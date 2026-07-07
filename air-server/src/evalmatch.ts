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
// This is the Spider-style execution match, scoped to our domain.

export type Row = Record<string, unknown>;

export interface MatchOpts {
  ordered?: boolean;
  columnsSensitive?: boolean;
  tupleSensitive?: boolean;
  numericTolerance?: number;
}

const NUMERIC = /^-?\d+(\.\d+)?$/;

function normToken(v: unknown, tol?: number): string {
  if (v === null || v === undefined) return "∅";
  const s = String(v).trim();
  if (NUMERIC.test(s)) {
    const n = Number(s);
    return tol && tol > 0 ? `n:${Math.round(n / tol) * tol}` : `n:${n}`;
  }
  return `s:${String(v)}`;
}

function canonRow(row: Row, opts: MatchOpts = {}): string {
  const entries = Object.entries(row); // insertion (select) order
  let parts = opts.columnsSensitive
    ? entries.map(([k, v]) => `${k}=${normToken(v, opts.numericTolerance)}`)
    : entries.map(([, v]) => normToken(v, opts.numericTolerance));
  // value/column-order-insensitive unless the question marks the tuple sensitive
  if (!opts.tupleSensitive) parts = [...parts].sort();
  return JSON.stringify(parts);
}

export function canonicalize(rows: Row[], opts: MatchOpts = {}): string[] {
  return rows.map((r) => canonRow(r, opts)).sort();
}

export function resultsMatch(a: Row[], b: Row[], opts: MatchOpts = {}): boolean {
  if (opts.ordered) {
    // order-sensitive: compare row SEQUENCES, not multisets.
    return JSON.stringify(a.map((r) => canonRow(r, opts))) === JSON.stringify(b.map((r) => canonRow(r, opts)));
  }
  return JSON.stringify(canonicalize(a, opts)) === JSON.stringify(canonicalize(b, opts));
}
