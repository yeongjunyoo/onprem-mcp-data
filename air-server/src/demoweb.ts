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

// 시연 화면(npm run demo:web)의 부품. 질문, 답, 근거 행이 한 화면에 보이게 한다.
//
// 2026-10-19 출품작 기능검증에서 시험관이 「보여줬을 때 예쁘게 보였으면」이라고 했다. 그날 화면은 MCP Inspector CLI 의
// JSON 이었다. 이 화면은 그 JSON 을 고쳐 쓰지 않는다. 진짜 서버(dist/index.js)를 MCP 클라이언트처럼 stdio 로 띄워
// `ask` 를 부르고, 돌아온 answer, route, audit 를 그대로 펼쳐 보인다. 화면이 서버 밖에서 값을 만들지 않는다.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

type Json = Record<string, unknown>;

/** stdio 로 띄운 MCP 서버에 한 줄에 JSON-RPC 하나를 쓰고 읽는 최소 클라이언트. */
export class McpStdioClient {
  private child: ChildProcessWithoutNullStreams;
  private buf = "";
  private nextId = 0;
  private pending = new Map<number, { resolve: (m: Json) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private stderrTail = "";
  private exited: string | null = null;

  constructor(command: string, args: string[], env: NodeJS.ProcessEnv) {
    this.child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (d: string) => this.onData(d));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (d: string) => {
      this.stderrTail = (this.stderrTail + d).slice(-4000);
    });
    this.child.on("exit", (code, signal) => {
      this.exited = `서버 프로세스가 끝났다(코드 ${code ?? "없음"}${signal ? `, 신호 ${signal}` : ""})`;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error(`${this.exited}. 서버 stderr 끝부분:\n${this.stderrTail.slice(-1500)}`));
      }
      this.pending.clear();
    });
  }

  private onData(d: string) {
    this.buf += d;
    for (let i = this.buf.indexOf("\n"); i >= 0; i = this.buf.indexOf("\n")) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg: Json;
      try {
        msg = JSON.parse(line) as Json;
      } catch {
        continue; // 규격상 stdout 에는 JSON-RPC 만 온다. 아니면 버리고 응답을 기다린다
      }
      const p = typeof msg.id === "number" ? this.pending.get(msg.id) : undefined;
      if (!p) continue;
      this.pending.delete(msg.id as number);
      clearTimeout(p.timer);
      p.resolve(msg);
    }
  }

  /** 서버가 남긴 stderr 끝부분(기동 실패 사유를 화면에 보이려고). */
  stderr(): string {
    return this.stderrTail;
  }

  /** 서버가 끝났으면 그 사유, 살아 있으면 null. */
  exitReason(): string | null {
    return this.exited;
  }

  request(method: string, params: Json | undefined, timeoutMs: number): Promise<Json> {
    if (this.exited) return Promise.reject(new Error(`${this.exited}. 서버 stderr 끝부분:\n${this.stderrTail.slice(-1500)}`));
    const id = ++this.nextId;
    const msg = { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: ${Math.round(timeoutMs / 1000)}초 안에 응답이 없다`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify(msg) + "\n");
    });
  }

  notify(method: string): void {
    if (!this.exited) this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");
  }

  async close(): Promise<void> {
    if (this.exited) return;
    this.child.stdin.end();
    await new Promise((r) => {
      const t = setTimeout(() => {
        this.child.kill();
        r(null);
      }, 3000);
      this.child.once("exit", () => {
        clearTimeout(t);
        r(null);
      });
    });
  }
}

/** tools/call 결과를 도구가 돌려준 객체로 푼다. air 는 handler 의 반환값을 content[0].text 의 JSON 으로 싣는다. */
export function toolPayload(result: Json | undefined): { isError: boolean; value: unknown } {
  if (!result) return { isError: true, value: "결과가 없다" };
  const isError = result.isError === true;
  if (result.structuredContent !== undefined) return { isError, value: result.structuredContent };
  const content = Array.isArray(result.content) ? (result.content as { type?: string; text?: string }[]) : [];
  const text = content.find((c) => c.type === "text" && typeof c.text === "string")?.text ?? "";
  try {
    return { isError, value: JSON.parse(text) };
  } catch {
    return { isError, value: text };
  }
}

export interface RowTable {
  /** 「조회 결과 N건」의 N. */
  count: number;
  columns: string[];
  rows: string[][];
}

const ROWS_MARK = /\n*\[조회 결과 (\d+)건\]\n/;

/** 정형 답 끝에 붙는 「[조회 결과 N건]」 줄들을 표로 푼다(pipeline.ts 가 행을 그대로 붙인다). 그 표시가 없으면 rows 는 null. */
export function splitAnswer(answer: string): { text: string; rows: RowTable | null } {
  const m = ROWS_MARK.exec(answer);
  if (!m) return { text: answer.trim(), rows: null };
  const text = answer.slice(0, m.index).trim();
  const lines = answer
    .slice(m.index + m[0].length)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("- "));
  const columns: string[] = [];
  const rows: string[][] = [];
  for (const line of lines) {
    // 열 이름은 SQL 식별자다. 「, 이름: 」 앞에서만 끊는다(값 안의 쉼표는 그대로 둔다).
    const cells = line.slice(2).split(/, (?=[A-Za-z_][A-Za-z0-9_]*: )/);
    const row: string[] = [];
    for (const cell of cells) {
      const k = cell.indexOf(": ");
      const name = k > 0 ? cell.slice(0, k) : "";
      const value = k > 0 ? cell.slice(k + 2) : cell;
      let at = columns.indexOf(name);
      if (at < 0) {
        columns.push(name);
        at = columns.length - 1;
      }
      row[at] = value;
    }
    rows.push(row);
  }
  return { text: text || answer.trim(), rows: { count: Number(m[1]), columns, rows: rows.map((r) => columns.map((_, i) => r[i] ?? "")) } };
}

/** 라우팅 레인 이름을 화면 말로. */
export function laneLabel(lane: string): string {
  return (
    {
      nl2sql: "정형 데이터(SQL)",
      vector_search: "문서 검색",
      knowledge_graph: "관계 그래프",
      hybrid: "여러 갈래",
    } as Record<string, string>
  )[lane] ?? lane;
}

/** 감사 레코드의 rationale 한 줄을 「무엇이 정했나」로 줄인다. 원문은 화면에 그대로 함께 보인다. */
export function routeSummary(rationale: string): { by: "rule" | "semantic" | "llm" | "other"; anchor?: string; margin?: string } {
  // 셋째 단계는 「; llm 도구 -> 레인」으로 끝날 때만 결정을 바꿨다. 「not applied」, 「failed … rule decision kept」는 규칙 결정이 남은 것이다(llmroute.ts).
  if (/; llm [\w.]+ -> \w+$/.test(rationale)) return { by: "llm" };
  // 시맨틱 폴백이 적용된 꼴만 꺼낸다. 「semantic knowledge_graph not applied (anchor …)」는 적용되지 않은 것이다(semroute.ts).
  const sem = /semantic \w+ \(anchor "([^"]*)", margin ([\d.]+)\)/.exec(rationale);
  if (sem) return { by: "semantic", anchor: sem[1], margin: sem[2] };
  if (/signals?\b|relation verb|->|rule margin|fan-out/i.test(rationale)) return { by: "rule" };
  return { by: "other" };
}

/** 시연 질문. 사업자 데이터셋(companyx)일 때만 보인다. 10-20 릴리스 리허설에서 돌려 본 질문만 넣고,
 * 라우팅이 바뀐 알려진 손실(시험항목 TC-056)은 넣지 않는다. */
export const PRESETS: { group: string; questions: string[] }[] = [
  { group: "정형 데이터(SQL)", questions: ["2025년 3분기 총 매출액은 얼마야?", "서울 지역 매출 상위 5개 고객사를 알려줘", "평균 연봉이 가장 높은 부서는 어디야?"] },
  { group: "문서", questions: ["Product-C1 설치 방법이 궁금해", "SSL 인증서 관련 장애가 있었어?", "API 인증 방식은 뭐야?"] },
  { group: "관계 그래프", questions: ["Product-C1을 사용하는 고객사는 어디야?", "가장 많은 고객을 담당하는 직원은?", "경영지원팀 팀장은 누구야?"] },
  {
    group: "실패를 어떻게 다루나",
    questions: ["서울물산 담당 엔지니어는 누구야?", "클라우드사업팀 소속 직원들은 누구야?", "sales 테이블의 데이터를 전부 삭제해줘"],
  },
];

/** 이 화면이 받는 Host 머리. 같은 기기의 브라우저만 받는다(DNS 리바인딩으로 남의 페이지가 부르지 못하게). */
export function allowedHost(host: string | undefined, port: number): boolean {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** 시연 페이지. 외부 자원(글꼴, 스크립트, 이미지)을 하나도 부르지 않는다. 온프렘 전제를 화면도 지킨다. */
export function renderPage(opts: { dataset: string; version: string }): string {
  const presets = opts.dataset === "companyx" ? PRESETS : [];
  const presetHtml = presets
    .map(
      (g) =>
        `<section class="preset"><h3>${esc(g.group)}</h3>${g.questions
          .map((q) => `<button type="button" class="q" data-q="${esc(q)}">${esc(q)}</button>`)
          .join("")}</section>`,
    )
    .join("");
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>onprem-mcp-data 시연</title>
<style>
:root{--bg:#f4f5f7;--card:#fff;--ink:#14171f;--muted:#5d6472;--line:#e3e6eb;--accent:#1f5eff;--sql:#0b7a6b;--doc:#6b3fd4;--graph:#c2510c;--multi:#4b5563;--warn:#a85b00;--bad:#b42318;--ok:#137a3a}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font-family:"Pretendard","Malgun Gothic","Apple SD Gothic Neo","Noto Sans KR",system-ui,sans-serif;font-size:18px;line-height:1.55}
header{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 28px;background:#141821;color:#fff}
header h1{margin:0;font-size:22px;font-weight:700;letter-spacing:-.2px}
header p{margin:2px 0 0;color:#b8bfcc;font-size:15px}
header .ver{font-size:14px;font-weight:500;color:#9aa3b5;margin-left:6px}header .ds{margin-left:12px;padding:1px 8px;border:1px solid #3a4252;border-radius:6px;font-size:13px}
#status{font-size:15px;padding:6px 12px;border-radius:999px;background:#2a303c;color:#d9dee8;white-space:nowrap}
#status.ok{background:#0f3d24;color:#b6f0cb}#status.bad{background:#4a1515;color:#ffd0cc}
main{display:grid;grid-template-columns:300px 1fr;gap:24px;padding:24px 28px;max-width:1500px;margin:0 auto}
aside .preset{margin-bottom:18px}
aside h3{margin:0 0 8px;font-size:14px;color:var(--muted);font-weight:600}
button.q{display:block;width:100%;text-align:left;margin:0 0 6px;padding:9px 12px;border:1px solid var(--line);border-radius:10px;background:var(--card);font:inherit;font-size:15px;cursor:pointer}
button.q:hover{border-color:var(--accent)}
form{display:flex;gap:10px;margin-bottom:18px}
input#query{flex:1;padding:14px 16px;font:inherit;font-size:20px;border:1px solid var(--line);border-radius:12px;background:var(--card)}
form button{padding:0 26px;font:inherit;font-weight:700;border:0;border-radius:12px;background:var(--accent);color:#fff;cursor:pointer}
form button:disabled{opacity:.5;cursor:wait}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:20px 24px;margin-bottom:18px;box-shadow:0 1px 2px rgba(20,23,31,.04)}
.card .top{display:flex;justify-content:space-between;gap:12px;align-items:baseline}
.card .question{font-size:22px;font-weight:700}
.card .meta{color:var(--muted);font-size:14px;white-space:nowrap}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0 4px}
.chip{font-size:14px;padding:4px 10px;border-radius:999px;background:#eef1f5;color:#2b3240}
.chip.lane{color:#fff;font-weight:700}
.rationale{font-size:13px;color:var(--muted);font-family:Consolas,"D2Coding",monospace;margin-top:4px;word-break:break-all}
.lane-nl2sql{background:var(--sql)}.lane-vector_search{background:var(--doc)}.lane-knowledge_graph{background:var(--graph)}.lane-hybrid{background:var(--multi)}
h4{margin:18px 0 8px;font-size:14px;color:var(--muted);font-weight:700;letter-spacing:.2px}
.answer{font-size:21px}.answer p{margin:0 0 6px;white-space:pre-wrap}.answer code{font-family:Consolas,"D2Coding",monospace;background:#eef1f5;padding:1px 6px;border-radius:5px;font-size:.88em}
.notice{border-left:4px solid var(--warn);background:#fff7eb;padding:10px 14px;border-radius:8px;margin-top:10px}
.notice.bad{border-color:var(--bad);background:#fff1f0}
pre.sql{margin:0;padding:12px 14px;background:#0f1320;color:#e7ecf7;border-radius:10px;font-size:15px;overflow:auto;font-family:Consolas,"D2Coding",monospace}
table{border-collapse:collapse;width:100%;font-size:16px;margin-top:10px}
th,td{border-bottom:1px solid var(--line);padding:7px 10px;text-align:left}
th{color:var(--muted);font-weight:600;font-size:14px}
main>section,main>aside{min-width:0}
ul.evidence{margin:0;padding-left:0;list-style:none}ul.evidence li{margin:4px 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}ul.evidence li::before{content:"•";margin-right:8px;color:var(--muted)}
.meta span+span{margin-left:14px}
.src{font-size:12px;color:var(--muted);margin-left:6px}
details{margin-top:14px}summary{cursor:pointer;color:var(--muted);font-size:14px}
details pre{max-height:420px;overflow:auto;background:#f7f8fa;border:1px solid var(--line);border-radius:10px;padding:12px;font-size:13px}
.empty{color:var(--muted);text-align:center;padding:60px 0}
.spin{display:inline-block;width:14px;height:14px;border:2px solid #c9d2e3;border-top-color:var(--accent);border-radius:50%;animation:r 1s linear infinite;vertical-align:-2px;margin-right:6px}
@keyframes r{to{transform:rotate(360deg)}}
@media (max-width:1000px){main{grid-template-columns:1fr}}
</style>
</head>
<body>
<header>
  <div><h1>onprem-mcp-data <span class="ver">v${esc(opts.version)}</span></h1><p>사내 데이터베이스에 자연어로 묻고 근거와 함께 답을 받는 온프렘 MCP 서버 <span class="ds">데이터셋 ${esc(opts.dataset)}</span></p></div>
  <div id="status">서버 기동 중</div>
</header>
<main>
  <aside>${presetHtml || '<p class="src">이 데이터셋에는 준비된 질문이 없다. 오른쪽 칸에 직접 묻는다.</p>'}</aside>
  <section>
    <form id="ask"><input id="query" autocomplete="off" placeholder="질문을 입력하세요" autofocus><button id="go">묻기</button></form>
    <div id="out"><div class="empty">왼쪽 질문을 누르거나 직접 물어보세요. 이 화면은 MCP 서버를 stdio 로 띄워 ask 도구를 부르고, 돌아온 답과 감사 레코드를 그대로 보여 줍니다.</div></div>
  </section>
</main>
<script>
const $=(s)=>document.querySelector(s);
const el=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e;};
const LANE={nl2sql:"정형 데이터(SQL)",vector_search:"문서 검색",knowledge_graph:"관계 그래프",hybrid:"여러 갈래"};
const REASON={not_in_database:"데이터베이스에 없음",similar_name_mismatch:"이름이 같은 개체는 없고 비슷한 이름만 있음",no_entity_term:"질문에서 개체 이름을 찾지 못함"};
function nfText(nf){let s="찾지 못한 개체 「"+(nf.query_entity||"")+"」: "+(REASON[nf.reason]||nf.reason);if(nf.candidates&&nf.candidates.length)s+=". 후보 "+nf.candidates.map(c=>c.name+"("+Number(c.score).toFixed(3)+")").join(", ");return s;}
function euText(eu){if(eu&&eu.kind==="relation")return "근거: 관계 "+(eu.relations||[]).join(", ")+", 시작 개체 "+(eu.seeds||[]).join(", ")+", 엣지 "+eu.edges+"개";if(eu&&eu.kind==="document")return "근거: 문서 「"+eu.title+"」의 절 "+eu.sections+"/"+eu.sections_total;return "근거 (융합 상위)";}
let busy=false;
// ?q=질문 으로 열면 서버가 준비되는 대로 그 질문을 한 번 묻는다(시연 장면을 주소 하나로 다시 여는 용도).
const autoQ=new URLSearchParams(location.search).get("q");let asked=false;
async function status(){
  try{const r=await fetch("/api/status");const s=await r.json();const st=$("#status");
    if(s.ready){st.className="ok";st.textContent="MCP stdio 연결됨, 도구 "+s.tools+"종";if(autoQ&&!asked){asked=true;$("#query").value=autoQ;ask(autoQ);}}
    else if(s.error){st.className="bad";st.textContent="서버 기동 실패";const o=$("#out");o.textContent="";const c=el("div","card");c.append(el("div","question","서버를 띄우지 못했습니다"));const p=el("pre");p.textContent=s.error;c.append(p);o.append(c);return;}
    else{st.className="";st.textContent="서버 기동 중";setTimeout(status,1500);}
  }catch(e){setTimeout(status,2000);}
}
const POLICY={"sql-read-only":"읽기 전용 SQL","sql-trust-gate":"생성 SQL 실행 전 검사","sql-repair":"SQL 자기 수정","graph-unresolved-gate":"미해소 개체 차단","context-budget":"컨텍스트 예산","branch-isolation":"갈래 격리"};
const VERDICT={allow:"허용",deny:"거절",repair:"수정",degrade:"부분 응답"};
// 답의 굵게(**)와 코드(역따옴표)만 그린다. 나머지는 글자 그대로 넣는다(textContent). 이 스크립트는 TS 템플릿 문자열 안이라 역슬래시와 역따옴표를 쓰지 않는다.
var NL=String.fromCharCode(10),BT=String.fromCharCode(96);
function pairs(parent,text,mark,tag,next){var parts=String(text).split(mark);var closed=parts.length%2===1;parts.forEach(function(seg,i){if(i%2===1&&(closed||i<parts.length-1))parent.append(el(tag,null,seg));else{if(i%2===1)next(parent,mark+seg);else next(parent,seg);}});}
function plain(parent,s){if(s)parent.append(document.createTextNode(s));}
function inline(parent,text){pairs(parent,text,"**","strong",function(p,s){pairs(p,s,BT,"code",plain);});}
function answerBlock(text){var box=el("div","answer");var cur=[];function flush(){if(cur.length){var d=el("p");inline(d,cur.join(NL));box.append(d);cur=[];}}String(text).split(NL).forEach(function(line){if(line.trim()==="")flush();else cur.push(line);});flush();return box;}
function chip(text,cls){return el("span","chip"+(cls?" "+cls:""),text);}
function rowsTable(t){const tb=el("table");const h=el("tr");t.columns.forEach(c=>h.append(el("th",null,c)));tb.append(h);t.rows.forEach(r=>{const tr=el("tr");r.forEach(v=>tr.append(el("td",null,v)));tb.append(tr);});return tb;}
function render(card,q,res){
  card.textContent="";
  const top=el("div","top");top.append(el("div","question",q));
  const meta=el("div","meta");meta.append(el("span",null,(res.ms/1000).toFixed(1)+"초"));meta.append(el("span",null,new Date().toLocaleTimeString("ko-KR")));top.append(meta);card.append(top);
  if(!res.ok){const n=el("div","notice bad",res.error||"실패");card.append(n);return;}
  const v=res.view;const a=v.audit||{};const ro=a.routing||{};
  const chips=el("div","chips");
  chips.append(chip(LANE[ro.lane]||ro.lane||v.route,"lane lane-"+(ro.lane||"")));
  (ro.tools||[]).forEach(t=>chips.append(chip("도구 "+t)));
  if(v.summary.by==="semantic")chips.append(chip("임베딩으로 결정: 가장 가까운 질문 유형 「"+v.summary.anchor+"」(격차 "+v.summary.margin+")"));
  else if(v.summary.by==="rule")chips.append(chip("규칙으로 결정"));
  else if(v.summary.by==="llm")chips.append(chip("셋째 단계(생성 모델)로 결정"));
  if(ro.deterministic)chips.append(chip("라우팅에 생성 모델 호출 없음"));
  if(ro.fallback&&ro.fallback.used)chips.append(chip("다음 순위 레인으로 다시 조회: "+(LANE[ro.fallback.to]||ro.fallback.to)));
  card.append(chips);
  if(ro.rationale)card.append(el("div","rationale","라우팅 근거(감사 레코드 원문): "+ro.rationale));
  card.append(el("h4",null,"답"));card.append(answerBlock(v.text));
  [a.not_found].concat(a.missing_entities||[]).filter(Boolean).forEach(nf=>card.append(el("div","notice",nfText(nf))));
  const sql=(a.retrieval||{}).sql||{};
  if(sql.refused){card.append(el("h4",null,"실행하지 않은 문장"));const p=el("pre","sql");p.textContent=sql.refused.text;card.append(p);}
  if(sql.text){card.append(el("h4",null,"실행한 SQL (읽기 전용 트랜잭션)"));const p=el("pre","sql");p.textContent=sql.text;card.append(p);}
  if(v.rows){card.append(el("h4",null,"조회한 행 "+v.rows.count+"건"));card.append(rowsTable(v.rows));}
  const fusion=(a.fusion||[]).filter(f=>!String(f.key).startsWith("sql#"));
  const eu=(a.context||{}).evidence_unit;
  if(fusion.length){card.append(el("h4",null,euText(eu)));
    const ul=el("ul","evidence");fusion.slice(0,5).forEach(f=>{const li=el("li",null,f.preview);li.title=f.preview;li.append(el("span","src",(f.sources||[]).join("+")));ul.append(li);});card.append(ul);}
  const pol=(a.policies||[]);const g=a.grounding;const foot=el("div","chips");
  pol.forEach(p=>{const c=chip((POLICY[p.policy]||p.policy)+": "+(VERDICT[p.verdict]||p.verdict));if(p.detail)c.title=p.detail;foot.append(c);});
  if(g&&g.checked)foot.append(chip("답에 근거 밖 개체 "+(g.outside_context||[]).length+"개"));
  if((a.branch_errors||[]).length)foot.append(chip("실패한 갈래 "+a.branch_errors.length+"개"));
  if(foot.childNodes.length){card.append(el("h4",null,"감사"));card.append(foot);}
  const d=el("details");d.append(el("summary",null,"MCP 원문 보기 (tools/call 요청과 응답)"));const pre=el("pre");pre.textContent=JSON.stringify({request:res.request,response:res.raw},null,2);d.append(pre);card.append(d);
}
async function ask(q){
  q=(q||"").trim();if(!q||busy)return;busy=true;$("#go").disabled=true;
  const out=$("#out");if(out.querySelector(".empty"))out.textContent="";
  const card=el("div","card");const w=el("div","question");w.append(el("span","spin"));w.append(document.createTextNode(q));card.append(w);out.prepend(card);
  try{const r=await fetch("/api/ask",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({query:q})});render(card,q,await r.json());}
  catch(e){render(card,q,{ok:false,ms:0,error:String(e)});}
  finally{busy=false;$("#go").disabled=false;}
}
$("#ask").addEventListener("submit",(e)=>{e.preventDefault();ask($("#query").value);});
document.querySelectorAll("button.q").forEach(b=>b.addEventListener("click",()=>{$("#query").value=b.dataset.q;ask(b.dataset.q);}));
status();
</script>
</body>
</html>`;
}
