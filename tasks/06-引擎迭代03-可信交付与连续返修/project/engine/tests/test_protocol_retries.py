"""U1 回归测试：按角色修复交付格式，证据规则保持严格；不调用模型。"""
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from loop_engineering.adapters import ENGINE_DIR, member_prompt
from loop_engineering.common import LoopError, load_json
from loop_engineering.engine import Controller
from loop_engineering.protocol import validate_report
from loop_engineering.rules import normalize
from loop_engineering.storage import create_run


class ProtocolRetryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='loop-role-retries-')
        self.path = Path(self.temp.name)
        self.root, self.source = self.path / 'data', self.path / 'source'
        shutil.copytree(ENGINE_DIR / 'examples/demo_project', self.source)
        self.raw = load_json(ENGINE_DIR / 'examples/demo.json')
        self.raw['source'] = str(self.source)
        self.raw['limits']['max_wall_seconds'] = 60
        self.raw['units'][0].update(max_repairs=0, max_seconds=55)

    def tearDown(self):
        self.temp.cleanup()

    def execute(self, developer='success', reviewer='success', maximum=1, repairs=0):
        self.raw['agents']['dev']['argv'][-1] = developer
        self.raw['agents']['review']['argv'][-1] = reviewer
        self.raw['units'][0].update(max_protocol_retries=maximum, max_repairs=repairs)
        rid = create_run(self.root, normalize(self.raw, self.path))
        self.run = self.root / 'runs' / rid
        Controller(self.root, rid).execute()
        self.data = load_json(self.run / 'manifest.json')
        self.unit = self.data['units']['invite']
        return self.data['result']['stop']

    def assert_retries(self, expected):
        stats = self.unit['stats']
        self.assertIs(type(stats['protocol_retries']), int)
        self.assertEqual(stats['protocol_retries'], sum(expected.values()))
        self.assertEqual(stats['protocol_retries_by_role'], expected)
        self.assertEqual(self.unit['result']['stats'], stats)
        result = load_json(self.run / 'units/invite/result.json')
        self.assertEqual(result['stats'], stats)

    def test_initial_stats_include_zero_counts_for_both_roles(self):
        rid = create_run(self.root, normalize(self.raw, self.path))
        data = load_json(self.root / 'runs' / rid / 'manifest.json')
        stats = data['units']['invite']['stats']
        self.assertIs(type(stats['protocol_retries']), int)
        self.assertEqual(stats['protocol_retries'], 0)
        self.assertEqual(stats['protocol_retries_by_role'], {'developer': 0, 'reviewer': 0})

    def test_developer_retry_does_not_use_reviewer_allowance(self):
        self.assertEqual(self.execute('format', 'format', maximum=1), 'PASSED')
        self.assert_retries({'developer': 1, 'reviewer': 1})
        self.assertEqual(self.unit['stats']['member_invocations'], 4)
        self.assertEqual(self.unit['stats']['repairs'], 0)
        for role in ('developer', 'reviewer'):
            contexts = [load_json(p) for p in self.run.glob('units/invite/attempts/' + role + '-*/context.json')]
            self.assertEqual(len(contexts), 2)
            self.assertEqual(sorted(c['protocol_repair_only'] for c in contexts), [False, True])

    def test_each_role_stops_after_its_own_allowance(self):
        cases = [
            ('duplicate', 'success', {'developer': 1, 'reviewer': 0}, 2),
            ('success', 'duplicate', {'developer': 0, 'reviewer': 1}, 3),
            ('format', 'duplicate', {'developer': 1, 'reviewer': 1}, 4),
        ]
        for developer, reviewer, expected, calls in cases:
            with self.subTest(developer=developer, reviewer=reviewer):
                self.assertEqual(self.execute(developer, reviewer, maximum=1), 'BLOCKED')
                self.assert_retries(expected)
                self.assertEqual(self.unit['stats']['member_invocations'], calls)
                self.assertIn('交付协议修复已耗尽', self.unit['result']['reason'])

    def test_zero_allowance_does_not_schedule_a_retry(self):
        for developer, reviewer, calls in [('format', 'success', 1), ('success', 'format', 2)]:
            with self.subTest(developer=developer, reviewer=reviewer):
                self.assertEqual(self.execute(developer, reviewer, maximum=0), 'BLOCKED')
                self.assert_retries({'developer': 0, 'reviewer': 0})
                self.assertEqual(self.unit['stats']['member_invocations'], calls)

    def test_valid_deliveries_keep_zero_role_counts(self):
        self.assertEqual(self.execute(), 'PASSED')
        self.assert_retries({'developer': 0, 'reviewer': 0})
        self.assertEqual(self.unit['stats']['member_invocations'], 2)

    def test_role_allowance_is_not_reset_by_business_repairs(self):
        cases = [
            ('format', 'unknown', {'developer': 1, 'reviewer': 0}, 4),
            ('always-fail', 'format', {'developer': 0, 'reviewer': 1}, 5),
        ]
        for developer, reviewer, expected, calls in cases:
            with self.subTest(developer=developer, reviewer=reviewer):
                self.assertEqual(self.execute(developer, reviewer, maximum=1, repairs=1), 'BLOCKED')
                self.assert_retries(expected)
                self.assertEqual(self.unit['stats']['repairs'], 1)
                self.assertEqual(self.unit['stats']['member_invocations'], calls)
                self.assertIn('交付协议修复已耗尽', self.unit['result']['reason'])


class EvidenceRuleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='loop-evidence-rules-')
        self.code = Path(self.temp.name)
        (self.code / 'x.py').write_text('x = 1\n', encoding='utf-8')
        self.gates = {'G1': {'status': 'PASS'}}

    def tearDown(self):
        self.temp.cleanup()

    def delivery(self, role, evidence):
        context = {'attempt_id': 'current', 'role': role,
                   'candidate_hash': 'current-hash' if role == 'reviewer' else '',
                   'unit': {'criteria': [{'id': 'S1'}]}}
        report = {'attempt_id': context['attempt_id'], 'role': role,
                  'candidate_hash': context['candidate_hash'], 'summary': '证据校验回归测试',
                  'blocked': False, 'issues': [], 'rule_gaps': [],
                  'criteria': [{'id': 'S1', 'status': 'PASS', 'note': '本地测试', 'evidence': evidence}]}
        return report, context

    def test_developer_cannot_reference_even_an_existing_gate(self):
        report, context = self.delivery('developer', ['code:x.py', 'gate:G1'])
        with self.assertRaises(LoopError):
            validate_report(report, context, self.code, self.gates)

    def test_both_roles_reject_other_evidence_and_nonrelative_code_paths(self):
        refs = ['/tmp/report.json', 'workspace/report.json', 'https://example.invalid/result',
                'stdout.log', 'log:stdout.log', 'code:/tmp/x.py', 'code:../x.py']
        for role in ('developer', 'reviewer'):
            for ref in refs:
                with self.subTest(role=role, evidence=ref):
                    report, context = self.delivery(role, ['code:x.py', ref])
                    with self.assertRaises(LoopError):
                        validate_report(report, context, self.code, self.gates)

    def test_valid_references_remain_accepted(self):
        for role in ('developer', 'reviewer'):
            with self.subTest(role=role):
                evidence = ['code:x.py']
                if role == 'reviewer':
                    evidence.append('gate:G1')
                report, context = self.delivery(role, evidence)
                self.assertEqual(validate_report(report, context, self.code, self.gates), report)

    def test_member_prompt_explains_evidence_for_both_roles(self):
        for role in ('developer', 'reviewer'):
            with self.subTest(role=role):
                prompt = member_prompt({'role': role})
                self.assertIn('evidence 数组只接受 code:<项目内相对路径> 和 gate:<门禁ID> 两种引用。', prompt)
                self.assertIn('开发方不得写 gate: 引用', prompt)
                self.assertIn('自己跑过的测试写在 note 里', prompt)
                self.assertIn('其他路径（绝对路径、工作区路径）、网址、日志位置不放进 evidence，写在 note 里。', prompt)
