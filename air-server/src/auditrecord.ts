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
import type { GraphTruncation } from "./graph.js";
import type { NotFound } from "./notfound.js";
import { sqlGatePolicy } from "./sqltrust.js";
import { NO_TABLE } from "./nl2sql.js";

export interface PolicyVerdict {
  /** 정책 이름. 코드에서 실제로 강제하는 것과 1:1 대응한다. */
  policy: "sql-read-only" | "sql-repair" | "sql-trust-gate" | "graph-unresolved-gate" | "context-budget" | "branch-isolation";
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
    sql: {
      text: string | null;
      ok: boolean | null;
      rows: number | null;
      error: string | null;
      repaired: boolean;
      /** 생성 모델이 만들었지만 실행하지 않은 문장. 그때만 붙고 text 는 null 이다. */
      refused?: { kind: string; text: string };
      /** 질문이 묻는 항목이 스키마에 없어 SQL 을 만들지 않았을 때 그 항목. 그때만 붙는다. */
      absent?: string;
    };
    vector: { hits: number | null };
    graph: { strategy: string | null; seeds: number | null; edges: number | null; truncated: GraphTruncation | null };
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
  /** 답변이 있을 때만. 컨텍스트 밖 개체를 답이 언급했는지. fixed 는 생성 답의 근거 밖 이름을 목록에서 뺐거나(removed) 근거에 없다고
   * 밝힌(flagged) 내역이다(pipeline.ts withoutOutsideNames). 그런 이름이 있었을 때만 붙는다. */
  grounding?: {
    checked: boolean;
    answer_chars: number;
    outside_context: string[];
    fixed?: { removed: string[]; flagged: string[] };
  };
  /** 미해소 개체 게이트가 발동했을 때만. 왜 못 찾았는지. */
  not_found?: NotFound;
  /** 섞인 질문에서 일부 개체만 해소됐을 때만. 해소되지 않은 이름마다 왜 못 찾았는지. */
  missing_entities?: NotFound[];
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

/**
 * 저장소에 커밋할 산출물에서 사업자 문서 본문을 가린다.
 *
 * 배포 조건이 "대회 목적 사용 한정, 재배포 금지" 이므로 문서 본문을 공개
 * 저장소에 남기면 형태만 다른 재배포다. 실제로 `eval/results/companyx-audit.json`
 * 이 `fusion[].preview` 로 본문 28줄을 담고 있었다(2026-08-17 실측).
 *
 * ★ 런타임 preview 는 지운다는 뜻이 아니다.
 *   호스트가 무엇이 융합됐는지 보는 것은 이 제품의 가치다. 가리는 것은 **파일로
 *   남길 때**뿐이고, 대신 길이와 해시 앞자리를 남겨 재현·대조는 계속 가능하다.
 */
export function redactForPublication(record: AuditRecord): AuditRecord {
  return {
    ...record,
    fusion: record.fusion.map((f) => ({
      ...f,
      preview: `[본문 비공개 — ${f.preview.length}자, sha256:${fingerprint(f.preview).slice(0, 12)}]`,
    })),
  };
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
  } else if (r.sql.refused) {
    // 실행하지 않은 생성 문장도 거부 판정으로 남긴다. 종전에는 조용히 버려 감사 레코드에 흔적이 없었다.
    policies.push({
      policy: "sql-read-only",
      verdict: "deny",
      detail:
        r.sql.refused.kind === NO_TABLE
          ? "생성 모델이 테이블을 읽지 않는 SELECT 를 만들어 실행하지 않았다(데이터와 무관한 상수)"
          : `생성 모델이 쓰기 문장(${r.sql.refused.kind})을 만들어 실행하지 않았다`,
    });
  } else if (r.sql.absent) {
    policies.push({
      policy: "sql-read-only",
      verdict: "deny",
      detail: `질문의 항목(${r.sql.absent})이 데이터 스키마에 없어 SQL 을 만들지 않았다(없는 열을 다른 열로 바꿔 답하지 않음)`,
    });
  }

  // 1-1) 실행 전 검사(외래키 조인, 질문에 없는 id 번호). 거부한 것이 있을 때만.
  const gate = sqlGatePolicy(r.sql.gate);
  if (gate) policies.push(gate);

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
    const nf = r.graph.not_found;
    const why = nf
      ? ` — 사유 ${nf.reason}: ${nf.query_entity}` +
        (nf.candidates.length ? ` (비슷한 이름: ${nf.candidates.map((c) => c.name).join(", ")})` : "")
      : "";
    policies.push({
      policy: "graph-unresolved-gate",
      verdict: "deny",
      detail: `질의가 지목한 개체를 온톨로지에서 해소하지 못해 근거를 비우고, 찾지 못한 사유 한 줄만 컨텍스트에 남겼다(환각 차단)${why}`,
    });
  } else if (r.missing?.length) {
    // 섞인 질문: 찾은 개체로는 답하되, 없는 개체는 사유를 컨텍스트와 답 앞에 싣는다.
    const names = r.missing.map((nf) => `${nf.query_entity}: ${nf.reason}`).join(", ");
    policies.push({
      policy: "graph-unresolved-gate",
      verdict: "degrade",
      detail:
        `질의가 지목한 개체 일부를 온톨로지에서 해소하지 못했다(${names}). 그 사유를 컨텍스트와 답 앞에 싣고, ` +
        `찾은 개체의 근거로만 「${r.answer_query ?? r.query}」에 답했다(없는 개체에 찾은 개체의 사실을 붙이지 않음)`,
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
    // rrfMerge 는 출처를 입력 목록 번호로 적는다. 번호만으로는 어느 레인인지 읽을 수 없어
    // 파이프라인이 넘긴 목록별 레인 이름으로 바꾼다. 이름이 없으면 번호를 그대로 둔다.
    sources: (f.sources ?? []).map((i) => r.fusion_lanes?.[i] ?? String(i)),
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
        ...(r.sql.refused ? { refused: r.sql.refused } : {}),
        ...(r.sql.absent ? { absent: r.sql.absent } : {}),
      },
      vector: { hits: r.vector?.ok ? r.vector.hits.length : null },
      graph: {
        strategy: r.graph?.strategy ?? null,
        seeds: r.graph?.seeds?.length ?? null,
        edges: r.graph?.edgeCount ?? null,
        truncated: r.graph?.truncated ?? null,
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

  if (r.not_found) record.not_found = r.not_found;
  if (r.missing?.length) record.missing_entities = r.missing;

  if (answer !== undefined) {
    const fixed = "grounding_fix" in r ? r.grounding_fix : undefined;
    record.grounding = {
      checked: true,
      answer_chars: answer.length,
      outside_context: outsideContextMentions(answer, r.context),
      ...(fixed ? { fixed } : {}),
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
    `SQL: ${rec.retrieval.sql.text ? `${rec.retrieval.sql.ok ? "실행" : "거부"}${rec.retrieval.sql.repaired ? " (1회 교정)" : ""}` : rec.retrieval.sql.refused ? `실행 안 함(생성 문장 ${rec.retrieval.sql.refused.kind})` : rec.retrieval.sql.absent ? `만들지 않음(없는 항목 ${rec.retrieval.sql.absent})` : "해당 없음"}`,
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
    const f = rec.grounding.fixed;
    if (f?.removed.length) lines.push(`접지 보정: 생성 답의 근거 밖 이름을 목록에서 뺐다(${f.removed.join(", ")})`);
    if (f?.flagged.length) lines.push(`접지 보정: 생성 답의 근거 밖 이름을 답 끝에 밝혔다(${f.flagged.join(", ")})`);
  }
  return lines.join("\n");
}
