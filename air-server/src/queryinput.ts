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

// 질의를 받는 도구 여섯(route, retrieve, ask, audit.explain, vector.search, ontology.search)의 query 인자 계약.
//
// 빈 질문은 도구 입력 검증에서 거절한다. 종전에는 빈 문자열과 공백만 있는 질문이 그대로
// 파이프라인에 들어가, 라우터가 기본 fan-out(hybrid)을 고르고 7B 가 질문과 상관없는 SQL 을
// 만들어 그 결과로 부서장에 대한 거짓 문장을 답했다(2026-10-06 경계 실측 3/3). 물은 것이 없는데
// 답을 지어낸 것이다. 입력 검증에서 막으면 라우터도 DB 도 7B 도 부르지 않는다.
// vector.search 는 빈 질문을 임베딩해 pgvector 오류(vector must have at least 1 dimension)를, ontology.search 는
// 아무 표시 없이 ok 와 빈 hits 를 돌려줬다(2026-10-07 실측). 같은 안내 문장으로 맞춘다.
//
// 거절은 TC-040·041 의 인자 오류와 같은 길로 나간다. air 는 zod 스키마를 그대로 MCP SDK 에
// 넘기고, SDK 는 핸들러보다 먼저 이 스키마로 검증해 isError 로 돌려준다(Inspector exit 5).
// refine 은 JSON Schema 에 나타나지 않으므로 tools/list 의 입력 스키마는 바뀌지 않는다.
//
// 값은 바꾸지 않는다(트림하지 않는다). 감사 레코드의 query 는 받은 그대로여야 한다(TC-153 의
// query_length 2200 은 끝 공백까지 센 길이다).
import { z } from "zod";

export const EMPTY_QUERY_MESSAGE = "질문이 비어 있습니다. 회사 데이터에 대해 물을 내용을 입력해 주세요.";

/** air sanitizer 가 지우는 제어 문자(같은 범위)와 폭 없는 문자. 검증을 지나도 sanitizer 뒤에
 * 빈 문자열이 되면 같은 결함이 남으므로, 지운 뒤의 모습으로 판정한다. */
const INVISIBLE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F​-‍⁠﻿]/g;

/** 공백(전각 공백 포함)과 보이지 않는 문자만 있으면 빈 질문이다. */
export function isBlankQuery(q: string): boolean {
  return q.replace(INVISIBLE, "").trim().length === 0;
}

/** 도구 params 의 query 칸. 설명은 tools/list 에 종전 그대로 나간다. */
export function queryParam(description: string) {
  return z
    .string()
    .describe(description)
    .refine((q) => !isBlankQuery(q), { message: EMPTY_QUERY_MESSAGE });
}

/** 빠진 필수 인자의 검증 문장에 기대한 형을 남긴다. MCP SDK 1.30 부터 입력 검증 오류가 「<문장> at <경로>」 한 줄로 줄어
 * 나가는데, zod 3 의 빠진 인자 문장은 「Required」뿐이라 무엇이 와야 하는지가 화면에서 사라졌다(1.29 는 expected, received 가 든
 * 오류 목록을 그대로 보냈다. TC-042). 다른 오류 문장은 zod 기본 그대로다. zod 전역 설정이라 buildServer 가 건다. */
export function installInputErrorMessages(): void {
  z.setErrorMap((issue, ctx) =>
    issue.code === z.ZodIssueCode.invalid_type && issue.received === z.ZodParsedType.undefined
      ? { message: `Required (expected ${issue.expected}, received undefined)` }
      : { message: ctx.defaultError },
  );
}

/** audit.explain 의 format 칸. json 과 text 말고는 같은 입력 검증 길(-32602)로 거절한다. 종전에는 모르는 값(xml 등)을
 * 조용히 json 으로 돌려줬다(G17 ⑪). 값이 없으면 json 이다. tools/list 의 입력 스키마는 종전 그대로다. */
export function formatParam(description: string) {
  return z
    .string()
    .describe(description)
    .refine(
      (f) => f === "json" || f === "text",
      (f) => ({ message: `format 은 json(기본) 또는 text 만 받습니다. 받은 값: ${JSON.stringify(f)}` }),
    )
    .optional();
}
