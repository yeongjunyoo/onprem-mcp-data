// L3 — deterministic rule-based parallel router (MCP Parallel pattern).
// Ported from the validated Python prototype (prototype/router.py, tests 6/6),
// extended in the CompanyX increment with the third retrieval lane.
//
// Classifies a Korean query and decides which DB tools to fan out to:
//   STRUCTURED -> sql.query | SEMANTIC -> vector.search | GRAPH -> ontology.search+graph.expand
//   HYBRID     -> the structured+semantic pair (parallel + RRF)
//
// The three lanes mirror the 리원에이스 brief exactly (NL2SQL / 벡터 검색 / 지식 그래프)
// and the sponsor dataset labels every example question with one of them
// (datasets/companyx-v1.0/questions.json → nl2sql | vector_search | knowledge_graph).
//
// The pitch is NOT algorithmic novelty: it is determinism (no LLM call, zero tuning
// params, run-to-run variance = 0) + an audit log = operational stability, exactly
// the 리원에이스 brief's "fewer tuning params, fewer failure points" signal.
//
// Precedence ladder (first match wins) — each rung states WHY it outranks the next:
//   1. relation verb (사용/소속/담당/이끄는/팀장)  -> graph.
//      A traversal verb names an EDGE; no column and no document holds an edge.
//   2. document-content signal (설치/방법/원인/정책…) -> semantic.
//      Prose intent beats a bare relation NOUN ("회의록에서 논의된 이슈" is a document).
//   3. relation noun (이슈/관련된 X) + entity ref or superlative -> graph.
//   4. otherwise the original structured/semantic/hybrid signal scan.

export type Route = "structured" | "semantic" | "graph" | "hybrid";

export const SQL_TOOL = "sql.query";
export const VECTOR_TOOL = "vector.search";
export const ONTOLOGY_TOOL = "ontology.search";
export const GRAPH_TOOL = "graph.expand";

/** Sponsor-facing lane name (questions.json `tool` vocabulary). */
export const LANE_LABEL: Record<Route, string> = {
  structured: "nl2sql",
  semantic: "vector_search",
  graph: "knowledge_graph",
  hybrid: "nl2sql+vector_search",
};

const STRUCTURED_SIGNALS: [RegExp, string][] = [
  [/개수|몇\s*[개건명]|몇\s*\w+(이야|인가|일까)|건수|총\s*몇|카운트/, "count"],
  [/합계|총합|평균|최대|최소|최고|최저|중앙값|분포|통계/, "aggregate"],
  [/가장\s*(많|적|높|낮|큰|작)/, "superlative"],
  [/이상|이하|초과|미만|보다\s*(크|작|높|낮|많|적)/, "comparison"],
  [/정렬|순위|순으로|순서로|상위|하위|top\s*\d+|랭킹|오름차순|내림차순/, "sort"],
  [/\d{4}[-./]\d{1,2}|\d{4}년|\d\s*분기|최근|지난\s*(달|주|해|분기|\d+)|이번\s*(달|주|분기)|작년|올해|어제|오늘|날짜별|월별|연도별/, "time_filter"],
  [/별\s*(매출|개수|건수|합계|평균|금액)|그룹|group\s*by|범주별|카테고리별/, "groupby"],
  // Column/attribute vocabulary of the CompanyX schema (sales/contracts/employees/tickets).
  // A question that names a COLUMN is answerable only by SQL, never by an edge or a doc.
  [/매출|매출액|금액|계약|연봉|급여|예산|단가|월정액|우선순위|분기|등록(된|일)?|활성\s*상태/, "schema_column"],
  [/=|>=|<=|\bid\b|컬럼|필드|테이블|레코드|행\s*수/, "field_ref"],
];

// Semantic = MEANING signals only. Generic command verbs (알려줘/찾아줘) are
// route-neutral and intentionally excluded (they over-trigger on structured queries).
const SEMANTIC_SIGNALS: [RegExp, string][] = [
  [/비슷한|유사한|관련(된|있는)?|연관/, "similarity"],
  [/에\s*대(한|해)|내용|의미|취지|요지/, "aboutness"],
  [/설명|요약|정리해|어떤\s*내용|무슨\s*내용|뭐라고|어떻게\s*되어/, "explain"],
  [/느낌|분위기|톤|맥락|뉘앙스/, "soft_meaning"],
];

// Document-content signals: the vocabulary of the corpus itself (장애보고서·기술문서·
// 회의록·제안서). These name PROSE artifacts, so they outrank a bare relation noun.
const DOC_SIGNALS: [RegExp, string][] = [
  [/설치|구성\s*방법|방법|절차|가이드|매뉴얼|레퍼런스|문서|보고서|회의록|제안서|미팅|논의/, "doc_artifact"],
  [/원인|사례|대응|조치|복구|장애|취약점|점검|백업|인증|튜닝|최적화|성능\s*개선|정책/, "ops_topic"],
];

// L5 graph lane. Relation VERBS name an edge directly (traversal intent).
const RELATION_VERBS: [RegExp, string][] = [
  [/사용\s*(중|하는|중인)|사용하는|쓰고\s*있|도입한|이용\s*중/, "USES"],
  [/소속|속한|속해\s*있/, "BELONGS_TO"],
  [/담당(하는|자|해|인)?/, "MANAGES_ACCOUNT"],
  [/이끄는|이끌고|리드하는|맡고\s*있는|맡은/, "LEADS"],
  [/팀장|부서장|본부장|책임자/, "HEAD_IS"],
];

// Relation NOUNS are weaker: they need an entity reference or a superlative to
// mean "traverse", otherwise they are usually document prose.
const RELATION_NOUNS: [RegExp, string][] = [
  [/이슈|문의\s*건|신고\s*건/, "REPORTED_ISSUE"],
  [/관련(된|있는)?\s*(프로젝트|제품|고객|고객사|직원|부서|계약)/, "RELATED_TO"],
];

// Entity references: sponsor ids (Client-A / Product-C1 / project_12) or a Korean
// org-unit name (…팀 / …사업부 / …본부).
const ENTITY_REFS: [RegExp, string][] = [
  [/\b(client|product|employee|project|dept|department)[-_ ]?[a-z]?\d*\b/i, "entity_id"],
  [/[가-힣]{2,}(팀|사업부|본부|부서)/, "org_unit"],
];

/** What the graph lane should DO once routed — derived from the same deterministic
 * scan, so retrieval never has to re-parse the question. */
export interface GraphPlan {
  /** Relation types to traverse / scan (empty = any relation). */
  relTypes: string[];
  /** Rank endpoints by degree on this side — set for superlative questions. */
  aggregate?: "source" | "target";
  /** Node-property filter parsed from the query (진행 중 -> status=in_progress). */
  filter?: { side: "source" | "target"; key: string; value: string };
}

export interface RouteDecision {
  route: Route;
  tools: string[];
  structuredHits: string[];
  semanticHits: string[];
  graphHits: string[];
  docHits: string[];
  entityHits: string[];
  graphPlan?: GraphPlan;
  rationale: string;
}

/** Which endpoint a superlative counts over, per relation type.
 * "이슈가 가장 많은 제품" counts REPORTED_ISSUE by its TARGET (the product);
 * "가장 많은 고객을 담당하는 직원" counts MANAGES_ACCOUNT by its SOURCE (the employee). */
const AGG_SIDE: Record<string, "source" | "target"> = {
  REPORTED_ISSUE: "target",
  MANAGES_ACCOUNT: "source",
  USES: "target",
  LEADS: "source",
  HAS_PROJECT: "source",
  BELONGS_TO: "target",
  HEAD_IS: "source",
};

/** Node-property filters expressible in the question (sponsor status vocabulary). */
const PROPERTY_FILTERS: [RegExp, { side: "source" | "target"; key: string; value: string }][] = [
  [/진행\s*중|진행중/, { side: "target", key: "status", value: "in_progress" }],
  [/완료(된|한)?/, { side: "target", key: "status", value: "completed" }],
  [/계획\s*(중|단계)/, { side: "target", key: "status", value: "planning" }],
];

function buildGraphPlan(q: string, relTypes: string[], superlative: boolean): GraphPlan {
  const plan: GraphPlan = { relTypes: relTypes.filter((r) => r !== "RELATED_TO") };
  if (superlative && plan.relTypes.length) {
    plan.aggregate = AGG_SIDE[plan.relTypes[0]] ?? "source";
  }
  for (const [re, f] of PROPERTY_FILTERS) {
    if (re.test(q)) {
      plan.filter = f;
      break;
    }
  }
  return plan;
}

function scan(q: string, signals: [RegExp, string][]): string[] {
  return signals.filter(([re]) => re.test(q)).map(([, name]) => name);
}

const GRAPH_TOOLS = [ONTOLOGY_TOOL, GRAPH_TOOL];

export function route(query: string): RouteDecision {
  const q = query.trim();
  const s = scan(q, STRUCTURED_SIGNALS);
  const m = scan(q, SEMANTIC_SIGNALS);
  const verbs = scan(q, RELATION_VERBS);
  const nouns = scan(q, RELATION_NOUNS);
  const docs = scan(q, DOC_SIGNALS);
  const ents = scan(q, ENTITY_REFS);
  const graphHits = [...verbs, ...nouns];

  let route: Route, tools: string[], rationale: string;
  let graphPlan: GraphPlan | undefined;

  if (verbs.length) {
    // rung 1 — an explicit traversal verb: only the graph holds edges.
    [route, tools, rationale] = ["graph", GRAPH_TOOLS, `relation verb ${verbs.join(",")} -> graph traversal`];
    graphPlan = buildGraphPlan(q, verbs, s.includes("superlative"));
  } else if (docs.length) {
    // rung 2 — prose artifact / ops topic: the corpus, not the edges.
    [route, tools, rationale] = ["semantic", [VECTOR_TOOL], `document signals ${docs.join(",")}`];
  } else if (nouns.length && (ents.length || s.includes("superlative"))) {
    // rung 3 — relation noun anchored by an entity or a count-over-edges question.
    [route, tools, rationale] = [
      "graph",
      GRAPH_TOOLS,
      `relation noun ${nouns.join(",")} + ${ents.length ? `entity ${ents.join(",")}` : "superlative"}`,
    ];
    graphPlan = buildGraphPlan(q, nouns, s.includes("superlative"));
  } else if (s.length && m.length) {
    [route, tools, rationale] = ["hybrid", [SQL_TOOL, VECTOR_TOOL], "structured + semantic signals both present"];
  } else if (s.length) {
    [route, tools, rationale] = ["structured", [SQL_TOOL], "only structured signals"];
  } else if (m.length) {
    [route, tools, rationale] = ["semantic", [VECTOR_TOOL], "only semantic signals"];
  } else {
    // Ambiguous -> fan out both. Safer (fewer misses); RRF merges the results.
    [route, tools, rationale] = ["hybrid", [SQL_TOOL, VECTOR_TOOL], "no decisive signal; default fan-out"];
  }
  return {
    route,
    tools,
    structuredHits: s,
    semanticHits: m,
    graphHits,
    docHits: docs,
    entityHits: ents,
    graphPlan,
    rationale,
  };
}

/** Structured audit log entry — operational-stability / explainability. */
export function audit(d: RouteDecision) {
  return {
    route: d.route,
    lane: LANE_LABEL[d.route],
    tools: d.tools,
    structured_signals: d.structuredHits,
    semantic_signals: d.semanticHits,
    graph_signals: d.graphHits,
    graph_plan: d.graphPlan ?? null,
    document_signals: d.docHits,
    entity_signals: d.entityHits,
    rationale: d.rationale,
    deterministic: true,
  };
}
