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

// Ollama 에 JSON 을 POST 한다. 마감은 호출자가 준 signal 하나가 정한다.
//
// fetch 를 쓰지 않는 이유. Node 의 fetch(undici)는 응답 헤더를 300초까지만 기다린다(headersTimeout,
// 바꿀 공개 API 가 없다). stream:false 인 생성과 임베딩은 끝날 때까지 헤더를 보내지 않으므로,
// OLLAMA_TIMEOUT_MS, OLLAMA_EMBED_TIMEOUT_MS, WARMUP_TIMEOUT_MS 를 300초보다 크게 줘도 300초에
// 「fetch failed」로 끊겼다. 느린 환경이면 올리라고 안내하던 값이 300초 위에서는 아무 효과가 없었다.
// 2026-10-01 에 CPU 컨테이너가 7B 를 처음 올리는 워밍업과, GPU 를 다른 작업과 나눠 쓴 호스트의
// SQL 생성 세 건이 그렇게 끝났다. node:http 에는 그런 기본 한도가 없다.
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

export interface JsonResponse {
  status: number;
  text: string;
}

/** 마감에 걸리면 signal.reason(AbortSignal.timeout 이면 name 이 TimeoutError)으로 거절한다.
 * 호출부가 fetch 때와 같은 방식으로 시간 초과를 가려 사용자가 고칠 값을 말할 수 있다. */
export function postJson(url: string, body: unknown, signal: AbortSignal): Promise<JsonResponse> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const fail = (e: unknown) => reject(signal.aborted ? signal.reason : e);
    const u = new URL(url);
    const payload = JSON.stringify(body);
    const req = (u.protocol === "https:" ? httpsRequest : httpRequest)(
      u,
      {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
        signal,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", fail);
        res.on("close", () => {
          if (!res.complete) fail(new Error(`${u.pathname}: 응답이 끝나기 전에 연결이 끊겼다`));
        });
      },
    );
    req.on("error", fail);
    req.end(payload);
  });
}
