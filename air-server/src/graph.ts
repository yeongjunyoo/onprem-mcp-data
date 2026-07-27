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
import { contentTerms } from "./text.js";

const IDENT = /^[a-z_][a-z0-9_]*$/;
function safeSchema(schema: string): string {
  if (!IDENT.test(schema)) throw new Error(`unsafe schema identifier: ${schema}`);
  return schema;
}

/** KG schema in use. `bench` = internal benchmark; `companyx` = sponsor dataset.
 * Env-driven so the same tools serve either corpus with zero code change. */
export function kgSchema(): string {
  return safeSchema(process.env.KG_SCHEMA ?? "bench");
}

export interface OntologyHit {
  entityId: number;
  type: string;
  canonicalName: string;
  via: "canonical" | "alias";
  matched: string;
  /** 3 = exact name/id, 2 = prefix, 1 = substring. Ranks seeds so a query naming
   * "Product-C1" seeds THAT product instead of the first 5 rows containing "product". */
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
]);

export function seedTerms(query: string): string[] {
  const out = new Set<string>();
  for (const raw of query.match(SEED_TOKEN) ?? []) {
    const w = raw.replace(/(은|는|이|가|을|를|에|의|와|과|도|로|으로|에서|에게|까지|부터|만)$/, "");
    if (w.length < 2 || SEED_STOP.has(w)) continue;
    out.add(w);
  }
  return [...out];
}

export interface OntologyResult {
  ok: boolean;
  hits: OntologyHit[];
  error?: string;
}

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
    const scoreExpr = (col: string) => `CASE
            WHEN lower(${col}) = lower(t.term) THEN 3
            WHEN lower(${col}) LIKE lower(t.term) || '%' THEN 2
            ELSE 1 END`;
    const res = await pool.query(
      `WITH t AS (SELECT unnest($1::text[]) AS term),
            m AS (
              SELECT e.id, e.type, e.canonical_name, ${propsCol} AS properties,
                     'canonical'::text AS via, t.term AS matched,
                     ${scoreExpr("e.canonical_name")} AS score
                FROM ${s}.entities e JOIN t
                  ON e.canonical_name ILIKE '%' || t.term || '%'
              UNION ALL
              SELECT e.id, e.type, e.canonical_name, ${propsCol},
                     'alias', t.term, ${scoreExpr("a.alias")}
                FROM ${s}.entities e
                JOIN ${s}.aliases a ON a.entity_id = e.id
                JOIN t ON a.alias ILIKE '%' || t.term || '%'
            )
       SELECT id, type, canonical_name, properties,
              (array_agg(via ORDER BY score DESC, via))[1] AS via,
              (array_agg(matched ORDER BY score DESC, matched))[1] AS matched,
              max(score) AS score
         FROM m
        GROUP BY id, type, canonical_name, properties
        ORDER BY max(score) DESC, length(canonical_name) ASC, id
        LIMIT $2`,
      [terms, k],
    );
    const hits: OntologyHit[] = res.rows.map((r) => ({
      entityId: Number(r.id),
      type: String(r.type),
      canonicalName: String(r.canonical_name),
      via: r.via as "canonical" | "alias",
      matched: String(r.matched),
      score: Number(r.score),
      properties: (r.properties ?? undefined) as Record<string, unknown> | undefined,
    }));
    return { ok: true, hits };
  } catch (err) {
    return { ok: false, hits: [], error: err instanceof Error ? err.message : String(err) };
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

export interface GraphResult {
  ok: boolean;
  edges: GraphEdge[];
  error?: string;
}

export type Direction = "out" | "in" | "both";

/** BFS relation edges from a seed entity up to `depth`, optional rel_type filter.
 *
 * Direction matters and defaults to BOTH: half of the sponsor's graph questions are
 * reverse traversals ("Product-C1을 사용하는 고객사" = client -[USES]-> product read
 * backwards). An out-only expansion silently returns nothing for those, which is the
 * worst failure mode — a confident empty answer. Edges are emitted in a canonical
 * direction (src -rel-> dst) regardless of which way they were traversed. */
export async function graphExpand(
  pool: Pool,
  entityId: number,
  depth = 1,
  relTypes?: string[],
  schema = kgSchema(),
  direction: Direction = "both",
): Promise<GraphResult> {
  try {
    const s = safeSchema(schema);
    const d = Math.min(3, Math.max(1, Math.floor(depth) || 1));
    const edges: GraphEdge[] = [];
    const seen = new Set<string>();
    const visited = new Set<number>([entityId]);
    let frontier = [entityId];
    const match =
      direction === "out"
        ? "r.src_entity_id = ANY($1::int[])"
        : direction === "in"
          ? "r.dst_entity_id = ANY($1::int[])"
          : "(r.src_entity_id = ANY($1::int[]) OR r.dst_entity_id = ANY($1::int[]))";
    for (let level = 1; level <= d && frontier.length > 0; level++) {
      const res = await pool.query(
        `SELECT r.src_entity_id, se.canonical_name AS src_name, se.type AS src_type, r.rel_type,
                r.dst_entity_id, de.canonical_name AS dst_name, de.type AS dst_type, r.confidence, r.provenance
           FROM ${s}.relations r
           JOIN ${s}.entities se ON se.id = r.src_entity_id
           JOIN ${s}.entities de ON de.id = r.dst_entity_id
          WHERE ${match}
            AND ($2::text[] IS NULL OR r.rel_type = ANY($2::text[]))
          ORDER BY r.id`,
        [frontier, relTypes && relTypes.length ? relTypes : null],
      );
      const next: number[] = [];
      for (const row of res.rows) {
        const srcId = Number(row.src_entity_id);
        const dstId = Number(row.dst_entity_id);
        const key = `${srcId}-${row.rel_type}-${dstId}`;
        if (seen.has(key)) continue;
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
        for (const nid of [srcId, dstId]) {
          if (!visited.has(nid)) {
            visited.add(nid);
            next.push(nid);
          }
        }
      }
      frontier = next;
    }
    return { ok: true, edges };
  } catch (err) {
    return { ok: false, edges: [], error: err instanceof Error ? err.message : String(err) };
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
      ranking.push(
        ...[...counts.entries()]
          .map(([entityId, v]) => ({ entityId, ...v }))
          // count desc, then id asc: total order => zero run-to-run variance.
          .sort((a, b) => b.count - a.count || a.entityId - b.entityId),
      );
    }
    return { ok: true, edges: edges.slice(0, limit), ranking: ranking.slice(0, limit) };
  } catch (err) {
    return { ok: false, edges: [], ranking: [], error: err instanceof Error ? err.message : String(err) };
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

/** Convert graph edges to canonical graph candidates keyed by the destination entity. */
export function edgeCandidates(edges: GraphEdge[]): Candidate[] {
  return edges.map((e, i) => ({
    canonicalKey: entityKey(e.dstType, e.dstId),
    sourceKey: `graph#e${i}`,
    source: "graph" as const,
    text: `[그래프] ${e.srcName} -${e.relType}-> ${e.dstName}`,
    provenance: `relation:${e.relType}:${e.provenance}`,
  }));
}

/** Convert a relation-degree ranking to candidates (superlative questions).
 * The count is IN the context text, so the 7B reads the answer instead of
 * counting edges itself — counting is the database's job, not the model's. */
export function rankingCandidates(
  ranking: RelationScanResult["ranking"],
  relType: string,
  topN = 5,
): Candidate[] {
  return ranking.slice(0, topN).map((r, i) => ({
    canonicalKey: entityKey(r.type, r.entityId),
    sourceKey: `graph#r${i}`,
    source: "graph" as const,
    text: `[그래프 집계] ${r.name} (${r.type}) — ${relType} 관계 ${r.count}건 (전체 ${i + 1}위)`,
    provenance: `relation-rank:${relType}:#${i + 1}`,
  }));
}
