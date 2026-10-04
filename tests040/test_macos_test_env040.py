"""Real Darwin regression for acceptance scripts launched under deeply nested TMPDIR."""
import concurrent.futures
import importlib.util
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest

WRAPPER = Path(__file__).resolve().parents[1] / 'tools/macos_test_env.py'
spec = importlib.util.spec_from_file_location('macos_test_env', WRAPPER)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


@unittest.skipUnless(sys.platform == 'darwin', 'Requires real macOS AF_UNIX behavior')
class MacOSTestEnvironment(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='mt-', dir='/private/tmp')
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.deep = self.base / ('nested-' * 22)
        self.deep.mkdir()
        self.env = {k: os.environ.get(k) for k in module.TEMP_KEYS}
        self.cache = tempfile.tempdir
        self.addCleanup(self.restore)
        for k in module.TEMP_KEYS:
            os.environ[k] = str(self.deep)
        tempfile.tempdir = str(self.deep)  # Simulate a previously warmed Python cache.

    def restore(self):
        for k, value in self.env.items():
            if value is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = value
        tempfile.tempdir = self.cache

    def assert_clean(self, report):
        self.assertTrue(report['environment_restored'])
        self.assertTrue(report['cache_restored'])
        self.assertTrue(report['temporary_directory_removed'])
        self.assertFalse(Path(report['temporary_directory']).exists())
        self.assertEqual(tempfile.tempdir, str(self.deep))

    def test_long_socket_reproduces_short_context_and_child_succeed(self):
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
            with self.assertRaises(OSError):
                sock.bind(str(self.deep / 'test.sock'))
        report_path = self.base / 'environment.json'
        sentinel = self.deep / 'unrelated.txt'
        sentinel.write_text('preserve')
        home = os.environ.get('HOME')
        with module.macos_temp(report_path) as report:
            short = report['temporary_directory']
            self.assertEqual(tempfile.gettempdir(), short)
            self.assertTrue(all(os.environ[k] == short for k in module.TEMP_KEYS))
            self.assertEqual(os.environ.get('HOME'), home)
            code = ('import tempfile,socket,os,json; '
                    's=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM); '
                    's.bind(tempfile.gettempdir()+"/child.sock"); '
                    'print(json.dumps({"tmp":tempfile.gettempdir(),"home":os.environ.get("HOME")}))')
            child = subprocess.run([sys.executable, '-c', code], text=True, capture_output=True, timeout=10)
            self.assertEqual(child.returncode, 0, child.stderr)
            self.assertEqual(json.loads(child.stdout), {'tmp':short, 'home':home})
        self.assert_clean(json.loads(report_path.read_text()))
        self.assertEqual(sentinel.read_text(), 'preserve')

    def test_exception_and_exit_restore_environment_and_cache(self):
        for exception in (ValueError('fixture'), SystemExit(23)):
            with self.subTest(exception=type(exception).__name__):
                report_path = self.base / 'exception.json'
                with self.assertRaises(type(exception)):
                    with module.macos_temp(report_path):
                        raise exception
                self.assert_clean(json.loads(report_path.read_text()))

    def run_script(self, name, text, *args):
        script = self.base / (name + '.py')
        script.write_text(text)
        report = self.base / (name + '.json')
        p = subprocess.run([sys.executable, str(WRAPPER), '--report', str(report), str(script), *args],
                           text=True, capture_output=True, timeout=15)
        return p, json.loads(report.read_text())

    def test_command_preserves_arguments_exit_status_and_cleanup(self):
        for code in (0, 23, 'failure text'):
            p, report = self.run_script('exit',
                'import sys,os,tempfile,json\nprint(json.dumps(sys.argv[1:]))\n'
                'assert tempfile.gettempdir()==os.environ["TMPDIR"]\nraise SystemExit('+repr(code)+')\n',
                'argument with spaces', '--flag')
            self.assertEqual(p.returncode, code if isinstance(code,int) else 1)
            self.assertEqual(json.loads(p.stdout), ['argument with spaces','--flag'])
            self.assert_clean(report)

    def test_parallel_processes_use_distinct_directories(self):
        def worker(i):
            p, report = self.run_script('parallel'+str(i),
                'import tempfile,time\nprint(tempfile.gettempdir(),flush=True)\ntime.sleep(.2)\n')
            self.assertEqual(p.returncode, 0, p.stderr)
            return report
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            reports = list(pool.map(worker, range(2)))
        self.assertEqual(len({r['temporary_directory'] for r in reports}), 2)
        for report in reports:
            self.assert_clean(report)

    def test_sigterm_cleans_owned_directory(self):
        script = self.base / 'wait.py'
        script.write_text('import time\nwhile True: time.sleep(.05)\n')
        report = self.base / 'term.json'
        p = subprocess.Popen([sys.executable,str(WRAPPER),'--report',str(report),str(script)],
                             stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        try:
            deadline = time.monotonic()+10
            while not report.exists() and time.monotonic()<deadline:
                time.sleep(.01)
            self.assertTrue(report.exists())
            p.send_signal(signal.SIGTERM)
            p.communicate(timeout=10)
            self.assertEqual(p.returncode, 143)
            self.assert_clean(json.loads(report.read_text()))
        finally:
            if p.poll() is None:
                p.kill()
                p.communicate()


if __name__ == '__main__':
    unittest.main()
