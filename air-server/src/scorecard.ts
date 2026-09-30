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
}

const isNumeric = (v: unknown) => /^-?\d+(\.\d+)?$/.test(String(v));
const isIdCol = (c: string) => c === "id" || c.endsWith("_id");

export function askedColumns(rows: Record<string, unknown>[], limited: boolean): string[] {
  if (!rows.length) return [];
  const cols = Object.keys(rows[0]).filter((c) => !isIdCol(c));
  const textCols = cols.filter((c) => rows.some((r) => !isNumeric(r[c])));
  return limited && textCols.length ? textCols : cols;
}

export function scoreSql(answer: string, q: string, gold: SqlGold, cat: Catalog, state: AnswerState): Verdict {
  const early = common(answer, cat, state);
  if (early) return early;
  const cols = askedColumns(gold.rows, gold.limited);
  const req = gold.rows.flatMap((r) => cols.map((c) => ({ value: String(r[c]), numeric: isNumeric(r[c]) })));
  const required = req.map((x) => x.value);
  if (!req.length) return verdict(false, "정답 행이 0개다", { required });
  if (abstainsFirst(answer)) return verdict(false, "기권", { required, missing: required });
  const missing = req.filter((x) => !(x.numeric ? hasNumber(answer, x.value) : hasText(answer, x.value))).map((x) => x.value);
  if (missing.length) return verdict(false, `누락 ${missing.length}/${required.length}`, { required, missing });

  const key = cols.find((c) => !isNumeric(gold.rows[0][c]));
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

// ── 지연 요약 ───────────────────────────────────────────────────────────

/** 중앙값은 companyx:ask 와 같은 규칙(정렬 후 floor(n/2) 번째), p90 은 최근접 순위. */
export function latency(ms: number[]): { median_ms: number | null; p90_ms: number | null } {
  if (!ms.length) return { median_ms: null, p90_ms: null };
  const s = [...ms].sort((a, b) => a - b);
  return { median_ms: s[Math.floor(s.length / 2)], p90_ms: s[Math.ceil(0.9 * s.length) - 1] };
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
  return fails;
}
