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

// 스키마 카드를 PostgreSQL 카탈로그 주석(COMMENT ON TABLE, COMMENT ON COLUMN)에서 만든다.
//
// 리원에이스 CTO 서면 답변(2026-10-03, Q5): 카드에는 컬럼의 뜻과 타입만 두고 값 예시는 넣지 않는다. 값 범위는
// 「2020년 이후 날짜」처럼 추상적으로 쓰고, 자주 쓰는 조건은 SQL 로 적는다(미해결 티켓 = status = 'open').
// 운영에서는 이것을 스키마 옆의 COMMENT ON COLUMN 으로 관리하고, 통계(최솟값, 최댓값, 고유값 수)로 초안을 만든 뒤
// DBA 가 검토한다. 그 흐름의 세 조각이 여기 있다.
//   readCommentsSql    검토를 마친 주석 SQL(sql/companyx/comments.sql). 적재기가 표를 만든 뒤 실행한다.
//   loadCommentCard    카탈로그 주석으로 만든 카드(SQL_CARD=comments). 기동 때 한 번 읽고 캐시한다.
//   renderDraft        통계로 만든 검토용 초안 SQL(cli/companyx-comments-draft.ts).
//
// 값 예시는 카드에 들어가지 않는다. 초안의 최빈값은 SQL 주석(-- 줄)으로만 적어 검토자에게만 보인다.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** pg 의 Pool, Client, 시험용 가짜가 함께 맞는 최소 모양. */
export interface Queryable {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
}

// ---------- 검토를 마친 주석 SQL ----------

/** 검토를 마친 주석 SQL 의 자리. 저장소 루트의 sql/companyx/comments.sql 이다(dist/ 와 src/ 어디서 불러도 같다). */
export function commentsSqlPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..", "sql", "companyx", "comments.sql");
}

/** 주석 SQL 의 COMMENT 문. kind 는 TABLE 이나 COLUMN, target 은 스키마를 붙인 이름, text 는 주석 문자열이다. */
export interface CommentStatement {
  kind: "TABLE" | "COLUMN";
  target: string;
  text: string;
}

/** 줄 주석 바깥의 COMMENT ON TABLE, COMMENT ON COLUMN 문을 읽는다. 문자열은 달러 따옴표($$…$$, $tag$…$tag$)나 작은따옴표('' 는 ')다.
 * 문자열 안의 -- 와 ; 는 주석이나 문장 끝이 아니다. */
export function parseCommentStatements(sql: string): CommentStatement[] {
  const out: CommentStatement[] = [];
  const head = /COMMENT\s+ON\s+(TABLE|COLUMN)\s+([A-Za-z_][\w.]*)\s+IS\s+/iy;
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i);
      i = nl < 0 ? sql.length : nl + 1;
      continue;
    }
    head.lastIndex = i;
    const m = head.exec(sql);
    if (!m) {
      i++;
      continue;
    }
    let j = head.lastIndex;
    let text: string;
    if (sql[j] === "$") {
      const tag = /\$[A-Za-z_]*\$/y;
      tag.lastIndex = j;
      const t = tag.exec(sql)?.[0];
      if (!t) throw new Error(`주석 문자열을 읽지 못했다: ${m[2]}`);
      const end = sql.indexOf(t, j + t.length);
      if (end < 0) throw new Error(`닫히지 않은 달러 따옴표: ${m[2]}`);
      text = sql.slice(j + t.length, end);
      j = end + t.length;
    } else if (sql[j] === "'") {
      let k = j + 1;
      let s = "";
      for (;;) {
        if (k >= sql.length) throw new Error(`닫히지 않은 따옴표: ${m[2]}`);
        if (sql[k] === "'" && sql[k + 1] === "'") {
          s += "'";
          k += 2;
        } else if (sql[k] === "'") break;
        else s += sql[k++];
      }
      text = s;
      j = k + 1;
    } else {
      throw new Error(`주석 문자열이 아니다: ${m[2]} IS ${sql.slice(j, j + 10)}`);
    }
    out.push({ kind: m[1].toUpperCase() as "TABLE" | "COLUMN", target: m[2], text });
    i = j;
  }
  return out;
}

/** 검토를 마친 주석 SQL 을 그 스키마에 맞춰 읽는다. 파일이 없으면 null(적재기는 주석 없이 적재하고 그 사실을 보고한다).
 * 파일은 companyx 스키마 이름으로 쓴다. 다른 스키마에 적재할 때는 COMMENT ON 뒤의 스키마 이름만 바꾼다. */
export async function readCommentsSql(
  schema = "companyx",
  path = commentsSqlPath(),
): Promise<{ sql: string; path: string; tables: number; columns: number } | null> {
  if (!existsSync(path)) return null;
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error(`unsafe schema: ${schema}`);
  let sql = await readFile(path, "utf-8");
  if (schema !== "companyx") sql = sql.replace(/(COMMENT\s+ON\s+(?:TABLE|COLUMN)\s+)companyx\./gi, `$1${schema}.`);
  const stmts = parseCommentStatements(sql);
  return {
    sql,
    path,
    tables: stmts.filter((s) => s.kind === "TABLE").length,
    columns: stmts.filter((s) => s.kind === "COLUMN").length,
  };
}

// ---------- 카탈로그와 카드 ----------

export interface CatalogColumn {
  table: string;
  column: string;
  /** format_type 결과(integer, character varying(50) 따위). */
  type: string;
  comment: string | null;
  pk: boolean;
  /** 외래키가 가리키는 스키마, 표, 컬럼. */
  ref: { schema: string; table: string; column: string } | null;
}

export interface Catalog {
  tables: { table: string; comment: string | null }[];
  columns: CatalogColumn[];
}

/** 표의 컬럼, 타입, 기본키, 외래키, 주석(col_description, obj_description)을 카탈로그에서 읽는다. 표 순서는 tables 순서다. */
const CATALOG_SQL = `
SELECT c.relname AS table_name,
       obj_description(c.oid, 'pg_class') AS table_comment,
       a.attname AS column_name,
       format_type(a.atttypid, a.atttypmod) AS column_type,
       col_description(c.oid, a.attnum) AS column_comment,
       EXISTS (SELECT 1 FROM pg_constraint p
                WHERE p.conrelid = c.oid AND p.contype = 'p' AND a.attnum = ANY (p.conkey)) AS is_pk,
       r.ref_schema, r.ref_table, r.ref_column
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
  LEFT JOIN LATERAL (
    SELECT fn.nspname AS ref_schema, fc.relname AS ref_table, fa.attname AS ref_column
      FROM pg_constraint f
      JOIN pg_class fc ON fc.oid = f.confrelid
      JOIN pg_namespace fn ON fn.oid = fc.relnamespace
      JOIN pg_attribute fa ON fa.attrelid = f.confrelid AND fa.attnum = f.confkey[1]
     WHERE f.conrelid = c.oid AND f.contype = 'f' AND f.conkey = ARRAY[a.attnum]::int2[]
     ORDER BY f.conname
     LIMIT 1
  ) r ON true
 WHERE n.nspname = $1 AND c.relname = ANY ($2::text[]) AND c.relkind IN ('r', 'p', 'v', 'm')
 ORDER BY array_position($2::text[], c.relname::text), a.attnum`;

export async function readCatalog(db: Queryable, schema: string, tables: readonly string[]): Promise<Catalog> {
  const res = await db.query(CATALOG_SQL, [schema, [...tables]]);
  const seen = new Map<string, string | null>();
  const columns: CatalogColumn[] = [];
  for (const r of res.rows) {
    if (!seen.has(r.table_name)) seen.set(r.table_name, r.table_comment ?? null);
    columns.push({
      table: r.table_name,
      column: r.column_name,
      type: r.column_type,
      comment: r.column_comment ?? null,
      pk: r.is_pk === true,
      ref: r.ref_table ? { schema: r.ref_schema, table: r.ref_table, column: r.ref_column } : null,
    });
  }
  return { tables: [...seen].map(([table, comment]) => ({ table, comment })), columns };
}

/** 카드에 적는 짧은 타입 이름. 종전 카드와 같은 어휘(int, text, bool, date, timestamp)다. 문자열 길이는 SQL 을 쓰는 데 쓸모가 없다. */
export function shortType(t: string): string {
  const s = t.toLowerCase().trim();
  if (s === "integer" || s === "int" || s === "int4") return "int";
  if (s === "boolean" || s === "bool") return "bool";
  if (s === "text" || s.startsWith("character varying") || s.startsWith("varchar") || s.startsWith("character(") || s === "character")
    return "text";
  if (s.startsWith("timestamp")) return s.includes("with time zone") ? "timestamptz" : "timestamp";
  if (s.startsWith("numeric")) return "numeric";
  return s;
}

const hasText = (s: string | null | undefined): s is string => !!s && s.trim() !== "";
/** 카드의 한 줄. 주석 안의 줄바꿈과 겹친 공백을 한 칸으로 줄인다. */
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

export interface CommentCard {
  card: string;
  tables: number;
  /** 카드에 실은 컬럼 수(주석이 있거나 키인 컬럼). */
  columns: number;
  /** 주석이 없어 카드에서 뺀 컬럼(표.컬럼). 키 컬럼은 주석이 없어도 싣는다. */
  omitted: string[];
}

/** 카탈로그 주석으로 카드를 만든다. 결정론이다(같은 카탈로그면 같은 문자열).
 *
 * 모양은 종전 주석 카드(nl2sql.ts COMPANYX_SCHEMA_ANNOTATED)와 같은 CREATE TABLE 꼴이다. 표 주석은 여는 줄 뒤에, 컬럼 주석은
 * 그 컬럼 줄 뒤에 붙인다. 기본키와 외래키는 주석이 아니라 카탈로그의 제약에서 읽는다.
 *
 * 카드에 싣는 컬럼은 주석이 달린 컬럼과 키 컬럼이다. DBA 가 검토하지 않은 컬럼(적재 시각 created_at 따위)은 모델에게 보이지
 * 않는다. 표 가운데 하나라도 컬럼 주석이 전혀 없으면 검토가 끝나지 않은 카탈로그로 보고 카드를 만들지 않는다(반쪽 카드로
 * 조용히 돌지 않는다). 그때 호출부는 종전 카드로 돈다. */
export function buildCommentCard(
  schema: string,
  tables: readonly string[],
  catalog: Catalog,
): { ok: true; value: CommentCard } | { ok: false; reason: string } {
  const missing = tables.filter((t) => !catalog.columns.some((c) => c.table === t));
  if (missing.length) return { ok: false, reason: `카탈로그에 표가 없다: ${missing.join(", ")}` };
  const bare = tables.filter((t) => !catalog.columns.some((c) => c.table === t && hasText(c.comment)));
  if (bare.length === tables.length) return { ok: false, reason: "컬럼 주석이 하나도 없다" };
  if (bare.length) return { ok: false, reason: `컬럼 주석이 없는 표가 있다: ${bare.join(", ")}` };

  const lines: string[] = [];
  const omitted: string[] = [];
  let shownTotal = 0;
  for (const t of tables) {
    const tc = catalog.tables.find((x) => x.table === t)?.comment;
    lines.push(`CREATE TABLE ${schema}.${t} (${hasText(tc) ? `  -- ${oneLine(tc)}` : ""}`);
    const cols = catalog.columns.filter((c) => c.table === t);
    const shown = cols.filter((c) => hasText(c.comment) || c.pk || c.ref);
    for (const c of cols) if (!shown.includes(c)) omitted.push(`${t}.${c.column}`);
    shown.forEach((c, i) => {
      const parts = [c.column, shortType(c.type)];
      if (c.pk) parts.push("PRIMARY KEY");
      if (c.ref) parts.push(`REFERENCES ${c.ref.schema}.${c.ref.table}(${c.ref.column})`);
      const sep = i < shown.length - 1 ? "," : "";
      lines.push(`  ${parts.join(" ")}${sep}${hasText(c.comment) ? `  -- ${oneLine(c.comment)}` : ""}`);
    });
    lines.push(");");
    shownTotal += shown.length;
  }
  return { ok: true, value: { card: lines.join("\n"), tables: tables.length, columns: shownTotal, omitted } };
}

/** 주석 카드의 기동 상태. source 가 fallback 이면 card 는 null 이고 reason 이 종전 카드로 도는 이유다. */
export interface CommentCardState {
  source: "comments" | "fallback";
  card: string | null;
  tables: number;
  columns: number;
  omitted: string[];
  reason?: string;
}

let pending: Promise<CommentCardState> | undefined;
let settled: CommentCardState | undefined;

/** 카탈로그 주석으로 카드를 만들어 캐시한다. 처음 부를 때 한 번만 카탈로그를 읽고, 그 뒤로는 같은 결과를 돌려준다.
 * 카탈로그를 읽지 못하거나 주석이 없으면 fallback 으로 남기고 그 이유를 stderr 에 한 번 적는다(stdio 서버의 stdout 은 프로토콜이다). */
export function loadCommentCard(db: Queryable, schema: string, tables: readonly string[]): Promise<CommentCardState> {
  pending ??= (async (): Promise<CommentCardState> => {
    try {
      const r = buildCommentCard(schema, tables, await readCatalog(db, schema, tables));
      if (r.ok) return { source: "comments", card: r.value.card, tables: r.value.tables, columns: r.value.columns, omitted: r.value.omitted };
      return { source: "fallback", card: null, tables: 0, columns: 0, omitted: [], reason: r.reason };
    } catch (e) {
      const msg = (e instanceof Error ? e.message : String(e)).split("\n")[0];
      return { source: "fallback", card: null, tables: 0, columns: 0, omitted: [], reason: `카탈로그를 읽지 못했다: ${msg}` };
    }
  })().then((s) => {
    settled = s;
    if (s.source === "fallback") console.error(`[schema-card] SQL_CARD=comments 이지만 주석 카드를 만들지 못해 종전 주석 카드로 돈다: ${s.reason}`);
    else
      console.error(
        `[schema-card] 카탈로그 주석 카드: 표 ${s.tables}개, 컬럼 ${s.columns}개` +
          (s.omitted.length ? `, 주석이 없어 뺀 컬럼 ${s.omitted.length}개(${s.omitted.join(", ")})` : ""),
      );
    return s;
  });
  return pending;
}

/** 캐시된 주석 카드 상태. 아직 읽지 않았으면 undefined. */
export function commentCardState(): CommentCardState | undefined {
  return settled;
}

/** 시험용: 캐시를 비운다. */
export function resetCommentCard(): void {
  pending = undefined;
  settled = undefined;
}

// ---------- 통계로 만드는 검토용 초안 ----------

export interface ColumnStats {
  column: string;
  /** information_schema.columns 의 data_type. */
  dataType: string;
  nullable: boolean;
  nullFrac: number;
  /** 고유값 수. pg_stats 의 n_distinct 가 음수(행 수의 비율)면 행 수로 바꾼 값이다. */
  distinct: number;
  /** 수와 날짜, 시각 컬럼만. 그 밖은 null. */
  min: string | null;
  max: string | null;
  /** 저카디널리티 컬럼의 최빈값(검토 힌트 전용, 카드와 주석 문자열에 넣지 않는다). */
  mcv: { value: string; freq: number }[];
  pk: boolean;
  ref: { schema: string; table: string; column: string } | null;
  /** 지금 달려 있는 주석(다시 초안을 뽑을 때 검토자가 견준다). */
  comment: string | null;
}

export interface TableStats {
  table: string;
  rows: number;
  /** pg_stats 가 그 표를 덮었는지. 작은 표는 자동 ANALYZE 문턱을 못 넘어 통계가 없을 수 있다(그때는 정확 집계). */
  source: "pg_stats" | "scan";
  comment: string | null;
  columns: ColumnStats[];
}

/** 최빈값을 검토 힌트로 적는 고유값 수 상한. 이보다 많으면 코드 값이 아니라 이름이나 자유 텍스트로 본다. */
export const LOW_CARDINALITY = 12;
/** 최빈값 힌트에 적는 값의 길이 상한. 이보다 긴 값이 하나라도 있으면 코드가 아니라 서술로 보고 값을 적지 않는다. */
export const MCV_MAX_CHARS = 30;

const NUMERIC_TYPES = new Set(["integer", "bigint", "smallint", "numeric", "real", "double precision"]);
const TIME_TYPES = /^(date|timestamp|time)/;
export const orderable = (dataType: string) => NUMERIC_TYPES.has(dataType) || TIME_TYPES.test(dataType);

/** 수의 자릿수 이름(수십, 수천 …). 값 그대로가 아니라 규모만 적는다. */
export function magnitude(n: number): string {
  if (!Number.isFinite(n)) return "?";
  if (n < 0) return "음수";
  if (n === 0) return "0";
  const words = ["한 자리", "수십", "수백", "수천", "수만", "수십만", "수백만", "수천만", "억 단위", "십억 단위"];
  const k = Math.min(Math.floor(Math.log10(n)), words.length - 1);
  return words[k];
}

const yearOf = (s: string) => /^(\d{4})-/.exec(s)?.[1];

/** 초안 주석 문자열의 범위 표현. 수는 자릿수 이름, 날짜와 시각은 연도만 쓴다. 정확한 값은 검토 힌트(-- 줄)에만 둔다. */
export function abstractRange(c: Pick<ColumnStats, "dataType" | "min" | "max" | "distinct" | "nullFrac">, rows: number): string {
  if (NUMERIC_TYPES.has(c.dataType) && c.min !== null && c.max !== null) {
    const a = magnitude(Number(c.min));
    const b = magnitude(Number(c.max));
    const sign = Number(c.min) >= 0 ? "0 이상, " : "";
    return a === b ? `${sign}${a}` : `${sign}${a}~${b}`;
  }
  if (TIME_TYPES.test(c.dataType) && c.min !== null && c.max !== null) {
    const a = yearOf(c.min);
    const b = yearOf(c.max);
    const what = c.dataType === "date" ? "날짜" : "시각";
    if (a && b) return a === b ? `${a}년 안의 ${what}` : `${a}년~${b}년 사이 ${what}`;
  }
  if (c.dataType === "boolean") return "참 또는 거짓";
  if (c.distinct > 0 && c.distinct <= LOW_CARDINALITY && c.distinct < rows) return `${Math.round(c.distinct)}가지 코드 값`;
  if (rows > 0 && c.distinct >= rows * (1 - c.nullFrac) - 0.5) return "행마다 다른 값";
  return "자유 텍스트";
}

const KIND: Record<string, string> = {
  integer: "정수",
  bigint: "정수",
  smallint: "정수",
  numeric: "수",
  real: "수",
  "double precision": "수",
  boolean: "참거짓",
  date: "날짜",
  "character varying": "문자열",
  text: "문자열",
  "timestamp without time zone": "시각",
  "timestamp with time zone": "시각",
};

/** 달러 따옴표 문자열. 본문에 $$ 가 있으면 태그를 붙인다. */
export function dollarQuote(s: string): string {
  return s.includes("$$") ? `$c$${s}$c$` : `$$${s}$$`;
}

const pct = (f: number) => `${(f * 100).toFixed(f > 0 && f < 0.01 ? 1 : 0)}%`;

/** 검토용 초안 SQL. 주석 문자열(IS 뒤)에는 뜻 자리(TODO), 타입, 추상 범위, NULL 여부만 넣는다. 최솟값, 최댓값, 최빈값은
 * 검토자를 위한 -- 줄에만 적어 카탈로그와 카드에 들어가지 않는다. */
export function renderDraft(schema: string, tables: readonly TableStats[], meta: { generatedAt: string; endpoint: string }): string {
  const out: string[] = [
    "-- Company-X 컬럼 주석 초안 (사람 검토용, 자동 생성).",
    `-- 생성: ${meta.generatedAt}  대상: ${meta.endpoint}  스키마: ${schema}  표 ${tables.length}개`,
    "-- 원천: information_schema.columns, pg_stats(통계가 없는 표는 정확 집계), pg_constraint.",
    "-- 이 파일을 그대로 적용하지 않는다. 검토자가 TODO(뜻, 단위, 자주 쓰는 조건)를 채워 sql/companyx/comments.sql 로 옮긴다.",
    "-- 규칙: IS 뒤 문자열에는 뜻, 타입, 추상 범위, 단위, 자주 쓰는 조건(SQL)만 쓴다. 값 예시는 쓰지 않는다.",
    "--       [검토 힌트] 줄은 SQL 주석이라 카탈로그에도 카드에도 들어가지 않는다. 값 목록을 주석으로 옮기지 않고, 업무 용어와",
    "--       저장 값이 갈리는 것만 조건 SQL 로 적는다(미해결 = status IN (…)). 데이터에서 참인 조건만 적는다.",
    "",
  ];
  for (const t of tables) {
    out.push(`-- ===== ${schema}.${t.table} — ${t.rows}행, 통계 ${t.source === "pg_stats" ? "pg_stats" : "정확 집계(pg_stats 없음)"} =====`);
    if (t.comment) out.push(`-- 지금 주석: ${oneLine(t.comment)}`);
    out.push(`COMMENT ON TABLE ${schema}.${t.table} IS ${dollarQuote("TODO: 한 행이 무엇인지")};`, "");
    for (const c of t.columns) {
      const facts = [
        `${c.dataType}${c.nullable ? "" : " NOT NULL"}`,
        c.pk ? "기본키" : null,
        c.ref ? `외래키 → ${c.ref.schema}.${c.ref.table}.${c.ref.column}` : null,
      ].filter(Boolean);
      out.push(`-- ${t.table}.${c.column}  ${facts.join(", ")}`);
      const stat = [
        c.min !== null ? `최소 ${c.min}` : null,
        c.max !== null ? `최대 ${c.max}` : null,
        `고유값 ${Math.round(c.distinct)}`,
        `NULL ${pct(c.nullFrac)}`,
      ].filter(Boolean);
      out.push(`--   [검토 힌트] ${stat.join(", ")}`);
      // 키 컬럼의 값은 번호일 뿐이고, 긴 문자열은 코드가 아니라 서술이라 최빈값을 적지 않는다.
      const hints = c.pk || c.ref ? [] : c.mcv;
      if (hints.some((v) => v.value.length > MCV_MAX_CHARS)) out.push(`--   [검토 힌트] 값 ${Math.round(c.distinct)}가지(긴 문자열이라 값은 생략)`);
      else if (hints.length)
        out.push(`--   [검토 힌트] 값 ${Math.round(c.distinct)}가지(빈도): ${hints.map((v) => `'${v.value.replace(/'/g, "''")}' ${pct(v.freq)}`).join(", ")}`);
      if (c.comment) out.push(`--   지금 주석: ${oneLine(c.comment)}`);
      const body = [
        c.pk ? "기본키(행 번호)." : c.ref ? `${c.ref.table}.${c.ref.column} 를 가리키는 번호.` : "TODO 뜻.",
        c.pk || c.ref ? `${KIND[c.dataType] ?? c.dataType}.` : `${KIND[c.dataType] ?? c.dataType}, ${abstractRange(c, t.rows)}.`,
        c.nullFrac > 0 ? "비어 있을 수 있다(NULL)." : null,
        !c.pk && !c.ref && (NUMERIC_TYPES.has(c.dataType) || c.dataType === "boolean" || hints.length) ? "TODO 단위나 자주 쓰는 조건." : null,
      ].filter(Boolean);
      out.push(`COMMENT ON COLUMN ${schema}.${t.table}.${c.column} IS ${dollarQuote(body.join(" "))};`, "");
    }
  }
  return out.join("\n");
}
