// 다단계 실행기 — 개체 해소와 관계 탐색과 집계를 직접 엮어 한 질문을 끝까지 푼다.
//
// 왜 이게 다른가. 라우터는 한 질의를 한 레인에 맡긴다. 그래서 "Client-A가 쓰는
// 제품의 총 매출은?"처럼 두 레인을 **연달아** 거쳐야 하는 질의를 한 번의 호출로는
// 못 푼다(그래프가 Client-A를 해소해야 SQL이 제품 목록으로 집계할 수 있다).
//
// 왜 임시로 붙였다가 지우지 않고 모듈로 남기는가. 이 코드가 바로 "어떻게 왔는가"를
// 설명하는 계약이기 때문이다. 각 단계는 개체 해소, 관계 탐색, 집계 중 하나이고 각각
// 감사 레코드로 판정된다. 정의와 실행이 분리돼 있어 평가가 검증을 대신하지 않는다.
import type { Pool } from "pg";

import { graphExpand, kgSchema, ontologySearch } from "./graph.js";
import { sqlQuery } from "./sql.js";

export interface MultiStepResult {
  /** 단계별 결과. 각각 독립적으로 성공 또는 실패. */
  steps: {
    name: string;
    ok: boolean;
    detail: string;
    /** 다음 단계가 쓸 출력. */
    out?: unknown;
  }[];
  /** 마지막 컨텍스트(답변 생성에 쓸 근거 묶음). */
  context: string;
  /** 모든 필수 단계가 통과했는가. */
  complete: boolean;
}

/** 문자열 집계 열을 SQL 인젝션 없이 만든다. 허용 목록 밖이면 실패다. */
const AGG: Record<string, string> = {
  count: "COUNT(*)",
  sum: "SUM(amount)",
  avg: "AVG(amount)",
  max: "MAX(amount)",
};

/**
 * 다단계 계획 실행. 계획은 평가자가 정의하고 이 함수는 실행만 한다.
 * 각 단계의 출력은 다음 단계의 입력이 되므로 한 단계가 끊기면 그 뒤는 실행하지 않는다.
 */
export async function runMultiStep(
  pool: Pool,
  plan: { name: string; kind: "resolve" | "graph" | "sql"; spec: Record<string, unknown> }[],
  input: string,
): Promise<MultiStepResult> {
  const steps: MultiStepResult["steps"] = [];
  let current: unknown = input;
  let complete = true;
  const schema = kgSchema();

  for (const step of plan) {
    if (step.kind === "resolve") {
      const r = await ontologySearch(pool, String(current), Number(step.spec.k ?? 5), schema);
      if (!r.ok || !r.hits.length) {
        steps.push({ name: step.name, ok: false, detail: `개체 해소 실패: ${r.error ?? "결과 없음"}` });
        complete = false;
        break;
      }
      const top = r.hits[0];
      steps.push({ name: step.name, ok: true, detail: `${top.canonicalName} (${top.type})`, out: top });
      current = top;
    } else if (step.kind === "graph") {
      // 시드는 하나일 수도, 이전 단계가 만든 목록일 수도 있다.
      // 목록이면 각 시드의 관계를 돌고 결과를 모은다.
      const seeds: { entityId?: number; name?: string; type?: string }[] = Array.isArray(current)
        ? (current as { entityId?: number; name?: string; type?: string }[])
        : [current as { entityId?: number; name?: string; type?: string }];
      const relTypes = step.spec.relTypes as string[] | undefined;
      const endTypes = step.spec.endTypes as string[] | undefined;
      const depth = Number(step.spec.depth ?? 1);
      const allEdges: unknown[] = [];
      const endpoints: { name: string; type: string; entityId: number }[] = [];
      const seenEndpoint = new Set<string>();
      let failed: string | null = null;
      let visited = 0;
      for (const seed of seeds) {
        const entityId = (seed as { entityId?: number }).entityId ?? Number(step.spec.entityId);
        if (!Number.isFinite(entityId)) continue;
        const r = await graphExpand(pool, entityId, depth, relTypes, schema, "both");
        if (!r.ok) {
          failed = r.error ?? "unknown";
          continue;
        }
        visited++;
        for (const e of r.edges as any[]) {
          allEdges.push(e);
          const isSeed = e.srcId === entityId;
          const endId = isSeed ? e.dstId : e.srcId;
          const endName = isSeed ? e.dstName : e.srcName;
          const endType = isSeed ? e.dstType : e.srcType;
          if (endTypes && !endTypes.includes(endType)) continue;
          const key = `${endId}`;
          if (!seenEndpoint.has(key)) {
            seenEndpoint.add(key);
            endpoints.push({ name: endName, type: endType, entityId: endId });
          }
        }
      }
      if (!endpoints.length) {
        steps.push({
          name: step.name,
          ok: false,
          detail: `관계 탐색 실패: ${failed ?? "엣지 없음"} (시드 ${seeds.length}개 중 ${visited}개 조회)`,
        });
        complete = false;
        break;
      }
      steps.push({ name: step.name, ok: true, detail: `${endpoints.length}개 끝점 (시드 ${visited}개)`, out: endpoints });
      current = endpoints;
    } else {
      // sql
      const sql = String(step.spec.sql ?? "");
      const r = await sqlQuery(pool, sql);
      if (!r.ok) {
        steps.push({ name: step.name, ok: false, detail: `SQL 거부: ${r.error ?? "unknown"}` });
        complete = false;
        break;
      }
      // 집계 쿼리는 항상 한 행이 나온다. 행이 0이어도 단계는 성공이고,
      // "맞는 데이터가 없다"와 "SQL이 틀렸다"를 구분해 detail에 남긴다.
      const hasValue = r.rows.some((row) => Object.values(row).some((v) => v !== null && v !== "" && v !== 0));
      steps.push({
        name: step.name,
        ok: true,
        detail: `${r.rowCount}행${hasValue ? "" : " (조건에 맞는 데이터 없음)"}`,
        out: r.rows,
      });
      current = r.rows;
    }
  }

  // 컨텍스트: 각 단계의 출력을 구조를 깨지 않고 이어 붙인다.
  const context = steps
    .map((s) => {
      if (Array.isArray(s.out)) {
        return `[${s.name}] ${s.out.map((x: any) => x.name ?? JSON.stringify(x)).slice(0, 12).join(", ")}`;
      }
      if (s.out && typeof s.out === "object" && "canonicalName" in (s.out as object)) {
        const o = s.out as { canonicalName: string; type: string };
        return `[${s.name}] ${o.canonicalName} (${o.type})`;
      }
      return `[${s.name}] ${s.detail}`;
    })
    .join("\n");

  return { steps, context, complete };
}

export function aggregateSql(agg: string, table: string, filterCol: string, values: string[]): string | null {
  const fn = AGG[agg];
  if (!fn) return null;
  if (!/^[a-z_][a-z0-9_.]*$/.test(table) || !/^[a-z_][a-z0-9_.]*$/.test(filterCol)) return null;
  const list = values.map((v) => `'${String(v).replace(/'/g, "''")}'`).join(",");
  return `SELECT ${fn} AS value FROM ${table} WHERE ${filterCol} IN (${list})`;
}


/** 사실 테이블과 차원 테이블을 JOIN해 이름 목록으로 집계한다. FK와 컬럼은 허용 목록만. */
export function joinAggregateSql(
  agg: string,
  factTable: string,
  dimTable: string,
  fkCol: string,
  dimCol: string,
  values: string[],
): string | null {
  const fn = AGG[agg];
  if (!fn) return null;
  for (const id of [factTable, dimTable, fkCol, dimCol]) {
    if (!/^[a-z_][a-z0-9_.]*$/.test(id)) return null;
  }
  const list = values.map((v) => `'${String(v).replace(/'/g, "''")}'`).join(",");
  return (
    `SELECT ${fn} AS value FROM ${factTable} f ` +
    `JOIN ${dimTable} d ON f.${fkCol} = d.id ` +
    `WHERE d.${dimCol} IN (${list})`
  );
}
