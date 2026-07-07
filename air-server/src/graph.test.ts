// Graph tool tests — live bench KG (run after gen:bench). node dist/graph.test.js
import { getPool, closePool } from "./db.js";
import { ontologySearch, graphExpand, ontologyCandidates, edgeCandidates } from "./graph.js";

let pass = 0, fail = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { pass++; } else { fail++; console.error("  FAIL:", msg); }
}

async function main() {
  const pool = getPool();

  // alias resolution: '전자제품' -> 전자기기 (category), 'electronics' too
  const o1 = await ontologySearch(pool, "전자제품 환불 정책", 10);
  ok(o1.ok, "ontologySearch ok");
  ok(o1.hits.some((h) => h.canonicalName === "전자기기" && h.via === "alias"), `alias 전자제품->전자기기 (got ${JSON.stringify(o1.hits.map((h) => h.canonicalName))})`);
  ok(o1.hits.some((h) => h.canonicalName === "환불 정책" && h.via === "canonical"), "canonical 환불 정책 matched");
  const oEn = await ontologySearch(pool, "electronics", 5);
  ok(oEn.ok && oEn.hits.some((h) => h.canonicalName === "전자기기"), "en alias electronics->전자기기");

  // graph.expand: 환불 정책 (entity 1001) -applies_to-> categories
  const g1 = await graphExpand(pool, 1001, 1, ["applies_to"]);
  ok(g1.ok, "graphExpand ok");
  const dsts = g1.edges.map((e) => e.dstName).sort();
  ok(JSON.stringify(dsts) === JSON.stringify(["의류", "전자기기", "식품"].sort()),
    `환불정책 applies_to {의류,전자기기,식품} (got ${JSON.stringify(dsts)})`);
  ok(g1.edges.every((e) => e.relType === "applies_to" && e.provenance.length > 0), "edges carry rel_type + provenance");

  // graph.expand: product entity (101) -in_category-> exactly one category
  const g2 = await graphExpand(pool, 101, 1, ["in_category"]);
  ok(g2.ok && g2.edges.length === 1 && g2.edges[0].relType === "in_category", `product->category single edge (got ${g2.edges.length})`);
  ok(g2.edges[0].dstType === "category", "in_category dst is a category entity");

  // candidates carry canonical keys (for 3-way RRF agreement)
  const oc = ontologyCandidates(o1.hits);
  ok(oc.every((c) => c.canonicalKey.startsWith("entity:") && c.source === "graph"), "ontology candidates are canonical graph candidates");
  const ec = edgeCandidates(g1.edges);
  ok(ec.every((c) => c.canonicalKey.startsWith("entity:category#") && c.source === "graph"), "edge candidates key by dst category entity");

  // depth + rel_type filter: no filter returns >= filtered count
  const gAll = await graphExpand(pool, 1001, 1);
  ok(gAll.edges.length >= g1.edges.length, "unfiltered expand >= filtered");

  await closePool();
  console.log(`\ngraph.test: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
