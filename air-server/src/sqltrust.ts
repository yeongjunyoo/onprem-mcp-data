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

// 생성 SQL 을 실행하기 전에 거는 결정론 검사와 재작성.
//
// NL2SQL 경로(파이프라인과 companyx:sql 평가가 함께 부르는 executeWithRepair)에서만 쓴다. sql.query 도구는
// 사용자가 쓴 SQL 을 쓴 그대로 실행하므로 여기를 거치지 않는다. 모델은 부르지 않는다.
//
//   withTies  — 바깥 쿼리의 `ORDER BY … LIMIT 1` 을 `FETCH FIRST 1 ROWS WITH TIES` 로 바꾼다.
//               「직원이 가장 많은 부서」는 영업팀과 클라우드사업부가 10명으로 같은데 LIMIT 1 이 하나를
//               조용히 버렸다(랜덤 테스트 사전 점검 D1). 공동 1위는 모두 보여야 한다.
//   checkSql  — ① 조인 조건의 열 쌍이 스키마에 선언된 외래키인가 ② `id = 숫자` 의 숫자가 질문에 있는가.
//               「매출 알려줘」에 7B 가 `JOIN employees e ON s.contract_id = e.id` 로 없는 관계를 이어 담당자
//               이름을 지어냈고, 「연봉 알려줘」에 `WHERE e.id = 1` 로 묻지 않은 한 사람을 골랐다(D3).
//   checkMoney — ③ 금액 열과 비교하는 숫자가 질문의 금액과 단위가 맞는가. 「연봉이 2억 원 이상」에 7B 가
//               `salary >= 2000` 을 써 직원 45명을 모두 돌려줬다(G17 ⑥).
//   rankRewrite — 질문이 「두 번째로」처럼 2위 아래 순위를 묻고 생성 SQL 이 `ORDER BY … LIMIT 1 OFFSET k` 로 끝나면 그 순위
//               (k+1)의 행을 모두 돌려주는 DENSE_RANK 질의로 바꾼다. 「계약을 두 번째로 많이 담당한 직원」은 장미라, 김준혁,
//               안소연이 4건으로 같은데 OFFSET 1 이 김준혁 한 명만 골랐다.
//   vagueMeasure — 질문이 측정 항목 한 낱말(「매출 알려줘」)뿐이면 SQL 을 만들지 않고 되묻는다. 7B 가 매출 표 전체를 골랐고
//               답 문장은 그 가운데 한 건의 값을 매출이라고 말했다(「매출은 1953입니다.」).
//   checkEnum, checkRatio, checkMonthUnit, confirmCountUnit — 값 어휘에 없는 상태 값, 정수 나눗셈 비율, 질문과 다른 집계 단위
//               (랜덤 테스트 사전 점검 3차 Q1, Q6, Q7). checkPeriod 는 반기도 본다(Q2).
//   checkUnaskedEnum, checkGroupTop, checkBothEnds, checkSyntax: 질문에 없는 값 조건, 묶음마다 1위를 전체 1위 한 행으로, 두 끝을
//               묻는데 한쪽 끝만, PostgreSQL 이 읽지 못하는 LIMIT a, b 와 자리표시 ?(4차 P13, P6, P4). checkPeriod 는 달도 본다(P1).
//               값 어휘 수리가 질문의 상태를 뒤집으면 받지 않는다(repairTurnsValue, P12).
//   checkHalfGroup — 반기를 묻는데 분기로 묶은 SQL(7B 가 분기 행을 반기로 읽음). checkUnaskedEnum 은 그 표에 없는 상태와 부정한 상태의
//               나머지 일부도 본다(4차 수정본 실측 N5, R2, N3).
//   5차: checkPeriod 는 달 범위, 「YYYY년 이후」, 「작년 같은 분기」도 본다(P2, P3). checkPeriodLength(근속 평균, 계약 기간), checkAvgElseZero,
//               checkCompareGroups, checkContradiction(P6), checkAbsentState(제품 상태에 없는 「판매 중지」, P10), checkJsonOutput(P1), COUNT 팬아웃(P12).
//               groupTopRewrite, countDistinctRewrite 는 사유만으로 7B 수리가 실패한 두 꼴을 결정론으로 고친다(P13, P12).
import type { Pool } from "./db.js";
import type { PolicyVerdict } from "./auditrecord.js";
import { formatManwon, moneyMentions } from "./money.js";
import { sqlQuery, tokenizeSql, type SqlToken } from "./sql.js";
import { DOT_MONTH_RE, RELATIVE_YEAR, RELATIVE_YEAR_RE, SAME_QUARTER_LAST_YEAR_RE, sameQuarterLastYear, seoulYear } from "./llm.js";
import { COMPANYX_SCHEMA_DDL } from "./nl2sql.js";
import { SCHEMA_NAMES } from "./profile.js";

/** 문자열 값, 따옴표 이름, 주석을 같은 길이의 공백으로 가린다. 자리가 그대로라 가린 문자열에서 찾은 위치를
 * 원문에 그대로 쓴다. 달러 따옴표, E'' 문자열, 닫히지 않은 따옴표처럼 이 스캐너가 확실히 읽지 못하면 null. */
export function maskSql(sql: string): string | null {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === "$") return null;
    if (c === "'" || c === '"') {
      if (c === "'" && /[eE]/.test(sql[i - 1] ?? "") && !/[A-Za-z0-9_]/.test(sql[i - 2] ?? "")) return null;
      let j = i + 1;
      for (;;) {
        if (j >= sql.length) return null;
        if (sql[j] === c) {
          if (sql[j + 1] === c) {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      out += c + " ".repeat(j - i - 1) + c;
      i = j + 1;
      continue;
    }
    if (c === "-" && next === "-") {
      const nl = sql.indexOf("\n", i);
      const end = nl < 0 ? sql.length : nl;
      out += " ".repeat(end - i);
      i = end;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      if (end < 0) return null;
      out += " ".repeat(end + 2 - i);
      i = end + 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** 자리마다 괄호 깊이. 괄호가 맞지 않으면 null. */
function depths(masked: string): number[] | null {
  const d: number[] = [];
  let depth = 0;
  for (const ch of masked) {
    if (ch === "(") {
      d.push(depth);
      depth++;
    } else if (ch === ")") {
      depth--;
      if (depth < 0) return null;
      d.push(depth);
    } else d.push(depth);
  }
  return depth === 0 ? d : null;
}

/** 바깥 쿼리가 `ORDER BY … LIMIT 1` 로 끝나면(OFFSET 없음) `ORDER BY … FETCH FIRST 1 ROWS WITH TIES` 로 바꾼다.
 * 공동 1위가 있으면 모두 돌려주고, 없으면 결과가 같다(PostgreSQL 13 이상). LIMIT 2 이상, 하위 쿼리 안의 LIMIT,
 * ORDER BY 가 바깥에 없는 쿼리, 확실히 읽지 못하는 문장은 그대로 둔다. */
export function withTies(sql: string): string {
  const masked = maskSql(sql);
  if (masked === null) return sql;
  const d = depths(masked);
  if (!d) return sql;
  const m = /\blimit\s+1(\s*;?\s*)$/i.exec(masked);
  if (!m || d[m.index] !== 0) return sql;
  const top = (re: RegExp) => [...masked.matchAll(re)].filter((x) => d[x.index ?? 0] === 0 && (x.index ?? 0) < m.index);
  if (!top(/\border\s+by\b/gi).length) return sql;
  if (top(/\b(offset|fetch)\b/gi).length) return sql;
  const end = m.index + m[0].length - m[1].length;
  return `${sql.slice(0, m.index)}FETCH FIRST 1 ROWS WITH TIES${sql.slice(end)}`;
}

const KO_NUMBER: Readonly<Record<string, number>> = {
  두: 2, 둘: 2, 세: 3, 셋: 3, 네: 4, 넷: 4, 다섯: 5, 여섯: 6, 일곱: 7, 여덟: 8, 아홉: 9, 열: 10,
};
const ORDINAL_RANK =
  /(?<![가-힣0-9])(?:(두|세|네|다섯|여섯|일곱|여덟|아홉|열|\d+)\s*번\s?째|(둘|셋|넷|다섯|여섯|일곱|여덟|아홉|열)째|(\d+)위)/g;

/** 질문에 든 순위 가운데 2 이상: 「두 번째」, 「3번째」, 「셋째」, 「2위」. 「첫 번째」와 「1위」는 withTies 가 맡는다. 「위」는 숫자에
 * 붙어 있을 때만 본다(「08-18 위조」의 18 은 순위가 아니다). 결정론이다. */
export function ordinalRanks(question: string): number[] {
  const out = new Set<number>();
  for (const m of question.matchAll(ORDINAL_RANK)) {
    const w = m[1] ?? m[2] ?? m[3];
    const n = /^\d+$/.test(w) ? Number(w) : KO_NUMBER[w];
    if (n >= 2) out.add(n);
  }
  return [...out];
}

const NAME_RE = /[A-Za-z_\u0080-￿][A-Za-z0-9_$\u0080-￿]*/y;

/** 낱말(tokenizeSql)이 원문에서 끝나는 자리. */
function tokenEnd(sql: string, t: SqlToken): number {
  if (t.k === "q") return t.at + 2 + t.v.replace(/"/g, '""').length;
  if (t.k === "s") return t.at + t.v.length + (sql[t.at] === "'" || sql[t.at] === "$" ? 0 : 1); // E'…' 는 at 이 e 자리다
  if (t.k === "w") {
    NAME_RE.lastIndex = t.at;
    return t.at + (NAME_RE.exec(sql)?.[0].length ?? t.v.length);
  }
  return t.at + t.v.length;
}

/** 별칭으로 쓰이지 않는 낱말. 식 끝의 이 낱말(CASE … END, IS NULL)을 별칭으로 읽지 않는다. */
const NOT_OUTPUT_NAME = new Set(
  ("end null true false and or not is in like ilike similar between then else when case from as asc desc over filter " +
    "within distinct all any some unknown collate at zone").split(" "),
);

/** 순위 질문의 생성 SQL 을 그 순위의 행을 모두 돌려주는 SQL 로 바꾼다. 바꿀 꼴이 아니면 null.
 *
 * 질문의 순위(ordinalRanks)가 k+1 이고 SQL 의 바깥 꼬리가 `ORDER BY <열> LIMIT 1 OFFSET k`(또는 OFFSET k LIMIT 1,
 * OFFSET k FETCH FIRST 1 ROWS ONLY)일 때만 바꾼다. 바꾼 SQL 은 본 SELECT 목록에 `DENSE_RANK() OVER (ORDER BY <열>)` 를
 * rank 열로 더하고 LIMIT, OFFSET 을 뺀 질의를 감싸 rank = k+1 인 행을 모두 고른다. 같은 값이 여럿이면 OFFSET k 는 그 가운데
 * 하나를 골랐다(「계약을 두 번째로 많이 담당한 직원」 4건 셋 가운데 김준혁). ORDER BY 가 출력 열 이름이나 자리 번호를 쓰면 그
 * 식으로 바꿔 넣는다(창 함수의 ORDER BY 는 출력 열 이름을 모른다). 순위는 첫 정렬 키로만 매긴다. 둘째 키부터는 같은 값을
 * 늘어놓는 순서(`ORDER BY COUNT(c.id) DESC, e.name`)라 순위에 넣으면 공동 순위가 갈라져 한 명만 남는다. 그 키들은 안쪽
 * 질의의 ORDER BY 에 그대로 남아 행 순서만 정한다. WITH 로 시작하거나 DISTINCT, 집합 연산, FOR UPDATE, 주석,
 * rank 라는 이름이 있는 문장, 읽지 못하는 문장은 바꾸지 않는다. */
export function rankRewrite(sql: string, question: string): { text: string; rank: number } | null {
  const ranks = ordinalRanks(question);
  if (!ranks.length) return null;
  const all = tokenizeSql(sql);
  if (!all?.length) return null;
  // 원문 조각을 옮겨 붙이므로 낱말 사이에 공백 말고 다른 것(주석)이 있으면 다루지 않는다.
  let prev = 0;
  for (const t of all) {
    if (sql.slice(prev, t.at).trim() || ((t.k === "w" || t.k === "q") && t.v === "rank")) return null;
    prev = tokenEnd(sql, t);
  }
  if (sql.slice(prev).trim()) return null;
  const toks = all[all.length - 1].k === ";" ? all.slice(0, -1) : all;
  const depth: number[] = [];
  let level = 0;
  for (const t of toks) {
    if (t.k === ";") return null;
    if (t.k === ")" || t.k === "]") level--;
    if (level < 0) return null;
    depth.push(level);
    if (t.k === "(" || t.k === "[") level++;
  }
  if (level !== 0) return null;
  // 바깥 절의 키워드. 점 뒤(t.order)는 이름이다.
  const kw = (i: number) => (depth[i] === 0 && toks[i]?.k === "w" && toks[i - 1]?.k !== "." ? toks[i].v : null);
  const int = (i: number) => (toks[i]?.k === "o" && /^\d+$/.test(toks[i].v) ? Number(toks[i].v) : null);
  const isName = (i: number) => toks[i]?.k === "w" || toks[i]?.k === "q";
  const text = (lo: number, hi: number) => sql.slice(toks[lo].at, tokenEnd(sql, toks[hi - 1]));
  if (kw(0) !== "select" || kw(1) === "distinct" || kw(1) === "all") return null;
  let from = -1;
  let order = -1;
  let tail = -1;
  for (let i = 1; i < toks.length; i++) {
    const w = kw(i);
    if (w === "select" || w === "union" || w === "intersect" || w === "except" || w === "window" || w === "for" || w === "into") return null;
    if (w === "from" && from < 0) from = i;
    else if (w === "order" && kw(i + 1) === "by") {
      if (order >= 0) return null;
      order = i;
    } else if ((w === "limit" || w === "offset" || w === "fetch") && tail < 0) tail = i;
  }
  if (from < 0 || order < from || tail < order + 3) return null;

  let limit: number | null = null;
  let offset: number | null = null;
  for (let i = tail; i < toks.length; ) {
    const w = kw(i);
    if (w === "limit" && limit === null && int(i + 1) !== null) {
      limit = int(i + 1);
      i += 2;
    } else if (w === "offset" && offset === null && int(i + 1) !== null) {
      offset = int(i + 1);
      i += 2;
      if (kw(i) === "row" || kw(i) === "rows") i++;
    } else if (w === "fetch" && limit === null && (kw(i + 1) === "first" || kw(i + 1) === "next")) {
      i += 2;
      limit = int(i) ?? 1;
      if (int(i) !== null) i++;
      if (!(kw(i) === "row" || kw(i) === "rows") || kw(i + 1) !== "only") return null;
      i += 2;
    } else return null;
  }
  if (limit !== 1 || offset === null || offset < 1 || !ranks.includes(offset + 1)) return null;

  const split = (lo: number, hi: number): [number, number][] => {
    const parts: [number, number][] = [];
    let start = lo;
    for (let i = lo; i < hi; i++) {
      if (depth[i] === 0 && toks[i].k === ",") {
        parts.push([start, i]);
        start = i + 1;
      }
    }
    parts.push([start, hi]);
    return parts;
  };
  // 본 SELECT 목록의 항목마다 출력 열 이름과 식. 이름: AS 뒤, 식 뒤에 붙은 이름, 별칭 없는 열(t.x 의 x).
  const items: { name: string | null; expr: string; star: boolean }[] = [];
  for (const [lo, hi] of split(1, from)) {
    if (hi <= lo) return null;
    const star = toks[hi - 1].k === "o" && toks[hi - 1].v === "*";
    const last = toks[hi - 1];
    const before = toks[hi - 2];
    if (hi - lo >= 3 && kw(hi - 2) === "as" && isName(hi - 1)) items.push({ name: last.v, expr: text(lo, hi - 2), star });
    else if (
      hi - lo >= 2 &&
      isName(hi - 1) &&
      !(last.k === "w" && NOT_OUTPUT_NAME.has(last.v)) &&
      (before.k === ")" || before.k === "]" || before.k === "s" || isName(hi - 2) || (before.k === "o" && /^\d/.test(before.v)))
    ) {
      items.push({ name: last.v, expr: text(lo, hi - 1), star });
    } else {
      const column = toks.slice(lo, hi).every((t, j) => (j % 2 === 0 ? t.k === "w" || t.k === "q" : t.k === "."));
      items.push({ name: column && (hi - lo) % 2 === 1 ? last.v : null, expr: text(lo, hi), star });
    }
  }
  // 순위는 첫 정렬 키로만 매긴다. 둘째 키부터는 안쪽 질의의 ORDER BY 에 남아 행 순서만 정한다.
  const [lo, end] = split(order + 2, tail)[0];
  if (end <= lo) return null;
  let hi = end;
  if (hi - lo >= 3 && kw(hi - 2) === "nulls" && (kw(hi - 1) === "first" || kw(hi - 1) === "last")) hi -= 2;
  if (hi - lo >= 2 && (kw(hi - 1) === "asc" || kw(hi - 1) === "desc")) hi -= 1;
  for (let i = lo; i < hi; i++) if (kw(i) === "using") return null;
  let expr = text(lo, hi);
  if (hi - lo === 1 && isName(lo)) {
    const hit = items.filter((it) => it.name === toks[lo].v);
    if (hit.length > 1 || hit[0]?.star) return null;
    if (hit.length) expr = hit[0].expr;
  } else if (hi - lo === 1 && int(lo) !== null) {
    const it = items[int(lo)! - 1];
    if (!it || it.star) return null;
    expr = it.expr;
  }
  const key = hi < end ? `${expr} ${text(hi, end)}` : expr;
  const rank = offset + 1;
  const inner =
    `${sql.slice(0, toks[from].at).trimEnd()}, CAST(DENSE_RANK() OVER (ORDER BY ${key}) AS integer) AS rank ` +
    sql.slice(toks[from].at, toks[tail].at).trimEnd();
  return { text: `SELECT * FROM (${inner}) AS ranked WHERE rank = ${rank}`, rank };
}

const QUALIFIED_NAME = /(?<![A-Za-z0-9_.])([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)(?![A-Za-z0-9_])/g;
const KNOWN_SCHEMAS = new Set(SCHEMA_NAMES.map((s) => s.toLowerCase()));

/** 질문이 표를 스키마까지 적어 지목하면(「bench.admin_secrets 테이블」) 생성 SQL 도 그 이름을 쓰게 맞춘다. 7B 는 같은 프롬프트에서도
 * Ollama 상태에 따라 스키마 카드의 companyx 를 붙여 「companyx.admin_secrets」로 쓰기도 했고(2026-10-08, 같은 질문 3회씩 bench 와
 * companyx 로 갈림), 그러면 TC-150 이 보는 권한 거부(42501) 대신 없는 표 오류가 났다. 질문에 적힌 이름이 사용자가 고른 표다.
 * 다른 스키마를 붙인 같은 표 이름, FROM 과 JOIN 바로 뒤의 스키마 없는 같은 표 이름을 그 이름으로 바꾼다. 문자열 값은 건드리지 않고,
 * 같은 표가 질문에 두 이름 아래 적혔으면 바꾸지 않는다. 읽지 못하는 SQL 은 그대로 돌려준다.
 * 「X.Y」의 X 가 이 서버의 스키마 이름(프로파일이 선언한 SCHEMA_NAMES)일 때만 스키마.표로 읽는다. 「employees.salary 평균은 얼마야?」의
 * employees.salary 는 표.열인데 스키마.표로 읽어 맞는 SQL 의 `AVG(e.salary) … employees e` 를 `AVG(employees.salary)` 로 바꿨다(별칭을
 * 단 표를 표 이름으로 가리키면 PostgreSQL 이 거부한다). */
export function alignQualifiedTables(sql: string, question: string): string {
  const named = new Map<string, Map<string, string>>(); // 표 → (적힌 이름의 소문자 → 적힌 그대로)
  for (const m of question.matchAll(QUALIFIED_NAME)) {
    const table = m[2].toLowerCase();
    if (!named.has(table)) named.set(table, new Map());
    named.get(table)!.set(m[1].toLowerCase(), m[1]);
  }
  const wanted = new Map<string, string>();
  for (const [table, under] of named) {
    const [only] = under.size === 1 ? [...under] : [];
    if (only && KNOWN_SCHEMAS.has(only[0])) wanted.set(table, only[1]);
  }
  if (!wanted.size) return sql;
  const toks = tokenizeSql(sql);
  if (!toks) return sql;
  const edits: { at: number; end: number; text: string }[] = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    const schema = t.k === "w" ? wanted.get(t.v) : undefined;
    if (!schema) continue;
    if (toks[i - 1]?.k === ".") {
      const s = toks[i - 2];
      if (s?.k === "w" && s.v !== schema.toLowerCase() && toks[i - 3]?.k !== ".") edits.push({ at: s.at, end: tokenEnd(sql, s), text: schema });
    } else if (toks[i + 1]?.k !== "." && toks[i + 1]?.k !== "(" && toks[i - 1]?.k === "w" && (toks[i - 1].v === "from" || toks[i - 1].v === "join")) {
      edits.push({ at: t.at, end: t.at, text: `${schema}.` });
    }
  }
  let out = sql;
  for (const e of edits.sort((a, b) => b.at - a.at)) out = out.slice(0, e.at) + e.text + out.slice(e.end);
  return out;
}

/** 선언된 외래키 한 쌍. table.column 이 refTable.refColumn 을 가리킨다. */
export interface ForeignKey {
  table: string;
  column: string;
  refTable: string;
  refColumn: string;
}

export interface SqlCheck {
  ok: boolean;
  reasons: string[];
  /** 질문에 없는 번호로 건 id 조건. 그 행의 이름이 질문에 있으면 거부하지 않는다(confirmNamedIds). */
  ids: { col: string; num: number; tables: string[]; reason: string }[];
}

const IDENT = "[A-Za-z_][A-Za-z0-9_]*";
const NOT_ALIAS = new Set(
  ("on using where join inner left right full outer cross natural lateral group order having limit offset fetch " +
    "union intersect except window for as select from and or")
    .split(" "),
);

/** 별칭 → 테이블(known 에 든 표만). 하위 쿼리마다 같은 별칭을 다른 표에 쓸 수 있어 집합으로 모은다. 표 이름은 자기 자신에 묶는다. */
function aliasTables(masked: string, known: ReadonlySet<string>): Map<string, Set<string>> {
  const alias = new Map<string, Set<string>>();
  const bind = (name: string, table: string) => {
    if (!alias.has(name)) alias.set(name, new Set());
    alias.get(name)!.add(table);
  };
  const bindRe = new RegExp(`\\b(?:from|join)\\s+((?:${IDENT}\\.)?${IDENT})`, "gi");
  const aliasRe = new RegExp(`\\s+(?:as\\s+)?(${IDENT})`, "iy");
  for (const m of masked.matchAll(bindRe)) {
    const table = m[1].split(".").pop()!.toLowerCase();
    if (!known.has(table)) continue; // CTE, 하위 쿼리 이름, EXTRACT(… FROM 열): 어느 표인지 모른다
    bind(table, table);
    aliasRe.lastIndex = (m.index ?? 0) + m[0].length;
    const a = aliasRe.exec(masked)?.[1].toLowerCase();
    if (a && !NOT_ALIAS.has(a)) bind(a, table);
  }
  return alias;
}

/** 표마다의 열 이름(declaredColumns). 없는 열로 조인한 사유를 「projects 에는 dept_id 열이 없다」로 적는 데 쓴다. */
export type TableColumns = ReadonlyMap<string, ReadonlySet<string>>;

/** 없는 열로 조인한 사유의 꼴. untrustedAnswer 가 괄호 안을 답에 옮긴다. */
const MISSING_COLUMN = /^조인 조건 .+? 은 없는 열을 쓴다\(([^)]+)\)/;

/** 생성 SQL 을 실행해도 되는지. 확실히 읽지 못하는 부분은 거부하지 않는다(검사는 아는 꼴만 막는다).
 *  ① `JOIN … ON a.x = b.y` 의 열 쌍마다 선언된 외래키(어느 방향이든)여야 한다. fks 가 비었으면 이 검사는 끈다.
 *     columns 가 있고 한쪽 열이 그 표에 아예 없으면 사유가 그 열과 그 표가 외래키로 이어지는 표를 말한다: 「조인 조건
 *     p.dept_id = d.id 은 없는 열을 쓴다(projects 에는 dept_id 열이 없다). projects 는 client_id → clients, manager_id →
 *     employees, contract_id → contracts 로만 이어진다. 질문이 묻지 않은 표의 조인은 뺀다」. 종전 사유(「외래키가 아니다」)로는
 *     수리가 같은 조인을 다시 냈다(랜덤 테스트 사전 점검 2차 R11, 「예산이 가장 큰 프로젝트 3개」 3/3 거절).
 *  ② `x.id = 숫자`(또는 `id = 숫자`)의 숫자는 질문에 있어야 한다. 질문에 없는 번호로 한 행을 고르는 것은 추측이다. */
export function checkSql(sql: string, question: string, fks: ForeignKey[] | null, columns?: TableColumns | null): SqlCheck {
  const masked = maskSql(sql);
  if (masked === null) return { ok: true, reasons: [], ids: [] };
  const reasons: string[] = [];

  const alias = aliasTables(masked, new Set((fks ?? []).flatMap((f) => [f.table, f.refTable])));

  if (fks && fks.length) {
    const fk = (t1: string, c1: string, t2: string, c2: string) =>
      fks.some((f) => f.table === t1 && f.column === c1 && f.refTable === t2 && f.refColumn === c2);
    const fkPair = (t1: string, c1: string, t2: string, c2: string) => fk(t1, c1, t2, c2) || fk(t2, c2, t1, c1);
    const d = depths(masked);
    const stop = /\b(join|inner|left|right|full|cross|natural|where|group|order|having|limit|offset|fetch|union|intersect|except|window|on|select|from)\b/gi;
    for (const on of d ? masked.matchAll(/\bon\b/gi) : []) {
      const start = (on.index ?? 0) + 2;
      const base = d![on.index ?? 0];
      let end = masked.length;
      for (let i = start; i < masked.length; i++) {
        if (d![i] < base || (d![i] === base && masked[i] === ",")) {
          end = i;
          break;
        }
      }
      stop.lastIndex = start;
      for (let s = stop.exec(masked); s && s.index < end; s = stop.exec(masked)) {
        if (d![s.index] === base) {
          end = s.index;
          break;
        }
      }
      const seg = masked.slice(start, end);
      const eqRe = new RegExp(`(?<![A-Za-z0-9_.])((?:${IDENT}\\.){1,2}${IDENT})\\s*=\\s*((?:${IDENT}\\.){1,2}${IDENT})(?![A-Za-z0-9_.(])`, "g");
      for (const e of seg.matchAll(eqRe)) {
        const [lq, lc] = e[1].toLowerCase().split(".").slice(-2);
        const [rq, rc] = e[2].toLowerCase().split(".").slice(-2);
        const lt = alias.get(lq);
        const rt = alias.get(rq);
        if (!lt || !rt) continue; // 어느 표인지 모르면 판정하지 않는다
        // 같은 표의 같은 열로 잇는 자기 조인(c1.start_date = c2.start_date)은 같은 값끼리 짝짓는 것이라 외래키 조인이 아니다. 「같은 날 시작한
        // 계약이 있어?」를 「외래키가 아닌 열」로 거절했다(랜덤 테스트 사전 점검 6차 P13, SJ06 3/3. 2024-08-20 과 2025-09-23 두 쌍). 질문이 그 열을
        // 말할 때만 받는다(SELF_JOIN_WORDS). 「2025년 3분기 매출을 전년 같은 분기와 비교해줘」의 s1.client_id = s2.client_id … 는 매출 건끼리 짝지어 견줘
        // 종전처럼 거부한다(MR14 1/3).
        if (lc === rc && [...lt].some((t) => rt.has(t)) && selfJoinSaid(lc, question)) continue;
        const valid = [...lt].some((t1) => [...rt].some((t2) => fkPair(t1, lc, t2, rc)));
        if (valid) continue;
        // 열 목록을 아는 표에서 그 열이 어느 표에도 없으면 없는 열이다. 수리 안내가 되도록 그 표가 외래키로 이어지는 표를 덧붙인다.
        const absent = (ts: Set<string>, c: string) => (columns && [...ts].every((t) => columns.get(t)?.size && !columns.get(t)!.has(c)) ? [...ts] : null);
        const missing = [[absent(lt, lc), lc], [absent(rt, rc), rc]].filter((x): x is [string[], string] => x[0] !== null);
        if (!missing.length) {
          reasons.push(`조인 조건 ${e[1]} = ${e[2]} 은 스키마에 선언된 외래키가 아니다`);
          continue;
        }
        const paths = missing.map(([ts]) => {
          const out = fks.filter((f) => ts.includes(f.table)).map((f) => `${f.column} → ${f.refTable}`);
          return `${ts.join("/")} 는 ${out.length ? `${out.join(", ")} 로만 이어진다` : "다른 표를 가리키는 열이 없다"}`;
        });
        reasons.push(
          `조인 조건 ${e[1]} = ${e[2]} 은 없는 열을 쓴다(${missing.map(([ts, c]) => `${ts.join("/")} 에는 ${c} 열이 없다`).join(", ")}). ` +
            `${paths.join(". ")}. 질문이 묻지 않은 표의 조인은 뺀다`,
        );
      }
    }
  }

  const asked = new Set((question.match(/\d+/g) ?? []).map((n) => Number(n)));
  const idRe = new RegExp(
    `(?<![A-Za-z0-9_.])((?:${IDENT}\\.){0,2}id)\\s*=\\s*(\\d+)(?![\\d.])|(?<![A-Za-z0-9_.])(\\d+)\\s*=\\s*((?:${IDENT}\\.){0,2}id)(?![A-Za-z0-9_])`,
    "gi",
  );
  const ids: SqlCheck["ids"] = [];
  const fromTables = [...new Set([...alias.values()].flatMap((s) => [...s]))];
  for (const m of masked.matchAll(idRe)) {
    const col = (m[1] ?? m[4]).toLowerCase();
    const num = Number(m[2] ?? m[3]);
    if (asked.has(num)) continue;
    const q = col.split(".").slice(-2, -1)[0];
    const tables = q ? [...(alias.get(q) ?? [])] : fromTables.length === 1 ? fromTables : [];
    ids.push({ col, num, tables, reason: `${col} = ${num} 의 번호 ${num} 은 질문에 없다(질문에 없는 번호로 행을 고름)` });
  }
  return { ok: reasons.length === 0 && ids.length === 0, reasons, ids };
}

/** 집계를 부풀리는 조인 사유의 머리말. untrustedAnswer 가 이것으로 사유를 가른다. */
const FANOUT_REASON = "집계 ";

/** 부모 표(가리켜지는 쪽) 열의 집계가 자식 표(가리키는 쪽)와의 조인으로 부풀 수 있는 자리. */
export interface FanoutJoin {
  /** 생성 SQL 에 쓰인 집계 그대로(SUM(c.amount)). */
  agg: string;
  parent: string;
  child: string;
  /** 부모를 가리키는 자식 표의 외래키 열. 이 열에 같은 값이 둘 이상 있어야 실제로 부푼다(confirmFanout). */
  childColumn: string;
  /** 조인 조건 그대로(s.contract_id = c.id). */
  join: string;
  /** 부모의 키를 생성 SQL 의 별칭으로(c.id). 질의가 고르는 행에서 겹침을 셀 때 묶는 열. */
  parentKey: string;
  /** 집계가 든 SELECT 의 FROM 부터 WHERE 끝까지(원문 그대로). WITH 로 시작하는 문장은 CTE 를 빼면 뜻이 달라져 비워 둔다. */
  scope?: string;
}

/** ④ SUM, AVG 의 열이 가리켜지는 쪽 표(부모)에 있고, 같은 질의 단계에서 부모가 자기를 가리키는 표(자식)와 선언된 외래키로
 * 조인돼 있으면 부모 한 행이 자식 행 수만큼 겹쳐 집계된다. 「Client-Q 매출 합계랑 계약 금액 합계 각각 알려줘」에
 * `sales s JOIN contracts c ON s.contract_id = c.id` 로 SUM(c.amount) 를 해 계약 합계 107,850(실제 11,250)을 답했다(랜덤
 * 테스트 사전 점검 2차 R8). AVG 는 부모의 키로 묶었으면(GROUP BY c.id) 묶음마다 같은 값의 평균이라 맞다. SUM 은 묶어도
 * 겹친 수만큼 커서 막는다. 집계와 조인은 같은 괄호 깊이(같은 SELECT)만 짝짓는다. 하위 질의로 따로 집계한 값은 걸리지 않는다.
 * 확실히 읽지 못하는 문장, 별칭 없이 쓴 열, fks 가 빈 스키마는 판정하지 않는다. */
export function fanoutJoins(sql: string, fks: ForeignKey[] | null): FanoutJoin[] {
  if (!fks?.length) return [];
  const masked = maskSql(sql);
  if (masked === null) return [];
  const d = depths(masked);
  if (!d) return [];
  const known = new Set(fks.flatMap((f) => [f.table, f.refTable]));
  const out: FanoutJoin[] = [];
  // COUNT 는 DISTINCT 없이 부모의 키를 셀 때만 본다(COUNT(co.id) 를 sales 와 조인해 Client-T 계약 6건을 41건으로 셌다. 랜덤 테스트 사전 점검 5차 P12,
  // JN04 3/3). 부모의 키로 묶어도 자식 행 수를 센다.
  const aggRe = new RegExp(`\\b(sum|avg|count)\\s*\\(\\s*(distinct\\s+)?((?:${IDENT}\\.){1,2}${IDENT})\\s*\\)`, "gi");
  for (const a of masked.matchAll(aggRe)) {
    const isCount = a[1].toLowerCase() === "count";
    if (isCount && a[2]) continue;
    const at = a.index ?? 0;
    const level = d[at];
    // 집계가 든 SELECT 의 범위: 같은 깊이를 여는 괄호 뒤부터 닫는 괄호 앞까지(맨 바깥이면 문장 전체)
    let lo = 0;
    let hi = masked.length;
    if (level > 0) {
      for (let i = at; i >= 0; i--) if (masked[i] === "(" && d[i] === level - 1) { lo = i + 1; break; }
      for (let i = at; i < masked.length; i++) if (masked[i] === ")" && d[i] === level - 1) { hi = i; break; }
    }
    const here = (re: RegExp) => [...masked.slice(lo, hi).matchAll(re)].filter((m) => d[lo + (m.index ?? 0)] === level);
    const bind = new Map<string, string>();
    for (const m of here(new RegExp(`\\b(?:from|join)\\s+((?:${IDENT}\\.)?${IDENT})(?:\\s+(?:as\\s+)?(${IDENT}))?`, "gi"))) {
      const table = m[1].split(".").pop()!.toLowerCase();
      if (!known.has(table)) continue;
      bind.set(table, table);
      const al = m[2]?.toLowerCase();
      if (al && !NOT_ALIAS.has(al)) bind.set(al, table);
    }
    const [aq, ac] = a[3].toLowerCase().split(".").slice(-2);
    const parent = bind.get(aq);
    if (!parent) continue;
    const group = here(/\bgroup\s+by\b/gi)[0];
    let groupText = "";
    if (group) {
      const from = lo + (group.index ?? 0);
      const stop = [...masked.slice(from, hi).matchAll(/\b(having|order|limit|offset|fetch|window|union|intersect|except)\b/gi)].find(
        (m) => d[from + (m.index ?? 0)] === level,
      );
      groupText = masked.slice(from, stop ? from + (stop.index ?? 0) : hi).toLowerCase();
    }
    // 그 SELECT 의 FROM 부터 다음 절(GROUP BY 등) 앞까지. 질의가 실제로 고르는 행에서 겹침을 셀 때 쓴다(confirmFanout).
    let scope: string | undefined;
    const fromAt = here(/\bfrom\b/gi)[0];
    if (fromAt && !/^\s*with\b/i.test(masked)) {
      const from = lo + (fromAt.index ?? 0);
      const stop = [...masked.slice(from, hi).matchAll(/\b(group|having|order|limit|offset|fetch|window|union|intersect|except)\b/gi)].find(
        (m) => d[from + (m.index ?? 0)] === level,
      );
      scope = sql.slice(from, stop ? from + (stop.index ?? 0) : hi).replace(/[\s;]+$/, "");
    }
    const eqRe = new RegExp(`(?<![A-Za-z0-9_.])((?:${IDENT}\\.){1,2}${IDENT})\\s*=\\s*((?:${IDENT}\\.){1,2}${IDENT})(?![A-Za-z0-9_.(])`, "g");
    for (const e of here(eqRe)) {
      const sides = [e[1], e[2]].map((x) => x.toLowerCase().split(".").slice(-2) as [string, string]);
      for (const [[pq, pc], [cq, cc]] of [[sides[0], sides[1]], [sides[1], sides[0]]]) {
        if (pq !== aq) continue;
        const child = bind.get(cq);
        if (!child || !fks.some((f) => f.table === child && f.column === cc && f.refTable === parent && f.refColumn === pc)) continue;
        // 부모의 키나 이름으로 묶었으면(GROUP BY c.name) 묶음마다 센 부모 키는 자식 행 수이고 그것을 물었을 수 있다(「고객사별 계약 수」의
        // COUNT(c.id)). 부모의 다른 열(지역, 업종, 규모)로 묶으면 묶음마다 부모가 여럿이라 겹쳐 센다: 「지역별 고객사 수와 티켓 수」의 GROUP BY
        // c.region 에 COUNT(c.id) 가 부산 17곳(실제 4곳)이었다(랜덤 테스트 사전 점검 6차 P10, CJ06 3/3).
        const byParent = new RegExp(`(?<![A-Za-z0-9_.])(?:(?:(?:${aq}|${parent})\\.)?(?:${pc}|name)|${cq}\\.${cc})(?![A-Za-z0-9_])`).test(groupText);
        if (isCount && (ac !== pc || byParent)) continue;
        // AVG 는 부모의 키로 묶으면 맞다.
        const keyed = new RegExp(`(?<![A-Za-z0-9_])(?:${aq}|${parent})\\.${pc}(?![A-Za-z0-9_])`).test(groupText);
        if (a[1].toLowerCase() === "avg" && keyed) continue;
        const agg = sql.slice(at, at + a[0].length);
        if (!out.some((x) => x.agg === agg && x.child === child)) {
          const join = sql.slice(lo + (e.index ?? 0), lo + (e.index ?? 0) + e[0].length);
          out.push({ agg, parent, child, childColumn: cc, join, parentKey: `${pq}.${pc}`, ...(scope ? { scope } : {}) });
        }
      }
    }
  }
  return out;
}

/** fanoutJoins 의 자리 가운데 실제로 부푸는 조인의 사유. 부서장(departments.head_id)처럼 한 부모를 한 자식만 가리키거나,
 * 질의가 자식을 한 행으로 좁혀(WHERE s.id = 7) 부모 한 행이 한 번만 잡히면 막지 않는다. 읽지 못하면 막지 않는다.
 * 데이터에 따라 바뀌는 판정이라 기억해 두지 않는다(PR #257 리뷰: 처음에 겹침이 없다고 기억하면 나중에 생긴 겹침을 못 막는다). */
export async function confirmFanout(pool: Pool, schema: string, joins: FanoutJoin[]): Promise<string[]> {
  const reasons: string[] = [];
  for (const j of joins) {
    const dup = (await scopedFanout(pool, j)) ?? (await tableFanout(pool, schema, j));
    if (!dup) continue;
    const counted = /^count\s*\(/i.exec(j.agg)
      ? `${j.child} 행 수만큼 겹쳐 세어진다. ${j.agg} 를 COUNT(DISTINCT ${j.agg.replace(/^count\s*\(\s*|\s*\)$/gi, "")}) 로 바꾼 SQL 전체를 쓴다`
      : `${j.child} 행 수만큼 겹쳐 집계된다. ${j.parent} 의 값은 ${j.child} 와 조인하지 않은 하위 질의로 따로 집계한다`;
    reasons.push(`${FANOUT_REASON}${j.agg} 은 ${j.parent} 의 열인데 ${j.parent} 를 가리키는 ${j.child} 와 조인(${j.join})해 ${j.parent} 한 행이 ${counted}`);
  }
  return reasons;
}

/** 사유가 모두 부모 키의 COUNT 팬아웃(confirmFanout)이면 그 COUNT(x) 를 COUNT(DISTINCT x) 로 바꾼 SQL. 아니면 null. 사유만 되먹였을 때 7B 수리는
 * 「COUNT(DISTINCT co.id)」 한 조각만 내 SQL 이 없었다(랜덤 테스트 사전 점검 5차 P12 수정본 실측, JN04 3/3 거절). */
export function countDistinctRewrite(sql: string, reasons: readonly string[]): string | null {
  if (!reasons.length) return null;
  const aggs = reasons.map((r) => /^집계 (count\s*\(\s*((?:[A-Za-z_][A-Za-z0-9_]*\.){1,2}[A-Za-z_][A-Za-z0-9_]*)\s*\)) 은 /i.exec(r));
  if (aggs.some((a) => !a)) return null;
  let out = sql;
  for (const a of aggs) out = out.split(a![1]).join(`COUNT(DISTINCT ${a![2]})`);
  return out === sql ? null : out;
}

/** 그 질의가 고르는 행에서 부모 한 행이 두 번 이상 잡히는가. 생성 SQL 의 FROM..WHERE 를 그대로 써서 sql.query 와 같은
 * 읽기 전용 거래(mcp_ro, 시간 상한)에서 센다. 범위가 없거나(WITH 문장) 실행하지 못하면(바깥 별칭을 쓰는 하위 질의 등) null. */
async function scopedFanout(pool: Pool, j: FanoutJoin): Promise<boolean | null> {
  if (!j.scope) return null;
  const r = await sqlQuery(pool, `SELECT EXISTS (SELECT 1 ${j.scope} GROUP BY ${j.parentKey} HAVING count(*) > 1) AS dup`);
  const v = r.ok ? (r.rows[0] as { dup?: unknown } | undefined)?.dup : undefined;
  return typeof v === "boolean" ? v : null;
}

/** 자식의 외래키 열 전체에 같은 값이 둘 이상 있는가(질의의 범위를 쓸 수 없을 때). 읽지 못하면 null. */
async function tableFanout(pool: Pool, schema: string, j: FanoutJoin): Promise<boolean | null> {
  if (![schema, j.child, j.childColumn].every((x) => /^[a-z_][a-z0-9_]*$/.test(x))) return null;
  try {
    const res = await pool.query(
      `SELECT EXISTS (SELECT 1 FROM ${schema}.${j.child} WHERE ${j.childColumn} IS NOT NULL GROUP BY ${j.childColumn} HAVING count(*) > 1) AS dup`,
    );
    const v = (res?.rows?.[0] as { dup?: unknown } | undefined)?.dup;
    return typeof v === "boolean" ? v : null;
  } catch {
    return null;
  }
}

/** 스키마마다 만원 단위인 금액 열(nl2sql.ts 의 주석 카드). 여기 없는 스키마(smoke 의 public, bench)는 금액 단위를 보지 않는다. */
const MONEY_COLUMNS = new Map<string, readonly string[]>([["companyx", ["salary", "amount", "budget", "price_monthly"]]]);

export function moneyColumns(schema: string): readonly string[] {
  return MONEY_COLUMNS.get(schema) ?? [];
}

/** 금액 단위 사유의 머리말. untrustedAnswer 가 이것으로 사유를 가른다. */
const MONEY_REASON = "금액 조건 ";
const UNIT_FACTORS = [10, 100, 1000, 10000];
const same = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

/** ③ 질문에 금액 표현(money.ts)이 있을 때, 금액 열을 숫자와 비교하는 조건(=, <>, !=, <, <=, >, >=, BETWEEN)의 숫자가
 * 질문의 만원 값과 10, 100, 1000, 10000 배로 어긋나면 단위 오류다. 사유는 기대한 만원 값을 말한다(수리 안내가 된다).
 * 질문의 만원 값과 같은 숫자, 어느 값과도 배수 관계가 아닌 숫자, 집계(SUM(amount) > …)와 식(salary * 12 > …), 확실히
 * 읽지 못하는 문장은 판정하지 않는다. columns 가 비었으면(금액 열을 모르는 스키마) 끈다. */
export function checkMoney(sql: string, question: string, columns: readonly string[]): string[] {
  if (!columns.length) return [];
  const asked = moneyMentions(question);
  if (!asked.length) return [];
  const masked = maskSql(sql);
  if (masked === null) return [];
  const col = `(?<![A-Za-z0-9_$.])(?<![*/%^+\\-|]\\s*)(?:${IDENT}\\.){0,2}(?:${columns.join("|")})(?![A-Za-z0-9_$])`;
  const lit = "(\\d+(?:\\.\\d*)?(?:[eE][+-]?\\d+)?|\\.\\d+(?:[eE][+-]?\\d+)?)(?![A-Za-z0-9_.])";
  const litEnd = "(?!\\s*[*/%^+\\-|])";
  const op = "(?:<>|!=|<=|>=|=|<|>)";
  const forms = [
    new RegExp(`${col}\\s*${op}\\s*${lit}${litEnd}`, "gi"),
    new RegExp(`(?<![A-Za-z0-9_$.])(?<![*/%^+\\-|]\\s*)${lit}\\s*${op}\\s*${col}(?!\\s*[*/%^+\\-|.(])`, "gi"),
    new RegExp(`${col}\\s+(?:not\\s+)?between\\s+(?:symmetric\\s+)?${lit}\\s+and\\s+${lit}${litEnd}`, "gi"),
  ];
  const reasons: string[] = [];
  for (const re of forms) {
    for (const m of masked.matchAll(re)) {
      const cond = sql.slice(m.index, m.index + m[0].length).replace(/\s+/g, " ");
      for (const raw of m.slice(1).filter((x) => x !== undefined)) {
        const n = Number(raw);
        if (asked.some((a) => same(a.manwon, n))) continue;
        const near = asked.find((a) => UNIT_FACTORS.some((f) => same(n * f, a.manwon) || same(n, a.manwon * f)));
        if (!near) continue;
        const want = formatManwon(near.manwon);
        reasons.push(
          `${MONEY_REASON}${cond} 의 ${raw} 은 질문의 금액 「${near.text}」(=${want}만 원)과 단위가 다르다. ` +
            `금액 열은 만원 단위라 ${want} 이어야 한다`,
        );
      }
    }
  }
  return reasons;
}

/** 기간 사유의 머리말. untrustedAnswer 가 이것으로 사유를 가른다. */
const PERIOD_REASON = "기간 조건 ";
/** 질문이 분기, 월, 반기를 말하는가. 말하면 한 분기를 고르는 조건이 맞을 수 있어 기간 검사를 하지 않는다. */
const PART_OF_YEAR = /\d\s*분기|[일이삼사]\s*분기|사분기|분기별|Q[1-4]|\d{1,2}\s*월|상반기|하반기|반기/i;

/** ⑤ 질문이 한 해(「2025년 매출」, 「작년 매출」)를 묻고 분기나 월을 말하지 않는데 생성 SQL 이 그해의 한 분기만
 * (quarter = '2025-Q3') 고르면 기간이 다르다. 스키마 카드의 분기 예시가 '2025-Q3' 이라 7B 는 「2025년 매출은 얼마야?」,
 * 「2025년 총 매출은 얼마야?」를 3분기 23,859 로 답했다(2025년 전체는 112,773, 2026-10-08 실측 각 1회). 「2024년 매출
 * 합계」, 「2025년 전체 매출」은 맞게 한 해를 골랐다. 사유는 한 해 전체로 고르라고 말한다(수리 안내가 된다). 질문의 연도는
 * 숫자 연도와 상대 연도(작년, 지난해, 재작년, 내년, 서울 기준)를 함께 본다. */
export function checkPeriod(sql: string, question: string, now: Date = new Date()): string[] {
  return [...checkSinceYear(sql, question, now), ...checkSameQuarterLastYear(sql, question, now), ...checkYearPeriod(sql, question, now)];
}

/** 「YYYY년 이후」, 「YYYY년부터」(상대 연도 포함). 바로 뒤에 달이나 분기가 오면(「2025년 3월부터」) 보지 않는다. */
const SINCE_YEAR_RE = /(?:(?<![\d.])(\d{4})\s*년\s*도?|(재작년|작년|지난해|내년)\s*도?)\s*(?:이후|부터|이래)/g;

/** ⑤-4 질문이 「2025년 이후」, 「2025년부터」를 묻는데 생성 SQL 이 그해 끝 다음부터 고르면(hire_date > '2025-12-31', >= '2026-01-01',
 * EXTRACT(YEAR FROM …) > 2025) 그해가 빠진다. 「2025년 이후에 입사한 직원은 몇 명이야?」에 0명을 답했다(2025-01-01 이후 입사는 6명. 랜덤 테스트
 * 사전 점검 5차 P3, DT03 3/3). 그해 첫날부터 고르는 조건(>= '2025-01-01')이 함께 있으면 보지 않는다. */
function checkSinceYear(sql: string, question: string, now: Date): string[] {
  const years = new Set<number>();
  for (const m of question.matchAll(SINCE_YEAR_RE)) years.add(m[1] ? Number(m[1]) : seoulYear(now) + RELATIVE_YEAR[m[2]]);
  if (!years.size) return [];
  const masked = maskSql(sql);
  if (masked === null) return [];
  const reasons: string[] = [];
  const col = `((?:${IDENT}\\.)?${IDENT}(?:_date|_at))`;
  for (const year of years) {
    if (new RegExp(`${col}\\s*>=\\s*'${year}-01-01'|extract\\s*\\(\\s*year\\s+from\\s+${col}\\s*\\)\\s*>=\\s*${year}\\b`, "i").test(sql)) continue;
    const late = [
      new RegExp(`${col}\\s*>\\s*'${year}-12-31(?:[ T][0-9:.]*)?'`, "gi"),
      new RegExp(`${col}\\s*>=?\\s*'${year + 1}-01-01'`, "gi"),
      new RegExp(`extract\\s*\\(\\s*year\\s+from\\s+${col}\\s*\\)\\s*>\\s*${year}\\b`, "gi"),
      new RegExp(`date_part\\s*\\(\\s*'year'\\s*,\\s*${col}\\s*\\)\\s*>\\s*${year}\\b`, "gi"),
    ];
    for (const re of late) {
      for (const m of sql.matchAll(re)) {
        if (masked.slice(m.index ?? 0, (m.index ?? 0) + m[0].length) !== m[0].replace(/'[^']*'/g, (s) => `'${" ".repeat(s.length - 2)}'`)) continue;
        reasons.push(
          `${PERIOD_REASON}${m[0].replace(/\s+/g, " ")} 은 ${year}년을 뺀다. 질문의 「${year}년 이후(부터)」는 ${year}년을 포함한다. ` +
            `${m[1]} >= '${year}-01-01' 로 고른다`,
        );
      }
    }
  }
  return reasons;
}

/** ⑤-5 질문이 한 기간으로 「작년 같은 분기」를 묻는데(서울 기준 오늘이 2026년 4분기면 2025년 4분기) 생성 SQL 의 분기 값 조건이 그 분기가
 * 아니면 기간이 다르다. 「작년 같은 분기 매출은 얼마였어?」에 quarter LIKE '2025-Q%' 로 한 해 합계 112,773 을 답했다(2025-Q4 는 31,795. 5차 P3,
 * DT10 3/3). 분기 값 조건이 없으면(날짜 범위) 보지 않는다. */
function checkSameQuarterLastYear(sql: string, question: string, now: Date): string[] {
  const target = sameQuarterLastYear(question, now);
  if (!target || maskSql(sql) === null) return [];
  const want = `${target.year}-Q${target.quarter}`;
  const conds = [
    ...sql.matchAll(/(?<![A-Za-z0-9_$])(?:[A-Za-z_][A-Za-z0-9_]*\.)?quarter(?:\s*(?:=|i?like)\s*'[^']*'|\s+in\s*\([^()]*\))/gi),
  ];
  if (!conds.length) return [];
  // 그 분기를 고르면 받는다. 이번 분기와 견주는 질문(「작년 동기 대비 매출 증감률은?」)은 이번 분기도 함께 골라야 한다: 2025-Q4 를 직전 분기 2025-Q3 와 견준
  // 33.26% 를 「작년 동기 대비」로 답했다(랜덤 테스트 사전 점검 6차 P4, MR17, XC05 3/3).
  const chosen = pickedQuarters(conds);
  const compare = sameQuarterCompare(question, now);
  const current = (target.year + 1) * 4 + target.quarter - 1;
  const picked = [...new Set(conds.map((c) => c[0].replace(/\s+/g, " ")))].join(", ");
  if (chosen?.has(target.year * 4 + target.quarter - 1)) {
    if (!compare || chosen.has(current)) return [];
    return [
      `${PERIOD_REASON}${picked} 은 이번 분기(${compare.current})를 고르지 않는다. 질문의 「작년 동기 대비」는 이번 분기(${target.year + 1}년 ${target.quarter}분기)를 ` +
        `1년 전 같은 분기(${target.year}년 ${target.quarter}분기)와 견준다. quarter IN ('${compare.current}', '${want}') 로 두 분기를 고르고 분기마다 합계를 견준다`,
    ];
  }
  return [
    `${PERIOD_REASON}${picked} 은 질문의 기간과 다르다. 질문의 「작년 같은 분기」는 오늘(${target.year + 1}년 ${target.quarter}분기)의 1년 전인 ` +
      `${target.year}년 ${target.quarter}분기다. quarter = '${want}' 로 고른다`,
  ];
}

function checkYearPeriod(sql: string, question: string, now: Date): string[] {
  const month = checkMonthPeriod(sql, question, now);
  if (month.length) return month;
  // 「작년 같은 분기」는 한 해가 아니라 그해의 한 분기를 묻는다(checkSameQuarterLastYear 가 본다).
  if (PART_OF_YEAR.test(question) || new RegExp(SAME_QUARTER_LAST_YEAR_RE.source).test(question)) return checkHalfYear(sql, question, now);
  const years = new Set<number>([...question.matchAll(/(\d{4})\s*년/g)].map((m) => Number(m[1])));
  const thisYear = seoulYear(now);
  for (const m of question.matchAll(RELATIVE_YEAR_RE)) years.add(thisYear + RELATIVE_YEAR[m[1]]);
  if (!years.size) return [];
  const reasons: string[] = [];
  for (const m of sql.matchAll(/(?<![A-Za-z0-9_$])((?:[A-Za-z_][A-Za-z0-9_]*\.)?quarter\s*=\s*'(\d{4})-Q[1-4]')/gi)) {
    const year = Number(m[2]);
    if (!years.has(year)) continue;
    reasons.push(
      `${PERIOD_REASON}${m[1].replace(/\s+/g, " ")} 은 ${year}년의 한 분기만 고른다. 질문은 분기를 말하지 않고 ${year}년을 묻는다. ` +
        `한 해 전체(quarter LIKE '${year}-%' 나 날짜의 연도)로 고른다`,
    );
  }
  return reasons;
}

/** 질문이 연도와 함께 말한 달: 「2024년 3월」, 「24년 3월」, 「작년 3월」. 뒤에 날이 오면(「3월 15일」) 하루를 묻는 것이라 뺀다. */
const YEAR_MONTH_RE =
  /(?:(?<![\d.])(\d{4}|\d{2})\s*년\s*도?|(재작년|작년|지난해|내년|올해|금년)\s*도?)\s*(?:의\s*)?(1[0-2]|0?[1-9])\s*월(?!\s*\d{1,2}\s*일)/g;

/** 질문이 연도와 함께 말한 달 범위: 「2025년 1월부터 3월까지」, 「2025년 1월~3월」, 「2025년 1~3월」, 「2025년 1월에서 3월」,
 * 「2024년 11월부터 2025년 2월까지」. 끝 달 뒤에 날이 오면(「3월 15일」) 날짜 범위라 뺀다. */
const YEAR_MONTH_RANGE_RE =
  /(?:(?<![\d.])(\d{4}|\d{2})\s*년\s*도?|(재작년|작년|지난해|내년|올해|금년)\s*도?)\s*(?:의\s*)?(1[0-2]|0?[1-9])\s*(?:월\s*(?:부터|에서|~|～|〜|-)|~|～|〜|-)\s*(?:(\d{4})\s*년\s*도?\s*)?(1[0-2]|0?[1-9])\s*월(?!\s*\d{1,2}\s*일)/g;

/** 질문이 묻는 달 또는 달 범위. from, to 는 (연도 × 12 + 달 - 1) 이다. 한 달이면 from = to. */
interface AskedMonths {
  from: number;
  to: number;
}
const monthIndex = (year: number, month: number) => year * 12 + month - 1;
const monthLabel = (i: number) => `${Math.floor(i / 12)}년 ${(i % 12) + 1}월`;
const monthStart = (i: number) => `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}-01`;

function askedMonths(question: string, now: Date): AskedMonths[] {
  const thisYear = seoulYear(now);
  const out = new Map<string, AskedMonths>();
  const add = (from: number, to: number) => out.set(`${from}-${to}`, { from, to });
  const yearOf = (digits: string | undefined, word: string | undefined) =>
    digits ? (digits.length === 2 ? 2000 + Number(digits) : Number(digits)) : thisYear + (RELATIVE_YEAR[word ?? ""] ?? 0);
  // 달 범위를 먼저 읽는다. 「2025년 1월부터 3월까지」를 연도가 붙은 1월 하나로 읽어 맞던 quarter = '2025-Q1' 을 1월로 수리했다(5차 P2).
  const covered: [number, number][] = [];
  for (const m of question.matchAll(YEAR_MONTH_RANGE_RE)) {
    const year = yearOf(m[1], m[2]);
    const endYear = m[4] ? Number(m[4]) : year;
    const from = monthIndex(year, Number(m[3]));
    let to = monthIndex(endYear, Number(m[5]));
    if (to < from && !m[4]) to += 12; // 「2025년 11월부터 2월까지」는 다음 해 2월
    if (to < from) continue;
    add(from, to);
    covered.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
  }
  for (const m of question.matchAll(YEAR_MONTH_RE)) {
    if (covered.some(([s, e]) => (m.index ?? 0) >= s && (m.index ?? 0) < e)) continue;
    const i = monthIndex(yearOf(m[1], m[2]), Number(m[3]));
    add(i, i);
    covered.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
  }
  // 연도 없이 뒤에 이어지는 달과 달 범위(「2025년 1월부터 3월까지와 4월부터 6월까지」의 4~6월)는 바로 앞 연도의 달이다. 앞에 연도가 없으면 보지 않는다.
  const anchors = [...question.matchAll(/(?:(?<![\d.])(\d{4}|\d{2})\s*년|(재작년|작년|지난해|내년|올해|금년))/g)].map((m) => ({ at: m.index ?? 0, year: yearOf(m[1], m[2]) }));
  const yearBefore = (at: number) => anchors.filter((a) => a.at < at).pop()?.year;
  for (const m of question.matchAll(/(?<![\d.년])(1[0-2]|0?[1-9])\s*(?:(?:월\s*(?:부터|에서|~|～|〜|-)|~|～|〜|-)\s*(1[0-2]|0?[1-9])\s*)?월(?!\s*\d{1,2}\s*일)/g)) {
    const at = m.index ?? 0;
    if (covered.some(([s, e]) => at < e && at + m[0].length > s)) continue;
    const year = yearBefore(at);
    if (year === undefined) continue;
    const from = monthIndex(year, Number(m[1]));
    const to = m[2] ? monthIndex(year, Number(m[2])) : from;
    if (to >= from) add(from, to);
  }
  for (const m of question.matchAll(DOT_MONTH_RE)) {
    const i = monthIndex(Number(m[1]), Number(m[2]));
    add(i, i);
  }
  return [...out.values()];
}

/** 생성 SQL 의 분기 값 조건이 고르는 분기(연도 × 4 + 분기 - 1). =, IN 의 'YYYY-Qn' 만 읽고, 다른 꼴(LIKE, 크기 비교)이 있으면 null. */
function pickedQuarters(conds: RegExpMatchArray[]): Set<number> | null {
  const out = new Set<number>();
  for (const c of conds) {
    const text = c[0];
    if (/\b(?:i?like)\b/i.test(text) && /[%_]/.test(/'([^']*)'/.exec(text)?.[1] ?? "%")) return null;
    const values = [...text.matchAll(/'(\d{4})-Q([1-4])'/g)];
    if (!values.length || /'[^']*'/.test(text.replace(/'\d{4}-Q[1-4]'/g, ""))) return null;
    for (const v of values) out.add(Number(v[1]) * 4 + Number(v[2]) - 1);
  }
  return out;
}

/** ⑤-3 질문이 한 달(「2024년 3월」, 「24년 3월」, 「2024.3」)을 묻는데 생성 SQL 이 그 달의 날짜 없이 분기 값(quarter =, LIKE, IN)으로
 * 고르면 기간이 다르다. 「24년 3월 매출은 얼마야?」에 quarter = '2024-Q1' 로 1분기 합 31,960 을 3월 매출이라고 답했다(3월은 11,634.
 * 랜덤 테스트 사전 점검 4차 P1, SF11 3/3). 「2024년 3월」은 '2024-Q2'(3월이 든 분기도 아님), 「2024.3」은 '2024-Q3' 이었다. 질문이
 * 분기나 반기도 말하면(「3월이 든 분기」) 보지 않고, SQL 이 그 달의 날짜('2024-03-…')나 달 단위 식(EXTRACT(MONTH), date_trunc('month'))을
 * 쓰면 보지 않는다. 사유는 그 달의 sale_date 범위를 적는다(수리 안내가 된다). */
function checkMonthPeriod(sql: string, question: string, now: Date): string[] {
  if (/분기|반기|Q[1-4]/i.test(question)) return [];
  const months = askedMonths(question, now);
  if (!months.length || maskSql(sql) === null || monthGrouped(sql)) return [];
  const quarter = new RegExp(
    `(?<![A-Za-z0-9_$])((?:[A-Za-z_][A-Za-z0-9_]*\\.)?)quarter(?:\\s*(?:=|i?like)\\s*'[^']*'|\\s+in\\s*\\([^()]*\\))`,
    "gi",
  );
  const conds = [...sql.matchAll(quarter)];
  if (!conds.length) return [];
  const picked = [...new Set(conds.map((c) => c[0].replace(/\s+/g, " ")))].join(", ");
  const date = `${conds[0][1]}sale_date`;
  const chosen = pickedQuarters(conds);
  // 분기와 꼭 같은 달 범위들이 가리키는 분기 전체. 범위가 둘이면(「1월부터 3월까지와 4월부터 6월까지」) SQL 은 두 분기를 함께 고른다.
  const quartersOf = (from: number, to: number) =>
    from % 3 === 0 && to % 3 === 2 ? Array.from({ length: (to - from + 1) / 3 }, (_, k) => Math.floor(from / 3) + k) : [];
  const askedQuarters = new Set(months.flatMap(({ from, to }) => quartersOf(from, to)));
  const reasons: string[] = [];
  for (const { from, to } of months) {
    if (sql.includes(`'${monthStart(from).slice(0, 7)}`)) continue; // 그 달(첫 달)의 날짜로도 고른다
    const range = `${date} >= '${monthStart(from)}' AND ${date} < '${monthStart(to + 1)}'`;
    if (from === to) {
      reasons.push(
        `${PERIOD_REASON}${picked} 은 분기를 고른다. 질문의 ${monthLabel(from)}은 한 분기가 아니라 한 달이다. ` +
          `분기(quarter)가 아니라 그 달의 날짜 범위(${range})로 고른다`,
      );
      continue;
    }
    // 달 범위가 분기 몇 개와 꼭 같으면(1~3월 = 1분기) 그 분기들을 고른 조건은 맞다. 「2025년 1월부터 3월까지」의 quarter = '2025-Q1' 은 30,403 으로
    // 맞았는데 1월만 고르게 수리했다(5차 P2, 1월은 6,820).
    const want = quartersOf(from, to);
    const whole = want.length > 0;
    if (whole && chosen && want.every((q) => chosen.has(q)) && [...chosen].every((q) => askedQuarters.has(q))) continue;
    const span = `${monthLabel(from)}부터 ${Math.floor(to / 12) === Math.floor(from / 12) ? `${(to % 12) + 1}월` : monthLabel(to)}까지`;
    const quarters = want.map((q) => `'${Math.floor(q / 4)}-Q${(q % 4) + 1}'`);
    reasons.push(
      whole
        ? `${PERIOD_REASON}${picked} 은 분기를 고른다. 질문의 ${span}는 ${quarters.length === 1 ? `quarter = ${quarters[0]}` : `quarter IN (${quarters.join(", ")})`} 다. ` +
            `그 분기나 그 달들의 날짜 범위(${range})로 고른다`
        : `${PERIOD_REASON}${picked} 은 분기를 고른다. 질문의 ${span}는 분기와 맞지 않는 달 범위다. ` +
            `분기(quarter)가 아니라 그 달들의 날짜 범위(${range})로 고른다`,
    );
  }
  return reasons;
}

/** 반기의 분기. */
const HALF: Readonly<Record<string, { name: string; quarters: readonly number[] }>> = {
  상: { name: "상반기", quarters: [1, 2] },
  하: { name: "하반기", quarters: [3, 4] },
};
const HALF_RE = /(?:(\d{4})\s*년\s*도?|(재작년|작년|지난해|내년|올해|금년)\s*도?)\s*(?:의\s*)?(상|하)반기/g;
const QUARTER_OR_MONTH = /\d\s*분기|[일이삼사]\s*분기|사분기|Q[1-4]|\d{1,2}\s*월/i;
/** 질문의 연도 낱말. 바로 뒤에 반기가 오지 않으면 그해를 반기로 좁히지 않고 묻는다(「2024년 하반기 매출은 2024년 매출의 몇 %야?」). */
const YEAR_WORD = /(\d{4})\s*년(?:\s*도)?|(재작년|작년|지난해|내년|올해|금년)(?:\s*도)?/g;
/** 연도를 붙이지 않고 한 해 전체를 묻는 말: 연간, 한 해, 1년, 일 년, 연 매출, 그해, 전체. 「하반기 전체」의 전체는 반기 전체라 뺀다. */
const WHOLE_YEAR_WORD =
  /연간|한\s*해|(?<![\d.,])1\s*년(?!\s*(?:전|후|뒤|만))|(?<![가-힣\d])일\s*년|(?<![가-힣])연\s*(?:매출|실적|합계|총)|그\s*해(?![가-힣])|그해|(?<!반기\s*(?:의\s*)?)전체/;
/** 날짜 열의 범위 조건이나 달 추출. 분기 값이 반기보다 넓어도 이것이 행을 더 좁힐 수 있다. */
const DATE_NARROWING = /(?<![A-Za-z0-9_$])(?:[A-Za-z_][A-Za-z0-9_]*\.)?[A-Za-z_][A-Za-z0-9_]*(?:_date|_at)\s*(?:<|>|between\b)|\bextract\s*\(\s*month\b|\bdate_part\s*\(\s*'month'/i;

/** 가린 문장에서 CASE … END 와 FILTER ( … ) 의 범위. 그 안의 조건은 행을 고르지 않고 식 안에서 값을 가른다. */
function exprSpans(masked: string): [number, number][] {
  const spans: [number, number][] = [];
  const open: number[] = [];
  for (const m of masked.matchAll(/\b(case|end)\b/gi)) {
    if (m[1].toLowerCase() === "case") open.push(m.index ?? 0);
    else if (open.length) spans.push([open.pop()!, (m.index ?? 0) + 3]);
  }
  const d = depths(masked);
  for (const m of d ? masked.matchAll(/\bfilter\s*\(/gi) : []) {
    const at = (m.index ?? 0) + m[0].length - 1;
    let end = at + 1;
    while (end < masked.length && !(masked[end] === ")" && d![end] === d![at])) end++;
    spans.push([at, end]);
  }
  return spans;
}

/** ⑤-2 질문이 반기(「2024년 하반기」, 「올해 상반기」)를 묻는데 생성 SQL 이 그해의 분기를 값으로 고르면서 그 반기의 두 분기와 다르게
 * 고르면 기간이 다르다. 「2024년 하반기 총 매출액은 얼마야?」에 7B 가 quarter = '2024-Q4' 만 골라 42,404 를 답했다(3분기 22,730 을
 * 뺌, 하반기는 65,134. 랜덤 테스트 사전 점검 3차 T01, 3/3). 분기 값은 =, LIKE, IN 과 그해 전체(LIKE 'YYYY-%')로 읽고, 분기를
 * 크기로 비교하면(>=, BETWEEN) 판정하지 않는다. 질문이 분기나 월을 따로 말하거나(「하반기 중 4분기」), 연도 없는 반기가 있거나
 * (「상반기와 하반기」), SQL 이 날짜 범위로 고르면 보지 않는다.
 * 그해 전체도 함께 묻거나(「2024년 하반기 매출은 2024년 연간 매출의 몇 퍼센트야?」, 「… 2024년 전체 매출을 같이 보여줘」) 반기를
 * WHERE 가 아니라 식 안(CASE, FILTER)에서 고르면 보지 않는다. 그 SQL 은 WHERE 로 한 해를 고르고 반기는 식 안에서 따로 셌는데
 * 두 조건을 합쳐 「1, 2, 3, 4분기만 고른다」며 거부했다. 그해 전체(LIKE 'YYYY-%')와 그 안의 분기를 함께 고르면 분기 값으로 본다.
 * 사유는 고른 분기가 반기를 모두 담으면 반기 밖의 분기만 적는다(반기를 담은 분기 묶음을 「만 고른다」고 적지 않는다). */
function checkHalfYear(sql: string, question: string, now: Date): string[] {
  if (QUARTER_OR_MONTH.test(question)) return [];
  const thisYear = seoulYear(now);
  const want = new Map<number, Set<number>>();
  const halves = new Map<number, string[]>();
  const bound = [...question.matchAll(HALF_RE)];
  if (bound.length !== (question.match(/[상하]반기/g) ?? []).length) return [];
  for (const m of bound) {
    const year = m[1] ? Number(m[1]) : thisYear + (RELATIVE_YEAR[m[2]] ?? 0);
    if (!want.has(year)) want.set(year, new Set());
    for (const q of HALF[m[3]].quarters) want.get(year)!.add(q);
    halves.set(year, [...(halves.get(year) ?? []), HALF[m[3]].name]);
  }
  if (!want.size) return [];
  const wholeAsked = WHOLE_YEAR_WORD.test(question);
  // 반기가 붙지 않은 연도 낱말: 그해 전체를 묻는다.
  const whole = new Set<number>();
  for (const m of question.matchAll(YEAR_WORD)) {
    if (/^\s*(?:의\s*)?[상하]반기/.test(question.slice((m.index ?? 0) + m[0].length))) continue;
    whole.add(m[1] ? Number(m[1]) : thisYear + (RELATIVE_YEAR[m[2]] ?? 0));
  }
  const masked = maskSql(sql);
  if (masked === null) return [];
  const col = `(?<![A-Za-z0-9_$])(?:[A-Za-z_][A-Za-z0-9_]*\\.)?quarter`;
  // 한 해 안의 분기 범위(quarter BETWEEN '2024-Q3' AND '2024-Q4')는 그 분기들을 고른 것으로 읽는다. 그 밖의 크기 비교는 판정하지 않는다.
  const ranges = [...sql.matchAll(new RegExp(`${col}\\s+between\\s+'(\\d{4})-Q([1-4])'\\s+and\\s+'(\\d{4})-Q([1-4])'`, "gi"))];
  if (ranges.some((m) => m[1] !== m[3] || Number(m[2]) > Number(m[4]))) return [];
  const rest = ranges.reduce((s, m) => s.replace(m[0], " "), sql);
  if (new RegExp(`${col}\\s*(?:<|>|between\\b|i?like\\s*'(?!\\d{4}-(?:Q[1-4]|%)')[^']*')`, "i").test(rest)) return [];
  const spans = exprSpans(masked);
  const inExpr = (at: number) => spans.some(([s, e]) => at >= s && at < e);
  const inside = new Set<number>();
  // 식 안(CASE, FILTER)에서 고른 분기. 반기를 식 안에서 세더라도 그 분기는 반기의 두 분기여야 한다: 「2024년 하반기 매출은 2024년 연간
  // 매출의 몇 퍼센트야?」에 CASE WHEN quarter = '2024-Q3' 만 세어 17.03% 를 답했다(하반기는 3, 4분기. 4차 수정 실측 2026-10-08).
  // 한 해의 두 반기를 함께 물으면(「상반기와 하반기」) ELSE 가 다른 반기를 셀 수 있어 보지 않는다.
  const insideQ = new Map<number, { quarters: Set<number>; conds: string[] }>();
  const got = new Map<number, { quarters: Set<number>; wide: boolean; conds: string[] }>();
  const pick = (at: number, cond: string, year: number, quarters: number[] | null) => {
    if (inExpr(at)) {
      inside.add(year);
      if (quarters) {
        if (!insideQ.has(year)) insideQ.set(year, { quarters: new Set(), conds: [] });
        for (const q of quarters) insideQ.get(year)!.quarters.add(q);
        insideQ.get(year)!.conds.push(cond.replace(/\s+/g, " "));
      }
      return;
    }
    if (!got.has(year)) got.set(year, { quarters: new Set(), wide: false, conds: [] });
    const g = got.get(year)!;
    if (quarters) for (const q of quarters) g.quarters.add(q);
    else g.wide = true;
    g.conds.push(cond.replace(/\s+/g, " "));
  };
  for (const m of sql.matchAll(new RegExp(`${col}\\s*(?:=|i?like)\\s*'(\\d{4})-(?:Q([1-4])|%)'`, "gi"))) {
    pick(m.index ?? 0, m[0], Number(m[1]), m[2] ? [Number(m[2])] : null);
  }
  for (const m of sql.matchAll(new RegExp(`${col}\\s+in\\s*\\(([^()]*)\\)`, "gi"))) {
    for (const v of m[1].matchAll(/'(\d{4})-Q([1-4])'/g)) pick(m.index ?? 0, m[0], Number(v[1]), [Number(v[2])]);
  }
  for (const m of ranges) {
    const [from, to] = [Number(m[2]), Number(m[4])];
    pick(m.index ?? 0, m[0], Number(m[1]), Array.from({ length: to - from + 1 }, (_, i) => from + i));
  }
  const reasons: string[] = [];
  for (const [year, quarters] of want) {
    const iq = insideQ.get(year);
    const asked = [...quarters].sort();
    const g = got.get(year);
    const before = reasons.length;
    if (iq && halves.get(year)!.length === 1 && (asked.some((q) => !iq.quarters.has(q)) || [...iq.quarters].some((q) => !quarters.has(q)))) {
      const list = asked.map((q) => `'${year}-Q${q}'`).join(", ");
      reasons.push(
        `${PERIOD_REASON}${[...new Set(iq.conds)].join(", ")} 은 ${year}년 ${[...iq.quarters].sort().join(", ")}분기만 고른다. ` +
          `질문의 ${year}년 ${halves.get(year)!.join(", ")}는 ${asked.join(", ")}분기다. 식 안(CASE, FILTER)에서도 quarter IN (${list}) 로 그 분기를 모두 센다`,
      );
    }
    // 그해 전체도 묻는데(「… 2024년 연간 매출의 몇 퍼센트야?」) WHERE 가 그해의 일부 분기만 남기면 전체를 셀 수 없다: quarter BETWEEN
    // '2024-Q3' AND '2024-Q4' 안에서 4분기를 나눠 65.10% 를 답했다(하반기의 연간 비중은 48.79%. 4차 수정본 실측 R1). 하위 질의가 있으면
    // 전체를 따로 셀 수 있어 보지 않는다.
    if (g && (wholeAsked || whole.has(year)) && !g.wide && g.quarters.size > 0 && g.quarters.size < 4 && !/\(\s*select\b/i.test(masked)) {
      const list = asked.map((q) => `'${year}-Q${q}'`).join(", ");
      reasons.push(
        `${PERIOD_REASON}${[...new Set(g.conds)].join(", ")} 은 ${year}년 ${[...g.quarters].sort().join(", ")}분기만 남긴다. 질문은 ${year}년 전체도 묻는다. ` +
          `WHERE 는 ${year}년 전체(quarter LIKE '${year}-%' 나 sale_date 범위)로 고르고 ${halves.get(year)!.join(", ")}는 식 안(CASE, FILTER)에서 quarter IN (${list}) 로 센다`,
      );
    }
    if (reasons.length > before) continue;
    if (!g || wholeAsked || whole.has(year) || inside.has(year)) continue;
    // 그해 전체(LIKE 'YYYY-%')와 그 안의 분기를 함께 고르면 행은 그 분기들이다.
    const picked = g.quarters.size ? [...g.quarters].sort() : g.wide ? [1, 2, 3, 4] : [];
    const missing = asked.filter((q) => !picked.includes(q));
    const extra = picked.filter((q) => !quarters.has(q));
    if (!missing.length && (!extra.length || DATE_NARROWING.test(sql))) continue;
    const list = asked.map((q) => `'${year}-Q${q}'`).join(", ");
    const conds = [...new Set(g.conds)].join(", ");
    const name = halves.get(year)!.join(", ");
    reasons.push(
      missing.length
        ? `${PERIOD_REASON}${conds} 은 ${year}년 ${picked.join(", ")}분기만 고른다. ` +
            `질문의 ${year}년 ${name}는 ${asked.join(", ")}분기다. quarter IN (${list}) 이나 sale_date 범위로 그 분기를 모두 고른다`
        : `${PERIOD_REASON}${conds} 은 ${year}년 ${name}(${asked.join(", ")}분기) 밖의 ${extra.join(", ")}분기도 고른다. ` +
            `질문의 ${year}년 ${name}는 ${asked.join(", ")}분기다. quarter IN (${list}) 이나 sale_date 범위로 그 분기만 고른다`,
    );
  }
  return reasons;
}

/** 값 조건 사유의 머리말. untrustedAnswer 가 이것으로 사유를 가른다. */
const ENUM_REASON = "값 조건 ";

/** 표 → 열 → 그 열에 쓸 수 있는 값. */
export type TableEnums = ReadonlyMap<string, ReadonlyMap<string, readonly string[]>>;
/** 스키마마다 값 어휘를 적은 카드(nl2sql.ts 한 줄 카드의 `열['값'|'값']`). 카드의 값은 데이터의 값과 같다(2026-10-08 DISTINCT 대조).
 * 여기 없는 스키마(smoke 의 public, bench)는 값 어휘를 보지 않는다. */
const ENUM_CARDS = new Map<string, string>([["companyx", COMPANYX_SCHEMA_DDL]]);
const enumCache = new Map<string, TableEnums>();

export function enumColumns(schema: string): TableEnums {
  const hit = enumCache.get(schema);
  if (hit) return hit;
  const out = new Map<string, Map<string, string[]>>();
  for (const line of (ENUM_CARDS.get(schema) ?? "").split("\n")) {
    const table = /^\s*\w+\.(\w+)\(/.exec(line)?.[1];
    if (!table) continue;
    for (const m of line.matchAll(/(\w+)\[((?:'[^']*'\|?)+)\]/g)) {
      if (!out.has(table)) out.set(table, new Map());
      out.get(table)!.set(m[1], [...m[2].matchAll(/'([^']*)'/g)].map((v) => v[1]));
    }
  }
  enumCache.set(schema, out);
  return out;
}

/** ⑥ 값 어휘가 정해진 열(상태, 분류, 우선순위, 규모, 계약 유형)을 어휘에 없는 문자열과 같다고 비교하면(=, IN) 그 조건은 행을
 * 하나도 고르지 않는다. 「현재 진행 중인 계약 수는 몇 개야?」에 7B 가 프로젝트와 티켓의 값 'in_progress' 를 계약에 써 「0개」를
 * 답했다(계약 상태는 active, completed, cancelled 뿐. 랜덤 테스트 사전 점검 3차 V13, 3/3). 사유는 그 열에 쓸 수 있는 값을 말한다
 * (수리 안내가 된다). 열의 표는 별칭이나 표 이름으로 정하고, 표를 붙이지 않은 열은 문장에 나온 표 가운데 그 열이 있는 표로 정한다
 * (둘 이상이면 어느 표의 값이든 있으면 통과). 어느 표인지 모르는 열, 식(LOWER(status)), 확실히 읽지 못하는 문장, 값 어휘를 모르는
 * 스키마는 판정하지 않는다. 다르다는 비교(<>, !=, NOT IN)는 어휘 밖의 값이면 모든 행을 남겨 해가 없어 보지 않는다. 「취소되지 않은
 * 프로젝트는 몇 개야?」의 status <> 'cancelled' 는 프로젝트 40개 그대로가 맞는 답인데 거부했다. */
export function checkEnum(sql: string, enums: TableEnums): string[] {
  const reasons: string[] = [];
  for (const c of enumConditions(sql, enums)) {
    const allowed = [...new Set(c.tables.flatMap((t) => enums.get(t)!.get(c.col)!))];
    const bad = c.values.filter((v) => !allowed.includes(v));
    if (!bad.length) continue;
    reasons.push(
      `${ENUM_REASON}${c.cond} 의 ${bad.map((v) => `'${v}'`).join(", ")} 은 ${c.tables.map((t) => `${t}.${c.col}`).join(", ")} 에 없는 값이다. ` +
        `쓸 수 있는 값: ${allowed.map((v) => `'${v}'`).join(", ")}`,
    );
  }
  return reasons;
}

/** 값 어휘 열에 건 같다는 조건(=, IN) 하나: 조건 원문(공백 하나로), 열, 그 열이 있을 수 있는 표, 문자열 값. */
interface EnumCondition {
  cond: string;
  col: string;
  tables: string[];
  values: string[];
}

/** 생성 SQL 의 값 어휘 열 조건(=, IN. negative 면 <>, !=, NOT IN). 표는 별칭이나 표 이름으로, 표를 붙이지 않은 열은 문장에 나온 표
 * 가운데 그 열이 있는 표로 정한다. 어느 표인지 모르는 열, 식, 확실히 읽지 못하는 문장은 넣지 않는다. */
function enumConditions(sql: string, enums: TableEnums, negative = false): EnumCondition[] {
  if (!enums.size) return [];
  const masked = maskSql(sql);
  if (masked === null) return [];
  const cols = [...new Set([...enums.values()].flatMap((m) => [...m.keys()]))];
  const alias = aliasTables(masked, new Set(enums.keys()));
  const inSql = [...new Set([...alias.values()].flatMap((s) => [...s]))];
  const ref = `(?<![A-Za-z0-9_$.])((?:${IDENT}\\.){0,2}(?:${cols.join("|")}))(?![A-Za-z0-9_$])`;
  const out: EnumCondition[] = [];
  const add = (m: RegExpMatchArray, lits: [number, number][]) => {
    const parts = m[1].toLowerCase().split(".");
    const col = parts[parts.length - 1];
    const owner = parts.length > 1 ? alias.get(parts[parts.length - 2]) : new Set(inSql);
    const tables = [...(owner ?? [])].filter((t) => enums.get(t)?.has(col));
    if (!tables.length) return;
    const cond = sql.slice(m.index, (m.index ?? 0) + m[0].length).replace(/\s+/g, " ");
    out.push({ cond, col, tables, values: lits.map(([s, e]) => sql.slice(s, e).replace(/''/g, "'")) });
  };
  for (const m of masked.matchAll(new RegExp(`${ref}\\s*${negative ? "(?:<>|!=)" : "="}\\s*'( *)'`, "gi"))) {
    const end = (m.index ?? 0) + m[0].length - 1;
    add(m, [[end - m[2].length, end]]);
  }
  for (const m of masked.matchAll(new RegExp(`${ref}\\s+${negative ? "not\\s+in" : "in"}\\s*\\(\\s*'( *)'(?:\\s*,\\s*'( *)')*\\s*\\)`, "gi"))) {
    const open = (m.index ?? 0) + m[0].indexOf("(");
    const list = masked.slice(open + 1, (m.index ?? 0) + m[0].length - 1);
    add(m, [...list.matchAll(/'( *)'/g)].map((v) => [open + 2 + (v.index ?? 0), open + 2 + (v.index ?? 0) + v[1].length]));
  }
  return out;
}

/** 값 어휘마다 그 값을 가리키는 질문 낱말(정규식 조각, 카드의 대응과 랜덤 테스트 실측 문장). 열 이름이나 그 열 전체를 가리키는 낱말은
 * "" 에 둔다. 영문 값 자체(「active인 것만」, 「Critical 우선순위」)는 따로 본다. 스키마마다 둔다(값 어휘 카드와 같은 방식). */
const ENUM_WORDS = new Map<string, Readonly<Record<string, Readonly<Record<string, string>>>>>([
  [
    "companyx",
    {
      "clients.company_size": {
        "": "규모|크기",
        startup: "스타트업|신생|소규모|소기업|작은",
        mid: "중견|중소|중형|중규모|중간\\s*규모|미드",
        enterprise: "대기업|대형|대규모|엔터프라이즈|큰",
      },
      "products.category": { "": "분류|카테고리|종류|부문|분야|솔루션", cloud: "클라우드", security: "보안", data: "데이터", consulting: "컨설팅" },
      "sales.category": { "": "분류|카테고리|종류|부문|분야|솔루션", cloud: "클라우드", security: "보안", data: "데이터", consulting: "컨설팅" },
      "products.status": { "": "상태|현황|중인|현재|단종|판매\\s*중지|출시\\s*전", active: "활성|판매|출시|정식|사용|운영|서비스", beta: "베타|시범|테스트|시험" },
      "contracts.contract_type": {
        "": "유형|종류|형태|방식|타입",
        subscription: "구독",
        project: "프로젝트|구축|일회",
        maintenance: "유지\\s*보수|유지\\s*관리|정비|보수",
      },
      "contracts.status": {
        "": "상태|현황|중인|현재|보류|대기",
        active: "활성|진행|유효|살아|유지\\s*중|운영\\s*중|계약\\s*중",
        completed: "완료|종료|끝|만료|마친|마감|종결",
        cancelled: "취소|해지|해약|철회|파기",
      },
      "projects.status": {
        "": "상태|현황|중인|현재",
        planning: "계획|기획|준비|예정|착수\\s*전",
        in_progress: "진행|수행|작업\\s*중|하고\\s*있",
        completed: "완료|종료|끝|마친|마무리|마감",
        on_hold: "보류|중단|중지|멈|대기|홀드|정지",
      },
      "support_tickets.priority": {
        "": "우선\\s*순위|중요도|긴급도",
        critical: "긴급|치명|심각|크리티컬|최우선",
        high: "높|하이|중요",
        medium: "중간|보통|미디엄",
        low: "낮|로우",
      },
      "support_tickets.status": {
        "": "상태|현황|중인|현재|미해결|미처리|해결\\s*안|해결되지|처리\\s*안|처리되지|남은|남아",
        open: "접수|열린|열려|오픈|신규|대기",
        in_progress: "처리\\s*중|진행|작업\\s*중|대응\\s*중",
        resolved: "해결|처리\\s*완료|처리된|처리됨",
        closed: "종결|종료|닫힌|닫혀|완료|마감",
      },
    },
  ],
]);

/** 표마다 이름이 다른 같은 상태(끝난 계약과 해결되거나 종결된 티켓, 진행 중인 계약과 프로젝트). 질문이 말한 상태가 그 표에 없는지 볼 때
 * 같은 상태로 친다: 「아직 안 끝난 critical 티켓」의 끝은 계약과 프로젝트의 completed 낱말이지만 티켓에는 resolved, closed 가 있다. */
const SAME_STATE = new Map<string, readonly (readonly string[])[]>([
  ["companyx", [["completed", "resolved", "closed"], ["active", "in_progress", "open"]]],
]);

/** 값에 순서가 있어 「…하지 않은」이 나머지 값 모두를 뜻하지 않는 열(「중요하지 않은 티켓」은 critical 을 담지 않는다). */
const ORDINAL_COLUMNS = new Map<string, ReadonlySet<string>>([["companyx", new Set(["priority"])]]);

/** 질문이 그 값을 말하는가: 영문 값(밑줄은 띄어 써도) 또는 그 값의 우리말 낱말. value 가 "" 면 그 열 전체를 가리키는 낱말. */
function saysValue(question: string, words: Readonly<Record<string, string>> | undefined, value: string): boolean {
  const ko = words?.[value];
  if (ko && new RegExp(ko, "i").test(question)) return true;
  return value !== "" && new RegExp(`(?<![A-Za-z])${value.replace(/_/g, "[_ ]?")}(?![A-Za-z])`, "i").test(question);
}

/** 값 낱말 바로 뒤의 부정: 「취소되지 않은」, 「완료 안 된」, 「끝나지 않은」, 「활성 상태가 아닌」, 「취소된 것 제외」. */
const NEG_AFTER =
  /^[가-힣]{0,2}\s*(?:지\s*(?:않|못)|안\s*(?:된|한))|^\s*(?:상태\s*)?(?:이|가)?\s*아닌|^[가-힣]{0,2}\s*(?:(?:것|건)\s*)?(?:을|를)?\s*(?:제외|빼고|말고|이외|외의)/;
/** 값 낱말 바로 앞의 부정: 「안 끝난」, 「미완료」. */
const NEG_BEFORE = /(?<![가-힣])(?:안|못)\s*$|(?<![가-힣])미$/;

/** 질문이 그 열의 값을 긍정으로 말했는지(pos), 부정으로 말했는지(neg). 같은 이름의 열 모두의 낱말과 영문 값을 본다. */
function valueMentions(
  question: string,
  words: Readonly<Record<string, Readonly<Record<string, string>>>>,
  col: string,
  vocab: readonly string[],
): { pos: Set<string>; neg: Set<string> } {
  const pos = new Set<string>();
  const neg = new Set<string>();
  const see = (value: string, re: RegExp) => {
    for (const m of question.matchAll(re)) {
      const at = m.index ?? 0;
      const negated = NEG_AFTER.test(question.slice(at + m[0].length)) || NEG_BEFORE.test(question.slice(0, at));
      (negated ? neg : pos).add(value);
    }
  };
  for (const [tc, w] of Object.entries(words)) {
    if (!tc.endsWith(`.${col}`)) continue;
    for (const [value, ko] of Object.entries(w)) if (value !== "") see(value, new RegExp(ko, "gi"));
  }
  for (const value of vocab) see(value, new RegExp(`(?<![A-Za-z])${value.replace(/_/g, "[_ ]?")}(?![A-Za-z])`, "gi"));
  return { pos, neg };
}

/** 질문에 없는 조건 사유의 머리말. untrustedAnswer 가 이것으로 사유를 가른다. */
const UNASKED_REASON = "질문에 없는 조건 ";
/** 데이터에 없는 상태 사유의 머리말. */
const ABSENT_REASON = "없는 상태 ";
/** 표의 상태 열 어휘에 없는 상태를 가리키는 질문 낱말과 그 표를 가리키는 말(스키마마다). 제품 상태는 active, beta 뿐이다. */
const ABSENT_STATES = new Map<string, readonly { table: string; col: string; subject: string; words: string }[]>([
  ["companyx", [{ table: "products", col: "status", subject: "제품|상품|프로덕트|product", words: "단종|판매\\s*(?:중지|중단|종료)|생산\\s*(?:중지|중단|종료)" }]],
]);

/** ⑥-5 질문이 표의 상태 열에 없는 상태(「판매 중지된 제품」, 「단종된 제품」)를 물으면 어떤 SQL 도 그 상태를 고를 수 없다. 다른 표의 상태(계약의
 * status = 'cancelled')를 그 상태로 쓰면 취소 계약의 제품 6개를 판매 중지 목록으로 답했다(랜덤 테스트 사전 점검 5차 P10, FV09 3/3). 그 열을 어휘 밖
 * 값으로 고른 SQL 은 checkEnum 이 값 목록으로 답하므로(4차 KF07) 여기서는 보지 않는다. */
export function checkAbsentState(sql: string, question: string, enums: TableEnums, schema: string): string[] {
  for (const s of ABSENT_STATES.get(schema) ?? []) {
    const m = new RegExp(s.words).exec(question);
    if (!m || !new RegExp(s.subject, "i").test(question)) continue;
    const vocab = enums.get(s.table)?.get(s.col) ?? [];
    const conds = [...enumConditions(sql, enums), ...enumConditions(sql, enums, true)];
    if (conds.some((c) => c.tables.includes(s.table) && c.col === s.col && c.values.some((v) => !vocab.includes(v)))) return [];
    const others = conds.filter((c) => c.col === s.col);
    const what = others.length
      ? `${others.map((c) => c.cond).join(", ")} 은 그 상태가 아니다(${[...new Set(others.flatMap((c) => c.tables))].map((t) => `${t}.${s.col}`).join(", ")} 의 값)`
      : `SQL 이 ${s.table}.${s.col} 로 거르지 않는다`;
    return [
      `${ABSENT_REASON}질문이 말한 상태 '${m[0].replace(/\s+/g, " ")}' 는 ${s.table}.${s.col} 에 없는 값이다(쓸 수 있는 값: ${vocab.map((v) => `'${v}'`).join(", ")}). ` +
        `${what}. 그 상태의 행은 데이터에 없다`,
    ];
  }
  return [];
}

/** ⑥-2 값 어휘 열에 건 같다는 조건(=, IN)인데 질문에 그 열을 가리키는 말(값, 값의 우리말, 열의 우리말)이 하나도 없으면 질문이
 * 묻지 않은 조건이다. 「서울 고갱사는 몇 곳이야?」에 7B 가 company_size = 'mid' 를 붙여 1곳이라고 답했다(서울 고객사는 4곳. 랜덤
 * 테스트 사전 점검 4차 P13, SF03 6회 모두 같은 조건). 사유는 그 조건을 빼라고 말한다(수리 안내가 된다). 열 전체를 보므로 부정과
 * 여집합(「아직 해결되지 않은 건」의 status IN ('open', 'in_progress'))도 말한 것으로 친다. 같은 이름의 열(상태는 계약, 프로젝트,
 * 제품, 티켓)의 낱말을 함께 보고, 어휘 밖의 값이 든 조건은 checkEnum 이 맡는다(「취소된 프로젝트 목록」의 status = 'cancelled' 는
 * 질문이 말한 조건이다. 빼라고 하면 수리가 프로젝트 전체를 취소 목록처럼 낸다). 낱말을 두지 않은 스키마는 보지 않는다. */
export function checkUnaskedEnum(sql: string, question: string, enums: TableEnums, schema: string): string[] {
  const words = ENUM_WORDS.get(schema);
  if (!words) return [];
  const reasons: string[] = [];
  const alike = (v: string) => [v, ...(SAME_STATE.get(schema) ?? []).filter((g) => g.includes(v)).flat()];
  const conds = [...enumConditions(sql, enums).map((c) => ({ ...c, negative: false })), ...enumConditions(sql, enums, true).map((c) => ({ ...c, negative: true }))];
  for (const c of conds) {
    const vocab = [...new Set([...enums.values()].flatMap((cols) => cols.get(c.col) ?? []))];
    if (c.values.some((v) => !c.tables.some((t) => enums.get(t)?.get(c.col)?.includes(v)))) {
      // 어휘 밖 값은 checkEnum 이 맡는다. 다만 질문이 그 열의 값을 부정하면(「종료되지 않은 계약」) 여집합 조건을 함께 적는다. 값 목록 사유만으로는
      // 수리가 티켓 상태('open', 'in_progress')를 다시 계약에 썼다(랜덤 테스트 사전 점검 5차 P10, FV15 3/3. completed 가 아닌 계약은 56건).
      if (c.negative || ORDINAL_COLUMNS.get(schema)?.has(c.col)) continue;
      const own = [...new Set(c.tables.flatMap((t) => enums.get(t)?.get(c.col) ?? []))];
      const { neg, pos } = valueMentions(question, words, c.col, vocab);
      const negOwn = own.filter((x) => [...neg].some((v) => alike(v).includes(x)));
      const posOwn = own.filter((x) => [...pos].some((v) => alike(v).includes(x)) && !negOwn.includes(x));
      if (!negOwn.length || posOwn.length) continue;
      const tc = c.tables.map((t) => `${t}.${c.col}`).join(", ");
      const ref = /^\s*((?:[A-Za-z_][A-Za-z0-9_]*\.)*[A-Za-z_][A-Za-z0-9_]*)/.exec(c.cond)?.[1] ?? c.col;
      const not = negOwn.length === 1 ? `${ref} <> '${negOwn[0]}'` : `${ref} NOT IN (${negOwn.map((v) => `'${v}'`).join(", ")})`;
      reasons.push(
        `${UNASKED_REASON}${c.cond} 은 질문이 묻지 않은 조건이다(질문은 ${tc} 가 ${negOwn.map((v) => `'${v}'`).join(", ")} 이 아닌 행을 묻는데 ` +
          `이 조건은 ${tc} 에 없는 값을 고른다). ${not} 로 거른다`,
      );
      continue;
    }
    const own = [...new Set(c.tables.flatMap((t) => enums.get(t)?.get(c.col) ?? []))];
    const tc = c.tables.map((t) => `${t}.${c.col}`).join(", ");
    const { pos, neg } = valueMentions(question, words, c.col, vocab);
    const named = new Set([...pos, ...neg]);
    // 질문이 말한 상태가 이 표의 열에 하나도 없으면(「취소되지 않은 프로젝트는 몇 개야?」의 취소는 계약 상태다) 질문이 말하지 않은 값을
    // 고르거나 빼는 조건은 질문의 상태를 다른 상태로 바꾼 것이다. status = 'completed' 로 6개를 세고 「알 수 없습니다」라고 답했고, 「이
    // 조건을 빼고」라고 안내하자 수리가 status != 'completed' 로 34개를 셌다(프로젝트 40개 모두가 답이다. 4차 수정본 실측 R2).
    const ownSaid = c.values.some((v) => c.tables.some((t) => saysValue(question, words[`${t}.${c.col}`], v)));
    if (named.size && [...named].every((v) => !alike(v).some((x) => own.includes(x))) && !ownSaid) {
      const absent = [...(neg.size ? neg : named)];
      reasons.push(
        `${UNASKED_REASON}${c.cond} 은 질문이 묻지 않은 조건이다(질문이 말한 상태 ${absent.map((v) => `'${v}'`).join(", ")} 는 ` +
          `${tc} 에 없는 값이다. 쓸 수 있는 값: ${own.map((v) => `'${v}'`).join(", ")}). ` +
          (neg.size
            ? `질문은 그 상태가 아닌 것을 묻는다: ${c.col} <> '${absent[0]}' 로 거른다(그 값이 없으니 모든 행이다)`
            : `질문은 그 상태를 묻는다: ${tc} 에 그 값이 없으니 조건에 맞는 행은 0건이다`),
      );
      continue;
    }
    // 질문이 그 열의 값을 부정하면(「완료되지 않은 프로젝트」) 그 값이 아닌 값을 모두 골라야 한다. 남은 값 가운데 일부만 고르거나(status =
    // 'on_hold' 로 10개, 답은 34개. 4차 수정본 실측 N3) 부정한 값을 고르면 질문과 다르다. 질문이 긍정으로 말한 값을 고르면 보지 않는다
    // (「완료되지 않은 프로젝트 중 진행 중인 것」). 순서가 있는 열(우선순위)은 「중요하지 않은」이 여집합이 아니라 보지 않는다.
    const negOwn = own.filter((x) => [...neg].some((v) => alike(v).includes(x)));
    if (!c.negative && negOwn.length && !ORDINAL_COLUMNS.get(schema)?.has(c.col)) {
      const rest = own.filter((x) => !negOwn.includes(x));
      const picksNegated = c.values.some((v) => negOwn.includes(v));
      const partial = rest.some((x) => !c.values.includes(x));
      const posSaid = c.values.some((v) => [...pos].some((p) => alike(p).includes(v)));
      if ((picksNegated || partial) && !posSaid) {
        const not = negOwn.length === 1 ? `${c.col} <> '${negOwn[0]}'` : `${c.col} NOT IN (${negOwn.map((v) => `'${v}'`).join(", ")})`;
        reasons.push(
          `${UNASKED_REASON}${c.cond} 은 질문이 묻지 않은 조건이다(질문은 ${tc} 가 ${negOwn.map((v) => `'${v}'`).join(", ")} 이 아닌 행을 묻는데 ` +
            `${picksNegated ? "이 조건은 그 값을 고른다" : `이 조건은 그 가운데 ${c.values.map((v) => `'${v}'`).join(", ")} 만 고른다`}). ${not} 로 거른다`,
        );
        continue;
      }
    }
    if (c.negative) continue;
    const said = Object.entries(words)
      .filter(([tc]) => tc.endsWith(`.${c.col}`))
      .some(([, w]) => Object.keys(w).some((v) => saysValue(question, w, v)));
    if (said || vocab.some((v) => saysValue(question, undefined, v))) continue;
    reasons.push(
      `${UNASKED_REASON}${c.cond} 은 질문이 묻지 않은 조건이다(질문에 ${c.tables.map((t) => `${t}.${c.col}`).join(", ")} 을 가리키는 말이 없다). ` +
        "그 조건을 빼고 질문이 말한 조건만 건다",
    );
  }
  return reasons;
}

/** 날짜 열마다 그 열을 가리키는 질문 낱말. 여기 없는 날짜 열은 일반 낱말만 본다. */
const DATE_COLUMN_WORDS: Readonly<Record<string, string>> = {
  // 맨 「종료」, 「끝」은 상태(completed)의 말이라 날짜를 가리키지 않는다. 「끝나지 않은 계약은 몇 건이야?」의 수리가 end_date IS NULL 을 남겨 0건을
  // 답했다(56건, 랜덤 테스트 사전 점검 5차 P10 수정본 실측).
  end_date: "종료\\s*(?:일|날|예정|시점|시기)|끝나는\\s*날|끝난\\s*날|끝\\s*날|만료|마감|기한|기간",
  start_date: "시작|착수|개시|기간",
  resolved_at: "해결|처리|완료|종결|닫",
  registered_at: "등록|가입",
  hire_date: "입사|채용",
  created_at: "생성|등록|접수|만든|만들",
};
/** 날짜가 있는지 없는지를 묻는 일반 낱말. */
const DATE_PRESENCE_WORDS = /날짜|일자|언제|정해지|정해진|미정|비어|빈\s|없는|없이|기록|null/i;

/** ⑥-3 날짜 열이 비었는지(IS NULL, IS NOT NULL)를 거는데 질문에 그 날짜를 가리키는 말이 없으면 질문이 묻지 않은 조건이다. 「현재 진행 중인 계약
 * 수는 몇 개야?」에 7B 가 status = 'active' 에 end_date IS NULL 을 붙여 6회 중 1회 다른 수를 냈다(랜덤 테스트 사전 점검 3차 V13). 「종료일이
 * 정해지지 않은 프로젝트」처럼 그 날짜나 날짜가 없음을 말하면 보지 않는다. 사유는 그 조건을 빼라고 말한다(수리 안내가 된다). */
export function checkUnaskedNull(sql: string, question: string): string[] {
  const masked = maskSql(sql);
  if (masked === null) return [];
  const reasons: string[] = [];
  for (const m of masked.matchAll(/(?<![A-Za-z0-9_$.])((?:[A-Za-z_][A-Za-z0-9_]*\.)?([A-Za-z_][A-Za-z0-9_]*(?:_date|_at)))\s+is\s+(?:not\s+)?null\b/gi)) {
    const col = m[2].toLowerCase();
    const words = DATE_COLUMN_WORDS[col];
    if (DATE_PRESENCE_WORDS.test(question) || (words && new RegExp(words).test(question))) continue;
    const cond = sql.slice(m.index ?? 0, (m.index ?? 0) + m[0].length).replace(/\s+/g, " ");
    reasons.push(`${UNASKED_REASON}${cond} 은 질문이 묻지 않은 조건이다(질문에 ${col} 을 가리키는 말이 없다). 그 조건을 빼고 질문이 말한 조건만 건다`);
  }
  return reasons;
}

/** 기간 길이 사유의 머리말. */
const LENGTH_REASON = "기간 길이 ";
/** 「계약 기간이 1년 넘는」, 「프로젝트 기간이 6개월 이상인」: 시작일과 종료일 사이의 길이를 묻는 말. */
const SPAN_ASKED =
  /(?:계약|프로젝트)[^?？.。]{0,12}?기간\s*(?:이|은|는|의)?\s*(?:\d+|한|두|세|일|이|삼)\s*(?:년|개월|달|주|일)\s*(?:넘|이상|초과|보다|이하|미만|이내|안\s*되|짧|길)/;

/** ⑥-4 기간의 길이를 묻는 질문의 꼴.
 *  ① 평균 근속처럼 사람(행)마다의 기간을 평균하는데 AVG 안에서 햇수를 내리면(AVG(EXTRACT(YEAR FROM AGE(…)))) 3년 11개월이 3년으로 들어간다.
 *     「직원들의 평균 근속 기간은 몇 년이야?」를 3.31년으로 답했다(일 단위 평균은 3.77년. 랜덤 테스트 사전 점검 5차 P3, DT12 3/3).
 *  ② 계약, 프로젝트의 기간(「계약 기간이 1년 넘는」)은 종료일 - 시작일인데 생성 SQL 이 시작일을 쓰지 않으면 길이가 아니다. 「계약 기간이 1년 넘는
 *     계약은 몇 건이야?」에 end_date < CURRENT_DATE + INTERVAL '1 year' 로 62건을 세고 「알 수 없습니다」라고 답했다(end_date - start_date > 365 는
 *     41건, DT07 3/3). 근속 연수처럼 한 날짜에서 오늘까지를 재는 질문(EXTRACT(YEAR FROM AGE(hire_date)) >= 5)은 맞아 보지 않는다. */
export function checkPeriodLength(sql: string, question: string): string[] {
  const masked = maskSql(sql);
  if (masked === null) return [];
  const reasons: string[] = [];
  if (/평균/.test(question)) {
    const floored = /\bavg\s*\(\s*(?:\(\s*)*(?:cast\s*\(\s*)?(?:extract\s*\(\s*years?\s+from\s+age\s*\(|date_part\s*\(\s*'years?'\s*,\s*age\s*\()/gi;
    for (const m of masked.matchAll(floored)) {
      const at = m.index ?? 0;
      let depth = 0;
      let end = at + m[0].indexOf("(");
      for (; end < masked.length; end++) {
        if (masked[end] === "(") depth++;
        else if (masked[end] === ")" && --depth === 0) break;
      }
      const expr = sql.slice(at, end + 1).replace(/\s+/g, " ");
      // AGE(끝, 시작) 이면 두 날짜의 차, AGE(날짜) 나 AGE(CURRENT_DATE, 날짜) 면 오늘까지의 차로 적는다.
      const args = /\bage\s*\(\s*([^,()]+?)\s*(?:,\s*([^,()]+?)\s*)?\)/i.exec(sql.slice(at, end + 1));
      const span = !args
        ? "CURRENT_DATE - hire_date"
        : args[2] === undefined
          ? `CURRENT_DATE - ${args[1]}`
          : /^current_date$/i.test(args[1])
            ? `CURRENT_DATE - ${args[2]}`
            : `${args[1]} - ${args[2]}`;
      reasons.push(
        `${LENGTH_REASON}${expr} 은 행마다 햇수를 내린 뒤(3년 11개월이 3년) 평균한다. 햇수를 내리지 말고 일 단위로 평균해 년으로 바꾼다: ` +
          `AVG((${span}) / 365.25)`,
      );
    }
  }
  const span = SPAN_ASKED.exec(question);
  if (span && /\b(?:from|join)\s+(?:companyx\.)?(?:contracts|projects)\b/i.test(masked) && !(/\bend_date\b/i.test(masked) && /\bstart_date\b/i.test(masked))) {
    const label = (span[0] + (/^[가-힣]*/.exec(question.slice((span.index ?? 0) + span[0].length))?.[0] ?? "")).replace(/^[^기]*/, "");
    reasons.push(
      `${LENGTH_REASON}질문의 「${label}」는 시작일부터 종료일까지의 길이인데 SQL 이 시작일과 종료일의 차를 쓰지 않는다(한 날짜를 오늘과 견줌). ` +
        `${spanCondition(span[0])} 로 고른다(CURRENT_DATE 와 견주지 않는다)`,
    );
  }
  return reasons;
}

const KO_SMALL: Readonly<Record<string, number>> = { 한: 1, 일: 1, 두: 2, 이: 2, 세: 3, 삼: 3 };
/** 「기간이 6개월 넘는」 → end_date > start_date + INTERVAL '6 months'. 해와 주, 날은 일 수(end_date - start_date)로 견준다(1년 = 365일, 5차 DT07 의
 * 기준 41건과 같은 셈). 6개월처럼 달은 INTERVAL 로 견준다. 「6개월 넘는」 꼴로 일러 주자 7B 수리는 다시 CURRENT_DATE + INTERVAL 로 썼다(수정본 실측). */
function spanCondition(phrase: string): string {
  const m = /(\d+|한|두|세|일|이|삼)\s*(년|개월|달|주|일)\s*(넘|이상|초과|보다\s*길|이하|미만|이내|안\s*되|짧|보다)?/.exec(phrase);
  if (!m) return "end_date - start_date > 365";
  const n = /^\d+$/.test(m[1]) ? Number(m[1]) : KO_SMALL[m[1]];
  const op = /이상/.test(m[3] ?? "") ? ">=" : /이하|이내/.test(m[3] ?? "") ? "<=" : /미만|안\s*되|짧/.test(m[3] ?? "") ? "<" : ">";
  if (m[2] === "개월" || m[2] === "달") return `end_date ${op} start_date + INTERVAL '${n} months'`;
  return `end_date - start_date ${op} ${m[2] === "년" ? n * 365 : m[2] === "주" ? n * 7 : n}`;
}

/** 부정과 여집합의 말. 이런 질문은 고친 값이 질문 낱말과 다를 수 있다(「완료되지 않은 프로젝트」의 IN ('planning', 'in_progress', …)). */
const NEGATED = /지\s*않|않은|아닌|안\s*(?:된|한|끝난)|없는|제외|빼고|말고|이외|외의/;

/** 값 어휘 사유로 거부한 SQL 을 고친 SQL 이 그 열의 값을 질문이 말하지 않은 값으로 바꿨으면 그 사유. 비면 받는다.
 * 「단종된 제품 목록을 알려줘」는 products.status 에 없는 'cancelled' 를 거부한 뒤 수리가 'active' 로 바꿔 활성 제품 10개를 단종
 * 목록처럼 붙였다(랜덤 테스트 사전 점검 4차 P12, KF07 3/3. 제품 상태는 active, beta 뿐). 이때는 수리를 받지 않고 처음 사유(그 열의
 * 값 목록)로 답한다. 「현재 진행 중인 계약 수」의 'in_progress' → 'active' 는 질문의 「진행 중」이 active 를 가리켜 받는다. 부정이
 * 든 질문, 낱말을 두지 않은 스키마는 보지 않는다. */
export function repairTurnsValue(firstReasons: string[], repaired: string, question: string, enums: TableEnums, schema: string): string[] {
  const words = ENUM_WORDS.get(schema);
  if (!words || NEGATED.test(question)) return [];
  const refused = new Set(
    firstReasons.flatMap((r) => /^값 조건 .+? 은 (.+?) 에 없는 값이다\. 쓸 수 있는 값: /.exec(r)?.[1].split(", ") ?? []),
  );
  if (!refused.size) return [];
  const reasons: string[] = [];
  for (const c of enumConditions(repaired, enums)) {
    const cols = c.tables.map((t) => `${t}.${c.col}`).filter((tc) => refused.has(tc));
    if (!cols.length) continue;
    const unsaid = c.values.filter((v) => !cols.some((tc) => saysValue(question, words[tc], v)));
    if (!unsaid.length) continue;
    reasons.push(
      `${ENUM_REASON}${c.cond} 은 수리하며 바꾼 값(${unsaid.map((v) => `'${v}'`).join(", ")})이 질문이 말한 상태가 아니다. ` +
        "질문의 상태가 그 열의 어휘에 없으면 데이터에 없는 상태를 물은 것이다",
    );
  }
  return reasons;
}

/** 문법 사유의 머리말. */
const SYNTAX_REASON = "문법 ";

/** ⑨ PostgreSQL 이 읽지 못하는 생성 SQL 의 꼴. MySQL 의 `LIMIT a, b` 와 값 대신 쓴 자리표시 `?` 는 실행하면 42601 이라 「조회 자체가
 * 실패했습니다」로 답했다(랜덤 테스트 사전 점검 4차 P4: 「2025년 분기 중 매출이 가장 높은 분기와 가장 낮은 분기는?」의 LIMIT 1, 1,
 * 「그 고객사 매출은 얼마야?」의 client_id = ?, 「그 직원 연봉은 얼마야?」의 e.id = ?). 실행 전에 사유로 걸어 한 번 고치게 한다.
 * 문자열 뒤의 ?(jsonb 의 `? 'key'`), ?|, ?& 는 연산자라 보지 않는다. */
export function checkSyntax(sql: string): string[] {
  const masked = maskSql(sql);
  if (masked === null) return [];
  const reasons: string[] = [];
  for (const m of masked.matchAll(/\blimit\s+(\d+)\s*,\s*(\d+)/gi)) {
    const text = sql.slice(m.index, (m.index ?? 0) + m[0].length).replace(/\s+/g, " ");
    reasons.push(`${SYNTAX_REASON}${text} 은 MySQL 꼴이라 PostgreSQL 이 읽지 못한다(42601). PostgreSQL 에서는 LIMIT ${m[2]} OFFSET ${m[1]} 로 쓴다`);
  }
  const holes = [...masked.matchAll(/\?(?![|&?])(?!\s*')/g)].map((m) => {
    const at = m.index ?? 0;
    const left = /((?:[A-Za-z_][A-Za-z0-9_]*\.)?[A-Za-z_][A-Za-z0-9_]*\s*(?:<>|!=|<=|>=|=|<|>|\bin\s*\(|\blike)\s*)$/i.exec(masked.slice(0, at))?.[1];
    return left ? `${sql.slice(at - left.length, at).replace(/\s+/g, " ")}?` : "?";
  });
  if (holes.length) {
    reasons.push(
      `${SYNTAX_REASON}자리표시 ?(${[...new Set(holes)].join(", ")}) 는 값이 아니다(PostgreSQL 이 읽지 못한다, 42601). 생성 모델이 그 값을 몰랐다는 뜻이다. ` +
        "질문에 그 값이 있으면 그 값을 쓰고, 없으면 그 조건을 뺀다",
    );
  }
  // ON 없는 JOIN(CROSS, NATURAL 이 아님): 「경영지원팀 평균 연봉이 영업팀보다 얼마나 낮아?」의 JOIN companyx.employees e2 JOIN … 이 42601 로 끝났고 오류 수리도
  // 같은 JOIN 을 남겼다(랜덤 테스트 사전 점검 6차 P3, XC02 3/3).
  const bare = new RegExp(
    `(?<!\\b(?:cross|natural)\\s+)\\bjoin\\s+((?:${IDENT}\\.)?${IDENT}(?:\\s+(?:as\\s+)?(?!(?:on|using|join|where|group|order|limit|left|right|inner|full|cross|natural|lateral)\\b)${IDENT})?)\\s*(?=$|\\)|\\b(?:join|where|group|order|having|limit|left|right|inner|full|cross|natural|union)\\b)`,
    "gi",
  );
  const noOn = [...masked.matchAll(bare)].map((m) => `JOIN ${sql.slice((m.index ?? 0) + m[0].indexOf(m[1]), (m.index ?? 0) + m[0].indexOf(m[1]) + m[1].length)}`);
  if (noOn.length) {
    reasons.push(
      `${SYNTAX_REASON}${[...new Set(noOn)].join(", ")} 에 ON 조건이 없다(PostgreSQL 이 읽지 못한다, 42601). 외래키 열로 ON 을 잇거나, ` +
        "두 값을 견주려고 같은 표를 두 번 읽었다면 한 번만 읽고 값마다 FILTER 로 따로 집계한다",
    );
  }
  return reasons;
}

/** 비율 사유의 머리말. */
const RATIO_REASON = "나눗셈 ";
// 「몇 배」도 비율이다: 「서울 고객사 매출은 부산 고객사 매출의 몇 배야?」를 SUM / SUM 정수 나눗셈으로 「4배」라고 답했다(4.30배. 랜덤 테스트 사전 점검 6차 P3, CP11 3/3).
const RATIO_WORDS = /퍼센트|%|％|비율|비중|증감률|증가율|감소율|성장률|대비|몇\s*배|\d\s*배(?![가-힣])|배(?:야|인가|인지|나요?|로)(?![가-힣])/;
/** 정수가 아닌 값이 끼는 표시: 형 변환, 소수 상수, AVG(결과가 numeric). 문자열과 주석은 가린 문장에서 본다. */
const NOT_INTEGER = /::\s*(?:numeric|decimal|float|real|double)|\bcast\s*\(|(?<![\w.])\d+\.\d*(?!\w)|(?<![\w.])\.\d|\bavg\s*\(|\b(?:numeric|decimal|float\d?|real|double)\b/i;

/** 가린 문장의 i 자리 연산자 바로 왼쪽(dir -1) 또는 오른쪽(dir 1) 피연산자의 [시작, 끝]: 괄호 묶음(앞의 함수 이름까지), 함수 호출, 낱말 하나. */
function operand(masked: string, i: number, dir: -1 | 1): [number, number] {
  let k = i + dir;
  while (masked[k] === " " || masked[k] === "\n" || masked[k] === "\t" || masked[k] === "\r") k += dir;
  const word = (from: number, step: -1 | 1) => {
    let x = from;
    while (/[A-Za-z0-9_.]/.test(masked[x] ?? "")) x += step;
    return x;
  };
  const close = (from: number, step: -1 | 1) => {
    let depth = 0;
    for (let x = from; x >= 0 && x < masked.length; x += step) {
      if (masked[x] === (step === 1 ? "(" : ")")) depth++;
      else if (masked[x] === (step === 1 ? ")" : "(") && --depth === 0) return x;
    }
    return from;
  };
  if (dir === -1) {
    if (masked[k] !== ")") return [word(k, -1) + 1, k + 1];
    const open = close(k, -1);
    return [word(open - 1, -1) + 1, k + 1];
  }
  const w = word(k, 1);
  let p = w;
  while (masked[p] === " ") p++;
  return masked[p] === "(" ? [k, close(p, 1) + 1] : [k, w];
}

/** ⑦ 비율(퍼센트, 비중, 증감률, 대비)을 묻는데 생성 SQL 이 정수 집계(SUM, COUNT)끼리 나누고 정수가 아닌 값(형 변환, 소수 상수, AVG)이
 * 하나도 없으면 PostgreSQL 이 소수점 아래를 버린다. 「2025년 매출은 전년 대비 몇 퍼센트 감소했어?」를 (SUM - SUM) / SUM * 100 으로 써
 * 「0% 감소」라고 답했다(실제 15.53%. 랜덤 테스트 사전 점검 3차 A05, 3/3). 사유는 분자를 numeric 으로 바꾸라고 말한다. */
export function checkRatio(sql: string, question: string): string[] {
  if (!RATIO_WORDS.test(question)) return [];
  const masked = maskSql(sql);
  if (masked === null || NOT_INTEGER.test(masked)) return [];
  for (const m of masked.matchAll(/\//g)) {
    const at = m.index ?? 0;
    const [ls, le] = operand(masked, at, -1);
    const [rs, re] = operand(masked, at, 1);
    if (!/\b(?:sum|count)\s*\(/i.test(masked.slice(ls, le) + " " + masked.slice(rs, re))) continue;
    const expr = sql.slice(ls, re).replace(/\s+/g, " ");
    return [
      `${RATIO_REASON}${expr.length > 200 ? `${expr.slice(0, 200)}…` : expr} 은 정수(SUM, COUNT 의 결과)끼리 나눠 소수점 아래를 버린다` +
        `(15.53% 가 0 이 된다). 분자를 ::numeric 으로 바꿔(SUM(x)::numeric / SUM(y)) 나눈다`,
    ];
  }
  return [];
}

/** 집계 단위 사유의 머리말(「집계 」는 부푸는 조인 사유가 쓴다). */
const UNIT_REASON = "묶음 단위 ";
/** 「매출이 가장 낮았던 달」, 「티켓이 제일 많이 접수된 월」, 「몇 월에 매출이 가장 높았어?」: 달마다 모은 값을 견주는 질문. */
const MONTH_RANK =
  /(?:가장|제일)\s*(?:많|적|높|낮)[가-힣]*\s+(?:[가-힣]+\s+)?(?:달|월)(?=$|[^가-힣]|[은는이가을를에로인])|(?:몇\s*월|어느\s*(?:달|월)|무슨\s*달)[^?]*?(?:가장|제일)\s*(?:많|적|높|낮)/;
const MONTH_GROUPING = /date_trunc\s*\(\s*'month'|to_char\s*\([^)]*'[^']*(?:MM|Mon)[^']*'|extract\s*\(\s*month\b|date_part\s*\(\s*'month'/i;
/** 날짜를 글자로 바꿔 연월(앞 7자)이나 월(6번째부터 2자)을 잘라 묶는 꼴: LEFT(sale_date::text, 7), SUBSTRING(sale_date::text FROM 1
 * FOR 7), SUBSTR(CAST(sale_date AS text), 6, 2). 자르는 값에 날짜 열(…_date, …_at)이 있어야 한다. */
const MONTH_SLICE =
  /\b(?:left\s*\(((?:[^()]|\([^()]*\))*?),\s*7\s*\)|substr(?:ing)?\s*\(((?:[^()]|\([^()]*\))*?)(?:\s+from\s+1\s+for\s+7|\s*,\s*1\s*,\s*7|\s+from\s+6\s+for\s+2|\s*,\s*6\s*,\s*2)\s*\))/gi;
/** 한 건의 값을 견주는 질문: 「어느 달에 계약한 건이 금액이 가장 높아?」. 견주는 값이 그 건(계약, 직원 …)의 금액, 연봉, 예산이라 답은
 * 그 한 건의 달이다(달마다 모은 값이 아니다). */
const SINGLE_RECORD =
  /(?:(?<![가-힣])건|것|계약|직원|사원|티켓|프로젝트|고객사|거래|주문)\s*(?:이|가|의|은|는|중에서|중에|중|가운데)\s+(?:금액|연봉|급여|월급|예산|가격|이용료|단가)\s*(?:이|가|은|는)?\s*(?:가장|제일)/;

function monthGrouped(sql: string): boolean {
  if (MONTH_GROUPING.test(sql)) return true;
  return [...sql.matchAll(MONTH_SLICE)].some((m) => /[A-Za-z0-9](?:_date|_at)\b/i.test(m[1] ?? m[2] ?? ""));
}

/** ⑧-1 달마다 모은 값을 견주는 질문인데 생성 SQL 이 달로 묶지 않으면(date_trunc('month'), to_char(…, 'YYYY-MM'), EXTRACT(MONTH),
 * LEFT(날짜::text, 7), SUBSTRING(날짜::text …) 이 없음) 답이 달이 아니다. 「2024년에 매출이 가장 낮았던 달은 언제야?」에 매출 한 건을
 * 금액 순으로 골라 그 건의 분기를 「2분기」라고 답했다(월 합계 최저는 2024년 9월 3,860. 랜덤 테스트 사전 점검 3차 A14, 3/3).
 * 「가장 큰 계약이 체결된 달」, 「어느 달에 계약한 건이 금액이 가장 높아?」처럼 한 건을 고르는 질문은 보지 않는다. 날짜를 글자로
 * 잘라 묶은 `GROUP BY LEFT(sale_date::text, 7)` 과 한 건 질문의 `ORDER BY amount DESC LIMIT 1` 을 거부했었다. */
export function checkMonthUnit(sql: string, question: string): string[] {
  if (!MONTH_RANK.test(question) || SINGLE_RECORD.test(question) || monthGrouped(sql)) return [];
  // 수리 안내에 그 SQL 의 날짜 열을 그대로 적는다. 「날짜 열」로만 적었을 때 7B 는 분기(quarter)로 묶어 다시 냈다(A14 실측 1/2).
  const date = new RegExp(`(?<![A-Za-z0-9_$.])(?:${IDENT}\\.)?${IDENT}(?:_date|_at)(?![A-Za-z0-9_$])`, "i").exec(maskSql(sql) ?? "")?.[0] ?? "날짜 열";
  return [
    `${UNIT_REASON}질문은 달마다 모은 값을 견줘 달(월)을 묻는데 SQL 이 달로 묶지 않는다(한 건의 값이나 분기를 고른다). ` +
      `분기(quarter)가 아니라 date_trunc('month', ${date}) 로 GROUP BY 해 달마다 합계를 구한 뒤 견준다`,
  ];
}

/** 묶음 낱말과 그 같은 말. 「X별 … 가장 …」에서 가장 뒤에 X 가 다시 나오면(「분기별 매출 중 가장 높은 분기」) 전체에서 1위인 X 를 묻는다. */
const GROUP_NOUNS: Readonly<Record<string, string>> = {
  부서: "부서|팀", 팀: "팀|부서", 고객사: "고객사|고객|회사", 고객: "고객|고객사|회사", 제품: "제품|상품", 상품: "상품|제품", 지역: "지역",
  직급: "직급", 업종: "업종", 분기: "분기", 월: "월|달", 달: "달|월", 연도: "연도|해|년", 카테고리: "카테고리|분류", 분류: "분류|카테고리",
  유형: "유형", 담당자: "담당자|직원", 직원: "직원|사람", 프로젝트: "프로젝트", 상태: "상태", 우선순위: "우선순위", 규모: "규모",
};
const PER_GROUP_TOP = new RegExp(
  `(?<![가-힣])(${Object.keys(GROUP_NOUNS).join("|")})\\s*(?:별로?|마다)(?![가-힣])|(?:^|\\s)각\\s*(${Object.keys(GROUP_NOUNS).join("|")})(?=$|[^가-힣]|의|에서)`,
);
const TOP_WORD = /가장|제일|최고|최저|최대|최소|1위/;
/** 바깥 질의 끝에서 한 행만 고르는 꼴. OFFSET 이 붙어도 한 행이다: 「2025년 분기 중 매출이 가장 높은 분기와 가장 낮은 분기는?」의 수리 SQL
 * `ORDER BY total_sales DESC, total_sales ASC LIMIT 1 OFFSET 1` 이 검사를 지나 두 번째로 높은 분기 하나를 가장 높은 분기로 답했다
 * (랜덤 테스트 4차 수정본 실측 I8a). MySQL 꼴 `LIMIT 1, 1` 도 한 행이다. 문법 사유만 받은 수리가 LIMIT 1 OFFSET 1 로 고쳐 다시 거부됐다. */
const ONE_ROW_TAIL =
  /\b(?:(?:offset\s+\d+\s+(?:rows?\s+)?)?limit\s+(?:\d+\s*,\s*)?1(?:\s+offset\s+\d+(?:\s+rows?)?)?|(?:offset\s+\d+\s+rows?\s+)?fetch\s+(?:first|next)\s+1\s+rows?\s+(?:only|with\s+ties))\s*;?\s*$/i;

/** ⑧-3 묶음마다의 1위(「부서별 최고 연봉자는 누구야?」, 「지역별로 매출이 가장 높은 고객사」)를 묻는데 생성 SQL 의 바깥 질의가
 * 전체에서 한 행(ORDER BY … LIMIT 1, FETCH FIRST 1 ROWS)만 고르고 PARTITION BY 나 DISTINCT ON 이 없으면 1위가 하나뿐이다.
 * 「부서별 최고 연봉자는 누구야?」에 전체 1위 박소연 한 명을 답했다(부서마다 1위는 6명. 랜덤 테스트 사전 점검 4차 P6, AG02 3/3).
 * 가장 뒤에 묶음 낱말이 다시 오면(「분기별 매출 중 가장 높은 분기는?」) 전체 1위를 묻는 것이라 보지 않는다. */
export function checkGroupTop(sql: string, question: string): string[] {
  const g = PER_GROUP_TOP.exec(question);
  const top = g ? TOP_WORD.exec(question.slice(g.index + g[0].length)) : null;
  if (!g || !top) return [];
  const group = g[1] ?? g[2];
  const after = question.slice(g.index + g[0].length + top.index + top[0].length);
  if (new RegExp(GROUP_NOUNS[group]).test(after)) return [];
  const masked = maskSql(sql);
  const d = masked === null ? null : depths(masked);
  if (masked === null || !d || /\bpartition\s+by\b|\bdistinct\s+on\b/i.test(masked)) return [];
  const tail = ONE_ROW_TAIL.exec(masked);
  if (!tail || d[tail.index] !== 0 || !/\border\s+by\b/i.test(masked.slice(0, tail.index))) return [];
  return [
    `${UNIT_REASON}질문은 ${group}마다 1위를 묻는데 SQL 이 전체에서 한 행(${sql.slice(tail.index).replace(/\s+/g, " ").trim()})만 고른다. ` +
      `${group}마다 1위를 고른다(RANK() OVER (PARTITION BY ${group}의 열 ORDER BY …) = 1 인 행)`,
  ];
}

/** 묶음 낱말이 가리키는 열(표.열, * 는 어느 표든). 앞의 것부터 고른다. 질문의 묶음 낱말이 이 표에 없으면 groupTopRewrite 는 바꾸지 않는다. */
const GROUP_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  지역: ["clients.region", "sales.region"],
  부서: ["departments.name", "employees.dept_id"],
  팀: ["departments.name", "employees.dept_id"],
  직급: ["employees.position"],
  업종: ["clients.industry"],
  분기: ["sales.quarter"],
  카테고리: ["products.category", "sales.category"],
  분류: ["products.category", "sales.category"],
  유형: ["contracts.contract_type"],
  규모: ["clients.company_size"],
  우선순위: ["support_tickets.priority"],
  고객사: ["clients.name", "*.client_id"],
  고객: ["clients.name", "*.client_id"],
  제품: ["products.name", "*.product_id"],
  상품: ["products.name", "*.product_id"],
};

/** ⑧-3 의 결정론 수리. 묶음마다의 1위(「지역별로 매출이 가장 높은 고객사는?」)를 묻는데 생성 SQL 이 전체 1위 한 행(ORDER BY … LIMIT 1)만 고르면,
 * 그 SQL 에서 LIMIT 를 빼고 RANK() OVER (PARTITION BY 묶음 열 ORDER BY 첫 정렬 값) 를 더해 순위 1 인 행을 모두 고르는 SQL 로 바꾼다. 사유만 되먹였을
 * 때 7B 수리가 두 번 다 LIMIT 1 을 남겨 거절로 끝났다(랜덤 테스트 사전 점검 5차 P13, FV11 3/3). 묶음 열은 질문의 묶음 낱말(GROUP_COLUMNS)이 가리키는
 * 열 가운데 SQL 의 표에 있는 것이고, SELECT 목록에 없으면 앞에 더한다(묶은 질의면 GROUP BY 에도 더한다). 첫 정렬 키가 묶음 열이면 그다음 키로 순위를
 * 매긴다. 바꿀 꼴이 아니면(WITH, DISTINCT, 집합 연산, 하위 질의의 LIMIT, rank 라는 이름, 읽지 못하는 문장) null. */
export function groupTopRewrite(sql: string, question: string): string | null {
  if (!checkGroupTop(sql, question).length) return null;
  const g = PER_GROUP_TOP.exec(question);
  const columns = GROUP_COLUMNS[g?.[1] ?? g?.[2] ?? ""];
  if (!columns) return null;
  const all = tokenizeSql(sql);
  if (!all?.length) return null;
  let prev = 0;
  for (const t of all) {
    if (sql.slice(prev, t.at).trim() || ((t.k === "w" || t.k === "q") && /^(?:group_rank|ranked)$/.test(t.v))) return null;
    prev = tokenEnd(sql, t);
  }
  if (sql.slice(prev).trim()) return null;
  const toks = all[all.length - 1].k === ";" ? all.slice(0, -1) : all;
  const depth: number[] = [];
  let level = 0;
  for (const t of toks) {
    if (t.k === ";") return null;
    if (t.k === ")" || t.k === "]") level--;
    if (level < 0) return null;
    depth.push(level);
    if (t.k === "(" || t.k === "[") level++;
  }
  if (level !== 0) return null;
  const kw = (i: number) => (depth[i] === 0 && toks[i]?.k === "w" && toks[i - 1]?.k !== "." ? toks[i].v : null);
  const isName = (i: number) => toks[i]?.k === "w" || toks[i]?.k === "q";
  const text = (lo: number, hi: number) => sql.slice(toks[lo].at, tokenEnd(sql, toks[hi - 1]));
  if (kw(0) !== "select" || kw(1) === "distinct" || kw(1) === "all") return null;
  let from = -1;
  let group = -1;
  let order = -1;
  let tail = -1;
  let clauseEnd = -1; // GROUP BY 목록의 끝(HAVING, ORDER BY, 꼬리 가운데 먼저 오는 것)
  for (let i = 1; i < toks.length; i++) {
    const w = kw(i);
    if (w === "select" || w === "union" || w === "intersect" || w === "except" || w === "window" || w === "for" || w === "into") return null;
    if (w === "from" && from < 0) from = i;
    else if (w === "group" && kw(i + 1) === "by" && group < 0) group = i;
    else if ((w === "having" || (w === "order" && kw(i + 1) === "by")) && group >= 0 && clauseEnd < 0) clauseEnd = i;
    if (w === "order" && kw(i + 1) === "by") {
      if (order >= 0) return null;
      order = i;
    } else if ((w === "limit" || w === "offset" || w === "fetch") && tail < 0) tail = i;
  }
  if (from < 0 || order < from || tail < order + 3) return null;
  if (group >= 0 && clauseEnd < 0) clauseEnd = tail;
  const split = (lo: number, hi: number): [number, number][] => {
    const parts: [number, number][] = [];
    let start = lo;
    for (let i = lo; i < hi; i++) {
      if (depth[i] === 0 && toks[i].k === ",") {
        parts.push([start, i]);
        start = i + 1;
      }
    }
    parts.push([start, hi]);
    return parts;
  };
  // 본 SELECT 목록의 출력 이름과 식(rankRewrite 와 같은 읽기).
  const items: { name: string | null; expr: string; star: boolean }[] = [];
  for (const [lo, hi] of split(1, from)) {
    if (hi <= lo) return null;
    const star = toks[hi - 1].k === "o" && toks[hi - 1].v === "*";
    const last = toks[hi - 1];
    const before = toks[hi - 2];
    if (star) return null;
    if (hi - lo >= 3 && kw(hi - 2) === "as" && isName(hi - 1)) items.push({ name: last.v, expr: text(lo, hi - 2), star });
    else if (
      hi - lo >= 2 &&
      isName(hi - 1) &&
      !(last.k === "w" && NOT_OUTPUT_NAME.has(last.v)) &&
      (before.k === ")" || before.k === "]" || before.k === "s" || isName(hi - 2) || (before.k === "o" && /^\d/.test(before.v)))
    ) {
      items.push({ name: last.v, expr: text(lo, hi - 1), star });
    } else {
      const column = toks.slice(lo, hi).every((t, j) => (j % 2 === 0 ? t.k === "w" || t.k === "q" : t.k === "."));
      items.push({ name: column && (hi - lo) % 2 === 1 ? last.v : null, expr: text(lo, hi), star });
    }
  }
  // 묶음 열: SQL 의 표 별칭으로 GROUP_COLUMNS 의 열을 찾는다.
  const masked = maskSql(sql);
  if (masked === null) return null;
  const alias = aliasTables(masked, new Set(["clients", "sales", "departments", "employees", "products", "contracts", "projects", "support_tickets"]));
  const bound = [...alias.entries()];
  let part: string | null = null;
  for (const c of columns) {
    const [t, col] = c.split(".");
    const owner = bound.find(([a, ts]) => (t === "*" ? [...ts].some((x) => x !== "departments") : ts.has(t)) && a !== t && toks.some((k, i) => k.k === "w" && k.v === a && toks[i + 1]?.k === "."));
    const plain = bound.find(([a, ts]) => a === t && ts.has(t));
    const name = owner?.[0] ?? plain?.[0];
    if (name && (t !== "*" || new RegExp(`(?<![A-Za-z0-9_])${name}\\.${col}(?![A-Za-z0-9_])`, "i").test(masked))) {
      part = `${name}.${col}`;
      break;
    }
  }
  if (!part) return null;
  const partRe = new RegExp(`^${part.replace(".", "\\.")}$`, "i");
  // 순위 값: 첫 정렬 키(묶음 열이면 그다음 키). 출력 이름이나 자리 번호면 그 식으로 바꾼다.
  let key: string | null = null;
  for (const [lo, end] of split(order + 2, tail)) {
    if (end <= lo) return null;
    let hi = end;
    if (hi - lo >= 3 && kw(hi - 2) === "nulls" && (kw(hi - 1) === "first" || kw(hi - 1) === "last")) hi -= 2;
    if (hi - lo >= 2 && (kw(hi - 1) === "asc" || kw(hi - 1) === "desc")) hi -= 1;
    let expr = text(lo, hi);
    if (hi - lo === 1 && isName(lo)) {
      const hit = items.filter((it) => it.name === toks[lo].v);
      if (hit.length > 1) return null;
      if (hit.length) expr = hit[0].expr;
    } else if (hi - lo === 1 && toks[lo].k === "o" && /^\d+$/.test(toks[lo].v)) {
      const it = items[Number(toks[lo].v) - 1];
      if (!it) return null;
      expr = it.expr;
    }
    if (partRe.test(expr.replace(/\s+/g, "")) || expr.replace(/\s+/g, "").toLowerCase() === part.toLowerCase()) continue;
    key = hi < end ? `${expr} ${text(hi, end)}` : expr;
    break;
  }
  if (!key) return null;
  const selected = items.some((it) => it.expr.replace(/\s+/g, "").toLowerCase() === part!.toLowerCase());
  // SELECT 목록에 묶음 열이 없으면 묶음 이름(GROUP_LABELS)으로 앞에 더한다. 그 이름이 다른 출력 이름과 겹치면 바꾸지 않는다.
  const label = GROUP_LABELS[g?.[1] ?? g?.[2] ?? ""] ?? "group_key";
  if (!selected && items.some((it) => it.name === label)) return null;
  const head = `SELECT ${selected ? "" : `${part} AS ${label}, `}${text(1, from)}, RANK() OVER (PARTITION BY ${part} ORDER BY ${key}) AS group_rank`;
  let body = text(from, group >= 0 ? clauseEnd : order);
  if (group >= 0) {
    const keys = split(group + 2, clauseEnd).map(([lo, hi]) => text(lo, hi).replace(/\s+/g, "").toLowerCase());
    const grouped = keys.includes(part.toLowerCase());
    body = `${text(from, clauseEnd)}${grouped ? "" : `, ${part}`}`;
    if (kw(clauseEnd) === "having") body += ` ${text(clauseEnd, order)}`;
  }
  const names = [...(selected ? [] : [label]), ...items.map((it) => it.name)];
  const outer = names.every((n): n is string => n !== null) && new Set(names).size === names.length ? names.join(", ") : "*";
  return `SELECT ${outer} FROM (${head} ${body}) AS ranked WHERE group_rank = 1`;
}
const GROUP_LABELS: Readonly<Record<string, string>> = {
  지역: "region", 부서: "department", 팀: "department", 직급: "position", 업종: "industry", 분기: "quarter", 카테고리: "category", 분류: "category",
  유형: "contract_type", 규모: "company_size", 우선순위: "priority", 고객사: "client", 고객: "client", 제품: "product", 상품: "product",
};

const HIGH_END = /(?:가장|제일)\s*(?:높|많|크|큰|비싸|비싼|길|긴)|최고|최대|최댓값/;
const LOW_END = /(?:가장|제일)\s*(?:낮|적|작|싸|싼|짧)|최저|최소|최솟값/;

/** ⑧-4 가장 높은 쪽과 가장 낮은 쪽을 함께 묻는데(「2025년 분기 중 매출이 가장 높은 분기와 가장 낮은 분기는?」, 「계약 금액이 가장 큰
 * 계약과 가장 작은 계약은?」) 생성 SQL 의 바깥 질의가 한쪽 끝 한 행(ORDER BY … LIMIT 1, FETCH FIRST 1 ROWS)만 고르면 다른 끝이 빠진다.
 * 「계약 금액이 가장 큰 계약과 가장 작은 계약은?」에 가장 큰 계약(11,000)만 답하고 가장 작은 계약(480)을 빠뜨렸다(랜덤 테스트 사전 점검
 * 4차 P6, AG08 6회 중 5회). 바깥에 UNION 이 있거나 MAX 와 MIN 처럼 한 행에 두 끝을 담는 SQL 은 바깥 LIMIT 이 없어 보지 않는다. */
export function checkBothEnds(sql: string, question: string): string[] {
  if (!HIGH_END.test(question) || !LOW_END.test(question)) return [];
  const masked = maskSql(sql);
  const d = masked === null ? null : depths(masked);
  if (masked === null || !d) return [];
  if ([...masked.matchAll(/\b(?:union|intersect|except)\b/gi)].some((m) => d[m.index ?? 0] === 0)) return [];
  const tail = ONE_ROW_TAIL.exec(masked);
  if (!tail || d[tail.index] !== 0 || !/\border\s+by\b/i.test(masked.slice(0, tail.index))) return [];
  return [
    `${UNIT_REASON}질문은 가장 높은 쪽과 가장 낮은 쪽을 함께 묻는데 SQL 이 한쪽 끝 한 행(${sql.slice(tail.index).replace(/\s+/g, " ").trim()})만 고른다. ` +
      "두 끝을 함께 고른다: (SELECT … ORDER BY 값 DESC LIMIT 1) UNION ALL (SELECT … ORDER BY 값 ASC LIMIT 1)",
  ];
}

/** ⑧-5 반기(「2024년 상반기와 하반기 매출을 비교해줘」)를 묻는데 생성 SQL 의 바깥 질의가 분기(quarter)로 묶으면 7B 가 분기 행을 반기로
 * 읽는다. 1, 2분기 두 행을 상반기와 하반기라고 답했다(31,960 대 36,412. 반기는 68,372 대 65,134. 4차 수정본 실측 N5). 반기로 묶거나
 * (CASE … END, 그 별칭) 묶지 않고 합계 한 행을 내면 보지 않는다. 질문이 분기나 달을 따로 말하면(「하반기 분기별 매출」) 보지 않는다. */
export function checkHalfGroup(sql: string, question: string): string[] {
  if (!/[상하]반기/.test(question) || QUARTER_OR_MONTH.test(question) || /분기\s*(?:별|마다|단위)/.test(question)) return [];
  const masked = maskSql(sql);
  const d = masked === null ? null : depths(masked);
  if (masked === null || !d) return [];
  const group = [...masked.matchAll(/\bgroup\s+by\b/gi)].find((m) => d[m.index ?? 0] === 0);
  if (!group) return [];
  const from = (group.index ?? 0) + group[0].length;
  const stop = [...masked.slice(from).matchAll(/\b(?:having|order\s+by|limit|offset|fetch|union|intersect|except|window)\b/gi)].find(
    (m) => d[from + (m.index ?? 0)] === 0,
  );
  const to = stop ? from + (stop.index ?? 0) : masked.length;
  const keys = sql.slice(from, to).replace(/\s+/g, " ").replace(/;\s*$/, "").trim();
  if (/\bcase\b/i.test(masked.slice(from, to))) return [];
  if (!/(?<![A-Za-z0-9_$'])(?:[A-Za-z_][A-Za-z0-9_]*\.)?quarter(?![A-Za-z0-9_$'])|date_trunc\s*\(\s*'quarter'|extract\s*\(\s*quarter\b/i.test(keys)) return [];
  const year = /(\d{4})\s*년/.exec(question)?.[1] ?? "YYYY";
  return [
    `${UNIT_REASON}질문은 반기(상반기, 하반기)를 묻는데 SQL 이 분기(GROUP BY ${keys})로 묶는다. 반기마다 한 행이 되게 ` +
      `CASE WHEN quarter IN ('${year}-Q1', '${year}-Q2') THEN '상반기' ELSE '하반기' END 로 묶어 합계를 구한다`,
  ];
}

const COUNT_QUESTION = /몇\s*(?:명|개|건|곳)/;
/** 그룹마다의 수를 묻는 말: 「부서별」, 「고객사마다」, 「각 부서」, 「영업팀과 기술지원팀」. */
const PER_GROUP = /별|마다|각각|(?:^|\s)각\s|따라|[가-힣A-Za-z0-9](?:와|과|하고|이랑)\s|\s및\s/;

/** ⑧-2 수 하나를 묻는데(몇 명, 몇 개, 몇 건, 몇 곳) 생성 SQL 의 바깥 질의가 GROUP BY 로 묶어 그룹마다 COUNT 를 내면 답할 값이
 * 여러 행에 흩어진다. 「고객사를 두 곳 이상 담당하는 직원은 몇 명이야?」에 GROUP BY manager_id … HAVING 으로 1 이 12행 나왔고
 * 답은 「1명」이었다(랜덤 테스트 사전 점검 3차 S14, 3/3). 실제로 여러 행이 나오는지는 sql.query 와 같은 읽기 전용 거래에서 센다
 * (그룹을 묶은 뒤 한 행만 남는 「영업팀 직원은 몇 명이야?」의 GROUP BY d.name 은 막지 않는다). 그룹마다의 수를 묻는 질문, 읽지
 * 못하거나 실행되지 않는 문장은 보지 않는다. */
export async function confirmCountUnit(pool: Pool, sql: string, question: string): Promise<string[]> {
  if (!COUNT_QUESTION.test(question) || PER_GROUP.test(question)) return [];
  const masked = maskSql(sql);
  if (masked === null) return [];
  const d = depths(masked);
  if (!d) return [];
  const top = (re: RegExp) => [...masked.matchAll(re)].filter((m) => d[m.index ?? 0] === 0).map((m) => m.index ?? 0);
  const group = top(/\bgroup\s+by\b/gi)[0];
  const selects = top(/\bselect\b/gi);
  if (group === undefined || selects.length !== 1) return [];
  const from = top(/\bfrom\b/gi).find((at) => at > selects[0]) ?? masked.length;
  if (!/\bcount\s*\(/i.test(masked.slice(selects[0], from))) return [];
  const r = await sqlQuery(pool, `SELECT count(*) AS n FROM (${sql.replace(/[\s;]+$/, "")}) AS grouped`);
  const n = r.ok ? Number((r.rows[0] as { n?: unknown } | undefined)?.n) : NaN;
  if (!(n > 1)) return [];
  const stop = top(/\b(?:having|order|limit|offset|fetch|window)\b/gi).find((at) => at > group) ?? sql.length;
  return [
    `${UNIT_REASON}${sql.slice(group, stop).replace(/\s+/g, " ").trim()} 로 묶어 그룹마다 수를 하나씩(${n}행) 돌려준다. ` +
      "질문은 수 하나를 묻는다. 조건에 맞는 그룹을 하위 질의로 고른 뒤 바깥에서 count(*) 로 센다",
  ];
}

/** 묶음 하나마다의 평균을 묻는 말: 「고객사당」, 「직원 1인당」, 「부서당」. */
const PER_UNIT_AVERAGE = /(?:고객사|고객|직원|사람|부서|팀|제품|프로젝트|계약|티켓)\s*(?:1\s*인\s*)?당(?![가-힣])|1\s*인\s*당/;
const PER_UNIT_AVERAGE_HINT =
  "묶음마다 센 값을 하위 질의로 두고 바깥에서 AVG 하나를 구한다: SELECT AVG(n)::numeric(10,2) FROM (SELECT 묶음.id, COUNT(센 표.id) AS n " +
  "FROM 묶음 표 LEFT JOIN 센 표 ON … GROUP BY 묶음.id) AS t. 묶음 표(고객사면 clients)에서 LEFT JOIN 으로 세어 값이 없는 묶음도 0 으로 넣는다. " +
  "AVG(COUNT(…)) 처럼 집계를 겹쳐 쓰지 않는다";
const CUMULATIVE_ASKED = /(?:월|달|분기|연도|해|일|주)\s*(?:별|마다)|추이|흐름/;
const CUMULATIVE_HINT =
  "기간마다 합계를 하위 질의(WITH)로 먼저 구한 뒤 바깥에서 SUM(합계) OVER (ORDER BY 기간) 으로 누적을 센다. 창의 ORDER BY 에는 같은 단계의 별칭을 쓰지 않는다";
/** 기간마다 1년 전 같은 기간과 견주는 질문: 「전년 동기」, 「작년 같은 분기」, 「분기별 … 전년 대비」. 기간 낱말 없는 「2025년 매출은 전년 대비
 * 몇 퍼센트 감소했어?」는 한 해끼리 견주는 질문이라 넣지 않는다(LAG 를 연도로 한 칸 걸면 맞다). */
const yoyAsked = (question: string) =>
  (/전년\s*(?:동기|동월|동분기)|작년\s*같은\s*(?:분기|달|월|기간|때)|\byoy\b|year\s*over\s*year/i.test(question) &&
    // 「작년 같은 분기 매출은 얼마였어?」는 견주지 않고 한 기간(2025년 4분기)을 묻는다(5차 P3 DT10).
    !(sameQuarterLastYear(question) && !/대비|비교|증감|증가|감소|늘|줄|차이|보다|성장|변화/.test(question))) ||
  (/(?:분기|월|달)\s*(?:별|마다)|매\s*(?:분기|달|월)/.test(question) && /전년\s*(?:대비|같은)/.test(question));
/** 꼴을 그대로 적는다. 「분자를 ::numeric 으로」만 덧붙였을 때 7B 는 LAG(SUM(amount), 4) 까지 맞히고 정수 나눗셈을 3/3 그대로 두었다. */
const yoyHint = (question: string) => {
  const step = /월|달/.test(question) && !/분기/.test(question) ? 12 : 4;
  return (
    `기간마다 합계를 먼저 구하고(GROUP BY 기간) 1년 전 같은 ${step === 12 ? "달" : "분기"}와 견준다. 증감률은 분자를 ::numeric 으로 바꿔 나눈다: ` +
    `(SUM(값) - LAG(SUM(값), ${step}) OVER (ORDER BY 기간))::numeric * 100 / LAG(SUM(값), ${step}) OVER (ORDER BY 기간)`
  );
};

/** 질문 모양에 맞춘 SQL 안내(묶음당 평균, 기간별 누적, 전년 동기). 수리 프롬프트마다(오류, 0행, 실행 전 검사) 붙인다. 실행 전 검사 사유만
 * 안내하던 때는 오류 수리가 그 모양을 몰라 「고객사당 평균 계약 건수는?」의 AVG(COUNT(…)) 오류를 고객사별 30행으로 고쳤고, 전년 동기 수리는
 * LAG(SUM(amount), 4) 까지 맞히고 정수 나눗셈으로, 누적 수리는 창 ORDER BY 에 별칭을 써 42703 으로 끝났다(4차 P6 수정본 실측 2026-10-08).
 * 시험항목 질문에는 「당 … 평균」, 「누적」, 「전년」이 없다. */
export function shapeHints(question: string): string[] {
  const hints: string[] = [];
  if (/평균/.test(question) && PER_UNIT_AVERAGE.test(question) && !PER_GROUP.test(question)) hints.push(`질문은 묶음 하나마다의 평균 하나를 묻는다. ${PER_UNIT_AVERAGE_HINT}`);
  if (/누적/.test(question) && CUMULATIVE_ASKED.test(question)) hints.push(`질문은 기간마다의 누적을 묻는다. ${CUMULATIVE_HINT}`);
  if (yoyAsked(question)) hints.push(`질문은 전년 동기와 견준다. ${yoyHint(question)}`);
  // 6차 P3: 두 값의 비, 두 묶음의 차, 두 반기의 차. 7B 는 「high 우선순위 티켓은 low 우선순위 티켓의 몇 배야?」를 COUNT(*) … / COUNT(*) … 문법 오류로, 「경영지원팀 평균
  // 연봉이 영업팀보다 얼마나 낮아?」를 ON 없는 JOIN 으로, 「2025년 상반기 계약 금액은 2024년 상반기보다 얼마나 많아?」를 sales 의 EXTRACT(… FROM quarter) 로 써 한 번의
  // 수리도 실패했다(CP06, XC02, MR16 3/3).
  const halves = halfPeriods(question);
  if (/몇\s*배/.test(question)) hints.push(`질문은 두 값의 비(몇 배)를 묻는다. ${RATIO_SHAPE_HINT}`);
  if (halves.length >= 2) hints.push(`질문은 두 기간의 값을 견준다. ${halfDiffHint(question, halves[0], halves[1])}`);
  else if (/보다\s*(?:얼마나|몇)/.test(question)) hints.push(`질문은 두 값의 차를 묻는다. ${diffShapeHint(question)}`);
  // 6차 P11: 「최근 매출 추이는 어때?」는 끝난 분기 네 개로 본다(SP08).
  if (RECENT_TREND.test(question) && /매출|실적/.test(question)) hints.push(`질문은 최근 추이를 묻는다. ${recentQuartersHint()}`);
  return hints;
}

const RATIO_SHAPE_HINT =
  "값마다 따로 집계해 나누고 분자를 ::numeric 으로 바꾼다(정수끼리 나누면 소수점 아래를 버린다): SELECT (SELECT COUNT(*) FROM 표 WHERE 열 = 'A')::numeric / " +
  "NULLIF((SELECT COUNT(*) FROM 표 WHERE 열 = 'B'), 0) AS ratio. 합계의 비는 SUM(값) FILTER (WHERE 열 = 'A')::numeric / NULLIF(SUM(값) FILTER (WHERE 열 = 'B'), 0). " +
  "A, B 는 질문의 두 값이다";
/** 두 값의 차 안내. 질문에 부서 이름이 둘이면 그 이름을 넣은 SQL 을 그대로 적는다(A, B 자리표시만 주자 7B 는 같은 표를 두 번 JOIN 한 꼴을 남겼다, XC02). */
function diffShapeHint(question: string): string {
  const depts = (COMPARE_FAMILIES.get("companyx")?.find((f) => f.col === "departments.name")?.values ?? [])
    .map(([v]) => [question.indexOf(v), v] as [number, string])
    .filter(([i]) => i >= 0)
    .sort((x, y) => x[0] - y[0])
    .map(([, v]) => v);
  if (depts.length === 2 && /연봉|급여|월급/.test(question)) {
    const [a, b] = depts;
    return (
      `한 FROM 에서 값마다 FILTER 로 따로 집계해 뺀다: SELECT AVG(e.salary) FILTER (WHERE d.name = '${a}') - AVG(e.salary) FILTER (WHERE d.name = '${b}') AS diff ` +
      "FROM companyx.employees e JOIN companyx.departments d ON d.id = e.dept_id. 같은 표를 두 번 JOIN 하지 않는다"
    );
  }
  return (
    "한 FROM 에서 값마다 FILTER 로 따로 집계해 뺀다: SELECT SUM(값) FILTER (WHERE 열 = 'A') - SUM(값) FILTER (WHERE 열 = 'B') AS diff FROM 표 " +
    "(평균이면 AVG). A 는 질문의 앞 값, B 는 「보다」 앞의 값이다. 같은 표를 두 번 JOIN 하지 않는다"
  );
}

/** 질문의 연도가 붙은 반기(「2025년 상반기」, 「작년 하반기」). */
function halfPeriods(question: string): { year: number; half: string }[] {
  const thisYear = seoulYear(new Date());
  return [...question.matchAll(HALF_RE)].map((m) => ({ year: m[1] ? Number(m[1]) : thisYear + (RELATIVE_YEAR[m[2]] ?? 0), half: m[3] }));
}

function halfDiffHint(question: string, a: { year: number; half: string }, b: { year: number; half: string }): string {
  const contract = /계약/.test(question);
  const col = contract ? "start_date" : "sale_date";
  const range = (p: { year: number; half: string }) =>
    p.half === "상" ? `${col} >= '${p.year}-01-01' AND ${col} < '${p.year}-07-01'` : `${col} >= '${p.year}-07-01' AND ${col} < '${p.year + 1}-01-01'`;
  return (
    `기간마다 FILTER 로 따로 합해 뺀다: SELECT SUM(amount) FILTER (WHERE ${range(a)}) - SUM(amount) FILTER (WHERE ${range(b)}) AS diff FROM companyx.${contract ? "contracts" : "sales"}. ` +
    (contract ? "계약 금액은 contracts.amount 를 계약 시작일(start_date)로 센다(매출 sales 가 아니다). " : "매출은 sales.amount 를 sale_date 로 센다. ") +
    "quarter 는 '2025-Q1' 꼴 글자라 EXTRACT 에 넣지 않는다"
  );
}

/** ⑧-6 묶음 하나마다의 평균 하나를 묻는데(「고객사당 평균 계약 건수는?」) 생성 SQL 의 바깥 질의가 GROUP BY 로 묶어 묶음마다 값을 내면
 * 7B 가 그 행들을 보고 평균을 지어낸다. 고객사별 30행에 「3입니다」라고 답했다(계약이 있는 27곳 평균 2.41. 랜덤 테스트 사전 점검 4차
 * AG11). 실제로 여러 행이 나오는지는 confirmCountUnit 과 같이 읽기 전용 거래에서 센다. 묶음마다의 평균을 묻는 질문은 보지 않는다. */
export async function confirmAverageUnit(pool: Pool, sql: string, question: string): Promise<string[]> {
  if (!/평균/.test(question) || !PER_UNIT_AVERAGE.test(question) || PER_GROUP.test(question)) return [];
  const masked = maskSql(sql);
  const d = masked === null ? null : depths(masked);
  if (masked === null || !d) return [];
  const top = (re: RegExp) => [...masked.matchAll(re)].filter((m) => d[m.index ?? 0] === 0).map((m) => m.index ?? 0);
  const group = top(/\bgroup\s+by\b/gi)[0];
  if (group === undefined || top(/\bselect\b/gi).length !== 1) return [];
  const r = await sqlQuery(pool, `SELECT count(*) AS n FROM (${sql.replace(/[\s;]+$/, "")}) AS grouped`);
  const n = r.ok ? Number((r.rows[0] as { n?: unknown } | undefined)?.n) : NaN;
  if (!(n > 1)) return [];
  const stop = top(/\b(?:having|order|limit|offset|fetch|window)\b/gi).find((at) => at > group) ?? sql.length;
  return [
    `${UNIT_REASON}${sql.slice(group, stop).replace(/\s+/g, " ").trim()} 로 묶어 묶음마다 값을 하나씩(${n}행) 돌려준다. 질문은 평균 하나를 묻는다. ` +
      PER_UNIT_AVERAGE_HINT,
  ];
}

/** ⑧-7 기간마다의 누적(「2025년 월별 누적 매출을 보여줘」)을 묻는데 생성 SQL 에 창 합계(SUM(…) OVER (ORDER BY …))가 없으면 누적은 7B 가
 * 행을 더해 낸다. 월 합계 12행을 받아 2월부터 누적을 틀렸다(2월 15,325, 실제 22,145 … 112,773. 랜덤 테스트 사전 점검 4차 AG05). 기간 낱말
 * 없이 「누적 매출」 하나를 묻는 질문(합계 하나)은 보지 않는다. */
export function checkCumulative(sql: string, question: string): string[] {
  if (!/누적/.test(question) || !CUMULATIVE_ASKED.test(question)) return [];
  const masked = maskSql(sql);
  if (masked === null || /\bover\s*\(/i.test(masked)) return [];
  return [`${UNIT_REASON}질문은 기간마다의 누적을 묻는데 SQL 이 누적을 세지 않는다(창 합계가 없다). ${CUMULATIVE_HINT}`];
}

/** ⑧-8 전년 동기 대비(「분기별 매출의 전년 동기 대비 증감률을 보여줘」)를 묻는데 생성 SQL 의 LAG 가 1년 전 같은 기간에 닿지 않으면 다른
 * 행과 견준다. 기간마다 합계를 내지 않은 매출 500행에 LAG(amount) OVER (PARTITION BY quarter …) 를 걸어 「2024년 Q1 … 600%」라고
 * 답했다(같은 분기 안의 매출 건끼리 견줌. 2024년은 견줄 전년이 없다. 실제 2025-Q1 -4.87% … 랜덤 테스트 사전 점검 4차 AG04). 묶지 않은 행의
 * LAG, 분기 값 그대로('2024-Q1')로 나눈 PARTITION, 나누지 않은 한 칸 LAG 를 본다. LAG 없이 연도를 하나 빼 조인한 SQL 은 보지 않는다. */
export function checkYearOverYear(sql: string, question: string): string[] {
  if (!yoyAsked(question)) return [];
  const masked = maskSql(sql);
  if (masked === null) return [];
  const lags = [...masked.matchAll(/\blag\s*\(/gi)];
  if (!lags.length) return [];
  const grouped = /\bgroup\s+by\b/i.test(masked);
  const partitioned = /\bpartition\s+by\b/i.test(masked);
  const byQuarterValue = /\bpartition\s+by\s+(?:[A-Za-z_][A-Za-z0-9_]*\.)?quarter\s*(?:\)|\border\b|,)/i.test(masked);
  const one = lags.some((m) => {
    let depth = 0;
    let comma = false;
    for (let i = (m.index ?? 0) + m[0].length; i < masked.length; i++) {
      const c = masked[i];
      if (c === "(") depth++;
      else if (c === ")") {
        if (depth === 0) return !comma || /,\s*1\s*$/.test(masked.slice((m.index ?? 0) + m[0].length, i));
        depth--;
      } else if (c === "," && depth === 0) comma = true;
    }
    return false;
  });
  if (grouped && !byQuarterValue && (partitioned || !one)) return [];
  return [`${UNIT_REASON}질문은 전년 동기와 견주는데 SQL 의 LAG 는 1년 전 같은 기간에 닿지 않는다. ${yoyHint(question)}`];
}

/** 평균 식 사유의 머리말. */
const AVG_ELSE_REASON = "평균 식 ";

/** ⑧-9 AVG(CASE WHEN 묶음 조건 THEN 값 ELSE 0 END) 는 다른 묶음의 행을 0 으로 넣어 평균한다. 「대기업 고객사와 스타트업 고객사의 평균 계약 금액
 * 차이는?」에 이 꼴로 -35.08 을 답했다(대기업 3,300, 스타트업 2,780, 차이 520. 랜덤 테스트 사전 점검 5차 P6, CG06 3/3). THEN 이 모두 상수인
 * 비율 꼴(AVG(CASE WHEN … THEN 1 ELSE 0 END))은 맞아 보지 않는다. */
export function checkAvgElseZero(sql: string): string[] {
  const masked = maskSql(sql);
  if (masked === null) return [];
  const reasons: string[] = [];
  for (const m of masked.matchAll(/\bavg\s*\(\s*case\b/gi)) {
    const at = m.index ?? 0;
    const caseAt = at + m[0].length - 4;
    const re = /\b(case|end)\b/gi;
    re.lastIndex = caseAt;
    let depth = 0;
    let end = -1;
    for (let x = re.exec(masked); x; x = re.exec(masked)) {
      if (x[1].toLowerCase() === "case") depth++;
      else if (--depth === 0) {
        end = (x.index ?? 0) + 3;
        break;
      }
    }
    if (end < 0) continue;
    const body = masked.slice(caseAt, end);
    if (!/\belse\s+0(?:\.0*)?(?:\s*::\s*[a-z]+)?\s+end$/i.test(body)) continue;
    const thens = [...body.matchAll(/\bthen\s+(\S+)/gi)].map((t) => t[1]);
    if (thens.length && thens.every((v) => /^\d+(?:\.\d*)?$/.test(v))) continue;
    let close = end;
    while (close < masked.length && masked[close] !== ")") close++;
    reasons.push(
      `${AVG_ELSE_REASON}${sql.slice(at, close + 1).replace(/\s+/g, " ")} 은 조건 밖의 행을 0 으로 넣어 평균한다. AVG 안의 CASE 는 ELSE 0 을 쓰지 않는다: ` +
        "ELSE 를 빼야(조건 밖의 행은 NULL 이라 AVG 가 건너뛴다) 그 묶음의 행만 평균한다",
    );
  }
  return reasons;
}

/** 비교 사유의 머리말. */
const COMPARE_REASON = "비교 ";
/** 질문 낱말 뒤에 와도 그 값을 가리키는 말(조사, 지역 따위). 「서울물산」의 서울은 값이 아니다. */
const VALUE_TAIL = "(?=$|[^가-힣]|과|와|이랑|랑|하고|및|이|가|은|는|의|에|을|를|보다|지역|쪽|고객|매출|소재|대비)";
/** 한 열의 두 값을 견주는 질문에서 읽는 값. sql 은 생성 SQL 의 값, words 는 질문 낱말. 부서 이름은 분류 낱말(클라우드사업부의 클라우드)보다 먼저 지운다. */
const COMPARE_FAMILIES = new Map<string, readonly { col: string; keys: readonly string[]; values: readonly [string, string][] }[]>([
  [
    "companyx",
    [
      { col: "departments.name", keys: ["departments.name", "departments.id", "*.dept_id"], values: ["경영지원팀", "클라우드사업부", "보안솔루션팀", "데이터플랫폼팀", "기술지원팀", "영업팀"].map((v) => [v, v] as [string, string]) },
      { col: "region", keys: ["clients.region", "sales.region"], values: ["서울", "경기", "인천", "부산", "대구", "대전", "광주", "제주"].map((v) => [v, v] as [string, string]) },
      {
        col: "company_size",
        keys: ["clients.company_size"],
        values: [["startup", "스타트업|신생|소규모|소기업"], ["mid", "중견|중소|중형|중규모"], ["enterprise", "대기업|대형|대규모|엔터프라이즈"]],
      },
      { col: "category", keys: ["products.category", "sales.category"], values: [["cloud", "클라우드"], ["security", "보안"], ["data", "데이터"], ["consulting", "컨설팅"]] },
      // 6차 P3: 「critical 티켓과 high 티켓 중 미해결이 더 많은 쪽은?」에 두 값을 거르지 않고 미해결 1위 우선순위(medium)를 골랐다(CP10 3/3).
      {
        col: "priority",
        keys: ["support_tickets.priority"],
        values: [
          ["critical", "(?<![A-Za-z])[Cc]ritical|크리티컬|긴급"],
          ["high", "(?<![A-Za-z])[Hh]igh(?![A-Za-z])|하이"],
          ["medium", "(?<![A-Za-z])[Mm]edium|미디엄"],
          ["low", "(?<![A-Za-z])[Ll]ow(?![A-Za-z])|로우"],
        ],
      },
      {
        col: "industry",
        keys: ["clients.industry"],
        values: [
          ["건설", "건설"], ["교육", "교육"], ["금융", "금융"], ["미디어", "미디어"], ["에너지", "에너지"], ["제조업", "제조업?"], ["공공기관", "공공\\s*기관|공공"],
          ["유통/물류", "유통|물류"], ["의료/바이오", "의료|바이오"], ["IT/SW", "(?<![A-Za-z])IT(?![A-Za-z])|소프트웨어"],
        ],
      },
      {
        col: "contract_type",
        keys: ["contracts.contract_type"],
        values: [["subscription", "구독"], ["maintenance", "유지\\s*보수|유지\\s*관리"], ["project", "프로젝트\\s*(?:계약|형)|구축\\s*(?:계약|형)"]],
      },
    ],
  ],
]);
const COMPARE_ASKED = /비교|차이|대비|(?<![가-힣])보다|(?:중|가운데)(?:에서)?\s*(?:어느|어디|누가|누구|무엇|뭐|더)|더\s*(?:많|높|크|큰|적|낮|작|비싸|싸|길|짧)|\bvs\.?(?![A-Za-z])|(?<=\s)대(?=\s)/i;

/** 가린 문장의 i 자리를 둘러싼 가장 안쪽 하위 질의(괄호 안이 SELECT, WITH 로 시작)의 여는 괄호 자리. 바깥이면 -1. 바깥의 집합 연산(UNION 등)으로 갈린
 * 가지는 -2 - 가지 번호. */
function queryScope(masked: string, i: number): number {
  const open: number[] = [];
  for (let k = 0; k < i; k++) {
    if (masked[k] === "(") open.push(k);
    else if (masked[k] === ")") open.pop();
  }
  for (let j = open.length - 1; j >= 0; j--) if (/^\(\s*(?:select|with)\b/i.test(masked.slice(open[j], open[j] + 12))) return open[j];
  const d = depths(masked);
  let branch = 0;
  for (const m of masked.matchAll(/\b(?:union|intersect|except)\b/gi)) if ((m.index ?? 0) < i && d?.[m.index ?? 0] === 0) branch++;
  return -2 - branch;
}

/** ⑧-10 한 열의 두 값(서울과 부산, 대기업과 스타트업, 영업팀과 기술지원팀)을 견주는 질문인데 생성 SQL 이 두 값을 한 묶음으로 섞어 세거나(IN 으로 함께
 * 고르고 다른 열로 묶음) 한 값을 빠뜨리면 견줄 값이 나오지 않는다. 「서울 고객사와 부산 고객사의 매출을 비교해줘」에 c.region IN ('서울', '부산') 을
 * 고객사로 묶어 「Client-Q 의 매출이 가장 높아요」라고 답했고(서울 67,714, 부산 15,744. 랜덤 테스트 사전 점검 5차 P6, CG02 3/3), 「영업팀과 기술지원팀
 * 평균 연봉 차이」에 영업팀만 자기 조인해 0 을 냈다(CG01). 그 열로 묶거나(GROUP BY, PARTITION BY), 값마다 식 안(CASE, FILTER)이나 따로 된 하위
 * 질의에서 고르면 보지 않는다. */
export function checkCompareGroups(sql: string, question: string, schema: string): string[] {
  const families = COMPARE_FAMILIES.get(schema);
  if (!families || !COMPARE_ASKED.test(question)) return [];
  const masked = maskSql(sql);
  if (masked === null || !depths(masked)) return [];
  const reasons: string[] = [];
  let rest = question;
  for (const f of families) {
    const hits: [number, string][] = [];
    for (const [value, words] of f.values) {
      const m = new RegExp(`(?:${words})${VALUE_TAIL}`).exec(rest);
      if (m) hits.push([m.index ?? 0, value]);
      if (f.col === "departments.name") rest = rest.replace(new RegExp(words, "g"), (w) => " ".repeat(w.length));
    }
    const said = hits.sort((a, b) => a[0] - b[0]).map(([, v]) => v);
    if (said.length !== 2) continue;
    const alias = aliasTables(masked, new Set(f.keys.map((k) => k.split(".")[0]).filter((t) => t !== "*").concat(["employees", "contracts", "projects", "support_tickets"])));
    const refRe = new RegExp(`(?<![A-Za-z0-9_$.])(?:(${IDENT})\\.)?(${IDENT})(?![A-Za-z0-9_$])`, "g");
    const isKey = (q: string | undefined, c: string) =>
      f.keys.some((k) => {
        const [t, col] = k.split(".");
        if (col !== c.toLowerCase()) return false;
        if (t === "*") return true;
        return q ? alias.get(q.toLowerCase())?.has(t) ?? false : true;
      });
    const keyed = (text: string) => [...text.matchAll(refRe)].some((r) => isKey(r[1], r[2]));
    const d = depths(masked)!;
    const clause = (kw: RegExp) =>
      [...masked.matchAll(kw)].map((m) => {
        const from = (m.index ?? 0) + m[0].length;
        const level = d[m.index ?? 0];
        const stop = /\b(?:having|order|limit|offset|fetch|window|union|intersect|except)\b|\)/gi;
        stop.lastIndex = from;
        let end = masked.length;
        for (let s = stop.exec(masked); s; s = stop.exec(masked)) {
          if (s[0] === ")" ? d[s.index ?? 0] < level : d[s.index ?? 0] === level) {
            end = s.index ?? 0;
            break;
          }
        }
        return masked.slice(from, end);
      });
    const spans = exprSpans(masked);
    const at = (v: string) => [...sql.matchAll(new RegExp(`'${v}'`, "g"))].map((m) => m.index ?? 0).filter((i) => masked[i] === "'");
    const where = said.map(at);
    const missing = said.filter((_, i) => !where[i].length);
    if (clause(/\bgroup\s+by\b/gi).some(keyed) || clause(/\bpartition\s+by\b/gi).some(keyed)) {
      // 그 열로 묶어도 두 값으로 거르지 않고 전체 묶음에서 한 행만 고르면 두 값을 견주지 않는다: 「critical 티켓과 high 티켓 중 미해결이 더 많은 쪽은?」에
      // 미해결 1위 우선순위 medium 한 행을 골랐다(랜덤 테스트 사전 점검 6차 P3, CP10 3/3).
      const tail = ONE_ROW_TAIL.exec(masked);
      if (!missing.length || !tail || d[tail.index] !== 0) continue;
      const ref = [...masked.matchAll(refRe)].find((r) => isKey(r[1], r[2]) && !/^(?:id|dept_id)$/i.test(r[2]))?.[0] ?? f.col;
      reasons.push(
        `${COMPARE_REASON}질문은 '${said[0]}' 과 '${said[1]}' 을 견주는데 SQL 이 그 두 값으로 거르지 않고 전체 묶음에서 한 행만 고른다. ` +
          `${ref} IN ('${said[0]}', '${said[1]}') 로 거른 뒤 ${ref} 로 묶어 두 값을 함께 낸다`,
      );
      continue;
    }
    if (!missing.length) {
      if (where.every((ps) => ps.some((p) => spans.some(([s, e]) => p >= s && p < e)))) continue;
      const scopes = where.map((ps) => new Set(ps.map((p) => queryScope(masked, p))));
      if (![...scopes[0]].some((s) => scopes[1].has(s))) continue;
    }
    const ref = [...masked.matchAll(refRe)].find((r) => isKey(r[1], r[2]) && !/^(?:id|dept_id)$/i.test(r[2]))?.[0] ?? f.col;
    const lit = (v: string) => `'${v}'`;
    reasons.push(
      `${COMPARE_REASON}질문은 ${lit(said[0])} 과 ${lit(said[1])} 을 견주는데 ` +
        (missing.length ? `SQL 에 ${missing.map(lit).join(", ")} 이 없다(한쪽만 고른다). ` : `SQL 이 두 값을 한 묶음으로 섞어 센다. `) +
        `${ref} 로 묶어(GROUP BY ${ref}) 값마다 한 행을 내거나, 값마다 따로 집계해(AVG(…) FILTER (WHERE ${ref} = ${lit(said[0])})) 견준다`,
    );
  }
  return reasons;
}

/** 모순 조건 사유의 머리말. */
const CONTRADICTION_REASON = "모순 조건 ";

/** ⑧-11 바깥 질의의 AND 조건(WHERE, 안쪽 조인의 ON)이 함께 참일 수 없으면 그 SQL 은 늘 0행이거나 집계가 null 이다. 「영업팀과 기술지원팀 평균 연봉
 * 차이는 얼마야?」에 e2.dept_id = d.id, d.name = '영업팀', e2.dept_id = (SELECT id … WHERE name = '기술지원팀') 을 함께 걸어 null 을 냈고 답은 「조건에
 * 맞는 행이 없어 집계한 값이 없습니다」였다(랜덤 테스트 사전 점검 5차 P6, CG01). 같다는 조건으로 이어진 열과 값을 묶어 ① 한 묶음에 서로 다른 값 둘
 * ② 표의 id 가 「이름이 X 인 행의 id」(하위 질의)와 같은데 그 행의 이름이 X 가 아님 ③ 같은 묶음끼리 다르다는 조건(<>, !=)을 본다. OR 가 바깥에
 * 있는 절, LEFT, RIGHT, FULL 조인의 ON, 하위 질의 안은 보지 않는다. */
export function checkContradiction(sql: string, known: ReadonlySet<string>): string[] {
  const masked = maskSql(sql);
  const d = masked === null ? null : depths(masked);
  if (masked === null || !d) return [];
  // 바깥 집합 연산(UNION 등)의 가지는 서로 다른 행을 고르므로 가지마다 따로 본다(같은 별칭을 써도 다른 표 읽기다).
  const setOps = [...masked.matchAll(/\b(?:union|intersect|except)\b(?:\s+(?:all|distinct)\b)?/gi)].filter((m) => d[m.index ?? 0] === 0);
  if (setOps.length) {
    const cuts = [0, ...setOps.flatMap((m) => [m.index ?? 0, (m.index ?? 0) + m[0].length]), sql.length];
    const out: string[] = [];
    for (let k = 0; k < cuts.length; k += 2) out.push(...checkContradiction(sql.slice(cuts[k], cuts[k + 1]), known));
    return out;
  }
  const alias = aliasTables(masked, known);
  // LEFT(…), RIGHT(…) 같은 함수 호출은 절 키워드가 아니다.
  const top = [...masked.matchAll(/\b(where|on|group|having|order|limit|offset|fetch|union|intersect|except|window|join|left|right|full|inner|cross|natural)\b(?!\s*\()/gi)].filter(
    (m) => d[m.index ?? 0] === 0,
  );
  const clauses: string[] = [];
  top.forEach((m, k) => {
    const w = m[1].toLowerCase();
    if (w !== "where" && w !== "on") return;
    if (w === "on") {
      const joinAt = top.slice(0, k).reverse().find((x) => x[1].toLowerCase() === "join");
      const before = joinAt ? masked.slice(Math.max(0, (joinAt.index ?? 0) - 12), joinAt.index ?? 0) : "";
      if (/\b(?:left|right|full)\b(?:\s+outer)?\s*$/i.test(before)) return;
    }
    const from = (m.index ?? 0) + m[0].length;
    const next = top.slice(k + 1).find((x) => !/^(?:on)$/i.test(x[1]) || w === "on");
    let end = next ? next.index ?? masked.length : masked.length;
    const comma = masked.slice(from, end).search(/,/);
    if (w === "on" && comma >= 0 && d[from + comma] === 0) end = from + comma;
    clauses.push(`${from}:${end}`);
  });
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    while (parent.has(x) && parent.get(x) !== x) x = parent.get(x)!;
    return x;
  };
  const union = (a: string, b: string) => {
    const [x, y] = [find(a), find(b)];
    if (x !== y) parent.set(x, y);
    if (!parent.has(y)) parent.set(y, y);
  };
  const said = new Map<string, string>(); // 낱말 → 그 낱말이 든 조건 원문
  const unequal: [string, string, string][] = [];
  const term = (s: string, o: string): string | null => {
    const t = s.trim();
    const lit = /^'((?:[^']|'')*)'$/.exec(o.trim());
    if (lit) return `lit:${lit[1]}`;
    if (/^-?\d+(?:\.\d+)?$/.test(t)) return `num:${Number(t)}`;
    const sub = new RegExp(
      `^\\(\\s*select\\s+(?:${IDENT}\\.)?(${IDENT})\\s+from\\s+(?:${IDENT}\\.)?(${IDENT})(?:\\s+(?:as\\s+)?${IDENT})?\\s+where\\s+(?:${IDENT}\\.)?(${IDENT})\\s*=\\s*'((?:[^']|'')*)'\\s*\\)$`,
      "i",
    ).exec(o.trim());
    if (sub) return `sub:${sub[2].toLowerCase()}.${sub[1].toLowerCase()}|${sub[3].toLowerCase()}=${sub[4]}`;
    const col = new RegExp(`^(?:${IDENT}\\.)?(${IDENT})\\.(${IDENT})$`).exec(t);
    if (col && alias.has(col[1].toLowerCase())) return `col:${col[1].toLowerCase()}.${col[2].toLowerCase()}`;
    return null;
  };
  for (const span of clauses) {
    const [from, end] = span.split(":").map(Number);
    if ([...masked.slice(from, end).matchAll(/\bor\b/gi)].some((m) => d[from + (m.index ?? 0)] === 0)) continue;
    // 바깥 깊이의 AND 로 가른다(BETWEEN … AND 의 AND 는 가르지 않는다).
    const parts: [number, number][] = [];
    let start = from;
    let between = false;
    for (const m of masked.slice(from, end).matchAll(/\b(and|between)\b/gi)) {
      const at = from + (m.index ?? 0);
      if (d[at] !== 0) continue;
      if (m[1].toLowerCase() === "between") between = true;
      else if (between) between = false;
      else {
        parts.push([start, at]);
        start = at + 3;
      }
    }
    parts.push([start, end]);
    for (const [s, e] of parts) {
      const cm = masked.slice(s, e);
      const op = [...cm.matchAll(/<>|!=|=/g)].filter((x) => d[s + (x.index ?? 0)] === 0 && !/[<>!]/.test(cm[(x.index ?? 0) - 1] ?? ""));
      if (op.length !== 1) continue;
      const i = op[0].index ?? 0;
      const [lm, rm] = [cm.slice(0, i), cm.slice(i + op[0][0].length)];
      const [lo, ro] = [sql.slice(s, s + i), sql.slice(s + i + op[0][0].length, e)];
      const [a, b] = [term(lm, lo), term(rm, ro)];
      if (!a || !b) continue;
      const text = sql.slice(s, e).replace(/\s+/g, " ").trim();
      if (op[0][0] === "=") {
        union(a, b);
        for (const x of [a, b]) if (!said.has(x)) said.set(x, text);
      } else unequal.push([a, b, text]);
    }
  }
  const groups = new Map<string, string[]>();
  for (const x of parent.keys()) {
    const r = find(x);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r)!.push(x);
  }
  const reasons: string[] = [];
  const push = (conds: string[], why: string) =>
    reasons.push(
      `${CONTRADICTION_REASON}${[...new Set(conds)].join(" 과 ")} 은 함께 참일 수 없다(${why}). 이 SQL 은 늘 0행이거나 집계가 null 이다. ` +
        "두 값을 견주려면 값마다 따로 집계하거나(FILTER, 하위 질의) 그 열로 묶는다(GROUP BY)",
    );
  for (const members of groups.values()) {
    const values = members.filter((x) => x.startsWith("lit:") || x.startsWith("num:"));
    const cols = members.filter((x) => x.startsWith("col:"));
    if (values.length > 1 && cols.length) {
      push(values.map((v) => said.get(v)!), `${cols[0].slice(4)} 가 ${values.map((v) => v.slice(4)).join(", ")} 를 함께 가져야 한다`);
      continue;
    }
    const subs = members.filter((x) => x.startsWith("sub:"));
    const byKey = new Map<string, string[]>();
    for (const s of subs) {
      const [, key, val] = /^sub:([^|]+)\|([^=]+)=(.*)$/.exec(s)!;
      const k = `${key}|${val}`;
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k)!.push(s);
    }
    // 같은 표의 id 를 서로 다른 이름의 행 id 와 함께 같다고 걸면 모순이다(이름이 다른 두 행의 id 는 다르다).
    for (const [k, list] of byKey) {
      const vals = new Set(list.map((s) => s.split("=").slice(1).join("=")));
      if (vals.size > 1 && k.split("|")[0].endsWith(".id")) push(list.map((s) => said.get(s)!), `${k.split("|")[0]} 가 이름이 다른 두 행을 함께 가리켜야 한다`);
    }
    for (const s of subs) {
      const [, table, keyCol, col, val] = /^sub:([^.]+)\.([^|]+)\|([^=]+)=(.*)$/.exec(s)!;
      if (keyCol !== "id") continue;
      for (const c of cols) {
        const [a, cc] = c.slice(4).split(".");
        if (cc !== "id" || !alias.get(a)?.has(table)) continue;
        const own = find(`col:${a}.${col}`);
        const other = (groups.get(own) ?? []).find((x) => x.startsWith("lit:") && x.slice(4) !== val);
        if (other) push([said.get(other)!, said.get(s)!], `${a} 한 행의 ${col} 이 '${other.slice(4)}' 이면서 '${val}' 이어야 한다`);
      }
    }
  }
  for (const [a, b, text] of unequal) if (find(a) === find(b) && parent.has(a)) push([text, said.get(a) ?? text], `${a.slice(4)} 와 ${b.slice(4)} 는 다른 조건으로 같다고 묶여 있다`);
  return reasons;
}

/** 출력 형식 사유의 머리말. */
const FORMAT_REASON = "출력 형식 ";
const JSON_BUILDERS = /\b(json_agg|jsonb_agg|json_build_object|jsonb_build_object|json_object_agg|jsonb_object_agg|row_to_json|to_json|to_jsonb|json_build_array|jsonb_build_array|array_to_json)\s*\(/i;

/** ⑧-12 바깥 SELECT 가 행을 JSON 값으로 묶으면(json_agg, json_build_object, row_to_json, to_json) 조회 결과는 JSON 값 하나이고 답 단계는 그 안의 값을
 * 읽지 못한다. 「영업팀 직원 목록을 JSON으로 줘」에 json_agg(json_build_object(…)) 한 행을 받아 없는 직원 10명과 이메일, 연봉을 지어 냈다(랜덤 테스트
 * 사전 점검 5차 P1, OS04 3/3). 열로 고르게 한다. 답의 형식(JSON, 표)은 답 단계가 행으로 만든다. */
export function checkJsonOutput(sql: string): string[] {
  const masked = maskSql(sql);
  const d = masked === null ? null : depths(masked);
  if (masked === null || !d) return [];
  const selects = [...masked.matchAll(/\bselect\b/gi)].filter((m) => d[m.index ?? 0] === 0);
  const main = selects[selects.length - 1];
  if (!main) return [];
  const from = [...masked.matchAll(/\bfrom\b/gi)].find((m) => (m.index ?? 0) > (main.index ?? 0) && d[m.index ?? 0] === 0);
  const list = masked.slice((main.index ?? 0) + 6, from?.index ?? masked.length);
  const hit = JSON_BUILDERS.exec(list);
  if (!hit) return [];
  // json_build_object('name', e.name, 'email', e.email …) 의 값 자리를 열 목록 예로 든다.
  const build = /json_build_object\s*\(/i.exec(list);
  let cols: string[] = [];
  if (build) {
    const at = (main.index ?? 0) + 6 + (build.index ?? 0) + build[0].length;
    const args: string[] = [];
    let depth = 0;
    let start = at;
    for (let i = at; i < masked.length; i++) {
      const c = masked[i];
      if (c === "(") depth++;
      else if (c === ")" && depth-- === 0) {
        args.push(sql.slice(start, i).trim());
        break;
      } else if (c === "," && depth === 0) {
        args.push(sql.slice(start, i).trim());
        start = i + 1;
      }
    }
    cols = args.filter((_, i) => i % 2 === 1).filter((a) => a.length < 60);
  }
  return [
    `${FORMAT_REASON}바깥 SELECT 가 행을 JSON 값(${hit[1]})으로 묶는다(조회 결과가 JSON 값 하나라 답 단계가 그 안의 값을 읽지 못한다). ` +
      `JSON 으로 묶지 않고 열로 고른다(SELECT ${cols.length ? cols.join(", ") : "열1, 열2, …"} FROM …). JSON 이나 표 같은 답의 형식은 답 단계가 행으로 만든다`,
  ];
}

/** 질문에 없는 번호로 건 id 조건 가운데 그 행의 이름(name 열)이 질문에 그대로 있는 것은 거부하지 않는다.
 * 「Client-N에 메일 보내야 돼」에 c.id = 14 는 Client-N 을 가리키므로 추측이 아니다(qwen3.5:9b 홀드아웃3 h3-05,
 * 정답으로 채점된 SQL). 「연봉 알려줘」의 e.id = 1(윤소연)은 질문에 이름이 없어 그대로 거부한다. 표 이름은
 * 선언된 외래키에 나온 표로만 쓰고, 행을 읽지 못하면 거부를 유지한다. 남는 사유를 돌려준다. */
export async function confirmNamedIds(pool: Pool, schema: string, check: SqlCheck, question: string): Promise<string[]> {
  const left: string[] = [...check.reasons];
  for (const ref of check.ids) {
    let named = false;
    for (const t of ref.tables) {
      if (!/^[a-z_][a-z0-9_]*$/.test(t) || !/^[a-z_][a-z0-9_]*$/.test(schema)) continue;
      try {
        const res = await pool.query(`SELECT name::text AS name FROM ${schema}.${t} WHERE id = $1`, [ref.num]);
        const name = (res?.rows?.[0] as { name?: unknown } | undefined)?.name;
        if (typeof name === "string" && name && question.includes(name)) named = true;
      } catch {
        /* name 열이 없는 표(sales 등)거나 읽지 못함: 거부 유지 */
      }
    }
    if (!named) left.push(ref.reason);
  }
  return left;
}

const FK_SQL = `
  SELECT cl.relname AS table_name, a.attname AS column_name, fcl.relname AS ref_table, fa.attname AS ref_column
    FROM pg_constraint co
    JOIN pg_class cl ON cl.oid = co.conrelid
    JOIN pg_namespace n ON n.oid = cl.relnamespace
    JOIN pg_class fcl ON fcl.oid = co.confrelid
   CROSS JOIN LATERAL unnest(co.conkey, co.confkey) AS k(src, dst)
    JOIN pg_attribute a ON a.attrelid = co.conrelid AND a.attnum = k.src
    JOIN pg_attribute fa ON fa.attrelid = co.confrelid AND fa.attnum = k.dst
   WHERE co.contype = 'f' AND n.nspname = $1`;

const fkCache = new WeakMap<object, Map<string, ForeignKey[]>>();

/** 스키마에 선언된 외래키(데이터셋 DDL 의 REFERENCES 와 ALTER TABLE … FOREIGN KEY). 풀마다 한 번 읽는다.
 * 스키마 카드의 REFERENCES 와 같고, 카드가 주석으로만 적은 departments.head_id → employees.id 도 들어 있다.
 * 읽지 못하면 null(그때 조인 검사는 꺼진다. 조회 자체도 실패하므로 그 오류가 따로 보인다). */
export async function declaredForeignKeys(pool: Pool, schema: string): Promise<ForeignKey[] | null> {
  const hit = fkCache.get(pool)?.get(schema);
  if (hit) return hit;
  try {
    const res = await pool.query(FK_SQL, [schema]);
    const rows = (res?.rows ?? []) as Record<string, unknown>[];
    const fks = rows
      .filter((r) => [r.table_name, r.column_name, r.ref_table, r.ref_column].every((v) => typeof v === "string"))
      .map((r) => ({
        table: String(r.table_name),
        column: String(r.column_name),
        refTable: String(r.ref_table),
        refColumn: String(r.ref_column),
      }));
    if (!fkCache.has(pool)) fkCache.set(pool, new Map());
    fkCache.get(pool)!.set(schema, fks);
    return fks;
  } catch {
    return null;
  }
}

const COLUMNS_SQL = `
  SELECT c.relname AS table_name, a.attname AS column_name
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = $1 AND a.attnum > 0 AND NOT a.attisdropped AND c.relkind IN ('r', 'v', 'm', 'p', 'f')`;

const colCache = new WeakMap<object, Map<string, TableColumns>>();

/** 스키마의 표마다 열 이름. 풀마다 한 번 읽는다(카탈로그라 권한에 따라 가려지지 않는다). 읽지 못하면 null(없는 열 사유를
 * 쓰지 않고 종전 사유로 둔다). */
export async function declaredColumns(pool: Pool, schema: string): Promise<TableColumns | null> {
  const hit = colCache.get(pool)?.get(schema);
  if (hit) return hit;
  try {
    const res = await pool.query(COLUMNS_SQL, [schema]);
    const cols = new Map<string, Set<string>>();
    for (const r of (res?.rows ?? []) as Record<string, unknown>[]) {
      if (typeof r.table_name !== "string" || typeof r.column_name !== "string") continue;
      if (!cols.has(r.table_name)) cols.set(r.table_name, new Set());
      cols.get(r.table_name)!.add(r.column_name);
    }
    if (!colCache.has(pool)) colCache.set(pool, new Map());
    colCache.get(pool)!.set(schema, cols);
    return cols;
  } catch {
    return null;
  }
}

/** 시각 열(timestamp)마다. 날짜 열(registered_at, hire_date 등)은 날짜 하나로 끝을 골라도 맞아 넣지 않는다. 스키마마다 둔다. */
const TIMESTAMP_COLUMNS = new Map<string, readonly string[]>([["companyx", ["created_at", "resolved_at"]]]);

/** ⑤-6 시각 열을 날짜 하나로 끝내 고르면(created_at <= '2025-12-31', BETWEEN … AND '2025-12-31') 그날 0시 뒤의 시각이 빠진다. 「2025년까지 접수된
 * 티켓은 몇 건이야?」에 2025-12-31 20:22 에 접수된 티켓을 빼고 102건을 답했다(실제 103건. 랜덤 테스트 사전 점검 6차 P16, MR11 3/3). 시각이 붙은
 * 값('2025-12-31 23:59:59'), 날짜로 바꾼 열(created_at::date), 날짜 열은 보지 않는다. */
export function checkTimestampEnd(sql: string, schema: string): string[] {
  const cols = TIMESTAMP_COLUMNS.get(schema);
  const masked = cols?.length ? maskSql(sql) : null;
  if (!cols || masked === null) return [];
  const col = `((?:${IDENT}\\.)?(?:${cols.join("|")}))`;
  const day = "'(\\d{4})-(\\d{2})-(\\d{2})'";
  const reasons: string[] = [];
  const next = (y: string, m: string, d: string) => new Date(Date.UTC(Number(y), Number(m) - 1, Number(d) + 1)).toISOString().slice(0, 10);
  const outside = (at: number, len: number) => masked.slice(at, at + len) === sql.slice(at, at + len);
  for (const m of sql.matchAll(new RegExp(`(?<![A-Za-z0-9_$.])${col}\\s*<=\\s*${day}`, "gi"))) {
    if (!outside(m.index ?? 0, m[1].length)) continue;
    const end = `${m[2]}-${m[3]}-${m[4]}`;
    reasons.push(
      `${PERIOD_REASON}${m[0].replace(/\s+/g, " ")} 은 시각 열이라 ${end} 0시 뒤의 시각(그날 낮 시각)이 빠진다. ${m[1]} < '${next(m[2], m[3], m[4])}' 로 고른다`,
    );
  }
  for (const m of sql.matchAll(new RegExp(`(?<![A-Za-z0-9_$.])${col}\\s+between\\s+('[^']*')\\s+and\\s+${day}`, "gi"))) {
    if (!outside(m.index ?? 0, m[1].length)) continue;
    const end = `${m[3]}-${m[4]}-${m[5]}`;
    reasons.push(
      `${PERIOD_REASON}${m[0].replace(/\s+/g, " ")} 은 시각 열이라 ${end} 0시 뒤의 시각(그날 낮 시각)이 빠진다. ` +
        `${m[1]} >= ${m[2]} AND ${m[1]} < '${next(m[3], m[4], m[5])}' 로 고른다`,
    );
  }
  return reasons;
}

/** 견줌을 묻는 말. 「작년 같은 분기 매출은 얼마였어?」처럼 이 말이 없으면 한 기간을 묻는다. */
const YOY_COMPARE = /대비|비교|증감|증가|감소|늘|줄|차이|보다|성장|변화|변동/;

/** 「작년 동기 대비 매출 증감률은?」, 「작년 같은 분기 대비 …」처럼 분기를 따로 말하지 않고 이번 분기를 1년 전 같은 분기와 견주는 질문의 두 분기
 * ('YYYY-Qn', 서울 기준). 견주는 말이 없거나 분기, 연도를 따로 말하면 null. */
export function sameQuarterCompare(question: string, now: Date = new Date()): { current: string; target: string } | null {
  const t = sameQuarterLastYear(question, now);
  if (!t || !YOY_COMPARE.test(question)) return null;
  return { current: `${t.year + 1}-Q${t.quarter}`, target: `${t.year}-Q${t.quarter}` };
}

/** 분기마다 매출 합계에서 마지막 분기와 그 1년 전 같은 분기(둘 다 매출이 있는 분기 가운데 마지막). 이번 분기 매출이 아직 없을 때 견줄 수 있는 값으로 쓴다. */
export function lastSameQuarterSql(schema: string): string {
  return (
    `WITH q AS (SELECT quarter, SUM(amount) AS amount FROM ${schema}.sales GROUP BY quarter) ` +
    "SELECT cur.quarter, cur.amount, prev.quarter AS prev_quarter, prev.amount AS prev_amount, " +
    "ROUND((cur.amount - prev.amount)::numeric * 100 / NULLIF(prev.amount, 0), 2) AS change_pct " +
    "FROM q cur JOIN q prev ON prev.quarter = (CAST(LEFT(cur.quarter, 4) AS integer) - 1) || RIGHT(cur.quarter, 3) " +
    "ORDER BY cur.quarter DESC LIMIT 1"
  );
}

/** 「작년 동기 대비」인데 이번 분기 매출이 아직 없는 사유. untrustedAnswer 가 gate.sameQuarter 로 결정론 문장을 쓴다. */
export function noCurrentQuarterReason(c: { current: string; target: string }): string {
  return (
    `${PERIOD_REASON}질문의 「작년 동기」는 이번 분기(${quarterLabel(c.current)})를 1년 전 같은 분기(${quarterLabel(c.target)})와 견주는데 ` +
    `이번 분기 매출이 아직 없다(sales 에 quarter = '${c.current}' 행이 없다). 생성 SQL 은 견줄 수 없는 기간을 견준다`
  );
}

const quarterLabel = (q: string) => q.replace(/^(\d{4})-Q([1-4])$/, "$1년 $2분기");

const EXPLICIT_QUARTER = /(\d{4})\s*년\s*(?:도\s*)?([1-4])\s*분기/g;
const PREV_YEAR_SAME = /(?:전년|작년|지난해)\s*(?:의\s*)?(?:같은\s*분기|동일\s*분기|동\s*분기|동기)/;

/** ⑤-7 분기를 말하고 그 분기를 1년 전 같은 분기와 견주는데(「2025년 3분기 매출을 전년 같은 분기와 비교해줘」) 생성 SQL 의 분기 값 조건이 그 분기 하나만
 * 남기면 견줄 값이 없다. WHERE s.quarter = '2025-Q3' 위의 LAG(SUM(s.amount)) 가 모두 null 인데 「높아요」라고 답했다(2025-Q3 23,859, 2024-Q3 22,730.
 * 랜덤 테스트 사전 점검 6차 P4, MR14 2/3). 분기 값 조건이 없거나(날짜 범위) 그 분기를 고르지 않는 SQL 은 보지 않는다(다른 기간 검사가 본다). */
export function checkExplicitYoy(sql: string, question: string): string[] {
  if (!PREV_YEAR_SAME.test(question) || !YOY_COMPARE.test(question)) return [];
  const asked = [...question.matchAll(EXPLICIT_QUARTER)];
  if (asked.length !== 1 || maskSql(sql) === null) return [];
  const [y, q] = [Number(asked[0][1]), Number(asked[0][2])];
  const conds = [...sql.matchAll(/(?<![A-Za-z0-9_$])(?:[A-Za-z_][A-Za-z0-9_]*\.)?quarter(?:\s*(?:=|i?like)\s*'[^']*'|\s+in\s*\([^()]*\))/gi)];
  const chosen = conds.length ? pickedQuarters(conds) : null;
  if (!chosen || !chosen.has(y * 4 + q - 1) || chosen.has((y - 1) * 4 + q - 1)) return [];
  const picked = [...new Set(conds.map((c) => c[0].replace(/\s+/g, " ")))].join(", ");
  return [
    `${PERIOD_REASON}${picked} 은 ${y}년 ${q}분기만 남겨 1년 전 같은 분기(${y - 1}년 ${q}분기)와 견줄 값이 없다(LAG 가 닿을 행이 없다). ` +
      `quarter IN ('${y}-Q${q}', '${y - 1}-Q${q}') 로 두 분기를 고르고 GROUP BY quarter 로 분기마다 합계를 견준다`,
  ];
}

/** 최근 추이 질문(「최근 매출 추이는 어때?」). */
const RECENT_TREND = /(?:최근|요즘|요새|근래|요즈음)[^?]*?(?:추이|흐름|추세|트렌드|변화)/;
const ROLLING_CUT = /(?<![A-Za-z0-9_$.])((?:[A-Za-z_][A-Za-z0-9_]*\.)?[A-Za-z_][A-Za-z0-9_]*(?:_date|_at))\s*>=?\s*(?:current_date|now\s*\(\s*\)|current_timestamp)\s*-\s*interval\s*'[^']*'/i;

/** 끝난 분기 네 개를 고르는 안내. 이번 분기(서울 기준)는 아직 끝나지 않았다. */
function recentQuartersHint(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Seoul", year: "numeric", month: "numeric" }).formatToParts(now);
  const part = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const current = `${part("year")}-Q${Math.floor((part("month") - 1) / 3) + 1}`;
  return (
    `끝난 분기를 통째로 견준다: SELECT quarter, SUM(amount) AS total FROM companyx.sales WHERE quarter < '${current}' GROUP BY quarter ORDER BY quarter DESC LIMIT 4 ` +
    "(최근 분기 네 개). CURRENT_DATE - INTERVAL 로 자르면 맨 앞 분기가 중간에서 잘린다"
  );
}

/** ⑤-8 최근 추이를 묻는데 생성 SQL 이 분기로 묶으면서 오늘에서 거꾸로 잰 기간(sale_date >= CURRENT_DATE - INTERVAL '1 year')으로 자르면 맨 앞 분기를 일부만
 * 센다. 「최근 매출 추이는 어때?」에 2025년 4분기를 10월 8일부터의 29,939 로 적었다(실제 31,795. 랜덤 테스트 사전 점검 6차 P11, SP08 3/3). */
export function checkRollingQuarter(sql: string, question: string, now: Date = new Date()): string[] {
  if (!RECENT_TREND.test(question)) return [];
  const masked = maskSql(sql);
  const d = masked === null ? null : depths(masked);
  if (masked === null || !d) return [];
  const group = [...masked.matchAll(/\bgroup\s+by\b([^;]*)/gi)].find((m) => /(?<![A-Za-z0-9_$'])(?:[A-Za-z_][A-Za-z0-9_]*\.)?quarter(?![A-Za-z0-9_$'])/i.test(m[1]));
  const cut = ROLLING_CUT.exec(masked);
  if (!group || !cut) return [];
  return [
    `${PERIOD_REASON}${sql.slice(cut.index, cut.index + cut[0].length).replace(/\s+/g, " ")} 은 오늘에서 거꾸로 잰 기간이라 분기로 묶으면 맨 앞 분기를 일부만 센다. ${recentQuartersHint(now)}`,
  ];
}

/** 문법 사유 가운데 quarter 에 날짜 함수를 쓴 것. */
const QUARTER_TEXT_FN =
  /\b(?:extract\s*\(\s*[A-Za-z_]+\s+from\s+((?:[A-Za-z_][A-Za-z0-9_]*\.)?quarter)\s*\)|date_part\s*\(\s*'[^']*'\s*,\s*((?:[A-Za-z_][A-Za-z0-9_]*\.)?quarter)\s*\)|date_trunc\s*\(\s*'[^']*'\s*,\s*((?:[A-Za-z_][A-Za-z0-9_]*\.)?quarter)\s*\))/gi;

/** ⑨-2 sales.quarter 는 '2025-Q1' 꼴 글자인데 날짜 함수(EXTRACT, date_part, date_trunc)에 넣으면 PostgreSQL 이 읽지 못한다(42883). 「2025년 상반기 계약 금액은
 * 2024년 상반기보다 얼마나 많아?」의 EXTRACT(YEAR FROM quarter) 가 수리 뒤에도 남아 거절했다(랜덤 테스트 사전 점검 6차 P3, MR16 3/3). quarter 를 날짜로
 * 만든 별칭(AS quarter)이 있으면 보지 않는다. */
export function checkQuarterText(sql: string): string[] {
  const masked = maskSql(sql);
  if (masked === null || /\bas\s+quarter\b/i.test(masked)) return [];
  const hits = [...masked.matchAll(QUARTER_TEXT_FN)].map((m) => sql.slice(m.index ?? 0, (m.index ?? 0) + m[0].length).replace(/\s+/g, " "));
  if (!hits.length) return [];
  return [
    `${SYNTAX_REASON}${[...new Set(hits)].join(", ")} 의 quarter 는 '2025-Q1' 꼴 글자다(날짜가 아니라 날짜 함수가 읽지 못한다, 42883). ` +
      "연도는 quarter LIKE '2025-%' 나 LEFT(quarter, 4) = '2025', 분기는 quarter = '2025-Q1' 처럼 글자로 고르거나 날짜 열(sale_date, start_date)로 센다",
  ];
}

/** 상태 조건 사유의 머리말. */
const STATE_REASON = "상태 조건 ";
/** 열린 티켓을 가리키는 말(open, in_progress). 「처리 중」만이면 in_progress. 「아직 해결되지 않은 건」은 넣지 않았다(4차 P12 의 수리 SQL 을 받는 시험이
 * 상태 조건 없는 SQL 을 받는다). */
const OPEN_TICKET = /열린|열려\s*있|미해결|해결\s*안\s*(?:된|됨)/;
const IN_PROGRESS_TICKET = /처리\s*중/;

/** 질문이 말한 열린 티켓의 상태 조건(열 이름 없이): IN ('open', 'in_progress') 나 = 'in_progress'. 말하지 않았으면 null. */
function openTicketCondition(question: string): string | null {
  return OPEN_TICKET.test(question) ? "IN ('open', 'in_progress')" : IN_PROGRESS_TICKET.test(question) ? "= 'in_progress'" : null;
}

/** 생성 SQL 의 바깥 질의가 support_tickets 를 읽는 별칭(하나일 때만). 아니면 null. */
function topTicketAlias(masked: string, d: number[]): string | null {
  const binds = [...masked.matchAll(new RegExp(`\\b(?:from|join)\\s+(?:${IDENT}\\.)?support_tickets\\b(?:\\s+(?:as\\s+)?(${IDENT}))?`, "gi"))];
  if (binds.length !== 1 || d[binds[0].index ?? 0] !== 0) return null;
  const a = binds[0][1];
  return a && !NOT_ALIAS.has(a.toLowerCase()) ? a : "support_tickets";
}

/** ⑥-6 열린(미해결, 처리 중) 티켓을 묻는데 생성 SQL 이 티켓을 상태로 거르지 않으면 해결되거나 종결된 티켓도 고른다. 「우선순위별로 가장 오래 열린 티켓은?」에
 * 상태 조건 없이 묶음마다 1위를 골라 critical, high 줄에 해결된 티켓을 적었다(랜덤 테스트 사전 점검 6차 P12, TG04 3/3). 상태 열이나 해결 시각(resolved_at
 * IS NULL)으로 거르는 SQL, 티켓을 읽지 않는 SQL 은 보지 않는다. */
export function checkOpenTickets(sql: string, question: string): string[] {
  const want = openTicketCondition(question);
  const masked = want ? maskSql(sql) : null;
  if (!want || masked === null || !/\bsupport_tickets\b/i.test(masked)) return [];
  if (/\bstatus\b/i.test(masked) || /\bresolved_at\s+is\b/i.test(masked)) return [];
  const d = depths(masked);
  const alias = d ? topTicketAlias(masked, d) : null;
  const col = `${alias ?? "support_tickets"}.status`;
  return [
    `${STATE_REASON}질문은 ${want.startsWith("IN") ? "열린(해결되지 않은)" : "처리 중인"} 티켓을 묻는데 SQL 이 support_tickets.status 로 거르지 않는다` +
      `(해결되거나 종결된 티켓도 고른다). ${col} ${want} 로 고른다`,
  ];
}

/** checkOpenTickets 의 결정론 수리: 바깥 질의의 WHERE 에 열린 티켓 상태 조건을 더한다(WHERE 가 없으면 만든다). 묶음마다 1위 재작성(groupTopRewrite)은 이
 * 조건을 그대로 둔다. 바꿀 꼴이 아니면(WITH, 집합 연산, 티켓을 읽는 바깥 별칭이 하나가 아님, 읽지 못하는 문장) null. */
export function openStatusRewrite(sql: string, question: string): { text: string; cond: string } | null {
  const want = openTicketCondition(question);
  if (!want || !checkOpenTickets(sql, question).length) return null;
  const masked = maskSql(sql);
  const d = masked === null ? null : depths(masked);
  if (masked === null || !d || /^\s*(?:\(\s*)*with\b/i.test(masked)) return null;
  if ([...masked.matchAll(/\b(?:union|intersect|except)\b/gi)].some((m) => d[m.index ?? 0] === 0)) return null;
  const alias = topTicketAlias(masked, d);
  if (!alias) return null;
  const cond = `${alias}.status ${want}`;
  const body = masked.replace(/[\s;]+$/, "").length;
  const clauses = [...masked.slice(0, body).matchAll(/\b(where|group\s+by|having|order\s+by|limit|offset|fetch|window)\b/gi)].filter((m) => d[m.index ?? 0] === 0);
  const where = clauses.find((m) => /^where$/i.test(m[1]));
  if (where) {
    const after = (where.index ?? 0) + where[0].length;
    const stop = clauses.find((m) => (m.index ?? 0) > after)?.index ?? body;
    const rest = sql.slice(stop, body).trim();
    return { text: `${sql.slice(0, after)} ${cond} AND (${sql.slice(after, stop).trim()})${rest ? ` ${rest}` : ""}`, cond };
  }
  const at = clauses[0]?.index ?? body;
  const rest = sql.slice(at, body).trim();
  return { text: `${sql.slice(0, at).trimEnd()} WHERE ${cond}${rest ? ` ${rest}` : ""}`, cond };
}

/** 자기 조인의 같음 조건에서 열마다 그 열을 가리키는 질문 낱말. 여기 없는 열은 판정하지 않는다. */
const SELF_JOIN_WORDS: Readonly<Record<string, string>> = {
  client_id: "고객|회사|거래처",
  product_id: "제품|상품",
  manager_id: "담당|매니저|관리자",
  assignee_id: "담당|처리자",
  dept_id: "부서|팀",
  contract_id: "계약\\s*(?:건|번호)",
  region: "지역|도시",
  industry: "업종|산업",
  company_size: "규모",
  category: "분류|카테고리|종류",
  status: "상태",
  contract_type: "유형|종류|형태",
  priority: "우선\\s*순위|중요도",
  position: "직급|직책",
  start_date: "시작|착수|개시|날짜|일자",
  end_date: "종료|끝|만료|마감|날짜|일자",
  hire_date: "입사|날짜|일자",
  registered_at: "등록|가입|날짜|일자",
  created_at: "접수|생성|날짜|일자",
  sale_date: "날짜|일자|판매일|매출일",
  amount: "금액|매출",
  salary: "연봉|급여",
  budget: "예산",
  quarter: "분기",
};

/** 질문이 그 열을 가리키는 말을 하는가(SELF_JOIN_WORDS). 낱말을 두지 않은 열은 false. */
function selfJoinSaid(col: string, question: string): boolean {
  const words = SELF_JOIN_WORDS[col];
  return words !== undefined && new RegExp(words).test(question);
}

/** ⑥-7 같은 표를 두 번 읽는 자기 조인(c1, c2)에서 질문이 말한 열(같은 날 시작 → start_date)의 같음 조건 밖에 질문이 말하지 않은 열의 같음 조건(c1.client_id =
 * c2.client_id)을 더 걸면 그 쌍은 거의 없다. 「같은 날 시작한 계약이 있어?」에 고객사, 제품, 담당자까지 같은 쌍을 골랐다(랜덤 테스트 사전 점검 6차 P13, SJ06
 * 3/3. 같은 날 시작한 쌍은 둘이다). 질문이 말한 열이 하나도 없는 자기 조인은 판정하지 않는다. */
export function checkSelfJoin(sql: string, question: string, known: ReadonlySet<string>): string[] {
  const masked = maskSql(sql);
  if (masked === null) return [];
  const alias = aliasTables(masked, known);
  const pairs = new Map<string, { table: string; conds: [string, string][] }>();
  const eqRe = new RegExp(`(?<![A-Za-z0-9_.])(${IDENT})\\.(${IDENT})\\s*=\\s*(${IDENT})\\.(${IDENT})(?![A-Za-z0-9_.(])`, "g");
  for (const m of masked.matchAll(eqRe)) {
    const [a, ca, b, cb] = [m[1], m[2], m[3], m[4]].map((x) => x.toLowerCase());
    const ta = alias.get(a);
    const tb = alias.get(b);
    if (a === b || ca !== cb || ta?.size !== 1 || tb?.size !== 1) continue;
    const [t] = [...ta];
    if (!tb.has(t)) continue;
    const key = [a, b].sort().join("|");
    if (!pairs.has(key)) pairs.set(key, { table: t, conds: [] });
    pairs.get(key)!.conds.push([ca, sql.slice(m.index ?? 0, (m.index ?? 0) + m[0].length).replace(/\s+/g, " ")]);
  }
  const reasons: string[] = [];
  const said = (c: string) => selfJoinSaid(c, question);
  for (const { table, conds } of pairs.values()) {
    const keys = [...new Set(conds.filter(([c]) => said(c)).map(([c]) => c))];
    const extra = [...new Set(conds.filter(([c]) => SELF_JOIN_WORDS[c] !== undefined && !said(c)).map(([, t]) => t))];
    if (!keys.length || !extra.length) continue;
    reasons.push(
      `${UNASKED_REASON}${extra.join(", ")} 은 질문이 묻지 않은 조건이다(질문은 ${table} 두 행의 같은 ${keys.join(", ")} 만 묻는다). ` +
        "그 조건을 빼고 질문이 말한 조건만 건다",
    );
  }
  return reasons;
}

/** checkSelfJoin 의 결정론 수리: 질문이 말하지 않은 자기 조인 같음 조건을 AND 마디째 뺀다. 그 조건이 WHERE, ON 의 유일한 조건이거나 AND 로 이어지지 않으면 null. */
export function dropSelfJoinConditions(sql: string, reasons: readonly string[]): string | null {
  const conds = reasons.flatMap((r) => /^질문에 없는 조건 (.+?) 은 질문이 묻지 않은 조건이다\(질문은 \S+ 두 행의 같은 /.exec(r)?.[1].split(", ") ?? []);
  if (!conds.length || reasons.some((r) => !/^질문에 없는 조건 .+? 은 질문이 묻지 않은 조건이다\(질문은 \S+ 두 행의 같은 /.test(r))) return null;
  let out = sql;
  for (const c of conds) {
    const parts = c.split(/\s*=\s*/);
    if (parts.length !== 2) return null;
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const cond = `${esc(parts[0])}\\s*=\\s*${esc(parts[1])}(?![A-Za-z0-9_])`;
    const before = new RegExp(`\\s+and\\s+${cond}`, "i");
    const after = new RegExp(`${cond}\\s+and\\s+`, "i");
    const alone = new RegExp(`\\s+where\\s+${cond}\\s*(?=$|;|\\)|\\b(?:group|order|limit|having|offset|fetch|window|union|intersect|except)\\b)`, "i");
    const next = before.test(out) ? out.replace(before, "") : after.test(out) ? out.replace(after, "") : alone.test(out) ? out.replace(alone, " ") : null;
    if (next === null) return null;
    out = next;
  }
  return out === sql ? null : out.trim();
}

/** 별칭 사유의 머리말. */
const ALIAS_REASON = "별칭 ";

/** ⑨-3 FROM 에 없는 별칭(c.industry 의 c)이 쓰였고, 그 별칭으로 쓴 열이 모두 있는 표가 FROM 에 하나뿐이며 그 표의 별칭이 하나뿐이면 그 별칭으로 바꾼다.
 * 「업종별 고객사 수와 계약 금액 합계는?」의 FROM companyx.clients cl … GROUP BY c.industry 가 42P01 로 끝났고 수리도 같은 별칭을 남겼다(랜덤 테스트 사전 점검
 * 6차 P10, CJ05 3/3). 하위 질의나 WITH 가 있는 문장, 읽지 못하는 문장, 열 목록을 모를 때는 바꾸지 않는다. 바꾼 것이 없으면 null. */
export function realiasSql(sql: string, columns: TableColumns | null, known: ReadonlySet<string>): { text: string; reason: string } | null {
  const masked = columns ? maskSql(sql) : null;
  if (!columns || masked === null || /\bwith\b|\(\s*select\b/i.test(masked)) return null;
  const alias = aliasTables(masked, known);
  const toks = tokenizeSql(sql);
  if (!toks) return null;
  const used = new Map<string, Set<string>>(); // FROM 에 없는 별칭 → 그 별칭으로 쓴 열
  for (let i = 0; i + 2 < toks.length; i++) {
    const [q, dot, c] = [toks[i], toks[i + 1], toks[i + 2]];
    if (q.k !== "w" || dot.k !== "." || c.k !== "w" || toks[i - 1]?.k === "." || toks[i + 3]?.k === "." || toks[i + 3]?.k === "(") continue;
    if (alias.has(q.v) || KNOWN_SCHEMAS.has(q.v)) continue;
    if (!used.has(q.v)) used.set(q.v, new Set());
    used.get(q.v)!.add(c.v);
  }
  if (!used.size) return null;
  const tables = [...new Set([...alias.values()].flatMap((s) => [...s]))];
  const swap = new Map<string, string>();
  const notes: string[] = [];
  for (const [q, cols] of used) {
    const owners = tables.filter((t) => [...cols].every((c) => columns.get(t)?.has(c)));
    if (owners.length !== 1) return null;
    const names = [...alias.entries()].filter(([a, ts]) => ts.size === 1 && ts.has(owners[0]) && a !== owners[0]).map(([a]) => a);
    const to = names.length === 1 ? names[0] : names.length === 0 && alias.has(owners[0]) ? owners[0] : null;
    if (!to) return null;
    swap.set(q, to);
    notes.push(`${q} 는 FROM 에 없다(${[...cols].map((c) => `${q}.${c}`).join(", ")}). ${[...cols].join(", ")} 열이 있는 표 ${owners[0]} 의 별칭 ${to} 로 바꿨다`);
  }
  let out = sql;
  for (let i = toks.length - 3; i >= 0; i--) {
    const t = toks[i];
    if (t.k === "w" && toks[i + 1].k === "." && toks[i - 1]?.k !== "." && swap.has(t.v)) out = out.slice(0, t.at) + swap.get(t.v)! + out.slice(tokenEnd(sql, t));
  }
  return out === sql ? null : { text: out, reason: `${ALIAS_REASON}${notes.join(". ")}` };
}

/** 없는 열 사유의 머리말. */
const NO_COLUMN_REASON = "없는 열 ";

/** ⑨-4 수리까지 없는 열 오류(42703)로 끝난 SQL 의 마지막 수습: 바깥 SELECT 목록의 「별칭.열 [AS 이름]」 가운데 그 별칭의 표에 없는 열을 목록에서 뺀다. 목록에만
 * 있는 열이라 고르는 행은 그대로다. 「같은 날 시작한 계약이 있어?」의 c1.name(contracts 에 name 이 없다)을 수리도 남겨 42703 으로 거절했다(랜덤 테스트 사전 점검
 * 6차 P13, SJ06). 뺄 것이 없거나 다 빠지거나, 열 목록을 모르거나, 읽지 못하는 문장이면 null. */
export function dropMissingSelectColumns(sql: string, columns: TableColumns | null, known: ReadonlySet<string>): { text: string; reason: string } | null {
  const masked = columns ? maskSql(sql) : null;
  const toks = masked === null ? null : tokenizeSql(sql);
  if (!columns || masked === null || !toks?.length) return null;
  const alias = aliasTables(masked, known);
  let level = 0;
  const depth = toks.map((t) => {
    if (t.k === ")") level--;
    const d = level;
    if (t.k === "(") level++;
    return d;
  });
  if (toks[0].k !== "w" || toks[0].v !== "select") return null;
  const from = toks.findIndex((t, i) => depth[i] === 0 && t.k === "w" && t.v === "from");
  if (from < 2) return null;
  const items: [number, number][] = [];
  let start = toks[1].k === "w" && toks[1].v === "distinct" ? 2 : 1;
  const head = start;
  for (let i = start; i <= from; i++) {
    if (i === from || (depth[i] === 0 && toks[i].k === ",")) {
      items.push([start, i]);
      start = i + 1;
    }
  }
  const gone: string[] = [];
  const kept = items.filter(([lo, hi]) => {
    const t = toks.slice(lo, hi);
    const simple = t.length >= 3 && t[0].k === "w" && t[1].k === "." && t[2].k === "w" && (t.length === 3 || (t.length === 4 && t[3].k === "w") || (t.length === 5 && t[3].v === "as"));
    if (!simple) return true;
    const owners = alias.get(t[0].v);
    if (owners?.size !== 1) return true;
    const [table] = [...owners];
    if (!columns.get(table)?.size || columns.get(table)!.has(t[2].v)) return true;
    gone.push(`${t[0].v}.${t[2].v} 은 ${table} 에 없다`);
    return false;
  });
  if (!gone.length || !kept.length) return null;
  const list = kept.map(([lo, hi]) => sql.slice(toks[lo].at, tokenEnd(sql, toks[hi - 1]))).join(", ");
  const text = `${sql.slice(0, toks[head].at)}${list} ${sql.slice(toks[from].at)}`;
  return { text, reason: `${NO_COLUMN_REASON}${gone.join(", ")}(42703). 고르는 행은 그대로 두고 그 열을 SELECT 목록에서 뺐다` };
}

/** 조건 없는 목록 요청(「계약 목록 보여줘」, 「전체 계약 목록 보여줘」)의 표 낱말과 그 표의 목록 SQL(표시 열과 외래키가 가리키는 이름). 스키마마다 둔다. */
const LIST_QUERIES = new Map<string, readonly { words: string; sql: string }[]>([
  [
    "companyx",
    [
      {
        words: "계약",
        sql:
          "SELECT c.id, cl.name AS client, p.name AS product, e.name AS manager, c.contract_type, c.amount, c.start_date, c.end_date, c.status " +
          "FROM companyx.contracts c LEFT JOIN companyx.clients cl ON cl.id = c.client_id LEFT JOIN companyx.products p ON p.id = c.product_id " +
          "LEFT JOIN companyx.employees e ON e.id = c.manager_id ORDER BY c.id",
      },
      { words: "고객사|고객|거래처", sql: "SELECT c.id, c.name, c.industry, c.region, c.company_size, c.registered_at, c.is_active FROM companyx.clients c ORDER BY c.id" },
      {
        words: "직원|사원|임직원",
        sql: "SELECT e.id, e.name, e.position, d.name AS department, e.hire_date, e.is_active FROM companyx.employees e LEFT JOIN companyx.departments d ON d.id = e.dept_id ORDER BY e.id",
      },
      { words: "부서|팀", sql: "SELECT d.id, d.name, h.name AS head FROM companyx.departments d LEFT JOIN companyx.employees h ON h.id = d.head_id ORDER BY d.id" },
      { words: "제품|상품", sql: "SELECT p.id, p.name, p.category, p.price_monthly, p.version, p.release_date, p.status FROM companyx.products p ORDER BY p.id" },
      {
        words: "프로젝트",
        sql:
          "SELECT pr.id, pr.name, cl.name AS client, e.name AS manager, pr.status, pr.start_date, pr.end_date, pr.budget FROM companyx.projects pr " +
          "LEFT JOIN companyx.clients cl ON cl.id = pr.client_id LEFT JOIN companyx.employees e ON e.id = pr.manager_id ORDER BY pr.id",
      },
      {
        words: "지원\\s*티켓|티켓",
        sql:
          "SELECT t.id, t.title, cl.name AS client, p.name AS product, e.name AS assignee, t.priority, t.status, t.created_at, t.resolved_at " +
          "FROM companyx.support_tickets t LEFT JOIN companyx.clients cl ON cl.id = t.client_id LEFT JOIN companyx.products p ON p.id = t.product_id " +
          "LEFT JOIN companyx.employees e ON e.id = t.assignee_id ORDER BY t.id",
      },
    ],
  ],
]);

/** 질문이 조건 없이 한 표의 목록만 묻으면(문장 전체가 「(전체) <표 낱말> 목록 보여줘」 꼴) 그 표의 목록 SQL, 아니면 null. 조건 낱말(「완료된」, 「2019년에
 * 입사한」, 「기술지원팀」)이 하나라도 있으면 null 이다. 결정론이다. */
export function plainListSql(question: string, schema: string): string | null {
  const q = question.normalize("NFC").replace(/[?？!！.。,，~～…]+/g, " ").replace(/\s+/g, " ").trim();
  const all = "(?:(?:전체|모든|전부|우리\\s*회사)\\s*(?:의\\s*)?)?";
  const many = "(?:\\s*(?:전체|전부|모두|다))?";
  const verb = "(?:보여|알려|뽑아|출력해|나열해|조회해|띄워)\\s?(?:줘요?|주세요|줄래요?|주라|봐)";
  for (const l of LIST_QUERIES.get(schema) ?? []) {
    const re = new RegExp(`^${all}(?:${l.words})\\s*(?:들)?${many}(?:\\s*(?:목록|리스트|명단))?(?:\\s*(?:을|를|은|는|좀))?${many}(?:\\s*${verb})?$`, "i");
    if (re.test(q) && /목록|리스트|명단|보여|알려|뽑아|출력|나열|조회|띄워/.test(q)) return l.sql;
  }
  return null;
}

/** 생성 SQL(과 수리 SQL)을 실행하기 전의 검사 사유. 비었으면 실행해도 된다. executeWithRepair 가 부르고, 순서는 조인과 id
 * (checkSql, confirmNamedIds), 금액 단위(checkMoney), 집계를 부풀리는 조인(fanoutJoins, confirmFanout), 기간(checkPeriod),
 * 값 어휘(checkEnum), 질문에 없는 값 조건(checkUnaskedEnum, checkAbsentState, checkUnaskedNull), 기간 길이(checkPeriodLength), 비율의 정수
 * 나눗셈(checkRatio), 집계 단위(checkMonthUnit, checkGroupTop, checkBothEnds, …, checkAvgElseZero, checkCompareGroups), 함께 참일 수 없는 조건
 * (checkContradiction), JSON 묶음(checkJsonOutput), 집계 단위(confirmCountUnit, confirmAverageUnit), PostgreSQL 이 읽지 못하는 꼴(checkSyntax)이다. */
export async function untrustedReasons(pool: Pool, schema: string, sql: string, question: string): Promise<string[]> {
  const fks = await declaredForeignKeys(pool, schema);
  const v = checkSql(sql, question, fks, await declaredColumns(pool, schema));
  return [
    ...(v.ok ? [] : await confirmNamedIds(pool, schema, v, question)),
    ...checkMoney(sql, question, moneyColumns(schema)),
    ...(await confirmFanout(pool, schema, fanoutJoins(sql, fks))),
    ...checkPeriod(sql, question),
    ...checkTimestampEnd(sql, schema),
    ...checkExplicitYoy(sql, question),
    ...checkRollingQuarter(sql, question),
    ...checkEnum(sql, enumColumns(schema)),
    ...checkUnaskedEnum(sql, question, enumColumns(schema), schema),
    ...checkAbsentState(sql, question, enumColumns(schema), schema),
    ...checkOpenTickets(sql, question),
    ...checkSelfJoin(sql, question, new Set((fks ?? []).flatMap((f) => [f.table, f.refTable]))),
    ...checkUnaskedNull(sql, question),
    ...checkPeriodLength(sql, question),
    ...checkRatio(sql, question),
    ...checkMonthUnit(sql, question),
    ...checkGroupTop(sql, question),
    ...checkBothEnds(sql, question),
    ...checkHalfGroup(sql, question),
    ...checkCumulative(sql, question),
    ...checkYearOverYear(sql, question),
    ...checkAvgElseZero(sql),
    ...checkCompareGroups(sql, question, schema),
    ...checkContradiction(sql, new Set((fks ?? []).flatMap((f) => [f.table, f.refTable]))),
    ...checkJsonOutput(sql),
    ...(await confirmCountUnit(pool, sql, question)),
    ...(await confirmAverageUnit(pool, sql, question)),
    ...checkSyntax(sql),
    ...checkQuarterText(sql),
  ];
}

/** 실행 전 검사의 기록. 검사가 아무것도 거부하지 않았으면 만들지 않는다.
 *  refused  — 실행할 믿을 만한 SQL 이 없다. 답하지 않는다.
 *  repaired — 처음 SQL 을 거부하고 수리한 SQL 을 실행했다.
 *  kept     — 0행 수리로 만든 SQL 을 거부하고 처음 SQL(0행)을 그대로 썼다. */
export interface SqlGate {
  outcome: "refused" | "repaired" | "kept";
  rejected: { sql: string; reasons: string[] }[];
  /** 질문이 측정 항목 한 낱말뿐이라(vagueMeasure) SQL 을 만들지 않았을 때 그 낱말. 그때 outcome 은 refused, rejected 는 비었다. */
  vague?: string;
  /** 생성 모델을 다시 부르지 않고 결정론으로 바꾼 SQL 을 실행했으면 그 방식. group-top: 묶음마다 1위(groupTopRewrite), count-distinct: 부모 키를
   * COUNT(DISTINCT …) 로(countDistinctRewrite), list: 조건 없는 목록 질문에 그 표의 목록 SQL(plainListSql), open-status: 열린 티켓 상태 조건을 더함
   * (openStatusRewrite), self-join: 질문에 없는 자기 조인 조건을 뺌(dropSelfJoinConditions), alias: FROM 에 없는 별칭을 그 표의 별칭으로(realiasSql).
   * 그때 outcome 은 repaired. */
  rewritten?: "group-top" | "count-distinct" | "list" | "open-status" | "self-join" | "alias" | "missing-column";
  /** 결정론으로 더한 조건(묶음마다 1위 재작성과 함께 더한 열린 티켓 상태 조건). */
  added?: string[];
  /** 「작년 동기 대비」인데 이번 분기 매출이 아직 없어 생성 SQL 을 실행하지 않았을 때 두 분기와, 결정론으로 조회한 마지막 분기와 그 1년 전 분기의 매출.
   * 그때 outcome 은 refused 이고 답은 untrustedAnswer 의 결정론 문장이다. */
  sameQuarter?: {
    current: string;
    target: string;
    last?: { quarter: string; amount: number; prevQuarter: string; prevAmount: number; pct: number };
  };
}

/** 대상 없이 한 낱말로 물을 때 조회할 값을 정할 수 없는 측정 항목. 스키마마다 둔다(금액 열, moneyColumns 와 같은 방식).
 * 낱말, 되물을 때 함께 물어 달라는 말, 이 데이터에서 맞게 답하는 예시 질문 둘(라이브로 확인한 것). 금액 열(salary, sales 와
 * contracts 의 amount, budget)마다 묶고, 「금액」은 어느 금액인지부터 묻는다. 예시에는 개체 식별자(Client-A 등)를 넣지 않는다.
 * 근거 없이 쓴 답이라 감사 레코드의 접지 검사가 그 이름을 근거 밖 개체로 적는다(「Client-A 매출 합계는?」에서 실측). */
const VAGUE_MEASURES = new Map<string, readonly { words: string; ask: string; examples: readonly [string, string] }[]>([
  [
    "companyx",
    [
      { words: "매출액?|실적", ask: "기간, 고객사, 제품처럼 대상을 함께 물어봐 주세요.", examples: ["2025년 3분기 총 매출액은 얼마야?", "서울 지역 매출 상위 5개 고객사를 알려줘"] },
      { words: "연봉|급여|월급", ask: "부서나 직원처럼 대상을 함께 물어봐 주세요.", examples: ["기술지원팀 직원 목록과 연봉을 알려줘", "평균 연봉이 가장 높은 부서는 어디야?"] },
      { words: "예산", ask: "프로젝트, 고객사, 진행 상태처럼 대상을 함께 물어봐 주세요.", examples: ["예산이 가장 큰 프로젝트 3개를 알려줘", "진행 중인 프로젝트의 예산 합계는?"] },
      { words: "계약 ?금액", ask: "고객사, 제품, 계약 상태처럼 대상을 함께 물어봐 주세요.", examples: ["제품별 총 계약 금액을 큰 순서로 보여줘", "현재 활성 상태인 계약의 금액 합계는?"] },
      { words: "금액", ask: "매출, 계약 금액, 프로젝트 예산 가운데 어느 금액인지와 기간이나 고객사 같은 대상을 함께 물어봐 주세요.", examples: ["2025년 3분기 총 매출액은 얼마야?", "제품별 총 계약 금액을 큰 순서로 보여줘"] },
    ],
  ],
]);

/** 측정 항목 낱말 뒤에 와도 대상을 더하지 않는 말: 조사 하나, 「좀」, 요청과 물음의 끝말. 이 밖의 낱말(합계, 2025년, Client-A,
 * 서울, 평균, 총 …)이 하나라도 있으면 되묻지 않는다. */
const VAGUE_TAIL =
  "(?:은|는|이|가|을|를|도)?(?:\\s*(?:좀|(?:알려|보여|말해|조회해)\\s?(?:줘요?|주세요|줄래요?|주라)|얼마(?:야|예요|에요|지|니|임|인가요?|일까요?)?|어때요?|궁금해요?|궁금합니다))*";

/** 질문이 측정 항목 한 낱말뿐이면(「매출 알려줘」, 「연봉이 얼마야?」, 「예산」) 그 낱말, 아니면 null. 문장부호와 공백만 고르고
 * 대조한다. 기간, 개체, 집계, 비교처럼 다른 내용이 조금이라도 있으면 null 이다. 이 낱말을 두지 않은 스키마(smoke, bench)도 null.
 * 결정론이다. */
export function vagueMeasure(question: string, schema: string): string | null {
  const families = VAGUE_MEASURES.get(schema);
  if (!families) return null;
  const q = question.normalize("NFC").replace(/[?？!！.。,，~～…]+/g, " ").replace(/\s+/g, " ").trim();
  for (const v of VAGUE_ASKS.get(schema) ?? []) {
    const m = new RegExp(`^${v.pattern}$`).exec(q);
    if (m) return m[1].replace(/\s+/g, " ");
  }
  return new RegExp(`^(${families.map((f) => f.words).join("|")})${VAGUE_TAIL}$`).exec(q)?.[1] ?? null;
}

/** 측정 항목 없이 견주는 최상급(「가장 큰 고객사는 어디야?」, 「가장 중요한 고객사」)과 기간 없이 묻는 「요즘 매출 어때?」. 7B 는 아무 기준이나 골랐다:
 * 대기업을 등록일 순으로 골라 「Client-F」, 최근 등록 고객사 행에 제안서의 「Client-O」, sale_date >= CURRENT_DATE 의 null(랜덤 테스트 사전 점검 5차
 * P9, AM01, AM04, AM05 3/3). 측정 항목이 든 최상급(「매출이 가장 큰 고객사」)과 「제일 잘나가는 제품」, 「제일 바쁜 직원」은 걸리지 않는다(문장 전체를
 * 대조). pattern 의 첫 묶음이 답과 감사 레코드에 적는 말이다. 예시 질문은 라이브로 확인한 것이고 개체 식별자를 넣지 않는다. */
/** 막연한 최상급 뒤의 물음 끝말(「가장 중요한 프로젝트는 뭐야?」의 「는 뭐야」). */
const VAGUE_SUPERLATIVE_TAIL =
  "(?:은|는|이|가|를|을)?(?:\\s*(?:어디|어느\\s*(?:곳|것|거|팀|부서|프로젝트|제품)|누구|뭐|무엇|어떤\\s*(?:것|거))(?:야|예요|에요|지|니|일까요?|인가요?|입니까|임)?|\\s*(?:알려|말해)\\s?(?:줘요?|주세요))?";
const VAGUE_ASKS = new Map<string, readonly { pattern: string; detail: string; ask: string; examples: readonly [string, string] }[]>([
  [
    "companyx",
    [
      {
        pattern:
          "((?:(?:가장|제일|젤)\\s*(?:큰|중요한|좋은|대단한|핵심적인|핵심|주요한|큰손인|vip인|VIP인)|최대의?|최고의?|1등|일등)\\s*(?:고객사|고객|회사|거래처))(?:은|는|이|가|를|을)?(?:\\s*(?:어디|어느\\s*곳|누구|뭐|무엇|어느\\s*고객사)(?:야|예요|에요|지|니|일까요?|인가요?|입니까|임)?|\\s*(?:알려|말해)\\s?(?:줘요?|주세요))?",
        detail: "무엇으로 견줄지(측정 항목) 없이",
        ask: "무엇으로 견줄지 정할 수 없어 조회하지 않았습니다. 매출, 계약 금액, 회사 규모 가운데 무엇으로 볼지 함께 물어봐 주세요.",
        examples: ["매출 합계가 가장 큰 고객사는 어디야?", "계약 금액 합계가 가장 큰 고객사는 어디야?"],
      },
      {
        pattern: "((?:요즘|요새|최근|근래|요즈음)\\s*(?:매출액?|실적|장사))(?:은|는|이|가)?(?:\\s*(?:좀|어때요?|어떤가요?|어떻게\\s*돼(?:요)?|어떠니|괜찮아요?|좋아요?|어떄))*",
        detail: "기간 없이",
        ask: "어느 기간을 볼지 정할 수 없어 조회하지 않았습니다. 기간을 함께 물어봐 주세요.",
        examples: ["최근 6개월 매출 합계는 얼마야?", "2026년 2분기 총 매출액은 얼마야?"],
      },
      // 6차 P11: 고객사 밖의 막연한 최상급. 「가장 큰 부서」는 인원으로 답해도 되어 넣지 않는다(중요한, 좋은, 핵심만). 7B 는 「가장 중요한 프로젝트는 뭐야?」에
      // 기준을 말하지 않고 예산 1위를 골랐다(SP05 3/3).
      {
        pattern: `((?:가장|제일|젤)\\s*(?:중요한|좋은|핵심적인|핵심)\\s*프로젝트)${VAGUE_SUPERLATIVE_TAIL}`,
        detail: "무엇으로 견줄지(측정 항목) 없이",
        ask: "무엇으로 견줄지 정할 수 없어 조회하지 않았습니다. 예산, 진행 상태, 고객사 가운데 무엇으로 볼지 함께 물어봐 주세요.",
        examples: ["예산이 가장 큰 프로젝트는 뭐야?", "진행 중인 프로젝트의 예산 합계는?"],
      },
      {
        pattern: `((?:가장|제일|젤)\\s*(?:중요한|좋은|핵심적인|핵심)\\s*(?:제품|상품))${VAGUE_SUPERLATIVE_TAIL}`,
        detail: "무엇으로 견줄지(측정 항목) 없이",
        ask: "무엇으로 견줄지 정할 수 없어 조회하지 않았습니다. 매출, 판매 건수, 월 이용료 가운데 무엇으로 볼지 함께 물어봐 주세요.",
        examples: ["가장 많이 팔린 제품은?", "매출이 가장 높은 제품 카테고리는?"],
      },
      {
        pattern: `((?:가장|제일|젤)\\s*(?:중요한|좋은|핵심적인|핵심)\\s*(?:직원|사원|인재|사람))${VAGUE_SUPERLATIVE_TAIL}`,
        detail: "무엇으로 견줄지(측정 항목) 없이",
        ask: "무엇으로 견줄지 정할 수 없어 조회하지 않았습니다. 담당 고객 수, 처리한 티켓 수, 연봉 가운데 무엇으로 볼지 함께 물어봐 주세요.",
        examples: ["가장 많은 고객을 담당하는 직원은?", "미해결 티켓이 가장 많은 담당자는 누구야?"],
      },
      {
        pattern: `((?:가장|제일|젤)\\s*(?:중요한|좋은|핵심적인|핵심)\\s*(?:부서|팀))${VAGUE_SUPERLATIVE_TAIL}`,
        detail: "무엇으로 견줄지(측정 항목) 없이",
        ask: "무엇으로 견줄지 정할 수 없어 조회하지 않았습니다. 인원, 평균 연봉 가운데 무엇으로 볼지 함께 물어봐 주세요.",
        examples: ["직원이 가장 많은 부서는 어디야?", "평균 연봉이 가장 높은 부서는 어디야?"],
      },
      // 6차 P11: 「요즘 티켓 상황 어때?」에 7B 가 기간 없이 120건을 읽고 2024년에 닫힌 티켓을 「요즘」이라고 답했다(SP07 3/3).
      {
        pattern:
          "((?:요즘|요새|최근|근래|요즈음)\\s*(?:지원\\s*)?(?:티켓|문의|장애)\\s*(?:상황|현황|상태)?)(?:은|는|이|가)?(?:\\s*(?:좀|어때요?|어떤가요?|어떻게\\s*돼(?:요)?|어떠니|괜찮아요?|어떄|알려\\s?줘요?|알려\\s?주세요))*",
        detail: "기간 없이",
        ask: "어느 기간을 볼지 정할 수 없어 조회하지 않았습니다. 기간이나 상태를 함께 물어봐 주세요.",
        examples: ["진행 중인 티켓 목록 보여줘", "2025년 10월부터 12월까지 해결된 티켓은 몇 건이야?"],
      },
    ],
  ],
]);

/** 측정 항목 한 낱말뿐인 질문의 답. 조회하지 않았다고 말하고, 함께 물을 대상과 이 데이터에서 맞게 답하는 예시를 든다. */
export function vagueAnswer(word: string): string {
  const ask = [...VAGUE_ASKS.values()].flat().find((x) => new RegExp(`^${x.pattern}$`).test(word));
  if (ask) return `「${word}」만으로는 ${ask.ask} 예: 「${ask.examples[0]}」, 「${ask.examples[1]}」`;
  const f = [...VAGUE_MEASURES.values()].flat().find((x) => new RegExp(`^(?:${x.words})$`).test(word));
  return (
    `「${word}」만으로는 무엇을 알고 싶은지 정할 수 없어 조회하지 않았습니다. ` +
    (f ? `${f.ask} 예: 「${f.examples[0]}」, 「${f.examples[1]}」` : "기간이나 대상을 함께 물어봐 주세요.")
  );
}

/** 감사 레코드의 정책 줄. */
export function sqlGatePolicy(gate: SqlGate | undefined): PolicyVerdict | undefined {
  if (!gate) return undefined;
  if (gate.vague) {
    const ask = [...VAGUE_ASKS.values()].flat().find((x) => new RegExp(`^${x.pattern}$`).test(gate.vague!));
    const last = gate.vague.charCodeAt(gate.vague.length - 1) - 0xac00;
    const object = last >= 0 && last < 11172 && last % 28 !== 0 ? "을" : "를";
    return {
      policy: "sql-trust-gate",
      verdict: "deny",
      detail: ask
        ? `질문이 ${ask.detail} 「${gate.vague}」${object} 물어 조회할 값을 정할 수 없어 SQL 을 만들지 않았고 답하지 않았다(${ask.detail === "기간 없이" ? "기간" : "견줄 항목"}을 함께 물어 달라고 되물음)`
        : `질문이 측정 항목 한 낱말(「${gate.vague}」)뿐이라 어느 기간, 어느 대상의 값을 조회할지 정할 수 없어 SQL 을 만들지 않았고 ` +
          "답하지 않았다(대상을 함께 물어 달라고 되물음)",
    };
  }
  const why = gate.rejected.map((r) => `「${r.sql.replace(/\s+/g, " ")}」: ${r.reasons.join("; ")}`).join(" / ");
  const added = gate.added?.length ? ` 열린 티켓 상태 조건(${gate.added.join(", ")})도 결정론으로 더했다.` : "";
  const head =
    gate.outcome === "refused" && gate.sameQuarter
      ? `질문의 「작년 동기」는 이번 분기(${quarterLabel(gate.sameQuarter.current)})를 1년 전 같은 분기(${quarterLabel(gate.sameQuarter.target)})와 견주는데 ` +
        "이번 분기 매출이 아직 없어 생성 SQL 을 실행하지 않았다. 매출이 있는 마지막 분기와 그 1년 전 같은 분기를 결정론 SQL 로 조회해 결정론 문장으로 답했다(생성 모델을 부르지 않음)"
      : gate.outcome === "refused"
      ? "생성 SQL 을 실행하지 않았고 믿을 만한 SQL 을 만들지 못해 답하지 않았다"
      : gate.rewritten === "group-top"
        ? `처음 생성 SQL 을 실행하지 않고 묶음마다 1위를 고르는 SQL(LIMIT 를 빼고 RANK() OVER (PARTITION BY 묶음 열 …) = 1)로 결정론으로 바꿔 실행했다(생성 모델을 다시 부르지 않음).${added}`
        : gate.rewritten === "count-distinct"
        ? "처음 생성 SQL 을 실행하지 않고 겹쳐 센 부모 키를 COUNT(DISTINCT …) 로 세는 SQL 로 결정론으로 바꿔 실행했다(생성 모델을 다시 부르지 않음)"
        : gate.rewritten === "list"
        ? "생성 SQL 과 수리 SQL 이 거부되거나 실행되지 않아, 조건 없는 목록 질문이라 그 표의 목록 SQL(표시 열과 외래키가 가리키는 이름)을 결정론으로 실행했다(생성 모델을 다시 부르지 않음)"
        : gate.rewritten === "open-status"
        ? `처음 생성 SQL 에 열린 티켓 상태 조건(${gate.added?.join(", ") ?? "status"})을 결정론으로 더해 실행했다(생성 모델을 다시 부르지 않음)`
        : gate.rewritten === "self-join"
        ? "질문이 묻지 않은 자기 조인 같음 조건을 결정론으로 빼고 실행했다(생성 모델을 다시 부르지 않음)"
        : gate.rewritten === "alias"
        ? "생성 SQL 의 FROM 에 없는 별칭을 그 열이 있는 표의 별칭으로 결정론으로 바꿔 실행했다(생성 모델을 다시 부르지 않음)"
        : gate.rewritten === "missing-column"
        ? "수리한 SQL 도 없는 열 오류로 끝나, 그 열을 SELECT 목록에서 결정론으로 빼고 실행했다(고르는 행은 그대로, 생성 모델을 다시 부르지 않음)"
        : gate.outcome === "repaired"
          ? "처음 생성 SQL 을 실행하지 않고 1회 수리한 SQL 을 실행했다"
          : "0행 수리로 만든 SQL 을 실행하지 않고 처음 SQL(0행)을 그대로 썼다";
  return { policy: "sql-trust-gate", verdict: gate.outcome === "repaired" ? "repair" : "deny", detail: `${head} — ${why}` };
}

/** 「작년 동기 대비」인데 이번 분기 매출이 아직 없을 때의 결정론 문장. 그렇다고 말하고, 매출이 있는 마지막 분기를 그 1년 전 같은 분기와 견준 값을 든다. 7B 가
 * 2025년 3분기 대비 4분기(직전 분기)의 33.26% 를 「작년 동기 대비」로 답했다(랜덤 테스트 사전 점검 6차 P4, MR17, XC05 3/3). */
function sameQuarterAnswer(s: NonNullable<SqlGate["sameQuarter"]>): string {
  const head = `이번 분기(${quarterLabel(s.current)}) 매출이 아직 없어 작년 같은 분기(${quarterLabel(s.target)})와 견줄 수 없습니다.`;
  const l = s.last;
  if (!l) return head;
  const won = (n: number) => `${n.toLocaleString("en-US")}만원`;
  const tail =
    l.pct === 0
      ? `작년 같은 분기(${quarterLabel(l.prevQuarter)}, ${won(l.prevAmount)})와 같습니다.`
      : `작년 같은 분기(${quarterLabel(l.prevQuarter)}) ${won(l.prevAmount)}보다 ${Math.abs(l.pct).toFixed(2)}% ${l.pct > 0 ? "많습니다" : "적습니다"}.`;
  return `${head} 매출이 있는 마지막 분기인 ${quarterLabel(l.quarter)} 매출은 ${won(l.amount)}으로 ${tail}`;
}

/** 믿을 만한 SQL 을 만들지 못했을 때의 답. 7B 를 부르지 않는다. 금액 단위만 걸렸으면 금액 조건을 말하고 만원으로
 * 바꿔 묻는 법을 알린다. */
export function untrustedAnswer(gate: SqlGate): string {
  if (gate.vague) return vagueAnswer(gate.vague);
  if (gate.sameQuarter) return sameQuarterAnswer(gate.sameQuarter);
  const reasons = gate.rejected.flatMap((r) => r.reasons);
  const missing = reasons.map((r) => MISSING_COLUMN.exec(r)?.[1]).find((x) => x !== undefined);
  const join = reasons.find((r) => r.startsWith("조인 조건"))?.match(/^조인 조건 (.+?) 은/)?.[1];
  const id = reasons
    .find(
      (r) =>
        ![
          "조인 조건",
          MONEY_REASON,
          FANOUT_REASON,
          PERIOD_REASON,
          ENUM_REASON,
          UNASKED_REASON,
          ABSENT_REASON,
          RATIO_REASON,
          UNIT_REASON,
          SYNTAX_REASON,
          LENGTH_REASON,
          AVG_ELSE_REASON,
          COMPARE_REASON,
          CONTRADICTION_REASON,
          FORMAT_REASON,
          STATE_REASON,
          ALIAS_REASON,
          NO_COLUMN_REASON,
        ].some((p) => r.startsWith(p)),
    )
    ?.match(/^(.+?) 의 번호/)?.[1];
  const money = reasons
    .find((r) => r.startsWith(MONEY_REASON))
    ?.match(/^금액 조건 (.+?) 의 [^ ]+ 은 질문의 금액 「(.+?)」\(=([^)]+)만 원\)/);
  const fan = reasons.find((r) => r.startsWith(FANOUT_REASON))?.match(/^집계 (.+?) 은 (\S+) 의 열인데 \S+ 를 가리키는 (\S+) 와 조인/);
  if (!join && !id && !fan && money) {
    const [, cond, text, want] = money;
    return (
      "이 질문의 금액 조건으로는 믿을 수 있는 조회를 만들지 못해 답하지 않았습니다. " +
      `생성된 SQL 이 금액 조건(${cond})을 질문의 금액(${text} = ${want}만 원)과 다른 단위로 걸어서 실행하지 않았습니다. ` +
      `금액은 만원 단위 숫자로 바꿔 다시 물어봐 주세요. 예: 「${text}」 대신 「${want}만 원」`
    );
  }
  const monthly = reasons.map((r) => /^기간 조건 (.+?) 은 분기를 고른다\. 질문의 (\d{4})년 (\d{1,2})월은/.exec(r)).find((x) => x !== null);
  if (!join && !id && !fan && !money && !missing && monthly) {
    const [, cond, year, month] = monthly;
    const mm = month.padStart(2, "0");
    const last = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
    return (
      "이 질문의 기간 조건으로는 믿을 수 있는 조회를 만들지 못해 답하지 않았습니다. " +
      `생성된 SQL 이 ${year}년 ${month}월이 아니라 분기(${cond})로 골라서 실행하지 않았습니다. ` +
      `날짜 범위로 함께 물어봐 주세요. 예: 「${year}-${mm}-01부터 ${year}-${mm}-${last}까지 매출 합계는?」`
    );
  }
  const ranged = reasons
    .map((r) => /^기간 조건 (.+?) 은 분기를 고른다\. 질문의 (\d{4}년 \d{1,2}월부터 (?:\d{4}년 )?\d{1,2}월까지)는 .+?\(\S+ >= '(\d{4}-\d{2}-\d{2})' AND \S+ < '(\d{4}-\d{2}-\d{2})'\)/.exec(r))
    .find((x) => x !== null);
  if (!join && !id && !fan && !money && !missing && ranged) {
    const [, cond, span, start, next] = ranged;
    const end = new Date(Date.parse(`${next}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
    return (
      "이 질문의 기간 조건으로는 믿을 수 있는 조회를 만들지 못해 답하지 않았습니다. " +
      `생성된 SQL 이 ${span}가 아니라 분기(${cond})로 골라서 실행하지 않았습니다. ` +
      `날짜 범위로 함께 물어봐 주세요. 예: 「${start}부터 ${end}까지 매출 합계는?」`
    );
  }
  const period = reasons.find((r) => r.startsWith(PERIOD_REASON))?.match(/^기간 조건 (.+?) 은 (\d{4})년의 한 분기만/);
  const half = reasons
    .map(
      (r) =>
        /^기간 조건 (.+?) 은 (\d{4})년 ([\d, ]+)분기만 고른다\. 질문의 \d{4}년 (.+?)는 ([\d, ]+)분기다/.exec(r) ??
        /^기간 조건 (.+?) 은 (\d{4})년 .+? 밖의 ([\d, ]+)분기도 고른다\. 질문의 \d{4}년 (.+?)는 ([\d, ]+)분기다/.exec(r),
    )
    .find((x) => x !== null);
  if (!join && !id && !fan && !money && !missing && period) {
    const [, cond, year] = period;
    return (
      "이 질문의 기간 조건으로는 믿을 수 있는 조회를 만들지 못해 답하지 않았습니다. " +
      `생성된 SQL 이 ${year}년 전체가 아니라 한 분기(${cond})만 골라서 실행하지 않았습니다. ` +
      `분기를 함께 물어봐 주세요. 예: 「${year}년 3분기 총 매출액은 얼마야?」`
    );
  }
  if (!join && !id && !fan && !money && !missing && half) {
    const [said, cond, year, picked, name, asked] = half;
    const inHalf = picked.split(",").every((q) => asked.split(",").map((a) => a.trim()).includes(q.trim()));
    const chose = said.includes(" 밖의 ")
      ? `${name}(${asked}분기) 밖의 ${picked}분기(${cond})도 골라서`
      : inHalf
        ? `${name}(${asked}분기) 가운데 ${picked}분기(${cond})만 골라서`
        : `${name}(${asked}분기)와 다른 ${picked}분기(${cond})를 골라서`;
    return (
      "이 질문의 기간 조건으로는 믿을 수 있는 조회를 만들지 못해 답하지 않았습니다. " +
      `생성된 SQL 이 ${year}년 ${chose} 실행하지 않았습니다. ` +
      `분기마다 나눠 물어봐 주세요. 예: 「${year}년 ${asked.split(",")[0].trim()}분기 총 매출액은 얼마야?」`
    );
  }
  const value = reasons.map((r) => /^값 조건 .+? 의 (.+?) 은 (.+?) 에 없는 값이다\. 쓸 수 있는 값: (.+)$/.exec(r)).find((x) => x !== null);
  const unit = reasons.find((r) => r.startsWith(UNIT_REASON));
  const unaskedWhy = reasons.find((r) => r.startsWith(UNASKED_REASON));
  const unasked = unaskedWhy?.match(/^질문에 없는 조건 (.+?) 은 질문이 묻지 않은 조건이다/)?.[1];
  // 질문이 말한 상태가 그 표에 없으면 그 사실과 그 열의 값을 함께 말한다(「취소되지 않은 프로젝트」: projects.status 에 cancelled 가 없다).
  const absentState = reasons
    .map((r) => /^질문에 없는 조건 .+? 은 질문이 묻지 않은 조건이다\(질문이 말한 상태 (.+?) 는 (\S+) 에 없는 값이다\. 쓸 수 있는 값: ([^)]+)\)/.exec(r))
    .find((x) => x !== null);
  const syntax = reasons.find((r) => r.startsWith(SYNTAX_REASON));
  const absent = reasons.map((r) => /^없는 상태 질문이 말한 상태 '(.+?)' 는 (\S+) 에 없는 값이다\(쓸 수 있는 값: ([^)]+)\)/.exec(r)).find((x) => x !== null);
  const since = reasons.map((r) => /^기간 조건 .+? 은 (\d{4})년을 뺀다\./.exec(r)).find((x) => x !== null);
  const sameQuarter = reasons.map((r) => /^기간 조건 (.+?) 은 질문의 기간과 다르다\. 질문의 「작년 같은 분기」는 .+?(\d{4})년 (\d)분기다/.exec(r)).find((x) => x !== null);
  const length = reasons.find((r) => r.startsWith(LENGTH_REASON));
  const avgElse = reasons.find((r) => r.startsWith(AVG_ELSE_REASON));
  const compare = reasons.map((r) => /^비교 질문은 '(.+?)' 과 '(.+?)' 을 견주는데/.exec(r)).find((x) => x !== null);
  const contradiction = reasons.map((r) => /^모순 조건 (.+?) 은 함께 참일 수 없다/.exec(r)).find((x) => x !== null);
  const format = reasons.find((r) => r.startsWith(FORMAT_REASON));
  const state = reasons.find((r) => r.startsWith(STATE_REASON));
  const stampEnd = reasons.find((r) => /^기간 조건 .+? 은 시각 열이라 /.test(r));
  const oneQuarter = reasons.find((r) => /^기간 조건 .+?만 남겨 1년 전 같은 분기/.test(r));
  const rolling = reasons.find((r) => /^기간 조건 .+? 은 오늘에서 거꾸로 잰 기간이라/.test(r));
  // 값 어휘에 없는 값이 있으면 그것부터 말한다. 질문이 데이터에 없는 상태를 물었다는 뜻이라 다른 사유(조인 열 따위)보다
  // 묻는 사람에게 가깝다(「취소된 프로젝트 목록을 알려줘」: projects.status 에 cancelled 가 없다. 종전 답은 dept_id 조인을 먼저 말함).
  const why = value
    ? `생성된 SQL 이 ${value[2]} 에 없는 값(${value[1]})으로 조건을 걸어서 실행하지 않았습니다. ${value[2]} 의 값은 ${value[3]} 입니다. `
    : absent
    ? `질문이 말한 상태('${absent[1]}')는 ${absent[2]} 에 없는 값입니다. ${absent[2]} 의 값은 ${absent[3]} 입니다. `
    : contradiction
    ? `생성된 SQL 이 함께 참일 수 없는 조건(${contradiction[1]})을 걸어 늘 빈 결과가 되므로 실행하지 않았습니다. `
    : format
    ? "생성된 SQL 이 조회 결과를 JSON 값 하나로 묶어서 실행하지 않았습니다. "
    : missing
    ? `생성된 SQL 이 표에 없는 열로 표를 이어서(${missing}) 실행하지 않았습니다. `
    : join
    ? `생성된 SQL 이 외래키가 아닌 열(${join})로 표를 이어서 실행하지 않았습니다. `
    : id
      ? `생성된 SQL 이 질문에 없는 번호(${id})로 한 건만 골라서 실행하지 않았습니다. `
      : fan
        ? `생성된 SQL 이 ${fan[2]} 의 값(${fan[1]})을 ${fan[3]} 와 조인한 채 집계해 ${/^count\s*\(/i.test(fan[1]) ? "같은 행을 여러 번 세어서" : "같은 값을 여러 번 더해서"} 실행하지 않았습니다. `
        : since
        ? `생성된 SQL 이 질문의 「${since[1]}년 이후」에서 ${since[1]}년을 빼고 골라서 실행하지 않았습니다. `
        : sameQuarter
        ? `생성된 SQL 이 질문의 「작년 같은 분기」(${sameQuarter[2]}년 ${sameQuarter[3]}분기)와 다른 기간(${sameQuarter[1]})을 골라서 실행하지 않았습니다. `
        : stampEnd
        ? "생성된 SQL 이 시각 열을 날짜 하나로 끝내 골라(그날 0시 뒤가 빠짐) 실행하지 않았습니다. "
        : oneQuarter
        ? "생성된 SQL 이 한 분기만 남겨 1년 전 같은 분기와 견주지 못해서 실행하지 않았습니다. "
        : rolling
        ? "생성된 SQL 이 오늘에서 거꾸로 잰 기간으로 분기를 잘라 맨 앞 분기를 일부만 세어서 실행하지 않았습니다. "
        : state
        ? "생성된 SQL 이 열린 티켓만 고르지 않아서(상태 조건 없음) 실행하지 않았습니다. "
        : length
        ? "생성된 SQL 이 기간의 길이를 재지 않아서(햇수를 내리거나 시작일 없이 오늘과 견줌) 실행하지 않았습니다. "
        : avgElse
        ? "생성된 SQL 이 평균에 조건 밖의 행을 0 으로 넣어서 실행하지 않았습니다. "
        : compare
        ? `생성된 SQL 이 견주는 두 값('${compare[1]}', '${compare[2]}')을 따로 집계하지 않아서 실행하지 않았습니다. `
        : unasked
          ? `생성된 SQL 이 질문에 없는 조건(${unasked})을 붙여서 실행하지 않았습니다. ` +
            (absentState ? `질문이 말한 상태(${absentState[1]})는 ${absentState[2]} 에 없는 값입니다. ${absentState[2]} 의 값은 ${absentState[3]} 입니다. ` : "")
          : reasons.some((r) => r.startsWith(RATIO_REASON))
            ? "생성된 SQL 이 비율을 정수끼리 나눠 소수점 아래를 버려서 실행하지 않았습니다. "
            : unit
              ? unit.includes("count(*)")
                ? "생성된 SQL 이 수 하나 대신 그룹마다 수를 돌려줘서 실행하지 않았습니다. "
                : unit.includes("마다 1위")
                  ? "생성된 SQL 이 묶음마다 1위가 아니라 전체 1위만 골라서 실행하지 않았습니다. "
                  : unit.includes("가장 낮은 쪽을 함께")
                    ? "생성된 SQL 이 가장 높은 쪽과 가장 낮은 쪽 가운데 한쪽만 골라서 실행하지 않았습니다. "
                    : unit.includes("반기(상반기, 하반기)를 묻는데")
                      ? "생성된 SQL 이 반기가 아니라 분기로 묶어서 실행하지 않았습니다. "
                      : unit.includes("질문은 평균 하나를 묻는다")
                        ? "생성된 SQL 이 평균 하나 대신 묶음마다 값을 돌려줘서 실행하지 않았습니다. "
                        : unit.includes("누적을 묻는데")
                          ? "생성된 SQL 이 누적을 세지 않아서 실행하지 않았습니다. "
                          : unit.includes("전년 동기와 견주는데")
                            ? "생성된 SQL 이 1년 전 같은 기간과 견주지 못해서 실행하지 않았습니다. "
                            : "생성된 SQL 이 달로 묶지 않아 달을 고를 수 없어서 실행하지 않았습니다. "
              : syntax
                ? syntax.includes("자리표시")
                  ? "생성된 SQL 이 값 대신 자리표시(?)를 써서 실행하지 않았습니다. "
                  : syntax.includes("의 quarter 는")
                    ? "생성된 SQL 이 글자 열 quarter('2025-Q1' 꼴)에 날짜 함수를 써서 실행하지 않았습니다. "
                    : syntax.includes("ON 조건이 없다")
                    ? "생성된 SQL 이 ON 조건 없는 JOIN 을 써서 실행하지 않았습니다. "
                    : "생성된 SQL 이 PostgreSQL 이 읽지 못하는 꼴(LIMIT a, b)이라 실행하지 않았습니다. "
                : "";
  return (
    "이 질문으로는 믿을 수 있는 조회를 만들지 못해 답하지 않았습니다. " +
    why +
    "무엇을 알고 싶은지 조금 더 구체적으로 물어봐 주세요. 예: 「2025년 3분기 총 매출액은 얼마야?」, 「기술지원팀 직원 목록과 연봉을 알려줘」"
  );
}

/** WITH TIES 로 실행한 SQL 이 공동 1위를 둘 이상 돌려줬을 때의 답 문장. 7B 를 부르지 않는다.
 *
 * 7B 는 컨텍스트의 「FETCH FIRST 1 ROWS WITH TIES」를 보고 한 행만 골라 말했다. 「가장 많은 프로젝트를 진행 중인
 * 고객사는?」 3/3 「Client-J」, 「직원이 가장 많은 부서는 어디야?」 「영업팀」(행은 둘 다 붙음). 공동 1위의 이름은
 * 결정론으로 다 적는다(관계 레인의 「공동 1위 3명」과 같은 말). 이름은 첫 문자열 열, 모델에게 간 행만 쓴다.
 * 순위 질문을 rankRewrite 로 실행했으면(sql.rank) 그 순위의 같은 값 행들을 같은 말로 적는다: 「공동 2위가 3건입니다: …」.
 * 라우트는 묻지 않는다. SQL 레인이 돌아 행을 돌려줬으면 hybrid 도 같다(「지원 티켓이 제일 적은 제품은?」은 hybrid 로 가서
 * Product-D3, Product-C1 두 행을 받고도 「Product-D3」 하나만 답했다. 랜덤 테스트 사전 점검 3차 S06, 3/3). */
export function tieAnswer(
  r: {
    sql: { text: string | null; rank?: number; result?: { ok: boolean; rows: Record<string, unknown>[] } };
    curated: { kept: { source: string }[] };
  },
  render: (v: unknown) => string,
): string | undefined {
  const res = r.sql.result;
  if (!res?.ok || res.rows.length < 2) return undefined;
  const rank = r.sql.rank ?? (/\bfetch\s+first\s+1\s+rows\s+with\s+ties\s*;?\s*$/i.test(r.sql.text ?? "") ? 1 : 0);
  if (!rank) return undefined;
  const kept = new Set(r.curated.kept.filter((it) => it.source.startsWith("sql#")).map((it) => Number(it.source.slice(4))));
  const rows = res.rows.filter((_, i) => kept.has(i));
  if (!rows.length) return undefined;
  const col = Object.keys(rows[0]).find((c) => typeof rows[0][c] === "string") ?? Object.keys(rows[0])[0];
  const rest = res.rows.length - rows.length;
  return `공동 ${rank}위가 ${res.rows.length}건입니다: ${rows.map((row) => render(row[col])).join(", ")}${rest > 0 ? ` 외 ${rest}건` : ""}.`;
}

/** ontology.search 의 k 를 vector.search(vector.ts)와 같은 범위로 맞춘다. 0, 음수, 소수가 그대로 SQL LIMIT 에
 * 들어가 「있는 Client-A 를 못 찾음」(k=0)이나 DB 오류 원문(k=-1, 1.5)이 됐다(D6). */
export function clampK(k: unknown): number {
  return Math.min(50, Math.max(1, Math.floor(Number(k)) || 5));
}

/** graph.expand 의 entityId 검사. 정수가 아니면 DB 오류 원문 대신 이 문장으로 ok:false. */
export function entityIdError(entityId: unknown): string | undefined {
  return Number.isInteger(entityId)
    ? undefined
    : `entityId 는 정수여야 합니다(ontology.search 결과의 hits[].entityId). 받은 값: ${JSON.stringify(entityId) ?? String(entityId)}`;
}
