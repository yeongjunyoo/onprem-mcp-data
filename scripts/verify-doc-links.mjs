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

if (fails.length) {
  console.error("\n가리키는 파일이 없는 링크:");
  for (const f of fails) console.error(`  - ${f}`);
  console.error("\n심사자는 링크를 타고 들어온다. 404 는 나머지 서술까지 의심받게 한다.\n");
  process.exit(1);
}

console.log("OK: 문서의 내부 링크가 전부 실제 파일을 가리킨다.");
console.log("    (외부 URL 은 보지 않는다 — 남의 서버로 우리 CI 를 빨갛게 만들지 않는다.)");
