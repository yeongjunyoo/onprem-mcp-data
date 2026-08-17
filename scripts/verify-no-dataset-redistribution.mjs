// 사업자 데이터셋이 저장소에 재배포되지 않았는지 확인한다.
//
// 배포 조건은 "대회 목적 사용 한정, 재배포 금지" 다. 작업 트리에 데이터셋이 없다는
// 것만으로는 부족하다 — 평가 산출물이 문서 본문을 실어 나를 수 있다.
//
// 실제로 그랬다(2026-08-17 실측): `eval/results/companyx-audit.json` 의
// `fusion[].preview` 가 문서 본문 120자를 158개 담고 있었다. 데이터셋 파일은 한
// 번도 커밋된 적이 없는데(이력 전수 확인), 산출물이 대신 실어 나르고 있었다.
//
// ★ 원문 스니펫과 시스템 출력은 다르다.
//   `preview` / `chunk` / `context` 는 코퍼스를 그대로 옮긴 것이라 재배포다.
//   `answer` 는 시스템이 만든 출력이고, 근거를 인용하는 것이 이 제품의 기능이며
//   접지 평가의 증거다. 지우면 증거가 사라진다. 대신 **길이 상한**을 둬서 답변이
//   문서를 통째로 쏟는 경우를 막는다.
//
// 실행: node scripts/verify-no-dataset-redistribution.mjs
// 데이터셋이 없으면(CI) 구조 규칙만 검사한다.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DATASET = join(ROOT, "datasets", "companyx-v1.0");
const ANSWER_MAX_CHARS = 2000; // 답변이 이보다 길면 문서를 쏟고 있다고 본다
const failures = [];

const tracked = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" })
  .split("\n")
  .filter((f) => f.trim());

// ── 1. 데이터셋 파일 자체가 추적되고 있는가 ─────────────────────────────
const datasetFiles = tracked.filter(
  (f) => f.includes("companyx-v1.0") || (f.startsWith("datasets/") && f !== "datasets/MANIFEST.md"),
);
if (datasetFiles.length) {
  failures.push(`데이터셋 파일이 커밋돼 있다: ${datasetFiles.slice(0, 5).join(", ")}`);
}

// ── 2. 구조 규칙 — preview 는 가려져 있어야 한다 ────────────────────────
// 데이터셋이 없어도 검사할 수 있다. 이것이 CI 에서 도는 층이다.
let previewsChecked = 0;
for (const f of tracked.filter((f) => f.startsWith("eval/results/") && f.endsWith(".json"))) {
  let data;
  try {
    data = JSON.parse(readFileSync(join(ROOT, f), "utf8"));
  } catch {
    continue;
  }
  const stack = [data];
  while (stack.length) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      stack.push(...node);
    } else if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node)) {
        if (k === "preview" && typeof v === "string") {
          previewsChecked++;
          if (!v.startsWith("[본문 비공개")) {
            failures.push(`${f}: preview 가 가려지지 않았다 — ${JSON.stringify(v.slice(0, 40))}`);
          }
        } else if (k === "answer" && typeof v === "string" && v.length > ANSWER_MAX_CHARS) {
          failures.push(`${f}: answer 가 ${v.length}자다 (상한 ${ANSWER_MAX_CHARS}) — 문서를 쏟고 있다`);
        } else {
          stack.push(v);
        }
      }
    }
  }
}
if (previewsChecked === 0) {
  console.error("\n실패: 검사한 preview 가 0개다 — eval/results 를 못 읽었거나 필터가 잘못됐다.\n");
  process.exit(1);
}
console.log(`구조 검사: 커밋된 preview ${previewsChecked}개가 전부 가려져 있는지 확인.`);

// ── 3. 본문 대조 — 데이터셋이 로컬에 있을 때만 ──────────────────────────
if (existsSync(DATASET)) {
  const bodies = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(txt|md)$/.test(name)) {
        for (const line of readFileSync(p, "utf8").split("\n")) {
          const c = line.trim();
          if (c.length >= 30) bodies.push(c);
        }
      }
    }
  };
  const docs = join(DATASET, "documents");
  if (existsSync(docs)) walk(docs);

  let leaked = 0;
  for (const f of tracked.filter((f) => f.startsWith("eval/") || f.startsWith("docs/"))) {
    const text = readFileSync(join(ROOT, f), "utf8");
    for (const b of bodies) {
      if (!text.includes(b)) continue;
      // answer 안의 인용은 시스템 출력이다 — 상한 검사가 따로 지킨다.
      const inAnswerOnly = /"answer":/.test(text) && !/"preview":\s*"(?!\[본문 비공개)/.test(text);
      if (!inAnswerOnly) {
        failures.push(`${f}: 문서 본문이 원문 필드에 실려 있다 — ${JSON.stringify(b.slice(0, 40))}`);
        leaked++;
      }
      break;
    }
  }
  console.log(`본문 대조: 문서 ${bodies.length}줄과 커밋 파일을 맞춰 유출 ${leaked}건.`);
} else {
  console.log("본문 대조: 데이터셋이 로컬에 없어 건너뛴다(구조 검사는 위에서 끝났다).");
}

if (failures.length) {
  console.error("\n재배포 금지 조건 위반:");
  for (const f of failures) console.error(`  - ${f}`);
  console.error(
    "\n원문 스니펫은 redactForPublication 으로 가린다. 시스템 출력(answer)은 근거로 남기되 길이를 지킨다.\n",
  );
  process.exit(1);
}

console.log("\nOK: 사업자 데이터셋이 저장소에 재배포되지 않았다.");
console.log("    (원문 스니펫과 시스템 출력은 다르다 — 전자는 가리고 후자는 상한을 둔다.)");
