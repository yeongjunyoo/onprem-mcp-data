// Router tests (mirror prototype/test_router.py): correctness + determinism.
// Run after build: node dist/router.test.js
import { route, audit, SQL_TOOL, VECTOR_TOOL } from "./router.js";

let pass = 0, fail = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { pass++; } else { fail++; console.error("  FAIL:", msg); }
}
function eq<T>(a: T, b: T, msg: string) { ok(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)})`); }

// structured: count + time
let d = route("최근 3개월간 주문 건수 알려줘");
eq(d.route, "structured", "structured count+time");
eq(d.tools, [SQL_TOOL], "structured -> sql only");

// semantic: aboutness
d = route("환불 정책에 대한 내용 찾아줘");
eq(d.route, "semantic", "semantic aboutness");
eq(d.tools, [VECTOR_TOOL], "semantic -> vector only");

// hybrid: both
d = route("지난달 취소된 주문 중 환불 관련 문의가 비슷한 케이스");
eq(d.route, "hybrid", "hybrid both signals");
eq(d.tools, [SQL_TOOL, VECTOR_TOOL], "hybrid -> both tools");

// ambiguous -> hybrid fan-out
eq(route("주문").route, "hybrid", "ambiguous defaults to hybrid");

// '몇 명' counts as structured
eq(route("전체 사용자 수는 몇 명이야").route, "structured", "몇 명 -> structured");

// determinism: 20 runs identical
const q = "지난달 취소된 주문 중 환불 관련 문의가 비슷한 케이스";
const first = JSON.stringify(audit(route(q)));
let stable = true;
for (let i = 0; i < 20; i++) if (JSON.stringify(audit(route(q))) !== first) stable = false;
ok(stable, "determinism: 20 runs identical");

console.log(`\nrouter.test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
