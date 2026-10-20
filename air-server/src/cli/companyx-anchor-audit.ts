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

// 앵커 오염 감사와 구어 변형 실측 — dev 문항(사업자 30, 홀드아웃 1·2·3차)만 쓴다.
//
// 1. 거의 베낀 앵커. 기존 앵커(semroute.ts)와 구어 변형(semparaphrase.ts)을 dev 문항 하나하나와 견준다. 문항은 라우터와
//    같이 maskEntities 로 가린다. bge-m3 코사인(라우터가 최근접을 고르는 바로 그 값)과 글자 바이그램 유사도(Dice, 그리고
//    앵커 바이그램이 문항에 든 비율)를 같이 본다. 뜻이 가까운 것은 앵커가 할 일이라 코사인만으로는 베낌이 아니다. 글자까지
//    겹쳐야 문항 문구에서 왔다고 본다.
// 2. 세 앵커 세트로 라우터를 돌린다: 기존, 기존에서 거의 베낀 것을 뺀 것, 거기에 구어 변형(거의 베낀 것 제외)을 더한 것.
//    규칙과 경계 상수는 그대로이고 앵커만 바뀐다. 사전 등록한 채택 규칙: 셋째가 둘째 이상이고 어느 세트도 1문항 넘게
//    떨어지지 않아야 후보다.
//
// AUDIT_ONLY=1 이면 1만 하고 끝난다. 문턱은 분포만 보고(라우터 정확도를 보기 전에) 정했다.
// 감사가 뺀 앵커는 표에서 지웠고 REMOVED_BY_AUDIT 에 남긴다. 「기존」은 표에 그것을 되돌린 세트라 지금 돌려도 같은 비교가
// 나온다. 문턱이 다시 고른 것이 REMOVED_BY_AUDIT 와 다르거나 정제, 증강이 지금 표(ROUTE_ANCHORS, INSTALLED_ANCHORS)와
// 다르면 실패로 끝난다.
// 사용: npm run companyx:anchors   (EMBEDDER=ollama 필요)
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { requireCompanyxProfile, loadGraph } from "../companyx.js";
import { route, installOntology, maskEntities, RULE_MIN_MARGIN, LANES, type Lane } from "../router.js";
import { routeQuery, semanticVerdict, installSemanticRouter, ROUTE_ANCHORS, INSTALLED_ANCHORS, SEMANTIC_MIN_MARGIN } from "../semroute.js";
import { PARAPHRASE_ANCHORS } from "../semparaphrase.js";
import { getEmbedder, type Embedder } from "../embedder.js";

type AnchorSet = Record<Lane, Record<string, string[]>>;

const LANE: Record<string, string> = {
  structured: "nl2sql",
  semantic: "vector_search",
  graph: "knowledge_graph",
  hybrid: "hybrid",
};

// companyx-route-boundary.ts 와 같은 개발용 세트. 홀드아웃 4차와 5차는 봉인이라 읽지 않는다.
const DEV_SETS: { name: string; path: string; label: "tool" | "expected" }[] = [
  { name: "sponsor30", path: "datasets/companyx-v1.0/questions.json", label: "tool" },
  { name: "holdout1", path: "eval/companyx/holdout_route.json", label: "expected" },
  { name: "holdout2", path: "eval/companyx/holdout2_route.json", label: "expected" },
  { name: "holdout3", path: "eval/companyx/holdout3_route.json", label: "expected" },
];

/** 거의 베낀 쌍의 문턱. AUDIT_ONLY 실행의 분포만 보고 정했다(세 세트 실측 전). */
const NEAR_COPY = {
  // 뜻: 앵커 458 × 문항 150 = 68,700쌍 코사인의 p99.9 가 0.824, 0.80 이상은 105쌍(0.15%)이다. 문항을 보지 않고 쓴
  // 구어 변형 283개의 「가장 가까운 dev 문항 코사인」 p90 이 0.798 이라, 이 위는 모르고 쓴 앵커가 열에 하나만 닿는 자리다.
  cos: Number(process.env.NEAR_COS ?? 0.8),
  // 글자: 앵커 바이그램의 절반 이상이 문항에 그대로 있다. 전체 쌍의 p99.9 가 0.50 이다(0.50 이상 107쌍, 0.16%).
  // 0.6 으로 올리면 semroute.ts 머리 주석이 적은 홀드아웃 2차 오답 낱말에서 온 앵커 둘(「{제품} 깔린 데가 어디야」 0.571,
  // 「고객 제일 많이 맡은 사람」 0.556)이 빠진다.
  containment: Number(process.env.NEAR_CONT ?? 0.5),
};

/** semroute.ts 머리 주석이 적은 홀드아웃 2차 오답 낱말. 이 낱말이 든 문항에 맞춰 쓴 앵커가 문턱에 걸리는지로 문턱을 검증한다. */
const DOCUMENTED_HOLDOUT2_WORDS = ["깔려 있는 데", "끼고 있는 사람", "몇 군데", "인원수", "세팅", "사고 기록"];

/** 감사가 거의 베낀 것으로 걸러 표에서 지운 앵커(1b1873e 의 실측). current 는 ROUTE_ANCHORS, paraphrase 는 semparaphrase.ts 에 있던 것이다. */
const REMOVED_BY_AUDIT: { source: "current" | "paraphrase"; lane: Lane; type: string; text: string }[] = [
  { source: "current", lane: "knowledge_graph", type: "BELONGS_TO", text: "{직원} 소속이 어디야" },
  { source: "current", lane: "knowledge_graph", type: "HEAD_IS", text: "{부서} 팀장 누구야" },
  { source: "current", lane: "knowledge_graph", type: "HEAD_IS", text: "{부서} 윗선이 누구야" },
  { source: "current", lane: "knowledge_graph", type: "LEADS", text: "{직원} 요즘 뭐 해" },
  { source: "current", lane: "knowledge_graph", type: "MANAGES_ACCOUNT", text: "{고객사} 창구가 누구" },
  { source: "current", lane: "knowledge_graph", type: "MANAGES_ACCOUNT", text: "고객 제일 많이 맡은 사람" },
  { source: "current", lane: "knowledge_graph", type: "REPORTED_ISSUE", text: "{제품} 말썽 많아?" },
  { source: "current", lane: "knowledge_graph", type: "USES", text: "{제품} 쓰는 고객사 어디어디야" },
  { source: "current", lane: "knowledge_graph", type: "USES", text: "{제품} 깔린 데가 어디야" },
  { source: "current", lane: "nl2sql", type: "client_count", text: "고객사 몇 군데야" },
  { source: "current", lane: "nl2sql", type: "client_lookup", text: "{고객사} 연락처 이름이랑 메일 줘" },
  { source: "current", lane: "nl2sql", type: "contract", text: "계약 금액 큰 순으로 보여줘" },
  { source: "current", lane: "nl2sql", type: "employee_stats", text: "퇴사자 빼고 인원수" },
  { source: "current", lane: "nl2sql", type: "employee_stats", text: "부서별 평균 연봉" },
  { source: "current", lane: "nl2sql", type: "period_sales", text: "2025년 3분기에 얼마 벌었어" },
  { source: "current", lane: "nl2sql", type: "product_sales", text: "{제품} 판매액 총 얼마" },
  { source: "current", lane: "nl2sql", type: "project_lookup", text: "{프로젝트} 예산 얼마야" },
  { source: "current", lane: "nl2sql", type: "project_lookup", text: "보류 중인 프로젝트 이름만" },
  { source: "current", lane: "nl2sql", type: "project_stats", text: "프로젝트 가장 많은 고객사" },
  { source: "current", lane: "nl2sql", type: "region_sales", text: "지역별로 매출 얼마씩 나왔어" },
  { source: "current", lane: "nl2sql", type: "ticket_lookup", text: "{고객사} 티켓 언제 접수되고 언제 해결됐어" },
  { source: "current", lane: "nl2sql", type: "ticket_stats", text: "우선순위별 티켓 건수" },
  { source: "current", lane: "nl2sql", type: "ticket_stats", text: "Critical 티켓 아직 안 닫힌 거" },
  { source: "current", lane: "nl2sql", type: "ticket_stats", text: "미해결 티켓 몇 건" },
  { source: "current", lane: "vector_search", type: "api_reference", text: "API 인증 어떻게 해" },
  { source: "current", lane: "vector_search", type: "incident_cause", text: "네트워크 문제로 생긴 사고 기록" },
  { source: "current", lane: "vector_search", type: "install_setup", text: "개발 환경 세팅하는 법" },
  { source: "current", lane: "vector_search", type: "operations", text: "모니터링 알람 기준 어떻게 잡았어" },
  { source: "current", lane: "vector_search", type: "policy", text: "개인정보 다룰 때 지켜야 할 원칙" },
  { source: "current", lane: "vector_search", type: "policy", text: "권한 요청 절차" },
  { source: "paraphrase", lane: "knowledge_graph", type: "BELONGS_TO", text: "{부서} 소속 직원들" },
  { source: "paraphrase", lane: "knowledge_graph", type: "BELONGS_TO", text: "{직원}이랑 같은 팀 사람" },
  { source: "paraphrase", lane: "knowledge_graph", type: "HAS_PROJECT", text: "{프로젝트} 고객사 어디야" },
  { source: "paraphrase", lane: "knowledge_graph", type: "LEADS", text: "{직원}이 이끄는 프로젝트 목록" },
  { source: "paraphrase", lane: "nl2sql", type: "employee_stats", text: "평균 연봉 얼마임" },
];

interface DevItem {
  id: string;
  set: string;
  q: string;
  masked: string;
  expected: string;
}

interface AnchorRef {
  source: "current" | "paraphrase";
  lane: Lane;
  type: string;
  text: string;
}

/** 같은 문자열을 두 번 임베딩하지 않는다(세 세트가 앵커와 문항을 나눠 쓴다). 벡터는 그대로다. */
class MemoEmbedder implements Embedder {
  readonly name: string;
  readonly dim: number;
  private cache = new Map<string, Promise<number[]>>();
  calls = 0;
  constructor(private readonly inner: Embedder) {
    this.name = inner.name;
    this.dim = inner.dim;
  }
  embed(text: string): Promise<number[]> {
    let p = this.cache.get(text);
    if (!p) {
      this.calls++;
      p = this.inner.embed(text);
      this.cache.set(text, p);
    }
    return p;
  }
}

function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) s += a[i] * b[i];
  return s;
}

// 자리표시는 한 글자로 접는다. 그대로 두면 「{제품}」 하나가 바이그램 넷을 만들어 이름 자리만 같아도 겹침이 커진다.
const PLACEHOLDER_CHAR: Record<string, string> = {
  "{고객사}": "",
  "{제품}": "",
  "{직원}": "",
  "{부서}": "",
  "{프로젝트}": "",
  "{날짜}": "",
};

function charNorm(s: string): string {
  let t = s;
  for (const [ph, ch] of Object.entries(PLACEHOLDER_CHAR)) t = t.split(ph).join(ch);
  return t.toLowerCase().replace(/[\s?!.,~'"“”‘’()]/g, "");
}

function bigrams(s: string): Map<string, number> {
  const a = Array.from(s);
  const m = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i++) {
    const g = a[i] + a[i + 1];
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

function size(m: Map<string, number>): number {
  let n = 0;
  for (const c of m.values()) n += c;
  return n;
}

function overlap(a: Map<string, number>, b: Map<string, number>): number {
  let n = 0;
  for (const [g, c] of a) n += Math.min(c, b.get(g) ?? 0);
  return n;
}

function flatten(set: AnchorSet, source: AnchorRef["source"]): AnchorRef[] {
  return LANES.flatMap((lane) => Object.entries(set[lane]).flatMap(([type, texts]) => texts.map((text) => ({ source, lane, type, text }))));
}

function count(set: AnchorSet): Record<string, number> {
  const out: Record<string, number> = {};
  let total = 0;
  for (const lane of LANES) {
    out[lane] = Object.values(set[lane]).reduce((s, xs) => s + xs.length, 0);
    total += out[lane];
  }
  return { ...out, total };
}

/** 세트에서 빼야 할 문장을 뺀다. 유형 순서와 문장 순서는 그대로 둔다. */
function without(set: AnchorSet, drop: Set<string>): AnchorSet {
  return Object.fromEntries(
    LANES.map((lane) => [lane, Object.fromEntries(Object.entries(set[lane]).map(([t, xs]) => [t, xs.filter((x) => !drop.has(x))]))]),
  ) as AnchorSet;
}

function merge(a: AnchorSet, b: AnchorSet): AnchorSet {
  return Object.fromEntries(
    LANES.map((lane) => [lane, Object.fromEntries(Object.keys(a[lane]).map((t) => [t, [...a[lane][t], ...(b[lane][t] ?? [])]]))]),
  ) as AnchorSet;
}

/** 감사가 지운 앵커를 제 유형 끝에 되돌린다(감사 전 세트). */
function restore(set: AnchorSet, source: AnchorRef["source"]): AnchorSet {
  const out = merge(set, Object.fromEntries(LANES.map((l) => [l, {}])) as unknown as AnchorSet);
  for (const r of REMOVED_BY_AUDIT) if (r.source === source) out[r.lane][r.type] = [...out[r.lane][r.type], r.text];
  return out;
}

function sameSet(a: AnchorSet, b: AnchorSet): boolean {
  const key = (s: AnchorSet) => JSON.stringify(LANES.map((l) => Object.keys(s[l]).sort().map((t) => [t, [...s[l][t]].sort()])));
  return key(a) === key(b);
}

function quantiles(xs: number[]): Record<string, number> {
  const s = [...xs].sort((x, y) => x - y);
  const q = (p: number) => Number(s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(4));
  return { n: s.length, p50: q(0.5), p90: q(0.9), p99: q(0.99), p999: q(0.999), max: Number(s[s.length - 1].toFixed(4)) };
}

function histogram(xs: number[], step: number, from: number): Record<string, number> {
  const h: Record<string, number> = {};
  for (const x of xs) {
    const lo = Math.max(from, Math.floor(x / step) * step);
    const k = lo <= from ? `<${(from + step).toFixed(2)}` : lo.toFixed(2);
    h[k] = (h[k] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(h).sort(([a], [b]) => a.localeCompare(b)));
}

interface Row {
  id: string;
  set: string;
  expected: string;
  rule: string;
  rule_margin: number;
  semantic: Lane;
  semantic_margin: number;
  nearest: string;
  deployed: string;
}

function combine(r: Row, tau: number, sigma: number): string {
  const confident = r.rule !== "hybrid" && r.rule_margin >= tau;
  if (confident) return r.rule;
  return r.semantic_margin >= sigma ? r.semantic : r.rule;
}

async function measure(name: string, set: AnchorSet, items: DevItem[], embedder: Embedder) {
  const sem = await installSemanticRouter(embedder, set);
  if (sem.error) throw new Error(`시맨틱 앵커 임베딩 실패(${name}): ${sem.error}`);
  const rows: Row[] = [];
  for (const it of items) {
    const d = route(it.q);
    const v = (await semanticVerdict(it.q, embedder))!;
    const deployed = await routeQuery(it.q, embedder);
    rows.push({
      id: it.id,
      set: it.set,
      expected: it.expected,
      rule: LANE[d.route],
      rule_margin: d.gate.margin,
      semantic: v.lane,
      semantic_margin: Number(v.margin.toFixed(4)),
      nearest: `${v.nearest.lane}/${v.nearest.type}: ${v.nearest.text}`,
      deployed: LANE[deployed.route],
    });
  }
  const acc = (rs: Row[], f: (r: Row) => string) => rs.filter((r) => f(r) === r.expected).length;
  const bySet = Object.fromEntries(
    DEV_SETS.map((s) => {
      const rs = rows.filter((r) => r.set === s.name);
      return [s.name, { n: rs.length, rule_only: acc(rs, (r) => r.rule), semantic_only: acc(rs, (r) => r.semantic), deployed: acc(rs, (r) => r.deployed) }];
    }),
  );
  const bucketOf = (r: Row) => (r.rule === "hybrid" ? "hybrid(판단 포기)" : `margin ${r.rule_margin}`);
  const buckets: Record<string, { n: number; rule: number; semantic: number; deployed: number }> = {};
  for (const r of rows) {
    const b = (buckets[bucketOf(r)] ??= { n: 0, rule: 0, semantic: 0, deployed: 0 });
    b.n++;
    if (r.rule === r.expected) b.rule++;
    if (r.semantic === r.expected) b.semantic++;
    if (r.deployed === r.expected) b.deployed++;
  }
  // 시맨틱이 실제로 결정하는 문항(규칙 격차가 문턱 아래)의 시맨틱 격차 분포. 격차가 SEMANTIC_MIN_MARGIN 근처면 앵커 한 줄에 뒤집힌다.
  const fallback = rows.filter((r) => r.rule === "hybrid" || r.rule_margin < RULE_MIN_MARGIN);
  const semMarginBuckets: Record<string, { n: number; semantic: number }> = {};
  for (const r of fallback) {
    const k = r.semantic_margin < SEMANTIC_MIN_MARGIN ? `<${SEMANTIC_MIN_MARGIN}` : r.semantic_margin < 0.05 ? "0.02-0.05" : r.semantic_margin < 0.1 ? "0.05-0.10" : ">=0.10";
    const b = (semMarginBuckets[k] ??= { n: 0, semantic: 0 });
    b.n++;
    if (r.semantic === r.expected) b.semantic++;
  }
  const simulated = acc(rows, (r) => combine(r, RULE_MIN_MARGIN, SEMANTIC_MIN_MARGIN));
  const out = {
    anchors: { installed: sem.anchors, ...count(set) },
    n: rows.length,
    rule_only: acc(rows, (r) => r.rule),
    semantic_only: acc(rows, (r) => r.semantic),
    deployed: acc(rows, (r) => r.deployed),
    simulated_matches_deployed: simulated === acc(rows, (r) => r.deployed) && rows.every((r) => combine(r, RULE_MIN_MARGIN, SEMANTIC_MIN_MARGIN) === r.deployed),
    by_set: bySet,
    buckets: Object.fromEntries(Object.entries(buckets).sort(([a], [b]) => a.localeCompare(b))),
    fallback_semantic_margin: semMarginBuckets,
    misses: rows.filter((r) => r.deployed !== r.expected),
    rows,
  };
  console.log(`[${name}] 앵커 ${sem.anchors}  규칙만 ${out.rule_only}  시맨틱만 ${out.semantic_only}  배포 ${out.deployed}/${out.n}  ${JSON.stringify(bySet)}`);
  return out;
}

async function main() {
  requireCompanyxProfile();
  if ((process.env.EMBEDDER ?? "hash") !== "ollama") {
    console.error("앵커 감사는 라우터의 bge-m3 코사인을 재는 것이라 EMBEDDER=ollama 가 필요하다.");
    process.exit(2);
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const root = resolve(here, "../../..");
  const { nodes, edges } = await loadGraph();
  installOntology(nodes, edges);
  const embedder = new MemoEmbedder(getEmbedder());

  const items: DevItem[] = [];
  const input_hashes: Record<string, string> = {};
  for (const set of DEV_SETS) {
    const text = await readFile(resolve(root, set.path), "utf8");
    input_hashes[set.path] = createHash("sha256").update(text.replace(/\r\n/g, "\n")).digest("hex").slice(0, 16);
    const raw = JSON.parse(text);
    const list: Record<string, string>[] = Array.isArray(raw) ? raw : raw.items;
    list.forEach((x, i) =>
      items.push({ id: x.id ?? `${set.name}#${i + 1}`, set: set.name, q: x.q, masked: maskEntities(x.q.trim()), expected: x[set.label] }),
    );
  }

  // ── 1. 거의 베낀 앵커 ──
  const baseCurrent = restore(ROUTE_ANCHORS, "current");
  const baseParaphrase = restore(PARAPHRASE_ANCHORS, "paraphrase");
  const anchors = [...flatten(baseCurrent, "current"), ...flatten(baseParaphrase, "paraphrase")];
  const qVec = await Promise.all(items.map((it) => embedder.embed(it.masked)));
  const qGram = items.map((it) => bigrams(charNorm(it.masked)));
  const pairs: { source: string; lane: Lane; type: string; anchor: string; id: string; q_masked: string; cos: number; dice: number; containment: number }[] = [];
  const allCos: number[] = [];
  const allCont: number[] = [];
  const maxCosByAnchor: Record<string, number[]> = { current: [], paraphrase: [] };
  for (const a of anchors) {
    const av = await embedder.embed(a.text);
    const ag = bigrams(charNorm(a.text));
    const an = size(ag);
    let best = -1;
    items.forEach((it, i) => {
      const cos = dot(av, qVec[i]);
      const ov = overlap(ag, qGram[i]);
      const dice = an + size(qGram[i]) ? (2 * ov) / (an + size(qGram[i])) : 0;
      const containment = an ? ov / an : 0;
      allCos.push(cos);
      allCont.push(containment);
      best = Math.max(best, cos);
      pairs.push({ source: a.source, lane: a.lane, type: a.type, anchor: a.text, id: it.id, q_masked: it.masked, cos, dice, containment });
    });
    maxCosByAnchor[a.source].push(best);
  }
  const r4 = (x: number) => Number(x.toFixed(4));
  const isNear = (p: (typeof pairs)[number]) => p.cos >= NEAR_COPY.cos && p.containment >= NEAR_COPY.containment;
  const near = pairs
    .filter(isNear)
    .sort((x, y) => y.cos - x.cos)
    .map((p) => ({ ...p, cos: r4(p.cos), dice: r4(p.dice), containment: r4(p.containment) }));
  // 문턱 바로 아래(한쪽만 넘는 쌍)도 남겨 경계가 어디서 갈리는지 보이게 한다.
  const borderline = pairs
    .filter((p) => !isNear(p) && (p.cos >= NEAR_COPY.cos - 0.05 || p.containment >= NEAR_COPY.containment - 0.1) && p.cos >= 0.65 && p.containment >= 0.3)
    .sort((x, y) => y.cos - x.cos)
    .map((p) => ({ ...p, cos: r4(p.cos), dice: r4(p.dice), containment: r4(p.containment) }));
  const top = (key: "cos" | "dice" | "containment") =>
    [...pairs].sort((x, y) => y[key] - x[key]).slice(0, 25).map((p) => ({ ...p, cos: r4(p.cos), dice: r4(p.dice), containment: r4(p.containment) }));
  // 문턱 검증: 기록된 오답 낱말이 든 홀드아웃 2차 문항마다, 글자가 가장 많이 겹치는 기존 앵커가 걸리는가.
  const validation = DOCUMENTED_HOLDOUT2_WORDS.map((word) => ({
    word,
    questions: items
      .filter((it) => it.set === "holdout2" && it.q.includes(word))
      .map((it) => {
        const best = pairs.filter((p) => p.id === it.id && p.source === "current").sort((x, y) => y.containment - x.containment || y.cos - x.cos)[0];
        return { id: it.id, anchor: best.anchor, cos: r4(best.cos), containment: r4(best.containment), flagged: isNear(best) };
      }),
  }));
  const audit = {
    pairs: pairs.length,
    distribution: {
      cos_all_pairs: { ...quantiles(allCos), histogram: histogram(allCos, 0.05, 0.5) },
      containment_all_pairs: { ...quantiles(allCont), histogram: histogram(allCont, 0.1, 0) },
      max_cos_per_current_anchor: { ...quantiles(maxCosByAnchor.current), histogram: histogram(maxCosByAnchor.current, 0.05, 0.5) },
      max_cos_per_paraphrase_anchor: { ...quantiles(maxCosByAnchor.paraphrase), histogram: histogram(maxCosByAnchor.paraphrase, 0.05, 0.5) },
      // 두 축의 결합: 코사인 구간마다 글자 포함률이 높은 쌍이 몇인지.
      joint: Object.fromEntries(
        [0.7, 0.75, 0.8, 0.85, 0.9].map((c) => [
          `cos>=${c}`,
          Object.fromEntries([0.4, 0.5, 0.6, 0.7].map((k) => [`cont>=${k}`, pairs.filter((p) => p.cos >= c && p.containment >= k).length])),
        ]),
      ),
    },
    top_by_cos: top("cos"),
    top_by_containment: top("containment"),
    top_by_dice: top("dice"),
    thresholds: NEAR_COPY,
    threshold_validation: validation,
    near_copies: near,
    borderline,
  };
  console.log(`pairs=${pairs.length}  near-copy(cos>=${NEAR_COPY.cos} & cont>=${NEAR_COPY.containment})=${near.length}  borderline=${borderline.length}`);
  for (const p of near) console.log(`  NEAR ${p.source.padEnd(10)} ${p.lane}/${p.type} 「${p.anchor}」 ~ ${p.id} 「${p.q_masked}」 cos ${p.cos} dice ${p.dice} cont ${p.containment}`);

  await mkdir(resolve(root, "eval/results"), { recursive: true });
  const outPath = resolve(root, process.env.OUT ?? "eval/results/companyx-anchor-paraphrase.json");
  if (process.env.AUDIT_ONLY === "1") {
    await writeFile(outPath.replace(/\.json$/, ".audit-only.json"), JSON.stringify({ input_hashes, embedder: embedder.name, audit }, null, 2) + "\n");
    console.log(JSON.stringify(audit.distribution, null, 1));
    return;
  }

  // ── 2. 세 세트 실측 ──
  const dropCurrent = new Set(near.filter((p) => p.source === "current").map((p) => p.anchor));
  const dropNew = new Set(near.filter((p) => p.source === "paraphrase").map((p) => p.anchor));
  const cleaned = without(baseCurrent, dropCurrent);
  const augmented = merge(cleaned, without(baseParaphrase, dropNew));
  const removedNow = new Set(REMOVED_BY_AUDIT.map((r) => r.text));
  const consistency = {
    removed_by_audit_matches_thresholds: removedNow.size === dropCurrent.size + dropNew.size && [...dropCurrent, ...dropNew].every((t) => removedNow.has(t)),
    cleaned_is_ROUTE_ANCHORS: sameSet(cleaned, ROUTE_ANCHORS),
    augmented_is_INSTALLED_ANCHORS: sameSet(augmented, INSTALLED_ANCHORS),
  };
  const current = await measure("current", baseCurrent, items, embedder);
  const cleanedM = await measure("cleaned", cleaned, items, embedder);
  const augmentedM = await measure("augmented", augmented, items, embedder);

  // 사전 등록한 규칙(2026-10-11, 실측 전): 증강이 정제 이상이고, 어느 세트도 정제보다 1문항 넘게 떨어지지 않는다.
  const drops = Object.fromEntries(
    DEV_SETS.map((s) => [s.name, augmentedM.by_set[s.name].deployed - cleanedM.by_set[s.name].deployed]),
  );
  const candidate = augmentedM.deployed >= cleanedM.deployed && Object.values(drops).every((d) => d >= -1);

  const out = {
    note:
      "개발용 문항(사업자 30, 홀드아웃 1·2·3차)에서 앵커만 바꿔 라우터를 잰 결과. 규칙과 경계 상수(RULE_MIN_MARGIN, SEMANTIC_MIN_MARGIN)는 " +
      "같다. current = 배포 앵커, cleaned = dev 문항을 거의 베낀 앵커를 뺀 것, augmented = cleaned + 구어 변형(거의 베낀 것 제외). " +
      "구어 변형은 dev 문항을 열기 전에 커밋했다(da43d4a). 이 문항들은 라우터를 고치며 본 것이라 일반화 수치가 아니다.",
    input_hashes,
    embedder: embedder.name,
    constants: { RULE_MIN_MARGIN, SEMANTIC_MIN_MARGIN },
    rule: "augmented 가 후보가 되려면 deployed 합계가 cleaned 이상이고 어느 세트도 cleaned 보다 1문항 넘게 떨어지지 않아야 한다(사전 등록).",
    decision: { candidate, augmented_minus_cleaned_by_set: drops, augmented_minus_cleaned_total: augmentedM.deployed - cleanedM.deployed },
    removed: { current: [...dropCurrent], paraphrase: [...dropNew] },
    consistency,
    audit,
    variants: { current, cleaned: cleanedM, augmented: augmentedM },
    embed_calls: embedder.calls,
    generated_at: new Date().toISOString(),
  };
  await writeFile(outPath, JSON.stringify(out, null, 2) + "\n");
  console.log(`decision: candidate=${candidate}  augmented-cleaned=${out.decision.augmented_minus_cleaned_total}  by set ${JSON.stringify(drops)}`);
  if (!Object.values(consistency).every(Boolean)) {
    console.error(`FAIL: 감사가 고른 세트가 지금 앵커 표와 다르다 ${JSON.stringify(consistency)}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
