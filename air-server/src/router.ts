// L3 — deterministic rule-based parallel router (MCP Parallel pattern).
// Ported from the validated Python prototype (prototype/router.py, tests 6/6).
//
// Classifies a Korean query and decides which DB tools to fan out to:
//   STRUCTURED -> sql.query | SEMANTIC -> vector.search | HYBRID -> both (parallel + RRF)
//
// The pitch is NOT algorithmic novelty: it is determinism (no LLM call, zero tuning
// params, run-to-run variance = 0) + an audit log = operational stability, exactly
// the 리원에이스 brief's "fewer tuning params, fewer failure points" signal.

export type Route = "structured" | "semantic" | "hybrid";

export const SQL_TOOL = "sql.query";
export const VECTOR_TOOL = "vector.search";

const STRUCTURED_SIGNALS: [RegExp, string][] = [
  [/개수|몇\s*[개건명]|몇\s*\w+(이야|인가|일까)|건수|총\s*몇|카운트/, "count"],
  [/합계|총합|평균|최대|최소|최고|최저|중앙값|분포|통계/, "aggregate"],
  [/이상|이하|초과|미만|보다\s*(크|작|높|낮|많|적)/, "comparison"],
  [/정렬|순위|순으로|상위|하위|top\s*\d+|랭킹|오름차순|내림차순/, "sort"],
  [/\d{4}[-./]\d{1,2}|최근|지난\s*(달|주|해|분기|\d+)|이번\s*(달|주|분기)|작년|올해|어제|오늘|날짜별|월별|연도별/, "time_filter"],
  [/별\s*(매출|개수|건수|합계|평균)|그룹|group\s*by|범주별|카테고리별/, "groupby"],
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

export interface RouteDecision {
  route: Route;
  tools: string[];
  structuredHits: string[];
  semanticHits: string[];
  rationale: string;
}

function scan(q: string, signals: [RegExp, string][]): string[] {
  return signals.filter(([re]) => re.test(q)).map(([, name]) => name);
}

export function route(query: string): RouteDecision {
  const q = query.trim();
  const s = scan(q, STRUCTURED_SIGNALS);
  const m = scan(q, SEMANTIC_SIGNALS);

  let route: Route, tools: string[], rationale: string;
  if (s.length && m.length) {
    [route, tools, rationale] = ["hybrid", [SQL_TOOL, VECTOR_TOOL], "structured + semantic signals both present"];
  } else if (s.length) {
    [route, tools, rationale] = ["structured", [SQL_TOOL], "only structured signals"];
  } else if (m.length) {
    [route, tools, rationale] = ["semantic", [VECTOR_TOOL], "only semantic signals"];
  } else {
    // Ambiguous -> fan out both. Safer (fewer misses); RRF merges the results.
    [route, tools, rationale] = ["hybrid", [SQL_TOOL, VECTOR_TOOL], "no decisive signal; default fan-out"];
  }
  return { route, tools, structuredHits: s, semanticHits: m, rationale };
}

/** Structured audit log entry — operational-stability / explainability. */
export function audit(d: RouteDecision) {
  return {
    route: d.route,
    tools: d.tools,
    structured_signals: d.structuredHits,
    semantic_signals: d.semanticHits,
    rationale: d.rationale,
    deterministic: true,
  };
}
