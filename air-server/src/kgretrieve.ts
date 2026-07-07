// Gate4 — canonical 3-way retrieval over the bench KG.
//
// Runs the vector + graph branches CONCURRENTLY and maps every hit into the
// canonical Candidate identity space (via bench.entity_links), then fuses with
// rrfMergeNamed. The point: the SAME real entity surfaced by BOTH the vector
// branch (its policy document) and the graph branch (alias resolution / relation
// edge) accumulates named sources and outranks single-source hits — a genuine
// agreement signal, not three concatenated lists.
//
// SQL rows are mapped the same way when they carry an entity_link, so a product
// returned by sql + reachable by graph also fuses by canonical key.

import type { Pool } from "./db.js";
import type { Embedder } from "./embedder.js";
import { vectorSearch } from "./vector.js";
import { ontologySearch, graphExpand, ontologyCandidates, edgeCandidates } from "./graph.js";
import { rrfMergeNamed, type FusedCandidate } from "./rrf.js";
import { type Candidate, entityKey, documentKey } from "./candidate.js";

const IDENT = /^[a-z_][a-z0-9_]*$/;
function safeSchema(s: string): string {
  if (!IDENT.test(s)) throw new Error(`unsafe schema: ${s}`);
  return s;
}

/** Map vector document hits to canonical candidates via entity_links (doc -> entity),
 * falling back to documents#id when a doc has no entity mapping. */
async function vectorCandidates(
  pool: Pool,
  hits: { id: number; title: string; body: string }[],
  schema: string,
): Promise<Candidate[]> {
  if (hits.length === 0) return [];
  const ids = hits.map((h) => h.id);
  // The entity_links bridge is best-effort: if it's missing/unavailable, degrade
  // gracefully to documents#id keys instead of crashing the whole retrieve.
  let byDoc = new Map<number, { entityId: number; type: string }>();
  try {
    const links = (
      await pool.query(
        `SELECT l.document_id, l.entity_id, e.type
           FROM ${schema}.entity_links l JOIN ${schema}.entities e ON e.id = l.entity_id
          WHERE l.source_kind = 'vector' AND l.document_id = ANY($1::int[])`,
        [ids],
      )
    ).rows;
    byDoc = new Map(
      links.map((r) => [Number(r.document_id), { entityId: Number(r.entity_id), type: String(r.type) }]),
    );
  } catch {
    /* entity_links unavailable -> fall back to document keys (no crash) */
  }
  return hits.map((h, i) => {
    const e = byDoc.get(h.id);
    return {
      canonicalKey: e ? entityKey(e.type, e.entityId) : documentKey(h.id),
      sourceKey: `vector#${i}`,
      source: "vector" as const,
      text: `${h.title}: ${h.body}`,
      provenance: `${schema}.documents#${h.id}`,
    };
  });
}

export interface KgRetrieveResult {
  fused: FusedCandidate[];
  audit: {
    vector: number;
    graph: number;
    fused: number;
    agreement: number; // # fused candidates with >1 named source
  };
}

export async function kgRetrieve(
  pool: Pool,
  query: string,
  deps: { embedder: Embedder; schema?: string; k?: number },
): Promise<KgRetrieveResult> {
  const schema = safeSchema(deps.schema ?? "bench");
  const k = deps.k ?? 5;

  // vector + ontology branches run concurrently
  const [vec, onto] = await Promise.all([
    vectorSearch(pool, deps.embedder, query, k, `${schema}.documents`),
    ontologySearch(pool, query, k, schema),
  ]);

  const vc = vec.ok ? await vectorCandidates(pool, vec.hits, schema) : [];
  const graphList: Candidate[] = onto.ok ? [...ontologyCandidates(onto.hits)] : [];
  // expand 1 hop from each resolved entity to pull related entities (edge-required answers)
  if (onto.ok) {
    for (const h of onto.hits.slice(0, 3)) {
      const g = await graphExpand(pool, h.entityId, 1, undefined, schema);
      if (g.ok) graphList.push(...edgeCandidates(g.edges));
    }
  }

  const fused = rrfMergeNamed([vc, graphList]);
  return {
    fused,
    audit: {
      vector: vc.length,
      graph: graphList.length,
      fused: fused.length,
      agreement: fused.filter((f) => f.sources.length > 1).length,
    },
  };
}
