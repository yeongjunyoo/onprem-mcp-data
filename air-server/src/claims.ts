// claim 단위 접지 채점 — 답변을 검증 가능한 원자로 쪼개고 각각이 컨텍스트에 있는지 본다.
//
// 왜 바꾸는가. 지금까지의 접지 검사는 "답변이 언급한 개체가 컨텍스트에 있는가"였다.
// 개체 하나만 맞으면 통과라 문장 전체가 지어낸 것이어도 잡히지 않는다. 2026년 업계
// 평가는 근거 기반 생성을 **claim 단위**로 쪼개 각각의 접지와 전체 완전성을 나눠서 잰다.
//
// 우리 방식: LLM 심판을 쓰지 않는다. 문장을 나누고 각 문장에서 **검증 가능한 원자**만
// 뽑는다. 원자는 컨텍스트 문자열에 있거나 없거나 둘 중 하나이므로 채점이 결정론이다.
//
// 원자로 인정하는 것 (전부 데이터셋에 실재하는 형태):
//   - 식별자      Client-A, Product-C1, DOC-014
//   - 수치        3건, 45,000,000, 91%, 330ms, 2025-10-19
//   - 인명+직함   윤소연 팀장, 박민수 대리
//   - 상태 값     in_progress, resolved, active
//
// 원자가 없는 문장(인사말, "정보가 없습니다")은 채점 대상이 아니다. 없는 것을
// 채점하면 분모가 부풀어 점수가 좋아 보인다.

export interface Claim {
  sentence: string;
  atoms: string[];
  grounded: string[];
  ungrounded: string[];
  /** 원자가 없어 채점할 수 없는 문장 */
  scorable: boolean;
}

export interface ClaimScore {
  claims: Claim[];
  /** 채점 가능한 문장 수 */
  scorable: number;
  /** 모든 원자가 접지된 문장 수 */
  fullyGrounded: number;
  /** 원자 단위 접지율 */
  atomGroundedRate: number | null;
  /** 문장 단위 접지율 */
  claimGroundedRate: number | null;
  /** 접지 실패한 원자 전량 */
  ungroundedAtoms: string[];
}

const ID = /[A-Z][A-Za-z]*-[A-Z0-9]+/g;
const NUM = /\d[\d,]*(?:\.\d+)?\s*(?:%|건|명|개|원|초|분|시간|일|ms|GB|MB)?/g;
const DATE = /\d{4}-\d{2}-\d{2}/g;
const PERSON = /[가-힣]{2,4}(?=\s*(?:씨|님|과장|대리|부장|팀장|사원|이사))/g;
const STATUS = /\b(?:in_progress|completed|on_hold|planning|resolved|closed|open|active|critical|high|medium|low)\b/g;

/** 문장 분리. 한국어 종결과 마침표, 줄바꿈을 본다. */
export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+|(?<=(?:다|요|음|임))\s*[.。]\s*/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** 문장에서 검증 가능한 원자를 뽑는다. */
export function extractAtoms(sentence: string): string[] {
  const out = new Set<string>();
  for (const re of [ID, DATE, PERSON, STATUS]) {
    for (const m of sentence.match(re) ?? []) out.add(m.trim());
  }
  for (const m of sentence.match(NUM) ?? []) {
    const v = m.trim();
    // 한 자리 숫자만 있는 토큰은 노이즈가 많다(목록 번호 등). 두 자리 이상이거나 단위가 붙은 것만.
    if (/\d{2,}/.test(v) || /[%건명개원초분일]|ms|GB|MB|시간/.test(v)) out.add(v);
  }
  return [...out];
}

/** 원자가 컨텍스트에 있는지. 숫자는 쉼표 표기 차이를 흡수한다. */
function inContext(atom: string, context: string): boolean {
  if (context.includes(atom)) return true;
  const bare = atom.replace(/[,\s]/g, "");
  if (bare && context.replace(/[,\s]/g, "").includes(bare)) return true;
  // "3건" 같은 단위 부착형은 숫자만으로도 인정한다(컨텍스트가 count=3으로 적혀 있을 수 있다).
  const num = atom.match(/^\d[\d,]*/)?.[0]?.replace(/,/g, "");
  if (num && num.length >= 1 && new RegExp(`\\b${num}\\b`).test(context.replace(/,/g, ""))) return true;
  return false;
}

export function scoreClaims(answer: string, context: string): ClaimScore {
  const claims: Claim[] = [];
  for (const sentence of splitSentences(answer)) {
    const atoms = extractAtoms(sentence);
    const grounded = atoms.filter((a) => inContext(a, context));
    const ungrounded = atoms.filter((a) => !inContext(a, context));
    claims.push({ sentence, atoms, grounded, ungrounded, scorable: atoms.length > 0 });
  }
  const scorableClaims = claims.filter((c) => c.scorable);
  const totalAtoms = scorableClaims.reduce((n, c) => n + c.atoms.length, 0);
  const groundedAtoms = scorableClaims.reduce((n, c) => n + c.grounded.length, 0);
  const fully = scorableClaims.filter((c) => c.ungrounded.length === 0).length;
  return {
    claims,
    scorable: scorableClaims.length,
    fullyGrounded: fully,
    atomGroundedRate: totalAtoms ? Number((groundedAtoms / totalAtoms).toFixed(3)) : null,
    claimGroundedRate: scorableClaims.length ? Number((fully / scorableClaims.length).toFixed(3)) : null,
    ungroundedAtoms: scorableClaims.flatMap((c) => c.ungrounded),
  };
}

/**
 * 완전성 — 정답에 필요한 근거를 다 가져왔는가.
 * 접지와 방향이 반대다. 접지는 "지어내지 않았는가", 완전성은 "빠뜨리지 않았는가"다.
 * 둘을 한 지표로 뭉치면 아무 말도 안 하는 답변이 만점을 받는다.
 */
export function completeness(required: string[], context: string): { covered: string[]; missing: string[]; rate: number | null } {
  if (!required.length) return { covered: [], missing: [], rate: null };
  const covered = required.filter((r) => inContext(r, context));
  const missing = required.filter((r) => !inContext(r, context));
  return { covered, missing, rate: Number((covered.length / required.length).toFixed(3)) };
}
