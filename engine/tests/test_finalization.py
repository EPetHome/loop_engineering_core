"""Trusted finalization counterexamples; deterministic local reports, no models."""
import contextlib
import copy
import html
import io
import os
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from loop_engineering.adapters import ENGINE_DIR
from loop_engineering.audit import audit, export_candidate
from loop_engineering.cli import main
from loop_engineering.common import LoopError, atomic_json, load_json
from loop_engineering.engine import Controller, UnitEngine
from loop_engineering.rules import normalize
from loop_engineering.storage import Store, create_run
from loop_engineering.supervisor import recover


class Interrupted(BaseException):
    pass


class OfflineRun:
    def __init__(self, directory):
        self.path = Path(directory).resolve()
        self.source, self.root = self.path / 'source', self.path / 'data'
        shutil.copytree(ENGINE_DIR / 'examples/demo_project', self.source)
        self.raw = load_json(ENGINE_DIR / 'examples/demo.json')
        self.raw['source'] = str(self.source)
        self.raw['units'][0].update(gates=[], max_repairs=0, max_protocol_retries=0)
        for criterion in self.raw['units'][0]['criteria']:
            criterion['gate_ids'] = []
        for agent in self.raw['agents'].values():
            agent['argv'] = [sys.executable, '-c', 'raise RuntimeError("unexpected member process")']
        self.calls, self.submitted = [], {}

    def add_independent(self):
        unit = copy.deepcopy(self.raw['units'][0])
        unit.update(id='other', writable_paths=[])
        self.raw['units'].append(unit)
        self.raw['completion'] = {'mode': 'independent'}

    def create(self):
        self.rid = create_run(self.root, normalize(self.raw, self.path))
        self.run = self.root / 'runs' / self.rid

    def execute(self, after_units=None, action=None):
        self.create()
        finish_unit = Store.finish_unit

        def job(engine, argv, code, job, stdin, timeout, idle, env, phase):
            context = load_json(job.parent / 'context.json')
            self.calls.append(context)
            report = {'attempt_id': context['attempt_id'], 'role': context['role'],
                      'candidate_hash': context['candidate_hash'], 'summary': 'offline finalization fixture',
                      'blocked': False, 'issues': [], 'rule_gaps': [],
                      'criteria': [{'id': c['id'], 'status': 'PASS', 'note': 'local fixture',
                                    'evidence': ['code:invites.py']} for c in context['unit']['criteria']]}
            if action:
                action(context, report)
            atomic_json(Path(context['response_path']), report)
            return {'reason': 'ok', 'exit_code': 0}

        def submit(store, uid, result):
            finish_unit(store, uid, result)
            self.submitted[uid] = copy.deepcopy(store.data['units'][uid]['result'])
            if after_units and all(s['state'] == 'TERMINAL' for s in store.data['units'].values()):
                after_units(store)

        with patch.object(UnitEngine, 'run_job', job), patch.object(Store, 'finish_unit', submit):
            Controller(self.root, self.rid).execute()
        return load_json(self.run / 'manifest.json')


def fail_other(context, report):
    if context['unit_id'] == 'other' and context['role'] == 'reviewer':
        report['criteria'][0]['status'] = 'FAIL'


class FinalizationTests(unittest.TestCase):
    def assert_views(self, rig, data, status):
        result = data['result']
        self.assertEqual(result['finalization']['status'], status)
        self.assertEqual(load_json(rig.run / 'result.json'), result)
        md = (rig.run / 'result.md').read_text()
        self.assertIn('finalization.status：**' + status + '**', md)
        self.assertIn(html.escape(md), (rig.run / 'report.html').read_text())
        for uid, state in data['units'].items():
            self.assertEqual(state['result'], rig.submitted[uid])
            self.assertEqual(load_json(rig.run / 'units' / uid / 'result.json'), state['result'])
        return md

    def assert_export_denied(self, rig, uid='invite', reason=None):
        before = (rig.run / 'manifest.json').read_bytes()
        data = load_json(rig.run / 'manifest.json')
        candidate = data['units'][uid]['result']['candidate']
        target = rig.path / 'export'
        with self.assertRaises(LoopError) as raised:
            export_candidate(rig.root, rig.rid, target, uid)
        self.assertIn(candidate['path'], str(raised.exception))
        if reason:
            self.assertIn(reason, str(raised.exception))
        self.assertTrue(Path(candidate['path']).is_dir())
        self.assertFalse(target.exists())
        self.assertEqual((rig.run / 'manifest.json').read_bytes(), before)

    def test_final_source_enumeration_failure_is_fail_not_no_drift(self):
        with tempfile.TemporaryDirectory() as directory:
            rig = OfflineRun(directory)
            completed = False
            scandir = os.scandir

            def after_units(store):
                nonlocal completed
                completed = True

            def scan(path):
                if completed and Path(path) == rig.source:
                    raise PermissionError('source cannot be enumerated')
                return scandir(path)

            with patch('loop_engineering.common.os.scandir', side_effect=scan):
                data = rig.execute(after_units=after_units)
            self.assertEqual(data['result']['stop'], 'BLOCKED')
            self.assertEqual(data['result']['source_drift'], [])
            self.assertEqual(data['result']['finalization']['checks'], {'integrity': 'PASS', 'source': 'FAIL'})
            md = self.assert_views(rig, data, 'FAIL')
            self.assertIn('PermissionError', md)
            self.assertIn('不能据此判断原项目没有变化', md)
            self.assert_export_denied(rig, reason='FAIL')

    def test_lost_frozen_handoff_blocks_total_without_rewriting_unit(self):
        with tempfile.TemporaryDirectory() as directory:
            rig = OfflineRun(directory)

            def lose_handoff(store):
                next(store.run.glob('units/*/attempts/reviewer-*/accepted.json')).unlink()

            data = rig.execute(after_units=lose_handoff)
            self.assertEqual(data['result']['stop'], 'BLOCKED')
            self.assertEqual(data['units']['invite']['result']['stop'], 'PASSED')
            self.assertEqual(data['result']['finalization']['checks'], {'integrity': 'FAIL', 'source': 'PASS'})
            md = self.assert_views(rig, data, 'FAIL')
            self.assertIn('冻结文件发生变化', md)
            self.assert_export_denied(rig)

    def test_changed_input_snapshot_is_final_integrity_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            rig = OfflineRun(directory)

            def change_input(store):
                path = Path(store.data['input']['path']) / 'baseline.md'
                path.chmod(0o600)
                path.write_text('damaged input snapshot\n')

            data = rig.execute(after_units=change_input)
            self.assertEqual(data['result']['stop'], 'BLOCKED')
            md = self.assert_views(rig, data, 'FAIL')
            self.assertIn('原始输入快照发生变化', md)
            self.assert_export_denied(rig)

    def test_all_current_candidates_checked_even_not_met_independent_one(self):
        for failed_unit in (False, True):
            with self.subTest(failed_unit=failed_unit), tempfile.TemporaryDirectory() as directory:
                rig = OfflineRun(directory)
                if failed_unit:
                    rig.add_independent()
                uid = 'other' if failed_unit else 'invite'

                def corrupt_candidate(store):
                    candidate = store.data['units'][uid]['result']['candidate']
                    path = Path(candidate['path']) / 'invites.py'
                    path.chmod(0o600)
                    path.write_text('damaged candidate\n')

                data = rig.execute(after_units=corrupt_candidate, action=fail_other if failed_unit else None)
                self.assertEqual(data['units'][uid]['result']['stop'], 'NOT_MET' if failed_unit else 'PASSED')
                self.assertEqual(data['result']['stop'], 'BLOCKED')
                md = self.assert_views(rig, data, 'FAIL')
                self.assertIn('候选成果指纹不匹配', md)
                f = data['result']['finalization']
                self.assertEqual(set(f['candidate_hashes']), set(data['units']))
                self.assert_export_denied(rig, 'invite')

    def test_candidate_scan_failure_is_fail_and_still_publishes_views(self):
        with tempfile.TemporaryDirectory() as directory:
            rig = OfflineRun(directory)
            from loop_engineering.engine import snapshot_manifest
            target = None

            def after_units(store):
                nonlocal target
                target = Path(store.data['units']['invite']['result']['candidate']['path'])

            def scan(path, limits, excludes=None):
                if path == target:
                    raise PermissionError('candidate unreadable at finalization')
                return snapshot_manifest(path, limits, excludes)

            with patch('loop_engineering.engine.snapshot_manifest', side_effect=scan):
                data = rig.execute(after_units=after_units)
            self.assertEqual(data['result']['stop'], 'BLOCKED')
            md = self.assert_views(rig, data, 'FAIL')
            self.assertIn('candidate unreadable at finalization', md)
            self.assert_export_denied(rig)

    def test_atomic_final_commit_failure_recovers_unknown_even_after_drift_calculated(self):
        for drift in (False, True):
            with self.subTest(drift=drift), tempfile.TemporaryDirectory() as directory:
                rig = OfflineRun(directory)
                replace = os.replace
                attempted = []

                def reject_final_commit(source, destination):
                    if Path(destination).name == 'manifest.json':
                        record = load_json(Path(source))
                        if record['state'] == 'TERMINAL':
                            attempted.append(record)
                            raise OSError('final atomic replace interrupted')
                    return replace(source, destination)

                def after_units(store):
                    if drift:
                        (rig.source / 'baseline.md').write_text('source changed\n')

                with patch('loop_engineering.common.os.replace', side_effect=reject_final_commit):
                    with self.assertRaisesRegex(OSError, 'final atomic replace interrupted'):
                        rig.execute(after_units=after_units)
                self.assertEqual(len(attempted), 1)
                pending = load_json(rig.run / 'manifest.json')
                self.assertEqual(pending['state'], 'RUNNING')
                self.assertIsNone(pending['result'])
                self.assertEqual(attempted[0]['result']['finalization']['status'], 'FAIL' if drift else 'PASS')
                if drift:
                    self.assertEqual(attempted[0]['result']['source_drift'], ['baseline.md'])
                calls = len(rig.calls)
                with patch.object(UnitEngine, 'member', side_effect=AssertionError('must not rerun members')), \
                     patch('loop_engineering.engine.snapshot_manifest', side_effect=AssertionError('must not rescan')):
                    result = recover(rig.root, rig.rid)
                data = load_json(rig.run / 'manifest.json')
                self.assertEqual(data['units'], pending['units'])
                self.assertEqual(data['budget'], pending['budget'])
                self.assertEqual(len(rig.calls), calls)
                self.assertEqual(result['stop'], 'BLOCKED')
                self.assertEqual(result['source_drift'], [])
                self.assertEqual(result['finalization']['checks'], {'integrity': 'UNKNOWN', 'source': 'UNKNOWN'})
                md = self.assert_views(rig, data, 'UNKNOWN')
                self.assertNotIn('未发现', md)
                self.assertIn('不能据此判断原项目没有变化', md)
                self.assert_export_denied(rig, reason='UNKNOWN')

    def test_empty_drift_and_one_completed_check_never_attest_completion(self):
        for flags in ({}, {'integrity_checked': True}, {'source_checked': True}):
            with self.subTest(flags=flags), tempfile.TemporaryDirectory() as directory:
                rig = OfflineRun(directory)
                with patch.object(Store, 'finish_run', side_effect=Interrupted()):
                    with self.assertRaises(Interrupted):
                        rig.execute()
                store = Store(rig.root, rig.rid)
                store.finish_run(source_drift=[], **flags)
                self.assertEqual(store.data['result']['stop'], 'BLOCKED')
                self.assertEqual(store.data['result']['finalization']['status'], 'UNKNOWN')

    def test_initial_recovery_has_no_candidate_and_no_input_attestation(self):
        with tempfile.TemporaryDirectory() as directory:
            rig = OfflineRun(directory)
            rig.create()
            with patch.object(UnitEngine, 'member', side_effect=AssertionError('no members')):
                result = recover(rig.root, rig.rid)
            self.assertEqual(result['stop'], 'BLOCKED')
            f = result['finalization']
            self.assertEqual(f['status'], 'UNKNOWN')
            self.assertIsNone(f['input_hash'])
            self.assertEqual(f['candidate_hashes'], {})
            self.assertEqual(f['rule_hash'], load_json(rig.run / 'manifest.json')['rule_hash'])

    def test_terminal_rebuild_preserves_authority_without_new_checks(self):
        for drift in (False, True):
            with self.subTest(drift=drift), tempfile.TemporaryDirectory() as directory:
                rig = OfflineRun(directory)

                def after_units(store):
                    if drift:
                        (rig.source / 'baseline.md').write_text('source changed\n')

                data = rig.execute(after_units=after_units)
                before = (rig.run / 'manifest.json').read_bytes()
                shutil.rmtree(rig.source)
                for name in ('result.md', 'result.json', 'report.html'):
                    (rig.run / name).unlink()
                with patch.object(UnitEngine, 'member', side_effect=AssertionError('no members')), \
                     patch('loop_engineering.engine.snapshot_manifest', side_effect=AssertionError('no scans')), \
                     patch('loop_engineering.audit.audit', side_effect=AssertionError('no new audit')):
                    self.assertEqual(recover(rig.root, rig.rid), data['result'])
                    Controller(rig.root, rig.rid).execute()
                self.assertEqual((rig.run / 'manifest.json').read_bytes(), before)
                self.assert_views(rig, data, 'FAIL' if drift else 'PASS')

    def test_legacy_terminal_is_unknown_for_export_and_views_without_migration(self):
        with tempfile.TemporaryDirectory() as directory:
            rig = OfflineRun(directory)
            data = rig.execute()
            del data['result']['finalization']
            atomic_json(rig.run / 'manifest.json', data)
            before = (rig.run / 'manifest.json').read_bytes()
            with patch.object(UnitEngine, 'member', side_effect=AssertionError('no members')), \
                 patch('loop_engineering.engine.snapshot_manifest', side_effect=AssertionError('no scans')):
                self.assertEqual(recover(rig.root, rig.rid), data['result'])
            self.assertEqual((rig.run / 'manifest.json').read_bytes(), before)
            self.assertTrue(audit(rig.root, rig.rid)['integrity_ok'])
            md = (rig.run / 'result.md').read_text()
            self.assertIn('finalization.status：**UNKNOWN**', md)
            self.assertIn('旧记录缺少 finalization', md)
            self.assertNotIn('未发现', md)
            self.assertIn(html.escape(md), (rig.run / 'report.html').read_text())
            for command in ('recover', 'status'):
                output = io.StringIO()
                with contextlib.redirect_stdout(output):
                    self.assertEqual(main([command, rig.rid, '--root', str(rig.root)]), 0)
                self.assertIn('UNKNOWN', output.getvalue())
                self.assertNotIn('已核对', output.getvalue())
            self.assert_export_denied(rig, reason='未知')

    def test_claimed_pass_cannot_override_known_global_anomaly(self):
        anomalies = [{'source_drift': ['baseline.md']}, {'source_drift_error': 'scan failed'},
                     {'integrity_error': 'evidence missing'}, {'source_drift': None}]
        for anomaly in anomalies:
            with self.subTest(anomaly=anomaly), tempfile.TemporaryDirectory() as directory:
                rig = OfflineRun(directory)
                data = rig.execute()
                data['result'].update(anomaly)
                atomic_json(rig.run / 'manifest.json', data)
                self.assertFalse(audit(rig.root, rig.rid)['integrity_ok'])
                self.assert_export_denied(rig, reason='矛盾')

    def test_existing_dangling_export_link_is_not_resolved_into_new_output(self):
        with tempfile.TemporaryDirectory() as directory:
            rig = OfflineRun(directory)
            rig.execute()
            destination, missing = rig.path / 'export', rig.path / 'missing'
            destination.symlink_to(missing, target_is_directory=True)
            with self.assertRaisesRegex(LoopError, '目标已存在'):
                export_candidate(rig.root, rig.rid, destination)
            self.assertTrue(destination.is_symlink())
            self.assertEqual(destination.readlink(), missing)
            self.assertFalse(missing.exists())

    def test_later_integrity_failure_does_not_rewrite_pass_attestation(self):
        with tempfile.TemporaryDirectory() as directory:
            rig = OfflineRun(directory)
            data = rig.execute()
            before = (rig.run / 'manifest.json').read_bytes()
            next(rig.run.glob('units/*/attempts/*/response.json')).unlink()
            self.assertFalse(audit(rig.root, rig.rid)['integrity_ok'])
            self.assert_export_denied(rig, reason='完整性')
            self.assertEqual((rig.run / 'manifest.json').read_bytes(), before)
            self.assertEqual(load_json(rig.run / 'manifest.json')['result'], data['result'])


if __name__ == '__main__':
    unittest.main()
