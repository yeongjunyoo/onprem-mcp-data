# 증거 아티팩트 매니페스트

문서가 인용하는 수치는 전부 이 디렉터리의 실행 결과에서 나온다.

**22/34 개가 자기 생성 시각을 들고 있다.** 나머지는 파일 자체에 시각이 없어
마지막 커밋 시각으로만 추적된다 — 옛 평가기가 그 필드를 안 쓰던 시절의 산출물이다.
없는 시각을 지어내지 않고, 어느 것이 자기 시각을 갖고 어느 것이 안 갖는지 그대로 적는다.

해시는 줄바꿈을 정규화한 SHA-256 앞 16자다(git 이 OS 마다 CRLF/LF 를 바꾸므로).

이 파일은 `node scripts/evidence-manifest.mjs --write` 로 생성하고, CI 가 재생성해도
달라지지 않는지 검사한다. **매니페스트 자체가 낡으면 그것이 다음 번 낡은 아티팩트다.**

| 파일 | 크기 | sha256(16) | 자체 생성시각 | 마지막 커밋 |
|---|---:|---|---|---|
| `companyx-ask-host-gpu.json` | 21,907 | `d97d536ece6307d9` | 2026-08-17T08:14:06 | 2026-08-17T09:15:53 |
| `companyx-ask.json` | 22,535 | `6b573ad944946f2b` | 2026-08-17T12:39:39 | 2026-08-17T12:40:53 |
| `companyx-audit.json` | 98,544 | `b2f0d563776486cc` | 2026-07-29T14:39:23 | 2026-07-29T14:43:01 |
| `companyx-holdout-route.json` | 11,104 | `8f702f06b98c38d5` | 2026-08-17T09:32:04 | 2026-08-17T09:32:24 |
| `companyx-holdout2-route.json` | 11,103 | `88d8905dd92a4463` | 2026-08-17T09:32:04 | 2026-08-17T09:32:24 |
| `companyx-hybrid.json` | 113,071 | `93af25bfe935cc98` | 2026-07-29T14:13:17 | 2026-07-29T14:17:18 |
| `companyx-kg.json` | 6,369 | `24051290517eb8e6` | 2026-08-17T01:38:57 | 2026-08-17T01:41:51 |
| `companyx-load.json` | 720 | `d77ab0d2521bde6a` | 2026-08-17T12:27:13 | 2026-08-17T12:40:53 |
| `companyx-multi-step.json` | 2,132 | `319a96696d0dd072` | 2026-07-29T15:13:52 | 2026-07-29T15:19:43 |
| `companyx-route.json` | 23,256 | `df5baace783aa922` | 2026-08-17T14:52:16 | 2026-08-17T14:53:42 |
| `companyx-sql-llm-norepair.json` | 4,972 | `cfd9d08c70a15248` | 2026-07-29T12:48:18 | 2026-07-29T12:52:54 |
| `companyx-sql-llm.json` | 4,871 | `1692988d8ac28c44` | 2026-07-29T12:49:17 | 2026-07-29T12:52:54 |
| `companyx-sql-naive-norepair.json` | 5,340 | `141152e4ade6bb89` | 2026-07-29T12:49:47 | 2026-07-29T12:52:54 |
| `companyx-sql-naive.json` | 4,817 | `4b9baa585766485f` | 2026-07-29T12:50:21 | 2026-07-29T12:52:54 |
| `companyx-sql-repeat-llm-norepair.json` | 1,456 | `6ab414c9d7b6b4f0` | 2026-07-29T12:48:18 | 2026-07-29T12:52:54 |
| `companyx-sql-repeat-llm.json` | 1,211 | `76d7d6a2377c348c` | 2026-07-29T12:49:17 | 2026-07-29T12:52:54 |
| `companyx-sql-repeat-naive-norepair.json` | 1,322 | `e9b99c8da8c81c82` | 2026-07-29T12:49:47 | 2026-07-29T12:52:54 |
| `companyx-sql-repeat-naive.json` | 921 | `0b36b54e90223b19` | 2026-07-29T12:50:21 | 2026-07-29T12:52:54 |
| `companyx-vector.json` | 170,890 | `604f20c1d8cd115e` | 2026-08-17T12:33:19 | 2026-08-17T12:40:53 |
| `external-bird-raw.json` | 9,878 | `cfe1dc452172c024` | — | 2026-07-07T08:11:19 |
| `external-bird-rescore.json` | 8,863 | `bb10a5d137f00ebe` | 2026-08-17T06:13:28 | 2026-08-17T06:13:50 |
| `external-bird-summary.json` | 680 | `8f4c2b484a0f59f3` | — | 2026-07-07T08:11:19 |
| `faults.json` | 1,012 | `9f739ede99b69a6c` | — | 2026-07-07T08:11:19 |
| `internal-llm-raw.json` | 20,437 | `828515eba18fe4ce` | — | 2026-07-07T08:11:19 |
| `internal-llm-summary.json` | 1,202 | `c5ad866aa36baddd` | — | 2026-07-07T08:11:19 |
| `internal-naive-raw.json` | 22,474 | `27211e52b68ea5f0` | — | 2026-07-07T08:11:19 |
| `internal-naive-summary.json` | 1,203 | `313a1a17bb752b3f` | — | 2026-07-07T08:11:19 |
| `internal-template-raw.json` | 15,293 | `b04f711a734547df` | — | 2026-07-07T08:11:19 |
| `internal-template-summary.json` | 1,204 | `2b6c46d67d3766de` | — | 2026-07-07T08:11:19 |
| `recall-bge.json` | 3,442 | `63919863a632ee66` | — | 2026-07-07T08:11:19 |
| `recall-compare.json` | 545 | `fe6b533844c9b0a2` | — | 2026-07-07T08:11:19 |
| `recall-hash.json` | 3,419 | `33f73840449ef4bc` | — | 2026-07-07T08:11:19 |
| `replica-spike.log` | 593 | `1249589cd8a28839` | 2026-08-17T15:11:32 | 2026-08-17T15:12:42 |
| `test-counts.json` | 1,533 | `987d354146a08767` | 2026-08-17T14:10:00 | 2026-08-17T14:08:45 |

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
