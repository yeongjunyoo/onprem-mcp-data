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

// air 0.5.2 프로토콜 엔진이 main(air 0.3.0, 곧 MCP SDK 1.31 McpServer)과 같은 MCP 응답을 내게 한다.
//
// air 0.5.0 은 SDK 를 걷어내고 자체 엔진(protocol/mcp-protocol.js)을 넣었다. 같은 요청에 그 엔진이 내는 응답은
// main 과 이만큼 달랐다(2026-10-11 실측, 같은 요청 60건을 두 서버에 보냄).
//   - tools/list: 입력 스키마가 refine 한 인자의 설명을 버리고 budget 을 string 으로 적는다. route 의 출력 스키마는
//     nullable 칸을 string 으로 적어, 출력 스키마로 structuredContent 를 검사하는 클라이언트(MCP SDK 1.31 Client 실측)가
//     route 호출을 「Structured content does not match the tool's output schema」 오류로 끝낸다.
//   - tools/call: 입력 검증 오류가 isError 없이 「[Validation] Invalid parameters ...」 문장으로 나간다. 도구 결과를
//     content 배열로만 옮기므로 isError 를 낼 길이 없다(Inspector 의 exit 5 를 보는 TC-041, 042, 빈 질문 항목이 달라진다).
//   - prompts/get: 필수 인자를 검사하지 않고 빈 칸 템플릿을 돌려준다(TC-046). 결과에 resultType 이 붙는다.
//   - resources/read, 없는 프롬프트, 모르는 메서드: 오류 문장이 다르다(TC-043, 045).
//   - initialize: 2025-06-18, 2025-03-26 을 요청해도 2025-11-25 로 답한다.
//
// 그래서 main 이 처리하던 메서드는 main 의 SDK 가 쓰던 함수 그대로(스키마 변환, 검증, 오류 문장) 여기서 답하고,
// 도구 실행만 air 엔진에 넘긴다. 도구 실행은 air 의 미들웨어 체인(플러그인 8종)을 그대로 지난다.
// air 엔진이 새로 받는 2026-07-28 판(server/discover, 요청별 _meta)은 열지 않는다. 그 판의 tools/list 와 tools/call 도 위와
// 같은 스키마, 검증 결함을 그대로 낸다. main 처럼 2025-11-25 이하로만 협상하고, --protocol-era auto 로 붙는 클라이언트도
// initialize 로 돌아온다(TC-018). HTTP 전송도 같다(세션 없이 요청마다 받는 Streamable HTTP).
//
// 엔진 클래스는 패키지가 내보내지 않으므로 패키지 진입점 옆의 파일을 직접 연다. 파일이나 메서드가 없으면
// 조용히 넘어가지 않고 기동을 멈춘다. 상류가 위 차이를 고치면 해당 갈래를 지운다.
import { paramsToZodSchema } from "@airmcp-dev/core";
import {
  CallToolRequestSchema,
  ErrorCode,
  GetPromptRequestSchema,
  InitializeRequestSchema,
  LATEST_PROTOCOL_VERSION,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  PingRequestSchema,
  ReadResourceRequestSchema,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "@modelcontextprotocol/sdk/types.js";
import { getParseErrorMessage, normalizeObjectSchema, safeParseAsync } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { parseWithCompat, toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import { randomUUID } from "node:crypto";
import { promptArgsShape } from "./promptargs.js";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
interface Message {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Json;
}
interface Engine {
  config: { name: string; tools: Json[]; resources: Json[]; prompts: Json[] };
  serverInfo: { name: string; version: string };
  handleMessage(message: Message): Promise<Json>;
}

const CAPABILITIES = { tools: { listChanged: true }, resources: { listChanged: true }, prompts: { listChanged: true } };

const engineUrl = new URL("./protocol/mcp-protocol.js", import.meta.resolve("@airmcp-dev/core"));
const engineModule = (await import(engineUrl.href).catch(() => ({}))) as { McpProtocolEngine?: { prototype: Engine } };
const found = engineModule.McpProtocolEngine?.prototype;
if (!found || typeof found.handleMessage !== "function") {
  throw new Error(`air 프로토콜 엔진을 찾지 못했다(${engineUrl.href}). @airmcp-dev/core 판이 바뀌었다면 mcpcompat.ts 를 다시 맞춘다.`);
}
const proto: Engine = found;
const airHandleMessage = proto.handleMessage;

let installed = false;

/** 엔진에 한 번 건다. 알림(id 없는 메시지)은 air 엔진이 그대로 받는다. 전송이 알림에는 답하지 않는다. */
export function installMcpCompat(): void {
  if (installed) return;
  installed = true;
  proto.handleMessage = async function (this: Engine, message: Message) {
    if (message.id === undefined) return airHandleMessage.call(this, message);
    try {
      return { jsonrpc: "2.0", id: message.id, result: await legacy(this, message) };
    } catch (e) {
      // SDK 의 Protocol 처럼 던진 오류를 JSON-RPC 오류로 돌려준다. 숫자 코드가 없으면 -32603 이다.
      const err = e as { code?: unknown; message?: string };
      const code = typeof err.code === "number" && Number.isSafeInteger(err.code) ? err.code : ErrorCode.InternalError;
      return { jsonrpc: "2.0", id: message.id, error: { code, message: err.message ?? "Internal error" } };
    }
  };
}

/** main 의 SDK 가 받던 메서드만 받는다. 나머지는 SDK 처럼 「Method not found」. */
async function legacy(engine: Engine, message: Message): Promise<Json> {
  const params = message.params ?? {};
  switch (message.method) {
    case "initialize": {
      parseWithCompat(InitializeRequestSchema, message);
      const requested = params.protocolVersion as string;
      return {
        protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL_VERSION,
        capabilities: CAPABILITIES,
        serverInfo: engine.serverInfo,
      };
    }
    case "ping":
      parseWithCompat(PingRequestSchema, message);
      return {};
    case "tools/list":
      parseWithCompat(ListToolsRequestSchema, message);
      return { tools: engine.config.tools.map(toolDefinition) };
    case "tools/call":
      parseWithCompat(CallToolRequestSchema, message);
      return callTool(engine, message);
    case "prompts/list":
      parseWithCompat(ListPromptsRequestSchema, message);
      return result(await airHandleMessage.call(engine, message));
    case "prompts/get":
      parseWithCompat(GetPromptRequestSchema, message);
      return getPrompt(engine, params);
    case "resources/list":
      parseWithCompat(ListResourcesRequestSchema, message);
      return result(await airHandleMessage.call(engine, message));
    case "resources/templates/list":
      parseWithCompat(ListResourceTemplatesRequestSchema, message);
      return result(await airHandleMessage.call(engine, message));
    case "resources/read":
      parseWithCompat(ReadResourceRequestSchema, message);
      return readResource(engine, params.uri as string);
    default:
      throw Object.assign(new Error("Method not found"), { code: ErrorCode.MethodNotFound });
  }
}

function result(reply: Json): Json {
  if (reply.error) throw Object.assign(new Error(reply.error.message), { code: reply.error.code });
  return reply.result;
}

/** air 0.3.0 이 SDK registerTool 에 넘기던 모양(zod shape)과 SDK 의 JSON Schema 변환. */
const shapeOf = (params: unknown) => paramsToZodSchema(params as never)?.shape;

function toolDefinition(tool: Json): Json {
  const { title, ...hints } = (tool.annotations ?? {}) as Json;
  const input = normalizeObjectSchema(shapeOf(tool.params));
  const def: Json = {
    name: tool.name,
    title,
    description: tool.description,
    inputSchema: input ? toJsonSchemaCompat(input, { strictUnions: true, pipeStrategy: "input" }) : { type: "object", properties: {} },
    annotations: Object.keys(hints).length ? hints : undefined,
    execution: { taskSupport: "forbidden" }, // SDK registerTool 의 기본값
  };
  const output = normalizeObjectSchema(shapeOf(tool.outputSchema));
  if (output) def.outputSchema = toJsonSchemaCompat(output, { strictUnions: true, pipeStrategy: "output" });
  return def;
}

const toolError = (text: string) => ({ content: [{ type: "text", text }], isError: true });

async function callTool(engine: Engine, message: Message): Promise<Json> {
  const { name, arguments: args } = message.params as { name: string; arguments?: Json };
  const tool = engine.config.tools.find((t) => t.name === name);
  if (!tool) return toolError(new McpError(ErrorCode.InvalidParams, `Tool ${name} not found`).message);
  const input = normalizeObjectSchema(shapeOf(tool.params));
  let parsed = args;
  if (input) {
    const r = await safeParseAsync(input, args);
    if (!r.success) {
      const msg = getParseErrorMessage(r.error);
      return toolError(new McpError(ErrorCode.InvalidParams, `Input validation error: Invalid arguments for tool ${name}: ${msg}`).message);
    }
    parsed = r.data as Json;
  }
  const out = result(await airHandleMessage.call(engine, { ...message, params: { ...message.params, arguments: parsed ?? {} } }));
  // 출력 스키마가 있으면 SDK 처럼 structuredContent 를 검사한다(route).
  const output = normalizeObjectSchema(shapeOf(tool.outputSchema));
  if (output && !out.isError) {
    if (!out.structuredContent) {
      return toolError(new McpError(ErrorCode.InvalidParams, `Output validation error: Tool ${name} has an output schema but no structured content was provided`).message);
    }
    const r = await safeParseAsync(output, out.structuredContent);
    if (!r.success) {
      const msg = getParseErrorMessage(r.error);
      return toolError(new McpError(ErrorCode.InvalidParams, `Output validation error: Invalid structured content for tool ${name}: ${msg}`).message);
    }
  }
  return out;
}

async function getPrompt(engine: Engine, params: Json): Promise<Json> {
  const prompt = engine.config.prompts.find((p) => p.name === params.name);
  if (!prompt) throw new McpError(ErrorCode.InvalidParams, `Prompt ${params.name} not found`);
  let args = params.arguments as Json | undefined;
  const schema = prompt.arguments?.length ? normalizeObjectSchema(promptArgsShape(prompt.arguments)) : undefined;
  if (schema) {
    const r = await safeParseAsync(schema, args);
    if (!r.success) {
      throw new McpError(ErrorCode.InvalidParams, `Invalid arguments for prompt ${params.name}: ${getParseErrorMessage(r.error)}`);
    }
    args = r.data as Json;
  }
  const messages = (await prompt.handler(args ?? {})) as { role: string; content: string }[];
  return { messages: messages.map((m) => ({ role: m.role, content: { type: "text", text: m.content } })) };
}

async function readResource(engine: Engine, raw: string): Promise<Json> {
  const uri = new URL(raw);
  const resource = engine.config.resources.find((r) => r.uri === uri.toString());
  if (!resource) throw new McpError(ErrorCode.InvalidParams, `Resource ${uri} not found`);
  const got = await resource.handler(uri.href, { requestId: randomUUID(), serverName: engine.config.name });
  const content =
    typeof got === "string"
      ? { uri: uri.href, text: got }
      : "text" in got
        ? { uri: uri.href, text: got.text, mimeType: got.mimeType }
        : { uri: uri.href, blob: got.blob, mimeType: got.mimeType };
  return { contents: [content] };
}
