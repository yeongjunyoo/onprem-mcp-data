// 「근거 없음」과 「조회 실패」를 구분하는가 — DB 없이 검증한다.
//
// 2026-08-17 실측: DB 가 죽은 상태에서 `ask` 가 이렇게 답했다.
//
//     "주어진 정보로는 알 수 없습니다"
//
// 그 문장은 **데이터셋에 그 내용이 없다**는 뜻이다. 인프라 장애를 그 문장으로
// 덮으면 사용자는 시스템이 모른다고 읽는다 — 실제로는 자기 설정이 틀린 것인데.
// 심사자가 DB 설정을 틀렸을 때 정확히 이 오해를 한다.
//
// 같은 실행에서 `audit.explain` 의 `branch_errors` 도 **빈 배열**이었다.
// 파이프라인이 `Promise.allSettled` 의 rejected 만 보는데, sql·vector 레인은
// 실패를 **던지지 않고 `{ok:false, error}` 로 돌려주기** 때문이다.
//
// ★ 실패하는 pool 을 주입해 DB 없이 잰다. 가짜 단언이 아니라 진짜 분기를 탄다.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Pool } from "pg";

import type { Embedder } from "./embedder.js";
import { ask, retrieve, renderValue, sqlRowsBlock, SQL_ROWS_MAX } from "./pipeline.js";
import { postJson } from "./ollamahttp.js";
import { describeError } from "./errors.js";

let passed = 0;
let failed = 0;

function ok(cond: unknown, label: string) {
  if (cond) passed++;
  else {
    failed++;
    console.error(`  FAIL: ${label}`);
  }
}

// 접속이 안 되는 pool — Node 가 여러 주소를 시도하다 실패할 때의 모양 그대로.
const deadPool = {
  query: async () => {
    throw new AggregateError(
      [
        Object.assign(new Error("connect ECONNREFUSED ::1:5433"), { code: "ECONNREFUSED" }),
        Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5433"), { code: "ECONNREFUSED" }),
      ],
      "", // ← 이 빈 문자열이 사용자에게 그대로 보였다
    );
  },
} as unknown as Pool;

const deadEmbedder: Embedder = {
  name: "test:dead",
  dim: 768,
  embed: async () => new Array(768).fill(0),
};

// ── 1) branch_errors 가 실제 이유를 담는가
{
  const r = await retrieve("환불 정책이 무엇인가", {
    pool: deadPool,
    embedder: deadEmbedder,
  });
  const errs = r.audit?.branch_errors ?? [];
  ok(errs.length > 0, "레인이 죽으면 branch_errors 가 비어 있지 않다");
  ok(
    errs.some((e) => e.includes("ECONNREFUSED")),
    "branch_errors 가 진짜 이유를 담는다 (빈 문자열이 아니다)",
  );
  ok(r.context.length === 0, "죽은 레인에서 컨텍스트는 비어 있다");
}

// ── 2) ask 가 장애를 지식 부재로 위장하지 않는가
{
  let llmCalled = false;
  const r = await ask("환불 정책이 무엇인가", {
    pool: deadPool,
    embedder: deadEmbedder,
    llm: async () => {
      llmCalled = true;
      return "주어진 정보로는 알 수 없습니다";
    },
  });
  ok(!llmCalled, "조회가 실패하면 LLM 을 부르지 않는다 (부를 근거가 없다)");
  ok(
    !r.answer.includes("주어진 정보로는 알 수 없습니다"),
    "장애를 '모른다' 로 덮지 않는다",
  );
  ok(r.answer.includes("조회"), "조회가 실패했다고 말한다");
  ok(r.answer.includes("ECONNREFUSED"), "무엇 때문인지 말한다 — 사용자가 고칠 단서");
}

// ── 3) 근거가 없을 뿐이면 여전히 LLM 에 맡긴다
//
// 이 구분이 핵심이다. 장애가 아니면 "모른다" 는 **정당한 답**이고 그대로 둔다.
{
  let llmCalled = false;
  const emptyPool = {
    query: async () => ({ rows: [], rowCount: 0 }),
  } as unknown as Pool;
  const r = await ask("존재하지 않는 개체에 대한 질문", {
    pool: emptyPool,
    embedder: deadEmbedder,
    llm: async () => {
      llmCalled = true;
      return "주어진 정보로는 알 수 없습니다";
    },
  });
  ok(llmCalled, "장애가 아니면 LLM 을 부른다");
  ok(r.answer.includes("알 수 없습니다"), "근거 없음은 그대로 '모른다' 로 답한다");
}

// ── 4) 생성 LLM 이 **기동 후** 죽으면 그 사실을 말하는가
//
// 기동 시 부재는 프리플라이트가 안내한다. 운영 중 죽는 경우는 그 검사를 이미
// 지났다 — 2026-08-17 실측에서 `AggregateError`(message: "")가 그대로 던져져
// 사용자가 **빈 이유**를 받았다.
//
// 조회는 성공했다. "조회 실패" 로 뭉뚱그리면 안 된다.
{
  const rows = [
    { id: 1, title: "환불 정책", body: "구매 후 7일 이내 환불", score: 0.9 },
  ];
  const livePool = {
    query: async () => ({ rows, rowCount: rows.length }),
  } as unknown as Pool;

  const r = await ask("환불 정책이 무엇인가", {
    pool: livePool,
    embedder: deadEmbedder,
    llm: async () => {
      throw new AggregateError(
        [Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:11435"), { code: "ECONNREFUSED" })],
        "", // ← 이 빈 문자열이 사용자에게 그대로 나갔다
      );
    },
  });

  ok(r.answer.length > 0, "생성이 실패해도 빈 답변을 돌려주지 않는다");
  ok(r.answer.includes("생성"), "조회가 아니라 **생성**이 실패했다고 말한다");
  ok(r.answer.includes("ECONNREFUSED"), "무엇 때문인지 말한다");
  ok(!r.answer.includes("조회에 실패해"), "근거를 가져왔으므로 조회 실패로 뭉뚱그리지 않는다");
  ok(
    (r.audit?.branch_errors ?? []).some((e) => e.startsWith("answer:")),
    "audit 에 생성 실패가 남는다",
  );
}

// ── 5) 모르는 DATASET 값을 거절하는가
//
// 2026-08-17 실측: `DATASET=nonexistent-profile` 로 조회하면 **130건이 돌아왔다.**
// 사용자는 자기가 지정한 데이터셋의 결과라고 믿지만 실제로는 smoke 시드였다.
// `companyX` 나 `conpanyx` 같은 오타 하나로 **다른 데이터의 답**을 받는다.
//
// PR #70 에서 MCP_TRANSPORT 오타가 조용히 stdio 로 폴백하던 것을 같은 이유로 고쳤다.
{
  const { profile } = await import("./profile.js");
  const saved = process.env.DATASET;
  const savedKg = process.env.KG_SCHEMA;
  delete process.env.KG_SCHEMA;

  try {
    for (const name of ["companyx", "bench", "smoke"]) {
      process.env.DATASET = name;
      ok(profile().name === name, `DATASET=${name} 는 그 프로파일로 돈다`);
    }

    delete process.env.DATASET;
    ok(profile().name === "smoke", "미설정은 smoke — 정당한 기본값이다");

    process.env.DATASET = "";
    ok(profile().name === "smoke", "빈 문자열도 미설정과 같다");

    for (const bad of ["conpanyx", "companyX ", "company-x", "prod"]) {
      process.env.DATASET = bad;
      let threw = false;
      let msg = "";
      try {
        profile();
      } catch (e) {
        threw = true;
        msg = e instanceof Error ? e.message : String(e);
      }
      ok(threw, `DATASET=${JSON.stringify(bad)} 를 거절한다`);
      ok(msg.includes("companyx | bench | smoke"), `거절 메시지가 가능한 값을 알려준다 (${bad})`);
    }
  } finally {
    if (saved === undefined) delete process.env.DATASET;
    else process.env.DATASET = saved;
    if (savedKg !== undefined) process.env.KG_SCHEMA = savedKg;
  }
}

// SQL 값 표기. Date 와 interval 이 「Thu Aug 01 ...」「[object Object]」로 컨텍스트에 들어가면
// 기간을 묻는 질문은 정답 행을 찾고도 답할 수 없다.
{
  // node-postgres 의 interval 객체와 같은 모양(postgres-interval). 하위 의존성을 직접 부르지 않는다.
  const PI = (s: string) => {
    const [d, t = "00:00:00"] = s.includes("days") ? s.split(" days ") : ["0", s];
    const [h, m, sec] = t.split(":").map(Number);
    return { days: Number(d) || undefined, hours: h || undefined, minutes: m || undefined, seconds: sec || undefined, toPostgres: () => s };
  };
  ok(renderValue(new Date(2024, 7, 1)) === "2024-08-01", "date 는 로컬 날짜로 (UTC 로 하루 당겨지지 않는다)");
  ok(renderValue(new Date(2024, 7, 1, 13, 24, 5)) === "2024-08-01 13:24:05", "timestamp 는 로컬 시각까지");
  ok(renderValue(PI("6 days 21:50:21")) === "6일 21시간 50분 21초", "interval 은 채점기와 같은 한국어 기간 표기");
  ok(renderValue(PI("00:00:00")) === "0초", "0 기간도 비우지 않는다");
  ok(renderValue(1234) === "1234" && renderValue("x") === "x" && renderValue(null) === "null", "나머지 값은 종전 그대로");
}

// 정형 레인의 답에는 조회 행이 그대로 붙는다. 7B 가 목록 일부나 열 하나를 빠뜨려도 값은 답에 있다.
{
  const rows = [
    { name: "박소연", salary: 9520 },
    { name: "권승호", salary: 5378 },
  ];
  const block = sqlRowsBlock(rows);
  ok(block.startsWith("[조회 결과 2건]") && block.includes("- name: 박소연, salary: 9520"), `행마다 모든 열 (got ${block})`);
  ok(sqlRowsBlock([]) === "", "행이 없으면 붙일 것도 없다");
  const many = sqlRowsBlock(Array.from({ length: SQL_ROWS_MAX + 3 }, (_, i) => ({ n: i })));
  ok(many.includes("- 외 3건") && many.split("\n").length === SQL_ROWS_MAX + 2, "상한을 넘으면 남은 건수만 적는다");
  const cut = sqlRowsBlock(rows.slice(0, 1), 2);
  ok(cut.startsWith("[조회 결과 2건]") && cut.includes("박소연") && !cut.includes("권승호") && cut.includes("- 외 1건"), "모델에게 안 간 행은 건수만");

  const rowsPool = {
    connect: async () => ({
      query: async (sql: string) =>
        /FROM companyx\.employees/.test(sql) ? { rows, rowCount: rows.length, fields: [{ name: "name" }, { name: "salary" }] } : { rows: [], rowCount: 0 },
      release: () => {},
    }),
    query: async () => ({ rows: [], rowCount: 0 }),
  } as unknown as Pool;
  const deps = {
    pool: rowsPool,
    embedder: deadEmbedder,
    nl2sql: async () => "SELECT name, salary FROM companyx.employees",
    llm: async () => "기술지원팀 직원은 박소연, 권승호입니다.",
  };
  const r = await ask("기술지원팀 직원 목록과 연봉을 알려줘", deps);
  ok(r.route === "structured", `정형 질문 (got ${r.route})`);
  ok(r.answer.startsWith("기술지원팀 직원은") && r.answer.includes("salary: 9520") && r.answer.includes("salary: 5378"), `모델 문장 뒤에 연봉이 붙는다 (got ${r.answer})`);
  ok(r.answer.split("\n").filter((l) => l.startsWith("- ")).every((l) => r.context.includes(l.slice(2).split(", ")[0].replace(": ", "="))), "붙인 행은 전부 컨텍스트에 있다");
  // 한 행이 약 22 토큰(estTokens)이라 예산 30 이면 한 행만 모델에게 간다.
  const tight = await ask("기술지원팀 직원 목록과 연봉을 알려줘", { ...deps, budget: 30 });
  const tail = tight.answer.slice(tight.answer.indexOf("[조회 결과"));
  ok(tight.curated.kept.length === 1 && tail.startsWith("[조회 결과 2건]") && tail.includes("salary: 9520") && !tail.includes("salary: 5378") && tail.includes("- 외 1건"), `예산 밖으로 밀린 행은 싣지 않고 건수만 (got ${tail})`);
  process.env.ANSWER_SQL_ROWS = "0";
  const off = await ask("기술지원팀 직원 목록과 연봉을 알려줘", deps);
  delete process.env.ANSWER_SQL_ROWS;
  ok(off.answer === "기술지원팀 직원은 박소연, 권승호입니다.", "ANSWER_SQL_ROWS=0 이면 종전 그대로");
  const gen = await ask("기술지원팀 직원 목록과 연봉을 알려줘", {
    ...deps,
    llm: async () => {
      throw new Error("fetch failed");
    },
  });
  ok(gen.answer.includes("답변 생성에 실패") && gen.answer.includes("salary: 9520"), "생성이 죽어도 조회 결과는 보여준다");
}

// Ollama POST(ollamahttp.ts). 마감은 signal 하나가 정하고, 시간 초과는 호출부가 가릴 수 있는 이름으로 온다.
// fetch 의 300초 헤더 한도 자체는 단위 테스트로 재현할 수 없어(300초) 계약만 잰다.
{
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const wait = req.url === "/slow" ? 1500 : 30;
      setTimeout(() => {
        if (res.destroyed) return;
        if (req.url === "/missing") {
          res.writeHead(404).end("model not found");
          return;
        }
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ response: ` 받음:${JSON.parse(body).prompt} `, embedding: [0.5, 0.25] }));
      }, wait);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;

  const okRes = await postJson(`${base}/api/generate`, { prompt: "안녕" }, AbortSignal.timeout(5000));
  ok(okRes.status === 200 && JSON.parse(okRes.text).response === " 받음:안녕 ", `응답 본문을 그대로 돌려준다 (got ${okRes.status} ${okRes.text})`);
  const miss = await postJson(`${base}/missing`, { prompt: "x" }, AbortSignal.timeout(5000));
  ok(miss.status === 404 && miss.text === "model not found", "2xx 가 아니어도 상태와 본문을 돌려준다(판단은 호출부)");

  let slowErr: unknown;
  const t0 = Date.now();
  try {
    await postJson(`${base}/slow`, { prompt: "x" }, AbortSignal.timeout(200));
  } catch (e) {
    slowErr = e;
  }
  ok(slowErr instanceof Error && slowErr.name === "TimeoutError", `마감에 걸리면 TimeoutError (got ${String(slowErr)})`);
  ok(Date.now() - t0 < 1200, "마감에서 끊는다(서버를 끝까지 기다리지 않는다)");

  let refused: unknown;
  const closed = createServer();
  await new Promise<void>((r) => closed.listen(0, "127.0.0.1", () => r()));
  const deadPort = (closed.address() as AddressInfo).port;
  await new Promise<void>((r) => closed.close(() => r()));
  try {
    await postJson(`http://127.0.0.1:${deadPort}/api/generate`, {}, AbortSignal.timeout(5000));
  } catch (e) {
    refused = e;
  }
  ok(describeError(refused).includes("ECONNREFUSED"), `꺼진 포트는 이유를 말한다 (got ${describeError(refused)})`);

  // 생성과 임베딩이 이 호출을 쓰고, 시간 초과를 사용자가 고칠 값으로 말한다.
  process.env.OLLAMA_HOST = base;
  const llm = (await import(new URL("./llm.js?ollamahttp", import.meta.url).href)) as typeof import("./llm.js");
  delete process.env.OLLAMA_HOST;
  ok((await llm.generate("질문")) === "받음:질문", "generate 는 응답을 다듬어 돌려준다");
  const { OllamaEmbedder } = await import("./embedder.js");
  const emb = await new OllamaEmbedder("bge-m3", base).embed("x");
  ok(emb.length === 2 && emb[0] === 0.5, `embed 는 벡터를 돌려준다 (got ${JSON.stringify(emb)})`);
  server.close();
  server.closeAllConnections();
}

console.log(`degraded.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
