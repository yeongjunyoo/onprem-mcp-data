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

// air integration smoke test — drives tools through server.callTool(), which
// runs the full middleware + plugin chain (timeout/retry/circuit-breaker).
// Run after build: node dist/server.test.js  (requires db up + embeddings).
import { buildServer } from "./server.js";
import { getPool, closePool } from "./db.js";
import { embedDocuments } from "./vector.js";
import { getEmbedder } from "./embedder.js";

let pass = 0, fail = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { pass++; } else { fail++; console.error("  FAIL:", msg); }
}

async function main() {
  await embedDocuments(getPool(), getEmbedder()); // ensure vector side is populated
  const server = buildServer();

  const tools = server.tools().map((t) => t.name).sort();
  // 도구는 8종이다. audit.explain이 추가됐는데 이 목록이 7종에 멈춰 있어서
  // 테스트가 조용히 깨져 있었다(DB가 필요해 오프라인 CI가 잡지 못했다).
  ok(JSON.stringify(tools) === JSON.stringify(["ask", "audit.explain", "graph.expand", "ontology.search", "retrieve", "route", "sql.query", "vector.search"]),
    `tools registered (got ${JSON.stringify(tools)})`);

  const r = JSON.parse(await server.callTool("route", { query: "최근 주문 건수 알려줘" }));
  ok(r.route === "structured" && r.deterministic === true, "route tool via callTool");

  const s = JSON.parse(await server.callTool("sql.query", { sql: "SELECT count(*)::int AS n FROM orders" }));
  ok(s.ok && Number(s.rows[0]?.n) === 5, "sql.query tool via callTool");

  const writeBlocked = JSON.parse(await server.callTool("sql.query", { sql: "DELETE FROM orders" }));
  ok(!writeBlocked.ok, "sql.query blocks writes via callTool");

  const v = JSON.parse(await server.callTool("vector.search", { query: "환불 정책", k: 2 }));
  ok(v.ok && v.hits.length === 2 && v.hits[0].title === "환불 정책", "vector.search tool via callTool");

  // stdio 클라이언트가 입력을 닫으면 서버가 스스로 끝난다(index.ts). 기동 줄을 본 뒤 입력을 닫고 종료를 기다린다
  {
    const { spawn } = await import("node:child_process");
    const { fileURLToPath } = await import("node:url");
    const child = spawn(process.execPath, [fileURLToPath(new URL("./index.js", import.meta.url))], { stdio: ["pipe", "pipe", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    const started = await new Promise<boolean>((res) => {
      const timer = setTimeout(() => res(false), 120_000);
      child.stderr.on("data", () => {
        if (err.includes("[air] Starting")) {
          clearTimeout(timer);
          res(true);
        }
      });
      child.on("exit", () => {
        clearTimeout(timer);
        res(false);
      });
    });
    ok(started, `서버가 기동한다 (stderr ${err.slice(-200)})`);
    const t0 = Date.now();
    child.stdin.end();
    const code = await new Promise<number | null>((res) => {
      const timer = setTimeout(() => {
        child.kill();
        res(null);
      }, 15_000);
      child.on("exit", (c) => {
        clearTimeout(timer);
        res(c);
      });
    });
    ok(code === 0, `입력을 닫으면 서버가 종료 코드 0 으로 끝난다 (got ${code}, ${Date.now() - t0}ms)`);
  }

  await closePool();
  console.log(`\nserver.test: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
