// air MCP server factory — built once, started by index.ts, exercised by tests
// via server.callTool() (which runs the full middleware + plugin chain).

import {
  defineServer,
  defineTool,
  timeoutPlugin,
  retryPlugin,
  circuitBreakerPlugin,
  type AirServer,
} from "@airmcp-dev/core";
import { route, audit, SQL_TOOL, VECTOR_TOOL } from "./router.js";
import { getReadPool } from "./db.js";
import { getEmbedder } from "./embedder.js";
import { sqlQuery } from "./sql.js";
import { vectorSearch } from "./vector.js";
import { retrieve, ask } from "./pipeline.js";
import { ontologySearch, graphExpand, kgSchema } from "./graph.js";
import { profile } from "./profile.js";

export function buildServer(): AirServer {
  const ds = profile();
  return defineServer({
    name: "onprem-mcp-data",
    version: "0.2.0",
    description:
      `온프렘 PostgreSQL+pgvector MCP 데이터 플랫폼 — 결정론 라우터(MCP Parallel) + 구조보존 큐레이션. 데이터셋: ${ds.description}`,

    // "장애 지점 감소 / 운영 안정성" — air 플러그인 한 줄씩. 모든 도구 호출에 적용.
    // timeout은 가장 느린 합법 경로(콜드 모델 로드 포함 7B ask)를 덮도록 넉넉히.
    use: [timeoutPlugin(120_000), retryPlugin({ maxRetries: 2, delayMs: 150 }), circuitBreakerPlugin()],

    tools: [
      defineTool("route", {
        description:
          "한국어 질의를 분석해 어떤 데이터 도구(sql.query / vector.search)를 호출할지 결정한다. " +
          "LLM 호출 없는 결정론적 규칙 기반 라우팅(MCP Parallel 패턴). 같은 질의 → 항상 같은 결정.",
        params: { query: { type: "string", description: "사용자의 한국어 질의" } },
        annotations: { readOnlyHint: true, idempotentHint: true },
        layer: 2, // Pylon-7: routing/dispatch layer
        tags: ["router", "deterministic", "mcp-parallel"],
        handler: async ({ query }) => audit(route(query as string)),
      }),

      defineTool(SQL_TOOL, {
        description:
          "PostgreSQL에 읽기 전용 SELECT/WITH 쿼리를 실행하고 행을 반환한다. " +
          "읽기 전용 트랜잭션으로 강제되며 쓰기/DDL/문장 체이닝은 거부된다.",
        params: { sql: { type: "string", description: "실행할 단일 SELECT/WITH 쿼리" } },
        annotations: { readOnlyHint: true, idempotentHint: true },
        layer: 3, // data access
        tags: ["sql", "postgres", "read-only"],
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
        layer: 3, // data access
        tags: ["vector", "pgvector", "semantic"],
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
        layer: 4, // context assembly / curation
        tags: ["pipeline", "rrf", "curation", "tacc"],
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
        layer: 7, // Pylon-7: top agent/answer layer
        tags: ["agent", "answer", "qwen", "end-to-end"],
        handler: async ({ query, budget }) => {
          const r = await ask(query as string, {
            pool: getReadPool(),
            embedder: getEmbedder(),
            budget: budget as number | undefined,
          });
          return { answer: r.answer, route: r.route, context: r.context, audit: r.audit };
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
        layer: 5, // ontology / knowledge layer
        tags: ["graph", "ontology", "kg"],
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
        layer: 5, // graph traversal
        tags: ["graph", "expand", "kg"],
        handler: async ({ entityId, depth }) =>
          graphExpand(getReadPool(), entityId as number, (depth as number) ?? 1, undefined, kgSchema()),
      }),
    ],
  });
}
