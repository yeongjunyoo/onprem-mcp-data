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

// 감사 기록 파일(AUDIT_LOG_FILE). DB 없이 잰다.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";

import { auditLogEntry, auditLogPath, auditLogPlugin, auditLogWriter, noteAudit, type AuditLogEntry } from "./auditlog.js";
import { buildAuditRecord } from "./auditrecord.js";
import type { Embedder } from "./embedder.js";
import { ask } from "./pipeline.js";
import { failedToolResult } from "./server.js";

let passed = 0;
let failed = 0;
function ok(cond: unknown, label: string) {
  if (cond) passed++;
  else {
    failed++;
    console.error(`  FAIL: ${label}`);
  }
}

const SECRET_ROW = "비밀행값-연봉9520";
const caller = { transport: "stdio", os_user: "tester" };
const dir = mkdtempSync(join(tmpdir(), "auditlog-"));
const file = join(dir, "sub", "audit.jsonl");

// 파이프라인 결과로 만든다(가짜 레코드가 아니라 진짜 분기). 표 갈래, 행이 하나.
const embedder: Embedder = { name: "test:unused", dim: 8, embed: async () => new Array(8).fill(0) };
const pool = {
  connect: async () => ({
    query: async (sql: string) => {
      const r = /^\s*(select|with)\b/i.test(sql) && !/pg_roles/.test(sql) ? [{ name: SECRET_ROW }] : [];
      return { rows: r, rowCount: r.length, fields: [{ name: "name" }] };
    },
    release: () => {},
  }),
  query: async () => ({ rows: [], rowCount: 0 }),
} as unknown as Pool;
const sql = "SELECT name FROM employees WHERE salary > 9000";
const r = await ask("연봉이 9000 넘는 직원은 누구야?", { pool, embedder, repair: false, nl2sql: async () => sql, llm: async () => `답은 ${SECRET_ROW}` });
const record = buildAuditRecord(r);
const askResult = noteAudit({ answer: r.answer, route: r.route, context: r.context, audit: record }, record);

{
  const e = auditLogEntry({ tool: "ask", params: { query: "연봉이 9000 넘는 직원은 누구야?" }, result: askResult, requestId: "req-1", durationMs: 12 }, caller, new Date("2026-11-02T00:00:00.000Z"));
  ok(e.ts === "2026-11-02T00:00:00.000Z" && e.tool === "ask" && e.request_id === "req-1", "시각, 도구, 요청 번호");
  ok(e.caller.transport === "stdio" && e.caller.os_user === "tester", "호출 주체");
  ok(e.query === "연봉이 9000 넘는 직원은 누구야?", "질문");
  ok(e.route === r.route && Array.isArray(e.tools) && e.tools.length > 0, "갈래와 도구");
  ok(e.sql === sql && e.sql_ok === true && e.sql_rows === 1, `실행한 SQL 과 행 수 (got ${e.sql} ${e.sql_ok} ${e.sql_rows})`);
  ok(e.policies.some((p) => p.policy === "sql-read-only" && p.verdict === "allow"), "정책 판정");
  ok(e.duration_ms === 12 && e.cached === false && e.error === null, "시간, 캐시, 오류");
  ok(!JSON.stringify(e).includes(SECRET_ROW), "조회 행, 답, 컨텍스트가 들어가지 않는다");
}

// retrieve: 응답에 SQL 이 없어도 핸들러가 달아 둔 레코드로 적는다. 달아 두지 않은 캐시 적중은 SQL 을 지어내지 않는다.
{
  const retrieveResult = noteAudit({ route: r.route, context: r.context, audit: r.audit }, record, [{ sql: "SELECT 1", reasons: ["거부 사유"] }]);
  const e = auditLogEntry({ tool: "retrieve", params: { query: "q" }, result: retrieveResult }, caller);
  ok(e.sql === sql && !JSON.stringify(e).includes(SECRET_ROW), "retrieve 도 실행한 SQL 을 남기고 행은 남기지 않는다");
  ok(e.sql_refused.length === 1 && e.sql_refused[0].kind === "sql-trust-gate" && e.sql_refused[0].text === "SELECT 1" && e.sql_refused[0].reasons?.[0] === "거부 사유", "실행 전 검사가 거부한 문장");
  const cachedText = [{ type: "text", text: JSON.stringify({ route: "structured", context: SECRET_ROW, audit: { route: { tools: ["sql.query"] }, branch_errors: [] } }) }];
  const hit = auditLogEntry({ tool: "retrieve", params: { query: "q" }, result: cachedText, cached: true }, caller);
  ok(hit.cached === true && hit.route === "structured" && hit.tools[0] === "sql.query" && hit.sql === null && !JSON.stringify(hit).includes(SECRET_ROW), "캐시 적중은 표시하고 SQL 을 지어내지 않는다");
  const askHit = auditLogEntry({ tool: "ask", params: { query: "q" }, result: [{ type: "text", text: JSON.stringify(askResult) }], cached: true }, caller);
  ok(askHit.cached === true && askHit.sql === sql && !JSON.stringify(askHit).includes(SECRET_ROW), "캐시 적중한 ask 는 응답의 감사 레코드에서 읽고 답은 적지 않는다");
}

// 못 찾은 이름과 거절한 SQL
{
  const nf = { reason: "not_in_database" as const, query_entity: "서울물산", candidates: [] };
  const rec = {
    ...record,
    not_found: nf,
    missing_entities: [nf, { ...nf, query_entity: "삼성전자" }],
    retrieval: { ...record.retrieval, sql: { ...record.retrieval.sql, text: null, ok: null, rows: null, refused: { kind: "UNRESOLVED_NAME", text: "SELECT 2" } } },
  };
  const e = auditLogEntry({ tool: "audit.explain", params: { query: "q" }, result: rec }, caller);
  ok(e.not_found.join() === "서울물산,삼성전자", `못 찾은 이름 (got ${e.not_found.join()})`);
  ok(e.sql === null && e.sql_refused[0]?.kind === "UNRESOLVED_NAME" && e.sql_refused[0].text === "SELECT 2" && e.sql_refused[0].ran === undefined, "거절한 SQL 은 실행한 SQL 칸이 아니다");
  const ranRec = { ...rec, retrieval: { ...rec.retrieval, sql: { ...rec.retrieval.sql, refused: { kind: "UNRESOLVED_NAME", text: "SELECT 3", ran: true as const } } } };
  ok(auditLogEntry({ tool: "audit.explain", params: { query: "q" }, result: ranRec }, caller).sql_refused[0]?.ran === true, "실행한 뒤 답에 쓰지 않은 SQL 은 표시를 남긴다");
}

// 직접 도구
{
  const q = auditLogEntry({ tool: "sql.query", params: { sql: "SELECT name FROM t" }, result: { ok: true, rows: [{ name: SECRET_ROW }], rowCount: 1, columns: ["name"], truncated: false } }, caller);
  ok(q.sql === "SELECT name FROM t" && q.sql_ok === true && q.sql_rows === 1 && !JSON.stringify(q).includes(SECRET_ROW), "sql.query 는 받은 문장과 행 수만");
  const bad = auditLogEntry({ tool: "sql.query", params: { sql: "DROP TABLE t" }, result: { ok: false, rows: [], rowCount: 0, columns: [], truncated: false, error: "읽기 전용" } }, caller);
  ok(bad.sql_ok === false && bad.sql_error === "읽기 전용", "실패 사유");
  const o = auditLogEntry({ tool: "ontology.search", params: { query: "서울물산" }, result: { ok: true, hits: [], not_found: { reason: "not_in_database", query_entity: "서울물산", candidates: [] } } }, caller);
  ok(o.not_found[0] === "서울물산" && o.sql === null, "ontology.search 의 못 찾은 이름");
  const v = auditLogEntry({ tool: "ask", params: {}, result: [{ type: "text", text: "[Validation] Invalid parameters for \"ask\":\n  - query: Required" }] }, caller);
  ok(v.error === "[Validation] Invalid parameters for \"ask\":" && v.query === null, "입력 검증 거절은 머리 글만");
}

// 파일: 한 줄에 하나, 덧붙이기, 켜고 끄기, 쓰기 실패는 경고만
{
  const savedEnv = process.env.AUDIT_LOG_FILE;
  delete process.env.AUDIT_LOG_FILE;
  ok(auditLogPath() === undefined, "기본은 끔");
  process.env.AUDIT_LOG_FILE = "  ";
  ok(auditLogPath() === undefined, "빈 값은 끔");
  process.env.AUDIT_LOG_FILE = file;
  ok(auditLogPath() === file, "경로를 주면 켠다");
  if (savedEnv === undefined) delete process.env.AUDIT_LOG_FILE;
  else process.env.AUDIT_LOG_FILE = savedEnv;

  const plugin = auditLogPlugin(file, () => caller);
  const mw = plugin.middleware![0];
  const ctx = (result: unknown, meta: Record<string, unknown> = {}) =>
    ({ tool: { name: "ask" }, params: { query: "q1" }, requestId: "r", serverName: "s", startedAt: 0, meta, result, duration: 3 }) as never;
  await mw.after!(ctx(askResult));
  await mw.after!(ctx(askResult, { _cached: true }));
  await mw.onError!(ctx(undefined), new TypeError("boom /secret/path"));
  const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l) as AuditLogEntry);
  ok(lines.length === 3, `호출마다 한 줄 (got ${lines.length})`);
  ok(lines[1].cached === true && lines[0].cached === false, "캐시 적중 표시");
  ok(lines[2].error === "TypeError" && !JSON.stringify(lines[2]).includes("/secret/path"), "예외는 종류만 적는다");
  ok(!readFileSync(file, "utf8").includes(SECRET_ROW), "파일에 조회 행이 없다");

  // 쓰기 실패: 예외를 던지지 않고 stderr 경고는 사유마다 한 번, stdout 은 건드리지 않는다.
  const errs: string[] = [];
  const outs: string[] = [];
  const savedErr = console.error;
  const savedStdout = process.stdout.write.bind(process.stdout);
  console.error = (m: unknown) => void errs.push(String(m));
  process.stdout.write = ((m: string) => (outs.push(String(m)), true)) as typeof process.stdout.write;
  let threw = false;
  try {
    const write = auditLogWriter(dir); // 폴더는 파일로 열 수 없다
    const e = auditLogEntry({ tool: "ask", params: { query: "q" }, result: askResult }, caller);
    write(e);
    write(e);
  } catch {
    threw = true;
  } finally {
    console.error = savedErr;
    process.stdout.write = savedStdout;
  }
  ok(!threw, "쓰기 실패가 답으로 번지지 않는다");
  ok(errs.length === 1 && errs[0].startsWith("[audit]"), `경고는 stderr 에 한 번 (got ${errs.length})`);
  ok(outs.length === 0, "stdout 에는 쓰지 않는다(stdio 프레이밍)");
}

// 실패한 답은 캐시하지 않는다(복구된 뒤에도 60초 동안 같은 실패를 답하지 않게)
{
  ok(failedToolResult({ ok: false, error: "x" }) && failedToolResult({ answer: "a", audit: { branch_errors: ["sql: x"] } }) && failedToolResult({ branch_errors: ["sql: x"] }), "실패가 담긴 결과");
  ok(!failedToolResult({ ok: true, rows: [] }) && !failedToolResult({ answer: "a", audit: { branch_errors: [] } }) && !failedToolResult(undefined) && !failedToolResult("글"), "실패가 없는 결과");
}

rmSync(dir, { recursive: true, force: true });
console.log(`\nauditlog.test: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
