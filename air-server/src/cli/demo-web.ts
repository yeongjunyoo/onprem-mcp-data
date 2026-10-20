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
// 화면은 그 응답을 펼칠 뿐 값을 만들지 않는다. 서버 기동 검사(Ollama 모델, DB)가 실패하면 그 사유를 화면에 그대로 보인다.
// 같은 기기의 브라우저만 받는다(127.0.0.1 에만 붙고, Host 머리가 다르면 403).
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpStdioClient, allowedHost, renderPage, routeSummary, splitAnswer, toolPayload } from "../demoweb.js";

const here = dirname(fileURLToPath(import.meta.url));
const VERSION: string = JSON.parse(readFileSync(resolve(here, "..", "..", "package.json"), "utf8")).version;
const PORT = Number(process.env.DEMO_WEB_PORT ?? 3520);
const DATASET = process.env.DATASET ?? "companyx";
/** 7B 를 처음 부르는 호출은 모델 적재 때문에 리허설에서 52.8초가 걸렸다. 넉넉히 둔다. */
const ASK_TIMEOUT_MS = Number(process.env.DEMO_WEB_ASK_TIMEOUT_MS ?? 180_000);

// 서버는 stdio 로만 띄운다. 셸에 남은 네트워크 전송 설정이 있으면 지운다.
const env: NodeJS.ProcessEnv = { ...process.env, DATASET };
for (const k of ["MCP_TRANSPORT", "MCP_PORT", "MCP_HOST", "MCP_ALLOWED_ORIGINS"]) delete env[k];

const client = new McpStdioClient(process.execPath, [resolve(here, "..", "index.js")], env);
const state: { ready: boolean; tools: number; error: string | null } = { ready: false, tools: 0, error: null };

async function connect() {
  try {
    await client.request(
      "initialize",
      { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "onprem-mcp-data demo-web", version: VERSION } },
      ASK_TIMEOUT_MS,
    );
    client.notify("notifications/initialized");
    const list = await client.request("tools/list", {}, 30_000);
    const tools = ((list.result as { tools?: unknown[] } | undefined)?.tools ?? []).length;
    Object.assign(state, { ready: true, tools });
    console.log(`MCP 서버 연결됨: 도구 ${tools}종`);
  } catch (e) {
    state.error = e instanceof Error ? e.message : String(e);
    console.error(`MCP 서버에 붙지 못했다:\n${state.error}`);
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
    const error = state.error ?? client.exitReason();
    return send(res, 200, JSON.stringify({ ready: state.ready && !error, tools: state.tools, error: error ? `${error}\n\n${client.stderr().slice(-1500)}` : null }));
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
      return send(res, 200, JSON.stringify({ ok: true, ms, request, raw: reply, view }));
    } catch (e) {
      return send(res, 200, JSON.stringify({ ok: false, ms: Date.now() - started, request, error: e instanceof Error ? e.message : String(e) }));
    }
  }
  send(res, 404, JSON.stringify({ error: "없는 경로" }));
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`시연 화면: http://127.0.0.1:${PORT}  (데이터셋 ${DATASET}, 끝내려면 Ctrl+C)`);
  void connect();
});

async function stop() {
  server.close();
  await client.close();
  process.exitCode = 0;
}
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
