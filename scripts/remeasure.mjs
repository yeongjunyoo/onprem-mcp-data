// 결정론 지표를 다시 재고 정본과 달라진 것만 말한다.
//
// 로드맵 6번(재측정 비용 낮추기)의 **값싼 절반**이다. 캐시·재추론 분리는 아직이고,
// 여기서는 오늘 손으로 돌린 순서를 한 명령으로 묶는다.
//
// ★ 왜 필요한가.
//   2026-08-18 에 내부 벤치가 06-30 측정 그대로 83 이었고 다시 재니 81 이었다.
//   **비싸면 미루고, 미루면 낡는다.** 그날 정본 재확인을 하느라 명령 일곱 개를
//   순서대로 치고 결과를 눈으로 대조했다 — 그 절차가 사람 머리에만 있으면 다음에
//   또 안 한다.
//
// ★ 무엇을 넣고 무엇을 뺐나.
//   생성이 끼지 않는 것만 넣는다. `ask`(19문항 × 약 14초)와 `bench:internal`(100문항)
//   은 재실행마다 흔들리므로 **값이 같기를 요구하면 그 요구 자체가 거짓 주장**이 된다.
//   그 둘은 여기서 빼고 이름을 말한다 — 뺀 것을 숨기지 않는다.
//
// ★ 프로파일을 박는다.
//   셸에 남은 DATASET 이 결과를 바꾸는 것을 오늘 네 번 겪었다. 각 평가는 자기
//   프로파일로 고정된 npm 스크립트를 쓴다.
//
// 실행: node scripts/remeasure.mjs
// 필요: docker compose up -d, npm run companyx:load
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = resolve(ROOT, "air-server");
const PKG = JSON.parse(readFileSync(resolve(SERVER, "package.json"), "utf8"));

/** npm 을 거치지 않고 스크립트 본문의 node 호출을 직접 실행한다.
 *
 * spawnSync npm     → ENOENT (Windows 의 npm 은 npm.cmd)
 * spawnSync npm.cmd → EINVAL (Node 는 .cmd 를 shell 없이 못 띄운다)
 *
 * 셸을 끼우면 되지만, 오늘 replica-spike 에서 **셸이 잡는 docker 가 다른 데몬을 보는**
 * 사고를 겪었다. 중간 셸을 없애면 그런 환경 차이가 원천적으로 안 생긴다.
 */
function runScript(name) {
  const body = PKG.scripts?.[name];
  if (!body) throw new Error(`package.json 에 ${name} 이 없다`);
  for (const step of body.split("&&").map((x) => x.trim())) {
    const parts = step.split(/\s+/);
    if (parts[0] !== "node") throw new Error(`${name}: node 로 시작하지 않는 단계 — ${step}`);
    execFileSync(process.execPath, parts.slice(1), {
      cwd: SERVER,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 20 * 60 * 1000,
    });
  }
}

/** 다시 잴 것. 전부 생성이 안 끼는(또는 결정론인) 평가다. */
const EVALS = [
  ["companyx:route", "라우팅 in-sample"],
  ["companyx:kg", "KG 재현율"],
  ["companyx:vector", "벡터 hit@5"],
  ["companyx:holdout", "홀드아웃1(템플릿 문형)"],
  ["companyx:holdout2", "홀드아웃2(구어체)"],
  ["companyx:multistep", "다단계"],
  ["fault:inject", "장애 주입"],
  // 규칙 지문. §8.5 가 이 값을 "보장" 으로 적으므로 여기서 재야 한다 —
  // **보장이라 적었으면 재야 하고, 안 재면 그 줄이 곧 거짓이다**(2026-08-18 리뷰).
  // 같은 파일의 pipeline_stable 은 관측이라 아래에서 비교 대상에서 뺀다.
  ["companyx:audit", "규칙 지문 안정성"],
];

/** 여기서 빼는 것 — 뺀 것을 숨기지 않는다. */
const SKIPPED = [
  ["companyx:ask", "19문항 × 약 14초. LLM 생성이 껴서 지연이 매번 다르다"],
  ["bench:internal", "100문항 LLM. 2026-08-18 에 83 → 81 로 실제로 움직였다"],
  ["external:bird", "32문항 재추론 + sqlite3 필요"],
];

function canonical() {
  const out = execFileSync(process.execPath, [resolve(ROOT, "scripts/metrics-check.mjs")], {
    cwd: ROOT,
    encoding: "utf8",
  });
  const map = {};
  for (const m of out.matchAll(/^\s+([a-z_0-9]+) = (.+)$/gm)) map[m[1]] = m[2].trim();
  return map;
}

const before = canonical();
console.log(`정본 ${Object.keys(before).length}지표를 기록했다. 결정론 평가 ${EVALS.length}종을 다시 잰다.\n`);

const t0 = Date.now();
const failed = [];
for (const [script, label] of EVALS) {
  const s = Date.now();
  try {
    runScript(script);
    console.log(`  ${label.padEnd(22)} ${((Date.now() - s) / 1000).toFixed(1)}s`);
  } catch (e) {
    failed.push([script, (e.stderr || e.stdout || String(e)).split("\n").slice(-3).join(" ").slice(0, 140)]);
    console.error(`  ${label.padEnd(22)} 실패`);
  }
}

// audit 결과의 **관측 축**(pipeline_stable)은 실행마다 달라지는 것이 정상이다.
// 정본 대조에 넣으면 매번 빨개지고, 빨개지는 검사는 꺼진다. 규칙 축만 본다.
{
  const p = resolve(ROOT, "eval/results/companyx-audit.json");
  if (existsSync(p)) {
    const a = JSON.parse(readFileSync(p, "utf8"));
    const rs = a?.summary?.routing_stable;
    const n = a?.summary?.determinism_checked;
    console.log(`  규칙 지문: ${rs}/${n} (보장) · 파이프라인: ${a?.summary?.pipeline_stable}/${n} (관측, 비교 안 함)`);
    if (rs !== n) {
      console.error(`\n실패: 규칙 지문이 ${rs}/${n} 이다 — 같은 질의에서 라우팅·정책은 항상 같아야 한다.\n`);
      process.exitCode = 1;
    }
  }
}

const after = canonical();
const moved = Object.keys(after).filter((k) => before[k] !== undefined && before[k] !== after[k]);

console.log(`\n총 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(`건너뛴 평가 ${SKIPPED.length}종 (생성이 껴서 값이 같기를 요구할 수 없다):`);
for (const [s, why] of SKIPPED) console.log(`  ${s.padEnd(18)} ${why}`);

// ── 작업본 상태를 말한다. 이 도구는 결과 파일을 다시 쓰므로 **돌리면 8개가 수정
// 상태**가 된다. 7개는 타임스탬프뿐이고 companyx-audit 은 관측 축이 실제로 바뀐다.
// 아무 말 없이 두면 다음 사람이 `git status` 를 보고 깨졌다고 오해한다.
//
// **자동으로 되돌리지 않는다** — 값이 진짜 바뀐 경우(정본 갱신)를 도구가 지우면
// 오늘 BIRD·kg 에서 겪은 "실패한 실행이 정본을 덮는다" 의 반대 사고가 난다.
{
  const changed = execFileSync("git", ["diff", "--name-only", "--", "eval/results"], {
    cwd: ROOT, encoding: "utf8",
  }).trim().split("\n").filter(Boolean);
  if (changed.length) {
    const onlyTs = [];
    const real = [];
    for (const f of changed) {
      const d = execFileSync("git", ["diff", "-U0", "--", f], { cwd: ROOT, encoding: "utf8" });
      const lines = d.split("\n").filter((l) => /^[+-][^+-]/.test(l));
      (lines.every((l) => /generated_at|generatedAt|"at"/.test(l)) ? onlyTs : real).push(f);
    }
    console.log(`\n작업본 변경 ${changed.length}개:`);
    if (onlyTs.length) console.log(`  타임스탬프만 ${onlyTs.length}개 — 재실행 흔적이다`);
    for (const f of real) console.log(`  ★ 값이 바뀜: ${f}`);
    console.log("  값 변화가 없다면 되돌린다: git checkout eval/results");
    console.log("  (관측 축은 실행마다 달라지는 것이 정상이다 — docs/report.md §8.5)");
  }
}

if (failed.length) {
  console.error("\n실패한 평가:");
  for (const [s, msg] of failed) console.error(`  ${s}: ${msg}`);
  console.error("\n값을 비교할 수 없다 — 실패를 '변화 없음' 으로 읽지 않는다.\n");
  process.exitCode = 1;
} else if (moved.length) {
  console.error(`\n정본이 움직였다 (${moved.length}종):`);
  for (const k of moved) console.error(`  ${k}: ${before[k]} → ${after[k]}`);
  console.error("\n문서를 이 값에 맞추고 같은 커밋에서 함께 올린다.");
  console.error("올리는 쪽이든 내리는 쪽이든 **두 번 돌려 같은 값**인지 먼저 확인한다.\n");
  process.exitCode = 1;
} else {
  console.log(`\nOK: 결정론 지표 ${EVALS.length}종이 정본과 같다 (값 변화 0).`);
  console.log("    (비싸면 미루고, 미루면 낡는다 — 그래서 싸게 만들었다.)");
}
