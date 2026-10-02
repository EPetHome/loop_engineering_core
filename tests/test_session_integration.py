"""Composed A/B/C/D integration with real OS denials and deterministic local JSONL.

These are wire stubs, never a call to Pi or proof of model savings. Assertions
inspect frozen code, gate executions, leases, raw events and formal export, not
merely the stub's own PASS report.
"""
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

PROJECT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT / 'engine'))
from loop_engineering.audit import audit, export_candidate
from loop_engineering.common import LoopError, load_json
from loop_engineering.engine import Controller
from loop_engineering.rules import normalize
from loop_engineering.storage import create_run


PROGRAM = r'''
import json, os, subprocess, sys
from pathlib import Path
args=sys.argv[1:]
prompt=sys.stdin.read()
c=json.loads(Path(os.environ['LOOP_CONTEXT']).read_text())
s=c['session'];cwd=Path.cwd().resolve()
assert str(cwd)==c['code_path']
assert c['code_path'] in prompt and c['attempt_id'] in prompt
assert '--continue' not in args and '--resume' not in args
assert args[args.index('--mode')+1]=='json'
session=args[args.index('--session')+1] if '--session' in args else None
if session:
    p=Path(session)
    lines=p.read_text().splitlines()
    header=json.loads(lines[0])
    assert header['cwd']==str(cwd), 'tools must use the reopened header cwd'
    prior=json.loads(lines[-1])['id'] if len(lines)>1 else None
    with p.open('a') as f:f.write(json.dumps({'type':'custom','id':c['attempt_id'],'parentId':prior,'timestamp':'2026-10-01T00:00:00.000Z','customType':'offline-invocation','data':{'round':c['round']}})+'\n')
    tool_cwd=Path(header['cwd'])
else:
    assert '--no-session' in args
    tool_cwd=cwd
    assert c['role']=='reviewer' or s['policy']=='fresh'

def emit(event):print(json.dumps(event),flush=True)
emit({'type':'agent_start'})
emit({'type':'turn_start'})
emit({'type':'tool_execution_start','toolCallId':'guard-check','toolName':'bash','args':{'command':'offline OS write probes'}})
attempted=[]
writer='import json,sys;from pathlib import Path\np=Path(sys.argv[1])\ntry:p.write_bytes(b"ILLEGAL")\nexcept OSError:print("denied")\nelse:print("written")\n'
for index,old in enumerate(s['previous_code_paths'] if s['policy']=='reuse_repairs' else []):
    original=Path(old)/'invites.py'
    before=original.read_bytes()
    alias=Path(c['workspace_path'])/('old-alias-'+str(index))
    alias.symlink_to(Path(old),target_is_directory=True)
    denied=[]
    for target in (original,alias/'invites.py'):
        done=subprocess.run(['/bin/bash','-c','exec "$@"','old-write',sys.executable,'-c',writer,str(target)],capture_output=True,text=True)
        denied.append(done.returncode==0 and done.stdout.strip()=='denied')
    chmod_denied=False
    try:os.chmod(original,0o600)
    except OSError:chmod_denied=True
    assert all(denied) and chmod_denied, (old,denied,chmod_denied)
    assert original.read_bytes()==before
    attempted.append({'old':old,'denied':denied,'chmod_denied':chmod_denied})
emit({'type':'tool_execution_end','toolCallId':'guard-check','toolName':'bash','isError':False,'result':{'content':[]}})
scenario=os.environ.get('SESSION_SCENARIO','two_repairs')
if c['role']=='developer' and not c['protocol_repair_only']:
    (tool_cwd/'invites.py').write_text('value = %d\n'%c['round'])
if c['role']=='reviewer':
    assert (tool_cwd/'invites.py').read_text()=='value = %d\n'%c['round']
with open(os.environ['SESSION_CAPTURE'],'a') as f:
    f.write(json.dumps({'context':c,'session':session,'argv':args,'attempted':attempted})+'\n')
if scenario=='infra' and c['role']=='developer' and s['reason']=='first_business_attempt':sys.exit(7)
r={'attempt_id':c['attempt_id'],'role':c['role'],'candidate_hash':c['candidate_hash'],
   'summary':'deterministic wire stub','blocked':False,'issues':[],'rule_gaps':[],
   'criteria':[{'id':x['id'],'status':'PASS','note':'offline code evidence','evidence':['code:invites.py']} for x in c['unit']['criteria']]}
if scenario=='protocol' and c['role']=='developer' and c['round']==1 and not c['protocol_repair_only']:
    r['attempt_id']='expired-receipt'
if c['role']=='reviewer' and c['round']<(3 if scenario=='two_repairs' else 2):
    r['criteria'][0]['status']='FAIL'
    r['issues']=[{'criterion_id':r['criteria'][0]['id'],'description':'revision %d required'%c['round'],'suggested_fix':'increment current code'}]
    if c['round']==1:r['rule_gaps']=['prove historical revision explicitly']
if c['role']=='reviewer' and c['round']>1:
    r['issue_resolutions']=[{'id':item['id'],'note':'checked current code and current gate','evidence':['code:invites.py','gate:G']} for item in c['issue_history']]
u={'input':10,'output':2,'cacheRead':3,'cacheWrite':0,'cost':{'total':0}}
m={'role':'assistant','content':[{'type':'text','text':json.dumps(r)}],'usage':u,'stopReason':'stop'}
emit({'type':'message_update','usage':u,'assistantMessageEvent':{'type':'text_delta','delta':'partial'}})
emit({'type':'message_end','message':m})
emit({'type':'turn_end','message':m})
emit({'type':'agent_end','messages':[m],'willRetry':False})
emit({'type':'agent_settled'})
'''


class ComposedSessionIntegration(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.work = Path(self.tmp.name).resolve()
        self.source, self.root = self.work / 'source', self.work / 'data'
        shutil.copytree(PROJECT / 'engine/examples/demo_project', self.source)
        self.before = (self.source / 'invites.py').read_bytes()
        self.program = self.work / 'wire-program'
        self.program.write_text('#!' + sys.executable + '\n' + PROGRAM)
        self.program.chmod(0o700)
        self.capture = self.work / 'calls.jsonl'
        self.raw = load_json(PROJECT / 'engine/examples/demo.json')
        self.raw['source'] = str(self.source)
        self.raw['limits'].update(max_parallel=1, max_wall_seconds=120, max_member_invocations=16)
        for agent in self.raw['agents'].values():
            agent.update(kind='command', argv=[sys.executable, str(PROJECT / 'adapters/pi_member.py'),
                         '--model', 'explicit-offline-wire', '--thinking', 'max', '--tools', 'read,bash,edit,write'],
                         output='stdout', inherit_env=['LOOP_PI_BIN', 'SESSION_CAPTURE', 'SESSION_SCENARIO'])
        u = self.raw['units'][0]
        u.update(developer_session='reuse_repairs', max_repairs=2, max_protocol_retries=1, max_infra_retries=1)
        u['gates'] = [{'id': 'G', 'argv': [sys.executable, '-c',
            'from pathlib import Path; value=int(Path("invites.py").read_text().split("=")[1]); '
            'assert 1 <= value <= 3; print("tested candidate value", value)'], 'timeout_seconds': 10}]
        for row in u['criteria']: row['gate_ids'] = ['G']

    def execute(self, scenario='two_repairs'):
        rules = normalize(self.raw, self.work)
        rid = create_run(self.root, rules)
        self.run = self.root / 'runs' / rid
        with patch.dict(os.environ, LOOP_PI_BIN=str(self.program), SESSION_CAPTURE=str(self.capture), SESSION_SCENARIO=scenario):
            Controller(self.root, rid).execute()
        data = load_json(self.run / 'manifest.json')
        diagnostics = '\n'.join(p.read_text() for p in self.run.glob('units/*/attempts/*/job/stderr.log'))
        self.assertEqual(data['result']['stop'], 'PASSED', data['units']['invite']['result']['reason'] + '\n' + diagnostics)
        self.calls = [json.loads(line) for line in self.capture.read_text().splitlines()]
        return data

    def test_two_business_repairs_resolution_observation_protection_finalization_export(self):
        d = self.execute()
        u = d['units']['invite']
        self.assertEqual(u['stats']['repairs'], 2)
        self.assertEqual(u['stats']['member_invocations'], 6)
        self.assertEqual(d['result']['finalization']['status'], 'PASS')
        self.assertEqual(d['result']['human_acceptance'], 'NOT_PERFORMED')
        dev = [x for x in self.calls if x['context']['role'] == 'developer']
        review = [x for x in self.calls if x['context']['role'] == 'reviewer']
        self.assertEqual([x['context']['session']['mode'] for x in dev], ['fresh', 'reuse_repairs', 'reuse_repairs'])
        self.assertEqual(len({x['session'] for x in dev}), 1)
        self.assertTrue(all(x['session'] is None for x in review))
        self.assertTrue(all(x['attempted'] for x in dev[1:]))
        self.assertEqual(len({x['context']['code_path'] for x in self.calls}), 6)
        self.assertEqual(len({x['context']['attempt_id'] for x in self.calls}), 6)
        self.assertEqual((self.source / 'invites.py').read_bytes(), self.before)
        for round, history in enumerate(u['result']['history'], 1):
            candidate = Path(history['candidate']['path'])
            self.assertEqual((candidate / 'invites.py').read_text(), f'value = {round}\n')
            self.assertFalse((candidate / 'invites.py').stat().st_mode & 0o222)
            gate = history['gates']['G']
            self.assertEqual(gate['status'], 'PASS')
            self.assertEqual(gate['candidate_hash'], history['candidate']['hash'])
            self.assertIn(f'tested candidate value {round}', Path(gate['stdout']).read_text())
        ledger = u['result']['issue_history']
        self.assertGreaterEqual(len(ledger), 3)
        self.assertTrue(all(x['status'] == 'RESOLVED' for x in ledger))
        self.assertTrue(all(x['resolution']['candidate_hash'] == u['result']['candidate']['hash'] for x in ledger))
        self.assertEqual(u['result']['rule_gaps'], [])
        self.assertTrue(u['result']['historical_rule_gaps'])
        self.assertEqual(d['result']['member_usage']['tokens'], {'input': 60, 'output': 12, 'cache_read': 18, 'cache_write': 0})
        self.assertEqual(d['result']['member_usage']['assistant_messages'], 6)
        self.assertEqual(d['result']['member_usage']['tool_calls'], 6)
        self.assertIsNone(d['result']['member_usage']['api_requests'])
        self.assertIsNone(d['result']['member_usage']['cost'])
        for call in self.calls:
            adir = Path(call['context']['workspace_path'])
            activity = load_json(adir / 'activity.json')
            self.assertTrue(activity['last_event_at'])
            self.assertFalse(activity['running'])
            self.assertIn('tool_execution_start', (adir / 'pi-events.jsonl').read_text())
            guard = load_json(adir / 'session-protection.json')
            self.assertEqual(guard['status'], 'PASS')
            self.assertTrue(guard['absolute_write_denied'] and guard['symlink_write_denied'])
            if call['context']['role'] == 'developer': self.assertTrue(guard['current_writable'])
        lines = Path(dev[0]['session']).read_text().splitlines()
        self.assertEqual([json.loads(line)['id'] for line in lines[1:]], [x['context']['attempt_id'] for x in dev])
        self.assertEqual(json.loads(lines[0])['cwd'], dev[-1]['context']['code_path'])
        self.assertTrue(audit(self.root, self.run.name)['integrity_ok'])
        exported = export_candidate(self.root, self.run.name, self.work / 'formal-export')
        self.assertEqual((exported / 'invites.py').read_text(), 'value = 3\n')
        with self.assertRaises(LoopError): export_candidate(self.root, self.run.name, exported)
        # Export is a copy, not a rewrite of the original source or prior round.
        self.assertEqual((self.source / 'invites.py').read_bytes(), self.before)
        self.assertEqual((Path(u['result']['history'][0]['candidate']['path']) / 'invites.py').read_text(), 'value = 1\n')

    def test_old_receipt_causes_new_format_session_not_business_resume(self):
        d = self.execute('protocol')
        dev = [x for x in self.calls if x['context']['role'] == 'developer']
        self.assertEqual(len(dev), 3)
        self.assertEqual(len({x['session'] for x in dev}), 3)
        self.assertTrue(dev[1]['context']['protocol_repair_only'])
        self.assertEqual(dev[1]['context']['session']['mode'], 'fresh')
        self.assertEqual(dev[1]['context']['session']['reason'], 'protocol_repair_always_fresh')
        self.assertEqual(dev[2]['context']['session']['mode'], 'fresh')
        self.assertIn('format_only_not_reusable', dev[2]['context']['session']['reason'])
        first = Path(dev[0]['context']['workspace_path'])
        self.assertIn('过期', (first / 'protocol-error.txt').read_text())
        self.assertFalse((first / 'accepted.json').exists())
        self.assertEqual(d['units']['invite']['stats']['protocol_retries_by_role'], {'developer': 1, 'reviewer': 0})
        self.assertEqual(d['units']['invite']['stats']['repairs'], 1)

    def test_failed_local_process_retries_fresh_and_preserves_failed_conversation(self):
        self.execute('infra')
        dev = [x for x in self.calls if x['context']['role'] == 'developer']
        self.assertEqual(len(dev), 3)
        self.assertNotEqual(dev[0]['session'], dev[1]['session'])
        self.assertEqual(dev[1]['context']['session']['mode'], 'fresh')
        self.assertIn('execution_failed', dev[1]['context']['session']['reason'])
        self.assertEqual(dev[1]['session'], dev[2]['session'])
        failed = Path(dev[0]['context']['workspace_path'])
        self.assertFalse((failed / 'accepted.json').exists())
        self.assertEqual(load_json(failed / 'job/receipt.json')['exit_code'], 7)
        self.assertEqual(len(Path(dev[0]['session']).read_text().splitlines()), 2)
        self.assertEqual(load_json(self.run / 'manifest.json')['units']['invite']['stats']['infra_retries'], 1)

    def test_fresh_control_uses_no_persisted_session(self):
        self.raw['units'][0]['developer_session'] = 'fresh'
        d = self.execute()
        self.assertTrue(all(x['session'] is None and '--no-session' in x['argv'] for x in self.calls))
        self.assertFalse((self.run / 'units/invite/sessions').exists())
        self.assertEqual(d['units']['invite']['stats']['repairs'], 2)
