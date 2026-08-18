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
  // ── 전제. v=0 은 "테스트가 틀렸다" 가 아니라 "임베딩이 없다" 는 뜻이다.
  //
  // 2026-08-18: embed CLI 를 프로파일 기반으로 바꾸면서 bench.documents 가 비었고
  // 이 테스트가 `TypeError: Cannot read properties of undefined (reading 'rank')` 로
  // 죽었다. **TypeError 는 원인을 말하지 않는다** — 상단 주석에 전제가 적혀 있었지만
  // 주석은 사람이 읽어야 하고 전제 검사는 저절로 말한다.
  {
    const { rows } = await pool.query<{ n: string }>(
      "SELECT count(embedding)::text AS n FROM bench.documents",
    );
    if (Number(rows[0]?.n ?? 0) === 0) {
      console.error("\n실패: bench.documents 에 임베딩이 없다 — 이 테스트는 벡터 레인을 쓴다.");
      // 셸 전용 문법을 안 쓴다. 이 저장소는 Windows 에서 개발·검증되는데
      // `VAR=x cmd` 는 cmd/PowerShell 에서 안 먹는다 — 스크립트가 값을 직접 넘긴다.
      console.error("  npm run embed:bench:ollama 로 채우고 다시 돌린다(스크립트가 프로파일을 고정한다).");
      console.error("  (npm run test:kg 는 그 단계를 포함한다.)\n");
      process.exit(1);
    }
  }

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
