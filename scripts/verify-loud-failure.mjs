// 실패했을 때 **조용히 다른 것을 돌려주는** 자리를 찾는다.
//
// 왜 필요한가. 이 저장소는 README 에서 Docker 의 `PublishedPort: 0` 을 길게
// 규탄한다 — 포트 충돌 시 조용히 게시를 포기하고 컨테이너는 `running` 이라 어느
// 쪽에 붙었는지 모르게 되는 문제. 그런데 같은 형태를 우리 코드가 세 군데서 하고
// 있었다(2026-08-17 실측).
//
//   MCP_TRANSPORT 오타 -> 조용히 stdio
//   스키마 카드        -> 조용히 스모크 프로파일
//   증거 목록          -> 조용히 보고서 서론
//
// 셋 다 에러 없이 **다른 것**을 준다. 받는 쪽은 성공한 줄 안다.
//
// ★ 폴백이 있는 게 문제가 아니라 폴백이 말을 안 하는 게 문제다.
//   그래서 이 검사는 catch 를 금지하지 않는다. catch 가 값을 돌려주면서
//   (a) 로그도 없고 (b) 실패 표식(ok:false / null / 빈 값)도 없고 (c) 왜 그렇게
//   하는지 주석도 없을 때만 잡는다. 셋 중 하나라도 있으면 선언된 폴백이다.
//
// 실행: node scripts/verify-loud-failure.mjs
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROOTS = [join(ROOT, "air-server", "src"), join(ROOT, "scripts")];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|mjs)$/.test(name) && !name.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

/** 이 catch 가 자기 폴백을 선언하고 있는가. */
function declaresFallback(window) {
  const text = window.join("\n");
  return (
    /console\.(warn|error)/.test(text) || // 말한다
    /\bthrow\b/.test(text) || // 안 삼킨다
    /ok:\s*false|return null|return ""|return \[\]|return undefined/.test(text) || // 실패를 값에 싣는다
    // 사람에게 실패를 말하는 문자열을 돌려주는 것도 선언이다. 리소스 핸들러는
    // 예외를 던질 수 없으니(호스트가 그냥 끊긴다) 이 형태가 유일한 발화 수단이다.
    /(찾지 못했|실패|없습니다|없음|not found|failed)/.test(text) ||
    /\/\/|\/\*/.test(text) // 왜 그런지 적어 뒀다
  );
}

const findings = [];
for (const root of ROOTS) {
  for (const file of walk(root)) {
    const lines = readFileSync(file, "utf8").split("\n");
    const rel = relative(ROOT, file).replace(/\\/g, "/");
    for (let i = 0; i < lines.length; i++) {
      if (!/^\s*\}?\s*catch\s*[({]/.test(lines[i])) continue;
      const window = lines.slice(i, i + 7);
      if (!/\breturn\b/.test(window.join("\n"))) continue;
      if (declaresFallback(window)) continue;
      findings.push(
        `${rel}:${i + 1} — catch 가 값을 돌려주는데 로그도, 실패 표식도, 설명도 없다\n` +
          `    ${(window.find((w) => w.includes("return")) ?? "").trim().slice(0, 90)}`,
      );
    }
  }
}

const scanned = ROOTS.flatMap((r) => walk(r)).length;
if (scanned === 0) {
  console.error("\n실패: 훑을 소스가 0개다 — 경로나 필터가 잘못됐다. 검사가 아무것도 안 봤다.\n");
  process.exit(1);
}
console.log(`소스 ${scanned}개에서 조용한 대체를 찾았다.`);

if (findings.length) {
  console.error("\n말하지 않는 폴백:");
  for (const f of findings) console.error(`  - ${f}`);
  console.error(
    "\n폴백을 없애라는 뜻이 아니다. 실패했음을 값이나 로그로 드러내거나, 왜 조용해도 되는지 주석으로 남겨라.\n",
  );
  process.exit(1);
}

console.log("OK: 실패 경로가 전부 자기 폴백을 선언한다.");
console.log("    (폴백이 있는 게 아니라 폴백이 말을 안 하는 게 문제다.)");
