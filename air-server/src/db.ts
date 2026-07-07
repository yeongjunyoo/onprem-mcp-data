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

export function getPool(): pg.Pool {
  if (!shared) {
    shared = new Pool({
      connectionString: process.env.DATABASE_URL ?? DEFAULT_URL,
      max: 8,
      idleTimeoutMillis: 30_000,
      // Bound every statement so a runaway query can never wedge the server.
      statement_timeout: 10_000,
    });
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
