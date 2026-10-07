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

// prompts/get 이 받은 인자를 버리던 결함의 우회. 상류(@airmcp-dev/core)가 고쳐지면 이 파일을 지운다.
//
// air 0.3.0 은 프롬프트를 MCP SDK 에 `server.prompt(name, description, cb)` 로 등록한다. 인자 스키마가
// 없는 이 오버로드는 SDK 에서 「인자 없는 프롬프트」다. 그래서 prompts/list 는 arguments 를 싣지 않고,
// prompts/get 은 받은 arguments 를 버린 채 cb(extra) 를 부른다. 질문을 넣어 불러도 템플릿의 질문
// 칸이 늘 비어 있었다(2026-10-06 MCP 서버 시험 R19). air 가 쥔 McpServer 는 private 이라 밖에서
// 다시 등록할 수 없다(docs/roadmap.md 「상류에 열려 있는 것」).
//
// 그래서 SDK 의 prompt() 를 한 번 감싼다. 우리가 인자를 선언한 프롬프트가 그 세 인자 형태로 등록될
// 때만, 선언(definePrompt 의 arguments)으로 만든 인자 스키마를 끼워 SDK 의 네 인자 형태로 넘긴다.
// 그러면 SDK 가 목록에 arguments 를 싣고, get 에서 필수 인자를 검사한 뒤 값을 cb 에 넘긴다.
// 다른 호출은 손대지 않는다.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

interface DeclaredArg {
  name: string;
  description?: string;
  required?: boolean;
}

const DECLARED = new Map<string, DeclaredArg[]>();
let wrapped = false;

function argsShape(args: DeclaredArg[]) {
  return Object.fromEntries(
    args.map((a) => {
      const s = a.description ? z.string().describe(a.description) : z.string();
      return [a.name, a.required ? s : s.optional()];
    }),
  );
}

/** 프롬프트 정의를 그대로 돌려주고, 선언한 인자가 MCP 로 오가게 한다. */
export function exposeArguments<T extends { name: string; arguments?: DeclaredArg[] }>(prompts: T[]): T[] {
  for (const p of prompts) if (p.arguments?.length) DECLARED.set(p.name, p.arguments);
  if (!wrapped) {
    wrapped = true;
    const proto = McpServer.prototype as unknown as { prompt: (...a: unknown[]) => unknown };
    const sdkPrompt = proto.prompt;
    proto.prompt = function (this: McpServer, ...a: unknown[]) {
      const declared = DECLARED.get(a[0] as string);
      if (declared && a.length === 3 && typeof a[1] === "string" && typeof a[2] === "function") {
        return sdkPrompt.call(this, a[0], a[1], argsShape(declared), a[2]);
      }
      return sdkPrompt.apply(this, a);
    };
  }
  return prompts;
}
