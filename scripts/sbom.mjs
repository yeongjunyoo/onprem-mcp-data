#!/usr/bin/env node
// SBOM 생성기 — 결과보고서 붙임1(소프트웨어 자재명세서)과 라이선스 검증 대비용.
// 근거: node_modules에 실제로 설치된 package.json을 읽는다(선언이 아니라 설치 상태).
// 사용: node scripts/sbom.mjs > docs/sbom.md
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = path.join(root, 'air-server');
const pkg = JSON.parse(fs.readFileSync(path.join(app, 'package.json'), 'utf8'));

// 직접 의존성의 사용 목적 — 사람이 유지하는 유일한 수기 항목.
const PURPOSE = {
  '@airmcp-dev/core': 'MCP 서버 프레임워크(air). 도구 등록, transport, 라이프사이클 관리',
  pg: 'PostgreSQL 클라이언트. 관계형 조회, pgvector 유사도 검색, 읽기 엔드포인트 풀링',
  typescript: '빌드 도구(개발 전용). 타입 검사 및 dist 트랜스파일',
  '@types/node': '타입 정의(개발 전용)',
  '@types/pg': '타입 정의(개발 전용)',
};

// 런타임 6종은 npm 트리에 없어서 **손으로 적는다.** 그래서 조용히 낡는다 —
// 2026-08-18 에 pgvector 0.6.0(실물 0.8.6) · Ollama 0.32.4(실물 0.32.14)로
// 남아 있었고, 붙임1 SBOM 표에 그대로 인쇄돼 있었다(라이선스 배점 5점 자리).
//
// verify-loaded-corpus 가 살아 있는 스택에 물어 이 표와 대조한다.
const RUNTIME = [
  ['PostgreSQL', '16', 'PostgreSQL License (OSI 인증)', 'https://github.com/postgres/postgres', '관계형 저장소와 온프렘 클러스터(primary, replica)'],
  ['pgvector', '0.8.6', 'PostgreSQL License (OSI 인증)', 'https://github.com/pgvector/pgvector', '벡터 인덱스와 코사인 유사도 검색'],
  ['Ollama', '0.32.14', 'MIT', 'https://github.com/ollama/ollama', '로컬 LLM과 임베딩 런타임(외부 API 호출 없음)'],
  ['qwen2.5-coder:7b', '7B', 'Apache-2.0 (오픈웨이트)', 'https://huggingface.co/Qwen/Qwen2.5-Coder-7B-Instruct', '질의 의도 분해와 답변 생성(로컬 추론)'],
  ['bge-m3', '567M', 'MIT (오픈웨이트)', 'https://huggingface.co/BAAI/bge-m3', '문서와 질의 임베딩(1024차원, 로컬 추론)'],
  ['Node.js', '20 LTS', 'MIT', 'https://github.com/nodejs/node', 'MCP 서버 런타임'],
];

const installed = [];
const nm = path.join(app, 'node_modules');
const walk = (dir, scoped = false) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === '.bin' || entry.name === '.package-lock.json') continue;
    const full = path.join(dir, entry.name);
    if (!scoped && entry.name.startsWith('@')) { walk(full, true); continue; }
    const manifest = path.join(full, 'package.json');
    if (!fs.existsSync(manifest)) continue;
    try {
      const m = JSON.parse(fs.readFileSync(manifest, 'utf8'));
      if (!m.name || !m.version) continue;
      const repo = typeof m.repository === 'string' ? m.repository : m.repository?.url ?? '';
      installed.push({
        name: m.name,
        version: m.version,
        license: m.license ?? (Array.isArray(m.licenses) ? m.licenses.map(l => l.type).join('/') : '미표기'),
        repo: normalizeRepo(repo, m.name),
      });
    } catch { /* 손상된 매니페스트는 건너뛴다 */ }
  }
};
function normalizeRepo(url, name) {
  if (!url) return `https://www.npmjs.com/package/${name}`;
  let u = url.replace(/^git\+/, '').replace(/^git:\/\//, 'https://').replace(/^git@github\.com:/, 'https://github.com/').replace(/^ssh:\/\/git@/, 'https://').replace(/\.git$/, '');
  if (!u.startsWith('http')) u = `https://github.com/${u}`;
  // 2026-08-18: 제출 docx 의 URL 112건을 실제로 열어 보니 **하나가 죽어 있었다** -
  // `https://git@github.com/EventSource/eventsource`. npm 필드가
  // `git+https://git@github.com/...` 이라 `git+` 만 떼면 **userinfo 가 남는다.**
  //
  // 심사자는 클릭한다. 라이선스 근거로 건 링크가 죽으면 그 표 전체가 의심받는다.
  // userinfo 를 통째로 벗긴다 - `user:pass@host` 도 같이 처리되어
  // **자격증명이 SBOM 에 실리는 것**까지 막는다(오늘 db.ts 에서 같은 부류를 겪었다).
  u = u.replace(/^(https?:\/\/)[^/@]*@/, '$1');
  return u;
}
walk(nm);
installed.sort((a, b) => a.name.localeCompare(b.name));

const direct = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]);
const directRows = installed.filter(p => direct.has(p.name));
const transitive = installed.filter(p => !direct.has(p.name));

const licenseCount = new Map();
for (const p of installed) licenseCount.set(p.license, (licenseCount.get(p.license) ?? 0) + 1);

// ★ 카피레프트 0건은 **주장이 아니라 검사 결과여야 한다.**
//
// 종전에는 이 문장을 그냥 적었다. 배점 5점이 걸린 라이선스 검증 항목인데, 새
// 의존성이 GPL 을 들고 들어와도 SBOM 은 태연히 "0건" 이라고 적었을 것이다.
// 실제 설치 트리를 훑어 카피레프트를 찾고, 있으면 생성 자체를 실패시킨다.
const COPYLEFT = ["GPL", "AGPL", "LGPL", "MPL", "EPL", "CDDL", "SSPL", "OSL", "EUPL"];
const copyleft = installed.filter((p) => {
  const up = String(p.license).toUpperCase();
  // "GPL" 은 "LGPL"·"AGPL" 의 부분문자열이라 각각이 아니라 전체 토큰으로 본다.
  return COPYLEFT.some((k) => new RegExp(`(^|[^A-Z])${k}([^A-Z]|$)`).test(up));
});
const unlicensed = installed.filter((p) => p.license === "미표기");

if (copyleft.length > 0) {
  console.error("\n카피레프트 의존성이 발견됐다 — SBOM 의 '0건' 주장을 그대로 둘 수 없다:");
  for (const p of copyleft) console.error(`  ${p.name}@${p.version}  ${p.license}`);
  console.error("\n라이선스 충돌 여부를 판단하고 문구를 고친 뒤 다시 생성한다.\n");
  process.exit(1);
}
if (unlicensed.length > 0) {
  console.error(`\n라이선스 미표기 패키지 ${unlicensed.length}건 — 검증 없이 '전부 허용형' 이라 적을 수 없다:`);
  for (const p of unlicensed.slice(0, 10)) console.error(`  ${p.name}@${p.version}`);
  console.error("\n각 패키지의 실제 라이선스를 확인하고 매니페스트를 고친다.\n");
  process.exit(1);
}

const out = [];
out.push('# 붙임1 SBOM (소프트웨어 자재명세서)');
out.push('');
out.push(`> 생성 = \`node scripts/sbom.mjs\`. 근거 = \`air-server/node_modules\`에 **실제 설치된** 매니페스트(선언이 아니라 설치 상태).`);
out.push(`> 생성 시각 ${new Date().toISOString()}`);
out.push(`> npm 패키지 ${installed.length}개(직접 ${directRows.length} / 전이 ${transitive.length}) + 런타임 구성요소 ${RUNTIME.length}개.`);
out.push(`> 라이선스 분포: ${[...licenseCount.entries()].sort((a, b) => b[1] - a[1]).map(([l, c]) => `${l} ${c}`).join(' · ')}.`);
out.push(`> 직접 작성한 소스코드 라이선스 = **Apache-2.0**(OSI 인증, 레포 \`LICENSE\`). 카피레프트(GPL/AGPL/LGPL/MPL/EPL/CDDL/SSPL/OSL/EUPL) 의존성 **0건**, 라이선스 미표기 **0건** → 라이선스 충돌 없음. 이 두 수치는 설치 트리를 훑어 **검사한 결과**이며, 위반이 있으면 이 파일 생성이 실패한다(\`node scripts/sbom.mjs\`).`);
out.push('');
out.push('## 1. 직접 의존성 및 런타임 구성요소');
out.push('');
out.push('| 번호 | 라이브러리명 | 버전 | 라이선스 | 공식 저장소 URL | 사용 목적 및 주요 기능 |');
out.push('| --- | --- | --- | --- | --- | --- |');
let i = 1;
for (const p of directRows) out.push(`| ${i++} | ${p.name} | ${p.version} | ${p.license} | ${p.repo} | ${PURPOSE[p.name] ?? '—'} |`);
for (const r of RUNTIME) out.push(`| ${i++} | ${r[0]} | ${r[1]} | ${r[2]} | ${r[3]} | ${r[4]} |`);
out.push('');
out.push('## 2. 전이 의존성 (자동 수집)');
out.push('');
out.push('| 번호 | 라이브러리명 | 버전 | 라이선스 | 공식 저장소 URL |');
out.push('| --- | --- | --- | --- | --- |');
let j = 1;
for (const p of transitive) out.push(`| ${j++} | ${p.name} | ${p.version} | ${p.license} | ${p.repo} |`);
out.push('');
process.stdout.write(out.join('\n'));
