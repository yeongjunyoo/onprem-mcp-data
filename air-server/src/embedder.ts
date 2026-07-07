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

/** bge-m3 embeddings from a local Ollama instance (dim 1024). */
export class OllamaEmbedder implements Embedder {
  readonly name: string;
  readonly dim = EMBED_DIM;
  constructor(
    readonly model = process.env.EMBED_MODEL ?? "bge-m3",
    readonly host = process.env.OLLAMA_HOST ?? "http://localhost:11434",
  ) {
    this.name = `ollama:${model}`;
  }
  async embed(text: string): Promise<number[]> {
    const res = await fetch(`${this.host}/api/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: this.model, prompt: text }),
    });
    if (!res.ok) throw new Error(`ollama embeddings ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as { embedding: number[] };
    if (!Array.isArray(json.embedding)) throw new Error("ollama: missing embedding in response");
    return json.embedding;
  }
}

let cached: Embedder | undefined;

/** Pick the embedder from EMBEDDER env (default: hash for offline determinism). */
export function getEmbedder(): Embedder {
  if (!cached) {
    cached = (process.env.EMBEDDER ?? "hash") === "ollama" ? new OllamaEmbedder() : new HashEmbedder();
  }
  return cached;
}

/** pgvector text literal for a float array: '[v1,v2,...]'. */
export function toVectorLiteral(v: number[]): string {
  return `[${v.join(",")}]`;
}
