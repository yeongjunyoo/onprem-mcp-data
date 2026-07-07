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
//   * emits an audit of kept/dropped + a structure-integrity guarantee (0 broken rows).
// Thesis is structure integrity at a fixed budget, NOT a token-reduction percentage.

import { estTokens, contentTerms } from "./text.js";

export type ItemKind = "row" | "chunk";

export interface ContextItem {
  kind: ItemKind; // 'row' (structured, atomic) | 'chunk' (document text)
  text: string; // rendered text that would go into the prompt
  source: string; // e.g. 'orders#2' or 'documents#1'
  fields?: number; // for rows: number of fields (integrity check)
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

/** Greedy relevance-ranked packing; rows stay whole. Deterministic. */
export function curate(query: string, items: ContextItem[], budget: number): Curated {
  const qt = contentTerms(query);
  // Stable sort: relevance desc, then original index (deterministic, no tie RNG).
  const ranked = items
    .map((it, i) => ({ it, i }))
    .sort((a, b) => relevance(qt, b.it) - relevance(qt, a.it) || a.i - b.i);

  const kept: ContextItem[] = [];
  const dropped: ContextItem[] = [];
  let used = 0;
  for (const { it } of ranked) {
    const cost = estTokens(it.text);
    if (used + cost <= budget) {
      kept.push(it);
      used += cost;
    } else {
      // A row is atomic: if it does not fit whole, it is dropped, never split.
      dropped.push(it);
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
    notes: [`${kept.length} kept / ${dropped.length} dropped, rows atomic`],
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
