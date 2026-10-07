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

// 장애 상태 시연 — 실패가 예외가 아니라 **상태**로 끝나는지 한 화면에 보인다.
//
// fault:inject 는 브랜치 하나를 죽였을 때 나머지가 부분 컨텍스트를 받치는지(조회 층)를
// 잰다. 기능테스트에서 심사자가 보는 것은 그 위층이다 — ask 가 무엇을 **답하는가**.
// 세 장애를 실제로 일으키고 ask() 가 던지지 않고 상태와 사람이 읽을 문장으로 끝나는지 본다.
//
//   1) DB 연결 끊김   아무도 듣지 않는 포트에 붙인 실제 pg 풀(흉내 낸 객체가 아니다)
//   2) 모델 시간 초과 실제 Ollama 호출에 지킬 수 없는 마감(기본 0.05초)을 준다
//   3) 빈 결과       사업자 예시의 「서울물산」 — 데이터셋에 없는 고객사
//
// 기대 상태와 다르거나 예외가 나면 exit 1 이다. 시연 전에 한 번 돌려 두면 당일 장애가
// 어떻게 보일지 미리 안다.
//
// 실행: npm run fault:demo   (companyx 적재 + Ollama 필요. 생성은 3번에서 한 번만 한다)
import pg from "pg";
import { getPool } from "../db.js";
import { getEmbedder } from "../embedder.js";
import { ask, type AskResult } from "../pipeline.js";
import { answer, DEFAULT_MODEL } from "../llm.js";
import { probeOllama, reportOllama } from "../preflight.js";
import { requireCompanyxProfile } from "../companyx.js";
import { shutdown } from "../exit.js";
import { answerState, STATE_LABEL, type AnswerState } from "../scorecard.js";

const DEAD_DB = process.env.FAULT_DEAD_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:1/mcpdata";
const GEN_DEADLINE_MS = Number(process.env.FAULT_GEN_TIMEOUT_MS) || 50;

interface Scenario {
  title: string;
  how: string;
  expect: AnswerState;
  run: () => Promise<AskResult>;
}

async function main() {
  requireCompanyxProfile();
  const probe = await probeOllama();
  if (!reportOllama(probe, [process.env.OLLAMA_MODEL ?? DEFAULT_MODEL, process.env.EMBED_MODEL ?? "bge-m3"])) {
    await shutdown(1);
  }
  const embedder = getEmbedder();
  const dead = new pg.Pool({ connectionString: DEAD_DB, max: 1, connectionTimeoutMillis: 3000 });

  const scenarios: Scenario[] = [
    {
      title: "DB 연결 끊김",
      how: `DB 주소를 아무도 듣지 않는 곳(${DEAD_DB.replace(/\/\/[^@]*@/, "//")})으로 바꿨다`,
      expect: "retrieval_failed",
      run: () => ask("경영지원팀 팀장은 누구야?", { pool: dead, embedder }),
    },
    {
      title: "모델 시간 초과",
      how: `생성 마감을 ${GEN_DEADLINE_MS / 1000}초로 줄여 실제 Ollama 호출을 중간에 끊었다`,
      expect: "generation_failed",
      run: () =>
        ask("경영지원팀 팀장은 누구야?", {
          pool: getPool(),
          embedder,
          llm: (q, ctx) => answer(q, ctx, { timeoutMs: GEN_DEADLINE_MS }),
        }),
    },
    {
      title: "빈 결과",
      how: "데이터셋에 없는 고객사(서울물산)를 물었다 — 사업자 예시 30문항 중 하나",
      expect: "empty",
      run: () => ask("서울물산 담당 엔지니어는 누구야?", { pool: getPool(), embedder }),
    },
  ];

  console.log("\n=== 장애 상태 시연: 예외 대신 상태로 끝나는가 ===");
  let good = 0;
  for (const [i, s] of scenarios.entries()) {
    const t0 = Date.now();
    let state: AnswerState | "threw";
    let text: string;
    try {
      const r = await s.run();
      state = answerState(r);
      text = r.answer;
    } catch (e) {
      // 여기 오면 시연 실패다 — 사용자는 답 대신 스택을 본다.
      state = "threw";
      text = `예외: ${e instanceof Error ? e.message : String(e)}`;
    }
    const ms = Date.now() - t0;
    const pass = state === s.expect;
    if (pass) good++;
    const shown = state === "threw" ? "예외" : STATE_LABEL[state];
    console.log(`\n[${i + 1}] ${s.title} — ${s.how}`);
    console.log(`    상태: ${shown} (기대 ${STATE_LABEL[s.expect]}) ${pass ? "OK" : "불일치"}, ${ms}ms`);
    console.log(`    답: ${text.replace(/\s+/g, " ").trim().slice(0, 220)}`);
  }
  await dead.end();

  console.log(`\n결과: ${good}/${scenarios.length} 시나리오가 예외 없이 기대한 상태로 끝났다.`);
  await shutdown(good === scenarios.length ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await shutdown(1);
});
