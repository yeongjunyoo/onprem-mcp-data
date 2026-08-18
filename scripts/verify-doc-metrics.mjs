// 판정 문서 전체에서 "지표를 말하는 자리인데 정본 값이 없는" 곳을 찾는다.
//
// `metrics-check.mjs` 는 marker 가 달린 행만 본다. 그래서 marker 없는 표 행이나
// 산문에 낡은 값이 남으면 못 잡는다 — 이번에 실제로 그렇게 313단언, 18472ms,
// 접지 17/17 이 살아남아 있었다.
//
// 이 검사는 반대로 접근한다. **지표 이름과 값이 같은 줄에 있는데 그 값이 정본과
// 다르면** 후보로 올린다. marker 를 붙일 필요가 없어 문서 전역에 적용된다.
//
// ★ 형태가 아니라 문맥으로 본다.
//   값의 모양만 보면 오탐투성이다 — BIRD 0.281, "개선 전 0.278", "해시 폴백 0.775"
//   는 전부 정당한 값인데 0.9xx 형태 검사에 걸린다. 그래서 **그 줄이 어느 지표를
//   말하는지**를 먼저 보고, 그 지표의 정본이 그 줄에 없을 때만 잡는다.
//
// ★ 선언된 한계
//   과거 측정을 서술하는 줄은 정당하게 옛 값을 담는다. `<!--metric-ok-->` 로
//   면제하되, 침묵이 아니라 시점을 밝히는 문장과 함께 쓴다.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = [
  "README.md",
  "README.en.md",
  "docs/report.md",
  "docs/submission-report.md",
  // 기여자가 처음 밟는 문서. 여기 수치가 틀리면 "돌려 봤는데 다른데" 가 되고
  // 그 순간 문서 전체의 신뢰가 깎인다.
  "CONTRIBUTING.md",
];

// 정본은 metrics-check 가 이미 계산한다. 두 곳에서 따로 읽으면 갈린다.
const out = execFileSync(process.execPath, [resolve(ROOT, "scripts/metrics-check.mjs")], {
  cwd: ROOT,
  encoding: "utf8",
});
const canonical = {};
for (const m of out.matchAll(/^\s+([a-z_0-9]+) = (.+)$/gm)) canonical[m[1]] = m[2].trim();

/** 지표를 말하는 자리인지 알아보는 패턴과, 그 자리에 있어야 할 정본. */
const SUBJECTS = [
  // `hit@5` 를 생략한 짧은 표기("벡터 0.985")도 본다. 2026-08-17 실측에서 그 표기가
  // 규칙 밖이라 낡은 채로 남아 있었다 — **같은 사실을 짧게 쓰면 검사가 못 본다.**
  // 오늘 도구 수(숫자 선행)·단언 수(중간에 단어)에서도 같은 형태를 겪었다.
  { re: /벡터.{0,12}hit@5|vector hit@5|벡터\s*0\.\d{3}/i, key: "vector_hit5", val: /\b0\.\d{3}\b/g },
  { re: /홀드아웃1|holdout 1|템플릿 문형/i, key: "holdout1_strict", val: /\b0\.\d{3}\b/g },
  { re: /홀드아웃2|holdout 2|구어체|colloquial/i, key: "holdout2_strict", val: /\b0\.\d{3}\b/g },
  { re: /라우팅 도구 일치|routing tool match/i, key: "route_insample", val: /\b\d{1,2}\/30\b/g },
  { re: /근거 포함|evidence in context/i, key: "ask_evidence", val: /\b\d{1,2}\/19\b/g },
  { re: /KG 재현율|지식그래프 검색 재현율|knowledge-graph recall/i, key: "kg_recall", val: /\b\d\.\d{3}\b/g },
];

const fails = [];
let scanned = 0;

for (const doc of DOCS) {
  if (!existsSync(resolve(ROOT, doc))) continue;
  let fenced = false;
  const lines = readFileSync(resolve(ROOT, doc), "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced || line.includes("<!--metric-ok-->")) continue;
    for (const s of SUBJECTS) {
      if (!s.re.test(line)) continue;
      const want = canonical[s.key];
      if (!want) continue;
      const vals = [...line.matchAll(s.val)].map((m) => m[0]);
      if (vals.length === 0) continue;
      scanned++;
      if (!vals.includes(want)) {
        fails.push(
          `${doc}:${i + 1} — ${s.key} 를 말하는 자리인데 정본 ${want} 이 없다 (문서: ${vals.join(", ")})\n` +
            `    ${line.trim().slice(0, 100)}`,
        );
      }
    }
  }
}

console.log(`지표를 말하는 자리 ${scanned}곳을 정본과 대조했다 (문서 ${DOCS.length}개).`);

if (fails.length) {
  console.error("\n정본과 어긋나는 자리:");
  for (const f of fails) console.error(`  - ${f}`);
  console.error(
    "\n과거 측정을 일부러 서술한 자리라면 시점을 밝히는 문장과 함께 <!--metric-ok--> 로 면제한다.\n",
  );
  process.exit(1);
}

console.log("OK: 지표를 말하는 모든 자리가 정본과 일치한다.");
console.log("    (marker 없는 표 행과 산문까지 본다 — metrics-check 의 사각을 덮는다.)");
