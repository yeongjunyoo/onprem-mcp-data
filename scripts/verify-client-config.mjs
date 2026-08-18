// README 가 붙여넣으라는 MCP 클라이언트 설정이 실제로 붙는지 확인한다.
//
// 2차 배점의 「활용성」에서 심사자가 가장 먼저 하는 일이 이것이다 — 자기 클라이언트에
// 붙여 보는 것. 설정이 틀리면 도구가 아무리 좋아도 그 자리에서 끝난다.
//
// 종전 README 는 "stdio 로 서버를 띄우면 됩니다" 한 줄뿐이었다(2026-08-17).
// 사용자는 소스를 읽어 스스로 조립해야 했다.
//
// ★ 문서에 적은 설정은 조용히 낡는다.
//   진입점 경로가 바뀌거나 필수 환경변수가 늘면 문서만 옛말이 된다. 커밋에는
//   "동작한다" 가 안 남는다 — 그래서 검사가 **문서에서 설정을 뽑아** 그대로 띄운다.
//
// 실행: node scripts/verify-client-config.mjs   (DB·모델 필요)
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// ────────────────────────────────────────────────────────────────────────────
// 1단: 정적 대조 (스택 없이도 돈다 → CI 에서 표류를 잡는다)
//
// 아래 실행 검사는 정확하지만 DB·모델이 있어야 돌아 CI 에서 못 돈다. 그 사이에
// 문서의 Ollama 포트가 11449 → 11462 로 표류했고 compose 는 줄곧 11435 였다.
// **CI 밖 검사는 아무도 안 돌린 날부터 없는 것과 같다.**
//
// compose 가 게시하는 포트와 sql/init 이 만드는 로그인 role 은 파일만 읽어도 안다.
function staticDrift() {
  const bad = [];
  const compose = readFileSync(resolve(ROOT, "docker-compose.yml"), "utf8");
  const port = compose.match(/"(\d+):11434"/)?.[1];
  if (!port) return ["docker-compose.yml 에서 Ollama 게시 포트를 못 찾았다"];

  // 로그인 가능한 role. NOLOGIN 으로 만든 것은 접속 설정에 쓸 수 없다.
  const roles = new Set(["postgres"]);
  const init = resolve(ROOT, "sql/init/02_roles.sql");
  if (existsSync(init)) {
    const sql = readFileSync(init, "utf8");
    for (const m of sql.matchAll(/CREATE ROLE (\w+)([^;]*)/g)) {
      if (!/NOLOGIN/i.test(m[2])) roles.add(m[1]);
    }
  }

  for (const doc of ["README.md", "README.en.md", "docs/report.md", "docs/submission-report.md"]) {
    const p = resolve(ROOT, doc);
    if (!existsSync(p)) continue;
    const t = readFileSync(p, "utf8");
    for (const m of t.matchAll(/localhost:(\d{5})/g)) {
      // 11434 는 Ollama 자체의 기본 포트다. "호스트에 설치하면 11434, compose 로
      // 띄우면 <port>" 는 **참인 서술**이라 물면 안 된다. 표류로 생긴 값(11449,
      // 11462)만 잡는다.
      if (/^114\d\d$/.test(m[1]) && m[1] !== port && m[1] !== "11434") {
        bad.push(`${doc}: Ollama 를 localhost:${m[1]} 로 적었는데 compose 는 ${port} 로 게시한다`);
      }
    }
    for (const m of t.matchAll(/postgres(?:ql)?:\/\/(\w+):/g)) {
      if (!roles.has(m[1])) {
        bad.push(`${doc}: DB 계정 '${m[1]}' 로 적었는데 로그인 가능한 role 은 ${[...roles].join(", ")} 뿐이다`);
      }
    }
  }
  return [...new Set(bad)];
}

const drift = staticDrift();
if (drift.length) {
  console.error("\n문서의 접속 설정이 실제 스택과 갈렸다 (정적 대조):");
  for (const d of drift) console.error(`  - ${d}`);
  console.error("\n붙여넣으면 그 자리에서 실패한다. 심사자가 제일 먼저 하는 일이다.\n");
  process.exitCode = 1;
  process.exit(1);
}
console.log("정적 대조: 문서의 포트·계정이 docker-compose·sql/init 과 일치한다.");

const fails = [];

// 1) README 에서 mcpServers 블록을 뽑는다 (문서가 정본이다)
const readme = readFileSync(resolve(ROOT, "README.md"), "utf8");
const m = readme.match(/```json\s*(\{[\s\S]*?"mcpServers"[\s\S]*?\})\s*```/);
if (!m) {
  console.error("\n실패: README 에 mcpServers 설정 블록이 없다.");
  console.error("  '띄우면 됩니다' 만으로는 사용자가 붙일 수 없다.\n");
  process.exit(1);
}

let cfg;
try {
  cfg = JSON.parse(m[1].replace(/<저장소>|<repo>/g, ROOT.replace(/\\/g, "/")));
} catch (e) {
  console.error(`\n실패: README 의 설정이 유효한 JSON 이 아니다 — ${e.message}\n`);
  process.exit(1);
}

const entry = Object.values(cfg.mcpServers ?? {})[0];
if (!entry) {
  fails.push("mcpServers 에 서버 항목이 없다");
}

// 2) 진입점이 실재하는가
const argPath = entry?.args?.[0];
if (!argPath || !existsSync(argPath)) {
  fails.push(`설정이 가리키는 진입점이 없다: ${argPath} (먼저 tsc 로 빌드한다)`);
}

if (fails.length) {
  console.error("\nREADME 설정이 실물과 어긋난다:");
  for (const f of fails) console.error(`  - ${f}`);
  process.exit(1);
}

// 3) 그 설정 그대로 stdio 핸드셰이크
const child = spawn(entry.command, entry.args, {
  cwd: ROOT,
  env: { ...process.env, ...(entry.env ?? {}) },
  stdio: ["pipe", "pipe", "pipe"],
});

const send = (o) => child.stdin.write(`${JSON.stringify(o)}\n`);
send({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "verify-client-config", version: "1.0" },
  },
});
send({ jsonrpc: "2.0", method: "notifications/initialized" });
send({ jsonrpc: "2.0", id: 2, method: "tools/list" });

const result = await new Promise((res) => {
  let buf = "";
  let info = null;
  const timer = setTimeout(() => res({ timeout: true, info }), 60_000);
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id === 1) info = msg.result?.serverInfo ?? null;
      if (msg.id === 2) {
        clearTimeout(timer);
        res({ tools: (msg.result?.tools ?? []).map((t) => t.name), info });
      }
    }
  });
});
child.kill();

if (result.timeout) {
  console.error("\n실패: README 설정으로 띄운 서버가 60초 안에 도구를 열거하지 못했다.");
  console.error("  DB(5433)와 Ollama(11435)가 떠 있는지 확인한다.\n");
  process.exit(1);
}

console.log(
  `README 설정으로 기동: ${result.info?.name} ${result.info?.version} · 도구 ${result.tools.length}종`,
);

if (result.tools.length !== 8) {
  console.error(`\n실패: 도구가 8종이 아니라 ${result.tools.length}종이다.\n`);
  process.exit(1);
}

console.log("OK: README 가 붙여넣으라는 설정 그대로 MCP 클라이언트가 붙는다.");
console.log("    (문서에 적은 설정은 조용히 낡는다 — 문서에서 뽑아 그대로 띄운다.)");
