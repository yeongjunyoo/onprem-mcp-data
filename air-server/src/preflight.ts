// 환경 프리플라이트 — 문서가 말하는 환경과 실제 환경이 다를 때 그것을 드러낸다.
//
// 왜 필요한가. `docker compose up -d`로 Ollama 컨테이너를 띄워도, 호스트에 이미
// Ollama가 있으면 포트 게시가 **조용히 실패한다**(PublishedPort: 0). 컨테이너는
// "running"이고 에러도 없다. 그리고 앱은 호스트 데몬에 붙는다 — 그 데몬이 어떤
// 모델을 갖고 있든. 그 상태로 잰 수치는 자기가 무엇을 쟀는지 모르는 수치다.
//
// 그래서 실행 전에 **실제로 붙은 엔드포인트와 그 모델 목록**을 찍는다.

// ★ 프리플라이트는 시점 검사다 (TOCTOU).
// 프로브가 통과한 뒤 엔드포인트가 죽으면 실행 중에 실패한다 — QA가 재현했다.
// 이 검사는 "기동 시점에 쓸 수 있었다"를 증명하지, 계속 쓸 수 있음을 보장하지
// 않는다. 런타임 오류 처리는 별도로 필요하고, 실제로 파이프라인은
// Promise.allSettled + branch_errors 로 부분 실패를 견딘다.
// 프로브 마감 시간. 기본값은 기동을 오래 세우지 않도록 짧게 두되, **설정 가능**하게
// 한다. CPU만 있는 배포에서 7B를 처음 적재하면 30초를 넘길 수 있고, 그때 프리플라이트가
// 정상 환경을 거부하면 검사가 방해물이 된다(리뷰 권고). 느린 환경은 값을 올려서 쓴다.
const num = (v: string | undefined, dflt: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : dflt;
};
const embedTimeoutMs = () => num(process.env.PREFLIGHT_EMBED_TIMEOUT_MS, 10_000);
const genTimeoutMs = () => num(process.env.PREFLIGHT_GEN_TIMEOUT_MS, 60_000);

export interface OllamaProbe {
  host: string;
  reachable: boolean;
  models: string[];
  error?: string;
}

/** 실제로 응답하는 Ollama가 무엇인지, 어떤 모델을 갖고 있는지 확인한다. */
export async function probeOllama(host = process.env.OLLAMA_HOST ?? "http://localhost:11434"): Promise<OllamaProbe> {
  try {
    const res = await fetch(`${host.replace(/\/$/, "")}/api/tags`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return { host, reachable: false, models: [], error: `HTTP ${res.status}` };
    const body = (await res.json()) as { models?: { name: string }[] };
    return { host, reachable: true, models: (body.models ?? []).map((m) => m.name).sort() };
  } catch (e) {
    return { host, reachable: false, models: [], error: String(e).slice(0, 120) };
  }
}

/** 필요한 모델이 다 있는지 확인하고, 없으면 무엇을 실행해야 하는지 알려준다.
 *
 * 태그를 느슨하게 비교한다: `bge-m3`는 `bge-m3:latest`를 만족시킨다. */
export function missingModels(probe: OllamaProbe, required: string[]): string[] {
  const have = probe.models.map((m) => m.replace(/:latest$/, ""));
  return required.filter((r) => {
    const base = r.replace(/:latest$/, "");
    return !have.some((h) => h === base || h.startsWith(`${base}:`) || base.startsWith(`${h}:`));
  });
}

/** 태그에 있다고 실제로 서빙되는 것은 아니다.
 *
 * QA 레드팀이 재현했다 — `/api/tags`가 요구 모델을 정확히 보고하는데
 * `/api/embeddings`가 503을 돌려주는 엔드포인트에서 프리플라이트가 통과했다.
 * 메타데이터만 보면 "붙었다"와 "쓸 수 있다"를 구분하지 못한다.
 * 그래서 임베딩 모델은 **실제로 한 번 임베딩해 본다.** 토큰 하나면 충분하다. */
export async function probeServing(
  host: string,
  embedModel: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${host.replace(/\/$/, "")}/api/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: embedModel, prompt: "ok" }),
      signal: AbortSignal.timeout(embedTimeoutMs()),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const body = (await res.json()) as { embedding?: unknown[] };
    const v = body.embedding;
    if (!Array.isArray(v) || v.length === 0) return { ok: false, error: "빈 임베딩 응답" };
    // 배열이 비지 않았다고 임베딩인 것은 아니다. [null] 과 ["not-a-number"] 가
    // 정상으로 통과했다(QA 재현). 좌표가 유한한 수인지까지 본다.
    if (!v.every((x) => typeof x === "number" && Number.isFinite(x))) {
      return { ok: false, error: "임베딩 좌표가 유한한 수가 아니다" };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 120) };
  }
}

/** 생성 모델도 실제로 서빙되는지 본다.
 *
 * 임베더를 안 쓰는 구성(EMBEDDER 미설정)에서도 `ask`는 여전히 로컬 7B로 답을
 * 만든다. 임베딩만 확인하면 그 경로가 죽어 있어도 서버가 뜬다(QA 재현). */
export async function probeGeneration(
  host: string,
  model: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${host.replace(/\/$/, "")}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, prompt: "ok", stream: false, options: { num_predict: 1 } }),
      signal: AbortSignal.timeout(genTimeoutMs()),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const body = (await res.json()) as { response?: unknown };
    if (typeof body.response !== "string") return { ok: false, error: "생성 응답 형식이 아니다" };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 120) };
  }
}

/** 사람이 읽을 프리플라이트 리포트. 실패하면 false를 돌려준다(호출부가 멈춘다). */
export function reportOllama(probe: OllamaProbe, required: string[]): boolean {
  if (!probe.reachable) {
    console.error(`\n[환경] Ollama에 붙지 못했다: ${probe.host} (${probe.error})`);
    console.error("  docker compose up -d ollama  # 컨테이너는 host 11435에 게시된다");
    console.error("  OLLAMA_HOST=http://localhost:11435 으로 실행하거나, 호스트 Ollama를 켠다\n");
    return false;
  }
  console.log(`[환경] Ollama ${probe.host} — 모델 ${probe.models.length}종: ${probe.models.join(", ") || "(없음)"}`);
  const missing = missingModels(probe, required);
  if (missing.length) {
    console.error(`\n[환경] 필요한 모델이 없다: ${missing.join(", ")}`);
    for (const m of missing) console.error(`  ollama pull ${m}          # 호스트 Ollama를 쓸 때`);
    for (const m of missing) console.error(`  docker compose exec ollama ollama pull ${m}   # 컨테이너를 쓸 때`);
    console.error("");
    return false;
  }
  return true;
}
