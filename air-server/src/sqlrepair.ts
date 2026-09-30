// 생성된 SQL 을 실행하고, 실행 결과가 나쁘면 데이터베이스의 반응을 되먹여 한 번 고친다.
//
// 파이프라인(retrieve)과 NL2SQL 평가(companyx:sql)가 이 함수 하나를 부른다. 평가가 수리
// 로직을 따로 베껴 두면 평가가 재는 경로와 사용자가 타는 경로가 갈린다.
//
// 고치는 조건은 둘이다.
//   error — 엔진이 거부했다(없는 컬럼, 잘못된 함수). 2026-08 부터 기본.
//   empty — 실행은 됐는데 0행이다. 기본은 꺼져 있고 SQL_EMPTY_REPAIR=1 로 켠다.
//           「2026년 10월 종료」를 날짜 하나와 같다고 비교한 식의 필터 오류가 0행으로
//           드러난다(홀드아웃3 h3-11). 온프렘 텍스트-SQL 비교 연구(arXiv 2606.29733)는
//           실행 결과를 되먹이는 자기수정이 계열과 크기에 상관없이 유의하게 도왔다고 보고했다.
//           0행이 정답인 질문도 있으므로, 고친 쿼리가 행을 돌려줄 때만 바꾼다.
import type { Pool } from "./db.js";
import { sqlQuery, columnsForSql, type SqlResult } from "./sql.js";
import { repairSql } from "./nl2sql.js";

export interface RepairOpts {
  /** 엔진 오류일 때 고친다. false 면 한 번만 실행한다. */
  repair?: boolean;
  /** 0행일 때도 고친다. 미지정이면 SQL_EMPTY_REPAIR 환경변수를 따른다. */
  emptyRepair?: boolean;
  /** 컬럼 목록을 읽을 스키마. */
  schema?: string;
}

export interface Executed {
  text: string;
  result: SqlResult;
  repaired: boolean;
  repairReason?: "error" | "empty";
}

const EMPTY_FEEDBACK =
  "쿼리는 실행됐지만 결과가 0행이다. 질문이 가리키는 행이 실제로 있다면 필터가 틀렸을 가능성이 크다 — " +
  "날짜와 기간은 범위로(해당 월의 첫날 이상, 다음 달 첫날 미만), 상태와 우선순위 같은 값은 스키마 카드의 " +
  "값 표기(소문자 등) 그대로, 이름은 정확한 값으로 비교했는지 확인하고 고친다.";

export async function executeWithRepair(pool: Pool, query: string, text: string, opts: RepairOpts = {}): Promise<Executed> {
  const first = await sqlQuery(pool, text);
  const emptyRepair = opts.emptyRepair ?? process.env.SQL_EMPTY_REPAIR === "1";
  const failed = !first.ok;
  const empty = first.ok && first.rows.length === 0;
  if (opts.repair === false || (!failed && !(empty && emptyRepair))) return { text, result: first, repaired: false };

  const cols = await columnsForSql(pool, text, opts.schema ?? "companyx").catch(() => "");
  const fixed = failed
    ? await repairSql(query, text, first.error ?? "unknown error", cols, "error")
    : await repairSql(query, text, EMPTY_FEEDBACK, cols, "empty");
  if (!fixed) return { text, result: first, repaired: false };
  const second = await sqlQuery(pool, fixed);
  // 오류 수리는 실행만 되면 받는다. 0행 수리는 행을 돌려줄 때만 받는다 — 0행이 정답인
  // 질문에서 멀쩡한 쿼리를 행이 나오는 틀린 쿼리로 바꾸지 않게 하려는 것이다.
  const accept = failed ? second.ok : second.ok && second.rows.length > 0;
  return accept
    ? { text: fixed, result: second, repaired: true, repairReason: failed ? "error" : "empty" }
    : { text, result: first, repaired: false };
}
