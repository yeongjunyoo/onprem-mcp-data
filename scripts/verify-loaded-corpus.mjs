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
