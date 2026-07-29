// 한국어 정규화 계약 테스트. 데이터베이스도 모델도 없이 돈다.
//
// 여기서 검증하는 것은 "문자열이 예쁘게 잘리는가"가 아니라 **계약이 지켜지는가**다.
// 계약의 핵심은 하나다: 질의와 문서가 같은 함수를 통과하면 같은 형태로 만난다.
import { indexText, normalizeQuery, normalizeTokens, stripTails } from "./normalize.js";

let pass = 0,
  fail = 0;
function ok(cond: boolean, msg: string) {
  if (cond) pass++;
  else {
    fail++;
    console.error("  FAIL:", msg);
  }
}
const has = (arr: string[], v: string) => arr.includes(v);

function main() {
  // --- 1. 조사와 어미 ---
  ok(stripTails("고객사가") === "고객사", "조사 '가' 제거");
  ok(stripTails("고객사를") === "고객사", "조사 '를' 제거");
  ok(stripTails("고객사에서") === "고객사", "복합 조사 '에서' 제거");
  ok(stripTails("프로젝트로부터") === "프로젝트", "복합 조사 '으로부터' 제거");
  ok(stripTails("알려줘") === "알려줘" || stripTails("알려줘").length >= 2, "짧은 토큰은 통째로 지우지 않는다");
  ok(stripTails("이가") === "이가", "2음절 이하는 조사 제거를 하지 않는다(이름 보호)");

  // --- 2. 질의와 문서가 같은 형태로 만난다 (계약의 본질) ---
  const docTokens = normalizeTokens("Client-A 고객사의 미해결 티켓 목록");
  const qTokens = normalizeTokens("client a 고객사가 가진 티켓은?");
  const overlap = qTokens.filter((t) => docTokens.includes(t));
  ok(overlap.length >= 2, `질의와 문서가 최소 2개 토큰에서 만난다 (got ${overlap.join(",")})`);
  ok(has(docTokens, "고객사") && has(qTokens, "고객사"), "조사가 달라도 같은 정규형으로 만난다");

  // --- 3. 혼용 표기 분해 ---
  const p = normalizeTokens("Product-C1");
  ok(has(p, "product"), "영문 부분이 토큰이 된다");
  ok(has(p, "c1"), "영숫자 부분이 토큰이 된다");
  ok(has(p, "productc1"), "결합형도 토큰이 된다");

  // --- 4. 띄어쓰기 변형 흡수 ---
  const spaced = normalizeTokens("고객 사 목록");
  ok(has(spaced, "고객사"), "띄어 쓴 표기가 붙임 표기와 만난다");

  // --- 5. 동의어는 스키마 어휘로만 접힌다 ---
  ok(has(normalizeTokens("클라이언트 목록"), "고객사"), "클라이언트 -> 고객사");
  ok(has(normalizeTokens("담당 엔지니어"), "직원"), "엔지니어 -> 직원");
  ok(has(normalizeTokens("진행중인 프로젝트"), "in_progress"), "진행중 -> 상태 열거값");

  // --- 6. tsquery 안전성 ---
  const evil = normalizeQuery("고객사 & | ! ( ) : * ' \" ; -- drop table");
  // 우리가 만드는 구분자는 " | "와 ":*"뿐이다. 그 둘을 걷어낸 나머지에 연산자가 남으면 누출이다.
  const bare = evil.tsquery.split(" | ").map((t) => t.replace(/:\*$/, ""));
  ok(bare.every((t) => /^[가-힣a-z0-9]+$/.test(t)), `토큰에 연산자 문자가 새지 않는다 (got ${bare.join(",")})`);
  ok(!evil.tokens.some((t) => /[&!()'";:*]/.test(t)), "토큰 자체에 연산자 문자가 없다");
  ok(evil.tsquery.includes("고객사:*"), "정상 토큰은 접두 매칭으로 들어간다");
  const empty = normalizeQuery("!!!");
  ok(empty.tsquery === "", "토큰이 없으면 빈 tsquery");

  // --- 7. 결정론 ---
  const a = normalizeTokens("Client-A 고객사의 미해결 티켓").join("|");
  const b = normalizeTokens("Client-A 고객사의 미해결 티켓").join("|");
  ok(a === b, "같은 입력은 같은 출력(결정론)");

  // --- 8. 감사 정보 ---
  const audited = normalizeQuery("클라이언트가 진행중인 프로젝트를 알려줘");
  ok(audited.applied.stripped.length > 0, "무엇을 잘랐는지 기록한다");
  ok(audited.applied.synonyms.length > 0, "무엇을 동의어로 접었는지 기록한다");
  ok(audited.tokens.length > 0, "토큰이 비지 않는다");

  // --- 9. 색인 문자열 ---
  const idx = indexText("Client-A 고객사의 미해결 티켓");
  ok(idx.split(" ").length === normalizeTokens("Client-A 고객사의 미해결 티켓").length, "색인 문자열은 토큰 나열이다");
  ok(!idx.includes("'"), "색인 문자열에 인용부호가 없다");

  // --- 10. 빈 입력과 경계 ---
  ok(normalizeTokens("").length === 0, "빈 문자열은 토큰 0개");
  ok(normalizeTokens("a").length === 0, "1글자 영문은 버린다");
  ok(normalizeTokens("가").length === 0, "1음절 한글은 버린다");

  console.log(`\nnormalize.test: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main();
