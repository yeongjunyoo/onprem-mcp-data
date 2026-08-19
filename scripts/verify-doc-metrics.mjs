// 판정 문서 전체에서 "지표를 말하는 자리인데 정본 값이 없는" 곳을 찾는다.
//
// `metrics-check.mjs` 는 marker 가 달린 행만 본다. 그래서 marker 없는 표 행이나
// 산문에 낡은 값이 남으면 못 잡는다 — 이번에 실제로 그렇게 313단언, 18472ms,
// 접지 17/17 이 살아남아 있었다.
//
// 이 검사는 반대로 접근한다. **지표 이름과 값이 같은 줄에 있는데 그 값이 정본과
// 다르면** 후보로 올린다. marker 를 붙일 필요가 없어 문서 전역에 적용된다.
//
// ★ 형태가 아니라 문맥으로 본다.
//   값의 모양만 보면 오탐투성이다 — BIRD 0.281, "개선 전 0.278", "해시 폴백 0.775"
//   는 전부 정당한 값인데 0.9xx 형태 검사에 걸린다. 그래서 **그 줄이 어느 지표를
//   말하는지**를 먼저 보고, 그 지표의 정본이 그 줄에 없을 때만 잡는다.
//
// ★ 선언된 한계
//   과거 측정을 서술하는 줄은 정당하게 옛 값을 담는다. `<!--metric-ok-->` 로
//   면제하되, 침묵이 아니라 시점을 밝히는 문장과 함께 쓴다.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** 저장소에 **추적되는** md 만 본다.
 *
 * 파일시스템을 훑으면 로컬은 63개, 갓 클론한 CI 는 22개를 본다 — **같은 검사가
 * 환경마다 다른 범위를 본다.** 2026-08-18 에 `air-server/README.md`(prepack 이
 * 루트 README 를 복사해 만드는 빌드 산출물, .gitignore 에 있다)를 실물 문서로
 * 착각한 것이 그 탓이다.
 *
 * 기여자의 로컬 메모가 검사를 빨갛게 만들면 사람은 검사를 끈다.
 * **저장소에 있는 것이 곧 심사 대상이다.**
 */
function trackedMarkdown(root) {
  return execFileSync("git", ["ls-files", "*.md"], { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
}

const DOCS = trackedMarkdown(ROOT).filter((f) => f !== "CHANGELOG.md");

// 정본은 metrics-check 가 이미 계산한다. 두 곳에서 따로 읽으면 갈린다.
const out = execFileSync(process.execPath, [resolve(ROOT, "scripts/metrics-check.mjs")], {
  cwd: ROOT,
  encoding: "utf8",
});
const canonical = {};
for (const m of out.matchAll(/^\s+([a-z_0-9]+) = (.+)$/gm)) canonical[m[1]] = m[2].trim();

/** 지표를 말하는 자리인지 알아보는 패턴과, 그 자리에 있어야 할 정본. */
const SUBJECTS = [
  // naive(테이블명만) 베이스라인. 2026-08-19: 정본에 없어서 모델 교체 때 6자리가
  // 통째로 낡았다. **등록과 소비는 다르다** - canonical 에 넣고 여기도 넣는다.
  // 주제어를 **둘 다** 요구한다. 「테이블명만」만 보면 **재시도 행**까지 물어
  // 무재시도 값을 내놓으라고 한다 - 첫 판에 거짓 유죄 5건이 났다.
  // **넓은 측정은 거짓 유죄를 만든다.**
  { re: /(?=.*(?:테이블명만|without the schema card|스키마 카드 제거))(?=.*(?:재시도 없|무재시도|no retry|without retry)).*/i,
    key: "nl2sql_naive_norepair", val: /\b\d{1,2}\/10\b/g, window: 70 },
  // 커버율. 2026-08-18 리뷰: canonical 에 넣기만 하고 아무도 안 봤다 -
  // **등록과 소비는 다르다**(PR #195 와 같은 지적).
  //
  // 1차·2차가 다른 줄이고 값 모양이 겹치므로 **주제어에 차수를 함께 요구**한다.
  // 한 줄에 「홀드아웃1」과 「커버율」이 같이 있어야 그 줄의 커버율이 1차 것이다.
  {
    re: /(?:홀드아웃\s*1|holdout\s*1|템플릿 문형)[^\n]*(?:커버율|coverage)/i,
    key: "holdout1_coverage",
    val: /\b\d\.\d{3}\b/g,
    window: 60,
  },
  {
    re: /(?:홀드아웃\s*2|holdout\s*2|구어체)[^\n]*(?:커버율|coverage)/i,
    key: "holdout2_coverage",
    val: /\b0\.\d{3}\b/g,
    window: 60,
  },
  // 외부 BIRD. 2026-08-18 완결 감사에서 정본에 없다는 걸 알았고 metrics-check 에
  // 넣었다. **등록과 소비는 다르다**(PR #195) - 여기 없으면 문서는 계속 자유롭다.
  //
  // 한 줄에 0.344(공식 set)와 0.312(운영 multiset)가 같이 나온다. 그게 논지라
  // 갈라 봐야 한다 - 위 multi-hit 창 규칙이 「주제 바로 뒤의 값」을 본다.
  // 창을 넓게 잡는다: `공식 set 동등 0.344와 이 저장소의 운영 multiset 동등 0.312`
  { re: /공식 set 동등|official set/i, key: "bird_official", val: /0\.\d{3}/g, window: 45 },
  { re: /운영 multiset 동등|operational multiset/i, key: "bird_multiset", val: /0\.\d{3}/g, window: 45 },
  { re: /execution accuracy|실행 정확도/i, key: "bird_exec_pct", val: /\d{1,2}\.\d/g, window: 40 },
  // `hit@5` 를 생략한 짧은 표기("벡터 0.985")도 본다. 2026-08-18 실측에서 그 표기가
  // 규칙 밖이라 낡은 채로 남아 있었다 — **같은 사실을 짧게 쓰면 검사가 못 본다.**
  // 오늘 도구 수(숫자 선행)·단언 수(중간에 단어)에서도 같은 형태를 겪었다.
  { re: /벡터.{0,12}hit@5|vector hit@5|벡터\s*0\.\d{3}/i, key: "vector_hit5", val: /\b0\.\d{3}\b/g },
  // 지연 산문. 2026-08-18 에 **두 번째로** 낡은 것이 나왔다 — 본문 3쪽을 고쳤을 때
  // check_report_metrics.py 에 넣었지만 그 검사는 제출 원고만 본다. 저장소 문서
  // (특히 영준이 보고 녹화하는 시연 대본)는 여전히 밖이었다.
  //
  // **같은 사실이 여러 문서에 흩어져 있으면 검사도 흩어져야 한다.**
  { re: /컨테이너는 중앙값|종단 중앙 지연|ask median/i, key: "ask_median_ms", val: /\b\d{4,5}(?=\s*ms)/g },
  { re: /호스트 Ollama는 중앙값|호스트 GPU/i, key: "ask_median_ms_host", val: /\b\d{3,4}(?=\s*ms)/g },
  // 내부 벤치의 **괄호 표기**만 본다. 2026-08-18 에 83 → 81 로 내렸는데 보고서 서두
  // 「핵심 한 줄」의 `품질(83%)` 이 살아남았다 — 그 표기가 규칙 밖이었다.
  //
  // 처음엔 주제어를 `내부 SQL execution-match` 까지 넓혔다가 `81/100=81.0%` 줄을
  // 세 개 오탐했다(값 추출기가 `%` 앞 숫자를 못 봄). **오탐 있는 검사는 꺼진다** —
  // `81/100` 형태는 기존 규칙이 이미 보므로 여기서는 괄호 하나만 맡는다.
  { re: /품질\(\d{1,3}%\)/, key: "bench_internal_pct", val: /(?<=품질\()\d{1,3}(?=%\))/g },
  // 산문·불릿의 `execution-match: 81/100` 자리. metrics-check 의 CLAIMS 는 **표 행만**
  // 보므로 불릿은 아무도 안 봤다 — 2026-08-18 위조 시험에서 통과했다.
  { re: /execution-match/i, key: "bench_internal", val: /\b\d{1,3}\/100\b/g },
  // 같은 줄의 **퍼센트 표기**도 본다. 2026-08-18 리뷰: 분수만 잡으면
  // `81/100 = 83.0%` 처럼 **분수는 맞고 퍼센트만 틀린` 자리가 통과한다.
  // 분수를 먼저 지우고 퍼센트만 본다. 2026-08-18 위조 시험: `81/100 = 83.0%` 에서
  // 값 집합에 81 이 들어 있어 **정본이 그 줄에 있다** 는 이유로 통과했다 —
  // 분수는 맞고 퍼센트만 틀린 자리를 놓친다.
  { re: /execution-match/i, key: "bench_internal_pct", val: /(?<![\d.])(\d{1,3})(?=\s*(?:\.\d+)?\s*%)/g, strip: /\d{1,3}\/100/g , window: 60 },
  // 창 30 → 60. 커버율 주제어가 붙으며 이 줄이 **다중 주제**가 되어 창 경로를 타자
  // 빈 창 탐지가 물었다 - README.en.md:94 는 주제(holdout 1)와 값(0.900) 사이가
  // 40자 가까이 떨어져 있다. **탐지기가 자기 몫을 했다.**
  { re: /홀드아웃1|holdout 1|템플릿 문형/i, key: "holdout1_strict", val: /\b0\.\d{3}\b/g, window: 60 },
  { re: /홀드아웃2|holdout 2|구어체|colloquial/i, key: "holdout2_strict", val: /\b0\.\d{3}\b/g, window: 60 },
  { re: /라우팅 도구 일치|routing tool match/i, key: "route_insample", val: /\b\d{1,2}\/30\b/g },
  { re: /단언 통과|assertions pass/i, key: "test_total", val: /(?<!\d)\d{3}(?!\d)/g },
  // 분모를 /19 로 못 박으면 **분모까지 바꾼 위조가 건너뛰어진다** — 값이 하나도
  // 안 잡히면 검사는 그 줄을 넘긴다. 어떤 비율이든 잡아서 정본과 대조한다.
  { re: /근거 포함|evidence in context/i, key: "ask_evidence", val: /\b\d{1,2}\/\d{1,2}\b/g },
  { re: /KG 재현율|지식그래프 검색 재현율|knowledge-graph recall/i, key: "kg_recall", val: /\b\d\.\d{3}\b/g },
];

// 분수와 그 퍼센트가 한 자리에 같이 적히면 **사본이 둘**이다.
//
// 2026-08-18. 위조 시험에서 `81/100=**81.0%**` 를 `81/100=**81.77%**` 로 바꿨는데
// 아래 SUBJECTS 대조가 통과했다 - 줄에 `81` 이 남아 있어서다.
// **정본 대조는 분자를 보고 파생 퍼센트는 안 본다.**
//
// 이 검사는 정본이 필요 없다. 81/100 은 81.0% 여야 한다 - 무엇이 정본이든.
// 그래서 새 지표가 생겨도 자동으로 덮인다.
//
// 처음엔 따로 루프를 돌렸다가 리뷰가 짚었다 - 그 루프엔 파일 존재 검사도 펜스
// 건너뛰기도 없었다. **같은 파일 안에 규칙이 다른 루프를 하나 더 만든 것**이라
// 아래 루프 안으로 접었다. 사본은 코드에서도 갈린다.
const FRAC = /(\d{1,4})\s*\/\s*(\d{1,4})\s*\**\s*=\s*\**\s*(\d{1,3}(?:\.\d+)?)\s*%/g;
let derived = 0;

const fails = [];
let scanned = 0;

for (const doc of DOCS) {
  if (!existsSync(resolve(ROOT, doc))) continue;
  let fenced = false;
  const lines = readFileSync(resolve(ROOT, doc), "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced || line.includes("<!--metric-ok-->")) continue;
    // 산문은 문단으로 쓰이는데 검사는 줄에서 끊는다. 2026-08-18: BIRD 세 자리가
    // 전부 **값이 다음 줄에** 있어 걸렸다. 기존 45자리가 통과한 건 마침 같은 줄에
    // 있어서다 - 운이었다.
    //
    // 한 줄만 잇는다. 빈 줄·펜스 경계에서 끊는다.
    // 넓은 측정은 거짓 유죄를 만들고 **넓은 창은 거짓 무죄를 만든다.**
    const nxt = lines[i + 1];
    const ctx =
      nxt !== undefined && nxt.trim() !== "" && !/^\s*```/.test(nxt) &&
      !nxt.includes("<!--metric-ok-->")
        ? `${line} ${nxt}`
        : line;
    for (const m of line.matchAll(FRAC)) {
      const [num, den] = [Number(m[1]), Number(m[2])];
      if (den === 0) continue;
      derived++;
      // 반올림 자릿수를 문서 표기에 맞춘다 - 89.5 를 90 이라 쓰면 다른 주장이다.
      const dec = m[3].includes(".") ? m[3].split(".")[1].length : 0;
      const real = Number(((num / den) * 100).toFixed(dec));
      if (real !== Number(m[3])) {
        fails.push(
          `${doc}:${i + 1} - ${m[0].trim()} 는 산술이 안 맞는다 (실제 ${real}%)\n` +
            `    ${line.trim().slice(0, 100)}`,
        );
      }
    }
    // 한 줄이 여러 주제에 걸리면 **주제 바로 뒤의 수**만 그 주제 것으로 본다.
    // 2026-08-18 에 반대쪽으로 두 번 틀린 뒤에 얻은 규칙이다.
    //
    //   "걸린 주제마다 자기 정본이 줄 어딘가에" → 1차·2차를 같이 말하며 2차 값만
    //   인용한 옳은 문장을 물었다(roadmap:22).
    //
    //   "줄의 모든 값이 누군가의 정본" → 같은 줄의 **커버율 0.933** 을 물었다
    //   (README:185). 추적 대상이 아닌 지표가 같은 줄에 있는 건 정상이다.
    //
    // 둘 다 "어느 수가 어느 주제 것인가" 를 안 보고 뭉뚱그린 탓이다. 사람은 위치로
    // 안다 — "홀드아웃1(템플릿 문형)에서 27/30(0.900)".
    const hit = SUBJECTS.filter((s) => s.re.test(line) && canonical[s.key]);
    if (hit.length > 1) {
      for (const s of hit) {
        // 주제가 한 줄에 여러 번 나오면 **자리마다** 본다. 2026-08-18:
        // roadmap:22 는 `2차(구어체)` 와 `구어체 strict 0.633` 두 곳에 주제가
        // 있는데 첫 자리만 봐서 값이 창 밖이었다.
        //
        // 창을 넓히는 건 나쁜 처방이다 - 남의 값이 들어와 거짓 무죄가 난다.
        // 사람은 창을 넓혀 읽지 않고 **주제가 나오는 자리마다** 근처를 본다.
        const reAll = new RegExp(
          s.re.source,
          s.re.flags.includes("g") ? s.re.flags : `${s.re.flags}g`,
        );
        const ats = [...ctx.matchAll(reAll)].map((m) => m.index);
        const at = ats.length ? ats[0] : line.search(s.re);
        // 창은 **양방향**이다. 한국어는 값이 주제 앞에 오기도 한다 —
        // "0.900은 템플릿 문형, 0.633이 구어체다"(report.md:362). 뒤만 보면
        // 0.900 을 놓치고 0.633 을 홀드아웃1 것으로 오독한다.
        // 창 폭은 규칙이 정할 수 있다. 2026-08-18: execution-match 자리는
        // `execution-match: 81/100 = 83.0%` 라 ±30자로는 **% 가 창 밖**이라
        // 값이 0개가 되고 건너뛰어졌다 — 넓히지 않으면 그 규칙은 없는 것과 같다.
        const w = s.window ?? 30;
        let near = (ats.length ? ats : [at])
          .map((a) => ctx.slice(Math.max(0, a - w), a + w))
          .join(" \u0001 ");
        // 규칙이 strip 을 주면 그 패턴을 먼저 지운다. 2026-08-18 위조 시험:
        // `81/100 = 83.0%` 에서 분수 안의 81 이 값 집합에 들어가 **퍼센트만 틀린 자리**가
        // 통과했다. 분수를 지우면 퍼센트만 남는다.
        if (s.strip) near = near.replace(s.strip, " ");
        const vals = [...near.matchAll(s.val)].map((m) => m[0]);
        if (vals.length === 0) {
          // 창엔 없는데 **줄에는 그 모양의 값이 있다**면 「값이 없다」가 아니라
          // **「창이 잘못됐다」**이다. 2026-08-18: bird_official 창 20 이
          // `0.344` 를 반토막 내 위조가 통과했다 - PR #205 와 같은 함정을
          // 다른 파일에서 다시 팠다.
          //
          // 창이 **완전히 빈 경우에만** 본다. 다중 주제 줄에서 남의 값이 창 밖에
          // 있는 건 정상이라(473행: 공식 0.344 · 운영 0.312) 그때는 자기 값이
          // 창 안에 있어 여기 안 온다.
          // 전역 정규식의 test() 는 lastIndex 를 전진시켜 **뒤의 matchAll 을
          // 오염**시킨다. 실제로 그 탓에 빈 창 실패 5건이 헛으로 떴다.
          // 상태 없는 사본으로 본다.
          // 신호는 「값 모양」이 아니라 **정본 값 그 자체**여야 한다.
          // 모양으로 보면 roadmap:22 처럼 1차·2차를 같이 말하며 2차 값만 인용한
          // **옳은 문장**을 문다 - 기존 주석이 이미 지목한 줄인데 같은 방식으로
          // 두 번 걸렸다.
          //
          // 정본 값이 줄에 있는데 창이 못 닿았다면 그건 설정 오류가 **확실**하다.
          // 다른 지표의 값은 정본이 다르니 안 걸린다.
          // 단 `strip` 이 있는 규칙은 **일부러 값을 걷어낸다**(예: bench_internal_pct 가
          // 88/100 을 지우고 퍼센트만 찾는다). 그 줄이 분수만 인용하면 빈 결과가
          // **정상**이지 사각이 아니다. 2026-08-19 에 README 약점 공개 줄에서 헛 실패가 났다.
          const strippedAway = s.strip && new RegExp(s.strip.source, s.strip.flags).test(line);
          if (!strippedAway && line.includes(canonical[s.key])) {
            fails.push(
              `${doc}:${i + 1} - ${s.key} 의 창(${w}자)에 값이 하나도 안 잡혔는데 ` +
                `줄에는 그 모양의 값이 있다. **창이 좁아 조용히 건너뛰는 중이다** - ` +
                `window 를 넓힌다.\n    ${line.trim().slice(0, 100)}`,
            );
          }
          continue; // 멀리 있는 값은 남의 것이다
        }
        scanned++;
        if (!vals.includes(canonical[s.key])) {
          fails.push(
            `${doc}:${i + 1} — ${s.key} 바로 뒤의 값이 정본 ${canonical[s.key]} 이 아니다 ` +
              `(문서: ${vals.join(", ")})\n    ${line.trim().slice(0, 100)}`,
          );
        }
      }
      continue;
    }

    for (const s of SUBJECTS) {
      if (!s.re.test(line)) continue;
      const want = canonical[s.key];
      if (!want) continue;
      const vals = [...ctx.matchAll(s.val)].map((m) => m[0]);
      if (vals.length === 0) continue;
      scanned++;
      if (!vals.includes(want)) {
        fails.push(
          `${doc}:${i + 1} — ${s.key} 를 말하는 자리인데 정본 ${want} 이 없다 (문서: ${vals.join(", ")})\n` +
            `    ${line.trim().slice(0, 100)}`,
        );
      }
    }
  }
}

// 면제는 그 줄의 검사를 **영구히 끄는** 행위인데 붙이는 비용이 0이다.
// 위 오류 문구가 「시점을 밝히는 문장과 함께」라고 규약을 말하지만
// **그 규약을 집행하는 코드가 없었다.**
//
// 날짜를 강제하지는 않는다 - ablation 표 행(무조건 융합/규칙 게이트 융합)은
// 회고가 아니라 **대안 구성**이라 날짜가 없는 게 맞다. 강제하면 거짓 유죄가 난다.
//
// 대신 개수를 못 박는다. 다르면 실패하고 숫자를 고치게 한다 -
// 의도를 판정하지 않고 **면제를 붙이는 일을 눈에 보이는 행위로** 만든다.
// 11 (2026-08-19): 로드맵 5번의 **동기 문단**을 면제했다. 그 문단은 「32문항으로는
// 가를 수 없다」는 항목 신설 이유의 기록이고, 거기에 전수 값(0.486)을 끼우면
// 32문항 이야기에 500문항 값을 섞는 자기 모순이 된다.
// 13 (2026-08-19): 호스트 GPU 지연을 Coder 로 재측정해 864 → 947ms 가 됐다.
// README 한/영 각 한 줄이 **일부러** 옛 값을 역사로 적는다 - 그 문장이 없으면
// 심사자가 947 만 보고 「같은 모델이 느려졌다」로 읽는다. 두 줄을 면제한다.
const EXEMPTION_BUDGET = 13;
{
  const at = [];
  for (const doc of DOCS) {
    if (!existsSync(resolve(ROOT, doc))) continue;
    const ls = readFileSync(resolve(ROOT, doc), "utf8").split("\n");
    for (let i = 0; i < ls.length; i++) {
      if (ls[i].includes("<!--metric-ok-->")) at.push(`${doc}:${i + 1}`);
    }
  }
  if (at.length !== EXEMPTION_BUDGET) {
    fails.push(
      `면제 예산: <!--metric-ok--> 가 ${at.length}건인데 예산은 ${EXEMPTION_BUDGET} 건이다.\n` +
        `    ${at.join(", ")}\n` +
        `    늘렸다면 왜 그 줄이 정본과 다를 수밖에 없는지 커밋 메시지에 적고 ` +
        `EXEMPTION_BUDGET 을 함께 고친다. 줄었다면 숫자만 내린다.`,
    );
  }
}

console.log(`지표를 말하는 자리 ${scanned}곳을 정본과 대조했다 (문서 ${DOCS.length}개).`);
console.log(`분수=퍼센트 표기 ${derived}건의 산술도 봤다.`);

if (fails.length) {
  console.error("\n정본과 어긋나는 자리:");
  for (const f of fails) console.error(`  - ${f}`);
  console.error(
    "\n과거 측정을 일부러 서술한 자리라면 시점을 밝히는 문장과 함께 <!--metric-ok--> 로 면제한다.\n",
  );
  process.exit(1);
}

console.log("OK: 지표를 말하는 모든 자리가 정본과 일치한다.");
console.log("    (marker 없는 표 행과 산문까지 본다 — metrics-check 의 사각을 덮는다.)");
