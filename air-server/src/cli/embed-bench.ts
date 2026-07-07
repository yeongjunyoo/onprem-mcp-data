// WS-C — backfill bench.documents.embedding with the configured embedder.
//   EMBEDDER=ollama EMBED_MODEL=bge-m3  -> real semantic embeddings (demo/eval headline)
//   (default hash)                       -> offline deterministic CI fallback
// Records embedder metadata so the report can cite model/dim/count.
// Run: EMBEDDER=ollama npm run embed:bench
import { getPool, closePool } from "../db.js";
import { getEmbedder } from "../embedder.js";
import { embedDocuments } from "../vector.js";

async function main() {
  const pool = getPool();
  const emb = getEmbedder();
  const t0 = Date.now();
  const n = await embedDocuments(pool, emb, "bench.documents");
  const dimRow = await pool.query<{ d: number }>(
    "SELECT vector_dims(embedding) AS d FROM bench.documents WHERE embedding IS NOT NULL LIMIT 1",
  );
  const dim = dimRow.rows[0]?.d;
  const meta = {
    embedder: emb.name,
    dim,
    docs: n,
    ms_total: Date.now() - t0,
    ollama_host: process.env.OLLAMA_HOST ?? "http://localhost:11434",
    embed_model: process.env.EMBED_MODEL ?? "bge-m3",
  };
  console.log(`embed:bench ${JSON.stringify(meta)}`);
  if (dim !== 1024) {
    console.error(`FAIL: expected dim 1024, got ${dim}`);
    process.exit(1);
  }
  await closePool();
}

main().catch((e) => { console.error(e); process.exit(1); });
