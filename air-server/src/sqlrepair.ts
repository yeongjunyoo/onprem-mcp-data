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
//   검사 — 외래키가 아닌 열로 조인하거나 질문에 없는 번호로 id 를 거는 SQL, 금액 열을 질문의 금액과 다른 단위로
//          비교하는 SQL 은 실행하지 않고, 사유를 되먹여 한 번 고친다. 고친 것도 거부되면 실행할 SQL 이 없다(gate.outcome = refused).
//          되먹일 때 그 SQL 의 계획만 세워 보고(EXPLAIN, 실행 없음) 없는 열 같은 오류가 있으면 사유에 붙인다.
//   재작성 — 바깥 `ORDER BY … LIMIT 1` 은 `FETCH FIRST 1 ROWS WITH TIES` 로 실행한다(공동 1위를 다 보임).
//          순위 질문(「두 번째로」)의 `ORDER BY … LIMIT 1 OFFSET k` 는 그 순위의 행을 모두 돌려주는 SQL(rankRewrite)로
//          먼저 실행하고, 그 SQL 이 검사를 지나지 못하거나 실행되지 않거나 0행이면 종전처럼 처음 SQL 을 실행한다.
//          묶음마다 1위를 전체 1위로 고른 SQL 과 부모 키를 겹쳐 센 COUNT 는 7B 수리 전에 결정론으로 바꿔 본다(groupTopRewrite,
//          countDistinctRewrite. 바꾼 SQL 도 검사를 지나고 실행돼야 받는다).
//          돌려주는 text 는 실제로 실행한 문장이다.
import type { Pool } from "./db.js";
import { sqlQuery, columnsForSql, isReadOnly, type SqlResult } from "./sql.js";
import { repairSql } from "./nl2sql.js";
import {
  countDistinctRewrite,
  enumColumns,
  groupTopRewrite,
  rankRewrite,
  repairTurnsValue,
  shapeHints,
  untrustedReasons,
  withTies,
  type SqlGate,
} from "./sqltrust.js";

export interface RepairOpts {
  /** 엔진 오류일 때 고친다. false 면 한 번만 실행한다. */
  repair?: boolean;
  /** 0행일 때도 고친다. 미지정이면 켜져 있고, SQL_EMPTY_REPAIR=0 이면 끈다. */
  emptyRepair?: boolean;
  /** 컬럼 목록을 읽을 스키마. */
  schema?: string;
  /** 수리 SQL 을 만드는 함수. 미지정이면 생성 모델(nl2sql.ts repairSql). 단위 테스트가 모델 대신 넣는다. */
  repairer?: typeof repairSql;
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
  /** 순위 질문을 그 순위의 행을 모두 돌려주는 SQL(rankRewrite)로 실행했으면 그 순위. */
  rank?: number;
}

const EMPTY_FEEDBACK =
  "쿼리는 실행됐지만 결과가 0행이다. 질문이 가리키는 행이 실제로 있다면 필터가 틀렸을 가능성이 크다 — " +
  "날짜와 기간은 범위로(해당 월의 첫날 이상, 다음 달 첫날 미만), 상태와 우선순위 같은 값은 스키마 카드의 " +
  "값 표기(소문자 등) 그대로, 이름은 정확한 값으로 비교했는지 확인하고 고친다.";

/** 검사가 거부한 SQL 을 실행하지 않고 계획만 세워 본다(EXPLAIN). 없는 열, 없는 표처럼 데이터베이스가 읽다가 내는 오류(SQLSTATE 42 계열)가
 * 있으면 그 오류 문장을, 없으면 "". 그 오류는 같은 1회 수리의 안내에 붙인다. 「계약 금액이 가장 큰 계약과 가장 작은 계약은?」의 처음 SQL 은
 * contracts 에 없는 name 을 골랐는데, 두 끝 사유만 받은 수리가 name 을 그대로 써 42703 으로 끝났다(4차 수정본 실측 I8b). */
async function engineError(pool: Pool, sql: string): Promise<string> {
  const plan = await sqlQuery(pool, sql, { explain: true });
  return !plan.ok && /\(42[0-9A-Z]{3}\)\s*$/.test(plan.error ?? "") ? (plan.error ?? "") : "";
}

export async function executeWithRepair(pool: Pool, query: string, generated: string, opts: RepairOpts = {}): Promise<Executed> {
  const schema = opts.schema ?? "companyx";
  const repair = opts.repairer ?? repairSql;
  /** 수리 안내 끝에 질문 모양의 SQL 안내(shapeHints)를 붙인다. 사유에 같은 안내가 이미 있으면 다시 붙이지 않는다. */
  const withShape = (feedback: string) =>
    [feedback, ...shapeHints(query).filter((h) => !feedback.includes(h.slice(h.indexOf(". ") + 2)))].join(" ");
  const rejected: SqlGate["rejected"] = [];
  const trusted = async (sql: string) => {
    const reasons = await untrustedReasons(pool, schema, sql, query);
    if (reasons.length) rejected.push({ sql, reasons });
    return reasons.length === 0;
  };
  /** 검사를 지난 SQL 을 실행한다. 순위 질문이면 그 순위의 행을 모두 돌려주는 SQL 을 먼저 실행하고, 그 SQL 이 읽기 전용 가드와
   * 실행 전 검사를 지나지 못하거나 실행되지 않거나 0행이면 종전 문장(withTies)을 실행한다(종전보다 더 거절하지 않는다). */
  const run = async (sql: string): Promise<{ text: string; result: SqlResult; rank?: number }> => {
    const ranked = rankRewrite(sql, query);
    if (ranked && isReadOnly(ranked.text) && (await untrustedReasons(pool, schema, ranked.text, query)).length === 0) {
      const result = await sqlQuery(pool, ranked.text);
      if (result.ok && result.rows.length > 0) return { text: ranked.text, result, rank: ranked.rank };
    }
    const text = withTies(sql);
    return { text, result: await sqlQuery(pool, text) };
  };

  /** 묶음마다 1위를 묻는데 전체 1위 한 행만 고른 SQL 을 생성 모델 없이 묶음마다 1위를 고르는 SQL 로 바꿔(groupTopRewrite) 실행한다. 바꾼 SQL 이
   * 읽기 전용 가드와 실행 전 검사를 지나고 행을 돌려줄 때만 받는다. 사유만 되먹였을 때 7B 수리는 「지역별로 매출이 가장 높은 고객사는?」에서 두 번 다
   * LIMIT 1 을 남겼다(랜덤 테스트 사전 점검 5차 P13, FV11 3/3 거절). */
  const regroup = async (sql: string): Promise<Executed | null> => {
    const text = groupTopRewrite(sql, query);
    if (!text || !isReadOnly(text) || (await untrustedReasons(pool, schema, text, query)).length) return null;
    const result = await sqlQuery(pool, text);
    return result.ok && result.rows.length > 0 ? { text, result, repaired: false, gate: { outcome: "repaired", rejected, rewritten: "group-top" } } : null;
  };
  /** 사유가 모두 부모 키의 COUNT 팬아웃이면 COUNT(DISTINCT …) 로 바꿔(countDistinctRewrite) 실행한다. 받는 조건은 regroup 과 같다. */
  const recount = async (sql: string, reasons: string[]): Promise<Executed | null> => {
    const text = countDistinctRewrite(sql, reasons);
    if (!text || !isReadOnly(text) || (await untrustedReasons(pool, schema, text, query)).length) return null;
    const ran = await run(text);
    return ran.result.ok
      ? { text: ran.text, result: ran.result, repaired: false, gate: { outcome: "repaired", rejected, rewritten: "count-distinct" }, ...(ran.rank ? { rank: ran.rank } : {}) }
      : null;
  };

  // 처음 SQL 부터 믿을 수 없으면 실행하지 않고 사유를 되먹여 한 번 고친다. 값 어휘 사유로 고친 SQL 이 그 열의 값을 질문이 말하지 않은
  // 값으로 바꿨으면(「단종된 제품」의 'cancelled' → 'active') 뜻이 뒤집힌 것이라 받지 않고 처음 사유(그 열의 값 목록)로 답한다.
  if (!(await trusted(generated))) {
    const rewritten = (await regroup(generated)) ?? (await recount(generated, rejected[0].reasons));
    if (rewritten) return rewritten;
    const cols = opts.repair === false ? "" : await columnsForSql(pool, generated, schema).catch(() => "");
    const engine = opts.repair === false ? "" : await engineError(pool, generated);
    // 오류를 사유 앞에 둔다. 사유 뒤에 「이 SQL 은 실행하면 오류도 난다」로 붙였을 때 7B 는 3/3 name 을 그대로 썼고, 앞에 두고 바꾸라고
    // 하자 3/3 실제 열로 바꿨다(I8b 수리 실측 2026-10-08).
    const why = withShape((engine ? `이 SQL 은 실행하면 오류가 난다: ${engine}. 오류가 지목한 열은 그 표에 없으니 빼거나 실제 컬럼 목록의 열로 바꾼다. 그리고 ` : "") + rejected[0].reasons.join(" "));
    const fixed = opts.repair === false ? null : await repair(query, generated, why, cols, "untrusted");
    if (!fixed || !(await trusted(fixed))) return (fixed ? await regroup(fixed) : null) ?? { text: null, repaired: false, gate: { outcome: "refused", rejected } };
    const turned = repairTurnsValue(rejected[0].reasons, fixed, query, enumColumns(schema), schema);
    if (turned.length) {
      rejected.push({ sql: fixed, reasons: turned });
      return { text: null, repaired: false, gate: { outcome: "refused", rejected } };
    }
    const ran = await run(fixed);
    return {
      text: ran.text,
      result: ran.result,
      repaired: true,
      repairReason: "untrusted",
      gate: { outcome: "repaired", rejected },
      ...(ran.rank ? { rank: ran.rank } : {}),
    };
  }

  const ran = await run(generated);
  const text = ran.text;
  const first = ran.result;
  const emptyRepair = opts.emptyRepair ?? process.env.SQL_EMPTY_REPAIR !== "0";
  const failed = !first.ok;
  const empty = first.ok && first.rows.length === 0;
  if (opts.repair === false || (!failed && !(empty && emptyRepair))) {
    return { text, result: first, repaired: false, ...(ran.rank ? { rank: ran.rank } : {}) };
  }

  const cols = await columnsForSql(pool, text, schema).catch(() => "");
  const fixed = failed
    ? await repair(query, text, withShape(first.error ?? "unknown error"), cols, "error")
    : await repair(query, text, withShape(EMPTY_FEEDBACK), cols, "empty");
  if (!fixed) return { text, result: first, repaired: false };
  // 수리한 SQL 도 같은 검사를 거친다. 오류를 고치려다 없는 관계로 조인한 것이면(「매출 알려줘」) 믿을 만한
  // SQL 이 없는 것이고, 0행을 고치려다 그랬으면 처음 SQL 의 0행이 답이다.
  if (!(await trusted(fixed))) {
    return { text, result: first, repaired: false, gate: { outcome: failed ? "refused" : "kept", rejected } };
  }
  const again = await run(fixed);
  const second = again.result;
  // 오류 수리는 실행만 되면 받는다. 0행 수리는 행을 돌려줄 때만 받는다 — 0행이 정답인
  // 질문에서 멀쩡한 쿼리를 행이 나오는 틀린 쿼리로 바꾸지 않게 하려는 것이다.
  const accept = failed ? second.ok : second.ok && second.rows.length > 0;
  return accept
    ? { text: again.text, result: second, repaired: true, repairReason: failed ? "error" : "empty", ...(again.rank ? { rank: again.rank } : {}) }
    : { text, result: first, repaired: false };
}
