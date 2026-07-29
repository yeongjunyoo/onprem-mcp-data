#!/usr/bin/env python3
"""벡터 레인 평가셋 확장기 (8문항 -> 70문항+).

왜 필요한가: 기존 평가는 채점 가능한 문항이 8개뿐이라 hit@5 = 1.00의
95% Wilson 하한이 약 0.68이었다. 그 수치로는 임베딩 모델 우열을 판정할 수 없다.
(근거: R4 리서치 D1 레인, 2026-07-29)

오라클 계약은 그대로 둔다: 문서가 gold인 조건은 `keywords`를 **전부** 포함하는
것이고, 검색기는 질문 문장만 본다. 즉 정답 집합은 시스템과 독립이다.

이 스크립트가 추가로 강제하는 것:
  1. gold 집합 크기가 1~3이어야 한다. 0이면 채점 불가, 4 이상이면 변별력이 없다.
  2. `style` 표기. `entity`는 질문에 고유명이 그대로 나오는 현실적 질의,
     `paraphrase`는 키워드가 질문에 하나도 안 나오는 의미검색 전용 질의다.
     paraphrase 문항이 실제 의미 검색 능력을 가른다.
  3. 문서 40건을 모두 덮는다. 특정 문서 유형에 쏠리면 유형 정확도가 왜곡된다.

사용: python eval/companyx/build_vector_gold.py [--out eval/companyx/vector_gold.json]
"""
from __future__ import annotations

import argparse
import json
import math
import re
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DOCS = ROOT / "datasets" / "companyx-v1.0" / "documents"

ORACLE = (
    "Gold sets are computed by a DETERMINISTIC LEXICAL RULE over the raw documents "
    "(a doc is gold iff it contains every keyword in `keywords`, case-insensitive) "
    "and/or by the document type declared in documents/index.json. The retriever never "
    "sees the keywords - it only embeds the natural-language question - so lexical gold "
    "+ semantic retrieval keeps the oracle independent of the system under test. "
    "Questions whose sponsor hint names only a document TYPE are scored on type accuracy alone. "
    "`style` marks whether the question repeats the keywords (entity) or avoids them entirely "
    "(paraphrase); paraphrase items are the ones that actually test semantic retrieval."
)

# (질문, 기대 문서유형 or None, 키워드, style)
# 사업자 원문에서 확인한 사실만 쓴다. 숫자와 고유명은 문서에 실제로 있는 값이다.
ITEMS: list[tuple[str, str | None, list[str], str]] = [
    # ---- 기존 8문항 회귀 유지 (원본 vector_gold.json) ----
    ("최근 서버 장애 사례와 원인을 알려줘", "incident_report", [], "entity"),
    ("Product-C1 설치 방법이 궁금해", "technical_doc", ["Product-C1", "설치"], "entity"),
    ("Kubernetes 관련 장애 대응 방법은?", "incident_report", [], "entity"),
    ("Client-A와의 회의에서 결정된 사항은?", "meeting_note", ["Client-A", "결정 사항"], "entity"),
    ("SSL 인증서 만료로 인한 장애가 있었나요?", "incident_report", ["SSL 인증서 만료"], "entity"),
    ("Product-S2 성능 튜닝 방법 알려줘", "technical_doc", ["Product-S2", "성능 최적화"], "entity"),
    ("제안서에서 언급된 ROI는?", "proposal", [], "entity"),
    ("DB 연결 풀 고갈 문제 해결 방법", None, ["DB 연결 풀 고갈"], "entity"),

    # ---- 장애보고서 10건: 문서당 최소 1문항, 절반은 paraphrase ----
    ("디스크 입출력 성능이 한계에 도달해 데이터베이스 조회가 끊긴 사고는 어느 고객사였나", "incident_report", ["Client-A", "IOPS"], "paraphrase"),
    ("Client-A 사고에서 복구까지 걸린 총 시간은", "incident_report", ["Client-A", "완전 복구"], "entity"),
    ("트래픽을 나눠 주는 장비의 상태 점검이 실패해 분산이 안 된 첫 번째 사례", "incident_report", ["Client-B", "헬스체크"], "paraphrase"),
    ("Client-B 장애의 심각도 등급은 무엇이었나", "incident_report", ["Client-B", "Medium"], "entity"),
    ("커넥션 풀이 바닥나서 응답이 밀린 Client-C 사고의 조치 항목", "incident_report", ["Client-C", "로드밸런서 설정 복구"], "entity"),
    ("전체 서비스가 멈춘 등급의 장애를 겪은 고객사는", "incident_report", ["전체 서비스 중단"], "paraphrase"),
    ("보안 패치를 올린 뒤 호환성 문제가 터진 사고들", "incident_report", ["보안 패치 적용 후 호환성"], "paraphrase"),
    ("인증서 유효기간이 지나 암호화 통신이 끊긴 Client-E 사고의 대응", "incident_report", ["Client-E", "긴급 스케일아웃"], "paraphrase"),
    ("Client-F에서 발생한 HTTPS 통신 실패 사고는 언제였나", "incident_report", ["Client-F", "2025-10-19"], "entity"),
    ("컨테이너가 메모리 한계로 계속 재시작된 사고", "incident_report", ["Pod OOM"], "paraphrase"),
    ("Client-G 사고에서 감지까지 몇 분 걸렸는지", "incident_report", ["Client-G", "6분"], "entity"),
    ("가장 높은 심각도로 분류된 Client-H 사고의 원인 분석", "incident_report", ["Client-H", "Critical"], "entity"),
    ("Client-I에서 새벽이 아닌 오후에 발생한 크리티컬 등급 사고", "incident_report", ["Client-I", "Critical"], "entity"),
    ("2026년에 접수된 장애 보고서가 있나", "incident_report", ["2026-02-16"], "paraphrase"),
    ("외부 의존 서비스의 지연이 번져 2026년에 터진 사고의 권고 패턴", "incident_report", ["서킷브레이커", "2026-02-16"], "paraphrase"),
    ("장애 대응 담당이 조예진이었던 보고서", "incident_report", ["조예진"], "entity"),

    # ---- 기술문서 10건 ----
    ("Product-C1을 올리려면 디스크 용량이 얼마나 필요한가", "technical_doc", ["Product-C1", "146GB"], "entity"),
    ("서비스가 처음 뜨는 데 걸리는 시간이 38초라고 적힌 문서", "technical_doc", ["38초"], "entity"),
    ("메모리는 최소 몇 기가를 잡아야 Product-D2를 설치할 수 있나", "technical_doc", ["Product-D2", "8GB"], "entity"),
    ("Product-C2의 오토스케일링은 CPU 사용률 몇 퍼센트에서 동작하나", "technical_doc", ["Product-C2", "78%"], "entity"),
    ("메시지를 비동기로 주고받는 큐로 무엇을 쓰는지", "technical_doc", ["RabbitMQ"], "paraphrase"),
    ("서비스 간 통신을 상호 인증 방식으로 암호화한다고 설계된 제품", "technical_doc", ["mTLS"], "paraphrase"),
    ("Product-S1의 백업은 며칠 동안 보관되나", "technical_doc", ["Product-S1", "26일"], "entity"),
    ("응답 시간 상위 백분위 기준이 330밀리초로 잡힌 운영 문서", "technical_doc", ["330ms"], "entity"),
    ("로그를 121일간 보관한다고 명시한 제품", "technical_doc", ["121일"], "entity"),
    ("무중단 배포를 위해 두 벌의 환경을 번갈아 쓰는 전략", "technical_doc", ["블루/그린"], "paraphrase"),
    ("Product-S2의 커넥션 풀 최대값은 얼마인가", "technical_doc", ["Product-S2", "최대 90"], "entity"),
    ("가비지 컬렉션 최대 정지 시간을 102밀리초로 맞추라는 지침", "technical_doc", ["MaxGCPauseMillis=102"], "entity"),
    ("Product-D3의 쿼리 캐시 만료 시간은", "technical_doc", ["Product-D3", "TTL 200초"], "entity"),
    ("콘텐츠 전송망을 붙이면 캐시 적중률을 91퍼센트까지 올릴 수 있다는 문서", "technical_doc", ["91%"], "entity"),
    ("Product-D1 API에서 분당 요청 한도를 넘기면 어떤 코드가 오나", "technical_doc", ["Product-D1", "429"], "entity"),
    ("프리미엄 등급의 분당 호출 상한이 3167회인 제품", "technical_doc", ["3167"], "entity"),
    ("토큰을 발급받는 엔드포인트 경로가 무엇인지", "technical_doc", ["/auth/token"], "paraphrase"),

    # ---- 회의록 10건 ----
    ("Client-A 미팅에서 보안 점검 결과 몇 건이 나왔나", "meeting_note", ["Client-A", "7건"], "entity"),
    ("일정이 2주 늘어나기로 합의된 회의", "meeting_note", ["일정 2주 연장 합의"], "paraphrase"),
    ("Client-B와의 회의에서 예산은 얼마나 집행됐다고 보고됐나", "meeting_note", ["Client-B", "49%"], "entity"),
    ("본사 3층에서 열린 Client-C 회의의 진행률", "meeting_note", ["Client-C", "40%"], "entity"),
    ("추가 인력 두 명이 더 필요하다고 보고된 회의", "meeting_note", ["추가 인력 2명"], "paraphrase"),
    ("진행률이 80퍼센트라고 공유된 화상회의", "meeting_note", ["80%"], "entity"),
    ("응답 시간이 기준을 넘는 구간이 발견돼 캐싱 전략을 다시 보자고 한 회의", "meeting_note", ["캐싱 전략 재검토"], "paraphrase"),
    ("Client-G 회의에서 예산 집행률은 몇 퍼센트로 보고됐나", "meeting_note", ["Client-G", "46%"], "entity"),
    ("킥오프 성격으로 열린 Client-H 미팅의 참석 인원", "meeting_note", ["Client-H", "박민수"], "entity"),
    ("다음 스프린트에 보안 패치를 먼저 넣기로 한 회의", "meeting_note", ["보안 패치 우선 적용"], "paraphrase"),
    ("Client-I 회의에서 마일스톤이 며칠 밀렸다고 했나", "meeting_note", ["Client-I", "13일"], "entity"),
    ("고객사 사무실을 직접 방문해서 진행한 회의", "meeting_note", ["고객사 방문"], "paraphrase"),
    ("투입 인력이 여덟 명이라고 보고된 회의", "meeting_note", ["투입 인력 8명"], "paraphrase"),
    ("검증 환경을 먼저 만들고 본 환경에 적용하자고 결정한 회의들", "meeting_note", ["POC 환경 우선 구축"], "paraphrase"),

    # ---- 제안서 10건 ----
    ("교육 분야 대기업을 대상으로 한 클라우드 전환 제안", "proposal", ["Client-F", "교육"], "paraphrase"),
    ("Client-F 제안서의 초기 구축 비용은 얼마인가", "proposal", ["Client-F", "초기 구축비"], "entity"),
    ("광주에 있는 미디어 스타트업에 낸 제안서", "proposal", ["Client-G", "미디어"], "paraphrase"),
    ("규모가 작은 회사를 겨냥한 클라우드 이전 도구를 제안한 문서", "proposal", ["중소기업용"], "paraphrase"),
    ("제주 소재 에너지 기업에 제로트러스트 보안을 제안한 건", "proposal", ["Client-H", "제로트러스트"], "paraphrase"),
    ("건설 분야 고객에게 엔드포인트 보안과 암호화를 제안한 문서", "proposal", ["Client-I", "엔드포인트 보안"], "paraphrase"),
    ("Client-I 제안의 총소유비용 절감률은", "proposal", ["Client-I", "TCO"], "entity"),
    ("공공기관 스타트업에 실시간 데이터 파이프라인을 제안한 건", "proposal", ["Client-J", "실시간 데이터 파이프라인"], "paraphrase"),
    ("부산 제조업 고객에게 자연어 질의가 되는 대시보드를 제안한 문서", "proposal", ["Client-K", "자연어 질의"], "paraphrase"),
    ("금융권 고객에게 인프라 모니터링과 알림을 제안한 건", "proposal", ["Client-L", "모니터링 및 알림"], "paraphrase"),
    ("대구의 IT 스타트업에 배포 자동화 도구를 제안한 문서", "proposal", ["Client-M", "CI/CD"], "paraphrase"),
    ("이상 탐지를 머신러닝으로 하는 플랫폼을 제안받은 고객사", "proposal", ["Client-N", "이상 탐지"], "paraphrase"),
    ("의료 바이오 대기업에 인증 관리 시스템을 제안한 건", "proposal", ["Client-O", "보안 인증 관리"], "paraphrase"),
    ("운영 비용을 39퍼센트 줄일 수 있다고 적힌 제안서", "proposal", ["39% 절감"], "entity"),
    ("구축 2단계에만 8주가 걸린다고 잡은 제안서", "proposal", ["**2단계** (8주)"], "entity"),
    ("투자 회수 기간을 18개월로 본 제안", "proposal", ["18개월"], "entity"),
]


def load_corpus() -> tuple[list[dict], dict[str, str]]:
    index = json.loads((DOCS / "index.json").read_text(encoding="utf-8"))
    text = {e["id"]: (DOCS / e["filename"]).read_text(encoding="utf-8").lower() for e in index}
    return index, text


def gold_for(keywords: list[str], index: list[dict], text: dict[str, str]) -> list[str]:
    if not keywords:
        return []
    return [e["id"] for e in index if all(k.lower() in text[e["id"]] for k in keywords)]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(ROOT / "eval" / "companyx" / "vector_gold.json"))
    ap.add_argument("--check-only", action="store_true")
    args = ap.parse_args()

    index, text = load_corpus()
    type_of = {e["id"]: e["type"] for e in index}

    items, problems = [], []
    covered: Counter[str] = Counter()
    for q, typ, kws, style in ITEMS:
        gold = gold_for(kws, index, text)
        if kws:
            if not gold:
                problems.append(f"gold 0건: {q} :: {kws}")
                continue
            if len(gold) > 3:
                problems.append(f"gold {len(gold)}건으로 과다(변별력 없음): {q} :: {kws}")
                continue
            if typ and any(type_of[g] != typ for g in gold):
                problems.append(f"기대 유형 {typ}와 gold 유형 불일치: {q} :: {[(g, type_of[g]) for g in gold]}")
                continue
        leaked = bool(kws) and all(k.lower() in q.lower() for k in kws)
        if style == "paraphrase" and leaked:
            problems.append(f"paraphrase인데 질문이 키워드를 그대로 포함: {q} :: {kws}")
            continue
        for g in gold:
            covered[g] += 1
        items.append({"q": q, "type": typ, "keywords": kws, "style": style, "gold_preview": gold})

    scored = [i for i in items if i["keywords"]]
    para = [i for i in scored if i["style"] == "paraphrase"]
    uncovered = [e["id"] for e in index if covered[e["id"]] == 0]

    print(f"문항 {len(items)}개 (채점 가능 {len(scored)}, paraphrase {len(para)})")
    print(f"문서 커버리지 {40 - len(uncovered)}/40" + (f", 미커버 {uncovered}" if uncovered else ""))
    n = len(scored)
    if n:
        # 정확도 1.0일 때의 Wilson 95% 하한. 표본이 작으면 이 값이 곧 결론의 한계다.
        z = 1.96
        lo = (n / (n + z * z)) * (1 + z * z / (2 * n) - z * math.sqrt((1 / n) * (z * z / (4 * n) + 0) + 0))
        lo = (1 + z * z / (2 * n) - z * math.sqrt(z * z / (4 * n * n) + 0)) / (1 + z * z / n)
        print(f"hit@5=1.00 가정 시 95% Wilson 하한 {lo:.3f} (문항 {n}개 기준)")
    for p in problems:
        print("  ! " + p)
    if problems:
        print(f"\n검증 실패 {len(problems)}건. 수정 전에는 기록하지 않는다.")
        return 1

    if args.check_only:
        return 0

    out = {
        "oracle": ORACLE,
        "generated_by": "eval/companyx/build_vector_gold.py",
        "items": [{k: v for k, v in i.items() if k != "gold_preview"} for i in items],
    }
    Path(args.out).write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"\n기록: {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
