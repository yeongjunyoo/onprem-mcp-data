// MCP 표준 표면 테스트 — 리소스와 프롬프트가 실제로 등록되고 응답하는지.
//
// 데이터베이스도 모델도 없이 돈다. 리소스 핸들러는 파일과 상수만 읽고,
// 프롬프트 핸들러는 문자열을 만들 뿐이다. 그래서 CI에서 그대로 검증된다.
import { buildPrompts } from "./prompts.js";
import { buildResources } from "./resources.js";
import { resolveTransport } from "./server.js";

let pass = 0,
  fail = 0;
function ok(cond: boolean, msg: string) {
  if (cond) pass++;
  else {
    fail++;
    console.error("  FAIL:", msg);
  }
}

async function main() {
  // --- resources ---
  const resources = buildResources();
  ok(resources.length >= 6, `리소스 6개 이상 등록 (got ${resources.length})`);

  const uris = resources.map((r) => r.uri);
  for (const expected of [
    "schema://companyx/tables",
    "dataset://companyx/manifest",
    "eval://results/index",
    "profile://dataset/active",
    "docs://report/evidence",
    "audit://schema/v1",
  ]) {
    ok(uris.includes(expected), `리소스 ${expected} 존재`);
  }

  for (const r of resources) {
    ok(Boolean(r.name && r.description), `${r.uri}: 이름과 설명이 있다`);
    const content = await r.handler(r.uri, { requestId: "test", serverName: "onprem-mcp-data" });
    const text = typeof content === "string" ? content : "text" in content ? content.text : "";
    ok(text.length > 0, `${r.uri}: 빈 응답이 아니다`);
    // 리소스는 읽기 전용이어야 한다. 응답에 자격증명이 섞이면 즉시 실패다.
    ok(!/password|secret|token|api[_-]?key/i.test(text), `${r.uri}: 자격증명 문자열 없음`);
  }

  const schema = resources.find((r) => r.uri === "schema://companyx/tables")!;
  const card = String(await schema.handler(schema.uri, { requestId: "t", serverName: "s" }));
  ok(card.includes("("), "스키마 카드가 컬럼 목록 형태다");

  const prof = resources.find((r) => r.uri === "profile://dataset/active")!;
  const profJson = JSON.parse(String(await prof.handler(prof.uri, { requestId: "t", serverName: "s" })));
  ok(["smoke", "bench", "companyx"].includes(profJson.profile), "활성 프로파일 이름이 유효하다");
  ok(typeof profJson.vector_table === "string", "벡터 테이블이 노출된다");

  // --- prompts ---
  const prompts = buildPrompts();
  ok(prompts.length >= 4, `프롬프트 4개 이상 등록 (got ${prompts.length})`);
  const names = prompts.map((p) => p.name);
  for (const expected of ["grounded-answer", "nl2sql-with-schema-card", "explain-routing", "review-generated-sql"]) {
    ok(names.includes(expected), `프롬프트 ${expected} 존재`);
  }

  for (const p of prompts) {
    ok(Boolean(p.description), `${p.name}: 설명이 있다`);
    const args = Object.fromEntries((p.arguments ?? []).map((a) => [a.name, `<${a.name}>`]));
    const msgs = await p.handler(args);
    ok(msgs.length > 0, `${p.name}: 메시지를 만든다`);
    ok(msgs.every((m) => m.role === "user" || m.role === "assistant"), `${p.name}: role이 유효하다`);
    // 인자가 실제로 템플릿에 들어가야 한다. 안 들어가면 인자 선언이 거짓말이다.
    for (const a of p.arguments ?? []) {
      if (a.required) {
        ok(msgs.some((m) => m.content.includes(`<${a.name}>`)), `${p.name}: 필수 인자 ${a.name}가 본문에 반영된다`);
      }
    }
  }

  const grounded = prompts.find((p) => p.name === "grounded-answer")!;
  const gm = await grounded.handler({ question: "질문", context: "근거" });
  ok(gm[0].content.includes("컨텍스트에 없는"), "근거 기반 템플릿이 접지 규칙을 담는다");

  // --- transport 해석 ---
  //
  // 종전에는 `=== "sse"` 이외가 전부 stdio 로 조용히 떨어졌다. 주석은 http 도
  // 지원한다고 적어둔 채였으므로, MCP_TRANSPORT=http 를 준 사람은 에러 없이
  // stdio 서버를 받고 성공한 줄 안다. 잘못 다룬 설정은 기본값으로 메꾸는 것보다
  // 기동을 멈추는 편이 싸다.
  const savedTransport = process.env.MCP_TRANSPORT;
  const savedPort = process.env.MCP_PORT;
  try {
    delete process.env.MCP_TRANSPORT;
    ok(resolveTransport().type === "stdio", "미지정이면 stdio");

    process.env.MCP_TRANSPORT = "stdio";
    ok(resolveTransport().type === "stdio", "stdio 명시");

    process.env.MCP_TRANSPORT = "sse";
    delete process.env.MCP_PORT;
    const sse = resolveTransport();
    ok(sse.type === "sse" && sse.port === 3510, "sse 기본 포트 3510");

    process.env.MCP_PORT = "3600";
    const sse2 = resolveTransport();
    ok(sse2.type === "sse" && sse2.port === 3600, "MCP_PORT 반영");

    // ★ 핵심 — 모르는 값은 조용히 넘어가지 않는다.
    // 공백만 있는 값은 "미지정"으로 본다 — 셸에서 빈 변수를 넘기는 흔한 형태다.
    // 결정이라면 테스트가 그 결정을 말해야 한다.
    process.env.MCP_TRANSPORT = "   ";
    ok(resolveTransport().type === "stdio", "공백만 있는 값은 미지정과 같다");

    for (const bad of ["http", "HTTP", "websocket", "sse2", "stdio2"]) {
      process.env.MCP_TRANSPORT = bad;
      let threw = false;
      try {
        resolveTransport();
      } catch {
        threw = true;
      }
      ok(threw, `MCP_TRANSPORT=${JSON.stringify(bad)} 는 거절한다`);
    }

    process.env.MCP_TRANSPORT = "sse";
    for (const badPort of ["0", "70000", "abc", "-1"]) {
      process.env.MCP_PORT = badPort;
      let threw = false;
      try {
        resolveTransport();
      } catch {
        threw = true;
      }
      ok(threw, `MCP_PORT=${badPort} 는 거절한다`);
    }
  } finally {
    if (savedTransport === undefined) delete process.env.MCP_TRANSPORT;
    else process.env.MCP_TRANSPORT = savedTransport;
    if (savedPort === undefined) delete process.env.MCP_PORT;
    else process.env.MCP_PORT = savedPort;
  }

  console.log(`\nsurfaces.test: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
