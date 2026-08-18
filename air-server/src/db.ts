// L1/L2 substrate glue: a single shared node-postgres pool.
//
// The pool is created once and stashed on the air server's global `state` so
// every tool reuses one connection pool (fewer sockets = fewer failure points).
// DATABASE_URL is supplied by docker-compose inside the network
// (postgresql://postgres:postgres@db:5432/mcpdata); on the host (dev/tests) it
// defaults to the published port 5433.

import pg from "pg";

const { Pool } = pg;
export type Pool = pg.Pool;

const DEFAULT_URL = "postgresql://postgres:postgres@localhost:5433/mcpdata";

let shared: pg.Pool | undefined;
let readShared: pg.Pool | undefined;

/** 연결 실패를 사람 말로 바꾼다.
 *
 * 2026-08-18 전제 스윕: DB 가 없을 때 `fault:inject` 는 원시 `AggregateError
 * [ECONNREFUSED]` 를, `test:integration` 은 `FAIL: orders count = 5 (got [])` 를
 * 냈다. 앞은 원인을 안 말하고 뒤는 **데이터 버그처럼 보인다** — 둘 다 사람을
 * 엉뚱한 곳으로 보낸다.
 *
 * 진입점마다 문구를 복사하면 갈린다(오늘 사본 드리프트를 세 번 봤다). 여기 한 겹을
 * 두면 앞으로 생길 진입점까지 덮는다.
 */
/** 접속 문자열에서 **자격증명을 지우고** host:port/db 만 남긴다.
 *
 * 2026-08-18 리뷰 지적: 이 오류는 `vectorSearch` 같은 catch-and-return 경로를 타고
 * **MCP 응답과 감사 로그**로 나간다. `postgresql://user:password@host/db` 를 그대로
 * 넣으면 비밀번호가 로그에 남는다 — 보안을 파는 저장소에서 있을 수 없다.
 */
function safeEndpoint(raw: string | undefined): string {
  if (!raw) return "(주소 미설정)";
  try {
    const u = new URL(raw);
    const db = u.pathname.replace(/^\//, "") || "(db 미지정)";
    return `${u.hostname}:${u.port || "5432"}/${db}`;
  } catch {
    return "(주소 형식 불명)";
  }
}

function explainConnection(e: unknown, endpoint?: string): Error {
  // AggregateError 는 message 가 비어 있고 원인이 errors[] 안에 있다 —
  // 2026-08-18 에 fault:inject 가 정확히 그 모양으로 새어 나갔다.
  const parts: string[] = [];
  const walk = (x: unknown, depth = 0) => {
    if (depth > 3 || !x) return;
    if (x instanceof Error) {
      if (x.message) parts.push(x.message);
      const agg = (x as { errors?: unknown[] }).errors;
      if (Array.isArray(agg)) for (const sub of agg) walk(sub, depth + 1);
      if ((x as { cause?: unknown }).cause) walk((x as { cause?: unknown }).cause, depth + 1);
    } else {
      parts.push(String(x));
    }
  };
  walk(e);
  const msg = parts.join(" | ") || String(e);
  // `does not exist` 는 **테이블/스키마 부재**이기도 하다 — 이 저장소는 그 상황을
  // 일부러 만드는 장애 시나리오가 있다. 2026-08-18 리뷰 + 재현: 없는 테이블을 조회하면
  // "붙지 못했다 ... docker compose up -d" 가 떴다. **연결은 성공했는데** 스택을
  // 띄우라고 말하면 진짜 문제(테이블 부재)를 가린다.
  // 데이터베이스 자체가 없는 경우(`database "x" does not exist`)만 연결 문제로 본다.
  const connIssue = /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|password authentication/i.test(msg)
    || /database "[^"]*" does not exist/i.test(msg);
  if (!connIssue) {
    return e instanceof Error ? e : new Error(msg);
  }
  // 실패한 **그 풀**의 주소를 보여 준다. 리뷰 지적: 읽기 전용 도구가 replica 에서
  // 실패해도 primary 주소를 찍으면 사람을 엉뚱한 곳으로 보낸다.
  const url = safeEndpoint(endpoint ?? process.env.DATABASE_URL);
  return new Error(
    `PostgreSQL 에 붙지 못했다 — ${url}\n` +
      `  스택을 먼저 띄운다: docker compose up -d  (db 5433 / postgres:postgres@mcpdata)\n` +
      `  그다음 데이터를 적재한다: npm run companyx:load  또는  npm run gen:bench\n` +
      `  원본 오류: ${msg}`,
  );
}

/** 풀의 query·connect 를 감싸 연결 실패를 사람 말로 바꾼다.
 *
 * 2026-08-18: 처음엔 `shared.query` 만 감쌌는데 두 곳이 샜다 —
 *   readShared        READ_DATABASE_URL 이 있으면 쓰는 별도 풀
 *   pool.connect()    sql.ts · companyx.ts · companyx-vector-eval.ts 가 쓰는 경로
 * **감싼 것과 덮은 것은 다르다.**
 */
function explainOn(pool: pg.Pool, endpoint: string | undefined): void {
  const q = pool.query.bind(pool) as (...a: unknown[]) => Promise<unknown>;
  pool.query = ((...args: unknown[]) =>
    q(...args).catch((e: unknown) => { throw explainConnection(e, endpoint); })) as typeof pool.query;
  // connect 는 콜백 오버로드가 있어 반환이 Promise 가 아닐 수 있다 —
  // 2026-08-18 실측: 그냥 .catch 를 붙였더니 "Cannot read properties of undefined".
  const c = pool.connect.bind(pool) as (...a: unknown[]) => unknown;
  pool.connect = ((...args: unknown[]) => {
    const r = c(...args);
    return r && typeof (r as Promise<unknown>).catch === "function"
      ? (r as Promise<unknown>).catch((e: unknown) => { throw explainConnection(e, endpoint); })
      : r;
  }) as typeof pool.connect;
}

export function getPool(): pg.Pool {
  if (!shared) {
    shared = new Pool({
      connectionString: process.env.DATABASE_URL ?? DEFAULT_URL,
      max: 8,
      idleTimeoutMillis: 30_000,
      // Bound every statement so a runaway query can never wedge the server.
      statement_timeout: 10_000,
    });
    explainOn(shared, process.env.DATABASE_URL ?? DEFAULT_URL);
  }
  return shared;
}

/**
 * Read-endpoint pool for the cluster topology. When READ_DATABASE_URL points at
 * a read replica, read-only tools route there to offload the primary. When it is
 * unset this transparently FALLS BACK to the primary pool, so a single-node
 * deployment behaves identically with zero config.
 *
 * This is the tested fallback contract — NOT a claim of live WAL replication.
 * "replica/failover" wording requires real replication + kill-drill logs.
 */
export function getReadPool(): pg.Pool {
  const url = process.env.READ_DATABASE_URL;
  if (!url) return getPool(); // fallback: identical instance to the primary
  if (!readShared) {
    readShared = new Pool({
      connectionString: url,
      max: 8,
      idleTimeoutMillis: 30_000,
      statement_timeout: 10_000,
    });
    explainOn(readShared, url);
  }
  return readShared;
}

export async function closePool(): Promise<void> {
  if (shared) {
    await shared.end();
    shared = undefined;
  }
  if (readShared) {
    await readShared.end();
    readShared = undefined;
  }
}
