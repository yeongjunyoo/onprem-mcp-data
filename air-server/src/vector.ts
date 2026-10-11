// Copyright 2026 Yeongjun Yoo
// SPDX-License-Identifier: Apache-2.0
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// L2 — vector.search tool (pgvector cosine similarity over documents).
//
// Embeds the query with the configured embedder (offline hash by default,
// bge-m3 via Ollama for the demo) and returns the top-k nearest documents by
// cosine similarity. The embedder is pluggable so the exact same retrieval path
// runs in air-gapped CI and in the recorded demo.

import type { Pool } from "./db.js";
import { type Embedder, toVectorLiteral } from "./embedder.js";
import { profile } from "./profile.js";
import { describeError } from "./errors.js";

export interface VectorHit {
  id: number;
  title: string;
  body: string;
  score: number; // cosine similarity in [-1, 1]; higher = closer
}

export interface VectorResult {
  ok: boolean;
  hits: VectorHit[];
  embedder: string;
  error?: string;
}

const TABLE_IDENT = /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/;
function safeTable(t: string): string {
  if (!TABLE_IDENT.test(t)) throw new Error(`unsafe table identifier: ${t}`);
  return t;
}

export interface VectorSearchOptions {
  /** 이 문서 유형으로 거른다(doctype.ts). 유형을 모르는 문서(doc_type NULL)는 거르지 않고 남긴다. 표에 doc_type 열이 있어야 한다(docTypeReady). */
  docType?: string;
}

export async function vectorSearch(
  pool: Pool,
  embedder: Embedder,
  query: string,
  k = 5,
  table = profile().vectorTable,
  opts: VectorSearchOptions = {},
): Promise<VectorResult> {
  try {
    // Clamp k to a sane integer range so a bad MCP arg can't error / flood.
    const limit = Math.min(50, Math.max(1, Math.floor(k) || 5));
    const vec = toVectorLiteral(await embedder.embed(query));
    const typed = opts.docType !== undefined;
    const res = await pool.query(
      // Secondary ORDER BY id makes equal-distance ties deterministic
      // (the run-to-run variance = 0 claim must hold on the vector path too).
      `SELECT id, title, body, 1 - (embedding <=> $1::vector) AS score
         FROM ${safeTable(table)}
        WHERE embedding IS NOT NULL${typed ? " AND (doc_type = $3 OR doc_type IS NULL)" : ""}
        ORDER BY embedding <=> $1::vector, id
        LIMIT $2`,
      typed ? [vec, limit, opts.docType] : [vec, limit],
    );
    const hits: VectorHit[] = res.rows.map((r) => ({
      id: Number(r.id),
      title: String(r.title),
      body: String(r.body),
      score: Number(r.score),
    }));
    return { ok: true, hits, embedder: embedder.name };
  } catch (err) {
    return {
      ok: false,
      hits: [],
      embedder: embedder.name,
      error: describeError(err),
    };
  }
}

/** 문서 유형 필터를 쓸 수 있는가 — 벡터 표(뷰)에 doc_type 열이 있는가. companyx 는 적재(companyx:load)나
 * companyx:doctype 이 그 열을 붙인다. smoke, bench 는 없다. */
export async function docTypeReady(pool: Pool, table = profile().vectorTable): Promise<boolean> {
  const t = safeTable(table);
  const [schema, name] = t.includes(".") ? t.split(".") : ["public", t];
  const r = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2 AND column_name = 'doc_type'`,
    [schema, name],
  );
  return Number(r.rows[0]?.n ?? 0) > 0;
}

/** Backfill documents.embedding using the given embedder. Returns rows updated.
 * Embeds "title\nbody" so the title contributes to retrieval. */
export async function embedDocuments(pool: Pool, embedder: Embedder, table = "documents"): Promise<number> {
  const t = safeTable(table);
  const docs = await pool.query<{ id: number; title: string; body: string }>(
    `SELECT id, title, body FROM ${t} ORDER BY id`,
  );
  let updated = 0;
  for (const d of docs.rows) {
    const vec = toVectorLiteral(await embedder.embed(`${d.title}\n${d.body}`));
    await pool.query(`UPDATE ${t} SET embedding = $1::vector WHERE id = $2`, [vec, d.id]);
    updated++;
  }
  return updated;
}
