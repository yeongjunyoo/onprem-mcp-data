# 증거 아티팩트 매니페스트

문서가 인용하는 수치는 전부 이 디렉터리의 실행 결과에서 나온다.

**22/34 개가 자기 생성 시각을 들고 있다.** 나머지는 파일 자체에 시각이 없어
`git log` 로만 추적된다 — 옛 평가기가 그 필드를 안 쓰던 시절의 산출물이다.
없는 시각을 지어내지 않고, 어느 것이 자기 시각을 갖고 어느 것이 안 갖는지 그대로 적는다.

커밋 시각 열은 두지 않는다. CI 는 얕은 클론이라 `git log` 가 이력 대신 checkout
시각을 주므로 환경마다 값이 달라진다 — 재현 가능한 값만 남긴다.

해시는 줄바꿈을 정규화한 SHA-256 앞 16자다(git 이 OS 마다 CRLF/LF 를 바꾸므로).

이 파일은 `node scripts/evidence-manifest.mjs --write` 로 생성하고, CI 가 재생성해도
달라지지 않는지 검사한다. **매니페스트 자체가 낡으면 그것이 다음 번 낡은 아티팩트다.**

| 파일 | 크기 | sha256(16) | 자체 생성시각 |
|---|---:|---|---|
| `companyx-ask-host-gpu.json` | 22,170 | `33944f8ce99163f7` | 2026-08-17T08:14:06 |
| `companyx-ask.json` | 22,883 | `2a49f42f97b4581d` | 2026-08-18T02:55:21 |
| `companyx-audit.json` | 85,011 | `9f26ee08fe290e7d` | 2026-07-29T14:39:23 |
| `companyx-holdout-route.json` | 11,104 | `b30029c31bcb5cfd` | 2026-08-18T07:52:21 |
| `companyx-holdout2-route.json` | 11,103 | `bfbc72fd31065e31` | 2026-08-18T07:52:23 |
| `companyx-hybrid.json` | 113,071 | `93af25bfe935cc98` | 2026-07-29T14:13:17 |
| `companyx-kg.json` | 6,369 | `aab9304ecdb4031e` | 2026-08-18T07:45:54 |
| `companyx-load.json` | 720 | `d77ab0d2521bde6a` | 2026-08-17T12:27:13 |
| `companyx-multi-step.json` | 2,285 | `ba3341c805b1c8d4` | 2026-08-18T08:07:54 |
| `companyx-route.json` | 23,256 | `4aa78f1c53f019e7` | 2026-08-18T07:45:52 |
| `companyx-sql-llm-norepair.json` | 4,972 | `cfd9d08c70a15248` | 2026-07-29T12:48:18 |
| `companyx-sql-llm.json` | 4,864 | `4ad7afdcb2ec0a8f` | 2026-08-17T20:20:15 |
| `companyx-sql-naive-norepair.json` | 5,340 | `141152e4ade6bb89` | 2026-07-29T12:49:47 |
| `companyx-sql-naive.json` | 4,817 | `4b9baa585766485f` | 2026-07-29T12:50:21 |
| `companyx-sql-repeat-llm-norepair.json` | 1,456 | `6ab414c9d7b6b4f0` | 2026-07-29T12:48:18 |
| `companyx-sql-repeat-llm.json` | 1,211 | `76d7d6a2377c348c` | 2026-07-29T12:49:17 |
| `companyx-sql-repeat-naive-norepair.json` | 1,322 | `e9b99c8da8c81c82` | 2026-07-29T12:49:47 |
| `companyx-sql-repeat-naive.json` | 921 | `0b36b54e90223b19` | 2026-07-29T12:50:21 |
| `companyx-vector.json` | 170,890 | `f6241ac4b139e229` | 2026-08-18T07:52:19 |
| `external-bird-raw.json` | 9,878 | `cfe1dc452172c024` | — |
| `external-bird-rescore.json` | 8,863 | `bb10a5d137f00ebe` | 2026-08-17T06:13:28 |
| `external-bird-summary.json` | 680 | `8f4c2b484a0f59f3` | — |
| `faults.json` | 1,013 | `ef49562c09b91c16` | — |
| `internal-llm-raw.json` | 20,454 | `9abd9ae51ba4cf6e` | — |
| `internal-llm-summary.json` | 1,202 | `6f7a3328168ebe6d` | — |
| `internal-naive-raw.json` | 22,556 | `c5d84677e2b4f10d` | — |
| `internal-naive-summary.json` | 1,203 | `0f33a9261810caf0` | — |
| `internal-template-raw.json` | 15,293 | `b04f711a734547df` | — |
| `internal-template-summary.json` | 1,204 | `5f9c08622087364a` | — |
| `recall-bge.json` | 3,442 | `63919863a632ee66` | — |
| `recall-compare.json` | 545 | `2b7b7e8f183203c2` | — |
| `recall-hash.json` | 3,419 | `33f73840449ef4bc` | — |
| `replica-spike.log` | 817 | `e0a2914cf9fb569f` | 2026-08-18T07:32:03 |
| `test-counts.json` | 2,916 | `60b921da57941d0f` | 2026-08-18T00:00:00 |

## 재생성

```bash
# 라우팅·벡터·KG·종단 (DATASET 은 스크립트가 스스로 넘긴다)
npm run companyx:route && npm run companyx:vector && npm run companyx:kg && npm run companyx:ask

# 홀드아웃 2벌
node dist/cli/companyx-holdout-route-eval.js
HOLDOUT=eval/companyx/holdout2_route.json OUT=eval/results/companyx-holdout2-route.json \
  node dist/cli/companyx-holdout-route-eval.js

# BIRD 공식 set 의미 재채점 (재추론 없음)
python scripts/rescore_bird.py

# 복제 스파이크 (primary 를 잠깐 정지시킨다)
bash scripts/replica-spike.sh

# 매니페스트 갱신
node scripts/evidence-manifest.mjs --write
```

문서 수치와 이 결과들의 일치는 `node scripts/metrics-check.mjs` 가 강제하고,
테스트 단언 수는 `node scripts/verify-test-counts.mjs` 가 러너 출력에서 다시 센다.
