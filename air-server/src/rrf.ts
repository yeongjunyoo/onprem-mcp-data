// Reciprocal Rank Fusion — merges the ranked candidate lists produced by the
// parallel fan-out (sql.query + vector.search) into one fused ranking.
//
// RRF score(d) = Σ_lists 1 / (k + rank_list(d)). It needs no score calibration
// across heterogeneous sources (SQL rows vs vector hits) — only ranks — which is
// exactly why it fits a deterministic, tuning-free pipeline. A document found by
// BOTH paths accumulates score from both, so agreement floats to the top.
// k=60 is the standard constant (Cormack et al. 2009); it is fixed, not tuned.

import type { Candidate, CandidateSource } from "./candidate.js";
export interface Ranked<T> {
  key: string; // stable identity used for fusion (e.g. 'documents#1', 'orders#2')
  value: T;
}

export interface Fused<T> {
  key: string;
  value: T;
  score: number;
  sources: number[]; // indices of the input lists that contributed
  rank: number; // 1-based position in the fused ranking
}

export const RRF_K = 60;

export function rrfMerge<T>(lists: Ranked<T>[][], k = RRF_K): Fused<T>[] {
  const acc = new Map<string, { value: T; score: number; sources: Set<number> }>();
  lists.forEach((list, li) => {
    list.forEach((r, idx) => {
      const inc = 1 / (k + idx + 1); // rank is 1-based
      const cur = acc.get(r.key);
      if (cur) {
        cur.score += inc;
        cur.sources.add(li);
      } else {
        acc.set(r.key, { value: r.value, score: inc, sources: new Set([li]) });
      }
    });
  });
  return [...acc.entries()]
    .map(([key, v]) => ({ key, value: v.value, score: v.score, sources: [...v.sources].sort((a, b) => a - b) }))
    // deterministic order: score desc, then key asc (no RNG, stable run-to-run)
    .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key))
    .map((x, i) => ({ ...x, rank: i + 1 }));
}

// ===== Named-source RRF over canonical candidates (Gate2) =====
// Fuses Candidate lists by `canonicalKey` and accumulates the DISTINCT named
// sources (sql/vector/graph) that surfaced each entity — so 3-way agreement is
// explicit and auditable, not a positional index.



export interface FusedCandidate {
  canonicalKey: string;
  candidate: Candidate; // first-seen candidate (representative text/provenance)
  score: number;
  sources: CandidateSource[]; // distinct contributing branches, sorted
  rank: number;
}

export function rrfMergeNamed(lists: Candidate[][], k = RRF_K): FusedCandidate[] {
  const acc = new Map<string, { candidate: Candidate; score: number; sources: Set<CandidateSource> }>();
  for (const list of lists) {
    list.forEach((c, idx) => {
      const inc = 1 / (k + idx + 1); // 1-based rank within its own list
      const cur = acc.get(c.canonicalKey);
      if (cur) {
        cur.score += inc;
        cur.sources.add(c.source);
      } else {
        acc.set(c.canonicalKey, { candidate: c, score: inc, sources: new Set([c.source]) });
      }
    });
  }
  return [...acc.entries()]
    .map(([canonicalKey, v]) => ({
      canonicalKey,
      candidate: v.candidate,
      score: v.score,
      sources: [...v.sources].sort(),
    }))
    // deterministic: score desc, then more-sources first, then canonicalKey asc
    .sort(
      (a, b) =>
        b.score - a.score || b.sources.length - a.sources.length || a.canonicalKey.localeCompare(b.canonicalKey),
    )
    .map((x, i) => ({ ...x, rank: i + 1 }));
}
