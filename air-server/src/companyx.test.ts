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

// CompanyX increment tests: the third router lane, seed tokenization, directional
// expansion, relation-level scan, and the unresolved-entity gate.
//
// The graph/DB half needs the sponsor dataset loaded (npm run companyx:load) and
// skips cleanly when it is absent, exactly like the other live-PG suites.
// Run after build: node dist/companyx.test.js
import { route, LANE_LABEL, ONTOLOGY_TOOL, GRAPH_TOOL, VECTOR_TOOL, SQL_TOOL } from "./router.js";
import { seedTerms, ontologySearch, graphExpand, relationScan, edgeCandidates, GRAPH_LIMITS } from "./graph.js";
import { chunkMarkdown, nodePk, NODE_TABLE } from "./companyx.js";
import { graphLane, ask } from "./pipeline.js";
import { getPool, closePool } from "./db.js";
import { getEmbedder } from "./embedder.js";

let pass = 0,
  fail = 0;
function ok(cond: boolean, msg: string) {
  if (cond) pass++;
  else {
    fail++;
    console.error("  FAIL:", msg);
  }
}
function eq<T>(a: T, b: T, msg: string) {
  ok(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)})`);
}

// ---------- router: the graph lane ----------
{
  // A traversal verb outranks every other signal: only edges hold "who uses what".
  const d = route("Client-A가 사용 중인 제품 목록은?");
  eq(d.route, "graph", "relation verb -> graph lane");
  eq(d.tools, [ONTOLOGY_TOOL, GRAPH_TOOL], "graph lane fans out to the KG tools");
  eq(d.graphPlan?.relTypes, ["USES"], "plan carries the relation type");
  eq(LANE_LABEL[d.route], "knowledge_graph", "lane maps to the sponsor tool name");

  // A document artifact outranks a bare relation NOUN (회의록 prose, not an edge).
  eq(route("고객사 미팅에서 논의된 일정 지연 이슈는?").route, "semantic", "doc signal beats relation noun");
  // ...but the same noun with an entity IS a traversal.
  eq(route("Product-S1 관련 고객 이슈 현황은?").route, "graph", "relation noun + entity -> graph");

  // Superlatives over a relation are counted by the DB, not guessed by the model.
  const agg = route("가장 많은 고객을 담당하는 직원은?");
  eq(agg.route, "graph", "superlative over a relation -> graph");
  eq(agg.graphPlan?.aggregate, "source", "MANAGES_ACCOUNT aggregates by source (the employee)");
  const agg2 = route("기술 지원 이슈가 가장 많은 제품은?");
  eq(agg2.graphPlan?.aggregate, "target", "REPORTED_ISSUE aggregates by target (the product)");

  // Status vocabulary becomes a node-property filter.
  eq(route("진행 중인 프로젝트를 이끄는 직원 목록").graphPlan?.filter, {
    side: "target",
    key: "status",
    value: "in_progress",
  }, "진행 중 -> status=in_progress filter");

  // Column vocabulary still goes to SQL even when a team name is present.
  const sqlish = route("기술지원팀 직원 목록과 연봉을 알려줘");
  eq(sqlish.route, "structured", "salary column -> nl2sql lane");
  eq(sqlish.tools, [SQL_TOOL], "structured -> sql only");
  eq(route("Product-C1 설치 방법이 궁금해").tools, [VECTOR_TOOL], "install guide -> vector only");

  // Determinism of the extended router.
  const q = "Product-D1 제품과 관련된 프로젝트는?";
  const first = JSON.stringify(route(q));
  let stable = true;
  for (let i = 0; i < 20; i++) if (JSON.stringify(route(q)) !== first) stable = false;
  ok(stable, "extended router: 20 runs identical");
}

// ---------- seed tokenization ----------
{
  ok(seedTerms("Product-C1을 사용하는 고객사는 어디야?").includes("Product-C1"), "hyphenated sponsor id survives tokenization");
  ok(!seedTerms("Product-C1을 사용하는 고객사는 어디야?").includes("고객사"), "type nouns are not entity seeds");
  ok(seedTerms("클라우드사업부 소속 직원들은 누구야?").includes("클라우드사업부"), "org unit is a seed");
}

// ---------- dataset helpers ----------
{
  eq(nodePk("client_17"), 17, "node id -> relational pk");
  eq(NODE_TABLE["client"], "clients", "node type -> table");
  const chunks = chunkMarkdown("# 장애 보고서\n본문\n\n## 원인 분석\n디스크\n\n## 조치 사항\n1. 확장");
  eq(chunks.length, 3, "markdown splits at section boundaries");
  ok(chunks[1].content.startsWith("## 원인 분석"), "each chunk keeps its heading (structure-preserving)");
  ok(chunks.every((c) => c.content.trim().length > 0), "no empty chunks");
}

// ---------- live KG (skips without the loaded dataset) ----------
async function live() {
  const pool = getPool();
  const schema = "companyx";
  const probe = await ontologySearch(pool, "Client-A", 3, schema);
  if (!probe.ok || probe.hits.length === 0) {
    console.log("companyx.test: LIVE PART SKIPPED (run `npm run companyx:load` first)");
    await closePool();
    return;
  }

  // Ranked seeds: naming Product-C1 seeds THAT product, not 5 arbitrary products.
  const seeds = await ontologySearch(pool, "Product-C1을 사용하는 고객사는 어디야?", 5, schema);
  eq(seeds.hits[0]?.canonicalName, "Product-C1", "exact match ranks first");
  eq(seeds.hits[0]?.score, 4, "exact canonical match scores 4 (outranks an exact ALIAS at 3)");

  // Reverse traversal: client -[USES]-> product read backwards.
  const pid = seeds.hits[0]!.entityId;
  const inbound = await graphExpand(pool, pid, 1, ["USES"], schema, "in");
  ok(inbound.ok && inbound.edges.length > 0, `incoming USES edges exist (got ${inbound.edges.length})`);
  ok(inbound.edges.every((e) => e.dstId === pid), "incoming edges point at the seed");
  const outbound = await graphExpand(pool, pid, 1, ["USES"], schema, "out");
  eq(outbound.edges.length, 0, "a product has no outgoing USES edge (direction matters)");

  // Relation-level scan + degree ranking, deterministic across runs.
  const scan1 = await relationScan(pool, { relTypes: ["MANAGES_ACCOUNT"], aggregate: "source" }, schema);
  ok(scan1.ok && scan1.ranking.length > 0, "relation scan ranks employees by account count");
  const scan2 = await relationScan(pool, { relTypes: ["MANAGES_ACCOUNT"], aggregate: "source" }, schema);
  eq(scan1.ranking, scan2.ranking, "relation ranking is deterministic");
  ok(scan1.ranking[0].count >= scan1.ranking[scan1.ranking.length - 1].count, "ranking is sorted by degree desc");

  // Property filter: only in_progress projects.
  const scanF = await relationScan(
    pool,
    { relTypes: ["LEADS"], filter: { side: "target", key: "status", value: "in_progress" } },
    schema,
  );
  ok(scanF.ok && scanF.edges.length > 0, "status-filtered scan returns edges");
  const scanAll = await relationScan(pool, { relTypes: ["LEADS"], limit: 200 }, schema);
  ok(scanAll.edges.length > scanF.edges.length, "filter actually removes edges");

  // 상태 조건은 시드 확장에도 걸린다(랜덤 테스트 2차 R4). Client-AC 의 프로젝트 넷 중 보류(성능 최적화)가 빠진다.
  const inProgress = { side: "target" as const, key: "status", value: "in_progress" };
  const acId = (await ontologySearch(pool, "Client-AC", 1, schema)).hits[0].entityId;
  const acAll = await graphExpand(pool, acId, 1, ["HAS_PROJECT"], schema, "both");
  const acNow = await graphExpand(pool, acId, 1, ["HAS_PROJECT"], schema, "both", GRAPH_LIMITS, inProgress);
  eq([acAll.edges.length, acNow.edges.length], [4, 3], "seed expansion keeps only in_progress projects");
  ok(!acNow.edges.some((e) => e.dstName.includes("성능 최적화")), "the on_hold project is not offered as in progress");
  const acLane = await graphLane(pool, "Client-AC에서 진행 중인 프로젝트는 뭐야?", 5, 2, schema, { relTypes: ["HAS_PROJECT"], filter: inProgress });
  const acLines = new Set(acLane.items.filter((i) => i.text.startsWith("[그래프] Client-AC의")).map((i) => i.text));
  ok(acLines.size === 3 && ![...acLines].some((t) => t.includes("성능 최적화")), `graph lane offers Client-AC's three in_progress projects only (got ${[...acLines]})`);
  // 시드 자신은 거르지 않는다: 보류 프로젝트를 시드로 펼쳐도 그 프로젝트의 엣지는 남는다.
  const held = (await ontologySearch(pool, "Client-AC 성능 최적화", 1, schema)).hits[0].entityId;
  ok((await graphExpand(pool, held, 1, ["LEADS"], schema, "both", GRAPH_LIMITS, inProgress)).edges.length === 1, "the seed's own edges are not filtered");


  // A department name is also a property alias on every one of its employees.
  // Canonical-exact must outrank alias-exact or the department is evicted from the
  // seed set and its HEAD_IS edge never reaches the context.
  const dept = await ontologySearch(pool, "경영지원팀 팀장은 누구야?", 5, schema);
  eq(dept.hits[0]?.type, "department", "department outranks its own members");
  eq(dept.hits[0]?.score, 4, "canonical exact = 4");
  ok(dept.hits.slice(1).some((h) => h.type === "employee" && h.score === 3), "employee alias hits score 3");

  // Edge candidates are keyed by the endpoint that ANSWERS, not always the dst:
  // 8 inbound edges must stay 8 distinct candidates through RRF's per-list dedupe.
  const s1 = await ontologySearch(pool, "Product-S1", 1, schema);
  const inEdges = await graphExpand(pool, s1.hits[0].entityId, 1, ["REPORTED_ISSUE"], schema, "in");
  const cands = edgeCandidates(inEdges.edges, s1.hits[0].entityId);
  eq(new Set(cands.map((c) => c.canonicalKey)).size, inEdges.edges.length,
    "inbound edges keep distinct canonical keys (client side, not the seed)");
  ok(cands.every((c) => c.canonicalKey.startsWith("entity:client#")), "keyed by the answering client");

  // A named relation means one hop; extra hops are noise the model reads asnoise.
  const laneRel = await graphLane(pool, "Product-S1 관련 고객 이슈 현황은?", 5, 2, schema);
  eq(laneRel.edgeCount, 8, "relation-specified query expands exactly one hop");
  const laneOpen = await graphLane(pool, "Product-D1 제품과 관련된 프로젝트는?", 5, 2, schema);
  ok(laneOpen.edgeCount > 8, "unspecified relation keeps the requested depth");

  // Ties are a property of the data and must survive into the context.
  const tie = await graphLane(pool, "가장 많은 고객을 담당하는 직원은?", 5, 2, schema);
  const tied = tie.items.filter((i) => i.text.includes("공동 1위"));
  ok(tied.length >= 2, `tied top rank is rendered as 공동 (got ${tied.length})`);

  // Unresolved-entity gate: no fabricated context for an entity absent from the data.
  const missing = await graphLane(pool, "서울물산 담당 엔지니어는 누구야?", 5, 2, schema);
  eq(missing.strategy, "unresolved", "absent entity -> unresolved gate");
  eq(missing.edgeCount, 0, "absent entity contributes zero edges");
  eq(missing.items.length, 1, "gate emits exactly one explicit not-found item");
  ok(missing.items[0].text.includes("찾지 못했습니다"), "not-found item says so in the context");
  eq(missing.not_found?.reason, "not_in_database", "서울물산: nothing similar in the lexicon -> not_in_database");
  eq(missing.not_found?.query_entity, "서울물산", "not_found names the missing entity");

  // A near-miss name is reported with its candidate but never expanded.
  const near = await graphLane(pool, "클라우드사업팀 소속 직원들은 누구야?", 5, 2, schema);
  eq(near.strategy, "unresolved", "similar name does not resolve");
  eq(near.edgeCount, 0, "similar name contributes zero edges");
  eq(near.not_found?.reason, "similar_name_mismatch", "near-miss -> similar_name_mismatch");
  eq(near.not_found?.candidates[0]?.name, "클라우드사업부", "candidate is the similarly named department");

  // 섞인 질문(G17 ①): 있는 개체는 펼치고 없는 개체는 사유로 남긴다. 없는 개체가 든 마디의 관계(담당)는
  // 찾은 개체에서 펼치지 않는다 — 펼치면 Client-A 의 담당자가 서울물산의 담당자로 읽혔다.
  const mixed = await graphLane(pool, "서울물산 담당 엔지니어와 Client-A가 사용 중인 제품을 알려줘", 5, 2, schema);
  eq(mixed.missing?.[0]?.query_entity, "서울물산", "mixed question reports the missing entity");
  eq(mixed.answer_query, "Client-A가 사용 중인 제품을 알려줘", "answer step gets the question without the missing clause");
  ok(
    mixed.items[0]?.text.includes("서울물산") && !mixed.items.some((i) => i.text.includes("담당 고객사")) &&
      mixed.items.some((i) => i.text.includes("Product-C3")),
    "mixed question: not-found line first, Client-A products kept, no MANAGES_ACCOUNT edge offered",
  );

  // A real entity still traverses.
  const found = await graphLane(pool, "Client-A가 사용 중인 제품 목록은?", 5, 2, schema);
  ok(found.strategy.startsWith("seeded"), `real entity -> seeded traversal (got ${found.strategy})`);
  ok(found.edgeCount > 0, "real entity yields edges");
  eq(found.not_found, undefined, "found entity carries no not_found");

  // ask answers the gate from not_found without calling the model.
  let llmCalled = false;
  const answered = await ask("서울물산 담당 엔지니어는 누구야?", {
    pool,
    embedder: getEmbedder(),
    llm: async () => {
      llmCalled = true;
      return "";
    },
  });
  ok(!llmCalled && answered.answer.includes("서울물산") && answered.answer.includes("비슷한 개체도 없습니다"),
    `ask states the reason without the LLM (got ${answered.answer})`);

  // Traversal caps never bind on the sponsor graph: from EVERY entity at the maximum
  // depth, the capped BFS equals an uncapped one edge for edge.
  const ids = (await pool.query(`SELECT id FROM ${schema}.entities ORDER BY id`)).rows.map((r) => Number(r.id));
  const open = { maxHops: GRAPH_LIMITS.maxHops, maxNodes: Number.MAX_SAFE_INTEGER, maxEdges: 1_000_000 };
  let capped = 0,
    differ = 0,
    widest = 0;
  for (const id of ids) {
    const g = await graphExpand(pool, id, GRAPH_LIMITS.maxHops, undefined, schema);
    const u = await graphExpand(pool, id, GRAPH_LIMITS.maxHops, undefined, schema, "both", open);
    if (g.truncated) capped++;
    if (JSON.stringify(g.edges) !== JSON.stringify(u.edges)) differ++;
    widest = Math.max(widest, g.edges.length);
  }
  eq(capped, 0, `default caps never truncate on the sponsor graph (${ids.length} seeds, widest ${widest} edges)`);
  eq(differ, 0, "capped BFS == uncapped BFS on every seed");

  await closePool();
}

live()
  .then(() => {
    console.log(`\ncompanyx.test: ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
