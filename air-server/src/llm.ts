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

// L7 — on-prem answer generation via a local Ollama (Qwen2.5-Coder-7B by default).
//
// The model is Apache-2.0 and runs entirely on-prem (no external API), matching
// the license gate. Generation is pinned to temperature 0 + a fixed seed so the
// demo is as reproducible as a sampling model allows; the deterministic spine
// (router / RRF / curator) is exactly reproducible regardless.
//
// Per ref [1] (전현우 외 2026): context marginal utility is model-dependent and
// Qwen benefits from fuller context (p<0.001) — which is why the curated context
// from L4 is fed whole rather than aggressively trimmed.

import { postJson } from "./ollamahttp.js";
import { annotateMoney } from "./money.js";

const HOST = process.env.OLLAMA_HOST ?? "http://localhost:11434";
/** 기본 생성 모델. **여기서만 정한다** — 2026-08-19 모델 교체에서 이 값을
 *  한 곳만 바꿨더니 프리플라이트와 결과 JSON 이 옛 태그를 들고 있었다.
 *  증거 파일이 쓰지도 않은 모델명을 적는 것이 가장 나쁘다. */
export const DEFAULT_MODEL = "qwen2.5-coder:7b";
const MODEL = process.env.OLLAMA_MODEL ?? DEFAULT_MODEL;

export interface GenOptions {
  model?: string;
  temperature?: number;
  seed?: number;
  numCtx?: number;
  /** 이 호출 하나의 마감(ms). 없으면 OLLAMA_TIMEOUT_MS, 그것도 없으면 110초. */
  timeoutMs?: number;
}

/** 생성 한 번의 마감.
 *
 * 마감이 없으면 멈춘 Ollama 앞에서 `ask` 가 **영원히** 기다린다 — 상태가 아니라
 * 멈춤이다. 마감이 있으면 파이프라인의 생성 실패 분기가 받아서 「근거는 찾았지만
 * 생성에 실패했다」는 답으로 끝난다.
 *
 * 110초인 이유: CPU 컨테이너에서 답변 한 번이 70초 넘게 걸린 적이 있다
 * (eval/results/companyx-ask.json 최댓값). 그보다 넉넉하되, MCP 도구 마감(120초,
 * server.ts timeoutPlugin)보다는 짧게 둬서 생성 하나가 도구 전체 마감을 혼자
 * 먹지 않게 한다. 느린 환경은 OLLAMA_TIMEOUT_MS 로 올린다. */
function genTimeoutMs(): number {
  const n = Number(process.env.OLLAMA_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 110_000;
}

export async function generate(prompt: string, opts: GenOptions = {}): Promise<string> {
  const deadline = opts.timeoutMs ?? genTimeoutMs();
  try {
    const res = await postJson(
      `${HOST}/api/generate`,
      {
        model: opts.model ?? MODEL,
        prompt,
        stream: false,
        // 생각 모드가 있는 모델(qwen3.5, gemma4 등)을 비교할 때 OLLAMA_THINK=false 로 끈다.
        // 기본 모델에는 생각 모드가 없어 이 필드를 보내지 않는다(없는 기능을 켜라고 하면
        // Ollama 가 거부한다).
        ...(process.env.OLLAMA_THINK ? { think: process.env.OLLAMA_THINK === "true" } : {}),
        options: {
          temperature: opts.temperature ?? 0,
          seed: opts.seed ?? 42,
          num_ctx: opts.numCtx ?? 4096,
        },
      },
      AbortSignal.timeout(deadline),
    );
    if (res.status < 200 || res.status >= 300) throw new Error(`ollama generate ${res.status}: ${res.text}`);
    const json = JSON.parse(res.text) as { response?: string };
    return (json.response ?? "").trim();
  } catch (e) {
    // AbortSignal.timeout 은 영어 DOMException 을 던진다. 사용자가 고칠 값을 말한다.
    if (e instanceof Error && e.name === "TimeoutError") {
      throw new Error(
        `생성 모델이 ${(deadline / 1000).toFixed(deadline < 1000 ? 2 : 0)}초 안에 응답하지 않았다(시간 초과). ` +
          "느린 환경이면 OLLAMA_TIMEOUT_MS 를 올린다.",
      );
    }
    throw e;
  }
}

/** True if Ollama is reachable and the model is pulled. Used to skip live tests. */
export async function isAvailable(model = MODEL): Promise<boolean> {
  try {
    const res = await fetch(`${HOST}/api/tags`, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return false;
    const json = (await res.json()) as { models?: { name: string }[] };
    const base = model.split(":")[0];
    return !!json.models?.some((m) => m.name === model || m.name.startsWith(base));
  } catch {
    return false;
  }
}

/** Korean answer prompt: answer ONLY from the curated context, no guessing.
 *
 * The three extra rules below are not prompt decoration, they are fixes for
 * failures observed on the sponsor's own 30 questions (eval/results/companyx-ask.json):
 *   * language lock  — Qwen 계열이 한국어 질의에서 답변 중간에 중국어로 넘어가는 것을
 *                      2026-07 에 `qwen2.5:7b` 로 관측했다(30문항 중 2건이 못 쓸 답).
 *
 *                      2026-08-19: 모델을 `qwen2.5-coder:7b` 로 바꾼 뒤 **잠금을 빼고
 *                      30문항을 다시 돌렸다 — 한자가 섞인 답변 0건.** 잠금이 있을 때도
 *                      0건이다. 이 모델에서는 원 결함이 재현되지 않는다.
 *                      재현: ANSWER_LANG_LOCK=0 npm run companyx:ask
 *                      원자료: eval/results/companyx-language-lock.json
 *
 *                      **그래도 잠금은 유지한다.** 30문항 한 번으로 「절대 안 샌다」를
 *                      말할 수 없고, 프롬프트 한 줄은 비용이 0이며 실패 비용은 크다.
 *                      비대칭한 위험 앞에서는 싼 보험을 유지한다.
 *                      원 관측:
 *     business text ("클라우德迁移建议书"). Two of 30 answers were unusable.
 *   * relation lines — the graph lane hands over "A -부서장은-> B" triples; without
 *     an explicit instruction the model read the triple as unrelated tokens and
 *     answered "알 수 없습니다" while the answer sat in its context.
 *   * ids vs names   — asked for a department, it answered "dept_id 5번". The user
 *     asked for a thing, not a foreign key.
 *
 * 시도했다가 되돌린 것(2026-10-01): 「보안 취약점 점검 관련 내용이 있어?」에 회의록 다섯 건이
 * 컨텍스트에 있었는데 답이 「네, 각 회의록에서 언급되었습니다」 한 줄이라, 「문서를 근거로
 * 답할 때는 제목이나 날짜와 구체적인 사실을 적으라」는 줄을 넣어 봤다. 그 문항의 답은 한 글자도
 * 바뀌지 않았고, 다른 문항(진행 중 프로젝트 리드 11명)이 한 명을 빠뜨렸다. 효과 없는 문장은
 * 남기지 않는다. */
export function buildAnswerPrompt(query: string, context: string): string {
  return [
    "당신은 온프렘 데이터 플랫폼의 한국어 어시스턴트입니다.",
    "아래 [컨텍스트]에 있는 정보만 사용해 [질문]에 한국어로 간결하고 정확하게 답하세요.",
    // 언어 잠금. **검증용 제거 스위치**이지 런타임 튜닝 파라미터가 아니다 —
    // `CX_REPAIR=0`·`BENCH_STRATEGY=naive` 와 같은 자리다. 기본값은 켜짐.
    //   재현: ANSWER_LANG_LOCK=0 npm run companyx:ask
    ...(process.env.ANSWER_LANG_LOCK === "0"
      ? []
      : ["반드시 한국어로만 답하세요. 중국어·영어 문장을 섞지 마세요(고유명사 제외)."]),
    "컨텍스트의 `[SQL 결과] <쿼리> → <값>` 항목은 데이터베이스 실행 결과이니 그 값을 그대로 근거로 삼으세요.",
    "`[그래프] A -관계-> B` 형태는 A와 B의 관계를 뜻합니다. 질문이 그 관계를 물으면 이 줄이 곧 답입니다.",
    "`[그래프 집계]`에 동점이 여러 건이면 전부 나열하세요.",
    "id·코드 대신 이름으로 답하세요. 컨텍스트에 이름이 있으면 id를 그대로 쓰지 마세요.",
    "컨텍스트에 근거가 전혀 없을 때만 '주어진 정보로는 알 수 없습니다'라고 답하세요. 추측하지 마세요.",
    "",
    "[컨텍스트]",
    context.trim() || "(없음)",
    "",
    `[질문] ${answerQuestionForModel(query)}`,
    "[답변]",
  ].join("\n");
}

/** 상대 연도 낱말과 오늘 연도와의 차. 재작년이 작년보다 먼저 맞아야 한다(정규식 대안의 순서). 올해와 금년은 다루지 않는다
 * (nl2sql.ts absoluteYears 의 실측). 둘째 묶음은 뒤에 붙은 「도」(작년도). */
export const RELATIVE_YEAR: Record<string, number> = { 재작년: -2, 작년: -1, 지난해: -1, 내년: 1 };
export const RELATIVE_YEAR_RE = /(재작년|작년|지난해|내년)(도?)/g;

/** 서울 시각으로 오늘의 연도. */
export function seoulYear(now: Date = new Date()): number {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Seoul", year: "numeric" }).format(now));
}

/** 답 프롬프트의 질문 줄. 상대 연도 뒤에 연도를, 금액 표현 뒤에 만원 값을 괄호로 덧붙인다: 「작년 매출」 → 「작년(2025년)
 * 매출」, 「1억 원」 → 「1억 원(=10000만 원)」. 생성 SQL 은 이미 2025년과 만원으로 조회하는데 답 모델은 그 연결을 몰라
 * 「작년 매출은 얼마야?」에 조회 행 112,773 을 두고 「알 수 없습니다」라고 했고(3/3), 계약 금액 11000(만원)을 「11,000 원」이라고
 * 썼다(랜덤 테스트 2차 뒤 실측, 2026-10-08). 낱말은 지우지 않고 덧붙이기만 한다. 상대 연도와 금액 표현이 없는 질문은
 * questionForModel 결과 그대로다. */
export function answerQuestionForModel(query: string, now: Date = new Date()): string {
  const year = seoulYear(now);
  return fitAnnotated(query, (q) =>
    annotateMoney(q.replace(RELATIVE_YEAR_RE, (w: string, word: string) => `${w}(${year + RELATIVE_YEAR[word]}년)`)),
  );
}

export async function answer(query: string, context: string, opts?: GenOptions): Promise<string> {
  return generate(buildAnswerPrompt(query, context), opts);
}

/** 생성 모델 프롬프트에 넣는 질문의 상한(유니코드 문자 수).
 *
 * 생성은 num_ctx 4096 으로 돈다. 프롬프트가 그보다 길면 Ollama 는 오류 없이 앞쪽을 잘라 2,050토큰만 남기고,
 * 잘려 나가는 것이 지시문과 스키마 카드다(2026-10-07 실측, prompt_eval_count). 같은 질문 200번(4,400자)에
 * 7B 가 「제공한 정보는 충분하지 않습니다」라고 답한 까닭이다(3/3). 같은 실측에서 Company-X NL2SQL
 * 프롬프트는 질문을 뺀 몫이 1,451토큰, 그 질문은 22자에 20토큰이었다. 질문 2,400자면 약 3,630토큰이라
 * 4,096 안에 SQL 을 쓸 자리가 남고, 2,200자(TC-153)는 손대지 않고 그대로 들어간다. 감사 레코드의 query 는
 * 호출부가 가진 원문 그대로다. */
export const LLM_QUESTION_MAX_CHARS = 2400;

/** 상한을 넘는 질문은 앞부분만 넣고, 그 사실을 stderr 에 남긴다. 서로게이트 쌍을 가르지 않는다. */
export function questionForModel(query: string): string {
  const chars = Array.from(query);
  if (chars.length <= LLM_QUESTION_MAX_CHARS) return query;
  console.error(`[생성] 질문 ${chars.length}자가 생성 모델 문맥에 다 들어가지 않아 앞 ${LLM_QUESTION_MAX_CHARS}자만 넣는다`);
  return chars.slice(0, LLM_QUESTION_MAX_CHARS).join("");
}

/** 덧붙인 질문 줄(상대 연도의 연도, 금액의 만원 값)을 상한 안으로. 덧붙이면 길어지므로 상한은 덧붙인 뒤의 길이에 건다. 원문을
 * 먼저 자르고 덧붙이면 금액 표현이 많은 질문은 상한 근처에서 수천 자가 늘어 문맥을 넘었다(PR #257 Codex). 덧붙인 결과가 상한 안에
 * 드는 원문 앞부분을 골라 거기에 다시 덧붙이므로 괄호 한가운데서 잘린 값(「2억 원(=200」)은 생기지 않는다. 덧붙일 것이 없으면
 * questionForModel 과 같다. */
export function fitAnnotated(query: string, annotate: (q: string) => string): string {
  const whole = annotate(query);
  if (Array.from(whole).length <= LLM_QUESTION_MAX_CHARS) return whole;
  const chars = Array.from(query);
  let lo = 0;
  let hi = Math.min(chars.length, LLM_QUESTION_MAX_CHARS);
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (Array.from(annotate(chars.slice(0, mid).join(""))).length <= LLM_QUESTION_MAX_CHARS) lo = mid;
    else hi = mid - 1;
  }
  console.error(`[생성] 질문 ${chars.length}자가 생성 모델 문맥에 다 들어가지 않아 앞 ${lo}자만 넣는다`);
  return annotate(chars.slice(0, lo).join(""));
}
