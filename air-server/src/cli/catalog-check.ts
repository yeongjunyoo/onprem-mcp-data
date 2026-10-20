// Copyright 2026 Yeongjun Yoo
// SPDX-License-Identifier: Apache-2.0
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// 다른 회사 DB 점검: 점검 세트의 질문을 서버(dist/index.js)에 MCP 클라이언트처럼 stdio 로 한 번씩 묻고(ask) 채점한다(catalogcheck.ts).
// 서버는 셸의 환경(DATASET=catalog, CATALOG_SCHEMA, DATABASE_URL …)을 그대로 받는다. 지금 그 DB 의 카드가 주석 카드인지 열 이름 카드인지도
// 같은 함수로 재서 결과에 남긴다.
//
// 사용: npm run catalog:check -- --set eval/catalog/chinook_check_v1.jsonl --out eval/results/catalog-chinook-plain.json --label 주석 없음
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { laneTablesIn } from "../catalog.js";
import { hasValue, parseCheckSet, rowsCover, rowsExact, type CheckItem } from "../catalogcheck.js";
import { closePool, getPool } from "../db.js";
import { McpStdioClient, splitAnswer, toolPayload } from "../demoweb.js";
import { loadCatalogSchemaCard } from "../nl2sql.js";
import { profile } from "../profile.js";

const here = dirname(fileURLToPath(import.meta.url));
const VERSION: string = JSON.parse(await readFile(resolve(here, "..", "..", "package.json"), "utf8")).version;
const ASK_TIMEOUT_MS = 300_000;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

interface Result {
  id: string;
  difficulty: string;
  question: string;
  ms: number;
  error?: string;
  route?: string;
  rationale?: string;
  sql: string | null;
  sql_error?: string;
  refused?: string;
  answer: string;
  columns: string[];
  rows: string[][];
  row_count: number;
  must: string[];
  must_missing: string[];
  answer_ok: boolean;
  rows_exact: boolean;
  rows_cover: boolean;
}

interface Audit {
  routing?: { rationale?: string };
  retrieval?: { sql?: { text?: string | null; error?: string; refused?: { kind?: string } } };
}

async function main() {
  const setPath = arg("--set");
  const outPath = arg("--out");
  if (!setPath || !outPath) {
    console.error("사용: npm run catalog:check -- --set <점검 세트.jsonl> --out <결과.json> [--label <이름>]");
    process.exitCode = 2;
    return;
  }
  const raw = await readFile(resolve(setPath), "utf8");
  const items: CheckItem[] = parseCheckSet(raw);
  const ds = profile();

  // 서버가 기동 때 만드는 것과 같은 카드를 여기서도 만들어 종류만 기록한다(읽기만 한다).
  const card = ds.name === "catalog" ? await loadCatalogSchemaCard(getPool(), ds.sqlSchema, laneTablesIn(ds)) : null;
  await closePool();

  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of ["MCP_TRANSPORT", "MCP_PORT", "MCP_HOST", "MCP_ALLOWED_ORIGINS"]) delete env[k];
  // 다 묻고 닫을 때의 종료는 정상이다. 그 전에 끝나면 사유와 서버 stderr 끝부분을 찍는다.
  let closing = false;
  const client = new McpStdioClient(process.execPath, [resolve(here, "..", "index.js")], env, (reason, stderr) => {
    if (!closing) console.error(`${reason}. 서버 stderr 끝부분:\n${stderr.slice(-1500)}`);
  });
  const results: Result[] = [];
  try {
    await client.request(
      "initialize",
      { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "onprem-mcp-data catalog-check", version: VERSION } },
      ASK_TIMEOUT_MS,
    );
    client.notify("notifications/initialized");
    for (const q of items) {
      const t0 = Date.now();
      const reply = await client.request("tools/call", { name: "ask", arguments: { query: q.question } }, ASK_TIMEOUT_MS);
      const ms = Date.now() - t0;
      const { isError, value } = toolPayload(reply.result as Record<string, unknown> | undefined);
      const v = (typeof value === "object" && value !== null ? value : {}) as { answer?: string; route?: string; audit?: Audit };
      const { text, rows } = splitAnswer(v.answer ?? (typeof value === "string" ? value : ""));
      const got = rows?.rows ?? [];
      const missing = q.must.filter((m) => !hasValue(text, m));
      const sql = v.audit?.retrieval?.sql;
      const r: Result = {
        id: q.id,
        difficulty: q.difficulty,
        question: q.question,
        ms,
        error: isError || reply.error ? (typeof value === "string" ? value : JSON.stringify(reply.error ?? value)) : undefined,
        route: v.route,
        rationale: v.audit?.routing?.rationale,
        sql: sql?.text ?? null,
        sql_error: sql?.error,
        refused: sql?.refused?.kind,
        answer: text,
        columns: rows?.columns ?? [],
        rows: got,
        row_count: rows?.count ?? 0,
        must: q.must,
        must_missing: missing,
        answer_ok: missing.length === 0,
        rows_exact: rowsExact(got, q.gold_rows),
        rows_cover: rowsCover(got, q.gold_rows),
      };
      results.push(r);
      const mark = (b: boolean) => (b ? "O" : "X");
      console.log(`${q.id} ${q.difficulty.padEnd(6)} 답 ${mark(r.answer_ok)} 행 ${mark(r.rows_cover)} [${r.route}, ${ms}ms] ${q.question}`);
      if (!r.answer_ok) console.log(`      빠진 값 ${JSON.stringify(missing)} | 답: ${text.replace(/\n/g, " / ").slice(0, 160)}`);
    }
  } finally {
    closing = true;
    await client.close();
  }

  const count = (k: "answer_ok" | "rows_exact" | "rows_cover", rs = results) => rs.filter((r) => r[k]).length;
  const byDifficulty: Record<string, { n: number; answer_ok: number; rows_cover: number }> = {};
  for (const d of [...new Set(results.map((r) => r.difficulty))]) {
    const rs = results.filter((r) => r.difficulty === d);
    byDifficulty[d] = { n: rs.length, answer_ok: count("answer_ok", rs), rows_cover: count("rows_cover", rs) };
  }
  const summary = { n: results.length, answer_ok: count("answer_ok"), rows_exact: count("rows_exact"), rows_cover: count("rows_cover"), by_difficulty: byDifficulty };
  const out = {
    generated_at: new Date().toISOString(),
    label: arg("--label") ?? null,
    server_version: VERSION,
    dataset: ds.name,
    schema: ds.sqlSchema,
    database: (() => {
      try {
        const u = new URL(process.env.DATABASE_URL ?? "");
        return `${u.hostname}:${u.port || "5432"}/${u.pathname.replace(/^\//, "")}`;
      } catch {
        return null;
      }
    })(),
    model: process.env.OLLAMA_MODEL ?? "qwen2.5-coder:7b",
    card: card && { kind: card.kind, tables: card.tables, columns: card.columns, omitted: card.omitted.length, reason: card.reason ?? null },
    // 해시는 줄바꿈을 LF 로 맞춘 내용으로 낸다. Windows 에서 클론하면 세트 파일이 CRLF 로 체크아웃된다.
    set: { path: setPath.replace(/\\/g, "/"), sha256: createHash("sha256").update(raw.replace(/\r\n/g, "\n")).digest("hex"), items: items.length },
    scoring: "catalogcheck.ts: answer_ok = 답 문장에 must 값이 모두 있다, rows_exact = 행이 정답과 같다, rows_cover = 행 수가 같고 정답 행의 값을 모두 담는다",
    summary,
    results,
  };
  await mkdir(dirname(resolve(outPath)), { recursive: true });
  await writeFile(resolve(outPath), JSON.stringify(out, null, 2) + "\n", "utf8");
  console.log(`\n답 ${summary.answer_ok}/${summary.n}, 행 ${summary.rows_cover}/${summary.n}(정확히 같음 ${summary.rows_exact}) → ${outPath}`);
}

main().catch(async (e) => {
  console.error(e instanceof Error ? `Error: ${e.message}` : e);
  await closePool();
  process.exitCode = 1;
});
