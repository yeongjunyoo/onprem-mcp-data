// NL2SQL model comparison on the fixed dev subset, the way the pipeline runs it:
// companyxNL2SQL -> alignQualifiedTables -> executeWithRepair (gates, rewrites, one repair).
//
// Subset "dev30" = sponsor 10 (eval/companyx/sql_gold.jsonl) + holdout3 nl2sql 20 — the same 30 questions as the
// 2026-09-30 model comparison (docs/report.md: coder 18, qwen3.5:9b 20, gemma4:e4b 19; swap rule +3).
// "h4" = holdout4 nl2sql 20, reported separately.
//
// Two scores per question:
//   ex    execution match as companyx:sql measures it (subsetColumns for holdout, gold id dropped when the question
//         does not ask for ids), except that interval values are compared by value. evalmatch.ts stringifies them,
//         so any two intervals compare equal ("[object Object]").
//   rows  the scorecard judge applied to the executed rows (does the row set carry every asked value)
//
// Usage: OLLAMA_MODEL=<tag> [OLLAMA_THINK=false] [DIAG_STRIP_THINK=1] DATASET=companyx ... node eval/diag/sql-models.mjs --out <file>
// DIAG_STRIP_THINK=1 (patch-dist.mjs) keeps only the text after `</think>` for models that reason even with think=false.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const arg = (n, d) => {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1] : d;
};
const MODEL = process.env.OLLAMA_MODEL ?? "qwen2.5-coder:7b";
const OUT = arg("--out", join(root, ".scratch", "diag", `sql-models-${MODEL.replace(/[^a-zA-Z0-9.]+/g, "_")}.json`));
const SETS = (arg("--sets", "dev30,h4") || "").split(",");
// --sc N: execution-guided self-consistency. The greedy SQL plus N samples (temperature 0.7, seeds 1..N), each run through
// the same gates and repair; the answer is the result set most candidates agree on (ties go to the greedy candidate's set).
const SC = Number(arg("--sc", "0"));
if (!/mcpdata_diag/.test(process.env.DATABASE_URL ?? "")) throw new Error("DATABASE_URL must point at mcpdata_diag");
if (!/^http:\/\/(127\.0\.0\.1|localhost):11434\/?$/.test(process.env.OLLAMA_HOST ?? "")) throw new Error("OLLAMA_HOST must be the host Ollama on 11434");

const D = (m) => import(pathToFileURL(join(root, "air-server", "dist", "_diag", m)).href);
const sc = await D("scorecard.js");
const cx = await D("companyx.js");
const { getPool } = await D("db.js");
const { companyxNL2SQL } = await D("nl2sql.js");
const { executeWithRepair } = await D("sqlrepair.js");
const { alignQualifiedTables } = await D("sqltrust.js");
const { sqlQuery } = await D("sql.js");
const { resultsMatch } = await D("evalmatch.js");
const { sqlRowsBlock } = await D("pipeline.js");

const pool = getPool();
const { nodes } = await cx.loadGraph(cx.datasetDir());
const cat = sc.buildCatalog(nodes);
const byValue = (rows) =>
  rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v && typeof v === "object" && "toPostgres" in v ? v.toPostgres() : v])));

async function runGold(sql) {
  const res = await pool.query(sql);
  const rows = res.rows;
  const limited = sc.isLimited(sql);
  let tied = [];
  if (limited && rows.length) {
    const cols = Object.keys(rows[0]);
    const asked = sc.askedColumns(rows, true);
    const helpers = cols.filter((c) => !asked.includes(c) && !/^id$|_id$/.test(c));
    if (helpers.length && asked.length) {
      const last = rows[rows.length - 1];
      const every = await pool.query(sc.withoutLimit(sql));
      tied = every.rows.filter((r) => helpers.every((h) => String(r[h]) === String(last[h]))).map((r) => String(r[asked[0]]));
    }
  }
  return { rows, fields: res.fields, limited, tied };
}

const items = [];
if (SETS.includes("dev30")) {
  for (const l of (await readFile(join(root, "eval/companyx/sql_gold.jsonl"), "utf8")).split("\n").filter((x) => x.trim())) {
    const g = JSON.parse(l);
    const r = await runGold(g.gold);
    const gold = { rows: r.rows, ordered: Boolean(g.ordered), limited: r.limited, tied: r.tied };
    items.push({ set: "dev30", id: g.id, q: g.q, gold: g.gold, opts: { ordered: g.ordered, columnsSensitive: g.columnsSensitive, tupleSensitive: g.tupleSensitive, numericTolerance: g.numericTolerance, subsetColumns: g.subsetColumns }, dropId: false, judge: (a) => sc.scoreSql(a, g.q, gold, cat, "ok") });
  }
}
for (const [set, file] of [["dev30", "eval/companyx/holdout3_route.json"], ["h4", "eval/companyx/holdout4_route.json"]]) {
  if (!SETS.includes(set)) continue;
  for (const it of JSON.parse(await readFile(join(root, file), "utf8")).items) {
    if (it.expected !== "nl2sql") continue;
    const sql = cx.qualifyCompanyx(it.gold_sql);
    const r = await runGold(sql);
    const g = sc.sqlGoldFromResult(r.rows, r.fields, { ordered: false, limited: r.limited, tied: r.tied });
    items.push({ set, id: it.id, q: it.q, gold: sql, opts: { subsetColumns: true }, dropId: !/\bid\b|아이디|번호/i.test(it.q), judge: "gold" in g ? (a) => sc.scoreSql(a, it.q, g.gold, cat, "ok") : null });
  }
}

const canon = (rows) => JSON.stringify(byValue(rows).map((r) => Object.values(r).map((v) => (v instanceof Date ? v.toISOString() : String(v))).sort()).map((x) => JSON.stringify(x)).sort());
async function candidate(q, gen) {
  globalThis.__diag = gen ? { gen } : {};
  const report = {};
  let pred = null;
  try {
    pred = await companyxNL2SQL(q, report);
  } catch {
    pred = null;
  }
  globalThis.__diag = {};
  const text = pred ? alignQualifiedTables(pred, q) : null;
  const ex = text ? await executeWithRepair(pool, q, text, { repair: true, schema: "companyx" }) : null;
  return { pred, ex };
}
const rows = [];
for (const it of items) {
  const t0 = Date.now();
  let err = null;
  const greedy = await candidate(it.q, null);
  let { pred, ex } = greedy;
  let votes = null;
  if (SC > 0) {
    const cands = [greedy];
    for (let i = 1; i <= SC; i++) cands.push(await candidate(it.q, { temperature: 0.7, seed: i }));
    const groups = new Map();
    cands.forEach((c, i) => {
      if (!c.ex?.result?.ok || !c.ex.result.rows.length) return;
      const key = canon(c.ex.result.rows);
      groups.set(key, [...(groups.get(key) ?? []), i]);
    });
    let best = null;
    for (const [, idx] of groups) if (!best || idx.length > best.length || (idx.length === best.length && idx.includes(0))) best = idx;
    if (best) ({ pred, ex } = cands[best[0]]);
    votes = { groups: [...groups.values()].map((g) => g.length).sort((a, b) => b - a), picked_greedy: best ? best.includes(0) : true };
  }
  const genMs = Date.now() - t0;
  const res = ex?.result;
  const g0 = await sqlQuery(pool, it.gold);
  const g = it.dropId ? g0.rows.map(({ id: _id, ...rest }) => rest) : g0.rows;
  const ok = Boolean(res?.ok);
  const exMatch = ok && g0.ok ? resultsMatch(byValue(res.rows), byValue(g), it.opts) : false;
  const exRepo = ok && g0.ok ? resultsMatch(res.rows, g, it.opts) : false;
  const rowsAns = ok && res.rows.length && it.judge ? it.judge(sqlRowsBlock(res.rows, res.rows.length, 1e9)).correct : false;
  rows.push({ set: it.set, id: it.id, votes, ex: exMatch, ex_repo_matcher: exRepo, rows_have_answer: rowsAns, scorable: Boolean(it.judge), sql: ex?.text ?? pred ?? null, gate: ex?.gate?.outcome ?? null, repaired: Boolean(ex?.repaired), error: res && !res.ok ? res.error : err, gen_ms: genMs, ms: Date.now() - t0 });
  console.log(`${exMatch ? "✓" : "✗"}${rowsAns ? "r" : "-"} ${it.set} ${it.id} ${genMs}ms`);
}
const sum = (set) => {
  const xs = rows.filter((r) => r.set === set);
  return { n: xs.length, ex: xs.filter((r) => r.ex).length, ex_repo_matcher: xs.filter((r) => r.ex_repo_matcher).length, rows_have_answer: `${xs.filter((r) => r.rows_have_answer).length}/${xs.filter((r) => r.scorable).length}`, median_gen_ms: xs.map((r) => r.gen_ms).sort((a, b) => a - b)[Math.floor(xs.length / 2)] };
};
const summary = { model: MODEL, think: process.env.OLLAMA_THINK ?? null, self_consistency: SC || null, sets: Object.fromEntries(SETS.map((s) => [s, sum(s)])), generated_at: new Date().toISOString() };
await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify({ summary, rows }, null, 2) + "\n");
console.log(JSON.stringify(summary));
await pool.end();
process.exit(0);
