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

// 라우터 셋째 단계(llmroute.ts) 테스트. 모델 없이 돈다 — 127.0.0.1 에 Ollama /api/chat 흉내를 띄워 응답의 모양마다
// 단계가 무엇을 돌려주는지 본다. 선택 정확도는 여기서 재지 않는다(npm run companyx:toolselect, 7B 필요).
// 여기서 보는 것: 기본은 꺼져 있다, 모델이 보는 도구가 tools/list 와 같다, 실패하면 규칙의 결정을 그대로 둔다.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { paramsToJsonSchema } from "@airmcp-dev/core";

import {
  firstLaneTool,
  installLlmLaneTools,
  LANE_TOOL_NAMES,
  listLaneTools,
  llmLaneToolsReady,
  llmLaneVerdict,
  llmStageEnabled,
  TOOL_SELECT_OPTIONS,
  TOOL_SELECT_SYSTEM,
  uninstallLlmLaneTools,
} from "./llmroute.js";
import { audit, GRAPH_TOOL, ONTOLOGY_TOOL, route, SQL_TOOL, VECTOR_TOOL } from "./router.js";
import { installSemanticRouter, routeQuery, uninstallSemanticRouter } from "./semroute.js";
import { buildServer } from "./server.js";
import type { Embedder } from "./embedder.js";

let pass = 0, fail = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { pass++; } else { fail++; console.error("  FAIL:", msg); }
}
function eq<T>(a: T, b: T, msg: string) { ok(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)})`); }

const saved = { stage: process.env.ROUTER_LLM_STAGE, host: process.env.OLLAMA_HOST, timeout: process.env.ROUTER_LLM_TIMEOUT_MS };

// ── 켜는 스위치 ───────────────────────────────────────────────────────
{
  delete process.env.ROUTER_LLM_STAGE;
  ok(!llmStageEnabled(), "기본은 꺼져 있다");
  for (const v of ["0", "true", "yes", " 1", ""]) {
    process.env.ROUTER_LLM_STAGE = v;
    ok(!llmStageEnabled(), `ROUTER_LLM_STAGE=${JSON.stringify(v)} 는 켜지 않는다`);
  }
  process.env.ROUTER_LLM_STAGE = "1";
  ok(llmStageEnabled(), "ROUTER_LLM_STAGE=1 만 켠다");
  delete process.env.ROUTER_LLM_STAGE;
}

// ── 모델이 보는 도구 = tools/list 의 레인 도구 넷 ────────────────────────
const served = buildServer().tools();
const lane = listLaneTools(served);
eq(lane.map((t) => t.name).sort(), [...LANE_TOOL_NAMES].sort(), "레인 도구 넷만 고른다");
for (const t of lane) {
  const def = served.find((d) => d.name === t.name)!;
  eq(t.description, def.description, `${t.name} 설명은 서버에 등록한 그대로`);
  eq(t.inputSchema, paramsToJsonSchema(def.params) ?? { type: "object", properties: {} }, `${t.name} 입력 스키마는 air 가 tools/list 에 싣는 것과 같다`);
}
eq(listLaneTools([{ name: SQL_TOOL, description: "d" }])[0].inputSchema, { type: "object", properties: {} }, "인자가 없으면 빈 object 스키마(air 와 같게)");
eq(listLaneTools([{ name: "ask" }, { name: "route" }]), [], "레인 도구가 아닌 것은 빼낸다");

// ── 본문에서 처음 부른 레인 도구 ────────────────────────────────────────
eq(firstLaneTool(`{"name": "${VECTOR_TOOL}", "arguments": {}} 다음 ${SQL_TOOL}`), VECTOR_TOOL, "가장 앞에 적힌 도구");
eq(firstLaneTool(`먼저 ${GRAPH_TOOL} 를 부르고 ${ONTOLOGY_TOOL}`), GRAPH_TOOL, "여러 호출이면 첫 호출");
eq(firstLaneTool("도구를 부르지 않고 답합니다"), null, "도구 이름이 없으면 null");

// ── Ollama /api/chat 흉내 ─────────────────────────────────────────────
type Reply = { status?: number; body?: unknown; delayMs?: number };
let reply: Reply = {};
let lastBody: Record<string, unknown> | undefined;
const fake = createServer((req: IncomingMessage, res: ServerResponse) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    lastBody = JSON.parse(raw || "{}");
    const send = () => {
      res.writeHead(reply.status ?? 200, { "content-type": "application/json" });
      res.end(JSON.stringify(reply.body ?? {}));
    };
    if (reply.delayMs) setTimeout(send, reply.delayMs);
    else send();
  });
});
await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
process.env.OLLAMA_HOST = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;

try {
  uninstallLlmLaneTools();
  const none = await llmLaneVerdict("매출 알려줘");
  ok("error" in none && /레인 도구가 0개만/.test(none.error), "도구를 걸지 않았으면 모델을 부르지 않고 실패를 돌려준다");
  eq(installLlmLaneTools(lane.filter((t) => t.name !== GRAPH_TOOL)), 3, "셋만 걸린다");
  ok(!llmLaneToolsReady(), "넷이 다 걸리지 않으면 단계가 준비되지 않은 것");
  eq(installLlmLaneTools(lane), 4, "넷을 건다");
  ok(llmLaneToolsReady(), "넷이 걸리면 준비");

  reply = { body: { message: { content: "", tool_calls: [{ function: { name: SQL_TOOL, arguments: {} } }] } } };
  const viaCall = await llmLaneVerdict("이번 분기 실적 어땠어");
  ok(!("error" in viaCall) && viaCall.lane === "nl2sql" && viaCall.tool === SQL_TOOL && viaCall.via === "tool_calls", `tool_calls 의 레인 도구 (got ${JSON.stringify(viaCall)})`);
  const body = lastBody as { options?: Record<string, unknown>; messages?: { role: string; content: string }[]; tools?: { function: { name: string } }[]; stream?: boolean };
  eq(body.options, { ...TOOL_SELECT_OPTIONS }, "생성 설정은 도구 선택 평가와 같다(temperature 0, seed 42, 상한 512)");
  eq(body.messages?.[0], { role: "system", content: TOOL_SELECT_SYSTEM }, "시스템 문장은 도구 선택 평가와 같다");
  eq(body.messages?.[1]?.content, "이번 분기 실적 어땠어", "질문을 그대로 보낸다");
  eq(body.tools?.map((t) => t.function.name).sort(), [...LANE_TOOL_NAMES].sort(), "모델에게 레인 도구 넷을 준다");
  eq(body.stream, false, "스트리밍하지 않는다");

  reply = { body: { message: { content: `{"name": "${VECTOR_TOOL}", "arguments": {"query": "설치"}}` } } };
  const viaText = await llmLaneVerdict("설치 어떻게 해");
  ok(!("error" in viaText) && viaText.lane === "vector_search" && viaText.via === "content", "본문 JSON 으로 적은 호출도 읽는다");

  reply = { body: { message: { content: "잘 모르겠습니다" } } };
  const noTool = await llmLaneVerdict("음");
  ok("error" in noTool && noTool.error === "레인 도구를 고르지 않았다", "도구를 고르지 않으면 실패");

  reply = { status: 500, body: { error: "model not found" } };
  const http500 = await llmLaneVerdict("음");
  ok("error" in http500 && http500.error === "Ollama /api/chat 500", "HTTP 오류는 상태 코드로");

  process.env.ROUTER_LLM_TIMEOUT_MS = "200";
  reply = { delayMs: 1500, body: { message: { content: SQL_TOOL } } };
  const slow = await llmLaneVerdict("음");
  ok("error" in slow && slow.ms < 1400, `시간 초과는 기다리지 않고 실패로 (got ${JSON.stringify(slow)})`);
  delete process.env.ROUTER_LLM_TIMEOUT_MS;

  // ── 라우터에 걸었을 때 ─────────────────────────────────────────────
  // 모든 문장을 같은 벡터로 보내는 임베더면 시맨틱 격차가 0 이라 시맨틱도 확신하지 못한다. 규칙도 확신하지 못하는 질문만 셋째 단계로 간다.
  const flat: Embedder = { name: "flat", dim: 2, embed: async () => [1, 0] };
  await installSemanticRouter(flat);
  const q = "주문";
  ok(!route(q).gate.confident, "규칙은 이 질문에 확신이 없다");

  reply = { body: { message: { content: "", tool_calls: [{ function: { name: SQL_TOOL } }] } } };
  const off = await routeQuery(q, flat);
  ok(off.llm === undefined && audit(off).deterministic === true, "꺼져 있으면 모델을 부르지 않고 결정론");

  process.env.ROUTER_LLM_STAGE = "1";
  const on = await routeQuery(q, flat);
  eq([on.route, on.tools, on.llm?.applied, on.llm?.tool], ["structured", [SQL_TOOL], true, SQL_TOOL], "켜면 모델이 고른 레인으로 보낸다");
  ok(/llm sql\.query -> nl2sql$/.test(on.rationale), `근거에 셋째 단계가 남는다 (got ${on.rationale})`);
  eq(audit(on).deterministic, false, "모델을 부른 결정은 deterministic=false");

  reply = { status: 503, body: {} };
  const failed = await routeQuery(q, flat);
  const rule = await (async () => { delete process.env.ROUTER_LLM_STAGE; const r = await routeQuery(q, flat); process.env.ROUTER_LLM_STAGE = "1"; return r; })();
  eq([failed.route, failed.tools], [rule.route, rule.tools], "셋째 단계가 실패하면 규칙의 결정 그대로");
  ok(failed.llm?.applied === false && /llm stage failed \(Ollama \/api\/chat 503\), rule decision kept$/.test(failed.rationale), `실패 사유를 남긴다 (got ${failed.rationale})`);
} finally {
  uninstallSemanticRouter();
  uninstallLlmLaneTools();
  fake.close();
  for (const [k, v] of [["ROUTER_LLM_STAGE", saved.stage], ["OLLAMA_HOST", saved.host], ["ROUTER_LLM_TIMEOUT_MS", saved.timeout]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

console.log(`llmroute.test: ${pass} passed, ${fail} failed`);
// buildServer 가 띄운 air 의 타이머가 프로세스를 붙잡지 않게 끝낸다.
process.exit(fail ? 1 : 0);
