// 실행되는 파일에 CRLF 가 섞이지 않았는지 확인한다.
//
// shebang 뒤의 `\r` 은 인터프리터 이름의 일부가 된다 — 커널이 `python3\r` 이나
// `bash\r` 을 찾고 못 찾는다. 셸 스크립트는 그보다 먼저 죽는다:
//
//   scripts/replica-spike.sh: line 16: set: pipefail
//   : invalid option name
//
// 실측(2026-08-17): `.gitattributes` 가 없어 Windows 체크아웃이 `.sh` 2개와
// shebang 파일 7개를 CRLF 로 바꿨고, 대본이 지시하는 replica-spike 가 첫 줄에서
// 죽었다. **심사자가 Windows 에서 클론하면 같은 상태가 된다.**
//
// ★ 한 종류만 보고 규칙을 만들면 나머지가 사각이 된다.
//   처음엔 `.sh` 만 고쳤다. 같은 위험이 `.py` 와 `.mjs` 에도 있었고, shebang 을
//   기준으로 다시 훑고서야 7개가 더 나왔다.
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const tracked = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" })
  .split("\n")
  .map((f) => f.trim())
  .filter(Boolean);

const offenders = [];
let scanned = 0;

for (const rel of tracked) {
  const abs = resolve(ROOT, rel);
  let buf;
  try {
    if (!statSync(abs).isFile()) continue;
    buf = readFileSync(abs);
  } catch {
    continue;
  }
  if (buf.includes(0)) continue; // 바이너리

  const isShell = rel.endsWith(".sh");
  const hasShebang = buf[0] === 0x23 && buf[1] === 0x21; // #!
  if (!isShell && !hasShebang) continue;

  scanned++;
  if (!buf.includes("\r\n")) continue;

  offenders.push(
    isShell
      ? `${rel} — 셸 스크립트가 CRLF 다 (bash 가 첫 줄에서 죽는다)`
      : `${rel} — shebang 파일이 CRLF 다 (인터프리터 이름에 \\r 이 붙는다)`,
  );
}

console.log(`실행되는 파일 ${scanned}개의 줄바꿈을 확인했다.`);

if (offenders.length) {
  console.error("\nCRLF 로 체크아웃되면 실행이 깨지는 파일:");
  for (const o of offenders) console.error(`  - ${o}`);
  console.error(
    "\n.gitattributes 에 해당 확장자를 `text eol=lf` 로 넣고, 현재 파일도 LF 로 바꾼다.\n",
  );
  process.exit(1);
}

console.log("OK: 셸 스크립트와 shebang 파일이 전부 LF 다.");
console.log("    (한 종류만 보고 규칙을 만들면 나머지가 사각이 된다 — shebang 으로 훑는다.)");
