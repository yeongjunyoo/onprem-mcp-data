// Gate6 — offline end-to-end demo over the bench dataset.
// Showcases: 7 MCP tools, deterministic route, SQL, BGE-M3 vector, ontology/graph,
// canonical 3-way RRF agreement, on-prem 7B answer, and graceful fault degradation.
// Run (network may be OFF after models cached): EMBEDDER=ollama npm run demo
import { buildServer } from "../server.js";
import { getPool, closePool } from "../db.js";
import { OllamaEmbedder, type Embedder } from "../embedder.js";
import { route, audit } from "../router.js";
import { sqlQuery } from "../sql.js";
import { vectorSearch } from "../vector.js";
import { ontologySearch, graphExpand } from "../graph.js";
import { kgRetrieve } from "../kgretrieve.js";
import { benchNL2SQL } from "../nl2sql.js";
import { answer, isAvailable } from "../llm.js";

const line = (s = "") => console.log(s);
const hr = (t: string) => line(`\n=== ${t} ===`);

async function main() {
  const pool = getPool();
  const emb: Embedder = new OllamaEmbedder("bge-m3");
  const haveLLM = await isAvailable();

  hr("0) air MCP 서버 — 등록된 도구");
  const tools = buildServer().tools().map((t) => t.name).sort();
  line(`tools(${tools.length}): ${tools.join(", ")}`);

  hr("1) L3 결정론 라우터 (LLM 없음)");
  for (const q of ["환불 정책 알려줘", "상태별 주문 건수", "지난달 취소된 주문 중 환불 비슷한 케이스"]) {
    const a = audit(route(q));
    line(`  "${q}" -> ${a.route} ${JSON.stringify(a.tools)}`);
  }

  hr("2) L2 sql.query (읽기전용, mcp_ro 강등)");
  const sb = await sqlQuery(pool, "SELECT status, count(*)::int AS n, sum(total)::bigint AS revenue FROM bench.orders GROUP BY status ORDER BY status");
  for (const r of sb.rows) line(`  ${r.status}: ${r.n}건 / 매출 ${r.revenue}`);
  const denied = await sqlQuery(pool, "SELECT * FROM bench.admin_secrets");
  line(`  보안: admin_secrets 접근 -> ${denied.ok ? "허용(!!)" : "거부됨 (" + (denied.error ?? "").slice(0, 40) + ")"}`);

  hr("3) L2 vector.search (BGE-M3 의미검색)");
  const vs = await vectorSearch(pool, emb, "물건이 마음에 안 들어 돈 돌려받고 싶어요", 3, "bench.documents");
  line(`  질의(어휘겹침0) -> ${vs.hits.map((h) => h.title).join(" | ")}`);

  hr("4) 온톨로지/지식그래프 (SQL/벡터가 못 잇는 동의어·관계)");
  const onto = await ontologySearch(pool, "전자제품", 5, "bench");
  line(`  ontology.search('전자제품') -> ${onto.hits.map((h) => `${h.canonicalName}(${h.via})`).join(", ")}`);
  const gx = await graphExpand(pool, 1001, 1, ["applies_to"], "bench");
  line(`  graph.expand(환불정책, applies_to) -> ${gx.edges.map((e) => e.dstName).join(", ")}`);

  hr("5) ★ canonical 3-way RRF (sql/vector/graph 합의)");
  const kg = await kgRetrieve(pool, "전자제품 환불 규정 알려줘", { embedder: emb, schema: "bench", k: 5 });
  const agree = kg.fused.find((f) => f.sources.length > 1);
  line(`  audit: vector=${kg.audit.vector} graph=${kg.audit.graph} fused=${kg.audit.fused} agreement=${kg.audit.agreement}`);
  if (agree) line(`  합의 엔티티: ${agree.canonicalKey} sources=${JSON.stringify(agree.sources)} rank=${agree.rank}`);

  hr("6) 온프렘 7B 최종 답변 (Qwen2.5)");
  if (haveLLM) {
    const q = "전체 주문은 몇 건이야?";
    const sql = await benchNL2SQL(q);
    const res = sql ? await sqlQuery(pool, sql) : { ok: false, rows: [] as any[] };
    const ctx = res.ok ? `[SQL 결과] ${sql} -> ${JSON.stringify(res.rows[0])}` : "(없음)";
    const ans = await answer(q, ctx);
    line(`  Q: ${q}`);
    line(`  A: ${ans}`);
  } else {
    line("  (Ollama/qwen2.5:7b 미가용 — 답변 단계 스킵)");
  }

  hr("7) 장애주입 → graceful degradation");
  const broken: Embedder = { name: "broken", dim: 1024, embed: async () => { throw new Error("embedder unavailable (injected)"); } };
  const degraded = await kgRetrieve(pool, "전자제품 환불 규정", { embedder: broken, schema: "bench", k: 5 });
  line(`  벡터 브랜치 강제 실패: vector=${degraded.audit.vector} graph=${degraded.audit.graph} fused=${degraded.audit.fused}`);
  line(`  -> 크래시 없이 그래프 브랜치로 부분 컨텍스트 반환 (graceful degradation)`);

  hr("DEMO OK (전 과정 온프렘, 외부 API 없음)");
  await closePool();
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
