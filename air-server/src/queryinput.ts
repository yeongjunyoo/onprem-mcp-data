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

/** 도구가 받은 질문을 사전, 기간 검사, 금액 해석이 기대하는 꼴로: 유니코드 NFC, 전각 ASCII(！~～)와 전각 공백을 반각으로, 폭 없는
 * 문자 제거. NFD 로 풀어 쓴 「영업팀 직원은 몇 명이야?」에 「안진우」, 전각 「２０２５년 매출 합계는?」에 3분기 값을 답했고, 사이에 폭 없는
 * 공백이 든 「Client-​A」는 찾지 못했다(랜덤 테스트 사전 점검 4차 P15). NFKC 는 자모 나열(「ㅁㄴㅇㄹ」)의 호환 자모까지 바꾸므로
 * 쓰지 않는다. 이미 NFC 반각인 질문은 그대로다. */
export function normalizeQuery(q: string): string {
  return q
    .normalize("NFC")
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/　/g, " ")
    .replace(/[​-‍⁠﻿]/g, "");
}

/** 질문과 SQL 인자의 상한(문자열 길이). air sanitizer 의 기본 상한과 같은 값이다. 종전에는 sanitizer 가 넘는 부분을 말없이 잘라
 * 다른 질의를 실행했다: 11,963자 SELECT 는 사실과 다른 문법 오류, 공백을 채운 10,101자 SELECT 는 앞 10,000자만 실행해 다른 값
 * (랜덤 테스트 사전 점검 3차 G20, G24, 3/3). 이제 넘으면 입력 검증에서 거절하고 sanitizer 는 자르지 않는다(server.ts). */
export const MAX_INPUT_CHARS = 10_000;

const n = (v: number) => v.toLocaleString("en-US");

/** 도구 params 의 query 칸. 설명은 tools/list 에 종전 그대로 나간다. */
export function queryParam(description: string) {
  return z
    .string()
    .describe(description)
    .refine((q) => !isBlankQuery(q), { message: EMPTY_QUERY_MESSAGE })
    .refine(
      (q) => q.length <= MAX_INPUT_CHARS,
      (q) => ({
        message: `질문이 너무 깁니다(${n(q.length)}자). ${n(MAX_INPUT_CHARS)}자 이하로 입력해 주세요. 잘라서 처리하면 다른 질문이 되므로 처리하지 않았습니다.`,
      }),
    );
}

/** sql.query 의 sql 칸. 길이만 본다(빈 SQL 과 쓰기 문장은 종전처럼 실행 단계의 가드가 거절한다). tools/list 의 입력 스키마는 종전 그대로다. */
export function sqlParam(description: string) {
  return z
    .string()
    .describe(description)
    .refine(
      (s) => s.length <= MAX_INPUT_CHARS,
      (s) => ({
        message: `SQL 이 너무 깁니다(${n(s.length)}자). ${n(MAX_INPUT_CHARS)}자 이하로 입력해 주세요. 잘라서 실행하면 다른 질의가 되므로 실행하지 않았습니다.`,
      }),
    );
}

/** retrieve 와 ask 의 budget 칸(큐레이터 토큰 예산). 1 이상의 정수만 받고, 아니면 같은 입력 검증 길(-32602)로 거절한다. 종전에는
 * -1 과 0.5 를 그대로 받아 근거 후보를 모두 버린 빈 컨텍스트를 돌려주고 ask 는 「알 수 없습니다」라고 답했다(랜덤 테스트 사전 점검
 * 3차 F20, F21, X01, 3/3). 값이 없으면 기본(1024)이다. tools/list 의 입력 스키마는 종전 그대로다. */
export function budgetParam(description: string) {
  return z
    .number()
    .describe(description)
    .refine(
      (b) => Number.isInteger(b) && b >= 1,
      (b) => ({ message: `budget 은 1 이상의 정수(토큰 수)만 받습니다. 기본은 1024 입니다. 받은 값: ${JSON.stringify(b) ?? String(b)}` }),
    )
    .optional();
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
