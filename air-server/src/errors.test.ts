// describeError — 실패 이유가 **비지 않는다**는 것을 지킨다.
//
// 2026-08-17 실측: DB 가 죽은 상태로 `vector.search` 를 부르면 사용자가 이걸 읽었다.
//
//     {"ok": false, "hits": [], "embedder": "ollama:bge-m3@768", "error": ""}
//
// 원인은 `AggregateError.message === ""`. Node 가 여러 주소(::1, 127.0.0.1)로
// 붙어 보다 실패하면 AggregateError 를 던지고, 진짜 이유는 `errors[]` 안에 있다.
// `err instanceof Error ? err.message : String(err)` 는 그 빈 문자열을 그대로 통과시킨다.
//
// **실패 표식(ok:false)은 있는데 이유가 없는 상태**였다. verify-loud-failure 는
// 표식만 보므로 통과했다 — 정적 검사가 못 보는 층이다.
import { describeError } from "./errors.js";

let passed = 0;
let failed = 0;

function eq(actual: unknown, expected: unknown, label: string) {
  if (actual === expected) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL: ${label}\n    기대 ${JSON.stringify(expected)}\n    실제 ${JSON.stringify(actual)}`);
  }
}

function truthy(v: unknown, label: string) {
  if (v) passed++;
  else {
    failed++;
    console.error(`  FAIL: ${label} (값 ${JSON.stringify(v)})`);
  }
}

// ── 이 결함을 그대로 재현한 입력
{
  const inner = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5433"), {
    code: "ECONNREFUSED",
  });
  const agg = new AggregateError([inner], ""); // message 가 빈 문자열이다
  eq(agg.message, "", "AggregateError 의 message 는 실제로 비어 있다");
  const out = describeError(agg);
  truthy(out.length > 0, "AggregateError 에서 빈 문자열을 돌려주지 않는다");
  truthy(out.includes("ECONNREFUSED"), "내부 오류의 이유가 드러난다");
  truthy(out.includes("5433"), "어느 주소인지 드러난다 — 사용자가 고칠 단서");
}

// ── 여러 주소를 동시에 시도한 경우 전부 보인다
{
  const agg = new AggregateError([
    new Error("connect ECONNREFUSED ::1:5433"),
    new Error("connect ECONNREFUSED 127.0.0.1:5433"),
  ], "");
  const out = describeError(agg);
  truthy(out.includes("::1"), "IPv6 시도가 보인다");
  truthy(out.includes("127.0.0.1"), "IPv4 시도가 보인다");
}

// ── 평범한 Error
eq(describeError(new Error("boom")), "boom", "일반 Error 는 message 그대로");

// ── message 는 없고 code 만 있는 Error
{
  const e = Object.assign(new Error(""), { code: "ENOENT" });
  const out = describeError(e);
  truthy(out.includes("ENOENT"), "message 가 비면 code 라도 말한다");
}

// ── Error 가 아닌 것
eq(describeError("문자열 오류"), "문자열 오류", "문자열은 그대로");
truthy(describeError({}).length > 0, "객체를 던져도 빈 문자열이 아니다");
truthy(describeError(undefined).length > 0, "undefined 를 던져도 빈 문자열이 아니다");
truthy(describeError(null).length > 0, "null 을 던져도 빈 문자열이 아니다");

// ── 계약: 무엇을 넣어도 비지 않는다
for (const v of [new Error(""), new AggregateError([], ""), 0, "", false, NaN]) {
  truthy(describeError(v).length > 0, `빈 문자열 금지: ${String(v)}`);
}

console.log(`errors.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
