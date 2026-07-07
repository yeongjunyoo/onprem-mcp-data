# 개발보고서 — onprem-mcp-data

**2026 오픈소스 개발자대회 · 리원에이스 지정과제 「MCP 기반 지능형 데이터 플랫폼 클러스터」**

> 전 과정 온프렘·오프라인(외부 API 0). 모든 수치는 실제 실행 결과이며, 정확도 채점에 **자작 LLM-저지를 쓰지 않는다**(DB/gold가 오라클).
> _본 문서는 OT(07-23) 배점 공개 전 초안이다. 배점 확정 시 헤드라인 가중치를 재정렬한다._

---

## 0. 요약 (심사자용 30초)

리원에이스 미션: *"복잡한 설정은 그만. 규격화된 최신 기술로 **장애 지점을 줄인**, **튜닝 없는** 똑똑한 AI 검색 비서."*

본 구현은 그 명제를 **측정 가능한 형태로 실증**한다 — 그리고 단순화가 품질을 깎지 않음을 벤치마크로 증명한다.

| 리원에이스가 원하는 것 | 본 구현의 증거 (실행 결과) |
|---|---|
| **튜닝 없음 (설정 민감성↓)** | 라우터·RRF·큐레이션·벡터정렬 = **LLM 호출 0, 튜닝 파라미터 0, run-to-run 분산 0** (테스트 단언) |
| **장애 지점↓ (운영 안정성)** | 장애주입 스위트 **no-crash 4/4·partial 4/4·error-visible 4/4**; air 플러그인(timeout/retry/circuit); 클러스터 read-endpoint fallback + **라이브 streaming-replica kill-drill** |
| **품질 유지 (단순해도 정확)** | 내부 SQL execution-match **83/100=83.0%**; 구조보존 큐레이션이 정확도의 결정 레버임을 ablation으로 실증(**Δ +53.0pp**) |
| **MCP·air 규격 준수** | air `defineServer/defineTool` 위 **7 MCP 도구**; Pylon-7 layer 힌트; 전현우 2026 TACC 논문을 설계 근거로 구현 |

핵심 한 줄: **"튜닝 0·장애 지점 최소화로 운영을 단순화하되, 구조보존 큐레이션으로 품질(83%)을 지킨 온프렘 MCP 데이터 플랫폼."**

---

## 1. 미션 적합성 — 개발과제 예시 100% 충족

| 리원에이스 요구 (과제 예시) | 구현 | 증거 |
|---|---|---|
| PostgreSQL + pgvector 벡터 DB | L1 PG17+pgvector, `bench` 격리 스키마 | `eval/internal/schema.sql` |
| MCP 프로토콜 기반 AI 도구 설계·구현 | air 위 7 MCP 도구 | `air-server/src/server.ts` |
| 규칙 기반 라우터 (MCP Parallel) | `route` 결정론 라우터 + 병렬 fan-out | `air-server/src/router.ts` |
| 온프렘 소형 LLM(7B) 연동 (Ollama) | `ask` = Qwen2.5-7B, 근거 없으면 거부 | `air-server/src/llm.ts` |
| 선택적 컨텍스트 큐레이션 (TACC) | L4 구조보존 큐레이션(`broken_rows=0`) | `air-server/src/curator.ts` |
| (심화) 온톨로지 기반 지식 그래프 | `ontology.search`/`graph.expand` + canonical 3-way RRF | `air-server/src/{graph,kgretrieve}.ts` |

과제가 요구한 5개 예시 + 심화(온톨로지/KG)까지 전부 구현·검증.

---

## 2. 왜 이 설계가 "복잡도↓·장애 지점↓"인가 (리원에이스 핵심 가치)

**(1) 튜닝 0 — 설정 민감성 제거.** 라우팅은 규칙 기반(LLM 호출 0). RRF 융합·구조보존 큐레이션·벡터 tie 정렬은 전부 결정론. 테스트가 run-to-run **분산 0**을 단언한다. → 리원에이스 논지("튜닝 파라미터 9→2")를 코드로 실증. (NL2SQL·최종답변만 7B라 비결정론이며, 이는 명시적으로 표기.)

**(2) 장애 지점↓ — 다층 방어.**
- **air 플러그인**: timeout / retry / circuitBreaker를 전역 적용(운영 기능을 직접 짜지 않음 = 코드 복잡도·버그 표면↓).
- **병렬 fan-out**은 `Promise.allSettled` + `branch_errors` 감사 → 한 브랜치가 죽어도 크래시 없이 부분 컨텍스트 반환.
- **장애주입 스위트**로 실측(§4).

**(3) air 관용적 활용 + 학술 근거.** `defineServer`/`defineTool` + 플러그인 + Pylon-7 `layer` 힌트(인용→구현). 컨텍스트 구성은 전현우 외 2026(TACC) — "무조건 많이가 아니라 모델·과업에 맞게 선별" — 을 L4 설계 근거로 삼음.

---

## 3. 아키텍처 (레이어)

- **L1 substrate** — PostgreSQL 17 + pgvector. 스모크 시드(public)와 콘테스트급 벤치(`bench` 8테이블) 분리.
- **L2 데이터 도구** — `sql.query`(읽기전용 트랜잭션 + 최소권한 `mcp_ro` 강등 → `pg_read_file` 등 superuser 함수·쓰기 거부, statement/lock timeout), `vector.search`(pgvector 코사인, BGE-M3, id 2차정렬로 tie 결정성, k 클램프).
- **L3 결정론 라우터(MCP Parallel)** — 규칙 기반 한국어 질의 분류(LLM 0, 튜닝 0, 분산 0) → structured/semantic/hybrid 병렬 fan-out + 감사 로그.
- **L4 구조보존 큐레이션(TACC)** — 스키마인지 row 원자 패킹(`broken_rows=0`). 해자 = 고정예산에서 **SQL 튜플을 안 깨고** 트림(naive 토큰컷의 실패모드 회피).
- **L5 온톨로지/지식그래프** — `entities/aliases/relations/entity_links`. `ontology.search`(별칭 해소: 전자제품→전자기기), `graph.expand`(타입 관계 BFS + provenance).
- **L7 답변** — 온프렘 Qwen2.5-7B(Ollama). 큐레이션 컨텍스트에만 근거, 근거 없으면 거부.
- **융합** — canonical `entity_links` 브릿지로 SQL/vector/graph 후보를 동일 정규 엔티티로 매핑 → **named-source RRF**(3-way agreement).

토폴로지 다이어그램: `docs/architecture.md`.

---

## 4. 운영 안정성 (헤드라인 — 실행 결과)

- **결정론(범위 한정):** route/RRF/curator/벡터정렬 = 분산 0(테스트 단언). NL2SQL·답변은 7B라 비결정론(명시).
- **장애주입 스위트:** `eval/results/faults.json` — 4 시나리오(vector fail / graph fail / sql fail / vector unavailable)에서 **no-crash 4/4, partial-context 4/4(≥80%), error-visible 4/4**. `branch_errors` 로깅 100%. 스위트가 실제 크래시 버그(kgRetrieve `entity_links` 조회)를 적발→수정.
- **권한 경계:** `sql.query`는 `mcp_ro` 강등 → `pg_read_file` 등 superuser 함수·쓰기·문장 체이닝 거부(`db.test`).
- **클러스터:** 무상태 air 서버 → 수평 확장 구조. 6개 read-only 도구는 `getReadPool()` 경유 — `READ_DATABASE_URL` 설정 시 읽기 오프로드, 미설정 시 Primary 투명 폴백(`db.test` 22/22).
- **검증된 라이브 read-replica spike** (`scripts/replica-spike.sh`, 로그 `eval/results/replica-spike.log`): `pg_basebackup` hot-standby → 실제 **streaming replication**(`state=streaming`), write→replica 3초 반영, replica **read-only 강제**, `getReadPool()` replica 라우팅, **kill-drill: primary 정지 중에도 replica가 reads 제공**(orders=2000)→primary 재기동 정상. **단정 안 함**: 자동 promotion/failover·lag SLA·멀티노드 부하 = production HA 범위(미수행).

---

## 5. 검색 품질 (단순화가 품질을 희생하지 않음)

- **내부 SQL execution-match: 83/100 = 83.0%** (`eval/results/internal-llm-summary.json`, raw 추적가능). 100문항·16종 taxonomy. 오답 17 = 값 영문화(의류→clothing, 서울→seoul)·환각 필터·여분 컬럼·복합 join으로, strict 비교기가 정확히 적발(거짓 통과 없음).
- **Ablation matrix — 컴포넌트별 기여(동일 100문항·`mcp_ro` 오라클·LLM저지 없음):**
  - template-only(결정론, 모델 없음, 단일테이블 하드코딩) = **1/100 = 1.0%** — 하드와이어 템플릿은 실 다중테이블로 일반화 불가.
  - naive LLM(bare 테이블명) = **30/100 = 30.0%** — 환각 컬럼·오류 enum 다발.
  - curated LLM(구조보존 스키마카드) = **83/100 = 83.0%**.
  - **결정 레버 = 구조보존 큐레이션: naive→curated Δ +53.0pp.** thesis 실증. 재현 `BENCH_STRATEGY={template|naive} npm run bench:internal`.
- **의미검색 정량(BGE-M3 vs hash, 동일 랭킹경로·gold 오라클):** 저-어휘겹침 16질의(암호↔비밀번호 등). hash recall@5=0.500/MRR=0.304 → **BGE recall@5=1.000/MRR=0.906** (Δ recall@5 +50.0pp·top1 +68.8pp·MRR +0.602). `npm run recall:eval`.
- **canonical 3-way RRF:** "전자제품 환불 규정" → `entity:policy#1001`이 vector+graph 양쪽에서 나와 2 source 누적·rank 1 (`kgretrieve.test`).
- **외부 calibration(객관성 anchor):** BIRD Mini-Dev(SQLite) — 동일 on-prem Qwen2.5-7B를 공개 벤치 cross-domain DDL+oracle evidence로 실행, BIRD-style execution accuracy **7/32 = 21.9%**(stride 샘플; simple 3/6·moderate 4/19·challenging 0/7, 샘플 moderate/challenging 편중). **⚠️ 다른·더 어려운 데이터셋·샘플 → 내부 83.0%와 직접 비교 불가, 별도 열.** 참고: 풀 BIRD-dev GPT-4 ≈46%·7B급 ≈20~35% → 동일 7B가 공개 벤치에 난이도 비례로 일반화됨을 객관 입증. `EXT_LIMIT=32 npm run external:bird`.
- **테스트:** 스모크 156(router/curator/rrf/evalmatch/db 22/server/pipeline/llm) + KG 19(graph/kgretrieve) = **175** 그린. tsc strict clean.

---

## 6. 벤치마크 프로토콜 (객관·비순환)

- **내부 brief-aligned suite:** `bench` e-commerce 8테이블·수천행(결정론 seed=42), gold NL→SQL 전 taxonomy. 예측 SQL = Qwen NL2SQL, 예측/골드 모두 `mcp_ro`로 실행 후 **strict execution-match**(순서/별칭/컬럼/수치 메타데이터). **DB가 오라클, 자작 LLM-저지 없음.**
- **외부 calibration:** BIRD Mini-Dev(SQLite) execution accuracy(결과셋 multiset), 헤드라인 별도 열.
- **KOSSA 64.0%는 다른 데이터셋의 contextual reference**이며 same-benchmark beat 주장이 아니다(내부 go/no-go 없음).

---

## 7. 인용 (필수 참조 매핑)

- **전현우·김태성·강현 2026** (zenodo 18842478): 컨텍스트 한계효용의 모델 의존성(Qwen 풀컨텍스트 이득 p<0.001) → L4 구조보존 큐레이션·모델 선택 근거.
- **Pylon-7** (Jeon 2026, zenodo 18808598): 7계층 워크플로 참조모델 → 도구 `layer` 힌트(인용→구현).
- **MCP Specification** (Anthropic 2024, modelcontextprotocol.io); **air** (Apache-2.0, airmcp.dev) — 7 도구·플러그인.
- 권장 참조: pgvector, Ollama, RAG(Lewis 2020), Lost-in-the-Middle(Liu 2024), MCP landscape(Hou 2025).

---

## 8. 재현 (오프라인)

```bash
docker compose up -d                                   # PG17+pgvector + Ollama
docker compose exec -T ollama ollama pull qwen2.5:7b   # 답변용 (Apache-2.0)
docker compose exec -T ollama ollama pull bge-m3       # 임베딩용 (MIT)
cd air-server && npm ci && npm run build
npm run gen:bench && EMBEDDER=ollama npm run embed:bench # bench 데이터+임베딩
npm test              # 스모크 156
npm run test:kg       # 그래프/3-way 19
npm run bench:internal                    # 내부 벤치 execution-match (83/100)
BENCH_STRATEGY=naive npm run bench:internal   # ablation naive
EXT_LIMIT=32 npm run external:bird         # 외부 BIRD calibration
npm run recall:eval   # 의미검색 BGE vs hash recall@k/MRR
npm run fault:inject  # 장애주입 스위트
EMBEDDER=ollama npm run demo   # 오프라인 end-to-end 데모
bash scripts/replica-spike.sh  # 라이브 streaming-replica + kill-drill
docker build -t onprem-mcp-data-mcp ./air-server   # 이미지 빌드(검증됨)
```

---

## 9. Evidence manifest (모든 수치 = raw + 커맨드로 추적)

- 내부 벤치: `eval/internal/questions.jsonl`(100Q), `eval/internal/schema.sql`, `air-server/src/cli/gen-bench.ts`(seed=42), `eval/results/internal-{llm,naive,template}-{raw,summary}.json`(ablation matrix).
- 의미검색: `eval/internal/retrieval.jsonl`(저-어휘겹침 gold), `eval/results/recall-{hash,bge,compare}.json`.
- 외부 calibration: `air-server/src/cli/external-eval.ts`, `eval/results/external-bird-{raw,summary}.json`. 데이터셋 `eval/external/`(gitignore, 원본 BIRD).
- 장애: `eval/results/faults.json`. 클러스터: `scripts/replica-spike.sh` + `eval/results/replica-spike.log`.
- 데모: `air-server/src/cli/demo.ts` 실행 로그. 토폴로지: `docs/architecture.md`.
- 라이선스/모델: `LICENSE`(Apache-2.0), `NOTICE`, `docs/model-cards/{qwen2.5-7b,bge-m3}.md`.
- 하드웨어: Apple M4 / macOS 25.5.

---

## 10. 정직 경계 & 다운스트림

- **정직 경계(NEVER COMPROMISE):** 자동 promotion/failover·lag SLA·멀티노드 부하시험 로그가 없으므로 "production HA / 자동 failover"를 단정하지 않는다. 라이브 replica는 검증된 spike(kill-drill 로그)까지가 주장 범위.
- **빌드 완료:** 9개 워크스트림(Gate0~8) 전부 빌드+검증(내부 100Q, ablation, 외부 BIRD, 의미검색, 3-way, fault, 클러스터, 패키징, 라이선스/보고서).
- **다운스트림(제출 절차):** 3분 시연영상 녹화(스크립트 `docs/demo-script.md`) + 포털 제출(08-27). 선택: 풀 BIRD 500 전수(~7h).
- **배점 재정렬:** OT(07-23) 배점 공개 후 본 보고서 헤드라인 가중치를 채점 기준에 맞춰 조정한다.
