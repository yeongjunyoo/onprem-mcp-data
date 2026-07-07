# 아키텍처 / 클러스터 토폴로지

온프렘·오프라인 단일 런타임(air-on-TS) 위의 레이어드 MCP 데이터 플랫폼. 모든 추론·임베딩·검색은 로컬에서 수행되며 외부 API를 호출하지 않는다.

## 레이어드 데이터 흐름 (단일 노드)

```
        한국어 질의
            │
            ▼
   ┌──────────────────┐  L3  규칙기반 라우터 route (LLM 호출 0 = 결정론)
   │  route()         │      structured / semantic / hybrid 분류
   └────────┬─────────┘
            │ 병렬 fan-out (Promise.allSettled + branch_errors 감사)
   ┌────────┼────────────────────┬─────────────────────┐
   ▼        ▼                    ▼                     ▼
 sql.query  vector.search    ontology.search        graph.expand     ← L2/L5 MCP 도구
 (mcp_ro)   (pgvector,BGE)   (별칭 해소)             (관계 BFS)
   │        │                    │                     │
   └────────┴──── canonical entity_links 브릿지 ───────┘
            │
            ▼
   ┌──────────────────┐  L4  rrfMergeNamed (named-source 3-way agreement)
   │  RRF merge       │
   └────────┬─────────┘
            ▼
   ┌──────────────────┐  L4  구조보존 큐레이션 TACC (broken_rows=0, 고정 예산)
   │  curator         │
   └────────┬─────────┘
            ▼
   ┌──────────────────┐  L7  ask — 온프렘 Qwen2.5-7B (큐레이션 컨텍스트에만 근거)
   │  answer          │
   └──────────────────┘
```

## 클러스터 / 배포 토폴로지

```
        ┌─────────────────────────────┐
        │   air MCP 서버 (TS, 무상태)   │   N개 수평 확장 가능 (무상태 → 로드밸런서 뒤)
        │  7 MCP 도구 + 플러그인        │
        └───────┬─────────────┬───────┘
       쓰기 경로 │             │ 읽기 경로 (read-only 도구 6개)
       (없음:    │             │  getReadPool()
       전 도구    ▼             ▼
       read-only)┌────────┐   ┌──────────────────────────┐
                 │ Primary│   │ Read endpoint            │
                 │  PG17  │──▶│ READ_DATABASE_URL 설정 시  │
                 │+pgvec  │   │   → 별도 풀(읽기 오프로드)  │
                 └────────┘   │ 미설정 시                  │
                              │   → Primary로 폴백(동일)    │
                              └──────────────────────────┘
```

### 읽기 엔드포인트 폴백 (구현·테스트됨)

- 모든 MCP 도구는 read-only(`readOnlyHint: true`). 읽기 경로는 `getReadPool()`(`src/db.ts`)을 통해 풀을 얻는다.
- `READ_DATABASE_URL`이 **설정되면** 별도 읽기 풀을 생성해 read replica로 부하를 오프로드한다.
- **미설정이면** Primary 풀로 **투명 폴백** → 단일 노드 배포가 무설정으로 동일하게 동작.
- 테스트: `db.test.ts` — (1) 미설정 시 read pool === primary, (2) 설정 시 별도 풀 생성, (3) 그 풀로 SELECT 정상(count=5). `node dist/db.test.js` 22/22.

### 정직한 경계 (NEVER COMPROMISE)

- **검증된 라이브 read-replica spike (실측 로그 `eval/results/replica-spike.log`, 재현 `scripts/replica-spike.sh`):** 실행 중인 primary로부터 `pg_basebackup` hot-standby 구성 → **실제 PostgreSQL streaming replication**(`pg_stat_replication state=streaming`), primary write→replica 3초 내 반영, replica는 **read-only 강제**(`cannot execute INSERT in a read-only transaction`), 앱 `getReadPool()`이 replica로 라우팅(`in_recovery=true`), **kill-drill: primary 정지 중에도 replica가 reads 정상 제공**(orders=2000) → primary 재기동 후 정상. = read 가용성 실증.
- **여전히 단정하지 않는 것:** 자동 promotion/failover 오케스트레이션, 모니터링되는 lag SLA, 멀티노드 부하시험 = production HA 범위(미수행). 본 spike는 수동 1회 실증이며 자동 장애조치가 아니다.
- air 서버는 무상태라 수평 확장은 구조적으로 가능하나, 멀티노드 부하시험 로그는 아직 없다 → "확장 가능(구조)"로만 표기.
