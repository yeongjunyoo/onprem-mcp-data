// 라우터 기동 상태 — 서버와 평가가 같은 함수로 만든다.
//
// 라우터는 두 가지를 기동 때 설치한다. DB 의 온톨로지(타입쌍 추론)와 시맨틱 폴백의
// 앵커 임베딩이다. 둘 다 없으면 라우터는 규칙만으로 돈다. 서버(index.ts)는 둘을 설치했는데
// 종단 평가 CLI 들은 설치하지 않았고, 그래서 채점표가 서버가 아닌 경로를 쟀다
// (2026-09-30: 홀드아웃3 정형 20문항 중 13문항만 SQL 레인에 갔다. 서버 경로는 19문항).
// 평가가 서버와 같은 상태에서 돌려면 같은 함수를 불러야 한다.
import { installOntology } from "./router.js";
import { installSemanticRouter } from "./semroute.js";
import { getPool } from "./db.js";
import { getEmbedder } from "./embedder.js";
import { loadOntologyForRouter } from "./graph.js";

/** 라우터 온톨로지 적재 상태. 시연·감사에서 확인할 수 있게 노출한다. */
let ontologyState: { entities: number; typePairs: number; error?: string } = {
  entities: 0,
  typePairs: 0,
  error: "not loaded",
};

export function routerOntologyState(): Readonly<typeof ontologyState> {
  return ontologyState;
}

/** 기동 시 1회. 실패해도 서버는 뜨고, 라우터는 폴백 정규식으로 계속 돈다.
 *
 * 이것이 없으면 평가에서 잰 라우팅 성능이 서버 경로에서 재현되지 않는다(이슈 #18).
 * 그래서 실패를 조용히 삼키지 않고 경고와 상태로 남긴다. */
export async function loadRouterOntology(): Promise<Readonly<typeof ontologyState>> {
  try {
    const { nodes, edges } = await loadOntologyForRouter(getPool());
    const r = installOntology(nodes, edges);
    ontologyState = { entities: r.entities, typePairs: r.typePairs };
    if (r.entities === 0) {
      ontologyState.error = "empty";
      console.warn("[router] 온톨로지가 비어 있다 — 타입쌍 추론 없이 폴백으로 동작한다");
    }
  } catch (e) {
    ontologyState = { entities: 0, typePairs: 0, error: String(e).slice(0, 200) };
    console.warn(`[router] 온톨로지 적재 실패 — 폴백으로 동작한다: ${ontologyState.error}`);
  }
  return ontologyState;
}

/** 기동 시 1회. 임베딩 모델(bge-m3)이 있을 때만 시맨틱 폴백 앵커를 임베딩한다.
 * 해시 임베더는 의미를 담지 않으므로 설치하지 않는다 — 그때 라우터는 규칙만으로 돈다. */
export async function loadSemanticRouter(): Promise<{ anchors: number; error?: string }> {
  const embedder = getEmbedder();
  if (!embedder.name.startsWith("ollama")) return { anchors: 0, error: `embedder ${embedder.name}: 규칙만 사용` };
  return installSemanticRouter(embedder);
}

/** 서버 기동과 같은 라우터 상태를 만든다. 평가 CLI 는 ask/retrieve 를 부르기 전에 이것을 부른다
 * (semroute.test 가 companyx 평가 CLI 소스를 읽어 강제한다). 결과는 평가 파일에 그대로 싣는다. */
export async function initRouting(): Promise<{
  ontology: Readonly<typeof ontologyState>;
  semantic: { anchors: number; error?: string };
}> {
  const ontology = await loadRouterOntology();
  const semantic = await loadSemanticRouter();
  console.error(
    `[router] 온톨로지 ${ontology.error ? `미적재(${ontology.error})` : `${ontology.entities}개`}, ` +
      `시맨틱 앵커 ${semantic.error ? `없음(${semantic.error})` : `${semantic.anchors}개`}`,
  );
  return { ontology, semantic };
}
