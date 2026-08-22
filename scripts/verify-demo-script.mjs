// 녹화 대본이 약속하는 것이 실제로 존재하는지 확인한다.
//
// 대본은 두 종류를 약속한다.
//   실행 화면  — `npm run demo:ollama` 가 찍는 것 (도구 목록, 거부 화면, 2000건 …)
//   띄우는 파일 — faults.json, internal-*-summary.json 의 수치
//
// 후자가 위험하다. **명령 출력이 아니라 파일을 열어 화면에 띄우는 것**이라 값이
// 낡으면 영상에 그대로 찍힌다. 영상은 재업로드가 되지만 이미 본 심사자에겐
// 못 고친다.
//
// ★ 대본에 적힌 수를 파일에서 다시 읽어 대조한다.
//   대본이 적은 정확도는 internal-llm-summary.json 의 값과 같아야 하고,
//   "1%/30%/83%" 라 적었으면 template/naive/llm 이 그 순서여야 한다.
//
// 실행: node scripts/verify-demo-script.mjs   (파일만 읽는다 — DB·모델 불필요)
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = readFileSync(resolve(ROOT, "docs", "demo-script.md"), "utf8");
const fails = [];
let checked = 0;

const readJson = (rel) => {
  const p = resolve(ROOT, rel);
  if (!existsSync(p)) {
    fails.push(`대본이 띄우라는 파일이 없다: ${rel}`);
    return null;
  }
  return JSON.parse(readFileSync(p, "utf8"));
};

// 0) 대본이 가리키는 섹션이 실물 데모에 있는가
//
//   `verify-demo-script` 는 대본의 **수**를 대조하는데 **섹션 번호**는 아무도 안
//   봤다. 이 대본은 3분 시연영상의 촬영 지시서다 — 화면에 섹션 5가 안 뜨는데
//   대본이 5를 가리키면 녹화 중에 알게 되고 다시 찍어야 한다.
//
//   **문서가 틀린 비용을 사람이 시간으로 낸다.**
{
  const demoSrc = resolve(ROOT, "air-server/src/cli/demo.ts");
  if (!existsSync(demoSrc)) {
    fails.push("demo.ts 를 못 찾았다 — 섹션 대조를 건너뛰지 않고 실패시킨다");
  } else {
    const src = readFileSync(demoSrc, "utf8");
    // 섹션은 `hr("N) ...")` 로 찍는다. 출력 문자열(`=== N) ===`)을 찾으면 헬퍼
    // 정의 한 줄만 걸리고 실제 섹션은 하나도 안 걸린다 — 초판이 그래서 실물을
    // {0} 으로 봤다. **찍히는 모양이 아니라 부르는 자리를 본다.**
    // 인용부호 종류를 가리지 않는다. 2026-08-20 에 모델명을 정본에서 끌어오려고
    // `hr("6) ...")` 를 백틱 템플릿으로 바꿨더니, 쌍따옴표만 보던 이 정규식이
    // 섹션 6 을 못 보고 **멀쩡한 대본에 거짓 유죄**를 냈다.
    // 거짓 유죄를 내는 검사는 사람이 꺼버린다 — 이 저장소가 여러 번 배운 것이다.
    const real = new Set([...src.matchAll(/hr\(\s*[`"'](\d+)\)/g)].map((m) => m[1]));
    // 실물이 0개면 대조가 아니라 무조건 통과다. 위 정규식이 낡으면 정확히
    // 그렇게 되므로(2026-08-22 실측) **매처가 아무것도 못 잡은 것 자체를 실패로** 센다.
    if (real.size === 0) {
      fails.push("demo.ts 에서 섹션을 하나도 못 읽었다 — hr() 매처가 낡았다");
    }
    const cited = new Set();
    for (const m of script.matchAll(/섹션\s*(\d+)(?:\s*[-–~]\s*(\d+))?/g)) {
      cited.add(m[1]);
      if (m[2]) {
        for (let i = Number(m[1]); i <= Number(m[2]); i++) cited.add(String(i));
      }
    }
    if (cited.size === 0) {
      fails.push("대본이 섹션을 하나도 가리키지 않는다 — 패턴이 낡았는지 확인하라");
    }
    for (const n of [...cited].sort()) {
      checked++;
      if (!real.has(n)) {
        fails.push(`대본이 섹션 ${n} 을 가리키는데 데모는 그 섹션을 찍지 않는다 ` +
          `(실물: ${[...real].sort().join(", ")})`);
      }
    }
  }
}

// 0-b) 타임라인이 부르는 명령이 「촬영 전 준비」 블록에 다 있는가
//
//   이 대본의 원래 결함이 **화면에 띄우라고 적어 놓고 띄우는 방법을 안 적은 것**
//   이었다(코드블록 0개). 준비 블록을 넣고 나니 이번엔 블록은 `npm run demo`,
//   타임라인은 `npm run demo:ollama` 로 **같은 파일 안에서 두 명령**을 시켰다.
//
//   영준은 이 문서만 보고 녹화한다. 두 명령 중 어느 쪽이 맞는지 그가 판단하게
//   두면 안 된다.
{
  const fence = "`" + "`" + "`";
  const blockStart = script.indexOf("## 촬영 전 준비");
  if (blockStart < 0) {
    fails.push("대본에 「촬영 전 준비」 절이 없다");
  } else {
    // 경계가 타임라인까지 삼키면 **비교하는 두 집합이 겹쳐 비교가 항상 참**이 된다.
    // 첫 타임라인 행과 다음 절 중 먼저 오는 데서 끊는다.
    const nextHeading = script.indexOf("\n## ", blockStart + 5);
    const firstRow = script.slice(blockStart).search(/\n\|\s*\d:\d\d/);
    const ends = [nextHeading, firstRow >= 0 ? blockStart + firstRow : -1].filter((n) => n > 0);
    const blockEnd = ends.length ? Math.min(...ends) : -1;
    const block = script.slice(blockStart, blockEnd > 0 ? blockEnd : undefined);
    // 코드펜스 안만 본다 — 산문에서 이름을 언급한 것과 치라고 적은 것은 다르다.
    const fenced = [...block.matchAll(new RegExp(fence + "[a-z]*\\n([\\s\\S]*?)" + fence, "g"))]
      .map((m) => m[1]).join("\n");
    // 주석 줄은 명령이 아니다. 2026-08-18 리뷰 지적: 실행 줄이 `npm run demo` 로
    // 퇴행해도 근처 설명이 `# npm run demo:ollama` 면 검사가 통과해 —
    // **이 검사가 잡으려던 바로 그 불일치를 되살린다.**
    const runnable = fenced
      .split("\n")
      .map((l) => l.replace(/(^|\s)#.*$/, ""))
      .filter((l) => l.trim() && !l.trim().startsWith("#"))
      .join("\n");
    const inBlock = new Set([...runnable.matchAll(/npm run ([a-z0-9:_-]+)/g)].map((m) => m[1]));
    const timeline = script.split("\n").filter((l) => /^\|\s*\d:\d\d/.test(l)).join("\n");
    for (const m of timeline.matchAll(/npm run ([a-z0-9:_-]+)/g)) {
      checked++;
      if (!inBlock.has(m[1])) {
        fails.push(`타임라인이 \`npm run ${m[1]}\` 을 부르는데 「촬영 전 준비」 블록에 없다`);
      }
    }
    if (!block.includes(fence)) fails.push("「촬영 전 준비」 절에 명령 블록이 없다");
  }
}

// 0-c) 대본이 스크롤하라는 replica 로그가 **주장을 담고 있는가**
//
//   2026-08-18 실측: 그 파일은 169B 짜리 실패 기록이었다.
//     Error response from daemon: No such container: onprem-mcp-data-db-1
//
//   그런데 report.md 는 그 파일을 근거로 kill-drill 성공을 주장했고 대본은 그걸
//   영상에서 스크롤하라고 했다. **심사자가 보는 화면에 에러가 떴을 것이다.**
//
//   evidence-manifest 는 해시를 기록한다 — 내용이 참인지는 안 본다. 실패한 로그도
//   해시가 있으므로 매니페스트는 만족한다.
//   **존재와 무결성은 참을 보장하지 않는다.**
{
  const rel = "eval/results/replica-spike.log";
  const p = resolve(ROOT, rel);
  if (!existsSync(p)) {
    fails.push(`대본이 스크롤하라는 ${rel} 이 없다 — bash scripts/replica-spike.sh`);
  } else {
    const log = readFileSync(p, "utf8");
    const need = [
      [/in_recovery=t/, "standby 가 recovery 모드로 떴다"],
      [/state.*streaming|streaming\/async/, "streaming replication 성립"],
      [/read-only transaction/, "replica 쓰기 거부"],
      [/replica orders while primary down=(\d+)/, "primary 정지 중 replica 서빙"],
      // 값까지 본다. 2026-08-18 리뷰 지적: psql 이 제때 안 뜨면 명령 치환이 실패해
      // `primary RESTARTED orders=` 만 남고 뒤에 PostgreSQL 오류가 붙는데, 말만 보는
      // 정규식은 그 로그를 승인한다 — **복구를 증명한 적 없는 로그다.**
      [/primary RESTARTED[^\n]*orders=\d+/, "primary 재기동 복구(행 수 포함)"],
    ];
    for (const [re, what] of need) {
      checked++;
      if (!re.test(log)) fails.push(`${rel} 에 「${what}」 증거가 없다 — 실패한 실행이 증거로 남아 있는지 확인하라`);
    }
    if (/Error response from daemon|No such container|is not running/.test(log)) {
      fails.push(`${rel} 이 실행 실패를 기록하고 있다 — 영상에서 이 파일을 스크롤한다`);
    }
  }
}

// 1) internal-llm-summary 의 정확도
const llmClaim = script.match(/internal-llm-summary[^)]*?\((\d+)\/(\d+)\)/);
if (llmClaim) {
  checked++;
  const [, correct, total] = llmClaim.map(Number);
  const s = readJson("eval/results/internal-llm-summary.json");
  if (s && (s.correct !== correct || s.total !== total)) {
    fails.push(
      `대본은 internal-llm ${correct}/${total} 인데 파일은 ${s.correct}/${s.total} 이다`,
    );
  }
}

// 2) ablation 3행 — 순서는 대본 문맥상 template / naive / llm 이다
const abl = script.match(/ablation\s*3행\((\d+)%\/(\d+)%\/(\d+)%\)/);
if (abl) {
  checked++;
  const want = abl.slice(1).map(Number);
  const got = ["template", "naive", "llm"].map((k) => {
    const s = readJson(`eval/results/internal-${k}-summary.json`);
    return s?.accuracy ?? null;
  });
  if (got.some((v, i) => v !== want[i])) {
    fails.push(`대본은 ablation ${want.join("/")}% 인데 파일은 ${got.join("/")}% 이다`);
  }
}

// 3) faults.json — 4/4/4 가 통과 상태인지
if (/faults\.js/.test(script)) {
  checked++;
  // summary 아래에 중첩돼 있다 — 최상위에서 찾다가 오탐을 냈다.
  const raw = readJson("eval/results/faults.json");
  const f = raw?.summary ?? raw;
  if (f && (f.pass !== true || f.total !== 4)) {
    fails.push(`대본이 띄우는 faults.json 이 통과 상태가 아니다: ${JSON.stringify(f)}`);
  }
}

console.log(`대본이 화면에 띄우라는 아티팩트 ${checked}종을 실물과 대조했다.`);

if (checked === 0) {
  console.error("\n실패: 대조한 항목이 0개다 — 대본 형식이 바뀌었는지 확인한다.\n");
  process.exit(1);
}

if (fails.length) {
  console.error("\n대본과 실물이 어긋난다:");
  for (const f of fails) console.error(`  - ${f}`);
  console.error("\n영상에 그대로 찍힌다 — 녹화 전에 고친다.\n");
  process.exit(1);
}

console.log("OK: 대본이 띄우는 수치가 실물과 일치한다.");
console.log("    (파일을 화면에 띄우는 장면은 값이 낡으면 영상에 그대로 남는다.)");
