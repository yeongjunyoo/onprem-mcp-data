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
//
// ★ 온톨로지 전수 커버 의무(2026-08-16). 데이터셋 엣지 타입은 7종이다
// (USES, BELONGS_TO, MANAGES_ACCOUNT, LEADS, HEAD_IS, REPORTED_ISSUE, HAS_PROJECT).
// 하나라도 라우팅 신호가 없으면 그 관계는 질문으로 도달할 수 없는 구조적 사각지대가
// 된다. router.test.ts가 edges.json을 읽어 이 불변식을 강제한다.
// HAS_PROJECT(354엣지 중 40)가 실제로 비어 있었고, 홀드아웃 오답 4건 중 2건이
// 거기서 나왔다.
const RELATION_VERBS: [RegExp, string][] = [
  [/사용\s*(중|하는|중인)|사용하는|쓰고\s*있|도입한|이용\s*중/, "USES"],
  [/소속|속한|속해\s*있/, "BELONGS_TO"],
  [/담당(하는|자|해|인)?/, "MANAGES_ACCOUNT"],
  [/이끄는|이끌고|리드하는|맡고\s*있는|맡은/, "LEADS"],
  [/팀장|부서장|본부장|책임자|수장/, "HEAD_IS"],
  // HAS_PROJECT — client→project 엣지. "관여/참여"는 컬럼도 문서도 아니고
  // 오직 엣지만이 답할 수 있는 질문이다. 주어가 직원이면 이 엣지가 닿지 않으므로
  // 그래프 레인이 시드 타입에 맞춰 employee→project 엣지(LEADS)로 바꾼다(fitPlanToSeed).
  [/관여(하는|한|하고)|참여(하는|한|중인)|투입된|배정된/, "HAS_PROJECT"],
];

// 타입 미지정 관계 신호. "연결된/이어진"은 어떤 엣지인지 문장만으로는 정해지지
// 않지만, 컬럼이나 문서가 아닌 「엣지」를 묻는다는 것만은 확정적이다.
// RELATED_TO는 buildGraphPlan이 relTypes에서 털어내므로 무타입 확장으로 간다.
const GENERIC_RELATION_VERBS: [RegExp, string][] = [
  [/연결(된|돼|되어)|이어진|엮여\s*있는|관계\s*있는/, "RELATED_TO"],
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
  // employee는 온톨로지의 1급 노드타입(45개)인데 인물을 지칭하는 패턴이 없었다.
  //
  // 이것은 사전이 없을 때의 폴백이다. 이름을 정규식으로 맞히는 것은 원리적으로
  // 불가능하다 — 실제로 "신하은"이 은으로 끝난다는 이유로 제외되는 결함이 있었다.
  // 정답은 온톨로지 대조이고(installEntityLexicon), 여기서는 동사 관형어미만
  // 걸러 오탐을 줄인다.
  [/[가-힣]{2,4}(?<![된는인])\s*(직원|사원|담당자)/, "person"],
];

/** 이름 자리에 올 수 없는 수식어. 폴백 정규식의 오탐을 줄인다. */
const NOT_A_NAME = new Set([
  "소속된", "재직", "중인", "담당하는", "근무하는", "입사한", "퇴사한",
  "해당", "관련된", "신규", "전체", "모든", "우리", "각", "타",
]);

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

/** 사업자 라벨 공간의 세 도구. 규칙 점수와 시맨틱 폴백이 같은 공간에서 비교된다. */
export type Lane = "nl2sql" | "vector_search" | "knowledge_graph";
export const LANES: readonly Lane[] = ["nl2sql", "vector_search", "knowledge_graph"];

/** 규칙이 확신하는 정도. 사다리가 고른 도구의 점수에서 나머지 중 최고점을 뺀 값이다. */
export interface RuleGate {
  scores: Record<Lane, number>;
  /** 사다리가 고른 도구. hybrid 로 떨어졌으면 null — 확신이 없다는 뜻이다. */
  pick: Lane | null;
  margin: number;
  /** pick 이 있고 margin 이 RULE_MIN_MARGIN 이상일 때만 true. false 면 시맨틱 폴백 차례다. */
  confident: boolean;
}

export interface RouteDecision {
  route: Route;
  tools: string[];
  structuredHits: string[];
  semanticHits: string[];
  graphHits: string[];
  docHits: string[];
  entityHits: string[];
  /** 타입쌍 추론 결과. 관계어를 못 맞혀도 온톨로지가 엣지를 알려준 경우. */
  typePair?: { relation: string; from: string; to: string };
  graphPlan?: GraphPlan;
  rationale: string;
  gate: RuleGate;
  /** 규칙이 확신하지 못해 시맨틱 폴백이 판단했을 때만 붙는다(semroute.ts). */
  semantic?: {
    lane: Lane;
    margin: number;
    scores: Record<Lane, number>;
    nearest: { lane: Lane; type: string; text: string; score: number };
    applied: boolean;
  };
}

// ── 신호 가중치 합산 ────────────────────────────────────────────────
//
// 사다리(아래 route())는 첫 일치에서 멈추므로 "얼마나 확실한가"를 말하지 못한다.
// 「매출」은 정형 신호지만 「매출 관련 보고서」는 문서 질문이다. 두 신호가 함께
// 있을 때 사다리는 여전히 한쪽을 고르고, 그 선택이 박빙이었다는 사실은 버려진다.
// 그래서 같은 신호를 도구별 점수로 합산해 1위와 2위의 격차를 남긴다.
//
// 가중치는 사다리의 우선순위를 수치로 옮긴 것이다. 엣지를 직접 부르는 관계 동사가
// 가장 무겁고(3), 문서 어휘와 타입쌍이 그다음(2), 개체에 걸린 관계 명사(1.5),
// 나머지 정형·의미 신호는 개당 1이다.
const WEIGHT = {
  relationVerb: 3,
  genericRelation: 2,
  typePair: 2,
  relationNoun: 1.5,
  doc: 2,
  semantic: 1,
  structured: 1,
} as const;

/** 이 격차 미만이면 규칙은 판단을 시맨틱 폴백에 넘긴다.
 *
 * 값은 개발용 문항 150개(사업자 30, 홀드아웃 1·2·3차)에서 격차 구간별로 규칙만,
 * 시맨틱만의 정확도를 따로 재서 정했다(`npm run companyx:boundary`,
 * eval/results/companyx-route-boundary.json). 격차 1 구간은 규칙 17/21 대 시맨틱
 * 20/21, 격차 2 구간은 49/53 대 51/53 으로 시맨틱이 나았고, 2.5 이상에서 둘이
 * 같아졌다. 규칙이 판단을 포기한 33문항은 시맨틱 32/33, 규칙 0/33.
 *
 * 1차 값은 1이었다(90문항). 봉인 홀드아웃 3차가 격차 1~2 구간의 규칙 오답을
 * 드러냈다 — 날짜가 박힌 문서 질문과 집계어 없는 조회 질문. */
export const RULE_MIN_MARGIN = 2.5;

const LANE_OF: Record<Route, Lane | null> = {
  structured: "nl2sql",
  semantic: "vector_search",
  graph: "knowledge_graph",
  hybrid: null,
};

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

export function buildGraphPlan(q: string, relTypes: string[], superlative: boolean): GraphPlan {
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

// ── 온톨로지 엔티티 사전 ──────────────────────────────────────────────
//
// 라우터가 개체를 「추측」하지 않고 「대조」하게 한다. 실제 배포에서 이 목록은
// 고객사 자신의 DB에서 나오므로(기동 시 1회 적재), 데이터셋을 저장소에 재배포할
// 필요가 없다. 임계값이 없으므로 튜닝 파라미터도 늘지 않는다.
//
// 왜 필요한가: 홀드아웃 2차(구어체)에서 knowledge_graph strict 1/10이 나왔고,
// 실패의 대부분이 「개체를 못 알아봐서 관계 질문인 줄 몰랐다」였다.
let ENTITY_LEXICON: { name: string; type: string }[] = [];

/** 타입쌍 -> 엣지 타입들(데이터 순서). edges.json에서 유도하며 사람이 적지 않는다.
 *
 * 한 타입쌍에 엣지가 여럿일 수 있다. 고객과 제품 사이에는 USES 와 REPORTED_ISSUE 가,
 * 부서와 직원 사이에는 BELONGS_TO 와 HEAD_IS 가 있다. 종전에는 먼저 나온 하나만 남겨서,
 * 「Product-S1 관련 고객 이슈 현황은?」(사업자 예시 29번)이 이슈를 묻는데 USES 로 탐색했다.
 * 온톨로지를 적재한 서버에서만 생기는 결함이라 온톨로지 없이 돌던 평가들이 몰랐다(2026-09-30). */
let TYPE_PAIR_EDGE = new Map<string, string[]>();

/** 엣지 타입 -> 그 엣지가 잇는 (출발 타입, 도착 타입). 역시 데이터에서 유도한다. */
let REL_ENDS = new Map<string, [string, string][]>();

/** 노드 타입을 가리키는 말. 관계 동사와 달리 **닫힌 집합**이다 — 온톨로지의
 * 노드 타입이 5종이므로 이 표도 5행에서 끝난다. 관계 표현은 무한하지만
 * "무엇을 묻는가"의 대상 타입은 유한하다. 이것이 이 설계의 요점이다. */
const NODE_TYPE_TERMS: [RegExp, string][] = [
  [/부서|조직|팀|본부|사업부|소속/, "department"],
  [/직원|사원|담당자|담당|사람|누구|인원|엔지니어|창구|윗선|책임자|팀장/, "employee"],
  [/프로젝트|과제|건(이|을|은|가|\s|$)|업무/, "project"],
  [/제품|솔루션|서비스|상품/, "product"],
  [/고객사|고객|거래처|계정/, "client"],
];

/** 기동 시 1회 설치한다.
 *
 * 실제 배포에서 nodes/edges는 고객사 자신의 DB에서 온다. 저장소에 데이터를
 * 재배포하지 않아도 되고, 임계값이 없으므로 튜닝 파라미터도 늘지 않는다. */
export function installOntology(
  nodes: Iterable<{ name: string; type: string }>,
  edges: Iterable<{ source: string; target: string; relation: string }> = [],
): { entities: number; typePairs: number } {
  const seen = new Set<string>();
  ENTITY_LEXICON = [];
  for (const n of nodes) {
    const name = (n.name ?? "").trim();
    if (name.length < 2 || seen.has(name)) continue;
    seen.add(name);
    ENTITY_LEXICON.push({ name, type: n.type });
  }
  // 긴 이름부터 대조해 부분 일치를 막는다.
  ENTITY_LEXICON.sort((a, b) => b.name.length - a.name.length);

  // 타입쌍 -> 엣지. 노드 id 접두사가 타입이다(client_7 -> client).
  const typeOf = new Map<string, string>();
  for (const n of nodes as Iterable<{ name: string; type: string; id?: string }>) {
    if (n.id) typeOf.set(n.id, n.type);
  }
  TYPE_PAIR_EDGE = new Map();
  REL_ENDS = new Map();
  const add = (key: string, rel: string) => {
    const list = TYPE_PAIR_EDGE.get(key) ?? [];
    if (!list.includes(rel)) list.push(rel);
    TYPE_PAIR_EDGE.set(key, list);
  };
  for (const e of edges) {
    const st = typeOf.get(e.source) ?? e.source.replace(/_\d+$/, "");
    const tt = typeOf.get(e.target) ?? e.target.replace(/_\d+$/, "");
    // 데이터 순서를 지킨다(결정론). 질문이 엣지를 지목하지 않으면 첫 엣지를 쓴다.
    add(`${st}|${tt}`, e.relation);
    add(`${tt}|${st}`, e.relation);
    const ends = REL_ENDS.get(e.relation) ?? [];
    if (!ends.some(([a, b]) => a === st && b === tt)) ends.push([st, tt]);
    REL_ENDS.set(e.relation, ends);
  }
  return { entities: ENTITY_LEXICON.length, typePairs: TYPE_PAIR_EDGE.size };
}

/** 테스트와 재현성을 위해 현재 사전 크기를 노출한다. */
export function entityLexiconSize(): number {
  return ENTITY_LEXICON.length;
}

/** 별칭 가운데 사전에 넣을 것: 한 개체만 가리키는 것.
 *
 * 별칭 테이블에는 이름 말고 속성 값도 들어 있다. companyx 적재기는 ontology.search 가
 * 「in_progress」, 「서울」 같은 값으로도 개체를 찾도록 지역, 업종, 직급, 상태를 별칭으로 넣는다.
 * 그것을 이름으로 받으면 「서울」이 고객사 이름이 되어 「서울 쪽 매출이 어때」가
 * 「{고객사} 쪽 매출이 어때」로 가려지고 그래프로 갔다(멘토 예시, 2026-10-02). 이름은 한 개체를
 * 가리키고, 여러 개체가 나눠 가진 값은 속성이다. */
export function identifyingAliases<T extends { id: string; name: string }>(aliases: T[]): T[] {
  const owners = new Map<string, Set<string>>();
  for (const a of aliases) {
    const key = a.name.trim();
    const ids = owners.get(key) ?? new Set<string>();
    ids.add(a.id);
    owners.set(key, ids);
  }
  return aliases.filter((a) => owners.get(a.name.trim())!.size === 1);
}

/** 하루를 짚는 날짜. 분기, 월, 연도처럼 구간을 거는 말과 다르다. 이 데이터에서 날짜가
 * 제목에 박힌 것은 장애 보고서와 회의록이라, 「2025년 12월 27일 그 장애」는 기간 필터가
 * 아니라 사건 한 건을 가리킨다. 그래서 정형 신호를 세기 전에 뺀다. 하루 단위 집계는
 * 여전히 컬럼 어휘(매출, 금액…)가 정형으로 끌고 간다. */
const FULL_DAY = /\d{4}\s*년\s*\d{1,2}\s*월\s*\d{1,2}\s*일|\d{4}-\d{1,2}-\d{1,2}|\d{1,2}\s*월\s*\d{1,2}\s*일/g;

const TYPE_PLACEHOLDER: Record<string, string> = {
  client: "{고객사}",
  product: "{제품}",
  employee: "{직원}",
  department: "{부서}",
  project: "{프로젝트}",
};

/** 실재 개체명을 타입 자리표시로 바꾼다. 시맨틱 폴백은 「무엇을 묻는가」를 비교해야
 * 하는데, "Product-C3" 같은 고유명은 의미가 없는 토큰이라 유사도를 흐린다. */
export function maskEntities(q: string): string {
  let out = q.replace(FULL_DAY, "{날짜}");
  for (const e of ENTITY_LEXICON) {
    const ph = TYPE_PLACEHOLDER[e.type];
    if (ph && out.includes(e.name)) out = out.split(e.name).join(ph);
  }
  return out;
}

/** 질문에 등장하는 실재 개체의 타입들. */
function entityTypesIn(q: string): string[] {
  const out = new Set<string>();
  for (const e of ENTITY_LEXICON) if (q.includes(e.name)) out.add(e.type);
  return [...out];
}

/** 타입쌍 추론: 지목된 개체의 타입과, 질문이 가리키는 다른 타입 사이의 엣지.
 *
 * 그 타입쌍의 엣지가 여럿이면 질문의 관계 명사(「이슈」 → REPORTED_ISSUE)가 지목한 엣지를 쓰고,
 * 지목이 없으면 데이터 순서의 첫 엣지를 쓴다. */
function inferByTypePair(q: string, named: string[] = []): { relation: string; from: string; to: string } | null {
  const froms = entityTypesIn(q);
  if (!froms.length) return null;
  const tos = scan(q, NODE_TYPE_TERMS);
  for (const from of froms) {
    for (const to of tos) {
      if (to === from) continue;
      const rels = TYPE_PAIR_EDGE.get(`${from}|${to}`);
      if (rels?.length) return { relation: rels.find((r) => named.includes(r)) ?? rels[0], from, to };
    }
  }
  return null;
}

/** 시드 개체에서 출발하는 탐색. hops[i] 는 i+1 번째 홉에서 탈 엣지 타입들이다.
 * 빈 배열이면 엣지 타입을 정하지 않은 무타입 확장이다. */
export interface SeedWalk {
  hops: string[][];
  /** 계획을 시드 타입에 맞게 고쳤으면 그 내용. 감사 로그에 남는다. */
  fitted?: string;
}

/** 질문이 묻는 노드 타입. 한국어는 머리말이 끝에 오므로 마지막에 나온 타입 어휘다.
 * 「Product-S1 이슈를 올린 고객사의 프로젝트는?」은 고객사가 아니라 프로젝트를 묻는다.
 * 개체 이름 속의 타입 어휘(「기술지원팀」의 팀)는 세지 않는다. 시드 타입은 뺀다. */
function askedType(q: string, except: string): string | undefined {
  let text = q;
  for (const e of ENTITY_LEXICON) if (text.includes(e.name)) text = text.split(e.name).join(" ".repeat(e.name.length));
  let best: { at: number; type: string } | undefined;
  for (const [re, type] of NODE_TYPE_TERMS) {
    if (type === except) continue;
    for (const m of text.matchAll(new RegExp(re.source, "g"))) {
      if (m.index !== undefined && (!best || m.index >= best.at)) best = { at: m.index, type };
    }
  }
  return best?.type;
}

/** 탐색 계획을 시드 개체의 타입에 맞춘다.
 *
 * 계획의 엣지는 질문의 말(관계어, 시맨틱 앵커)에서 나오고 시드는 개체 해소에서 나온다.
 * 둘이 어긋나면 시드에서 그 엣지를 탈 수 없어 탐색이 빈손으로 끝나고, 7B 는 「알 수
 * 없다」고 답한다. 사업자 예시 25번 「Product-D1 제품과 관련된 프로젝트는?」이 그랬다.
 * 계획은 HAS_PROJECT(고객사 → 프로젝트)인데 시드가 제품이라 닿는 엣지가 0개였다. 제품과
 * 프로젝트 사이에는 엣지가 없고 고객사를 거쳐야 한다. 사업자 그래프 스키마 문서의 예시
 * 질의도 같은 모양이다(「Product-C1 담당 엔지니어」 = product ←[USES]- client
 * ←[MANAGES_ACCOUNT]- employee).
 *
 * 규칙은 온톨로지의 타입 그래프와 질문이 묻는 타입(askedType)만 본다. 어휘를 늘리지 않는다.
 *   0. 「같은 팀」, 「같은 제품」처럼 시드와 같은 무리를 물으면 무리 타입으로 갔다가 같은 엣지로
 *      돌아온다. 그 무리를 이름으로 지목한 다른 시드가 있으면(otherSeedTypes) 왕복하지 않는다.
 *   1. 계획의 엣지가 시드 타입에 닿으면 그 엣지로 한 홉. 닿는 엣지와 안 닿는 엣지가 이어지면
 *      시드에서부터 한 홉씩 탄다(담당 직원 → 그 직원이 이끄는 프로젝트). 한 홉으로 묻는
 *      타입에 못 닿으면 그 타입으로 가는 엣지를 한 홉 더 잇는다(직원 → 담당 고객사 → 그
 *      고객사의 프로젝트).
 *   2. 닿지 않으면, 묻는 타입이 그 엣지의 끝이고 시드 타입과 그 타입을 바로 잇는 엣지가
 *      있을 때 그 엣지 한 홉으로 바꾼다(직원이 「관여하는 프로젝트」 = LEADS).
 *   3. 그것도 없으면 시드 타입과 그 엣지의 한쪽 끝을 잇는 다리 엣지를 찾아 두 홉으로 잇는다.
 *   다리나 대체 엣지가 여럿이면 질문이 지목한 엣지, 없으면 데이터 순서의 첫 엣지다(타입쌍
 *   추론과 같은 규칙). 어느 것도 안 되거나 온톨로지가 없으면 계획을 그대로 둔다. */
export function fitPlanToSeed(relTypes: string[], seedType: string, query: string, otherSeedTypes: string[] = []): SeedWalk {
  const rels = relTypes.filter((r) => r !== "RELATED_TO");
  const named = [...scan(query, RELATION_VERBS), ...scan(query, RELATION_NOUNS)];
  const pick = (cands: string[]) => cands.find((r) => named.includes(r)) ?? cands[0];

  // 0. 시드 자신의 엣지는 둘째 홉에서 다시 줍지 않는다(이미 본 엣지 id 는 빠진다).
  //    무리를 이름으로 지목한 시드가 따로 있으면(「같은 제품 … 그 제품은 Product-S1」) 왕복하지 않는다.
  //    그 시드에서 바로 탐색하면 되고, 왕복은 이 시드가 속한 다른 무리까지 끌어와 근거 예산을 채운다
  //    (홀드아웃3 #57).
  const same = /같은\s*([가-힣]+)/.exec(query);
  const group = same ? scan(same[1], NODE_TYPE_TERMS)[0] : undefined;
  if (group && group !== seedType && !otherSeedTypes.includes(group)) {
    const via = TYPE_PAIR_EDGE.get(`${seedType}|${group}`);
    if (via?.length) {
      const e = via.find((r) => rels.includes(r)) ?? pick(via);
      return { hops: [[e], [e]], fitted: `같은 ${group}: ${e} 로 갔다가 같은 엣지로 돌아옴` };
    }
  }

  if (!rels.length) return { hops: [] };
  const ends = (r: string) => REL_ENDS.get(r) ?? [];
  if (!rels.every((r) => ends(r).length)) return { hops: [rels] };
  /** 엣지 r 에서 타입 t 의 반대편 타입들. t 에 닿지 않으면 빈 배열. */
  const across = (r: string, t: string) => ends(r).flatMap(([a, b]) => (a === t ? [b] : b === t ? [a] : []));
  const asked = askedType(query, seedType);

  const touching = rels.filter((r) => across(r, seedType).length);
  if (touching.length) {
    for (const first of touching) {
      const mids = across(first, seedType);
      const second = rels.find((r) => !touching.includes(r) && mids.some((m) => across(r, m).length));
      if (second) return { hops: [[first], [second]], fitted: `${first} 다음 ${second}` };
    }
    if (rels.length === 1 && asked) {
      const reached = across(rels[0], seedType);
      for (const m of reached.includes(asked) ? [] : reached) {
        const next = TYPE_PAIR_EDGE.get(`${m}|${asked}`);
        if (next?.length) {
          const n = pick(next);
          return { hops: [[rels[0]], [n]], fitted: `${rels[0]} 로는 ${asked} 에 못 닿아 ${n} 를 이어 탐` };
        }
      }
    }
    return { hops: [rels] };
  }

  const rel = rels[0];
  const relEnds = [...new Set(ends(rel).flat())];
  if (asked && relEnds.includes(asked)) {
    const direct = TYPE_PAIR_EDGE.get(`${seedType}|${asked}`);
    if (direct?.length) {
      const d = pick(direct);
      return { hops: [[d]], fitted: `${rel} 는 ${seedType} 에 닿지 않아 ${seedType}-${asked} 엣지 ${d}` };
    }
  }
  // 다리 반대편(= 답)이 묻는 타입인 쪽을 먼저 본다.
  const answersAsked = (m: string) => Number(asked !== undefined && across(rel, m).includes(asked));
  const mids = relEnds.filter((m) => m !== seedType).sort((a, b) => answersAsked(b) - answersAsked(a));
  for (const m of mids) {
    const bridge = TYPE_PAIR_EDGE.get(`${seedType}|${m}`);
    if (bridge?.length) {
      const b = pick(bridge);
      return { hops: [[b], [rel]], fitted: `${rel} 는 ${seedType} 에 닿지 않아 ${m} 를 거침: ${b} 다음 ${rel}` };
    }
  }
  return { hops: [rels] };
}

/** 라우터가 신호를 가진 관계 타입 전체.
 *
 * 온톨로지 커버리지 불변식의 한쪽 항이다. 데이터셋 edges.json의 relation 집합이
 * 이 집합에 포함되지 않으면 그 관계는 질문으로 도달할 수 없다 — router.test.ts가
 * 그것을 실패로 만든다. 목록을 손으로 적지 않고 신호 테이블에서 유도하므로
 * 신호를 추가하면 자동으로 반영된다. */
export const RELATION_SIGNAL_TYPES: ReadonlySet<string> = new Set([
  ...RELATION_VERBS.map(([, t]) => t),
  ...GENERIC_RELATION_VERBS.map(([, t]) => t),
  ...RELATION_NOUNS.map(([, t]) => t),
]);

const GRAPH_TOOLS = [ONTOLOGY_TOOL, GRAPH_TOOL];

export function route(query: string): RouteDecision {
  const q = query.trim();
  const s = scan(q.replace(FULL_DAY, " "), STRUCTURED_SIGNALS);
  const m = scan(q, SEMANTIC_SIGNALS);
  const verbs = scan(q, RELATION_VERBS);
  const generic = scan(q, GENERIC_RELATION_VERBS);
  const nouns = scan(q, RELATION_NOUNS);
  const docs = scan(q, DOC_SIGNALS);
  const ents = scan(q, ENTITY_REFS).filter((name) => {
    if (name !== "person") return true;
    // 폴백 정규식이 잡은 인물 후보가 수식어면 버린다.
    const m = q.match(/([가-힣]{2,4})\s*(?:직원|사원|담당자)/);
    return !(m && NOT_A_NAME.has(m[1]));
  });
  // 온톨로지에 실재하는 개체명이 문장에 있으면 추측할 필요가 없다.
  if (ENTITY_LEXICON.some((n) => q.includes(n.name)) && !ents.includes("known_entity")) {
    ents.push("known_entity");
  }
  const graphHits = [...verbs, ...generic, ...nouns];

  const typePair = inferByTypePair(q, nouns);
  // 최상급은 그래프 집계일 수 있으므로 구조화 신호에서 분리한다.
  const columnish = s.filter((x) => x !== "superlative");

  let route: Route, tools: string[], rationale: string;
  let graphPlan: GraphPlan | undefined;

  if (verbs.length) {
    // rung 1 — an explicit traversal verb: only the graph holds edges.
    [route, tools, rationale] = ["graph", GRAPH_TOOLS, `relation verb ${verbs.join(",")} -> graph traversal`];
    graphPlan = buildGraphPlan(q, verbs, s.includes("superlative"));
  } else if (generic.length && ents.length) {
    // rung 1b — 타입 미지정 관계어 + 엔티티 앵커. 엣지를 묻는 것은 확실하고
    // 어느 엣지인지만 미정이라, 무타입 확장으로 그래프를 탄다.
    [route, tools, rationale] = [
      "graph",
      GRAPH_TOOLS,
      `generic relation ${generic.join(",")} + entity ${ents.join(",")} -> untyped traversal`,
    ];
    graphPlan = buildGraphPlan(q, generic, s.includes("superlative"));
  } else if (docs.length) {
    // rung 2 — prose artifact / ops topic: the corpus, not the edges.
    [route, tools, rationale] = ["semantic", [VECTOR_TOOL], `document signals ${docs.join(",")}`];
  } else if (typePair && !docs.length && !columnish.length) {
    // rung 2b — 타입쌍 추론. 관계어를 못 맞혀도, 지목된 개체의 타입과 질문이
    // 가리키는 타입이 온톨로지에서 엣지로 이어져 있으면 그것은 관계 질문이다.
    //
    // 두 곳에 양보한다. 문서 신호가 있으면 산문이 답할 수 있고(rung 2),
    // 컬럼 어휘가 있으면 STRUCTURED_SIGNALS의 공리대로 SQL만이 답할 수 있다
    // ("연봉"을 물으면 그것은 엣지 질문이 아니다). 최상급은 예외로 두는데,
    // 엣지를 세는 질문("가장 많은 고객을 담당하는 직원")이 그래프 집계이기 때문이다.
    [route, tools, rationale] = [
      "graph",
      GRAPH_TOOLS,
      `type-pair ${typePair.from}->${typePair.to} => ${typePair.relation}`,
    ];
    graphPlan = buildGraphPlan(q, [typePair.relation], s.includes("superlative"));
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
  } else if (ents.length) {
    // Ambiguous BUT entity-anchored -> 세 레인 전부 연다.
    //
    // 결함이었던 지점: 기존 fan-out은 structured+semantic만 켜서, 신호를 놓친
    // 관계 질문이 그래프에 영영 닿지 못했다. 3레인 시스템에서 "모르겠으면 둘만"은
    // 세 번째 레인을 구조적 사각지대로 만든다. 그래프 탐색은 앵커가 있어야
    // 의미가 있으므로, 엔티티가 지목된 모호 질문에 한해 그래프를 포함한다.
    [route, tools, rationale] = [
      "hybrid",
      [SQL_TOOL, VECTOR_TOOL, ...GRAPH_TOOLS],
      `no decisive signal; entity-anchored fan-out (${ents.join(",")})`,
    ];
    graphPlan = buildGraphPlan(q, [], s.includes("superlative"));
  } else {
    // Ambiguous, 앵커도 없음 -> 기존대로 둘만. 앵커 없는 그래프 탐색은 낭비다.
    [route, tools, rationale] = ["hybrid", [SQL_TOOL, VECTOR_TOOL], "no decisive signal; default fan-out"];
  }

  const scores: Record<Lane, number> = {
    nl2sql: WEIGHT.structured * s.length,
    vector_search: WEIGHT.doc * docs.length + WEIGHT.semantic * m.length,
    knowledge_graph:
      WEIGHT.relationVerb * verbs.length +
      (generic.length && ents.length ? WEIGHT.genericRelation : 0) +
      (typePair && !columnish.length ? WEIGHT.typePair : 0) +
      (nouns.length && (ents.length || s.includes("superlative")) ? WEIGHT.relationNoun : 0),
  };
  const pick = LANE_OF[route];
  const margin = pick ? scores[pick] - Math.max(...LANES.filter((l) => l !== pick).map((l) => scores[l])) : 0;
  const gate: RuleGate = { scores, pick, margin, confident: pick !== null && margin >= RULE_MIN_MARGIN };

  return {
    route,
    tools,
    structuredHits: s,
    semanticHits: m,
    graphHits,
    docHits: docs,
    entityHits: ents,
    typePair: typePair ?? undefined,
    graphPlan,
    rationale,
    gate,
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
    type_pair: d.typePair ?? null,
    rationale: d.rationale,
    rule_scores: d.gate.scores,
    rule_margin: d.gate.margin,
    rule_confident: d.gate.confident,
    semantic_fallback: d.semantic
      ? {
          lane: d.semantic.lane,
          margin: Number(d.semantic.margin.toFixed(4)),
          applied: d.semantic.applied,
          nearest_anchor: d.semantic.nearest.text,
        }
      : null,
    deterministic: true,
  };
}
