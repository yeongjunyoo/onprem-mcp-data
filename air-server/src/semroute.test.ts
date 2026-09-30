// 규칙 가중치 게이트와 시맨틱 폴백 테스트. 모델 없이 돈다.
//
// 시맨틱 폴백의 정확도는 bge-m3 로만 잴 수 있으므로 여기서 재지 않는다
// (npm run companyx:boundary, companyx:holdout3). 여기서는 배선을 잰다:
// 게이트가 언제 열리는지, 열렸을 때 무엇으로 바뀌는지, 없을 때 규칙 그대로인지.
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { route, audit, installOntology, maskEntities, RULE_MIN_MARGIN, LANES, SQL_TOOL, VECTOR_TOOL, GRAPH_TOOL } from "./router.js";
import {
  routeQuery,
  semanticVerdict,
  installSemanticRouter,
  uninstallSemanticRouter,
  semanticReady,
  ROUTE_ANCHORS,
  SEMANTIC_MIN_MARGIN,
} from "./semroute.js";
import type { Embedder } from "./embedder.js";
import { z } from "zod";
import { ROUTE_OUTPUT_SCHEMA, routeToolOutput } from "./routeschema.js";

let pass = 0, fail = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { pass++; } else { fail++; console.error("  FAIL:", msg); }
}
function eq<T>(a: T, b: T, msg: string) { ok(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)})`); }

// ── 가중치 합산과 게이트 ──────────────────────────────────────────────
{
  const d = route("Client-A가 사용 중인 제품 목록은?");
  eq(d.gate.pick, "knowledge_graph", "관계 동사 -> 그래프 pick");
  ok(d.gate.scores.knowledge_graph >= 3, "관계 동사는 3점 이상");
  ok(d.gate.confident, "관계 동사 질문은 규칙이 확신한다");

  const h = route("주문");
  eq(h.gate.pick, null, "hybrid 는 pick 없음");
  ok(!h.gate.confident, "판단 포기는 확신이 아니다");

  // 「매출」은 정형 신호, 「보고서」는 문서 신호. 사다리는 문서를 고르고, 격차가 남는다.
  const mix = route("매출 관련 보고서 찾아줘");
  eq(mix.route, "semantic", "문서 어휘가 컬럼 어휘를 이긴다");
  ok(mix.gate.scores.nl2sql > 0 && mix.gate.scores.vector_search > mix.gate.scores.nl2sql, "두 신호가 모두 점수로 남는다");

  // 사다리가 고른 도구보다 다른 도구 점수가 높으면 격차는 음수 -> 확신 없음.
  for (const q of ["최근 3개월간 주문 건수 알려줘", "환불 정책에 대한 내용 찾아줘", "지난달 취소된 주문 중 환불 관련 문의가 비슷한 케이스"]) {
    const g = route(q).gate;
    ok(g.confident === (g.pick !== null && g.margin >= RULE_MIN_MARGIN), `confident 정의 일치: ${q}`);
  }

  const a = audit(route("주문"));
  ok("rule_scores" in a && "rule_margin" in a && "semantic_fallback" in a, "감사 로그에 게이트가 남는다");
  eq(a.semantic_fallback, null, "폴백이 안 돌았으면 null");
}

// ── 앵커 표 불변식 ────────────────────────────────────────────────────
{
  eq(Object.keys(ROUTE_ANCHORS).sort(), [...LANES].sort(), "앵커는 세 도구 전부에 있다");
  const PH = ["{고객사}", "{제품}", "{직원}", "{부서}", "{프로젝트}", "{날짜}"];
  const sizeOff: string[] = [], dup: string[] = [], badPh: string[] = [];
  for (const lane of LANES) {
    for (const [type, texts] of Object.entries(ROUTE_ANCHORS[lane])) {
      if (texts.length < 3 || texts.length > 5) sizeOff.push(`${lane}/${type}:${texts.length}`);
      if (new Set(texts).size !== texts.length) dup.push(`${lane}/${type}`);
      for (const t of texts) if ((t.match(/\{[^}]+\}/g) ?? []).some((ph) => !PH.includes(ph))) badPh.push(t);
    }
  }
  eq(sizeOff, [], "유형당 표현 3~5개");
  eq(dup, [], "유형 안에 중복 표현 없음");
  eq(badPh, [], "자리표시는 maskEntities 표기만");
  // 그래프 앵커의 유형 이름은 엣지 타입이다(routeQuery 가 탐색 계획에 그대로 쓴다).
  // 데이터셋의 모든 엣지 타입에 앵커가 있어야 한다.
  const here = dirname(fileURLToPath(import.meta.url));
  const edgesPath = resolve(here, "../../datasets/companyx-v1.0/graph/edges.json");
  if (existsSync(edgesPath)) {
    const edges = JSON.parse(readFileSync(edgesPath, "utf8")) as { relation: string }[];
    const missing = [...new Set(edges.map((e) => e.relation))].filter((r) => !(r in ROUTE_ANCHORS.knowledge_graph));
    eq(missing, [], "모든 엣지 타입에 그래프 앵커");
  } else {
    console.log("  SKIP: 엣지 타입 앵커 커버리지 (데이터셋 없음)");
  }
}

// ── 개체 마스킹 ───────────────────────────────────────────────────────
{
  installOntology(
    [
      { name: "Product-C3", type: "product" },
      { name: "김도윤", type: "employee" },
      { name: "보안솔루션팀", type: "department" },
    ],
    [],
  );
  eq(maskEntities("Product-C3 이거 말썽 많이 나?"), "{제품} 이거 말썽 많이 나?", "제품명 마스킹");
  eq(maskEntities("김도윤 요즘 보안솔루션팀 일 해?"), "{직원} 요즘 {부서} 일 해?", "사람, 부서 마스킹");
  eq(maskEntities("아무 개체 없음"), "아무 개체 없음", "개체 없으면 그대로");
}

// ── routeQuery 배선 (가짜 임베더) ─────────────────────────────────────
//
// 앵커 문장은 제 도구의 원핫으로, 질문은 표지어로 원핫을 돌려주는 임베더.
// 앵커의 도구를 표에서 직접 읽으므로 앵커 문구를 고쳐도 이 테스트는 깨지지 않는다.
const LANE_OF_ANCHOR = new Map<string, number>();
LANES.forEach((lane, i) => {
  for (const texts of Object.values(ROUTE_ANCHORS[lane])) for (const t of texts) LANE_OF_ANCHOR.set(t, i);
});
class MarkerEmbedder implements Embedder {
  readonly name = "marker";
  readonly dim = 3;
  async embed(text: string): Promise<number[]> {
    const i = LANE_OF_ANCHOR.get(text) ?? (/말썽/.test(text) ? 2 : /세팅/.test(text) ? 1 : 0);
    return [0, 1, 2].map((j) => (j === i ? 1 : 0));
  }
}
const marker = new MarkerEmbedder();
{
  uninstallSemanticRouter();
  ok(!semanticReady(), "설치 전에는 폴백 없음");
  const q = "Product-C3 이거 말썽 많이 나는 편이야?";
  eq(JSON.stringify(await routeQuery(q, marker)), JSON.stringify(route(q)), "폴백 미설치면 규칙 결정 그대로");

  const inst = await installSemanticRouter(marker);
  const total = Object.values(ROUTE_ANCHORS).reduce((n, t) => n + Object.values(t).reduce((m, x) => m + x.length, 0), 0);
  eq(inst.anchors, total, "앵커 전부 임베딩");

  // 규칙은 판단을 포기하는데(개체만 있음) 시맨틱은 그래프라고 본다.
  const r0 = route(q);
  ok(!r0.gate.confident, "규칙은 이 질문에 확신이 없다");
  const d = await routeQuery(q, marker);
  eq(d.route, "graph", "시맨틱 폴백이 그래프로 보낸다");
  eq(d.tools.includes(GRAPH_TOOL), true, "그래프 도구 호출");
  eq(d.semantic?.applied, true, "적용 표시");
  ok(/semantic knowledge_graph/.test(d.rationale), "근거에 시맨틱이 남는다");
  ok(d.graphPlan !== undefined, "그래프 탐색 계획이 붙는다");

  // 규칙이 확신하는 질문에는 폴백이 끼어들지 않는다.
  const sure = "Client-A가 사용 중인 제품 목록은?";
  eq(JSON.stringify(await routeQuery(sure, marker)), JSON.stringify(route(sure)), "확신 구간은 규칙 그대로");

  // 시맨틱도 박빙이면(모든 도구 동점) 규칙의 fan-out 을 유지한다.
  class Flat implements Embedder { readonly name = "flat"; readonly dim = 3; async embed() { return [1, 0, 0]; } }
  await installSemanticRouter(new Flat());
  const flat = await routeQuery("주문", new Flat());
  eq(flat.route, "hybrid", "시맨틱 박빙이면 fan-out 유지");
  eq(flat.tools, [SQL_TOOL, VECTOR_TOOL], "fan-out 도구 그대로");
  eq(flat.semantic?.applied, false, "판단은 남기되 적용 안 함");
  ok((flat.semantic?.margin ?? 1) < SEMANTIC_MIN_MARGIN, "박빙 격차");

  // 결정론: 같은 임베더, 같은 질문 -> 같은 결정.
  await installSemanticRouter(marker);
  const first = JSON.stringify(await routeQuery(q, marker));
  let stable = true;
  for (let i = 0; i < 20; i++) if (JSON.stringify(await routeQuery(q, marker)) !== first) stable = false;
  ok(stable, "routeQuery 20회 동일");

  // 임베딩 실패는 예외로 새지 않고 규칙만으로 도는 상태가 된다.
  class Broken implements Embedder { readonly name = "broken"; readonly dim = 3; async embed(): Promise<number[]> { throw new Error("ollama down"); } }
  const bad = await installSemanticRouter(new Broken());
  ok(bad.anchors === 0 && /ollama down/.test(bad.error ?? ""), "설치 실패는 상태로 보고");
  ok(!semanticReady(), "설치 실패 후 폴백 비활성");
  eq((await semanticVerdict(q, marker)), null, "비활성이면 판정 없음");
  uninstallSemanticRouter();
}

// ── route 도구 출력은 공개한 스키마를 통과한다 ──────────────────────────
//
// SDK 는 outputSchema 를 추가 필드 금지로 공개하고, 엄격한 클라이언트(MCP Inspector 2.8)는
// 스키마 밖의 필드가 하나라도 있으면 결과를 거부한다. 규칙 결정, 시맨틱 적용, 시맨틱 박빙 세
// 경우의 출력을 같은 엄격도로 검사한다.
{
  const strict = z.object(ROUTE_OUTPUT_SCHEMA).strict();
  await installSemanticRouter(marker);
  const outs = [
    routeToolOutput(route("Client-A가 사용 중인 제품 목록은?")),
    routeToolOutput(await routeQuery("Product-C3 이거 말썽 많이 나는 편이야?", marker)),
  ];
  class Flat2 implements Embedder { readonly name = "flat"; readonly dim = 3; async embed() { return [1, 0, 0]; } }
  await installSemanticRouter(new Flat2());
  outs.push(routeToolOutput(await routeQuery("주문", new Flat2())));
  uninstallSemanticRouter();
  const failures = outs.map((o) => strict.safeParse(o)).filter((r) => !r.success).map((r) => (r.success ? "" : r.error.issues[0]?.message));
  eq(failures, [], "route 출력 세 경우가 공개 스키마를 통과한다");
  ok(!strict.safeParse({ ...outs[0], surprise: 1 }).success, "스키마 밖의 필드는 거부된다(클라이언트와 같은 엄격도)");
}

// ── 평가는 서버와 같은 라우터 상태에서 돈다 ─────────────────────────────
//
// 서버는 기동 때 온톨로지와 시맨틱 앵커를 설치한다(routerinit.ts). 종단 평가 CLI 가 이것을
// 빼먹으면 규칙만 쓰는 경로를 재고, 그 수치가 서버의 수치인 척 문서에 실린다(2026-09-30 실제로
// 그랬다). companyx 평가 CLI 중 ask/retrieve/graphLane 을 부르는 파일은 initRouting 도 불러야 한다.
// graphLane 은 2026-10-01 에 더했다. KG 재현율 평가가 규칙만의 계획으로 1.0 을 내는 동안 서버는
// 사업자 예시 25번에서 빈손이었다.
{
  const here = dirname(fileURLToPath(import.meta.url));
  const cliDir = resolve(here, "../src/cli");
  if (existsSync(cliDir)) {
    const missing = readdirSync(cliDir)
      .filter((f) => /^companyx-.*\.ts$/.test(f))
      .filter((f) => {
        const src = readFileSync(resolve(cliDir, f), "utf8");
        return /\b(?:ask|retrieve|graphLane)\(/.test(src) && /from "\.\.\/pipeline\.js"/.test(src) && !/initRouting\(/.test(src);
      });
    eq(missing, [], "ask/retrieve/graphLane 을 부르는 companyx 평가 CLI 는 initRouting 을 부른다");
  } else {
    console.log("  SKIP: 평가 CLI 라우터 초기화 검사 (소스 없음)");
  }
}

console.log(`semroute.test: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
