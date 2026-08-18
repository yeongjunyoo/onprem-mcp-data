# 기여 안내 (Contributing)

이 저장소는 온프렘 환경에서 도는 MCP 데이터 플랫폼입니다. 외부 API를 호출하지 않는 것이 설계 제약이자 검증 대상이므로, 기여도 그 제약 안에서 이루어집니다.


> **질문은 이슈가 아니라 [Discussions](https://github.com/yeongjunyoo/onprem-mcp-data/discussions)로 주세요.** 이 저장소는 빈 이슈를 막아 두었고, 이슈 템플릿은 버그 신고와 기능 제안 두 가지입니다. 사용 방법·설계 의도·재현 실패처럼 답을 찾는 질문은 Discussions 가 맞는 자리입니다.
> 처음 기여한다면 [good first issue](https://github.com/yeongjunyoo/onprem-mcp-data/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22) 부터 보세요.

## 내 데이터에 붙이기

이 저장소는 코퍼스 세 개(`smoke` / `bench` / `companyx`)를 한 PostgreSQL 안에 두고
`DATASET` 으로 고릅니다. **네 번째를 붙이는 데 필요한 것은 프로파일 항목 하나입니다.**

```ts
// air-server/src/profile.ts
mydata: {
  name: "mydata",
  kgSchema: "bench",              // 그래프 레인을 안 쓰면 기존 스키마를 가리켜 둡니다
  vectorTable: "mydata.documents",// id/title/body/embedding 을 가진 테이블
  nl2sql: llmNL2SQL,              // 스키마 카드를 읽는 범용 전략
  schemaCard: `CREATE TABLE mydata.tickets (...);`,  // 모델이 보는 유일한 스키마 설명
  description: "사내 티켓 코퍼스(mydata 스키마)",
},
```

`DatasetName` 유니온과 `profile()` 의 허용 목록에 이름을 더하면 끝입니다.

**2026-08-18 에 실제로 해 봤습니다.** `mydata` 스키마에 티켓 3행·문서 2행을 넣고 위
항목을 추가한 뒤 `DATASET=mydata` 로 돌리니 SQL 레인이 `{"status":"open","n":2}` 를
돌려주고, 프로파일이 지정한 벡터 테이블이 조회되고, 스키마 카드가 도구 설명에 실리고,
`node scripts/verify-stdio-tools.mjs` 가 **도구 8종 전부 통과**했습니다. 확인 뒤
프로파일과 스키마는 되돌렸습니다 — 저장소는 세 코퍼스로 출하합니다.

**아직 안 해 본 것은 이렇습니다.** 위 실측은 SQL 레인과 도구 표면까지입니다.
의미검색을 쓰려면 `documents.embedding` 을 채워야 하고(`npm run embed:bench:ollama`
가 하는 일), 그래프 레인을 쓰려면 `<스키마>.entities / aliases / relations` 를 채워야
합니다(`npm run companyx:load` 가 하는 일). 그 두 적재를 여러분의 데이터로 돌려 본
적이 없으므로 **명령만 가리키고 절차를 지어내지 않습니다.**

`llmNL2SQL` 은 스키마 카드 텍스트만 보고 SQL 을 만듭니다. `companyx`/`bench` 처럼
전용 전략을 쓰지 않아도 되고, 카드가 곧 모델이 아는 전부입니다 — 컬럼 의미가
애매하면 카드에 주석을 답니다.

## 먼저 알아야 할 세 가지

1. **외부 API 호출을 추가하지 마세요.** 생성 모델과 임베딩 모델은 전부 로컬 Ollama에서 구동합니다. 상용 API를 호출하는 코드 경로가 들어오면 이 프로젝트의 핵심 주장이 무너집니다.
2. **수치를 바꾸는 변경에는 재실행 결과를 첨부하세요.** 이 저장소의 모든 성능 수치는 `eval/results/`에 원자료로 남아 있고, 채점자는 자체 제작한 LLM 심판이 아니라 데이터베이스 실행 결과와 정답 집합입니다. 수치를 인용하거나 갱신하려면 같은 커맨드를 다시 돌리고 그 JSON을 함께 커밋해 주세요.
3. **조건 없는 성능 주장은 받지 않습니다.** "더 빠르다", "더 정확하다"는 하드웨어, 양자화, 표본 수, 프롬프트, 비교 대상이 함께 적혀야 검토할 수 있습니다.

## 개발 환경

| 구성요소 | 버전 | 비고 |
| --- | --- | --- |
| Node.js | 20 LTS 이상 | TypeScript 5.9로 빌드 |
| PostgreSQL | 16 이상 | pgvector 0.8.6 확장 필요(compose 가 함께 띄운다) |
| Ollama | 0.32 이상 | `qwen2.5:7b`(생성), `bge-m3`(임베딩) |

```bash
git clone https://github.com/yeongjunyoo/onprem-mcp-data.git && cd onprem-mcp-data
bash scripts/pg-up.sh                 # PostgreSQL 16 + pgvector 기동
cd air-server && npm ci && npx tsc     # 의존성 설치와 빌드
```

## 테스트 계층 — 무엇이 어디서 도는가

이 프로젝트의 테스트는 **필요한 외부 자원에 따라 세 층으로 나뉩니다.** CI는 첫 번째 층만 돌립니다. 나머지를 CI에서 도는 것처럼 표시하지 않는 것도 이 프로젝트의 정직 원칙입니다.

| 층 | 명령 | 필요한 것 | CI |
| --- | --- | --- | --- |
| 오프라인 단위 | `npm test` — `claims`, `normalize`, `auditrecord`, `surfaces`, `router`, `curator`, `rrf`, `evalmatch`, `errors`, `degraded` | 없음 | 돕니다 (335 단언. 사업자 데이터셋이 없는 CI 와 갓 클론한 저장소에서는 324 — 온톨로지 커버리지 단언 11건이 `edges.json` 을 필요로 합니다) |
| DB 통합 | `npm run test:integration` — `db`, `server`, `pipeline`, `llm`, `graph`, `kgretrieve`, `auditcache`, `companyx`, `ontologyload` | PostgreSQL + pgvector, 시드 적재 | 안 돕니다 (127 단언) |
| 모델 평가 | `npm run companyx:route`, `companyx:sql`, `companyx:kg`, `companyx:vector`, `companyx:ask`, `npm run bench:internal`, `fault:inject` | 위 + Ollama 모델 2종 | 안 돕니다 |

**갓 클론한 저장소에서 아무 설정 없이 돌아갑니다.** `git clone` → `cd air-server && npm ci` → `npm test` 로 324단언이 통과합니다(2026-08-18 실측). Docker 도 모델도 필요 없습니다 — 데이터베이스가 필요한 계층은 `npm run test:integration` 으로 분리돼 있고, 각 스위트는 자기 데이터셋 프로파일에 고정돼 있어 셸에 남은 `DATASET` 값이 결과를 바꾸지 않습니다.

전 스위트 기준 462단언이 통과 상태입니다(오프라인 335 + DB·모델 통합 127). 이 숫자는 손으로 적는 값이 아니라 러너 출력에서 집계하며, `node scripts/verify-test-counts.mjs` 가 정본 `eval/results/test-counts.json` 과 대조해 어긋나면 실패합니다. 각 평가의 원자료는 `eval/results/`에, 실행 커맨드와 해석은 `docs/report.md`에 있습니다.

## 변경 절차

1. **이슈를 먼저 여세요.** 버그는 재현 절차와 실제/기대 동작을, 기능은 해결하려는 문제를 적습니다. 템플릿이 준비되어 있습니다.
2. 브랜치를 파고 작업합니다. 커밋 메시지는 `feat:`, `fix:`, `docs:`, `test:`, `chore:` 접두어를 씁니다. 한국어 본문을 권장합니다.
3. PR을 엽니다. **PR 본문에 무엇을 왜 바꿨는지와 어떤 테스트를 돌렸는지**를 적습니다. 1인 저장소이므로 병합 전 셀프리뷰 코멘트를 남깁니다.
4. 수치나 동작이 바뀌면 `docs/report.md`와 `eval/results/`를 같은 PR에서 갱신합니다.
5. 의존성을 추가하면 `node scripts/sbom.mjs > docs/sbom.md`로 SBOM을 재생성합니다. CI가 드리프트를 검사합니다.

## 라이선스와 의존성 규칙

- 직접 작성한 코드는 **Apache License 2.0**입니다. 기여하면 같은 라이선스로 배포되는 데 동의하는 것으로 봅니다.
- **카피레프트(GPL·AGPL·LGPL) 의존성을 추가하지 마세요.** 현재 npm 의존성 110개는 전부 허용형(MIT·ISC·BSD·Apache-2.0)이며 충돌이 0건입니다. 이 상태가 라이선스 검증의 전제입니다.
- AI 모델을 추가하거나 교체하려면 **최소 오픈웨이트 이상**이어야 하고, 모델 카드와 라이선스를 `docs/model-cards/`와 `docs/ai-model-spec.md`에 함께 기록해야 합니다.

## 처음 기여한다면

`good first issue` 라벨이 붙은 이슈는 범위가 닫혀 있고 외부 자원이 덜 필요한 작업입니다. 문서 오탈자, 오프라인 단위 테스트 추가, 에러 메시지 개선처럼 데이터베이스 없이도 검증되는 것부터 시작할 수 있습니다.

## 보안 문제

취약점은 공개 이슈로 올리지 말고 `SECURITY.md`의 절차를 따라 주세요.
