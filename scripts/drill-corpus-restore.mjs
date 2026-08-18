// 벡터 평가가 코퍼스를 원상 복구하는지 **데이터로** 확인한다.
//
// 왜 필요한가. 이 평가는 임베더를 바꿔 가며 재현율을 재기 때문에 DDL 과 258행
// UPDATE 를 한다. 평가가 자기가 읽는 코퍼스를 건드리는 유일한 자리다.
//
// 그리고 이 저장소는 그것 때문에 이미 한 번 당했다 — 벡터 평가가 매 실행 코퍼스를
// 파괴해 종단 근거가 17/19 에서 13/19 로 **조용히** 내려갔다. 그때도 앞선 PR 에
// "복원하도록 고쳤다" 고 적혀 있었고, 그 복원은 처음부터 작동하지 않았다.
//
// ★ "고쳤다" 와 "고쳐졌다" 는 다르다.
//   PR #44 는 중간 상태가 안 보인다는 것(원자성)을 확인했다. 실행 후 코퍼스가
//   원래대로 돌아온다는 것은 **별개의 주장**이고, 이 드릴이 그걸 본다.
//
// 실행: node scripts/drill-corpus-restore.mjs
// 필요: docker compose up -d, npm run companyx:load, Ollama 모델 2종
import { execSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { getReadPool } from "../air-server/dist/db.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function snapshot() {
  const pool = getReadPool();
  const one = async (sql) => (await pool.query(sql)).rows[0];
  return {
    chunks: (await one("SELECT count(*)::int AS n FROM companyx.document_chunks")).n,
    embedded: (
      await one(
        "SELECT count(*)::int AS n FROM companyx.document_chunks WHERE embedding IS NOT NULL",
      )
    ).n,
    dim:
      (
        await one(
          "SELECT vector_dims(embedding) AS n FROM companyx.document_chunks WHERE embedding IS NOT NULL LIMIT 1",
        )
      )?.n ?? null,
    docs: (await one("SELECT count(*)::int AS n FROM companyx.documents")).n,
  };
}

const before = await snapshot();
console.log(`실행 전: ${JSON.stringify(before)}`);

if (before.chunks === 0) {
  console.error("\n코퍼스가 비어 있다 — npm run companyx:load 를 먼저 돌린다.\n");
  process.exit(1);
}

try {
  execSync("npm run companyx:vector", {
    cwd: resolve(ROOT, "air-server"),
    stdio: "ignore",
    shell: true,
    timeout: 25 * 60 * 1000,
  });
} catch (e) {
  console.error(`\n벡터 평가가 실패했다: ${e.message}\n`);
  process.exit(1);
}

const after = await snapshot();
console.log(`실행 후: ${JSON.stringify(after)}`);

// 데모도 같은 성질을 지켜야 한다. §9 가 "npm run demo 는 DB 에 쓰지 않는다" 고
// 적었고, 심사자가 가장 먼저 돌리는 것이 데모다. 적었으면 검사가 지킨다.
try {
  // 데모는 bench 시드 전용이고 스스로 그걸 확인한다. DATASET 을 물려주면
  // 정당하게 거절당한다 — 드릴이 그 거절을 데모 실패로 오해하지 않도록 비운다.
  const demoEnv = { ...process.env };
  delete demoEnv.DATASET;
  execSync("npm run demo", {
    cwd: resolve(ROOT, "air-server"),
    env: demoEnv,
    stdio: "ignore",
    shell: true,
    timeout: 10 * 60 * 1000,
  });
} catch (e) {
  console.error(`\n데모가 실패했다: ${e.message}\n`);
  process.exit(1);
}
const afterDemo = await snapshot();
console.log(`데모 후: ${JSON.stringify(afterDemo)}`);

const drift = Object.keys(before).filter(
  (k) => before[k] !== after[k] || before[k] !== afterDemo[k],
);
if (drift.length) {
  console.error("\n실패: 평가가 코퍼스를 바꿨다.");
  for (const k of drift) {
    const who = before[k] !== after[k] ? "벡터 평가" : "데모";
    const got = before[k] !== after[k] ? after[k] : afterDemo[k];
    console.error(`  - ${k}: ${before[k]} -> ${got} (${who})`);
  }
  console.error("\n평가는 자기가 읽는 데이터를 남겨 두고 나와야 한다.\n");
  process.exit(1);
}

console.log("\nOK: 벡터 평가와 데모 후에도 코퍼스가 실행 전과 동일하다.");
console.log('    ("고쳤다" 와 "고쳐졌다" 는 다르다 — 이 저장소는 그것 때문에 한 번 당했다.)');
process.exit(0);
