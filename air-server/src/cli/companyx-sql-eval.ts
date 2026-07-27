// NL2SQL lane eval on the sponsor's Company-X data (execution match, DB oracle).
//
// eval/companyx/sql_gold.jsonl holds the 10 nl2sql questions from the sponsor's
// questions.json together with gold SQL written from the sponsor's OWN hint field.
// Prediction and gold are both executed under the least-privilege role and the
// RESULT SETS are compared — no LLM judge anywhere in the loop.
//
//   CX_STRATEGY=llm   (default) curated schema card
//   CX_STRATEGY=naive           bare table names (ablation)
//
// Run: npm run companyx:sql
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getPool, closePool } from "../db.js";
import { sqlQuery, columnsForSql } from "../sql.js";
import { companyxNL2SQL, companyxNL2SQLNaive, repairSql } from "../nl2sql.js";
import { resultsMatch, type MatchOpts } from "../evalmatch.js";
import { isAvailable } from "../llm.js";

interface Q {
  id: string;
  q: string;
  gold: string;
  tax: string;
  hint: string;
  ordered?: boolean;
  columnsSensitive?: boolean;
  tupleSensitive?: boolean;
  numericTolerance?: number;
  subsetColumns?: boolean;
}

async function main() {
  const strategy = process.env.CX_STRATEGY ?? "llm";
  if (!(await isAvailable())) {
    console.log("companyx:sql SKIPPED (Ollama/model unavailable)");
    process.exit(0);
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const root = resolve(here, "../../..");
  const items: Q[] = (await readFile(resolve(root, "eval/companyx/sql_gold.jsonl"), "utf8"))
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));

  const pool = getPool();
  const rows = [];
  let correct = 0;
  let goldFailures = 0;
  for (const it of items) {
    const t0 = Date.now();
    let pred = strategy === "naive" ? await companyxNL2SQLNaive(it.q) : await companyxNL2SQL(it.q);
    // eval == live: the pipeline repairs a rejected query once with the database's
    // own catalogue, so the benchmark must do the same or it measures a path no
    // user ever runs. CX_REPAIR=0 reproduces the un-repaired number.
    let repaired = false;
    if (pred && process.env.CX_REPAIR !== "0") {
      const probe = await sqlQuery(pool, pred);
      if (!probe.ok) {
        const cols = await columnsForSql(pool, pred, "companyx").catch(() => "");
        const fixed = await repairSql(it.q, pred, probe.error ?? "unknown error", cols);
        if (fixed) {
          const second = await sqlQuery(pool, fixed);
          if (second.ok) {
            pred = fixed;
            repaired = true;
          }
        }
      }
    }
    const ms = Date.now() - t0;
    const opts: MatchOpts = {
      ordered: it.ordered,
      columnsSensitive: it.columnsSensitive,
      tupleSensitive: it.tupleSensitive,
      numericTolerance: it.numericTolerance,
      subsetColumns: it.subsetColumns,
    };
    const g = await sqlQuery(pool, it.gold);
    if (!g.ok) goldFailures++;
    let matched = false;
    let predOk = false;
    let predErr: string | undefined;
    if (pred) {
      const p = await sqlQuery(pool, pred);
      predOk = p.ok;
      predErr = p.error;
      matched = p.ok && g.ok && resultsMatch(p.rows, g.rows, opts);
    }
    if (matched) correct++;
    rows.push({ id: it.id, tax: it.tax, ok: matched, repaired, pred: pred ?? "(no SQL)", predOk, predErr, goldOk: g.ok, goldRows: g.rows.length, ms });
    console.log(`${matched ? "✓" : "✗"} ${it.id} [${it.tax}] ${it.q}`);
    if (!matched) console.log(`    pred: ${(pred ?? "(no SQL)").replace(/\s+/g, " ")}${predErr ? ` | err: ${predErr}` : ""}`);
  }

  const byTax: Record<string, { c: number; n: number }> = {};
  for (const r of rows) {
    byTax[r.tax] ??= { c: 0, n: 0 };
    byTax[r.tax].n++;
    if (r.ok) byTax[r.tax].c++;
  }
  const summary = {
    dataset: "companyx-dataset-v1.0 / questions.json (nl2sql subset)",
    strategy,
    model: process.env.OLLAMA_MODEL ?? "qwen2.5:7b",
    total: items.length,
    correct,
    accuracy: Number(((correct / items.length) * 100).toFixed(1)),
    gold_execution_failures: goldFailures,
    repaired_queries: rows.filter((r) => r.repaired).length,
    repair_enabled: process.env.CX_REPAIR !== "0",
    byTax,
    note: "Gold SQL written from the sponsor's own hint field; both queries executed, result sets compared (execution match). No LLM judge. n=10 is the sponsor's example set — small, so treat as a smoke number, not a benchmark.",
    generated_at: new Date().toISOString(),
  };
  await mkdir(resolve(root, "eval/results"), { recursive: true });
  await writeFile(resolve(root, `eval/results/companyx-sql-${strategy}.json`), JSON.stringify({ summary, rows }, null, 2) + "\n");
  console.log(`\ncompanyx:sql ${JSON.stringify(summary, null, 2)}`);
  await closePool();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
