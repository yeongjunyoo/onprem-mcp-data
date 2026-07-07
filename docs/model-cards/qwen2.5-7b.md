# Model Card — Qwen2.5-7B-Instruct (NL2SQL + answer generation)

- **Role in system:** L7 on-prem LLM. Generates SQL from NL over the schema card
  (`benchNL2SQL` / `llmNL2SQL`) and the final Korean answer grounded only in the
  curated context (`ask`).
- **Source / license:** Alibaba Cloud, **Apache-2.0** (open weights). Pulled via Ollama
  (`ollama pull qwen2.5:7b`), tag `qwen2.5:7b`, quantization Q4_K_M, 7.6B params,
  context length 32768, gguf. Digest recorded by Ollama at pull time.
- **Why Qwen (cited):** 전현우 외 2026 (zenodo 18842478, 3,805 experiments) found context
  marginal utility is model-dependent and **Qwen benefits from fuller context (p<0.001)**
  while Llama plateaus after key+answer — directly motivating the L4 curated-context design.
- **Runtime / on-prem:** Served locally by Ollama; no external API. Generation pinned to
  `temperature 0`, `seed 42`, `num_ctx 4096` for reproducibility (sampling model, so not
  bit-exact, but stable in practice).
- **Hardware (recorded):** Apple M4, macOS 25.5; container DB + host/container Ollama.
- **Limitations:** 7B NL2SQL makes real errors (e.g. extra columns, hallucinated filters —
  see eval/results/internal-llm-raw.json q17/q23). The system mitigates with the strict
  read-only SQL guard (`mcp_ro`), execution-match scoring against gold, and answer grounding
  that refuses when context lacks the answer. Numbers are measured, never tuned to a target.
