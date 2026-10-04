"""Offline regressions: review an unreviewed input before repair, and select a round."""
import json,stat,tempfile,unittest
from pathlib import Path
from typing import Any
from helpers import project,prep,normalize,execute_prepared
from loop_engineering.common import LoopError,IntegrityError,atomic_json,copy_manifest,digest
from loop_engineering.engine import snapshot_manifest,verify_candidate
from test_derive040 import guard,stdout_json


# Failed gates, not reviewer issues, trigger repairs; compatible with the new review contract.
MEMBER="""import json,os
from pathlib import Path
c=json.loads(Path(os.environ['LOOP_CONTEXT']).read_text())
code=Path(c['code_path']);role=c['role']
if role=='developer':
    (code/'value.txt').write_text('fixed-round-'+str(c['round']))
if role=='reviewer' and c['round']==1 and c['unit'].get('first_round')=='review':
    assert c['developer_delivery'] is None
rows=[]
for criterion in c['unit']['criteria']:
    failed=role=='reviewer' and any(c['gate_evidence'][g]['status']=='FAIL' for g in criterion['gate_ids'])
    rows.append({'id':criterion['id'],'status':'FAIL' if failed else 'PASS',
                 'note':'OFFLINE gate-based review',
                 'evidence':['gate:'+g for g in criterion['gate_ids']] if role=='reviewer' else ['code:value.txt']})
print(json.dumps({'attempt_id':c['attempt_id'],'role':role,
                 'candidate_hash':c['candidate_hash'] if role=='reviewer' else '',
                 'summary':'OFFLINE deterministic member','blocked':False,
                 'criteria':rows,'issues':[],'rule_gaps':[]}))
"""
REVIEW_NOTICE=('【续接，与上文冲突时以本段为准】上次运行留下 {count} 个未解决问题；'
               '当前代码是第 {round} 轮候选，开发方已声称处理，但还没有评审。'
               '评审逐条核对：已解决的不再列出，仍未解决的重新列为问题。'
               '开发方只处理评审本轮列出的问题。')


def finding(description,status='OPEN',kind='issue',deferred=False):
    return {'id':kind+'-'+description,'kind':kind,'description':description,
            'criterion_ids':['C'],'status':status,'deferred':deferred,
            'occurrences':[{'reported':{'files':['value.txt']}}]}


class FirstRoundRules(unittest.TestCase):
    def setUp(self):
        self.t=tempfile.TemporaryDirectory();self.addCleanup(self.t.cleanup)
        self.base=Path(self.t.name).resolve();self.raw=project(self.base,True)

    def test_default_develop_and_explicit_review(self):
        self.assertEqual(normalize(self.raw,self.base)['units'][0]['first_round'],'develop')
        self.raw['units'][0]['first_round']='review'
        self.assertEqual(normalize(self.raw,self.base)['units'][0]['first_round'],'review')

    def test_register_refuses_invalid_first_round_values(self):
        for value in ('later','',None,True,1,[],{}):
            with self.subTest(value=value):
                self.raw['units'][0]['first_round']=value
                with self.assertRaisesRegex(LoopError,'first_round'):
                    prep.register_project(self.base/'state','bad',self.raw,self.base,self.base/'data',verify=False)

    def test_verify_refuses_even_explicit_develop(self):
        u=self.raw['units'][0]
        u.update(kind='verify',developer=None,writable_paths=[],build_profiles=[])
        for mode in ('independent','gates'):
            u.update(review_mode=mode,reviewer='review' if mode=='independent' else None)
            for value in ('develop','review'):
                with self.subTest(mode=mode,value=value):
                    u['first_round']=value
                    with self.assertRaisesRegex(LoopError,'verify.*first_round'):
                        normalize(self.raw,self.base)
            u.pop('first_round')
            self.assertNotIn('first_round',normalize(self.raw,self.base)['units'][0])

    def test_review_requires_reviewer_at_registration(self):
        u=self.raw['units'][0];u['first_round']='review'
        for missing in (False,True):
            with self.subTest(missing=missing):
                if missing:u.pop('reviewer',None)
                else:u['reviewer']=None
                with self.assertRaisesRegex(LoopError,'first_round.*reviewer'):
                    prep.register_project(self.base/'state','bad',self.raw,self.base,self.base/'data',verify=False)

    def test_schema_v1_does_not_accept_first_round(self):
        raw={k:v for k,v in self.raw.items() if k not in ('security','execution_profiles','operation_budgets','limits')}
        raw['schema_version']=1
        u=raw['units'][0];u.pop('review_mode');u.pop('build_profiles');u['first_round']='review'
        u['gates']=[{'id':'G','argv':['{python}','build.py'],'timeout_seconds':20}]
        with self.assertRaisesRegex(LoopError,'first_round'):normalize(raw,self.base)

    def test_preview_marks_only_review_first_units(self):
        rules=normalize(self.raw,self.base)
        marker='第 1 轮：只跑门禁和评审（不开发）'
        self.assertNotIn(marker,prep.render_preview(rules,rules,self.base/'rules.json'))
        self.raw['units'][0]['first_round']='review';rules=normalize(self.raw,self.base)
        self.assertIn(marker,prep.render_preview(rules,rules,self.base/'rules.json'))


class ReviewFirstExecution(unittest.TestCase):
    def setUp(self):
        self.t=tempfile.TemporaryDirectory();self.addCleanup(self.t.cleanup)
        self.base=Path(self.t.name).resolve();self.raw=project(self.base,True)
        member=self.base/'member.py';member.write_text(MEMBER)
        for agent in self.raw['agents'].values():agent['argv']=['{python}',str(member)]
        self.raw['units'][0].update(first_round='review',build_profiles=[])

    def execute(self,fail_gate=False):
        if fail_gate:
            build=Path(self.raw['source'])/'build.py'
            build.write_text(build.read_text()+"raise SystemExit(0 if Path('value.txt').read_text().startswith('fixed-round-') else 1)\n")
        m,state,root,sealed,aid=execute_prepared(self.base,self.raw)
        self.manifest=m;self.limits=sealed['rules']['limits']
        self.result=m['units']['check']['result']
        workspace=Path(self.result['workspace'])
        self.contexts=sorted((json.loads(p.read_text()) for p in workspace.glob('attempts/*/context.json')),
                             key=lambda c:(c['round'],c['role']))
        return self.result

    def test_passing_input_calls_only_reviewer_and_freezes_program_delivery(self):
        result=self.execute()
        self.assertEqual(result['stop'],'PASSED',result['reason'])
        self.assertEqual([(c['round'],c['role']) for c in self.contexts],[(1,'reviewer')])
        self.assertEqual(self.manifest['units']['check']['stats']['member_invocations'],1)
        self.assertTrue(result['reviewed']);self.assertIsNone(self.contexts[0]['developer_delivery'])
        history=result['history'];self.assertEqual(len(history),1);self.assertIsNone(history[0]['developer'])
        self.assertEqual(json.loads(Path(history[0]['delivery_path']).read_text()),
                         {'origin':'program','kind':'review_first','input_hash':result['candidate']['input_hash']})
        state=self.manifest['units']['check']
        self.assertEqual(result['candidate']['hash'],state['input_hash'])
        self.assertEqual((Path(result['candidate']['path'])/'value.txt').read_text(),'initial')
        self.assertFalse(Path(result['candidate']['path']).stat().st_mode & stat.S_IWUSR)
        self.assertFalse((Path(result['candidate']['path'])/'value.txt').stat().st_mode & stat.S_IWUSR)
        verify_candidate(result['candidate'],self.limits)

    def test_failed_gate_repairs_on_round_two_and_compares_against_input(self):
        result=self.execute(fail_gate=True)
        self.assertEqual(result['stop'],'PASSED',result['reason'])
        self.assertEqual([(c['round'],c['role']) for c in self.contexts],
                         [(1,'reviewer'),(2,'developer'),(2,'reviewer')])
        first,second=result['history']
        self.assertIsNone(first['developer']);self.assertIsNotNone(second['developer'])
        self.assertEqual((first['gates']['G']['status'],second['gates']['G']['status']),('FAIL','PASS'))
        self.assertEqual(self.manifest['units']['check']['stats']['repairs'],1)
        self.assertEqual(first['candidate']['hash'],self.manifest['units']['check']['input_hash'])
        developer=self.contexts[1];reviewer=self.contexts[2]
        self.assertEqual(developer['feedback']['criteria'][0]['status'],'FAIL')
        self.assertEqual(developer['feedback']['issues'],[])
        self.assertEqual(reviewer['comparison']['changed_from_previous'],['value.txt'])
        self.assertEqual(reviewer['comparison']['previous_candidate']['path'],first['candidate']['path'])
        self.assertEqual(reviewer['developer_delivery'],second['developer'])
        self.assertFalse(second['deferred']);self.assertFalse(second['regression_only'])
        self.assertEqual((Path(second['candidate']['path'])/'value.txt').read_text(),'fixed-round-2')

    def test_failed_gate_obeys_zero_repair_limit(self):
        self.raw['units'][0]['max_repairs']=0
        result=self.execute(fail_gate=True)
        self.assertEqual(result['stop'],'NOT_MET',result['reason'])
        self.assertIn('返修上限',result['reason'])
        self.assertEqual([(c['round'],c['role']) for c in self.contexts],[(1,'reviewer')])

    def test_integration_unit_can_review_input_first(self):
        self.raw['units'][0]['kind']='integration'
        result=self.execute()
        self.assertEqual(result['stop'],'PASSED',result['reason'])
        self.assertEqual([c['role'] for c in self.contexts],['reviewer'])


class ContinueRound(unittest.TestCase):
    def setUp(self):
        self.t=tempfile.TemporaryDirectory();self.addCleanup(self.t.cleanup)
        self.base=Path(self.t.name).resolve();self.raw=project(self.base,True)
        self.rules=normalize(self.raw,self.base)
        self.root=self.base/'data';self.run_path=self.root/'runs'/'stopped';self.run_path.mkdir(parents=True)
        self.input_manifest=snapshot_manifest(Path(self.rules['source']),self.rules['limits'])
        self.input_path=self.run_path/'input';copy_manifest(Path(self.rules['source']),self.input_path,self.input_manifest,readonly=True)
        self.candidates=[self.candidate(n) for n in (1,2)]
        self.latest=[finding('latest-one'),finding('latest-two')]
        self.history=[{'round':1,'candidate':self.candidates[0],'review':{'summary':'accepted review'},
                       'issue_history':[finding('first-reviewed')]},
                      {'round':2,'candidate':self.candidates[1],'review_path':None,
                       'issue_history':[finding('second-snapshot')]}]
        self.result={'stop':'NOT_MET','candidate':self.candidates[1],'reviewed':False,
                     'history':self.history,'issue_history':self.latest}
        self.unit_state={'result':self.result,'issue_history':self.latest,
                         'input_path':str(self.input_path),'input_hash':digest(self.input_manifest)}
        self.manifest={'state':'TERMINAL','units':{'check':self.unit_state},
                       'input':{'path':str(self.input_path)}}

    def candidate(self,round_number):
        work=self.base/('work-'+str(round_number));copy_manifest(Path(self.rules['source']),work,self.input_manifest)
        (work/'value.txt').write_text('candidate-'+str(round_number))
        tree=snapshot_manifest(work,self.rules['limits']);code=self.base/('candidate-'+str(round_number))
        copy_manifest(work,code,tree,readonly=True)
        metadata=self.run_path/('candidate-'+str(round_number)+'.json')
        atomic_json(metadata,{'candidate_hash':digest(tree),'manifest':tree,'base_manifest':self.input_manifest},readonly=True)
        return {'round':round_number,'path':str(code),'metadata_path':str(metadata),
                'hash':digest(tree),'input_hash':digest(self.input_manifest)}

    def save(self):
        (self.run_path/'rules.json').write_text(json.dumps(self.rules))
        self.manifest['rule_hash']=digest(self.rules)
        (self.run_path/'manifest.json').write_text(json.dumps(self.manifest))

    def draft(self,**kw):
        self.save();out=self.base/'continued.json'
        response=prep.continue_plan(self.root,'stopped','next',out,**kw)
        return response,json.loads(out.read_text())

    def test_latest_unreviewed_carries_two_issues_with_exact_review_notice(self):
        self.rules['notes']='旧流程：续接单元先开发再评审。'
        response,plan=self.draft()
        self.assertEqual(response['first_round'],'review');self.assertIsNone(response['from_round'])
        self.assertEqual(response['carried_open_issues'],2)
        u=plan['units'][0];self.assertEqual(u['first_round'],'review')
        self.assertIn(REVIEW_NOTICE.format(count=2,round=2),u['goal'])
        self.assertIn('- [C] latest-one（value.txt）',u['goal'])
        self.assertIn('- [C] latest-two（value.txt）',u['goal'])
        self.assertNotIn('请先逐条修复',u['goal']);self.assertEqual(plan['source'],self.candidates[1]['path'])
        self.assertIn('第 1 轮只跑门禁和评审（不开发）',plan['notes'].splitlines()[0])
        self.assertEqual(plan['security'],'audit-only')

    def test_one_round_reviewed_result_stays_develop_and_repair_first(self):
        self.result.update(candidate=self.candidates[0],reviewed=True,history=self.history[:1])
        self.rules['units'][0]['first_round']='review'
        response,plan=self.draft()
        self.assertEqual(response['first_round'],'develop');self.assertEqual(plan['units'][0]['first_round'],'develop')
        self.assertIn('留下 2 个未解决问题，请先逐条修复：',plan['units'][0]['goal'])
        self.assertNotIn('还没有评审',plan['units'][0]['goal'])

    def test_does_not_carry_advisory_resolved_deferred_or_rule_gaps(self):
        self.latest[:]=[finding('active'),finding('unknown','UNKNOWN'),finding('suggestion','ADVISORY'),
                       finding('closed','RESOLVED'),finding('legacy',deferred=True),finding('gap',kind='rule_gap')]
        response,plan=self.draft()
        self.assertEqual(response['carried_open_issues'],2);self.assertEqual(response['deferred_findings_not_carried'],1)
        goal=plan['units'][0]['goal']
        for text in ('active','unknown'):self.assertIn(text,goal)
        for text in ('suggestion','closed','legacy','gap'):self.assertNotIn(text,goal)

    def test_reviewed_round_uses_its_post_review_history_not_latest(self):
        response,plan=self.draft(from_round=1)
        self.assertEqual((response['first_round'],response['from_round']),('develop',1))
        self.assertEqual(plan['source'],self.candidates[0]['path']);self.assertEqual(response['carried_open_issues'],1)
        goal=plan['units'][0]['goal'];self.assertIn('first-reviewed',goal);self.assertNotIn('latest-',goal)
        self.assertIn('请先逐条修复',goal);self.assertEqual(plan['units'][0]['first_round'],'develop')
        self.assertIn('源码来自 check 单元第 1 轮候选',plan['notes'].splitlines()[0])

    def test_unreviewed_round_uses_its_start_snapshot_even_if_latest_reviewed(self):
        self.result['reviewed']=True
        response,plan=self.draft(from_round=2)
        self.assertEqual((response['first_round'],response['from_round']),('review',2))
        self.assertEqual(response['carried_open_issues'],1)
        goal=plan['units'][0]['goal'];self.assertIn('second-snapshot',goal);self.assertNotIn('latest-',goal)
        self.assertIn(REVIEW_NOTICE.format(count=1,round=2),goal)
        self.assertEqual(plan['source'],self.candidates[1]['path'])

    def test_selected_round_filters_advisory_and_uses_its_deferred_count(self):
        self.history[0]['issue_history'] += [finding('suggestion','ADVISORY'),finding('legacy',deferred=True)]
        response,plan=self.draft(from_round=1)
        self.assertEqual(response['carried_open_issues'],1);self.assertEqual(response['deferred_findings_not_carried'],1)
        self.assertNotIn('suggestion',plan['units'][0]['goal']);self.assertNotIn('legacy',plan['units'][0]['goal'])

    def test_missing_round_or_candidate_lists_selectable_rounds(self):
        self.history.append({'round':3,'candidate':None});self.save()
        for round_number in (9,3):
            with self.subTest(round=round_number):
                out=self.base/('missing-'+str(round_number)+'.json')
                with self.assertRaisesRegex(LoopError,'可选轮次：1、2'):
                    prep.continue_plan(self.root,'stopped','next',out,from_round=round_number)
                self.assertFalse(out.exists())

    def test_from_round_and_fresh_unit_are_mutually_exclusive_in_api_and_cli(self):
        self.save();out=self.base/'invalid.json'
        with self.assertRaisesRegex(LoopError,'互斥'):
            prep.continue_plan(self.root,'stopped','next',out,from_round=1,fresh_unit=True)
        done=guard(self.base/'state','continue','stopped','--root',self.root,'--project-id','next','--out',out,
                   '--fresh-unit','--from-round',1)
        self.assertNotEqual(done.returncode,0);self.assertIn('--from-round',done.stderr);self.assertFalse(out.exists())

    def test_from_round_requires_positive_integer(self):
        self.save()
        invalid_values:tuple[Any,...]=(0,-1,True,1.5,'1')
        for value in invalid_values:
            with self.subTest(value=value):
                out=self.base/'invalid.json'
                with self.assertRaisesRegex(LoopError,'from-round.*正整数'):
                    prep.continue_plan(self.root,'stopped','next',out,from_round=value)
                self.assertFalse(out.exists())

    def test_selected_candidate_tampering_refused_before_writing(self):
        path=Path(self.candidates[0]['path'])/'value.txt';path.chmod(0o600);path.write_text('tampered')
        self.save();out=self.base/'tampered.json'
        with self.assertRaisesRegex(IntegrityError,'候选成果指纹'):
            prep.continue_plan(self.root,'stopped','next',out,from_round=1)
        self.assertFalse(out.exists())

    def test_selected_candidate_metadata_tampering_refused(self):
        path=Path(self.candidates[0]['metadata_path']);path.chmod(0o600)
        metadata=json.loads(path.read_text());metadata['candidate_hash']='wrong';path.write_text(json.dumps(metadata))
        self.save();out=self.base/'tampered.json'
        with self.assertRaisesRegex(IntegrityError,'元数据'):
            prep.continue_plan(self.root,'stopped','next',out,from_round=1)
        self.assertFalse(out.exists())

    def test_fresh_unit_resets_review_first_and_does_not_carry_candidate_issues(self):
        self.rules['units'][0]['first_round']='review'
        response,plan=self.draft(fresh_unit=True)
        self.assertEqual(response['first_round'],'develop');self.assertIsNone(response['from_round'])
        self.assertEqual(plan['units'][0]['first_round'],'develop');self.assertEqual(response['carried_open_issues'],0)
        self.assertEqual(plan['source'],str(self.input_path));self.assertNotIn('latest-',plan['units'][0]['goal'])

    def test_no_open_issues_still_explains_review_first(self):
        self.latest.clear()
        response,plan=self.draft()
        self.assertEqual(response['first_round'],'review');self.assertEqual(response['carried_open_issues'],0)
        self.assertIn(REVIEW_NOTICE.format(count=0,round=2),plan['units'][0]['goal'])

    def test_verify_continuation_keeps_native_verify_without_first_round_field(self):
        u=self.rules['units'][0]
        u.update(kind='verify',developer=None,reviewer=None,review_mode='gates',writable_paths=[],build_profiles=[])
        u.pop('first_round',None)
        response,plan=self.draft()
        self.assertEqual(response['first_round'],'develop');self.assertNotIn('first_round',plan['units'][0])
        normalize(plan,self.base)

    def test_cli_outputs_selection_without_modifying_readonly_run_or_candidate(self):
        self.save();out=self.base/'cli.json'
        roots=[self.run_path,*[Path(c['path']) for c in self.candidates]]
        def fingerprints():
            return {str(p):(p.stat().st_mode,p.stat().st_mtime_ns,p.read_bytes() if p.is_file() else None)
                    for root in roots for p in [root,*root.rglob('*')]}
        before=fingerprints()
        done=guard(self.base/'state','continue','stopped','--root',self.root,'--project-id','next','--out',out,
                   '--from-round',1)
        self.assertEqual(done.returncode,0,done.stderr);body=stdout_json(done)
        self.assertEqual((body['first_round'],body['from_round']),('develop',1))
        self.assertEqual(body['source'],self.candidates[0]['path']);self.assertEqual(len(body['next_commands']),3)
        self.assertEqual(fingerprints(),before)
        self.assertFalse((self.base/'state').exists())


if __name__=='__main__':unittest.main()
