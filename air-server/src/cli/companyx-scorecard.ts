// 기능테스트 스코어카드 — 사업자 예시 30문항을 실제 ask() 로 돌려 **최종 답이 맞았는지**를
// 한 화면에 보인다.
//
// companyx:ask 는 근거가 컨텍스트에 들어왔는지(검색)와 답이 지어낸 개체가 없는지(접지)를
// 잰다. 기능테스트는 그것을 묻지 않는다 — 「답이 정답과 같은가」 하나다. 라우팅이 맞아도
// 답이 틀리면 오답이고, 라우팅이 달라도 답이 맞으면 정답이다(리원에이스 멘토링).
// 그래서 판정은 답 문자열과 정답 파일만 본다. 규칙은 src/scorecard.ts 머리말에 있다.
//
// 파이프라인을 다시 짜지 않는다. MCP `ask` 도구가 부르는 것과 같은 ask() 를 같은 기본값
// (읽기 풀, 기본 예산)으로 부른다 — 심사자가 보는 답이 여기서 채점되는 답이다.
//
// 실행: npm run companyx:score                 30문항, 정본 eval/results/companyx-scorecard.json 을 쓴다
//       npm run companyx:score -- --limit 3    앞 3문항만. 정본은 쓰지 않는다
//       npm run companyx:score -- --from <json> 모델 없이 저장된 답만 다시 채점한다(규칙을 고쳤을 때)
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { cpus, totalmem, platform, release, arch } from "node:os";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPool, getReadPool } from "../db.js";
import { getEmbedder } from "../embedder.js";
import { ask } from "../pipeline.js";
import { DEFAULT_MODEL } from "../llm.js";
import { probeOllama, reportOllama } from "../preflight.js";
import { shutdown } from "../exit.js";
import {
  loadQuestions,
  loadGraph,
  datasetDir,
  requireDataset,
  requireCompanyxProfile,
  kgGoldIds,
  type CxQuestion,
  type KgSpec,
} from "../companyx.js";
import {
  LANE_ROUTE,
  STATE_LABEL,
  answerState,
  buildCatalog,
  scoreSql,
  scoreKg,
  scoreVector,
  latency,
  selfCheckPrimitives,
  askedColumns,
  type AnswerState,
  type Lane,
  type SqlGold,
  type VectorGold,
  type Verdict,
} from "../scorecard.js";

const OUT = "eval/results/companyx-scorecard.json";
const GOLD_FILES = ["eval/companyx/sql_gold.jsonl", "eval/companyx/kg_gold.json", "eval/companyx/vector_gold.json"];
const ANSWER_CAP = 1800; // verify-no-dataset-redistribution 의 상한(2000자) 안쪽

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** 줄바꿈을 정규화한 내용 해시 — companyx:ask 와 같은 규칙이라 metrics-check 가 같은 식으로 검산한다. */
const hash = (text: string) => createHash("sha256").update(text.replace(/\r\n/g, "\n")).digest("hex").slice(0, 16);

/** 터미널 폭. 한글은 두 칸이다 — 안 세면 표가 어긋난다. */
const width = (s: string) => [...s].reduce((w, ch) => w + (/[ᄀ-ᇿ㄰-㆏가-힯]/.test(ch) ? 2 : 1), 0);
const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - width(s)));
const lpad = (s: string, w: number) => " ".repeat(Math.max(0, w - width(s))) + s;
const cut = (s: string, w: number) => {
  let out = "";
  for (const ch of s) {
    if (width(out + ch) > w - 1) return `${out}…`;
    out += ch;
  }
  return out;
};

const SHORT: Record<string, string> = {
  nl2sql: "sql",
  vector_search: "vector",
  knowledge_graph: "graph",
  structured: "sql",
  semantic: "vector",
  graph: "graph",
  hybrid: "hybrid",
};

interface Row {
  i: number;
  q: string;
  lane: Lane;
  routed: string;
  route_match: boolean;
  answer_correct: boolean;
  reason: string;
  state: AnswerState;
  ms: number;
  required: string[];
  missing: string[];
  extra: string[];
  anchors?: string[];
  gold_source?: string;
  branch_errors: string[];
  /** 큐레이션이 남긴 항목과 예산 때문에 뺀 항목 — 목록 답의 누락이 모델 탓인지 예산 탓인지 가른다 */
  context_items?: { kept: number; dropped: number };
  answer: string;
}

/** 저장된 답만 다시 채점할 때의 입력. 스코어카드 행과 companyx-ask.json 행 둘 다 받는다. */
interface StoredRow {
  q: string;
  answer: string;
  ms?: number;
  routed?: string;
  lane_routed?: string;
  state?: AnswerState;
  branch_errors?: string[];
}

function storedState(r: StoredRow): AnswerState {
  if (r.state) return r.state;
  const errs = r.branch_errors ?? [];
  if (errs.some((e) => e.startsWith("answer:"))) return "generation_failed";
  if (r.answer.startsWith("조회에 실패")) return "retrieval_failed";
  return errs.length ? "degraded" : "ok";
}

function tableHeader() {
  console.log(`\n ${lpad("#", 2)}  ${pad("레인", 7)}${pad("라우트", 8)}${pad("정답", 5)}${pad("상태", 10)}${lpad("ms", 7)}  이유 / 질문`);
  console.log(" " + "-".repeat(96));
}

function tableRow(r: Row) {
  const routed = SHORT[r.routed] ?? r.routed;
  const why = r.answer_correct ? "" : `[${r.reason}] `;
  console.log(
    ` ${lpad(String(r.i), 2)}  ${pad(SHORT[r.lane], 7)}${pad(r.route_match ? routed : `${routed}≠`, 8)}` +
      `${pad(r.answer_correct ? "O" : "X", 5)}${pad(STATE_LABEL[r.state], 10)}${lpad(String(r.ms), 7)}  ${cut(why + r.q, 58)}`,
  );
}

async function main() {
  requireDataset();
  requireCompanyxProfile();
  const limit = Number(arg("--limit") ?? 0);
  const from = arg("--from");
  const dir = datasetDir();

  const all: CxQuestion[] = await loadQuestions(dir);
  const partial = Number.isFinite(limit) && limit > 0 && limit < all.length;
  const questions = partial ? all.slice(0, limit) : all;

  // ── 정답 준비 — 모델을 부르기 전에 전부 계산한다 ─────────────────────
  const goldText = Object.fromEntries(
    await Promise.all(GOLD_FILES.map(async (f) => [f, await readFile(resolve(root, f), "utf8")] as const)),
  );
  const sqlGoldList = goldText["eval/companyx/sql_gold.jsonl"]
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as { id: string; q: string; gold: string; ordered?: boolean });
  const kgGoldList = JSON.parse(goldText["eval/companyx/kg_gold.json"]) as { q: string; spec: KgSpec }[];
  const vecGold = JSON.parse(goldText["eval/companyx/vector_gold.json"]) as {
    items: { q: string; keywords: string[]; type?: string | null; gold_docs?: string[] }[];
  };

  const { nodes, edges } = await loadGraph(dir);
  const cat = buildCatalog(nodes);
  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  const index = JSON.parse(await readFile(join(dir, "documents", "index.json"), "utf8")) as {
    id: string;
    type: string;
    filename: string;
  }[];
  const docs = await Promise.all(
    index.map(async (e) => ({ ...e, text: await readFile(join(dir, "documents", e.filename), "utf8") })),
  );

  const sqlGold = new Map<string, SqlGold>();
  const pool = getPool();
  try {
    for (const g of sqlGoldList) {
      const res = await pool.query(g.gold);
      const rows = res.rows as Record<string, unknown>[];
      const limited = /\bLIMIT\s+\d+\s*$/i.test(g.gold);
      // LIMIT 경계의 동점. 정렬 값이 SELECT 에 있을 때만 알 수 있다(가장 많은 프로젝트: Client-AC 와
      // Client-E 가 둘 다 4건). 정렬 값이 없으면 동점을 모르므로 허용하지 않는다 — 보수 쪽이다.
      let tied: string[] = [];
      if (limited && rows.length) {
        const cols = Object.keys(rows[0]);
        const asked = askedColumns(rows, true);
        const helpers = cols.filter((c) => !asked.includes(c) && !/^id$|_id$/.test(c));
        if (helpers.length && asked.length) {
          const last = rows[rows.length - 1];
          const every = await pool.query(g.gold.replace(/\bLIMIT\s+\d+\s*$/i, ""));
          tied = (every.rows as Record<string, unknown>[])
            .filter((r) => helpers.every((h) => String(r[h]) === String(last[h])))
            .map((r) => String(r[asked[0]]));
        }
      }
      sqlGold.set(g.q, { rows, ordered: Boolean(g.ordered), limited, tied });
    }
  } catch (e) {
    console.error(`\n정답 SQL 을 실행하지 못했다: ${e instanceof Error ? e.message : String(e)}`);
    console.error("  DATABASE_URL 이 살아 있는지, npm run companyx:load 로 적재했는지 확인한다.");
    console.error("  정답 없이는 채점하지 않는다 — 모델도 부르지 않았다.\n");
    await shutdown(1);
  }

  const kgGold = new Map(
    kgGoldList.map((g) => {
      const ids = kgGoldIds(g.spec, nodes, edges);
      return [
        g.q,
        {
          names: ids.map((id) => nodeById.get(id)?.name ?? id),
          kind: ids.length ? nodeById.get(ids[0])?.type : undefined,
          absent: g.spec.kind === "absent",
        },
      ] as const;
    }),
  );

  // 사업자 힌트가 말하는 문서 유형. vector_gold 에 항목이 없는 4문항의 정답 문서를 여기서 정한다.
  const HINT_TYPES: [RegExp, string][] = [
    [/장애\s*보고서/, "incident_report"],
    [/회의록/, "meeting_note"],
    [/제안서/, "proposal"],
    [/기술\s*문서|가이드|레퍼런스|매뉴얼/, "technical_doc"],
  ];
  function vectorGold(item: CxQuestion): VectorGold {
    const v = vecGold.items.find((x) => x.q === item.q);
    const pick = (ids: string[], source: string): VectorGold => ({
      keywords: v?.keywords ?? [],
      docs: docs.filter((d) => ids.includes(d.id)).map((d) => ({ id: d.id, text: d.text })),
      source,
    });
    if (v?.gold_docs?.length) {
      return pick(v.gold_docs.filter((f) => f.endsWith(".md")).map((f) => f.replace(/\.md$/, "")), "vector_gold.gold_docs");
    }
    if (v?.keywords.length) {
      // vector_gold 의 신탁 규칙 그대로: 키워드를 전부 담은 문서가 정답 문서다.
      const kws = v.keywords.map((k) => k.toLowerCase());
      return pick(docs.filter((d) => kws.every((k) => d.text.toLowerCase().includes(k))).map((d) => d.id), "vector_gold.keywords");
    }
    if (v?.type) return pick(docs.filter((d) => d.type === v.type).map((d) => d.id), "vector_gold.type");
    const types = HINT_TYPES.filter(([re]) => re.test(item.hint)).map(([, t]) => t);
    return pick(docs.filter((d) => types.includes(d.type)).map((d) => d.id), `questions.hint(${types.join("+") || "없음"})`);
  }

  function judge(item: CxQuestion, answer: string, state: AnswerState): Verdict & { gold_source?: string } {
    if (item.tool === "nl2sql") {
      const g = sqlGold.get(item.q);
      if (!g) return { correct: false, reason: "정답 SQL 없음", required: [], missing: [], extra: [] };
      return scoreSql(answer, item.q, g, cat, state);
    }
    if (item.tool === "knowledge_graph") {
      const g = kgGold.get(item.q);
      if (!g) return { correct: false, reason: "그래프 정답 없음", required: [], missing: [], extra: [] };
      return scoreKg(answer, item.q, g, cat, state);
    }
    const g = vectorGold(item);
    return { ...scoreVector(answer, item.q, g, cat, state), gold_source: g.source };
  }

  // ── 자기 점검: 정답을 정답으로, 기권을 오답으로 가르는가 ──────────────
  //
  // 규칙이 정답 자체를 오답으로 판정하면 표의 모든 X 가 의심스러워진다. 정답 값을 이어 붙인
  // 「모범 답」과 기권 문장으로 30문항 전부를 한 번 돌려 본다. 모델 호출 없이 1초 안에 끝난다.
  {
    const fails = selfCheckPrimitives();
    const ABST = "주어진 정보로는 알 수 없습니다.";
    for (const item of all) {
      let ideal: string | null = null;
      if (item.tool === "nl2sql") {
        const g = sqlGold.get(item.q);
        const cols = g ? askedColumns(g.rows, g.limited) : [];
        ideal = g ? g.rows.map((r) => cols.map((c) => String(r[c])).join(" ")).join(", ") : null;
      } else if (item.tool === "knowledge_graph") {
        const g = kgGold.get(item.q);
        ideal = g ? (g.absent ? "해당 고객사는 데이터셋에 존재하지 않아 알 수 없습니다." : [...new Set(g.names)].join(", ")) : null;
      } else {
        const g = vectorGold(item);
        const fact = g.docs
          .map((d) => d.text.match(/\d{4}-\d{2}-\d{2}|\d+\s?(?:GB|%|초|분|시간|일|개월|건)/)?.[0])
          .find((a) => a && !item.q.includes(a));
        ideal = fact ? `${g.keywords.join(" ")} ${fact}`.trim() : null;
      }
      if (ideal === null) {
        fails.push(`모범 답을 만들 수 없다 — 정답이 비었다: ${item.q}`);
        continue;
      }
      const good = judge(item, ideal, "ok");
      if (!good.correct) fails.push(`모범 답이 오답으로 나온다(${good.reason}): ${item.q}`);
      const absent = kgGold.get(item.q)?.absent === true;
      if (judge(item, ABST, "ok").correct !== absent) fails.push(`기권 판정이 거꾸로다: ${item.q}`);
    }
    if (fails.length) {
      console.error("\n채점기 자기 점검 실패 — 모델을 부르기 전에 멈춘다:");
      for (const f of fails) console.error(`  - ${f}`);
      await shutdown(1);
    }
    console.log(`[채점기] 자기 점검 통과 — ${all.length}문항의 모범 답은 정답, 기권은 오답(부재 개체 1건은 반대)으로 가른다.`);
  }

  // ── 실행 ────────────────────────────────────────────────────────────
  const stored = from
    ? new Map(
        ((JSON.parse(await readFile(resolve(root, from), "utf8")) as { rows: StoredRow[] }).rows ?? []).map((r) => [r.q, r]),
      )
    : null;
  const model = process.env.OLLAMA_MODEL ?? DEFAULT_MODEL;
  const host = process.env.OLLAMA_HOST ?? "http://localhost:11434";
  if (!stored) {
    const probe = await probeOllama(host);
    if (!reportOllama(probe, [model, process.env.EMBED_MODEL ?? "bge-m3"])) await shutdown(1);
  } else {
    console.log(`[재채점] ${from} 의 저장된 답을 다시 채점한다. 모델을 부르지 않고 정본도 쓰지 않는다.`);
  }

  const embedder = getEmbedder();
  const budget = process.env.CX_BUDGET ? Number(process.env.CX_BUDGET) : undefined;
  const rows: Row[] = [];
  tableHeader();
  for (const [n, item] of questions.entries()) {
    let answer: string, ms: number, routed: string, state: AnswerState, errs: string[];
    let items: Row["context_items"];
    if (stored) {
      const s = stored.get(item.q);
      if (!s) {
        console.log(` ${lpad(String(n + 1), 2)}  (저장된 답 없음) ${item.q}`);
        continue;
      }
      answer = s.answer;
      ms = s.ms ?? 0;
      routed = s.routed ?? s.lane_routed ?? "?";
      state = storedState(s);
      errs = s.branch_errors ?? [];
    } else {
      const t0 = Date.now();
      const r = await ask(item.q, { pool: getReadPool(), embedder, budget });
      ms = Date.now() - t0;
      answer = r.answer;
      routed = r.route;
      state = answerState(r);
      errs = r.audit.branch_errors;
      items = { kept: r.audit.curate.kept.length, dropped: r.audit.curate.dropped.length };
    }
    const v = judge(item, answer, state);
    const flat = answer.replace(/\s+/g, " ").trim();
    const row: Row = {
      i: n + 1,
      q: item.q,
      lane: item.tool,
      routed,
      route_match: LANE_ROUTE[item.tool] === routed,
      answer_correct: v.correct,
      reason: v.reason,
      state,
      ms,
      required: v.required,
      missing: v.missing,
      extra: v.extra,
      ...(v.anchors ? { anchors: v.anchors } : {}),
      ...(v.gold_source ? { gold_source: v.gold_source } : {}),
      branch_errors: errs,
      ...(items ? { context_items: items } : {}),
      // 판정은 전문으로 했다. 저장만 상한 안에서 자른다(재배포 금지 조건의 길이 상한).
      answer: flat.length > ANSWER_CAP ? `${flat.slice(0, ANSWER_CAP)}…(전체 ${flat.length}자, 판정은 전문으로 했다)` : flat,
    };
    rows.push(row);
    tableRow(row);
  }

  // ── 요약 ────────────────────────────────────────────────────────────
  const frac = (xs: Row[], f: (r: Row) => boolean) => `${xs.filter(f).length}/${xs.length}`;
  const lanes: Lane[] = ["nl2sql", "vector_search", "knowledge_graph"];
  const by_lane = Object.fromEntries(
    lanes.map((l) => {
      const xs = rows.filter((r) => r.lane === l);
      return [
        l,
        {
          correct: frac(xs, (r) => r.answer_correct),
          correct_n: xs.filter((r) => r.answer_correct).length,
          n: xs.length,
          ...latency(xs.map((r) => r.ms)),
          route_match: frac(xs, (r) => r.route_match),
        },
      ];
    }),
  ) as Record<Lane, { correct: string; correct_n: number; n: number; median_ms: number | null; p90_ms: number | null; route_match: string }>;
  const overall = { correct: frac(rows, (r) => r.answer_correct), ...latency(rows.map((r) => r.ms)) };
  const states = Object.fromEntries(
    (Object.keys(STATE_LABEL) as AnswerState[]).map((s) => [s, rows.filter((r) => r.state === s).length]),
  ) as Record<AnswerState, number>;
  // 라우팅이 달랐는데 답이 맞은 것, 라우팅이 맞았는데 답이 틀린 것 — 채점 기준이 가르는 두 칸.
  const routeOffRight = rows.filter((r) => !r.route_match && r.answer_correct).length;
  const routeOnWrong = rows.filter((r) => r.route_match && !r.answer_correct).length;

  console.log(" " + "-".repeat(96));
  console.log(`\n ${pad("레인", 8)}${pad("정답", 8)}${lpad("중앙값 ms", 11)}${lpad("p90 ms", 9)}   라우트 일치`);
  for (const l of lanes) {
    const s = by_lane[l];
    console.log(` ${pad(SHORT[l], 8)}${pad(s.correct, 8)}${lpad(String(s.median_ms ?? "-"), 11)}${lpad(String(s.p90_ms ?? "-"), 9)}   ${s.route_match}`);
  }
  console.log(` ${pad("전체", 8)}${pad(overall.correct, 8)}${lpad(String(overall.median_ms ?? "-"), 11)}${lpad(String(overall.p90_ms ?? "-"), 9)}   ${frac(rows, (r) => r.route_match)}`);
  console.log(
    `\n 상태: ${(Object.keys(states) as AnswerState[]).map((s) => `${STATE_LABEL[s]} ${states[s]}`).join(", ")}` +
      `\n 라우트가 달랐지만 답이 맞음 ${routeOffRight}건, 라우트가 맞았지만 답이 틀림 ${routeOnWrong}건` +
      `\n 모델 ${model}, 임베더 ${embedder.name}, Ollama ${host}`,
  );

  if (stored || partial) {
    console.log(
      `\n[${stored ? "재채점" : `부분 실행 --limit ${limit}`}] 정본 ${OUT} 는 쓰지 않는다 — 전량 수치는 그 파일을 본다.`,
    );
    await shutdown(0);
  }
  // 전 문항이 조회 실패면 0점이 아니라 DB 가 없는 것이다. 그 표를 정본으로 남기지 않는다.
  if (rows.length && rows.every((r) => r.state === "retrieval_failed")) {
    console.error("\n실패: 전 문항이 조회 실패다 — 코퍼스를 못 읽었다. 정본을 쓰지 않았다.\n");
    await shutdown(1);
  }

  // ── 정본 기록 ────────────────────────────────────────────────────────
  const git = (args: string[]): string | null => {
    try {
      return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    } catch {
      return null; // git 이 없는 배포본 — 커밋을 모른다고 적는다
    }
  };
  const ollamaGet = async (path: string): Promise<unknown> => {
    try {
      const res = await fetch(`${host.replace(/\/$/, "")}${path}`, { signal: AbortSignal.timeout(5000) });
      return res.ok ? await res.json() : null;
    } catch {
      return null; // 기록용 부가 정보다. 못 읽었으면 null 로 남긴다
    }
  };
  const ps = (await ollamaGet("/api/ps")) as { models?: { name: string; size_vram?: number }[] } | null;
  const loaded = ps?.models?.map((m) => ({ name: m.name, size_vram: m.size_vram ?? null })) ?? null;
  const cpu = cpus();
  const summary = {
    dataset: "companyx-dataset-v1.0 / questions.json (기능테스트 스코어카드: 최종 답 일치)",
    rule: "판정은 최종 답과 정답 파일만 본다. 라우팅은 판정에 쓰지 않는다. 레인별 규칙은 air-server/src/scorecard.ts 머리말.",
    input_hashes: Object.fromEntries(GOLD_FILES.map((f) => [f, hash(goldText[f])])),
    dataset_questions_sha: hash(await readFile(join(dir, "questions.json"), "utf8")),
    git_commit: git(["rev-parse", "--short", "HEAD"]),
    git_dirty: (git(["status", "--porcelain", "--", "air-server/src"]) ?? "") !== "",
    model,
    embedder: embedder.name,
    budget: budget ?? null,
    budget_note: "null 이면 MCP ask 도구와 같은 파이프라인 기본 예산이다",
    ollama_host: host,
    ollama_version: ((await ollamaGet("/api/version")) as { version?: string } | null)?.version ?? null,
    // 적재된 모델의 VRAM 이 0 이면 CPU 추론이다. 설정이 아니라 Ollama 가 보고한 값이다.
    ollama_loaded: loaded,
    inference: loaded?.length ? (loaded.every((m) => !m.size_vram) ? "cpu" : "gpu") : null,
    host: {
      platform: platform(),
      release: release(),
      arch: arch(),
      node: process.version,
      cpu_model: cpu[0]?.model.trim() ?? null,
      cpu_cores: cpu.length,
      mem_gb: Math.round(totalmem() / 1024 ** 3),
    },
    n: rows.length,
    correct: overall.correct,
    correct_pct: Number(((rows.filter((r) => r.answer_correct).length / rows.length) * 100).toFixed(1)),
    median_ms: overall.median_ms,
    p90_ms: overall.p90_ms,
    by_lane,
    route_match: frac(rows, (r) => r.route_match),
    route_off_answer_right: routeOffRight,
    route_on_answer_wrong: routeOnWrong,
    states,
    latency_rule: "ms 는 ask() 한 번의 벽시계 시간(조회+생성). 중앙값은 정렬 후 floor(n/2) 번째(companyx:ask 와 같음), p90 은 최근접 순위.",
    redaction_note:
      "answer 는 시스템이 생성한 출력이며 채점 근거로서 보존한다. 원문 인용이 포함될 수 있으나 문서 전문이 아니라 " +
      "답변에 필요한 범위다. anchors 는 정답 문서에서 확인한 짧은 사실 토큰이고 문서 본문은 싣지 않는다.",
    generated_at: new Date().toISOString(),
  };
  await mkdir(resolve(root, "eval/results"), { recursive: true });
  await writeFile(resolve(root, OUT), JSON.stringify({ summary, rows }, null, 2) + "\n");
  console.log(`\n정본을 썼다: ${OUT}`);
  // 대본의 표와 증거 매니페스트는 이 파일에서 만든다. 안 돌리면 CI 가 어긋남으로 멈춘다.
  console.log("  이어서(저장소 루트에서): node scripts/scorecard-docs.mjs --write && node scripts/evidence-manifest.mjs --write");
  await shutdown(0);
}

main().catch(async (e) => {
  console.error(e);
  await shutdown(1);
});
