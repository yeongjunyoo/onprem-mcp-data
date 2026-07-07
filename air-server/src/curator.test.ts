// L4 curator tests (mirror prototype/curator.py): relevance packing,
// the structure-integrity guarantee, and the head-to-head vs naive truncation.
import { curate, naiveTokenTruncate, curateAudit, type ContextItem } from "./curator.js";

let pass = 0, fail = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { pass++; } else { fail++; console.error("  FAIL:", msg); }
}

const items: ContextItem[] = [
  { kind: "row", text: "주문 #2 | 사용자 1 | 상태 환불 | 금액 8000 | 2026-04-10", source: "orders#2", fields: 5 },
  { kind: "row", text: "주문 #1 | 사용자 1 | 상태 결제완료 | 금액 12000 | 2026-04-02", source: "orders#1", fields: 5 },
  { kind: "chunk", text: "환불 정책: 단순 변심 반품은 수령 후 7일 이내 가능하며 택배비는 고객 부담입니다.", source: "documents#1" },
  { kind: "chunk", text: "배송 안내: 출고 후 보통 2~3일 내 도착하며 운송장은 문자로 안내됩니다.", source: "documents#2" },
];

// --- relevance: refund query keeps the two refund items, drops 배송 ---
const c = curate("환불 관련 주문과 정책", items, 60);
const kept = new Set(c.kept.map((i) => i.source));
ok(c.brokenRows === 0, "curator never breaks a row");
ok(c.tokensUsed <= c.budget, `budget respected (${c.tokensUsed} <= ${c.budget})`);
ok(kept.has("orders#2") && kept.has("documents#1"), `refund items kept (got ${[...kept]})`);
ok(!kept.has("documents#2"), "irrelevant 배송 doc dropped under budget");

// --- structure-integrity property: curator NEVER breaks a row, at ANY budget;
//     the naive token-cut baseline DOES split a row at some budget (the moat) ---
const rows = items.filter((i) => i.kind === "row");
let naiveBrokeSomewhere = false;
for (let b = 1; b <= 60; b++) {
  ok(curate("주문", rows, b).brokenRows === 0, `curator broken=0 at budget ${b}`);
  if (naiveTokenTruncate(rows, b).brokenRows > 0) naiveBrokeSomewhere = true;
}
ok(naiveBrokeSomewhere, "naive token-cut splits a row (corrupts a tuple) at some budget");

// --- determinism ---
const a1 = JSON.stringify(curateAudit(curate("환불 관련 주문과 정책", items, 60)));
const a2 = JSON.stringify(curateAudit(curate("환불 관련 주문과 정책", items, 60)));
ok(a1 === a2, "curate is deterministic");

// --- audit shape + integrity flag ---
const audit = curateAudit(c);
ok(audit.structure_preserved === true && audit.broken_rows === 0, "audit reports structure preserved");

console.log(`\ncurator.test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
