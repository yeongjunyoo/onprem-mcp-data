# 공개와 배포 실행 순서

> 이 문서는 **실행 전 체크리스트**다. 여기 적힌 단계 중 외부에 무언가를 남기는 것(저장소 공개, npm 배포, 레지스트리 등록, 외부 저장소 PR)은 전부 **소유자 승인 게이트**이며 이 문서를 읽는 것만으로 실행되지 않는다.
> 근거: 2026-07-29 R4 리서치 C2 레인(공식 문서 원문 확인). 각 단계의 선행조건과 되돌림 가능성을 그때 확인한 그대로 옮겼다.

## 왜 순서가 있나

공식 MCP Registry는 **코드가 아니라 메타데이터만** 호스팅한다. 등록 시 npm 공개 레지스트리에 있는 **특정 버전**과 `package.json`의 `mcpName`이 `server.json`의 `name`과 일치하는지 검증한다. 그래서 npm 공개가 레지스트리 등록의 선행조건이고, 저장소 공개가 그 앞에 온다.

```
A 저장소 공개 준비  ->  B npm 계정·이름 확보  ->  C npm 최초 공개 버전
                                                      |
                                     D MCP Registry 등록 (server.json)
                                                      |
                                     E 큐레이션 목록 PR   F (선택) MCPB + Smithery
```

## A. 저장소 공개 준비 — 완료

| 항목 | 상태 | 근거 |
| --- | --- | --- |
| LICENSE (Apache-2.0) | 완료 | 저장소 루트 |
| README, 영어 요약본 | 완료 | `README.md`, `README.en.md` |
| 기여·보안·행동규범, 이슈/PR 템플릿 | 완료 | `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `.github/` |
| CI | 완료 | `.github/workflows/ci.yml` (오프라인 단위 테스트 + SBOM 드리프트) |
| 비밀값 점검 | 완료 | 추적 파일 전수 스캔에서 자격증명 0건. 검출된 문자열은 전부 테스트 픽스처(`bench.admin_secrets`)와 로컬 컨테이너 비밀번호 |
| 대용량·라이선스 제한 자산 | 완료 | 사업자 데이터셋과 외부 벤치는 Git 밖. 추적 파일 합계 0.65MB |
| 패키지 메타데이터 | 완료 | `air-server/package.json`에 description, keywords, license, repository, homepage, bin, files, engines |
| 패키지 tarball 점검 | 완료 | `npm pack --dry-run` 37파일 72.6kB, README/LICENSE/NOTICE 포함, 테스트 파일 제외 |

`private: true`는 **일부러 남겨 뒀다.** 실수로 publish 되는 것을 막는 마지막 안전장치이고, 공개 시점에 이 한 줄만 지운다.

## B. npm 계정과 이름 — 게이트

- [ ] npm 계정 로그인과 2FA 활성화
- [ ] 패키지 이름 가용성 확인. 현재 `server.json`은 **`onprem-mcp-data`** (스코프 없음)를 전제로 적혀 있다. 이름이 이미 점유돼 있으면 `@<계정>/onprem-mcp-data`로 바꾸고 `server.json`의 `packages[0].identifier`도 같이 바꾼다.
- [ ] `package.json`의 `name`을 최종 이름으로 교체 (현재 값 `air-server`는 내부 디렉터리 이름이지 배포명이 아니다)
- [ ] `package.json`에 `"mcpName": "io.github.yeongjunyoo/onprem-mcp-data"` 추가 (레지스트리 소유권 검증에 필요, `server.json`의 `name`과 완전히 일치해야 한다)

## C. npm 최초 공개 — 게이트, 되돌리기 어려움

```bash
cd air-server
npm pkg delete private          # 안전장치 해제
npm pack --dry-run              # 마지막 확인: 파일 목록, 크기, README 포함 여부
npm publish --access public     # scoped 이름이면 --access public 필수
```

**되돌리기 어려운 이유 (공식 정책):**

- 같은 `package@version`은 unpublish 후에도 **다시 쓸 수 없다.**
- 모든 버전을 unpublish 하면 **24시간 동안** 새 버전을 publish 할 수 없다.
- 공개 후 72시간이 지나면 삭제 조건이 엄격해진다(의존 0, 최근 주 다운로드 300 미만, 단독 메인테이너를 모두 충족해야 한다).
- 사고 대응의 기본값은 unpublish가 아니라 **deprecate**다.

## D. MCP Registry 등록 — 게이트

`server.json` 초안은 저장소 루트에 이미 있다. 등록 전에 `version`과 `packages[0].version`을 **실제 publish 한 버전**으로 맞춘다(범위 표기 `latest`, `^`, `~`, `1.x`는 거부된다).

```bash
mcp-publisher login github     # 디바이스 코드 인증, io.github.<계정>/* 네임스페이스
mcp-publisher publish
curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=onprem-mcp-data"
```

- 네임스페이스는 **GitHub 방식**을 쓴다. DNS/HTTP 방식은 커스텀 도메인을 장기 운영할 때만 의미가 있다.
- 레지스트리는 preview 단계라 breaking change나 데이터 리셋이 있을 수 있다. 등록 성공을 영구 노출 보장으로 쓰지 않는다.
- 삭제해도 메타데이터는 `status: deleted`로 남는다. 그러므로 이름, 설명, 저장소 URL에 개인정보를 넣지 않는다.

## E. 큐레이션 목록 PR — 게이트

무료이고 stdio 서버를 배제하지 않는 두 목록이 1차 대상이다. 각 저장소의 CONTRIBUTING이 요구하는 형식(카테고리 위치, 알파벳 순서, 한 줄 설명)을 그대로 따른다. 병합 여부와 소요는 유지관리자 재량이다.

- [ ] `punkpeye/awesome-mcp-servers`
- [ ] `appcypher/awesome-mcp-servers`

## F. Smithery, MCP.so — 선택

- Smithery는 로컬 stdio 서버를 **MCPB 번들**로 받는다. 번들 제작 비용이 따로 든다.
- MCP.so는 현재 제출 UI에서 확인되는 경로가 39달러 유료 즉시 게재다. 무료 심사 경로는 페이지 설명에만 있고 절차와 기간을 확인하지 못했다. 유료 노출을 품질 증명으로 오인하지 않는다.

## 공개 직후 할 일

저장소를 공개한 순간부터 **운영 흔적 자체가 평가 대상**이 된다(1인 참가의 관리체계, 커뮤니티 확장 항목). 공개 즉시 다음을 만든다.

1. About 설명과 topics 설정, 라이선스 자동 인식 확인
2. `docs/roadmap.md`를 마일스톤으로 등록
3. `docs/initial-issues.md`의 이슈 등록(`good first issue` 라벨 포함)
4. 이후 변경은 브랜치와 PR로. 1인이라도 PR 본문에 변경 이유와 검증 결과를 남기고 셀프리뷰 코멘트를 붙인다.
5. 첫 릴리스 태그와 CHANGELOG

## 아직 답을 못 얻은 것

대회 기간 중 **디렉터리 등록과 외부 홍보가 허용되는지**를 운영규정 원문에서 확인하지 못했다. 금지 조항도 허용 조항도 없다. 운영사무국에 행위를 열거해 서면으로 확인받기 전에는 "허용된다"고 표현하지 않는다.
