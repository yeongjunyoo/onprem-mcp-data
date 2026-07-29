// 한국어 정규화 계약 — 검색과 SQL과 그래프가 **같은 규칙**으로 문자열을 본다.
//
// 왜 계약인가. 지금까지 각 레인이 제 나름대로 문자열을 잘랐다. 벡터 레인은 임베딩에
// 맡겼고, 그래프 시드는 substring을 썼고, 라우터는 자체 어휘 사전을 봤다. 그래서
// "고객사 Client-A"와 "클라이언트 client a"가 어느 레인에서는 같고 어느 레인에서는
// 달랐다. 한 곳에서 규칙을 정의하고 모두가 그것을 쓰면 그 불일치가 사라진다.
//
// 규칙은 전부 결정론이고 순수 함수다. 사전은 스키마와 그래프 온톨로지에 실제로
// 존재하는 어휘에서만 만든다. 평가 문항에서 어휘를 뽑으면 그건 과적합이다.
//
// 한국어에서 이 계약이 다루는 것:
//   1. 조사와 어미      "고객사가", "고객사를" -> "고객사"
//   2. 띄어쓰기 변형    "고객 사", "고객사"     -> 둘 다 "고객사"를 만든다
//   3. 혼용 표기        "Product-C1"            -> "product", "c1", "productc1"
//   4. 약어와 동의어    "클라이언트"            -> "고객사"
//   5. 대소문자와 폭    NFKC 정규화 후 소문자
import { contentTerms } from "./text.js";

/** 조사·어미. text.ts의 것보다 넓다(2음절 조사와 복합 조사를 포함). */
const PARTICLE_TAIL =
  /(으로부터|로부터|에서부터|이라는|라는|에게서|으로서|으로써|이지만|지만|에서는|에게는|까지도|부터는|은|는|이|가|을|를|에|의|와|과|도|로|으로|에서|에게|까지|부터|만|이나|나|든지|처럼|보다|마다|조차|밖에)$/;

/** 서술형 어미. 질문 문장에서 자주 붙는 것만 최소로 자른다. */
const VERB_TAIL = /(합니다|입니다|했나요|하나요|인가요|는가|은가|나요|해줘|알려줘|보여줘|주세요|이야|야|임|중인|중)$/;

/**
 * 동의어 사전. **스키마와 그래프 온톨로지에 실재하는 어휘만** 넣는다.
 * 왼쪽(변형)을 오른쪽(정규형)으로 접는다. 평가 문항에서 뽑지 않는다.
 */
const SYNONYM: Record<string, string> = {
  // 관계형 스키마의 테이블·컬럼 어휘
  클라이언트: "고객사",
  client: "고객사",
  고객: "고객사",
  거래처: "고객사",
  product: "제품",
  프로덕트: "제품",
  솔루션: "제품",
  employee: "직원",
  사원: "직원",
  담당자: "직원",
  엔지니어: "직원",
  department: "부서",
  팀: "부서",
  project: "프로젝트",
  contract: "계약",
  ticket: "티켓",
  문의: "티켓",
  장애: "장애",
  sales: "매출",
  판매: "매출",
  // 상태 어휘 (스키마 카드의 열거형 값)
  진행중: "in_progress",
  진행: "in_progress",
  완료: "completed",
  대기: "on_hold",
  해결: "resolved",
  종료: "closed",
  활성: "active",
};

/** 유니코드 폭과 호환 문자를 접고 소문자로 내린다. */
function fold(text: string): string {
  return text.normalize("NFKC").toLowerCase();
}

/** 영숫자 혼합 토큰을 조각으로도 낸다: product-c1 -> product, c1, productc1 */
function splitAlnum(token: string): string[] {
  if (!/[a-z]/.test(token) || !/[0-9]/.test(token)) return [];
  const parts = token.match(/[a-z]+|[0-9]+/g) ?? [];
  return parts.length > 1 ? [...parts, parts.join("")] : [];
}

/** 조사와 어미를 벗긴다. 2음절 이상 한글에만 적용해 "이가" 같은 짧은 이름을 지키지 않는다. */
export function stripTails(token: string): string {
  let w = token;
  if (/^[가-힣]{3,}$/.test(w)) {
    w = w.replace(VERB_TAIL, "");
  }
  if (/^[가-힣]{3,}$/.test(w)) {
    w = w.replace(PARTICLE_TAIL, "");
  }
  return w.length >= 2 ? w : token;
}

/**
 * 문자열을 정규화 토큰 집합으로. 문서 색인과 질의 양쪽이 이 함수를 쓴다.
 * 같은 함수를 쓰는 것이 계약의 핵심이다.
 */
export function normalizeTokens(text: string): string[] {
  const folded = fold(text);
  const out = new Set<string>();

  for (const raw of folded.match(/[가-힣]+|[a-z0-9]+/g) ?? []) {
    const base = stripTails(raw);
    if (base.length < 2) continue;
    out.add(base);
    const syn = SYNONYM[base];
    if (syn) out.add(syn);
    for (const piece of splitAlnum(base)) {
      if (piece.length >= 2) out.add(piece);
    }
  }

  // 하이픈이나 공백으로 끊긴 영숫자 식별자를 붙인 형태도 만든다.
  // "Product-C1"은 토큰 분리에서 product와 c1로 갈라지므로 결합형을 따로 만들어야
  // 문서의 "productc1" 표기와 만난다.
  const alnum = (folded.match(/[a-z0-9]+/g) ?? []).map(stripTails);
  for (let i = 0; i < alnum.length - 1; i++) {
    const joined = alnum[i] + alnum[i + 1];
    if (joined.length >= 2 && joined.length <= 24) out.add(joined);
  }

  // 띄어쓰기 변형 흡수: 인접한 짧은 한글 토큰을 붙인 형태도 후보로 둔다.
  // "고객 사 목록" -> "고객사"가 만들어져야 문서의 "고객사"와 만난다.
  const hangul = (folded.match(/[가-힣]+/g) ?? []).map(stripTails);
  for (let i = 0; i < hangul.length - 1; i++) {
    const joined = hangul[i] + hangul[i + 1];
    if (joined.length >= 2 && joined.length <= 8) out.add(joined);
  }

  return [...out];
}

export interface NormalizedQuery {
  raw: string;
  /** 정규화 토큰. 색인과 같은 규칙으로 만든다. */
  tokens: string[];
  /** PostgreSQL tsquery 문자열. simple 설정에 우리 토큰을 그대로 넣는다. */
  tsquery: string;
  /** 계약이 실제로 무엇을 했는지. 감사와 디버깅용. */
  applied: { stripped: string[]; synonyms: string[]; joined: string[] };
}

/** 질의 정규화. tsquery는 OR 결합이고 순위는 ts_rank_cd가 정한다. */
export function normalizeQuery(query: string): NormalizedQuery {
  const tokens = normalizeTokens(query);
  const folded = fold(query);
  const rawTokens: string[] = folded.match(/[가-힣]+|[a-z0-9]+/g) ?? [];

  const stripped: string[] = [];
  const synonyms: string[] = [];
  for (const raw of rawTokens) {
    const base = stripTails(raw);
    if (base !== raw) stripped.push(`${raw} -> ${base}`);
    if (SYNONYM[base]) synonyms.push(`${base} -> ${SYNONYM[base]}`);
  }
  const joined = tokens.filter((t) => !rawTokens.includes(t) && /^[가-힣]+$/.test(t));

  // tsquery 안전: 토큰은 이미 [가-힣a-z0-9]로만 이루어져 있어 연산자 주입이 불가능하다.
  const tsquery = tokens.length ? tokens.map((t) => `${t}:*`).join(" | ") : "";

  return { raw: query, tokens, tsquery, applied: { stripped, synonyms, joined } };
}

/** 문서 색인용 토큰 문자열. tsvector로 만들 때 쓴다. */
export function indexText(text: string): string {
  return normalizeTokens(text).join(" ");
}
