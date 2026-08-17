// Vector lane eval on the sponsor's 40-document corpus.
//
// Oracle = a deterministic LEXICAL rule over the raw Markdown (see
// eval/companyx/vector_gold.json) plus the document type declared in the sponsor's
// index.json. The retriever only ever sees the natural-language question, so the
// oracle is independent of the system under test.
//
// Metrics per question: hit@k on the gold document set, and type accuracy of the
// retrieved chunks. Runs head-to-head between the offline hash embedder and
// BGE-M3, so the report can state what the real embedding model actually buys on
// THIS corpus instead of citing a generic benchmark.
//
// Run: EMBEDDER=ollama npm run companyx:vector
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPool, closePool, type Pool } from "../db.js";
import { getEmbedder, HashEmbedder, OllamaEmbedder, TruncatedEmbedder, type Embedder } from "../embedder.js";
import { vectorSearch } from "../vector.js";
import { computeCompanyXVectors, datasetDir, CX_SCHEMA } from "../companyx.js";

interface GoldItem {
  q: string;
  type: string | null;
  keywords: string[];
}

/** 결과가 자기 입력의 내용 해시를 들고 다니게 한다. 줄바꿈은 정규화한다 —
 * git 이 OS 마다 CRLF/LF 를 바꾸므로 원시 바이트를 해시하면 같은 내용이 다른
 * 해시가 된다. 재려는 것은 인코딩이 아니라 내용이다. */
async function inputHashes(root: string, files: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const f of files) {
    try {
      const text = await readFile(resolve(root, f), "utf8");
      out[f] = createHash("sha256").update(text.replace(/\r\n/g, "\n")).digest("hex").slice(0, 16);
    } catch {
      /* 없는 입력은 기록하지 않는다 — 검사가 부재를 따로 잡는다 */
    }
  }
  return out;
}


/** 폭 재정렬과 백필을 **한 트랜잭션**으로 한다.
 *
 * 둘을 나누면 그 사이에 프로세스가 죽었을 때 코퍼스가 비거나 부분만 채워진 채
 * 남는다(QA 재현: 0/258, 83/258). 부분 채움은 빈 것과 같다 — 검색이 조용히
 * 나빠지고 아무도 모른다. 느린 임베딩 계산은 트랜잭션 밖에서 끝내고 안에서는
 * DDL 과 UPDATE 만 한다. */
async function realignAndBackfill(pool: Pool, emb: Embedder): Promise<{ updated: number; dim: number }> {
  const vectors = await computeCompanyXVectors(pool, emb, CX_SCHEMA);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DROP VIEW IF EXISTS ${CX_SCHEMA}.documents`);
    await client.query(
      `ALTER TABLE ${CX_SCHEMA}.document_chunks ALTER COLUMN embedding TYPE vector(${emb.dim}) USING NULL`,
    );
    await client.query(
      `CREATE VIEW ${CX_SCHEMA}.documents AS
         SELECT id, (metadata->>'title') || ' — ' || (metadata->>'section') AS title,
                content AS body, embedding
           FROM ${CX_SCHEMA}.document_chunks`,
    );
    for (const [id, vec] of vectors) {
      await client.query(`UPDATE ${CX_SCHEMA}.documents SET embedding = $1::vector WHERE id = $2`, [vec, id]);
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  return { updated: vectors.length, dim: emb.dim };
}

/** 코퍼스를 주 임베더로 되돌린다.
 *
 * ★ 이 복원은 **반드시** 돌아야 한다. 종전에는 루프 뒤 평범한 문장이라, 비교
 * 변종 하나가 죽으면(예: 컨테이너에 nomic-embed-text 가 없어 404) 복원에 도달하지
 * 못한 채 종료했고 **코퍼스가 비워진 상태로 남았다.** 그 뒤 ask/demo 의 벡터 후보가
 * 0건이 됐다(실측: 종단 근거 포함 17/19 -> 13/19).
 *
 * 평가 도구는 자기가 건드린 상태를 원위치시켜야 한다. 그러지 않으면 그 도구는
 * 측정 도구가 아니라 부작용이다. */
async function restoreCorpus(pool: Pool, primary: Embedder) {
  const restored = await realignAndBackfill(pool, primary);
  console.log(`\n코퍼스를 주 임베더로 복원: ${primary.name} ${JSON.stringify(restored)}`);
  return restored;
}

async function main() {
  const dir = datasetDir();
  const here = dirname(fileURLToPath(import.meta.url));
  const root = resolve(here, "../../..");
  const goldFile = JSON.parse(await readFile(resolve(root, "eval/companyx/vector_gold.json"), "utf8")) as {
    oracle: string;
    items: GoldItem[];
  };

  // Raw corpus for the lexical oracle.
  const index: { id: string; type: string; filename: string }[] = JSON.parse(
    await readFile(join(dir, "documents", "index.json"), "utf8"),
  );
  const text = new Map<string, string>();
  const typeOf = new Map<string, string>();
  for (const e of index) {
    text.set(e.id, (await readFile(join(dir, "documents", e.filename), "utf8")).toLowerCase());
    typeOf.set(e.id, e.type);
  }
  const goldDocs = (item: GoldItem): string[] =>
    item.keywords.length
      ? index.map((e) => e.id).filter((id) => item.keywords.every((kw) => text.get(id)!.includes(kw.toLowerCase())))
      : [];

  // 이 평가는 companyx 전용이다. 다른 프로파일로 돌리면 주 임베더의 차원이
  // companyx 스키마와 어긋나 복원이 실패하고 코퍼스가 빈 채 남는다(QA 재현).
  // 설정이 아니라 대상이 정해진 도구이므로 여기서 못 박는다.
  if ((process.env.DATASET ?? "") !== "companyx") {
    console.error("\n이 평가는 DATASET=companyx 로 실행해야 한다.");
    console.error("  다른 프로파일에서는 임베딩 차원이 어긋나 복원이 실패하고 코퍼스가 비워진다.\n");
    console.error("  DATASET=companyx EMBEDDER=ollama OLLAMA_HOST=... node dist/cli/companyx-vector-eval.js\n");
    process.exitCode = 1;
    return;
  }

  const pool = getPool();
  const k = Number(process.env.CX_TOPK ?? 5);
  // Compared head to head because the choice decides whether the sponsor's
  // vector(768) DDL is used verbatim: nomic-embed-text emits 768, BGE-M3 1024.
  const embedders: Embedder[] = [new HashEmbedder()];
  if (process.env.EMBEDDER === "ollama" || process.env.CX_COMPARE === "1") {
    for (const spec of (process.env.CX_MODELS ?? "bge-m3,bge-m3@768,bge-m3@512,nomic-embed-text").split(",")) {
      const [model, trunc] = spec.trim().split("@");
      const e = new OllamaEmbedder(model);
      embedders.push(trunc ? new TruncatedEmbedder(e, Number(trunc)) : e);
    }
  }

  const results: Record<string, unknown> = {};
  const skipped: string[] = [];
  for (const emb of embedders) {
    // 변종 하나가 죽어도 나머지 비교와 복원은 계속 간다. 컨테이너에 특정
    // 모델이 없을 수 있고(실측: nomic-embed-text 404), 그 하나 때문에 코퍼스를
    // 잃는 것은 측정이 아니라 사고다.
    try {
      // 변종마다 자기 벡터로 코퍼스를 채운다. 폭 정렬과 백필은 한 트랜잭션이라
      // 중간에 죽어도 부분 상태가 남지 않는다.
      const backfill = await realignAndBackfill(pool, emb);
      const rows = [];
      let hits = 0,
        scoredHit = 0,
        typeSum = 0,
        typeScored = 0;
      for (const item of goldFile.items) {
        const res = await vectorSearch(pool, emb, item.q, k, `${CX_SCHEMA}.documents`);
        if (!res.ok) throw new Error(`vector search failed: ${res.error}`);
        // chunk title is "<doc title> — <section>"; recover the doc id via the chunk row
        const ids = await pool.query<{ id: number; doc_id: string }>(
          `SELECT id, doc_id FROM ${CX_SCHEMA}.document_chunks WHERE id = ANY($1::int[])`,
          [res.hits.map((h) => h.id)],
        );
        const docOf = new Map(ids.rows.map((r) => [r.id, r.doc_id]));
        const retrieved = res.hits.map((h) => docOf.get(h.id)!).filter(Boolean);
        const gold = goldDocs(item);
        const hit = gold.length ? retrieved.some((d) => gold.includes(d)) : null;
        if (hit !== null) {
          scoredHit++;
          if (hit) hits++;
        }
        let typeAcc: number | null = null;
        if (item.type) {
          typeAcc = retrieved.filter((d) => typeOf.get(d) === item.type).length / Math.max(1, retrieved.length);
          typeSum += typeAcc;
          typeScored++;
        }
        rows.push({
          q: item.q,
          gold_n: gold.length,
          gold,
          retrieved,
          top_scores: res.hits.map((h) => Number(h.score.toFixed(3))),
          [`hit@${k}`]: hit,
          expected_type: item.type,
          type_precision: typeAcc === null ? null : Number(typeAcc.toFixed(2)),
        });
        console.log(
          `[${emb.name}] ${hit === null ? "----" : hit ? "HIT " : "MISS"} type_p=${typeAcc?.toFixed(2) ?? "-"} :: ${item.q}`,
        );
      }
      results[emb.name] = {
        embedder: emb.name,
        dim: backfill.dim,
        chunks: backfill.updated,
        [`hit@${k}`]: scoredHit ? Number((hits / scoredHit).toFixed(3)) : null,
        scored_questions: scoredHit,
        mean_type_precision: typeScored ? Number((typeSum / typeScored).toFixed(3)) : null,
        rows,
      };
    } catch (e) {
      skipped.push(`${emb.name}: ${String(e).split("\n")[0].slice(0, 120)}`);
      console.error(`[skip] ${emb.name} — ${String(e).split("\n")[0]}`);
    }
  }

  // ── 코퍼스를 주 임베더로 되돌린다 ─────────────────────────────────────
  //
  // 위 루프는 변종마다 코퍼스를 재임베딩한다. 그대로 끝내면 DB에는 마지막
  // 변종(기본 순서상 nomic-embed-text, hit@5 0.380)의 벡터가 남고, 이후의
  // ask/demo가 조용히 무너진다. 실측: 종단 근거 포함 89.5% -> 68.4%.
  //
  // 평가 도구는 자기가 건드린 상태를 원위치시켜야 한다. 그러지 않으면 그 도구는
  // 측정 도구가 아니라 부작용이다.
  const primary = getEmbedder();
  const restored = await restoreCorpus(pool, primary);

  const out = {
    input_hashes: await inputHashes(root, ["eval/companyx/vector_gold.json"]),
    corpus_restored_to: primary.name,
    skipped_embedders: skipped,
    dataset: "companyx-dataset-v1.0 / documents (40 docs, 258 chunks)",
    top_k: k,
    oracle: goldFile.oracle,
    summary: Object.fromEntries(
      Object.entries(results).map(([name, r]) => {
        const v = r as Record<string, unknown>;
        return [name, { [`hit@${k}`]: v[`hit@${k}`], mean_type_precision: v.mean_type_precision, dim: v.dim }];
      }),
    ),
    detail: results,
    generated_at: new Date().toISOString(),
  };
  await mkdir(resolve(root, "eval/results"), { recursive: true });
  await writeFile(resolve(root, "eval/results/companyx-vector.json"), JSON.stringify(out, null, 2) + "\n");
  console.log(`\ncompanyx:vector ${JSON.stringify(out.summary, null, 2)}`);
  await closePool();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
