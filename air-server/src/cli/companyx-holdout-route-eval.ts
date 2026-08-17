// 홀드아웃 라우팅 평가 — 사업자 공개 30문항과 겹치지 않는 문구로 라우터를 잰다.
//
// 왜 이게 다른가. 공개 30문항 30/30은 라우터 어휘를 그 문항을 읽으며 작성한 in-sample
// 수치다. 이 평가는 라우터가 한 번도 보지 않은 문구로 묻는다. 그래서 결과가 낮게
// 나오는 것이 오히려 의미 있다.
//
// 라벨은 스키마/온톨로지의 라우팅 신호로 정한다(평가자가 보고 맞춘 것이 아니다).
// 라우터는 질문 문장만 보고 어떤 도구를 호출할지 고른다.
//
// 사용: DATASET=companyx node dist/cli/companyx-holdout-route-eval.js
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { route, installOntology, SQL_TOOL, VECTOR_TOOL, ONTOLOGY_TOOL, GRAPH_TOOL } from "../router.js";

/** 데이터셋 그래프 노드에서 엔티티 사전을 만든다(오프라인 평가 경로).
 * 운영 경로는 DB에서 만든다 — server.ts 참조. */
async function installLexiconFromDataset(): Promise<number> {
  const { loadGraph } = await import("../companyx.js");
  const { nodes, edges } = await loadGraph();
  const n = installOntology(nodes, edges).entities;
  console.log(`entity lexicon: ${n}개 (데이터셋 그래프 노드)`);
  return n;
}


async function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = resolve(here, "../../..");
  // 평가셋과 출력 경로는 환경변수로 갈아끼운다. 1차 홀드아웃은 라우터 결함을
  // 진단하는 데 썼으므로 더 이상 홀드아웃이 아니고, 2차 이후를 같은 도구로 잰다.
  const goldPath = process.env.HOLDOUT ?? "eval/companyx/holdout_route.json";
  const outPath = process.env.OUT ?? "eval/results/companyx-holdout-route.json";
  const gold = JSON.parse(await readFile(resolve(root, goldPath), "utf8")) as {
    items: { q: string; expected: string }[];
  };
  console.log(`gold=${goldPath}`);
  const lexSize = await installLexiconFromDataset();

  // 라우팅 결과를 기대 라벨로 매핑한다. 라우터가 고른 레인과 평가자가 정한 신호 라벨을
  // 같은 공간에 둔다.
  const LANE: Record<string, string> = {
    structured: "nl2sql",
    semantic: "vector_search",
    graph: "knowledge_graph",
    hybrid: "hybrid",
  };

  // 기대 레인이 실제로 호출되는가를 도구 목록으로 판정한다. 라벨 문자열 일치는
  // 엄격 지표이고, 이쪽은 "그 레인에 닿기는 했는가"라는 도달 지표다.
  // 둘을 나누는 이유: fan-out으로 기대 레인을 포함해 연 경우는 답이 나올 수
  // 있으므로 라벨 불일치와 같은 실패로 셀 수 없다. 반대로 닿지도 못한 것은
  // 변명의 여지가 없는 실패다. 이 구분을 사람이 적지 않고 코드가 판정한다.
  const LANE_TOOLS: Record<string, string[]> = {
    nl2sql: [SQL_TOOL],
    vector_search: [VECTOR_TOOL],
    knowledge_graph: [ONTOLOGY_TOOL, GRAPH_TOOL],
  };

  type Row = {
    q: string;
    expected: string;
    got: string;
    lane: string;
    hit: boolean;
    reached: boolean;
    tools: string[];
    rationale: string;
  };
  const rows: Row[] = [];
  let hits = 0;
  let reachedCount = 0;
  for (const item of gold.items) {
    const d = route(item.q);
    const got = LANE[d.route] ?? d.route;
    const hit = got === item.expected;
    const want = LANE_TOOLS[item.expected] ?? [];
    // 기대 레인의 도구 중 하나라도 실제 호출 목록에 있으면 도달로 센다.
    const reached = want.length > 0 && want.some((t) => d.tools.includes(t));
    if (hit) hits++;
    if (reached) reachedCount++;
    rows.push({
      q: item.q,
      expected: item.expected,
      got,
      lane: d.route,
      hit,
      reached,
      tools: d.tools,
      rationale: d.rationale,
    });
    const mark = hit ? "HIT " : reached ? "FAN " : "MISS";
    console.log(`${mark} 기대=${item.expected} 실제=${got} :: ${item.q}`);
  }

  // 혼동 행렬 — 어디를 어디로 헷갈리는지.
  const confusion: Record<string, number> = {};
  for (const r of rows) {
    if (!r.hit) confusion[`${r.expected} -> ${r.got}`] = (confusion[`${r.expected} -> ${r.got}`] ?? 0) + 1;
  }

  const total = gold.items.length;
  const conservativeFanout = rows.filter((r) => !r.hit && r.reached).length;
  const trueMiss = rows.filter((r) => !r.reached).length;

  // 결과가 자기 입력의 내용 해시를 들고 다닌다. 입력이 바뀌면 이 결과는 더 이상
  // 그 입력에 대한 측정이 아니다 — mtime 과 달리 clone·복사·touch 에 흔들리지 않는다.
  const input_hashes: Record<string, string> = {
    // 줄바꿈을 정규화하고 해시한다 — git 이 OS 마다 CRLF/LF 를 바꾸므로 원시 바이트를
    // 해시하면 같은 내용이 다른 해시가 된다. 재려는 것은 인코딩이 아니라 내용이다.
    [goldPath]: createHash("sha256")
      .update((await readFile(resolve(root, goldPath), "utf8")).replace(/\r\n/g, "\n"))
      .digest("hex")
      .slice(0, 16),
  };

  const out = {
    input_hashes,
    gold: goldPath,
    entity_lexicon_size: lexSize,
    note:
      "홀드아웃 라우팅 평가. 사업자 공개 30문항과 어휘가 겹치지 않는 30문항. " +
      "라벨은 스키마/온톨로지 신호로 정하고 라우터는 질문 문장만 본다. " +
      "strict_accuracy = 라벨 문자열 일치. coverage = 기대 레인의 도구가 실제 호출 목록에 포함된 비율. " +
      "conservative_fanout = 라벨은 틀렸지만 기대 레인을 함께 연 것(답은 나올 수 있다). " +
      "true_miss = 기대 레인에 닿지도 못한 것. 이 셋은 전부 tools 배열에서 기계적으로 판정하며 손으로 적지 않는다.",
    total,
    correct: hits,
    accuracy: Number((hits / total).toFixed(3)),
    summary: {
      total,
      correct: hits,
      strict_accuracy: Number((hits / total).toFixed(3)),
      conservative_fanout: conservativeFanout,
      true_miss: trueMiss,
      coverage: Number((reachedCount / total).toFixed(3)),
    },
    confusion,
    rows,
    generated_at: new Date().toISOString(),
  };
  await mkdir(resolve(root, "eval/results"), { recursive: true });
  await writeFile(resolve(root, outPath), JSON.stringify(out, null, 2) + "\n");
  console.log(`\n${JSON.stringify(out.summary, null, 2)}`);
  console.log(`confusion: ${JSON.stringify(confusion)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
