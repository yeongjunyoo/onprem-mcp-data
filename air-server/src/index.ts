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
import { probeOllama, reportOllama } from "./preflight.js";

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
}

const ont = await loadRouterOntology();
console.error(
  ont.error
    ? `[router] 온톨로지 미적재(${ont.error}) — 폴백 경로로 동작한다`
    : `[router] 온톨로지 적재: 개체 ${ont.entities}개, 타입쌍 ${ont.typePairs}개`,
);

buildServer().start();
