// Router accuracy against the sponsor's own labels.
//
// datasets/companyx-v1.0/questions.json ships 30 example questions, each labelled
// with the MCP tool the 지정과제 expects (nl2sql | vector_search | knowledge_graph).
// That is a real external label set for the routing decision, so we score it the
// honest way: exact lane match, plus a "label ∈ fanned-out tools" recall column
// (a hybrid fan-out still reaches the right tool, at the cost of a second call).
//
// No LLM, no DB: the router is pure. Run: npm run companyx:route
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { route, audit, LANE_LABEL, SQL_TOOL, VECTOR_TOOL, ONTOLOGY_TOOL, GRAPH_TOOL } from "../router.js";
import { loadQuestions, datasetDir, type CxQuestion } from "../companyx.js";

const TOOL_OF_LABEL: Record<CxQuestion["tool"], string[]> = {
  nl2sql: [SQL_TOOL],
  vector_search: [VECTOR_TOOL],
  knowledge_graph: [ONTOLOGY_TOOL, GRAPH_TOOL],
};

async function main() {
  const questions = await loadQuestions(datasetDir());
  const rows = questions.map((item) => {
    const d = route(item.q);
    const lane = LANE_LABEL[d.route];
    const exact = lane === item.tool;
    const reached = TOOL_OF_LABEL[item.tool].some((t) => d.tools.includes(t));
    return { q: item.q, expected: item.tool, got: lane, exact, reached, audit: audit(d) };
  });

  const byLabel: Record<string, { n: number; exact: number; reached: number }> = {};
  for (const r of rows) {
    const b = (byLabel[r.expected] ??= { n: 0, exact: 0, reached: 0 });
    b.n++;
    if (r.exact) b.exact++;
    if (r.reached) b.reached++;
  }

  // Determinism: the whole point of a rule router. 20 repeats must be byte-identical.
  const fingerprint = JSON.stringify(questions.map((x) => audit(route(x.q))));
  let stable = true;
  for (let i = 0; i < 20; i++) {
    if (JSON.stringify(questions.map((x) => audit(route(x.q)))) !== fingerprint) stable = false;
  }

  const exact = rows.filter((r) => r.exact).length;
  const reached = rows.filter((r) => r.reached).length;
  const summary = {
    dataset: "companyx-dataset-v1.0 / questions.json",
    n: rows.length,
    exact_lane_match: exact,
    exact_pct: Number(((exact / rows.length) * 100).toFixed(1)),
    label_reached: reached,
    reached_pct: Number(((reached / rows.length) * 100).toFixed(1)),
    by_label: byLabel,
    deterministic_20_runs: stable,
    caveat:
      "IN-SAMPLE: these 30 questions are the sponsor's published examples and the router lexicon was written while reading them. Generalization is measured separately (companyx-route-heldout).",
    misses: rows.filter((r) => !r.exact).map((r) => ({ q: r.q, expected: r.expected, got: r.got, why: r.audit.rationale })),
    generated_at: new Date().toISOString(),
  };

  const here = dirname(fileURLToPath(import.meta.url));
  const outPath = resolve(here, "..", "..", "..", "eval", "results", "companyx-route.json");
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify({ summary, rows }, null, 2) + "\n", "utf-8");

  for (const r of rows) {
    console.log(`${r.exact ? "OK  " : "MISS"} [${r.expected} -> ${r.got}] ${r.q}`);
  }
  console.log(`\ncompanyx:route ${JSON.stringify(summary, null, 2)}`);
  if (!stable) {
    console.error("FAIL: router is not deterministic across 20 runs");
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
