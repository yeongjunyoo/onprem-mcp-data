// Gate4 canonical 3-way retrieval test — live bench KG + BGE-M3.
// Requires: npm run gen:bench && EMBEDDER=ollama npm run embed:bench.
// Run: EMBEDDER=ollama node dist/kgretrieve.test.js
import { getPool, closePool } from "./db.js";
import { OllamaEmbedder } from "./embedder.js";
import { isAvailable } from "./llm.js";
import { kgRetrieve } from "./kgretrieve.js";

let pass = 0, fail = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { pass++; } else { fail++; console.error("  FAIL:", msg); }
}

async function main() {
  if (!(await isAvailable("bge-m3"))) {
    console.log("\nkgretrieve.test: SKIPPED (bge-m3 not available)");
    process.exit(0);
  }
  const pool = getPool();
  const embedder = new OllamaEmbedder("bge-m3"); // bench docs are bge-m3-embedded

  // "전자제품 환불" : ontology resolves 전자기기(alias)+환불 정책(canonical);
  // vector returns the 환불 정책 doc -> mapped via entity_links to the SAME policy entity.
  const r = await kgRetrieve(pool, "전자제품 환불 규정 알려줘", { embedder, schema: "bench", k: 5 });
  ok(r.fused.length > 0, "fused candidates returned");
  ok(r.audit.vector > 0 && r.audit.graph > 0, `both branches contributed (v=${r.audit.vector} g=${r.audit.graph})`);

  // canonical agreement: at least one entity surfaced by BOTH vector and graph
  const agree = r.fused.find((f) => f.sources.length > 1);
  ok(!!agree, `>=1 candidate has multi-source agreement (agreement=${r.audit.agreement})`);
  ok(!!agree && agree.sources.includes("vector") && agree.sources.includes("graph"),
    `agreement spans vector+graph (got ${JSON.stringify(agree?.sources)})`);
  ok(!!agree && agree.canonicalKey.startsWith("entity:"),
    `agreement candidate is a canonical entity (got ${agree?.canonicalKey})`);

  // the multi-source candidate outranks at least one single-source candidate
  const single = r.fused.find((f) => f.sources.length === 1);
  ok(!single || (agree!.rank < single.rank), "multi-source agreement outranks single-source");

  // determinism of fusion ranking (embeddings fixed after backfill)
  const a = JSON.stringify((await kgRetrieve(pool, "전자제품 환불 규정 알려줘", { embedder, schema: "bench" })).fused.map((f) => [f.canonicalKey, f.sources]));
  const b = JSON.stringify((await kgRetrieve(pool, "전자제품 환불 규정 알려줘", { embedder, schema: "bench" })).fused.map((f) => [f.canonicalKey, f.sources]));
  ok(a === b, "kgRetrieve fusion is deterministic");

  console.log(`\nkgretrieve.test: ${pass} passed, ${fail} failed`);
  console.log(`  agreement entity: ${agree?.canonicalKey} sources=${JSON.stringify(agree?.sources)}`);
  await closePool();
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
