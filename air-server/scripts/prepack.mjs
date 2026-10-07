#!/usr/bin/env node
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

// npm 패키지 루트가 저장소 루트가 아니라 air-server/ 라서, 그냥 pack 하면
// README와 LICENSE가 빠진 tarball이 나간다. npm 레지스트리는 패키지 페이지에
// 패키지 안의 README만 렌더링하므로, 설명 없는 패키지가 공개되는 셈이다.
// 그래서 pack/publish 직전에 저장소 루트의 두 파일을 복사한다(복사본은 Git 무시).
import { copyFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");
const repoRoot = join(pkgRoot, "..");

for (const name of ["README.md", "LICENSE", "NOTICE"]) {
  const src = join(repoRoot, name);
  if (!existsSync(src)) {
    console.error(`[prepack] ${name} 없음, 건너뜀`);
    continue;
  }
  copyFileSync(src, join(pkgRoot, name));
  console.error(`[prepack] ${name} 복사`);
}
