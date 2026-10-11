// Diagnostic build: copy air-server/dist/*.js into air-server/dist/_diag/ and add four hooks to
// pipeline.js so a harness can replace one stage with an oracle. The product build is not touched;
// the hooks are inert unless globalThis.__diag defines them.
//
//   route(query, decision)          -> decision          (oracle route)
//   sql(query, pool)                -> sql branch | null (oracle SQL rows)
//   vector(pool, embedder, q, k)    -> VectorResult      (oracle documents)
//   graph(pool, q, k, decision)     -> GraphLaneResult   (oracle edges)
//
// Run after `npm run build` in air-server: node eval/diag/patch-dist.mjs
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const dist = join(root, "air-server", "dist");
const out = join(dist, "_diag");
mkdirSync(out, { recursive: true });
for (const f of readdirSync(dist)) if (f.endsWith(".js")) copyFileSync(join(dist, f), join(out, f));

const file = join(out, "pipeline.js");
let src = readFileSync(file, "utf8");
const swaps = [
  [
    "const decision = await routeQuery(query, embedder);",
    "let decision = await routeQuery(query, embedder);\n    if (globalThis.__diag?.route) decision = globalThis.__diag.route(query, decision);",
  ],
  [
    "        if (!wantSql)\n            return { text: null };",
    "        if (!wantSql)\n            return { text: null };\n        if (globalThis.__diag?.sql) { const o = await globalThis.__diag.sql(query, pool); if (o) return o; }",
  ],
  [
    "? vectorSearch(pool, embedder, query, k)",
    "? (globalThis.__diag?.vector ? globalThis.__diag.vector(pool, embedder, query, k) : vectorSearch(pool, embedder, query, k))",
  ],
  [
    "? graphLane(pool, query, k, 2, kgSchema(), decision.graphPlan)",
    "? (globalThis.__diag?.graph ? globalThis.__diag.graph(pool, query, k, decision) : graphLane(pool, query, k, 2, kgSchema(), decision.graphPlan))",
  ],
];
for (const [from, to] of swaps) {
  const n = src.split(from).length - 1;
  if (n !== 1) throw new Error(`patch point found ${n} times: ${from.slice(0, 60)}`);
  src = src.replace(from, to);
}
writeFileSync(file, src);
console.log(`patched ${file} (${swaps.length} hooks)`);

// Sampling hook for the self-consistency experiment (eval/diag/sql-models.mjs --sc N): generation options can be
// overridden per call through globalThis.__diag.gen. Without it generation stays temperature 0, seed 42.
const llmFile = join(out, "llm.js");
let llm = readFileSync(llmFile, "utf8");
for (const [from, to] of [
  ["temperature: opts.temperature ?? 0,", "temperature: globalThis.__diag?.gen?.temperature ?? opts.temperature ?? 0,"],
  ["seed: opts.seed ?? 42,", "seed: globalThis.__diag?.gen?.seed ?? opts.seed ?? 42,"],
  // Candidate models that reason before answering even with think=false (Kwai-AutoSQL-14B) print a trace and
  // `</think>` ahead of the SQL. DIAG_STRIP_THINK=1 keeps only the text after the last `</think>`, as a swap would have to.
  [
    'return (json.response ?? "").trim();',
    'const text = (json.response ?? "").trim(); return process.env.DIAG_STRIP_THINK === "1" && text.includes("</think>") ? text.slice(text.lastIndexOf("</think>") + 8).trim() : text;',
  ],
]) {
  if (llm.split(from).length !== 2) throw new Error(`llm.js patch point: ${from}`);
  llm = llm.replace(from, to);
}
writeFileSync(llmFile, llm);
console.log(`patched ${llmFile} (sampling hook)`);
