// 마크다운 표가 빈 줄로 쪼개져 GitHub 가 두 개의 표로 렌더하는 것을 잡는다.
//
// 실측(2026-09-10): README 「주장을 지키는 검사」 표가 27행째 뒤의 빈 줄 하나로
// 두 동강 났다. GitHub 는 아래쪽 13행을 **헤더 없는 표**로 렌더한다 — 깨진 것처럼
// 보이고, 로컬에서 아무 검사도 이를 잡지 못했다. 표 행은 줄 단위로 매치되는
// 검사들(verify-tool-surface)은 그대로 통과했다.
//
// 규칙: 빈 줄 다음 줄이 `|` 로 시작하는데 그 직전 블록도 표였다면, 이는 하나의
// 표가 쪼개진 것이다. (의도적인 두 표 사이에는 헤더 행이 온다 — 헤더 없이
// 바로 데이터 행(`| x | y |` 아래 `| --- |`)으로 시작하는 표는 존재하지 않는다.)
//
// 실행: node scripts/verify-table-integrity.mjs   (파일만 읽는다)
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirnameOf(import.meta.url), "..");

function dirnameOf(u) {
  return new URL(".", u).pathname.replace(/^\/([A-Za-z]:)/, "$1");
}

const fails = [];
let checked = 0;

const tracked = execFileSync("git", ["ls-files", "*.md"], { cwd: ROOT, encoding: "utf8" })
  .split("\n")
  .map((f) => f.trim())
  .filter(Boolean);

for (const rel of tracked) {
  const lines = readFileSync(resolve(ROOT, rel), "utf8").split(/\r?\n/);
  let prevWasTable = false;
  let prevTableStart = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isTable = line.startsWith("|");
    if (!isTable && line.trim() === "" && prevWasTable) {
      // 빈 줄 뒤가 표 재개인지는 다음 줄에서 판정
      const next = lines[i + 1] ?? "";
      if (next.startsWith("|") && !/^\|\s*-{2,}/.test(next)) {
        // 다음 표 블록의 첫 행이 구분행이면 새 표의 헤더가 아니라 데이터행 — 쪼개진 것
        // (정상적인 새 표라면 헤더행 다음에 구분행이 오고, 구분행이 첫 줄로 오는 일은 없다)
        const headerCandidate = next;
        const sep = lines[i + 2] ?? "";
        const looksLikeNewTable = /^\|/.test(sep) && /^\|\s*:?-{3,}/.test(sep);
        if (!looksLikeNewTable) {
          fails.push(`${rel}:${i + 2} 표가 빈 줄로 쪼개졌다 (원래 표 시작 ${prevTableStart + 1}행)`);
        }
      }
    }
    if (isTable) {
      if (!prevWasTable) prevTableStart = i;
      prevWasTable = true;
    } else if (line.trim() !== "") {
      prevWasTable = false;
    }
    checked++;
  }
}

if (fails.length) {
  console.error("\n실패: 마크다운 표가 쪼개져 렌더가 깨진 문서 " + fails.length + "곳");
  for (const f of fails) console.error("  - " + f);
  process.exit(1);
}
console.log(`표 무결성: ${tracked.length}개 문서 검사, 쪼개진 표 없음.`);
