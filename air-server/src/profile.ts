// Dataset profile — which corpus every MCP tool serves.
//
// The platform hosts three corpora in one PostgreSQL instance:
//   smoke     public.*      tiny seed (orders/documents) for the 148-test smoke suite
//   bench     bench.*       internal contest-grade benchmark (e-commerce, seed=42)
//   companyx  companyx.*    the sponsor's official Company-X dataset
//
// Before this existed, `route`/`vector.search`/`retrieve`/`ask` were hard-wired to
// the smoke seed while only the eval CLIs knew about companyx. That meant a judge
// starting the MCP server got the toy orders table, not the dataset the 지정과제 is
// about — the lane evals looked green while the product answered from the wrong
// corpus. One profile, selected by DATASET, now feeds every tool.
//
//   DATASET=companyx npm start        # sponsor corpus (default for submission)
//   DATASET=bench    npm run ...      # internal benchmark
//   DATASET=smoke                     # tiny seed (unit/integration tests)

import { type NL2SQL, llmNL2SQL, benchNL2SQL, companyxNL2SQL, SCHEMA_DDL, BENCH_SCHEMA_DDL, COMPANYX_SCHEMA_DDL } from "./nl2sql.js";

export type DatasetName = "smoke" | "bench" | "companyx";

export interface DatasetProfile {
  name: DatasetName;
  /** Schema holding entities/aliases/relations for the graph lane. */
  kgSchema: string;
  /** Table (or view) exposing id/title/body/embedding for vector.search. */
  vectorTable: string;
  /** NL->SQL strategy bound to this corpus's schema card. */
  nl2sql: NL2SQL;
  /** Human-readable schema card (audit / tool description). */
  schemaCard: string;
  /** One-line description for the MCP tool metadata. */
  description: string;
  /** Embedding width the corpus schema declares. companyx = 768 (official DDL). */
  embedDim?: number;
}

const PROFILES: Record<DatasetName, DatasetProfile> = {
  smoke: {
    name: "smoke",
    kgSchema: "bench", // the smoke seed has no KG of its own
    vectorTable: "documents",
    nl2sql: llmNL2SQL,
    schemaCard: SCHEMA_DDL,
    description: "스모크 시드(public.orders/documents)",
  },
  bench: {
    name: "bench",
    kgSchema: "bench",
    vectorTable: "bench.documents",
    nl2sql: benchNL2SQL,
    schemaCard: BENCH_SCHEMA_DDL,
    description: "내부 벤치마크(bench 스키마, e-commerce 8테이블)",
  },
  companyx: {
    name: "companyx",
    kgSchema: "companyx",
    vectorTable: "companyx.documents",
    nl2sql: companyxNL2SQL,
    schemaCard: COMPANYX_SCHEMA_DDL,
    description: "리원에이스 공식 데이터셋 Company-X(8테이블 818행 / 문서 40건 / 그래프 133노드·354엣지)",
    // The official DDL says vector(768). Measured on this corpus, BGE-M3 truncated
    // to 768 keeps hit@5 = 1.00, so the schema is used verbatim instead of widened.
    embedDim: 768,
  },
};

/** Active profile. DATASET wins; KG_SCHEMA stays supported for the older eval CLIs. */
export const PROFILE_NAMES = ["companyx", "bench", "smoke"] as const;

export function profile(): DatasetProfile {
  const raw = process.env.DATASET ?? "";
  const name = raw.toLowerCase();
  if (name === "companyx" || name === "bench" || name === "smoke") return PROFILES[name];

  // ★ 모르는 값은 거절한다. 조용히 기본으로 떨어지면 안 된다.
  //
  // 2026-08-17 실측: `DATASET=nonexistent-profile` 로 조회하면 **130건이 돌아왔다.**
  // 사용자는 자기가 지정한 데이터셋의 결과라고 믿지만 실제로는 smoke 시드다.
  // `companyX` 나 `conpanyx` 같은 오타 하나로 **다른 데이터의 답**을 받는다.
  //
  // 이 저장소가 PR #70 에서 고친 형태 그대로다 — MCP_TRANSPORT 오타가 조용히
  // stdio 로 폴백했다. 같은 교훈: 모르는 값은 거절한다.
  //
  // 빈 값은 폴백이 맞다. 미설정은 "기본으로 돌려라" 는 정당한 뜻이고, 오타와는 다르다.
  if (raw.trim() !== "") {
    throw new Error(
      `DATASET="${raw}" 는 모르는 프로파일이다. ` +
        `가능한 값: ${PROFILE_NAMES.join(" | ")} (미설정이면 smoke 로 돈다). ` +
        "오타 하나로 다른 데이터셋의 답을 받지 않도록 거절한다.",
    );
  }

  // Back-compat: the KG evals select the corpus with KG_SCHEMA alone.
  const kg = process.env.KG_SCHEMA;
  if (kg === "companyx") return PROFILES.companyx;
  if (kg === "bench") return PROFILES.bench;
  if (kg !== undefined && kg.trim() !== "") {
    throw new Error(
      `KG_SCHEMA="${kg}" 는 모르는 스키마다. 가능한 값: companyx | bench (미설정이면 smoke).`,
    );
  }
  return PROFILES.smoke;
}
