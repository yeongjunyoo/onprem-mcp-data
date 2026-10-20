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

// LLM 자율 도구 선택 대 규칙 라우터 — 같은 문항, 같은 도구 설명으로 비교한다
// (리원에이스 멘토링 09-22 제안 ⑤).
//
// MCP 표준 방식은 호스트 LLM 이 tools/list 의 description 을 읽고 도구를 고르는 것이다.
// 그 방식으로 규칙 라우터를 걷어낼 수 있는지를 재려면, LLM 이 보는 설명이 서버가 실제로
// 내보내는 설명이어야 한다. 그래서 설명을 여기 베끼지 않고 stdio 서버를 띄워
// tools/list 로 받는다.
//
// 후보 도구는 레인 도구 넷(sql.query, vector.search, ontology.search, graph.expand)이다.
// route, retrieve, ask, audit.explain 은 안에서 라우터를 부르므로, 이들을 후보에 넣으면
// 「라우터를 대체할 수 있는가」가 아니라 「라우터를 부를 줄 아는가」를 재게 된다.
//
// 모델은 서버 기본 생성 모델(qwen2.5-coder:7b), temperature 0, seed 42. Ollama 의
// 네이티브 도구 호출(/api/chat tools)을 쓴다. 채점은 도구 이름 → 레인 매핑의 문자열
// 일치이며 LLM 판정자는 없다.
//
// 사용: npm run companyx:toolselect   (EMBEDDER=ollama, Ollama 필요)
//       TOOLSELECT_SETS=holdout4 로 봉인 세트만 따로 잰다.
//       TOOLSELECT_OUT=eval/results/<이름>.json 으로 결과 파일 경로를 바꾼다.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { requireCompanyxProfile, loadGraph } from "../companyx.js";
import { route, installOntology } from "../router.js";
import { routeQuery, installSemanticRouter } from "../semroute.js";
import { getEmbedder } from "../embedder.js";
import { DEFAULT_MODEL } from "../llm.js";
import { TOOL_SELECT_OPTIONS, TOOL_SELECT_SYSTEM, installLlmLaneTools, listLaneTools, llmStageEnabled } from "../llmroute.js";
import { buildServer } from "../server.js";

const HOST = process.env.OLLAMA_HOST ?? "http://localhost:11434";
const MODEL = process.env.OLLAMA_MODEL ?? DEFAULT_MODEL;
const LANE_TOOLS = ["sql.query", "vector.search", "ontology.search", "graph.expand"];
const LANE_OF_TOOL: Record<string, string> = {
  "sql.query": "nl2sql",
  "vector.search": "vector_search",
  "ontology.search": "knowledge_graph",
  "graph.expand": "knowledge_graph",
};
const LANE_OF_ROUTE: Record<string, string> = {
  structured: "nl2sql",
  semantic: "vector_search",
  graph: "knowledge_graph",
  hybrid: "hybrid",
};

/** 본문에서 가장 먼저 나오는 레인 도구 이름. 없으면 null. */
function firstNamedTool(content: string): string | null {
  let first: string | null = null;
  let at = Infinity;
  for (const t of LANE_TOOLS) {
    const i = content.indexOf(t);
    if (i >= 0 && i < at) [first, at] = [t, i];
  }
  return first;
}
// 시스템 문장과 생성 설정은 라우터 셋째 단계(llmroute.ts)와 같은 상수다. 여기서 잰 선택 정확도가 그 단계의 정확도다.
// 생성 설정의 num_predict 상한이 왜 있는지는 llmroute.ts 에 적었다.
const GEN_OPTIONS = TOOL_SELECT_OPTIONS;
const SYSTEM = TOOL_SELECT_SYSTEM;

const SETS: Record<string, { path: string; label: "tool" | "expected" }> = {
  sponsor30: { path: "datasets/companyx-v1.0/questions.json", label: "tool" },
  holdout1: { path: "eval/companyx/holdout_route.json", label: "expected" },
  holdout2: { path: "eval/companyx/holdout2_route.json", label: "expected" },
  holdout3: { path: "eval/companyx/holdout3_route.json", label: "expected" },
  holdout4: { path: "eval/companyx/holdout4_route.json", label: "expected" },
};

interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/** stdio 서버를 띄워 tools/list 만 받고 내린다. */
async function listServerTools(root: string): Promise<McpTool[]> {
  const server = spawn(process.execPath, ["air-server/dist/index.js"], {
    cwd: root,
    env: { ...process.env, MCP_TRANSPORT: "" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buf = "";
  let err = "";
  const got = new Map<number, { result?: { tools?: McpTool[] } }>();
  server.stdout.on("data", (c) => {
    buf += c;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("{")) continue;
      try {
        const m = JSON.parse(line);
        if (m.id !== undefined) got.set(m.id, m);
      } catch {
        /* 부분 프레임 */
      }
    }
  });
  server.stderr.on("data", (d) => (err += d));
  const send = (method: string, params: unknown, id: number) =>
    server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  const wait = async (id: number, s = 120) => {
    for (let i = 0; i < s * 5; i++) {
      if (got.has(id)) return got.get(id);
      if (server.exitCode !== null) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    return undefined;
  };
  try {
    for (let i = 0; i < 180 && !err.includes("Starting"); i++) await new Promise((r) => setTimeout(r, 1000));
    if (!err.includes("Starting")) throw new Error(`stdio 서버가 뜨지 않았다: ${err.slice(-400)}`);
    send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "toolselect-eval", version: "1" } }, 1);
    if (!(await wait(1))) throw new Error("initialize 응답 없음");
    send("tools/list", {}, 2);
    const r = await wait(2);
    const tools = r?.result?.tools ?? [];
    if (!tools.length) throw new Error("tools/list 가 비었다");
    return tools;
  } finally {
    server.kill();
  }
}

type Choice = { tool: string | null; via: string; ms: number; raw?: string };

async function chooseTool(q: string, tools: McpTool[]): Promise<Choice> {
  const t0 = Date.now();
  const res = await fetch(`${HOST}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      stream: false,
      options: GEN_OPTIONS,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: q },
      ],
      tools: tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description ?? "", parameters: t.inputSchema ?? { type: "object", properties: {} } },
      })),
    }),
  });
  if (!res.ok) throw new Error(`Ollama /api/chat ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { message?: { content?: string; tool_calls?: { function?: { name?: string } }[] } };
  const called = data.message?.tool_calls?.[0]?.function?.name;
  if (called) return { tool: called, via: "tool_calls", ms: Date.now() - t0, raw: JSON.stringify(data.message?.tool_calls).slice(0, 300) };
  // qwen2.5-coder 는 호출을 tool_calls 필드 대신 본문에 JSON 으로 적기도 한다. 호스트마다
  // 파싱이 다르므로, 본문에 도구 이름이 있으면 그것을 선택으로 읽고 경로를 따로 센다.
  // 이것을 빼면 모델의 선택 능력이 아니라 출력 형식을 재게 된다.
  // 호출을 여럿 적으면 모델이 먼저 적은 도구가 선택이다(고정 목록 순서로 고르면 sql.query 가 늘 이긴다).
  const content = data.message?.content ?? "";
  const named = firstNamedTool(content);
  // 본문 원문을 남긴다. 도구 이름이 둘 이상 적힌 본문과 도구를 안 고른 본문을 나중에 원문으로 가른다.
  return { tool: named, via: named ? "content" : "none", ms: Date.now() - t0, raw: content.slice(0, 300) };
}

/** 한 문항의 호출이 실패해도 실험 전체를 죽이지 않는다. GPU 를 다른 작업과 나눠 쓰면
 * 응답이 5분을 넘겨 fetch 가 끊긴다(2026-09-30 실측). 한 번 다시 부르고, 그래도 안 되면
 * 그 문항을 오류로 세고 넘어간다 — 오류는 선택이 아니므로 정답에도 오답에도 넣지 않는다. */
async function chooseToolOrError(q: string, tools: McpTool[]): Promise<Choice> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await chooseTool(q, tools);
    } catch (e) {
      if (attempt >= 2) {
        console.error(`  ! 호출 실패(${String(e).slice(0, 120)}) :: ${q}`);
        return { tool: null, via: "error", ms: 0 };
      }
    }
  }
}

async function main() {
  requireCompanyxProfile();
  const here = dirname(fileURLToPath(import.meta.url));
  const root = resolve(here, "../../..");
  const all = await listServerTools(root);
  const tools = all.filter((t) => LANE_TOOLS.includes(t.name));
  if (tools.length !== LANE_TOOLS.length) throw new Error(`레인 도구가 ${tools.length}개만 보인다`);

  const { nodes, edges } = await loadGraph();
  installOntology(nodes, edges);
  const embedder = (process.env.EMBEDDER ?? "hash") === "ollama" ? getEmbedder() : undefined;
  if (embedder) {
    const sem = await installSemanticRouter(embedder);
    if (sem.error) throw new Error(`시맨틱 앵커 임베딩 실패: ${sem.error}`);
  }

  // ROUTER_LLM_STAGE=1 이면 router 열이 3단계 라우터(규칙 → 시맨틱 → LLM)다. 셋째 단계는 서버와 같은 레인 도구를 본다 —
  // 서버가 쓰는 listLaneTools 의 결과가 tools/list 와 다르면 여기서 잰 값이 서버의 값이 아니므로 멈춘다.
  const llmStage = llmStageEnabled();
  if (llmStage) {
    const sortByName = (xs: McpTool[]) => [...xs].sort((a, b) => a.name.localeCompare(b.name));
    const served = JSON.stringify(sortByName(tools).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })));
    const inProcess = JSON.stringify(sortByName(listLaneTools(buildServer().tools())));
    if (served !== inProcess) throw new Error("셋째 단계가 서버 안에서 만드는 레인 도구가 tools/list 와 다르다");
    if (installLlmLaneTools(tools) !== LANE_TOOLS.length) throw new Error("셋째 단계에 레인 도구 넷을 걸지 못했다");
  }

  const want = (process.env.TOOLSELECT_SETS ?? "sponsor30,holdout1,holdout2,holdout3").split(",");
  const rows: Record<string, unknown>[] = [];
  const bySet: Record<string, { n: number; llm: number; rule_only: number; router: number; no_tool: number; errors: number }> = {};
  const input_hashes: Record<string, string> = {};
  for (const name of want) {
    const set = SETS[name];
    if (!set) throw new Error(`모르는 세트: ${name}`);
    const text = await readFile(resolve(root, set.path), "utf8");
    input_hashes[set.path] = createHash("sha256").update(text.replace(/\r\n/g, "\n")).digest("hex").slice(0, 16);
    const raw = JSON.parse(text);
    const items: { q: string; expected: string }[] = (Array.isArray(raw) ? raw : raw.items).map(
      (x: Record<string, string>) => ({ q: x.q, expected: x[set.label] }),
    );
    const s = (bySet[name] = { n: 0, llm: 0, rule_only: 0, router: 0, no_tool: 0, errors: 0 });
    for (const it of items) {
      const c = await chooseToolOrError(it.q, tools);
      if (c.via === "error") {
        s.errors++;
        rows.push({ set: name, q: it.q, expected: it.expected, llm_tool: null, llm_via: "error", llm: "error", llm_ms: 0 });
        continue;
      }
      const llm = c.tool ? LANE_OF_TOOL[c.tool] ?? `other:${c.tool}` : "none";
      const ruleOnly = LANE_OF_ROUTE[route(it.q).route];
      const decision = await routeQuery(it.q, embedder);
      const router = LANE_OF_ROUTE[decision.route];
      const routerVia = decision.llm ? (decision.llm.applied ? "llm" : "llm_kept_rule") : decision.semantic?.applied ? "semantic" : "rule";
      s.n++;
      if (llm === it.expected) s.llm++;
      if (ruleOnly === it.expected) s.rule_only++;
      if (router === it.expected) s.router++;
      if (llm === "none") s.no_tool++;
      rows.push({ set: name, q: it.q, expected: it.expected, llm_tool: c.tool, llm_via: c.via, llm, rule_only: ruleOnly, router, router_via: routerVia, llm_ms: c.ms, llm_raw: c.raw });
      console.log(`${llm === it.expected ? "O" : "X"} llm=${llm.padEnd(15)} router=${router.padEnd(15)} 기대=${it.expected} :: ${it.q}`);
    }
  }

  const ms = rows.filter((r) => r.llm_via !== "error").map((r) => r.llm_ms as number).sort((a, b) => a - b);
  const total = Object.values(bySet).reduce(
    (a, b) => ({ n: a.n + b.n, llm: a.llm + b.llm, rule_only: a.rule_only + b.rule_only, router: a.router + b.router, no_tool: a.no_tool + b.no_tool, errors: a.errors + b.errors }),
    { n: 0, llm: 0, rule_only: 0, router: 0, no_tool: 0, errors: 0 },
  );
  const out = {
    note:
      "LLM 자율 도구 선택(MCP tools/list 의 description 만 보고 고름) 대 규칙 라우터, 규칙+시맨틱 라우터. " +
      "후보는 레인 도구 넷. 채점은 도구 → 레인 매핑의 문자열 일치, LLM 판정자 없음. llm_ms 는 CPU 추론 시간." +
      (llmStage ? " ROUTER_LLM_STAGE=1 실행이라 router 열은 3단계 라우터(규칙 → 시맨틱 → LLM)다. router_via 가 어느 단계가 정했는지다." : ""),
    model: MODEL,
    options: GEN_OPTIONS,
    router_llm_stage: llmStage,
    ollama_host: HOST,
    embedder: embedder?.name ?? "none (rule only)",
    tool_descriptions: Object.fromEntries(tools.map((t) => [t.name, t.description ?? ""])),
    input_hashes,
    by_set: bySet,
    total,
    llm_ms_median: ms[Math.floor(ms.length / 2)] ?? null,
    llm_via: rows.reduce<Record<string, number>>((a, r) => ((a[r.llm_via as string] = (a[r.llm_via as string] ?? 0) + 1), a), {}),
    router_via: rows.reduce<Record<string, number>>((a, r) => (r.router_via ? ((a[r.router_via as string] = (a[r.router_via as string] ?? 0) + 1), a) : a), {}),
    rows,
    generated_at: new Date().toISOString(),
  };
  // TOOLSELECT_OUT 로 결과 파일을 따로 둔다(저장소 루트 기준 경로). 설명을 바꿔 가며 재는 실험이 커밋된 결과를 덮지 않게 한다.
  const suffix = want.length === 1 ? `-${want[0]}` : "";
  const outPath = resolve(root, process.env.TOOLSELECT_OUT ?? `eval/results/companyx-toolselect${suffix}.json`);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(out, null, 2) + "\n");
  console.error(`결과: ${outPath}`);
  console.log(JSON.stringify({ by_set: bySet, total, llm_ms_median: out.llm_ms_median }, null, 2));
}

// 끝나면 바로 내린다. ROUTER_LLM_STAGE=1 실행은 레인 도구를 대조하려고 buildServer() 를 부르는데, air 플러그인의 타이머가
// 이벤트 루프를 붙잡아 결과를 다 쓴 뒤에도 프로세스가 남았다(2026-10-11 실측).
main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
