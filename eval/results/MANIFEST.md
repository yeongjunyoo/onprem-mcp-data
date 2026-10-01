# 증거 아티팩트 매니페스트

문서가 인용하는 수치는 전부 이 디렉터리의 실행 결과에서 나온다.

**35/47 개가 자기 생성 시각을 들고 있다.** 나머지는 파일 자체에 시각이 없어
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
| `companyx-holdout-route.json` | 12,996 | `610a167871885494` | 2026-09-30T08:20:24 |
| `companyx-holdout2-route.json` | 13,496 | `830701be1afb9f25` | 2026-09-30T08:22:23 |
| `companyx-holdout3-route-sealed.json` | 25,801 | `983281d8daae9064` | 2026-09-30T08:11:14 |
| `companyx-holdout3-route.json` | 28,226 | `3eef7bb632a4911f` | 2026-09-30T08:47:21 |
| `companyx-holdout4-route.json` | 28,134 | `d44d053b6d4d4164` | 2026-09-30T08:48:12 |
| `companyx-hybrid.json` | 113,071 | `93af25bfe935cc98` | 2026-07-29T14:13:17 |
| `companyx-kg.json` | 6,369 | `9c2cc0c7c049812f` | 2026-08-19T06:48:56 |
| `companyx-language-lock.json` | 973 | `98bfe23d21c9e06d` | 2026-08-19T12:10:13 |
| `companyx-load.json` | 720 | `d77ab0d2521bde6a` | 2026-08-17T12:27:13 |
| `companyx-multi-step.json` | 2,285 | `074ee8ea197187fa` | 2026-08-19T06:42:52 |
| `companyx-route-boundary.json` | 50,244 | `e8af51147ca055c0` | 2026-09-30T08:18:40 |
| `companyx-route.json` | 23,256 | `d926ae3076ee9264` | 2026-08-19T06:42:57 |
| `companyx-scorecard-answerfix-gpu-base-holdout3.json` | 49,270 | `7757312a77029f79` | 2026-09-30T15:12:38 |
| `companyx-scorecard-answerfix-gpu-base-sponsor30.json` | 25,647 | `c70c74f5216a2706` | 2026-09-30T15:05:34 |
| `companyx-scorecard-answerfix-gpu-fixed-holdout3.json` | 51,869 | `56acadaa02b676a4` | 2026-10-01T02:22:52 |
| `companyx-scorecard-answerfix-gpu-fixed-sponsor30.json` | 28,722 | `22652516d0caf013` | 2026-09-30T15:37:48 |
| `companyx-scorecard.json` | 22,051 | `344c86be246c2e37` | 2026-09-30T08:38:08 |
| `companyx-sql-answerfix-gpu-card-base.json` | 12,953 | `294014ff00e41cba` | 2026-10-01T02:15:29 |
| `companyx-sql-answerfix-gpu-card-new.json` | 13,010 | `4d998a01b01bacdb` | 2026-10-01T02:16:28 |
| `companyx-sql-llm-norepair.json` | 4,978 | `43c526bd73a4f407` | 2026-08-19T13:29:31 |
| `companyx-sql-llm.json` | 4,977 | `6ab121ab31fa7853` | 2026-08-19T13:24:26 |
| `companyx-sql-naive-norepair.json` | 5,555 | `0ff089f56aaba54e` | 2026-08-19T13:44:25 |
| `companyx-sql-naive.json` | 4,845 | `eaeeee10a26fb4c3` | 2026-08-19T13:39:41 |
| `companyx-sql-repeat-llm-norepair.json` | 1,418 | `cb2c4feff5470033` | 2026-08-19T13:29:31 |
| `companyx-sql-repeat-llm.json` | 1,417 | `a5755c0b1ea45c54` | 2026-08-19T13:24:26 |
| `companyx-sql-repeat-naive-norepair.json` | 2,152 | `9211a222683464d0` | 2026-08-19T13:44:25 |
| `companyx-sql-repeat-naive.json` | 1,663 | `8cf5455560bcd0f8` | 2026-08-19T13:39:41 |
| `companyx-vector.json` | 170,890 | `057090199c0e3935` | 2026-08-19T06:48:54 |
| `external-bird-raw.json` | 173,506 | `adfb5244c4d6462e` | — |
| `external-bird-rescore.json` | 114,560 | `c2c41a9500285fdf` | 2026-09-30T13:36:23 |
| `external-bird-summary.json` | 1,040 | `a1b5e5ddc3eb8774` | — |
| `faults.json` | 1,013 | `dad1608540df9d8d` | — |
| `internal-llm-raw.json` | 20,498 | `b1b1eb9f259cff9b` | — |
| `internal-llm-summary.json` | 1,209 | `9c46ab04d31f7879` | — |
| `internal-naive-raw.json` | 22,119 | `8daeb8c0ce078a51` | — |
| `internal-naive-summary.json` | 1,209 | `ee7562e234163c90` | — |
| `internal-template-raw.json` | 15,293 | `b04f711a734547df` | — |
| `internal-template-summary.json` | 1,196 | `d14336ced9e3a19d` | — |
| `model-bakeoff.json` | 2,216 | `1d720a9ff36c4f88` | 2026-08-19T16:04:35 |
| `recall-bge.json` | 3,442 | `63919863a632ee66` | — |
| `recall-compare.json` | 545 | `2b7b7e8f183203c2` | — |
| `recall-hash.json` | 3,419 | `33f73840449ef4bc` | — |
| `replica-spike.log` | 817 | `e0a2914cf9fb569f` | 2026-08-18T07:32:03 |
| `test-counts.json` | 3,532 | `aeb923a11fddfd8b` | 2026-09-30T00:00:00 |

## 재생성

```bash
# 라우팅·벡터·KG·종단 (DATASET 은 스크립트가 스스로 넘긴다)
npm run companyx:route && npm run companyx:vector && npm run companyx:kg && npm run companyx:ask

# 기능테스트 스코어카드 (최종 답 일치, 레인별 지연)
npm run companyx:score

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
