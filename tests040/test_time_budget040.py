"""Time/round-budget counterexamples from wbhost-r3 and 49f48e0a; no real models."""
import json, math, os, shutil, subprocess, tempfile, unittest
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest import mock
from helpers import BUNDLE, BUILD, Controller, create_prepared_run, normalize, prep, prepared, project
from loop_engineering.common import LoopError, tree_manifest
from loop_engineering.engine import Stop, UnitEngine, repair_time_reserve
from loop_engineering.member_service import MemberService
from loop_engineering.capabilities import round_selftest_cap, unit_selftest_cap
from loop_engineering.audit import audit


class Clock:
    def __init__(self, value:float=0): self.value=value
    def __call__(self): return self.value
    def advance(self, seconds): self.value+=seconds


class TimeWarnings(unittest.TestCase):
    def test_real_plan_shapes_warn_without_blocking_and_show_round_shares(self):
        for seconds,stage in ((7200,3600),(10800,5400)):
            with self.subTest(seconds=seconds), tempfile.TemporaryDirectory() as t:
                base=Path(t);raw=project(base,True)
                raw['units'][0].update(max_seconds=seconds,stage_timeout_seconds=stage,max_repairs=2,max_selftests=20)
                raw['limits'].update(max_selftests=20,max_wall_seconds=20000)
                state,root,d=prepared(base,raw)
                checks=prep.check(state,d['id'],1)
                expected=(f'单元 check 的时限 {seconds} 秒，按阶段时限 {stage} 秒算最多只够约 2 轮开发，'
                          f'返修上限 2 次可能用不满；建议把单元时限至少调到 {3*stage}，或者调低阶段时限')
                self.assertEqual(checks['status'],'READY');self.assertIn(expected,checks['warnings'])
                preview=Path(prep.seal(state,d['id'],1)['preview_path']).read_text()
                self.assertIn(expected,preview)
                self.assertIn('时限可容纳约 2 轮（按阶段时限）',preview)
                self.assertIn('自测：单元 20 次，按 3 轮累计分配（7 / 14 / 20）',preview)

    def test_sufficient_time_and_verify_do_not_warn(self):
        unit={'id':'u','developer':'dev','max_seconds':10800,'stage_timeout_seconds':3600,'max_repairs':2}
        self.assertEqual(prep.time_warnings({'units':[unit]}),[])
        unit['max_seconds']=1;unit['developer']=None
        self.assertEqual(prep.time_warnings({'units':[unit]}),[])

    def test_preview_uses_existing_per_unit_share_and_zero_repairs(self):
        with tempfile.TemporaryDirectory() as t:
            base=Path(t);rules=normalize(project(base,True),base);first=rules['units'][0]
            first['max_repairs']=0
            rules['units'].append(dict(first,id='other'))
            text=prep.render_preview(rules,rules,base/'rules.json')
            self.assertEqual(text.count('自测：单元 3 次，按 1 轮累计分配（3）'),2)
            self.assertEqual(unit_selftest_cap(rules,first),3)


class RepairTimeDecision(unittest.TestCase):
    def setUp(self):
        self.timing={'developer_seconds':3300,'gate_seconds':0,'review_seconds':630}

    def test_wbhost_has_time_to_start_but_not_fifty_minutes_to_develop(self):
        reserve=repair_time_reserve(7200,self.timing,current=3930)
        self.assertEqual(reserve,788)
        self.assertEqual(7200-reserve-3930,2482)

    def test_shortage_reports_all_three_minute_values(self):
        with self.assertRaises(Stop) as e: repair_time_reserve(6000,self.timing,current=3930)
        self.assertEqual(e.exception.stop,'NOT_MET')
        self.assertEqual(e.exception.reason,'时间不够返修：剩余 34.5 分钟，扣除门禁和复审预留 13.1 分钟后，'
                         '不足上一轮开发用时的一半（27.5 分钟）；未开始返修，保留当前候选和问题清单')

    def test_half_developer_boundary_and_reserve_ceiling(self):
        timing={'developer_seconds':20,'gate_seconds':1.1,'review_seconds':2.1}
        reserve=math.ceil(3.2*1.25)
        self.assertEqual(repair_time_reserve(10+reserve,timing,current=0),reserve)
        with self.assertRaises(Stop): repair_time_reserve(9.9+reserve,timing,current=0)

    def test_no_developer_only_requires_positive_available_time(self):
        timing={'developer_seconds':0,'gate_seconds':2,'review_seconds':2}
        self.assertEqual(repair_time_reserve(5.1,timing,current=0),5)
        for deadline in (5,4,0):
            with self.subTest(deadline=deadline), self.assertRaises(Stop):
                repair_time_reserve(deadline,timing,current=0)


class RoundSelftests(unittest.TestCase):
    def setUp(self):
        self.t=tempfile.TemporaryDirectory();self.addCleanup(self.t.cleanup);self.base=Path(self.t.name)
        self.rules=normalize(project(self.base,True),self.base);self.unit=self.rules['units'][0]
        self.unit.update(max_repairs=2,max_selftests=20,writable_paths=['value.txt','gone.txt','copies/'])
        self.rules['limits']['max_selftests']=20
        code=Path(self.rules['source']);(code/'gone.txt').write_text('remove me')
        self.used={'selftests':0}
        store=SimpleNamespace(data={'units':{'check':{'stats':self.used}}},run=self.base,
                              assert_integrity=mock.Mock(),reserve_operation=mock.Mock(return_value=True),
                              counter=mock.Mock(side_effect=lambda uid,key:self.used.update({key:self.used.get(key,0)+1})),
                              event=mock.Mock(),seal=mock.Mock())
        self.owner=SimpleNamespace(rules=self.rules,unit=self.unit,uid='check',limits=self.rules['limits'],store=store,
                                  input_manifest=tree_manifest(code),workspace=self.base/'workspace',round=1,
                                  deadline=1000,developer_deadline=100.9,check_time=mock.Mock(),quota_specs=lambda:[])
        self.context={'role':'developer','protocol_repair_only':False,'attempt_id':'a','run_id':'r','unit_id':'check'}
        self.service=MemberService(self.owner,self.context,code,self.owner.input_manifest)
        self.clock=Clock(50.2)
        patch=mock.patch('loop_engineering.member_service.time.time',self.clock);patch.start();self.addCleanup(patch.stop)
        patch=mock.patch('loop_engineering.member_service.execute_recipe',return_value={
            'status':'PASS','reason':'ok','candidate_hash':'h'})
        self.executor=patch.start();self.addCleanup(patch.stop)
        self.calls=0

    def build(self,request_id=None):
        self.calls+=1
        return self.service.dispatch({'method':'build','recipe_id':'test','request_id':request_id or str(self.calls)})

    def test_round_cap_is_cumulative_and_preserves_unit_total(self):
        self.assertEqual([round_selftest_cap(self.rules,self.unit,r) for r in (1,2,3,4)],[7,14,20,20])
        self.assertEqual(unit_selftest_cap(self.rules,self.unit),20)
        self.unit.pop('max_selftests');self.rules['limits']['max_selftests']=5
        self.rules['units'].append(dict(self.unit,id='later'))
        self.assertEqual([round_selftest_cap(self.rules,self.unit,r) for r in (1,2,3)],[1,2,3])

    def test_eighth_first_round_build_is_rejected_before_run_reservation(self):
        for _ in range(7): self.build()
        with self.assertRaises(LoopError) as e: self.build()
        self.assertEqual(str(e.exception),'本轮自测额度已用完（本单元已用 7 次，到第 1 轮累计可用 7 次，总额度 20 次），'
                         '剩余额度留给后续返修；请直接交付，由正式门禁检查')
        self.assertEqual(self.owner.store.reserve_operation.call_count,7)
        self.assertEqual(self.executor.call_count,7);self.assertEqual(self.used['selftests'],7)

    def test_unused_quota_rolls_forward_to_fourteen_then_twenty(self):
        for _ in range(3): self.build()
        self.owner.round=2
        for _ in range(11): self.build()
        self.assertEqual(self.used['selftests'],14)
        with self.assertRaisesRegex(LoopError,'第 2 轮累计可用 14 次'): self.build()
        self.owner.round=3
        for _ in range(6): self.build()
        with self.assertRaisesRegex(LoopError,'累计可用 20 次'): self.build()
        self.assertEqual(self.used['selftests'],20)
        for call in self.owner.store.reserve_operation.call_args_list:
            self.assertEqual(call.args[2],20)  # run-level total unchanged

    def test_no_repairs_allows_all_twenty_in_round_one(self):
        self.unit['max_repairs']=0
        for _ in range(20): self.build()
        with self.assertRaisesRegex(LoopError,'第 1 轮累计可用 20 次'): self.build()
        self.assertEqual(self.used['selftests'],20)

    def test_run_budget_is_still_required_after_round_budget(self):
        self.owner.store.reserve_operation.return_value=False
        with self.assertRaisesRegex(LoopError,'self-test budget exhausted'): self.build()
        self.assertEqual(self.used['selftests'],0);self.executor.assert_not_called()

    def test_all_developer_tool_receipts_and_replayed_build_show_current_seconds(self):
        replies=[self.build('same'),self.service.dispatch({'method':'submit_check'}),
                 self.service.dispatch({'method':'delete','paths':['gone.txt']}),
                 self.service.dispatch({'method':'copy','source':'value.txt','targets':['copies/x.txt']})]
        for reply in replies:
            self.assertEqual(reply['seconds_left'],50);self.assertIs(type(reply['seconds_left']),int)
        self.clock.advance(25)
        self.assertEqual(self.build('same')['seconds_left'],25)
        self.assertEqual(self.used['selftests'],1);self.executor.assert_called_once()
        self.clock.advance(100)
        self.assertEqual(self.service.dispatch({'method':'submit_check'})['seconds_left'],0)

    def test_nested_selftest_cannot_keep_running_into_review_reserve(self):
        self.build()
        self.assertEqual(self.executor.call_args.kwargs['deadline'],self.owner.developer_deadline)
        self.assertEqual(self.owner.deadline,1000)
        self.assertEqual(self.executor.call_args.args[2],self.rules['execution_profiles']['test'])

    def test_failed_build_receipt_also_has_seconds_left(self):
        self.executor.return_value={'status':'FAIL','reason':'nonzero_exit','candidate_hash':'h'}
        self.assertEqual(self.build()['seconds_left'],50)


class TimedRounds(unittest.TestCase):
    def setUp(self):
        self.t=tempfile.TemporaryDirectory();self.addCleanup(self.t.cleanup);self.base=Path(self.t.name)
        self.calls=[]

    def execute(self,rounds,seconds=7200,stage=3600,repairs=2,verify=None,run_seconds=20000):
        raw=project(self.base,True)
        unit=raw['units'][0];unit.update(max_seconds=seconds,stage_timeout_seconds=stage,max_repairs=repairs)
        unit['max_infra_retries']=1
        raw['limits']['max_wall_seconds']=run_seconds
        if verify:
            unit.update(kind='verify',developer=None,writable_paths=[],build_profiles=[],review_mode=verify)
            if verify=='gates': unit['reviewer']=None
        (Path(raw['source'])/'build.py').write_text(BUILD+"if Path('value.txt').read_text()=='fixed-round-1': raise SystemExit(1)\n")
        state,root,d=prepared(self.base,raw);rid,s,aid=create_prepared_run(state,root,d)
        controller=Controller(root,rid);clock=Clock(controller.store.data['created_epoch'])
        original=UnitEngine.run_gates
        attempts={}

        def fake_job(owner,argv,code,job,stdin,timeout,idle,env,phase):
            c=json.loads(Path(env['LOOP_CONTEXT']).read_text());role=c['role'];r=c['round']
            self.calls.append({'role':role,'round':r,'timeout':timeout,'prompt':stdin,'context':c})
            key=(r,role);index=attempts.get(key,0);attempts[key]=index+1
            steps=rounds[r][role]
            duration,behavior=steps[index] if isinstance(steps,list) else (steps,'ok')
            reason='timeout' if duration>timeout else (behavior if behavior not in ('invalid','ok') else 'ok')
            clock.advance(min(duration,timeout))
            job.mkdir(parents=True)
            if role=='developer' and not c['protocol_repair_only']:
                (code/'value.txt').write_text('fixed-round-'+str(r))
            rows=[{'id':x['id'],'status':'PASS' if role=='developer' or all(owner.gates[g]['status']=='PASS' for g in x['gate_ids']) else 'FAIL',
                   'note':'offline timed fixture','evidence':['code:value.txt'] if role=='developer' else ['gate:'+g for g in x['gate_ids']]}
                  for x in owner.unit['criteria']]
            report={'attempt_id':c['attempt_id'],'role':role,'candidate_hash':c['candidate_hash'],'summary':'offline',
                    'blocked':False,'criteria':rows,'issues':[],'rule_gaps':[]}
            (job/'stdout.log').write_text(json.dumps({} if behavior=='invalid' else report))
            (job/'stderr.log').write_text('')
            return {'reason':reason,'exit_code':0 if reason=='ok' else None}

        def gates(owner,manifest):
            original(owner,manifest)
            clock.advance(rounds[owner.round]['gate'])

        with mock.patch('loop_engineering.engine.time.time',clock), mock.patch.object(UnitEngine,'run_job',fake_job), \
             mock.patch.object(UnitEngine,'run_gates',gates):
            controller.execute()
        m=json.loads((root/'runs'/rid/'manifest.json').read_text())
        self.assertEqual(m['result']['finalization']['status'],'PASS',m['result'])
        self.assertTrue(audit(root,rid)['integrity_ok'])
        return m,m['units']['check']['result']

    def test_wbhost_repair_is_cut_off_before_it_uses_review_reserve(self):
        m,result=self.execute({1:{'developer':3300,'gate':0,'reviewer':630},2:{'developer':3000,'gate':0,'reviewer':240}})
        self.assertEqual(result['stop'],'NOT_MET')
        self.assertEqual(result['reason'],'返修开发用完了本轮可用时间（已为门禁和复审预留 13.1 分钟），没有交付；保留上一候选和问题清单')
        call=self.calls[2];self.assertEqual((call['round'],call['role'],call['timeout']),(2,'developer',2482))
        self.assertIn('本轮开发限时约 41.4 分钟（已扣除门禁和复审预留）',call['prompt'])
        self.assertIn('受管工具的回执里有 seconds_left，时间不够时先交付已经完成的修复',call['prompt'])
        self.assertEqual(result['candidate'],result['history'][0]['candidate'])
        self.assertEqual(result['issue_history'],result['history'][0]['issue_history'])
        self.assertIsNone(result['history'][1]['candidate'])
        self.assertEqual(result['history'][1]['timing'],{'developer_seconds':2482,'gate_seconds':0,'review_seconds':0})
        self.assertEqual(m['budget']['repairs'],1)
        self.assertEqual(m['units']['check']['history'],result['history'])

    def test_insufficient_time_never_reserves_or_counts_a_repair(self):
        m,result=self.execute({1:{'developer':3300,'gate':0,'reviewer':630}},seconds=6000)
        self.assertEqual(result['stop'],'NOT_MET');self.assertIn('时间不够返修',result['reason'])
        self.assertEqual(m['budget'].get('repairs',0),0);self.assertEqual(result['stats']['repairs'],0)
        self.assertEqual(len(result['history']),1);self.assertEqual(len(self.calls),2)

    def test_remaining_time_uses_minimum_of_run_and_unit_deadline(self):
        m,result=self.execute({1:{'developer':3300,'gate':0,'reviewer':630}},seconds=7200,run_seconds=6000)
        self.assertEqual(result['stop'],'NOT_MET');self.assertIn('剩余 34.5 分钟',result['reason'])
        self.assertEqual(result['stats']['repairs'],0)

    def test_every_completed_round_persists_three_rounded_stage_times(self):
        m,result=self.execute({1:{'developer':10.26,'gate':2.24,'reviewer':4.26},
                               2:{'developer':6.26,'gate':3.24,'reviewer':5.26}},seconds=100,stage=60)
        self.assertEqual(result['stop'],'PASSED',result['reason'])
        self.assertEqual([h['timing'] for h in result['history']],
                         [{'developer_seconds':10.3,'gate_seconds':2.2,'review_seconds':4.3},
                          {'developer_seconds':6.3,'gate_seconds':3.2,'review_seconds':5.3}])
        self.assertEqual(m['units']['check']['history'],result['history'])

    def test_protocol_and_infra_retries_are_timed_in_same_business_round(self):
        m,result=self.execute({1:{'developer':[(2,'transient_service_error'),(3,'invalid'),(5,'ok')],
                                  'gate':1.26,'reviewer':[(7,'invalid'),(11,'ok')]}},seconds=200,stage=60,repairs=0)
        self.assertEqual(result['stop'],'NOT_MET');self.assertIn('返修上限',result['reason'])
        self.assertEqual(result['history'][0]['timing'],{'developer_seconds':10,'gate_seconds':1.3,'review_seconds':18})
        self.assertEqual(result['stats']['infra_retries'],1)
        self.assertEqual(result['stats']['protocol_retries_by_role'],{'developer':1,'reviewer':1})
        self.assertEqual({c['round'] for c in self.calls},{1})
        self.assertEqual(result['stats']['repairs'],0)

    def test_reserved_deadline_is_not_reset_by_infra_retry(self):
        m,result=self.execute({1:{'developer':10,'gate':2,'reviewer':4},
                               2:{'developer':[(30,'transient_service_error'),(100,'ok')],'gate':0,'reviewer':0}},seconds=100,stage=60)
        self.assertEqual(result['stop'],'NOT_MET');self.assertIn('返修开发用完',result['reason'])
        self.assertEqual([c['timeout'] for c in self.calls if c['round']==2],[60,46])
        self.assertEqual(result['history'][1]['timing']['developer_seconds'],76)
        self.assertEqual(result['stats']['repairs'],1)

    def test_ordinary_stage_timeout_still_blocks_even_in_repair_round(self):
        m,result=self.execute({1:{'developer':10,'gate':2,'reviewer':4},
                               2:{'developer':100,'gate':0,'reviewer':0}},seconds=300,stage=60)
        self.assertEqual((result['stop'],result['reason']),('BLOCKED','成员执行停止：timeout'))
        self.assertEqual(self.calls[-1]['timeout'],60)

    def test_idle_timeout_is_not_reclassified_as_reserved_timeout(self):
        m,result=self.execute({1:{'developer':3300,'gate':0,'reviewer':630},
                               2:{'developer':[(10,'idle_timeout')],'gate':0,'reviewer':0}})
        self.assertEqual((result['stop'],result['reason']),('BLOCKED','成员执行停止：idle_timeout'))

    def test_verify_gates_round_has_zero_developer_and_review_time(self):
        m,result=self.execute({1:{'gate':1.26}},seconds=100,stage=60,verify='gates')
        self.assertEqual(result['stop'],'PASSED');self.assertEqual(self.calls,[])
        self.assertEqual(result['history'][0]['timing'],{'developer_seconds':0,'gate_seconds':1.3,'review_seconds':0})

    def test_verify_independent_round_has_zero_developer_time(self):
        m,result=self.execute({1:{'gate':1.26,'reviewer':4.26}},seconds=100,stage=60,verify='independent')
        self.assertEqual(result['stop'],'PASSED')
        self.assertEqual([c['role'] for c in self.calls],['reviewer'])
        self.assertEqual(result['history'][0]['timing'],{'developer_seconds':0,'gate_seconds':1.3,'review_seconds':4.3})

    def test_review_failure_also_persists_time(self):
        m,result=self.execute({1:{'developer':10,'gate':2,'reviewer':100}},seconds=300,stage=60)
        self.assertEqual((result['stop'],result['reason']),('BLOCKED','成员执行停止：timeout'))
        self.assertEqual(result['history'][0]['timing'],{'developer_seconds':10,'gate_seconds':2,'review_seconds':60})


class GuardianDeadline(unittest.TestCase):
    def test_developer_timeout_shrinks_but_guardian_keeps_unit_deadline(self):
        import sys,time
        with tempfile.TemporaryDirectory() as t:
            base=Path(t);run=base/'run';run.mkdir()
            store=mock.Mock(run=run,root=base,rid='r',data={'units':{'u':{'member_observations':{}}}})
            controller:Any=SimpleNamespace(store=store,rules={'schema_version':1,'limits':{'max_log_bytes':10000}},deadline=time.time()+10.4)
            owner=UnitEngine(controller,{'id':'u','max_seconds':10.4})
            owner.repair_reserve=10;owner.developer_deadline=owner.deadline-owner.repair_reserve
            code=base/'code';code.mkdir();job=base/'job'
            timeout=owner.developer_deadline-time.time()
            receipt=owner.run_job([sys.executable,'-c','import time;time.sleep(2)'],code,job,'',timeout,0,dict(os.environ),'developing')
            spec=json.loads((job/'job.json').read_text())
            self.assertEqual(receipt['reason'],'timeout')
            self.assertEqual(spec['deadline_epoch'],owner.deadline)
            self.assertLess(spec['timeout_seconds'],.5)


    def test_reserved_timeout_survives_cleanup_crossing_unit_deadline(self):
        with tempfile.TemporaryDirectory() as t:
            base=Path(t);run=base/'run';run.mkdir();clock=Clock()
            store=mock.Mock(run=run,root=base,rid='r',data={'units':{'u':{'member_observations':{}}}})
            controller:Any=SimpleNamespace(store=store,rules={'schema_version':1,'limits':{'max_log_bytes':10000}},deadline=10)
            with mock.patch('loop_engineering.engine.time.time',clock):
                owner=UnitEngine(controller,{'id':'u','max_seconds':10})
                owner.repair_reserve=2;owner.developer_deadline=8
                code=base/'code';code.mkdir();job=base/'job'
                def guardian(*args,**kw):
                    (job/'receipt.json').write_text(json.dumps({'reason':'timeout','exit_code':None}))
                    clock.advance(11)
                    return mock.Mock(poll=mock.Mock(return_value=0))
                with mock.patch('loop_engineering.engine.subprocess.Popen',side_effect=guardian), \
                     mock.patch('loop_engineering.engine.process_identity',return_value='start'):
                    receipt=owner.run_job(['offline'],code,job,'',8,0,{},'developing')
                self.assertEqual(receipt['reason'],'timeout')
                with self.assertRaises(Stop) as e: owner.repair_timeout()
                self.assertEqual(e.exception.stop,'NOT_MET');self.assertIn('返修开发用完',e.exception.reason)


class ReceiptVisibility(unittest.TestCase):
    def test_unmodified_pi_extension_places_seconds_left_in_model_text(self):
        node,npm=shutil.which('node'),shutil.which('npm')
        if not node or not npm: self.skipTest('local Node/npm required; no installs')
        modules=Path(subprocess.check_output([npm,'root','-g'],text=True).strip())
        candidates=[modules/'typescript',BUNDLE/'node_modules/typescript',
                    Path.home()/'.pi/tools/node_modules/typescript']
        typescript=next((p for p in candidates if p.is_dir()),None)
        if typescript is None: self.skipTest('local TypeScript required; no installs')
        script=r"""
const assert=require('node:assert/strict'),fs=require('node:fs'),net=require('node:net'),Module=require('node:module');
const ts=require(process.argv[2]),source=process.argv[1];
const m=new Module(source);m.require=id=>id==='@sinclair/typebox'?{Type:{Object:x=>x,String:()=>({}),Array:x=>x}}:require(id);
m._compile(ts.transpileModule(fs.readFileSync(source,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,source);
const tools={};m.exports.default({registerTool:t=>tools[t.name]=t,on:()=>{},setActiveTools:()=>{}});
const server=net.createServer(c=>{let body='';c.on('data',chunk=>{body+=chunk;if(body.includes('\n'))
 c.end(JSON.stringify({ok:true,result:{status:'PASS',seconds_left:37}})+'\n');});});
(async()=>{await new Promise(r=>server.listen(process.env.LOOP_MEMBER_SOCKET,r));
for(const [name,params] of [['loop_build',{recipe_id:'test'}],['loop_submit_check',{}],['loop_delete',{paths:['value.txt']}],['loop_copy',{source:'value.txt',targets:['x.txt']}]]){
 const result=await tools[name].execute(name,params);
 assert.equal(result.details.seconds_left,37);assert.equal(JSON.parse(result.content[0].text).seconds_left,37);
}
await new Promise(r=>server.close(r));console.log('seconds_left visible in all four model-text receipts; real_pi=false');
})().catch(e=>{console.error(e);server.close();process.exitCode=1;});
"""
        with tempfile.TemporaryDirectory() as t:
            base=Path(t);context=base/'context.json'
            context.write_text(json.dumps({'managed_tools':True,'role':'developer','unit':{'stage_timeout_seconds':5}}))
            env={**os.environ,'LOOP_CONTEXT':str(context),'LOOP_MEMBER_SOCKET':str(base/'s'),'LOOP_MEMBER_TOKEN':'token'}
            result=subprocess.run([node,'-e',script,str(BUNDLE/'extensions/pi/loop-member-tools.ts'),str(typescript)],
                                  env=env,text=True,capture_output=True,timeout=30)
            self.assertEqual(result.returncode,0,result.stderr)
            self.assertIn('seconds_left visible in all four model-text receipts',result.stdout)


if __name__=='__main__': unittest.main()
