"""보호가 실제로 막는지 **빨간 PR 로** 확인한다.

`enforce_admins` 를 켰다고 적는 것과 막히는 것은 다르다 — 오늘 하루 그 구분으로
결함을 열 개 넘게 찾았다. **통과만 보는 것은 검사가 아니다.**

방법: 일부러 깨지는 브랜치를 만들어 PR 을 열고, CI 가 빨개진 뒤 병합을 시도한다.
막히면 닫고 브랜치를 지운다.

깨는 방법은 **되돌리기 쉬운 것**으로 고른다 — 증거 매니페스트에 한 글자를 넣는다.
(오늘 그 검사가 실제로 main 을 빨갛게 만든 그 자리다.)
"""
import json
import os
import subprocess
import time
import urllib.request

REPO = 'yeongjunyoo/onprem-mcp-data'
ROOT = r'C:\Users\basqu\Projects\onprem-mcp-data'
tok = subprocess.run(['gh', 'auth', 'token'], capture_output=True, text=True).stdout.strip()


def api(path, method='GET', body=None):
    req = urllib.request.Request(
        f'https://api.github.com/repos/{REPO}/{path}',
        headers={'Authorization': f'token {tok}', 'Accept': 'application/vnd.github+json',
                 'Content-Type': 'application/json'},
        method=method, data=json.dumps(body).encode() if body else None)
    try:
        raw = urllib.request.urlopen(req).read().decode()
        return json.loads(raw) if raw.strip() else {}
    except urllib.error.HTTPError as e:
        return {'_error': e.code, '_body': e.read().decode()[:300]}


def git(*a):
    return subprocess.run(['git', *a], cwd=ROOT, capture_output=True, text=True, encoding='utf-8')


BR = 'test/protection-probe'
git('checkout', 'main', '-q')
git('checkout', '-b', BR, '-q')

man = os.path.join(ROOT, 'eval', 'results', 'MANIFEST.md')
with open(man, 'a', encoding='utf-8') as f:
    f.write('\n<!-- 보호 규칙 시험용 한 줄. 이 PR 은 병합되지 않고 닫힌다. -->\n')

git('add', '-A')
git('commit', '-q', '-m', 'test: 브랜치 보호가 빨간 PR 을 막는지 확인 (병합 안 함)')
git('push', '-u', 'origin', BR, '-q')

pr = api('pulls', 'POST', {'title': 'test: 보호 규칙 시험 (병합하지 않음)',
                           'head': BR, 'base': 'main',
                           'body': 'enforce_admins 가 실제로 빨간 병합을 막는지 확인하는 일회용 PR. 확인 후 닫는다.'})
num = pr.get('number')
print('시험 PR:', num)

sha = git('rev-parse', 'HEAD').stdout.strip()
for i in range(18):
    runs = api(f'commits/{sha}/check-runs').get('check_runs', [])
    done = [c for c in runs if c['status'] == 'completed']
    bad = [c for c in runs if c['conclusion'] not in (None, 'success', 'skipped')]
    if bad:
        print(f'CI 빨감 {len(bad)}건 — 병합을 시도한다')
        break
    print(f'  대기 {i + 1}/18 · 완료 {len(done)}/{len(runs)}')
    time.sleep(20)
else:
    print('CI 가 빨개지지 않았다 — 시험 실패')

res = api(f'pulls/{num}/merge', 'PUT', {'merge_method': 'merge'})
if res.get('_error'):
    print(f"★ 병합 차단됨 ({res['_error']})")
    print('  ', res['_body'][:170].replace('\\n', ' '))
else:
    print('☠ 병합이 통과했다 — 보호가 작동하지 않는다:', res.get('message'))

api(f'pulls/{num}', 'PATCH', {'state': 'closed'})
git('checkout', 'main', '-q')
git('push', 'origin', '--delete', BR, '-q')
git('branch', '-D', BR, '-q')
print('정리 완료 · 현재 브랜치:', git('rev-parse', '--abbrev-ref', 'HEAD').stdout.strip())
