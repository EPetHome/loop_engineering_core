#!/usr/bin/env python3
"""OFFLINE deterministic member fixture. Never calls Pi, Codex or a model."""
import json,os,socket,sys
from pathlib import Path
c=json.loads(Path(os.environ['LOOP_CONTEXT']).read_text())
role=c['role']; code=Path(c['code_path'])

def rpc(method,**kw):
    with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as s:
        s.settimeout(30);s.connect(os.environ['LOOP_MEMBER_SOCKET'])
        s.sendall((json.dumps({'token':os.environ['LOOP_MEMBER_TOKEN'],'method':method,**kw})+'\n').encode())
        with s.makefile('rb') as f:r=json.loads(f.readline())
    if not r['ok']:raise RuntimeError(r['error'])
    return r['result']

rpc('hello')
if role=='developer' and not c['protocol_repair_only']:
    (code/'value.txt').write_text('fixed-round-'+str(c['round']))
    for name in c['unit']['build_profiles']:
        result=rpc('build',recipe_id=name,request_id='selftest-'+str(c['round']))
        if result['status']!='PASS':raise RuntimeError(str(result))
    rpc('submit_check')
rows=[]
for criterion in c['unit']['criteria']:
    status='PASS'
    if role=='reviewer' and c['round']==1 and '--repair' in sys.argv:
        status='FAIL'
    if role=='reviewer' and any(c['gate_evidence'][g]['status']!='PASS' for g in criterion['gate_ids']):
        status='FAIL'
    rows.append({'id':criterion['id'],'status':status,'note':'OFFLINE stub, not model judgement',
                 'evidence':['code:value.txt'] if role=='developer' else ['gate:'+g for g in criterion['gate_ids']]})
report={'attempt_id':c['attempt_id'],'role':role,'candidate_hash':'' if role=='developer' else c['candidate_hash'],
        'summary':'Deterministic offline fixture','blocked':False,'criteria':rows,
        'issues':[{'criterion_id':x['id'],'description':'fixture requires second development round',
                   'suggested_fix':'produce second version'} for x in rows if x['status']=='FAIL'], 'rule_gaps':[]}
Path(c['response_path']).write_text(json.dumps(report))
print(json.dumps(report))
