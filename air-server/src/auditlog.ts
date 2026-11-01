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

// 감사 기록 파일 — AUDIT_LOG_FILE 을 주면 도구 호출마다 JSONL 한 줄을 덧붙인다. 기본은 끔.
//
// 감사 레코드는 응답으로만 돌아가고 서버에 쌓이지 않았다. 서버 로그(air jsonLogger)에는 도구, 시간, request_id 만 남아 누가 무엇을 물었고 어떤 SQL 이
// 돌았는지 나중에 볼 수 없었다. 이 파일은 그 자리를 채운다: 시각, 호출 주체, 질문, 갈래, 도구, 실행한 SQL, 거절한 SQL, 정책 판정, 못 찾은 이름.
//
// 조회 행은 넣지 않는다. 답과 컨텍스트에는 업무 데이터가 들어 있어 이 파일이 데이터 사본이 되면 안 된다. 질문 원문과 SQL 은 들어가므로 파일 권한은 소유자만이다(POSIX).
// 쓰기 실패는 stderr 경고만 내고 답에 영향을 주지 않는다. stdout 은 MCP stdio 프레이밍이라 여기서 쓰지 않는다.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AirPlugin } from "@airmcp-dev/core";
import type { AuditRecord } from "./auditrecord.js";

export interface AuditLogEntry {
  ts: string;
  tool: string;
  request_id: string | null;
  caller: { transport: string; os_user: string | null };
  query: string | null;
  /** 갈래(structured, semantic, graph, hybrid)와 그 갈래가 연 도구. 라우팅을 거치지 않는 도구는 null, []. */
  route: string | null;
  tools: string[];
  /** 실행한 SQL. 없으면 null. sql.query 는 받은 문장이다. */
  sql: string | null;
  sql_ok: boolean | null;
  /** 돌아온 행 수. 행 자체는 적지 않는다. */
  sql_rows: number | null;
  sql_error: string | null;
  /** 실행하지 않은 SQL: 생성 모델의 쓰기 문장, 지목한 이름을 뺀 문장(kind 는 sql.refused 의 종류), 실행 전 검사가 거부한 문장(kind 는 sql-trust-gate, reasons 는 사유). */
  sql_refused: { kind: string; text: string; reasons?: string[] }[];
  policies: { policy: string; verdict: string; detail: string }[];
  /** 질문이 지목했는데 데이터에서 못 찾은 이름. */
  not_found: string[];
  branch_errors: string[];
  duration_ms: number | null;
  /** 60초 캐시나 같은 호출 합치기(dedup)로 돌려준 호출이면 true. 이때 적힌 SQL 은 앞선 호출의 것이다. */
  cached: boolean;
  /** 도구가 실패로 끝났으면(입력 검증, 예외) 그 사유. 조회 행이 들 수 없는 머리 글만 적는다. */
  error: string | null;
}

/** 파이프라인을 도는 도구(ask, retrieve, audit.explain)의 핸들러가 결과 객체에 달아 두는 감사 레코드와 실행 전 검사가 거부한 문장. retrieve 의 응답에는 SQL 이 없고
 * 거부한 문장은 감사 레코드에 사유 글로만 있다. 응답에 더 싣지 않으려고 약한 지도에 둔다. */
const notes = new WeakMap<object, { record: AuditRecord; rejected: { sql: string; reasons: string[] }[] }>();
export function noteAudit<T extends object>(result: T, record: AuditRecord, rejected: { sql: string; reasons: string[] }[] = []): T {
  notes.set(result, { record, rejected });
  return result;
}

/** 도구 결과. 캐시 적중이면 air 가 응답 형식(content 배열)으로 넘겨 그 글을 읽는다. */
function plainResult(result: unknown): Record<string, unknown> {
  if (Array.isArray(result)) {
    const text = (result[0] as { text?: unknown } | undefined)?.text;
    if (typeof text !== "string") return {};
    try {
      const parsed: unknown = JSON.parse(text);
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    } catch {
      // 입력 검증 거절처럼 JSON 이 아닌 응답 글이다. 실패 표식으로 머리 글만 error 칸에 옮긴다.
      return { _text: text };
    }
  }
  return result && typeof result === "object" ? (result as Record<string, unknown>) : {};
}

const names = (nf: { query_entity?: unknown } | undefined | null) => (typeof nf?.query_entity === "string" ? [nf.query_entity] : []);

/** 호출 하나의 감사 줄. 순수 변환이다. 결과에서 정한 칸만 옮겨 조회 행, 답, 컨텍스트가 들어올 자리가 없다. */
export function auditLogEntry(
  call: { tool: string; params: Record<string, unknown>; result: unknown; requestId?: string; durationMs?: number; cached?: boolean; error?: string },
  caller: { transport: string; os_user: string | null },
  now = new Date(),
): AuditLogEntry {
  const res = plainResult(call.result);
  const noted = call.result && typeof call.result === "object" ? notes.get(call.result as object) : undefined;
  // ask 는 audit 칸에, audit.explain 은 맨 위에 레코드가 있다. retrieve 는 핸들러가 달아 둔다. 캐시 적중한 retrieve 의 audit 칸은 레코드가 아니다.
  const embedded = (res.audit && typeof res.audit === "object" && "schema" in (res.audit as object) ? res.audit : "schema" in res ? res : undefined) as AuditRecord | undefined;
  const rec = noted?.record ?? embedded;
  const pipelineAudit = (res.audit ?? {}) as { branch_errors?: unknown; not_found?: { query_entity?: unknown }; missing_entities?: { query_entity?: unknown }[]; route?: { tools?: unknown } };
  const direct = typeof call.params.sql === "string" ? call.params.sql : null;
  const sqlRec = rec?.retrieval.sql;
  const notFound = rec
    ? [...new Set([...names(rec.not_found), ...(rec.missing_entities ?? []).flatMap(names)])]
    : [...new Set([...names(pipelineAudit.not_found), ...(pipelineAudit.missing_entities ?? []).flatMap(names), ...names(res.not_found as { query_entity?: unknown } | undefined)])];
  const failedText = typeof res._text === "string" ? res._text.split("\n")[0].slice(0, 200) : null;
  return {
    ts: now.toISOString(),
    tool: call.tool,
    request_id: call.requestId ?? null,
    caller,
    query: typeof call.params.query === "string" ? call.params.query : null,
    route: typeof res.route === "string" ? res.route : (rec?.routing.lane ?? null),
    tools: rec?.routing.tools ?? (Array.isArray(pipelineAudit.route?.tools) ? (pipelineAudit.route.tools as string[]) : Array.isArray(res.tools) ? (res.tools as string[]) : []),
    sql: sqlRec?.text ?? direct,
    sql_ok: sqlRec ? sqlRec.ok : direct !== null && typeof res.ok === "boolean" ? res.ok : null,
    sql_rows: sqlRec ? sqlRec.rows : direct !== null && typeof res.rowCount === "number" ? res.rowCount : null,
    sql_error: sqlRec?.error ?? (direct !== null && typeof res.error === "string" ? res.error : null),
    sql_refused: [
      ...(sqlRec?.refused ? [{ kind: sqlRec.refused.kind, text: sqlRec.refused.text }] : []),
      ...(noted?.rejected ?? []).map((r) => ({ kind: "sql-trust-gate", text: r.sql, reasons: r.reasons })),
    ],
    policies: (rec?.policies ?? []).map((p) => ({ policy: p.policy, verdict: p.verdict, detail: p.detail })),
    not_found: notFound,
    branch_errors: rec?.branch_errors ?? (Array.isArray(pipelineAudit.branch_errors) ? (pipelineAudit.branch_errors as string[]) : []),
    duration_ms: call.durationMs ?? null,
    cached: Boolean(call.cached),
    error: call.error ?? failedText,
  };
}

/** AUDIT_LOG_FILE 의 경로. 비었으면 끈다. */
export function auditLogPath(): string | undefined {
  return process.env.AUDIT_LOG_FILE?.trim() || undefined;
}

/** 파일 끝에 한 줄을 덧붙인다. 실패하면 stderr 에 경고만 낸다(같은 사유는 다시 찍지 않고, 다시 성공하면 잊는다). */
export function auditLogWriter(path: string): (entry: AuditLogEntry) => void {
  let warned: string | null = null;
  let dirReady = false;
  return (entry) => {
    try {
      if (!dirReady) {
        mkdirSync(dirname(path), { recursive: true });
        dirReady = true;
      }
      appendFileSync(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
      warned = null;
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      if (why !== warned) {
        warned = why;
        console.error(`[audit] 감사 기록 파일에 쓰지 못했다(답에는 영향 없음): ${why}`);
      }
    }
  };
}

/** 호출마다 감사 줄을 남기는 air 플러그인. use 의 앞쪽에 둔다: air 는 캐시 적중과 입력 검증 거절에도 after 를 돌린다. */
export function auditLogPlugin(path: string, caller: () => { transport: string; os_user: string | null }): AirPlugin {
  const write = auditLogWriter(path);
  const entry = (ctx: { tool: { name: string }; params: Record<string, unknown>; requestId?: string; meta?: Record<string, unknown>; duration?: number; result?: unknown }, error?: string) =>
    auditLogEntry({ tool: ctx.tool.name, params: ctx.params, result: ctx.result, requestId: ctx.requestId, durationMs: ctx.duration, cached: Boolean(ctx.meta?._cached || ctx.meta?._deduped), error }, caller());
  return {
    meta: { name: "onprem:audit-log" },
    middleware: [
      {
        name: "onprem:audit-log",
        after: async (ctx) => write(entry(ctx)),
        onError: async (ctx, error) => {
          write(entry(ctx, error.name || "Error"));
          return undefined;
        },
      },
    ],
  };
}
