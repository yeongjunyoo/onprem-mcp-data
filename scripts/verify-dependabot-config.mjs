// 의존성 갱신 정책이 **저장소 안에** 있는지 확인한다.
//
// 이 저장소는 설정이 저장소 밖에 살아서 네 번 곤란했다.
//
//   브랜치 보호 · 비공개 취약점 신고 · 릴리스 노트 · 그리고 Dependabot 일정
//
// 보안 알림과 자동 보안 수정은 UI 에서 켰다. 그건 **취약점이 공개된 뒤에** 도는
// 것이고 정기 갱신은 별개다. UI 설정은 커밋에 남지 않고 **포크한 사람에게도 안 간다.**
//
// ★ OSS 로 내놓는 이상 정책은 코드로 간다.
//
// 실행: node scripts/verify-dependabot-config.mjs   (파일만 읽는다)
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const P = resolve(ROOT, ".github/dependabot.yml");
const fails = [];

if (!existsSync(P)) {
  console.error("\n실패: .github/dependabot.yml 이 없다.");
  console.error("  UI 로만 켜면 커밋에 안 남고 포크한 사람에게도 안 간다.\n");
  process.exit(1);
}

const text = readFileSync(P, "utf8");

// 최소 요건 — 파서를 새로 들이지 않고 형태로 본다.
if (!/^version:\s*2\s*$/m.test(text)) fails.push("version: 2 가 없다");

const ecosystems = [...text.matchAll(/package-ecosystem:\s*([\w-]+)/g)].map((m) => m[1]);
if (!ecosystems.includes("npm")) fails.push("npm 갱신이 없다 — 런타임 의존성이 방치된다");
if (!ecosystems.includes("github-actions")) {
  fails.push("github-actions 갱신이 없다 — 워크플로가 낡으면 CI 가 조용히 다르게 돈다");
}

// npm 항목이 실제 package.json 이 있는 디렉터리를 가리키는가
for (const m of text.matchAll(/package-ecosystem:\s*npm[\s\S]{0,200}?directory:\s*([^\s]+)/g)) {
  const dir = m[1].replace(/^\/+/, "");
  const pkg = resolve(ROOT, dir, "package.json");
  if (!existsSync(pkg)) {
    fails.push(`npm 갱신이 ${m[1]} 를 가리키는데 package.json 이 없다`);
  }
}

// 상한이 없으면 검토 없이 PR 이 쌓인다
if (!/open-pull-requests-limit:\s*\d+/.test(text)) {
  fails.push("open-pull-requests-limit 이 없다 — 검토 없이 쌓인 PR 이 저장소를 어지럽힌다");
}

// 라벨을 쓰면 그 라벨이 실재해야 한다(없으면 Dependabot 이 PR 생성에 실패한다)
const labels = [...text.matchAll(/^\s+-\s+(dependencies|[\w-]+)\s*$/gm)]
  .map((m) => m[1])
  .filter((l) => l === "dependencies");
if (labels.length === 0) {
  fails.push("labels 가 없다 — PR 이 다른 것들 사이에 섞인다");
}

console.log(
  `dependabot.yml: 생태계 ${[...new Set(ecosystems)].join(" · ")} · ${text.split("\n").length}줄`,
);

if (fails.length) {
  console.error("\n의존성 갱신 정책이 불완전하다:");
  for (const f of fails) console.error(`  - ${f}`);
  console.error("\n설정은 커밋에 남지 않는다 — 저장소 안에 두면 포크한 사람도 받는다.\n");
  process.exit(1);
}

console.log("OK: 의존성 갱신 정책이 저장소 안에 있고 실제 경로를 가리킨다.");
console.log("    (UI 설정은 원본 저장소에만 붙는다 — OSS 는 정책도 코드로 간다.)");
