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
| `companyx-ask.json` | 23,984 | `c6e624264ab44a9b` | 2026-08-19T06:34:05 |
| `companyx-audit.json` | 82,149 | `673dbf863f81a2d2` | 2026-08-19T06:55:48 |
| `companyx-holdout-route.json` | 11,104 | `5cafe91be728cd73` | 2026-08-19T06:42:59 |
| `companyx-holdout2-route.json` | 11,103 | `b83e0130e355c823` | 2026-08-19T06:43:01 |
| `companyx-hybrid.json` | 113,071 | `93af25bfe935cc98` | 2026-07-29T14:13:17 |
| `companyx-kg.json` | 6,369 | `9c2cc0c7c049812f` | 2026-08-19T06:48:56 |
| `companyx-load.json` | 720 | `d77ab0d2521bde6a` | 2026-08-17T12:27:13 |
| `companyx-multi-step.json` | 2,285 | `074ee8ea197187fa` | 2026-08-19T06:42:52 |
| `companyx-route.json` | 23,256 | `d926ae3076ee9264` | 2026-08-19T06:42:57 |
| `companyx-sql-llm-norepair.json` | 4,981 | `3518ceb4eaa9c5e3` | 2026-08-19T06:23:20 |
| `companyx-sql-llm.json` | 4,984 | `0726086d523da282` | 2026-08-19T06:21:37 |
| `companyx-sql-naive-norepair.json` | 5,555 | `e09767da281c9517` | 2026-08-19T08:09:30 |
| `companyx-sql-naive.json` | 4,845 | `3258f8af27fcf00f` | 2026-08-19T08:05:09 |
| `companyx-sql-repeat-llm-norepair.json` | 1,456 | `6ab414c9d7b6b4f0` | 2026-07-29T12:48:18 |
| `companyx-sql-repeat-llm.json` | 1,211 | `76d7d6a2377c348c` | 2026-07-29T12:49:17 |
| `companyx-sql-repeat-naive-norepair.json` | 1,322 | `e9b99c8da8c81c82` | 2026-07-29T12:49:47 |
| `companyx-sql-repeat-naive.json` | 921 | `0b36b54e90223b19` | 2026-07-29T12:50:21 |
| `companyx-vector.json` | 170,890 | `057090199c0e3935` | 2026-08-19T06:48:54 |
| `external-bird-raw.json` | 9,821 | `9797f594286c9bf2` | — |
| `external-bird-rescore.json` | 8,683 | `a8eee43a530ec2d9` | 2026-08-18T09:39:21 |
| `external-bird-summary.json` | 681 | `23809a688a2d07e6` | — |
| `faults.json` | 1,013 | `dad1608540df9d8d` | — |
| `internal-llm-raw.json` | 20,517 | `4e393d5e209919e8` | — |
| `internal-llm-summary.json` | 1,209 | `dd32b14862160937` | — |
| `internal-naive-raw.json` | 22,122 | `a1d525681e3a4107` | — |
| `internal-naive-summary.json` | 1,209 | `8cea648885430cab` | — |
| `internal-template-raw.json` | 15,293 | `b04f711a734547df` | — |
| `internal-template-summary.json` | 1,210 | `0ebd78f2095219ac` | — |
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
