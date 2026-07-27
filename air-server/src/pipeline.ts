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
import { sqlQuery, type SqlResult } from "./sql.js";
import { vectorSearch, type VectorResult } from "./vector.js";
import { rrfMerge, type Ranked, type Fused } from "./rrf.js";
import { curate, render, curateAudit, type ContextItem, type Curated } from "./curator.js";
import { type NL2SQL, llmNL2SQL } from "./nl2sql.js";
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

export interface RetrieveDeps {
  pool: Pool;
  embedder: Embedder;
  nl2sql?: NL2SQL; // default: deterministic template fast-path
  k?: number; // vector top-k (default 5)
  budget?: number; // curator token budget (default 256)
}

export interface RetrieveResult {
  query: string;
  route: RouteDecision["route"];
  sql: { text: string | null; result?: SqlResult };
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

  const onto = await ontologySearch(pool, query, k, schema);
  if (!onto.ok) return { seeds: [], edgeCount: 0, strategy: "none", items: [], error: onto.error };
  const seeds = onto.hits.map((h) => ({ entityId: h.entityId, canonicalName: h.canonicalName, type: h.type }));
  const items: Candidate[] = ontologyCandidates(onto.hits);
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
    const exp = await graphExpand(pool, hit.entityId, depth, relTypes, schema, "both");
    if (!exp.ok) return { seeds, edgeCount, strategy: "seeded", items, error: exp.error };
    edgeCount += exp.edges.length;
    items.push(...edgeCandidates(exp.edges));
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
  const nl2sql = deps.nl2sql ?? llmNL2SQL;
  const k = deps.k ?? 5;
  const budget = deps.budget ?? 256;

  const decision = route(query);
  const wantSql = decision.route === "structured" || decision.route === "hybrid";
  const wantVec = decision.route === "semantic" || decision.route === "hybrid";
  const wantGraph = decision.route === "graph";

  // --- parallel fan-out (MCP Parallel): the vector branch starts immediately and
  // runs CONCURRENTLY with NL2SQL+SQL; allSettled isolates branches so a failure
  // in one (e.g. NL2SQL throws) still yields the other's context (graceful degradation). ---
  const sqlBranch = (async (): Promise<{ text: string | null; result?: SqlResult }> => {
    if (!wantSql) return { text: null };
    const text = await nl2sql(query);
    return { text, result: text ? await sqlQuery(pool, text) : undefined };
  })();
  const vecBranch: Promise<VectorResult | undefined> = wantVec
    ? vectorSearch(pool, embedder, query, k)
    : Promise.resolve(undefined);
  // The graph lane (L5): resolve the query's entities, then BFS their typed edges.
  // Runs concurrently with the other branches and is isolated the same way.
  const graphBranch: Promise<GraphLaneResult | undefined> = wantGraph
    ? graphLane(pool, query, k, 2, kgSchema(), decision.graphPlan)
    : Promise.resolve(undefined);

  const [sqlSettled, vecSettled, graphSettled] = await Promise.allSettled([sqlBranch, vecBranch, graphBranch]);
  const sql = sqlSettled.status === "fulfilled" ? sqlSettled.value : { text: null as string | null };
  const sqlText = sql.text;
  const sqlResult = sql.result;
  const vecResult = vecSettled.status === "fulfilled" ? vecSettled.value : undefined;
  const graphResult = graphSettled.status === "fulfilled" ? graphSettled.value : undefined;
  const branchErrors: string[] = [];
  if (sqlSettled.status === "rejected") branchErrors.push(`sql: ${String(sqlSettled.reason)}`);
  if (vecSettled.status === "rejected") branchErrors.push(`vector: ${String(vecSettled.reason)}`);
  if (graphSettled.status === "rejected") branchErrors.push(`graph: ${String(graphSettled.reason)}`);
  if (graphResult?.error) branchErrors.push(`graph: ${graphResult.error}`);

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
    sql: { text: sqlText, result: sqlResult },
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
  const gen = deps.llm ?? llmAnswer;
  const answer = await gen(query, r.context);
  return { ...r, answer };
}
