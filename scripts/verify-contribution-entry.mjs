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

// ── 「내 데이터에 붙이기」가 가리키는 길.
//
// 2026-08-18 에 그 절을 쓰면서 식별자를 손으로 확인했다. **손으로 확인한 것은 다음에
// 누가 이름을 바꾸면 조용히 낡는다** — 활용성 15점이 걸린 자리라 특히 그렇다.
//
// 심사자가 그 절을 따라 하다 없는 변수나 스크립트를 만나면 거기서 끝난다.
//
// 2026-10-20: 붙이는 길이 profile.ts 에 항목을 더하는 코드 수정에서 환경 변수(DATASET=catalog, CATALOG_*)로 바뀌었다.
// 종전 검사는 CONTRIBUTING 의 프로파일 예제(```ts)가 DatasetProfile 의 필수 필드를 다 갖췄는지 봤다. 이제 그 절은
// docs/connect-your-db.md 를 가리키므로, 두 문서를 합친 안내가 profile.ts 가 실제로 읽는 변수와 맞는지 양쪽으로 본다.
{
  const guide = contrib.includes("## 내 데이터에 붙이기");
  if (!guide) {
    fails.push('CONTRIBUTING 에 「내 데이터에 붙이기」 절이 없다 — 활용성 질문에 답하는 자리다');
  } else {
    const section = contrib.slice(contrib.indexOf("## 내 데이터에 붙이기"));
    const body = section.slice(0, section.indexOf("\n## ", 10) + 1 || undefined);
    const DOC = "docs/connect-your-db.md";
    if (!body.includes(DOC)) fails.push(`CONTRIBUTING 「내 데이터에 붙이기」가 ${DOC} 를 가리키지 않는다`);
    const doc = existsSync(resolve(ROOT, DOC)) ? readFileSync(resolve(ROOT, DOC), "utf8") : "";
    if (!doc) fails.push(`${DOC} 가 없다 — CONTRIBUTING 이 가리키는 절차가 끊긴다`);
    const text = body + "\n" + doc;
    const profileSrc = readFileSync(resolve(ROOT, "air-server/src/profile.ts"), "utf8");
    const pkg = JSON.parse(readFileSync(resolve(ROOT, "air-server/package.json"), "utf8"));

    // 안내가 적은 CATALOG_* 는 profile.ts 가 읽어야 하고, profile.ts 가 읽는 CATALOG_* 는 안내에 있어야 한다.
    // 한쪽만 보면 변수를 더하거나 이름을 바꾼 날 다른 쪽이 조용히 낡는다(2026-10-07 PR #256 의 필수 필드와 같은 꼴).
    const said = new Set([...text.matchAll(/(?<![\w$])(CATALOG_[A-Z0-9_]+)(?![\w$])/g)].map((m) => m[1]));
    const read = new Set([...profileSrc.matchAll(/process\.env\.(CATALOG_[A-Z0-9_]+)/g)].map((m) => m[1]));
    if (!read.size) fails.push("profile.ts 에서 CATALOG_* 환경 변수를 못 읽었다 — 패턴을 확인하라");
    for (const v of said) if (!read.has(v)) fails.push(`안내가 ${v} 를 적는데 profile.ts 는 그 변수를 읽지 않는다`);
    for (const v of read) if (!said.has(v)) fails.push(`profile.ts 가 읽는 ${v} 가 안내에 없다 — 따라 하는 사람이 그 변수를 모른다`);
    for (const m of text.matchAll(/DATASET=([A-Za-z_]+)/g)) {
      if (!new RegExp(`PROFILE_NAMES = \\[[^\\]]*"${m[1]}"`).test(profileSrc)) {
        fails.push(`안내가 DATASET=${m[1]} 을 쓰는데 profile.ts 의 PROFILE_NAMES 에 없다`);
      }
    }
    for (const m2 of text.matchAll(/npm run ([\w:.-]+)/g)) {
      if (!pkg.scripts?.[m2[1]]) fails.push(`「내 데이터에 붙이기」 안내가 없는 스크립트를 가리킨다: ${m2[1]}`);
    }
    for (const m3 of text.matchAll(/(scripts\/[\w.-]+\.mjs|air-server\/src\/[\w.-]+\.ts|docs\/[\w.-]+\.md)/g)) {
      if (!existsSync(resolve(ROOT, m3[1]))) fails.push(`「내 데이터에 붙이기」 안내가 없는 파일을 가리킨다: ${m3[1]}`);
    }
    // 안내의 명령(`node dist/cli/x.js`)은 빌드 결과라 저장소에 없다. 소스(air-server/src/cli/x.ts)로 대조한다.
    for (const m4 of text.matchAll(/node dist\/([\w/.-]+)\.js/g)) {
      if (!existsSync(resolve(ROOT, "air-server/src", `${m4[1]}.ts`))) fails.push(`「내 데이터에 붙이기」 안내의 명령이 없는 소스를 가리킨다: dist/${m4[1]}.js`);
    }
  }
}

if (fails.length) {
  console.error("\n외부 기여자의 길이 끊긴다:");
  for (const f of fails) console.error(`  - ${f}`);
  console.error("\n파일이 있는 것과 길이 이어지는 것은 다르다.\n");
  process.exit(1);
}

console.log("OK: 질문·버그·기능·보안·첫 기여로 가는 길이 전부 이어져 있다.");
