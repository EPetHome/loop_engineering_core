"""Offline check: exercise the adapter with a fake Pi; never invoke a model."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ADAPTER = Path(__file__).with_name('pi_member.py')


class PiMemberCheck(unittest.TestCase):
    def test_preserves_context_loading_and_explicit_model(self):
        with tempfile.TemporaryDirectory(prefix='pi-member-check-') as directory:
            work = Path(directory)
            fake = work / 'fake_pi'
            fake.write_text('#!' + sys.executable + '\n'
                'import json, os, sys\n'
                'from pathlib import Path\n'
                'Path(os.environ["CAPTURE"]).write_text(json.dumps({"argv":sys.argv[1:], "prompt":sys.stdin.read()}))\n'
                'print("```json\\n{\\\"ok\\\":true}\\n```")\n')
            fake.chmod(0o700)
            for model, thinking, selected in [
                ('openai-codex/gpt-6.1-sol', 'max', 'read,bash,edit,write,grep,find,ls'),
                ('openai-codex/gpt-6-astra', 'xhigh', 'read,grep,find,ls'),
            ]:
                capture = work / 'capture.json'
                done = subprocess.run([sys.executable, str(ADAPTER), '--model', model,
                    '--thinking', thinking, '--tools', selected], input='frozen task context',
                    text=True, capture_output=True, timeout=15,
                    env=dict(os.environ, LOOP_PI_BIN=str(fake), CAPTURE=str(capture)))
                self.assertEqual(done.returncode, 0, done.stderr)
                self.assertEqual(json.loads(done.stdout), {'ok': True})
                recorded = json.loads(capture.read_text())
                args = recorded['argv']
                self.assertEqual(recorded['prompt'], 'frozen task context')
                for flag, value in [('--model', model), ('--thinking', thinking), ('--tools', selected)]:
                    self.assertEqual(args[args.index(flag) + 1], value)
                self.assertNotIn('--no-context-files', args)
                self.assertIn('--offline', args)
                self.assertIn('--no-extensions', args)
                self.assertEqual(args[args.index('-e') + 1],
                    '/Users/Admin/.pi/agent/npm/node_modules/@gotgenes/pi-permission-system/src/index.ts')
                self.assertIn('-p', args)


if __name__ == '__main__':
    unittest.main()
