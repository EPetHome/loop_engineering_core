"""U5 release regression: CLI verification is read-only; regeneration is repeatable."""
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from loop_engineering.adapters import ENGINE_DIR
from loop_engineering.checksums import checksums


class ChecksumsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='loop-checksums-test-')
        self.path = Path(self.temp.name)
        self.engine = self.path / 'engine'
        self.engine.mkdir()
        shutil.copyfile(ENGINE_DIR / 'loop.py', self.engine / 'loop.py')
        shutil.copytree(ENGINE_DIR / 'loop_engineering', self.engine / 'loop_engineering',
                        ignore=shutil.ignore_patterns('__pycache__', '*.pyc', '*.pyo'))
        (self.engine / 'docs').mkdir()
        (self.engine / 'docs/z.txt').write_text('last\n', encoding='utf-8')
        (self.engine / 'docs/旧.txt').write_text('original\n', encoding='utf-8')
        (self.engine / 'a.txt').write_bytes(b'\x00\xff\n')
        self.manifest = self.engine / 'SHA256SUMS'

    def tearDown(self):
        self.temp.cleanup()

    def cli(self, *args):
        return subprocess.run([sys.executable, str(self.engine / 'loop.py'), 'checksums', *args],
                              cwd=self.path, capture_output=True, text=True, timeout=20,
                              env={**os.environ, 'PYTHONDONTWRITEBYTECODE': '1', 'LOOP_NO_NOTIFY': '1'})

    def generate(self):
        done = self.cli('--write')
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)

    def independent_sums(self):
        result = {}
        skip = {'__pycache__', '.git', 'node_modules', '.venv', 'venv'}
        for path in self.engine.rglob('*'):
            relative = path.relative_to(self.engine)
            if any(part in skip for part in relative.parts):
                continue
            if (path.name in ('SHA256SUMS', '.DS_Store', '.env') or path.name.startswith('.env.')
                    or path.suffix in ('.pyc', '.pyo') or path.is_symlink() or not path.is_file()):
                continue
            result[relative.as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()
        return result

    def assert_manifest(self):
        wanted = self.independent_sums()
        self.assertEqual(self.manifest.read_text(encoding='utf-8').splitlines(),
                         [f'{wanted[name]}  {name}' for name in sorted(wanted)])

    def test_regenerate_sorted_full_manifest_and_verify_from_another_cwd(self):
        self.generate()
        self.assert_manifest()
        before = self.manifest.read_bytes(), self.manifest.stat().st_mtime_ns
        files = self.independent_sums()
        done = self.cli()
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertEqual((self.manifest.read_bytes(), self.manifest.stat().st_mtime_ns), before)
        self.assertEqual(self.independent_sums(), files)
        self.assertFalse((self.path / 'SHA256SUMS').exists())

    def test_missing_extra_and_changed_files_report_paths_without_writing(self):
        self.generate()
        before = self.manifest.read_bytes(), self.manifest.stat().st_mtime_ns
        (self.engine / 'docs/z.txt').write_text('changed\n', encoding='utf-8')
        (self.engine / 'docs/旧.txt').unlink()
        (self.engine / 'docs/新增 空格.txt').write_text('added\n', encoding='utf-8')
        done = self.cli()
        self.assertEqual(done.returncode, 5, done.stdout + done.stderr)
        for message in ('缺少文件：docs/旧.txt', '多出文件：docs/新增 空格.txt', '不一致：docs/z.txt'):
            self.assertIn(message, done.stdout)
        self.assertEqual((self.manifest.read_bytes(), self.manifest.stat().st_mtime_ns), before)
        self.generate()
        self.assert_manifest()
        self.assertEqual(self.cli().returncode, 0)

    def test_missing_manifest_is_not_created_until_write(self):
        done = self.cli()
        self.assertEqual(done.returncode, 5, done.stdout + done.stderr)
        self.assertIn('SHA256SUMS', done.stdout)
        self.assertIn('a.txt', done.stdout)
        self.assertFalse(self.manifest.exists())
        self.generate()
        self.assertEqual(self.cli().returncode, 0)

    def test_regeneration_is_repeatable_and_does_not_hash_manifest_itself(self):
        self.generate()
        first = self.manifest.read_bytes()
        self.manifest.write_text('not a manifest\n', encoding='utf-8')
        self.generate()
        self.assertEqual(self.manifest.read_bytes(), first)
        self.generate()
        self.assertEqual(self.manifest.read_bytes(), first)
        self.assert_manifest()

    def test_caches_and_excluded_directories_are_ignored_at_any_depth(self):
        self.generate()
        before = self.manifest.read_bytes()
        for parent in (self.engine, self.engine / 'docs'):
            for directory in ('__pycache__', '.git', 'node_modules', '.venv', 'venv'):
                (parent / directory).mkdir(exist_ok=True)
                (parent / directory / 'ignored.txt').write_text('ignored\n', encoding='utf-8')
            for name in ('.DS_Store', 'x.pyc', 'x.pyo', '.env', '.env.local', '.env.example'):
                (parent / name).write_text('ignored\n', encoding='utf-8')
        self.assertEqual(self.cli().returncode, 0)
        self.generate()
        self.assertEqual(self.manifest.read_bytes(), before)
        self.assert_manifest()

    def test_links_and_special_files_are_not_hashed_or_followed(self):
        self.generate()
        before = self.manifest.read_bytes()
        outside = self.path / 'outside'
        outside.mkdir()
        (outside / 'file.txt').write_text('outside\n', encoding='utf-8')
        (self.engine / 'link.txt').symlink_to(outside / 'file.txt')
        (self.engine / 'linked-directory').symlink_to(outside, target_is_directory=True)
        (self.engine / 'broken-link').symlink_to(outside / 'missing.txt')
        if hasattr(os, 'mkfifo'):
            os.mkfifo(self.engine / 'fifo')
        self.assertEqual(self.cli().returncode, 0)
        self.generate()
        self.assertEqual(self.manifest.read_bytes(), before)
        self.assert_manifest()

    def test_invalid_manifests_fail_without_rewrite_and_can_be_regenerated(self):
        self.generate()
        original = self.manifest.read_bytes()
        lines = original.decode('utf-8').splitlines(keepends=True)
        invalid = [b'not a manifest\n', b'\xff\n', original + lines[0].encode('utf-8'),
                   ''.join(reversed(lines)).encode('utf-8')]
        for data in invalid:
            with self.subTest(data=data[:40]):
                self.manifest.write_bytes(data)
                before = self.manifest.stat().st_mtime_ns
                done = self.cli()
                self.assertEqual(done.returncode, 5, done.stdout + done.stderr)
                self.assertEqual(self.manifest.read_bytes(), data)
                self.assertEqual(self.manifest.stat().st_mtime_ns, before)
                self.generate()
                self.assertEqual(self.manifest.read_bytes(), original)
                self.assertEqual(self.cli().returncode, 0)

    def test_scan_failure_preserves_existing_manifest(self):
        self.generate()
        before = self.manifest.read_bytes()
        with patch('loop_engineering.checksums.os.scandir', side_effect=PermissionError('injected scan failure')):
            with self.assertRaises(PermissionError):
                checksums(self.engine, write=True)
        self.assertEqual(self.manifest.read_bytes(), before)

    def test_manifest_symlink_is_neither_trusted_nor_overwritten(self):
        outside = self.path / 'outside-sums'
        outside.write_text('outside\n', encoding='utf-8')
        self.manifest.symlink_to(outside)
        self.assertEqual(self.cli().returncode, 5)
        self.assertEqual(self.cli('--write').returncode, 4)
        self.assertTrue(self.manifest.is_symlink())
        self.assertEqual(outside.read_text(encoding='utf-8'), 'outside\n')


if __name__ == '__main__':
    unittest.main()
