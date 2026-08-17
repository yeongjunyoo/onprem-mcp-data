# 3분 시연영상 스크립트 (네트워크 OFF 녹화)

> 사전: `docker compose up -d` → `docker compose exec ollama ollama pull qwen2.5:7b` / `bge-m3` → `npm run gen:bench` → `npm run embed:bench:ollama` → `bash scripts/replica-spike.sh` 1회(로그 확보).
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
| 1:55–2:15 | 섹션 6: 온프렘 Qwen2.5-7B 답변 "전체 주문은 2000건입니다." | "온프렘 7B가 **큐레이션된 컨텍스트에만** 근거해 답합니다. 구조를 안 깨고 담기 때문에 작은 모델도 정확히 답하죠. 근거가 없으면 추측 대신 **거부**합니다." |
| 2:15–2:42 | 섹션 7 장애주입(벡터 브랜치 강제 실패→graceful degradation) + `eval/results/faults.json`(4/4) + `eval/results/replica-spike.log` 스크롤(streaming/kill-drill) | "운영 안정성. 벡터 브랜치를 **죽여도** 크래시 없이 그래프로 부분 컨텍스트를 반환 — no-crash 4/4. 클러스터는 실제 streaming replica로, **primary를 정지시켜도 복제본이 읽기를 계속 서빙**합니다. kill-drill 로그로 증명." |
| 2:42–2:58 | `internal-llm-summary.json`(83/100) + ablation 3행(1%/30%/83%) 표 플래시 | "품질도 실측입니다. **자작 LLM-저지 없이 DB가 채점** — 내부 100문항 **83%**. 그리고 ablation: 구조보존 큐레이션을 빼면 30%로 떨어집니다. **단순화의 핵심 레버가 바로 이 큐레이션**임을 +53%p로 증명했습니다." |
| 2:58–3:00 | repo 트리 + LICENSE(Apache-2.0)/NOTICE/model-cards | "전부 오픈소스 Apache-2.0, raw 증거 전부 동봉. 복잡도는 낮추고, 안정성과 품질은 지킵니다. 감사합니다." |

## 촬영 노트 (서사 강조점)
- **되받기 프레임:** 첫 22초에 리원에이스 미션 문장("복잡·튜닝·장애")을 그대로 되받아 "우리가 그걸 없앴다"로 연결 → 심사자 몰입.
- **차별점 3개만 각인:** ① 튜닝0 결정론(0:22–0:45), ② canonical 3-way 합의(1:25–1:55), ③ 운영안정성+클러스터 kill-drill(2:15–2:42). 나머지는 흐름.
- **정직성이 무기:** "자작 LLM-저지 없이 DB가 채점" "64%는 비교 아님" "production HA는 미주장"을 명시 → 신뢰가 곧 채용 신호.

## 녹화 체크리스트
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
- [ ] **지연은 환경에 종속된다.** GPU 호스트 Ollama는 중앙값 864ms, GPU 패스스루 없는 컨테이너는 약 12초다. 화면에 뜨는 대기 시간이 문서 수치와 다르면 어느 환경인지 자막으로 밝힌다.
- [ ] 3:00 초과 금지 — 초과 시 0:45–1:03(권한) 또는 1:03–1:25(의미검색)를 압축.
