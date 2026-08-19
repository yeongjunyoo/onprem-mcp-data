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
// ★ 선언된 설계 선택 (한계를 한계로 적는다).
//   - **라벨은 검사하지 않는다.** marker가 지표 정체성을 들고 라벨은 자유롭게 쓴다.
//     따라서 라벨을 엉뚱하게 바꿔도 통과한다 — 의도된 자유이지 우회가 아니다.
//     대신 어느 행이 어느 지표를 주장하는지는 marker가 못 박는다.
//   - **표기 형식은 정본과 정확히 같아야 한다.** `0.9000`·`.900`·`89.50` 은 실패한다.
//     수치적으로 같아도 문서에는 정본 문자열을 그대로 적는다는 규약이다.
//
// ★ 선언된 범위 한계 (덮지 못하는 것을 덮은 척하지 않는다).
//   이 검사는 **마크다운 파이프 표 행만** 본다. 산문·목록·HTML 표·코드블록에 적힌
//   수치는 검사하지 않는다. 산문에는 이력("0.433에서 0.633으로")과 다른 통계(Wilson
//   하한)가 정당하게 섞이고, 그것까지 잡으면 오탐이 생기며 오탐이 생기면 사람이
//   검사를 꺼버리기 때문이다. 정본 수치는 표에 적고 산문은 설명에 쓴다는 규약이
//   이 검사의 전제다. 규약을 어기면 검사는 막지 못한다 — 알려진 한계다.
//
// 사용: node scripts/metrics-check.mjs
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(resolve(ROOT, p), "utf8");

/** 코드펜스를 걷어낸 본문. 펜스 안의 예시는 문서의 주장이 아니다. */
function prose(doc) {
  let fenced = false;
  return read(doc)
    .split("\n")
    .filter((l) => {
      if (/^\s*```/.test(l)) {
        fenced = !fenced;
        return false;
      }
      return !fenced;
    });
}

/** 값이 **토큰 경계**로 일치하는지 본다.
 *
 * substring 비교는 두 세대 연속 뚫렸다 — `0.900`이 `0.9001`을, `17/19`가 `17/190`을
 * 만족했다(QA 재현). 숫자 뒤에 숫자가 더 붙으면 다른 값이다. */
function hasExactValue(text, want) {
  const esc = want.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\d.])${esc}(?![\\d.])`).test(text);
}
const readJson = (p) => {
  // 없으면 크래시가 아니라 진단으로 끝낸다. 크래시는 무엇이 없는지 안 알려준다.
  if (!existsSync(resolve(ROOT, p))) {
    console.error(`\n정본이 없다: ${p} — 해당 평가를 돌려야 한다`);
    process.exit(1);
  }
  return JSON.parse(read(p));
};
const fails = [];

// ── A. 신선도 — 입력의 내용 해시로 본다 ─────────────────────────────────
//
// 종전에는 파일 mtime 을 비교했다. **git 은 mtime 을 보존하지 않는다.** 새로 clone
// 하면 checkout 순서가 곧 mtime 순서라, 그 검사는 평가 순서가 아니라 파일이 어떤
// 순서로 쓰였는지를 봤을 뿐이다. `touch` 로도 뒤집혔다.
//
// 대신 결과가 **자기 입력의 내용 해시를 들고 다니게** 한다. 입력이 바뀌면 해시가
// 달라지고, 그러면 그 결과는 그 입력에 대한 측정이 아니다. clone 해도, 복사해도,
// touch 해도 같은 판정이 나온다.
//
// 아직 해시를 안 들고 있는 결과는 "기록 없음"으로 실패시키지 않는다 — 그러면 모든
// 평가를 지금 당장 다시 돌려야 한다. 대신 경고로 남겨 다음 실행 때 채우게 한다.
// 덮지 못하는 것을 덮은 척하지 않되, 검사 도입이 작업을 멈추게 하지도 않는다.
// 줄바꿈을 정규화하고 해시한다. git 이 Windows 체크아웃에서 LF 를 CRLF 로 바꾸므로,
// 원시 바이트를 해시하면 같은 내용이 OS 마다 다른 해시가 된다(CI 에서 실제로 깨졌다).
// 우리가 재려는 것은 인코딩이 아니라 내용이다.
const sha = (p) =>
  createHash("sha256").update(readFileSync(resolve(ROOT, p), "utf8").replace(/\r\n/g, "\n")).digest("hex").slice(0, 16);

const FRESHNESS = [
  { result: "eval/results/companyx-ask.json", inputs: ["eval/companyx/vector_gold.json", "eval/companyx/kg_gold.json", "eval/companyx/sql_gold.jsonl"] },
  { result: "eval/results/companyx-vector.json", inputs: ["eval/companyx/vector_gold.json"] },
  { result: "eval/results/companyx-holdout-route.json", inputs: ["eval/companyx/holdout_route.json"] },
  { result: "eval/results/companyx-holdout2-route.json", inputs: ["eval/companyx/holdout2_route.json"] },
];

const staleNotes = [];
for (const { result, inputs } of FRESHNESS) {
  if (!existsSync(resolve(ROOT, result))) {
    fails.push(`신선도: 결과가 없다 ${result} — 평가를 돌려야 한다`);
    continue;
  }
  // 평가기마다 최상위에 두기도 하고 summary 안에 두기도 한다. 둘 다 본다.
  const rj = readJson(result);
  const recorded = rj.input_hashes ?? rj.summary?.input_hashes;
  for (const i of inputs) {
    if (!existsSync(resolve(ROOT, i))) {
      fails.push(`신선도: 입력이 없다 ${i} — 평가셋이 사라졌다`);
      continue;
    }
    if (!recorded) {
      // 이제 모든 평가기가 해시를 기록한다. 없다는 것은 그 결과가 해시 도입 이전의
      // 낡은 산출물이라는 뜻이므로 통과시키지 않는다 — 경고로 두면 영영 안 채워진다.
      fails.push(`신선도: ${result} 에 input_hashes 가 없다 — 평가를 다시 돌려야 한다`);
      break;
    }
    if (recorded[i] !== sha(i)) {
      fails.push(`신선도: ${i} 가 ${result} 이 기록한 해시와 다르다 — 평가를 다시 돌려야 한다`);
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
// 커버율은 strict 를 **해명하는** 값이다. 발표 대본 35행이 구어체 0.633 을 정면으로
// 받는 답의 핵심 논거로 쓴다 - 엄격 라벨 일치는 0.633 이지만 기대 레인 도달률은
// 0.933 이고 아예 못 닿은 것은 2건. **그 답 전체가 이 값에 걸려 있다.**
// strict 는 넣어 놓고 그것을 해명하는 값은 안 넣었다.
canonical.holdout1_coverage = h1.summary.coverage.toFixed(3);

if (existsSync(resolve(ROOT, "eval/results/companyx-holdout2-route.json"))) {
  const h2 = readJson("eval/results/companyx-holdout2-route.json");
  canonical.holdout2_strict = h2.summary.strict_accuracy.toFixed(3);
  canonical.holdout2_coverage = h2.summary.coverage.toFixed(3);
  canonical.holdout2_true_miss = String(h2.summary.true_miss);
}

// 종단 근거 포함은 공개 헤드라인인데 정본에서 읽지 않아 drift가 재발할 수 있었다(H3).
const ask = readJson("eval/results/companyx-ask.json");
canonical.ask_evidence = ask.summary.evidence_in_context_full;
canonical.ask_evidence_pct = String(ask.summary.evidence_pct);
canonical.ask_grounded_pct = String(ask.summary.grounded_pct);

// 테스트 단언 수는 문서끼리 합의하는지가 아니라 **러너가 낸 값**을 본다.
// 종전 대역 일치 검사는 두 문서가 나란히 틀려도 통과했다(둘 다 388인데 실측 394).
const counts = readJson("eval/results/test-counts.json");
canonical.test_total = String(counts.total);
// 지연은 환경 종속이라 정본 자체가 어느 엔드포인트에서 쟀는지 들고 있어야 한다.
// 같은 코드가 GPU 호스트에서 약 0.8초, CPU 컨테이너에서 약 10초다.
canonical.ask_median_ms = String(ask.summary.median_ms);

// 호스트 GPU 비교치도 자기 artifact 에 결속한다. 문서에 적으면서 원자료가 없으면
// 그것은 측정이 아니라 기억이다(QA 지적: 864 를 999 로 바꿔도 통과했다).
const askHost = readJson("eval/results/companyx-ask-host-gpu.json");
canonical.ask_median_ms_host = String(askHost.summary.median_ms);

// 장애주입은 "운영 안정성" 기둥이고 시연영상 2:15-2:42 가 화면에 띄운다.
// 그런데 문서의 4/4/4 가 정본과 대조되지 않고 있었다 — 주입 시나리오가 늘거나
// 하나가 깨져도 문서는 그대로 4/4/4 라고 적었을 것이다.
const faults = readJson("eval/results/faults.json");
const fs_ = faults.summary;
if (fs_.noCrashRate !== 1 || fs_.partialRate !== 1 || fs_.errorVisibleRate !== 1 || fs_.pass !== true) {
  fails.push(
    `장애주입: 정본이 통과 상태가 아니다 (no-crash ${fs_.noCrashRate}, partial ${fs_.partialRate}, ` +
      `error-visible ${fs_.errorVisibleRate}, pass ${fs_.pass})`,
  );
}
// 한 칸에 같은 값이 여러 번 나오면 하나만 바꿔도 통과한다(실측: 4/4 가 셋이라
// 무중단만 3/4 로 바꿔도 검사가 못 잡았다). 세 지표를 각각 자기 행으로 결속한다.
// in-sample 라우팅 30/30 은 헤드라인인데 결속돼 있지 않았다. 라우터가 바뀌어
// 29/30 이 돼도 문서는 30/30 이라고 적었을 것이다.
const route = readJson("eval/results/companyx-route.json");
const rs = route.summary;
canonical.route_insample = `${rs.exact_lane_match}/${rs.n}`;
// 결정론은 "튜닝 0" 주장의 뼈대다. 플래그가 false 로 뒤집히면 문서만 고쳐서는
// 안 되고 라우터를 봐야 한다 — 여기서 막는다.
if (rs.deterministic_20_runs !== true) {
  fails.push(`결정론: companyx-route.json 의 deterministic_20_runs 가 ${rs.deterministic_20_runs} 다`);
}

// KG 재현율은 이미 결속됐지만 접지 위반(0건)과 다단계 완료율은 아니었다.
// 접지는 "근거 없으면 답하지 않는다" 는 안전 주장의 핵심 수치다.
canonical.ask_grounded_ratio = ask.summary.answers_grounded;

// 다단계 작업 완료율 — "레인이 따로 잘돼도 연결이 안 되면 질문은 못 푼다" 를
// 보이려고 만든 지표다. 헤드라인인데 결속돼 있지 않았다.
const multi = readJson("eval/results/companyx-multi-step.json");
const mus = multi.summary ?? multi;
canonical.multistep = `${mus.completed}/6`;
canonical.multistep_steps = `${mus.steps_passed}/${mus.steps_total}`;

// 의존성 수는 SBOM 이 설치 트리에서 세는 값이다. 문서가 따로 적으면 갈린다.
const sbomHead = read("docs/sbom.md").slice(0, 900);
const pkgMatch = /npm 패키지 (\d+)개/.exec(sbomHead);
if (pkgMatch) canonical.dep_packages = pkgMatch[1];

// NL2SQL 은 7B 비결정론이라 범위로 적지만, 마지막 실행값은 정본에 있다.
const sqlNo = readJson("eval/results/companyx-sql-llm-norepair.json");
const sqlRe = readJson("eval/results/companyx-sql-llm.json");
canonical.nl2sql_norepair = `${(sqlNo.summary ?? sqlNo).correct}/10`;
canonical.nl2sql_repair = `${(sqlRe.summary ?? sqlRe).correct}/10`;

canonical.faults_nocrash = `${Math.round(fs_.noCrashRate * fs_.total)}/${fs_.total}`;
canonical.faults_partial = `${Math.round(fs_.partialRate * fs_.total)}/${fs_.total}`;
canonical.faults_errvis = `${Math.round(fs_.errorVisibleRate * fs_.total)}/${fs_.total}`;

const kg = readJson("eval/results/companyx-kg.json");
canonical.kg_recall = Number(kg.summary.mean_recall).toFixed(3);

// 내부 벤치(execution-match, 100문항). 2026-08-18 에 83 → 81 로 내리며 **손으로**
// 다섯 자리를 고쳤는데, 이유는 이 값이 정본에 없었기 때문이다.
// **정본에 없는 값은 문서에서 자유롭게 썩는다** — 서두 「핵심 한 줄」의 `품질(83%)` 이
// 그렇게 살아남았다.
// 외부 BIRD. 2026-08-18 완결 감사에서 **정본에 없다**는 걸 알았다.
// 문서·근거·대본이 마침 다 일치했지만 그건 검사가 아니라 운이다 —
// bench_internal 이 정확히 그렇게 다섯 자리에서 썩었다.
//
// 세 수치를 다 넣는다. 의미가 서로 다르고(공식 set / 운영 multiset / 백분율),
// **그 차이 자체가 우리 논지**라 하나만 넣으면 나머지 둘이 썩는다.
const birdRescore = readJson("eval/results/external-bird-rescore.json");
const birdSummary = readJson("eval/results/external-bird-summary.json");
canonical.bird_official = birdRescore.official_set.accuracy.toFixed(3);
canonical.bird_multiset = birdRescore.operational_multiset.accuracy.toFixed(3);
canonical.bird_exec_pct = String(birdSummary.executionAccuracy);
// 백분율 표기. 발표 대본은 말로 하는 문서라 `0.344` 라고 읽지 않는다 -
// 「34.4%」라고 말한다. 표기를 문서에 맞추라고 요구할 수 없다.
// 손으로 적지 않고 분수에서 계산한다 - 하드코딩된 값은 다시 갈린다.
// (multiset 쪽 백분율은 위 bird_exec_pct 가 이미 그것이다.)
canonical.bird_official_pct = (
  (birdRescore.official_set.correct / birdRescore.official_set.of) *
  100
).toFixed(1);
// bird_sampled(32) 는 **일부러 넣지 않는다.** 위 대역 검사가 부분문자열로 보는데
// 324(데이터셋 없는 CI 단언 수) 안의 32 에 걸려 거짓 유죄가 났다.
// **정본에 넣는 값은 자기를 식별할 수 있어야 한다** — 두 자리 수는 못 한다.

const benchInternal = readJson("eval/results/internal-llm-summary.json");
{
  const b = benchInternal.summary ?? benchInternal;
  canonical.bench_internal = `${b.correct}/${b.total}`;
  canonical.bench_internal_pct = String(b.correct);
}

// ── B. 정합성 ───────────────────────────────────────────────────────────
// 문서에서 지표가 쓰인 자리를 찾아, 거기 적힌 값이 정본과 같은지 본다.
// "언급되어야 한다"가 아니라 "어긋나면 안 된다"를 검사한다.
// 심사자와 기여자가 읽는 문서를 전부 본다. 목록이 좁으면 문서를 하나 늘릴
// 때마다 사각이 하나 생긴다 — CONTRIBUTING 의 낡은 단언 수 120·223 이
// 살아남은 이유가 정확히 그것이었다(2026-08-17).
const DOCS = [
  "README.md",
  "README.en.md",
  "docs/report.md",
  "docs/submission-report.md",
  "CONTRIBUTING.md",
];
const CLAIMS = [
  {
    metric: "bench_internal",
    // "내부 SQL execution-match: **81/100 = 81.0%**" / "execution-match (81/100)"
    // 2026-08-18 리뷰 지적: 정본에 등록만 하고 **아무 검사도 소비하지 않았다.**
    // 정본에 넣는 것과 검사가 보는 것은 다르다.
    re: /execution-match[^\n]*?(\d{1,3}\/100)/g,
    label: "내부 벤치 execution-match",
  },
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
        // 경계 일치로 확인한 값은 정상이다(0.9001 같은 더 긴 값만 걸러낸다).
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
// ── 대역: 정본 지표가 양쪽에 다 있는가 ─────────────────────────────────────
//
// 종전 대역 검사는 단언 수 하나만 봤다. 그래서 영문에 **리소스 6종·프롬프트 4종
// 서술이 통째로 없는데도** 아무도 안 잡았다(2026-08-17 실측). 영문 README 는
// 국제 심사자와 OSS 커뮤니티가 보는 문서다.
//
// 오탐을 피하려고 문구가 아니라 **정본 지표 값**으로 본다 — 값이 기준이면 번역
// 차이에 안 흔들린다. 한쪽에만 있는 지표는 번역이 빠진 것이다.
{
  const koText = read("README.md");
  const enText = existsSync(resolve(ROOT, "README.en.md")) ? read("README.en.md") : null;
  if (enText) {
    // 한쪽에만 등장하는 지표. 둘 다 없는 것은 의도적 생략일 수 있어 보지 않는다.
    const lopsided = Object.entries(canonical)
      .filter(([, v]) => koText.includes(v) !== enText.includes(v))
      .map(([k, v]) => `${k}(${v}) — ${koText.includes(v) ? "한국어에만" : "영어에만"}`);
    if (lopsided.length) {
      fails.push(`대역 지표: 한쪽 README 에만 있는 지표 ${lopsided.length}개 — ${lopsided.join(", ")}`);
    }
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

// ── D. 필수 claim: marker로 지표와 값을 결합한다 ────────────────────────
//
// 앞선 두 세대에서 이 검사는 두 번 뚫렸다.
//   1세대: 어긋난 값만 찾아서, 라벨을 바꾸면("두 번째 검증 세트") 아무 정규식에도
//          안 걸리고 통과했다.
//   2세대: 존재 검사를 붙였더니, **어느 행이든** 그 숫자가 있으면 만족돼
//          holdout1/2 값을 서로 바꿔도 통과했다. metric-ok 마커도 여전히
//          거짓 행을 침묵시켰다.
//
// 근본 원인은 하나다 — **문서의 어느 행이 어느 지표를 주장하는지 계약이 없었다.**
// 그래서 행에 기계가 읽는 marker를 박고, marker가 붙은 행의 값만 본다.
// 라벨 문구는 자유롭게 바꿔도 되고, marker를 지우면 "필수 claim 없음"으로 실패한다.
//
//   | 벡터 검색 hit@5 | **0.986** | ... |   <!--metric:vector_hit5-->
//
// metric-ok는 **과거 표본의 참고표**에만 쓰는 면제이지 필수 claim을 침묵시키는
// 수단이 아니다. marker가 붙은 행에서는 metric-ok를 무시한다.
const REQUIRED_CLAIMS = [
  // bench_internal 은 여기 안 넣는다 — docs/report.md 는 marker 규약을 안 쓰는 문서라
  // 필수 목록에 넣으면 "marker 가 0개" 로 항상 실패한다. **CLAIMS 대조로 잡는다**
  // (그 목록은 marker 없는 산문·표도 훑는다). 넣을 수 없는 곳에 넣는 것은 검사가
  // 아니라 소음이다.
  { doc: "README.md", metric: "vector_hit5" },
  { doc: "README.md", metric: "holdout1_strict" },
  { doc: "README.md", metric: "holdout2_strict" },
  { doc: "README.md", metric: "ask_evidence" },
  { doc: "README.md", metric: "ask_evidence_pct" },
  { doc: "README.md", metric: "ask_median_ms" },
  { doc: "README.md", metric: "test_total" },
  // ★ 심사자가 실제로 채점하는 문서다. README 만 묶고 여기를 두면, 정작 점수가
  // 매겨지는 표가 낡아도 아무도 모른다.
  { doc: "docs/submission-report.md", metric: "route_insample" },
  { doc: "docs/submission-report.md", metric: "kg_recall" },
  { doc: "docs/submission-report.md", metric: "vector_hit5" },
  { doc: "docs/submission-report.md", metric: "ask_evidence" },
  { doc: "docs/submission-report.md", metric: "ask_grounded_ratio" },
  { doc: "docs/submission-report.md", metric: "ask_median_ms_host" },

  { doc: "README.md", metric: "dep_packages" },
  { doc: "README.en.md", metric: "dep_packages" },
  { doc: "README.en.md", metric: "ask_median_ms" },
  { doc: "README.md", metric: "route_insample" },
  { doc: "README.md", metric: "ask_grounded_ratio" },
  { doc: "README.md", metric: "multistep" },
  { doc: "README.en.md", metric: "route_insample" },
  { doc: "README.en.md", metric: "kg_recall" },
  { doc: "README.md", metric: "faults_nocrash" },
  { doc: "README.md", metric: "faults_partial" },
  { doc: "README.md", metric: "faults_errvis" },
  { doc: "README.en.md", metric: "faults_nocrash" },
  { doc: "README.en.md", metric: "faults_partial" },
  { doc: "README.en.md", metric: "faults_errvis" },
  { doc: "README.md", metric: "ask_median_ms_host" },
  { doc: "README.en.md", metric: "ask_median_ms_host" },
  { doc: "README.en.md", metric: "test_total" },
  { doc: "README.en.md", metric: "vector_hit5" },
  { doc: "README.en.md", metric: "holdout1_strict" },
  { doc: "README.en.md", metric: "holdout2_strict" },
  { doc: "README.en.md", metric: "ask_evidence" },
  { doc: "README.en.md", metric: "ask_evidence_pct" },
  { doc: "README.en.md", metric: "ask_grounded_pct" },
  { doc: "README.md", metric: "ask_grounded_pct" },
];

for (const { doc, metric } of REQUIRED_CLAIMS) {
  if (!existsSync(resolve(ROOT, doc))) continue;
  const want = canonical[metric];
  if (want === undefined) {
    fails.push(`필수 claim: 정본에 ${metric} 이 없다 — 지표 산출을 확인하라`);
    continue;
  }
  const marker = `<!--metric:${metric}-->`;
  // 표 행만 본다. 코드펜스 안의 예시나 산문 줄에 marker를 달아도 주장이 되지 않는다.
  const rows = prose(doc).filter((l) => l.trimStart().startsWith("|") && l.includes(marker));

  if (rows.length !== 1) {
    fails.push(
      `필수 claim: ${doc} 에 ${marker} 가 붙은 행이 ${rows.length}개다 (정확히 1개여야 한다). ` +
        `라벨은 자유롭게 바꿔도 되지만 marker는 유지해야 한다`,
    );
    continue;
  }
  // ★ 행 전체가 아니라 **결과 셀**에서 찾는다.
  //
  // 행 전체를 보면 `| 라벨 | **0.001** | 참고 0.900 | <!--marker-->` 가 통과한다.
  // 값은 비고 칸에 있고 정작 보이는 결과는 틀렸는데도 만족된다(4세대 리뷰 지적).
  // 이 저장소의 지표 표는 `| 지표 | 값 | 비고 … |` 규약이므로 두 번째 칸이 결과다.
  // 이스케이프된 파이프는 셀 구분자가 아니다. 단 **백슬래시 패리티**를 봐야 한다 —
  // `\\|` 처럼 백슬래시가 짝수 개면 서로를 이스케이프하고 파이프는 구조적이다.
  // 홀수 개일 때만 파이프가 escape 된다. QA가 짝수 케이스로 우회를 재현했다.
  const SENTINEL = "\u0000";
  const masked = rows[0].replace(/(\\*)\|/g, (_m, bs) =>
    bs.length % 2 === 1 ? `${bs.slice(0, -1)}${SENTINEL}` : `${bs}|`,
  );
  const cells = masked.split("|").slice(1, -1).map((c) => c.split(SENTINEL).join("\\|"));
  const resultCell = cells[1] ?? "";
  if (!hasExactValue(resultCell, want)) {
    fails.push(
      `필수 claim: ${doc} 의 ${marker} **결과 칸**에 측정값 ${want} 가 없다 ` +
        `(결과 칸 = "${resultCell.trim().slice(0, 50)}")`,
    );
  }
}

// ── E2. NL2SQL 범위 표기가 정본을 포함하는지 ────────────────────────────
//
// NL2SQL 은 7B 비결정론이라 문서가 "5~7/10" 처럼 **범위**로 적는다. 그래서
// 단일 값 결속이 맞지 않는다. 대신 **정본 최종 실행값이 그 범위 안에 있는지**를
// 본다. 범위 밖이면 문서가 낡았거나 성능이 실제로 변한 것이다.
//
// 범위로 적는 것은 정직하지만, 범위가 정본을 벗어나도 아무도 모르면 그 정직함은
// 검사되지 않는 주장이 된다.
{
  const nrCorrect = Number(canonical.nl2sql_norepair.split("/")[0]);
  const rpCorrect = Number(canonical.nl2sql_repair.split("/")[0]);
  // 산문 검사 대상은 DOCS 하나다. 목록을 따로 두면 어느 문서가 어느 검사의
  // 사각인지 아무도 모르게 된다 — CONTRIBUTING 의 낡은 수치가 그렇게 살았다.
  const RANGE_DOCS = DOCS;

  for (const doc of RANGE_DOCS) {
    if (!existsSync(resolve(ROOT, doc))) continue;
    for (const line of prose(doc)) {
      if (!/NL2SQL/i.test(line) || line.includes("<!--metric-ok-->")) continue;
      for (const m of line.matchAll(/\*?\*?(\d)\s*[~-]\s*(\d)\/10/g)) {
        const lo = Number(m[1]);
        const hi = Number(m[2]);
        const isRepair = /재시도|repair/i.test(line);
        const actual = isRepair ? rpCorrect : nrCorrect;
        if (actual < lo || actual > hi) {
          fails.push(
            `NL2SQL 범위: ${doc} 가 ${lo}~${hi}/10 이라 적었는데 정본 최종 실행값은 ${actual}/10 이다` +
              `${isRepair ? " (재시도 1회)" : " (재시도 없음)"}`,
          );
        }
      }
    }
  }
}

// ── E3. 폐기된 테스트 단언 수가 남아 있지 않은지 ────────────────────────
//
// 지연과 같은 부류다. 테스트 수는 스위트가 늘 때마다 바뀌는데 표가 아닌 산문과
// 채점 대응표에도 박힌다 — 실제로 docs/report.md 에 313단언 이 남아 있었다
// (현행 오프라인 267). 표 검사는 파이프 행만 보므로 못 잡았다.
{
  const liveCounts = new Set([
    canonical.test_total,
    String(readJson("eval/results/test-counts.json").offline_with_dataset),
    String(readJson("eval/results/test-counts.json").offline_ci),
    String(readJson("eval/results/test-counts.json").integration),
  ]);
  // 위 DOCS 와 따로 두지 않는다. 목록이 둘이면 하나만 고치고 고쳤다고 믿게 된다
  // — CONTRIBUTING 의 낡은 223단언이 그렇게 살아남았다.
  const COUNT_DOCS = DOCS;
  for (const doc of COUNT_DOCS) {
    if (!existsSync(resolve(ROOT, doc))) continue;
    for (const line of prose(doc)) {
      if (line.includes("<!--metric-ok-->")) continue;
      // ★ 개별 스위트의 단언 수(예: "normalize.ts, 28단언")는 정당한 서술이다.
      // 전체를 말하는 문맥에서만 본다 — "전체 N단언", "오프라인 N단언",
      // "테스트 N단언" 처럼 총계를 주장하는 자리.
      //
      // 오탐이 있는 검사는 사람이 꺼버린다. 좁게 물되 무는 곳에서는 확실히 문다.
      for (const m2 of line.matchAll(/(?:전체|총|오프라인|통합|테스트|스위트 기준)\s*(\d{2,4})\s*단언/g)) {
        if (!liveCounts.has(m2[1])) {
          fails.push(
            `폐기된 테스트 수: ${doc} 에 ${m2[1]}단언 이 총계로 적혀 있다 (현행 ${[...liveCounts].join(" / ")})`,
          );
        }
      }
      for (const m2 of line.matchAll(/(\d{2,4})\s*assertions/g)) {
        if (!liveCounts.has(m2[1])) {
          fails.push(
            `폐기된 테스트 수: ${doc} 에 ${m2[1]} assertions 가 남아 있다 (현행 ${[...liveCounts].join(" / ")})`,
          );
        }
      }
    }
  }
}

// ── E. 폐기된 지연값이 어디에도 남아 있지 않은지 ──────────────────────────
//
// 지연은 재측정할 때마다 바뀌는데 문서 곳곳(표가 아닌 산문 포함)에 박힌다.
// 표 검사는 파이프 행만 보므로 산문에 남은 옛 값을 못 잡는다 — 실제로
// docs/report.md 에 18472ms 가 남아 있었다.
//
// 정본이 아닌 지연값이 문서에 있으면 실패시킨다. 과거 서술이 필요하면
// "이전 측정" 처럼 맥락을 붙이지 말고 아예 값을 빼거나 표에 metric-ok 로 남긴다.
const LATENCY_DOCS = DOCS;
const liveLatency = new Set([canonical.ask_median_ms, canonical.ask_median_ms_host]);

for (const doc of LATENCY_DOCS) {
  if (!existsSync(resolve(ROOT, doc))) continue;
  for (const line of prose(doc)) {
    if (line.includes("<!--metric-ok-->")) continue;
    for (const m2 of line.matchAll(/(\d{3,6})\s*ms/g)) {
      if (!liveLatency.has(m2[1])) {
        fails.push(
          `폐기된 지연값: ${doc} 에 ${m2[1]}ms 가 남아 있다 (현행 ${[...liveLatency].join(" / ")}ms)`,
        );
      }
    }
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
// 자기가 본 규모를 말한다.
//
// 다른 게이트는 전부 "27곳", "158개" 처럼 규모를 말하는데 이것만 안 했다. 규모를
// 안 말하면 **입력이 비어도 통과했는지 알 수 없다.** 2026-08-17 에 위조 테스트와
// 적재 스냅샷이 각각 "아무것도 안 보고 초록" 으로 통과한 적이 있다.
if (REQUIRED_CLAIMS.length === 0) {
  console.error("\n실패: 필수 claim 목록이 비어 있다 — 검사가 아무것도 대조하지 않는다.\n");
  process.exit(1);
}
if (Object.keys(canonical).length === 0) {
  console.error("\n실패: 정본 지표가 하나도 없다 — eval/results 를 확인하라.\n");
  process.exit(1);
}
console.log(
  `\n대조 규모: 정본 ${Object.keys(canonical).length}지표 · 필수 claim ${REQUIRED_CLAIMS.length}행 · 문서 ${DOCS.length}개.`,
);

console.log("\nOK: 문서 수치가 측정 결과와 일치하고, 결과가 입력보다 새롭다.");
