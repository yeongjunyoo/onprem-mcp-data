// Gate7 — deterministic fault-injection suite + observability.
//
// Injects branch failures (no model needed) and measures the operational-stability
// claim the brief rewards ("fewer failure points / graceful degradation"):
//   no-crash rate      — retrieval must never throw on a single-branch failure
//   partial-context    — when >=1 branch still has candidates, context is non-empty
//   error-visibility   — every failure is auditable (branch_errors OR ok:false)
// Writes eval/results/faults.json + a per-scenario audit line. Exits non-zero if
// thresholds are not met (no fabrication: real injected failures, real outcomes).
import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { getPool, closePool } from "../db.js";
import { HashEmbedder, type Embedder } from "../embedder.js";
import { embedDocuments } from "../vector.js";
import { retrieve } from "../pipeline.js";
import { kgRetrieve } from "../kgretrieve.js";
import { templateNL2SQL } from "../nl2sql.js";

const broken: Embedder = { name: "broken", dim: 1024, embed: async () => { throw new Error("embedder unavailable (injected)"); } };
const throwingNL2SQL = async () => { throw new Error("nl2sql backend down (injected)"); };

interface Outcome { scenario: string; crashed: boolean; partial: boolean; errorVisible: boolean; detail: string; }

async function main() {
  const pool = getPool();
  const hash = new HashEmbedder();
  await embedDocuments(pool, hash); // public.documents (hash) for the public-pipeline scenarios

  const out: Outcome[] = [];
  const run = async (scenario: string, fn: () => Promise<{ partial: boolean; errorVisible: boolean; detail: string }>) => {
    try {
      const r = await fn();
      out.push({ scenario, crashed: false, ...r });
    } catch (e) {
      out.push({ scenario, crashed: true, partial: false, errorVisible: true, detail: `THREW: ${e instanceof Error ? e.message : String(e)}` });
    }
  };

  // A) KG 3-way, vector branch fails (broken embedder) -> graph must carry it
  await run("kg.vector_fail", async () => {
    const r = await kgRetrieve(pool, "전자제품 환불 규정", { embedder: broken, schema: "bench", k: 5 });
    return { partial: r.fused.length > 0 && r.audit.graph > 0, errorVisible: r.audit.vector === 0, detail: `vector=${r.audit.vector} graph=${r.audit.graph} fused=${r.audit.fused}` };
  });

  // B) KG 3-way, graph branch fails (no KG tables in 'public') -> vector must carry it
  await run("kg.graph_fail", async () => {
    const r = await kgRetrieve(pool, "환불 정책", { embedder: hash, schema: "public", k: 5 });
    return { partial: r.fused.length > 0 && r.audit.vector > 0, errorVisible: r.audit.graph === 0, detail: `vector=${r.audit.vector} graph=${r.audit.graph} fused=${r.audit.fused}` };
  });

  // C) public pipeline, SQL branch rejects (nl2sql throws) -> vector survives, error in branch_errors
  await run("pipeline.sql_fail", async () => {
    const r = await retrieve("지난달 취소된 주문 중 환불 관련 비슷한 케이스", { pool, embedder: hash, nl2sql: throwingNL2SQL });
    return { partial: r.context.length > 0 && r.audit.candidates.vector > 0, errorVisible: r.audit.branch_errors.some((e) => e.startsWith("sql")), detail: `branch_errors=${JSON.stringify(r.audit.branch_errors)} vec=${r.audit.candidates.vector}` };
  });

  // D) public pipeline, vector embedder fails -> SQL survives (caught as ok:false, auditable)
  await run("pipeline.vector_fail", async () => {
    const r = await retrieve("환불 관련 주문이 비슷한 케이스 몇 건", { pool, embedder: broken, nl2sql: templateNL2SQL });
    return { partial: r.context.length > 0 && r.audit.candidates.sql > 0, errorVisible: r.vector?.ok === false, detail: `vec.ok=${r.vector?.ok} sql=${r.audit.candidates.sql} ctxlen=${r.context.length}` };
  });

  const total = out.length;
  const noCrash = out.filter((o) => !o.crashed).length;
  const partial = out.filter((o) => o.partial).length;
  const visible = out.filter((o) => o.errorVisible).length;
  const summary = {
    total, noCrashRate: noCrash / total, partialRate: partial / total, errorVisibleRate: visible / total,
    thresholds: { noCrash: 1.0, partial: 0.8, errorVisible: 1.0 },
    pass: noCrash === total && partial / total >= 0.8 && visible === total,
    generatedAt: new Date().toISOString(),
  };
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  await mkdir(resolve(root, "eval/results"), { recursive: true });
  await writeFile(resolve(root, "eval/results/faults.json"), JSON.stringify({ summary, scenarios: out }, null, 2));

  for (const o of out) console.log(`${o.crashed ? "CRASH" : o.partial ? "✓degraded" : "✗nopart"} ${o.scenario} | errVisible=${o.errorVisible} | ${o.detail}`);
  console.log(`\n[fault] no-crash ${noCrash}/${total}, partial ${partial}/${total} (>=80%), error-visible ${visible}/${total} -> ${summary.pass ? "PASS" : "FAIL"}`);
  await closePool();
  process.exit(summary.pass ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
