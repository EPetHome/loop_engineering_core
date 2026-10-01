"""Offline delivery checks; fake summary programs only, no Pi/model calls."""
import contextlib
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, '/Users/Admin/Desktop/Loop/engine')
import run_loop
from loop_engineering.audit import audit


class DeliveryCheck(unittest.TestCase):
    def test_terminal_delivery_paths(self):
        for case in ('short', 'long', 'failed', 'empty', 'timeout', 'cancelled', 'running'):
            with self.subTest(case=case), tempfile.TemporaryDirectory(prefix='loop-brief-check-') as name:
                root = Path(name)
                current = root / 'exact-run'
                current.mkdir()
                manifest = {'state':'RUNNING' if case == 'running' else 'TERMINAL',
                            'result':{'stop':'NOT_MET','human_acceptance':'NOT_PERFORMED'}}
                (current/'manifest.json').write_text(json.dumps(manifest))
                (current/'result.md').write_text('original failed criterion S1\n')
                if case not in ('short', 'running'):
                    (current/'stderr.log').write_text('x' * (run_loop.LONG_LOG_BYTES + 1))
                if case == 'cancelled':
                    (current/'cancel').touch()
                original = {p.name:p.read_bytes() for p in current.iterdir()}
                fake = root/'fake.py'
                fake.write_text('import sys,time\n'
                    'data=sys.stdin.read()\n'
                    'assert "exact-run" in data and "禁止改选 latest" in data\n'
                    + ('sys.exit(7)\n' if case == 'failed' else
                       'time.sleep(10)\n' if case == 'timeout' else
                       'pass\n' if case == 'empty' else
                       'print("原始结果未达标；S1 未通过；这不是新的评审结论。")\n'))
                with patch.object(run_loop, 'brief_command', return_value=[sys.executable,str(fake)]) as command, \
                     patch.object(run_loop, 'BRIEF_SECONDS', 0.3 if case == 'timeout' else 10), \
                     contextlib.redirect_stdout(io.StringIO()):
                    if case == 'running':
                        with self.assertRaises(run_loop.LoopError): run_loop.deliver(current)
                        self.assertFalse(command.called)
                        continue
                    entry = run_loop.deliver(current).read_text()
                self.assertIn('未达标',entry)
                self.assertEqual(command.call_count, 0 if case in ('short','cancelled') else 1)
                self.assertEqual({k:(current/k).read_bytes() for k in original},original)
                self.assertEqual((current/'brief.md').exists(),case=='long')
                self.assertEqual((current/'brief-error.json').exists(),case in ('failed','empty','timeout'))
                if case == 'long':
                    self.assertIn('brief.md',entry)
                if case in ('failed','empty','timeout'):
                    self.assertIn('原始结果已保留',entry)

    def test_exact_run_and_exit_code(self):
        with tempfile.TemporaryDirectory() as name, \
             patch.object(run_loop,'load_rules',return_value={}), \
             patch.object(run_loop,'create_run',return_value='this-run'), \
             patch.object(run_loop,'supervise',return_value=3), \
             patch.object(run_loop,'deliver') as delivery, contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(run_loop.run(Path('task.json'),Path(name)),3)
            delivery.assert_called_once_with(Path(name).resolve()/'runs/this-run')
            delivery.side_effect=OSError('summary unavailable')
            with contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(run_loop.run(Path('task.json'),Path(name)),3)

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
            with patch.object(run_loop,'brief_command',return_value=[sys.executable,str(fake)]), \
                 patch.object(run_loop,'LONG_LOG_BYTES',1), \
                 patch.dict(os.environ,{'LOOP_NO_NOTIFY':'1'}), contextlib.redirect_stdout(io.StringIO()):
                code=run_loop.run(run_loop.ENGINE_DIR/'examples/demo.json',root)
            self.assertEqual(code,0)
            runs=list((root/'runs').iterdir())
            self.assertEqual(len(runs),1)
            self.assertTrue((runs[0]/'brief.md').is_file())
            self.assertIn('brief.md',(runs[0]/'交付结果.md').read_text())
            self.assertTrue(audit(root,runs[0].name)['integrity_ok'])


if __name__ == '__main__':
    unittest.main()
