"""N1：读取收集不能证明完整时必须保持未知——残留事件、解析上限与下游传播。

只做离线事件投影和离线运行，不调用模型。原有未知路径（未匹配工具生命周期、
缺 toolCallId、缺 toolName、坏 JSONL）由 test_review_fix040 覆盖，这里只补 N1：
收集结束时仍有未解析残留，或 feed 因解析上限抛错，之后 finish 不得再声称完整。
"""
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from helpers import Controller, create_prepared_run, prepared, project
from loop_engineering.common import atomic_write, load_json
from loop_engineering.engine import UnitEngine
from loop_engineering.observability import cost_sessions
from loop_engineering.pi_events import EventError, PiEvents

READ_FIELDS = ('reads', 'distinct_files', 'repeat_reads', 'read_paths', 'tools_by_name')
SESSION = {'type': 'session', 'cwd': '/code'}
HALF_READ = (b'{"type":"tool_execution_start","toolCallId":"r1",'
             b'"toolName":"read","args":{"path":"a.py"}')


def wire(events):
    return b''.join(json.dumps(e, ensure_ascii=False).encode() + b'\n' for e in events)


def reads(paths):
    events = []
    for i, path in enumerate(paths):
        events.extend([{'type': 'tool_execution_start', 'toolCallId': str(i), 'toolName': 'read',
                        'args': {'path': path}}, {'type': 'tool_execution_end', 'toolCallId': str(i)}])
    return events


def final(ok):
    return [{'type': 'message_end', 'message': {'role': 'assistant', 'stopReason': 'stop',
             'content': [{'type': 'text', 'text': json.dumps(ok)}],
             'usage': {'input': 10, 'output': 3, 'cacheRead': 20, 'cacheWrite': 0}}},
            {'type': 'agent_end', 'willRetry': False}, {'type': 'agent_settled'}]


def complete_usage(paths=('a.py',)):
    p = PiEvents(None, 65536, code_path='/code')
    p.feed(wire([SESSION] + reads(list(paths)) + final({'ok': True})))
    p.finish('ok')
    return p.usage()


class ReadIntegrityUnknown(unittest.TestCase):
    def assertUnknown(self, usage):
        for field in READ_FIELDS:
            self.assertIsNone(usage[field], field)
        self.assertFalse(usage['coverage']['reads_complete'])

    def later_cross_reads(self, usage):
        records = [{'usage': usage, 'call_order': 0},
                   {'usage': complete_usage(), 'call_order': 1}]
        return [s['cross_reads'] for s in cost_sessions(records)]

    def test_half_event_then_timeout_or_cancel_is_unknown(self):
        for reason in ('timeout', 'cancelled'):
            with self.subTest(reason=reason):
                p = PiEvents(None, 65536, code_path='/code')
                p.feed(wire([SESSION]))
                p.feed(HALF_READ)
                p.finish(reason)
                usage = p.usage()
                self.assertUnknown(usage)
                self.assertEqual(self.later_cross_reads(usage), [None, None])

    def test_event_limit_error_sets_the_mark_before_raising(self):
        p = PiEvents(None, 128, diagnostic_bytes=64, code_path='/code')
        p.feed(wire([SESSION]))
        with self.assertRaises(EventError) as caught:
            p.feed(b'{"type":"tool_execution_start","toolCallId":"r1","toolName":"read","args":{"path":"'
                   + b'x' * 200 + b'"}}\n')
        self.assertEqual(caught.exception.reason, 'event_limit')
        p.finish('event_limit')
        usage = p.usage()
        self.assertUnknown(usage)
        self.assertEqual(self.later_cross_reads(usage), [None, None])

    def test_timeout_without_residual_keeps_complete_statistics(self):
        p = PiEvents(None, 65536, code_path='/code')
        p.feed(wire([SESSION] + reads(['a', 'a']) + final({'ok': True})))
        p.finish('timeout')
        usage = p.usage()
        self.assertTrue(usage['coverage']['reads_complete'])
        self.assertEqual(usage['reads'], 2)
        self.assertEqual(usage['distinct_files'], 1)
        self.assertEqual(usage['repeat_reads'], 1)
        self.assertEqual(usage['read_paths'], [{'path': 'a', 'outside': False}])
        self.assertEqual(usage['tools_by_name'], {'read': 2})


class ReadIntegrityResultPage(unittest.TestCase):
    def setUp(self):
        t = tempfile.TemporaryDirectory(prefix=self._testMethodName + '-')
        self.addCleanup(t.cleanup)
        self.base = Path(t.name)

    def offline_run(self):
        raw = project(self.base, True)
        state, root, draft = prepared(self.base, raw)
        rid, _, _ = create_prepared_run(state, root, draft)

        def body(context):
            return {'attempt_id': context['attempt_id'], 'role': context['role'],
                    'candidate_hash': context['candidate_hash'], 'summary': 'OFFLINE, no model',
                    'blocked': False,
                    'criteria': [{'id': 'C', 'status': 'PASS', 'note': 'checked',
                                  'evidence': ['code:value.txt']}],
                    'issues': [], 'rule_gaps': []}

        def job(owner, argv, code, job, stdin, timeout, idle, env, phase):
            context = load_json(Path(env['LOOP_CONTEXT']))
            report = body(context)
            job.mkdir(parents=True, exist_ok=True)
            p = PiEvents(job.parent, 65536, code_path=code)
            p.feed(wire([{'type': 'session', 'cwd': str(code)}]))
            if context['role'] == 'developer':
                (code / 'value.txt').write_text('round-' + str(context['round']))
                report['code_map'] = 'value.txt'
                p.feed(wire(reads(['value.txt']) + final(report)))
                p.finish('ok')
            else:
                # 命中 T1：先有完整事件，收尾前留下半条工具事件，按 timeout 结束。
                p.feed(wire(reads(['value.txt']) + final(report)))
                p.feed(HALF_READ)
                p.finish('timeout')
            atomic_write(job / 'stdout.log', json.dumps(report, ensure_ascii=False))
            return {'reason': 'ok', 'exit_code': 0, 'elapsed_seconds': 1.25, 'wall_elapsed_seconds': 1.25}

        with patch.object(UnitEngine, 'run_job', job):
            Controller(root, rid).execute()
        run = root / 'runs' / rid
        return {'data': load_json(run / 'manifest.json'), 'markdown': (run / 'result.md').read_text()}

    def test_result_page_and_totals_show_unknown_after_residual_timeout(self):
        run = self.offline_run()
        data = run['data']
        self.assertEqual(data['result']['stop'], 'PASSED')
        self.assertEqual(data['result']['finalization']['status'], 'PASS')
        reviewer = next(s for s in data['units']['check']['result']['cost_sessions']
                        if s['role'] == 'reviewer')
        for field in ('reads', 'distinct_files', 'repeat_reads', 'cross_reads'):
            self.assertIsNone(reviewer[field], field)
        self.assertIsNone(reviewer['off_map_reads'])
        self.assertEqual(reviewer['off_map_status'], 'unknown')
        self.assertIn('读文件 未知 次、跨会话重读 未知 次', run['markdown'])
        rows = [line for line in run['markdown'].splitlines() if line.startswith('| 评审方')]
        self.assertTrue(rows)
        cells = [c.strip() for c in rows[-1].strip('|').split('|')]
        self.assertEqual(cells[5:10], ['未知'] * 5)  # 读文件/不同文件/会话内重读/跨会话重读/地图外读取


if __name__ == '__main__':
    unittest.main()
