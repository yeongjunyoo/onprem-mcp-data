#!/usr/bin/env node
// onprem-mcp-data — air MCP server entrypoint (리원에이스 지정과제).
//
// Single-runtime, fully on-prem MCP data platform. air gives us the MCP server +
// stability plugins (timeout/retry/circuit-breaker = "fewer failure points") for
// free; we add the differentiators: L3 deterministic router (MCP Parallel), the
// L2 DB tools over PostgreSQL+pgvector, and (next increment) L4 structure-
// preserving curation + the 7B answer step. The server wiring lives in
// server.ts (buildServer) so tests can exercise it without opening stdio.

import { closePool } from "./db.js";
import { shutdown } from "./exit.js";
import { probeGeneration, probeOllama, probeServing, reportOllama } from "./preflight.js";
import { buildServer, loadRouterOntology } from "./server.js";
import { DEFAULT_MODEL } from "./llm.js";

/** 기동 전 환경 검사. 통과하지 못하면 서버를 띄우지 않는다.
 *
 * 반환값으로 실패를 알린다 — 여기서 곧바로 `process.exit()`을 부르면 아직 열려
 * 있는 DB 풀 핸들 때문에 Windows libuv가 assertion을 내고 종료코드가 9로 바뀐다
 * (QA 재현). 핸들을 정리한 뒤 자연 종료시키는 편이 종료코드를 정확하게 만든다. */
async function preflight(): Promise<boolean> {
  const need = [process.env.OLLAMA_MODEL ?? DEFAULT_MODEL];
  if ((process.env.EMBEDDER ?? "") === "ollama") need.push(process.env.EMBED_MODEL ?? "bge-m3");

  const probe = await probeOllama();
  if (!reportOllama(probe, need)) return false;

  // 태그에 있다고 서빙되는 것은 아니다. 생성은 EMBEDDER 설정과 무관하게 항상
  // 쓰이므로(`ask`, `audit.explain`) 무조건 확인한다.
  const gen = await probeGeneration(probe.host, process.env.OLLAMA_MODEL ?? DEFAULT_MODEL);
  if (!gen.ok) {
    console.error(`\n[환경] 생성 모델이 태그에는 있으나 서빙되지 않는다: ${gen.error}`);
    console.error(`  ${probe.host} 의 /api/generate 가 응답하지 않는다. 느린 환경이면 PREFLIGHT_GEN_TIMEOUT_MS 를 올린다.\n`);
    return false;
  }

  // 서버의 기본 임베더는 해시라, Ollama 임베딩은 실제로 쓸 때만 확인한다.
  if ((process.env.EMBEDDER ?? "") === "ollama") {
    const serving = await probeServing(probe.host, process.env.EMBED_MODEL ?? "bge-m3");
    if (!serving.ok) {
      console.error(`\n[환경] 임베딩 모델이 태그에는 있으나 서빙되지 않는다: ${serving.error}`);
      console.error(`  ${probe.host} 의 /api/embeddings 가 응답하지 않는다.\n`);
      return false;
    }
  }
  return true;
}

async function main(): Promise<void> {
  if (!(await preflight())) {
    process.exitCode = 1;
    await closePool();
    return;
  }

  // 라우터 온톨로지를 적재한다. 이것이 없으면 타입쌍 추론이 죽고, 평가에서 측정한
  // 라우팅 성능이 서버 경로에서 재현되지 않는다(이슈 #18). 실패해도 서버는 뜨고
  // 폴백으로 동작하되, 경고를 남긴다.
  const ont = await loadRouterOntology();
  console.error(
    ont.error
      ? `[router] 온톨로지 미적재(${ont.error}) — 폴백 경로로 동작한다`
      : `[router] 온톨로지 적재: 개체 ${ont.entities}개, 타입쌍 ${ont.typePairs}개`,
  );

  buildServer().start();
}

main().catch(async (e) => {
  console.error(e instanceof Error ? `Error: ${e.message}` : e);
  // 자연 종료에 기대지 않는다. 기동 중 던지면 preflight 가 열어둔 소켓과 풀
  // 핸들이 이벤트 루프를 붙잡아 **에러를 찍고도 프로세스가 매달린다**(실측 90초
  // 타임아웃). 매달리는 것은 실패보다 나쁘다 — 호출자는 성공도 실패도 못 읽는다.
  // shutdown() 이 정확히 이 문제를 위해 있다.
  await shutdown(1);
});
