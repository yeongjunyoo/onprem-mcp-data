// 감사 레코드 전량 내보내기 — 사업자 공개 30문항을 돌려 호출별 근거를 파일로 남긴다.
//
// 왜 파일인가. "재현 가능한 감사"는 도구를 호출할 수 있는 사람에게만 열려 있으면
// 반쪽이다. 심사자와 검증기관은 저장소만 보고도 "이 시스템이 무엇을 근거로 답하고
// 무엇을 거부했는지"를 확인할 수 있어야 한다.
//
// 추가로 결정론을 직접 증명한다. 같은 질의를 두 번 돌려 **답변을 제외한 지문이
// 일치하는지** 확인하고 그 결과를 함께 기록한다.
//
// 사용: EMBEDDER=ollama DATASET=companyx node dist/cli/companyx-audit-export.js
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildAuditRecord, redactForPublication, type AuditRecord } from "../auditrecord.js";
import { datasetDir, requireDataset } from "../companyx.js";
import { closePool, getPool } from "../db.js";
import { getEmbedder } from "../embedder.js";
import { ask } from "../pipeline.js";

async function main() {
  requireDataset();
  const here = dirname(fileURLToPath(import.meta.url));
  const root = resolve(here, "../../..");
  const questions = JSON.parse(await readFile(join(datasetDir(), "questions.json"), "utf8")) as {
    q: string;
    tool: string;
  }[];

  const pool = getPool();
  const embedder = getEmbedder();
  const records: AuditRecord[] = [];
  const determinism: {
    q: string;
    routing: [string, string];
    pipeline: [string, string];
    routing_same: boolean;
    pipeline_same: boolean;
  }[] = [];

  for (const [i, item] of questions.entries()) {
    const r = await ask(item.q, { pool, embedder });
    const rec = buildAuditRecord(r);
    records.push(rec);
    console.log(
      `[${i + 1}/${questions.length}] ${rec.routing_fingerprint}/${rec.pipeline_fingerprint} ${rec.routing.lane} ` +
        `정책 ${rec.policies.map((p) => `${p.policy}:${p.verdict}`).join(",") || "없음"} :: ${item.q.slice(0, 34)}`,
    );

    // 앞 다섯 문항만 두 번 돌려 지문 일치를 확인한다(전량 재실행은 시간이 두 배다).
    if (i < 5) {
      const again = buildAuditRecord(await ask(item.q, { pool, embedder }));
      determinism.push({
        q: item.q,
        routing: [rec.routing_fingerprint, again.routing_fingerprint],
        pipeline: [rec.pipeline_fingerprint, again.pipeline_fingerprint],
        routing_same: rec.routing_fingerprint === again.routing_fingerprint,
        pipeline_same: rec.pipeline_fingerprint === again.pipeline_fingerprint,
      });
    }
  }

  const policyCount = new Map<string, number>();
  for (const rec of records) {
    for (const p of rec.policies) {
      const key = `${p.policy}:${p.verdict}`;
      policyCount.set(key, (policyCount.get(key) ?? 0) + 1);
    }
  }
  const groundingViolations = records.filter((r) => (r.grounding?.outside_context.length ?? 0) > 0);
  const brokenRows = records.filter((r) => (r.context.broken_rows ?? 0) > 0);

  const out = {
    dataset: "companyx-dataset-v1.0 / questions.json",
    questions: questions.length,
    summary: {
      policies: Object.fromEntries([...policyCount.entries()].sort()),
      grounding_violations: groundingViolations.length,
      broken_rows_violations: brokenRows.length,
      determinism_checked: determinism.length,
      routing_stable: determinism.filter((d) => d.routing_same).length,
      pipeline_stable: determinism.filter((d) => d.pipeline_same).length,
    },
    determinism,
    // 저장소에 남는 산출물에서는 사업자 문서 본문을 가린다(재배포 금지 조건).
    // 런타임 감사에는 preview 가 그대로 있다 — 가리는 것은 파일뿐이다.
    records: records.map(redactForPublication),
    note:
      "감사 레코드는 순수 변환이다(auditrecord.ts). 지문은 둘로 나뉜다. routing_fingerprint는 규칙 구간(라우팅과 정책)만 " +
      "덮으므로 같은 질의에서 항상 같아야 한다. pipeline_fingerprint는 모델이 만든 SQL까지 덮으므로 로컬 7B의 실행 간 " +
      "변동이 그대로 드러난다. 두 값을 나눈 이유는 무엇이 결정론이고 무엇이 아닌지를 숨기지 않기 위해서다. " +
      "broken_rows는 큐레이터의 구조 보존 계약이라 0이 아니면 결함이다.",
    generated_at: new Date().toISOString(),
  };

  await mkdir(resolve(root, "eval/results"), { recursive: true });
  await writeFile(resolve(root, "eval/results/companyx-audit.json"), JSON.stringify(out, null, 2) + "\n");
  console.log(`\n${JSON.stringify(out.summary, null, 2)}`);
  await closePool();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
