// Pipeline integration test — route -> fan-out -> RRF -> curate, against the
// live DB. Run after build: node dist/pipeline.test.js (db up + embeddings).
import { getPool, closePool } from "./db.js";
import { getEmbedder } from "./embedder.js";
import { embedDocuments } from "./vector.js";
import { retrieve } from "./pipeline.js";
import { templateNL2SQL } from "./nl2sql.js";

let pass = 0, fail = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { pass++; } else { fail++; console.error("  FAIL:", msg); }
}

async function main() {
  const pool = getPool();
  const embedder = getEmbedder();
  await embedDocuments(pool, embedder);
  // Inject the deterministic template NL2SQL so this spine test stays offline
  // (no Ollama). The live ask/retrieve default to llmNL2SQL; that path is what
  // the execution-match eval covers. Here we test routing/RRF/curation plumbing.
  const deps = { pool, embedder, nl2sql: templateNL2SQL };

  // --- structured: count -> SQL only, no vector candidates ---
  const s = await retrieve("전체 주문 건수 알려줘", deps);
  ok(s.route === "structured", `structured route (got ${s.route})`);
  ok(s.sql.text != null && /count/i.test(s.sql.text), "structured produced a count SQL");
  ok(s.audit.candidates.sql >= 1 && s.audit.candidates.vector === 0, "sql-only candidates");
  ok(/order_count=5/.test(s.context), `context carries the count (got: ${s.context})`);
  ok(s.curated.brokenRows === 0, "structured: no broken rows");

  // --- semantic: aboutness -> vector only ---
  const m = await retrieve("환불 정책에 대한 내용 찾아줘", deps);
  ok(m.route === "semantic", `semantic route (got ${m.route})`);
  ok(m.audit.candidates.vector >= 1 && m.audit.candidates.sql === 0, "vector-only candidates");
  ok(/환불/.test(m.context), "context carries the refund policy");
  ok(m.curated.brokenRows === 0, "semantic: no broken rows");

  // --- hybrid: both signals -> fan out + RRF fuse both sources ---
  const h = await retrieve("지난달 취소된 주문 중 환불 관련 문의가 비슷한 케이스", deps);
  ok(h.route === "hybrid", `hybrid route (got ${h.route})`);
  ok(h.audit.candidates.sql >= 1 && h.audit.candidates.vector >= 1, "both sources contributed");
  const keys = h.fused.map((f) => f.key);
  ok(keys.some((k) => k.startsWith("sql#")) && keys.some((k) => k.startsWith("documents#")),
    "fused list mixes sql + document candidates");
  ok(h.curated.brokenRows === 0, "hybrid: structure integrity preserved");

  // --- determinism: identical run -> identical context + audit ---
  const a = JSON.stringify(await retrieve("지난달 취소된 주문 중 환불 관련 문의가 비슷한 케이스", deps));
  const b = JSON.stringify(await retrieve("지난달 취소된 주문 중 환불 관련 문의가 비슷한 케이스", deps));
  ok(a === b, "pipeline is deterministic");

  await closePool();
  console.log(`\npipeline.test: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
