# air 패치와 전송 설정

이 서버는 MCP 프레임워크 air(`@airmcp-dev/core`) 0.5.2 의 자체 엔진과 전송(stdio, SSE, Streamable HTTP)으로 돈다. 0.5.2 에서 우리가 찾은 결함은 air 저장소에 수정 PR 로 올렸고, 릴리스에 들어오기 전까지는 npm 배포본 0.5.2 에 같은 수정을 얹은 tarball 을 저장소에 두고 쓴다(`air-server/vendor/`). 우리 쪽 우회 코드는 두지 않는다.

## tarball 에 든 것

`air-server/vendor/airmcp-dev-core-0.5.2-patched.1.tgz` 는 npm 의 `@airmcp-dev/core@0.5.2` tarball(registry integrity `sha512-QFQr8kPg6Q79xwo2xVBcZ42nqdWTdvzhkmOtbyPdtZNMceWZr77y+MGdLqwmc6olL5q+F26KtWBVo9uh8pxzeA==`)에 아래 패치 셋을 이름 순서대로 대고, `package.json` 의 판만 `0.5.2-patched.1` 로 바꿔 `npm pack` 한 것이다. 다른 파일은 배포본과 바이트까지 같다.

- sha512 `X/5s8kYLmiJqQNwNTRY7+dv0ORdL5Nyrc+X+7D02gKueqILpaNQ10SorKkv33QUKm7vpLvSmeLwyy8vFhG+LYw==`
- sha256 `31779e87b17477a9f1b0dc4a0b652cee1a211259af53bf3c441736bb3ee277d9`
- 해시와 패치 목록의 정본은 `air-server/vendor/air-vendor.json` 이다. 위 두 줄과 어긋나면 그 파일이 맞다.

| 패치 (`air-server/vendor/patches/`) | 내용 |
|---|---|
| `001-air-prs-3-5-7-9-11.patch` | airmcp-dev/air PR 다섯 개. [#3](https://github.com/airmcp-dev/air/pull/3) stdio 줄 단위 프레이밍, [#5](https://github.com/airmcp-dev/air/pull/5) 도구 결과의 `isError` 전달, [#7](https://github.com/airmcp-dev/air/pull/7) Zod 에서 JSON Schema 로의 변환(refine 안쪽의 형과 설명, 배열 `items`, nullable 은 `anyOf: [형, {"type": "null"}]`), [#9](https://github.com/airmcp-dev/air/pull/9) `prompts/get` 필수 인자 검사(-32602), [#11](https://github.com/airmcp-dev/air/pull/11) Streamable HTTP(`GET /mcp` 405, Origin 검사, 기본 바인딩 127.0.0.1, 지원하지 않는 `MCP-Protocol-Version` 400) |
| `002-ping-from-air-main-42cf9e0.patch` | air main 의 [42cf9e0](https://github.com/airmcp-dev/air/commit/42cf9e0) 가운데 `ping` 한 줄. 0.5.2 는 `ping` 에 `{"resultType":"complete"}` 를 돌려주는데, 빈 결과만 받는 MCP SDK 클라이언트의 `ping()` 이 이를 거부한다. 42cf9e0 은 0.5.2 배포 뒤의 커밋이라 아직 릴리스에 없다 |
| `003-sse-origin.patch` | 이전 HTTP+SSE 전송(`GET /sse`, `POST /message`)의 Origin 검사. #11 의 규칙(Origin 없음, 루프백 출처, `allowedOrigins` 만 받는다)을 두 전송이 같이 쓰는 함수(`dist/protocol/origin.js`)로 꺼내 SSE 의 모든 경로에 건다. MCP 스펙 2024-11-05 transports 의 HTTP with SSE 절이 요구하는 검사다. air 저장소에 올릴 수정이고 아직 올리지 않았다(#11 위에 쌓은 커밋) |

패치는 air 소스에서 만든다. 0.5.2 와 빌드 결과가 같은 커밋 `ddab0b4` 에 PR 커밋을 쌓아 TypeScript 5.9.3 으로 빌드한 `dist` 와 배포본의 차이가 001 이고, 그 위에 SSE 커밋을 더 쌓은 빌드와의 차이가 003 이다(`.js`, `.d.ts`). `.map` 은 넣지 않았다. 그래서 고친 파일의 source map 은 배포본 그대로라 고친 줄과 맞지 않고, 새 파일 `origin.js` 에는 map 이 없다. 각 수정의 이유와 재현은 PR 본문에 있다.

## 만드는 법

```sh
node scripts/build-air-vendor.mjs            # air-server/vendor 에 tarball 과 air-vendor.json 을 쓴다
cd air-server && npm install                 # package-lock.json 의 integrity 를 새 tarball 로 바꾼다
cd .. && node scripts/build-air-vendor.mjs --check   # 커밋된 tarball 이 다시 만들어지는지 본다(CI 도 돈다)
```

`build-air-vendor.mjs` 는 배포본을 받아 npm registry 가 알려 주는 integrity 와 스크립트에 고정한 integrity 둘 다와 견주고, 새 임시 폴더에 풀어 패치를 댄다. 패치의 문맥이 한 줄이라도 다르면 멈춘다(어긋난 자리를 찾아 대는 일은 하지 않는다). 그다음 판을 바꿔 `npm pack --ignore-scripts` 한다. git 이나 tar 는 부르지 않는다. Windows(Node 24, npm 11.16)와 Linux 컨테이너(Node 20, npm 10.8)에서 바이트까지 같은 tarball 이 나왔다.

패치를 바꿀 때는 `air-server/vendor/patches/` 의 파일을 고치고, 스크립트의 `LOCAL` 을 `patched.2` 처럼 올리고, `air-server/package.json` 의 `file:` 경로를 새 이름으로 바꾼 뒤 위 세 줄을 돈다. 같은 판 이름에 다른 내용이 실리지 않게 하려는 것이다.

## 적용과 확인

- `air-server/package.json` 의 `@airmcp-dev/core` 는 `file:` 의존성으로 `air-server/vendor/airmcp-dev-core-0.5.2-patched.1.tgz` 를 가리키고, `package-lock.json` 이 그 sha512 를 적는다. 로컬, CI, Docker 이미지 빌드 모두 `npm ci` 가 이 파일을 설치한다. 설치 스크립트(`postinstall`)는 없다. `air-server/Dockerfile` 은 `npm ci` 전에 `vendor/*.tgz` 를 복사한다.
- 캐시가 없는 `npm ci` 는 lockfile 과 다른 tarball 을 `seems to be corrupted` 로 거절한다(배포본으로 바꿔 넣어 확인했다). CI 는 그 뒤에 `node scripts/verify-air-patch.mjs` 로 다음을 보고, 어긋나면 이름을 대고 실패한다.
  1. `package.json` 이 이 파일을 가리키고, 파일의 sha512 가 `air-vendor.json` 과 `package-lock.json` 에 적힌 값과 같다.
  2. `air-server/vendor/patches` 가 `air-vendor.json` 에 적힌 패치와 같다(패치만 고치고 tarball 을 다시 만들지 않은 경우).
  3. 설치된 `node_modules/@airmcp-dev/core` 가 tarball 의 파일과 바이트까지 같고, 패치가 넣는 줄이 다 들어 있다.
- 이어서 `node scripts/build-air-vendor.mjs --check` 가 tarball 을 배포본과 패치에서 다시 만들어 들어 있는 것과 견준다. 커밋된 바이너리에 패치 말고 다른 것이 없다는 것을 CI 가 매번 다시 보인다.
- 패치가 빠진 air 에서는 `npm run build` 도 실패한다. `server.ts` 의 전송 설정이 #11 이 더한 `allowedOrigins` 칸을 쓰기 때문이다. `surfaces.test` 는 서버 정의를 air 의 stdio, HTTP, SSE 전송에 그대로 얹어 수정들과 `ping` 을 응답으로 확인한다. 도구 스키마에 타입 배열이 없는 것(MCP Inspector `tools/list --strict` 의 이식성 경고 0, TC-028)도 여기서 본다.
- 패치 파일은 LF 로만 체크아웃하고 tarball 은 바이너리로 둔다(`.gitattributes`).

## tarball 을 지우는 때

air 새 릴리스가 PR #3, #5, #7, #9, #11, 42cf9e0, SSE Origin 수정을 모두 담으면 지운다. `file:` 의존성은 Dependabot 이 판을 올려 주지 않으므로 air 의 릴리스와 이 PR 들의 상태를 직접 본다.

1. 새 판의 변경 기록에서 수정이 들어갔는지 본다. 일부만 들어갔으면 `build-air-vendor.mjs` 의 `BASE` 를 그 판으로 바꾸고 남은 수정만 패치로 다시 만든다.
2. 모두 들어갔으면 `@airmcp-dev/core` 를 그 판으로 정확히 고정하고 `air-server/vendor/`, `scripts/build-air-vendor.mjs`, `scripts/air-vendor-lib.mjs`, `scripts/verify-air-patch.mjs`, CI 의 두 단계, Dockerfile 의 `COPY vendor`, NOTICE 와 `scripts/sbom.mjs` 의 해당 문장, 이 문서를 지운다. README 의 검사 표와 검사 수도 고친다.
3. `npm ci` 뒤 `surfaces.test` 를 돌린다. 패치가 하던 일을 릴리스가 하는지 이 테스트가 응답으로 확인한다.

## 전송 설정

| 변수 | 기본값 | 뜻 |
|---|---|---|
| `MCP_TRANSPORT` | `stdio` | `stdio`, `sse`, `http`(세션 없는 Streamable HTTP, `POST /mcp`) 가운데 하나. 다른 값이면 기동을 멈춘다 |
| `MCP_PORT` | `3510` | `sse` 와 `http` 의 포트 |
| `MCP_HOST` | `127.0.0.1` | `sse` 와 `http` 의 바인딩 주소. 같은 기기의 클라이언트만 붙는다. 다른 기기나 컨테이너 밖에서 붙으려면 `0.0.0.0` 처럼 준다 |
| `MCP_ALLOWED_ORIGINS` | 없음 | `sse` 와 `http` 가 루프백 출처 말고 더 받을 브라우저 Origin. 쉼표로 구분하고 스킴, 호스트, 포트까지 정확히 적는다(예: `https://app.example.com`). `*` 는 받지 않는다 |

`sse` 와 `http` 는 Origin 헤더가 없는 요청(MCP Inspector CLI, SDK 클라이언트, curl)과 루프백 출처(`localhost`, `127.0.0.1`, `[::1]`, 포트 무관)에서 온 요청을 받고, 나머지 Origin 은 모든 경로에서 403 으로 막는다(DNS 리바인딩 방어). MCP Inspector 웹 UI(`http://localhost:6274`)도 루프백 출처라 따로 적을 것이 없다. air 의 `corsPlugin` 은 이 검사와 상관없다. SSE 는 air 0.5.2 그대로는 Origin 을 보지 않았고(main 의 air 0.3.0 도 같았다) 003 패치가 HTTP 와 같은 규칙을 건다.

## 알려진 것

- tarball 은 이 저장소에서 `npm ci` 할 때만 쓰인다. npm 에 공개한 패키지를 받는 쪽에서는 `file:vendor/...` 의존성을 풀 수 없으므로, tarball 이 남아 있는 동안은 npm 에 공개하지 않는다([publishing.md](publishing.md) B 단계).
- `npm ci` 는 패키지 20개를 설치하고 감사 줄은 `found 0 vulnerabilities` 다. patch-package 로 패치하던 동안에는 그 개발 의존성 사슬(`find-yarn-workspace-root` → `micromatch` → `braces`)이 high 4건(GHSA-vfj7-8cjw-p6xm, 고친 판 없음)을 끌고 왔는데, tarball 로 바꾸면서 사슬째 빠졌다.
- air 는 목록에 없는 도구 호출을 JSON-RPC 오류 `-32601` 로 돌려준다. MCP 스펙은 이것을 프로토콜 오류로 분류하지만 예시의 코드는 `-32602` 다.
