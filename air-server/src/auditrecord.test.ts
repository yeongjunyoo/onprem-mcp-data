// 감사 레코드 테스트. 데이터베이스도 모델도 없이 돈다 — 순수 변환이므로 가짜 결과를 넣는다.
//
// 여기서 지키려는 계약 셋.
//   1. 정책 판정은 실제로 일어난 것만 기록한다. 없는 정책을 지어내지 않는다.
//   2. 지문은 결정론 구간만 덮는다. 답변이 달라져도 지문은 같아야 한다.
//   3. 접지 검사는 컨텍스트 밖 개체를 잡아낸다.
import { buildAuditRecord, outsideContextMentions, renderAudit } from "./auditrecord.js";
import type { AskResult, RetrieveResult } from "./pipeline.js";

let pass = 0,
  fail = 0;
function ok(cond: boolean, msg: string) {
  if (cond) pass++;
  else {
    fail++;
    console.error("  FAIL:", msg);
  }
}

function base(over: Partial<RetrieveResult> = {}): RetrieveResult {
  const curated = { kept: [], dropped: [], tokensUsed: 40, budget: 256, brokenRows: 0, notes: [] };
  return {
    query: "Client-A의 계약 건수는?",
    route: "structured",
    sql: { text: "SELECT count(*) FROM companyx.contracts", result: undefined, repaired: false },
    fused: [],
    curated,
    context: "[SQL 결과] → count=3",
    audit: {
      route: {
        route: "structured",
        lane: "관계형",
        tools: ["sql.query"],
        structured_signals: ["계약", "건수"],
        semantic_signals: [],
        graph_signals: [],
        rationale: "집계 어휘가 관계형 레인을 지시",
        deterministic: true,
      },
      candidates: { sql: 1, vector: 0, graph: 0, fused: 1 },
      branch_errors: [],
      curate: { kept: ["sql#0"], dropped: [], tokens_used: 40, budget: 256, broken_rows: 0, structure_preserved: true },
    },
    ...over,
  } as unknown as RetrieveResult;
}

function main() {
  // --- 1. 성공 경로: 허용 정책만 남는다 ---
  const okSql = base({
    sql: {
      text: "SELECT count(*) FROM companyx.contracts",
      result: { ok: true, rows: [{ count: 3 }], rowCount: 1, columns: ["count"], truncated: false },
      repaired: false,
    },
  } as Partial<RetrieveResult>);
  const r1 = buildAuditRecord(okSql);
  ok(r1.schema === "onprem-mcp-data/audit/v1", "스키마 버전을 박는다");
  ok(r1.policies.some((p) => p.policy === "sql-read-only" && p.verdict === "allow"), "성공한 SQL은 allow");
  ok(!r1.policies.some((p) => p.verdict === "deny"), "일어나지 않은 거부를 지어내지 않는다");
  ok(r1.routing.deterministic === true, "라우팅이 결정론임을 명시한다");
  ok(r1.grounding === undefined, "답변이 없으면 접지 절이 없다");

  // --- 2. 거부 경로: 사유가 함께 기록된다 ---
  const denied = buildAuditRecord(
    base({
      sql: {
        text: "SELECT is_active FROM companyx.contracts",
        result: { ok: false, rows: [], rowCount: 0, columns: [], truncated: false, error: 'column "is_active" does not exist' },
        repaired: false,
      },
    } as Partial<RetrieveResult>),
  );
  const deny = denied.policies.find((p) => p.policy === "sql-read-only");
  ok(deny?.verdict === "deny", "실패한 SQL은 deny");
  ok(Boolean(deny && deny.detail.includes("is_active")), "거부 사유에 원인이 남는다");

  // --- 3. 재시도와 미해소 게이트 ---
  const repaired = buildAuditRecord(
    base({
      sql: {
        text: "SELECT status FROM companyx.contracts",
        result: { ok: true, rows: [], rowCount: 0, columns: [], truncated: false },
        repaired: true,
      },
    } as Partial<RetrieveResult>),
  );
  ok(repaired.policies.some((p) => p.policy === "sql-repair" && p.verdict === "repair"), "교정을 기록한다");

  const gated = buildAuditRecord(
    base({
      route: "graph",
      graph: { strategy: "unresolved", seeds: [], edgeCount: 0, items: [] },
    } as unknown as Partial<RetrieveResult>),
  );
  const gate = gated.policies.find((p) => p.policy === "graph-unresolved-gate");
  ok(gate?.verdict === "deny", "미해소 개체 게이트를 deny로 기록한다");
  ok(Boolean(gate && gate.detail.includes("환각")), "게이트의 목적을 사유에 적는다");
  // 게이트는 근거를 비우지만 찾지 못한 사유 한 줄을 컨텍스트에 남긴다(context.items 1).
  // 사유문이 「0건」이라고 하면 같은 레코드 안에서 모순이다(2026-10-06 리허설).
  ok(Boolean(gate && !gate.detail.includes("0건") && gate.detail.includes("사유 한 줄")), "게이트 사유문이 남은 안내 한 줄과 맞다");

  // 못 찾은 이유가 있으면 판정 사유와 레코드 필드 둘 다에 남는다.
  const notFound = {
    reason: "similar_name_mismatch" as const,
    query_entity: "클라우드사업팀",
    candidates: [{ name: "클라우드사업부", type: "department", score: 0.857 }],
  };
  const gatedWhy = buildAuditRecord(
    base({
      route: "graph",
      graph: { strategy: "unresolved", seeds: [], edgeCount: 0, items: [], not_found: notFound },
      not_found: notFound,
    } as unknown as Partial<RetrieveResult>),
  );
  const why = gatedWhy.policies.find((p) => p.policy === "graph-unresolved-gate");
  ok(Boolean(why?.detail.includes("클라우드사업부")), "판정 사유가 비슷한 이름 후보를 말한다");
  ok(gatedWhy.not_found?.reason === "similar_name_mismatch", "레코드에 not_found 가 실린다");
  ok(gated.not_found === undefined && gated.retrieval.graph.truncated === null, "사유·잘림이 없으면 필드도 없다");

  // --- 4. 브랜치 격리 ---
  const degraded = buildAuditRecord(
    base({ audit: { ...base().audit, branch_errors: ["vector: timeout"] } } as unknown as Partial<RetrieveResult>),
  );
  ok(
    degraded.policies.some((p) => p.policy === "branch-isolation" && p.verdict === "degrade"),
    "레인 실패를 degrade로 기록한다",
  );

  // --- 5. 지문은 결정론 구간만 덮는다 ---
  const withAnswerA = { ...okSql, answer: "계약은 3건입니다." } as AskResult;
  const withAnswerB = { ...okSql, answer: "총 3건의 계약이 있습니다." } as AskResult;
  const fa = buildAuditRecord(withAnswerA);
  const fb = buildAuditRecord(withAnswerB);
  ok(fa.routing_fingerprint === fb.routing_fingerprint, "답변 문구가 달라도 규칙 지문은 같다");
  ok(fa.pipeline_fingerprint === fb.pipeline_fingerprint, "답변 문구는 파이프라인 지문에도 안 들어간다");
  const different = buildAuditRecord(base({ query: "다른 질의" }));
  ok(different.routing_fingerprint !== fa.routing_fingerprint, "질의가 다르면 규칙 지문이 다르다");
  ok(/^[0-9a-f]{8}$/.test(fa.routing_fingerprint), "지문은 8자리 16진수");
  // 모델이 만든 SQL이 달라지면 파이프라인 지문만 달라져야 한다.
  // 이 분리가 무엇이 결정론인지를 정확히 말해 준다.
  const sqlA = buildAuditRecord(base({ sql: { text: "SELECT 1", result: undefined, repaired: false } } as never));
  const sqlB = buildAuditRecord(base({ sql: { text: "SELECT 2", result: undefined, repaired: false } } as never));
  ok(sqlA.routing_fingerprint === sqlB.routing_fingerprint, "SQL이 달라도 규칙 지문은 같다");
  ok(sqlA.pipeline_fingerprint !== sqlB.pipeline_fingerprint, "SQL이 다르면 파이프라인 지문은 다르다");

  // --- 6. 접지 검사 ---
  const grounded = buildAuditRecord({ ...okSql, answer: "Client-A는 3건입니다." } as AskResult);
  ok(grounded.grounding?.checked === true, "답변이 있으면 접지를 검사한다");
  ok((grounded.grounding?.outside_context ?? []).includes("Client-A"), "컨텍스트에 없는 개체를 잡아낸다");

  const clean = buildAuditRecord({
    ...base({ context: "[SQL 결과] Client-A → count=3" }),
    answer: "Client-A는 3건입니다.",
  } as AskResult);
  ok((clean.grounding?.outside_context ?? []).length === 0, "컨텍스트에 있으면 위반이 아니다");

  ok(outsideContextMentions("Product-C1과 Product-C2", "Product-C1만 있음").join() === "Product-C2", "식별자 단위로 판정");

  // --- 7. 융합 출처는 레인 이름으로 ---
  // rrfMerge 의 sources 는 입력 목록 번호다. 레코드가 「0」, 「1」을 그대로 적으면 어느 레인이
  // 찾았는지 읽을 수 없다(2026-10-06 리허설에서 fusion[].sources 가 ["0"]).
  const fusedRec = buildAuditRecord(
    base({
      fused: [{ key: "documents#7", value: { kind: "chunk", text: "장애 보고서", source: "documents#7" }, score: 0.0325, sources: [1, 2] }],
      fusion_lanes: ["sql", "vector", "keyword"],
    } as unknown as Partial<RetrieveResult>),
  );
  ok(
    JSON.stringify(fusedRec.fusion[0]?.sources) === '["vector","keyword"]',
    `융합 출처를 레인 이름으로 적는다 (got ${JSON.stringify(fusedRec.fusion[0]?.sources)})`,
  );

  // --- 8. 사람이 읽는 요약 ---
  const text = renderAudit(denied);
  ok(text.includes("정책 sql-read-only: deny"), "요약에 정책 판정이 나온다");
  ok(text.split("\n").length <= 12, "요약은 열 줄 안쪽");

  console.log(`\nauditrecord.test: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main();
