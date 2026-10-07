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

// 시맨틱 폴백 라우터 — 규칙이 확신하지 못한 질문만 임베딩 유사도로 도구를 고른다.
//
// 왜 키워드를 더 넣지 않는가. 홀드아웃 2차(구어체)의 오답 11건은 셋으로 갈렸다.
// 관계 질문인데 관계어가 없고(「깔려 있는 데」, 「끼고 있는 사람」), 정형 질문인데
// 집계어가 없고(「몇 군데」, 「인원수」), 문서 질문인데 문서 어휘가 없었다(「세팅」,
// 「사고 기록」). 단어를 하나씩 더하면 다음 표현에서 다시 빠진다. 의미 비교는
// 표현이 바뀌어도 같은 질문 유형을 잡는다(리원에이스 멘토링 09-22 제안).
//
// 구조는 규칙 우선이다. 규칙이 격차 RULE_MIN_MARGIN 이상으로 확신하면 이 모듈은
// 부르지도 않는다. 앵커는 도구별 질문 유형마다 같은 뜻의 다른 표현(구어체, 줄임말,
// 어순)을 5개씩 둔다. 유형은 실패 사례가 아니라 데이터 구조에서 뽑는다 — 테이블마다
// 집계와 조회, 문서 유형마다 섹션, 엣지 타입마다 한 유형. 결정은 최근접 앵커의 도구이고, 임베딩 모델이 같으면 같은
// 질문에 같은 결정이 나온다.
import type { Embedder } from "./embedder.js";
import { profile } from "./profile.js";
import {
  route,
  maskEntities,
  buildGraphPlan,
  tableOnlyNoun,
  documentCountRequest,
  LANES,
  SQL_TOOL,
  VECTOR_TOOL,
  ONTOLOGY_TOOL,
  GRAPH_TOOL,
  type Lane,
  type RouteDecision,
} from "./router.js";

/** 도구 → 질문 유형 → 표현들. 고유명은 타입 자리표시로 쓴다(maskEntities 와 같은 표기).
 * knowledge_graph 의 유형 이름은 엣지 타입이라 그래프 탐색 계획에 그대로 쓰인다. */
export const ROUTE_ANCHORS: Record<Lane, Record<string, string[]>> = {
  nl2sql: {
    region_sales: ["서울 매출 얼마야", "부산 쪽 장사 어때", "지역별로 매출 얼마씩 나왔어", "매출 제일 많이 나온 지역이 어디야", "경기에서 번 돈 총 얼마"],
    period_sales: ["지난 분기 매출 합계", "올해 매출 작년이랑 비교하면", "월별 매출 추이 보여줘", "2025년 3분기에 얼마 벌었어", "분기마다 매출 얼마씩이었는지"],
    product_sales: ["{제품} 얼마나 팔렸어", "{제품} 판매액 총 얼마", "제품별 매출 순위", "제일 잘 팔리는 제품이 뭐야", "카테고리별 판매 금액"],
    client_count: ["고객사 몇 군데야", "신규 고객 몇 곳 들어왔어", "업종별 고객 수", "대전 고객사 몇 개", "작년에 새로 등록한 거래처 수"],
    contract: ["계약 금액 큰 순으로 보여줘", "활성 계약 몇 건이야", "{고객사}랑 맺은 계약 총액", "해지된 계약 몇 개", "계약 유형별 건수"],
    employee_stats: ["직원 몇 명이야", "퇴사자 빼고 인원수", "부서별 평균 연봉", "연봉 제일 높은 사람", "올해 입사한 사람 몇 명"],
    ticket_stats: ["미해결 티켓 몇 건", "우선순위별 티켓 건수", "Critical 티켓 아직 안 닫힌 거", "제품별 문의 건수 세줘", "이번 달 접수된 지원 요청 수"],
    project_stats: ["프로젝트 예산 총액", "진행 중인 프로젝트 몇 개야", "예산 제일 큰 프로젝트", "상태별 프로젝트 수", "프로젝트 가장 많은 고객사"],
    product_catalog: ["{제품} 월 이용료 얼마야", "제품 가격표 보여줘", "보안 카테고리 제품 몇 개", "최근 출시된 제품 목록", "월정액 제일 비싼 제품"],
    // 집계가 아니라 행을 찾는 질문. 테이블마다 한 유형씩 둔다(속성 조회, 조건 목록).
    client_lookup: ["{고객사} 연락처 이름이랑 메일 줘", "제조업 고객사 명단", "{고객사} 어느 지역 회사야", "스타트업 규모 고객 목록", "고객사 업종이랑 지역 같이 뽑아줘"],
    employee_lookup: ["{직원} 입사일 언제야", "{직원} 직급 뭐야", "{직원} 이메일 주소 알려줘", "{부서} 직원 명단이랑 직급", "최근 입사자 목록"],
    ticket_lookup: ["{고객사} 티켓 언제 접수되고 언제 해결됐어", "{제품} 열린 티켓 제목들", "High 우선순위 티켓 목록", "티켓 상태가 closed 인 거", "{고객사}가 올린 티켓 내역"],
    project_lookup: ["보류 중인 프로젝트 이름만", "종료일 안 정해진 프로젝트", "{프로젝트} 예산 얼마야", "{프로젝트} 언제 시작했어", "계획 단계 프로젝트 목록"],
    contract_lookup: ["{고객사} 계약 언제 끝나", "{고객사} 계약 유형이 뭐야", "만료 예정 계약 목록", "시작일 순으로 계약 나열", "{고객사}랑 {제품} 계약 금액"],
  },
  vector_search: {
    install_setup: ["{제품} 설치 어떻게 해", "{제품} 어떻게 깔아", "{제품} 초기 세팅 뭐부터 해야 돼", "{제품} 설치할 때 필요한 사양", "개발 환경 세팅하는 법"],
    incident_cause: ["지난번 장애 원인이 뭐였어", "서버 다운됐던 사례 있어", "{고객사} 장애 났을 때 무슨 일이었어", "네트워크 문제로 생긴 사고 기록", "디스크 꽉 찼던 장애 보고서"],
    incident_response: ["장애 나면 어떻게 대응해", "복구 절차 알려줘", "재발 방지 대책 뭐였어", "DB 죽었을 때 조치 방법", "인증서 만료 장애 어떻게 해결했어"],
    tuning: ["{제품} 성능 튜닝 방법", "느릴 때 뭐 손봐야 돼", "쿼리 최적화 가이드", "메모리 설정 어떻게 잡아", "캐시 설정 권장값"],
    api_reference: ["API 인증 어떻게 해", "{제품} API 호출 방법", "토큰 갱신 어떻게 해", "엔드포인트 목록 알려줘", "API 요청 제한 있어"],
    architecture: ["{제품} 구조가 어떻게 돼", "{제품} 아키텍처 설명해줘", "시스템 구성도 있어", "컴포넌트끼리 어떻게 연결돼", "설계할 때 고려한 점"],
    operations: ["{제품} 운영할 때 주의할 점", "모니터링 알람 기준 어떻게 잡았어", "로그 어디서 봐", "정기 점검 항목 뭐야", "백업 주기 어떻게 돼"],
    meeting: ["{고객사} 미팅에서 뭐 얘기했어", "회의에서 나온 안건 정리", "지난 회의 결정사항", "일정 지연 얘기 나왔던 거", "킥오프 때 합의한 내용"],
    proposal: ["{고객사}한테 낸 제안서 내용", "도입 제안할 때 기대효과 뭐라고 했어", "마이그레이션 제안 요약", "제안서에 들어간 일정", "견적이랑 도입 범위 어떻게 제안했어"],
    policy: ["보안 정책 어떻게 돼", "개인정보 다룰 때 지켜야 할 원칙", "비밀번호 규정", "권한 요청 절차", "취약점 점검 기준"],
    // 특정 문서 한 건의 세부. 문서 유형 넷(장애 보고서, 기술문서, 회의록, 제안서)의
    // 섹션 제목이 곧 질문 유형이다. 날짜는 maskEntities 가 {날짜}로 가린다.
    incident_detail: ["{고객사} {날짜} {제품} 장애 원인이 뭐였대", "{날짜} 사고 복구까지 얼마나 걸렸어", "그 장애 때 조치한 내용", "장애 영향 범위 어디까지였어", "{제품} 터졌을 때 미리 못 잡은 이유"],
    techdoc_detail: ["{제품} 시스템 요구사항 뭐야", "{제품} 에러 코드 무슨 뜻이야", "{제품} 업데이트했다가 이전 버전으로 되돌리는 법", "{제품} 설정 파일 어디 둬", "{제품} 헬스체크 어떻게 해"],
    meeting_detail: ["{고객사} {날짜} 회의 참석자 누구였어", "그날 미팅에서 일정 얼마나 늘려주기로 했어", "{고객사} 정기 미팅 결정 사항", "다음 회의 언제로 잡았어", "킥오프 때 들어온 사람 이름"],
    proposal_detail: ["{고객사}에 {제품} 제안할 때 구축 기간 몇 주 잡았어", "제안서에 적은 초기 구축비", "제안한 투자 비용 얼마였어", "제안서의 고객 현황 분석", "제안서상 테스트랑 안정화 기간"],
  },
  knowledge_graph: {
    USES: ["{고객사} 뭐 쓰고 있어", "{고객사}가 도입한 제품", "{제품} 쓰는 고객사 어디어디야", "{제품} 깔린 데가 어디야", "{제품} 들어가 있는 고객 목록"],
    BELONGS_TO: ["{직원} 어느 팀이야", "{직원} 소속이 어디야", "{부서}에 누구누구 있어", "{부서} 사람들 보여줘", "{직원} 무슨 부서 사람이야"],
    HEAD_IS: ["{부서} 팀장 누구야", "{부서} 책임자가 누구", "{부서} 윗선이 누구야", "{부서} 누가 이끌어", "각 부서장 알려줘"],
    MANAGES_ACCOUNT: ["{고객사} 담당자 누구야", "{고객사} 창구가 누구", "{직원}이 맡은 고객사", "{직원} 담당 거래처 어디야", "고객 제일 많이 맡은 사람"],
    LEADS: ["{직원} 요즘 뭐 해", "{직원}이 맡은 프로젝트", "{직원} 무슨 건 하고 있어", "{프로젝트} 누가 맡고 있어", "{프로젝트} PM이 누구야"],
    HAS_PROJECT: ["{고객사} 프로젝트 뭐 있어", "{고객사}랑 진행 중인 과제", "{고객사} 쪽 일 뭐 하고 있어", "{프로젝트} 어느 고객 건이야", "{고객사} 관련 프로젝트 목록"],
    REPORTED_ISSUE: ["{제품} 말썽 많아?", "{제품} 문제 자주 생겨?", "{제품} 이슈 올린 고객사", "이슈 제일 많은 제품", "{고객사}가 문제 제기한 제품"],
  },
};

/** 1위 도구와 2위 도구의 최근접 유사도 차가 이 값 미만이면 시맨틱도 확신이 없는
 * 것으로 보고, 규칙의 넓은 fan-out 을 그대로 둔다. 값의 근거는 RULE_MIN_MARGIN 과
 * 같은 경계 실측이다. */
export const SEMANTIC_MIN_MARGIN = 0.02;

interface AnchorVec {
  lane: Lane;
  type: string;
  text: string;
  vec: number[];
}

let ANCHORS: AnchorVec[] = [];
let EMBEDDER_NAME = "";

export function semanticReady(): boolean {
  return ANCHORS.length > 0;
}

export function semanticState(): { anchors: number; embedder: string } {
  return { anchors: ANCHORS.length, embedder: EMBEDDER_NAME };
}

/** 기동 시 1회. 앵커를 임베딩해 둔다. 실패하면 비워 두고 규칙만으로 돈다. */
export async function installSemanticRouter(embedder: Embedder): Promise<{ anchors: number; error?: string }> {
  const out: AnchorVec[] = [];
  try {
    for (const lane of LANES) {
      for (const [type, texts] of Object.entries(ROUTE_ANCHORS[lane])) {
        for (const text of texts) out.push({ lane, type, text, vec: await embedder.embed(text) });
      }
    }
  } catch (e) {
    // 실패는 error 필드로 돌려준다. 기동 경로(index.ts)가 그것을 경고로 찍고, route
    // 도구 응답의 semantic_anchors 가 0으로 남아 시연 중에도 보인다.
    ANCHORS = [];
    EMBEDDER_NAME = "";
    return { anchors: 0, error: String(e).slice(0, 200) };
  }
  ANCHORS = out;
  EMBEDDER_NAME = embedder.name;
  return { anchors: ANCHORS.length };
}

/** 테스트용. 설치 상태를 비운다. */
export function uninstallSemanticRouter(): void {
  ANCHORS = [];
  EMBEDDER_NAME = "";
}

function dot(a: number[], b: number[]): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

/** 도구별 최근접 앵커 유사도. 임베더 출력은 L2 정규화돼 있으므로 내적 = 코사인이다. */
export async function semanticVerdict(query: string, embedder: Embedder): Promise<NonNullable<RouteDecision["semantic"]> | null> {
  if (!ANCHORS.length) return null;
  const q = await embedder.embed(maskEntities(query.trim()));
  const best = new Map<Lane, { score: number; a: AnchorVec }>();
  for (const a of ANCHORS) {
    const score = dot(q, a.vec);
    const cur = best.get(a.lane);
    if (!cur || score > cur.score) best.set(a.lane, { score, a });
  }
  const scores = Object.fromEntries(LANES.map((l) => [l, best.get(l)?.score ?? -1])) as Record<Lane, number>;
  // 동점이면 LANES 순서로 고정한다(결정론).
  const ranked = [...LANES].sort((x, y) => scores[y] - scores[x]);
  const top = best.get(ranked[0])!;
  return {
    lane: ranked[0],
    margin: scores[ranked[0]] - scores[ranked[1]],
    scores,
    nearest: { lane: top.a.lane, type: top.a.type, text: top.a.text, score: top.score },
    applied: false,
  };
}

const TOOLS_OF: Record<Lane, { route: RouteDecision["route"]; tools: string[] }> = {
  nl2sql: { route: "structured", tools: [SQL_TOOL] },
  vector_search: { route: "semantic", tools: [VECTOR_TOOL] },
  knowledge_graph: { route: "graph", tools: [ONTOLOGY_TOOL, GRAPH_TOOL] },
};

/** 규칙 → (확신 없으면) 시맨틱 순으로 도구를 정한다. 서버와 파이프라인은 이것을 부른다.
 *
 * 시맨틱이 없거나(임베딩 모델 미가동, 오프라인 테스트) 시맨틱도 박빙이면 규칙의
 * 결정을 그대로 돌려준다. 어느 경우든 audit 에 무엇이 결정했는지 남는다. */
export async function routeQuery(query: string, embedder?: Embedder): Promise<RouteDecision> {
  const d = route(query);
  // 문서 개수 질문은 문서 제목으로 센다(router.ts documentCountRequest, pipeline.ts documentCount). 조각 상위 k 개를 읽는
  // 벡터 레인도, 문서 표가 없는 정형 레인도 문서 수를 셀 수 없어 규칙 점수와 시맨틱 폴백으로 레인을 고르지 않는다. 제목의
  // 종류 꼬리표는 Company-X 문서의 규약이라 그 프로파일에서만 쓴다.
  const docCount = profile().name === "companyx" ? documentCountRequest(query.trim()) : undefined;
  if (docCount) {
    const what = `${docCount.entity ? `${docCount.entity} ` : ""}${docCount.kind}`;
    return { ...d, route: "semantic", tools: [VECTOR_TOOL], graphPlan: undefined, rationale: `document count (${what}) -> count document titles`, docCount };
  }
  if (d.gate.confident || !embedder || !semanticReady()) return d;
  const v = await semanticVerdict(query, embedder);
  if (!v) return d;
  if (v.margin < SEMANTIC_MIN_MARGIN) return { ...d, semantic: v };
  // 계약, 티켓, 장애처럼 그래프에 관계로 없는 항목을 묻는 질문은 그래프 앵커(「고객 제일 많이 맡은 사람」)가 가까워도
  // 그래프로 보내지 않는다. 그래프에는 그 답이 없어 맡은 고객사 수 순위가 답이 됐다(랜덤 테스트 사전 점검 2차 R1).
  // 규칙의 결정을 그대로 둔다(시맨틱도 확신이 없을 때와 같다).
  const noun = v.lane === "knowledge_graph" ? tableOnlyNoun(query.trim()) : undefined;
  if (noun) {
    return {
      ...d,
      rationale: `${d.rationale}; semantic knowledge_graph not applied (anchor "${v.nearest.text}", margin ${v.margin.toFixed(3)}): table noun ${noun} has no graph edge`,
      semantic: v,
    };
  }
  const t = TOOLS_OF[v.lane];
  const superlative = d.structuredHits.includes("superlative");
  // 그래프로 넘길 때 탐색할 엣지: 규칙의 타입쌍 추론이 있으면 그것을, 없으면 최근접
  // 앵커의 유형(= 엣지 타입)을 쓴다.
  const rel = d.typePair?.relation ?? (v.nearest.lane === "knowledge_graph" ? v.nearest.type : undefined);
  return {
    ...d,
    route: t.route,
    tools: t.tools,
    graphPlan: v.lane === "knowledge_graph" ? buildGraphPlan(query.trim(), rel ? [rel] : [], superlative) : undefined,
    rationale: `rule margin ${d.gate.margin} < gate; semantic ${v.lane} (anchor "${v.nearest.text}", margin ${v.margin.toFixed(3)})`,
    semantic: { ...v, applied: true },
  };
}
