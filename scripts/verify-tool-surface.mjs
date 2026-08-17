// 공개 문서가 말하는 MCP 도구 목록이 소스의 등록과 일치하는지 검사한다.
//
// 이 저장소는 이번에 도구 표면 때문에 두 번 데였다.
//   - `server.test.ts` 의 기대 목록이 7종에 멈춰 조용히 깨져 있었다(audit.explain 누락)
//   - 심사자용 제출보고서가 "도구 7개" 라며 내부 단계인 kgRetrieve 를 노출 도구로 적었다
//
// `server.test.ts` 가 등록 목록을 강제하지만 **DB 가 있어야 돌아 CI 에서는 안 돈다.**
// 문서와의 일치는 아무도 보지 않았다. 기능테스트에서 심사자가 문서를 보고 없는
// 도구를 부르면 그 자리에서 깨진다.
//
// 이 검사는 DB 없이 소스만 읽는다 — CI 에서 돈다.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(resolve(ROOT, p), "utf8");

// 소스 전체 목록 — 상수 해석에 쓴다.
const srcFiles = [];
(function walk(dir) {
  for (const n of readdirSync(dir)) {
    const p = resolve(dir, n);
    if (statSync(p).isDirectory()) walk(p);
    else if (n.endsWith(".ts")) srcFiles.push(p);
  }
})(resolve(ROOT, "air-server/src"));

// ── 1. 소스에서 등록 도구를 뽑는다 ──────────────────────────────────────
const serverSrc = read("air-server/src/server.ts");

// defineTool("name", ...) 또는 defineTool(CONST, ...)
const names = [];
for (const m of serverSrc.matchAll(/defineTool\(\s*(?:"([^"]+)"|([A-Z_]+))\s*,/g)) {
  if (m[1]) {
    names.push(m[1]);
    continue;
  }
  // 상수면 그 값을 찾아 푼다 (SQL_TOOL = "sql.query" 등).
  // 파일 목록을 고정하지 않고 소스 전체를 훑는다 — 상수가 다른 파일로 옮겨져도
  // 검사가 조용히 깨지지 않는다(실측: SQL_TOOL 이 router.ts 에 있었다).
  const constName = m[2];
  let value = null;
  const re = new RegExp(`export const ${constName}\\s*=\\s*"([^"]+)"`);
  for (const f of srcFiles) {
    const v = re.exec(readFileSync(f, "utf8"));
    if (v) {
      value = v[1];
      break;
    }
  }
  if (!value) {
    console.error(`\ndefineTool 의 상수 ${constName} 값을 찾지 못했다 — 검사가 도구를 놓친다.`);
    process.exit(1);
  }
  names.push(value);
}
const registered = [...new Set(names)].sort();

if (registered.length === 0) {
  console.error("\nserver.ts 에서 등록 도구를 하나도 못 찾았다 — 검사 정규식을 확인한다.");
  process.exit(1);
}

console.log(`소스 등록 도구 ${registered.length}종:`);
console.log(`  ${registered.join(", ")}`);

// ── 2. 문서의 주장과 대조 ───────────────────────────────────────────────
// 각 문서는 (a) 도구 개수를 정확히 말하고 (b) 모든 도구 이름을 담아야 한다.
const DOCS = ["README.md", "README.en.md", "docs/submission-report.md"];
const fails = [];

for (const doc of DOCS) {
  let text;
  try {
    text = read(doc);
  } catch {
    continue;
  }

  // 배지도 본다. 심사자가 저장소에서 **가장 먼저** 보는 숫자인데, 실제로
  // 영문 README 배지가 7 tools 에 멈춰 있었다(한글은 8).
  for (const m of text.matchAll(/badge\/MCP-(\d+)%20tools/g)) {
    if (Number(m[1]) !== registered.length) {
      fails.push(`${doc}: MCP 배지가 ${m[1]} tools 인데 실제는 ${registered.length}종이다`);
    }
  }

  // "도구는 8종" / "도구 8종" / "8 MCP tools" / "8개를 노출"
  const counts = [...text.matchAll(/(?:도구[^\n]{0,12}?(\d+)\s*(?:종|개)|\*\*(\d+) MCP tools\*\*|(\d+)\s+MCP tools)/g)]
    .map((m) => Number(m[1] ?? m[2] ?? m[3]))
    .filter((n) => n > 0 && n < 100);

  if (counts.length === 0) {
    fails.push(`${doc}: 도구 개수를 말하지 않는다 — 심사자가 표면을 알 수 없다`);
  } else {
    const wrong = counts.filter((c) => c !== registered.length);
    if (wrong.length) {
      fails.push(`${doc}: 도구 개수를 ${[...new Set(wrong)].join("/")}로 적었는데 실제는 ${registered.length}종이다`);
    }
  }

  // 이름을 하나라도 열거한 문서라면 전부 담아야 한다
  const listed = registered.filter((n) => text.includes(`\`${n}\``));
  if (listed.length > 0 && listed.length !== registered.length) {
    const missing = registered.filter((n) => !listed.includes(n));
    fails.push(`${doc}: 도구 이름을 열거하면서 ${missing.join(", ")} 를 빠뜨렸다`);
  }
}


// ── 검사 표 ──────────────────────────────────────────────────────────────
//
// README 「주장을 지키는 검사」 표가 실물과 맞는지 본다. 두 방향 다 문제다.
//   없는 검사를 적으면  심사자가 그 자리에서 깨뜨린다(도구 표면에서 겪은 형태다)
//   만든 검사를 안 적으면 안 만든 것과 같다 — 아무도 저장소를 뒤지지 않는다
const readmeFull = readFileSync(resolve(ROOT, "README.md"), "utf8");
const gateStart = readmeFull.indexOf("## 주장을 지키는 검사");
if (gateStart >= 0) {
  const gateEnd = readmeFull.indexOf("\n## ", gateStart + 3);
  const table = readmeFull.slice(gateStart, gateEnd > 0 ? gateEnd : undefined);
  const listed = [...new Set([...table.matchAll(/^\| `([a-z0-9-]+)`/gm)].map((m) => m[1]))];
  const files = readdirSync(resolve(ROOT, "scripts"))
    .filter((f) => f.endsWith(".mjs"))
    .map((f) => f.slice(0, -4));
  const gateFiles = files.filter(
    (f) =>
      f.startsWith("verify-") ||
      f.startsWith("drill-") ||
      ["metrics-check", "sbom", "evidence-manifest"].includes(f),
  );
  const phantom = listed.filter((n) => !files.includes(n));
  const unlisted = gateFiles.filter((n) => !listed.includes(n));
  if (phantom.length) fails.push(`README 검사 표에 실물 없는 항목: ${phantom.join(", ")}`);
  if (unlisted.length) fails.push(`검사를 만들고 README 표에 안 적었다: ${unlisted.join(", ")}`);
  console.log(`검사 표: README ${listed.length}개 = scripts ${gateFiles.length}개.`);
  // 표의 「CI」 열이 워크플로와 맞는가.
  //
  // 이름만 맞추면 절반이다. 심사자는 이 열을 보고 **무엇이 자동으로 지켜지는지**를
  // 읽는다. "예" 라고 적힌 검사가 실제로는 CI 밖이면, 자동이라고 믿는 것이 수동인
  // 상태다 — 오늘 잡은 결함 대부분이 이 형태였다.
  const workflow = readFileSync(resolve(ROOT, ".github", "workflows", "ci.yml"), "utf8");
  const inCi = new Set([...workflow.matchAll(/node scripts\/([a-z0-9-]+)\.mjs/g)].map((m) => m[1]));
  if (workflow.includes("sbom")) inCi.add("sbom");
  for (const row of table.matchAll(/^\| `([a-z0-9-]+)` \| .+? \| (.+?) \|$/gm)) {
    const [, name, ciCol] = row;
    const claimsCi = ciCol.trim() === "예";
    if (claimsCi !== inCi.has(name)) {
      fails.push(
        `README 검사 표의 CI 열이 틀렸다: ${name} 은 "${ciCol.trim()}" 인데 워크플로에는 ` +
          `${inCi.has(name) ? "있다" : "없다"}`,
      );
    }
  }

}

// ── README 가 말하는 "검사 N종" ────────────────────────────────────────
//
// 산문 안의 목록이라 지표 검사가 못 본다. 실제로 "10종" 이라 쓰고 9개만 나열한
// 적이 있다(2026-08-17) — 하루 종일 "주장하는 수와 실제가 다르다" 를 잡으면서
// 그걸 고치는 문장에서 같은 실수를 했다.
//
// 주장한 수 · 괄호 안 나열 수 · 워크플로가 부르는 수, 셋이 같아야 한다.
{
  const ci = readFileSync(resolve(ROOT, ".github", "workflows", "ci.yml"), "utf8");
  const ciCount = new Set(
    [...ci.matchAll(/node scripts\/([a-z0-9-]+)\.mjs/g)].map((m) => m[1]),
  ).size;
  // 나열은 " — " 뒤부터다. 괄호 앞부분에 설명("아래 표의 17종 중 ...")이 올 수 있고
  // 그것까지 세면 나열 수가 부풀려진다 — 실제로 이 문장을 고치다 그렇게 됐다.
  const koClaim = readmeFull.match(/\*\*검사 (\d+)종\*\*\(([^)]+)\)/);
  if (koClaim) koClaim[2] = koClaim[2].includes(" — ") ? koClaim[2].split(" — ").pop() : koClaim[2];
  if (koClaim) {
    const claimed = Number(koClaim[1]);
    const listed = koClaim[2].split("·").length;
    if (claimed !== listed) {
      fails.push(`README 검사 수: "${claimed}종" 이라 쓰고 ${listed}개만 나열했다`);
    }
    if (claimed !== ciCount) {
      fails.push(`README 검사 수: "${claimed}종" 인데 워크플로는 ${ciCount}종을 부른다`);
    }
  }
}

// ── 버전 정본 ────────────────────────────────────────────────────────────
//
// 종전에는 셋이 갈려 있었다 — git 태그 v0.1.0, package.json 0.1.3, server.ts 0.2.0.
// 심사자가 MCP 로 붙으면 서버가 말하는 값을 보고 저장소에서는 package.json 을 본다.
// 어느 것이 이 프로젝트의 버전인지 아무도 답할 수 없었다.
//
// 코드는 이제 package.json 을 읽으므로 갈릴 수 없다. 그 규칙이 지켜지는지 보고,
// 태그가 뒤처지면 **조용히 두지 않고 말한다** — 릴리스 페이지가 현재를 대변하지
// 못하면 심사자는 옛 버전을 현재로 읽는다.
const pkgJson = JSON.parse(readFileSync(resolve(ROOT, "air-server", "package.json"), "utf8"));
const hardcoded = readFileSync(resolve(ROOT, "air-server", "src", "server.ts"), "utf8").match(
  /version:\s*"(\d+\.\d+\.\d+)"/,
);
if (hardcoded) {
  console.error(
    `\n실패: server.ts 가 버전을 하드코딩했다(${hardcoded[1]}). package.json 을 읽어야 한다.\n`,
  );
  process.exit(1);
}

let latestTag = "";
try {
  latestTag = execFileSync("git", ["describe", "--tags", "--abbrev=0"], {
    cwd: ROOT,
    encoding: "utf8",
  }).trim();
} catch {
  /* 태그 없는 저장소 — 검사 대상이 아니다 */
}
if (latestTag && latestTag.replace(/^v/, "") !== pkgJson.version) {
  const behind = execFileSync("git", ["rev-list", `${latestTag}..HEAD`, "--count"], {
    cwd: ROOT,
    encoding: "utf8",
  }).trim();
  console.log(
    `주의: 최신 태그 ${latestTag} 가 package.json ${pkgJson.version} 보다 뒤처졌다 (${behind}커밋).`,
  );
} else if (latestTag) {
  console.log(`버전 정본: package.json ${pkgJson.version} = 태그 ${latestTag}.`);
}

// 판정은 **모든 검사 뒤**에 온다. 앞에 두면 그 뒤에 추가한 검사가
// 조용히 아무 일도 안 한다 — 검사 표 대조를 넣고 실제로 그랬다.
if (fails.length) {
  console.error("\n문서의 도구 표면이 소스와 어긋난다:");
  for (const f of fails) console.error(`  - ${f}`);
  console.error("\n기능테스트에서 심사자가 문서를 보고 없는 도구를 부르면 그 자리에서 깨진다.\n");
  process.exit(1);
}

console.log("\nOK: 문서의 도구 개수·목록이 소스 등록과 일치한다.");
console.log("    (등록 자체의 동작은 server.test 가 검증한다 — DB 가 필요해 CI 밖에서 돈다.)");
