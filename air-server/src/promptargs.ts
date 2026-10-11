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

// prompts/get 이 받은 인자를 검사하는 스키마. 선언(definePrompt 의 arguments)에서 만든다.
//
// air 0.3.0 은 프롬프트를 인자 스키마 없는 SDK 오버로드로 등록해 받은 인자를 버렸고(2026-10-06 MCP 서버 시험 R19),
// 그때는 이 파일이 SDK 의 prompt() 를 감싸 이 스키마를 끼워 넣었다. air 0.5.2 엔진은 선언한 인자를 목록에 싣고
// 핸들러에 그대로 넘기지만 필수 인자를 검사하지 않는다. 그래서 mcpcompat.ts 의 prompts/get 이 이 스키마로
// main 과 같은 검사와 같은 오류 문장(「Invalid arguments for prompt …」)을 낸다.
import { z } from "zod";
import { isBlankQuery } from "./queryinput.js";

interface DeclaredArg {
  name: string;
  description?: string;
  required?: boolean;
}

/** 필수 인자는 빈 값(공백, 보이지 않는 문자뿐)도 빠진 인자처럼 거절한다. 도구의 빈 질문과 같은 판정이다(queryinput.ts). 종전에는
 * question="" 를 받아 질문 칸이 빈 템플릿을 돌려줬다(랜덤 테스트 사전 점검 3차 X04). describe 는 refine 뒤에 건다. 인자 스키마의
 * description 이 refine 이 감싼 바깥에 없으면 설명이 빠진다. */
export function promptArgsShape(args: DeclaredArg[]) {
  return Object.fromEntries(
    args.map((a) => {
      const s = a.required
        ? z.string().refine((v) => !isBlankQuery(v), { message: `${a.name} 인자가 비어 있습니다. 내용을 넣어 주세요.` })
        : z.string();
      const described = a.description ? s.describe(a.description) : s;
      return [a.name, a.required ? described : described.optional()];
    }),
  );
}
