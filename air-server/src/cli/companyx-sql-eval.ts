// NL2SQL lane eval on the sponsor's Company-X data (execution match, DB oracle).
//
// eval/companyx/sql_gold.jsonl holds the 10 nl2sql questions from the sponsor's
// questions.json together with gold SQL written from the sponsor's OWN hint field.
// Prediction and gold are both executed under the least-privilege role and the
// RESULT SETS are compared — no LLM judge anywhere in the loop.
//
//   CX_STRATEGY=llm   (default) curated schema card
//   CX_STRATEGY=naive           bare table names (ablation)
//   SQL_CARD=compact            종전 한 줄 카드(ablation). 기본은 컬럼마다 뜻과 단위를 주석으로
//                               붙인 카드다.
//   CX_GOLD=eval/companyx/holdout3_route.json
//                               사업자 10문항 뒤에 홀드아웃의 nl2sql 문항(gold_sql)을
//                               붙인다. n=10 은 한 문항이 10pp 라 카드 비교를 못 가른다.
//
// Run: npm run companyx:sql
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getPool, closePool } from "../db.js";
import { sqlQuery, columnsForSql } from "../sql.js";
import { companyxNL2SQL, companyxNL2SQLNaive, repairSql } from "../nl2sql.js";
import { resultsMatch, type MatchOpts } from "../evalmatch.js";
import { isAvailable, DEFAULT_MODEL } from "../llm.js";
import { qualifyCompanyx } from "../companyx.js";

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
  /** 정답 행에서 id 열을 뺀다. 홀드아웃 작성자는 정렬용 id 를 습관처럼 투영했는데,
   * 질문은 id 를 묻지 않았다. 그 열 때문에 제목, 날짜, 고객명을 맞게 뽑은 예측이 오답이
   * 됐다(2026-09-30, h3-08, h3-12, h3-17). 답변 채점표도 id 를 빼고 본다. */
  dropGoldId?: boolean;
}

async function main() {
  const strategy = process.env.CX_STRATEGY ?? "llm";
  // CX_RESCORE=<결과 파일>: 모델을 부르지 않고 그 파일에 저장된 예측 SQL 을 다시 실행해
  // 채점한다. 비교기를 고쳤을 때 생성의 흔들림 없이 비교기 효과만 본다.
  const rescoreFrom = process.env.CX_RESCORE;
  if (!rescoreFrom && !(await isAvailable())) {
    console.log("companyx:sql SKIPPED (Ollama/model unavailable)");
    process.exit(0);
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const root = resolve(here, "../../..");
  const items: Q[] = (await readFile(resolve(root, "eval/companyx/sql_gold.jsonl"), "utf8"))
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
  const extra = process.env.CX_GOLD;
  if (extra) {
    const h = JSON.parse(await readFile(resolve(root, extra), "utf8")) as {
      items: { id: string; q: string; expected: string; gold_sql?: string }[];
    };
    for (const it of h.items) {
      if (it.expected !== "nl2sql" || !it.gold_sql) continue;
      // 투영 폭은 질문이 정하지 못한다. 행 수와 값은 엄격하게, 여분 컬럼은 허용한다.
      items.push({ id: it.id, q: it.q, gold: qualifyCompanyx(it.gold_sql), tax: "holdout", hint: "", subsetColumns: true, dropGoldId: !/\bid\b|아이디|번호/i.test(it.q) });
    }
  }

  const stored = rescoreFrom
    ? new Map(
        (JSON.parse(await readFile(resolve(root, rescoreFrom), "utf8")).rows as { id: string; pred: string; repaired?: boolean }[]).map(
          (r) => [r.id, r] as const,
        ),
      )
    : undefined;

  const pool = getPool();
  const rows = [];
  let correct = 0;
  let goldFailures = 0;
  for (const it of items) {
    const t0 = Date.now();
    const saved = stored?.get(it.id);
    if (stored && !saved) throw new Error(`${rescoreFrom} 에 ${it.id} 의 예측이 없다`);
    let pred: string | null = saved
      ? saved.pred === "(no SQL)" ? null : saved.pred
      : strategy === "naive" ? await companyxNL2SQLNaive(it.q) : await companyxNL2SQL(it.q);
    // eval == live: the pipeline repairs a rejected query once with the database's
    // own catalogue, so the benchmark must do the same or it measures a path no
    // user ever runs. CX_REPAIR=0 reproduces the un-repaired number.
    let repaired = saved?.repaired ?? false;
    if (!saved && pred && process.env.CX_REPAIR !== "0") {
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
    const g0 = await sqlQuery(pool, it.gold);
    const g = it.dropGoldId ? { ...g0, rows: g0.rows.map(({ id: _id, ...rest }) => rest) } : g0;
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
    dataset: extra ? `questions.json (nl2sql subset) + ${extra} (nl2sql)` : "companyx-dataset-v1.0 / questions.json (nl2sql subset)",
    strategy,
    schema_card: strategy === "naive" ? "table-names" : process.env.SQL_CARD === "compact" ? "compact" : "annotated",
    model: process.env.OLLAMA_MODEL ?? DEFAULT_MODEL,
    total: items.length,
    correct,
    accuracy: Number(((correct / items.length) * 100).toFixed(1)),
    gold_execution_failures: goldFailures,
    repaired_queries: rows.filter((r) => r.repaired).length,
    repair_enabled: process.env.CX_REPAIR !== "0",
    rescored_from: rescoreFrom ?? null,
    gold_id_dropped: items.filter((i) => i.dropGoldId).length,
    byTax,
    note: "Gold SQL written from the sponsor's own hint field; both queries executed, result sets compared (execution match). No LLM judge. n=10 is the sponsor's example set — small, so treat as a smoke number, not a benchmark.",
    generated_at: new Date().toISOString(),
  };
  await mkdir(resolve(root, "eval/results"), { recursive: true });
  // 재시도 유무는 같은 전략의 다른 조건이다. 한 파일에 덮어쓰면 2x2(스키마카드 x 재시도)
  // 중 두 칸만 저장소에 남고 보고서가 인용하는 나머지 두 칸은 근거가 사라진다.
  const suffix =
    (process.env.CX_REPAIR === "0" ? "-norepair" : "") +
    (strategy !== "naive" && process.env.SQL_CARD === "compact" ? "-compact" : "") +
    (extra ? `-${extra.replace(/^.*[/\\]/, "").replace(/_route\.json$|\.json$/, "")}` : "");
  await writeFile(
    resolve(root, `eval/results/companyx-sql-${strategy}${suffix}.json`),
    JSON.stringify({ summary, rows }, null, 2) + "\n",
  );
  console.log(`\ncompanyx:sql ${JSON.stringify(summary, null, 2)}`);
  await closePool();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
