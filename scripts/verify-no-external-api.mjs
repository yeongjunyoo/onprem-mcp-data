// "외부 API를 호출하지 않는다" 를 주장이 아니라 검사 결과로 만든다.
//
// 이 문장은 이 프로젝트 피치의 핵심이다(온프렘, 사내 데이터 미유출). 그런데
// 지금까지 아무도 검사하지 않았다 — SBOM 의 "카피레프트 0건" 이 그랬던 것과
// 같은 형태다. 누군가 OpenAI 든 무엇이든 원격 호출을 하나 넣어도 문서는 태연히
// "외부 API 0" 이라고 적었을 것이다.
//
// 검사 방식: 런타임 소스(air-server/src)에서 네트워크를 실제로 여는 호출의
// 대상 호스트를 찾아, 루프백이 아닌 것이 있으면 실패한다.
//
// ★ 선언된 범위 한계 (덮지 못하는 것을 덮은 척하지 않는다)
//   - 정적 검사다. 런타임에 조립되는 URL(`${base}/x`)의 base 가 환경변수면
//     그 값까지는 못 본다. 대신 환경변수 기본값이 루프백인지는 본다.
//   - 문자열 상수로 적힌 출처·문서 링크는 호출이 아니다. fetch/axios 등
//     **호출 지점의 인자**만 대상으로 한다.
//   - 의존 패키지 내부의 텔레메트리는 이 검사의 범위가 아니다. SBOM 과
//     네트워크 차단 실행(데모는 네트워크 off 로 녹화한다)이 그 몫이다.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = resolve(ROOT, "air-server/src");

/** 루프백으로 인정하는 호스트. 이 밖은 전부 외부다. */
const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0|host\.docker\.internal)$/i;
/** compose 네트워크 안의 형제 서비스명 — 컨테이너 내부 주소이지 인터넷이 아니다. */
const COMPOSE_SERVICES = /^(db|ollama|mcp)$/i;

const files = [];
(function walk(dir) {
  for (const n of readdirSync(dir)) {
    const p = resolve(dir, n);
    if (statSync(p).isDirectory()) walk(p);
    else if (n.endsWith(".ts")) files.push(p);
  }
})(SRC);

const fails = [];
const seen = [];

// fetch(...) / axios(...) / got(...) / request(...) 의 첫 인자에서 호스트를 뽑는다.
const CALL = /\b(?:fetch|axios(?:\.\w+)?|got(?:\.\w+)?|request)\s*\(\s*([^)]{0,200})/g;
const HOST = /https?:\/\/([A-Za-z0-9._\-[\]]+)/;

for (const p of files) {
  const rel = p.slice(ROOT.length + 1).replace(/\\/g, "/");
  const text = readFileSync(p, "utf8");
  for (const m of text.matchAll(CALL)) {
    const arg = m[1];
    const h = HOST.exec(arg);
    if (!h) continue; // 템플릿 변수만 있는 경우 — 아래 환경변수 기본값 검사로 넘어간다
    const host = h[1];
    seen.push(`${rel}: ${host}`);
    if (!LOOPBACK.test(host) && !COMPOSE_SERVICES.test(host)) {
      fails.push(`${rel} 이 외부 호스트를 호출한다: ${host}`);
    }
  }
}

// 네트워크 대상이 되는 환경변수의 **기본값**도 본다. 기본이 외부면 아무 설정
// 없이 돌렸을 때 밖으로 나간다.
const ENV_DEFAULT = /process\.env\.(OLLAMA_HOST|DATABASE_URL|READ_DATABASE_URL)\s*\?\?\s*["'`]([^"'`]+)["'`]/g;
for (const p of files) {
  const rel = p.slice(ROOT.length + 1).replace(/\\/g, "/");
  for (const m of readFileSync(p, "utf8").matchAll(ENV_DEFAULT)) {
    const [, name, val] = m;
    const h = HOST.exec(val) ?? /@([A-Za-z0-9._-]+):\d+/.exec(val);
    if (!h) continue;
    seen.push(`${rel}: ${name} 기본값 -> ${h[1]}`);
    if (!LOOPBACK.test(h[1]) && !COMPOSE_SERVICES.test(h[1])) {
      fails.push(`${rel} 의 ${name} 기본값이 외부다: ${h[1]}`);
    }
  }
}

console.log(`검사한 네트워크 지점 ${seen.length}곳 (런타임 소스 ${files.length}파일):`);
for (const s of [...new Set(seen)].sort()) console.log(`  ${s}`);

if (fails.length) {
  console.error("\n외부 API 호출이 발견됐다 — 문서의 '외부 API 0' 주장을 그대로 둘 수 없다:");
  for (const f of fails) console.error(`  - ${f}`);
  console.error("\n온프렘 전제가 깨진다. 호출을 없애거나 문서 주장을 고친다.\n");
  process.exit(1);
}

console.log("\nOK: 런타임 소스의 네트워크 대상이 전부 루프백 또는 compose 형제 서비스다.");
console.log("    (정적 검사다. 의존 패키지 내부 텔레메트리는 SBOM 과 네트워크 차단 실행이 담당한다.)");
