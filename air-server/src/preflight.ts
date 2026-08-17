// 환경 프리플라이트 — 문서가 말하는 환경과 실제 환경이 다를 때 그것을 드러낸다.
//
// 왜 필요한가. `docker compose up -d`로 Ollama 컨테이너를 띄워도, 호스트에 이미
// Ollama가 있으면 포트 게시가 **조용히 실패한다**(PublishedPort: 0). 컨테이너는
// "running"이고 에러도 없다. 그리고 앱은 호스트 데몬에 붙는다 — 그 데몬이 어떤
// 모델을 갖고 있든. 그 상태로 잰 수치는 자기가 무엇을 쟀는지 모르는 수치다.
//
// 그래서 실행 전에 **실제로 붙은 엔드포인트와 그 모델 목록**을 찍는다.

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
