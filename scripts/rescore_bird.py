#!/usr/bin/env python3
"""외부 BIRD 결과를 공식 execution-accuracy 의미로 재채점한다 (재추론 없음).

왜 필요한가.
  `external-eval`이 쓰는 비교기는 BIRD 공식과 다르다.

    우리:  정렬한 행 값 튜플의 **다중집합(multiset)** 동등 + 숫자를 소수 6자리로 반올림
    공식:  `set(predicted_res) == set(ground_truth_res)` — **집합(set)** 동등, 중복 무시

  즉 중복 행의 개수만 다른 예측을 우리는 오답으로, 공식은 정답으로 센다. 같은 이름
  (execution accuracy)을 쓰지만 다른 지표이므로, 우리 숫자를 공식 리더보드 옆에
  놓으면 비교가 성립하지 않는다. 1차 확인 = R9 D레인.

무엇을 하나.
  저장된 예측 SQL(`eval/results/external-bird-raw.json`)을 다시 실행해 **두 의미로
  각각 채점**한다. 모델을 돌리지 않으므로 회귀 위험이 없고, 두 수치의 차이가 곧
  비교기 정의의 효과다.

표본의 대표성도 함께 기록한다. 이 32문항은 question_id 정렬 후 주기적 stride
표집이라 대표성이 없다 — 데이터베이스 하나가 통째로 빠지고 난이도가 편중된다.
숨기면 그 수치는 다시 오독된다.

사용: python scripts/rescore_bird.py
"""
from __future__ import annotations

import json
import sqlite3
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / "eval" / "external" / "minidev" / "MINIDEV"
RAW = ROOT / "eval" / "results" / "external-bird-raw.json"
OUT = ROOT / "eval" / "results" / "external-bird-rescore.json"

TIMEOUT_S = 30.0


# 공식 BIRD(`evaluation_ex.py`)는 `cursor.fetchall()`이 돌려준 **파이썬 값 튜플을 그대로**
# set에 넣어 비교한다. 문자열로 정규화하면 두 가지가 깨진다.
#   - NULL을 센티널 문자열로 바꾸면 **실제 NULL과 리터럴 문자열이 충돌**한다(오탐 정답).
#   - 정수 1과 실수 1.0은 파이썬에서 같지만 문자열로는 "1" != "1.0"이라 갈린다(오탐 오답).
# 둘 다 QA 레드팀이 재현했다. 그래서 공식 경로는 정규화하지 않고 raw 값을 쓴다.
def row_key(row) -> tuple:
    """공식 의미용 키. 값을 변형하지 않고 튜플 그대로 쓴다(열 순서 보존)."""
    return tuple(row)


def run(db_path: Path, sql: str):
    """읽기 전용으로 실행한다. 실패는 숨기지 않고 사유를 돌려준다."""
    try:
        uri = f"file:{db_path.as_posix()}?mode=ro"
        con = sqlite3.connect(uri, uri=True, timeout=TIMEOUT_S)
        try:
            con.execute("PRAGMA query_only = ON")
            rows = con.execute(sql).fetchall()
        finally:
            con.close()
        return True, [row_key(r) for r in rows], None
    except Exception as e:  # noqa: BLE001 — 사유를 그대로 보존한다
        return False, [], f"{type(e).__name__}: {e}".split("\n")[0][:200]


def set_match(pred, gold) -> bool:
    """공식 의미: set(pred) == set(gold). 중복 다중도를 무시한다."""
    return set(pred) == set(gold)


def multiset_match(pred, gold) -> bool:
    """운영 의미: 다중집합 동등. 중복 개수까지 같아야 한다."""
    return Counter(pred) == Counter(gold)


def main() -> int:
    raw = json.loads(RAW.read_text(encoding="utf-8"))
    gold_file = json.loads((BASE / "mini_dev_sqlite.json").read_text(encoding="utf-8"))
    gold_of = {q["question_id"]: q for q in gold_file}

    set_correct = multiset_correct = gold_failed = 0
    rows, diverged = [], []

    for r in raw:
        q = gold_of.get(r["id"])
        if q is None:
            raise SystemExit(f"gold 없음: question_id={r['id']}")
        db = BASE / "dev_databases" / q["db_id"] / f"{q['db_id']}.sqlite"

        g_ok, g_rows, g_err = run(db, q["SQL"])
        if not g_ok:
            # gold가 실행 안 되면 그 문항은 어떤 의미로도 채점할 수 없다. 숨기지 않는다.
            gold_failed += 1
            rows.append({"id": r["id"], "db": r["db"], "diff": r["diff"], "scorable": False, "gold_error": g_err})
            continue

        p_ok, p_rows, p_err = (True, [], None) if not r.get("pred") else run(db, r["pred"])
        if not r.get("pred"):
            p_ok = False

        as_set = p_ok and set_match(p_rows, g_rows)
        as_multiset = p_ok and multiset_match(p_rows, g_rows)
        set_correct += as_set
        multiset_correct += as_multiset
        if as_set != as_multiset:
            diverged.append({
                "id": r["id"], "db": r["db"], "diff": r["diff"],
                "as_set": as_set, "as_multiset": as_multiset,
                "pred_rows": len(p_rows), "gold_rows": len(g_rows),
                "pred_distinct": len(set(p_rows)), "gold_distinct": len(set(g_rows)),
            })
        rows.append({
            "id": r["id"], "db": r["db"], "diff": r["diff"], "scorable": True,
            "as_set": as_set, "as_multiset": as_multiset, "pred_ok": p_ok, "pred_error": p_err,
        })

    scorable = sum(1 for x in rows if x["scorable"])

    sampled_dbs = {r["db"] for r in raw}
    all_dbs = {q["db_id"] for q in gold_file}
    missing = sorted(all_dbs - sampled_dbs)
    by_diff = dict(Counter(r["diff"] for r in raw))

    out = {
        "note": (
            "저장된 예측 SQL을 재실행해 두 비교 의미로 각각 채점했다. 모델은 돌리지 않았다(재추론 없음). "
            "official_set = BIRD 공식 의미(set(pred)==set(gold), 중복 무시). "
            "operational_multiset = 이 저장소의 운영 지표(다중집합 동등, 중복 개수까지 일치). "
            "두 수치의 차이는 비교기 정의의 효과이며 모델 성능 차이가 아니다."
        ),
        "sample": {
            "n": len(raw),
            "scorable": scorable,
            "gold_failed": gold_failed,
            "databases_sampled": len(sampled_dbs),
            "databases_total": len(all_dbs),
            "databases_missing": missing,
            "by_difficulty": by_diff,
            "representativeness": (
                "question_id 정렬 후 주기적 stride 표집이라 대표성이 없다. "
                "공식 Mini-Dev 난이도 구성은 30/50/20이고 데이터베이스는 11개다. "
                "이 표본으로 Mini-Dev 성능을 추정할 수 없다."
            ),
        },
        "official_set": {
            "correct": set_correct, "of": scorable,
            "accuracy": round(set_correct / scorable, 3) if scorable else None,
        },
        "operational_multiset": {
            "correct": multiset_correct, "of": scorable,
            "accuracy": round(multiset_correct / scorable, 3) if scorable else None,
        },
        "diverged": diverged,
        "rows": rows,
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(json.dumps({k: v for k, v in out.items() if k not in ("rows",)}, ensure_ascii=False, indent=2))
    print(f"\n기록: {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
