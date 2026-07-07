// Shared deterministic text helpers (ported from prototype/curator.py).
// Used by the L4 curator (token budgeting + relevance) and the offline
// hashing embedder. No GPU, no model, no RNG — every output is a pure
// function of its input, which is the operational-stability thesis.

const HANGUL = /[가-힣]/g;
const ASCIIWORD = /[A-Za-z0-9]+/g;
const PUNCT = /[^\w\s가-힣]/g;

/** Rough, deterministic token estimate: Korean syllables + ascii word tokens
 * + punctuation. Monotonic in length; good enough for budgeting. The eval
 * harness swaps in the real Qwen tokenizer for reported numbers. */
export function estTokens(text: string): number {
  const hangul = (text.match(HANGUL) ?? []).length;
  const asciiWords = (text.match(ASCIIWORD) ?? []).length;
  const punct = (text.match(PUNCT) ?? []).length;
  return hangul + asciiWords + punct;
}

const STOP = new Set([
  "그리고", "그러나", "하지만", "또는", "에서", "으로", "에게", "이다", "있다", "없다",
  "the", "a", "an", "of", "to", "is", "are", "and", "or",
]);

const TERM = /[가-힣]+|[A-Za-z0-9]+/g;
const PARTICLE_TAIL = /(은|는|이|가|을|를|에|의|와|과|도|로|으로|에서|에게|까지|부터|만)$/;

/** Content-word terms: strip common Korean particle tails, lowercase ascii,
 * drop stopwords and length<2 tokens. Deterministic and language-light. */
export function contentTerms(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().match(TERM) ?? []) {
    const w = raw.replace(PARTICLE_TAIL, "");
    if (w.length >= 2 && !STOP.has(w)) out.add(w);
  }
  return out;
}
