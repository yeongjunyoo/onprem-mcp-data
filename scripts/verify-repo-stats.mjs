// 문서가 적는 저장소 활동 수치가 실제와 맞는지 확인한다.
//
// 배점 대응표의 「팀워크 = 저장소 관리」 행이 커밋·PR·이슈 수를 근거로 든다.
// **그 수는 매일 늘어나는데 문서는 손으로 적힌다** — 2026-08-17 실측에서
// 커밋 169(실제 262) · PR 79(실제 127) 로 크게 벌어져 있었다.
//
// ★ 심사자가 저장소를 열면 바로 드러난다.
//   낡은 수치는 "적어 놓고 안 본다" 는 인상을 주고, 그 인상은 나머지 서술의
//   신뢰까지 깎는다. 오늘 여러 번 확인한 형태다.
//
// ★ 허용 오차를 둔다.
//   커밋은 이 검사를 고치는 커밋만으로도 늘어난다. 정확히 같기를 요구하면
//   **매 커밋마다 실패하는 검사**가 되고 사람이 꺼버린다. 문서가 실제보다
//   **적게** 적은 것만, 그것도 여유를 넘겼을 때만 잡는다.
//
// 실행: node scripts/verify-repo-stats.mjs   (토큰 필요)
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = "yeongjunyoo/onprem-mcp-data";

// 문서가 이만큼 뒤처져도 넘어간다. 그 이상이면 "안 보고 있다" 는 뜻이다.
const TOLERANCE = { commits: 40, prs: 20, issues: 3 };

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
  console.error("\n실패: GitHub 토큰이 없다 — GITHUB_TOKEN 또는 gh auth login.\n");
  process.exitCode = 1;
} else {
  const search = async (q) => {
    const r = await fetch(
      `https://api.github.com/search/issues?q=${encodeURIComponent(`repo:${REPO} ${q}`)}`,
      { headers: { Authorization: `token ${tok}`, Accept: "application/vnd.github+json" } },
    );
    if (!r.ok) throw new Error(`search ${q} → HTTP ${r.status}`);
    return (await r.json()).total_count;
  };

  const actual = {
    commits: Number(execFileSync("git", ["rev-list", "--count", "HEAD"], {
      cwd: ROOT,
      encoding: "utf8",
    }).trim()),
    prs: await search("type:pr"),
    merged: await search("type:pr is:merged"),
    issues: await search("type:issue"),
  };

  const doc = readFileSync(resolve(ROOT, "docs/report.md"), "utf8");
  const claimed = {
    commits: Number(doc.match(/커밋\s*(\d+)/)?.[1] ?? 0),
    prs: Number(doc.match(/PR\s*(\d+)\s*\(병합/)?.[1] ?? 0),
    merged: Number(doc.match(/PR\s*\d+\s*\(병합\s*(\d+)/)?.[1] ?? 0),
    issues: Number(doc.match(/이슈\s*(\d+)\s*\(열림/)?.[1] ?? 0),
  };

  console.log("저장소 활동 (문서 vs 실제):");
  for (const k of ["commits", "prs", "merged", "issues"]) {
    console.log(`  ${k.padEnd(8)} 문서 ${String(claimed[k]).padStart(4)}  실제 ${String(actual[k]).padStart(4)}`);
  }

  const fails = [];
  if (!claimed.commits) fails.push("문서에서 커밋 수를 못 찾았다 — 패턴을 확인하라");
  for (const [k, tol] of Object.entries(TOLERANCE)) {
    const gap = actual[k] - (claimed[k] ?? 0);
    if (gap > tol) {
      fails.push(`${k}: 문서 ${claimed[k]} · 실제 ${actual[k]} (${gap} 뒤처짐, 허용 ${tol})`);
    }
  }

  if (fails.length) {
    console.error("\n배점 대응표의 저장소 활동 수치가 낡았다:");
    for (const f of fails) console.error(`  - ${f}`);
    console.error("\n심사자가 저장소를 열면 바로 드러난다 — 낡은 수치는 나머지 서술의 신뢰까지 깎는다.\n");
    process.exitCode = 1;
  } else {
    console.log("\nOK: 문서의 저장소 활동 수치가 실제와 허용 범위 안에서 맞는다.");
    console.log("    (정확히 같기를 요구하면 매 커밋마다 실패하는 검사가 된다.)");
  }
}
