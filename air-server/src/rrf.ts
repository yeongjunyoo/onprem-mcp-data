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

// Reciprocal Rank Fusion — merges the ranked candidate lists produced by the
// parallel fan-out (sql.query + vector.search) into one fused ranking.
//
// RRF score(d) = Σ_lists 1 / (k + rank_list(d)). It needs no score calibration
// across heterogeneous sources (SQL rows vs vector hits) — only ranks — which is
// exactly why it fits a deterministic, tuning-free pipeline. A document found by
// BOTH paths accumulates score from both, so agreement floats to the top.
// k=60 is the standard constant (Cormack et al. 2009); it is fixed, not tuned.
//
// RRF is defined over ranked lists of DISTINCT items, so each list contributes a
// key at most once, at its BEST rank. This matters on the graph branch: expanding
// one entity emits many edges that all point at the same node, and without the
// dedupe that node would collect a dozen increments and outrank a genuine
// cross-source agreement. Degree is a graph fact, not retrieval evidence.
// Ranks count DISTINCT keys too: a hub repeated ten times must not push the next
// item of its list to rank 11, or the repetition still decides the fusion.

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
    const seen = new Set<string>(); // best rank only, once per list
    list.forEach((r) => {
      if (seen.has(r.key)) return;
      seen.add(r.key);
      const inc = 1 / (k + seen.size); // 1-based rank among distinct keys
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
    const seen = new Set<string>(); // best rank only, once per list (see header)
    list.forEach((c) => {
      if (seen.has(c.canonicalKey)) return;
      seen.add(c.canonicalKey);
      const inc = 1 / (k + seen.size); // 1-based rank among distinct keys of its own list
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
