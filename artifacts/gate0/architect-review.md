## Summary

Gate0 freeze 계약 기준으로는 **통과**입니다. `artifacts/gate0/npm-test-report.txt`는 `tsc` 이후 8개 테스트 레인이 모두 `0 failed`로 끝난 140개 passing 증거를 담고 있고, README의 eval 문구는 `13/14`를 작은 스모크 하네스로 명시하면서 회사 64.0% 레퍼런스와 직접 비교 불가라고 선을 긋습니다.

현재 코드는 Gate1~8에서 확장해야 할 제출 전체 결함(KG, 대형 benchmark, packaging, license)을 숨기지 않고 README에 별도 한계로 분리해 두었으며, Gate0의 회귀 하니스 baseline으로는 안전합니다. Gate0 artifact 범위에서는 product source patch가 아니라 검증 증거 파일만 확인됐습니다.

## Analysis

### Gate0 계약 항목별 평가

#### 1) air-server 회귀 스위트 140 green 증거 확인 — PASS

- `artifacts/gate0/npm-test-report.txt`는 실행된 테스트 커맨드를 `tsc && node dist/router.test.js && ... && node dist/llm.test.js`로 기록합니다 (`artifacts/gate0/npm-test-report.txt:2-3`). 즉 TypeScript 빌드가 먼저 통과해야 뒤 테스트들이 실행되는 구조입니다.
- 기록된 suite 결과는 모두 `0 failed`입니다:
  - router `9 passed, 0 failed` (`artifacts/gate0/npm-test-report.txt:6`)
  - curator `67 passed, 0 failed` (`artifacts/gate0/npm-test-report.txt:8`)
  - rrf `8 passed, 0 failed` (`artifacts/gate0/npm-test-report.txt:10`)
  - evalmatch `13 passed, 0 failed` (`artifacts/gate0/npm-test-report.txt:12`)
  - db `19 passed, 0 failed` (`artifacts/gate0/npm-test-report.txt:14`)
  - server `5 passed, 0 failed` (`artifacts/gate0/npm-test-report.txt:20`)
  - pipeline `14 passed, 0 failed` (`artifacts/gate0/npm-test-report.txt:22`)
  - llm `5 passed, 0 failed` (`artifacts/gate0/npm-test-report.txt:24`)
- 합계는 `9 + 67 + 8 + 13 + 19 + 5 + 14 + 5 = 140`입니다. LLM lane도 skip이 아니라 실제 `5 passed`이며 structured/semantic answer sample이 기록되어 있습니다 (`artifacts/gate0/npm-test-report.txt:24-26`).
- `air-server/package.json`의 `test` script도 동일한 8개 suite를 빌드 뒤 순차 실행하도록 정의되어 있어 artifact와 package contract가 일치합니다 (`air-server/package.json:9-10`).

**판정:** regression/code lane은 Gate0 기준 CLEAR입니다.

#### 2) eval 라벨 정직성 — PASS

- README의 검증 현황은 `SQL execution-match eval`을 **스모크 하네스 13/14**로 부르고, “자작 LLM-저지 없이 DB를 오라클로 객관 채점”한다고 설명합니다. 같은 문장에서 “시드 스키마가 작아(orders 5행·14문항) 일반화 벤치마크가 아니며, 회사의 64.0% 레퍼런스와 직접 비교 불가”라고 명시합니다 (`README.md:40`). 이 문구는 과장 headline이 아니라 제한 조건을 함께 둔 라벨입니다.
- README는 테스트 총량도 `140 passing`으로 표기하고, live PG/LLM 테스트는 환경 없으면 graceful skip이라고 분리합니다 (`README.md:39`). Gate0 artifact에서는 LLM test가 실제 pass로 기록되어 README보다 약한 증거가 아닙니다 (`artifacts/gate0/npm-test-report.txt:24-26`).
- eval 구현도 README 문구와 일치합니다. `eval.ts`는 predicted SQL과 gold SQL의 result set을 비교하고 “No LLM judge anywhere — the database is the oracle”라고 주석화합니다 (`air-server/src/eval.ts:4-5`). 회사 `64.0%`는 `REFERENCE = 0.64`로 contextual reference만 보관됩니다 (`air-server/src/eval.ts:20`). 출력도 “SMOKE harness over a tiny seed schema (5 orders rows, 14 questions)” 및 “NOT comparable to the brief's 64.0% reference”를 직접 출력하도록 되어 있습니다 (`air-server/src/eval.ts:49-57`).
- 실제 eval dataset은 14 JSONL rows입니다 (`eval/sql_eval.jsonl:1-14`). seed schema도 orders 5행과 documents 3행으로 작습니다 (`sql/init/01_schema.sql:21-30`). 따라서 README의 “orders 5행·14문항” 제한 문구는 코드/데이터와 정합합니다.

**판정:** product/eval-label lane은 Gate0 기준 CLEAR입니다. `13/14` 자체를 제출-grade benchmark처럼 포장하지 않고, 작은 smoke harness와 직접 비교 불가성을 명시했으므로 정직성 계약을 충족합니다.

#### 3) Gate1~8 증분을 위한 안전한 회귀 하니스 baseline 여부 — PASS

현 코드는 제출 전체 완성본은 아니지만, Gate0 freeze baseline으로는 적절합니다. 이유는 다음과 같습니다.

- **MCP tool boundary가 작고 명확합니다.** `server.ts`는 `route`, `sql.query`, `vector.search`, `retrieve`, `ask` 5개 tool을 air `defineTool`로 등록합니다 (`air-server/src/server.ts:31`, `:42`, `:53`, `:68`, `:90`). 모든 data/retrieval tool에 read-only/idempotent annotation이 있고, answer tool도 `openWorldHint: false`를 둡니다 (`air-server/src/server.ts:36`, `:47`, `:61`, `:77`, `:98`).
- **운영 안정성 hook이 baseline에 포함되어 있습니다.** server factory는 timeout/retry/circuitBreaker plugin을 전역 적용합니다 (`air-server/src/server.ts:7-9`, `:28`). Gate7에서 black-box fault evidence를 추가해야 하지만, Gate0 regression harness에는 plugin wiring과 callTool smoke가 이미 있습니다.
- **pipeline은 증분 확장 가능한 spine입니다.** `retrieve`는 기본 `llmNL2SQL`, route decision, vector branch, `Promise.allSettled` branch isolation, RRF merge, curator를 분리합니다 (`air-server/src/pipeline.ts:67`, `:71`, `:84`, `:87`, `:120-121`). audit에는 candidate counts, `branch_errors`, curation audit가 포함됩니다 (`air-server/src/pipeline.ts:137-139`). Gate2~5에서 graph/canonical candidate contract를 추가할 때 이 branch/fusion boundary를 확장하면 되며, 전체 architecture rewrite가 필요한 구조는 아닙니다.
- **SQL safety baseline이 테스트 가능한 형태입니다.** `sql.ts`는 single SELECT/WITH guard, statement chaining 거부, READ ONLY transaction, optional `mcp_ro` role downgrade, statement/lock timeout, max row cap을 둡니다 (`air-server/src/sql.ts:35-59`, `:67-80`). `db.test.ts`는 write block, no mutation, superuser file read block, vector determinism을 단언합니다 (`air-server/src/db.test.ts:36-42`, `:55-58`).
- **determinism/structure regression이 이미 테스트됩니다.** router determinism은 20 runs identical로 테스트됩니다 (`air-server/src/router.test.ts:32-37`). curator는 row를 깨지 않음, budget 준수, determinism, naive truncation contrast를 테스트합니다 (`air-server/src/curator.test.ts:20-38`). RRF도 agreement bonus, contiguous ranks, deterministic tie-break를 테스트합니다 (`air-server/src/rrf.test.ts:1`, `:23-26`). pipeline test는 structured/semantic/hybrid path, SQL+document fusion, broken rows 0, identical run determinism을 확인합니다 (`air-server/src/pipeline.test.ts:18-21`, `:26-29`, `:34-45`, `:50`).
- **server integration lane이 실제 tool registry를 검증합니다.** `server.test.ts`는 registered tools가 정확히 `["ask", "retrieve", "route", "sql.query", "vector.search"]`인지 검사하고, `callTool`을 통해 route/sql/vector path와 write blocking을 확인합니다 (`air-server/src/server.test.ts:19-23`, `artifacts/gate0/npm-test-report.txt:20`).

Gate1~8의 작업은 baseline 위에 증분 가능합니다. README도 현재 한계를 과장 없이 분리합니다: benchmark 확장, ontology/KG 미구현, Docker/full demo packaging, license artifacts가 제출 전 작업으로 명시되어 있습니다 (`README.md:44-52`). 이 항목들은 **submission/gold-floor 계약의 backlog**이지 Gate0 freeze 계약의 BLOCK 사유가 아닙니다.

**판정:** architecture lane은 Gate0 기준 CLEAR입니다. Gate2의 canonical KG/RRF candidate refactor, Gate5의 benchmark expansion, Gate6의 packaging은 필요하지만, 현 spine을 폐기하거나 큰 재작성부터 해야 하는 상태는 아닙니다.

#### 4) Gate0 범위에서 새로 도입된 코드 변경 여부 — PASS with provenance caveat

- Gate0 artifact inventory는 `artifacts/gate0/npm-test-report.txt`와 `artifacts/gate0/cli-replay.json` 두 개로 확인됐습니다. 이 둘은 검증 증거이며 product source file이 아닙니다.
- `cli-replay.json`은 `replaySafe: true`이고, 명령도 `node -e console.log("gate0-baseline-140-green")` 및 stdout 기록만 담습니다 (`artifacts/gate0/cli-replay.json:2-10`). 제품 코드 경로(`air-server/src`)를 수정하는 내용은 없습니다.
- 이 workspace에는 `~/projects/onprem-mcp-data/.git`이 없어 VCS diff로 “source diff 0”을 독립 증명할 수는 없었습니다. 따라서 절대적 변경 없음은 git evidence로 주장하지 않습니다. 다만 Gate0 artifact 범위와 검토된 evidence 기준으로는 source patch나 new Gate0 code path가 관찰되지 않았습니다.

**판정:** code-change lane은 Gate0 기준 CLEAR입니다. 단, 이후 gate freeze artifact에는 `git diff --stat --exit-code` 또는 source manifest hash를 함께 남기면 provenance가 더 강해집니다.

## Root Cause

Gate0 범위에서 결함의 root cause는 발견되지 않았습니다. 이전 architect BLOCK/REQUEST CHANGES는 “출품작 전체 / gold-floor submission” 계약의 미충족(KG 미구현, benchmark toy risk, packaging/license/fault evidence 부족)에 대한 평가였고, 현재 README는 그 한계를 Gate1~8 backlog로 정직하게 분리합니다 (`README.md:44-52`).

## Findings

### Gate0-blocking findings

없음.

### Non-blocking evidence watch — LOW

- **Reference:** `.git` directory가 project root에서 확인되지 않아 VCS diff 기반의 “Gate0 source change 없음” 증거는 만들 수 없었습니다. Gate0 artifacts 자체는 `npm-test-report.txt`와 `cli-replay.json`뿐이고, `cli-replay.json`은 replay-safe stdout 기록입니다 (`artifacts/gate0/cli-replay.json:2-10`).
- **Impact:** 현재 Gate0 통과 여부를 막지는 않습니다. 다만 이후 baseline freeze 감사에서는 “검증 전용 story였는가”를 더 강하게 입증하려면 source tree hash 또는 git diff artifact가 필요합니다.
- **Fix suggestion:** Gate1부터 각 gate artifact에 `git diff --stat --exit-code` 결과 또는 tracked source manifest hash를 포함합니다. product source를 바꾸는 gate라면 변경 파일 목록과 테스트 근거를 함께 묶습니다.

## Three-lane Gate0 Status

| Lane | Status | Evidence-backed rationale |
|---|---|---|
| Architecture | CLEAR | 5-tool air boundary, `Promise.allSettled` branch isolation, RRF/curator separation, SQL guard/role/timeouts가 이미 source와 tests에 존재합니다 (`server.ts:31-98`, `pipeline.ts:67-139`, `sql.ts:35-80`). Gate1~8은 증분 확장으로 진행 가능합니다. |
| Product / eval label | CLEAR | README는 `13/14`를 tiny smoke harness로 표기하고 회사 64.0%와 직접 비교 불가라고 명시합니다 (`README.md:40`). eval code도 DB oracle/no LLM judge와 NOT comparable 출력이 있습니다 (`eval.ts:4-5`, `:49-57`). |
| Code / regression | CLEAR | Gate0 artifact는 8 suites 합계 140 passing/0 failed를 기록합니다 (`npm-test-report.txt:6-24`). Gate0 artifact 범위에서는 검증 증거 외 product-source patch가 관찰되지 않았습니다 (`cli-replay.json:2-10`). |

## Recommendations

1. **Gate0 freeze를 승인합니다.** 현 artifact는 140 green baseline과 정직한 eval label을 충족합니다.
2. **Gate1~8은 현재 140-test suite를 회귀 하니스로 고정하고 진행합니다.** 특히 router/RRF/curator/pipeline determinism 및 SQL privilege tests는 이후 KG/benchmark/packaging 증분의 guardrail로 유지해야 합니다.
3. **README의 한계 문구를 유지합니다.** KG 미구현, large held-out benchmark 부재, packaging/license 미완료는 Gate0 blocker가 아니라 후속 gate acceptance로 닫아야 합니다 (`README.md:48-52`).
4. **다음 gate부터 diff provenance를 artifact화합니다.** 이번 Gate0에는 source-change artifact가 관찰되지 않았지만, `.git` 부재로 diff-level proof가 제한됐습니다. 이후에는 source manifest or git diff stat을 남기는 것이 좋습니다.

## Architectural Status

`CLEAR`

## Code Review Recommendation

`APPROVE`

## Trade-offs

| Option | Pros | Cons | Gate0 decision |
|---|---|---|---|
| 현 baseline freeze | 140-test passing evidence를 안정 회귀점으로 고정. Gate1~8 증분 중 regression 감지 가능. | 제출 전체 결함(KG/benchmark/demo/license)은 그대로 남음. | 채택. Gate0 계약에 맞음. |
| Gate0에서 architecture rewrite | 장기적으로 canonical KG/RRF를 한 번에 반영 가능. | 검증 전용 story 범위 위반. 140 green baseline을 흔들고 regression 원인을 섞음. | 거부. Gate1~8에서 증분 처리. |
| Gate0를 submission 전체 기준으로 BLOCK | KG 미구현 등 실제 제출 리스크를 강하게 경고 가능. | 사용자 계약과 충돌. README가 이미 한계를 명시했고 Gate1~8 소관임. | 거부. Gate0만 평가하면 CLEAR. |
| VCS diff 없음을 BLOCK 처리 | provenance 엄격성 최대화. | 현재 workspace에 `.git`이 없어 입증 방식이 불가능하며, artifact/source 검토상 product patch는 관찰되지 않음. | BLOCK 아님. LOW watch로만 기록. |