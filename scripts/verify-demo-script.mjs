// 녹화 대본이 약속하는 것이 실제로 존재하는지 확인한다.
//
// 대본은 두 종류를 약속한다.
//   실행 화면  — `npm run demo:ollama` 가 찍는 것 (도구 목록, 거부 화면, 2000건 …)
//   띄우는 파일 — faults.json, internal-*-summary.json 의 수치
//
// 후자가 위험하다. **명령 출력이 아니라 파일을 열어 화면에 띄우는 것**이라 값이
// 낡으면 영상에 그대로 찍힌다. 영상은 재업로드가 되지만 이미 본 심사자에겐
// 못 고친다.
//
// ★ 대본에 적힌 수를 파일에서 다시 읽어 대조한다.
//   대본이 "83/100" 이라 적었으면 internal-llm-summary.json 이 83 이어야 하고,
//   "1%/30%/83%" 라 적었으면 template/naive/llm 이 그 순서여야 한다.
//
// 실행: node scripts/verify-demo-script.mjs   (파일만 읽는다 — DB·모델 불필요)
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = readFileSync(resolve(ROOT, "docs", "demo-script.md"), "utf8");
const fails = [];
let checked = 0;

const readJson = (rel) => {
  const p = resolve(ROOT, rel);
  if (!existsSync(p)) {
    fails.push(`대본이 띄우라는 파일이 없다: ${rel}`);
    return null;
  }
  return JSON.parse(readFileSync(p, "utf8"));
};

// 0) 대본이 가리키는 섹션이 실물 데모에 있는가
//
//   `verify-demo-script` 는 대본의 **수**를 대조하는데 **섹션 번호**는 아무도 안
//   봤다. 이 대본은 3분 시연영상의 촬영 지시서다 — 화면에 섹션 5가 안 뜨는데
//   대본이 5를 가리키면 녹화 중에 알게 되고 다시 찍어야 한다.
//
//   **문서가 틀린 비용을 사람이 시간으로 낸다.**
{
  const demoSrc = resolve(ROOT, "air-server/src/cli/demo.ts");
  if (!existsSync(demoSrc)) {
    fails.push("demo.ts 를 못 찾았다 — 섹션 대조를 건너뛰지 않고 실패시킨다");
  } else {
    const src = readFileSync(demoSrc, "utf8");
    // 섹션은 `hr("N) ...")` 로 찍는다. 출력 문자열(`=== N) ===`)을 찾으면 헬퍼
    // 정의 한 줄만 걸리고 실제 섹션은 하나도 안 걸린다 — 초판이 그래서 실물을
    // {0} 으로 봤다. **찍히는 모양이 아니라 부르는 자리를 본다.**
    const real = new Set([...src.matchAll(/hr\("(\d+)\)/g)].map((m) => m[1]));
    const cited = new Set();
    for (const m of script.matchAll(/섹션\s*(\d+)(?:\s*[-–~]\s*(\d+))?/g)) {
      cited.add(m[1]);
      if (m[2]) {
        for (let i = Number(m[1]); i <= Number(m[2]); i++) cited.add(String(i));
      }
    }
    if (cited.size === 0) {
      fails.push("대본이 섹션을 하나도 가리키지 않는다 — 패턴이 낡았는지 확인하라");
    }
    for (const n of [...cited].sort()) {
      checked++;
      if (!real.has(n)) {
        fails.push(`대본이 섹션 ${n} 을 가리키는데 데모는 그 섹션을 찍지 않는다 ` +
          `(실물: ${[...real].sort().join(", ")})`);
      }
    }
  }
}

// 1) internal-llm-summary 의 정확도
const llmClaim = script.match(/internal-llm-summary[^)]*?\((\d+)\/(\d+)\)/);
if (llmClaim) {
  checked++;
  const [, correct, total] = llmClaim.map(Number);
  const s = readJson("eval/results/internal-llm-summary.json");
  if (s && (s.correct !== correct || s.total !== total)) {
    fails.push(
      `대본은 internal-llm ${correct}/${total} 인데 파일은 ${s.correct}/${s.total} 이다`,
    );
  }
}

// 2) ablation 3행 — 순서는 대본 문맥상 template / naive / llm 이다
const abl = script.match(/ablation\s*3행\((\d+)%\/(\d+)%\/(\d+)%\)/);
if (abl) {
  checked++;
  const want = abl.slice(1).map(Number);
  const got = ["template", "naive", "llm"].map((k) => {
    const s = readJson(`eval/results/internal-${k}-summary.json`);
    return s?.accuracy ?? null;
  });
  if (got.some((v, i) => v !== want[i])) {
    fails.push(`대본은 ablation ${want.join("/")}% 인데 파일은 ${got.join("/")}% 이다`);
  }
}

// 3) faults.json — 4/4/4 가 통과 상태인지
if (/faults\.js/.test(script)) {
  checked++;
  // summary 아래에 중첩돼 있다 — 최상위에서 찾다가 오탐을 냈다.
  const raw = readJson("eval/results/faults.json");
  const f = raw?.summary ?? raw;
  if (f && (f.pass !== true || f.total !== 4)) {
    fails.push(`대본이 띄우는 faults.json 이 통과 상태가 아니다: ${JSON.stringify(f)}`);
  }
}

console.log(`대본이 화면에 띄우라는 아티팩트 ${checked}종을 실물과 대조했다.`);

if (checked === 0) {
  console.error("\n실패: 대조한 항목이 0개다 — 대본 형식이 바뀌었는지 확인한다.\n");
  process.exit(1);
}

if (fails.length) {
  console.error("\n대본과 실물이 어긋난다:");
  for (const f of fails) console.error(`  - ${f}`);
  console.error("\n영상에 그대로 찍힌다 — 녹화 전에 고친다.\n");
  process.exit(1);
}

console.log("OK: 대본이 띄우는 수치가 실물과 일치한다.");
console.log("    (파일을 화면에 띄우는 장면은 값이 낡으면 영상에 그대로 남는다.)");
