// End-to-end retrieval pipeline (the differentiator spine):
//   route (L3, deterministic)  ->  parallel fan-out (sql.query ∥ vector.search)
//   ->  RRF merge  ->  L4 structure-preserving curation  ->  curated context.
//
// The 7B answer step consumes `context` (added in the LLM increment). Everything
// here is deterministic given a deterministic nl2sql + embedder, so the whole
// spine is reproducible and unit-testable without a model.

import type { Pool } from "./db.js";
import type { Embedder } from "./embedder.js";
import { route, audit as routeAuditLog, fitPlanToSeed, type RouteDecision, type GraphPlan } from "./router.js";
import { routeQuery } from "./semroute.js";
import { sqlQuery, columnsForSql, type SqlResult } from "./sql.js";
import { keywordIndexReady, keywordSearch, type KeywordSearchResult } from "./keyword.js";
import { vectorSearch, type VectorResult } from "./vector.js";
import { rrfMerge, type Ranked, type Fused } from "./rrf.js";
import { curate, render, curateAudit, type ContextItem, type Curated } from "./curator.js";
import { type NL2SQL, type Nl2SqlReport, NO_TABLE } from "./nl2sql.js";
import { executeWithRepair } from "./sqlrepair.js";
import { profile } from "./profile.js";
import { answer as llmAnswer } from "./llm.js";
import {
  ontologySearch,
  seedTerms,
  graphExpand,
  graphWalk,
  relationScan,
  ontologyCandidates,
  edgeCandidates,
  seedEdgeCandidates,
  pathCandidates,
  rankingCandidates,
  kgSchema,
  type GraphEdge,
  type GraphTruncation,
} from "./graph.js";
import type { Candidate } from "./candidate.js";
import { describeError } from "./errors.js";
import { describeNotFound, type NotFound } from "./notfound.js";

export interface RetrieveDeps {
  pool: Pool;
  embedder: Embedder;
  nl2sql?: NL2SQL; // default: deterministic template fast-path
  k?: number; // vector top-k (default 5)
  budget?: number; // curator token budget (default DEFAULT_BUDGET)
  repair?: boolean; // retry a rejected SQL once with the DB error (default true)
}

export interface RetrieveResult {
  query: string;
  route: RouteDecision["route"];
  /** refused 는 생성 모델이 만들었지만 실행하지 않은 문장(nl2sql.ts pickSql). 그때 text 는 null 이다. */
  sql: { text: string | null; result?: SqlResult; repaired?: boolean; refused?: { kind: string; text: string } };
  vector?: VectorResult;
  graph?: GraphLaneResult;
  fused: Fused<ContextItem>[];
  /** RRF 입력 목록마다의 레인 이름. fused[].sources 의 번호가 이 배열의 위치다. */
  fusion_lanes?: string[];
  curated: Curated;
  context: string;
  /** 미해소 개체 게이트가 발동했을 때 그 사유. 그 밖에는 없다. */
  not_found?: NotFound;
  /** 섞인 질문에서 해소되지 않은 이름마다의 사유. 찾은 개체로 답하고 답 앞에 이 사유를 붙인다. */
  missing?: NotFound[];
  /** missing 이 있을 때 답 단계가 받는 질문(없는 개체가 든 마디를 뺀 것). */
  answer_query?: string;
  audit: {
    route: ReturnType<typeof routeAudit>;
    candidates: { sql: number; vector: number; graph: number; fused: number };
    branch_errors: string[];
    curate: ReturnType<typeof curateAudit>;
    // retrieve 도구는 audit 만 돌려주므로 두 상태를 여기에도 싣는다.
    not_found?: NotFound;
    missing_entities?: NotFound[];
    graph_truncated?: GraphTruncation;
    /** 탐색 계획을 시드 타입에 맞게 고쳤으면 무엇을 고쳤는지(시드마다 한 줄). */
    graph_fitted?: string[];
  };
}

function routeAudit(d: RouteDecision) {
  return routeAuditLog(d);
}

/** L5 lane result: ontology seeds + expanded edges, already canonicalized. */
export interface GraphLaneResult {
  seeds: { entityId: number; canonicalName: string; type: string }[];
  edgeCount: number;
  strategy: "seeded" | "relation-scan" | "seeded+relation-scan" | "unresolved" | "none";
  ranking?: { name: string; type: string; count: number }[];
  items: Candidate[];
  /** strategy 가 unresolved 일 때 왜 못 찾았는지. */
  not_found?: NotFound;
  /** 시드 확장 중 하나라도 탐색 상한에 걸렸으면 처음 걸린 것. */
  truncated?: GraphTruncation;
  /** 계획을 시드 타입에 맞게 고친 내용(router.ts fitPlanToSeed). */
  fitted?: string[];
  /** 섞인 질문에서 해소되지 않은 이름마다의 사유(graph.ts ontologySearch 의 missing). */
  missing?: NotFound[];
  /** missing 이 있을 때 답 단계와 탐색 계획이 쓰는 질문. 없는 개체가 든 마디를 뺐다. */
  answer_query?: string;
  error?: string;
}

/** 섞인 질문에서 없는 개체가 든 마디를 뺀 질문.
 *
 * 「서울물산 담당 엔지니어와 Client-A가 사용 중인 제품을 알려줘」에서 서울물산이 없으면
 * 「Client-A가 사용 중인 제품을 알려줘」만 남긴다. 그 마디의 관계(「담당」)를 찾은 개체에 걸면
 * Client-A 의 담당자가 서울물산의 담당자처럼 컨텍스트에 들어가고 7B 가 그렇게 답했다(경계 실측 3/3).
 * 마디는 「와·과·하고·이랑·랑」 뒤 공백, 쉼표, 「그리고」, 「및」에서 가른다. 남은 마디에 관계어가
 * 없으면(「Client-A와 서울물산의 담당자」) 관계어가 찾은 개체에도 걸린 것이라 마디 대신 이름과
 * 그 앞뒤 조사만 뺀다. 결정론이다. */
export function withoutMissing(query: string, names: string[]): string {
  const parts = query
    .split(/(?<=[가-힣A-Za-z0-9])(?:와|과|하고|이랑|랑)\s+|\s*,\s*|\s+(?:그리고|및)\s+/)
    .map((p) => p.trim())
    .filter(Boolean);
  const kept = parts.filter((p) => !names.some((n) => p.includes(n)));
  if (kept.length && kept.length < parts.length) {
    const reduced = kept.join(", ");
    if (route(reduced).graphPlan?.relTypes.length) return reduced;
  }
  let q = query;
  for (const n of names) {
    const name = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    q = q.replace(
      new RegExp(`(?:(?:와|과|하고|이랑|랑)\\s+)?${name}(?:은|는|이|가|을|를|의|와|과|도|에|에서|하고|이랑|랑)?`),
      " ",
    );
  }
  return q.replace(/\s+/g, " ").trim() || query;
}

/** Resolve the query's entities, BFS their typed edges, and — when the question
 * names a RELATION rather than a node ("가장 많은 고객을 담당하는 직원") — scan that
 * relation directly. Deterministic throughout: ranked alias matching, ordered BFS,
 * ordered aggregation. No model in the loop. */
export async function graphLane(
  pool: Pool,
  query: string,
  k = 5,
  depth = 2,
  schema = kgSchema(),
  plan?: GraphPlan,
): Promise<GraphLaneResult> {
  const onto = await ontologySearch(pool, query, k, schema);
  if (!onto.ok) return { seeds: [], edgeCount: 0, strategy: "none", items: [], error: onto.error };
  // 섞인 질문: 찾은 개체는 펼치되, 없는 개체가 든 마디를 뺀 질문으로 계획을 다시 세운다
  // (withoutMissing). 다시 세운 계획에 관계가 없으면 원래 계획을 쓴다.
  const missing = onto.missing ?? [];
  const answerQuery = missing.length ? withoutMissing(query, missing.map((m) => m.query_entity)) : undefined;
  const replanned = answerQuery ? route(answerQuery).graphPlan : undefined;
  const p = replanned?.relTypes.length ? replanned : (plan ?? route(query).graphPlan);
  const relTypes = p?.relTypes?.length ? p.relTypes : undefined;
  // When the question names a RELATION, one hop is the answer and every extra hop
  // is noise: "Product-S1 관련 고객 이슈" pulled in Client-X -> Product-C2 edges two
  // hops away and the 7B, reading a context full of other products, concluded there
  // were no Product-S1 issues at all. Unspecified relations keep the requested depth.
  // A named relation that cannot start from the seed's type ("Product-D1 관련 프로젝트":
  // HAS_PROJECT starts at a client, not a product) is re-planned per seed below
  // (fitPlanToSeed) into a typed two-hop walk instead of an empty one-hop expansion.
  const hops = relTypes ? 1 : depth;

  const seeds = onto.hits.map((h) => ({ entityId: h.entityId, canonicalName: h.canonicalName, type: h.type }));
  // Order matters: EDGES first, name-resolution hits last. RRF keeps one entry per
  // key at its best rank, and a seed hit ("윤소연 — 별칭 매칭 '경영지원팀'") shares its
  // key with the edge that actually answers ("경영지원팀의 부서장: 윤소연"). Listed
  // first, the near-empty seed line won and the model answered "알 수 없습니다" with
  // the answer one line below the cut. Facts before bookkeeping.
  // 예외는 없는 개체의 사유 줄이다. 예산에 잘리지 않게 맨 앞에 둔다.
  const items: Candidate[] = missing.map((nf) => ({
    canonicalKey: `missing#${nf.query_entity}`,
    sourceKey: "graph#missing",
    source: "graph" as const,
    text: `[그래프] ${describeNotFound(nf)}`,
    provenance: "ontology:missing",
  }));
  const partial = missing.length ? { missing, answer_query: answerQuery } : {};
  let edgeCount = 0;

  // Anti-hallucination gate: the question names an entity, nothing resolves, and the
  // plan has no relation-level intent -> say so. Dumping every edge of the relation
  // would hand the 7B a context that CONTAINS plausible-looking wrong answers
  // (the sponsor's own example "서울물산 담당 엔지니어" names a client absent from the
  // dataset; the honest output is "없음", not the 63 MANAGES_ACCOUNT edges).
  // The line names WHY (onto.not_found): absent vs. a similarly-named entity that
  // does not match. A similar name is reported, never expanded.
  if (onto.hits.length === 0 && !(p?.aggregate || p?.filter)) {
    const terms = seedTerms(query);
    return {
      seeds: [],
      edgeCount: 0,
      strategy: "unresolved",
      not_found: onto.not_found,
      items: [
        {
          canonicalKey: `unresolved#${terms.join("+")}`,
          sourceKey: "graph#unresolved",
          source: "graph" as const,
          // 질의어가 하나도 없으면(「ㅁㄴㅇㄹ」) 찾지 못한 대상의 이름도 없다. 종전 문장은
          // 「대상()」처럼 빈 괄호를 보였고, 없는 개체를 단정하는 문장도 맞지 않았다.
          text: onto.not_found
            ? `[그래프] ${describeNotFound(onto.not_found)}`
            : terms.length
              ? `[그래프] 질의에 등장한 대상(${terms.join(", ")})을 지식그래프에서 찾지 못했습니다. 해당 개체는 데이터셋에 존재하지 않습니다.`
              : "[그래프] 질의에서 개체 이름으로 볼 낱말을 찾지 못해 지식그래프를 탐색하지 않았습니다.",
          provenance: "ontology:unresolved",
        },
      ],
    };
  }

  // Seeded traversal: expand only from EXACT/prefix seeds when we have any, so a
  // single well-named entity is not drowned by substring noise.
  const best = Math.max(0, ...onto.hits.map((h) => h.score));
  const expandFrom = onto.hits.filter((h) => h.score === best);
  let truncated: GraphTruncation | undefined;
  const fitted: string[] = [];
  // 한 홉 엣지는 시드를 다 돈 뒤 한꺼번에 후보로 바꾼다. 같은 답 개체에 여러 시드가 닿으면 한 줄로
  // 모아야 해서다(seedEdgeCandidates). 자리는 처음 펼친 한 홉 시드의 자리 그대로다.
  const edgeGroups: { edges: GraphEdge[]; seedId: number }[] = [];
  let edgesAt = -1;
  for (const hit of expandFrom) {
    // 계획의 엣지가 이 시드의 타입에 닿지 않으면 온톨로지 타입 그래프로 경로를 맞춘다.
    // GRAPH_PATH_FIT=0 은 검증용 제거 스위치다(고치기 전 동작).
    const others = expandFrom.filter((h) => h !== hit).map((h) => h.type);
    const walk =
      p && process.env.GRAPH_PATH_FIT !== "0" ? fitPlanToSeed(p.relTypes, hit.type, answerQuery ?? query, others) : undefined;
    if (walk?.fitted) fitted.push(`${hit.canonicalName}: ${walk.fitted}`);
    const exp =
      walk && walk.hops.length > 1
        ? await graphWalk(pool, hit.entityId, walk.hops, schema)
        : await graphExpand(pool, hit.entityId, hops, walk?.hops[0] ?? relTypes, schema, "both");
    if (!exp.ok) return { seeds, edgeCount, strategy: "seeded", items, error: exp.error, ...partial };
    truncated ??= exp.truncated;
    edgeCount += exp.edges.length;
    if (walk && walk.hops.length > 1) items.push(...pathCandidates(exp.edges, hit.entityId));
    else {
      if (edgesAt < 0) edgesAt = items.length;
      edgeGroups.push({ edges: exp.edges, seedId: hit.entityId });
    }
  }
  if (edgesAt >= 0) items.splice(edgesAt, 0, ...seedEdgeCandidates(edgeGroups));

  // Relation-level scan: needed when the question names no node (aggregate /
  // status-filtered listings), and harmless as an addition when it names both.
  let ranking: GraphLaneResult["ranking"];
  const needScan = Boolean(p && p.relTypes.length && (p.aggregate || p.filter || expandFrom.length === 0));
  if (needScan) {
    const scan = await relationScan(
      pool,
      { relTypes: p!.relTypes, aggregate: p!.aggregate, filter: p!.filter },
      schema,
    );
    if (!scan.ok) {
      return { seeds, edgeCount, strategy: "relation-scan", items, error: scan.error, ...partial };
    }
    edgeCount += scan.edges.length;
    if (scan.ranking.length) {
      ranking = scan.ranking.slice(0, 5).map((r) => ({ name: r.name, type: r.type, count: r.count }));
      items.push(...rankingCandidates(scan.ranking, p!.relTypes[0]));
    } else {
      items.push(...edgeCandidates(scan.edges));
    }
  }

  // Seed-resolution provenance goes last: it explains WHY these edges, and it is
  // still in the audit log even when the budget trims it from the context.
  // 펼친 시드만 싣는다. 점수가 낮아 펼치지 않은 시드(「영업」이라는 낱말로 걸린 직원 넷)는 사실 없이
  // 이름만 늘어서 답 줄을 가렸다(홀드아웃3 #47: 「김준혁의 담당 고객사: Client-K」가 첫 줄인데 「영업
  // 담당자들에게 말 걸면 됩니다」). 감사 레코드의 seeds 에는 그대로 남는다. GRAPH_WEAK_SEEDS=1 이 옛 동작.
  items.push(...ontologyCandidates(process.env.GRAPH_WEAK_SEEDS === "1" || !expandFrom.length ? onto.hits : expandFrom));

  const strategy: GraphLaneResult["strategy"] =
    expandFrom.length && needScan
      ? "seeded+relation-scan"
      : expandFrom.length
        ? "seeded"
        : needScan
          ? "relation-scan"
          : "none";
  return {
    seeds,
    edgeCount,
    strategy,
    ranking,
    items,
    ...(truncated ? { truncated } : {}),
    ...(fitted.length ? { fitted } : {}),
    ...partial,
  };
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** SQL 값 하나를 모델이 읽을 표기로.
 *
 * node-postgres 는 date, timestamp 를 Date 로, interval 을 객체로 준다. 템플릿 문자열에
 * 그대로 넣으면 「Thu Aug 01 2024 00:00:00 GMT+0900」과 「[object Object]」가 컨텍스트에
 * 들어갔고, 기간을 묻는 질문은 정답 행을 찾고도 답할 수 없었다(홀드아웃 채점표에서 발견).
 * Date 는 드라이버가 로컬 시각으로 만들므로 로컬 성분으로 적는다 — toISOString 은 UTC 라
 * 한국 시간 자정의 날짜가 하루 앞당겨진다. */
export function renderValue(v: unknown): string {
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    const day = `${v.getFullYear()}-${pad2(v.getMonth() + 1)}-${pad2(v.getDate())}`;
    const midnight = !v.getHours() && !v.getMinutes() && !v.getSeconds() && !v.getMilliseconds();
    return midnight ? day : `${day} ${pad2(v.getHours())}:${pad2(v.getMinutes())}:${pad2(v.getSeconds())}`;
  }
  if (v && typeof v === "object" && "toPostgres" in v) {
    const iv = v as { years?: number; months?: number; days?: number; hours?: number; minutes?: number; seconds?: number };
    const parts: string[] = [];
    for (const [n, unit] of [
      [iv.years, "년"],
      [iv.months, "개월"],
      [iv.days, "일"],
      [iv.hours, "시간"],
      [iv.minutes, "분"],
      [iv.seconds, "초"],
    ] as const) {
      if (n) parts.push(`${n}${unit}`);
    }
    return parts.length ? parts.join(" ") : "0초";
  }
  return String(v);
}

function renderRow(row: Record<string, unknown>): string {
  return Object.entries(row)
    .map(([k, v]) => `${k}=${renderValue(v)}`)
    .join(" | ");
}

/** 정형 레인 답 끝에 그대로 싣는 조회 결과의 최대 행 수. 넘으면 남은 건수만 적는다. */
export const SQL_ROWS_MAX = 30;

/** 정형 레인 답의 끝에 붙이는 조회 결과. 값과 목록은 DB 가 말한다.
 *
 * 7B 는 SQL 결과를 읽고도 목록 일부나 열 하나를 빠뜨린다. 사업자 예시 5번 「기술지원팀
 * 직원 목록과 연봉」은 SQL 이 이름과 연봉 네 행을 돌려줬는데 답에는 이름만 있었다. 같은
 * 모델, 같은 시드인데 Ollama 0.34.2 에서 틀리고 0.35.0 에서 맞았다. 답의 정확도가 런타임
 * 버전 운에 달리지 않게, 행을 답에 그대로 싣는다. 모델은 문장을 쓰고 값은 옮겨 적지 않는다.
 * 싣는 행은 큐레이션이 모델에게 넘긴 행이다. 그래서 답에 나오는 값은 전부 컨텍스트에 있다
 * (companyx:ask 의 answer_grounded 가 그대로 성립한다). 예산 밖으로 밀린 행은 건수만 적는다.
 * ANSWER_SQL_ROWS=0 은 검증용 제거 스위치다. */
export function sqlRowsBlock(rows: Record<string, unknown>[], total = rows.length, max = SQL_ROWS_MAX): string {
  if (!rows.length) return "";
  const shown = rows
    .slice(0, max)
    .map((r) => `- ${Object.entries(r).map(([k, v]) => `${k}: ${renderValue(v)}`).join(", ")}`);
  const rest = total > shown.length ? [`- 외 ${total - shown.length}건`] : [];
  return [`[조회 결과 ${total}건]`, ...shown, ...rest].join("\n");
}

function withSqlRows(r: RetrieveResult, text: string): string {
  if (r.route !== "structured" || !r.sql.result?.ok || process.env.ANSWER_SQL_ROWS === "0") return text;
  const seen = new Set(r.curated.kept.filter((it) => it.source.startsWith("sql#")).map((it) => Number(it.source.slice(4))));
  const rows = r.sql.result.rows.filter((_, i) => seen.has(i));
  const block = sqlRowsBlock(rows, r.sql.result.rows.length);
  return block ? `${text.trimEnd()}\n\n${block}` : text;
}

/** 큐레이터가 모델에 넘기는 컨텍스트 예산(토큰 근사). 256 → 1024 (2026-09-30).
 *
 * 채점 기준이 최종 답 일치라(리원에이스 멘토링 09-22) 답을 기준으로 골랐다. 개발용 세트(사업자 30,
 * 홀드아웃3 채점 가능 38)에서 서버와 같은 라우터 상태로 잰 정답 합이 256: 21+18=39, 512: 22+19=41,
 * 1024: 24+20=44. 256 에서 틀린 목록형 답은 근거가 잘려 목록 일부만 말한 것이었다. 규칙은
 * 「최고치에서 1문항 이내인 가장 작은 예산」이고 1024 만 해당한다. 봉인 홀드아웃4 는 따로 한 번 잰다. */
export const DEFAULT_BUDGET = 1024;

/** Run the retrieval spine for one query.
 * Deterministic parts: route (L3) + RRF merge + L4 curation. The structured
 * path's NL2SQL is the 7B by default (faithful to the brief; this is the path
 * the execution-match eval measures, so eval == live). Inject `nl2sql:
 * templateNL2SQL` for an offline, zero-LLM deterministic fast-path. */
export async function retrieve(query: string, deps: RetrieveDeps): Promise<RetrieveResult> {
  const { pool, embedder } = deps;
  const nl2sql = deps.nl2sql ?? profile().nl2sql;
  const k = deps.k ?? 5;
  const budget = deps.budget ?? DEFAULT_BUDGET;

  // 규칙이 확신하지 못하면 시맨틱 폴백이 정한다. 폴백이 설치되지 않았으면 규칙만.
  const decision = await routeQuery(query, embedder);
  const wantSql = decision.route === "structured" || decision.route === "hybrid";
  const wantVec = decision.route === "semantic" || decision.route === "hybrid";
  const wantGraph = decision.route === "graph";

  // --- parallel fan-out (MCP Parallel): the vector branch starts immediately and
  // runs CONCURRENTLY with NL2SQL+SQL; allSettled isolates branches so a failure
  // in one (e.g. NL2SQL throws) still yields the other's context (graceful degradation). ---
  const sqlBranch = (async (): Promise<RetrieveResult["sql"]> => {
    if (!wantSql) return { text: null };
    const report: Nl2SqlReport = {};
    const text = await nl2sql(query, report);
    if (!text) return report.refused ? { text: null, refused: report.refused } : { text: null };
    // 엔진이 거부하면(없는 컬럼 등) 그 오류를 한 번 되먹여 고친다 — 빈 컨텍스트가 두 번째
    // 호출보다 나쁘다. 평가(companyx:sql)도 같은 함수를 부른다.
    const ex = await executeWithRepair(pool, query, text, {
      repair: deps.repair !== false,
      schema: profile().kgSchema === "companyx" ? "companyx" : "public",
    });
    return { text: ex.text, result: ex.result, repaired: ex.repaired || undefined };
  })();
  const vecBranch: Promise<VectorResult | undefined> = wantVec
    ? vectorSearch(pool, embedder, query, k)
    : Promise.resolve(undefined);
  // The graph lane (L5): resolve the query's entities, then BFS their typed edges.
  // Runs concurrently with the other branches and is isolated the same way.
  const graphBranch: Promise<GraphLaneResult | undefined> = wantGraph
    ? graphLane(pool, query, k, 2, kgSchema(), decision.graphPlan)
    : Promise.resolve(undefined);
  // 키워드(희소) 레인. **기본은 꺼져 있다.**
  //
  // 왜 껐나. 68문항으로 재 보니 이 코퍼스에서는 융합이 순위를 떨어뜨렸다.
  // 밀집 hit@1 0.868 / MRR 0.913 대 무조건 융합 0.706 / 0.830, 식별자 조건으로
  // 게이트를 걸어도 0.838 / 0.894였다(eval/results/companyx-hybrid.json).
  // 문서가 40건뿐이라 밀집이 이미 hit@5 0.985로 천장에 붙어 있고, 약한 레인을
  // 같은 가중치로 섞으면 손해만 남는다. 가중치를 조정하면 개선되겠지만 그것은
  // 튜닝 파라미터를 하나 만드는 일이라 이 프로젝트의 전제와 충돌한다.
  //
  // 그래서 코드는 남기고 기본값만 끈다. 식별자가 지배적인 코퍼스나 문서 수가
  // 훨씬 큰 환경에서는 결과가 달라질 수 있고, 그때는 KEYWORD_LANE=1로 켠다.
  const keywordBranch: Promise<KeywordSearchResult | undefined> = wantVec && process.env.KEYWORD_LANE === "1"
    ? (async () => {
        const table = profile().name === "companyx" ? "companyx.document_chunks" : profile().vectorTable;
        if (!(await keywordIndexReady(pool, table))) return undefined;
        return keywordSearch(pool, query, k, table);
      })()
    : Promise.resolve(undefined);

  const [sqlSettled, vecSettled, graphSettled, kwSettled] = await Promise.allSettled([
    sqlBranch,
    vecBranch,
    graphBranch,
    keywordBranch,
  ]);
  const sql: RetrieveResult["sql"] = sqlSettled.status === "fulfilled" ? sqlSettled.value : { text: null };
  const sqlText = sql.text;
  const sqlResult = sql.result;
  const vecResult = vecSettled.status === "fulfilled" ? vecSettled.value : undefined;
  const graphResult = graphSettled.status === "fulfilled" ? graphSettled.value : undefined;
  const kwResult = kwSettled.status === "fulfilled" ? kwSettled.value : undefined;
  const branchErrors: string[] = [];
  if (sqlSettled.status === "rejected") branchErrors.push(`sql: ${String(sqlSettled.reason)}`);
  if (vecSettled.status === "rejected") branchErrors.push(`vector: ${String(vecSettled.reason)}`);
  if (graphSettled.status === "rejected") branchErrors.push(`graph: ${String(graphSettled.reason)}`);
  if (kwSettled.status === "rejected") branchErrors.push(`keyword: ${String(kwSettled.reason)}`);
  if (kwResult && !kwResult.ok) branchErrors.push(`keyword: ${kwResult.error ?? "unknown"}`);
  if (graphResult?.error) branchErrors.push(`graph: ${graphResult.error}`);
  // ★ sql·vector 레인은 실패를 **던지지 않고 돌려준다**.
  //
  // 위의 rejected 검사만으로는 안 잡힌다 — `{ok:false, error}` 는 fulfilled 다.
  // 2026-08-17 실측: DB 가 죽은 상태에서 ask 가 "주어진 정보로는 알 수 없습니다" 로
  // 답하고 audit.explain 의 branch_errors 는 **빈 배열**이었다.
  //
  // 인프라 장애가 지식 부재로 위장된다. 접지 규율("모르면 모른다")이 장애를
  // 삼키는 통로가 되면 안 된다. 네 레인 중 keyword·graph 만 이 검사가 있었다.
  if (sqlResult && !sqlResult.ok) {
    branchErrors.push(`sql: ${sqlResult.error ?? "unknown"}`);
  }
  if (vecResult && !vecResult.ok) {
    branchErrors.push(`vector: ${vecResult.error ?? "unknown"}`);
  }

  // --- normalize each path into a ranked candidate list of ContextItems ---
  const lists: Ranked<ContextItem>[][] = [];
  const listLanes: string[] = [];
  if (sqlResult?.ok) {
    // Each SQL row is an atomic context item, prefixed with the query that
    // produced it so the 7B can ground its answer (a bare "count=3" is
    // unanchored; "SELECT ... WHERE amount>=10000 → count=3" is self-explaining).
    const sqlHead = `[SQL 결과] ${sqlText}`;
    lists.push(
      sqlResult.rows.map((row, i) => ({
        key: `sql#${i}`,
        value: { kind: "row" as const, text: `${sqlHead} → ${renderRow(row)}`, source: `sql#${i}`, fields: Object.keys(row).length },
      })),
    );
    listLanes.push("sql");
  }
  if (vecResult?.ok) {
    lists.push(
      vecResult.hits.map((h) => ({
        key: `documents#${h.id}`,
        value: { kind: "chunk", text: `${h.title}: ${h.body}`, source: `documents#${h.id}` },
      })),
    );
    listLanes.push("vector");
  }
  if (kwResult?.ok && kwResult.hits.length) {
    // 벡터 레인과 같은 key 규칙(documents#id)을 쓴다. 같은 청크를 두 레인이 찾으면
    // RRF가 교차 소스 합의로 인식해 순위를 올린다. 그것이 하이브리드의 이득이다.
    lists.push(
      kwResult.hits.map((h) => ({
        key: `documents#${h.id}`,
        value: { kind: "chunk" as const, text: `${h.title}: ${h.body}`, source: `keyword#${h.id}` },
      })),
    );
    listLanes.push("keyword");
  }
  if (graphResult && graphResult.items.length) {
    lists.push(
      graphResult.items.map((it, i) => ({
        key: it.canonicalKey,
        value: { kind: "chunk" as const, text: it.text, source: `graph#${i}` },
      })),
    );
    listLanes.push("graph");
  }

  // --- RRF merge -> L4 curation ---
  const fused = rrfMerge(lists);
  const curated = curate(query, fused.map((f) => f.value), budget);

  return {
    query,
    route: decision.route,
    sql: { text: sqlText, result: sqlResult, repaired: sql.repaired, ...(sql.refused ? { refused: sql.refused } : {}) },
    vector: vecResult,
    graph: graphResult,
    fused,
    fusion_lanes: listLanes,
    curated,
    context: render(curated),
    ...(graphResult?.not_found ? { not_found: graphResult.not_found } : {}),
    ...(graphResult?.missing?.length ? { missing: graphResult.missing, answer_query: graphResult.answer_query } : {}),
    audit: {
      route: routeAudit(decision),
      candidates: {
        sql: sqlResult?.ok ? sqlResult.rows.length : 0,
        vector: vecResult?.ok ? vecResult.hits.length : 0,
        graph: graphResult?.items.length ?? 0,
        fused: fused.length,
      },
      branch_errors: branchErrors,
      curate: curateAudit(curated),
      ...(graphResult?.not_found ? { not_found: graphResult.not_found } : {}),
      ...(graphResult?.missing?.length ? { missing_entities: graphResult.missing } : {}),
      ...(graphResult?.truncated ? { graph_truncated: graphResult.truncated } : {}),
      ...(graphResult?.fitted ? { graph_fitted: graphResult.fitted } : {}),
    },
  };
}

// --- end-to-end ask: retrieve -> 7B answer over the curated context ---

export type AnswerFn = (query: string, context: string) => Promise<string>;

/** 쓰기 요청의 답. 바뀐 것이 없으므로 무엇을 했다고 말하지 않는다(시험항목 TC-145, TC-146 은
 * 답에 「변경」, 「삭제」, 「완료」, 「했습니다」가 없어야 한다). */
export function writeRefusal(kind: string): string {
  return (
    "데이터를 바꾸는 요청은 처리하지 않습니다. 이 서버는 읽기 전용이라 조회만 하며, " +
    `생성 모델이 만든 ${kind} 문은 실행하지 않았습니다.`
  );
}

/** 생성 SQL 이 테이블을 읽지 않는 상수 SELECT 뿐이고 다른 근거도 없을 때의 답. */
export const NO_TABLE_ANSWER =
  "주어진 정보로는 알 수 없습니다. 이 질문에 답할 데이터가 데이터베이스에 없어 조회하지 않았습니다.";

export interface AskResult extends RetrieveResult {
  answer: string;
}

/** Full pipeline: deterministic retrieval spine + the on-prem 7B answer step.
 * `llm` is injectable so the eval / tests can substitute a stub. */
export async function ask(
  query: string,
  deps: RetrieveDeps & { llm?: AnswerFn },
): Promise<AskResult> {
  const r = await retrieve(query, deps);

  // 생성 모델이 쓰기 문장을 만들었다면 질문은 데이터를 바꾸라는 요청이다. 실행하지 않았고 이 서버는
  // 바꾸지 않으므로 그렇게 말한다. 종전에는 빈 컨텍스트로 7B 를 불러 「주어진 정보로는 알 수 없습니다」라고
  // 답했다 — 데이터가 없다는 뜻으로 읽힌다(G17 ②).
  const refused = r.sql.refused;
  if (refused && refused.kind !== NO_TABLE) {
    return { ...r, answer: writeRefusal(refused.kind) };
  }

  // ★ 근거가 없는 것과 근거를 **가져올 수 없는** 것은 다르다.
  //
  // 2026-08-17 실측: DB 가 죽은 상태에서도 ask 는 "주어진 정보로는 알 수 없습니다"
  // 라고 답했다. 접지 규율은 옳지만, 그 문장은 **데이터셋에 그 내용이 없다**는 뜻이다.
  // 인프라 장애를 그 문장으로 덮으면 사용자는 시스템이 모른다고 읽는다 —
  // 실제로는 자기 설정이 틀린 것인데.
  //
  // 컨텍스트가 비었고 **동시에** 레인이 실패했다면 LLM 을 부르지 않는다.
  // 답을 지어내지 않되, 왜 답할 수 없는지는 정확히 말한다.
  const branchErrors = r.audit?.branch_errors ?? [];
  if (r.context.length === 0 && branchErrors.length > 0) {
    return {
      ...r,
      answer:
        "조회에 실패해 답할 근거를 가져오지 못했습니다. 데이터가 없는 것이 아니라 " +
        `조회 자체가 실패했습니다: ${branchErrors.join(" / ")}`,
    };
  }

  // 게이트가 개체를 못 찾았으면 답할 내용은 이미 정해져 있다. 7B 에게 다시 쓰게 하면
  // 사유가 빠진다 — 실측 답은 「주어진 정보로는 알 수 없습니다」 한 줄이었다.
  if (r.not_found) {
    return { ...r, answer: describeNotFound(r.not_found) };
  }

  // 테이블을 읽지 않는 SELECT 만 나왔고 다른 근거도 없다. 데이터에 답이 없는 질문이다.
  if (refused && r.context.length === 0) {
    return { ...r, answer: NO_TABLE_ANSWER };
  }

  // 섞인 질문에서 없는 개체는 결정론 문장으로 먼저 말하고, 7B 는 그 개체가 든 마디를 뺀 질문에
  // 찾은 개체의 근거로만 답한다. 사유 줄은 7B 컨텍스트에서 뺀다(같은 말을 두 번 하지 않게).
  const missingLines = new Set((r.missing ?? []).map((nf) => `[그래프] ${describeNotFound(nf)}`));
  const head = missingLines.size ? `${(r.missing ?? []).map(describeNotFound).join(" ")}\n\n` : "";
  const answerContext = missingLines.size
    ? r.context.split("\n").filter((l) => !missingLines.has(l)).join("\n")
    : r.context;

  const gen = deps.llm ?? llmAnswer;
  try {
    const answer = await gen(r.answer_query ?? query, answerContext);
    return { ...r, answer: head + withSqlRows(r, answer) };
  } catch (e) {
    // ★ 생성 LLM 이 **기동 후** 죽는 경우.
    //
    // 기동 시 부재는 프리플라이트가 정확히 안내한다. 운영 중 컨테이너가 내려가는
    // 경우는 그 검사를 이미 지났다 — 2026-08-17 실측에서 `AggregateError` 가
    // `message: ""` 인 채로 그대로 던져졌고, 사용자는 **빈 이유**를 받았다.
    //
    // 조회는 성공했다. "조회 실패" 로 뭉뚱그리지 않고 생성만 실패했다고 말한다 —
    // 근거는 있으니 사용자가 컨텍스트를 직접 볼 수도 있다.
    const why = describeError(e);
    return {
      ...r,
      // 정형 레인이면 조회 결과는 생성 없이도 보여줄 수 있다.
      answer:
        head +
        withSqlRows(
          r,
          // 건수는 큐레이션이 남긴 항목 수다. context.length 는 글자 수라 「412건」이 됐다.
          `근거는 ${r.curated.kept.length}건 찾았지만 답변 생성에 실패했습니다: ${why}\n` +
            "로컬 LLM(Ollama)이 떠 있는지 확인하세요. 근거 자체는 audit 의 context 에 있습니다.",
        ),
      audit: {
        ...r.audit,
        branch_errors: [...(r.audit?.branch_errors ?? []), `answer: ${why}`],
      },
    };
  }
}
