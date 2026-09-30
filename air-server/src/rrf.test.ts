// RRF merge tests: fusion math, agreement bonus, and determinism.
import { rrfMerge, rrfMergeNamed, type Ranked } from "./rrf.js";
import type { Candidate, CandidateSource } from "./candidate.js";

let pass = 0, fail = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { pass++; } else { fail++; console.error("  FAIL:", msg); }
}

const r = (key: string): Ranked<string> => ({ key, value: key });

// list A: a,b,c | list B: b,d  ->  b appears in both, should float to the top.
const listA = [r("a"), r("b"), r("c")];
const listB = [r("b"), r("d")];
const fused = rrfMerge([listA, listB]);

ok(fused[0].key === "b", `agreement (b) ranks first (got ${fused[0].key})`);
ok(JSON.stringify(fused.find((f) => f.key === "b")!.sources) === "[0,1]", "b credited to both lists");
ok(fused.find((f) => f.key === "a")!.sources.length === 1, "a credited to one list");
ok(fused.length === 4, `all unique keys present (got ${fused.length})`);
ok(fused.every((f, i) => f.rank === i + 1), "ranks are contiguous 1..n");
ok(fused.every((f, i) => i === 0 || fused[i - 1].score >= f.score), "scores monotonically non-increasing");

// determinism: same inputs -> identical fusion, every run
const once = JSON.stringify(rrfMerge([listA, listB]));
let stable = true;
for (let i = 0; i < 20; i++) if (JSON.stringify(rrfMerge([listA, listB])) !== once) stable = false;
ok(stable, "rrfMerge is deterministic over 20 runs");

// tie-break: two disjoint single-item lists, equal score -> key asc
const t = rrfMerge([[r("z")], [r("a")]]);
ok(t[0].key === "a" && t[1].key === "z", "equal scores tie-break by key asc");

// ===== named-source RRF (Gate2 canonical agreement) =====
const cand = (key: string, source: CandidateSource): Candidate => ({
  canonicalKey: key,
  sourceKey: `${source}#0`,
  source,
  text: `${source}:${key}`,
  provenance: `prov:${source}:${key}`,
});
// "entity:product#7" surfaces from sql + vector + graph; "row:orders#1" from sql only.
const sqlList = [cand("entity:product#7", "sql"), cand("row:orders#1", "sql")];
const vecList = [cand("entity:product#7", "vector"), cand("documents#3", "vector")];
const graphList = [cand("entity:product#7", "graph")];
const fusedN = rrfMergeNamed([sqlList, vecList, graphList]);

const top = fusedN[0];
ok(top.canonicalKey === "entity:product#7", `3-way agreement entity ranks first (got ${top.canonicalKey})`);
ok(JSON.stringify(top.sources) === JSON.stringify(["graph", "sql", "vector"]), `accumulates 3 named sources (got ${JSON.stringify(top.sources)})`);
const single = fusedN.find((f) => f.canonicalKey === "row:orders#1")!;
ok(single.sources.length === 1 && top.rank < single.rank, "single-source candidate ranks below the agreement entity");
ok(fusedN.length === 3, `distinct canonical keys fused (got ${fusedN.length})`);

// determinism
const onceN = JSON.stringify(rrfMergeNamed([sqlList, vecList, graphList]));
let stableN = true;
for (let i = 0; i < 20; i++) if (JSON.stringify(rrfMergeNamed([sqlList, vecList, graphList])) !== onceN) stableN = false;
ok(stableN, "rrfMergeNamed deterministic over 20 runs");


// Per-list dedupe: one key contributes once, at its BEST rank. Without this a
// graph expansion that emits 10 edges into the same node would outrank a real
// two-source agreement (degree is a graph fact, not retrieval evidence).
{
  const spammy = [
    [{ key: "hub", value: 1 }, { key: "hub", value: 1 }, { key: "hub", value: 1 }, { key: "hub", value: 1 }],
    [{ key: "agree", value: 2 }],
  ];
  const fusedSpam = rrfMerge([spammy[0], [{ key: "agree", value: 2 }]]);
  const hub = fusedSpam.find((f) => f.key === "hub")!;
  ok(Math.abs(hub.score - 1 / (60 + 1)) < 1e-12, `hub scores once at best rank (got ${hub.score})`);

  const withAgreement = rrfMerge([
    [{ key: "hub", value: 1 }, { key: "agree", value: 2 }],
    [{ key: "agree", value: 2 }],
  ]);
  ok(withAgreement[0].key === "agree", `two-source agreement outranks a single-source rank-1 item (got ${withAgreement[0].key})`);
  ok(withAgreement[0].sources.length === 2, "agreement records both lists");
}

// ===== 중복 키 경계 사례 =====
const near = (a: number, b: number) => Math.abs(a - b) < 1e-12;
const keys = (xs: string[]) => xs.map(r);

// 같은 키가 한 리스트에 여러 번 — 가장 좋은(첫) 순위에서 한 번만 센다.
{
  const f = rrfMerge([keys(["x", "a", "x", "a", "a"])]);
  ok(f.length === 2, `반복 키는 하나로 합쳐진다 (got ${f.length})`);
  ok(near(f.find((e) => e.key === "a")!.score, 1 / 62), "a 는 첫 등장 순위(2)에서 한 번만");
  ok(near(f.find((e) => e.key === "x")!.score, 1 / 61), "x 는 1위에서 한 번만");
}

// 반복이 같은 리스트의 나머지를 밀어내지 않는다. 순위는 서로 다른 키 사이의 순위다.
// hub 가 10번 나온 뒤의 c 는 2위이지 11위가 아니다 — 11위로 세면 허브의 반복이
// 다른 리스트의 3위(e)보다 c 를 아래로 떨어뜨린다.
{
  const f = rrfMerge([keys([...Array(10).fill("hub"), "c"]), keys(["d", "f", "e"])]);
  const c = f.find((x) => x.key === "c")!;
  ok(near(c.score, 1 / 62), `반복 뒤의 키는 서로 다른 키 기준 2위 (got 1/${Math.round(1 / c.score)})`);
  ok(c.rank < f.find((x) => x.key === "e")!.rank, "반복 뒤의 2위가 다른 리스트의 3위보다 위다");
}

// 반복은 교차 소스 합의를 못 이긴다 — 반복 횟수를 50번으로 늘려도.
{
  const f = rrfMerge([keys([...Array(50).fill("hub"), "agree"]), keys(["agree"])]);
  ok(f[0].key === "agree" && f[0].sources.length === 2, `50번 반복한 허브도 두 소스 합의를 못 이긴다 (got ${f[0].key})`);
}

// 빈 입력.
{
  ok(rrfMerge([]).length === 0, "리스트가 없으면 결과도 없다");
  ok(rrfMerge([[], []]).length === 0, "빈 리스트만 있으면 결과도 없다");
  const f = rrfMerge([[], keys(["a"])]);
  ok(f.length === 1 && JSON.stringify(f[0].sources) === "[1]", "빈 리스트가 있어도 리스트 번호는 그대로다");
  ok(rrfMergeNamed([]).length === 0 && rrfMergeNamed([[], []]).length === 0, "named: 빈 입력은 빈 결과");
}

// 리스트 하나 — 원래 순서, 1/(k+순위).
{
  const f = rrfMerge([keys(["a", "b", "c"])]);
  ok(f.map((x) => x.key).join() === "a,b,c", "리스트 하나면 순서를 그대로 둔다");
  ok(near(f[0].score, 1 / 61) && near(f[2].score, 1 / 63), "리스트 하나의 점수는 1/(k+순위)");
}

// 전부 같은 키.
{
  const f = rrfMerge([keys(["a", "a", "a", "a"])]);
  ok(f.length === 1 && f[0].rank === 1 && near(f[0].score, 1 / 61), "전부 같은 키면 1위 하나, 1/61");
}

// 동점 — 합이 같으면 키 오름차순.
{
  const f = rrfMerge([keys(["y", "x"]), keys(["x", "y"])]);
  ok(near(f[0].score, f[1].score), "대칭 순위는 동점");
  ok(f[0].key === "x" && f[1].key === "y", "동점은 키 오름차순");
}

// named: 한 소스가 같은 정규 키를 여러 번 내도 한 번만 센다.
{
  const g = (key: string, i: number): Candidate => ({ ...cand(key, "graph"), sourceKey: `graph#e${i}`, text: `edge ${i} -> ${key}` });
  const graph = [g("entity:client#1", 0), g("entity:client#1", 1), g("entity:client#1", 2), g("entity:client#1", 3), g("entity:product#9", 4)];
  const vector = [cand("entity:product#9", "vector")];
  const f = rrfMergeNamed([graph, vector]);
  const hub = f.find((x) => x.canonicalKey === "entity:client#1")!;
  ok(near(hub.score, 1 / 61), `named: 반복 정규 키는 1위에서 한 번만 (got ${hub.score})`);
  ok(JSON.stringify(hub.sources) === '["graph"]', "named: 반복해도 소스는 하나");
  ok(hub.candidate.text === "edge 0 -> entity:client#1", "named: 대표 후보는 처음 본 것");
  ok(f[0].canonicalKey === "entity:product#9", "named: 반복한 허브가 교차 소스 합의를 못 이긴다");
  ok(near(f[0].score, 1 / 62 + 1 / 61), "named: 반복 뒤의 키는 그래프 리스트 2위로 센다");
}

// named 동점 — 점수가 같으면 소스가 많은 쪽, 그다음 키.
// q 는 두 리스트의 62위(1/122 + 1/122 = 1/61), p 는 한 리스트의 1위(1/61).
{
  const fill = (src: CandidateSource, n: number) => Array.from({ length: n }, (_, i) => cand(`filler:${src}#${i}`, src));
  const a = [cand("a:p", "sql"), ...fill("sql", 60), cand("z:q", "sql")];
  const b = [...fill("vector", 61), cand("z:q", "vector")];
  const f = rrfMergeNamed([a, b]);
  const p = f.find((x) => x.canonicalKey === "a:p")!;
  const q = f.find((x) => x.canonicalKey === "z:q")!;
  ok(near(p.score, q.score), "named: 두 점수가 같다");
  ok(q.rank < p.rank, "named: 동점이면 소스가 많은 쪽이 먼저(키 순보다 우선)");
}

console.log(`\nrrf.test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
