// 증거 아티팩트 매니페스트를 생성하고, 드리프트를 검사한다.
//
// `eval/results/MANIFEST.md` 는 문서가 인용하는 수치의 출처를 고정한다. 그런데
// **매니페스트 자체가 낡으면 그것이 다음 번 낡은 아티팩트**가 된다 — 이 저장소가
// 이번에 반복해서 겪은 문제가 정확히 그 형태다(지연 910ms, 두 달 된 replica 로그,
// 세 문서에서 갈린 테스트 수).
//
// 그래서 생성기를 커밋하고, CI 가 "다시 생성해도 달라지지 않는가" 를 검사한다.
// SBOM drift check 와 같은 패턴이다.
//
//   node scripts/evidence-manifest.mjs           # 검사 (드리프트면 exit 1)
//   node scripts/evidence-manifest.mjs --write   # 재생성
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = resolve(ROOT, "eval/results");
const OUT = resolve(DIR, "MANIFEST.md");
const WRITE = process.argv.includes("--write");

/** 줄바꿈을 정규화해 해시한다 — git 이 OS 마다 CRLF/LF 를 바꾸므로 원시 바이트를
 * 해시하면 같은 내용이 플랫폼마다 다른 해시가 된다(CI 에서 실제로 깨졌다). */
const sha = (buf) =>
  createHash("sha256").update(buf.toString("utf8").replace(/\r\n/g, "\n")).digest("hex").slice(0, 16);

const stampOf = (name, text) => {
  if (name.endsWith(".json")) {
    try {
      const d = JSON.parse(text);
      if (d && typeof d === "object") {
        return (d.generated_at ?? d.summary?.generated_at ?? "").slice(0, 19);
      }
    } catch {
      /* 배열이거나 파싱 불가 — 시각 없음으로 둔다 */
    }
    return "";
  }
  if (name.endsWith(".log")) {
    return (/(\d{4}-\d{2}-\d{2}T[\d:]+Z)/.exec(text)?.[1] ?? "").slice(0, 19);
  }
  return "";
};

const rows = readdirSync(DIR)
  .filter((n) => n !== "MANIFEST.md" && statSync(resolve(DIR, n)).isFile())
  .sort()
  .map((n) => {
    const buf = readFileSync(resolve(DIR, n));
    const text = buf.toString("utf8");
    // 크기도 해시와 같은 기준으로 센다. 원시 바이트는 CRLF/LF 로 갈려
    // Windows 작업본과 Linux CI 가 다른 값을 낸다(실측: 22,701 vs 21,907).
    const normalized = Buffer.byteLength(text.replace(/\r\n/g, "\n"), "utf8");
    return { n, size: normalized, digest: sha(buf), stamp: stampOf(n, text) };
  });

const selfStamped = rows.filter((r) => r.stamp).length;

const body = [
  "# 증거 아티팩트 매니페스트",
  "",
  "문서가 인용하는 수치는 전부 이 디렉터리의 실행 결과에서 나온다.",
  "",
  `**${selfStamped}/${rows.length} 개가 자기 생성 시각을 들고 있다.** 나머지는 파일 자체에 시각이 없어`,
  "`git log` 로만 추적된다 — 옛 평가기가 그 필드를 안 쓰던 시절의 산출물이다.",
  "없는 시각을 지어내지 않고, 어느 것이 자기 시각을 갖고 어느 것이 안 갖는지 그대로 적는다.",
  "",
  "커밋 시각 열은 두지 않는다. CI 는 얕은 클론이라 `git log` 가 이력 대신 checkout",
  "시각을 주므로 환경마다 값이 달라진다 — 재현 가능한 값만 남긴다.",
  "",
  "해시는 줄바꿈을 정규화한 SHA-256 앞 16자다(git 이 OS 마다 CRLF/LF 를 바꾸므로).",
  "",
  "이 파일은 `node scripts/evidence-manifest.mjs --write` 로 생성하고, CI 가 재생성해도",
  "달라지지 않는지 검사한다. **매니페스트 자체가 낡으면 그것이 다음 번 낡은 아티팩트다.**",
  "",
  "| 파일 | 크기 | sha256(16) | 자체 생성시각 |",
  "|---|---:|---|---|",
  ...rows.map((r) => `| \`${r.n}\` | ${r.size.toLocaleString("en-US")} | \`${r.digest}\` | ${r.stamp || "—"} |`),
  "",
  "## 재생성",
  "",
  "```bash",
  "# 라우팅·벡터·KG·종단 (DATASET 은 스크립트가 스스로 넘긴다)",
  "npm run companyx:route && npm run companyx:vector && npm run companyx:kg && npm run companyx:ask",
  "",
  "# 홀드아웃 2벌",
  "node dist/cli/companyx-holdout-route-eval.js",
  "HOLDOUT=eval/companyx/holdout2_route.json OUT=eval/results/companyx-holdout2-route.json \\",
  "  node dist/cli/companyx-holdout-route-eval.js",
  "",
  "# BIRD 공식 set 의미 재채점 (재추론 없음)",
  "python scripts/rescore_bird.py",
  "",
  "# 복제 스파이크 (primary 를 잠깐 정지시킨다)",
  "bash scripts/replica-spike.sh",
  "",
  "# 매니페스트 갱신",
  "node scripts/evidence-manifest.mjs --write",
  "```",
  "",
  "문서 수치와 이 결과들의 일치는 `node scripts/metrics-check.mjs` 가 강제하고,",
  "테스트 단언 수는 `node scripts/verify-test-counts.mjs` 가 러너 출력에서 다시 센다.",
  "",
].join("\n");

if (WRITE) {
  writeFileSync(OUT, body, "utf8");
  console.log(`매니페스트 생성: ${rows.length}개 아티팩트, 자체 시각 ${selfStamped}개`);
  process.exit(0);
}

const current = readFileSync(OUT, "utf8").replace(/\r\n/g, "\n");
if (current !== body) {
  console.error("\n매니페스트가 실제 아티팩트와 어긋난다.");
  console.error("  node scripts/evidence-manifest.mjs --write 로 갱신하고 함께 커밋한다.\n");
  const a = current.split("\n");
  const b = body.split("\n");
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) {
      console.error(`  첫 차이 ${i + 1}행`);
      console.error(`    현재: ${(a[i] ?? "(없음)").slice(0, 110)}`);
      console.error(`    실제: ${(b[i] ?? "(없음)").slice(0, 110)}`);
      break;
    }
  }
  process.exit(1);
}
console.log(`OK: 매니페스트가 실제 아티팩트와 일치한다 (${rows.length}개, 자체 시각 ${selfStamped}개).`);
