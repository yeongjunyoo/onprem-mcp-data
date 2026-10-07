# 붙임1 SBOM (소프트웨어 자재명세서)

> 생성 = `node scripts/sbom.mjs`. 근거 = `air-server/node_modules`에 **실제 설치된** 매니페스트(선언이 아니라 설치 상태).
> 생성 시각 2026-10-07T06:59:43.662Z
> npm 패키지 110개(직접 6 / 전이 104) + 런타임 구성요소 6개.
> 라이선스 분포: MIT 96 · ISC 9 · Apache-2.0 2 · BSD-3-Clause 2 · BSD-2-Clause 1.
> 직접 작성한 소스코드 라이선스 = **Apache-2.0**(OSI 인증, 레포 `LICENSE`). 카피레프트(GPL/AGPL/LGPL/MPL/EPL/CDDL/SSPL/OSL/EUPL) 의존성 **0건**, 라이선스 미표기 **0건** → 라이선스 충돌 없음. 이 두 수치는 설치 트리를 훑어 **검사한 결과**이며, 위반이 있으면 이 파일 생성이 실패한다(`node scripts/sbom.mjs`).

## 1. 직접 의존성 및 런타임 구성요소

| 번호 | 라이브러리명 | 버전 | 라이선스 | 공식 저장소 URL | 사용 목적 및 주요 기능 |
| --- | --- | --- | --- | --- | --- |
| 1 | @airmcp-dev/core | 0.3.0 | Apache-2.0 | https://github.com/airmcp-dev/air | MCP 서버 프레임워크(air). 도구 등록, transport, 라이프사이클 관리 |
| 2 | @modelcontextprotocol/sdk | 1.31.0 | MIT | https://github.com/modelcontextprotocol/typescript-sdk | MCP 공식 TypeScript SDK. 프롬프트 인자 검증(promptargs.ts)이 직접 쓰고 air 도 이 위에서 동작 |
| 3 | @types/node | 26.4.1 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped | 타입 정의(개발 전용) |
| 4 | @types/pg | 8.23.1 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped | 타입 정의(개발 전용) |
| 5 | pg | 8.23.0 | MIT | https://github.com/brianc/node-postgres | PostgreSQL 클라이언트. 관계형 조회, pgvector 유사도 검색, 읽기 엔드포인트 풀링 |
| 6 | typescript | 5.9.3 | Apache-2.0 | https://github.com/microsoft/TypeScript | 빌드 도구(개발 전용). 타입 검사 및 dist 트랜스파일 |
| 7 | PostgreSQL | 16 | PostgreSQL License (OSI 인증) | https://github.com/postgres/postgres | 관계형 저장소와 온프렘 클러스터(primary, replica) |
| 8 | pgvector | 0.8.6 | PostgreSQL License (OSI 인증) | https://github.com/pgvector/pgvector | 벡터 인덱스와 코사인 유사도 검색 |
| 9 | Ollama | 0.32.14 | MIT | https://github.com/ollama/ollama | 로컬 LLM과 임베딩 런타임(외부 API 호출 없음) |
| 10 | qwen2.5-coder:7b | 7B | Apache-2.0 (오픈웨이트) | https://huggingface.co/Qwen/Qwen2.5-Coder-7B-Instruct | 질의 의도 분해와 답변 생성(로컬 추론) |
| 11 | bge-m3 | 567M | MIT (오픈웨이트) | https://huggingface.co/BAAI/bge-m3 | 문서와 질의 임베딩(1024차원, 로컬 추론) |
| 12 | Node.js | 20 LTS | MIT | https://github.com/nodejs/node | MCP 서버 런타임 |

## 2. 전이 의존성 (자동 수집)

| 번호 | 라이브러리명 | 버전 | 라이선스 | 공식 저장소 URL |
| --- | --- | --- | --- | --- |
| 1 | @hono/node-server | 2.1.1 | MIT | https://github.com/honojs/node-server |
| 2 | accepts | 2.0.0 | MIT | https://github.com/jshttp/accepts |
| 3 | ajv | 8.20.0 | MIT | https://github.com/ajv-validator/ajv |
| 4 | ajv-formats | 3.0.1 | MIT | https://github.com/ajv-validator/ajv-formats |
| 5 | body-parser | 2.3.0 | MIT | https://github.com/expressjs/body-parser |
| 6 | bytes | 3.1.2 | MIT | https://github.com/visionmedia/bytes.js |
| 7 | call-bind-apply-helpers | 1.0.2 | MIT | https://github.com/ljharb/call-bind-apply-helpers |
| 8 | call-bound | 1.0.4 | MIT | https://github.com/ljharb/call-bound |
| 9 | content-disposition | 1.1.0 | MIT | https://github.com/jshttp/content-disposition |
| 10 | content-type | 1.0.5 | MIT | https://github.com/jshttp/content-type |
| 11 | cookie | 0.7.2 | MIT | https://github.com/jshttp/cookie |
| 12 | cookie-signature | 1.2.2 | MIT | https://github.com/visionmedia/node-cookie-signature |
| 13 | cors | 2.8.6 | MIT | https://github.com/expressjs/cors |
| 14 | cross-spawn | 7.0.6 | MIT | https://github.com/moxystudio/node-cross-spawn |
| 15 | debug | 4.4.3 | MIT | https://github.com/debug-js/debug |
| 16 | depd | 2.0.0 | MIT | https://github.com/dougwilson/nodejs-depd |
| 17 | dunder-proto | 1.0.1 | MIT | https://github.com/es-shims/dunder-proto |
| 18 | ee-first | 1.1.1 | MIT | https://github.com/jonathanong/ee-first |
| 19 | encodeurl | 2.0.0 | MIT | https://github.com/pillarjs/encodeurl |
| 20 | es-define-property | 1.0.1 | MIT | https://github.com/ljharb/es-define-property |
| 21 | es-errors | 1.3.0 | MIT | https://github.com/ljharb/es-errors |
| 22 | es-object-atoms | 1.1.2 | MIT | https://github.com/ljharb/es-object-atoms |
| 23 | escape-html | 1.0.3 | MIT | https://github.com/component/escape-html |
| 24 | etag | 1.8.1 | MIT | https://github.com/jshttp/etag |
| 25 | eventsource | 3.0.7 | MIT | https://github.com/EventSource/eventsource |
| 26 | eventsource-parser | 3.1.0 | MIT | https://github.com/rexxars/eventsource-parser |
| 27 | express | 5.2.1 | MIT | https://github.com/expressjs/express |
| 28 | express-rate-limit | 8.5.2 | MIT | https://github.com/express-rate-limit/express-rate-limit |
| 29 | fast-deep-equal | 3.1.3 | MIT | https://github.com/epoberezkin/fast-deep-equal |
| 30 | fast-uri | 4.2.1 | BSD-3-Clause | https://github.com/fastify/fast-uri |
| 31 | finalhandler | 2.1.1 | MIT | https://github.com/pillarjs/finalhandler |
| 32 | forwarded | 0.2.0 | MIT | https://github.com/jshttp/forwarded |
| 33 | fresh | 2.0.0 | MIT | https://github.com/jshttp/fresh |
| 34 | function-bind | 1.1.2 | MIT | https://github.com/Raynos/function-bind |
| 35 | get-intrinsic | 1.3.0 | MIT | https://github.com/ljharb/get-intrinsic |
| 36 | get-proto | 1.0.1 | MIT | https://github.com/ljharb/get-proto |
| 37 | gopd | 1.2.0 | MIT | https://github.com/ljharb/gopd |
| 38 | has-symbols | 1.1.0 | MIT | https://github.com/inspect-js/has-symbols |
| 39 | hasown | 2.0.4 | MIT | https://github.com/inspect-js/hasOwn |
| 40 | hono | 4.13.11 | MIT | https://github.com/honojs/hono |
| 41 | http-errors | 2.0.1 | MIT | https://github.com/jshttp/http-errors |
| 42 | iconv-lite | 0.7.2 | MIT | https://github.com/pillarjs/iconv-lite |
| 43 | inherits | 2.0.4 | ISC | https://github.com/isaacs/inherits |
| 44 | ip-address | 10.7.2 | MIT | https://github.com/beaugunderson/ip-address |
| 45 | ipaddr.js | 1.9.1 | MIT | https://github.com/whitequark/ipaddr.js |
| 46 | is-promise | 4.0.0 | MIT | https://github.com/then/is-promise |
| 47 | isexe | 2.0.0 | ISC | https://github.com/isaacs/isexe |
| 48 | jose | 6.2.3 | MIT | https://github.com/panva/jose |
| 49 | json-schema-traverse | 1.0.0 | MIT | https://github.com/epoberezkin/json-schema-traverse |
| 50 | json-schema-typed | 8.0.2 | BSD-2-Clause | https://github.com/RemyRylan/json-schema-typed |
| 51 | math-intrinsics | 1.1.0 | MIT | https://github.com/es-shims/math-intrinsics |
| 52 | media-typer | 1.1.0 | MIT | https://github.com/jshttp/media-typer |
| 53 | merge-descriptors | 2.0.0 | MIT | https://github.com/sindresorhus/merge-descriptors |
| 54 | mime-db | 1.54.0 | MIT | https://github.com/jshttp/mime-db |
| 55 | mime-types | 3.0.2 | MIT | https://github.com/jshttp/mime-types |
| 56 | ms | 2.1.3 | MIT | https://github.com/vercel/ms |
| 57 | negotiator | 1.0.0 | MIT | https://github.com/jshttp/negotiator |
| 58 | object-assign | 4.1.1 | MIT | https://github.com/sindresorhus/object-assign |
| 59 | object-inspect | 1.13.4 | MIT | https://github.com/inspect-js/object-inspect |
| 60 | on-finished | 2.4.1 | MIT | https://github.com/jshttp/on-finished |
| 61 | once | 1.4.0 | ISC | https://github.com/isaacs/once |
| 62 | parseurl | 1.3.3 | MIT | https://github.com/pillarjs/parseurl |
| 63 | path-key | 3.1.1 | MIT | https://github.com/sindresorhus/path-key |
| 64 | path-to-regexp | 8.4.2 | MIT | https://github.com/pillarjs/path-to-regexp |
| 65 | pg-cloudflare | 1.4.0 | MIT | https://github.com/brianc/node-postgres |
| 66 | pg-connection-string | 2.14.0 | MIT | https://github.com/brianc/node-postgres |
| 67 | pg-int8 | 1.0.1 | ISC | https://github.com/charmander/pg-int8 |
| 68 | pg-pool | 3.14.0 | MIT | https://github.com/brianc/node-postgres |
| 69 | pg-protocol | 1.16.0 | MIT | https://github.com/brianc/node-postgres |
| 70 | pg-types | 2.2.0 | MIT | https://github.com/brianc/node-pg-types |
| 71 | pgpass | 1.0.5 | MIT | https://github.com/hoegaarden/pgpass |
| 72 | pkce-challenge | 5.0.1 | MIT | https://github.com/crouchcd/pkce-challenge |
| 73 | postgres-array | 2.0.0 | MIT | https://github.com/bendrucker/postgres-array |
| 74 | postgres-bytea | 1.0.1 | MIT | https://github.com/bendrucker/postgres-bytea |
| 75 | postgres-date | 1.0.7 | MIT | https://github.com/bendrucker/postgres-date |
| 76 | postgres-interval | 1.2.0 | MIT | https://github.com/bendrucker/postgres-interval |
| 77 | proxy-addr | 2.0.8 | MIT | https://github.com/jshttp/proxy-addr |
| 78 | qs | 6.16.0 | BSD-3-Clause | https://github.com/ljharb/qs |
| 79 | range-parser | 1.3.0 | MIT | https://github.com/jshttp/range-parser |
| 80 | raw-body | 3.0.2 | MIT | https://github.com/stream-utils/raw-body |
| 81 | require-from-string | 2.0.2 | MIT | https://github.com/floatdrop/require-from-string |
| 82 | router | 2.2.0 | MIT | https://github.com/pillarjs/router |
| 83 | safer-buffer | 2.1.2 | MIT | https://github.com/ChALkeR/safer-buffer |
| 84 | send | 1.2.1 | MIT | https://github.com/pillarjs/send |
| 85 | serve-static | 2.2.1 | MIT | https://github.com/expressjs/serve-static |
| 86 | setprototypeof | 1.2.0 | ISC | https://github.com/wesleytodd/setprototypeof |
| 87 | shebang-command | 2.0.0 | MIT | https://github.com/kevva/shebang-command |
| 88 | shebang-regex | 3.0.0 | MIT | https://github.com/sindresorhus/shebang-regex |
| 89 | side-channel | 1.1.1 | MIT | https://github.com/ljharb/side-channel |
| 90 | side-channel-list | 1.0.1 | MIT | https://github.com/ljharb/side-channel-list |
| 91 | side-channel-map | 1.0.1 | MIT | https://github.com/ljharb/side-channel-map |
| 92 | side-channel-weakmap | 1.0.2 | MIT | https://github.com/ljharb/side-channel-weakmap |
| 93 | split2 | 4.2.0 | ISC | https://github.com/mcollina/split2 |
| 94 | statuses | 2.0.2 | MIT | https://github.com/jshttp/statuses |
| 95 | toidentifier | 1.0.1 | MIT | https://github.com/component/toidentifier |
| 96 | type-is | 2.1.0 | MIT | https://github.com/jshttp/type-is |
| 97 | undici-types | 8.3.0 | MIT | https://github.com/nodejs/undici |
| 98 | unpipe | 1.0.0 | MIT | https://github.com/stream-utils/unpipe |
| 99 | vary | 1.1.2 | MIT | https://github.com/jshttp/vary |
| 100 | which | 2.0.2 | ISC | https://github.com/isaacs/node-which |
| 101 | wrappy | 1.0.2 | ISC | https://github.com/npm/wrappy |
| 102 | xtend | 4.0.2 | MIT | https://github.com/Raynos/xtend |
| 103 | zod | 3.25.76 | MIT | https://github.com/colinhacks/zod |
| 104 | zod-to-json-schema | 3.25.2 | ISC | https://github.com/StefanTerdell/zod-to-json-schema |
