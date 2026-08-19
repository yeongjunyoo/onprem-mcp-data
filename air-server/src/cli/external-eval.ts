// Gate5 — EXTERNAL calibration on BIRD Mini-Dev (SQLite), execution accuracy.
//
// Objectivity anchor: a recognized public text-to-SQL benchmark with 500
// instances over 11 cross-domain databases (formula_1, financial, superhero,
// ...). We run the SAME on-prem Qwen2.5-7B NL2SQL approach (schema card +
// BIRD oracle "evidence") over each DB's real DDL, execute the predicted and
// gold SQL against the actual SQLite database, and compare RESULT SETS
// (BIRD-style execution accuracy: multiset of value-tuples, row-order
// insensitive). No LLM judge — the database is the oracle.
//
// This is a CALIBRATION number (different dataset, harder cross-domain schemas);
// it is reported in a SEPARATE column and is NOT a go/no-go on the internal
// suite. Sampling is deterministic (stride over question_id order) for
// reproducibility; raw predictions + summary land in eval/results/.
//
// Data (gitignored, ~3.3GB unzipped): eval/external/minidev/MINIDEV/
//   - mini_dev_sqlite.json  (questions)
//   - dev_databases/<db_id>/<db_id>.sqlite
//
// Run: EXT_LIMIT=50 node dist/cli/external-eval.js   (requires Ollama/qwen2.5:7b)
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { generate, isAvailable } from "../llm.js";
import { extractSql } from "../nl2sql.js";

const exec = promisify(execFile);

interface BirdQ { question_id: number; db_id: string; question: string; evidence: string; SQL: string; difficulty: string; }

/** Immutable read-only URI: opens WAL-mode DBs cleanly with zero locking. */
function dbUri(db: string): string { return `file:${db}?mode=ro&immutable=1`; }

/** Run a read-only SQL through the sqlite3 CLI; return parsed rows or an error. */
async function runSqlite(db: string, sql: string): Promise<{ ok: boolean; rows: unknown[]; error?: string }> {
  try {
    const { stdout } = await exec("sqlite3", ["-json", dbUri(db), sql], { timeout: 30_000, maxBuffer: 64 * 1024 * 1024 });
    const trimmed = stdout.trim();
    return { ok: true, rows: trimmed ? JSON.parse(trimmed) : [] };
  } catch (e) {
    return { ok: false, rows: [], error: (e as Error).message.split("\n")[0] };
  }
}

/** Normalize a value for BIRD-style comparison: tame float formatting noise. */
function norm(v: unknown): string {
  if (typeof v === "number") return String(Number(v.toFixed(6)));
  if (v === null) return "∅";
  return String(v);
}

/** BIRD execution accuracy: equal multisets of row value-tuples (row order ignored). */
function execMatch(pred: unknown[], gold: unknown[]): boolean {
  const key = (rows: unknown[]) =>
    rows.map((r) => (r && typeof r === "object" ? Object.values(r as Record<string, unknown>).map(norm).join("\u0001") : norm(r))).sort();
  const a = key(pred), b = key(gold);
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

const schemaCache = new Map<string, string>();
async function schemaCard(db: string): Promise<string> {
  if (schemaCache.has(db)) return schemaCache.get(db)!;
  const { stdout } = await exec("sqlite3", [dbUri(db), ".schema"], { timeout: 30_000, maxBuffer: 32 * 1024 * 1024 });
  // Drop sqlite internal/index noise; keep CREATE TABLE bodies. Cap to keep the
  // prompt bounded on wide schemas (e.g. card_games.cards has 70+ columns).
  let ddl = stdout.split("\n").filter((l) => !/^\s*CREATE INDEX/i.test(l)).join("\n").trim();
  if (ddl.length > 9000) ddl = ddl.slice(0, 9000) + "\n-- (schema truncated)";
  schemaCache.set(db, ddl);
  return ddl;
}

async function birdNL2SQL(ddl: string, q: string, evidence: string): Promise<string | null> {
  const prompt = [
    "다음은 SQLite 데이터베이스 스키마입니다.",
    ddl,
    "",
    evidence ? `참고 지식: ${evidence}` : "",
    "",
    "질문에 답하는 단일 읽기 전용 SQLite SELECT 한 문장만 출력하세요.",
    "설명/주석/코드펜스/세미콜론 없이 SQL만 출력. 컬럼명에 공백/특수문자가 있으면 큰따옴표로 감쌉니다.",
    "",
    `질문: ${q}`,
    "SQL:",
  ].filter(Boolean).join("\n");
  return extractSql(await generate(prompt));
}

async function main() {
  // ── 프리플라이트. 없는 전제를 50번 발견하지 않는다.
  //
  // 2026-08-18: sqlite3 CLI 가 PATH 에 없어 50문항 전부(gold 실행까지) 실패했고
  // 0/50 이 정본(7/32)을 덮었다. **첫 문항에서 멈추고 무엇이 없는지 말해야 한다.**
  try {
    await exec("sqlite3", ["-version"], { timeout: 10_000 });
  } catch {
    console.error("\n실패: sqlite3 CLI 를 찾지 못했다 — BIRD Mini-Dev 는 SQLite 파일을 직접 조회한다.");
    console.error("  설치: winget install SQLite.SQLite  |  apt install sqlite3  |  brew install sqlite");
    console.error("  설치 후 새 셸에서 다시 실행한다. (결과 파일은 건드리지 않았다.)\n");
    process.exit(1);
  }

  if (!(await isAvailable())) { console.log("external:bird SKIPPED (Ollama/qwen2.5:7b unavailable)"); process.exit(0); }
  const here = dirname(fileURLToPath(import.meta.url));
  const root = resolve(here, "../../..");
  const base = resolve(root, "eval/external/minidev/MINIDEV");
  const all: BirdQ[] = JSON.parse(await readFile(resolve(base, "mini_dev_sqlite.json"), "utf8"));
  all.sort((a, b) => a.question_id - b.question_id);

  const limit = Number(process.env.EXT_LIMIT ?? 50);
  const stride = Math.max(1, Math.floor(all.length / limit));
  const sample = all.filter((_, i) => i % stride === 0).slice(0, limit);

  type Row = { id: number; db: string; diff: string; ok: boolean; predOk: boolean; goldOk: boolean; pred: string };

  // 전수 500 문항은 26s/문항 실측으로 **3.6시간**이다. 체크포인트가 없으면
  // Ollama 가 한 번 끊기는 순간 전부 잃는다.
  //
  // 부분 결과를 eval/results/ 에 두지 않는다 - evidence-manifest 가 그 폴더를
  // readdirSync 로 훑어 .json 을 전부 증거로 센다. **부분 파일이 증거로 오인된다.**
  // eval/external/ 은 통째로 gitignore 되므로 거기 둔다.
  const progressPath = resolve(root, "eval/external/.bird-progress.json");
  let rows: Row[] = [];
  if (process.env.EXT_RESUME === "1" && existsSync(progressPath)) {
    rows = JSON.parse(await readFile(progressPath, "utf8"));
    console.log(`[resume] 이전 진행분 ${rows.length}문항을 이어받는다.`);
  }
  const done = new Set(rows.map((r) => r.id));
  let correct = rows.filter((r) => r.ok).length;
  const byDiff: Record<string, { c: number; n: number }> = {};
  for (const r of rows) {
    byDiff[r.diff] ??= { c: 0, n: 0 };
    byDiff[r.diff].n++;
    if (r.ok) byDiff[r.diff].c++;
  }
  for (const it of sample) {
    if (done.has(it.question_id)) continue;
    const db = resolve(base, "dev_databases", it.db_id, `${it.db_id}.sqlite`);
    let matched = false, predOk = false, goldOk = false, pred: string | null = null;
    try {
      // gold 를 **먼저** 돌린다. 2026-08-18 리뷰: 예측 생성이 던지면(Ollama 끊김 등)
      // 이 줄 뒤의 gold 실행이 통째로 건너뛰어져 `goldOk:false` 가 되고, 가드가
      // **생성 오류를 채점기 고장으로** 읽는다. gold 는 예측 경로와 무관해야 한다.
      const g = await runSqlite(db, it.SQL);
      goldOk = g.ok;
      const ddl = await schemaCard(db);
      pred = await birdNL2SQL(ddl, it.question, it.evidence);
      if (pred) {
        const p = await runSqlite(db, pred);
        predOk = p.ok;
        matched = p.ok && g.ok && execMatch(p.rows, g.rows);
      }
    } catch (e) {
      console.log(`    ! q${it.question_id} errored: ${(e as Error).message.split("\n")[0]}`);
    }
    if (matched) correct++;
    byDiff[it.difficulty] ??= { c: 0, n: 0 };
    byDiff[it.difficulty].n++; if (matched) byDiff[it.difficulty].c++;
    rows.push({ id: it.question_id, db: it.db_id, diff: it.difficulty, ok: matched, predOk, goldOk, pred: pred ?? "(no SQL)" });
    console.log(`${matched ? "✓" : "✗"} q${it.question_id} [${it.db_id}/${it.difficulty}] ${it.question.slice(0, 60)}`);
    if (!matched) console.log(`    pred: ${(pred ?? "(no SQL)").slice(0, 140)}`);
    // 매 문항마다 저장한다. 3.6시간짜리 실행에서 마지막에만 쓰는 것은 도박이다.
    await writeFile(progressPath, JSON.stringify(rows, null, 2));
  }

  const acc = correct / sample.length;
  // ── 채점에 실제로 쓴 gold 를 검사한다.
  //
  // 2026-08-18 리뷰 둘.
  //   ① `EXT_LIMIT=0` 이면 sample 이 비어 goldFailed 도 비고 **가드가 통과** —
  //      정본이 `sampled:0 · accuracy:null` 로 덮인다(재현했다).
  //   ② 가드가 gold 를 **다시 돌리면** 채점에 쓴 실행과 다른 실행을 본다.
  //      재시도에서 성공하면 낮게 나온 점수를 그대로 쓴다.
  if (!sample.length) {
    console.error("\n실패: 표본이 0문항이다 — EXT_LIMIT 값을 확인한다(양의 정수).");
    console.error("  0문항 결과는 측정이 아니다. 결과 파일을 쓰지 않았다.\n");
    process.exit(1);
  }
  const goldFailed = rows.filter((r) => !r.goldOk);
  if (goldFailed.length) {
    console.error(`\n실패: gold SQL ${goldFailed.length}/${rows.length}문항이 실행되지 않았다 — 채점기 환경 문제다.`);
    console.error(`  첫 실패: q${goldFailed[0].id}`);
    console.error("  sqlite3 와 Mini-Dev 데이터가 온전한지 확인한다. 결과 파일을 쓰지 않았다.");
    console.error("  (gold 가 전부 도는데 예측이 0개면 그건 **정당한 0/N** 이라 기록한다.)\n");
    process.exit(1);
  }


const summary = {
    benchmark: "BIRD Mini-Dev (SQLite)", model: process.env.OLLAMA_MODEL ?? "qwen2.5:7b",
    sampled: sample.length, of: all.length, samplingStride: stride,
    correct, executionAccuracy: Number((acc * 100).toFixed(1)),
    byDifficulty: byDiff, generatedAt: new Date().toISOString(),
    note: "External calibration on a DIFFERENT, harder cross-domain dataset; BIRD-style execution accuracy (result-set multiset match) vs gold; no LLM judge; oracle evidence included in prompt as per BIRD protocol. Reported in a SEPARATE column; NOT a go/no-go on the internal suite.",
  };
  await mkdir(resolve(root, "eval/results"), { recursive: true });
  await writeFile(resolve(root, "eval/results/external-bird-raw.json"), JSON.stringify(rows, null, 2));
  await writeFile(resolve(root, "eval/results/external-bird-summary.json"), JSON.stringify(summary, null, 2));
  console.log(`\n[external:bird] execution-accuracy ${correct}/${sample.length} = ${(acc * 100).toFixed(1)}% (sampled stride=${stride} of ${all.length})`);
  console.log(`byDifficulty: ${JSON.stringify(byDiff)}`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
