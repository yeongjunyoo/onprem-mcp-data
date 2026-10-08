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
import type { Pool } from "./db.js";
import type { PolicyVerdict } from "./auditrecord.js";
import { formatManwon, moneyMentions } from "./money.js";
import { sqlQuery, tokenizeSql, type SqlToken } from "./sql.js";
import { DOT_MONTH_RE, RELATIVE_YEAR, RELATIVE_YEAR_RE, seoulYear } from "./llm.js";
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
  const aggRe = new RegExp(`\\b(sum|avg)\\s*\\(\\s*(?:distinct\\s+)?((?:${IDENT}\\.){1,2}${IDENT})\\s*\\)`, "gi");
  for (const a of masked.matchAll(aggRe)) {
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
    const [aq, ac] = a[2].toLowerCase().split(".").slice(-2);
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
    reasons.push(
      `${FANOUT_REASON}${j.agg} 은 ${j.parent} 의 열인데 ${j.parent} 를 가리키는 ${j.child} 와 조인(${j.join})해 ${j.parent} 한 행이 ` +
        `${j.child} 행 수만큼 겹쳐 집계된다. ${j.parent} 의 값은 ${j.child} 와 조인하지 않은 하위 질의로 따로 집계한다`,
    );
  }
  return reasons;
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
  const month = checkMonthPeriod(sql, question, now);
  if (month.length) return month;
  if (PART_OF_YEAR.test(question)) return checkHalfYear(sql, question, now);
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

function askedMonths(question: string, now: Date): { year: number; month: number }[] {
  const thisYear = seoulYear(now);
  const out = new Map<string, { year: number; month: number }>();
  const add = (year: number, month: number) => out.set(`${year}-${month}`, { year, month });
  for (const m of question.matchAll(YEAR_MONTH_RE)) {
    const year = m[1] ? (m[1].length === 2 ? 2000 + Number(m[1]) : Number(m[1])) : thisYear + (RELATIVE_YEAR[m[2]] ?? 0);
    add(year, Number(m[3]));
  }
  for (const m of question.matchAll(DOT_MONTH_RE)) add(Number(m[1]), Number(m[2]));
  return [...out.values()];
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
  const reasons: string[] = [];
  for (const { year, month } of months) {
    const mm = String(month).padStart(2, "0");
    if (sql.includes(`'${year}-${mm}`)) continue; // 그 달의 날짜로도 고른다
    const next = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, "0")}-01`;
    reasons.push(
      `${PERIOD_REASON}${picked} 은 분기를 고른다. 질문의 ${year}년 ${month}월은 한 분기가 아니라 한 달이다. ` +
        `분기(quarter)가 아니라 그 달의 날짜 범위(${date} >= '${year}-${mm}-01' AND ${date} < '${next}')로 고른다`,
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
  if (new RegExp(`${col}\\s*(?:<|>|between\\b|i?like\\s*'(?!\\d{4}-(?:Q[1-4]|%)')[^']*')`, "i").test(sql)) return [];
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
  const reasons: string[] = [];
  for (const [year, quarters] of want) {
    const iq = insideQ.get(year);
    const asked = [...quarters].sort();
    if (iq && halves.get(year)!.length === 1 && (asked.some((q) => !iq.quarters.has(q)) || [...iq.quarters].some((q) => !quarters.has(q)))) {
      const list = asked.map((q) => `'${year}-Q${q}'`).join(", ");
      reasons.push(
        `${PERIOD_REASON}${[...new Set(iq.conds)].join(", ")} 은 ${year}년 ${[...iq.quarters].sort().join(", ")}분기만 고른다. ` +
          `질문의 ${year}년 ${halves.get(year)!.join(", ")}는 ${asked.join(", ")}분기다. 식 안(CASE, FILTER)에서도 quarter IN (${list}) 로 그 분기를 모두 센다`,
      );
      continue;
    }
    const g = got.get(year);
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

/** 생성 SQL 의 값 어휘 열 조건(=, IN). 표는 별칭이나 표 이름으로, 표를 붙이지 않은 열은 문장에 나온 표 가운데 그 열이 있는 표로
 * 정한다. 어느 표인지 모르는 열, 식, 확실히 읽지 못하는 문장은 넣지 않는다. */
function enumConditions(sql: string, enums: TableEnums): EnumCondition[] {
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
  for (const m of masked.matchAll(new RegExp(`${ref}\\s*=\\s*'( *)'`, "gi"))) {
    const end = (m.index ?? 0) + m[0].length - 1;
    add(m, [[end - m[2].length, end]]);
  }
  for (const m of masked.matchAll(new RegExp(`${ref}\\s+in\\s*\\(\\s*'( *)'(?:\\s*,\\s*'( *)')*\\s*\\)`, "gi"))) {
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

/** 질문이 그 값을 말하는가: 영문 값(밑줄은 띄어 써도) 또는 그 값의 우리말 낱말. value 가 "" 면 그 열 전체를 가리키는 낱말. */
function saysValue(question: string, words: Readonly<Record<string, string>> | undefined, value: string): boolean {
  const ko = words?.[value];
  if (ko && new RegExp(ko, "i").test(question)) return true;
  return value !== "" && new RegExp(`(?<![A-Za-z])${value.replace(/_/g, "[_ ]?")}(?![A-Za-z])`, "i").test(question);
}

/** 질문에 없는 조건 사유의 머리말. untrustedAnswer 가 이것으로 사유를 가른다. */
const UNASKED_REASON = "질문에 없는 조건 ";

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
  for (const c of enumConditions(sql, enums)) {
    const vocab = [...new Set([...enums.values()].flatMap((cols) => cols.get(c.col) ?? []))];
    if (c.values.some((v) => !c.tables.some((t) => enums.get(t)?.get(c.col)?.includes(v)))) continue;
    // 질문이 말한 상태가 이 표의 열에 하나도 없으면(「취소되지 않은 프로젝트는 몇 개야?」의 취소는 계약 상태다) 질문이 말하지 않은 값을
    // 고른 조건은 질문의 상태를 다른 상태로 바꾼 것이다. status = 'completed' 로 6개를 세고 「알 수 없습니다」라고 답했다(4차 수정본 실측 R2).
    const own = [...new Set(c.tables.flatMap((t) => enums.get(t)?.get(c.col) ?? []))];
    const named = new Set([
      ...Object.entries(words)
        .filter(([tc]) => tc.endsWith(`.${c.col}`))
        .flatMap(([, w]) => Object.keys(w).filter((v) => v !== "" && saysValue(question, w, v))),
      ...vocab.filter((v) => saysValue(question, undefined, v)),
    ]);
    const ownSaid = c.values.some((v) => c.tables.some((t) => saysValue(question, words[`${t}.${c.col}`], v)));
    const alike = (v: string) => [v, ...(SAME_STATE.get(schema) ?? []).filter((g) => g.includes(v)).flat()];
    if (named.size && [...named].every((v) => !alike(v).some((x) => own.includes(x))) && !ownSaid) {
      reasons.push(
        `${UNASKED_REASON}${c.cond} 은 질문이 묻지 않은 조건이다(질문이 말한 상태 ${[...named].map((v) => `'${v}'`).join(", ")} 는 ` +
          `${c.tables.map((t) => `${t}.${c.col}`).join(", ")} 에 없는 값이다. 쓸 수 있는 값: ${own.join(", ")}). ` +
          "그 상태가 아닌 것을 물으면 이 조건을 빼고 모두 세고, 그 상태를 물으면 없는 값이라 0건이다",
      );
      continue;
    }
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
  return reasons;
}

/** 비율 사유의 머리말. */
const RATIO_REASON = "나눗셈 ";
const RATIO_WORDS = /퍼센트|%|％|비율|비중|증감률|증가율|감소율|성장률|대비/;
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
 * (랜덤 테스트 4차 수정본 실측 I8a). */
const ONE_ROW_TAIL =
  /\b(?:(?:offset\s+\d+\s+(?:rows?\s+)?)?limit\s+1(?:\s+offset\s+\d+(?:\s+rows?)?)?|(?:offset\s+\d+\s+rows?\s+)?fetch\s+(?:first|next)\s+1\s+rows?\s+(?:only|with\s+ties))\s*;?\s*$/i;

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

/** 생성 SQL(과 수리 SQL)을 실행하기 전의 검사 사유. 비었으면 실행해도 된다. executeWithRepair 가 부르고, 순서는 조인과 id
 * (checkSql, confirmNamedIds), 금액 단위(checkMoney), 집계를 부풀리는 조인(fanoutJoins, confirmFanout), 기간(checkPeriod),
 * 값 어휘(checkEnum), 질문에 없는 값 조건(checkUnaskedEnum), 비율의 정수 나눗셈(checkRatio), 집계 단위(checkMonthUnit,
 * checkGroupTop, checkBothEnds, confirmCountUnit), PostgreSQL 이 읽지 못하는 꼴(checkSyntax)이다. */
export async function untrustedReasons(pool: Pool, schema: string, sql: string, question: string): Promise<string[]> {
  const fks = await declaredForeignKeys(pool, schema);
  const v = checkSql(sql, question, fks, await declaredColumns(pool, schema));
  return [
    ...(v.ok ? [] : await confirmNamedIds(pool, schema, v, question)),
    ...checkMoney(sql, question, moneyColumns(schema)),
    ...(await confirmFanout(pool, schema, fanoutJoins(sql, fks))),
    ...checkPeriod(sql, question),
    ...checkEnum(sql, enumColumns(schema)),
    ...checkUnaskedEnum(sql, question, enumColumns(schema), schema),
    ...checkRatio(sql, question),
    ...checkMonthUnit(sql, question),
    ...checkGroupTop(sql, question),
    ...checkBothEnds(sql, question),
    ...(await confirmCountUnit(pool, sql, question)),
    ...checkSyntax(sql),
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
  return new RegExp(`^(${families.map((f) => f.words).join("|")})${VAGUE_TAIL}$`).exec(q)?.[1] ?? null;
}

/** 측정 항목 한 낱말뿐인 질문의 답. 조회하지 않았다고 말하고, 함께 물을 대상과 이 데이터에서 맞게 답하는 예시를 든다. */
export function vagueAnswer(word: string): string {
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
    return {
      policy: "sql-trust-gate",
      verdict: "deny",
      detail:
        `질문이 측정 항목 한 낱말(「${gate.vague}」)뿐이라 어느 기간, 어느 대상의 값을 조회할지 정할 수 없어 SQL 을 만들지 않았고 ` +
        "답하지 않았다(대상을 함께 물어 달라고 되물음)",
    };
  }
  const why = gate.rejected.map((r) => `「${r.sql.replace(/\s+/g, " ")}」: ${r.reasons.join("; ")}`).join(" / ");
  const head =
    gate.outcome === "refused"
      ? "생성 SQL 을 실행하지 않았고 믿을 만한 SQL 을 만들지 못해 답하지 않았다"
      : gate.outcome === "repaired"
        ? "처음 생성 SQL 을 실행하지 않고 1회 수리한 SQL 을 실행했다"
        : "0행 수리로 만든 SQL 을 실행하지 않고 처음 SQL(0행)을 그대로 썼다";
  return { policy: "sql-trust-gate", verdict: gate.outcome === "repaired" ? "repair" : "deny", detail: `${head} — ${why}` };
}

/** 믿을 만한 SQL 을 만들지 못했을 때의 답. 7B 를 부르지 않는다. 금액 단위만 걸렸으면 금액 조건을 말하고 만원으로
 * 바꿔 묻는 법을 알린다. */
export function untrustedAnswer(gate: SqlGate): string {
  if (gate.vague) return vagueAnswer(gate.vague);
  const reasons = gate.rejected.flatMap((r) => r.reasons);
  const missing = reasons.map((r) => MISSING_COLUMN.exec(r)?.[1]).find((x) => x !== undefined);
  const join = reasons.find((r) => r.startsWith("조인 조건"))?.match(/^조인 조건 (.+?) 은/)?.[1];
  const id = reasons
    .find(
      (r) =>
        !["조인 조건", MONEY_REASON, FANOUT_REASON, PERIOD_REASON, ENUM_REASON, UNASKED_REASON, RATIO_REASON, UNIT_REASON, SYNTAX_REASON].some((p) =>
          r.startsWith(p),
        ),
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
  const unasked = reasons.find((r) => r.startsWith(UNASKED_REASON))?.match(/^질문에 없는 조건 (.+?) 은 질문이 묻지 않은 조건이다/)?.[1];
  const syntax = reasons.find((r) => r.startsWith(SYNTAX_REASON));
  // 값 어휘에 없는 값이 있으면 그것부터 말한다. 질문이 데이터에 없는 상태를 물었다는 뜻이라 다른 사유(조인 열 따위)보다
  // 묻는 사람에게 가깝다(「취소된 프로젝트 목록을 알려줘」: projects.status 에 cancelled 가 없다. 종전 답은 dept_id 조인을 먼저 말함).
  const why = value
    ? `생성된 SQL 이 ${value[2]} 에 없는 값(${value[1]})으로 조건을 걸어서 실행하지 않았습니다. ${value[2]} 의 값은 ${value[3]} 입니다. `
    : missing
    ? `생성된 SQL 이 표에 없는 열로 표를 이어서(${missing}) 실행하지 않았습니다. `
    : join
    ? `생성된 SQL 이 외래키가 아닌 열(${join})로 표를 이어서 실행하지 않았습니다. `
    : id
      ? `생성된 SQL 이 질문에 없는 번호(${id})로 한 건만 골라서 실행하지 않았습니다. `
      : fan
        ? `생성된 SQL 이 ${fan[2]} 의 값(${fan[1]})을 ${fan[3]} 와 조인한 채 집계해 같은 값을 여러 번 더해서 실행하지 않았습니다. `
        : unasked
          ? `생성된 SQL 이 질문에 없는 조건(${unasked})을 붙여서 실행하지 않았습니다. `
          : reasons.some((r) => r.startsWith(RATIO_REASON))
            ? "생성된 SQL 이 비율을 정수끼리 나눠 소수점 아래를 버려서 실행하지 않았습니다. "
            : unit
              ? unit.includes("count(*)")
                ? "생성된 SQL 이 수 하나 대신 그룹마다 수를 돌려줘서 실행하지 않았습니다. "
                : unit.includes("마다 1위")
                  ? "생성된 SQL 이 묶음마다 1위가 아니라 전체 1위만 골라서 실행하지 않았습니다. "
                  : unit.includes("가장 낮은 쪽을 함께")
                    ? "생성된 SQL 이 가장 높은 쪽과 가장 낮은 쪽 가운데 한쪽만 골라서 실행하지 않았습니다. "
                    : "생성된 SQL 이 달로 묶지 않아 달을 고를 수 없어서 실행하지 않았습니다. "
              : syntax
                ? syntax.includes("자리표시")
                  ? "생성된 SQL 이 값 대신 자리표시(?)를 써서 실행하지 않았습니다. "
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
