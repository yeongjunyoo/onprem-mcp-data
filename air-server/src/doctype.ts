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

// 문서 유형 — 문서마다 유형 꼬리표를 달고, 질문이 묻는 유형이 확실할 때만 문서 검색을 그 유형으로 좁힌다.
//
// 리원에이스 서면 답변(10-03, Q4): 같은 틀로 찍어 낸 문서 40건에서는 벡터 검색이 다른 유형의 같은 틀 문단을
// 끌어온다. 가장 직접적인 처방은 문서 유형을 메타데이터로 달고 질문의 유형으로 거른 뒤 벡터 검색을 돌리는 것이다.
//
// 두 함수 모두 결정론이다. 모델을 부르지 않고 임계값도 없다.
//   tagDocument     원문의 첫 제목과 섹션 구성으로 유형을 정한다. 둘이 다른 유형을 가리키면 꼬리표를 달지 않는다.
//   questionDocType 질문의 유형 말을 읽는다. 한 유형만 가리킬 때만 답하고, 아니면 거르지 않는다(null).
//
// 질문 쪽 낱말은 평가 문항이 아니라 문서에서 뽑았다. 유형 이름(문서 제목의 종류 말)과, 그 유형의 섹션 제목과 항목
// 이름 가운데 코퍼스에서 그 유형에만 나오는 말(문서 빈도로 확인)이다. 거르기는 되돌릴 수 없는 결정이라(걸러진 유형의
// 정답 문서는 검색에 다시 나타나지 않는다) 넓게 잡지 않고, 둘 이상의 유형이 걸리면 거르지 않는다.

export const DOC_TYPES = ["incident_report", "technical_doc", "meeting_note", "proposal"] as const;
export type DocType = (typeof DOC_TYPES)[number];

export function isDocType(v: unknown): v is DocType {
  return typeof v === "string" && (DOC_TYPES as readonly string[]).includes(v);
}

// ── 문서 → 유형 ───────────────────────────────────────────────────────

/** 기술문서는 다섯 갈래다. 꼬리표는 유형 하나만 달고, 갈래는 첫 제목과 섹션 구성이 서로 맞는지 볼 때만 쓴다. */
type Kind = "incident" | "meeting" | "proposal" | "install" | "architecture" | "operations" | "tuning" | "api";

const KIND_TYPE: Record<Kind, DocType> = {
  incident: "incident_report",
  meeting: "meeting_note",
  proposal: "proposal",
  install: "technical_doc",
  architecture: "technical_doc",
  operations: "technical_doc",
  tuning: "technical_doc",
  api: "technical_doc",
};

/** 첫 제목(# …)의 종류 말. 「# 장애 보고서」, 「# 회의록」, 「# Client-F 대상 Product-C1 도입 제안서」, 「# Product-C1 설치 가이드」. */
const HEADING_KINDS: [RegExp, Kind][] = [
  [/장애\s*보고서/, "incident"],
  [/회의록/, "meeting"],
  [/제안서/, "proposal"],
  [/설치\s*가이드/, "install"],
  [/아키텍처\s*설계서/, "architecture"],
  [/운영\s*매뉴얼/, "operations"],
  [/튜닝\s*가이드/, "tuning"],
  [/API\s*레퍼런스/i, "api"],
];

/** 갈래마다 고정된 섹션 제목(##, ###). 번호(「1. 」, 「1단계: 」)는 떼고 비교한다. 두 갈래가 공유하는 「기본 정보」는 넣지 않는다. */
const SECTION_SIGNATURES: Record<Kind, string[]> = {
  incident: ["장애 내용", "원인 분석", "조치 사항", "복구 시간", "담당자"],
  meeting: ["안건", "결정 사항", "다음 회의"],
  proposal: ["고객 현황 분석", "솔루션 제안", "구축 계획", "투자 비용", "기대 효과"],
  install: ["시스템 요구사항", "설치 절차", "의존성 설치", "설정 파일 준비", "서비스 시작", "헬스체크"],
  architecture: ["시스템 아키텍처", "핵심 컴포넌트", "배포 환경", "보안"],
  operations: ["일상 운영", "모니터링", "백업", "로그 관리", "업데이트"],
  tuning: ["성능 최적화", "DB 최적화", "애플리케이션 최적화", "네트워크 최적화"],
  api: ["API 엔드포인트", "인증", "주요 API", "에러 코드", "Rate Limit"],
};

/** 섹션 구성으로 정하려면 그 갈래의 고정 섹션이 이만큼은 있어야 한다. 갈래마다 고정 섹션이 3~6개다. */
const MIN_SECTIONS = 2;

export interface DocTag {
  type: DocType | null;
  /** 무엇으로 정했나: heading+sections(둘이 같은 유형), heading(섹션 구성이 판단을 못 함), sections(첫 제목이 판단을 못 함). */
  basis: "heading+sections" | "heading" | "sections" | "conflict" | "none";
  heading: string;
  headingType: DocType | null;
  sectionType: DocType | null;
}

const normSection = (s: string) =>
  s
    .replace(/^\s*(?:\d+\s*단계\s*[:：.]\s*|\d+\s*[.)]\s*)/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

/** 원문 Markdown 의 첫 제목과 섹션 구성으로 문서 유형을 정한다. 둘이 다른 유형을 가리키면 type 은 null 이다. */
export function tagDocument(markdown: string): DocTag {
  const lines = markdown.split(/\r?\n/);
  const heading = (lines.find((l) => /^#\s+/.test(l)) ?? "").replace(/^#\s+/, "").trim();
  const headingKind = HEADING_KINDS.find(([re]) => re.test(heading))?.[1];
  const headingType = headingKind ? KIND_TYPE[headingKind] : null;

  const sections = new Set(lines.filter((l) => /^#{2,3}\s+/.test(l)).map((l) => normSection(l.replace(/^#{2,3}\s+/, ""))));
  const scored = (Object.keys(SECTION_SIGNATURES) as Kind[])
    .map((k) => ({ k, n: SECTION_SIGNATURES[k].filter((s) => sections.has(normSection(s))).length }))
    .filter((x) => x.n >= MIN_SECTIONS)
    .sort((a, b) => b.n - a.n);
  const sectionKind = scored.length && (scored.length === 1 || scored[0].n > scored[1].n) ? scored[0].k : undefined;
  const sectionType = sectionKind ? KIND_TYPE[sectionKind] : null;

  if (headingType && sectionType) {
    return headingType === sectionType
      ? { type: headingType, basis: "heading+sections", heading, headingType, sectionType }
      : { type: null, basis: "conflict", heading, headingType, sectionType };
  }
  if (headingType) return { type: headingType, basis: "heading", heading, headingType, sectionType };
  if (sectionType) return { type: sectionType, basis: "sections", heading, headingType, sectionType };
  return { type: null, basis: "none", heading, headingType, sectionType };
}

// ── 질문 → 유형 ───────────────────────────────────────────────────────

interface Cue {
  type: DocType;
  re: RegExp;
}

/** 유형 이름. 문서 제목의 종류 말이다(「[장애보고]」, 「설치 가이드」, 「정기 미팅」, 「중간 점검」, 「도입 제안」).
 * 「제안해 줘」와 「가이드해 줘」는 시스템에 하는 부탁이라 유형 이름으로 보지 않는다. 「회의적」은 회의가 아니다. */
const KIND_CUES: Cue[] = [
  { type: "incident_report", re: /장애\s*보고|보고서/ },
  { type: "technical_doc", re: /기술\s*문서|가이드(?!\s*(?:해|좀))|매뉴얼|레퍼런스|설계서/ },
  { type: "meeting_note", re: /회의(?!적)|미팅|킥오프|중간\s*점검/ },
  { type: "proposal", re: /제안(?!\s*(?:해|좀))/ },
];

/** 유형마다 고유한 섹션 제목과 항목 이름. 코퍼스 40건에서 그 유형에만 나오는 말만 넣었다
 * (문서 빈도: 해당 유형 2건 이상, 다른 유형 0건). 「장애」는 예외다 — 제안서 「솔루션 제안」에 「장애 대응 시간 N% 단축」이
 * 상투구로 들어 있어서, 그 구절 안의 「장애」는 장애 보고서 말로 세지 않고 구절째 제안서 쪽 말로 센다.
 * 모니터링, 보안, 성능, 설정, 대응, 지연, API, 헬스체크처럼 두 유형 이상에 나오는 말은 넣지 않는다. 「발생」과 「조치」는
 * 장애 보고서에만 나오지만 「에러 발생」, 「보안 조치」처럼 다른 유형을 묻는 말에도 붙어서 항목 이름(발생일시, 조치 사항)으로만 센다. */
const TOPIC_CUES: Cue[] = [
  {
    type: "incident_report",
    re: /장애(?!\s*대응\s*시간)|원인|복구|재발|심각도|영향\s*범위|발생\s*일시|조치\s*사항|초기\s*대응|인증서|SSL/i,
  },
  {
    type: "technical_doc",
    re: new RegExp(
      [
        "설치", "요구\\s*사항", "의존성", "설정\\s*파일", "아키텍처", "컴포넌트", "마이크로\\s*서비스", "배포\\s*환경", "오토\\s*스케일",
        "백업", "로그(?!인)", "업데이트", "롤백", "블루\\s*/?\\s*그린", "튜닝", "(?:DB|애플리케이션|네트워크|성능)\\s*최적화",
        "커넥션\\s*풀", "connection\\s*pool", "인덱스", "JVM", "GC", "스레드\\s*풀", "keep-?alive", "gzip", "CDN",
        "엔드포인트", "토큰", "에러\\s*코드", "rate\\s*limit", "캐시", "mTLS", "RBAC", "Helm", "Docker", "Grafana", "ELK",
        "Redis", "RabbitMQ", "보관\\s*기간", "메트릭", "p99",
      ].join("|"),
      "i",
    ),
  },
  {
    type: "meeting_note",
    re: /참석|안건|결정\s*사항|다음\s*회의|마일스톤|스프린트|일정\s*(?:조정|연장)/,
  },
  {
    type: "proposal",
    re: /장애\s*대응\s*시간|투자\s*비용|구축\s*(?:계획|비)|운영\s*비|연간\s*총\s*비용|ROI|TCO|투자\s*회수|기대\s*효과|생산성|고객\s*현황|솔루션|도입|마이그레이션/i,
  },
];

export interface QuestionDocType {
  /** 거를 유형. 확실하지 않으면 null — 거르지 않는다. */
  type: DocType | null;
  /** kind: 유형 이름이 한 유형만 가리켰다. topic: 유형 이름은 없고 고유 낱말이 한 유형만 가리켰다.
   * ambiguous: 둘 이상의 유형이 걸렸다. none: 아무 말도 안 걸렸다. */
  basis: "kind" | "topic" | "ambiguous" | "none";
  /** 걸린 말. 감사 기록에 그대로 싣는다. */
  cues: { type: DocType; word: string; kind: boolean }[];
}

function hits(cues: Cue[], q: string, kind: boolean): QuestionDocType["cues"] {
  const out: QuestionDocType["cues"] = [];
  for (const c of cues) {
    const re = new RegExp(c.re.source, c.re.flags.includes("g") ? c.re.flags : c.re.flags + "g");
    for (const m of q.matchAll(re)) out.push({ type: c.type, word: m[0], kind });
  }
  return out;
}

/** 질문이 묻는 문서 유형. 유형 이름이 한 유형만 가리키면 그 유형(「Client-E 장애 대응 회의」는 회의록 — 이름이 주제어를 이긴다).
 * 유형 이름이 없으면 고유 낱말이 한 유형만 가리킬 때 그 유형. 그 밖에는 null 이다. */
export function questionDocType(query: string): QuestionDocType {
  const q = query.normalize("NFC");
  const kindHits = hits(KIND_CUES, q, true);
  const topicHits = hits(TOPIC_CUES, q, false);
  const cues = [...kindHits, ...topicHits];
  const kindTypes = [...new Set(kindHits.map((h) => h.type))];
  if (kindTypes.length === 1) return { type: kindTypes[0], basis: "kind", cues };
  if (kindTypes.length > 1) return { type: null, basis: "ambiguous", cues };
  const topicTypes = [...new Set(topicHits.map((h) => h.type))];
  if (topicTypes.length === 1) return { type: topicTypes[0], basis: "topic", cues };
  return { type: null, basis: topicTypes.length ? "ambiguous" : "none", cues };
}
