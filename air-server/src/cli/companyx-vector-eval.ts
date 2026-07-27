// Vector lane eval on the sponsor's 40-document corpus.
//
// Oracle = a deterministic LEXICAL rule over the raw Markdown (see
// eval/companyx/vector_gold.json) plus the document type declared in the sponsor's
// index.json. The retriever only ever sees the natural-language question, so the
// oracle is independent of the system under test.
//
// Metrics per question: hit@k on the gold document set, and type accuracy of the
// retrieved chunks. Runs head-to-head between the offline hash embedder and
// BGE-M3, so the report can state what the real embedding model actually buys on
// THIS corpus instead of citing a generic benchmark.
//
// Run: EMBEDDER=ollama npm run companyx:vector
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPool, closePool } from "../db.js";
import { HashEmbedder, OllamaEmbedder, type Embedder } from "../embedder.js";
import { vectorSearch } from "../vector.js";
import { embedCompanyXChunks, datasetDir, CX_SCHEMA } from "../companyx.js";

interface GoldItem {
  q: string;
  type: string | null;
  keywords: string[];
}

async function main() {
  const dir = datasetDir();
  const here = dirname(fileURLToPath(import.meta.url));
  const root = resolve(here, "../../..");
  const goldFile = JSON.parse(await readFile(resolve(root, "eval/companyx/vector_gold.json"), "utf8")) as {
    oracle: string;
    items: GoldItem[];
  };

  // Raw corpus for the lexical oracle.
  const index: { id: string; type: string; filename: string }[] = JSON.parse(
    await readFile(join(dir, "documents", "index.json"), "utf8"),
  );
  const text = new Map<string, string>();
  const typeOf = new Map<string, string>();
  for (const e of index) {
    text.set(e.id, (await readFile(join(dir, "documents", e.filename), "utf8")).toLowerCase());
    typeOf.set(e.id, e.type);
  }
  const goldDocs = (item: GoldItem): string[] =>
    item.keywords.length
      ? index.map((e) => e.id).filter((id) => item.keywords.every((kw) => text.get(id)!.includes(kw.toLowerCase())))
      : [];

  const pool = getPool();
  const k = Number(process.env.CX_TOPK ?? 5);
  const embedders: Embedder[] = [new HashEmbedder()];
  if (process.env.EMBEDDER === "ollama" || process.env.CX_COMPARE === "1") embedders.push(new OllamaEmbedder());

  const results: Record<string, unknown> = {};
  for (const emb of embedders) {
    // Each embedder needs the corpus embedded with ITS OWN vectors.
    const backfill = await embedCompanyXChunks(pool, emb, CX_SCHEMA);
    const rows = [];
    let hits = 0,
      scoredHit = 0,
      typeSum = 0,
      typeScored = 0;
    for (const item of goldFile.items) {
      const res = await vectorSearch(pool, emb, item.q, k, `${CX_SCHEMA}.documents`);
      if (!res.ok) throw new Error(`vector search failed: ${res.error}`);
      // chunk title is "<doc title> — <section>"; recover the doc id via the chunk row
      const ids = await pool.query<{ id: number; doc_id: string }>(
        `SELECT id, doc_id FROM ${CX_SCHEMA}.document_chunks WHERE id = ANY($1::int[])`,
        [res.hits.map((h) => h.id)],
      );
      const docOf = new Map(ids.rows.map((r) => [r.id, r.doc_id]));
      const retrieved = res.hits.map((h) => docOf.get(h.id)!).filter(Boolean);
      const gold = goldDocs(item);
      const hit = gold.length ? retrieved.some((d) => gold.includes(d)) : null;
      if (hit !== null) {
        scoredHit++;
        if (hit) hits++;
      }
      let typeAcc: number | null = null;
      if (item.type) {
        typeAcc = retrieved.filter((d) => typeOf.get(d) === item.type).length / Math.max(1, retrieved.length);
        typeSum += typeAcc;
        typeScored++;
      }
      rows.push({
        q: item.q,
        gold_n: gold.length,
        gold,
        retrieved,
        top_scores: res.hits.map((h) => Number(h.score.toFixed(3))),
        [`hit@${k}`]: hit,
        expected_type: item.type,
        type_precision: typeAcc === null ? null : Number(typeAcc.toFixed(2)),
      });
      console.log(
        `[${emb.name}] ${hit === null ? "----" : hit ? "HIT " : "MISS"} type_p=${typeAcc?.toFixed(2) ?? "-"} :: ${item.q}`,
      );
    }
    results[emb.name] = {
      embedder: emb.name,
      dim: backfill.dim,
      chunks: backfill.updated,
      [`hit@${k}`]: scoredHit ? Number((hits / scoredHit).toFixed(3)) : null,
      scored_questions: scoredHit,
      mean_type_precision: typeScored ? Number((typeSum / typeScored).toFixed(3)) : null,
      rows,
    };
  }

  const out = {
    dataset: "companyx-dataset-v1.0 / documents (40 docs, 258 chunks)",
    top_k: k,
    oracle: goldFile.oracle,
    summary: Object.fromEntries(
      Object.entries(results).map(([name, r]) => {
        const v = r as Record<string, unknown>;
        return [name, { [`hit@${k}`]: v[`hit@${k}`], mean_type_precision: v.mean_type_precision, dim: v.dim }];
      }),
    ),
    detail: results,
    generated_at: new Date().toISOString(),
  };
  await mkdir(resolve(root, "eval/results"), { recursive: true });
  await writeFile(resolve(root, "eval/results/companyx-vector.json"), JSON.stringify(out, null, 2) + "\n");
  console.log(`\ncompanyx:vector ${JSON.stringify(out.summary, null, 2)}`);
  await closePool();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
