// BIRD 산출물 세 개가 서로 맞는지 본다.
//
// 2026-08-19: 후보 비교(EXT_LIMIT=32) 실행이 정본 raw 를 500행 -> 32행으로 덮었다.
// summary 는 500, rescore 는 500, raw 만 32 였고 **검사 23종이 전부 통과했다** -
// 세 검사 스크립트 어디에도 external-bird-raw 를 읽는 곳이 없었기 때문이다.
// rescore_bird.py 는 raw 를 입력으로 쓰므로 그 상태로 재실행하면 전수 결과가 덮인다.
//
// **아무도 안 보는 증거는 증거가 아니다.**
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => JSON.parse(readFileSync(resolve(ROOT, p), "utf8"));

const RAW = "eval/results/external-bird-raw.json";
const SUM = "eval/results/external-bird-summary.json";
const RES = "eval/results/external-bird-rescore.json";

const fails = [];
for (const p of [RAW, SUM, RES]) {
  if (!existsSync(resolve(ROOT, p))) fails.push(`없다: ${p}`);
}
if (fails.length) {
  console.error("\n실패:\n  - " + fails.join("\n  - ") + "\n");
  process.exit(1);
}

const raw = read(RAW);
const sum = read(SUM);
const res = read(RES);

if (!Array.isArray(raw) || raw.length === 0) fails.push(`${RAW} 가 배열이 아니거나 비었다`);
if (raw.length !== sum.sampled) {
  fails.push(
    `행수 불일치: raw ${raw.length}행 vs summary.sampled ${sum.sampled} — ` +
      `부분 실행이 정본 raw 를 덮었을 수 있다`,
  );
}
if (raw.length !== res.sample?.n) {
  fails.push(`행수 불일치: raw ${raw.length}행 vs rescore.sample.n ${res.sample?.n}`);
}
const okCount = raw.filter((r) => r.ok).length;
if (okCount !== sum.correct) {
  fails.push(`정답 수 불일치: raw ${okCount} vs summary.correct ${sum.correct}`);
}
// rescore 가 **이 raw 를 봤는지** 해시로 확인한다. 행수만 맞으면 낡은 rescore 가
// 조용히 통과한다 - 같은 수를 말한다고 같은 실행인 것은 아니다.
if (res.raw_sha256) {
  const actual = createHash("sha256").update(readFileSync(resolve(ROOT, RAW))).digest("hex");
  if (actual !== res.raw_sha256) {
    fails.push(
      `rescore 가 다른 raw 를 봤다: 기록 ${String(res.raw_sha256).slice(0, 12)} ` +
        `vs 현재 ${actual.slice(0, 12)} — rescore_bird.py 를 다시 돌린다`,
    );
  }
} else {
  fails.push(`${RES} 에 raw_sha256 이 없다 — rescore_bird.py 를 다시 돌린다`);
}

// **데이터셋과 대조한다.** raw 의 id 다중집합이 Mini-Dev 항목의 id 다중집합과 같아야 한다.
// 「고유 id 여야 한다」로 만들면 안 된다 - BIRD Mini-Dev 는 500항목 중 q137·q138 을
// **중복 수록**한다(문항 텍스트가 같다). 그건 상류 데이터셋의 성질이지 우리 결함이 아니다.
// 데이터셋에 묶으면 중복이든 누락이든 **데이터셋 기준으로** 잡힌다.
const DS = "eval/external/minidev/MINIDEV/mini_dev_sqlite.json";
if (existsSync(resolve(ROOT, DS))) {
  const ds = read(DS);
  const bag = (xs) => xs.slice().sort((a, b) => a - b).join(",");
  const dsIds = bag(ds.map((q) => q.question_id));
  const rawIds = bag(raw.map((r) => r.id));
  if (dsIds !== rawIds) {
    const dsSet = new Set(ds.map((q) => q.question_id));
    const missing = [...dsSet].filter((x) => !raw.some((r) => r.id === x));
    fails.push(
      `raw 의 문항 구성이 데이터셋과 다르다: raw ${raw.length}항목 vs 데이터셋 ${ds.length}항목` +
        (missing.length ? ` · 빠진 id [${missing.slice(0, 10).join(", ")}]` : ""),
    );
  } else {
    console.log(`데이터셋 대조: raw 가 Mini-Dev ${ds.length}항목을 그대로 덮는다.`);
  }
}

const goldBad = raw.filter((r) => !r.goldOk).map((r) => r.id).sort((a, b) => a - b);
const declared = [...(sum.goldUnscorableIds ?? [])].sort((a, b) => a - b);
if (JSON.stringify(goldBad) !== JSON.stringify(declared)) {
  fails.push(
    `채점 불가 id 불일치: raw [${goldBad.join(", ")}] vs summary [${declared.join(", ")}]`,
  );
}

console.log(
  `BIRD 산출물 셋을 대조했다: raw ${raw.length}행 · summary ${sum.sampled}문항 ` +
    `· rescore n=${res.sample?.n} · 정답 ${okCount} · 채점 불가 [${goldBad.join(", ")}]`,
);
if (fails.length) {
  console.error("\n실패 " + fails.length + "건:");
  for (const f of fails) console.error("  - " + f);
  console.error("\n부분 실행(EXT_LIMIT)이 정본을 덮었는지 확인한다.\n");
  process.exit(1);
}
console.log("OK: BIRD raw/summary/rescore 가 같은 실행을 가리킨다.");
