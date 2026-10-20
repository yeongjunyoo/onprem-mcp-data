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

// Unit tests for the execution-match comparator (the eval's objectivity hinge).
import pg from "pg";
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


// subsetColumns: a wider projection is accepted, wrong rows are not.
ok(resultsMatch([{ id: 1, title: "a", extra: 9 }], [{ id: 1, title: "a" }], { subsetColumns: true }),
  "subsetColumns accepts extra columns");
ok(!resultsMatch([{ id: 2, title: "a" }], [{ id: 1, title: "a" }], { subsetColumns: true }),
  "subsetColumns still rejects a wrong row");
ok(!resultsMatch([{ id: 1 }], [{ id: 1, title: "a" }], { subsetColumns: true }),
  "subsetColumns rejects a NARROWER projection (missing gold value)");
ok(!resultsMatch([{ id: 1, title: "a" }, { id: 2, title: "b" }], [{ id: 1, title: "a" }], { subsetColumns: true }),
  "subsetColumns rejects a different row count");
ok(resultsMatch([{ n: 3.0001, x: 1 }], [{ n: 3 }], { subsetColumns: true, numericTolerance: 0.01 }),
  "subsetColumns honours numericTolerance");
ok(resultsMatch([{ a: 2, z: 0 }, { a: 1, z: 0 }], [{ a: 2 }, { a: 1 }], { subsetColumns: true, ordered: true }),
  "subsetColumns honours row order when ordered");
ok(!resultsMatch([{ a: 1, z: 0 }, { a: 2, z: 0 }], [{ a: 2 }, { a: 1 }], { subsetColumns: true, ordered: true }),
  "subsetColumns rejects wrong order when ordered");

// intervals (rules v2). node-postgres parses interval columns into objects; v1 turned every one into
// "[object Object]", so any two interval results matched. The values below are the real holdout4 h4-18
// results from the companyx data, parsed by node-postgres's own interval parser (OID 1186):
// gold AVG over resolved_at IS NOT NULL, the generated SQL's AVG over status = 'resolved'.
{
  const interval = pg.types.getTypeParser(1186) as (s: string) => object;
  const gold = [{ avg_resolution_time: interval("3 days 19:56:31.172414") }];
  const pred = [{ avg_resolution_time: interval("3 days 18:15:40.085106") }];
  ok(!resultsMatch(pred, gold), "h4-18: a different average interval does not match (v2)");
  ok(resultsMatch(pred, gold, { rules: "v1" }), "h4-18: v1 still reproduces the old interval-blind match");
  ok(!resultsMatch(pred, gold, { subsetColumns: true }), "h4-18: subsetColumns does not match a different interval either");
  ok(resultsMatch([{ t: interval("3 days 19:56:31.172414") }], gold), "the same interval matches");
  ok(resultsMatch([{ t: interval("1 day") }], [{ t: interval("24:00:00") }]), "'1 day' = '24:00:00', as PostgreSQL's = says");
  ok(!resultsMatch([{ t: interval("1 day") }], [{ t: interval("1 day 00:00:01") }]), "one second apart does not match");
  ok(!resultsMatch([{ t: 331_591.172414 }], gold), "an interval does not match its length written as a plain number");
  ok(resultsMatch([{ t: interval("00:00:00") }], [{ t: interval("0 days") }]), "zero intervals match");
  ok(!resultsMatch([{ o: { a: 1 } }], [{ o: { a: 2 } }]), "other objects compare by content, not as [object Object]");
}

console.log(`\nevalmatch.test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
