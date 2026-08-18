// WS-C — backfill the active profile's document table with the configured embedder.
//   EMBEDDER=ollama EMBED_MODEL=bge-m3  -> real semantic embeddings (demo/eval headline)
//   (default hash)                       -> offline deterministic CI fallback
// Records embedder metadata so the report can cite model/dim/count.
// Run: EMBEDDER=ollama npm run embed:bench
import { getPool, closePool } from "../db.js";
import { getEmbedder } from "../embedder.js";
import { embedDocuments } from "../vector.js";
import { profile } from "../profile.js";

async function main() {
  const pool = getPool();
  const emb = getEmbedder();
  const t0 = Date.now();
  // 대상 테이블을 프로파일에서 가져온다. 박아 두면 남의 코퍼스에 못 쓴다 —
  // 2026-08-18 에 「내 데이터에 붙이기」를 쓰면서 이 CLI 때문에 "임베딩 적재는 안
  // 해 봤다" 고 적어야 했다. **하드코딩된 값은 다시 갈리지만 물어본 값은 안 갈린다.**
  const table = profile().vectorTable;
  const n = await embedDocuments(pool, emb, table);
  const dimRow = await pool.query<{ d: number }>(
    `SELECT vector_dims(embedding) AS d FROM ${table} WHERE embedding IS NOT NULL LIMIT 1`,
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
