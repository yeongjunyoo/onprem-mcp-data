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
import { postJson, type JsonResponse } from "./ollamahttp.js";

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
      // 모델 문맥 길이를 넘는 입력은 오류로 끝내지 않고 앞부분만 다시 보낸다(fitToContext, 이 파일 끝).
      // 들어가는 입력은 종전 그대로 한 번에 보내므로 그 벡터는 바뀌지 않는다.
      const res = await fitToContext(text, (input) =>
        postJson(`${this.host}/api/embeddings`, { model: this.model, prompt: input }, AbortSignal.timeout(deadline)),
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

/** 임베딩 입력이 모델 문맥을 넘을 때 다시 보낼 길이(유니코드 문자 수).
 *
 * 호스트 Ollama 0.35.1 의 bge-m3 는 2,048토큰에서 끊는다(모델 카드의 문맥은 8,192). 넘으면 벡터 대신
 * 500 「the input length exceeds the context length」를 돌려주고, 종전에는 그 오류가 시맨틱 라우터를
 * 거쳐 ask 의 답으로 그대로 나갔다(같은 질문 200번, 4,400자. 2026-10-06 경계 실측 2/2).
 * 실측 상한(2026-10-07, 접두 길이 이분 탐색): 문장부호만 이은 글 2,046자(한 자가 한 토큰),
 * 이모지 2,728자, 한자 3,381자, 그 반복 질문 4,092자, 영문 단어 4,213자, 한글 음절 6,916자.
 * 가장 나쁜 경우보다 조금 아래로 둔다. */
export const EMBED_RETRY_CHARS = 2000;

/** 문맥 길이 초과일 때만 앞부분을 잘라 다시 보낸다.
 *
 * 처음에는 받은 그대로 보낸다. 들어가는 입력(종전에 되던 모든 질의와 문서)은 한 번에 끝나고 벡터도
 * 같다. 초과면 앞 EMBED_RETRY_CHARS 자로, 그래도 넘치면(정규화로 글자가 늘어나는 입력) 반씩
 * 줄인다. 길이는 매번 줄어드니 반드시 끝난다. 자른 사실은 stderr 에 남긴다. 감사 레코드의 query 는
 * 호출부가 가진 원문 그대로다. 다른 오류는 그대로 돌려줘 호출부가 종전처럼 던진다. */
export async function fitToContext(
  text: string,
  send: (input: string) => Promise<JsonResponse>,
): Promise<JsonResponse> {
  let res = await send(text);
  const chars = Array.from(text); // 서로게이트 쌍(이모지)을 가르지 않는다
  let len = chars.length;
  while (res.status >= 400 && /context length/i.test(res.text) && len > 1) {
    len = len > EMBED_RETRY_CHARS ? EMBED_RETRY_CHARS : Math.floor(len / 2);
    console.error(`[임베딩] 입력 ${chars.length}자가 임베딩 모델의 문맥 길이를 넘어 앞 ${len}자만 임베딩한다`);
    res = await send(chars.slice(0, len).join(""));
  }
  return res;
}
