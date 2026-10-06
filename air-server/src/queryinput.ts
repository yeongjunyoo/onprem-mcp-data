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
