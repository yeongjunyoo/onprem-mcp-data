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

// 시연 직전 워밍업 — Ollama 콜드 스타트를 시연 밖에서 치른다.
//
// Ollama 는 모델을 첫 요청 때 메모리에 올린다. CPU 에서 7B 는 그 적재만 수십 초라, 워밍업을
// 안 하면 심사자의 첫 질문이 그 시간을 대신 낸다(리원에이스 멘토링: 시연 전에 요청을 하나
// 보내 둘 것). 임베딩과 생성을 한 번씩 보내 **적재 포함 첫 호출**과 **적재 후 두 번째 호출**
// 시간을 찍는다.
//
// 모델이 없으면 여기서 멈추고 받을 명령을 그대로 알려준다. 시연 중에 pull 을 시작하면
// 온라인에서 멈출 수 있으므로 모델은 시연 전에 받아 둔다(docker compose 의 models 서비스).
//
// 실행: npm run warmup    (OLLAMA_HOST 기본 http://localhost:11434, compose 컨테이너는 11435)
import { DEFAULT_MODEL } from "../llm.js";
import { probeOllama, reportOllama } from "../preflight.js";
import { postJson } from "../ollamahttp.js";

const host = (process.env.OLLAMA_HOST ?? "http://localhost:11434").replace(/\/$/, "");
const genModel = process.env.OLLAMA_MODEL ?? DEFAULT_MODEL;
const embedModel = process.env.EMBED_MODEL ?? "bge-m3";
// 워밍업이 올린 모델이 시연 전에 다시 내려가지 않게 한다. Ollama 기본은 5분이다.
const keepAlive = process.env.WARMUP_KEEP_ALIVE ?? "30m";
// CPU 에서 7B 첫 적재는 1분을 넘길 수 있다. 워밍업은 기다리는 것이 일이다.
const timeoutMs = Number(process.env.WARMUP_TIMEOUT_MS) || 300_000;

interface Timed {
  ms: number;
  /** Ollama 가 보고한 모델 적재 시간(생성 응답에만 있다) */
  loadMs: number | null;
}

async function post(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  // fetch 는 응답 헤더를 300초까지만 기다려 WARMUP_TIMEOUT_MS 를 그 위로 올려도 소용이 없었다(ollamahttp.ts).
  const res = await postJson(`${host}${path}`, { ...body, keep_alive: keepAlive }, AbortSignal.timeout(timeoutMs));
  if (res.status < 200 || res.status >= 300) throw new Error(`${path} HTTP ${res.status}: ${res.text.slice(0, 200)}`);
  return JSON.parse(res.text) as Record<string, unknown>;
}

async function embedOnce(): Promise<Timed> {
  const t0 = Date.now();
  const r = await post("/api/embeddings", { model: embedModel, prompt: "워밍업" });
  const v = r.embedding;
  if (!Array.isArray(v) || v.length === 0 || !v.every((x) => typeof x === "number" && Number.isFinite(x))) {
    throw new Error("임베딩 응답에 유한한 벡터가 없다");
  }
  return { ms: Date.now() - t0, loadMs: null };
}

async function generateOnce(): Promise<Timed> {
  const t0 = Date.now();
  const r = await post("/api/generate", {
    model: genModel,
    prompt: "한 단어로 답하라: 준비됐나?",
    stream: false,
    options: { temperature: 0, seed: 42, num_predict: 8 },
  });
  if (typeof r.response !== "string") throw new Error("생성 응답 형식이 아니다");
  const load = typeof r.load_duration === "number" ? Math.round(r.load_duration / 1e6) : null;
  return { ms: Date.now() - t0, loadMs: load };
}

async function main() {
  const probe = await probeOllama(host);
  if (!reportOllama(probe, [genModel, embedModel])) {
    console.error("워밍업 실패: 위 모델을 받은 뒤 다시 npm run warmup 을 실행한다.");
    console.error("  시연 중에 pull 하지 않는다 — 온라인에서 멈출 수 있다.\n");
    process.exit(1);
  }

  // 이미 올라와 있으면 첫 호출은 콜드가 아니다. 모르는 채로 「콜드 시간」이라 적지 않는다.
  let resident: string[] = [];
  try {
    const ps = (await (await fetch(`${host}/api/ps`, { signal: AbortSignal.timeout(5000) })).json()) as {
      models?: { name: string }[];
    };
    resident = (ps.models ?? []).map((m) => m.name);
  } catch (e) {
    console.warn(`[warmup] /api/ps 를 읽지 못했다(${String(e).slice(0, 80)}) — 적재 상태는 모른다고 적는다`);
    resident = ["?"];
  }
  const was = (m: string) =>
    resident.includes("?") ? "모름" : resident.some((r) => r === m || r.startsWith(`${m}:`)) ? "이미 적재됨" : "적재 안 됨(콜드)";

  const rows: [string, Timed, Timed, string][] = [];
  try {
    const e1 = await embedOnce();
    const e2 = await embedOnce();
    rows.push([embedModel, e1, e2, was(embedModel)]);
    const g1 = await generateOnce();
    const g2 = await generateOnce();
    rows.push([genModel, g1, g2, was(genModel)]);
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    console.error(`\n워밍업 실패: ${why}`);
    if (/HTTP 404/.test(why)) {
      console.error(`  모델이 없다. ollama pull ${genModel} && ollama pull ${embedModel}`);
      console.error(`  컨테이너면: docker compose exec ollama ollama pull ${genModel}`);
    } else if (/TimeoutError|aborted/i.test(why)) {
      console.error(`  ${timeoutMs / 1000}초 안에 응답이 없다. 느린 환경이면 WARMUP_TIMEOUT_MS 를 올린다.`);
    }
    process.exit(1);
  }

  console.log(`\n[warmup] Ollama ${host}`);
  for (const [m, a, b, st] of rows) {
    const load = a.loadMs === null ? "" : ` (그중 적재 ${a.loadMs}ms)`;
    console.log(`  ${m.padEnd(18)} 첫 호출 ${a.ms}ms${load}, 두 번째 ${b.ms}ms — 시작 시 ${st}`);
  }
  console.log(
    `\n[warmup] OK — 두 모델이 ${keepAlive} 동안 메모리에 남는다(keep_alive). 시연 직전 마지막 명령으로 돌린다.` +
      "\n  적재 시간은 Ollama 가 보고한 load_duration 이다. 시작 시 이미 적재돼 있었다면 첫 호출도 콜드가 아니다.",
  );
}

main().catch((e) => {
  console.error(`워밍업 실패: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
