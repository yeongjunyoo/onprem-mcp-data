# 붙임1 SBOM (소프트웨어 자재명세서)

> 생성 = `node scripts/sbom.mjs`. 근거 = `air-server/node_modules`에 **실제 설치된** 매니페스트(선언이 아니라 설치 상태).
> 생성 시각 2026-10-11T17:04:54.554Z
> npm 패키지 76개(직접 7 / 전이 69) + 런타임 구성요소 6개.
> 라이선스 분포: MIT 64 · ISC 7 · Apache-2.0 3 · BSD-2-Clause 1 · Public Domain 1.
> 직접 작성한 소스코드 라이선스 = **Apache-2.0**(OSI 인증, 레포 `LICENSE`). 카피레프트(GPL/AGPL/LGPL/MPL/EPL/CDDL/SSPL/OSL/EUPL) 의존성 **0건**, 라이선스 미표기 **0건** → 라이선스 충돌 없음. 이 두 수치는 설치 트리를 훑어 **검사한 결과**이며, 위반이 있으면 이 파일 생성이 실패한다(`node scripts/sbom.mjs`).

## 1. 직접 의존성 및 런타임 구성요소

| 번호 | 라이브러리명 | 버전 | 라이선스 | 공식 저장소 URL | 사용 목적 및 주요 기능 |
| --- | --- | --- | --- | --- | --- |
| 1 | @airmcp-dev/core | 0.5.2 | Apache-2.0 | https://github.com/airmcp-dev/air | MCP 서버 프레임워크(air). 프로토콜 엔진, 도구 등록, 입력 검증, stdio/SSE/HTTP 전송, 라이프사이클 관리. 상류 수정 패치를 얹는다(docs/air-patch.md) |
| 2 | @types/node | 26.6.4 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped | 타입 정의(개발 전용) |
| 3 | @types/pg | 8.23.1 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped | 타입 정의(개발 전용) |
| 4 | patch-package | 8.0.1 | MIT | https://github.com/ds300/patch-package | 설치 도구(개발 전용). npm ci 때 air-server/patches 를 @airmcp-dev/core 에 댄다 |
| 5 | pg | 8.23.1 | MIT | https://github.com/brianc/node-postgres | PostgreSQL 클라이언트. 관계형 조회, pgvector 유사도 검색, 읽기 엔드포인트 풀링 |
| 6 | typescript | 5.9.3 | Apache-2.0 | https://github.com/microsoft/TypeScript | 빌드 도구(개발 전용). 타입 검사 및 dist 트랜스파일 |
| 7 | zod | 3.25.76 | MIT | https://github.com/colinhacks/zod | 도구 입력과 route 출력의 스키마(air 가 검증과 JSON Schema 변환에 쓴다) |
| 8 | PostgreSQL | 16 | PostgreSQL License (OSI 인증) | https://github.com/postgres/postgres | 관계형 저장소와 온프렘 클러스터(primary, replica) |
| 9 | pgvector | 0.8.6 | PostgreSQL License (OSI 인증) | https://github.com/pgvector/pgvector | 벡터 인덱스와 코사인 유사도 검색 |
| 10 | Ollama | 0.32.14 | MIT | https://github.com/ollama/ollama | 로컬 LLM과 임베딩 런타임(외부 API 호출 없음) |
| 11 | qwen2.5-coder:7b | 7B | Apache-2.0 (오픈웨이트) | https://huggingface.co/Qwen/Qwen2.5-Coder-7B-Instruct | 질의 의도 분해와 답변 생성(로컬 추론) |
| 12 | bge-m3 | 567M | MIT (오픈웨이트) | https://huggingface.co/BAAI/bge-m3 | 문서와 질의 임베딩(1024차원, 로컬 추론) |
| 13 | Node.js | 20 LTS | MIT | https://github.com/nodejs/node | MCP 서버 런타임 |

## 2. 전이 의존성 (자동 수집)

| 번호 | 라이브러리명 | 버전 | 라이선스 | 공식 저장소 URL |
| --- | --- | --- | --- | --- |
| 1 | @yarnpkg/lockfile | 1.1.0 | BSD-2-Clause | https://github.com/yarnpkg/yarn/blob/master/packages/lockfile |
| 2 | ansi-styles | 4.3.0 | MIT | https://github.com/chalk/ansi-styles |
| 3 | braces | 3.0.3 | MIT | https://github.com/micromatch/braces |
| 4 | call-bind | 1.0.9 | MIT | https://github.com/ljharb/call-bind |
| 5 | call-bind-apply-helpers | 1.0.2 | MIT | https://github.com/ljharb/call-bind-apply-helpers |
| 6 | call-bound | 1.0.4 | MIT | https://github.com/ljharb/call-bound |
| 7 | chalk | 4.1.2 | MIT | https://github.com/chalk/chalk |
| 8 | ci-info | 3.9.0 | MIT | https://github.com/watson/ci-info |
| 9 | color-convert | 2.0.1 | MIT | https://github.com/Qix-/color-convert |
| 10 | color-name | 1.1.4 | MIT | https://github.com/colorjs/color-name |
| 11 | cross-spawn | 7.0.6 | MIT | https://github.com/moxystudio/node-cross-spawn |
| 12 | define-data-property | 1.1.4 | MIT | https://github.com/ljharb/define-data-property |
| 13 | dunder-proto | 1.0.1 | MIT | https://github.com/es-shims/dunder-proto |
| 14 | es-define-property | 1.0.1 | MIT | https://github.com/ljharb/es-define-property |
| 15 | es-errors | 1.3.0 | MIT | https://github.com/ljharb/es-errors |
| 16 | es-object-atoms | 1.1.2 | MIT | https://github.com/ljharb/es-object-atoms |
| 17 | fill-range | 7.1.1 | MIT | https://github.com/jonschlinkert/fill-range |
| 18 | find-yarn-workspace-root | 2.0.0 | Apache-2.0 | https://github.com/square/find-yarn-workspace-root |
| 19 | fs-extra | 10.1.0 | MIT | https://github.com/jprichardson/node-fs-extra |
| 20 | function-bind | 1.1.2 | MIT | https://github.com/Raynos/function-bind |
| 21 | get-intrinsic | 1.3.0 | MIT | https://github.com/ljharb/get-intrinsic |
| 22 | get-proto | 1.0.1 | MIT | https://github.com/ljharb/get-proto |
| 23 | gopd | 1.2.0 | MIT | https://github.com/ljharb/gopd |
| 24 | graceful-fs | 4.2.11 | ISC | https://github.com/isaacs/node-graceful-fs |
| 25 | has-flag | 4.0.0 | MIT | https://github.com/sindresorhus/has-flag |
| 26 | has-property-descriptors | 1.0.2 | MIT | https://github.com/inspect-js/has-property-descriptors |
| 27 | has-symbols | 1.1.0 | MIT | https://github.com/inspect-js/has-symbols |
| 28 | hasown | 2.0.4 | MIT | https://github.com/inspect-js/hasOwn |
| 29 | is-docker | 2.2.1 | MIT | https://github.com/sindresorhus/is-docker |
| 30 | is-number | 7.0.0 | MIT | https://github.com/jonschlinkert/is-number |
| 31 | is-wsl | 2.2.0 | MIT | https://github.com/sindresorhus/is-wsl |
| 32 | isarray | 2.0.5 | MIT | https://github.com/juliangruber/isarray |
| 33 | isexe | 2.0.0 | ISC | https://github.com/isaacs/isexe |
| 34 | json-stable-stringify | 1.3.0 | MIT | https://github.com/ljharb/json-stable-stringify |
| 35 | jsonfile | 6.2.1 | MIT | https://github.com/jprichardson/node-jsonfile |
| 36 | jsonify | 0.0.1 | Public Domain | https://github.com/ljharb/jsonify |
| 37 | klaw-sync | 6.0.0 | MIT | https://github.com/manidlou/node-klaw-sync |
| 38 | math-intrinsics | 1.1.0 | MIT | https://github.com/es-shims/math-intrinsics |
| 39 | micromatch | 4.0.8 | MIT | https://github.com/micromatch/micromatch |
| 40 | minimist | 1.2.8 | MIT | https://github.com/minimistjs/minimist |
| 41 | object-keys | 1.1.1 | MIT | https://github.com/ljharb/object-keys |
| 42 | open | 7.4.2 | MIT | https://github.com/sindresorhus/open |
| 43 | path-key | 3.1.1 | MIT | https://github.com/sindresorhus/path-key |
| 44 | pg-cloudflare | 1.4.1 | MIT | https://github.com/brianc/node-postgres |
| 45 | pg-connection-string | 2.14.1 | MIT | https://github.com/brianc/node-postgres |
| 46 | pg-int8 | 1.0.1 | ISC | https://github.com/charmander/pg-int8 |
| 47 | pg-pool | 3.14.0 | MIT | https://github.com/brianc/node-postgres |
| 48 | pg-protocol | 1.16.1 | MIT | https://github.com/brianc/node-postgres |
| 49 | pg-types | 2.2.0 | MIT | https://github.com/brianc/node-pg-types |
| 50 | pgpass | 1.0.5 | MIT | https://github.com/hoegaarden/pgpass |
| 51 | picomatch | 2.3.2 | MIT | https://github.com/micromatch/picomatch |
| 52 | postgres-array | 2.0.0 | MIT | https://github.com/bendrucker/postgres-array |
| 53 | postgres-bytea | 1.0.1 | MIT | https://github.com/bendrucker/postgres-bytea |
| 54 | postgres-date | 1.0.7 | MIT | https://github.com/bendrucker/postgres-date |
| 55 | postgres-interval | 1.2.0 | MIT | https://github.com/bendrucker/postgres-interval |
| 56 | semver | 7.8.5 | ISC | https://github.com/npm/node-semver |
| 57 | set-function-length | 1.2.2 | MIT | https://github.com/ljharb/set-function-length |
| 58 | shebang-command | 2.0.0 | MIT | https://github.com/kevva/shebang-command |
| 59 | shebang-regex | 3.0.0 | MIT | https://github.com/sindresorhus/shebang-regex |
| 60 | slash | 2.0.0 | MIT | https://github.com/sindresorhus/slash |
| 61 | split2 | 4.2.0 | ISC | https://github.com/mcollina/split2 |
| 62 | supports-color | 7.2.0 | MIT | https://github.com/chalk/supports-color |
| 63 | tmp | 0.2.7 | MIT | https://github.com/raszi/node-tmp |
| 64 | to-regex-range | 5.0.1 | MIT | https://github.com/micromatch/to-regex-range |
| 65 | undici-types | 8.9.0 | MIT | https://github.com/nodejs/undici |
| 66 | universalify | 2.0.1 | MIT | https://github.com/RyanZim/universalify |
| 67 | which | 2.0.2 | ISC | https://github.com/isaacs/node-which |
| 68 | xtend | 4.0.2 | MIT | https://github.com/Raynos/xtend |
| 69 | yaml | 2.9.1 | ISC | https://github.com/eemeli/yaml |
