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

export interface OntologyHit {
  entityId: number;
  type: string;
  canonicalName: string;
  via: "canonical" | "alias";
  matched: string;
}

export interface OntologyResult {
  ok: boolean;
  hits: OntologyHit[];
  error?: string;
}

/** Resolve query terms to canonical entities via canonical_name OR alias (ILIKE). */
export async function ontologySearch(
  pool: Pool,
  query: string,
  k = 5,
  schema = "bench",
): Promise<OntologyResult> {
  try {
    const s = safeSchema(schema);
    const terms = [...contentTerms(query)];
    if (terms.length === 0) return { ok: true, hits: [] };
    const res = await pool.query(
      `WITH t AS (SELECT unnest($1::text[]) AS term)
       SELECT e.id, e.type, e.canonical_name, 'canonical' AS via, e.canonical_name AS matched
         FROM ${s}.entities e
        WHERE EXISTS (SELECT 1 FROM t WHERE e.canonical_name ILIKE '%' || t.term || '%')
       UNION
       SELECT e.id, e.type, e.canonical_name, 'alias' AS via, a.alias AS matched
         FROM ${s}.entities e JOIN ${s}.aliases a ON a.entity_id = e.id
        WHERE EXISTS (SELECT 1 FROM t WHERE a.alias ILIKE '%' || t.term || '%')
       ORDER BY 1
       LIMIT $2`,
      [terms, k],
    );
    const hits: OntologyHit[] = res.rows.map((r) => ({
      entityId: Number(r.id),
      type: String(r.type),
      canonicalName: String(r.canonical_name),
      via: r.via as "canonical" | "alias",
      matched: String(r.matched),
    }));
    return { ok: true, hits };
  } catch (err) {
    return { ok: false, hits: [], error: err instanceof Error ? err.message : String(err) };
  }
}

export interface GraphEdge {
  srcId: number;
  srcName: string;
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

/** BFS outgoing relation edges from a seed entity up to `depth`, optional rel_type filter. */
export async function graphExpand(
  pool: Pool,
  entityId: number,
  depth = 1,
  relTypes?: string[],
  schema = "bench",
): Promise<GraphResult> {
  try {
    const s = safeSchema(schema);
    const d = Math.min(3, Math.max(1, Math.floor(depth) || 1));
    const edges: GraphEdge[] = [];
    const seen = new Set<string>();
    let frontier = [entityId];
    for (let level = 1; level <= d && frontier.length > 0; level++) {
      const res = await pool.query(
        `SELECT r.src_entity_id, se.canonical_name AS src_name, r.rel_type,
                r.dst_entity_id, de.canonical_name AS dst_name, de.type AS dst_type, r.confidence, r.provenance
           FROM ${s}.relations r
           JOIN ${s}.entities se ON se.id = r.src_entity_id
           JOIN ${s}.entities de ON de.id = r.dst_entity_id
          WHERE r.src_entity_id = ANY($1::int[])
            AND ($2::text[] IS NULL OR r.rel_type = ANY($2::text[]))
          ORDER BY r.id`,
        [frontier, relTypes && relTypes.length ? relTypes : null],
      );
      const next: number[] = [];
      for (const row of res.rows) {
        const key = `${row.src_entity_id}-${row.rel_type}-${row.dst_entity_id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({
          srcId: Number(row.src_entity_id),
          srcName: String(row.src_name),
          relType: String(row.rel_type),
          dstId: Number(row.dst_entity_id),
          dstName: String(row.dst_name),
          dstType: String(row.dst_type),
          confidence: Number(row.confidence),
          provenance: String(row.provenance),
          depth: level,
        });
        next.push(Number(row.dst_entity_id));
      }
      frontier = next;
    }
    return { ok: true, edges };
  } catch (err) {
    return { ok: false, edges: [], error: err instanceof Error ? err.message : String(err) };
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
