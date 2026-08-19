// Gate5 — internal contest-grade benchmark runner (SQL execution-match).
//
// Strategy (BENCH_STRATEGY): "llm" (default) = Qwen2.5-7B benchNL2SQL over the
// bench schema card. Each predicted SQL and the gold SQL are executed under the
// least-privilege mcp_ro role; results are compared with the strict execution
// matcher honoring per-question metadata (ordered / numericTolerance / ...).
// No LLM judge — the database is the oracle. Raw predictions + summary are
// written to eval/results/ so every reported number is traceable.
//
// Run: node dist/cli/bench-eval.js   (requires bench seeded + Ollama + 생성 모델)
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { getPool, closePool } from "../db.js";
import { sqlQuery } from "../sql.js";
import { benchNL2SQL, benchNL2SQLNaive, templateNL2SQL } from "../nl2sql.js";
import { resultsMatch, type MatchOpts } from "../evalmatch.js";
import { isAvailable, DEFAULT_MODEL } from "../llm.js";

interface Q {
  id: string; q: string; gold: string; tax: string;
  ordered?: boolean; columnsSensitive?: boolean; tupleSensitive?: boolean; numericTolerance?: number;
}

async function main() {
  const strategy = process.env.BENCH_STRATEGY ?? "llm";

  // ★ 모르는 전략은 거절한다.
  //
  // 아래 분기는 naive/template/llm 이 아니면 `pred = null` 로 떨어져 **전 항목이
  // 오답**이 되고, 정확도 0/100 짜리 `internal-<오타>-summary.json` 을 쓴다.
  // 심사자가 ablation 을 재현하다 오타를 내면 0% 를 보고 시스템이 망가졌다고 읽는다.
  //
  // ablation 1%/30%/83% 는 시연 대본이 화면에 띄우는 값이다. 그 재현 경로에
  // 조용한 0% 가 있으면 안 된다. DATASET(PR #123)·MCP_TRANSPORT(PR #70) 와 같다.
  const STRATEGIES = ["naive", "template", "llm"] as const;
  if (!(STRATEGIES as readonly string[]).includes(strategy)) {
    console.error(
      `BENCH_STRATEGY="${strategy}" 는 모르는 전략이다. ` +
        `가능한 값: ${STRATEGIES.join(" | ")} (미설정이면 llm).`,
    );
    console.error("  모르는 값으로 돌면 전 항목이 오답이 되고 0% 짜리 결과 파일이 남는다.");
    process.exit(1);
  }

  if (strategy !== "template" && !(await isAvailable())) {
    console.log(`bench:internal SKIPPED (Ollama/${process.env.OLLAMA_MODEL ?? DEFAULT_MODEL} unavailable)`);
    process.exit(0);
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const root = resolve(here, "../../..");
  const items: Q[] = (await readFile(resolve(root, "eval/internal/questions.jsonl"), "utf8"))
    .split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));


  const pool = getPool();
  const rows: { id: string; tax: string; ok: boolean; pred: string; predOk: boolean; goldOk: boolean }[] = [];
  let correct = 0;
  for (const it of items) {
    const pred = strategy === "naive"
      ? await benchNL2SQLNaive(it.q)
      : strategy === "template"
      ? templateNL2SQL(it.q)
      : strategy === "llm" ? await benchNL2SQL(it.q) : null;
    let matched = false, predOk = false, goldOk = false;
    if (pred) {
      const opts: MatchOpts = {
        ordered: it.ordered, columnsSensitive: it.columnsSensitive,
        tupleSensitive: it.tupleSensitive, numericTolerance: it.numericTolerance,
      };
      const [p, g] = await Promise.all([sqlQuery(pool, pred), sqlQuery(pool, it.gold)]);
      predOk = p.ok; goldOk = g.ok;
      matched = p.ok && g.ok && resultsMatch(p.rows, g.rows, opts);
    }
    if (matched) correct++;
    rows.push({ id: it.id, tax: it.tax, ok: matched, pred: pred ?? "(no SQL)", predOk, goldOk });
    console.log(`${matched ? "✓" : "✗"} ${it.id} [${it.tax}] ${it.q}`);
    if (!matched) console.log(`    pred: ${pred ?? "(no SQL)"}`);
  }

  const acc = correct / items.length;
  const byTax: Record<string, { c: number; n: number }> = {};
  for (const r of rows) {
    const k = r.tax;
    byTax[k] ??= { c: 0, n: 0 };
    byTax[k].n++; if (r.ok) byTax[k].c++;
  }
  const summary = {
    strategy, model: process.env.OLLAMA_MODEL ?? DEFAULT_MODEL,
    total: items.length, correct, accuracy: Number((acc * 100).toFixed(1)),
    byTax, generatedAt: new Date().toISOString(),
    note: "internal brief-aligned suite; strict execution-match vs gold under mcp_ro; no LLM judge. KOSSA 64.0% is a contextual reference on a DIFFERENT dataset, not a same-benchmark comparison.",
  };
  await mkdir(resolve(root, "eval/results"), { recursive: true });
  await writeFile(resolve(root, `eval/results/internal-${strategy}-raw.json`), JSON.stringify(rows, null, 2));
  await writeFile(resolve(root, `eval/results/internal-${strategy}-summary.json`), JSON.stringify(summary, null, 2));
  console.log(`\n[bench:internal ${strategy}] accuracy ${correct}/${items.length} = ${(acc * 100).toFixed(1)}%`);
  console.log(`byTax: ${JSON.stringify(byTax)}`);
  await closePool();
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
