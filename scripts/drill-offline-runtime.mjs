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
import { copyFileSync, existsSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOCAL = /^(127\.|0\.0\.0\.0|\[?::1\]?|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/;

const samples = new Map();
const sniffErrors = { tasklist: 0, netstat: 0 };
let sampling = true;

/** 우리가 띄운 자식과 **그 자손들**의 PID.
 *
 * 종전에는 이 머신의 모든 node 프로세스를 봤다. 주장은 "우리 시스템이 외부를 안
 * 부른다" 인데 측정은 "이 기계의 어떤 node 도 안 부른다" 였다.
 *
 * 2026-08-18 에 그 차이가 터졌다 — 드릴이 76.76.21.112:443 을 608회 잡고 실패했는데
 * 이 머신에 node 가 11개 돌고 있었고 그중 **Vercel CLI** 와 **다른 프로젝트의
 * Next.js dev 서버**가 있었다. 76.76.21.112 는 Vercel 이다.
 *
 * 넓은 측정은 거짓 무죄를 만들지 않지만 **거짓 유죄**를 만든다. 그리고 빨개지는
 * 검사는 꺼진다. **측정 대상을 주장 대상에 맞춘다.**
 *
 * 트리는 매 표본마다 새로 뜬다 — 자식이 손자를 낳는다(npm → node).
 */
function treePids(rootPid) {
  if (!rootPid) return new Set();
  let rows;
  try {
    rows = execFileSync(
      "powershell",
      ["-NoProfile", "-Command",
       "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Csv -NoTypeInformation"],
      { encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "ignore"] },
    );
  } catch {
    // 조용히 넘기면 표본기가 눈이 먼다 — 세어서 끝에 한 번 말한다.
    sniffErrors.tasklist++;
    return new Set();
  }

  const parent = new Map();
  for (const line of rows.split("\n").slice(1)) {
    const m = line.match(/"?(\d+)"?,"?(\d+)"?/);
    if (m) parent.set(Number(m[1]), Number(m[2]));
  }

  const mine = new Set([rootPid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [pid, ppid] of parent) {
      if (!mine.has(pid) && mine.has(ppid)) {
        mine.add(pid);
        grew = true;
      }
    }
  }
  return mine;
}

function sampleOnce() {
  const pids = treePids(childPid);
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

// ── 컨테이너 층.
//
// 위 표본기는 node 프로세스를 본다 = **우리 코드**가 외부를 안 부른다는 증거.
// 그런데 대본 0:00 장면은 네트워크를 끄고 시작한다 — 그때 살아 있어야 하는 건
// node 뿐이 아니라 postgres·ollama 컨테이너다. 컨테이너가 조용히 밖을 부르면
// 그 화면에서 무언가 실패하고, **그 장면이 헤드라인 주장이다.**
let childPid = 0;   // 스폰 후 채워진다 — 그 전 표본은 비어 있는 게 맞다
const containers = { db: new Set(), ollama: new Set() };
const containerErrors = {};

const hexIp = (h) => [6, 4, 2, 0].map((i) => parseInt(h.slice(i, i + 2), 16)).join(".");

function sampleContainers() {
  for (const svc of Object.keys(containers)) {
    try {
      const out = execFileSync("docker", ["compose", "exec", "-T", svc, "cat", "/proc/net/tcp"],
        { cwd: ROOT, encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "ignore"] });
      for (const line of out.split("\n").slice(1)) {
        const p = line.trim().split(/\s+/);
        if (p.length < 4 || p[3] !== "01") continue; // 01 = ESTABLISHED
        const [ip, port] = p[2].split(":");
        containers[svc].add(`${hexIp(ip)}:${parseInt(port, 16)}`);
      }
    } catch {
      containerErrors[svc] = (containerErrors[svc] ?? 0) + 1;
    }
  }
}

const timer = setInterval(() => {
  if (sampling) {
    sampleOnce();
    sampleContainers();
  }
}, 150);

// ★ 드릴은 네트워크를 보는 것이 목적이지 지표를 재는 게 아니다.
//
// `companyx:ask` 는 `companyx-ask.json` 을 쓰고, 그 안의 지연은 머신 부하에 따라
// 매번 달라진다. 그대로 두면 **드릴을 돌릴 때마다 정본 지연이 바뀐다**
// (2026-08-17 실측: 11674 -> 9719 -> 10606).
//
// 이 저장소는 같은 형태로 두 번 당했다 — 벡터 평가가 코퍼스를 파괴했고(PR #44),
// 홀드아웃2 가 홀드아웃1 정본을 덮었다(PR #96). 평가는 자기가 읽는 것도, 남의
// 정본도 남겨 두고 나와야 한다.
const CANON = resolve(ROOT, "eval", "results", "companyx-ask.json");
const BACKUP = `${CANON}.drill-backup`;
const hadCanon = existsSync(CANON);
if (hadCanon) copyFileSync(CANON, BACKUP);

// LLM 을 가장 많이 부르는 경로. 외부 호출이 있다면 여기서 난다.
  // Node DEP0190: shell 을 쓸 때 args 배열을 함께 넘기면 이스케이프 없이
  // 이어 붙는다고 경고한다. 명령이 정적이라 위험은 없지만 **경고를 읽은
  // 사람은 앞의 보안 주장도 의심한다.** 문자열 하나로 준다.
  // (Windows 의 npm 은 npm.cmd 라 shell 없이 spawn 하면 EINVAL 이다.)
const child = spawn("npm run companyx:ask", {
  cwd: resolve(ROOT, "air-server"),
  env: { ...process.env },
  stdio: "ignore",
  shell: true,
});

childPid = child.pid;
const code = await new Promise((res) => child.on("close", res));
sampling = false;
clearInterval(timer);

// 정본을 되돌리고 **되돌렸다고 말한다** (조용한 복원은 조용한 파괴와 구분이 안 된다).
if (hadCanon) {
  copyFileSync(BACKUP, CANON);
  unlinkSync(BACKUP);
  console.log("정본 복원: eval/results/companyx-ask.json (드릴은 지표를 갱신하지 않는다)");
}

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
// ── 컨테이너 판정. node 층과 **따로** 낸다 — 어느 층을 재고 있는지가 곧 정답이다.
const PRIVATE = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;
const cSeen = Object.values(containers).reduce((n, s2) => n + s2.size, 0);
console.log("\n컨테이너 층:");
for (const [svc, addrs] of Object.entries(containers)) {
  console.log(`  ${svc.padEnd(8)} ${addrs.size}종  ${[...addrs].sort().join(" ") || "(표본 없음)"}`);
}
// 합계가 아니라 **서비스마다** 본다. 2026-08-18 리뷰 지적: 합계면 한쪽 표본만으로도
// 0이 아니게 되고, 못 본 서비스는 빈 집합으로 외부주소 검사를 통과한다 —
// 드릴이 "둘 다 검증됨" 이라 말한다. **못 본 것을 없다고 적지 않는다** 는 이 스크립트의
// 문구가 정작 자기 자신에게는 안 적용되고 있었다.
const blind = Object.entries(containers).filter(([, a]) => a.size === 0).map(([svc]) => svc);
if (blind.length) {
  console.error(`\n실패: 표본이 0건인 컨테이너가 있다 — ${blind.join(", ")}`);
  console.error("  외부가 없는 게 아니라 그 서비스를 못 본 것이다. docker compose 상태를 확인한다.");
  console.error("  **못 본 것을 없다고 적지 않는다.**\n");
  process.exitCode = 1;
} else if (cSeen === 0) {
  console.error("\n실패: 컨테이너 표본이 0건이다 — 외부가 없는 게 아니라 표본기가 눈이 멀었다.\n");
  process.exitCode = 1;
} else {
  const outside = Object.entries(containers).flatMap(([svc, a]) =>
    [...a].filter((x) => !PRIVATE.test(x)).map((x) => `${svc} ${x}`));
  if (outside.length) {
    console.error(`\n실패: 컨테이너가 외부로 나갔다 — ${outside.join(", ")}\n`);
    process.exitCode = 1;
  } else {
    console.log("  OK: 두 컨테이너 모두 사설/루프백 주소로만 연결했다.");
    console.log("      (네트워크를 끄고 찍는 장면이 이 층까지 참이어야 성립한다.)");
  }
}

console.log("    (정적 검사가 못 보는 층을 런타임으로 덮는다 — 표본기 시력을 먼저 증명한다.)");
