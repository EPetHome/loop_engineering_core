"""Frozen behavior checks for iteration 03. No Pi, network or account calls.

Run from the composed project: python acceptance/check_iter03.py A|B|C|D.
The task's criteria specify the small public record shapes exercised here.
"""
import contextlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

PROJECT = Path(__file__).resolve().parents[1]
ENGINE = PROJECT / 'engine'
sys.path.insert(0, str(ENGINE))
from loop_engineering.common import LoopError, atomic_json, load_json
from loop_engineering.engine import Controller, UnitEngine
from loop_engineering.rules import normalize
from loop_engineering.storage import Store, create_run
from loop_engineering.supervisor import recover
from loop_engineering.audit import audit, export_candidate


def read(path):
    return json.loads(Path(path).read_text())


def report(c, status='PASS'):
    return {'attempt_id': c['attempt_id'], 'role': c['role'],
            'candidate_hash': c['candidate_hash'], 'summary': 'offline acceptance',
            'blocked': False, 'issues': [], 'rule_gaps': [],
            'criteria': [{'id': x['id'], 'status': status, 'note': 'offline evidence',
                          'evidence': ['code:invites.py']} for x in c['unit']['criteria']]}


class Rig:
    def __init__(self, work):
        self.work = Path(work).resolve()
        self.source, self.root = self.work / 'source', self.work / 'data'
        shutil.copytree(ENGINE / 'examples/demo_project', self.source)
        self.raw = load_json(ENGINE / 'examples/demo.json')
        self.raw['source'] = str(self.source)
        self.raw['limits'].update(max_wall_seconds=120, max_member_invocations=24)
        for agent in self.raw['agents'].values():
            agent.update(kind='command', argv=[sys.executable, '-c', 'raise RuntimeError("unexpected process")'], output='file')
        for u in self.raw['units']:
            u['gates'] = []
            u['max_repairs'] = 1
            u['max_protocol_retries'] = 0
            for cr in u['criteria']:
                cr['gate_ids'] = []
        self.contexts = []

    def create(self):
        self.rules = normalize(self.raw, self.work)
        self.rid = create_run(self.root, self.rules)
        self.run = self.root / 'runs' / self.rid

    def execute(self, action=None, crash=False):
        self.create()
        rig = self
        def job(engine, argv, code, job, stdin, timeout, idle, env, phase):
            c = load_json(job.parent / 'context.json')
            rig.contexts.append(c)
            value = report(c)
            if action:
                action(c, value)
            atomic_json(Path(c['response_path']), value)
            return {'reason': 'ok', 'exit_code': 0}
        class Crash(BaseException):
            pass
        with patch.object(UnitEngine, 'run_job', job):
            if crash:
                with patch.object(Store, 'finish_run', side_effect=Crash()):
                    try:
                        Controller(self.root, self.rid).execute()
                    except Crash:
                        pass
            else:
                Controller(self.root, self.rid).execute()
        return read(self.run / 'manifest.json')


class A(unittest.TestCase):
    def test_normal_finalization_and_export(self):
        with tempfile.TemporaryDirectory() as w:
            rig = Rig(w)
            d = rig.execute()
            self.assertEqual(d['result']['stop'], 'PASSED')
            f = d['result']['finalization']
            self.assertEqual(f['status'], 'PASS')
            self.assertEqual(f['rule_hash'], d['rule_hash'])
            self.assertEqual(f['input_hash'], d['input']['hash'])
            self.assertEqual(f['candidate_hashes'], {u: s['result']['candidate']['hash'] for u, s in d['units'].items() if s['result'].get('candidate')})
            target = export_candidate(rig.root, rig.rid, rig.work / 'export')
            self.assertTrue((target / 'invites.py').is_file())
            with self.assertRaises(LoopError):
                export_candidate(rig.root, rig.rid, target)

    def test_source_drift_blocks_formal_export_but_keeps_candidate(self):
        with tempfile.TemporaryDirectory() as w:
            rig = Rig(w)
            def mutate(c, _):
                if c['role'] == 'developer':
                    (rig.source / 'baseline.md').write_text('drift\n')
            d = rig.execute(mutate)
            self.assertEqual(d['result']['stop'], 'BLOCKED')
            self.assertEqual(d['result']['finalization']['status'], 'FAIL')
            self.assertEqual(d['units']['invite']['result']['stop'], 'PASSED')
            self.assertTrue(Path(d['units']['invite']['result']['candidate']['path']).is_dir())
            with self.assertRaises(LoopError):
                export_candidate(rig.root, rig.rid, rig.work / 'export')
            self.assertFalse((rig.work / 'export').exists())

    def test_crash_at_final_commit_never_becomes_pass(self):
        for drift in (False, True):
            with self.subTest(drift=drift), tempfile.TemporaryDirectory() as w:
                rig = Rig(w)
                def mutate(c, _):
                    if drift and c['role'] == 'developer':
                        (rig.source / 'baseline.md').write_text('drift\n')
                before = rig.execute(mutate, crash=True)
                self.assertNotEqual(before['state'], 'TERMINAL')
                old = before['units']['invite']['result']
                self.assertEqual(old['stop'], 'PASSED')
                result = recover(rig.root, rig.rid)
                self.assertEqual(result['stop'], 'BLOCKED')
                self.assertEqual(result['finalization']['status'], 'UNKNOWN')
                self.assertEqual(read(rig.run / 'manifest.json')['units']['invite']['result'], old)
                with self.assertRaises(LoopError):
                    export_candidate(rig.root, rig.rid, rig.work / 'export')

    def test_missing_or_forged_binding_does_not_allow_export(self):
        for case in ('legacy', 'rule', 'input', 'candidate'):
            with self.subTest(case=case), tempfile.TemporaryDirectory() as w:
                rig = Rig(w); d = rig.execute()
                if case == 'legacy':
                    d['result'].pop('finalization', None)
                else:
                    f = d['result']['finalization']
                    if case == 'candidate':
                        f['candidate_hashes']['invite'] = 'wrong'
                    else:
                        f[case + '_hash'] = 'wrong'
                atomic_json(rig.run / 'manifest.json', d)
                before = (rig.run / 'manifest.json').read_bytes()
                with self.assertRaises(LoopError):
                    export_candidate(rig.root, rig.rid, rig.work / 'export')
                self.assertEqual((rig.run / 'manifest.json').read_bytes(), before)

    def test_independent_pass_can_export_when_other_unit_fails(self):
        with tempfile.TemporaryDirectory() as w:
            rig = Rig(w)
            other = json.loads(json.dumps(rig.raw['units'][0]))
            other.update(id='other', writable_paths=[], max_repairs=0)
            rig.raw['units'].append(other)
            rig.raw['completion'] = {'mode': 'independent'}
            def fail(c, value):
                if c['unit_id'] == 'other' and c['role'] == 'reviewer':
                    for row in value['criteria']:
                        row['status'] = 'FAIL'
            d = rig.execute(fail)
            self.assertEqual(d['result']['stop'], 'NOT_MET')
            self.assertEqual(d['result']['finalization']['status'], 'PASS')
            self.assertTrue(export_candidate(rig.root, rig.rid, rig.work / 'export', 'invite').is_dir())


class B(unittest.TestCase):
    def test_comparison_and_explicit_resolution(self):
        for resolution in ('resolved', 'omitted', 'invented'):
            with self.subTest(resolution=resolution), tempfile.TemporaryDirectory() as w:
                rig = Rig(w)
                def action(c, value):
                    if c['role'] == 'developer':
                        (Path(c['code_path']) / 'invites.py').write_text('value = %d\n' % c['round'])
                    if c['role'] == 'reviewer' and c['round'] == 1:
                        value['criteria'][0]['status'] = 'FAIL'
                        value['issues'] = [{'criterion_id': value['criteria'][0]['id'], 'description': 'needs revision', 'suggested_fix': 'revise'}]
                        value['rule_gaps'] = ['missing historical proof']
                    if c['role'] == 'reviewer' and c['round'] == 2 and resolution != 'omitted':
                        ids = [item['id'] for item in c.get('issue_history', [])]
                        value['issue_resolutions'] = [{'id': x, 'note': 'verified on current candidate', 'evidence': ['code:invites.py']} for x in (ids if resolution == 'resolved' else ['nonexistent'])]
                d = rig.execute(action)
                first = next(c for c in rig.contexts if c['role'] == 'reviewer' and c['round'] == 1)
                second = [c for c in rig.contexts if c['round'] == 2]
                self.assertEqual(len(second), 2)
                for c in [first] + second:
                    comp = c['comparison']
                    self.assertEqual(comp['unit_input']['hash'], c['unit_input_hash'])
                    base = Path(comp['unit_input']['path'])
                    self.assertEqual((base / 'baseline.md').read_bytes(), (rig.source / 'baseline.md').read_bytes())
                    self.assertIn('invites.py', comp['changed_from_input']) if c['role'] == 'reviewer' else None
                    self.assertFalse((base / 'invites.py').stat().st_mode & 0o222)
                self.assertIsNone(first['comparison']['previous_candidate'])
                previous_hash = d['units']['invite']['result']['history'][0]['candidate']['hash']
                for c in second:
                    self.assertEqual(c['comparison']['previous_candidate']['hash'], previous_hash)
                    self.assertEqual(c['comparison']['previous_review']['criteria'][0]['status'], 'FAIL')
                    self.assertTrue(c['issue_history'])
                    if c['role'] == 'reviewer':
                        self.assertIn('invites.py', c['comparison']['changed_from_previous'])
                if resolution == 'invented':
                    self.assertEqual(d['result']['stop'], 'BLOCKED')
                else:
                    self.assertEqual(d['result']['stop'], 'PASSED')
                    items = d['units']['invite']['result']['issue_history']
                    self.assertGreaterEqual(len(items), 2)
                    if resolution == 'resolved':
                        self.assertTrue(all(x['status'] == 'RESOLVED' for x in items))
                        self.assertTrue(all(x['resolution']['candidate_hash'] == d['units']['invite']['result']['candidate']['hash'] for x in items))
                    else:
                        self.assertTrue(all(x['status'] != 'RESOLVED' for x in items))
                self.assertTrue(audit(rig.root, rig.rid)['integrity_ok'])


# Emits the documented Pi 0.87.1 JSONL wire format, never invokes Pi.
FAKE_PI = r'''
import json, os, sys, time
from pathlib import Path
args = sys.argv[1:]
sys.stdin.read()
assert args[args.index('--mode')+1] == 'json', args
c = json.loads(Path(os.environ['LOOP_CONTEXT']).read_text())
session_file = args[args.index('--session')+1] if '--session' in args else None
attempted = []
for old in (c.get('session') or {}).get('previous_code_paths', []):
    target = Path(old)/'invites.py'
    before = target.read_bytes()
    blocked = False
    try: target.write_bytes(b'ILLEGAL OLD WRITE')
    except OSError: blocked = True
    attempted.append({'path':old, 'blocked':blocked})
    if not blocked: target.write_bytes(before)
capture = os.environ.get('ITER03_CAPTURE')
if capture:
    with open(capture,'a') as f: f.write(json.dumps({'role':c['role'],'round':c['round'],'session':session_file,'attempted':attempted,'argv':args})+'\n')
if session_file:
    p=Path(session_file);p.parent.mkdir(parents=True,exist_ok=True)
    if not p.exists(): p.write_text(json.dumps({'type':'session','version':3,'id':'fake-session','timestamp':'2026-10-01T00:00:00Z','cwd':str(Path.cwd())})+'\n')
    header=json.loads(p.read_text().splitlines()[0])
    assert Path(header['cwd']).resolve()==Path.cwd().resolve(), 'Pi reopens the session header cwd: it must be rebound before reuse'
def emit(v):print(json.dumps(v),flush=True)
emit({'type':'session','version':3,'id':'fake-session','cwd':str(Path.cwd())})
emit({'type':'agent_start'})
emit({'type':'turn_start'})
emit({'type':'tool_execution_start','toolCallId':'tool1','toolName':'read','args':{'path':'invites.py'}})
pause = float(os.environ.get('ITER03_PAUSE','0'))
time.sleep(pause)
emit({'type':'tool_execution_end','toolCallId':'tool1','toolName':'read','result':{'content':[{'type':'text','text':'read completed'}]},'isError':False})
r={'attempt_id':c['attempt_id'],'role':c['role'],'candidate_hash':c['candidate_hash'],'summary':'fake Pi only','blocked':False,'issues':[],'rule_gaps':[], 'criteria':[{'id':x['id'],'status':'PASS','note':'offline evidence','evidence':['code:invites.py']} for x in c['unit']['criteria']]}
if c['role']=='reviewer' and c['round']==1 and capture:
    r['criteria'][0]['status']='FAIL'
    r['issues']=[{'criterion_id':r['criteria'][0]['id'],'description':'retry once','suggested_fix':'retry'}]
if c['role']=='developer':(Path(c['code_path'])/'invites.py').write_text('value = %d\n'%c['round'])
usage={'input':100,'output':20,'cacheRead':30,'cacheWrite':0,'totalTokens':150,'cost':{'input':0,'output':0,'cacheRead':0,'cacheWrite':0,'total':0}}
m={'role':'assistant','content':[{'type':'text','text':json.dumps(r)}],'usage':usage,'stopReason':'stop','timestamp':1}
emit({'type':'message_update','usage':usage,'assistantMessageEvent':{'type':'text_delta','contentIndex':0,'delta':'partial'}})
emit({'type':'message_end','message':m})
emit({'type':'turn_end','message':m,'toolResults':[]})
emit({'type':'agent_end','messages':[m],'willRetry':False})
emit({'type':'agent_settled'})
'''


def fake_pi(work):
    path = Path(work) / 'fake_pi'
    path.write_text('#!' + sys.executable + '\n' + FAKE_PI)
    path.chmod(0o700)
    return path


class C(unittest.TestCase):
    def test_stream_updates_before_exit_and_usage_not_double_counted(self):
        with tempfile.TemporaryDirectory() as w:
            rig = Rig(w); rig.execute()
            code = rig.work / 'code'; shutil.copytree(rig.source, code)
            adir = rig.work / 'attempt'; adir.mkdir()
            c = dict(rig.contexts[0])
            c.update({'run_id':rig.rid,'unit_id':'invite','attempt_id':'developer-r001-test','role':'developer',
                 'round':1,'candidate_hash':'','code_path':str(code),'workspace_path':str(adir),
                 'response_path':str(adir/'response.json'),
                 'unit':rig.rules['units'][0], 'limits':rig.rules['limits'], 'protocol_repair_only':False})
            atomic_json(adir / 'context.json', c)
            env = dict(os.environ, LOOP_PI_BIN=str(fake_pi(rig.work)), LOOP_CONTEXT=str(adir/'context.json'),
                       LOOP_ATTEMPT_ID=c['attempt_id'],LOOP_UNIT_ID='invite',LOOP_ROLE='developer',ITER03_PAUSE='2')
            argv = [sys.executable,str(PROJECT/'adapters/pi_member.py'),'--model','offline/fake','--thinking','max','--tools','read,bash,edit,write']
            with (rig.work/'out').open('wb') as out, (rig.work/'err').open('wb') as err:
                p = subprocess.Popen(argv,cwd=code,env=env,stdin=subprocess.PIPE,stdout=out,stderr=err)
                p.stdin.write(b'offline context\n');p.stdin.close()
                try:
                    until = time.monotonic()+1.5
                    while not (adir/'activity.json').exists() and time.monotonic()<until and p.poll() is None:
                        time.sleep(.02)
                    self.assertIsNone(p.poll(), 'fake member must still be running at observation')
                    self.assertTrue((adir/'activity.json').is_file(), 'activity must be persisted before exit')
                    self.assertTrue(read(adir/'activity.json').get('last_event_at'))
                    self.assertEqual(p.wait(timeout=10),0,(rig.work/'err').read_text())
                finally:
                    if p.poll() is None:p.kill();p.wait()
            self.assertEqual(read(rig.work/'out')['attempt_id'],c['attempt_id'])
            usage=read(adir/'usage.json')
            self.assertEqual(usage['assistant_messages'],1)
            self.assertEqual(usage['tool_calls'],1)
            self.assertEqual(usage['tokens'],{'input':100,'output':20,'cache_read':30,'cache_write':0})
            self.assertIsNone(usage['api_requests'])
            self.assertIsNone(usage['cost'])
            self.assertTrue((adir/'pi-events.jsonl').read_text().strip())


class D(unittest.TestCase):
    def test_explicit_session_reused_only_for_developer_and_old_writes_denied(self):
        with tempfile.TemporaryDirectory() as w:
            rig = Rig(w)
            fake = fake_pi(rig.work)
            capture=rig.work/'capture.jsonl'
            rig.raw['units'][0]['developer_session']='reuse_repairs'
            for agent in rig.raw['agents'].values():
                agent.update(argv=[sys.executable,str(PROJECT/'adapters/pi_member.py'),'--model','offline/fake','--thinking','max','--tools','read,bash,edit,write'],
                             output='stdout',inherit_env=['LOOP_PI_BIN','ITER03_CAPTURE'])
            rig.create()
            with patch.dict(os.environ,LOOP_PI_BIN=str(fake),ITER03_CAPTURE=str(capture)):
                Controller(rig.root,rig.rid).execute()
            d=read(rig.run/'manifest.json')
            self.assertEqual(d['result']['stop'],'PASSED',d['result'])
            calls=[json.loads(s) for s in capture.read_text().splitlines()]
            dev=[x for x in calls if x['role']=='developer'];rev=[x for x in calls if x['role']=='reviewer']
            self.assertEqual(len(dev),2);self.assertEqual(len(rev),2)
            self.assertTrue(dev[0]['session'])
            self.assertEqual(dev[0]['session'],dev[1]['session'])
            self.assertTrue(dev[1]['attempted'],'second developer must be given old checkout identities')
            self.assertTrue(all(x['blocked'] for x in dev[1]['attempted']),'real OS/tool guard must deny old writes')
            self.assertTrue(all(x['session']!=dev[0]['session'] for x in rev))
            self.assertTrue(all('--continue' not in x['argv'] for x in calls))
            contexts=[read(p) for p in (rig.run/'units/invite/attempts').glob('*/context.json')]
            self.assertEqual(len({x['attempt_id'] for x in contexts}),4)
            self.assertEqual(len({x['code_path'] for x in contexts}),4)

    def test_policy_is_explicit_opt_in(self):
        with tempfile.TemporaryDirectory() as w:
            rig=Rig(w)
            self.assertEqual(normalize(rig.raw,rig.work)['units'][0]['developer_session'],'fresh')
            for bad in (True,1,'continue','',None):
                with self.subTest(value=bad):
                    rig.raw['units'][0]['developer_session']=bad
                    with self.assertRaises(LoopError):normalize(rig.raw,rig.work)


if __name__ == '__main__':
    groups = {'A': A, 'B': B, 'C': C, 'D': D}
    selected = sys.argv[1:]
    if not selected or any(x not in groups for x in selected):
        raise SystemExit('usage: check_iter03.py A|B|C|D [more groups]')
    suite=unittest.TestSuite(unittest.defaultTestLoader.loadTestsFromTestCase(groups[x]) for x in selected)
    result=unittest.TextTestRunner(verbosity=2).run(suite)
    raise SystemExit(0 if result.wasSuccessful() else 1)
