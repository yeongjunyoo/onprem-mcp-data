#!/usr/bin/env python3
"""홀드아웃 2차 라우팅 평가셋 — 1차가 오염된 뒤에 일반화를 다시 재기 위한 것.

왜 2차가 필요한가.
  1차 홀드아웃(`holdout_route.json`)은 라우터의 온톨로지 커버리지 구멍을 **진단하는 데**
  썼다(2026-08-16, PR #14). 진단에 쓴 순간 그것은 더 이상 홀드아웃이 아니다. 수정 후
  1차에서 0.900이 나온 것은 "고친 것이 고쳐졌다"는 확인이지 일반화의 증거가 아니다.
  그래서 수정 이후 한 번도 보지 않은 문구로 다시 묻는다.

이 생성기가 1차와 다르게 강제하는 것.
  1. **표면형을 업무 담당자의 말투로 쓴다.** 1차는 템플릿 문형이 규칙적이라 라우터에
     유리했다. 여기서는 어미·조사·어순을 흔들고 구어체를 섞는다.
  2. **온톨로지 엣지 7종을 전수 포함한다.** 1차는 USES/BELONGS_TO/MANAGES_ACCOUNT/
     HAS_PROJECT에 몰려 있어 HEAD_IS·LEADS·REPORTED_ISSUE 표면형을 재지 못했다.
  3. **라우터 어휘를 보지 않고 쓴다.** 사전에 있는 단어를 골라 쓰면 측정이 아니라 연출이다.
     결과가 낮게 나오면 낮은 대로 적는다.
  4. 고유명사는 데이터셋에 실재하는 것에서 뽑는다(존재하지 않는 개체를 물으면
     라우팅이 아니라 환각 차단을 재게 된다).

사용: python eval/companyx/build_holdout2_route.py [--check-only]
"""
from __future__ import annotations

import argparse
import json
import random
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "datasets" / "companyx-v1.0"
OUT_DEFAULT = ROOT / "eval" / "companyx" / "holdout2_route.json"

# 이미 써버린 문구. 1차 홀드아웃과 공개 30문항의 표면형은 재사용하지 않는다.
BURNED_SOURCES = [
    DATA / "questions.json",
    ROOT / "eval" / "companyx" / "holdout_route.json",
]


def load_entities():
    nodes = json.loads((DATA / "graph" / "nodes.json").read_text(encoding="utf-8"))
    by = {}
    for n in nodes:
        by.setdefault(n["type"], []).append(n["name"])
    return by


def burned_phrases() -> list[str]:
    out: list[str] = []
    for p in BURNED_SOURCES:
        if not p.exists():
            continue
        d = json.loads(p.read_text(encoding="utf-8"))
        items = d if isinstance(d, list) else (d.get("items") or d.get("questions") or [])
        for it in items:
            q = it.get("q") or it.get("question")
            if q:
                out.append(q)
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(OUT_DEFAULT))
    ap.add_argument("--check-only", action="store_true")
    ap.add_argument("--seed", type=int, default=20260816)
    args = ap.parse_args()

    rng = random.Random(args.seed)
    ents = load_entities()
    clients = ents["client"]
    products = ents["product"]
    employees = ents["employee"]
    departments = ents["department"]

    # (라벨, 엣지타입 또는 근거, 표면형). 라벨은 데이터 구조가 정한다:
    #   집계/필터 = 컬럼이 답한다 -> nl2sql
    #   산문/절차 = 문서가 답한다 -> vector_search
    #   개체 간 연결 = 엣지가 답한다 -> knowledge_graph
    items: list[dict] = []

    def add(label: str, basis: str, q: str) -> None:
        items.append({"q": q, "expected": label, "basis": basis})

    # ── nl2sql 10 — 전부 컬럼 집계/필터 ────────────────────────────────
    add("nl2sql", "contracts.amount 집계", "작년 대비 올해 계약 금액이 얼마나 늘었어?")
    add("nl2sql", "employees.salary 집계", "연봉 상위 10명의 평균이 궁금한데")
    add("nl2sql", "sales 집계", f"{rng.choice(products)} 이거 분기별로 얼마나 팔렸어?")
    add("nl2sql", "clients 필터+카운트", "신규로 들어온 고객사가 몇 군데나 돼?")
    add("nl2sql", "tickets 상태 필터", "아직 안 닫힌 티켓 몇 건이나 남았지?")
    add("nl2sql", "contracts 정렬", "계약 규모 큰 순으로 스무 곳만 뽑아줘")
    add("nl2sql", "employees 필터", "퇴사자 빼고 인원수만 알려줄래?")
    add("nl2sql", "sales 지역 집계", "지역별로 매출 얼마씩 나왔는지 정리해줘")
    add("nl2sql", "projects.budget 집계", "예산 초과한 프로젝트 총액이 얼마지?")
    add("nl2sql", "tickets 우선순위 집계", "우선순위별 티켓 분포 좀 보여줘")

    # ── vector_search 10 — 전부 문서 산문이 답한다 ──────────────────────
    add("vector_search", "기술문서", "신규 입사자가 개발 환경 세팅하려면 뭐부터 해야 해?")
    add("vector_search", "장애보고서", "지난번 디스크 꽉 찼을 때 어떻게 복구했더라?")
    add("vector_search", "정책문서", "재해 복구 절차가 문서로 정리된 게 있나?")
    add("vector_search", "기술문서", "로그 수집 파이프라인을 어떤 식으로 꾸렸는지 설명해줘")
    add("vector_search", "회의록", "지난 분기 회고에서 나온 개선 안건 뭐였지?")
    add("vector_search", "제안서", "고객사에 낸 제안서 중에 아키텍처 설명한 부분 찾아줘")
    add("vector_search", "정책문서", "권한 요청은 어떤 절차를 밟아야 하는지 알려줘")
    add("vector_search", "장애보고서", "네트워크 지연 때문에 생긴 사고 기록 있어?")
    add("vector_search", "기술문서", "모니터링 알람 임계값은 어떤 기준으로 잡았어?")
    add("vector_search", "정책문서", "개인정보 처리할 때 지켜야 하는 원칙이 뭐야?")

    # ── knowledge_graph 10 — 엣지 7종 전수 ──────────────────────────────
    add("knowledge_graph", "USES", f"{rng.choice(clients)} 여기는 우리 솔루션 중에 뭘 쓰지?")
    add("knowledge_graph", "USES", f"{rng.choice(products)} 이거 깔려 있는 데가 어디어디야?")
    add("knowledge_graph", "BELONGS_TO", f"{rng.choice(employees)} 사원은 어느 조직 사람이야?")
    add("knowledge_graph", "BELONGS_TO", f"{rng.choice(departments)} 인원 구성 좀 보여줘")
    add("knowledge_graph", "MANAGES_ACCOUNT", f"{rng.choice(clients)} 여기 창구가 누구야?")
    add("knowledge_graph", "MANAGES_ACCOUNT", "고객사를 제일 많이 끼고 있는 사람이 누구지?")
    add("knowledge_graph", "LEADS", f"{rng.choice(employees)} 직원이 리드하는 건이 뭐가 있어?")
    add("knowledge_graph", "HEAD_IS", f"{rng.choice(departments)} 윗선이 누구인지 알려줘")
    add("knowledge_graph", "REPORTED_ISSUE", f"{rng.choice(products)} 이거 말썽 많이 나는 편이야?")
    add("knowledge_graph", "HAS_PROJECT", f"{rng.choice(employees)} 직원 지금 무슨 건 붙어 있어?")

    # ── 검증: 통과 못 하면 기록하지 않는다 ───────────────────────────────
    burned = burned_phrases()
    problems: list[str] = []

    if len(items) != 30:
        problems.append(f"문항 수 {len(items)} (30이어야 함)")

    seen = set()
    for it in items:
        if it["q"] in seen:
            problems.append(f"중복 문항: {it['q']}")
        seen.add(it["q"])
        if it["q"] in burned:
            problems.append(f"기존 평가셋과 동일한 문항: {it['q']}")

    # 표면형 겹침: 기존 문항과 8글자 이상 연속 일치하면 베낀 것으로 본다.
    #
    # 고유명사는 검사에서 제외한다. 개체는 반드시 데이터셋에 실재하는 것에서 뽑아야
    # 하므로 겹치는 것이 정상이고, 여기서 재려는 것은 「묻는 방식」이 겹치는가다.
    all_names = sorted(
        {n for names in ents.values() for n in names} | {"Client", "Product", "project", "dept"},
        key=len,
        reverse=True,
    )

    def mask(text: str) -> str:
        for n in all_names:
            text = text.replace(n, "\u3007")
        return text

    burned_masked = [mask(b) for b in burned]
    for it in items:
        q = mask(it["q"])
        hit = next(
            (q[i : i + 8] for i in range(len(q) - 7) if any(q[i : i + 8] in b for b in burned_masked)),
            None,
        )
        if hit:
            problems.append(f"표면형 8자 겹침 '{hit}' :: {it['q']}")

    # 엣지 전수 커버
    edges = json.loads((DATA / "graph" / "edges.json").read_text(encoding="utf-8"))
    edge_types = {e["relation"] for e in edges}
    covered = {it["basis"] for it in items if it["expected"] == "knowledge_graph"}
    missing = sorted(edge_types - covered)
    if missing:
        problems.append(f"엣지 타입 미커버: {missing}")

    # 라벨 균형
    from collections import Counter

    dist = Counter(it["expected"] for it in items)
    if set(dist.values()) != {10}:
        problems.append(f"라벨 불균형: {dict(dist)}")

    if problems:
        print("검증 실패:")
        for p in problems:
            print("  -", p)
        return 1

    print(f"검증 통과: {len(items)}문항, 라벨 {dict(dist)}, 엣지 {len(edge_types)}종 전수 커버")
    if args.check_only:
        return 0

    payload = {
        "note": (
            "홀드아웃 2차. 1차 홀드아웃은 라우터 온톨로지 커버리지 구멍을 진단하는 데 썼으므로 "
            "더 이상 홀드아웃이 아니다. 이 평가셋은 그 수정 이후 라우터가 한 번도 보지 않은 문구다. "
            "표면형은 업무 담당자의 구어체로 쓰고 어미·조사·어순을 흔들었으며, 온톨로지 엣지 7종을 "
            "전수 포함한다. 라벨은 데이터 구조가 정한다(컬럼이 답하면 nl2sql, 문서가 답하면 "
            "vector_search, 엣지가 답하면 knowledge_graph)."
        ),
        "seed": args.seed,
        "items": items,
    }
    Path(args.out).write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"기록: {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
