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

// build-air-vendor.mjs 와 verify-air-patch.mjs 가 같이 쓰는 것: npm tarball 읽기, 패치 파일 읽기(docs/air-patch.md).
import { createHash } from "node:crypto";
import { posix } from "node:path";
import { gunzipSync } from "node:zlib";

/** npm 이 lockfile 에 적는 형식의 sha512 integrity */
export const sri = (buf) => `sha512-${createHash("sha512").update(buf).digest("base64")}`;
export const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/**
 * npm tarball(gzip 한 ustar)을 읽어 `package/...` 경로 → 내용 Map 으로 돌려준다.
 * 일반 파일만 받는다. 링크나 장치 파일, package/ 밖으로 나가는 경로가 있으면 멈춘다.
 */
export function readTgz(buf) {
  const tar = gunzipSync(buf);
  const entries = new Map();
  let paxPath;
  for (let off = 0; off + 512 <= tar.length; ) {
    const h = tar.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const field = (s, n) => h.subarray(s, s + n).toString("utf8").replace(/\0.*$/s, "");
    const size = parseInt(field(124, 12).trim() || "0", 8);
    const type = String.fromCharCode(h[156] || 48);
    const prefix = field(345, 155);
    let name = paxPath ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
    paxPath = undefined;
    const data = Buffer.from(tar.subarray(off + 512, off + 512 + size));
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === "x") {
      const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(data.toString("utf8"));
      if (m) paxPath = m[1];
      continue;
    }
    if (type === "g" || type === "5") continue;
    if (type !== "0") throw new Error(`tarball 에 일반 파일이 아닌 항목이 있다(${type}): ${name}`);
    name = posix.normalize(name);
    if (!name.startsWith("package/") || name.split("/").includes("..")) {
      throw new Error(`tarball 의 경로가 package/ 밖이다: ${name}`);
    }
    entries.set(name, data);
  }
  return entries;
}

/**
 * 통합 diff(git diff 형식)를 파일별로 읽는다. 파일 수정과 새 파일만 받고 경로는 패키지 안의 dist/ 로 한정한다.
 * 돌려주는 값: [{ path, isNew, hunks: [{ oldStart, oldLen, newLen, lines: [' ...', '-...', '+...', '\\ ...'] }] }]
 */
export function parsePatch(text, label) {
  if (text.includes("\r")) throw new Error(`${label}: CR 이 있다. 패치는 LF 로만 둔다(.gitattributes)`);
  const lines = text.split("\n");
  const files = [];
  let i = 0;
  while (i < lines.length) {
    if (!lines[i].startsWith("diff --git ")) {
      i++;
      continue;
    }
    const file = { path: undefined, isNew: false, hunks: [] };
    for (i++; i < lines.length && !lines[i].startsWith("@@") && !lines[i].startsWith("diff --git "); i++) {
      const l = lines[i];
      if (l.startsWith("new file mode")) file.isNew = true;
      else if (/^(deleted file|rename |copy |old mode|new mode|Binary files|GIT binary patch)/.test(l)) {
        throw new Error(`${label}: 지원하지 않는 변경이다: ${l}`);
      } else if (l.startsWith("+++ b/")) file.path = l.slice(6);
    }
    if (!file.path || !file.path.startsWith("dist/") || file.path.split("/").includes("..")) {
      throw new Error(`${label}: dist/ 밖의 파일을 고치는 패치는 받지 않는다: ${file.path}`);
    }
    while (i < lines.length && lines[i].startsWith("@@")) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[i]);
      if (!m) throw new Error(`${label}: hunk 머리를 읽지 못했다: ${lines[i]}`);
      const hunk = {
        oldStart: Number(m[1]),
        oldLen: m[2] === undefined ? 1 : Number(m[2]),
        newLen: m[4] === undefined ? 1 : Number(m[4]),
        lines: [],
      };
      let oldLeft = hunk.oldLen;
      let newLeft = hunk.newLen;
      for (i++; i < lines.length && (oldLeft > 0 || newLeft > 0 || lines[i].startsWith("\\")); i++) {
        const l = lines[i];
        if (l[0] === " ") oldLeft--, newLeft--;
        else if (l[0] === "-") oldLeft--;
        else if (l[0] === "+") newLeft--;
        else if (l[0] !== "\\") throw new Error(`${label}: ${file.path} hunk 안에 읽지 못하는 줄이 있다: ${l}`);
        hunk.lines.push(l);
      }
      if (oldLeft !== 0 || newLeft !== 0) throw new Error(`${label}: ${file.path} hunk 의 줄 수가 머리와 다르다`);
      file.hunks.push(hunk);
    }
    files.push(file);
  }
  return files;
}
