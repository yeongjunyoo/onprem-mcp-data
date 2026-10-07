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
import type { Pool } from "./db.js";
import type { PolicyVerdict } from "./auditrecord.js";

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

/** 생성 SQL 을 실행해도 되는지. 확실히 읽지 못하는 부분은 거부하지 않는다(검사는 아는 꼴만 막는다).
 *  ① `JOIN … ON a.x = b.y` 의 열 쌍마다 선언된 외래키(어느 방향이든)여야 한다. fks 가 비었으면 이 검사는 끈다.
 *  ② `x.id = 숫자`(또는 `id = 숫자`)의 숫자는 질문에 있어야 한다. 질문에 없는 번호로 한 행을 고르는 것은 추측이다. */
export function checkSql(sql: string, question: string, fks: ForeignKey[] | null): SqlCheck {
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
        if (!valid) reasons.push(`조인 조건 ${e[1]} = ${e[2]} 은 스키마에 선언된 외래키가 아니다`);
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

/** 실행 전 검사의 기록. 검사가 아무것도 거부하지 않았으면 만들지 않는다.
 *  refused  — 실행할 믿을 만한 SQL 이 없다. 답하지 않는다.
 *  repaired — 처음 SQL 을 거부하고 수리한 SQL 을 실행했다.
 *  kept     — 0행 수리로 만든 SQL 을 거부하고 처음 SQL(0행)을 그대로 썼다. */
export interface SqlGate {
  outcome: "refused" | "repaired" | "kept";
  rejected: { sql: string; reasons: string[] }[];
}

/** 감사 레코드의 정책 줄. */
export function sqlGatePolicy(gate: SqlGate | undefined): PolicyVerdict | undefined {
  if (!gate) return undefined;
  const why = gate.rejected.map((r) => `「${r.sql.replace(/\s+/g, " ")}」: ${r.reasons.join("; ")}`).join(" / ");
  const head =
    gate.outcome === "refused"
      ? "생성 SQL 을 실행하지 않았고 믿을 만한 SQL 을 만들지 못해 답하지 않았다"
      : gate.outcome === "repaired"
        ? "처음 생성 SQL 을 실행하지 않고 1회 수리한 SQL 을 실행했다"
        : "0행 수리로 만든 SQL 을 실행하지 않고 처음 SQL(0행)을 그대로 썼다";
  return { policy: "sql-trust-gate", verdict: gate.outcome === "repaired" ? "repair" : "deny", detail: `${head} — ${why}` };
}

/** 믿을 만한 SQL 을 만들지 못했을 때의 답. 7B 를 부르지 않는다. */
export function untrustedAnswer(gate: SqlGate): string {
  const reasons = gate.rejected.flatMap((r) => r.reasons);
  const join = reasons.find((r) => r.startsWith("조인 조건"))?.match(/^조인 조건 (.+?) 은/)?.[1];
  const id = reasons.find((r) => !r.startsWith("조인 조건"))?.match(/^(.+?) 의 번호/)?.[1];
  const why = join
    ? `생성된 SQL 이 외래키가 아닌 열(${join})로 표를 이어서 실행하지 않았습니다. `
    : id
      ? `생성된 SQL 이 질문에 없는 번호(${id})로 한 건만 골라서 실행하지 않았습니다. `
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
 * 결정론으로 다 적는다(관계 레인의 「공동 1위 3명」과 같은 말). 이름은 첫 문자열 열, 모델에게 간 행만 쓴다. */
export function tieAnswer(
  r: { route: string; sql: { text: string | null; result?: { ok: boolean; rows: Record<string, unknown>[] } }; curated: { kept: { source: string }[] } },
  render: (v: unknown) => string,
): string | undefined {
  const res = r.sql.result;
  if (r.route !== "structured" || !res?.ok || res.rows.length < 2) return undefined;
  if (!/\bfetch\s+first\s+1\s+rows\s+with\s+ties\s*;?\s*$/i.test(r.sql.text ?? "")) return undefined;
  const kept = new Set(r.curated.kept.filter((it) => it.source.startsWith("sql#")).map((it) => Number(it.source.slice(4))));
  const rows = res.rows.filter((_, i) => kept.has(i));
  if (!rows.length) return undefined;
  const col = Object.keys(rows[0]).find((c) => typeof rows[0][c] === "string") ?? Object.keys(rows[0])[0];
  const rest = res.rows.length - rows.length;
  return `공동 1위가 ${res.rows.length}건입니다: ${rows.map((row) => render(row[col])).join(", ")}${rest > 0 ? ` 외 ${rest}건` : ""}.`;
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
