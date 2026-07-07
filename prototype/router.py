"""
L3 — deterministic rule-based parallel router (MCP Parallel pattern).

Classifies a Korean query and decides which DB MCP tools to fan out to:
  - STRUCTURED  -> SQL tool (counts, filters, sorts, aggregations, explicit fields)
  - SEMANTIC    -> pgvector similarity tool (meaning / "related to" / summarize)
  - HYBRID      -> both, in parallel, then RRF-merge

Design choices that ARE the contest pitch (not algorithmic novelty):
  * NO LLM call, NO embeddings -> fully deterministic: same query always routes
    the same way (run-to-run variance = 0), zero token cost, offline.
  * Zero tuning parameters: the rules are fixed and inspectable.
  * Every decision carries an audit log (which signals fired) -> explainable,
    graceful, "fewer failure points" operational-stability story.

This is the faithful implementation of 리원에이스's "규칙 기반 라우터 (MCP Parallel)"
brief item; novelty is not claimed, correctness + stability + auditability is.
"""
from __future__ import annotations
import re
from dataclasses import dataclass, field
from enum import Enum


class Route(str, Enum):
    STRUCTURED = "structured"   # -> sql tool
    SEMANTIC = "semantic"       # -> vector tool
    HYBRID = "hybrid"           # -> both, parallel + RRF


# Signal lexicons (fixed; no weights to tune). Matched on the raw Korean query.
STRUCTURED_SIGNALS: list[tuple[str, str]] = [
    (r"개수|몇\s*[개건명건수]|몇\s*\w+(이야|인가|일까)|건수|총\s*몇|카운트", "count"),
    (r"합계|총합|평균|최대|최소|최고|최저|중앙값|분포|통계", "aggregate"),
    (r"이상|이하|초과|미만|보다\s*(크|작|높|낮|많|적)", "comparison"),
    (r"정렬|순위|순으로|상위|하위|top\s*\d+|랭킹|오름차순|내림차순", "sort"),
    (r"\d{4}[-./]\d{1,2}|최근|지난\s*(달|주|해|분기|\d+)|이번\s*(달|주|분기)|작년|올해|어제|오늘|날짜별|월별|연도별", "time_filter"),
    (r"별\s*(매출|개수|건수|합계|평균)|그룹|group\s*by|범주별|카테고리별", "groupby"),
    (r"=|>=|<=|\bid\b|컬럼|필드|테이블|레코드|행\s*수", "field_ref"),
]
# Semantic = MEANING signals only. Generic command verbs (알려줘/찾아줘/보여줘) are
# route-neutral and were dropped: they over-triggered on structured queries.
SEMANTIC_SIGNALS: list[tuple[str, str]] = [
    (r"비슷한|유사한|관련(된|있는)?|연관", "similarity"),
    (r"에\s*대(한|해)|내용|의미|취지|요지", "aboutness"),
    (r"설명|요약|정리해|어떤\s*내용|무슨\s*내용|뭐라고|어떻게\s*되어", "explain"),
    (r"느낌|분위기|톤|맥락|뉘앙스", "soft_meaning"),
]


@dataclass
class RouteDecision:
    route: Route
    tools: list[str]                      # MCP tools to invoke (in parallel if >1)
    structured_hits: list[str] = field(default_factory=list)
    semantic_hits: list[str] = field(default_factory=list)
    rationale: str = ""

    def audit(self) -> dict:
        """Structured audit log entry (operational-stability / explainability)."""
        return {
            "route": self.route.value,
            "tools": self.tools,
            "structured_signals": self.structured_hits,
            "semantic_signals": self.semantic_hits,
            "rationale": self.rationale,
            "deterministic": True,
        }


def _scan(query: str, signals: list[tuple[str, str]]) -> list[str]:
    return [name for pat, name in signals if re.search(pat, query)]


# Tool names match the reused DB-MCP layer (postgres-mcp / mcp-toolbox).
SQL_TOOL = "sql.execute"
VECTOR_TOOL = "vector.search"


def route(query: str) -> RouteDecision:
    """Pure function: query string -> deterministic routing decision."""
    q = query.strip()
    s_hits = _scan(q, STRUCTURED_SIGNALS)
    m_hits = _scan(q, SEMANTIC_SIGNALS)

    if s_hits and m_hits:
        r, tools, why = Route.HYBRID, [SQL_TOOL, VECTOR_TOOL], "structured + semantic signals both present"
    elif s_hits:
        r, tools, why = Route.STRUCTURED, [SQL_TOOL], "only structured signals"
    elif m_hits:
        r, tools, why = Route.SEMANTIC, [VECTOR_TOOL], "only semantic signals"
    else:
        # Ambiguous -> fan out both. Safer (fewer misses); RRF merges the results.
        r, tools, why = Route.HYBRID, [SQL_TOOL, VECTOR_TOOL], "no decisive signal; default fan-out"

    return RouteDecision(r, tools, s_hits, m_hits, why)


if __name__ == "__main__":
    samples = [
        "환불 정책에 대한 내용 찾아줘",                       # semantic
        "최근 3개월간 주문 건수 알려줘",                       # structured (time + count)
        "지난달 취소된 주문 중 환불 관련 문의가 비슷한 케이스", # hybrid
        "전체 사용자 수는 몇 명이야",                          # structured
        "이 약관이랑 비슷한 다른 약관 있어?",                  # semantic
    ]
    for s in samples:
        d = route(s)
        print(f"[{d.route.value:10}] {s}  -> {d.tools}  ({d.rationale})")
