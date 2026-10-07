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

// 마크다운 표가 빈 줄로 쪼개져 GitHub 가 두 개의 표로 렌더하는 것을 잡는다.
//
// 실측(2026-09-10): README 「주장을 지키는 검사」 표가 27행째 뒤의 빈 줄 하나로
// 두 동강 났다. GitHub 는 아래쪽 13행을 **헤더 없는 표**로 렌더한다 — 깨진 것처럼
// 보이고, 로컬에서 아무 검사도 이를 잡지 못했다. 표 행은 줄 단위로 매치되는
// 검사들(verify-tool-surface)은 그대로 통과했다.
//
// 규칙. 표 블록(연속한 `|` 시작 행) 뒤의 빈 줄 다음에:
//   - 구분행(| --- |)이 오면       → 실패. 헤더와 구분행이 갈라져 GitHub 는 표를
//     아예 그리지 않는다. 구분행으로 시작하는 올바른 표는 존재하지 않는다.
//   - 헤더행 + 구분행이 오면       → 통과. 의도적인 새 표다.
//   - 그 외 표 행이 오면           → 실패. 하나의 표가 쪼개진 것이다.
//
// 실행: node scripts/verify-table-integrity.mjs   (파일만 읽는다)
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const fails = [];
let scanned = 0;

const tracked = execFileSync("git", ["ls-files", "*.md"], { cwd: ROOT, encoding: "utf8" })
  .split("\n")
  .map((f) => f.trim())
  .filter(Boolean);

const isRow = (s) => s.startsWith("|");
const isDelim = (s) => /^\|\s*:?-{3,}/.test(s);

for (const rel of tracked) {
  const lines = readFileSync(resolve(ROOT, rel), "utf8").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== "" || !isRow(lines[i - 1] ?? "")) continue;
    // 여기서 lines[i] 는 표 블록 바로 뒤의 빈 줄이다.
    const next = lines[i + 1] ?? "";
    if (!isRow(next)) continue; // 표가 정상적으로 닫혔다.
    const after = lines[i + 2] ?? "";
    if (isDelim(next)) {
      fails.push(`${rel}:${i + 2} 구분행이 빈 줄 뒤에서 표를 시작한다 — 헤더와 갈라진 표`);
    } else if (!(isRow(after) && isDelim(after))) {
      // 새 표라면 헤더행 다음에 구분행이 와야 한다.
      fails.push(`${rel}:${i + 2} 표가 빈 줄로 쪼개졌다 (헤더 없는 표 행)`);
    }
  }
  scanned++;
}

if (fails.length) {
  console.error("\n실패: 마크다운 표가 쪼개져 렌더가 깨진 문서 " + fails.length + "곳");
  for (const f of fails) console.error("  - " + f);
  process.exit(1);
}
console.log(`표 무결성: ${scanned}개 문서 검사, 쪼개진 표 없음.`);
