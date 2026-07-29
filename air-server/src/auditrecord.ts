// 감사 레코드 — 한 번의 호출에서 무엇을 근거로 무엇을 판단했는지 기계가 읽을 형태로.
//
// 왜 필요한가. 이 서버는 답만 내놓지 않는다. 어떤 레인을 쓸지 고르고, SQL을 거부하고,
// 개체를 해소하지 못하면 컨텍스트를 비운다. 그 **판단**들이 지금까지는 로그로만
// 흘러갔다. 제3자가 "왜 이 답이 나왔고 무엇이 거부됐는가"를 확인하려면 코드를 읽어야
// 했다는 뜻이다.
//
// 공개된 데이터베이스 MCP 서버들을 살펴봐도 호출마다 근거와 정책 판정을 하나로 묶어
// 내보내는 사례를 찾지 못했다(R6 정찰 K7). 그래서 여기서 만든다.
//
// 설계 원칙 셋.
//   1. 순수 변환이다. 이 모듈은 파이프라인 결과를 읽어 레코드를 만들 뿐 아무것도 실행하지 않는다.
//   2. 모델 출력과 결정론 부분을 분리한다. 답변 텍스트를 뺀 나머지는 같은 질의에 대해 항상 같다.
//   3. 정책은 "거부했다"가 아니라 "무엇을, 왜"까지 적는다. 사유 없는 거부 기록은 감사에 쓸모가 없다.
import type { AskResult, RetrieveResult } from "./pipeline.js";

export interface PolicyVerdict {
  /** 정책 이름. 코드에서 실제로 강제하는 것과 1:1 대응한다. */
  policy: "sql-read-only" | "sql-repair" | "graph-unresolved-gate" | "context-budget" | "branch-isolation";
  /** allow = 통과, deny = 차단, repair = 고쳐서 통과, degrade = 일부만 살림 */
  verdict: "allow" | "deny" | "repair" | "degrade";
  detail: string;
}

export interface AuditRecord {
  schema: "onprem-mcp-data/audit/v1";
  query: string;
  /**
   * 규칙 구간의 지문. 라우팅 결정과 발동한 정책 종류만 덮는다.
   * 모델이 만든 것(SQL 문자열, 답변)은 들어가지 않으므로 같은 질의에서 항상 같아야 한다.
   */
  routing_fingerprint: string;
  /**
   * 파이프라인 전체 지문. 모델이 만든 SQL과 융합 결과까지 덮는다.
   * 로컬 7B는 실행마다 흔들릴 수 있어 이 값은 같지 않을 수 있다.
   * 두 지문을 나눈 이유가 이것이다. 무엇이 결정론이고 무엇이 아닌지를 구분해서 보여 준다.
   */
  pipeline_fingerprint: string;
  routing: {
    lane: string;
    tools: string[];
    signals: { structured: string[]; semantic: string[]; graph: string[] };
    rationale: string;
    deterministic: true;
  };
  retrieval: {
    sql: { text: string | null; ok: boolean | null; rows: number | null; error: string | null; repaired: boolean };
    vector: { hits: number | null };
    graph: { strategy: string | null; seeds: number | null; edges: number | null };
    candidates: { sql: number; vector: number; graph: number; fused: number };
  };
  /** 융합 결과 상위 항목. 어떤 소스들이 합의했는지가 핵심이다. */
  fusion: { key: string; score: number; sources: string[]; preview: string }[];
  context: {
    items: number;
    chars: number;
    budget_tokens: number | null;
    tokens_used: number | null;
    broken_rows: number | null;
  };
  policies: PolicyVerdict[];
  /** 답변이 있을 때만. 컨텍스트 밖 개체를 답이 언급했는지. */
  grounding?: { checked: boolean; answer_chars: number; outside_context: string[] };
  branch_errors: string[];
  generated_at: string;
}

/** 결정론 지문. 답변과 시각을 뺀 나머지를 안정 직렬화해 해시한다. */
function fingerprint(parts: unknown): string {
  const json = JSON.stringify(parts);
  // FNV-1a 32비트. 암호학적 용도가 아니라 "같은 입력인가"를 눈으로 보기 위한 것이다.
  let h = 0x811c9dc5;
  for (let i = 0; i < json.length; i++) {
    h ^= json.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** 답변이 컨텍스트 밖 고유명사를 만들었는지. 대문자 시작 식별자와 한글 고유명 후보만 본다. */
export function outsideContextMentions(answer: string, context: string): string[] {
  const candidates = new Set<string>();
  for (const m of answer.match(/[A-Z][A-Za-z]*-[A-Z0-9]+/g) ?? []) candidates.add(m); // Client-A, Product-C1
  for (const m of answer.match(/[가-힣]{2,4}(?=\s*(씨|님|과장|대리|부장|팀장))/g) ?? []) candidates.add(m);
  return [...candidates].filter((c) => !context.includes(c));
}

export function buildAuditRecord(r: RetrieveResult | AskResult): AuditRecord {
  const a = r.audit;
  const routeAudit = a.route as Record<string, unknown>;
  const answer = "answer" in r ? r.answer : undefined;

  const policies: PolicyVerdict[] = [];

  // 1) 읽기 전용 SQL 가드
  if (r.sql.text) {
    if (r.sql.result?.ok) {
      policies.push({
        policy: "sql-read-only",
        verdict: "allow",
        detail: `읽기 전용 트랜잭션에서 실행, ${r.sql.result.rowCount}행 반환`,
      });
    } else {
      policies.push({
        policy: "sql-read-only",
        verdict: "deny",
        detail: `엔진 또는 가드가 거부: ${r.sql.result?.error ?? "사유 미기록"}`,
      });
    }
  }

  // 2) 자기 수정 재시도
  if (r.sql.repaired) {
    policies.push({
      policy: "sql-repair",
      verdict: "repair",
      detail: "거부된 SQL을 데이터베이스 카탈로그와 함께 1회 되먹여 교정했다",
    });
  }

  // 3) 미해소 개체 게이트
  if (r.graph?.strategy === "unresolved") {
    policies.push({
      policy: "graph-unresolved-gate",
      verdict: "deny",
      detail: "질의가 지목한 개체를 온톨로지에서 해소하지 못해 컨텍스트를 0건으로 만들었다(환각 차단)",
    });
  }

  // 4) 컨텍스트 예산
  const curate = a.curate;
  const dropped = curate?.dropped?.length ?? 0;
  if (dropped > 0) {
    policies.push({
      policy: "context-budget",
      verdict: "degrade",
      detail: `토큰 예산으로 후보 ${dropped}건을 잘랐다`,
    });
  }

  // 5) 브랜치 격리
  if (a.branch_errors.length) {
    policies.push({
      policy: "branch-isolation",
      verdict: "degrade",
      detail: `레인 ${a.branch_errors.length}개가 실패했으나 나머지 결과로 응답했다: ${a.branch_errors.join("; ")}`,
    });
  }

  const fusion = r.fused.slice(0, 10).map((f) => ({
    key: f.key,
    score: Number(f.score.toFixed(6)),
    sources: (f as unknown as { sources?: number[] }).sources?.map(String) ?? [],
    preview: String(f.value.text ?? "").slice(0, 120),
  }));

  // 규칙 구간: 라우팅과 정책 종류. 모델 출력이 섞이지 않는다.
  const ruleCore = {
    query: r.query,
    routing: routeAudit,
    policies: policies.map((p) => [p.policy, p.verdict]),
  };
  // 전체 구간: 모델이 만든 SQL과 융합 결과까지.
  const pipelineCore = {
    ...ruleCore,
    sql: r.sql.text,
    fusion: fusion.map((f) => [f.key, f.score]),
    context_chars: r.context.length,
    context_items: r.curated.kept.length,
  };

  const record: AuditRecord = {
    schema: "onprem-mcp-data/audit/v1",
    query: r.query,
    routing_fingerprint: fingerprint(ruleCore),
    pipeline_fingerprint: fingerprint(pipelineCore),
    routing: {
      lane: String(routeAudit.lane ?? r.route),
      tools: (routeAudit.tools as string[]) ?? [],
      signals: {
        structured: (routeAudit.structured_signals as string[]) ?? [],
        semantic: (routeAudit.semantic_signals as string[]) ?? [],
        graph: (routeAudit.graph_signals as string[]) ?? [],
      },
      rationale: String(routeAudit.rationale ?? ""),
      deterministic: true,
    },
    retrieval: {
      sql: {
        text: r.sql.text,
        ok: r.sql.result ? r.sql.result.ok : null,
        rows: r.sql.result ? r.sql.result.rowCount : null,
        error: r.sql.result?.error ?? null,
        repaired: Boolean(r.sql.repaired),
      },
      vector: { hits: r.vector?.ok ? r.vector.hits.length : null },
      graph: {
        strategy: r.graph?.strategy ?? null,
        seeds: r.graph?.seeds?.length ?? null,
        edges: r.graph?.edgeCount ?? null,
      },
      candidates: a.candidates,
    },
    fusion,
    context: {
      items: r.curated.kept.length,
      chars: r.context.length,
      budget_tokens: curate?.budget ?? null,
      tokens_used: curate?.tokens_used ?? null,
      // 큐레이터의 계약: 행 구조를 깨지 않는다. 0이 아니면 계약 위반이다.
      broken_rows: curate?.broken_rows ?? null,
    },
    policies,
    branch_errors: a.branch_errors,
    generated_at: new Date().toISOString(),
  };

  if (answer !== undefined) {
    record.grounding = {
      checked: true,
      answer_chars: answer.length,
      outside_context: outsideContextMentions(answer, r.context),
    };
  }

  return record;
}

/** 사람이 읽는 요약. 감사 레코드를 열 줄 안쪽으로 줄인다. */
export function renderAudit(rec: AuditRecord): string {
  const lines = [
    `질의: ${rec.query}`,
    `지문: 규칙 ${rec.routing_fingerprint} / 파이프라인 ${rec.pipeline_fingerprint}`,
    `라우팅: ${rec.routing.lane} -> ${rec.routing.tools.join(", ") || "없음"} (${rec.routing.rationale})`,
    `SQL: ${rec.retrieval.sql.text ? `${rec.retrieval.sql.ok ? "실행" : "거부"}${rec.retrieval.sql.repaired ? " (1회 교정)" : ""}` : "해당 없음"}`,
    `후보: sql ${rec.retrieval.candidates.sql} / vector ${rec.retrieval.candidates.vector} / graph ${rec.retrieval.candidates.graph} -> 융합 ${rec.retrieval.candidates.fused}`,
    `컨텍스트: ${rec.context.items}항목 ${rec.context.chars}자`,
  ];
  for (const p of rec.policies) lines.push(`정책 ${p.policy}: ${p.verdict} — ${p.detail}`);
  if (rec.grounding) {
    lines.push(
      rec.grounding.outside_context.length
        ? `접지 위반: ${rec.grounding.outside_context.join(", ")}`
        : "접지: 답변의 개체가 모두 컨텍스트 안에 있다",
    );
  }
  return lines.join("\n");
}
