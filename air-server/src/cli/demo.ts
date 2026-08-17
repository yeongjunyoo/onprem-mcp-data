// Gate6 — offline end-to-end demo over the bench dataset.
// Showcases: 7 MCP tools, deterministic route, SQL, BGE-M3 vector, ontology/graph,
// canonical 3-way RRF agreement, on-prem 7B answer, and graceful fault degradation.
// Run (network may be OFF after models cached): EMBEDDER=ollama npm run demo
import { buildServer } from "../server.js";
import { probeOllama, reportOllama } from "../preflight.js";
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

  // ── 프로파일 게이트 ─────────────────────────────────────────────────
  //
  // 이 데모는 bench 시드 전용이다. 질의도 테이블도 bench에 하드코딩돼 있다.
  // 그런데 DATASET=companyx로 실행해도 조용히 bench 숫자를 찍고 DEMO OK로 끝났다.
  // 활성 프로파일과 실제로 조회하는 데이터가 다르면 그 출력은 거짓말이다.
  {
    const requested = process.env.DATASET;
    if (requested && requested !== "bench") {
      console.error(
        `\n이 데모는 bench 시드 전용인데 DATASET=${requested} 로 실행됐다.\n` +
          "  질의와 테이블이 bench에 고정돼 있어 다른 프로파일의 데이터를 보여주지 못한다.\n\n" +
          "  DATASET을 지우고 실행하거나, 해당 데이터셋 전용 평가 CLI를 쓴다:\n" +
          `    DATASET=${requested} node dist/cli/companyx-ask-eval.js\n`,
      );
      process.exit(1);
    }
  }

  // ── 환경 프리플라이트 ───────────────────────────────────────────────
  //
  // 어느 Ollama에 붙었는지 먼저 밝힌다. 호스트와 컨테이너가 둘 다 있을 때
  // 조용히 엉뚱한 쪽에 붙는 사고를 막는다(docker-compose.yml의 11435 주석 참조).
  {
    const need = [process.env.OLLAMA_MODEL ?? "qwen2.5:7b"];
    if ((process.env.EMBEDDER ?? "") === "ollama") need.push(process.env.EMBED_MODEL ?? "bge-m3");
    const probe = await probeOllama();
    if (!reportOllama(probe, need)) process.exit(1);
  }

  // ── 기반 데이터 확인 게이트 ─────────────────────────────────────────
  //
  // 시드 데이터가 없으면 모든 레인이 0건을 돌려주는데, 그래도 아래 흐름은 끝까지
  // 돌아 "DEMO OK"를 찍는다. 저장소를 clone한 심사자가 준비 명령을 건너뛰면
  // 텅 빈 데모가 성공했다고 말하게 된다. 거짓 성공은 실패보다 나쁘므로 여기서 막는다.
  {
    const need: string[] = [];
    const count = async (sql: string): Promise<number> => {
      const r = await sqlQuery(pool, sql);
      return r.ok && r.rows.length ? Number(r.rows[0].n) : 0;
    };
    const orders = await count("SELECT count(*)::int AS n FROM bench.orders");
    if (orders === 0) need.push("npm run gen:bench");
    const embedded = await count(
      "SELECT count(*)::int AS n FROM bench.documents WHERE embedding IS NOT NULL",
    );
    if (embedded === 0) need.push("EMBEDDER=ollama npm run embed:bench");

    if (need.length) {
      console.error("\n데모를 실행할 기반 데이터가 없다. 아래를 먼저 실행한다:\n");
      for (const c of need) console.error(`  ${c}`);
      console.error(
        "\n(PostgreSQL이 떠 있어야 한다: docker compose up -d db)\n" +
          `실측: bench.orders=${orders}행, 임베딩된 문서=${embedded}건\n`,
      );
      process.exit(1);
    }
    line(`기반 데이터 확인: bench.orders ${orders}행, 임베딩된 문서 ${embedded}건`);
  }

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
