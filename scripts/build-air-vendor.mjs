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

// air-server/vendor 의 @airmcp-dev/core tarball 을 다시 만든다(docs/air-patch.md).
//
// npm 에 배포된 @airmcp-dev/core 0.5.2 tarball 을 받아 npm registry 가 알려 주는 integrity 와 이 파일에 고정한
// integrity(sha512) 둘 다로 확인한다. 그 dist 에 air-server/vendor/patches 의 패치를 이름 순서대로 대고(문맥이 한 줄이라도
// 다르면 멈춘다), package.json 의 판을 0.5.2-patched.N 으로 바꿔 npm pack 한다. 결과 tarball 과 해시는
// air-server/vendor/air-vendor.json 에 적는다. air-server 의 package.json 이 이 tarball 을 file: 의존성으로 쓰고,
// package-lock.json 이 그 integrity 를 고정한다.
//
// 실행:
//   node scripts/build-air-vendor.mjs           만들어서 air-server/vendor 에 쓴다. 그 뒤 air-server 에서 npm install
//   node scripts/build-air-vendor.mjs --check   다시 만들어 들어 있는 tarball 과 견준다(파일 내용이 다르면 실패)
//
// 네트워크(registry.npmjs.org)와 npm 이 필요하다. 압축 풀기와 패치는 이 파일 안에서 한다(git, tar 를 부르지 않는다).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePatch, readTgz, sha256, sri } from "./air-vendor-lib.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VENDOR = resolve(ROOT, "air-server/vendor");
const PATCH_DIR = resolve(VENDOR, "patches");
const MANIFEST = resolve(VENDOR, "air-vendor.json");

// 받는 배포본. integrity 는 npm registry 의 dist.integrity 와 같아야 하고, 받은 바이트의 sha512 와도 같아야 한다.
const BASE = {
  name: "@airmcp-dev/core",
  version: "0.5.2",
  tarball: "https://registry.npmjs.org/@airmcp-dev/core/-/core-0.5.2.tgz",
  integrity: "sha512-QFQr8kPg6Q79xwo2xVBcZ42nqdWTdvzhkmOtbyPdtZNMceWZr77y+MGdLqwmc6olL5q+F26KtWBVo9uh8pxzeA==",
};
// 패치를 바꾸면 N 을 올린다. 같은 판 이름에 다른 내용이 실리지 않게 한다.
const LOCAL = "patched.1";
const VERSION = `${BASE.version}-${LOCAL}`;
const OUT_NAME = `airmcp-dev-core-${VERSION}.tgz`;

const check = process.argv.includes("--check");
const fail = (msg) => {
  console.error(`\n실패: ${msg}\n  자세한 것은 docs/air-patch.md.\n`);
  process.exit(1);
};

// ── 1. 배포본을 받아 확인한다 ──
const metaRes = await fetch(`https://registry.npmjs.org/${BASE.name}/${BASE.version}`);
if (!metaRes.ok) fail(`npm registry 에서 ${BASE.name}@${BASE.version} 정보를 못 받았다(HTTP ${metaRes.status})`);
const meta = await metaRes.json();
if (meta.dist?.integrity !== BASE.integrity || meta.dist?.tarball !== BASE.tarball) {
  fail(`npm registry 의 ${BASE.name}@${BASE.version} 가 고정한 값과 다르다: ${meta.dist?.integrity} ${meta.dist?.tarball}`);
}
const tgzRes = await fetch(BASE.tarball);
if (!tgzRes.ok) fail(`${BASE.tarball} 를 못 받았다(HTTP ${tgzRes.status})`);
const baseTgz = Buffer.from(await tgzRes.arrayBuffer());
if (sri(baseTgz) !== BASE.integrity) fail(`받은 tarball 의 sha512 가 ${BASE.integrity} 가 아니다: ${sri(baseTgz)}`);
console.log(`받음: ${BASE.name}@${BASE.version} ${baseTgz.length} bytes, ${BASE.integrity} (registry 와 같음)`);

// ── 2. 새 빈 폴더에 푼다 ──
const work = mkdtempSync(join(tmpdir(), "air-vendor-"));
process.on("exit", () => rmSync(work, { recursive: true, force: true }));
const pkgDir = join(work, "package");
for (const [name, data] of readTgz(baseTgz)) {
  const p = join(work, ...name.split("/"));
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, data);
}

// ── 3. 패치를 순서대로 댄다 ──
const patchFiles = readdirSync(PATCH_DIR).filter((f) => f.endsWith(".patch")).sort();
if (patchFiles.length === 0) fail("air-server/vendor/patches 에 패치가 없다");
const patchInfo = [];
for (const f of patchFiles) {
  const buf = readFileSync(join(PATCH_DIR, f));
  const files = [];
  try {
    for (const file of parsePatch(buf.toString("utf8"), f)) files.push(applyFile(pkgDir, file, f));
  } catch (err) {
    fail(err.message);
  }
  patchInfo.push({ file: f, sha256: sha256(buf), files });
  console.log(`댐: ${f} (${files.length}개 파일)`);
}

// ── 4. 판을 바꾸고 npm pack ──
const pkgJsonPath = join(pkgDir, "package.json");
const pkgJson = readFileSync(pkgJsonPath, "utf8");
const versionLine = `"version": "${BASE.version}",`;
if (pkgJson.split(versionLine).length !== 2) fail(`package.json 에서 ${versionLine} 줄을 하나만 찾아야 한다`);
writeFileSync(pkgJsonPath, pkgJson.replace(versionLine, `"version": "${VERSION}",`));
const packDir = join(work, "out");
mkdirSync(packDir);
const pack = npm(["pack", "--ignore-scripts", "--pack-destination", packDir], pkgDir);
if (pack.status !== 0) fail(`npm pack 이 실패했다\n${pack.stdout}\n${pack.stderr}`);
const built = readFileSync(join(packDir, OUT_NAME));
const npmVersion = npm(["--version"], work).stdout.trim();
const result = {
  package: BASE.name,
  version: VERSION,
  file: OUT_NAME,
  integrity: sri(built),
  sha256: sha256(built),
  base: BASE,
  patches: patchInfo,
  packed_with: { node: process.version, npm: npmVersion },
};

// ── 5. 쓰거나(--check 가 아니면) 들어 있는 것과 견준다 ──
if (check) {
  const target = join(VENDOR, OUT_NAME);
  if (!existsSync(target)) fail(`${OUT_NAME} 가 air-server/vendor 에 없다`);
  const committed = readFileSync(target);
  const a = readTgz(committed);
  const b = readTgz(built);
  const diffs = [...new Set([...a.keys(), ...b.keys()])].filter((k) => !a.has(k) || !b.has(k) || !a.get(k).equals(b.get(k)));
  if (diffs.length) fail(`다시 만든 tarball 의 내용이 ${OUT_NAME} 와 다르다: ${diffs.slice(0, 10).join(", ")}`);
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
  const listed = manifest.patches.map((p) => `${p.file}:${p.sha256}`).join(" ");
  if (listed !== patchInfo.map((p) => `${p.file}:${p.sha256}`).join(" ")) {
    fail("air-server/vendor/patches 가 air-vendor.json 에 적힌 패치와 다르다. 패치를 바꿨으면 이 스크립트로 tarball 을 다시 만든다");
  }
  const same = sri(committed) === result.integrity;
  console.log(
    `OK: 다시 만든 tarball 의 파일 ${b.size}개가 ${OUT_NAME} 와 바이트까지 같다. ` +
      (same ? `tarball 자체도 같다(${result.integrity}).` : `tarball 바이트는 다르다(npm ${npmVersion} 의 압축 차이, 내용은 같다).`),
  );
} else {
  for (const f of readdirSync(VENDOR)) {
    if (/^airmcp-dev-core-.*\.tgz$/.test(f) && f !== OUT_NAME) {
      unlinkSync(join(VENDOR, f));
      console.log(`지움: 이전 tarball ${f}`);
    }
  }
  writeFileSync(join(VENDOR, OUT_NAME), built);
  writeFileSync(MANIFEST, JSON.stringify(result, null, 2) + "\n");
  console.log(`씀: air-server/vendor/${OUT_NAME}\n  integrity ${result.integrity}\n  sha256    ${result.sha256}`);
  console.log(`air-server/package.json 이 "file:vendor/${OUT_NAME}" 를 가리키는지 보고 air-server 에서 npm install 로 package-lock.json 을 갱신한다.`);
}

// npm 을 셸 없이 부른다. npm 으로 돌리면 npm_execpath, 아니면 지금 node 옆의 npm-cli.js, 그것도 없으면 PATH 의 npm.
function npm(args, cwd) {
  const cli = [
    process.env.npm_execpath,
    join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"),
    join(dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js"),
  ].find((p) => p && /npm-cli\.js$/.test(p) && existsSync(p));
  const opts = { cwd, encoding: "utf8", windowsHide: true };
  return cli
    ? spawnSync(process.execPath, [cli, ...args], opts)
    : spawnSync("npm", args, { ...opts, shell: process.platform === "win32" });
}

// 파일 하나에 hunk 를 차례로 댄다. 문맥과 지우는 줄이 정확히 맞아야 한다(어긋나 있어도 찾아 대는 일은 하지 않는다).
function applyFile(root, file, label) {
  const target = join(root, ...file.path.split("/"));
  if (file.isNew === existsSync(target)) throw new Error(`${label}: ${file.path} 는 ${file.isNew ? "이미 있다" : "없다"}`);
  const src = file.isNew ? [] : readFileSync(target, "utf8").split("\n");
  let srcEol = true; // 원래 파일이 줄바꿈으로 끝나는지
  if (!file.isNew) {
    if (src[src.length - 1] === "") src.pop();
    else srcEol = false;
  }
  const out = [];
  let pos = 0;
  let endEol = null; // 마지막 hunk 가 파일 끝까지 닿았을 때 새 파일의 끝 줄바꿈
  for (const h of file.hunks) {
    const start = h.oldLen === 0 ? h.oldStart : h.oldStart - 1;
    if (start < pos || start > src.length) throw new Error(`${label}: ${file.path} hunk 위치(-${h.oldStart})가 맞지 않는다`);
    out.push(...src.slice(pos, start));
    pos = start;
    let last = "";
    let newNoEol = false;
    for (const l of h.lines) {
      const t = l.slice(1);
      if (l[0] === "\\") {
        if (last === "+" || last === " ") newNoEol = true;
        continue;
      }
      last = l[0];
      if (l[0] === "+") {
        out.push(t);
        continue;
      }
      if (src[pos] !== t) throw new Error(`${label}: ${file.path} ${pos + 1}행이 패치의 문맥과 다르다\n  패치: ${t}\n  파일: ${src[pos]}`);
      pos++;
      if (l[0] === " ") out.push(t);
    }
    endEol = pos === src.length ? !newNoEol : null;
  }
  out.push(...src.slice(pos));
  const eol = pos < src.length || endEol === null ? srcEol : endEol;
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, out.join("\n") + (eol ? "\n" : ""));
  return file.path;
}
