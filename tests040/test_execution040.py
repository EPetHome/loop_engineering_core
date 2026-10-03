import copy,json,os,sys,tempfile,time,unittest
from pathlib import Path
from helpers import *
from loop_engineering.common import tree_manifest,digest,LoopError
from loop_engineering.execution import execute_recipe,inspect_developer_delivery,sandbox_command
from loop_engineering.audit import audit,export_candidate

class BuildContract(unittest.TestCase):
    def setUp(self):
        self.t=tempfile.TemporaryDirectory();self.addCleanup(self.t.cleanup);self.base=Path(self.t.name)
        self.raw=project(self.base);self.r=normalize(self.raw,self.base);self.src=Path(self.r['source']);self.manifest=tree_manifest(self.src)
    def build(self,name='build',**kw):
        return execute_recipe(self.src,self.manifest,self.r['execution_profiles']['test'],self.base/name,self.r['limits'],
                purpose='SELF_TEST',security='audit-only',deadline=time.time()+30,cancel_file=self.base/'cancel',**kw)
    def test_initial_and_repair_builds_never_pollute_delivery(self):
        first=self.build('first');self.assertEqual(first['status'],'PASS')
        self.assertFalse((self.src/'module/target').exists())
        (self.src/'value.txt').write_text('repaired');self.manifest=tree_manifest(self.src)
        second=self.build('repair');self.assertEqual(second['status'],'PASS')
        self.assertNotEqual(first['candidate_hash'],second['candidate_hash'])
        self.assertFalse((self.src/'module/target').exists())
    def test_shared_delivery_has_no_excludes_override(self):
        (self.src/'module/target').mkdir();(self.src/'module/target/x').write_text('artifact')
        unit={'writable_paths':['module/','value.txt'],'protected_paths':[],'build_profiles':['test']}
        with self.assertRaises(LoopError):inspect_developer_delivery(self.src,self.manifest,unit,self.r['limits'],self.r['execution_profiles'])
        with self.assertRaises(TypeError):inspect_developer_delivery(self.src,self.manifest,unit,self.r['limits'],exclude_paths=['module/target/'])
    def test_zero_exit_source_mutation_still_rejected(self):
        (self.src/'build.py').write_text(BUILD+"Path('value.txt').write_text('illegal')\n");self.manifest=tree_manifest(self.src)
        x=self.build();self.assertEqual(x['reason'],'output_violation');self.assertEqual((self.src/'value.txt').read_text(),'initial')
    def test_undeclared_output_is_not_automatically_whitelisted(self):
        (self.src/'build.py').write_text(BUILD+"Path('unexpected.txt').write_text('x')\n");self.manifest=tree_manifest(self.src)
        self.assertEqual(self.build()['reason'],'output_violation')
    def test_existing_output_in_candidate_rejected_before_command(self):
        (self.src/'module/target').mkdir();(self.src/'module/target/a').write_text('old');self.manifest=tree_manifest(self.src)
        self.assertEqual(self.build()['reason'],'config_error');self.assertFalse((self.base/'build/job').exists())
    def test_missing_required_report_is_not_pass(self):
        (self.src/'build.py').write_text("print('0 tests')\n");self.manifest=tree_manifest(self.src)
        self.assertEqual(self.build()['status'],'UNKNOWN')
    def test_report_cap_separate_from_diagnostic_cap(self):
        self.r['limits']['max_log_bytes']=20;self.r['limits']['max_evidence_bytes']=2
        self.assertEqual(self.build()['reason'],'evidence_limit')
    def test_build_byte_limit_cannot_hide_in_source_excludes(self):
        self.r['limits']['max_build_bytes']=5
        self.assertEqual(self.build()['reason'],'build_limit')
    def test_cancel_before_exec_has_no_command_receipt(self):
        (self.base/'cancel').write_text('cancel')
        self.assertEqual(self.build()['reason'],'cancelled');self.assertFalse((self.base/'build/job/receipt.json').exists())
    def test_strict_mode_does_not_silently_fall_back(self):
        if sys.platform=='darwin':self.skipTest('Linux-only unavailable path')
        with self.assertRaises(LoopError):sandbox_command([sys.executable], [self.base], network=False,mode='strict')

class EndToEnd(unittest.TestCase):
    def setUp(self):
        self.t=tempfile.TemporaryDirectory();self.addCleanup(self.t.cleanup);self.base=Path(self.t.name)
    def test_work_repair_selftests_gates_and_finalization(self):
        m,state,root,s,aid=execute_prepared(self.base,project(self.base,True,True))
        self.assertEqual(m['result']['stop'],'PASSED',m['result'])
        self.assertEqual(m['budget']['member_invocations'],4)
        self.assertEqual(m['budget']['selftests'],2)
        self.assertEqual(m['budget']['gate_executions'],2)
        self.assertEqual(m['budget']['repairs'],1)
        self.assertEqual(m['result']['finalization']['status'],'PASS')
        candidate=Path(m['units']['check']['result']['candidate']['path'])
        self.assertEqual((candidate/'value.txt').read_text(),'fixed-round-2')
        self.assertFalse((candidate/'module/target').exists())
        self.assertTrue(audit(root,m['run_id'])['integrity_ok'])
        self.assertEqual(Ledger(state).authorization(aid)['used']['selftests'],2)
        dest=export_candidate(root,m['run_id'],self.base/'export');self.assertTrue((dest/'value.txt').is_file())
    def test_verify_only_zero_developers_and_no_fake_review(self):
        m,state,root,s,aid=execute_prepared(self.base,project(self.base))
        self.assertEqual(m['result']['stop'],'PASSED',m['result']);self.assertEqual(m['budget']['member_invocations'],0)
        self.assertFalse(m['units']['check']['result']['reviewed'])
        self.assertEqual(m['units']['check']['result']['verification_mode'],'gates')
        self.assertTrue(audit(root,m['run_id'])['integrity_ok'])
    def test_c06_failure_stops_dependents_without_repair(self):
        raw=project(self.base,failed_verify=True)
        first=raw['units'][0];first['id']='C06';first['gates']=[{'id':'G','profile':'fail','budget_key':'C06'}]
        second=copy.deepcopy(first);second.update(id='seven',depends_on=['C06'],input_from='C06');second['gates']=[{'id':'G','profile':'test'}]
        raw['units'].append(second);raw['completion']={'mode':'integration','unit':'seven'}
        m,state,root,s,aid=execute_prepared(self.base,raw)
        self.assertEqual(m['units']['C06']['result']['stop'],'NOT_MET',m)
        self.assertEqual(m['units']['seven']['result']['stop'],'NOT_RUN')
        self.assertEqual(m['budget']['member_invocations'],0)
        self.assertEqual(Ledger(state).authorization(aid)['used']['operation:C06'],1)
    def test_verify_chain_uses_exact_input_candidate(self):
        raw=project(self.base,True)
        raw['units'][0]['id']='repair'
        v={'id':'check','kind':'verify','review_mode':'gates','goal':'check repaired candidate','depends_on':['repair'],'input_from':'repair',
           'criteria':[{'id':'C','text':'test','gate_ids':['G']}],'gates':[{'id':'G','profile':'test'}]}
        raw['units'].append(v);raw['completion']={'mode':'integration','unit':'check'}
        m,state,root,s,aid=execute_prepared(self.base,raw)
        self.assertEqual(m['result']['stop'],'PASSED',m['result'])
        self.assertEqual(m['units']['repair']['result']['candidate']['hash'],m['units']['check']['result']['candidate']['hash'])
        self.assertEqual(m['budget']['member_invocations'],2)
    def test_tampered_gate_report_prevents_export(self):
        m,state,root,s,aid=execute_prepared(self.base,project(self.base))
        receipt=next((root/'runs'/m['run_id']).rglob('build-receipt.json'));receipt.chmod(0o600);receipt.write_text('{}')
        self.assertFalse(audit(root,m['run_id'])['integrity_ok'])
        with self.assertRaises(LoopError):export_candidate(root,m['run_id'],self.base/'out')

if __name__=='__main__':unittest.main()
