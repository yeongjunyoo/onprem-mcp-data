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

console.log(`degraded.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
