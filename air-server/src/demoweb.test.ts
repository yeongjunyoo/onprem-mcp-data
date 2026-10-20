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

// 시연 화면(demoweb.ts) 테스트. DB 와 모델 없이 돈다.
// 여기서 보는 것: 정형 답 끝의 행을 표로 그대로 푼다, 라우팅 근거를 줄여도 원문과 어긋나지 않는다, 페이지가 외부 자원을 부르지 않는다,
// 같은 기기의 Host 만 받는다, stdio 클라이언트가 가짜 MCP 서버와 주고받고 서버가 죽으면 사유를 돌려준다.
import { readFileSync } from "node:fs";

import { McpConnection, McpStdioClient, PRESETS, allowedHost, handshake, laneLabel, renderPage, routeSummary, splitAnswer, toolPayload } from "./demoweb.js";

let pass = 0, fail = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { pass++; } else { fail++; console.error("  FAIL:", msg); }
}
function eq<T>(a: T, b: T, msg: string) { ok(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)})`); }

// ── 정형 답의 행 ──────────────────────────────────────────────────────
// 2026-10-20 릴리스 리허설 TC-118 의 실제 답(rehearsal_rel1020/TC-118.txt).
{
  const answer =
    "서울 지역 매출 상위 5개 고객사는 다음과 같습니다:\n\n1. Client-Q | 매출: 23,244\n2. Client-Y | 매출: 22,865\n3. Client-I | 매출: 10,898\n4. Client-A | 매출: 10,707\n\n" +
    "[조회 결과 4건]\n- client_name: Client-Q, total_sales: 23244\n- client_name: Client-Y, total_sales: 22865\n- client_name: Client-I, total_sales: 10898\n- client_name: Client-A, total_sales: 10707";
  const { text, rows } = splitAnswer(answer);
  ok(text.startsWith("서울 지역 매출 상위 5개 고객사는") && !text.includes("[조회 결과"), "답 본문은 행 표시 앞까지");
  eq(rows?.count, 4, "「조회 결과 N건」의 N");
  eq(rows?.columns, ["client_name", "total_sales"], "열 이름은 행 줄에서 읽는다");
  eq(rows?.rows[0], ["Client-Q", "23244"], "값은 그대로 옮긴다(천 단위 쉼표를 넣지 않는다)");
  eq(rows?.rows.length, 4, "행 수");
}
{
  // 값 안의 쉼표는 열을 가르지 않는다. 열 이름(SQL 식별자) 앞의 「, 」만 가른다.
  const { rows } = splitAnswer("두 건입니다.\n\n[조회 결과 2건]\n- title: 장애 보고서, 2025-12-27, n: 1\n- title: 회의록, n: 2");
  eq(rows?.columns, ["title", "n"], "값 안의 쉼표에서 열을 만들지 않는다");
  eq(rows?.rows, [["장애 보고서, 2025-12-27", "1"], ["회의록", "2"]], "값은 쉼표까지 그대로");
}
{
  // 한 행만 있고 집계 하나인 답(TC-113)과 행 표시가 없는 답.
  const one = splitAnswer("2025년 3분기 총 매출액은 23859입니다.\n\n[조회 결과 1건]\n- total_revenue: 23859");
  eq([one.text, one.rows?.columns, one.rows?.rows], ["2025년 3분기 총 매출액은 23859입니다.", ["total_revenue"], [["23859"]]], "집계 한 행");
  const none = splitAnswer("Product-C1을 사용하는 고객사는 Client-H, Client-D입니다.");
  eq(none.rows, null, "행 표시가 없으면 표가 없다");
  eq(none.text, "Product-C1을 사용하는 고객사는 Client-H, Client-D입니다.", "본문은 그대로");
  const ragged = splitAnswer("[조회 결과 2건]\n- a: 1\n- a: 2, b: x");
  eq(ragged.rows?.rows, [["1", ""], ["2", "x"]], "열이 모자란 행은 빈 칸으로 맞춘다");
  ok(ragged.text.length > 0, "본문이 비면 답 전체를 본문으로 둔다");
}

// ── 라우팅 근거 줄이기 ─────────────────────────────────────────────────
{
  eq(
    routeSummary('rule margin 2 < gate; semantic nl2sql (anchor "상반기 매출 총합 얼마예요?", margin 0.201)'),
    { by: "semantic", anchor: "상반기 매출 총합 얼마예요?", margin: "0.201" },
    "시맨틱 폴백은 앵커와 격차를 그대로 꺼낸다(TC-113 감사 레코드)",
  );
  eq(routeSummary("relation verb MANAGES_ACCOUNT -> graph traversal").by, "rule", "관계 동사는 규칙");
  eq(routeSummary("only structured signals").by, "rule", "정형 신호만 있으면 규칙");
  eq(routeSummary("document signals ops_topic").by, "rule", "문서 신호는 규칙");
  eq(routeSummary("no decisive signal; default fan-out").by, "rule", "신호가 없어 세 갈래를 여는 것도 규칙의 결정");
  eq(
    routeSummary('rule margin 1 < gate; semantic knowledge_graph not applied (anchor "각 부서장 알려줘", margin 0.064): no entity named to start from').by,
    "rule",
    "적용되지 않은 시맨틱 제안은 시맨틱 결정이 아니다",
  );
  eq(routeSummary("rule margin 1 < gate; no decisive signal; llm graph.expand -> knowledge_graph").by, "llm", "셋째 단계가 바꾼 결정");
  eq(routeSummary("only semantic signals; rule margin 1 < gate; llm stage failed (Ollama /api/chat 503), rule decision kept").by, "rule", "셋째 단계가 실패하면 규칙 결정");
  eq(routeSummary("only semantic signals; rule margin 1 < gate; llm sql.query not applied: table noun 직원 has no graph edge").by, "rule", "셋째 단계가 적용되지 않으면 규칙 결정");
  eq(routeSummary("").by, "other", "근거가 없으면 지어내지 않는다");
  eq([laneLabel("nl2sql"), laneLabel("vector_search"), laneLabel("knowledge_graph"), laneLabel("hybrid"), laneLabel("x")], ["정형 데이터(SQL)", "문서 검색", "관계 그래프", "여러 갈래", "x"], "레인 이름");
}

// ── 페이지 ────────────────────────────────────────────────────────────
{
  const page = renderPage({ dataset: "companyx", version: "0.3.0" });
  ok(!/(https?:)?\/\/(?!127\.0\.0\.1|localhost)[a-z0-9.-]+\.[a-z]{2,}/i.test(page), "외부 자원(글꼴, 스크립트, 이미지)을 부르지 않는다");
  ok(!/<(script|link|img)[^>]+(src|href)=/i.test(page), "src, href 로 무엇도 불러오지 않는다");
  ok(page.startsWith("<!doctype html>") && page.includes('<html lang="ko">'), "한국어 문서");
  ok(PRESETS.every((g) => g.questions.every((q) => page.includes(q))), "사업자 데이터셋이면 시연 질문을 싣는다");
  ok(!PRESETS.some((g) => g.questions.some((q) => /Product-D2 이거 깔려/.test(q))), "라우팅이 바뀐 알려진 손실(TC-056)은 시연 질문에 넣지 않는다");
  const other = renderPage({ dataset: "mydata", version: "0.3.0" });
  ok(!PRESETS[0].questions.some((q) => other.includes(q)), "다른 데이터셋에는 사업자 질문을 싣지 않는다");
  ok(renderPage({ dataset: '<x">', version: "0.3.0" }).includes("&lt;x&quot;&gt;"), "머리글 값은 HTML 이스케이프");
  // 페이지 스크립트는 TS 템플릿 문자열 안에 있다. 거기 쓴 역슬래시는 한 겹 벗겨지고 역따옴표는 문자열을 끝낸다.
  // 2026-10-20 에 정규식 /\s+/ 가 /s+/ 로 바뀌어 화면이 조용히 깨질 뻔했다. 스크립트가 읽히는지와 두 글자가 없는지를 본다.
  const script = page.slice(page.indexOf("<script>") + "<script>".length, page.lastIndexOf("</script>"));
  let parses = true;
  try {
    new Function(script);
  } catch {
    parses = false;
  }
  ok(parses, "페이지 스크립트가 문법 오류 없이 읽힌다");
  // 벗겨진 뒤에는 역슬래시가 남지 않으므로 출력이 아니라 원문을 본다(/\s+/ 는 출력에서 /s+/ 라 읽히기는 한다).
  const src = readFileSync(new URL("../src/demoweb.ts", import.meta.url), "utf8");
  const body = src.slice(src.indexOf("<script>"), src.indexOf("</script>"));
  ok(body.length > 1000 && !body.includes(String.fromCharCode(92)), "페이지 스크립트 원문(TS 템플릿 안)에 역슬래시가 없다");
}

// ── Host 머리 ────────────────────────────────────────────────────────
{
  ok(allowedHost("127.0.0.1:3520", 3520) && allowedHost("localhost:3520", 3520), "같은 기기는 받는다");
  ok(!allowedHost("evil.example:3520", 3520) && !allowedHost(undefined, 3520) && !allowedHost("127.0.0.1:9999", 3520), "다른 Host 는 막는다(DNS 리바인딩)");
}

// ── 도구 결과 풀기 ─────────────────────────────────────────────────────
{
  eq(toolPayload({ content: [{ type: "text", text: '{"answer":"a","route":"graph"}' }] }), { isError: false, value: { answer: "a", route: "graph" } }, "content[0].text 의 JSON");
  eq(toolPayload({ content: [{ type: "text", text: "평문 오류" }], isError: true }), { isError: true, value: "평문 오류" }, "JSON 이 아니면 문자열 그대로, isError 유지");
  eq(toolPayload({ structuredContent: { answer: "b" }, content: [] }), { isError: false, value: { answer: "b" } }, "structuredContent 가 있으면 그것");
  eq(toolPayload(undefined).isError, true, "결과가 없으면 오류");
}

// ── stdio 클라이언트 ───────────────────────────────────────────────────
// 가짜 MCP 서버: 한 줄에 JSON-RPC 하나를 읽고 initialize, tools/list, tools/call 에 답한다. 「die」를 물으면 stderr 에 사유를 쓰고 끝난다.
const FAKE = `
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  buf += d;
  for (let i = buf.indexOf("\\n"); i >= 0; i = buf.indexOf("\\n")) {
    const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    if (m.id === undefined) continue;
    const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\\n");
    if (m.method === "initialize") reply({ protocolVersion: m.params.protocolVersion, capabilities: {}, serverInfo: { name: "fake", version: "0" } });
    else if (m.method === "tools/list") reply({ tools: [{ name: "ask" }, { name: "route" }] });
    else if (m.method === "tools/call" && m.params.arguments.query === "die") { process.stderr.write("[환경] 필요한 모델이 없다: qwen2.5-coder:7b\\n"); process.exit(1); }
    else if (m.method === "tools/call") { process.stdout.write("로그 한 줄이 섞여도\\n"); reply({ content: [{ type: "text", text: JSON.stringify({ answer: "답: " + m.params.arguments.query, route: "structured" }) }] }); }
  }
});
`;
{
  const exits: string[] = [];
  const c = new McpStdioClient(process.execPath, ["-e", FAKE], { ...process.env }, (reason, stderr) => exits.push(`${reason}|${stderr}`));
  try {
    const init = await c.request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "0" } }, 10_000);
    eq((init.result as { protocolVersion?: string }).protocolVersion, "2025-11-25", "initialize 를 주고받는다");
    c.notify("notifications/initialized");
    const list = await c.request("tools/list", {}, 10_000);
    eq(((list.result as { tools: unknown[] }).tools).length, 2, "tools/list");
    const [a, b] = await Promise.all([
      c.request("tools/call", { name: "ask", arguments: { query: "첫째" } }, 10_000),
      c.request("tools/call", { name: "ask", arguments: { query: "둘째" } }, 10_000),
    ]);
    eq([toolPayload(a.result as Record<string, unknown>).value, toolPayload(b.result as Record<string, unknown>).value].map((v) => (v as { answer: string }).answer), ["답: 첫째", "답: 둘째"], "동시에 보낸 두 요청을 id 로 짝짓는다(JSON 아닌 줄은 건너뛴다)");
    let reason = "";
    try {
      await c.request("tools/call", { name: "ask", arguments: { query: "die" } }, 10_000);
    } catch (e) {
      reason = e instanceof Error ? e.message : String(e);
    }
    ok(/서버 프로세스가 끝났다\(코드 1\)/.test(reason) && reason.includes("필요한 모델이 없다"), `서버가 죽으면 기다리지 않고 사유와 stderr 를 돌려준다 (got ${reason.slice(0, 120)})`);
    ok(c.exitReason() !== null, "끝난 뒤에는 끝났다고 말한다");
    ok(exits.length === 1 && exits[0].includes("코드 1") && exits[0].includes("필요한 모델이 없다"), `끝나면 onExit 에 사유와 stderr 를 한 번 넘긴다 (got ${JSON.stringify(exits)})`);
    let after = "";
    try {
      await c.request("tools/list", {}, 10_000);
    } catch (e) {
      after = e instanceof Error ? e.message : String(e);
    }
    ok(after.includes("서버 프로세스가 끝났다"), "끝난 서버에 보낸 요청은 바로 실패한다");
  } finally {
    await c.close();
  }
}
{
  const silent = new McpStdioClient(process.execPath, ["-e", "process.stdin.resume()"], { ...process.env });
  let msg = "";
  try {
    await silent.request("initialize", {}, 300);
  } catch (e) {
    msg = e instanceof Error ? e.message : String(e);
  }
  ok(/initialize: 0초 안에 응답이 없다|initialize: \d+초 안에 응답이 없다/.test(msg), `응답이 없으면 정한 시간 뒤 실패한다 (got ${msg})`);
  await silent.close();
}

// ── 서버가 끝나면 다음 요청 때 다시 띄운다 ──────────────────────────────
{
  const spawned: McpStdioClient[] = [];
  const conn = new McpConnection(
    () => {
      const c = new McpStdioClient(process.execPath, ["-e", FAKE], { ...process.env });
      spawned.push(c);
      return c;
    },
    (c) => handshake(c, "0", 10_000),
  );
  try {
    const first = conn.get();
    eq(conn.status().state, "starting", "띄우는 동안은 starting");
    const c1 = await first;
    eq([conn.status(), conn.starts()], [{ state: "ready", tools: 2 }, 1], "handshake 뒤 ready 와 도구 수, 한 번 띄움");
    ok((await conn.get()) === c1 && conn.starts() === 1, "살아 있으면 같은 연결을 다시 쓴다");
    await c1.request("tools/call", { name: "ask", arguments: { query: "die" } }, 10_000).catch(() => undefined);
    eq(conn.status().state, "down", "서버가 끝나면 down");
    const [a, b] = await Promise.all([conn.get(), conn.get()]);
    ok(a === b && a !== c1 && conn.starts() === 2 && spawned.length === 2, "끝난 뒤 다음 요청에서 한 번만 새로 띄운다(동시에 불러도)");
    const reply = await a.request("tools/call", { name: "ask", arguments: { query: "셋째" } }, 10_000);
    eq((toolPayload(reply.result as Record<string, unknown>).value as { answer: string }).answer, "답: 셋째", "새로 띄운 서버가 답한다");
  } finally {
    await conn.close();
  }
}
{
  // 기동하자마자 끝나는 서버(기동 검사 실패). 끝난 서버에 쓴 EPIPE 로 이 프로세스가 죽지 않고, 요청마다 한 번만 다시 띄운다.
  const conn = new McpConnection(() => new McpStdioClient(process.execPath, ["-e", "process.exit(3)"], { ...process.env }), (c) => handshake(c, "0", 10_000));
  const msgs: string[] = [];
  for (let i = 0; i < 3; i++) {
    try {
      await conn.get();
      msgs.push("붙음");
    } catch (e) {
      msgs.push(e instanceof Error ? e.message : String(e));
    }
  }
  ok(msgs.every((m) => m.includes("서버 프로세스가 끝났다(코드 3)")), `붙지 못하면 끝난 사유를 담아 던진다 (got ${JSON.stringify(msgs).slice(0, 200)})`);
  await new Promise((r) => setTimeout(r, 300));
  eq([conn.status().state, conn.starts()], ["down", 3], "요청 세 번에 세 번만 띄우고 그 사이 혼자 다시 띄우지 않는다");
  await conn.close();
}
{
  // stdin 을 닫고 잠시 살아 있는 서버. 거기 쓰면 POSIX 에서 EPIPE 가 난다(맥에서 이 경우 시연 화면 프로세스가 죽었다).
  const c = new McpStdioClient(process.execPath, ["-e", "require('fs').closeSync(0); setTimeout(() => process.exit(3), 1000)"], { ...process.env });
  await new Promise((r) => setTimeout(r, 400));
  let msg = "";
  try {
    await c.request("tools/list", {}, 5000);
  } catch (e) {
    msg = e instanceof Error ? e.message : String(e);
  }
  ok(msg.includes("서버 프로세스가 끝났다(코드 3)"), `닫힌 stdin 에 써도 죽지 않고 끝난 사유로 실패한다 (got ${msg.slice(0, 80)})`);
}

console.log(`demoweb.test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
