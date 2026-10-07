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
// 봉인 홀드아웃(CX_SET=holdout3|holdout4)은 같은 규칙에 봉인 파일의 정답을 넣는다.
//   nl2sql   gold_sql 을 companyx 로 한정해 실행한 행. 날짜, 시각, 기간은 표기가 아니라 값으로
//            가른다(아래 「값의 모양」). 순서는 보지 않는다 — 봉인 파일에는 ordered 표시가 없다.
//   graph    gold_answer_names. 정답이 프로젝트와 사람의 짝이면 채점 불가다.
//   vector   gold_keywords 가 곧 답이다(정답 문서의 원문 문자열). 질문에 이미 있는 키워드를 뺀 나머지를
//            전부 대야 한다. 띄어쓰기, 문장부호, 대소문자만 가리지 않고 조사나 어미가 바뀐 말은 받지
//            않는다 — 풀어 쓴 옳은 답도 오답으로 세는 하한이다. 키워드가 없거나(3차) 정답 문서가 여럿이면
//            채점 불가다. 「정답 문서의 사실 하나」로 가르면 같은 문서의 다른 사실(검토자 대신 대응자)도
//            정답이 된다.
//   채점 불가 문항은 언제나 오답으로 판정하되 분모에서 뺀다. 이유는 결과 행의 unscorable 에 남는다.
import type { AskResult } from "./pipeline.js";
import type { GraphNode } from "./companyx.js";

export type Lane = "nl2sql" | "vector_search" | "knowledge_graph";

/** 사업자 레인 라벨 → 라우터 출력. */
export const LANE_ROUTE: Record<Lane, string> = {
  nl2sql: "structured",
  vector_search: "semantic",
  knowledge_graph: "graph",
};

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
}

const isNumeric = (v: unknown) => /^-?\d+(\.\d+)?$/.test(String(v));
const isIdCol = (c: string) => c === "id" || c.endsWith("_id");

export function askedColumns(rows: Record<string, unknown>[], limited: boolean): string[] {
  if (!rows.length) return [];
  const cols = Object.keys(rows[0]).filter((c) => !isIdCol(c));
  const textCols = cols.filter((c) => rows.some((r) => !isNumeric(r[c])));
  return limited && textCols.length ? textCols : cols;
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

export function scoreSql(answer: string, q: string, gold: SqlGold, cat: Catalog, state: AnswerState): Verdict {
  const early = common(answer, cat, state);
  if (early) return early;
  const cols = askedColumns(gold.rows, gold.limited);
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
}

/** 답 키워드가 있는 벡터 문항(홀드아웃 4차). 키워드를 전부 댔으면 「정답 문서의 사실로 답했다」도 성립한다 —
 * 키워드가 그 문서의 원문이다. 그래서 앵커 규칙 대신 키워드가 앵커가 된다. 사업자 문항의 키워드는 주제어라
 * 이 규칙을 쓰지 않는다(scoreVector). */
export function scoreVectorKeyed(answer: string, q: string, gold: KeyedVectorGold, cat: Catalog, state: AnswerState): Verdict {
  const early = common(answer, cat, state);
  if (early) return early;
  const required = gold.keys;
  if (!required.length || !gold.docs.length) return verdict(false, "답 키워드가 없다", { required });
  if (abstainsFirst(answer)) return verdict(false, "기권", { required, missing: required });
  const missing = required.filter((k) => !hasKeyword(answer, k));
  if (missing.length) return verdict(false, `키워드 누락 ${missing.join(", ")}`, { required, missing });
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

export type ScoreSet = "sponsor30" | "holdout3" | "holdout4";
export type HoldoutSet = Exclude<ScoreSet, "sponsor30">;

export const HOLDOUT_FILES: Record<HoldoutSet, string> = {
  holdout3: "eval/companyx/holdout3_route.json",
  holdout4: "eval/companyx/holdout4_route.json",
};

/** CX_SET. 모르는 이름이면 던진다 — 오타가 조용히 30문항으로 돌면 홀드아웃을 쟀다고 믿게 된다. */
export function parseScoreSet(v: string | undefined): ScoreSet {
  const s = (v ?? "").trim() || "sponsor30";
  if (s === "sponsor30" || s === "holdout3" || s === "holdout4") return s;
  throw new Error(`CX_SET=${v} 를 모른다 — sponsor30, holdout3, holdout4 중 하나다`);
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
 * 「없다」는 답과 기권을, 「미해결」과 NULL 을 규칙으로 가를 수 없다. */
export function sqlGoldFromResult(
  rows: Record<string, unknown>[],
  fields: SqlField[],
  opts: { ordered: boolean; limited: boolean; tied: string[] },
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
  const broken = askedColumns(out, opts.limited).filter((c) => bad.has(c));
  if (broken.length) {
    return { unscorable: `묻는 칸에 ${broken.map((c) => `${c}(${bad.get(c)})`).join(", ")} — 답의 표현을 규칙으로 가를 수 없다` };
  }
  return { gold: { rows: out, ordered: opts.ordered, limited: opts.limited, tied: opts.tied, types } };
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
  const cols = askedColumns(g.rows, g.limited);
  return g.rows.map((r) => cols.map((c) => show(r[c], g.types?.[c])).join(" ")).join(", ");
}

/** 그래프 문항의 정답 — gold_answer_names. 정답 개체가 두 종류면(프로젝트와 사람의 짝) 이름이 다 있어도
 * 짝이 바뀐 답을 가르지 못하므로 채점 불가다. */
export function holdoutKgGold(it: HoldoutItem, cat: Catalog): GoldOrWhy<KgGold> {
  const names = uniq(it.gold_answer_names ?? []);
  if (!names.length) return { unscorable: "정답 이름이 없다" };
  const unknown = names.filter((n) => !cat.kindOf.has(n));
  if (unknown.length) return { unscorable: `그래프에 없는 정답 이름 ${unknown.join(", ")}` };
  const kinds = uniq(names.map((n) => cat.kindOf.get(n) as string));
  if (kinds.length > 1) return { unscorable: `정답이 ${kinds.join(", ")} 짝이다 — 이름이 다 있어도 짝이 바뀐 답을 가르지 못한다` };
  return { gold: { names, kind: kinds[0], absent: false } };
}

/** 벡터 문항의 정답 — gold_keywords 와 gold_docs(4차는 확장자 없이, 3차는 .md 를 붙여 적었다). */
export function holdoutVectorGold(it: HoldoutItem, docs: Map<string, string>): GoldOrWhy<KeyedVectorGold> {
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
  const need = keys.filter((k) => !hasKeyword(it.q, k));
  if (!need.length) return { unscorable: "키워드가 전부 질문에 있다 — 답이 따로 대야 할 사실이 없다" };
  return { gold: { keys: need, docs: [{ id: ids[0], text }], source: "holdout.gold_keywords" } };
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

export function holdoutSqlItem(it: HoldoutItem, g: GoldOrWhy<SqlGold>, cat: Catalog): ScoreItem {
  if ("unscorable" in g) return unscorableItem(it, g.unscorable);
  return { id: it.id, q: it.q, lane: "nl2sql", ideal: idealSqlAnswer(g.gold), judge: (a, s) => scoreSql(a, it.q, g.gold, cat, s) };
}

export function holdoutKgItem(it: HoldoutItem, cat: Catalog): ScoreItem {
  const g = holdoutKgGold(it, cat);
  if ("unscorable" in g) return unscorableItem(it, g.unscorable);
  return {
    id: it.id,
    q: it.q,
    lane: "knowledge_graph",
    ideal: g.gold.names.join(", "),
    judge: (a, s) => scoreKg(a, it.q, g.gold, cat, s),
  };
}

export function holdoutVectorItem(it: HoldoutItem, docs: Map<string, string>, cat: Catalog): ScoreItem {
  const g = holdoutVectorGold(it, docs);
  if ("unscorable" in g) return unscorableItem(it, g.unscorable);
  return {
    id: it.id,
    q: it.q,
    lane: "vector_search",
    ideal: g.gold.keys.join(" / "),
    judge: (a, s) => ({ ...scoreVectorKeyed(a, it.q, g.gold, cat, s), gold_source: g.gold.source }),
  };
}

/** 홀드아웃 한 문항. CLI 와 오프라인 단위 테스트가 이 함수 하나로 만든다 — 정답을 두 길로 만들면 한쪽만
 * 고친다. nl2sql 정답은 DB 가 있어야 하므로 호출부가 실행해서 넘긴다(없으면 채점 불가). */
export function holdoutItem(
  it: HoldoutItem,
  ctx: { docs: Map<string, string>; cat: Catalog; sql?: GoldOrWhy<SqlGold> },
): ScoreItem {
  switch (it.expected) {
    case "nl2sql":
      return holdoutSqlItem(it, ctx.sql ?? { unscorable: "정답 SQL 을 실행하지 않았다" }, ctx.cat);
    case "knowledge_graph":
      return holdoutKgItem(it, ctx.cat);
    case "vector_search":
      return holdoutVectorItem(it, ctx.docs, ctx.cat);
    default:
      return unscorableItem(it, `모르는 레인 ${String(it.expected)}`);
  }
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
  return fails;
}
