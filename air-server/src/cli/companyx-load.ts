// Load the sponsor (리원에이스) CompanyX dataset into PostgreSQL and, unless
// SKIP_EMBED=1, backfill the chunk embeddings with the configured embedder.
//
//   npm run companyx:load                       # hash embedder (offline, deterministic)
//   EMBEDDER=ollama npm run companyx:load       # BGE-M3 via local Ollama
//
// Writes eval/results/companyx-load.json so the report can cite exact counts.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getPool, closePool } from "../db.js";
import { getEmbedder } from "../embedder.js";
import { loadCompanyX, embedCompanyXChunks, datasetDir, CX_SCHEMA, requireDataset } from "../companyx.js";

async function main() {
  requireDataset();
  const pool = getPool();
  const emb = getEmbedder();
  const t0 = Date.now();
  const report = await loadCompanyX(pool, { embedDim: emb.dim, dir: datasetDir() });
  const loadMs = Date.now() - t0;

  let embedded = { updated: 0, dim: 0 };
  let embedMs = 0;
  if (process.env.SKIP_EMBED !== "1") {
    const t1 = Date.now();
    embedded = await embedCompanyXChunks(pool, emb, CX_SCHEMA);
    embedMs = Date.now() - t1;
  }

  const out = {
    dataset: "companyx-dataset-v1.0",
    sha256: "3008476738d992857d738337b4882772e88288f7b314da235d6a5d120827d772",
    source: "https://liwonace.co.kr/blog/9",
    ...report,
    embedder: emb.name,
    embedded_chunks: embedded.updated,
    embedding_dim_actual: embedded.dim || report.embeddingDim,
    ms_load: loadMs,
    ms_embed: embedMs,
    generated_at: new Date().toISOString(),
  };

  const here = dirname(fileURLToPath(import.meta.url));
  const outPath = resolve(here, "..", "..", "..", "eval", "results", "companyx-load.json");
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(out, null, 2) + "\n", "utf-8");

  console.log(`companyx:load ${JSON.stringify(out, null, 2)}`);
  const rowTotal = Object.entries(report.tables)
    .filter(([t]) => t !== "document_chunks")
    .reduce((s, [, n]) => s + n, 0);
  if (rowTotal !== 818) {
    console.error(`FAIL: expected 818 relational rows, got ${rowTotal}`);
    process.exit(1);
  }
  if (report.entities !== 133 || report.relations !== 354) {
    console.error(`FAIL: expected 133 nodes / 354 edges, got ${report.entities}/${report.relations}`);
    process.exit(1);
  }
  await closePool();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
