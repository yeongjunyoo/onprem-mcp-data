# Final-answer diagnosis by pipeline stage (dev sets, main c7c1083, 2026-10-11)

Diagnosis and recommendation only. No product code was changed. Per-question data: `answer-diagnosis-2026-10-11.json` next to this file. Harness: `eval/diag/` (section 8).

## 0. Bottom line

- **Half of the dev misses are not misses.** Of the 40 scorable wrong answers on record (sponsor30 3, holdout3 7, holdout4 30), 21 are right answers the scorer cannot see: number stated with a different label than the gold sentence fragment (9), gold columns or keywords the question does not ask for (9), gold values the question already states (1), a sort-key rule that only recognises `LIMIT` (1), and one wrong gold (h4-59, the dataset has 13 issue reporters, the gold lists 10).
- **The 26 real failures are spread evenly across stages:** NL2SQL 7, retrieval 7, answer step 7, route 5, curation 0. No single stage dominates.
- **Ceilings (real answers, 150 dev questions, baseline 124 right):** perfect route +5, perfect NL2SQL +6 (−1 regression), perfect evidence (whole gold document, gold edges only) +10, answer step residue +4 at most. Curation never caused a first failure at the 1024 budget.
- **The answer-rendering stage is not where SQL answers fail.** In all 32 SQL answers whose context rows held the answer, the final answer was right (the appended rows block carries the values). The 7B prose alone was right in 26. The slip fixers fired 3 times in 440 dev answers. A context verifier would have flagged 5 of 141 7B answers, one of them wrong.
- **NL2SQL levers measured flat on the fixed subset (dev30, coder 22/30):** self-consistency (greedy + 4 samples, vote by result set) 23 (the +1 is run-to-run noise), qwen3.5:9b 21, Kwai-AutoSQL-14B (September, BIRD-listed) 18, NeoHorse-1-9B (September) 22. None clears the +3 swap rule. NeoHorse is +3 on holdout4 SQL, but three of its four gains come from projecting columns the golds over-ask for.
- **Recommended order:** fix the scorer first (+12 strict on dev, no screen change), then the change with the biggest product ceiling: **assemble context by evidence unit** (whole document section for single-document questions, the complete edge set of the planned relation for graph questions), then an empty-evidence route fallback (+4, small).

## 1. Setup and reproduction

- Clean worktree `C:/Users/basqu/Projects/onprem-wt-diag` at c7c1083 (detached), real `npm ci`, `tsc`. Dataset zip copied from the doctype worktree, SHA-256 `3008476738d9…` checked against `datasets/MANIFEST.md`.
- Database `mcpdata_diag` only (every pool, `READ_DATABASE_URL` unset); host Ollama 0.40.2 on 11434 with `qwen2.5-coder:7b` and `bge-m3`. Container Ollama not used.
- Misses of record: the 2026-10-11 scorecards `companyx-doctype-score-{sponsor30,holdout3,holdout4}-off.json` (DOC_TYPE_FILTER off, same behaviour as main): 27/30, 31/38, 29/59 = **87/127 scorable**, 63 rows wrong, abstained or unscorable.
- Traces: `ask()` exactly as the MCP tool calls it, with four inert hooks in a patched copy of `dist/` (`eval/diag/patch-dist.mjs`) and the scorecard's own judge. Two full reruns gave 27/32/29 both times. The only verdict change against the record is h3-13 (the 10-11 run generated a join on a missing column, both reruns generated a correct query). Answer text was identical for 138 of 150 questions against the record and for 137 of 150 between my two reruns, and generated SQL differed in 2 sponsor questions between reruns (same verdicts). Temperature 0 and seed 42 are not bit-reproducible on this host: treat ±1 per set as noise, which matters for a +3 swap rule.

## 2. Stage attribution

Rule: each miss goes to the earliest stage whose failure explains it. A wrong route counts only if the expected lane did not run or another lane's evidence changed the answer (h4-06 went hybrid, its SQL lane still returned the right client, the miss is the scorer's). “Analyst” means a human read of the answer against the gold `basis`, the gold SQL rows and the dataset files, not the scorer.

### 2.1 Earliest failing stage, all 63 rows of record

| Stage | sponsor30 | holdout3 | holdout4 | All | scorable | real failure |
|---|---:|---:|---:|---:|---:|---:|
| Route | 0 | 1 | 4 | 5 | 4 | 5 |
| NL2SQL (generation, gates, repair) | 1 | 4 | 2 | 7 | 7 | 7 |
| Retrieval (vector document/chunk, graph edges) | 1 | 5 | 1 | 7 | 3 | 7 |
| Curation | 0 | 0 | 0 | 0 | 0 | 0 |
| Answer step (7B or deterministic text) | 1 | 2 | 4 | 7 | 5 | 7 |
| Scoring artifact (answer is right) | 0 | 1 | 20 | 21 | 21 | 0 |
| Unscorable, answer right | 0 | 16 | 0 | 16 | 0 | 0 |
| **Total** | **3** | **29** | **31** | **63** | **40** | **26** |

By lane, the 26 real failures: SQL questions 10 (NL2SQL 7, route 2, answer 1), vector 10 (retrieval 4, route 3, answer 3), graph 6 (retrieval 3, answer 3).

### 2.2 How far each lane gets (rerun traces, all 150 questions)

| Lane | Route right | Evidence retrieved | Evidence in context | Final right given evidence in context |
|---|---|---|---|---|
| SQL (50) | 45 (h4-06 hybrid still ran SQL) | rows hold every asked value: 32 of 49 scorable; EX 32/50 | 32 of 32 (no SQL row dropped; largest result 15 rows) | 32/32 with rows block; prose alone 26/32 |
| Vector (50) | 47 | gold document in top 5: 47 of 47 routed (45 at rank 1); holdout4 answer chunk 18/18 | same as retrieved (5 chunks always fit) | holdout4: 16 of 17 by analyst (h4-39 wrong); strict scorer 2 |
| Graph (50) | 48 (both misroutes still right) | all gold names in lane output: 47 of 49 scorable | same | 43/47 (h3-59, h4-46, h4-60 answer step; h4-59 gold error) |

Curation dropped items in only two questions, both graph and both answered right (h3-53 hybrid: 27 of 51 items; h3-57: 2 of 16).

Document-level retrieval is effectively perfect when routed right. The vector misses are below the document: the install procedure is four tiny step chunks (`1단계`…`4단계`, 43 to 87 characters each), so top-5 never holds all steps (h3-21, h3-22), and the cause section of the right report can lose to its siblings (h3-30). s30-13 is a document miss the scorer cannot see: its gold is the whole incident-report type, while the only report about Kubernetes (DOC-007) never reaches the top 5, even when search is limited to incident reports.

### 2.3 The real failures, one line each

| id | lane | stage | what happened |
|---|---|---|---|
| s30-06 | sql | NL2SQL | 「가장 많은 프로젝트를 진행 중인」 read as `status='in_progress'`; gold counts all projects (wording ambiguous) |
| h3-10 | sql | NL2SQL | year filter on `resolved_at` instead of `created_at`, hours as a number; prose also leaks 「小时」 |
| h3-13 | sql | NL2SQL | 10-11: join on `projects.product_id` (no such column), gate refused; reruns: correct. Unstable generation |
| h3-19 | sql | NL2SQL | `start_date >= '2025-01-01'` without the upper bound, and the zero-count type dropped by `GROUP BY` |
| h3-20 | sql | NL2SQL | grouped by quarter; the half-year gate then rewrote it to half-year groups, but the question asks the best month inside H1 |
| h4-15 | sql | NL2SQL | 「지난주 회의」 applied to `sale_date` → 0 rows. Behind it: with the gold SQL, curation keeps 13 of 36 rows |
| h4-18 | sql | NL2SQL | `status='resolved'` instead of `resolved_at IS NOT NULL` (closed tickets are resolved too); gold defensible |
| h4-01 | sql | route | graph: 「부서마다」 taken as an entity, not-found answer |
| h4-17 | sql | route | semantic: answered from incident reports with the wrong clients |
| h3-09 | sql | answer | rows right (EX); prose reports one of two tickets and leaves the other's NULL `resolved_at` unexplained (unscorable) |
| s30-13 | vector | retrieval | DOC-007 (the Kubernetes incident) not retrieved; the 7B correctly abstains on what it got |
| h3-21, h3-22 | vector | retrieval | step chunks 2 (.env) and 4 (health check) not retrieved (unscorable) |
| h3-30 | vector | retrieval | cause-analysis chunk of the right report not in top 5; abstains (unscorable) |
| h3-35, h4-32, h4-40 | vector | route | structured: NULL aggregate, refused SQL, 0 rows. Oracle route answers 46%, 49%, 500만원 |
| s30-15 | vector | answer | security-check meeting notes in context, answer names no concrete fact |
| h4-26 | vector | answer | two of three 8-hour incidents named; the third report's chunk is in context (unscorable) |
| h4-39 | vector | answer | 「28%」 from another proposal while the chunk with 40% is in context |
| h3-55 | graph | retrieval | REPORTED_ISSUE edge not retrieved; names Client-G's USES product instead |
| h4-43 | graph | retrieval | 1 of 10 BELONGS_TO edges of 영업팀 retrieved |
| h3-60 | graph | retrieval | LEADS edges of the two projects not retrieved; abstains (unscorable) |
| h3-59 | graph | answer | both projects in context; reads 「K8s 말고도」 as an exclusion |
| h4-46 | graph | answer | the MANAGES_ACCOUNT edge (안소연) in context; abstains, also with gold edges only |
| h4-60 | graph | answer | both edges in context next to two other lines; abstains on the intersection; answers with gold edges only |

### 2.4 The 21 scoring artifacts

| Kind | ids | evidence |
|---|---|---|
| Number right, label/sentence not verbatim | h4-23, h4-24, h4-30, h4-31, h4-33, h4-34, h4-35, h4-37, h4-38 | e.g. answer 「40분」 for keyword 「초기 대응: 40분」; 「투입 인력은 8명이었고, 추가 인력 1명이 필요」 for 「현재 투입 인력 8명이며, 추가 인력 1명이 필요한 상황입니다」 |
| Keyword not asked by the question | h4-21, h4-25, h4-27, h4-28, h4-29 | incident time-stamp, 「…적용이 필요합니다」 sentence, HPA, Redis, 「ELK 스택」 (the question already says ELK) |
| Gold projects columns the question does not ask | h3-03, h4-02, h4-07, h4-10 | 「얼마나 더 붙어?」 answered 220 (gold also wants both prices); names in hire order (gold also wants the dates); 「베타 남아 있나?」 (gold also wants version, release date, status); client and amount (gold also wants the product) |
| Gold value stated in the question | h4-06 | 부산 and IT/SW required; the question states both. The vector scorer already drops such keywords, the SQL scorer does not |
| Sort-key rule only for `LIMIT` golds | h4-13 | scorecard.ts says top-N and maximum questions drop the sort-key number; `isLimited` only sees a trailing `LIMIT`, the gold uses `= (SELECT MAX(...))`, so the sum stays required |
| Wrong gold | h4-59 | The dataset's graph/edges.json has 13 REPORTED_ISSUE sources into Product-T2; the gold `basis` says the same relation but lists 10 (omits Client-R, Client-W, Client-M). The answer names all 13 |

Separate measurement defect (not the answer scorecard): `evalmatch.ts` `normToken` turns interval values into `"[object Object]"`, so any two interval results compare equal in `companyx:sql`. h4-18 (3일 18시간 15분 40초 against gold 3일 19시간 56분 31초) is counted as an execution match: h4 EX 13/20 with the repo matcher, 12/20 by value.

## 3. Ceilings: the answer step re-run with oracle inputs

Each oracle replaces one stage for every question of its lane (and forces the expected route for that lane); everything else is the shipped pipeline. Strict = the scorecard as is on the 127 scorable questions (record 87). Analyst = all 150 questions (record 124 = 87 + 21 artifacts + 16 unscorable right).

| Oracle stage | Strict /127 | Δ | Analyst /150 | fixed / broken | Notes |
|---|---:|---:|---:|---|---|
| none (record) | 87 | | 124 | | |
| Route (10 misrouted questions forced) | 89 | +2 | 129 | +5 / 0 | h4-32, h4-40 answers right but fail the strict keyword wording |
| NL2SQL: gold SQL rows (50 SQL questions) | 100 | +13 | 131 | +8 / −1 | +13 = 6 NL2SQL, 2 route, 6 gold-projection artifacts, −1. Broken: s30-01, gold SQL has no sum column and the 7B listed the top 5 in reverse order. Not fixed: h3-09 (prose), h4-15 (curation keeps 13 of 36 rows) |
| Documents: top 5 within the gold document (50 vector) | 87 | 0 | 127 | +5 / −2 | fixed h3-30, h4-39 and the 3 route cases; broken h4-33 (abstains), h3-27 (now affirms the wrong reading) |
| Documents: whole gold document (7 vector misses and h4-33 only) | | | | +6 | s30-13 (DOC-007), s30-15, h3-21, h3-22, h3-30, h4-39. Not run on right answers, so regressions unknown |
| Edges: gold edges only (40 graph) | 90 | +3 | 127 | +4 / −1 | fixed h3-55, h4-43, h3-60, h4-60; strict also gains h4-59 only because the oracle feeds the wrong gold. Broken h3-57: gold edges alone omit the candidate set the question filters |
| Scorer, mechanical fixes (section 4) | 99 | +12 | 124 | | |
| Scorer, plus asked-value labels | 108 | +21 | 124 | | |

Per stage, what a perfect stage is worth in real answers: route 5, NL2SQL 6 (−1), retrieval and context focus 10 (7 retrieval-stage failures plus 3 answer-stage failures that the cleaner context also fixed: s30-15, h4-39, h4-60), answer step at most 4 more (h3-09, h3-59, h4-26, h4-46).

A non-oracle check of the retrieval lever, “expand the top hit to its whole document”: +3 real (h3-22, h3-30, h4-39), strict 0, but three open multi-document questions lose content (s30-16 drops the second product's backup policy, s30-19 answers with an echo of the question, s30-20 drops one of two SSL incidents; the scorer still passes all three) and h4-26 lists 8 incidents. It has to be gated to questions that name one document.

## 4. Scorer findings and the fixes that are demonstrably right

Mechanical, +12 strict, no wrong answer flips to right in the dev data:

1. **Numbers in keywords are compared as values** (`eval/diag/rescore-values.mjs`): a keyword with numbers is satisfied when every number appears with the same value and unit; keywords without numbers stay verbatim. holdout4 vector 2/19 → 11/19 (+9). h4-39 (28% for 40%) stays wrong, abstentions stay wrong, documents-outside ids still fail.
2. **Drop gold text values the question already states** (SQL), as `holdoutVectorGold` already does for keywords: +1 (h4-06).
3. **Treat `= (SELECT MAX|MIN …)` golds like `LIMIT` golds** for sort-key columns, as the header comment already intends: +1 (h4-13).
4. **Correct h4-59's gold** to the 13 sources in `edges.json`: +1.

Needs labels written from the question text alone (two labellers, before looking at answers): which gold columns and keywords the question asks for (h3-03, h4-02, h4-07, h4-10; h4-21, h4-25, h4-27, h4-28, h4-29): +9.

Also fix `evalmatch.ts` interval comparison (compare `toPostgres()` text), otherwise EX on interval questions is always a match.

## 5. NL2SQL: measured levers and the model survey

Fixed dev subset for the swap rule: **dev30 = sponsor 10 + holdout3 SQL 20**, the same 30 questions as the 2026-09-30 comparison (coder 18, qwen3.5:9b 20, gemma4:e4b 19). holdout4 SQL 20 reported separately. Pipeline path: `companyxNL2SQL` → `alignQualifiedTables` → `executeWithRepair`. EX compares intervals by value; “rows” is the scorecard judge on the executed rows.

| NL2SQL | dev30 EX | dev30 rows | h4 EX | h4 rows | median gen |
|---|---:|---:|---:|---:|---:|
| qwen2.5-coder:7b (today) | 22/30 | 23/29 | 12/20 | 12/20 | 0.6 s |
| coder + self-consistency (greedy + 4 samples at T 0.7, vote by result set) | 23/30 | 24/29 | 12/20 | 12/20 | 2.9 s |
| qwen3.5:9b, think off | 21/30 | 23/29 | 13/20 | 13/20 | 0.9 s |
| Kwai-AutoSQL-14B IQ4_XS (reasoning trace stripped) | 18/30 | 21/29 | 11/20 | 11/20 | 7.3 s |
| NeoHorse-1-9B Q4_K_M, think off | 22/30 | 23/29 | 15/20 | 15/20 | 0.9 s |

Self-consistency does not help: in 29 of 50 questions all five candidates return the same rows, and for every remaining EX miss the majority group is the wrong one. Its +1 is h3-04, where the greedy SQL itself came out different in that run. The 7B's errors are systematic misreadings (temporal scope, status meaning, period bounds), not sampling noise.

Model survey (primary sources checked: arXiv 2609.33670 table 2, BIRD leaderboard, Hugging Face cards), ≤15B, released or updated since 2026-09-01:

- Independent PostgreSQL numbers, BIRD dev, greedy single sample (arXiv 2609.33670, 09-27): Qwen3.5-9B 58.7 (66.6 on SQLite), GPT-OSS-20B 56.7, OmniSQL 54.9, Gemma 4 E4B 51.9, Ministral 3-8B 49.7. Every model loses on PostgreSQL; the SQL-specialised ones lose most.
- **Kwai-AutoSQL-14B** (Qwen3-14B fine-tune, Apache-2.0 weights): BIRD dev 69.69 / test 74.01, listed 2026-09-19, with 8 to 32 sampled candidates (BIRD team scored). No prompt format published, English/SQLite training. Ollama: `hf.co/mradermacher/Kwai-AutoSQL-14B-GGUF:IQ4_XS` (8.18 GB).
- **NeoHorse-1-9B** (Qwen3.5-9B fine-tune, 09-05, Apache-2.0): BFCL v4 67.43 vs 64.88 for its base (self-reported); a tool-use model. `hf.co/TokenRhythm/NeoHorse-1-9B-GGUF:Q4_K_M` (5.63 GB).
- Others: MiMo-V2.6-Distill-Qwen-9B (09-21, MIT, tool-call template problems reported), Mellum2.1-12B-A2.5B-Thinking (09-20, always thinks), K2-Horizon-7B (09-01, architecture not in Ollama 0.40.2's llama.cpp build). Granite 4.2 8B and Ornith-1.5-9B are August releases. No new Korean-made model at ≤15B since 09-01 (Kanana-2 3B, July, needs a separate commercial licence for on-prem redistribution). The official BFCL board was last updated 2026-04-12, so all BFCL figures above are self-reported.

**Swap verdict: keep qwen2.5-coder:7b.** On the fixed subset dev30 no candidate clears +3: NeoHorse ties (22), qwen3.5:9b is −1, Kwai is −4 and twelve times slower. Kwai ignores `think=false` and prints its reasoning before `</think>`, so the harness keeps only the text after it (`DIAG_STRIP_THINK=1`); without that, the pipeline's SQL picker takes a query from inside the reasoning. Its wins (h3-10, CX-SQL-10) are outweighed by narrower projections (h3-16 drops the dates the question explicitly asks for; h3-13 and h3-18 drop the name the question already states, which EX requires just like the scorer). NeoHorse is +3 on holdout4 SQL, but three of its four gains (h4-05, h4-06, h4-13) come from projecting columns that echo the question or that the gold over-asks (section 2.4), one (h4-15) is a real fix of the 「지난주」 misreading, and it loses h4-14 by reading the typo 「매츌이」 as a client name; it also writes Korean column aliases (`고객사명`, `건수`). EX shares the projection artifacts of the scorer, so a model that projects wide looks better on it than it is. Re-measure NeoHorse on all 50 SQL questions after the scorer fix, and end to end (it would also write the answers), before deciding anything. Kwai-AutoSQL was deleted from the host after the run; NeoHorse is still pulled.

## 6. Recommendations, ranked by ceiling and risk

| # | Change | Dev gain (measured ceiling → expected) | What changes on screen | Risk | Size |
|---|---|---|---|---|---|
| 0 | **Scorer corrections** (section 4) | strict +12 mechanical, +21 with labels; real 0 | nothing | low: each rule checked against known wrong answers | ~60 lines `scorecard.ts` + tests, one gold edit, 3 lines `evalmatch.ts` |
| 1 | **Assemble context by evidence unit**: single-document questions get the document's whole section(s) in order; graph questions get the complete edge set of the planned relation from the seed, and only those edges go to the answer step; an exact-term lexical match for technical names | ceiling +10 real; expected +5 to +8 real, strict +1 to +3 now (more after #0) | document answers list every step or figure of the section; graph lists become complete | medium: an ungated version loses content on open multi-document questions (measured: s30-16, s30-19, s30-20) | medium: vector branch and curator order, graph lane plan; ~200 to 300 lines + tests |
| 2 | **Empty-evidence route fallback**: when the rule router was not confident (the semantic fallback chose the lane) and that lane ends in not-found, 0 rows, NULL aggregate or a refused SQL, run the semantic runner-up lane before answering | ceiling +5; expected +4: in h3-35, h4-01, h4-32 and h4-40 the semantic runner-up is exactly the expected lane (h4-17 is not empty, so it is not caught); strict +1 now, +3 after #0 | some 「0건」, 「찾지 못했습니다」, 「믿을 수 있는 조회를 만들지 못해」 answers become answers | low to medium: the absent-entity refusal stays because it comes from a confident rule (s30-24 서울물산, margin 3); no right dev answer goes through this path | small: ~100 lines in `ask()` + tests |
| 3 | **NL2SQL** | ceiling +6 real (−1), +13 strict of which 6 are scorer artifacts. Self-consistency 0; no swap candidate clears +3 on dev30 (NeoHorse ties, +3 on holdout4 SQL) | none | low if kept as is | none recommended now. Re-measure NeoHorse after #0 on all 50 SQL questions and end to end; the half-year gate's repair hint misfired once (h3-20), worth a rule-class look |
| 4 | **Deterministic rendering of SQL answers** (values, units, lists, ranks, NULL meaning from rows; the 7B writes only a lead sentence) | strict 0 now (+1 with better SQL: s30-01 order); real +1 (h3-09); prose quality +2 of 32 (h3-16 dates, h4-03 distribution) | every SQL answer's prose becomes templated | high for the 10-19 test: QA-round sentences that cases quote would change | large: renderer for result shapes ~400 to 600 lines, removes ~400 lines of slip fixers that fired 3 times in 440 dev answers |
| 5 | **Context verifier** for numbers and names | ≤1 on dev: flags 5 of 141 7B answers, 1 wrong; the real failures are grounded-but-wrong (wrong rows, wrong chunk, omission, abstention) | rare rejections | low | medium; only worth it as the guard inside #4 |

The change with the biggest ceiling is **#1**: in oracle reruns the right evidence unit fixed 10 of the 26 real failures, twice what a perfect route or a perfect NL2SQL would fix. Do #0 before it so the follow-up measures #1 on a metric whose misses are real; #2 is the cheapest single win.

## 7. What I could not do, and caveats

- No oracle exists for the answer step; its ceiling is the residue after the retrieval oracles (4).
- The whole-document oracle ran only on 7 vector misses and h4-33, so its regressions on currently right answers are unknown; the top-document expansion run shows the kind (multi-document questions).
- Analyst labels are one reader's judgement (written in `answer-diagnosis-2026-10-11.json`, field `why`). h4-02, h4-18 and s30-06 are close calls.
- Oracle inputs differ from what a real stage would produce: gold edges alone broke h3-57; gold SQL without the sort column broke s30-01.
- Every number above has about ±1 per set of run-to-run noise (section 1).
- holdout5 was not fetched, checked out or opened.

## 8. Files and reproduction

- `answer-diagnosis-2026-10-11.json`: the 63 rows of record with stage, reason, analyst verdict, SQL (generated, executed, gate reasons, EX, rows hold the answer, rows kept), vector (gold docs, rank, chunk ids retrieved and kept), graph (edges retrieved and kept), and every oracle answer with its strict, number-rule and analyst verdicts. No document text.
- `eval/diag/patch-dist.mjs`: copies `air-server/dist` to `dist/_diag` and adds the hooks (route, SQL, vector, graph, sampling) and the optional `DIAG_STRIP_THINK=1` reasoning-trace cut. Inert unless a harness sets `globalThis.__diag` or the variable.
- `eval/diag/answer-stages.mjs --set <sponsor30|holdout3|holdout4> --mode <trace|oracle-route|oracle-sql|oracle-docs|oracle-chunks|oracle-wholedoc|oracle-edges|expand-topdoc>`.
- `eval/diag/sql-models.mjs [--sc N]` with `OLLAMA_MODEL` (and `OLLAMA_THINK=false`, plus `DIAG_STRIP_THINK=1` for models that reason anyway).
- Raw per-run outputs (traces, oracle runs, model runs) stay in the worktree's ignored `.scratch/diag/`; the JSON next to this file carries what the analysis uses.
- `eval/diag/rescore-values.mjs`: the number rule on stored answers.
- `eval/diag/build-diagnosis.py`: builds the JSON from the record files, the traces and the labels.
- Environment for all of them: `DATASET=companyx EMBEDDER=ollama DATABASE_URL=postgresql://postgres:postgres@localhost:5433/mcpdata_diag OLLAMA_HOST=http://127.0.0.1:11434 DATASET_DIR=<worktree>/datasets/companyx-v1.0`, after `npm run build` and `node eval/diag/patch-dist.mjs`.
