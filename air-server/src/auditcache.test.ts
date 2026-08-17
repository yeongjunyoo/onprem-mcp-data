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

  ok(a1.cache_bypassed === true, "감사 레코드가 캐시 우회를 선언한다");
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

  // ── 대조군: 캐시가 켜진 도구는 실제로 캐시된다 ──────────────────────
  // route는 exclude에 없으므로 같은 인스턴스가 돌아온다. 이 대조가 없으면
  // "우회됐다"가 아니라 "애초에 캐시가 안 돈다"일 수도 있다.
  const r1 = await server.callTool("route", { query: q });
  const r2 = await server.callTool("route", { query: q });
  ok(r1 === r2, "대조군: 캐시 대상 도구는 같은 응답 문자열을 돌려준다");

  console.log(`\nauditcache.test: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
