"""Offline engine, streaming wrapper, finalization and handoff integration."""
import contextlib
import io
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

ENGINE = Path(__file__).resolve().parents[1]
PROJECT = ENGINE.parent
sys.path.insert(0, str(PROJECT))
import run_loop
from loop_engineering.audit import audit, export_candidate
from loop_engineering.common import atomic_json, load_json
from loop_engineering.engine import Controller
from loop_engineering.observability import read_observation, summarize, timing_fields
from loop_engineering.rules import normalize
from loop_engineering.storage import create_run

# The only executable passed as LOOP_PI_BIN is this deterministic local program.
STREAM_PROGRAM = r'''
import json, os, sys, time
from pathlib import Path
sys.stdin.read()
args=sys.argv[1:]
assert args[args.index('--mode')+1]=='json'
assert '--continue' not in args
c=json.loads(Path(os.environ['LOOP_CONTEXT']).read_text())
assert Path(c['comparison']['unit_input']['path'],'baseline.md').is_file()
if c['round']>1:
    assert c['comparison']['previous_candidate']
    assert c['comparison']['previous_review']['criteria'][0]['status']=='FAIL'
    assert c['issue_history']
def emit(v): print(json.dumps(v),flush=True)
emit({'type':'session'})
emit({'type':'turn_start'})
emit({'type':'tool_execution_start','toolCallId':'read1','toolName':'read'})
os.write(2,b'diagnostic waiting, not stage evidence\n'*1000)
time.sleep(float(os.environ.get('PAUSE_SECONDS','0')))
emit({'type':'tool_execution_end','toolCallId':'read1'})
emit({'type':'message_end','message':{'role':'assistant','stopReason':'toolUse','content':[], 'usage':{'input':3,'output':1,'cacheRead':0,'cacheWrite':0}}})
emit({'type':'turn_start'})
r={'attempt_id':c['attempt_id'],'role':c['role'],'candidate_hash':c['candidate_hash'],
   'summary':'deterministic stub, not a model','blocked':False,'issues':[],'rule_gaps':[],
   'criteria':[{'id':x['id'],'status':'PASS','note':'offline','evidence':['code:invites.py']} for x in c['unit']['criteria']]}
if os.environ.get('REPAIR_CYCLE') and c['role']=='reviewer' and c['round']==1:
    r['criteria'][0]['status']='FAIL'
    r['issues']=[{'criterion_id':r['criteria'][0]['id'],'description':'offline repair counterexample','suggested_fix':'revise'}]
if c['role']=='reviewer' and c['round']>1:
    r['issue_resolutions']=[{'id':x['id'],'note':'current candidate checked','evidence':['code:invites.py']} for x in c['issue_history']]
if c['role']=='developer':
    Path(c['code_path'],'invites.py').write_text('value=%d\n'%c['round'])
    if os.environ.get('DRIFT_SOURCE'):Path(os.environ['DRIFT_SOURCE'],'baseline.md').write_text('source drift\n')
u={'input':7,'output':2,'cacheRead':2,'cacheWrite':0,'cost':{'total':0}}
m={'role':'assistant','stopReason':'stop','content':[{'type':'text','text':json.dumps(r)}],'usage':u}
emit({'type':'message_update','usage':u,'assistantMessageEvent':{'type':'text_delta','delta':'partial'}})
emit({'type':'message_end','message':m})
emit({'type':'turn_end','message':m})
emit({'type':'agent_end','messages':[m],'willRetry':False})
emit({'type':'agent_settled'})
'''


class Aggregation(unittest.TestCase):
    def test_missing_invocation_does_not_turn_known_subtotal_into_total(self):
        u = {'assistant_messages': 2, 'tool_calls': 1, 'tokens': {'input': 10, 'output': 0}}
        r = summarize([{'usage': u, 'receipt': {'elapsed_seconds': 1}}], 2)
        self.assertIsNone(r['usage']['tokens']['input'])
        self.assertEqual(r['usage']['coverage']['tokens']['input']['observed_total'], 10)
        self.assertIsNone(r['usage']['assistant_messages'])
        self.assertIsNone(r['processes']['elapsed_seconds'])

    def test_fieldwise_coverage_and_known_zero_preserved(self):
        records = [{'usage': {'assistant_messages': 1, 'tool_calls': 0, 'tokens': {'input': 2, 'output': 0}},
                    'receipt': {'elapsed_seconds': 1, 'wall_elapsed_seconds': 1.1}},
                   {'usage': {'assistant_messages': 1, 'tool_calls': 1, 'tokens': {'input': 3}},
                    'receipt': {'elapsed_seconds': 2, 'wall_elapsed_seconds': 2.1, 'timing_discrepancy': True}}]
        r = summarize(records, 2)
        self.assertEqual(r['usage']['tokens']['input'], 5)
        self.assertIsNone(r['usage']['tokens']['output'])
        self.assertEqual(r['usage']['coverage']['tokens']['output']['observed_total'], 0)
        self.assertEqual(r['usage']['tool_calls'], 1)
        self.assertEqual(r['processes']['elapsed_seconds'], 3)
        self.assertTrue(r['processes']['timing_discrepancy'])
        self.assertIsNone(r['usage']['api_requests'])
        self.assertIsNone(r['usage']['cost'])

    def test_no_calls_is_not_a_free_model_claim(self):
        r = summarize([], 0)
        self.assertEqual(r['processes']['elapsed_seconds'], 0)
        self.assertEqual(r['processes']['process_invocations'], 0)
        self.assertIsNone(r['usage']['cost'])
        self.assertIsNone(r['usage']['tokens']['input'])

    def test_bad_projection_is_unknown_with_error_not_silently_passed(self):
        with tempfile.TemporaryDirectory() as w:
            workspace = Path(w)
            atomic_json(workspace / 'activity.json', {'phase': 3, 'last_event_at': 'x'})
            atomic_json(workspace / 'usage.json', {'tokens': {'input': True}})
            r = read_observation(workspace)
            self.assertIsNone(r['activity'])
            self.assertIsNone(r['usage'])
            self.assertEqual(len(r['errors']), 2)

    def test_projection_symlink_and_size_limit(self):
        with tempfile.TemporaryDirectory() as w:
            workspace = Path(w)
            target = workspace / 'other'
            target.write_text('{}')
            (workspace / 'activity.json').symlink_to(target)
            (workspace / 'usage.json').write_text('x' * (256 * 1024 + 1))
            r = read_observation(workspace)
            self.assertEqual(len(r['errors']), 2)
            self.assertIsNone(r['usage'])

    def test_timing_threshold_and_negative_wall_clock_jump(self):
        normal = timing_fields(10, 20, 12, 22)
        self.assertEqual(normal['elapsed_seconds'], 2)
        self.assertEqual(normal['wall_elapsed_seconds'], 2)
        self.assertFalse(normal['timing_discrepancy'])
        self.assertFalse(timing_fields(10, 20, 12, 24)['timing_discrepancy'])
        for wall_now in (24.1, 10):
            mismatch = timing_fields(10, 20, 12, wall_now)
            self.assertTrue(mismatch['timing_discrepancy'])
            self.assertIn('do not attribute', mismatch['timing_note'])


class StreamEngine(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.work = Path(self.tmp.name)
        self.source, self.root = self.work / 'source', self.work / 'data'
        shutil.copytree(ENGINE / 'examples/demo_project', self.source)
        fake = self.work / 'stream-program'
        fake.write_text('#!' + sys.executable + '\n' + STREAM_PROGRAM)
        fake.chmod(0o700)
        permission = self.work / 'permission-fixture.ts'
        permission.write_text('// offline fixture; no actual permission verification\n')
        raw = load_json(ENGINE / 'examples/demo.json')
        raw['source'] = str(self.source)
        raw['limits']['max_wall_seconds'] = 120
        for a in raw['agents'].values():
            a.update(kind='command', argv=[sys.executable, str(PROJECT / 'adapters/pi_member.py'),
                '--model', 'offline/protocol', '--thinking', 'max', '--tools', 'read',
                '--permission-extension', str(permission)], output='stdout',
                inherit_env=['LOOP_PI_BIN', 'PAUSE_SECONDS', 'REPAIR_CYCLE', 'DRIFT_SOURCE'])
        for u in raw['units']:
            u.update(gates=[], max_repairs=1)
            for c in u['criteria']: c['gate_ids'] = []
        self.rid = create_run(self.root, normalize(raw, self.work))
        self.run = self.root / 'runs' / self.rid
        self.env = {'LOOP_PI_BIN': str(fake), 'LOOP_NO_NOTIFY': '1'}

    def test_live_activity_usage_final_receipts_and_sealing(self):
        with patch.dict(os.environ, {**self.env, 'PAUSE_SECONDS': '1.5'}):
            thread = threading.Thread(target=Controller(self.root, self.rid).execute)
            thread.start()
            try:
                until = time.monotonic() + 4
                activity = {}
                while time.monotonic() < until:
                    d = load_json(self.run / 'manifest.json')
                    activity = d['units']['invite'].get('member_activity') or {}
                    if activity.get('phase') == 'tools': break
                    time.sleep(.03)
                self.assertTrue(thread.is_alive())
                self.assertEqual(activity.get('phase'), 'tools')
                self.assertTrue(activity.get('last_event_at'))
                self.assertEqual(activity['tool_calls'][0]['toolCallId'], 'read1')
            finally:
                thread.join(timeout=20)
            self.assertFalse(thread.is_alive())
        d = load_json(self.run / 'manifest.json')
        self.assertEqual(d['result']['stop'], 'PASSED', d['result'])
        self.assertEqual(d['result']['member_invocations'], 2)
        usage = d['result']['member_usage']
        self.assertEqual(usage['assistant_messages'], 4)
        self.assertEqual(usage['tool_calls'], 2)
        self.assertEqual(usage['tokens'], {'input': 20, 'output': 6, 'cache_read': 4, 'cache_write': 0})
        self.assertIsNone(usage['cost'])
        self.assertIsNone(usage['api_requests'])
        self.assertEqual(d['result']['token_usage'], usage['tokens'])
        records = d['units']['invite']['result']['member_observations']
        self.assertEqual(len(records), 2)
        for rec in records.values():
            self.assertIn('wall_elapsed_seconds', rec['receipt'])
            self.assertIn('timing_note', rec['receipt'])
            for name in ('activity.json', 'usage.json', 'pi-events.jsonl', 'pi-stderr.log'):
                rel = str((Path(rec['workspace']) / name).relative_to(self.run.resolve()))
                self.assertIn(rel, d['integrity'])
        self.assertTrue(audit(self.root, self.rid)['integrity_ok'])
        self.assertTrue(export_candidate(self.root, self.rid, self.work / 'export').is_dir())
        first = Path(next(iter(records.values()))['workspace']) / 'usage.json'
        first.chmod(0o600)
        first.write_text('{}')
        self.assertFalse(audit(self.root, self.rid)['integrity_ok'])

    def test_streaming_repairs_keep_comparison_issue_binding_and_counters(self):
        with patch.dict(os.environ, {**self.env, 'REPAIR_CYCLE': '1'}):
            Controller(self.root, self.rid).execute()
        d = load_json(self.run / 'manifest.json')
        self.assertEqual(d['result']['stop'], 'PASSED', d['result'])
        state = d['units']['invite']
        self.assertEqual(state['stats']['member_invocations'], 4)
        self.assertEqual(state['stats']['repairs'], 1)
        self.assertEqual(len(state['result']['history']), 2)
        self.assertEqual(state['result']['history'][0]['review']['criteria'][0]['status'], 'FAIL')
        self.assertTrue(all(x['status'] == 'RESOLVED' for x in state['result']['issue_history']))
        self.assertEqual(d['result']['member_usage']['assistant_messages'], 8)
        self.assertTrue(audit(self.root, self.rid)['integrity_ok'])

    def test_source_drift_with_streaming_blocks_total_not_unit_result(self):
        with patch.dict(os.environ, {**self.env, 'DRIFT_SOURCE': str(self.source)}):
            Controller(self.root, self.rid).execute()
        d = load_json(self.run / 'manifest.json')
        self.assertEqual(d['units']['invite']['result']['stop'], 'PASSED')
        self.assertEqual(d['result']['stop'], 'BLOCKED')
        self.assertEqual(d['result']['finalization']['status'], 'FAIL')
        self.assertEqual(d['result']['member_usage']['tokens']['input'], 20)
        before = (self.run / 'manifest.json').read_bytes()
        with self.assertRaises(run_loop.LoopError): export_candidate(self.root, self.rid, self.work / 'export')
        self.assertEqual((self.run / 'manifest.json').read_bytes(), before)

    def test_cli_status_reads_live_projection_without_model_call(self):
        from loop_engineering.cli import main
        d = load_json(self.run / 'manifest.json')
        d['units']['invite']['member_activity'] = {'phase': 'tools', 'last_event_at': 'event-time',
                                                  'basis': 'tool_execution_start', 'tool_calls': []}
        atomic_json(self.run / 'manifest.json', d)
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(main(['status', self.rid, '--root', str(self.root)]), 0)
        self.assertIn('member_stage=tools', out.getvalue())
        self.assertIn('last_event=event-time', out.getvalue())
