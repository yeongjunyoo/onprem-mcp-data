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

// MCP 표준 표면 테스트 — 리소스와 프롬프트가 실제로 등록되고 응답하는지.
//
// 데이터베이스도 모델도 없이 돈다. 리소스 핸들러는 파일과 상수만 읽고,
// 프롬프트 핸들러는 문자열을 만들 뿐이다. 그래서 CI에서 그대로 검증된다.
import { buildPrompts } from "./prompts.js";
import { buildAnswerPrompt } from "./llm.js";
import { buildCompanyxSqlPrompt } from "./nl2sql.js";
import { buildAuditRecord } from "./auditrecord.js";
import { buildResources } from "./resources.js";
import { resolveTransport, SANITIZER_OPTIONS } from "./server.js";
import { reportOllama } from "./preflight.js";
import { ROUTE_OUTPUT_SCHEMA } from "./routeschema.js";
import { sanitizerPlugin } from "@airmcp-dev/core";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

let pass = 0,
  fail = 0;
function ok(cond: boolean, msg: string) {
  if (cond) pass++;
  else {
    fail++;
    console.error("  FAIL:", msg);
  }
}

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
interface Reply {
  id?: number;
  result?: Json;
  error?: { code: number; message: string };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const childEnv = (vars: Record<string, string | undefined>) => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of ["MCP_TRANSPORT", "MCP_PORT", "MCP_HOST", "MCP_ALLOWED_ORIGINS"]) delete env[k];
  for (const [k, v] of Object.entries(vars)) if (v !== undefined) env[k] = v;
  return env;
};

/** 서버 정의(buildServer)를 air 의 stdio 전송으로 띄운다. 클라이언트처럼 한 줄에 JSON-RPC 하나를 쓰고 읽는다.
 * buildServer 는 air dedup 의 타이머가 프로세스를 붙잡으므로 입력이 닫히면 끝나게 한다. */
async function startStdio(serverJs: string) {
  const child = spawn(
    process.execPath,
    ["--input-type=module", "-e", `const { buildServer } = await import(${serverJs}); process.stdin.once("end", () => process.exit(0)); await buildServer().start();`],
    { env: childEnv({}), stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
  );
  const pending = new Map<number, (r: Reply) => void>();
  const nonJson: string[] = [];
  let buf = "",
    stderr = "",
    nextId = 0;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (d: string) => {
    buf += d;
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      let msg: Reply;
      try {
        msg = JSON.parse(line) as Reply;
      } catch {
        nonJson.push(line);
        continue;
      }
      const settle = pending.get(msg.id as number);
      if (!settle) nonJson.push(line); // 요청하지 않은 메시지(알림에 대한 응답 따위)도 위반이다
      else {
        pending.delete(msg.id as number);
        settle(msg);
      }
    }
  });
  child.stderr.on("data", (d) => (stderr += d));
  const write = (msg: Json, eol = "\n") => child.stdin.write(JSON.stringify(msg) + eol);
  return {
    rpc(method: string, params?: Json, eol = "\n"): Promise<Reply> {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`stdio ${method}: 30초 안에 응답이 없다. 서버 stderr:\n${stderr.slice(-600)}`)), 30_000);
        pending.set(id, (r) => {
          clearTimeout(timer);
          resolve(r);
        });
        write({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }, eol);
      });
    },
    notify: (method: string) => void write({ jsonrpc: "2.0", method }),
    nonJson: () => nonJson,
    unanswered: () => pending.size,
    async close() {
      child.stdin.end();
      if (child.exitCode === null) await new Promise((r) => child.once("exit", r));
    },
  };
}

/** 같은 서버 정의를 air 의 Streamable HTTP(MCP_TRANSPORT=http)나 HTTP+SSE(MCP_TRANSPORT=sse) 전송으로 빈 포트에 띄운다. */
async function startHttp(serverJs: string, vars: Record<string, string>, transport: "http" | "sse" = "http") {
  const port = await new Promise<number>((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
  const child = spawn(process.execPath, ["--input-type=module", "-e", `const { buildServer } = await import(${serverJs}); await buildServer().start();`], {
    env: childEnv({ ...vars, MCP_TRANSPORT: transport, MCP_PORT: String(port) }),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  for (let i = 0; i < 300 && !/listening on port/.test(log) && child.exitCode === null; i++) await sleep(100);
  if (!/listening on port/.test(log)) {
    child.kill();
    throw new Error(`${transport} 서버가 뜨지 않았다:\n${log.slice(-600)}`);
  }
  // fetch 대신 node:http 로 보낸다. Origin 같은 머리를 클라이언트 라이브러리가 바꾸지 않고 그대로 싣는다.
  const request = (method: string, path: string, body?: Json, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpRequest(
        { host: "127.0.0.1", port, method, path, headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers } },
        (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (d) => (text += d));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
        },
      );
      req.on("error", reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  // SSE 스트림(GET /sse)은 끝나지 않는다. 200 이면 endpoint 이벤트가 올 때까지, 아니면 응답 끝까지 읽고 연결을 닫는다.
  const openStream = (path: string, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; endpoint?: string; body: string }>((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port, method: "GET", path, headers: { accept: "text/event-stream", ...headers } }, (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (d) => {
          text += d;
          const endpoint = /^event: endpoint\ndata: (.+)$/m.exec(text)?.[1];
          if (res.statusCode === 200 && endpoint) {
            resolve({ status: 200, endpoint, body: text });
            req.destroy();
          }
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
      });
      req.on("error", (e) => (req.destroyed ? undefined : reject(e)));
      req.end();
    });
  return {
    log: () => log,
    request,
    openStream,
    post: (body: Json, headers: Record<string, string> = {}) => request("POST", "/mcp", body, headers),
    async close() {
      child.kill();
      if (child.exitCode === null) await new Promise((r) => child.once("exit", r));
    },
  };
}

async function main() {
  // --- resources ---
  const resources = buildResources();
  ok(resources.length >= 6, `리소스 6개 이상 등록 (got ${resources.length})`);

  const uris = resources.map((r) => r.uri);
  for (const expected of [
    "schema://dataset/tables",
    "dataset://companyx/manifest",
    "eval://results/index",
    "profile://dataset/active",
    "docs://report/evidence",
    "audit://schema/v1",
  ]) {
    ok(uris.includes(expected), `리소스 ${expected} 존재`);
  }

  for (const r of resources) {
    ok(Boolean(r.name && r.description), `${r.uri}: 이름과 설명이 있다`);
    const content = await r.handler(r.uri, { requestId: "test", serverName: "onprem-mcp-data" });
    const text = typeof content === "string" ? content : "text" in content ? content.text : "";
    ok(text.length > 0, `${r.uri}: 빈 응답이 아니다`);
    // 리소스는 읽기 전용이어야 한다. 응답에 자격증명이 섞이면 즉시 실패다.
    ok(!/password|secret|token|api[_-]?key/i.test(text), `${r.uri}: 자격증명 문자열 없음`);
  }

  const schema = resources.find((r) => r.uri === "schema://dataset/tables")!;
  const card = String(await schema.handler(schema.uri, { requestId: "t", serverName: "s" }));
  ok(card.includes("("), "스키마 카드가 컬럼 목록 형태다");
  // ★ 카드는 자기가 어느 프로파일의 것인지 스스로 밝혀야 한다.
  //
  // 종전 URI 는 schema://companyx/tables 였는데 핸들러는 **활성 프로파일**의
  // 카드를 돌려준다. DATASET 미설정이면 스모크 시드(orders/documents)가 나온다.
  // 즉 이름은 companyx 인데 내용은 8테이블이 아니었다 — 심사자가 MCP 로 열어
  // 보면 이름이 거짓말을 한다. 읽는 사람이 다른 리소스를 열어 봐야 자기가 무엇을
  // 보고 있는지 아는 상태는 근거 공개가 아니다.
  ok(card.startsWith("# 프로파일: "), "스키마 카드 첫 줄이 프로파일을 밝힌다");
  ok(
    ["smoke", "bench", "companyx"].some((n) => card.split("\n")[0].includes(n)),
    "밝힌 프로파일 이름이 유효하다",
  );

  // ★ 감사 스키마 리소스는 실물과 필드가 같아야 한다.
  //
  // 설명이 "감사 결과를 파싱하려는 쪽이 먼저 읽을 문서다" 라고 말한다. 즉 호스트가
  // 이걸 계약으로 삼는다. 계약이 실물과 다르면 파싱이 조용히 깨진다.
  //
  // 실제로 갈려 있었다 — 리소스는 `fingerprint` 하나를 적었는데 레코드에는
  // routing_fingerprint / pipeline_fingerprint 둘이 있다. 그 분리는 "무엇이
  // 결정론이고 무엇이 아닌가" 를 보여 주는 설계인데 문서에서 사라져 있었고,
  // branch_errors(우아한 저하 근거)와 generated_at 도 빠져 있었다.
  // ★ 증거 목록 리소스는 **증거 절**을 줘야 한다.
  //
  // 종전 구현은 "## 9. Evidence manifest" 를 문자열로 찾고 못 찾으면 보고서 앞
  // 4000자를 대신 돌려줬다. 절을 하나 끼워 넣어 번호가 밀리기만 해도, 이 리소스는
  // "개발보고서 증거 목록" 이라는 이름으로 서론을 준다. 조용한 오답이다.
  const evidenceRes = resources.find((r) => r.uri === "docs://report/evidence")!;
  const evidenceText = String(
    await evidenceRes.handler(evidenceRes.uri, { requestId: "t", serverName: "s" }),
  );
  ok(
    /^##\s+\d+\.\s*Evidence manifest/i.test(evidenceText.trim()),
    "증거 목록 리소스가 Evidence manifest 절로 시작한다",
  );
  ok(
    !evidenceText.includes("찾지 못했습니다"),
    "증거 절을 실제로 찾았다(못 찾으면 조용히 다른 것을 주지 않고 그렇게 말한다)",
  );

  const auditRes = resources.find((r) => r.uri === "audit://schema/v1")!;
  const auditDoc = JSON.parse(
    String(await auditRes.handler(auditRes.uri, { requestId: "t", serverName: "s" })),
  );
  const sampleRecord = buildAuditRecord({
    query: "표면 테스트",
    route: "structured",
    sql: { text: "SELECT 1", result: undefined, repaired: false },
    fused: [],
    curated: { kept: [], dropped: [], tokensUsed: 0, budget: 256, brokenRows: 0, notes: [] },
    context: "",
    audit: {
      route: {
        route: "structured",
        lane: "관계형",
        tools: ["sql.query"],
        structured_signals: [],
        semantic_signals: [],
        graph_signals: [],
        rationale: "",
        deterministic: true,
      },
      candidates: { sql: 0, vector: 0, graph: 0, fused: 0 },
      branch_errors: [],
      curate: {
        kept: [],
        dropped: [],
        tokens_used: 0,
        budget: 256,
        broken_rows: 0,
        structure_preserved: true,
      },
    },
  } as never);
  // ★ 감사 레코드는 두 계층이다.
  //
  //   buildAuditRecord()          파이프라인이 만드는 12종
  //   server.ts 의 audit.explain  거기에 executed_at · cache_policy 를 덧붙인 14종
  //
  // 계약이 설명하는 것은 **도구가 돌려주는 14종**이다. 2026-08-17 에 이 테스트가
  // 12종만 만들어 놓고 대조해 계약의 두 필드를 "유령" 으로 판정했다 —
  // 틀린 것은 계약이 아니라 **대조 대상의 계층**이었다.
  const toolRecord = {
    ...sampleRecord,
    executed_at: "2026-08-17T00:00:00.000Z",
    cache_policy: "excluded" as const,
  };
  const documentedFields = Object.keys(auditDoc.fields ?? {}).sort();
  const actualFields = Object.keys(toolRecord).sort();
  // 특정 경로에서만 붙는 선택 필드(답변 생성, 미해소 게이트, 섞인 질문의 없는 개체). 그냥 예외로 빼면 다음에
  // 진짜 유령이 생겨도 못 잡으므로, 타입에서 선택인 것만 이름으로 못박아 둔다.
  const OPTIONAL_FIELDS = ["grounding", "not_found", "missing_entities"];
  const undocumented = actualFields.filter((f) => !documentedFields.includes(f));
  const phantom = documentedFields.filter(
    (f) => !actualFields.includes(f) && !OPTIONAL_FIELDS.includes(f),
  );
  ok(undocumented.length === 0, `감사 레코드의 모든 필드가 문서화됨 (누락: ${undocumented})`);
  ok(phantom.length === 0, `문서에 없는 필드를 지어내지 않음 (유령: ${phantom})`);
  ok(auditDoc.schema === sampleRecord.schema, "스키마 식별자가 실물과 같다");

  const prof = resources.find((r) => r.uri === "profile://dataset/active")!;
  const profJson = JSON.parse(String(await prof.handler(prof.uri, { requestId: "t", serverName: "s" })));
  ok(["smoke", "bench", "companyx"].includes(profJson.profile), "활성 프로파일 이름이 유효하다");
  ok(typeof profJson.vector_table === "string", "벡터 테이블이 노출된다");

  // --- prompts ---
  const prompts = buildPrompts();
  ok(prompts.length >= 4, `프롬프트 4개 이상 등록 (got ${prompts.length})`);
  const names = prompts.map((p) => p.name);
  for (const expected of ["grounded-answer", "nl2sql-with-schema-card", "explain-routing", "review-generated-sql"]) {
    ok(names.includes(expected), `프롬프트 ${expected} 존재`);
  }

  for (const p of prompts) {
    ok(Boolean(p.description), `${p.name}: 설명이 있다`);
    const args = Object.fromEntries((p.arguments ?? []).map((a) => [a.name, `<${a.name}>`]));
    const msgs = await p.handler(args);
    ok(msgs.length > 0, `${p.name}: 메시지를 만든다`);
    ok(msgs.every((m) => m.role === "user" || m.role === "assistant"), `${p.name}: role이 유효하다`);
    // 인자가 실제로 템플릿에 들어가야 한다. 안 들어가면 인자 선언이 거짓말이다.
    for (const a of p.arguments ?? []) {
      if (a.required) {
        ok(msgs.some((m) => m.content.includes(`<${a.name}>`)), `${p.name}: 필수 인자 ${a.name}가 본문에 반영된다`);
      }
    }
  }

  // ★ 노출 프롬프트는 실행 프롬프트와 **같아야** 한다.
  //
  // README 는 "서버가 실제로 쓰는 템플릿을 그대로 노출합니다" 라고 주장하고
  // prompts.ts 설명도 "ask 도구가 쓰는 규칙과 같다" 고 적혀 있다. 종전에는 저기
  // 손으로 줄인 사본이 있었고 언어 고정·그래프 트리플 해석·SQL 결과 인용 규칙이
  // 빠져 있었다. 문구를 부분 일치로 확인하면 그 누락을 못 잡는다 — 그래서
  // **전문 동일성**을 본다.
  const grounded = prompts.find((p) => p.name === "grounded-answer")!;
  const gm = await grounded.handler({ question: "질문", context: "근거" });
  ok(
    gm[0].content === buildAnswerPrompt("질문", "근거"),
    "노출된 근거 기반 프롬프트가 ask 실행 경로와 전문 동일",
  );

  const sqlPrompt = prompts.find((p) => p.name === "nl2sql-with-schema-card")!;
  const sm = await sqlPrompt.handler({ question: "질문" });
  ok(
    sm[0].content === buildCompanyxSqlPrompt("질문"),
    "노출된 NL2SQL 프롬프트가 companyx 실행 경로와 전문 동일",
  );
  ok(
    sm[0].content.includes("companyx. 접두사"),
    "실제 프롬프트에만 있던 스키마 접두사 규칙이 노출본에도 있다",
  );

  // --- transport 해석 ---
  //
  // 종전에는 `=== "sse"` 이외가 전부 stdio 로 조용히 떨어졌다. 주석은 http 도
  // 지원한다고 적어둔 채였으므로, MCP_TRANSPORT=http 를 준 사람은 에러 없이
  // stdio 서버를 받고 성공한 줄 안다. 잘못 다룬 설정은 기본값으로 메꾸는 것보다
  // 기동을 멈추는 편이 싸다.
  const savedEnv = { ...process.env };
  const setEnv = (vars: Record<string, string | undefined>) => {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  const throws = (vars: Record<string, string | undefined>) => {
    setEnv(vars);
    try {
      resolveTransport();
      return false;
    } catch {
      return true;
    }
  };
  try {
    setEnv({ MCP_TRANSPORT: undefined, MCP_PORT: undefined, MCP_HOST: undefined, MCP_ALLOWED_ORIGINS: undefined });
    ok(resolveTransport().type === "stdio", "미지정이면 stdio");

    process.env.MCP_TRANSPORT = "stdio";
    ok(resolveTransport().type === "stdio", "stdio 명시");

    process.env.MCP_TRANSPORT = "sse";
    ok(
      JSON.stringify(resolveTransport()) === JSON.stringify({ type: "sse", port: 3510, host: "127.0.0.1", allowedOrigins: [] }),
      `sse 기본 포트 3510, 루프백에만 바인딩하고 루프백 밖 Origin 은 받지 않는다 (got ${JSON.stringify(resolveTransport())})`,
    );

    process.env.MCP_PORT = "3600";
    const sse2 = resolveTransport();
    ok(sse2.type === "sse" && sse2.port === 3600, "MCP_PORT 반영");

    // http 는 air 의 세션 없는 Streamable HTTP 다. 포트는 sse 와 같은 MCP_PORT, 허용 출처는 루프백뿐이다.
    process.env.MCP_TRANSPORT = "http";
    ok(
      JSON.stringify(resolveTransport()) === JSON.stringify({ type: "http", port: 3600, host: "127.0.0.1", allowedOrigins: [] }),
      `http 는 MCP_PORT 를 쓰고 루프백에만 바인딩하며 루프백 밖 Origin 은 받지 않는다 (got ${JSON.stringify(resolveTransport())})`,
    );
    setEnv({ MCP_HOST: "0.0.0.0", MCP_ALLOWED_ORIGINS: "https://app.example.com, http://192.168.0.5:8080" });
    const open = resolveTransport();
    ok(
      open.type === "http" && open.host === "0.0.0.0" && JSON.stringify(open.allowedOrigins) === JSON.stringify(["https://app.example.com", "http://192.168.0.5:8080"]),
      `MCP_HOST 와 MCP_ALLOWED_ORIGINS 를 반영한다 (got ${JSON.stringify(open)})`,
    );
    setEnv({ MCP_HOST: "  ", MCP_ALLOWED_ORIGINS: " " });
    const blankOpts = resolveTransport();
    ok(blankOpts.type === "http" && blankOpts.host === "127.0.0.1" && blankOpts.allowedOrigins.length === 0, "공백만 있는 MCP_HOST, MCP_ALLOWED_ORIGINS 는 미지정과 같다");

    // ★ 핵심 — 모르는 값은 조용히 넘어가지 않는다.
    // 공백만 있는 값은 "미지정"으로 본다 — 셸에서 빈 변수를 넘기는 흔한 형태다.
    // 결정이라면 테스트가 그 결정을 말해야 한다.
    setEnv({ MCP_TRANSPORT: "   " });
    ok(resolveTransport().type === "stdio", "공백만 있는 값은 미지정과 같다");

    for (const bad of ["HTTP", "websocket", "sse2", "stdio2", "streamable-http"]) {
      ok(throws({ MCP_TRANSPORT: bad }), `MCP_TRANSPORT=${JSON.stringify(bad)} 는 거절한다`);
    }
    for (const badPort of ["0", "70000", "abc", "-1"]) {
      ok(throws({ MCP_TRANSPORT: "sse", MCP_PORT: badPort }), `MCP_PORT=${badPort} 는 거절한다`);
    }
    process.env.MCP_PORT = "3600";
    for (const badHost of ["0.0.0.0:3510", "http://127.0.0.1", "local host"]) {
      ok(throws({ MCP_TRANSPORT: "http", MCP_HOST: badHost }), `MCP_HOST=${JSON.stringify(badHost)} 는 거절한다(포트는 MCP_PORT 로)`);
    }
    process.env.MCP_HOST = "::1";
    ok(!throws({ MCP_TRANSPORT: "http" }), "IPv6 주소(::1)는 받는다");
    for (const badOrigin of ["*", "https://app.example.com/", "app.example.com", "https://app.example.com/path", "ftp://files.example.com"]) {
      ok(throws({ MCP_TRANSPORT: "http", MCP_HOST: undefined, MCP_ALLOWED_ORIGINS: badOrigin }), `MCP_ALLOWED_ORIGINS=${JSON.stringify(badOrigin)} 는 거절한다(출처만 받는다)`);
    }
  } finally {
    for (const k of ["MCP_TRANSPORT", "MCP_PORT", "MCP_HOST", "MCP_ALLOWED_ORIGINS"]) setEnv({ [k]: savedEnv[k] });
  }

  // --- sanitizer: SQL 비교 연산자를 지우지 않는다 ---
  // air 기본값(stripHtml)은 `<` 부터 `>` 까지를 태그로 보고 지운다. 서버가 쓰는 설정으로
  // air 의 실제 미들웨어를 돌려, sql.query 와 ask 에 들어온 연산자가 그대로 남는지 본다.
  const sanitize = sanitizerPlugin(SANITIZER_OPTIONS).middleware![0].before!;
  for (const sql of [
    "SELECT name FROM companyx.employees WHERE salary < 5000 AND salary > 3000",
    "SELECT count(*) FROM companyx.support_tickets WHERE status <> 'closed'",
  ]) {
    const out = (await sanitize({ tool: { name: "sql.query" }, params: { sql } } as never)) as {
      params: { sql: string };
    };
    ok(out.params.sql === sql, `sanitizer 가 SQL 연산자를 지우지 않는다: ${sql}`);
  }
  // 한국어 질문은 제목을 꺾쇠로 감싸기도 한다. 기본값이면 제목이 통째로 사라진다.
  const question = "<클라우드 마이그레이션> 제안서 내용 보여줘";
  const askOut = (await sanitize({ tool: { name: "ask" }, params: { query: question } } as never)) as {
    params: { query: string };
  };
  ok(askOut.params.query === question, "sanitizer 가 질문 속 꺾쇠 제목을 지우지 않는다");
  const ctrlOut = (await sanitize({ tool: { name: "ask" }, params: { query: "매출\u0007 합계" } } as never)) as {
    params: { query: string };
  };
  ok(ctrlOut.params.query === "매출 합계", "제어 문자 제거는 그대로 한다");
  // 길이 상한에서 말없이 자르지 않는다(랜덤 테스트 3차 G24: 공백을 채운 10,101자 SQL 이 앞 10,000자만 실행됐다). 상한은 입력 검증이 거절한다.
  const padded = "SELECT count(*) AS n FROM companyx.sales WHERE amount > 0" + " ".repeat(10000) + "AND amount > 1000";
  const longOut = (await sanitize({ tool: { name: "sql.query" }, params: { sql: padded } } as never)) as { params: { sql: string } };
  ok(longOut.params.sql === padded, `sanitizer 가 10,000자를 넘는 인자를 자르지 않는다 (got ${longOut.params.sql.length}자)`);

  // --- stdio: 프리플라이트가 stdout 에 쓰지 않는다 ---
  // stdout 은 MCP JSON-RPC 통로다. 사람이 읽을 줄이 섞이면 클라이언트가 파싱 오류를 낸다.
  const realLog = console.log;
  const realErr = console.error;
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  console.log = (...a: unknown[]) => void stdoutLines.push(a.join(" "));
  console.error = (...a: unknown[]) => void stderrLines.push(a.join(" "));
  let preflightOk = false;
  try {
    preflightOk = reportOllama(
      { reachable: true, host: "http://localhost:11434", models: ["qwen2.5-coder:7b", "bge-m3"] } as never,
      ["qwen2.5-coder:7b", "bge-m3"],
    );
  } finally {
    console.log = realLog;
    console.error = realErr;
  }
  ok(preflightOk, "모델이 다 있으면 프리플라이트가 통과한다");
  ok(stdoutLines.length === 0, `프리플라이트가 stdout 에 쓰지 않는다 (got ${stdoutLines.length}줄)`);
  ok(stderrLines.some((l) => l.includes("[환경] Ollama")), "프리플라이트 안내 줄은 stderr 로 간다");

  // --- 기동: 데이터셋 프로파일 오타는 다른 일을 하기 전에 거절한다 ---
  // 리허설(2026-10-06)에서 DATASET 오타로 띄우면 「폴백으로 동작한다」를 두 번 찍은 뒤에야 같은
  // 오류로 끝났다. Ollama 주소를 닫힌 포트로 두어, 프로파일보다 Ollama 를 먼저 보면 이 단언이 깨진다.
  const typo = spawnSync(process.execPath, [fileURLToPath(new URL("./index.js", import.meta.url))], {
    env: { ...process.env, DATASET: "conpanyx", OLLAMA_HOST: "http://127.0.0.1:9" },
    encoding: "utf8",
    timeout: 30_000,
  });
  ok(typo.status === 1, `DATASET 오타면 종료 코드 1 (got ${typo.status})`);
  ok(typo.stderr.includes("모르는 프로파일이다") && typo.stderr.includes("companyx | bench | smoke"), "오타 사유와 가능한 값을 알린다");
  ok(!typo.stderr.includes("폴백"), "폴백으로 돈다는 말 없이 거절한다");
  ok(typo.stdout === "", "거절할 때도 stdout 에 쓰지 않는다");

  // --- 인자 계약(queryinput.ts): 빈 질문, format, 긴 인자, budget ---
  // 2026-10-06 경계 실측: ask 에 빈 질문을 주면 7B 가 SQL 을 지어내 부서장에 대한 거짓 문장을 답했다(3/3).
  const { EMPTY_QUERY_MESSAGE, MAX_INPUT_CHARS, queryParam, formatParam, sqlParam, budgetParam } = await import("./queryinput.js");
  const qp = queryParam("사용자의 한국어 질의");
  for (const blank of ["", "   ", "\t\n", "　　", "​", "\u0007"]) {
    const r = qp.safeParse(blank);
    ok(!r.success && r.error.issues[0].message === EMPTY_QUERY_MESSAGE, `빈 질문 ${JSON.stringify(blank)} 은 거절한다`);
  }
  for (const q of ["서울 매출", "  서울 매출 ", "2025년 3분기 총 매출액은 얼마야? "]) {
    const r = qp.safeParse(q);
    ok(r.success && r.data === q, `질문 ${JSON.stringify(q)} 은 손대지 않고 통과한다(트림하지 않는다)`);
  }
  // audit.explain format: json 과 text 말고는 입력 검증에서 거절한다(G17 ⑪). 종전에는 xml 을 조용히 json 으로 돌려줬다.
  const fp = formatParam("json(기본) 또는 text");
  for (const f of [undefined, "json", "text"]) ok(fp.safeParse(f).success, `format ${JSON.stringify(f)} 은 받는다(TC-161 은 text)`);
  for (const f of ["xml", "TEXT", "", "markdown"]) {
    const r = fp.safeParse(f);
    ok(!r.success && r.error.issues[0].message === `format 은 json(기본) 또는 text 만 받습니다. 받은 값: ${JSON.stringify(f)}`, `format ${JSON.stringify(f)} 은 거절하고 받은 값을 말한다`);
  }
  // 긴 인자와 budget(랜덤 테스트 3차 G20, G24, F20, F21, X01): 종전에는 sanitizer 가 10,000자에서 말없이 잘라 다른 질의를
  // 실행했고, budget -1 과 0.5 는 근거를 모두 버린 빈 컨텍스트가 됐다.
  const sp = sqlParam("실행할 단일 SELECT/WITH 쿼리");
  const bp = budgetParam("큐레이터 토큰 예산 (기본 1024)");
  const longQ = "가".repeat(MAX_INPUT_CHARS + 1);
  const qr = qp.safeParse(longQ);
  ok(!qr.success && qr.error.issues[0].message === "질문이 너무 깁니다(10,001자). 10,000자 이하로 입력해 주세요. 잘라서 처리하면 다른 질문이 되므로 처리하지 않았습니다.", `긴 질문은 자르지 않고 거절한다 (got ${qr.success ? "통과" : qr.error.issues[0].message})`);
  const tc157 = "2025년 3분기 총 매출액은 얼마야? ".repeat(100);
  ok(qp.safeParse(tc157).success && qp.safeParse("가".repeat(MAX_INPUT_CHARS)).success, "TC-157 의 2,200자와 상한 그대로의 질문은 통과한다");
  const sr = sp.safeParse("SELECT 1" + " ".repeat(MAX_INPUT_CHARS));
  ok(!sr.success && sr.error.issues[0].message.startsWith("SQL 이 너무 깁니다(10,008자). 10,000자 이하로 입력해 주세요."), `긴 SQL 은 자르지 않고 거절한다 (got ${sr.success ? "통과" : sr.error.issues[0].message})`);
  ok(sp.safeParse("SELECT count(*) FROM companyx.clients").success, "보통 SQL 은 통과한다");
  for (const b of [undefined, 1, 200, 1024, 1e12]) ok(bp.safeParse(b).success, `budget ${b} 는 받는다(TC-111, TC-112 는 200)`);
  for (const b of [-1, 0, 0.5, 1.5, Number.POSITIVE_INFINITY]) {
    const r = bp.safeParse(b);
    ok(!r.success && r.error.issues[0].message.startsWith("budget 은 1 이상의 정수(토큰 수)만 받습니다.") && r.error.issues[0].message.includes(`받은 값: ${JSON.stringify(b) ?? String(b)}`), `budget ${b} 는 거절하고 받은 값을 말한다`);
  }

  // --- MCP stdio: 서버 정의를 air 의 stdio 전송에 그대로 얹고 클라이언트처럼 줄 단위 JSON-RPC 로 묻는다 ---
  // 클라이언트가 받는 응답 그 자체를 잰다(air 엔진, 입력 검증 미들웨어, 플러그인 체인, 전송). DB 와 모델이 필요 없는 요청만
  // 보낸다: 목록, 프롬프트, 리소스, 그리고 핸들러 앞의 입력 검증에서 막히는 호출. 여기 걸린 air 의 동작 가운데 여섯은
  // air-server/vendor 의 패치 얹은 air 가 고친 것이다(docs/air-patch.md). 패치가 빠지면 이 절이 실패한다.
  const SERVER_JS = JSON.stringify(new URL("./server.js", import.meta.url).href);
  const stdio = await startStdio(SERVER_JS);
  const PROTOCOL = "2025-11-25";
  try {
    // 줄 단위 프레이밍(airmcp-dev/air#3): 0.5.2 그대로는 Content-Length 머리가 없는 요청을 읽지 않아 응답이 오지 않았다.
    const init = await stdio.rpc("initialize", { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "surfaces-test", version: "0" } });
    ok(init.result?.protocolVersion === PROTOCOL, `줄 단위 initialize 에 응답하고 ${PROTOCOL} 로 협상한다 (got ${JSON.stringify(init).slice(0, 160)})`);
    ok(
      JSON.stringify(init.result?.capabilities) === JSON.stringify({ tools: { listChanged: true }, resources: { listChanged: true }, prompts: { listChanged: true } }),
      `능력은 tools, resources, prompts 셋이고 logging 과 completions 는 선언하지 않는다(TC-017) (got ${JSON.stringify(init.result?.capabilities)})`,
    );
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as { version: string };
    ok(init.result?.serverInfo?.name === "onprem-mcp-data" && init.result?.serverInfo?.version === pkg.version, `serverInfo 는 onprem-mcp-data ${pkg.version} (TC-015)`);
    stdio.notify("notifications/initialized");
    // CRLF 로 끝나는 줄도 받는다(Windows 의 클라이언트).
    const crlf = await stdio.rpc("ping", undefined, "\r\n");
    // ping 은 빈 결과다. 0.5.2 그대로는 { resultType } 을 실어 SDK 클라이언트의 ping() 이 거부했다(air main 42cf9e0 의 수정).
    ok(JSON.stringify(crlf.result) === "{}", `CRLF 줄의 ping 에 빈 결과로 답한다 (got ${JSON.stringify(crlf)})`);

    // tools/list(airmcp-dev/air#7): refine 한 인자의 설명과 형, 배열의 items, nullable 칸의 null 이 스키마에 실린다.
    const tools = ((await stdio.rpc("tools/list", {})).result?.tools ?? []) as { name: string; inputSchema: Json; outputSchema?: Json; annotations?: Json }[];
    const tool = (name: string) => tools.find((t) => t.name === name);
    ok(tools.length === 8, `도구 8종 (got ${tools.map((t) => t.name).join(", ")})`);
    ok(tools.every((t) => t.annotations?.readOnlyHint === true), "여덟 도구 모두 readOnlyHint (TC-019..026)");
    const queryProp = { type: "string", description: "사용자의 한국어 질의" };
    ok(
      JSON.stringify(tool("route")?.inputSchema) === JSON.stringify({ type: "object", properties: { query: queryProp }, required: ["query"] }),
      `route 의 query 는 refine 안쪽의 형과 설명 그대로 공개된다 (got ${JSON.stringify(tool("route")?.inputSchema)})`,
    );
    ok(
      JSON.stringify(tool("retrieve")?.inputSchema) ===
        JSON.stringify({ type: "object", properties: { query: queryProp, budget: { type: "number", description: "큐레이터 토큰 예산 (기본 1024)" } }, required: ["query"] }),
      `retrieve 의 budget 은 number 이고 선택이다 (got ${JSON.stringify(tool("retrieve")?.inputSchema)})`,
    );
    ok(
      JSON.stringify(tool("sql.query")?.inputSchema) === JSON.stringify({ type: "object", properties: { sql: { type: "string", description: "실행할 단일 SELECT/WITH 쿼리" } }, required: ["sql"] }),
      `sql.query 의 sql 스키마 (got ${JSON.stringify(tool("sql.query")?.inputSchema)})`,
    );
    ok(
      JSON.stringify(tool("audit.explain")?.inputSchema.properties.format) === JSON.stringify({ type: "string", description: "json(기본) 또는 text" }),
      `audit.explain 의 format 스키마 (got ${JSON.stringify(tool("audit.explain")?.inputSchema.properties.format)})`,
    );
    const out = tool("route")?.outputSchema?.properties ?? {};
    // nullable 칸은 anyOf: [object, null] 이다. 타입 배열(type: ["object", "null"])은 단일 type 만 받는 클라이언트에 덜 이식적이라
    // MCP Inspector 2.8.0 의 tools/list --strict 가 경고로 센다(TC-028 의 경고 0).
    const nullableObject = (p: Json | undefined) =>
      Array.isArray(p?.anyOf) && p.anyOf.length === 2 && p.anyOf[0]?.type === "object" && JSON.stringify(p.anyOf[1]) === '{"type":"null"}';
    ok(
      JSON.stringify(out.tools) === JSON.stringify({ type: "array", items: { type: "string" }, description: "호출할 도구 이름 목록" }) &&
        nullableObject(out.graph_plan) &&
        nullableObject(out.type_pair) &&
        nullableObject(out.semantic_fallback) &&
        out.rule_margin?.type === "number" &&
        Object.keys(out).length === Object.keys(ROUTE_OUTPUT_SCHEMA).length,
      `route 의 출력 스키마가 배열 items 와 nullable 칸의 null 을 싣는다(구조화 출력 검사, TC-029) (got ${JSON.stringify(out).slice(0, 300)})`,
    );
    const typeArrays = JSON.stringify(tools.map((t) => [t.inputSchema, t.outputSchema])).match(/"type":\[/g) ?? [];
    ok(typeArrays.length === 0, `도구 스키마에 타입 배열이 없다(Inspector --strict 이식성 경고 0, TC-028) (got ${typeArrays.length})`);

    // tools/call 입력 검증(airmcp-dev/air#5): 핸들러 앞에서 막고 isError 결과로 돌려준다(Inspector exit 5).
    const call = async (name: string, args: Json | undefined) => {
      const r = (await stdio.rpc("tools/call", args === undefined ? { name } : { name, arguments: args })).result as { isError?: boolean; content?: { text?: string }[] } | undefined;
      return { isError: r?.isError === true, text: r?.content?.[0]?.text ?? JSON.stringify(r) };
    };
    for (const t of ["route", "retrieve", "ask", "audit.explain", "vector.search", "ontology.search"]) {
      const r = await call(t, { query: " " });
      ok(r.isError && r.text.includes(EMPTY_QUERY_MESSAGE), `${t} 도구가 빈 질문을 isError 로 거절한다 (got ${r.text.slice(0, 160)})`);
    }
    const xml = await call("audit.explain", { query: "현재 활성 상태인 계약 수는 몇 개야?", format: "xml" });
    ok(xml.isError && xml.text.includes('format 은 json(기본) 또는 text 만 받습니다. 받은 값: "xml"'), `audit.explain 이 format=xml 을 isError 로 거절한다 (got ${xml.text.slice(0, 160)})`);
    const longSql = await call("sql.query", { sql: "SELECT 1" + " ".repeat(MAX_INPUT_CHARS) });
    ok(longSql.isError && longSql.text.includes("SQL 이 너무 깁니다"), `sql.query 가 긴 SQL 을 isError 로 거절한다 (got ${longSql.text.slice(0, 160)})`);
    for (const t of ["retrieve", "ask"]) {
      const r = await call(t, { query: "질문", budget: 0.5 });
      ok(r.isError && r.text.includes("budget 은 1 이상의 정수"), `${t} 가 budget 0.5 를 isError 로 거절한다 (got ${r.text.slice(0, 160)})`);
    }
    const neg = await call("retrieve", { query: "Client-B가 사용 중인 제품 목록은?", budget: -1 });
    ok(neg.isError && neg.text.includes("받은 값: -1"), `retrieve 가 budget -1 을 isError 로 거절한다 (got ${neg.text.slice(0, 160)})`);
    const longRoute = await call("route", { query: longQ });
    ok(longRoute.isError && longRoute.text.includes("질문이 너무 깁니다"), `질의 도구가 긴 질문을 isError 로 거절한다 (got ${longRoute.text.slice(0, 160)})`);
    // 빠진 인자와 형이 틀린 값: air 의 검증 문장이 무엇이 와야 하는지(expected)와 받은 값을 함께 적는다(TC-042, TC-041).
    for (const args of [{}, undefined]) {
      const r = await call("sql.query", args);
      ok(r.isError && r.text.includes("sql: Required (expected: string, got: undefined)"), `sql 인자가 빠지면(${JSON.stringify(args)}) 기대한 형과 받은 값을 말한다 (got ${r.text.slice(0, 200)})`);
    }
    const nullId = await call("graph.expand", { entityId: null });
    ok(nullId.isError && nullId.text.includes("entityId: Expected number, received null"), `entityId 에 null 이 오면 형이 틀렸다고 말한다(TC-041) (got ${nullId.text.slice(0, 200)})`);
    const unknown = await stdio.rpc("tools/call", { name: "sql.delete", arguments: { sql: "DELETE FROM companyx.sales" } });
    ok(unknown.error?.code === -32601 && String(unknown.error?.message).includes("sql.delete"), `목록에 없는 도구는 실행하지 않고 JSON-RPC 오류로 거절한다 (got ${JSON.stringify(unknown)})`);

    // prompts: 목록이 인자를 싣고, get 이 인자를 템플릿에 넣는다. 빠진 필수 인자는 air 가(airmcp-dev/air#9), 빈 필수 인자는
    // prompts.ts 가 -32602 로 거절한다(랜덤 테스트 3차 X04: question="" 에 질문 칸이 빈 템플릿).
    const defs = buildPrompts();
    const listed = ((await stdio.rpc("prompts/list", {})).result?.prompts ?? []) as { name: string; arguments?: { name: string; required?: boolean; description?: string }[] }[];
    for (const p of defs) {
      const want = (p.arguments ?? []).map((a) => `${a.name}:${Boolean(a.required)}:${a.description}`).join(",");
      const have = (listed.find((x) => x.name === p.name)?.arguments ?? []).map((a) => `${a.name}:${Boolean(a.required)}:${a.description}`).join(",");
      ok(have === want, `prompts/list 가 ${p.name} 의 인자와 설명을 싣는다 (want ${want}, got ${have})`);
      const values = Object.fromEntries((p.arguments ?? []).map((a) => [a.name, `인자값-${a.name}-7`]));
      const got = await stdio.rpc("prompts/get", { name: p.name, arguments: values });
      const text = ((got.result?.messages ?? []) as { content: { text?: string } }[]).map((m) => m.content.text ?? "").join("\n");
      for (const [k, v] of Object.entries(values)) ok(text.includes(v), `prompts/get ${p.name}: 인자 ${k} 가 본문에 들어간다`);
    }
    for (const [args, missing] of [[undefined, "question, context"], [{ question: "질문" }, "context"]] as const) {
      const r = await stdio.rpc("prompts/get", args === undefined ? { name: "grounded-answer" } : { name: "grounded-answer", arguments: args });
      ok(
        r.error?.code === -32602 && r.error.message === `Missing required arguments for prompt grounded-answer: ${missing}`,
        `필수 인자가 빠지면(${missing}) 빈 칸 템플릿 대신 -32602 로 거절한다(TC-046) (got ${JSON.stringify(r).slice(0, 200)})`,
      );
    }
    for (const [name, args] of [
      ["grounded-answer", { question: "", context: "" }],
      ["grounded-answer", { question: "   ", context: "[SQL 결과] total_revenue=23859" }],
      ["nl2sql-with-schema-card", { question: "　" }],
      ["review-generated-sql", { question: "매출", sql: "" }],
    ] as const) {
      const r = await stdio.rpc("prompts/get", { name, arguments: { ...args } });
      const empty = Object.entries(args).filter(([, v]) => !v.trim()).map(([k]) => k);
      ok(
        r.error?.code === -32602 && r.error.message === `Invalid params: prompt ${name}: ${empty.join(", ")} 인자가 비어 있습니다. 내용을 넣어 주세요.`,
        `prompts/get ${name} 의 빈 필수 인자(${empty.join(", ")})는 -32602 로 거절한다 (got ${JSON.stringify(r).slice(0, 200)})`,
      );
    }
    const tc039 = await stdio.rpc("prompts/get", { name: "grounded-answer", arguments: { question: "2025년 3분기 총 매출액은 얼마야?", context: "[SQL 결과] total_revenue=23859" } });
    ok(String(tc039.result?.messages?.[0]?.content?.text ?? "").includes("[질문] 2025년 3분기 총 매출액은 얼마야?"), "값이 있는 인자는 템플릿에 들어간다(TC-039)");
    const nope = await stdio.rpc("prompts/get", { name: "nope" });
    ok(nope.error?.code === -32602 && String(nope.error?.message).includes("nope"), `없는 프롬프트는 -32602 (TC-045) (got ${JSON.stringify(nope)})`);

    // resources: 목록과 읽기, 없는 URI 는 빈 내용 대신 오류.
    const listedRes = ((await stdio.rpc("resources/list", {})).result?.resources ?? []) as { uri: string }[];
    ok(listedRes.length === resources.length, `resources/list 가 리소스 ${resources.length}종을 싣는다 (TC-030) (got ${listedRes.length})`);
    const prof = await stdio.rpc("resources/read", { uri: "profile://dataset/active" });
    const content = prof.result?.contents?.[0] as { uri?: string; mimeType?: string; text?: string } | undefined;
    ok(content?.uri === "profile://dataset/active" && content.mimeType === "application/json" && JSON.parse(content.text ?? "{}").profile !== undefined, `resources/read 가 내용을 돌려준다 (got ${JSON.stringify(prof).slice(0, 160)})`);
    const missingRes = await stdio.rpc("resources/read", { uri: "dataset://companyx/nope" });
    ok(missingRes.error?.code === -32602 && String(missingRes.error?.message).includes("dataset://companyx/nope"), `없는 리소스는 -32602 (TC-043) (got ${JSON.stringify(missingRes)})`);
  } finally {
    await stdio.close();
  }
  ok(stdio.nonJson().length === 0, `stdout 에는 JSON-RPC 줄만 나간다 (got ${JSON.stringify(stdio.nonJson()).slice(0, 200)})`);
  ok(stdio.unanswered() === 0, `보낸 요청에 모두 답했다 (남은 요청 ${stdio.unanswered()})`);

  // --- MCP Streamable HTTP(MCP_TRANSPORT=http): 바인딩과 Origin 검사(airmcp-dev/air#11), 그리고 같은 엔진 ---
  {
    const http = await startHttp(SERVER_JS, {});
    try {
      ok(http.log().includes("(127.0.0.1)"), `기본 바인딩은 루프백(127.0.0.1)이다 (got ${http.log().split("\n").find((l) => l.includes("listening")) ?? http.log().slice(-200)})`);
      const init = await http.post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "surfaces-test", version: "0" } } });
      ok(init.status === 200 && init.body.includes(`"protocolVersion":"${PROTOCOL}"`), `Origin 없는 클라이언트(Inspector CLI, SDK)는 받는다 (got ${init.status} ${init.body.slice(0, 120)})`);
      const inspector = await http.post({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { origin: "http://localhost:6274" });
      ok(inspector.status === 200 && inspector.body.includes('"name":"route"'), `MCP Inspector 웹 UI 의 출처(http://localhost:6274)는 받는다 (got ${inspector.status})`);
      const evil = await http.post({ jsonrpc: "2.0", id: 3, method: "tools/list" }, { origin: "http://attacker.example" });
      ok(evil.status === 403 && !evil.body.includes('"name":"route"'), `루프백이 아닌 Origin 은 403 이다(DNS 리바인딩 방어) (got ${evil.status} ${evil.body.slice(0, 120)})`);
      const get = await http.request("GET", "/mcp");
      ok(get.status === 405, `GET /mcp 는 405 다(서버 발신 SSE 스트림 없음) (got ${get.status})`);
      const badVersion = await http.post({ jsonrpc: "2.0", id: 4, method: "tools/list" }, { "mcp-protocol-version": "1999-01-01" });
      ok(badVersion.status === 400, `지원하지 않는 MCP-Protocol-Version 은 400 이다 (got ${badVersion.status})`);
      const blank = await http.post({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "ask", arguments: { query: "" } } });
      ok(blank.status === 200 && blank.body.includes('"isError":true') && blank.body.includes(EMPTY_QUERY_MESSAGE), `HTTP 도 같은 엔진과 입력 검증을 지난다 (got ${blank.body.slice(0, 160)})`);
    } finally {
      await http.close();
    }
    const opened = await startHttp(SERVER_JS, { MCP_ALLOWED_ORIGINS: "https://app.example.com" });
    try {
      const app = await opened.post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { origin: "https://app.example.com" });
      ok(app.status === 200, `MCP_ALLOWED_ORIGINS 에 적은 출처는 받는다 (got ${app.status})`);
      const other = await opened.post({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { origin: "https://other.example.com" });
      ok(other.status === 403, `적지 않은 출처는 여전히 403 이다 (got ${other.status})`);
    } finally {
      await opened.close();
    }
  }

  // --- MCP HTTP+SSE(MCP_TRANSPORT=sse): 바인딩과 Origin 검사(air-server/vendor 의 003 패치). 규칙은 http 와 같다 ---
  {
    const sse = await startHttp(SERVER_JS, {}, "sse");
    try {
      ok(sse.log().includes("(127.0.0.1)"), `sse 도 기본 바인딩은 루프백(127.0.0.1)이다 (got ${sse.log().split("\n").find((l) => l.includes("listening")) ?? sse.log().slice(-200)})`);
      const plain = await sse.openStream("/sse");
      ok(plain.status === 200 && /^\/message\?sessionId=/.test(plain.endpoint ?? ""), `Origin 없는 클라이언트는 /sse 로 세션을 연다 (got ${plain.status} ${plain.body.slice(0, 120)})`);
      const local = await sse.openStream("/sse", { origin: "http://localhost:6274" });
      ok(local.status === 200, `루프백 출처(http://localhost:6274)는 /sse 를 연다 (got ${local.status})`);
      const foreign = { origin: "http://attacker.example" };
      const evil = await sse.openStream("/sse", foreign);
      ok(evil.status === 403 && evil.endpoint === undefined, `루프백이 아닌 Origin 은 /sse 에서 403 이다(DNS 리바인딩 방어) (got ${evil.status} ${evil.body.slice(0, 120)})`);
      const post = await sse.request("POST", plain.endpoint ?? "/message", { jsonrpc: "2.0", id: 1, method: "tools/list" }, foreign);
      ok(post.status === 403, `열린 세션이라도 루프백이 아닌 Origin 의 POST /message 는 403 이다 (got ${post.status} ${post.body.slice(0, 120)})`);
    } finally {
      await sse.close();
    }
    const allowed = await startHttp(SERVER_JS, { MCP_ALLOWED_ORIGINS: "https://app.example.com" }, "sse");
    try {
      ok((await allowed.openStream("/sse", { origin: "https://app.example.com" })).status === 200, "sse 도 MCP_ALLOWED_ORIGINS 에 적은 출처는 받는다");
      ok((await allowed.openStream("/sse", { origin: "https://other.example.com" })).status === 403, "sse 도 적지 않은 출처는 403 이다");
    } finally {
      await allowed.close();
    }
  }

  console.log(`\nsurfaces.test: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
