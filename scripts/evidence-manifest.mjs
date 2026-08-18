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
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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

// ── §9 의 재현 명령이 실재하는가 ──────────────────────────────────────────
//
// 이 절은 "모든 수치 = raw + 커맨드로 추적" 을 표방한다. 그런데 파일 경로만
// 나열돼 있으면 심사자는 "이 수치를 다시 뽑으려면 뭘 치나" 에 답을 못 얻는다.
// 파일이 있다는 것과 다시 만들 수 있다는 것은 다르다.
//
// 명령을 적었으면 그 명령이 실재해야 한다. 스크립트 이름은 실제로 바뀐다 —
// 이 저장소에서 companyx:* 9개를 한 번에 정정한 적이 있다.
const reportPath = resolve(ROOT, "docs", "report.md");
if (existsSync(reportPath)) {
  const report = readFileSync(reportPath, "utf8");
  const at = report.indexOf("Evidence manifest");
  if (at >= 0) {
    const until = report.indexOf("\n## ", at);
    const section = report.slice(at, until > 0 ? until : undefined);
    const pkgScripts = new Set(
      Object.keys(
        JSON.parse(readFileSync(resolve(ROOT, "air-server", "package.json"), "utf8")).scripts ?? {},
      ),
    );
    const named = [...new Set([...section.matchAll(/npm run ([a-z0-9:._-]+)/g)].map((m) => m[1]))];
    const gone = named.filter((n) => !pkgScripts.has(n));
    const checks = [...new Set([...section.matchAll(/node (scripts\/[a-z0-9-]+\.mjs)/g)].map((m) => m[1]))];
    const absent = checks.filter((c) => !existsSync(resolve(ROOT, c)));
    if (gone.length || absent.length) {
      if (gone.length) console.error(`\n실패: Evidence manifest 가 없는 스크립트를 부른다 — ${gone.join(", ")}`);
      if (absent.length) console.error(`실패: Evidence manifest 가 없는 검사를 부른다 — ${absent.join(", ")}`);
      console.error("");
      process.exit(1);
    }
    
// ── 신선도. 정본 증거가 며칠 전 측정인지 적는다.
//
// 2026-08-18: `internal-llm-summary.json` 이 06-30 측정이었고 다시 재니 83 이 아니라
// **81** 이었다. 날짜만 보면 알 수 있는 것을 아무도 안 보고 있었다.
//
// ★ 첫 판은 기준을 "마지막 air-server/src 변경" 으로 잡았다가 **오늘 잰 증거까지
//   '0일 오래됨' 으로 12줄** 나열했다. external-eval.ts 를 고쳤다고 벡터·라우팅
//   증거가 낡는 것은 아니다. 매번 12줄이 뜨면 아무도 안 읽는다 —
//   **꺼지는 것과 안 읽히는 것은 같다.**
//
//   그래서 절대 나이로 잰다. 83→81 을 찾게 한 것은 "7주" 라는 나이였지 "src 보다
//   이전" 이라는 관계가 아니었다.
{
  const TS = ["generated_at", "generatedAt", "at"];
  const findTs = (v) => {
    const stack = [v];
    while (stack.length) {
      const cur = stack.pop();
      if (cur && typeof cur === "object") {
        for (const [k, val] of Object.entries(cur)) {
          if (TS.includes(k) && typeof val === "string" && /^\d{4}-/.test(val)) return val;
          if (val && typeof val === "object") stack.push(val);
        }
      }
    }
    return null;
  };

  const mc = readFileSync(resolve(ROOT, "scripts/metrics-check.mjs"), "utf8");
  const canonFiles = [...new Set([...mc.matchAll(/eval\/results\/([\w.\-]+\.json)/g)].map((m) => m[1]))];

  const now = Date.now();
  const aged = [];
  for (const f of canonFiles) {
    const p = resolve(ROOT, "eval/results", f);
    if (!existsSync(p)) continue;
    let ts;
    try { ts = findTs(JSON.parse(readFileSync(p, "utf8"))); } catch { continue; }
    if (!ts) continue;
    const days = Math.floor((now - Date.parse(ts)) / 86400000);
    aged.push([f, ts.slice(0, 10), days]);
  }

  const STALE_DAYS = 30;
  const old = aged.filter(([, , d]) => d >= 7).sort((a, b) => b[2] - a[2]);
  if (old.length) {
    console.log(`\n정본 증거 나이 (7일 이상 ${old.length}개 / 전체 ${aged.length}개):`);
    for (const [f, d, days] of old) console.log(`  ${String(days).padStart(3)}일  ${d}  ${f}`);
    console.log("  (다시 잴 수 있는 것은 다시 잰다. 환경 전용 측정은 그대로 둔다.)");
  } else {
    console.log(`\n정본 증거 ${aged.length}개 전부 7일 이내 측정이다.`);
  }

  const rotten = aged.filter(([, , d]) => d > STALE_DAYS);
  if (rotten.length) {
    console.error(`\n실패: ${STALE_DAYS}일 넘게 안 잰 정본 증거 ${rotten.length}개 — ${rotten.map(([f]) => f).join(", ")}`);
    console.error("  정당하게 오래된 것이 아니라 잊힌 것이다.\n");
    process.exitCode = 1;
  }
}

console.log(`재현 명령: npm ${named.length}종 · 검사 ${checks.length}종 전부 실재한다.`);
  }
}
