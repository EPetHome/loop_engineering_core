#!/usr/bin/env python3
"""DETERMINISTIC PROTOCOL STUB, NOT AN AI MODEL. Used only in offline demos/tests.

It really edits a checkout and the engine really runs protected tests. This proves
execution plumbing, not model reasoning quality or compatibility with an AI account.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import sys
import time

p = argparse.ArgumentParser()
p.add_argument('--context', required=True)
p.add_argument('--mode', default='repair')
a = p.parse_args()
c = json.loads(Path(a.context).read_text())
code, role, mode = Path(c['code_path']), c['role'], a.mode
is_dev = role == 'developer'
if mode == 'hang':
    time.sleep(60)
if mode == 'chatty':
    while True:
        print('still thinking', flush=True)
        time.sleep(.03)
if mode == 'missing':
    print('I am done.')
    sys.exit(0)
if mode == 'logspam':
    print('X' * 100000, flush=True)
    time.sleep(1)
if mode == 'once-exit' and len(list(Path(a.context).parent.parent.glob(role + '-*'))) == 1:
    sys.exit(9)
if mode == 'exit':
    sys.exit(7)
if mode == 'tamper-rule':
    rules = Path(a.context).parents[4] / 'rules.json'
    rules.chmod(0o600)
    rules.write_text('{}')
if mode == 'mutate-review' and not is_dev:
    f = code / 'invites.py'
    f.chmod(0o600)
    f.write_text('invalid = True\n')
if is_dev and not c['protocol_repair_only']:
    if mode.startswith('dag'):
        if c['unit_id'] == 'front':
            (code / 'frontend.py').write_text("def payload():\n    return {'invite_code': 'ABC'}\n")
        elif c['unit_id'] == 'back':
            key = 'token' if mode == 'dag-bad' else 'invite_code'
            (code / 'backend.py').write_text(f"def accept(data):\n    return data.get('{key}') == 'ABC'\n")
    else:
        if mode == 'boundary':
            (code / 'baseline.md').write_text('overwritten\n')
        implementation = "status == 'pending' and expired"
        if mode in ('always-fail', 'lie') or (mode == 'repair' and c['round'] == 1):
            implementation = 'expired'
        (code / 'invites.py').write_text('def can_resend(status: str, expired: bool) -> bool:\n    return ' + implementation + '\n')
if mode == 'format' and not c['protocol_repair_only']:
    Path(c['response_path']).write_text('{invalid')
    sys.exit(0)
if mode == 'slow':
    time.sleep(.6)
rows = []
for criterion in c['unit']['criteria']:
    gate_ids = criterion['gate_ids']
    if is_dev:
        evidence = ['code:' + ('frontend.py' if mode.startswith('dag') else 'invites.py')]
        status = 'PASS'
    else:
        evidence = ['gate:' + g for g in gate_ids]
        if not evidence:
            evidence = ['code:invites.py']
        status = 'PASS' if all(c['gate_evidence'][g]['status'] == 'PASS' for g in gate_ids) else 'FAIL'
        if mode == 'lie':
            status = 'PASS'
        if mode == 'unknown':
            status = 'UNKNOWN'
    rows.append({'id': criterion['id'], 'status': status, 'note': '离线协议桩结论；真实测试由引擎执行', 'evidence': evidence})
report = {'attempt_id': c['attempt_id'], 'role': role,
          'candidate_hash': c['candidate_hash'] if not is_dev else '',
          'summary': '离线协议桩：请以本轮门禁和代码证据为准', 'blocked': False,
          'criteria': rows,
          'issues': [{'criterion_id': r['id'], 'description': '标准尚未通过', 'suggested_fix': '检查过期状态与邀请状态联合判断'} for r in rows if r['status'] != 'PASS'],
          'rule_gaps': []}
if mode == 'stale':
    report['attempt_id'] = 'previous-run-attempt'
if mode == 'duplicate':
    report['criteria'] += report['criteria'][:1]
if mode == 'extra-criterion':
    report['issues'].append({'criterion_id': 'NEW', 'description': 'new scope', 'suggested_fix': 'do more'})
if mode == 'gap':
    report['blocked'] = True
    report['rule_gaps'] = ['离线测试：规则对同一行为有相互矛盾的定义']
Path(c['response_path']).write_text(json.dumps(report, ensure_ascii=False), encoding='utf-8')
print(json.dumps(report, ensure_ascii=False))
