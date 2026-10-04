#!/usr/bin/env python3
"""OFFLINE severity/stagnation member. No Pi, Codex or model calls."""
import json,os,socket,sys
from pathlib import Path
c=json.loads(Path(os.environ['LOOP_CONTEXT']).read_text())
role=c['role'];code=Path(c['code_path']);rnd=c['round'];scenario=sys.argv[sys.argv.index('--scenario')+1]
value='second.txt' if c['unit_id']=='U2' else 'value.txt'


def rpc(method,**kw):
    with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as s:
        s.settimeout(30);s.connect(os.environ['LOOP_MEMBER_SOCKET'])
        s.sendall((json.dumps({'token':os.environ['LOOP_MEMBER_TOKEN'],'method':method,**kw})+'\n').encode())
        with s.makefile('rb') as f:r=json.loads(f.readline())
    if not r['ok']:raise RuntimeError(r['error'])
    return r['result']


def finding(description,severity='blocking'):
    return {'criterion_id':'C','description':description,'suggested_fix':'fix only the blocking result',
            'files':[value],'severity':severity,'counterexample':'input 1 returns 2 instead of 1',
            'locations':[value+':1'],'spec_refs':['C']}


def resolution(item):
    return {'id':item['id'],'note':'checked in current candidate','evidence':['code:'+value]}


rpc('hello');issues=[];resolutions=[];status='PASS'
if role=='developer' and not c['protocol_repair_only']:
    (code/value).write_text('fixed-round-'+str(rnd))
    for name in c['unit']['build_profiles']:rpc('build',recipe_id=name,request_id='selftest-'+str(rnd))
    rpc('submit_check')
elif role=='reviewer':
    advisory_only=scenario=='advisory-only' or (scenario=='mixed' and c['unit_id']=='U2')
    if advisory_only:
        issues=[finding('optional stricter checks','advisory')]
    elif scenario!='gate-only':
        if rnd==1:
            count=3 if scenario=='stalled-third' else 2 if scenario=='stalled-second' else 1
            issues=[finding('known bug '+str(n)) for n in range(count)]
            if scenario!='reconfirm-only':issues.append(finding('optional stricter checks','advisory'))
            status='FAIL'
        else:
            blockers=[i for i in c['issue_history'] if i['kind']=='issue' and i.get('severity','blocking')=='blocking']
            if scenario=='mixed':resolutions=[resolution(i) for i in blockers]
            elif scenario=='stalled-third':
                resolutions=[resolution(i) for i in blockers if i['description']=='known bug 0']
                status='FAIL'
            elif scenario=='stalled-second':status='FAIL'
            elif scenario=='reconfirm-only':
                if rnd==2:resolutions=[resolution(i) for i in blockers]
                if rnd in (2,3):status='UNKNOWN'
rows=[{'id':x['id'],'status':status,'note':'OFFLINE severity fixture',
       'evidence':['code:'+value] if role=='developer' else ['gate:'+g for g in x['gate_ids']]}
      for x in c['unit']['criteria']]
r={'attempt_id':c['attempt_id'],'role':role,'candidate_hash':'' if role=='developer' else c['candidate_hash'],
   'summary':'offline severity fixture','blocked':False,'criteria':rows,'issues':issues,'rule_gaps':[]}
if resolutions:r['issue_resolutions']=resolutions
print(json.dumps(r))
