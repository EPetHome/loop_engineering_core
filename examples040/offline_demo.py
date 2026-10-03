#!/usr/bin/env python3
"""Offline acceptance: one development repair + C06 + seven verification gates.

Uses deterministic local Python fixtures, NOT Pi/models/Maven. No user project is
read or modified. Explicit audit-only is for these generated harmless fixtures.
"""
import argparse
import json
import os
from pathlib import Path
import sys
import tempfile

BUNDLE=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(BUNDLE/'tests040'));sys.path.insert(0,str(BUNDLE))
from helpers import project,prepared,prep
from loop_guard import launch_prepared


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--out',type=Path)
    p.add_argument('--fail-c06',action='store_true')
    a=p.parse_args()
    if a.out:
        base=a.out.expanduser().absolute()
        if base.exists() or base.is_symlink():
            raise SystemExit('输出路径已存在，拒绝覆盖；请使用新的目录。')
        base.mkdir(parents=True)
    else:
        base=Path(tempfile.mkdtemp(prefix='loop040-offline-'))
    os.environ['LOOP_NO_NOTIFY']='1'
    raw=project(base,developer=True,repair=True,failed_verify=a.fail_c06)
    raw['units'][0]['id']='repair'
    verify={'id':'C06','kind':'verify','review_mode':'gates','goal':'OFFLINE one-scenario gate; not a real business scenario',
            'depends_on':['repair'],'input_from':'repair','criteria':[{'id':'C','text':'offline report exists','gate_ids':['G']}],
            'gates':[{'id':'G','profile':'fail' if a.fail_c06 else 'test','budget_key':'C06'}]}
    raw['units'].append(verify)
    raw['units'].append({'id':'seven','kind':'verify','review_mode':'gates','goal':'OFFLINE seven gate invocations; not real seven-scene acceptance',
             'depends_on':['C06'],'input_from':'C06',
             'criteria':[{'id':'C'+str(i),'text':'offline fixture '+str(i),'gate_ids':['G'+str(i)]} for i in range(1,8)],
             'gates':[{'id':'G'+str(i),'profile':'test'} for i in range(1,8)]})
    raw['completion']={'mode':'integration','unit':'seven'}
    (base/'task.v2.json').write_text(json.dumps(raw,ensure_ascii=False,indent=2))
    state,root,d=prepared(base,raw)
    report=prep.check(state,d['id'],1)
    if report['status']!='READY':
        raise SystemExit(json.dumps(report,ensure_ascii=False))
    sealed=prep.seal(state,d['id'],1)
    print('OFFLINE ONLY: generated fixtures, 0 real model calls, no real Maven execution.')
    launch_prepared(state,sealed['id'],approve=True)
    from loop_engineering.ledger import Ledger
    claim=Ledger(state).launch(sealed['launch_request_id'])
    m=json.loads((root/'runs'/claim['run_id']/'manifest.json').read_text())
    expected='NOT_MET' if a.fail_c06 else 'PASSED'
    summary={'real_model_calls':0,'real_business_tested':False,'security':'audit-only',
             'expected_stop':expected,'actual_stop':m['result']['stop'],'finalization':m['result']['finalization']['status'],
             'member_fixture_invocations':m['budget']['member_invocations'],'budget':m['budget'],
             'units':{u:{'stop':s['result']['stop'],'reviewed':s['result'].get('reviewed',False)} for u,s in m['units'].items()},
             'run_id':m['run_id'],'result_path':str(root/'runs'/claim['run_id']/'result.md'),
             'authorization_id':claim['authorization'],'launch_request_id':sealed['launch_request_id']}
    # Exercise exact duplicate: it must not create another run or call supervise.
    before=len(list((root/'runs').iterdir()))
    launch_prepared(state,sealed['id'],approve=True)
    summary['duplicate_did_not_create_run']=before==len(list((root/'runs').iterdir()))
    (base/'DEMO-RESULT.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2))
    print(json.dumps(summary,ensure_ascii=False,indent=2))
    print('演示记录：'+str(base/'DEMO-RESULT.json'))
    okay=m['result']['stop']==expected and summary['duplicate_did_not_create_run'] and m['result']['finalization']['status']=='PASS'
    return 0 if okay else 1

if __name__=='__main__':raise SystemExit(main())
