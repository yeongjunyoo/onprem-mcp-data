# onprem-mcp-data

[![CI](https://github.com/yeongjunyoo/onprem-mcp-data/actions/workflows/ci.yml/badge.svg)](https://github.com/yeongjunyoo/onprem-mcp-data/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-8%20tools-informational)](docs/architecture.md)
[![Model](https://img.shields.io/badge/LLM-qwen2.5%3A7b%20(local)-success)](docs/model-cards/qwen2.5-7b.md)

**사내 데이터베이스에 자연어로 묻고, 근거와 함께 답을 받는 온프렘 MCP 서버.** 질문 하나를 벡터 검색, NL2SQL, 지식그래프 세 갈래로 자동 분기해 동시에 조회하고, 결과를 합쳐 로컬 소형 모델이 답합니다. 모델은 전부 로컬에서 돌고 **외부 API를 호출하지 않습니다.** 이 주장은 CI가 검사합니다 — `node scripts/verify-no-external-api.mjs`가 런타임 소스의 네트워크 호출 대상과 관련 환경변수 기본값을 훑어, 루프백과 compose 형제 서비스가 아닌 곳이 하나라도 있으면 실패합니다.

| | |
| --- | --- |
| 무엇을 푸는가 | 사내 데이터는 밖으로 못 내보내는데, 문서 검색과 통계 조회와 관계 추적은 서로 다른 시스템에 흩어져 있다 |
| 어떻게 | MCP 도구 8종 뒤에서 3레인 라우팅, 병렬 조회, RRF 융합, 구조 보존 큐레이션, 로컬 7B 답변 |
| 무엇을 안 하는가 | 외부 상용 API 호출, 쓰기 작업, 컨텍스트 밖 추측 |
| 실행 환경 | PostgreSQL 16 + pgvector, Ollama, Node.js 20 이상. GPU 없이 CPU로 동작 |

[English summary](README.en.md) | [개발보고서](docs/report.md) | [아키텍처](docs/architecture.md) | [SBOM](docs/sbom.md) | [기여 안내](CONTRIBUTING.md)

## 30초 만에 돌려보기

```bash
git clone https://github.com/yeongjunyoo/onprem-mcp-data.git && cd onprem-mcp-data
docker compose up -d                                     # PostgreSQL 16 + pgvector, Ollama
docker compose exec ollama ollama pull qwen2.5:7b
docker compose exec ollama ollama pull bge-m3

cd air-server && npm ci && npx tsc
export OLLAMA_HOST=http://localhost:11435                # 컨테이너 Ollama
npm run gen:bench && npm run embed:bench:ollama          # 결정론 시드 데이터 적재
npm run demo:ollama                                      # 도구 8종부터 장애 주입까지 한 번에
```

> **Windows(cmd/PowerShell)에서는** `export` 대신 `set OLLAMA_HOST=http://localhost:11435`
> 또는 `$env:OLLAMA_HOST="http://localhost:11435"` 를 씁니다. 그 외 명령에는 셸 전용
> 문법이 없습니다 — `npm run demo:ollama` 처럼 환경변수를 스크립트가 직접 넘깁니다.
> 이 저장소는 Windows에서 개발·검증됐고 `npm run test:integration` 도 그 환경에서
> 끝까지 돕니다.
>
> **포트가 11435인 이유.** 컨테이너 Ollama를 11434로 게시하면 호스트에 이미 설치된
> Ollama와 충돌하는데, Docker는 이때 **조용히 게시를 포기한다**(`PublishedPort: 0`).
> 컨테이너는 `running`이고 에러도 없으며, 앱은 호스트 데몬에 붙는다 — 그 데몬이 어떤
> 모델을 갖고 있든. 포트를 갈라 두면 어느 쪽에 붙었는지가 항상 명시적이다.
> 호스트 Ollama를 쓰고 싶다면 `OLLAMA_HOST`를 `http://localhost:11434`로 두면 된다.
>
> 실행 시작 시 **실제로 붙은 엔드포인트와 그 모델 목록**을 찍는다. 필요한 모델이
> 없으면 무엇을 실행해야 하는지 알려주고 멈춘다.

`npm run demo`는 네트워크 없이 돕니다. 도구 호출, 3레인 합의, 로컬 7B 답변, 장애 주입 후 응답까지 한 화면에서 확인할 수 있습니다.

MCP 클라이언트에 붙이려면 stdio로 서버를 띄우면 됩니다. `MCP_TRANSPORT=sse`로 전송 방식을 바꿀 수 있습니다.

클라이언트 설정 파일(예: Claude Desktop의 `claude_desktop_config.json`)에 그대로 넣으면 됩니다.
`<저장소>`만 실제 경로로 바꾸세요.

```json
{
  "mcpServers": {
    "onprem-mcp-data": {
      "command": "node",
      "args": ["<저장소>/air-server/dist/index.js"],
      "env": {
        "DATABASE_URL": "postgresql://mcp:mcp@localhost:5433/mcpdata",
        "OLLAMA_HOST": "http://localhost:11435",
        "EMBEDDER": "ollama",
        "OLLAMA_MODEL": "qwen2.5:7b",
        "EMBED_MODEL": "bge-m3",
        "DATASET": "companyx"
      }
    }
  }
}
```

`DATASET`을 지우면 벤치 시드로 뜹니다. 위 설정 그대로 핸드셰이크를 돌려
`serverInfo` `onprem-mcp-data 0.2.0`과 도구 8종 열거를 확인했습니다 — 적어 놓고
안 돌려 본 설정이 아닙니다.

주 경로인 stdio 는 `node scripts/verify-stdio-tools.mjs` 가 도구 8종을 **실제로 호출해** 확인합니다(열거가 아니라 호출입니다 — `demo` 는 내부 호출이라 MCP 스키마 검증을 거치지 않습니다). sse 전환이 실제로 되는지는 `node scripts/verify-sse-transport.mjs` 로 확인합니다 — 포트가 열리는 것이 아니라 **MCP 핸드셰이크가 끝까지 가고 도구 8종이 열거되는지**를 봅니다.

## 동작 방식

```mermaid
flowchart LR
    Q["자연어 질문"] --> R["route<br/>규칙 기반 라우터<br/>LLM 호출 0"]
    R -->|structured| S["sql.query<br/>NL2SQL + 읽기전용 가드"]
    R -->|semantic| V["vector.search<br/>pgvector 코사인"]
    R -->|graph| G["kgRetrieve<br/>양방향 BFS"]
    S --> F["RRF 융합"]
    V --> F
    G --> F
    F --> C["retrieve<br/>구조 보존 큐레이션"]
    C --> A["ask<br/>로컬 7B, 근거 밖 생성 금지"]
```

- **라우터는 모델을 부르지 않습니다.** 질의 어휘를 스키마와 그래프 온톨로지에 대조하는 규칙 기반이라 튜닝 파라미터가 없고, 같은 질문에 같은 분기를 냅니다.
- **SQL은 읽기 전용으로 강등된 롤에서만 실행됩니다.** 쓰기 구문, 다중 구문 연결, 수퍼유저 함수는 거부되고 statement와 lock에 타임아웃이 걸립니다.
  이 문단의 주장은 `node scripts/verify-security-claims.mjs` 가 실제 DB 에 물어 확인합니다 — 실측 `current_user=mcp_ro` · `statement_timeout=8s` · `lock_timeout=2s` · `pg_read_file`/`pg_ls_dir` 거부. **보안 주장은 그렇게 짰다가 아니라 그렇게 도는가로만 증명됩니다.**
  방어는 2층입니다 — 문자열 가드와 `READ ONLY` 트랜잭션. **위층을 일부러 우회해 아래층만 남긴 상태**로 `node scripts/drill-readonly-defense.mjs` 를 돌려 데이터가 그대로임을 확인합니다(실측: orders 5행 → DELETE·UPDATE·INSERT 시도 → 5행). 층을 둘 쌓아 놓고 위층만 시험하면 아래층은 장식입니다.
- **큐레이션은 구조를 깨지 않습니다.** 표는 표로, 관계는 관계 문장으로 컨텍스트에 들어갑니다.
- **질문이 지목한 개체를 못 찾으면 컨텍스트를 비웁니다.** 관계를 통째로 밀어 넣으면 소형 모델은 그럴듯한 답을 지어냅니다. 그래서 미해소 개체는 0건과 not found로 만듭니다.

MCP 표면은 도구 8종, 리소스 6종, 프롬프트 4종입니다. `audit.explain`은 한 질의를 끝까지 실행하고 **왜 그 답이 나왔는지**를 기계가 읽을 감사 레코드로 돌려줍니다. 라우팅 근거, 거부된 SQL과 사유, 융합에 합의한 소스, 정책 판정 다섯 가지, 접지 검사까지 한 레코드에 담깁니다. 리소스는 스키마 카드, 데이터셋 매니페스트, 평가 원자료 색인, 활성 프로파일, 증거 목록을 도구 호출 없이 열람하게 합니다. 프롬프트는 서버가 실제로 쓰는 근거 기반 답변과 NL2SQL 템플릿을 그대로 노출합니다.

MCP 도구는 8종입니다. `route`, `sql.query`, `vector.search`, `retrieve`, `ask`, `audit.explain`, `ontology.search`, `graph.expand`. 지식그래프 3-way 검색(`kgRetrieve`)은 `retrieve`와 `ask` 안에서 동작합니다. 각 도구에는 위험도 계층 힌트가 붙어 있습니다.

## 측정 결과

모든 수치는 실행 결과이고 원자료는 `eval/results/`에 JSON으로 있습니다. 파일 목록·크기·SHA-256·생성 시각은 `eval/results/MANIFEST.md`가 고정합니다 — 자기 생성 시각을 들고 있는 아티팩트와 그렇지 않은 것을 구분해 적었습니다. **정확도 채점에 자체 제작한 LLM 심판을 쓰지 않았습니다.** 채점자는 데이터베이스 실행 결과와 정답 집합입니다.

| 측정 | 결과 | 표본과 조건 | 오라클 |
| --- | --- | --- | --- |
| 라우팅 도구 일치 | 30/30 | 사업자 공개 예시 30문항, **in-sample** | 데이터셋이 붙인 도구 라벨 |  <!--metric:route_insample-->
| **라우팅 일반화 (홀드아웃1, 템플릿 문형)** | **27/30 = 0.900**, 커버율 1.000, 진짜 오류 0 | 공개 예시와 어휘가 겹치지 않는 30문항 | 스키마/온톨로지 신호 라벨 |  <!--metric:holdout1_strict-->
| **라우팅 일반화 (홀드아웃2, 구어체)** | **19/30 = 0.633**, 커버율 0.933, 진짜 오류 2 | 업무 담당자 말투 30문항. 엣지 7종 전수 | 스키마/온톨로지 신호 라벨 |  <!--metric:holdout2_strict-->
| NL2SQL 실행 일치 | **5~7/10**, 스키마 카드 제거 시 **2/10** | 재시도 없음. n=10, 세션 내 반복은 동일하고 세션 간에 1~2문항 흔들린다 | 정답 SQL의 실행 결과 |
| NL2SQL 실행 일치 (재시도 1회) | **7~8/10**, 스키마 카드 제거 시 **7/10** | 실패 SQL을 DB 카탈로그와 함께 1회 되먹임. **재시도 2회 대 6회** | 동일 |
| 지식그래프 검색 재현율 | 1.000 (개선 전 0.278) | 10문항, 결함 4건 수리 후 | 관계 파일에서 계산한 정답 집합 |
| 벡터 검색 hit@5 | **0.986 (73/74)** | 74문항(사업자 문항 3건 복원 포함). 해시 폴백 0.775, 영어 전용 768 모델 0.380 | 원문 키워드 규칙 |  <!--metric:vector_hit5-->
| 종단 답변 근거 포함 | **17/19 = 89.5%** (5회 중 4회, 1회 18/19) | 30문항 중 채점 가능한 19문항. 사업자 vector 문항 3건 gold 복원 반영 | 레인별 정답 근거 |  <!--metric:ask_evidence--> <!--metric:ask_evidence_pct-->
| 접지 위반 | **0건** (answers_grounded 100%) | 답변이 명명한 데이터셋 개체가 전부 컨텍스트 안에 있다 | 실측 |  <!--metric:ask_grounded_pct-->
| 답변 접지 위반 | **0건 (19/19 접지)** | 답변에 등장한 데이터셋 개체가 컨텍스트에 있는지 검사. 채점 가능한 답변 전부가 접지됐다 | 컨텍스트 집합 |  <!--metric:ask_grounded_ratio-->
| 응답 지연 중앙값 | **10606ms** | `docker compose` Ollama(CPU, GPU 패스스루 없음) 기준 종단 30문항. 반복 실측 9.8~18.5초로 변동이 크다. GPU가 붙은 호스트 Ollama에서는 **864ms**(원자료 `eval/results/companyx-ask-host-gpu.json`) | 실측 |  <!--metric:ask_median_ms-->
| 응답 지연 (호스트 GPU) | **864ms** | GPU가 붙은 호스트 Ollama 기준 같은 30문항. 원자료 `eval/results/companyx-ask-host-gpu.json` | 실측 |  <!--metric:ask_median_ms_host-->
| 장애 주입 — 무중단 | **4/4** | DB 정지, 지연, 부분 실패 주입. 원자료 `eval/results/faults.json` | 실측 |  <!--metric:faults_nocrash-->
| 장애 주입 — 부분 응답 | **4/4** | 벡터 브랜치를 죽여도 그래프로 부분 컨텍스트 반환 | 실측 |  <!--metric:faults_partial-->
| 장애 주입 — 오류 가시성 | **4/4** | 실패한 브랜치를 `branch_errors` 로 감사 레코드에 남긴다 | 실측 |  <!--metric:faults_errvis-->
| 감사 레코드 정책 발동 | 예산 절감 17, SQL 허용 10, 자기수정 2, 미해소 차단 1 | 사업자 공개 30문항 | 실측 |
| **다단계 작업 완료율** | **5/6 = 0.833**, 단계 통과 14/15 | 개체 해소 -> 관계 탐색 -> 집계를 엮는 6작업 | 실측 |  <!--metric:multistep-->
| claim 단위 접지 | 정의와 채점 코드 공개, 결정론 | 문장별 원자 추출 + 컨텍스트 일치 | 코드 |
| 규칙 구간 결정론 | **5/5** (파이프라인 전체는 4/5) | 같은 질의 2회 실행, 지문 비교 | 실측 |
| 테스트 | **417단언 통과** | 오프라인 290 + DB·모델 통합 127. 데이터셋 없는 CI에서는 오프라인 279(사업자 데이터셋이 있어야 도는 온톨로지 커버리지 단언 11건 제외). CI가 러너 출력에서 다시 세어 대조한다. 원자료 `eval/results/test-counts.json` | 실측 |  <!--metric:test_total-->
| 의존성 라이선스 | 110개 전부 허용형, 카피레프트 0건 | 설치된 매니페스트에서 자동 생성 | `node scripts/sbom.mjs` |  <!--metric:dep_packages-->

재현 명령은 `docs/report.md`의 evidence manifest에 측정별로 적혀 있습니다.

## 주장을 지키는 검사

이 저장소의 수치와 문장은 사람이 지키지 않습니다. 검사가 지킵니다. 전부 **일부러 깨뜨려
exit 1 을 확인한 뒤** 커밋했습니다 — 통과만 하는 검사는 아무것도 보장하지 않습니다.

| 검사 | 무엇을 막는가 | CI |
| --- | --- | --- |
| `metrics-check` | 문서 수치가 `eval/results` 원자료와 어긋나는 것 | 예 |
| `verify-doc-metrics` | marker 없는 표 행·산문에 낡은 값이 남는 것 | 예 |
| `verify-test-counts` | 테스트 단언 수를 손으로 적는 것(러너 출력에서 재계수) | 예 |
| `verify-tool-surface` | 문서가 없는 도구를 부르게 하는 것, 버전이 갈리는 것 | 예 |
| `verify-no-external-api` | "외부 API 0" 주장이 코드와 어긋나는 것 | 예 |
| `verify-loud-failure` | 실패 경로가 조용히 다른 값을 돌려주는 것 | 예 |
| `verify-line-endings` | 셸·shebang 파일이 CRLF 로 체크아웃돼 실행이 깨지는 것 | 예 |
| `verify-demo-script` | 녹화 대본이 띄우는 수치가 실물과 달라 영상에 남는 것 | 예 |
| `verify-doc-links` | 문서 링크가 없는 파일을 가리키는 것 | 예 |
| `verify-contribution-entry` | 빈 이슈를 막고 질문 창구를 안 알려 기여자가 막다른 길에 서는 것 | 예 |
| `verify-no-dataset-redistribution` | 산출물이 사업자 코퍼스를 실어 나르는 것 | 예 |
| `evidence-manifest` | 증거 목록과 실제 파일이 어긋나는 것 | 예 |
| `sbom` | 카피레프트·미표기 라이선스가 섞이는 것 | 예 |
| `verify-stdio-tools` | 도구가 **열거만 되고 호출은 안 되는** 것 | DB·모델 필요 |
| `verify-client-config` | README 가 붙여넣으라는 설정이 실제로는 안 붙는 것 | DB·모델 필요 |
| `verify-sse-transport` | sse 전환 주장이 실제로는 안 되는 것 | DB·모델 필요 |
| `verify-security-claims` | 보안 문단이 실제 DB 설정과 어긋나는 것 | DB 필요 |
| `drill-readonly-defense` | 2층 방어가 장식인 것(1층을 우회해 확인) | DB 필요 |
| `drill-corpus-restore` | 벡터 평가가 코퍼스를 되돌리지 않는 것 | DB·모델 필요 |
| `drill-offline-runtime` | 실행 중 외부로 나가는 연결 (정적 검사가 못 보는 층) | DB·모델 필요 |
| `verify-loaded-corpus` | 적재된 코퍼스가 문서가 말하는 규모와 다른 것 | DB 필요 |
| `verify-security-policy` | SECURITY.md 가 안내하는 신고 경로가 닫혀 있는 것 | 토큰 필요 |
| `verify-repo-presentation` | 저장소 페이지에 빈 탭·빠진 설명이 생기는 것 | 토큰 필요 |

각 검사는 자기가 **덮지 못하는 것**도 스스로 말합니다. 예를 들어 `verify-test-counts`
는 통합 127건이 DB·모델을 요구해 CI 에서 재현 불가임을 출력에 적습니다 — 덮지 못하는
것을 덮은 척하지 않습니다.

## 스스로 반증한 것

이 프로젝트는 자기 주장을 무너뜨린 기록을 지우지 않습니다. 검증 비용을 낮추는 것이 목적이기 때문입니다.

1. **스키마 카드의 기여는 재시도를 붙이는 순간 정확도에서 비용으로 이동합니다.** 값 어휘까지 담은 스키마 카드는 재시도가 없을 때 5~7/10 대 2/10으로 갈리지만(+30에서 +50pp), 실패한 SQL을 데이터베이스 카탈로그와 함께 한 번 되먹이면 7~8/10 대 7/10으로 좁혀집니다(0에서 +10pp). 대신 재시도 횟수가 2회 대 6회로 갈립니다. 즉 재시도가 있는 시스템에서 스키마 카드가 사는 근거는 정확도가 아니라 호출 수입니다. 범위로 적는 이유는 16회 반복 실측에서 **세션 안에서는 결과가 완전히 동일한데 세션이 바뀌면 1~2문항이 움직였기** 때문입니다. 단일 실행 수치를 헤드라인으로 쓰지 않습니다.
2. **임베딩 차원을 자른 방식은 공식 지원이 아니었습니다. 다만 손실은 측정했습니다.** 사업자 스키마가 `vector(768)`이라 bge-m3의 1024차원 출력 중 앞 768개만 저장해 왔는데, bge-m3 모델 카드는 dense 1024만 명시하고 차원 축소 학습을 주장하지 않습니다. 즉 이 절단은 모델이 보증한 출력 모드가 아닙니다. 그래서 평가 문항을 8개에서 68개로 늘려 같은 코퍼스에서 대조했습니다. **결과는 1024 원본과 768 절단이 각각 67/68로 동일했고, 서로 다른 문항 하나씩을 놓쳤습니다(McNemar p = 1.0).** 이 코퍼스, 이 표본에서는 절단의 손실이 관측되지 않습니다. 그래도 공식 출력 모드가 아니라는 사실은 그대로이므로 정식 기능으로 주장하지 않고, 다국어 공식 768 모델이 확보되면 다시 대조합니다. 참고로 함께 돌린 영어 전용 768 모델은 같은 한국어 문항에서 25/68에 그쳤습니다.
3. **키워드 검색 레인을 만들었다가 껐습니다.** 밀집과 희소를 함께 쓰는 것이 2026년 표준이라 한국어 정규화 계약과 함께 희소 레인을 구현했는데, 68문항으로 재 보니 융합이 순위를 **떨어뜨렸습니다**(밀집 hit@1 0.868 대 융합 0.706, 규칙 게이트를 걸어도 0.838). 문서가 40건뿐이라 밀집이 이미 천장에 붙어 있고 약한 레인을 같은 가중치로 섞으면 손해만 남습니다. 가중치를 조정하면 나아지겠지만 그건 튜닝 파라미터를 만드는 일이라 이 프로젝트의 전제와 충돌합니다. 그래서 코드는 남기고 기본값만 껐습니다(`KEYWORD_LANE=1`). 만든 것을 전부 켜서 내보내는 것보다 이쪽이 정직합니다.
4. **라우팅 30/30은 in-sample이고, 홀드아웃은 따로 두 벌 잽니다.** 30문항은 사업자가 공개한 예시이고 라우터 어휘를 그 문항을 읽으며 작성했습니다. 어휘가 겹치지 않는 홀드아웃1(템플릿 문형)에서 27/30(0.900), 커버율 1.000, 진짜 오류 0입니다. 문형을 업무 담당자 말투로 바꾼 홀드아웃2에서는 19/30(0.633), 커버율 0.933, 진짜 오류 2로 떨어집니다. **세 숫자를 섞지 않습니다.** 관계 표현은 무한해서 규칙 기반이 어휘로 따라잡을 수 없고, 그래서 개체 타입 쌍을 온톨로지 엣지에 대조하는 방식으로 바꿨습니다. 두 홀드아웃은 각각 결함 진단에 소진돼 더 이상 홀드아웃이 아닙니다(`docs/report.md` §0.14).

## 알려진 한계

- 벡터 평가 문항은 **74개**입니다(2026-07-29 확장, 구 8개). 40개 문서를 모두 덮고 30문항은 키워드를 질문에 노출하지 않는 의미검색 전용입니다. 이 중 71문항이 hit@5 로 채점되고 나머지는 문서 **타입**만 지정한 힌트라 타입 정확도로 봅니다. 그래도 코퍼스가 문서 40건이라 절대 성능을 일반화할 수는 없습니다.
- 7B 모델은 자연어 해석에서 실제 오답을 냅니다. 남은 오답 3건의 원인을 `docs/report.md`에 그대로 적었습니다. 공개된 30문항에 맞춰 프롬프트를 더 손대면 과적합이 됩니다.
- 자동 장애 조치(failover)는 범위 밖입니다. 읽기 엔드포인트의 replica 폴백과 kill drill 로그까지가 검증된 범위입니다.
- CI는 오프라인 단위 테스트와 **검사 13종**(아래 표의 22종 중 데이터셋·DB·모델 없이 도는 것들 — 지표·지표 산문·테스트 수·증거 매니페스트·도구 표면·외부 API·조용한 폴백·데이터셋 재배포·줄바꿈·시연 대본·문서 링크·기여 진입 경로·SBOM 드리프트)을 돌립니다. 데이터베이스와 모델이 필요한 스위트와 드릴은 로컬에서 돌고, 그 원자료를 저장소에 커밋합니다. **CI에서 도는 것처럼 표시하지 않습니다** — 「주장을 지키는 검사」 표의 CI 열이 워크플로와 일치하는지도 검사가 대조합니다. 통합 127단언은 CI가 재현할 수 없지만 미확인은 아닙니다(2026-08-17 실측 127/127, `eval/results/test-counts.json`).

## 프로젝트 구조

```
air-server/          MCP 서버 (TypeScript, air 프레임워크)
  src/router.ts      규칙 기반 3레인 라우터
  src/curator.ts     구조 보존 컨텍스트 큐레이션
  src/graph.ts       지식그래프 탐색
  src/cli/           평가 실행기
docs/                개발보고서, 아키텍처, 모델카드, SBOM, AI 모델 명세
eval/results/        모든 측정의 원자료 JSON
sql/, scripts/       스키마와 운영 스크립트
prototype/           로직 검증용 Python 레퍼런스
```

## 데이터셋

평가에 쓰는 사업자 공개 데이터셋은 배포 조건이 대회 목적 사용으로 한정되어 있어 **저장소에 포함하지 않습니다.** `scripts/fetch-companyx-dataset.sh`가 SHA-256을 검증하며 받아 오고, 출처와 무결성 명세는 `datasets/MANIFEST.md`에 있습니다. 공식 DDL은 한 글자도 바꾸지 않고 적재합니다.

## 기여와 정책

- [CONTRIBUTING.md](CONTRIBUTING.md) 개발 환경, 테스트 계층, PR 규칙
- [SECURITY.md](SECURITY.md) 취약점 비공개 신고 경로
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) Contributor Covenant 2.1
- [docs/roadmap.md](docs/roadmap.md) 개발 로드맵과 범위 밖으로 정한 것
- [docs/publishing.md](docs/publishing.md) 패키지 배포와 레지스트리 등록 절차

## 라이선스

직접 작성한 코드는 **Apache License 2.0**입니다. 제3자 구성요소와 모델의 라이선스는 [NOTICE](NOTICE)와 [docs/sbom.md](docs/sbom.md)에 있습니다. 탑재 모델은 qwen2.5:7b(Apache-2.0)와 bge-m3(MIT)이며 둘 다 오픈웨이트를 로컬에서 구동합니다. 모델 활용 명세는 [docs/ai-model-spec.md](docs/ai-model-spec.md)에 있습니다.

## 참고 문헌

- 전현우, 김태성, 강현 (2026), zenodo 18842478. 컨텍스트 한계효용이 모델에 따라 다르며 Qwen 계열은 풀 컨텍스트에서 유의하게 개선된다는 결과. 큐레이션 설계와 모델 선택의 근거.
- Pylon-7 (2026), zenodo 18808598. 계층별 위험도 정의. 도구의 layer 힌트에 반영.
- Model Context Protocol 명세, pgvector, Ollama 공식 문서.
