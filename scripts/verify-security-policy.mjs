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
// 2026-08-18 리뷰 지적: 이 게이트가 스크립트 전체를 막고 있었다. SECURITY.md 문구를
// 지우면 **무관한 저장소 설정 검사(보호·자동삭제)까지 같이 사라진다.**
// 종료하지 않고 플래그로 둔다 — 신고 경로 검사만 건너뛴다.
if (!promisesPrivateReporting) {
  console.log("SECURITY.md 가 비공개 신고를 안내하지 않는다 — 신고 경로 검사는 건너뛴다.");
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
  if (promisesPrivateReporting) {
    const pvr = await api("/private-vulnerability-reporting");
    if (pvr.enabled) {
      console.log("  비공개 취약점 신고   열려 있다");
    } else {
      failures.push(
        "SECURITY.md 는 비공개 신고를 안내하는데 그 기능이 꺼져 있다 — 신고자가 버튼을 못 찾는다",
      );
    }
  }

  const repo = await api("");

  // ── 오늘 켠 설정 둘. 커밋에 안 남으므로 여기서 붙든다.
  //
  // 2026-08-18: `enforce_admins` 가 **false** 여서 필수 상태 검사가 등록돼 있는데도
  // 관리자(나)가 빨간 PR 을 병합했다. **규칙이 있는 것과 나에게도 적용되는 것은 다르다.**
  // `delete_branch_on_merge` 는 손으로 지우는 규율이 안 지켜져서 켰다 — 브랜치 100개를
  // 지운 당일 다음 PR 이 또 하나를 남겼다.
  if (repo.delete_branch_on_merge !== true) {
    failures.push("delete_branch_on_merge 가 꺼져 있다 — 병합된 브랜치가 쌓인다");
  }

  // 보호가 통째로 없으면 이 엔드포인트는 **404** 를 준다. 예외로 흘리면 바깥 catch 가
  // "GitHub 에 못 붙었다" 로 처리하며 exit 0 하고 — **잡으려던 드리프트가 통과한다**
  // (2026-08-18 리뷰 지적). 없는 것이 곧 드리프트이므로 실패로 번역한다.
  let prot = null;
  try {
    prot = await api("/branches/main/protection");
  } catch (e) {
    if (String(e.message).includes("HTTP 404")) {
      failures.push("main 에 브랜치 보호가 아예 없다 — 빨간 PR 도 그대로 들어간다");
    } else {
      throw e;
    }
  }
  if (prot?.enforce_admins?.enabled !== true) {
    failures.push("main 보호의 enforce_admins 가 꺼져 있다 — 관리자가 빨간 PR 을 병합할 수 있다");
  } else {
    console.log("  관리자에게도 CI 강제   켜져 있다");
  }
  const contexts = prot?.required_status_checks?.contexts ?? [];
  for (const need of [
    "typecheck + offline unit tests (20)",
    "typecheck + offline unit tests (22)",
    "SBOM drift check",
  ]) {
    if (!contexts.includes(need)) {
      failures.push(`main 보호의 필수 상태 검사에 「${need}」 가 없다`);
    }
  }
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
