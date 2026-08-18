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

// ── 실물 레코드와 필드 목록 대조 (선택: DB·모델이 있을 때만) ──────────────
//
// 위까지는 소스만 읽는다. 필드 목록 자체가 갈리는 것은 실물을 받아야 안다.
// 2026-08-17 실측: audit.explain 이 14종을 돌려주는데 계약은 12종만 설명했다
// (executed_at · cache_policy 누락). PR #73 에서 한 번 맞췄는데 그 뒤 필드가 늘고
// 계약이 안 따라갔다 — **한 번 맞춘 것이 다시 갈린다.**
//
// `--live` 를 주면 서버를 띄워 대조한다. CI 는 DB 가 없으므로 소스 검사까지만 한다.
if (process.argv.includes("--live")) {
  const { spawn } = await import("node:child_process");
  const entry = resolve(ROOT, "air-server/dist/index.js");
  const child = spawn("node", [entry], { cwd: ROOT, stdio: ["pipe", "pipe", "ignore"] });
  const send = (o) => child.stdin.write(`${JSON.stringify(o)}\n`);
  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "verify-audit-contract", version: "1.0" },
    },
  });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "audit.explain", arguments: { query: "환불 정책이 무엇인가" } },
  });
  send({ jsonrpc: "2.0", id: 3, method: "resources/read", params: { uri: "audit://schema/v1" } });

  const got = await new Promise((res) => {
    const acc = {};
    let buf = "";
    const timer = setTimeout(() => res(acc), 300_000);
    child.stdout.on("data", (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === 2 || msg.id === 3) acc[msg.id] = msg;
        if (acc[2] && acc[3]) {
          clearTimeout(timer);
          res(acc);
        }
      }
    });
  });
  child.kill();

  if (!got[2] || !got[3]) {
    console.error("\n실패: 실물 레코드나 스키마를 못 받았다 — 스택이 떠 있는지 확인한다.\n");
    process.exit(1);
  }

  const record = JSON.parse(got[2].result.content[0].text);
  const schemaDoc = JSON.parse(got[3].result.contents[0].text);
  const described = schemaDoc.fields ?? schemaDoc;

  const onlyReal = Object.keys(record).filter((k) => !(k in described));
  const onlyDoc = Object.keys(described).filter((k) => !(k in record));
  console.log(`실물 ${Object.keys(record).length}종 · 계약 ${Object.keys(described).length}종`);
  if (onlyReal.length || onlyDoc.length) {
    console.error("\n필드 목록이 갈렸다:");
    if (onlyReal.length) console.error(`  - 계약이 설명하지 않는 필드: ${onlyReal.join(", ")}`);
    if (onlyDoc.length) console.error(`  - 계약에만 있는 필드: ${onlyDoc.join(", ")}`);
    process.exit(1);
  }
  console.log("실물 대조: 필드 목록이 정확히 일치한다.");
}

console.log("OK: audit 계약이 코드가 넣는 출처를 전부 설명한다.");
console.log("    (필드 유무가 아니라 값의 형태까지 본다.)");
