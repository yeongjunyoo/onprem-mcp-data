#!/usr/bin/env node
// 문서에 적힌 수치가 실제 측정 결과와 어긋나면 실패한다.
//
// 왜 필요한가. 이 저장소는 같은 결함을 세 번 반복했다.
//   1. 결과보고서가 "홀드아웃 구축이 다음 작업"이라 적힌 채 레포엔 결과가 두 벌 있었다.
//   2. eval/results/companyx-ask.json(07-27)이 자기 입력인 vector_gold.json(07-29)보다
//      낡은 채로 남았고, 그 낡은 91.3%가 결과보고서 헤드라인에 들어갔다.
//   3. README.en.md가 0.985/223단언에 멈춰 있는 동안 README.md는 0.986/388이었다.
//
// 셋 다 "사람이 기억해서 같이 고치기"에 의존했고 셋 다 실패했다. 그래서 기계가 막는다.
//
// 검사 셋:
//   A. 신선도 — 결과 JSON이 자기 입력보다 새로운가
//   B. 정합성 — 문서에 등장하는 지표값이 결과 JSON의 값과 같은가
//   C. 대역 일치 — 한국어 문서와 영어 문서가 같은 수를 말하는가
//
// ★ 선언된 범위 한계 (덮지 못하는 것을 덮은 척하지 않는다).
//   이 검사는 **마크다운 파이프 표 행만** 본다. 산문·목록·HTML 표·코드블록에 적힌
//   수치는 검사하지 않는다. 산문에는 이력("0.433에서 0.633으로")과 다른 통계(Wilson
//   하한)가 정당하게 섞이고, 그것까지 잡으면 오탐이 생기며 오탐이 생기면 사람이
//   검사를 꺼버리기 때문이다. 정본 수치는 표에 적고 산문은 설명에 쓴다는 규약이
//   이 검사의 전제다. 규약을 어기면 검사는 막지 못한다 — 알려진 한계다.
//
// 사용: node scripts/metrics-check.mjs
import { readFileSync, statSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(resolve(ROOT, p), "utf8");
const readJson = (p) => JSON.parse(read(p));
const fails = [];

// ── A. 신선도 ───────────────────────────────────────────────────────────
// 결과는 자기 입력보다 새로워야 한다. 입력이 바뀌었는데 결과를 안 돌리면
// 그 결과는 더 이상 그 입력에 대한 측정이 아니다.
const FRESHNESS = [
  { result: "eval/results/companyx-ask.json", inputs: ["eval/companyx/vector_gold.json", "eval/companyx/kg_gold.json", "eval/companyx/sql_gold.jsonl"] },
  { result: "eval/results/companyx-vector.json", inputs: ["eval/companyx/vector_gold.json"] },
  { result: "eval/results/companyx-holdout-route.json", inputs: ["eval/companyx/holdout_route.json"] },
  { result: "eval/results/companyx-holdout2-route.json", inputs: ["eval/companyx/holdout2_route.json"] },
];

for (const { result, inputs } of FRESHNESS) {
  if (!existsSync(resolve(ROOT, result))) continue;
  const rt = statSync(resolve(ROOT, result)).mtimeMs;
  for (const i of inputs) {
    if (!existsSync(resolve(ROOT, i))) continue;
    if (statSync(resolve(ROOT, i)).mtimeMs > rt) {
      fails.push(`신선도: ${i} 가 ${result} 보다 새롭다 — 평가를 다시 돌려야 한다`);
    }
  }
}

// ── 정본 지표 ───────────────────────────────────────────────────────────
// 값은 전부 결과 JSON에서 읽는다. 여기에 손으로 적지 않는다.
const canonical = {};

const vec = readJson("eval/results/companyx-vector.json");
const vecKey = Object.keys(vec.detail).find((k) => k.includes("bge-m3@768")) ?? Object.keys(vec.detail)[0];
canonical.vector_hit5 = vec.detail[vecKey]["hit@5"].toFixed(3);

const h1 = readJson("eval/results/companyx-holdout-route.json");
canonical.holdout1_strict = h1.summary.strict_accuracy.toFixed(3);

if (existsSync(resolve(ROOT, "eval/results/companyx-holdout2-route.json"))) {
  const h2 = readJson("eval/results/companyx-holdout2-route.json");
  canonical.holdout2_strict = h2.summary.strict_accuracy.toFixed(3);
}

const kg = readJson("eval/results/companyx-kg.json");
canonical.kg_recall = Number(kg.summary.mean_recall).toFixed(3);

// ── B. 정합성 ───────────────────────────────────────────────────────────
// 문서에서 지표가 쓰인 자리를 찾아, 거기 적힌 값이 정본과 같은지 본다.
// "언급되어야 한다"가 아니라 "어긋나면 안 된다"를 검사한다.
const DOCS = ["README.md", "README.en.md", "docs/report.md"];
const CLAIMS = [
  {
    metric: "vector_hit5",
    // "hit@5 | **0.986 (73/74)**" / "hit@5 ... 0.986"
    re: /hit@5[^\n]*?(0\.\d{3})/g,
    label: "벡터 hit@5",
  },
  {
    metric: "holdout1_strict",
    // "라우팅 일반화 (홀드아웃)" 행. 구어체(holdout2)와 구분하기 위해 구어체 표기가
    // 없는 홀드아웃 행만 본다.
    re: /홀드아웃(?![^\n]*구어체)[^\n]*?(0\.\d{3})/g,
    label: "홀드아웃1 strict",
  },
  {
    metric: "holdout2_strict",
    re: /(?:구어체|colloquial)[^\n]{0,60}?(0\.\d{3})/g,
    label: "홀드아웃 2차(구어체) strict",
  },
];

// 산문이 아니라 **표 행만** 본다. 산문에는 이력("0.433에서 0.633으로")과 다른
// 통계(Wilson 하한)가 정당하게 섞이는데, 그것까지 잡으면 오탐이 생기고 오탐이
// 생기면 사람이 검사를 꺼버린다. 정본 주장은 표에 있다.
// 표 행이라도 의도적으로 과거값을 적어야 하면 그 행에 <!--metric-ok--> 를 단다.
for (const doc of DOCS) {
  if (!existsSync(resolve(ROOT, doc))) continue;
  for (const line of read(doc).split("\n")) {
    if (!line.trimStart().startsWith("|")) continue;
    if (line.includes("<!--metric-ok-->")) continue;
    for (const claim of CLAIMS) {
      const want = canonical[claim.metric];
      if (want === undefined) continue;
      for (const m of line.matchAll(claim.re)) {
        const got = m[1] ?? m[2];
        if (!got || got === want) continue;
        fails.push(`정합성: ${doc} 표 행의 ${claim.label} = ${got} 인데 측정값은 ${want} (…${line.trim().slice(0, 70)}…)`);
      }
    }
  }
}

// ── C. 대역 일치 ────────────────────────────────────────────────────────
// 한국어 문서와 영어 문서가 서로 다른 수를 말하면 둘 중 하나는 낡은 것이다.
const ASSERTIONS = /(\d{3})\s*(?:단언|assertions)/g;
const perDoc = {};
for (const doc of ["README.md", "README.en.md"]) {
  if (!existsSync(resolve(ROOT, doc))) continue;
  perDoc[doc] = [...read(doc).matchAll(ASSERTIONS)].map((m) => m[1]);
}
const kr = perDoc["README.md"] ?? [];
const en = perDoc["README.en.md"] ?? [];
if (kr.length && en.length) {
  const krSet = [...new Set(kr)].sort().join(",");
  const enSet = [...new Set(en)].sort().join(",");
  if (krSet !== enSet) {
    fails.push(`대역 일치: 테스트 단언 수가 한국어 [${krSet}] vs 영어 [${enSet}] 로 다르다`);
  }
}
for (const doc of ["README.en.md"]) {
  if (!existsSync(resolve(ROOT, doc))) continue;
  const text = read(doc);
  for (const line of text.split("\n")) {
    if (!line.trimStart().startsWith("|") || line.includes("<!--metric-ok-->")) continue;
    for (const m of line.matchAll(/hit@5[^\n]*?(0\.\d{3})/g)) {
      if (m[1] !== canonical.vector_hit5) {
        fails.push(`대역 일치: ${doc} 의 hit@5 = ${m[1]} 인데 측정값은 ${canonical.vector_hit5}`);
      }
    }
  }
}

// ── D. 필수 claim 존재 ──────────────────────────────────────────────────
//
// 정규식 회피가 가능한 이유는 **어긋난 값을 찾는 검사**만 있었기 때문이다.
// 용어를 바꾸면("두 번째 검증 세트") 어느 정규식에도 안 걸리고 통과했다(QA 재현).
// 그래서 반대 방향도 건다 — 필수 지표는 **문서에 반드시 한 번 이상 정확히** 있어야 한다.
// 없으면 실패다. 표기를 바꾸려면 이 목록도 같이 고쳐야 하므로 조용한 회피가 막힌다.
const REQUIRED_CLAIMS = [
  { doc: "README.md", metric: "vector_hit5", label: "벡터 hit@5" },
  { doc: "README.md", metric: "holdout1_strict", label: "홀드아웃1 strict" },
  { doc: "README.md", metric: "holdout2_strict", label: "홀드아웃2 strict" },
  { doc: "README.en.md", metric: "vector_hit5", label: "vector hit@5" },
  { doc: "README.en.md", metric: "holdout1_strict", label: "holdout1 strict" },
  { doc: "README.en.md", metric: "holdout2_strict", label: "holdout2 strict" },
];

for (const { doc, metric, label } of REQUIRED_CLAIMS) {
  if (!existsSync(resolve(ROOT, doc))) continue;
  const want = canonical[metric];
  if (want === undefined) continue;
  // **표 행 안에서** 찾는다. 산문은 이력("0.433에서 0.633으로")을 정당하게 담으므로
  // 산문에 값이 있다는 이유로 통과시키면, 표 행 라벨을 바꿔 거짓 값을 숨기는 우회가
  // 그대로 남는다(QA 재현). 정합성 검사와 같은 표면을 본다.
  const inTable = read(doc)
    .split("\n")
    .some((l) => l.trimStart().startsWith("|") && !l.includes("<!--metric-ok-->") && l.includes(want));
  if (!inTable) {
    fails.push(`필수 claim: ${doc} 표에 ${label} 값 ${want} 가 없다 — 라벨을 바꿨다면 REQUIRED_CLAIMS도 같이 고쳐라`);
  }
}

// ── 결과 ────────────────────────────────────────────────────────────────
console.log("정본 지표 (eval/results 에서 읽음):");
for (const [k, v] of Object.entries(canonical)) console.log(`  ${k} = ${v}`);

if (fails.length) {
  console.error(`\n실패 ${fails.length}건:`);
  for (const f of fails) console.error(`  - ${f}`);
  console.error("\n문서의 수치는 손으로 적는 값이 아니라 측정 결과다. 결과를 다시 돌리거나 문서를 고쳐라.");
  process.exit(1);
}
console.log("\nOK: 문서 수치가 측정 결과와 일치하고, 결과가 입력보다 새롭다.");
