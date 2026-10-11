# air 패치와 전송 설정

이 서버는 MCP 프레임워크 air(`@airmcp-dev/core`) 0.5.2 의 자체 엔진과 전송(stdio, SSE, Streamable HTTP)으로 돈다. 0.5.2 에서 우리가 찾은 결함 다섯은 air 저장소에 수정 PR 로 올렸고, 릴리스에 들어오기 전까지는 같은 수정을 `air-server/patches/` 의 패치로 얹는다. 우리 쪽 우회 코드는 두지 않는다.

## 패치

| 파일 | 내용 |
|---|---|
| `@airmcp-dev+core+0.5.2+001+air-prs-3-5-7-9-11.patch` | airmcp-dev/air PR 다섯 개. [#3](https://github.com/airmcp-dev/air/pull/3) stdio 줄 단위 프레이밍, [#5](https://github.com/airmcp-dev/air/pull/5) 도구 결과의 `isError` 전달, [#7](https://github.com/airmcp-dev/air/pull/7) Zod 에서 JSON Schema 로의 변환(refine 안쪽의 형과 설명, 배열 `items`, nullable), [#9](https://github.com/airmcp-dev/air/pull/9) `prompts/get` 필수 인자 검사(-32602), [#11](https://github.com/airmcp-dev/air/pull/11) Streamable HTTP(`GET /mcp` 405, Origin 검사, 기본 바인딩 127.0.0.1, 지원하지 않는 `MCP-Protocol-Version` 400) |
| `@airmcp-dev+core+0.5.2+002+ping-from-air-main-42cf9e0.patch` | air main 의 [42cf9e0](https://github.com/airmcp-dev/air/commit/42cf9e0) 가운데 `ping` 한 줄. 0.5.2 는 `ping` 에 `{"resultType":"complete"}` 를 돌려주는데, 빈 결과만 받는 MCP SDK 클라이언트의 `ping()` 이 이를 거부한다. 42cf9e0 은 0.5.2 배포 뒤의 커밋이라 아직 릴리스에 없다 |

001 은 air 0.5.2 소스(ddab0b4, 배포본과 빌드 결과가 같은 커밋)에 다섯 PR 의 커밋을 쌓아 TypeScript 5.9.3 으로 빌드한 `dist` 와 npm 배포본의 차이다(`.js`, `.d.ts`, `.map` 제외). 각 수정의 이유와 재현은 PR 본문에 있다.

## 적용 방식

- `air-server/package.json` 이 `@airmcp-dev/core` 를 `0.5.2` 로 고정하고, `postinstall` 이 `patch-package --error-on-fail --error-on-warn` 을 돈다. `npm ci` 를 하면 로컬, CI, Docker 이미지 빌드 모두 같은 패치가 들어간다. `air-server/Dockerfile` 은 `npm ci` 전에 `patches/` 를 복사한다.
- 패치가 대지지 않거나 설치된 air 판이 패치 파일 이름의 판(0.5.2)과 다르면 `npm ci` 가 실패한다. CI 는 그 뒤에 `node scripts/verify-air-patch.mjs` 로 설치본에 패치의 줄이 다 들어갔는지 다시 본다.
- 패치가 빠진 air 에서는 `npm run build` 도 실패한다. `server.ts` 의 전송 설정이 #11 이 더한 `allowedOrigins` 칸을 쓰기 때문이다. `surfaces.test` 는 서버 정의를 air 의 stdio 와 HTTP 전송에 그대로 얹어 다섯 수정과 `ping` 을 응답으로 확인한다.
- 패치 파일은 LF 로만 체크아웃한다(`.gitattributes`).

## 패치를 지우는 때

air 새 릴리스가 PR #3, #5, #7, #9, #11 과 42cf9e0 을 모두 담으면 지운다. Dependabot 이 air 판을 올리는 PR 은 판이 맞지 않아 `npm ci` 에서 실패하므로 그때 확인하게 된다.

1. 새 판의 변경 기록에서 여섯 수정이 들어갔는지 본다. 일부만 들어갔으면 남은 수정으로 패치를 다시 만든다.
2. `@airmcp-dev/core` 를 그 판으로 정확히 고정하고 `air-server/patches/`, `postinstall`, `patch-package` 개발 의존성, CI 의 패치 확인 단계와 `scripts/verify-air-patch.mjs`, Dockerfile 의 `COPY patches`, NOTICE 의 해당 항목, 이 문서를 지운다.
3. `npm ci` 뒤 `surfaces.test` 를 돌린다. 패치가 하던 일을 릴리스가 하는지 이 테스트가 응답으로 확인한다.

## 전송 설정

| 변수 | 기본값 | 뜻 |
|---|---|---|
| `MCP_TRANSPORT` | `stdio` | `stdio`, `sse`, `http`(세션 없는 Streamable HTTP, `POST /mcp`) 가운데 하나. 다른 값이면 기동을 멈춘다 |
| `MCP_PORT` | `3510` | `sse` 와 `http` 의 포트 |
| `MCP_HOST` | `127.0.0.1` | `sse` 와 `http` 의 바인딩 주소. 같은 기기의 클라이언트만 붙는다. 다른 기기나 컨테이너 밖에서 붙으려면 `0.0.0.0` 처럼 준다 |
| `MCP_ALLOWED_ORIGINS` | 없음 | `http` 가 루프백 출처 말고 더 받을 브라우저 Origin. 쉼표로 구분하고 스킴, 호스트, 포트까지 정확히 적는다(예: `https://app.example.com`). `*` 는 받지 않는다 |

`http` 는 Origin 헤더가 없는 요청(MCP Inspector CLI, SDK 클라이언트, curl)과 루프백 출처(`localhost`, `127.0.0.1`, `[::1]`, 포트 무관)에서 온 요청을 받고, 나머지 Origin 은 모든 경로에서 403 으로 막는다(DNS 리바인딩 방어). MCP Inspector 웹 UI(`http://localhost:6274`)도 루프백 출처라 따로 적을 것이 없다. air 의 `corsPlugin` 은 이 검사와 상관없다.

`sse` 는 air 의 이전 HTTP+SSE 전송이라 Origin 을 검사하지 않는다(main 의 air 0.3.0 도 같았다). 바인딩만 루프백으로 묶는다. 브라우저에서 붙는 배포에는 `http` 를 쓴다.

## 알려진 것

- 패치는 이 저장소에서 `npm ci` 할 때만 들어간다. npm 에 공개한 패키지를 받는 쪽에는 따라가지 않으므로 패치가 남아 있는 동안은 npm 에 공개하지 않는다([publishing.md](publishing.md) B 단계).
- `npm ci` 끝의 감사 줄에 high 4건이 나온다. 모두 같은 권고(GHSA-vfj7-8cjw-p6xm, braces 3.0.3 이하, 고친 판 없음)이고 `patch-package` → `find-yarn-workspace-root` → `micromatch` → `braces` 의 개발 의존성 사슬이다. 설치할 때 로컬 `package.json` 의 workspaces 패턴만 읽고 서버 실행 경로에는 없다. `npm audit --omit=dev` 는 0건이다.
- air 는 목록에 없는 도구 호출을 JSON-RPC 오류 `-32601` 로 돌려준다. MCP 스펙은 이것을 프로토콜 오류로 분류하지만 예시의 코드는 `-32602` 다.
