"""Offline delivery checks; fake summary programs only, no Pi/model calls."""
import contextlib
import io
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent / 'engine'))
import run_loop
from loop_engineering.audit import audit


class DeliveryCheck(unittest.TestCase):
    def test_terminal_delivery_paths(self):
        cases = [(case, brief) for case in ('short', 'long', 'cancelled', 'running', 'incomplete')
                 for brief in (False, True)]
        cases += [(case, True) for case in ('failed', 'empty', 'timeout', 'brief_cancelled')]
        failures = {'failed': 'nonzero_exit', 'empty': 'invalid_response',
                    'timeout': 'timeout', 'brief_cancelled': 'cancelled'}
        for case, brief in cases:
            with self.subTest(case=case, brief=brief), tempfile.TemporaryDirectory(prefix='loop-brief-check-') as name:
                root = Path(name)
                current = root / 'exact-run'
                current.mkdir()
                manifest = {'state': 'RUNNING' if case == 'running' else 'TERMINAL',
                            'result': None if case == 'incomplete' else
                            {'stop': 'NOT_MET', 'human_acceptance': 'NOT_PERFORMED'}}
                (current / 'manifest.json').write_text(json.dumps(manifest))
                (current / 'result.md').write_text('original failed criterion S1\n')
                (current / 'stderr.log').write_text('short log\n' if case == 'short' else 'x' * (65 * 1024))
                if case == 'cancelled':
                    (current / 'cancel').touch()
                original = {p.name: p.read_bytes() for p in current.iterdir()}
                fake = root / 'fake.py'
                fake.write_text('import sys,time\nfrom pathlib import Path\n'
                    'data=sys.stdin.read()\n'
                    'assert "exact-run" in data and "禁止改选 latest" in data\n'
                    + ('sys.exit(7)\n' if case == 'failed' else
                       'time.sleep(10)\n' if case == 'timeout' else
                       'pass\n' if case == 'empty' else
                       'print("partial body", flush=True)\n'
                       'Path("brief-job/cancel").write_text("cancel brief")\ntime.sleep(10)\n'
                       if case == 'brief_cancelled' else
                       'print("原始结果未达标；S1 未通过；这不是新的评审结论。")\n'))

                def command_argv():
                    # The program delivery must already exist before any optional process starts.
                    self.assertIn('[原始结果](result.md)', (current / '交付结果.md').read_text())
                    self.assertTrue((current / 'delivery-overview.json').is_file())
                    return [sys.executable, str(fake)]

                output = io.StringIO()
                with patch.object(run_loop, 'brief_command', side_effect=command_argv) as command, \
                     patch.object(run_loop, 'make_brief', wraps=run_loop.make_brief) as summary, \
                     patch.object(run_loop, 'BRIEF_SECONDS', 0.3 if case == 'timeout' else 10), \
                     patch.object(Path, 'rglob', side_effect=AssertionError('delivery must not scan logs')), \
                     contextlib.redirect_stdout(output):
                    if case in ('running', 'incomplete'):
                        with self.assertRaises(run_loop.LoopError):
                            run_loop.deliver(current, brief=brief)
                        self.assertFalse(command.called)
                        self.assertFalse(summary.called)
                        self.assertFalse((current / '交付结果.md').exists())
                        self.assertFalse((current / 'delivery-overview.json').exists())
                        self.assertEqual({k: (current / k).read_bytes() for k in original}, original)
                        continue
                    entry = run_loop.deliver(current, brief=brief).read_text()
                invoked = int(brief and case != 'cancelled')
                self.assertIn('未达标', entry)
                self.assertIn(str(current / '交付结果.md'), output.getvalue())
                self.assertEqual(command.call_count, invoked)
                self.assertEqual(summary.call_count, invoked)
                self.assertEqual({k: (current / k).read_bytes() for k in original}, original)
                self.assertEqual((current / 'brief.md').exists(), brief and case in ('short', 'long'))
                self.assertEqual((current / 'brief-error.json').exists(), case in failures)
                overview = json.loads((current / 'delivery-overview.json').read_text())
                self.assertEqual(overview['brief']['process_invocations'], invoked)
                paths = re.findall(r'\]\(([^)]+)\)', entry)
                self.assertIn('result.md', paths)
                self.assertIn('manifest.json', paths)
                self.assertIn('delivery-overview.json', paths)
                for path in paths:
                    self.assertTrue((current / path).is_file(), path)
                if not brief:
                    self.assertIn('未请求 AI 简报', entry)
                    self.assertNotIn('日志较短', entry)
                    self.assertFalse((current / 'brief-job').exists())
                    self.assertEqual(overview['brief']['reason'], 'not_invoked')
                if brief and case in ('short', 'long'):
                    self.assertIn('brief.md', paths)
                if case in failures:
                    self.assertIn('原始结果已保留', entry)
                    self.assertNotIn('brief.md', paths)
                    self.assertEqual(overview['brief']['reason'], failures[case])
                    self.assertEqual((current / 'brief-job/stdout.log').read_bytes(), b'')

    def test_exact_run_and_exit_code(self):
        with tempfile.TemporaryDirectory() as name, \
             patch.object(run_loop, 'load_rules', return_value={}), \
             patch.object(run_loop, 'create_run', return_value='this-run'), \
             patch.object(run_loop, 'supervise') as supervisor, \
             patch.object(run_loop, 'deliver') as delivery, contextlib.redirect_stdout(io.StringIO()):
            for brief in (False, True):
                for code in (0, 2, 3, 4):
                    with self.subTest(brief=brief, code=code):
                        supervisor.return_value = code
                        delivery.reset_mock()
                        delivery.side_effect = None
                        self.assertEqual(run_loop.run(Path('task.json'), Path(name), brief=brief), code)
                        delivery.assert_called_once_with(Path(name).resolve() / 'runs/this-run', brief=brief)
                        delivery.side_effect = OSError('summary unavailable')
                        with contextlib.redirect_stderr(io.StringIO()):
                            self.assertEqual(run_loop.run(Path('task.json'), Path(name), brief=brief), code)

    def test_cli_default_and_explicit_brief(self):
        for brief in (False, True):
            for explicit_root in (False, True):
                with self.subTest(brief=brief, explicit_root=explicit_root):
                    root = Path('/unused/data') if explicit_root else run_loop.ROOT / 'loop-data'
                    argv = ['run_loop.py', 'task.json']
                    if explicit_root:
                        argv += ['--root', str(root)]
                    if brief:
                        argv += ['--brief']
                    with patch.object(sys, 'argv', argv), patch.object(run_loop, 'run', return_value=3) as run:
                        self.assertEqual(run_loop.main(), 3)
                        run.assert_called_once_with(Path('task.json'), root, brief=brief)

    def test_summary_model_and_read_only_tools(self):
        argv=run_loop.brief_command()
        self.assertEqual(argv[argv.index('--model')+1],'opencode-go/deepseek-v4.1-flash')
        self.assertEqual(argv[argv.index('--thinking')+1],'xhigh')
        self.assertEqual(argv[argv.index('--tools')+1],'read,grep,find,ls')
        self.assertNotIn('--no-context-files',argv)
        self.assertIn(run_loop.EXTENSION,argv)

    def test_offline_loop_integration(self):
        with tempfile.TemporaryDirectory(prefix='loop-entry-integration-') as name:
            work=Path(name)
            fake=work/'summary.py'
            fake.write_text('import sys\nsys.stdin.read()\nprint("offline summary")\n')
            root=work/'data'
            with patch.object(run_loop,'brief_command',return_value=[sys.executable,str(fake)]) as command, \
                 patch.dict(os.environ,{'LOOP_NO_NOTIFY':'1'}), contextlib.redirect_stdout(io.StringIO()):
                code=run_loop.run(run_loop.ENGINE_DIR/'examples/demo.json',root,brief=True)
            self.assertEqual(command.call_count,1)
            self.assertEqual(code,0)
            runs=list((root/'runs').iterdir())
            self.assertEqual(len(runs),1)
            self.assertTrue((runs[0]/'brief.md').is_file())
            self.assertIn('brief.md',(runs[0]/'交付结果.md').read_text())
            overview=json.loads((runs[0]/'delivery-overview.json').read_text())
            self.assertEqual(overview['brief']['process_invocations'],1)
            self.assertTrue(audit(root,runs[0].name)['integrity_ok'])


if __name__ == '__main__':
    unittest.main()
