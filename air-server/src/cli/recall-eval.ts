// Gate3 quantification — semantic retrieval head-to-head: BGE-M3 vs hash.
//
// Both embedders are 1024-dim and share the exact same ranking code path; the
// only variable is the embedding. Gold relevance labels (eval/internal/
// retrieval.jsonl) use deliberately LOW lexical-overlap queries (synonyms /
// paraphrases: 암호↔비밀번호, 할인권↔쿠폰, 상담원↔고객센터, 무르다↔환불) so the
// comparison measures semantic generalization, not term matching. Metrics:
// recall@{1,3,5}, MRR, top1 — computed against the DB-backed bench.documents
// corpus. No LLM judge; the gold set is the oracle. Raw per-query ranks +
// summary written to eval/results/ so every number is traceable.
//
// Run: EMBEDDER unused here (runs BOTH); requires bench docs + Ollama/bge-m3.
//   node dist/cli/recall-eval.js
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { getPool, closePool } from "../db.js";
import { HashEmbedder, OllamaEmbedder, type Embedder } from "../embedder.js";

interface QGold { q: string; gold: number[]; }
interface Doc { id: number; text: string; }

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

/** 1-indexed rank of the best (lowest-rank) gold doc; Infinity if none ranked. */
function bestGoldRank(ranked: number[], gold: number[]): number {
  let best = Infinity;
  for (const g of gold) {
    const r = ranked.indexOf(g);
    if (r >= 0) best = Math.min(best, r + 1);
  }
  return best;
}

async function evalEmbedder(emb: Embedder, docs: Doc[], qs: QGold[]) {
  const docVecs = new Map<number, number[]>();
  for (const d of docs) docVecs.set(d.id, await emb.embed(d.text));
  const perQ: { q: string; gold: number[]; rank: number; top: number[] }[] = [];
  const ks = [1, 3, 5];
  const recallHit: Record<number, number> = { 1: 0, 3: 0, 5: 0 };
  let mrrSum = 0;
  for (const it of qs) {
    const qv = await emb.embed(it.q);
    const scored = docs
      .map((d) => ({ id: d.id, s: cosine(qv, docVecs.get(d.id)!) }))
      .sort((a, b) => b.s - a.s || a.id - b.id);
    const ranked = scored.map((x) => x.id);
    const rank = bestGoldRank(ranked, it.gold);
    for (const k of ks) if (rank <= k) recallHit[k]++;
    mrrSum += rank === Infinity ? 0 : 1 / rank;
    perQ.push({ q: it.q, gold: it.gold, rank: rank === Infinity ? -1 : rank, top: ranked.slice(0, 5) });
  }
  const n = qs.length;
  return {
    embedder: emb.name, dim: emb.dim, queries: n,
    recall: { "1": +(recallHit[1] / n).toFixed(3), "3": +(recallHit[3] / n).toFixed(3), "5": +(recallHit[5] / n).toFixed(3) },
    mrr: +(mrrSum / n).toFixed(3),
    top1: +(recallHit[1] / n).toFixed(3),
    perQ,
  };
}

async function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = resolve(here, "../../..");
  const qs: QGold[] = (await readFile(resolve(root, "eval/internal/retrieval.jsonl"), "utf8"))
    .split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));

  const pool = getPool();
  const { rows } = await pool.query("select id, title, body from bench.documents order by id");
  const docs: Doc[] = rows.map((r: { id: number; title: string; body: string }) => ({ id: r.id, text: `${r.title} ${r.body}` }));
  if (docs.length === 0) { console.log("recall:eval SKIPPED (bench.documents empty — run gen:bench)"); await closePool(); process.exit(0); }

  // BGE-M3 (semantic). Skip gracefully if the model is unreachable.
  const bge = new OllamaEmbedder("bge-m3");
  let bgeRes: Awaited<ReturnType<typeof evalEmbedder>> | null = null;
  try { bgeRes = await evalEmbedder(bge, docs, qs); }
  catch (e) { console.log(`bge-m3 unavailable, hash-only: ${(e as Error).message}`); }

  const hash = new HashEmbedder();
  const hashRes = await evalEmbedder(hash, docs, qs);

  await mkdir(resolve(root, "eval/results"), { recursive: true });
  await writeFile(resolve(root, "eval/results/recall-hash.json"), JSON.stringify(hashRes, null, 2));
  if (bgeRes) await writeFile(resolve(root, "eval/results/recall-bge.json"), JSON.stringify(bgeRes, null, 2));

  const fmt = (r: typeof hashRes) => `${r.embedder.padEnd(12)} recall@1=${r.recall["1"]} @3=${r.recall["3"]} @5=${r.recall["5"]} MRR=${r.mrr}`;
  console.log(`\n[recall:eval] corpus=${docs.length} docs, queries=${qs.length} (low-lexical-overlap gold)`);
  console.log(fmt(hashRes));
  if (bgeRes) {
    console.log(fmt(bgeRes));
    const d = (a: number, b: number) => `${a >= b ? "+" : ""}${((a - b) * 100).toFixed(1)}pp`;
    const delta = {
      recall5_pp: +((bgeRes.recall["5"] - hashRes.recall["5"]) * 100).toFixed(1),
      recall1_pp: +((bgeRes.top1 - hashRes.top1) * 100).toFixed(1),
      mrr: +(bgeRes.mrr - hashRes.mrr).toFixed(3),
    };
    console.log(`\nΔ (BGE-M3 − hash): recall@5 ${d(bgeRes.recall["5"], hashRes.recall["5"])}, top1 ${d(bgeRes.top1, hashRes.top1)}, MRR ${delta.mrr >= 0 ? "+" : ""}${delta.mrr}`);
    const thresholds = { recall5_ge15pp: delta.recall5_pp >= 15, mrr_ge0_10: delta.mrr >= 0.10, top1_ge10pp: delta.recall1_pp >= 10 };
    console.log(`thresholds (plan): recall@5≥15pp=${thresholds.recall5_ge15pp} MRR≥0.10=${thresholds.mrr_ge0_10} top1≥10pp=${thresholds.top1_ge10pp}`);
    await writeFile(resolve(root, "eval/results/recall-compare.json"), JSON.stringify({ delta, thresholds, bge: { recall: bgeRes.recall, mrr: bgeRes.mrr }, hash: { recall: hashRes.recall, mrr: hashRes.mrr }, generatedAt: new Date().toISOString(), note: "BGE-M3 vs deterministic hash on identical ranking path; low-lexical-overlap gold; no LLM judge." }, null, 2));
  }
  await closePool();
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
