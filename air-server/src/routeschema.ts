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

// route 도구의 출력 계약. 스키마와 출력을 한 파일이 만든다.
//
// air 는 outputSchema 의 shape 만 SDK 에 넘기고, SDK 는 그것을 추가 필드를 금지하는 JSON Schema
// 로 공개한다. 그래서 출력에 스키마에 없는 필드가 하나라도 있으면 엄격한 클라이언트가 결과를
// 거부한다. 2026-09-30 MCP Inspector 2.8(SDK v2)로 여덟 도구를 불러 보니 route 만 「data must
// NOT have additional properties」로 실패했다 — 감사 필드(graph_plan, entity_signals,
// entity_lexicon 등)가 늘어나는 동안 스키마는 여덟 칸에 머물러 있었다. 원시 JSON-RPC 로 부르는
// 검사(verify-stdio-tools)는 출력 검증을 거치지 않아 몰랐다.
//
// 출력을 만드는 함수와 스키마를 여기 함께 두고, semroute.test 가 출력이 스키마를 통과하는지
// 확인한다. 필드를 더하면 스키마도 같이 더해야 테스트가 지나간다.
import { z } from "zod";
import { audit, type RouteDecision } from "./router.js";
import { semanticState } from "./semroute.js";
import { routerOntologyState } from "./routerinit.js";

const signals = (what: string) => z.array(z.string()).describe(what);

export const ROUTE_OUTPUT_SCHEMA = {
  route: z.string().describe("structured | semantic | graph | hybrid"),
  lane: z.string().describe("사람이 읽는 레인 이름"),
  // 배열은 배열로 선언한다. 종전에는 넷 다 `type: "object"` 였고, MCP 출력 검증이
  // "Expected object, received array" 로 도구 호출 자체를 거부했다.
  tools: z.array(z.string()).describe("호출할 도구 이름 목록"),
  structured_signals: signals("관계형 레인을 고르게 한 어휘"),
  semantic_signals: signals("의미 검색 레인을 고르게 한 어휘"),
  graph_signals: signals("그래프 레인을 고르게 한 어휘"),
  document_signals: signals("문서 레인을 고르게 한 어휘"),
  entity_signals: signals("질문에서 찾은 개체 신호"),
  graph_plan: z
    .object({
      relTypes: z.array(z.string()),
      aggregate: z.enum(["source", "target"]).optional(),
      // 「가장 적은」 집계면 asc(적은 쪽부터). 없으면 많은 쪽부터(router.ts buildGraphPlan).
      order: z.enum(["asc"]).optional(),
      filter: z.object({ side: z.enum(["source", "target"]), key: z.string(), value: z.string() }).optional(),
    })
    .nullable()
    .describe("그래프 레인이 탐색할 관계와 집계, 필터. 그래프가 아니면 null"),
  type_pair: z
    .object({ relation: z.string(), from: z.string(), to: z.string() })
    .nullable()
    .describe("온톨로지 타입쌍 추론 결과. 없으면 null"),
  rationale: z.string().describe("결정 근거 한 줄"),
  rule_scores: z
    .object({ nl2sql: z.number(), vector_search: z.number(), knowledge_graph: z.number() })
    .describe("규칙 신호의 도구별 가중 합"),
  rule_margin: z.number().describe("규칙이 고른 도구와 2위 도구의 점수 차"),
  rule_confident: z.boolean().describe("격차가 경계 이상이라 규칙이 결정했는가. false 면 시맨틱 폴백 차례"),
  semantic_fallback: z
    .object({ lane: z.string(), margin: z.number(), applied: z.boolean(), nearest_anchor: z.string() })
    .nullable()
    .describe("규칙이 확신하지 못했을 때 임베딩 앵커 비교 결과. 규칙이 결정했으면 null"),
  deterministic: z.boolean().describe("항상 true. 생성 모델을 부르지 않고, 같은 임베딩 모델이면 같은 결정"),
  entity_lexicon: z.number().describe("기동 때 적재한 온톨로지 개체 수. 0이면 타입쌍 추론 없이 돈다"),
  semantic_anchors: z.number().describe("임베딩해 둔 시맨틱 앵커 수. 0이면 규칙만 쓴다"),
};

/** route 도구가 돌려주는 값. 서버 핸들러와 테스트가 같은 함수를 부른다. */
export function routeToolOutput(d: RouteDecision) {
  return {
    ...audit(d),
    // 사전과 앵커가 적재됐는지 시연 중에 바로 보이게 한다. 0이면 폴백 경로다.
    entity_lexicon: routerOntologyState().entities,
    semantic_anchors: semanticState().anchors,
  };
}
