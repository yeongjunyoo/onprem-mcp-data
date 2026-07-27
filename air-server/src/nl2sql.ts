// NL -> SQL for the structured retrieval path.
//
// Two strategies share this interface so the pipeline is agnostic:
//   templateNL2SQL — a deterministic fast-path for the seed orders domain (no
//                    LLM, zero variance). Handles the common, unambiguous
//                    intents and returns null otherwise (deferring to the LLM).
//   llmNL2SQL      — Qwen2.5-7B generates SQL from the live schema (added in the
//                    LLM increment). Measured honestly by the execution-match eval.
//
// Returning null = "I decline; let the next strategy try."

export type NL2SQL = (query: string) => Promise<string | null> | string | null;

import { generate } from "./llm.js";
import { isReadOnly } from "./sql.js";

/** Schema description handed to the model for NL2SQL. */
export const SCHEMA_DDL = [
  "orders(id int, user_id int, status text, amount int, created_at date)",
  "  -- status ∈ {'paid','cancelled','refunded'}",
  "documents(id int, title text, body text, embedding vector)",
].join("\n");

/** Strip code fences / prose and keep the first read-only SQL statement. */
export function extractSql(raw: string): string | null {
  let s = raw.trim();
  const fence = s.match(/```(?:sql)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  s = s.replace(/^sql\s*[:\n]/i, "").trim();
  // take from the first SELECT/WITH to the first semicolon (or end)
  const m = s.match(/\b(select|with)\b[\s\S]*?(?=;|$)/i);
  if (!m) return null;
  const sql = m[0].trim();
  return isReadOnly(sql) ? sql : null;
}

/** Qwen2.5-7B generates a single read-only SQL from the schema + question.
 * This is the path measured (non-circularly) by the execution-match eval. */
export async function llmNL2SQL(query: string): Promise<string | null> {
  const prompt = [
    "다음은 PostgreSQL 스키마입니다.",
    SCHEMA_DDL,
    "",
    "질문에 답하는 단일 읽기 전용 SQL(SELECT) 한 문장만 출력하세요.",
    "설명, 주석, 코드펜스, 세미콜론 없이 SQL만 출력합니다.",
    "",
    `질문: ${query}`,
    "SQL:",
  ].join("\n");
  const raw = await generate(prompt);
  return extractSql(raw);
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

/** Qwen2.5-7B NL->SQL over the bench schema (benchmark headline path, Gate5). */
export async function benchNL2SQL(query: string): Promise<string | null> {
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
  return extractSql(raw);
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

/** Qwen2.5-7B NL->SQL over the sponsor's Company-X schema. */
export async function companyxNL2SQL(query: string): Promise<string | null> {
  const prompt = [
    "다음은 PostgreSQL 스키마입니다(모든 테이블은 companyx 스키마에 있음).",
    COMPANYX_SCHEMA_DDL,
    "",
    "질문에 답하는 단일 읽기 전용 SQL(SELECT) 한 문장만 출력하세요.",
    "테이블은 반드시 companyx. 접두사로 참조합니다. 설명/주석/코드펜스/세미콜론 없이 SQL만 출력.",
    "사람이 읽을 답을 돌려주세요: 부서·고객사·제품·직원을 물으면 id가 아니라 name을 조인해 반환합니다.",
    "",
    `질문: ${query}`,
    "SQL:",
  ].join("\n");
  const raw = await generate(prompt);
  return extractSql(raw);
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
): Promise<string | null> {
  const prompt = [
    "다음은 PostgreSQL 스키마입니다(모든 테이블은 companyx 스키마에 있음).",
    COMPANYX_SCHEMA_DDL,
    "",
    "아래 SQL이 데이터베이스에서 오류로 거부되었습니다. 오류 메시지를 보고 고친 SQL 한 문장만 출력하세요.",
    "오류가 지목한 컬럼은 이 데이터베이스에 존재하지 않습니다. 테이블 이름을 앞에 붙여도 생기지 않습니다.",
    "아래 실제 컬럼 목록에 있는 컬럼만 쓰고, 의미가 비슷한 다른 컬럼으로 대체하세요.",
    "설명/주석/코드펜스/세미콜론 없이 SQL만 출력.",
    ...(realColumns ? ["", "[이 쿼리가 참조한 테이블의 실제 컬럼]", realColumns] : []),
    "",
    `질문: ${query}`,
    `실패한 SQL: ${failedSql}`,
    `오류: ${dbError}`,
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
