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

// 스코어카드 채점기 오프라인 테스트 — 정답을 정답으로, 기권을 오답으로 가르는가.
//
// companyx:score 는 모델을 부르기 전에 같은 자기 점검을 돈다. 그런데 그 점검은 DB 와 데이터셋이
// 있어야 시작되고 CI 에는 둘 다 없다. 채점 규칙은 순수 함수라 여기서 매번 돈다. 봉인 홀드아웃의
// 그래프, 벡터 문항은 데이터셋 파일만 있으면 전량을 점검한다. SQL 문항은 정답이 DB 에서 나오므로
// 그 절반(실행한 정답으로 만든 모범 답)은 CLI 시작 때 돌고, 여기서는 node-postgres 가 돌려주는 모양의
// 합성 결과로 같은 함수를 점검한다.
//
// Run after build: node dist/scorecard.test.js
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CX_TABLES, qualifyCompanyx } from "./companyx.js";
import {
  ABSTAIN,
  HOLDOUT_FILES,
  LABELS_FILE,
  buildCatalog,
  holdoutItem,
  holdoutKgGold,
  holdoutSqlItem,
  holdoutVectorGold,
  isLimited,
  labelsFor,
  parseBudget,
  parseRules,
  parseScoreSet,
  requiredColumns,
  scoreKg,
  scoreSql,
  scoreVectorKeyed,
  scorecardOut,
  selfCheckItems,
  selfCheckPrimitives,
  sqlGoldFromResult,
  type AnswerState,
  type GoldLabelsFile,
  type HoldoutItem,
  type Lane,
  type ScoreItem,
  type ScoreRules,
  type SqlGold,
  type ValueKind,
} from "./scorecard.js";

// 데이터셋이 있어도 없는 것처럼 센다. verify-test-counts 가 데이터셋 없는 CI 의 단언 수를
// 로컬에서 세려고만 켠다(셸에 남아도 단언 수가 「데이터셋 없음」 정본과 같아질 뿐이다).
const TEST_AS_CI = process.env.TEST_AS_CI === "1";

let pass = 0, fail = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { pass++; } else { fail++; console.error("  FAIL:", msg); }
}
function eq<T>(a: T, b: T, msg: string) { ok(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)})`); }
const throws = (f: () => unknown) => { try { f(); return false; } catch { return true; } };

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");

// ── 원시 판정: CLI 가 모델 전에 도는 표와 같은 표 ─────────────────────
eq(selfCheckPrimitives(), [], "채점 원시 판정(수, 이름, 기권, 날짜, 기간, 키워드)");

// ── 세트, 예산, 결과 파일 ─────────────────────────────────────────────
// 예산 실행과 홀드아웃이 기본 예산 정본을 덮으면 대본 표가 다른 조건의 수치를 띄운다.
eq(parseScoreSet(undefined), "sponsor30", "CX_SET 이 없으면 사업자 30문항");
eq(parseScoreSet("holdout4"), "holdout4", "CX_SET=holdout4");
ok(throws(() => parseScoreSet("holdout5")), "모르는 세트는 던진다(조용히 30문항으로 돌지 않는다)");
eq(parseBudget(undefined), undefined, "CX_BUDGET 이 없으면 기본 예산");
eq(parseBudget("512"), 512, "CX_BUDGET=512");
ok(["abc", "0", "-256", "1.5"].every((v) => throws(() => parseBudget(v))), "양의 정수가 아닌 예산은 던진다(NaN 예산은 컨텍스트를 비운다)");
eq(scorecardOut("sponsor30"), "eval/results/companyx-scorecard.json", "기본 예산 30문항은 정본 이름 그대로");
eq(scorecardOut("sponsor30", 256), "eval/results/companyx-scorecard-b256.json", "예산 실행은 정본을 덮지 않는다");
eq(scorecardOut("holdout3"), "eval/results/companyx-scorecard-holdout3.json", "홀드아웃 3차");
eq(scorecardOut("holdout4", 1024), "eval/results/companyx-scorecard-holdout4-b1024.json", "홀드아웃 4차 + 예산");

// ── 봉인 파일의 모양 ──────────────────────────────────────────────────
// 저장소에 있는 파일이라 데이터셋 없이 본다. 저장된 답을 다시 채점할 때 질문으로 찾으므로 질문도 유일해야 한다.
const LANES: Lane[] = ["nl2sql", "vector_search", "knowledge_graph"];
const sets = Object.entries(HOLDOUT_FILES).map(([set, file]) => ({
  set,
  items: (JSON.parse(readFileSync(resolve(root, file), "utf8")) as { items: HoldoutItem[] }).items,
}));
for (const { set, items } of sets) {
  eq(LANES.map((l) => items.filter((i) => i.expected === l).length), [20, 20, 20], `${set} 레인별 20문항`);
  ok(new Set(items.map((i) => i.id)).size === items.length && new Set(items.map((i) => i.q)).size === items.length, `${set} id 와 질문이 유일`);
  const gaps = items.filter((i) =>
    i.expected === "nl2sql" ? !i.gold_sql
      : i.expected === "vector_search" ? !i.gold_docs?.length
        : !i.gold_answer_names?.length || !i.gold_edges?.length,
  ).map((i) => i.id);
  eq(gaps, [], `${set} 레인마다 정답 필드가 있다`);
}

// ── 정답 SQL 의 스키마 한정 ───────────────────────────────────────────
// 한정이 하나라도 빠지면 CLI 가 DB 앞에서야 멈춘다. FROM/JOIN 대상이 companyx 테이블, CTE, 괄호
// 하위 질의 중 하나인지 여기서 본다.
{
  const unresolved: string[] = [];
  const limited: string[] = [];
  for (const { items } of sets) {
    for (const it of items.filter((i) => i.expected === "nl2sql" && i.gold_sql)) {
      const sql = qualifyCompanyx(it.gold_sql as string);
      const ctes = new Set([...sql.matchAll(/(?:\bwith|,)\s+(\w+)\s+as\s*\(/gi)].map((m) => m[1].toLowerCase()));
      for (const m of sql.matchAll(/\b(?:from|join)\s+([A-Za-z_][\w.]*)/gi)) {
        const t = m[1].toLowerCase();
        const known = (t.startsWith("companyx.") && CX_TABLES.includes(t.slice(9))) || ctes.has(t);
        if (!known) unresolved.push(`${it.id}:${m[1]}`);
      }
      if (isLimited(sql)) limited.push(it.id);
    }
  }
  eq(unresolved, [], "홀드아웃 정답 SQL 의 FROM/JOIN 이 전부 companyx 로 한정된다");
  // 봉인 SQL 은 세미콜론으로 끝난다. 끝자리 LIMIT 을 못 보면 상위 N 질의의 「정답 밖 개체」 검사가 꺼진다.
  eq(limited, ["h3-10", "h3-16"], "세미콜론으로 끝나는 LIMIT 질의를 상위 N 으로 본다");
}

// ── SQL 정답: node-postgres 가 돌려주는 모양의 합성 결과 ─────────────
// date, timestamp 는 Date(로컬 자정), interval 은 객체, int8 은 문자열로 온다. CLI 는 실제 DB 결과를
// 같은 함수에 넣는다.
{
  const cat = buildCatalog([
    { name: "Client-A", type: "client" },
    { name: "Client-B", type: "client" },
    { name: "Client-C", type: "client" },
  ]);
  const base = { id: "t-01", q: "합성 SQL 문항", expected: "nl2sql" as Lane };
  const F = (name: string, dataTypeID: number) => ({ name, dataTypeID });
  const opts = { ordered: false, limited: false, tied: [] as string[] };

  const g = sqlGoldFromResult(
    [{ id: 7, name: "Client-A", registered_at: new Date(2023, 0, 17), created_at: new Date(2025, 3, 15, 11, 32, 44), took: { days: 6, hours: 21, minutes: 50, seconds: 21 }, n: "589" }],
    [F("id", 23), F("name", 1043), F("registered_at", 1082), F("created_at", 1114), F("took", 1186), F("n", 20)],
    opts,
  );
  ok("gold" in g, "날짜, 시각, 기간, int8 이 섞인 결과는 채점할 수 있다");
  if ("gold" in g) {
    eq(g.gold.rows[0], { id: 7, name: "Client-A", registered_at: "2023-01-17", created_at: "2025-04-15 11:32:44", took: "6일 21시간 50분 21초", n: "589" },
      "값을 사람이 적는 모양으로 바꾼다(Date.toString 이나 [object Object] 가 정답이 되지 않는다)");
    const item = holdoutSqlItem(base, g, cat);
    eq(selfCheckItems([item]), [], "합성 SQL 문항의 모범 답은 정답, 기권은 오답");
    ok(item.judge("Client-A 2023년 1월 17일 가입, 2025-04-15 11:32 접수, 6일 22시간, 589건", "ok").correct, "표기가 달라도 값이 같으면 정답");
    ok(!item.judge("Client-A 2023년 1월 18일 가입, 2025-04-15 11:32 접수, 6일 22시간, 589건", "ok").correct, "하루 다른 날짜는 오답");
    ok(!item.judge("Client-A 2023년 1월 17일 가입, 2025-04-15 11:32 접수, 약 7일, 589건", "ok").correct, "0.5% 를 넘게 뭉갠 기간은 오답");
  }

  const month = sqlGoldFromResult([{ month: new Date(2026, 1, 1), sales_amount: "2969" }], [F("month", 1082), F("sales_amount", 20)], opts);
  ok("gold" in month && month.gold.types?.month === "month" && month.gold.rows[0].month === "2026-02", "DATE_TRUNC 달 열은 달로 가른다");
  if ("gold" in month) {
    const item = holdoutSqlItem(base, month, cat);
    ok(item.judge("2026년 2월, 2,969만원", "ok").correct && !item.judge("2026년 3월, 2,969만원", "ok").correct, "달이 같아야 정답");
  }

  const nul = sqlGoldFromResult([{ created_at: new Date(2024, 11, 14), resolved_at: null }], [F("created_at", 1114), F("resolved_at", 1114)], opts);
  ok("unscorable" in nul && /NULL/.test(nul.unscorable), "묻는 칸에 NULL 이 있으면 채점 불가");
  const empty = sqlGoldFromResult([], [F("name", 1043)], opts);
  ok("unscorable" in empty, "빈 결과는 채점 불가(「없다」와 기권을 못 가른다)");
  const bool = sqlGoldFromResult([{ name: "Client-A", is_active: true }], [F("name", 1043), F("is_active", 16)], opts);
  ok("unscorable" in bool, "참거짓 칸은 채점 불가");

  // 상위 N: 순위의 주인을 묻는다. 정렬 근거 수치는 요구하지 않고, 같은 종류의 개체를 더 대면 오답이다.
  const top = sqlGoldFromResult([{ name: "Client-A", n: "5" }], [F("name", 1043), F("n", 20)], { ...opts, limited: true });
  if ("gold" in top) {
    const item = holdoutSqlItem(base, top, cat);
    ok(item.judge("Client-A 입니다", "ok").correct && !item.judge("Client-A, Client-B 입니다", "ok").correct, "상위 N 질의에서 정답 밖 개체를 대면 오답");
  } else ok(false, "상위 N 합성 결과를 채점할 수 있어야 한다");

  eq(holdoutItem(base, { docs: new Map(), cat }).unscorable, "정답 SQL 을 실행하지 않았다", "SQL 정답 없이 만든 SQL 문항은 채점 불가");
}

// ── 벡터, 그래프 정답의 채점 불가 규칙(합성) ──────────────────────────
{
  const docs = new Map([
    ["DOC-901", "## 로그 관리\n- ELK 스택으로 수집하며 보관 기간은 71일이며 이후 삭제한다.\n## 백업\n- 보관 기간은 26일"],
    ["DOC-902", "## 로그 관리\n- 보관 기간은 30일"],
  ]);
  const v = (over: Partial<HoldoutItem>): HoldoutItem => ({ id: "t-v", q: "로그 며칠 보관해? ELK 쪽", expected: "vector_search", ...over });
  const key = holdoutVectorGold(v({ gold_docs: ["DOC-901"], gold_keywords: ["보관 기간은 71일이며", "ELK 스택"] }), docs);
  ok("gold" in key, "키워드와 단일 정답 문서가 있으면 채점한다");
  ok("unscorable" in holdoutVectorGold(v({ gold_docs: ["DOC-901.md"] }), docs), "키워드가 없으면 채점 불가(3차 봉인 파일의 모양)");
  ok("unscorable" in holdoutVectorGold(v({ gold_docs: ["DOC-901", "DOC-902"], gold_keywords: ["보관 기간"] }), docs), "정답 문서가 여럿이면 채점 불가");
  ok("unscorable" in holdoutVectorGold(v({ gold_docs: ["DOC-901"], gold_keywords: ["보관 기간은 90일이며"] }), docs), "정답 문서에 없는 키워드는 채점 불가");
  ok("unscorable" in holdoutVectorGold(v({ q: "ELK 스택 로그 보관", gold_docs: ["DOC-901"], gold_keywords: ["ELK 스택"] }), docs), "키워드가 전부 질문에 있으면 채점 불가");
  if ("gold" in key) eq(key.gold.keys, ["보관 기간은 71일이며", "ELK 스택"], "질문에 없는 키워드만 답이 대야 한다");

  const cat = buildCatalog([{ name: "Client-A", type: "client" }, { name: "김지훈", type: "employee" }, { name: "Client-A 보안 감사", type: "project" }]);
  const vi = holdoutItem(v({ gold_docs: ["DOC-901"], gold_keywords: ["보관 기간은 71일이며", "ELK 스택"] }), { docs, cat });
  eq(selfCheckItems([vi]), [], "합성 벡터 문항의 모범 답은 정답, 기권은 오답");
  ok(!vi.judge("ELK 스택 로그의 보관 기간은 26일입니다", "ok").correct, "같은 문서의 다른 사실(백업 26일)은 오답");

  const k = (names: string[]): HoldoutItem => ({ id: "t-k", q: "합성 그래프 문항", expected: "knowledge_graph", gold_answer_names: names });
  ok("gold" in holdoutKgGold(k(["김지훈"]), cat), "한 종류의 정답 이름은 채점한다");
  ok("unscorable" in holdoutKgGold(k(["Client-A 보안 감사", "김지훈"]), cat), "프로젝트와 사람의 짝은 채점 불가");
  ok("unscorable" in holdoutKgGold(k(["없는사람"]), cat), "그래프에 없는 정답 이름은 채점 불가");
}

// ── 자기 점검이 스스로 깨진 채점기를 잡는가 ──────────────────────────
{
  const broken: ScoreItem = { q: "늘 오답인 채점기", lane: "knowledge_graph", ideal: "김지훈", judge: () => ({ correct: false, reason: "고장", required: [], missing: [], extra: [] }) };
  const lenient: ScoreItem = { q: "채점 불가인데 정답을 내는 채점기", lane: "vector_search", unscorable: "합성", ideal: null, judge: () => ({ correct: true, reason: "", required: [], missing: [], extra: [] }) };
  const yes: ScoreItem = { q: "기권도 정답으로 받는 채점기", lane: "nl2sql", ideal: "x", judge: () => ({ correct: true, reason: "", required: [], missing: [], extra: [] }) };
  eq(selfCheckItems([broken, lenient, yes]).length, 3, "모범 답 오답, 채점 불가 문항의 정답, 기권 정답을 전부 잡는다");
  ok(yes.judge(ABSTAIN, "ok").correct, "(대조) 기권 문장은 ABSTAIN 이다");
}

// ── 봉인 홀드아웃 전 문항(그래프, 벡터) — 데이터셋이 있을 때만 ─────────
//
// 데이터셋을 저장소 안의 datasets/companyx-v1.0 에서만 찾는다(DATASET_DIR 을 보지 않는다).
// verify-test-counts 가 같은 자리를 보고 「데이터셋 있음/없음」 정본 수를 고른다 — 여기서만
// DATASET_DIR 을 따르면 셸에 그 값이 남은 날 단언 수가 두 정본 어느 쪽과도 안 맞는다.
{
  const dir = resolve(root, "datasets/companyx-v1.0");
  if (!TEST_AS_CI && existsSync(resolve(dir, "graph/nodes.json")) && existsSync(resolve(dir, "graph/edges.json")) && existsSync(resolve(dir, "documents/index.json"))) {
    const nodes = JSON.parse(readFileSync(resolve(dir, "graph/nodes.json"), "utf8")) as { id: string; name: string; type: string }[];
    const edges = JSON.parse(readFileSync(resolve(dir, "graph/edges.json"), "utf8")) as { source: string; relation: string; target: string }[];
    const index = JSON.parse(readFileSync(resolve(dir, "documents/index.json"), "utf8")) as { id: string; filename: string }[];
    const docs = new Map(index.map((e) => [e.id, readFileSync(resolve(dir, "documents", e.filename), "utf8")]));
    const cat = buildCatalog(nodes);
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const edgeSet = new Set(edges.map((e) => `${e.source}|${e.relation}|${e.target}`));

    const scorable: Record<string, Record<string, number>> = {};
    const unscorable: string[] = [];
    for (const { set, items } of sets) {
      scorable[set] = {};
      for (const lane of ["vector_search", "knowledge_graph"] as Lane[]) {
        const built = items.filter((i) => i.expected === lane).map((i) => holdoutItem(i, { docs, cat }));
        // 봉인 파일의 모든 문항: 채점 가능하면 모범 답은 정답, 기권은 오답. 채점 불가면 무엇을 대도 오답.
        eq(selfCheckItems(built), [], `${set} ${lane} 전 문항 자기 점검`);
        scorable[set][lane] = built.filter((b) => !b.unscorable).length;
        unscorable.push(...built.filter((b) => b.unscorable).map((b) => b.id as string));
      }
      // 정답 이름은 정답 엣지의 끝점이고, 정답 엣지는 그래프에 실제로 있다(작성자의 오탈자를 잡는다).
      const kgBad = items
        .filter((i) => i.expected === "knowledge_graph")
        .filter((i) => {
          const ends = new Set((i.gold_edges ?? []).flatMap((e) => [byId.get(e.source)?.name, byId.get(e.target)?.name]));
          return (i.gold_edges ?? []).some((e) => !edgeSet.has(`${e.source}|${e.relation}|${e.target}`)) ||
            (i.gold_answer_names ?? []).some((n) => !ends.has(n));
        })
        .map((i) => i.id);
      eq(kgBad, [], `${set} 그래프 정답 이름이 그래프의 정답 엣지 위에 있다`);
    }
    // 채점 가능 수를 못 박는다. 규칙이나 봉인 파일이 바뀌면 여기서 먼저 깨지고, 보고서의 분모도 같이 고친다.
    eq(scorable, { holdout3: { vector_search: 0, knowledge_graph: 19 }, holdout4: { vector_search: 19, knowledge_graph: 20 } },
      "채점 가능 문항 수(3차 벡터는 키워드가 없어 0, 짝 문항 h3-60, 다중 문서 h4-26 제외)");
    eq(unscorable.filter((id) => !/^h3-(2\d|3\d|40)$/.test(id)), ["h3-60", "h4-26"], "3차 벡터 밖의 채점 불가 문항");
  } else {
    // 데이터셋은 배포 조건상 저장소에 없다. 없으면 건너뛰되 침묵하지 않는다.
    console.log("  SKIP: 봉인 홀드아웃 그래프, 벡터 전 문항 자기 점검 (데이터셋 없음 — datasets/companyx-v1.0)");
  }
}

// ── 채점 규칙 v2 ────────────────────────────────────────────────────────
//
// 2026-10-11 진단이 「답이 맞았는데 채점기가 못 본」 21건에서 찾은 결함을 v2 가 고쳤다. 고친 규칙마다 두 쪽을 본다.
// 진단이 옳다고 본 실제 답은 v1 이 틀리고 v2 가 맞힌다. 진단이 실제로 틀렸다고 본 같은 갈래의 실제 답은 v1, v2 모두
// 틀린다. 기대값은 우리 채점기가 아니라 진단의 분석가 판정이다(eval/companyx/scorer_cases.json, 답은 기록 파일 그대로).
eq(parseRules(undefined), "v2", "CX_RULES 가 없으면 v2");
eq(parseRules("v1"), "v1", "CX_RULES=v1 은 공개 수치를 낸 규칙");
ok(throws(() => parseRules("v3")), "모르는 규칙 판은 던진다(조용히 다른 규칙으로 돌지 않는다)");

type Labelled = GoldLabelsFile & {
  labellers: Record<"A" | "B", { output: { sql: Record<string, { asked_columns: string[] }>; vector: Record<string, { required_facts: string[] }> } }>;
};
const labels = JSON.parse(readFileSync(resolve(root, LABELS_FILE), "utf8")) as Labelled;
const byset = Object.fromEntries(sets.map(({ set, items }) => [set, items])) as Record<string, HoldoutItem[]>;
const sponsorSql = readFileSync(resolve(root, "eval/companyx/sql_gold.jsonl"), "utf8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l) as { id: string; gold: string });

// ── 라벨 파일: 질문이 묻는 것만 고르고, 정답을 넓히지 않는다 ─────────────
{
  const sqlItems = [
    ...sponsorSql.map((g) => ({ id: g.id, sql: g.gold })),
    ...["holdout3", "holdout4"].flatMap((s) => byset[s].filter((i) => i.expected === "nl2sql").map((i) => ({ id: i.id, sql: i.gold_sql as string }))),
  ];
  const vecItems = byset.holdout4.filter((i) => i.expected === "vector_search" && i.gold_keywords?.length);
  eq(sqlItems.length, 50, "라벨 대상 SQL 은 사업자 10, 홀드아웃3 20, 홀드아웃4 20");
  eq(sqlItems.filter((i) => !labels.items[i.id]?.asked_columns?.length).map((i) => i.id), [], "SQL 문항마다 묻는 열 라벨이 있다");
  eq(vecItems.filter((i) => !labels.items[i.id]?.required_facts?.length).map((i) => i.id), [], "홀드아웃4 키워드 문서 문항마다 묻는 사실 라벨이 있다");
  const badCols = sqlItems.flatMap((i) =>
    (labels.items[i.id]?.asked_columns ?? []).filter((c) => c === "id" || c.endsWith("_id") || !new RegExp(`\\b${c}\\b`).test(i.sql)).map((c) => `${i.id}:${c}`),
  );
  eq(badCols, [], "묻는 열은 정답 SQL 에 있는 열이고 id 열이 아니다");
  const badFacts = vecItems.flatMap((i) =>
    (labels.items[i.id]?.required_facts ?? []).filter((f) => !(i.gold_keywords ?? []).some((k) => k.includes(f))).map((f) => `${i.id}:${f}`),
  );
  eq(badFacts, [], "묻는 사실은 그 문항 정답 키워드의 부분 문자열이다(라벨이 새 정답을 만들지 않는다)");
  const same = (got: string[] | undefined, a: string[], b: string[]) => {
    const want = new Set([...a, ...b]);
    return (got ?? []).length === want.size && (got ?? []).every((x) => want.has(x));
  };
  const { A, B } = labels.labellers;
  eq(
    [
      ...sqlItems.filter((i) => !same(labels.items[i.id].asked_columns, A.output.sql[i.id].asked_columns, B.output.sql[i.id].asked_columns)),
      ...vecItems.filter((i) => !same(labels.items[i.id].required_facts, A.output.vector[i.id].required_facts, B.output.vector[i.id].required_facts)),
    ].map((i) => i.id),
    [],
    "라벨은 두 라벨러 출력의 합집합 그대로다(손으로 고친 칸이 없다)",
  );
  const fix = labels.errata["h4-59"] as GoldLabelsFile["errata"][string] & { v1_gold_answer_names: string[] };
  const orig = byset.holdout4.find((i) => i.id === "h4-59")?.gold_answer_names ?? [];
  eq(Object.keys(labels.errata), ["h4-59"], "정정은 데이터셋으로 확인한 h4-59 하나다");
  eq(fix.v1_gold_answer_names, orig, "정정의 v1 이름은 봉인 파일의 정답 그대로다");
  ok(new Set(fix.gold_answer_names).size === 13 && orig.every((n) => fix.gold_answer_names.includes(n)), "정정한 h4-59 정답은 원래 10곳을 품은 13곳이다");
  eq(labelsFor(labels, "h4-59", { asked: false, errata: true })?.gold_answer_names?.length, 13, "정답 정정은 라벨을 꺼도 쓴다");
  eq(labelsFor(labels, "h4-21", { asked: false, errata: true }), undefined, "라벨을 끄면 묻는 사실은 싣지 않는다");
}

// ── 실제 답으로 본 v1 과 v2 ────────────────────────────────────────────
type Case = { set: string; id: string; source: string; label: string; answer: string; state: AnswerState; expect: { right: boolean; basis: string } };
const cases = JSON.parse(readFileSync(resolve(root, "eval/companyx/scorer_cases.json"), "utf8")) as {
  sql: (Case & { q: string; gold: { gold_id: string; rows: Record<string, unknown>[]; ordered: boolean; limited: boolean; tied: string[]; types: Record<string, ValueKind> } })[];
  vector: Case[];
  graph: Case[];
};
// 데이터셋 없이 도는 판정용 개체 목록. 고객사 id 30개(Client-A … Client-AD)와 제품 id 12개만 있으면 지어낸 개체를 가른다.
const idCat = buildCatalog([
  ...[..."ABCDEFGHIJKLMNOPQRSTUVWXYZ", "AA", "AB", "AC", "AD"].map((x) => ({ name: `Client-${x}`, type: "client" })),
  ...["C1", "C2", "C3", "C4", "D1", "D2", "D3", "S1", "S2", "S3", "T1", "T2"].map((x) => ({ name: `Product-${x}`, type: "product" })),
]);
{
  const verdicts = (c: (typeof cases.sql)[number]) => {
    const gold: SqlGold = { rows: c.gold.rows, ordered: c.gold.ordered, limited: c.gold.limited, tied: c.gold.tied, types: c.gold.types };
    const asked = labels.items[c.gold.gold_id]?.asked_columns;
    const v = (r: ScoreRules, g: SqlGold) => scoreSql(c.answer, c.q, g, idCat, c.state, r).correct;
    return { v1: v("v1", gold), v2m: v("v2", gold), v2: v("v2", { ...gold, asked }) };
  };
  for (const c of cases.sql) {
    const v = verdicts(c);
    const tag = `SQL ${c.id}(${c.source})`;
    if (c.expect.right) {
      ok(!v.v1, `${tag}: v1 은 진단이 옳다고 본 답을 틀린다 — 고칠 결함이 실제로 있다`);
      ok(v.v2, `${tag}: v2 는 그 답을 맞힌다`);
    } else ok(!v.v1 && !v.v2m && !v.v2, `${tag}: 실제로 틀린 답은 v1, v2(라벨 없이), v2 모두 틀린다`);
  }
  eq(cases.sql.filter((c) => !c.expect.right).length, 10, "SQL 음성 사례는 진단의 실제 오답 9과 공개 기록의 h4-06 오답");
  // 무엇이 고쳤는지: 질문이 말한 값 규칙은 h4-06 만, 묻는 열 라벨은 나머지 다섯. h4-13(MAX 부분 질의)은 라벨로만 맞는다 —
  // MAX 정답을 LIMIT 처럼 보는 기계 규칙은 h3-20, h4-10, h4-20 처럼 질문이 그 값을 묻는 정답에서 값을 빼므로 넣지 않았다.
  eq(cases.sql.filter((c) => c.expect.right && verdicts(c).v2m).map((c) => c.id), ["h4-06"], "질문이 말한 값을 빼는 규칙만으로 맞는 것은 h4-06");
  eq(
    cases.sql.filter((c) => c.expect.right && !verdicts(c).v2m).map((c) => c.id),
    ["h4-02", "h4-07", "h4-10", "h4-13", "h3-03"],
    "묻는 열 라벨이 있어야 맞는 다섯(h4-13 포함)",
  );

  // 질문이 말한 값: 모든 행에서 같은 글자 값만, 빼면 요구가 남을 때만 뺀다.
  const g1: SqlGold = { rows: [{ name: "Client-C", region: "부산", industry: "IT/SW" }], ordered: false, limited: false, tied: [] };
  eq(requiredColumns("부산 쪽에 있는 IT/SW 업종 고객사가 어디였더라?", g1, "v2"), ["name"], "질문이 말한 부산, IT/SW 는 요구하지 않는다");
  eq(requiredColumns("부산 쪽에 있는 IT/SW 업종 고객사가 어디였더라?", g1, "v1"), ["name", "region", "industry"], "v1 은 그대로 요구한다");
  const g2: SqlGold = { rows: [{ region: "부산" }], ordered: false, limited: false, tied: [] };
  eq(requiredColumns("Client-A 가 부산에 있어?", g2, "v2"), ["region"], "빼면 남는 것이 없으면 빼지 않는다");
  ok(!scoreSql("아니요, 서울에 있습니다.", "Client-A 가 부산에 있어?", g2, idCat, "ok", "v2").correct, "확인 질문에 다른 값을 댄 답은 틀린다");
  const g3: SqlGold = { rows: [{ name: "Client-A", amount: "100" }, { name: "Client-B", amount: "200" }], ordered: false, limited: false, tied: [] };
  eq(requiredColumns("Client-A 랑 Client-B 매출 각각 얼마야?", g3, "v2"), ["name", "amount"], "행마다 다른 이름은 질문에 있어도 요구한다(어느 행의 값인지 가른다)");
  ok(!scoreSql("100 과 200 입니다", "Client-A 랑 Client-B 매출 각각 얼마야?", g3, idCat, "ok", "v2").correct, "이름 없이 수만 댄 답은 틀린다");
  const g4: SqlGold = { rows: [{ name: "Client-B", amount: "10000" }], ordered: false, limited: false, tied: [] };
  eq(requiredColumns("금액 10000 넘는 계약 고객사?", g4, "v2"), ["name", "amount"], "질문에 있는 수는 빼지 않는다(글자 값만 뺀다)");
}
{
  // 문서 문항. 정답 문서 본문은 데이터셋에 있다 — 여기서는 정답 키워드만 담은 문서로 같은 함수를 돈다.
  const h4 = new Map(byset.holdout4.map((i) => [i.id, i]));
  const judge = (it: HoldoutItem, answer: string, state: AnswerState, r: ScoreRules, withLabels: boolean): boolean | null => {
    const docs = new Map((it.gold_docs ?? []).map((d) => [d.replace(/\.md$/, ""), (it.gold_keywords ?? []).join("\n")]));
    const g = holdoutVectorGold(it, docs, { rules: r, facts: withLabels ? labels.items[it.id]?.required_facts : undefined });
    return "gold" in g ? scoreVectorKeyed(answer, it.q, g.gold, idCat, state, r).correct : null;
  };
  const verdicts = (c: Case) => {
    const it = h4.get(c.id) as HoldoutItem;
    return { v1: judge(it, c.answer, c.state, "v1", false), v2m: judge(it, c.answer, c.state, "v2", false), v2: judge(it, c.answer, c.state, "v2", true) };
  };
  for (const c of cases.vector) {
    const v = verdicts(c);
    const tag = `문서 ${c.id}(${c.source})`;
    if (c.expect.right) {
      ok(v.v1 === false, `${tag}: v1 은 진단이 옳다고 본 답을 틀린다`);
      ok(v.v2 === true, `${tag}: v2 는 그 답을 맞힌다`);
    } else ok(v.v1 !== true && v.v2m !== true && v.v2 !== true, `${tag}: 실제로 틀린 답은 v1, v2(라벨 없이), v2 모두 틀린다`);
  }
  eq(
    cases.vector.filter((c) => c.expect.right && verdicts(c).v2m === true).map((c) => `${c.id}:${c.source}`),
    ["h4-23", "h4-24", "h4-30", "h4-31", "h4-33", "h4-34", "h4-35", "h4-37", "h4-38"].map((id) => `${id}:record-1011`).concat("h4-33:published-1002"),
    "수를 값으로 보는 규칙만으로 맞는 것은 진단의 아홉과 공개 기록의 h4-33(「10일」)",
  );
  eq(
    cases.vector.filter((c) => c.expect.right && verdicts(c).v2m !== true).map((c) => c.id),
    ["h4-21", "h4-25", "h4-27", "h4-28", "h4-29"],
    "묻는 사실 라벨이 있어야 맞는 다섯(묻지 않은 키워드)",
  );
  eq(verdicts(cases.vector.find((c) => c.id === "h4-26") as Case).v2, null, "정답 문서가 셋인 h4-26 은 v2 에서도 채점 불가");

  // 값 규칙의 경계(합성). 진단의 실제 오답은 위에서 봤고, 여기는 규칙이 받아서는 안 되는 모양이다.
  const it = (id: string) => h4.get(id) as HoldoutItem;
  const both = (id: string, a: string) => [judge(it(id), a, "ok", "v2", false), judge(it(id), a, "ok", "v2", true)];
  eq(both("h4-30", "Product-D1 API의 기본 분당 호출 한도는 2130회이고, 프리미엄 분당 호출 한도는 263회입니다."), [false, false], "기본과 프리미엄의 값이 엇갈린 답은 틀린다(라벨이 꼬리표를 떼도 정답 키워드의 꼬리표로 본다)");
  eq(both("h4-30", "기본과 프리미엄 각각 분당 263회, 2130회입니다."), [true, true], "「각각」으로 꼬리표와 값을 따로 늘어놓은 답은 맞다");
  eq(both("h4-23", "40초"), [false, false], "단위가 다르면 틀린다");
  eq(both("h4-37", "약 4,100만원"), [false, false], "어림한 값은 틀린다");
  // 알려진 한계를 못 박는다(고치면 이 단언을 같이 바꾼다). 맞는 값과 다른 값을 함께 대면 v2 는 맞는 값을 찾아 맞힌다.
  // v1 의 SQL 수 판정과 같은 성질이고, 개발 세트의 실제 답 중 이런 답은 없다(재채점에서 v2 가 맞힌 답을 전부 읽어 확인).
  eq(both("h4-39", "TCO 절감률은 28%입니다. 다른 제안서는 40%였습니다."), [true, true], "알려진 한계: 다른 값을 곁들인 답도 맞는 값이 있으면 맞힌다");
  eq(judge(it("h4-39"), "TCO 절감률은 28%입니다. 다른 제안서는 40%였습니다.", "ok", "v1", false), false, "(대조) v1 은 그 답을 글자로 틀린다");
  eq(both("h4-33", "마일스톤 2가 며칠 밀렸는지는 문서에 없습니다"), [false, false], "질문이 말한 수(마일스톤 2)만 되풀이한 답은 틀린다");
}

// ── 정답 정정 h4-59 와 그래프 실제 답 — 데이터셋이 있을 때만 ────────────
{
  const dir = resolve(root, "datasets/companyx-v1.0");
  if (!TEST_AS_CI && existsSync(resolve(dir, "graph/nodes.json")) && existsSync(resolve(dir, "graph/edges.json"))) {
    const nodes = JSON.parse(readFileSync(resolve(dir, "graph/nodes.json"), "utf8")) as { id: string; name: string; type: string }[];
    const edges = JSON.parse(readFileSync(resolve(dir, "graph/edges.json"), "utf8")) as { source: string; relation: string; target: string }[];
    const cat = buildCatalog(nodes);
    const byId = new Map(nodes.map((n) => [n.id, n.name]));
    const t2 = nodes.find((n) => n.name === "Product-T2")?.id;
    const reporters = edges.filter((e) => e.relation === "REPORTED_ISSUE" && e.target === t2).map((e) => byId.get(e.source) as string);
    const fix = labels.errata["h4-59"];
    eq([...reporters].sort(), [...fix.gold_answer_names].sort(), "정정한 h4-59 정답은 edges.json 의 Product-T2 REPORTED_ISSUE 출발점 전부다");
    const edgeSet = new Set(edges.map((e) => `${e.source}|${e.relation}|${e.target}`));
    ok((fix.gold_edges ?? []).length === 13 && (fix.gold_edges ?? []).every((e) => edgeSet.has(`${e.source}|${e.relation}|${e.target}`)), "정정의 엣지 13개가 그래프에 있다");
    for (const c of cases.graph) {
      const item = byset[c.set].find((i) => i.id === c.id) as HoldoutItem;
      const judge = (r: ScoreRules) => {
        const g = holdoutKgGold(item, cat, r === "v2" ? labelsFor(labels, c.id, { asked: false, errata: true })?.gold_answer_names : undefined);
        return "gold" in g ? scoreKg(c.answer, item.q, g.gold, cat, c.state).correct : null;
      };
      const [v1, v2] = [judge("v1"), judge("v2")];
      const tag = `그래프 ${c.id}(${c.source})`;
      if (c.expect.right) ok(v1 === false && v2 === true, `${tag}: 13곳을 다 댄 답은 v1 이 틀리고 v2 가 맞힌다`);
      else if (c.source === "oracle-edges") ok(v1 === true && v2 === false, `${tag}: 틀린 정답(10곳)을 받아 10곳만 댄 답은 v1 이 맞히고 v2 가 틀린다`);
      else ok(v1 !== true && v2 !== true, `${tag}: 실제로 틀린 답은 v1, v2 모두 틀린다`);
    }
    // v2 로도 봉인 홀드아웃 그래프, 벡터 전 문항의 모범 답은 정답, 기권은 오답이고, 채점 가능 수는 v1 과 같다.
    const index = JSON.parse(readFileSync(resolve(dir, "documents/index.json"), "utf8")) as { id: string; filename: string }[];
    const docs = new Map(index.map((e) => [e.id, readFileSync(resolve(dir, "documents", e.filename), "utf8")]));
    const scorable: Record<string, number> = {};
    for (const { set, items } of sets) {
      const built = items
        .filter((i) => i.expected !== "nl2sql")
        .map((i) => holdoutItem(i, { docs, cat, rules: "v2", labels: labelsFor(labels, i.id) }));
      eq(selfCheckItems(built), [], `${set} 그래프, 벡터 전 문항 자기 점검(v2, 라벨과 정정)`);
      scorable[set] = built.filter((b) => !b.unscorable).length;
    }
    eq(scorable, { holdout3: 19, holdout4: 39 }, "v2 의 채점 가능 수는 v1 과 같다(라벨이 분모를 바꾸지 않는다)");
  } else {
    console.log("  SKIP: 정답 정정 h4-59 와 그래프 실제 답 v2 점검 (데이터셋 없음 — datasets/companyx-v1.0)");
  }
}

console.log(`\nscorecard.test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
