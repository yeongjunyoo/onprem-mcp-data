// 미해소 개체의 사유 — 게이트가 개체를 못 찾았을 때 「왜」를 구조화 필드로 돌려준다.
//
// 컨텍스트를 비우는 것은 옳다(환각 차단). 그런데 "없다" 한 마디로는 호출한 쪽이
// 다음 행동을 고를 수 없다. 데이터에 아예 없는 이름인지, 비슷한 이름의 다른 개체가
// 있는지(오타·다른 표기)는 다른 상황이다. 후자도 해소하지는 않는다 — 같은 대상인지
// 모르는 채 그 개체의 관계를 넘기면 게이트가 막으려던 것을 다시 들이는 셈이다.
//
// 유사도는 정규화 편집 거리 하나다. 모델도 임베딩도 부르지 않으므로 같은 질의와
// 같은 개체 사전이면 사유와 후보가 항상 같다.

export type NotFoundReason = "not_in_database" | "similar_name_mismatch";

export interface NotFoundCandidate {
  name: string;
  type: string;
  /** 0~1. 1 - 편집거리/긴 쪽 길이 (공백·하이픈·밑줄·마침표를 빼고 소문자로 잰다). */
  score: number;
}

export interface NotFound {
  reason: NotFoundReason;
  /** 못 찾은 질의어. 비슷한 이름이 있으면 그 질의어, 없으면 질의의 첫 개체 후보. */
  query_entity: string;
  /** similar_name_mismatch 일 때만 채운다. 점수 내림차순, 같으면 이름 순. */
  candidates: NotFoundCandidate[];
}

/** 이 점수 이상이면 「비슷한 이름」이다. 임계값은 이 한 곳에만 둔다.
 *
 * 0.6 은 글자의 60% 이상이 그대로 남는다는 뜻이다. 세 글자 이름은 한 글자 차이(0.67)
 * 까지 걸리고 두 글자 차이(0.33)는 빠진다. 두 글자 이름의 한 글자 차이(0.5)는 다른
 * 개체일 가능성이 더 커서 넣지 않는다. */
export const NOT_FOUND_SIMILARITY = 0.6;

/** 사유와 함께 보여 줄 후보 수. 판정에는 쓰지 않는다. */
export const NOT_FOUND_MAX_CANDIDATES = 3;

function norm(s: string): string {
  return s.normalize("NFC").toLowerCase().replace(/[\s\-_.]+/g, "");
}

function levenshtein(a: string[], b: string[]): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** 정규화 편집 유사도(0~1). 대칭이고 결정론이다. */
export function nameSimilarity(a: string, b: string): number {
  const x = [...norm(a)];
  const y = [...norm(b)];
  const longer = Math.max(x.length, y.length);
  if (longer === 0) return 0;
  return 1 - levenshtein(x, y) / longer;
}

/** 질의어 하나와 비슷한 이름의 개체들. 편집거리는 길이 차 이상이므로, 길이 비율이
 * 임계값에 못 미치는 이름은 거리를 재지 않고 건너뛴다. */
export function similarNames(
  term: string,
  lexicon: readonly { name: string; type: string }[],
): NotFoundCandidate[] {
  const tl = [...norm(term)].length;
  if (tl === 0) return [];
  const seen = new Set<string>();
  const out: { name: string; type: string; raw: number }[] = [];
  for (const e of lexicon) {
    const key = `${e.type}\u0000${e.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const el = [...norm(e.name)].length;
    if (Math.min(tl, el) / Math.max(tl, el) < NOT_FOUND_SIMILARITY) continue;
    const raw = nameSimilarity(term, e.name);
    if (raw >= NOT_FOUND_SIMILARITY) out.push({ name: e.name, type: e.type, raw });
  }
  const byCodePoint = (p: string, q: string) => (p < q ? -1 : p > q ? 1 : 0);
  return out
    .sort((p, q) => q.raw - p.raw || byCodePoint(p.name, q.name) || byCodePoint(p.type, q.type))
    .slice(0, NOT_FOUND_MAX_CANDIDATES)
    .map((c) => ({ name: c.name, type: c.type, score: Number(c.raw.toFixed(3)) }));
}

/** 해소에 실패한 질의어들을 사유 하나로 분류한다.
 *
 * 비슷한 이름이 있는 질의어가 하나라도 있으면 similar_name_mismatch 이고, 최고 점수
 * 후보를 가진 질의어가 query_entity 가 된다(동점이면 질의에서 먼저 나온 쪽). 없으면
 * not_in_database 이고 질의의 첫 질의어가 query_entity 다. */
export function classifyNotFound(
  terms: readonly string[],
  lexicon: readonly { name: string; type: string }[],
): NotFound {
  let best: { term: string; candidates: NotFoundCandidate[] } | undefined;
  for (const term of terms) {
    const candidates = similarNames(term, lexicon);
    if (candidates.length && (!best || candidates[0].score > best.candidates[0].score)) {
      best = { term, candidates };
    }
  }
  if (!best) return { reason: "not_in_database", query_entity: terms[0] ?? "", candidates: [] };
  return { reason: "similar_name_mismatch", query_entity: best.term, candidates: best.candidates };
}

/** 사유를 한국어 한 문단으로. 그래프 컨텍스트와 ask 의 답이 같은 문장을 쓴다. */
export function describeNotFound(nf: NotFound): string {
  const head = `질문에 나온 개체(${nf.query_entity})를 데이터베이스에서 찾지 못했습니다.`;
  if (nf.reason === "not_in_database") {
    return `${head} 이름이 비슷한 개체도 없습니다. 해당 개체는 데이터셋에 존재하지 않습니다.`;
  }
  const list = nf.candidates.map((c) => `${c.name}(${c.type})`).join(", ");
  return (
    `${head} 이름이 비슷한 개체는 있습니다: ${list}. ` +
    "같은 대상인지 확인되지 않아 그 개체의 정보로는 답하지 않았습니다."
  );
}
