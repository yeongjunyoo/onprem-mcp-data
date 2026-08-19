# 변경 이력

> 이 파일은 **GitHub 릴리스 노트에서 생성**됩니다(`node scripts/sync-changelog.mjs --write`).
> 릴리스가 정본이고 이 파일은 파생입니다 — 손으로 고치면 두 곳이 갈립니다.
> 클론한 사람이 GitHub 페이지를 열지 않고도 버전 사이의 변화를 읽을 수 있도록 둡니다.

## v0.2.0 — 주장과 실제를 기계가 대조한다 (2026-08-17)

이번 릴리스의 축은 하나다 — **주장과 실제를 기계가 대조하게 만들었다.**

v0.1.0 이후 113커밋 동안 문서가 주장하지만 아무도 실행해 본 적 없던 경로를 하나씩 밟았고, 그때마다 결함이 나왔다. 고친 뒤에는 같은 형태가 재발하지 않도록 검사를 남겼다.

## 심사자가 밟는 경로에서 깨지던 것

- **`route` 도구가 MCP 클라이언트에서 호출 자체가 거부됐다.** `outputSchema` 가 배열 넷을 `object` 로 선언해 출력 검증에 걸렸다. `demo` 는 파이프라인 함수를 직접 불러 이 검증을 안 거치므로 초록이었다. 열거되는 것과 호출되는 것은 다르다.
- **`MCP_TRANSPORT` 오타가 조용히 stdio 로 떨어졌다.** 주석은 `http` 도 지원한다고 적혀 있었다. 이제 모르는 값은 소리내어 거절하고 즉시 종료한다.
- **`schema://companyx/tables` 가 스모크 프로파일의 카드를 돌려줬다.** 이름이 내용을 보증하지 않았다. URI 를 프로파일 중립으로 바꾸고 본문 첫 줄이 자기 출처를 밝힌다.
- **증거 목록 리소스가 절을 못 찾으면 보고서 서론을 대신 줬다.** 이제 없으면 없다고 말한다.
- **노출 프롬프트가 실행 프롬프트의 요약본이었다.** 언어 고정·그래프 트리플 해석 규칙이 빠져 있었다. 한 곳에서만 나오게 하고 전문 동일성을 검사한다.
- **감사 스키마 문서가 없는 필드를 말하고 실물 5개를 빠뜨렸다.** 양방향 대조를 넣었다.

## 배포 조건

- **평가 산출물이 사업자 문서 본문을 실어 나르고 있었다.** 데이터셋 파일은 이력에 한 번도 없었지만 `fusion[].preview` 가 본문 120자를 158개 담고 있었다. 파일로 남길 때만 가리고 런타임 표시는 유지한다 — 규정을 지키려고 기능을 죽이지 않는다.

## 검증된 주장

전부 실제로 뚫어 보거나 무너뜨려 보고 확인했다.

- **2층 방어** — 1층 문자열 가드를 무력화한 빌드로 DELETE/UPDATE/INSERT 를 보냈다. `orders` 5행 → 5행. PostgreSQL 이 직접 거부했다.
- **보안 문단** — `current_user=mcp_ro`, `statement_timeout=8s`, `lock_timeout=2s`, `pg_read_file`/`pg_ls_dir` 거부.
- **sse 전송** — `initialize → tools/list` 완주, 도구 8종 열거.
- **stdio 전송** — 도구 8종 실호출, 프롬프트 4종 `get`, 리소스 6종 `read`.

## 게이트

주장을 지키는 검사 8종이 CI 와 로컬에서 돈다. 전부 **일부러 깨뜨려 exit 1 을 확인한 뒤** 커밋했다 — 통과만 하는 검사는 아무것도 보장하지 않는다.

```
metrics-check · verify-test-counts · evidence-manifest · verify-no-external-api
verify-tool-surface · verify-doc-metrics · verify-loud-failure
verify-no-dataset-redistribution · sbom
verify-stdio-tools · verify-sse-transport · drill-readonly-defense · verify-security-claims
```

테스트 417단언(오프라인 290 + DB·모델 통합 127).

## v0.1.0 — 3레인 MCP 데이터 플랫폼 (2026-08-17)

사내 데이터베이스에 자연어로 묻고 근거와 함께 답을 받는 온프렘 MCP 서버의 첫 공개 릴리스입니다. 모델은 전부 로컬에서 돌고 외부 API를 호출하지 않습니다.

## 무엇이 들어 있나

- **MCP 도구 8종** — `route` `sql.query` `vector.search` `retrieve` `ask` `audit.explain` `ontology.search` `graph.expand`. 리소스 6종, 프롬프트 4종.
- **결정론 라우터** — 질문을 벡터검색 / NL2SQL / 지식그래프 세 갈래로 분기합니다. LLM 호출과 튜닝 파라미터가 없어 재실행 결과가 같습니다. 관계 질문은 어휘가 아니라 **개체 타입 쌍을 온톨로지 엣지에 대조**해 판정합니다.
- **읽기 전용 가드** — `sql.query`는 NOLOGIN 역할로 강등되어 실행되고, 다중 구문과 쓰기를 거부합니다.
- **근거 밖 생성 금지** — 질문이 지목한 개체를 해소하지 못하면 컨텍스트를 비우고 모른다고 답합니다.
- **감사 레코드** — `audit.explain`이 라우팅 근거, 거부된 SQL과 사유, 융합 합의 소스, 정책 판정, 접지 검사를 한 레코드로 돌려줍니다.

## 실측 (PostgreSQL 16 + pgvector, Ollama qwen2.5-coder:7b / bge-m3)

| 지표 | 값 |
| --- | --- |
| 벡터 검색 hit@5 | 0.986 (73/74) |
| 지식그래프 재현율 | 1.000 |
| 라우팅 (사업자 공개 예시 30문항) | 30/30, 20회 재실행 동일 |
| 라우팅 (홀드아웃 · 템플릿 문형) | 0.900 |
| 라우팅 (홀드아웃 · 구어체) | 0.633 |
| 종단 근거 포함 | 17/19 (5회 중 4회) |
| 접지 위반 | 0건 |
| 테스트 | 388단언 통과 |

구어체 라우팅 0.633을 숨기지 않습니다. 관계 표현은 무한해서 규칙 기반이 어휘로 따라잡을 수 없고, 타입쌍 추론은 그 한계를 늦춘 것이지 없앤 것이 아닙니다. 측정 방법과 남은 실패는 [개발보고서](docs/report.md) §0.14에 있습니다.

## 시작하기

```bash
docker compose up -d
docker compose exec ollama ollama pull qwen2.5-coder:7b
docker compose exec ollama ollama pull bge-m3
cd air-server && npm ci && npx tsc
export OLLAMA_HOST=http://localhost:11435
npm run gen:bench && EMBEDDER=ollama npm run embed:bench
EMBEDDER=ollama npm run demo
```

실행 시작 시 실제로 붙은 Ollama 엔드포인트와 모델 목록을 찍습니다. 필요한 모델이 없으면 무엇을 실행해야 하는지 알려주고 멈춥니다.

## 라이선스

Apache-2.0. 의존 패키지 전부 허용형이며 카피레프트 0건입니다. 전체 목록은 [SBOM](docs/sbom.md).
