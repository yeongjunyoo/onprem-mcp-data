// 적재된 코퍼스가 문서가 말하는 규모인지 DB 에 물어 확인한다.
//
// 문서는 "8테이블 818행 / 문서 40건에서 258청크 / 그래프 133노드 354엣지" 라고
// 여러 곳에서 말한다. 그 수는 **적재 결과 파일**에서 왔고, 지금 DB 에 실제로 그만큼
// 있는지는 아무도 안 봤다.
//
// 심사자가 clone -> fetch -> companyx:load 를 밟으면 이 상태가 나와야 하고,
// 안 나오면 그 뒤 모든 수치가 다른 코퍼스에서 나온 값이 된다.
//
// ★ 비교 대상이 둘 다 없으면 어떤 비교든 참이 된다.
//   이 검사를 만들다 존재하지 않는 테이블(kg_nodes)을 물어 스냅샷이 둘 다 null 이
//   됐고, `null === null` 이라 "동일하다" 로 통과했다. 그래서 여기서는 기대값을
//   **명시적으로** 적고 하나라도 어긋나면 실패시킨다.
//
// 실행: node scripts/verify-loaded-corpus.mjs
// 필요: docker compose up -d, npm run companyx:load
import { getReadPool } from "../air-server/dist/db.js";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BUSINESS_TABLES = [
  "departments",
  "employees",
  "clients",
  "products",
  "contracts",
  "projects",
  "sales",
  "support_tickets",
];

// 문서가 주장하는 규모. 바뀌면 문서와 함께 고친다.
const EXPECT = {
  business_tables: 8,
  business_rows: 818,
  documents: 258,
  chunks: 258,
  embed_dim: 768,
  entities: 133,
  relations: 354,
};

const pool = getReadPool();
const one = async (sql) => (await pool.query(sql)).rows[0];

let rows = 0;
try {
  for (const t of BUSINESS_TABLES) {
    rows += (await one(`SELECT count(*)::int AS n FROM companyx.${t}`)).n;
  }
} catch (e) {
  console.error(`\n실패: companyx 스키마를 읽지 못했다 — ${String(e.message).split("\n")[0]}`);
  console.error("  npm run companyx:load 를 먼저 돌린다.\n");
  process.exit(1);
}

const actual = {
  business_tables: BUSINESS_TABLES.length,
  business_rows: rows,
  documents: (await one("SELECT count(*)::int AS n FROM companyx.documents")).n,
  chunks: (await one("SELECT count(*)::int AS n FROM companyx.document_chunks")).n,
  embed_dim:
    (
      await one(
        "SELECT vector_dims(embedding) AS n FROM companyx.document_chunks WHERE embedding IS NOT NULL LIMIT 1",
      )
    )?.n ?? null,
  entities: (await one("SELECT count(*)::int AS n FROM companyx.entities")).n,
  relations: (await one("SELECT count(*)::int AS n FROM companyx.relations")).n,
};

// ── 문서가 말하는 런타임 버전을 살아 있는 스택에 묻는다.
//
// npm 의존성은 package.json 이 정본이라 CI 에서 대조한다. **컨테이너 이미지는
// 파일에 없다** — `pgvector/pgvector:pg16` 은 태그일 뿐 안에 든 확장 버전을 말해
// 주지 않는다. 2026-08-18 실측에서 문서 pgvector 0.6.0 vs 실물 0.8.6,
// 문서 Ollama 0.32.4 vs 실물 0.32.14 로 갈려 있었다.
//
// latest 태그는 계속 움직이므로 문서에는 측정 시점을 함께 적는다.
{
  const ROOT2 = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const pool = getReadPool();
  const q = one;  // 이미 위에서 만든 헬퍼를 쓴다 (도구 증식 금지)
  const pgv = (await q("select extversion v from pg_extension where extname='vector'"))?.v;
  const pgs = (await q("show server_version"))?.server_version?.split(" ")[0];
  let oll = null;
  try {
    const host = process.env.OLLAMA_HOST || "http://localhost:11435";
    oll = (await (await fetch(`${host}/api/version`)).json()).version;
  } catch {
    oll = null; // 모델이 안 떠 있으면 이 항목만 건너뛴다 (조용히 통과시키지 않고 말한다)
  }

  const docs = ["docs/report.md", "docs/submission-report.md", "CONTRIBUTING.md"];
  const seen = [];
  for (const d of docs) {
    const t = readFileSync(resolve(ROOT2, d), "utf8");
    for (const [label, re, real] of [
      ["pgvector", /pgvector (\d+\.\d+\.\d+)/g, pgv],
      ["Ollama", /Ollama (\d+\.\d+\.\d+)/g, oll],
    ]) {
      if (!real) continue;
      for (const m of t.matchAll(re)) {
        seen.push(`${d}: ${label} ${m[1]}`);
        if (m[1] !== real) {
          console.error(`\n실패: ${d} 가 ${label} ${m[1]} 이라 적었는데 실물은 ${real} 이다.`);
          console.error("  latest 태그는 계속 움직인다 — 문서를 실물에 맞추고 측정 시점을 함께 적는다.\n");
          process.exit(1);
        }
      }
    }
  }
  console.log(`런타임 버전: PostgreSQL ${pgs} · pgvector ${pgv} · Ollama ${oll ?? "(미기동)"} — 문서 ${seen.length}곳과 일치.`);
  if (!oll) console.log("  (Ollama 가 안 떠 있어 그 항목은 대조하지 못했다 — 건너뛴 것을 말한다.)");
}

await pool.end();

const drift = [];
for (const [k, want] of Object.entries(EXPECT)) {
  const got = actual[k];
  console.log(`  ${k.padEnd(16)} 문서 ${String(want).padStart(5)}  실제 ${String(got).padStart(5)}`);
  if (got !== want) drift.push(`${k}: 문서는 ${want} 인데 DB 는 ${got}`);
}

if (drift.length) {
  console.error("\n적재된 코퍼스가 문서가 말하는 규모와 다르다:");
  for (const d of drift) console.error(`  - ${d}`);
  console.error("\n이 상태에서 낸 수치는 문서가 말하는 코퍼스의 값이 아니다.\n");
  process.exit(1);
}

console.log("\nOK: 적재된 코퍼스가 문서가 말하는 규모와 일치한다.");
console.log("    (기대값을 명시한다 — 둘 다 없으면 어떤 비교든 참이 되기 때문이다.)");
process.exit(0);
