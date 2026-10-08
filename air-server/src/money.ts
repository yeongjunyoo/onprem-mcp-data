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

// 질문 속 한국어 금액 표현을 만원 단위 값으로 읽는다(G17 ⑥).
//
// Company-X 의 금액 열(연봉 salary, 계약 금액과 매출 amount, 예산 budget, 월 이용료 price_monthly)은 만원 단위다.
// 스키마 카드에 「연봉 5천만 원 = 5000」, 「1억 원 = 10000」을 적어 둬도 7B 는 「연봉이 2억 원 이상인 직원 목록」을
// salary >= 2000 으로 써 직원 45명을 모두 돌려줬다(3/3, 경계 실측). 그래서 질문의 금액 옆에 만원 값을 적어
// 생성 모델에 넘기고(annotateMoney), 생성 SQL 이 금액 열을 그 값과 10배수로 어긋난 숫자와 비교하면 실행 전 검사가
// 고치게 한다(sqltrust.ts checkMoney).
//
// 금액으로 읽는 것: 아라비아 숫자로 시작하고
//   조가 있는 것(「1조 원」 = 1억 만원, 「1.5조」, 「1조 5천억 원」, 「1조 5천만 원」. 조 뒤의 억, 만 자리도 읽는다),
//   억이 있는 것(「2억 원」, 「2억원」, 「1.5억」, 「1억 5천만 원」, 만을 줄인 「1억 5천」, 원 단위가 붙은 「1억 5천 원」),
//   천만, 백만, 십만인 것(「5천만 원」, 「5천만 이상」),
//   원으로 끝나는 만 단위(「3,000만 원」, 「500만원」).
// 한글 수(「오천만 원」, 「삼억」, 「이천오백만 원」)와 백만 원 단위 「10M」(질문에 금액 낱말이 있을 때)은 아라비아 숫자 꼴로 바꿔
// 같은 규칙으로 읽는다(normalized). 자리와 text 는 원문의 것이다.
// 읽지 않는 것: 원이 없는 만 단위(「500만 명」, 「3000만」), 뒤에 세는 말이나 다른 통화가 오는 것(「1억 건」, 「2억 년」,
// 「1억 달러」), 단위 없는 숫자가 억이나 조 뒤에 붙어 값이 갈리는 것(「1억 2」, 「1조 2」), 조항 번호(「제1조」, 「제 3조」),
// 숫자와 띄어 쓴 조나 뒤에 다른 한글이 붙은 조(「08 조현우」, 「1조각」), 낱말의 일부인 한글 수(「오만하다」, 「이만큼」).

/** 질문 속 금액 표현 하나. text 는 질문에 쓰인 그대로(원까지), manwon 은 만원 단위 값. */
export interface MoneyMention {
  text: string;
  start: number;
  end: number;
  manwon: number;
}

const NUM = /(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?/y;
const MULT: Record<string, number> = { 천: 1000, 백: 100, 십: 10 };
/** 원 없이 이 말이 뒤따르면 금액이 아니다. */
const COUNTER = /^ ?(?:명|건|개|회|번|년|배|살|세|개월|시간|분|초|달러|위안|유로|파운드)/;

/** 공백 하나까지 건너뛴다. */
const sp = (q: string, i: number) => (q[i] === " " ? i + 1 : i);

function num(q: string, i: number): { v: number; end: number } | null {
  NUM.lastIndex = i;
  const m = NUM.exec(q);
  return m ? { v: Number(m[0].replace(/,/g, "")), end: i + m[0].length } : null;
}

/** 만원 값을 프롬프트와 사유에 쓰는 꼴로. 정수면 정수, 아니면 소수 넷째 자리까지. */
export function formatManwon(v: number): string {
  return String(Math.round(v * 10000) / 10000);
}

/** q[i] 에서 시작하는 금액 표현 하나. 금액이 아니면 null. */
function readMoney(q: string, i: number): MoneyMention | null {
  let a = num(q, i);
  if (!a) return null;
  let j = sp(q, a.end);
  let manwon = 0;
  let end: number;
  let big: boolean; // 조나 억, 천만, 백만, 십만이면 원이 없어도 금액이다
  // 조 = 1억 만원. 「1조 원」을 금액으로 읽지 못해 7B 가 amount > 10000(1억)으로 조회했다(랜덤 테스트 3차 U05, 3/3).
  // 조 뒤의 억 자리(「1조 5천억」)는 이어서 억으로, 만 자리(「1조 5천만」)는 만원으로 읽는다.
  // 조는 숫자에 바로 붙고 뒤에 원, 억, 만, 천, 백, 십 말고 다른 한글 음절이 붙지 않을 때만 금액이다(끝, 공백, 문장부호는 된다).
  // 「제」 뒤는 조항 번호다(「제1조」, 「제 3조」). 「2026-10-08 조현우가 처리한 티켓은?」을 「08 조(=800000000만 원)현우가」로,
  // 「계약서 제 3조 내용 알려줘」를 「제 3조(=300000000만 원)」로 적어 7B 프롬프트에 넘겼다.
  if (q[j] === "조") {
    if (j !== a.end || /제\s*$/.test(q.slice(Math.max(0, i - 3), i))) return null;
    if (/[가-힣]/.test(q[j + 1] ?? "") && !/[원억만천백십]/.test(q[j + 1])) return null; // 「1조각」, 「08조현우」
    manwon = a.v * 100000000;
    end = j + 1;
    const k0 = sp(q, end);
    const b = /\d/.test(q[k0] ?? "") ? num(q, k0) : null;
    let k = b?.end ?? 0;
    const mul = b ? MULT[q[k]] : undefined;
    if (mul) k++;
    if (b && q[k] === "억") {
      a = { v: b.v * (mul ?? 1), end: k };
      j = k;
    } else {
      if (b && q[k] === "만") {
        manwon += b.v * (mul ?? 1); // 「1조 5천만 원」
        end = k + 1;
      } else if (b) return null; // 「1조 2」
      const w = sp(q, end);
      if (q[w] === "원") end = w + 1;
      else if (COUNTER.test(q.slice(end))) return null; // 「1조 건」
      return { text: q.slice(i, end), start: i, end, manwon: Math.round(manwon * 10000) / 10000 };
    }
  }
  if (q[j] === "억") {
    manwon += a.v * 10000;
    end = j + 1;
    big = true;
    // 억 뒤의 만 단위: 「5천만」, 「5000만」, 그리고 만을 줄인 「5천」. 바로 뒤에 원이 오면 그 자리는 원 단위다
    // (「1억 5천 원」 = 1억 5천 원 = 10000.5만 원. 만을 줄인 읽기는 원이 없을 때만, PR #257 Codex)
    const k0 = sp(q, end);
    if (/\d/.test(q[k0] ?? "")) {
      const b = num(q, k0)!;
      let k = b.end;
      const mul = MULT[q[k]];
      if (mul) k++;
      if (q[k] === "만") {
        end = k + 1;
        manwon += b.v * (mul ?? 1);
      } else if (q[sp(q, k)] === "원") {
        end = k;
        manwon += (b.v * (mul ?? 1)) / 10000;
      } else if (mul === 1000) {
        end = k;
        manwon += b.v * 1000;
      } else return null; // 「1억 2」: 단위 없는 숫자가 붙어 어느 값인지 모른다
    }
  } else {
    let k = j;
    const mul = MULT[q[k]];
    if (mul) k++;
    if (q[k] !== "만") return null;
    manwon = a.v * (mul ?? 1);
    end = k + 1;
    big = mul !== undefined;
  }
  const w = sp(q, end);
  if (q[w] === "원") end = w + 1;
  else if (!big || COUNTER.test(q.slice(end))) return null;
  return { text: q.slice(i, end), start: i, end, manwon: Math.round(manwon * 10000) / 10000 };
}

const KO_DIGIT: Readonly<Record<string, number>> = { 일: 1, 이: 2, 삼: 3, 사: 4, 오: 5, 육: 6, 칠: 7, 팔: 8, 구: 9 };
const KO_SMALL: Readonly<Record<string, number>> = { 십: 10, 백: 100, 천: 1000 };
/** 한글 수 뒤에 올 수 있는 것: 끝, 한글 아닌 글자, 원, 비교와 어림의 말, 조사. 이 밖의 한글이 붙으면 낱말의 일부다(「오만하다」, 「이만큼」). */
const KO_FOLLOW = /^(?:$|[^가-힣]|원|이상|이하|초과|미만|넘|짜리|대|선|정도|가량|쯤|의|을|를|이|가|은|는|으로|로|보다|까지|부터|에|도|씩)/;
/** 「10M」, 「1.5M」: 백만 원 단위. 질문에 금액 낱말이 있을 때만 금액으로 읽는다. */
const MILLION = /(?<![A-Za-z0-9_$₩.,])(\d+(?:\.\d+)?)\s?[Mm](?![A-Za-z0-9])/g;
const MONEY_WORD = /금액|연봉|급여|월급|예산|매출|가격|이용료|비용|단가|(?<![가-힣])원(?![가-힣])/;

/** q[i] 에서 시작하는 한글 수 금액(「오천만」, 「삼억」, 「이천오백만」, 「일억 오천만」, 「백만」)의 아라비아 숫자 꼴. 숫자 낱말 뒤에 만, 억,
 * 조가 있어야 하고 뒤에 다른 한글이 붙으면 낱말의 일부라 읽지 않는다. 만 자리가 「N천」 하나면 「5천만」처럼 천을 남긴다(아라비아
 * 「5천만」과 같이 원이 없어도 금액이다). 만, 억, 조로 끝나지 않는 꼬리(「일억 오천」의 오천)는 읽지 않는다. */
function koreanMoney(q: string, i: number): { end: number; text: string } | null {
  let text = "";
  let end = i;
  let section = 0;
  let digit: number | null = null;
  let terms = 0;
  let small = "";
  for (let j = i; j < q.length; j++) {
    const c = q[j];
    if (KO_DIGIT[c] !== undefined && digit === null) digit = KO_DIGIT[c];
    else if (KO_SMALL[c] !== undefined) {
      section += (digit ?? 1) * KO_SMALL[c];
      digit = null;
      terms++;
      small = c;
    } else if ((c === "만" || c === "억" || c === "조") && section + (digit ?? 0) > 0) {
      const value = section + (digit ?? 0);
      text += c === "만" && terms === 1 && digit === null ? `${value / KO_SMALL[small]}${small}만` : `${value}${c}`;
      end = j + 1;
      section = 0;
      digit = null;
      terms = 0;
      if (q[j + 1] === " " && (KO_DIGIT[q[j + 2]] !== undefined || KO_SMALL[q[j + 2]] !== undefined)) {
        text += " ";
        j++;
      }
    } else break;
  }
  if (end === i || !KO_FOLLOW.test(q.slice(end))) return null;
  return { end, text: text.trimEnd() };
}

/** 금액 해석 앞에 한글 수와 「M」을 아라비아 숫자 꼴로 바꾼 글, 그리고 바꾼 글의 자리마다 원문에서 시작과 끝 자리. 「연봉이 오천만 원
 * 이상」은 7B 가 salary >= 1000 으로 써 45명을 답했고(실제 32명), 「계약 금액이 10M 이상」은 amount >= 10000(1억)으로 1건을
 * 답했다(10M 원 = 1,000만 원 이상은 56건. 랜덤 테스트 사전 점검 4차 P9). 바꾼 것이 없으면 원문 그대로다. */
function normalized(q: string): { text: string; start: number[]; end: number[] } {
  const start: number[] = [];
  const end: number[] = [0];
  let text = "";
  // 그대로 둔 글자는 제자리, 바꾼 글자는 모두 바꾼 원문 조각의 시작과 끝을 가리킨다.
  const put = (from: number, to: number, by: string) => {
    const kept = by === q.slice(from, to);
    for (let k = 0; k < by.length; k++) {
      start.push(kept ? from + k : from);
      end.push(kept ? from + k + 1 : to);
    }
    text += by;
  };
  const millions = new Map(MONEY_WORD.test(q) ? [...q.matchAll(MILLION)].map((m) => [m.index ?? 0, m] as const) : []);
  for (let i = 0; i < q.length; ) {
    const m = millions.get(i);
    const k = m || /[가-힣\d.,]/.test(q[i - 1] ?? "") ? null : koreanMoney(q, i);
    if (m) {
      const to = i + m[0].length;
      put(i, to, `${formatManwon(Number(m[1]) * 100)}만${q[sp(q, to)] === "원" ? "" : " 원"}`);
      i = to;
    } else if (k) {
      put(i, k.end, k.text);
      i = k.end;
    } else {
      put(i, i + 1, q[i]);
      i++;
    }
  }
  return { text, start, end };
}

/** 질문 속 금액 표현을 앞에서부터. 다른 숫자나 영문자에 붙은 숫자(「C1」, 「1,5」)와 이미 단 주석 「(=…)」 안은 읽지 않는다.
 * 한글 수(「오천만 원」)와 「10M」은 아라비아 숫자 꼴로 바꿔 읽고(normalized), 자리와 text 는 원문의 것이다. */
export function moneyMentions(q: string): MoneyMention[] {
  const n = normalized(q);
  const t = n.text;
  const out: MoneyMention[] = [];
  let i = 0;
  while (i < t.length) {
    if (!/\d/.test(t[i]) || /[\d.,A-Za-z_]/.test(t[i - 1] ?? "") || t.slice(Math.max(0, i - 2), i) === "(=") {
      i++;
      continue;
    }
    const m = readMoney(t, i);
    if (m) {
      const start = n.start[m.start];
      const end = n.end[m.end];
      out.push({ text: q.slice(start, end), start, end, manwon: m.manwon });
      i = m.end;
    } else {
      while (i < t.length && /[\d.,]/.test(t[i])) i++;
    }
  }
  return out;
}

/** 질문의 금액 표현마다 바로 뒤에 만원 값을 적는다: 「2억 원」 → 「2억 원(=20000만 원)」. 금액 표현이 없으면 받은 그대로 돌려준다. */
export function annotateMoney(q: string): string {
  const found = moneyMentions(q).filter((m) => !q.startsWith("(=", m.end));
  if (!found.length) return q;
  let out = "";
  let at = 0;
  for (const m of found) {
    out += `${q.slice(at, m.end)}(=${formatManwon(m.manwon)}만 원)`;
    at = m.end;
  }
  return out + q.slice(at);
}
