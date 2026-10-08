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

// End-to-end retrieval pipeline (the differentiator spine):
//   route (L3, deterministic)  ->  parallel fan-out (sql.query ∥ vector.search)
//   ->  RRF merge  ->  L4 structure-preserving curation  ->  curated context.
//
// The 7B answer step consumes `context` (added in the LLM increment). Everything
// here is deterministic given a deterministic nl2sql + embedder, so the whole
// spine is reproducible and unit-testable without a model.

import type { Pool } from "./db.js";
import type { Embedder } from "./embedder.js";
import {
  route,
  audit as routeAuditLog,
  fitPlanToSeed,
  backReferenceOnly,
  entitiesIn,
  GRAPH_TOOL,
  type RouteDecision,
  type GraphPlan,
  type DocCountRequest,
} from "./router.js";
import { routeQuery } from "./semroute.js";
import { sqlQuery, columnsForSql, type SqlResult } from "./sql.js";
import { keywordIndexReady, keywordSearch, type KeywordSearchResult } from "./keyword.js";
import { vectorSearch, type VectorResult } from "./vector.js";
import { rrfMerge, type Ranked, type Fused } from "./rrf.js";
import { curate, render, curateAudit, type ContextItem, type Curated } from "./curator.js";
import { type NL2SQL, type Nl2SqlReport, NO_TABLE } from "./nl2sql.js";
import { executeWithRepair } from "./sqlrepair.js";
import { alignQualifiedTables, tieAnswer, untrustedAnswer, vagueMeasure, type SqlGate } from "./sqltrust.js";
import { profile } from "./profile.js";
import { answer as llmAnswer } from "./llm.js";
import {
  ontologySearch,
  seedTerms,
  mentionTerms,
  entityLikeName,
  graphExpand,
  graphWalk,
  relationScan,
  ontologyCandidates,
  edgeCandidates,
  seedEdgeCandidates,
  pathCandidates,
  rankingCandidates,
  relLabel,
  kgSchema,
  pairEdges,
  membersWithout,
  GRAPH_LIMITS,
  RELATION_SCAN_LIMIT,
  type GraphEdge,
  type GraphResult,
  type GraphTruncation,
  type NodeFilter,
} from "./graph.js";
import type { Candidate } from "./candidate.js";
import { describeError } from "./errors.js";
import { absentAttribute, describeAbsentAttribute, describeNotFound, NO_ENTITY_TERM, type NotFound } from "./notfound.js";
import { outsideContextMentions } from "./auditrecord.js";

export interface RetrieveDeps {
  pool: Pool;
  embedder: Embedder;
  nl2sql?: NL2SQL; // default: deterministic template fast-path
  k?: number; // vector top-k (default 5)
  budget?: number; // curator token budget (default DEFAULT_BUDGET)
  repair?: boolean; // retry a rejected SQL once with the DB error (default true)
}

export interface RetrieveResult {
  query: string;
  route: RouteDecision["route"];
  /** gate 는 실행 전 검사(sqltrust.ts)가 생성 SQL 을 거부했거나 질문이 측정 항목 한 낱말뿐이라(gate.vague) SQL 을
   * 만들지 않았을 때만 붙는다. refused 는 생성 모델이 만들었지만 실행하지 않은 문장(nl2sql.ts pickSql), absent 는 질문이
   * 묻는 항목이 스키마에 없어 SQL 을 만들지 않았을 때 그 항목(notfound.ts absentAttribute). refused 와 absent 는 text 가
   * null 이다. rank 는 순위 질문을 그 순위의 행을 모두 돌려주는 SQL(sqltrust.ts rankRewrite)로 실행했을 때 그 순위다. */
  sql: {
    text: string | null;
    result?: SqlResult;
    repaired?: boolean;
    gate?: SqlGate;
    refused?: { kind: string; text: string };
    absent?: string;
    rank?: number;
    /** 질문이 이름처럼 생긴 낱말로 지목했는데 데이터에 없는 개체(sqlMissingNames). 있을 때만. */
    missing?: NotFound[];
  };
  vector?: VectorResult;
  graph?: GraphLaneResult;
  /** 문서 개수 질문(router.ts documentCountRequest)일 때만. 제목으로 고른 문서와 전체 문서 수. */
  documents?: DocCountResult;
  /** 두 개체의 관계 질문(router.ts pairRelationRequest)일 때만. 두 개체 사이의 직접 엣지. */
  pair?: { a: string; b: string } & GraphResult;
  /** 앞 대화를 가리키는 말만 있는 질문(router.ts backReferenceOnly)일 때만. 그 말. 라우팅도 조회도 하지 않았다. */
  back_reference?: string;
  fused: Fused<ContextItem>[];
  /** RRF 입력 목록마다의 레인 이름. fused[].sources 의 번호가 이 배열의 위치다. */
  fusion_lanes?: string[];
  curated: Curated;
  context: string;
  /** 미해소 개체 게이트가 발동했을 때 그 사유. 그 밖에는 없다. */
  not_found?: NotFound;
  /** 섞인 질문에서 해소되지 않은 이름마다의 사유. 찾은 개체로 답하고 답 앞에 이 사유를 붙인다. */
  missing?: NotFound[];
  /** missing 이 있을 때 답 단계가 받는 질문(없는 개체가 든 마디를 뺀 것). */
  answer_query?: string;
  audit: {
    route: ReturnType<typeof routeAudit>;
    candidates: { sql: number; vector: number; graph: number; fused: number };
    branch_errors: string[];
    curate: ReturnType<typeof curateAudit>;
    // retrieve 도구는 audit 만 돌려주므로 두 상태를 여기에도 싣는다.
    not_found?: NotFound;
    missing_entities?: NotFound[];
    graph_truncated?: GraphTruncation;
    /** 탐색 계획을 시드 타입에 맞게 고쳤으면 무엇을 고쳤는지(시드마다 한 줄). */
    graph_fitted?: string[];
    /** 생성 SQL 의 실행 전 검사가 무엇을 거부했는지(sqltrust.ts). 거부한 것이 있을 때만. */
    sql_gate?: SqlGate;
  };
}

function routeAudit(d: RouteDecision) {
  return routeAuditLog(d);
}

/** L5 lane result: ontology seeds + expanded edges, already canonicalized. */
export interface GraphLaneResult {
  seeds: { entityId: number; canonicalName: string; type: string }[];
  edgeCount: number;
  strategy: "seeded" | "relation-scan" | "seeded+relation-scan" | "unresolved" | "none" | "pair";
  ranking?: { name: string; type: string; count: number }[];
  /** 「가장 적은」(계획 order=asc) 집계의 공동 1위 전부. 답 문장이 이름을 다 적는다(fewestAnswer). */
  fewest?: { relType: string; count: number; entries: { name: string; text: string }[] };
  /** 속성 조건을 건 관계 스캔(「완료된 프로젝트를 이끈 직원 목록」)의 엣지. 답 문장이 조건과 이름을 적는다(filteredListAnswer).
   * complete 는 스캔 상한에 걸리지 않고 조건이 SQL 에 걸렸다는 뜻이다. */
  filtered?: { filter: NodeFilter; complete: boolean; entries: { relType: string; src: string; dst: string; text: string }[] };
  items: Candidate[];
  /** strategy 가 unresolved 일 때 왜 못 찾았는지. */
  not_found?: NotFound;
  /** 시드 확장 중 하나라도 탐색 상한에 걸렸으면 처음 걸린 것. */
  truncated?: GraphTruncation;
  /** 계획을 시드 타입에 맞게 고친 내용(router.ts fitPlanToSeed). */
  fitted?: string[];
  /** 섞인 질문에서 해소되지 않은 이름마다의 사유(graph.ts ontologySearch 의 missing). */
  missing?: NotFound[];
  /** missing 이 있을 때 답 단계와 탐색 계획이 쓰는 질문. 없는 개체가 든 마디를 뺐다. */
  answer_query?: string;
  error?: string;
}

/** 섞인 질문에서 없는 개체가 든 마디를 뺀 질문.
 *
 * 「서울물산 담당 엔지니어와 Client-A가 사용 중인 제품을 알려줘」에서 서울물산이 없으면
 * 「Client-A가 사용 중인 제품을 알려줘」만 남긴다. 그 마디의 관계(「담당」)를 찾은 개체에 걸면
 * Client-A 의 담당자가 서울물산의 담당자처럼 컨텍스트에 들어가고 7B 가 그렇게 답했다(경계 실측 3/3).
 * 마디는 「와·과·하고·이랑·랑」 뒤 공백, 쉼표, 「그리고」, 「및」에서 가른다. 남은 마디에 관계어가
 * 없으면(「Client-A와 서울물산의 담당자」) 관계어가 찾은 개체에도 걸린 것이라 마디 대신 이름과
 * 그 앞뒤 조사만 뺀다. 결정론이다. */
export function withoutMissing(query: string, names: string[]): string {
  const parts = query
    .split(/(?<=[가-힣A-Za-z0-9])(?:와|과|하고|이랑|랑)\s+|\s*,\s*|\s+(?:그리고|및)\s+/)
    .map((p) => p.trim())
    .filter(Boolean);
  const kept = parts.filter((p) => !names.some((n) => p.includes(n)));
  if (kept.length && kept.length < parts.length) {
    const reduced = kept.join(", ");
    if (route(reduced).graphPlan?.relTypes.length) return reduced;
  }
  let q = query;
  for (const n of names) {
    const name = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    q = q.replace(
      new RegExp(`(?:(?:와|과|하고|이랑|랑)\\s+)?${name}(?:은|는|이|가|을|를|의|와|과|도|에|에서|하고|이랑|랑)?`),
      " ",
    );
  }
  return q.replace(/\s+/g, " ").trim() || query;
}

/** Resolve the query's entities, BFS their typed edges, and — when the question
 * names a RELATION rather than a node ("가장 많은 고객을 담당하는 직원") — scan that
 * relation directly. Deterministic throughout: ranked alias matching, ordered BFS,
 * ordered aggregation. No model in the loop. */
export async function graphLane(
  pool: Pool,
  query: string,
  k = 5,
  depth = 2,
  schema = kgSchema(),
  plan?: GraphPlan,
): Promise<GraphLaneResult> {
  const onto = await ontologySearch(pool, query, k, schema);
  if (!onto.ok) return { seeds: [], edgeCount: 0, strategy: "none", items: [], error: onto.error };
  // 섞인 질문: 찾은 개체는 펼치되, 없는 개체가 든 마디를 뺀 질문으로 계획을 다시 세운다
  // (withoutMissing). 다시 세운 계획에 관계가 없으면 원래 계획을 쓴다.
  const missing = onto.missing ?? [];
  const answerQuery = missing.length ? withoutMissing(query, missing.map((m) => m.query_entity)) : undefined;
  const replanned = answerQuery ? route(answerQuery).graphPlan : undefined;
  const p = replanned?.relTypes.length ? replanned : (plan ?? route(query).graphPlan);
  const relTypes = p?.relTypes?.length ? p.relTypes : undefined;
  // When the question names a RELATION, one hop is the answer and every extra hop
  // is noise: "Product-S1 관련 고객 이슈" pulled in Client-X -> Product-C2 edges two
  // hops away and the 7B, reading a context full of other products, concluded there
  // were no Product-S1 issues at all. Unspecified relations keep the requested depth.
  // A named relation that cannot start from the seed's type ("Product-D1 관련 프로젝트":
  // HAS_PROJECT starts at a client, not a product) is re-planned per seed below
  // (fitPlanToSeed) into a typed two-hop walk instead of an empty one-hop expansion.
  const hops = relTypes ? 1 : depth;

  const seeds = onto.hits.map((h) => ({ entityId: h.entityId, canonicalName: h.canonicalName, type: h.type }));
  // Order matters: EDGES first, name-resolution hits last. RRF keeps one entry per
  // key at its best rank, and a seed hit ("윤소연 — 별칭 매칭 '경영지원팀'") shares its
  // key with the edge that actually answers ("경영지원팀의 부서장: 윤소연"). Listed
  // first, the near-empty seed line won and the model answered "알 수 없습니다" with
  // the answer one line below the cut. Facts before bookkeeping.
  // 예외는 없는 개체의 사유 줄이다. 예산에 잘리지 않게 맨 앞에 둔다.
  const items: Candidate[] = missing.map((nf) => ({
    canonicalKey: `missing#${nf.query_entity}`,
    sourceKey: "graph#missing",
    source: "graph" as const,
    text: `[그래프] ${describeNotFound(nf)}`,
    provenance: "ontology:missing",
  }));
  const partial = missing.length ? { missing, answer_query: answerQuery } : {};
  let edgeCount = 0;

  // Anti-hallucination gate: the question names an entity, nothing resolves, and the
  // plan has no relation-level intent -> say so. Dumping every edge of the relation
  // would hand the 7B a context that CONTAINS plausible-looking wrong answers
  // (the sponsor's own example "서울물산 담당 엔지니어" names a client absent from the
  // dataset; the honest output is "없음", not the 63 MANAGES_ACCOUNT edges).
  // The line names WHY (onto.not_found): absent vs. a similarly-named entity that
  // does not match. A similar name is reported, never expanded.
  if (onto.hits.length === 0 && !(p?.aggregate || p?.filter)) {
    const terms = seedTerms(query);
    // 찾지 못한 대상으로는 이름을 지목한 낱말만 댄다(graph.ts mentionTerms). 「등록된」, 「어떤 데이터베이스」만 있으면 개체를
    // 지목하지 않은 질문이라 「개체 이름으로 볼 낱말을 찾지 못해」 문장이다. 그 사유(no_entity_term)는 ontology.search 의 답에만
    // 싣고 여기서는 종전처럼 사유 없이 그 줄만 남긴다(ask 는 7B 에게 넘긴다).
    const nf = onto.not_found?.reason === "no_entity_term" ? undefined : onto.not_found;
    const mentions = mentionTerms(query);
    return {
      seeds: [],
      edgeCount: 0,
      strategy: "unresolved",
      not_found: nf,
      items: [
        {
          canonicalKey: `unresolved#${terms.join("+")}`,
          sourceKey: "graph#unresolved",
          source: "graph" as const,
          // 질의어가 하나도 없으면(「ㅁㄴㅇㄹ」) 찾지 못한 대상의 이름도 없다. 종전 문장은
          // 「대상()」처럼 빈 괄호를 보였고, 없는 개체를 단정하는 문장도 맞지 않았다.
          text: nf
            ? `[그래프] ${describeNotFound(nf)}`
            : mentions.length
              ? `[그래프] 질의에 등장한 대상(${mentions.join(", ")})을 지식그래프에서 찾지 못했습니다. 해당 개체는 데이터셋에 존재하지 않습니다.`
              : `[그래프] ${NO_ENTITY_TERM}`,
          provenance: "ontology:unresolved",
        },
      ],
    };
  }

  // Seeded traversal: expand only from EXACT/prefix seeds when we have any, so a
  // single well-named entity is not drowned by substring noise.
  const best = Math.max(0, ...onto.hits.map((h) => h.score));
  const expandFrom = onto.hits.filter((h) => h.score === best);
  let truncated: GraphTruncation | undefined;
  const fitted: string[] = [];
  // 한 홉 엣지는 시드를 다 돈 뒤 한꺼번에 후보로 바꾼다. 같은 답 개체에 여러 시드가 닿으면 한 줄로
  // 모아야 해서다(seedEdgeCandidates). 자리는 처음 펼친 한 홉 시드의 자리 그대로다.
  const edgeGroups: { edges: GraphEdge[]; seedId: number }[] = [];
  let edgesAt = -1;
  for (const hit of expandFrom) {
    // 계획의 엣지가 이 시드의 타입에 닿지 않으면 온톨로지 타입 그래프로 경로를 맞춘다.
    // GRAPH_PATH_FIT=0 은 검증용 제거 스위치다(고치기 전 동작).
    const others = expandFrom.filter((h) => h !== hit).map((h) => h.type);
    const walk =
      p && process.env.GRAPH_PATH_FIT !== "0" ? fitPlanToSeed(p.relTypes, hit.type, answerQuery ?? query, others) : undefined;
    if (walk?.fitted) fitted.push(`${hit.canonicalName}: ${walk.fitted}`);
    // 계획의 속성 조건(진행 중 → status=in_progress)은 시드의 엣지에도 건다. 관계 스캔에만 걸려 「Client-AC에서 진행 중인
    // 프로젝트」에 보류 프로젝트가 섞였다(랜덤 테스트 사전 점검 2차 R4).
    const exp =
      walk && walk.hops.length > 1
        ? await graphWalk(pool, hit.entityId, walk.hops, schema, GRAPH_LIMITS, p?.filter)
        : await graphExpand(pool, hit.entityId, hops, walk?.hops[0] ?? relTypes, schema, "both", GRAPH_LIMITS, p?.filter);
    if (!exp.ok) return { seeds, edgeCount, strategy: "seeded", items, error: exp.error, ...partial };
    truncated ??= exp.truncated;
    edgeCount += exp.edges.length;
    if (walk && walk.hops.length > 1) items.push(...pathCandidates(exp.edges, hit.entityId, walk.hops.length));
    else {
      if (edgesAt < 0) edgesAt = items.length;
      edgeGroups.push({ edges: exp.edges, seedId: hit.entityId });
    }
  }
  if (edgesAt >= 0) items.splice(edgesAt, 0, ...seedEdgeCandidates(edgeGroups));

  // Relation-level scan: needed when the question names no node (aggregate /
  // status-filtered listings), and harmless as an addition when it names both.
  let ranking: GraphLaneResult["ranking"];
  let fewest: GraphLaneResult["fewest"];
  let filtered: GraphLaneResult["filtered"];
  const needScan = Boolean(p && p.relTypes.length && (p.aggregate || p.filter || expandFrom.length === 0));
  if (needScan) {
    const scan = await relationScan(
      pool,
      { relTypes: p!.relTypes, aggregate: p!.aggregate, ...(p!.order ? { order: p!.order } : {}), filter: p!.filter },
      schema,
    );
    if (!scan.ok) {
      return { seeds, edgeCount, strategy: "relation-scan", items, error: scan.error, ...partial };
    }
    edgeCount += scan.edges.length;
    if (scan.ranking.length) {
      ranking = scan.ranking.slice(0, 5).map((r) => ({ name: r.name, type: r.type, count: r.count }));
      const ranked = rankingCandidates(scan.ranking, p!.relTypes[0], 5, p!.order);
      items.push(...ranked);
      if (p!.order === "asc") {
        const min = scan.ranking[0].count;
        fewest = {
          relType: p!.relTypes[0],
          count: min,
          entries: scan.ranking.flatMap((r, i) => (r.count === min ? [{ name: r.name, text: ranked[i].text }] : [])),
        };
      }
    } else {
      const lines = edgeCandidates(scan.edges);
      items.push(...lines);
      // 줄에는 거른 상태가 없어 7B 는 「완료된」을 확인할 근거가 없다며 거절했다. 답 문장을 위해 엣지를 따로 싣는다(컨텍스트는 그대로).
      if (p!.filter) {
        filtered = {
          filter: p!.filter,
          complete: Boolean(scan.filterApplied) && scan.edges.length < RELATION_SCAN_LIMIT,
          entries: scan.edges.map((e, i) => ({ relType: e.relType, src: e.srcName, dst: e.dstName, text: lines[i].text })),
        };
      }
    }
  }

  // Seed-resolution provenance goes last: it explains WHY these edges, and it is
  // still in the audit log even when the budget trims it from the context.
  // 펼친 시드만 싣는다. 점수가 낮아 펼치지 않은 시드(「영업」이라는 낱말로 걸린 직원 넷)는 사실 없이
  // 이름만 늘어서 답 줄을 가렸다(홀드아웃3 #47: 「김준혁의 담당 고객사: Client-K」가 첫 줄인데 「영업
  // 담당자들에게 말 걸면 됩니다」). 감사 레코드의 seeds 에는 그대로 남는다. GRAPH_WEAK_SEEDS=1 이 옛 동작.
  items.push(...ontologyCandidates(process.env.GRAPH_WEAK_SEEDS === "1" || !expandFrom.length ? onto.hits : expandFrom));

  const strategy: GraphLaneResult["strategy"] =
    expandFrom.length && needScan
      ? "seeded+relation-scan"
      : expandFrom.length
        ? "seeded"
        : needScan
          ? "relation-scan"
          : "none";
  return {
    seeds,
    edgeCount,
    strategy,
    ranking,
    ...(fewest ? { fewest } : {}),
    ...(filtered ? { filtered } : {}),
    items,
    ...(truncated ? { truncated } : {}),
    ...(fitted.length ? { fitted } : {}),
    ...partial,
  };
}

/** 정형 레인 질문이 이름처럼 생긴 낱말(Client-ZZ 꼴, 물산, 팀 같은 조직 접미사, graph.ts mentionTerms)로 지목했는데 온톨로지에서
 * 찾지 못한 개체마다의 사유. 정형 레인에는 개체 게이트가 없어 「서울물산의 2025년 3분기 총 매출액은 얼마야?」에 「서울물산의 … 매출액은
 * 없습니다.」라고 서울물산이 있는 고객사처럼 답했다. 「등록된」, 「어떤」, 「이전」 같은 말은 이름이 아니라 보지 않는다. Company-X 는
 * 이름을 가진 표(고객사, 제품, 직원, 부서, 프로젝트)가 모두 온톨로지 노드라 그 프로파일에서만 쓴다. */
export async function sqlMissingNames(pool: Pool, query: string, schema = kgSchema()): Promise<NotFound[]> {
  const out: NotFound[] = [];
  for (const term of mentionTerms(query)) {
    const name = entityLikeName(term);
    if (!name) continue;
    const o = await ontologySearch(pool, name, 1, schema);
    if (o.ok && !o.hits.length && o.not_found && o.not_found.reason !== "no_entity_term") out.push(o.not_found);
  }
  return out;
}

export interface DocCountResult {
  request: DocCountRequest;
  ok: boolean;
  /** 전체 문서 수(제목 기준). */
  total: number;
  /** 질문의 개체와 종류에 맞는 문서 제목. 문서 적재 순서. */
  titles: string[];
  error?: string;
}

/** 문서 제목이 질문의 개체와 종류에 맞는가. 개체 이름은 앞뒤가 영숫자가 아닐 때만 맞는다(Client-A 가 Client-AB 에 맞지 않게). */
export function documentMatches(title: string, req: DocCountRequest): boolean {
  const flat = (s: string) => s.replace(/\s+/g, "").toLowerCase();
  if (req.tag && !title.startsWith(req.tag)) return false;
  if (req.words && !flat(title).includes(flat(req.words))) return false;
  if (req.entity) {
    const name = req.entity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!new RegExp(`(?<![A-Za-z0-9])${name}(?![A-Za-z0-9])`).test(title)) return false;
  }
  return true;
}

/** 문서 개수 질문의 결정론 조회. 문서 뷰(제목 = 「문서 제목 — 절 제목」)에서 문서 제목을 적재 순서로 읽어 고른다. */
export async function documentCount(pool: Pool, req: DocCountRequest, table = profile().vectorTable): Promise<DocCountResult> {
  if (!/^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/.test(table)) throw new Error(`unsafe table identifier: ${table}`);
  try {
    const res = await pool.query(
      `SELECT split_part(title, ' — ', 1) AS title, min(id) AS first FROM ${table} GROUP BY 1 ORDER BY 2, 1`,
    );
    const all = res.rows.map((r) => String(r.title));
    return { request: req, ok: true, total: all.length, titles: all.filter((t) => documentMatches(t, req)) };
  } catch (err) {
    return { request: req, ok: false, total: 0, titles: [], error: describeError(err) };
  }
}

/** 받침이 있으면 「은」, 없으면 「는」. */
function topic(word: string): string {
  const c = word.charCodeAt(word.length - 1);
  return c >= 0xac00 && c <= 0xd7a3 && (c - 0xac00) % 28 !== 0 ? "은" : "는";
}

/** 문서 개수 질문의 답 문장. 7B 를 부르지 않는다. 제목은 열 건까지 적고 나머지는 건수만. */
export function documentCountAnswer(d: DocCountResult, max = 10): string {
  const subject = `${d.request.entity ? `${d.request.entity} 관련 ` : ""}${d.request.kind}`;
  const head = `문서 제목 기준으로 ${subject}${topic(subject)}`;
  if (!d.titles.length) return `${head} 없습니다(0건).`;
  const rest = d.titles.length - Math.min(max, d.titles.length);
  return `${head} ${d.titles.length}건입니다: ${d.titles.slice(0, max).join(", ")}${rest > 0 ? ` 외 ${rest}건` : ""}.`;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** SQL 값 하나를 모델이 읽을 표기로.
 *
 * node-postgres 는 date, timestamp 를 Date 로, interval 을 객체로 준다. 템플릿 문자열에
 * 그대로 넣으면 「Thu Aug 01 2024 00:00:00 GMT+0900」과 「[object Object]」가 컨텍스트에
 * 들어갔고, 기간을 묻는 질문은 정답 행을 찾고도 답할 수 없었다(홀드아웃 채점표에서 발견).
 * Date 는 드라이버가 로컬 시각으로 만들므로 로컬 성분으로 적는다 — toISOString 은 UTC 라
 * 한국 시간 자정의 날짜가 하루 앞당겨진다. */
export function renderValue(v: unknown): string {
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    const day = `${v.getFullYear()}-${pad2(v.getMonth() + 1)}-${pad2(v.getDate())}`;
    const midnight = !v.getHours() && !v.getMinutes() && !v.getSeconds() && !v.getMilliseconds();
    return midnight ? day : `${day} ${pad2(v.getHours())}:${pad2(v.getMinutes())}:${pad2(v.getSeconds())}`;
  }
  if (v && typeof v === "object" && "toPostgres" in v) {
    const iv = v as { years?: number; months?: number; days?: number; hours?: number; minutes?: number; seconds?: number };
    const parts: string[] = [];
    for (const [n, unit] of [
      [iv.years, "년"],
      [iv.months, "개월"],
      [iv.days, "일"],
      [iv.hours, "시간"],
      [iv.minutes, "분"],
      [iv.seconds, "초"],
    ] as const) {
      if (n) parts.push(`${n}${unit}`);
    }
    return parts.length ? parts.join(" ") : "0초";
  }
  return String(v);
}

function renderRow(row: Record<string, unknown>): string {
  return Object.entries(row)
    .map(([k, v]) => `${k}=${renderValue(v)}`)
    .join(" | ");
}

/** 정형 레인 답 끝에 그대로 싣는 조회 결과의 최대 행 수. 넘으면 남은 건수만 적는다. */
export const SQL_ROWS_MAX = 30;

/** 정형 레인 답의 끝에 붙이는 조회 결과. 값과 목록은 DB 가 말한다.
 *
 * 7B 는 SQL 결과를 읽고도 목록 일부나 열 하나를 빠뜨린다. 사업자 예시 5번 「기술지원팀
 * 직원 목록과 연봉」은 SQL 이 이름과 연봉 네 행을 돌려줬는데 답에는 이름만 있었다. 같은
 * 모델, 같은 시드인데 Ollama 0.34.2 에서 틀리고 0.35.0 에서 맞았다. 답의 정확도가 런타임
 * 버전 운에 달리지 않게, 행을 답에 그대로 싣는다. 모델은 문장을 쓰고 값은 옮겨 적지 않는다.
 * 싣는 행은 큐레이션이 모델에게 넘긴 행이다. 그래서 답에 나오는 값은 전부 컨텍스트에 있다
 * (companyx:ask 의 answer_grounded 가 그대로 성립한다). 예산 밖으로 밀린 행은 건수만 적는다.
 * 라우트는 묻지 않는다. hybrid 도 SQL 레인이 돌아 행을 돌려줬으면 붙인다(공동 1위 답 tieAnswer 와 같은 조건, 랜덤 테스트 사전 점검 3차 S06).
 * ANSWER_SQL_ROWS=0 은 검증용 제거 스위치다. */
export function sqlRowsBlock(rows: Record<string, unknown>[], total = rows.length, max = SQL_ROWS_MAX): string {
  if (!rows.length) return "";
  const shown = rows
    .slice(0, max)
    .map((r) => `- ${Object.entries(r).map(([k, v]) => `${k}: ${renderValue(v)}`).join(", ")}`);
  const rest = total > shown.length ? [`- 외 ${total - shown.length}건`] : [];
  return [`[조회 결과 ${total}건]`, ...shown, ...rest].join("\n");
}

function withSqlRows(r: RetrieveResult, text: string): string {
  if (!r.sql.result?.ok || process.env.ANSWER_SQL_ROWS === "0") return text;
  const seen = new Set(r.curated.kept.filter((it) => it.source.startsWith("sql#")).map((it) => Number(it.source.slice(4))));
  const rows = r.sql.result.rows.filter((_, i) => seen.has(i));
  const block = sqlRowsBlock(rows, r.sql.result.rows.length);
  return block ? `${text.trimEnd()}\n\n${block}` : text;
}

/** 큐레이터가 모델에 넘기는 컨텍스트 예산(토큰 근사). 256 → 1024 (2026-09-30).
 *
 * 채점 기준이 최종 답 일치라(리원에이스 멘토링 09-22) 답을 기준으로 골랐다. 개발용 세트(사업자 30,
 * 홀드아웃3 채점 가능 38)에서 서버와 같은 라우터 상태로 잰 정답 합이 256: 21+18=39, 512: 22+19=41,
 * 1024: 24+20=44. 256 에서 틀린 목록형 답은 근거가 잘려 목록 일부만 말한 것이었다. 규칙은
 * 「최고치에서 1문항 이내인 가장 작은 예산」이고 1024 만 해당한다. 봉인 홀드아웃4 는 따로 한 번 잰다. */
export const DEFAULT_BUDGET = 1024;

/** 라우팅 결정이 여는 레인. 개체를 지목했지만 신호가 모자라 hybrid 로 떨어진 질문은 라우터가 그래프 도구까지 연다
 * (router.ts 「entity-anchored fan-out」, route 도구의 tools). 종전에는 route 가 graph 일 때만 그래프를 돌아 그 세 번째
 * 레인이 실제로 돈 적이 없었다(G12, 홀드아웃3 의 「클라우드사업부 맨 위에 이름 뭐 써 있더라, 조직도에서」). */
export function lanesFor(decision: Pick<RouteDecision, "route" | "tools">): { sql: boolean; vector: boolean; graph: boolean } {
  const hybrid = decision.route === "hybrid";
  return {
    sql: decision.route === "structured" || hybrid,
    vector: decision.route === "semantic" || hybrid,
    graph: decision.route === "graph" || (hybrid && decision.tools.includes(GRAPH_TOOL)),
  };
}

/** hybrid 에서 돈 그래프 레인은 찾은 개체의 근거만 더한다. 못 찾았다는 판정(unresolved 의 not_found, 섞인 질문의 missing)과
 * 그 사유 줄은 그래프로 간 질문에서만 답을 정한다. hybrid 에서 쓰면 정형과 문서 레인에 답이 있어도 「찾지 못했습니다」로
 * 답하게 된다. */
export function hybridGraph(g: GraphLaneResult): GraphLaneResult {
  const out: GraphLaneResult = {
    ...g,
    items: g.items.filter((it) => it.provenance !== "ontology:unresolved" && it.provenance !== "ontology:missing"),
  };
  delete out.not_found;
  delete out.missing;
  delete out.answer_query;
  return out;
}

/** 앞 대화를 가리키는 말만 있는 질문의 결과. 레인을 열지 않았으므로 감사의 도구는 비우고, 규칙 라우터의 판단은 근거로만 남긴다. */
function backReferenceResult(query: string, mark: string, budget: number): RetrieveResult {
  const d = route(query);
  const curated = curate(query, [], budget);
  return {
    query,
    route: d.route,
    sql: { text: null },
    back_reference: mark,
    fused: [],
    fusion_lanes: [],
    curated,
    context: "",
    audit: {
      route: routeAudit({ ...d, tools: [], rationale: `refers to a previous turn (${mark}) -> not routed; the server keeps no previous question` }),
      candidates: { sql: 0, vector: 0, graph: 0, fused: 0 },
      branch_errors: [],
      curate: curateAudit(curated),
    },
  };
}

/** Run the retrieval spine for one query.
 * Deterministic parts: route (L3) + RRF merge + L4 curation. The structured
 * path's NL2SQL is the 7B by default (faithful to the brief; this is the path
 * the execution-match eval measures, so eval == live). Inject `nl2sql:
 * templateNL2SQL` for an offline, zero-LLM deterministic fast-path. */
export async function retrieve(query: string, deps: RetrieveDeps): Promise<RetrieveResult> {
  const { pool, embedder } = deps;
  const nl2sql = deps.nl2sql ?? profile().nl2sql;
  const k = deps.k ?? 5;
  const budget = deps.budget ?? DEFAULT_BUDGET;

  // 앞 대화를 가리키는 말만 있는 질문(「그럼 2위는?」)은 라우팅 전에 끝낸다(router.ts backReferenceOnly).
  const backRef = backReferenceOnly(query);
  if (backRef) return backReferenceResult(query, backRef, budget);

  // 규칙이 확신하지 못하면 시맨틱 폴백이 정한다. 폴백이 설치되지 않았으면 규칙만.
  const decision = await routeQuery(query, embedder);
  // 문서 개수 질문은 벡터 검색 대신 문서 제목을 센다(documentCount). 두 개체의 관계 질문은 두 개체 사이의 엣지만 읽는다(pairEdges).
  const docCount = decision.docCount;
  const pair = decision.pair;
  const lanes = lanesFor(decision);
  const wantSql = !docCount && !pair && lanes.sql;
  const wantVec = !docCount && !pair && lanes.vector;
  const wantGraph = !docCount && !pair && lanes.graph;

  // --- parallel fan-out (MCP Parallel): the vector branch starts immediately and
  // runs CONCURRENTLY with NL2SQL+SQL; allSettled isolates branches so a failure
  // in one (e.g. NL2SQL throws) still yields the other's context (graceful degradation). ---
  const sqlBranch = (async (): Promise<RetrieveResult["sql"]> => {
    if (!wantSql) return { text: null };
    // 없는 항목(나이, 성별, 고객사의 직원 수)을 묻는 질문은 생성 모델에 넘기지 않는다. 넘기면 다른 열로
    // 바꿔 답했다(랜덤 테스트 사전 점검 D2).
    const absent = absentAttribute(query, profile().schemaCard);
    if (absent) return { text: null, absent };
    // 측정 항목 한 낱말뿐인 요청(「매출 알려줘」)도 생성 모델에 넘기지 않고 대상을 되묻는다. 넘기면 7B 가 매출 표 전체를 고르고
    // 답 문장은 그 가운데 한 건의 값을 매출이라고 말했다(「매출은 1953입니다.」). 감사에는 sql-trust-gate deny 로 남는다.
    const vague = vagueMeasure(query, profile().sqlSchema);
    if (vague) return { text: null, gate: { outcome: "refused", rejected: [], vague } };
    const report: Nl2SqlReport = {};
    const missing = profile().name === "companyx" ? await sqlMissingNames(pool, query) : [];
    const generated = await nl2sql(query, report);
    const text = generated ? alignQualifiedTables(generated, query) : generated;
    if (!text) return report.refused ? { text: null, refused: report.refused } : { text: null };
    // 엔진이 거부하면(없는 컬럼 등) 그 오류를 한 번 되먹여 고친다 — 빈 컨텍스트가 두 번째
    // 호출보다 나쁘다. 평가(companyx:sql)도 같은 함수를 부른다. 외래키와 컬럼은 프로파일의 테이블이 있는
    // 스키마에서 읽는다. 종전에는 companyx 가 아니면 public 을 넘겨 bench 의 조인 검사가 꺼져 있었다(#255).
    const ex = await executeWithRepair(pool, query, text, {
      repair: deps.repair !== false,
      schema: profile().sqlSchema,
    });
    return {
      text: ex.text,
      result: ex.result,
      repaired: ex.repaired || undefined,
      ...(ex.gate ? { gate: ex.gate } : {}),
      ...(ex.rank ? { rank: ex.rank } : {}),
      ...(missing.length ? { missing } : {}),
    };
  })();
  const vecBranch: Promise<VectorResult | undefined> = wantVec
    ? vectorSearch(pool, embedder, query, k)
    : Promise.resolve(undefined);
  // The graph lane (L5): resolve the query's entities, then BFS their typed edges.
  // Runs concurrently with the other branches and is isolated the same way.
  const graphBranch: Promise<GraphLaneResult | undefined> = wantGraph
    ? graphLane(pool, query, k, 2, kgSchema(), decision.graphPlan)
    : Promise.resolve(undefined);
  // 키워드(희소) 레인. **기본은 꺼져 있다.**
  //
  // 왜 껐나. 68문항으로 재 보니 이 코퍼스에서는 융합이 순위를 떨어뜨렸다.
  // 밀집 hit@1 0.868 / MRR 0.913 대 무조건 융합 0.706 / 0.830, 식별자 조건으로
  // 게이트를 걸어도 0.838 / 0.894였다(eval/results/companyx-hybrid.json).
  // 문서가 40건뿐이라 밀집이 이미 hit@5 0.985로 천장에 붙어 있고, 약한 레인을
  // 같은 가중치로 섞으면 손해만 남는다. 가중치를 조정하면 개선되겠지만 그것은
  // 튜닝 파라미터를 하나 만드는 일이라 이 프로젝트의 전제와 충돌한다.
  //
  // 그래서 코드는 남기고 기본값만 끈다. 식별자가 지배적인 코퍼스나 문서 수가
  // 훨씬 큰 환경에서는 결과가 달라질 수 있고, 그때는 KEYWORD_LANE=1로 켠다.
  const keywordBranch: Promise<KeywordSearchResult | undefined> = wantVec && process.env.KEYWORD_LANE === "1"
    ? (async () => {
        const table = profile().name === "companyx" ? "companyx.document_chunks" : profile().vectorTable;
        if (!(await keywordIndexReady(pool, table))) return undefined;
        return keywordSearch(pool, query, k, table);
      })()
    : Promise.resolve(undefined);

  const docBranch: Promise<DocCountResult | undefined> = docCount ? documentCount(pool, docCount) : Promise.resolve(undefined);
  const pairBranch: Promise<GraphResult | undefined> = pair ? pairEdges(pool, pair.a, pair.b, kgSchema()) : Promise.resolve(undefined);

  const [sqlSettled, vecSettled, graphSettled, kwSettled, docSettled, pairSettled] = await Promise.allSettled([
    sqlBranch,
    vecBranch,
    graphBranch,
    keywordBranch,
    docBranch,
    pairBranch,
  ]);
  const docResult = docSettled.status === "fulfilled" ? docSettled.value : undefined;
  const pairOut = pairSettled.status === "fulfilled" ? pairSettled.value : undefined;
  const pairResult = pair && pairOut ? { ...pair, ...pairOut } : undefined;
  const sql: RetrieveResult["sql"] = sqlSettled.status === "fulfilled" ? sqlSettled.value : { text: null };
  const sqlText = sql.text;
  const sqlResult = sql.result;
  const vecResult = vecSettled.status === "fulfilled" ? vecSettled.value : undefined;
  const graphLaneOut = graphSettled.status === "fulfilled" ? graphSettled.value : undefined;
  const graphResult = graphLaneOut && decision.route === "hybrid" ? hybridGraph(graphLaneOut) : graphLaneOut;
  const kwResult = kwSettled.status === "fulfilled" ? kwSettled.value : undefined;
  const branchErrors: string[] = [];
  if (sqlSettled.status === "rejected") branchErrors.push(`sql: ${String(sqlSettled.reason)}`);
  if (vecSettled.status === "rejected") branchErrors.push(`vector: ${String(vecSettled.reason)}`);
  if (graphSettled.status === "rejected") branchErrors.push(`graph: ${String(graphSettled.reason)}`);
  if (kwSettled.status === "rejected") branchErrors.push(`keyword: ${String(kwSettled.reason)}`);
  if (kwResult && !kwResult.ok) branchErrors.push(`keyword: ${kwResult.error ?? "unknown"}`);
  if (graphResult?.error) branchErrors.push(`graph: ${graphResult.error}`);
  // ★ sql·vector 레인은 실패를 **던지지 않고 돌려준다**.
  //
  // 위의 rejected 검사만으로는 안 잡힌다 — `{ok:false, error}` 는 fulfilled 다.
  // 2026-08-17 실측: DB 가 죽은 상태에서 ask 가 "주어진 정보로는 알 수 없습니다" 로
  // 답하고 audit.explain 의 branch_errors 는 **빈 배열**이었다.
  //
  // 인프라 장애가 지식 부재로 위장된다. 접지 규율("모르면 모른다")이 장애를
  // 삼키는 통로가 되면 안 된다. 네 레인 중 keyword·graph 만 이 검사가 있었다.
  if (sqlResult && !sqlResult.ok) {
    branchErrors.push(`sql: ${sqlResult.error ?? "unknown"}`);
  }
  if (vecResult && !vecResult.ok) {
    branchErrors.push(`vector: ${vecResult.error ?? "unknown"}`);
  }
  if (docSettled.status === "rejected") branchErrors.push(`documents: ${String(docSettled.reason)}`);
  if (docResult && !docResult.ok) branchErrors.push(`documents: ${docResult.error ?? "unknown"}`);
  if (pairSettled.status === "rejected") branchErrors.push(`graph: ${String(pairSettled.reason)}`);
  if (pairOut && !pairOut.ok) branchErrors.push(`graph: ${pairOut.error ?? "unknown"}`);

  // --- normalize each path into a ranked candidate list of ContextItems ---
  const lists: Ranked<ContextItem>[][] = [];
  const listLanes: string[] = [];
  if (sqlResult?.ok) {
    // Each SQL row is an atomic context item, prefixed with the query that
    // produced it so the 7B can ground its answer (a bare "count=3" is
    // unanchored; "SELECT ... WHERE amount>=10000 → count=3" is self-explaining).
    const sqlHead = `[SQL 결과] ${sqlText}`;
    lists.push(
      sqlResult.rows.map((row, i) => ({
        key: `sql#${i}`,
        value: { kind: "row" as const, text: `${sqlHead} → ${renderRow(row)}`, source: `sql#${i}`, fields: Object.keys(row).length },
      })),
    );
    listLanes.push("sql");
  }
  if (vecResult?.ok) {
    lists.push(
      vecResult.hits.map((h) => ({
        key: `documents#${h.id}`,
        value: { kind: "chunk", text: `${h.title}: ${h.body}`, source: `documents#${h.id}` },
      })),
    );
    listLanes.push("vector");
  }
  if (kwResult?.ok && kwResult.hits.length) {
    // 벡터 레인과 같은 key 규칙(documents#id)을 쓴다. 같은 청크를 두 레인이 찾으면
    // RRF가 교차 소스 합의로 인식해 순위를 올린다. 그것이 하이브리드의 이득이다.
    lists.push(
      kwResult.hits.map((h) => ({
        key: `documents#${h.id}`,
        value: { kind: "chunk" as const, text: `${h.title}: ${h.body}`, source: `keyword#${h.id}` },
      })),
    );
    listLanes.push("keyword");
  }
  if (graphResult && graphResult.items.length) {
    lists.push(
      graphResult.items.map((it, i) => ({
        key: it.canonicalKey,
        value: { kind: "chunk" as const, text: it.text, source: `graph#${i}` },
      })),
    );
    listLanes.push("graph");
  }
  if (docResult?.ok) {
    // 센 결과 한 줄과 고른 문서 제목. 답 문장(documentCountAnswer)의 제목과 개체가 모두 컨텍스트에 있다.
    const what = `${docResult.request.entity ? `${docResult.request.entity} 관련 ` : ""}${docResult.request.kind}`;
    lists.push([
      {
        key: "documents#count",
        value: { kind: "chunk" as const, text: `[문서 개수] 문서 ${docResult.total}건 가운데 제목 기준 ${what}: ${docResult.titles.length}건`, source: "documents#count" },
      },
      ...docResult.titles.map((t, i) => ({
        key: `documents#title:${t}`,
        value: { kind: "chunk" as const, text: `[문서] ${t}`, source: `documents#t${i}` },
      })),
    ]);
    listLanes.push("documents");
  }
  const pairText = pairResult?.ok ? pairLines(pairResult) : [];
  if (pairText.length) {
    lists.push(pairText.map((text, i) => ({ key: `pair#${i}`, value: { kind: "chunk" as const, text, source: `graph#${i}` } })));
    listLanes.push("graph");
  }

  // --- RRF merge -> L4 curation ---
  const fused = rrfMerge(lists);
  const curated = curate(query, fused.map((f) => f.value), budget);

  return {
    query,
    route: decision.route,
    sql: {
      text: sqlText,
      result: sqlResult,
      repaired: sql.repaired,
      ...(sql.gate ? { gate: sql.gate } : {}),
      ...(sql.refused ? { refused: sql.refused } : {}),
      ...(sql.absent ? { absent: sql.absent } : {}),
      ...(sql.rank ? { rank: sql.rank } : {}),
      ...(sql.missing ? { missing: sql.missing } : {}),
    },
    vector: vecResult,
    graph: graphResult ?? (pairResult ? { seeds: [], edgeCount: pairResult.edges.length, strategy: "pair", items: [] } : undefined),
    ...(docResult ? { documents: docResult } : {}),
    ...(pairResult ? { pair: pairResult } : {}),
    fused,
    fusion_lanes: listLanes,
    curated,
    context: render(curated),
    ...(graphResult?.not_found ? { not_found: graphResult.not_found } : {}),
    ...(graphResult?.missing?.length ? { missing: graphResult.missing, answer_query: graphResult.answer_query } : {}),
    audit: {
      route: routeAudit(decision),
      candidates: {
        sql: sqlResult?.ok ? sqlResult.rows.length : 0,
        vector: vecResult?.ok ? vecResult.hits.length : 0,
        graph: graphResult?.items.length ?? pairText.length,
        fused: fused.length,
      },
      branch_errors: branchErrors,
      curate: curateAudit(curated),
      ...(graphResult?.not_found ? { not_found: graphResult.not_found } : {}),
      ...(graphResult?.missing?.length ? { missing_entities: graphResult.missing } : {}),
      ...(graphResult?.truncated ? { graph_truncated: graphResult.truncated } : {}),
      ...(graphResult?.fitted ? { graph_fitted: graphResult.fitted } : {}),
      ...(sql.gate ? { sql_gate: sql.gate } : {}),
    },
  };
}

// --- end-to-end ask: retrieve -> 7B answer over the curated context ---

export type AnswerFn = (query: string, context: string) => Promise<string>;

/** 쓰기 요청의 답. 바뀐 것이 없으므로 무엇을 했다고 말하지 않는다(시험항목 TC-145, TC-146 은
 * 답에 「변경」, 「삭제」, 「완료」, 「했습니다」가 없어야 한다). */
export function writeRefusal(kind: string): string {
  return (
    "데이터를 바꾸는 요청은 처리하지 않습니다. 이 서버는 읽기 전용이라 조회만 하며, " +
    `생성 모델이 만든 ${kind} 문은 실행하지 않았습니다.`
  );
}

/** 생성 SQL 이 테이블을 읽지 않는 상수 SELECT 뿐이고 다른 근거도 없을 때의 답. */
export const NO_TABLE_ANSWER =
  "주어진 정보로는 알 수 없습니다. 이 질문에 답할 데이터가 데이터베이스에 없어 조회하지 않았습니다.";

export interface AskResult extends RetrieveResult {
  answer: string;
  /** 7B 답의 근거 밖 이름(withoutOutsideNames)과 자릿수가 틀린 SQL 값(scaleSlip)을 다룬 내역. 그런 것이 있었을 때만. */
  grounding_fix?: { removed: string[]; flagged: string[]; value?: { from: string; to: string } };
}

/** 그래프 집계의 「가장 적은」(시드 없는 관계 스캔, 계획 order=asc)에서 공동 1위가 둘 이상일 때의 답 문장. 7B 를 부르지 않는다.
 *
 * 「담당하는 고객사가 가장 적은 직원은 누구야?」는 담당 고객사가 없는 직원 15명이 공동이다(1곳은 9명). 7B 는 컨텍스트의
 * 순위 줄에서 몇 명만 골라 말한다. SQL 의 공동 1위 답(sqltrust.ts tieAnswer)과 같은 말로, 모델에게 간 줄의 이름을 다 적는다. */
export function fewestAnswer(r: RetrieveResult): string | undefined {
  const f = r.graph?.fewest;
  if (r.route !== "graph" || r.graph?.strategy !== "relation-scan" || !f || f.entries.length < 2) return undefined;
  const kept = new Set(r.curated.kept.map((it) => it.text));
  const shown = f.entries.filter((e) => kept.has(e.text));
  if (!shown.length) return undefined;
  const rest = f.entries.length - shown.length;
  return (
    `가장 적은 쪽 공동 1위가 ${f.entries.length}건입니다(${relLabel(f.relType)} ${f.count}건): ` +
    `${shown.map((e) => e.name).join(", ")}${rest > 0 ? ` 외 ${rest}건` : ""}.`
  );
}

/** 앞 대화를 가리키는 말만 있는 질문의 답(router.ts backReferenceOnly). 7B 를 부르지 않는다. */
export const BACK_REFERENCE_ANSWER =
  "이 서버는 앞 질문을 기억하지 않습니다. 대상(고객사, 제품, 기간)을 넣어 질문 전체를 다시 입력해 주세요.";

/** 두 개체 사이에 엣지가 없을 때의 문장. */
export const PAIR_NONE = "두 개체 사이에 직접 연결된 관계가 없습니다";

/** 두 개체의 관계 질문의 컨텍스트 줄. 엣지는 그래프 레인과 같은 꼴, 없으면 그 사실 한 줄. */
export function pairLines(p: { a: string; b: string; edges: GraphEdge[] }): string[] {
  if (!p.edges.length) return [`[그래프] ${PAIR_NONE}(조회한 개체: ${p.a}, ${p.b}).`];
  return [...new Set(edgeCandidates(p.edges).map((c) => c.text))];
}

/** 두 개체의 관계 질문의 답. 두 방향의 직접 엣지를 컨텍스트 줄과 같은 관계 이름으로 적는다. 7B 를 부르지 않는다. */
export function pairAnswer(p: { a: string; b: string; edges: GraphEdge[] }): string {
  if (!p.edges.length) return `${PAIR_NONE}(조회한 개체: ${p.a}, ${p.b}. 다른 개체를 거치는 관계는 보지 않았습니다).`;
  const facts = [...new Set(p.edges.map((e) => `${e.srcName}의 ${relLabel(e.relType)}: ${e.dstName} (${e.relType})`))];
  return `두 개체 사이에 직접 연결된 관계는 ${facts.length}건입니다: ${facts.join("; ")}.`;
}

/** 상태 조건을 건 관계 목록의 말. 조건은 도착 끝(프로젝트)에 걸리고 답은 출발 끝이다. asks 는 질문이 출발 끝을 묻는지 본다. */
const FILTERED_LIST: Record<string, { tail: string; noun: string; counter: string; asks: RegExp }> = {
  LEADS: { tail: "프로젝트를 이끄는", noun: "직원", counter: "명", asks: /직원|사람|누구|담당자|리더|팀원|사원/ },
  HAS_PROJECT: { tail: "프로젝트가 있는", noun: "고객사", counter: "곳", asks: /고객사|고객|거래처|회사|어디/ },
};
const STATUS_KO: Record<string, string> = { in_progress: "진행 중", completed: "완료", planning: "계획 단계", on_hold: "보류" };

/** 상태 조건을 건 관계 스캔의 답(「완료된 프로젝트를 이끈 직원 목록」). 7B 를 부르지 않는다.
 *
 * 컨텍스트 줄(「이지훈의 이끄는 프로젝트: Client-AB DevOps 전환」)에는 거른 상태가 없어 7B 는 「완료된」을 확인할 근거가
 * 없다며 「알 수 없습니다」라고 답했다(랜덤 테스트 사전 점검 3차 Q4, 정답 6줄이 컨텍스트에 있었다). 같은 길의 TC-130(진행 중,
 * 11명)도 이 문장으로 답한다. 이름은 컨텍스트에 남은 줄의 순서로 적고, 예산에 잘린 줄에만 있는 이름은 수만 적는다. */
export function filteredListAnswer(r: RetrieveResult, query: string): string | undefined {
  const f = r.graph?.filtered;
  if (r.route !== "graph" || r.graph?.strategy !== "relation-scan" || !f?.complete || f.filter.side !== "target") return undefined;
  const rels = [...new Set(f.entries.map((e) => e.relType))];
  const w = rels.length === 1 ? FILTERED_LIST[rels[0]] : undefined;
  if (!w || !w.asks.test(query)) return undefined;
  const kept = new Set(r.curated.kept.map((it) => it.text));
  const all = [...new Set(f.entries.map((e) => e.src))];
  const shown = [...new Set(f.entries.filter((e) => kept.has(e.text)).map((e) => e.src))];
  const status = `${STATUS_KO[f.filter.value] ?? f.filter.value}(${f.filter.value})`;
  const head = `상태가 ${status}인 ${w.tail} ${w.noun}`;
  if (!all.length) return `${head}${topic(w.noun)} 없습니다.`;
  const rest = all.length - shown.length;
  return `${head}${topic(w.noun)} ${all.length}${w.counter}입니다: ${shown.join(", ")}${rest > 0 ? ` 외 ${rest}${w.counter}` : ""}.`;
}

/** 부정 조건(「담당하지 않는」, 「고객사가 없는」, 「안 맡은」). 「없는데」, 「기억 안 나는데」는 조건이 아니다. */
const NEGATION = /지\s*않|없는(?![가-힣])|안\s*(?:맡|쓰|하|이끄|이끈|담당|사용|관리)[가-힣]*[는은](?![가-힣])/;
/** 사람을 묻는 말. 부정 조건 뒤에 와야 「그 조건의 사람」을 묻는 것이다. */
const PERSON_ASKED = /직원|사람|누구|팀원|사원|멤버/;
/** 출발 끝이 직원인 관계(직원 → 고객사, 직원 → 프로젝트). 부서 소속 직원과 차집합을 낼 수 있다. */
const MEMBER_RELATIONS = new Set(["MANAGES_ACCOUNT", "LEADS"]);
export const NEGATION_ANSWER =
  "이 서버는 부정 조건(「…하지 않는」, 「…이 없는」)을 계산하지 않습니다. 지식그래프는 있는 관계만 따라가므로 없는 관계를 찾는 질문에는 답하지 않았습니다.";
export const THREE_HOP_ANSWER =
  "이 서버는 세 단계 이상 이어지는 관계(예: 고객사 → 담당자 → 부서 → 같은 부서 직원)는 계산하지 않습니다. 중간 대상의 이름(예: 담당자 이름)을 넣어 다시 물어 주세요.";

/** 그래프 레인이 답할 수 없는 꼴의 질문. 부정 조건과 세 단계 관계다. 「영업팀 직원 중 고객사를 담당하지 않는 사람은?」과 「Client-K
 * 담당자와 같은 부서 사람은 누구야?」에 7B 는 「알 수 없습니다」라고 답했고, 데이터에 답이 없다는 뜻으로 읽혔다(랜덤 테스트 사전 점검
 * 3차 Q11). 「부서 소속 직원 가운데 그 관계가 없는 사람」 꼴만 차집합으로 계산하고(membersWithout), 나머지는 계산하지 않는다고 답한다. */
export async function graphLimitAnswer(pool: Pool, r: RetrieveResult, query: string): Promise<string | undefined> {
  if (r.route !== "graph" || !r.graph || r.graph.strategy === "unresolved" || r.missing?.length) return undefined;
  const named = entitiesIn(query);
  const neg = NEGATION.exec(query);
  if (neg) {
    const dept = named.find((e) => e.type === "department");
    const plan = (r.audit.route as { graph_plan?: GraphPlan | null }).graph_plan;
    const rel = plan?.relTypes[0];
    if (dept && rel && MEMBER_RELATIONS.has(rel) && PERSON_ASKED.test(query.slice(neg.index))) {
      const m = await membersWithout(pool, dept.name, rel);
      if (m.ok && m.members.length) {
        const cond = `${relLabel(rel)}(${rel})`;
        const head = `${dept.name} 소속 직원 ${m.members.length}명 가운데`;
        return m.without.length
          ? `${head} ${cond}가 없는 직원은 ${m.without.length}명입니다: ${m.without.join(", ")}.`
          : `${head} ${cond}가 없는 직원은 없습니다.`;
      }
    }
    return NEGATION_ANSWER;
  }
  if (/같은\s*(?:부서|팀|소속)/.test(query) && named.length && !named.some((e) => e.type === "employee")) return THREE_HOP_ANSWER;
  return undefined;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** text[at] 를 품은 문장의 [시작, 끝). 소수점(「22.04」)은 문장 끝이 아니다. */
function sentenceAround(text: string, at: number): [number, number] {
  let s = at;
  while (s > 0 && !/[\n!?]/.test(text[s - 1]) && !(text[s - 1] === "." && /\s/.test(text[s] ?? ""))) s--;
  let e = at;
  while (e < text.length && !/[\n!?]/.test(text[e])) {
    if (text[e] === "." && /\s|$/.test(text[e + 1] ?? "")) return [s, e + 1];
    e++;
  }
  return [s, e];
}

/** 7B 답이 근거(컨텍스트)에도 질문에도 없는 이름(auditrecord.ts outsideContextMentions)을 사실처럼 말하지 않게 한다.
 *
 * 「Product-T2 관련 고객 이슈 현황은?」에 근거 13곳에 없는 Client-L 을 더해 「총 14건」이라 답했고, 감사 레코드의 접지 검사가
 * Client-L 을 잡고도 답은 그대로 나갔다(랜덤 테스트 사전 점검 3차 Q3, 3/3). 식별자(Client-L)가 쉼표 목록이나 머리표 줄의 한 항목이면
 * 그 항목을 빼고, 그 목록을 센 수(「총 14건」)가 항목 수와 같으면 하나 줄인다. 목록이 아니라 문장 속에 있으면 빼면 문장이 깨지므로
 * 답 끝에 그 이름이 근거에 없다는 줄을 붙인다. 근거 밖 이름이 없으면 답은 그대로다. */
export function withoutOutsideNames(
  answer: string,
  context: string,
  query: string,
): { text: string; removed: string[]; flagged: string[] } {
  const names = outsideContextMentions(answer, `${context}\n${query}`);
  if (!names.length) return { text: answer, removed: [], flagged: [] };
  let text = answer;
  const removed: string[] = [];
  const flagged: string[] = [];
  for (const name of names) {
    const n = escapeRe(name);
    const isId = /^[A-Z][A-Za-z]*-[A-Z0-9]+$/.test(name);
    const item = `${n}(?![A-Za-z0-9-])(?:\\s*\\([^)\\n]*\\))?`;
    const bullet = new RegExp(`^[ \\t]*(?:[-*•]|\\d+[.)])[ \\t]*${item}[^\\n]*(?:\\n|$)`, "m");
    const at = text.search(new RegExp(`(?<![A-Za-z0-9-])${n}(?![A-Za-z0-9-])`));
    let done = false;
    if (isId && bullet.test(text)) {
      const count = (s: string) => (s.match(/^[ \t]*(?:[-*•]|\d+[.)])[ \t]*\S/gm) ?? []).length;
      const before = count(text);
      text = text.replace(bullet, "").replace(new RegExp(`(?<!\\d)${before}(\\s*(?:건|곳|개|명|군데))`), `${before - 1}$1`);
      done = true;
    } else if (isId && at >= 0) {
      const [s, e] = sentenceAround(text, at);
      const sentence = text.slice(s, e);
      const prefix = name.slice(0, name.indexOf("-") + 1);
      const ids = new Set(sentence.match(new RegExp(`(?<![A-Za-z0-9-])${escapeRe(prefix)}[A-Z0-9]+(?![A-Za-z0-9-])`, "g")) ?? []);
      const patterns = [
        new RegExp(`\\s*[,，、]\\s*${item}`),
        new RegExp(`(?<![A-Za-z0-9-])${item}\\s*[,，、]\\s*`),
        new RegExp(`(?:(?<=[A-Za-z0-9가-힣)])(?:와|과)|\\s+(?:및|그리고))\\s+${item}`),
        new RegExp(`(?<![A-Za-z0-9-])${item}(?:와|과)\\s+`),
      ];
      const p = ids.size >= 2 ? patterns.find((re) => re.test(sentence)) : undefined;
      if (p) {
        const cut = sentence
          .replace(p, "")
          .replace(new RegExp(`(?<!\\d)${ids.size}(\\s*(?:건|곳|개|명|군데))`), `${ids.size - 1}$1`);
        text = text.slice(0, s) + cut + text.slice(e);
        done = true;
      }
    }
    if (done) removed.push(name);
    if (!done || new RegExp(`(?<![A-Za-z0-9-])${n}(?![A-Za-z0-9-])`).test(text)) flagged.push(name);
  }
  if (flagged.length) {
    text = `${text.trimEnd()}\n\n근거에 없는 이름이 답에 섞여 있어 사실로 볼 수 없습니다: ${flagged.join(", ")}.`;
  }
  return { text, removed, flagged };
}

/** 답 문장의 수 하나. 천 단위 쉼표와 소수점을 받고, 영문자, 숫자, 하이픈, 슬래시, 콜론, 점, 쉼표에 붙은 수(Product-C1, 2025-Q3,
 * 2026-06-27, 14:30)는 수로 보지 않는다. */
const ANSWER_NUMBER = /(?<![\w.,\-/:])(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?![\w\-/:]|[.,]\d)/g;
/** 뒤에 오면 그 수를 고치지 않는 말: 때와 순서(2026년, 3분기, 2위), 비율(15%), 우리말 큰 수 단위(1억, 5천만). */
const NOT_A_VALUE_AFTER = /^\s*(?:년|분기|월|일|시|분|초|주|위|번|차|호|회|개월|배|%|％|퍼센트|프로|억|만|천|백|십|조)/;
/** 비율을 묻는 질문. 계산한 비율은 수의 자릿수가 바뀌는 것이 정상이라(0.155 → 15.5%) 보지 않는다. */
const RATIO_QUESTION = /비율|비중|퍼센트|백분율|%|％|증감률|증가율|감소율|성장률|점유율|몇\s*배/;

/** SQL 값 하나의 수. 숫자거나 숫자만 든 글(bigint, numeric 은 글로 온다)일 때만. */
function sqlNumber(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string" && /^-?\d+(?:\.\d+)?$/.test(v.trim())) return Number(v);
  return undefined;
}

/** 7B 답이 SQL 값 하나를 10배, 100배 … 틀리게 옮겨 적은 것을 그 값으로 되돌린다.
 *
 * 「올해 상반기 매출 합계 알려줘」는 조회 행이 total_sales: 58753 인데 답 문장이 「… 매출 합계는 587,530입니다.」였다(6회 중 2회,
 * 답 프롬프트는 같음). 조회 결과가 한 행에 수 하나(V)이고, 답에 V 가 어떤 꼴(그대로, 쉼표, 답에 적힌 자릿수로 반올림)로도 없으며,
 * 답의 수 N 이 V × 10^k(k = ±1~±4) 하나뿐일 때만 그 N 을 쉼표 꼴의 V 로 바꾼다. 때와 순서, 비율, 우리말 단위가 붙은 수, 해(2026)
 * 같은 수, 만원을 원으로 바꿔 적은 수(V × 10^3, 10^4 뒤에 「원」)는 손대지 않는다. 그 밖에는 답을 그대로 둔다. */
export function scaleSlip(text: string, rows: Record<string, unknown>[], query: string): { text: string; from?: string; to?: string } {
  if (rows.length !== 1 || RATIO_QUESTION.test(query)) return { text };
  const values = Object.values(rows[0]).map(sqlNumber).filter((v): v is number => v !== undefined);
  if (values.length !== 1 || values[0] === 0) return { text };
  const v = values[0];
  const numbers = (s: string) => [...s.matchAll(ANSWER_NUMBER)].map((m) => ({ at: m.index!, raw: m[0], n: Number(m[0].replace(/,/g, "")) }));
  const tokens = numbers(text);
  // 답에 V 가 이미 있으면(답에 적힌 자릿수로 반올림해 같으면) 다른 수는 V 가 아니다.
  const decimals = (raw: string) => Math.min(20, (raw.split(".")[1] ?? "").length);
  if (tokens.some((t) => Number(Math.abs(v).toFixed(decimals(t.raw))) === t.n)) return { text };
  const close = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(Math.abs(a), Math.abs(b));
  // 질문에 있는 수(「상위 50개」)를 답이 되풀이한 것은 옮겨 적은 값이 아니다.
  const asked = new Set(numbers(query).map((t) => t.n));
  const slips = tokens.filter((t) => {
    const after = text.slice(t.at + t.raw.length);
    if (!t.n || asked.has(t.n) || NOT_A_VALUE_AFTER.test(after) || /^(?:19|20)\d\d$/.test(t.raw)) return false;
    const k = [1, 2, 3, 4, -1, -2, -3, -4].find((e) => close(t.n, Math.abs(v) * 10 ** e));
    return k !== undefined && !(k >= 3 && /^\s*원/.test(after));
  });
  const plain = String(Math.abs(v));
  if (!slips.length || new Set(slips.map((t) => t.n)).size !== 1 || /e/i.test(plain)) return { text };
  const [int, frac] = plain.split(".");
  const to = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (frac ? `.${frac}` : "");
  let out = text;
  for (const t of [...slips].reverse()) out = out.slice(0, t.at) + to + out.slice(t.at + t.raw.length);
  return { text: out, from: slips[0].raw, to };
}

/** 문서 전체나 최근을 묻는 말. 「보고서들」의 「들」은 명사 뒤 복수일 때만(「들어온」, 「만들어」는 아니다). 「정리」는 정리해 달라는
 * 요청일 때만(「문서로 정리된 게 있나?」는 아니다). */
const ALL_OR_RECENT = /[가-힣]들(?=[은는이가을를의에과와도만]|\s|$|[?？!.,])|모든|전부|전체|정리\s*(?:해|하여|좀)|요즘|최근/;

/** 문서 레인 답이 검색 상위 조각만 본 것을 밝히는 줄. 「장애 보고서들에 나온 장애 원인을 정리해줘」에 세 유형 가운데 하나만,
 * 「요즘 서버 장애 난 거 원인이 뭐였어?」에 최근이 아닌 장애의 원인을 답했다(랜덤 테스트 사전 점검 3차 Q10). 질문이 전체, 정리,
 * 최근을 물을 때만 붙인다. */
export function documentScopeNote(r: RetrieveResult, query: string): string | undefined {
  if (r.route !== "semantic" || r.documents || !r.vector?.ok || !ALL_OR_RECENT.test(query)) return undefined;
  const n = r.curated.kept.filter((it) => it.source.startsWith("documents#")).length;
  if (!n) return undefined;
  const recent = /요즘|최근/.test(query);
  return `이 답은 검색 상위 ${n}개 조각만 근거로 했습니다. 문서 전체를 다 ${recent ? "보거나 날짜순으로 고른" : "본"} 것은 아닙니다.`;
}

/** Full pipeline: deterministic retrieval spine + the on-prem 7B answer step.
 * `llm` is injectable so the eval / tests can substitute a stub. */
export async function ask(
  query: string,
  deps: RetrieveDeps & { llm?: AnswerFn },
): Promise<AskResult> {
  const r = await retrieve(query, deps);

  // 앞 대화를 가리키는 말만 있는 질문은 조회하지 않았다. 다시 물어 달라고 답한다.
  if (r.back_reference) return { ...r, answer: BACK_REFERENCE_ANSWER };

  // 생성 모델이 쓰기 문장을 만들었다면 질문은 데이터를 바꾸라는 요청이다. 실행하지 않았고 이 서버는
  // 바꾸지 않으므로 그렇게 말한다. 종전에는 빈 컨텍스트로 7B 를 불러 「주어진 정보로는 알 수 없습니다」라고
  // 답했다 — 데이터가 없다는 뜻으로 읽힌다(G17 ②).
  const refused = r.sql.refused;
  if (refused && refused.kind !== NO_TABLE) {
    return { ...r, answer: writeRefusal(refused.kind) };
  }
  // 묻는 항목이 데이터에 없고 다른 레인의 근거도 없다. 7B 없이 그렇게 답한다.
  if (r.sql.absent && r.context.length === 0) {
    return { ...r, answer: describeAbsentAttribute(r.sql.absent) };
  }
  // 실행 전 검사가 생성 SQL 을 모두 거부했다. 모델에게 쓰게 하지 않고 그 사실과 다시 물을 방법을 말한다.
  if (r.sql.gate?.outcome === "refused") return { ...r, answer: untrustedAnswer(r.sql.gate) };

  // ★ 근거가 없는 것과 근거를 **가져올 수 없는** 것은 다르다.
  //
  // 2026-08-17 실측: DB 가 죽은 상태에서도 ask 는 "주어진 정보로는 알 수 없습니다"
  // 라고 답했다. 접지 규율은 옳지만, 그 문장은 **데이터셋에 그 내용이 없다**는 뜻이다.
  // 인프라 장애를 그 문장으로 덮으면 사용자는 시스템이 모른다고 읽는다 —
  // 실제로는 자기 설정이 틀린 것인데.
  //
  // 컨텍스트가 비었고 **동시에** 레인이 실패했다면 LLM 을 부르지 않는다.
  // 답을 지어내지 않되, 왜 답할 수 없는지는 정확히 말한다.
  const branchErrors = r.audit?.branch_errors ?? [];
  if (r.context.length === 0 && branchErrors.length > 0) {
    return {
      ...r,
      answer:
        "조회에 실패해 답할 근거를 가져오지 못했습니다. 데이터가 없는 것이 아니라 " +
        `조회 자체가 실패했습니다: ${branchErrors.join(" / ")}`,
    };
  }

  // 문서 개수 질문은 제목으로 센 수와 제목을 그대로 답한다. 7B 는 조각을 보고 수를 셌다(「2건」, 실제 1건).
  if (r.documents?.ok) return { ...r, answer: documentCountAnswer(r.documents) };
  // 두 개체의 관계 질문은 두 개체 사이의 직접 엣지로 답한다.
  if (r.pair?.ok) return { ...r, answer: pairAnswer(r.pair) };

  // 게이트가 개체를 못 찾았으면 답할 내용은 이미 정해져 있다. 7B 에게 다시 쓰게 하면
  // 사유가 빠진다 — 실측 답은 「주어진 정보로는 알 수 없습니다」 한 줄이었다.
  if (r.not_found) {
    return { ...r, answer: describeNotFound(r.not_found) };
  }

  // 테이블을 읽지 않는 SELECT 만 나왔고 다른 근거도 없다. 데이터에 답이 없는 질문이다.
  if (refused && r.context.length === 0) {
    return { ...r, answer: NO_TABLE_ANSWER };
  }

  // 공동 1위(WITH TIES 로 2행 이상)와 순위 질문의 공동 순위(rankRewrite 로 2행 이상)는 이름을 모두 적는 결정론 문장으로
  // 답한다(sqltrust.ts tieAnswer). 질문에 없는 개체가 섞였으면 그 사유를 먼저 말해야 하므로 아래 길로 간다.
  // 정형 레인 질문이 데이터에 없는 개체를 이름으로 지목했고 생성 SQL 이 그 이름을 그대로 찾았으면 그 사유를 답 앞에 붙인다
  // (sqlMissingNames). SQL 이 그 이름을 찾지 않았으면(모델이 다른 이름으로 찾았으면) 사유와 답이 어긋나 붙이지 않는다.
  const sqlMissing = (r.sql.missing ?? []).filter((nf) => r.sql.text?.includes(nf.query_entity));
  const missingSqlHead = sqlMissing.length ? `${sqlMissing.map(describeNotFound).join(" ")}\n\n` : "";
  const tie = (r.missing ?? []).length ? null : tieAnswer(r, renderValue);
  if (tie) return { ...r, answer: missingSqlHead + withSqlRows(r, tie) };
  // 그래프 집계의 「가장 적은」이 공동이면 같은 방식으로 이름을 모두 적는다.
  const few = fewestAnswer(r);
  if (few) return { ...r, answer: few };
  // 상태 조건을 건 관계 목록은 조건과 이름을 결정론으로 적는다. 부정 조건과 세 단계 관계는 계산하거나 계산하지 않는다고 말한다.
  const listed = filteredListAnswer(r, query);
  if (listed) return { ...r, answer: listed };
  const limit = await graphLimitAnswer(deps.pool, r, query);
  if (limit) return { ...r, answer: limit };

  // 섞인 질문에서 없는 개체는 결정론 문장으로 먼저 말하고, 7B 는 그 개체가 든 마디를 뺀 질문에
  // 찾은 개체의 근거로만 답한다. 사유 줄은 7B 컨텍스트에서 뺀다(같은 말을 두 번 하지 않게).
  const missingLines = new Set((r.missing ?? []).map((nf) => `[그래프] ${describeNotFound(nf)}`));
  const head = (missingLines.size ? `${(r.missing ?? []).map(describeNotFound).join(" ")}\n\n` : "") + missingSqlHead;
  const answerContext = missingLines.size
    ? r.context.split("\n").filter((l) => !missingLines.has(l)).join("\n")
    : r.context;

  const gen = deps.llm ?? llmAnswer;
  try {
    const generated = await gen(r.answer_query ?? query, answerContext);
    // 근거에도 질문에도 없는 이름은 사실로 남기지 않는다(withoutOutsideNames). 정형 레인의 값 하나를 10의 거듭제곱만큼 틀리게
    // 옮겨 적었으면 조회 값으로 되돌린다(scaleSlip). 문서 레인이 상위 조각만 본 것은 밝힌다.
    const fix = withoutOutsideNames(generated, r.context, query);
    const scaled = r.route === "structured" && r.sql.result?.ok ? scaleSlip(fix.text, r.sql.result.rows, query) : { text: fix.text };
    const note = documentScopeNote(r, query);
    const answer = note ? `${scaled.text.trimEnd()}\n\n${note}` : scaled.text;
    const value = scaled.from !== undefined && scaled.to !== undefined ? { value: { from: scaled.from, to: scaled.to } } : {};
    return {
      ...r,
      answer: head + withSqlRows(r, answer),
      ...(fix.removed.length || fix.flagged.length || scaled.from !== undefined
        ? { grounding_fix: { removed: fix.removed, flagged: fix.flagged, ...value } }
        : {}),
    };
  } catch (e) {
    // ★ 생성 LLM 이 **기동 후** 죽는 경우.
    //
    // 기동 시 부재는 프리플라이트가 정확히 안내한다. 운영 중 컨테이너가 내려가는
    // 경우는 그 검사를 이미 지났다 — 2026-08-17 실측에서 `AggregateError` 가
    // `message: ""` 인 채로 그대로 던져졌고, 사용자는 **빈 이유**를 받았다.
    //
    // 조회는 성공했다. "조회 실패" 로 뭉뚱그리지 않고 생성만 실패했다고 말한다 —
    // 근거는 있으니 사용자가 컨텍스트를 직접 볼 수도 있다.
    const why = describeError(e);
    return {
      ...r,
      // 정형 레인이면 조회 결과는 생성 없이도 보여줄 수 있다.
      answer:
        head +
        withSqlRows(
          r,
          // 건수는 큐레이션이 남긴 항목 수다. context.length 는 글자 수라 「412건」이 됐다.
          `근거는 ${r.curated.kept.length}건 찾았지만 답변 생성에 실패했습니다: ${why}\n` +
            "로컬 LLM(Ollama)이 떠 있는지 확인하세요. 근거 자체는 audit 의 context 에 있습니다.",
        ),
      audit: {
        ...r.audit,
        branch_errors: [...(r.audit?.branch_errors ?? []), `answer: ${why}`],
      },
    };
  }
}
