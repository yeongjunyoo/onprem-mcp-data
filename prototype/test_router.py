"""Router tests: correctness on Korean queries + the determinism property
(the operational-stability claim must be true, not asserted)."""
from router import route, Route, SQL_TOOL, VECTOR_TOOL


def test_structured_count_time():
    d = route("최근 3개월간 주문 건수 알려줘")
    assert d.route is Route.STRUCTURED
    assert d.tools == [SQL_TOOL]
    assert "count" in d.structured_hits and "time_filter" in d.structured_hits


def test_semantic_aboutness():
    d = route("환불 정책에 대한 내용 찾아줘")
    assert d.route is Route.SEMANTIC
    assert d.tools == [VECTOR_TOOL]


def test_hybrid_when_both():
    d = route("지난달 취소된 주문 중 환불 관련 문의가 비슷한 케이스")
    assert d.route is Route.HYBRID
    assert d.tools == [SQL_TOOL, VECTOR_TOOL]
    assert d.structured_hits and d.semantic_hits


def test_ambiguous_defaults_to_hybrid_fanout():
    d = route("주문")
    assert d.route is Route.HYBRID  # no decisive signal -> safe fan-out


def test_determinism_zero_variance():
    # The core operational-stability claim: same query -> identical decision, every run.
    q = "지난달 취소된 주문 중 환불 관련 문의가 비슷한 케이스"
    first = route(q).audit()
    for _ in range(20):
        assert route(q).audit() == first


def test_audit_log_shape():
    d = route("전체 사용자 수는 몇 명이야")
    a = d.audit()
    assert a["deterministic"] is True
    assert a["route"] == "structured"
    assert set(a) == {"route", "tools", "structured_signals", "semantic_signals", "rationale", "deterministic"}
