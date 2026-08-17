// MCP resources — 호스트가 도구를 부르지 않고도 열람할 수 있는 데이터 표면.
//
// 왜 도구만으로 부족한가. 도구는 "무언가를 실행해 달라"는 요청이고, 리소스는
// "네가 무엇을 알고 있는지 보여 달라"는 요청이다. 스키마, 온톨로지, 데이터셋
// 출처, 평가 원자료는 실행 대상이 아니라 **읽을 대상**이다. 이걸 도구 뒤에
//숨겨 두면 호스트는 서버가 무엇을 근거로 답하는지 알 수 없고, 심사자는 답을
// 검증하려면 매번 도구를 호출해야 한다.
//
// 전부 읽기 전용이고 데이터베이스 없이도 응답한다(스키마 카드와 매니페스트는
// 파일과 상수에서, 평가 요약은 커밋된 결과 JSON에서 읽는다). 그래서 이 리소스는
// 심사자가 서버만 띄우고도 근거 체계를 확인하는 경로가 된다.
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineResource } from "@airmcp-dev/core";

import { profile } from "./profile.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/** 평가 결과 JSON들의 요약 — 수치를 주장이 아니라 파일로 보여 준다. */
async function evalSummary(): Promise<string> {
  const dir = join(repoRoot, "eval", "results");
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return "eval/results 디렉터리를 찾지 못했습니다. 저장소 루트에서 실행했는지 확인하세요.";
  }
  const lines: string[] = [
    "# 평가 원자료 목록",
    "",
    "각 파일은 실행 결과 그대로다. 정확도 채점에 자체 제작 LLM 심판을 쓰지 않았고,",
    "채점자는 데이터베이스 실행 결과이거나 사전에 정의된 정답 집합이다.",
    "",
  ];
  for (const f of files) {
    const raw = await readIfExists(join(dir, f));
    if (!raw) continue;
    let head = "";
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const summary = (parsed.summary ?? parsed) as Record<string, unknown>;
      const keys = Object.keys(summary).slice(0, 6);
      head = keys.map((k) => `${k}=${JSON.stringify((summary as Record<string, unknown>)[k])}`).join(" ");
    } catch {
      head = "(JSON 파싱 실패)";
    }
    lines.push(`- **${f}** — ${head.slice(0, 300)}`);
  }
  return lines.join("\n");
}

export function buildResources() {
  const ds = profile();
  return [
    defineResource({
      // URI 에 companyx 를 박지 않는다. 이 핸들러는 **활성 프로파일**의 카드를
      // 돌려주므로, DATASET 미설정이면 스모크 시드(orders/documents)를 준다.
      // 종전 URI 는 `schema://companyx/tables` 였고, 심사자가 그걸 열면 이름은
      // companyx 인데 내용은 8테이블이 아닌 스모크 스키마였다 — 이름이 거짓말을
      // 하고 있었다.
      uri: "schema://dataset/tables",
      name: "스키마 카드 (활성 프로파일)",
      description:
        "NL2SQL이 실제로 받는 스키마 카드. 테이블, 컬럼, 외래키, 그리고 상태 컬럼의 값 어휘까지 포함한다. " +
        "이 카드가 정확도를 좌우한다는 것이 이 프로젝트의 실증 논지이므로 카드 원문을 공개한다. " +
        "지금 어느 프로파일의 카드인지는 응답 첫 줄이 스스로 밝힌다.",
      mimeType: "text/plain",
      handler: () => {
        const p = profile();
        // 결과가 스스로 출처를 말하게 한다. 이걸 빼면 읽는 사람은 자기가 무엇을
        // 보고 있는지 다른 리소스를 열어 봐야 안다.
        return `# 프로파일: ${p.name} — 이 카드는 지금 서버가 바라보는 코퍼스의 것이다.\n` +
          `# 사업자 공식 데이터셋을 보려면 DATASET=companyx 로 기동한다.\n\n` +
          p.schemaCard;
      },
    }),

    defineResource({
      uri: "dataset://companyx/manifest",
      name: "데이터셋 매니페스트",
      description:
        "평가에 사용한 사업자 데이터셋의 출처와 무결성 명세. 배포 조건이 대회 목적 한정이라 " +
        "저장소에 재배포하지 않고 취득 스크립트와 SHA-256으로 재현한다.",
      mimeType: "text/markdown",
      handler: async () =>
        (await readIfExists(join(repoRoot, "datasets", "MANIFEST.md"))) ??
        "datasets/MANIFEST.md 를 찾지 못했습니다. scripts/fetch-companyx-dataset.sh 로 데이터셋을 먼저 받으세요.",
    }),

    defineResource({
      uri: "eval://results/index",
      name: "평가 원자료 색인",
      description:
        "eval/results 의 모든 실행 결과 파일과 각 파일의 요약. 보고서가 인용하는 수치는 전부 여기서 나온다.",
      mimeType: "text/markdown",
      handler: evalSummary,
    }),

    defineResource({
      uri: "profile://dataset/active",
      name: "활성 데이터 프로파일",
      description:
        "지금 서버가 바라보는 코퍼스. companyx(사업자 공식 데이터셋), bench(결정론 합성 벤치), smoke(스모크 시드) 중 하나다. " +
        "심사자가 서버를 띄웠을 때 어떤 데이터를 보고 있는지 즉시 확인할 수 있어야 한다.",
      mimeType: "application/json",
      handler: () =>
        JSON.stringify(
          {
            profile: ds.name,
            description: ds.description,
            kg_schema: ds.kgSchema,
            vector_table: ds.vectorTable,
            embed_dim: ds.embedDim ?? null,
            env: { DATASET: process.env.DATASET ?? "(미설정, 기본값 사용)" },
          },
          null,
          2,
        ),
    }),

    defineResource({
      uri: "audit://schema/v1",
      name: "감사 레코드 스키마",
      description:
        "audit.explain이 돌려주는 레코드의 구조와 각 정책의 의미. 감사 결과를 파싱하려는 쪽이 먼저 읽을 문서다.",
      mimeType: "application/json",
      handler: () =>
        JSON.stringify(
          {
            schema: "onprem-mcp-data/audit/v1",
            fields: {
              fingerprint: "답변을 제외한 결정론 구간의 해시. 같은 질의는 같은 값을 낸다",
              routing: "선택된 레인과 근거가 된 어휘, 결정론 여부",
              retrieval: "레인별 실행 결과와 후보 수",
              fusion: "RRF 상위 항목과 합의한 소스",
              context: "큐레이션 결과. broken_rows는 항상 0이어야 한다(큐레이터 계약)",
              policies: "실제로 발동한 정책만 기록한다",
              grounding: "답변이 컨텍스트 밖 개체를 만들었는지",
            },
            policies: {
              "sql-read-only": "읽기 전용 트랜잭션과 최소권한 롤. deny면 사유를 함께 적는다",
              "sql-repair": "거부된 SQL을 데이터베이스 카탈로그와 함께 1회 되먹여 교정",
              "graph-unresolved-gate": "질의가 지목한 개체를 해소하지 못하면 컨텍스트를 0건으로(환각 차단)",
              "context-budget": "토큰 예산으로 후보를 자름",
              "branch-isolation": "레인 하나가 실패해도 나머지로 응답",
            },
          },
          null,
          2,
        ),
    }),

    defineResource({
      uri: "docs://report/evidence",
      name: "개발보고서 증거 목록",
      description:
        "개발보고서에서 수치와 재현 커맨드를 연결한 절. 어떤 수치가 어떤 명령으로 나오는지 한 곳에서 본다.",
      mimeType: "text/markdown",
      handler: async () => {
        const raw = await readIfExists(join(repoRoot, "docs", "report.md"));
        if (!raw) return "docs/report.md 를 찾지 못했습니다.";
        // Evidence manifest 절만 잘라 준다. 전문은 저장소에서 읽는다.
        const start = raw.indexOf("## 9. Evidence manifest");
        if (start < 0) return raw.slice(0, 4000);
        const rest = raw.slice(start);
        const end = rest.indexOf("\n## ", 3);
        return end > 0 ? rest.slice(0, end) : rest;
      },
    }),
  ];
}
