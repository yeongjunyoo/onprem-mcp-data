// 미해소 개체의 사유 — DB 없이 검증한다.
//
// 사업자 예시 24번 "서울물산 담당 엔지니어는 누구야?" 의 서울물산은 데이터셋에 없다.
// 게이트가 컨텍스트를 비우는 것은 그대로 두고, 왜 못 찾았는지를 구조화 필드로 낸다:
// not_in_database(비슷한 이름도 없음) / similar_name_mismatch(비슷한 이름의 다른 개체만 있음).
//
// ontologySearch 와 ask 는 가짜 pool 로 진짜 분기를 탄다(degraded.test 와 같은 방식).
import type { Pool } from "pg";

import type { Embedder } from "./embedder.js";
import { entityLikeName, ontologySearch } from "./graph.js";
import {
  NOT_FOUND_SIMILARITY,
  classifyNotFound,
  describeNotFound,
  nameSimilarity,
  similarNames,
} from "./notfound.js";
import { ask, graphLane, withoutMissing } from "./pipeline.js";

let passed = 0;
let failed = 0;
function ok(cond: unknown, label: string) {
  if (cond) passed++;
  else {
    failed++;
    console.error(`  FAIL: ${label}`);
  }
}

// 사업자 그래프와 같은 모양의 개체 사전(이름 형태만 빌린 합성본).
const ENTITIES = [
  { id: 1, name: "Client-A", type: "client" },
  { id: 2, name: "Client-B", type: "client" },
  { id: 3, name: "Product-C1", type: "product" },
  { id: 4, name: "클라우드사업부", type: "department" },
  { id: 5, name: "경영지원팀", type: "department" },
  { id: 6, name: "윤소연", type: "employee" },
  { id: 7, name: "Client-J 모니터링 시스템 도입", type: "project" },
];
const LEXICON = ENTITIES.map(({ name, type }) => ({ name, type }));
// 5) 의 섞인 질문용 엣지. Client-A 는 Product-C1 을 쓰고, 윤소연이 Client-A 를 담당한다.
const RELATIONS = [
  { id: 1, src: 1, rel: "USES", dst: 3 },
  { id: 2, src: 6, rel: "MANAGES_ACCOUNT", dst: 1 },
];

// ── 1) 유사도: 결정론, 대칭, 표기 차이 흡수 ─────────────────────────────
{
  ok(nameSimilarity("클라우드사업부", "클라우드사업부") === 1, "같은 이름은 1");
  ok(nameSimilarity("ClientA", "Client-A") === 1, "하이픈·대소문자 차이는 같은 이름으로 본다");
  ok(
    nameSimilarity("윤소현", "윤소연") === nameSimilarity("윤소연", "윤소현"),
    "유사도는 대칭이다",
  );
  // 임계값의 양쪽 — 세 글자에서 한 글자 차이는 걸리고, 두 글자 차이는 빠진다.
  ok(nameSimilarity("윤소현", "윤소연") >= NOT_FOUND_SIMILARITY, "세 글자 중 한 글자 차이는 비슷하다");
  ok(nameSimilarity("윤지현", "윤소연") < NOT_FOUND_SIMILARITY, "세 글자 중 두 글자 차이는 비슷하지 않다");
  ok(nameSimilarity("서울", "서산") < NOT_FOUND_SIMILARITY, "두 글자 이름의 한 글자 차이는 넣지 않는다");
  ok(similarNames("", LEXICON).length === 0, "빈 질의어는 후보가 없다");
}

// ── 2) 사유 분류 ────────────────────────────────────────────────────────
{
  // not_in_database — 사업자 예시 24번. 시드 토큰은 seedTerms 가 낸 그대로다.
  const absent = classifyNotFound(["서울물산", "누구야"], LEXICON);
  ok(absent.reason === "not_in_database", `서울물산은 not_in_database (got ${absent.reason})`);
  ok(absent.query_entity === "서울물산", `query_entity 는 첫 질의어 (got ${absent.query_entity})`);
  ok(absent.candidates.length === 0, "없는 개체에 후보를 지어내지 않는다");

  // similar_name_mismatch — 부서명 오기
  const near = classifyNotFound(["클라우드사업팀", "직원들", "누구야"], LEXICON);
  ok(near.reason === "similar_name_mismatch", `클라우드사업팀은 similar_name_mismatch (got ${near.reason})`);
  ok(near.query_entity === "클라우드사업팀", "query_entity 는 비슷한 이름을 가진 질의어");
  ok(
    near.candidates[0]?.name === "클라우드사업부" && near.candidates[0]?.type === "department",
    `후보는 클라우드사업부(department) (got ${JSON.stringify(near.candidates)})`,
  );
  ok(near.candidates[0]?.score === 0.857, `점수는 1 - 1/7 을 셋째 자리까지 (got ${near.candidates[0]?.score})`);

  // 질의어 순서보다 후보 점수가 query_entity 를 정한다.
  const late = classifyNotFound(["누구야", "윤소현"], LEXICON);
  ok(late.query_entity === "윤소현", `뒤에 나온 질의어라도 비슷한 이름이 있으면 그쪽 (got ${late.query_entity})`);

  // 결정론: 같은 입력, 같은 출력.
  const once = JSON.stringify(classifyNotFound(["Product-X9"], LEXICON));
  let stable = true;
  for (let i = 0; i < 20; i++) if (JSON.stringify(classifyNotFound(["Product-X9"], LEXICON)) !== once) stable = false;
  ok(stable, "분류는 20회 같은 결과");

  // 한국어 문장이 사유를 말한다.
  const a = describeNotFound(absent);
  ok(a.includes("서울물산") && a.includes("찾지 못했습니다") && a.includes("비슷한 개체도 없습니다"), "없음 사유 문장");
  const n = describeNotFound(near);
  ok(n.includes("클라우드사업부(department)") && n.includes("답하지 않았습니다"), "비슷한 이름 사유 문장");
}

// ── 3) ontologySearch 가 필드를 싣는가 (가짜 pool) ────────────────────────
// 해소 쿼리는 정본명 부분 일치만 흉내 낸다. 사전 쿼리는 정본명 전체를 준다.
const fakePool = {
  query: async (sql: string, params?: unknown[]) => {
    if (sql.includes("information_schema.columns")) return { rowCount: 1, rows: [{}] };
    if (sql.includes("canonical_name AS name")) return { rowCount: LEXICON.length, rows: LEXICON };
    if (sql.includes("WITH t AS")) {
      const terms = (params?.[0] ?? []) as string[];
      const rows = ENTITIES.flatMap((e) => {
        const t = terms.find((x) => e.name.toLowerCase().includes(x.toLowerCase()));
        if (!t) return [];
        const score = e.name.toLowerCase() === t.toLowerCase() ? 4 : 1;
        return [{ id: e.id, type: e.type, canonical_name: e.name, properties: null, via: "canonical", matched: t, score }];
      });
      return { rowCount: rows.length, rows };
    }
    throw new Error(`fake pool: 예상하지 못한 쿼리 ${sql.slice(0, 60)}`);
  },
} as unknown as Pool;

{
  const found = await ontologySearch(fakePool, "클라우드사업부 소속 직원들은 누구야?", 5, "companyx");
  ok(found.ok && found.hits[0]?.canonicalName === "클라우드사업부", "찾은 경우 hits 가 있다");
  ok(found.not_found === undefined, "찾은 경우 not_found 가 없다");

  const absent = await ontologySearch(fakePool, "서울물산 담당 엔지니어는 누구야?", 5, "companyx");
  ok(absent.ok && absent.hits.length === 0, "없는 개체는 hits 0");
  ok(absent.not_found?.reason === "not_in_database", "도구 결과에 not_in_database");

  const near = await ontologySearch(fakePool, "클라우드사업팀 소속 직원들은 누구야?", 5, "companyx");
  ok(near.hits.length === 0, "비슷한 이름은 해소하지 않는다(hits 0)");
  ok(
    near.not_found?.reason === "similar_name_mismatch" && near.not_found.candidates[0]?.name === "클라우드사업부",
    "도구 결과에 similar_name_mismatch 와 후보",
  );
}

// ── 4) ask 는 LLM 을 부르지 않고 사유로 답한다 ─────────────────────────────
{
  const embedder: Embedder = { name: "test:unused", dim: 8, embed: async () => new Array(8).fill(0) };
  let llmCalled = false;
  const r = await ask("서울물산 담당 엔지니어는 누구야?", {
    pool: fakePool,
    embedder,
    llm: async () => {
      llmCalled = true;
      return "지어낸 담당자";
    },
  });
  ok(r.route === "graph", `그래프 레인으로 간다 (got ${r.route})`);
  ok(r.not_found?.reason === "not_in_database", "파이프라인 결과에 not_found");
  ok(r.audit.not_found?.reason === "not_in_database", "retrieve 도구가 돌려주는 audit 에도 not_found");
  ok(!llmCalled, "게이트가 발동하면 LLM 을 부르지 않는다");
  ok(r.answer === describeNotFound(r.not_found!), "답이 사유 문장이다");
  // 환각 차단은 그대로 — 컨텍스트에는 not-found 한 줄뿐이다.
  ok(r.graph?.edgeCount === 0 && r.curated.kept.length === 1, "게이트 컨텍스트는 엣지 0, 한 줄");
}

// ── 5) 섞인 질문: 있는 개체와 없는 개체(G17 ①) ───────────────────────────
// 「서울물산 담당 엔지니어와 Client-A가 사용 중인 제품을 알려줘」에 종전 답은 「서울물산의 담당 엔지니어는
// 류서연」이었다(류서연은 Client-A 담당, 경계 실측 3/3). 게이트가 해소 0건일 때만 섰기 때문이다.
{
  for (const [t, want] of [
    ["서울물산", "서울물산"],
    ["서울물산이랑", "서울물산"],
    ["Client-ZZ", "Client-ZZ"],
    ["Product-Z9", "Product-Z9"],
    ["마케팅팀", "마케팅팀"],
    ["모바일사업부", "모바일사업부"],
  ]) {
    ok(entityLikeName(t) === want, `${t} 는 이름처럼 생겼다 (got ${entityLikeName(t)})`);
  }
  for (const t of ["등록된", "이전", "산업", "팀", "누구야", "e-mail", "COVID-19", "매출"]) {
    ok(entityLikeName(t) === null, `${t} 는 일반 낱말이다`);
  }

  const mixed = await ontologySearch(fakePool, "서울물산 담당 엔지니어와 Client-A가 사용 중인 제품을 알려줘", 5, "companyx");
  ok(mixed.hits[0]?.canonicalName === "Client-A" && mixed.not_found === undefined, "있는 개체는 그대로 해소된다");
  ok(
    mixed.missing?.length === 1 && mixed.missing[0].query_entity === "서울물산" && mixed.missing[0].reason === "not_in_database",
    `없는 개체는 missing 에 사유와 함께 (got ${JSON.stringify(mixed.missing)})`,
  );
  const typo = await ontologySearch(fakePool, "윤소현 담당 고객사와 Client-A가 사용 중인 제품", 5, "companyx");
  ok(
    typo.missing?.[0]?.query_entity === "윤소현" && typo.missing[0].reason === "similar_name_mismatch" && typo.missing[0].candidates[0]?.name === "윤소연",
    `비슷한 이름만 있는 이름도 missing (got ${JSON.stringify(typo.missing)})`,
  );
  const generic = await ontologySearch(fakePool, "이전에 등록된 Client-A 제품 목록", 5, "companyx");
  ok(generic.hits.length > 0 && generic.missing === undefined, "「이전」, 「등록된」은 없는 개체로 올리지 않는다");
  const plain = await ontologySearch(fakePool, "클라우드사업부 소속 직원들은 누구야?", 5, "companyx");
  ok(plain.missing === undefined, "해소된 개체만 있는 질문은 그대로");

  ok(
    withoutMissing("서울물산 담당 엔지니어와 Client-A가 사용 중인 제품을 알려줘", ["서울물산"]) === "Client-A가 사용 중인 제품을 알려줘",
    "없는 개체가 든 마디를 뺀다",
  );
  ok(withoutMissing("Client-A가 사용 중인 제품과 서울물산 매출을 알려줘", ["서울물산"]) === "Client-A가 사용 중인 제품", "뒤 마디도 뺀다");
  ok(
    withoutMissing("Client-A와 서울물산의 담당자를 알려줘", ["서울물산"]) === "Client-A 담당자를 알려줘",
    "관계어가 남은 마디에 없으면 이름과 조사만 뺀다",
  );

  // ask: 7B 는 없는 개체가 빠진 질문과, 그 마디의 관계(담당)가 빠진 근거만 받는다.
  const relPool = {
    query: async (sql: string, params?: unknown[]) => {
      if (sql.includes(".relations r") && sql.includes("ANY($1::int[])")) {
        const [frontier, rels, seen] = params as [number[], string[] | null, number[]];
        const byId = new Map(ENTITIES.map((e) => [e.id, e]));
        const rows = RELATIONS.filter(
          (r) => (frontier.includes(r.src) || frontier.includes(r.dst)) && (!rels || rels.includes(r.rel)) && !seen.includes(r.id),
        ).map((r) => ({
          id: r.id,
          src_entity_id: r.src,
          src_name: byId.get(r.src)!.name,
          src_type: byId.get(r.src)!.type,
          rel_type: r.rel,
          dst_entity_id: r.dst,
          dst_name: byId.get(r.dst)!.name,
          dst_type: byId.get(r.dst)!.type,
          confidence: 1,
          provenance: "test",
        }));
        return { rowCount: rows.length, rows };
      }
      return fakePool.query(sql, params);
    },
  } as unknown as Pool;
  const seen: { q: string; ctx: string }[] = [];
  const r = await ask("서울물산 담당 엔지니어와 Client-A가 사용 중인 제품을 알려줘", {
    pool: relPool,
    embedder: { name: "test:unused", dim: 8, embed: async () => new Array(8).fill(0) },
    llm: async (q, ctx) => {
      seen.push({ q, ctx });
      return "Client-A가 사용 중인 제품은 Product-C1입니다.";
    },
  });
  const head = describeNotFound(mixed.missing![0]);
  ok(r.route === "graph" && r.not_found === undefined, `그래프 레인, 전체 게이트는 서지 않는다 (got ${r.route})`);
  ok(seen[0]?.q === "Client-A가 사용 중인 제품을 알려줘", `7B 는 없는 개체가 빠진 질문을 받는다 (got ${seen[0]?.q})`);
  ok(Boolean(seen[0] && !seen[0].ctx.includes("윤소연") && seen[0].ctx.includes("Product-C1")), `없는 개체 마디의 관계(담당)는 근거에서 빠진다 (got ${seen[0]?.ctx})`);
  ok(Boolean(seen[0] && !seen[0].ctx.includes("서울물산")), "사유 줄은 7B 근거에서 뺀다");
  ok(r.context.startsWith(`[그래프] ${head}`), "retrieve 의 컨텍스트에는 사유 줄이 맨 앞에 있다");
  ok(r.answer === `${head}\n\nClient-A가 사용 중인 제품은 Product-C1입니다.`, `답은 사유 문장으로 시작한다 (got ${r.answer})`);
  ok(!r.answer.includes("윤소연"), "찾은 개체의 담당자를 없는 개체에 붙이지 않는다");
  ok(r.audit.missing_entities?.[0]?.query_entity === "서울물산", "retrieve 의 audit 에도 missing_entities");
}

// ── 6) 질의어가 하나도 없을 때 빈 괄호를 보이지 않는다(G17 ⑩) ─────────────
{
  const none = await graphLane(fakePool, "ㅁㄴㅇㄹ", 5, 2, "companyx");
  ok(none.strategy === "unresolved" && none.items.length === 1, "질의어가 없으면 탐색하지 않는다");
  ok(!none.items[0].text.includes("()") && none.items[0].text.includes("개체 이름으로 볼 낱말"), `빈 괄호 대신 이유를 말한다 (got ${none.items[0].text})`);
}

console.log(`\nnotfound.test: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
