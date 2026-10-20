# 다른 PostgreSQL DB 에 붙이기

코드를 고치지 않고 환경 변수로 붙인다. 정형 레인(NL2SQL)은 표만 있으면 바로 돈다. 문서 레인과 그래프 레인은 각자의 표가 있을 때만 쓴다. 표가 없는 레인으로는 라우터가 보내지 않는다. 기동 로그에는 없는 레인이, 호출마다 남는 감사 기록에는 바꾼 경로가 라우팅 근거로 적힌다.

1. **연결.** 읽기 전용 역할에 권한을 주고 환경 변수로 서버를 띄운다. 이것만으로 질문에 답한다.
2. **주석 초안.** 표와 열의 통계로 열 주석 초안 SQL 을 만든다.
3. **검수와 적용.** 붙일 DB 를 아는 담당자가 초안의 빈칸을 뜻과 단위로 채워 DB 에 건다.

모델이 SQL 을 쓸 때 보는 표 설명을 이 문서에서는 스키마 카드라 부른다. 카드는 둘이다. 열 이름과 타입만 실은 **열 이름 카드**는 1단계만 마쳤을 때, 열마다 주석을 붙인 **주석 카드**는 3단계를 마친 뒤에 쓰인다. 공개 예제 DB Chinook 으로 처음부터 끝까지 해 본 기록(2026-10-20)이 맨 아래에 있다.

## 0. 준비

- 서버 빌드: `cd air-server && npm ci && npx tsc`
- Ollama 와 두 모델: `ollama pull qwen2.5-coder:7b`, `ollama pull bge-m3` (README 의 빠른 시작과 같다)
- 붙일 DB 의 접속 URL(`postgresql://사용자:비밀번호@호스트:포트/DB`)

## 1. 연결

### 읽기 전용 역할

생성 모델이 쓴 SQL 은 READ ONLY 트랜잭션을 열고 그 안에서 `mcp_ro` 역할로 낮춰 돈다(`air-server/src/sql.ts`). 붙일 DB 에서 아래를 한 번 실행한다. 역할은 클러스터 단위라 이미 있으면 첫 줄은 건너뛴다.

```sql
CREATE ROLE mcp_ro NOLOGIN;
GRANT USAGE ON SCHEMA <스키마> TO mcp_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA <스키마> TO mcp_ro;
GRANT mcp_ro TO <접속 사용자>;   -- 접속 사용자가 superuser 면 필요 없다
```

하나라도 빠지면 서버가 기동 때 `[read-role]` 줄에 무엇이 막혔는지와 고칠 SQL 을 찍는다. 이 점검은 스키마 카드에 싣는 표만 본다. 역할이 아예 없으면 질의는 READ ONLY 트랜잭션으로만 돌고 역할 강등은 하지 않는다.

문서 레인과 그래프 레인은 코드가 짠 질의라 접속 사용자로 읽는다. 접속 사용자는 두 레인의 표를 읽을 수 있어야 한다. 아래의 `npm run embed` 는 문서 표의 `embedding` 열에 값을 쓰므로 그 열의 UPDATE 권한도 있어야 한다.

### 환경 변수

| 변수 | 뜻 | 기본값 |
|---|---|---|
| `DATABASE_URL` | 붙일 DB 의 접속 URL | (필수) |
| `DATASET=catalog` | 다른 회사 DB 프로파일 | |
| `CATALOG_SCHEMA` | 정형 레인의 표가 있는 스키마 | (필수) |
| `CATALOG_VECTOR_TABLE` | 문서 레인 표(`스키마.표`, 열 `id`, `title`, `body`, `embedding vector(1024)`) | `<스키마>.documents` |
| `CATALOG_KG_SCHEMA` | 그래프 레인 표(`entities`, `aliases`, `relations`)가 있는 스키마 | `<스키마>` |
| `EMBEDDER=ollama` | 문서 레인의 질문을 bge-m3 로 임베딩한다. 문서 레인이 있으면 켠다 | 해시(뜻을 담지 않는다) |

스키마와 표 이름은 식별자 꼴(`[A-Za-z_][A-Za-z0-9_]*`)만 받는다. `CATALOG_SCHEMA` 가 비었거나 꼴이 틀리면 서버는 DB 에 붙기 전에 멈춘다.

```sh
cd air-server
export DATABASE_URL=postgresql://app:비밀번호@db.example:5432/shop DATASET=catalog CATALOG_SCHEMA=public EMBEDDER=ollama
node dist/index.js          # MCP 서버(stdio)
node dist/cli/demo-web.js   # 또는 시연 화면: http://127.0.0.1:3520 에서 질문하고 답, SQL, 조회한 행을 본다
```

Windows PowerShell 에서는 `$env:DATASET = "catalog"` 처럼 먼저 설정한다. `npm run demo:web` 은 이 저장소의 Company-X 데이터셋(아래 사업자 데이터셋)으로 고정돼 있어 다른 DB 에는 `node dist/cli/demo-web.js` 를 바로 부른다.

Chinook 에 주석을 걸기 전의 기동 로그는 이렇다.

```
[catalog] public 스키마. 문서 레인 없음(public.documents 에 embedding 열이 없다), 그래프 레인 없음(public 에 entities, aliases, relations 표가 없다)
[schema-card] 열 이름과 타입만 실은 카드: 표 11개, 컬럼 64개(컬럼 주석이 하나도 없다). npm run comments-draft 로 주석 초안을 만들어 검수하면 정확도가 오른다
[router] 온톨로지 미적재(이 DB 에 그래프 레인 표가 없다) — 폴백 경로로 동작한다
[router] 시맨틱 폴백 없음(catalog 프로파일: 앵커가 사업자 데이터셋의 질문 유형이라 규칙만 쓴다)
```

열 이름 카드로도 정형 질문에 답한다. 다만 모델이 열 이름만 보고 SQL 을 쓰므로 열 이름이 뜻을 다 말하지 않는 DB 일수록 틀린다. 2, 3단계에서 열의 뜻과 단위를 주석으로 채운다.

## 2. 주석 초안

```sh
npm run comments-draft -- --schema public --out public.comments.draft.sql
```

`DATABASE_URL` 이 가리키는 DB 에서 그 스키마의 일반 표를 모두 읽는다. 문서 레인과 그래프 레인의 표는 뺀다. `--tables a,b` 로 표를 고를 수 있다. 초안은 표와 열마다 `COMMENT ON` 문 하나다.

- 주석 문자열(`IS` 뒤)에는 뜻 자리(`TODO`), 타입, 추상 범위(자릿수, 연도 범위, 값의 가짓수), NULL 여부만 들어간다.
- 정확한 최솟값, 최댓값, 최빈값은 `--` 로 시작하는 검토 힌트 줄에만 적는다. 그 줄은 SQL 파일 안의 메모라 DB 에도 카드에도 들어가지 않는다.
- 통계(`pg_stats`)가 없는 작은 표는 NULL 비율과 값의 가짓수를 정확 집계로 잰다. 도구는 읽기만 하고 ANALYZE 도 돌리지 않는다.

## 3. 검수와 적용

붙일 DB 를 아는 사람이 `TODO` 를 채운다. **값 예시는 쓰지 않는다.** 열의 뜻과 단위를 적는다. 업무 용어가 저장 값과 갈리는 곳(「미해결」이 상태 값 둘을 뜻하는 경우)만 그 조건을 SQL 로 적는다.

| 쓴다 | 쓰지 않는다 |
|---|---|
| `송장 합계 금액, 달러. 매출은 이 열의 합이다` | `예: 1.98, 3.96` |
| `고객이 사는 나라(영문 국가명)` | `USA, Canada, Brazil …` |
| `미해결 = status IN ('open', 'in_progress')` | 상태 값 목록 전부 |

값 목록을 주석에 옮기면 모델이 질문과 상관없이 그 값을 SQL 에 박는다. `TODO` 가 남아 검수가 끝나지 않은 열은 주석을 지운다. 검수를 마친 파일(아래에서는 `public.comments.sql`)을 붙일 DB 에 건다.

```sh
psql "$DATABASE_URL" -f public.comments.sql
```

서버를 다시 띄우면 주석 카드로 바뀐다.

```
[schema-card] 카탈로그 주석 카드: 표 11개, 컬럼 48개, 주석이 없어 뺀 컬럼 16개
```

- 주석 카드에는 주석이 달린 열과 키 열(기본키, 외래키)만 실린다. 키가 아니면서 주석이 없는 열은 모델에게 보이지 않아 SQL 에 쓰이지 않는다.
- 표 가운데 하나라도 열 주석이 전혀 없으면 검수가 덜 끝난 것으로 보고 열 이름 카드로 돌며 그 이유를 기동 로그에 적는다.

## 문서 레인과 그래프 레인

**문서 레인.** `CATALOG_VECTOR_TABLE`(기본 `<스키마>.documents`)에 `id`, `title`, `body`, `embedding vector(1024)` 열을 두고 본문을 넣은 뒤 임베딩을 채운다.

```sh
npm run embed   # DATASET=catalog 와 위 변수를 그대로 둔 채로. bge-m3 로 embedding 열을 채운다
```

Chinook 에 `public.documents` 를 만들고 짧은 안내문 3건(환불 정책, 파일 형식, 고객 지원 시간)을 넣은 뒤 `npm run embed` 를 돌리자 1024차원 3건이 0.46초에 찼다. 다시 띄우면 기동 로그가 `문서 레인 있음(public.documents)` 으로 바뀐다. 스키마 카드는 표 11개 그대로다. 같은 스키마에 있는 문서 표는 카드에서 뺀다. 「내려받은 곡도 환불돼?」에 「아니요, 내려받은 곡은 환불되지 않습니다」, 「환불 신청은 며칠 안에 해야 해?」에 「구매일로부터 7일 안」, 「고객 지원은 몇 시까지 받아?」에 「평일 오전 9시부터 오후 6시까지」라고 답했다(2026-10-20). 셋 다 규칙이 레인을 정하지 못해 있는 레인을 모두 도는 기본 경로(hybrid, 이 DB 에서는 정형과 문서)로 갔고 답은 문서 조각에서 나왔다.

**그래프 레인.** `CATALOG_KG_SCHEMA` 에 `entities`, `aliases`, `relations` 표가 있으면 쓴다. 이 저장소에서 그 세 표를 채우는 적재기(`npm run companyx:load`)는 사업자 데이터셋의 파일 구조를 읽는다. 다른 데이터로 그래프를 채워 본 적은 없어서 절차를 적지 않는다.

**라우터.** 키워드 규칙으로만 레인을 고른다. 사업자 데이터셋에서는 규칙이 확신하지 못할 때 기준 문장 423개와 뜻을 견주는 시맨틱 폴백을 쓴다. 그 문장들은 사업자 데이터셋의 질문 유형(표, 문서 유형, 관계)에서 뽑은 것이라 다른 DB 에서는 켜지 않는다. 없는 레인으로 가는 결정은 있는 레인으로 바꾼다. 예를 들어 정형 레인만 있는 DB 에서 문서 레인으로 갈 질문은 정형으로 간다. 라우팅 근거 끝에는 `lanes in this database: sql -> structured`(이 DB 의 레인은 sql 뿐이라 structured 로 보냈다)가 붙는다.

## Chinook 으로 해 본 기록 (2026-10-20)

**대상.** 공개 예제 DB Chinook(음반 판매점, 표 11개, 송장 412건, 곡 3,503곡. Luis Rocha, MIT License). 저장소에는 넣지 않는다. lerocha/chinook-database 커밋 `9ad881311025c290a911a0461dd9919317b09021` 의 [ChinookDatabase/DataSources/Chinook_PostgreSql.sql](https://github.com/lerocha/chinook-database/blob/9ad881311025c290a911a0461dd9919317b09021/ChinookDatabase/DataSources/Chinook_PostgreSql.sql)(sha256 `e3fde5c1a5b51a2a91429a702c9ca6e69ba56e6c7f5e112724d70c3d03db695e`)을 받아 `psql -U postgres -f Chinook_PostgreSql.sql` 로 적재했다. 파일 맨 앞이 `DROP DATABASE IF EXISTS chinook; CREATE DATABASE chinook;` 이라 같은 서버에 별도 DB 가 생긴다. 사업자 데이터셋이 든 DB 는 건드리지 않았다.

**한 일.** 위 세 단계 그대로이고 코드는 고치지 않았다.

1. `mcp_ro` 역할은 이미 있고 접속 사용자가 superuser 라 1단계 SQL 가운데 `GRANT USAGE`, `GRANT SELECT` 두 줄만 걸었다. `DATASET=catalog CATALOG_SCHEMA=public` 으로 띄운 기동 로그가 1단계의 것이다.
2. `npm run comments-draft -- --schema public` 이 표 11개, 열 64개의 초안을 썼다.
3. 표 11개와 열 38개에 뜻과 단위를 적어 걸었다(`eval/catalog/chinook_comments.sql`). 주석이 없는 키 열 10개는 카드에 그대로 실리고 주소, 전화, 팩스, 생년월일 같은 16개는 카드에서 빠졌다.

**점검 세트.** 제품 코드와 결과와 주석을 보지 않은 별도 에이전트 세션이 한국어 질문 24개(쉬움 8, 보통 10, 어려움 6)와 정답 SQL, 답에 있어야 할 값을 썼다(`eval/catalog/`). 정답 SQL 24개를 다시 돌려 세트에 적힌 정답 행과 같은지 확인했다. 주석 검수본은 세트를 쓰기 전에 고정했고 카드마다 한 번 돌렸다. 다만 검수본은 그 전에 개발 중 손으로 물어본 8문항의 결과를 본 뒤에 썼다. 세트의 C14 는 그중 「직원별 담당 고객 수」와 거의 같은 질문이고 C22 는 「고객이 가장 많은 나라」를 한 단계로 품는다. 두 문항 모두 주석 카드에서도 틀렸다.

```sh
cd air-server
npm run catalog:check -- --set ../eval/catalog/chinook_check_v1.jsonl --out ../eval/results/catalog-chinook-comments.json
```

| 카드 | 답 맞음 | 행 맞음 | 원자료 |
|---|---|---|---|
| 열 이름 카드(주석 없음) | 15/24 | 15/24 | `eval/results/catalog-chinook-plain-first.json` |
| 주석 카드(검수한 주석) | 16/24 | 17/24 | `eval/results/catalog-chinook-comments.json` |

「답 맞음」은 답 문장에 정답 값이 모두 있는 것이고 「행 맞음」은 실행한 SQL 이 정답 행을 모두 담은 것이다. 채점 규칙(`air-server/src/catalogcheck.ts`)은 세트를 돌리기 전에 정했다. 질문 하나의 응답 중앙값은 0.58초다(호스트 GPU, `qwen2.5-coder:7b`). 주석 카드의 답은 쉬움 6/8, 보통 8/10, 어려움 2/6 이다. 두 줄 모두 아래 `notfound.ts` 수정 전의 코드로 돌았다. 그 수정은 주석 카드의 판정을 바꾸지 않는다(카드에 `birth_date` 가 없다).

주석을 걸자 행이 두 문항 더 맞았다. C13(구매 금액이 가장 큰 고객 셋)은 열 이름 카드가 송장 한 건의 금액으로 골랐고 주석 카드가 고객별 합계로 골랐다. C24(Grunge 재생목록에 곡이 가장 많은 아티스트)는 열 이름 카드에서 0건이었다. 답이 하나만 오른 것은 C19 때문이다. 주석 카드에서 C19 는 행이 맞았는데 답이 영문 이름을 한국어로 옮겨 적어 틀렸다. 주석과 상관없이 남은 오답:

- 묶음마다 1위를 고르는 다단계 집계(C21 장르별 1위 아티스트, C22 나라별 1위 고객, C23 연도별 1위 담당자). 7B 가 그 SQL 을 짜지 못했다.
- 이름 대신 번호를 고른 SQL(C17 「아티스트는 90번」)과 없는 열을 쓴 SQL(C14 `employee_id`). 실패한 SQL 을 한 번 고쳐 다시 실행하는 단계도 실패했다.
- 답을 쓰는 단계. 행은 맞았는데 수를 읽지 못했고(C06 「주어진 정보로는 알 수 없습니다」) 영문 이름을 한국어로 소리 나는 대로 옮겼다(C19 「마리가트 파크」). 답 프롬프트의 「한국어로만 답하라(고유명사 제외)」 줄에서 고유명사 제외가 지켜지지 않는다. 아직 고치지 않았다. 답 프롬프트를 바꾸면 사업자 데이터셋의 답도 바뀌므로 고칠 때는 시험항목 187건을 다시 돌린다.
- C07(가장 나이 많은 직원)은 검수 때 `birth_date` 에 주석을 달지 않아 주석 카드에서 빠졌고 서버는 「나이」가 이 데이터에 없다고 답했다. 주석 카드에는 검수한 열과 키 열만 실린다. 사용자가 물을 만한 열은 검수 때 주석을 비워 두지 않는다.

첫 실행에서 찾은 결함은 고쳤다. 데이터에 없는 항목(「나이」, 「주소」 등)을 묻는 질문을 SQL 을 짜기 전에 거르는 규칙이 카드에서 한국어 낱말만 찾아서 열 이름 카드에 `birth_date` 가 있는데도 C07 을 걸렀다(`air-server/src/notfound.ts`). 영문 열 이름의 낱말(birth, address, phone 등)도 보게 고친 뒤 열 이름 카드를 다시 돌리자 C07 의 SQL 은 맞았다(행 16/24, `eval/results/catalog-chinook-plain.json`). 답은 「마지트 가 파크」로 이름을 옮겨 적어 답 점수는 15/24 그대로다. 이 재실행은 세트의 결과를 보고 고친 코드로 낸 값이라 처음 보는 문항의 값이 아니다. 이번에 더한 영문 낱말은 사업자 데이터셋, bench, smoke 세 코퍼스의 카드와 열 172개 어디에도 없어 그 세 프로파일에서 이 규칙의 판정은 바뀌지 않는다.
