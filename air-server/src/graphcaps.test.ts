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

// 그래프 탐색 상한 — 합성 그래프로 DB 없이 검증한다.
//
// 양방향 BFS 는 허브 하나, 긴 사슬 하나로 비용이 폭증한다. 상한(홉·노드·엣지)이
// 실제로 걸리는지, 걸리면 예외가 아니라 결과의 truncated 로 보고되는지, 그리고
// 상한 안쪽의 그래프는 전과 똑같이 끝까지 도는지를 본다.
//
// 가짜 pool 은 graphExpand 가 보내는 SQL 의 의미(방향 조건, 관계 필터, 이미 본 id
// 제외, id 순 정렬, LIMIT)를 그대로 흉내 낸다. 실제 SQL 은 companyx.test 가 사업자
// 그래프 위에서 확인한다.
import type { Pool } from "pg";

import {
  GRAPH_LIMITS,
  edgeCandidates,
  graphExpand,
  graphWalk,
  pathCandidates,
  rankingCandidates,
  seedEdgeCandidates,
  type GraphEdge,
  type GraphLimits,
} from "./graph.js";

let passed = 0;
let failed = 0;
function ok(cond: unknown, label: string) {
  if (cond) passed++;
  else {
    failed++;
    console.error(`  FAIL: ${label}`);
  }
}

type Rel = { id: number; src: number; dst: number; rel: string };

function fakePool(rels: Rel[]) {
  const stats = { queries: 0, rowsRead: 0 };
  const pool = {
    query: async (sql: string, params: unknown[]) => {
      stats.queries++;
      const [frontier, relTypes, seenIds, limit] = params as [number[], string[] | null, number[], number];
      const f = new Set(frontier);
      const skip = new Set(seenIds);
      const both = sql.includes("OR r.dst_entity_id = ANY");
      const out = !both && sql.includes("r.src_entity_id = ANY");
      const rows = rels
        .filter((r) => (both ? f.has(r.src) || f.has(r.dst) : out ? f.has(r.src) : f.has(r.dst)))
        .filter((r) => !relTypes || relTypes.includes(r.rel))
        .filter((r) => !skip.has(r.id))
        .sort((a, b) => a.id - b.id)
        .slice(0, limit)
        .map((r) => ({
          id: r.id,
          src_entity_id: r.src,
          src_name: `n${r.src}`,
          src_type: "node",
          rel_type: r.rel,
          dst_entity_id: r.dst,
          dst_name: `n${r.dst}`,
          dst_type: "node",
          confidence: 1,
          provenance: "synthetic",
        }));
      stats.rowsRead += rows.length;
      return { rowCount: rows.length, rows };
    },
  } as unknown as Pool;
  return { pool, stats };
}

/** 허브 1 에서 잎 n 개로 뻗는 별. */
const star = (n: number): Rel[] => Array.from({ length: n }, (_, i) => ({ id: i + 1, src: 1, dst: i + 2, rel: "LINK" }));
/** 노드 11개 사이에 관계 타입만 다른 엣지 n개 — 노드는 적고 엣지만 많은 허브. */
const multi = (n: number): Rel[] =>
  Array.from({ length: n }, (_, i) => ({ id: i + 1, src: 1, dst: 2 + (i % 10), rel: `R${i}` }));
/** 1-2-3-…-n 사슬. */
const chain = (n: number): Rel[] => Array.from({ length: n - 1 }, (_, i) => ({ id: i + 1, src: i + 1, dst: i + 2, rel: "LINK" }));

const expand = (rels: Rel[], depth: number, limits?: GraphLimits) => {
  const { pool, stats } = fakePool(rels);
  return graphExpand(pool, 1, depth, undefined, "synthetic", "both", limits).then((r) => ({ r, stats }));
};

// ── 0) 상한은 이름 붙은 상수 한 곳에 있다 ────────────────────────────────
ok(Object.isFrozen(GRAPH_LIMITS), "GRAPH_LIMITS 는 고정된 상수다");
ok(
  GRAPH_LIMITS.maxHops >= 1 && GRAPH_LIMITS.maxNodes >= 1 && GRAPH_LIMITS.maxEdges >= 1,
  `상한 셋이 모두 양수 (got ${JSON.stringify(GRAPH_LIMITS)})`,
);

// ── 1) 엣지 상한: 노드 11개 사이 엣지 5,000개 ─────────────────────────────
{
  const { r, stats } = await expand(multi(5000), 1);
  ok(r.ok, "허브 확장은 예외 없이 끝난다");
  ok(r.truncated?.by === "edges" && r.truncated.limit === GRAPH_LIMITS.maxEdges, `엣지 상한으로 잘렸다고 보고 (got ${JSON.stringify(r.truncated)})`);
  ok(r.edges.length === GRAPH_LIMITS.maxEdges, `담은 엣지는 상한과 같다 (got ${r.edges.length})`);
  ok(stats.rowsRead <= GRAPH_LIMITS.maxEdges + 1, `DB 에서 읽은 행도 상한+1 이하 (got ${stats.rowsRead})`);
}

// ── 2) 노드 상한: 잎 5,000개짜리 별 ──────────────────────────────────────
{
  const { r, stats } = await expand(star(5000), 1);
  ok(r.truncated?.by === "nodes" && r.truncated.limit === GRAPH_LIMITS.maxNodes, `노드 상한으로 잘렸다고 보고 (got ${JSON.stringify(r.truncated)})`);
  const nodes = new Set(r.edges.flatMap((e) => [e.srcId, e.dstId]));
  ok(nodes.size === GRAPH_LIMITS.maxNodes, `결과의 노드 수가 상한과 같다 (got ${nodes.size})`);
  ok(stats.rowsRead <= GRAPH_LIMITS.maxEdges + 1, `잎이 5,000개여도 읽은 행은 엣지 상한+1 이하 (got ${stats.rowsRead})`);

  const tight = { maxHops: 3, maxNodes: 10, maxEdges: 1000 };
  const small = await expand(star(50), 1, tight);
  ok(small.r.truncated?.by === "nodes" && small.r.truncated.limit === 10, `상한을 낮추면 그 값에서 잘린다 (got ${JSON.stringify(small.r.truncated)})`);
}

// ── 3) 홉 상한: 요청이 상한을 넘을 때만 잘림이다 ─────────────────────────
{
  const over = await expand(chain(10), GRAPH_LIMITS.maxHops + 2);
  ok(over.r.truncated?.by === "hops" && over.r.truncated.limit === GRAPH_LIMITS.maxHops, `홉 상한으로 잘렸다고 보고 (got ${JSON.stringify(over.r.truncated)})`);
  ok(over.r.edges.length === GRAPH_LIMITS.maxHops, `상한 깊이까지만 갔다 (got ${over.r.edges.length})`);
  ok(over.stats.queries === GRAPH_LIMITS.maxHops, `질의 수도 홉 상한 이하 (got ${over.stats.queries})`);

  const exact = await expand(chain(10), GRAPH_LIMITS.maxHops);
  ok(exact.r.truncated === undefined, "요청한 깊이에서 멈춘 것은 잘림이 아니다");

  const short = await expand(chain(3), GRAPH_LIMITS.maxHops + 2);
  ok(short.r.truncated === undefined && short.r.edges.length === 2, "상한 전에 그래프가 끝나면 잘림이 아니다");
}

// ── 4) 상한 안쪽은 전과 같다 ────────────────────────────────────────────
{
  const { r } = await expand(star(50), 1);
  ok(r.truncated === undefined && r.edges.length === 50, `기본 상한에서 잎 50개 허브는 전부 나온다 (got ${r.edges.length})`);

  // 삼각형: 2단계에서 1단계 엣지가 다시 걸리지만 이미 본 id 로 빠진다.
  // 이게 안 빠지면 엣지 상한 3 에서 새 엣지 1개를 두고 잘렸다고 거짓 보고한다.
  const tri: Rel[] = [
    { id: 1, src: 1, dst: 2, rel: "LINK" },
    { id: 2, src: 2, dst: 3, rel: "LINK" },
    { id: 3, src: 3, dst: 1, rel: "LINK" },
  ];
  const t = await expand(tri, 2, { maxHops: 3, maxNodes: 10, maxEdges: 3 });
  ok(t.r.truncated === undefined && t.r.edges.length === 3, `다시 걸린 엣지가 상한을 먹지 않는다 (got ${t.r.edges.length}, ${JSON.stringify(t.r.truncated)})`);
}

// ── 4b) 홉마다 엣지 타입이 정해진 경로(graphWalk) ────────────────────────
// 제품(1) ←[USES]- 고객사(2) -[HAS_PROJECT]→ 프로젝트(3). 고객사는 다른 제품(4)도 쓰고, 제품 1 에
// 이슈도 올렸다. 두 홉 모두 두 엣지를 허용하는 확장은 제품 4 를 끌어오지만, 경로는 프로젝트만 낸다.
{
  const g: Rel[] = [
    { id: 1, src: 2, dst: 1, rel: "USES" },
    { id: 2, src: 2, dst: 4, rel: "USES" },
    { id: 3, src: 2, dst: 3, rel: "HAS_PROJECT" },
    { id: 4, src: 2, dst: 1, rel: "REPORTED_ISSUE" },
    { id: 5, src: 5, dst: 3, rel: "LEADS" },
  ];
  const { pool } = fakePool(g);
  const w = await graphWalk(pool, 1, [["USES"], ["HAS_PROJECT"]], "synthetic");
  ok(w.ok && w.edges.map((e) => `${e.depth}:${e.srcId}-${e.relType}-${e.dstId}`).join(",") === "1:2-USES-1,2:2-HAS_PROJECT-3", `홉마다 그 엣지만 탄다 (got ${w.edges.map((e) => `${e.depth}:${e.srcId}-${e.relType}-${e.dstId}`).join(",")})`);
  const loose = await graphExpand(fakePool(g).pool, 1, 2, ["USES", "HAS_PROJECT"], "synthetic", "both");
  ok(loose.edges.some((e) => e.dstId === 4), "대조: 두 엣지를 두 홉 모두 허용하면 다른 제품이 섞인다");
  const lines = pathCandidates(w.edges, 1);
  ok(lines.length === 1 && lines[0].canonicalKey.endsWith("3"), `경로 한 줄, 답은 경로 끝 개체 (got ${JSON.stringify(lines.map((l) => l.canonicalKey))})`);
  ok(/n2의 .*: n1 → n2의 .*: n3/.test(lines[0].text), `경로 전체가 한 줄에 있다 (got ${lines[0].text})`);
  const dead = await graphWalk(fakePool(g).pool, 1, [["USES"], ["LEADS"]], "synthetic");
  ok(pathCandidates(dead.edges, 1).length === 0, "다음 홉이 없는 중간 개체는 답이 아니다");
  // 답이 둘째 엣지의 도착점이면 종전 글 그대로(TC-129), 출발점이면(제품 ← 고객사 ← 담당 직원) 답부터 적는다(랜덤 테스트 2차 R2).
  ok(lines[0].text === "[그래프 경로] n2의 사용 중인 제품: n1 → n2의 진행 프로젝트: n3 (USES→HAS_PROJECT)", `정방향 경로 줄은 그대로 (got ${lines[0].text})`);
  const back = await graphWalk(fakePool([...g, { id: 6, src: 6, dst: 2, rel: "MANAGES_ACCOUNT" }]).pool, 1, [["USES"], ["MANAGES_ACCOUNT"]], "synthetic");
  const answerFirst = pathCandidates(back.edges, 1);
  ok(
    answerFirst.length === 1 && answerFirst[0].canonicalKey.endsWith("6") &&
      answerFirst[0].text === "[그래프 경로] n6의 담당 고객사: n2 → n2의 사용 중인 제품: n1 (MANAGES_ACCOUNT→USES)",
    `둘째 엣지를 거꾸로 탄 경로는 답(n6)부터 (got ${JSON.stringify(answerFirst.map((c) => c.text))})`,
  );
}

// ── 4c) 세 홉 경로: 고객사(2) -HAS_PROJECT→ 프로젝트(3, 9) ←LEADS- 직원(5, 8) -BELONGS_TO→ 부서(7) ──────
// 랜덤 테스트 사전 점검 2차 R5 「Client-J 프로젝트를 이끄는 직원들은 어느 부서 소속이야?」. 답은 셋째 홉의 끝(부서)이고,
// 두 직원이 같은 부서에 닿아도 줄 둘이 다 남는다(줄의 정체는 답과 그 앞 직원의 쌍).
{
  const g: Rel[] = [
    { id: 1, src: 2, dst: 3, rel: "HAS_PROJECT" },
    { id: 2, src: 2, dst: 9, rel: "HAS_PROJECT" },
    { id: 3, src: 5, dst: 3, rel: "LEADS" },
    { id: 4, src: 8, dst: 9, rel: "LEADS" },
    { id: 5, src: 5, dst: 7, rel: "BELONGS_TO" },
    { id: 6, src: 8, dst: 7, rel: "BELONGS_TO" },
    { id: 7, src: 10, dst: 2, rel: "MANAGES_ACCOUNT" },
  ];
  const w = await graphWalk(fakePool(g).pool, 2, [["HAS_PROJECT"], ["LEADS"], ["BELONGS_TO"]], "synthetic");
  const three = pathCandidates(w.edges, 2, 3);
  ok(
    three.map((c) => c.text).join("\n") ===
      "[그래프 경로] n2의 진행 프로젝트: n3 → n5의 이끄는 프로젝트: n3 → n5의 소속 부서: n7 (HAS_PROJECT→LEADS→BELONGS_TO)\n" +
        "[그래프 경로] n2의 진행 프로젝트: n9 → n8의 이끄는 프로젝트: n9 → n8의 소속 부서: n7 (HAS_PROJECT→LEADS→BELONGS_TO)",
    `세 홉 경로는 시드부터 차례로 한 줄 (got ${JSON.stringify(three.map((c) => c.text))})`,
  );
  ok(new Set(three.map((c) => c.canonicalKey)).size === 2, `같은 부서에 닿은 두 직원의 줄이 모두 남는다 (got ${JSON.stringify(three.map((c) => c.canonicalKey))})`);
  ok(pathCandidates(w.edges, 2).every((c) => !c.text.includes("소속 부서")), "홉 수를 주지 않으면 종전 두 홉 줄(셋째 홉은 읽지 않는다)");
  const short = await graphWalk(fakePool(g.filter((r) => r.rel !== "BELONGS_TO")).pool, 2, [["HAS_PROJECT"], ["LEADS"], ["BELONGS_TO"]], "synthetic");
  ok(pathCandidates(short.edges, 2, 3).length === 0, "셋째 홉이 없는 직원은 답이 아니다");
}

// ── 4a) 집계 순위 줄: 많은 쪽은 종전 글 그대로(TC-132, TC-133), 적은 쪽은 「적은 순」과 공동 1위 전부 ───
// 랜덤 테스트 사전 점검 2차 R6: 「담당하는 고객사가 가장 적은 직원」에 많은 쪽 상위를 답했다.
{
  const rk = (counts: number[]) => counts.map((count, i) => ({ entityId: i + 1, name: `e${i + 1}`, type: "employee", count }));
  const desc = rankingCandidates(rk([4, 4, 4, 3, 3, 2]), "MANAGES_ACCOUNT");
  ok(desc.length === 5 && desc[0].text === "[그래프 집계] e1 (employee) — 담당 고객사 4건, 공동 1위" && desc[3].text === "[그래프 집계] e4 (employee) — 담당 고객사 3건, 공동 4위", `많은 쪽 순위 줄은 종전 그대로 (got ${desc.map((c) => c.text)})`);
  const asc = rankingCandidates(rk([0, 0, 0, 0, 0, 0, 0, 1, 2]), "MANAGES_ACCOUNT", 5, "asc");
  ok(asc.length === 7 && asc[6].text === "[그래프 집계] e7 (employee) — 담당 고객사 0건, 적은 순 공동 1위", `적은 쪽은 공동 1위 일곱을 다 싣는다 (got ${asc.length}: ${asc[6]?.text})`);
  const ascFew = rankingCandidates(rk([0, 1, 1, 2, 3, 3, 4]), "MANAGES_ACCOUNT", 5, "asc");
  ok(ascFew.length === 5 && ascFew[0].text.endsWith("0건, 적은 순 1위") && ascFew[1].text.endsWith("1건, 적은 순 공동 2위"), `공동 1위가 다섯보다 적으면 다섯 줄 (got ${ascFew.map((c) => c.text)})`);
}

// ── 4b) 여러 시드가 같은 답 개체에 닿으면 사실을 버리지 않고 한 줄로 모은다 ───
// 홀드아웃3 #43: Client-N 은 Product-S1 과 Product-C4 를 다 쓰는데, 답 개체가 같아 RRF 가 둘째 엣지를 버렸다.
{
  const e = (src: [number, string, string], rel: string, dst: [number, string, string], prov = "p"): GraphEdge => ({
    srcId: src[0], srcName: src[1], srcType: src[2], relType: rel, dstId: dst[0], dstName: dst[1], dstType: dst[2],
    confidence: 1, provenance: prov, depth: 1,
  });
  const n: [number, string, string] = [14, "Client-N", "client"];
  const e1: [number, string, string] = [5, "Client-E", "client"];
  const s1: [number, string, string] = [33, "Product-S1", "product"];
  const c4: [number, string, string] = [38, "Product-C4", "product"];
  const out = seedEdgeCandidates([
    { seedId: 33, edges: [e(e1, "USES", s1), e(n, "USES", s1)] },
    { seedId: 38, edges: [e(n, "USES", c4)] },
  ]);
  ok(out.length === 2, `답 개체마다 한 후보 (got ${out.length})`);
  ok(out[1].text === "[그래프] Client-N의 사용 중인 제품: Product-S1, Product-C4 (client→product, USES)", `두 시드를 한 줄에 (got ${out[1].text})`);
  ok(out[0].text === edgeCandidates([e(e1, "USES", s1)], 33)[0].text, "엣지가 하나면 종전 글과 같다");
  ok(new Set(out.map((c) => c.canonicalKey)).size === out.length, "정체는 답 개체 그대로(겹치지 않는다)");
  const mixed = seedEdgeCandidates([{ seedId: 14, edges: [e(n, "USES", s1), e(n, "REPORTED_ISSUE", s1)] }]);
  ok(mixed.length === 1 && mixed[0].text.split("\n").length === 2, `관계가 다르면 한 후보에 줄을 나눠 싣는다 (got ${JSON.stringify(mixed.map((c) => c.text))})`);
}

// ── 4b) 「가장 적은」의 공동 1위는 관계 스캔 상한에서 자르지 않는다 ─────────
// 엣지가 없는 개체 61개가 공동 1위면 상한 60 에서 자른 순위로는 답 문장이 「공동 1위가 60건」이라고 말한다(PR #257 Codex P2).
{
  const { relationScan } = await import("./graph.js");
  const owners = 64; // 1~3 은 엣지가 하나씩, 4~64 의 61개는 없다
  const scanPool = {
    query: async (sql: string) => {
      if (sql.includes("information_schema.columns")) return { rowCount: 0, rows: [] };
      if (sql.trimStart().startsWith("SELECT r.src_entity_id"))
        return {
          rowCount: 3,
          rows: [1, 2, 3].map((i) => ({
            src_entity_id: i, src_name: `n${i}`, src_type: "employee", rel_type: "MANAGES_ACCOUNT",
            dst_entity_id: 100 + i, dst_name: `c${i}`, dst_type: "client", confidence: 1, provenance: "synthetic",
          })),
        };
      return { rowCount: owners, rows: Array.from({ length: owners }, (_, i) => ({ id: i + 1, canonical_name: `n${i + 1}`, type: "employee" })) };
    },
  } as unknown as Pool;
  const few = await relationScan(scanPool, { relTypes: ["MANAGES_ACCOUNT"], aggregate: "source", order: "asc" }, "synthetic");
  ok(few.ok && few.ranking.length === 61 && few.ranking.every((r) => r.count === 0), `공동 1위 61개를 다 남긴다 (got ${few.ranking.length}, ${few.error ?? ""})`);
  const most = await relationScan(scanPool, { relTypes: ["MANAGES_ACCOUNT"], aggregate: "source", order: "asc", limit: 10 }, "synthetic");
  ok(most.ranking.length === 61, `상한을 낮춰도 공동 1위는 다 남긴다 (got ${most.ranking.length})`);
  const desc = await relationScan(scanPool, { relTypes: ["MANAGES_ACCOUNT"], aggregate: "source", limit: 2 }, "synthetic");
  ok(desc.ranking.length === 2, `많은 쪽부터는 종전대로 상한에서 자른다 (got ${desc.ranking.length})`);
}

// ── 5) 환경변수로 바꾸고, 잘못된 값은 기동에서 거절한다 ─────────────────
{
  process.env.GRAPH_MAX_HOPS = "5";
  const mod = await import(new URL("./graph.js?override", import.meta.url).href);
  ok(mod.GRAPH_LIMITS.maxHops === 5, `GRAPH_MAX_HOPS 로 홉 상한을 바꾼다 (got ${mod.GRAPH_LIMITS.maxHops})`);
  delete process.env.GRAPH_MAX_HOPS;

  process.env.GRAPH_MAX_NODES = "0";
  let err = "";
  try {
    await import(new URL("./graph.js?invalid", import.meta.url).href);
  } catch (e) {
    err = String(e);
  }
  ok(err.includes("GRAPH_MAX_NODES"), `잘못된 상한은 조용히 기본값으로 메우지 않는다 (got ${err.slice(0, 80)})`);
  delete process.env.GRAPH_MAX_NODES;
}

console.log(`\ngraphcaps.test: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
