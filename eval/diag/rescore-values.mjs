// Re-score stored vector answers (holdout4, gold_keywords) with one narrower-than-human rule added to the
// scorecard's keyword match: a keyword that carries numbers (40분, 78%, 4098만원, 2025-04-22 16:33) is satisfied when
// every number in it appears in the answer with the same value and unit. Keywords without numbers stay verbatim
// (scorecard.ts hasKeyword). Wrong values still fail (28% for 40%), abstentions still fail, documents-outside ids
// still fail. Reads answer-stages output files; writes nothing.
//
// Usage: DATASET_DIR=... node eval/diag/rescore-values.mjs <stages.json> [<stages.json> ...]
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const D = (m) => import(pathToFileURL(join(root, "air-server", "dist", "_diag", m)).href);
const sc = await D("scorecard.js");
const cx = await D("companyx.js");
const { nodes } = await cx.loadGraph(cx.datasetDir());
const cat = sc.buildCatalog(nodes);
const docText = async (id) => readFile(join(cx.datasetDir(), "documents", `${id}.md`), "utf8");
const ID = /\b(?:Client|Product)-[A-Z0-9]+\b/g;
const h4 = new Map(JSON.parse(await readFile(join(root, "eval/companyx/holdout4_route.json"), "utf8")).items.map((x) => [x.id, x]));

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function numberAtoms(kw) {
  const t = kw.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return [{ date: t }];
  return [...t.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*(만원|억원|원|%|GB|MB|TB|ms|초|분|시간|일|주|개월|년|회|명|건|개)?/g)].map((m) => ({
    n: m[1].replace(/,/g, ""),
    unit: m[2] ?? "",
  }));
}
export function hasAtoms(answer, kw) {
  const atoms = numberAtoms(kw);
  if (!atoms.length) return null;
  const a = answer.replace(/(?<=\d),(?=\d{3})/g, "");
  return atoms.every((x) =>
    x.date ? sc.hasDate(answer, x.date) : new RegExp(`(?<![\\d.])${esc(x.n)}(?![\\d.])\\s*${x.unit.split("").map(esc).join("\\s*")}`).test(a),
  );
}

const args = process.argv.slice(2);
const jsonAt = args.indexOf("--json");
const jsonOut = jsonAt >= 0 ? args.splice(jsonAt, 2)[1] : null;
const verdicts = {};
for (const f of args) {
  const name = f.replace(/^.*[\\/]/, "");
  verdicts[name] = {};
  const data = JSON.parse(await readFile(f, "utf8"));
  let strict = 0, lenient = 0, n = 0;
  for (const r of data.rows) {
    const it = h4.get(r.id);
    if (!it || it.expected !== "vector_search" || r.unscorable) continue;
    n++;
    const keys = (it.gold_keywords ?? []).filter((k) => !sc.hasKeyword(it.q, k));
    const abst = sc.abstainsFirst(r.answer);
    const ok = (k) => sc.hasKeyword(r.answer, k) || hasAtoms(r.answer, k) === true;
    const gold = await Promise.all((it.gold_docs ?? []).map((d) => docText(d.replace(/\.md$/, ""))));
    const inQ = new Set([...it.q.matchAll(ID)].map((m) => m[0]));
    const outside = [...new Set([...r.answer.matchAll(ID)].map((m) => m[0]))].filter((x) => !inQ.has(x) && !gold.some((t) => new RegExp(`(?<![A-Za-z0-9-])${x}(?![A-Za-z0-9])`).test(t)));
    const pass = r.state === "ok" && !abst && !sc.inventedIds(r.answer, cat).length && keys.every(ok) && outside.length === 0;
    if (r.correct) strict++;
    if (r.correct || pass) lenient++;
    verdicts[name][r.id] = { strict: r.correct, number_rule: r.correct || pass };
    const miss = keys.filter((k) => !ok(k));
    console.log(`${r.correct ? "O" : pass ? "+" : "X"} ${r.id} ${miss.length ? `still missing: ${miss.join(" / ")}` : ""}`);
  }
  console.log(`${f.replace(/^.*[\\/]/, "")}: strict ${strict}/${n}, with number rule ${lenient}/${n}\n`);
}
if (jsonOut) await (await import("node:fs/promises")).writeFile(jsonOut, `${JSON.stringify(verdicts, null, 1)}\n`);
