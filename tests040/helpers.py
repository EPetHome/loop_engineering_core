from pathlib import Path
import json,sys
BUNDLE=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(BUNDLE/'engine'));sys.path.insert(0,str(BUNDLE))
from loop_engineering import prep
from loop_engineering.ledger import Ledger
from loop_engineering.storage import create_run
from loop_engineering.engine import Controller
from loop_engineering.rules import normalize
from loop_guard import maxima_for

BUILD="""from pathlib import Path
p=Path('module/target');p.mkdir(parents=True)
(p/'report.txt').write_text('one offline check executed\\n')
print('one offline check passed')
"""

def project(base,developer=False,repair=False,failed_verify=False):
    base=Path(base);src=base/'source';src.mkdir()
    (src/'module').mkdir();(src/'value.txt').write_text('initial')
    (src/'build.py').write_text(BUILD)
    profiles={'test':{'argv':['{python}','build.py'],'cwd':'.','output_paths':['module/target/'],
                       'evidence_paths':['module/target/report.txt'],'timeout_seconds':20,'probe_allowed':True}}
    unit={'id':'check','kind':'verify','review_mode':'gates','goal':'validate frozen code',
          'criteria':[{'id':'C','text':'test report recorded','gate_ids':['G']}],'gates':[{'id':'G','profile':'test'}]}
    agents={}
    if developer:
        for name in ('dev','review'):
            agents[name]={'kind':'command','identity':'offline-'+name,'argv':['{python}',str(BUNDLE/'tests040/fixtures/member.py')]+(['--repair'] if repair else []),'output':'stdout'}
        unit.update(kind='work',review_mode='independent',developer='dev',reviewer='review',
                    writable_paths=['value.txt'],build_profiles=['test'],max_repairs=1)
    raw={'schema_version':2,'task_id':'offline','title':'OFFLINE fixture — no models','source':str(src),
         'agents':agents,'security':'audit-only','execution_profiles':profiles,'units':[unit],
         'limits':{'max_wall_seconds':120,'max_member_invocations':12,'max_selftests':6,'max_total_repairs':3},
         'operation_budgets':{'C06':1}}
    if failed_verify:
        (src/'fail.py').write_text(BUILD+"raise SystemExit(1)\n")
        profiles['fail']={**profiles['test'],'argv':['{python}','fail.py']}
    return raw


def prepared(base,raw=None,require_probes=()):
    base=Path(base);raw=raw or project(base)
    state,root=base/'state',base/'data'
    p=prep.register_project(state,'p',raw,base,root,require_probes)
    d=prep.begin(state,'p')
    return state,root,d


def create_prepared_run(state,root,d,auth=None):
    s=prep.seal(state,d['id'],d['revision'])
    aid=auth or Ledger(state).authorize(d['project_id'],maxima_for(s['rules']))
    rid=create_run(root,s['rules'],admission={'state':str(state),'prepared_id':s['id'],'authorization_id':aid})
    return rid,s,aid


def execute_prepared(base,raw):
    state,root,d=prepared(base,raw)
    rid,s,aid=create_prepared_run(state,root,d)
    Controller(root,rid).execute()
    result=json.loads((root/'runs'/rid/'manifest.json').read_text())
    return result,state,root,s,aid
