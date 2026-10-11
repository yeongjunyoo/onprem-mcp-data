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

// stdio 전송. MCP 의 stdio 는 한 줄에 JSON-RPC 메시지 하나다(줄바꿈 구분).
//
// air 0.5.2 의 자체 stdio 전송(protocol/stdio-transport.js)은 LSP 처럼 `Content-Length:` 머리로 메시지를 나눈다.
// 줄로 보내는 MCP 클라이언트(Inspector, Claude Desktop, SDK)의 요청은 끝내 읽지 않고, 응답 앞에는 머리 줄을 붙인다.
// 2026-10-11 실측: Inspector 2.8.0 CLI 의 initialize 가 25초 기다리다 exit 4(unreachable)로 끝났고, 머리를 붙여
// 보낸 요청에만 `Content-Length: 234` 머리가 붙은 응답이 왔다.
//
// 그래서 줄 나누기는 MCP SDK 의 StdioServerTransport(main 이 쓰던 것)가 하고, 메시지 처리는 air 엔진이 한다.
// 엔진으로 가는 공개 입구는 server.fetch 하나다(air 가 Workers 용으로 내놓은 것). 상류 전송이 줄 구분이 되면 이
// 파일을 지우고 server.start() 로 돌아간다.
import { onShutdown, type AirServer } from "@airmcp-dev/core";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

export async function serveStdio(server: AirServer): Promise<void> {
  const handle = server.fetch;
  if (!handle) throw new Error("air 서버에 fetch 입구가 없다. stdio 전송을 붙일 수 없다.");

  // stdout 은 JSON-RPC 전용이다. air 의 stdio 기동이 하던 대로 console.log 를 stderr 로 돌리고 같은 기동 줄을 남긴다.
  console.log = (...args: unknown[]) => console.error(...args);
  console.error(`[air] Starting "${server.name}" (stdio transport, ${server.tools().length} tools)`);

  const transport = new StdioServerTransport();
  transport.onmessage = (message: JSONRPCMessage) => {
    void (async () => {
      // 같은 프로세스 안의 함수 호출이다. 소켓을 열지 않는다(주소는 Request 를 만드는 데만 쓴다).
      const res = await handle(
        new Request("http://localhost/", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(message) }),
      );
      // 요청에만 답한다. 알림과 클라이언트의 응답에는 답하지 않는다.
      if ("method" in message && "id" in message) await transport.send((await res.json()) as JSONRPCMessage);
    })().catch((e) => console.error(`[stdio] ${e instanceof Error ? e.message : String(e)}`));
  };
  onShutdown(() => transport.close());
  await transport.start();
}
