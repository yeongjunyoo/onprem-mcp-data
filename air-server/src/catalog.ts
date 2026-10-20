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

// 다른 회사 DB(catalog 프로파일)를 붙일 때 기동 때 재는 것: 이 DB 에 있는 레인과 읽기 전용 역할의 권한.
//
// 레인. 다른 회사 DB 는 정형 표만 있는 경우가 많다. 라우터의 규칙과 앵커는 사업자 데이터셋의
// 세 레인을 전제로 하므로, 없는 레인으로 보내면 그 갈래는 「표가 없다」 오류로 끝나고 답은 남은 갈래에서만 나온다. 그래서 기동 때
// 레인 표가 있는지 재고, 라우팅 결정에서 없는 레인을 빼고 그 사실을 근거(rationale)에 적는다. 사업자 데이터셋 프로파일은 세 레인이
// 다 있어 재지 않는다(undefined 면 가리지 않는다).
//
// 읽기 역할. 생성 모델이 쓴 SQL 은 READ ONLY 거래 안에서 mcp_ro 로 강등해 돈다(sql.ts). 새 DB 에서 그 역할이 정형 카드의 표를
// 읽지 못하면 정형 질문마다 permission denied 로 끝나므로, 기동 때 막히는 곳을 고칠 SQL 과 함께 알린다(readRoleProblems). 문서와
// 그래프 레인은 코드가 짠 질의라 접속 사용자로 읽는다(vector.ts, graph.ts). 그 표는 이 점검의 대상이 아니다.
import { GRAPH_TOOL, ONTOLOGY_TOOL, SQL_TOOL, VECTOR_TOOL, type RouteDecision } from "./router.js";
import type { Queryable } from "./schemacomments.js";

export interface LaneSet {
  sql: boolean;
  vector: boolean;
  graph: boolean;
}

type Lane = keyof LaneSet;

let available: LaneSet | undefined;

/** 이 DB 에 있는 레인. catalog 프로파일만 기동 때 정한다. undefined 면 세 레인이 다 있다고 본다. */
export function availableLanes(): LaneSet | undefined {
  return available;
}

export function setAvailableLanes(lanes: LaneSet | undefined): void {
  available = lanes;
}

/** 그래프 레인이 읽는 표(graph.ts). */
export const GRAPH_TABLES = ["entities", "aliases", "relations"] as const;

/** 문서 레인은 embedding 열이 있는 문서 표, 그래프 레인은 GRAPH_TABLES 세 표가 있어야 쓴다. 정형 레인은 늘 있다. */
export async function detectLanes(
  db: Queryable,
  p: { vectorTable: string; kgSchema: string },
): Promise<LaneSet & { why: { vector: string; graph: string } }> {
  const [vs, vt] = p.vectorTable.split(".");
  const vec = await db.query(
    "SELECT 1 FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND column_name = 'embedding'",
    [vs, vt],
  );
  const kg = await db.query("SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name = ANY ($2::text[])", [
    p.kgSchema,
    [...GRAPH_TABLES],
  ]);
  const have = new Set((kg.rows as { table_name: string }[]).map((r) => r.table_name));
  const missing = GRAPH_TABLES.filter((t) => !have.has(t));
  const vector = vec.rows.length > 0;
  return {
    sql: true,
    vector,
    graph: missing.length === 0,
    why: {
      vector: vector ? `${p.vectorTable}` : `${p.vectorTable} 에 embedding 열이 없다`,
      graph: missing.length === 0 ? `${p.kgSchema}` : `${p.kgSchema} 에 ${missing.join(", ")} 표가 없다`,
    },
  };
}

/** SQL 에 적을 이름. 소문자 식별자가 아니면 큰따옴표로 싼다. */
const ident = (s: string) => (/^[a-z_][a-z0-9_]*$/.test(s) ? s : `"${s.replace(/"/g, '""')}"`);

/** mcp_ro 가 정형 카드의 표(schema 의 tables)를 읽지 못하게 막는 것들. 문장마다 무엇이 막히는지와 고칠 SQL 을 적는다. 막히는 것이
 * 없으면 빈 배열이다. 역할이 없으면 질의는 READ ONLY 거래로만 돌고 역할 강등은 하지 않는다(sql.ts hasRoRole). 접속 사용자가 그 역할의
 * 구성원이 아니거나 역할에 스키마 사용 권한, 표 읽기 권한이 없으면 정형 질의마다 실패한다. */
export async function readRoleProblems(db: Queryable, schema: string, tables: readonly string[]): Promise<string[]> {
  const r = await db.query(
    "SELECT current_user AS login, r.oid IS NOT NULL AS role, r.oid IS NOT NULL AND pg_has_role(current_user, r.oid, 'MEMBER') AS member " +
      "FROM (SELECT 1) x LEFT JOIN pg_roles r ON r.rolname = 'mcp_ro'",
  );
  const { login, role, member } = r.rows[0] as { login: string; role: boolean; member: boolean };
  const grants = `GRANT USAGE ON SCHEMA ${schema} TO mcp_ro; GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO mcp_ro;`;
  if (!role) {
    return [`mcp_ro 역할이 없다. 질의는 READ ONLY 거래로만 돌고 역할 강등은 하지 않는다. 만들려면: CREATE ROLE mcp_ro NOLOGIN; ${grants} GRANT mcp_ro TO ${ident(login)};`];
  }
  const out: string[] = [];
  if (!member) out.push(`접속 사용자 ${login} 이 mcp_ro 로 바꿀 수 없어 정형 질의마다 실패한다: GRANT mcp_ro TO ${ident(login)};`);
  const u = await db.query("SELECT has_schema_privilege('mcp_ro', $1, 'USAGE') AS ok", [schema]);
  if (!(u.rows[0] as { ok: boolean }).ok) {
    out.push(`mcp_ro 가 ${schema} 스키마를 쓸 수 없어 정형 질의마다 permission denied 로 끝난다: ${grants}`);
    return out;
  }
  const t = await db.query(
    "SELECT t FROM unnest($2::text[]) AS t WHERE NOT has_table_privilege('mcp_ro', format('%I.%I', $1::text, t), 'SELECT') ORDER BY t",
    [schema, [...tables]],
  );
  const names = (t.rows as { t: string }[]).map((x) => x.t);
  if (names.length) {
    const shown = names.slice(0, 5).join(", ") + (names.length > 5 ? " …" : "");
    out.push(`mcp_ro 가 읽지 못하는 ${schema} 의 표 ${names.length}개(${shown}): GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO mcp_ro;`);
  }
  return out;
}

/** 정형 카드에 싣지 않을 표: sqlSchema 안에 있는 문서 레인 표와 그래프 레인 표. */
export function laneTablesIn(p: { sqlSchema: string; vectorTable: string; kgSchema: string }): string[] {
  const [vs, vt] = p.vectorTable.split(".");
  return [...(vs === p.sqlSchema ? [vt] : []), ...(p.kgSchema === p.sqlSchema ? GRAPH_TABLES : [])];
}

const ROUTE_LANE: Record<Exclude<RouteDecision["route"], "hybrid">, Lane> = { structured: "sql", semantic: "vector", graph: "graph" };
const LANE_ROUTE: Record<Lane, RouteDecision["route"]> = { sql: "structured", vector: "semantic", graph: "graph" };
const LANE_TOOLS: Record<Lane, string[]> = { sql: [SQL_TOOL], vector: [VECTOR_TOOL], graph: [ONTOLOGY_TOOL, GRAPH_TOOL] };
const ORDER: Lane[] = ["sql", "vector", "graph"];

/** 결정이 여는 레인에서 이 DB 에 없는 레인을 뺀다. 남는 레인이 없으면 있는 레인 가운데 첫째(정형)로 보낸다. 바뀐 결정은 근거 끝에
 * 「lanes in this database: … -> 경로」를 단다. 가릴 것이 없으면 결정을 그대로 돌려준다. */
export function maskRoute(d: RouteDecision, a: LaneSet | undefined = available): RouteDecision {
  if (!a) return d;
  const wanted: Lane[] =
    d.route === "hybrid" ? ["sql", "vector", ...(d.tools.includes(GRAPH_TOOL) ? (["graph"] as Lane[]) : [])] : [ROUTE_LANE[d.route]];
  const kept = wanted.filter((l) => a[l]);
  if (kept.length === wanted.length) return d;
  const here = ORDER.filter((l) => a[l]);
  const lanes = kept.length ? kept : here.slice(0, 1);
  const route = lanes.length > 1 ? "hybrid" : LANE_ROUTE[lanes[0]];
  return {
    ...d,
    route,
    tools: lanes.flatMap((l) => LANE_TOOLS[l]),
    graphPlan: lanes.includes("graph") ? d.graphPlan : undefined,
    rationale: `${d.rationale}; lanes in this database: ${here.join(", ")} -> ${route}`,
  };
}
