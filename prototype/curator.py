"""
L4 — structure-preserving, schema-aware context curation (TACC).

The moat (per the brief + the failure mode documented for token-level compressors
like LLMLingua/Squeez): when you prune retrieved context to fit a small 7B window,
you must NOT split a SQL tuple / table row. Token-level compression corrupts
structured data; a row that loses half its fields becomes a wrong fact.

This curator:
  * scores each retrieved item's relevance to the query (deterministic term
    overlap — training-free, no GPU, runs on-prem; the RL-vs-heuristic gap is a
    fewer-params / zero-training feature, not a shortfall),
  * greedily packs the highest-relevance items WHOLE under a token budget,
  * NEVER partially includes a structured row (rows are atomic),
  * emits an audit of kept/dropped + a structure-integrity guarantee (0 broken rows).

Thesis is structure integrity at a fixed budget, NOT a token-reduction percentage.
"""
from __future__ import annotations
import re
from dataclasses import dataclass, field


# --- token estimate (deterministic heuristic; swap for the model tokenizer in eval) ---
_HANGUL = re.compile(r"[가-힣]")
_ASCIIWORD = re.compile(r"[A-Za-z0-9]+")


def est_tokens(text: str) -> int:
    """Rough, deterministic token estimate: Korean syllables + ascii word tokens
    + punctuation. Monotonic in length; good enough for budgeting. The eval
    harness swaps in the real Qwen tokenizer for reported numbers."""
    hangul = len(_HANGUL.findall(text))
    ascii_words = len(_ASCIIWORD.findall(text))
    punct = len(re.findall(r"[^\w\s가-힣]", text))
    return hangul + ascii_words + punct


# --- content-word relevance (deterministic, language-light) ---
_STOP = {"그리고", "그러나", "하지만", "또는", "에서", "으로", "에게", "이다", "있다", "없다",
         "the", "a", "an", "of", "to", "is", "are", "and", "or"}


def _content_terms(text: str) -> set[str]:
    # Korean: strip common particle tails; ascii: lowercase words. Cheap + deterministic.
    toks = set()
    for w in re.findall(r"[가-힣]+|[A-Za-z0-9]+", text.lower()):
        w = re.sub(r"(은|는|이|가|을|를|에|의|와|과|도|로|으로|에서|에게|까지|부터|만)$", "", w)
        if len(w) >= 2 and w not in _STOP:
            toks.add(w)
    return toks


@dataclass
class ContextItem:
    kind: str                 # 'row' (structured, atomic) | 'chunk' (document text)
    text: str                 # rendered text that would go into the prompt
    source: str = ""          # e.g. 'orders#2' or 'documents#1'
    fields: int = 0           # for rows: number of fields (used for integrity check)


@dataclass
class Curated:
    kept: list[ContextItem]
    dropped: list[ContextItem]
    tokens_used: int
    budget: int
    broken_rows: int = 0      # MUST stay 0 for the curator (the guarantee)
    notes: list[str] = field(default_factory=list)

    def render(self) -> str:
        return "\n".join(i.text for i in self.kept)

    def audit(self) -> dict:
        return {
            "kept": [i.source for i in self.kept],
            "dropped": [i.source for i in self.dropped],
            "tokens_used": self.tokens_used,
            "budget": self.budget,
            "broken_rows": self.broken_rows,
            "structure_preserved": self.broken_rows == 0,
        }


def _relevance(query_terms: set[str], item: ContextItem) -> int:
    return len(query_terms & _content_terms(item.text))


def curate(query: str, items: list[ContextItem], budget: int) -> Curated:
    """Greedy relevance-ranked packing; rows stay whole. Deterministic."""
    qt = _content_terms(query)
    # Stable sort: relevance desc, then original order (deterministic, no ties RNG).
    ranked = sorted(enumerate(items), key=lambda p: (-_relevance(qt, p[1]), p[0]))

    kept: list[ContextItem] = []
    dropped: list[ContextItem] = []
    used = 0
    for _, it in ranked:
        cost = est_tokens(it.text)
        if used + cost <= budget:
            kept.append(it)
            used += cost
        else:
            # A row is atomic: if it does not fit whole, it is dropped, never split.
            dropped.append(it)
    # restore original order among kept for readable context
    order = {id(it): i for i, it in enumerate(items)}
    kept.sort(key=lambda it: order[id(it)])
    return Curated(kept, dropped, used, budget, broken_rows=0,
                   notes=[f"{len(kept)} kept / {len(dropped)} dropped, rows atomic"])


def naive_token_truncate(items: list[ContextItem], budget: int) -> Curated:
    """Baseline standing in for token-level compressors (LLMLingua/Squeez-style):
    concatenate everything and hard-cut at the token budget. This SPLITS whichever
    row straddles the boundary -> corrupted structured data. Used for the head-to-head."""
    # build the concatenated prompt and record each item's exact char span
    spans: list[tuple[int, int]] = []
    cursor = 0
    pieces = []
    for i, it in enumerate(items):
        start = cursor
        pieces.append(it.text)
        cursor += len(it.text)
        spans.append((start, cursor))
        if i < len(items) - 1:
            cursor += 1  # the "\n" separator
    full = "\n".join(it.text for it in items)
    # cut at the token budget (binary search on char length, est_tokens monotonic)
    lo, hi = 0, len(full)
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if est_tokens(full[:mid]) <= budget:
            lo = mid
        else:
            hi = mid - 1
    cut = lo
    broken = 0
    kept_items, dropped_items = [], []
    for it, (s, e) in zip(items, spans):
        if cut >= e:
            kept_items.append(it)            # fully inside the kept prefix
        elif cut <= s:
            dropped_items.append(it)         # fully past the cut
        else:
            # the cut falls INSIDE this item's text -> it is split mid-content.
            # for a structured row this corrupts the tuple (lost fields).
            if it.kind == "row":
                broken += 1
            else:
                dropped_items.append(it)     # a chunk fragment, treat as dropped
    return Curated(kept_items, dropped_items, est_tokens(full[:cut]), budget,
                   broken_rows=broken, notes=["hard token cut; rows may be split mid-tuple"])


if __name__ == "__main__":
    rows = [
        ContextItem("row", "주문 #2 | 사용자 1 | 상태 환불 | 금액 8000 | 2026-04-10", "orders#2", fields=5),
        ContextItem("row", "주문 #1 | 사용자 1 | 상태 결제완료 | 금액 12000 | 2026-04-02", "orders#1", fields=5),
        ContextItem("chunk", "환불 정책: 단순 변심 반품은 수령 후 7일 이내 가능하며 택배비는 고객 부담입니다.", "documents#1"),
        ContextItem("chunk", "배송 안내: 출고 후 보통 2~3일 내 도착하며 운송장은 문자로 안내됩니다.", "documents#2"),
    ]
    q = "환불 관련 주문과 정책"
    budget = 40
    c = curate(q, rows, budget)
    n = naive_token_truncate(rows, budget)
    print("CURATOR :", c.audit())
    print("NAIVE   :", n.audit())
