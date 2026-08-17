// SECURITY.md 가 약속한 신고 경로가 **실제로 열려 있는지** 확인한다.
//
// SECURITY.md 는 "GitHub의 비공개 취약점 신고(Security 탭 > Report a vulnerability)를
// 이용하거나" 라고 안내한다. 그런데 그 기능이 꺼져 있었다(2026-08-17 실측:
// `private_vulnerability_reporting.enabled = false`).
//
// 신고자는 안내받은 탭에 갔다가 버튼을 못 찾는다. **문서가 약속한 문이 잠겨
// 있었다.** 코드 결함보다 조용하고, 그래서 더 오래 간다.
//
// ★ 저장소 설정은 커밋에 남지 않는다.
//   코드는 리뷰를 거치지만 설정은 누가 언제 껐는지 이력이 없다. 그래서 문서가
//   약속한 설정은 검사로 붙들어 둔다.
//
// 실행: node scripts/verify-security-policy.mjs   (GITHUB_TOKEN 또는 gh 인증 필요)
// 네트워크가 없으면 건너뛴다 — CI 밖 로컬 점검용이다.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = "yeongjunyoo/onprem-mcp-data";

const policy = readFileSync(resolve(ROOT, "SECURITY.md"), "utf8");
const promisesPrivateReporting = /비공개 취약점 신고|private vulnerability/i.test(policy);
if (!promisesPrivateReporting) {
  console.log("SECURITY.md 가 비공개 신고를 안내하지 않는다 — 검사할 약속이 없다.");
  process.exit(0);
}

function token() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    return execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

const auth = token();
if (!auth) {
  console.log("GitHub 토큰이 없어 건너뛴다(로컬 점검용 검사다).");
  process.exit(0);
}

async function api(path) {
  const r = await fetch(`https://api.github.com/repos/${REPO}${path}`, {
    headers: { Authorization: `token ${auth}`, Accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) throw new Error(`${path} -> HTTP ${r.status}`);
  return r.json();
}

const failures = [];
try {
  const pvr = await api("/private-vulnerability-reporting");
  if (pvr.enabled) {
    console.log("  비공개 취약점 신고   열려 있다");
  } else {
    failures.push(
      "SECURITY.md 는 비공개 신고를 안내하는데 그 기능이 꺼져 있다 — 신고자가 버튼을 못 찾는다",
    );
  }

  const repo = await api("");
  const sa = repo.security_and_analysis ?? {};
  for (const [key, label] of [
    ["secret_scanning", "비밀 스캔"],
    ["secret_scanning_push_protection", "푸시 보호"],
  ]) {
    if (sa[key]?.status === "enabled") console.log(`  ${label.padEnd(18)} 켜져 있다`);
    else failures.push(`${label}이 꺼져 있다 — 자격증명이 커밋될 수 있다`);
  }
} catch (e) {
  console.log(`GitHub API 에 닿지 못해 건너뛴다: ${e.message}`);
  process.exit(0);
}

if (failures.length) {
  console.error("\nSECURITY.md 의 약속과 저장소 설정이 어긋난다:");
  for (const f of failures) console.error(`  - ${f}`);
  console.error("\n설정을 켜거나 SECURITY.md 에서 그 안내를 지운다. 약속만 남기지 않는다.\n");
  process.exit(1);
}

console.log("\nOK: SECURITY.md 가 안내하는 신고 경로가 실제로 열려 있다.");
console.log("    (설정은 커밋에 남지 않는다 — 그래서 검사로 붙들어 둔다.)");
