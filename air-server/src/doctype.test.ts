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

// 문서 유형 꼬리표(tagDocument)와 질문 유형 분류(questionDocType) 단위 테스트. DB 도 모델도 쓰지 않는다.
// 질문 예문은 평가 문항에서 가져오지 않고 문서 유형과 섹션 구성을 보고 새로 썼다.
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DOC_TYPES, isDocType, questionDocType, tagDocument, type DocType } from "./doctype.js";

let pass = 0, fail = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { pass++; } else { fail++; console.error("  FAIL:", msg); }
}
function eq<T>(got: T, want: T, msg: string) {
  ok(JSON.stringify(got) === JSON.stringify(want), `${msg} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);
}
const TEST_AS_CI = process.env.TEST_AS_CI === "1";

// ── 문서 → 유형: 첫 제목과 섹션 구성 ─────────────────────────────────
const md = (heading: string, sections: string[]) =>
  [`# ${heading}`, "", ...sections.flatMap((s) => [s, "본문 한 줄.", ""])].join("\n");

const cases: [string, string, DocType][] = [
  ["장애 보고서", md("장애 보고서", ["## 기본 정보", "## 장애 내용", "## 원인 분석", "## 조치 사항", "## 복구 시간", "## 담당자"]), "incident_report"],
  ["회의록", md("회의록", ["## 기본 정보", "## 안건", "### 1. 일정 조정", "## 결정 사항", "## 다음 회의"]), "meeting_note"],
  ["제안서", md("Client-Z 대상 Product-Q9 도입 제안서", ["## 1. 고객 현황 분석", "## 2. 솔루션 제안", "## 3. 구축 계획", "## 4. 투자 비용", "## 5. 기대 효과"]), "proposal"],
  ["설치 가이드", md("Product-Q9 설치 가이드", ["## 시스템 요구사항", "## 설치 절차", "### 1단계: 의존성 설치", "### 2단계: 설정 파일 준비", "### 3단계: 서비스 시작", "### 4단계: 헬스체크"]), "technical_doc"],
  ["아키텍처 설계서", md("Product-Q9 아키텍처 설계서", ["## 시스템 아키텍처", "### 핵심 컴포넌트", "### 배포 환경", "### 보안"]), "technical_doc"],
  ["운영 매뉴얼", md("Product-Q9 운영 매뉴얼", ["## 일상 운영", "### 모니터링", "### 백업", "### 로그 관리", "### 업데이트"]), "technical_doc"],
  ["성능 튜닝 가이드", md("Product-Q9 성능 튜닝 가이드", ["## 성능 최적화", "### DB 최적화", "### 애플리케이션 최적화", "### 네트워크 최적화"]), "technical_doc"],
  ["API 레퍼런스", md("Product-Q9 API 레퍼런스", ["## API 엔드포인트", "### 인증", "### 주요 API", "### 에러 코드", "### Rate Limit"]), "technical_doc"],
];
for (const [name, text, want] of cases) {
  const t = tagDocument(text);
  eq(t.type, want, `${name}: 유형`);
  eq(t.basis, "heading+sections", `${name}: 첫 제목과 섹션 구성이 같은 유형을 가리킨다`);
}

{
  // 첫 제목과 섹션 구성이 다른 유형을 가리키면 꼬리표를 달지 않는다.
  const t = tagDocument(md("회의록", ["## 1. 고객 현황 분석", "## 2. 솔루션 제안", "## 3. 구축 계획"]));
  eq([t.type, t.basis, t.headingType, t.sectionType], [null, "conflict", "meeting_note", "proposal"], "충돌: 회의록 제목 + 제안서 섹션");
}
{
  // 한쪽만 판단할 수 있으면 그쪽으로 정하고, 무엇으로 정했는지 남긴다.
  eq([tagDocument("# 장애 보고서\n\n본문만 있다.").type, tagDocument("# 장애 보고서\n\n본문만 있다.").basis], ["incident_report", "heading"], "첫 제목만");
  const s = tagDocument("## 안건\n\n- 하나\n\n## 결정 사항\n\n- 둘\n");
  eq([s.type, s.basis], ["meeting_note", "sections"], "섹션 구성만(첫 제목 없음)");
  eq([tagDocument("# 메모\n\n## 할 일\n").type, tagDocument("# 메모\n\n## 할 일\n").basis], [null, "none"], "판단 근거 없음");
  // 고정 섹션이 하나뿐이면 섹션 구성으로 정하지 않는다(MIN_SECTIONS = 2).
  eq(tagDocument("# 메모\n\n## 안건\n").type, null, "고정 섹션 하나로는 정하지 않는다");
  // CRLF 원문도 같다.
  eq(tagDocument(cases[0][1].replace(/\n/g, "\r\n")).type, "incident_report", "CRLF 원문");
}

// ── 질문 → 유형 ───────────────────────────────────────────────────────
const qt = (q: string) => questionDocType(q).type;
const qb = (q: string) => questionDocType(q).basis;

// 유형 이름(문서 제목의 종류 말)이 한 유형만 가리키면 그 유형.
eq(qt("Product-Q9 설치 가이드 전체를 보여 줘"), "technical_doc", "설치 가이드");
eq(qt("Product-Q9 API 레퍼런스에 적힌 내용"), "technical_doc", "API 레퍼런스");
eq(qt("Client-Z 정기 미팅 회의록 요약"), "meeting_note", "회의록");
eq(qt("Client-Z 킥오프 때 합의한 것"), "meeting_note", "킥오프");
eq(qt("Client-Z 대상 제안서 요약"), "proposal", "제안서");
eq(qt("Client-Z에 제안했던 제품이 뭐야"), "proposal", "제안했던");
eq(qt("작년 장애 보고서 내용 정리"), "incident_report", "장애 보고서");
eq(qb("작년 장애 보고서 내용 정리"), "kind", "유형 이름으로 정했다");

// 유형 이름이 주제어를 이긴다. 「장애 대응 회의」는 회의록 제목이다.
eq(qt("Client-Z 장애 대응 회의에서 무엇을 정했어"), "meeting_note", "장애 대응 회의 → 회의록");
eq(qt("설치 가이드에서 장애 날 때 보는 항목"), "technical_doc", "가이드 + 장애 → 기술문서");

// 유형 이름이 둘 이상이면 거르지 않는다.
eq(qt("회의록하고 제안서 둘 다 보여 줘"), null, "유형 이름 둘");
eq(qb("회의록하고 제안서 둘 다 보여 줘"), "ambiguous", "유형 이름 둘 → ambiguous");

// 유형 이름이 없으면 그 유형에만 나오는 섹션 말로 정한다.
eq(qt("Product-Q9 커넥션 풀 최대값"), "technical_doc", "커넥션 풀 → 성능 튜닝 가이드");
eq(qt("Product-Q9 백업은 며칠 보관해"), "technical_doc", "백업 → 운영 매뉴얼");
eq(qt("Product-Q9 에러 코드 403 뜻"), "technical_doc", "에러 코드 → API 레퍼런스");
eq(qt("투자 회수까지 몇 달 걸린다고 했어"), "proposal", "투자 회수 → 제안서");
eq(qt("Client-Z 쪽 ROI 얼마로 잡았어"), "proposal", "ROI → 제안서");
eq(qt("그날 참석자 누구누구야"), "meeting_note", "참석자 → 회의록");
eq(qt("심각도 Critical 이었던 건 원인"), "incident_report", "심각도, 원인 → 장애 보고서");
eq(qb("심각도 Critical 이었던 건 원인"), "topic", "섹션 말로 정했다");

// 제안서의 상투구 「장애 대응 시간 N% 단축」 안의 「장애」는 장애 보고서 말이 아니다.
eq(qt("장애 대응 시간 몇 퍼센트 줄어든다고 했어"), "proposal", "장애 대응 시간 → 제안서");
// 같은 질문에 장애 보고서 말이 따로 있으면 두 유형이 걸려 거르지 않는다.
eq(qt("장애 대응 시간이랑 실제 복구 시간 비교"), null, "장애 대응 시간 + 복구 → 거르지 않음");

// 두 유형의 섹션 말이 함께 걸리면 거르지 않는다.
eq(qt("백업에서 복구하는 순서"), null, "백업(기술문서) + 복구(장애 보고서)");
eq(qt("업데이트하고 나서 재발한 문제"), null, "업데이트 + 재발");

// 여러 유형에 나오는 말만 있으면 거르지 않는다.
for (const q of ["모니터링 어떻게 해", "보안 어떻게 돼", "성능 개선 방법", "API 응답이 느려", "헬스체크 주기", "Product-Q9 가격", "직원 몇 명이야", "에러 발생하면 어떻게 해"]) {
  eq(qt(q), null, `거르지 않음: ${q}`);
}

// 시스템에 하는 부탁(「제안해 줘」, 「가이드해 줘」)과 「회의적」, 「로그인」은 유형 말이 아니다.
eq(qt("성능 개선 방법 좀 제안해 줘"), null, "제안해 줘 → 거르지 않음");
eq(qt("처음 쓰는 사람한테 가이드해 줘"), null, "가이드해 줘 → 거르지 않음");
eq(qt("그 계획에 회의적인 의견"), null, "회의적 → 회의 아님");
eq(qt("로그인이 안 돼"), null, "로그인 → 로그 아님");

// 걸린 말을 감사용으로 남긴다.
{
  const r = questionDocType("Client-Z 장애 대응 회의 안건");
  ok(r.cues.some((c) => c.kind && c.type === "meeting_note" && c.word === "회의"), "걸린 유형 이름이 남는다");
  ok(r.cues.some((c) => !c.kind && c.type === "incident_report" && c.word === "장애"), "걸린 섹션 말도 남는다");
}

// 결정론: 같은 질문은 같은 결과.
{
  const q = "Product-Q9 롤백 절차와 블루/그린 배포";
  const first = JSON.stringify(questionDocType(q));
  ok(Array.from({ length: 20 }, () => JSON.stringify(questionDocType(q))).every((x) => x === first), "결정론: 20회 동일");
  eq(qt(q), "technical_doc", "롤백, 블루/그린 → 기술문서");
}

eq([...DOC_TYPES], ["incident_report", "technical_doc", "meeting_note", "proposal"], "유형 넷");
ok(isDocType("proposal") && !isDocType("policy") && !isDocType(null), "isDocType");

// ── 사업자 문서 40건 — 데이터셋이 있을 때만 ──────────────────────────
//
// 꼬리표는 원문의 첫 제목과 섹션 구성으로 정한다. 사업자 index.json 의 유형은 그 결과를 대조하는 데만 쓴다.
// 데이터셋은 배포 조건상 저장소에 없다(datasets/MANIFEST.md). 없으면 건너뛴다.
{
  const here = dirname(fileURLToPath(import.meta.url));
  const dir = resolve(here, "../../datasets/companyx-v1.0/documents");
  if (!TEST_AS_CI && existsSync(resolve(dir, "index.json"))) {
    const index = JSON.parse(readFileSync(resolve(dir, "index.json"), "utf8")) as { id: string; type: string; filename: string }[];
    const tags = index.map((e) => ({ e, t: tagDocument(readFileSync(resolve(dir, e.filename), "utf8")) }));
    eq(tags.length, 40, "사업자 문서 40건");
    eq(tags.filter(({ t }) => t.type === null).map(({ e }) => e.id), [], "꼬리표를 못 단 문서 없음");
    eq(tags.filter(({ e, t }) => t.type !== e.type).map(({ e }) => e.id), [], "꼬리표가 사업자 index.json 유형과 같다");
    eq(tags.filter(({ t }) => t.basis !== "heading+sections").map(({ e }) => e.id), [], "40건 모두 첫 제목과 섹션 구성이 같은 유형을 가리킨다");
    const counts = Object.fromEntries(DOC_TYPES.map((d) => [d, tags.filter(({ t }) => t.type === d).length]));
    eq(counts, { incident_report: 10, technical_doc: 10, meeting_note: 10, proposal: 10 }, "유형별 10건");
  }
}

console.log(`\ndoctype.test: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
