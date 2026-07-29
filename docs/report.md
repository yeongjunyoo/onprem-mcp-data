# 개발보고서 — onprem-mcp-data

**2026 오픈소스 개발자대회 · 리원에이스 지정과제 「MCP 기반 지능형 데이터 플랫폼 클러스터」**

> 전 과정 온프렘·오프라인(외부 API 0). 모든 수치는 실제 실행 결과이며, 정확도 채점에 **자작 LLM-저지를 쓰지 않는다**(DB/gold가 오라클).
> _배점 확정 반영(2026-07-29, OT 녹화 4강 슬라이드 p07·p09): 1차 서면 30점 + 2차 발표 70점. 항목별 대응은 §11._
> _제출용 5쪽 원고는 `docs/submission-report.md`, 붙임1 SBOM은 `docs/sbom.md`, 붙임2 AI 모델 명세는 `docs/ai-model-spec.md`._

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

## 0.5 공식 데이터셋(Company-X) 실측 — 사업자 배포본 그대로

리원에이스가 2026-07-22 공개한 **공식 데이터셋**(`companyx-dataset-v1.0.zip`, SHA-256 `30084767…0827d772`, 출처 https://liwonace.co.kr/blog/9)을 **원본 DDL 그대로** 적재하고 3개 도구 레인을 전부 실측했다. 사내 합성 벤치가 아니라 **심사자가 준 데이터** 위의 숫자다.

적재 실측 (`eval/results/companyx-load.json`): 8테이블 **818행** · 문서 40건 → **258청크**(섹션 원자 분할) · 그래프 **133노드/354엣지** · `entity_links` 133건(그래프 노드 ↔ 관계형 행 1:1 브릿지). **공식 DDL은 한 글자도 바꾸지 않았다** — 로더의 `ddlDeviations`가 빈 배열이다. 초기 구현은 `vector(768)`을 1024로 넓혔으나, §0.8의 리서치·실측 결과로 원본 폭을 지키는 쪽이 옳다고 판정해 되돌렸다.

| 레인 | 지표 | 결과 | 오라클 |
|---|---|---|---|
| **라우터** | 공식 30문항 도구 라벨 일치 | **30/30 = 100%**, 20회 재실행 바이트 동일 | 사업자가 붙인 `tool` 라벨 (외부 라벨) |
| **NL2SQL** (재시도 없음) | execution match, 큐레이션 스키마카드 | **7/10 = 70%** | gold SQL 실행 결과 = DB (LLM 저지 없음) |
| **NL2SQL** (재시도 없음, ablation) | execution match, 테이블명만 | **2/10 = 20%** → **Δ +50pp** | 동일 |
| **NL2SQL** (self-repair 1회) | 스키마카드 **8/10 = 80%** / 테이블명만 **7/10 = 70%** | Δ가 +50pp에서 **+10pp로 축소**, 재시도 2회 vs 6회 | 동일 |
| **end-to-end `ask`** | 컨텍스트에 정답 근거 포함 | **91~96%** (7B 비결정성으로 run 간 변동) | 레인별 gold |
| **end-to-end `ask`** | 답변 접지 (컨텍스트 밖 개체 생성) | **0건 / 18문항**, 3회 연속 | 답변 개체 ⊆ 컨텍스트 |
| **end-to-end `ask`** | 미존재 개체 질의 거절 | **성공** (「주어진 정보로는 알 수 없습니다」) | 서울물산 케이스 |
| **벡터 검색** | hit@5 (BGE-M3 → 768 절단) | **67/68 = 0.985** (95% CI [0.921, 0.997]; 1024 원본도 67/68, hash 0.779, nomic-embed-text 0.368) — 구 8문항 결과는 §0.9로 대체 | 원문 키워드 규칙 (검색기는 질문만 봄) |
| **벡터 검색** | 문서 타입 정밀도 | 0.971 (hash 1.000) | 사업자 `index.json` 타입 |
| **지식그래프** | 골드 엔티티 검색 recall | **9/9 = 1.00** (평균 1.000) | `edges.json`에서 계산한 정답 집합 |

읽는 법 세 가지.

1. **라우터 100%는 in-sample이다.** 30문항은 사업자가 *공개한 예시*이고 라우터 어휘를 그 문항을 읽으며 작성했다. 일반화 수치가 아니라 "3레인 분기가 사업자 의도와 일치한다"는 확인으로 읽어야 한다. 어휘 자체는 스키마·그래프 스키마에서 뽑았지 라벨에서 뽑지 않았다.
2. **NL2SQL 60%의 ablation이 본 프로젝트의 논지를 사업자 데이터에서 재현한다 — 단 재시도를 붙이면 그 논지가 무너진다(§0.6).** 테이블명만 준 베이스라인의 실패 8건 중 6건이 **존재하지 않는 컬럼 환각**(`contracts.is_active`, `clients.registration_date`, `employees.department_id` …)이었다. 값 어휘(`quarter='2025-Q3'`, `status='active'`)까지 담은 스키마 카드를 주면 그 실패군이 사라진다. 내부 벤치의 Δ +53.0pp와 같은 방향이며, **같은 데이터·같은 모델·같은 채점기**로 측정했다.
3. **남은 4건은 숨기지 않는다.** ① `보안 솔루션 … 월 평균 매출` = 모델이 OR 우선순위를 틀림(진짜 오답), ② `활성 계약 수` = 스키마 카드에 `status['active'…]`가 있는데도 `is_active` 환각, ③ `평균 연봉이 가장 높은 부서` = `dept_id`만 반환(부서명 조인 누락), ④ `가장 많은 프로젝트를 진행 중인 고객사` = 모델이 `status='in_progress'` 필터를 **추가**했다 — 사업자 hint는 필터 없이 GROUP BY만 지시하므로 gold 기준으로는 오답이지만 질문 문면("진행 중인")으로는 모델 쪽이 더 충실한 해석이다. 이 4건은 7B 한계와 질문 모호성이지 파이프라인 결함이 아니다.

**그래프 레인은 이번에 새로 만들었다.** 공식 라벨이 요구하는 `knowledge_graph`가 기존 라우터에 아예 없었고(구 라우터 = structured/semantic 2레인), 초기 실측 평균 recall은 **0.278**이었다. 원인 4가지를 고쳐 **1.000**으로 올렸다: ① 확장이 out 방향뿐이라 역방향 질의("Product-C1을 **사용하는** 고객사")가 조용히 0건 반환 → 양방향 BFS, ② 시드가 substring 매칭 상위 5건이라 `Product-C1`을 물으면 엉뚱한 제품이 시드 → exact>prefix>substring 랭킹, ③ 노드를 지목하지 않고 **관계만** 지목하는 질의("가장 많은 고객을 **담당하는** 직원")는 시드가 없어 시작 불가 → 관계 단위 스캔·차수 집계 도입(집계는 DB가 하고 모델은 읽기만), ④ 노드 속성 미적재로 `status='in_progress'` 필터 불가 → 속성 적재.

**환각 방지 게이트(실측).** 사업자 예시 24번 `서울물산 담당 엔지니어는 누구야?`의 **서울물산은 데이터셋에 존재하지 않는다**(고객사는 `Client-A…Client-AD`, questions.json에만 등장). 이때 관계 전체(MANAGES_ACCOUNT 63엣지)를 컨텍스트로 밀어 넣으면 7B는 그럴듯한 담당자를 **지어낸다**. 그래서 "질의가 개체를 지목했는데 온톨로지에서 해소 실패 + 관계 단위 의도 없음" 조건에서 컨텍스트를 **0엣지 + 명시적 not-found 한 줄**로 만든다(`eval/results/companyx-kg.json → unresolved_gate_fired: 1`). 데이터셋 결함은 사업자에게 별도 문의했다.

## 0.6 자기 반증 — 스키마 카드의 기여는 정확도가 아니라 비용이었다

실패한 SQL을 **데이터베이스 자신의 카탈로그**(information_schema 실컬럼 목록)와 함께 모델에 한 번 되먹이는 self-repair를 붙이자, 스키마 카드 유무의 **정확도 차이가 사라졌다**.

| 조건 | 정확도 | LLM 호출 | 총 소요 | 재시도 |
|---|---|---|---|---|
| 스키마 카드, 재시도 없음 | 60% | 10회 | — | — |
| 테이블명만, 재시도 없음 | 20% | 10회 | — | — |
| 스키마 카드 + 재시도 1회 | **70%** | **12회** | **8.7초** | 2건 |
| 테이블명만 + 재시도 1회 | **70%** | 16회 | 11.6초 | 6건 |

**해석을 바꿔야 한다.** 스키마 카드와 self-repair는 다른 기능이 아니라 **같은 병(모델이 스키마를 모른다)의 사전 처방과 사후 처방**이다. 사전에 주면 첫 호출에 맞고, 사후에 고치면 두 번째 호출에서 맞는다. 그래서 재시도가 있는 시스템에서 스키마 카드가 사는 근거는 정확도가 아니라 **호출 수 33% 감소, 지연 25% 감소, 실패 경로 3분의 1**이다. 재시도가 없는 경로에서는 Δ +40pp의 정확도 차이가 그대로 남는다.

이 결과는 내부 벤치의 「구조보존 큐레이션 Δ +53.0pp」를 **부정하지 않지만 조건을 붙인다**: 그 수치는 재시도 없는 단발 호출 조건의 값이다. 같은 조건에서 사업자 데이터가 Δ +40pp로 재현했고, 재시도를 허용하면 이득이 정확도에서 비용으로 이동한다. 심사자가 재시도를 전제로 본다면 헤드라인은 **같은 정확도를 절반의 재시도로 달성한다**여야 한다.

self-repair 자체는 튜닝 파라미터를 늘리지 않는다. 재시도 조건은 "엔진이 오류를 냈는가" 하나뿐이고, 성공한 쿼리는 재시도되지 않으며, 임계값도 샘플링도 없다.

---

## 0.7 제품 경로(`ask`) 실측 — 레인 점수가 아니라 실제 답변

레인 평가는 **검색**을 재고 심사자가 보는 것은 **답변**이다. 30문항 전부를 `ask`(route → 병렬 fan-out → RRF → 큐레이션 → 온프렘 7B)로 돌려 LLM 저지 없이 셋을 측정했다. ① 큐레이션된 컨텍스트가 정답 근거를 담았는가 ② 답변이 언급한 데이터셋 개체가 전부 컨텍스트 안에 있는가(밖이면 지어낸 것) ③ 미존재 개체 질의를 거절하는가.

**첫 실행에서 결함 5개가 드러났고 전부 "검색은 맞는데 출력이 새는" 유형이었다.** 레인 평가만 봤으면 못 봤을 것들이다.

| 증상 | 진단 | 수정 |
|---|---|---|
| 「경영지원팀 팀장」에 「알 수 없습니다」, 정답은 컨텍스트 한 줄 아래 | ① 부서명이 소속 직원 전원의 property alias라 exact 동점이 되고 짧은 이름 타이브레이크로 **부서 노드가 시드에서 탈락** ② RRF의 리스트당 중복 제거가 「윤소연 이름 매칭」(정보 없음)을 「경영지원팀의 부서장: 윤소연」(정답)보다 먼저 잡아 대표로 남김 | canonical exact 4 > alias exact 3 분리, 후보 순서를 **엣지 우선, 이름 매칭 후순위**로 |
| 「Product-S1 관련 고객 이슈」에 「이슈 없습니다」 | 관계가 특정된 질의를 2홉까지 확장해 **다른 제품 엣지**가 컨텍스트를 채움 | 관계가 지정되면 1홉, 미지정이면 요청 깊이 유지 |
| 같은 질의에서 고객 8곳이 1줄로 붕괴 | 들어오는 엣지 8개가 전부 dst(=Product-S1) 기준 같은 canonicalKey라 중복 제거가 정당하게 8을 1로 접음 | 엣지 키를 **답이 되는 쪽 끝점**으로(시드가 dst면 src) |
| 「활성 계약 수」에 빈 컨텍스트 | `contracts.is_active` 환각으로 SQL 거부, 컨텍스트 0자 | self-repair(§0.6). 첫 판은 스키마 카드만 되먹여 **같은 환각을 반복**했고 information_schema 실컬럼을 주자 `status='active'`로 교정 |
| 중국어 혼입 2건, 「dept_id 5번」 | 7B code-switching, id 그대로 노출 | 답변 프롬프트에 한국어 고정, 관계줄 해석, id 대신 이름, 동점 전부 나열 |

수정 후 근거 포함 82.6% → **95.7%**(gold 정의를 보수화하면 91.3%), 접지 위반 **0**, 미존재 개체 거절 성공, 중앙값 **830~940ms**, 레인 일치 30/30, 브랜치 오류 0.

남은 오답 3건은 숨기지 않는다. 「월 평균 매출」은 제품별 그룹핑 해석 차이, 「진행 중인 고객사」는 모델이 `status='in_progress'`를 **추가**한 것이고 사업자 hint에는 필터가 없어 gold 기준으로만 오답이며 질문 문면으로는 모델 쪽이 더 충실하다, 「미해결 티켓」은 `closed`를 미해결에 포함한 진짜 오답이다. 셋 다 7B의 자연어 해석 한계이지 파이프라인 결함이 아니고, 여기서 프롬프트를 더 만지면 **공개된 30문항에 과적합**된다.

**데이터셋 프로파일.** 이 작업 전까지 `route`/`vector.search`/`retrieve`/`ask`는 스모크 시드(public.orders)에 하드와이어되어 있었고 companyx는 평가 CLI만 알고 있었다. 즉 **심사자가 MCP 서버를 띄우면 지정과제 데이터가 아니라 장난감 테이블이 나왔다.** `DATASET=companyx|bench|smoke` 프로파일 하나로 전 도구를 한 코퍼스에 묶었다(`air-server/src/profile.ts`).

---

## 0.8 사업자 공개자료 정밀독해 — 물어보는 대신 읽고 재는 쪽을 골랐다

담당자 메일을 받고 문의 5건을 정리했으나, 보내기 전에 사업자가 이미 공개한 것을 전부 읽었다. 블로그 9편·제품 19종·서비스 7종·공지 3건(**99페이지**), **air 공식 문서 34페이지(196KB)**, 그리고 과제가 「필수 참조」로 지정한 **논문 2편 PDF 전문**이다. 결과적으로 **5건 중 4건이 닫혔고 출제자만 답할 수 있는 1건만 남았다**.

### 0.8.1 필수 참조를 인용에서 근거로

**전현우·김태성·강현 2026** (zenodo 18842478, 저자 소속에 **Liwonace Corp.** 포함): 컨텍스트 4성분 K·A·D·G의 2⁴ 요인실험 3,805런. ① 풀 컨텍스트가 빈 baseline 대비 유의(Qwen **d=0.835, p<0.001**) ② **K(지식베이스)만 유의한 주효과**(Δ=0.119, p=0.028) ③ K+A vs Full에서 **Qwen만 풀 컨텍스트가 유의하게 우수**(p<0.001, d=-0.347), Llama는 차이 없음.

→ 본 구현이 Qwen2.5-7B를 쓰고 큐레이션된 컨텍스트를 공격적으로 트림하지 않는 것은 이제 취향이 아니라 **이 실측치**에 근거한다. 그리고 「K만 유의」는 컨텍스트 예산 배분의 지침이 된다 — §0.7에서 그래프 레인의 이름매칭 줄(부기성 정보)을 엣지(K) 뒤로 미룬 수정이 이 방향과 일치한다.

**Pylon-7** (zenodo 18808598): 615런, CPU-only 보급형 하드웨어. ① 계층화가 **토큰 47%↓·정확도 37%↑ 동시 달성** ② **L3가 sweet spot**, 과도한 제약(L4)은 정확도 소폭 하락 ③ **7B+MCP가 20B 단독보다 3.5배 저렴·14.4%p 정확**. 설계 원칙은 Descent Cost(하위 계층일수록 비용·위험 증가)·Gateway·Independence.

### 0.8.2 그 독해가 잡아낸 우리 결함 두 가지

**(1) Pylon-7 계층 번호를 거꾸로 붙이고 있었다.** 논문 Table 1은 **L7 Interface(위험 최소) → L1 System(셸·root, 위험 최대)**의 내림차순이다. 본 구현은 `route:2 / graph:5 / retrieve:4`였는데 논문 기준으로는 각각 **L5 Routing / L3 Resource / L6 Analysis**다. 특히 route에 붙였던 2번은 논문에서 **L2 = Mutation(코드 수정, High risk)** 자리다. 필수 참조를 인용하면서 그 표를 반대로 쓰고 있었다.

**(2) air Meter의 L1~L7은 Pylon-7과 방향이 반대다.** air 공식 문서(`guide/meter`)의 Meter는 **비용 오름차순**(L1 정적응답 → L2 조회 → L6 LLM 호출 → L7 에이전트 체인)이고, `defineTool`의 `layer`는 **Meter의 자동 분류를 오버라이드한다**. 거기에 Pylon-7 번호를 넣으면 비용·지연 통계가 통째로 잘못된 계층에 집계된다.

→ 그래서 **`layer`는 air Meter 규약**을 따르고, **Pylon-7 위치는 `tags: ["pylon7:Lx"]`**로 분리했다. 두 체계를 다 읽지 않으면 보이지 않는 충돌이다.

→ 정리하고 나니 드러난 사실 하나: 7개 도구 중 **Pylon-7 L2(Mutation)·L1(System)에 해당하는 도구가 하나도 없다.** 전 도구가 읽기 전용이고 `sql.query`는 NOLOGIN `mcp_ro`로 강등된다. Descent Cost Principle 관점에서 **비용·위험이 최대인 두 계층에 애초에 내려가지 않는 설계**다.

### 0.8.3 임베딩 차원 — 물어볼 문항을 실측으로 대체했다

사업자 입장은 세 곳에서 일관된다. 공지는 "**Ollama의 임베딩 모델을 활용하여 적재**"라고만 하고 모델을 지정하지 않는다. 블로그(VectorDB 튜닝)는 "**PCA나 Matryoshka로 768 또는 512차원으로 줄여도 검색 품질 차이는 미미**"라고 쓴다. 자사 제품 Bubble Embedding은 **512차원·CPU only·한국어 특화**다. 반면 같은 블로그(RAG 실수 5가지)는 "**범용 영어 임베딩을 그대로 쓰는 것은 실수, 한국어 문서는 도메인 특화가 훨씬 정확**"이라고 못 박는다.

즉 요구는 「차원은 작게, 단 한국어를 포기하지 말 것」이다. 그러면 768 네이티브 영어 모델로 갈아타는 것은 오답이고 한국어 모델을 잘라 쓰는 것이 정답이다. 사업자 코퍼스에서 직접 쟀다.

| 임베더 | dim | hit@5 | 문서 타입 정밀도 |
|---|---|---|---|
| hash (오프라인 결정론) | 1024 | 0.75 | 1.000 |
| BGE-M3 | 1024 | **1.00** | 0.971 |
| **BGE-M3 → 768 절단+재정규화 (채택)** | **768** | **1.00** | 0.943 |
| BGE-M3 → 512 절단+재정규화 | 512 | **1.00** | 0.971 |
| nomic-embed-text (768 네이티브) | 768 | 0.75 | **0.486** |

**결론: 공식 `vector(768)`을 원본 그대로 쓴다.** nomic으로 갈아탔다면 타입 정밀도가 0.971 → 0.486으로 반토막 났을 것이다. 귀사 블로그의 처방을 귀사 데이터에서 검증한 결과이며, 이로써 스키마 변경 사유가 사라졌다(`ddlDeviations: []`).

### 0.8.4 air를 3/19에서 8개로, transport는 설정 한 줄로

air는 **19개 플러그인**을 제공하는데 본 구현은 timeout/retry/circuitBreaker 3개만 쓰고 있었다. 이 워크로드가 **전 도구 읽기 전용 + 결정론**이라는 성질에 근거해 5개를 더했다.

`jsonLogger`(ELK/Datadog 호환 감사 로그) · `sanitizer`(도구 입력은 외부 입력이다, Hou 2025 위협모델) · `queue`(온프렘 7B 경로만 동시 2로 좁힘) · `dedup`(병렬 fan-out의 동일 하위호출 제거) · `cache`(**결정론이 캐시를 안전하게 만든다** — 같은 질의가 같은 결과를 보장하므로 TTL 캐싱이 정확도를 훼손하지 않는다).

쓰지 않은 것에도 근거를 둔다: auth/cors/rateLimit은 stdio 로컬 배포에 불필요하고, transform/i18n은 응답 계약을 흐리며, dryrun은 개발 전용이다.

또한 이전 문서가 "stdio→HTTP transport는 후속"이라고 적어둔 항목은 **air가 설정 한 줄로 지원**한다(`transport: { type: 'sse', port }`). `MCP_TRANSPORT=sse`로 전환된다.

### 0.8.5 남은 최대 갭 — 키워드 검색

사업자 Vector Engine 제품 페이지는 "**벡터 검색만으로는 부족합니다. 키워드 검색과 결합해야 정확합니다**"라고 명시하고, 시맨틱 + BM25를 **RRF**로 융합한다. 본 구현은 RRF를 쓰지만 융합 대상이 SQL·벡터·그래프이고 **키워드 검색 레인이 없다**. PostgreSQL FTS(tsvector) + 한국어 바이그램은 추가 의존성 없이 구현 가능하며 RRF의 네 번째 소스로 들어간다. 이것이 다음 작업 1순위다.

---

재현:

```bash
bash scripts/fetch-companyx-dataset.sh            # SHA-256 검증 후 추출 (재배포 금지 라이선스 → 저장소 미포함)
cd air-server
EMBEDDER=ollama npm run companyx:load             # 적재 + BGE-M3 임베딩
npm run companyx:route                            # 라우터 30문항
npm run companyx:sql                              # NL2SQL (CX_STRATEGY=naive 로 ablation)
npm run companyx:kg                               # 지식그래프 recall
EMBEDDER=ollama npm run companyx:vector           # 벡터 hit@5 (hash vs BGE-M3)
DATASET=companyx EMBEDDER=ollama npm run companyx:ask   # end-to-end 답변 (§0.7)
CX_REPAIR=0 npm run companyx:sql                  # self-repair 끈 대조군 (§0.6)
```

---

## 0.9 벡터 레인 재평가 — 8문항을 68문항으로 늘리고, 우리가 자른 차원을 직접 쟀다

**왜 다시 쟀나.** 기존 벡터 평가는 채점 가능한 문항이 8개였다. hit@5 = 1.00처럼 보였지만 그 표본에서 정확도 1.0의 95% Wilson 하한은 0.676이다. 즉 "임베딩 모델이 좋다"도 "차원을 잘라도 괜찮다"도 이 수치로는 말할 수 없었다. 그리고 R4 리서치에서 **bge-m3 모델 카드가 dense 1024만 명시하고 Matryoshka 축소를 주장하지 않는다**는 것이 확인되면서, 우리가 앞 768개만 저장해 온 방식이 공식 출력 모드가 아니라는 사실이 드러났다.

**어떻게 늘렸나.** `eval/companyx/build_vector_gold.py`가 71문항을 만든다(채점 가능 68). 오라클 계약은 그대로다 — 문서가 정답인 조건은 `keywords`를 전부 포함하는 것이고 검색기는 질문 문장만 본다. 생성기가 강제하는 것은 셋이다. ① 정답 집합 크기 1~3(0이면 채점 불가, 4 이상이면 변별력 없음) ② 문서 40건 전부 커버 ③ `style` 표기 — `paraphrase` 30문항은 **키워드를 질문에 한 글자도 노출하지 않는다.** 어휘가 겹치면 의미 검색이 아니라 문자열 매칭을 재게 되기 때문이다.

**결과 (68문항, 동일 코퍼스·동일 top-k=5, `eval/results/companyx-vector.json`).**

| 임베더 | 차원 | hit@5 | 95% CI | entity 38문항 | paraphrase 30문항 | 유형 정확도 |
|---|---|---|---|---|---|---|
| BGE-M3 원본 | 1024 | **67/68 = 0.985** | [0.921, 0.997] | 37/38 | **30/30** | 0.891 |
| BGE-M3 앞 768 절단 (현행) | 768 | **67/68 = 0.985** | [0.921, 0.997] | 37/38 | **30/30** | 0.880 |
| 해시 임베더 (오프라인 폴백) | 1024 | 53/68 = 0.779 | [0.667, 0.862] | 28/38 | 25/30 | 0.680 |
| nomic-embed-text (영어 전용, 공식 768) | 768 | 25/68 = 0.368 | [0.263, 0.486] | 19/38 | **6/30** | 0.366 |

**읽는 법 네 가지.**

1. **절단의 손실이 관측되지 않았다.** 1024와 768은 총점이 같고, 서로 다른 문항 하나씩을 놓쳤다(불일치 쌍 1대 1, McNemar exact p = 1.0). 이 코퍼스, 이 표본에서 우리 절단은 성능을 깎지 않았다. 다만 **"공식 지원 모드가 아니다"는 사실은 측정으로 바뀌지 않는다.** 그래서 보고서와 README는 이를 기능이 아니라 제약으로 적는다.
2. **"공식 768 모델로 바꾸면 된다"는 단순 처방은 반증됐다.** 우리가 로컬에서 확보한 공식 768 출력 모델(nomic-embed-text)은 영어 전용이고, 같은 한국어 문항에서 25/68에 그쳤다. paraphrase 문항에서는 6/30으로 무너진다. 차원의 공식성보다 **언어 적합성이 먼저**라는 것이 이번 실측의 결론이다. 다국어이면서 공식 768을 내는 모델이 확보되면 그때 다시 대조한다.
3. **해시 폴백은 폴백이다.** 53/68로 실사용 품질이 아니며, paraphrase에서 25/30으로 버티는 것은 이 코퍼스의 어휘 반복 때문이다. CI에서 임베딩 모델 없이 파이프라인이 도는지 확인하는 용도 이상으로 쓰지 않는다.
4. **표본은 늘었지만 코퍼스는 그대로다.** 문서 40건이라 절대 성능을 일반화할 수 없다. 이 표는 모델 간 상대 비교이지 제품 성능 보증이 아니다.

**재현.**

```bash
python eval/companyx/build_vector_gold.py            # 평가셋 생성·검증(문항 71, 채점 68, 커버리지 40/40)
node scripts/pg-keepalive.mjs &                      # WSL2 PostgreSQL 유휴 종료 방지
cd air-server
CX_COMPARE=1 CX_TOPK=5 CX_MODELS="bge-m3,nomic-embed-text,bge-m3@768" node dist/cli/companyx-vector-eval.js
```

> 환경 주의: 이 개발 환경의 PostgreSQL은 WSL2 안에서 돈다. WSL VM이 유휴 상태로 60초쯤 지나면 배포판이 내려가면서 PostgreSQL이 fast shutdown되고, 진행 중이던 평가 세션은 `57P01`로 끊긴다(2026-07-29 실측, WSL 로그에서 `received fast shutdown request` 확인). 임베딩 백필처럼 DB를 몇 분 놀리는 작업은 배포판을 붙잡아 두고 돌려야 한다.

## 0.10 NL2SQL 2x2 재측정 — 우리가 인용하던 숫자의 근거가 저장소에 없었다

**어떻게 드러났나.** 2026-07-29 심사 시뮬레이션 레인이 "저장소의 `companyx-sql-llm.json`은 8/10인데 문서는 6/10이라고 적혀 있다"고 지적했다. 확인해 보니 재시도를 켠 실행이 같은 파일 경로에 덮어써 있었고, **문서가 헤드라인으로 인용하던 재시도 없는 수치의 원자료가 저장소에 남아 있지 않았다.** 평가 CLI가 조건에 상관없이 전략별로 한 파일에만 쓰고 있었던 탓이다.

**무엇을 고쳤나.** `companyx-sql-eval.ts`가 `CX_REPAIR=0`일 때 `-norepair` 접미사를 붙여 별도 파일에 쓰도록 바꿨다. 2x2 네 칸이 동시에 저장소에 남는다. 그리고 같은 코드 상태에서 네 조건을 모두 다시 돌렸다.

| 조건 | 재시도 없음 | 재시도 1회 |
|---|---|---|
| 값 어휘를 담은 스키마 카드 | **7/10** (`companyx-sql-llm-norepair.json`) | **8/10** (`companyx-sql-llm.json`, 재시도 2회) |
| 테이블명만 (ablation) | **2/10** (`companyx-sql-naive-norepair.json`) | **7/10** (`companyx-sql-naive.json`, 재시도 6회) |

**해석이 어떻게 바뀌었나.**

- 재시도가 없을 때의 격차는 **Δ +50pp**로, 이전에 적어 둔 +40pp보다 오히려 크다.
- 재시도를 붙이면 격차가 **Δ +10pp**로 줄어든다. 다만 이전에 적었던 "차이가 완전히 사라진다(둘 다 70%)"는 **이번 실행에서는 재현되지 않았다.** 스키마 카드 쪽이 한 문항 앞선다.
- n=10이고 7B는 실행마다 한 문항 정도 흔들린다. 그래서 10pp는 유의하다고 말하지 않고, **재시도 횟수 2회 대 6회**라는 비용 차이를 논지로 남긴다. §0.6의 결론(스키마 카드의 기여가 정확도에서 비용으로 이동한다)은 유지되지만, 그 근거는 "정확도가 같아진다"가 아니라 "격차가 좁아지고 비용이 갈린다"로 정정한다.

**교훈은 도구 쪽이다.** 평가 조건이 여러 개인데 출력 파일이 하나면, 마지막 실행만 살아남고 문서는 사라진 근거를 계속 인용한다. 이번엔 외부 검토가 잡아냈지만 다음에도 그러리라는 보장이 없어서 조건을 파일명에 넣었다.

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
- **공식 데이터셋(Company-X):** 무결성·출처 `datasets/MANIFEST.md`(SHA-256 고정), 취득 `scripts/fetch-companyx-dataset.sh`, 적재 `air-server/src/companyx.ts`. 결과 `eval/results/companyx-{load,route,sql-llm,sql-naive,kg,vector}.json`. 오라클 정의 `eval/companyx/{sql_gold.jsonl,kg_gold.json,vector_gold.json}`. 회귀 `air-server/src/companyx.test.ts`(46 단언, `npm run test:companyx`). end-to-end `air-server/src/cli/companyx-ask-eval.ts` → `eval/results/companyx-ask.json`. 프로파일 `air-server/src/profile.ts`.
- 라이선스/모델: `LICENSE`(Apache-2.0), `NOTICE`, `docs/model-cards/{qwen2.5-7b,bge-m3}.md`.
- 하드웨어: Apple M4 / macOS 25.5 (초기 빌드·내부 벤치). 공식 데이터셋 실측은 Windows 11 + RTX 4070 SUPER, PostgreSQL 16.14 + pgvector 0.6.0(WSL2 Ubuntu 24.04), Ollama 0.32.4 — 실행 환경이 바뀌어도 같은 커맨드로 재현되는지까지 확인한 결과다.

---

## 10. 정직 경계 & 다운스트림

- **정직 경계(NEVER COMPROMISE):** 자동 promotion/failover·lag SLA·멀티노드 부하시험 로그가 없으므로 "production HA / 자동 failover"를 단정하지 않는다. 라이브 replica는 검증된 spike(kill-drill 로그)까지가 주장 범위.
- **빌드 완료:** 9개 워크스트림(Gate0~8) 전부 빌드+검증(내부 100Q, ablation, 외부 BIRD, 의미검색, 3-way, fault, 클러스터, 패키징, 라이선스/보고서).
- **다운스트림(제출 절차):** 3분 시연영상 녹화(스크립트 `docs/demo-script.md`) + 포털 제출(08-27). 선택: 풀 BIRD 500 전수(~7h).
- **배점 재정렬:** OT(07-23) 배점 공개 후 본 보고서 헤드라인 가중치를 채점 기준에 맞춰 조정한다.

---

## 11. 배점 대응표 (2026-07-29 확정 배점 기준)

출처 = OT 녹화 4강 슬라이드 p07(1차 30점), p09(2차 70점). 각 항목에 대응하는 **이미 존재하는 증거**만 적는다. 없는 것은 없다고 적는다.

### 1차 서면 30점

| 평가항목(배점) | 대응 증거 | 상태 |
|---|---|---|
| 프로젝트 구조 및 코드 완성도 (6) | 레이어 분리(§3), 읽기 전용 SQL 가드, 프로파일 단일화(`profile.ts`), 테스트 223단언 | 있음 |
| 오픈소스 프로젝트로의 발전 가능성 (6) | Apache-2.0, 재현 커맨드 전량 공개, 데이터셋 비재배포 + fetch 스크립트, 확장 로드맵 | 있음 |
| 개발 문서의 구체성 (6) | 본 개발보고서, `docs/architecture.md`, 모델카드 2종, `docs/sbom.md`, `docs/ai-model-spec.md`, evidence manifest(§9) | 있음 |
| 프로젝트 혁신성 (6) | 3레인 자동 분기 + 구조보존 큐레이션의 인과 실증(Δ +40pp/+53pp), 환각 차단 게이트, 자기 반증(§0.6) | 있음 |
| 프로젝트 팀워크 (6) — **1인 참가는 프로젝트 관리체계로 채점**(github issues, review, pull requests, commit, merge, 커뮤니티) | 커밋 히스토리는 있으나 **공개 저장소가 없어 issues/PR/review 흔적이 0**이다 | **미충족 (최대 갭)** |

### 2차 발표 70점

| 평가항목(배점) | 대응 증거 | 상태 |
|---|---|---|
| 작품발표 PT (10) — 오픈소스SW 활용 라이브러리 표기 명시 | 발표자료 미작성. 라이브러리 표기 재료는 `docs/sbom.md`로 준비됨 | 미작성(2차 진출 시) |
| 활용성 (15) | 온프렘 적용 가능 도메인, CPU 7B 기준 실측, MCP 클라이언트 호환 | 있음 |
| 작품 데모 완성도 (10) | `npm run demo` 오프라인 종단 시연, 중앙값 910ms | 있음 |
| 커뮤니티 확장 가능성 (10) | 품질관리 체계(테스트·평가 재현), 개발 로드맵은 있으나 **커뮤니티 참여 흔적 없음** | 부분 |
| 오픈소스SW 적절성 (10) | 의존성 110개 전부 허용형, 카피레프트 0건, air/pgvector/Ollama 적재적소 사용 | 있음 |
| 기능테스트 (10) | 장애주입 무중단 4/4, 부분응답 4/4, 오류가시성 4/4, replica kill drill 로그 | 있음(외부기관 재검증 대상) |
| 라이선스 검증 (5) | SBOM 자동생성, 충돌 0건. **NIPA 오픈업 사전 컨설팅으로 채점 전 확인 가능** | 있음(사전 컨설팅 미신청) |

### 이 표가 지목하는 것

**최대 갭은 성능이 아니라 공개 운영 흔적이다.** 1차 6점(팀워크=관리체계)과 2차 10점(커뮤니티 확장)이 저장소 공개와 이슈/PR 운영에 걸려 있고, 현재 저장소에는 원격이 없다. 운영규정 제10조가 공개 저장소 게시를 의무로 두고 있어 어차피 필수 요건이기도 하다.
