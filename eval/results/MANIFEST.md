# 증거 아티팩트 매니페스트

문서가 인용하는 수치는 전부 이 디렉터리의 실행 결과에서 나온다.

**24/36 개가 자기 생성 시각을 들고 있다.** 나머지는 파일 자체에 시각이 없어
`git log` 로만 추적된다 — 옛 평가기가 그 필드를 안 쓰던 시절의 산출물이다.
없는 시각을 지어내지 않고, 어느 것이 자기 시각을 갖고 어느 것이 안 갖는지 그대로 적는다.

커밋 시각 열은 두지 않는다. CI 는 얕은 클론이라 `git log` 가 이력 대신 checkout
시각을 주므로 환경마다 값이 달라진다 — 재현 가능한 값만 남긴다.

해시는 줄바꿈을 정규화한 SHA-256 앞 16자다(git 이 OS 마다 CRLF/LF 를 바꾸므로).

이 파일은 `node scripts/evidence-manifest.mjs --write` 로 생성하고, CI 가 재생성해도
달라지지 않는지 검사한다. **매니페스트 자체가 낡으면 그것이 다음 번 낡은 아티팩트다.**

| 파일 | 크기 | sha256(16) | 자체 생성시각 |
|---|---:|---|---|
| `companyx-ask-host-gpu.json` | 24,183 | `bccfcd80c2551e20` | 2026-08-19T13:16:26 |
| `companyx-ask.json` | 23,984 | `c6e624264ab44a9b` | 2026-08-19T06:34:05 |
| `companyx-audit.json` | 82,149 | `673dbf863f81a2d2` | 2026-08-19T06:55:48 |
| `companyx-holdout-route.json` | 11,104 | `5cafe91be728cd73` | 2026-08-19T06:42:59 |
| `companyx-holdout2-route.json` | 11,103 | `b83e0130e355c823` | 2026-08-19T06:43:01 |
| `companyx-hybrid.json` | 113,071 | `93af25bfe935cc98` | 2026-07-29T14:13:17 |
| `companyx-kg.json` | 6,369 | `9c2cc0c7c049812f` | 2026-08-19T06:48:56 |
| `companyx-language-lock.json` | 973 | `98bfe23d21c9e06d` | 2026-08-19T12:10:13 |
| `companyx-load.json` | 720 | `d77ab0d2521bde6a` | 2026-08-17T12:27:13 |
| `companyx-multi-step.json` | 2,285 | `074ee8ea197187fa` | 2026-08-19T06:42:52 |
| `companyx-route.json` | 23,256 | `d926ae3076ee9264` | 2026-08-19T06:42:57 |
| `companyx-sql-llm-norepair.json` | 4,978 | `43c526bd73a4f407` | 2026-08-19T13:29:31 |
| `companyx-sql-llm.json` | 4,977 | `6ab121ab31fa7853` | 2026-08-19T13:24:26 |
| `companyx-sql-naive-norepair.json` | 5,555 | `0ff089f56aaba54e` | 2026-08-19T13:44:25 |
| `companyx-sql-naive.json` | 4,845 | `eaeeee10a26fb4c3` | 2026-08-19T13:39:41 |
| `companyx-sql-repeat-llm-norepair.json` | 1,418 | `cb2c4feff5470033` | 2026-08-19T13:29:31 |
| `companyx-sql-repeat-llm.json` | 1,417 | `a5755c0b1ea45c54` | 2026-08-19T13:24:26 |
| `companyx-sql-repeat-naive-norepair.json` | 2,152 | `9211a222683464d0` | 2026-08-19T13:44:25 |
| `companyx-sql-repeat-naive.json` | 1,663 | `8cf5455560bcd0f8` | 2026-08-19T13:39:41 |
| `companyx-vector.json` | 170,890 | `057090199c0e3935` | 2026-08-19T06:48:54 |
| `external-bird-raw.json` | 10,755 | `b2d91c82059dcbe8` | — |
| `external-bird-rescore.json` | 114,113 | `1efa946c25e9d378` | 2026-08-19T13:12:42 |
| `external-bird-summary.json` | 1,042 | `724a6971a85a284d` | — |
| `faults.json` | 1,013 | `dad1608540df9d8d` | — |
| `internal-llm-raw.json` | 20,517 | `4e393d5e209919e8` | — |
| `internal-llm-summary.json` | 1,209 | `dd32b14862160937` | — |
| `internal-naive-raw.json` | 22,122 | `a1d525681e3a4107` | — |
| `internal-naive-summary.json` | 1,209 | `8cea648885430cab` | — |
| `internal-template-raw.json` | 15,293 | `b04f711a734547df` | — |
| `internal-template-summary.json` | 1,196 | `be89b8ddedf497a1` | — |
| `model-bakeoff.json` | 2,216 | `1d720a9ff36c4f88` | 2026-08-19T16:04:35 |
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
