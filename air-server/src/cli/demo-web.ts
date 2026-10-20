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

// 시연 화면. 질문, 답, 근거 행을 브라우저 한 화면에 보인다.
//
//   npm run demo:web          → http://127.0.0.1:3520 (DEMO_WEB_PORT 로 바꾼다)
//
// 서버(dist/index.js)를 MCP 클라이언트처럼 stdio 로 띄워 initialize, tools/list, tools/call(ask) 을 보낸다.
// 화면은 그 응답을 펼칠 뿐 값을 만들지 않는다. 서버 기동 검사(Ollama 모델, DB)가 실패하면 화면에는 실패했다는 것만 보이고 사유는 이 터미널에 찍는다.
// 서버가 끝나 있으면 다음 질문 때 다시 띄운다(원인을 고친 뒤 화면을 다시 켜지 않고 다시 물으면 된다).
// 같은 기기의 브라우저만 받는다(127.0.0.1 에만 붙고, Host 머리가 다르면 403).
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpConnection, McpStdioClient, allowedHost, handshake, renderPage, routeSummary, splitAnswer, toolPayload } from "../demoweb.js";

const here = dirname(fileURLToPath(import.meta.url));
const VERSION: string = JSON.parse(readFileSync(resolve(here, "..", "..", "package.json"), "utf8")).version;
const PORT = Number(process.env.DEMO_WEB_PORT ?? 3520);
const DATASET = process.env.DATASET ?? "companyx";
/** 7B 를 처음 부르는 호출은 모델 적재 때문에 리허설에서 52.8초가 걸렸다. 넉넉히 둔다. */
const ASK_TIMEOUT_MS = Number(process.env.DEMO_WEB_ASK_TIMEOUT_MS ?? 180_000);

// 서버는 stdio 로만 띄운다. 셸에 남은 네트워크 전송 설정이 있으면 지운다.
const env: NodeJS.ProcessEnv = { ...process.env, DATASET };
for (const k of ["MCP_TRANSPORT", "MCP_PORT", "MCP_HOST", "MCP_ALLOWED_ORIGINS"]) delete env[k];

const FAILED = "MCP 서버를 띄우지 못했다. 사유는 demo:web 을 띄운 터미널에 찍었다. 다시 물으면 서버를 새로 띄운다.";
const ENDED = "MCP 서버가 답하는 도중에 끝났다. 사유는 demo:web 을 띄운 터미널에 찍었다. 다음 질문 때 서버를 새로 띄운다.";
const conn = new McpConnection(
  () =>
    new McpStdioClient(process.execPath, [resolve(here, "..", "index.js")], env, (reason, stderr) =>
      console.error(`${reason}. 서버 stderr 끝부분:
${stderr.slice(-1500)}`),
    ),
  (c) => handshake(c, VERSION, ASK_TIMEOUT_MS),
);

/** 붙어 있는 서버. 끝나 있으면 새로 띄운다. 붙지 못하면 null. */
async function connected(): Promise<McpStdioClient | null> {
  const before = conn.starts();
  try {
    const c = await conn.get();
    if (conn.starts() !== before) console.log(`MCP 서버 ${before ? "다시 띄워 " : ""}연결됨: 도구 ${conn.status().tools}종`);
    return c;
  } catch (e) {
    // 사유(서버 stderr 끝부분 포함)는 이 터미널에만 찍는다. 화면에는 고정 문구만 보낸다. DB 장애 답이 원인 코드까지만 싣고 고칠 단서는
    // 서버 로그에 남기는 것과 같은 원칙이다(CodeQL js/stack-trace-exposure, PR #269).
    console.error(`MCP 서버에 붙지 못했다:\n${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}


function send(res: ServerResponse, code: number, body: string, type = "application/json; charset=utf-8") {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}

/** 본문을 바이트로 모은 뒤 한 번에 UTF-8 로 푼다. 조각마다 문자열로 바꾸면 조각 경계에 걸린 한글 한 글자가 깨진다. */
async function readBody(req: IncomingMessage): Promise<string> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > 20_000) throw new Error("요청이 너무 크다");
    parts.push(chunk);
  }
  return Buffer.concat(parts).toString("utf8");
}

const server = createServer(async (req, res) => {
  if (!allowedHost(req.headers.host, PORT)) return send(res, 403, JSON.stringify({ error: "이 화면은 같은 기기에서만 연다" }));
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  if (req.method === "GET" && url.pathname === "/") return send(res, 200, renderPage({ dataset: DATASET, version: VERSION }), "text/html; charset=utf-8");
  if (req.method === "GET" && url.pathname === "/api/status") {
    const s = conn.status();
    return send(res, 200, JSON.stringify({ ready: s.state === "ready", tools: s.tools, error: s.state === "down" ? FAILED : null }));
  }
  if (req.method === "POST" && url.pathname === "/api/ask") {
    // 다른 사이트의 폼이 보낼 수 있는 단순 요청(form, text/plain)은 받지 않는다. JSON 은 브라우저가 사전 요청을 거치게 한다.
    if (!(req.headers["content-type"] ?? "").startsWith("application/json")) return send(res, 415, JSON.stringify({ ok: false, error: "JSON 으로 보낸다" }));
    const started = Date.now();
    let query = "";
    try {
      query = String((JSON.parse(await readBody(req)) as { query?: unknown }).query ?? "").trim();
    } catch {
      return send(res, 400, JSON.stringify({ ok: false, ms: 0, error: "요청 본문을 읽지 못했다" }));
    }
    if (!query) return send(res, 400, JSON.stringify({ ok: false, ms: 0, error: "질문이 비어 있다" }));
    const request = { method: "tools/call", params: { name: "ask", arguments: { query } } };
    const before = conn.starts();
    const client = await connected();
    if (!client) return send(res, 200, JSON.stringify({ ok: false, ms: Date.now() - started, request, error: FAILED }));
    const restarted = before > 0 && conn.starts() !== before;
    try {
      const reply = await client.request(request.method, request.params, ASK_TIMEOUT_MS);
      const ms = Date.now() - started;
      if (reply.error) return send(res, 200, JSON.stringify({ ok: false, ms, request, raw: reply, error: JSON.stringify(reply.error) }));
      const { isError, value } = toolPayload(reply.result as Record<string, unknown> | undefined);
      if (isError || typeof value !== "object" || value === null) {
        return send(res, 200, JSON.stringify({ ok: false, ms, request, raw: reply, error: typeof value === "string" ? value : "도구가 오류를 돌려줬다" }));
      }
      const v = value as { answer?: string; route?: string; audit?: { routing?: { rationale?: string } } };
      const { text, rows } = splitAnswer(v.answer ?? "");
      const view = { route: v.route, text, rows, summary: routeSummary(v.audit?.routing?.rationale ?? ""), audit: v.audit };
      return send(res, 200, JSON.stringify({ ok: true, ms, request, raw: reply, view, restarted }));
    } catch (e) {
      console.error(`ask 실패(${query}):\n${e instanceof Error ? e.message : String(e)}`);
      const error = client.exitReason() ? ENDED : "MCP 서버가 정한 시간 안에 답하지 않았다. 사유는 demo:web 을 띄운 터미널에 찍었다.";
      return send(res, 200, JSON.stringify({ ok: false, ms: Date.now() - started, request, error }));
    }
  }
  send(res, 404, JSON.stringify({ error: "없는 경로" }));
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`시연 화면: http://127.0.0.1:${PORT}  (데이터셋 ${DATASET}, 끝내려면 Ctrl+C)`);
  void connected();
});

async function stop() {
  server.close();
  await conn.close();
  process.exitCode = 0;
}
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
