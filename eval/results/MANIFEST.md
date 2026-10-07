# 증거 아티팩트 매니페스트

문서가 인용하는 수치는 전부 이 디렉터리의 실행 결과에서 나온다.

**61/73 개가 자기 생성 시각을 들고 있다.** 나머지는 파일 자체에 시각이 없어
`git log` 로만 추적된다 — 옛 평가기가 그 필드를 안 쓰던 시절의 산출물이다.
없는 시각을 지어내지 않고, 어느 것이 자기 시각을 갖고 어느 것이 안 갖는지 그대로 적는다.

커밋 시각 열은 두지 않는다. CI 는 얕은 클론이라 `git log` 가 이력 대신 checkout
시각을 주므로 환경마다 값이 달라진다 — 재현 가능한 값만 남긴다.

해시는 줄바꿈을 정규화한 SHA-256 앞 16자다(git 이 OS 마다 CRLF/LF 를 바꾸므로).

이 파일은 `node scripts/evidence-manifest.mjs --write` 로 생성하고, CI 가 재생성해도
달라지지 않는지 검사한다. **매니페스트 자체가 낡으면 그것이 다음 번 낡은 아티팩트다.**

| 파일 | 크기 | sha256(16) | 자체 생성시각 |
|---|---:|---|---|
| `companyx-ask-host-gpu.json` | 28,174 | `fc6e69c1183594a5` | 2026-10-01T05:00:10 |
| `companyx-ask.json` | 28,415 | `35ffb464897bf740` | 2026-10-01T17:25:47 |
| `companyx-audit.json` | 80,374 | `7886754623b0598f` | 2026-10-01T17:18:46 |
| `companyx-holdout-route.json` | 12,996 | `af42f06c98cf6151` | 2026-10-01T17:08:44 |
| `companyx-holdout2-route.json` | 13,496 | `56da66723060e44b` | 2026-10-01T17:09:19 |
| `companyx-holdout3-route-sealed.json` | 25,801 | `983281d8daae9064` | 2026-09-30T08:11:14 |
| `companyx-holdout3-route.json` | 28,226 | `3eef7bb632a4911f` | 2026-09-30T08:47:21 |
| `companyx-holdout4-route.json` | 28,134 | `d44d053b6d4d4164` | 2026-09-30T08:48:12 |
| `companyx-hybrid.json` | 113,071 | `93af25bfe935cc98` | 2026-07-29T14:13:17 |
| `companyx-kg.json` | 7,420 | `a377ef577052314c` | 2026-10-01T17:03:16 |
| `companyx-language-lock.json` | 973 | `98bfe23d21c9e06d` | 2026-08-19T12:10:13 |
| `companyx-load.json` | 720 | `d77ab0d2521bde6a` | 2026-08-17T12:27:13 |
| `companyx-multi-step.json` | 2,285 | `db02b43d82dc25c7` | 2026-10-01T17:09:19 |
| `companyx-route-boundary.json` | 50,244 | `e8af51147ca055c0` | 2026-09-30T08:18:40 |
| `companyx-route.json` | 29,703 | `524998512fb424c3` | 2026-10-01T17:02:41 |
| `companyx-scorecard-answerfix-gpu-base-holdout3.json` | 49,270 | `7757312a77029f79` | 2026-09-30T15:12:38 |
| `companyx-scorecard-answerfix-gpu-base-sponsor30.json` | 25,647 | `c70c74f5216a2706` | 2026-09-30T15:05:34 |
| `companyx-scorecard-answerfix-gpu-fixed-holdout3.json` | 51,869 | `56acadaa02b676a4` | 2026-10-01T02:22:52 |
| `companyx-scorecard-answerfix-gpu-fixed-sponsor30.json` | 28,722 | `22652516d0caf013` | 2026-09-30T15:37:48 |
| `companyx-scorecard-answerfix2-gpu-base-holdout3.json` | 51,464 | `2f3c874bd308a0a4` | 2026-10-01T04:53:57 |
| `companyx-scorecard-answerfix2-gpu-base-sponsor30.json` | 28,323 | `afd221871c38eea0` | 2026-10-01T04:53:07 |
| `companyx-scorecard-answerfix2-gpu-fixed-holdout3.json` | 51,480 | `f2249c7e90b007b8` | 2026-10-01T04:59:02 |
| `companyx-scorecard-answerfix2-gpu-fixed-sponsor30.json` | 28,266 | `c29c617582b3ea49` | 2026-10-01T04:58:15 |
| `companyx-scorecard-answerfix2-gpu-ticketlines-holdout3.json` | 51,777 | `fea2e3a9bb2c8d89` | 2026-10-01T04:55:23 |
| `companyx-scorecard-answerfix2-gpu-ticketlines-sponsor30.json` | 29,138 | `6c01ecc9f603e189` | 2026-10-01T04:54:36 |
| `companyx-scorecard-b1024.json` | 25,785 | `512184a682efefad` | 2026-09-30T13:40:32 |
| `companyx-scorecard-b256.json` | 24,565 | `0b51a9d400e33e9c` | 2026-09-30T13:34:36 |
| `companyx-scorecard-b512.json` | 25,828 | `00aac95b7e2e4884` | 2026-09-30T13:37:25 |
| `companyx-scorecard-holdout3-b1024.json` | 49,460 | `efa2c93f907a23e6` | 2026-09-30T13:42:20 |
| `companyx-scorecard-holdout3-b256.json` | 49,964 | `84b861bf92b7db17` | 2026-09-30T13:36:21 |
| `companyx-scorecard-holdout3-b512.json` | 49,519 | `d891b338c5aa5533` | 2026-09-30T13:39:19 |
| `companyx-scorecard-holdout4.json` | 54,866 | `724ceae0cb880082` | 2026-10-01T18:31:40 |
| `companyx-scorecard.json` | 28,669 | `9283689ac3a7b391` | 2026-10-01T17:32:57 |
| `companyx-sql-answerfix-gpu-card-base.json` | 12,953 | `294014ff00e41cba` | 2026-10-01T02:15:29 |
| `companyx-sql-answerfix-gpu-card-new.json` | 13,010 | `4d998a01b01bacdb` | 2026-10-01T02:16:28 |
| `companyx-sql-answerfix2-gpu-card-base.json` | 12,991 | `e14eafcb8fe9dfd4` | 2026-10-01T04:52:11 |
| `companyx-sql-answerfix2-gpu-card-fixed.json` | 12,963 | `fc4393c861ce337f` | 2026-10-01T04:56:59 |
| `companyx-sql-answerfix2-gpu-card-ticketlines.json` | 13,234 | `80b33954be768fa0` | 2026-10-01T04:52:32 |
| `companyx-sql-answerfix2-gpu-card-v1-rule.json` | 12,738 | `823e064c235b62ed` | 2026-10-01T04:57:21 |
| `companyx-sql-answerfix2-gpu-card-v2-rule-noexample.json` | 12,807 | `9c7cab633a971aeb` | 2026-10-01T04:57:44 |
| `companyx-sql-llm-compact-holdout3.json` | 13,394 | `b7e0ffb532d287e2` | 2026-09-30T12:57:56 |
| `companyx-sql-llm-compact-holdout4.json` | 12,469 | `66e32cca681d27db` | 2026-09-30T13:00:04 |
| `companyx-sql-llm-emptyrepair-holdout3.json` | 12,908 | `c2c9d212885b1f0c` | 2026-09-30T13:06:03 |
| `companyx-sql-llm-gemma4_e4b-holdout3.json` | 11,658 | `1bc67ef305206a3f` | 2026-09-30T13:11:25 |
| `companyx-sql-llm-holdout4.json` | 11,583 | `f9855aada58647b9` | 2026-09-30T12:59:25 |
| `companyx-sql-llm-norepair.json` | 5,050 | `eb8b0a74c4f73835` | 2026-10-01T08:02:07 |
| `companyx-sql-llm-qwen3.5_9b-holdout3.json` | 12,940 | `4387070500ffed75` | 2026-09-30T13:08:58 |
| `companyx-sql-llm.json` | 5,047 | `4a9f6b3ac3a56eff` | 2026-10-01T07:52:21 |
| `companyx-sql-naive-norepair.json` | 5,668 | `e5fcd8b4bb1b66d6` | 2026-10-01T18:48:50 |
| `companyx-sql-naive.json` | 5,206 | `02300d89a305f8f5` | 2026-10-01T18:44:02 |
| `companyx-sql-repeat-llm-norepair.json` | 1,296 | `5b3c233c1bdafd03` | 2026-10-01T08:02:07 |
| `companyx-sql-repeat-llm.json` | 1,295 | `de9123e0ba53c507` | 2026-10-01T07:52:21 |
| `companyx-sql-repeat-naive-norepair.json` | 2,152 | `4faa8a810b2fb490` | 2026-10-01T18:48:50 |
| `companyx-sql-repeat-naive.json` | 1,663 | `a431bd2f65fb5324` | 2026-10-01T18:44:02 |
| `companyx-toolselect-holdout4.json` | 26,316 | `bca6a7e1d83aef45` | 2026-09-30T13:14:08 |
| `companyx-toolselect.json` | 54,850 | `919867ee84bdfb85` | 2026-09-30T13:13:31 |
| `companyx-vector.json` | 170,890 | `c2ccb8012dd8e74f` | 2026-10-01T17:08:12 |
| `external-bird-raw.json` | 173,506 | `adfb5244c4d6462e` | — |
| `external-bird-rescore.json` | 114,560 | `c2c41a9500285fdf` | 2026-09-30T13:36:23 |
| `external-bird-summary.json` | 1,040 | `a1b5e5ddc3eb8774` | — |
| `faults.json` | 1,013 | `a7a54fc82261911b` | — |
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
| `test-counts.json` | 3,509 | `fe882bac3b173419` | 2026-09-30T00:00:00 |

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
