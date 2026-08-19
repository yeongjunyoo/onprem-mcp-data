// 저장소 페이지가 심사자에게 어떻게 보이는지 확인한다.
//
// 1차 배점의 「팀워크 = 저장소 관리」를 심사자는 문서가 아니라 **저장소 페이지**에서
// 본다. 설명, 토픽, 릴리스, 이슈, 라이선스, 그리고 **켜져 있는데 빈 탭**.
//
// ★ 설정은 커밋에 남지 않는다.
//   문서가 약속한 플랫폼 설정은 검사로 붙든다 — `verify-security-policy` 와 같은
//   이유다. 누가 UI 에서 되돌려도 여기서 잡힌다.
//
// 실측(2026-08-17): Wiki 와 Projects 탭이 **켜져 있는데 비어 있었다.** 심사자가
// 클릭하면 빈 화면이다. 문서는 전부 `docs/` 에 있고 위키를 쓴 적이 없다.
//
// 실행: GITHUB_TOKEN=... node scripts/verify-repo-presentation.mjs
// 토큰이 없으면 건너뛰지 않고 **실패**한다 — 조용히 넘어가면 검사가 없는 것과 같다.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const REPO = "yeongjunyoo/onprem-mcp-data";

function token() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    return execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

const tok = token();
if (!tok) {
  console.error("\n실패: GitHub 토큰이 없다 — GITHUB_TOKEN 또는 gh auth login.");
  console.error("  건너뛰지 않는다. 조용히 넘어가는 검사는 없는 것과 같다.\n");
  process.exit(1);
}

async function api(path) {
  const res = await fetch(`https://api.github.com/repos/${REPO}${path}`, {
    headers: { Authorization: `token ${tok}`, Accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return res.json();
}

const fails = [];
const info = await api("");
const topics = (await api("/topics")).names ?? [];
const releases = await api("/releases");

// 0) 열린 이슈가 없는 경로·없는 명령을 가리키는가.
//
//    문서는 인용 경로를 검사하는데 **이슈는 아무도 안 봤다.** 그런데
//    `good first issue` 는 기여자가 가장 먼저 여는 면이다.
//
//    실측(2026-08-18): #7 이 `src/text.ts` 를 가리켰다. docs/initial-issues.md 는
//    PR #209 에서 고쳤는데 **살아 있는 이슈는 안 고쳤다.** 사본은 반드시 갈린다.
//    그리고 고치면서 없는 명령(`npm run test:offline`)을 넣었다 —
//    **온램프에서 명령이 실패하면 그 사람은 안 돌아온다.**
{
  const issues = (await api("/issues?state=open")).filter((i) => !i.pull_request);
  const pkg = JSON.parse(readFileSync(resolve(ROOT, "air-server/package.json"), "utf8"));
  const SPAN = /`([^`\n]*)`/g;
  const PATHISH = /(?<![A-Za-z0-9_./-])([A-Za-z0-9_-]+(?:\/[A-Za-z0-9_.-]+)+\.[a-z]{2,5})/g;
  let checked = 0;
  for (const it of issues) {
    let fenced = false;
    const seen = new Set();
    for (const line of (it.body ?? "").split("\n")) {
      if (/^\s*```/.test(line)) {
        fenced = !fenced;
        continue;
      }
      // 명령은 코드블록 안에 있으므로 펜스 안에서도 본다.
      for (const m of line.matchAll(/npm run ([a-z:0-9-]+)/g)) {
        if (seen.has(`npm:${m[1]}`)) continue;
        seen.add(`npm:${m[1]}`);
        checked++;
        if (!pkg.scripts[m[1]]) {
          fails.push(
            `이슈 #${it.number} 가 없는 명령을 안내한다: npm run ${m[1]} ` +
              `(air-server/package.json 에 없다)`,
          );
        }
      }
      if (fenced) continue;
      for (const sp of line.matchAll(SPAN)) {
        for (const m of sp[1].matchAll(PATHISH)) {
          const p = m[1];
          if (seen.has(p) || p.includes("..") || p.includes("://")) continue;
          seen.add(p);
          checked++;
          if (!existsSync(resolve(ROOT, p))) {
            fails.push(`이슈 #${it.number} 가 없는 경로를 가리킨다: ${p}`);
          }
        }
      }
    }
  }
  console.log(`열린 이슈 ${issues.length}건이 인용한 경로·명령 ${checked}건을 확인했다.`);
}

// 1) 켜져 있는데 비어 있는 탭
if (info.has_wiki) {
  fails.push("Wiki 탭이 켜져 있다 — 문서는 docs/ 에 있고 위키는 비어 있다(빈 탭은 미완성으로 보인다)");
}
if (info.has_projects) {
  fails.push("Projects 탭이 켜져 있다 — 쓰지 않는 빈 탭이다");
}

// 2) 있어야 하는 것
if (!info.description || info.description.length < 40) {
  fails.push(`저장소 설명이 짧거나 없다 (${info.description?.length ?? 0}자)`);
}
if (!info.license?.spdx_id || info.license.spdx_id === "NOASSERTION") {
  fails.push("라이선스가 GitHub 에 인식되지 않는다 — 심사 항목이다");
}
if (topics.length < 5) {
  fails.push(`토픽이 ${topics.length}종이다 — 검색 노출과 분류에 쓰인다`);
}
if (!Array.isArray(releases) || releases.length === 0) {
  fails.push("릴리스가 없다 — 태그만으로는 배포 이력이 보이지 않는다");
}
if (!info.has_issues) fails.push("이슈가 꺼져 있다 — 외부 기여 진입점이 사라진다");
if (!info.has_discussions) fails.push("Discussions 가 꺼져 있다");
if (info.private) fails.push("저장소가 비공개다 — 공개 심사 대상이다");
if (info.archived) fails.push("저장소가 보관 상태다");

console.log(
  `저장소 표면: 토픽 ${topics.length}종 · 릴리스 ${releases.length}종 · ` +
    `wiki ${info.has_wiki} · projects ${info.has_projects} · ` +
    `issues ${info.has_issues} · discussions ${info.has_discussions}`,
);

if (fails.length) {
  console.error("\n저장소 페이지가 심사자에게 이렇게 보인다:");
  for (const f of fails) console.error(`  - ${f}`);
  console.error("\n설정은 커밋에 남지 않는다 — 이 검사가 그 자리를 지킨다.\n");
  process.exit(1);
}

console.log("OK: 저장소 페이지에 빈 탭이 없고 설명·라이선스·토픽·릴리스가 갖춰져 있다.");
console.log("    (star 0 / fork 0 은 사실이므로 검사 대상이 아니다 — 지우지 않고 문서에 적는다.)");
