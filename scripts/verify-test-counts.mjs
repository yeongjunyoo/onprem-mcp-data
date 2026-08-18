// 테스트 단언 수를 **러너 출력에서 직접 집계**해 정본과 대조한다.
//
// `eval/results/test-counts.json` 은 손으로 고칠 수 있는 파일이다. QA 레드팀이
// 그 값과 문서를 함께 999 로 위조하면 지표 검사가 통과하는 것을 실증했다.
// 문서가 정본과 일치하는지만 보면, 정본 자체가 거짓일 때 아무도 못 잡는다.
//
// 그래서 CI 가 **실제로 돌릴 수 있는 것**은 실제로 돌려서 센다. 오프라인 스위트는
// DB 도 모델도 필요 없으므로 여기서 전량 실행해 합계를 낸다.
//
// ★ 범위 한계 (덮지 못하는 것을 덮은 척하지 않는다).
//   통합 스위트 9종은 PostgreSQL 과 Ollama 가 있어야 돌아서 CI 에서 재현할 수 없다.
//   그 값(integration)은 여전히 선언이고, 로컬 실행 기록으로만 뒷받침된다.
//   즉 이 검사는 오프라인 부분의 위조를 막고, 통합 부분은 막지 못한다.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = resolve(ROOT, "air-server");

const canonical = JSON.parse(readFileSync(resolve(ROOT, "eval/results/test-counts.json"), "utf8"));


// 스위트 목록은 **정본 한 곳**에서만 읽는다.
//
// 종전에는 이 배열과 `eval/results/test-counts.json` 의 `suites.offline` 이 따로
// 있었다. 2026-08-17 에 errors.test 를 추가하며 정본만 고쳤고, 검사는 옛 목록으로
// 세어 "정본 308 인데 실측 290" 으로 실패했다.
//
// **목록이 둘이면 하나만 고치고 고쳤다고 믿는다** — 이 저장소에서 세 번째다
// (metrics-check 의 DOCS/COUNT_DOCS, RANGE_DOCS/LATENCY_DOCS, 그리고 여기).
const OFFLINE = canonical.suites?.offline ?? [];
if (OFFLINE.length === 0) {
  console.error("\n실패: 정본에 suites.offline 이 없다 — 셀 대상이 0개다.\n");
  process.exit(1);
}

let counted = 0;
const perSuite = [];

for (const suite of OFFLINE) {
  let out;
  try {
    out = execFileSync(process.execPath, [`dist/${suite}.test.js`], {
      cwd: SERVER,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    console.error(`\n${suite}.test 가 실패했다 — 단언 수를 세기 전에 통과해야 한다.`);
    console.error(String(e.stdout ?? e).slice(-800));
    process.exit(1);
  }
  const m = /(\d+) passed, (\d+) failed/.exec(out);
  if (!m) {
    console.error(`\n${suite}.test 출력에서 "N passed, M failed" 를 찾지 못했다.`);
    process.exit(1);
  }
  const [, passed, failed] = m;
  if (Number(failed) !== 0) {
    console.error(`\n${suite}.test 에 실패가 있다: ${failed}건`);
    process.exit(1);
  }
  counted += Number(passed);
  perSuite.push(`${suite}=${passed}`);
}

// ★ 데이터셋 유무로 합계가 갈린다. 사업자 데이터셋은 배포 조건상 저장소에 없고,
// router.test 의 온톨로지 커버리지 단언 11건은 edges.json 이 있을 때만 돈다.
// 그래서 "오프라인 267" 은 데이터셋이 있을 때의 값이고 CI 에서는 256 이다.
// 하나의 숫자로 뭉개면 그 문서는 어느 환경에서도 정확하지 않다.
const hasDataset = existsSync(resolve(ROOT, "datasets/companyx-v1.0/graph/edges.json"));
const expected = hasDataset ? canonical.offline_with_dataset : canonical.offline_ci;
const label = hasDataset ? "offline_with_dataset" : "offline_ci (데이터셋 없음)";

console.log("러너 실측 (오프라인):");
console.log("  " + perSuite.join(" "));
console.log(`  합계 ${counted}`);
console.log(`정본 test-counts.json: ${label}=${expected} integration=${canonical.integration} total=${canonical.total}`);

const fails = [];
if (expected !== counted) {
  fails.push(`정본 ${label}=${expected} 인데 러너 실측은 ${counted} 이다`);
}
if (canonical.offline_with_dataset + canonical.integration !== canonical.total) {
  fails.push(
    `정본 합계가 어긋난다: ${canonical.offline_with_dataset} + ${canonical.integration} != ${canonical.total}`,
  );
}

if (fails.length) {
  console.error("\n실패:");
  for (const f of fails) console.error(`  - ${f}`);
  console.error("\n테스트 수는 손으로 적는 값이 아니라 러너가 낸 값이다.");
  process.exit(1);
}

console.log("\nOK: 정본의 오프라인 단언 수가 러너 실측과 일치한다.");
// CI 가 못 보는 것과 아무도 확인한 적 없는 것은 다르다. 후자였다가 전자가 됐으면
// 출력이 그 사실을 말해야 한다 — 안 그러면 읽는 사람은 계속 미확인으로 읽는다.
const iv = canonical.integration_verified;
if (iv) {
  console.log(
    `    (통합 ${canonical.integration}건은 DB·모델이 필요해 CI 에서 재현할 수 없다. ` +
      `다만 미확인이 아니다 — ${iv.at} 에 9스위트를 각자 올바른 프로파일로 돌려 ` +
      `${iv.passed}/${canonical.integration} 통과를 확인했고 기록은 eval/results/test-counts.json 에 있다.)`,
  );
} else {
  console.log(
    `    (통합 ${canonical.integration}건은 DB·모델이 필요해 CI 에서 재현할 수 없다 — 선언으로 남는다.)`,
  );
}
