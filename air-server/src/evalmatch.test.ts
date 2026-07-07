// Unit tests for the execution-match comparator (the eval's objectivity hinge).
import { resultsMatch, canonicalize } from "./evalmatch.js";

let pass = 0, fail = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { pass++; } else { fail++; console.error("  FAIL:", msg); }
}

// identical
ok(resultsMatch([{ n: 5 }], [{ n: 5 }]), "identical rows match");

// alias-insensitive: different column name, same value
ok(resultsMatch([{ n: 5 }], [{ order_count: 5 }]), "column alias ignored");

// numeric-format-insensitive: 14000 == '14000.0000'
ok(resultsMatch([{ a: 14000 }], [{ a: "14000.0000" }]), "numeric format ignored");

// row-order-insensitive (multiset)
ok(resultsMatch([{ s: "a" }, { s: "b" }], [{ s: "b" }, { s: "a" }]), "row order ignored");

// column-order-insensitive within a row
ok(resultsMatch([{ x: 1, y: 2 }], [{ y: 2, x: 1 }]), "column order ignored");

// genuine mismatch
ok(!resultsMatch([{ n: 5 }], [{ n: 6 }]), "different values do not match");
ok(!resultsMatch([{ n: 5 }], [{ n: 5 }, { n: 5 }]), "different cardinality does not match");

// null handling
ok(resultsMatch([{ n: null }], [{ n: null }]), "nulls match");
ok(!resultsMatch([{ n: null }], [{ n: 0 }]), "null != 0");

// ordered mode: row sequence matters (top-k); reversed must fail when ordered
ok(resultsMatch([{ a: 1 }, { a: 2 }], [{ a: 2 }, { a: 1 }]), "unordered: row order ignored");
ok(!resultsMatch([{ a: 1 }, { a: 2 }], [{ a: 2 }, { a: 1 }], { ordered: true }), "ordered: reversed sequence fails");
ok(resultsMatch([{ a: 1 }, { a: 2 }], [{ a: 1 }, { a: 2 }], { ordered: true }), "ordered: same sequence matches");

// canonicalize is order-stable
ok(JSON.stringify(canonicalize([{ s: "b" }, { s: "a" }])) === JSON.stringify(canonicalize([{ s: "a" }, { s: "b" }])),
  "canonicalize is order-stable");

// columnsSensitive: column names matter
ok(resultsMatch([{ n: 5 }], [{ order_count: 5 }]), "default: alias ignored");
ok(!resultsMatch([{ n: 5 }], [{ order_count: 5 }], { columnsSensitive: true }), "columnsSensitive: alias mismatch fails");
ok(resultsMatch([{ n: 5 }], [{ n: 5 }], { columnsSensitive: true }), "columnsSensitive: same name matches");

// tupleSensitive: within-row association/order preserved
ok(resultsMatch([{ x: 1, y: 2 }], [{ x: 2, y: 1 }]), "default: within-row values order-insensitive");
ok(!resultsMatch([{ x: 1, y: 2 }], [{ x: 2, y: 1 }], { tupleSensitive: true }), "tupleSensitive: swapped tuple fails");
ok(resultsMatch([{ x: 1, y: 2 }], [{ a: 1, b: 2 }], { tupleSensitive: true }), "tupleSensitive: same tuple order matches (aliases ok)");

// numericTolerance: allow rounding differences
ok(!resultsMatch([{ a: 14000 }], [{ a: 14000.4 }]), "default: numeric exact mismatch");
ok(resultsMatch([{ a: 14000 }], [{ a: 14000.4 }], { numericTolerance: 1 }), "numericTolerance: within tolerance matches");

console.log(`\nevalmatch.test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
