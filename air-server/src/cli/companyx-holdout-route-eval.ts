// 홀드아웃 라우팅 평가 — 사업자 공개 30문항과 겹치지 않는 문구로 라우터를 잰다.
//
// 왜 이게 다른가. 공개 30문항 30/30은 라우터 어휘를 그 문항을 읽으며 작성한 in-sample
// 수치다. 이 평가는 라우터가 한 번도 보지 않은 문구로 묻는다. 그래서 결과가 낮게
// 나오는 것이 오히려 의미 있다.
//
// 라벨은 스키마/온톨로지의 라우팅 신호로 정한다(평가자가 보고 맞춘 것이 아니다).
// 라우터는 질문 문장만 보고 어떤 도구를 호출할지 고른다.
//
// 사용: DATASET=companyx node dist/cli/companyx-holdout-route-eval.js
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { route } from "../router.js";

async function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = resolve(here, "../../..");
  const gold = JSON.parse(await readFile(resolve(root, "eval/companyx/holdout_route.json"), "utf8")) as {
    items: { q: string; expected: string }[];
  };

  // 라우팅 결과를 기대 라벨로 매핑한다. 라우터가 고른 레인과 평가자가 정한 신호 라벨을
  // 같은 공간에 둔다.
  const LANE: Record<string, string> = {
    structured: "nl2sql",
    semantic: "vector_search",
    graph: "knowledge_graph",
    hybrid: "hybrid",
  };

  const rows: { q: string; expected: string; got: string; lane: string; hit: boolean; rationale: string }[] = [];
  let hits = 0;
  for (const item of gold.items) {
    const d = route(item.q);
    const got = LANE[d.route] ?? d.route;
    const hit = got === item.expected;
    if (hit) hits++;
    rows.push({
      q: item.q,
      expected: item.expected,
      got,
      lane: d.route,
      hit,
      rationale: d.rationale,
    });
    console.log(`${hit ? "HIT " : "MISS"} 기대=${item.expected} 실제=${got} :: ${item.q}`);
  }

  // 혼동 행렬 — 어디를 어디로 헷갈리는지.
  const confusion: Record<string, number> = {};
  for (const r of rows) {
    if (!r.hit) confusion[`${r.expected} -> ${r.got}`] = (confusion[`${r.expected} -> ${r.got}`] ?? 0) + 1;
  }

  const out = {
    note: "홀드아웃 라우팅 평가. 사업자 공개 30문항과 어휘가 겹치지 않는 30문항. 라벨은 스키마/온톨로지 신호로 정하고 라우터는 질문 문장만 본다.",
    total: gold.items.length,
    correct: hits,
    accuracy: Number((hits / gold.items.length).toFixed(3)),
    confusion,
    rows,
    generated_at: new Date().toISOString(),
  };
  await mkdir(resolve(root, "eval/results"), { recursive: true });
  await writeFile(resolve(root, "eval/results/companyx-holdout-route.json"), JSON.stringify(out, null, 2) + "\n");
  console.log(`\n${JSON.stringify({ correct: hits, total: gold.items.length, accuracy: out.accuracy, confusion }, null, 2)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
