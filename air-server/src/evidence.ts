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

// 근거 단위 — 답 단계가 읽는 컨텍스트를 상위 k 조각이 아니라 온전한 단위로 만든다.
//
// 문서 하나를 지목한 질문에 상위 다섯 조각을 주면 그 문서의 절이 잘리고 다른 문서의 조각이 섞인다. 설치 절차는 단계마다 조각이라
// 다섯 안에 네 단계가 다 들지 못했고(홀드아웃3 #21, #22), 원인 분석 절이 같은 문서의 다른 절에 밀렸고(#30), 다른 제안서의 28%를
// 답했다(홀드아웃4 #39). 정답 문서 전체를 준 오라클 재실행은 문서 레인 실패 7건 가운데 6건을 고쳤다(2026-10-11 진단).
// 그래서 질문이 제목의 속성(고객사, 제품 식별자, 날짜, 문서 종류)으로 문서 하나를 가리키면 그 문서의 절을 통째로, 문서 순서대로 준다.
// 여러 문서를 묻는 열린 질문에 같은 일을 하면 둘째 문서의 내용이 빠졌으므로(사업자 16, 19, 20번) 문서 하나를 가리킬 때만 쓴다.
import type { Pool } from "./db.js";
import { contentTerms, estTokens } from "./text.js";
import { profile } from "./profile.js";
import type { VectorHit } from "./vector.js";

/** 답 단계가 받은 근거 단위. 감사 레코드에 그대로 싣는다. */
export type EvidenceUnit =
  | {
      kind: "document";
      /** 문서 제목(조각 제목의 「 — 」 앞). */
      title: string;
      /** 무엇으로 문서 하나를 골랐는지(식별자, 날짜, 종류, 식별자 집합 일치). */
      named_by: string[];
      /** 컨텍스트에 실은 절 수와 문서의 절 수. */
      sections: number;
      sections_total: number;
      chunks: number;
      /** 벡터 검색 상위 k 가운데 이 문서의 조각 수. 0 이면 쓰지 않는다. */
      hits_in_document: number;
    }
  | {
      kind: "relation";
      /** 계획의 관계 타입. */
      relations: string[];
      /** 엣지를 펼친 시드. */
      seeds: string[];
      /** 시드에서 그 관계로 닿은 엣지 수(컨텍스트 줄 수가 아니다. 같은 답 개체의 엣지는 한 줄로 모인다). */
      edges: number;
    };

// ── 문서 제목의 속성 ────────────────────────────────────────────────────

/** 제목과 질문의 사업자 식별자(Client-A, Product-C1). 앞뒤가 영숫자면 다른 식별자다(Client-A 와 Client-AB). */
const ID = /(?<![A-Za-z0-9-])[A-Z][A-Za-z]*-[A-Z0-9]+(?![A-Za-z0-9-])/g;
/** 제목의 날짜(「(2025-12-27)」). 기술 문서와 제안서 제목에는 없다. */
const TITLE_DATE = /\((\d{4})-(\d{2})-(\d{2})\)/;
/** 제목 앞 종류 꼬리표(「[장애보고]」). */
const TITLE_TAG = /^\s*\[([^\]]+)\]/;

export interface DocTitle {
  title: string;
  ids: string[];
  date?: { y: number; m: number; d: number };
  tag?: string;
}

export function docTitle(title: string): DocTitle {
  const date = TITLE_DATE.exec(title);
  const tag = TITLE_TAG.exec(title)?.[1];
  return {
    title,
    ids: [...new Set(title.match(ID) ?? [])],
    ...(date ? { date: { y: Number(date[1]), m: Number(date[2]), d: Number(date[3]) } } : {}),
    ...(tag ? { tag } : {}),
  };
}

// ── 질문이 가리키는 문서 ────────────────────────────────────────────────

/** 문서 종류를 가리키는 평소 말과 그 종류의 제목 꼬리표. 한 질문이 둘을 말할 수 있다(「장애 대응 회의」). */
const KIND_WORDS: [RegExp, string][] = [
  [/장애|사고|터진|터졌|먹통|다운됐|인시던트/, "장애보고"],
  [/회의|미팅|킥오프|중간\s*점검|만났|만난/, "회의록"],
  [/제안|도입안|견적/, "제안서"],
  [/가이드|매뉴얼|레퍼런스|설계서|기술\s*문서/, "기술문서"],
];

/** 서울 기준 올해(UTC+9). router.ts seoulYear 와 같은 셈이다. */
function seoulYear(now: number): number {
  return new Date(now + 9 * 3600 * 1000).getUTCFullYear();
}

/** 상대 연도 말과 올해에서 뺄 햇수. 「재작년」을 「작년」보다 먼저 본다. */
const RELATIVE_YEARS: [RegExp, number][] = [
  [/재작년|지지난\s*해/g, 2],
  [/작년|지난\s*해|지난해/g, 1],
  [/올해|금년|이번\s*해/g, 0],
];

export interface AskedDate {
  y?: number;
  m?: number;
  d?: number;
}

/** 질문의 날짜(해, 달, 날 가운데 말한 것). 「작년 8월 말」은 해와 달, 「6월에」는 달만이다. 없으면 undefined. */
export function askedDate(query: string, now = Date.now()): AskedDate | undefined {
  let q = query;
  const thisYear = seoulYear(now);
  for (const [re, back] of RELATIVE_YEARS) q = q.replace(re, `${thisYear - back}년 `);
  const iso = /(?<!\d)(\d{4})\s*[-./]\s*(\d{1,2})\s*[-./]\s*(\d{1,2})(?!\d)/.exec(q);
  if (iso) return { y: Number(iso[1]), m: Number(iso[2]), d: Number(iso[3]) };
  const full = /(?<!\d)(\d{4})\s*년(?:도)?\s*(\d{1,2})\s*월(?:\s*(\d{1,2})\s*일)?/.exec(q);
  if (full) return { y: Number(full[1]), m: Number(full[2]), ...(full[3] ? { d: Number(full[3]) } : {}) };
  const md = /(?<![\d.])(\d{1,2})\s*월(?:\s*(\d{1,2})\s*일)?/.exec(q);
  if (md) {
    const y = /(?<!\d)(\d{4})\s*년/.exec(q);
    return { ...(y ? { y: Number(y[1]) } : {}), m: Number(md[1]), ...(md[2] ? { d: Number(md[2]) } : {}) };
  }
  const year = /(?<!\d)(\d{4})\s*년(?:도)?/.exec(q);
  return year ? { y: Number(year[1]) } : undefined;
}

/** 문서 여럿을 묻는 말: 문서 낱말의 복수, 모든·전부·여러 + 문서 낱말, 정리 요청, 최근. 그리고 문서 사이를 견주는 최상급. */
const ALL_OR_RECENT =
  /(?:문서|보고서|회의록|매뉴얼|가이드|제안서|자료|기록|사례|장애|이슈)들(?=[은는이가을를의에과와도만]|\s|$|[?？!.,])|(?:모든|전부|전체|여러)\s*(?:문서|보고서|회의록|매뉴얼|가이드|제안서|자료|기록|사례|장애|이슈)|정리\s*(?:해|하여|좀)|요즘|최근/;
const DOC_SUPERLATIVE = /(?:가장|제일)\s*(?:길|오래|많|짧|적)/;
const DOC_WORD = /장애|보고서|회의|문서|매뉴얼/;

/** 질문이 문서 여럿을 훑거나 견주라는 것인가(「장애 보고서들 정리해줘」, 「요즘 장애 원인」, 「복구가 가장 오래 걸린 장애」).
 * 「설치 단계들」, 「설치 가이드 전체 절차」는 한 문서 안의 질문이다. */
export function asksAcrossDocuments(query: string): boolean {
  return ALL_OR_RECENT.test(query) || (DOC_SUPERLATIVE.test(query) && DOC_WORD.test(query));
}

/** 질문에 식별자가 있는가. 대소문자와 하이픈 대신 쓴 공백, 밑줄은 가리지 않는다(「client a」, 「CLIENT-A」). */
function mentions(query: string, id: string): boolean {
  const [head, ...tail] = id.split("-");
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9])${esc(head)}[-_\\s]?${esc(tail.join("-"))}(?![A-Za-z0-9])`, "i").test(query);
}

export interface NamedDocument {
  title: string;
  named_by: string[];
  /** 식별자, 날짜, 종류로는 여럿이 남아 「제목의 식별자가 질문과 똑같은 문서」로 골랐다. 그만큼 약한 지목이다. */
  by_identifier_set: boolean;
}

/** 질문이 제목의 속성으로 문서 하나를 가리키면 그 제목. 결정론이다.
 *
 * 질문의 식별자를 모두 제목에 가진 문서가 후보다(식별자가 없으면 가리킨 것이 아니다). 날짜를 말했으면 제목 날짜가 그 해, 달, 날과 같은
 * 것만, 문서 종류를 말했으면 그 종류만 남긴다. 하나 남으면 그 문서다. 여럿이면 제목의 식별자가 질문의 식별자와 똑같은 문서 하나를
 * 고른다: 제품만 말한 질문은 제품만 제목에 단 문서(기술 문서), 고객사만 말한 질문은 고객사만 단 문서(회의록)를 가리킨다. 문서 여럿을
 * 묻는 질문(asksAcrossDocuments)은 가리키지 않는다. */
export function namedDocument(query: string, titles: readonly string[], now = Date.now()): NamedDocument | undefined {
  if (asksAcrossDocuments(query)) return undefined;
  const docs = titles.map(docTitle);
  const ids = [...new Set(docs.flatMap((d) => d.ids))].filter((id) => mentions(query, id));
  if (!ids.length) return undefined;
  const by = [`식별자 ${ids.join(", ")}`];
  let cands = docs.filter((d) => ids.every((id) => d.ids.includes(id)));
  const date = askedDate(query, now);
  if (date) {
    cands = cands.filter(
      (d) => d.date && (date.y === undefined || d.date.y === date.y) && (date.m === undefined || d.date.m === date.m) && (date.d === undefined || d.date.d === date.d),
    );
    by.push(`날짜 ${[date.y, date.m, date.d].filter((x) => x !== undefined).join("-")}`);
  }
  const tags = KIND_WORDS.filter(([re]) => re.test(query)).map(([, tag]) => tag);
  if (tags.length) {
    cands = cands.filter((d) => d.tag !== undefined && tags.includes(d.tag));
    by.push(`종류 ${tags.join("+")}`);
  }
  if (cands.length === 1) return { title: cands[0].title, named_by: by, by_identifier_set: false };
  const exact = cands.filter((d) => d.ids.length === ids.length);
  if (exact.length === 1) return { title: exact[0].title, named_by: [...by, "제목의 식별자가 질문과 같다"], by_identifier_set: true };
  return undefined;
}

// ── 문서의 절 ───────────────────────────────────────────────────────────

/** 문서 조각 하나. title 은 「문서 제목 — 절 제목」이다(companyx.documents 뷰). */
export interface DocChunk {
  id: number;
  title: string;
  body: string;
}

/** 조각 제목의 문서 제목 부분. 「 — 」가 없으면(조각이 곧 문서인 표) 제목 전체다. */
export function documentOf(chunkTitle: string): string {
  const at = chunkTitle.indexOf(" — ");
  return at >= 0 ? chunkTitle.slice(0, at) : chunkTitle;
}

/** 조각 본문 첫 줄의 마크다운 제목 수준(#, ##, ###). 제목으로 시작하지 않으면 0. */
function headingLevel(body: string): number {
  return /^(#{1,6})\s/.exec(body.trimStart())?.[1].length ?? 0;
}

/** 문서 순서의 조각을 절로 묶는다. 둘째 수준 제목(##)이 절을 열고, 그 아래 제목(###)과 제목 없는 조각(긴 절을 문단으로 가른 것)은
 * 앞 절에 붙는다. 첫째 수준 제목(#)은 문서 머리라 혼자 한 단위다. 설치 가이드의 「설치 절차」는 네 단계와 함께 한 절이 된다. */
export function sectionUnits(chunks: readonly DocChunk[]): DocChunk[][] {
  const units: DocChunk[][] = [];
  // 지금 붙일 수 있는 절이 열려 있는가. 문서 머리(#) 뒤에는 닫혀 있다.
  let open = false;
  for (const c of chunks) {
    const level = headingLevel(c.body);
    if (level === 1 || level === 2 || !open) {
      units.push([c]);
      open = level !== 1;
    } else {
      units[units.length - 1].push(c);
    }
  }
  return units;
}

/** 컨텍스트 줄의 글. 파이프라인이 문서 조각을 싣는 꼴과 같다. */
export function chunkText(c: Pick<DocChunk, "title" | "body">): string {
  return `${c.title}: ${c.body}`;
}

/** 예산 안에 실을 절. 문서가 통째로 들면 전부, 아니면 검색 상위 조각이 든 절부터(순위 순), 그다음 질문 낱말이 많이 겹치는 절부터
 * 절 단위로 담고 문서 순서로 되돌린다. 절은 쪼개지 않는다. */
export function chooseSections(units: readonly DocChunk[][], query: string, hitRank: ReadonlyMap<number, number>, budget: number): DocChunk[][] {
  const cost = (u: readonly DocChunk[]) => u.reduce((n, c) => n + estTokens(chunkText(c)), 0);
  if (units.reduce((n, u) => n + cost(u), 0) <= budget) return [...units];
  const qt = contentTerms(query);
  const overlap = (u: readonly DocChunk[]) => u.reduce((n, c) => n + [...contentTerms(chunkText(c))].filter((t) => qt.has(t)).length, 0);
  const best = (u: readonly DocChunk[]) => Math.min(...u.map((c) => hitRank.get(c.id) ?? Infinity));
  const order = units
    .map((u, i) => ({ u, i, rank: best(u), rel: overlap(u) }))
    .sort((a, b) => a.rank - b.rank || b.rel - a.rel || a.i - b.i);
  const kept: { u: DocChunk[]; i: number }[] = [];
  let used = 0;
  for (const x of order) {
    const c = cost(x.u);
    if (used + c > budget) continue;
    kept.push({ u: [...x.u], i: x.i });
    used += c;
  }
  return kept.sort((a, b) => a.i - b.i).map((x) => x.u);
}

// ── DB ──────────────────────────────────────────────────────────────────

function safeTable(t: string): string {
  if (!/^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/.test(t)) throw new Error(`unsafe table identifier: ${t}`);
  return t;
}

/** 문서 제목 목록(조각 제목의 「 — 」 앞, 적재 순서). */
export async function documentTitles(pool: Pool, table = profile().vectorTable): Promise<string[]> {
  const res = await pool.query(
    `SELECT split_part(title, ' — ', 1) AS title, min(id) AS first FROM ${safeTable(table)} GROUP BY 1 ORDER BY 2, 1`,
  );
  return res.rows.map((r) => String(r.title));
}

/** 질문이 가리키는 문서가 검색 상위 조각에도 있으면 그 문서. 검색이 그 문서를 하나도 찾지 않았으면 질문이 그 문서의 내용을 묻는다고
 * 보지 않는다. 제목을 읽지 못하면 던진다(부르는 쪽이 상위 k 를 두고 그 사실을 남긴다). */
export async function namedDocumentInHits(
  pool: Pool,
  query: string,
  hits: readonly Pick<VectorHit, "title">[],
  table = profile().vectorTable,
): Promise<(NamedDocument & { hits: number }) | undefined> {
  if (!hits.length) return undefined;
  const named = namedDocument(query, await documentTitles(pool, table));
  if (!named) return undefined;
  const inDoc = hits.filter((h) => documentOf(h.title) === named.title).length;
  return inDoc ? { ...named, hits: inDoc } : undefined;
}

/** 문서 하나를 가리킨 질문의 근거: 그 문서의 절(chooseSections)을 문서 순서대로. 가리킨 문서가 없으면 undefined(상위 k 조각 그대로). */
export async function documentEvidence(
  pool: Pool,
  query: string,
  hits: readonly VectorHit[],
  budget: number,
  table = profile().vectorTable,
): Promise<{ hits: VectorHit[]; unit: EvidenceUnit; units: number[] } | undefined> {
  const named = await namedDocumentInHits(pool, query, hits, table);
  if (!named) return undefined;
  const res = await pool.query(`SELECT id, title, body FROM ${safeTable(table)} WHERE split_part(title, ' — ', 1) = $1 ORDER BY id`, [named.title]);
  const chunks: DocChunk[] = res.rows.map((r) => ({ id: Number(r.id), title: String(r.title), body: String(r.body) }));
  if (!chunks.length) return undefined;
  const all = sectionUnits(chunks);
  const hitRank = new Map(hits.map((h, i) => [h.id, i] as const));
  const chosen = chooseSections(all, query, hitRank, budget);
  if (!chosen.length) return undefined;
  const score = new Map(hits.map((h) => [h.id, h.score] as const));
  const top = hits[0]?.score ?? 0;
  const out: VectorHit[] = [];
  const units: number[] = [];
  chosen.forEach((u, s) => {
    for (const c of u) {
      out.push({ id: c.id, title: c.title, body: c.body, score: score.get(c.id) ?? top });
      units.push(s);
    }
  });
  return {
    hits: out,
    units,
    unit: {
      kind: "document",
      title: named.title,
      named_by: named.named_by,
      sections: chosen.length,
      sections_total: all.length,
      chunks: out.length,
      hits_in_document: named.hits,
    },
  };
}
