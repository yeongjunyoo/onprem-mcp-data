// Stage-by-stage trace of the final answer, with optional oracle stages.
//
// Runs the same ask() the MCP `ask` tool runs (default budget, read pool, 7B NL2SQL and answer),
// scores the answer with the scorecard's own judge, and records for each question what every stage
// produced: route, generated and executed SQL, whether the SQL rows contain the gold values, which
// documents the vector lane returned and which survived curation, which gold edges the graph lane
// found and kept, and whether the 7B prose alone (without the appended SQL rows block) is right.
// No context or document text is written out (dataset licence); only ids, SQL, counts and answers.
//
// Modes (each oracle also forces the expected route for the lane it replaces):
//   trace         no override
//   oracle-route  route forced to the expected lane when the router chose another
//   oracle-sql    nl2sql questions: the gold SQL and its rows replace NL2SQL
//   oracle-docs   vector questions: vector search restricted to the gold document(s)
//   oracle-chunks vector questions with gold keywords: the chunks that contain them first, then gold-doc chunks
//   oracle-edges  graph questions: the gold edges replace the graph lane
//   oracle-wholedoc vector questions: every chunk of the gold document(s) in document order (analyst gold for s30-13:
//                 DOC-007, the only Kubernetes incident report; the scorer's gold there is the whole document type)
//
// Usage (from the repo root, after npm run build in air-server and node eval/diag/patch-dist.mjs):
//   DATASET=companyx EMBEDDER=ollama DATABASE_URL=postgresql://postgres:postgres@localhost:5433/mcpdata_diag \
//   OLLAMA_HOST=http://127.0.0.1:11434 node eval/diag/answer-stages.mjs --set holdout4 --mode trace [--only h4-01,h4-02] [--lane nl2sql] --out <file>
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const arg = (n, d) => {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1] : d;
};
const SET = arg("--set", "sponsor30");
const MODE = arg("--mode", "trace");
const ONLY = (arg("--only", "") || "").split(",").map((s) => s.trim()).filter(Boolean);
const LANE = arg("--lane", "");
const OUT = arg("--out", join(root, ".scratch", "diag", `${SET}-${MODE}.json`));

if (!/mcpdata_diag/.test(process.env.DATABASE_URL ?? "")) throw new Error("DATABASE_URL must point at mcpdata_diag");
if (process.env.READ_DATABASE_URL) throw new Error("READ_DATABASE_URL must be unset");
if (!/^http:\/\/(127\.0\.0\.1|localhost):11434\/?$/.test(process.env.OLLAMA_HOST ?? "")) throw new Error("OLLAMA_HOST must be the host Ollama on 11434");
if (process.env.DATASET !== "companyx" || process.env.EMBEDDER !== "ollama") throw new Error("DATASET=companyx EMBEDDER=ollama required");

const D = (m) => import(pathToFileURL(join(root, "air-server", "dist", "_diag", m)).href);
const sc = await D("scorecard.js");
const cx = await D("companyx.js");
const { getPool, getReadPool } = await D("db.js");
const { getEmbedder, toVectorLiteral } = await D("embedder.js");
const { initRouting } = await D("routerinit.js");
const { ask, sqlRowsBlock, graphLane } = await D("pipeline.js");
const { answer: llmAnswer } = await D("llm.js");
const { profile } = await D("profile.js");
const { sqlQuery } = await D("sql.js");
const { resultsMatch } = await D("evalmatch.js");
const { relLabel, kgSchema } = await D("graph.js");
const { vectorSearch } = await D("vector.js");
const router = await D("router.js");

const TOOLS_OF = {
  nl2sql: { route: "structured", tools: [router.SQL_TOOL] },
  vector_search: { route: "semantic", tools: [router.VECTOR_TOOL] },
  knowledge_graph: { route: "graph", tools: [router.ONTOLOGY_TOOL, router.GRAPH_TOOL] },
};

// ── gold, exactly as cli/companyx-scorecard builds it ─────────────────────────
const dir = cx.datasetDir();
const { nodes, edges } = await cx.loadGraph(dir);
const cat = sc.buildCatalog(nodes);
const nodeById = new Map(nodes.map((n) => [n.id, n]));
const index = JSON.parse(await readFile(join(dir, "documents", "index.json"), "utf8"));
const docs = await Promise.all(index.map(async (e) => ({ ...e, text: await readFile(join(dir, "documents", e.filename), "utf8") })));
const docMap = new Map(docs.map((d) => [d.id, d.text]));
const pool = getPool();

async function runGold(sql) {
  const res = await pool.query(sql);
  const rows = res.rows;
  const limited = sc.isLimited(sql);
  let tied = [];
  if (limited && rows.length) {
    const cols = Object.keys(rows[0]);
    const asked = sc.askedColumns(rows, true);
    const helpers = cols.filter((c) => !asked.includes(c) && !/^id$|_id$/.test(c));
    if (helpers.length && asked.length) {
      const last = rows[rows.length - 1];
      const every = await pool.query(sc.withoutLimit(sql));
      tied = every.rows.filter((r) => helpers.every((h) => String(r[h]) === String(last[h]))).map((r) => String(r[asked[0]]));
    }
  }
  return { rows, fields: res.fields, limited, tied };
}

/** One entry per question: scorer item plus the gold the stage checks need. */
const Q = [];
if (SET === "sponsor30") {
  const all = await cx.loadQuestions(dir);
  const sqlGoldList = (await readFile(join(root, "eval/companyx/sql_gold.jsonl"), "utf8")).split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  const kgGoldList = JSON.parse(await readFile(join(root, "eval/companyx/kg_gold.json"), "utf8"));
  const vecGold = JSON.parse(await readFile(join(root, "eval/companyx/vector_gold.json"), "utf8"));
  const sqlGold = new Map();
  for (const g of sqlGoldList) {
    const r = await runGold(g.gold);
    sqlGold.set(g.q, { gold: { rows: r.rows, ordered: Boolean(g.ordered), limited: r.limited, tied: r.tied }, sql: g.gold, match: g });
  }
  const kgGold = new Map(
    kgGoldList.map((g) => {
      const ids = cx.kgGoldIds(g.spec, nodes, edges);
      return [g.q, { names: ids.map((id) => nodeById.get(id)?.name ?? id), kind: ids.length ? nodeById.get(ids[0])?.type : undefined, absent: g.spec.kind === "absent", ids, spec: g.spec }];
    }),
  );
  const HINT_TYPES = [
    [/장애\s*보고서/, "incident_report"],
    [/회의록/, "meeting_note"],
    [/제안서/, "proposal"],
    [/기술\s*문서|가이드|레퍼런스|매뉴얼/, "technical_doc"],
  ];
  const vectorGold = (item) => {
    const v = vecGold.items.find((x) => x.q === item.q);
    const pick = (ids, source) => ({ keywords: v?.keywords ?? [], docs: docs.filter((d) => ids.includes(d.id)).map((d) => ({ id: d.id, text: d.text })), source });
    if (v?.gold_docs?.length) return pick(v.gold_docs.filter((f) => f.endsWith(".md")).map((f) => f.replace(/\.md$/, "")), "vector_gold.gold_docs");
    if (v?.keywords.length) {
      const kws = v.keywords.map((k) => k.toLowerCase());
      return pick(docs.filter((d) => kws.every((k) => d.text.toLowerCase().includes(k))).map((d) => d.id), "vector_gold.keywords");
    }
    if (v?.type) return pick(docs.filter((d) => d.type === v.type).map((d) => d.id), "vector_gold.type");
    const types = HINT_TYPES.filter(([re]) => re.test(item.hint)).map(([, t]) => t);
    return pick(docs.filter((d) => types.includes(d.type)).map((d) => d.id), `questions.hint(${types.join("+") || "없음"})`);
  };
  all.forEach((item, i) => {
    const id = `s30-${String(i + 1).padStart(2, "0")}`;
    const base = { id, q: item.q, lane: item.tool };
    if (item.tool === "nl2sql") {
      const g = sqlGold.get(item.q);
      Q.push({ ...base, goldSql: g.sql, sqlGold: g.gold, matchOpts: { ordered: g.match.ordered, columnsSensitive: g.match.columnsSensitive, tupleSensitive: g.match.tupleSensitive, numericTolerance: g.match.numericTolerance, subsetColumns: g.match.subsetColumns }, dropGoldId: false, judge: (a, s) => sc.scoreSql(a, item.q, g.gold, cat, s) });
    } else if (item.tool === "knowledge_graph") {
      const g = kgGold.get(item.q);
      Q.push({ ...base, goldNames: g.names, goldEdges: null, judge: (a, s) => sc.scoreKg(a, item.q, g, cat, s) });
    } else {
      const g = vectorGold(item);
      Q.push({ ...base, goldDocs: g.docs.map((d) => d.id), goldKeywords: g.keywords, keyed: false, judge: (a, s) => sc.scoreVector(a, item.q, g, cat, s) });
    }
  });
} else {
  const file = sc.HOLDOUT_FILES[SET];
  const holdout = JSON.parse(await readFile(join(root, file), "utf8")).items;
  for (const it of holdout) {
    let sqlG;
    if (it.expected === "nl2sql") {
      const r = await runGold(cx.qualifyCompanyx(it.gold_sql));
      sqlG = sc.sqlGoldFromResult(r.rows, r.fields, { ordered: false, limited: r.limited, tied: r.tied });
    }
    const item = sc.holdoutItem(it, { docs: docMap, cat, sql: sqlG });
    const base = { id: it.id, q: it.q, lane: it.expected, unscorable: item.unscorable, judge: item.judge };
    if (it.expected === "nl2sql") {
      Q.push({ ...base, goldSql: cx.qualifyCompanyx(it.gold_sql), sqlGold: sqlG && "gold" in sqlG ? sqlG.gold : null, matchOpts: { subsetColumns: true }, dropGoldId: !/\bid\b|아이디|번호/i.test(it.q) });
    } else if (it.expected === "vector_search") {
      const keys = (it.gold_keywords ?? []).filter((k) => !sc.hasKeyword(it.q, k));
      Q.push({ ...base, goldDocs: (it.gold_docs ?? []).map((d) => d.replace(/\.md$/, "")), goldKeywords: it.gold_keywords ?? [], answerKeys: keys, keyed: Boolean(it.gold_keywords?.length) });
    } else {
      Q.push({ ...base, goldNames: it.gold_answer_names ?? [], goldEdges: it.gold_edges ?? [] });
    }
  }
}

// ── chunk → document map ───────────────────────────────────────────────────
const chunkRows = (await pool.query("SELECT c.id, c.doc_id, d.title, d.body FROM companyx.document_chunks c JOIN companyx.documents d ON d.id = c.id ORDER BY c.id")).rows;
const chunkDoc = new Map(chunkRows.map((r) => [Number(r.id), r.doc_id]));
const chunkText = new Map(chunkRows.map((r) => [Number(r.id), `${r.title}\n${r.body}`]));
const chunksOf = (docIds) => chunkRows.filter((r) => docIds.includes(r.doc_id)).map((r) => Number(r.id));

// ── oracle hooks ───────────────────────────────────────────────────────────
const byQ = new Map(Q.map((x) => [x.q, x]));
function forceRoute(q, d, lane) {
  const t = TOOLS_OF[lane];
  if (d.route === t.route && !d.docCount && !d.pair && !d.productState) return d;
  if (d.route === t.route) return d;
  const out = { ...d, route: t.route, tools: t.tools, rationale: `${d.rationale}; diag: oracle route ${lane}` };
  if (lane === "knowledge_graph") {
    out.graphPlan = d.graphPlan ?? router.buildGraphPlan(q.trim(), d.typePair?.relation ? [d.typePair.relation] : [], d.structuredHits.includes("superlative"));
  } else {
    out.graphPlan = undefined;
    delete out.pair;
  }
  if (lane !== "vector_search") delete out.docCount;
  if (lane !== "nl2sql") delete out.productState;
  return out;
}
const diag = {};
const forcedLane = { "expand-topdoc": null, "oracle-route": null, "oracle-sql": "nl2sql", "oracle-docs": "vector_search", "oracle-chunks": "vector_search", "oracle-wholedoc": "vector_search", "oracle-edges": "knowledge_graph" }[MODE];
if (MODE !== "trace" && MODE !== "expand-topdoc") {
  diag.route = (q, d) => {
    const x = byQ.get(q);
    if (!x) return d;
    if (MODE === "oracle-route" || x.lane === forcedLane) return forceRoute(q, d, x.lane);
    return d;
  };
}
if (MODE === "oracle-sql") {
  diag.sql = async (q, p) => {
    const x = byQ.get(q);
    if (!x || x.lane !== "nl2sql") return null;
    return { text: x.goldSql, result: await sqlQuery(p, x.goldSql) };
  };
}
const ANALYST_DOCS = { "s30-13": ["DOC-007"] };
// Not an oracle: a candidate structural change measured the same way. Dense top-k as today, then every chunk of the
// top hit's document in document order first, then the remaining hits from other documents.
if (MODE === "expand-topdoc") {
  diag.vector = async (p, embedder, q, k) => {
    const base = await vectorSearch(p, embedder, q, k);
    if (!base.ok || !base.hits.length) return base;
    const top = chunkDoc.get(base.hits[0].id);
    const res = await p.query(
      `SELECT d.id, d.title, d.body FROM companyx.documents d JOIN companyx.document_chunks c ON c.id = d.id WHERE c.doc_id = $1 ORDER BY c.chunk_index`,
      [top],
    );
    const own = res.rows.map((r) => ({ id: Number(r.id), title: String(r.title), body: String(r.body), score: base.hits[0].score }));
    const rest = base.hits.filter((h) => chunkDoc.get(h.id) !== top);
    return { ...base, hits: [...own, ...rest] };
  };
}
if (MODE === "oracle-wholedoc") {
  diag.vector = async (p, embedder, q, k) => {
    const x = byQ.get(q);
    if (!x || x.lane !== "vector_search" || !x.goldDocs.length) return vectorSearch(p, embedder, q, k);
    const ids = ANALYST_DOCS[x.id] ?? x.goldDocs;
    const res = await p.query(
      `SELECT d.id, d.title, d.body FROM companyx.documents d JOIN companyx.document_chunks c ON c.id = d.id WHERE c.doc_id = ANY($1) ORDER BY c.doc_id, c.chunk_index`,
      [ids],
    );
    return { ok: true, hits: res.rows.map((r) => ({ id: Number(r.id), title: String(r.title), body: String(r.body), score: 1 })), embedder: embedder.name };
  };
}
if (MODE === "oracle-docs" || MODE === "oracle-chunks") {
  diag.vector = async (p, embedder, q, k) => {
    const x = byQ.get(q);
    if (!x || x.lane !== "vector_search" || !x.goldDocs.length) return vectorSearch(p, embedder, q, k);
    const vec = toVectorLiteral(await embedder.embed(q));
    const res = await p.query(
      `SELECT d.id, d.title, d.body, 1 - (d.embedding <=> $1::vector) AS score
         FROM companyx.documents d JOIN companyx.document_chunks c ON c.id = d.id
        WHERE c.doc_id = ANY($2) AND d.embedding IS NOT NULL
        ORDER BY d.embedding <=> $1::vector, d.id`,
      [vec, x.goldDocs],
    );
    let rows = res.rows;
    if (MODE === "oracle-chunks" && x.keyed) {
      const keyChunk = (r) => x.goldKeywords.some((kw) => sc.hasKeyword(`${r.title}\n${r.body}`, kw));
      rows = [...rows.filter(keyChunk), ...rows.filter((r) => !keyChunk(r))];
    }
    return { ok: true, hits: rows.slice(0, k).map((r) => ({ id: Number(r.id), title: String(r.title), body: String(r.body), score: Number(r.score) })), embedder: embedder.name };
  };
}
if (MODE === "oracle-edges") {
  diag.graph = async (p, q, k, decision) => {
    const x = byQ.get(q);
    if (!x || x.lane !== "knowledge_graph" || !x.goldEdges?.length) return graphLane(p, q, k, 2, kgSchema(), decision.graphPlan);
    const items = x.goldEdges.map((e, i) => {
      const s = nodeById.get(e.source);
      const t = nodeById.get(e.target);
      return {
        canonicalKey: `diag:gold#${i}`,
        sourceKey: `graph#e${i}`,
        source: "graph",
        text: `[그래프] ${s.name}의 ${relLabel(e.relation)}: ${t.name} (${s.type}→${t.type}, ${e.relation})`,
        provenance: `relation:${e.relation}:gold`,
      };
    });
    return { seeds: [], edgeCount: items.length, strategy: "seeded", items };
  };
}
globalThis.__diag = diag;

// ── run ────────────────────────────────────────────────────────────────────
const embedder = getEmbedder();
await cx.assertCorpusEmbedder(pool, embedder);
const routing = await initRouting();
const baseNl2sql = profile().nl2sql;
const ROWS_BLOCK = /\n\n\[조회 결과 \d+건\][\s\S]*$/;
const cap = (s, n = 1800) => (s && s.length > n ? `${s.slice(0, n)}…(${s.length}자)` : s);
const flat = (s) => (s ?? "").replace(/\s+/g, " ").trim();
const keptIdx = (r, prefix) => r.curated.kept.filter((it) => it.source.startsWith(prefix)).map((it) => it.source.slice(prefix.length));
const strip = ({ id: _id, ...rest }) => rest;

let todo = Q.filter((x) => (!ONLY.length || ONLY.includes(x.id)) && (!LANE || x.lane === LANE));
if (MODE === "oracle-sql") todo = todo.filter((x) => x.lane === "nl2sql");
if (MODE === "expand-topdoc") todo = todo.filter((x) => x.lane === "vector_search");
if (MODE === "oracle-docs" || MODE === "oracle-chunks" || MODE === "oracle-wholedoc") todo = todo.filter((x) => x.lane === "vector_search" && (MODE !== "oracle-chunks" || x.keyed));
if (MODE === "oracle-edges") todo = todo.filter((x) => x.lane === "knowledge_graph" && x.goldEdges?.length);

/** What a context verifier would flag in the prose: numbers with a unit or three or more digits, and
 * catalog names, that appear neither in the context nor in the question. Counts of context items are
 * allowed (the prose may count rows). Approximate by design — it estimates how often a verifier fires. */
const UNIT_NUM = /(?<![A-Za-z0-9_.-])(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?\s*(조|억|천만|백만|만|천|원|%|건|명|일|시간|분|개월|주|년|개|곳|회|GB|MB|ms|초)?/g;
function verifyProse(prose, context, question, keptCount, rowCount) {
  const nums = [];
  for (const m of prose.matchAll(UNIT_NUM)) {
    const raw = m[0].trim();
    const digits = m[1].replace(/,/g, "");
    const unit = m[3];
    if (!unit && digits.length < 3 && !m[2]) continue; // list ordinals and small bare numbers
    if (/^(19|20)\d\d$/.test(digits) && (unit === "년" || !unit)) continue; // years are dates, checked elsewhere
    const value = Number(digits + (m[2] ? `.${m[2]}` : ""));
    if (unit && ["건", "명", "개", "곳"].includes(unit) && (value === keptCount || value === rowCount)) continue;
    const plain = `${digits}${m[2] ? `.${m[2]}` : ""}`;
    if (sc.hasNumber(context, plain) || sc.hasNumber(question, plain) || context.includes(raw) || question.includes(raw)) continue;
    nums.push(raw);
  }
  const names = [];
  for (const kind of ["client", "product", "employee", "department", "project"]) {
    for (const n of sc.mentionsOfKind(prose, kind, cat)) if (!sc.hasText(context, n) && !sc.hasText(question, n)) names.push(n);
  }
  return { nums: [...new Set(nums)].slice(0, 12), names: [...new Set(names)].slice(0, 12) };
}

const out = [];
for (const x of todo) {
  const tr = { generated: null, llm: null, llmCalls: 0 };
  const nl2sql = async (q, report) => {
    const s = await baseNl2sql(q, report);
    tr.generated = s;
    tr.refused = report?.refused;
    return s;
  };
  const llm = async (q, ctx) => {
    tr.llmCalls++;
    tr.llmQuery = q;
    const o = await llmAnswer(q, ctx);
    tr.llm = o;
    return o;
  };
  const t0 = Date.now();
  const r = await ask(x.q, { pool: getReadPool(), embedder, nl2sql, llm });
  const ms = Date.now() - t0;
  const state = sc.answerState(r);
  const v = x.judge(r.answer, state);
  const prose = r.answer.replace(ROWS_BLOCK, "");
  const vp = x.judge(prose, state);
  const row = {
    id: x.id,
    q: x.q,
    lane: x.lane,
    mode: MODE,
    unscorable: x.unscorable ?? null,
    routed: r.route,
    route_ok: sc.LANE_ROUTE[x.lane] === r.route,
    route_rationale: r.audit.route?.rationale ?? null,
    lanes_run: { sql: r.sql.text !== null || Boolean(r.sql.result) || Boolean(r.sql.gate) || Boolean(r.sql.refused) || Boolean(r.sql.absent), vector: Boolean(r.vector), graph: Boolean(r.graph), documents: Boolean(r.documents), pair: Boolean(r.pair) },
    state,
    correct: v.correct,
    reason: v.reason,
    required: v.required,
    missing: v.missing,
    extra: v.extra,
    prose_correct: vp.correct,
    prose_reason: vp.reason,
    answer_path: tr.llmCalls ? "llm" : "deterministic",
    grounding_fix: r.grounding_fix ?? null,
    verify: verifyProse(prose, r.context, x.q, r.curated.kept.length, r.sql.result?.ok ? r.sql.result.rows.length : -1),
    curate: { kept: r.curated.kept.length, dropped: r.curated.dropped.length, tokens: r.curated.tokensUsed, budget: r.curated.budget },
    ms,
    answer: cap(flat(r.answer)),
    llm_raw: tr.llmCalls ? cap(flat(tr.llm)) : null,
  };
  // SQL lane
  if (row.lanes_run.sql || x.lane === "nl2sql") {
    const res = r.sql.result;
    const rows = res?.ok ? res.rows : [];
    const kept = new Set(keptIdx(r, "sql#").map(Number));
    const keptRows = rows.filter((_, i) => kept.has(i));
    const s = {
      generated: tr.generated ?? null,
      executed: r.sql.text,
      rewritten: r.sql.gate?.rewritten ?? null,
      gate: r.sql.gate ? { outcome: r.sql.gate.outcome, rejected: r.sql.gate.rejected?.map((g) => g.rule ?? g) ?? [], vague: r.sql.gate.vague ?? null } : null,
      repaired: Boolean(r.sql.repaired),
      refused: r.sql.refused ?? tr.refused ?? null,
      absent: r.sql.absent ?? null,
      ok: res ? res.ok : null,
      error: res?.ok === false ? res.error : null,
      rows: rows.length,
      rows_kept: keptRows.length,
    };
    if (x.lane === "nl2sql" && x.sqlGold !== undefined) {
      const g0 = await sqlQuery(pool, x.goldSql);
      const g = x.dropGoldId ? g0.rows.map(strip) : g0.rows;
      s.gold_rows = g.length;
      s.ex_match = res?.ok && g0.ok ? resultsMatch(rows, g, x.matchOpts) : false;
      if (x.sqlGold) {
        const all = rows.length ? x.judge(sqlRowsBlock(rows, rows.length, 1e9), "ok") : { correct: false, reason: "no rows", missing: [] };
        const ctx = keptRows.length ? x.judge(sqlRowsBlock(keptRows, keptRows.length, 1e9), "ok") : { correct: false, reason: "no rows in context", missing: [] };
        s.rows_have_answer = all.correct;
        s.rows_reason = all.reason;
        s.ctx_rows_have_answer = ctx.correct;
        s.ctx_rows_reason = ctx.reason;
      }
    }
    row.sql = s;
  }
  // vector lane
  if (row.lanes_run.vector || x.lane === "vector_search") {
    const hits = r.vector?.ok ? r.vector.hits : [];
    const keptChunks = keptIdx(r, "documents#").map(Number).filter((n) => Number.isFinite(n));
    const vv = {
      hits: hits.map((h) => `${chunkDoc.get(h.id)}#${h.id}`),
      ctx: keptChunks.map((id) => `${chunkDoc.get(id)}#${id}`),
      error: r.vector && !r.vector.ok ? r.vector.error : null,
      documents_count: r.documents ? { total: r.documents.total, titles: r.documents.titles.length } : null,
    };
    if (x.lane === "vector_search") {
      const gold = x.goldDocs ?? [];
      const rank = hits.findIndex((h) => gold.includes(chunkDoc.get(h.id)));
      vv.gold_docs = gold;
      vv.gold_rank = rank >= 0 ? rank + 1 : null;
      vv.gold_in_ctx = keptChunks.some((id) => gold.includes(chunkDoc.get(id)));
      if (x.keyed) {
        const goldChunks = chunksOf(gold);
        const per = x.goldKeywords.map((kw) => {
          const holders = goldChunks.filter((id) => sc.hasKeyword(chunkText.get(id), kw));
          return { kw, chunks: holders, in_hits: holders.some((id) => hits.some((h) => h.id === id)), in_ctx: holders.some((id) => keptChunks.includes(id)) };
        });
        vv.keywords = per;
        vv.key_chunks_in_hits = per.every((p) => p.in_hits);
        vv.key_chunks_in_ctx = per.every((p) => p.in_ctx);
      }
    }
    row.vector = vv;
  }
  // graph lane
  if (row.lanes_run.graph || x.lane === "knowledge_graph") {
    const items = r.graph?.items ?? [];
    const keptTexts = r.curated.kept.filter((it) => it.source.startsWith("graph#")).map((it) => it.text);
    const allTexts = items.map((it) => it.text);
    const gg = { strategy: r.graph?.strategy ?? null, seeds: (r.graph?.seeds ?? []).map((s) => s.canonicalName), items: items.length, items_kept: keptTexts.length, not_found: r.not_found ? r.not_found.reason ?? true : null, truncated: r.graph?.truncated ?? null };
    if (x.lane === "knowledge_graph" && x.goldNames) {
      gg.gold_names = x.goldNames;
      gg.names_in_items = x.goldNames.filter((n) => allTexts.some((t) => sc.hasText(t, n))).length;
      gg.names_in_ctx = x.goldNames.filter((n) => sc.hasText(r.context, n)).length;
      if (x.goldEdges?.length) {
        const has = (texts, e) => {
          const s = nodeById.get(e.source)?.name;
          const t = nodeById.get(e.target)?.name;
          return texts.some((tx) => sc.hasText(tx, s) && sc.hasText(tx, t));
        };
        gg.gold_edges = x.goldEdges.length;
        gg.edges_in_items = x.goldEdges.filter((e) => has(allTexts, e)).length;
        gg.edges_in_ctx = x.goldEdges.filter((e) => has(keptTexts, e)).length;
      }
    }
    row.graph = gg;
  }
  out.push(row);
  const mark = row.unscorable ? "-" : row.correct ? "O" : "X";
  console.log(`${mark} ${x.id} ${x.lane}→${r.route} ${row.answer_path} ${ms}ms ${row.reason ?? ""}`);
}
await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify({ set: SET, mode: MODE, routing, model: process.env.OLLAMA_MODEL ?? "qwen2.5-coder:7b", generated_at: new Date().toISOString(), rows: out }, null, 2) + "\n");
const scored = out.filter((r) => !r.unscorable);
console.log(`\n${SET} ${MODE}: ${scored.filter((r) => r.correct).length}/${scored.length} scorable correct (${out.length} run) → ${OUT}`);
await pool.end();
process.exit(0);
