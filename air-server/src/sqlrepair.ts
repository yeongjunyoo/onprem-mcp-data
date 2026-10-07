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

// 생성된 SQL 을 실행하고, 실행 결과가 나쁘면 데이터베이스의 반응을 되먹여 한 번 고친다.
//
// 파이프라인(retrieve)과 NL2SQL 평가(companyx:sql)가 이 함수 하나를 부른다. 평가가 수리
// 로직을 따로 베껴 두면 평가가 재는 경로와 사용자가 타는 경로가 갈린다.
//
// 고치는 조건은 둘이다.
//   error — 엔진이 거부했다(없는 컬럼, 잘못된 함수). 2026-08 부터 기본.
//   empty — 실행은 됐는데 0행이다. 기본으로 켜져 있고 SQL_EMPTY_REPAIR=0 으로 끈다(ablation).
//           「2026년 10월 종료」를 날짜 하나와 같다고 비교한 식의 필터 오류가 0행으로
//           드러난다(홀드아웃3 h3-11). 온프렘 텍스트-SQL 비교 연구(arXiv 2606.29733)는
//           실행 결과를 되먹이는 자기수정이 계열과 크기에 상관없이 유의하게 도왔다고 보고했다.
//           0행이 정답인 질문도 있으므로, 고친 쿼리가 행을 돌려줄 때만 바꾼다.
//           기본값으로 켠 근거(2026-09-30, 개발용 사업자 10 + 홀드아웃3 정형 20): 7/10, 11/20 에서
//           7/10, 12/20. 바뀐 문항은 h3-11 하나이고 나빠진 문항은 없다.
//
// 실행 전에는 sqltrust.ts 의 검사와 재작성을 거친다(생성 SQL 과 수리 SQL 모두).
//   검사 — 외래키가 아닌 열로 조인하거나 질문에 없는 번호로 id 를 거는 SQL 은 실행하지 않고, 사유를
//          되먹여 한 번 고친다. 고친 것도 거부되면 실행할 SQL 이 없다(gate.outcome = refused).
//   재작성 — 바깥 `ORDER BY … LIMIT 1` 은 `FETCH FIRST 1 ROWS WITH TIES` 로 실행한다(공동 1위를 다 보임).
//          돌려주는 text 는 실제로 실행한 문장이다.
import type { Pool } from "./db.js";
import { sqlQuery, columnsForSql, type SqlResult } from "./sql.js";
import { repairSql } from "./nl2sql.js";
import { checkSql, confirmNamedIds, declaredForeignKeys, withTies, type SqlGate } from "./sqltrust.js";

export interface RepairOpts {
  /** 엔진 오류일 때 고친다. false 면 한 번만 실행한다. */
  repair?: boolean;
  /** 0행일 때도 고친다. 미지정이면 켜져 있고, SQL_EMPTY_REPAIR=0 이면 끈다. */
  emptyRepair?: boolean;
  /** 컬럼 목록을 읽을 스키마. */
  schema?: string;
}

export interface Executed {
  /** 실제로 실행한 SQL. 검사가 모두 거부해 실행한 것이 없으면 null. */
  text: string | null;
  /** 실행 결과. 실행한 것이 없으면 없다. */
  result?: SqlResult;
  repaired: boolean;
  repairReason?: "error" | "empty" | "untrusted";
  /** 실행 전 검사가 무엇을 거부했는지. 거부한 것이 없으면 없다. */
  gate?: SqlGate;
}

const EMPTY_FEEDBACK =
  "쿼리는 실행됐지만 결과가 0행이다. 질문이 가리키는 행이 실제로 있다면 필터가 틀렸을 가능성이 크다 — " +
  "날짜와 기간은 범위로(해당 월의 첫날 이상, 다음 달 첫날 미만), 상태와 우선순위 같은 값은 스키마 카드의 " +
  "값 표기(소문자 등) 그대로, 이름은 정확한 값으로 비교했는지 확인하고 고친다.";

export async function executeWithRepair(pool: Pool, query: string, generated: string, opts: RepairOpts = {}): Promise<Executed> {
  const schema = opts.schema ?? "companyx";
  const fks = await declaredForeignKeys(pool, schema);
  const rejected: SqlGate["rejected"] = [];
  const trusted = async (sql: string) => {
    const v = checkSql(sql, query, fks);
    const reasons = v.ok ? [] : await confirmNamedIds(pool, schema, v, query);
    if (reasons.length) rejected.push({ sql, reasons });
    return reasons.length === 0;
  };

  // 처음 SQL 부터 믿을 수 없으면 실행하지 않고 사유를 되먹여 한 번 고친다.
  if (!(await trusted(generated))) {
    const cols = opts.repair === false ? "" : await columnsForSql(pool, generated, schema).catch(() => "");
    const fixed =
      opts.repair === false ? null : await repairSql(query, generated, rejected[0].reasons.join(" "), cols, "untrusted");
    if (!fixed || !(await trusted(fixed))) return { text: null, repaired: false, gate: { outcome: "refused", rejected } };
    const text = withTies(fixed);
    return { text, result: await sqlQuery(pool, text), repaired: true, repairReason: "untrusted", gate: { outcome: "repaired", rejected } };
  }

  const text = withTies(generated);
  const first = await sqlQuery(pool, text);
  const emptyRepair = opts.emptyRepair ?? process.env.SQL_EMPTY_REPAIR !== "0";
  const failed = !first.ok;
  const empty = first.ok && first.rows.length === 0;
  if (opts.repair === false || (!failed && !(empty && emptyRepair))) return { text, result: first, repaired: false };

  const cols = await columnsForSql(pool, text, schema).catch(() => "");
  const fixed = failed
    ? await repairSql(query, text, first.error ?? "unknown error", cols, "error")
    : await repairSql(query, text, EMPTY_FEEDBACK, cols, "empty");
  if (!fixed) return { text, result: first, repaired: false };
  // 수리한 SQL 도 같은 검사를 거친다. 오류를 고치려다 없는 관계로 조인한 것이면(「매출 알려줘」) 믿을 만한
  // SQL 이 없는 것이고, 0행을 고치려다 그랬으면 처음 SQL 의 0행이 답이다.
  if (!(await trusted(fixed))) {
    return { text, result: first, repaired: false, gate: { outcome: failed ? "refused" : "kept", rejected } };
  }
  const fixedText = withTies(fixed);
  const second = await sqlQuery(pool, fixedText);
  // 오류 수리는 실행만 되면 받는다. 0행 수리는 행을 돌려줄 때만 받는다 — 0행이 정답인
  // 질문에서 멀쩡한 쿼리를 행이 나오는 틀린 쿼리로 바꾸지 않게 하려는 것이다.
  const accept = failed ? second.ok : second.ok && second.rows.length > 0;
  return accept
    ? { text: fixedText, result: second, repaired: true, repairReason: failed ? "error" : "empty" }
    : { text, result: first, repaired: false };
}
