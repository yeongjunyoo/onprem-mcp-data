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

/** 모델 서버(Ollama) 연결 실패의 문장. 데이터베이스 연결 실패(db.ts connectionFailure)와 가른다. 사용자 답과 감사 레코드에는 원인 코드까지만 적고 주소는 적지
 * 않는다(고칠 단서는 서버 로그). Ollama 가 죽었는데 「데이터베이스에 연결하지 못했습니다(ECONNREFUSED)」라고 답해 멀쩡한 DB 를 보게 했다(2026-11-02 실측). */
export const MODEL_SERVER_FAILURE = "모델 서버에 연결하지 못했습니다";
const NET_CODE = /\b(ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|EHOSTUNREACH|ENETUNREACH|EPIPE|EAI_AGAIN)\b/;

/** 모델 서버 호출이 네트워크에서 실패했으면 원인 코드만 남긴 오류. 그 밖의 실패면 null. */
export function modelServerError(err: unknown): Error | null {
  const code = NET_CODE.exec(describeError(err))?.[1];
  return code ? new Error(`${MODEL_SERVER_FAILURE}(${code})`) : null;
}

/** 실패 문장에서 모델 서버 쪽 사유를 사용자에게 보일 꼴로. 연결 실패는 그 문장, HTTP 오류는 상태 코드까지(본문에는 서버 안의 경로가 들 수 있다). 아니면 null. */
export function modelServerReason(text: string): string | null {
  const at = text.indexOf(MODEL_SERVER_FAILURE);
  if (at >= 0) return /^[^)]*\)/.exec(text.slice(at))?.[0] ?? MODEL_SERVER_FAILURE;
  const http = /\bollama (?:generate|embeddings) (\d{3})\b/.exec(text);
  return http ? `모델 서버가 오류로 응답했습니다(HTTP ${http[1]})` : null;
}
