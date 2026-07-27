# datasets/ — provenance manifest

The sponsor dataset is **fetched, never vendored**: its licence limits use to the
contest ("본 데이터셋은 대회 참가 목적으로만 사용 가능합니다"), so redistributing it
inside an Apache-2.0 repository would be a licence violation. The archive and the
extracted tree are gitignored; this file is the reproducibility contract.

```bash
bash scripts/fetch-companyx-dataset.sh    # download + SHA-256 verify + extract
cd air-server && npm run companyx:load    # schema + rows + chunks + graph -> PostgreSQL
```

## companyx-dataset-v1.0

| field | value |
|---|---|
| file | `companyx-dataset-v1.0.zip` (56,460 bytes) |
| sha256 | `3008476738d992857d738337b4882772e88288f7b314da235d6a5d120827d772` |
| source | https://liwonace.co.kr/blog/9 (리원에이스 기술개발본부, 2026-07-22) |
| notified | 담당자 메일 2026-07-27 12:22 KST (이시현 연구원) |
| licence | contest use only — do not redistribute |
| retrieved | 2026-07-27 (SHA-256 verified against the value published on the blog page) |

### Contents (verified after load)

| part | count | lane |
|---|---|---|
| `sql/01-schema.sql` + `02-data.sql` | 8 tables / **818 rows** (departments 6, employees 45, clients 30, products 12, contracts 65, projects 40, sales 500, support_tickets 120) | NL2SQL |
| `documents/DOC-001..040.md` | 40 docs → **258 chunks** (incident_report 10 / technical_doc 10 / meeting_note 10 / proposal 10) | vector search |
| `graph/nodes.json` + `edges.json` | **133 nodes / 354 edges** (BELONGS_TO 45, HEAD_IS 6, USES 61, MANAGES_ACCOUNT 63, HAS_PROJECT 40, LEADS 40, REPORTED_ISSUE 99) | knowledge graph |
| `questions.json` | 30 labelled example questions (10 per lane) | router labels |

### Deviations from the official DDL (documented, not silent)

1. `document_chunks.embedding vector(768)` → `vector(<embedder dim>)`. The official
   768 assumes `nomic-embed-text`; this build embeds with BGE-M3 (1024). The loader
   rewrites exactly this one declaration and reports it in
   `eval/results/companyx-load.json → ddlDeviations`.
2. Everything is created inside the `companyx` schema (not `public`) so the sponsor
   corpus, the internal benchmark (`bench`) and the smoke seed (`public`) coexist in
   one instance. Table/column names are untouched.

### Data defects found (reported upstream)

* `questions.json` #24 asks about **서울물산**, which appears nowhere else in the
  dataset (no client row, no graph node — the clients are `Client-A … Client-AD`).
  Treated as an intentional-or-not abstention case: the platform answers
  "not found" instead of inventing an engineer. See `eval/companyx/kg_gold.json`.
