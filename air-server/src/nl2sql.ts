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
