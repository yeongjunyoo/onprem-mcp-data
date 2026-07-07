// WS-A — deterministic benchmark seed generator (schema `bench`).
//
// Fully deterministic (seeded mulberry32) so gold SQL results are reproducible.
// Loads eval/internal/schema.sql then inserts thousands of rows across the
// e-commerce domain, and grants the least-privilege role SELECT on everything
// EXCEPT bench.admin_secrets (which powers permission-denied eval cases).
//
// Run: npm run gen:bench   (DATABASE_URL must point at the writable owner).
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { getPool, closePool } from "../db.js";

const SEED = 42;

/** mulberry32 — tiny deterministic PRNG. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const r = rng(SEED);
const pick = <T>(arr: T[]): T => arr[Math.floor(r() * arr.length)];
const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
const weighted = <T>(pairs: [T, number][]): T => {
  const total = pairs.reduce((s, [, w]) => s + w, 0);
  let x = r() * total;
  for (const [v, w] of pairs) {
    if ((x -= w) < 0) return v;
  }
  return pairs[pairs.length - 1][0];
};
const dateBetween = (startYmd: string, endYmd: string): string => {
  const s = Date.parse(startYmd), e = Date.parse(endYmd);
  return new Date(s + Math.floor(r() * (e - s))).toISOString().slice(0, 10);
};

const CATEGORIES = ["의류", "전자기기", "식품", "가구", "도서", "뷰티", "스포츠", "완구"];
const REGIONS = ["서울", "경기", "부산", "대구", "인천", "광주", "대전", "제주"];
const SEGMENTS: [string, number][] = [["regular", 60], ["new", 25], ["vip", 15]];
const ORDER_STATUS: [string, number][] = [["paid", 55], ["shipped", 22], ["cancelled", 11], ["refunded", 12]];
const TICKET_REASON: [string, number][] = [["단순문의", 40], ["배송지연", 25], ["환불요청", 20], ["상품불량", 15]];
const TICKET_STATUS: [string, number][] = [["resolved", 55], ["open", 30], ["escalated", 15]];
const SUPPLIERS = ["대한상사", "글로벌무역", "한빛유통", "미래상회", null, null]; // ~33% null

const N_CUST = 80, N_PROD = 60, N_ORDER = 2000, N_TICKET = 300;

async function main() {
  const pool = getPool();
  const here = dirname(fileURLToPath(import.meta.url));
  const schemaPath = resolve(here, "../../../eval/internal/schema.sql");
  const schema = await readFile(schemaPath, "utf8");
  await pool.query(schema);

  // categories
  await pool.query(
    `INSERT INTO bench.categories (id, name) VALUES ${CATEGORIES.map((_, i) => `(${i + 1}, $${i + 1})`).join(",")}`,
    CATEGORIES,
  );

  // customers
  {
    const rows: unknown[][] = [];
    for (let i = 1; i <= N_CUST; i++)
      rows.push([i, `고객${i}`, weighted(SEGMENTS), pick(REGIONS), dateBetween("2024-01-01", "2025-06-01")]);
    await batchInsert(pool, "bench.customers (id, name, segment, region, created_at)", rows);
  }

  // products
  {
    const vals: string[] = [], params: unknown[] = [];
    for (let i = 1; i <= N_PROD; i++) {
      const b = (i - 1) * 6;
      vals.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6})`);
      params.push(i, `상품${i}`, int(1, CATEGORIES.length), int(5, 200) * 1000, pick(SUPPLIERS), r() < 0.9);
    }
    await pool.query(
      `INSERT INTO bench.products (id, name, category_id, price, supplier, active) VALUES ${vals.join(",")}`,
      params,
    );
  }

  // orders + items (order.total derived from its items)
  {
    const orders: unknown[][] = [];
    const items: unknown[][] = [];
    let itemId = 0;
    for (let oid = 1; oid <= N_ORDER; oid++) {
      const customerId = int(1, N_CUST);
      const status = weighted(ORDER_STATUS);
      const createdAt = dateBetween("2025-01-01", "2026-06-30");
      const nItems = int(1, 5);
      let total = 0;
      for (let k = 0; k < nItems; k++) {
        const pid = int(1, N_PROD);
        const qty = int(1, 4);
        const unit = int(5, 200) * 1000;
        total += qty * unit;
        items.push([++itemId, oid, pid, qty, unit]);
      }
      orders.push([oid, customerId, status, total, createdAt]);
    }
    await batchInsert(pool, "bench.orders (id, customer_id, status, total, created_at)", orders);
    await batchInsert(pool, "bench.order_items (id, order_id, product_id, qty, unit_price)", items);
  }

  // support tickets (order optional)
  {
    const rows: unknown[][] = [];
    for (let i = 1; i <= N_TICKET; i++) {
      const customerId = int(1, N_CUST);
      const hasOrder = r() < 0.7;
      const orderId = hasOrder ? int(1, N_ORDER) : null;
      rows.push([i, customerId, orderId, weighted(TICKET_REASON), weighted(TICKET_STATUS), dateBetween("2025-02-01", "2026-06-30")]);
    }
    await batchInsert(pool, "bench.support_tickets (id, customer_id, order_id, reason, status, created_at)", rows);
  }

  // documents (policy / faq / guide)
  const docs: [string, string, string][] = [
    ["환불 정책", "단순 변심 반품은 수령 후 7일 이내 가능하며 택배비는 고객 부담입니다.", "policy"],
    ["배송 정책", "출고 후 보통 2~3일 내 도착하며 운송장은 문자로 안내됩니다. 제주/도서산간은 추가 1~2일.", "policy"],
    ["교환 정책", "상품 불량 교환은 수령 후 14일 이내 무료로 가능합니다.", "policy"],
    ["멤버십 등급", "VIP는 최근 6개월 구매 실적 기준으로 매월 1일 자동 산정됩니다.", "policy"],
    ["적립금 안내", "구매 확정 시 결제 금액의 1%가 적립되며 유효기간은 1년입니다.", "faq"],
    ["배송 지연 문의", "배송이 3일 이상 지연되면 고객센터로 문의하시면 보상 쿠폰을 드립니다.", "faq"],
    ["품절 안내", "품절 상품은 재입고 알림 신청 시 입고 즉시 문자로 안내합니다.", "faq"],
    ["반품 신청 방법", "마이페이지 > 주문내역에서 반품 신청 후 상품을 회수 기사에게 전달하세요.", "guide"],
  ];
  // diverse filler FAQs (deterministic, NO 환불/배송/교환/반품 keywords so they
  // don't pollute refund/delivery semantic retrieval).
  const FILLER: [string, string][] = [
    ["회원가입 방법", "이메일 인증을 마치면 가입이 완료되며 만 14세 이상만 가입할 수 있습니다."],
    ["비밀번호 재설정", "로그인 화면의 비밀번호 찾기에서 등록 이메일로 재설정 링크를 받습니다."],
    ["쿠폰 사용", "결제 단계에서 보유 쿠폰을 선택해 적용하며 중복 사용은 불가합니다."],
    ["현금영수증", "마이페이지 주문상세에서 현금영수증과 세금계산서를 신청할 수 있습니다."],
    ["포인트 적립률", "일반 회원은 1퍼센트, VIP 회원은 3퍼센트가 적립되고 리뷰 작성 시 추가됩니다."],
    ["알림 설정", "앱 설정에서 푸시와 문자, 이메일 수신 여부를 항목별로 끌 수 있습니다."],
    ["결제 수단", "신용카드와 계좌이체, 간편결제를 지원하며 일부 카드 무이자 할부가 됩니다."],
    ["장바구니 보관", "장바구니에 담은 상품은 최대 30일간 보관되며 이후 자동으로 비워집니다."],
    ["위시리스트", "관심 상품을 위시리스트에 저장하면 가격 변동 시 알림을 받을 수 있습니다."],
    ["리뷰 작성", "구매 확정 후 30일 이내에 사진 리뷰를 남기면 포인트가 추가 적립됩니다."],
    ["고객센터 운영시간", "고객센터는 평일 오전 9시부터 오후 6시까지 운영하며 주말은 휴무입니다."],
    ["앱 설치 혜택", "모바일 앱 최초 설치 후 로그인하면 웰컴 쿠폰을 즉시 지급합니다."],
    ["이벤트 참여", "진행 중인 이벤트는 이벤트 페이지에서 응모 버튼을 눌러 참여합니다."],
    ["개인정보 수정", "마이페이지 회원정보에서 연락처와 이메일을 직접 수정할 수 있습니다."],
    ["회원 탈퇴", "회원 탈퇴는 마이페이지 하단에서 가능하며 보유 포인트는 소멸됩니다."],
    ["추천인 코드", "친구 추천 코드를 입력하면 추천인과 신규 회원 모두 쿠폰을 받습니다."],
    ["기프트카드", "기프트카드는 결제 시 잔액 범위 내에서 사용하며 잔액은 이월됩니다."],
    ["재입고 알림", "재입고 알림을 신청하면 입고 즉시 문자로 안내를 받습니다."],
    ["대량 구매 문의", "기업 대량 구매는 별도 견적이 필요하니 고객센터로 문의해 주세요."],
    ["선물 포장", "선물 포장 옵션을 선택하면 메시지 카드를 함께 동봉해 드립니다."],
    ["영업일 기준", "영업일은 주말과 공휴일을 제외한 평일을 의미합니다."],
    ["계정 보안", "2단계 인증을 켜면 로그인 시 추가 코드 입력으로 계정을 보호합니다."],
  ];
  let fi = 0;
  while (docs.length < 30) {
    const f = FILLER[fi % FILLER.length];
    docs.push([f[0], f[1], "faq"]);
    fi++;
  }
  await batchInsert(
    pool,
    "bench.documents (id, title, body, doc_type)",
    docs.map((d, i) => [i + 1, d[0], d[1], d[2]]),
  );

  // ===== knowledge graph (entities / aliases / relations / entity_links) =====
  // Derived deterministically from the already-loaded relational + document rows.
  const catEntId = (i: number) => i; // 1..8
  const prodEntId = (pid: number) => 100 + pid; // 101..160
  const polEntId = (docId: number) => 1000 + docId; // 1001..100x

  const entities: unknown[][] = [];
  const aliases: unknown[][] = [];
  const relations: unknown[][] = [];
  const links: unknown[][] = [];

  // category entities + aliases + links
  const CAT_ALIAS: Record<string, [string, string][]> = {
    "의류": [["옷", "ko"], ["clothing", "en"]],
    "전자기기": [["전자제품", "ko"], ["electronics", "en"]],
    "식품": [["음식", "ko"], ["food", "en"]],
    "가구": [["퍼니처", "ko"], ["furniture", "en"]],
    "도서": [["책", "ko"], ["books", "en"]],
    "뷰티": [["화장품", "ko"], ["beauty", "en"]],
    "스포츠": [["운동용품", "ko"], ["sports", "en"]],
    "완구": [["장난감", "ko"], ["toys", "en"]],
  };
  CATEGORIES.forEach((name, i) => {
    const eid = catEntId(i + 1);
    entities.push([eid, "category", name]);
    for (const [alias, lang] of CAT_ALIAS[name] ?? []) aliases.push([eid, alias, lang]);
    links.push([eid, "sql", "categories", i + 1, null, null, null, `bench.categories#${i + 1}`]);
  });

  // product entities + in_category relations + links (category_id read back from DB)
  const prods = (await pool.query<{ id: number; category_id: number }>(
    "SELECT id, category_id FROM bench.products ORDER BY id",
  )).rows;
  let relId = 0;
  for (const p of prods) {
    const eid = prodEntId(p.id);
    entities.push([eid, "product", `상품${p.id}`]);
    links.push([eid, "sql", "products", p.id, null, null, null, `bench.products#${p.id}`]);
    relations.push([++relId, eid, "in_category", catEntId(p.category_id), 1.0, `bench.products#${p.id}.category_id`]);
  }

  // policy entities (first 8 curated docs are the named policy/faq) + aliases + links
  const POL_ALIAS: Record<string, [string, string][]> = {
    "환불 정책": [["반품 정책", "ko"], ["refund policy", "en"]],
    "배송 정책": [["배달 정책", "ko"], ["delivery policy", "en"]],
    "교환 정책": [["exchange policy", "en"]],
    "멤버십 등급": [["membership tier", "en"]],
  };
  docs.slice(0, 8).forEach((d, i) => {
    const docId = i + 1;
    const eid = polEntId(docId);
    entities.push([eid, "policy", d[0]]);
    for (const [alias, lang] of POL_ALIAS[d[0]] ?? []) aliases.push([eid, alias, lang]);
    links.push([eid, "vector", "documents", docId, docId, 0, d[1].length, `documents#${docId}`]);
  });

  // applies_to: policy -> category (curated, edge-required for graph-only questions)
  const byCat = (name: string) => catEntId(CATEGORIES.indexOf(name) + 1);
  const polEnt = (title: string) => polEntId(docs.findIndex((d) => d[0] === title) + 1);
  const APPLIES: [string, string][] = [
    ["환불 정책", "의류"], ["환불 정책", "전자기기"], ["환불 정책", "식품"],
    ["교환 정책", "전자기기"], ["교환 정책", "가구"], ["배송 정책", "식품"],
  ];
  for (const [pol, cat] of APPLIES)
    relations.push([++relId, polEnt(pol), "applies_to", byCat(cat), 1.0, `curated:${pol}->${cat}`]);
  // substitutes: category <-> category (a little graph variety)
  relations.push([++relId, byCat("완구"), "substitutes", byCat("도서"), 0.8, "curated:gift-substitute"]);
  relations.push([++relId, byCat("전자기기"), "substitutes", byCat("완구"), 0.6, "curated:gift-substitute"]);

  await batchInsert(pool, "bench.entities (id, type, canonical_name)", entities);
  await batchInsert(pool, "bench.aliases (entity_id, alias, lang)", aliases);
  await batchInsert(pool, "bench.relations (id, src_entity_id, rel_type, dst_entity_id, confidence, provenance)", relations);
  await batchInsert(pool, "bench.entity_links (entity_id, source_kind, source_table, source_pk, document_id, span_start, span_end, provenance)", links);

  // admin secrets (must remain invisible to mcp_ro)
  await pool.query(
    `INSERT INTO bench.admin_secrets (id, secret) VALUES (1,'ROOT_TOKEN_X'),(2,'BILLING_KEY_Y'),(3,'INTERNAL_Z')`,
  );

  // least-privilege grants: SELECT on bench.* EXCEPT admin_secrets
  await pool.query("GRANT USAGE ON SCHEMA bench TO mcp_ro");
  for (const t of ["categories", "customers", "products", "orders", "order_items", "support_tickets", "documents", "entities", "aliases", "relations", "entity_links"]) {
    await pool.query(`GRANT SELECT ON bench.${t} TO mcp_ro`);
  }
  await pool.query("REVOKE ALL ON bench.admin_secrets FROM mcp_ro");

  // report
  const counts: Record<string, number> = {};
  for (const t of ["categories", "customers", "products", "orders", "order_items", "support_tickets", "documents", "entities", "aliases", "relations", "entity_links", "admin_secrets"]) {
    const res = await pool.query(`SELECT count(*)::int AS n FROM bench.${t}`);
    counts[t] = res.rows[0].n;
  }
  console.log(`bench seed (deterministic, seed=${SEED}):`, JSON.stringify(counts));
  await closePool();
}

async function batchInsert(pool: ReturnType<typeof getPool>, into: string, rows: unknown[][], chunk = 500) {
  if (rows.length === 0) return;
  const cols = rows[0].length;
  for (let i = 0; i < rows.length; i += chunk) {
    const slice = rows.slice(i, i + chunk);
    const params: unknown[] = [];
    const tuples = slice.map((row, ri) => {
      const ph = row.map((_, ci) => `$${ri * cols + ci + 1}`);
      params.push(...row);
      return `(${ph.join(",")})`;
    });
    await pool.query(`INSERT INTO ${into} VALUES ${tuples.join(",")}`, params);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
