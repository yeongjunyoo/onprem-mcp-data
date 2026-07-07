// air integration smoke test — drives tools through server.callTool(), which
// runs the full middleware + plugin chain (timeout/retry/circuit-breaker).
// Run after build: node dist/server.test.js  (requires db up + embeddings).
import { buildServer } from "./server.js";
import { getPool, closePool } from "./db.js";
import { embedDocuments } from "./vector.js";
import { getEmbedder } from "./embedder.js";

let pass = 0, fail = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { pass++; } else { fail++; console.error("  FAIL:", msg); }
}

async function main() {
  await embedDocuments(getPool(), getEmbedder()); // ensure vector side is populated
  const server = buildServer();

  const tools = server.tools().map((t) => t.name).sort();
  ok(JSON.stringify(tools) === JSON.stringify(["ask", "graph.expand", "ontology.search", "retrieve", "route", "sql.query", "vector.search"]),
    `tools registered (got ${JSON.stringify(tools)})`);

  const r = JSON.parse(await server.callTool("route", { query: "최근 주문 건수 알려줘" }));
  ok(r.route === "structured" && r.deterministic === true, "route tool via callTool");

  const s = JSON.parse(await server.callTool("sql.query", { sql: "SELECT count(*)::int AS n FROM orders" }));
  ok(s.ok && Number(s.rows[0]?.n) === 5, "sql.query tool via callTool");

  const writeBlocked = JSON.parse(await server.callTool("sql.query", { sql: "DELETE FROM orders" }));
  ok(!writeBlocked.ok, "sql.query blocks writes via callTool");

  const v = JSON.parse(await server.callTool("vector.search", { query: "환불 정책", k: 2 }));
  ok(v.ok && v.hits.length === 2 && v.hits[0].title === "환불 정책", "vector.search tool via callTool");

  await closePool();
  console.log(`\nserver.test: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
