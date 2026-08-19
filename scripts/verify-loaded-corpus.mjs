// 적재된 코퍼스가 문서가 말하는 규모인지 DB 에 물어 확인한다.
//
// 문서는 "8테이블 818행 / 문서 40건에서 258청크 / 그래프 133노드 354엣지" 라고
// 여러 곳에서 말한다. 그 수는 **적재 결과 파일**에서 왔고, 지금 DB 에 실제로 그만큼
// 있는지는 아무도 안 봤다.
//
// 심사자가 clone -> fetch -> companyx:load 를 밟으면 이 상태가 나와야 하고,
// 안 나오면 그 뒤 모든 수치가 다른 코퍼스에서 나온 값이 된다.
//
// ★ 비교 대상이 둘 다 없으면 어떤 비교든 참이 된다.
//   이 검사를 만들다 존재하지 않는 테이블(kg_nodes)을 물어 스냅샷이 둘 다 null 이
//   됐고, `null === null` 이라 "동일하다" 로 통과했다. 그래서 여기서는 기대값을
//   **명시적으로** 적고 하나라도 어긋나면 실패시킨다.
//
// 실행: node scripts/verify-loaded-corpus.mjs
// 필요: docker compose up -d, npm run companyx:load
import { getReadPool } from "../air-server/dist/db.js";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BUSINESS_TABLES = [
  "departments",
  "employees",
  "clients",
  "products",
  "contracts",
  "projects",
  "sales",
  "support_tickets",
];

// 문서가 주장하는 규모. 바뀌면 문서와 함께 고친다.
const EXPECT = {
  business_tables: 8,
  business_rows: 818,
  documents: 258,
  chunks: 258,
  embed_dim: 768,
  entities: 133,
  relations: 354,
};

const pool = getReadPool();
const one = async (sql) => (await pool.query(sql)).rows[0];

let rows = 0;
try {
  for (const t of BUSINESS_TABLES) {
    rows += (await one(`SELECT count(*)::int AS n FROM companyx.${t}`)).n;
  }
} catch (e) {
  console.error(`\n실패: companyx 스키마를 읽지 못했다 — ${String(e.message).split("\n")[0]}`);
  console.error("  npm run companyx:load 를 먼저 돌린다.\n");
  process.exit(1);
}

const actual = {
  business_tables: BUSINESS_TABLES.length,
  business_rows: rows,
  documents: (await one("SELECT count(*)::int AS n FROM companyx.documents")).n,
  chunks: (await one("SELECT count(*)::int AS n FROM companyx.document_chunks")).n,
  embed_dim:
    (
      await one(
        "SELECT vector_dims(embedding) AS n FROM companyx.document_chunks WHERE embedding IS NOT NULL LIMIT 1",
      )
    )?.n ?? null,
  entities: (await one("SELECT count(*)::int AS n FROM companyx.entities")).n,
  relations: (await one("SELECT count(*)::int AS n FROM companyx.relations")).n,
};

// ── 문서가 말하는 런타임 버전을 살아 있는 스택에 묻는다.
//
// npm 의존성은 package.json 이 정본이라 CI 에서 대조한다. **컨테이너 이미지는
// 파일에 없다** — `pgvector/pgvector:pg16` 은 태그일 뿐 안에 든 확장 버전을 말해
// 주지 않는다. 2026-08-18 실측에서 문서 pgvector 0.6.0 vs 실물 0.8.6,
// 문서 Ollama 0.32.4 vs 실물 0.32.14 로 갈려 있었다.
//
// latest 태그는 계속 움직이므로 문서에는 측정 시점을 함께 적는다.
{
  const ROOT2 = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const pool = getReadPool();
  const q = one;  // 이미 위에서 만든 헬퍼를 쓴다 (도구 증식 금지)
  const pgv = (await q("select extversion v from pg_extension where extname='vector'"))?.v;
  const pgs = (await q("show server_version"))?.server_version?.split(" ")[0];
  let oll = null;
  try {
    const host = process.env.OLLAMA_HOST || "http://localhost:11435";
    oll = (await (await fetch(`${host}/api/version`)).json()).version;
  } catch {
    oll = null; // 모델이 안 떠 있으면 이 항목만 건너뛴다 (조용히 통과시키지 않고 말한다)
  }

  // 추적되는 md 만 본다 — 파일시스템을 훑으면 로컬과 CI 가 다른 범위를 본다.
  const docs = execFileSync("git", ["ls-files", "*.md"], { cwd: ROOT2, encoding: "utf8" })
    .split("\n").filter(Boolean).map((f) => resolve(ROOT2, f));

  const seen = [];
  for (const d of docs) {
    const t = readFileSync(d, "utf8");
    for (const [label, re, real] of [
      // 산문("pgvector 0.8.6")과 표 행("| pgvector | 0.8.6 |") 둘 다 본다.
      // 산문 패턴만 두었더니 SBOM 표의 위조가 통과했다 — **같은 사실을 다른 모양으로
      // 쓰면 같은 검사가 못 본다** 를 오늘 네 번째로 확인했다.
      ["pgvector", /pgvector[\s|]+(\d+\.\d+\.\d+)/g, pgv],
      ["Ollama", /Ollama[\s|]+(\d+\.\d+\.\d+)/g, oll],
    ]) {
      if (!real) continue;
      for (const m of t.matchAll(re)) {
        seen.push(`${relative(ROOT2, d)}: ${label} ${m[1]}`);
        if (m[1] !== real) {
          console.error(`\n실패: ${relative(ROOT2, d)} 가 ${label} ${m[1]} 이라 적었는데 실물은 ${real} 이다.`);
          console.error("  latest 태그는 계속 움직인다 — 문서를 실물에 맞추고 측정 시점을 함께 적는다.\n");
          process.exit(1);
        }
      }
    }
  }
  console.log(`런타임 버전: PostgreSQL ${pgs} · pgvector ${pgv} · Ollama ${oll ?? "(미기동)"} — 문서 ${seen.length}곳과 일치.`);
  if (!oll) console.log("  (Ollama 가 안 떠 있어 그 항목은 대조하지 못했다 — 건너뛴 것을 말한다.)");
}

await pool.end();

// ── 붙임2(AI 모델 명세서)가 주장하는 모델 제원을 **살아 있는 Ollama** 와 대조한다.
//
// 2026-08-18: 제출 PDF 10쪽이 `Q4_K_M · 7.6B · context 32768 · dense 1024 · 8192토큰` 을
// 적는데 **어느 검사도 안 봤다.** 라이선스 명세서라 틀리면 「라이선스 검증」이 직접 깎인다.
// 기대값은 문서에서 읽는다 — 손으로 박으면 문서를 고칠 때 갈린다.
const modelDrift = [];
{
  // 이 파일에는 ROOT/OLLAMA 상수가 없다 — **가정하지 않고** 여기서 만든다.
  const here = dirname(fileURLToPath(import.meta.url));
  const specPath = resolve(here, "..", "docs", "ai-model-spec.md");
  const OLLAMA = process.env.OLLAMA_HOST || "http://localhost:11435";
  const spec = readFileSync(specPath, "utf8");
  const want = {
    "qwen2.5:7b": {
      // 값을 **문서에서 뽑는다.** 2026-08-18 위조 시험: `/Q4_K_M/.test()` 는 문서가
      // Q8_0 로 바뀌면 그냥 null 이 돼 **검사를 건너뛴다** — 있으면 보고 없으면 안 보는
      // 규칙은 위조에 무력하다.
      quantization_level: spec.match(/Ollama `qwen2\.5:7b`, ([A-Z0-9_]+),/)?.[1] ?? null,
      parameter_size: spec.match(/([\d.]+B) params/)?.[1] ?? null,
      context_length: Number(spec.match(/context (\d+)/)?.[1] ?? 0) || null,
    },
    "bge-m3": {
      context_length: Number(spec.match(/(\d+) 토큰 컨텍스트/)?.[1] ?? 0) || null,
      embedding_length: Number(spec.match(/dense (\d+)-dim/)?.[1] ?? 0) || null,
    },
  };

  for (const [model, fields] of Object.entries(want)) {
    let info;
    try {
      const r = await fetch(`${OLLAMA}/api/show`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: model }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      info = await r.json();
    } catch {
      console.log(`  (${model} 을 조회하지 못해 제원 대조를 건너뛴다 — 못 본 것을 없다고 적지 않는다.)`);
      continue;
    }
    const det = info.details ?? {};
    const mi = info.model_info ?? {};
    const pick = (suffix) => {
      const k = Object.keys(mi).find((x) => x.endsWith(suffix));
      return k ? mi[k] : undefined;
    };
    const got = {
      quantization_level: det.quantization_level,
      parameter_size: det.parameter_size,
      context_length: pick("context_length"),
      embedding_length: pick("embedding_length"),
    };
    for (const [k, v] of Object.entries(fields)) {
      if (v === null || v === undefined) continue;
      console.log(`  ${model} ${k.padEnd(18)} 문서 ${String(v).padStart(7)}  실제 ${String(got[k]).padStart(7)}`);
      if (String(got[k]) !== String(v)) {
        modelDrift.push(`${model} ${k}: 문서 ${v} · 실제 ${got[k]}`);
      }
    }
  }
}

const drift = [];
for (const [k, want] of Object.entries(EXPECT)) {
  const got = actual[k];
  console.log(`  ${k.padEnd(16)} 문서 ${String(want).padStart(5)}  실제 ${String(got).padStart(5)}`);
  if (got !== want) drift.push(`${k}: 문서는 ${want} 인데 DB 는 ${got}`);
}

if (modelDrift.length) {
  console.error("\n붙임2가 적은 모델 제원이 실물과 다르다:");
  for (const d of modelDrift) console.error(`  - ${d}`);
  console.error("\n라이선스 명세서는 심사자가 대조하는 문서다 — 제원이 틀리면 나머지 서술도 의심받는다.\n");
  process.exitCode = 1;
}

if (drift.length) {
  console.error("\n적재된 코퍼스가 문서가 말하는 규모와 다르다:");
  for (const d of drift) console.error(`  - ${d}`);
  console.error("\n이 상태에서 낸 수치는 문서가 말하는 코퍼스의 값이 아니다.\n");
  process.exit(1);
}

console.log("\nOK: 적재된 코퍼스가 문서가 말하는 규모와 일치한다.");
console.log("    (기대값을 명시한다 — 둘 다 없으면 어떤 비교든 참이 되기 때문이다.)");
// process.exit(0) 을 쓰지 않는다. 2026-08-18: 모델 제원 대조를 넣으면서 fetch 핸들이
// 남았고, 강제 종료가 Windows libuv 어서션(UV_HANDLE_CLOSING)을 터뜨려 **초록인데
// exit 9** 가 됐다. 자연 종료를 기다린다 — 종료 코드는 검사의 판정이지 정리 시점이 아니다.
