# 붙임1 SBOM (소프트웨어 자재명세서)

> 생성 = `node scripts/sbom.mjs`. 근거 = `air-server/node_modules`에 **실제 설치된** 매니페스트(선언이 아니라 설치 상태).
> 생성 시각 2026-07-29T11:35:43.749Z
> npm 패키지 110개(직접 5 / 전이 105) + 런타임 구성요소 6개.
> 라이선스 분포: MIT 96 · ISC 9 · Apache-2.0 2 · BSD-3-Clause 2 · BSD-2-Clause 1.
> 직접 작성한 소스코드 라이선스 = **Apache-2.0**(OSI 인증, 레포 `LICENSE`). 카피레프트(GPL/AGPL/LGPL) 의존성 **0건** → 라이선스 충돌 없음.

## 1. 직접 의존성 및 런타임 구성요소

| 번호 | 라이브러리명 | 버전 | 라이선스 | 공식 저장소 URL | 사용 목적 및 주요 기능 |
| --- | --- | --- | --- | --- | --- |
| 1 | @airmcp-dev/core | 0.2.0 | Apache-2.0 | https://github.com/airmcp-dev/air | MCP 서버 프레임워크(air). 도구 등록, transport, 라이프사이클 관리 |
| 2 | @types/node | 26.0.1 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped | 타입 정의(개발 전용) |
| 3 | @types/pg | 8.20.0 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped | 타입 정의(개발 전용) |
| 4 | pg | 8.22.0 | MIT | https://github.com/brianc/node-postgres | PostgreSQL 클라이언트. 관계형 조회, pgvector 유사도 검색, 읽기 엔드포인트 풀링 |
| 5 | typescript | 5.9.3 | Apache-2.0 | https://github.com/microsoft/TypeScript | 빌드 도구(개발 전용). 타입 검사 및 dist 트랜스파일 |
| 6 | PostgreSQL | 16 | PostgreSQL License (OSI 인증) | https://github.com/postgres/postgres | 관계형 저장소와 온프렘 클러스터(primary, replica) |
| 7 | pgvector | 0.6.0 | PostgreSQL License (OSI 인증) | https://github.com/pgvector/pgvector | 벡터 인덱스와 코사인 유사도 검색 |
| 8 | Ollama | 0.32.4 | MIT | https://github.com/ollama/ollama | 로컬 LLM과 임베딩 런타임(외부 API 호출 없음) |
| 9 | qwen2.5:7b | 7B | Apache-2.0 (오픈웨이트) | https://huggingface.co/Qwen/Qwen2.5-7B-Instruct | 질의 의도 분해와 답변 생성(로컬 추론) |
| 10 | bge-m3 | 567M | MIT (오픈웨이트) | https://huggingface.co/BAAI/bge-m3 | 문서와 질의 임베딩(1024차원, 로컬 추론) |
| 11 | Node.js | 20 LTS | MIT | https://github.com/nodejs/node | MCP 서버 런타임 |

## 2. 전이 의존성 (자동 수집)

| 번호 | 라이브러리명 | 버전 | 라이선스 | 공식 저장소 URL |
| --- | --- | --- | --- | --- |
| 1 | @hono/node-server | 1.19.14 | MIT | https://github.com/honojs/node-server |
| 2 | @modelcontextprotocol/sdk | 1.29.0 | MIT | https://github.com/modelcontextprotocol/typescript-sdk |
| 3 | accepts | 2.0.0 | MIT | https://github.com/jshttp/accepts |
| 4 | ajv | 8.20.0 | MIT | https://github.com/ajv-validator/ajv |
| 5 | ajv-formats | 3.0.1 | MIT | https://github.com/ajv-validator/ajv-formats |
| 6 | body-parser | 2.3.0 | MIT | https://github.com/expressjs/body-parser |
| 7 | bytes | 3.1.2 | MIT | https://github.com/visionmedia/bytes.js |
| 8 | call-bind-apply-helpers | 1.0.2 | MIT | https://github.com/ljharb/call-bind-apply-helpers |
| 9 | call-bound | 1.0.4 | MIT | https://github.com/ljharb/call-bound |
| 10 | content-disposition | 1.1.0 | MIT | https://github.com/jshttp/content-disposition |
| 11 | content-type | 1.0.5 | MIT | https://github.com/jshttp/content-type |
| 12 | cookie | 0.7.2 | MIT | https://github.com/jshttp/cookie |
| 13 | cookie-signature | 1.2.2 | MIT | https://github.com/visionmedia/node-cookie-signature |
| 14 | cors | 2.8.6 | MIT | https://github.com/expressjs/cors |
| 15 | cross-spawn | 7.0.6 | MIT | https://github.com/moxystudio/node-cross-spawn |
| 16 | debug | 4.4.3 | MIT | https://github.com/debug-js/debug |
| 17 | depd | 2.0.0 | MIT | https://github.com/dougwilson/nodejs-depd |
| 18 | dunder-proto | 1.0.1 | MIT | https://github.com/es-shims/dunder-proto |
| 19 | ee-first | 1.1.1 | MIT | https://github.com/jonathanong/ee-first |
| 20 | encodeurl | 2.0.0 | MIT | https://github.com/pillarjs/encodeurl |
| 21 | es-define-property | 1.0.1 | MIT | https://github.com/ljharb/es-define-property |
| 22 | es-errors | 1.3.0 | MIT | https://github.com/ljharb/es-errors |
| 23 | es-object-atoms | 1.1.2 | MIT | https://github.com/ljharb/es-object-atoms |
| 24 | escape-html | 1.0.3 | MIT | https://github.com/component/escape-html |
| 25 | etag | 1.8.1 | MIT | https://github.com/jshttp/etag |
| 26 | eventsource | 3.0.7 | MIT | https://git@github.com/EventSource/eventsource |
| 27 | eventsource-parser | 3.1.0 | MIT | https://github.com/rexxars/eventsource-parser |
| 28 | express | 5.2.1 | MIT | https://github.com/expressjs/express |
| 29 | express-rate-limit | 8.5.2 | MIT | https://github.com/express-rate-limit/express-rate-limit |
| 30 | fast-deep-equal | 3.1.3 | MIT | https://github.com/epoberezkin/fast-deep-equal |
| 31 | fast-uri | 3.1.3 | BSD-3-Clause | https://github.com/fastify/fast-uri |
| 32 | finalhandler | 2.1.1 | MIT | https://github.com/pillarjs/finalhandler |
| 33 | forwarded | 0.2.0 | MIT | https://github.com/jshttp/forwarded |
| 34 | fresh | 2.0.0 | MIT | https://github.com/jshttp/fresh |
| 35 | function-bind | 1.1.2 | MIT | https://github.com/Raynos/function-bind |
| 36 | get-intrinsic | 1.3.0 | MIT | https://github.com/ljharb/get-intrinsic |
| 37 | get-proto | 1.0.1 | MIT | https://github.com/ljharb/get-proto |
| 38 | gopd | 1.2.0 | MIT | https://github.com/ljharb/gopd |
| 39 | has-symbols | 1.1.0 | MIT | https://github.com/inspect-js/has-symbols |
| 40 | hasown | 2.0.4 | MIT | https://github.com/inspect-js/hasOwn |
| 41 | hono | 4.12.27 | MIT | https://github.com/honojs/hono |
| 42 | http-errors | 2.0.1 | MIT | https://github.com/jshttp/http-errors |
| 43 | iconv-lite | 0.7.2 | MIT | https://github.com/pillarjs/iconv-lite |
| 44 | inherits | 2.0.4 | ISC | https://github.com/isaacs/inherits |
| 45 | ip-address | 10.2.0 | MIT | https://github.com/beaugunderson/ip-address |
| 46 | ipaddr.js | 1.9.1 | MIT | https://github.com/whitequark/ipaddr.js |
| 47 | is-promise | 4.0.0 | MIT | https://github.com/then/is-promise |
| 48 | isexe | 2.0.0 | ISC | https://github.com/isaacs/isexe |
| 49 | jose | 6.2.3 | MIT | https://github.com/panva/jose |
| 50 | json-schema-traverse | 1.0.0 | MIT | https://github.com/epoberezkin/json-schema-traverse |
| 51 | json-schema-typed | 8.0.2 | BSD-2-Clause | https://github.com/RemyRylan/json-schema-typed |
| 52 | math-intrinsics | 1.1.0 | MIT | https://github.com/es-shims/math-intrinsics |
| 53 | media-typer | 1.1.0 | MIT | https://github.com/jshttp/media-typer |
| 54 | merge-descriptors | 2.0.0 | MIT | https://github.com/sindresorhus/merge-descriptors |
| 55 | mime-db | 1.54.0 | MIT | https://github.com/jshttp/mime-db |
| 56 | mime-types | 3.0.2 | MIT | https://github.com/jshttp/mime-types |
| 57 | ms | 2.1.3 | MIT | https://github.com/vercel/ms |
| 58 | negotiator | 1.0.0 | MIT | https://github.com/jshttp/negotiator |
| 59 | object-assign | 4.1.1 | MIT | https://github.com/sindresorhus/object-assign |
| 60 | object-inspect | 1.13.4 | MIT | https://github.com/inspect-js/object-inspect |
| 61 | on-finished | 2.4.1 | MIT | https://github.com/jshttp/on-finished |
| 62 | once | 1.4.0 | ISC | https://github.com/isaacs/once |
| 63 | parseurl | 1.3.3 | MIT | https://github.com/pillarjs/parseurl |
| 64 | path-key | 3.1.1 | MIT | https://github.com/sindresorhus/path-key |
| 65 | path-to-regexp | 8.4.2 | MIT | https://github.com/pillarjs/path-to-regexp |
| 66 | pg-cloudflare | 1.4.0 | MIT | https://github.com/brianc/node-postgres |
| 67 | pg-connection-string | 2.14.0 | MIT | https://github.com/brianc/node-postgres |
| 68 | pg-int8 | 1.0.1 | ISC | https://github.com/charmander/pg-int8 |
| 69 | pg-pool | 3.14.0 | MIT | https://github.com/brianc/node-postgres |
| 70 | pg-protocol | 1.15.0 | MIT | https://github.com/brianc/node-postgres |
| 71 | pg-types | 2.2.0 | MIT | https://github.com/brianc/node-pg-types |
| 72 | pgpass | 1.0.5 | MIT | https://github.com/hoegaarden/pgpass |
| 73 | pkce-challenge | 5.0.1 | MIT | https://github.com/crouchcd/pkce-challenge |
| 74 | postgres-array | 2.0.0 | MIT | https://github.com/bendrucker/postgres-array |
| 75 | postgres-bytea | 1.0.1 | MIT | https://github.com/bendrucker/postgres-bytea |
| 76 | postgres-date | 1.0.7 | MIT | https://github.com/bendrucker/postgres-date |
| 77 | postgres-interval | 1.2.0 | MIT | https://github.com/bendrucker/postgres-interval |
| 78 | proxy-addr | 2.0.7 | MIT | https://github.com/jshttp/proxy-addr |
| 79 | qs | 6.15.3 | BSD-3-Clause | https://github.com/ljharb/qs |
| 80 | range-parser | 1.3.0 | MIT | https://github.com/jshttp/range-parser |
| 81 | raw-body | 3.0.2 | MIT | https://github.com/stream-utils/raw-body |
| 82 | require-from-string | 2.0.2 | MIT | https://github.com/floatdrop/require-from-string |
| 83 | router | 2.2.0 | MIT | https://github.com/pillarjs/router |
| 84 | safer-buffer | 2.1.2 | MIT | https://github.com/ChALkeR/safer-buffer |
| 85 | send | 1.2.1 | MIT | https://github.com/pillarjs/send |
| 86 | serve-static | 2.2.1 | MIT | https://github.com/expressjs/serve-static |
| 87 | setprototypeof | 1.2.0 | ISC | https://github.com/wesleytodd/setprototypeof |
| 88 | shebang-command | 2.0.0 | MIT | https://github.com/kevva/shebang-command |
| 89 | shebang-regex | 3.0.0 | MIT | https://github.com/sindresorhus/shebang-regex |
| 90 | side-channel | 1.1.1 | MIT | https://github.com/ljharb/side-channel |
| 91 | side-channel-list | 1.0.1 | MIT | https://github.com/ljharb/side-channel-list |
| 92 | side-channel-map | 1.0.1 | MIT | https://github.com/ljharb/side-channel-map |
| 93 | side-channel-weakmap | 1.0.2 | MIT | https://github.com/ljharb/side-channel-weakmap |
| 94 | split2 | 4.2.0 | ISC | https://github.com/mcollina/split2 |
| 95 | statuses | 2.0.2 | MIT | https://github.com/jshttp/statuses |
| 96 | toidentifier | 1.0.1 | MIT | https://github.com/component/toidentifier |
| 97 | type-is | 2.1.0 | MIT | https://github.com/jshttp/type-is |
| 98 | undici-types | 8.3.0 | MIT | https://github.com/nodejs/undici |
| 99 | unpipe | 1.0.0 | MIT | https://github.com/stream-utils/unpipe |
| 100 | vary | 1.1.2 | MIT | https://github.com/jshttp/vary |
| 101 | which | 2.0.2 | ISC | https://github.com/isaacs/node-which |
| 102 | wrappy | 1.0.2 | ISC | https://github.com/npm/wrappy |
| 103 | xtend | 4.0.2 | MIT | https://github.com/Raynos/xtend |
| 104 | zod | 3.25.76 | MIT | https://github.com/colinhacks/zod |
| 105 | zod-to-json-schema | 3.25.2 | ISC | https://github.com/StefanTerdell/zod-to-json-schema |
