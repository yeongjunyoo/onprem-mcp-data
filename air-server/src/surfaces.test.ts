// MCP 표준 표면 테스트 — 리소스와 프롬프트가 실제로 등록되고 응답하는지.
//
// 데이터베이스도 모델도 없이 돈다. 리소스 핸들러는 파일과 상수만 읽고,
// 프롬프트 핸들러는 문자열을 만들 뿐이다. 그래서 CI에서 그대로 검증된다.
import { buildPrompts } from "./prompts.js";
import { buildAnswerPrompt } from "./llm.js";
import { buildCompanyxSqlPrompt } from "./nl2sql.js";
import { buildAuditRecord } from "./auditrecord.js";
import { buildResources } from "./resources.js";
import { resolveTransport, SANITIZER_OPTIONS } from "./server.js";
import { reportOllama } from "./preflight.js";
import { sanitizerPlugin } from "@airmcp-dev/core";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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
    "schema://dataset/tables",
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

  const schema = resources.find((r) => r.uri === "schema://dataset/tables")!;
  const card = String(await schema.handler(schema.uri, { requestId: "t", serverName: "s" }));
  ok(card.includes("("), "스키마 카드가 컬럼 목록 형태다");
  // ★ 카드는 자기가 어느 프로파일의 것인지 스스로 밝혀야 한다.
  //
  // 종전 URI 는 schema://companyx/tables 였는데 핸들러는 **활성 프로파일**의
  // 카드를 돌려준다. DATASET 미설정이면 스모크 시드(orders/documents)가 나온다.
  // 즉 이름은 companyx 인데 내용은 8테이블이 아니었다 — 심사자가 MCP 로 열어
  // 보면 이름이 거짓말을 한다. 읽는 사람이 다른 리소스를 열어 봐야 자기가 무엇을
  // 보고 있는지 아는 상태는 근거 공개가 아니다.
  ok(card.startsWith("# 프로파일: "), "스키마 카드 첫 줄이 프로파일을 밝힌다");
  ok(
    ["smoke", "bench", "companyx"].some((n) => card.split("\n")[0].includes(n)),
    "밝힌 프로파일 이름이 유효하다",
  );

  // ★ 감사 스키마 리소스는 실물과 필드가 같아야 한다.
  //
  // 설명이 "감사 결과를 파싱하려는 쪽이 먼저 읽을 문서다" 라고 말한다. 즉 호스트가
  // 이걸 계약으로 삼는다. 계약이 실물과 다르면 파싱이 조용히 깨진다.
  //
  // 실제로 갈려 있었다 — 리소스는 `fingerprint` 하나를 적었는데 레코드에는
  // routing_fingerprint / pipeline_fingerprint 둘이 있다. 그 분리는 "무엇이
  // 결정론이고 무엇이 아닌가" 를 보여 주는 설계인데 문서에서 사라져 있었고,
  // branch_errors(우아한 저하 근거)와 generated_at 도 빠져 있었다.
  // ★ 증거 목록 리소스는 **증거 절**을 줘야 한다.
  //
  // 종전 구현은 "## 9. Evidence manifest" 를 문자열로 찾고 못 찾으면 보고서 앞
  // 4000자를 대신 돌려줬다. 절을 하나 끼워 넣어 번호가 밀리기만 해도, 이 리소스는
  // "개발보고서 증거 목록" 이라는 이름으로 서론을 준다. 조용한 오답이다.
  const evidenceRes = resources.find((r) => r.uri === "docs://report/evidence")!;
  const evidenceText = String(
    await evidenceRes.handler(evidenceRes.uri, { requestId: "t", serverName: "s" }),
  );
  ok(
    /^##\s+\d+\.\s*Evidence manifest/i.test(evidenceText.trim()),
    "증거 목록 리소스가 Evidence manifest 절로 시작한다",
  );
  ok(
    !evidenceText.includes("찾지 못했습니다"),
    "증거 절을 실제로 찾았다(못 찾으면 조용히 다른 것을 주지 않고 그렇게 말한다)",
  );

  const auditRes = resources.find((r) => r.uri === "audit://schema/v1")!;
  const auditDoc = JSON.parse(
    String(await auditRes.handler(auditRes.uri, { requestId: "t", serverName: "s" })),
  );
  const sampleRecord = buildAuditRecord({
    query: "표면 테스트",
    route: "structured",
    sql: { text: "SELECT 1", result: undefined, repaired: false },
    fused: [],
    curated: { kept: [], dropped: [], tokensUsed: 0, budget: 256, brokenRows: 0, notes: [] },
    context: "",
    audit: {
      route: {
        route: "structured",
        lane: "관계형",
        tools: ["sql.query"],
        structured_signals: [],
        semantic_signals: [],
        graph_signals: [],
        rationale: "",
        deterministic: true,
      },
      candidates: { sql: 0, vector: 0, graph: 0, fused: 0 },
      branch_errors: [],
      curate: {
        kept: [],
        dropped: [],
        tokens_used: 0,
        budget: 256,
        broken_rows: 0,
        structure_preserved: true,
      },
    },
  } as never);
  // ★ 감사 레코드는 두 계층이다.
  //
  //   buildAuditRecord()          파이프라인이 만드는 12종
  //   server.ts 의 audit.explain  거기에 executed_at · cache_policy 를 덧붙인 14종
  //
  // 계약이 설명하는 것은 **도구가 돌려주는 14종**이다. 2026-08-17 에 이 테스트가
  // 12종만 만들어 놓고 대조해 계약의 두 필드를 "유령" 으로 판정했다 —
  // 틀린 것은 계약이 아니라 **대조 대상의 계층**이었다.
  const toolRecord = {
    ...sampleRecord,
    executed_at: "2026-08-17T00:00:00.000Z",
    cache_policy: "excluded" as const,
  };
  const documentedFields = Object.keys(auditDoc.fields ?? {}).sort();
  const actualFields = Object.keys(toolRecord).sort();
  // 특정 경로에서만 붙는 선택 필드(답변 생성, 미해소 게이트, 섞인 질문의 없는 개체). 그냥 예외로 빼면 다음에
  // 진짜 유령이 생겨도 못 잡으므로, 타입에서 선택인 것만 이름으로 못박아 둔다.
  const OPTIONAL_FIELDS = ["grounding", "not_found", "missing_entities"];
  const undocumented = actualFields.filter((f) => !documentedFields.includes(f));
  const phantom = documentedFields.filter(
    (f) => !actualFields.includes(f) && !OPTIONAL_FIELDS.includes(f),
  );
  ok(undocumented.length === 0, `감사 레코드의 모든 필드가 문서화됨 (누락: ${undocumented})`);
  ok(phantom.length === 0, `문서에 없는 필드를 지어내지 않음 (유령: ${phantom})`);
  ok(auditDoc.schema === sampleRecord.schema, "스키마 식별자가 실물과 같다");

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

  // ★ 노출 프롬프트는 실행 프롬프트와 **같아야** 한다.
  //
  // README 는 "서버가 실제로 쓰는 템플릿을 그대로 노출합니다" 라고 주장하고
  // prompts.ts 설명도 "ask 도구가 쓰는 규칙과 같다" 고 적혀 있다. 종전에는 저기
  // 손으로 줄인 사본이 있었고 언어 고정·그래프 트리플 해석·SQL 결과 인용 규칙이
  // 빠져 있었다. 문구를 부분 일치로 확인하면 그 누락을 못 잡는다 — 그래서
  // **전문 동일성**을 본다.
  const grounded = prompts.find((p) => p.name === "grounded-answer")!;
  const gm = await grounded.handler({ question: "질문", context: "근거" });
  ok(
    gm[0].content === buildAnswerPrompt("질문", "근거"),
    "노출된 근거 기반 프롬프트가 ask 실행 경로와 전문 동일",
  );

  const sqlPrompt = prompts.find((p) => p.name === "nl2sql-with-schema-card")!;
  const sm = await sqlPrompt.handler({ question: "질문" });
  ok(
    sm[0].content === buildCompanyxSqlPrompt("질문"),
    "노출된 NL2SQL 프롬프트가 companyx 실행 경로와 전문 동일",
  );
  ok(
    sm[0].content.includes("companyx. 접두사"),
    "실제 프롬프트에만 있던 스키마 접두사 규칙이 노출본에도 있다",
  );

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

  // --- sanitizer: SQL 비교 연산자를 지우지 않는다 ---
  // air 기본값(stripHtml)은 `<` 부터 `>` 까지를 태그로 보고 지운다. 서버가 쓰는 설정으로
  // air 의 실제 미들웨어를 돌려, sql.query 와 ask 에 들어온 연산자가 그대로 남는지 본다.
  const sanitize = sanitizerPlugin(SANITIZER_OPTIONS).middleware![0].before!;
  for (const sql of [
    "SELECT name FROM companyx.employees WHERE salary < 5000 AND salary > 3000",
    "SELECT count(*) FROM companyx.support_tickets WHERE status <> 'closed'",
  ]) {
    const out = (await sanitize({ tool: { name: "sql.query" }, params: { sql } } as never)) as {
      params: { sql: string };
    };
    ok(out.params.sql === sql, `sanitizer 가 SQL 연산자를 지우지 않는다: ${sql}`);
  }
  // 한국어 질문은 제목을 꺾쇠로 감싸기도 한다. 기본값이면 제목이 통째로 사라진다.
  const question = "<클라우드 마이그레이션> 제안서 내용 보여줘";
  const askOut = (await sanitize({ tool: { name: "ask" }, params: { query: question } } as never)) as {
    params: { query: string };
  };
  ok(askOut.params.query === question, "sanitizer 가 질문 속 꺾쇠 제목을 지우지 않는다");
  const ctrlOut = (await sanitize({ tool: { name: "ask" }, params: { query: "매출\u0007 합계" } } as never)) as {
    params: { query: string };
  };
  ok(ctrlOut.params.query === "매출 합계", "제어 문자 제거는 그대로 한다");

  // --- stdio: 프리플라이트가 stdout 에 쓰지 않는다 ---
  // stdout 은 MCP JSON-RPC 통로다. 사람이 읽을 줄이 섞이면 클라이언트가 파싱 오류를 낸다.
  const realLog = console.log;
  const realErr = console.error;
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  console.log = (...a: unknown[]) => void stdoutLines.push(a.join(" "));
  console.error = (...a: unknown[]) => void stderrLines.push(a.join(" "));
  let preflightOk = false;
  try {
    preflightOk = reportOllama(
      { reachable: true, host: "http://localhost:11434", models: ["qwen2.5-coder:7b", "bge-m3"] } as never,
      ["qwen2.5-coder:7b", "bge-m3"],
    );
  } finally {
    console.log = realLog;
    console.error = realErr;
  }
  ok(preflightOk, "모델이 다 있으면 프리플라이트가 통과한다");
  ok(stdoutLines.length === 0, `프리플라이트가 stdout 에 쓰지 않는다 (got ${stdoutLines.length}줄)`);
  ok(stderrLines.some((l) => l.includes("[환경] Ollama")), "프리플라이트 안내 줄은 stderr 로 간다");

  // --- 기동: 데이터셋 프로파일 오타는 다른 일을 하기 전에 거절한다 ---
  // 리허설(2026-10-06)에서 DATASET 오타로 띄우면 「폴백으로 동작한다」를 두 번 찍은 뒤에야 같은
  // 오류로 끝났다. Ollama 주소를 닫힌 포트로 두어, 프로파일보다 Ollama 를 먼저 보면 이 단언이 깨진다.
  const typo = spawnSync(process.execPath, [fileURLToPath(new URL("./index.js", import.meta.url))], {
    env: { ...process.env, DATASET: "conpanyx", OLLAMA_HOST: "http://127.0.0.1:9" },
    encoding: "utf8",
    timeout: 30_000,
  });
  ok(typo.status === 1, `DATASET 오타면 종료 코드 1 (got ${typo.status})`);
  ok(typo.stderr.includes("모르는 프로파일이다") && typo.stderr.includes("companyx | bench | smoke"), "오타 사유와 가능한 값을 알린다");
  ok(!typo.stderr.includes("폴백"), "폴백으로 돈다는 말 없이 거절한다");
  ok(typo.stdout === "", "거절할 때도 stdout 에 쓰지 않는다");

  console.log(`\nsurfaces.test: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
