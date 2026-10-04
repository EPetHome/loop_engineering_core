"""Cross-patch contracts for review-first, severity, timing, maps and prompts; offline only."""
import copy
import json
import math
import re
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from helpers import BUNDLE, BUILD, Controller, create_prepared_run, execute_prepared, normalize, prep, prepared, project
from loop_engineering import adapters, engine
from loop_engineering.common import atomic_write, load_json
from loop_engineering.protocol import response_schema
from test_cost040 import REPAIR_GUIDE, REVIEW_GUIDE
from test_time_budget040 import Clock


def instruction_blocks():
    context = {'role': 'reviewer', 'managed_tools': True, 'protocol_repair_only': False, 'round': 1,
               'unit': {'review_scope': 'frozen', 'first_round': 'develop', 'max_repairs': 2,
                        'review_bar': '会让正确实现被判失败的算必须修；错误实现也能通过（检查不够严）的算建议，除非涉及标准里点名的核心行为。'},
               'code_map': None, 'developer_delivery': None}
    blocks = {}
    for name, role, rnd, first in (
            ('受管评审第 1 轮', 'reviewer', 1, 'develop'),
            ('受管评审第 2 轮（冻结）', 'reviewer', 2, 'develop'),
            ('受管开发第 1 轮', 'developer', 1, 'develop'),
            ('受管开发返修轮', 'developer', 2, 'develop'),
            ('先评审的第 1 轮评审', 'reviewer', 1, 'review')):
        c = copy.deepcopy(context)
        c.update(role=role, round=rnd)
        c['unit']['first_round'] = first
        if role == 'developer':
            c['developer_timeout_seconds'] = 2482
        # Keep every instruction, including authority/binding/evidence rules; only omit the JSON data.
        blocks[name] = adapters.member_prompt(c).split('\n\n{', 1)[0].rstrip()
    return blocks


class MergeContracts(unittest.TestCase):
    def setUp(self):
        t = tempfile.TemporaryDirectory()
        self.addCleanup(t.cleanup)
        self.base = Path(t.name)

    def severity_run(self, scenario):
        raw = project(self.base, True)
        for agent in raw['agents'].values():
            agent['argv'] = ['{python}', str(BUNDLE / 'tests040/fixtures/member_severity.py'), '--scenario', scenario]
        raw['units'][0].update(first_round='review', max_repairs=3)
        raw['limits'].update(max_total_repairs=4, max_selftests=12)
        return execute_prepared(self.base, raw)

    def timed_review_first(self, seconds):
        raw = project(self.base, True)
        raw['units'][0].update(first_round='review', max_seconds=seconds, stage_timeout_seconds=60, max_repairs=2)
        (Path(raw['source']) / 'build.py').write_text(
            BUILD + "if Path('value.txt').read_text() == 'initial': raise SystemExit(1)\n")
        state, root, draft = prepared(self.base, raw)
        rid, _, _ = create_prepared_run(state, root, draft)
        controller = Controller(root, rid)
        clock = Clock(controller.store.data['created_epoch'])
        calls = []
        original_gates = engine.UnitEngine.run_gates

        def run_job(owner, argv, code, job, stdin, timeout, idle, env, phase):
            c = load_json(Path(env['LOOP_CONTEXT']))
            calls.append((c, timeout))
            if c['role'] == 'developer':
                (code / 'value.txt').write_text('fixed')
            elif c['round'] == 1:
                clock.advance(2)
            report = {'attempt_id': c['attempt_id'], 'role': c['role'], 'candidate_hash': c['candidate_hash'],
                      'summary': 'OFFLINE review-first timing', 'blocked': False,
                      'criteria': [{'id': 'C', 'status': 'PASS', 'note': 'checked',
                                    'evidence': ['code:value.txt']}], 'issues': [], 'rule_gaps': []}
            job.mkdir(parents=True)
            atomic_write(job / 'stdout.log', json.dumps(report))
            return {'reason': 'ok', 'exit_code': 0}

        def gates(owner, manifest):
            original_gates(owner, manifest)
            if owner.round == 1:
                clock.advance(2)

        with patch('loop_engineering.engine.time.time', clock), patch.object(engine.UnitEngine, 'run_job', run_job), \
             patch.object(engine.UnitEngine, 'run_gates', gates), \
             patch('loop_engineering.engine.repair_time_reserve', wraps=engine.repair_time_reserve) as reserve:
            controller.execute()
        return load_json(root / 'runs' / rid / 'manifest.json'), calls, reserve

    def test_review_first_zero_developer_need_allows_any_positive_available_time(self):
        data, calls, reserve = self.timed_review_first(9.1)
        result = data['units']['check']['result']
        self.assertEqual(result['stop'], 'PASSED', result['reason'])
        self.assertEqual(result['history'][0]['timing'],
                         {'developer_seconds': 0, 'gate_seconds': 2, 'review_seconds': 2})
        self.assertEqual(reserve.call_args.args[1]['developer_seconds'], 0)
        self.assertEqual(math.ceil((2 + 2) * 1.25), 5)
        self.assertEqual([(c['role'], c['round']) for c, _ in calls],
                         [('reviewer', 1), ('developer', 2), ('reviewer', 2)])
        self.assertAlmostEqual(calls[1][1], .1, places=5)
        self.assertEqual(data['budget']['repairs'], 1)

    def test_review_first_nonpositive_available_time_does_not_schedule_repair(self):
        data, calls, reserve = self.timed_review_first(9)
        result = data['units']['check']['result']
        self.assertEqual(result['stop'], 'NOT_MET')
        self.assertIn('时间不够返修', result['reason'])
        self.assertIn('（0.0 分钟）', result['reason'])
        self.assertEqual(reserve.call_args.args[1]['developer_seconds'], 0)
        self.assertEqual([(c['role'], c['round']) for c, _ in calls], [('reviewer', 1)])
        self.assertEqual(data['budget'].get('repairs', 0), 0)

    def test_first_developer_after_review_gets_null_map_and_can_close_blockers(self):
        data, _, root, _, _ = self.severity_run('mixed')
        result = data['units']['check']['result']
        self.assertEqual(result['stop'], 'PASSED', result['reason'])
        contexts = [load_json(p) for p in (root / 'runs' / data['run_id'] / 'units/check/attempts').glob('*/context.json')]
        developer = next(c for c in contexts if c['role'] == 'developer')
        self.assertEqual(developer['round'], 2)
        self.assertIsNone(developer['code_map'])
        first_review = next(c for c in contexts if c['role'] == 'reviewer' and c['round'] == 1)
        self.assertIsNone(first_review['code_map'])
        self.assertIsNone(first_review['developer_delivery'])
        self.assertTrue(all(i['severity'] == 'blocking' and i['counterexample'] and i['locations']
                            for i in developer['feedback']['issues']))
        self.assertEqual([i['status'] for i in result['issue_history']], ['RESOLVED', 'ADVISORY'])
        self.assertEqual(result['history'][0]['timing']['developer_seconds'], 0)
        self.assertEqual(len(result['history']), 2)

    def test_review_first_stagnation_uses_first_review_open_snapshot(self):
        data, _, _, _, _ = self.severity_run('stalled-second')
        result = data['units']['check']['result']
        self.assertEqual(result['stop'], 'NOT_MET')
        self.assertEqual(result['reason'], '停滞：本轮返修没有关掉任何已知的必须修问题（仍有 2 个），继续返修大概率白跑；已停下交拍板人决定')
        self.assertEqual(len(result['history']), 2)
        self.assertIsNone(result['history'][0]['developer'])
        self.assertIsNotNone(result['history'][1]['developer'])
        self.assertEqual(sum(i['status'] == 'OPEN' for i in result['history'][0]['issue_history']), 2)
        self.assertEqual(data['budget']['repairs'], 1)

    def test_continue_filters_advisory_from_real_accepted_ledger_and_selected_round(self):
        data, _, root, _, _ = self.severity_run('stalled-second')
        result = data['units']['check']['result']
        advice = next(i for i in result['issue_history'] if i['status'] == 'ADVISORY')
        self.assertEqual(advice['severity'], 'advisory')
        self.assertTrue(Path(advice['source']['report_path']).is_file())
        for rnd in (None, 1):
            with self.subTest(from_round=rnd):
                out = self.base / f'continued-{rnd}.json'
                draft = prep.continue_plan(root, data['run_id'], 'next', out, from_round=rnd)
                plan = load_json(out)
                self.assertEqual(draft['carried_open_issues'], 2)
                self.assertEqual(draft['first_round'], 'develop')
                self.assertNotIn(advice['description'], plan['units'][0]['goal'])
                for item in result['issue_history']:
                    if item['status'] == 'OPEN':
                        self.assertIn(item['description'], plan['units'][0]['goal'])

    def test_combined_preview_keeps_bar_first_round_time_and_round_selftests(self):
        raw = project(self.base, True)
        raw['units'][0].update(review_bar='只按 C 的明示行为过线。', first_round='review', max_repairs=2,
                               max_seconds=7200, stage_timeout_seconds=3600, max_selftests=20)
        raw['limits']['max_selftests'] = 20
        rules = normalize(raw, self.base)
        preview = prep.render_preview(rules, rules, self.base / 'rules.json')
        for text in ('过线口径：只按 C 的明示行为过线。', '第 1 轮：只跑门禁和评审（不开发）',
                     '时限可容纳约 2 轮', '按 3 轮累计分配（7 / 14 / 20）'):
            self.assertIn(text, preview)

    def test_five_complete_instruction_blocks_are_consistent_and_not_duplicated(self):
        blocks = instruction_blocks()
        self.assertEqual(len(blocks), 5)
        for name, text in blocks.items():
            with self.subTest(name=name):
                self.assertIn('本次唯一权威', text)
                self.assertIn('最终回复只输出符合 response_schema', text)
                self.assertIn('内置 codex 由 CLI 自动保存最后回复', text)
                sentences = [s.strip() for s in re.split(r'(?<=[。！？])\s*|\n', text) if s.strip()]
                self.assertEqual(len(sentences), len(set(sentences)), '完整指令有重复句子')
                if '评审' in name:
                    self.assertIn(adapters.DEFAULT_REVIEW_BAR, text)
                    self.assertIn('以单元口径为准', text)
                    for field in ('severity', 'counterexample', 'locations', 'spec_refs'):
                        self.assertIn(field, text)
                    self.assertNotIn('交付时提供 code_map', text)
                else:
                    self.assertIn('按轮累计分配', text)
                    self.assertNotIn('自测次数按单元限额', text)
                    self.assertIn('code_map（最多 8000 字）', text)
        self.assertIn(REPAIR_GUIDE, blocks['受管开发返修轮'])
        self.assertIn(REVIEW_GUIDE, blocks['受管评审第 2 轮（冻结）'])
        self.assertIn('seconds_left', blocks['受管开发返修轮'])
        self.assertNotIn('本轮开发限时', blocks['受管开发第 1 轮'])
        self.assertIn('没有开发交付', blocks['先评审的第 1 轮评审'])
        self.assertIn('null', blocks['先评审的第 1 轮评审'])
        self.assertNotIn(REVIEW_GUIDE, blocks['先评审的第 1 轮评审'])

    def test_documentary_response_template_matches_runtime_schema(self):
        self.assertEqual(load_json(BUNDLE / 'engine/templates/member-response.schema.json'), response_schema())


if __name__ == '__main__':
    unittest.main()
