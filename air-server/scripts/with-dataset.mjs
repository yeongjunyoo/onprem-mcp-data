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

// DATASET 환경변수를 셸에 의존하지 않고 넘긴다.
//
// `DATASET=companyx node ...` 는 POSIX 셸 문법이라 npm이 cmd.exe로 스크립트를 돌리는
// Windows에서 실행되지 않는다. 이 저장소의 실측 개발 환경이 Windows라 그대로 두면
// 통합 테스트 진입점이 그 환경에서 돌지 않는다.
import { spawn } from "node:child_process";

const [dataset, script, ...rest] = process.argv.slice(2);
if (!dataset || !script) {
  console.error("사용: node scripts/with-dataset.mjs <dataset> <script.js> [args...]");
  process.exit(2);
}
spawn(process.execPath, [script, ...rest], {
  stdio: "inherit",
  env: { ...process.env, DATASET: dataset },
}).on("exit", (code) => process.exit(code ?? 1));
