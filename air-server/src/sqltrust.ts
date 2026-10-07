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
import type { Pool } from "./db.js";
import type { PolicyVerdict } from "./auditrecord.js";
import { formatManwon, moneyMentions } from "./money.js";
import { sqlQuery, tokenizeSql, type SqlToken } from "./sql.js";
import { RELATIVE_YEAR, RELATIVE_YEAR_RE, seoulYear } from "./llm.js";

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

  const known = new Set((fks ?? []).flatMap((f) => [f.table, f.refTable]));
  // 별칭 → 테이블. 하위 쿼리마다 같은 별칭을 다른 표에 쓸 수 있어 집합으로 모은다.
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
  if (PART_OF_YEAR.test(question)) return [];
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
 * (checkSql, confirmNamedIds), 금액 단위(checkMoney), 집계를 부풀리는 조인(fanoutJoins, confirmFanout), 기간(checkPeriod)이다. */
export async function untrustedReasons(pool: Pool, schema: string, sql: string, question: string): Promise<string[]> {
  const fks = await declaredForeignKeys(pool, schema);
  const v = checkSql(sql, question, fks, await declaredColumns(pool, schema));
  return [
    ...(v.ok ? [] : await confirmNamedIds(pool, schema, v, question)),
    ...checkMoney(sql, question, moneyColumns(schema)),
    ...(await confirmFanout(pool, schema, fanoutJoins(sql, fks))),
    ...checkPeriod(sql, question),
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
    .find((r) => !r.startsWith("조인 조건") && !r.startsWith(MONEY_REASON) && !r.startsWith(FANOUT_REASON) && !r.startsWith(PERIOD_REASON))
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
  const period = reasons.find((r) => r.startsWith(PERIOD_REASON))?.match(/^기간 조건 (.+?) 은 (\d{4})년의 한 분기만/);
  if (!join && !id && !fan && !money && !missing && period) {
    const [, cond, year] = period;
    return (
      "이 질문의 기간 조건으로는 믿을 수 있는 조회를 만들지 못해 답하지 않았습니다. " +
      `생성된 SQL 이 ${year}년 전체가 아니라 한 분기(${cond})만 골라서 실행하지 않았습니다. ` +
      `분기를 함께 물어봐 주세요. 예: 「${year}년 3분기 총 매출액은 얼마야?」`
    );
  }
  const why = missing
    ? `생성된 SQL 이 표에 없는 열로 표를 이어서(${missing}) 실행하지 않았습니다. `
    : join
    ? `생성된 SQL 이 외래키가 아닌 열(${join})로 표를 이어서 실행하지 않았습니다. `
    : id
      ? `생성된 SQL 이 질문에 없는 번호(${id})로 한 건만 골라서 실행하지 않았습니다. `
      : fan
        ? `생성된 SQL 이 ${fan[2]} 의 값(${fan[1]})을 ${fan[3]} 와 조인한 채 집계해 같은 값을 여러 번 더해서 실행하지 않았습니다. `
        : "";
  return (
    "이 질문으로는 믿을 수 있는 조회를 만들지 못해 답하지 않았습니다. " +
    why +
    "무엇을 알고 싶은지 조금 더 구체적으로 물어봐 주세요. 예: 「2025년 3분기 총 매출액은 얼마야?」, 「기술지원팀 직원 목록과 연봉을 알려줘」"
  );
}

/** WITH TIES 로 실행한 정형 질문이 공동 1위를 둘 이상 돌려줬을 때의 답 문장. 7B 를 부르지 않는다.
 *
 * 7B 는 컨텍스트의 「FETCH FIRST 1 ROWS WITH TIES」를 보고 한 행만 골라 말했다. 「가장 많은 프로젝트를 진행 중인
 * 고객사는?」 3/3 「Client-J」, 「직원이 가장 많은 부서는 어디야?」 「영업팀」(행은 둘 다 붙음). 공동 1위의 이름은
 * 결정론으로 다 적는다(관계 레인의 「공동 1위 3명」과 같은 말). 이름은 첫 문자열 열, 모델에게 간 행만 쓴다.
 * 순위 질문을 rankRewrite 로 실행했으면(sql.rank) 그 순위의 같은 값 행들을 같은 말로 적는다: 「공동 2위가 3건입니다: …」. */
export function tieAnswer(
  r: {
    route: string;
    sql: { text: string | null; rank?: number; result?: { ok: boolean; rows: Record<string, unknown>[] } };
    curated: { kept: { source: string }[] };
  },
  render: (v: unknown) => string,
): string | undefined {
  const res = r.sql.result;
  if (r.route !== "structured" || !res?.ok || res.rows.length < 2) return undefined;
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
