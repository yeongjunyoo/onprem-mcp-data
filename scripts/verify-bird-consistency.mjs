// BIRD 산출물 세 개가 서로 맞는지 본다.
//
// 2026-08-19: 후보 비교(EXT_LIMIT=32) 실행이 정본 raw 를 500행 -> 32행으로 덮었다.
// summary 는 500, rescore 는 500, raw 만 32 였고 **검사 23종이 전부 통과했다** -
// 세 검사 스크립트 어디에도 external-bird-raw 를 읽는 곳이 없었기 때문이다.
// rescore_bird.py 는 raw 를 입력으로 쓰므로 그 상태로 재실행하면 전수 결과가 덮인다.
//
// **아무도 안 보는 증거는 증거가 아니다.**
import { readFileSync, existsSync } from "node:fs";
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
