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

// 환경변수를 셸에 의존하지 않고 넘긴다.
//
// `EMBEDDER=ollama npm run demo` 는 POSIX 셸 문법이라 npm 이 cmd.exe 로 스크립트를
// 돌리는 Windows 에서 실행되지 않는다. README 가 그 형태를 안내하면 심사자가
// Windows 에서 그대로 따라 할 수 없다 — QA 가 cold-judge 경로에서 지적했다.
//
// 사용: node scripts/with-env.mjs KEY=VALUE [KEY=VALUE...] -- <script.js> [args...]
import { spawn } from "node:child_process";

const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
if (sep < 1) {
  console.error("사용: node scripts/with-env.mjs KEY=VALUE ... -- <script.js> [args...]");
  process.exit(2);
}
const env = { ...process.env };
for (const kv of argv.slice(0, sep)) {
  const i = kv.indexOf("=");
  if (i < 1) {
    console.error(`환경변수 형식이 아니다: ${kv}`);
    process.exit(2);
  }
  env[kv.slice(0, i)] = kv.slice(i + 1);
}
const [script, ...rest] = argv.slice(sep + 1);
spawn(process.execPath, [script, ...rest], { stdio: "inherit", env }).on("exit", (c) => process.exit(c ?? 1));
