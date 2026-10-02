"""Iteration 03 evidence handoff counterexamples; only deterministic local reports."""
import copy
import html
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from loop_engineering.adapters import ENGINE_DIR, member_prompt
from loop_engineering.audit import audit
from loop_engineering.common import LoopError, atomic_json, atomic_write, digest, file_hash, load_json, tree_manifest
from loop_engineering.engine import Controller, UnitEngine
from loop_engineering.handoff import apply_resolutions, record_findings
from loop_engineering.protocol import response_schema, validate_report
from loop_engineering.rules import normalize
from loop_engineering.storage import Store, create_run
from loop_engineering.supervisor import recover

OLD_DOCUMENT = '# History\n\n## 0.2.0\nKeep the original clause, not a reconstructed summary.\n\n## 0.1.0\nFirst release evidence, unchanged.\n'


class HandoffRun:
    def __init__(self, directory):
        self.path = Path(directory).resolve()
        self.source, self.root = self.path / 'source', self.path / 'data'
        shutil.copytree(ENGINE_DIR / 'examples/demo_project', self.source)
        (self.source / 'docs').mkdir()
        (self.source / 'docs/history.md').write_text(OLD_DOCUMENT)
        self.raw = load_json(ENGINE_DIR / 'examples/demo.json')
        self.raw['source'] = str(self.source)
        self.raw['limits'].update(max_wall_seconds=120, max_member_invocations=20)
        self.raw['units'][0].update(gates=[], max_repairs=1, max_protocol_retries=0,
                                    writable_paths=['invites.py', 'docs/', 'data.bin', 'gone.py', 'new.py', 'empty/'])
        for criterion in self.raw['units'][0]['criteria']:
            criterion['gate_ids'] = []
        for agent in self.raw['agents'].values():
            agent.update(argv=[sys.executable, '-c', 'raise RuntimeError("unexpected member process")'], output='file')
        self.contexts, self.prompts = [], []

    def add_gate(self):
        self.raw['units'][0]['gates'] = [{'id': 'G', 'argv': [sys.executable, '-c', 'pass'],
                                        'timeout_seconds': 10, 'output_paths': []}]
        self.raw['units'][0]['criteria'][0]['gate_ids'] = ['G']

    def execute(self, action=None, gate_status=None):
        self.rules = normalize(self.raw, self.path)
        self.rid = create_run(self.root, self.rules)
        self.run = self.root / 'runs' / self.rid

        def job(engine, argv, code, job, stdin, timeout, idle, env, phase):
            if phase == 'testing':
                status = gate_status(engine.round) if gate_status else 'PASS'
                atomic_write(job / 'stdout.log', 'offline gate\n', readonly=True)
                atomic_write(job / 'stderr.log', '', readonly=True)
                engine.store.seal(job / 'stdout.log')
                engine.store.seal(job / 'stderr.log')
                return {'reason': {'PASS': 'ok', 'FAIL': 'nonzero_exit', 'UNKNOWN': 'timeout'}[status],
                        'exit_code': {'PASS': 0, 'FAIL': 1, 'UNKNOWN': None}[status]}
            context = load_json(job.parent / 'context.json')
            self.contexts.append(context)
            self.prompts.append(stdin)
            report = {'attempt_id': context['attempt_id'], 'role': context['role'],
                      'candidate_hash': context['candidate_hash'], 'summary': 'offline handoff fixture',
                      'blocked': False, 'issues': [], 'rule_gaps': [],
                      'criteria': [{'id': c['id'], 'status': 'PASS', 'note': 'fixture evidence',
                                    'evidence': ['code:invites.py']} for c in context['unit']['criteria']]}
            if action:
                action(context, report)
            atomic_json(Path(context['response_path']), report)
            return {'reason': 'ok', 'exit_code': 0}

        with patch.object(UnitEngine, 'run_job', job):
            Controller(self.root, self.rid).execute()
        self.data = load_json(self.run / 'manifest.json')
        self.result = self.data['units']['invite']['result']
        return self.data


def raise_findings(context, report):
    if context['role'] == 'developer':
        (Path(context['code_path']) / 'invites.py').write_text('value = %d\n' % context['round'])
    if context['role'] == 'reviewer' and context['round'] == 1:
        report['criteria'][0]['status'] = 'FAIL'
        report['issues'] = [{'criterion_id': report['criteria'][0]['id'], 'description': 'retain historical clauses',
                             'suggested_fix': 'compare the frozen old body'}]
        report['rule_gaps'] = ['historical evidence needs explicit verification']


def resolve_all(context, report, evidence=None):
    report['issue_resolutions'] = [{'id': item['id'], 'note': 'explicitly checked on this candidate',
                                    'evidence': evidence or ['code:invites.py']}
                                   for item in context['issue_history']]


class ComparisonTests(unittest.TestCase):
    def test_first_round_u5_style_document_preservation_needs_no_reconstruction_round(self):
        with tempfile.TemporaryDirectory() as directory:
            rig = HandoffRun(directory)
            old_bodies = []

            def action(c, report):
                comp = c['comparison']
                old = Path(comp['unit_input']['path']) / 'docs/history.md'
                old_bodies.append(old.read_text())
                self.assertEqual(old.read_text(), OLD_DOCUMENT)
                self.assertFalse(old.stat().st_mode & 0o222)
                if c['role'] == 'developer':
                    # The old body comes from the authorized frozen input, not
                    # from already edited current code or a second-round repair.
                    (Path(c['code_path']) / 'docs/history.md').write_text('# New handoff\n\n' + old.read_text())
                else:
                    self.assertEqual(comp['changed_from_input'], ['docs/history.md'])
                    self.assertEqual((Path(c['code_path']) / 'docs/history.md').read_text(), '# New handoff\n\n' + OLD_DOCUMENT)
                    diff = Path(comp['diff_index']['path']).read_text()
                    self.assertIn('+# New handoff', diff)
                    report['criteria'][0]['evidence'] = ['code:docs/history.md']

            data = rig.execute(action)
            self.assertEqual(data['result']['stop'], 'PASSED')
            self.assertEqual(len(old_bodies), 2)
            self.assertEqual(rig.result['stats']['repairs'], 0)
            for c in rig.contexts:
                comp = c['comparison']
                self.assertIsNone(comp['previous_candidate'])
                self.assertIsNone(comp['previous_review'])
                self.assertEqual(comp['changed_from_previous'], [])
                self.assertEqual(comp['unit_input']['hash'], c['unit_input_hash'])
                self.assertEqual(comp['current']['hash'], c['input_hash'])
                self.assertEqual(comp['current']['path'], c['code_path'])
            self.assertTrue(audit(rig.root, rig.rid)['integrity_ok'])

    def test_previous_business_candidate_and_original_review_reach_both_roles(self):
        with tempfile.TemporaryDirectory() as directory:
            rig = HandoffRun(directory)
            data = rig.execute(raise_findings)
            self.assertEqual(data['result']['stop'], 'PASSED')
            first = rig.result['history'][0]
            second = [c for c in rig.contexts if c['round'] == 2]
            self.assertEqual(len(second), 2)
            for c in second:
                comp = c['comparison']
                self.assertEqual(comp['previous_candidate'], first['candidate'])
                self.assertEqual(comp['previous_review'], load_json(Path(first['review_path']))['report'])
                self.assertEqual((Path(comp['previous_candidate']['path']) / 'invites.py').read_text(), 'value = 1\n')
                self.assertEqual(comp['changed_from_previous'], ['invites.py'] if c['role'] == 'reviewer' else [])
                self.assertEqual(comp['changed_from_input'], ['invites.py'])
                self.assertTrue(all(x['status'] == 'OPEN' for x in c['issue_history']))
            self.assertEqual({x['id'] for x in second[0]['issue_history']}, {x['id'] for x in second[1]['issue_history']})

    def test_previous_review_is_raw_accepted_report_not_gate_overridden_evaluation(self):
        with tempfile.TemporaryDirectory() as directory:
            rig = HandoffRun(directory)
            rig.add_gate()

            def action(c, report):
                raise_findings(c, report)
                if c['role'] == 'reviewer' and c['round'] == 1:
                    report['criteria'][0]['status'] = 'PASS'

            self.assertEqual(rig.execute(action, gate_status=lambda n: 'FAIL' if n == 1 else 'PASS')['result']['stop'], 'PASSED')
            for c in [c for c in rig.contexts if c['round'] == 2]:
                self.assertEqual(c['comparison']['previous_review']['criteria'][0]['status'], 'PASS')
                if c['role'] == 'developer':
                    self.assertEqual(c['feedback']['criteria'][0]['status'], 'FAIL')
            self.assertEqual(rig.result['history'][0]['evaluated'][0]['status'], 'FAIL')

    def test_comparison_records_add_delete_mode_directory_and_binary_without_omission(self):
        with tempfile.TemporaryDirectory() as directory:
            rig = HandoffRun(directory)
            (rig.source / 'gone.py').write_text('deleted\n')
            (rig.source / 'data.bin').write_bytes(b'\x00old\xff')

            def action(c, report):
                code = Path(c['code_path'])
                if c['role'] == 'developer':
                    (code / 'gone.py').unlink()
                    (code / 'new.py').write_text('new = True')
                    (code / 'empty').mkdir()
                    (code / 'data.bin').write_bytes(b'\x00new\xfe')
                    (code / 'invites.py').chmod(0o700)
                else:
                    comp = c['comparison']
                    self.assertEqual(comp['changed_from_input'], ['data.bin', 'empty/', 'gone.py', 'invites.py', 'new.py'])
                    self.assertEqual((Path(comp['unit_input']['path']) / 'data.bin').read_bytes(), b'\x00old\xff')
                    diff = Path(comp['diff_index']['path']).read_text()
                    self.assertIn('Binary content', diff)
                    self.assertIn('-deleted', diff)
                    self.assertIn('+new = True', diff)
                    self.assertIn('No newline at end of file', diff)
                    self.assertIn('"executable": true', diff)
                    self.assertIn('"path": "empty/"', diff)

            self.assertEqual(rig.execute(action)['result']['stop'], 'PASSED')

    def test_full_diff_can_exceed_prompt_budget_but_remains_indexed_and_sealed(self):
        with tempfile.TemporaryDirectory() as directory:
            rig = HandoffRun(directory)
            rig.raw['limits']['max_context_bytes'] = 25000
            old = ''.join('original clause %d\n' % n for n in range(4000))
            (rig.source / 'docs/large.md').write_text(old)

            def action(c, report):
                if c['role'] == 'developer':
                    (Path(c['code_path']) / 'docs/large.md').write_text(old.replace('original', 'revised'))
                else:
                    index = c['comparison']['diff_index']
                    path = Path(index['path'])
                    self.assertGreater(index['bytes'], c['limits']['max_context_bytes'])
                    self.assertEqual(index['sha256'], file_hash(path))
                    self.assertFalse(path.stat().st_mode & 0o222)
                    text = path.read_text()
                    self.assertIn('-original clause 3999\n', text)
                    self.assertIn('+revised clause 3999\n', text)
                    self.assertEqual((Path(c['comparison']['unit_input']['path']) / 'docs/large.md').read_text(), old)

            self.assertEqual(rig.execute(action)['result']['stop'], 'PASSED')
            self.assertTrue(all(len(p.encode()) < 25000 for p in rig.prompts))
            for c in rig.contexts:
                for criterion in c['unit']['criteria']:
                    self.assertIn(criterion['text'], rig.prompts[rig.contexts.index(c)])

    def test_context_budget_failure_blocks_before_call_instead_of_trimming_rules(self):
        with tempfile.TemporaryDirectory() as directory:
            rig = HandoffRun(directory)
            rig.raw['limits']['max_context_bytes'] = 64
            data = rig.execute()
            self.assertEqual(data['result']['stop'], 'BLOCKED')
            self.assertEqual(rig.contexts, [])
            self.assertIn('未静默截断', rig.result['reason'])
            self.assertEqual(data['budget']['member_invocations'], 0)

    def test_protocol_attempts_keep_the_previous_business_round_not_previous_attempt(self):
        with tempfile.TemporaryDirectory() as directory:
            rig = HandoffRun(directory)
            rig.raw['units'][0]['max_protocol_retries'] = 1

            def action(c, report):
                raise_findings(c, report)
                if c['role'] == 'reviewer' and c['round'] == 2 and not c['protocol_repair_only']:
                    report['issue_resolutions'] = [{'id': 'invented', 'note': 'invalid', 'evidence': ['code:invites.py']}]

            self.assertEqual(rig.execute(action)['result']['stop'], 'PASSED')
            second = [c for c in rig.contexts if c['round'] == 2 and c['role'] == 'reviewer']
            self.assertEqual(len(second), 2)
            self.assertEqual(second[0]['comparison']['previous_candidate'], second[1]['comparison']['previous_candidate'])
            self.assertEqual(second[0]['comparison']['previous_review'], second[1]['comparison']['previous_review'])
            self.assertEqual(second[0]['issue_history'], second[1]['issue_history'])
            self.assertEqual(rig.result['stats']['protocol_retries_by_role'], {'developer': 0, 'reviewer': 1})
            self.assertTrue(all(x['status'] == 'OPEN' for x in rig.result['issue_history']))

    def test_prompt_authorizes_only_indexed_local_old_bodies_and_explains_closure(self):
        for role in ('developer', 'reviewer'):
            prompt = member_prompt({'role': role})
            self.assertIn('明确允许只读 comparison 索引中的本运行本单元', prompt)
            self.assertIn('不得扩大到原项目、其它单元或其它运行', prompt)
            self.assertIn('不要从当前文件复原历史', prompt)
            self.assertIn('未裁剪规则或差异', prompt)
            self.assertIn('未再提及或某标准 PASS 不会自动关项', prompt)
            self.assertIn('仅评审可用当前候选有效证据显式解决已知 ID', prompt)


class IssueHistoryTests(unittest.TestCase):
    def test_silence_and_all_criteria_pass_do_not_close_issues_or_gaps(self):
        with tempfile.TemporaryDirectory() as directory:
            rig = HandoffRun(directory)
            self.assertEqual(rig.execute(raise_findings)['result']['stop'], 'PASSED')
            items = rig.result['issue_history']
            self.assertEqual({x['kind'] for x in items}, {'issue', 'rule_gap'})
            self.assertTrue(all(x['status'] == 'OPEN' and x['resolution'] is None for x in items))
            self.assertEqual(rig.result['rule_gaps'], ['historical evidence needs explicit verification'])
            self.assertTrue(audit(rig.root, rig.rid)['integrity_ok'])

    def test_explicit_review_resolution_has_current_file_hash_and_separate_history_views(self):
        with tempfile.TemporaryDirectory() as directory:
            rig = HandoffRun(directory)

            def action(c, report):
                raise_findings(c, report)
                if c['role'] == 'reviewer' and c['round'] == 2:
                    resolve_all(c, report)

            self.assertEqual(rig.execute(action)['result']['stop'], 'PASSED')
            self.assertEqual(rig.result['rule_gaps'], [])
            self.assertEqual(rig.result['historical_rule_gaps'], ['historical evidence needs explicit verification'])
            original = next(c for c in rig.contexts if c['round'] == 2 and c['role'] == 'developer')['issue_history']
            for item in rig.result['issue_history']:
                before = next(x for x in original if x['id'] == item['id'])
                self.assertEqual(item['source'], before['source'])
                self.assertEqual(item['occurrences'], before['occurrences'])
                self.assertEqual(item['status'], 'RESOLVED')
                resolution = item['resolution']
                self.assertEqual(resolution['candidate_hash'], rig.result['candidate']['hash'])
                self.assertTrue(resolution['applied'])
                evidence = resolution['evidence_index']['code:invites.py']
                self.assertEqual(evidence['sha256'], file_hash(Path(rig.result['candidate']['path']) / 'invites.py'))
                self.assertEqual(evidence['candidate_hash'], resolution['candidate_hash'])
            self.assertEqual(rig.result['history'][0]['review']['rule_gaps'], rig.result['historical_rule_gaps'])
            md = (rig.run / 'result.md').read_text()
            self.assertIn('当前未解决规则缺口：无', md)
            self.assertIn('历史提出、当前状态、处理依据', md)
            self.assertIn('historical evidence needs explicit verification', md)
            self.assertIn('RESOLVED', md)
            self.assertIn(html.escape(md), (rig.run / 'report.html').read_text())
            self.assertTrue(audit(rig.root, rig.rid)['integrity_ok'])

    def test_repeated_findings_keep_stable_id_original_source_and_all_occurrences(self):
        with tempfile.TemporaryDirectory() as directory:
            rig = HandoffRun(directory)

            def action(c, report):
                raise_findings(c, report)
                if c['role'] == 'developer' or c['round'] == 2:
                    report['issues'] = [{'criterion_id': 'S1', 'description': 'retain historical clauses',
                                         'suggested_fix': 'a later suggestion' if c['round'] == 2 else 'original suggestion'}]
                    report['rule_gaps'] = ['historical evidence needs explicit verification']

            self.assertEqual(rig.execute(action)['result']['stop'], 'PASSED')
            items = rig.result['issue_history']
            self.assertEqual(len(items), 2)
            for item in items:
                self.assertEqual(len(item['occurrences']), 4)
                self.assertEqual(item['source']['round'], 1)
                self.assertEqual(item['source']['role'], 'developer')
                self.assertEqual(item['status'], 'OPEN')
            issue = next(x for x in items if x['kind'] == 'issue')
            self.assertEqual(issue['suggested_fix'], 'original suggestion')
            self.assertEqual(issue['occurrences'][-1]['reported']['suggested_fix'], 'a later suggestion')
            self.assertTrue(audit(rig.root, rig.rid)['integrity_ok'])

    def test_developer_cannot_close_known_ids_and_unknown_review_ids_block(self):
        for role in ('developer', 'reviewer'):
            with self.subTest(role=role), tempfile.TemporaryDirectory() as directory:
                rig = HandoffRun(directory)

                def action(c, report):
                    raise_findings(c, report)
                    if c['role'] == role and c['round'] == 2:
                        resolve_all(c, report)
                        if role == 'reviewer':
                            report['issue_resolutions'][0]['id'] = 'invented'

                self.assertEqual(rig.execute(action)['result']['stop'], 'BLOCKED')
                self.assertIn('交付协议修复已耗尽', rig.result['reason'])
                self.assertTrue(all(x['status'] != 'RESOLVED' for x in rig.result['issue_history']))
                self.assertEqual(len(rig.result['issue_history']), 2)

    def test_related_gate_failure_rejects_resolution_even_with_current_code_and_review_pass(self):
        with tempfile.TemporaryDirectory() as directory:
            rig = HandoffRun(directory)
            rig.add_gate()

            def action(c, report):
                raise_findings(c, report)
                if c['role'] == 'reviewer' and c['round'] == 2:
                    resolve_all(c, report)

            data = rig.execute(action, gate_status=lambda round_number: 'PASS' if round_number == 1 else 'FAIL')
            self.assertEqual(data['result']['stop'], 'NOT_MET')
            self.assertEqual(rig.result['criteria'][0]['review_status'], 'PASS')
            self.assertEqual(rig.result['criteria'][0]['status'], 'FAIL')
            for item in rig.result['issue_history']:
                self.assertEqual(item['status'], 'OPEN')
                self.assertIsNone(item['resolution'])
                self.assertFalse(item['resolution_attempts'][-1]['applied'])
                self.assertIn('FAIL', item['state_note'])
            self.assertTrue(audit(rig.root, rig.rid)['integrity_ok'])

    def test_resolved_state_does_not_carry_to_later_candidate_even_when_hash_is_identical(self):
        for same_content in (False, True):
            with self.subTest(same_content=same_content), tempfile.TemporaryDirectory() as directory:
                rig = HandoffRun(directory)
                rig.raw['units'][0]['max_repairs'] = 2

                def action(c, report):
                    raise_findings(c, report)
                    if c['role'] == 'developer' and c['round'] == 3 and same_content:
                        (Path(c['code_path']) / 'invites.py').write_text('value = 2\n')
                    if c['role'] == 'reviewer' and c['round'] == 2:
                        resolve_all(c, report)
                        report['criteria'][1]['status'] = 'FAIL'

                self.assertEqual(rig.execute(action)['result']['stop'], 'PASSED')
                reviewer = next(c for c in rig.contexts if c['round'] == 3 and c['role'] == 'reviewer')
                self.assertTrue(all(x['status'] == 'UNKNOWN' for x in reviewer['issue_history']))
                self.assertTrue(all(x['status'] == 'UNKNOWN' for x in rig.result['issue_history']))
                for item in rig.result['issue_history']:
                    self.assertEqual(item['resolution']['round'], 2)
                    self.assertEqual(len(item['resolution_attempts']), 1)
                if same_content:
                    self.assertEqual(rig.result['candidate']['hash'], rig.result['history'][1]['candidate']['hash'])
                self.assertTrue(audit(rig.root, rig.rid)['integrity_ok'])

    def test_gate_unknown_stops_new_review_without_reusing_previous_resolution(self):
        with tempfile.TemporaryDirectory() as directory:
            rig = HandoffRun(directory)
            rig.raw['units'][0]['max_repairs'] = 2
            rig.add_gate()

            def action(c, report):
                raise_findings(c, report)
                if c['role'] == 'reviewer' and c['round'] == 2:
                    resolve_all(c, report)
                    report['criteria'][1]['status'] = 'FAIL'

            data = rig.execute(action, gate_status=lambda n: 'UNKNOWN' if n == 3 else 'PASS')
            self.assertEqual(data['result']['stop'], 'BLOCKED')
            self.assertFalse(any(c['role'] == 'reviewer' and c['round'] == 3 for c in rig.contexts))
            self.assertTrue(all(x['status'] == 'UNKNOWN' for x in rig.result['issue_history']))
            self.assertEqual(rig.result['criteria'][0]['status'], 'UNKNOWN')
            self.assertTrue(audit(rig.root, rig.rid)['integrity_ok'])

    def test_resolution_only_scratch_references_are_sealed_and_audited(self):
        with tempfile.TemporaryDirectory() as directory:
            rig = HandoffRun(directory)
            rig.raw['units'][0]['reviewer_exec'] = True

            def action(c, report):
                raise_findings(c, report)
                if c['role'] == 'reviewer' and c['round'] == 2:
                    (Path(c['scratch_path']) / 'proof.txt').write_text(c['candidate_hash'])
                    resolve_all(c, report, ['scratch:proof.txt'])

            self.assertEqual(rig.execute(action)['result']['stop'], 'PASSED')
            self.assertTrue(audit(rig.root, rig.rid)['integrity_ok'])
            evidence = rig.result['issue_history'][0]['resolution']['evidence_index']['scratch:proof.txt']
            path = Path(evidence['path'])
            self.assertFalse(path.stat().st_mode & 0o222)
            path.chmod(0o600)
            path.write_text('changed historical proof')
            self.assertFalse(audit(rig.root, rig.rid)['integrity_ok'])

    def test_audit_rejects_forged_current_closure_binding_without_rewriting_manifest(self):
        with tempfile.TemporaryDirectory() as directory:
            rig = HandoffRun(directory)

            def action(c, report):
                raise_findings(c, report)
                if c['role'] == 'reviewer' and c['round'] == 2:
                    resolve_all(c, report)

            data = rig.execute(action)
            item = data['units']['invite']['result']['issue_history'][0]
            item['resolution']['candidate_hash'] = data['units']['invite']['result']['history'][0]['candidate']['hash']
            atomic_json(rig.run / 'manifest.json', data)
            before = (rig.run / 'manifest.json').read_bytes()
            self.assertFalse(audit(rig.root, rig.rid)['integrity_ok'])
            self.assertEqual(before, (rig.run / 'manifest.json').read_bytes())

    def test_audit_checks_unit_input_and_old_candidate_trees_referenced_by_comparison(self):
        for target in ('unit_input', 'previous_candidate'):
            with self.subTest(target=target), tempfile.TemporaryDirectory() as directory:
                rig = HandoffRun(directory)
                rig.execute(raise_findings)
                c = next(c for c in rig.contexts if c['round'] == 2 and c['role'] == 'reviewer')
                path = Path(c['comparison'][target]['path']) / 'invites.py'
                path.chmod(0o600)
                path.write_text('corrupted historical body\n')
                self.assertFalse(audit(rig.root, rig.rid)['integrity_ok'])

    def test_recovery_retains_accepted_findings_when_unit_result_commit_was_lost(self):
        class Interrupted(BaseException):
            pass
        with tempfile.TemporaryDirectory() as directory:
            rig = HandoffRun(directory)
            with patch.object(Store, 'finish_unit', side_effect=Interrupted()):
                with self.assertRaises(Interrupted):
                    rig.execute(raise_findings)
            pending = load_json(rig.run / 'manifest.json')
            ledger = pending['units']['invite']['issue_history']
            self.assertEqual(len(ledger), 2)
            self.assertEqual(recover(rig.root, rig.rid)['stop'], 'BLOCKED')
            result = load_json(rig.run / 'units/invite/result.json')
            self.assertEqual(result['issue_history'], ledger)
            self.assertEqual(result['rule_gaps'], ['historical evidence needs explicit verification'])


    def test_recovery_keeps_raw_round_history_and_resolution_evidence_after_lost_unit_commit(self):
        class Interrupted(BaseException):
            pass
        with tempfile.TemporaryDirectory() as directory:
            rig = HandoffRun(directory)

            def action(c, report):
                raise_findings(c, report)
                if c['role'] == 'reviewer' and c['round'] == 2:
                    resolve_all(c, report)

            with patch.object(Store, 'finish_unit', side_effect=Interrupted()):
                with self.assertRaises(Interrupted):
                    rig.execute(action)
            pending = load_json(rig.run / 'manifest.json')['units']['invite']
            self.assertEqual(len(pending['history']), 2)
            self.assertEqual(recover(rig.root, rig.rid)['finalization']['status'], 'UNKNOWN')
            result = load_json(rig.run / 'units/invite/result.json')
            self.assertEqual(result['history'], pending['history'])
            self.assertEqual(result['issue_history'], pending['issue_history'])
            self.assertEqual(result['rule_gaps'], [])
            self.assertTrue(audit(rig.root, rig.rid)['integrity_ok'])


class ResolutionProtocolTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.code = Path(self.temp.name)
        (self.code / 'x.py').write_text('current = True\n')
        self.context = {'attempt_id': 'current', 'role': 'reviewer', 'candidate_hash': 'current-hash',
                        'unit': {'criteria': [{'id': 'S1', 'gate_ids': ['G']}]},
                        'issue_history': [{'id': 'known'}]}
        self.report = {'attempt_id': 'current', 'role': 'reviewer', 'candidate_hash': 'current-hash',
                       'summary': 'current proof', 'blocked': False, 'issues': [], 'rule_gaps': [],
                       'criteria': [{'id': 'S1', 'status': 'PASS', 'note': 'current evidence', 'evidence': ['code:x.py']}]}
        self.gates = {'G': {'status': 'PASS', 'candidate_hash': 'current-hash'}}

    def tearDown(self):
        self.temp.cleanup()

    def test_optional_schema_and_legacy_response_unchanged(self):
        self.assertIn('issue_resolutions', response_schema()['properties'])
        self.assertNotIn('issue_resolutions', response_schema()['required'])
        self.assertEqual(validate_report(self.report, self.context, self.code, self.gates), self.report)
        for role in ('developer', 'reviewer'):
            self.context.update(role=role, candidate_hash='' if role == 'developer' else 'current-hash')
            self.report.update(role=role, candidate_hash=self.context['candidate_hash'], issue_resolutions=[])
            validate_report(self.report, self.context, self.code, self.gates)

    def test_unknown_duplicate_empty_noncurrent_or_malformed_resolution_is_rejected(self):
        valid = {'id': 'known', 'note': 'checked now', 'evidence': ['code:x.py']}
        cases = [None, 'known', [dict(valid, id='unknown')], [valid, valid], [dict(valid, evidence=[])],
                 [dict(valid, evidence=['code:../old/x.py'])], [dict(valid, evidence=['code:' + str(self.code / 'x.py')])],
                 [dict(valid, evidence=['gate:missing'])], [dict(valid, evidence=['scratch:old.txt'])],
                 [dict(valid, note='')], [dict(valid, note=123)], [dict(valid, evidence='code:x.py')],
                 [dict(valid, candidate_hash='old-hash')]]
        for proposed in cases:
            with self.subTest(proposed=proposed):
                report = dict(self.report, issue_resolutions=copy.deepcopy(proposed))
                with self.assertRaises(LoopError):
                    validate_report(report, self.context, self.code, self.gates)

    def test_old_gate_and_old_response_hash_cannot_close_known_id(self):
        self.report['issue_resolutions'] = [{'id': 'known', 'note': 'checked', 'evidence': ['gate:G']}]
        self.gates['G']['candidate_hash'] = 'previous-hash'
        with self.assertRaises(LoopError):
            validate_report(self.report, self.context, self.code, self.gates)
        self.report['issue_resolutions'][0]['evidence'] = ['code:x.py']
        self.report['candidate_hash'] = 'previous-hash'
        with self.assertRaises(LoopError):
            validate_report(self.report, self.context, self.code, self.gates)

    def test_unknown_missing_or_stale_related_gate_leaves_unknown_not_resolved(self):
        report = dict(self.report, issue_resolutions=[{'id': 'known', 'note': 'checked', 'evidence': ['code:x.py']}])
        history = [{'id': 'known', 'criterion_ids': ['S1'], 'status': 'OPEN',
                    'resolution': None, 'resolution_attempts': []}]
        index = {'code:x.py': {'candidate_hash': 'current-hash', 'path': str(self.code / 'x.py'),
                               'sha256': file_hash(self.code / 'x.py')}}
        for gates in ({}, {'G': {'status': 'UNKNOWN', 'candidate_hash': 'current-hash'}},
                      {'G': {'status': 'PASS', 'candidate_hash': 'old-hash'}}):
            with self.subTest(gates=gates):
                result = apply_resolutions(history, report, self.context['unit'], gates, 'current-hash', 2, 'accepted', index)
                self.assertEqual(result[0]['status'], 'UNKNOWN')
                self.assertIsNone(result[0]['resolution'])
                self.assertFalse(result[0]['resolution_attempts'][0]['applied'])

    def test_same_description_on_different_criteria_remains_distinct_and_inputs_are_not_mutated(self):
        report = copy.deepcopy(self.report)
        report['issues'] = [{'criterion_id': c, 'description': 'same wording', 'suggested_fix': 'verify'} for c in ('S1', 'S2')]
        report['rule_gaps'] = ['same wording']
        original = copy.deepcopy(report)
        history = record_findings([], report, 'run', 'unit', 1, 'candidate', 'accepted')
        self.assertEqual(len(history), 3)
        self.assertEqual(len({x['id'] for x in history}), 3)
        self.assertEqual(report, original)
        before = copy.deepcopy(history)
        record_findings(history, report, 'run', 'unit', 2, 'next', 'accepted-next')
        self.assertEqual(history, before)


if __name__ == '__main__':
    unittest.main()
