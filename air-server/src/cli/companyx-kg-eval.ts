// Knowledge-graph lane retrieval eval on the sponsor dataset.
//
// The oracle is the dataset itself: eval/companyx/kg_gold.json states each of the
// 10 knowledge_graph questions as a graph QUERY (neighbors / two-hop / argmax over
// a relation), and the gold answer set is computed from graph/edges.json. No LLM
// judge, no hand-written answer strings — the same "the data is the oracle"
// discipline the SQL execution-match bench uses.
//
// Metric = retrieval recall: does the graph lane put every gold entity into the
// candidate context? (Answer generation is measured separately; a lane that
// never retrieves the gold entity can only answer by luck.)
//
// Run: KG_SCHEMA=companyx npm run companyx:kg
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPool, closePool } from "../db.js";
import { graphLane } from "../pipeline.js";
import { route } from "../router.js";
import { loadGraph, datasetDir, CX_SCHEMA } from "../companyx.js";

type Spec =
  | { kind: "neighbors"; seed: string; rel: string; dir: "in" | "out" }
  | { kind: "two_hop"; seed: string; rel1: string; dir1: "in" | "out"; rel2: string; dir2: "in" | "out" }
  | { kind: "argmax"; rel: string; over: "source" | "target" }
  | { kind: "leads_status"; rel: string; status: string }
  | { kind: "absent"; note: string };

interface GoldItem {
  q: string;
  spec: Spec;
}

async function main() {
  const dir = datasetDir();
  const { nodes, edges } = await loadGraph(dir);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const goldPath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "eval", "companyx", "kg_gold.json");
  const gold: GoldItem[] = JSON.parse(await readFile(goldPath, "utf-8"));

  const neighbors = (seed: string, rel: string, dir: "in" | "out"): string[] =>
    edges
      .filter((e) => e.relation === rel && (dir === "out" ? e.source === seed : e.target === seed))
      .map((e) => (dir === "out" ? e.target : e.source));

  function goldSet(spec: Spec): string[] {
    switch (spec.kind) {
      case "neighbors":
        return neighbors(spec.seed, spec.rel, spec.dir);
      case "two_hop": {
        const mid = neighbors(spec.seed, spec.rel1, spec.dir1);
        return [...new Set(mid.flatMap((m) => neighbors(m, spec.rel2, spec.dir2)))];
      }
      case "argmax": {
        const counts = new Map<string, number>();
        for (const e of edges) {
          if (e.relation !== spec.rel) continue;
          const key = spec.over === "target" ? e.target : e.source;
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        const max = Math.max(...counts.values());
        return [...counts.entries()].filter(([, c]) => c === max).map(([k]) => k);
      }
      case "leads_status": {
        const out: string[] = [];
        for (const e of edges) {
          if (e.relation !== spec.rel) continue;
          const proj = byId.get(e.target);
          if (proj && (proj.properties as { status?: string })?.status === spec.status) out.push(e.source);
        }
        return [...new Set(out)];
      }
      case "absent":
        return [];
    }
  }

  const pool = getPool();
  const schema = process.env.KG_SCHEMA ?? CX_SCHEMA;
  const rows = [] as Record<string, unknown>[];
  let recallSum = 0;
  let full = 0;
  let scored = 0;

  for (const item of gold) {
    const d = route(item.q);
    const lane = await graphLane(pool, item.q, Number(process.env.KG_SEEDS ?? 5), 2, schema);
    const retrievedText = lane.items.map((i) => i.text).join("\n");
    const g = goldSet(item.spec);
    const goldNames = g.map((id) => byId.get(id)?.name ?? id);
    const hit = goldNames.filter((n) => retrievedText.includes(n));
    const recall = goldNames.length ? hit.length / goldNames.length : null;
    if (recall !== null) {
      recallSum += recall;
      scored++;
      if (recall === 1) full++;
    }
    rows.push({
      q: item.q,
      routed: d.route,
      strategy: lane.strategy,
      plan: d.graphPlan ?? null,
      spec: item.spec.kind,
      gold_n: goldNames.length,
      gold: goldNames,
      seeds: lane.seeds.map((s) => `${s.canonicalName}(${s.type})`),
      edges: lane.edgeCount,
      candidates: lane.items.length,
      hit_n: hit.length,
      recall,
      missing: goldNames.filter((n) => !hit.includes(n)),
      error: lane.error,
    });
  }

  const summary = {
    dataset: "companyx-dataset-v1.0 / graph",
    schema,
    n: gold.length,
    scored,
    abstain_cases: gold.length - scored,
    unresolved_gate_fired: rows.filter((r) => r.strategy === "unresolved").length,
    mean_recall: scored ? Number((recallSum / scored).toFixed(3)) : null,
    full_recall_questions: full,
    routed_to_graph: rows.filter((r) => r.routed === "graph").length,
    generated_at: new Date().toISOString(),
  };

  const outPath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "eval", "results", "companyx-kg.json");
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify({ summary, rows }, null, 2) + "\n", "utf-8");

  for (const r of rows) {
    console.log(
      `${r.recall === null ? "ABST" : r.recall === 1 ? "OK  " : "PART"} recall=${r.recall ?? "-"} gold=${r.gold_n} hit=${r.hit_n} seeds=${(r.seeds as string[]).length} edges=${r.edges} :: ${r.q}`,
    );
  }
  console.log(`\ncompanyx:kg ${JSON.stringify(summary, null, 2)}`);
  await closePool();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
