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

// Execution-match comparison for the SQL eval (objective, no LLM judge).
//
// Two SQL queries "match" iff executing them yields the same result set. By
// default the comparison is robust to harmless differences (row order, column
// aliases, column order, numeric formatting). Per-question metadata can tighten
// it for cases where those DO matter:
//   * ordered          -> row SEQUENCE matters (ORDER BY ... LIMIT k)
//   * columnsSensitive -> column NAMES must match, not just values
//   * tupleSensitive   -> within-row column order/association preserved
//   * numericTolerance -> allow |a-b| <= tol for numeric values (e.g. avg rounding)
//   * subsetColumns    -> the prediction may carry EXTRA columns as long as it
//                         contains every gold value in the matching row. "목록을
//                         알려줘" is answered correctly by `SELECT *` as well as by
//                         `SELECT id, title`; penalising the wider projection would
//                         measure prompt luck, not SQL correctness. Row COUNT and
//                         row CONTENT are still strict, so a wrong filter still fails.
// This is the Spider-style execution match, scoped to our domain.
//
// Value tokens (rules v2, default). node-postgres returns an interval as an object
// ({ days, hours, minutes, seconds, milliseconds }). Rules v1 turned every value
// with String(), so every interval became "[object Object]" and ANY two interval
// results compared equal (2026-10-11 diagnosis: holdout4 h4-18, 3 days 18:15:40
// against the gold 3 days 19:56:31, counted as a match). v2 compares an interval by
// its length in seconds, the way PostgreSQL's `=` does (a month is 30 days, so
// '1 day' = '24:00:00'), and any other object by its JSON with sorted keys.
// EVALMATCH_RULES=v1 (or opts.rules) restores v1 to regenerate old EX numbers.

export type Row = Record<string, unknown>;

export interface MatchOpts {
  ordered?: boolean;
  columnsSensitive?: boolean;
  tupleSensitive?: boolean;
  numericTolerance?: number;
  subsetColumns?: boolean;
  /** Token rules. Default: EVALMATCH_RULES, else v2. v1 = the published, interval-blind rules */
  rules?: "v1" | "v2";
}

const NUMERIC = /^-?\d+(\.\d+)?$/;
const INTERVAL_KEYS = new Set(["years", "months", "days", "hours", "minutes", "seconds", "milliseconds"]);

/** An interval as node-postgres returns it (postgres-interval): only interval fields, all numbers. */
function intervalSeconds(v: object): number | null {
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o);
  const looksLike = typeof (o as { toPostgres?: unknown }).toPostgres === "function" || keys.length > 0;
  if (!looksLike || !keys.every((k) => INTERVAL_KEYS.has(k) && typeof o[k] === "number")) return null;
  const n = (k: string) => (typeof o[k] === "number" ? (o[k] as number) : 0);
  const days = (n("years") * 12 + n("months")) * 30 + n("days");
  const total = days * 86_400 + n("hours") * 3_600 + n("minutes") * 60 + n("seconds") + n("milliseconds") / 1000;
  return Math.round(total * 1e6) / 1e6; // microseconds, PostgreSQL's interval resolution
}

const sortedJson = (v: unknown): string =>
  JSON.stringify(v, (_k, x) =>
    x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x,
  );

function normToken(v: unknown, tol?: number, rules: "v1" | "v2" = "v2"): string {
  if (v === null || v === undefined) return "∅";
  if (rules === "v2" && typeof v === "object" && !(v instanceof Date)) {
    const secs = Array.isArray(v) ? null : intervalSeconds(v);
    return secs !== null ? `d:${secs}` : `o:${sortedJson(v)}`;
  }
  const s = String(v).trim();
  if (NUMERIC.test(s)) {
    const n = Number(s);
    return tol && tol > 0 ? `n:${Math.round(n / tol) * tol}` : `n:${n}`;
  }
  return `s:${String(v)}`;
}

const rulesOf = (opts: MatchOpts): "v1" | "v2" => opts.rules ?? (process.env.EVALMATCH_RULES === "v1" ? "v1" : "v2");

function canonRow(row: Row, opts: MatchOpts = {}): string {
  const entries = Object.entries(row); // insertion (select) order
  const r = rulesOf(opts);
  let parts = opts.columnsSensitive
    ? entries.map(([k, v]) => `${k}=${normToken(v, opts.numericTolerance, r)}`)
    : entries.map(([, v]) => normToken(v, opts.numericTolerance, r));
  // value/column-order-insensitive unless the question marks the tuple sensitive
  if (!opts.tupleSensitive) parts = [...parts].sort();
  return JSON.stringify(parts);
}

export function canonicalize(rows: Row[], opts: MatchOpts = {}): string[] {
  return rows.map((r) => canonRow(r, opts)).sort();
}

/** Does row `pred` contain every value of row `gold` (multiset containment)? */
function rowContains(pred: Row, gold: Row, tol: number | undefined, rules: "v1" | "v2"): boolean {
  const pool = Object.values(pred).map((v) => normToken(v, tol, rules));
  for (const v of Object.values(gold)) {
    const idx = pool.indexOf(normToken(v, tol, rules));
    if (idx < 0) return false;
    pool.splice(idx, 1);
  }
  return true;
}

function subsetMatch(pred: Row[], gold: Row[], opts: MatchOpts): boolean {
  if (pred.length !== gold.length) return false;
  const r = rulesOf(opts);
  if (opts.ordered) return gold.every((g, i) => rowContains(pred[i], g, opts.numericTolerance, r));
  const used = new Set<number>();
  for (const g of gold) {
    const hit = pred.findIndex((p, i) => !used.has(i) && rowContains(p, g, opts.numericTolerance, r));
    if (hit < 0) return false;
    used.add(hit);
  }
  return true;
}

export function resultsMatch(a: Row[], b: Row[], opts: MatchOpts = {}): boolean {
  if (opts.subsetColumns) return subsetMatch(a, b, opts);
  if (opts.ordered) {
    // order-sensitive: compare row SEQUENCES, not multisets.
    return JSON.stringify(a.map((r) => canonRow(r, opts))) === JSON.stringify(b.map((r) => canonRow(r, opts)));
  }
  return JSON.stringify(canonicalize(a, opts)) === JSON.stringify(canonicalize(b, opts));
}
