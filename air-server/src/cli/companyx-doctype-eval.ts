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

// 문서 질문의 최종 목록 순위 — 답 단계가 받는 목록에서 첫 정답 문서가 몇 번째인가.
//
// companyx:vector 와 companyx:hybrid 는 벡터 레인 상위 k 만 잰다. 7B 가 받는 것은 그 뒤의 목록이다: 라우터가 레인을 고르고,
// 레인 결과를 RRF 로 합치고, 큐레이터가 예산 안에서 남긴 것(retrieve().curated.kept, RRF 순서). 이 평가는 그 목록을 잰다.
// 라우터는 서버와 같은 상태다(initRouting). 정형 레인의 생성 SQL 만 부르지 않는다 — nl2sql 자리에 null 을 넣어 7B 없이 돈다.
// 그래서 hybrid 로 간 문항은 실제 ask 보다 생성 SQL 행이 빠진 목록이다. 결정론 SQL(제품 상태)과 그래프 레인, 문서 개수 길은 그대로 돈다.
//
// 세트(개발용): sponsor30   사업자 예시 vector 10문항. 정답 문서는 스코어카드와 같은 규칙(vector_gold → 힌트의 문서 유형)
//              vector_gold eval/companyx/vector_gold.json 에서 사업자 문항을 뺀 나머지. 정답은 그 파일의 신탁(gold_docs → keywords → type)
//              holdout1·2  eval/companyx/doc_gold_holdout12.json 의 정답 문서(같은 신탁, 2차는 basis 유형으로 좁힘)
//              holdout3·4  각 문항의 gold_docs
// 봉인 홀드아웃은 읽지 않는다. 세트 목록은 아래 SETS 에 박혀 있고 환경변수로 늘릴 수 없다.
//
// 구성(CX_CONFIGS, 기본은 넷 다): base           배포 기본값(밀집 레인만)
//                                 filter         DOC_TYPE_FILTER=1 (질문 유형이 확실하면 문서 레인을 그 유형으로 거른다)
//                                 hybrid         KEYWORD_LANE=1 (밀집 + 키워드를 RRF 로)
//                                 hybrid_filter  둘 다
// 지표: hit@1, hit@3, hit@5, MRR. 순위는 목록 항목 기준(item, 표제)과 서로 다른 문서 기준(doc) 둘 다 적는다. 정답 문서가 목록에
// 없으면 순위 없음(MRR 0)이다.
//
// 실행(air-server 에서 빌드한 뒤):
//   node scripts/with-env.mjs DATASET=companyx EMBEDDER=ollama -- dist/cli/companyx-doctype-eval.js
//   CX_OUT=eval/results/companyx-doctype-base.json CX_CONFIGS=base,hybrid … 로 결과 파일과 구성을 바꾼다.
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getReadPool } from "../db.js";
import { getEmbedder } from "../embedder.js";
import { initRouting } from "../routerinit.js";
import { retrieve, type RetrieveResult } from "../pipeline.js";
import { keywordIndexReady } from "../keyword.js";
import { questionDocType } from "../doctype.js";
import { shutdown } from "../exit.js";
import { CX_SCHEMA, assertCorpusEmbedder, datasetDir, loadQuestions, requireCompanyxProfile, requireDataset } from "../companyx.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");

const SETS = ["sponsor30", "vector_gold", "holdout1", "holdout2", "holdout3", "holdout4"] as const;
type SetName = (typeof SETS)[number];
const HOLDOUT_ROUTE: Record<"holdout1" | "holdout2" | "holdout3" | "holdout4", string> = {
  holdout1: "eval/companyx/holdout_route.json",
  holdout2: "eval/companyx/holdout2_route.json",
  holdout3: "eval/companyx/holdout3_route.json",
  holdout4: "eval/companyx/holdout4_route.json",
};
const GOLD_H12 = "eval/companyx/doc_gold_holdout12.json";
const VECTOR_GOLD = "eval/companyx/vector_gold.json";

const CONFIGS = {
  base: { DOC_TYPE_FILTER: undefined, KEYWORD_LANE: undefined },
  filter: { DOC_TYPE_FILTER: "1", KEYWORD_LANE: undefined },
  hybrid: { DOC_TYPE_FILTER: undefined, KEYWORD_LANE: "1" },
  hybrid_filter: { DOC_TYPE_FILTER: "1", KEYWORD_LANE: "1" },
} as const;
type ConfigName = keyof typeof CONFIGS;

interface DevItem {
  set: SetName;
  id: string;
  q: string;
  gold: string[];
  goldSource: string;
  unscorable?: string;
}

interface Doc {
  id: string;
  type: string;
  title: string;
  text: string;
}

const hash = (text: string) => createHash("sha256").update(text.replace(/\r\n/g, "\n")).digest("hex").slice(0, 16);
const stripMd = (f: string) => f.replace(/\.md$/, "");
const byKeywords = (docs: Doc[], kws: string[], type?: string | null) =>
  docs
    .filter((d) => !type || d.type === type)
    .filter((d) => kws.every((k) => d.text.toLowerCase().includes(k.toLowerCase())))
    .map((d) => d.id);

/** 스코어카드(companyx-scorecard.ts vectorGold)와 같은 규칙. 사업자 힌트가 말하는 문서 유형. */
const HINT_TYPES: [RegExp, string][] = [
  [/장애\s*보고서/, "incident_report"],
  [/회의록/, "meeting_note"],
  [/제안서/, "proposal"],
  [/기술\s*문서|가이드|레퍼런스|매뉴얼/, "technical_doc"],
];

async function loadDevItems(docs: Doc[]): Promise<{ items: DevItem[]; inputs: Record<string, string> }> {
  const inputs: Record<string, string> = {};
  const read = async (f: string) => {
    const text = await readFile(resolve(root, f), "utf8");
    inputs[f] = hash(text);
    return JSON.parse(text);
  };
  const vg = (await read(VECTOR_GOLD)) as {
    items: { q: string; keywords: string[]; type?: string | null; gold_docs?: string[]; style?: string }[];
  };
  const fromVectorGold = (v: (typeof vg.items)[number]): { gold: string[]; source: string } => {
    if (v.gold_docs?.length) return { gold: v.gold_docs.filter((f) => f.endsWith(".md")).map(stripMd), source: "vector_gold.gold_docs" };
    if (v.keywords.length) return { gold: byKeywords(docs, v.keywords), source: "vector_gold.keywords" };
    if (v.type) return { gold: docs.filter((d) => d.type === v.type).map((d) => d.id), source: "vector_gold.type" };
    return { gold: [], source: "none" };
  };

  const items: DevItem[] = [];
  // sponsor30: 사업자 예시 30문항 중 vector_search.
  const sponsor = (await loadQuestions(datasetDir())).filter((x) => x.tool === "vector_search");
  sponsor.forEach((s, i) => {
    const v = vg.items.find((x) => x.q === s.q);
    let g = v ? fromVectorGold(v) : { gold: [] as string[], source: "none" };
    if (!g.gold.length) {
      const types = HINT_TYPES.filter(([re]) => re.test(s.hint)).map(([, t]) => t);
      g = { gold: docs.filter((d) => types.includes(d.type)).map((d) => d.id), source: `questions.hint(${types.join("+") || "없음"})` };
    }
    items.push({ set: "sponsor30", id: `s30-v${i + 1}`, q: s.q, gold: g.gold, goldSource: g.source });
  });
  // vector_gold: 사업자 문항을 뺀 나머지(중복 집계를 막는다).
  const sponsorQ = new Set(sponsor.map((s) => s.q));
  vg.items
    .filter((v) => !sponsorQ.has(v.q))
    .forEach((v, i) => {
      const g = fromVectorGold(v);
      items.push({ set: "vector_gold", id: `vg-${i + 1}`, q: v.q, gold: g.gold, goldSource: g.source, ...(g.gold.length ? {} : { unscorable: "정답 문서 없음" }) });
    });
  // holdout1, holdout2: 라벨은 doc_gold_holdout12.json.
  const h12 = (await read(GOLD_H12)) as { items: { set: string; q: string; keywords?: string[]; type?: string | null; unscorable?: string }[] };
  for (const set of ["holdout1", "holdout2"] as const) {
    const route = (await read(HOLDOUT_ROUTE[set])) as { items: { q: string; expected: string }[] };
    route.items.forEach((it, i) => {
      if (it.expected !== "vector_search") return;
      const lab = h12.items.find((x) => x.set === set && x.q === it.q);
      const id = `${set === "holdout1" ? "h1" : "h2"}-${i + 1}`;
      if (!lab) {
        items.push({ set, id, q: it.q, gold: [], goldSource: "none", unscorable: `${GOLD_H12} 에 라벨이 없다` });
        return;
      }
      if (lab.unscorable) {
        items.push({ set, id, q: it.q, gold: [], goldSource: GOLD_H12, unscorable: lab.unscorable });
        return;
      }
      const gold = byKeywords(docs, lab.keywords ?? [], lab.type);
      items.push({ set, id, q: it.q, gold, goldSource: GOLD_H12, ...(gold.length ? {} : { unscorable: "라벨 규칙에 맞는 문서 없음" }) });
    });
  }
  // holdout3, holdout4: 문항의 gold_docs.
  for (const set of ["holdout3", "holdout4"] as const) {
    const route = (await read(HOLDOUT_ROUTE[set])) as { items: { id: string; q: string; expected: string; gold_docs?: string[] }[] };
    for (const it of route.items) {
      if (it.expected !== "vector_search") continue;
      const gold = (it.gold_docs ?? []).map(stripMd);
      items.push({ set, id: it.id, q: it.q, gold, goldSource: "gold_docs", ...(gold.length ? {} : { unscorable: "gold_docs 없음" }) });
    }
  }
  return { items, inputs };
}

interface Ranks {
  /** 목록 항목 기준 순위(1부터). 정답 문서가 없으면 null. */
  item: number | null;
  /** 서로 다른 문서 기준 순위. */
  doc: number | null;
  /** 목록에 나온 문서를 처음 나온 차례로(앞 8건). */
  docs: string[];
  route: string;
  lanes: string[];
  kept: number;
  doc_type?: unknown;
}

function ranksOf(r: RetrieveResult, gold: string[], docOfChunk: Map<number, string>, docOfTitle: Map<string, string>): Ranks {
  const docIds = r.curated.kept.map((it) => {
    const m = /^(?:documents|keyword)#(\d+)$/.exec(it.source);
    if (m) return docOfChunk.get(Number(m[1])) ?? null;
    if (/^documents#t\d+$/.test(it.source)) return docOfTitle.get(it.text.replace(/^\[문서\]\s*/, "")) ?? null;
    return null;
  });
  const itemIdx = docIds.findIndex((d) => d !== null && gold.includes(d));
  const distinct: string[] = [];
  for (const d of docIds) if (d && !distinct.includes(d)) distinct.push(d);
  const docIdx = distinct.findIndex((d) => gold.includes(d));
  const audit = r.audit as Record<string, unknown> | undefined;
  return {
    item: itemIdx >= 0 ? itemIdx + 1 : null,
    doc: docIdx >= 0 ? docIdx + 1 : null,
    docs: distinct.slice(0, 8),
    route: r.route,
    lanes: r.fusion_lanes ?? [],
    kept: r.curated.kept.length,
    ...(audit && "doc_type" in audit ? { doc_type: audit.doc_type } : {}),
  };
}

function metrics(ranks: (number | null)[]) {
  const n = ranks.length;
  const at = (k: number) => (n ? Number((ranks.filter((r) => r !== null && r <= k).length / n).toFixed(3)) : null);
  return {
    n,
    "hit@1": at(1),
    "hit@3": at(3),
    "hit@5": at(5),
    mrr: n ? Number((ranks.reduce<number>((s, r) => s + (r ? 1 / r : 0), 0) / n).toFixed(3)) : null,
  };
}

async function main() {
  requireDataset();
  requireCompanyxProfile();
  const configs = (process.env.CX_CONFIGS ?? "base,filter,hybrid,hybrid_filter")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean) as ConfigName[];
  const unknown = configs.filter((c) => !(c in CONFIGS));
  if (unknown.length) {
    console.error(`\n모르는 구성: ${unknown.join(", ")}. 가능한 값: ${Object.keys(CONFIGS).join(", ")}\n`);
    return shutdown(1);
  }
  const out = process.env.CX_OUT ?? "eval/results/companyx-doctype.json";

  const dir = datasetDir();
  const index = JSON.parse(await readFile(join(dir, "documents", "index.json"), "utf8")) as { id: string; type: string; title: string; filename: string }[];
  const docs: Doc[] = await Promise.all(
    index.map(async (e) => ({ id: e.id, type: e.type, title: e.title, text: await readFile(join(dir, "documents", e.filename), "utf8") })),
  );
  const { items, inputs } = await loadDevItems(docs);

  const pool = getReadPool();
  const embedder = getEmbedder();
  const routing = await initRouting();
  // 코퍼스 벡터가 지금 임베더로 채워졌는지 먼저 본다. 아니면 검색은 오류 없이 엉뚱한 조각을 돌려준다.
  let corpusCos: number;
  try {
    corpusCos = await assertCorpusEmbedder(pool, embedder);
  } catch (e) {
    console.error(`
${e instanceof Error ? e.message : String(e)}
`);
    return shutdown(1);
  }
  const chunkRows = await pool.query<{ id: number; doc_id: string }>(`SELECT id, doc_id FROM ${CX_SCHEMA}.document_chunks`);
  const docOfChunk = new Map(chunkRows.rows.map((r) => [Number(r.id), r.doc_id]));
  const docOfTitle = new Map(index.map((e) => [e.title, e.id]));
  if (configs.some((c) => CONFIGS[c].KEYWORD_LANE === "1") && !(await keywordIndexReady(pool, `${CX_SCHEMA}.document_chunks`))) {
    console.error("\n키워드 색인이 없다 — hybrid 구성은 밀집만 재게 된다. 먼저 DATASET=companyx node dist/cli/keyword-index.js 를 돌린다.\n");
    return shutdown(1);
  }

  const scorable = items.filter((i) => !i.unscorable);
  console.log(
    `[세트] ${SETS.map((s) => `${s} ${scorable.filter((i) => i.set === s).length}/${items.filter((i) => i.set === s).length}`).join(", ")} (채점 가능/전체)`,
  );
  console.log(`[구성] ${configs.join(", ")}  [임베더] ${embedder.name}`);

  const saved = { DOC_TYPE_FILTER: process.env.DOC_TYPE_FILTER, KEYWORD_LANE: process.env.KEYWORD_LANE };
  const rows: Record<string, unknown>[] = [];
  for (const item of items) {
    const cls = questionDocType(item.q);
    const goldTypes = [...new Set(item.gold.map((g) => docs.find((d) => d.id === g)?.type))];
    const row: Record<string, unknown> = {
      set: item.set,
      id: item.id,
      q: item.q,
      gold: item.gold,
      gold_source: item.goldSource,
      gold_types: goldTypes,
      ...(item.unscorable ? { unscorable: item.unscorable } : {}),
      classifier: { type: cls.type, basis: cls.basis, cues: cls.cues.map((c) => `${c.kind ? "kind" : "topic"}:${c.type}:${c.word}`) },
    };
    if (!item.unscorable) {
      for (const c of configs) {
        for (const [k, v] of Object.entries(CONFIGS[c])) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
        const r = await retrieve(item.q, { pool, embedder, nl2sql: async () => null, repair: false });
        row[c] = ranksOf(r, item.gold, docOfChunk, docOfTitle);
      }
      const marks = configs.map((c) => `${c}=${(row[c] as Ranks).item ?? "-"}`).join(" ");
      console.log(`${item.id.padEnd(8)} ${marks.padEnd(48)} cls=${cls.type ?? "-"} gold=${goldTypes.join("+")} :: ${item.q}`);
    }
    rows.push(row);
  }
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }

  const summarize = (filter: (r: Record<string, unknown>) => boolean) =>
    Object.fromEntries(
      configs.map((c) => {
        const rs = rows.filter((r) => !r.unscorable && filter(r)).map((r) => r[c] as Ranks);
        return [c, { item: metrics(rs.map((x) => x.item)), doc: metrics(rs.map((x) => x.doc)) }];
      }),
    );
  const summary = Object.fromEntries([
    ...SETS.map((s) => [s, summarize((r) => r.set === s)] as const),
    ["total", summarize(() => true)] as const,
  ]);
  const scored = rows.filter((r) => !r.unscorable);
  const classifier = {
    filtered: scored.filter((r) => (r.classifier as { type: string | null }).type).length,
    scored: scored.length,
    // 거른 유형이 정답 문서 유형에 들었나(정답이 여러 유형이면 그중 하나면 맞다).
    right: scored.filter((r) => {
      const t = (r.classifier as { type: string | null }).type;
      return t && (r.gold_types as string[]).includes(t);
    }).length,
    wrong: scored
      .filter((r) => {
        const t = (r.classifier as { type: string | null }).type;
        return t && !(r.gold_types as string[]).includes(t);
      })
      .map((r) => ({ id: r.id, q: r.q, type: (r.classifier as { type: string }).type, gold_types: r.gold_types })),
  };

  const result = {
    what: "문서 질문의 최종 목록(retrieve().curated.kept) 순위. 표제는 item(목록 항목 기준), doc 은 서로 다른 문서 기준.",
    sql_lane: "nl2sql 을 부르지 않았다(null). hybrid 로 간 문항은 생성 SQL 행이 빠진 목록이다.",
    configs,
    embedder: embedder.name,
    corpus_embedder_cosine: Number(corpusCos.toFixed(4)),
    routing,
    database: (() => {
      try {
        const u = new URL(process.env.DATABASE_URL ?? "postgresql://localhost:5433/mcpdata");
        return `${u.hostname}:${u.port}/${u.pathname.replace(/^\//, "")}`;
      } catch {
        return "(주소 형식 불명)";
      }
    })(),
    input_hashes: inputs,
    summary,
    classifier,
    rows,
    generated_at: new Date().toISOString(),
  };
  await mkdir(dirname(resolve(root, out)), { recursive: true });
  await writeFile(resolve(root, out), JSON.stringify(result, null, 2) + "\n");

  const fmt = (m: ReturnType<typeof metrics>) => `${m["hit@1"]}/${m["hit@3"]}/${m["hit@5"]} mrr ${m.mrr}`;
  console.log(`\n세트별 hit@1/hit@3/hit@5, MRR (목록 항목 기준) → ${out}`);
  for (const s of [...SETS, "total"] as const) {
    const sm = summary[s] as Record<string, { item: ReturnType<typeof metrics> }>;
    console.log(`  ${s.padEnd(12)} n=${String(sm[configs[0]].item.n).padEnd(3)} ${configs.map((c) => `${c}: ${fmt(sm[c].item)}`).join("  |  ")}`);
  }
  console.log(`  분류기: 거른 문항 ${classifier.filtered}/${classifier.scored}, 정답 유형과 맞음 ${classifier.right}, 틀림 ${classifier.wrong.length}`);
  return shutdown(0);
}

main().catch(async (e) => {
  console.error(e);
  await shutdown(1);
});
