# 붙임1 SBOM (소프트웨어 자재명세서)

> 생성 = `node scripts/sbom.mjs`. 근거 = `air-server/node_modules`에 **실제 설치된** 매니페스트(선언이 아니라 설치 상태).
> 생성 시각 2026-10-20T03:59:00.550Z
> npm 패키지 20개(직접 6 / 전이 14) + 런타임 구성요소 6개.
> 라이선스 분포: MIT 16 · Apache-2.0 2 · ISC 2.
> `@airmcp-dev/core` 0.5.2-patched.1 = npm 배포본 0.5.2(`sha512-QFQr8kPg6Q79xwo2xVBcZ42nqdWTdvzhkmOtbyPdtZNMceWZr77y+MGdLqwmc6olL5q+F26KtWBVo9uh8pxzeA==`)에 패치 3개(001-air-prs-3-5-7-9-11, 002-ping-from-air-main-42cf9e0, 003-sse-origin)를 얹은 `air-server/vendor/airmcp-dev-core-0.5.2-patched.1.tgz`(`sha512-X/5s8kYLmiJqQNwNTRY7+dv0ORdL5Nyrc+X+7D02gKueqILpaNQ10SorKkv33QUKm7vpLvSmeLwyy8vFhG+LYw==`). 만드는 법과 지우는 때는 `docs/air-patch.md`.
> 직접 작성한 소스코드 라이선스 = **Apache-2.0**(OSI 인증, 레포 `LICENSE`). 카피레프트(GPL/AGPL/LGPL/MPL/EPL/CDDL/SSPL/OSL/EUPL) 의존성 **0건**, 라이선스 미표기 **0건** → 라이선스 충돌 없음. 이 두 수치는 설치 트리를 훑어 **검사한 결과**이며, 위반이 있으면 이 파일 생성이 실패한다(`node scripts/sbom.mjs`).

## 1. 직접 의존성 및 런타임 구성요소

| 번호 | 라이브러리명 | 버전 | 라이선스 | 공식 저장소 URL | 사용 목적 및 주요 기능 |
| --- | --- | --- | --- | --- | --- |
| 1 | @airmcp-dev/core | 0.5.2-patched.1 | Apache-2.0 | https://github.com/airmcp-dev/air | MCP 서버 프레임워크(air). 프로토콜 엔진, 도구 등록, 입력 검증, stdio/SSE/HTTP 전송, 라이프사이클 관리. npm 배포본 0.5.2 에 상류 수정 패치를 얹은 air-server/vendor 의 tarball 이다(docs/air-patch.md) |
| 2 | @types/node | 26.6.5 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped | 타입 정의(개발 전용) |
| 3 | @types/pg | 8.23.1 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped | 타입 정의(개발 전용) |
| 4 | pg | 8.23.1 | MIT | https://github.com/brianc/node-postgres | PostgreSQL 클라이언트. 관계형 조회, pgvector 유사도 검색, 읽기 엔드포인트 풀링 |
| 5 | typescript | 5.9.3 | Apache-2.0 | https://github.com/microsoft/TypeScript | 빌드 도구(개발 전용). 타입 검사 및 dist 트랜스파일 |
| 6 | zod | 3.25.76 | MIT | https://github.com/colinhacks/zod | 도구 입력과 route 출력의 스키마(air 가 검증과 JSON Schema 변환에 쓴다) |
| 7 | PostgreSQL | 16 | PostgreSQL License (OSI 인증) | https://github.com/postgres/postgres | 관계형 저장소와 온프렘 클러스터(primary, replica) |
| 8 | pgvector | 0.8.6 | PostgreSQL License (OSI 인증) | https://github.com/pgvector/pgvector | 벡터 인덱스와 코사인 유사도 검색 |
| 9 | Ollama | 0.32.14 | MIT | https://github.com/ollama/ollama | 로컬 LLM과 임베딩 런타임(외부 API 호출 없음) |
| 10 | qwen2.5-coder:7b | 7B | Apache-2.0 (오픈웨이트) | https://huggingface.co/Qwen/Qwen2.5-Coder-7B-Instruct | 질의 의도 분해와 답변 생성(로컬 추론) |
| 11 | bge-m3 | 567M | MIT (오픈웨이트) | https://huggingface.co/BAAI/bge-m3 | 문서와 질의 임베딩(1024차원, 로컬 추론) |
| 12 | Node.js | 20 LTS | MIT | https://github.com/nodejs/node | MCP 서버 런타임 |

## 2. 전이 의존성 (자동 수집)

| 번호 | 라이브러리명 | 버전 | 라이선스 | 공식 저장소 URL |
| --- | --- | --- | --- | --- |
| 1 | pg-cloudflare | 1.4.1 | MIT | https://github.com/brianc/node-postgres |
| 2 | pg-connection-string | 2.14.1 | MIT | https://github.com/brianc/node-postgres |
| 3 | pg-int8 | 1.0.1 | ISC | https://github.com/charmander/pg-int8 |
| 4 | pg-pool | 3.14.0 | MIT | https://github.com/brianc/node-postgres |
| 5 | pg-protocol | 1.16.1 | MIT | https://github.com/brianc/node-postgres |
| 6 | pg-types | 2.2.0 | MIT | https://github.com/brianc/node-pg-types |
| 7 | pgpass | 1.0.5 | MIT | https://github.com/hoegaarden/pgpass |
| 8 | postgres-array | 2.0.0 | MIT | https://github.com/bendrucker/postgres-array |
| 9 | postgres-bytea | 1.0.1 | MIT | https://github.com/bendrucker/postgres-bytea |
| 10 | postgres-date | 1.0.7 | MIT | https://github.com/bendrucker/postgres-date |
| 11 | postgres-interval | 1.2.0 | MIT | https://github.com/bendrucker/postgres-interval |
| 12 | split2 | 4.2.0 | ISC | https://github.com/mcollina/split2 |
| 13 | undici-types | 8.9.0 | MIT | https://github.com/nodejs/undici |
| 14 | xtend | 4.0.2 | MIT | https://github.com/Raynos/xtend |
