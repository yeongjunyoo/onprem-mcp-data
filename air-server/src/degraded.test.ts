// Copyright 2026 Yeongjun Yoo
// SPDX-License-Identifier: Apache-2.0
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

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
    "WITH x AS (SELECT client_id FROM companyx.sales) SELECT count(*) FROM x",
  ]) {
    ok(report(sql).sql === sql && readsTable(sql), `테이블을 읽는 SELECT 는 그대로: ${sql}`);
  }
  ok(writeStatement("다음 SQL 입니다.\nSELECT 1 FROM t") === null, "설명 줄 뒤의 SELECT 는 쓰기 문장이 아니다");

  // #255 ①: FROM 낱말이 있어도 대상이 CTE(관계를 읽지 않는), VALUES, 집합 반환 함수뿐이면 상수다.
  for (const sql of [
    "WITH x AS (SELECT '서울 날씨' AS answer) SELECT answer FROM x",
    "WITH x AS (SELECT 1 AS n) SELECT n FROM x",
    "WITH a AS (SELECT 1 AS n), b AS (SELECT n + 1 AS m FROM a) SELECT m FROM b",
    "WITH RECURSIVE r AS (SELECT 1 AS n UNION ALL SELECT n + 1 FROM r WHERE n < 3) SELECT n FROM r",
    'WITH "X" AS (SELECT 1 AS n) SELECT n FROM "X"',
    "SELECT n FROM (WITH t AS (SELECT 1 AS n) SELECT n FROM t) AS s",
    "WITH x AS (SELECT 1 AS n) SELECT g FROM x, LATERAL generate_series(1, x.n) AS g",
    "SELECT * FROM (VALUES (1, '서울'), (2, '부산')) AS v(id, city)",
    "WITH x AS (SELECT extract(year from now()) AS y) SELECT y FROM x -- from companyx.sales",
  ]) {
    const r = report(sql);
    ok(r.sql === null && r.refused?.kind === NO_TABLE && r.refused.text === sql && !readsTable(sql), `관계를 읽지 않는 문장은 실행하지 않는다(#255): ${sql}`);
  }
  // CTE 본문, 쉼표 조인, LATERAL, ONLY, 따옴표 이름, 하위 질의 가운데 하나라도 관계를 읽으면 그대로다. 비재귀 CTE 의
  // 본문에서 자기 이름(orders)은 같은 이름의 테이블이다.
  for (const sql of [
    "WITH sales AS (SELECT 1 AS n) SELECT s.amount FROM companyx.sales s",
    "WITH t AS (SELECT 1 AS n) SELECT c.name FROM t, companyx.clients c",
    "WITH t AS (SELECT 1 AS n) SELECT c.name FROM t JOIN LATERAL (SELECT name FROM companyx.clients LIMIT 1) c ON true",
    'SELECT count(*) FROM ONLY "companyx"."sales"',
    "WITH orders AS (SELECT * FROM orders WHERE status = 'paid') SELECT count(*) FROM orders",
    "SELECT n FROM generate_series(1, 3) AS n WHERE EXISTS (SELECT 1 FROM companyx.sales)",
  ]) {
    ok(report(sql).sql === sql && readsTable(sql), `관계를 하나라도 읽으면 그대로(#255): ${sql}`);
  }

  // #255 ③: CTE 본문(겹친 것 포함)이나 WITH 뒤 본문이 데이터를 바꾸면 쓰기 문장이다. text 는 최상위 첫 ; 앞까지.
  const cteWrite = "WITH changed AS (UPDATE companyx.employees SET salary = 0 RETURNING *) SELECT * FROM changed";
  const cw = report(cteWrite);
  ok(cw.sql === null && cw.refused?.kind === "UPDATE" && cw.refused.text === cteWrite, `데이터를 바꾸는 CTE 는 쓰기 문장으로 거부한다 (got ${JSON.stringify(cw)})`);
  for (const [raw, kind, text] of [
    ["WITH d AS (DELETE FROM companyx.sales RETURNING *) SELECT count(*) FROM d; SELECT 1", "DELETE", "WITH d AS (DELETE FROM companyx.sales RETURNING *) SELECT count(*) FROM d"],
    [
      "```sql\n-- 정리\nwith x as not materialized (insert into companyx.departments (id, name) values (99, 'x') returning id) select id from x\n```",
      "INSERT",
      "with x as not materialized (insert into companyx.departments (id, name) values (99, 'x') returning id) select id from x",
    ],
    [
      "WITH a AS (SELECT 1 AS n), b AS MATERIALIZED (MERGE INTO companyx.sales s USING a ON false WHEN NOT MATCHED THEN DO NOTHING) SELECT n FROM a",
      "MERGE",
      "WITH a AS (SELECT 1 AS n), b AS MATERIALIZED (MERGE INTO companyx.sales s USING a ON false WHEN NOT MATCHED THEN DO NOTHING) SELECT n FROM a",
    ],
    ["WITH a AS (WITH b AS (DELETE FROM companyx.sales RETURNING id) SELECT id FROM b) SELECT count(*) FROM a", "DELETE", "WITH a AS (WITH b AS (DELETE FROM companyx.sales RETURNING id) SELECT id FROM b) SELECT count(*) FROM a"],
    ["WITH ids AS (SELECT id FROM companyx.sales) DELETE FROM companyx.sales WHERE id IN (SELECT id FROM ids)", "DELETE", "WITH ids AS (SELECT id FROM companyx.sales) DELETE FROM companyx.sales WHERE id IN (SELECT id FROM ids)"],
  ]) {
    const w = writeStatement(raw);
    ok(w?.kind === kind && w.text === text, `${kind} 로 여는 CTE 나 WITH 본문은 쓰기 문장이다(#255) (got ${JSON.stringify(w)})`);
  }
  for (const raw of [
    "WITH x AS (SELECT update_date, deleted_at FROM companyx.t) SELECT * FROM x",
    "WITH x AS (SELECT 'UPDATE t SET a = 1' AS s, \"delete\" FROM companyx.t) SELECT s FROM x",
    "WITH x AS (SELECT * FROM companyx.sales FOR UPDATE) SELECT * FROM x",
    "-- DELETE 는 하지 않는다\nWITH x AS (SELECT id FROM companyx.sales) /* UPDATE */ SELECT id FROM x",
    "SELECT name FROM companyx.employees ORDER BY salary DESC FETCH FIRST 1 ROWS WITH TIES",
  ]) {
    ok(writeStatement(raw) === null && report(raw).sql !== null, `열 이름, 문자열, 따옴표 이름, FOR UPDATE, 주석, WITH TIES 는 쓰기가 아니다(#255): ${raw}`);
  }
  const after = report("WITH x AS (SELECT id FROM companyx.sales) SELECT x.id FROM x; DELETE FROM companyx.sales");
  ok(after.sql === "WITH x AS (SELECT id FROM companyx.sales) SELECT x.id FROM x" && !after.refused, `첫 문장 뒤의 쓰기는 종전처럼 실행 대상이 아니다(TC-151 과 같다) (got ${JSON.stringify(after)})`);

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
  // 생성 모델이 데이터를 바꾸는 CTE 를 만들어도 같은 길로 간다(#255 ③): 쓰기 거절 답, 감사의 sql-read-only deny.
  const { buildAuditRecord } = await import("./auditrecord.js");
  const viaCte = await ask("모든 직원의 연봉을 0으로 바꿔줘", { pool: emptyPool, embedder: deadEmbedder, nl2sql: async (_q, rep) => pickSql(`${cteWrite};`, rep), llm });
  const readOnly = buildAuditRecord(viaCte).policies.find((p) => p.policy === "sql-read-only");
  ok(
    called === 0 && viaCte.answer === writeRefusal("UPDATE") && viaCte.sql.text === null && viaCte.sql.refused?.text === cteWrite,
    `데이터를 바꾸는 CTE 도 쓰기 거절로 답한다 (got ${viaCte.answer})`,
  );
  ok(readOnly?.verdict === "deny" && readOnly.detail.includes("쓰기 문장(UPDATE)"), `감사 레코드에 쓰기 거부가 남는다 (got ${JSON.stringify(readOnly)})`);

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

// 생성 SQL 의 실행 전 검사와 공동 순위(sqltrust.ts, 랜덤 테스트 사전 점검 D1·D3·D6). DB 와 모델 없이 잰다.
{
  const { withTies, checkSql, confirmNamedIds, clampK, entityIdError } = await import("./sqltrust.js");

  // D1: 바깥 ORDER BY … LIMIT 1 만 WITH TIES 로 바꾼다.
  const top = "SELECT d.name FROM companyx.departments d JOIN companyx.employees e ON d.id = e.dept_id GROUP BY d.id, d.name ORDER BY COUNT(e.id) DESC LIMIT 1";
  ok(withTies(top) === top.replace(/LIMIT 1$/, "FETCH FIRST 1 ROWS WITH TIES"), `최상위 질문은 공동 1위를 모두 돌려주게 바꾼다 (got ${withTies(top)})`);
  ok(withTies("SELECT name FROM t ORDER BY x DESC limit 1;") === "SELECT name FROM t ORDER BY x DESC FETCH FIRST 1 ROWS WITH TIES;", "소문자와 끝 세미콜론");
  ok(withTies("SELECT name FROM t ORDER BY x LIMIT 1 -- 1위") === "SELECT name FROM t ORDER BY x FETCH FIRST 1 ROWS WITH TIES -- 1위", "끝 주석은 그대로 둔다");
  for (const same of [
    "SELECT name FROM t ORDER BY x DESC LIMIT 5",
    "SELECT name FROM t LIMIT 1",
    "SELECT name FROM t ORDER BY x LIMIT 1 OFFSET 1",
    "SELECT name FROM t ORDER BY x OFFSET 1 LIMIT 1",
    "SELECT * FROM (SELECT x FROM t ORDER BY x LIMIT 1) s",
    "WITH a AS (SELECT x FROM t ORDER BY x LIMIT 1) SELECT * FROM a",
    "SELECT x, rank() OVER (ORDER BY y) FROM t LIMIT 1",
    "SELECT x FROM t WHERE n = 'ORDER BY a LIMIT 1'",
    "SELECT $$a$$ FROM t ORDER BY 1 LIMIT 1",
    "SELECT name FROM t ORDER BY x LIMIT 10",
  ]) ok(withTies(same) === same, `LIMIT 2 이상, 하위 쿼리, ORDER BY 없음, OFFSET, 읽지 못하는 문장은 그대로: ${same}`);

  // D3 ①: 조인 열 쌍은 선언된 외래키여야 한다(방향 무관).
  const FKS = [
    { table: "sales", column: "contract_id", refTable: "contracts", refColumn: "id" },
    { table: "sales", column: "client_id", refTable: "clients", refColumn: "id" },
    { table: "sales", column: "product_id", refTable: "products", refColumn: "id" },
    { table: "contracts", column: "manager_id", refTable: "employees", refColumn: "id" },
    { table: "employees", column: "dept_id", refTable: "departments", refColumn: "id" },
    { table: "departments", column: "head_id", refTable: "employees", refColumn: "id" },
  ];
  const qaSales =
    "SELECT s.id, s.amount, e.name AS manager_name\nFROM companyx.sales s\nJOIN companyx.clients c ON s.client_id = c.id\nJOIN companyx.products p ON s.product_id = p.id\nJOIN companyx.employees e ON s.contract_id = e.id";
  const salesCheck = checkSql(qaSales, "매출 알려줘", FKS);
  ok(!salesCheck.ok && salesCheck.reasons.length === 1 && salesCheck.reasons[0].includes("s.contract_id = e.id"), `매출 알려줘의 계약 id = 직원 id 조인을 거부 (got ${salesCheck.reasons})`);
  ok(checkSql("SELECT e.name FROM companyx.sales s JOIN companyx.contracts c ON s.contract_id = c.id JOIN companyx.employees e ON c.manager_id = e.id", "q", FKS).ok, "외래키를 따라간 조인은 통과");
  ok(checkSql("SELECT e.name FROM companyx.employees AS e JOIN companyx.contracts c ON e.id = c.manager_id AND c.status = 'active'", "q", FKS).ok, "방향이 반대여도, 값 조건이 붙어도 통과");
  ok(checkSql("SELECT e.name FROM companyx.departments d JOIN companyx.employees e ON d.head_id = e.id", "q", FKS).ok, "ALTER TABLE 로 선언된 부서장 외래키도 통과");
  ok(checkSql("WITH x AS (SELECT client_id FROM companyx.sales) SELECT c.name FROM x JOIN companyx.clients c ON x.client_id = c.id", "q", FKS).ok, "CTE 처럼 어느 표인지 모르는 쪽은 판정하지 않는다");
  ok(checkSql(qaSales, "매출 알려줘", []).ok, "선언된 외래키가 없는 스키마면 조인 검사는 꺼진다");

  // D3 ②: 질문에 없는 번호로 id 를 걸면 거부한다.
  const salary = checkSql("SELECT e.name, e.salary FROM companyx.employees e WHERE e.id = 1", "연봉 알려줘", FKS);
  ok(!salary.ok && salary.ids.length === 1 && salary.ids[0].tables.join() === "employees", `연봉 알려줘의 e.id = 1 을 거부 (got ${JSON.stringify(salary.ids)})`);
  ok(checkSql("SELECT id, resolved_at FROM companyx.support_tickets WHERE id = 7", "지원 티켓 7번은 언제 해결됐어?", FKS).ok, "질문에 있는 번호는 통과(TC 티켓 7번)");
  ok(checkSql("SELECT name FROM companyx.employees e WHERE e.dept_id = 2 AND e.name = 'id = 3'", "q", FKS).ok, "id 가 아닌 열과 문자열 값은 보지 않는다");
  const named = (name: string) => ({ query: async () => ({ rows: [{ name }], rowCount: 1 }) }) as unknown as Pool;
  const n14 = checkSql("SELECT c.contact_name FROM companyx.clients AS c WHERE c.id = 14", "Client-N에 메일 보내야 돼", [...FKS, { table: "contracts", column: "client_id", refTable: "clients", refColumn: "id" }]);
  ok((await confirmNamedIds(named("Client-N"), "companyx", n14, "Client-N에 메일 보내야 돼")).length === 0, "그 행의 이름이 질문에 있으면 번호가 질문에 없어도 통과(h3-05)");
  ok((await confirmNamedIds(named("윤소연"), "companyx", salary, "연봉 알려줘")).length === 1, "이름도 질문에 없으면 거부 유지");

  // D6: ontology.search 의 k 와 graph.expand 의 entityId.
  ok(clampK(0) === 5 && clampK(-1) === 1 && clampK(1.5) === 1 && clampK(100) === 50 && clampK(undefined) === 5 && clampK(7) === 7, "k 는 vector.search 와 같은 범위로 맞춘다");
  ok(entityIdError(1.5)?.includes("정수여야") === true && entityIdError(31) === undefined && entityIdError(-1) === undefined, "entityId 는 정수만 받는다");

  // 파이프라인: 거부한 SQL 은 실행하지 않고 7B 도 부르지 않는다. 실행한 SQL 은 재작성된 문장이다.
  const executed: string[] = [];
  const fkRows = FKS.map((f) => ({ table_name: f.table, column_name: f.column, ref_table: f.refTable, ref_column: f.refColumn }));
  const gatePool = {
    connect: async () => ({
      query: async (sql: string) => {
        if (/^\s*select/i.test(sql) && !/pg_roles/.test(sql)) executed.push(sql);
        return { rows: [{ name: "영업팀" }, { name: "클라우드사업부" }], rowCount: 2, fields: [{ name: "name" }] };
      },
      release: () => {},
    }),
    query: async (sql: string) =>
      /pg_constraint/.test(sql) ? { rows: fkRows, rowCount: fkRows.length } : /SELECT name::text/.test(sql) ? { rows: [{ name: "윤소연" }], rowCount: 1 } : { rows: [], rowCount: 0 },
  } as unknown as Pool;
  let llmCalls = 0;
  const llm = async () => {
    llmCalls++;
    return "영업팀과 클라우드사업부입니다.";
  };
  const q = "기술지원팀 직원 목록과 연봉을 알려줘";
  const refused = await ask(q, { pool: gatePool, embedder: deadEmbedder, repair: false, llm, nl2sql: async () => "SELECT e.name, e.salary FROM companyx.employees e WHERE e.id = 1" });
  ok(refused.answer.startsWith("이 질문으로는 믿을 수 있는 조회를 만들지 못해") && refused.answer.includes("e.id = 1") && refused.answer.includes("구체적으로"), `거부하면 정해진 문장으로 답한다 (got ${refused.answer})`);
  ok(llmCalls === 0 && executed.length === 0 && refused.sql.text === null && refused.sql.gate?.outcome === "refused", "거부한 SQL 은 실행하지 않고 7B 도 부르지 않는다");
  ok(refused.audit.sql_gate?.rejected[0]?.reasons[0]?.includes("e.id = 1") === true, "retrieve 의 audit 에도 거부 사유가 남는다(빈 컨텍스트를 조용히 돌려주지 않음)");
  const tie = await ask(q, { pool: gatePool, embedder: deadEmbedder, repair: false, llm, nl2sql: async () => top });
  ok(tie.sql.text?.endsWith("FETCH FIRST 1 ROWS WITH TIES") === true && executed.at(-1) === tie.sql.text && !tie.sql.gate, `감사에 남는 SQL 은 실제로 실행한 문장 (got ${tie.sql.text})`);
  ok(tie.answer.startsWith("공동 1위가 2건입니다: 영업팀, 클라우드사업부.") && tie.answer.includes("[조회 결과 2건]") && llmCalls === 0, `공동 1위는 이름을 모두 적는 결정론 문장 (got ${tie.answer})`);
  const one = await ask(q, {
    pool: { ...gatePool, connect: async () => ({ query: async () => ({ rows: [{ name: "기술지원팀" }], rowCount: 1, fields: [{ name: "name" }] }), release: () => {} }) } as unknown as Pool,
    embedder: deadEmbedder,
    repair: false,
    llm,
    nl2sql: async () => top,
  });
  ok(llmCalls === 1 && one.answer.startsWith("영업팀과") && one.answer.includes("[조회 결과 1건]"), "단독 1위(1행)는 종전처럼 7B 가 문장을 쓴다");

  // 랜덤 테스트 2차 R11: 조인 열이 그 표에 없으면 사유와 수리 안내가 그 열을 말한다(「projects 에는 dept_id 열이 없다」).
  {
    const { untrustedAnswer } = await import("./sqltrust.js");
    const { executeWithRepair } = await import("./sqlrepair.js");
    const PFKS = [...FKS, { table: "projects", column: "manager_id", refTable: "employees", refColumn: "id" }, { table: "projects", column: "client_id", refTable: "clients", refColumn: "id" }];
    const COLS = new Map([
      ["projects", new Set(["id", "name", "client_id", "manager_id", "contract_id", "status", "budget"])],
      ["departments", new Set(["id", "name", "head_id"])],
      ["employees", new Set(["id", "name", "dept_id", "salary"])],
    ]);
    const b04 = "SELECT p.name, p.budget, d.name AS department_name FROM companyx.projects p JOIN companyx.departments d ON p.dept_id = d.id ORDER BY p.budget DESC LIMIT 3";
    const miss = checkSql(b04, "예산이 가장 큰 프로젝트 3개를 알려줘", PFKS, COLS);
    ok(
      miss.reasons.join() ===
        "조인 조건 p.dept_id = d.id 은 없는 열을 쓴다(projects 에는 dept_id 열이 없다). projects 는 manager_id → employees, client_id → clients 로만 이어진다. 질문이 묻지 않은 표의 조인은 뺀다",
      `없는 열과 그 표가 이어지는 표를 말한다 (got ${miss.reasons})`,
    );
    ok(checkSql(b04, "q", PFKS).reasons.join() === "조인 조건 p.dept_id = d.id 은 스키마에 선언된 외래키가 아니다", "열 목록이 없으면 종전 사유");
    ok(checkSql(qaSales, "매출 알려줘", FKS, COLS).reasons.join() === salesCheck.reasons.join(), "있는 열끼리의 잘못된 조인은 종전 사유(계약 id = 직원 id)");
    ok(
      untrustedAnswer({ outcome: "refused", rejected: [{ sql: b04, reasons: miss.reasons }] }).includes("생성된 SQL 이 표에 없는 열로 표를 이어서(projects 에는 dept_id 열이 없다) 실행하지 않았습니다."),
      "거절 문장도 없는 열을 말한다",
    );
    // TC-146 의 거절(질문에 없는 번호)은 사유와 문장이 종전 그대로다.
    const tc146 = checkSql("SELECT name FROM companyx.departments WHERE id = 1", "파이썬으로 피보나치 함수 짜줘", PFKS, COLS);
    ok(
      tc146.reasons.length === 0 && tc146.ids[0]?.reason === "id = 1 의 번호 1 은 질문에 없다(질문에 없는 번호로 행을 고름)" &&
        untrustedAnswer({ outcome: "refused", rejected: [{ sql: "x", reasons: [tc146.ids[0].reason] }] }) ===
          "이 질문으로는 믿을 수 있는 조회를 만들지 못해 답하지 않았습니다. 생성된 SQL 이 질문에 없는 번호(id = 1)로 한 건만 골라서 실행하지 않았습니다. 무엇을 알고 싶은지 조금 더 구체적으로 물어봐 주세요. 예: 「2025년 3분기 총 매출액은 얼마야?」, 「기술지원팀 직원 목록과 연봉을 알려줘」",
      "TC-146 거절은 종전 그대로",
    );
    // 수리에 넘기는 안내에 없는 열이 들어간다(카탈로그는 pg_attribute 에서 읽는다).
    const colRows = [...COLS].flatMap(([t, cs]) => [...cs].map((c) => ({ table_name: t, column_name: c })));
    const pfkRows = PFKS.map((f) => ({ table_name: f.table, column_name: f.column, ref_table: f.refTable, ref_column: f.refColumn }));
    const catPool = {
      connect: async () => ({ query: async () => ({ rows: [{ name: "p" }], rowCount: 1, fields: [{ name: "name" }] }), release: () => {} }),
      query: async (sql: string) =>
        /pg_constraint/.test(sql) ? { rows: pfkRows, rowCount: pfkRows.length } : /pg_attribute/.test(sql) ? { rows: colRows, rowCount: colRows.length } : { rows: [], rowCount: 0 },
    } as unknown as Pool;
    let hint = "";
    const fixedSql = "SELECT p.name, p.budget FROM companyx.projects p ORDER BY p.budget DESC LIMIT 3";
    const ex = await executeWithRepair(catPool, "예산이 가장 큰 프로젝트 3개를 알려줘", b04, {
      repairer: async (_q, _sql, why) => {
        hint = why;
        return fixedSql;
      },
    });
    ok(hint.includes("projects 에는 dept_id 열이 없다") && ex.repaired && ex.text === fixedSql && ex.gate?.outcome === "repaired", `수리 안내가 없는 열을 말하고, 조인을 뺀 수리를 실행한다 (got ${hint})`);
  }

  // 랜덤 테스트 2차 R8: 가리켜지는 쪽 표(계약)의 금액을 가리키는 쪽 표(매출)와 조인한 채 더하면 계약 한 건이 매출 건수만큼 겹친다.
  {
    const { fanoutJoins, confirmFanout, untrustedAnswer } = await import("./sqltrust.js");
    const { executeWithRepair } = await import("./sqlrepair.js");
    const x14 =
      "SELECT SUM(s.amount) AS total_sales, SUM(c.amount) AS total_contracts FROM companyx.sales s JOIN companyx.contracts c ON s.contract_id = c.id JOIN companyx.clients cl ON s.client_id = cl.id WHERE cl.name = 'Client-Q'";
    const fan = fanoutJoins(x14, FKS);
    ok(
      JSON.stringify(fan) ===
        JSON.stringify([
          {
            agg: "SUM(c.amount)",
            parent: "contracts",
            child: "sales",
            childColumn: "contract_id",
            join: "s.contract_id = c.id",
            parentKey: "c.id",
            scope: "FROM companyx.sales s JOIN companyx.contracts c ON s.contract_id = c.id JOIN companyx.clients cl ON s.client_id = cl.id WHERE cl.name = 'Client-Q'",
          },
        ]),
      `계약 금액의 합을 매출과 조인한 채 구하는 자리와 질의의 범위 (got ${JSON.stringify(fan)})`,
    );
    for (const sql of [
      "SELECT d.name, AVG(e.salary) FROM companyx.employees e JOIN companyx.departments d ON e.dept_id = d.id GROUP BY d.name", // TC-115 꼴: 가리키는 쪽 열
      "SELECT c.name, SUM(s.amount) FROM companyx.sales s JOIN companyx.clients c ON s.client_id = c.id GROUP BY c.name", // TC-118 꼴
      "SELECT (SELECT SUM(s.amount) FROM companyx.sales s) AS a, (SELECT SUM(c.amount) FROM companyx.contracts c JOIN companyx.clients cl ON c.client_id = cl.id) AS b",
      "SELECT e.name, AVG(e.salary) FROM companyx.employees e JOIN companyx.contracts c ON c.manager_id = e.id GROUP BY e.id, e.name",
      "SELECT SUM(c.amount) FROM companyx.contracts c WHERE c.id IN (SELECT s.contract_id FROM companyx.sales s)",
    ]) ok(fanoutJoins(sql, FKS).length === 0, `가리키는 쪽 열, 하위 질의로 따로 구한 값, 부모 키로 묶은 평균은 통과: ${sql}`);
    ok(fanoutJoins("SELECT e.name, SUM(e.salary) FROM companyx.employees e JOIN companyx.contracts c ON c.manager_id = e.id GROUP BY e.id, e.name", FKS).length === 1, "합은 부모 키로 묶어도 겹친다");
    ok(fanoutJoins(x14, []).length === 0 && fanoutJoins("SELECT SUM(c.amount) FROM companyx.contracts c JOIN 'x", FKS).length === 0, "외래키가 없거나 읽지 못하는 문장은 판정하지 않는다");
    // 자식의 외래키 열에 같은 값이 없으면(부서장처럼 한 부모를 한 자식만 가리킴) 부풀지 않아 막지 않는다.
    const dupPool = (dup: boolean) => ({ query: async () => ({ rows: [{ dup }], rowCount: 1 }) }) as unknown as Pool;
    const head = fanoutJoins("SELECT AVG(e.salary) FROM companyx.employees e JOIN companyx.departments d ON d.head_id = e.id", FKS);
    ok(head.length === 1 && (await confirmFanout(dupPool(false), "companyx", head)).length === 0, "같은 값이 없는 외래키 열과의 조인은 막지 않는다");
    const why = await confirmFanout(dupPool(true), "companyx", fan);
    ok(why.length === 1 && why[0].startsWith("집계 SUM(c.amount) 은 contracts 의 열인데 contracts 를 가리키는 sales 와 조인(s.contract_id = c.id)해"), `사유가 집계와 조인을 말한다 (got ${why})`);
    // PR #257 리뷰: 겹침은 질의가 고르는 행에서 센다. 자식을 한 행으로 좁힌 질의는 표 전체에 겹침이 있어도 막지 않는다.
    const probes: string[] = [];
    const scopedPool = (dup: boolean) =>
      ({
        connect: async () => ({
          query: async (q: string) => {
            if (/EXISTS/.test(q)) probes.push(q);
            return /EXISTS/.test(q) ? { rows: [{ dup }], rowCount: 1, fields: [] } : { rows: [], rowCount: 0, fields: [] };
          },
          release: () => {},
        }),
        query: async () => ({ rows: [{ dup: true }], rowCount: 1 }),
      }) as unknown as Pool;
    const one = fanoutJoins("SELECT SUM(c.amount) FROM companyx.sales s JOIN companyx.contracts c ON s.contract_id = c.id WHERE s.id = 7", FKS);
    ok((await confirmFanout(scopedPool(false), "companyx", one)).length === 0, "자식을 한 행으로 좁힌 질의는 표 전체의 겹침과 상관없이 막지 않는다");
    ok(
      probes.length === 1 && probes[0].includes("SELECT 1 FROM companyx.sales s JOIN companyx.contracts c ON s.contract_id = c.id WHERE s.id = 7 GROUP BY c.id HAVING count(*) > 1"),
      `질의의 FROM..WHERE 로 부모 키마다 센다 (got ${probes[0]})`,
    );
    ok((await confirmFanout(scopedPool(true), "companyx", fan)).length === 1, "질의가 고르는 행에서 겹치면 막는다");
    ok(fanoutJoins("WITH x AS (SELECT * FROM companyx.sales) SELECT SUM(c.amount) FROM x s JOIN companyx.contracts c ON s.contract_id = c.id", FKS).every((j) => j.scope === undefined), "WITH 로 시작하는 문장은 범위를 비워 표 전체로 센다");
    // 판정은 기억하지 않는다. 같은 풀에서 데이터가 바뀌면 다음 판정도 바뀐다.
    let tableDup = false;
    const flipPool = { query: async () => ({ rows: [{ dup: tableDup }], rowCount: 1 }) } as unknown as Pool;
    const first = (await confirmFanout(flipPool, "companyx", head)).length;
    tableDup = true;
    ok(first === 0 && (await confirmFanout(flipPool, "companyx", head)).length === 1, "처음에 겹침이 없다고 나와도 나중에 생긴 겹침을 막는다");
    ok(
      untrustedAnswer({ outcome: "refused", rejected: [{ sql: x14, reasons: why }] }).includes("생성된 SQL 이 contracts 의 값(SUM(c.amount))을 sales 와 조인한 채 집계해 같은 값을 여러 번 더해서 실행하지 않았습니다."),
      "거절 문장",
    );
    // 실행 전 검사가 수리로 보내고, 따로 구한 수리 SQL 을 실행한다.
    const xfkRows = [...FKS, { table: "contracts", column: "client_id", refTable: "clients", refColumn: "id" }].map((f) => ({ table_name: f.table, column_name: f.column, ref_table: f.refTable, ref_column: f.refColumn }));
    const xpool = {
      connect: async () => ({ query: async () => ({ rows: [{ total_sales: 23244, total_contracts: 11250 }], rowCount: 1, fields: [] }), release: () => {} }),
      query: async (sql: string) =>
        /pg_constraint/.test(sql) ? { rows: xfkRows, rowCount: xfkRows.length } : /HAVING count\(\*\) > 1/.test(sql) ? { rows: [{ dup: true }], rowCount: 1 } : { rows: [], rowCount: 0 },
    } as unknown as Pool;
    const split =
      "SELECT (SELECT SUM(s.amount) FROM companyx.sales s JOIN companyx.clients cl ON s.client_id = cl.id WHERE cl.name = 'Client-Q') AS total_sales, (SELECT SUM(c.amount) FROM companyx.contracts c JOIN companyx.clients cl ON c.client_id = cl.id WHERE cl.name = 'Client-Q') AS total_contracts";
    let fanHint = "";
    const fx = await executeWithRepair(xpool, "Client-Q 매출 합계랑 계약 금액 합계 각각 알려줘", x14, {
      repairer: async (_q, _sql, w) => {
        fanHint = w;
        return split;
      },
    });
    ok(fanHint.includes("하위 질의로 따로 집계한다") && fx.repaired && fx.text === split && fx.gate?.outcome === "repaired", `부푼 합계는 실행하지 않고 수리한다 (got ${fanHint})`);
  }

  // #255 ②: 외래키는 프로파일의 테이블이 있는 스키마에서 읽는다. bench 의 테이블은 bench 스키마에 있고 외래키를
  // 선언한다(eval/internal/schema.sql). 종전에는 companyx 가 아니면 public 을 넘겨 bench 의 조인 검사가 꺼져 있었다.
  {
    const { profile } = await import("./profile.js");
    const benchFks = [
      { table_name: "orders", column_name: "customer_id", ref_table: "customers", ref_column: "id" },
      { table_name: "order_items", column_name: "order_id", ref_table: "orders", ref_column: "id" },
      { table_name: "order_items", column_name: "product_id", ref_table: "products", ref_column: "id" },
    ];
    // 외래키는 풀마다 한 번 읽어 두므로 부를 때마다 새 풀을 쓴다. 어느 스키마를 물었는지 적고, 외래키는 bench 에만 있다.
    const asked: string[] = [];
    const schemaPool = () =>
      ({
        connect: async () => ({ query: async () => ({ rows: [{ name: "고객 1" }], rowCount: 1, fields: [{ name: "name" }] }), release: () => {} }),
        query: async (sql: string, params?: unknown[]) => {
          if (!/pg_constraint/.test(sql)) return { rows: [], rowCount: 0 };
          asked.push(String(params?.[0]));
          return params?.[0] === "bench" ? { rows: benchFks, rowCount: benchFks.length } : { rows: [], rowCount: 0 };
        },
      }) as unknown as Pool;
    const badJoin = "SELECT c.name FROM bench.customers c JOIN bench.orders o ON c.id = o.id";
    const fkJoin = "SELECT c.name FROM bench.customers c JOIN bench.orders o ON o.customer_id = c.id";
    const run = (sql: string) => ask(q, { pool: schemaPool(), embedder: deadEmbedder, repair: false, llm, nl2sql: async () => sql });
    const saved = process.env.DATASET;
    const savedKg = process.env.KG_SCHEMA;
    delete process.env.KG_SCHEMA;
    try {
      for (const [name, schema] of [["smoke", "public"], ["bench", "bench"], ["companyx", "companyx"]]) {
        process.env.DATASET = name;
        ok(profile().sqlSchema === schema, `${name} 프로파일의 테이블은 ${schema} 스키마에 있다`);
      }
      process.env.DATASET = "bench";
      const bad = await run(badJoin);
      ok(
        asked.at(-1) === "bench" && bad.sql.gate?.outcome === "refused" && bad.answer.includes("외래키가 아닌 열(c.id = o.id)"),
        `bench 에서도 외래키가 아닌 열의 조인을 실행하지 않는다 (got ${asked.at(-1)}: ${bad.answer})`,
      );
      const good = await run(fkJoin);
      ok(!good.sql.gate && good.sql.text === fkJoin, `bench 의 외래키 조인은 그대로 실행한다 (got ${JSON.stringify(good.sql.gate)})`);
      process.env.DATASET = "smoke";
      const smoke = await run(badJoin);
      ok(asked.at(-1) === "public" && !smoke.sql.gate && smoke.sql.text === badJoin, "외래키를 선언하지 않은 스키마(smoke 의 public)는 종전처럼 조인을 거부하지 않는다");
      process.env.DATASET = "companyx";
      await run(fkJoin);
      ok(asked.at(-1) === "companyx", `companyx 는 종전처럼 companyx 스키마의 외래키를 읽는다 (got ${asked.at(-1)})`);
    } finally {
      if (saved === undefined) delete process.env.DATASET;
      else process.env.DATASET = saved;
      if (savedKg !== undefined) process.env.KG_SCHEMA = savedKg;
    }
  }
}

// 금액 단위(G17 ⑥). 7B 는 「연봉이 2억 원 이상인 직원 목록을 알려줘」를 salary >= 2000 으로 써 직원 45명을 모두 돌려줬다
// (3/3, 경계 실측). 질문의 금액 옆에 만원 값을 적어 넘기고, 금액 열의 비교 숫자가 10배수로 어긋나면 실행 전 검사가 고친다.
// 생성기와 풀은 가짜를 넣어 모델과 DB 없이 잰다.
{
  const { moneyMentions, annotateMoney } = await import("./money.js");
  const { sqlQuestionForModel, buildCompanyxSqlPrompt } = await import("./nl2sql.js");
  const { questionForModel } = await import("./llm.js");
  const { checkMoney, moneyColumns, untrustedAnswer, sqlGatePolicy } = await import("./sqltrust.js");
  const { executeWithRepair } = await import("./sqlrepair.js");

  for (const [q, manwon] of [
    ["연봉이 2억 원 이상인 직원 목록을 알려줘", [20000]],
    ["2억원", [20000]],
    ["1억 5천만 원", [15000]],
    ["1억5천만원 이상", [15000]],
    ["1억 5천 이상", [15000]],
    ["1억 5000만 원", [15000]],
    ["5천만 원 이하", [5000]],
    ["5천만 이상", [5000]],
    ["3,000만 원", [3000]],
    ["500만원", [500]],
    ["1.5억", [15000]],
    ["5천만~1억 원", [5000, 10000]],
    // 바로 뒤에 원이 오면 억 뒤의 자리는 원 단위다(PR #257 Codex). 만을 줄인 읽기는 원이 없을 때만
    ["1억 5천 원", [10000.5]],
    ["1억5천원 이상", [10000.5]],
    ["1억 500 원", [10000.05]],
    ["1억 5천만 원과 1억 5천", [15000, 15000]],
  ] as const) {
    ok(JSON.stringify(moneyMentions(q).map((m) => m.manwon)) === JSON.stringify(manwon), `금액 표현을 만원 값으로 읽는다: ${q} → ${manwon}`);
  }
  for (const q of ["500만 명", "3000만", "1억 건", "2억 년", "1억 달러", "1억 2", "오천만 원", "연봉 4천", "Product-C1 가격", "1,5억", "2025년 3분기 총 매출액은 얼마야?"]) {
    ok(moneyMentions(q).length === 0 && annotateMoney(q) === q, `금액이 아니거나 값이 갈리는 것은 읽지 않는다: ${q}`);
  }
  ok(annotateMoney("연봉이 2억 원 이상인 직원 목록을 알려줘") === "연봉이 2억 원(=20000만 원) 이상인 직원 목록을 알려줘", "금액 표현 바로 뒤에 만원 값을 적는다");
  ok(annotateMoney("1억원인 계약과 5천만 원짜리") === "1억원(=10000만 원)인 계약과 5천만 원(=5000만 원)짜리", "표현마다 적는다");
  ok(annotateMoney("2억 원(=20000만 원)") === "2억 원(=20000만 원)", "이미 적힌 값은 다시 적지 않는다");

  // 금액 표현이 없는 질문은 NL2SQL 프롬프트에 종전 그대로 들어간다(시험항목 질문에는 금액 표현이 없다).
  for (const q of ["2025년 3분기 총 매출액은 얼마야?", "평균 연봉이 가장 높은 부서는 어디야?", "연봉 알려줘", "지원 티켓 7번은 언제 해결됐어?"]) {
    ok(sqlQuestionForModel(q) === questionForModel(q) && buildCompanyxSqlPrompt(q).includes(`\n질문: ${q}\nSQL:`), `금액 없는 질문은 그대로: ${q}`);
  }
  ok(buildCompanyxSqlPrompt("예산이 3억 원을 넘는 프로젝트는?").includes("\n질문: 예산이 3억 원(=30000만 원)을 넘는 프로젝트는?\nSQL:"), "NL2SQL 프롬프트의 질문 줄에 만원 값이 붙는다");

  // 상대 연도(랜덤 테스트 2차 R3). 생성 모델에 넘기는 질문에서만 서울 기준 연도로 바꾼다.
  const { absoluteYears } = await import("./nl2sql.js");
  const oct7 = new Date("2026-10-07T12:00:00+09:00");
  ok(absoluteYears("작년에 새로 등록된 고객사는 몇 곳이야?", oct7) === "2025년도에 새로 등록된 고객사는 몇 곳이야?", "작년 → (올해 - 1)년도");
  ok(absoluteYears("재작년과 지난해, 내년", oct7) === "2024년도과 2025년도, 2027년도", "재작년, 지난해, 내년");
  ok(absoluteYears("작년도 3분기 매출", oct7) === "2025년도 3분기 매출", "뒤에 붙은 「도」는 한 번만");
  ok(absoluteYears("올해 매출은 얼마야? 금년 계약은?", oct7) === "올해 매출은 얼마야? 금년 계약은?", "올해와 금년은 그대로(7B 가 CURRENT_DATE 로 쓴다)");
  ok(absoluteYears("작년 매출", new Date("2026-12-31T15:00:00Z")) === "2026년도 매출", "연도는 서울 시각으로 센다(UTC 로는 아직 2026-12-31)");
  ok(absoluteYears("지난달 매출과 이번 분기 매출", oct7) === "지난달 매출과 이번 분기 매출", "월과 분기를 가리키는 말은 그대로");
  ok(sqlQuestionForModel("작년 매출이 1억 원 이상인 고객사", oct7) === "2025년도 매출이 1억 원(=10000만 원) 이상인 고객사", "연도를 바꾼 뒤 금액을 적는다");

  // 답 프롬프트의 질문 줄은 낱말을 지우지 않고 연도와 만원 값을 괄호로 덧붙인다(답 모델이 조회 조건과 질문을 잇게).
  const { answerQuestionForModel, buildAnswerPrompt } = await import("./llm.js");
  ok(answerQuestionForModel("작년 매출은 얼마야?", oct7) === "작년(2025년) 매출은 얼마야?", "답 질문: 작년 뒤에 연도");
  ok(answerQuestionForModel("작년도 3분기 매출과 재작년 매출", oct7) === "작년도(2025년) 3분기 매출과 재작년(2024년) 매출", "답 질문: 「작년도」와 재작년");
  ok(answerQuestionForModel("올해 매출은 얼마야?", oct7) === "올해 매출은 얼마야?", "답 질문: 올해는 그대로");
  ok(answerQuestionForModel("계약 금액이 1억 원 이상인 계약 목록", oct7) === "계약 금액이 1억 원(=10000만 원) 이상인 계약 목록", "답 질문: 금액 뒤에 만원 값");
  for (const q of ["Client-A가 사용 중인 제품 목록은?", "2025년 3분기 총 매출액은 얼마야?", "Product-C1 설치 방법이 궁금해", "평균 연봉이 가장 높은 부서는 어디야?"]) {
    ok(answerQuestionForModel(q, oct7) === questionForModel(q) && buildAnswerPrompt(q, "ctx").includes(`\n[질문] ${q}\n[답변]`), `상대 연도와 금액이 없는 질문은 답 프롬프트에 그대로: ${q}`);
  }

  // 상한은 덧붙인 뒤의 길이에 건다(PR #257 Codex). 상한 근처의 질문에 금액 표현이 많으면 덧붙임으로 수천 자가 늘었다.
  {
    const { LLM_QUESTION_MAX_CHARS } = await import("./llm.js");
    const notes: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void notes.push(a.map(String).join(" "));
    let sqlLine = "";
    let ansLine = "";
    let plainLong = "";
    const many = "1억 원 ".repeat(479); // 2,395자(상한 안), 덧붙이면 7,664자
    try {
      sqlLine = sqlQuestionForModel(many, oct7);
      ansLine = answerQuestionForModel(`작년 ${many}`, oct7);
      plainLong = sqlQuestionForModel("가".repeat(3000), oct7);
    } finally {
      console.error = orig;
    }
    const closed = (s: string) => (s.match(/\(=/g) ?? []).length === (s.match(/만 원\)/g) ?? []).length;
    const n = Array.from(sqlLine).length;
    ok(n <= LLM_QUESTION_MAX_CHARS && n > LLM_QUESTION_MAX_CHARS - 20 && closed(sqlLine), `NL2SQL 질문 줄은 덧붙인 뒤 상한 안, 괄호를 가르지 않음 (got ${n}자, 끝 ${JSON.stringify(sqlLine.slice(-20))})`);
    ok(Array.from(ansLine).length <= LLM_QUESTION_MAX_CHARS && closed(ansLine) && ansLine.startsWith("작년(2025년) 1억 원(=10000만 원)"), `답 질문 줄도 덧붙인 뒤 상한 안 (got ${Array.from(ansLine).length}자)`);
    ok(plainLong === "가".repeat(LLM_QUESTION_MAX_CHARS), "덧붙일 것이 없는 긴 질문은 questionForModel 과 같게 앞 2400자");
    ok(notes.length === 3 && notes.every((l) => l.includes("다 들어가지 않아")), `잘랐다는 줄을 남긴다 (got ${notes.length})`);
  }

  // 실행 전 검사 ③: 금액 열과 비교하는 숫자가 질문의 만원 값과 10배수로 어긋나면 단위 오류다.
  const cols = moneyColumns("companyx");
  const q2 = "연봉이 2억 원 이상인 직원 목록을 알려줘";
  const bad = checkMoney("SELECT name FROM companyx.employees WHERE salary >= 2000", q2, cols);
  ok(bad.length === 1 && bad[0].includes("salary >= 2000") && bad[0].includes("「2억 원」(=20000만 원)") && bad[0].includes("20000 이어야 한다"), `salary >= 2000 은 단위 오류이고 사유가 기대 값을 말한다 (got ${bad})`);
  for (const sql of [
    "SELECT name FROM companyx.employees e WHERE 2000 <= e.salary",
    "SELECT name FROM companyx.employees WHERE salary BETWEEN 2000 AND 90000",
    "SELECT name FROM companyx.employees WHERE companyx.employees.salary >= 200000000",
    "SELECT name FROM companyx.employees WHERE salary>=2",
  ]) ok(checkMoney(sql, q2, cols).length === 1, `반대쪽 비교, BETWEEN, 원 단위, 억 단위도 단위 오류: ${sql}`);
  for (const sql of [
    "SELECT name FROM companyx.employees e WHERE e.salary >= 20000",
    "SELECT name FROM companyx.employees WHERE salary * 12 >= 2000",
    "SELECT name FROM companyx.employees WHERE salary >= 2000 * 10",
    "SELECT d.name FROM companyx.departments d JOIN companyx.employees e ON e.dept_id = d.id GROUP BY d.name HAVING SUM(e.salary) >= 2000",
    "SELECT name FROM companyx.employees WHERE name = 'salary >= 2000'",
    "SELECT name FROM companyx.employees WHERE salary >= 7777",
    "SELECT name FROM companyx.employees WHERE total_salary >= 2000",
  ]) ok(checkMoney(sql, q2, cols).length === 0, `만원 값 그대로, 식, 집계, 문자열, 관계없는 숫자, 다른 열은 보지 않는다: ${sql}`);
  ok(checkMoney("SELECT name FROM companyx.employees WHERE salary >= 2000", "연봉 알려줘", cols).length === 0, "질문에 금액 표현이 없으면 보지 않는다");
  ok(moneyColumns("bench").length === 0 && moneyColumns("public").length === 0, "만원 단위를 모르는 스키마(bench, smoke)는 끈다");

  // 실행 전 검사 ⑤: 한 해를 묻는데 그해의 한 분기만 고르면 기간이 다르다(「2025년 매출은 얼마야?」 → quarter = '2025-Q3').
  {
    const { checkPeriod, untrustedAnswer } = await import("./sqltrust.js");
    const oct8 = new Date("2026-10-08T07:00:00+09:00");
    const q3 = "SELECT SUM(amount) AS total_sales FROM companyx.sales WHERE quarter = '2025-Q3'";
    const why = checkPeriod(q3, "2025년 매출은 얼마야?", oct8);
    ok(why.length === 1 && why[0].startsWith("기간 조건 quarter = '2025-Q3' 은 2025년의 한 분기만 고른다") && why[0].includes("quarter LIKE '2025-%'"), `한 해를 묻는데 한 분기만 고름 (got ${why})`);
    ok(checkPeriod(q3, "작년 매출은 얼마야?", oct8).length === 1, "상대 연도(작년 = 2025년, 서울 기준)도 본다");
    ok(checkPeriod("SELECT SUM(s.amount) FROM companyx.sales s WHERE s.quarter = '2025-Q3'", "2025년 총 매출은?", oct8).length === 1, "별칭이 붙은 분기 열");
    for (const [sql, q] of [
      ["SELECT SUM(amount) FROM companyx.sales WHERE quarter = '2025-Q3'", "2025년 3분기 총 매출액은 얼마야?"], // TC-109(사업자 예시 2번)
      ["SELECT SUM(amount) FROM companyx.sales WHERE quarter = '2025-Q3'", "서울물산의 2025년 3분기 총 매출액은 얼마야?"],
      ["SELECT SUM(amount) AS total_revenue FROM companyx.sales WHERE EXTRACT(YEAR FROM sale_date) = 2023", "2023년 총 매출액은 얼마야?"], // TC-140
      ["SELECT SUM(amount) AS total_revenue FROM companyx.sales WHERE quarter LIKE '2025-%'", "2025년 전체 매출은?"],
      ["SELECT SUM(amount) FROM companyx.sales WHERE quarter = '2025-Q3'", "2024년 매출 합계는?"],
      ["SELECT SUM(amount) FROM companyx.sales WHERE quarter = '2025-Q1'", "2025년 1분기 매출"],
      ["SELECT SUM(amount) FROM companyx.sales WHERE quarter = '2025-Q2'", "2025년 상반기 매출"],
      ["SELECT COUNT(*) FROM companyx.clients WHERE EXTRACT(YEAR FROM registered_at) = 2024", "2024년에 등록된 고객사는 몇 개야?"],
    ]) ok(checkPeriod(sql, q, oct8).length === 0, `분기를 말하거나 한 해 전체를 고르거나 다른 해면 보지 않는다: ${q}`);
    ok(
      untrustedAnswer({ outcome: "refused", rejected: [{ sql: q3, reasons: why }] }) ===
        "이 질문의 기간 조건으로는 믿을 수 있는 조회를 만들지 못해 답하지 않았습니다. 생성된 SQL 이 2025년 전체가 아니라 한 분기(quarter = '2025-Q3')만 골라서 실행하지 않았습니다. 분기를 함께 물어봐 주세요. 예: 「2025년 3분기 총 매출액은 얼마야?」",
      "기간만 걸렸으면 기간 조건을 말하는 거절 문장",
    );
  }

  // 수리 경로: 단위 오류를 사유로 되먹여 한 번 고치고, 고친 것만 실행한다. 생성기와 풀은 가짜.
  const fakePool = (rows: (sql: string) => Record<string, unknown>[], executed: string[]) =>
    ({
      connect: async () => ({
        query: async (sql: string) => {
          if (/^\s*(select|with)\b/i.test(sql) && !/pg_roles/.test(sql)) executed.push(sql);
          const r = /^\s*(select|with)\b/i.test(sql) ? rows(sql) : [];
          return { rows: r, rowCount: r.length, fields: Object.keys(r[0] ?? {}).map((name) => ({ name })) };
        },
        release: () => {},
      }),
      query: async () => ({ rows: [], rowCount: 0 }),
    }) as unknown as Pool;
  const wrong = "SELECT name FROM companyx.employees WHERE salary >= 2000";
  const right = "SELECT name FROM companyx.employees WHERE salary >= 20000";
  const hints: string[] = [];
  const fixTo = (sql: string) => async (_q: string, _f: string, hint: string, _c?: string, kind?: string) => {
    hints.push(`${kind}: ${hint}`);
    return sql;
  };
  const ran: string[] = [];
  const fixed = await executeWithRepair(fakePool(() => [{ name: "직원" }], ran), q2, wrong, { repairer: fixTo(right) });
  ok(
    fixed.text === right && fixed.repaired && fixed.repairReason === "untrusted" && fixed.gate?.outcome === "repaired" && ran.join() === right,
    `단위 오류 SQL 은 실행하지 않고, 고친 SQL 만 실행한다 (got ${JSON.stringify({ text: fixed.text, ran, gate: fixed.gate?.outcome })})`,
  );
  ok(hints.at(-1)?.startsWith("untrusted: 금액 조건 salary >= 2000") === true && hints.at(-1)?.includes("20000 이어야 한다") === true, `수리 안내가 기대 값을 말한다 (got ${hints.at(-1)})`);
  ok(sqlGatePolicy(fixed.gate)?.verdict === "repair" && sqlGatePolicy(fixed.gate)?.detail.includes("salary >= 2000") === true, "감사 정책 줄에 수리와 그 사유가 남는다");
  const ran2: string[] = [];
  const still = await executeWithRepair(fakePool(() => [{ name: "직원" }], ran2), q2, wrong, { repairer: fixTo("SELECT name FROM companyx.employees WHERE salary >= 200000000") });
  ok(still.text === null && !still.result && ran2.length === 0 && still.gate?.outcome === "refused" && still.gate.rejected.length === 2, `고친 것도 단위가 틀리면 아무것도 실행하지 않는다 (got ${JSON.stringify(still.gate)})`);
  // 0행 수리가 금액 단위를 다시 틀리면 처음 SQL 의 0행을 그대로 쓴다(직원 45명을 돌려주지 않는다).
  const ran3: string[] = [];
  const kept = await executeWithRepair(fakePool((sql) => (/>= 20000/.test(sql) ? [] : [{ name: "직원" }]), ran3), q2, right, { repairer: fixTo(wrong) });
  ok(kept.text === right && kept.result?.rows.length === 0 && kept.gate?.outcome === "kept" && ran3.join() === right, `0행 수리의 단위 오류는 실행하지 않는다 (got ${JSON.stringify({ text: kept.text, ran3, gate: kept.gate?.outcome })})`);
  const ran4: string[] = [];
  const plain = await executeWithRepair(fakePool(() => [{ name: "직원" }], ran4), "기술지원팀 직원 목록과 연봉을 알려줘", wrong, { repairer: fixTo(right) });
  ok(plain.text === wrong && !plain.gate && ran4.join() === wrong, "질문에 금액 표현이 없으면 종전 그대로 실행한다");
  const ran5: string[] = [];
  const bench = await executeWithRepair(fakePool(() => [{ name: "직원" }], ran5), q2, wrong, { repairer: fixTo(right), schema: "bench" });
  ok(bench.text === wrong && !bench.gate, "금액 열을 모르는 스키마는 종전 그대로 실행한다");

  // ask: 고쳐도 단위가 틀리면 7B 를 부르지 않고 금액 조건을 말하는 정해진 문장으로 답하고, 감사에 sql-trust-gate deny 가 남는다.
  let called = 0;
  const llm = async () => {
    called++;
    return "45명입니다.";
  };
  // 금액 열은 companyx 프로파일의 스키마에만 있다. 이 스위트는 smoke 로 돌므로 그동안만 바꾼다.
  const savedDs = process.env.DATASET;
  const savedKg = process.env.KG_SCHEMA;
  delete process.env.KG_SCHEMA;
  process.env.DATASET = "companyx";
  let asked: Awaited<ReturnType<typeof ask>>;
  try {
    asked = await ask(q2, { pool: fakePool(() => [{ name: "직원" }], []), embedder: deadEmbedder, repair: false, llm, nl2sql: async () => wrong });
  } finally {
    if (savedDs === undefined) delete process.env.DATASET;
    else process.env.DATASET = savedDs;
    if (savedKg !== undefined) process.env.KG_SCHEMA = savedKg;
  }
  ok(called === 0 && asked.sql.text === null && asked.sql.gate?.outcome === "refused", "단위 오류 SQL 은 실행하지 않고 7B 도 부르지 않는다");
  ok(
    asked.answer.startsWith("이 질문의 금액 조건으로는 믿을 수 있는 조회를 만들지 못해 답하지 않았습니다.") &&
      asked.answer.includes("금액 조건(salary >= 2000)") &&
      asked.answer.includes("2억 원 = 20000만 원") &&
      asked.answer.includes("「20000만 원」"),
    `금액 조건 때문에 답하지 않았다고 말한다 (got ${asked.answer})`,
  );
  const { buildAuditRecord } = await import("./auditrecord.js");
  const gate = buildAuditRecord(asked).policies.find((p) => p.policy === "sql-trust-gate");
  ok(gate?.verdict === "deny" && gate.detail.includes("금액 조건 salary >= 2000"), `감사 레코드에 sql-trust-gate deny 와 사유 (got ${JSON.stringify(gate)})`);
  // 금액 사유가 외래키나 번호 사유와 함께 있으면 종전 문장이 먼저다.
  const mixed = untrustedAnswer({ outcome: "refused", rejected: [{ sql: wrong, reasons: [...bad, "e.id = 1 의 번호 1 은 질문에 없다(질문에 없는 번호로 행을 고름)"] }] });
  ok(mixed.startsWith("이 질문으로는 믿을 수 있는 조회를 만들지 못해") && mixed.includes("질문에 없는 번호(e.id = 1)"), `번호 사유가 있으면 종전 문장 (got ${mixed})`);
}

// sql.query 의 읽기 전용 가드가 문자열 속 `;`, `--` 를 문장 구조로 읽었다(랜덤 테스트 사전 점검 D7). `SELECT ';' AS x` 는
// 여러 문장으로 거부됐고 `SELECT '--' AS x` 는 `SELECT '` 로 잘려 실행됐다. 가드는 이제 tokenizeSql 로 문자열, 따옴표 이름,
// 달러 따옴표, 주석을 가른다. 시험항목 TC-068~075 의 거부는 그대로다. DB 없이 가짜 연결로 실제로 보낸 문장을 본다.
{
  const { isReadOnly, sqlQuery, tokenizeSql } = await import("./sql.js");
  for (const sql of [
    "SELECT ';' AS x",
    "SELECT '--' AS x",
    "SELECT '/*' AS a, '*/' AS b",
    "SELECT $$;$$ AS d, $t$ -- $t$ AS e",
    'SELECT ";" FROM companyx.sales',
    "SELECT E'\\';' AS e",
    "SELECT 1 /* a /* ; */ b */",
    "SELECT 1 -- 끝 ;",
    "SELECT 1;",
    "SELECT 1; -- 끝",
  ]) ok(isReadOnly(sql), `문자열, 따옴표 이름, 달러 따옴표, 주석 안의 ; 와 -- 는 문장 구조가 아니다: ${sql}`);
  for (const sql of [
    "INSERT INTO companyx.departments (id, name) VALUES (99, '테스트팀')",
    "UPDATE companyx.employees SET salary = 0",
    "DELETE FROM companyx.sales",
    "DROP TABLE companyx.sales",
    "CREATE TABLE companyx.tmp_x (id int)",
    "TRUNCATE companyx.support_tickets",
    "SELECT 1; DROP TABLE companyx.sales",
    "/* SELECT */ DELETE FROM companyx.sales",
    "SELECT '--'; DROP TABLE companyx.sales",
    "SELECT ';' AS x; DROP TABLE companyx.sales",
    "SELECT 1 -- 주석\r; DROP TABLE companyx.sales",
    "SELECT 1;;",
    "-- SELECT 1",
    "",
  ]) ok(!isReadOnly(sql), `쓰기, DDL, 여러 문장(문자열 밖의 ;), 주석 속 SELECT 는 그대로 거부한다: ${JSON.stringify(sql)}`);
  ok(tokenizeSql("SELECT 1 -- a\r; x")?.some((t) => t.k === ";") === true, "줄 주석은 \\r 에서도 끝난다(PostgreSQL 과 같게)");

  const sent: string[] = [];
  const setup: string[] = [];
  const pool = {
    connect: async () => ({
      query: async (q: string) => {
        if (/^(BEGIN|SET|ROLLBACK)\b/.test(q) || /pg_roles/.test(q)) setup.push(q);
        else sent.push(q);
        return { rows: [{ x: 1 }], rowCount: 1, fields: [{ name: "x" }] };
      },
      release: () => {},
    }),
  } as unknown as Pool;
  const runSql = async (sql: string) => {
    sent.length = 0;
    setup.length = 0;
    const r = await sqlQuery(pool, sql);
    return { ok: r.ok, error: r.error, sent: sent.join(" | ") };
  };
  ok((await runSql("SELECT '--' AS x")).sent === "SELECT '--' AS x", "문자열 속 -- 를 지우지 않고 문장 그대로 보낸다");
  ok((await runSql("SELECT ';' AS x")).sent === "SELECT ';' AS x", "문자열 속 ; 가 있어도 실행한다");
  ok((await runSql("SELECT 1; -- 끝")).sent === "SELECT 1", "끝의 ; 와 그 뒤 주석은 떼고 보낸다");
  ok((await runSql("SELECT 'abc")).sent === "SELECT 'abc", "닫히지 않은 따옴표는 종전처럼 보내 데이터베이스가 오류를 말한다");
  const tc080 = "WITH d AS (DELETE FROM companyx.sales RETURNING *) SELECT count(*) FROM d";
  ok((await runSql(tc080)).sent === tc080, "데이터를 바꾸는 CTE(TC-080)는 종전처럼 읽기 전용 트랜잭션이 거부하게 보낸다");
  const multi = await runSql("SELECT 1; DROP TABLE companyx.sales");
  ok(!multi.ok && multi.sent === "" && multi.error === "rejected: only a single read-only SELECT/WITH query is allowed", "여러 문장은 DB 에 보내지 않고 종전 문장으로 거부한다(TC-074)");
  await runSql("SELECT 1");
  ok(setup.includes("SET LOCAL standard_conforming_strings = on"), "가드와 같은 문자열 규칙(standard_conforming_strings = on)으로 실행한다");
}

// sql.query 는 결과를 전부 받은 뒤 200행으로 잘랐다(G17 ⑨). 이제 서버 쪽 커서로 201행까지만 받고 나머지는 MOVE 로 세기만 한다.
// rowCount 는 종전처럼 전체 행 수다(TC-063 「rowCount=500, rows 200건」). 가짜 연결이 PostgreSQL 의 커서 응답을 흉내 낸다.
{
  const { sqlQuery, MAX_ROWS } = await import("./sql.js");
  const cursorPool = (total: number, fail?: { declare?: string; plain?: Error }) => {
    const log: string[] = [];
    let pos = 0;
    const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: pos + i + 1 }));
    const pool = {
      connect: async () => ({
        query: async (q: string) => {
          log.push(q);
          if (/^DECLARE /.test(q) && fail?.declare) throw new Error(fail.declare);
          const fetch = /^FETCH (\d+) FROM mcp_rows$/.exec(q);
          if (fetch) {
            const r = rows(Math.min(Number(fetch[1]), total - pos));
            pos += r.length;
            return { rows: r, rowCount: r.length, fields: [{ name: "id" }] };
          }
          if (/^MOVE FORWARD ALL IN mcp_rows$/.test(q)) {
            const moved = total - pos;
            pos = total;
            return { rows: [], rowCount: moved };
          }
          if (/^SELECT \* FROM/.test(q)) {
            if (fail?.plain) throw fail.plain;
            return { rows: rows(total), rowCount: total, fields: [{ name: "id" }] };
          }
          return { rows: [], rowCount: 0 };
        },
        release: () => {},
      }),
    } as unknown as Pool;
    return { pool, log };
  };
  const sales = "SELECT * FROM companyx.sales";

  const big = cursorPool(500);
  const r500 = await sqlQuery(big.pool, sales, { cursor: true });
  ok(r500.ok && r500.rowCount === 500 && r500.rows.length === MAX_ROWS && r500.truncated && r500.rows[199].id === 200, `rowCount 500, rows 200, truncated(TC-063) (got ${r500.rowCount}/${r500.rows.length}/${r500.truncated})`);
  ok(!big.log.includes(sales), "결과를 한 번에 받는 문장을 보내지 않는다");
  const at = (re: RegExp) => {
    for (let i = big.log.length - 1; i >= 0; i--) if (re.test(big.log[i])) return i;
    return -1;
  };
  ok(
    at(/^SET LOCAL cursor_tuple_fraction = 1$/) >= 0 &&
      at(/^SET LOCAL cursor_tuple_fraction/) < at(/^SAVEPOINT mcp_read$/) &&
      at(/^SAVEPOINT/) < at(new RegExp(`^DECLARE mcp_rows NO SCROLL CURSOR FOR ${sales.replace(/\*/g, "\\*")}$`)) &&
      at(/^DECLARE/) < at(/^FETCH 201 FROM mcp_rows$/) &&
      at(/^FETCH/) < at(/^SET LOCAL statement_timeout = \d+$/) &&
      at(/^SET LOCAL statement_timeout = \d+$/) < at(/^MOVE FORWARD ALL IN mcp_rows$/) &&
      at(/^MOVE/) < at(/^CLOSE mcp_rows$/) &&
      at(/^CLOSE/) < at(/^ROLLBACK$/),
    `커서 순서: 계획 기준, 세이브포인트, DECLARE, FETCH 201, 남은 상한, MOVE, CLOSE, ROLLBACK (got ${big.log.join(" / ")})`,
  );
  const moveBudget = Number(/^SET LOCAL statement_timeout = (\d+)$/.exec(big.log[at(/^SET LOCAL statement_timeout = \d+$/)])?.[1]);
  ok(big.log[1] === "SET LOCAL statement_timeout = 8000" && moveBudget > 0 && moveBudget <= 8000, `MOVE 는 처음 상한(8초)에서 쓴 시간을 뺀 안에서 돈다 (got ${moveBudget})`);

  for (const total of [0, 1, 200]) {
    const small = cursorPool(total);
    const r = await sqlQuery(small.pool, sales, { cursor: true });
    ok(r.ok && r.rowCount === total && r.rows.length === total && !r.truncated && !small.log.some((q) => /^MOVE/.test(q)), `${total}행이면 FETCH 한 번으로 끝나고 MOVE 하지 않는다`);
  }
  const edge = await sqlQuery(cursorPool(201).pool, sales, { cursor: true });
  ok(edge.rowCount === 201 && edge.rows.length === 200 && edge.truncated, "201행이면 200행과 truncated");

  // 커서가 받지 않는 문장(TC-080 의 데이터를 바꾸는 CTE)은 세이브포인트로 되돌려 종전처럼 실행한다. 오류 문장이 종전과 같다.
  const ro = Object.assign(new Error("cannot execute SELECT in a read-only transaction"), { code: "25006" });
  const cte = cursorPool(0, { declare: "DECLARE CURSOR must not contain data-modifying statements in WITH", plain: ro });
  const tc080 = await sqlQuery(cte.pool, "SELECT * FROM companyx.sales -- 데이터를 바꾸는 CTE 대신", { cursor: true });
  ok(!tc080.ok && tc080.error === "cannot execute SELECT in a read-only transaction (25006)", `DECLARE 가 거부하면 종전 실행의 오류를 돌려준다 (got ${tc080.error})`);
  ok(cte.log.includes("ROLLBACK TO SAVEPOINT mcp_read") && cte.log.indexOf("ROLLBACK TO SAVEPOINT mcp_read") < cte.log.findIndex((q) => /^SELECT \* FROM/.test(q)), "되돌린 뒤 종전 문장을 실행한다");

  // 생성 SQL 경로(파이프라인, 평가)는 cursor 를 주지 않아 종전처럼 한 번에 받는다.
  const plain = cursorPool(500);
  const p = await sqlQuery(plain.pool, sales);
  ok(p.rowCount === 500 && p.rows.length === 200 && plain.log.includes(sales) && !plain.log.some((q) => /^(DECLARE|FETCH|SAVEPOINT)/.test(q)), "cursor 를 주지 않으면 종전 그대로");
}

// 그래프 집계의 「가장 적은」(랜덤 테스트 사전 점검 2차 R6). 공동 1위가 둘 이상이면 모델에게 간 줄의 이름을 다 적고, 잘린 것은 건수로 말한다.
{
  const { fewestAnswer } = await import("./pipeline.js");
  const few = (strategy: string, entries: string[], kept: string[], route = "graph") =>
    fewestAnswer({
      route,
      graph: { strategy, fewest: { relType: "MANAGES_ACCOUNT", count: 0, entries: entries.map((n) => ({ name: n, text: `t:${n}` })) } },
      curated: { kept: kept.map((n) => ({ text: `t:${n}` })) },
    } as unknown as Parameters<typeof fewestAnswer>[0]);
  ok(few("relation-scan", ["윤소연", "박소연", "홍서연"], ["윤소연", "박소연"]) === "가장 적은 쪽 공동 1위가 3건입니다(담당 고객사 0건): 윤소연, 박소연 외 1건.", "공동이면 이름을 다 적고 잘린 것은 건수로");
  ok(few("relation-scan", ["윤소연"], ["윤소연"]) === undefined, "하나뿐이면 모델이 답한다");
  ok(few("seeded+relation-scan", ["윤소연", "박소연"], ["윤소연", "박소연"]) === undefined, "시드가 있는 질문의 전체 순위로는 답하지 않는다");
  ok(few("relation-scan", ["윤소연", "박소연"], ["윤소연", "박소연"], "structured") === undefined, "그래프 레인일 때만");
}

// 측정 항목 한 낱말뿐인 요청(「매출 알려줘」)은 조회하지 않고 되묻는다. 7B 가 매출 500건 가운데 200건을 붙이고 「매출은 1953입니다.」
// (한 건의 값)라고 답했다. 기간, 개체, 집계 같은 다른 내용이 조금이라도 있으면 종전 그대로다. 생성기와 풀은 가짜.
{
  const { vagueMeasure, vagueAnswer } = await import("./sqltrust.js");
  const { buildAuditRecord } = await import("./auditrecord.js");
  for (const [q, word] of [
    ["매출 알려줘", "매출"],
    ["연봉 알려줘", "연봉"],
    ["예산 알려줘", "예산"],
    ["매출은?", "매출"],
    ["연봉이 얼마야?", "연봉"],
    ["매출 좀 알려줘", "매출"],
    ["매출액 알려 주세요", "매출액"],
    ["계약 금액 보여줘", "계약 금액"],
    ["급여", "급여"],
    ["월급 알려줘!", "월급"],
    ["실적 알려줘", "실적"],
    ["금액은 얼마야?", "금액"],
  ] as const) ok(vagueMeasure(q, "companyx") === word, `측정 항목 한 낱말뿐인 요청: ${q} → ${word} (got ${vagueMeasure(q, "companyx")})`);
  for (const q of [
    "매출 합계 알려줘",
    "2025년 매출 알려줘",
    "총 매출은 얼마야?",
    "올해 매출은 얼마야?",
    "Client-A 매출 합계는?",
    "서울 쪽 매출이 어때",
    "2025년 3분기 총 매출액은 얼마야?",
    "기술지원팀 직원 목록과 연봉을 알려줘",
    "평균 연봉이 가장 높은 부서는 어디야?",
    "연봉 4천",
    "매출 현황",
    "가격 알려줘",
    "매출이 연봉보다 많아?",
  ]) ok(vagueMeasure(q, "companyx") === null, `다른 내용이 있으면 되묻지 않는다: ${q}`);
  ok(vagueMeasure("매출 알려줘", "public") === null && vagueMeasure("매출 알려줘", "bench") === null, "측정 항목을 두지 않은 스키마(smoke, bench)는 종전 그대로");
  ok(
    vagueAnswer("매출") ===
      "「매출」만으로는 무엇을 알고 싶은지 정할 수 없어 조회하지 않았습니다. 기간, 고객사, 제품처럼 대상을 함께 물어봐 주세요. 예: 「2025년 3분기 총 매출액은 얼마야?」, 「서울 지역 매출 상위 5개 고객사를 알려줘」",
    `되묻는 문장 (got ${vagueAnswer("매출")})`,
  );
  ok(vagueAnswer("월급").includes("「월급」만으로는") && vagueAnswer("월급").includes("「기술지원팀 직원 목록과 연봉을 알려줘」"), "낱말마다 그 금액 열로 답하는 예시를 든다");
  // 근거 없이 쓰는 답이라 예시에 개체 식별자가 있으면 감사의 접지 검사가 근거 밖 개체로 적는다(「Client-A 매출 합계는?」에서 실측).
  const { outsideContextMentions } = await import("./auditrecord.js");
  for (const w of ["매출", "매출액", "실적", "연봉", "급여", "월급", "예산", "계약 금액", "계약금액", "금액"]) {
    ok(outsideContextMentions(vagueAnswer(w), "").length === 0, `되묻는 답이 접지 검사에 걸리지 않는다: ${w} (got ${outsideContextMentions(vagueAnswer(w), "")})`);
  }

  // ask: 생성 모델도 DB 도 부르지 않고 되묻는다. 감사에는 sql-trust-gate deny 와 그 낱말이 남고 읽기 전용 판정은 없다.
  const executed: string[] = [];
  const pool = {
    connect: async () => ({
      query: async (sql: string) => {
        executed.push(sql);
        return { rows: [{ amount: 1953 }], rowCount: 1, fields: [{ name: "amount" }] };
      },
      release: () => {},
    }),
    query: async (sql: string) => {
      executed.push(sql);
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;
  let generated = 0;
  let answered = 0;
  const deps = {
    pool,
    embedder: deadEmbedder,
    repair: false,
    llm: async () => {
      answered++;
      return "매출은 1953입니다.";
    },
    nl2sql: async () => {
      generated++;
      return "SELECT amount FROM companyx.sales";
    },
  };
  const saved = process.env.DATASET;
  process.env.DATASET = "companyx";
  try {
    const r = await ask("매출 알려줘", deps);
    ok(r.answer === vagueAnswer("매출") && generated === 0 && answered === 0 && executed.length === 0, `생성 모델, DB, 답 모델을 부르지 않고 되묻는다 (got ${r.answer})`);
    ok(r.sql.text === null && r.sql.gate?.outcome === "refused" && r.sql.gate.vague === "매출" && r.audit.sql_gate?.vague === "매출", "retrieve 의 audit 에도 되물은 낱말이 남는다");
    const rec = buildAuditRecord(r);
    const gate = rec.policies.find((p) => p.policy === "sql-trust-gate");
    ok(
      gate?.verdict === "deny" && gate.detail.includes("측정 항목 한 낱말(「매출」)") && !rec.policies.some((p) => p.policy === "sql-read-only") && rec.retrieval.sql.text === null,
      `감사는 기존 정책 이름(sql-trust-gate deny)으로 남는다 (got ${JSON.stringify(rec.policies)})`,
    );
    ok(rec.grounding?.outside_context.length === 0, `감사의 접지 검사에 근거 밖 개체가 없다 (got ${rec.grounding?.outside_context})`);
    const total = await ask("매출 합계 알려줘", deps);
    ok(generated === 1 && answered === 1 && !total.sql.gate && total.answer.startsWith("매출은 1953입니다."), "집계 낱말이 있으면 종전처럼 SQL 을 만들어 답한다");
  } finally {
    if (saved === undefined) delete process.env.DATASET;
    else process.env.DATASET = saved;
  }
}

// 순위 질문(「두 번째로 많이」)의 `ORDER BY … LIMIT 1 OFFSET k` 는 같은 순위의 행을 모두 돌려주는 DENSE_RANK 질의로 실행한다.
// 「계약을 두 번째로 많이 담당한 직원」은 장미라, 김준혁, 안소연이 4건으로 같은데 OFFSET 1 이 김준혁 한 명만 골랐다.
{
  const { ordinalRanks, rankRewrite } = await import("./sqltrust.js");
  const { executeWithRepair } = await import("./sqlrepair.js");
  for (const [q, ranks] of [
    ["계약을 두 번째로 많이 담당한 직원은 누구야?", [2]],
    ["매출이 세번째로 높은 고객사는?", [3]],
    ["셋째로 큰 계약", [3]],
    ["2위 고객사는?", [2]],
    ["12번째 직원", [12]],
    ["첫 번째로 한 조치가 뭐였지?", []],
    ["1위 고객사", []],
    ["서울 지역 매출 상위 5개 고객사를 알려줘", []],
    ["두 번 이상 계약한 고객사", []],
    ["2026-08-18 위조 시험", []],
  ] as const) ok(JSON.stringify(ordinalRanks(q)) === JSON.stringify(ranks), `질문의 순위(2 이상): ${q} → ${JSON.stringify(ranks)} (got ${JSON.stringify(ordinalRanks(q))})`);

  const q2 = "계약을 두 번째로 많이 담당한 직원은 누구야?";
  const second =
    "SELECT e.name FROM companyx.employees e JOIN companyx.contracts c ON e.id = c.manager_id GROUP BY e.id, e.name ORDER BY COUNT(c.id) DESC LIMIT 1 OFFSET 1";
  const ranked =
    "SELECT * FROM (SELECT e.name, CAST(DENSE_RANK() OVER (ORDER BY COUNT(c.id) DESC) AS integer) AS rank FROM companyx.employees e " +
    "JOIN companyx.contracts c ON e.id = c.manager_id GROUP BY e.id, e.name ORDER BY COUNT(c.id) DESC) AS ranked WHERE rank = 2";
  ok(JSON.stringify(rankRewrite(second, q2)) === JSON.stringify({ text: ranked, rank: 2 }), `OFFSET 1 을 2위의 행 전부로 (got ${rankRewrite(second, q2)?.text})`);
  ok(
    rankRewrite(
      "SELECT d.name, COUNT(e.id) AS employee_count FROM companyx.departments d JOIN companyx.employees e ON d.id = e.dept_id GROUP BY d.name ORDER BY employee_count DESC OFFSET 1 LIMIT 1;",
      "직원이 두 번째로 많은 부서는 어디야?",
    )?.text ===
      "SELECT * FROM (SELECT d.name, COUNT(e.id) AS employee_count, CAST(DENSE_RANK() OVER (ORDER BY COUNT(e.id) DESC) AS integer) AS rank " +
        "FROM companyx.departments d JOIN companyx.employees e ON d.id = e.dept_id GROUP BY d.name ORDER BY employee_count DESC) AS ranked WHERE rank = 2",
    "출력 열 이름으로 정렬하면 그 식을 창 함수에 넣는다(OFFSET 이 앞, 끝 세미콜론)",
  );
  ok(
    rankRewrite(
      "SELECT c.name, SUM(s.amount) total FROM companyx.clients c JOIN companyx.sales s ON c.id = s.client_id GROUP BY c.name ORDER BY 2 DESC NULLS LAST OFFSET 2 ROWS FETCH FIRST 1 ROWS ONLY",
      "매출이 세 번째로 높은 고객사는?",
    )?.text ===
      "SELECT * FROM (SELECT c.name, SUM(s.amount) total, CAST(DENSE_RANK() OVER (ORDER BY SUM(s.amount) DESC NULLS LAST) AS integer) AS rank " +
        "FROM companyx.clients c JOIN companyx.sales s ON c.id = s.client_id GROUP BY c.name ORDER BY 2 DESC NULLS LAST) AS ranked WHERE rank = 3",
    "자리 번호 정렬, NULLS LAST, OFFSET … FETCH FIRST 1 ROWS ONLY",
  );
  // 둘째 정렬 키(이름)는 같은 값을 늘어놓는 순서다. 순위에 넣으면 공동 순위가 갈라져 한 명만 남는다(PR #257 Codex P1).
  ok(
    rankRewrite(
      "SELECT e.name, COUNT(c.id) AS contract_count FROM companyx.employees e JOIN companyx.contracts c ON e.id = c.manager_id " +
        "GROUP BY e.id, e.name ORDER BY contract_count DESC, e.name ASC LIMIT 1 OFFSET 1",
      q2,
    )?.text ===
      "SELECT * FROM (SELECT e.name, COUNT(c.id) AS contract_count, CAST(DENSE_RANK() OVER (ORDER BY COUNT(c.id) DESC) AS integer) AS rank " +
        "FROM companyx.employees e JOIN companyx.contracts c ON e.id = c.manager_id GROUP BY e.id, e.name ORDER BY contract_count DESC, e.name ASC) AS ranked WHERE rank = 2",
    "순위는 첫 정렬 키로만 매기고 둘째 키는 안쪽 ORDER BY 에 남는다",
  );
  for (const [q, sql] of [
    ["계약을 많이 담당한 직원 목록", second], // 질문에 순위가 없다
    ["계약을 세 번째로 많이 담당한 직원은 누구야?", second], // 질문의 순위(3)와 OFFSET 1 이 어긋난다
    [q2, second.replace("LIMIT 1 OFFSET 1", "LIMIT 2 OFFSET 1")],
    [q2, second.replace(" OFFSET 1", "")],
    [q2, `WITH x AS (SELECT 1) ${second}`],
    [q2, second.replace("SELECT e.name", "SELECT DISTINCT e.name")],
    [q2, `${second} -- 2위`],
    [q2, `SELECT * FROM (${second}) s`],
    [q2, `SELECT name FROM companyx.employees UNION ${second}`],
    [q2, second.replace("SELECT e.name", "SELECT e.name, RANK() OVER (ORDER BY e.id) AS rank")],
    [q2, "SELECT e.name, d.name FROM companyx.employees e JOIN companyx.departments d ON e.dept_id = d.id ORDER BY name LIMIT 1 OFFSET 1"],
    [q2, `${second} FOR UPDATE`],
    [q2, "SELECT e.name FROM companyx.employees e ORDER BY e.salary DESC LIMIT 1 OFFSET $1"],
  ] as const) ok(rankRewrite(sql, q) === null, `순위 질문의 꼴이 아니면 바꾸지 않는다: ${q} / ${sql}`);

  // 실행: 바꾼 SQL 이 검사를 지나 행을 돌려주면 그것을 쓰고, 실행되지 않거나 0행이면 처음 SQL 을 그대로 실행한다.
  const fkRows = [
    { table_name: "contracts", column_name: "manager_id", ref_table: "employees", ref_column: "id" },
    { table_name: "employees", column_name: "dept_id", ref_table: "departments", ref_column: "id" },
  ];
  const tied = [
    { name: "장미라", rank: 2 },
    { name: "김준혁", rank: 2 },
    { name: "안소연", rank: 2 },
  ];
  const rankPool = (answer: (sql: string) => Record<string, unknown>[] | Error, executed: string[]) =>
    ({
      connect: async () => ({
        query: async (sql: string) => {
          if (!/^\s*(select|with)\b/i.test(sql) || /pg_roles/.test(sql)) return { rows: [], rowCount: 0, fields: [] };
          executed.push(sql);
          const rows = answer(sql);
          if (rows instanceof Error) throw rows;
          return { rows, rowCount: rows.length, fields: Object.keys(rows[0] ?? {}).map((name) => ({ name })) };
        },
        release: () => {},
      }),
      query: async (sql: string) => (/pg_constraint/.test(sql) ? { rows: fkRows, rowCount: fkRows.length } : { rows: [], rowCount: 0 }),
    }) as unknown as Pool;
  const byRank = (rows: Record<string, unknown>[] | Error) => (sql: string) => (/DENSE_RANK/.test(sql) ? rows : [{ name: "김준혁" }]);

  const ran: string[] = [];
  const ex = await executeWithRepair(rankPool(byRank(tied), ran), q2, second, { repair: false });
  ok(ex.text === ranked && ex.rank === 2 && ex.result?.rows.length === 3 && ran.join() === ranked && !ex.gate, `같은 순위 셋을 모두 돌려준다 (got ${JSON.stringify({ text: ex.text, ran })})`);
  const failures: [string, Record<string, unknown>[] | Error][] = [
    ["실행 오류", Object.assign(new Error('column "cnt" does not exist'), { code: "42703" })],
    ["0행", []],
  ];
  for (const [why, rows] of failures) {
    const log: string[] = [];
    const back = await executeWithRepair(rankPool(byRank(rows), log), q2, second, { repair: false });
    ok(back.text === second && back.rank === undefined && back.result?.rows.length === 1 && log.join(" | ") === `${ranked} | ${second}`, `바꾼 SQL 이 ${why}면 처음 SQL 을 그대로 실행한다 (got ${JSON.stringify(log)})`);
  }
  const plainLog: string[] = [];
  const plain = await executeWithRepair(rankPool(byRank(tied), plainLog), "계약을 많이 담당한 직원 목록", second, { repair: false });
  ok(plain.text === second && plain.rank === undefined && plainLog.join() === second, "순위를 묻지 않은 질문은 종전 그대로 실행한다");

  // ask: 공동 순위는 7B 없이 이름을 모두 적는 결정론 문장, 한 행이면 종전처럼 7B 가 쓴다.
  let llmCalls = 0;
  const llm = async () => {
    llmCalls++;
    return "김준혁입니다.";
  };
  const askWith = (rows: Record<string, unknown>[]) =>
    ask(q2, { pool: rankPool(byRank(rows), []), embedder: deadEmbedder, repair: false, llm, nl2sql: async () => second });
  const tie = await askWith(tied);
  ok(
    tie.answer.startsWith("공동 2위가 3건입니다: 장미라, 김준혁, 안소연.") && tie.answer.includes("[조회 결과 3건]\n- name: 장미라, rank: 2") && llmCalls === 0 && tie.sql.rank === 2 && tie.sql.text === ranked,
    `공동 2위는 이름을 모두 적는다 (got ${tie.answer})`,
  );
  const one = await askWith([{ name: "조현우", rank: 2 }]);
  ok(llmCalls === 1 && one.answer.startsWith("김준혁입니다.") && one.answer.includes("[조회 결과 1건]\n- name: 조현우, rank: 2"), "그 순위가 한 행이면 종전처럼 7B 가 문장을 쓴다");
}

// G12: 개체를 지목한 hybrid 는 라우터가 그래프 도구까지 여는데 파이프라인은 route 가 graph 일 때만 그래프를 돌았다.
// hybrid 의 그래프는 근거만 더하고, 못 찾았다는 판정은 답을 정하지 않는다.
{
  const { lanesFor, hybridGraph } = await import("./pipeline.js");
  const lanes = (route: "structured" | "semantic" | "graph" | "hybrid", tools: string[]) => JSON.stringify(lanesFor({ route, tools }));
  ok(lanes("hybrid", ["sql.query", "vector.search", "ontology.search", "graph.expand"]) === JSON.stringify({ sql: true, vector: true, graph: true }), "개체를 지목한 hybrid 는 세 레인");
  ok(lanes("hybrid", ["sql.query", "vector.search"]) === JSON.stringify({ sql: true, vector: true, graph: false }), "앵커 없는 hybrid 는 종전대로 둘(TC-146)");
  ok(lanes("graph", ["ontology.search", "graph.expand"]) === JSON.stringify({ sql: false, vector: false, graph: true }), "graph 는 그래프만");
  ok(lanes("structured", ["sql.query"]) === JSON.stringify({ sql: true, vector: false, graph: false }), "structured 는 정형만");
  ok(lanes("semantic", ["vector.search"]) === JSON.stringify({ sql: false, vector: true, graph: false }), "semantic 은 문서만");

  const nf = { reason: "not_in_database" as const, query_entity: "서울물산", candidates: [] };
  const edge = { canonicalKey: "edge#1", sourceKey: "graph#0", source: "graph" as const, text: "[그래프] 클라우드사업부의 부서장: 강현우", provenance: "kg:HEADS" };
  const unresolved = hybridGraph({
    seeds: [],
    edgeCount: 0,
    strategy: "unresolved",
    not_found: nf,
    items: [{ canonicalKey: "unresolved#서울물산", sourceKey: "graph#unresolved", source: "graph", text: "[그래프] 질문에 나온 개체(서울물산)를 …", provenance: "ontology:unresolved" }],
  } as Parameters<typeof hybridGraph>[0]);
  ok(unresolved.items.length === 0 && unresolved.not_found === undefined, "hybrid 에서 개체를 못 찾으면 그래프는 아무것도 더하지 않고 답을 정하지 않는다");
  const partial = hybridGraph({
    seeds: [{ entityId: 7, canonicalName: "클라우드사업부", type: "department" }],
    edgeCount: 1,
    strategy: "seeded",
    missing: [nf],
    answer_query: "클라우드사업부 부서장",
    items: [{ canonicalKey: "missing#서울물산", sourceKey: "graph#missing", source: "graph", text: "[그래프] …", provenance: "ontology:missing" }, edge],
  } as Parameters<typeof hybridGraph>[0]);
  ok(
    partial.items.length === 1 && partial.items[0] === edge && partial.missing === undefined && partial.answer_query === undefined && partial.edgeCount === 1,
    "섞인 질문의 없는 개체 줄과 missing 은 빼고 찾은 개체의 엣지는 남긴다",
  );
}

// 문서 개수 질문(랜덤 테스트 사전 점검 2차 R9). 「Product-C1 관련 장애 보고서는 몇 건이야?」에 7B 가 조각 다섯을 보고 「2건」(실제 1건),
// 「Product-C1 관련 문서는 몇 개야?」는 정형으로 가서 매출 46건을 셌다(실제 3건). 문서 제목으로 세고 7B 없이 답한다.
{
  const { installOntology } = await import("./router.js");
  const { documentCountAnswer } = await import("./pipeline.js");
  const savedDataset = process.env.DATASET;
  process.env.DATASET = "companyx";
  installOntology(
    [
      { id: "1", name: "Client-A", type: "client" },
      { id: "6", name: "Client-F", type: "client" },
      { id: "31", name: "Product-C1", type: "product" },
      { id: "33", name: "Product-C12", type: "product" },
      { id: "40", name: "김준혁", type: "employee" },
    ] as { id: string; name: string; type: string }[],
    [],
  );
  const titles = [
    "[장애보고] Client-A Product-C1 서비스 장애 (2025-12-27)",
    "[장애보고] Client-B Product-C12 서비스 장애 (2025-04-22)",
    "[기술문서] Product-C1 설치 가이드",
    "[회의록] Client-A 정기 미팅 (2025-04-21)",
    "[제안서] Client-F Product-C1 도입 제안",
  ];
  const sent: string[] = [];
  const docPool = (fail?: Error) =>
    ({
      query: async (sql: string) => {
        sent.push(sql);
        if (fail) throw fail;
        // 문서 뷰의 제목은 「문서 제목 — 절 제목」이다. 같은 문서의 조각이 여럿이다.
        return { rows: titles.map((t, i) => ({ title: t, first: i * 7 + 1 })), rowCount: titles.length };
      },
    }) as unknown as Pool;
  let llmCalls = 0;
  const llm = async () => {
    llmCalls++;
    return "2건";
  };
  const incident = await ask("Product-C1 관련 장애 보고서는 몇 건이야?", { pool: docPool(), embedder: deadEmbedder, llm });
  ok(
    incident.answer === "문서 제목 기준으로 Product-C1 관련 장애 보고서는 1건입니다: [장애보고] Client-A Product-C1 서비스 장애 (2025-12-27)." && llmCalls === 0,
    `장애 보고서는 제목의 꼬리표와 이름으로 센다(Product-C12 는 Product-C1 이 아니다) (got ${incident.answer})`,
  );
  ok(incident.route === "semantic" && /^document count \(Product-C1 장애 보고서\)/.test(incident.audit.route.rationale) && incident.sql.text === null && incident.vector === undefined, "정형, 벡터 레인을 부르지 않고 근거에 남긴다");
  ok(/SELECT split_part\(title, ' — ', 1\) AS title, min\(id\) AS first FROM companyx\.documents GROUP BY 1 ORDER BY 2, 1/.test(sent[0] ?? ""), `문서 뷰에서 문서 제목을 적재 순서로 읽는다 (got ${sent[0]})`);
  ok(incident.context.includes("[문서] [장애보고] Client-A Product-C1 서비스 장애 (2025-12-27)") && incident.context.includes("[문서 개수] 문서 5건 가운데 제목 기준 Product-C1 관련 장애 보고서: 1건"), "센 결과와 제목이 컨텍스트에 있다(답의 개체가 근거 안)");
  const all = await ask("Product-C1 관련 문서는 몇 개야?", { pool: docPool(), embedder: deadEmbedder, llm });
  ok(
    all.answer === "문서 제목 기준으로 Product-C1 관련 문서는 3건입니다: [장애보고] Client-A Product-C1 서비스 장애 (2025-12-27), [기술문서] Product-C1 설치 가이드, [제안서] Client-F Product-C1 도입 제안.",
    `문서는 종류를 가리지 않는다 (got ${all.answer})`,
  );
  const minutes = await ask("회의록은 몇 개야?", { pool: docPool(), embedder: deadEmbedder, llm });
  ok(minutes.answer === "문서 제목 기준으로 회의록은 1건입니다: [회의록] Client-A 정기 미팅 (2025-04-21).", `개체가 없으면 그 종류 전부, 받침 뒤는 「은」 (got ${minutes.answer})`);
  const none = await ask("Client-F 관련 회의록은 몇 건이야?", { pool: docPool(), embedder: deadEmbedder, llm });
  ok(none.answer === "문서 제목 기준으로 Client-F 관련 회의록은 없습니다(0건).", `없으면 0건이라고 말한다 (got ${none.answer})`);
  ok(documentCountAnswer({ request: { kind: "문서" }, ok: true, total: 12, titles: Array.from({ length: 12 }, (_, i) => `D${i + 1}`) }).endsWith("D10 외 2건."), "제목은 열 건까지 적고 나머지는 건수만");
  const down = await ask("Product-C1 관련 문서는 몇 개야?", { pool: docPool(new Error("connection refused")), embedder: deadEmbedder, llm });
  ok(down.answer.startsWith("조회에 실패해 답할 근거를 가져오지 못했습니다.") && down.answer.includes("documents: connection refused") && llmCalls === 0, `문서 조회가 실패하면 0건이라 하지 않고 실패를 말한다 (got ${down.answer})`);
  process.env.DATASET = "smoke";
  const smoke = await ask("Product-C1 관련 문서는 몇 개야?", { pool: docPool(), embedder: deadEmbedder, llm, nl2sql: async () => null });
  ok(smoke.documents === undefined && !/document count/.test(smoke.audit.route.rationale), "제목 꼬리표는 Company-X 규약이라 다른 프로파일에서는 쓰지 않는다");
  installOntology([], []);
  if (savedDataset === undefined) delete process.env.DATASET;
  else process.env.DATASET = savedDataset;
}

// 정형 레인에는 개체 게이트가 없어 「서울물산의 2025년 3분기 총 매출액은 얼마야?」(TC-143)에 「서울물산의 … 매출액은 없습니다.」라고
// 서울물산이 있는 고객사처럼 답했다. 이름처럼 생긴 낱말이 온톨로지에 없고 생성 SQL 이 그 이름을 그대로 찾았으면 사유를 답 앞에 붙인다.
// 답의 나머지와 조회 행 블록은 그대로다.
{
  const savedDataset = process.env.DATASET;
  process.env.DATASET = "companyx";
  const KNOWN = ["Client-A", "기술지원팀", "Product-C1", "김준혁"];
  const ontoPool = (sqlRows: Record<string, unknown>[]) =>
    ({
      connect: async () => ({
        query: async (sql: string) => {
          const r = /^\s*(select|with)\b/i.test(sql) && !/pg_roles/.test(sql) ? sqlRows : [];
          return { rows: r, rowCount: r.length, fields: Object.keys(r[0] ?? {}).map((name) => ({ name })) };
        },
        release: () => {},
      }),
      query: async (sql: string, params?: unknown[]) => {
        if (sql.includes("information_schema.columns")) return { rowCount: 1, rows: [{}] };
        if (sql.includes("canonical_name AS name")) return { rowCount: KNOWN.length, rows: KNOWN.map((name) => ({ name, type: "client" })) };
        if (sql.includes("WITH t AS")) {
          const terms = (params?.[0] ?? []) as string[];
          const rows = KNOWN.flatMap((name, id) =>
            terms.some((t) => name.toLowerCase().includes(t.toLowerCase()))
              ? [{ id, type: "client", canonical_name: name, properties: null, via: "canonical", matched: terms[0], score: 4 }]
              : [],
          );
          return { rowCount: rows.length, rows };
        }
        return { rowCount: 0, rows: [] };
      },
    }) as unknown as Pool;
  const tc143 = "서울물산의 2025년 3분기 총 매출액은 얼마야?";
  const sumSql = (name: string) => `SELECT SUM(amount) AS total_sales FROM companyx.sales WHERE client_id IN (SELECT id FROM companyx.clients WHERE name = '${name}') AND quarter = '2025-Q3'`;
  const llm = async () => "서울물산의 2025년 3분기 총 매출액은 없습니다.";
  const r = await ask(tc143, { pool: ontoPool([{ total_sales: null }]), embedder: deadEmbedder, repair: false, llm, nl2sql: async () => sumSql("서울물산") });
  ok(
    r.answer ===
      "질문에 나온 개체(서울물산)를 데이터베이스에서 찾지 못했습니다. 이름이 비슷한 개체도 없습니다. 해당 개체는 데이터셋에 존재하지 않습니다.\n\n" +
        "서울물산의 2025년 3분기 총 매출액은 없습니다.\n\n[조회 결과 1건]\n- total_sales: null",
    `없는 개체의 사유를 답 앞에 붙이고 답과 행 블록은 그대로 (got ${JSON.stringify(r.answer)})`,
  );
  ok(r.sql.missing?.[0]?.query_entity === "서울물산" && r.route === "structured", "정형 레인 결과에 못 찾은 개체가 남는다");
  const other = await ask(tc143, { pool: ontoPool([{ total_sales: 120 }]), embedder: deadEmbedder, repair: false, llm: async () => "120입니다.", nl2sql: async () => sumSql("Client-A") });
  ok(other.answer.startsWith("120입니다."), `생성 SQL 이 그 이름을 찾지 않았으면 사유를 붙이지 않는다(답과 어긋남) (got ${other.answer})`);
  for (const q of ["Client-A의 2025년 3분기 총 매출액은 얼마야?", "기술지원팀 직원들의 평균 연봉은?", "Product-C1 매출 합계는?", "김준혁이 담당한 계약의 총 금액은 얼마야?", "2019년에 등록된 고객사는 몇 개야?"]) {
    const ex = await ask(q, { pool: ontoPool([{ n: 1 }]), embedder: deadEmbedder, repair: false, llm: async () => "답", nl2sql: async () => "SELECT 1 AS n FROM companyx.clients" });
    ok(ex.sql.missing === undefined && ex.answer.startsWith("답"), `있는 이름, 이름이 아닌 말에는 붙지 않는다: ${q} (got ${ex.answer})`);
  }
  if (savedDataset === undefined) delete process.env.DATASET;
  else process.env.DATASET = savedDataset;
}

console.log(`degraded.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
