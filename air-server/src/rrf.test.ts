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

console.log(`\nrrf.test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
