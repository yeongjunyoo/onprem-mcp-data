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

// L4 — structure-preserving, schema-aware context curation (TACC).
// Ported from the validated Python reference (prototype/curator.py).
//
// The moat (per the brief + the documented failure mode of token-level
// compressors like LLMLingua/Squeez): when you prune retrieved context to fit a
// small 7B window you must NOT split a SQL tuple / table row. Token-level
// compression corrupts structured data; a row that loses half its fields becomes
// a wrong fact. This curator:
//   * scores each item's relevance (deterministic term overlap — training-free),
//   * greedily packs the highest-relevance items WHOLE under a token budget,
//   * NEVER partially includes a structured row (rows are atomic),
//   * keeps an evidence unit (items sharing `unit`: the sections of the one document a
//     question names, the edge set of the planned relation) whole or drops it whole,
//   * emits an audit of kept/dropped + a structure-integrity guarantee (0 broken rows).
// Thesis is structure integrity at a fixed budget, NOT a token-reduction percentage.

import { estTokens, contentTerms } from "./text.js";

export type ItemKind = "row" | "chunk";

export interface ContextItem {
  kind: ItemKind; // 'row' (structured, atomic) | 'chunk' (document text)
  text: string; // rendered text that would go into the prompt
  source: string; // e.g. 'orders#2' or 'documents#1'
  fields?: number; // for rows: number of fields (integrity check)
  /** Evidence unit id (evidence.ts). Items with the same unit are packed together, whole or not at all. */
  unit?: string;
}

export interface CurateAudit {
  kept: string[];
  dropped: string[];
  tokens_used: number;
  budget: number;
  broken_rows: number;
  structure_preserved: boolean;
}

export interface Curated {
  kept: ContextItem[];
  dropped: ContextItem[];
  tokensUsed: number;
  budget: number;
  brokenRows: number; // MUST stay 0 for the curator (the guarantee)
  notes: string[];
}

export function render(c: Curated): string {
  return c.kept.map((i) => i.text).join("\n");
}

export function curateAudit(c: Curated): CurateAudit {
  return {
    kept: c.kept.map((i) => i.source),
    dropped: c.dropped.map((i) => i.source),
    tokens_used: c.tokensUsed,
    budget: c.budget,
    broken_rows: c.brokenRows,
    structure_preserved: c.brokenRows === 0,
  };
}

function relevance(queryTerms: Set<string>, item: ContextItem): number {
  let n = 0;
  for (const t of contentTerms(item.text)) if (queryTerms.has(t)) n++;
  return n;
}

/** Greedy relevance-ranked packing; rows and evidence units stay whole. Deterministic.
 *
 * The packing step is a group: an item without `unit` is a group of one, items sharing a
 * `unit` are one group ranked by their best member. A group that fits is kept whole; one
 * that does not is dropped whole. A unit larger than the entire budget can never fit, so it
 * is the one exception: its members are packed one by one by relevance (what every item got
 * before units existed) and a note says how much of it was kept. */
export function curate(query: string, items: ContextItem[], budget: number): Curated {
  const qt = contentTerms(query);
  const groups: { members: { it: ContextItem; i: number; rel: number; cost: number }[]; rel: number; first: number; cost: number; unit?: string }[] = [];
  const byUnit = new Map<string, (typeof groups)[number]>();
  items.forEach((it, i) => {
    const m = { it, i, rel: relevance(qt, it), cost: estTokens(it.text) };
    const g = it.unit !== undefined ? byUnit.get(it.unit) : undefined;
    if (g) {
      g.members.push(m);
      g.rel = Math.max(g.rel, m.rel);
      g.cost += m.cost;
      return;
    }
    const fresh = { members: [m], rel: m.rel, first: i, cost: m.cost, ...(it.unit !== undefined ? { unit: it.unit } : {}) };
    groups.push(fresh);
    if (it.unit !== undefined) byUnit.set(it.unit, fresh);
  });
  // Stable sort: relevance desc, then original index (deterministic, no tie RNG).
  groups.sort((a, b) => b.rel - a.rel || a.first - b.first);

  const kept: ContextItem[] = [];
  const dropped: ContextItem[] = [];
  const notes: string[] = [];
  let used = 0;
  for (const g of groups) {
    if (used + g.cost <= budget) {
      for (const m of g.members) kept.push(m.it);
      used += g.cost;
    } else if (g.unit !== undefined && g.members.length > 1 && g.cost > budget) {
      let n = 0;
      for (const m of [...g.members].sort((a, b) => b.rel - a.rel || a.i - b.i)) {
        if (used + m.cost <= budget) {
          kept.push(m.it);
          used += m.cost;
          n++;
        } else dropped.push(m.it);
      }
      notes.push(`unit ${g.unit} exceeds the budget (${g.cost} > ${budget}): kept ${n} of ${g.members.length}`);
    } else {
      // A row (or a unit) is atomic: if it does not fit whole, it is dropped, never split.
      for (const m of g.members) dropped.push(m.it);
    }
  }
  // restore original order among kept for readable context
  const order = new Map(items.map((it, i) => [it, i] as const));
  kept.sort((a, b) => (order.get(a)! - order.get(b)!));
  return {
    kept,
    dropped,
    tokensUsed: used,
    budget,
    brokenRows: 0,
    notes: [`${kept.length} kept / ${dropped.length} dropped, rows atomic`, ...notes],
  };
}

/** Baseline standing in for token-level compressors (LLMLingua/Squeez-style):
 * concatenate everything and hard-cut at the token budget. This SPLITS whichever
 * row straddles the boundary -> corrupted structured data. Used for head-to-head. */
export function naiveTokenTruncate(items: ContextItem[], budget: number): Curated {
  const spans: [number, number][] = [];
  let cursor = 0;
  for (let i = 0; i < items.length; i++) {
    const start = cursor;
    cursor += items[i].text.length;
    spans.push([start, cursor]);
    if (i < items.length - 1) cursor += 1; // the "\n" separator
  }
  const full = items.map((it) => it.text).join("\n");
  // binary search the char cut where est_tokens <= budget (est_tokens monotonic)
  let lo = 0, hi = full.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (estTokens(full.slice(0, mid)) <= budget) lo = mid;
    else hi = mid - 1;
  }
  const cut = lo;
  let broken = 0;
  const kept: ContextItem[] = [];
  const dropped: ContextItem[] = [];
  for (let i = 0; i < items.length; i++) {
    const [s, e] = spans[i];
    if (cut >= e) kept.push(items[i]); // fully inside the kept prefix
    else if (cut <= s) dropped.push(items[i]); // fully past the cut
    else if (items[i].kind === "row") broken++; // cut falls INSIDE a row -> corrupted tuple
    else dropped.push(items[i]); // a chunk fragment, treat as dropped
  }
  return {
    kept,
    dropped,
    tokensUsed: estTokens(full.slice(0, cut)),
    budget,
    brokenRows: broken,
    notes: ["hard token cut; rows may be split mid-tuple"],
  };
}
