// End-to-end retrieval pipeline (the differentiator spine):
//   route (L3, deterministic)  ->  parallel fan-out (sql.query ∥ vector.search)
//   ->  RRF merge  ->  L4 structure-preserving curation  ->  curated context.
//
// The 7B answer step consumes `context` (added in the LLM increment). Everything
// here is deterministic given a deterministic nl2sql + embedder, so the whole
// spine is reproducible and unit-testable without a model.

import type { Pool } from "./db.js";
import type { Embedder } from "./embedder.js";
import { route, audit as routeAuditLog, type RouteDecision, type GraphPlan } from "./router.js";
import { sqlQuery, columnsForSql, type SqlResult } from "./sql.js";
import { keywordIndexReady, keywordSearch, type KeywordSearchResult } from "./keyword.js";
import { vectorSearch, type VectorResult } from "./vector.js";
import { rrfMerge, type Ranked, type Fused } from "./rrf.js";
import { curate, render, curateAudit, type ContextItem, type Curated } from "./curator.js";
import { type NL2SQL, repairSql } from "./nl2sql.js";
import { profile } from "./profile.js";
import { answer as llmAnswer } from "./llm.js";
import {
  ontologySearch,
  seedTerms,
  graphExpand,
  relationScan,
  ontologyCandidates,
  edgeCandidates,
  rankingCandidates,
  kgSchema,
} from "./graph.js";
import type { Candidate } from "./candidate.js";
import { describeError } from "./errors.js";

export interface RetrieveDeps {
  pool: Pool;
  embedder: Embedder;
  nl2sql?: NL2SQL; // default: deterministic template fast-path
  k?: number; // vector top-k (default 5)
  budget?: number; // curator token budget (default 256)
  repair?: boolean; // retry a rejected SQL once with the DB error (default true)
}

export interface RetrieveResult {
  query: string;
  route: RouteDecision["route"];
  sql: { text: string | null; result?: SqlResult; repaired?: boolean };
  vector?: VectorResult;
  graph?: GraphLaneResult;
  fused: Fused<ContextItem>[];
  curated: Curated;
  context: string;
  audit: {
    route: ReturnType<typeof routeAudit>;
    candidates: { sql: number; vector: number; graph: number; fused: number };
    branch_errors: string[];
    curate: ReturnType<typeof curateAudit>;
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
  error?: string;
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
  const p = plan ?? route(query).graphPlan;
  const relTypes = p?.relTypes?.length ? p.relTypes : undefined;
  // When the question names a RELATION, one hop is the answer and every extra hop
  // is noise: "Product-S1 관련 고객 이슈" pulled in Client-X -> Product-C2 edges two
  // hops away and the 7B, reading a context full of other products, concluded there
  // were no Product-S1 issues at all. Unspecified relations (two-hop questions like
  // "Product-D1 관련 프로젝트") keep the requested depth.
  const hops = relTypes ? 1 : depth;

  const onto = await ontologySearch(pool, query, k, schema);
  if (!onto.ok) return { seeds: [], edgeCount: 0, strategy: "none", items: [], error: onto.error };
  const seeds = onto.hits.map((h) => ({ entityId: h.entityId, canonicalName: h.canonicalName, type: h.type }));
  // Order matters: EDGES first, name-resolution hits last. RRF keeps one entry per
  // key at its best rank, and a seed hit ("윤소연 — 별칭 매칭 '경영지원팀'") shares its
  // key with the edge that actually answers ("경영지원팀의 부서장: 윤소연"). Listed
  // first, the near-empty seed line won and the model answered "알 수 없습니다" with
  // the answer one line below the cut. Facts before bookkeeping.
  const items: Candidate[] = [];
  let edgeCount = 0;

  // Anti-hallucination gate: the question names an entity, nothing resolves, and the
  // plan has no relation-level intent -> say so. Dumping every edge of the relation
  // would hand the 7B a context that CONTAINS plausible-looking wrong answers
  // (the sponsor's own example "서울물산 담당 엔지니어" names a client absent from the
  // dataset; the honest output is "없음", not the 63 MANAGES_ACCOUNT edges).
  if (onto.hits.length === 0 && !(p?.aggregate || p?.filter)) {
    const terms = seedTerms(query);
    return {
      seeds: [],
      edgeCount: 0,
      strategy: "unresolved",
      items: [
        {
          canonicalKey: `unresolved#${terms.join("+")}`,
          sourceKey: "graph#unresolved",
          source: "graph" as const,
          text: `[그래프] 질의에 등장한 대상(${terms.join(", ")})을 지식그래프에서 찾지 못했습니다. 해당 개체는 데이터셋에 존재하지 않습니다.`,
          provenance: "ontology:unresolved",
        },
      ],
    };
  }

  // Seeded traversal: expand only from EXACT/prefix seeds when we have any, so a
  // single well-named entity is not drowned by substring noise.
  const best = Math.max(0, ...onto.hits.map((h) => h.score));
  const expandFrom = onto.hits.filter((h) => h.score === best);
  for (const hit of expandFrom) {
    const exp = await graphExpand(pool, hit.entityId, hops, relTypes, schema, "both");
    if (!exp.ok) return { seeds, edgeCount, strategy: "seeded", items, error: exp.error };
    edgeCount += exp.edges.length;
    items.push(...edgeCandidates(exp.edges, hit.entityId));
  }

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
      return { seeds, edgeCount, strategy: "relation-scan", items, error: scan.error };
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
  items.push(...ontologyCandidates(onto.hits));

  const strategy: GraphLaneResult["strategy"] =
    expandFrom.length && needScan
      ? "seeded+relation-scan"
      : expandFrom.length
        ? "seeded"
        : needScan
          ? "relation-scan"
          : "none";
  return { seeds, edgeCount, strategy, ranking, items };
}

function renderRow(row: Record<string, unknown>): string {
  return Object.entries(row)
    .map(([k, v]) => `${k}=${v}`)
    .join(" | ");
}

/** Run the retrieval spine for one query.
 * Deterministic parts: route (L3) + RRF merge + L4 curation. The structured
 * path's NL2SQL is the 7B by default (faithful to the brief; this is the path
 * the execution-match eval measures, so eval == live). Inject `nl2sql:
 * templateNL2SQL` for an offline, zero-LLM deterministic fast-path. */
export async function retrieve(query: string, deps: RetrieveDeps): Promise<RetrieveResult> {
  const { pool, embedder } = deps;
  const nl2sql = deps.nl2sql ?? profile().nl2sql;
  const k = deps.k ?? 5;
  const budget = deps.budget ?? 256;

  const decision = route(query);
  const wantSql = decision.route === "structured" || decision.route === "hybrid";
  const wantVec = decision.route === "semantic" || decision.route === "hybrid";
  const wantGraph = decision.route === "graph";

  // --- parallel fan-out (MCP Parallel): the vector branch starts immediately and
  // runs CONCURRENTLY with NL2SQL+SQL; allSettled isolates branches so a failure
  // in one (e.g. NL2SQL throws) still yields the other's context (graceful degradation). ---
  const sqlBranch = (async (): Promise<{ text: string | null; result?: SqlResult; repaired?: boolean }> => {
    if (!wantSql) return { text: null };
    const text = await nl2sql(query);
    if (!text) return { text: null };
    const first = await sqlQuery(pool, text);
    if (first.ok || deps.repair === false) return { text, result: first };
    // The engine rejected it (unknown column, bad function, ...). Feed the error
    // back exactly once — an empty context is a worse failure than a second call.
    const cols = await columnsForSql(pool, text, profile().kgSchema === "companyx" ? "companyx" : "public").catch(() => "");
    const fixed = await repairSql(query, text, first.error ?? "unknown error", cols);
    if (!fixed) return { text, result: first };
    const second = await sqlQuery(pool, fixed);
    return second.ok ? { text: fixed, result: second, repaired: true } : { text, result: first };
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
  const sql =
    sqlSettled.status === "fulfilled"
      ? sqlSettled.value
      : { text: null as string | null, result: undefined as SqlResult | undefined, repaired: undefined as boolean | undefined };
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
  }
  if (vecResult?.ok) {
    lists.push(
      vecResult.hits.map((h) => ({
        key: `documents#${h.id}`,
        value: { kind: "chunk", text: `${h.title}: ${h.body}`, source: `documents#${h.id}` },
      })),
    );
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
  }
  if (graphResult && graphResult.items.length) {
    lists.push(
      graphResult.items.map((it, i) => ({
        key: it.canonicalKey,
        value: { kind: "chunk" as const, text: it.text, source: `graph#${i}` },
      })),
    );
  }

  // --- RRF merge -> L4 curation ---
  const fused = rrfMerge(lists);
  const curated = curate(query, fused.map((f) => f.value), budget);

  return {
    query,
    route: decision.route,
    sql: { text: sqlText, result: sqlResult, repaired: sql.repaired },
    vector: vecResult,
    graph: graphResult,
    fused,
    curated,
    context: render(curated),
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
    },
  };
}

// --- end-to-end ask: retrieve -> 7B answer over the curated context ---

export type AnswerFn = (query: string, context: string) => Promise<string>;

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

  const gen = deps.llm ?? llmAnswer;
  try {
    const answer = await gen(query, r.context);
    return { ...r, answer };
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
      answer:
        `근거는 ${r.context.length}건 찾았지만 답변 생성에 실패했습니다: ${why}\n` +
        "로컬 LLM(Ollama)이 떠 있는지 확인하세요. 근거 자체는 audit 의 context 에 있습니다.",
      audit: {
        ...r.audit,
        branch_errors: [...(r.audit?.branch_errors ?? []), `answer: ${why}`],
      },
    };
  }
}
