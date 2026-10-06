// NL -> SQL for the structured retrieval path.
//
// Two strategies share this interface so the pipeline is agnostic:
//   templateNL2SQL — a deterministic fast-path for the seed orders domain (no
//                    LLM, zero variance). Handles the common, unambiguous
//                    intents and returns null otherwise (deferring to the LLM).
//   llmNL2SQL      — 생성 모델(기본 Qwen2.5-Coder-7B) generates SQL from the live schema (added in the
//                    LLM increment). Measured honestly by the execution-match eval.
//
// Returning null = "I decline; let the next strategy try."

export type NL2SQL = (query: string, report?: Nl2SqlReport) => Promise<string | null> | string | null;

/** SQL 을 내지 않은 이유를 호출부에 알리는 자리. 생성기가 채우고 파이프라인이 감사 레코드에 싣는다. */
export interface Nl2SqlReport {
  /** 생성 모델이 만들었지만 실행하지 않은 문장. kind 는 쓰기 문장이면 그 종류(UPDATE 등),
   * 테이블을 읽지 않는 SELECT 면 NO_TABLE. */
  refused?: { kind: string; text: string };
}

/** 테이블을 읽지 않는 SELECT 의 kind. */
export const NO_TABLE = "NO_TABLE";

import { generate } from "./llm.js";
import { isReadOnly } from "./sql.js";

/** Schema description handed to the model for NL2SQL. */
export const SCHEMA_DDL = [
  "orders(id int, user_id int, status text, amount int, created_at date)",
  "  -- status ∈ {'paid','cancelled','refunded'}",
  "documents(id int, title text, body text, embedding vector)",
].join("\n");

function unwrap(raw: string): string {
  let s = raw.trim();
  const fence = s.match(/```(?:sql)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  return s.replace(/^sql\s*[:\n]/i, "").trim();
}

/** Strip code fences / prose and keep the first read-only SQL statement. */
export function extractSql(raw: string): string | null {
  const s = unwrap(raw);
  // take from the first SELECT/WITH to the first semicolon (or end)
  const m = s.match(/\b(select|with)\b[\s\S]*?(?=;|$)/i);
  if (!m) return null;
  const sql = m[0].trim();
  return isReadOnly(sql) ? sql : null;
}

/** 줄 머리에서 시작하는 첫 문장의 키워드. 설명 줄이 앞에 있어도 SQL 문장의 첫 줄을 찾는다. */
const FIRST_STATEMENT = /^\s*(select|with|insert|update|delete|merge|drop|alter|truncate|create|grant|revoke)\b/im;

/** 모델 출력의 첫 문장이 데이터나 권한, 스키마를 바꾸는 문장이면 그 종류(UPDATE 등)와 문장을, 아니면 null.
 *
 * extractSql 은 SELECT 가 없으면 null 을 돌려줘 쓰기 문장은 원래 실행되지 않았다. 그런데 그 사실이
 * 어디에도 남지 않아 「모든 직원의 연봉을 0으로 바꿔줘」의 감사 레코드에 거부 판정이 없었고(G17 ②),
 * UPDATE 안의 부분 SELECT 는 거꾸로 실행될 수 있었다. 첫 문장의 키워드로 가른다. */
export function writeStatement(raw: string): { kind: string; text: string } | null {
  const s = unwrap(raw).replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
  const m = s.match(FIRST_STATEMENT);
  if (!m || /^(select|with)$/i.test(m[1])) return null;
  return { kind: m[1].toUpperCase(), text: s.slice(m.index).split(";")[0].trim() };
}

/** SELECT 가 테이블(뷰, CTE 포함)을 읽는가. FROM 이 없으면 데이터와 무관한 상수 계산이다.
 * 문자열 값과 FROM 을 문법으로 쓰는 함수(extract, substring, trim, overlay)는 빼고 본다. */
export function readsTable(sql: string): boolean {
  const s = sql
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""')
    .replace(/\b(?:extract|substring|trim|overlay)\s*\((?:[^()]|\([^()]*\))*\)/gi, "f()");
  return /\bfrom\b/i.test(s);
}

/** 생성 모델 출력에서 실행할 SQL 을 고른다. 고르지 않은 이유가 쓰기 문장이거나 테이블을 읽지 않는
 * SELECT 면 report 에 남긴다. 「오늘 서울 날씨 어때?」에 7B 가 SELECT '서울 날씨' AS answer 를 만들어
 * 답이 「서울 날씨」였다(G17 ④). sql.query 도구는 이 함수를 거치지 않으므로 SELECT current_user 같은
 * 직접 실행은 그대로다. */
export function pickSql(raw: string, report?: Nl2SqlReport): string | null {
  const write = writeStatement(raw);
  if (write) {
    if (report) report.refused = write;
    return null;
  }
  const sql = extractSql(raw);
  if (sql && !readsTable(sql)) {
    if (report) report.refused = { kind: NO_TABLE, text: sql };
    return null;
  }
  return sql;
}

/** 생성 모델(기본 Qwen2.5-Coder-7B) generates a single read-only SQL from the schema + question.
 * This is the path measured (non-circularly) by the execution-match eval. */
export async function llmNL2SQL(query: string, report?: Nl2SqlReport): Promise<string | null> {
  // 활성 프로파일의 스키마 카드를 쓴다. 2026-08-18 리뷰 지적: 여기에 `SCHEMA_DDL`
  // (smoke 전용)이 박혀 있어서, 새 코퍼스를 프로파일로 붙여도 **모델은 여전히
  // orders/documents 를 본다.** 그러면 "프로파일 항목 하나면 된다" 는 문서가 거짓이 된다.
  //
  // profile.ts 가 이 파일을 import 하므로 정적 import 는 순환이다 — 지연 import 로 끊는다.
  // smoke.schemaCard === SCHEMA_DDL 이라 기존 동작은 그대로다.
  const { profile } = await import("./profile.js");
  const card = profile().schemaCard;
  const prompt = [
    "다음은 PostgreSQL 스키마입니다.",
    card,
    "",
    "질문에 답하는 단일 읽기 전용 SQL(SELECT) 한 문장만 출력하세요.",
    "설명, 주석, 코드펜스, 세미콜론 없이 SQL만 출력합니다.",
    "",
    `질문: ${query}`,
    "SQL:",
  ].join("\n");
  const raw = await generate(prompt);
  return pickSql(raw, report);
}

/** Schema card for the contest-grade bench e-commerce dataset (Gate5). */
export const BENCH_SCHEMA_DDL = [
  "bench.categories(id, name)",
  "bench.customers(id, name, segment['vip'|'regular'|'new'], region, created_at date)",
  "bench.products(id, name, category_id->categories.id, price int, supplier(nullable), active bool)",
  "bench.orders(id, customer_id->customers.id, status['paid'|'cancelled'|'refunded'|'shipped'], total int, created_at date)",
  "bench.order_items(id, order_id->orders.id, product_id->products.id, qty int, unit_price int)",
  "bench.support_tickets(id, customer_id->customers.id, order_id->orders.id (nullable), reason, status['open'|'resolved'|'escalated'], created_at date)",
].join("\n");

/** 생성 모델(기본 Qwen2.5-Coder-7B) NL->SQL over the bench schema (benchmark headline path, Gate5). */
export async function benchNL2SQL(query: string, report?: Nl2SqlReport): Promise<string | null> {
  const prompt = [
    "다음은 PostgreSQL 스키마입니다(모든 테이블은 bench 스키마에 있음).",
    BENCH_SCHEMA_DDL,
    "",
    "질문에 답하는 단일 읽기 전용 SQL(SELECT) 한 문장만 출력하세요.",
    "테이블은 반드시 bench. 접두사로 참조합니다. 설명/주석/코드펜스/세미콜론 없이 SQL만 출력.",
    "",
    `질문: ${query}`,
    "SQL:",
  ].join("\n");
  const raw = await generate(prompt);
  return pickSql(raw, report);
}

/** Ablation baseline: bare table names only — no columns, types, enums, or FK
 * arrows. Isolates the contribution of the curated schema card (the structured
 * half of the thesis). Same model, same decoding, same execution-match oracle. */
export const BENCH_SCHEMA_NAIVE = [
  "bench.categories",
  "bench.customers",
  "bench.products",
  "bench.orders",
  "bench.order_items",
  "bench.support_tickets",
].join("\n");

export async function benchNL2SQLNaive(query: string): Promise<string | null> {
  const prompt = [
    "다음 PostgreSQL 테이블이 있습니다(모두 bench 스키마).",
    BENCH_SCHEMA_NAIVE,
    "",
    "질문에 답하는 단일 읽기 전용 SQL(SELECT) 한 문장만 출력하세요.",
    "테이블은 반드시 bench. 접두사로 참조합니다. 설명/주석/코드펜스/세미콜론 없이 SQL만 출력.",
    "",
    `질문: ${query}`,
    "SQL:",
  ].join("\n");
  const raw = await generate(prompt);
  return extractSql(raw);
}

const ORDER_COLS = "id, user_id, status, amount, created_at";

export function templateNL2SQL(query: string): string | null {
  const q = query.trim();

  // status listings
  if (/환불/.test(q) && /주문/.test(q))
    return `SELECT ${ORDER_COLS} FROM orders WHERE status = 'refunded' ORDER BY id`;
  if (/취소/.test(q) && /주문/.test(q))
    return `SELECT ${ORDER_COLS} FROM orders WHERE status = 'cancelled' ORDER BY id`;

  // counts
  if (/(주문).*(건수|개수|몇|\b수\b)|(건수|개수|몇).*(주문)/.test(q))
    return "SELECT count(*)::int AS order_count FROM orders";
  if (/(사용자|회원|유저).*(수|몇|명)/.test(q))
    return "SELECT count(DISTINCT user_id)::int AS user_count FROM orders";

  // breakdowns / aggregates
  if (/상태별|status/i.test(q))
    return "SELECT status, count(*)::int AS n FROM orders GROUP BY status ORDER BY status";
  if (/평균/.test(q) && /(금액|매출|결제)/.test(q))
    return "SELECT round(avg(amount))::int AS avg_amount FROM orders";
  if (/(총|합계|전체)/.test(q) && /(금액|매출|결제)/.test(q))
    return "SELECT sum(amount)::int AS total_amount FROM orders";

  return null; // decline -> LLM fallback (or no SQL candidates)
}

// ---------- CompanyX (sponsor dataset) ----------

/** Schema card for the sponsor's Company-X dataset, generated from the official
 * sql/01-schema.sql: table -> columns, FK arrows, and the ENUM-like value
 * vocabulary actually present in the data (status / priority / quarter / category).
 * The VALUES matter as much as the types here: a 7B that does not know a quarter
 * looks like '2025-Q3' writes a syntactically perfect query that returns zero rows. */
export const COMPANYX_SCHEMA_DDL = [
  "companyx.departments(id, name)  -- 경영지원팀, 클라우드사업부, 보안솔루션팀, 데이터플랫폼팀, 기술지원팀, 영업팀",
  "companyx.employees(id, name, email, position, dept_id->departments.id, hire_date date, salary int, is_active bool)",
  "companyx.clients(id, name, industry, region, company_size['startup'|'mid'|'enterprise'], contact_name, contact_email, registered_at date, is_active bool)",
  "companyx.products(id, name, category['cloud'|'security'|'data'|'consulting'], description, price_monthly int, version, release_date date, status['active'|'beta'])",
  "companyx.contracts(id, client_id->clients.id, product_id->products.id, manager_id->employees.id, contract_type['subscription'|'project'|'maintenance'], amount int, start_date date, end_date date, status['active'|'completed'|'cancelled'])",
  "companyx.projects(id, name, client_id->clients.id, manager_id->employees.id, contract_id->contracts.id, status['planning'|'in_progress'|'completed'|'on_hold'], start_date date, end_date date, budget int, description)",
  "companyx.sales(id, contract_id->contracts.id, client_id->clients.id, product_id->products.id, amount int, sale_date date, quarter text 예:'2025-Q3', category['cloud'|'security'|'data'|'consulting'], region 예:'서울')",
  "companyx.support_tickets(id, client_id->clients.id, product_id->products.id, assignee_id->employees.id, title, description, priority['critical'|'high'|'medium'|'low'], status['open'|'in_progress'|'resolved'|'closed'], created_at timestamp, resolved_at timestamp)",
].join("\n");

/** 컬럼마다 뜻과 단위를 DDL 주석으로 붙인 스키마 카드(리원에이스 멘토링 09-22 제안).
 *
 * 한 줄 카드(COMPANYX_SCHEMA_DDL)는 컬럼 이름과 값 어휘만 준다. 7B 는 `amount` 가
 * 매출인지 계약액인지, 단위가 원인지 만원인지 모른 채 「5천만 원 이상」을
 * `amount >= 50000000` 으로 쓴다. 주석은 그 해석을 스키마 옆에 둔다.
 *
 * 금액 단위(만원)는 공식 DDL 에 없다. 제안서 문서가 금액을 만원으로 적고(DOC-031
 * 초기 구축비 7917만원), 테이블 값의 규모가 그와 같다(계약 480~11000, 연봉
 * 3736~9520). 그래서 「만원」은 데이터에서 읽은 것이지 사업자가 명시한 것이 아니다. */
export const COMPANYX_SCHEMA_ANNOTATED = [
  "CREATE TABLE companyx.departments (",
  "  id int PRIMARY KEY,",
  "  name text,      -- 부서명: 경영지원팀, 클라우드사업부, 보안솔루션팀, 데이터플랫폼팀, 기술지원팀, 영업팀",
  "  head_id int     -- 부서장 = employees.id",
  ");",
  "CREATE TABLE companyx.employees (",
  "  id int PRIMARY KEY,",
  "  name text,      -- 직원 이름(한글)",
  "  email text,     -- 직원 업무 메일",
  "  position text,  -- 직급: 사원, 대리, 과장, 차장, 부장, 이사",
  "  dept_id int REFERENCES companyx.departments(id),  -- 소속 부서",
  "  hire_date date, -- 입사일",
  "  salary int,     -- 연봉, 단위 만원 (연봉 5천만 원 = 5000)",
  "  is_active bool  -- 재직 중이면 true, 퇴사자는 false",
  ");",
  "CREATE TABLE companyx.clients (",
  "  id int PRIMARY KEY,",
  "  name text,          -- 고객사명: Client-A … Client-AD",
  "  industry text,      -- 업종: 제조업, 금융, 의료/바이오, 공공기관, 유통/물류, IT/SW, 교육, 에너지, 건설, 미디어",
  "  region text,        -- 고객사 소재 지역: 서울, 경기, 인천, 부산, 대구, 대전, 광주, 제주",
  "  company_size text,  -- 규모: 'startup' | 'mid' | 'enterprise'",
  "  contact_name text,  -- 고객사 쪽 연락 담당자 이름(우리 직원 아님)",
  "  contact_email text, -- 고객사 쪽 연락 메일",
  "  registered_at date, -- 고객사로 등록된 날(신규 고객 = 이 날짜 기준)",
  "  is_active bool      -- 거래 중이면 true",
  ");",
  "CREATE TABLE companyx.products (",
  "  id int PRIMARY KEY,",
  "  name text,          -- 제품명: Product-C1 … Product-T2",
  "  category text,      -- 'cloud' | 'security' | 'data' | 'consulting' (보안 솔루션 = 'security')",
  "  description text,",
  "  price_monthly int,  -- 월 이용료, 단위 만원 (월 150만 원 = 150)",
  "  version text,",
  "  release_date date,  -- 출시일",
  "  status text         -- 'active' | 'beta'",
  ");",
  "CREATE TABLE companyx.contracts (",
  "  id int PRIMARY KEY,",
  "  client_id int REFERENCES companyx.clients(id),",
  "  product_id int REFERENCES companyx.products(id),",
  "  manager_id int REFERENCES companyx.employees(id),  -- 계약 담당 직원",
  "  contract_type text, -- 'subscription' | 'project' | 'maintenance'",
  "  amount int,         -- 계약 금액, 단위 만원(매출 아님, 1억 원 = 10000)",
  "  start_date date,",
  "  end_date date,      -- 종료일, 없으면 NULL",
  "  status text         -- 'active' | 'completed' | 'cancelled' (활성 계약 = 'active')",
  ");",
  "CREATE TABLE companyx.projects (",
  "  id int PRIMARY KEY,",
  "  name text,          -- 프로젝트명: 'Client-J 모니터링 시스템 도입' 형식",
  "  client_id int REFERENCES companyx.clients(id),",
  "  manager_id int REFERENCES companyx.employees(id),  -- 프로젝트 담당(리드) 직원",
  "  contract_id int REFERENCES companyx.contracts(id),",
  "  status text,        -- 'planning' | 'in_progress' | 'completed' | 'on_hold' (보류 = 'on_hold')",
  "  start_date date,",
  "  end_date date,      -- 종료(예정)일, 없으면 NULL",
  "  budget int,         -- 예산, 단위 만원 (1억 원 = 10000)",
  "  description text",
  ");",
  "CREATE TABLE companyx.sales (",
  "  id int PRIMARY KEY,",
  "  contract_id int REFERENCES companyx.contracts(id),",
  "  client_id int REFERENCES companyx.clients(id),",
  "  product_id int REFERENCES companyx.products(id),",
  "  amount int,         -- 매출액, 단위 만원(한 건의 매출)",
  "  sale_date date,     -- 매출 발생일",
  // 「분기: '2025-Q3' 형식」만 있을 때 7B 는 연도, 상반기 질문에도 예시 값을 그대로 넣었다
  // (홀드아웃3 「부산 쪽 2025년 장사」 quarter = '2025-Q3', 「2026년 상반기 제일 돈 잘 들어온 달」
  // quarter LIKE '2026-Q1'). 기간 조건을 어느 칸에 거는지 SQL 로 적는다(티켓 상태 줄과 같은 방식).
  "  quarter text,       -- 분기: '2025-Q3' 형식. 분기를 물을 때만 쓴다. 연도, 월, 상반기는 sale_date 로 건다(2025년 = sale_date >= '2025-01-01' AND sale_date < '2026-01-01')",
  "  category text,      -- 매출 제품의 분류: 'cloud' | 'security' | 'data' | 'consulting'",
  "  region text         -- 매출 지역: '서울' 등(clients.region 과 같은 값)",
  ");",
  "CREATE TABLE companyx.support_tickets (",
  "  id int PRIMARY KEY,",
  "  client_id int REFERENCES companyx.clients(id),   -- 티켓을 올린 고객사",
  "  product_id int REFERENCES companyx.products(id), -- 문제가 난 제품",
  "  assignee_id int REFERENCES companyx.employees(id), -- 처리 담당 직원",
  "  title text,",
  "  description text,",
  "  priority text,      -- 'critical' | 'high' | 'medium' | 'low' (소문자)",
  // 괄호 속 「미해결 = open, in_progress」만 있을 때 7B 는 「아직 해결되지 않은」을
  // status = 'open' 하나로 썼다(사업자 예시 7번, 5건 중 1건). 조건을 SQL 그대로 적으면
  // IN ('open','in_progress') 로 쓴다(2026-10-01, 문구 넷을 같은 시드로 비교).
  // 시도했다가 되돌린 것(2026-10-01): 「해결된 티켓 = status IN ('resolved','closed')」, 「해결까지 걸린
  // 시간 = resolved_at - created_at」을 덧붙였다. 겨냥한 홀드아웃3 문항은 그대로 status = 'resolved' 와
  // 초 단위였고, 사업자 예시 7번이 created_at, resolved_at 열을 더 고르게 돼 행이 넓어지고 컨텍스트 예산에
  // 다섯째 티켓이 잘려 정답에서 빠졌다(답변 채점 28 → 27). report §0.16.
  "  status text,        -- 'open'(접수) | 'in_progress'(처리 중) | 'resolved'(해결) | 'closed'(종결). 미해결(해결되지 않은) 티켓 = status IN ('open','in_progress')",
  "  created_at timestamp,  -- 접수 시각",
  "  resolved_at timestamp  -- 해결 시각, 미해결이면 NULL",
  ");",
].join("\n");

/** 생성과 수리가 같은 카드를 쓴다. 기본은 주석 카드이고 SQL_CARD=compact 로 종전 한 줄
 * 카드를 켠다(ablation).
 *
 * 기본값을 바꾼 근거(2026-09-30): 사업자 10문항과 홀드아웃3 정형 20문항에서 주석 카드는
 * 한 줄 카드와 사업자 7/10 동률, 홀드아웃3 11/20 대 9/20(질문이 묻지 않은 id 열을 뺀
 * 채점). 주석 카드만 맞힌 3문항, 한 줄 카드만 맞힌 1문항이고 그 1문항은 「연봉 4천」을
 * 4 로 읽은 단위 문제라 금액 주석에 환산 예시를 붙였다. 개발용 세트에서 고른 것이므로
 * 효과는 봉인 홀드아웃4 로 따로 잰다. */
export function companyxSchemaCard(): string {
  return process.env.SQL_CARD === "compact" ? COMPANYX_SCHEMA_DDL : COMPANYX_SCHEMA_ANNOTATED;
}

/** Company-X NL2SQL 프롬프트 원문.
 *
 * MCP 프롬프트 표면(prompts.ts)이 이 함수를 그대로 부른다. 종전에는 저쪽에
 * 손으로 베낀 요약본이 있었고, 실제 프롬프트에만 있는 "테이블은 반드시
 * companyx. 접두사" 같은 규칙이 노출본에서 빠져 있었다. 노출본과 실행본이
 * 갈리면 심사자가 보는 것은 서버가 쓰는 것이 아니다. */
export function buildCompanyxSqlPrompt(query: string): string {
  return [
    "다음은 PostgreSQL 스키마입니다(모든 테이블은 companyx 스키마에 있음).",
    companyxSchemaCard(),
    "",
    "질문에 답하는 단일 읽기 전용 SQL(SELECT) 한 문장만 출력하세요.",
    "테이블은 반드시 companyx. 접두사로 참조합니다. 설명/주석/코드펜스/세미콜론 없이 SQL만 출력.",
    "사람이 읽을 답을 돌려주세요: 부서·고객사·제품·직원을 물으면 id가 아니라 name을 조인해 반환합니다.",
    // 시도했다가 되돌린 것: "부정 조건에는 != 대신 IN으로 값을 나열하라"는 열거형
    // 규칙을 프롬프트에 넣어 봤다(2026-07-29). CX-SQL-07의 `status != 'resolved'`가
    // closed까지 끌어오는 실패를 겨냥했는데, 재실행 결과 같은 SQL이 그대로 나왔고
    // 점수도 8/10과 7/10로 변하지 않았다. 효과 없는 문장을 프롬프트에 남기면
    // "튜닝 없음"이라는 주장만 흐려지므로 되돌린다. 근거는 docs/report.md §0.10.
    "",
    `질문: ${query}`,
    "SQL:",
  ].join("\n");
}

/** 생성 모델(기본 Qwen2.5-Coder-7B) NL->SQL over the sponsor's Company-X schema. */
export async function companyxNL2SQL(query: string, report?: Nl2SqlReport): Promise<string | null> {
  const raw = await generate(buildCompanyxSqlPrompt(query));
  return pickSql(raw, report);
}

/** One deterministic repair attempt: feed the database's OWN error back.
 *
 * Observed on the sponsor's questions: the model invented `contracts.is_active`
 * (the column is `status`), PostgreSQL rejected it, and the pipeline handed the
 * 7B an EMPTY context — "현재 활성 상태인 계약 수" became "알 수 없습니다" even though
 * the data was right there. The retry is rule-driven (retry iff the engine raised
 * an error, exactly once, no scoring or sampling), so the tuning-free claim holds:
 * there is no threshold to tune, and a query that executes is never retried. */
export async function repairSql(
  query: string,
  failedSql: string,
  dbError: string,
  realColumns?: string,
  kind: "error" | "empty" = "error",
): Promise<string | null> {
  // 0행 수리는 거부가 아니라 필터 점검이다. 오류 전용 문장(「지목한 컬럼은 없다」)을 주면
  // 멀쩡한 컬럼을 바꾸라는 뜻으로 읽힌다.
  const intro =
    kind === "empty"
      ? [
          "아래 SQL은 실행됐지만 결과가 0행입니다. 아래 안내를 보고 조건을 고친 SQL 한 문장만 출력하세요.",
          "아래 실제 컬럼 목록에 있는 컬럼만 씁니다.",
        ]
      : [
          "아래 SQL이 데이터베이스에서 오류로 거부되었습니다. 오류 메시지를 보고 고친 SQL 한 문장만 출력하세요.",
          "오류가 지목한 컬럼은 이 데이터베이스에 존재하지 않습니다. 테이블 이름을 앞에 붙여도 생기지 않습니다.",
          "아래 실제 컬럼 목록에 있는 컬럼만 쓰고, 의미가 비슷한 다른 컬럼으로 대체하세요.",
        ];
  const prompt = [
    "다음은 PostgreSQL 스키마입니다(모든 테이블은 companyx 스키마에 있음).",
    companyxSchemaCard(),
    "",
    ...intro,
    "설명/주석/코드펜스/세미콜론 없이 SQL만 출력.",
    ...(realColumns ? ["", "[이 쿼리가 참조한 테이블의 실제 컬럼]", realColumns] : []),
    "",
    `질문: ${query}`,
    `실패한 SQL: ${failedSql}`,
    `${kind === "empty" ? "안내" : "오류"}: ${dbError}`,
    "수정된 SQL:",
  ].join("\n");
  const raw = await generate(prompt);
  return extractSql(raw);
}

/** Ablation baseline: bare table names only (no columns, no value vocabulary).
 * Isolates the contribution of the curated schema card on the sponsor's own data. */
export const COMPANYX_SCHEMA_NAIVE = [
  "companyx.departments",
  "companyx.employees",
  "companyx.clients",
  "companyx.products",
  "companyx.contracts",
  "companyx.projects",
  "companyx.sales",
  "companyx.support_tickets",
].join("\n");

export async function companyxNL2SQLNaive(query: string): Promise<string | null> {
  const prompt = [
    "다음 PostgreSQL 테이블이 있습니다(모두 companyx 스키마).",
    COMPANYX_SCHEMA_NAIVE,
    "",
    "질문에 답하는 단일 읽기 전용 SQL(SELECT) 한 문장만 출력하세요.",
    "테이블은 반드시 companyx. 접두사로 참조합니다. 설명/주석/코드펜스/세미콜론 없이 SQL만 출력.",
    "",
    `질문: ${query}`,
    "SQL:",
  ].join("\n");
  const raw = await generate(prompt);
  return extractSql(raw);
}
