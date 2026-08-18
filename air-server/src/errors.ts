/** 사람이 읽을 실패 이유를 만든다. **절대 빈 문자열을 돌려주지 않는다.**
 *
 * `err.message` 하나만 쓰면 안 되는 이유: Node 가 여러 주소로 접속을 시도하다
 * 실패하면 `AggregateError` 를 던지는데 그 `message` 는 **빈 문자열**이고 진짜
 * 이유는 `errors[0]` 에 들어 있다. 2026-08-17 에 DB 가 죽은 상태로
 * `vector.search` 를 부르면 사용자가 `{"ok":false,"error":""}` 를 읽었다 —
 * 실패 표식은 있는데 이유가 없었다.
 */
export function describeError(err: unknown): string {
  if (err instanceof AggregateError && err.errors?.length) {
    const inner = err.errors
      .map((e) => describeError(e))
      .filter(Boolean)
      .join("; ");
    if (inner) return err.message ? `${err.message}: ${inner}` : inner;
  }
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    if (err.message) return code ? `${err.message} (${code})` : err.message;
    if (code) return `${err.name}: ${code}`;
    return err.name || "알 수 없는 오류";
  }
  const s = String(err);
  return s && s !== "[object Object]" ? s : "알 수 없는 오류";
}
