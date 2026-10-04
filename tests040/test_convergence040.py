"""Repair convergence (2026-10-03): unit b3-control burned all repairs because each review
round found a new edge case in code nobody had touched. No model is called here."""
import json,tempfile,unittest
from pathlib import Path
from helpers import *
from loop_engineering.common import LoopError
from loop_engineering.protocol import validate_report
from loop_engineering.capabilities import unit_selftest_cap

FIXTURE=BUNDLE/'tests040/fixtures/member_freeze.py'


def scenario(base,name,max_repairs):
    raw=project(base,True)
    for agent in raw['agents'].values():
        agent['argv']=['{python}',str(FIXTURE),'--scenario',name]
    raw['units'][0]['max_repairs']=max_repairs
    raw['limits'].update(max_selftests=10,max_total_repairs=5)
    return raw


class Freeze(unittest.TestCase):
    def setUp(self):
        self.t=tempfile.TemporaryDirectory();self.addCleanup(self.t.cleanup);self.base=Path(self.t.name)

    def test_late_finding_in_unchanged_code_is_deferred_not_repaired(self):
        m,state,root,s,aid=execute_prepared(self.base,scenario(self.base,'late-unchanged',3))
        unit=m['units']['check']['result']
        self.assertEqual(unit['stop'],'PASSED',unit['reason'])
        self.assertEqual(m['budget']['repairs'],1)
        self.assertEqual([d['description'] for d in unit['deferred_findings']],['late finding in old code'])
        self.assertIn('遗留发现',(root/'runs'/m['run_id']/'result.md').read_text())

    def test_new_problem_in_changed_file_still_blocks(self):
        m,state,root,s,aid=execute_prepared(self.base,scenario(self.base,'regression',1))
        unit=m['units']['check']['result']
        self.assertEqual(unit['stop'],'NOT_MET');self.assertIn('返修上限',unit['reason'])
        self.assertEqual(unit['deferred_findings'],[])

    def test_two_regression_only_rounds_stop_as_not_converging(self):
        m,state,root,s,aid=execute_prepared(self.base,scenario(self.base,'nonconverge',4))
        unit=m['units']['check']['result']
        self.assertEqual(unit['stop'],'NOT_MET');self.assertIn('不收敛',unit['reason'])
        self.assertEqual(m['budget']['repairs'],2)  # stopped at round 3, not after 4 repairs

    def test_open_scope_keeps_old_behaviour(self):
        raw=scenario(self.base,'late-unchanged',1);raw['units'][0]['review_scope']='open'
        m,state,root,s,aid=execute_prepared(self.base,raw)
        self.assertEqual(m['units']['check']['result']['stop'],'NOT_MET')


class ReviewProtocol(unittest.TestCase):
    def context(self,history=()):
        return {'attempt_id':'a','role':'reviewer','candidate_hash':'h','round':2,'managed_tools':True,
                'issue_history':list(history),'unit':{'criteria':[{'id':'C','gate_ids':['G']}],'review_scope':'frozen'}}
    def report(self,issues,status='FAIL'):
        return {'attempt_id':'a','role':'reviewer','candidate_hash':'h','summary':'s','blocked':False,
                'criteria':[{'id':'C','status':status,'note':'n','evidence':['gate:G']}],'issues':issues,'rule_gaps':[]}
    def test_repair_round_issue_needs_files(self):
        with self.assertRaises(LoopError) as e:
            validate_report(self.report([{'criterion_id':'C','description':'d','suggested_fix':'f','severity':'advisory'}]),self.context(),Path('.'),{'G':{'status':'PASS'}})
        self.assertIn('files',str(e.exception))
    def test_fail_must_point_at_a_problem(self):
        with self.assertRaises(LoopError):
            validate_report(self.report([]),self.context(),Path('.'),{'G':{'status':'PASS'}})
        known=[{'id':'issue-1','kind':'issue','criterion_ids':['C'],'status':'OPEN'}]
        validate_report(self.report([]),self.context(known),Path('.'),{'G':{'status':'PASS'}})   # still-open known issue
        validate_report(self.report([]),self.context(),Path('.'),{'G':{'status':'FAIL'}})        # failed gate
    def test_first_round_requires_severity_but_not_files(self):
        ctx=self.context();ctx['round']=1
        item:dict={'criterion_id':'C','description':'d','suggested_fix':'f'}
        with self.assertRaisesRegex(LoopError,'severity'):
            validate_report(self.report([item]),ctx,Path('.'),{'G':{'status':'PASS'}})
        item.update(severity='blocking',counterexample='fixture scenario gives the wrong result',
                    locations=['tests040/fixtures/member_freeze.py:1'])
        validate_report(self.report([item]),ctx,Path('.'),{'G':{'status':'PASS'}})


class SelftestShare(unittest.TestCase):
    def test_even_split_and_explicit_cap(self):
        rules={'limits':{'max_selftests':48},'units':[{'id':u,'kind':'work','build_profiles':['b']} for u in 'abcd']}
        self.assertEqual(unit_selftest_cap(rules,rules['units'][0]),12)
        rules['units'][0]['max_selftests']=30;self.assertEqual(unit_selftest_cap(rules,rules['units'][0]),30)
        rules['units'][0]['max_selftests']=99;self.assertEqual(unit_selftest_cap(rules,rules['units'][0]),48)

    def test_unit_cap_enforced_during_a_run(self):
        with tempfile.TemporaryDirectory() as t:
            base=Path(t);raw=project(base,True,True);raw['units'][0]['max_selftests']=1
            m,state,root,s,aid=execute_prepared(base,raw)
            unit=m['units']['check']['result']
            self.assertEqual(m['budget']['selftests'],1);self.assertNotEqual(unit['stop'],'PASSED')


class PreparationVisibility(unittest.TestCase):
    def test_preview_lists_commands_and_warns_on_open_ended_criteria(self):
        with tempfile.TemporaryDirectory() as t:
            base=Path(t);raw=project(base);raw['units'][0]['criteria'][0]['text']='覆盖全部边界情况'
            state,root,d=prepared(base,raw)
            r=prep.check(state,d['id'],d['revision']);self.assertEqual(r['status'],'READY')
            self.assertTrue(any('全部' in w for w in r['warnings']))
            preview=Path(prep.seal(state,d['id'],d['revision'])['preview_path']).read_text()
            self.assertIn('将执行的构建/检查命令',preview);self.assertIn('build.py',preview)
            self.assertIn('验收标准提醒',preview);self.assertIn('问题清单冻结',preview)


if __name__=='__main__':unittest.main()
