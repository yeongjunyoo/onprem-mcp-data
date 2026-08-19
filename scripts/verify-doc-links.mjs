// 문서의 내부 링크가 실제 파일을 가리키는지 확인한다.
//
// 심사자가 저장소를 열면 README 를 먼저 보고, 거기서 링크를 타고 들어간다.
// 404 는 그 자리에서 신뢰를 깎는다 — **문서가 없는 파일을 가리키면 나머지 서술도
// 의심받는다.**
//
// 실측(2026-08-17): README 13개 · README.en 10개 내부 링크 전부 정상, 배지 4종
// 전부 HTTP 200. 이 검사는 그 상태를 붙든다.
//
// ★ 외부 URL 은 검사하지 않는다.
//   네트워크가 필요하고, 상대 서버가 죽으면 우리 CI 가 빨개진다. 그건 우리 결함이
//   아닌데 사람이 검사를 꺼버리는 이유가 된다 — 이 저장소에서 다섯 번 확인한
//   "오탐이 있는 검사는 꺼진다" 와 같은 함정이다.
//
// 실행: node scripts/verify-doc-links.mjs  (파일만 읽는다)
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const docs = execFileSync("git", ["ls-files", "*.md"], { cwd: ROOT, encoding: "utf8" })
  .split("\n")
  .map((f) => f.trim())
  .filter(Boolean);

// 백틱으로 인용한 경로도 본다. 위 주석이 이미 이유를 적어 놨다 -
// **문서가 없는 파일을 가리키면 나머지 서술도 의심받는다.**
// 그런데 마크다운 링크만 보고 백틱은 안 봤다. 문서가 코드를 가리키는 방식은
// 압도적으로 백틱이다(2026-08-18 실측: 백틱 115건 대 링크 23건).
//
// 실제로 여덟 곳이 `src/sql.ts` 라고 쓰는데 파일은 `air-server/src/sql.ts` 였다.
// 어느 문서도 「이하 air-server/ 기준」이라고 선언하지 않았다 - 심사자가 루트에서
// 찾으면 없다.
//
// datasets/MANIFEST.md 는 라이선스상 재배포 못 하는 **압축물 내부 구조**를 서술한다
// (datasets/companyx-v1.0/ 안에 실재하고 gitignore 됨).
// **못 담는 것과 없는 것은 다르다.**
//
// 그렇다고 문서를 통째로 면제하지 않는다 - 그러면 그 안의 다른 인용까지 눈이 먼다.
// **면제의 범위가 곧 눈감는 범위다.** 대신 **압축물 트리에서 실제로 찾는다.**
// 트리가 없으면(갓 클론·CI) 그때만 넘어간다 - 못 재는 것과 안 재는 것은 다르다.
const ARCHIVE_DOC = "datasets/MANIFEST.md";
const ARCHIVE_ROOT = resolve(ROOT, "datasets/companyx-v1.0");
const ARCHIVE_PRESENT = existsSync(ARCHIVE_ROOT);
const BACKTICK = /`([A-Za-z0-9_./-]+\/[A-Za-z0-9_./-]+)`/g;

const fails = [];
let checked = 0;

for (const rel of docs) {
  let text;
  try {
    text = readFileSync(resolve(ROOT, rel), "utf8");
  } catch (e) {
    fails.push(`${rel} 을 읽지 못했다 — ${String(e.message).split("\n")[0]}`);
    continue;
  }

  // 코드 펜스 안의 예시 경로는 링크가 아니다.
  const body = text.replace(/```[\s\S]*?```/g, "");

  for (const m of body.matchAll(/!?\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const target = m[1];
    if (/^(https?:|#|mailto:)/.test(target)) continue; // 외부·앵커는 대상 아님
    const path = target.split("#")[0];
    if (!path) continue;

    checked++;
    // 문서 기준 상대 경로로 푼다.
    const abs = path.startsWith("/")
      ? join(ROOT, path.slice(1))
      : resolve(ROOT, dirname(rel), path);
    if (!existsSync(abs)) {
      fails.push(`${rel}: \`${target}\` 이 없다`);
    }
  }
}

console.log(`문서 ${docs.length}개의 내부 링크 ${checked}개를 확인했다.`);

if (checked === 0) {
  console.error("\n실패: 확인한 링크가 0개다 — 문서 목록이나 패턴을 확인하라.\n");
  process.exit(1);
}

let backtickChecked = 0;
for (const doc of docs) {
  const lines = readFileSync(resolve(ROOT, doc), "utf8").split("\n");
  let fenced = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    for (const m of lines[i].matchAll(BACKTICK)) {
      const p = m[1];
      // `DOC-001..040.md` 는 범위 표기지 파일이 아니다. 상대경로(`../`) 인용이
      // 저장소에 0건임을 확인하고 `..` 을 범위로만 해석한다.
      if (p.includes("..") || p.includes("://") || p.startsWith("http")) continue;
      if (!/\.[a-z]{2,5}$/.test(p)) continue;
      if (p.startsWith("node_modules/") || p.startsWith("dist/")) continue;
      backtickChecked++;
      if (existsSync(resolve(ROOT, p))) continue;
      if (doc === ARCHIVE_DOC) {
        // 압축물 내부 경로다. 트리가 있으면 거기서 찾고, 없으면 검증 불가.
        if (!ARCHIVE_PRESENT) continue;
        if (existsSync(resolve(ARCHIVE_ROOT, p))) continue;
        fails.push(
          `${doc}:${i + 1} - 압축물 안에도 없는 경로다: ${p}\n` +
            `    ${lines[i].trim().slice(0, 90)}`,
        );
        continue;
      }
      fails.push(
        `${doc}:${i + 1} - 백틱으로 인용한 경로가 없다: ${p}\n` +
          `    ${lines[i].trim().slice(0, 90)}`,
      );
    }
  }
}
console.log(`백틱으로 인용한 경로 ${backtickChecked}건의 실재도 확인했다.`);

if (fails.length) {
  console.error("\n가리키는 파일이 없는 링크:");
  for (const f of fails) console.error(`  - ${f}`);
  console.error("\n심사자는 링크를 타고 들어온다. 404 는 나머지 서술까지 의심받게 한다.\n");
  process.exit(1);
}

console.log("OK: 문서의 내부 링크가 전부 실제 파일을 가리킨다.");
console.log("    (외부 URL 은 보지 않는다 — 남의 서버로 우리 CI 를 빨갛게 만들지 않는다.)");
