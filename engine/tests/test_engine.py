"""Execution and crash tests. All member processes are deterministic local stubs."""
import copy
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from loop_engineering.adapters import ENGINE_DIR
from loop_engineering.audit import audit,export_candidate
from loop_engineering.common import LoopError,IntegrityError,atomic_json,digest,file_hash,load_json,tree_manifest
from loop_engineering.engine import Controller
from loop_engineering.rules import normalize
from loop_engineering.storage import create_run,notify
from loop_engineering.supervisor import recover

class EngineTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='loop-engine-test-');self.path=Path(self.temp.name)
        self.root=self.path/'data';self.source=self.path/'source'
        shutil.copytree(ENGINE_DIR/'examples/demo_project',self.source)
        self.raw=load_json(ENGINE_DIR/'examples/demo.json');self.raw['source']=str(self.source)
        self.raw['limits'].update(max_wall_seconds=60)
        self.raw['units'][0].update(max_repairs=0,max_protocol_retries=0,max_seconds=55)
        self.mode('dev','success');self.mode('review','success')
    def tearDown(self):self.temp.cleanup()
    def mode(self,role,mode):self.raw['agents'][role]['argv'][-1]=mode
    def execute(self):
        self.rid=create_run(self.root,normalize(self.raw,self.path));self.run=self.root/'runs'/self.rid
        Controller(self.root,self.rid).execute();self.data=load_json(self.run/'manifest.json')
        self.unit=self.data['units'][next(iter(self.data['units']))]
        return self.data['result']['stop']
    def test_first_pass_original_untouched_and_export(self):
        before=digest(tree_manifest(self.source));self.assertEqual(self.execute(),'PASSED')
        self.assertEqual(self.unit['stats']['member_invocations'],2);self.assertEqual(before,digest(tree_manifest(self.source)))
        self.assertTrue(audit(self.root,self.rid)['integrity_ok'])
        out=export_candidate(self.root,self.rid,self.path/'export')
        self.assertIn("status == 'pending'",(out/'invites.py').read_text())
        with self.assertRaises(IntegrityError):export_candidate(self.root,self.rid,out)
    def test_task_notes_and_generated_response_template(self):
        self.raw['notes']='本任务的额外已确认约束：不改变接口。'
        self.assertEqual(self.execute(),'PASSED')
        contexts=[load_json(x) for x in self.run.glob('units/*/attempts/*/context.json')]
        self.assertEqual(len(contexts),2)
        for c in contexts:
            self.assertEqual(c['task_notes'],self.raw['notes'])
            template=load_json(Path(c['response_template_path']))
            self.assertEqual(template['attempt_id'],c['attempt_id'])
            self.assertEqual(template['candidate_hash'],c['candidate_hash'])
            self.assertEqual([r['id'] for r in template['criteria']],['S1','S2'])
            self.assertTrue(all(r['status']=='UNKNOWN' for r in template['criteria']))
    def test_stdout_adapter(self):
        for a in self.raw['agents'].values():a['output']='stdout'
        self.assertEqual(self.execute(),'PASSED')
        for p in self.run.glob('units/*/attempts/*/context.json'):
            c=load_json(p);self.assertEqual(c['adapter_kind'],'command');self.assertEqual(c['output_mode'],'stdout')
    def test_cli_retry_new_run_does_not_overwrite_old(self):
        self.assertEqual(self.execute(),'PASSED');old_hash=file_hash(self.run/'manifest.json')
        p=subprocess.run([sys.executable,str(ENGINE_DIR/'loop.py'),'retry',self.rid,'--root',str(self.root),'--json'],
            capture_output=True,text=True,timeout=30,env={**os.environ,'LOOP_NO_NOTIFY':'1'})
        self.assertEqual(p.returncode,0,p.stderr)
        rid=json.loads(p.stdout)['run_id'];self.assertNotEqual(rid,self.rid)
        new=load_json(self.root/'runs'/rid/'manifest.json')
        self.assertEqual(new['parent_run'],self.rid);self.assertEqual(new['result']['stop'],'PASSED')
        self.assertEqual(new['budget']['member_invocations'],2);self.assertEqual(file_hash(self.run/'manifest.json'),old_hash)
    def test_shared_resources_serialize_units(self):
        self.raw=load_json(ENGINE_DIR/'examples/dag.json');self.raw['source']=str(ENGINE_DIR/'examples/dag_project')
        for u in self.raw['units'][:2]:u['resources']=['one-test-port']
        self.assertEqual(self.execute(),'PASSED')
        events=[json.loads(x) for x in (self.run/'events.jsonl').read_text().splitlines()]
        front_stop=next(i for i,e in enumerate(events) if e['event']=='unit_stopped' and e['unit_id']=='front')
        back_start=next(i for i,e in enumerate(events) if e['event']=='command_started' and e['unit_id']=='back')
        self.assertLess(front_stop,back_start)
    def test_business_repair_count(self):
        self.mode('dev','repair');self.raw['units'][0]['max_repairs']=1
        self.assertEqual(self.execute(),'PASSED');self.assertEqual(self.unit['stats']['repairs'],1)
        self.assertEqual(self.unit['stats']['member_invocations'],4);self.assertEqual(len(self.unit['result']['history']),2)
    def test_exhausted_repairs(self):
        self.mode('dev','always-fail');self.assertEqual(self.execute(),'NOT_MET')
        self.assertEqual(self.unit['result']['criteria'][0]['status'],'FAIL')
    def test_zero_exit_without_delivery(self):
        self.mode('dev','missing');self.assertEqual(self.execute(),'BLOCKED');self.assertTrue((self.run/'result.md').is_file())
    def test_duplicate_row(self):
        self.mode('dev','duplicate');self.assertEqual(self.execute(),'BLOCKED')
    def test_stale_reviewer(self):
        self.mode('review','stale');self.assertEqual(self.execute(),'BLOCKED');self.assertFalse(self.unit['result']['reviewed'])
    def test_gate_beats_model_pass(self):
        self.mode('dev','always-fail');self.mode('review','lie');self.assertEqual(self.execute(),'NOT_MET')
        row=self.unit['result']['criteria'][0];self.assertEqual(row['review_status'],'PASS');self.assertEqual(row['status'],'FAIL')
    def test_missing_gate_is_unknown(self):
        self.raw['units'][0]['gates'][0]['argv']=['loop-no-such-executable']
        self.assertEqual(self.execute(),'BLOCKED');self.assertEqual(self.unit['stats']['member_invocations'],1)
        self.assertEqual(self.unit['result']['criteria'][0]['status'],'UNKNOWN')
    def test_silent_gate_not_member_idle_timeout(self):
        self.raw['units'][0]['idle_output_seconds']=.5
        self.raw['units'][0]['gates'][0]['argv']=['{python}','-c','import time;time.sleep(.7);print("done")']
        self.assertEqual(self.execute(),'PASSED')
    def test_chatty_cannot_extend_timeout(self):
        self.mode('dev','chatty');self.raw['units'][0]['stage_timeout_seconds']=.4
        start=time.monotonic();self.assertEqual(self.execute(),'BLOCKED');self.assertLess(time.monotonic()-start,8)
        self.assertIn('timeout',self.unit['result']['reason'])
    def test_idle_timeout(self):
        self.mode('dev','hang');self.raw['units'][0].update(stage_timeout_seconds=2,idle_output_seconds=.15)
        self.assertEqual(self.execute(),'BLOCKED');self.assertIn('idle_timeout',self.unit['result']['reason'])
    def test_log_limit(self):
        self.mode('dev','logspam');self.raw['limits']['max_log_bytes']=512
        self.assertEqual(self.execute(),'BLOCKED');logs=list(self.run.glob('units/*/attempts/*/job/stdout.log'))
        self.assertTrue(logs);self.assertLessEqual(logs[0].stat().st_size,512)
    def test_scope_boundary_preserves_original(self):
        before=(self.source/'baseline.md').read_text();self.mode('dev','boundary')
        self.assertEqual(self.execute(),'BLOCKED');self.assertEqual((self.source/'baseline.md').read_text(),before)
        self.assertIn('范围外',self.unit['result']['reason'])
    def test_rule_tamper(self):
        self.mode('dev','tamper-rule');self.assertEqual(self.execute(),'BLOCKED')
        self.assertIn('冻结文件',self.unit['result']['reason'])
    def test_reviewer_mutation(self):
        self.mode('review','mutate-review');self.assertEqual(self.execute(),'BLOCKED');self.assertIn('只读评审',self.unit['result']['reason'])
    def test_format_repair_separate_from_business(self):
        self.mode('dev','format');self.raw['units'][0]['max_protocol_retries']=1
        self.assertEqual(self.execute(),'PASSED');self.assertEqual(self.unit['stats']['protocol_retries'],1)
        self.assertEqual(self.unit['stats']['repairs'],0);self.assertEqual(self.unit['stats']['member_invocations'],3)
    def test_infra_retry_separate(self):
        self.mode('dev','once-exit');self.raw['units'][0]['max_infra_retries']=1
        self.assertEqual(self.execute(),'PASSED');self.assertEqual(self.unit['stats']['infra_retries'],1);self.assertEqual(self.unit['stats']['repairs'],0)
    def test_call_budget(self):
        self.raw['limits']['max_member_invocations']=1;self.assertEqual(self.execute(),'NOT_MET')
        self.assertEqual(self.data['budget']['member_invocations'],1);self.assertFalse(self.unit['result']['reviewed'])
    def test_context_limit_not_silent_truncation(self):
        self.raw['limits']['max_context_bytes']=64;self.assertEqual(self.execute(),'BLOCKED')
        self.assertEqual(self.data['budget']['member_invocations'],0);self.assertIn('上下文',self.unit['result']['reason'])
    def test_blocking_gap(self):
        self.mode('dev','gap');self.assertEqual(self.execute(),'NOT_MET');self.assertTrue(self.unit['result']['rule_gaps'])
    def test_unknown_not_pass(self):
        self.mode('review','unknown');self.assertEqual(self.execute(),'NOT_MET');self.assertEqual(self.unit['result']['criteria'][1]['status'],'UNKNOWN')
    def test_gate_cannot_modify_tests(self):
        self.raw['units'][0]['gates'][0]['argv']=['{python}','-c',"from pathlib import Path;Path('tests/test_invites.py').write_text('')"]
        self.assertEqual(self.execute(),'BLOCKED');self.assertIn('验收资产',self.unit['result']['reason'])
    def test_candidate_tamper_audit_and_export(self):
        self.assertEqual(self.execute(),'PASSED');f=Path(self.unit['result']['candidate']['path'])/'invites.py'
        f.chmod(0o600);f.write_text('changed=True\n');self.assertFalse(audit(self.root,self.rid)['integrity_ok'])
        with self.assertRaises(IntegrityError):export_candidate(self.root,self.rid,self.path/'export')
    def test_terminal_recovery_immutable(self):
        self.assertEqual(self.execute(),'PASSED');before=file_hash(self.run/'manifest.json');(self.run/'result.md').unlink()
        self.assertEqual(recover(self.root,self.rid)['stop'],'PASSED')
        self.assertEqual(before,file_hash(self.run/'manifest.json'));self.assertTrue((self.run/'result.md').exists())
    def test_notification_failure_separate(self):
        self.assertEqual(self.execute(),'PASSED');before=file_hash(self.run/'manifest.json')
        with patch.dict(os.environ,{'LOOP_NO_NOTIFY':'0'}),patch('loop_engineering.storage.subprocess.run',side_effect=FileNotFoundError('no desktop')):
            notify(self.root,self.rid)
        self.assertFalse(load_json(self.run/'notification.json')['delivered']);self.assertEqual(before,file_hash(self.run/'manifest.json'))
    def test_initial_orphan_result(self):
        rid=create_run(self.root,normalize(self.raw,self.path));self.assertEqual(recover(self.root,rid)['stop'],'BLOCKED')
        d=load_json(self.root/'runs'/rid/'manifest.json')
        self.assertEqual([r['id'] for r in d['units']['invite']['result']['criteria']],['S1','S2'])
    def test_source_symlink_has_failure_result(self):
        (self.source/'outside').symlink_to('/etc/passwd');self.assertEqual(self.execute(),'BLOCKED');self.assertTrue((self.run/'result.md').is_file())
    def test_dag_parallel_and_integration(self):
        self.raw=load_json(ENGINE_DIR/'examples/dag.json');self.raw['source']=str(ENGINE_DIR/'examples/dag_project')
        self.assertEqual(self.execute(),'PASSED');c=self.data['units']['integration']['result']['candidate']
        self.assertIn('invite_code',(Path(c['path'])/'frontend.py').read_text())
        events=[json.loads(x) for x in (self.run/'events.jsonl').read_text().splitlines()]
        self.assertEqual({e['unit_id'] for e in [e for e in events if e['event']=='command_started'][:2]},{'front','back'})
    def test_integration_failure_not_overridden_by_unit_passes(self):
        self.raw=load_json(ENGINE_DIR/'examples/dag.json');source=self.path/'dag'
        shutil.copytree(ENGINE_DIR/'examples/dag_project',source)
        f=source/'tests/check_unit.py';f.write_text(f.read_text().replace("accept({'invite_code': 'ABC'})","accept({'token': 'ABC'})"))
        self.raw['source']=str(source)
        for a in self.raw['agents'].values():a['argv'][-1]='dag-bad'
        self.assertEqual(self.execute(),'NOT_MET')
        self.assertEqual(self.data['units']['front']['result']['stop'],'PASSED')
        self.assertEqual(self.data['units']['back']['result']['stop'],'PASSED')
        self.assertEqual(self.data['units']['integration']['result']['stop'],'NOT_MET')
    def test_dependency_failure_leaves_independent_work(self):
        self.raw=load_json(ENGINE_DIR/'examples/dag.json');self.raw['source']=str(ENGINE_DIR/'examples/dag_project')
        self.raw['agents']['baddev']=copy.deepcopy(self.raw['agents']['dev']);self.raw['agents']['baddev']['identity']='bad-front'
        self.raw['agents']['baddev']['argv'][-1]='exit';self.raw['units'][0]['developer']='baddev'
        self.assertEqual(self.execute(),'BLOCKED');self.assertEqual(self.data['units']['back']['result']['stop'],'PASSED')
        self.assertEqual(self.data['units']['integration']['result']['stop'],'NOT_RUN')

class SupervisionTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='loop-supervision-');self.path=Path(self.temp.name);self.root=self.path/'data';self.processes=[]
        r=load_json(ENGINE_DIR/'examples/demo.json');r['source']=str(ENGINE_DIR/'examples/demo_project')
        r['agents']['dev']['argv'][-1]='hang';r['units'][0].update(stage_timeout_seconds=20,max_seconds=40,max_protocol_retries=0)
        r['limits']['max_wall_seconds']=45;self.rules=normalize(r,self.path)
    def tearDown(self):
        for p in self.processes:
            if p.poll() is None:
                p.terminate()
                try:p.wait(timeout=12)
                except subprocess.TimeoutExpired:p.kill();p.wait(timeout=3)
        self.temp.cleanup()
    def start(self):
        rid=create_run(self.root,self.rules);self.run=self.root/'runs'/rid
        with (self.path/'log').open('wb') as log:
            p=subprocess.Popen([sys.executable,str(ENGINE_DIR/'loop.py'),'_supervise',rid,'--root',str(self.root)],stdout=log,stderr=log,env={**os.environ,'LOOP_NO_NOTIFY':'1'})
        self.processes.append(p);until=time.monotonic()+15
        while time.monotonic()<until:
            jobs=list(self.run.glob('units/*/attempts/*/job/process.json'))
            if jobs:return rid,p,load_json(jobs[0])
            if p.poll() is not None:self.fail((self.path/'log').read_text())
            time.sleep(.1)
        self.fail('member not started')
    def test_corrupt_rules_before_worker_start_still_get_result(self):
        rid=create_run(self.root,self.rules);run=self.root/'runs'/rid
        rules=run/'rules.json';rules.chmod(0o600);rules.write_text('not json')
        p=subprocess.run([sys.executable,str(ENGINE_DIR/'loop.py'),'_supervise',rid,'--root',str(self.root)],
            capture_output=True,text=True,timeout=20,env={**os.environ,'LOOP_NO_NOTIFY':'1'})
        self.assertEqual(p.returncode,3,p.stderr)
        d=load_json(run/'manifest.json');self.assertEqual(d['result']['stop'],'BLOCKED')
        self.assertEqual([r['id'] for r in d['units']['invite']['result']['criteria']],['S1','S2'])
        self.assertTrue((run/'result.md').is_file())
    def test_worker_kill_auto_recovery(self):
        rid,p,child=self.start();os.kill(load_json(self.run/'worker.json')['pid'],signal.SIGKILL);p.wait(timeout=15)
        d=load_json(self.run/'manifest.json');self.assertEqual(d['state'],'TERMINAL');self.assertEqual(d['result']['stop'],'BLOCKED')
        self.assertTrue((self.run/'result.md').exists());receipts=list(self.run.glob('units/*/attempts/*/job/receipt.json'))
        self.assertTrue(receipts);self.assertIn(load_json(receipts[0])['reason'],('controller_lost','cancelled'))
    def test_recover_refuses_live_owner(self):
        rid,p,child=self.start()
        with self.assertRaises(LoopError):recover(self.root,rid)
        atomic_json(self.run/'cancel',{'reason':'test end'});p.wait(timeout=15)
        self.assertEqual(load_json(self.run/'manifest.json')['result']['stop'],'BLOCKED')
    def test_manual_recovery_after_both_killed(self):
        rid,p,child=self.start();worker=load_json(self.run/'worker.json')['pid'];p.kill();p.wait(timeout=3)
        os.kill(worker,signal.SIGKILL);time.sleep(.5)
        self.assertEqual(recover(self.root,rid)['stop'],'BLOCKED');self.assertTrue((self.run/'report.html').exists())
