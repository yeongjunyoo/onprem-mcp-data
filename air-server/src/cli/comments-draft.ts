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

// 컬럼 주석 초안 생성기 — 통계로 COMMENT ON TABLE, COMMENT ON COLUMN 초안 SQL 을 쓴다(사람 검토용).
//
// information_schema.columns 로 컬럼과 타입을, pg_stats 로 NULL 비율, 고유값 수, 최빈값을, pg_constraint 로 키를 읽고, 수와
// 날짜 컬럼은 최솟값과 최댓값을 잰다. 작은 표는 자동 ANALYZE 문턱을 못 넘어 pg_stats 가 비어 있을 수 있다(10-11 사본 DB 에서
// clients, departments, employees, products, projects). 그 표는 같은 값을 정확 집계로 잰다. ANALYZE 는 돌리지 않는다 —
// 이 도구는 읽기 전용 트랜잭션 안에서만 읽는다.
//
// 주석 문자열에는 뜻 자리(TODO), 타입, 추상 범위만 넣고, 정확한 최솟값, 최댓값, 최빈값은 -- 줄의 검토 힌트로만 적는다.
// 검토자가 뜻, 단위, 자주 쓰는 조건을 채워 DB 에 건다(사업자 데이터셋은 sql/companyx/comments.sql 로 옮긴다).
//
// 사용: npm run companyx:comments-draft                 사업자 데이터셋(sql/companyx/comments.draft.sql 에 쓴다)
//       npm run comments-draft -- --schema <스키마>    다른 회사 DB(DATABASE_URL 의 DB, <스키마>.comments.draft.sql 에 쓴다)
//       --tables a,b 로 표를 고르고 --out <파일> 로 쓸 곳을 정한다. 표를 고르지 않으면 그 스키마의 일반 표 전부(문서 레인,
//       그래프 레인 표는 뺀다, catalog.ts laneTablesIn)다. 사업자 스키마는 종전처럼 카드의 표 여덟 개를 같은 순서로 쓴다.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getPool, closePool } from "../db.js";
import { CX_SCHEMA, CX_TABLES } from "../companyx.js";
import { laneTablesIn } from "../catalog.js";
import { profile } from "../profile.js";
import { LOW_CARDINALITY, listTables, orderable, readCatalog, renderDraft, type ColumnStats, type Queryable, type TableStats } from "../schemacomments.js";

const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;

/** 접속 문자열에서 자격증명을 뺀 host:port/db. */
function endpoint(raw: string | undefined): string {
  try {
    const u = new URL(raw ?? "postgresql://localhost:5433/mcpdata");
    return `${u.hostname}:${u.port || "5432"}/${u.pathname.replace(/^\//, "")}`;
  } catch {
    // 초안 머리말에 적을 표시일 뿐이라 초안은 그대로 쓴다. 값이 형식을 못 읽었다고 적는다.
    return "(주소 형식 불명)";
  }
}

async function tableStats(db: Queryable, schema: string, table: string): Promise<TableStats> {
  const rel = `${ident(schema)}.${ident(table)}`;
  const info = (
    await db.query(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`,
      [schema, table],
    )
  ).rows as { column_name: string; data_type: string; is_nullable: string }[];
  const catalog = await readCatalog(db, schema, [table]);
  const rows = Number((await db.query(`SELECT count(*)::bigint AS n FROM ${rel}`)).rows[0].n);
  const stats = (
    await db.query(
      `SELECT attname, null_frac, n_distinct,
              most_common_vals::text::text[] AS mcv, most_common_freqs::float8[] AS mcf
         FROM pg_stats WHERE schemaname = $1 AND tablename = $2`,
      [schema, table],
    )
  ).rows as { attname: string; null_frac: number; n_distinct: number; mcv: string[] | null; mcf: number[] | null }[];
  const source = stats.length ? "pg_stats" : "scan";

  // 최솟값, 최댓값은 언제나 정확히 잰다(pg_stats 의 히스토그램 끝은 표본이다).
  const ord = info.filter((c) => orderable(c.data_type));
  const range = ord.length
    ? (await db.query(`SELECT ${ord.map((c, i) => `min(${ident(c.column_name)})::text AS lo${i}, max(${ident(c.column_name)})::text AS hi${i}`).join(", ")} FROM ${rel}`))
        .rows[0]
    : {};

  // pg_stats 가 없는 표: NULL 비율과 고유값 수를 정확 집계한다.
  const exact: Record<string, { nulls: number; distinct: number }> = {};
  if (source === "scan" && info.length) {
    const r = (
      await db.query(
        `SELECT ${info.map((c, i) => `count(*) - count(${ident(c.column_name)}) AS n${i}, count(DISTINCT ${ident(c.column_name)}) AS d${i}`).join(", ")} FROM ${rel}`,
      )
    ).rows[0];
    info.forEach((c, i) => (exact[c.column_name] = { nulls: Number(r[`n${i}`]), distinct: Number(r[`d${i}`]) }));
  }

  const columns: ColumnStats[] = [];
  for (const c of info) {
    const st = stats.find((s) => s.attname === c.column_name);
    const nullFrac = source === "pg_stats" ? Number(st?.null_frac ?? 0) : rows ? exact[c.column_name].nulls / rows : 0;
    const nd = source === "pg_stats" ? Number(st?.n_distinct ?? 0) : exact[c.column_name].distinct;
    const distinct = nd < 0 ? -nd * rows : nd;
    let mcv: { value: string; freq: number }[] = [];
    if (distinct > 0 && distinct <= LOW_CARDINALITY) {
      if (source === "pg_stats") {
        mcv = (st?.mcv ?? []).map((value, k) => ({ value, freq: Number(st?.mcf?.[k] ?? 0) }));
      } else {
        const g = await db.query(
          `SELECT ${ident(c.column_name)}::text AS v, count(*)::float8 / NULLIF($1::float8, 0) AS f
             FROM ${rel} WHERE ${ident(c.column_name)} IS NOT NULL GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT ${LOW_CARDINALITY}`,
          [rows],
        );
        mcv = g.rows.map((x: { v: string; f: number }) => ({ value: x.v, freq: Number(x.f) }));
      }
    }
    const k = ord.findIndex((o) => o.column_name === c.column_name);
    const cat = catalog.columns.find((x) => x.column === c.column_name);
    columns.push({
      column: c.column_name,
      dataType: c.data_type,
      nullable: c.is_nullable === "YES",
      nullFrac,
      distinct,
      min: k >= 0 ? (range[`lo${k}`] ?? null) : null,
      max: k >= 0 ? (range[`hi${k}`] ?? null) : null,
      mcv,
      pk: cat?.pk ?? false,
      ref: cat?.ref ?? null,
      comment: cat?.comment ?? null,
    });
  }
  return { table, rows, source, comment: catalog.tables[0]?.comment ?? null, columns };
}

/** --이름 값. 값이 없으면 undefined. */
function arg(argv: string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at >= 0 && argv[at + 1] && !argv[at + 1].startsWith("--") ? argv[at + 1] : undefined;
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

async function main() {
  const argv = process.argv.slice(2);
  const here = dirname(fileURLToPath(import.meta.url));
  // 스키마를 말하지 않으면 활성 프로파일의 정형 스키마다(DATASET=catalog 면 CATALOG_SCHEMA).
  const schema = arg(argv, "--schema") ?? profile().sqlSchema;
  if (!IDENT.test(schema)) throw new Error(`--schema 는 스키마 이름이어야 한다: ${JSON.stringify(schema)}`);
  const picked = arg(argv, "--tables")?.split(",").map((s) => s.trim()).filter(Boolean);
  if (picked?.some((t) => !IDENT.test(t))) throw new Error(`--tables 는 쉼표로 가른 표 이름이어야 한다: ${picked.join(",")}`);
  const outArg = arg(argv, "--out");
  const out = outArg
    ? resolve(outArg)
    : schema === CX_SCHEMA
      ? resolve(here, "../../..", "sql", "companyx", "comments.draft.sql")
      : resolve(process.cwd(), `${schema}.comments.draft.sql`);

  const pool = getPool();
  const client = await pool.connect();
  const tables: TableStats[] = [];
  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    const names =
      picked ??
      (schema === CX_SCHEMA
        ? [...CX_TABLES]
        : await listTables(client, schema, laneTablesIn({ sqlSchema: schema, vectorTable: `${schema}.documents`, kgSchema: schema })));
    if (names.length === 0) throw new Error(`${schema} 스키마에 일반 표가 없다(DATABASE_URL 의 DB 와 스키마 이름을 확인한다)`);
    for (const t of names) tables.push(await tableStats(client, schema, t));
  } finally {
    // 읽기만 했으니 되돌려 끝낸다. 중간에 실패해도 열린 트랜잭션을 풀에 돌려주지 않는다.
    await client.query("ROLLBACK").catch(() => {});
    client.release();
  }
  const sql = renderDraft(schema, tables, { generatedAt: new Date().toISOString(), endpoint: endpoint(process.env.DATABASE_URL) });
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, sql + "\n", "utf-8");
  const cols = tables.reduce((n, t) => n + t.columns.length, 0);
  console.log(`초안: ${out}`);
  console.log(`표 ${tables.length}개, 컬럼 ${cols}개 (pg_stats ${tables.filter((t) => t.source === "pg_stats").map((t) => t.table).join(", ") || "없음"}; 정확 집계 ${tables.filter((t) => t.source === "scan").map((t) => t.table).join(", ") || "없음"})`);
  await closePool();
}

main().catch(async (e) => {
  console.error(e);
  await closePool().catch(() => {});
  process.exit(1);
});
