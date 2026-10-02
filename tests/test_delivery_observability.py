"""Portable prompt and separate optional-brief accounting; local stubs only."""
import contextlib
import io
import json
from pathlib import Path
import re
import sys
import tempfile
import unittest
from unittest.mock import patch

PROJECT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT))
import run_loop
from test_pi_stream import wire, final_events, compaction_events


class BriefObservability(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.work = Path(self.tmp.name)
        self.run = self.work / 'exact-run'
        self.run.mkdir()
        self.manifest = {'state': 'TERMINAL', 'result': {'stop': 'PASSED', 'human_acceptance': 'NOT_PERFORMED',
            'member_invocations': 2, 'elapsed_seconds': 12, 'finalization': {'status': 'PASS'}}}
        (self.run / 'manifest.json').write_text(json.dumps(self.manifest))
        (self.run / 'result.md').write_text('原始结果\n')
        self.before = (self.run / 'manifest.json').read_bytes()

    def brief(self, failure=False, compaction=False):
        program = self.work / 'summary.py'
        usage = {'input': 9, 'output': 4, 'cacheRead': 1, 'cacheWrite': 0, 'cost': {'total': 0}}
        events = final_events(text='只有简报正文，不是新的结论。', usage=usage)
        if compaction:
            events = events[:-1] + compaction_events(summary_retry=True) + events[-1:]
        program.write_text('import sys,os\n'
            'prompt=sys.stdin.read()\nassert "exact-run" in prompt\n'
            'os.write(2,b"diagnostics\\n")\n'
            'os.write(1,' + repr(wire(events)) + ')\n'
            + ('sys.exit(7)\n' if failure else ''))
        (self.run / 'stderr.log').write_text('x' * (65 * 1024))
        with patch.object(run_loop, 'brief_command', return_value=[sys.executable, str(program)]) as command, \
             contextlib.redirect_stdout(io.StringIO()):
            run_loop.deliver(self.run, brief=True)
        self.assertEqual(command.call_count, 1)
        return json.loads((self.run / 'delivery-overview.json').read_text())

    def test_packaged_prompt_and_original_command_contract(self):
        self.assertEqual(run_loop.PROMPT, PROJECT / 'prompts/brief.md')
        self.assertTrue(run_loop.PROMPT.is_file())
        argv = run_loop.brief_command()
        self.assertEqual(argv[0], run_loop.PI)
        self.assertEqual(argv[argv.index('--model') + 1], 'opencode-go/deepseek-v4.1-flash')
        self.assertEqual(argv[argv.index('--mode') + 1], 'json')
        self.assertIn(run_loop.EXTENSION, argv)
        self.assertEqual(argv[argv.index('--tools') + 1], 'read,grep,find,ls')
        prompt = run_loop.PROMPT.read_text()
        for boundary in ('真实成员', '真实 CLI', 'NOT_PERFORMED', 'api_requests=null', 'provider cost=0', '未核实链接'):
            self.assertIn(boundary, prompt)

    def test_streamed_brief_usage_is_separate_and_manifest_unchanged(self):
        overview = self.brief(compaction=True)
        self.assertEqual((self.run / 'manifest.json').read_bytes(), self.before)
        self.assertEqual(overview['engine']['member_invocations'], 2)
        self.assertEqual(overview['engine']['wall_elapsed_seconds'], 12)
        self.assertIsNone(overview['engine']['usage']['assistant_messages'])
        brief = overview['brief']
        self.assertEqual(brief['process_invocations'], 1)
        self.assertEqual(brief['usage']['assistant_messages'], 1)
        self.assertEqual(brief['usage']['tokens'], {'input': 9, 'output': 4, 'cache_read': 1, 'cache_write': 0})
        self.assertIsNone(brief['usage']['api_requests'])
        self.assertIsNone(brief['usage']['cost'])
        self.assertGreaterEqual(brief['elapsed_seconds'], 0)
        self.assertGreaterEqual(brief['wall_elapsed_seconds'], 0)
        self.assertIn('只有简报正文', (self.run / 'brief.md').read_text())
        self.assertNotIn('message_end', (self.run / 'brief.md').read_text())
        receipt = json.loads((self.run / 'brief-job/receipt.json').read_text())
        self.assertIn('timing_note', receipt)
        self.assertIn('timing_discrepancy', receipt)

    def test_failed_brief_keeps_observed_usage_but_no_partial_body(self):
        overview = self.brief(failure=True)
        self.assertEqual(overview['brief']['process_invocations'], 1)
        self.assertEqual(overview['brief']['reason'], 'nonzero_exit')
        self.assertEqual(overview['brief']['usage']['tokens']['input'], 9)
        self.assertFalse((self.run / 'brief.md').exists())
        self.assertEqual((self.run / 'brief-job/stdout.log').read_bytes(), b'')
        self.assertTrue((self.run / 'brief-error.json').is_file())
        self.assertEqual((self.run / 'manifest.json').read_bytes(), self.before)

    def test_default_short_and_long_runs_have_zero_brief_invocations_unknown_usage_and_real_links(self):
        for size in (10, 65 * 1024):
            with self.subTest(log_bytes=size):
                (self.run / 'stderr.log').write_text('x' * size)
                with patch.object(run_loop, 'brief_command', side_effect=AssertionError('no model allowed')) as command, \
                     patch.object(run_loop, 'make_brief', side_effect=AssertionError('no brief allowed')) as summary, \
                     patch.object(Path, 'rglob', side_effect=AssertionError('no log scan allowed')), \
                     contextlib.redirect_stdout(io.StringIO()):
                    run_loop.deliver(self.run)
                command.assert_not_called()
                summary.assert_not_called()
                overview = json.loads((self.run / 'delivery-overview.json').read_text())
                self.assertEqual(overview['brief']['process_invocations'], 0)
                self.assertEqual(overview['brief']['elapsed_seconds'], 0)
                self.assertEqual(overview['brief']['reason'], 'not_invoked')
                self.assertIsNone(overview['brief']['usage']['tokens']['input'])
                entry = (self.run / '交付结果.md').read_text()
                self.assertIn('未请求 AI 简报', entry)
                self.assertNotIn('日志较短', entry)
                self.assertNotIn('[完整报告]', entry)
                self.assertNotIn('[查看日志简报]', entry)
                paths = re.findall(r'\]\(([^)]+)\)', entry)
                self.assertIn('result.md', paths)
                self.assertIn('manifest.json', paths)
                self.assertIn('delivery-overview.json', paths)
                for path in paths:
                    self.assertTrue((self.run / path).is_file(), path)
                self.assertIn('真实成员', entry)
                self.assertIn('人工验收未由简报执行', entry)
                self.assertEqual((self.run / 'manifest.json').read_bytes(), self.before)
                self.assertFalse((self.run / 'brief-job').exists())

    def test_existing_brief_records_are_history_not_new_default_invocations(self):
        original_overview = self.brief()
        paths = [self.run / 'brief.md', *(self.run / 'brief-job').iterdir()]
        original = {path: path.read_bytes() for path in paths if path.is_file()}
        with patch.object(run_loop, 'make_brief', side_effect=AssertionError('no new invocation')) as summary, \
             patch.object(Path, 'rglob', side_effect=AssertionError('no log scan allowed')), \
             contextlib.redirect_stdout(io.StringIO()):
            run_loop.deliver(self.run)
        summary.assert_not_called()
        self.assertEqual(json.loads((self.run / 'delivery-overview.json').read_text()), original_overview)
        self.assertEqual({path: path.read_bytes() for path in original}, original)
        self.assertEqual((self.run / 'manifest.json').read_bytes(), self.before)
        entry = (self.run / '交付结果.md').read_text()
        self.assertIn('未请求 AI 简报', entry)
        self.assertIn('含已有记录；不代表本次交付新增调用数', entry)

    def test_long_run_links_resolve_to_corresponding_files(self):
        self.brief()
        entry = (self.run / '交付结果.md').read_text()
        paths = re.findall(r'\]\(([^)]+)\)', entry)
        self.assertIn('brief.md', paths)
        self.assertIn('delivery-overview.json', paths)
        for path in paths:
            self.assertTrue((self.run / path).is_file(), path)
        self.assertNotIn('/Desktop/Promate/', entry)

    def test_terminal_original_usage_does_not_absorb_brief(self):
        usage = {'assistant_messages': 5, 'tool_calls': 3,
                 'tokens': {'input': 80, 'output': None, 'cache_read': None, 'cache_write': None},
                 'api_requests': None, 'cost': None, 'coverage': {'scope': 'original'}}
        self.manifest['result']['member_usage'] = usage
        (self.run / 'manifest.json').write_text(json.dumps(self.manifest))
        before = (self.run / 'manifest.json').read_bytes()
        overview = self.brief()
        self.assertEqual(overview['engine']['usage'], usage)
        self.assertEqual(overview['brief']['usage']['tokens']['input'], 9)
        self.assertEqual((self.run / 'manifest.json').read_bytes(), before)
