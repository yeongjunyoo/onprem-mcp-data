// End-to-end `ask` on the sponsor's 30 example questions.
//
// The lane evals measure RETRIEVAL. This measures the product: question in, Korean
// answer out, through route -> parallel fan-out -> RRF -> curation -> on-prem 7B.
// It is what a judge sees when they start the MCP server, and what the 3-minute
// demo records, so it gets its own numbers.
//
// Scored WITHOUT an LLM judge (the project's rule). Three deterministic checks:
//
//   1. evidence_in_context — did the curated context actually contain the gold
//      evidence? (gold reused from the lane oracles: SQL gold rows, KG gold
//      entities, vector gold keywords.) A wrong answer over correct context is a
//      model limit; a wrong answer over empty context is a pipeline bug, and only
//      this separation tells them apart.
//   2. answer_grounded — every dataset-specific entity the ANSWER names
//      (Client-*, Product-*, DOC-*, employee names, department names) must appear
//      in the context. An entity that is not there was invented.
//   3. abstains_when_absent — the 서울물산 case must produce a "not found" answer,
//      not a plausible engineer.
//
// Run: DATASET=companyx EMBEDDER=ollama npm run companyx:ask
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPool, closePool } from "../db.js";
import { getEmbedder } from "../embedder.js";
import { ask } from "../pipeline.js";
import { profile } from "../profile.js";
import { isAvailable } from "../llm.js";
import { loadQuestions, loadGraph, datasetDir, type CxQuestion } from "../companyx.js";

interface SqlGold {
  id: string;
  q: string;
  gold: string;
}

const ABSENT_Q = "서울물산 담당 엔지니어는 누구야?";
const NOT_FOUND_PAT = /없|찾을 수 없|찾지 못|확인되지|존재하지|모르|정보가 아니|해당 없/;

/** Dataset-specific entity mentions inside a free-text answer. */
function entityMentions(text: string, names: Set<string>): string[] {
  const found = new Set<string>();
  for (const m of text.match(/\b(?:Client|Product|DOC)-[A-Z0-9]+\b/g) ?? []) found.add(m);
  for (const n of names) {
    if (n.length >= 2 && text.includes(n)) found.add(n);
  }
  return [...found];
}

async function main() {
  const ds = profile();
  if (ds.name !== "companyx") {
    console.error(`FAIL: DATASET=companyx 로 실행해야 한다 (현재 ${ds.name})`);
    process.exit(1);
  }
  if (!(await isAvailable())) {
    console.log("companyx:ask SKIPPED (Ollama/model unavailable)");
    process.exit(0);
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const root = resolve(here, "../../..");
  const dir = datasetDir();

  const questions: CxQuestion[] = await loadQuestions(dir);
  const sqlGold: SqlGold[] = (await readFile(resolve(root, "eval/companyx/sql_gold.jsonl"), "utf8"))
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
  const sqlGoldByQ = new Map(sqlGold.map((g) => [g.q, g]));
  const vectorGold = JSON.parse(await readFile(resolve(root, "eval/companyx/vector_gold.json"), "utf8")) as {
    items: { q: string; keywords: string[] }[];
  };
  const vecByQ = new Map(vectorGold.items.map((i) => [i.q, i.keywords]));
  const kgGold = JSON.parse(await readFile(resolve(root, "eval/companyx/kg_gold.json"), "utf8")) as {
    q: string;
    spec: Record<string, unknown>;
  }[];
  const kgByQ = new Map(kgGold.map((g) => [g.q, g.spec]));

  const { nodes, edges } = await loadGraph(dir);
  const nodeName = new Map(nodes.map((n) => [n.id, n.name]));
  const personNames = new Set<string>(
    nodes.filter((n) => n.type === "employee" || n.type === "department").map((n) => n.name),
  );

  const pool = getPool();
  const embedder = getEmbedder();

  // Gold evidence per question, expressed as strings that MUST show up in context.
  async function goldEvidence(item: CxQuestion): Promise<string[]> {
    if (item.tool === "nl2sql") {
      const g = sqlGoldByQ.get(item.q);
      if (!g) return [];
      const res = await pool.query(g.gold);
      // Prefer the first NON-NUMERIC value of each gold row: a bare id ("37") both
      // matches by accident elsewhere in the context and is not what a person asked
      // for. Fall back to the first value for pure aggregates (counts, sums).
      return res.rows.slice(0, 5).map((r) => {
        const vals = Object.values(r).map((v) => String(v));
        return vals.find((v) => !/^-?\d+(\.\d+)?$/.test(v)) ?? vals[0];
      });
    }
    if (item.tool === "vector_search") return vecByQ.get(item.q) ?? [];
    const spec = kgByQ.get(item.q) as
      | { kind: string; seed?: string; rel?: string; dir?: "in" | "out" }
      | undefined;
    if (!spec || spec.kind === "absent") return [];
    if (spec.kind === "neighbors" && spec.seed && spec.rel) {
      return edges
        .filter((e) => e.relation === spec.rel && (spec.dir === "out" ? e.source === spec.seed : e.target === spec.seed))
        .map((e) => nodeName.get(spec.dir === "out" ? e.target : e.source) ?? "")
        .filter(Boolean)
        .slice(0, 5);
    }
    return []; // two_hop / argmax / leads_status: retrieval already scored in companyx:kg
  }

  const rows = [];
  let evidenceScored = 0,
    evidenceOk = 0,
    groundedScored = 0,
    groundedOk = 0;

  for (const item of questions) {
    const t0 = Date.now();
    const r = await ask(item.q, { pool, embedder, budget: Number(process.env.CX_BUDGET ?? 512) });
    const ms = Date.now() - t0;

    const gold = await goldEvidence(item);
    const inContext = gold.filter((g) => r.context.includes(g));
    const evidence = gold.length ? inContext.length / gold.length : null;
    if (evidence !== null) {
      evidenceScored++;
      if (evidence === 1) evidenceOk++;
    }

    const mentioned = entityMentions(r.answer, personNames);
    const invented = mentioned.filter((m) => !r.context.includes(m));
    if (mentioned.length) {
      groundedScored++;
      if (invented.length === 0) groundedOk++;
    }

    const isAbsent = item.q === ABSENT_Q;
    const abstained = isAbsent ? NOT_FOUND_PAT.test(r.answer) : null;

    rows.push({
      q: item.q,
      lane_expected: item.tool,
      lane_routed: r.route,
      answer: r.answer.replace(/\s+/g, " ").trim(),
      context_chars: r.context.length,
      candidates: r.audit.candidates,
      branch_errors: r.audit.branch_errors,
      gold_evidence: gold,
      evidence_in_context: evidence,
      answer_entities: mentioned,
      invented_entities: invented,
      abstained_on_absent: abstained,
      ms,
    });

    const flag =
      isAbsent ? (abstained ? "ABST-OK" : "ABST-FAIL") : invented.length ? "UNGROUNDED" : evidence === null ? "----" : evidence === 1 ? "OK  " : "PART";
    console.log(`${flag} [${item.tool}->${r.route}] ev=${evidence ?? "-"} ctx=${r.context.length} ${ms}ms :: ${item.q}`);
    console.log(`      ${rows[rows.length - 1].answer.slice(0, 160)}`);
  }

  const absentRow = rows.find((x) => x.q === ABSENT_Q);
  const summary = {
    dataset: "companyx-dataset-v1.0 / questions.json (end-to-end ask)",
    profile: ds.name,
    model: process.env.OLLAMA_MODEL ?? "qwen2.5:7b",
    embedder: embedder.name,
    // ★ 지연은 환경에 종속된다. 같은 코드가 GPU 호스트 Ollama에서 약 0.8초,
    // GPU 패스스루가 없는 컨테이너 Ollama에서 약 10초다(13배). 어느 엔드포인트에서
    // 쟀는지 결과가 스스로 말하지 않으면 그 수치는 재현 불가능한 주장이 된다.
    ollama_host: process.env.OLLAMA_HOST ?? "http://localhost:11434",
    n: rows.length,
    evidence_in_context_full: `${evidenceOk}/${evidenceScored}`,
    evidence_pct: evidenceScored ? Number(((evidenceOk / evidenceScored) * 100).toFixed(1)) : null,
    answers_grounded: `${groundedOk}/${groundedScored}`,
    grounded_pct: groundedScored ? Number(((groundedOk / groundedScored) * 100).toFixed(1)) : null,
    abstained_on_absent_entity: absentRow?.abstained_on_absent ?? null,
    lane_agreement: rows.filter(
      (x) =>
        (x.lane_expected === "nl2sql" && x.lane_routed === "structured") ||
        (x.lane_expected === "vector_search" && x.lane_routed === "semantic") ||
        (x.lane_expected === "knowledge_graph" && x.lane_routed === "graph"),
    ).length,
    branch_error_questions: rows.filter((x) => x.branch_errors.length).length,
    median_ms: rows.map((x) => x.ms).sort((a, b) => a - b)[Math.floor(rows.length / 2)],
    note: "No LLM judge. evidence_in_context = gold values (SQL gold rows / KG gold entities / vector gold keywords) present in the curated context. answers_grounded = every dataset entity named in the answer also appears in the context (invented entity = hallucination).",
    generated_at: new Date().toISOString(),
  };

  await mkdir(resolve(root, "eval/results"), { recursive: true });
  await writeFile(resolve(root, "eval/results/companyx-ask.json"), JSON.stringify({ summary, rows }, null, 2) + "\n");
  console.log(`\ncompanyx:ask ${JSON.stringify(summary, null, 2)}`);
  await closePool();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
