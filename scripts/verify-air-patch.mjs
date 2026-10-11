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

// 설치된 @airmcp-dev/core 에 air-server/patches 의 패치가 모두 들어가 있는지 확인한다.
//
// 우리 서버는 air 0.5.2 에 상류 수정(airmcp-dev/air PR #3 #5 #7 #9 #11, air main 42cf9e0 의 ping)을 패치로 얹어 돈다
// (docs/air-patch.md). npm ci 의 postinstall 이 patch-package 로 대고, 못 대면 npm ci 가 실패한다. 이 검사는 그 뒤에
// 설치본을 직접 읽는다. postinstall 이 건너뛰어진 설치(--ignore-scripts)나 판이 바뀐 air 를 여기서 이름으로 알린다.
// 패치가 빠진 air 는 오류 없이 뜨지만 stdio 클라이언트의 요청에 답하지 않는다.
//
// 실행: node scripts/verify-air-patch.mjs   (air-server 에서 npm ci 를 한 뒤. 파일만 읽는다)
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = resolve(ROOT, "air-server");
const PATCHES = resolve(SERVER, "patches");
const fails = [];

const files = existsSync(PATCHES) ? readdirSync(PATCHES).filter((f) => f.endsWith(".patch")).sort() : [];
if (files.length === 0) fails.push("air-server/patches 에 패치가 없다. 패치를 지웠다면 이 검사와 CI 단계, docs/air-patch.md 도 함께 지운다");

let lines = 0;
for (const file of files) {
  // patch-package 파일 이름: <scope>+<name>+<version>[+<순번>+<이름>].patch
  const m = /^(@[^+]+)\+([^+]+)\+(\d+\.\d+\.\d+[^+]*)(?:\+\d+\+[^+]+)?\.patch$/.exec(file);
  if (!m) {
    fails.push(`${file}: patch-package 이름 형식이 아니다`);
    continue;
  }
  const [, scope, name, version] = m;
  const pkgDir = resolve(SERVER, "node_modules", scope, name);
  const pkgJson = resolve(pkgDir, "package.json");
  if (!existsSync(pkgJson)) {
    fails.push(`${file}: ${scope}/${name} 가 설치돼 있지 않다(air-server 에서 npm ci 를 먼저 한다)`);
    continue;
  }
  const installed = JSON.parse(readFileSync(pkgJson, "utf8")).version;
  if (installed !== version) {
    fails.push(
      `${file}: 설치된 ${scope}/${name} 는 ${installed} 인데 패치는 ${version} 용이다. 새 판이 이 수정을 담았는지 확인하고, ` +
        `담았으면 patches/ 와 postinstall 을 지운다. 아니면 새 판에 맞춰 패치를 다시 만든다(docs/air-patch.md)`,
    );
    continue;
  }
  // 파일마다 패치가 넣는 줄이 설치본에 그대로 있는지 본다.
  let target = null;
  let text = "";
  for (const line of readFileSync(resolve(PATCHES, file), "utf8").split("\n")) {
    const header = /^\+\+\+ b\/(.+)$/.exec(line);
    if (header) {
      target = header[1];
      const abs = resolve(SERVER, target);
      text = existsSync(abs) ? readFileSync(abs, "utf8") : "";
      if (!text) fails.push(`${file}: ${target} 가 없다`);
      continue;
    }
    if (!target || !line.startsWith("+") || line.startsWith("+++")) continue;
    const added = line.slice(1);
    if (added.trim() === "") continue;
    lines++;
    if (text && !text.includes(added)) {
      fails.push(`${file}: ${target} 에 패치가 넣는 줄이 없다: ${added.trim().slice(0, 100)}`);
      target = null; // 파일마다 첫 누락만 알린다
    }
  }
}

if (fails.length) {
  console.error("\n실패: air 패치가 설치본에 들어가 있지 않다.");
  for (const f of fails) console.error(`  - ${f}`);
  console.error("\n  air-server 에서 npm ci 를 다시 하고 postinstall(patch-package) 출력을 본다. 자세한 것은 docs/air-patch.md.\n");
  process.exit(1);
}
console.log(`OK: air 패치 ${files.length}개(${files.join(", ")})가 설치본에 들어가 있다. 넣는 줄 ${lines}개를 확인했다.`);
