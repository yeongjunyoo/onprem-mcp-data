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

// 미해소 개체의 사유 — 게이트가 개체를 못 찾았을 때 「왜」를 구조화 필드로 돌려준다.
//
// 컨텍스트를 비우는 것은 옳다(환각 차단). 그런데 "없다" 한 마디로는 호출한 쪽이
// 다음 행동을 고를 수 없다. 데이터에 아예 없는 이름인지, 비슷한 이름의 다른 개체가
// 있는지(오타·다른 표기)는 다른 상황이다. 후자도 해소하지는 않는다 — 같은 대상인지
// 모르는 채 그 개체의 관계를 넘기면 게이트가 막으려던 것을 다시 들이는 셈이다.
//
// 유사도는 정규화 편집 거리 하나다. 모델도 임베딩도 부르지 않으므로 같은 질의와
// 같은 개체 사전이면 사유와 후보가 항상 같다.

/** no_entity_term 은 질의에 개체 이름으로 볼 낱말이 없을 때(「Client」, 「고객사」처럼 유형 낱말뿐). ontology.search 만 돌려준다. */
export type NotFoundReason = "not_in_database" | "similar_name_mismatch" | "no_entity_term";

export interface NotFoundCandidate {
  name: string;
  type: string;
  /** 0~1. 1 - 편집거리/긴 쪽 길이 (공백·하이픈·밑줄·마침표를 빼고 소문자로 잰다). */
  score: number;
}

export interface NotFound {
  reason: NotFoundReason;
  /** 못 찾은 질의어. 비슷한 이름이 있으면 그 질의어, 없으면 질의의 첫 개체 후보. */
  query_entity: string;
  /** similar_name_mismatch 일 때만 채운다. 점수 내림차순, 같으면 이름 순. */
  candidates: NotFoundCandidate[];
}

/** 이 점수 이상이면 「비슷한 이름」이다. 임계값은 이 한 곳에만 둔다.
 *
 * 0.6 은 글자의 60% 이상이 그대로 남는다는 뜻이다. 세 글자 이름은 한 글자 차이(0.67)
 * 까지 걸리고 두 글자 차이(0.33)는 빠진다. 두 글자 이름의 한 글자 차이(0.5)는 다른
 * 개체일 가능성이 더 커서 넣지 않는다. */
export const NOT_FOUND_SIMILARITY = 0.6;

/** 사유와 함께 보여 줄 후보 수. 판정에는 쓰지 않는다. */
export const NOT_FOUND_MAX_CANDIDATES = 3;

function norm(s: string): string {
  return s.normalize("NFC").toLowerCase().replace(/[\s\-_.]+/g, "");
}

function levenshtein(a: string[], b: string[]): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** 정규화 편집 유사도(0~1). 대칭이고 결정론이다. */
export function nameSimilarity(a: string, b: string): number {
  const x = [...norm(a)];
  const y = [...norm(b)];
  const longer = Math.max(x.length, y.length);
  if (longer === 0) return 0;
  return 1 - levenshtein(x, y) / longer;
}

/** 질의어 하나와 비슷한 이름의 개체들. 편집거리는 길이 차 이상이므로, 길이 비율이
 * 임계값에 못 미치는 이름은 거리를 재지 않고 건너뛴다. */
export function similarNames(
  term: string,
  lexicon: readonly { name: string; type: string }[],
): NotFoundCandidate[] {
  const tl = [...norm(term)].length;
  if (tl === 0) return [];
  const seen = new Set<string>();
  const out: { name: string; type: string; raw: number }[] = [];
  for (const e of lexicon) {
    const key = `${e.type}\u0000${e.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const el = [...norm(e.name)].length;
    if (Math.min(tl, el) / Math.max(tl, el) < NOT_FOUND_SIMILARITY) continue;
    const raw = nameSimilarity(term, e.name);
    if (raw >= NOT_FOUND_SIMILARITY) out.push({ name: e.name, type: e.type, raw });
  }
  const byCodePoint = (p: string, q: string) => (p < q ? -1 : p > q ? 1 : 0);
  return out
    .sort((p, q) => q.raw - p.raw || byCodePoint(p.name, q.name) || byCodePoint(p.type, q.type))
    .slice(0, NOT_FOUND_MAX_CANDIDATES)
    .map((c) => ({ name: c.name, type: c.type, score: Number(c.raw.toFixed(3)) }));
}

/** 개체 이름처럼 생긴 질의어인가. 맞으면 이름 부분(뒤에 붙은 조사를 뗀 것)을, 아니면 null.
 *
 * 질의어 일부만 해소된 섞인 질문에서 해소되지 않은 질의어를 「데이터에 없다」고 말할지 가른다.
 * 사업자 식별자 꼴(Client-A, Product-C1)과 조직 접미사(물산, 전자, 팀, 사업부 …)로 끝나는 낱말만
 * 이름으로 본다. 「등록된」, 「이전」 같은 일반 낱말은 해소되지 않아도 개체가 아니다 — 그 낱말을
 * 개체로 읽어 「찾지 못했습니다」라고 답한 오라우팅이 실측에 있었다(근거표 「넣지 않은 것」). */
const NAME_ID = /^[A-Z][A-Za-z]*-[A-Z]{1,3}\d*$/;
const ORG_NAME =
  /^([가-힣A-Za-z0-9]+?(?:물산|전자|상사|산업|건설|은행|증권|보험|카드|그룹|제약|화학|중공업|통신|테크|팀|사업부|본부|연구소))(?:이랑|랑|하고|이나|이며|이고|께서|한테)?$/;
export function entityLikeName(term: string): string | null {
  if (NAME_ID.test(term)) return term;
  return term.match(ORG_NAME)?.[1] ?? null;
}

/** 못 찾은 개체로 이름을 댈 질의어. 이름처럼 생긴 낱말(조직 접미사, 대문자, 하이픈, 숫자)을 먼저 고르고
 * 없으면 첫 질의어다. 「Who manages the Samsung account?」에서 「Who」가 아니라 「Samsung」(D5). */
function namedFirst(terms: readonly string[]): string {
  return terms.find((t) => entityLikeName(t) !== null || /[A-Z0-9-]/.test(t)) ?? terms[0] ?? "";
}

/** 해소에 실패한 질의어들을 사유 하나로 분류한다.
 *
 * 비슷한 이름이 있는 질의어가 하나라도 있으면 similar_name_mismatch 이고, 최고 점수
 * 후보를 가진 질의어가 query_entity 가 된다(동점이면 질의에서 먼저 나온 쪽). 없으면
 * not_in_database 이고 이름처럼 생긴 첫 질의어(없으면 첫 질의어)가 query_entity 다. */
export function classifyNotFound(
  terms: readonly string[],
  lexicon: readonly { name: string; type: string }[],
): NotFound {
  let best: { term: string; candidates: NotFoundCandidate[] } | undefined;
  for (const term of terms) {
    const candidates = similarNames(term, lexicon);
    if (candidates.length && (!best || candidates[0].score > best.candidates[0].score)) {
      best = { term, candidates };
    }
  }
  if (!best) return { reason: "not_in_database", query_entity: namedFirst(terms), candidates: [] };
  return { reason: "similar_name_mismatch", query_entity: best.term, candidates: best.candidates };
}

/** 어느 테이블에도 없는 속성. [질문의 낱말, 답에 쓸 항목 이름].
 *
 * 정형 레인의 7B 는 없는 열을 다른 열로 바꿔 답했다(랜덤 테스트 사전 점검 D2): 「직원들의 평균 나이」에
 * 평균 근속연수로 「약 3.31살」, 「남자 직원」에 직급 조건으로 「45명」. 이메일 주소는 있는 열이라 「주소」는
 * 메일 뒤가 아닐 때만 본다. 「연락처」는 고객사 연락 담당자, 메일 열이 있어 넣지 않는다. */
const ABSENT_ATTRIBUTES: [RegExp, string][] = [
  [/나이|연령/, "나이"],
  [/생년월일|생일|출생/, "생년월일"],
  [/성별|남자|여자|남성|여성|남직원|여직원/, "성별"],
  [/(?<!메일\s?)(?<!email\s?)주소/i, "주소"],
  [/전화\s?번호|휴대폰|핸드폰|휴대\s?전화/, "전화번호"],
  [/학력|출신\s?학교|졸업/, "학력"],
  [/국적/, "국적"],
  [/혈액형/, "혈액형"],
  [/결혼|기혼|미혼|배우자|자녀/, "결혼 여부"],
  [/주민등록번호|주민번호/, "주민등록번호"],
  // 인사 기록(랜덤 테스트 사전 점검 2차 R7). 직원 표에는 연차, 휴가, 근태, 평가 열이 없다. 「직원별 남은 연차 일수」에 7B 가
  // 입사일로 「윤소연: 336일」을 계산해 답했고, 「인사 평가 점수가 가장 높은 직원」은 연봉 순으로 골랐다. 「연차」 하나는 근속
  // 연수(연차가 높은 직원)일 수 있어 휴가의 뜻일 때만 본다. 「연휴가」, 「최고과 최저」, 「작성과」의 휴가, 고과, 성과는 다른 말이다.
  [/(남은|잔여|사용한|쓴)\s?연차|연차\s?(휴가|일수|사용|신청|며칠|몇\s?일)/, "연차"],
  [/(?<!연)휴가/, "휴가"],
  [/근태|출퇴근|결근/, "근태"],
  [/인사\s?(평가|고과)|평가\s?(점수|등급)|(?<![가-힣])(고과|성과\s?(평가|점수|등급))/, "인사 평가"],
];
/** 고객사의 직원 수. 직원 테이블은 우리 회사 직원이라 고객사의 인원은 데이터에 없다(D2: 「Client-A의 직원
 * 수」에 경영지원팀 인원 8명). 고객사를 담당하는 우리 직원 수(담당, 맡은)는 있는 데이터라 제외한다. */
const CLIENT_REF = /Client[-\s]?[A-Za-z]{1,2}(?![A-Za-z0-9])|고객사|거래처/i;
const HEADCOUNT = /직원\s*수|직원[은이]\s*몇|인원|임직원|종업원|사원\s*수/;
const MANAGED = /담당|맡|관리|배정/;
/** 사람의 성과(「성과가 가장 좋은 직원」). 매출, 영업, 계약의 성과는 있는 데이터라 제외한다. */
const PERFORMANCE = /(?<![가-힣])성과/;
const PERSON = /직원|사원|팀원|사람|누구/;
const BUSINESS = /매출|영업|판매|계약|실적|수익|금액/;

/** 질문이 묻는 항목이 데이터에 없으면 그 항목 이름, 있으면 null. 결정론이다.
 * 스키마 카드에 같은 낱말이 있으면(그 열이 생기면) 막지 않는다 — 있는 열을 막지 않게 카드로 확인한다. */
export function absentAttribute(query: string, schemaCard: string): string | null {
  for (const [re, label] of ABSENT_ATTRIBUTES) {
    const m = query.match(re);
    if (m && !schemaCard.includes(m[0]) && !schemaCard.includes(label)) return label;
  }
  if (CLIENT_REF.test(query) && HEADCOUNT.test(query) && !MANAGED.test(query)) return "고객사의 직원 수";
  if (PERFORMANCE.test(query) && PERSON.test(query) && !BUSINESS.test(query) && !schemaCard.includes("성과")) return "성과 평가";
  return null;
}

/** 없는 항목을 물은 질문의 답. 다른 열로 바꿔 답하지 않는다. */
export function describeAbsentAttribute(label: string): string {
  return `질문에 나온 항목(${label})은 이 데이터에 없는 정보라 답할 수 없습니다. 다른 항목으로 바꿔 답하지 않았습니다.`;
}

/** 질의에 개체 이름으로 볼 낱말이 없을 때의 문장. retrieve 의 그래프 줄과 ontology.search 의 사유가 같은 말을 쓴다. */
export const NO_ENTITY_TERM = "질의에서 개체 이름으로 볼 낱말을 찾지 못해 지식그래프를 탐색하지 않았습니다.";

/** 사유를 한국어 한 문단으로. 그래프 컨텍스트와 ask 의 답이 같은 문장을 쓴다. */
export function describeNotFound(nf: NotFound): string {
  if (nf.reason === "no_entity_term") return NO_ENTITY_TERM;
  const head = `질문에 나온 개체(${nf.query_entity})를 데이터베이스에서 찾지 못했습니다.`;
  if (nf.reason === "not_in_database") {
    return `${head} 이름이 비슷한 개체도 없습니다. 해당 개체는 데이터셋에 존재하지 않습니다.`;
  }
  const list = nf.candidates.map((c) => `${c.name}(${c.type})`).join(", ");
  return (
    `${head} 이름이 비슷한 개체는 있습니다: ${list}. ` +
    "같은 대상인지 확인되지 않아 그 개체의 정보로는 답하지 않았습니다."
  );
}
