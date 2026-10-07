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

// 시연 대본의 스코어카드 블록을 eval/results/companyx-scorecard.json 에서 만든다.
//
// 스코어카드는 다시 잴 때마다 값이 바뀐다(라우터 병합 뒤 재측정이 예정돼 있다). 표를 손으로
// 옮기면 칸 하나가 어긋나고, 잠정치라는 설명은 재측정 뒤에도 남는다. 그래서 블록 전체를
// 생성물로 둔다 — SBOM·증거 매니페스트와 같은 패턴이다. 답 대신 상태(조회·생성 실패)로 끝난
// 문항이 있으면 그 번호와 이유를 블록이 스스로 적고, 깨끗한 재측정이면 그 문단이 사라진다.
//
//   node scripts/scorecard-docs.mjs           검사: 대본의 블록이 JSON 에서 만든 것과 같은지
//   node scripts/scorecard-docs.mjs --write   재생성 (정본 JSON 을 바꾼 뒤 한 번)
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DOC = "docs/demo-script.md";
export const RESULT = "eval/results/companyx-scorecard.json";
export const BEGIN = "<!-- scorecard:begin (node scripts/scorecard-docs.mjs --write 로 생성한다. 손으로 고치지 않는다) -->";
export const END = "<!-- scorecard:end -->";

// air-server/src/scorecard.ts 의 STATE_LABEL 과 같은 이름. 모르는 코드가 오면 던진다 —
// 상태가 늘었는데 여기를 안 고치면 조용히 빈 이름을 찍는 대신 멈춘다.
const STATE = {
  ok: "정상",
  degraded: "부분 실패",
  empty: "근거 없음",
  retrieval_failed: "조회 실패",
  generation_failed: "생성 실패",
};
const label = (s) => {
  if (!(s in STATE)) throw new Error(`스코어카드 상태 코드를 모른다: ${s} — scorecard-docs.mjs 의 STATE 를 고친다`);
  return STATE[s];
};

// 레인별 7B 호출 수. 지연 차이의 구조적 이유라 측정값이 아니라 파이프라인의 사실이다(pipeline.ts).
const CALLS = {
  nl2sql: "두 번(SQL 생성, 답변). 엔진이 SQL 을 거부하면 수리 한 번 더",
  vector_search: "한 번(답변). 조회에 질의 임베딩 한 번",
  knowledge_graph: "한 번(답변). 조회는 모델 없는 결정론 순회",
};

export function renderScorecardBlock({ summary: s, rows }) {
  const h = s.host ?? {};
  const device =
    s.inference === "cpu" ? "CPU 추론(적재 모델 VRAM 0)" : s.inference === "gpu" ? "GPU 추론" : "추론 장치 미기록";
  const budget = s.budget === null || s.budget === undefined ? "MCP `ask` 도구 기본값" : `CX_BUDGET=${s.budget}`;
  const lines = [
    BEGIN,
    `**실측** (${s.generated_at.slice(0, 10)}, \`${RESULT}\`, 커밋 ${s.git_commit ?? "미기록"}${s.git_dirty ? " + 커밋 안 된 변경" : ""}). ` +
      `호스트 ${h.cpu_model ?? "?"} ${h.cpu_cores ?? "?"}스레드, 메모리 ${h.mem_gb ?? "?"}GB, ` +
      `Ollama ${s.ollama_host}(${device}), 모델 ${s.model}, 임베더 ${s.embedder}. ` +
      `ms 는 질문 하나의 \`ask()\` 벽시계 시간(조회와 생성의 합)이고 컨텍스트 예산은 ${budget}이다.`,
    "",
    "| 레인 | 최종 답 정답 | 라우트 일치 | 중앙값 ms | p90 ms | 7B 호출 |",
    "|---|---|---|---:|---:|---|",
    ...Object.entries(CALLS).map(([lane, calls]) => {
      const l = s.by_lane[lane];
      return `| ${lane} | ${l.correct} | ${l.route_match} | ${l.median_ms} | ${l.p90_ms} | ${calls} |`;
    }),
    `| 전체 | ${s.correct} | ${s.route_match} | ${s.median_ms} | ${s.p90_ms} | |`,
  ];
  const failed = rows.filter((r) => r.state === "retrieval_failed" || r.state === "generation_failed");
  if (failed.length) {
    lines.push(
      "",
      `**잠정치.** 이 실행에서 ${failed.length}문항이 답 대신 상태로 끝났다. 채점은 규칙대로 오답으로 셌고,` +
        " 지연도 그 실패를 포함한다. 같은 명령으로 다시 재면 이 문단은 사라진다.",
      "",
      ...failed.map((r) => {
        const why = (r.branch_errors[0] ?? "").replace(/^answer: /, "").replace(/\s+/g, " ").slice(0, 70);
        // 초로 적는다. 산문의 「NNNms」는 metrics-check 가 현행 지연값과 대조한다.
        return `- ${r.i}번 ${r.lane} ${label(r.state)}, ${(r.ms / 1000).toFixed(1)}초 만에: ${why}`;
      }),
    );
  }
  lines.push(END);
  return lines.join("\n");
}

function main() {
  const write = process.argv.includes("--write");
  const resultPath = resolve(ROOT, RESULT);
  if (!existsSync(resultPath)) {
    console.error(`\n실패: ${RESULT} 가 없다 — npm run companyx:score 로 만든다.\n`);
    process.exit(1);
  }
  const block = renderScorecardBlock(JSON.parse(readFileSync(resultPath, "utf8")));
  const docPath = resolve(ROOT, DOC);
  const doc = readFileSync(docPath, "utf8").replace(/\r\n/g, "\n");
  const a = doc.indexOf(BEGIN);
  const b = doc.indexOf(END);
  if (a < 0 || b < a || doc.indexOf(BEGIN, a + 1) >= 0) {
    console.error(`\n실패: ${DOC} 에 스코어카드 블록 표식이 정확히 한 쌍 있어야 한다.\n  ${BEGIN}\n  ${END}\n`);
    process.exit(1);
  }
  const current = doc.slice(a, b + END.length);
  if (write) {
    writeFileSync(docPath, doc.slice(0, a) + block + doc.slice(b + END.length), "utf8");
    console.log(`스코어카드 블록을 ${RESULT} 에서 다시 만들었다: ${DOC}`);
    return;
  }
  if (current !== block) {
    console.error(`\n실패: ${DOC} 의 스코어카드 블록이 ${RESULT} 와 다르다.`);
    console.error("  node scripts/scorecard-docs.mjs --write 로 다시 만들고 함께 커밋한다.\n");
    process.exit(1);
  }
  console.log(`OK: ${DOC} 의 스코어카드 블록이 ${RESULT} 에서 만든 것과 같다.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
