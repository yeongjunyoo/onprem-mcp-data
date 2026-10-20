# Builds eval/results/answer-diagnosis-2026-10-11.json from the 10-11 scorecard files (the misses of record),
# the stage traces and oracle runs (eval/diag/answer-stages.mjs output in .scratch/diag), and the analyst labels
# below. Labels assign each miss to the earliest stage whose failure explains it (a route that still ran the expected
# lane and did not change the answer is not counted as the cause). No document text is written.
#
# Run from the repo root: python -I eval/diag/build-diagnosis.py <doctype-results-dir>
import json, sys, os, re
from datetime import datetime, timezone
from collections import Counter, defaultdict

REF_DIR = sys.argv[1] if len(sys.argv) > 1 else 'C:/Users/basqu/Projects/onprem-wt-doctype/eval/results'
SCR = '.scratch/diag'
OUT = 'eval/results/answer-diagnosis-2026-10-11.json'

# stage: route | nl2sql | retrieval | curation | answer | scoring
# analyst: True = the answer conveys the asked DB values correctly and completely (human read against the gold
#          basis and the dataset), False = it does not. scoring rows are analyst True by definition.
L = {
 # sponsor30
 's30-06': ('nl2sql', 'interpretation: 「진행 중인」 read as status=in_progress; gold counts all projects (wording is ambiguous)', False),
 's30-13': ('retrieval', 'doc: the only Kubernetes incident report (DOC-007) is not in the top 5, also not when search is limited to incident reports; scorer gold is the whole type, so the 7B abstains on chunks that never mention Kubernetes', False),
 's30-15': ('answer', 'vague: meeting-note chunks about the security check are in context, the answer names no concrete fact', False),
 # holdout3 nl2sql
 'h3-03': ('scoring', 'gold over-asks: gold projects both monthly prices and the difference; the question asks only how much more (220, right)', True),
 'h3-09': ('answer', 'SQL rows right (execution match); prose reports one of two tickets and leaves the other ticket’s NULL resolved_at unexplained (unscorable: NULL in gold)', False),
 'h3-10': ('nl2sql', 'wrong filter column (resolved_at year instead of created_at) and hours as a number instead of an interval', False),
 'h3-13': ('nl2sql', 'unstable: 10-11 run generated a join on a missing column (projects.product_id) that the gate refused; both reruns today generated a correct query', False),
 'h3-19': ('nl2sql', 'no upper bound on 2025 (2026 contracts counted) and the zero-count type dropped by GROUP BY', False),
 'h3-20': ('nl2sql', 'grouped by quarter; the half-year gate then forced half-year grouping although the question asks the best month inside H1', False),
 # holdout3 vector (unscorable: no gold keywords) — analyst read against the basis field
 'h3-21': ('retrieval', 'chunk: the install procedure is four tiny step chunks; steps 2 (.env) and 4 (health check) not retrieved; still wrong with gold-doc oracle', False),
 'h3-22': ('retrieval', 'chunk: same four-step layout; steps 2 and 4 not retrieved, answer lists steps 1 and 3 only', False),
 'h3-23': (None, 'right', True), 'h3-24': (None, 'right', True), 'h3-25': (None, 'right', True), 'h3-26': (None, 'right', True),
 'h3-27': (None, 'right value (코어 수 × 4) but opens with 「네」 to 「코어 수 그대로 맞아?」', True),
 'h3-28': (None, 'right', True), 'h3-29': (None, 'right', True),
 'h3-30': ('retrieval', 'chunk: the 원인 분석 chunk of the right document is not in the top 5 (other chunks of it are); the 7B abstains; gold-doc oracle fixes it', False),
 'h3-31': (None, 'right', True), 'h3-32': (None, 'right', True), 'h3-33': (None, 'right', True), 'h3-34': (None, 'right', True),
 'h3-35': ('route', 'routed structured; SQL returns NULL, NULL-row answer; oracle route answers 46%', False),
 'h3-36': (None, 'right', True), 'h3-37': (None, 'right', True), 'h3-38': (None, 'right', True), 'h3-39': (None, 'right', True), 'h3-40': (None, 'right', True),
 # holdout3 graph
 'h3-55': ('retrieval', 'edges: the REPORTED_ISSUE edge to Product-S2 is not retrieved; the 7B names Client-G’s USES product instead', False),
 'h3-59': ('answer', 'both projects in context; the 7B reads 「K8s 말고도」 as an exclusion and drops the K8s project', False),
 'h3-60': ('retrieval', 'edges: LEADS edges of the two projects not retrieved; abstains (unscorable: project-person pairs); gold-edge oracle gives the right pairs', False),
 # holdout4 nl2sql
 'h4-01': ('route', 'routed graph: 「부서마다」 taken as an entity name, not-found answer; oracle route is right', False),
 'h4-02': ('scoring', 'gold over-asks: hire_date is the requested sort order, not a requested value; 15 names in the right order', True),
 'h4-06': ('scoring', 'gold echoes the question: 부산 and IT/SW are required although the question states them; Client-C is right (route hybrid, SQL lane ran)', True),
 'h4-07': ('scoring', 'gold over-asks: version, release_date and status required; the question asks whether beta products remain (both named)', True),
 'h4-10': ('scoring', 'gold over-asks: product name required; the question asks the client and the amount (both right)', True),
 'h4-13': ('scoring', 'MAX-subquery gold keeps the sort-key sum; the scorer drops it only for LIMIT golds; category right', True),
 'h4-15': ('nl2sql', '「지난주」 (the meeting) applied to sale_date: 0 rows; behind it, curation keeps 13 of 36 rows even with the gold SQL', False),
 'h4-17': ('route', 'routed semantic: no SQL lane; oracle route is right', False),
 'h4-18': ('nl2sql', 'interpretation: status=resolved instead of resolved_at IS NOT NULL (closed tickets also carry resolved_at); gold is defensible', False),
 # holdout4 vector
 'h4-21': ('scoring', 'keyword not asked: incident date-time required; the first action (SSL 인증서 갱신) is right', True),
 'h4-23': ('scoring', 'keyword fragment: 40분 right, 「초기 대응: 40분」 not verbatim', True),
 'h4-24': ('scoring', 'keyword fragment: 22분 and Critical right', True),
 'h4-25': ('scoring', 'keyword not asked: 서킷브레이커 패턴 right; the full sentence and the incident date-time required', True),
 'h4-26': ('answer', 'two of three 8-hour incidents named; the third (DOC-010) chunk is in context (unscorable: three gold documents)', False),
 'h4-27': ('scoring', 'keyword not asked: 78% right; HPA required', True),
 'h4-28': ('scoring', 'keyword fragment: 71일 right; 「ELK 스택」 required though the question already says ELK', True),
 'h4-29': ('scoring', 'keyword not asked: 222초 right; Redis required', True),
 'h4-30': ('scoring', 'keyword fragment: 263회 and 2130회 right', True),
 'h4-31': ('scoring', 'keyword fragment: 167GB SSD right', True),
 'h4-32': ('route', 'routed structured; the gate refuses the SQL; oracle route answers 49% (right)', False),
 'h4-33': ('scoring', 'keyword fragment: 10일 right', True),
 'h4-34': ('scoring', 'keyword fragment: 80% right', True),
 'h4-35': ('scoring', 'keyword fragment: 8명 and 1명 right', True),
 'h4-37': ('scoring', 'keyword fragment: 4098만원 right', True),
 'h4-38': ('scoring', 'keyword fragment: 68% right', True),
 'h4-39': ('answer', 'wrong value: 28% (another proposal’s figure) while the chunk with 40% is in context; gold-doc oracle answers 40%', False),
 'h4-40': ('route', 'routed structured; 0 rows; oracle route answers 500만원 (right)', False),
 # holdout4 graph
 'h4-43': ('retrieval', 'edges: 1 of 10 BELONGS_TO edges retrieved; gold-edge oracle lists all 10', False),
 'h4-46': ('answer', 'the MANAGES_ACCOUNT edge (안소연) is in context; the 7B abstains (「연락할 사람」 not tied to account manager); also with gold edges', False),
 'h4-59': ('scoring', 'gold error: edges.json has 13 REPORTED_ISSUE sources into Product-T2, the gold lists 10; the answer names all 13', True),
 'h4-60': ('answer', 'both edges in context with two other lines; the 7B abstains on the two-hop intersection; with only the two gold edges it answers Product-D1', False),
}

# Analyst read of oracle and candidate answers for the misses (True = conveys the asked values; the strict scorer
# verdict is kept next to it). Only rows where the read differs from the scorer or the scorer could not judge.
ORACLE_ANALYST = {
 ('s30-13', 'oracle-wholedoc'): True, ('s30-15', 'oracle-wholedoc'): True,
 ('h3-09', 'oracle-sql'): False,
 ('h3-21', 'oracle-docs'): False, ('h3-21', 'oracle-wholedoc'): True, ('h3-21', 'expand-topdoc'): False,
 ('h3-22', 'oracle-docs'): False, ('h3-22', 'oracle-wholedoc'): True, ('h3-22', 'expand-topdoc'): True,
 ('h3-30', 'oracle-docs'): True, ('h3-30', 'oracle-wholedoc'): True, ('h3-30', 'expand-topdoc'): True,
 ('h3-35', 'oracle-route'): True, ('h3-35', 'oracle-docs'): True,
 ('h3-60', 'oracle-edges'): True,
 ('h4-26', 'oracle-docs'): False, ('h4-26', 'oracle-wholedoc'): False, ('h4-26', 'expand-topdoc'): False,
 ('h4-32', 'oracle-route'): True, ('h4-32', 'oracle-docs'): True,
 ('h4-39', 'oracle-docs'): True, ('h4-39', 'oracle-chunks'): True, ('h4-39', 'oracle-wholedoc'): True, ('h4-39', 'expand-topdoc'): True,
 ('h4-40', 'oracle-route'): True, ('h4-40', 'oracle-docs'): True,
 ('h4-33', 'oracle-docs'): False,
}

def load(path):
    try:
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    except FileNotFoundError:
        return None

def short(s, n=300):
    s = re.sub(r'\s+', ' ', s or '').strip()
    return s if len(s) <= n else s[:n] + '…'

VALUE_RULE = load(f'{SCR}/value-rule.json') or {}
rows = []
for s in ['sponsor30', 'holdout3', 'holdout4']:
    ref = load(f'{REF_DIR}/companyx-doctype-score-{s}-off.json')
    trace = {r['q']: r for r in load(f'{SCR}/{s}-trace.json')['rows']}
    oracles = {}
    for m in ['oracle-route', 'oracle-sql', 'oracle-docs', 'oracle-chunks', 'oracle-wholedoc', 'oracle-edges', 'expand-topdoc']:
        d = load(f'{SCR}/{s}-{m}.json')
        if d:
            oracles[m] = {r['q']: r for r in d['rows']}
    for i, r in enumerate(ref['rows']):
        if r['answer_correct']:
            continue
        t = trace.get(r['q'])
        rid = t['id'] if t else r.get('id', f's30-{i+1:02d}')
        stage, why, analyst = L[rid]
        row = {
            'set': s, 'id': rid, 'lane': r['lane'], 'q': r['q'],
            'scorer_1011': 'unscorable' if r.get('unscorable') else 'wrong',
            'scorer_reason_1011': r['reason'],
            'rerun_correct': None if not t else (None if t['unscorable'] else t['correct']),
            'routed': r['routed'], 'route_ok': r['route_match'],
            'stage': stage or 'none (unscorable, analyst: right)',
            'why': why, 'analyst_right': analyst,
            'answer_1011': short(r['answer']),
        }
        if t:
            if t.get('sql') and r['lane'] == 'nl2sql':
                q = t['sql']
                row['sql'] = {k: q.get(k) for k in ['generated', 'executed', 'rewritten', 'repaired', 'ok', 'error', 'rows', 'rows_kept', 'gold_rows', 'ex_match', 'rows_have_answer', 'ctx_rows_have_answer']}
                if row['sql']['generated']:
                    row['sql']['generated'] = short(row['sql']['generated'], 600)
                if row['sql']['executed']:
                    row['sql']['executed'] = short(row['sql']['executed'], 600)
                if q.get('gate'):
                    row['sql']['gate'] = {'outcome': q['gate']['outcome'], 'reasons': [short(x, 240) for g in q['gate'].get('rejected', []) for x in (g.get('reasons', []) if isinstance(g, dict) else [])]}
            if t.get('vector') and r['lane'] == 'vector_search':
                v = t['vector']
                row['vector'] = {k: v.get(k) for k in ['gold_docs', 'gold_rank', 'gold_in_ctx', 'hits', 'ctx', 'key_chunks_in_hits', 'key_chunks_in_ctx']}
            if t.get('graph') and r['lane'] == 'knowledge_graph':
                g = t['graph']
                row['graph'] = {k: g.get(k) for k in ['strategy', 'items', 'items_kept', 'gold_edges', 'edges_in_items', 'edges_in_ctx', 'names_in_items', 'names_in_ctx']}
            row['answer_path'] = t['answer_path']
        o = {}
        for m, d in oracles.items():
            x = d.get(r['q'])
            if x:
                o[m] = {'strict': None if x['unscorable'] else x['correct'], 'answer': short(x['answer'], 200)}
                vr = VALUE_RULE.get(f'{s}-{m}.json', {}).get(rid)
                if vr:
                    o[m]['number_rule'] = vr['number_rule']
                if (rid, m) in ORACLE_ANALYST:
                    o[m]['analyst_right'] = ORACLE_ANALYST[(rid, m)]
        vr0 = VALUE_RULE.get(f'{s}-trace.json', {}).get(rid)
        if vr0:
            row['number_rule_rerun'] = vr0['number_rule']
        if o:
            row['oracle'] = o
        rows.append(row)

summary = defaultdict(Counter)
for x in rows:
    summary[x['set']][x['stage']] += 1
    summary['all'][x['stage']] += 1
lane = defaultdict(Counter)
for x in rows:
    lane[x['lane']][x['stage']] += 1
# Strict-scorer ceilings: the record's verdicts with each oracle run's verdicts substituted for the questions it covered.
ceilings = {}
record = {}
for st in ['sponsor30', 'holdout3', 'holdout4']:
    ref = load(f'{REF_DIR}/companyx-doctype-score-{st}-off.json')
    trace = {r['q']: r['id'] for r in load(f'{SCR}/{st}-trace.json')['rows']}
    for r in ref['rows']:
        record[(st, trace[r['q']])] = None if r.get('unscorable') else bool(r['answer_correct'])
base = sum(1 for v in record.values() if v)
ceilings['record'] = {'strict_correct': base, 'scorable': sum(1 for v in record.values() if v is not None)}
for m in ['oracle-route', 'oracle-sql', 'oracle-docs', 'oracle-chunks', 'oracle-edges', 'expand-topdoc']:
    cur = dict(record)
    covered = 0
    for st in ['sponsor30', 'holdout3', 'holdout4']:
        d = load(f'{SCR}/{st}-{m}.json')
        if not d:
            continue
        for r in d['rows']:
            covered += 1
            cur[(st, r['id'])] = None if r['unscorable'] else bool(r['correct'])
    ceilings[m] = {'strict_correct': sum(1 for v in cur.values() if v), 'questions_rerun': covered}
models = {}
for f in sorted(os.listdir(SCR)):
    if f.startswith('sql-models-') and f.endswith('.json'):
        d = load(f'{SCR}/{f}')
        models[f[len('sql-models-'):-5]] = {
            'summary': d['summary'],
            'per_question': {r['id']: {'ex': r['ex'], 'ex_repo_matcher': r['ex_repo_matcher'], 'rows_have_answer': r['rows_have_answer']} for r in d['rows']},
        }

out = {
    'note': 'Every wrong, abstained or unscorable answer in the 2026-10-11 scorecards (main c7c1083 behaviour, DOC_TYPE_FILTER off, '
            'files companyx-doctype-score-{set}-off.json), attributed to the earliest stage whose failure explains it. Traces and oracle runs '
            'are reruns on c7c1083 in a clean worktree against mcpdata_diag and the host Ollama (qwen2.5-coder:7b, bge-m3). analyst_right is a '
            'human read of the answer against the gold basis and the dataset, not the scorer.',
    'generated_at': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S'),
    'counts_by_set': {k: dict(v) for k, v in summary.items()},
    'counts_by_lane': {k: dict(v) for k, v in lane.items()},
    'strict_ceilings': ceilings,
    'nl2sql_models': models,
    'rows': rows,
}
os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, 'w', encoding='utf-8') as f:
    json.dump(out, f, ensure_ascii=False, indent=1)
    f.write('\n')
print(json.dumps(out['counts_by_set'], ensure_ascii=False, indent=1))
print(json.dumps(out['counts_by_lane'], ensure_ascii=False, indent=1))
print(len(rows), 'rows')
print(json.dumps(ceilings, indent=1))
