#!/usr/bin/env node
// onprem-mcp-data — air MCP server entrypoint (리원에이스 지정과제).
//
// Single-runtime, fully on-prem MCP data platform. air gives us the MCP server +
// stability plugins (timeout/retry/circuit-breaker = "fewer failure points") for
// free; we add the differentiators: L3 deterministic router (MCP Parallel), the
// L2 DB tools over PostgreSQL+pgvector, and (next increment) L4 structure-
// preserving curation + the 7B answer step. The server wiring lives in
// server.ts (buildServer) so tests can exercise it without opening stdio.

import { buildServer, loadRouterOntology } from "./server.js";
import { probeOllama, reportOllama, probeServing, probeGeneration } from "./preflight.js";

// 라우터 온톨로지를 먼저 적재한다. 이것이 없으면 타입쌍 추론이 죽고, 평가에서
// 측정한 라우팅 성능이 서버 경로에서 재현되지 않는다(이슈 #18). 실패해도 서버는
// 뜨고 폴백으로 동작하되, 경고를 남긴다.
// 환경 프리플라이트를 서버에도 건다. 데모에만 걸면 서버는 여전히 조용히 틀린
// Ollama에 붙을 수 있고, 기능테스트는 데모가 아니라 서버를 띄워 시연시킨다.
{
  const need = [process.env.OLLAMA_MODEL ?? "qwen2.5:7b"];
  if ((process.env.EMBEDDER ?? "") === "ollama") need.push(process.env.EMBED_MODEL ?? "bge-m3");
  const probe = await probeOllama();
  if (!reportOllama(probe, need)) process.exit(1);
  // 태그에 있다고 서빙되는 것은 아니다. 실제로 한 번씩 불러본다.
  // 생성은 EMBEDDER 설정과 무관하게 항상 쓰이므로 무조건 확인한다.
  const gen = await probeGeneration(probe.host, process.env.OLLAMA_MODEL ?? "qwen2.5:7b");
  if (!gen.ok) {
    console.error(`\n[환경] 생성 모델이 태그에는 있으나 서빙되지 않는다: ${gen.error}`);
    console.error(`  ${probe.host} 의 /api/generate 가 응답하지 않는다.\n`);
    process.exit(1);
  }
  if ((process.env.EMBEDDER ?? "") === "ollama") {
    const serving = await probeServing(probe.host, process.env.EMBED_MODEL ?? "bge-m3");
    if (!serving.ok) {
      console.error(`\n[환경] 모델이 태그에는 있으나 실제로 서빙되지 않는다: ${serving.error}`);
      console.error(`  ${probe.host} 의 /api/embeddings 가 응답하지 않는다. 컨테이너 상태를 확인한다.\n`);
      process.exit(1);
    }
  }
}

const ont = await loadRouterOntology();
console.error(
  ont.error
    ? `[router] 온톨로지 미적재(${ont.error}) — 폴백 경로로 동작한다`
    : `[router] 온톨로지 적재: 개체 ${ont.entities}개, 타입쌍 ${ont.typePairs}개`,
);

buildServer().start();
