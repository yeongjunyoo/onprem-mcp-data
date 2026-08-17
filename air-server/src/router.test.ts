// Router tests (mirror prototype/test_router.py): correctness + determinism.
// Run after build: node dist/router.test.js
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { route, audit, installOntology, entityLexiconSize, SQL_TOOL, VECTOR_TOOL, ONTOLOGY_TOOL, GRAPH_TOOL, RELATION_SIGNAL_TYPES } from "./router.js";

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
  if (existsSync(edgesPath)) {
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
  if (existsSync(resolve(gdir, "nodes.json")) && existsSync(resolve(gdir, "edges.json"))) {
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

console.log(`\nrouter.test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
