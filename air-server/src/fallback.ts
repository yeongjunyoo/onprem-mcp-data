// Copyright 2026 Yeongjun Yoo
// SPDX-License-Identifier: Apache-2.0
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// 다음 순위 레인 — 라우터가 확신하지 못한 채 고른 레인이 빈손으로 돌아오면 다음 순위 레인을 한 번 돌린다.
//
// 문서 질문이 정형 레인으로 가 0건, null 집계, 실행 전 검사 거부로 끝났고(홀드아웃3 #35, 홀드아웃4 #32, #40), 정형 질문이 그래프로 가
// 「부서마다」를 개체로 찾다 못 찾았다(홀드아웃4 #1). 넷 다 규칙이 확신하지 못해 시맨틱 폴백이 고른 레인이었고, 시맨틱의 2위 레인이
// 바로 맞는 레인이었다(2026-10-11 진단). 판단은 레인의 결과 상태(못 찾음, 0건, null, 거부)로만 하고 질문의 낱말은 보지 않는다.
// 확신한 규칙의 결과는 그대로다: 데이터에 없는 고객사(사업자 24번 「서울물산」)는 확신한 규칙이 그래프로 보내 「찾지 못했습니다」가 답이다.
// 이름처럼 생긴 낱말을 못 찾은 것, 데이터에 없는 항목, 쓰기 요청, 대상 없는 측정 낱말은 빈손이 아니라 그 자체로 답이다.
import type { Pool } from "./db.js";
import { LANES, SQL_TOOL, VECTOR_TOOL, ONTOLOGY_TOOL, GRAPH_TOOL, buildGraphPlan, type Lane, type Route, type RouteDecision } from "./router.js";
import type { RetrieveResult } from "./pipeline.js";
import { NO_TABLE } from "./nl2sql.js";
import { entityLikeName } from "./notfound.js";
import { namedDocumentInHits } from "./evidence.js";
import { describeError } from "./errors.js";

const LANE_OF: Record<Route, Lane | null> = { structured: "nl2sql", semantic: "vector_search", graph: "knowledge_graph", hybrid: null };
const ROUTE_OF: Record<Lane, { route: Route; tools: string[] }> = {
  nl2sql: { route: "structured", tools: [SQL_TOOL] },
  vector_search: { route: "semantic", tools: [VECTOR_TOOL] },
  knowledge_graph: { route: "graph", tools: [ONTOLOGY_TOOL, GRAPH_TOOL] },
};

/** 생성 SQL 자체의 오류(문법 42601, 없는 열 42703, 없는 표 42P01, 없는 함수 42883). 연결과 권한 오류는 장애라 여기에 들지 않는다. */
const GENERATED_SQL_ERROR = /\((?:42601|42703|42P01|42883)\)\s*$/;

/** 합계, 평균, 최댓값, 최솟값 집계가 값이 모두 null 인 한 행을 돌려줬는가(집계할 행이 없다). */
function nullAggregate(r: RetrieveResult): boolean {
  const res = r.sql.result;
  if (!res?.ok || res.rows.length !== 1 || !/\b(?:sum|avg|min|max)\s*\(/i.test(r.sql.text ?? "")) return false;
  const vals = Object.values(res.rows[0]);
  return vals.length > 0 && vals.every((v) => v === null);
}

/** 고른 레인이 쓸 근거 없이 돌아왔으면 그 사유, 아니면 undefined. 단일 레인 라우트만 본다(hybrid 는 이미 여러 레인이 돌았다).
 * 레인이 실패했으면(branch_errors) 빈손이 아니라 장애라 그대로 알린다. */
export function emptyLane(r: RetrieveResult): string | undefined {
  if (r.audit.branch_errors.length) return undefined;
  if (r.route === "structured") {
    const s = r.sql;
    if (s.refused) return s.refused.kind === NO_TABLE ? "the generated SELECT reads no table" : undefined;
    if (s.absent || s.gate?.vague) return undefined;
    if ((s.missing ?? []).some((nf) => s.text?.includes(nf.query_entity))) return undefined;
    if (s.gate?.outcome === "refused") return "the pre-execution check refused the generated SQL";
    if (!s.result) return s.text === null ? "no SQL was generated" : undefined;
    if (!s.result.ok) return GENERATED_SQL_ERROR.test(s.result.error ?? "") ? `the generated SQL failed: ${s.result.error}` : undefined;
    if (!s.result.rows.length) return "0 rows";
    if (nullAggregate(r)) return "the aggregate is NULL";
    return undefined;
  }
  if (r.route === "graph") {
    const g = r.graph;
    if (!g || g.error || r.missing?.length || r.pair) return undefined;
    if (g.strategy === "unresolved") {
      const nf = g.not_found;
      // 이름처럼 생긴 낱말(Client-ZZ, 서울물산)이나 비슷한 이름이 있는 낱말을 못 찾은 것은 「없는 개체」라는 답이다.
      if (nf && (nf.reason === "similar_name_mismatch" || entityLikeName(nf.query_entity) !== null)) return undefined;
      return `no entity resolved${nf ? ` (${nf.query_entity})` : ""}`;
    }
    if (g.edgeCount === 0 && !g.ranking?.length) return "no edge from the resolved entities";
    return undefined;
  }
  if (r.route === "semantic" && !r.documents && r.vector?.ok && !r.vector.hits.length) return "no document chunk";
  return undefined;
}

/** 다음 순위 레인으로 바꾼 라우팅 결정. 규칙이 확신했거나, 전용 길(문서 개수, 두 개체의 관계, 제품 상태)이거나, hybrid 면 undefined.
 * 순위는 시맨틱 폴백의 레인별 유사도(있으면)이고 없으면 규칙 점수다. 같으면 LANES 순서다(결정론). */
export function runnerUp(query: string, d: RouteDecision, why: string): RouteDecision | undefined {
  if (d.gate.confident || d.docCount || d.pair || d.productState) return undefined;
  const chosen = LANE_OF[d.route];
  if (!chosen) return undefined;
  const scores = d.semantic?.scores ?? d.gate.scores;
  const next = LANES.filter((l) => l !== chosen).sort((a, b) => scores[b] - scores[a])[0];
  const { route, tools } = ROUTE_OF[next];
  const graphPlan =
    next === "knowledge_graph"
      ? buildGraphPlan(query.trim(), d.typePair?.relation ? [d.typePair.relation] : [], d.structuredHits.includes("superlative"))
      : undefined;
  return { ...d, route, tools, graphPlan, rationale: `${d.rationale}; ${chosen} came back empty (${why}) -> runner-up ${next}` };
}

/** 라우팅 결정으로 레인을 돌리고(run), 확신 없이 고른 레인이 빈손이면 다음 순위 레인을 한 번 돌린다. 그 레인이 근거를 냈으면(rejected 가
 * undefined) 그 결과로, 아니면 처음 결과로 답한다. 다음 순위를 돌렸으면 audit.route_fallback 에 남고, 쓰지 않았으면 그 이유(rejected)도 남는다. */
export async function withRunnerUp(
  query: string,
  decision: RouteDecision,
  run: (d: RouteDecision) => Promise<RetrieveResult>,
  rejected: (r: RetrieveResult) => Promise<string | undefined>,
): Promise<RetrieveResult> {
  const first = await run(decision);
  const why = emptyLane(first);
  const alt = why ? runnerUp(query, decision, why) : undefined;
  if (!why || !alt) return first;
  const second = await run(alt);
  const no = await rejected(second);
  const fallback = { from: decision.route, to: alt.route, reason: why, used: no === undefined, ...(no !== undefined ? { rejected: no } : {}) };
  return no === undefined ? { ...second, audit: { ...second.audit, route_fallback: fallback } } : { ...first, audit: { ...first.audit, route_fallback: fallback } };
}

/** 다음 순위 레인의 결과를 쓰지 않을 이유. 근거가 있으면 undefined. 정형은 값이 있는 행, 그래프는 해소한 개체의 엣지가 근거다. 문서 레인은
 * 상위 k 조각이 늘 있으므로 그것만으로는 근거가 아니다. 질문이 식별자, 날짜, 종류로 문서 하나를 분명히 가리키고(evidence.ts namedDocument,
 * 식별자 집합만으로 고른 것은 빼고) 검색이 그 문서를 찾았을 때만 근거로 본다. 문서 제목을 읽다 실패하면 그 오류가 이유다. */
export async function runnerUpRejection(pool: Pool, query: string, r: RetrieveResult): Promise<string | undefined> {
  if (r.audit.branch_errors.length) return `lane failure: ${r.audit.branch_errors.join(" / ")}`;
  const empty = emptyLane(r);
  if (empty !== undefined) return empty;
  if (r.route === "structured") {
    return r.sql.result?.ok && r.sql.result.rows.length && !r.sql.refused && !r.sql.absent ? undefined : "no rows to answer from";
  }
  if (r.route === "graph") {
    return r.graph && r.graph.strategy !== "unresolved" && !r.not_found && (r.graph.edgeCount > 0 || r.graph.ranking?.length) ? undefined : "no edge to answer from";
  }
  if (r.route === "semantic" && r.vector?.ok) {
    let named;
    try {
      named = await namedDocumentInHits(pool, query, r.vector.hits);
    } catch (err) {
      return `reading document titles failed: ${describeError(err)}`;
    }
    if (!named) return "the question names no single document the search found";
    return named.by_identifier_set ? "the document is picked by its identifier set only" : undefined;
  }
  return "no usable evidence";
}
