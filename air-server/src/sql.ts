// L2 — SQL tool (faithful "execute_sql" MCP primitive over PostgreSQL).
//
// Safety is the headline (operational stability), so reads are enforced two ways:
//   1. a cheap string guard rejects anything that is not a single SELECT/WITH, and
//   2. execution happens inside a READ ONLY transaction that is always rolled back,
//      so even a guard bypass cannot mutate data (defense in depth).
// Returned rows are capped so a broad query cannot flood the 7B context window.

import type { Pool } from "./db.js";
import type { PoolClient } from "pg";

export const MAX_ROWS = 200;

export interface SqlResult {
  ok: boolean;
  rows: Record<string, unknown>[];
  rowCount: number;
  columns: string[];
  truncated: boolean;
  error?: string;
}

const READONLY_START = /^\s*(select|with)\b/i;

/** Strip SQL comments and surrounding whitespace / trailing semicolon. */
function normalize(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ") // block comments
    .replace(/--[^\n]*/g, " ") // line comments
    .trim()
    .replace(/;\s*$/, "");
}

/** Reject obvious non-read statements before touching the DB. */
export function isReadOnly(sql: string): boolean {
  const s = normalize(sql);
  if (!READONLY_START.test(s)) return false;
  if (s.includes(";")) return false; // no statement chaining
  return true;
}
// Cache whether the least-privilege role exists (checked once per process).
let roRole: boolean | undefined;
async function hasRoRole(client: PoolClient): Promise<boolean> {
  if (roRole === undefined) {
    const r = await client.query("SELECT 1 FROM pg_roles WHERE rolname = 'mcp_ro'");
    roRole = (r.rowCount ?? 0) > 0;
  }
  return roRole;
}

export async function sqlQuery(pool: Pool, sql: string): Promise<SqlResult> {
  if (!isReadOnly(sql)) {
    return {
      ok: false,
      rows: [],
      rowCount: 0,
      columns: [],
      truncated: false,
      error: "rejected: only a single read-only SELECT/WITH query is allowed",
    };
  }
  const text = normalize(sql);
  const client = await pool.connect();
  try {
    // Check role existence BEFORE the tx (a failed stmt inside a tx aborts it).
    const useRole = await hasRoRole(client);
    await client.query("BEGIN TRANSACTION READ ONLY");
    // Drop to the least-privilege role + bound time/locks for THIS statement only.
    // SET LOCAL is transaction-scoped and reverts on ROLLBACK. mcp_ro is NOT a
    // superuser, so pg_read_file/pg_ls_dir and any write are rejected by the DB.
    if (useRole) await client.query("SET LOCAL ROLE mcp_ro");
    await client.query("SET LOCAL statement_timeout = '8s'");
    await client.query("SET LOCAL lock_timeout = '2s'");
    const res = await client.query(text);
    await client.query("ROLLBACK");
    const all = res.rows as Record<string, unknown>[];
    const truncated = all.length > MAX_ROWS;
    return {
      ok: true,
      rows: truncated ? all.slice(0, MAX_ROWS) : all,
      rowCount: res.rowCount ?? all.length,
      columns: res.fields?.map((f) => f.name) ?? [],
      truncated,
    };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore rollback error */
    }
    return {
      ok: false,
      rows: [],
      rowCount: 0,
      columns: [],
      truncated: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    client.release();
  }
}
