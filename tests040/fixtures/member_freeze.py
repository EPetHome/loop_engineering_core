#!/usr/bin/env python3
"""OFFLINE member fixture for issue-list freeze scenarios. Never calls a model.

--scenario late-unchanged : round 2 reviewer finds a new problem in an unchanged file
--scenario regression     : round 2 reviewer finds a new problem in the file changed this round
--scenario nonconverge    : every repair round fixes the old problem and adds a new one in changed code
"""
import json,os,socket,sys
from pathlib import Path
c=json.loads(Path(os.environ['LOOP_CONTEXT']).read_text())
role=c['role']; code=Path(c['code_path']); scenario=sys.argv[sys.argv.index('--scenario')+1]; rnd=c['round']

def rpc(method,**kw):
    with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as s:
        s.settimeout(30);s.connect(os.environ['LOOP_MEMBER_SOCKET'])
        s.sendall((json.dumps({'token':os.environ['LOOP_MEMBER_TOKEN'],'method':method,**kw})+'\n').encode())
        with s.makefile('rb') as f:r=json.loads(f.readline())
    if not r['ok']:raise RuntimeError(r['error'])
    return r['result']

rpc('hello')
crit=c['unit']['criteria'][0]; gates=['gate:'+g for g in crit['gate_ids']]
issues,resolutions,status=[],[],'PASS'
if role=='developer' and not c['protocol_repair_only']:
    (code/'value.txt').write_text('fixed-round-'+str(rnd))
    for name in c['unit']['build_profiles']:
        rpc('build',recipe_id=name,request_id='selftest-'+str(rnd))
    rpc('submit_check')
elif role=='reviewer':
    if rnd==1:
        status='FAIL'; issues=[{'criterion_id':crit['id'],'description':'first problem','suggested_fix':'fix it','files':['value.txt']}]
    else:
        resolutions=[{'id':i['id'],'note':'fixed in this candidate','evidence':gates} for i in c['issue_history']
                     if i['kind']=='issue' and i['status']!='RESOLVED' and not i.get('deferred')]
        late={'late-unchanged':'build.py'}.get(scenario)
        changed={'regression':'value.txt','nonconverge':'value.txt'}.get(scenario)
        if late: issues=[{'criterion_id':crit['id'],'description':'late finding in old code','suggested_fix':'later','files':[late]}]
        if changed and not (scenario=='regression' and rnd>2):
            issues=[{'criterion_id':crit['id'],'description':'new problem round '+str(rnd),'suggested_fix':'fix','files':[changed]}]
        if issues: status='FAIL'
rows=[{'id':x['id'],'status':status if x is crit else 'PASS','note':'OFFLINE stub',
       'evidence':['code:value.txt'] if role=='developer' else ['gate:'+g for g in x['gate_ids']]} for x in c['unit']['criteria']]
report={'attempt_id':c['attempt_id'],'role':role,'candidate_hash':'' if role=='developer' else c['candidate_hash'],
        'summary':'freeze fixture','blocked':False,'criteria':rows,'issues':issues,'rule_gaps':[]}
if resolutions: report['issue_resolutions']=resolutions
print(json.dumps(report))
