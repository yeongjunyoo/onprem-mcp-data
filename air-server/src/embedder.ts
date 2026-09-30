// Pluggable embedder for the L2 vector.search tool.
//
// Two implementations, same 1024-dim output (matches the documents.embedding
// vector(1024) column = BGE-m3 dimensionality):
//
//   HashEmbedder   — feature-hashing vectorizer over content terms. Fully
//                    deterministic, offline, zero-dependency. Shared terms ->
//                    higher cosine, so it gives real (if shallow) semantic-lite
//                    retrieval with no model. Default for tests / air-gapped CI.
//   OllamaEmbedder — bge-m3 via a local Ollama (true semantic generalization).
//                    Used for the recorded demo. Still 100% on-prem, no external API.
//
// Selection is env-driven (EMBEDDER=hash|ollama) so the same code path runs
// offline in CI and with the real model in the demo.

import { contentTerms } from "./text.js";
import { profile } from "./profile.js";
import { postJson } from "./ollamahttp.js";

export const EMBED_DIM = 1024;

export interface Embedder {
  readonly name: string;
  readonly dim: number;
  embed(text: string): Promise<number[]>;
}

// --- FNV-1a 32-bit: a tiny, deterministic string hash (no deps) ---
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function l2normalize(v: number[]): number[] {
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm);
  if (norm === 0) return v;
  return v.map((x) => x / norm);
}

/** Deterministic feature-hashing embedder (à la sklearn HashingVectorizer).
 * Each content term is hashed to a bucket with a signed weight; the vector is
 * L2-normalized so cosine similarity = shared-term overlap. No model, no RNG. */
export class HashEmbedder implements Embedder {
  readonly name = "hash";
  constructor(readonly dim = EMBED_DIM) {}
  async embed(text: string): Promise<number[]> {
    const v = new Array<number>(this.dim).fill(0);
    for (const term of contentTerms(text)) {
      const idx = fnv1a(term) % this.dim;
      const sign = fnv1a(term + "#") & 1 ? 1 : -1;
      v[idx] += sign;
    }
    return l2normalize(v);
  }
}

/** Known output dimensions of the local embedding models we evaluate.
 * The sponsor's DDL declares vector(768) — the dimension of nomic-embed-text —
 * so the model choice decides whether the official schema is used verbatim. */
const MODEL_DIMS: Record<string, number> = {
  "bge-m3": 1024,
  "nomic-embed-text": 768,
  "mxbai-embed-large": 1024,
};

/** Embeddings from a local Ollama instance. Dimension follows the model. */
export class OllamaEmbedder implements Embedder {
  readonly name: string;
  readonly dim: number;
  constructor(
    readonly model = process.env.EMBED_MODEL ?? "bge-m3",
    readonly host = process.env.OLLAMA_HOST ?? "http://localhost:11434",
  ) {
    this.name = `ollama:${model}`;
    const base = model.split(":")[0];
    this.dim = Number(process.env.EMBED_DIM) || MODEL_DIMS[base] || EMBED_DIM;
  }
  async embed(text: string): Promise<number[]> {
    // 마감이 없으면 포트만 살아 있는 Ollama 앞에서 벡터 레인이 영원히 기다린다(생성의
    // OLLAMA_TIMEOUT_MS 와 같은 이유). 넘기면 레인이 실패를 돌려주고 ask 는 상태로 끝난다.
    const n = Number(process.env.OLLAMA_EMBED_TIMEOUT_MS);
    const deadline = Number.isFinite(n) && n > 0 ? n : 60_000;
    try {
      const res = await postJson(
        `${this.host}/api/embeddings`,
        { model: this.model, prompt: text },
        AbortSignal.timeout(deadline),
      );
      if (res.status < 200 || res.status >= 300) throw new Error(`ollama embeddings ${res.status}: ${res.text}`);
      const json = JSON.parse(res.text) as { embedding: number[] };
      if (!Array.isArray(json.embedding)) throw new Error("ollama: missing embedding in response");
      return json.embedding;
    } catch (e) {
      if (e instanceof Error && e.name === "TimeoutError") {
        throw new Error(
          `임베딩 모델이 ${deadline / 1000}초 안에 응답하지 않았다(시간 초과). 느린 환경이면 OLLAMA_EMBED_TIMEOUT_MS 를 올린다.`,
        );
      }
      throw e;
    }
  }
}


/** Dimension reduction by truncation + renormalization (Matryoshka-style).
 *
 * The sponsor's DDL declares vector(768) and their own guidance is explicit:
 * "1536차원 임베딩을 그대로 쓰면 인덱스 크기와 검색 시간이 불필요하게 커집니다.
 *  PCA나 Matryoshka 기법으로 768 또는 512차원으로 줄여도 검색 품질 차이는 미미합니다."
 * (liwonace.co.kr/blog/2). Swapping to a 768-native English model instead costs
 * Korean accuracy badly (measured: type precision 0.971 -> 0.486), so the honest
 * way to honour the official schema is to keep the Korean model and cut the tail.
 *
 * Whether BGE-M3 actually tolerates truncation is an empirical question, not an
 * assumption — `npm run companyx:vector` answers it on the sponsor's own corpus.
 */
export class TruncatedEmbedder implements Embedder {
  readonly name: string;
  constructor(
    private readonly inner: Embedder,
    readonly dim: number,
  ) {
    if (dim > inner.dim) throw new Error(`cannot truncate ${inner.dim} -> ${dim}`);
    this.name = `${inner.name}@${dim}`;
  }
  async embed(text: string): Promise<number[]> {
    const full = await this.inner.embed(text);
    return l2normalize(full.slice(0, this.dim));
  }
}

let cached: Embedder | undefined;

/** Pick the embedder from EMBEDDER env (default: hash for offline determinism). */
export function getEmbedder(): Embedder {
  if (!cached) {
    const base: Embedder =
      (process.env.EMBEDDER ?? "hash") === "ollama"
        ? new OllamaEmbedder()
        : new HashEmbedder(Number(process.env.EMBED_DIM) || EMBED_DIM);
    const want = Number(process.env.EMBED_TRUNCATE_DIM) || profile().embedDim || 0;
    cached = want && want < base.dim ? new TruncatedEmbedder(base, want) : base;
  }
  return cached;
}

/** pgvector text literal for a float array: '[v1,v2,...]'. */
export function toVectorLiteral(v: number[]): string {
  return `[${v.join(",")}]`;
}
