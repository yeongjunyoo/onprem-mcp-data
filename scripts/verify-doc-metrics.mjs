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
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// 문서 목록을 **손으로 적지 않는다.** 10개를 손으로 적고 있었는데, 전 md 로 넓혀
// 재 보니 어긋난 자리가 하나 나왔다 — air-server/README.md 의 측정 표가 옛 상태로
// 얼어 있었다(테스트 223단언, 정본 462).
//
// **같은 저장소의 두 README 가 같은 항목에 다른 수를 적으면 어느 쪽도 못 믿는다.**
// 하나가 틀린 게 아니라 둘 다 신뢰를 잃는다.
//
// 넓히기 전에 오탐을 재는 습관이 이번엔 진짜를 찾아냈다 — "넓히면 오탐" 이
// 기본값이 아니다. **재 보기 전에는 모른다.**
const DOCS = (function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === "node_modules" || e.name.startsWith(".")) return [];
    const full = resolve(dir, e.name);
    // CHANGELOG 는 제외한다. **릴리스 노트에서 생성되는 역사 기록**이라 그 시점의
    // 수치가 그대로 남는 것이 맞다(v0.1.0 의 388단언). 여기에 metric-ok 를 달 수도
    // 없다 — GitHub 릴리스 본문에는 그 표식이 없어서 sync-changelog 가 갈렸다고
    // 판정한다. **바꿀 수 없는 문서는 검사 대상이 아니라 제외 대상이다.**
    if (e.name === "CHANGELOG.md") return [];
    return e.isDirectory() ? walk(full) : e.name.endsWith(".md") ? [relative(ROOT, full)] : [];
  });
})(ROOT);

// 정본은 metrics-check 가 이미 계산한다. 두 곳에서 따로 읽으면 갈린다.
const out = execFileSync(process.execPath, [resolve(ROOT, "scripts/metrics-check.mjs")], {
  cwd: ROOT,
  encoding: "utf8",
});
const canonical = {};
for (const m of out.matchAll(/^\s+([a-z_0-9]+) = (.+)$/gm)) canonical[m[1]] = m[2].trim();

/** 지표를 말하는 자리인지 알아보는 패턴과, 그 자리에 있어야 할 정본. */
const SUBJECTS = [
  // `hit@5` 를 생략한 짧은 표기("벡터 0.985")도 본다. 2026-08-18 실측에서 그 표기가
  // 규칙 밖이라 낡은 채로 남아 있었다 — **같은 사실을 짧게 쓰면 검사가 못 본다.**
  // 오늘 도구 수(숫자 선행)·단언 수(중간에 단어)에서도 같은 형태를 겪었다.
  { re: /벡터.{0,12}hit@5|vector hit@5|벡터\s*0\.\d{3}/i, key: "vector_hit5", val: /\b0\.\d{3}\b/g },
  // 지연 산문. 2026-08-18 에 **두 번째로** 낡은 것이 나왔다 — 본문 3쪽을 고쳤을 때
  // check_report_metrics.py 에 넣었지만 그 검사는 제출 원고만 본다. 저장소 문서
  // (특히 영준이 보고 녹화하는 시연 대본)는 여전히 밖이었다.
  //
  // **같은 사실이 여러 문서에 흩어져 있으면 검사도 흩어져야 한다.**
  { re: /컨테이너는 중앙값|종단 중앙 지연|ask median/i, key: "ask_median_ms", val: /\b\d{4,5}(?=\s*ms)/g },
  { re: /호스트 Ollama는 중앙값|호스트 GPU/i, key: "ask_median_ms_host", val: /\b\d{3,4}(?=\s*ms)/g },
  { re: /홀드아웃1|holdout 1|템플릿 문형/i, key: "holdout1_strict", val: /\b0\.\d{3}\b/g },
  { re: /홀드아웃2|holdout 2|구어체|colloquial/i, key: "holdout2_strict", val: /\b0\.\d{3}\b/g },
  { re: /라우팅 도구 일치|routing tool match/i, key: "route_insample", val: /\b\d{1,2}\/30\b/g },
  { re: /단언 통과|assertions pass/i, key: "test_total", val: /(?<!\d)\d{3}(?!\d)/g },
  // 분모를 /19 로 못 박으면 **분모까지 바꾼 위조가 건너뛰어진다** — 값이 하나도
  // 안 잡히면 검사는 그 줄을 넘긴다. 어떤 비율이든 잡아서 정본과 대조한다.
  { re: /근거 포함|evidence in context/i, key: "ask_evidence", val: /\b\d{1,2}\/\d{1,2}\b/g },
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
    // 한 줄이 여러 주제에 걸리면 **주제 바로 뒤의 수**만 그 주제 것으로 본다.
    // 2026-08-18 에 반대쪽으로 두 번 틀린 뒤에 얻은 규칙이다.
    //
    //   "걸린 주제마다 자기 정본이 줄 어딘가에" → 1차·2차를 같이 말하며 2차 값만
    //   인용한 옳은 문장을 물었다(roadmap:22).
    //
    //   "줄의 모든 값이 누군가의 정본" → 같은 줄의 **커버율 0.933** 을 물었다
    //   (README:185). 추적 대상이 아닌 지표가 같은 줄에 있는 건 정상이다.
    //
    // 둘 다 "어느 수가 어느 주제 것인가" 를 안 보고 뭉뚱그린 탓이다. 사람은 위치로
    // 안다 — "홀드아웃1(템플릿 문형)에서 27/30(0.900)".
    const hit = SUBJECTS.filter((s) => s.re.test(line) && canonical[s.key]);
    if (hit.length > 1) {
      for (const s of hit) {
        const at = line.search(s.re);
        // 창은 **양방향**이다. 한국어는 값이 주제 앞에 오기도 한다 —
        // "0.900은 템플릿 문형, 0.633이 구어체다"(report.md:362). 뒤만 보면
        // 0.900 을 놓치고 0.633 을 홀드아웃1 것으로 오독한다.
        const near = line.slice(Math.max(0, at - 30), at + 30);
        const vals = [...near.matchAll(s.val)].map((m) => m[0]);
        if (vals.length === 0) continue; // 멀리 있는 값은 남의 것이다
        scanned++;
        if (!vals.includes(canonical[s.key])) {
          fails.push(
            `${doc}:${i + 1} — ${s.key} 바로 뒤의 값이 정본 ${canonical[s.key]} 이 아니다 ` +
              `(문서: ${vals.join(", ")})\n    ${line.trim().slice(0, 100)}`,
          );
        }
      }
      continue;
    }

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
