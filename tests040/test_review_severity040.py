"""OFFLINE counterexamples for review severity, pass bars and stalled repairs."""
import copy,json,tempfile,unittest
from pathlib import Path
from helpers import *
from loop_engineering import adapters
from loop_engineering.common import LoopError
from loop_engineering.handoff import record_findings,rebind_history,apply_resolutions,freeze_review
from loop_engineering.protocol import response_schema,validate_report

FIXTURE=BUNDLE/'tests040/fixtures/member_severity.py'


def issue(severity='blocking',description='wrong result'):
    return {'criterion_id':'C','description':description,'suggested_fix':'fix this result','files':['value.txt'],
            'severity':severity,'counterexample':'输入 1 时返回 2，标准要求返回 1',
            'locations':['value.txt:1-2'],'spec_refs':['C']}


def report(issues=(),status='FAIL'):
    return {'attempt_id':'a','role':'reviewer','candidate_hash':'h','summary':'offline review','blocked':False,
            'criteria':[{'id':'C','status':status,'note':'checked','evidence':['code:value.txt']}],
            'issues':list(issues),'rule_gaps':[]}


class SeverityProtocol(unittest.TestCase):
    def setUp(self):
        self.t=tempfile.TemporaryDirectory();self.addCleanup(self.t.cleanup);self.code=Path(self.t.name)
        (self.code/'value.txt').write_text('one\ntwo\nthree')
        (self.code/'empty.txt').touch();(self.code/'directory').mkdir()
        self.context={'attempt_id':'a','role':'reviewer','candidate_hash':'h','round':1,'managed_tools':True,
                      'issue_history':[],'unit':{'criteria':[{'id':'C','gate_ids':['G']}],'review_scope':'frozen'}}
        self.gates={'G':{'status':'PASS','candidate_hash':'h'}}

    def validate(self,r):
        return validate_report(r,self.context,self.code,self.gates)

    def test_schema_fields_are_optional_with_severity_enum(self):
        schema=response_schema()['properties']['issues']['items']
        for name in ('severity','counterexample','locations','spec_refs'):
            self.assertIn(name,schema['properties']);self.assertNotIn(name,schema['required'])
        self.assertEqual(schema['properties']['severity']['enum'],['blocking','advisory'])

    def test_managed_reviewer_requires_severity_in_every_round(self):
        item=issue();del item['severity']
        for rnd in (1,2,3):
            with self.subTest(round=rnd):
                self.context['round']=rnd
                with self.assertRaisesRegex(LoopError,'severity.*blocking.*advisory'):self.validate(report([item]))

    def test_blocking_requires_counterexample_and_locations(self):
        for name,values in (('counterexample',[None,'','   ',7]),('locations',[None,[],['']])):
            for value in values:
                with self.subTest(field=name,value=value):
                    item=issue()
                    if value is None:del item[name]
                    else:item[name]=value
                    with self.assertRaisesRegex(LoopError,name):self.validate(report([item]))

    def test_locations_require_safe_existing_files_and_real_line_ranges(self):
        (self.code/'link.txt').symlink_to(self.code/'value.txt')
        (self.code/'dir-link').symlink_to(self.code/'directory',target_is_directory=True)
        (self.code/'directory'/'nested.txt').write_text('one\n')
        outside=self.code.parent/(self.code.name+'-outside.txt');outside.write_text('outside\n')
        self.addCleanup(outside.unlink)
        (self.code/'escape').symlink_to(outside.parent,target_is_directory=True)
        (self.code/'loop').symlink_to(self.code/'loop',target_is_directory=True)
        bad=['value.txt','value.txt:0','value.txt:-1','value.txt:2-1','value.txt:1-4','value.txt:4',
             'value.txt:1-x','value.txt:1:2','missing.txt:1','directory:1','empty.txt:1',
             str(self.code/'value.txt')+':1','../value.txt:1','./value.txt:1','value.txt/:1',
             'link.txt:1','dir-link/nested.txt:1','escape/'+outside.name+':1','loop/x.txt:1',
             'value.txt:'+('9'*5000)]
        for location in bad:
            with self.subTest(location=location[:80]):
                item=issue();item['locations']=[location]
                with self.assertRaises(LoopError):self.validate(report([item]))

    def test_valid_locations_include_single_and_last_lines(self):
        item=issue();item['locations']=['value.txt:1','value.txt:3','value.txt:1-3']
        self.assertIs(self.validate(r:=report([item])),r)

    def test_optional_fields_are_type_checked_for_all_roles(self):
        for managed in (False,True):
            self.context['managed_tools']=managed
            for field,values in (('severity',['critical',None,1]),('counterexample',[1,[]]),
                                 ('locations',['value.txt:1',[1]]),('spec_refs',['C',[1]])):
                for value in values:
                    with self.subTest(managed=managed,field=field,value=value):
                        item=issue('advisory');item[field]=value
                        with self.assertRaisesRegex(LoopError,field):self.validate(report([item],'PASS'))

    def test_fail_with_only_advisory_or_rule_gap_is_rejected_in_all_rounds(self):
        for rnd in (1,2,3):
            self.context['round']=rnd
            for r in (report([issue('advisory')]),dict(report(),rule_gaps=['规格缺少输入范围'])):
                with self.subTest(round=rnd,issues=r['issues']):
                    with self.assertRaisesRegex(LoopError,'标准 C 判 FAIL 但没有必须修的问题.*只有建议项时请判 PASS'):
                        self.validate(r)

    def test_failed_gate_supports_fail_without_issues(self):
        self.gates['G']['status']='FAIL';self.validate(report())

    def test_only_open_non_deferred_blocking_history_supports_fail(self):
        known={'id':'known','kind':'issue','criterion_ids':['C'],'description':'known problem',
               'severity':'blocking','status':'OPEN'}
        self.context['issue_history']=[known];self.validate(report())
        for patch in ({'status':'UNKNOWN'},{'status':'RESOLVED'},{'status':'ADVISORY'},
                      {'deferred':{'round':2}},{'severity':'advisory'},{'kind':'rule_gap'}):
            with self.subTest(patch=patch):
                self.context['issue_history']=[dict(known,**patch)]
                with self.assertRaisesRegex(LoopError,'没有必须修'):self.validate(report())

    def test_advisory_cannot_be_upgraded_to_support_fail(self):
        self.context['issue_history']=[{'id':'known','kind':'issue','description':'wrong result',
                                       'criterion_ids':['C'],'severity':'advisory','status':'ADVISORY'}]
        with self.assertRaisesRegex(LoopError,'没有必须修'):self.validate(report([issue('blocking')]))

    def test_advisory_and_spec_gap_can_pass_without_blocking_metadata(self):
        item={'criterion_id':'C','description':'make checks stricter','suggested_fix':'optional','severity':'advisory'}
        self.validate(dict(report([item],'PASS'),rule_gaps=['规格未写此边界']))

    def test_advisory_resolution_is_rejected_by_protocol(self):
        self.context['issue_history']=[{'id':'advice','status':'ADVISORY','severity':'advisory'}]
        r=report([],'PASS');r['issue_resolutions']=[{'id':'advice','note':'done','evidence':['code:value.txt']}]
        with self.assertRaisesRegex(LoopError,'建议项不需要关闭'):self.validate(r)

    def test_v1_unmanaged_and_developer_keep_old_optional_contract(self):
        old={'criterion_id':'C','description':'old problem','suggested_fix':'old fix'}
        for role,managed in (('reviewer',False),('developer',True),('developer',False)):
            for rnd in (1,2):
                with self.subTest(role=role,managed=managed,round=rnd):
                    ctx=dict(self.context,role=role,managed_tools=managed,round=rnd)
                    r=report([old]);r.update(role=role,candidate_hash='' if role=='developer' else 'h')
                    validate_report(r,ctx,self.code,self.gates)
        self.context['managed_tools']=False
        self.validate(report([dict(old,severity='blocking',counterexample='',locations=['legacy:999'],spec_refs=[])]))


class SeverityLedger(unittest.TestCase):
    def record(self,history,items,rnd=1):
        return record_findings(history,report(items),'r','u',rnd,'h'+str(rnd),'accepted'+str(rnd))

    def test_blocking_and_advisory_metadata_are_recorded_without_mutating_inputs(self):
        r=report([issue(),issue('advisory','stricter checks')]);original=copy.deepcopy(r)
        history=record_findings([],r,'r','u',1,'h','accepted')
        self.assertEqual([i['status'] for i in history],['OPEN','ADVISORY'])
        self.assertEqual(history[1]['state_note'],'建议项，不阻断，交拍板人决定')
        for name in ('severity','counterexample','locations','spec_refs'):
            self.assertEqual(history[0][name],r['issues'][0][name])
        history[0]['locations'].append('other:1');self.assertEqual(r,original)
        legacy=issue();del legacy['severity']
        self.assertEqual(self.record([],[legacy])[0]['severity'],'blocking')

    def test_severity_and_id_are_fixed_on_first_occurrence(self):
        for initial,later,status in (('advisory','blocking','ADVISORY'),('blocking','advisory','OPEN')):
            with self.subTest(initial=initial):
                history=self.record([],[issue(initial)]);fid=history[0]['id']
                for rnd in (2,3):
                    before=copy.deepcopy(history)
                    history=rebind_history(history,'h'+str(rnd),rnd)
                    self.assertEqual(before[0]['status'],history[0]['status'])
                    history=self.record(history,[issue(later)],rnd)
                    self.assertEqual(len(history),1);self.assertEqual(history[0]['id'],fid)
                    self.assertEqual((history[0]['severity'],history[0]['status']),(initial,status))

    def test_advisory_cannot_be_closed_even_when_called_without_protocol(self):
        history=self.record([],[issue('advisory')]);r=report([],'PASS')
        r['issue_resolutions']=[{'id':history[0]['id'],'note':'done','evidence':['code:value.txt']}]
        with self.assertRaisesRegex(LoopError,'建议项不需要关闭'):
            apply_resolutions(history,r,{'criteria':[{'id':'C','gate_ids':[]}]},{},'h',2,'accepted',
                              {'code:value.txt':{'candidate_hash':'h'}})
        self.assertEqual(history[0]['status'],'ADVISORY')

    def test_advisory_is_neither_known_blocker_regression_nor_deferred(self):
        for changed in (set(),{'value.txt'}):
            with self.subTest(changed=changed):
                items=[issue('advisory','known advice'),issue('advisory','new advice')]
                history=self.record([],[items[0]])
                known={history[0]['id']};history=self.record(history,items,2)
                rows,ledger,deferred,regression=freeze_review(report()['criteria'],report(items),history,known,
                    changed,{'criteria':[{'id':'C','gate_ids':['G']}]},{'G':{'status':'PASS'}},'r','u',2)
                self.assertEqual(rows[0]['status'],'PASS');self.assertFalse(regression);self.assertEqual(deferred,[])
                self.assertTrue(all(i['status']=='ADVISORY' and not i.get('deferred') for i in ledger))

    def test_only_blocking_late_findings_enter_deferred_list(self):
        items=[issue('advisory','new advice'),issue('blocking','late bug')]
        history=self.record([],items,2)
        rows,ledger,deferred,regression=freeze_review(report()['criteria'],report(items),history,set(),set(),
            {'criteria':[{'id':'C','gate_ids':['G']}]},{'G':{'status':'PASS'}},'r','u',2)
        self.assertEqual([i['description'] for i in deferred],['late bug'])
        self.assertEqual([i['status'] for i in ledger],['ADVISORY','DEFERRED']);self.assertFalse(regression)


class SeverityPrompts(unittest.TestCase):
    def test_all_review_rounds_get_default_and_unit_bar_with_precedence(self):
        custom='只要登记的两个输入结果正确就过线，性能优化都是建议。'
        for rnd in (1,2):
            p=adapters.member_prompt({'role':'reviewer','managed_tools':True,'round':rnd,
                                     'unit':{'review_bar':custom,'review_scope':'frozen'}})
            self.assertIn(adapters.DEFAULT_REVIEW_BAR,p);self.assertIn(custom,p)
            for term in ('以单元口径为准','severity','counterexample','locations','相对路径:起-止',
                         'spec_refs','不要为了保险','rule_gaps','FAIL'):
                self.assertIn(term,p)
            self.assertIn('一次列全' if rnd==1 else '问题清单冻结',p)
        p=adapters.member_prompt({'role':'reviewer','managed_tools':True,'unit':{}})
        self.assertIn(adapters.DEFAULT_REVIEW_BAR,p)

    def test_advisory_brief_has_only_identifiers_and_open_brief_has_locations(self):
        ledger=record_findings([],report([issue(),issue('advisory','secret advice')]),'r','u',1,'h','accepted')
        brief=adapters.prompt_view({'issue_history':ledger})['issue_history']
        self.assertEqual(brief[1],{**{k:ledger[1][k] for k in ('id','kind','status','criterion_ids')},'advisory':True})
        for key in ('counterexample','locations','spec_refs'):self.assertEqual(brief[0][key],ledger[0][key])

    def test_developer_repairs_only_open_blockers_and_reads_locations_first(self):
        ledger=record_findings([],report([issue(),issue('advisory','secret advice')]),'r','u',1,'h','accepted')
        p=adapters.member_prompt({'role':'developer','managed_tools':True,'round':2,'unit':{},'issue_history':ledger})
        for text in ('OPEN 的必须修','建议项不用改，也不要顺手改',
                     '先读 code_map 和 issue_history 里待解决问题指出的位置（files，有 locations 时按行号）',
                     '只在需要时再读其他文件；不要通读目录或整份规格'):
            self.assertIn(text,p)
        self.assertNotIn('secret advice',p);self.assertIn('value.txt:1-2',p)


class ReviewBarRules(unittest.TestCase):
    def setUp(self):
        self.t=tempfile.TemporaryDirectory();self.addCleanup(self.t.cleanup);self.base=Path(self.t.name)

    def test_preview_preserves_unit_bar_and_displays_default(self):
        raw=project(self.base,True);rules=normalize(raw,self.base)
        preview=prep.render_preview(rules,rules,self.base/'rules.json')
        self.assertIn('过线口径：默认（违反标准原文 / 可复现的错误 / 破坏下游才算必须修）',preview)
        raw['units'][0]['review_bar']='  按 C 的两个输入判断；额外边界只是建议。  '
        rules=normalize(raw,self.base);preview=prep.render_preview(rules,rules,self.base/'rules.json')
        self.assertEqual(rules['units'][0]['review_bar'],raw['units'][0]['review_bar'])
        self.assertIn('过线口径：'+raw['units'][0]['review_bar'],preview)
        raw['units'][0]['review_bar']=' '+('字'*600)+' ';normalize(raw,self.base)

    def test_registration_rejects_empty_long_nontext_or_reviewerless_bar(self):
        for n,bar in enumerate(('', '  ', '字'*601,None,7,[], 'valid but no reviewer')):
            with self.subTest(bar=str(bar)[:40]):
                base=self.base/str(n);base.mkdir();raw=project(base,bar!='valid but no reviewer')
                raw['units'][0]['review_bar']=bar
                with self.assertRaisesRegex(LoopError,'review_bar'):prepared(base,raw)

    def test_v1_does_not_gain_review_bar_field(self):
        raw=project(self.base,True);raw['schema_version']=1
        for key in ('security','execution_profiles','operation_budgets'):raw.pop(key)
        raw['limits']={};unit=raw['units'][0]
        for key in ('review_mode','build_profiles'):unit.pop(key)
        unit['gates']=[];unit['criteria'][0]['gate_ids']=[];unit['review_bar']='custom'
        with self.assertRaisesRegex(LoopError,'review_bar'):normalize(raw,self.base)


class SeverityEngine(unittest.TestCase):
    def setUp(self):
        self.t=tempfile.TemporaryDirectory();self.addCleanup(self.t.cleanup);self.base=Path(self.t.name)

    def scenario(self,name,max_repairs=4):
        raw=project(self.base,True)
        for agent in raw['agents'].values():agent['argv']=['{python}',str(FIXTURE),'--scenario',name]
        raw['units'][0]['max_repairs']=max_repairs
        raw['limits'].update(max_selftests=12,max_total_repairs=6,max_member_invocations=20,max_parallel=1)
        if name=='gate-only':
            path=Path(raw['source'])/'build.py'
            path.write_text(BUILD+"if Path('value.txt').read_text() in ('fixed-round-1','fixed-round-2'):raise SystemExit(1)\n")
        return raw

    def contexts(self,m,root):
        return [json.loads(p.read_text()) for p in (root/'runs'/m['run_id']/'units').glob('*/attempts/*/context.json')]

    def test_mixed_first_review_repairs_only_u1_and_never_hands_advice_to_developer(self):
        raw=self.scenario('mixed');raw['units'][0]['id']='U1'
        (Path(raw['source'])/'second.txt').write_text('initial')
        second=copy.deepcopy(raw['units'][0]);second.update(id='U2',writable_paths=['second.txt']);raw['units'].append(second)
        raw['completion']={'mode':'independent'}
        m,state,root,s,aid=execute_prepared(self.base,raw)
        self.assertEqual([m['units'][u]['result']['stop'] for u in ('U1','U2')],['PASSED','PASSED'])
        self.assertEqual([m['units'][u]['stats']['repairs'] for u in ('U1','U2')],[1,0])
        dev=next(c for c in self.contexts(m,root) if c['unit_id']=='U1' and c['role']=='developer' and c['round']==2)
        self.assertEqual([i['severity'] for i in dev['feedback']['issues']],['blocking'])
        self.assertNotIn('optional stricter checks',adapters.member_prompt(dev))
        self.assertEqual(m['budget']['repairs'],1)

    def test_advisory_only_passes_and_result_lists_round_criterion_description_location(self):
        m,state,root,s,aid=execute_prepared(self.base,self.scenario('advisory-only'))
        result=m['units']['check']['result'];self.assertEqual(result['stop'],'PASSED',result['reason'])
        self.assertEqual(m['budget'].get('repairs',0),0)
        self.assertEqual([i['status'] for i in result['advisory_findings']],['ADVISORY'])
        markdown=(root/'runs'/m['run_id']/'result.md').read_text()
        self.assertIn('#### 建议项（不阻断，待拍板人决定）',markdown)
        self.assertIn('第 1 轮 · C · optional stricter checks（位置：value.txt:1）',markdown)

    def test_round_three_with_no_known_blocker_closed_stops_even_after_old_reconfirmation(self):
        m,state,root,s,aid=execute_prepared(self.base,self.scenario('stalled-third'))
        result=m['units']['check']['result'];self.assertEqual(result['stop'],'NOT_MET')
        self.assertEqual(result['reason'],'停滞：本轮返修没有关掉任何已知的必须修问题（仍有 2 个），继续返修大概率白跑；已停下交拍板人决定')
        self.assertEqual(m['budget']['repairs'],2);self.assertEqual(len(result['history']),3)
        self.assertEqual(sum(i['status']=='OPEN' for i in result['history'][1]['issue_history']),2)
        self.assertEqual(sum(i['status']=='ADVISORY' for i in result['issue_history']),1)
        dev=next(c for c in self.contexts(m,root) if c['role']=='developer' and c['round']==3)
        self.assertNotIn('optional stricter checks',adapters.member_prompt(dev))

    def test_stagnation_precedes_repair_limit(self):
        m,state,root,s,aid=execute_prepared(self.base,self.scenario('stalled-second',1))
        result=m['units']['check']['result'];self.assertEqual(result['stop'],'NOT_MET')
        self.assertIn('停滞',result['reason']);self.assertEqual(m['budget']['repairs'],1)

    def test_failed_gates_without_open_blockers_do_not_trigger_stagnation(self):
        m,state,root,s,aid=execute_prepared(self.base,self.scenario('gate-only'))
        result=m['units']['check']['result'];self.assertEqual(result['stop'],'PASSED',result['reason'])
        self.assertEqual(m['budget']['repairs'],2);self.assertEqual(len(result['history']),3)
        self.assertEqual(result['issue_history'],[])

    def test_unknown_reconfirmation_is_not_an_open_problem_at_round_start(self):
        m,state,root,s,aid=execute_prepared(self.base,self.scenario('reconfirm-only'))
        result=m['units']['check']['result'];self.assertEqual(result['stop'],'PASSED',result['reason'])
        self.assertEqual(m['budget']['repairs'],3);self.assertEqual(len(result['history']),4)
        self.assertTrue(all(i['status']=='UNKNOWN' for i in result['history'][2]['issue_history']))


if __name__=='__main__':unittest.main()
