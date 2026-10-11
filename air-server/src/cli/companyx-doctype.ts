// Copyright 2026 Yeongjun Yoo
// SPDX-License-Identifier: Apache-2.0
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// 이미 적재된 companyx DB 에 문서 유형을 단다(멱등). 새로 적재하면(companyx:load) 로더가 같은 일을 하므로 필요 없다.
//
//   곁테이블 companyx.document_types(doc_id, doc_type, basis)를 만들고(없으면), 조각을 문서별로 이어 붙인 원문으로
//   doctype.ts tagDocument 를 돌려 덮어쓰고, companyx.documents 뷰에 doc_type 열을 붙인다. 공식 document_chunks 는 바꾸지 않는다.
//
// 데이터셋이 있으면 원문 파일로 단 꼬리표와 사업자 index.json 유형도 대조해 함께 적는다(DB 조각으로 단 것과 같아야 한다).
// 결과: eval/results/companyx-doctype-tags.json
//
// 실행: npm run companyx:doctype   (DATABASE_URL 이 가리키는 DB 에 쓴다)
import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getPool } from "../db.js";
import { shutdown } from "../exit.js";
import { CX_SCHEMA, datasetDir, ensureDocumentTypes, loadDocTypes, requireCompanyxProfile } from "../companyx.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");

async function main() {
  requireCompanyxProfile();
  const pool = getPool();
  const db = await ensureDocumentTypes(pool, CX_SCHEMA);
  const stored = await pool.query<{ doc_id: string; doc_type: string | null; basis: string }>(
    `SELECT doc_id, doc_type, basis FROM ${CX_SCHEMA}.document_types ORDER BY doc_id`,
  );
  const view = await pool.query<{ doc_type: string | null; n: string }>(
    `SELECT doc_type, count(*)::text AS n FROM ${CX_SCHEMA}.documents GROUP BY doc_type ORDER BY doc_type`,
  );

  // 데이터셋이 있으면 원문 파일로 단 꼬리표, 사업자 index.json 유형과 대조한다.
  const dir = datasetDir();
  let crossCheck: Record<string, unknown> = { skipped: "데이터셋 없음(datasets/MANIFEST.md)" };
  if (existsSync(join(dir, "documents", "index.json"))) {
    const fromFiles = new Map((await loadDocTypes(dir)).map((d) => [d.docId, d.tag.type]));
    const index = JSON.parse(await readFile(join(dir, "documents", "index.json"), "utf8")) as { id: string; type: string }[];
    const sponsor = new Map(index.map((e) => [e.id, e.type]));
    crossCheck = {
      docs_in_dataset: index.length,
      db_vs_files_mismatch: stored.rows.filter((r) => fromFiles.get(r.doc_id) !== r.doc_type).map((r) => r.doc_id),
      db_vs_index_json_mismatch: stored.rows.filter((r) => sponsor.get(r.doc_id) !== r.doc_type).map((r) => r.doc_id),
      missing_in_db: index.map((e) => e.id).filter((id) => !stored.rows.some((r) => r.doc_id === id)),
    };
  }

  const out = {
    what: "companyx.document_types — 원문의 첫 제목과 섹션 구성으로 정한 문서 유형(doctype.ts tagDocument). 사업자 index.json 은 대조에만 썼다.",
    docs: db.docs,
    counts: db.counts,
    unclassified: db.unclassified,
    basis: Object.fromEntries([...new Set(stored.rows.map((r) => r.basis))].map((b) => [b, stored.rows.filter((r) => r.basis === b).length])),
    chunks_by_type: Object.fromEntries(view.rows.map((r) => [r.doc_type ?? "(null)", Number(r.n)])),
    cross_check: crossCheck,
    tags: stored.rows,
    generated_at: new Date().toISOString(),
  };
  const outPath = resolve(root, "eval/results/companyx-doctype-tags.json");
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(out, null, 2) + "\n");
  console.log(`companyx:doctype 문서 ${db.docs}건 ${JSON.stringify(db.counts)}, 못 단 문서 ${db.unclassified.length}건 → ${outPath}`);
  console.log(`  조각(뷰) 유형별: ${JSON.stringify(out.chunks_by_type)}`);
  console.log(`  대조: ${JSON.stringify(crossCheck)}`);
  return shutdown(db.unclassified.length ? 2 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await shutdown(1);
});
