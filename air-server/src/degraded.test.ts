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
import { ask, retrieve, renderValue, sqlRowsBlock, SQL_ROWS_MAX, writeRefusal, NO_TABLE_ANSWER } from "./pipeline.js";
import { pickSql, readsTable, writeStatement, NO_TABLE, type Nl2SqlReport } from "./nl2sql.js";
import { describeAbsentAttribute } from "./notfound.js";
import { postJson } from "./ollamahttp.js";
import { describeError } from "./errors.js";
import { assertCorpusEmbedder } from "./companyx.js";

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

// 코퍼스 임베더 확인(companyx.ts assertCorpusEmbedder). 2026-10-01 CPU 정본에서 코퍼스가 해시 벡터로
// 남은 채 bge-m3 로 질의해 벡터 레인이 오류 없이 0/10 이 됐다. 저장된 벡터와 지금 임베더가 다르면 던진다.
{
  const rowPool = (rows: { title: string; body: string; v: string }[]) =>
    ({ query: async () => ({ rows }) }) as unknown as Parameters<typeof assertCorpusEmbedder>[0];
  const fixed = (v: number[]): Embedder => ({ name: "stub", dim: v.length, embed: async () => v });
  const reason = (p: Promise<unknown>) => p.then(() => "", (e: Error) => e.message);
  const row = [{ title: "t", body: "b", v: "[1,0,0]" }];
  ok((await assertCorpusEmbedder(rowPool(row), fixed([2, 0, 0]))) > 0.999, "같은 방향이면 통과한다(크기는 상관없다)");
  const other = await reason(assertCorpusEmbedder(rowPool(row), fixed([0, 1, 0])));
  ok(other.includes("stub 로 채워져 있지 않다(첫 조각 코사인 0.000)"), `다른 임베더면 코사인과 함께 던진다 (got ${other})`);
  const width = await reason(assertCorpusEmbedder(rowPool(row), fixed([1, 0])));
  ok(width.includes("폭 3 이 stub 의 폭 2 과 다르다"), `폭이 다르면 던진다 (got ${width})`);
  const none = await reason(assertCorpusEmbedder(rowPool([]), fixed([1, 0, 0])));
  ok(none.includes("임베딩이 없다"), `임베딩이 하나도 없으면 던진다 (got ${none})`);
}

// ── 생성 모델이 만든 쓰기 문장과 상수 SELECT(G17 ②④) ─────────────────────────
// 7B 는 「모든 직원의 연봉을 0으로 바꿔줘」에 UPDATE 를, 「오늘 서울 날씨 어때?」에 SELECT '서울 날씨' 를
// 만들었다(경계 실측 원출력). 쓰기 문장은 원래도 실행되지 않았지만 흔적 없이 버려져 답이 「주어진 정보로는
// 알 수 없습니다」였고, 상수 SELECT 는 실행돼 답이 「서울 날씨」였다.
{
  const report = (raw: string) => {
    const rep: Nl2SqlReport = {};
    return { sql: pickSql(raw, rep), refused: rep.refused };
  };
  const upd = report("UPDATE companyx.employees SET salary = 0;");
  ok(upd.sql === null && upd.refused?.kind === "UPDATE" && upd.refused.text === "UPDATE companyx.employees SET salary = 0", `UPDATE 는 실행하지 않고 종류와 문장을 남긴다 (got ${JSON.stringify(upd)})`);
  ok(report("DELETE FROM companyx.sales;").refused?.kind === "DELETE", "DELETE");
  ok(report("```sql\n-- 테이블 정리\nDROP TABLE companyx.sales\n```").refused?.kind === "DROP", "코드펜스와 주석을 벗기고 본다");
  for (const kw of ["INSERT INTO t VALUES (1)", "ALTER TABLE t ADD c int", "TRUNCATE companyx.sales", "CREATE TABLE t (c int)", "GRANT ALL ON t TO x", "REVOKE ALL ON t FROM x"]) {
    ok(report(kw).refused?.kind === kw.split(" ")[0], `${kw.split(" ")[0]} 도 쓰기 문장이다`);
  }
  // 종전 extractSql 은 UPDATE 안의 부분 SELECT 를 골라 실행할 수 있었다. 첫 문장이 쓰기면 통째로 거부한다.
  const sub = report("UPDATE companyx.employees SET salary = 0 WHERE dept_id = (SELECT id FROM companyx.departments)");
  ok(sub.sql === null && sub.refused?.kind === "UPDATE", `쓰기 문장 안의 SELECT 를 실행하지 않는다 (got ${JSON.stringify(sub)})`);
  // 첫 문장이 SELECT 면 종전 그대로(TC-151: 질문에 섞인 DROP 은 모델 출력의 뒤에 있어도 실행되지 않는다).
  const mixed = report("SELECT region FROM companyx.clients WHERE name = 'Client-A'; DROP TABLE companyx.sales; --");
  ok(mixed.sql === "SELECT region FROM companyx.clients WHERE name = 'Client-A'" && !mixed.refused, `첫 문장이 SELECT 면 그 문장만 (got ${JSON.stringify(mixed)})`);
  const weather = report("```sql\nSELECT '서울 날씨' AS answer;\n```");
  ok(weather.sql === null && weather.refused?.kind === NO_TABLE && weather.refused.text === "SELECT '서울 날씨' AS answer", `테이블을 읽지 않는 SELECT 는 실행하지 않는다 (got ${JSON.stringify(weather)})`);
  ok(report("SELECT current_date").refused?.kind === NO_TABLE, "FROM 없는 함수 호출도 상수다");
  ok(report("SELECT extract(year from now())").refused?.kind === NO_TABLE, "extract(… from …) 의 from 은 테이블이 아니다");
  ok(report("SELECT 'from' AS x").refused?.kind === NO_TABLE, "문자열 속 from 은 테이블이 아니다");
  for (const sql of [
    "SELECT count(*)::int AS n FROM companyx.sales",
    "SELECT (SELECT count(*) FROM companyx.sales)::int AS sales",
    "SELECT extract(year from created_at) AS y FROM companyx.sales",
    "WITH x AS (SELECT 1 AS n) SELECT n FROM x",
  ]) {
    ok(report(sql).sql === sql && readsTable(sql), `테이블을 읽는 SELECT 는 그대로: ${sql}`);
  }
  ok(writeStatement("다음 SQL 입니다.\nSELECT 1 FROM t") === null, "설명 줄 뒤의 SELECT 는 쓰기 문장이 아니다");

  // ask: 쓰기 문장은 7B 를 부르지 않고 바꾸지 않았다고 답한다. 정형 레인 하나뿐이라 컨텍스트는 비어 있다.
  const emptyPool = { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as Pool;
  let called = 0;
  const llm = async () => {
    called++;
    return "모든 직원의 연봉을 0으로 변경했습니다.";
  };
  const writeNl2sql = async (_q: string, rep?: Nl2SqlReport) => {
    if (rep) rep.refused = { kind: "UPDATE", text: "UPDATE companyx.employees SET salary = 0" };
    return null;
  };
  const w = await ask("모든 직원의 연봉을 0으로 바꿔줘", { pool: emptyPool, embedder: deadEmbedder, nl2sql: writeNl2sql, llm });
  ok(called === 0, "쓰기 요청에는 7B 를 부르지 않는다");
  ok(w.answer === writeRefusal("UPDATE") && w.answer.includes("읽기 전용"), `읽기 전용이라고 답한다 (got ${w.answer})`);
  ok(!/변경|삭제|완료|했습니다/.test(writeRefusal("DELETE")), "답에 「변경」, 「삭제」, 「완료」, 「했습니다」가 없다(TC-145, TC-146)");
  ok(w.sql.text === null && w.sql.refused?.kind === "UPDATE", "실행한 SQL 은 없고 거부한 문장은 따로 남는다");

  // 상수 SELECT: 다른 근거가 없으면 7B 없이 알 수 없다고 답한다.
  const constNl2sql = async (_q: string, rep?: Nl2SqlReport) => {
    if (rep) rep.refused = { kind: NO_TABLE, text: "SELECT '서울 날씨' AS answer" };
    return null;
  };
  const c = await ask("오늘 서울 날씨 어때?", { pool: emptyPool, embedder: deadEmbedder, nl2sql: constNl2sql, llm });
  ok(called === 0 && c.answer === NO_TABLE_ANSWER && !c.answer.includes("서울 날씨"), `상수 SELECT 의 값을 답으로 쓰지 않는다 (got ${c.answer})`);

  // 없는 항목(랜덤 테스트 사전 점검 D2): 생성 모델에 넘기지 않고 없다고 답한다. 부서 인원은 그대로 넘긴다.
  let generated = 0;
  const countingNl2sql = async () => {
    generated++;
    return null;
  };
  const age = await ask("직원들의 평균 나이는 몇 살이야?", { pool: emptyPool, embedder: deadEmbedder, nl2sql: countingNl2sql, llm });
  ok(age.route === "structured" || age.route === "hybrid", `정형 레인 질문 (got ${age.route})`);
  ok(generated === 0 && called === 0 && age.sql.absent === "나이", "없는 항목은 SQL 도 답도 생성하지 않는다");
  ok(age.answer === describeAbsentAttribute("나이"), `나이는 없는 항목이라고 답한다 (got ${age.answer})`);
  const head = await ask("Client-A의 직원 수는 몇 명이야?", { pool: emptyPool, embedder: deadEmbedder, nl2sql: countingNl2sql, llm });
  ok(head.sql.absent === "고객사의 직원 수" && !/\d+명/.test(head.answer), `고객사의 직원 수를 지어내지 않는다 (got ${head.answer})`);
  await ask("클라우드사업부 직원 수는 몇 명이야?", { pool: emptyPool, embedder: deadEmbedder, nl2sql: countingNl2sql, llm });
  ok(generated === 1, "부서 인원 질문은 정형 레인으로 간다");
}

// 임베딩 입력이 모델 문맥을 넘을 때(embedder.ts fitToContext). 2026-10-06 경계 실측에서 같은 질문 200번
// (4,400자)이 「ollama embeddings 500: the input length exceeds the context length」를 답으로 냈다.
// 가짜 Ollama 는 문맥을 넘는 입력에 그 500 을 돌려준다. 문맥은 4,000자(실측에서 이 반복 질문은
// 4,092자까지 들어갔다), /tight 는 600자다.
{
  const seen: string[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const prompt = String(JSON.parse(body).prompt);
      seen.push(prompt);
      if (req.url?.startsWith("/missing/")) {
        res.writeHead(404).end("model not found");
        return;
      }
      const n = Array.from(prompt).length;
      if (n > (req.url?.startsWith("/tight/") ? 600 : 4000)) {
        res.writeHead(500, { "content-type": "application/json" }).end('{"error":"the input length exceeds the context length"}');
        return;
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ embedding: [n, 1] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const { OllamaEmbedder, EMBED_RETRY_CHARS } = await import("./embedder.js");
  // 자른 사실은 stderr 로 간다. 그 줄만 모으고 단언의 FAIL 줄은 그대로 찍히게 호출 동안만 가로챈다.
  const logs: string[] = [];
  const quiet = async <T,>(f: () => Promise<T>): Promise<T> => {
    const realError = console.error;
    console.error = (...a: unknown[]) => void logs.push(a.join(" "));
    try {
      return await f();
    } finally {
      console.error = realError;
    }
  };
  try {
    const emb = new OllamaEmbedder("bge-m3", base);
    seen.length = 0;
    ok((await quiet(() => emb.embed("짧은 질문")))[0] === 5 && seen.length === 1, "문맥 안의 입력은 한 번에, 그대로 보낸다");
    const tc153 = "2025년 3분기 총 매출액은 얼마야? ".repeat(100);
    seen.length = 0;
    ok(
      (await quiet(() => emb.embed(tc153)))[0] === 2200 && seen.length === 1 && logs.length === 0,
      "들어가는 입력(TC-153 의 2,200자)은 자르지 않고 한 번에 보낸다",
    );
    const long = "2025년 3분기 총 매출액은 얼마야? ".repeat(200);
    seen.length = 0;
    const v = await quiet(() => emb.embed(long));
    ok(v[0] === EMBED_RETRY_CHARS && seen.length === 2, `넘치면 앞 ${EMBED_RETRY_CHARS}자로 다시 보낸다 (got ${v[0]}, 호출 ${seen.length})`);
    ok(seen[1] === long.slice(0, EMBED_RETRY_CHARS), "다시 보낸 것은 원문의 앞부분이다");
    ok(
      logs.some((l) => l.includes("입력 4400자") && l.includes(`앞 ${EMBED_RETRY_CHARS}자`)),
      `자른 사실을 stderr 에 남긴다 (got ${logs.join(" | ")})`,
    );

    seen.length = 0;
    const tight = await quiet(() => new OllamaEmbedder("bge-m3", `${base}/tight`).embed(long));
    ok(tight[0] === 500 && seen.length === 4, `그래도 넘치면 반씩 줄인다(4,400 → 2,000 → 1,000 → 500) (got ${tight[0]}, 호출 ${seen.length})`);

    seen.length = 0;
    await quiet(() => emb.embed("\u{1F600}".repeat(5000)));
    const cut = seen[1] ?? "";
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    ok(Array.from(cut).length === EMBED_RETRY_CHARS && !lone.test(cut), "이모지(서로게이트 쌍)를 가르지 않고 문자 단위로 자른다");

    seen.length = 0;
    let missErr = "";
    try {
      await quiet(() => new OllamaEmbedder("bge-m3", `${base}/missing`).embed(long));
    } catch (e) {
      missErr = String(e);
    }
    ok(
      missErr.includes("ollama embeddings 404: model not found") && seen.length === 1,
      `문맥 초과가 아닌 오류는 다시 보내지 않고 종전처럼 던진다 (got ${missErr})`,
    );
  } finally {
    server.close();
    server.closeAllConnections();
  }
}

// 생성 프롬프트의 질문 상한(llm.ts questionForModel). num_ctx 를 넘는 프롬프트는 Ollama 가 앞쪽(지시문과
// 스키마 카드)을 잘라, 같은 질문 200번에 7B 가 「제공한 정보는 충분하지 않습니다」라고 답했다(3/3).
{
  const { questionForModel, LLM_QUESTION_MAX_CHARS, buildAnswerPrompt } = await import("./llm.js");
  const { buildCompanyxSqlPrompt } = await import("./nl2sql.js");
  const realError = console.error;
  const notes: string[] = [];
  console.error = (...a: unknown[]) => void notes.push(a.join(" "));
  let tc153Same = false, longCut = "", answerHasCut = false, sqlHasCut = false, emojiCut = "";
  const tc153 = "2025년 3분기 총 매출액은 얼마야? ".repeat(100);
  const long = "2025년 3분기 총 매출액은 얼마야? ".repeat(200);
  try {
    tc153Same = questionForModel(tc153) === tc153 && buildAnswerPrompt(tc153, "c").includes(`[질문] ${tc153}\n`);
    longCut = questionForModel(long);
    answerHasCut = buildAnswerPrompt(long, "c").includes(`[질문] ${longCut}\n[답변]`);
    sqlHasCut = buildCompanyxSqlPrompt(long).includes(`질문: ${longCut}\nSQL:`);
    emojiCut = questionForModel("\u{1F600}".repeat(3000));
  } finally {
    console.error = realError;
  }
  ok(tc153Same, "상한 안의 질문(TC-153 의 2,200자)은 프롬프트에 그대로 들어간다");
  ok(longCut === long.slice(0, LLM_QUESTION_MAX_CHARS), `넘는 질문은 앞 ${LLM_QUESTION_MAX_CHARS}자만 넣는다 (got ${longCut.length})`);
  ok(answerHasCut && sqlHasCut, "답변 프롬프트와 NL2SQL 프롬프트가 같은 상한을 쓴다");
  ok(notes.some((l) => l.includes("질문 4400자") && l.includes(`앞 ${LLM_QUESTION_MAX_CHARS}자`)), `자른 사실을 stderr 에 남긴다 (got ${notes[0]})`);
  ok(Array.from(emojiCut).length === LLM_QUESTION_MAX_CHARS && emojiCut === "\u{1F600}".repeat(LLM_QUESTION_MAX_CHARS), "서로게이트 쌍을 가르지 않는다");
}

console.log(`degraded.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
