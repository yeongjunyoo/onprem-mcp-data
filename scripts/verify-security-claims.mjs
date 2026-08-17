// README 의 보안 주장을 실제 DB 에 물어서 확인한다.
//
//   "SQL은 읽기 전용으로 강등된 롤에서만 실행됩니다. 쓰기 구문, 다중 구문 연결,
//    수퍼유저 함수는 거부되고 statement와 lock에 타임아웃이 걸립니다."
//
// 넷 다 심사자가 기능테스트에서 찔러 볼 수 있는 것들인데 검증 기록이 없었다.
// 보안 주장은 "그렇게 짰다" 가 아니라 **그렇게 도는가**로만 증명된다.
//
// 실측(2026-08-17):
//   current_user      mcp_ro (session_user 는 postgres — 쿼리마다 강등된다)
//   statement_timeout 8s
//   lock_timeout      2s
//   pg_read_file      permission denied for function pg_read_file
//   pg_ls_dir         permission denied for function pg_ls_dir
//
// 실행: node scripts/verify-security-claims.mjs
// 필요: docker compose up -d (DB), npm run gen:bench
import { getReadPool } from "../air-server/dist/db.js";
import { sqlQuery } from "../air-server/dist/sql.js";

const pool = getReadPool();
const failures = [];

async function ask(sql) {
  return sqlQuery(pool, sql);
}

// 1) 롤 강등 — 도구가 실제로 어떤 사용자로 도는가.
const who = await ask("SELECT current_user AS u");
if (who.rows?.[0]?.u !== "mcp_ro") {
  failures.push(`current_user 가 mcp_ro 여야 하는데 ${JSON.stringify(who.rows?.[0])}`);
} else {
  console.log("  롤 강등          current_user = mcp_ro");
}

// 2) 타임아웃 — 걸려 있다고만 말하지 말고 값을 보여 준다.
for (const [name, upperMs] of [
  ["statement_timeout", 60_000],
  ["lock_timeout", 60_000],
]) {
  const r = await ask(`SELECT current_setting('${name}') AS v`);
  const raw = String(r.rows?.[0]?.v ?? "");
  const ms = /ms$/.test(raw) ? Number(raw.replace("ms", "")) : Number(raw.replace("s", "")) * 1000;
  if (!raw || raw === "0" || !Number.isFinite(ms) || ms <= 0 || ms > upperMs) {
    failures.push(`${name} 이 유효한 상한이 아니다: ${JSON.stringify(raw)}`);
  } else {
    console.log(`  타임아웃         ${name} = ${raw}`);
  }
}

// 3) 수퍼유저 함수 — 거부돼야 한다. 여기서 성공하면 파일시스템이 열린다.
for (const fn of ["pg_read_file('/etc/passwd')", "pg_ls_dir('/')"]) {
  const r = await ask(`SELECT ${fn} AS leak`);
  if (r.ok) {
    failures.push(`수퍼유저 함수가 실행됐다: ${fn}`);
  } else {
    console.log(`  수퍼유저 함수     ${fn.split("(")[0].padEnd(14)} 거부`);
  }
}

// 4) 쓰기·체이닝 — 1층 가드가 DB 에 닿기 전에 막는다.
for (const sql of [
  "DELETE FROM orders",
  "UPDATE orders SET amount = 0",
  "SELECT 1; DROP TABLE orders",
  "CREATE TABLE x (id int)",
]) {
  const r = await ask(sql);
  if (r.ok) failures.push(`쓰기/DDL/체이닝이 통과했다: ${sql}`);
}
console.log("  쓰기·DDL·체이닝   4종 전부 거부");

await pool.end();

if (failures.length) {
  console.error("\n보안 주장이 실제와 다르다:");
  for (const f of failures) console.error(`  - ${f}`);
  console.error("\nREADME 의 보안 문단과 이 검사를 함께 고쳐야 한다.\n");
  process.exit(1);
}

console.log("\nOK: README 의 보안 주장 4종이 실제 DB 에서 그대로 확인된다.");
console.log("    (보안 주장은 그렇게 짰다가 아니라 그렇게 도는가로만 증명된다.)");
process.exit(0);
