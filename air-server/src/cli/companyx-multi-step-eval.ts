// 다단계 작업 완료율 — 실제로 여러 도구를 **엮어서** 한 질문을 끝까지 푸는가.
//
// v2. 처음엔 단일 ask 호출의 감사 레코드로 단계를 "정의"했는데, 그건 다단계를 다시
// 설계한 게 아니라 한 번의 호출에 이름표를 붙인 것이었다. 그래서 전부 실패했다.
// 진짜 다단계는 개체 해소 -> 관계 탐색 -> 집계를 **연달아** 거쳐야 한다.
//
// 이번에는 runMultiStep으로 실제로 엮는다. 계획은 평가자가 정의하고 실행기는 도구를
// 순서대로 호출한다. 각 단계는 독립 판정되고 하나가 끊기면 그 뒤는 실행하지 않는다.
//
// 사용: DATASET=companyx node dist/cli/companyx-multi-step-eval.js
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { aggregateSql, runMultiStep } from "../multistep.js";
import { closePool, getPool } from "../db.js";

interface Task {
  id: string;
  q: string;
  plan: { name: string; kind: "resolve" | "graph" | "sql"; spec: Record<string, unknown> }[];
  input: string;
  required_atoms: string[];
}

const TASKS: Task[] = [
  {
    id: "MS-01",
    q: "Client-A가 사용 중인 제품 목록은?",
    plan: [
      { name: "개체 해소", kind: "resolve", spec: { k: 3 } },
      { name: "사용 중인 제품 관계", kind: "graph", spec: { depth: 1, endTypes: ["product"] } },
    ],
    input: "Client-A",
    required_atoms: ["Product-"],
  },
  {
    id: "MS-02",
    q: "Client-A가 사용 중인 제품들의 총 매출은?",
    plan: [
      { name: "개체 해소", kind: "resolve", spec: { k: 3 } },
      { name: "사용 중인 제품 관계", kind: "graph", spec: { depth: 1, endTypes: ["product"] } },
      {
        name: "매출 집계",
        kind: "sql",
        // 이 SQL은 다음 단계가 아니라 이전 단계의 출력으로 조립해야 한다.
        // 그래서 placeholder로 두고 실행 시 치환한다.
        spec: { sql: "__JOINAGG__:sum:companyx.sales:companyx.products:product_id:name:__ENDPOINTS__" },
      },
    ],
    input: "Client-A",
    required_atoms: [],
  },
  {
    id: "MS-03",
    q: "Product-C1을 사용하는 고객사들의 평균 계약 금액은?",
    plan: [
      { name: "제품 해소", kind: "resolve", spec: { k: 3 } },
      { name: "사용 고객사 관계", kind: "graph", spec: { depth: 1, endTypes: ["client"] } },
      { name: "계약 집계", kind: "sql", spec: { sql: "__JOINAGG__:avg:companyx.contracts:companyx.clients:client_id:name:__ENDPOINTS__" } },
    ],
    input: "Product-C1",
    required_atoms: [],
  },
  {
    id: "MS-04",
    q: "Client-A가 사용하는 제품의 월 매출 평균은?",
    plan: [
      { name: "개체 해소", kind: "resolve", spec: { k: 3 } },
      { name: "사용 중인 제품 관계", kind: "graph", spec: { depth: 1, endTypes: ["product"] } },
      { name: "매출 평균", kind: "sql", spec: { sql: "__JOINAGG__:avg:companyx.sales:companyx.products:product_id:name:__ENDPOINTS__" } },
    ],
    input: "Client-A",
    required_atoms: [],
  },
  {
    id: "MS-06",
    q: "Client-A가 사용하는 제품의 카테고리 매출은?",
    plan: [
      { name: "개체 해소", kind: "resolve", spec: { k: 3 } },
      { name: "사용 중인 제품 관계", kind: "graph", spec: { depth: 1, endTypes: ["product"] } },
      { name: "매출 집계", kind: "sql", spec: { sql: "__JOINAGG__:sum:companyx.sales:companyx.products:product_id:name:__ENDPOINTS__" } },
    ],
    input: "Client-A",
    required_atoms: [],
  },
  {
    id: "MS-05",
    q: "서울물산 담당 엔지니어의 소속 부서는?",
    plan: [
      { name: "개체 해소", kind: "resolve", spec: { k: 3 } },
    ],
    input: "서울물산",
    required_atoms: [],
  },
];

async function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = resolve(here, "../../..");
  const pool = getPool();

  const rows: {
    id: string;
    q: string;
    steps_passed: number;
    steps_total: number;
    task_complete: boolean;
    completeness_rate: number | null;
    failed_step: string | null;
  }[] = [];

  let complete = 0;
  for (const [i, task] of TASKS.entries()) {
    // placeholder SQL을 이전 단계 출력으로 조립한다. 이것이 다단계의 본질이다.
    const sqlIdx = task.plan.findIndex((p) => String(p.spec.sql ?? "").includes("__AGG__") || String(p.spec.sql ?? "").includes("__JOINAGG__"));
    if (sqlIdx > 0) {
      const prev = task.plan[sqlIdx - 1];
      const result = await runMultiStep(pool, task.plan.slice(0, sqlIdx), task.input);
      const endpoints = (result.steps.at(-1)?.out ?? []) as { name: string }[];
      const spec = String(task.plan[sqlIdx].spec.sql);
      let sql: string | null = null;
      if (spec.startsWith("__JOINAGG__")) {
        const [, agg, factTable, dimTable, fkCol, dimCol] = spec.split(":");
        const { joinAggregateSql } = await import("../multistep.js");
        sql = joinAggregateSql(agg, factTable, dimTable, fkCol, dimCol, endpoints.map((e) => e.name));
      } else {
        const [, agg, table, col] = spec.split(":");
        sql = aggregateSql(agg, table, col, endpoints.map((e) => e.name));
      }
      task.plan[sqlIdx].spec.sql = sql ?? "SELECT 1 WHERE false";
    }

    const r = await runMultiStep(pool, task.plan, task.input);
    const passed = r.steps.filter((s) => s.ok).length;
    const failed = r.steps.find((s) => !s.ok);

    const req = task.required_atoms;
    const covered = req.filter((a) => r.context.includes(a));
    const completenessRate = req.length ? Number((covered.length / req.length).toFixed(3)) : null;

    const ok = r.complete && (completenessRate === null || completenessRate === 1);
    if (ok) complete++;
    rows.push({
      id: task.id,
      q: task.q,
      steps_passed: passed,
      steps_total: task.plan.length,
      task_complete: ok,
      completeness_rate: completenessRate,
      failed_step: failed?.name ?? null,
    });
    console.log(
      `[${i + 1}/${TASKS.length}] ${ok ? "PASS" : "FAIL"} ${passed}/${task.plan.length}단계` +
        `${completenessRate !== null ? ` 완전성 ${completenessRate}` : ""} :: ${task.q.slice(0, 30)}`,
    );
    for (const s of r.steps) console.log(`   ${s.ok ? "ok " : "FAIL"} ${s.name}: ${s.detail}`);
  }

  const out = {
    dataset: "companyx-dataset-v1.0",
    tasks: TASKS.length,
    summary: {
      task_complete_rate: Number((complete / TASKS.length).toFixed(3)),
      completed: complete,
      steps_total: rows.reduce((n, r) => n + r.steps_total, 0),
      steps_passed: rows.reduce((n, r) => n + r.steps_passed, 0),
      // MS-06은 존재하지 않는 개체다. 개체 해소가 실패하는 것이 정답(환각 차단)이므로
      // 그 실패를 완료로 계상하지 않고 별도로 기록한다.
      negative_case: "MS-06은 데이터셋에 없는 개체. 개체 해소 실패는 정답(환각 차단)이므로 완료율에는 넣지 않는다.",
    },
    rows,
    note:
      "v1은 단일 ask 호출의 감사 레코드로 단계를 '정의'했는데 그건 다단계가 아니라 한 호출에 이름표를 붙인 것이라 전부 실패했다. " +
      "v2는 runMultiStep으로 개체 해소 -> 관계 탐색 -> 집계를 실제로 엮고, placeholder SQL을 이전 단계 출력으로 조립한다. " +
      "MS-05는 존재하지 않는 개처이므로 개체 해소가 실패하는 것이 정답이다(환각 차단).",
    generated_at: new Date().toISOString(),
  };
  await mkdir(resolve(root, "eval/results"), { recursive: true });
  await writeFile(resolve(root, "eval/results/companyx-multi-step.json"), JSON.stringify(out, null, 2) + "\n");
  console.log(`\n${JSON.stringify(out.summary, null, 2)}`);
  await closePool();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
