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

// 근거 단위(evidence.ts) 테스트. DB 도 모델도 없이 돈다. 제목은 사업자 문서와 같은 꼴로 지어낸 것이다(데이터셋을 싣지 않는다).
import type { Pool } from "pg";

import { askedDate, asksAcrossDocuments, chooseSections, chunkText, docTitle, documentOf, namedDocument, sectionUnits, type DocChunk } from "./evidence.js";
import { curate } from "./curator.js";
import { estTokens } from "./text.js";
import { retrieve } from "./pipeline.js";
import type { Embedder } from "./embedder.js";

let pass = 0, fail = 0;
function ok(cond: unknown, msg: string) {
  if (cond) pass++;
  else {
    fail++;
    console.error("  FAIL:", msg);
  }
}
const eq = (a: unknown, b: unknown, msg: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)})`);

// 2026-10-12 정오(서울)를 「지금」으로 둔다. 「작년」은 2025, 「올해」는 2026 이다.
const NOW = Date.UTC(2026, 9, 12, 3);

const TITLES = [
  "[장애보고] Client-X Product-Z1 서비스 장애 (2025-04-22)",
  "[장애보고] Client-Y Product-Z2 서비스 장애 (2024-08-05)",
  "[기술문서] Product-Z1 설치 가이드",
  "[기술문서] Product-Z2 운영 매뉴얼",
  "[회의록] Client-X 정기 미팅 (2026-02-20)",
  "[회의록] Client-Y 장애 대응 회의 (2026-06-24)",
  "[제안서] Client-W Product-Z1 도입 제안",
  "[제안서] Client-Y Product-Z3 도입 제안",
];

// ── 제목의 속성 ─────────────────────────────────────────────────────────
{
  eq(docTitle(TITLES[0]), { title: TITLES[0], ids: ["Client-X", "Product-Z1"], date: { y: 2025, m: 4, d: 22 }, tag: "장애보고" }, "장애 보고서 제목");
  eq(docTitle(TITLES[2]).ids, ["Product-Z1"], "기술 문서 제목의 식별자는 제품 하나");
  ok(docTitle(TITLES[6]).date === undefined, "제안서 제목에는 날짜가 없다");
  eq(documentOf("[기술문서] Product-Z1 설치 가이드 — 설치 절차"), "[기술문서] Product-Z1 설치 가이드", "조각 제목의 문서 부분");
  eq(documentOf("환불 정책"), "환불 정책", "「 — 」가 없으면 제목 전체");
}

// ── 질문의 날짜 ─────────────────────────────────────────────────────────
{
  eq(askedDate("2025년 11월 8일 사고", NOW), { y: 2025, m: 11, d: 8 }, "해 달 날");
  eq(askedDate("작년 4월 22일에 난 장애", NOW), { y: 2025, m: 4, d: 22 }, "작년은 2025");
  eq(askedDate("올해 2월에 있었던 사고", NOW), { y: 2026, m: 2 }, "올해와 달");
  eq(askedDate("작년 8월 말 회의", NOW), { y: 2025, m: 8 }, "「말」은 날이 아니다");
  eq(askedDate("6월에 있었잖아", NOW), { m: 6 }, "달만");
  eq(askedDate("2025-03-17 건", NOW), { y: 2025, m: 3, d: 17 }, "ISO 날짜");
  eq(askedDate("2024년도 보고서", NOW), { y: 2024 }, "해만");
  eq(askedDate("투자금 회수 12개월, 월 운영비 500만원", NOW), undefined, "개월과 월 운영비는 날짜가 아니다");
}

// ── 문서 여럿을 묻는 질문 ───────────────────────────────────────────────
{
  ok(asksAcrossDocuments("장애 보고서들에 나온 원인을 정리해줘"), "복수와 정리");
  ok(asksAcrossDocuments("요즘 장애 원인이 뭐였어?"), "최근");
  ok(asksAcrossDocuments("복구가 가장 오래 걸린 장애는?"), "문서 사이의 최상급");
  ok(!asksAcrossDocuments("Product-Z1 설치 단계들 알려줘"), "한 문서 안의 단계들은 아니다");
  ok(!asksAcrossDocuments("설치 가이드 전체 절차"), "한 문서의 전체 절차는 아니다");
}

// ── 질문이 가리키는 문서 ────────────────────────────────────────────────
{
  const named = (q: string) => namedDocument(q, TITLES, NOW)?.title;
  eq(named("Client-X Product-Z1 2025년 4월 22일 장애 원인이 뭐였어?"), TITLES[0], "식별자 둘과 날짜");
  eq(named("작년 4월 22일 Client-X 건 첫 조치"), TITLES[0], "고객사와 상대 날짜");
  eq(named("올해 2월 20일 Client-X 미팅에서 뭐라고 했지?"), TITLES[4], "날짜가 같은 회의록");
  eq(named("Client-Y 장애 대응 회의가 6월에 있었잖아"), TITLES[5], "종류 낱말 둘(장애, 회의)과 달");
  eq(named("Client-W에 Product-Z1 권할 때 구축비 얼마 써냈어?"), TITLES[6], "고객사와 제품이 같이 든 제안서");
  eq(named("Product-Z1 일단 띄우려면 어떻게 해?"), TITLES[2], "제품만 말하면 제품만 제목에 단 문서(기술 문서)");
  ok(namedDocument("Product-Z1 일단 띄우려면 어떻게 해?", TITLES, NOW)?.by_identifier_set === true, "식별자 집합으로 고른 것은 표시한다");
  ok(namedDocument("올해 2월 20일 Client-X 미팅", TITLES, NOW)?.by_identifier_set === false, "날짜로 하나가 남으면 강한 지목이다");
  eq(named("Client-X 장애 때 첫 조치가 뭐였어?"), TITLES[0], "고객사만이어도 종류(장애)가 보고서를 고른다");
  eq(named("client x 정기 미팅 결정 사항"), TITLES[4], "대소문자와 공백 표기");
  eq(named("Product-Z1 장애 보고서들 정리해줘"), undefined, "문서 여럿을 묻는 질문은 가리키지 않는다");
  eq(named("설치 방법 알려줘"), undefined, "식별자가 없으면 가리키지 않는다");
  eq(named("Client-X 2024년 12월 1일 장애"), undefined, "날짜가 맞는 문서가 없으면 가리키지 않는다");
  eq(named("Client-X랑 Client-Y 미팅 비교해줘"), undefined, "두 고객사를 한 제목에 단 문서는 없다");
  eq(named("Client-XY 미팅"), undefined, "Client-X 는 Client-XY 가 아니다");
  eq(named("Product-Z1 관련 내용"), TITLES[2], "제품 하나만 말한 열린 질문도 제품 문서로 간다(식별자 집합)");
}

// ── 문서의 절 ───────────────────────────────────────────────────────────
const chunk = (id: number, section: string, body: string): DocChunk => ({ id, title: `[기술문서] Product-Z1 설치 가이드 — ${section}`, body });
const GUIDE: DocChunk[] = [
  chunk(1, "Product-Z1 설치 가이드", "# Product-Z1 설치 가이드"),
  chunk(2, "시스템 요구사항", "## 시스템 요구사항\n- CPU 8코어\n- 메모리 32GB"),
  chunk(3, "설치 절차", "## 설치 절차"),
  chunk(4, "1단계: 의존성 설치", "### 1단계: 의존성 설치\n패키지를 설치한다."),
  chunk(5, "2단계: 설정 파일 준비", "### 2단계: 설정 파일 준비\n.env 를 만든다."),
  chunk(6, "3단계: 서비스 시작", "### 3단계: 서비스 시작\n서비스를 올린다."),
  chunk(7, "4단계: 헬스체크", "### 4단계: 헬스체크\n상태를 확인한다."),
];
{
  const units = sectionUnits(GUIDE);
  eq(units.map((u) => u.map((c) => c.id)), [[1], [2], [3, 4, 5, 6, 7]], "## 가 절을 열고 ### 는 그 절에 붙는다, # 은 혼자다");
  eq(sectionUnits([chunk(1, "a", "본문만 있는 조각"), chunk(2, "b", "### 소제목")]).map((u) => u.map((c) => c.id)), [[1, 2]], "제목 없는 첫 조각도 절을 연다");
  eq(chooseSections(units, "설치 단계", new Map(), 10_000).length, 3, "통째로 들면 모든 절");
  const cost = (u: DocChunk[]) => u.reduce((n, c) => n + estTokens(chunkText(c)), 0);
  const tight = chooseSections(units, "설치 단계", new Map([[6, 0]]), cost(units[2]));
  eq(tight.map((u) => u.map((c) => c.id)), [[3, 4, 5, 6, 7]], "예산이 모자라면 검색 상위 조각이 든 절을 통째로");
  const two = chooseSections(units, "설치 단계", new Map([[2, 0]]), cost(units[1]) + cost(units[0]));
  eq(two.map((u) => u.map((c) => c.id)), [[1], [2]], "담은 절은 문서 순서로 되돌린다");
  ok(chooseSections(units, "설치", new Map(), 5).length === 0, "어느 절도 들지 않으면 빈 목록(절을 쪼개지 않는다)");
}

// ── 큐레이터: 근거 단위는 통째로 싣거나 통째로 뺀다 ──────────────────────
{
  const items = [
    { kind: "chunk" as const, text: "환불 첫째 절", source: "documents#1", unit: "doc#0" },
    { kind: "chunk" as const, text: "둘째 절 배송 안내 문단", source: "documents#2", unit: "doc#0" },
    { kind: "chunk" as const, text: "환불 정책 안내", source: "documents#9" },
  ];
  const t = (i: number) => estTokens(items[i].text);
  const all = curate("환불 정책", items, 1000);
  eq(all.kept.map((i) => i.source), ["documents#1", "documents#2", "documents#9"], "예산이 넉넉하면 모두, 원래 순서로");
  const exact = curate("환불 정책", items, t(0) + t(1) + t(2));
  eq(exact.kept.length, 3, "단위와 항목이 딱 들면 모두");
  const short = curate("환불 정책", items, t(0) + t(1) + t(2) - 1);
  eq(short.kept.map((i) => i.source), ["documents#9"], "더 관련 있는 항목을 담고 남은 자리에 단위가 통째로 들지 않으면 단위를 뺀다(조각 하나만 싣지 않는다)");
  eq(short.dropped.map((i) => i.source), ["documents#1", "documents#2"], "뺀 단위의 조각은 모두 dropped");
  const big = curate("환불 정책", items.slice(0, 2), t(0));
  eq(big.kept.map((i) => i.source), ["documents#1"], "예산 전체보다 큰 단위는 항목별로 담는다");
  ok(big.notes.some((n) => /unit doc#0 exceeds the budget .*kept 1 of 2/.test(n)), `그렇다고 적는다 (got ${JSON.stringify(big.notes)})`);
  ok(big.tokensUsed <= t(0), "그때도 예산은 지킨다");
}

// ── retrieve: 문서 하나를 가리킨 질문은 그 문서의 절을 문서 순서대로 받는다 ──
{
  const DOC = "[기술문서] Product-Z1 설치 가이드";
  const OTHER = "[제안서] Client-W Product-Z1 도입 제안";
  const rows = [
    ...GUIDE.map((c) => ({ ...c, title: `${DOC} — ${c.title.split(" — ")[1]}` })),
    { id: 20, title: `${OTHER} — 3. 구축 계획`, body: "## 3. 구축 계획\n설치 일정" },
  ];
  const queries: string[] = [];
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      queries.push(sql);
      if (/GROUP BY 1 ORDER BY 2, 1/.test(sql)) return { rows: [{ title: DOC, first: 1 }, { title: OTHER, first: 20 }] };
      if (/WHERE split_part\(title, ' — ', 1\) = \$1/.test(sql)) return { rows: rows.filter((r) => r.title.startsWith(`${params?.[0]} — `)) };
      if (/ORDER BY embedding <=>/.test(sql)) {
        // 상위 k: 다른 문서 조각이 1위이고 가이드는 4단계 하나만 들었다.
        return { rows: [rows[7], rows[6]].map((r) => ({ ...r, score: 0.8 })) };
      }
      return { rows: [] };
    },
  } as unknown as Pool;
  const embedder: Embedder = { name: "test:fixed", dim: 4, embed: async () => [1, 0, 0, 0] };
  const r = await retrieve("Product-Z1 설치 가이드 문서에서 설치 절차 알려줘", { pool, embedder });
  eq(r.route, "semantic", "문서 질문은 문서 레인");
  eq(r.curated.kept.map((i) => i.source), GUIDE.map((c) => `documents#${c.id}`), "가이드의 모든 조각이 문서 순서로 실리고 다른 문서 조각은 빠진다");
  const unit = r.audit.evidence_unit;
  ok(unit?.kind === "document" && unit.title === DOC && unit.sections === 3 && unit.chunks === 7 && unit.hits_in_document === 1, `감사에 근거 단위가 남는다 (got ${JSON.stringify(unit)})`);
  ok(r.audit.branch_errors.length === 0, "오류 없음");
  ok(r.audit.candidates.vector === 2 && r.vector?.hits.length === 2, `레인의 후보 수와 결과는 검색이 찾은 상위 k 그대로다 (got ${r.audit.candidates.vector})`);

  const multi = await retrieve("Product-Z1 관련 장애 보고서들 정리해줘", { pool, embedder });
  ok(multi.audit.evidence_unit === undefined && multi.curated.kept.length === 2, "문서 여럿을 묻는 질문은 상위 k 그대로");

  const failing = {
    query: async (sql: string) => {
      if (/ORDER BY embedding <=>/.test(sql)) return { rows: [{ ...rows[6], score: 0.9 }] };
      throw new Error("relation gone");
    },
  } as unknown as Pool;
  const degraded = await retrieve("Product-Z1 설치 가이드 문서에서 설치 절차 알려줘", { pool: failing, embedder });
  ok(degraded.curated.kept.length === 1 && degraded.audit.evidence_unit === undefined, "문서 제목을 못 읽으면 상위 k 그대로 둔다");
  ok(degraded.audit.branch_errors.some((e) => /^vector: document unit: .*relation gone/.test(e)), "그 사실을 branch_errors 에 남긴다");
}

console.log(`\nevidence.test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
