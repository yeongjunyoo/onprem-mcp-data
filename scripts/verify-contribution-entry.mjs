// 외부 기여자가 처음 밟는 길에 막다른 지점이 없는지 확인한다.
//
// 2차 배점의 「커뮤니티」를 심사자는 문서 목록이 아니라 **흐름**으로 본다.
// 새 사람이 저장소에 와서 질문 하나 하려면 어디를 눌러야 하는가.
//
// 실측(2026-08-17)에서 막다른 길을 찾았다.
//
//   config.yml   blank_issues_enabled: false   빈 이슈 금지
//   contact_links                              없음
//   CONTRIBUTING 질문 창구 안내                 없음
//
// 이슈 템플릿은 "버그" 와 "기능 제안" 둘뿐이고, 빈 이슈는 막혀 있고, 어디로 가라는
// 말이 없었다. **문은 있는데(Discussions 활성) 표지판이 없었다.**
//
// ★ 파일이 있는 것과 길이 이어지는 것은 다르다.
//   CONTRIBUTING·CODE_OF_CONDUCT·템플릿·SECURITY 는 전부 있었다. 목록으로 보면
//   완비인데 흐름으로 보면 끊겨 있었다.
//
// 실행: node scripts/verify-contribution-entry.mjs  (파일만 읽는다)
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fails = [];

const read = (rel) => {
  try {
    return readFileSync(resolve(ROOT, rel), "utf8");
  } catch {
    return null;
  }
};

// 1) 있어야 하는 문서
for (const f of ["CONTRIBUTING.md", "CODE_OF_CONDUCT.md", "SECURITY.md", "LICENSE"]) {
  if (!existsSync(resolve(ROOT, f))) fails.push(`${f} 이 없다`);
}

// 2) 이슈 템플릿
const tplDir = join(ROOT, ".github", "ISSUE_TEMPLATE");
const tpls = existsSync(tplDir) ? readdirSync(tplDir) : [];
const forms = tpls.filter((f) => f !== "config.yml");
if (forms.length === 0) fails.push("이슈 템플릿이 하나도 없다");

// 3) ★ 빈 이슈를 막았으면 갈 곳을 알려야 한다
const cfg = read(".github/ISSUE_TEMPLATE/config.yml");
if (cfg === null) {
  fails.push(".github/ISSUE_TEMPLATE/config.yml 이 없다");
} else {
  const blocked = /blank_issues_enabled:\s*false/.test(cfg);
  const hasLinks = /contact_links:/.test(cfg) && /- name:/.test(cfg);
  if (blocked && !hasLinks) {
    fails.push(
      "빈 이슈를 막아 놓고 contact_links 가 없다 — 버그도 기능도 아닌 질문이 막다른 길이 된다",
    );
  }
}

// 4) CONTRIBUTING 이 질문 창구를 말하는가
const contrib = read("CONTRIBUTING.md");
if (contrib && !/discussions/i.test(contrib)) {
  fails.push("CONTRIBUTING 이 질문 창구(Discussions)를 안내하지 않는다");
}

// 5) good first issue 로 가는 길
const readme = read("README.md");
const pointsToGfi = [contrib, cfg, readme].some((t) => t && /good[+ %]?first[+ %]?issue/i.test(t));
if (!pointsToGfi) {
  fails.push("good first issue 로 가는 링크가 어디에도 없다 — 처음 오는 사람의 진입점이다");
}

console.log(
  `기여 진입 경로: 템플릿 ${forms.length}종 · config ${cfg ? "있음" : "없음"} · ` +
    `CONTRIBUTING ${contrib ? "있음" : "없음"}`,
);

if (fails.length) {
  console.error("\n외부 기여자의 길이 끊긴다:");
  for (const f of fails) console.error(`  - ${f}`);
  console.error("\n파일이 있는 것과 길이 이어지는 것은 다르다.\n");
  process.exit(1);
}

console.log("OK: 질문·버그·기능·보안·첫 기여로 가는 길이 전부 이어져 있다.");
