# 3분 시연영상 스크립트 (네트워크 OFF 녹화)

## 시연 전 체크리스트 (기능테스트, 2026-10-12~10-28)

외부 심사자가 온라인으로 직접 돌려 보는 기능테스트용이다. 아래 영상 대본과는 따로 쓴다.
채점은 **최종 답이 정답과 같은가** 하나다. 라우팅이 맞아도 답이 틀리면 오답이고, 라우팅이
달라도 답이 맞으면 정답이다(리원에이스 멘토링). 이 순서대로 친다.

```bash
# 1) 스택: db, ollama, 모델 캐시 확인(models 서비스는 한 번 돌고 끝난다)
docker compose up -d
docker compose logs models           # "cached: qwen2.5-coder:7b", "cached: bge-m3" 두 줄
docker compose ps -a models          # Exited (0). 1 이면 모델을 못 받았다(아래 첫 항목)

# 2) 환경: 매 셸마다. companyx 적재는 처음 한 번 npm run companyx:load
export DATABASE_URL=postgresql://postgres:postgres@localhost:5433/mcpdata
export OLLAMA_HOST=http://localhost:11435
export EMBEDDER=ollama                      # 적재와 검색이 같은 bge-m3 를 쓴다. 기본값 hash 로 적재하면 문서 검색이 엉뚱한 조각을 낸다
export DATASET_DIR=/path/to/companyx-v1.0   # 저장소의 datasets 폴더에 풀었으면 필요 없다

# 3) 워밍업: 시연 직전 마지막 준비. 7B 적재(콜드 스타트)를 심사자 대신 치른다
cd air-server && npm run warmup

# 4) 스코어카드: 30문항을 실제 ask 로 돌려 레인별 정답과 지연을 한 화면에
npm run companyx:score               # 빠른 확인은 npm run companyx:score -- --limit 3 (정본을 안 쓴다)

# 5) 장애 상태: DB 끊김, 모델 시간 초과, 빈 결과가 예외 없이 상태로 끝나는지
npm run fault:demo
```

- **모델은 시연 전에 받아 둔다.** 당일 pull 은 온라인에서 멈출 수 있다. `models` 서비스는
  볼륨에 모델이 있으면 네트워크 없이 확인만 하고 끝나고, 없을 때만 받는다. 못 받으면 exit 1 로
  남으므로 `docker compose ps -a` 에서 보인다.
- **워밍업은 한 번이면 된다.** 첫 호출은 7B 를 메모리에 올리느라 느리고 두 번째부터 빠르다.
  워밍업이 찍는 두 값이 그 차이다. 워밍업이 올린 모델은 30분 동안 내려가지 않는다
  (`WARMUP_KEEP_ALIVE`). 모델이 없으면 받을 명령을 알려주고 멈춘다.
- **멈춘 모델이나 DB 앞에서 무한정 기다리지 않는다.** 생성 한 번(`OLLAMA_TIMEOUT_MS`, 기본 110초),
  임베딩 한 번(`OLLAMA_EMBED_TIMEOUT_MS`, 기본 60초), DB 접속(`PG_CONNECT_TIMEOUT_MS`, 기본 15초)에
  마감이 있다. 포트만 열려 있고 응답이 없는 상태에서도 「조회 실패」나 「생성 실패」로 끝난다.
  스코어카드와 장애 시연의 상태 칸은 같은 다섯 가지다: 정상, 부분 실패, 근거 없음, 조회 실패, 생성 실패.
- **채점 규칙**은 `air-server/src/scorecard.ts` 머리말에 있다. LLM 심판 없이 정답 파일
  (`eval/companyx/`)에서 계산한 정답과 최종 답을 대조하고, 확신이 없으면 오답으로 센다.
  스코어카드는 모델을 부르기 전에 30문항의 모범 답은 정답, 기권은 오답으로 가르는지 스스로 점검한다.

<!-- scorecard:begin (node scripts/scorecard-docs.mjs --write 로 생성한다. 손으로 고치지 않는다) -->
**실측** (2026-10-01, `eval/results/companyx-scorecard.json`, 커밋 13fd329). 호스트 AMD Ryzen 5 7500F 6-Core Processor 12스레드, 메모리 32GB, Ollama http://localhost:11435(CPU 추론(적재 모델 VRAM 0)), 모델 qwen2.5-coder:7b, 임베더 ollama:bge-m3@768. ms 는 질문 하나의 `ask()` 벽시계 시간(조회와 생성의 합)이고 컨텍스트 예산은 MCP `ask` 도구 기본값이다.

| 레인 | 최종 답 정답 | 라우트 일치 | 중앙값 ms | p90 ms | 7B 호출 |
|---|---|---|---:|---:|---|
| nl2sql | 10/10 | 10/10 | 14405 | 35237 | 두 번(SQL 생성, 답변). 엔진이 SQL 을 거부하면 수리 한 번 더 |
| vector_search | 8/10 | 10/10 | 8404 | 30711 | 한 번(답변). 조회에 질의 임베딩 한 번 |
| knowledge_graph | 10/10 | 10/10 | 6812 | 11618 | 한 번(답변). 조회는 모델 없는 결정론 순회 |
| 전체 | 28/30 | 30/30 | 10740 | 30711 | |
<!-- scorecard:end -->

## 촬영 전 준비 (그대로 붙여넣는다)

무엇을 보여줄지는 아래 타임코드에 있고, **띄우는 방법은 여기 있다.** 환경변수 하나가
빠지면 데모가 프리플라이트에서 멈추고 그 테이크는 버린다.

```bash
# 1) 스택 (한 번만)
docker compose up -d                       # db → host 5433, ollama → host 11435
docker compose exec -T ollama ollama pull qwen2.5-coder:7b
docker compose exec -T ollama ollama pull bge-m3

# 2) 빌드 (한 번만)
cd air-server && npm ci && node node_modules/typescript/bin/tsc

# 3) 환경 — 매 셸마다
export DATABASE_URL=postgresql://postgres:postgres@localhost:5433/mcpdata
export OLLAMA_HOST=http://localhost:11435
export EMBEDDER=ollama OLLAMA_MODEL=qwen2.5-coder:7b EMBED_MODEL=bge-m3
unset DATASET                              # 남아 있으면 데모가 정당하게 거절한다

# 4) 코퍼스 (한 번만)
npm run companyx:load

# 5) 녹화 — 화면에 섹션 0~7 이 순서대로 찍힌다
#    타임라인 0:22 행과 같은 명령이다. demo:ollama 는 EMBEDDER 를 스스로 박아
#    넣어 셸 상태와 무관하게 같은 결과를 낸다.
npm run demo:ollama
```

**실행 시간 실측(2026-08-18):** 전체 **13.6초**. 그중 섹션 6(온프렘 7B 답변) 한 번이
**9.1초**로, 나머지 일곱 섹션은 합쳐 4.5초다. 3분 영상에 172초가 남으므로 서두를 필요가
없고, 편집에서 잘라 낼 구간은 섹션 6의 대기 하나뿐이다.

**GPU 호스트 Ollama를 쓰면** 그 대기가 685ms로 줄지만 환경이 문서 수치와 달라진다 —
어느 쪽으로 찍든 자막으로 환경을 밝힌다.


> 사전: `docker compose up -d` → `docker compose exec ollama ollama pull qwen2.5-coder:7b` / `bge-m3` → `npm run gen:bench` → `npm run embed:bench:ollama` → `bash scripts/replica-spike.sh` 1회(로그 확보).
>
> `OLLAMA_HOST=http://localhost:11435` (컨테이너 Ollama. 호스트에 Ollama가 떠 있으면 포트가 갈린다). 그 외 명령에는 셸 전용 문법이 없다 — Windows에서도 그대로 된다.
>
> 녹화 직전 **네트워크 차단**(외부 API 없음 증명). 화면 우상단에 네트워크 off + 하드웨어/OS 표시.
>
> 서사 원칙: 리원에이스 미션 언어("복잡한 설정 그만·장애 지점↓·튜닝 없음")를 그대로 되받아, **문제→MCP 해결→증거** 순으로 판다. 기술 나열이 아니라 "왜 이게 운영을 단순하게 만드는가"를 판다.

| 시간 | 화면 | 내레이션 |
|---|---|---|
| 0:00–0:22 | 제목 슬라이드 → "RAG = 복잡한 파이프라인·튜닝 지옥·장애 지점" 도식 → 네트워크 off / `docker compose ps`(db·ollama healthy) | "AI에 외부 지식을 붙이는 기존 RAG는 파이프라인이 복잡하고, 설정이 조금만 틀어져도 성능이 무너지고, 장애 지점이 많습니다. 저희는 이걸 **MCP 규격 하나로** 단순화했습니다. 전 과정 온프렘, 외부 API 0." |
| 0:22–0:45 | `npm run demo:ollama` 실행, 도구 목록 출력 + 라우터를 **연달아 2번** 호출해 동일 결과 | "air 프레임워크 위 **8개 MCP 도구**(route · sql.query · vector.search · retrieve · ask · audit.explain · ontology.search · graph.expand). 도구 선택은 **규칙 기반 라우터** — LLM 호출도, 튜닝 파라미터도 없습니다. 두 번 돌려도 결과가 완전히 같죠. **튜닝 0, 분산 0.** 리원에이스가 말한 '설정 민감성 제거'를 코드로 실증합니다." |
| 0:45–1:03 | 섹션 1–2: SQL 실행 + `admin_secrets` 접근 거부 화면 | "데이터 접근은 읽기전용 최소권한으로 강등됩니다. 쓰기도, 관리자 파일 함수도, 비밀 테이블도 **거부**. 안전한 기본값이 곧 장애·사고 지점을 줄입니다." |
| 1:03–1:25 | 섹션 3: BGE-M3 의미검색, 어휘겹침 0 질의 | "'돈 돌려받고 싶어요'처럼 단어가 하나도 안 겹쳐도 환불·반품 정책을 찾습니다. 어휘 매칭이 아니라 **의미**입니다." |
| 1:25–1:55 | 섹션 4–5 (**핵심**): ontology.search('전자제품')→전자기기, graph.expand, 그리고 **canonical 3-way agreement** 출력(`entity:policy#1001 sources=[graph,vector] rank=1`) | "여기가 차별점입니다. 온톨로지가 '전자제품'을 전자기기로 해소하고, 지식그래프가 정책의 적용 범위를 확장합니다. 그리고 **같은 정책 엔티티가 벡터와 그래프 양쪽에서 나오면 canonical 키로 합쳐집니다.** 여러 갈래가 **합의**하면 그 근거가 위로 올라옵니다 — SQL·벡터·그래프 3-way." |
| 1:55–2:15 | 섹션 6: 온프렘 Qwen2.5-Coder-7B 답변 "전체 주문은 2000건입니다." | "온프렘 7B가 **큐레이션된 컨텍스트에만** 근거해 답합니다. 구조를 안 깨고 담기 때문에 작은 모델도 정확히 답하죠. 근거가 없으면 추측 대신 **거부**합니다." |
| 2:15–2:42 | 섹션 7 장애주입(벡터 브랜치 강제 실패→graceful degradation) + `eval/results/faults.json`(4/4) + `eval/results/replica-spike.log` 스크롤(streaming/kill-drill) | "운영 안정성. 벡터 브랜치를 **죽여도** 크래시 없이 그래프로 부분 컨텍스트를 반환 — no-crash 4/4. 클러스터는 실제 streaming replica로, **primary를 정지시켜도 복제본이 읽기를 계속 서빙**합니다. kill-drill 로그로 증명." |
| 2:42–2:58 | `internal-llm-summary.json`(88/100) + ablation 3행(1%/37%/88%) 표 플래시 | "품질도 실측입니다. **자작 LLM-저지 없이 DB가 채점** — 내부 100문항 **88%**. 그리고 ablation: 구조보존 큐레이션을 빼면 37%로 떨어집니다. **단순화의 핵심 레버가 바로 이 큐레이션**임을 +51%p로 증명했습니다." |
| 2:58–3:00 | repo 트리 + LICENSE(Apache-2.0)/NOTICE/model-cards | "전부 오픈소스 Apache-2.0, raw 증거 전부 동봉. 복잡도는 낮추고, 안정성과 품질은 지킵니다. 감사합니다." |

## 촬영 노트 (서사 강조점)
- **되받기 프레임:** 첫 22초에 리원에이스 미션 문장("복잡·튜닝·장애")을 그대로 되받아 "우리가 그걸 없앴다"로 연결 → 심사자 몰입.
- **차별점 3개만 각인:** ① 튜닝0 결정론(0:22–0:45), ② canonical 3-way 합의(1:25–1:55), ③ 운영안정성+클러스터 kill-drill(2:15–2:42). 나머지는 흐름.
- **정직성이 무기:** "자작 LLM-저지 없이 DB가 채점" "64%는 비교 아님" "production HA는 미주장"을 명시 → 신뢰가 곧 채용 신호.

## 녹화 체크리스트
- [ ] **새 터미널에서 시작한다.** 앞서 평가를 돌렸다면 셸에 `DATASET=companyx` 가 남아 있고,
      그 상태로 데모를 치면 **거절당한다**(실측 exit 1: "이 데모는 bench 시드 전용인데
      DATASET=companyx 로 실행됐다"). 데모가 잘못된 데이터를 보여주지 않으려는 정상 동작이다.
      확인: `echo $DATASET` 이 비어 있어야 한다. 남아 있으면 `unset DATASET`.
- [ ] 네트워크 차단 후 `npm run demo:ollama` 1회 리허설(캐시된 모델로 통과, 20분 내). 기반 데이터나 모델이 없으면 데모가 **성공으로 끝내지 않고** 무엇을 해야 하는지 알리고 멈춘다 — 녹화 전에 이 상태를 없애 둔다.
- [ ] 시드/데모 쿼리만 사용(라이브 7B 할루시네이션 방지).
- [ ] `bash scripts/replica-spike.sh` 사전 1회 → `eval/results/replica-spike.log` 화면 준비.
      **2026-08-17 재확인:** 이 절차를 같은 순서로 실제 스택에서 밟아 전부 재현했다 —
      pg_basebackup 36.7MB 성공, standby `in_recovery=t`, 복제 반영 확인,
      replica 쓰기 거부(`cannot execute INSERT in a read-only transaction`),
      `pg_stat_replication = streaming/async`, **primary 정지 중 replica 가 orders 2000 서빙**,
      재기동 후 2000 복구. 정리 후 부작용 0(pg_hba 잔여 0, replica 컨테이너 없음, probe 없음).
      실행하면 primary 를 잠깐 정지시키므로 녹화 직전보다 **여유 있을 때** 먼저 돌린다.
- [ ] raw 로그(`eval/results/*`, demo stdout) 별도 저장 → 모든 수치 추적 가능.
- [ ] 하드웨어/OS 표시, 네트워크 off 표시 상시 노출.
- [ ] **지연은 환경에 종속된다.** GPU 호스트 Ollama는 중앙값 685ms, GPU 패스스루 없는 컨테이너는 중앙값 10934ms(약 11초, 2026-10-02 정본. 이전 반복 실측은 9.8~18.5초)다. 화면에 뜨는 대기 시간이 문서 수치와 다르면 어느 환경인지 자막으로 밝힌다.
- [ ] 3:00 초과 금지 — 초과 시 0:45–1:03(권한) 또는 1:03–1:25(의미검색)를 압축.
