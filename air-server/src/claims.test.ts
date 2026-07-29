// claim 단위 접지 채점 테스트. LLM 심판이 아니라 원자 일치로 채점하므로 여기서
// 검증하는 것은 "분해와 채점이 결정론적으로 같은 결과를 내는가"다.
import { completeness, extractAtoms, scoreClaims, splitSentences } from "./claims.js";

let pass = 0,
  fail = 0;
function ok(cond: boolean, msg: string) {
  if (cond) pass++;
  else {
    fail++;
    console.error("  FAIL:", msg);
  }
}

function main() {
  // --- 1. 문장 분리 ---
  const sentences = splitSentences("Client-A는 3건입니다. 계약 총액은 45,000,000원입니다.\n감사합니다.");
  ok(sentences.length === 3, `문장 3개로 분리 (got ${sentences.length})`);

  // --- 2. 원자 추출 ---
  const atoms = extractAtoms("Client-A는 2025-10-19에 계약을 갱신했고 총액은 45,000,000원입니다.");
  ok(atoms.includes("Client-A"), "식별자를 뽑는다");
  ok(atoms.includes("2025-10-19"), "날짜를 뽑는다");
  ok(atoms.some((a) => a.includes("45,000,000")), "수치를 뽑는다");
  ok(extractAtoms("윤소연 팀장이 담당합니다.").includes("윤소연"), "인명+직함을 뽑는다");
  ok(extractAtoms("진행 상태는 in_progress입니다.").includes("in_progress"), "상태 값을 뽑는다");
  ok(extractAtoms("잘 부탁드립니다.").length === 0, "검증할 것이 없는 문장은 원자 0개");

  // --- 3. 접지 채점 ---
  const context = "[SQL 결과] Client-A 계약 건수 → count=3";
  const good = scoreClaims("Client-A는 3건의 계약을 보유하고 있습니다.", context);
  ok(good.scorable === 1, "채점 가능한 문장이 1개");
  ok(good.fullyGrounded === 1, "원자가 모두 접지됐다");
  ok(good.claimGroundedRate === 1, "문장 접지율 1.0");

  const bad = scoreClaims("Client-B는 7건의 계약을 보유하고 있습니다.", context);
  ok(bad.ungroundedAtoms.includes("Client-B"), "컨텍스트에 없는 개체를 실패로 잡는다");
  ok(bad.claimGroundedRate === 0, "접지 실패 문장은 0점");

  const mixed = scoreClaims("Client-A는 3건입니다. Client-Z는 9건입니다.", context);
  ok(mixed.fullyGrounded === 1, "한 문장만 전부 접지");
  ok(mixed.ungroundedAtoms.includes("Client-Z") && mixed.ungroundedAtoms.includes("9건"), "실패 원자를 전량 모은다");

  // --- 4. 쉼표와 단위 표기 흡수 ---
  const numContext = "총 계약 금액: 45000000원";
  ok(scoreClaims("총액은 45,000,000원입니다.", numContext).fullyGrounded === 1, "쉼표 표기 차이를 흡수한다");
  ok(scoreClaims("건수는 3건입니다.", "count=3").fullyGrounded === 1, "count=3 형태도 단위 표기와 만난다");

  // --- 5. 아무 말도 안 하는 답변은 만점이 아니다 ---
  const empty = scoreClaims("주어진 정보로는 알 수 없습니다.", context);
  ok(empty.scorable === 0, "원자가 없으면 채점 대상이 아니다");
  ok(empty.claimGroundedRate === null, "분모가 없으면 점수가 아니라 null");

  // --- 6. 완전성은 접지와 방향이 반대다 ---
  const full = completeness(["Client-A", "count=3"], context);
  ok(full.rate === 1, "필요한 근거를 모두 덮었다");
  const partial = completeness(["Client-A", "Product-C1"], context);
  ok(partial.missing.includes("Product-C1"), "빠뜨린 근거를 잡는다");
  ok(partial.rate === 0.5, "절반 덮음");

  // --- 7. 결정론 ---
  const a = scoreClaims("Client-A는 3건입니다. Client-B는 7건입니다.", context);
  const b = scoreClaims("Client-A는 3건입니다. Client-B는 7건입니다.", context);
  ok(JSON.stringify(a) === JSON.stringify(b), "같은 입력은 같은 출력");

  console.log(`\nclaims.test: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main();
