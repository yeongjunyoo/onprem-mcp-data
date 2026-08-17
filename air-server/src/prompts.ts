// MCP prompts — 호스트가 그대로 꺼내 쓸 수 있는 재사용 템플릿.
//
// 왜 필요한가. 이 서버의 답변 품질은 프롬프트에 크게 의존하는데, 지금까지 그
// 프롬프트는 코드 안에만 있었다. 호스트(사용자)가 같은 데이터를 자기 방식으로
// 쓰고 싶을 때 참고할 것이 없고, 심사자는 우리가 모델에게 실제로 무엇을
// 요구하는지 볼 수 없다. 프롬프트를 표면으로 올리면 둘 다 해결된다.
//
// 원칙: 여기 있는 템플릿은 코드가 쓰는 것과 같은 규칙을 담는다. 홍보용 문구를
// 새로 만들지 않는다.
import { definePrompt } from "@airmcp-dev/core";

// 노출본을 손으로 베끼지 않는다. 실행 경로가 쓰는 바로 그 함수를 부른다.
import { buildAnswerPrompt } from "./llm.js";
import { buildCompanyxSqlPrompt } from "./nl2sql.js";

import { profile } from "./profile.js";

export function buildPrompts() {
  return [
    definePrompt({
      name: "grounded-answer",
      description:
        "큐레이션된 컨텍스트만 근거로 한국어 답변을 만드는 템플릿. 컨텍스트 밖 개체를 답에 넣지 않고, " +
        "근거가 없으면 모른다고 답하도록 지시한다. 서버의 ask 도구가 쓰는 규칙과 같다.",
      arguments: [
        { name: "question", description: "사용자 질문", required: true },
        { name: "context", description: "검색으로 모은 근거 묶음", required: true },
      ],
      // ask 도구가 실제로 쓰는 프롬프트를 그대로 돌려준다. 종전에는 여기에
      // 손으로 줄인 사본이 있었고, 실제에만 있던 언어 고정·그래프 트리플 해석·
      // SQL 결과 인용 규칙이 빠져 있었다. "서버가 쓰는 규칙과 같다" 는 설명이
      // 사실이 아니었던 것이다.
      handler: (args) => [
        {
          role: "user",
          content: buildAnswerPrompt(String(args.question ?? ""), String(args.context ?? "")),
        },
      ],
    }),

    definePrompt({
      name: "nl2sql-with-schema-card",
      description:
        "값 어휘까지 담은 스키마 카드를 주고 단일 읽기 전용 SQL을 생성하게 하는 템플릿. " +
        "이 카드의 유무가 정확도를 가른다는 것이 이 프로젝트의 실증 논지다(개발보고서 0.6, 0.10).",
      arguments: [{ name: "question", description: "자연어 질문", required: true }],
      // companyx NL2SQL 경로가 실제로 쓰는 프롬프트. 사본을 두면
      // "테이블은 반드시 companyx. 접두사" 같은 규칙이 조용히 빠진다.
      handler: (args) => [
        {
          role: "user",
          content: buildCompanyxSqlPrompt(String(args.question ?? "")),
        },
      ],
    }),

    definePrompt({
      name: "explain-routing",
      description:
        "라우터가 왜 그 레인을 골랐는지 설명하게 하는 템플릿. 라우팅 자체는 규칙 기반이라 " +
        "모델이 결정에 관여하지 않는다. 이 프롬프트는 결정을 사람에게 설명하는 용도다.",
      arguments: [
        { name: "question", description: "사용자 질문", required: true },
        { name: "routing", description: "route 도구가 반환한 결정과 감사 로그", required: true },
      ],
      handler: (args) => [
        {
          role: "user",
          content: [
            "아래는 규칙 기반 라우터가 내린 결정과 그 근거입니다. 사람이 읽을 수 있게 설명하세요.",
            "라우터는 LLM을 호출하지 않으므로, 결정을 지어내지 말고 주어진 근거만으로 설명합니다.",
            "",
            "[결정]",
            args.routing ?? "",
            "",
            `[질문] ${args.question ?? ""}`,
          ].join("\n"),
        },
      ],
    }),

    definePrompt({
      name: "review-generated-sql",
      description:
        "생성된 SQL을 스키마 카드와 대조해 검토하게 하는 템플릿. 실행 전에 사람이 확인하는 경로를 만든다.",
      arguments: [
        { name: "question", description: "원래 질문", required: true },
        { name: "sql", description: "검토할 SQL", required: true },
      ],
      handler: (args) => [
        {
          role: "user",
          content: [
            "아래 SQL이 질문에 맞는지 스키마와 대조해 검토하세요.",
            "특히 다음을 봅니다: 존재하지 않는 컬럼, 누락된 조인, 과도한 필터, 열거형 값 오용.",
            "",
            profile().schemaCard,
            "",
            `[질문] ${args.question ?? ""}`,
            `[SQL] ${args.sql ?? ""}`,
          ].join("\n"),
        },
      ],
    }),
  ];
}
