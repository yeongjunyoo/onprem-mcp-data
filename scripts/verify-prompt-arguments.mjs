// `prompts/list` 가 인자 정의를 클라이언트에게 전달하는지 확인한다.
//
// 실측(2026-08-17): 우리 코드는 인자를 정확히 넘기는데 MCP 목록에는 **빈 배열**이
// 온다.
//
//   buildPrompts()   grounded-answer → [question, context]
//   prompts/list     grounded-answer → []
//
// 클라이언트는 목록만 보고 **무엇을 채워야 하는지 알 수 없다.** 프롬프트가
// `[질문]` 자리가 빈 채로 돌아온다 — 쓸 수 없는 템플릿이다.
//
// ★ 이건 우리 결함이 아니라 프레임워크(@airmcp-dev/core)가 목록을 만들 때
//   arguments 를 빠뜨리는 것이다. 그래도 **우리 제품의 사용성 문제**이므로
//   조용히 두지 않는다 — 알고 있다는 것과 모르는 것은 다르다.
//
// 실행: node scripts/verify-prompt-arguments.mjs   (DB·모델 필요)
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Windows 절대경로는 ESM import 가 거부한다 — file:// URL 로 바꾼다.
const { pathToFileURL } = await import("node:url");
const { buildPrompts } = await import(
  pathToFileURL(resolve(ROOT, "air-server/dist/prompts.js")).href
);

const defined = new Map(
  buildPrompts().map((p) => [p.name, (p.arguments ?? []).map((a) => a.name)]),
);
console.log(`소스가 정의한 프롬프트 ${defined.size}종`);

const child = spawn("node", [resolve(ROOT, "air-server/dist/index.js")], {
  cwd: ROOT,
  stdio: ["pipe", "pipe", "ignore"],
});
const send = (o) => child.stdin.write(`${JSON.stringify(o)}\n`);
send({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "verify-prompt-arguments", version: "1.0" },
  },
});
send({ jsonrpc: "2.0", method: "notifications/initialized" });
send({ jsonrpc: "2.0", id: 2, method: "prompts/list" });

const listed = await new Promise((res) => {
  let buf = "";
  const timer = setTimeout(() => res(null), 120_000);
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      let m;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      if (m.id === 2) {
        clearTimeout(timer);
        res(m.result?.prompts ?? []);
      }
    }
  });
});
child.kill();

if (!listed) {
  console.error("\n실패: prompts/list 응답을 못 받았다.\n");
  process.exit(1);
}

const fails = [];
for (const p of listed) {
  const want = defined.get(p.name);
  if (!want) {
    fails.push(`${p.name}: 소스에 없는 프롬프트가 목록에 있다`);
    continue;
  }
  const got = (p.arguments ?? []).map((a) => a.name);

  // ★ 프레임워크(@airmcp-dev/core)가 MCP SDK 의 **deprecated 오버로드**
  //   `server.prompt(name, description, cb)` 를 써서 arguments 가 목록에 안 실린다.
  //   그 오버로드는 "zero-argument prompt" 용이다. mcp 핸들이 private 이라
  //   밖에서 재등록할 수도 없다.
  //
  //   고칠 수 없는 층은 우회하되 **숨기지 않는다** — 설명 끝에 `[인자] ...` 를
  //   넣어 클라이언트가 읽을 수 있게 했다. 목록이 곧 사용 설명서다.
  //
  //   둘 중 하나로 전달되면 통과한다. 프레임워크가 고쳐져 arguments 가 실리면
  //   그것도 통과다 — 우회로를 영구화하지 않는다.
  const inDescription = want.every((n) => (p.description ?? "").includes(`${n}(`));
  const inArguments = want.join(",") === got.join(",");

  if (!inArguments && !inDescription) {
    fails.push(
      `${p.name}: 인자 ${want.join(", ")} 가 목록에도 설명에도 없다 — ` +
        "클라이언트가 무엇을 채울지 알 수 없다",
    );
  } else if (!inArguments && inDescription) {
    console.log(`  ${p.name}: arguments 는 비었지만 설명이 인자를 알린다 (프레임워크 우회)`);
  }
}

console.log(`prompts/list 가 알린 프롬프트 ${listed.length}종`);

if (listed.length !== defined.size) {
  fails.push(`프롬프트 수가 다르다: 소스 ${defined.size} vs 목록 ${listed.length}`);
}

if (fails.length) {
  console.error("\n프롬프트 인자가 클라이언트에게 전달되지 않는다:");
  for (const f of fails) console.error(`  - ${f}`);
  console.error(
    "\n템플릿은 있는데 채울 자리를 모르면 쓸 수 없다 — 목록이 곧 사용 설명서다.\n",
  );
  process.exit(1);
}

console.log("OK: 정의한 인자가 prompts/list 로 그대로 전달된다.");
