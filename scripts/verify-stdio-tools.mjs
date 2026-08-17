// stdio 전송으로 MCP 도구 8종을 **실제로 호출**한다.
//
// 왜 필요한가. `demo` 는 파이프라인 함수를 직접 부른다. 그래서 MCP 의 입력·출력
// 스키마 검증을 **거치지 않는다.** 심사자가 Claude Desktop 에 붙일 때 쓰는 경로는
// stdio 이고, 거기서는 검증을 거친다.
//
// 실제로 이 검사가 결함을 찾았다(2026-08-17):
//   route 의 outputSchema 가 배열 넷을 `type: "object"` 로 선언해 두어
//   MCP 가 "Expected object, received array" 로 **도구 호출 자체를 거부**했다.
//   demo 는 초록이었고, sse 핸드셰이크 검사도 열거만 해서 못 잡았다.
//
// ★ 열거되는 것과 호출되는 것은 다르다.
//   tools/list 가 8종을 보여 준다고 8종이 동작하는 것이 아니다.
//
// 실행: node scripts/verify-stdio-tools.mjs
// 필요: docker compose up -d (DB + Ollama 모델 2종)
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 각 도구를 부를 최소 인자. 인자가 틀리면 입력 검증에서 걸리므로 이것도 계약이다. */
const CALLS = [
  ["route", { query: "환불된 주문은 몇 건인가?" }],
  ["sql.query", { sql: "SELECT count(*)::int AS n FROM orders" }],
  ["vector.search", { query: "보안 정책", k: 3 }],
  ["retrieve", { query: "환불된 주문은 몇 건인가?" }],
  ["ontology.search", { query: "정책" }],
  ["graph.expand", { entityId: 1001, depth: 1 }],
  ["audit.explain", { query: "환불된 주문은 몇 건인가?" }],
  ["ask", { query: "환불된 주문은 몇 건인가?" }],
];

const env = { ...process.env };
delete env.MCP_TRANSPORT; // stdio 가 기본이다

const server = spawn(process.execPath, ["air-server/dist/index.js"], {
  cwd: ROOT,
  env,
  stdio: ["pipe", "pipe", "pipe"],
});

const responses = new Map();
let stdoutBuf = "";
server.stdout.on("data", (chunk) => {
  stdoutBuf += chunk;
  let nl;
  while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
    const line = stdoutBuf.slice(0, nl).trim();
    stdoutBuf = stdoutBuf.slice(nl + 1);
    if (!line.startsWith("{")) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined) responses.set(msg.id, msg);
    } catch {
      /* 부분 프레임 */
    }
  }
});
let stderrLog = "";
server.stderr.on("data", (d) => (stderrLog += d));

const send = (method, params, id) =>
  server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);

async function waitFor(id, seconds = 90) {
  for (let i = 0; i < seconds * 5; i++) {
    if (responses.has(id)) return responses.get(id);
    if (server.exitCode !== null) return undefined;
    await sleep(200);
  }
  return undefined;
}

let failure = null;
const broken = [];
try {
  for (let i = 0; i < 40 && !stderrLog.includes("Starting"); i++) await sleep(1000);
  if (!stderrLog.includes("Starting")) throw new Error("서버가 stdio 로 기동하지 않았다");

  send(
    "initialize",
    {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "verify-stdio-tools", version: "1" },
    },
    1,
  );
  if (!(await waitFor(1, 30))) throw new Error("initialize 응답이 없다");

  const listed = await (send("tools/list", {}, 2), waitFor(2, 30));
  const names = (listed?.result?.tools ?? []).map((t) => t.name).sort();
  console.log(`tools/list -> ${names.length}종`);
  if (names.length !== CALLS.length) {
    throw new Error(`도구 ${CALLS.length}종이어야 하는데 ${names.length}종`);
  }

  for (let i = 0; i < CALLS.length; i++) {
    const [name, args] = CALLS[i];
    send("tools/call", { name, arguments: args }, 10 + i);
    const r = await waitFor(10 + i);
    const blob = JSON.stringify(r ?? {});
    // MCP 는 스키마 위반을 result.content 안의 텍스트로 돌려주기도 한다.
    // 응답이 왔다는 것만으로 성공이라고 읽으면 이 결함을 놓친다.
    const bad = !r || r.error || blob.includes("MCP error") || blob.includes("validation error");
    console.log(`  ${name.padEnd(16)} ${bad ? "실패" : "OK"}`);
    if (bad) broken.push(`${name}: ${blob.slice(0, 200)}`);
  }
  if (broken.length) throw new Error(`MCP 전선에서 깨지는 도구 ${broken.length}종`);
} catch (err) {
  failure = err;
} finally {
  server.stdin.end();
  server.kill();
}

if (failure) {
  console.error(`\n실패: ${failure.message}`);
  for (const b of broken) console.error(`  - ${b}`);
  console.error("\ndocker compose up -d 로 DB 와 Ollama 모델 2종이 준비돼 있어야 한다.\n");
  process.exit(1);
}

console.log("\nOK: stdio 로 도구 8종이 전부 호출된다.");
console.log("    (열거되는 것과 호출되는 것은 다르다 — demo 는 이 검증을 안 거친다.)");
process.exit(0);
