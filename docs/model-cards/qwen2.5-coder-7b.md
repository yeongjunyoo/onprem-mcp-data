# Model Card — Qwen2.5-Coder-7B-Instruct (NL2SQL + answer generation)

- **Role in system:** L7 on-prem LLM. Generates SQL from NL over the schema card
  (`benchNL2SQL` / `llmNL2SQL`) and the final Korean answer grounded only in the
  curated context (`ask`).
- **Source / license:** Alibaba Cloud, **Apache-2.0** (open weights). Pulled via Ollama
  (`ollama pull qwen2.5-coder:7b`), tag `qwen2.5-coder:7b`, quantization Q4_K_M, 7.6B params,
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

## 왜 이 모델로 바꿨나 (2026-08-19)

이 저장소는 `qwen2.5:7b`(일반)로 시작했다. 2026-08-19 에 후보 3종을 **같은 기계·같은
스택·같은 날** 우리 벤치마크로 재고 바꿨다.

| 후보 | NL2SQL 무재시도 | BIRD Mini-Dev 32 | 단발 호출 |
|---|---|---|---|
| `qwen2.5:7b` | 5/10 | 10/32 | 36.4초 (6토큰) |
| **`qwen2.5-coder:7b`** | **7/10** | **12/32** | **32.7초 (23토큰)** |
| `qwen3:8b` | 7/10 | 안 쟀다 | **82.5초 (465토큰)** |

원자료 `eval/results/model-bakeoff.json`. 임베딩은 전 후보 bge-m3 로 고정했다.

`qwen3:8b` 는 **측정으로 탈락**시켰다 — 다만 **실패해서가 아니다.**
NL2SQL 무재시도는 7/10 으로 Coder 와 같다. 탈락 사유는 **지연**이다:
호출당 82.5초로 Coder(32.7초)의 2.5배이고 465토큰을 생각에 쓴다. 사고형의 비용이다.
BIRD32 는 82.5초 × 32문항 = 약 44분이라 **안 쟀다** — 탈락 사유가 이미 확정돼
추가 측정이 결정을 바꾸지 않는다. **못 잰 것을 실패라 적지 않는다.**
**더 새 모델이 더 나은 모델은 아니다.**

교체 비용은 **태그 하나**다 — 같은 4.7GB · 같은 Q4_K_M · 같은 context 32768 ·
같은 Apache-2.0. 심사자의 설치 절차가 바뀌지 않는다.

외부 근거: arXiv 2606.29733(2026-06)이 BIRD dev 전량(n=1534)에서 Qwen2.5-Coder-7B
**39.1 EX** 를 보고한다. 우리 32문항 37.5% 와 어긋나지 않는다.
