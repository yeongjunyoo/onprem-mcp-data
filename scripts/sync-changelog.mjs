// CHANGELOG.md 를 GitHub 릴리스 노트에서 생성하고, 갈렸으면 실패한다.
//
// 릴리스 노트 3220자가 GitHub 페이지에만 있었다(2026-08-17). **저장소를 클론한
// 사람은 버전 사이에 무엇이 바뀌었는지 볼 곳이 없었다** — OSS 관례상 CHANGELOG 가
// 그 자리이고, 2차 배점의 「OSS 적절성」을 심사자가 보는 항목이다.
//
// ★ 손으로 쓰지 않는다.
//   릴리스 노트가 정본이고 CHANGELOG 는 파생이다. 손으로 쓰면 두 곳이 갈린다 —
//   이 저장소에서 목록·수치가 두 곳에 있어 갈린 것이 세 번이다.
//
// ★ process.exit() 를 쓰지 않는다.
//   fetch 가 연 핸들이 살아 있는 상태로 exit 을 부르면 Windows libuv 가
//     Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)
//   를 내고 **종료코드를 9로 바꾼다**(실측: 정상·위조·복구 전부 9였다).
//   air-server/src/index.ts 가 같은 이유로 이미 exitCode 방식을 쓴다.
//
// 실행:
//   node scripts/sync-changelog.mjs           대조만 (갈렸으면 exit 1)
//   node scripts/sync-changelog.mjs --write   릴리스에서 다시 생성
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(ROOT, "CHANGELOG.md");
const REPO = "yeongjunyoo/onprem-mcp-data";

function token() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    return execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

async function main() {
  const tok = token();
  if (!tok) {
    console.error("\n실패: GitHub 토큰이 없다 — GITHUB_TOKEN 또는 gh auth login.");
    console.error("  건너뛰지 않는다. 조용히 넘어가는 검사는 없는 것과 같다.\n");
    return 1;
  }

  const res = await fetch(`https://api.github.com/repos/${REPO}/releases`, {
    headers: { Authorization: `token ${tok}`, Accept: "application/vnd.github+json" },
  });
  if (!res.ok) {
    console.error(`\n실패: 릴리스를 못 받았다 — HTTP ${res.status}\n`);
    return 1;
  }
  const releases = await res.json();
  if (!Array.isArray(releases) || releases.length === 0) {
    console.error("\n실패: 릴리스가 하나도 없다 — 생성할 내용이 없다.\n");
    return 1;
  }

  const head = [
    "# 변경 이력",
    "",
    "> 이 파일은 **GitHub 릴리스 노트에서 생성**됩니다(`node scripts/sync-changelog.mjs --write`).",
    "> 릴리스가 정본이고 이 파일은 파생입니다 — 손으로 고치면 두 곳이 갈립니다.",
    "> 클론한 사람이 GitHub 페이지를 열지 않고도 버전 사이의 변화를 읽을 수 있도록 둡니다.",
    "",
  ];

  const body = releases.flatMap((r) => {
    const tag = r.tag_name;
    const title = (r.name || tag).replace(tag, "").replace(/^\s*[—-]\s*/, "").trim();
    const date = (r.published_at || "").slice(0, 10);
    return [
      `## ${tag}${title ? ` — ${title}` : ""} (${date})`,
      "",
      (r.body || "").trim() || "_(릴리스 노트 없음)_",
      "",
    ];
  });

  const want = `${[...head, ...body].join("\n").trimEnd()}\n`;

  if (process.argv.includes("--write")) {
    writeFileSync(OUT, want, "utf8");
    console.log(`CHANGELOG.md 생성: 릴리스 ${releases.length}종 · ${want.length}자`);
    return 0;
  }

  if (!existsSync(OUT)) {
    console.error("\n실패: CHANGELOG.md 가 없다 — `--write` 로 생성한다.\n");
    return 1;
  }

  const have = readFileSync(OUT, "utf8");
  console.log(`릴리스 ${releases.length}종 · CHANGELOG ${have.length}자`);

  if (have.trimEnd() !== want.trimEnd()) {
    console.error("\nCHANGELOG.md 가 릴리스 노트와 갈렸다.");
    console.error("  node scripts/sync-changelog.mjs --write 로 다시 생성하고 함께 커밋한다.");
    console.error("  (릴리스가 정본이다 — 이 파일을 손으로 고치면 안 된다.)\n");
    return 1;
  }

  console.log("OK: CHANGELOG 가 릴리스 노트와 같다.");
  console.log("    (클론한 사람도 GitHub 을 열지 않고 변화를 읽을 수 있다.)");
  return 0;
}

process.exitCode = await main();
