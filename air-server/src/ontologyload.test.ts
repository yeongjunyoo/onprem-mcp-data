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

// 서버 경로 온톨로지 적재 테스트 (이슈 #18) — DB 필요.
//
// 무엇을 막는가. PR #15의 타입쌍 추론은 온톨로지가 적재돼 있어야 동작한다. 적재를
// 서버에 연결하지 않으면 **평가 CLI에서 잰 라우팅 성능이 실제 서버 경로에서는
// 나오지 않는다.** 기능테스트는 서버를 띄워 시연시키므로 그 간극이 그대로 실점이다.
//
// 그래서 여기서는 "적재 함수가 성공했다"가 아니라 **"서버가 내리는 라우팅 결정이
// 평가 경로와 같다"**를 단언한다. 전자는 통과해도 후자가 깨질 수 있다.
//
// 실행: DATASET=companyx node dist/ontologyload.test.js
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadRouterOntology, routerOntologyState, buildServer } from "./server.js";
import { route, installOntology, entityLexiconSize, maskEntities } from "./router.js";

let pass = 0,
  fail = 0;
function ok(cond: boolean, msg: string) {
  if (cond) pass++;
  else {
    fail++;
    console.error("  FAIL:", msg);
  }
}

async function main() {
  // 적재 전에는 사전이 비어 있어야 한다(기동 순서 의존성을 드러낸다).
  installOntology([], []);
  ok(entityLexiconSize() === 0, "적재 전 사전은 비어 있다");
  const before = route("김지훈 직원 지금 무슨 건 붙어 있어?");
  ok(before.typePair === undefined, "적재 전에는 타입쌍이 발동하지 않는다");

  // ── 서버 경로 적재 ──────────────────────────────────────────────────
  const state = await loadRouterOntology();
  ok(!state.error, `DB에서 온톨로지 적재 성공 (${state.error ?? "ok"})`);
  ok(state.entities > 100, `개체 적재 (${state.entities}개)`);
  ok(state.typePairs > 0, `타입쌍 유도 (${state.typePairs}쌍)`);
  ok(routerOntologyState().entities === state.entities, "적재 상태가 노출된다");

  // ── ★ 핵심: 서버 경로 결정 == 평가 경로 결정 ─────────────────────────
  //
  // 평가 CLI는 데이터셋 파일에서, 서버는 DB에서 온톨로지를 만든다. 두 출처가
  // 같은 라우팅 결정을 내지 않으면 평가 수치는 서버에 대해 아무 말도 하지 않는다.
  //
  // 문서가 인용하는 문항 세트 전부를 대조하고, 규칙 결정(route)과 함께 시맨틱 단계의 입력
  // (maskEntities)도 본다. 둘이 같으면 routeQuery 의 최종 결정도 같다. 홀드아웃 2차의 규칙
  // 결정만 대조하던 동안 지역, 업종 별칭이 고객사 이름으로 사전에 들어간 것을 못 잡았다
  // (서버 사전 296개 중 32개가 속성 값, 2026-10-02).
  const here = dirname(fileURLToPath(import.meta.url));
  const root = resolve(here, "../..");
  const readItems = (rel: string): { q: string }[] => {
    const p = resolve(root, rel);
    if (!existsSync(p)) return [];
    const text = readFileSync(p, "utf8");
    if (rel.endsWith(".jsonl")) return text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
    const raw = JSON.parse(text);
    return Array.isArray(raw) ? raw : raw.items;
  };
  const questions: string[] = [];
  for (const rel of [
    "datasets/companyx-v1.0/questions.json",
    "eval/companyx/holdout_route.json",
    "eval/companyx/holdout2_route.json",
    "eval/companyx/holdout3_route.json",
    "eval/companyx/holdout4_route.json",
    "eval/companyx/kg_gold.json",
    "eval/companyx/sql_gold.jsonl",
    "eval/companyx/vector_gold.json",
  ]) {
    for (const it of readItems(rel)) if (!questions.includes(it.q)) questions.push(it.q);
  }
  const decide = (q: string) => JSON.stringify({ route: route(q), masked: maskEntities(q.trim()) });

  const gdir = resolve(root, "datasets/companyx-v1.0/graph");
  if (questions.length && existsSync(resolve(gdir, "nodes.json"))) {
    // DB 출처(현재 적재 상태)로 결정을 받아 둔다.
    const fromDb = questions.map(decide);

    // 데이터셋 파일 출처로 갈아끼우고 같은 질문을 다시 묻는다.
    const nodes = JSON.parse(readFileSync(resolve(gdir, "nodes.json"), "utf8"));
    const edges = JSON.parse(readFileSync(resolve(gdir, "edges.json"), "utf8"));
    installOntology(nodes, edges);
    const fromFile = questions.map(decide);

    const diff = questions.filter((_, i) => fromDb[i] !== fromFile[i]);
    ok(diff.length === 0, `서버(DB) 경로와 평가(파일) 경로의 결정과 마스킹이 동일 (${questions.length}문항, 불일치 ${diff.length}건)`);
    for (const q of diff.slice(0, 5)) console.error("    불일치:", q);

    // 되돌려 놓는다.
    await loadRouterOntology();
  } else {
    console.log("  SKIP: 파일 출처 대조 (데이터셋 없음)");
  }

  // 여러 고객사가 나눠 가진 별칭(지역)은 이름이 아니다.
  ok(maskEntities("서울 쪽 매출이 어때") === "서울 쪽 매출이 어때", "서버 사전은 지역을 고객사 자리표시로 가리지 않는다");

  const goldPath = resolve(root, "eval/companyx/holdout2_route.json");
  if (existsSync(goldPath)) {
    const gold = JSON.parse(readFileSync(goldPath, "utf8")) as {
      items: { q: string; expected: string }[];
    };

    // 적재 후 그래프 레인이 실제로 살아난다.
    const kg = gold.items.filter((it) => it.expected === "knowledge_graph");
    const hit = kg.filter((it) => route(it.q).route === "graph").length;
    ok(hit >= 7, `적재 후 구어체 관계 질문 ${hit}/${kg.length} (7 이상이어야 회귀 아님)`);
  } else {
    console.log("  SKIP: 홀드아웃 2차 없음");
  }

  // ── 서버가 route 응답에 사전 크기를 노출한다 ─────────────────────────
  const server = buildServer();
  const r = JSON.parse(await server.callTool("route", { query: "최근 주문 건수 알려줘" }));
  ok(typeof r.entity_lexicon === "number", "route 응답에 entity_lexicon 노출");
  ok(r.entity_lexicon > 100, `route 응답의 사전 크기 (${r.entity_lexicon})`);

  console.log(`\nontologyload.test: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
