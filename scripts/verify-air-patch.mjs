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

// 설치된 @airmcp-dev/core 가 air-server/vendor 의 패치 얹은 tarball 그대로인지 확인한다(docs/air-patch.md).
//
// 우리 서버는 air 0.5.2 배포본에 상류 수정(airmcp-dev/air PR #3 #5 #7 #9 #11, air main 42cf9e0 의 ping, HTTP+SSE 의
// Origin 검사)을 댄 tarball 을 file: 의존성으로 쓴다(scripts/build-air-vendor.mjs 가 만든다). 이 검사는 다음을 본다.
//   1. package.json 이 그 tarball 을 가리키고, tarball 의 sha512 가 air-vendor.json 과 package-lock.json 에 적힌 값과 같다
//   2. air-server/vendor/patches 가 air-vendor.json 에 적힌 패치와 같다(패치만 고치고 tarball 을 다시 만들지 않은 경우)
//   3. 설치된 node_modules/@airmcp-dev/core 가 tarball 의 파일과 바이트까지 같고, 패치가 넣는 줄이 다 들어 있다
// 패치가 빠진 air 는 오류 없이 뜨지만 stdio 클라이언트의 요청에 답하지 않는다. 그래서 어긋나면 이름을 대고 실패한다.
//
// 실행: node scripts/verify-air-patch.mjs   (air-server 에서 npm ci 를 한 뒤. 파일만 읽는다)
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePatch, readTgz, sha256, sri } from "./air-vendor-lib.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = resolve(ROOT, "air-server");
const VENDOR = resolve(SERVER, "vendor");
const INSTALLED = resolve(SERVER, "node_modules/@airmcp-dev/core");
const fails = [];
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

const manifestPath = join(VENDOR, "air-vendor.json");
if (!existsSync(manifestPath)) {
  console.error("\n실패: air-server/vendor/air-vendor.json 이 없다. node scripts/build-air-vendor.mjs 로 tarball 을 만든다(docs/air-patch.md).\n");
  process.exit(1);
}
const manifest = readJson(manifestPath);
const spec = `file:vendor/${manifest.file}`;

// 1. package.json, tarball, lockfile
const declared = readJson(join(SERVER, "package.json")).dependencies?.["@airmcp-dev/core"];
if (declared !== spec) fails.push(`air-server/package.json 의 @airmcp-dev/core 가 "${declared}" 다. "${spec}" 여야 한다`);
const tgzPath = join(VENDOR, manifest.file);
let tgz;
if (!existsSync(tgzPath)) fails.push(`air-server/vendor/${manifest.file} 가 없다`);
else {
  tgz = readFileSync(tgzPath);
  if (sri(tgz) !== manifest.integrity) {
    fails.push(`${manifest.file} 의 sha512 가 air-vendor.json 과 다르다(파일 ${sri(tgz)}, 적힌 값 ${manifest.integrity})`);
    tgz = undefined; // 해시가 다른 파일은 풀어 보지 않는다
  }
}
const stale = readdirSync(VENDOR).filter((f) => /^airmcp-dev-core-.*\.tgz$/.test(f) && f !== manifest.file);
if (stale.length) fails.push(`air-server/vendor 에 쓰지 않는 tarball 이 있다: ${stale.join(", ")}`);
const locked = readJson(join(SERVER, "package-lock.json")).packages?.["node_modules/@airmcp-dev/core"];
if (locked?.resolved !== spec || locked?.integrity !== manifest.integrity || locked?.version !== manifest.version) {
  fails.push(
    `package-lock.json 의 @airmcp-dev/core 가 tarball 과 다르다(resolved ${locked?.resolved}, version ${locked?.version}, ` +
      `integrity ${locked?.integrity}). air-server 에서 npm install 로 lockfile 을 다시 쓴다`,
  );
}

// 2. 패치 파일
const patchDir = join(VENDOR, "patches");
const patchFiles = existsSync(patchDir) ? readdirSync(patchDir).filter((f) => f.endsWith(".patch")).sort() : [];
const listed = manifest.patches.map((p) => `${p.file}:${p.sha256}`).join(" ");
const actual = patchFiles.map((f) => `${f}:${sha256(readFileSync(join(patchDir, f)))}`).join(" ");
if (listed !== actual) {
  fails.push(`air-server/vendor/patches 가 air-vendor.json 에 적힌 패치와 다르다. 패치를 바꿨으면 node scripts/build-air-vendor.mjs 로 tarball 을 다시 만든다`);
}

// 3. 설치본
let lines = 0;
let compared = 0;
if (!existsSync(join(INSTALLED, "package.json"))) {
  fails.push("@airmcp-dev/core 가 설치돼 있지 않다(air-server 에서 npm ci 를 먼저 한다)");
} else {
  const installedVersion = readJson(join(INSTALLED, "package.json")).version;
  if (installedVersion !== manifest.version) {
    fails.push(`설치된 @airmcp-dev/core 는 ${installedVersion} 인데 tarball 은 ${manifest.version} 이다. air-server 에서 npm ci 를 다시 한다`);
  }
  if (tgz) {
    for (const [name, data] of readTgz(tgz)) {
      const p = join(INSTALLED, ...name.slice("package/".length).split("/"));
      compared++;
      if (!existsSync(p) || !readFileSync(p).equals(data)) {
        fails.push(`설치본의 ${name.slice("package/".length)} 가 tarball 과 다르다`);
        break;
      }
    }
  }
  // 패치가 넣는 줄. 뒤 패치가 지운 줄은 빼고 센다(003 이 001 의 Origin 검사를 protocol/origin.js 로 옮긴다).
  const expected = new Map();
  for (const f of patchFiles) {
    for (const file of parsePatch(readFileSync(join(patchDir, f), "utf8"), f)) {
      const set = expected.get(file.path) ?? new Set();
      expected.set(file.path, set);
      for (const l of file.hunks.flatMap((h) => h.lines)) {
        if (l[0] === "-") set.delete(l.slice(1));
        else if (l[0] === "+" && l.slice(1).trim() !== "") set.add(l.slice(1));
      }
    }
  }
  for (const [path, set] of expected) {
    const p = join(INSTALLED, ...path.split("/"));
    const text = existsSync(p) ? readFileSync(p, "utf8") : "";
    if (!text) {
      fails.push(`설치본에 ${path} 가 없다`);
      continue;
    }
    for (const added of set) {
      lines++;
      if (!text.includes(added)) {
        fails.push(`설치본의 ${path} 에 패치가 넣는 줄이 없다: ${added.trim().slice(0, 100)}`);
        break; // 파일마다 첫 누락만 알린다
      }
    }
  }
}

if (fails.length) {
  console.error("\n실패: 설치된 air 가 air-server/vendor 의 패치 얹은 tarball 과 다르다.");
  for (const f of fails) console.error(`  - ${f}`);
  console.error("\n  air-server 에서 npm ci 를 다시 한다. tarball 을 바꿨다면 node scripts/build-air-vendor.mjs 와 npm install 을 거친다. 자세한 것은 docs/air-patch.md.\n");
  process.exit(1);
}
console.log(
  `OK: @airmcp-dev/core ${manifest.version} 가 air-server/vendor/${manifest.file}(${manifest.integrity.slice(0, 23)}…) 그대로 설치돼 있다. ` +
    `파일 ${compared}개가 tarball 과 같고 패치 ${patchFiles.length}개(${patchFiles.join(", ")})가 넣는 줄 ${lines}개를 확인했다.`,
);
