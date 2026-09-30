// 규칙-시맨틱 경계 실측 — 규칙이 어디까지 믿을 만하고 어디서부터 시맨틱에 넘길지를
// 데이터로 정한다(리원에이스 멘토링 09-22 제안).
//
// 개발용 문항만 쓴다: 사업자 공개 30문항, 홀드아웃 1·2차. 셋 다 라우터를 고치면서
// 이미 본 문항이다. 여기서 고른 경계값이 일반화되는지는 이 파일이 답하지 않는다 —
// 수정 전에 봉인한 홀드아웃 3차(`npm run companyx:holdout3`)가 답한다.
//
// 산출:
//   1. 규칙만, 시맨틱만의 정확도.
//   2. 규칙 격차 구간별로 두 방식의 정확도. 규칙이 이기는 구간과 지는 구간의 경계.
//   3. 경계값 후보(규칙 격차 τ × 시맨틱 격차 σ) 격자의 결합 정확도.
//   4. 배포된 상수(RULE_MIN_MARGIN, SEMANTIC_MIN_MARGIN)로 routeQuery 를 실제로 돌린 값.
//      3의 격자는 모사이고, 4는 배포 함수 자체다. 둘이 어긋나면 실패로 끝낸다.
//
// 사용: npm run companyx:boundary   (EMBEDDER=ollama 필요)
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { requireCompanyxProfile, loadGraph } from "../companyx.js";
import { route, installOntology, RULE_MIN_MARGIN, type Lane } from "../router.js";
import { routeQuery, semanticVerdict, installSemanticRouter, SEMANTIC_MIN_MARGIN } from "../semroute.js";
import { getEmbedder } from "../embedder.js";

const LANE: Record<string, string> = {
  structured: "nl2sql",
  semantic: "vector_search",
  graph: "knowledge_graph",
  hybrid: "hybrid",
};

const DEV_SETS: { name: string; path: string; label: "tool" | "expected" }[] = [
  { name: "sponsor30", path: "datasets/companyx-v1.0/questions.json", label: "tool" },
  { name: "holdout1", path: "eval/companyx/holdout_route.json", label: "expected" },
  { name: "holdout2", path: "eval/companyx/holdout2_route.json", label: "expected" },
];

interface Row {
  set: string;
  q: string;
  expected: string;
  rule: string;
  rule_margin: number;
  semantic: Lane;
  semantic_margin: number;
  deployed: string;
}

function combine(r: Row, tau: number, sigma: number): string {
  const confident = r.rule !== "hybrid" && r.rule_margin >= tau;
  if (confident) return r.rule;
  return r.semantic_margin >= sigma ? r.semantic : r.rule;
}

async function main() {
  requireCompanyxProfile();
  if ((process.env.EMBEDDER ?? "hash") !== "ollama") {
    console.error("경계 실측은 시맨틱 폴백을 재는 것이라 EMBEDDER=ollama 가 필요하다.");
    process.exit(2);
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const root = resolve(here, "../../..");
  const { nodes, edges } = await loadGraph();
  installOntology(nodes, edges);
  const embedder = getEmbedder();
  const sem = await installSemanticRouter(embedder);
  if (sem.error) throw new Error(`시맨틱 앵커 임베딩 실패: ${sem.error}`);

  const rows: Row[] = [];
  const input_hashes: Record<string, string> = {};
  for (const set of DEV_SETS) {
    const text = await readFile(resolve(root, set.path), "utf8");
    input_hashes[set.path] = createHash("sha256").update(text.replace(/\r\n/g, "\n")).digest("hex").slice(0, 16);
    const raw = JSON.parse(text);
    const items: { q: string; expected: string }[] = (Array.isArray(raw) ? raw : raw.items).map(
      (x: Record<string, string>) => ({ q: x.q, expected: x[set.label] }),
    );
    for (const it of items) {
      const d = route(it.q);
      const v = (await semanticVerdict(it.q, embedder))!;
      const deployed = await routeQuery(it.q, embedder);
      rows.push({
        set: set.name,
        q: it.q,
        expected: it.expected,
        rule: LANE[d.route],
        rule_margin: d.gate.margin,
        semantic: v.lane,
        semantic_margin: Number(v.margin.toFixed(4)),
        deployed: LANE[deployed.route],
      });
    }
  }

  const acc = (f: (r: Row) => string) => rows.filter((r) => f(r) === r.expected).length;
  const n = rows.length;

  // 규칙 격차 구간별 비교. hybrid 는 규칙이 판단을 포기한 구간이다.
  const bucketOf = (r: Row) => (r.rule === "hybrid" ? "hybrid(판단 포기)" : `margin ${r.rule_margin}`);
  const buckets: Record<string, { n: number; rule: number; semantic: number }> = {};
  for (const r of rows) {
    const b = (buckets[bucketOf(r)] ??= { n: 0, rule: 0, semantic: 0 });
    b.n++;
    if (r.rule === r.expected) b.rule++;
    if (r.semantic === r.expected) b.semantic++;
  }

  const TAUS = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, Infinity];
  const SIGMAS = [0, 0.02, 0.05, 0.1];
  const grid = TAUS.flatMap((tau) =>
    SIGMAS.map((sigma) => ({ tau: tau === Infinity ? "inf" : tau, sigma, correct: acc((r) => combine(r, tau, sigma)) })),
  );

  const simulated = acc((r) => combine(r, RULE_MIN_MARGIN, SEMANTIC_MIN_MARGIN));
  const deployed = acc((r) => r.deployed);
  const mismatch = rows.filter((r) => combine(r, RULE_MIN_MARGIN, SEMANTIC_MIN_MARGIN) !== r.deployed);

  const bySet = Object.fromEntries(
    DEV_SETS.map((s) => {
      const rs = rows.filter((r) => r.set === s.name);
      const c = (f: (r: Row) => string) => rs.filter((r) => f(r) === r.expected).length;
      return [s.name, { n: rs.length, rule_only: c((r) => r.rule), semantic_only: c((r) => r.semantic), deployed: c((r) => r.deployed) }];
    }),
  );

  const out = {
    note:
      "개발용 문항(사업자 30, 홀드아웃 1·2차)에서 규칙과 시맨틱의 경계를 잰 결과. 이 문항들은 라우터를 고치며 본 것이라 " +
      "일반화 수치가 아니다. 일반화는 수정 전에 봉인한 홀드아웃 3차가 잰다. grid 는 상수 후보의 모사, deployed 는 " +
      "배포 상수로 routeQuery 를 실제로 돌린 값이다.",
    input_hashes,
    embedder: embedder.name,
    semantic_anchors: sem.anchors,
    constants: { RULE_MIN_MARGIN, SEMANTIC_MIN_MARGIN },
    n,
    rule_only: acc((r) => r.rule),
    semantic_only: acc((r) => r.semantic),
    deployed,
    by_set: bySet,
    buckets,
    grid,
    rows,
    generated_at: new Date().toISOString(),
  };
  await mkdir(resolve(root, "eval/results"), { recursive: true });
  await writeFile(resolve(root, "eval/results/companyx-route-boundary.json"), JSON.stringify(out, null, 2) + "\n");

  console.log(`n=${n}  규칙만 ${out.rule_only}  시맨틱만 ${out.semantic_only}  배포(τ=${RULE_MIN_MARGIN}, σ=${SEMANTIC_MIN_MARGIN}) ${deployed}`);
  console.log(JSON.stringify(bySet));
  console.log("구간별 (n / 규칙 / 시맨틱):");
  for (const [b, v] of Object.entries(buckets).sort()) console.log(`  ${b.padEnd(18)} ${v.n} / ${v.rule} / ${v.semantic}`);
  console.log("격자 (τ, σ → 정답):");
  for (const g of grid) console.log(`  τ=${g.tau} σ=${g.sigma} → ${g.correct}`);
  if (mismatch.length || simulated !== deployed) {
    console.error(`FAIL: 모사(${simulated})와 배포 함수(${deployed})가 ${mismatch.length}건 어긋난다`);
    for (const r of mismatch) console.error(`  ${r.q}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
