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

// 다음 순위 레인(fallback.ts) 테스트. DB 도 모델도 없이 돈다. 판단은 레인의 결과 상태로만 하므로 결과를 직접 만들어 넣는다.
import type { Pool } from "pg";

import { emptyLane, runnerUp, runnerUpUsable, withRunnerUp } from "./fallback.js";
import type { RetrieveResult } from "./pipeline.js";
import type { Lane, RouteDecision } from "./router.js";
import { NO_TABLE } from "./nl2sql.js";

let pass = 0, fail = 0;
function ok(cond: unknown, msg: string) {
  if (cond) pass++;
  else {
    fail++;
    console.error("  FAIL:", msg);
  }
}

const curated = { kept: [], dropped: [], tokensUsed: 0, budget: 1024, brokenRows: 0, notes: [] };
const audit = { route: {}, candidates: { sql: 0, vector: 0, graph: 0, fused: 0 }, branch_errors: [] as string[], curate: {} };
function result(over: Record<string, unknown>): RetrieveResult {
  return { query: "q", route: "structured", sql: { text: null }, fused: [], curated, context: "", audit: { ...audit }, ...over } as unknown as RetrieveResult;
}
const rows = (n: number, row: Record<string, unknown> = { n: 1 }) => ({ ok: true, rows: Array.from({ length: n }, () => row), rowCount: n, columns: Object.keys(row), truncated: false });

// ── 빈손 판정: 정형 레인 ────────────────────────────────────────────────
{
  const sql = (s: Record<string, unknown>) => result({ route: "structured", sql: { text: "SELECT 1 FROM t", ...s } });
  ok(emptyLane(sql({ result: rows(0) })) === "0 rows", "0건");
  ok(emptyLane(sql({ text: "SELECT SUM(a) AS s FROM t", result: rows(1, { s: null }) })) === "the aggregate is NULL", "null 집계");
  ok(emptyLane(sql({ text: "SELECT a FROM t", result: rows(1, { a: null }) })) === undefined, "집계가 아닌 null 값은 빈손이 아니다");
  ok(emptyLane(sql({ result: rows(2) })) === undefined, "행이 있으면 빈손이 아니다");
  ok(/refused/.test(emptyLane(sql({ text: null, gate: { outcome: "refused", rejected: [] } })) ?? ""), "실행 전 검사가 거부");
  ok(emptyLane(sql({ text: null, gate: { outcome: "refused", rejected: [], vague: { word: "매출" } } })) === undefined, "대상 없는 측정 낱말은 되묻는 답이다");
  ok(/42703/.test(emptyLane(sql({ result: { ok: false, rows: [], rowCount: 0, columns: [], truncated: false, error: "column x does not exist (42703)" } })) ?? ""), "생성 SQL 오류");
  ok(emptyLane(sql({ result: { ok: false, rows: [], rowCount: 0, columns: [], truncated: false, error: "connect ECONNREFUSED" } })) === undefined, "연결 오류는 장애라 빈손이 아니다");
  ok(emptyLane(sql({ text: null, refused: { kind: "UPDATE", text: "UPDATE t SET a = 1" } })) === undefined, "쓰기 요청 거절은 그대로 답이다");
  ok(/no table/.test(emptyLane(sql({ text: null, refused: { kind: NO_TABLE, text: "SELECT 1" } })) ?? ""), "테이블을 읽지 않는 상수 SELECT");
  ok(emptyLane(sql({ text: null, absent: "나이" })) === undefined, "없는 항목은 그대로 답이다");
  ok(emptyLane(sql({ text: "SELECT * FROM t WHERE name = '서울물산'", result: rows(0), missing: [{ reason: "not_in_database", query_entity: "서울물산", candidates: [] }] })) === undefined, "없는 개체를 찾은 0건은 그대로 답이다");
  ok(emptyLane(result({ route: "structured", sql: { text: "SELECT 1 FROM t", result: rows(0) }, audit: { ...audit, branch_errors: ["vector: down"] } })) === undefined, "레인 장애가 있으면 빈손으로 보지 않는다");
  ok(emptyLane(sql({ text: null })) === "no SQL was generated", "SQL 을 만들지 못했다");
}

// ── 빈손 판정: 그래프, 문서, hybrid ──────────────────────────────────────
{
  const graph = (g: Record<string, unknown>, over: Record<string, unknown> = {}) => result({ route: "graph", graph: { seeds: [], edgeCount: 0, items: [], ...g }, ...over });
  const nf = (query_entity: string, reason = "not_in_database") => ({ reason, query_entity, candidates: [] });
  ok(/부서마다/.test(emptyLane(graph({ strategy: "unresolved", not_found: nf("부서마다") })) ?? ""), "이름이 아닌 낱말을 못 찾은 것은 빈손");
  ok(emptyLane(graph({ strategy: "unresolved", not_found: nf("서울물산") })) === undefined, "조직 접미사 이름(서울물산)을 못 찾은 것은 「없다」는 답");
  ok(emptyLane(graph({ strategy: "unresolved", not_found: nf("Client-ZZ") })) === undefined, "식별자 꼴 이름을 못 찾은 것도 「없다」는 답");
  ok(emptyLane(graph({ strategy: "unresolved", not_found: nf("클라우드사업부서", "similar_name_mismatch") })) === undefined, "비슷한 이름만 있는 것도 그대로 답");
  ok(/no edge/.test(emptyLane(graph({ strategy: "seeded", edgeCount: 0 })) ?? ""), "해소했지만 엣지가 없다");
  ok(emptyLane(graph({ strategy: "seeded", edgeCount: 3 })) === undefined, "엣지가 있으면 빈손이 아니다");
  ok(emptyLane(graph({ strategy: "relation-scan", edgeCount: 0, ranking: [{ name: "a", type: "employee", count: 0 }] })) === undefined, "순위가 있으면 빈손이 아니다");
  ok(emptyLane(graph({ strategy: "seeded", edgeCount: 0 }, { missing: [nf("서울물산")] })) === undefined, "섞인 질문의 없는 개체는 그대로 답");
  ok(emptyLane(result({ route: "semantic", vector: { ok: true, hits: [], embedder: "t" } })) === "no document chunk", "문서 조각이 없다");
  ok(emptyLane(result({ route: "semantic", vector: { ok: true, hits: [{ id: 1, title: "t", body: "b", score: 1 }], embedder: "t" } })) === undefined, "조각이 있으면 빈손이 아니다");
  ok(emptyLane(result({ route: "hybrid", sql: { text: "SELECT 1 FROM t", result: rows(0) } })) === undefined, "hybrid 는 이미 여러 레인이 돌았다");
}

// ── 다음 순위 레인 ──────────────────────────────────────────────────────
const decision = (route: RouteDecision["route"], over: Partial<RouteDecision> = {}): RouteDecision => ({
  route,
  tools: [],
  structuredHits: [],
  semanticHits: [],
  graphHits: [],
  docHits: [],
  entityHits: [],
  rationale: "rule margin 1 < gate",
  gate: { scores: { nl2sql: 1, vector_search: 0, knowledge_graph: 0 }, pick: "nl2sql", margin: 1, confident: false },
  ...over,
});
const sem = (lane: Lane, scores: Record<Lane, number>) => ({ lane, margin: 0.03, scores, nearest: { lane, type: "t", text: "a", score: scores[lane] }, applied: true });
{
  const d1 = decision("structured", { semantic: sem("nl2sql", { nl2sql: 0.7, vector_search: 0.66, knowledge_graph: 0.6 }) });
  const a1 = runnerUp("q", d1, "0 rows");
  ok(a1?.route === "semantic" && a1.tools.join() === "vector.search", "시맨틱 2위(문서)로 간다");
  ok(/nl2sql came back empty \(0 rows\) -> runner-up vector_search/.test(a1?.rationale ?? ""), `근거에 남는다 (got ${a1?.rationale})`);
  ok(a1?.graphPlan === undefined, "문서 레인에는 탐색 계획이 없다");
  const d2 = decision("graph", { semantic: sem("knowledge_graph", { nl2sql: 0.69, vector_search: 0.59, knowledge_graph: 0.72 }), typePair: { relation: "BELONGS_TO", from: "employee", to: "department" } });
  ok(runnerUp("부서마다 사람 몇 명씩", d2, "no entity resolved")?.route === "structured", "그래프의 2위가 정형이면 정형");
  const d3 = decision("structured", { semantic: sem("nl2sql", { nl2sql: 0.7, vector_search: 0.5, knowledge_graph: 0.66 }), typePair: { relation: "USES", from: "client", to: "product" } });
  const a3 = runnerUp("Client-A 제품", d3, "0 rows");
  ok(a3?.route === "graph" && a3.graphPlan?.relTypes.join() === "USES", "그래프로 가면 규칙의 타입쌍 관계로 계획한다");
  const d4 = decision("structured", { gate: { scores: { nl2sql: 2, vector_search: 0, knowledge_graph: 1 }, pick: "nl2sql", margin: 1, confident: false } });
  ok(runnerUp("q", d4, "0 rows")?.route === "graph", "시맨틱이 없으면 규칙 점수의 2위");
  ok(runnerUp("q", decision("structured", { gate: { scores: { nl2sql: 1, vector_search: 0, knowledge_graph: 0 }, pick: "nl2sql", margin: 1, confident: false } }), "0 rows")?.route === "semantic", "동점이면 LANES 순서");
  ok(runnerUp("q", decision("graph", { gate: { scores: { nl2sql: 0, vector_search: 0, knowledge_graph: 3 }, pick: "knowledge_graph", margin: 3, confident: true } }), "x") === undefined, "규칙이 확신했으면 다음 순위가 없다(사업자 24번 서울물산)");
  ok(runnerUp("q", decision("hybrid"), "x") === undefined, "hybrid 는 다음 순위가 없다");
  ok(runnerUp("q", decision("semantic", { docCount: { kind: "회의록" } }), "x") === undefined, "문서 개수 질문은 전용 길이다");
  ok(runnerUp("q", decision("graph", { pair: { a: "A", b: "B" } }), "x") === undefined, "두 개체의 관계 질문은 전용 길이다");
  ok(runnerUp("q", decision("structured", { productState: { word: "단종" } }), "x") === undefined, "제품 상태 질문은 전용 길이다");
}

// ── 다음 순위 결과가 근거인가 ───────────────────────────────────────────
{
  const titles = ["[회의록] Client-X 정기 미팅 (2026-02-20)", "[장애보고] Client-X Product-Z1 서비스 장애 (2025-04-22)", "[기술문서] Product-Z1 설치 가이드"];
  const pool = { query: async () => ({ rows: titles.map((title, i) => ({ title, first: i })) }) } as unknown as Pool;
  const hit = (title: string) => ({ id: 1, title: `${title} — 기본 정보`, body: "b", score: 0.8 });
  const vec = (hits: ReturnType<typeof hit>[]) => result({ route: "semantic", vector: { ok: true, hits, embedder: "t" } });
  ok(await runnerUpUsable(pool, "올해 2월 20일 Client-X 미팅에서 예산 얼마 썼대?", vec([hit(titles[0])])), "날짜로 문서 하나를 가리키고 검색이 그 문서를 찾았다");
  ok(!(await runnerUpUsable(pool, "올해 2월 20일 Client-X 미팅에서 예산 얼마 썼대?", vec([hit(titles[1])]))), "검색이 그 문서를 찾지 못했으면 근거가 아니다");
  ok(!(await runnerUpUsable(pool, "2019년에 입사한 직원 목록", vec([hit(titles[0])]))), "문서를 가리키지 않은 질문의 상위 조각은 근거가 아니다");
  ok(!(await runnerUpUsable(pool, "Client-X 관련 내용", vec([hit(titles[0])]))), "식별자 집합만으로 고른 문서는 근거로 보지 않는다");
  const broken = { query: async () => { throw new Error("down"); } } as unknown as Pool;
  ok(!(await runnerUpUsable(broken, "올해 2월 20일 Client-X 미팅", vec([hit(titles[0])]))), "제목을 못 읽으면 근거가 아니다");
  ok(await runnerUpUsable(pool, "q", result({ route: "structured", sql: { text: "SELECT 1 FROM t", result: rows(3) } })), "정형은 값이 있는 행");
  ok(!(await runnerUpUsable(pool, "q", result({ route: "structured", sql: { text: "SELECT 1 FROM t", result: rows(0) } }))), "0건은 근거가 아니다");
  ok(await runnerUpUsable(pool, "q", result({ route: "graph", graph: { strategy: "seeded", seeds: [], edgeCount: 2, items: [] } })), "그래프는 엣지");
  ok(!(await runnerUpUsable(pool, "q", result({ route: "graph", graph: { strategy: "unresolved", seeds: [], edgeCount: 0, items: [] } }))), "못 찾은 그래프는 근거가 아니다");
}

// ── 묶음: 첫 레인, 다음 레인, 감사 ─────────────────────────────────────
{
  const d = decision("structured", { semantic: sem("nl2sql", { nl2sql: 0.7, vector_search: 0.66, knowledge_graph: 0.6 }) });
  const empty = result({ route: "structured", sql: { text: "SELECT 1 FROM t", result: rows(0) } });
  const good = result({ route: "semantic", vector: { ok: true, hits: [{ id: 1, title: "t", body: "b", score: 1 }], embedder: "t" } });
  const runs: string[] = [];
  const run = async (x: RouteDecision) => {
    runs.push(x.route);
    return x.route === "structured" ? empty : good;
  };
  const used = await withRunnerUp("q", d, run, async () => true);
  ok(runs.join() === "structured,semantic" && used.route === "semantic", "빈손이면 다음 순위를 돌려 그 결과로 답한다");
  ok(JSON.stringify(used.audit.route_fallback) === JSON.stringify({ from: "structured", to: "semantic", reason: "0 rows", used: true }), `감사에 남는다 (got ${JSON.stringify(used.audit.route_fallback)})`);
  runs.length = 0;
  const kept = await withRunnerUp("q", d, run, async () => false);
  ok(runs.join() === "structured,semantic" && kept.route === "structured" && kept.audit.route_fallback?.used === false, "다음 순위도 근거가 없으면 처음 결과로 답하고 시도했다고 남긴다");
  runs.length = 0;
  const confident = decision("structured", { gate: { scores: { nl2sql: 3, vector_search: 0, knowledge_graph: 0 }, pick: "nl2sql", margin: 3, confident: true } });
  const once = await withRunnerUp("q", confident, run, async () => true);
  ok(runs.join() === "structured" && once.audit.route_fallback === undefined, "규칙이 확신했으면 한 번만 돈다");
  runs.length = 0;
  const full = result({ route: "structured", sql: { text: "SELECT 1 FROM t", result: rows(2) } });
  const plain = await withRunnerUp("q", d, async (x) => (runs.push(x.route), full), async () => true);
  ok(runs.join() === "structured" && plain === full, "빈손이 아니면 그대로");
}

console.log(`\nfallback.test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
