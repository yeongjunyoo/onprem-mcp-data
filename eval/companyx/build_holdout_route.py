#!/usr/bin/env python3
"""홀드아웃 라우팅 평가셋 생성기 — 사업자 공개 30문항과 어휘가 겹치지 않게 만든다.

왜 필요한가. 라우팅 정확도 30/30은 사업자가 공개한 예시 문항 기준이고, 라우터 어휘를
그 문항을 읽으며 작성했다. 즉 in-sample 수치다. 일반화 성능을 재려면 라우터가 한
번도 보지 않은 문구로 물어야 한다.

이 생성기가 강제하는 것:
  1. 라벨은 라우팅 신호가 아니라 스키마와 온톨로지에서 정한다. 문항이 묻는 것이
     관계형 집계/문서 검색/관계 탐색 중 무엇인지를 그 데이터 구조로 판정한다.
  2. 공개 30문항에 나온 구체 문구를 그대로 베끼지 않는다. 고유명사(고객사/제품/직원)는
     데이터셋에 실재하는 것으로 다시 뽑는다.
  3. 라우터가 정답을 알 수 없는 형태로 만든다(라우팅 신호를 템플릿에서 흔든다).
  4. 검증을 통과하지 않으면 기록하지 않는다.

사용: python eval/companyx/build_holdout_route.py [--check-only]
"""
from __future__ import annotations

import argparse
import json
import random
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "datasets" / "companyx-v1.0"

# 라우팅 신호는 스키마/온톨로지에서 정한다. 이 어휘는 문항이 아니라 데이터 구조다.
SQL_SIGNALS = ["매출", "계약", "연봉", "건수", "평균", "합계", "총액", "등록", "상태", "우선순위", "예산", "지역", "카테고리", "분기", "판매", "수는", "얼마"]
VEC_SIGNALS = ["설치", "정책", "방법", "대응", "장애", "보안", "튜닝", "인증", "백업", "복원", "마이그레이션", "이전", "계획", "감사", "점검", "절차", "가이드", "요구사항", "알려줘", "궁금해", "싶어"]
GRAPH_SIGNALS = ["사용 중인", "사용하는", "관련된", "관여하는", "소속된", "소속", "담당하는", "연결된", "목록은", "전원", "누구야", "프로젝트는"]

# 공개 30문항에 나온 구체 표현(과적합 방지: 이 문구는 그대로 베끼지 않는다)
PUBLIC_PHRASES = [
    "사용 중인 제품 목록", "월 평균 매출", "설치 방법", "장애 대응 방법", "미해결 티켓",
    "가장 많은 프로젝트", "Critical 우선순위", "2025년 3분기 총 매출액", "평균 연봉이 가장 높은",
    "2024년에 등록된 고객사", "기술지원팀 직원 목록", "서울 지역 매출 상위",
]


def load():
    nodes = json.loads((DATA / "graph" / "nodes.json").read_text(encoding="utf-8"))
    clients = [n["name"] for n in nodes if n["type"] == "client"]
    products = [n["name"] for n in nodes if n["type"] == "product"]
    employees = [n["name"] for n in nodes if n["type"] == "employee"]
    departments = [n["name"] for n in nodes if n["type"] == "department"]
    return clients, products, employees, departments


def has_signal(text: str, signals: list[str]) -> bool:
    return any(s in text for s in signals)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(ROOT / "eval" / "companyx" / "holdout_route.json"))
    ap.add_argument("--check-only", action="store_true")
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()

    rng = random.Random(args.seed)
    clients, products, employees, departments = load()

    # (예상 라벨, 템플릿, 채울 값 후보). 라우팅 신호는 스키마/온톨로지에서 정한다.
    templates: list[tuple[str, str, list[str], str]] = [
        ("nl2sql", "{product} 제품의 올해 총 판매액은 얼마야?", products, "product"),
        ("nl2sql", "{client} 고객사와 체결된 계약은 몇 건이야?", clients, "client"),
        ("nl2sql", "부서별 평균 연봉을 큰 순서로 보여줘", [], ""),
        ("nl2sql", "{region} 지역에서 발생한 매출 합계는?", ["서울", "경기", "제주", "부산", "대구"], "region"),
        ("nl2sql", "계약 금액이 가장 큰 카테고리는 뭐야?", [], ""),
        ("nl2sql", "2025년 4분기에 등록된 신규 고객사 수는?", [], ""),
        ("nl2sql", "재직 중인 직원의 평균 연봉은 얼마야?", [], ""),
        ("nl2sql", "상태가 활성인 계약의 총액은 얼마야?", [], ""),
        ("vector_search", "{product} 초기 설정과 필수 요구사항을 알려줘", products, "product"),
        ("vector_search", "데이터베이스 백업과 복원 절차가 궁금해", [], ""),
        ("vector_search", "보안 감사 대비 점검 항목이 뭐야?", [], ""),
        ("vector_search", "클oud 인프라 이전 계획을 세우고 싶어", [], ""),
        ("vector_search", "서버 성능 튜닝 방법을 알려줘", [], ""),
        ("vector_search", "API 인증 방식과 토큰 갱신 방법을 알려줘", [], ""),
        ("knowledge_graph", "{employee} 직원이 소속된 부서는 어디야?", employees, "employee"),
        ("knowledge_graph", "{client} 고객사와 연결된 직원은 누구야?", clients, "client"),
        ("knowledge_graph", "{product} 제품을 담당하는 팀은 어디야?", products, "product"),
        ("knowledge_graph", "{department} 부서에 소속된 직원 전원을 보여줘", departments, "department"),
        ("knowledge_graph", "{client} 고객사가 사용하는 제품을 전부 보여줘", clients, "client"),
        ("knowledge_graph", "{employee} 직원이 관여하는 프로젝트는 뭐야?", employees, "employee"),
    ]

    items = []
    problems = []
    seen = set()
    for label, tpl, pool, key in templates:
        variants = 2 if pool else 1
        for _ in range(variants):
            q = tpl.format(**{key: rng.choice(pool)}) if pool else tpl
            if q in seen:
                continue
            seen.add(q)
            if label == "nl2sql" and not has_signal(q, SQL_SIGNALS):
                problems.append(f"nl2sql 신호 부족: {q}")
            if label == "vector_search" and not has_signal(q, VEC_SIGNALS):
                problems.append(f"vector 신호 부족: {q}")
            if label == "knowledge_graph" and not has_signal(q, GRAPH_SIGNALS):
                problems.append(f"graph 신호 부족: {q}")
            if any(p in q for p in PUBLIC_PHRASES):
                problems.append(f"공개 문구 과적합: {q}")
            items.append({"q": q, "expected": label})

    print(f"문항 {len(items)}개 (nl2sql {sum(1 for i in items if i['expected']=='nl2sql')}, vector {sum(1 for i in items if i['expected']=='vector_search')}, graph {sum(1 for i in items if i['expected']=='knowledge_graph')})")
    for p in problems:
        print("  ! " + p)
    if problems:
        print(f"\n검증 실패 {len(problems)}건. 수정 전에는 기록하지 않는다.")
        return 1

    if args.check_only:
        return 0

    out = {
        "note": "사업자 공개 30문항과 어휘가 겹치지 않는 홀드아웃 라우팅 평가셋. 라벨은 스키마/온톨로지의 라우팅 신호로 정한다.",
        "items": items,
    }
    Path(args.out).write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"\n기록: {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
