import copy,concurrent.futures,importlib.util,json,os,subprocess,sys,tempfile,unittest
from pathlib import Path
from unittest import mock
from helpers import *
from loop_engineering.common import LoopError,digest
from loop_engineering.guard_server import dispatch
from loop_engineering.admission import verify_run
from loop_guard import launch_prepared

class Preparation(unittest.TestCase):
    def setUp(self):
        self.t=tempfile.TemporaryDirectory();self.addCleanup(self.t.cleanup);self.base=Path(self.t.name)
        self.raw=project(self.base)
        self.state,self.root,self.d=prepared(self.base,self.raw)
    def test_prepare_never_runs_command_by_default(self):
        with mock.patch('subprocess.Popen',side_effect=AssertionError('unexpected execution')):
            c=prep.check(self.state,self.d['id'],1);s=prep.seal(self.state,self.d['id'],1)
        self.assertEqual(c['status'],'READY');self.assertIn('launch',s['launch_command'])
    def test_check_same_revision_cache(self):
        a=prep.check(self.state,self.d['id'],1);b=prep.check(self.state,self.d['id'],1)
        self.assertFalse(a['cached']);self.assertTrue(b['cached']);self.assertEqual(a['checked_at'],b['checked_at'])
    def test_all_gate_conflicts_reported_before_paid_work(self):
        raw=copy.deepcopy(self.d['rules']['units']);raw[0]['gates'][0]['output_paths']=[]
        x=copy.deepcopy(raw[0]);x['id']='other';raw.append(x)
        d=prep.patch(self.state,self.d['id'],1,{'units':raw,'completion':{'mode':'independent'}})
        c=prep.check(self.state,d['id'],d['revision'])
        self.assertEqual(c['status'],'INVALID');self.assertEqual({i.get('unit') for i in c['issues'] if i.get('unit')},{'check','other'})
    def test_cannot_change_profiles_or_tools(self):
        with self.assertRaises(LoopError):prep.patch(self.state,self.d['id'],1,{'execution_profiles':{}})
        with self.assertRaises(LoopError):prep.patch(self.state,self.d['id'],1,{'agents':{}})
    def test_cannot_expand_budget(self):
        limits=copy.deepcopy(self.d['rules']['limits']);limits['max_wall_seconds']+=1
        with self.assertRaises(LoopError):prep.patch(self.state,self.d['id'],1,{'limits':limits})
    def test_cannot_expand_writable_source(self):
        units=copy.deepcopy(self.d['rules']['units']);units[0]['writable_paths']=['module/']
        with self.assertRaises(LoopError):prep.patch(self.state,self.d['id'],1,{'units':units})
    def test_revision_conflict_and_sealed_cannot_edit(self):
        with self.assertRaises(LoopError):prep.patch(self.state,self.d['id'],2,{'title':'x'})
        prep.seal(self.state,self.d['id'],1)
        with self.assertRaises(LoopError):prep.patch(self.state,self.d['id'],1,{'title':'x'})
    def test_source_changed_after_seal_rejected_before_creation(self):
        s=prep.seal(self.state,self.d['id'],1);(Path(self.raw['source'])/'value.txt').write_text('changed')
        aid=Ledger(self.state).authorize('p',maxima_for(s['rules']))
        with self.assertRaises(LoopError):create_run(self.root,s['rules'],admission={'state':str(self.state),'prepared_id':s['id'],'authorization_id':aid})
        self.assertEqual(Ledger(self.state).authorization(aid)['used'],{})
    def test_rules_tampering_rejected(self):
        s=prep.seal(self.state,self.d['id'],1);changed=copy.deepcopy(s['rules']);changed['title']='other'
        aid=Ledger(self.state).authorize('p',maxima_for(s['rules']))
        with self.assertRaises(LoopError):create_run(self.root,changed,admission={'state':str(self.state),'prepared_id':s['id'],'authorization_id':aid})
    def test_installation_change_rejected(self):
        s=prep.seal(self.state,self.d['id'],1);aid=Ledger(self.state).authorize('p',maxima_for(s['rules']))
        with mock.patch('loop_engineering.admission.installation_identity',return_value={'sha256':'other'}):
            with self.assertRaises(LoopError):create_run(self.root,s['rules'],admission={'state':str(self.state),'prepared_id':s['id'],'authorization_id':aid})
    def test_all_direct_v2_creation_without_admission_refused(self):
        with self.assertRaises(LoopError):create_run(self.root,normalize(self.raw,self.base))
    def test_managed_root_rejects_v1_bypass(self):
        r={'schema_version':1,'task_id':'old','source':self.raw['source']}
        with self.assertRaises(LoopError):create_run(self.root,r)
    def test_duplicate_launch_claim_has_one_run(self):
        rid,s,aid=create_prepared_run(self.state,self.root,self.d)
        other=create_run(self.root,s['rules'],admission={'state':str(self.state),'prepared_id':s['id'],'authorization_id':aid})
        self.assertEqual(rid,other);self.assertEqual(len(list((self.root/'runs').iterdir())),1)
    def test_duplicate_cli_launch_does_not_supervise(self):
        rid,s,aid=create_prepared_run(self.state,self.root,self.d)
        with mock.patch('loop_engineering.supervisor.supervise',side_effect=AssertionError('restarted')):
            self.assertEqual(launch_prepared(self.state,s['id'],approve=True),0)
    def test_mcp_has_no_launch_approve_or_shell(self):
        for name in ('launch','approve','authorize','shell','create_run','run'):
            with self.assertRaises(LoopError):dispatch(self.state,{'method':name,'args':{}})
    def test_invalid_rpc_keys_and_traversal_ids(self):
        with self.assertRaises(LoopError):dispatch(self.state,{'method':'loop_prepare_check','args':{'prep_id':'../../bad','revision':1}})
        with self.assertRaises(LoopError):dispatch(self.state,{'method':'loop_prepare_patch','args':{'prep_id':self.d['id'],'revision':1,'changes':{},'argv':['sh']}})
    def test_project_read_rejects_links_and_secrets(self):
        src=Path(self.raw['source']);(src/'leak').symlink_to('/etc/passwd');(src/'.env').write_text('secret')
        for path in ('../file','leak','.env'):
            with self.assertRaises(LoopError):dispatch(self.state,{'method':'loop_project_read','args':{'project_id':'p','path':path,'start_line':1,'max_lines':20}})
    def test_no_arbitrary_probe_after_ready(self):
        prep.check(self.state,self.d['id'],1)
        with self.assertRaises(LoopError):prep.probe(self.state,self.d['id'],1,'profile:test')
    def test_profile_output_compiled_once_for_all_stages(self):
        r=normalize(self.raw,self.base);self.assertIn('module/target/',r['exclude_paths'])
        self.assertEqual(r['units'][0]['gates'][0]['output_paths'],['module/target/'])
        self.assertEqual(normalize(r,self.base),r)

class Probe(unittest.TestCase):
    def test_probe_uses_frozen_input_not_fake_exclusion_at_delivery(self):
        with tempfile.TemporaryDirectory() as t:
            base=Path(t);raw=project(base);src=Path(raw['source']);(src/'module/target').mkdir();(src/'module/target/old').write_text('old')
            state,root,d=prepared(base,raw,require_probes=['test'])
            c=prep.check(state,d['id'],1);self.assertTrue(any(x.get('question_id')=='profile:test' for x in c['issues']))
            r=prep.probe(state,d['id'],1,'profile:test');self.assertTrue(r['environment_valid'],r)
            self.assertEqual((src/'module/target/old').read_text(),'old')
            self.assertEqual(prep.check(state,d['id'],1)['status'],'READY')
            with self.assertRaises(LoopError):prep.probe(state,d['id'],1,'profile:test')

class Budget(unittest.TestCase):
    def test_concurrent_claim_and_reservation(self):
        with tempfile.TemporaryDirectory() as t:
            ledger=Ledger(Path(t));aid=ledger.authorize('p',{'member_invocations':1});binding={'x':1}
            def claim(i):return Ledger(Path(t)).claim('req',aid,'p','/exact-root','rid-'+str(i),binding)
            with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:rs=list(pool.map(claim,range(8)))
            self.assertEqual(sum(x[1] for x in rs),1);rid=rs[0][0]['run_id']
            def reserve(i):return Ledger(Path(t)).reserve_many(aid,['member_invocations'],'op-'+str(i),rid)
            with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:rs=list(pool.map(reserve,range(8)))
            self.assertEqual(sum(rs),1)
    def test_new_run_same_authorization_does_not_reset(self):
        with tempfile.TemporaryDirectory() as t:
            ledger=Ledger(Path(t));aid=ledger.authorize('p',{'member_invocations':1})
            ledger.claim('r1',aid,'p','/root','run1',{});self.assertTrue(ledger.reserve_many(aid,['member_invocations'],'first','run1'))
            ledger.claim('r2',aid,'p','/root','run2',{});self.assertFalse(ledger.reserve_many(aid,['member_invocations'],'second','run2'))
    def test_reservation_idempotence_and_cross_run_conflict(self):
        with tempfile.TemporaryDirectory() as t:
            l=Ledger(Path(t));a=l.authorize('p',{'gates':1});l.claim('r',a,'p','/root','run',{})
            self.assertTrue(l.reserve_many(a,['gates'],'op','run'));self.assertTrue(l.reserve_many(a,['gates'],'op','run'))
            l.claim('r2',a,'p','/root','run2',{})
            with self.assertRaises(LoopError):l.reserve_many(a,['gates'],'op','run2')
            self.assertEqual(l.authorization(a)['used']['gates'],1)

if __name__=='__main__':unittest.main()
