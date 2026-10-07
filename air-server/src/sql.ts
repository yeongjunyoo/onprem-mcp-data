// Copyright 2026 Yeongjun Yoo
// SPDX-License-Identifier: Apache-2.0
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// L2 — SQL tool (faithful "execute_sql" MCP primitive over PostgreSQL).
//
// Safety is the headline (operational stability), so reads are enforced two ways:
//   1. a cheap string guard rejects anything that is not a single SELECT/WITH, and
//   2. execution happens inside a READ ONLY transaction that is always rolled back,
//      so even a guard bypass cannot mutate data (defense in depth).
// Returned rows are capped so a broad query cannot flood the 7B context window.

import type { Pool } from "./db.js";
import type { PoolClient } from "pg";
import { describeError } from "./errors.js";

export const MAX_ROWS = 200;

export interface SqlResult {
  ok: boolean;
  rows: Record<string, unknown>[];
  rowCount: number;
  columns: string[];
  truncated: boolean;
  error?: string;
}

/** SQL 낱말. w 는 따옴표 없는 이름과 키워드(소문자로), q 는 따옴표 이름(대소문자 그대로), s 는 문자열 값,
 * o 는 그 밖의 기호와 숫자다. at 은 원문에서의 자리. */
export interface SqlToken {
  k: "w" | "q" | "s" | "o" | "(" | ")" | "[" | "]" | "," | ";" | ".";
  v: string;
  at: number;
}

const WORD = /[A-Za-z_\u0080-\uffff][A-Za-z0-9_$\u0080-\uffff]*/y;
const NUMBER = /(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/y;
const DOLLAR_TAG = /\$(?:[A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*)?\$/y;
const PARAM = /\$\d+/y;

/** SQL 을 낱말로 자른다. 주석은 버린다. 닫히지 않은 따옴표, 달러 따옴표, 블록 주석이 있으면 null.
 * 문자열은 standard_conforming_strings = on 으로 읽는다(sqlQuery 가 그 값으로 실행한다). 읽기 전용 가드(isReadOnly)와
 * 생성 SQL 의 구조 판정(nl2sql.ts sqlShape)이 함께 쓴다. */
export function tokenizeSql(sql: string): SqlToken[] | null {
  const out: SqlToken[] = [];
  const n = sql.length;
  const at = (re: RegExp, i: number) => {
    re.lastIndex = i;
    return re.exec(sql)?.[0];
  };
  let i = 0;
  while (i < n) {
    const c = sql[i];
    if (/\s/.test(c)) {
      i++;
    } else if (c === "-" && sql[i + 1] === "-") {
      // PostgreSQL 의 줄 주석은 \n 과 \r 어느 쪽에서도 끝난다. \n 에서만 끊으면 `-- 주석\r; DROP …` 의 뒤를
      // 주석으로 읽어 가드가 두 번째 문장을 못 본다.
      let j = i + 2;
      while (j < n && sql[j] !== "\n" && sql[j] !== "\r") j++;
      i = j;
    } else if (c === "/" && sql[i + 1] === "*") {
      // PostgreSQL 의 블록 주석은 겹칠 수 있다.
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (sql.startsWith("/*", j) || sql.startsWith("*/", j)) {
          depth += sql[j] === "/" ? 1 : -1;
          j += 2;
        } else j++;
      }
      if (depth > 0) return null;
      i = j;
    } else if (c === "'") {
      // E'…' 는 역슬래시 이스케이프를 쓴다. 바로 앞에 붙은 e 는 문자열의 접두사다.
      const prev = out[out.length - 1];
      const escaped = prev?.k === "w" && prev.v === "e" && prev.at + 1 === i;
      let j = i + 1;
      for (;;) {
        if (j >= n) return null;
        if (escaped && sql[j] === "\\") j += 2;
        else if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
        else if (sql[j] === "'") break;
        else j++;
      }
      if (escaped) out.pop();
      out.push({ k: "s", v: sql.slice(i, j + 1), at: escaped ? i - 1 : i });
      i = j + 1;
    } else if (c === '"') {
      let j = i + 1;
      for (;;) {
        if (j >= n) return null;
        if (sql[j] === '"' && sql[j + 1] === '"') j += 2;
        else if (sql[j] === '"') break;
        else j++;
      }
      out.push({ k: "q", v: sql.slice(i + 1, j).replace(/""/g, '"'), at: i });
      i = j + 1;
    } else if (c === "$") {
      const tag = at(DOLLAR_TAG, i);
      const param = tag ? undefined : at(PARAM, i);
      if (tag) {
        const end = sql.indexOf(tag, i + tag.length);
        if (end < 0) return null;
        out.push({ k: "s", v: sql.slice(i, end + tag.length), at: i });
        i = end + tag.length;
      } else {
        out.push({ k: "o", v: param ?? c, at: i });
        i += param?.length ?? 1;
      }
    } else if ("()[],;.".includes(c) && !(c === "." && /\d/.test(sql[i + 1] ?? ""))) {
      out.push({ k: c as SqlToken["k"], v: c, at: i });
      i++;
    } else {
      const word = at(WORD, i);
      const num = word ? undefined : at(NUMBER, i);
      const v = word ?? num ?? c;
      out.push({ k: word ? "w" : "o", v: word ? word.toLowerCase() : v, at: i });
      i += v.length;
    }
  }
  return out;
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

/** 실행할 문장. 읽기 전용 단일 SELECT/WITH 가 아니면 null.
 *
 * 문자열 값, 따옴표 이름, 달러 따옴표, 주석 안의 `;`, `--`, `/*` 는 문장 구조로 읽지 않는다(tokenizeSql). 종전에는
 * 주석과 `;` 를 문자열과 상관없이 찾아 `SELECT ';' AS x` 를 여러 문장으로 거부하고 `SELECT '--' AS x` 를
 * `SELECT '` 로 잘라 실행했다(D7). 문장 끝의 `;` 하나는 떼고, 그 밖에 `;` 가 있으면 여러 문장이라 거부한다. 첫 낱말은
 * 종전 그대로 SELECT 나 WITH 여야 한다. 주석은 지우지 않고 데이터베이스에 그대로 넘긴다(데이터베이스도 주석으로 읽는다).
 * 낱말로 자르지 못하는 문장(닫히지 않은 따옴표, 달러 따옴표, 블록 주석)은 종전 판정과 종전 문장 그대로 둔다 —
 * 데이터베이스가 그 오류를 말한다. */
function readOnlyText(sql: string): string | null {
  const toks = tokenizeSql(sql);
  if (!toks) {
    const s = normalize(sql);
    return READONLY_START.test(s) && !s.includes(";") ? s : null;
  }
  const semis = toks.filter((t) => t.k === ";");
  const last = toks[toks.length - 1];
  if (semis.length > 1 || (semis.length === 1 && semis[0] !== last)) return null; // no statement chaining
  if (!toks.length || !READONLY_START.test(sql.slice(toks[0].at))) return null;
  return (semis.length ? sql.slice(0, last.at) : sql).trim();
}

/** Reject obvious non-read statements before touching the DB. */
export function isReadOnly(sql: string): boolean {
  return readOnlyText(sql) !== null;
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
  const text = readOnlyText(sql);
  if (text === null) {
    return {
      ok: false,
      rows: [],
      rowCount: 0,
      columns: [],
      truncated: false,
      error: "rejected: only a single read-only SELECT/WITH query is allowed",
    };
  }
  // 연결 실패도 결과로 돌려준다. 여기서 예외가 새면 호출부의 가드가 통째로
  // 건너뛰어지고, DB 불통이 "시드 없음" 같은 엉뚱한 진단이나 크래시로 나타난다.
  let client;
  try {
    client = await pool.connect();
  } catch (e) {
    return {
      ok: false,
      rows: [],
      rowCount: 0,
      columns: [],
      truncated: false,
      error: `연결 실패: ${(e as Error).message.split("\n")[0]}`,
    };
  }
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
    // 가드(tokenizeSql)는 문자열을 이 설정으로 읽는다. 서버 기본값이 off 여도 가드와 데이터베이스가 같은 자리에서
    // 문자열을 끝내게 한다(`;` 가 문자열 안에 있다고 본 문장이 데이터베이스에서 두 문장으로 갈리지 않게).
    await client.query("SET LOCAL standard_conforming_strings = on");
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
      error: describeError(err),
    };
  } finally {
    client.release();
  }
}

/** Real column list for the tables a failed SQL referenced — read from the catalogue.
 * Used by the NL2SQL repair path so the model is corrected by the database itself
 * rather than by the same schema card it already ignored. */
export async function columnsForSql(pool: Pool, sql: string, schema: string): Promise<string> {
  const tables = [...new Set([...sql.matchAll(/\b([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)/gi)]
    .filter((m) => m[1].toLowerCase() === schema.toLowerCase())
    .map((m) => m[2].toLowerCase()))];
  if (!tables.length) return "";
  const res = await pool.query<{ table_name: string; cols: string }>(
    `SELECT table_name, string_agg(column_name || ' ' || data_type, ', ' ORDER BY ordinal_position) AS cols
       FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = ANY($2::text[])
      GROUP BY table_name ORDER BY table_name`,
    [schema, tables],
  );
  return res.rows.map((r) => `${schema}.${r.table_name}(${r.cols})`).join("\n");
}
