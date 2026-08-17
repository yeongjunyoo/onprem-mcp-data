// audit.explain 캐시 우회 테스트 (이슈 #12) — DB + 모델 필요.
//
// 무엇을 막는가. air의 cachePlugin은 60초 TTL로 모든 도구 호출을 캐싱한다.
// `audit.explain`도 도구라서 제외하지 않으면 같은 질의를 연속 감사할 때 **60초 전의
// 실행 기록**이 돌아온다. 감사의 목적은 "지금 이 순간 파이프라인이 무엇을 하는가"이므로
// 그것은 감사가 아니라 과거 기록의 재생이다.
//
// 캐시 우회는 **보이지 않는 성질**이다. 되돌려도 결과가 그럴듯해 보이므로 테스트가
// 없으면 아무도 모른다. 그래서 여기서 명시적으로 잰다.
//
// 실행: node dist/auditcache.test.js
import { closePool } from "./db.js";
import { buildServer } from "./server.js";

let pass = 0,
  fail = 0;
function ok(cond: boolean, msg: string) {
  if (cond) pass++;
  else {
    fail++;
    console.error("  FAIL:", msg);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const server = buildServer();
  const q = "환불 정책 알려줘";

  // ── audit.explain은 매번 새로 실행돼야 한다 ─────────────────────────
  const a1 = JSON.parse(await server.callTool("audit.explain", { query: q }));
  await sleep(1100); // executed_at이 초 단위로도 갈리도록
  const a2 = JSON.parse(await server.callTool("audit.explain", { query: q }));

  ok(a1.cache_policy === "excluded", "감사 레코드가 캐시 정책을 선언한다");
  ok(typeof a1.executed_at === "string", "감사 레코드에 실행 시각이 있다");
  ok(
    a1.executed_at !== a2.executed_at,
    `두 감사가 서로 다른 시점의 실행이다 (${a1.executed_at} vs ${a2.executed_at})`,
  );

  // 결정론 구간은 그대로여야 한다. 캐시를 껐다고 라우팅이 흔들리면 그건 다른 문제다.
  ok(
    a1.routing_fingerprint === a2.routing_fingerprint,
    "캐시를 우회해도 라우팅 지문은 동일하다(결정론 유지)",
  );

  // ── 대조군 ──────────────────────────────────────────────────────────
  //
  // ★ 이 대조군은 한 번 무효였다. 처음에는 `route`를 두 번 불러 같은 문자열이
  // 나오는지 봤는데, route는 결정론이라 **캐시가 꺼져 있어도 같은 문자열**이
  // 나온다. 실제로 cachePlugin의 exclude에 route를 임시로 추가해도 그 단언은
  // 그대로 통과했다(QA 레드팀 재현). 즉 아무것도 증명하지 못했다.
  //
  // 캐시를 증명하려면 **호출마다 값이 달라지는** 관측점이 필요하다.
  // `ask`는 exclude에 없고 응답에 7B가 만든 답이 실려 지연이 실측 가능하다.
  // 캐시가 돌면 2회차가 1회차보다 확연히 빠르다.
  const t1 = Date.now();
  const k1 = await server.callTool("ask", { query: q });
  const d1 = Date.now() - t1;
  const t2 = Date.now();
  const k2 = await server.callTool("ask", { query: q });
  const d2 = Date.now() - t2;

  ok(k1 === k2, "대조군: 캐시 대상 도구는 같은 응답을 돌려준다");
  ok(
    d2 * 5 < d1 || d2 < 50,
    `대조군: 2회차가 캐시로 훨씬 빠르다 (1회차 ${d1}ms, 2회차 ${d2}ms)`,
  );

  console.log(`\nauditcache.test: ${pass} passed, ${fail} failed`);
  // 풀을 **먼저 닫고** 종료한다. 핸들이 열린 채 process.exit 을 부르면 Windows libuv
  // 가 assertion 을 내며 종료코드가 9로 바뀐다.
  //
  // 다만 자연 종료만으로는 끝나지 않는다 — air 서버 인스턴스가 자체 핸들을 물고
  // 있어 프로세스가 매달린다(실측: 120초 타임아웃). 정리 후 명시적으로 끝낸다.
  // 매달리는 테스트는 실패보다 나쁘다. CI가 무한히 기다린다.
  await closePool();
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
