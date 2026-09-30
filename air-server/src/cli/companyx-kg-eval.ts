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
// ★ 서버와 같은 라우터 상태에서 잰다(initRouting + routeQuery, 2026-10-01).
// 종전에는 온톨로지도 시맨틱 앵커도 없는 규칙만의 route() 로 탐색 계획을 만들었다. 그 상태에서
// 「Product-D1 제품과 관련된 프로젝트는?」은 무타입 두 홉 확장이라 재현율 1.0 이었지만, 서버는
// 시맨틱 폴백이 준 HAS_PROJECT 로 제품에서 출발해 빈손이었다. 평가가 서버가 아닌 경로를 재면
// 정본 1.0 이 서버의 오답을 가린다.
//
// Run: KG_SCHEMA=companyx npm run companyx:kg
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPool, closePool } from "../db.js";
import { graphLane } from "../pipeline.js";
import { routeQuery } from "../semroute.js";
import { initRouting } from "../routerinit.js";
import { getEmbedder } from "../embedder.js";
import { loadGraph, datasetDir, CX_SCHEMA, requireDataset, kgGoldIds, type KgSpec } from "../companyx.js";

interface GoldItem {
  q: string;
  spec: KgSpec;
}

async function main() {
  requireDataset();
  const dir = datasetDir();
  const { nodes, edges } = await loadGraph(dir);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const goldPath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "eval", "companyx", "kg_gold.json");
  const gold: GoldItem[] = JSON.parse(await readFile(goldPath, "utf-8"));

  const goldSet = (spec: KgSpec): string[] => kgGoldIds(spec, nodes, edges);

  const pool = getPool();
  const schema = process.env.KG_SCHEMA ?? CX_SCHEMA;
  const routing = await initRouting();
  const embedder = getEmbedder();
  const rows = [] as Record<string, unknown>[];
  let recallSum = 0;
  let full = 0;
  let scored = 0;

  for (const item of gold) {
    const d = await routeQuery(item.q, embedder);
    const lane = await graphLane(pool, item.q, Number(process.env.KG_SEEDS ?? 5), 2, schema, d.graphPlan);
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
      fitted: lane.fitted ?? null,
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
    routing: {
      ontology_entities: routing.ontology.entities,
      ontology_error: routing.ontology.error ?? null,
      semantic_anchors: routing.semantic.anchors,
      semantic_error: routing.semantic.error ?? null,
      embedder: embedder.name,
    },
    generated_at: new Date().toISOString(),
  };

  const outPath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "eval", "results", "companyx-kg.json");
  await mkdir(dirname(outPath), { recursive: true });
  // ── 쓰기 전에: 아무 근거도 못 읽었으면 그것은 0점이 아니라 코퍼스가 없는 것이다.
  //
  // 2026-08-18: DB 를 죽은 포트로 돌린 상태에서 이 평가가 **exit 0 으로 recall=0** 을
  // 내고 정본을 덮었다. BIRD 는 최소한 exit 1 이었는데 이건 사람이 눈치챌 신호가 없다.
  // **거절은 사람이 고치게 하지만 나쁜 숫자는 사람이 믿게 한다.**
  const anyEvidence = rows.some((r) => (r.seeds as string[]).length > 0 || Number(r.edges) > 0);
  if (!anyEvidence) {
    console.error("\n실패: 전 문항에서 시드도 엣지도 0이다 — 코퍼스를 못 읽었다(0점이 아니라 데이터 부재).");
    console.error("  DATABASE_URL 이 살아 있는지, npm run companyx:load 를 돌렸는지 확인한다.");
    console.error("  결과 파일을 쓰지 않았다. 정본은 그대로다.\n");
    process.exit(1);
  }

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
