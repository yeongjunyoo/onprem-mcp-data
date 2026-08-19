// L7 — on-prem answer generation via a local Ollama (Qwen2.5-7B by default).
//
// The model is Apache-2.0 and runs entirely on-prem (no external API), matching
// the license gate. Generation is pinned to temperature 0 + a fixed seed so the
// demo is as reproducible as a sampling model allows; the deterministic spine
// (router / RRF / curator) is exactly reproducible regardless.
//
// Per ref [1] (전현우 외 2026): context marginal utility is model-dependent and
// Qwen benefits from fuller context (p<0.001) — which is why the curated context
// from L4 is fed whole rather than aggressively trimmed.

const HOST = process.env.OLLAMA_HOST ?? "http://localhost:11434";
const MODEL = process.env.OLLAMA_MODEL ?? "qwen2.5-coder:7b";

export interface GenOptions {
  model?: string;
  temperature?: number;
  seed?: number;
  numCtx?: number;
}

export async function generate(prompt: string, opts: GenOptions = {}): Promise<string> {
  const res = await fetch(`${HOST}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: opts.model ?? MODEL,
      prompt,
      stream: false,
      options: {
        temperature: opts.temperature ?? 0,
        seed: opts.seed ?? 42,
        num_ctx: opts.numCtx ?? 4096,
      },
    }),
  });
  if (!res.ok) throw new Error(`ollama generate ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { response?: string };
  return (json.response ?? "").trim();
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
 *   * language lock  — Qwen2.5-7B code-switches into Chinese mid-answer on Korean
 *     business text ("클라우德迁移建议书"). Two of 30 answers were unusable.
 *   * relation lines — the graph lane hands over "A -부서장은-> B" triples; without
 *     an explicit instruction the model read the triple as unrelated tokens and
 *     answered "알 수 없습니다" while the answer sat in its context.
 *   * ids vs names   — asked for a department, it answered "dept_id 5번". The user
 *     asked for a thing, not a foreign key. */
export function buildAnswerPrompt(query: string, context: string): string {
  return [
    "당신은 온프렘 데이터 플랫폼의 한국어 어시스턴트입니다.",
    "아래 [컨텍스트]에 있는 정보만 사용해 [질문]에 한국어로 간결하고 정확하게 답하세요.",
    "반드시 한국어로만 답하세요. 중국어·영어 문장을 섞지 마세요(고유명사 제외).",
    "컨텍스트의 `[SQL 결과] <쿼리> → <값>` 항목은 데이터베이스 실행 결과이니 그 값을 그대로 근거로 삼으세요.",
    "`[그래프] A -관계-> B` 형태는 A와 B의 관계를 뜻합니다. 질문이 그 관계를 물으면 이 줄이 곧 답입니다.",
    "`[그래프 집계]`에 동점이 여러 건이면 전부 나열하세요.",
    "id·코드 대신 이름으로 답하세요. 컨텍스트에 이름이 있으면 id를 그대로 쓰지 마세요.",
    "컨텍스트에 근거가 전혀 없을 때만 '주어진 정보로는 알 수 없습니다'라고 답하세요. 추측하지 마세요.",
    "",
    "[컨텍스트]",
    context.trim() || "(없음)",
    "",
    `[질문] ${query}`,
    "[답변]",
  ].join("\n");
}

export async function answer(query: string, context: string, opts?: GenOptions): Promise<string> {
  return generate(buildAnswerPrompt(query, context), opts);
}
