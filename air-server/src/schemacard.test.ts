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

// 카탈로그 주석 카드(SQL_CARD=comments) — DB 없이 검증한다.
//
// 카드 만들기(주석이 있을 때, 없을 때, 반쪽일 때), 기동 때 한 번만 읽는 캐시, 주석 SQL 읽기, 검토를 마친 주석 파일의 계약
// (값 예시 없음, 컬럼 전부, 없는 항목 검사와 어긋나지 않음), 초안의 최빈값이 주석 문자열에 들어가지 않는지를 본다.
// 카탈로그는 가짜 query 로 흉내 낸다.
import { readFileSync } from "node:fs";

import { absentAttribute } from "./notfound.js";
import {
  COMPANYX_CARD_TABLES,
  COMPANYX_SCHEMA_ANNOTATED,
  COMPANYX_SCHEMA_DDL,
  companyxSchemaCard,
  companyxSchemaCardName,
  loadCompanyxSchemaCard,
} from "./nl2sql.js";
import { profile } from "./profile.js";
import {
  abstractRange,
  buildCommentCard,
  commentsSqlPath,
  magnitude,
  parseCommentStatements,
  readCommentsSql,
  renderDraft,
  resetCommentCard,
  shortType,
  type Catalog,
  type CatalogColumn,
  type Queryable,
  type TableStats,
} from "./schemacomments.js";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) passed++;
  else {
    failed++;
    console.error("  FAIL:", msg);
  }
}

const col = (table: string, column: string, type: string, comment: string | null, extra: Partial<CatalogColumn> = {}): CatalogColumn => ({
  table,
  column,
  type,
  comment,
  pk: false,
  ref: null,
  ...extra,
});

// ---------- 카드 만들기: 주석이 있을 때 ----------
{
  const catalog: Catalog = {
    tables: [
      { table: "a", comment: "표 A.\n한 행이 하나." },
      { table: "b", comment: null },
    ],
    columns: [
      col("a", "id", "integer", null, { pk: true }),
      col("a", "name", "character varying(50)", "이름(문자열)."),
      col("a", "created_at", "timestamp without time zone", null),
      col("a", "flag", "boolean", "여부(참거짓).  재직 중 = flag"),
      col("b", "id", "integer", null, { pk: true }),
      col("b", "a_id", "integer", null, { ref: { schema: "s", table: "a", column: "id" } }),
      col("b", "amount", "integer", "금액(정수, 만원 단위)."),
    ],
  };
  const r = buildCommentCard("s", ["a", "b"], catalog);
  ok(r.ok, "주석이 있으면 카드를 만든다");
  if (r.ok) {
    const lines = r.value.card.split("\n");
    ok(lines[0] === "CREATE TABLE s.a (  -- 표 A. 한 행이 하나.", `표 주석은 여는 줄 뒤에 한 줄로 (got ${lines[0]})`);
    ok(lines[1] === "  id int PRIMARY KEY,", `기본키는 주석이 없어도 싣는다 (got ${lines[1]})`);
    ok(lines[2] === "  name text,  -- 이름(문자열).", `varchar 는 text, 주석은 쉼표 뒤 (got ${lines[2]})`);
    ok(lines[3] === "  flag bool  -- 여부(참거짓). 재직 중 = flag", `마지막 컬럼은 쉼표 없이, 겹친 공백은 한 칸 (got ${lines[3]})`);
    ok(lines[4] === ");", "표를 닫는다");
    ok(lines[5] === "CREATE TABLE s.b (", "표 주석이 없으면 여는 줄만");
    ok(lines[7] === "  a_id int REFERENCES s.a(id),", `외래키는 주석이 없어도 REFERENCES 로 싣는다 (got ${lines[7]})`);
    ok(!r.value.card.includes("created_at"), "주석이 없는 일반 컬럼은 카드에서 뺀다");
    ok(JSON.stringify(r.value.omitted) === '["a.created_at"]', `뺀 컬럼을 보고한다 (got ${JSON.stringify(r.value.omitted)})`);
    ok(r.value.tables === 2 && r.value.columns === 6, `표 2개, 실은 컬럼 6개 (got ${r.value.tables}, ${r.value.columns})`);
    ok(buildCommentCard("s", ["a", "b"], catalog).ok && (buildCommentCard("s", ["a", "b"], catalog) as { value: { card: string } }).value.card === r.value.card, "결정론이다");
  }
}

// ---------- 카드 만들기: 주석이 없을 때, 반쪽일 때, 표가 없을 때 ----------
{
  const bare: Catalog = {
    tables: [{ table: "a", comment: null }],
    columns: [col("a", "id", "integer", null, { pk: true }), col("a", "name", "text", null)],
  };
  const none = buildCommentCard("s", ["a"], bare);
  ok(!none.ok && none.reason === "컬럼 주석이 하나도 없다", "주석이 없으면 카드를 만들지 않는다");
  const blank = buildCommentCard("s", ["a"], { ...bare, columns: [col("a", "name", "text", "   ")] });
  ok(!blank.ok, "공백뿐인 주석은 주석이 아니다");
  const half: Catalog = {
    tables: [],
    columns: [col("a", "name", "text", "이름."), col("b", "name", "text", null)],
  };
  const h = buildCommentCard("s", ["a", "b"], half);
  ok(!h.ok && h.reason.includes("b") && !h.reason.includes("a,"), `한 표라도 주석이 없으면 반쪽 카드를 만들지 않고 그 표를 댄다 (got ${!h.ok && h.reason})`);
  const gone = buildCommentCard("s", ["a", "zz"], half);
  ok(!gone.ok && gone.reason.includes("zz"), "카탈로그에 없는 표를 댄다");
}

// ---------- 기동 때 한 번 읽고 캐시, 그리고 SQL_CARD 별 카드 ----------
/** 카탈로그 쿼리(readCatalog)에 답하는 가짜. 컬럼 주석이 있는 행을 돌려줄지 고른다. */
function fakeCatalog(withComments: boolean, fail = false) {
  let calls = 0;
  const rows = COMPANYX_CARD_TABLES.flatMap((t) => [
    { table_name: t, table_comment: withComments ? `${t} 표.` : null, column_name: "id", column_type: "integer", column_comment: null, is_pk: true, ref_schema: null, ref_table: null, ref_column: null },
    { table_name: t, table_comment: withComments ? `${t} 표.` : null, column_name: "name", column_type: "text", column_comment: withComments ? `${t} 이름.` : null, is_pk: false, ref_schema: null, ref_table: null, ref_column: null },
  ]);
  const db: Queryable = {
    async query(text: string) {
      calls++;
      if (fail) throw new Error("connect ECONNREFUSED 127.0.0.1:5433\n원본 오류");
      ok(/col_description/.test(text) && /obj_description/.test(text), "카드는 col_description, obj_description 으로 읽는다");
      return { rows };
    },
  };
  return { db, calls: () => calls };
}

const savedCard = process.env.SQL_CARD;
const savedDataset = process.env.DATASET;
{
  resetCommentCard();
  delete process.env.SQL_CARD;
  const f = fakeCatalog(true);
  ok((await loadCompanyxSchemaCard(f.db)) === null && f.calls() === 0, "SQL_CARD 가 comments 가 아니면 카탈로그를 읽지 않는다");
  ok(companyxSchemaCard() === COMPANYX_SCHEMA_ANNOTATED && companyxSchemaCardName() === "annotated", "기본 카드는 그대로 주석 카드다");
  process.env.SQL_CARD = "compact";
  ok(companyxSchemaCard() === COMPANYX_SCHEMA_DDL && companyxSchemaCardName() === "compact", "compact 는 그대로 한 줄 카드다");

  // 주석이 있을 때
  process.env.SQL_CARD = "comments";
  ok(companyxSchemaCard() === COMPANYX_SCHEMA_ANNOTATED, "읽기 전에는 주석 카드로 돈다");
  ok(companyxSchemaCardName().startsWith("annotated (comments 대신"), `읽기 전 이름이 그 사실을 말한다 (got ${companyxSchemaCardName()})`);
  const s1 = await loadCompanyxSchemaCard(f.db);
  const s2 = await loadCompanyxSchemaCard(f.db);
  ok(s1?.source === "comments" && s1 === s2 && f.calls() === 1, `한 번만 읽고 캐시한다 (calls ${f.calls()})`);
  const card = companyxSchemaCard();
  ok(card.startsWith("CREATE TABLE companyx.departments (  -- departments 표.") && card.includes("  name text  -- sales 이름."), "카탈로그 주석으로 만든 카드를 쓴다");
  ok(card !== COMPANYX_SCHEMA_ANNOTATED && companyxSchemaCardName() === "comments", "이름은 comments");
  process.env.DATASET = "companyx";
  ok(profile().schemaCard === card, "프로파일의 카드(MCP 리소스, 없는 항목 검사)도 기동 뒤의 주석 카드를 본다");

  // 주석이 없을 때
  resetCommentCard();
  const g = fakeCatalog(false);
  const s3 = await loadCompanyxSchemaCard(g.db);
  ok(s3?.source === "fallback" && s3.card === null && s3.reason === "컬럼 주석이 하나도 없다", "주석이 없으면 fallback 으로 남긴다");
  ok(companyxSchemaCard() === COMPANYX_SCHEMA_ANNOTATED, "주석이 없으면 주석 카드(annotated)로 돈다");
  ok(companyxSchemaCardName() === "annotated (comments 대신: 컬럼 주석이 하나도 없다)", `이름에 대체 사유 (got ${companyxSchemaCardName()})`);
  ok(profile().schemaCard === COMPANYX_SCHEMA_ANNOTATED, "프로파일 카드도 주석 카드");

  // 카탈로그를 읽지 못할 때
  resetCommentCard();
  const h = fakeCatalog(true, true);
  const s4 = await loadCompanyxSchemaCard(h.db);
  ok(s4?.source === "fallback" && s4.reason === "카탈로그를 읽지 못했다: connect ECONNREFUSED 127.0.0.1:5433", `읽기 실패는 첫 줄만 사유로 (got ${s4?.reason})`);
  ok(companyxSchemaCard() === COMPANYX_SCHEMA_ANNOTATED, "읽기 실패면 주석 카드로 돈다");
  await loadCompanyxSchemaCard(h.db);
  ok(h.calls() === 1, "실패도 캐시한다(기동 때 한 번)");
  resetCommentCard();
}
if (savedCard === undefined) delete process.env.SQL_CARD;
else process.env.SQL_CARD = savedCard;
if (savedDataset === undefined) delete process.env.DATASET;
else process.env.DATASET = savedDataset;

// ---------- 주석 SQL 읽기 ----------
{
  const sql = [
    "-- COMMENT ON COLUMN s.t.x IS $$주석 줄 안의 문장은 읽지 않는다$$;",
    "COMMENT ON TABLE s.t IS $$표; -- 문자열 안의 기호$$;",
    "COMMENT ON COLUMN s.t.a IS 'it''s ''quoted''';",
    "comment on column s.t.b is $c$달러 $$ 가 든 문자열$c$;",
  ].join("\n");
  const st = parseCommentStatements(sql);
  ok(st.length === 3, `주석 줄의 COMMENT 는 세지 않는다 (got ${st.length})`);
  ok(st[0]?.kind === "TABLE" && st[0].target === "s.t" && st[0].text === "표; -- 문자열 안의 기호", "달러 따옴표 안의 ; 와 -- 는 문자열이다");
  ok(st[1]?.text === "it's 'quoted'", "작은따옴표의 '' 는 ' 다");
  ok(st[2]?.kind === "COLUMN" && st[2].target === "s.t.b" && st[2].text === "달러 $$ 가 든 문자열", "태그 달린 달러 따옴표, 소문자 키워드");
  let threw = false;
  try {
    parseCommentStatements("COMMENT ON TABLE s.t IS $$닫히지 않음");
  } catch {
    threw = true;
  }
  ok(threw, "닫히지 않은 문자열은 오류");
}

// ---------- 검토를 마친 주석 파일(sql/companyx/comments.sql)의 계약 ----------
const file = await readCommentsSql();
ok(file !== null && file.path === commentsSqlPath(), "검토본이 저장소에 있다");
const reviewed = parseCommentStatements(file?.sql ?? "");
ok(file?.tables === 8 && file.columns === 58, `표 8개, 컬럼 58개 (got ${file?.tables}, ${file?.columns})`);
{
  const other = await readCommentsSql("companyx_test");
  const targets = parseCommentStatements(other?.sql ?? "").map((s) => s.target);
  ok(targets.length === 66 && targets.every((t) => t.startsWith("companyx_test.")), "다른 스키마로 적재하면 COMMENT 대상의 스키마만 바뀐다");
  let unsafe = false;
  try {
    await readCommentsSql("x; DROP");
  } catch {
    unsafe = true;
  }
  ok(unsafe, "스키마 이름을 검사한다");
}

/** 주석 카드(annotated)의 CREATE TABLE 꼴에서 표, 컬럼, 타입, 키를 읽는다. 오프라인 카탈로그 대용이다. */
function catalogFromAnnotated(statements: { kind: string; target: string; text: string }[]): Catalog {
  const columns: CatalogColumn[] = [];
  let table = "";
  for (const line of COMPANYX_SCHEMA_ANNOTATED.split("\n")) {
    const t = /^CREATE TABLE companyx\.(\w+)/.exec(line);
    if (t) {
      table = t[1];
      continue;
    }
    const c = /^\s+(\w+)\s+(\w+)(\s+PRIMARY KEY)?(?:\s+REFERENCES\s+(\w+)\.(\w+)\((\w+)\))?/.exec(line);
    if (!c || !table) continue;
    const comment = statements.find((s) => s.kind === "COLUMN" && s.target === `companyx.${table}.${c[1]}`)?.text ?? null;
    columns.push(col(table, c[1], c[2], comment, { pk: !!c[3], ref: c[4] ? { schema: c[4], table: c[5], column: c[6] } : null }));
  }
  const tables = COMPANYX_CARD_TABLES.map((t) => ({
    table: t,
    comment: statements.find((s) => s.kind === "TABLE" && s.target === `companyx.${t}`)?.text ?? null,
  }));
  return { tables, columns };
}
const offline = catalogFromAnnotated(reviewed);
{
  const missing = offline.columns.filter((c) => !c.pk && !c.comment).map((c) => `${c.table}.${c.column}`);
  ok(missing.length === 0, `종전 카드의 기본키 아닌 컬럼은 모두 주석이 있다 (없음: ${missing.join(", ")})`);
  const unknown = reviewed.filter((s) => s.kind === "COLUMN" && !offline.columns.some((c) => `companyx.${c.table}.${c.column}` === s.target));
  ok(unknown.length === 0, `주석은 있는 컬럼에만 단다 (모르는 대상: ${unknown.map((s) => s.target).join(", ")})`);
  ok(COMPANYX_CARD_TABLES.every((t) => reviewed.some((s) => s.kind === "TABLE" && s.target === `companyx.${t}`)), "표 여덟 개 모두 표 주석이 있다");
  ok(JSON.stringify(COMPANYX_CARD_TABLES) === JSON.stringify(["departments", "employees", "clients", "products", "contracts", "projects", "sales", "support_tickets"]), "카드의 표는 종전 카드와 같은 여덟 개, 같은 순서");
}

// 값 예시가 없다(CTO 답변). 종전 카드의 예시 목록은 주석에 나오지 않고, 코드 값은 조건 SQL 의 따옴표 안에서만 나온다.
{
  const texts = reviewed.map((s) => s.text);
  const all = texts.join("\n");
  ok(!/\d{4}-Q[1-4]/.test(all), "분기 값 예시('2025-Q3' 꼴)가 없다");
  ok(!/예\s*:/.test(all) && !/예시/.test(all), "「예:」 예시 표기가 없다");
  ok(!/Client-[A-Z]/.test(all) && !/Product-[A-Z]\d/.test(all), "고객사, 제품 이름 예시가 없다(이름 꼴만 적는다)");
  for (const v of ["경영지원팀", "클라우드사업부", "보안솔루션팀", "데이터플랫폼팀", "기술지원팀", "영업팀"]) ok(!all.includes(v), `부서 이름 예시가 없다: ${v}`);
  for (const v of ["제조업", "금융", "의료/바이오", "공공기관", "유통/물류", "IT/SW", "교육", "에너지", "건설", "미디어"]) ok(!all.includes(v), `업종 이름 예시가 없다: ${v}`);
  for (const v of ["서울", "경기", "인천", "부산", "대구", "대전", "광주", "제주"]) ok(!all.includes(v), `지역 이름 예시가 없다: ${v}`);
  for (const v of ["사원", "대리", "과장", "차장", "부장", "이사"]) {
    const bare = all.replace(new RegExp(`'${v}'`, "g"), "");
    ok(all.includes(`'${v}'`) && !bare.includes(v), `직급 값은 조건 SQL 의 따옴표 안에서만 나온다: ${v}`);
  }
  const codes = ["open", "in_progress", "resolved", "closed", "critical", "high", "medium", "low", "active", "completed", "cancelled", "beta", "planning", "on_hold", "subscription", "project", "maintenance", "enterprise", "mid", "startup", "cloud", "security", "data", "consulting"];
  for (const v of codes) {
    const bare = all.replace(new RegExp(`'${v}'`, "g"), "").replace(/[A-Za-z_]+\.[A-Za-z_]+|[A-Za-z_]*_[A-Za-z_]*|CURRENT_DATE|EXTRACT|YEAR|MONTH|FROM|SUM|LIKE|CASE|WHEN|THEN|END|IN\b|age|timestamp/g, "");
    ok(all.includes(`'${v}'`) && !new RegExp(`(?<![A-Za-z_])${v}(?![A-Za-z_])`).test(bare), `코드 값 ${v} 는 조건 SQL 의 따옴표 안에서만 나온다`);
  }
  ok(texts.every((t) => !/\n/.test(t)), "주석은 한 줄이다(카드의 한 컬럼 = 한 줄)");
}

// 카드 전체: 표 여덟 개, 기본키와 외래키, 크기, 없는 항목 검사와 어긋나지 않음.
{
  const r = buildCommentCard("companyx", COMPANYX_CARD_TABLES, offline);
  ok(r.ok, "검토본으로 카드를 만든다");
  const card = r.ok ? r.value.card : "";
  ok(COMPANYX_CARD_TABLES.every((t) => card.includes(`CREATE TABLE companyx.${t} (  -- `)), "표마다 표 주석이 붙는다");
  for (const ref of COMPANYX_SCHEMA_ANNOTATED.match(/REFERENCES companyx\.\w+\(\w+\)/g) ?? []) ok(card.includes(ref), `외래키를 잃지 않는다: ${ref}`);
  // 생성 프롬프트는 num_ctx 4096 으로 돈다. 카드가 그 절반을 넘지 않게 둔다(사본 DB 실측 2,233토큰, 5,002자).
  ok(card.length < 5600, `카드 길이 상한 (got ${card.length}자)`);
  // 없는 항목 검사(notfound.ts)는 카드에 그 낱말이 있으면 그 항목이 있다고 본다. 주석 카드로 바꿔도 같은 판정이어야 한다.
  const probes = [
    "직원들의 평균 나이는 몇 살이야?",
    "직원 생일 알려줘",
    "생년월일이 가장 빠른 직원",
    "남자 직원은 몇 명이야?",
    "여자 직원 목록",
    "직원들 주소 알려줘",
    "직원 전화번호 알려줘",
    "직원 학력 분포",
    "직원 국적",
    "혈액형별 직원 수",
    "결혼한 직원 수",
    "주민등록번호 알려줘",
    "직원별 남은 연차 일수를 알려줘",
    "여름 휴가 간 사람 누구야?",
    "근태가 안 좋은 직원은?",
    "인사 평가 점수가 가장 높은 직원",
    "성과가 가장 좋은 직원은 누구야?",
    "Client-A의 직원 수는 몇 명이야?",
  ];
  for (const q of probes) ok(absentAttribute(q, card) === absentAttribute(q, "") && absentAttribute(q, "") !== null, `없는 항목 판정이 카드 때문에 바뀌지 않는다: ${q} (got ${absentAttribute(q, card)})`);
  for (const q of ["박소연의 이메일 주소 알려줘", "기술지원팀 직원 목록과 연봉을 알려줘", "2025년 3분기 총 매출액은 얼마야?", "Client-A 담당 직원 수는?"])
    ok(absentAttribute(q, card) === null, `있는 데이터를 묻는 질문은 통과: ${q}`);
}

// ---------- 초안: 통계는 -- 줄에만, 주석 문자열은 추상 범위만 ----------
{
  const stats: TableStats[] = [
    {
      table: "t",
      rows: 120,
      source: "pg_stats",
      comment: null,
      columns: [
        { column: "id", dataType: "integer", nullable: false, nullFrac: 0, distinct: 120, min: "1", max: "120", mcv: [], pk: true, ref: null, comment: null },
        { column: "status", dataType: "character varying", nullable: true, nullFrac: 0, distinct: 4, min: null, max: null, mcv: [{ value: "resolved", freq: 0.39 }, { value: "open", freq: 0.12 }], pk: false, ref: null, comment: null },
        { column: "quarter", dataType: "character varying", nullable: false, nullFrac: 0, distinct: 10, min: null, max: null, mcv: [{ value: "2025-Q3", freq: 0.08 }], pk: false, ref: null, comment: null },
        { column: "amount", dataType: "integer", nullable: false, nullFrac: 0, distinct: 397, min: "65", max: "2078", mcv: [], pk: false, ref: null, comment: null },
        { column: "sale_date", dataType: "date", nullable: false, nullFrac: 0, distinct: 389, min: "2024-01-11", max: "2026-06-27", mcv: [], pk: false, ref: null, comment: null },
        { column: "note", dataType: "text", nullable: true, nullFrac: 0.28, distinct: 3, min: null, max: null, mcv: [{ value: "x".repeat(40), freq: 0.5 }], pk: false, ref: null, comment: null },
        { column: "client_id", dataType: "integer", nullable: false, nullFrac: 0, distinct: 4, min: "5", max: "41", mcv: [{ value: "14", freq: 0.28 }], pk: false, ref: { schema: "s", table: "c", column: "id" }, comment: "지금 주석" },
      ],
    },
  ];
  const draft = renderDraft("s", stats, { generatedAt: "2026-10-11T00:00:00Z", endpoint: "localhost:5433/db" });
  const st = parseCommentStatements(draft);
  const texts = st.map((s) => s.text).join("\n");
  ok(st.length === 8 && st[0].kind === "TABLE", `표 하나, 컬럼 일곱의 COMMENT 문 (got ${st.length})`);
  ok(!/resolved|open|2025-Q3|xxxxxxxx|'14'/.test(texts), "최빈값은 주석 문자열에 들어가지 않는다");
  ok(draft.includes("'resolved' 39%") && draft.includes("'2025-Q3' 8%"), "최빈값은 검토 힌트(-- 줄)에 적는다");
  ok(draft.includes("값 3가지(긴 문자열이라 값은 생략)") && !draft.includes("x".repeat(31)), "긴 문자열 값은 힌트에도 적지 않는다");
  ok(!draft.includes("'14' 28%"), "키 컬럼의 값은 힌트에 적지 않는다");
  ok(!/\b(65|2078)\b/.test(texts) && draft.includes("최소 65, 최대 2078"), "정확한 최솟값, 최댓값은 힌트에만");
  ok(texts.includes("정수, 0 이상, 수십~수천.") && texts.includes("날짜, 2024년~2026년 사이 날짜."), `주석 문자열의 범위는 자릿수와 연도로만 (got ${texts})`);
  ok(texts.includes("비어 있을 수 있다(NULL).") && texts.includes("c.id 를 가리키는 번호. 정수."), "NULL 과 외래키를 적는다");
  ok(draft.includes("--   지금 주석: 지금 주석"), "지금 달린 주석을 검토자에게 보여 준다");
}

// ---------- 작은 함수 ----------
ok(magnitude(0) === "0" && magnitude(7) === "한 자리" && magnitude(65) === "수십" && magnitude(480) === "수백" && magnitude(9520) === "수천" && magnitude(11000) === "수만", "자릿수 이름");
ok(magnitude(-3) === "음수" && magnitude(Number.NaN) === "?", "음수와 수가 아닌 값");
ok(abstractRange({ dataType: "boolean", min: null, max: null, distinct: 1, nullFrac: 0 }, 45) === "참 또는 거짓", "참거짓 범위");
ok(abstractRange({ dataType: "character varying", min: null, max: null, distinct: 45, nullFrac: 0 }, 45) === "행마다 다른 값", "고유한 문자열");
ok(abstractRange({ dataType: "character varying", min: null, max: null, distinct: 4, nullFrac: 0 }, 120) === "4가지 코드 값", "코드 문자열");
ok(abstractRange({ dataType: "timestamp without time zone", min: "2026-10-08 16:49:39", max: "2026-10-08 16:49:39", distinct: 1, nullFrac: 0 }, 6) === "2026년 안의 시각", "같은 해의 시각");
ok(shortType("integer") === "int" && shortType("character varying(100)") === "text" && shortType("boolean") === "bool", "짧은 타입 이름");
ok(shortType("timestamp without time zone") === "timestamp" && shortType("timestamp with time zone") === "timestamptz" && shortType("numeric(10,2)") === "numeric" && shortType("date") === "date", "시각, 수 타입 이름");

console.log(`\nschemacard.test: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
