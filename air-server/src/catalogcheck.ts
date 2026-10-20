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

// 다른 회사 DB 점검 세트의 채점(cli/catalog-check.ts). 문항은 질문, 정답 SQL 과 그 행, 답 문장에 있어야 할 값(must)이다.
//
// 세 판정을 따로 낸다.
//   answerOk   답 문장(조회 행 블록을 뺀 생성 모델의 문장)에 must 값이 모두 있다. 수는 답에 나온 수를 모두 읽어 값으로 견준다
//              (523.06 과 523.060 은 같고, 2021 안의 21 은 21 이 아니다). 글자는 대소문자를 가리지 않고, 나라 이름은 한국어 이름도 받는다
//              (데이터는 영문인데 답은 「미국」으로 옮겨 적는다).
//   rowsExact  실행한 SQL 의 행이 정답 행과 같다. 행 순서와 행 안의 열 순서는 보지 않는다.
//   rowsCover  행 수가 같고 정답 행마다 결과 행 하나가 그 값을 모두 담는다. 묻지 않은 열을 더 고른 SQL 과 이름과 성을 두 열로 고른 SQL 도
//              맞게 본다.
// 채점 규칙은 점검 세트를 돌리기 전에 정했다(2026-10-20). 결과를 보고 규칙을 바꾸면 그 세트의 점수는 쓰지 않는다.

export interface CheckItem {
  id: string;
  question: string;
  difficulty: string;
  gold_sql: string;
  gold_rows: string[][];
  must: string[];
  note?: string;
}

/** 영문 국가명 → 답에 나올 한국어 이름. */
const COUNTRY_KO: Record<string, string[]> = {
  usa: ["미국"],
  "united states": ["미국"],
  canada: ["캐나다"],
  brazil: ["브라질"],
  france: ["프랑스"],
  germany: ["독일"],
  "united kingdom": ["영국"],
  "czech republic": ["체코"],
  portugal: ["포르투갈"],
  india: ["인도"],
  chile: ["칠레"],
  ireland: ["아일랜드"],
  hungary: ["헝가리"],
  austria: ["오스트리아"],
  finland: ["핀란드"],
  netherlands: ["네덜란드"],
  norway: ["노르웨이"],
  sweden: ["스웨덴"],
  spain: ["스페인"],
  poland: ["폴란드"],
  italy: ["이탈리아"],
  denmark: ["덴마크"],
  belgium: ["벨기에"],
  australia: ["호주", "오스트레일리아"],
  argentina: ["아르헨티나"],
};

const NUMERIC = /^-?[\d,]+(?:\.\d+)?$/;
/** 천 단위 쉼표를 지운다(1,234.5 → 1234.5). */
const dropThousands = (s: string) => s.replace(/(?<=\d),(?=\d{3}(?!\d))/g, "");

/** 답 문장에 값이 있는가. 수는 답의 수를 모두 읽어 값으로 견주고, 글자는 대소문자를 가리지 않고 찾는다. */
export function hasValue(answer: string, value: string): boolean {
  const v = value.trim();
  if (NUMERIC.test(v)) {
    const want = Number(v.replace(/,/g, ""));
    return (dropThousands(answer).match(/-?\d+(?:\.\d+)?/g) ?? []).some((t) => Number(t) === want);
  }
  const low = v.toLowerCase();
  return answer.toLowerCase().includes(low) || (COUNTRY_KO[low] ?? []).some((k) => answer.includes(k));
}

/** 비교용 칸 값: 수는 수로(523.060 → 523.06, 1,234 → 1234), 자정 시각은 날짜로, 글자는 소문자로. */
export function cellKey(v: unknown): string {
  if (v === null || v === undefined) return "null";
  const s = String(v).trim();
  if (NUMERIC.test(s)) return String(Number(s.replace(/,/g, "")));
  const midnight = /^(\d{4}-\d{2}-\d{2})[ T]00:00:00(?:\.0+)?$/.exec(s);
  if (midnight) return midnight[1];
  return s.toLowerCase();
}

const rowKey = (row: unknown[]) => row.map(cellKey).sort().join("\u0000");

/** 행 순서와 행 안의 열 순서를 보지 않고 두 결과가 같은가. */
export function rowsExact(got: unknown[][], gold: unknown[][]): boolean {
  if (got.length !== gold.length) return false;
  const count = new Map<string, number>();
  for (const r of got) count.set(rowKey(r), (count.get(rowKey(r)) ?? 0) + 1);
  for (const r of gold) {
    const k = rowKey(r);
    const n = count.get(k) ?? 0;
    if (!n) return false;
    count.set(k, n - 1);
  }
  return true;
}

/** 결과 행 하나가 담은 값들. 나란한 두 글자 칸을 공백으로 이은 값(이름과 성)도 넣는다. */
function cellBag(row: unknown[]): Map<string, number> {
  const keys = row.map(cellKey);
  const joined: string[] = [];
  for (let i = 0; i + 1 < row.length; i++) {
    if (!NUMERIC.test(String(row[i] ?? "").trim()) && !NUMERIC.test(String(row[i + 1] ?? "").trim())) joined.push(`${keys[i]} ${keys[i + 1]}`);
  }
  const bag = new Map<string, number>();
  for (const k of [...keys, ...joined]) bag.set(k, (bag.get(k) ?? 0) + 1);
  return bag;
}

/** 행 수가 같고 정답 행마다 아직 짝이 없는 결과 행 하나가 그 값을 모두 담는가. */
export function rowsCover(got: unknown[][], gold: unknown[][]): boolean {
  if (got.length !== gold.length) return false;
  const pool = got.map(cellBag);
  for (const g of gold) {
    const need = new Map<string, number>();
    for (const k of g.map(cellKey)) need.set(k, (need.get(k) ?? 0) + 1);
    const at = pool.findIndex((bag) => [...need].every(([k, n]) => (bag.get(k) ?? 0) >= n));
    if (at < 0) return false;
    pool.splice(at, 1);
  }
  return true;
}

/** 점검 세트 JSONL 을 읽는다. 문항마다 필수 칸이 있는지 보고, 없으면 그 줄 번호와 함께 멈춘다. */
export function parseCheckSet(text: string): CheckItem[] {
  const items: CheckItem[] = [];
  text.split("\n").forEach((line, i) => {
    if (!line.trim()) return;
    const o = JSON.parse(line) as Partial<CheckItem>;
    const bad = (["id", "question", "difficulty", "gold_sql"] as const).filter((k) => typeof o[k] !== "string" || !o[k]);
    const missing: string[] = [...bad];
    if (!Array.isArray(o.gold_rows)) missing.push("gold_rows");
    if (!Array.isArray(o.must) || !o.must.length) missing.push("must");
    if (missing.length) throw new Error(`점검 세트 ${i + 1}행: ${missing.join(", ")} 칸이 비었거나 형식이 다르다`);
    items.push(o as CheckItem);
  });
  return items;
}
