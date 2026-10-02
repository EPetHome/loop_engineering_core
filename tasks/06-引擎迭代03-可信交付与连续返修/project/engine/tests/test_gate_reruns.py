"""U3 回归：限次重跑、逐次取证和候选返修隔离；仅使用本地离线桩。"""
import json
from pathlib import Path
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from loop_engineering.adapters import ENGINE_DIR
from loop_engineering.audit import audit
from loop_engineering.common import LoopError, file_hash, load_json
from loop_engineering.engine import Controller, gate_failure_reason
from loop_engineering.rules import normalize
from loop_engineering.storage import create_run


GATE = r'''
import json, os, sys, time
from pathlib import Path
plan_path, gid, code, workspace = sys.argv[1:]
plan_path = Path(plan_path)
plan = json.loads(plan_path.read_text(encoding='utf-8'))[gid]
counter = plan_path.parent / ('count-' + gid)
n = int(counter.read_text()) if counter.exists() else 0
counter.write_text(str(n + 1))
outcome = plan[min(n, len(plan) - 1)]
assert Path.cwd() == Path(code)
assert Path(os.environ['HOME']) == Path(workspace) / 'home'
# Every execution, including reruns, must start with clean code outputs and HOME.
output, home_marker = Path('tmp-output'), Path(os.environ['HOME']) / 'marker'
assert not output.exists()
assert not home_marker.exists()
output.mkdir()
(output / 'marker.txt').write_text(str(n + 1))
home_marker.write_text(str(n + 1))
print('execution=' + str(n + 1), flush=True)
for line in outcome.get('stdout', []):
    print(line, flush=True)
for line in outcome.get('stderr', []):
    print(line, file=sys.stderr, flush=True)
if outcome.get('sleep'):
    time.sleep(outcome['sleep'])
if outcome.get('mutate'):
    Path('invites.py').write_text('tampered = True\n')
sys.exit(outcome['exit_code'])
'''


def fail(reason=None):
    return {'exit_code': 1, 'stdout': [] if reason is None else ['LOOP_FAIL_REASON=' + reason]}


def passed():
    return {'exit_code': 0}


class GateRerunRuleTests(unittest.TestCase):
    def setUp(self):
        self.raw = load_json(ENGINE_DIR / 'examples/demo.json')
        self.gate = self.raw['units'][0]['gates'][0]

    def test_default_is_zero_and_input_rule_is_not_mutated(self):
        rule = normalize(self.raw, ENGINE_DIR / 'examples')
        self.assertEqual(rule['units'][0]['gates'][0]['max_reruns'], 0)
        self.assertNotIn('max_reruns', self.gate)

    def test_accepts_only_integers_zero_through_five(self):
        for value in range(6):
            with self.subTest(value=value):
                self.gate['max_reruns'] = value
                rule = normalize(self.raw, ENGINE_DIR / 'examples')
                self.assertEqual(rule['units'][0]['gates'][0]['max_reruns'], value)
        for value in (True, False, 1.0, 1.5, '1', -1, 6, None):
            with self.subTest(value=value):
                self.gate['max_reruns'] = value
                with self.assertRaisesRegex(LoopError, 'max_reruns'):
                    normalize(self.raw, ENGINE_DIR / 'examples')


class GateFailureReasonTests(unittest.TestCase):
    def test_last_stdout_marker_trimming_fallback_and_character_limit(self):
        cases = [
            (b'noise\nLOOP_FAIL_REASON=first\nLOOP_FAIL_REASON=  last  \r\nfooter\n', 'last'),
            (b' LOOP_FAIL_REASON=not-a-marker\nnoise LOOP_FAIL_REASON=other\n', 'unspecified'),
            (b'no marker\n', 'unspecified'),
            (b'LOOP_FAIL_REASON=first\nLOOP_FAIL_REASON= \t', 'unspecified'),
            (('LOOP_FAIL_REASON=  ' + '原' * 250 + '  \n').encode('utf-8'), '原' * 200),
            (b'invalid-utf8=\xff\nLOOP_FAIL_REASON=decoded\n', 'decoded'),
        ]
        with tempfile.TemporaryDirectory(prefix='loop-gate-reason-') as temp:
            stdout = Path(temp) / 'stdout.log'
            for raw, expected in cases:
                with self.subTest(expected=expected):
                    stdout.write_bytes(raw)
                    self.assertEqual(gate_failure_reason(stdout), expected)


class GateRerunTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='loop-gate-reruns-')
        self.path = Path(self.temp.name).resolve()
        self.root, self.source = self.path / 'data', self.path / 'source'
        shutil.copytree(ENGINE_DIR / 'examples/demo_project', self.source)
        self.raw = load_json(ENGINE_DIR / 'examples/demo.json')
        self.raw['source'] = str(self.source)
        self.raw['limits']['max_wall_seconds'] = 60
        self.raw['units'][0].update(max_repairs=0, max_protocol_retries=0, max_seconds=55)
        for agent in self.raw['agents'].values():
            agent['argv'][-1] = 'success'
        self.stub, self.plan = self.path / 'gate.py', self.path / 'plan.json'
        self.stub.write_text(GATE, encoding='utf-8')

    def tearDown(self):
        self.temp.cleanup()

    def configure(self, plan, maximum=None, repairs=0, developer='success'):
        self.plan.write_text(json.dumps(plan, ensure_ascii=False), encoding='utf-8')
        unit = self.raw['units'][0]
        unit['gates'] = [
            {'id': gid, 'argv': ['{python}', str(self.stub), str(self.plan), gid, '{code}', '{workspace}'],
             'timeout_seconds': 10, 'output_paths': ['tmp-output/']}
            for gid in plan
        ]
        if maximum is not None:
            for gate in unit['gates']:
                gate['max_reruns'] = maximum
        unit['criteria'][0]['gate_ids'] = list(plan)
        unit['max_repairs'] = repairs
        self.raw['agents']['dev']['argv'][-1] = developer

    def execute(self):
        self.rid = create_run(self.root, normalize(self.raw, self.path))
        self.run = self.root / 'runs' / self.rid
        Controller(self.root, self.rid).execute()
        self.data = load_json(self.run / 'manifest.json')
        self.unit = self.data['units']['invite']
        self.result = self.unit['result']
        self.md = (self.run / 'result.md').read_text(encoding='utf-8')
        self.assertEqual(load_json(self.run / 'units/invite/result.json'), self.result)
        return self.data['result']['stop']

    def record(self, gid='G1', round_number=1):
        return load_json(self.run / 'units/invite/gates' / f'r{round_number:03d}-{gid}' / 'evidence.json')

    def test_initial_stats_include_zero_gate_reruns(self):
        rid = create_run(self.root, normalize(self.raw, self.path))
        stats = load_json(self.root / 'runs' / rid / 'manifest.json')['units']['invite']['stats']
        self.assertIs(type(stats['gate_reruns']), int)
        self.assertEqual(stats['gate_reruns'], 0)

    def test_default_does_not_retry_and_keeps_original_paths_and_fields(self):
        self.configure({'G1': [fail(), passed()]})
        self.assertEqual(self.execute(), 'NOT_MET')
        record = self.record()
        location = self.run / 'units/invite/gates/r001-G1'
        code = self.root / 'checkouts' / self.rid / 'invite/gate-r001-G1'
        self.assertEqual(record['stdout'], str(location / 'job/stdout.log'))
        self.assertEqual(record['stderr'], str(location / 'job/stderr.log'))
        self.assertEqual(record['receipt'], load_json(location / 'job/receipt.json'))
        self.assertEqual(record['argv'][-2:], [str(code), str(location)])
        self.assertEqual(record['status'], 'FAIL')
        self.assertEqual(record['candidate_hash'], self.result['candidate']['hash'])
        self.assertEqual(record['rule_hash'], self.data['rule_hash'])
        self.assertEqual(record['input_hash'], self.unit['input_hash'])
        self.assertEqual(record['reruns'], 0)
        self.assertFalse(record['passed_after_rerun'])
        self.assertIsNone(record['repeated_reason'])
        self.assertEqual(record['attempts'], [
            {'attempt': 1, 'status': 'FAIL', 'exit_code': 1, 'reason': 'unspecified',
             'stdout': record['stdout'], 'stderr': record['stderr']}
        ])
        self.assertFalse((location / 'attempt-002').exists())
        self.assertEqual(self.unit['stats']['gate_reruns'], 0)
        self.assertEqual((self.path / 'count-G1').read_text(), '1')

    def test_rerun_pass_keeps_all_logs_and_exposes_attempts_to_reviewer_and_result(self):
        success = {'exit_code': 0, 'stdout': ['LOOP_FAIL_REASON=ignored-on-success']}
        self.configure({'G1': [fail('json-invalid'), success]}, maximum=1)
        self.assertEqual(self.execute(), 'PASSED')
        record = self.record()
        self.assertEqual([a['status'] for a in record['attempts']], ['FAIL', 'PASS'])
        self.assertEqual([a['attempt'] for a in record['attempts']], [1, 2])
        self.assertEqual([a['exit_code'] for a in record['attempts']], [1, 0])
        self.assertEqual([a['reason'] for a in record['attempts']], ['json-invalid', None])
        self.assertEqual(record['reruns'], 1)
        self.assertTrue(record['passed_after_rerun'])
        self.assertIsNone(record['repeated_reason'])
        self.assertEqual(self.unit['stats']['gate_reruns'], 1)
        for stream in ('stdout', 'stderr'):
            logs = [Path(a[stream]) for a in record['attempts']]
            self.assertNotEqual(logs[0], logs[1])
            self.assertEqual(record[stream], str(logs[-1]))
            for log in logs:
                self.assertEqual(self.data['integrity'][log.relative_to(self.run).as_posix()], file_hash(log))
        self.assertIn('json-invalid', Path(record['attempts'][0]['stdout']).read_text())
        self.assertIn('execution=2', Path(record['stdout']).read_text())
        self.assertEqual(record['receipt'], load_json(Path(record['stdout']).parent / 'receipt.json'))
        context = load_json(next(self.run.glob('units/invite/attempts/reviewer-*/context.json')))
        self.assertEqual(context['gate_evidence']['G1'], record)
        self.assertEqual(self.result['evidence']['gate:G1']['attempts'], record['attempts'])
        self.assertIn('重跑后通过（不是一次通过）', self.md)
        self.assertIn('| 1 | FAIL | 1 | json-invalid |', self.md)
        self.assertIn('| 2 | PASS | 0 | — |', self.md)
        self.assertTrue(audit(self.root, self.rid)['integrity_ok'])

    def assert_suffixed_gate_isolated_from_rerun(self, order):
        plan = {'G1': [fail('needs-rerun'), passed()], 'G1-a002': [passed()]}
        self.configure({gid: plan[gid] for gid in order}, maximum=1)
        self.assertEqual(self.execute(), 'PASSED')
        rerun, suffixed = self.record('G1'), self.record('G1-a002')
        self.assertEqual([a['status'] for a in rerun['attempts']], ['FAIL', 'PASS'])
        self.assertEqual([a['status'] for a in suffixed['attempts']], ['PASS'])
        self.assertTrue(rerun['passed_after_rerun'])
        self.assertEqual(self.unit['stats']['gate_reruns'], 1)
        self.assertEqual((self.path / 'count-G1').read_text(), '2')
        self.assertEqual((self.path / 'count-G1-a002').read_text(), '1')
        checkout = self.root / 'checkouts' / self.rid / 'invite'
        codes = []
        for gid in order:
            record = self.record(gid)
            for execution in record['attempts']:
                job = Path(execution['stdout']).parent
                code = Path(load_json(job / 'job.json')['cwd'])
                codes.append(code)
                if execution['attempt'] == 1:
                    self.assertEqual(code, checkout / f'gate-r001-{gid}')
                    self.assertEqual(job, self.run / 'units/invite/gates' / f'r001-{gid}' / 'job')
                else:
                    self.assertEqual(code, checkout / 'gate-reruns/r001-G1/attempt-002')
                # All independently created outputs still exist and are not overwritten.
                self.assertEqual((code / 'tmp-output/marker.txt').read_text(), str(execution['attempt']))
                self.assertIn('execution=' + str(execution['attempt']), Path(execution['stdout']).read_text())
        self.assertEqual(len(set(codes)), 3)
        self.assertFalse(any(a.is_relative_to(b) for a in codes for b in codes if a != b))
        context = load_json(next(self.run.glob('units/invite/attempts/reviewer-*/context.json')))
        self.assertEqual(context['gate_evidence'], {'G1': rerun, 'G1-a002': suffixed})
        self.assertTrue(audit(self.root, self.rid)['integrity_ok'])

    def test_suffixed_gate_first_execution_does_not_collide_with_later_rerun(self):
        self.assert_suffixed_gate_isolated_from_rerun(['G1-a002', 'G1'])

    def test_rerun_does_not_collide_with_later_suffixed_gate_first_execution(self):
        self.assert_suffixed_gate_isolated_from_rerun(['G1', 'G1-a002'])

    def test_same_reason_twice_stops_before_unused_reruns(self):
        self.configure({'G1': [fail('same'), fail('same'), passed()]}, maximum=3)
        self.assertEqual(self.execute(), 'NOT_MET')
        record = self.record()
        self.assertEqual(len(record['attempts']), 2)
        self.assertEqual(record['status'], 'FAIL')
        self.assertEqual(record['repeated_reason'], 'same')
        self.assertFalse(record['passed_after_rerun'])
        self.assertEqual(self.unit['stats']['gate_reruns'], 1)
        self.assertEqual((self.path / 'count-G1').read_text(), '2')
        self.assertIn('同一原因出现两次，停止重跑：same', self.md)
        self.assertIn('| 2 | FAIL | 1 | same |', self.md)

    def test_repeated_reason_is_shared_between_gates_even_after_one_passes(self):
        self.configure({'G1': [fail('shared'), passed()], 'G2': [fail('shared'), passed()]}, maximum=1)
        self.assertEqual(self.execute(), 'NOT_MET')
        self.assertTrue(self.record('G1')['passed_after_rerun'])
        second = self.record('G2')
        self.assertEqual(len(second['attempts']), 1)
        self.assertEqual(second['status'], 'FAIL')
        self.assertEqual(second['repeated_reason'], 'shared')
        self.assertEqual(self.unit['stats']['gate_reruns'], 1)
        self.assertIn('第 1 轮 · G2：最终 FAIL', self.md)
        self.assertIn('同一原因出现两次，停止重跑：shared', self.md)

    def test_repairs_restart_all_gates_and_reasons_without_changing_old_evidence(self):
        self.configure({'G1': [fail('repair'), fail('repair'), fail('repair'), passed()],
                        'G2': [passed(), passed()]}, maximum=1, repairs=1, developer='repair')
        self.assertEqual(self.execute(), 'PASSED')
        first, second = self.record(), self.record(round_number=2)
        self.assertEqual(first['status'], 'FAIL')
        self.assertEqual(first['repeated_reason'], 'repair')
        self.assertEqual([a['status'] for a in second['attempts']], ['FAIL', 'PASS'])
        self.assertEqual([a['attempt'] for a in second['attempts']], [1, 2])
        self.assertIsNone(second['repeated_reason'])
        self.assertEqual(self.record('G2')['attempts'][0]['attempt'], 1)
        self.assertEqual(self.record('G2', 2)['attempts'][0]['attempt'], 1)
        self.assertEqual((self.path / 'count-G2').read_text(), '2')
        self.assertEqual(self.unit['stats']['repairs'], 1)
        self.assertEqual(self.unit['stats']['gate_reruns'], 2)
        self.assertNotEqual(first['candidate_hash'], second['candidate_hash'])
        self.assertEqual(self.result['history'][0]['gates']['G1'], first)
        self.assertEqual(self.result['history'][1]['gates']['G1'], second)
        self.assertEqual(self.result['evidence']['gate:G1']['attempts'], second['attempts'])
        contexts = [load_json(p) for p in self.run.glob('units/invite/attempts/reviewer-*/context.json')]
        self.assertEqual({c['round'] for c in contexts}, {1, 2})
        for context in contexts:
            self.assertEqual(context['gate_evidence']['G1'], first if context['round'] == 1 else second)
        self.assertIn('第 1 轮 · G1：最终 FAIL', self.md)
        self.assertIn('第 2 轮 · G1：重跑后通过（不是一次通过）', self.md)
        self.assertTrue(audit(self.root, self.rid)['integrity_ok'])

    def test_distinct_reasons_stop_at_limit_without_marking_a_repeat(self):
        self.configure({'G1': [fail('one'), fail('two'), passed()]}, maximum=1)
        self.assertEqual(self.execute(), 'NOT_MET')
        record = self.record()
        self.assertEqual([a['reason'] for a in record['attempts']], ['one', 'two'])
        self.assertIsNone(record['repeated_reason'])
        self.assertEqual(record['reruns'], 1)
        self.assertIn('| 1 | FAIL | 1 | one |', self.md)
        self.assertIn('| 2 | FAIL | 1 | two |', self.md)

    def test_maximum_five_reruns_allows_six_executions(self):
        self.configure({'G1': [fail(str(i)) for i in range(5)] + [passed()]}, maximum=5)
        self.assertEqual(self.execute(), 'PASSED')
        record = self.record()
        self.assertEqual([a['attempt'] for a in record['attempts']], list(range(1, 7)))
        self.assertEqual(record['reruns'], 5)
        self.assertEqual(self.unit['stats']['gate_reruns'], 5)
        self.assertTrue(record['passed_after_rerun'])

    def test_launch_error_unknown_is_not_retried(self):
        self.configure({'G1': [passed()]}, maximum=5)
        self.raw['units'][0]['gates'][0]['argv'] = ['loop-no-such-gate-executable']
        self.assertEqual(self.execute(), 'BLOCKED')
        record = self.record()
        self.assertEqual(record['status'], 'UNKNOWN')
        self.assertEqual(record['receipt']['reason'], 'launch_error')
        self.assertEqual(len(record['attempts']), 1)
        self.assertIsNone(record['attempts'][0]['reason'])
        self.assertIsNone(record['attempts'][0]['exit_code'])
        self.assertEqual(self.unit['stats']['gate_reruns'], 0)
        self.assertEqual(self.unit['stats']['member_invocations'], 1)

    def test_timeout_after_failure_is_unknown_and_stops_rerunning(self):
        self.configure({'G1': [fail('initial'), {'exit_code': 1, 'sleep': 2,
                                               'stdout': ['LOOP_FAIL_REASON=initial']}, passed()]}, maximum=3)
        self.raw['units'][0]['gates'][0]['timeout_seconds'] = 0.5
        self.assertEqual(self.execute(), 'BLOCKED')
        record = self.record()
        self.assertEqual([a['status'] for a in record['attempts']], ['FAIL', 'UNKNOWN'])
        self.assertEqual([a['reason'] for a in record['attempts']], ['initial', None])
        self.assertEqual(record['receipt']['reason'], 'timeout')
        self.assertIsNone(record['repeated_reason'])
        self.assertEqual(self.unit['stats']['gate_reruns'], 1)
        self.assertIn('initial', self.md)
        self.assertIn('| 2 | UNKNOWN |', self.md)

    def test_nonzero_execution_cannot_bypass_source_integrity_using_reruns(self):
        bad = fail('mutation')
        bad['mutate'] = True
        self.configure({'G1': [bad, passed()]}, maximum=3)
        self.assertEqual(self.execute(), 'BLOCKED')
        self.assertIn('验收资产', self.result['reason'])
        self.assertEqual((self.path / 'count-G1').read_text(), '1')
        self.assertEqual(self.unit['stats']['gate_reruns'], 0)


if __name__ == '__main__':
    unittest.main()
