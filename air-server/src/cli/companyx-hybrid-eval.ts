// 하이브리드 검색 평가 — 밀집만, 희소만, 그리고 둘을 RRF로 합친 것을 같은 문항으로 잰다.
//
// 왜 이 하네스가 따로 필요한가. 기존 벡터 평가는 임베더를 갈아 끼우며 임베딩 컬럼을
// 다시 채운다(파괴적이고 느리다). 여기서 재고 싶은 것은 임베딩 모델이 아니라
// **레인 구성**이므로, 기존 임베딩을 그대로 두고 검색 방식만 바꾼다.
//
// 오라클은 벡터 평가와 같다: 문서가 정답인 조건은 gold 키워드를 전부 포함하는 것이고,
// 검색기는 질문 문장만 본다. 즉 정답 집합은 시스템과 독립이다.
//
// 사용: EMBEDDER=ollama DATASET=companyx node dist/cli/companyx-hybrid-eval.js
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { closePool, getPool } from "../db.js";
import { getEmbedder } from "../embedder.js";
import { keywordIndexReady, keywordSearch } from "../keyword.js";
import { rrfMerge, type Ranked } from "../rrf.js";
import { datasetDir } from "../companyx.js";
import { vectorSearch } from "../vector.js";

interface GoldItem {
  q: string;
  type: string | null;
  keywords: string[];
  style?: string;
}

const TABLE = "companyx.document_chunks";
const VIEW = "companyx.documents";

function wilson(k: number, n: number): [number, number] {
  if (!n) return [0, 0];
  const z = 1.96;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Number((c - h).toFixed(3)), Number((c + h).toFixed(3))];
}

async function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = resolve(here, "../../..");
  const goldFile = JSON.parse(
    await readFile(resolve(root, "eval/companyx/vector_gold.json"), "utf8"),
  ) as { oracle: string; items: GoldItem[] };

  const dir = datasetDir();
  const index: { id: string; type: string; filename: string }[] = JSON.parse(
    await readFile(join(dir, "documents", "index.json"), "utf8"),
  );
  const text = new Map<string, string>();
  for (const e of index) text.set(e.id, (await readFile(join(dir, "documents", e.filename), "utf8")).toLowerCase());
  const goldDocs = (item: GoldItem): string[] =>
    item.keywords.length
      ? index.map((e) => e.id).filter((id) => item.keywords.every((kw) => text.get(id)!.includes(kw.toLowerCase())))
      : [];

  const pool = getPool();
  const embedder = getEmbedder();
  const k = Number(process.env.CX_TOPK ?? 5);

  if (!(await keywordIndexReady(pool, TABLE))) {
    console.error("키워드 색인이 없습니다. 먼저 `node dist/cli/keyword-index.js`를 돌리세요.");
    process.exit(2);
  }

  const docOf = async (ids: number[]): Promise<Map<number, string>> => {
    const r = await pool.query<{ id: number; doc_id: string }>(
      `SELECT id, doc_id FROM ${TABLE} WHERE id = ANY($1::int[])`,
      [ids],
    );
    return new Map(r.rows.map((row) => [row.id, row.doc_id]));
  };

  // gated: 무조건 융합하지 않고 규칙으로 켠다. 가중치가 아니라 조건이므로
  // "튜닝 파라미터 0"이 유지된다. 조건은 둘이다.
  //   (1) 질의에 식별자꼴 토큰이 있다 (영문+숫자 혼합, 예: Product-C1, p99, 330ms)
  //   (2) 밀집 레인이 아무것도 못 찾았다
  const identifierLike = (q: string) => /[A-Za-z]+[-_]?\d|\d+\s*(ms|gb|mb|초|일|분|%)/i.test(q);
  const configs = ["dense", "keyword", "hybrid", "gated"] as const;
  // hit@5만 보면 안 된다. 문서가 40건인데 슬롯이 5개라 천장에 붙는다.
  // 순위 품질은 hit@1과 MRR이 가른다.
  const stats: Record<string, { hit: number; hit1: number; rr: number; scored: number; rows: unknown[] }> = {
    dense: { hit: 0, hit1: 0, rr: 0, scored: 0, rows: [] },
    keyword: { hit: 0, hit1: 0, rr: 0, scored: 0, rows: [] },
    hybrid: { hit: 0, hit1: 0, rr: 0, scored: 0, rows: [] },
    gated: { hit: 0, hit1: 0, rr: 0, scored: 0, rows: [] },
  };

  for (const item of goldFile.items) {
    const gold = goldDocs(item);
    if (!gold.length) continue;

    const dense = await vectorSearch(pool, embedder, item.q, k, VIEW);
    const kw = await keywordSearch(pool, item.q, k, TABLE);

    const denseIds = dense.ok ? dense.hits.map((h) => h.id) : [];
    const kwIds = kw.ok ? kw.hits.map((h) => h.id) : [];

    // 하이브리드는 파이프라인과 같은 방식으로 합친다: 같은 key 규칙 + RRF.
    // 제네릭 rrfMerge를 쓰는 이유는 여기서 필요한 것이 문서 id 순위뿐이기 때문이다.
    const denseList: Ranked<number>[] = denseIds.map((id) => ({ key: `documents#${id}`, value: id }));
    const kwList: Ranked<number>[] = kwIds.map((id) => ({ key: `documents#${id}`, value: id }));
    const fused = rrfMerge([denseList, kwList])
      .slice(0, k)
      .map((c) => c.value);

    const map = await docOf([...new Set([...denseIds, ...kwIds, ...fused])]);
    const toDocs = (ids: number[]) => ids.map((id) => map.get(id)!).filter(Boolean);

    for (const cfg of configs) {
      const gatedOn = identifierLike(item.q) || denseIds.length === 0;
      const ids =
        cfg === "dense"
          ? denseIds
          : cfg === "keyword"
            ? kwIds
            : cfg === "hybrid"
              ? fused
              : gatedOn
                ? fused
                : denseIds;
      const retrieved = toDocs(ids);
      const firstGoldAt = retrieved.findIndex((d) => gold.includes(d)); // 0-based
      const hit = firstGoldAt >= 0;
      stats[cfg].scored++;
      if (hit) stats[cfg].hit++;
      if (firstGoldAt === 0) stats[cfg].hit1++;
      if (hit) stats[cfg].rr += 1 / (firstGoldAt + 1);
      stats[cfg].rows.push({
        q: item.q,
        style: item.style ?? null,
        gold,
        retrieved,
        hit,
        rank: hit ? firstGoldAt + 1 : null,
        ...(cfg === "gated" ? { gate: gatedOn ? "hybrid" : "dense" } : {}),
      });
    }
  }

  const summary: Record<string, unknown> = {};
  for (const cfg of configs) {
    const s = stats[cfg];
    const [lo, hi] = wilson(s.hit, s.scored);
    const byStyle = (style: string) => {
      const rows = (s.rows as { style: string | null; hit: boolean }[]).filter((r) => r.style === style);
      return rows.length ? `${rows.filter((r) => r.hit).length}/${rows.length}` : "-";
    };
    summary[cfg] = {
      [`hit@${k}`]: Number((s.hit / s.scored).toFixed(3)),
      "hit@1": Number((s.hit1 / s.scored).toFixed(3)),
      mrr: Number((s.rr / s.scored).toFixed(3)),
      scored: s.scored,
      ci95_hit5: [lo, hi],
      entity: byStyle("entity"),
      paraphrase: byStyle("paraphrase"),
    };
  }

  // 하이브리드가 어떤 문항에서 밀집을 이겼고 어디서 졌는지. 총점보다 이쪽이 정보다.
  const denseRows = stats.dense.rows as { q: string; hit: boolean; rank: number | null }[];
  const hybridRows = stats.hybrid.rows as { q: string; hit: boolean; rank: number | null }[];
  const gained = denseRows.filter((d, i) => !d.hit && hybridRows[i].hit).map((d) => d.q);
  const lost = denseRows.filter((d, i) => d.hit && !hybridRows[i].hit).map((d) => d.q);
  // 순위가 오른 문항과 내린 문항. hit이 같아도 순위는 움직인다.
  const rankUp = denseRows
    .filter((d, i) => d.rank && hybridRows[i].rank && hybridRows[i].rank! < d.rank!)
    .map((d, i) => d.q);
  const rankDown = denseRows
    .filter((d, i) => d.rank && hybridRows[i].rank && hybridRows[i].rank! > d.rank!)
    .map((d) => d.q);

  const out = {
    dataset: "companyx-dataset-v1.0 / documents",
    top_k: k,
    oracle: goldFile.oracle,
    embedder: embedder.name,
    summary,
    hybrid_vs_dense: { gained, lost, net: gained.length - lost.length, rank_up: rankUp, rank_down: rankDown },
    detail: stats,
    note:
      "키워드 레인은 normalize.ts의 정규화 계약을 통과한 토큰을 simple 설정 tsvector에 넣어 만든다. 색인과 질의가 같은 함수를 쓴다.",
    generated_at: new Date().toISOString(),
  };
  await mkdir(resolve(root, "eval/results"), { recursive: true });
  await writeFile(resolve(root, "eval/results/companyx-hybrid.json"), JSON.stringify(out, null, 2) + "\n");
  console.log(JSON.stringify({ summary, hybrid_vs_dense: out.hybrid_vs_dense }, null, 2));
  await closePool();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
