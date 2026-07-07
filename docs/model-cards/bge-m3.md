# Model Card — BGE-M3 (embeddings)

- **Role in system:** L2 embedder for `vector.search` and the document/entity backfill
  (`embed:bench`). Produces 1024-dim vectors matching `documents.embedding vector(1024)`.
- **Source / license:** BAAI, **MIT** (open weights). Pulled via Ollama (`ollama pull bge-m3`),
  tag `bge-m3:latest`. 100+ languages incl. Korean, 8192-token context, dense embeddings.
- **Why BGE-M3:** MIT-licensed, on-prem, 1024-dim aligns with the schema, strong Korean
  multilingual retrieval. It is the demo/eval **headline** embedder; the deterministic
  feature-hashing `HashEmbedder` is an **offline CI fallback only** (labeled lexical, never
  sold as semantic).
- **Verified semantic capability (on-prem):** lexically-disjoint queries resolve correctly —
  e.g. "물건이 마음에 안 들어 돈 돌려받고 싶어요" → 반품 신청 방법 / 환불 정책 (no shared content
  words); "주문한 게 너무 늦게 와요" → 배송 지연 문의 / 배송 정책. HashEmbedder cannot do this.
- **Runtime / on-prem:** Served locally by Ollama (`/api/embeddings`); no external API.
  Backfill of bench.documents (30 docs) recorded dim=1024, ~28–31s.
- **Hardware (recorded):** Apple M4, macOS 25.5.
- **Limitations:** Embedding quality depends on the document corpus; the bench corpus is
  synthetic. A full hash-vs-BGE recall@k / MRR comparison on a labeled semantic subset is
  the remaining WS-C measurement; the qualitative semantic superiority over hash is shown above.
