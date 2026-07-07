// End-to-end retrieval pipeline (the differentiator spine):
//   route (L3, deterministic)  ->  parallel fan-out (sql.query ∥ vector.search)
//   ->  RRF merge  ->  L4 structure-preserving curation  ->  curated context.
//
// The 7B answer step consumes `context` (added in the LLM increment). Everything
// here is deterministic given a deterministic nl2sql + embedder, so the whole
// spine is reproducible and unit-testable without a model.

import type { Pool } from "./db.js";
import type { Embedder } from "./embedder.js";
import { route, type RouteDecision } from "./router.js";
import { sqlQuery, type SqlResult } from "./sql.js";
import { vectorSearch, type VectorResult } from "./vector.js";
import { rrfMerge, type Ranked, type Fused } from "./rrf.js";
import { curate, render, curateAudit, type ContextItem, type Curated } from "./curator.js";
import { type NL2SQL, llmNL2SQL } from "./nl2sql.js";
import { answer as llmAnswer } from "./llm.js";

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
  fused: Fused<ContextItem>[];
  curated: Curated;
  context: string;
  audit: {
    route: ReturnType<typeof routeAudit>;
    candidates: { sql: number; vector: number; fused: number };
    branch_errors: string[];
    curate: ReturnType<typeof curateAudit>;
  };
}

function routeAudit(d: RouteDecision) {
  return {
    route: d.route,
    tools: d.tools,
    structured_signals: d.structuredHits,
    semantic_signals: d.semanticHits,
    rationale: d.rationale,
    deterministic: true,
  };
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

  const [sqlSettled, vecSettled] = await Promise.allSettled([sqlBranch, vecBranch]);
  const sql = sqlSettled.status === "fulfilled" ? sqlSettled.value : { text: null as string | null };
  const sqlText = sql.text;
  const sqlResult = sql.result;
  const vecResult = vecSettled.status === "fulfilled" ? vecSettled.value : undefined;
  const branchErrors: string[] = [];
  if (sqlSettled.status === "rejected") branchErrors.push(`sql: ${String(sqlSettled.reason)}`);
  if (vecSettled.status === "rejected") branchErrors.push(`vector: ${String(vecSettled.reason)}`);

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

  // --- RRF merge -> L4 curation ---
  const fused = rrfMerge(lists);
  const curated = curate(query, fused.map((f) => f.value), budget);

  return {
    query,
    route: decision.route,
    sql: { text: sqlText, result: sqlResult },
    vector: vecResult,
    fused,
    curated,
    context: render(curated),
    audit: {
      route: routeAudit(decision),
      candidates: {
        sql: sqlResult?.ok ? sqlResult.rows.length : 0,
        vector: vecResult?.ok ? vecResult.hits.length : 0,
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
