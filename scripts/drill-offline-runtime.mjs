// 이 프로젝트의 중심 주장을 **런타임에서** 확인한다: 외부로 나가지 않는다.
//
// `verify-no-external-api.mjs` 는 정적 검사다 — 소스에 외부 호스트가 없는지 본다.
// 그 검사 자신이 출력에 밝히듯, **의존 패키지 내부의 텔레메트리나 런타임에
// 조립되는 URL 은 못 본다.**
//
// 심사자가 "정말 온프렘이냐" 를 의심하면 정적 검사를 읽지 않는다. 돌려 보고
// 네트워크를 본다. 그래서 그렇게 한다.
//
// ★ 표본기가 눈이 멀었는지 먼저 증명한다.
//   2026-08-17 에 이 드릴의 초판이 "TCP 표본 0건 → 외부 없음" 을 냈다. 데모는
//   확실히 5433(DB)과 11435(Ollama)에 붙는데 **그것조차 못 본 상태**였다.
//   아무것도 안 보고 낸 초록은 증거가 아니다.
//
//   그래서 알려진 로컬 연결을 못 보면 **판정을 기각하고 exit 1** 한다.
//
// ★ 측정 범위를 주장 범위에 맞춘다.
//   초판은 `netstat` 전체를 집계해 브라우저·에디터 연결 29종을 "외부" 로 신고했다.
//   주장은 "이 서버가" 이므로 node 프로세스의 연결만 본다.
//
// 실행: node scripts/drill-offline-runtime.mjs
// 필요: docker compose up -d, 모델 2종, companyx 데이터셋. Windows(netstat/tasklist).
import { execFileSync, spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOCAL = /^(127\.|0\.0\.0\.0|\[?::1\]?|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/;

const samples = new Map();
const sniffErrors = { tasklist: 0, netstat: 0 };
let sampling = true;

function nodePids() {
  try {
    const out = execFileSync("tasklist", ["/FI", "IMAGENAME eq node.exe", "/FO", "CSV", "/NH"], {
      encoding: "utf8",
    });
    return new Set(
      out
        .split("\n")
        .filter((l) => l.includes('","'))
        .map((l) => Number(l.split('","')[1]))
        .filter(Boolean),
    );
  } catch {
    // 조용히 넘기면 표본기가 눈이 먼다 — 그게 이 드릴의 초판이 아무것도 못 본 이유다.
    // 매 150ms 루프라 여기서 로그를 찍으면 화면이 넘치므로, 세어서 끝에 한 번 말한다.
    sniffErrors.tasklist++;
    return new Set();
  }
}

function sampleOnce() {
  const pids = nodePids();
  if (!pids.size) return;
  let out;
  try {
    out = execFileSync("netstat", ["-ano", "-p", "TCP"], { encoding: "utf8" });
  } catch {
    sniffErrors.netstat++; // 같은 이유로 센다 (위 주석 참조)
    return;
  }
  for (const line of out.split("\n")) {
    const p = line.trim().split(/\s+/);
    if (p.length < 5 || p[0] !== "TCP") continue;
    const [, , remote, state, pid] = p;
    if (!/^\d+$/.test(pid) || !pids.has(Number(pid))) continue;
    if (state !== "ESTABLISHED" && state !== "SYN_SENT") continue;
    samples.set(remote, (samples.get(remote) ?? 0) + 1);
  }
}

const timer = setInterval(() => {
  if (sampling) sampleOnce();
}, 150);

// LLM 을 가장 많이 부르는 경로. 외부 호출이 있다면 여기서 난다.
const child = spawn("npm", ["run", "companyx:ask"], {
  cwd: resolve(ROOT, "air-server"),
  env: { ...process.env },
  stdio: "ignore",
  shell: true,
});

const code = await new Promise((res) => child.on("close", res));
sampling = false;
clearInterval(timer);

console.log(`companyx:ask 종료 코드 ${code} · TCP 표본 ${samples.size}종`);

if (code !== 0) {
  console.error("\n평가가 실패했다 — 스택과 데이터셋을 먼저 확인한다.\n");
  process.exit(1);
}

const local = [...samples].filter(([r]) => LOCAL.test(r));
const external = [...samples].filter(([r]) => !LOCAL.test(r));

console.log("\n로컬:");
for (const [r, n] of local.sort((a, b) => b[1] - a[1]).slice(0, 8)) {
  console.log(`  ${r.padEnd(26)} ${n}회`);
}

// 눈이 멀었는지 먼저 본다.
const known = local.filter(([r]) => r.endsWith(":5433") || r.endsWith(":11435"));
if (!known.length) {
  console.error("\n판정 기각: 알려진 로컬 연결(5433 DB / 11435 Ollama)조차 못 봤다.");
  console.error("  표본기가 눈이 먼 상태라 '외부 없음' 은 증거가 될 수 없다.");
  console.error("  샘플 주기·프로세스 필터를 확인한다.\n");
  process.exit(1);
}
console.log(`\n표본기 시력 확인: ${known.map(([r]) => r).join(", ")} 를 봤다.`);
if (sniffErrors.tasklist || sniffErrors.netstat) {
  console.log(
    `    (표본 중 실패 — tasklist ${sniffErrors.tasklist}회 · netstat ${sniffErrors.netstat}회. ` +
      `시력은 위에서 증명됐으므로 판정은 유효하다.)`,
  );
}

if (external.length) {
  console.error("\n외부로 나간 연결이 있다:");
  for (const [r, n] of external.sort((a, b) => b[1] - a[1])) {
    console.error(`  - ${r} (${n}회)`);
  }
  console.error("\n'외부 API 없음' 주장과 어긋난다.\n");
  process.exit(1);
}

console.log("\nOK: LLM 평가가 도는 동안 node 프로세스가 외부로 나가지 않았다.");
console.log("    (정적 검사가 못 보는 층을 런타임으로 덮는다 — 표본기 시력을 먼저 증명한다.)");
