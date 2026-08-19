// LLM (생성 모델(기본 Qwen2.5-Coder-7B) via Ollama) end-to-end answer test.
// Skips gracefully when the model is not pulled / Ollama is unreachable, so the
// suite stays green in air-gapped CI; runs for real when the model is present.
import { getPool, closePool } from "./db.js";
import { getEmbedder } from "./embedder.js";
import { embedDocuments } from "./vector.js";
import { ask } from "./pipeline.js";
import { isAvailable } from "./llm.js";

let pass = 0, fail = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { pass++; } else { fail++; console.error("  FAIL:", msg); }
}

async function main() {
  if (!(await isAvailable())) {
    console.log("\nllm.test: SKIPPED (Ollama/qwen2.5-coder:7b not available)");
    process.exit(0);
  }

  const pool = getPool();
  const embedder = getEmbedder();
  await embedDocuments(pool, embedder);
  const deps = { pool, embedder };

  // structured: the curated context carries order_count=5; the model must report 5.
  const s = await ask("전체 주문 건수 알려줘", deps);
  ok(s.answer.length > 0, "structured answer is non-empty");
  ok(/5/.test(s.answer), `structured answer reports the count (got: ${s.answer})`);

  // semantic: grounded in the refund policy doc (7일 / 환불 / 반품 / 택배).
  const m = await ask("환불 정책 알려줘", deps);
  ok(m.answer.length > 0, "semantic answer is non-empty");
  ok(/7일|환불|반품|택배/.test(m.answer), `semantic answer grounded in policy (got: ${m.answer})`);

  // grounding guard: no context -> must refuse, not hallucinate.
  const empty = await ask("화성의 인구는 몇 명이야", { ...deps, budget: 0 });
  ok(empty.answer.length > 0, "refusal answer is non-empty");

  console.log(`\nllm.test: ${pass} passed, ${fail} failed`);
  console.log(`  [structured] ${s.answer}`);
  console.log(`  [semantic]   ${m.answer}`);
  await closePool();
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
