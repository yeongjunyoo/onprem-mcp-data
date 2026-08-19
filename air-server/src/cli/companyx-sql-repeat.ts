// NL2SQL 반복 실행기 — 한 번 재보고 끝내는 수치의 변동폭을 드러낸다.
//
// 왜 필요한가: 2026-07-29에 같은 코드, 같은 설정(재시도 없음, 스키마 카드)으로
// 두 번 돌렸더니 7/10과 5/10이 나왔다. temperature 0과 seed를 고정해도 로컬 7B는
// 실행마다 흔들린다. n=10에서 한두 문항 차이는 20pp이므로, 단일 실행 수치를
// 헤드라인으로 쓰면 그 자체가 과장이다.
//
// 하는 일: 지정한 조건을 N회 반복 실행하고 문항별 정오 행렬과 중앙값·최소·최대를
// eval/results/companyx-sql-repeat.json에 남긴다. 개별 실행의 rows도 보존한다.
//
// 사용: CX_REPEAT=5 CX_STRATEGY=llm CX_REPAIR=0 node dist/cli/companyx-sql-repeat.js
import { execFile } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

async function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = resolve(here, "../../..");
  const strategy = process.env.CX_STRATEGY ?? "llm";
  const repair = process.env.CX_REPAIR ?? "1";
  const repeats = Number(process.env.CX_REPEAT ?? 5);
  const suffix = repair === "0" ? "-norepair" : "";
  const artifact = resolve(root, `eval/results/companyx-sql-${strategy}${suffix}.json`);

  const runs: { correct: number; total: number; wrong: string[]; model: string | null }[] = [];
  for (let i = 1; i <= repeats; i++) {
    await run(process.execPath, [resolve(here, "companyx-sql-eval.js")], {
      env: { ...process.env, CX_STRATEGY: strategy, CX_REPAIR: repair },
      maxBuffer: 1 << 24,
    });
    const d = JSON.parse(await readFile(artifact, "utf8")) as {
      summary: { correct: number; total: number; model?: string | null };
      rows: { id: string; ok: boolean }[];
    };
    const wrong = d.rows.filter((r) => !r.ok).map((r) => r.id);
    runs.push({ correct: d.summary.correct, total: d.summary.total, wrong, model: d.summary.model ?? null });
    console.log(`run ${i}/${repeats}: ${d.summary.correct}/${d.summary.total}  실패=${wrong.join(",") || "없음"}`);
  }

  const scores = runs.map((r) => r.correct).sort((a, b) => a - b);
  const median = scores[Math.floor(scores.length / 2)];
  // 문항별로 몇 번 맞았는지 — 항상 틀리는 문항과 흔들리는 문항을 가른다.
  const perQuestion = new Map<string, number>();
  for (const r of runs) for (const id of r.wrong) perQuestion.set(id, (perQuestion.get(id) ?? 0) + 1);

  // 하위 실행이 적은 모델을 **버리지 않고 전달한다.** 2026-08-19 리뷰: 집계기가
  // model 을 안 담아 7월 옛 모델 반복 결과가 현재 결과와 구별되지 않았다.
  // 라벨 사고를 **라벨 부재**로 재현한 것이다. 회차마다 다르면 그건 섞인 측정이라 실패시킨다.
  // null 을 **버리지 않고** 센다. filter(Boolean) 이면 「모델을 적은 회차 + 안 적은 회차」
  // 혼합이 불일치로 안 잡힌다(2026-08-19 리뷰 P2). 전부 null 인 것은 정상(비-LLM 전략),
  // null 과 이름이 섞이거나 이름끼리 다르면 **섞인 측정**이라 반복이 아니다.
  const models = [...new Set(runs.map((r) => r.model ?? null))];
  if (models.length > 1) {
    console.error(`\n실패: 회차마다 모델이 다르다 (${models.join(", ")}) — 섞인 측정은 반복이 아니다.\n`);
    process.exit(1);
  }

  const out = {
    strategy,
    model: models[0] ?? null,
    repair_enabled: repair !== "0",
    repeats,
    total: runs[0]?.total ?? 0,
    scores,
    median,
    min: scores[0],
    max: scores[scores.length - 1],
    always_wrong: [...perQuestion.entries()].filter(([, n]) => n === repeats).map(([id]) => id),
    flaky: [...perQuestion.entries()].filter(([, n]) => n < repeats).map(([id, n]) => ({ id, wrong_runs: n })),
    runs,
    note:
      "temperature 0과 seed를 고정해도 로컬 7B는 실행마다 흔들린다. n=10에서 한 문항은 10pp이므로 단일 실행 수치를 헤드라인으로 쓰지 않는다.",
    generated_at: new Date().toISOString(),
  };
  await mkdir(resolve(root, "eval/results"), { recursive: true });
  await writeFile(
    resolve(root, `eval/results/companyx-sql-repeat-${strategy}${suffix}.json`),
    JSON.stringify(out, null, 2) + "\n",
  );
  console.log(`\n중앙값 ${median}/${out.total}  범위 ${out.min}~${out.max}  항상틀림=${out.always_wrong.join(",") || "없음"}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
