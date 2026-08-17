// 종료 헬퍼.
//
// Windows libuv 는 핸들이 **닫히는 중**일 때 process.exit 을 부르면
// `!(handle->flags & UV_HANDLE_CLOSING)` assertion 을 내고 종료코드를 9로 바꾼다.
// pg 풀의 end() 는 소켓 close 를 시작만 하고 즉시 반환하므로, 바로 exit 하면
// 정확히 그 창에 걸린다. QA 가 DB 불통과 auditcache 양쪽에서 재현했다.
//
// 그래서 닫고 → 한 틱 쉬고 → 끝낸다. 자연 종료만으로는 air 서버 인스턴스가
// 핸들을 물어 프로세스가 매달린다(실측 120초). 매달리는 것은 실패보다 나쁘다.
import { closePool } from "./db.js";

export async function shutdown(code: number): Promise<never> {
  try {
    await closePool();
  } catch {
    /* 정리 실패가 종료를 막지 않는다 */
  }
  // close 콜백이 돌 틈을 준다. 이 지연이 exit 9 와 exit code 를 가른다.
  await new Promise((r) => setTimeout(r, 100));
  process.exit(code);
}
