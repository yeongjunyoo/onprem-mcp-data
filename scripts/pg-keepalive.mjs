#!/usr/bin/env node
// WSL2에서 도는 PostgreSQL은 유휴 상태가 되면 VM째 내려간다(실측 2026-07-29:
// 90초 유휴 후 ECONNREFUSED, 진행 중이던 세션은 57P01로 끊김). 임베딩 백필처럼
// 수 분 동안 DB를 놀리는 평가에서는 그 사이에 연결이 죽어 평가가 통째로 유실된다.
// 그래서 평가를 도는 동안만 옆에서 가벼운 쿼리를 넣어 VM을 깨워 둔다.
//
// 사용: node scripts/pg-keepalive.mjs & (평가 끝나면 kill)
import pg from "pg";

const url = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5433/mcpdata";
const everyMs = Number(process.env.KEEPALIVE_MS ?? 15000);
const pool = new pg.Pool({ connectionString: url, max: 1 });

let fails = 0;
const tick = async () => {
  try {
    await pool.query("SELECT 1");
    fails = 0;
  } catch (e) {
    fails += 1;
    console.error(`[keepalive] ${new Date().toISOString()} ${e.code ?? ""} ${String(e.message).slice(0, 60)}`);
    if (fails >= 20) {
      console.error("[keepalive] 연속 실패 20회, 중단");
      process.exit(1);
    }
  }
};
setInterval(tick, everyMs);
tick();
