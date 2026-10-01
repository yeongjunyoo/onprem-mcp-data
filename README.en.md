# onprem-mcp-data

[![CI](https://github.com/yeongjunyoo/onprem-mcp-data/actions/workflows/ci.yml/badge.svg)](https://github.com/yeongjunyoo/onprem-mcp-data/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-8%20tools-informational)](docs/architecture.md)
[![Model](https://img.shields.io/badge/LLM-qwen2.5--coder%3A7b%20(local)-success)](docs/model-cards/qwen2.5-coder-7b.md)

**An on-premise MCP server that answers natural-language questions over your own database, with citations.** One question is routed into three lanes at once (vector search, NL2SQL, knowledge graph), the results are fused, and a local 7B model answers from the curated context only. **No external API calls.** Every model runs locally through Ollama.

Korean documentation, including the full engineering report, is the primary reference: [README.md](README.md).

## Why it exists

Company data usually cannot leave the network, yet document search, SQL analytics and relationship lookups live in different systems. This project puts all three behind a single MCP server so that any MCP client gets one tool surface, and keeps every model on-prem so the data never leaves.

## Quick start

```bash
git clone https://github.com/yeongjunyoo/onprem-mcp-data.git && cd onprem-mcp-data
docker compose up -d                                     # PostgreSQL 16 + pgvector, Ollama
docker compose exec ollama ollama pull qwen2.5-coder:7b
docker compose exec ollama ollama pull bge-m3

cd air-server && npm ci && npx tsc
export OLLAMA_HOST=http://localhost:11435                # containerised Ollama
npm run gen:bench && npm run embed:bench:ollama          # deterministic seed data
npm run demo:ollama                                      # offline end-to-end demo
```

> **Why port 11435.** Publishing the container's Ollama on 11434 collides with a
> host-installed Ollama, and Docker then **silently gives up on the publication**
> (`PublishedPort: 0`). The container still reports `running`, and the app attaches to
> the host daemon instead — whatever models it happens to hold. Splitting the port keeps
> the binding explicit. To use a host Ollama instead, set `OLLAMA_HOST=http://localhost:11434`.
>
> **For the functional test on the sponsor dataset**, follow the pre-demo checklist in
> [docs/demo-script.md](docs/demo-script.md): `docker compose up -d` verifies the model cache
> (pulling only what is missing), `npm run warmup` pays the cold start up front,
> `npm run companyx:score` grades the final answers to the 30 example questions, and
> `npm run fault:demo` shows failures ending as states rather than exceptions.
>
> Both the server and the demo print the Ollama endpoint they actually reached and its
> model list on startup, and refuse to run when a required model is missing.

The server exposes **8 MCP tools**: `route`, `sql.query`, `vector.search`, `retrieve`, `ask`, `audit.explain`, `ontology.search`, `graph.expand`. Three-way knowledge-graph retrieval (`kgRetrieve`) runs inside `retrieve` and `ask` rather than being exposed as its own tool.

The MCP surface is **8 tools, 6 resources, 4 prompts**. Resources let a host read the schema
card, dataset manifest, evaluation index, active profile, audit-record schema and evidence
list **without calling a tool**. Prompts expose the exact grounded-answer and NL2SQL templates
the server itself runs — not a paraphrase; a unit test asserts full-text equality with the
runtime builders. All three surfaces are exercised over the wire, not just enumerated:
To attach an MCP client, run the server over stdio. `MCP_TRANSPORT=sse` switches the transport.

Paste this into your client config (e.g. Claude Desktop's `claude_desktop_config.json`),
replacing `<repo>` with the actual path.

```json
{
  "mcpServers": {
    "onprem-mcp-data": {
      "command": "node",
      "args": ["<repo>/air-server/dist/index.js"],
      "env": {
        "DATABASE_URL": "postgresql://postgres:postgres@localhost:5433/mcpdata",
        "OLLAMA_HOST": "http://localhost:11435",
        "EMBEDDER": "ollama",
        "OLLAMA_MODEL": "qwen2.5-coder:7b",
        "EMBED_MODEL": "bge-m3",
        "DATASET": "companyx"
      }
    }
  }
}
```

Drop `DATASET` to start on the bench seed. We ran this exact config through the stdio
handshake and confirmed `serverInfo` `onprem-mcp-data 0.2.0` plus all 8 tools listed —
it is not a config we wrote down without running.

`node scripts/verify-stdio-tools.mjs` calls every tool, fetches every prompt and reads every
resource over stdio, and `node scripts/verify-sse-transport.mjs` does the handshake over SSE.

`npm run demo:ollama` runs without network access and walks through tool calls, three-lane agreement, a local 7B answer, and fault injection.

## How it works

1. **Rule-first router, no generative LLM call.** Query vocabulary is scored per tool against the schema and the graph ontology. If the top tool leads the runner-up by 2.5 or more, the rules decide; otherwise the question is embedded with bge-m3 and sent to the tool of the nearest of 175 question-type anchors (semantic fallback). The only tuned values are those two margins, fixed by a boundary measurement on 150 development questions (`npm run companyx:boundary`). Same embedding model, same decision; without an embedding model the rules run alone.
2. **Parallel retrieval.** NL2SQL runs behind a read-only guard (privilege-downgraded role, statement and lock timeouts, no multi-statement); vector search uses pgvector cosine; the graph lane walks relations with bidirectional BFS, bounded by hop, node and edge caps that report `truncated` instead of cutting silently.
3. **Reciprocal rank fusion**, with one credit per key per list, ranked among distinct keys, so that a repeated graph hub can neither outvote cross-source agreement nor push the rest of its list down.
4. **Structure-preserving curation.** Tables stay tables, relations stay relation sentences.
5. **Grounded generation.** The local model may only use the curated context. If the entity in the question cannot be resolved, the context is emptied and the answer says "not found" and why, without calling the model: `not_found.reason` is `not_in_database` or `similar_name_mismatch` (a similarly named entity exists but is not assumed to be the same one).

## Measured results

Raw outputs live in `eval/results/`. **No self-built LLM judge is used for scoring**: the oracle is the database execution result or a gold set.

| Metric | Result | Sample and conditions |
| --- | --- | --- |
| Routing tool match | 30/30 | 30 published example questions, identical across 20 re-runs, **in-sample** |  <!--metric:route_insample-->
| **Routing generalisation (holdout 4, sealed)** | **54/60 = 0.900** (rules only 0.750) | coverage 0.917, true misses 5. 60 questions by an independent author who never saw the router or earlier misses; sealed after the second fix, scored once. McNemar p = 0.022 vs rules only |  <!--metric:holdout4_strict-->
| Routing (holdout 3, sealed, scored once) | **46/60 = 0.767** (rules only 0.550) | sealed before the first fix; used for error analysis afterwards, so now a development set |  <!--metric:holdout3_sealed_strict-->
| Routing (holdout 1, development) | **1.000 (30/30)**, rules only 0.900 | coverage 1.000. Used for diagnosis, so no longer held out |  <!--metric:holdout1_strict-->
| Routing (holdout 2, colloquial, development) | **29/30 = 0.967** (rules only 0.633) | coverage 0.967, true misses 1. Used for diagnosis, so no longer held out |  <!--metric:holdout2_strict-->
| NL2SQL execution match | **7/10** (1/10 without the schema card) | no retry, n=10; identical within a session, shifts by 1-2 questions across sessions |
| **External calibration (BIRD Mini-Dev, full 500)** | official set equality **240/500 = 0.480**, operational multiset 216/500 = 0.432 (re-measured 2026-09-30) | all 11 DBs, difficulty 148/250/102 (official mix); zero sampling error. **A different, harder cross-domain dataset — not comparable with the internal rows above.** 2 gold queries exceed the 30s budget and are unscorable |
| NL2SQL with one repair pass | **7/10** (5/10 without the schema card) | failed SQL fed back with the database catalogue; **0 vs 7 repairs** (`qwen2.5-coder:7b`, 2026-08-19; `qwen2.5:7b` gave 7-8/10 vs 7/10 with 2 vs 6 repairs) |
| Knowledge-graph recall | 1.000 (0.278 before four fixes) | 10 questions |  <!--metric:kg_recall-->
| Vector hit@5 | **0.986 (73/74)** | 74 questions, including 3 sponsor questions restored to the gold set; hash fallback 0.775, English-only 768 model 0.380 |  <!--metric:vector_hit5-->
| End-to-end evidence in context | **18/19 = 94.7%** | 19 scorable of 30, after restoring 3 sponsor vector questions to the gold set |  <!--metric:ask_evidence--> <!--metric:ask_evidence_pct-->
| Grounding violations | **0** — 18/18 answers grounded (100%) | every dataset entity named in an answer also appears in the curated context | measured |  <!--metric:ask_grounded_pct-->
| **Multi-step task completion** | **5/6 = 0.833**, 14/15 steps passed | six tasks chaining entity resolution -> relation walk -> aggregation | measured |  <!--metric:multistep-->
| Median latency | **15746 ms** | `docker compose` Ollama (CPU, no GPU passthrough), 30 questions end to end; repeated runs vary 9.8-18.5 s. On a GPU-backed host Ollama the same code runs at **685 ms** (`qwen2.5-coder:7b`; the older `qwen2.5:7b` measured 864 ms on the same host — different model and session, so this is not an improvement or a regression claim) (raw: `eval/results/companyx-ask-host-gpu.json`) |  <!--metric:ask_median_ms--> <!--metric-ok-->
| Median latency (host GPU) | **685 ms** | same 30 questions against a GPU-backed host Ollama. Raw: `eval/results/companyx-ask-host-gpu.json` |  <!--metric:ask_median_ms_host-->
| Tests | **692 assertions passing** | 555 offline + 137 requiring database and models. Without the sponsor dataset (as in CI) the offline count is 535, since 20 offline checks read the dataset files (11 ontology coverage, 1 edge-type anchor, 8 sealed-holdout scorer checks). CI recounts from runner output. Raw tally in `eval/results/test-counts.json` |  <!--metric:test_total-->
| Fault injection — no crash | **4/4** | DB stop, latency, partial failure. Raw: `eval/results/faults.json` |  <!--metric:faults_nocrash-->
| Fault injection — partial context | **4/4** | killing the vector branch still returns graph context |  <!--metric:faults_partial-->
| Fault injection — error visible | **4/4** | failed branches are recorded in `branch_errors` |  <!--metric:faults_errvis-->
| Dependency licences | 110 packages, all permissive, 0 copyleft | generated by `node scripts/sbom.mjs` |  <!--metric:dep_packages-->

## What we disproved about our own work

- **That conclusion was model-dependent — corrected 2026-08-19.** With `qwen2.5:7b` the schema card bought cost, not accuracy, once a repair pass existed. After switching generation to `qwen2.5-coder:7b` and re-measuring, the gap **does not close**: without retry it is **7/10 versus 1/10** (both arms re-run five times, identical every time), and with one execution-feedback retry it is **7/10 versus 5/10**, while the repair count splits **0 versus 7**. On this model the schema card buys accuracy as well as cost. The earlier statement was not wrong for that model; what was missing was **saying which model it held for**.
- **Truncating the embedding was not an officially supported mode, but we measured the cost.** The sponsor schema fixes `vector(768)`, so we stored the first 768 of bge-m3's 1024 dimensions, and the model card only documents 1024 dense dimensions without claiming Matryoshka training. We expanded the evaluation from 8 to 68 questions and compared head to head: **native 1024 and truncated 768 both score 67/68 and miss one different question each (McNemar p = 1.0)**. On this corpus the truncation costs nothing measurable, yet it is still not a guaranteed output mode, so we do not present it as a feature. An English-only 768 model scored 25/68 on the same Korean questions.
- **30/30 routing is in-sample, and generalisation is only measured on sealed held-out sets.** During the mentoring period (September 2026) we added a confidence gate and a semantic fallback. Before each fix, a different model that had never seen the router wrote 60 questions, which we committed (sealed) and scored exactly once after the fix: **On holdout 3, 0.767 after the first fix (rules only 0.550); on holdout 4, 0.900 after the second (rules only 0.750).** The six holdout-4 misses are listed in `docs/report.md` §0.15. A set used for error analysis stops being held out, so the current values on holdouts 1, 2 and 3 (1.000, 0.967, 0.933) are not generalisation numbers.

## Limits

- **Community metrics are zero.** 0 stars, 0 forks, and **0 pull requests from outside contributors**. The repository ships issue templates, a contributing guide, good-first-issues and Discussions, and its community profile health is 100% — but **nothing has actually come in from outside yet.** Every PR so far is either ours or **Dependabot**; **zero were opened by an outside person**.
- **The external benchmark scores far below the internal one.**
  - internal execution-match **88/100** over 100 questions
  - official set equality **240/500 = 0.480** over all 500 BIRD Mini-Dev questions
  - The datasets and domains differ so the two are not directly comparable, but read it as this: **the internal number is not this system's general ability.** We wrote the internal questions; somebody else wrote BIRD.
Vector evaluation now uses **74 questions** covering all 40 documents, 30 of which never repeat the gold keywords; 71 are scored by hit@5 and the rest carry a document-type hint only, so they are scored on type accuracy. The 7B model still makes real interpretation errors, listed openly in the engineering report. Automatic failover is out of scope; replica read fallback with a kill drill is what is verified. CI runs offline unit tests and **twenty checks** (the subset of the 30 in the checks table that needs no dataset, database or model — metrics, metric prose, test counts, evidence manifest, tool surface, external API, silent fallbacks, dataset redistribution, line endings, table integrity, demo script, doc links, contribution entry, audit contract, NOTICE attribution, dependabot config, SBOM drift). Database and model suites run locally and their raw output is committed — we do not mark them as running in CI. The integration suites (137 assertions) cannot be reproduced by CI but they are not unverified: 137/137 measured on 2026-09-30, recorded in `eval/results/test-counts.json`.

## Docs

- [Engineering report (Korean)](docs/report.md) with the evidence manifest
- [Architecture](docs/architecture.md), [model cards](docs/model-cards/), [SBOM](docs/sbom.md), [AI model spec](docs/ai-model-spec.md)
- [Contributing](CONTRIBUTING.md), [Security policy](SECURITY.md), [Code of conduct](CODE_OF_CONDUCT.md)

## Licence

Apache License 2.0 for the code. Bundled models are open-weight and run locally: qwen2.5-coder:7b (Apache-2.0) and bge-m3 (MIT). Third-party components are listed in [NOTICE](NOTICE) and `docs/sbom.md`.
