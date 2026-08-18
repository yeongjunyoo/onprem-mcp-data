// audit 계약이 **값의 형태**까지 실물과 맞는지 확인한다.
//
// `verify-stdio-tools` 와 audit 스키마 대조는 **필드 유무**를 본다. 필드 안의
// 값이 설명대로인지는 못 본다.
//
// 실측(2026-08-17): `branch_errors` 계약이 "레인별로 실패한 내용" 이라고 말하는데
// 같은 날 추가한 생성 실패가 `answer: ...` 로 들어갔다. **answer 는 레인이 아니다.**
// 필드는 그대로라 기존 검사는 통과했다 — 표식은 맞고 내용이 달랐다.
//
// ★ 계약이 열거하는 출처와 코드가 실제로 넣는 접두부가 같아야 한다.
//
// 실행: node scripts/verify-audit-contract.mjs   (파일만 읽는다)
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fails = [];

const resources = readFileSync(resolve(ROOT, "air-server/src/resources.ts"), "utf8");
const pipeline = readFileSync(resolve(ROOT, "air-server/src/pipeline.ts"), "utf8");

// 1) 코드가 실제로 넣는 접두부 — `branchErrors.push(\`x: ...\`)` 와 배열 리터럴 둘 다
const emitted = new Set();
for (const m of pipeline.matchAll(/branchErrors\.push\(`([a-z]+):/g)) emitted.add(m[1]);
// `branch_errors: [...(prev ?? []), \`answer: ...\`]` 처럼 스프레드 안에 빈 배열이
// 있으면 `[^\]]*` 가 거기서 끊긴다. 2026-08-17 에 그래서 answer 를 놓쳤고
// **위조 시험이 통과해서** 알았다 — 위조가 안 잡히면 검사가 아니다.
//
// 넓은 패턴 하나보다 좁은 패턴 여럿이 낫다. branch_errors 를 언급하는 줄부터
// 몇 줄 안에서 백틱 접두부를 찾는다.
for (const m of pipeline.matchAll(/branch_errors:[\s\S]{0,200}?`([a-z]+):\s*\$\{/g)) {
  emitted.add(m[1]);
}

if (emitted.size === 0) {
  console.error("\n실패: branch_errors 에 넣는 접두부를 하나도 못 찾았다 — 패턴을 확인하라.\n");
  process.exit(1);
}

// 2) 계약이 열거하는 출처
const contract = resources.match(/branch_errors:\s*((?:"[^"]*"\s*\+?\s*)+)/);
if (!contract) {
  fails.push("resources.ts 에서 branch_errors 설명을 못 찾았다");
} else {
  const text = contract[1];
  const missing = [...emitted].filter((p) => !text.includes(p));
  if (missing.length) {
    fails.push(
      `계약이 설명하지 않는 출처: ${missing.join(", ")} ` +
        `(코드는 넣는데 audit://schema/v1 은 말하지 않는다)`,
    );
  }
}

console.log(`branch_errors 출처 ${emitted.size}종: ${[...emitted].sort().join(", ")}`);

if (fails.length) {
  console.error("\naudit 계약이 실물과 어긋난다:");
  for (const f of fails) console.error(`  - ${f}`);
  console.error(
    "\n필드가 있는 것과 값이 설명대로인 것은 다르다 — 계약을 실물에 맞춘다.\n",
  );
  process.exit(1);
}

console.log("OK: audit 계약이 코드가 넣는 출처를 전부 설명한다.");
console.log("    (필드 유무가 아니라 값의 형태까지 본다.)");
