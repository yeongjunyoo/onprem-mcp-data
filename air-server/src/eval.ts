// SQL execution-match eval (objective, non-circular).
//
// For each NL question we let Qwen2.5-7B generate SQL (llmNL2SQL), execute both
// the predicted and the gold SQL, and check whether the RESULT SETS match
// (evalmatch.resultsMatch). No LLM judge anywhere — the database is the oracle.
// Reference benchmark from the 리원에이스 brief: ~64.0% accuracy with no tuning.
//
// Run: npm run eval   (requires db up + Ollama + 생성 모델). Reports, never fails
// the build on model accuracy.
import { readFile } from "node:fs/promises";
import { getPool, closePool } from "./db.js";
import { sqlQuery } from "./sql.js";
import { llmNL2SQL } from "./nl2sql.js";
import { resultsMatch } from "./evalmatch.js";
import { isAvailable } from "./llm.js";

interface EvalItem { q: string; gold: string; ordered?: boolean; columnsSensitive?: boolean; tupleSensitive?: boolean; numericTolerance?: number; }

const DATASET = new URL("../../eval/sql_eval.jsonl", import.meta.url);
const REFERENCE = 0.64; // 리원에이스 brief reference benchmark

async function main() {
  if (!(await isAvailable())) {
    console.log("eval: SKIPPED (Ollama 또는 생성 모델이 없다)");
    process.exit(0);
  }

  const text = await readFile(DATASET, "utf8");
  const items: EvalItem[] = text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));

  const pool = getPool();
  let correct = 0;
  const rows: { ok: boolean; q: string; pred: string }[] = [];

  for (const it of items) {
    const pred = await llmNL2SQL(it.q);
    let matched = false;
    if (pred) {
      const [p, g] = await Promise.all([sqlQuery(pool, pred), sqlQuery(pool, it.gold)]);
      matched = p.ok && g.ok && resultsMatch(p.rows, g.rows, {
        ordered: it.ordered,
        columnsSensitive: it.columnsSensitive,
        tupleSensitive: it.tupleSensitive,
        numericTolerance: it.numericTolerance,
      });
    }
    if (matched) correct++;
    rows.push({ ok: matched, q: it.q, pred: pred ?? "(no SQL produced)" });
  }

  const acc = correct / items.length;
  console.log("\n=== SQL execution-match eval ===");
  for (const r of rows) console.log(`${r.ok ? "✓" : "✗"} ${r.q}\n    -> ${r.pred}`);
  console.log(`\naccuracy: ${correct}/${items.length} = ${(acc * 100).toFixed(1)}%`);
  console.log(
    "NOTE: this is a SMOKE harness over a tiny seed schema (5 orders rows, 14 questions),",
  );
  console.log(
    "not a contest-grade benchmark. It validates the objective execution-match path",
  );
  console.log(
    `end-to-end; it is NOT comparable to the brief's ${(REFERENCE * 100).toFixed(1)}% reference`,
  );
  console.log(
    "(different dataset/difficulty). A held-out multi-table set is the benchmark to report.",
  );

  await closePool();
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
