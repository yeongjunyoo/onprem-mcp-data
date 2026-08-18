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
import type { Pool } from "pg";

import type { Embedder } from "./embedder.js";
import { ask, retrieve } from "./pipeline.js";

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

console.log(`degraded.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
