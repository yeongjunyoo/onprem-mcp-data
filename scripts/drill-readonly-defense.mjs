// 2층 방어(READ ONLY 트랜잭션)를 **1층을 뚫은 상태에서** 확인한다.
//
// `sql.ts` 주석은 defense in depth 를 주장한다 — "even a guard bypass cannot
// mutate data". 그건 **주장이었고**, 1층 문자열 가드를 실제로 우회해 보기 전에는
// 검증된 적이 없었다. 층을 둘 쌓아 놓고 위층만 시험하면 아래층은 장식이다.
//
// 이 드릴은 가드를 거치지 않고 풀에 직접 파괴적 SQL 을 보낸 뒤, **데이터가 실제로
// 그대로인지** 행 수로 확인한다. 서버가 뭐라 답했는지가 아니라 데이터를 본다.
//
// 실측(2026-08-17): orders 5행 → DELETE 시도 → 5행. 트랜잭션이 막았다.
//
// 실행: node scripts/drill-readonly-defense.mjs
// 필요: docker compose up -d (DB), npm run gen:bench 로 시드 적재
import { getReadPool } from "../air-server/dist/db.js";

const DESTRUCTIVE = [
  "DELETE FROM orders",
  "UPDATE orders SET amount = 0",
  "INSERT INTO orders (id, user_id, status, amount) VALUES (999999, 1, 'paid', 1)",
];

const pool = getReadPool();

async function countOrders() {
  const r = await pool.query("SELECT count(*)::int AS n FROM orders");
  return r.rows[0].n;
}

const before = await countOrders();
console.log(`드릴 전 orders: ${before}행`);

const leaked = [];
for (const sql of DESTRUCTIVE) {
  const client = await pool.connect();
  try {
    // 1층(isReadOnly)을 **일부러 건너뛴다.** 그게 이 드릴의 요점이다.
    await client.query("BEGIN TRANSACTION READ ONLY");
    await client.query(sql);
    await client.query("COMMIT");
    leaked.push(`${sql} — 예외 없이 통과했다`);
    console.log(`  ${sql.slice(0, 40).padEnd(42)} ★ 통과함`);
  } catch (e) {
    const msg = String(e.message ?? e).split("\n")[0];
    console.log(`  ${sql.slice(0, 40).padEnd(42)} 차단: ${msg.slice(0, 60)}`);
    try {
      await client.query("ROLLBACK");
    } catch {
      /* 트랜잭션이 이미 끝났다 */
    }
  } finally {
    client.release();
  }
}

const after = await countOrders();
console.log(`드릴 후 orders: ${after}행`);
await pool.end();

if (before !== after) {
  console.error(`\n실패: 데이터가 바뀌었다 (${before} -> ${after}). 2층 방어가 없다.`);
  process.exit(1);
}
if (leaked.length) {
  console.error(`\n실패: 파괴적 문장이 예외 없이 통과했다:\n  - ${leaked.join("\n  - ")}`);
  process.exit(1);
}

console.log("\nOK: 1층 가드를 건너뛰어도 트랜잭션이 데이터를 지킨다.");
console.log("    (층을 둘 쌓아 놓고 위층만 시험하면 아래층은 장식이다.)");
process.exit(0);
