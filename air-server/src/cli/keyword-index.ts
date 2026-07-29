// 키워드 색인 생성과 스모크 확인.
//
// 색인은 정규화 계약(normalize.ts)의 결과를 tsvector로 넣는 것이라, 계약이 바뀌면
// 반드시 다시 돌려야 한다. 그래서 별도 CLI로 둔다.
//
// 사용: DATASET=companyx node dist/cli/keyword-index.js
import { closePool, getPool } from "../db.js";
import { buildKeywordIndex, keywordIndexReady, keywordSearch } from "../keyword.js";
import { profile } from "../profile.js";

const SMOKE = [
  "Product-C1 설치 요구사항",
  "클라이언트가 겪은 장애",
  "미해결 티켓",
  "고객 사 목록",
  "제주 에너지 기업 제안",
];

async function main() {
  const pool = getPool();
  const ds = profile();
  const table = ds.name === "companyx" ? "companyx.document_chunks" : ds.vectorTable;

  console.log(`프로파일 ${ds.name} / 대상 ${table}`);
  console.log("색인 존재:", await keywordIndexReady(pool, table));

  const built = await buildKeywordIndex(pool, table);
  console.log(`색인 완료: ${built.indexed}/${built.rows} 행`);

  for (const q of SMOKE) {
    const r = await keywordSearch(pool, q, 5, table);
    console.log(`\nQ: ${q}`);
    console.log(`  토큰: ${r.normalized.tokens.slice(0, 10).join(", ")}`);
    if (r.normalized.applied.synonyms.length) {
      console.log(`  동의어: ${r.normalized.applied.synonyms.join(", ")}`);
    }
    console.log(
      `  결과: ${r.hits.map((h) => `${h.id}(${h.score.toFixed(3)})`).join(" ") || "없음"}${r.error ? ` [오류 ${r.error}]` : ""}`,
    );
  }

  await closePool();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
