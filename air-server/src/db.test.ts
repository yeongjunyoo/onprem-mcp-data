// L2 integration tests — hit the live PostgreSQL+pgvector on localhost:5433.
// Run after build: node dist/db.test.js  (requires `docker compose up -d db`).
import { getPool, getReadPool, closePool } from "./db.js";
import { sqlQuery, isReadOnly } from "./sql.js";
import { vectorSearch, embedDocuments } from "./vector.js";
import { HashEmbedder } from "./embedder.js";

let pass = 0, fail = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { pass++; } else { fail++; console.error("  FAIL:", msg); }
}

async function main() {
  const pool = getPool();
  const emb = new HashEmbedder();

  // --- read-only guard (pure, no DB) ---
  ok(isReadOnly("SELECT 1"), "SELECT allowed");
  ok(isReadOnly("  with x as (select 1) select * from x  "), "WITH allowed");
  ok(!isReadOnly("INSERT INTO orders VALUES (1)"), "INSERT rejected");
  ok(!isReadOnly("UPDATE orders SET amount=0"), "UPDATE rejected");
  ok(!isReadOnly("DROP TABLE orders"), "DROP rejected");
  ok(!isReadOnly("SELECT 1; DROP TABLE orders"), "chaining rejected");
  ok(!isReadOnly("delete from orders"), "DELETE rejected");

  // --- sql.query happy path ---
  const cnt = await sqlQuery(pool, "SELECT count(*)::int AS n FROM orders");
  ok(cnt.ok && Number(cnt.rows[0]?.n) === 5, `orders count = 5 (got ${JSON.stringify(cnt.rows)})`);

  const agg = await sqlQuery(pool, "SELECT status, count(*)::int AS n FROM orders GROUP BY status ORDER BY status");
  ok(agg.ok && agg.rows.length === 3, `3 status groups (got ${agg.rows.length})`);
  ok(agg.columns.includes("status") && agg.columns.includes("n"), "columns surfaced");

  // --- sql.query enforces read-only even if guard were bypassed ---
  const bad = await sqlQuery(pool, "UPDATE orders SET amount = 0");
  ok(!bad.ok && !!bad.error, "write blocked by sql.query");
  const stillFive = await sqlQuery(pool, "SELECT count(*)::int AS n FROM orders WHERE amount = 0");
  ok(stillFive.ok && Number(stillFive.rows[0]?.n) === 0, "no rows were mutated");

  // --- privilege boundary: under mcp_ro, superuser-only file funcs are rejected ---
  const fileRead = await sqlQuery(pool, "SELECT pg_read_file('/etc/hostname') AS leak");
  ok(!fileRead.ok && !!fileRead.error, `superuser file read blocked (got ${JSON.stringify(fileRead.rows)})`);
  const normal = await sqlQuery(pool, "SELECT 1 AS one");
  ok(normal.ok && Number(normal.rows[0]?.one) === 1, "normal SELECT still works under mcp_ro");

  // --- vector.search needs embeddings backfilled ---
  const n = await embedDocuments(pool, emb);
  ok(n === 3, `embedded 3 docs (got ${n})`);

  const r = await vectorSearch(pool, emb, "환불 정책 알려줘", 3);
  ok(r.ok && r.hits.length === 3, `3 hits (got ${r.hits.length})`);
  ok(r.hits[0]?.title === "환불 정책", `refund doc ranks first (got ${r.hits[0]?.title})`);
  ok(r.hits.every((h) => h.score >= -1.0001 && h.score <= 1.0001), "scores are valid cosine values");

  // determinism: identical query -> identical ranking + scores
  const a = JSON.stringify((await vectorSearch(pool, emb, "환불 정책 알려줘", 3)).hits);
  const b = JSON.stringify((await vectorSearch(pool, emb, "환불 정책 알려줘", 3)).hits);
  ok(a === b, "vector.search is deterministic");

  // --- cluster read-endpoint pool: fallback + distinct-replica routing ---
  delete process.env.READ_DATABASE_URL;
  ok(getReadPool() === pool, "READ_DATABASE_URL unset -> read pool falls back to primary");
  process.env.READ_DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5433/mcpdata";
  const rp = getReadPool();
  ok(rp !== pool, "READ_DATABASE_URL set -> distinct read pool created");
  const onRead = await sqlQuery(rp, "SELECT count(*)::int AS n FROM orders");
  ok(onRead.ok && Number(onRead.rows[0]?.n) === 5, "read pool serves SELECT (count=5)");
  delete process.env.READ_DATABASE_URL;

  await closePool();
  console.log(`\ndb.test: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
