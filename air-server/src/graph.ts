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

// L? — knowledge-graph retrieval over the relational KG (entities/aliases/relations).
//
// Two read-only primitives, both safe under mcp_ro:
//   ontologySearch — resolve NL terms to canonical entities via alias/canonical_name
//                    (e.g. "전자제품" -> 전자기기 category entity). This is what makes
//                    the graph branch answer queries SQL/vector cannot.
//   graphExpand    — BFS the typed relation edges from a seed entity, returning edges
//                    with provenance (e.g. 환불 정책 -applies_to-> 전자기기).
//
// Results convert to the canonical Candidate contract so RRF fuses graph hits with
// SQL/vector hits by the SAME entity identity (named 3-way agreement).

import type { Pool } from "./db.js";
import { type Candidate, entityKey } from "./candidate.js";
import { profile } from "./profile.js";
import { describeError } from "./errors.js";
import { classifyNotFound, entityLikeName, similarNames, type NotFound } from "./notfound.js";
import { identifyingAliases, isEntityName } from "./router.js";

const IDENT = /^[a-z_][a-z0-9_]*$/;
function safeSchema(schema: string): string {
  if (!IDENT.test(schema)) throw new Error(`unsafe schema identifier: ${schema}`);
  return schema;
}

/** KG schema of the active dataset profile (see profile.ts).
 * One selector for every tool, so the graph lane can never point at a different
 * corpus than the SQL and vector lanes. */
export function kgSchema(): string {
  return safeSchema(profile().kgSchema);
}

/** 라우터 엔티티 사전의 원천. entities는 개체명과 타입, relations는 타입쌍을 준다.
 *
 * 운영에서 이 목록은 고객사 자신의 DB에 있으므로 별도 배포물이 없다. 실패하면
 * 빈 결과를 돌려주고, 호출부가 그것을 경고로 남긴다(조용한 성능 저하 금지). */
export async function loadOntologyForRouter(
  pool: Pool,
  schema = kgSchema(),
): Promise<{
  nodes: { id: string; name: string; type: string }[];
  edges: { source: string; target: string; relation: string }[];
}> {
  const s = safeSchema(schema);
  const nodes = (
    await pool.query(`SELECT id, type, canonical_name FROM ${s}.entities`)
  ).rows.map((r) => ({ id: String(r.id), name: String(r.canonical_name), type: String(r.type) }));

  // 별칭은 한 개체만 가리키는 것만 사전에 넣는다. 여러 개체가 나눠 가진 별칭은 지역, 업종
  // 같은 속성 값이다(identifyingAliases). 없으면 무시한다.
  try {
    const aliases = (
      await pool.query(
        `SELECT a.entity_id, a.alias, e.type
           FROM ${s}.aliases a JOIN ${s}.entities e ON e.id = a.entity_id`,
      )
    ).rows.map((r) => ({ id: String(r.entity_id), name: String(r.alias), type: String(r.type) }));
    nodes.push(...identifyingAliases(aliases));
  } catch {
    /* aliases 테이블이 없는 배포도 있다 — 정본 이름만으로 동작한다 */
  }

  const edges = (
    await pool.query(
      `SELECT src_entity_id, dst_entity_id, rel_type FROM ${s}.relations`,
    )
  ).rows.map((r) => ({
    source: String(r.src_entity_id),
    target: String(r.dst_entity_id),
    relation: String(r.rel_type),
  }));

  return { nodes, edges };
}

export interface OntologyHit {
  entityId: number;
  type: string;
  canonicalName: string;
  via: "canonical" | "alias";
  matched: string;
  /** 5 = 여러 낱말로 된 정본 이름이 질문에 통째로 있음, 4 = exact canonical name,
   * 3 = exact alias, 2 = prefix, 1 = substring. Ranks
   * seeds so a query naming "Product-C1" seeds THAT product instead of the first 5
   * rows containing "product", and "경영지원팀" seeds the department rather than its
   * members (who carry the same string as a property alias). */
  score: number;
  properties?: Record<string, unknown>;
}

/** Seed tokens for entity resolution.
 * Keeps hyphenated sponsor ids intact ("Product-C1" must not become product + c1)
 * and drops the relation/type vocabulary, which names EDGES and TYPES, not nodes. */
const SEED_TOKEN = /[A-Za-z][A-Za-z0-9]*(?:[-_][A-Za-z0-9]+)*|[가-힣]{2,}/g;
const SEED_STOP = new Set([
  "사용", "사용중", "사용하는", "소속", "담당", "담당자", "이끄는", "맡은", "팀장", "부서장",
  "제품", "고객", "고객사", "직원", "부서", "프로젝트", "계약", "이슈", "목록", "현황", "관련",
  "관련된", "누구", "어디", "무엇", "얼마", "가장", "많은", "적은", "진행", "중인", "알려줘",
  "보여줘", "궁금해", "엔지니어", "지원",
  // 서수, 의문 낱말, 정도 부사와 서술어. 「계약을 두 번째로 많이 담당한 직원은 누구야?」의 「번째」를
  // 데이터에 없는 개체로 답했다(랜덤 테스트 사전 점검 D5). 낱말 자체는 어떤 개체 이름에도 없다.
  "번째", "몇", "어느", "많이", "적게", "담당한", "담당하는", "누구야", "어디야", "뭐야", "언제야", "얼마야",
  // 영어 의문사와 기능어(「Who manages the Samsung account?」의 「Who」). 소문자로 대조한다.
  "who", "what", "which", "where", "when", "why", "how", "the", "an", "is", "are", "was", "were", "do",
  "does", "did", "of", "for", "to", "in", "on", "and", "or", "with", "by", "from", "me", "show", "list",
  "tell", "give", "please", "all", "many", "much", "most", "manage", "manages", "managed", "use", "uses",
  "used", "using", "account", "accounts",
  // 유형 낱말 단독(「Client A」의 「Client」)은 모든 고객사에 부분 일치해 시드가 다섯으로 퍼졌다(D4).
  "client", "clients", "product", "products", "customer", "customers", "employee", "employees",
  "project", "projects",
]);
/** 서수(「두번째」, 「셋째」). 조사를 뗀 뒤 대조한다. */
const ORDINAL = /^(?:[첫두세네]|다섯|여섯|일곱|여덟|아홉|열|몇)?번째$|^(?:첫|둘|셋|넷)째$/;

/** 「Client A」, 「product c1」처럼 하이픈 대신 띄어 쓴 사업자 식별자를 「Client-A」, 「Product-C1」로.
 * 띄어 쓰면 한 글자 토큰(A)이 버려지고 남은 「Client」가 고객사 전부에 걸렸다(D4: 「Client A 담당 엔지니어」에
 * 담당자 둘 중 하나만 답함). 고객사 식별자는 대문자 한두 자, 제품 식별자는 영문 한 자와 숫자만 합친다
 * (「client is」는 합치지 않는다).
 *
 * 소문자로 띄어 쓴 것(「client b」), 하이픈 없이 붙인 것(「ClientA」), 밑줄로 이은 것(「Client_A」)은 합친 이름이
 * 온톨로지 사전에 있을 때만 합친다(router.ts isEntityName). 「client b 담당자 누구야?」는 시드 낱말이 하나도 남지 않아
 * 「알 수 없습니다」였고, 「ClientA」는 「찾지 못했습니다」였다(랜덤 테스트 사전 점검 2차 R10, 회색 F10). 붙여 쓴 고객사
 * 식별자는 대문자일 때만 본다(「clients」가 Client-S 가 되지 않게). */
export function joinSpacedIds(query: string): string {
  return query.replace(/\b(client|product)([\s_]*)([A-Za-z]{1,2}\d{0,2})(?![A-Za-z0-9])/gi, (m, type: string, sep: string, id: string) => {
    const client = /^client$/i.test(type);
    const name = `${type[0].toUpperCase()}${type.slice(1).toLowerCase()}-${id.toUpperCase()}`;
    const spaced = /^\s+$/.test(sep);
    if (spaced && (client ? /^[A-Z]{1,2}$/.test(id) : /^[A-Za-z]\d{1,2}$/.test(id))) return name;
    if (sep === "" && (client ? !/^[A-Z]{1,2}$/.test(id) || type === "CLIENT" : !/^[A-Za-z]\d{1,2}$/.test(id))) return m;
    return isEntityName(name) ? name : m;
  });
}

export function seedTerms(query: string): string[] {
  const out = new Set<string>();
  for (const raw of joinSpacedIds(query).match(SEED_TOKEN) ?? []) {
    const w = raw.replace(/(은|는|이|가|을|를|에|의|와|과|도|로|으로|에서|에게|까지|부터|만)$/, "");
    if (w.length < 2 || SEED_STOP.has(w) || SEED_STOP.has(w.toLowerCase()) || ORDINAL.test(w)) continue;
    out.add(w);
  }
  return [...out];
}

/** LIKE, ILIKE 패턴에 넣을 낱말. 역슬래시, %, _ 를 글자 그대로 찾게 앞에 역슬래시를 붙인다(PostgreSQL 의 기본 이스케이프 문자). */
export function likeLiteral(term: string): string {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export interface OntologyResult {
  ok: boolean;
  hits: OntologyHit[];
  /** 질의어가 있는데 하나도 해소되지 않았을 때만. 왜 못 찾았는지(notfound.ts). */
  not_found?: NotFound;
  /** 다른 질의어는 해소됐는데 개체 이름처럼 생긴 질의어가 해소되지 않았을 때, 그 이름마다의 사유. */
  missing?: NotFound[];
  error?: string;
}

export { entityLikeName } from "./notfound.js";

/** 비슷한 이름 판정을 이름 후보로 쓰는 최소 길이. 두 글자 낱말(「재원」, 「현우」)은 세 글자 직원
 * 이름과 0.67 로 겹쳐 일반 낱말이 이름으로 잡힌다. notfound.ts 도 두 글자의 한 글자 차이는 넣지 않는다. */
const SIMILAR_MIN_LEN = 3;

/** Does this schema's entities table carry a `properties` jsonb column?
 * (companyx does — sponsor node properties; the internal bench does not.)
 * Cached per schema so the probe costs one query per process. */
const propsCache = new Map<string, boolean>();
async function hasProps(pool: Pool, s: string): Promise<boolean> {
  const cached = propsCache.get(s);
  if (cached !== undefined) return cached;
  const r = await pool.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = 'entities' AND column_name = 'properties'`,
    [s],
  );
  const has = r.rowCount === 1;
  propsCache.set(s, has);
  return has;
}

/** Resolve query terms to canonical entities via canonical_name / ext_id / alias,
 * RANKED (exact > prefix > substring) so the seed set is the entity the user named
 * rather than the first k rows that merely contain the word. */
export async function ontologySearch(
  pool: Pool,
  query: string,
  k = 5,
  schema = kgSchema(),
): Promise<OntologyResult> {
  try {
    const s = safeSchema(schema);
    const terms = seedTerms(query);
    if (terms.length === 0) return { ok: true, hits: [] };
    const props = await hasProps(pool, s);
    const propsCol = props ? "e.properties" : "NULL::jsonb";
    // canonical exact (4) outranks alias exact (3). "경영지원팀" is the department's
    // OWN name, while every employee of that department carries it as a property
    // alias; without the split the 6 employees tie with the department and the
    // shorter-name tiebreak evicts the department itself — so the HEAD_IS edge the
    // question asks for never enters the context.
    // LIKE 패턴에는 낱말을 글자 그대로 넣는다(t.pat, likeLiteral). 「Client_A」의 밑줄이 한 글자 와일드카드가 되어
    // Client-A 부터 Client-AD 까지 다섯이 같은 점수로 걸렸다(랜덤 테스트 사전 점검 2차 R12).
    const scoreExpr = (col: string, exact: number) => `CASE
            WHEN lower(${col}) = lower(t.term) THEN ${exact}
            WHEN lower(${col}) LIKE lower(t.pat) || '%' THEN 2
            ELSE 1 END`;
    // 여러 낱말로 된 이름(프로젝트 「Client-C DB 마이그레이션」)은 낱말로 쪼갠 대조로는
    // 통째로 잡히지 않는다. 「Client-C」가 고객사와 정확히 맞아 고객사가 시드가 되고,
    // 질문이 가리킨 프로젝트는 접두 일치 후보로 밀려 탐색되지 않았다(홀드아웃3 「Client-C DB
    // 마이그레이션, 누가 끌고 가는 거야?」). 이름이 질문에 그대로 있으면 가장 강한 시드다.
    const resolve = (ts: string[], limit: number, text: string) => pool.query(
      `WITH t AS (SELECT * FROM unnest($1::text[], $4::text[]) AS t(term, pat)),
            m AS (
              SELECT e.id, e.type, e.canonical_name, ${propsCol} AS properties,
                     'canonical'::text AS via, e.canonical_name AS matched, 5 AS score
                FROM ${s}.entities e
               WHERE e.canonical_name LIKE '% %'
                 AND strpos(lower($3::text), lower(e.canonical_name)) > 0
              UNION ALL
              SELECT e.id, e.type, e.canonical_name, ${propsCol} AS properties,
                     'canonical'::text AS via, t.term AS matched,
                     ${scoreExpr("e.canonical_name", 4)} AS score
                FROM ${s}.entities e JOIN t
                  ON e.canonical_name ILIKE '%' || t.pat || '%'
              UNION ALL
              SELECT e.id, e.type, e.canonical_name, ${propsCol},
                     'alias', t.term, ${scoreExpr("a.alias", 3)}
                FROM ${s}.entities e
                JOIN ${s}.aliases a ON a.entity_id = e.id
                JOIN t ON a.alias ILIKE '%' || t.pat || '%'
            )
       SELECT id, type, canonical_name, properties,
              (array_agg(via ORDER BY score DESC, via))[1] AS via,
              (array_agg(matched ORDER BY score DESC, matched))[1] AS matched,
              max(score) AS score
         FROM m
        GROUP BY id, type, canonical_name, properties
        ORDER BY max(score) DESC, length(canonical_name) ASC, id
        LIMIT $2`,
      [ts, limit, text, ts.map(likeLiteral)],
    );
    const res = await resolve(terms, k, joinSpacedIds(query));
    const hits: OntologyHit[] = res.rows.map((r) => ({
      entityId: Number(r.id),
      type: String(r.type),
      canonicalName: String(r.canonical_name),
      via: r.via as "canonical" | "alias",
      matched: String(r.matched),
      score: Number(r.score),
      properties: (r.properties ?? undefined) as Record<string, unknown> | undefined,
    }));
    // 정본 이름만 대조한다. 별칭에는 속성값(지역·직급·상태)이 섞여 있어 "서울물산"이
    // 지역 별칭 "서울"과 비슷하다는 식의 후보를 만든다. 사전 전체를 읽지만 해소되지 않은
    // 질의어가 있을 때만 돈다.
    const loadLexicon = async () =>
      (await pool.query(`SELECT canonical_name AS name, type FROM ${s}.entities`)).rows.map((r) => ({
        name: String(r.name),
        type: String(r.type),
      }));
    if (hits.length === 0) {
      return { ok: true, hits, not_found: classifyNotFound(terms, await loadLexicon()) };
    }
    // 섞인 질문: 「서울물산 담당 엔지니어와 Client-A가 사용 중인 제품」. Client-A 만 해소되고
    // 서울물산은 없는데, 종전에는 해소 0건일 때만 「없다」고 했다. 그래서 Client-A 의 담당자
    // 류서연이 서울물산의 담당자로 답에 나왔다(경계 실측 3/3). 해소되지 않은 질의어 가운데
    // 이름처럼 생긴 것(entityLikeName)이나 비슷한 이름이 있는 것만 「없는 개체」로 올린다.
    // hits 는 상위 k 개라 질의어마다 따로 확인한다 — 다른 질의어의 강한 일치에 밀려 보이지
    // 않을 뿐 해소되는 이름도 있다.
    const unmatched = terms.filter((t) => !hits.some((h) => h.matched.toLowerCase() === t.toLowerCase()));
    if (unmatched.length === 0) return { ok: true, hits };
    const lexicon = await loadLexicon();
    const missing: NotFound[] = [];
    for (const t of unmatched) {
      const name =
        entityLikeName(t) ?? ([...t].length >= SIMILAR_MIN_LEN && similarNames(t, lexicon).length ? t : null);
      if (!name) continue;
      if ((await resolve([name], 1, name)).rows.length) continue;
      missing.push(classifyNotFound([name], lexicon));
    }
    return missing.length ? { ok: true, hits, missing } : { ok: true, hits };
  } catch (err) {
    return { ok: false, hits: [], error: describeError(err) };
  }
}

export interface GraphEdge {
  srcId: number;
  srcName: string;
  srcType: string;
  relType: string;
  dstId: number;
  dstName: string;
  dstType: string;
  confidence: number;
  provenance: string;
  depth: number;
}

/** 탐색이 상한에 걸려 멈췄다는 표시. 예외가 아니라 결과의 상태다. */
export interface GraphTruncation {
  by: "hops" | "nodes" | "edges";
  limit: number;
}

export interface GraphResult {
  ok: boolean;
  edges: GraphEdge[];
  /** 상한 때문에 덜 탐색했으면 채운다. 비어 있으면 요청한 범위를 끝까지 봤다. */
  truncated?: GraphTruncation;
  error?: string;
}

export interface GraphLimits {
  maxHops: number;
  maxNodes: number;
  maxEdges: number;
}

function capFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  // 오타를 기본값으로 메우면 상한이 걸린 줄 알고 무한정 도는 서버가 된다.
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name}="${raw}" 는 1 이상의 정수여야 한다.`);
  return n;
}

/** 그래프 탐색 상한. 양방향 BFS 는 홉마다 이웃이 곱으로 늘어 큰 그래프에서는 비용이
 * 폭증한다. 홉·노드만으로는 허브 하나가 엣지 수십만 개를 가진 경우를 못 막으므로,
 * 한 번에 읽는 행 수도 엣지 상한으로 묶는다(SQL LIMIT).
 *
 * 기본값은 사업자 그래프 전체(133노드·354엣지)보다 크다. 정상 질의는 닿지 않는다. */
export const GRAPH_LIMITS: Readonly<GraphLimits> = Object.freeze({
  maxHops: capFromEnv("GRAPH_MAX_HOPS", 3),
  maxNodes: capFromEnv("GRAPH_MAX_NODES", 500),
  maxEdges: capFromEnv("GRAPH_MAX_EDGES", 2000),
});

export type Direction = "out" | "in" | "both";

/** 노드 속성 조건(router.ts GraphPlan.filter 와 같은 꼴). side 는 엣지의 출발(source)과 도착(target) 가운데 어느 끝을 보는지. */
export interface NodeFilter {
  side: "source" | "target";
  key: string;
  value: string;
}

/** BFS relation edges from a seed entity up to `depth`, optional rel_type filter.
 *
 * Direction matters and defaults to BOTH: half of the sponsor's graph questions are
 * reverse traversals ("Product-C1을 사용하는 고객사" = client -[USES]-> product read
 * backwards). An out-only expansion silently returns nothing for those, which is the
 * worst failure mode — a confident empty answer. Edges are emitted in a canonical
 * direction (src -rel-> dst) regardless of which way they were traversed.
 *
 * Bounded by `limits` (GRAPH_LIMITS). Hitting a cap stops the walk and reports
 * `truncated` — a silently cut result reads as "no such relation".
 *
 * `filter` keeps only edges whose endpoint on that side carries the property value (walk). */
export async function graphExpand(
  pool: Pool,
  entityId: number,
  depth = 1,
  relTypes?: string[],
  schema = kgSchema(),
  direction: Direction = "both",
  limits: GraphLimits = GRAPH_LIMITS,
  filter?: NodeFilter,
): Promise<GraphResult> {
  const requested = Math.max(1, Math.floor(depth) || 1);
  const d = Math.min(limits.maxHops, requested);
  const rel = relTypes && relTypes.length ? relTypes : null;
  return walk(pool, entityId, Array.from({ length: d }, () => rel), schema, direction, limits, requested > d, filter);
}

/** 홉마다 탈 엣지 타입을 따로 정한 탐색. hops[i] 가 i+1 번째 홉의 엣지 타입이다.
 * 「제품 → 그 제품을 쓰는 고객사 → 그 고객사의 프로젝트」처럼 경로가 정해진 질문은
 * 두 홉 모두 두 엣지를 허용하면 첫 홉에서 프로젝트 엣지를, 둘째 홉에서 다른 제품을
 * 끌어와 답이 아닌 것이 섞인다(router.ts fitPlanToSeed). */
export async function graphWalk(
  pool: Pool,
  entityId: number,
  hops: string[][],
  schema = kgSchema(),
  limits: GraphLimits = GRAPH_LIMITS,
  filter?: NodeFilter,
): Promise<GraphResult> {
  const levels = hops.slice(0, limits.maxHops).map((h) => (h.length ? h : null));
  return walk(pool, entityId, levels, schema, "both", limits, hops.length > limits.maxHops, filter);
}

/** filter 가 있으면 그 쪽 끝 개체가 같은 키에 다른 값을 가진 엣지는 타지 않는다. 그 키가 없는 개체(상태가 없는 고객사,
 * 직원, 제품)와 시드 자신은 거르지 않는다. 「Client-AC에서 진행 중인 프로젝트」의 진행 중(status=in_progress)은 시드의
 * 엣지에도 걸려야 한다. 종전에는 관계 스캔(relationScan)에만 걸려 보류(on_hold) 프로젝트가 진행 중으로 나왔다(랜덤
 * 테스트 사전 점검 2차 R4). 속성 열이 없는 스키마(bench)에서는 거르지 않는다. */
async function walk(
  pool: Pool,
  entityId: number,
  levels: (string[] | null)[],
  schema: string,
  direction: Direction,
  limits: GraphLimits,
  cutByHops: boolean,
  filter?: NodeFilter,
): Promise<GraphResult> {
  try {
    const s = safeSchema(schema);
    const f = filter && (await hasProps(pool, s)) ? filter : undefined;
    const [end, endId] = f?.side === "source" ? ["se", "r.src_entity_id"] : ["de", "r.dst_entity_id"];
    const filterSql = f
      ? `\n            AND (${endId} = $7 OR NOT COALESCE(${end}.properties ? $5, false) OR ${end}.properties ->> $5 = $6)`
      : "";
    const d = levels.length;
    const edges: GraphEdge[] = [];
    const seen = new Set<string>();
    const seenIds: number[] = [];
    const visited = new Set<number>([entityId]);
    let frontier = [entityId];
    let truncated: GraphTruncation | undefined;
    const match =
      direction === "out"
        ? "r.src_entity_id = ANY($1::int[])"
        : direction === "in"
          ? "r.dst_entity_id = ANY($1::int[])"
          : "(r.src_entity_id = ANY($1::int[]) OR r.dst_entity_id = ANY($1::int[]))";
    for (let level = 1; level <= d && frontier.length > 0 && !truncated; level++) {
      // 이미 담은 엣지는 SQL 에서 뺀다. 안 빼면 앞 단계 엣지가 LIMIT 을 차지해
      // 새 엣지가 없는데도 잘렸다고 보고한다. 한 줄 더 읽어 넘침을 확인한다.
      const room = limits.maxEdges - edges.length;
      const res = await pool.query(
        `SELECT r.id, r.src_entity_id, se.canonical_name AS src_name, se.type AS src_type, r.rel_type,
                r.dst_entity_id, de.canonical_name AS dst_name, de.type AS dst_type, r.confidence, r.provenance
           FROM ${s}.relations r
           JOIN ${s}.entities se ON se.id = r.src_entity_id
           JOIN ${s}.entities de ON de.id = r.dst_entity_id
          WHERE ${match}
            AND ($2::text[] IS NULL OR r.rel_type = ANY($2::text[]))
            AND NOT (r.id = ANY($3::int[]))${filterSql}
          ORDER BY r.id
          LIMIT $4`,
        [frontier, levels[level - 1], seenIds, room + 1, ...(f ? [f.key, f.value, entityId] : [])],
      );
      const overflow = res.rows.length > room;
      const rows = overflow ? res.rows.slice(0, room) : res.rows;
      const next: number[] = [];
      for (const row of rows) {
        const srcId = Number(row.src_entity_id);
        const dstId = Number(row.dst_entity_id);
        seenIds.push(Number(row.id));
        const key = `${srcId}-${row.rel_type}-${dstId}`;
        if (seen.has(key)) continue;
        // 새 노드를 들일 자리가 없으면 그 엣지는 버린다. 이미 방문한 노드끼리의 엣지는 담는다.
        const fresh = [...new Set([srcId, dstId])].filter((n) => !visited.has(n));
        if (visited.size + fresh.length > limits.maxNodes) {
          truncated ??= { by: "nodes", limit: limits.maxNodes };
          continue;
        }
        seen.add(key);
        edges.push({
          srcId,
          srcName: String(row.src_name),
          srcType: String(row.src_type),
          relType: String(row.rel_type),
          dstId,
          dstName: String(row.dst_name),
          dstType: String(row.dst_type),
          confidence: Number(row.confidence),
          provenance: String(row.provenance),
          depth: level,
        });
        for (const nid of fresh) {
          visited.add(nid);
          next.push(nid);
        }
      }
      // 읽은 행 안에서 노드 상한이 먼저 걸렸으면 그쪽이 결과를 자른 것이다(id 순).
      if (overflow) truncated ??= { by: "edges", limit: limits.maxEdges };
      frontier = next;
    }
    // 홉 상한은 요청이 상한을 넘었고 아직 안 펼친 노드가 남았을 때만 잘림이다.
    // 요청한 깊이에서 멈춘 것은 요청대로 한 것이다.
    if (!truncated && cutByHops && frontier.length > 0) {
      truncated = { by: "hops", limit: limits.maxHops };
    }
    return truncated ? { ok: true, edges, truncated } : { ok: true, edges };
  } catch (err) {
    return { ok: false, edges: [], error: describeError(err) };
  }
}

/** Relation-level retrieval: no entity seed, the RELATION itself is the query.
 *
 * "가장 많은 고객을 담당하는 직원은?" and "진행 중인 프로젝트를 이끄는 직원 목록" name an
 * edge type and a filter, never a node — entity-seeded traversal cannot start. This
 * scans one relation type, optionally filtering on a node property, and (for
 * superlatives) ranks endpoints by degree. Deterministic SQL; no model, no sampling. */
export interface RelationScanOptions {
  relTypes: string[];
  /** Rank endpoints by edge count on this side (superlative questions). */
  aggregate?: "source" | "target";
  /** asc 면 적은 쪽부터 센다. 그 쪽 타입의 개체 가운데 맞는 엣지가 하나도 없는 것도 0건으로 넣는다(「가장 적은」). */
  order?: "asc";
  /** Keep only edges whose endpoint carries this property value (e.g. status=in_progress). */
  filter?: { side: "source" | "target"; key: string; value: string };
  limit?: number;
}

export interface RelationScanResult {
  ok: boolean;
  edges: GraphEdge[];
  ranking: { entityId: number; name: string; type: string; count: number }[];
  error?: string;
}

export async function relationScan(
  pool: Pool,
  opts: RelationScanOptions,
  schema = kgSchema(),
): Promise<RelationScanResult> {
  try {
    const s = safeSchema(schema);
    const limit = Math.min(200, Math.max(1, Math.floor(opts.limit ?? 60)));
    const props = await hasProps(pool, s);
    const filterSql =
      opts.filter && props
        ? `AND ${opts.filter.side === "source" ? "se" : "de"}.properties ->> $2 = $3`
        : "";
    const params: unknown[] = [opts.relTypes];
    if (filterSql) params.push(opts.filter!.key, opts.filter!.value);

    const res = await pool.query(
      `SELECT r.src_entity_id, se.canonical_name AS src_name, se.type AS src_type, r.rel_type,
              r.dst_entity_id, de.canonical_name AS dst_name, de.type AS dst_type, r.confidence, r.provenance
         FROM ${s}.relations r
         JOIN ${s}.entities se ON se.id = r.src_entity_id
         JOIN ${s}.entities de ON de.id = r.dst_entity_id
        WHERE r.rel_type = ANY($1::text[]) ${filterSql}
        ORDER BY r.id`,
      params,
    );
    const edges: GraphEdge[] = res.rows.map((row) => ({
      srcId: Number(row.src_entity_id),
      srcName: String(row.src_name),
      srcType: String(row.src_type),
      relType: String(row.rel_type),
      dstId: Number(row.dst_entity_id),
      dstName: String(row.dst_name),
      dstType: String(row.dst_type),
      confidence: Number(row.confidence),
      provenance: String(row.provenance),
      depth: 1,
    }));

    const ranking: RelationScanResult["ranking"] = [];
    if (opts.aggregate) {
      const counts = new Map<number, { name: string; type: string; count: number }>();
      for (const e of edges) {
        const id = opts.aggregate === "source" ? e.srcId : e.dstId;
        const name = opts.aggregate === "source" ? e.srcName : e.dstName;
        const type = opts.aggregate === "source" ? e.srcType : e.dstType;
        const cur = counts.get(id) ?? { name, type, count: 0 };
        cur.count++;
        counts.set(id, cur);
      }
      const asc = opts.order === "asc";
      if (asc) {
        // 「가장 적은」은 엣지가 없는 개체(담당 고객사가 없는 직원)까지 센다. 그 쪽 끝에 이 관계로 나오는 타입의 개체 전부다.
        const end = opts.aggregate === "source" ? "src_entity_id" : "dst_entity_id";
        const all = await pool.query(
          `SELECT e.id, e.canonical_name, e.type
             FROM ${s}.entities e
            WHERE e.type IN (SELECT DISTINCT x.type
                               FROM ${s}.relations r JOIN ${s}.entities x ON x.id = r.${end}
                              WHERE r.rel_type = ANY($1::text[]))
            ORDER BY e.id`,
          [opts.relTypes],
        );
        for (const row of all.rows) {
          const id = Number(row.id);
          if (!counts.has(id)) counts.set(id, { name: String(row.canonical_name), type: String(row.type), count: 0 });
        }
      }
      ranking.push(
        ...[...counts.entries()]
          .map(([entityId, v]) => ({ entityId, ...v }))
          // count desc (asc 면 오름차순), then id asc: total order => zero run-to-run variance.
          .sort((a, b) => (asc ? a.count - b.count : b.count - a.count) || a.entityId - b.entityId),
      );
    }
    return { ok: true, edges: edges.slice(0, limit), ranking: ranking.slice(0, limit) };
  } catch (err) {
    return { ok: false, edges: [], ranking: [], error: describeError(err) };
  }
}

/** Convert ontology hits to canonical graph candidates (for 3-way RRF). */
export function ontologyCandidates(hits: OntologyHit[]): Candidate[] {
  return hits.map((h, i) => ({
    canonicalKey: entityKey(h.type, h.entityId),
    sourceKey: `graph#${i}`,
    source: "graph" as const,
    text: `[그래프] ${h.canonicalName} (${h.type}) — 별칭/이름 매칭 '${h.matched}'`,
    provenance: `ontology:${h.via}:${h.matched}`,
  }));
}

/** Korean surface form for each relation type.
 *
 * The raw edge label is the sponsor's SCREAMING_SNAKE identifier. Handing
 * "경영지원팀 -HEAD_IS-> 윤소연" to a 7B produced "주어진 정보로는 알 수 없습니다"
 * while the answer sat in its own context: the model did not read the identifier
 * as a predicate. The edge is the same edge; only its rendering changed.
 * Unknown types fall back to the raw label rather than being dropped. */
const REL_LABEL: Record<string, string> = {
  USES: "사용 중인 제품",
  BELONGS_TO: "소속 부서",
  HEAD_IS: "부서장",
  MANAGES_ACCOUNT: "담당 고객사",
  HAS_PROJECT: "진행 프로젝트",
  LEADS: "이끄는 프로젝트",
  REPORTED_ISSUE: "기술지원 이슈를 제기한 제품",
};

export function relLabel(relType: string): string {
  return REL_LABEL[relType] ?? relType;
}

/** Convert graph edges to canonical candidates keyed by the entity that ANSWERS.
 *
 * `seedId` is the entity the query named. The candidate's identity is the OTHER
 * endpoint, because that is the new information: for "Product-S1에 이슈를 제기한
 * 고객" the answers are the clients, not Product-S1. Keying every edge by its
 * destination made all 8 inbound edges share one canonicalKey, and RRF's
 * per-list dedupe (correctly) collapsed them into a single context line — the
 * model then reported that Product-S1 had no issues at all. Same edges, same
 * dedupe; the bug was calling eight different facts the same thing. */
export function edgeCandidates(edges: GraphEdge[], seedId?: number): Candidate[] {
  return edges.map((e, i) => {
    const seedIsDst = seedId !== undefined && e.dstId === seedId;
    const [keyType, keyId] = seedIsDst ? [e.srcType, e.srcId] : [e.dstType, e.dstId];
    return {
      canonicalKey: entityKey(keyType, keyId),
      sourceKey: `graph#e${i}`,
      source: "graph" as const,
      text: `[그래프] ${e.srcName}의 ${relLabel(e.relType)}: ${e.dstName} (${e.srcType}→${e.dstType}, ${e.relType})`,
      provenance: `relation:${e.relType}:${e.provenance}`,
    };
  });
}

/** 여러 시드에서 펼친 엣지를 후보로 바꾸되, 같은 답 개체에 닿은 엣지는 한 줄로 모은다.
 *
 * 후보의 정체는 답 개체다(edgeCandidates). 시드가 둘 이상이면 같은 답 개체에 서로 다른 엣지로 닿을 수
 * 있는데, RRF 는 한 목록 안에서 같은 정체를 한 번만 받으므로 둘째 엣지가 통째로 빠졌다. 홀드아웃3 #43
 * 「Product-S1하고 Product-C4 둘 다 쓰는 고객」에서 Client-N 은 두 제품을 다 쓰는데 컨텍스트에는 S1 줄만
 * 남았고, 7B 는 「없다」고 답했다. 사실을 버리지 않고 모은다: 「Client-N의 사용 중인 제품: Product-S1,
 * Product-C4」. 관계가 다르면 줄을 나눠 한 후보에 싣는다. 엣지가 하나뿐이면 edgeCandidates 와 같은 글이다. */
export function seedEdgeCandidates(groups: { edges: GraphEdge[]; seedId: number }[]): Candidate[] {
  interface Clause {
    relType: string;
    answerIsSrc: boolean;
    answerName: string;
    srcType: string;
    dstType: string;
    others: string[];
    provenance: string[];
  }
  const byKey = new Map<string, { sourceKey: string; clauses: Map<string, Clause> }>();
  let n = 0;
  for (const { edges, seedId } of groups) {
    for (const e of edges) {
      const answerIsSrc = e.dstId === seedId;
      const [type, id, name, other] = answerIsSrc
        ? [e.srcType, e.srcId, e.srcName, e.dstName]
        : [e.dstType, e.dstId, e.dstName, e.srcName];
      const key = entityKey(type, id);
      let entry = byKey.get(key);
      if (!entry) byKey.set(key, (entry = { sourceKey: `graph#e${n}`, clauses: new Map() }));
      n++;
      const ck = `${e.relType}|${answerIsSrc ? "in" : "out"}`;
      let c = entry.clauses.get(ck);
      if (!c) {
        c = { relType: e.relType, answerIsSrc, answerName: name, srcType: e.srcType, dstType: e.dstType, others: [], provenance: [] };
        entry.clauses.set(ck, c);
      }
      if (!c.others.includes(other)) c.others.push(other);
      c.provenance.push(e.provenance);
    }
  }
  return [...byKey].map(([canonicalKey, { sourceKey, clauses }]) => {
    const cs = [...clauses.values()];
    const line = (c: Clause) =>
      c.answerIsSrc
        ? `[그래프] ${c.answerName}의 ${relLabel(c.relType)}: ${c.others.join(", ")} (${c.srcType}→${c.dstType}, ${c.relType})`
        : `[그래프] ${c.others.join(", ")}의 ${relLabel(c.relType)}: ${c.answerName} (${c.srcType}→${c.dstType}, ${c.relType})`;
    return {
      canonicalKey,
      sourceKey,
      source: "graph" as const,
      text: cs.map(line).join("\n"),
      provenance: cs.map((c) => `relation:${c.relType}:${c.provenance.join("|")}`).join(";"),
    };
  });
}

/** 두 홉 경로(graphWalk)를 경로마다 한 줄로. 답은 경로 끝의 개체다.
 *
 * 홉마다 따로 적으면 7B 가 「Client-Y 가 Product-D1 을 쓴다」와 「Client-Y 의 프로젝트」를
 * 스스로 이어 읽어야 한다. 한 줄에 경로 전체를 적어 잇는 일을 모델에 맡기지 않는다.
 * 다음 홉이 없는 중간 개체(프로젝트가 없는 고객사)는 답이 아니므로 싣지 않는다.
 *
 * 둘째 엣지를 거꾸로 타서 답이 그 엣지의 출발점이면(제품 ← 고객사 ← 담당 직원) 답이 줄 가운데에 묻힌다.
 * 「Client-Q의 사용 중인 제품: Product-C1 → 조현우의 담당 고객사: Client-Q」에 7B 는 「Product-C1 담당 엔지니어는
 * 누구야?」(사업자 graph/schema.md 의 예시 질의)를 「알 수 없습니다」라고 답했다(랜덤 테스트 사전 점검 2차 R2, 3/3).
 * 그때는 답부터 적는다: 「조현우의 담당 고객사: Client-Q → Client-Q의 사용 중인 제품: Product-C1」. 답이 둘째 엣지의
 * 도착점인 줄(TC-129 「Client-Y의 사용 중인 제품: Product-D1 → Client-Y의 진행 프로젝트: …」)은 그대로다. */
export function pathCandidates(edges: GraphEdge[], seedId: number): Candidate[] {
  const viaMid = new Map<number, GraphEdge>();
  for (const e of edges) {
    if (e.depth !== 1) continue;
    const mid = e.srcId === seedId ? e.dstId : e.srcId;
    if (!viaMid.has(mid)) viaMid.set(mid, e);
  }
  const line = (e: GraphEdge) => `${e.srcName}의 ${relLabel(e.relType)}: ${e.dstName}`;
  const out: Candidate[] = [];
  edges.forEach((e2, i) => {
    if (e2.depth !== 2) return;
    const forward = viaMid.has(e2.srcId);
    const [mid, ansType, ansId] = forward ? [e2.srcId, e2.dstType, e2.dstId] : [e2.dstId, e2.srcType, e2.srcId];
    const e1 = viaMid.get(mid);
    if (!e1) return;
    out.push({
      canonicalKey: entityKey(ansType, ansId),
      sourceKey: `graph#p${i}`,
      source: "graph" as const,
      text: forward
        ? `[그래프 경로] ${line(e1)} → ${line(e2)} (${e1.relType}→${e2.relType})`
        : `[그래프 경로] ${line(e2)} → ${line(e1)} (${e2.relType}→${e1.relType})`,
      provenance: `path:${e1.relType}>${e2.relType}:${e2.provenance}`,
    });
  });
  return out;
}

/** Convert a relation-degree ranking to candidates (superlative questions).
 * The count is IN the context text, so the 7B reads the answer instead of
 * counting edges itself — counting is the database's job, not the model's. */
export function rankingCandidates(
  ranking: RelationScanResult["ranking"],
  relType: string,
  topN = 5,
  order?: "asc",
): Candidate[] {
  // Standard competition ranking (1224): equal degree = equal rank, marked 공동.
  // "가장 많은 고객을 담당하는 직원" has a 3-way tie in the sponsor data; numbering
  // the tied rows 1,2,3 invited the model to answer with one name and call it the
  // maximum. The tie is a property of the data, so the context has to carry it.
  const withRank = ranking.map((r, i) => {
    const rank = ranking.findIndex((x) => x.count === r.count) + 1;
    const tied = ranking.filter((x) => x.count === r.count).length > 1;
    return { ...r, i, rank, tied };
  });
  // 적은 쪽부터(asc)는 순위 앞에 「적은 순」을 붙이고, 공동 1위가 다섯을 넘으면 그 전부를 싣는다(답 문장이 이름을 다 적는다,
  // pipeline.ts fewestAnswer). 많은 쪽부터는 종전 글 그대로다(TC-132, TC-133).
  const asc = order === "asc";
  const n = asc ? Math.max(topN, withRank.filter((r) => r.rank === 1).length) : topN;
  return withRank.slice(0, n).map((r) => ({
    canonicalKey: entityKey(r.type, r.entityId),
    sourceKey: `graph#r${r.i}`,
    source: "graph" as const,
    text: `[그래프 집계] ${r.name} (${r.type}) — ${relLabel(relType)} ${r.count}건, ${asc ? "적은 순 " : ""}${r.tied ? "공동 " : ""}${r.rank}위`,
    provenance: `relation-rank${asc ? "-asc" : ""}:${relType}:#${r.rank}${r.tied ? "-tied" : ""}`,
  }));
}
