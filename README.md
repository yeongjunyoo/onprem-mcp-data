# on-prem-mcp-data (working name)

2026 오픈소스 개발자대회 리원에이스 지정과제 출품작 (제출 2026-08-27).

**한 줄:** PostgreSQL + pgvector를 MCP 도구로 노출하고, 규칙기반 병렬 라우터(MCP Parallel)와 구조보존 컨텍스트 큐레이션(TACC)으로 온프렘 소형 LLM(7B)이 비싼 컨텍스트 없이 정확히 답하게 하는 데이터 플랫폼 에이전트. 전부 air(Apache-2.0) 위에서, 외부 API 없이.

> 프레임: "리원에이스 자기 스펙(air·MCP Parallel·TACC·Qwen)의 **충실한 레퍼런스 구현 + 운영 안정성**". 알고리즘 신규성 주장 아님.

## 구조 (레이어 + air 토대)

- **L1 substrate** — PostgreSQL 17 + pgvector. 스모크 시드 `sql/init/01_schema.sql`(public) + 콘테스트급 벤치 `eval/internal/schema.sql`(격리 `bench` 스키마, e-commerce 8테이블·수천 행).
- **L2 DB MCP 도구** — `sql.query`(읽기전용 트랜잭션 + 최소권한 `mcp_ro` 강등 → superuser 함수·쓰기 거부, statement/lock timeout), `vector.search`(pgvector 코사인, BGE-M3 임베딩, 2차키 id로 tie 결정성, k 클램프).
- **L3 차별점 A — 규칙기반 병렬 라우터 `route`(MCP Parallel)** — 한국어 질의 분류(**LLM 호출 X = 결정론, 튜닝파라미터 0, run-to-run 분산 0**) → structured/semantic/hybrid 병렬 fan-out + 감사 로그.
- **L4 차별점 B — 구조보존 큐레이션 `retrieve`(TACC)** — 7B 컨텍스트 진입 전 스키마인지 row 원자 패킹. **해자 = SQL 튜플을 안 깨고 트림**(토큰압축기 실패모드 회피). thesis = 고정 예산 **구조 무결성(broken_rows=0)**.
- **L5 온톨로지/지식그래프** — `entities/aliases/relations/entity_links`. `ontology.search`(별칭 해소: 전자제품→전자기기), `graph.expand`(타입 관계 BFS + provenance). canonical `entity_links` 브릿지로 SQL/vector/graph 후보를 동일 엔티티로 매핑 → **named-source RRF 3-way agreement**.
- **L7 답변 `ask`** — 온프렘 Qwen2.5-7B(Ollama)가 큐레이션 컨텍스트에만 근거해 답변(추측 금지).
- **토대: air** (`@airmcp-dev/core`, Apache-2.0) — `defineServer`/`defineTool` + **7 MCP 도구**(route/sql.query/vector.search/retrieve/ask/ontology.search/graph.expand) + 플러그인 `timeout`/`retry`/`circuitBreaker` + Pylon-7 `layer` 힌트.

## 빠른 시작 (오프라인)

```bash
docker compose up -d              # PG17+pgvector(:5433) + Ollama(:11434)
docker compose exec -T ollama ollama pull qwen2.5:7b   # 답변용 (Apache-2.0)
docker compose exec -T ollama ollama pull bge-m3       # 임베딩용 (MIT)

cd air-server && npm ci && npm run build
npm run gen:bench                         # 결정론 벤치 데이터(seed=42, orders 2000)
EMBEDDER=ollama npm run embed:bench       # bench 문서 BGE-M3 임베딩

npm test            # 스모크 단위+통합 148 (라이브 PG; LLM/모델 없으면 graceful skip)
npm run test:kg     # 그래프/온톨로지 + canonical 3-way 19 (bench+BGE-M3)
npm run bench:internal   # 내부 SQL execution-match 벤치 (자작 LLM-저지 없음)
npm run recall:eval      # 의미검색 BGE-M3 vs hash recall@k/MRR head-to-head
npm run fault:inject     # 장애주입 → graceful degradation 스위트
EMBEDDER=ollama npm run demo   # 오프라인 end-to-end 데모 (7툴→3-way→7B→fault)
docker build -t onprem-mcp-data-mcp ./air-server   # MCP 서버 이미지 (검증됨)
```

> `docker compose --profile full`은 mcp 서버까지 컨테이너로(Dockerfile 빌드 검증됨). stdio→HTTP transport는 후속.

## 검증 현황 (2026-06-30, 전부 실행 결과)

- **빌드:** TypeScript strict, clean. **air 7 MCP 도구** 등록 확인.
- **테스트:** 스모크 151(router 9/curator 67/rrf 13/evalmatch 21/db 22/server 5/pipeline 14) + KG 19(graph 12/kgretrieve 7) + llm 5 = **175**, 단계별 그린. 라이브 PG/모델 없으면 graceful skip.
- **내부 SQL execution-match 벤치:** **83/100 = 83.0%** (`eval/results/internal-llm-summary.json`, raw 추적가능). 4~8테이블·수천행 e-commerce, 100문항·16종 taxonomy, **자작 LLM-저지 없이 DB가 오라클**, 순서/별칭/튜플/수치 strict. ⚠️ **회사 64.0%는 다른 데이터셋의 contextual reference — same-benchmark beat 아님.**
- **외부 calibration(BIRD Mini-Dev SQLite, 객관성 anchor):** 동일 on-prem Qwen2.5-7B를 공개 벤치 cross-domain DDL+oracle evidence로 실행, **execution accuracy 7/32 = 21.9%**(stride 샘플 of 500; simple 50%·moderate 21%·challenging 0%, 샘플 moderate/challenging 편중). ⚠️ **다른·더 어려운 데이터셋·샘플 — 내부 83.0%와 비교 불가**(참고: 풀 BIRD GPT-4 ≈46%, 7B급 ≈20~35%). `EXT_LIMIT=32 npm run external:bird`.
- **Ablation matrix(동일 100문항·컴포넌트별 기여):** template-only **1/100(1.0%)** → naive LLM(bare 테이블) **30/100(30.0%)** → 큐레이션 스키마카드 **83/100(83.0%)**. 결정 레버 = 구조보존 큐레이션(naive→curated **Δ +53.0pp**). 동일 bench·DB오라클·LLM저지 없음. `BENCH_STRATEGY={template|naive} npm run bench:internal`.
- **의미검색 정량(BGE-M3 vs hash):** 저-어휘겹침 16질의(암호↔비밀번호 등)에서 hash recall@5=0.50/MRR=0.30 → **BGE recall@5=1.00/MRR=0.91**(Δ recall@5 +50pp·top1 +69pp·MRR +0.60, plan 임계 전부 통과). **canonical 3-way RRF**: `entity:policy#1001`이 vector+graph 합의 → rank 1. `npm run recall:eval`.
- **운영 안정성(장애주입):** `eval/results/faults.json` — no-crash 4/4, partial-context 4/4(≥80%), error-visible 4/4. 스위트가 실제 크래시 버그(entity_links) 적발·수정. `sql.query` mcp_ro 강등으로 `pg_read_file`·쓰기 거부.
- **클러스터(검증):** 무상태 air 서버 → 수평확장 구조. read-only 도구는 `getReadPool()` 경유(`READ_DATABASE_URL` 설정→읽기 오프로드, 미설정→Primary 폴백, `db.test`). **검증된 라이브 streaming-replica spike**(`scripts/replica-spike.sh`, 로그 `eval/results/replica-spike.log`): pg_basebackup hot-standby → 실제 streaming replication, replica read-only 강제, `getReadPool` replica 라우팅, **kill-drill: primary 정지 중 replica가 reads 제공**. 토폴로지 `docs/architecture.md`. ⚠️ 자동 promotion/failover·lag SLA = production HA(범위 외).
- **결정론(범위 한정):** route/RRF/curator/벡터정렬은 분산 0(테스트 단언). **NL2SQL·답변은 7B라 결정론 아님**(temp0/seed 재현성).

## 남은 작업 (정직, 출품 08-27 전)

> 9 워크스트림 핵심은 빌드+검증 완료. 아래는 acceptance 완성을 위한 잔여(개발보고서 §8).

- **벤치 확장:** 내부 29→100문항, **외부 BIRD Mini-Dev/Spider calibration**(객관성 anchor, headline 별도 열), baseline matrix(qwen-direct/router+TACC/template) 실행.
- **의미검색 정량:** hash vs BGE-M3 recall@5/MRR/top1 임계 비교.
- **클러스터:** HA/replica 다이어그램 + (안정 시) read-replica 1일 spike.
- **시연영상:** 3분 네트워크off 녹화(`docs/demo-script.md` 스크립트 준비됨).

## 레퍼런스 / 인용 (전부 KOSSA 과제 페이지 1차출처 확인)

- 전현우·김태성·강현(2026), zenodo 18842478 — 컨텍스트 한계효용은 모델 의존적, **Qwen 풀컨텍스트 이득(p<0.001)** → L4 설계 + Qwen2.5-7B 선택 근거.
- Pylon-7(Jeon 2026, zenodo 18808598) — 7계층 워크플로(도구 `layer` 힌트로 반영).
- MCP 스펙(modelcontextprotocol.io), pgvector, Ollama, Lewis 2020(RAG), Liu 2024(Lost in the Middle), Hou 2025(MCP 보안).

## 검증된 Python 레퍼런스

`prototype/`의 `router.py`(6/6) + `curator.py`(head-to-head)는 로직을 먼저 검증한 레퍼런스. TS 포트(`air-server/src/`)가 이를 충실히 이식 + 확장.

## 라이선스

코드 = **Apache-2.0** (`LICENSE`). 의존성·모델 라이선스 = `NOTICE` (air Apache-2.0 / pg MIT / Qwen2.5-7B Apache-2.0 / BGE-M3 MIT / PostgreSQL·pgvector PostgreSQL License). 모델카드 = `docs/model-cards/`. 임베더 = BGE-M3(데모/평가 기본) 또는 오프라인 결정론 hash(CI fallback). 개발보고서 = `docs/report.md`.
