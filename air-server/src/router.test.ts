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

// Router tests (mirror prototype/test_router.py): correctness + determinism.
// Run after build: node dist/router.test.js
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { route, audit, installOntology, entityLexiconSize, fitPlanToSeed, identifyingAliases, maskEntities, buildGraphPlan, documentCountRequest, pairRelationRequest, backReferenceOnly, entitiesIn, SQL_TOOL, VECTOR_TOOL, ONTOLOGY_TOOL, GRAPH_TOOL, RELATION_SIGNAL_TYPES } from "./router.js";

// 데이터셋이 있어도 없는 것처럼 센다. verify-test-counts 가 데이터셋 없는 CI 의 단언 수를
// 로컬에서 세려고만 켠다(셸에 남아도 단언 수가 「데이터셋 없음」 정본과 같아질 뿐이다).
const TEST_AS_CI = process.env.TEST_AS_CI === "1";

let pass = 0, fail = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { pass++; } else { fail++; console.error("  FAIL:", msg); }
}
function eq<T>(a: T, b: T, msg: string) { ok(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)})`); }

// structured: count + time
let d = route("최근 3개월간 주문 건수 알려줘");
eq(d.route, "structured", "structured count+time");
eq(d.tools, [SQL_TOOL], "structured -> sql only");

// semantic: aboutness
d = route("환불 정책에 대한 내용 찾아줘");
eq(d.route, "semantic", "semantic aboutness");
eq(d.tools, [VECTOR_TOOL], "semantic -> vector only");

// hybrid: both
d = route("지난달 취소된 주문 중 환불 관련 문의가 비슷한 케이스");
eq(d.route, "hybrid", "hybrid both signals");
eq(d.tools, [SQL_TOOL, VECTOR_TOOL], "hybrid -> both tools");

// ambiguous -> hybrid fan-out
eq(route("주문").route, "hybrid", "ambiguous defaults to hybrid");

// '몇 명' counts as structured
eq(route("전체 사용자 수는 몇 명이야").route, "structured", "몇 명 -> structured");

// determinism: 20 runs identical
const q = "지난달 취소된 주문 중 환불 관련 문의가 비슷한 케이스";
const first = JSON.stringify(audit(route(q)));
let stable = true;
for (let i = 0; i < 20; i++) if (JSON.stringify(audit(route(q))) !== first) stable = false;
ok(stable, "determinism: 20 runs identical");

// ── 온톨로지 커버리지 불변식 ───────────────────────────────────────────
//
// 데이터셋의 모든 엣지 타입은 라우터가 부를 수 있어야 한다. 신호가 없는 엣지
// 타입은 질문으로 도달할 수 없는 사각지대이고, 그 관계에 대한 질문은 전부
// 오답이 된다. 라벨을 손으로 적지 않고 edges.json에서 읽어 대조하므로,
// 데이터셋에 관계가 추가되면 라우터를 고치기 전에 이 테스트가 먼저 깨진다.
//
// 발견 경위: HAS_PROJECT(354엣지 중 40)에 신호가 없어 홀드아웃 라우팅이
// 0.767에 머물렀다. 수정 후 0.900.
{
  const here = dirname(fileURLToPath(import.meta.url));
  const edgesPath = resolve(here, "../../datasets/companyx-v1.0/graph/edges.json");
  if (!TEST_AS_CI && existsSync(edgesPath)) {
    const edges = JSON.parse(readFileSync(edgesPath, "utf8")) as { relation: string }[];
    const inData = [...new Set(edges.map((e) => e.relation))].sort();
    const uncovered = inData.filter((t) => !RELATION_SIGNAL_TYPES.has(t));
    eq(uncovered, [], "온톨로지 커버리지: 신호 없는 엣지 타입");
  } else {
    // 데이터셋은 배포 조건상 저장소에 없다. 없으면 건너뛰되 침묵하지 않는다.
    console.log("  SKIP: 온톨로지 커버리지 (데이터셋 없음 — npm run companyx:load 후 재실행)");
  }
}

// 관계 질문 라우팅: 각 엣지 타입이 실제로 그래프 레인으로 간다
eq(route("김지훈 직원이 관여하는 프로젝트는 뭐야?").route, "graph", "HAS_PROJECT -> graph");
eq(route("Client-X 고객사와 연결된 직원은 누구야?").route, "graph", "무타입 관계 + 엔티티 -> graph");
eq(route("데이터플랫폼팀 부서에 소속된 직원 전원을 보여줘").route, "graph", "BELONGS_TO -> graph");

// 인물 엔티티는 잡되 동사 관형어미는 이름으로 오인하지 않는다
ok(route("김지훈 직원이 관여하는 프로젝트는 뭐야?").entityHits.includes("person"), "인물 엔티티 인식");
ok(!route("재직 중인 직원의 평균 연봉은 얼마야?").entityHits.includes("person"), "'중인 직원'은 인물이 아니다");
ok(!route("기술지원팀 부서에 소속된 직원 전원을 보여줘").entityHits.includes("person"), "'소속된 직원'은 인물이 아니다");

// 엔티티 앵커가 있는 모호 질문은 그래프까지 fan-out 한다 (3레인 사각지대 방지)
{
  const d2 = route("Product-S1 초기 설정과 필수 요구사항을 알려줘");
  eq(d2.route, "hybrid", "엔티티 앵커 모호 질문 -> hybrid");
  ok(d2.tools.includes(ONTOLOGY_TOOL) && d2.tools.includes(GRAPH_TOOL), "엔티티 앵커 fan-out은 그래프를 포함한다");
  ok(d2.tools.includes(VECTOR_TOOL), "엔티티 앵커 fan-out은 벡터도 포함한다");
}
// 앵커가 없으면 그래프를 켜지 않는다 (앵커 없는 탐색은 낭비)
{
  const d3 = route("주문");
  eq(d3.tools, [SQL_TOOL, VECTOR_TOOL], "앵커 없는 모호 질문은 2레인만");
}

// ── 타입쌍 추론 ───────────────────────────────────────────────────────
//
// 관계 표현은 무한하다("관여하는/연결된/끼고 있는/붙어 있는/창구/윗선"…).
// 규칙 기반 라우터가 어휘로 그것을 따라잡는 것은 원리적으로 진다. 대신 질문이
// 지목한 개체의 타입과 질문이 가리키는 타입을 온톨로지에 대조해 엣지를 유도한다.
// 늘어나는 어휘는 노드 타입 지시어뿐이고 노드 타입은 닫힌 집합이다.
{
  const here = dirname(fileURLToPath(import.meta.url));
  const gdir = resolve(here, "../../datasets/companyx-v1.0/graph");
  // 둘 다 있어야 한다. nodes.json 만 보고 edges.json 을 무조건 읽으면, 한쪽만 있는
  // 상태에서 스킵이 아니라 크래시가 난다(부분 데이터셋 프로브에서 실측).
  if (!TEST_AS_CI && existsSync(resolve(gdir, "nodes.json")) && existsSync(resolve(gdir, "edges.json"))) {
    const nodes = JSON.parse(readFileSync(resolve(gdir, "nodes.json"), "utf8"));
    const edges = JSON.parse(readFileSync(resolve(gdir, "edges.json"), "utf8"));
    const inst = installOntology(nodes, edges);
    ok(inst.entities > 100, `엔티티 사전 적재 (${inst.entities}개)`);
    ok(inst.typePairs > 0, `타입쌍 사상 유도 (${inst.typePairs}쌍)`);
    ok(entityLexiconSize() === inst.entities, "사전 크기 일치");

    // 관계어를 하나도 모르는 구어체 질문이 온톨로지로 풀린다
    const names = (nodes as { name: string; type: string }[]);
    const emp = names.find((n) => n.type === "employee")!.name;
    const dept = names.find((n) => n.type === "department")!.name;

    const d4 = route(`${emp} 사원은 어느 조직 사람이야?`);
    eq(d4.route, "graph", "타입쌍: employee+department -> graph");
    eq(d4.typePair?.relation, "BELONGS_TO", "타입쌍이 BELONGS_TO를 유도");

    const d5 = route(`${emp} 직원 지금 무슨 건 붙어 있어?`);
    eq(d5.route, "graph", "타입쌍: employee+project -> graph");

    // 이름이 은/한/인으로 끝나도 개체로 인식해야 한다 (정규식 폴백의 결함)
    const trickyName = names.find((n) => n.type === "employee" && /[은한인]$/.test(n.name));
    if (trickyName) {
      ok(
        route(`${trickyName.name} 사원은 어느 조직 사람이야?`).entityHits.includes("known_entity"),
        `이름이 ${trickyName.name.slice(-1)}으로 끝나도 개체로 인식`,
      );
    }

    // ★ 컬럼을 물으면 엣지가 아니다 — 타입쌍이 STRUCTURED_SIGNALS에 양보한다.
    // 이 양보가 없으면 사업자 공개 문항 "기술지원팀 직원 목록과 연봉을 알려줘"가
    // knowledge_graph로 새서 in-sample 30/30이 깨진다.
    eq(route(`${dept} 직원 목록과 연봉을 알려줘`).route, "structured", "컬럼 어휘가 타입쌍을 이긴다");

    // 문서 신호도 타입쌍을 이긴다
    ok(route(`${dept} 인수인계 문서 작성 방법 알려줘`).route !== "graph", "문서 신호가 타입쌍을 이긴다");

    // 사전을 비우면 타입쌍은 발동하지 않는다 (결정론 유지, 사전 없이도 동작)
    installOntology([], []);
    ok(route(`${emp} 사원은 어느 조직 사람이야?`).typePair === undefined, "사전 없으면 타입쌍 없음");
    installOntology(nodes, edges);
  } else {
    console.log("  SKIP: 타입쌍 추론 (데이터셋 없음)");
  }
}

// 한 타입쌍에 엣지가 여럿이면 질문의 관계 명사가 고른다(데이터셋 없이 도는 합성 온톨로지).
// 고객-제품 사이에 USES 가 먼저, REPORTED_ISSUE 가 나중에 나온다. 「이슈」를 물으면 뒤의 것이다.
{
  installOntology(
    [
      { id: "client_1", name: "Client-A", type: "client" },
      { id: "product_7", name: "Product-S1", type: "product" },
    ] as { id: string; name: string; type: string }[],
    [
      { source: "client_1", target: "product_7", relation: "USES" },
      { source: "client_1", target: "product_7", relation: "REPORTED_ISSUE" },
    ],
  );
  eq(route("Product-S1 관련 고객 이슈 현황은?").graphPlan?.relTypes, ["REPORTED_ISSUE"], "관계 명사가 타입쌍의 엣지를 고른다");
  eq(route("Product-S1 쓰는 고객 어디야?").graphPlan?.relTypes, ["USES"], "지목이 없으면 데이터 순서의 첫 엣지");
  installOntology([], []);
}

// 별칭은 한 개체만 가리킬 때 이름이다. 고객사 둘이 나눠 가진 「서울」은 지역이라, 사전에 들어가면
// 「서울 쪽 매출이 어때」가 「{고객사} 쪽 매출이 어때」로 가려져 그래프로 갔다(멘토 예시).
{
  const aliases = [
    { id: "1", name: "client_1", type: "client" },
    { id: "1", name: "서울", type: "client" },
    { id: "2", name: "client_2", type: "client" },
    { id: "2", name: "서울", type: "client" },
  ];
  eq(identifyingAliases(aliases).map((a) => a.name), ["client_1", "client_2"], "여러 개체가 나눠 가진 별칭(지역)은 이름이 아니다");
  installOntology([{ id: "1", name: "Client-A", type: "client" }, { id: "2", name: "Client-B", type: "client" }, ...identifyingAliases(aliases)], []);
  eq(maskEntities("서울 쪽 매출이 어때"), "서울 쪽 매출이 어때", "지역은 고객사 자리표시로 가리지 않는다");
  installOntology([], []);
}

// 계획의 엣지가 시드 타입에 닿지 않으면 온톨로지 타입 그래프로 경로를 맞춘다(fitPlanToSeed).
// 사업자 예시 25번은 HAS_PROJECT(고객사 → 프로젝트)를 제품에서 출발시켜 빈손이었다.
{
  installOntology(
    [
      { id: "client_1", name: "Client-A", type: "client" },
      { id: "product_7", name: "Product-S1", type: "product" },
      { id: "project_3", name: "Client-A 데이터 이전", type: "project" },
      { id: "employee_2", name: "김지훈", type: "employee" },
      { id: "dept_1", name: "기술지원팀", type: "department" },
    ] as { id: string; name: string; type: string }[],
    [
      { source: "client_1", target: "product_7", relation: "USES" },
      { source: "employee_2", target: "client_1", relation: "MANAGES_ACCOUNT" },
      { source: "client_1", target: "project_3", relation: "HAS_PROJECT" },
      { source: "employee_2", target: "project_3", relation: "LEADS" },
      { source: "employee_2", target: "dept_1", relation: "BELONGS_TO" },
      { source: "client_1", target: "product_7", relation: "REPORTED_ISSUE" },
    ],
  );
  const hops = (rels: string[], type: string, q: string) => fitPlanToSeed(rels, type, q).hops;
  eq(hops(["HAS_PROJECT"], "product", "Product-S1 제품과 관련된 프로젝트는?"), [["USES"], ["HAS_PROJECT"]], "제품에서 고객사를 거쳐 프로젝트로");
  eq(hops(["HAS_PROJECT"], "product", "Product-S1 이슈를 올린 고객사의 프로젝트는?"), [["REPORTED_ISSUE"], ["HAS_PROJECT"]], "다리가 여럿이면 질문이 지목한 엣지, 묻는 타입은 마지막 타입 어휘");
  eq(hops(["HAS_PROJECT"], "employee", "김지훈 직원이 관여하는 프로젝트는?"), [["LEADS"]], "시드 타입과 묻는 타입을 바로 잇는 엣지로 바꾼다");
  eq(hops(["MANAGES_ACCOUNT", "LEADS"], "client", "Client-A 담당 직원이 이끄는 프로젝트는?"), [["MANAGES_ACCOUNT"], ["LEADS"]], "두 엣지가 시드에서 이어지면 한 홉씩");
  eq(hops(["MANAGES_ACCOUNT"], "employee", "김지훈 직원이 담당하는 고객사의 프로젝트는?"), [["MANAGES_ACCOUNT"], ["HAS_PROJECT"]], "한 홉으로 묻는 타입에 못 닿으면 한 홉 더");
  eq(hops(["USES", "REPORTED_ISSUE"], "client", "Client-A 제품과 이슈 알려줘"), [["USES", "REPORTED_ISSUE"]], "둘 다 시드에 닿으면 한 홉에 둘 다");
  eq(fitPlanToSeed(["USES"], "client", "Client-A가 쓰는 제품은?").fitted, undefined, "시드에 닿고 묻는 타입에 닿으면 고치지 않는다");
  eq(hops(["BELONGS_TO"], "department", "기술지원팀 소속 직원은 누구야?"), [["BELONGS_TO"]], "개체 이름 속 타입 어휘(팀)는 묻는 타입이 아니다");
  eq(hops([], "product", "Product-S1 관련된 거 다"), [], "엣지가 없으면 무타입 확장");
  eq(hops(["BELONGS_TO"], "employee", "김지훈이랑 같은 팀인 사람 이름 좀"), [["BELONGS_TO"], ["BELONGS_TO"]], "같은 무리: 무리로 갔다가 같은 엣지로 돌아온다");
  eq(hops([], "client", "Client-A랑 같은 제품 쓰는 고객사는?"), [["USES"], ["USES"]], "계획에 엣지가 없어도 같은 무리는 타입쌍으로 푼다");
  // 홀드아웃3 #54: 「수장」이 부서장 어휘에 없어 부서-직원 타입쌍의 첫 엣지(BELONGS_TO)로 팀원 여덟을 펼쳤다.
  eq(route("기술지원팀 수장 성함 다시 좀").graphPlan?.relTypes, ["HEAD_IS"], "수장은 부서장(HEAD_IS)이다");
  // 홀드아웃3 #57: 무리(제품)를 이름으로 지목했으면 시드의 모든 무리를 왕복하지 않는다.
  // 왕복하면 Client-A 가 쓰는 다른 제품을 거친 경로가 근거 예산을 채운다.
  eq(
    fitPlanToSeed(["USES"], "client", "Client-A랑 같은 제품 쓰는 데만 추려봐. 그 제품은 Product-S1이야", ["product"]).hops,
    [["USES"]],
    "같은 무리라도 그 무리를 이름으로 지목한 시드가 있으면 왕복하지 않는다",
  );
  // 랜덤 테스트 사전 점검 2차 R5: 지목한 관계(LEADS)를 고객 담당(MANAGES_ACCOUNT)으로 바꾸거나 버리지 않는다.
  // 시드 이름 바로 뒤의 「프로젝트」가 다리 타입이다. client -HAS_PROJECT- project -LEADS- employee (-BELONGS_TO- department).
  eq(
    fitPlanToSeed(["LEADS"], "client", "Client-A 프로젝트를 이끄는 직원은 누구야?"),
    { hops: [["HAS_PROJECT"], ["LEADS"]], fitted: "LEADS 는 client 에 닿지 않아 project 를 거침: HAS_PROJECT 다음 LEADS" },
    "고객사 프로젝트의 리드는 프로젝트를 거친다",
  );
  eq(hops(["LEADS"], "client", "Client-A의 프로젝트를 맡은 사람은 누구야?"), [["HAS_PROJECT"], ["LEADS"]], "「의」로 이어도 시드의 프로젝트다");
  eq(
    fitPlanToSeed(["BELONGS_TO", "LEADS"], "client", "Client-A 프로젝트를 이끄는 직원들은 어느 부서 소속이야?"),
    { hops: [["HAS_PROJECT"], ["LEADS"], ["BELONGS_TO"]], fitted: "LEADS, BELONGS_TO 는 client 에 닿지 않아 project 를 거침: HAS_PROJECT 다음 LEADS 다음 BELONGS_TO" },
    "리드의 부서는 세 홉: 계획의 두 엣지를 묻는 타입(부서)에서 끝나게 잇는다",
  );
  // 다리 타입이 시드 이름에 붙지 않으면 종전 규칙 그대로다.
  eq(hops(["LEADS"], "client", "Client-A에서 직원이 이끄는 프로젝트는?"), [["HAS_PROJECT"]], "시드에 붙지 않은 직원은 다리가 아니다(규칙 2)");
  eq(hops(["HAS_PROJECT"], "employee", "김지훈 직원이 관여하는 프로젝트는?"), [["LEADS"]], "고객사를 말하지 않으면 고객사를 거치지 않는다(규칙 2)");
  eq(hops(["HAS_PROJECT"], "product", "Product-S1 제품과 관련된 프로젝트는?"), [["USES"], ["HAS_PROJECT"]], "계획이 질문의 관계어가 아니면(앵커) 종전 규칙 3(TC-129)");
  installOntology([], []);
  eq(hops(["HAS_PROJECT"], "product", "Product-S1 제품과 관련된 프로젝트는?"), [["HAS_PROJECT"]], "온톨로지가 없으면 계획 그대로");
}

// ── 그래프 밖 항목의 「담당」 (랜덤 테스트 사전 점검 2차 R1) ─────────────
//
// 계약, 티켓, 장애의 담당은 고객 담당 관계(MANAGES_ACCOUNT)가 아니다. 그래프에는 그 담당자가 없다.
{
  const c = route("계약을 가장 많이 담당한 직원은 누구야?");
  ok(!c.graphHits.includes("MANAGES_ACCOUNT"), "계약의 담당은 고객 담당 동사로 세지 않는다");
  eq(c.route, "structured", "계약 담당 집계는 정형");
  ok(/; 담당 not counted as MANAGES_ACCOUNT \(table noun 계약\)$/.test(c.rationale), `근거에 세지 않은 이유가 남는다 (got ${c.rationale})`);
  eq(route("티켓 7번 담당자는 누구야?").gate.scores.knowledge_graph, 0, "티켓 담당자는 그래프 점수가 없다");
  eq(route("Client-H 장애 때 대응한 담당자는 누구야?").route, "semantic", "장애 대응 담당은 문서 질문");
  // 그래프 밖 항목이 없는 「담당」 질문은 그대로다(TC-108, TC-132, TC-134, TC-152, TC-160).
  for (const q of ["서울물산 담당 엔지니어는 누구야?", "가장 많은 고객을 담당하는 직원은?", "서울물산 담당 엔지니어와 Client-A가 사용 중인 제품을 알려줘"]) {
    const r = route(q);
    ok(r.graphHits.includes("MANAGES_ACCOUNT") && !/not counted/.test(r.rationale), `고객 담당 질문은 그대로: ${q}`);
  }
}

// ── 상태 조건은 거르라는 말일 때만 (랜덤 테스트 2차 R4) ──────────────────
//
// 조건은 시드의 엣지에도 걸린다. 「계획 중인 것도 빼지 마」를 조건으로 읽으면 계획 중인 프로젝트만 남는다.
{
  const inProgress = { side: "target", key: "status", value: "in_progress" };
  eq(buildGraphPlan("진행 중인 프로젝트를 이끄는 직원 목록", ["LEADS"], false).filter, inProgress, "진행 중은 조건(TC-050, TC-111, TC-130)");
  eq(buildGraphPlan("Client-AC에서 진행 중인 프로젝트는 뭐야?", ["HAS_PROJECT"], false).filter, inProgress, "시드가 있어도 조건");
  for (const q of ["서재원 쪽 프로젝트 묶음에 뭐뭐 있지? 계획 중인 것도 빼지 마", "Client-A 프로젝트 중 완료된 건 빼고 알려줘", "진행 중이 아닌 프로젝트", "완료된 것까지 포함해서 전부"]) {
    eq(buildGraphPlan(q, ["LEADS"], false).filter, undefined, `빼다, 말고, 아닌, 포함이 붙으면 조건이 아니다: ${q}`);
  }
}

// ── 그래프 집계의 방향 (랜덤 테스트 2차 R6) ─────────────────────────────
{
  eq(route("담당하는 고객사가 가장 적은 직원은 누구야?").graphPlan, { relTypes: ["MANAGES_ACCOUNT"], aggregate: "source", order: "asc" }, "가장 적은 → 적은 쪽부터");
  eq(buildGraphPlan("이슈가 가장 낮은 제품", ["REPORTED_ISSUE"], true).order, "asc", "가장 낮은 → 적은 쪽부터");
  // 「많은」은 종전 계획 그대로(TC-132, TC-133). order 키가 없다.
  eq(route("가장 많은 고객을 담당하는 직원은?").graphPlan, { relTypes: ["MANAGES_ACCOUNT"], aggregate: "source" }, "가장 많은 → 종전 그대로");
  eq(buildGraphPlan("기술 지원 이슈가 가장 많은 제품은?", ["REPORTED_ISSUE"], true), { relTypes: ["REPORTED_ISSUE"], aggregate: "target" }, "TC-133 계획 그대로");
}

// ── 문서 개수 질문 (랜덤 테스트 2차 R9) ─────────────────────────────────
//
// 개체 이름, 문서 종류, 개수 말과 조사뿐인 질문만 문서 제목으로 센다. 다른 낱말이 있으면 제목으로 셀 수 없어 종전 길이다.
{
  installOntology(
    [
      { id: "client_1", name: "Client-A", type: "client" },
      { id: "client_1", name: "client_1", type: "client" },
      { id: "product_1", name: "Product-C1", type: "product" },
      { id: "employee_3", name: "김준혁", type: "employee" },
      { id: "project_9", name: "Client-A 데이터 이전", type: "project" },
    ] as { id: string; name: string; type: string }[],
    [],
  );
  eq(documentCountRequest("Product-C1 관련 장애 보고서는 몇 건이야?"), { entity: "Product-C1", kind: "장애 보고서", tag: "[장애보고]" }, "장애 보고서 개수");
  eq(documentCountRequest("Product-C1 관련 문서는 몇 개야?"), { entity: "Product-C1", kind: "문서" }, "문서 개수(종류 무관)");
  eq(documentCountRequest("회의록 개수 알려줘"), { kind: "회의록", tag: "[회의록]" }, "개체 없이 종류만");
  eq(documentCountRequest("client_1 제안서는 몇 건?"), { entity: "Client-A", kind: "제안서", tag: "[제안서]" }, "별칭은 정본 이름으로 센다");
  eq(documentCountRequest("설치 가이드 몇 개 있어?"), { kind: "설치 가이드", words: "설치 가이드" }, "제목 말로 고르는 종류");
  for (const q of [
    "2025년 장애 보고서는 몇 건이야?", // 연도
    "SSL 관련 장애 보고서는 몇 건이야?", // 주제
    "김준혁이 참석한 회의록은 몇 건이야?", // 사람(제목에 없다)
    "Client-A 데이터 이전 관련 문서는 몇 개야?", // 프로젝트
    "Product-C1 관련 장애 보고서 내용 알려줘", // 개수 말 없음
    "Client-A와 Product-C1 관련 문서는 몇 개야?", // 개체 둘
    "장애 보고서와 제안서는 몇 건이야?", // 종류 둘
    "2019년에 등록된 고객사는 몇 개야?", // 문서 아님(TC-142)
    "Product-C1 매출은 몇 건이야?",
  ]) eq(documentCountRequest(q), undefined, `문서 개수 질문이 아니다: ${q}`);
  installOntology([], []);
}

// 랜덤 테스트 사전 점검 3차 Q8, Q9: 두 개체의 관계 질문과 앞 대화를 가리키는 질문.
{
  installOntology(
    [
      { id: "client_17", name: "Client-Q", type: "client" },
      { id: "client_4", name: "Client-D", type: "client" },
      { id: "product_12", name: "Product-D3", type: "product" },
      { id: "employee_9", name: "조현우", type: "employee" },
      { id: "department_3", name: "영업팀", type: "department" },
    ] as { id: string; name: string; type: string }[],
    [],
  );
  eq(pairRelationRequest("Client-Q와 조현우는 무슨 관계야?"), { a: "Client-Q", b: "조현우" }, "고객사와 직원");
  eq(pairRelationRequest("Client-D와 Product-D3는 어떤 관계야?"), { a: "Client-D", b: "Product-D3" }, "고객사와 제품");
  eq(pairRelationRequest("조현우랑 Client-Q는 서로 어떤 관계가 있어?"), { a: "조현우", b: "Client-Q" }, "「랑」, 「서로」, 「관계가 있어」");
  eq(pairRelationRequest("Client Q와 조현우는 무슨 관계야?"), { a: "Client-Q", b: "조현우" }, "띄어 쓴 식별자");
  for (const q of [
    "Client-Q와 서울물산은 무슨 관계야?", // 없는 개체
    "Client-Q와 Client-Q는 무슨 관계야?", // 같은 개체
    "Client-Q와 조현우의 관계를 표로 정리하고 매출도 알려줘", // 꼴이 다르다
    "Client-Q 담당자는 누구야?",
  ]) eq(pairRelationRequest(q), undefined, `두 개체 관계 질문이 아니다: ${q}`);

  for (const [q, mark] of [
    ["그럼 2위는?", "그럼"],
    ["위에서 말한 거 다시 말해줘", "위에서"],
    ["그 고객사 담당자는?", "그 고객사"],
    ["아까 그거 다시", "아까"],
    ["방금 말한 사람 누구라고?", "방금"],
  ]) eq(backReferenceOnly(q), mark, `앞 대화를 가리키는 말만: ${q}`);
  for (const q of [
    "그럼 2025년 매출은?", // 기간과 표 낱말
    "아까 말한 Client-Q 담당자는?", // 개체
    "그럼 조현우는?", // 사전의 이름
    "방금 등록된 고객사는?", // 표 낱말
    "그래프로 보여줘", // 「그래」로 시작하는 낱말
    "진행 중인 프로젝트를 이끄는 직원 목록",
    "Product-C3 이거 말썽 많이 나는 편이야?",
  ]) eq(backReferenceOnly(q), undefined, `대상이 있거나 가리키는 말이 아니다: ${q}`);

  eq(entitiesIn("영업팀 직원 중 Client-Q를 담당하지 않는 사람"), [{ name: "Client-Q", type: "client" }, { name: "영업팀", type: "department" }], "질문의 개체(긴 이름부터)");
  installOntology([], []);
}

console.log(`\nrouter.test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
