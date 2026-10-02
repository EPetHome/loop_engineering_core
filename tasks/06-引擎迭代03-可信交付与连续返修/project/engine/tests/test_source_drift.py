"""U2 回归测试：原项目收尾核对只影响总结果；成员均为本地离线桩。"""
import copy
import json
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
from loop_engineering.common import file_hash, load_json
from loop_engineering.engine import Controller, snapshot_manifest
from loop_engineering.rules import normalize
from loop_engineering.storage import Store, create_run
from loop_engineering.supervisor import recover


MEMBER = r'''
import json, runpy, shutil, sys
from pathlib import Path
context, demo, source, mutation, mode = sys.argv[1:]
c = json.loads(Path(context).read_text(encoding='utf-8'))
sys.argv = [demo, '--context', context, '--mode', mode]
runpy.run_path(demo, run_name='__main__')
if c['role'] == 'developer' and not c['protocol_repair_only']:
    original = Path(source)
    if mutation == 'changes':
        (original / 'baseline.md').write_text('运行期间被改动\n', encoding='utf-8')
        (original / '新增文件.txt').write_text('x', encoding='utf-8')
        (original / 'tests/test_invites.py').unlink()
    elif mutation == 'ignored':
        (original / '.DS_Store').write_bytes(b'x')
        (original / '.env').write_text('SYNTHETIC_VALUE=1\n', encoding='utf-8')
        (original / '__pycache__').mkdir(exist_ok=True)
        (original / '__pycache__/x.pyc').write_bytes(b'x')
        (original / 'scratch').mkdir(exist_ok=True)
        (original / 'scratch/new.txt').write_text('x', encoding='utf-8')
        (original / 'ignored.txt').unlink()
    elif mutation == 'missing':
        shutil.rmtree(original)
    elif mutation == 'symlink':
        (original / 'outside').symlink_to(original / 'baseline.md')
    elif mutation == 'metadata':
        (original / '新增目录').mkdir()
        baseline = original / 'baseline.md'
        baseline.chmod(baseline.stat().st_mode | 0o111)
'''


class SourceDriftTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='loop-source-drift-')
        self.path = Path(self.temp.name)
        self.root, self.source = self.path / 'data', self.path / 'source'
        shutil.copytree(ENGINE_DIR / 'examples/demo_project', self.source)
        self.raw = load_json(ENGINE_DIR / 'examples/demo.json')
        self.raw['source'] = str(self.source)
        self.raw['limits']['max_wall_seconds'] = 60
        self.raw['units'][0].update(max_repairs=0, max_protocol_retries=0, max_seconds=55)
        self.stub = self.path / 'member.py'
        self.stub.write_text(MEMBER, encoding='utf-8')
        self.changed_paths = sorted(['baseline.md', '新增文件.txt', 'tests/test_invites.py'])

    def tearDown(self):
        self.temp.cleanup()

    def execute(self, mutation='none', mode='success', cli=False, input_override=None):
        source = input_override or self.source
        for agent in self.raw['agents'].values():
            agent['argv'] = ['{python}', str(self.stub), '{context}',
                             '{engine}/examples/demo_member.py', str(source), mutation, mode]
        if cli:
            plan = self.path / 'task.json'
            plan.write_text(json.dumps(self.raw, ensure_ascii=False), encoding='utf-8')
            done = subprocess.run([sys.executable, str(ENGINE_DIR / 'loop.py'), 'run', str(plan),
                                   '--root', str(self.root)], capture_output=True, text=True, timeout=90,
                                  env={**os.environ, 'LOOP_NO_NOTIFY': '1', 'PYTHONDONTWRITEBYTECODE': '1'})
            self.exit_code = done.returncode
            runs = list((self.root / 'runs').glob('*/manifest.json'))
            self.assertEqual(len(runs), 1, done.stdout + done.stderr)
            self.run = runs[0].parent
            self.rid = self.run.name
        else:
            self.rid = create_run(self.root, normalize(self.raw, self.path),
                                  input_override=str(input_override) if input_override else None)
            self.run = self.root / 'runs' / self.rid
            Controller(self.root, self.rid).execute()
        self.data = load_json(self.run / 'manifest.json')
        self.result = self.data['result']
        self.unit = self.data['units']['invite']['result']
        self.assertEqual(self.data['state'], 'TERMINAL')
        self.assertEqual(load_json(self.run / 'result.json'), self.result)
        self.assertEqual(load_json(self.run / 'units/invite/result.json'), self.unit)
        self.md = (self.run / 'result.md').read_text(encoding='utf-8')
        self.assertTrue((self.run / 'report.html').is_file())
        return self.result['stop']

    def test_source_changes_block_total_and_list_paths_with_exit_code_3(self):
        self.assertEqual(self.execute('changes', cli=True), 'BLOCKED')
        self.assertEqual(self.exit_code, 3)
        self.assertEqual(self.result['source_drift'], self.changed_paths)
        self.assertIsNone(self.result['source_drift_error'])
        for rel in self.changed_paths:
            self.assertIn(rel, self.md)
        self.assertEqual(self.unit['stop'], 'PASSED')
        self.assertTrue(all(row['status'] == 'PASS' for row in self.unit['criteria']))
        self.assertEqual((self.source / 'baseline.md').read_text(encoding='utf-8'), '运行期间被改动\n')
        self.assertTrue((self.source / '新增文件.txt').is_file())
        self.assertFalse((self.source / 'tests/test_invites.py').exists())

    def test_no_drift_keeps_pass_and_empty_array(self):
        self.assertEqual(self.execute(cli=True), 'PASSED')
        self.assertEqual(self.exit_code, 0)
        self.assertEqual(self.result['source_drift'], [])
        self.assertIsNone(self.result['source_drift_error'])

    def test_default_and_custom_exclusions_are_unchanged(self):
        self.raw['exclude_paths'] = ['scratch/', 'ignored.txt']
        (self.source / 'scratch').mkdir()
        (self.source / 'scratch/old.txt').write_text('old', encoding='utf-8')
        (self.source / 'ignored.txt').write_text('old', encoding='utf-8')
        self.assertEqual(self.execute('ignored'), 'PASSED')
        self.assertEqual(self.result['source_drift'], [])
        self.assertIsNone(self.result['source_drift_error'])

    def test_drift_does_not_rewrite_finalized_unit_or_evidence(self):
        finalized = {}
        finish_unit = Store.finish_unit

        def record(store, uid, result):
            finish_unit(store, uid, result)
            finalized[uid] = copy.deepcopy(store.data['units'][uid]['result'])

        with patch.object(Store, 'finish_unit', record):
            self.assertEqual(self.execute('changes'), 'BLOCKED')
        self.assertEqual(self.unit, finalized['invite'])
        self.assertTrue(self.unit['reviewed'])
        self.assertTrue(self.unit['evidence'])
        self.assertEqual(self.unit['history'][-1]['review']['criteria'][0]['status'], 'PASS')

    def test_missing_source_blocks_and_publishes_reason_and_views(self):
        self.assertEqual(self.execute('missing', cli=True), 'BLOCKED')
        self.assertEqual(self.exit_code, 3)
        self.assertEqual(self.result['source_drift'], [])
        error = self.result['source_drift_error']
        self.assertIn('原项目收尾核对失败', error)
        self.assertIn('代码目录不存在', error)
        self.assertIn(str(self.source), error)
        self.assertIn(error, self.result['summary'])
        self.assertIn(error, self.md)
        self.assertEqual(self.unit['stop'], 'PASSED')

    def test_scan_oserror_blocks_without_losing_results(self):
        scans = 0

        def scan(path, limits, excludes=None):
            nonlocal scans
            if path.resolve() == self.source.resolve():
                scans += 1
                if scans == 3:
                    raise PermissionError('模拟原项目不可读')
            return snapshot_manifest(path, limits, excludes)

        with patch('loop_engineering.engine.snapshot_manifest', side_effect=scan):
            self.assertEqual(self.execute(), 'BLOCKED')
        self.assertEqual(scans, 3)
        error = self.result['source_drift_error']
        self.assertIn('PermissionError', error)
        self.assertIn('模拟原项目不可读', error)
        self.assertIn(error, self.md)
        self.assertEqual(self.unit['stop'], 'PASSED')

    def test_directory_scandir_error_blocks_without_reporting_deletions(self):
        directory = (self.source / 'unreadable').resolve()
        directory.mkdir()
        scandir = os.scandir
        for populated in (False, True):
            with self.subTest(populated=populated):
                if populated:
                    (directory / 'kept.txt').write_text('x', encoding='utf-8')
                scans = 0

                def scan(path):
                    nonlocal scans
                    if Path(path) == directory:
                        scans += 1
                        if scans == 3:
                            raise PermissionError(f'模拟原项目子目录不可读：{directory}')
                    return scandir(path)

                with patch('loop_engineering.common.os.scandir', side_effect=scan):
                    self.assertEqual(self.execute(), 'BLOCKED')
                self.assertEqual(scans, 3)
                self.assertIn('unreadable/', self.data['input']['manifest'])
                self.assertEqual(self.result['source_drift'], [])
                error = self.result['source_drift_error']
                self.assertIn('原项目收尾核对失败', error)
                self.assertIn('PermissionError', error)
                self.assertIn('模拟原项目子目录不可读', error)
                self.assertIn(str(directory), error)
                self.assertIn(error, self.result['summary'])
                self.assertIn(error, self.md)
                self.assertEqual(self.unit['stop'], 'PASSED')

    def test_excluded_unreadable_directories_are_not_scanned(self):
        self.raw['exclude_paths'] = ['scratch/']
        directories = {(self.source / name).resolve() for name in ('__pycache__', 'scratch')}
        for directory in directories:
            directory.mkdir()
        scandir, attempted = os.scandir, []

        def scan(path):
            if Path(path) in directories:
                attempted.append(str(path))
                raise PermissionError(f'模拟被排除目录不可读：{path}')
            return scandir(path)

        with patch('loop_engineering.common.os.scandir', side_effect=scan):
            self.assertEqual(self.execute(), 'PASSED')
        self.assertEqual(attempted, [])
        self.assertEqual(self.result['source_drift'], [])
        self.assertIsNone(self.result['source_drift_error'])

    def test_new_symlink_causes_scan_failure_not_crash(self):
        self.assertEqual(self.execute('symlink'), 'BLOCKED')
        self.assertIn('不支持链接或特殊文件：outside', self.result['source_drift_error'])
        self.assertEqual(self.unit['stop'], 'PASSED')

    def test_no_drift_preserves_not_met_but_drift_overrides_it(self):
        for mutation, expected, paths in [('none', 'NOT_MET', []), ('changes', 'BLOCKED', self.changed_paths)]:
            with self.subTest(mutation=mutation):
                self.assertEqual(self.execute(mutation, mode='always-fail'), expected)
                self.assertEqual(self.result['source_drift'], paths)
                self.assertEqual(self.unit['stop'], 'NOT_MET')
                self.assertEqual(self.unit['criteria'][0]['status'], 'FAIL')

    def test_directories_and_executable_bits_follow_snapshot_manifest(self):
        self.assertEqual(self.execute('metadata'), 'BLOCKED')
        self.assertEqual(self.result['source_drift'], ['baseline.md', '新增目录/'])
        self.assertIn('新增目录/', self.md)

    def test_rescan_uses_the_same_source_as_input_override(self):
        override = self.path / 'retry-source'
        shutil.copytree(self.source, override)
        (self.source / 'baseline.md').write_text('另一个输入来源\n', encoding='utf-8')
        self.assertEqual(self.execute(input_override=override), 'PASSED')
        self.assertEqual(self.result['source_drift'], [])
        self.assertEqual(self.execute('changes', input_override=override), 'BLOCKED')
        self.assertEqual(self.result['source_drift'], self.changed_paths)

    def test_terminal_view_rebuild_does_not_rescan_or_change_manifest(self):
        self.assertEqual(self.execute(), 'PASSED')
        before = file_hash(self.run / 'manifest.json')
        (self.source / 'baseline.md').write_text('终态后的改动\n', encoding='utf-8')
        (self.run / 'result.md').unlink()
        with patch('loop_engineering.engine.snapshot_manifest', side_effect=AssertionError('终态不应扫描')):
            Controller(self.root, self.rid).execute()
        self.assertEqual(file_hash(self.run / 'manifest.json'), before)
        self.assertEqual(load_json(self.run / 'result.json'), self.result)
        self.assertTrue((self.run / 'result.md').is_file())

    def test_orphan_recovery_does_not_require_source_rescan(self):
        rid = create_run(self.root, normalize(self.raw, self.path))
        shutil.rmtree(self.source)
        with patch('loop_engineering.engine.snapshot_manifest', side_effect=AssertionError('恢复不应扫描')):
            result = recover(self.root, rid)
        self.assertEqual(result['stop'], 'BLOCKED')
        self.assertEqual(result['source_drift'], [])
        self.assertIsNone(result['source_drift_error'])
        run = self.root / 'runs' / rid
        self.assertEqual(load_json(run / 'result.json'), result)
        self.assertTrue((run / 'result.md').is_file())
