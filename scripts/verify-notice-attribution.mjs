// Apache-2.0 의존성이 NOTICE 에 귀속돼 있는지 확인한다.
//
// 2차 배점에 라이선스 5점이 있다. SBOM 은 라이선스 **종류**를 세지만, Apache-2.0 은
// **NOTICE 전파 의무**(§4(d))가 따로 있다 — 귀속이 빠지면 형식 위반이다.
//
// 실측(2026-08-17): SBOM 의 Apache-2.0 3종 중 `typescript` 가 NOTICE 에 없었다.
// 아무 검사도 NOTICE 내용을 보지 않았다.
//
// ★ 이름 표기가 다르다.
//   SBOM 은 패키지 이름(`qwen2.5:7b`)을, NOTICE 는 사람이 읽는 이름
//   (`Qwen2.5-7B-Instruct`)을 쓴다. 단순 문자열 포함으로 보면 **있는데 없다고**
//   한다. 정규화해서 비교한다 — 오탐이 있는 검사는 사람이 꺼버린다.
//
// 실행: node scripts/verify-notice-attribution.mjs   (파일만 읽는다)
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sbom = readFileSync(resolve(ROOT, "docs/sbom.md"), "utf8");
const notice = readFileSync(resolve(ROOT, "NOTICE"), "utf8");

// 비교용 정규화: 소문자, 영숫자만. `qwen2.5:7b` → `qwen257b`,
// `Qwen2.5-7B-Instruct` → `qwen257binstruct` (앞이 뒤에 포함된다)
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const noticeNorm = norm(notice);

const apache = [];
for (const line of sbom.split("\n")) {
  if (!line.startsWith("|")) continue;
  const c = line.split("|").map((x) => x.trim());
  if (c.length < 6) continue;
  const [, , name, version, licence] = c;
  if (/apache/i.test(licence)) apache.push({ name, version, licence });
}

if (apache.length === 0) {
  console.error("\n실패: SBOM 에서 Apache 계열 의존성을 하나도 못 찾았다 — 파싱을 확인하라.\n");
  process.exit(1);
}

const missing = apache.filter((d) => !noticeNorm.includes(norm(d.name)));

console.log(`Apache-2.0 계열 의존성 ${apache.length}종을 NOTICE 와 대조했다.`);
for (const d of apache) {
  const ok = !missing.includes(d);
  console.log(`  ${ok ? "OK " : "★ "}${d.name.padEnd(24)} ${d.licence}`);
}

if (missing.length) {
  console.error("\nNOTICE 에 귀속이 빠진 Apache-2.0 의존성:");
  for (const d of missing) console.error(`  - ${d.name} (${d.version}) — ${d.licence}`);
  console.error(
    "\nApache-2.0 §4(d) 는 NOTICE 전파를 요구한다. 라이선스 심사 항목이다.\n",
  );
  process.exit(1);
}

console.log("OK: Apache-2.0 의존성이 전부 NOTICE 에 귀속돼 있다.");
console.log("    (SBOM 은 라이선스 종류를 세고, 이 검사는 귀속이 실렸는지 본다.)");
