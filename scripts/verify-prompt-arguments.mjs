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
// ★ 그때는 우리 결함이 아니라 프레임워크(@airmcp-dev/core 0.2, 0.3)가 목록을 만들 때
//   arguments 를 빠뜨린 것이었다. 그래도 **우리 제품의 사용성 문제**이므로
//   조용히 두지 않았다 — 알고 있다는 것과 모르는 것은 다르다. air 0.5 는 선언한
//   인자를 목록에 그대로 싣는다. 이 검사는 그것이 계속 그런지 본다.
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
  windowsHide: true, // Windows 에서 서버 콘솔 창을 띄우지 않는다
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

  // 0.3.0 까지는 목록에 arguments 가 비어 와서 설명 끝의 `[인자] ...` 와 promptargs.ts 로 우회했다. air 0.5 는
  // 선언한 인자를 그대로 싣고 두 우회는 지웠다(docs/air-patch.md). 이제 목록의 arguments 만 본다.
  if (want.join(",") !== got.join(",")) {
    fails.push(
      `${p.name}: 인자 ${want.join(", ")} 가 목록에 없다(목록: ${got.join(", ") || "없음"}) — ` +
        "클라이언트가 무엇을 채울지 알 수 없다",
    );
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
