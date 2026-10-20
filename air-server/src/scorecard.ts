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

// 기능테스트 채점 규칙 — 최종 답이 정답과 맞는가를 **LLM 심판 없이** 가른다.
//
// 기능테스트 채점 기준(리원에이스 멘토링): 라우팅이 맞아도 답이 틀리면 오답, 라우팅이
// 달라도 답이 맞으면 정답. 그래서 판정은 **답 문자열과 정답 파일만** 본다. 컨텍스트도
// 라우트도 판정에 들어가지 않는다 — companyx:ask 가 재는 「근거가 컨텍스트에 있었나」와
// 다른 질문이다.
//
// 정답은 저장소의 정답 파일에서 계산한다. 손으로 적은 정답 문자열은 없다.
//   nl2sql          sql_gold.jsonl 의 정답 SQL 을 DB 에서 실행한 행
//   knowledge_graph kg_gold.json 명세를 graph/edges.json 위에서 푼 노드(kgGoldIds)
//   vector_search   vector_gold.json 의 문서·키워드·유형, 항목이 없으면 사업자 힌트가 말한 문서 유형
//
// 레인별 규칙. **확신이 없으면 오답으로 센다** — 부풀린 점수는 시연 당일에 깨진다.
//   nl2sql   질문이 묻는 값이 전부 답에 있다. 묻는 값 = 정답 행에서 id 열을 뺀 열.
//            LIMIT 질의(상위 N·최댓값)는 정렬 근거인 수치 열(COUNT·SUM)도 뺀다 — 질문은
//            순위의 주인을 묻는다. 수는 쉼표와 만·억을 풀고, 답에 적힌 자릿수로 반올림해
//            같으면서 상대오차 0.5% 이내여야 한다(589.97 은 맞고 「약 2억」은 틀린다).
//            ordered 정답은 답에 나온 순서도 같아야 한다. LIMIT 질의에서 같은 종류의
//            개체를 더 대면 오답이다(정렬 값이 경계와 같은 동점만 허용).
//   graph    정답 개체 이름이 전부 답에 있고, 정답과 같은 종류의 개체를 더 대지 않는다.
//            서울물산(데이터셋에 없는 고객사)은 기권하고 직원을 하나도 대지 않아야 정답이다.
//   vector   기권이 아니고, 정답 키워드가 전부 있고, 질문에 없는 구체 사실(개체 id·날짜·
//            단위가 붙은 수·영문 기술어) 하나 이상이 정답 문서 본문에 실제로 있고, 답이 댄
//            Client-/Product- 가 전부 정답 문서에 있다.
//            ★ 한계: 열린 질문이라 정답 문장이 없다. 「정답 문서의 사실로 답했다」까지만
//            가른다. 구체 사실이 하나도 없는 두루뭉술한 답은 오답으로 센다.
//   공통     데이터셋에 없는 Client-/Product- 를 대면 오답. 첫 문장이 「알 수 없다」면
//            기권이다. 조회·생성 실패 상태는 답이 없으므로 오답이다.
//
// 봉인 홀드아웃(CX_SET=holdout3|holdout4|holdout5)은 같은 규칙에 봉인 파일의 정답을 넣는다.
//   nl2sql   gold_sql 을 companyx 로 한정해 실행한 행. 날짜, 시각, 기간은 표기가 아니라 값으로
//            가른다(아래 「값의 모양」). 순서는 보지 않는다 — 봉인 파일에는 ordered 표시가 없다.
//   graph    gold_answer_names. 정답이 프로젝트와 사람의 짝이면 채점 불가다.
//   vector   gold_keywords 가 곧 답이다(정답 문서의 원문 문자열). 질문에 이미 있는 키워드를 뺀 나머지를
//            전부 대야 한다. 띄어쓰기, 문장부호, 대소문자만 가리지 않고 조사나 어미가 바뀐 말은 받지
//            않는다 — 풀어 쓴 옳은 답도 오답으로 세는 하한이다. 키워드가 없거나(3차) 정답 문서가 여럿이면
//            채점 불가다. 「정답 문서의 사실 하나」로 가르면 같은 문서의 다른 사실(검토자 대신 대응자)도
//            정답이 된다.
//   채점 불가 문항은 언제나 오답으로 판정하되 분모에서 뺀다. 이유는 결과 행의 unscorable 에 남는다.
//
// 규칙 판(CX_RULES). 위는 v1 이다. 공개 수치(사업자 28/30, 봉인 홀드아웃4 27/59)는 v1 로 냈고, CX_RULES=v1 이
// 그 규칙을 그대로 다시 낸다. 기본값 v2 는 2026-10-11 진단(답이 맞았는데 채점기가 못 본 21건)에서 정답의 뜻이나
// 데이터셋으로 설명되는 결함만 고쳤다. 고친 규칙마다 진단이 실제로 틀렸다고 본 답이 계속 틀리는지 scorecard.test 가 본다.
//   수가 든 키워드  「초기 대응: 40분」은 꼬리표가 아니라 값을 묻는다. 키워드의 수가 전부 같은 값, 같은 단위로 답에
//            있으면 댄 것이다(40분). 수가 없는 키워드는 v1 그대로 글자로 본다. 한 문항에 같은 단위의 수가 둘 이상이면
//            꼬리표(기본, 프리미엄)와 값의 짝이 엇갈린 답(기본 2130회, 프리미엄 263회)은 오답이다. 방향어(절감, 증가)는
//            보지 않는다 — 개발 세트에서는 질문이 방향을 말한다(절감률, 단축된다고).
//   질문이 말한 값  모든 정답 행에서 같은 글자 값이고 질문에 이미 있으면(부산, IT/SW) 요구하지 않는다. 그 열은 질문의
//            조건을 되풀이할 뿐이다. 행마다 다른 값(어느 행의 값인지 가르는 이름)과 수는 그대로 요구한다. 빼면 요구가
//            하나도 남지 않을 때는 빼지 않는다(「Client-A 가 부산에 있어?」는 부산을 대야 한다). 벡터 키워드도 같다.
//   묻는 것 라벨  eval/companyx/gold_labels.json. 정답 SQL 의 결과 열 가운데 질문이 묻는 열(asked_columns), 정답 키워드
//            가운데 질문이 묻는 부분(required_facts). 질문과 정답만 본 두 라벨러가 따로 썼고 합은 합집합이다(엄격한 쪽).
//            라벨은 정답을 좁힐 뿐 넓히지 않는다 — 열은 결과 열에서, 사실은 키워드의 부분 문자열에서만 고른다.
//   정답 정정  같은 파일의 errata. 데이터셋과 어긋난 정답(h4-59: edges.json 의 신고 고객사 13곳 중 10곳만 적었다)을
//            데이터셋 값으로 바꾼다. v1 은 원래 정답을 쓴다.
//   하지 않은 것  `= (SELECT MAX(...))` 정답을 LIMIT 처럼 보고 정렬 값을 빼는 규칙. 그런 정답 다섯 중 셋(h3-20, h4-10,
//            h4-20)은 질문이 그 값을 묻는다(「그달 금액도」, 「얼마였는지도」). 묻는지는 라벨이 정한다.
import type { AskResult } from "./pipeline.js";
import type { GraphNode } from "./companyx.js";

export type Lane = "nl2sql" | "vector_search" | "knowledge_graph";

/** 사업자 레인 라벨 → 라우터 출력. */
export const LANE_ROUTE: Record<Lane, string> = {
  nl2sql: "structured",
  vector_search: "semantic",
  knowledge_graph: "graph",
};

/** 채점 규칙 판. v1 은 공개 수치를 낸 규칙, v2 는 진단이 찾은 결함을 고친 규칙(머리말). */
export type ScoreRules = "v1" | "v2";

/** CX_RULES. 비우면 v2. 모르는 이름이면 던진다 — 오타가 조용히 다른 규칙으로 돌면 두 수치를 섞는다. */
export function parseRules(v: string | undefined): ScoreRules {
  const s = (v ?? "").trim() || "v2";
  if (s === "v1" || s === "v2") return s;
  throw new Error(`CX_RULES=${v} 를 모른다 — v1, v2 중 하나다`);
}

/** 문항 하나의 라벨(eval/companyx/gold_labels.json). v2 만 쓴다. */
export interface ItemLabels {
  /** SQL: 답이 값을 대야 하는 정답 결과 열 */
  asked_columns?: string[];
  /** 벡터: 답이 대야 하는 정답 키워드의 부분 문자열 */
  required_facts?: string[];
  /** 그래프 정정: 데이터셋으로 확인한 정답 이름(errata) */
  gold_answer_names?: string[];
}

// ── 응답 상태 ───────────────────────────────────────────────────────────
//
// 장애는 예외가 아니라 **상태**로 끝나야 한다. ask() 는 이미 실패를 답 문장으로
// 바꿔 돌려주는데(pipeline.ts), 그 문장만 보면 사람이 매번 읽어서 가려야 한다.
// 표와 JSON 이 한 단어로 말하게 한다.

export type AnswerState = "ok" | "degraded" | "empty" | "retrieval_failed" | "generation_failed";

export const STATE_LABEL: Record<AnswerState, string> = {
  ok: "정상",
  degraded: "부분 실패",
  empty: "근거 없음",
  retrieval_failed: "조회 실패",
  generation_failed: "생성 실패",
};

export function answerState(r: Pick<AskResult, "context" | "audit" | "graph">): AnswerState {
  const errs = r.audit?.branch_errors ?? [];
  // 생성 실패는 pipeline 이 `answer:` 로 표시한다. 조회는 성공했으니 따로 센다.
  if (errs.some((e) => e.startsWith("answer:"))) return "generation_failed";
  if (r.context.length === 0 && errs.length) return "retrieval_failed";
  // 데이터셋에 없는 대상은 그래프 레인이 「찾지 못했다」는 한 줄만 싣는다 — 근거가 아니다.
  if (r.context.length === 0 || r.graph?.strategy === "unresolved") return "empty";
  if (errs.length) return "degraded";
  return "ok";
}

// ── 개체 ────────────────────────────────────────────────────────────────

export interface Catalog {
  /** 노드 이름 → 종류(client/product/employee/department/project) */
  kindOf: Map<string, string>;
  /** 종류 → 이름들. 긴 이름부터 — 짧은 이름이 긴 이름 안에서 따로 잡히지 않게 한다 */
  names: Map<string, string[]>;
}

export function buildCatalog(nodes: Pick<GraphNode, "name" | "type">[]): Catalog {
  const kindOf = new Map<string, string>();
  const names = new Map<string, string[]>();
  for (const n of nodes) {
    kindOf.set(n.name, n.type);
    names.set(n.type, [...(names.get(n.type) ?? []), n.name]);
  }
  for (const [k, v] of names) names.set(k, [...new Set(v)].sort((a, b) => b.length - a.length));
  return { kindOf, names };
}

const ID_TOKEN = /\b(?:Client|Product)-[A-Z0-9]+\b/g;
const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const uniq = <T>(xs: T[]) => [...new Set(xs)];

function valueRe(value: string): RegExp {
  const v = norm(value);
  const esc = v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // 영문·숫자로 끝나는 값은 뒤에 영문·숫자가 이어지면 다른 값이다(Client-A ≠ Client-AC).
  const head = /^[A-Za-z0-9]/.test(v) ? "(?<![A-Za-z0-9-])" : "";
  const tail = /[A-Za-z0-9]$/.test(v) ? "(?![A-Za-z0-9])" : "";
  return new RegExp(head + esc + tail);
}

export function hasText(text: string, value: string): boolean {
  return valueRe(value).test(norm(text));
}

function firstIndex(text: string, value: string): number {
  return norm(text).search(valueRe(value));
}

/** 답이 대는 특정 종류의 개체. 이름 종류는 긴 이름 안에 든 짧은 이름을 따로 세지 않는다. */
export function mentionsOfKind(text: string, kind: string, cat: Catalog): string[] {
  if (kind === "client" || kind === "product") {
    const prefix = kind === "client" ? "Client-" : "Product-";
    return uniq([...text.matchAll(ID_TOKEN)].map((m) => m[0]).filter((t) => t.startsWith(prefix)));
  }
  let rest = norm(text);
  const out: string[] = [];
  for (const n of cat.names.get(kind) ?? []) {
    if (!hasText(rest, n)) continue;
    out.push(n);
    rest = rest.split(norm(n)).join(" ");
  }
  return out;
}

/** 데이터셋에 없는 Client-/Product- — 지어낸 개체다. */
export function inventedIds(text: string, cat: Catalog): string[] {
  return uniq([...text.matchAll(ID_TOKEN)].map((m) => m[0])).filter((t) => !cat.kindOf.has(t));
}

// ── 수 ──────────────────────────────────────────────────────────────────

interface Num {
  value: number;
  /** 답이 적은 가장 작은 단위(1·만·억). 자릿수 비교를 이 단위에서 한다 */
  quantum: number;
  decimals: number;
}

const UNIT: Record<string, number> = { 조: 1e12, 억: 1e8, 천만: 1e7, 백만: 1e6, 만: 1e4, 천: 1e3 };
// 앞에 영문·숫자·점·하이픈이 붙은 수는 이름이나 날짜의 일부다(Product-C1, 2025-04-22 의 04).
const NUM_RE = /(?<![A-Za-z0-9_.-])(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?\s*(조|억|천만|백만|만|천)?/g;

export function numbersIn(text: string): Num[] {
  const raw = [...text.matchAll(NUM_RE)].map((m) => {
    const frac = m[2] ?? "";
    return {
      mant: Number(`${m[1].replace(/,/g, "")}${frac ? `.${frac}` : ""}`),
      unit: m[3] ? UNIT[m[3]] : 1,
      decimals: frac.length,
      start: m.index ?? 0,
      end: (m.index ?? 0) + m[0].length,
    };
  });
  const out: Num[] = [];
  for (let i = 0; i < raw.length; i++) {
    let { mant, unit, decimals } = raw[i];
    let value = mant * unit;
    let j = i;
    // 「2억 3,859만」 — 큰 단위 뒤에 작은 단위가 공백만 두고 붙으면 한 수다.
    while (
      j + 1 < raw.length &&
      raw[j].unit > 1 &&
      raw[j + 1].unit > 1 &&
      raw[j + 1].unit < raw[j].unit &&
      /^\s*$/.test(text.slice(raw[j].end, raw[j + 1].start))
    ) {
      j++;
      ({ mant, unit, decimals } = raw[j]);
      value += mant * unit;
    }
    out.push({ value, quantum: unit, decimals });
    i = j;
  }
  return out;
}

/** 정답 수가 답에 있는가. 금액·연봉 열에는 단위가 없어 「9520」도 「9,520만 원」도 같은
 * 값으로 쓰인다 — 원값과 만 단위 값을 둘 다 정답으로 본다. */
export function hasNumber(text: string, gold: string): boolean {
  const g = Number(gold);
  if (!Number.isFinite(g)) return false;
  for (const n of numbersIn(text)) {
    for (const G of [g, g * 1e4]) {
      const shown = n.value / n.quantum;
      const want = G / n.quantum;
      if (Number(want.toFixed(n.decimals)) !== Number(shown.toFixed(n.decimals))) continue;
      if (Math.abs(n.value - G) > Math.abs(G) * 0.005) continue;
      return true;
    }
  }
  return false;
}

// ── 값의 모양 ────────────────────────────────────────────────────────────
//
// 홀드아웃 정답 SQL 은 날짜, 시각, 기간을 돌려준다(사업자 30문항에는 없었다). node-postgres 는 date 와
// timestamp 를 Date 로, interval 을 객체로 준다. String() 으로 바꾸면 「Thu Aug 01 2024 00:00:00 GMT+0900」과
// 「[object Object]」가 정답 문자열이 된다 — 어떤 답에도 없는 글자라 그 문항은 소리 없이 늘 오답이다.
// 그래서 정답 값을 사람이 적는 모양으로 바꾸고, 판정은 표기가 아니라 값으로 한다.

export type ValueKind = "date" | "timestamp" | "month" | "duration";

const MON = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MON_RE = "(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?";

interface DateHit {
  y: number;
  m: number;
  d: number;
  /** 날짜 바로 뒤에 적은 시각(자정부터 분). 안 적었으면 없다 */
  minute?: number;
  /** 「오후 4시」처럼 시만 적었다 — 시 단위로만 비교한다 */
  hourOnly?: boolean;
}

function timeAfter(rest: string): Pick<DateHit, "minute" | "hourOnly"> {
  const hm = /^\s*(?:T|\s)?\s*(\d{1,2}):(\d{2})(?!\d)/.exec(rest);
  if (hm) return { minute: Number(hm[1]) * 60 + Number(hm[2]) };
  const ko = /^\s*(오전|오후)?\s*(\d{1,2})시(?!간)\s*(?:(\d{1,2})분)?/.exec(rest);
  if (!ko) return {};
  let h = Number(ko[2]);
  if (ko[1] === "오후" && h < 12) h += 12;
  if (ko[1] === "오전" && h === 12) h = 0;
  return { minute: h * 60 + Number(ko[3] ?? 0), hourOnly: ko[3] === undefined };
}

/** 답에 적힌 날짜. 2025-01-03, 2025.1.3, 2025/01/03, 2025년 1월 3일, 그리고 Jan 03 2025 — 파이프라인이
 * SQL 날짜 칸을 Date.toString() 모양으로 싣기 때문에 7B 가 그 표기를 그대로 옮겨 적기도 한다. */
function datesIn(text: string): DateHit[] {
  const out: DateHit[] = [];
  for (const m of text.matchAll(/(?<![\d.])(\d{4})\s*(?:[-./]|년)\s*(\d{1,2})\s*(?:[-./]|월)\s*(\d{1,2})(?!\d)\s*(?:일|\.)?/g)) {
    out.push({ y: +m[1], m: +m[2], d: +m[3], ...timeAfter(text.slice((m.index ?? 0) + m[0].length)) });
  }
  for (const m of text.matchAll(new RegExp(`\\b${MON_RE}\\s+(\\d{1,2}),?\\s+(\\d{4})(?!\\d)`, "gi"))) {
    const at = (m.index ?? 0) + m[0].length;
    out.push({ y: +m[3], m: MON.indexOf(m[1].toLowerCase()) + 1, d: +m[2], ...timeAfter(text.slice(at)) });
  }
  return out;
}

/** 정답 날짜(YYYY-MM-DD, 시각이 붙으면 YYYY-MM-DD HH:MM[:SS])가 답에 있는가. 연도까지 같아야 한다.
 * 시각은 답이 날짜 바로 뒤에 적었을 때만 비교한다 — 「접수일」을 물은 질문에 날짜만 댄 답은 맞고,
 * 다른 시각을 댄 답은 틀린다. */
export function hasDate(text: string, gold: string): boolean {
  const g = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(gold.trim());
  if (!g) return false;
  const want = g[4] === undefined ? undefined : Number(g[4]) * 60 + Number(g[5]);
  return datesIn(text).some(
    (h) =>
      h.y === +g[1] &&
      h.m === +g[2] &&
      h.d === +g[3] &&
      (want === undefined ||
        h.minute === undefined ||
        (h.hourOnly ? Math.floor(h.minute / 60) === Math.floor(want / 60) : h.minute === want)),
  );
}

/** 정답 달(YYYY-MM)이 답에 있는가. 「2026년 2월」「2026-02」. 연도는 적어야 한다. */
export function hasMonth(text: string, gold: string): boolean {
  const g = /^(\d{4})-(\d{2})$/.exec(gold.trim());
  if (!g) return false;
  const [y, m] = [+g[1], +g[2]];
  if (datesIn(text).some((h) => h.y === y && h.m === m)) return true;
  for (const x of text.matchAll(/(?<![\d.])(\d{4})\s*(?:[-./]|년)\s*(\d{1,2})(?!\d)/g)) if (+x[1] === y && +x[2] === m) return true;
  for (const x of text.matchAll(new RegExp(`\\b${MON_RE}\\s+(\\d{4})(?!\\d)`, "gi"))) {
    if (+x[2] === y && MON.indexOf(x[1].toLowerCase()) + 1 === m) return true;
  }
  return false;
}

const DUR_UNIT: Record<string, number> = { 일: 86_400, 시간: 3_600, 분: 60, 초: 1 };

/** 답에 적힌 기간. 「6일 21시간 50분」「165.8시간」처럼 이어 적은 단위는 한 기간으로 합친다.
 * 「5월 10일」「13시 24분」「1분기」는 날짜, 시각, 분기라 기간이 아니다. */
function durationsIn(text: string): { seconds: number; quantum: number; decimals: number }[] {
  const pieces = [...text.matchAll(/(?<![\d.,])(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?\s*(시간|일|분|초)(?!기)/g)]
    .filter((m) => !/(월|\d시)\s*$/.test(text.slice(0, m.index)))
    .map((m) => ({
      n: Number(`${m[1].replace(/,/g, "")}${m[2] ? `.${m[2]}` : ""}`),
      unit: DUR_UNIT[m[3]],
      decimals: (m[2] ?? "").length,
      start: m.index ?? 0,
      end: (m.index ?? 0) + m[0].length,
    }));
  const out: { seconds: number; quantum: number; decimals: number }[] = [];
  for (let i = 0; i < pieces.length; i++) {
    let seconds = pieces[i].n * pieces[i].unit;
    let j = i;
    while (
      j + 1 < pieces.length &&
      pieces[j + 1].unit < pieces[j].unit &&
      /^[\s,]*$/.test(text.slice(pieces[j].end, pieces[j + 1].start))
    ) {
      j++;
      seconds += pieces[j].n * pieces[j].unit;
    }
    out.push({ seconds, quantum: pieces[j].unit, decimals: pieces[j].decimals });
    i = j;
  }
  return out;
}

/** 정답 기간(「6일 21시간 50분 21초」)이 답에 있는가. 수와 같은 규칙이다 — 답이 적은 가장 작은 단위와
 * 자릿수로 반올림해 같으면서 상대오차 0.5% 이내(「6일 22시간」은 맞고 「약 7일」은 틀린다). */
export function hasDuration(text: string, gold: string): boolean {
  const g = durationsIn(gold);
  if (g.length !== 1) return false;
  const G = g[0].seconds;
  return durationsIn(text).some(
    (d) =>
      Number((G / d.quantum).toFixed(d.decimals)) === Number((d.seconds / d.quantum).toFixed(d.decimals)) &&
      Math.abs(d.seconds - G) <= G * 0.005,
  );
}

/** 초를 정답 기간 표기로. 0 인 윗단위는 쓰지 않고 초는 늘 쓴다(판정 자릿수의 기준이다). */
export function formatDuration(total: number): string {
  const t = Math.round(total * 1000) / 1000;
  const d = Math.floor(t / 86_400);
  const h = Math.floor((t % 86_400) / 3_600);
  const m = Math.floor((t % 3_600) / 60);
  const s = Number((t % 60).toFixed(3));
  const parts: string[] = [];
  if (d) parts.push(`${d}일`);
  if (d || h) parts.push(`${h}시간`);
  if (d || h || m) parts.push(`${m}분`);
  parts.push(`${s}초`);
  return parts.join(" ");
}

/** 문서 키워드가 답에 있는가. 대소문자, 띄어쓰기, 마크다운, 문장부호, 숫자 자리 쉼표는 같은 글자를 다르게
 * 적은 것이라 가리지 않는다. 조사나 어미가 바뀐 말은 다른 문장이라 받지 않는다. 날짜 키워드는 날짜로 본다. */
export function hasKeyword(text: string, key: string): boolean {
  if (/^\d{4}-\d{2}-\d{2}/.test(key.trim())) return hasDate(text, key);
  const clean = (s: string) =>
    s
      .toLowerCase()
      .replace(/(?<=\d),(?=\d)/g, "")
      .replace(/[*`"'“”‘’:,()[\]「」]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const k = clean(key);
  if (!k) return false;
  const body = k
    .split(" ")
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s*");
  const head = /^[a-z0-9]/.test(k) ? "(?<![a-z0-9])" : "";
  const tail = /[a-z0-9]$/.test(k) ? "(?![a-z0-9])" : "";
  return new RegExp(head + body + tail).test(clean(text));
}

// ── 수가 든 키워드 (v2) ─────────────────────────────────────────────────
//
// 봉인 홀드아웃4 의 키워드는 정답 문서의 문장 조각이다(「초기 대응: 40분」). 질문은 값을 묻고(「첫 대응 들어가기까지
// 시간 얼마나 걸렸대?」) 「40분」이 답이다. 꼬리표까지 글자 그대로 요구하면 옳은 답이 틀린다. 그래서 수가 든 키워드는
// 수마다 같은 값, 같은 단위를 답에서 찾는다. 다른 값(28% 대 40%)과 다른 단위(40초 대 40분)는 그대로 틀린다.

const KW_UNIT = "만\\s*원|억\\s*원|천\\s*원|원|%|퍼센트|GB|MB|TB|KB|ms|시간|개월|초|분|일|주|년|회|명|건|개|배";
// 날짜와 시각의 조각(2025-04-22 의 04, 16:33 의 33)과 이름의 일부(Product-C2 의 2)는 수가 아니다.
const KW_NUM = new RegExp(
  `(?<![A-Za-z0-9_.:/-])(\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.(\\d+))?(?![-:/.]\\d)(?:\\s*(${KW_UNIT}))?`,
  "gi",
);

interface Atom {
  value: number;
  unit: string;
  start: number;
  end: number;
}

/** 글에 적힌 수와 단위. 「4,098만 원」은 4098 과 만원이다. 「5월 10일」의 10일과 「13시 24분」의 24분은 날짜와 시각이라 뺀다. */
export function numberAtoms(text: string): Atom[] {
  return [...text.matchAll(KW_NUM)]
    .filter((m) => {
      const before = text.slice(0, m.index ?? 0);
      const unit = (m[3] ?? "").replace(/\s+/g, "");
      if (unit === "일" && /월\s*$/.test(before)) return false;
      if (unit === "분" && /\d\s*시\s*$/.test(before)) return false;
      return true;
    })
    .map((m) => ({
      value: Number(`${m[1].replace(/,/g, "")}${m[2] ? `.${m[2]}` : ""}`),
      unit: (m[3] ?? "").replace(/\s+/g, "").replace("퍼센트", "%").toUpperCase(),
      start: m.index ?? 0,
      end: (m.index ?? 0) + m[0].length,
    }));
}

/** v2 키워드 판정. 글자 그대로 있으면(v1) 댄 것이다. 수가 든 키워드는 수마다 같은 값, 같은 단위가 답에 있으면 댄 것이다.
 * 질문(q)이 이미 말한 수(「마일스톤 2가 며칠 밀렸다고」의 2)는 요구하지 않는다 — 빼면 남는 수가 없을 때만 빼지 않는다
 * (「500만원으로 적혀 있었나?」는 500만원을 대야 한다). 수가 없는 키워드(「Critical」, 「서킷브레이커」)는 v1 과 같다. */
export function hasKeywordValue(text: string, key: string, q = ""): boolean {
  if (hasKeyword(text, key)) return true;
  if (/^\d{4}-\d{2}-\d{2}/.test(key.trim())) return false; // 날짜 키워드는 hasKeyword 가 이미 값으로 봤다
  const atoms = numberAtoms(key);
  if (!atoms.length) return false;
  const inQ = numberAtoms(q);
  const asked = atoms.filter((a) => !inQ.some((x) => x.value === a.value && x.unit === a.unit));
  const want = asked.length ? asked : atoms;
  const have = numberAtoms(text);
  return want.every((w) => have.some((h) => h.value === w.value && h.unit === w.unit));
}

/** 키워드의 수마다 바로 앞의 낱말 두 개(꼬리표). 「기본 분당 263회」의 263회 → 기본, 분당. */
function labelledAtoms(key: string): { atom: Atom; words: string[] }[] {
  const atoms = numberAtoms(key);
  return atoms.map((atom, i) => ({
    atom,
    words: key
      .slice(i ? atoms[i - 1].end : 0, atom.start)
      .split(/[^가-힣A-Za-z]+/)
      .filter((w) => w.length >= 2)
      .slice(-2),
  }));
}

const positions = (text: string, word: string): number[] => {
  const out: number[] = [];
  for (let i = text.indexOf(word); i >= 0; i = text.indexOf(word, i + 1)) out.push(i);
  return out;
};

/** 같은 단위의 값 둘이 꼬리표와 엇갈렸는가(기본 2130회, 프리미엄 263회). 요구하는 사실(keys)의 수마다 그 사실이 나온
 * 정답 키워드(sources)에서 꼬리표를 찾는다. 두 값의 꼬리표가 다른 낱말일 때만 본다. 답에 꼬리표와 값이 같은 차례로 놓인
 * 자리가 하나라도 있으면 엇갈리지 않았다(「기본과 프리미엄 각각 263회, 2130회」도 맞다). 엇갈린 짝을 돌려준다. */
export function crossedValues(answer: string, keys: string[], sources: string[]): string[] {
  const labelled = sources.flatMap(labelledAtoms);
  const wanted = keys.flatMap((k) => numberAtoms(k));
  const items = labelled.filter((l) => wanted.some((w) => w.value === l.atom.value && w.unit === l.atom.unit));
  const valueAt = (a: Atom) => numberAtoms(answer).filter((h) => h.value === a.value && h.unit === a.unit).map((h) => h.start);
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const [a, b] = [items[i], items[j]];
      if (a.atom.unit !== b.atom.unit || a.atom.value === b.atom.value) continue;
      const pa = a.words.filter((w) => !b.words.includes(w)).flatMap((w) => positions(answer, w));
      const pb = b.words.filter((w) => !a.words.includes(w)).flatMap((w) => positions(answer, w));
      const [va, vb] = [valueAt(a.atom), valueAt(b.atom)];
      if (!pa.length || !pb.length || !va.length || !vb.length) continue;
      const same = pa.some((p) => pb.some((q) => va.some((x) => vb.some((y) => p !== q && x !== y && p < q === x < y))));
      if (!same) return [`${a.words.join(" ")} ${a.atom.value}${a.atom.unit}`, `${b.words.join(" ")} ${b.atom.value}${b.atom.unit}`];
    }
  }
  return [];
}

// ── 판정 ────────────────────────────────────────────────────────────────

export interface Verdict {
  correct: boolean;
  /** 오답 이유 한 줄(정답이면 빈 문자열) */
  reason: string;
  required: string[];
  missing: string[];
  extra: string[];
  anchors?: string[];
}

const verdict = (correct: boolean, reason: string, v: Partial<Verdict> = {}): Verdict => ({
  correct,
  reason: correct ? "" : reason,
  required: v.required ?? [],
  missing: v.missing ?? [],
  extra: v.extra ?? [],
  ...(v.anchors ? { anchors: v.anchors } : {}),
});

/** 첫 문장이 「알 수 없다」면 기권이다. 답 중간의 「문제는 없습니다」는 기권이 아니다. */
export function abstainsFirst(answer: string): boolean {
  return /^[^.!?\n]*(알 수 없|찾을 수 없|찾지 못|확인할 수 없|확인되지 않)/.test(answer.trim());
}

/** 부재 개체 질문의 기권. 문장 어디든 「없다」를 말하면 된다 — 대신 사람을 대면 안 된다. */
const ABSTAIN_ANY = /알 수 없|찾을 수 없|찾지 못|확인되지 않|확인할 수 없|존재하지 않|없습니다|없어요|정보가 없/;

function common(answer: string, cat: Catalog, state: AnswerState): Verdict | null {
  if (state === "retrieval_failed" || state === "generation_failed") {
    return verdict(false, STATE_LABEL[state]);
  }
  const invented = inventedIds(answer, cat);
  if (invented.length) return verdict(false, `없는 개체 ${invented.join(", ")}`, { extra: invented });
  return null;
}

export interface SqlGold {
  rows: Record<string, unknown>[];
  ordered: boolean;
  /** 정답 SQL 에 LIMIT 이 있다 — 상위 N·최댓값 질의 */
  limited: boolean;
  /** LIMIT 경계에서 정렬 값이 같아 함께 대도 되는 개체 */
  tied: string[];
  /** 값으로 가르는 열(날짜, 시각, 달, 기간). 없는 열은 수 또는 글자다 */
  types?: Record<string, ValueKind>;
  /** v2 라벨: 질문이 묻는 결과 열. 없으면 askedColumns 의 기본 규칙 */
  asked?: string[];
}

const isNumeric = (v: unknown) => /^-?\d+(\.\d+)?$/.test(String(v));
const isIdCol = (c: string) => c === "id" || c.endsWith("_id");

export function askedColumns(rows: Record<string, unknown>[], limited: boolean): string[] {
  if (!rows.length) return [];
  const cols = Object.keys(rows[0]).filter((c) => !isIdCol(c));
  const textCols = cols.filter((c) => rows.some((r) => !isNumeric(r[c])));
  return limited && textCols.length ? textCols : cols;
}

/** 라벨이 고른 열이 정답 결과에 실제로 있는가. 없는 열 이름은 라벨의 오탈자다 — 조용히 빼면 그 문항이 느슨해진다. */
export function checkAskedColumns(asked: string[], rows: Record<string, unknown>[]): string[] {
  const have = new Set(rows.length ? Object.keys(rows[0]) : []);
  return asked.filter((c) => !have.has(c) || isIdCol(c));
}

/** v2 에서 답이 값을 대야 하는 열. 라벨이 있으면 라벨, 없으면 v1 기본 규칙. 그중 모든 행에서 같은 글자 값이고 질문에 이미
 * 있는 열(질문 조건의 되풀이)은 뺀다. 빼고 남는 열이 없으면 빼지 않는다. */
export function requiredColumns(q: string, gold: SqlGold, rules: ScoreRules): string[] {
  const base = askedColumns(gold.rows, gold.limited);
  if (rules === "v1") return base;
  const cols = gold.asked?.length ? gold.asked : base;
  const echo = cols.filter((c) => {
    if (gold.types?.[c]) return false;
    const v = gold.rows[0]?.[c];
    if (v === null || v === undefined || isNumeric(v)) return false;
    return gold.rows.every((r) => String(r[c]) === String(v)) && hasText(q, String(v));
  });
  return echo.length && echo.length < cols.length ? cols.filter((c) => !echo.includes(c)) : cols;
}

type CellKind = ValueKind | "number" | "text";
const MATCH: Record<CellKind, (text: string, value: string) => boolean> = {
  number: hasNumber,
  text: hasText,
  date: hasDate,
  timestamp: hasDate,
  month: hasMonth,
  duration: hasDuration,
};

export function scoreSql(
  answer: string,
  q: string,
  gold: SqlGold,
  cat: Catalog,
  state: AnswerState,
  rules: ScoreRules = "v1",
): Verdict {
  const early = common(answer, cat, state);
  if (early) return early;
  const cols = requiredColumns(q, gold, rules);
  const req = gold.rows.flatMap((r) =>
    cols.map((c) => ({ value: String(r[c]), kind: (gold.types?.[c] ?? (isNumeric(r[c]) ? "number" : "text")) as CellKind })),
  );
  const required = req.map((x) => x.value);
  if (!req.length) return verdict(false, "정답 행이 0개다", { required });
  if (abstainsFirst(answer)) return verdict(false, "기권", { required, missing: required });
  const missing = req.filter((x) => !MATCH[x.kind](answer, x.value)).map((x) => x.value);
  if (missing.length) return verdict(false, `누락 ${missing.length}/${required.length}`, { required, missing });

  // 순서와 정답 밖 개체는 이름 열로 본다. 날짜 같은 값 열은 개체가 아니다.
  const key = cols.find((c) => !gold.types?.[c] && !isNumeric(gold.rows[0][c]));
  if (gold.ordered && key && gold.rows.length > 1) {
    const pos = gold.rows.map((r) => firstIndex(answer, String(r[key])));
    if (!pos.every((p, i) => i === 0 || p > pos[i - 1])) return verdict(false, "순서가 다르다", { required });
  }
  if (gold.limited && key) {
    const kind = cat.kindOf.get(String(gold.rows[0][key]));
    if (kind) {
      const allowed = new Set([...gold.rows.map((r) => String(r[key])), ...gold.tied, ...mentionsOfKind(q, kind, cat)]);
      const extra = mentionsOfKind(answer, kind, cat).filter((m) => !allowed.has(m));
      if (extra.length) return verdict(false, `정답 밖 ${extra.join(", ")}`, { required, extra });
    }
  }
  return verdict(true, "", { required });
}

export function scoreKg(
  answer: string,
  q: string,
  gold: { names: string[]; kind?: string; absent: boolean },
  cat: Catalog,
  state: AnswerState,
): Verdict {
  const early = common(answer, cat, state);
  if (early) return early;
  if (gold.absent) {
    // 없는 고객사의 「담당 엔지니어」를 묻는다. 누구든 이름을 대면 지어낸 것이다.
    const named = mentionsOfKind(answer, "employee", cat);
    if (named.length) return verdict(false, `없는 대상에 ${named.join(", ")}`, { extra: named });
    return ABSTAIN_ANY.test(answer) ? verdict(true, "") : verdict(false, "기권하지 않았다");
  }
  const required = uniq(gold.names);
  if (abstainsFirst(answer)) return verdict(false, "기권", { required, missing: required });
  const missing = required.filter((n) => !hasText(answer, n));
  if (missing.length) return verdict(false, `누락 ${missing.length}/${required.length}`, { required, missing });
  if (gold.kind) {
    const inQ = new Set(mentionsOfKind(q, gold.kind, cat));
    const extra = mentionsOfKind(answer, gold.kind, cat).filter((m) => !required.includes(m) && !inQ.has(m));
    if (extra.length) return verdict(false, `정답 밖 ${extra.join(", ")}`, { required, extra });
  }
  return verdict(true, "", { required });
}

export interface VectorGold {
  keywords: string[];
  docs: { id: string; text: string }[];
  /** 정답 문서를 어디서 정했는지 — vector_gold.gold_docs / keywords / type, questions.hint */
  source: string;
}

// 질문에 없는 구체 사실. 한국어 일반어는 어느 문서에나 있어 근거가 못 된다.
const ANCHOR_RES = [
  /\b(?:Client|Product)-[A-Z0-9]+\b/g,
  /\bDOC-\d{3}\b/g,
  /\d{4}-\d{2}-\d{2}/g,
  /\d[\d,.]*\s?(?:%|ms|GB|MB|TB|초|분|시간|일|개월|주|년|건|회|코어|원|명)/g,
  /\b[A-Za-z][A-Za-z0-9+#._/-]{2,}/g,
];
const STOP = new Set(["client", "product", "doc", "the", "and", "for", "with"]);
const squash = (s: string) => s.toLowerCase().replace(/[\s,]+/g, "");

export function scoreVector(answer: string, q: string, gold: VectorGold, cat: Catalog, state: AnswerState): Verdict {
  const early = common(answer, cat, state);
  if (early) return early;
  const required = gold.keywords;
  if (!gold.docs.length) return verdict(false, "정답 문서가 0개다", { required });
  if (abstainsFirst(answer)) return verdict(false, "기권", { required, missing: required });
  const missing = required.filter((k) => !answer.toLowerCase().includes(k.toLowerCase()));
  if (missing.length) return verdict(false, `키워드 누락 ${missing.join(", ")}`, { required, missing });

  const qs = squash(q);
  const docText = gold.docs.map((d) => squash(d.text));
  const candidates = uniq(ANCHOR_RES.flatMap((re) => [...answer.matchAll(re)].map((m) => m[0].trim())))
    .filter((a) => !STOP.has(a.toLowerCase()) && !qs.includes(squash(a)));
  const anchors = candidates.filter((a) => docText.some((t) => t.includes(squash(a))));
  if (!anchors.length) return verdict(false, "정답 문서의 구체 사실이 없다", { required, anchors });

  const inQ = new Set([...q.matchAll(ID_TOKEN)].map((m) => m[0]));
  const outside = uniq([...answer.matchAll(ID_TOKEN)].map((m) => m[0]))
    .filter((id) => !inQ.has(id) && !gold.docs.some((d) => valueRe(id).test(d.text)));
  if (outside.length) return verdict(false, `정답 문서 밖 ${outside.join(", ")}`, { required, extra: outside, anchors });
  return verdict(true, "", { required, anchors });
}

export interface KeyedVectorGold {
  /** 답이 대야 할 정답 문서의 원문 문자열. 질문에 이미 있는 키워드는 뺐다 */
  keys: string[];
  docs: { id: string; text: string }[];
  source: string;
  /** v2: keys 가 나온 정답 키워드 전부. 수의 꼬리표(기본, 프리미엄)를 여기서 찾는다 */
  sources?: string[];
}

/** 답 키워드가 있는 벡터 문항(홀드아웃 4차). 키워드를 전부 댔으면 「정답 문서의 사실로 답했다」도 성립한다 —
 * 키워드가 그 문서의 원문이다. 그래서 앵커 규칙 대신 키워드가 앵커가 된다. 사업자 문항의 키워드는 주제어라
 * 이 규칙을 쓰지 않는다(scoreVector). v2 는 수가 든 키워드를 값으로 보고, 값과 꼬리표가 엇갈린 답을 틀린다. */
export function scoreVectorKeyed(
  answer: string,
  q: string,
  gold: KeyedVectorGold,
  cat: Catalog,
  state: AnswerState,
  rules: ScoreRules = "v1",
): Verdict {
  const early = common(answer, cat, state);
  if (early) return early;
  const required = gold.keys;
  if (!required.length || !gold.docs.length) return verdict(false, "답 키워드가 없다", { required });
  if (abstainsFirst(answer)) return verdict(false, "기권", { required, missing: required });
  const has = rules === "v2" ? (t: string, k: string) => hasKeywordValue(t, k, q) : hasKeyword;
  const missing = required.filter((k) => !has(answer, k));
  if (missing.length) return verdict(false, `키워드 누락 ${missing.join(", ")}`, { required, missing });
  if (rules === "v2") {
    const crossed = crossedValues(answer, required, gold.sources ?? required);
    if (crossed.length) return verdict(false, `값과 꼬리표가 엇갈린다 ${crossed.join(" / ")}`, { required, missing: crossed });
  }
  const inQ = new Set([...q.matchAll(ID_TOKEN)].map((m) => m[0]));
  const outside = uniq([...answer.matchAll(ID_TOKEN)].map((m) => m[0]))
    .filter((id) => !inQ.has(id) && !gold.docs.some((d) => valueRe(id).test(d.text)));
  if (outside.length) return verdict(false, `정답 문서 밖 ${outside.join(", ")}`, { required, extra: outside });
  return verdict(true, "", { required, anchors: required });
}

// ── 지연 요약 ───────────────────────────────────────────────────────────

/** 중앙값은 companyx:ask 와 같은 규칙(정렬 후 floor(n/2) 번째), p90 은 최근접 순위. */
export function latency(ms: number[]): { median_ms: number | null; p90_ms: number | null } {
  if (!ms.length) return { median_ms: null, p90_ms: null };
  const s = [...ms].sort((a, b) => a - b);
  return { median_ms: s[Math.floor(s.length / 2)], p90_ms: s[Math.ceil(0.9 * s.length) - 1] };
}

// ── 채점 세트 ───────────────────────────────────────────────────────────
//
// 사업자 30문항은 규칙을 만들며 본 문항이다. 봉인 홀드아웃은 규칙도 라우터도 못 본 문구로 같은 채점을
// 한다. 예산을 바꾼 실행은 파일 이름에 예산을 달아 기본 예산 정본을 덮지 않는다.

export type ScoreSet = "sponsor30" | "holdout3" | "holdout4" | "holdout5";
export type HoldoutSet = Exclude<ScoreSet, "sponsor30">;

export const HOLDOUT_FILES: Record<HoldoutSet, string> = {
  holdout3: "eval/companyx/holdout3_route.json",
  holdout4: "eval/companyx/holdout4_route.json",
  holdout5: "eval/companyx/holdout5_route.json",
};

/** CX_SET. 모르는 이름이면 던진다 — 오타가 조용히 30문항으로 돌면 홀드아웃을 쟀다고 믿게 된다. */
export function parseScoreSet(v: string | undefined): ScoreSet {
  const s = (v ?? "").trim() || "sponsor30";
  if (s === "sponsor30" || s === "holdout3" || s === "holdout4" || s === "holdout5") return s;
  throw new Error(`CX_SET=${v} 를 모른다 — sponsor30, holdout3, holdout4, holdout5 중 하나다`);
}

/** CX_BUDGET. 양의 정수만 받는다 — 숫자가 아니면 큐레이터가 항목을 전부 버려 컨텍스트가 비고 점수가 조용히 0 이 된다. */
export function parseBudget(v: string | undefined): number | undefined {
  if (v === undefined || v.trim() === "") return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`CX_BUDGET=${v} 는 양의 정수여야 한다`);
  return n;
}

/** 결과 파일. 기본 예산의 사업자 30문항만 정본 이름을 쓴다. */
export function scorecardOut(set: ScoreSet, budget?: number): string {
  const s = set === "sponsor30" ? "" : `-${set}`;
  const b = budget === undefined ? "" : `-b${budget}`;
  return `eval/results/companyx-scorecard${s}${b}.json`;
}

// ── 홀드아웃 정답 ───────────────────────────────────────────────────────

export interface HoldoutItem {
  id: string;
  q: string;
  expected: Lane;
  gold_sql?: string;
  gold_docs?: string[];
  gold_keywords?: string[];
  gold_edges?: { source: string; relation: string; target: string }[];
  gold_answer_names?: string[];
}

/** 정답, 또는 채점할 수 없는 이유. */
export type GoldOrWhy<T> = { gold: T } | { unscorable: string };

export interface KgGold {
  names: string[];
  kind?: string;
  absent: boolean;
}

const LIMIT_TAIL = /\bLIMIT\s+\d+\s*;?\s*$/i;
/** 정답 SQL 이 상위 N 질의인가. 봉인 파일의 SQL 은 세미콜론으로 끝나 끝자리 LIMIT 을 그대로는 못 본다. */
export const isLimited = (sql: string) => LIMIT_TAIL.test(sql);
export const withoutLimit = (sql: string) => sql.replace(LIMIT_TAIL, "");

export interface SqlField {
  name: string;
  dataTypeID: number;
}

// PostgreSQL 형 OID. node-postgres 결과의 fields 가 들고 온다.
const OID = { date: 1082, timestamp: 1114, timestamptz: 1184, interval: 1186 };
const pad2 = (n: number) => String(n).padStart(2, "0");
const validDate = (v: unknown): v is Date => v instanceof Date && !Number.isNaN(v.getTime());

function ymd(v: unknown): string | null {
  // node-postgres 는 date 를 그날 자정(로컬)의 Date 로 준다. UTC 로 읽으면 한국 시간에서 하루 밀린다.
  if (validDate(v)) return `${v.getFullYear()}-${pad2(v.getMonth() + 1)}-${pad2(v.getDate())}`;
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}

function ymdhms(v: unknown): string | null {
  if (validDate(v)) return `${ymd(v)} ${pad2(v.getHours())}:${pad2(v.getMinutes())}:${pad2(v.getSeconds())}`;
  const m = typeof v === "string" ? /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(v) : null;
  return m ? `${m[1]} ${m[2]}` : null;
}

function durationText(v: unknown): string | null {
  // interval 객체({ days, hours, minutes, seconds, milliseconds }). 달이나 해가 섞이면 초로 못 바꾼다 —
  // 한 달이 며칠인지 정해져 있지 않다.
  if (!v || typeof v !== "object" || v instanceof Date) return null;
  const o = v as Record<string, unknown>;
  const n = (k: string) => (typeof o[k] === "number" ? (o[k] as number) : 0);
  if (n("years") || n("months")) return null;
  const total = n("days") * 86_400 + n("hours") * 3_600 + n("minutes") * 60 + n("seconds") + n("milliseconds") / 1000;
  return total >= 0 ? formatDuration(total) : null;
}

/** node-postgres 결과를 정답으로 바꾼다. 행이 없거나 묻는 칸에 NULL 이나 모르는 형이 있으면 채점 불가다 —
 * 「없다」는 답과 기권을, 「미해결」과 NULL 을 규칙으로 가를 수 없다. v2 라벨(asked)이 있으면 묻는 칸은 라벨의 열이다. */
export function sqlGoldFromResult(
  rows: Record<string, unknown>[],
  fields: SqlField[],
  opts: { ordered: boolean; limited: boolean; tied: string[]; asked?: string[] },
): GoldOrWhy<SqlGold> {
  if (!rows.length) return { unscorable: "정답이 빈 결과다 — 「없다」는 답과 기권을 규칙으로 가를 수 없다" };
  const oid = new Map(fields.map((f) => [f.name, f.dataTypeID]));
  const out = rows.map(() => ({}) as Record<string, unknown>);
  const types: Record<string, ValueKind> = {};
  const bad = new Map<string, string>();
  for (const c of Object.keys(rows[0])) {
    const t = oid.get(c);
    let kind: ValueKind | undefined =
      t === OID.date ? "date" : t === OID.timestamp || t === OID.timestamptz ? "timestamp" : t === OID.interval ? "duration" : undefined;
    const conv = kind === "date" ? ymd : kind === "timestamp" ? ymdhms : kind === "duration" ? durationText : null;
    rows.forEach((r, i) => {
      const v = r[c];
      if (v === null || v === undefined) {
        bad.set(c, "NULL");
        out[i][c] = null;
      } else if (conv) {
        out[i][c] = conv(v);
        if (out[i][c] === null) bad.set(c, `${kind} 로 못 읽는 값`);
      } else if (typeof v === "string" || typeof v === "number" || typeof v === "bigint") {
        out[i][c] = v;
      } else {
        bad.set(c, `${typeof v} 값`);
        out[i][c] = null;
      }
    });
    // DATE_TRUNC('month') 결과 — 이름이 month 이고 전부 1일이면 달이다. 「2월」에 「2월 1일」을 요구하면
    // 옳은 답을 틀린다.
    if (kind === "date" && /(^|_)month$/i.test(c) && out.every((r) => typeof r[c] === "string" && (r[c] as string).endsWith("-01"))) {
      kind = "month";
      for (const r of out) r[c] = (r[c] as string).slice(0, 7);
    }
    if (kind) types[c] = kind;
  }
  const asked = opts.asked?.length ? opts.asked : undefined;
  if (asked) {
    const wrong = checkAskedColumns(asked, out);
    if (wrong.length) throw new Error(`라벨의 asked_columns ${wrong.join(", ")} 가 정답 결과 열(${Object.keys(rows[0]).join(", ")})에 없다`);
  }
  const broken = (asked ?? askedColumns(out, opts.limited)).filter((c) => bad.has(c));
  if (broken.length) {
    return { unscorable: `묻는 칸에 ${broken.map((c) => `${c}(${bad.get(c)})`).join(", ")} — 답의 표현을 규칙으로 가를 수 없다` };
  }
  return { gold: { rows: out, ordered: opts.ordered, limited: opts.limited, tied: opts.tied, types, ...(asked ? { asked } : {}) } };
}

/** 정답 행으로 만든 모범 답. 값 열은 정답 문자열과 다른 표기로 쓴다 — 판정이 표기가 아니라 값을 보는지까지
 * 자기 점검이 확인한다. 값 열이 없는 사업자 정답에서는 예전과 같은 문자열이다. */
export function idealSqlAnswer(g: SqlGold): string {
  const show = (v: unknown, kind?: ValueKind): string => {
    const s = String(v);
    if (kind === "date") {
      const [y, m, d] = s.split("-").map(Number);
      return `${y}년 ${m}월 ${d}일`;
    }
    if (kind === "month") {
      const [y, m] = s.split("-").map(Number);
      return `${y}년 ${m}월`;
    }
    return kind === "timestamp" ? s.slice(0, 16) : s;
  };
  // 라벨 열과 v1 기본 열을 다 싣는다 — 어느 규칙으로 채점해도 모범 답이 정답이어야 한다.
  const cols = uniq([...askedColumns(g.rows, g.limited), ...(g.asked ?? [])]);
  return g.rows.map((r) => cols.map((c) => show(r[c], g.types?.[c])).join(" ")).join(", ");
}

/** 그래프 문항의 정답 — gold_answer_names. 정답 개체가 두 종류면(프로젝트와 사람의 짝) 이름이 다 있어도
 * 짝이 바뀐 답을 가르지 못하므로 채점 불가다. v2 정정(errata)이 있으면 names 가 정답 이름을 대신한다. */
export function holdoutKgGold(it: HoldoutItem, cat: Catalog, corrected?: string[]): GoldOrWhy<KgGold> {
  const names = uniq(corrected ?? it.gold_answer_names ?? []);
  if (!names.length) return { unscorable: "정답 이름이 없다" };
  const unknown = names.filter((n) => !cat.kindOf.has(n));
  if (unknown.length) return { unscorable: `그래프에 없는 정답 이름 ${unknown.join(", ")}` };
  const kinds = uniq(names.map((n) => cat.kindOf.get(n) as string));
  if (kinds.length > 1) return { unscorable: `정답이 ${kinds.join(", ")} 짝이다 — 이름이 다 있어도 짝이 바뀐 답을 가르지 못한다` };
  return { gold: { names, kind: kinds[0], absent: false } };
}

/** 벡터 문항의 정답 — gold_keywords 와 gold_docs(4차는 확장자 없이, 3차는 .md 를 붙여 적었다).
 * v2 라벨(facts)이 있으면 답이 댈 것은 라벨의 사실이다. 사실은 정답 키워드의 부분 문자열이어야 한다 — 라벨은 정답을
 * 좁힐 뿐 새 정답을 만들지 않는다. 라벨러는 질문이 이미 말한 부분을 뺐고, 확인 질문(「500만원으로 적혀 있었나?」)은
 * 그 값을 남겼다. 그래서 라벨의 사실에는 「질문에 있으면 뺀다」를 다시 걸지 않는다. */
export function holdoutVectorGold(
  it: HoldoutItem,
  docs: Map<string, string>,
  opts: { rules?: ScoreRules; facts?: string[] } = {},
): GoldOrWhy<KeyedVectorGold> {
  const ids = (it.gold_docs ?? []).map((d) => d.replace(/\.md$/, ""));
  if (!ids.length) return { unscorable: "정답 문서가 없다" };
  const lost = ids.filter((id) => !docs.has(id));
  if (lost.length) return { unscorable: `데이터셋에 없는 정답 문서 ${lost.join(", ")}` };
  const keys = it.gold_keywords ?? [];
  if (!keys.length) return { unscorable: "답 키워드가 없다 — 정답 문서의 사실 하나로 가르면 같은 문서의 다른 사실도 정답이 된다" };
  if (ids.length > 1) return { unscorable: `정답 문서가 ${ids.length}개다 — 키워드는 몇 건, 어느 문서를 대야 하는지 말하지 않는다` };
  const text = docs.get(ids[0]) as string;
  const absentKeys = keys.filter((k) => !hasKeyword(text, k));
  if (absentKeys.length) return { unscorable: `정답 문서에 없는 키워드 ${absentKeys.join(", ")}` };
  const facts = opts.rules === "v2" && opts.facts?.length ? opts.facts : null;
  if (facts) {
    const foreign = facts.filter((f) => !keys.some((k) => k.includes(f)));
    if (foreign.length) throw new Error(`${it.id} 라벨의 required_facts ${foreign.join(", ")} 가 정답 키워드의 부분 문자열이 아니다`);
    return { gold: { keys: facts, docs: [{ id: ids[0], text }], source: "gold_labels.required_facts", sources: keys } };
  }
  const need = keys.filter((k) => !hasKeyword(it.q, k));
  if (!need.length) return { unscorable: "키워드가 전부 질문에 있다 — 답이 따로 대야 할 사실이 없다" };
  return { gold: { keys: need, docs: [{ id: ids[0], text }], source: "holdout.gold_keywords", sources: keys } };
}

// ── 문항 ────────────────────────────────────────────────────────────────

export interface ScoreItem {
  id?: string;
  q: string;
  lane: Lane;
  /** 채점할 수 없는 이유. 있으면 판정은 늘 오답이고 분모에서 뺀다 */
  unscorable?: string;
  /** 정답으로 만든 모범 답. 자기 점검에 쓴다 */
  ideal: string | null;
  /** 기권이 정답인 문항(데이터셋에 없는 대상) */
  abstainIsRight?: boolean;
  judge(answer: string, state: AnswerState): Verdict & { gold_source?: string };
}

const unscorableItem = (it: HoldoutItem, why: string): ScoreItem => ({
  id: it.id,
  q: it.q,
  lane: it.expected,
  unscorable: why,
  ideal: null,
  judge: () => verdict(false, `채점 불가: ${why}`),
});

export function holdoutSqlItem(it: HoldoutItem, g: GoldOrWhy<SqlGold>, cat: Catalog, rules: ScoreRules = "v1"): ScoreItem {
  if ("unscorable" in g) return unscorableItem(it, g.unscorable);
  return {
    id: it.id,
    q: it.q,
    lane: "nl2sql",
    ideal: idealSqlAnswer(g.gold),
    judge: (a, s) => scoreSql(a, it.q, g.gold, cat, s, rules),
  };
}

export function holdoutKgItem(it: HoldoutItem, cat: Catalog, rules: ScoreRules = "v1", labels?: ItemLabels): ScoreItem {
  const g = holdoutKgGold(it, cat, rules === "v2" ? labels?.gold_answer_names : undefined);
  if ("unscorable" in g) return unscorableItem(it, g.unscorable);
  return {
    id: it.id,
    q: it.q,
    lane: "knowledge_graph",
    ideal: g.gold.names.join(", "),
    judge: (a, s) => scoreKg(a, it.q, g.gold, cat, s),
  };
}

export function holdoutVectorItem(
  it: HoldoutItem,
  docs: Map<string, string>,
  cat: Catalog,
  rules: ScoreRules = "v1",
  labels?: ItemLabels,
): ScoreItem {
  const g = holdoutVectorGold(it, docs, { rules, facts: labels?.required_facts });
  if ("unscorable" in g) return unscorableItem(it, g.unscorable);
  return {
    id: it.id,
    q: it.q,
    lane: "vector_search",
    ideal: g.gold.keys.join(" / "),
    judge: (a, s) => ({ ...scoreVectorKeyed(a, it.q, g.gold, cat, s, rules), gold_source: g.gold.source }),
  };
}

/** 홀드아웃 한 문항. CLI 와 오프라인 단위 테스트가 이 함수 하나로 만든다 — 정답을 두 길로 만들면 한쪽만
 * 고친다. nl2sql 정답은 DB 가 있어야 하므로 호출부가 실행해서 넘긴다(없으면 채점 불가). 규칙 판과 라벨도 여기로
 * 넘긴다 — v1 이면 라벨과 정정을 쓰지 않는다. SQL 라벨은 호출부가 정답(sqlGoldFromResult 의 asked)에 넣는다. */
export function holdoutItem(
  it: HoldoutItem,
  ctx: { docs: Map<string, string>; cat: Catalog; sql?: GoldOrWhy<SqlGold>; rules?: ScoreRules; labels?: ItemLabels },
): ScoreItem {
  const rules = ctx.rules ?? "v1";
  switch (it.expected) {
    case "nl2sql":
      return holdoutSqlItem(it, ctx.sql ?? { unscorable: "정답 SQL 을 실행하지 않았다" }, ctx.cat, rules);
    case "knowledge_graph":
      return holdoutKgItem(it, ctx.cat, rules, ctx.labels);
    case "vector_search":
      return holdoutVectorItem(it, ctx.docs, ctx.cat, rules, ctx.labels);
    default:
      return unscorableItem(it, `모르는 레인 ${String(it.expected)}`);
  }
}

// ── 라벨 파일 ───────────────────────────────────────────────────────────

export const LABELS_FILE = "eval/companyx/gold_labels.json";

export interface GoldLabelsFile {
  /** 문항 id(CX-SQL-01, h3-01, h4-21) → 질문이 묻는 열, 사실 */
  items: Record<string, Pick<ItemLabels, "asked_columns" | "required_facts">>;
  /** 문항 id → 데이터셋으로 확인한 정답 정정 */
  errata: Record<string, { gold_answer_names: string[]; gold_edges?: { source: string; relation: string; target: string }[] }>;
}

/** 문항 하나의 v2 라벨. asked 면 묻는 열과 사실, errata 면 정답 정정을 싣는다. 정정은 라벨이 아니라 정답 고침이라
 * v2 면 늘 쓰고(CX_LABELS=0 이어도), 묻는 것 라벨은 끌 수 있다. 실을 것이 없으면 undefined. */
export function labelsFor(
  file: GoldLabelsFile | null,
  id: string | undefined,
  use: { asked: boolean; errata: boolean } = { asked: true, errata: true },
): ItemLabels | undefined {
  if (!file || !id) return undefined;
  const it = use.asked ? file.items?.[id] : undefined;
  const fix = use.errata ? file.errata?.[id] : undefined;
  if (!it && !fix) return undefined;
  return { ...(it ?? {}), ...(fix ? { gold_answer_names: fix.gold_answer_names } : {}) };
}

export const ABSTAIN = "주어진 정보로는 알 수 없습니다.";

/** 문항마다 모범 답은 정답, 기권은 오답(기권이 정답인 문항은 반대)으로 가르는지 본다. 채점 불가 문항은
 * 무엇을 대도 정답이 나오면 안 된다 — 분모에서 빠지는 대신 점수를 낼 수도 없다. */
export function selfCheckItems(items: ScoreItem[]): string[] {
  const fails: string[] = [];
  for (const it of items) {
    const tag = it.id ? `${it.id} ` : "";
    if (it.unscorable) {
      if (it.judge(it.q, "ok").correct || it.judge(ABSTAIN, "ok").correct) fails.push(`채점 불가 문항이 정답을 낸다: ${tag}${it.q}`);
      continue;
    }
    if (it.ideal === null) {
      fails.push(`모범 답을 만들 수 없다 — 정답이 비었다: ${tag}${it.q}`);
      continue;
    }
    const good = it.judge(it.ideal, "ok");
    if (!good.correct) fails.push(`모범 답이 오답으로 나온다(${good.reason}): ${tag}${it.q}`);
    if (it.judge(ABSTAIN, "ok").correct !== Boolean(it.abstainIsRight)) fails.push(`기권 판정이 거꾸로다: ${tag}${it.q}`);
  }
  return fails;
}

// ── 자기 점검 ───────────────────────────────────────────────────────────
//
// 채점기가 틀리면 표 전체가 틀린다. 모델을 부르기 전에 수·이름 판정이 알려진 사례를
// 알려진 대로 가르는지 먼저 본다. 실패하면 CPU 를 쓰기 전에 멈춘다.
export function selfCheckPrimitives(): string[] {
  const fails: string[] = [];
  const num: [string, string, boolean][] = [
    ["총 매출은 2억 3,859만 원입니다", "23859", true],
    ["23,859", "23859", true],
    ["월 평균 589.97입니다", "589.9653179190751445", true],
    ["약 590", "589.9653179190751445", true],
    ["600", "589.9653179190751445", false],
    ["약 2억", "23859", false],
    ["46개입니다", "46", true],
    ["Product-C46 한 건", "46", false],
    ["2025-04-22 장애", "4", false],
    ["박소연 9,520만원", "9520", true],
  ];
  for (const [t, g, want] of num) {
    if (hasNumber(t, g) !== want) fails.push(`hasNumber(${JSON.stringify(t)}, ${g}) 가 ${!want} 다`);
  }
  const txt: [string, string, boolean][] = [
    ["Client-AC 입니다", "Client-A", false],
    ["Client-A와 Client-B", "Client-A", true],
    ["**SSL 인증서  만료 알림**", "SSL 인증서 만료 알림", true],
  ];
  for (const [t, v, want] of txt) {
    if (hasText(t, v) !== want) fails.push(`hasText(${JSON.stringify(t)}, ${v}) 가 ${!want} 다`);
  }
  if (!abstainsFirst("주어진 정보로는 알 수 없습니다.")) fails.push("기권 문장을 기권으로 못 본다");
  if (abstainsFirst("네, 있었습니다. 다른 문제는 없습니다.")) fails.push("「문제는 없습니다」를 기권으로 본다");

  // 홀드아웃이 쓰는 값 판정. 표기는 가리지 않되 값은 정확히 같아야 한다.
  const cases: [string, (t: string, g: string) => boolean, string, string, boolean][] = [
    ["hasDate", hasDate, "강동현 2024년 7월 9일 입사", "2024-07-09", true],
    ["hasDate", hasDate, "2024.07.09", "2024-07-09", true],
    ["hasDate", hasDate, "hire_date=Tue Jul 09 2024 00:00:00 GMT+0900", "2024-07-09", true],
    ["hasDate", hasDate, "2024-07-19", "2024-07-09", false],
    ["hasDate", hasDate, "7월 9일", "2024-07-09", false],
    ["hasDate", hasDate, "2025-04-15 11:32 접수", "2025-04-15 11:32:44", true],
    ["hasDate", hasDate, "2025년 4월 15일 접수", "2025-04-15 11:32:44", true],
    ["hasDate", hasDate, "2025-04-15 12:32 접수", "2025-04-15 11:32:44", false],
    ["hasDate", hasDate, "2025년 4월 15일 오전 11시", "2025-04-15 11:32:44", true],
    ["hasDate", hasDate, "2025년 4월 15일 오후 11시", "2025-04-15 11:32:44", false],
    ["hasMonth", hasMonth, "2026년 2월이 제일 많다", "2026-02", true],
    ["hasMonth", hasMonth, "2026-03", "2026-02", false],
    ["hasDuration", hasDuration, "약 6일 22시간", "6일 21시간 50분 21초", true],
    ["hasDuration", hasDuration, "165시간 50분", "6일 21시간 50분 21초", true],
    ["hasDuration", hasDuration, "약 7일", "6일 21시간 50분 21초", false],
    ["hasDuration", hasDuration, "5월 10일 13시 24분", "10일", false],
    ["hasDuration", hasDuration, "3일 19시간 56분 31초", "3일 19시간 56분 31.172초", true],
    ["hasKeyword", hasKeyword, "**초기 대응**: 40분이었다", "초기 대응: 40분", true],
    ["hasKeyword", hasKeyword, "초기 대응 140분", "초기 대응: 40분", false],
    ["hasKeyword", hasKeyword, "초기 구축비: 4,098만원", "초기 구축비: 4098만원", true],
    ["hasKeyword", hasKeyword, "보관 기간은 71일입니다", "보관 기간은 71일이며", false],
    ["hasKeyword", hasKeyword, "the hpa scales out", "HPA", true],
    ["hasKeyword", hasKeyword, "HPAX", "HPA", false],
    ["hasKeyword", hasKeyword, "2025년 4월 22일 16:33 에 났다", "2025-04-22 16:33", true],
  ];
  for (const [name, f, t, g, want] of cases) {
    if (f(t, g) !== want) fails.push(`${name}(${JSON.stringify(t)}, ${g}) 가 ${!want} 다`);
  }
  if (formatDuration(597_021) !== "6일 21시간 50분 21초") fails.push(`formatDuration(597021) 가 ${formatDuration(597_021)} 다`);

  // v2 키워드: 수는 같은 값, 같은 단위여야 한다. 다른 값, 다른 단위, 날짜와 시각 속의 수, 이름 속의 수는 아니다.
  const kv: [string, string, boolean][] = [
    ["40분", "초기 대응: 40분", true],
    ["초기 대응 140분", "초기 대응: 40분", false],
    ["40초", "초기 대응: 40분", false],
    ["28%", "TCO: 기존 대비 40% 절감", false],
    ["4,098만 원", "초기 구축비: 4098만원", true],
    ["4,100만원", "초기 구축비: 4098만원", false],
    ["투입 인력은 8명이었고 추가 인력 1명", "현재 투입 인력 8명이며, 추가 인력 1명이 필요한 상황입니다", true],
    ["투입 인력은 8명", "현재 투입 인력 8명이며, 추가 인력 1명이 필요한 상황입니다", false],
    ["2025년 4월 10일 회의", "10일 지연", false],
    ["13시 24분 접수", "소요: 24분", false],
    ["Product-C2 관련", "2개", false],
    ["Critical 입니다", "Critical", true],
    ["critical 이 아니라 high", "HPA", false],
    ["2024년 8월 5일 발생", "2024-08-05", true],
  ];
  for (const [t, g, want] of kv) {
    if (hasKeywordValue(t, g) !== want) fails.push(`hasKeywordValue(${JSON.stringify(t)}, ${g}) 가 ${!want} 다`);
  }
  const keys = ["기본 분당 263회", "프리미엄 분당 2130회"];
  const crossed: [string, boolean][] = [
    ["기본 분당 263회, 프리미엄 분당 2130회", false],
    ["기본과 프리미엄 각각 263회, 2130회", false],
    ["프리미엄은 2130회, 기본은 263회", false],
    ["기본 2130회, 프리미엄 263회", true],
    ["기본과 프리미엄 각각 2130회, 263회", true],
  ];
  for (const [t, want] of crossed) {
    if ((crossedValues(t, ["263회", "2130회"], keys).length > 0) !== want) fails.push(`crossedValues(${JSON.stringify(t)}) 가 ${!want} 다`);
  }
  return fails;
}
