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

// 다른 회사 DB 붙이기(catalog 프로파일) — DB 없이 검증한다.
//
// 환경 변수로 만드는 프로파일(필수 값, 식별자 검사), 이 DB 에 있는 레인 재기(detectLanes), 없는 레인을 라우팅 결정에서 빼기
// (maskRoute, routeQuery, lanesFor, runnerUp), 카탈로그로 만드는 카드(주석 카드와 열 이름만 실은 카드), 초안 머리말, 읽기 역할의
// 권한 점검, 연결 실패 안내, 점검 세트의 채점 규칙(catalogcheck.ts)을 본다.
// 카탈로그는 가짜 query 로 흉내 낸다.
import { runnerUp } from "./fallback.js";
import { detectLanes, GRAPH_TABLES, laneTablesIn, maskRoute, readRoleProblems, setAvailableLanes, type LaneSet } from "./catalog.js";
import { cellKey, hasValue, parseCheckSet, rowsCover, rowsExact } from "./catalogcheck.js";
import { logConnectionFailure } from "./db.js";
import { catalogSchemaCard, loadCatalogSchemaCard } from "./nl2sql.js";
import { lanesFor } from "./pipeline.js";
import { profile, PROFILE_NAMES } from "./profile.js";
import { GRAPH_TOOL, ONTOLOGY_TOOL, route, SQL_TOOL, VECTOR_TOOL, type Lane, type RouteDecision } from "./router.js";
import { buildCommentCard, buildPlainCard, renderDraft, type Catalog, type Queryable } from "./schemacomments.js";
import { routeQuery } from "./semroute.js";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) passed++;
  else {
    failed++;
    console.error("  FAIL:", msg);
  }
}
const throws = (f: () => unknown, re: RegExp): boolean => {
  try {
    f();
    return false;
  } catch (e) {
    return re.test(String((e as Error).message));
  }
};

const ENV_KEYS = ["DATASET", "CATALOG_SCHEMA", "CATALOG_VECTOR_TABLE", "CATALOG_KG_SCHEMA", "KG_SCHEMA"] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
function env(vars: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, vars);
}
const restoreEnv = () => env(Object.fromEntries(Object.entries(saved).filter(([, v]) => v !== undefined)) as Record<string, string>);

// ---------- 환경 변수로 만드는 프로파일 ----------
{
  ok(PROFILE_NAMES.includes("catalog"), "catalog 는 아는 프로파일이다");
  env({ DATASET: "catalgo" });
  ok(throws(() => profile(), /catalog/), "모르는 값을 거절하는 문구에 catalog 가 있다");

  env({ DATASET: "catalog" });
  ok(throws(() => profile(), /CATALOG_SCHEMA/), "CATALOG_SCHEMA 가 없으면 거절한다(조용히 다른 스키마로 돌지 않는다)");
  env({ DATASET: "catalog", CATALOG_SCHEMA: "public; DROP TABLE x" });
  ok(throws(() => profile(), /CATALOG_SCHEMA/), "스키마 이름 꼴이 아니면 거절한다(SQL 에 끼워 넣지 않는다)");

  env({ DATASET: "CATALOG", CATALOG_SCHEMA: " public " });
  const p = profile();
  ok(
    p.name === "catalog" && p.sqlSchema === "public" && p.kgSchema === "public" && p.vectorTable === "public.documents",
    `기본값: 문서 표 <스키마>.documents, 그래프 스키마 <스키마> (got ${p.sqlSchema}, ${p.kgSchema}, ${p.vectorTable})`,
  );
  ok(profile() === p, "같은 환경이면 같은 프로파일 객체다");
  ok(/아직 만들지 않았다/.test(p.schemaCard), "기동 때 카드를 만들기 전에는 그렇다고 적힌 자리표시다");

  env({ DATASET: "catalog", CATALOG_SCHEMA: "shop", CATALOG_VECTOR_TABLE: "docs.chunks", CATALOG_KG_SCHEMA: "kg" });
  const q = profile();
  ok(q.sqlSchema === "shop" && q.vectorTable === "docs.chunks" && q.kgSchema === "kg", "문서 표와 그래프 스키마를 따로 줄 수 있다");
  ok(q !== p, "환경이 바뀌면 프로파일도 바뀐다");

  env({ DATASET: "catalog", CATALOG_SCHEMA: "shop", CATALOG_VECTOR_TABLE: "chunks" });
  ok(throws(() => profile(), /스키마\.표/), "문서 표는 「스키마.표」 꼴이어야 한다");
  env({ DATASET: "catalog", CATALOG_SCHEMA: "shop", CATALOG_VECTOR_TABLE: "a.b.c" });
  ok(throws(() => profile(), /스키마\.표/), "점이 둘인 문서 표는 거절한다");
  env({ DATASET: "catalog", CATALOG_SCHEMA: "shop", CATALOG_KG_SCHEMA: "kg-1" });
  ok(throws(() => profile(), /CATALOG_KG_SCHEMA/), "그래프 스키마도 식별자 꼴만 받는다");
  restoreEnv();
}

// ---------- 이 DB 에 있는 레인 ----------
function lanesDb(o: { embedding: boolean; graphTables: readonly string[] }): Queryable & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  return {
    calls,
    async query(text: string, values?: unknown[]) {
      calls.push(values ?? []);
      if (/column_name = 'embedding'/.test(text)) return { rows: o.embedding ? [{ "?column?": 1 }] : [] };
      if (/information_schema\.tables/.test(text)) return { rows: o.graphTables.map((t) => ({ table_name: t })) };
      throw new Error(`unexpected query: ${text}`);
    },
  };
}
{
  const all = lanesDb({ embedding: true, graphTables: GRAPH_TABLES });
  const a = await detectLanes(all, { vectorTable: "shop.documents", kgSchema: "kg" });
  ok(a.sql && a.vector && a.graph, "문서 표에 embedding 열이 있고 그래프 표 셋이 있으면 세 레인");
  ok(JSON.stringify(all.calls[0]) === JSON.stringify(["shop", "documents"]) && (all.calls[1] as unknown[])[0] === "kg", "문서 표는 스키마와 표로 나눠 묻고, 그래프 표는 그래프 스키마에서 찾는다");

  const none = await detectLanes(lanesDb({ embedding: false, graphTables: ["entities"] }), { vectorTable: "public.documents", kgSchema: "public" });
  ok(none.sql && !none.vector && !none.graph, "embedding 열이 없고 그래프 표가 모자라면 정형 레인만");
  ok(none.why.vector === "public.documents 에 embedding 열이 없다", `문서 레인이 없는 이유 (got ${none.why.vector})`);
  ok(none.why.graph === "public 에 aliases, relations 표가 없다", `그래프 레인이 없는 이유에 빠진 표를 적는다 (got ${none.why.graph})`);

  ok(
    JSON.stringify(laneTablesIn({ sqlSchema: "public", vectorTable: "public.documents", kgSchema: "public" })) ===
      JSON.stringify(["documents", "entities", "aliases", "relations"]),
    "정형 스키마 안에 있는 문서 표와 그래프 표는 정형 카드에서 뺀다",
  );
  ok(laneTablesIn({ sqlSchema: "shop", vectorTable: "docs.chunks", kgSchema: "kg" }).length === 0, "다른 스키마에 있으면 뺄 것이 없다");
}

// ---------- 없는 레인을 결정에서 빼기 ----------
const SQL_ONLY: LaneSet = { sql: true, vector: false, graph: false };
const decision = (r: RouteDecision["route"], tools: string[], over: Partial<RouteDecision> = {}): RouteDecision => ({
  route: r,
  tools,
  structuredHits: [],
  semanticHits: [],
  graphHits: [],
  docHits: [],
  entityHits: [],
  rationale: "rule",
  gate: { scores: { nl2sql: 1, vector_search: 0, knowledge_graph: 0 }, pick: "nl2sql", margin: 1, confident: false },
  ...over,
});
{
  const plan = { relTypes: ["USES"], maxHops: 2 } as unknown as RouteDecision["graphPlan"];
  const sem = decision("semantic", [VECTOR_TOOL]);
  ok(maskRoute(sem, undefined) === sem, "레인을 재지 않았으면(사업자 데이터셋) 결정을 그대로 돌려준다");
  ok(maskRoute(sem, { sql: true, vector: true, graph: true }) === sem, "세 레인이 다 있으면 그대로");
  const st = decision("structured", [SQL_TOOL]);
  ok(maskRoute(st, SQL_ONLY) === st, "있는 레인으로 가는 결정은 그대로");

  const m1 = maskRoute(sem, SQL_ONLY);
  ok(m1.route === "structured" && m1.tools.join() === SQL_TOOL, "문서 레인이 없으면 정형으로 보낸다");
  ok(m1.rationale === "rule; lanes in this database: sql -> structured", `가린 사실을 근거에 남긴다 (got ${m1.rationale})`);

  const m2 = maskRoute(decision("graph", [ONTOLOGY_TOOL, GRAPH_TOOL], { graphPlan: plan }), SQL_ONLY);
  ok(m2.route === "structured" && m2.graphPlan === undefined, "그래프 레인이 없으면 정형으로 보내고 탐색 계획을 뗀다");

  const hy = decision("hybrid", [SQL_TOOL, VECTOR_TOOL, ONTOLOGY_TOOL, GRAPH_TOOL], { graphPlan: plan });
  const m3 = maskRoute(hy, { sql: true, vector: true, graph: false });
  ok(m3.route === "hybrid" && m3.tools.join() === [SQL_TOOL, VECTOR_TOOL].join() && m3.graphPlan === undefined, "hybrid 에서 없는 그래프만 뺀다");
  ok(/lanes in this database: sql, vector -> hybrid$/.test(m3.rationale), `남은 레인과 경로를 적는다 (got ${m3.rationale})`);
  const m4 = maskRoute(hy, { sql: true, vector: false, graph: true });
  ok(m4.route === "hybrid" && m4.tools.join() === [SQL_TOOL, ONTOLOGY_TOOL, GRAPH_TOOL].join() && m4.graphPlan === plan, "문서만 빠지면 그래프 계획은 그대로");
  ok(maskRoute(decision("hybrid", [SQL_TOOL, VECTOR_TOOL]), SQL_ONLY).route === "structured", "hybrid 에서 하나만 남으면 그 레인의 경로");
  const m5 = maskRoute(decision("semantic", [VECTOR_TOOL]), { sql: false, vector: false, graph: true });
  ok(m5.route === "graph" && m5.tools.join() === [ONTOLOGY_TOOL, GRAPH_TOOL].join(), "원하는 레인이 하나도 없으면 있는 레인 가운데 첫째");

  // routeQuery 가 가린다(route 도구, retrieve, ask 가 모두 이 길을 거친다).
  const q = "환불 정책 문서에 뭐라고 써 있어?";
  setAvailableLanes(undefined);
  const before = await routeQuery(q);
  ok(before.route === "semantic", `전제: 규칙은 이 질문을 문서 레인으로 보낸다 (got ${before.route})`);
  ok(JSON.stringify(before) === JSON.stringify(route(q)), "레인을 재지 않았으면 규칙 결정 그대로");
  setAvailableLanes(SQL_ONLY);
  const after = await routeQuery(q);
  ok(after.route === "structured" && /lanes in this database: sql -> structured$/.test(after.rationale), `정형 전용 DB 에서는 정형으로 (got ${after.route}, ${after.rationale})`);

  // 다른 길로 온 결정도 없는 레인을 돌리지 않는다.
  const l = lanesFor({ route: "hybrid", tools: [SQL_TOOL, VECTOR_TOOL, GRAPH_TOOL] });
  ok(l.sql && !l.vector && !l.graph, "lanesFor 는 없는 레인을 끈다");
  setAvailableLanes(undefined);
  const l2 = lanesFor({ route: "hybrid", tools: [SQL_TOOL, VECTOR_TOOL, GRAPH_TOOL] });
  ok(l2.sql && l2.vector && l2.graph, "레인을 재지 않았으면 결정대로");

  // 빈손일 때의 다음 순위 레인도 이 DB 에 있는 레인 가운데서 고른다.
  const sem3 = (scores: Record<Lane, number>) => ({ lane: "nl2sql" as Lane, margin: 0.03, scores, nearest: { lane: "nl2sql" as Lane, type: "t", text: "a", score: scores.nl2sql }, applied: true });
  const d = decision("structured", [SQL_TOOL], { semantic: sem3({ nl2sql: 0.7, vector_search: 0.66, knowledge_graph: 0.6 }) });
  ok(runnerUp("q", d, "0 rows")?.route === "semantic", "전제: 세 레인이면 시맨틱 2위(문서)로 간다");
  setAvailableLanes({ sql: true, vector: false, graph: true });
  ok(runnerUp("q", d, "0 rows")?.route === "graph", "문서 레인이 없으면 그다음(그래프)");
  setAvailableLanes(SQL_ONLY);
  ok(runnerUp("q", d, "0 rows") === undefined, "정형 레인만 있으면 다음 순위가 없다");
  setAvailableLanes(undefined);
}

// ---------- 카탈로그로 만드는 카드 ----------
type Col = { table: string; column: string; type: string; comment: string | null; pk?: boolean; ref?: string };
function catalogDb(tables: string[], cols: Col[], tableComments: Record<string, string> = {}): Queryable {
  return {
    async query(text: string, values?: unknown[]) {
      if (/table_type = 'BASE TABLE'/.test(text)) return { rows: tables.map((t) => ({ table_name: t })) };
      if (/pg_attribute/.test(text)) {
        const want = (values?.[1] as string[]) ?? [];
        return {
          rows: cols
            .filter((c) => want.includes(c.table))
            .map((c) => ({
              table_name: c.table,
              table_comment: tableComments[c.table] ?? null,
              column_name: c.column,
              column_type: c.type,
              column_comment: c.comment,
              is_pk: c.pk === true,
              ref_schema: c.ref ? "public" : null,
              ref_table: c.ref ?? null,
              ref_column: c.ref ? `${c.ref}_id` : null,
            })),
        };
      }
      throw new Error(`unexpected query: ${text}`);
    },
  };
}
{
  const tables = ["customer", "documents", "invoice"];
  const bare: Col[] = [
    { table: "customer", column: "customer_id", type: "integer", comment: null, pk: true },
    { table: "customer", column: "country", type: "character varying(40)", comment: null },
    { table: "customer", column: "phone", type: "character varying(24)", comment: null },
    { table: "invoice", column: "invoice_id", type: "integer", comment: null, pk: true },
    { table: "invoice", column: "customer_id", type: "integer", comment: null, ref: "customer" },
    { table: "invoice", column: "total", type: "numeric(10,2)", comment: null },
  ];
  ok(/아직 만들지 않았다/.test(catalogSchemaCard("public")), "기동 전에는 자리표시");

  const plain = await loadCatalogSchemaCard(catalogDb(tables, bare), "public", ["documents"]);
  ok(plain.kind === "plain" && plain.reason === "컬럼 주석이 하나도 없다", `주석이 없으면 열 이름과 타입만 실은 카드 (got ${plain.kind}, ${plain.reason})`);
  ok(plain.tables === 2 && plain.columns === 6 && plain.omitted.length === 0, `문서 표는 빼고 모든 컬럼을 싣는다 (got ${plain.tables}, ${plain.columns})`);
  ok(!/documents/.test(plain.card), "레인 표는 정형 카드에 없다");
  ok(
    plain.card.includes("CREATE TABLE public.customer (\n  customer_id int PRIMARY KEY,\n  country text,\n  phone text\n);") &&
      plain.card.includes("  customer_id int REFERENCES public.customer(customer_id),") &&
      plain.card.includes("  total numeric\n);"),
    `열 이름, 짧은 타입, 키를 주석 카드와 같은 꼴로 싣는다 (got ${plain.card})`,
  );
  ok(catalogSchemaCard("public") === plain.card && catalogSchemaCard("shop") !== plain.card, "만든 카드는 그 스키마에만 쓴다");
  env({ DATASET: "catalog", CATALOG_SCHEMA: "public" });
  ok(profile().schemaCard === plain.card, "프로파일의 카드(MCP 스키마 리소스, 생성 프롬프트)는 기동 때 만든 카드다");
  restoreEnv();

  const half = bare.map((c) => (c.table === "customer" && c.column === "country" ? { ...c, comment: "고객이 사는 나라" } : c));
  const h = await loadCatalogSchemaCard(catalogDb(tables, half), "public", ["documents"]);
  ok(h.kind === "plain" && h.reason === "컬럼 주석이 없는 표가 있다: invoice", `반쪽 주석이면 열 이름 카드로 돌고 이유를 남긴다 (got ${h.reason})`);
  ok(h.card.includes("  country text,  -- 고객이 사는 나라"), "열 이름 카드에도 있는 주석은 붙인다");

  const done = half.map((c) => (c.column === "total" ? { ...c, comment: "송장 합계, 달러" } : c));
  const cm = await loadCatalogSchemaCard(catalogDb(tables, done), "public", ["documents"]);
  ok(cm.kind === "comments" && cm.reason === undefined, "모든 표에 주석이 있으면 주석 카드");
  ok(cm.columns === 5 && cm.omitted.join() === "customer.phone", `주석도 키도 아닌 컬럼은 뺀다 (got ${cm.columns}, ${cm.omitted.join()})`);
  ok(cm.card.includes("  total numeric  -- 송장 합계, 달러") && !cm.card.includes("phone"), "주석 카드는 검토한 컬럼과 키만");

  const empty = await loadCatalogSchemaCard(catalogDb([], []), "nothing", []);
  ok(empty.tables === 0 && empty.kind === "plain", "표가 없는 스키마는 표 0개로 알린다(서버가 기동 로그에 적는다)");

  // 두 카드가 같은 카탈로그에서 어긋나지 않는다.
  const cat: Catalog = {
    tables: [{ table: "t", comment: null }],
    columns: [{ table: "t", column: "a", type: "integer", comment: "뜻", pk: true, ref: null }],
  };
  const c1 = buildCommentCard("s", ["t"], cat);
  ok(c1.ok && c1.value.card === buildPlainCard("s", ["t"], cat).card, "모든 컬럼에 주석이 있으면 두 카드가 같다");
}

// ---------- 초안 머리말 ----------
{
  const meta = { generatedAt: "2026-10-20T00:00:00Z", endpoint: "localhost:5433/chinook" };
  const other = renderDraft("public", [], meta);
  ok(!other.includes("Company-X") && !other.includes("sql/companyx/comments.sql") && other.includes("그 DB 에 건다"), "다른 DB 의 초안은 그 DB 에 거는 절차를 적는다");
  const cx = renderDraft("companyx", [], meta);
  ok(cx.startsWith("-- Company-X 컬럼 주석 초안") && cx.includes("sql/companyx/comments.sql"), "사업자 데이터셋 초안은 저장소의 검토본으로 옮긴다");
}

// ---------- 읽기 역할 ----------
function roleDb(o: { role: boolean; member: boolean; usage: boolean; denied: string[]; login?: string }): Queryable {
  return {
    async query(text: string, values?: unknown[]) {
      if (/pg_roles/.test(text)) return { rows: [{ login: o.login ?? "app", role: o.role, member: o.role && o.member }] };
      if (/has_schema_privilege/.test(text)) return { rows: [{ ok: o.usage }] };
      if (/has_table_privilege/.test(text)) return { rows: ((values?.[1] as string[]) ?? []).filter((t) => o.denied.includes(t)).map((t) => ({ t })) };
      throw new Error(`unexpected query: ${text}`);
    },
  };
}
{
  const card = ["customer", "invoice"];
  ok((await readRoleProblems(roleDb({ role: true, member: true, usage: true, denied: [] }), "public", card)).length === 0, "역할, 구성원, 권한이 다 있으면 알릴 것이 없다");
  const none = await readRoleProblems(roleDb({ role: false, member: false, usage: false, denied: [], login: "App User" }), "shop", card);
  ok(
    none.length === 1 &&
      none[0].includes("CREATE ROLE mcp_ro NOLOGIN;") &&
      none[0].includes("GRANT USAGE ON SCHEMA shop TO mcp_ro;") &&
      none[0].includes("GRANT SELECT ON ALL TABLES IN SCHEMA shop TO mcp_ro;") &&
      none[0].endsWith('GRANT mcp_ro TO "App User";'),
    `역할이 없으면 만들고 권한을 주는 SQL 을 한 줄로 (got ${none[0]})`,
  );
  const nm = await readRoleProblems(roleDb({ role: true, member: false, usage: true, denied: [] }), "public", card);
  ok(nm.length === 1 && nm[0].endsWith("GRANT mcp_ro TO app;"), `접속 사용자가 구성원이 아니면 역할을 준다 (got ${nm[0]})`);
  const nu = await readRoleProblems(roleDb({ role: true, member: true, usage: false, denied: ["invoice"] }), "public", card);
  ok(
    nu.length === 1 && /public 스키마를 쓸 수 없어/.test(nu[0]) && nu[0].includes("GRANT SELECT ON ALL TABLES IN SCHEMA public TO mcp_ro;"),
    "스키마를 쓸 수 없으면 표를 따로 세지 않고 두 GRANT 를 준다",
  );
  const many = ["a", "b", "c", "d", "e", "f", "g"];
  const nt = await readRoleProblems(roleDb({ role: true, member: true, usage: true, denied: many }), "public", many);
  ok(nt.length === 1 && nt[0].includes("표 7개(a, b, c, d, e …)") && nt[0].endsWith("GRANT SELECT ON ALL TABLES IN SCHEMA public TO mcp_ro;"), `읽지 못하는 표는 수와 앞 다섯 개 (got ${nt[0]})`);
  const docs = await readRoleProblems(roleDb({ role: true, member: true, usage: true, denied: ["documents"] }), "public", card);
  ok(docs.length === 0, "정형 카드에 없는 표(문서 레인 표)는 보지 않는다. 그 표는 접속 사용자로 읽는다");
}

// ---------- 연결 실패 안내 ----------
{
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => void lines.push(a.join(" "));
  env({ DATASET: "catalog", CATALOG_SCHEMA: "public" });
  logConnectionFailure("connect ECONNREFUSED 10.0.0.9:5432 (catalog.test 1)", "postgresql://u:secret@10.0.0.9:5432/shop");
  env({ DATASET: "companyx" });
  logConnectionFailure("connect ECONNREFUSED 10.0.0.9:5432 (catalog.test 2)", "postgresql://u:secret@10.0.0.9:5432/shop");
  console.error = orig;
  restoreEnv();
  ok(lines.length === 2, `두 번 남긴다 (got ${lines.length})`);
  ok(
    lines[0].includes("docs/connect-your-db.md") && !lines[0].includes("companyx:load") && !lines[0].includes("docker compose"),
    `다른 회사 DB 는 그 DB 를 가리키는지부터 보게 한다 (got ${lines[0]})`,
  );
  ok(lines[1].includes("npm run companyx:load") && !lines[1].includes("connect-your-db"), "사업자 데이터셋은 종전 안내 그대로");
  ok(!lines.join("|").includes("secret"), "비밀번호는 로그에 남기지 않는다");
}

// ---------- 점검 세트 채점(catalogcheck.ts) ----------
{
  ok(hasValue("미국, 캐나다, 프랑스 순입니다", "USA") && !hasValue("미국, 캐나다", "Brazil"), "나라 이름은 한국어로 옮겨 적어도 받는다");
  ok(hasValue("담당 고객은 21명입니다", "21") && !hasValue("2021년 매출입니다", "21"), "수는 다른 수 안에서 찾지 않는다");
  ok(hasValue("합계는 1,234.5달러", "1234.50") && hasValue("523.060 달러", "523.06") && !hasValue("523.6 달러", "523.06"), "수는 값으로 견준다(끝의 0, 천 단위 쉼표)");
  ok(hasValue("Jane Peacock 이 21명", "jane peacock") && !hasValue("Jane 이 21명", "Jane Peacock"), "글자는 대소문자만 가리지 않는다");
  ok(cellKey("523.060") === "523.06" && cellKey("1,234") === "1234" && cellKey("2024-01-01 00:00:00") === "2024-01-01" && cellKey(" USA ") === "usa", "칸 값을 맞춘다");
  ok(rowsExact([["USA", "523.06"]], [["523.060", "usa"]]) && !rowsExact([["USA", "523.06"], ["x", "1"]], [["USA", "523.06"]]), "같은 행인지는 순서를 보지 않고 행 수는 본다");
  ok(rowsCover([["Jane", "Peacock", "21"]], [["Jane Peacock", "21"]]), "이름과 성을 두 열로 고른 행도 받는다");
  ok(rowsCover([["Jane Peacock", "21", "3"]], [["Jane Peacock", "21"]]) && !rowsCover([["Jane Peacock", "20"]], [["Jane Peacock", "21"]]), "묻지 않은 열은 받고 다른 값은 받지 않는다");
  ok(!rowsCover([["a", "1"]], [["a", "1"], ["b", "2"]]) && !rowsCover([["a", "1"], ["a", "1"]], [["a", "1"], ["b", "2"]]), "행 수가 다르거나 한 행을 두 번 짝짓지 않는다");
  const line = (o: Record<string, unknown>) => JSON.stringify({ id: "C01", question: "q", difficulty: "simple", gold_sql: "SELECT 1", gold_rows: [["1"]], must: ["1"], ...o });
  ok(parseCheckSet(`${line({})}\n\n${line({ id: "C02" })}\n`).length === 2, "빈 줄은 건너뛴다");
  ok(throws(() => parseCheckSet(line({ must: [] })), /1행: must/), "답에 있어야 할 값이 없는 문항은 거절한다");
  ok(throws(() => parseCheckSet(`${line({})}\n${line({ gold_rows: "x" })}`), /2행: gold_rows/), "정답 행이 배열이 아니면 그 줄 번호로 거절한다");
}

console.log(`\ncatalog.test: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
