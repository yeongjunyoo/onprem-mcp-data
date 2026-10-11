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

// 3단계 라우터의 셋째 단계 — 규칙도 시맨틱도 확신하지 못한 질문만 생성 모델이 레인 도구 설명을 읽고 고른다
// (리원에이스 멘토 서면 답변 10-03 Q1: 규칙 → 시맨틱 → LLM). **기본은 꺼져 있다.** ROUTER_LLM_STAGE=1 일 때만 돈다.
//
// 모델이 보는 것은 MCP tools/list 가 내보내는 레인 도구 넷(sql.query, vector.search, ontology.search, graph.expand)의
// 설명과 입력 스키마 그대로다. 시스템 문장과 생성 설정은 도구 선택 평가(cli/companyx-llm-toolselect-eval.ts)와 같은
// 상수를 쓴다. 그래야 그 평가에서 잰 선택 정확도가 이 단계의 정확도다.
//
// 켜면 라우팅이 생성 모델을 부른다. temperature 0, seed 42 라 같은 질문에 같은 답을 내지만(개발 150문항 두 번 실행에서
// 본문까지 같았다) 규칙과 임베딩만 쓰는 결정론과는 다르다. 그래서 이 단계를 거친 결정은 route 출력과 감사 레코드에
// deterministic=false 로 남는다.
import { postJson } from "./ollamahttp.js";
import { DEFAULT_MODEL } from "./llm.js";
import { SQL_TOOL, VECTOR_TOOL, ONTOLOGY_TOOL, GRAPH_TOOL, type Lane } from "./router.js";

export const LLM_STAGE_ENV = "ROUTER_LLM_STAGE";

/** 셋째 단계가 켜졌는가. 값이 정확히 "1" 일 때만이다. */
export function llmStageEnabled(): boolean {
  return process.env[LLM_STAGE_ENV] === "1";
}

export const LANE_TOOL_NAMES: readonly string[] = [SQL_TOOL, VECTOR_TOOL, ONTOLOGY_TOOL, GRAPH_TOOL];
export const LANE_OF_TOOL: Readonly<Record<string, Lane>> = {
  [SQL_TOOL]: "nl2sql",
  [VECTOR_TOOL]: "vector_search",
  [ONTOLOGY_TOOL]: "knowledge_graph",
  [GRAPH_TOOL]: "knowledge_graph",
};

/** 도구를 고르게 하는 시스템 문장. 도구 선택 평가와 같은 문장이다. */
export const TOOL_SELECT_SYSTEM =
  "당신은 사내 데이터 질의 어시스턴트입니다. 사용자 질문에 답하려면 먼저 제공된 도구 중 하나를 호출해 " +
  "데이터를 가져와야 합니다. 질문에 가장 알맞은 도구 하나를 골라 호출하세요.";

/** 생성 설정. num_predict 는 상한이다. 도구 호출 하나는 200토큰을 넘지 않는데, 상한이 없으면 Ollama 는 끝없이
 * 생성한다(-1 기본값에 문맥 이동). 2026-10-11 설명 변형 하나에서 반복 생성이 2만 토큰을 넘겨 평가의 fetch 가 5분 만에
 * 끊겼다. 상한 안에서 끝나는 출력은 탐욕 디코딩이라 상한이 있든 없든 같다. */
export const TOOL_SELECT_OPTIONS = { temperature: 0, seed: 42, num_ctx: 8192, num_predict: 512 } as const;

export interface LaneToolSpec {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

let TOOLS: LaneToolSpec[] = [];

/** tools/list 로 받은 도구 중 레인 도구 넷을 셋째 단계에 건다. 건 개수를 돌려준다. */
export function installLlmLaneTools(tools: LaneToolSpec[]): number {
  TOOLS = tools.filter((t) => LANE_TOOL_NAMES.includes(t.name));
  return TOOLS.length;
}

/** 테스트와 평가용. 건 도구를 비운다. */
export function uninstallLlmLaneTools(): void {
  TOOLS = [];
}

/** 레인 도구 넷이 다 걸렸는가. 하나라도 빠지면 모델이 고를 수 없는 레인이 생기므로 단계를 돌리지 않는다. */
export function llmLaneToolsReady(): boolean {
  return TOOLS.length === LANE_TOOL_NAMES.length;
}

/** 서버 안에서 tools/list 와 같은 스키마를 얻는다. air 가 도구를 등록하는 길(paramsToZodSchema(...).shape →
 * SDK registerTool)을 메모리 안의 MCP 서버에 그대로 밟고 listTools 로 읽는다. 스키마를 손으로 옮겨 적으면
 * 평가에서 잰 입력과 서버의 입력이 갈린다. */
export async function listLaneTools(
  defs: readonly { name: string; description?: string; params?: Record<string, unknown> }[],
): Promise<LaneToolSpec[]> {
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { paramsToZodSchema } = await import("@airmcp-dev/core");
  const mcp = new McpServer({ name: "lane-tools", version: "0" });
  for (const d of defs.filter((x) => LANE_TOOL_NAMES.includes(x.name))) {
    const schema = paramsToZodSchema(d.params as Parameters<typeof paramsToZodSchema>[0]);
    mcp.registerTool(
      d.name,
      { ...(d.description ? { description: d.description } : {}), ...(schema ? { inputSchema: schema.shape } : {}) },
      async () => ({ content: [] }),
    );
  }
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await mcp.connect(serverSide);
  const client = new Client({ name: "lane-tools", version: "0" });
  await client.connect(clientSide);
  try {
    const { tools } = await client.listTools();
    return tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema as Record<string, unknown> }));
  } finally {
    await client.close();
    await mcp.close();
  }
}

/** 본문에서 처음 부른 레인 도구. 7B 는 호출을 tool_calls 대신 본문 JSON 으로 적고, 여러 호출을 잇달아 적기도 한다
 * (개발 150문항 기준 선택의 99%가 본문이었다). 이름이 둘 이상이면 가장 앞에 적힌 것이 모델의 첫 호출이다. */
export function firstLaneTool(text: string): string | null {
  let best: { name: string; at: number } | null = null;
  for (const name of LANE_TOOL_NAMES) {
    const at = text.indexOf(name);
    if (at >= 0 && (!best || at < best.at)) best = { name, at };
  }
  return best?.name ?? null;
}

function stageTimeoutMs(): number {
  const n = Number(process.env.ROUTER_LLM_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 30_000;
}

export type LlmLaneVerdict =
  | { lane: Lane; tool: string; via: "tool_calls" | "content"; ms: number }
  | { error: string; ms: number };

/** 레인 도구 넷 중 하나를 고르게 하고 그 레인을 돌려준다. 실패(시간 초과, HTTP 오류, 레인 도구 아닌 답)는 error 로
 * 돌려준다. 고르지 못한 것을 어느 레인으로 메꾸지 않는다 — 부르는 쪽이 규칙의 결정을 그대로 두고 그 사실을 남긴다. */
export async function llmLaneVerdict(query: string): Promise<LlmLaneVerdict> {
  const t0 = Date.now();
  if (!llmLaneToolsReady()) return { error: `레인 도구가 ${TOOLS.length}개만 걸려 있다`, ms: 0 };
  const host = process.env.OLLAMA_HOST ?? "http://localhost:11434";
  try {
    const res = await postJson(
      `${host}/api/chat`,
      {
        model: process.env.OLLAMA_MODEL ?? DEFAULT_MODEL,
        stream: false,
        options: TOOL_SELECT_OPTIONS,
        messages: [
          { role: "system", content: TOOL_SELECT_SYSTEM },
          { role: "user", content: query },
        ],
        tools: TOOLS.map((t) => ({
          type: "function",
          function: { name: t.name, description: t.description ?? "", parameters: t.inputSchema ?? { type: "object", properties: {} } },
        })),
      },
      AbortSignal.timeout(stageTimeoutMs()),
    );
    if (res.status < 200 || res.status >= 300) return { error: `Ollama /api/chat ${res.status}`, ms: Date.now() - t0 };
    const data = JSON.parse(res.text) as { message?: { content?: string; tool_calls?: { function?: { name?: string } }[] } };
    const called = data.message?.tool_calls?.map((c) => c.function?.name ?? "").find((n) => LANE_TOOL_NAMES.includes(n));
    if (called) return { lane: LANE_OF_TOOL[called], tool: called, via: "tool_calls", ms: Date.now() - t0 };
    const named = firstLaneTool(data.message?.content ?? "");
    if (named) return { lane: LANE_OF_TOOL[named], tool: named, via: "content", ms: Date.now() - t0 };
    return { error: "레인 도구를 고르지 않았다", ms: Date.now() - t0 };
  } catch (e) {
    // 실패(시간 초과, 연결 오류)는 error 로 돌려준다. 부르는 쪽(semroute.ts llmStage)이 규칙의 결정을 그대로 두고
    // 결정의 llm.error 와 rationale 에 「llm stage failed」로 사유를 남긴다.
    return { error: String(e instanceof Error ? e.message : e).slice(0, 160), ms: Date.now() - t0 };
  }
}
