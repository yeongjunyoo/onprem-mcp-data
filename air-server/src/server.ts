// air MCP server factory — built once, started by index.ts, exercised by tests
// via server.callTool() (which runs the full middleware + plugin chain).

import {
  defineServer,
  defineTool,
  timeoutPlugin,
  retryPlugin,
  circuitBreakerPlugin,
  cachePlugin,
  dedupPlugin,
  queuePlugin,
  sanitizerPlugin,
  jsonLoggerPlugin,
  type AirServer,
} from "@airmcp-dev/core";
import { route, audit, installOntology, SQL_TOOL, VECTOR_TOOL } from "./router.js";
import { getPool, getReadPool } from "./db.js";
import { getEmbedder } from "./embedder.js";
import { sqlQuery } from "./sql.js";
import { vectorSearch } from "./vector.js";
import { retrieve, ask } from "./pipeline.js";
import { ontologySearch, graphExpand, kgSchema, loadOntologyForRouter } from "./graph.js";
import { buildAuditRecord, renderAudit } from "./auditrecord.js";
import { buildPrompts } from "./prompts.js";
import { buildResources } from "./resources.js";
import { profile } from "./profile.js";

/**
 * Two layer systems share the letter "L" and run in OPPOSITE directions. Getting
 * them backwards is silent — nothing breaks, the numbers just lie:
 *
 *   air Meter (docs.airmcp.dev/guide/meter): cost ASCENDING.
 *     L1 static/cache … L2 lookup … L6 LLM call … L7 agent chain.
 *     `layer` on defineTool overrides Meter's auto-classification, so it MUST be
 *     the air value or every cost/latency statistic is filed under the wrong tier.
 *
 *   Pylon-7 (Jeon 2026, zenodo 18808598, Table 1): risk DESCENDING.
 *     L7 Interface(min risk) · L6 Analysis · L5 Routing · L4 Service ·
 *     L3 Resource · L2 Mutation(high) · L1 System(max: shell, root).
 *
 * So the reference-model position is carried in `tags` as `pylon7:Lx`, not in
 * `layer`. Note what the tag list does NOT contain: no tool touches Pylon-7 L2
 * (Mutation) or L1 (System). Every tool is read-only and `sql.query` drops to the
 * NOLOGIN `mcp_ro` role, so the two highest-risk layers of the Descent Cost
 * Principle are never entered at all.
 */
/** 라우터 온톨로지 적재 상태. 시연·감사에서 확인할 수 있게 노출한다. */
let ontologyState: { entities: number; typePairs: number; error?: string } = {
  entities: 0,
  typePairs: 0,
  error: "not loaded",
};

export function routerOntologyState(): Readonly<typeof ontologyState> {
  return ontologyState;
}

/** 기동 시 1회. 실패해도 서버는 뜨고, 라우터는 폴백 정규식으로 계속 돈다.
 *
 * 이것이 없으면 평가에서 잰 라우팅 성능이 서버 경로에서 재현되지 않는다(이슈 #18).
 * 그래서 실패를 조용히 삼키지 않고 경고와 상태로 남긴다. */
export async function loadRouterOntology(): Promise<Readonly<typeof ontologyState>> {
  try {
    const { nodes, edges } = await loadOntologyForRouter(getPool());
    const r = installOntology(nodes, edges);
    ontologyState = { entities: r.entities, typePairs: r.typePairs };
    if (r.entities === 0) {
      ontologyState.error = "empty";
      console.warn("[router] 온톨로지가 비어 있다 — 타입쌍 추론 없이 폴백으로 동작한다");
    }
  } catch (e) {
    ontologyState = { entities: 0, typePairs: 0, error: String(e).slice(0, 200) };
    console.warn(`[router] 온톨로지 적재 실패 — 폴백으로 동작한다: ${ontologyState.error}`);
  }
  return ontologyState;
}

/** 캐시에서 제외하는 도구. 감사 레코드가 이 목록을 직접 읽어 정책을 적으므로,
 * 여기서 빼면 레코드 표기도 함께 바뀐다 — 선언과 표기가 갈리지 않는다. */
const CACHE_EXCLUDED = ["audit.explain"];

export function buildServer(): AirServer {
  const ds = profile();
  return defineServer({
    name: "onprem-mcp-data",
    version: "0.2.0",
    description:
      `온프렘 PostgreSQL+pgvector MCP 데이터 플랫폼 — 결정론 라우터(MCP Parallel) + 구조보존 큐레이션. 데이터셋: ${ds.description}`,

    // "장애 지점 감소 / 운영 안정성" — air 플러그인 한 줄씩. 모든 도구 호출에 적용.
    // 순서가 곧 실행 순서다(air: use 배열 순).
    //
    // 왜 이 조합인가. air는 19개를 제공하고 우리는 6개를 쓴다. 고른 기준은 이 워크로드의
    // 성질이다: 전 도구가 읽기 전용 + 결정론(라우터/RRF/큐레이션)이라
    //   * cache  — 같은 질의는 같은 답이 보장되므로 캐싱이 정확도를 훼손하지 않는다.
    //              결정론이 캐시를 안전하게 만드는 것이지 그 반대가 아니다.
    //   * dedup  — 병렬 fan-out이 같은 하위 호출을 동시에 낼 수 있다.
    //   * queue  — 온프렘 7B는 동시 요청에 약하다. 무한 동시성보다 대기가 낫다.
    //   * sanitizer — MCP 도구 입력은 외부 입력이다(Hou 2025 위협 모델).
    //   * jsonLogger — 감사 로그를 ELK/Datadog가 그대로 먹는 형식으로.
    // 쓰지 않은 것도 근거가 있다: auth/cors/rateLimit은 stdio 로컬 배포에 불필요하고,
    // transform/i18n은 우리 응답 계약을 흐린다. dryrun은 개발 전용이다.
    use: [
      jsonLoggerPlugin(),
      sanitizerPlugin(),
      timeoutPlugin(120_000),
      queuePlugin({ concurrency: { "*": 8, ask: 2, retrieve: 2 } }), // 7B 경로만 좁게
      dedupPlugin(),
      // audit.explain은 캐시에서 제외한다. 감사의 목적은 "지금 이 순간
      // 파이프라인이 무엇을 하는가"인데, 캐시된 레코드는 60초 전의 실행 기록이다.
      // 그것은 감사가 아니라 과거 기록의 재생이다. (이슈 #12)
      cachePlugin({ ttlMs: 60_000, exclude: CACHE_EXCLUDED }),
      retryPlugin({ maxRetries: 2, delayMs: 150 }),
      circuitBreakerPlugin(),
    ],

    // stdio(기본) / sse / http — air가 설정 한 줄로 바꾼다. 심사자가 Claude Desktop에
    // 붙일 때는 stdio, 컨테이너로 띄울 때는 MCP_TRANSPORT=sse.
    transport:
      process.env.MCP_TRANSPORT === "sse"
        ? { type: "sse" as const, port: Number(process.env.MCP_PORT ?? 3510) }
        : { type: "stdio" as const },

    // MCP 표준 표면. 도구는 "실행", 리소스는 "열람", 프롬프트는 "재사용 템플릿"이다.
    // 스키마 카드와 평가 원자료를 도구 뒤에 숨기면 호스트도 심사자도 근거를 볼 수 없다.
    resources: buildResources(),
    prompts: buildPrompts(),

    tools: [
      defineTool("route", {
        description:
          "한국어 질의를 분석해 어떤 데이터 도구(sql.query / vector.search)를 호출할지 결정한다. " +
          "LLM 호출 없는 결정론적 규칙 기반 라우팅(MCP Parallel 패턴). 같은 질의 → 항상 같은 결정.",
        params: { query: { type: "string", description: "사용자의 한국어 질의" } },
        // 구조화 출력. 라우팅 결정은 사람이 읽는 문장이 아니라 기계가 검증할 계약이다.
        // 호스트가 이 스키마로 결과를 파싱하면 감사와 재현이 가능해진다.
        outputSchema: {
          route: { type: "string", description: "structured | semantic | graph | hybrid" },
          lane: { type: "string", description: "사람이 읽는 레인 이름" },
          tools: { type: "object", description: "호출할 도구 이름 목록(문자열 배열)" },
          structured_signals: { type: "object", description: "관계형 레인을 고르게 한 어휘(문자열 배열)" },
          semantic_signals: { type: "object", description: "의미 검색 레인을 고르게 한 어휘(문자열 배열)" },
          graph_signals: { type: "object", description: "그래프 레인을 고르게 한 어휘(문자열 배열)" },
          rationale: { type: "string", description: "결정 근거 한 줄" },
          deterministic: { type: "boolean", description: "항상 true. LLM 호출 없이 규칙으로만 결정한다" },
        },
        annotations: { readOnlyHint: true, idempotentHint: true },
        layer: 3, // air Meter: parse/transform tier (no LLM call, near-zero cost)
        tags: ["router", "deterministic", "mcp-parallel", "pylon7:L5"], // Pylon-7 L5 Routing
        handler: async ({ query }) => ({
          ...audit(route(query as string)),
          // 사전이 적재됐는지 시연 중에 바로 보이게 한다. 0이면 폴백 경로다.
          entity_lexicon: ontologyState.entities,
        }),
      }),

      defineTool(SQL_TOOL, {
        description:
          "PostgreSQL에 읽기 전용 SELECT/WITH 쿼리를 실행하고 행을 반환한다. " +
          "읽기 전용 트랜잭션으로 강제되며 쓰기/DDL/문장 체이닝은 거부된다.",
        params: { sql: { type: "string", description: "실행할 단일 SELECT/WITH 쿼리" } },
        annotations: { readOnlyHint: true, idempotentHint: true },
        layer: 2, // air Meter: simple lookup (DB read, no model)
        tags: ["sql", "postgres", "read-only", "pylon7:L3"], // Pylon-7 L3 Resource
        handler: async ({ sql }) => sqlQuery(getReadPool(), sql as string),
      }),

      defineTool(VECTOR_TOOL, {
        description:
          `질의를 임베딩해 pgvector 코사인 유사도로 ${ds.vectorTable} 상위 k건을 검색한다(의미 검색). ` +
          "임베더는 오프라인 결정론(hash) 기본, 데모는 bge-m3(Ollama)로 교체 가능.",
        params: {
          query: { type: "string", description: "검색할 한국어 질의" },
          k: { type: "number", description: "반환할 상위 건수 (기본 5)", optional: true },
        },
        annotations: { readOnlyHint: true, idempotentHint: true },
        layer: 6, // air Meter: embeds the query -> LLM-call tier
        tags: ["vector", "pgvector", "semantic", "pylon7:L3"], // Pylon-7 L3 Resource
        handler: async ({ query, k }) =>
          vectorSearch(getReadPool(), getEmbedder(), query as string, (k as number) ?? 5),
      }),

      defineTool("retrieve", {
        description:
          "한국어 질의를 route→병렬 fan-out(sql.query ∥ vector.search)→RRF 머지→구조보존 큐레이션까지 " +
          "한 번에 실행해 7B에 넣을 컨텍스트와 전체 감사 로그를 반환한다. 라우팅·RRF·큐레이션은 결정론, " +
          "구조화 경로 NL2SQL은 7B(최종 답변 생성 없이 컨텍스트만 반환).",
        params: {
          query: { type: "string", description: "사용자의 한국어 질의" },
          budget: { type: "number", description: "큐레이터 토큰 예산 (기본 256)", optional: true },
        },
        annotations: { readOnlyHint: true, idempotentHint: true },
        layer: 7, // air Meter: orchestrates several tools in one call
        tags: ["pipeline", "rrf", "curation", "tacc", "pylon7:L6"], // Pylon-7 L6 Analysis
        handler: async ({ query, budget }) => {
          const r = await retrieve(query as string, {
            pool: getReadPool(),
            embedder: getEmbedder(),
            budget: budget as number | undefined,
          });
          return { route: r.route, context: r.context, audit: r.audit };
        },
      }),

      defineTool("ask", {
        description:
          "한국어 질의에 대해 route→병렬 fan-out→RRF 머지→구조보존 큐레이션→온프렘 7B(Qwen2.5) " +
          "최종 답변까지 end-to-end로 수행한다. 답변은 큐레이션된 컨텍스트에만 근거(추측 금지).",
        params: {
          query: { type: "string", description: "사용자의 한국어 질의" },
          budget: { type: "number", description: "큐레이터 토큰 예산 (기본 256)", optional: true },
        },
        annotations: { readOnlyHint: true, openWorldHint: false },
        layer: 7, // air Meter: agent chain (retrieval + generation)
        tags: ["agent", "answer", "qwen", "end-to-end", "pylon7:L7"], // Pylon-7 L7 Interface
        handler: async ({ query, budget }) => {
          const r = await ask(query as string, {
            pool: getReadPool(),
            embedder: getEmbedder(),
            budget: budget as number | undefined,
          });
          // 감사 레코드를 함께 낸다. 답만 주면 "왜 그 답인가"를 확인할 방법이 없다.
          return { answer: r.answer, route: r.route, context: r.context, audit: buildAuditRecord(r) };
        },
      }),

      defineTool("audit.explain", {
        description:
          "한 질의를 끝까지 실행하고 왜 그 답이 나왔는지를 기계가 읽을 감사 레코드로 돌려준다. " +
          "라우팅 근거, 실행되거나 거부된 SQL과 그 사유, 레인별 후보 수, 융합 상위 항목과 합의한 소스, " +
          "정책 판정(읽기 전용 가드, 자기 수정, 미해소 개체 게이트, 컨텍스트 예산, 브랜치 격리), " +
          "그리고 답변이 컨텍스트 밖 개체를 만들었는지까지 한 레코드에 담는다. " +
          "답변 텍스트를 제외한 구간은 결정론이라 같은 질의는 같은 지문(fingerprint)을 낸다.",
        params: {
          query: { type: "string", description: "감사할 한국어 질의" },
          format: { type: "string", description: "json(기본) 또는 text", optional: true },
        },
        annotations: { readOnlyHint: true, openWorldHint: false },
        layer: 7,
        tags: ["audit", "explainability", "provenance", "pylon7:L7"],
        handler: async ({ query, format }) => {
          const executed_at = new Date().toISOString();
          const r = await ask(query as string, { pool: getReadPool(), embedder: getEmbedder() });
          // 이 레코드가 언제 실행됐는지를 레코드 자신이 말하게 한다. 캐시 우회는
          // 보이지 않는 성질이라, 보이게 하지 않으면 누가 되돌려도 모른다.
          //
          // cache_policy는 **관측값이 아니라 정책 선언**이다. 실제 캐시 적중 여부를
          // 미들웨어에서 읽어 오는 것이 아니므로 "우회했다"고 주장하지 않는다.
          // 설정에서 실제로 제외돼 있는지를 그 자리에서 확인해 적는다.
          const record = {
            ...buildAuditRecord(r),
            executed_at,
            cache_policy: CACHE_EXCLUDED.includes("audit.explain") ? ("excluded" as const) : ("cached" as const),
          };
          return format === "text" ? { text: renderAudit(record) } : record;
        },
      }),

      defineTool("ontology.search", {
        description:
          "한국어/영어 질의어를 지식그래프의 정규 엔티티로 해소한다(별칭·정규명 매칭). " +
          "예: '전자제품'→전자기기, 'electronics'→전자기기. SQL/vector가 못 잇는 동의어를 연결.",
        params: {
          query: { type: "string", description: "해소할 질의어" },
          k: { type: "number", description: "최대 엔티티 수 (기본 5)", optional: true },
        },
        annotations: { readOnlyHint: true, idempotentHint: true },
        layer: 2, // air Meter: simple lookup (alias/canonical match)
        tags: ["graph", "ontology", "kg", "pylon7:L3"], // Pylon-7 L3 Resource
        handler: async ({ query, k }) => ontologySearch(getReadPool(), query as string, (k as number) ?? 5, kgSchema()),
      }),

      defineTool("graph.expand", {
        description:
          "지식그래프에서 시드 엔티티로부터 타입 관계 엣지를 BFS로 확장한다(provenance 포함). " +
          "예: 환불 정책 -applies_to-> {의류,전자기기,식품}. graph edge 없이 못 푸는 질의용.",
        params: {
          entityId: { type: "number", description: "시드 엔티티 id" },
          depth: { type: "number", description: "확장 깊이 1~3 (기본 1)", optional: true },
        },
        annotations: { readOnlyHint: true, idempotentHint: true },
        layer: 2, // air Meter: simple lookup (indexed edge BFS)
        tags: ["graph", "expand", "kg", "pylon7:L3"], // Pylon-7 L3 Resource
        handler: async ({ entityId, depth }) =>
          graphExpand(getReadPool(), entityId as number, (depth as number) ?? 1, undefined, kgSchema()),
      }),
    ],
  });
}
