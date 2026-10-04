"""Whole-run finalization contracts for repair convergence; offline reports only."""
import copy
import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

from helpers import BUILD, Controller, create_prepared_run, prepared, project
from loop_engineering.audit import audit, export_candidate, issue_history_errors
from loop_engineering.common import atomic_json, atomic_write, file_hash, load_json
from loop_engineering.engine import UnitEngine
from loop_engineering.handoff import finding_id, rule_gaps
from test_review_fix040 import issue, offline_run, reads, report
from test_time_budget040 import Clock


def advisory(c, code, r, n):
    r['issues'] = [issue('advisory', '可选优化')]
    return reads(['value.txt'])


def mixed(c, code, r, n):
    if c['role'] == 'developer':
        (code / 'value.txt').write_text('round-' + str(c['round']))
        r['code_map'] = 'value.txt：实现 C'
    elif c['round'] == 1:
        r['issues'] = [issue(description='必须修的错误'), issue('advisory', '可选优化')]
        r['criteria'][0]['status'] = 'FAIL'
    else:
        r['issues'] = [issue('advisory', '可选优化')]
        r['issue_resolutions'] = [{'id': i['id'], 'note': '已核对本候选', 'evidence': ['code:value.txt']}
                                  for i in c['issue_history'] if i['severity'] == 'blocking']
    return reads(['value.txt'])


def unchanged(source):
    (source / 'unchanged.txt').write_text('unchanged input\n')


def deferred(c, code, r, n):
    if c['role'] == 'developer':
        (code / 'value.txt').write_text('round-' + str(c['round']))
    else:
        r['criteria'][0]['status'] = 'FAIL'
        if c['round'] == 1:
            r['issues'] = [issue(description='必须修的错误')]
        else:
            r['issue_resolutions'] = [{'id': c['issue_history'][0]['id'], 'note': '已核对本候选',
                                      'evidence': ['code:value.txt']}]
            r['issues'] = [issue(description='未改动代码里的新发现', files=['unchanged.txt'],
                                 locations=['unchanged.txt:1'])]
    return reads(['value.txt'])


def controlled_run(base, configure, responder, gate_seconds=0):
    raw = project(base, True)
    configure(raw)
    state, root, draft = prepared(base, raw)
    rid, _, _ = create_prepared_run(state, root, draft)
    controller = Controller(root, rid)
    clock = Clock(controller.store.data['created_epoch'])
    contexts, candidates, receipts = [], [], []
    original_gates = UnitEngine.run_gates

    def job(owner, argv, code, job, stdin, timeout, idle, env, phase):
        c = load_json(Path(env['LOOP_CONTEXT']))
        contexts.append(c)
        candidates.append(copy.deepcopy(owner.history[-1]['candidate']))
        r = report(c)
        reason = responder(c, code, r, len(contexts) - 1, clock) or 'ok'
        job.mkdir(parents=True)
        atomic_write(job / 'stdout.log', json.dumps(r, ensure_ascii=False))
        receipt = {'reason': reason, 'exit_code': 0 if reason == 'ok' else 1}
        receipts.append(receipt)
        return receipt

    def gates(owner, manifest):
        original_gates(owner, manifest)
        clock.advance(gate_seconds)

    with patch('loop_engineering.engine.time.time', clock), patch.object(UnitEngine, 'run_job', job), \
         patch.object(UnitEngine, 'run_gates', gates):
        controller.execute()
    data = load_json(root / 'runs' / rid / 'manifest.json')
    return {'data': data, 'unit': data['units']['check']['result'], 'contexts': contexts,
            'attempt_candidates': candidates, 'receipts': receipts}


class Finalization040(unittest.TestCase):
    def setUp(self):
        t = tempfile.TemporaryDirectory(prefix='fin-')
        self.addCleanup(t.cleanup)
        self.base = Path(t.name)

    def capture(self, run, base=None):
        base = base or self.base
        run['root'] = base / 'data'
        run['path'] = run['root'] / 'runs' / run['data']['run_id']
        run['audit'] = audit(run['root'], run['data']['run_id'])
        evidence = os.environ.get('LOOP_FIN_EVIDENCE')
        if evidence:
            dest = Path(evidence) / self._testMethodName
            if base != self.base:
                dest /= base.name
            shutil.copytree(run['path'], dest)
            atomic_json(dest / 'captured.json', {k: v for k, v in run.items() if k not in ('root', 'path')})
        return run

    def assertFinalized(self, run, stop='PASSED'):
        data, unit = run['data'], run['unit']
        self.assertEqual(data['state'], 'TERMINAL')
        self.assertEqual(unit['stop'], stop, unit['reason'])
        self.assertEqual(data['result']['finalization']['status'], 'PASS', run['audit']['errors'])
        self.assertTrue(run['audit']['integrity_ok'], run['audit']['errors'])
        self.assertEqual(data['result']['stop'], stop, data['result'])
        self.assertEqual(load_json(run['path'] / 'result.json'), data['result'])
        self.assertIn('finalization.status：**PASS**', (run['path'] / 'result.md').read_text())

    def assertExported(self, run):
        dest = export_candidate(run['root'], run['data']['run_id'], self.base / 'export')
        self.assertEqual((dest / 'value.txt').read_text(),
                         (Path(run['unit']['candidate']['path']) / 'value.txt').read_text())

    def test_e1_advisory_only_first_review_finalizes(self):
        run = self.capture(offline_run(self.base, advisory, first_round='review'))
        self.assertEqual(len(run['unit']['advisory_findings']), 1)
        item = run['unit']['advisory_findings'][0]
        self.assertEqual((item['status'], item['severity']), ('ADVISORY', 'advisory'))
        self.assertIsNone(item['resolution'])
        self.assertFinalized(run)
        self.assertExported(run)

    def test_e2_repaired_blocking_preserves_advisory_and_finalizes(self):
        run = self.capture(offline_run(self.base, mixed))
        self.assertEqual([i['status'] for i in run['unit']['issue_history']], ['RESOLVED', 'ADVISORY'])
        self.assertEqual(len(run['unit']['advisory_findings']), 1)
        self.assertEqual(len(run['unit']['advisory_findings'][0]['occurrences']), 2)
        developer = next(c for c in run['contexts'] if c['role'] == 'developer' and c['round'] == 2)
        self.assertEqual([i['severity'] for i in developer['feedback']['issues']], ['blocking'])
        self.assertEqual(run['unit']['stats']['repairs'], 1)
        self.assertFinalized(run)
        self.assertExported(run)

    def test_e3_frozen_review_defers_unchanged_finding_and_finalizes(self):
        run = self.capture(offline_run(self.base, deferred, setup=unchanged))
        unit = run['unit']
        self.assertEqual(len(unit['deferred_findings']), 1)
        item = unit['deferred_findings'][0]
        self.assertEqual((item['status'], item['severity']), ('DEFERRED', 'blocking'))
        self.assertEqual(item['deferred'], {'round': 2, 'files': ['unchanged.txt']})
        self.assertEqual(unit['criteria'][0]['status'], 'PASS')
        self.assertEqual(unit['history'][1]['review']['criteria'][0]['status'], 'FAIL')
        for h in unit['history']:
            self.assertEqual((Path(h['candidate']['path']) / 'unchanged.txt').read_text(), 'unchanged input\n')
        self.assertEqual(unit['stats']['repairs'], 1)
        self.assertFinalized(run)
        self.assertExported(run)

    def test_e4_review_first_passes_without_developer_and_finalizes(self):
        run = self.capture(offline_run(self.base, lambda *args: [], first_round='review'))
        self.assertEqual([(c['role'], c['round']) for c in run['contexts']], [('reviewer', 1)])
        self.assertIsNone(run['unit']['history'][0]['developer'])
        self.assertEqual(run['unit']['history'][0]['timing']['developer_seconds'], 0)
        self.assertEqual(run['unit']['stats']['repairs'], 0)
        self.assertFinalized(run)

    def test_e5_developer_failure_without_candidate_then_retry_and_repair_finalize(self):
        def configure(raw):
            raw['units'][0]['max_infra_retries'] = 1
            (Path(raw['source']) / 'build.py').write_text(
                BUILD + "if Path('value.txt').read_text() == 'round-1': raise SystemExit(1)\n")

        def responder(c, code, r, n, clock):
            if n == 0:
                return 'transient_service_error'
            if c['role'] == 'developer':
                (code / 'value.txt').write_text('round-' + str(c['round']))

        run = self.capture(controlled_run(self.base, configure, responder))
        self.assertIsNone(run['attempt_candidates'][0])
        self.assertIsNone(run['attempt_candidates'][1])
        self.assertEqual(run['receipts'][0]['reason'], 'transient_service_error')
        first = Path(run['contexts'][0]['workspace_path'])
        self.assertFalse((first / 'accepted.json').exists())
        self.assertEqual([(c['role'], c['round']) for c in run['contexts']],
                         [('developer', 1), ('developer', 1), ('reviewer', 1), ('developer', 2), ('reviewer', 2)])
        self.assertEqual(run['unit']['stats']['infra_retries'], 1)
        self.assertEqual(run['unit']['stats']['repairs'], 1)
        self.assertEqual(run['unit']['history'][0]['gates']['G']['status'], 'FAIL')
        self.assertFinalized(run)

    def test_e6_missing_map_is_format_repaired_and_finalizes(self):
        def setup(source):
            (source / 'src').mkdir()
            (source / 'src/changed.py').write_text('old')

        def responder(c, code, r, n):
            if c['role'] == 'developer':
                if not c['protocol_repair_only']:
                    (code / 'value.txt').write_text('fixed')
                    (code / 'src/changed.py').write_text('new')
                else:
                    self.assertEqual((code / 'src/changed.py').read_text(), 'new')
                    self.assertEqual((code / 'src/changed.py').stat().st_mode & 0o222, 0)
                r['code_map'] = 'value.txt' if n == 0 else 'value.txt src/changed.py'
            return reads(['value.txt'])

        run = self.capture(offline_run(self.base, responder, setup=setup, writable=('value.txt', 'src/')))
        self.assertEqual(len(run['errors']), 1)
        self.assertIn('code_map 漏写改动文件：src/changed.py', run['errors'][0])
        self.assertEqual([c['protocol_repair_only'] for c in run['contexts']], [False, True, False])
        self.assertEqual(run['unit']['stats']['protocol_retries_by_role']['developer'], 1)
        self.assertEqual(run['unit']['stats']['repairs'], 0)
        self.assertEqual(run['accepted'][0]['report']['code_map'], 'value.txt src/changed.py')
        self.assertFinalized(run)

    def test_e7_stagnation_not_met_still_finalizes(self):
        def responder(c, code, r, n):
            if c['role'] == 'developer':
                (code / 'value.txt').write_text('round-' + str(c['round']))
            else:
                r['criteria'][0]['status'] = 'FAIL'
                if c['round'] == 1:
                    r['issues'] = [issue()]
            return reads(['value.txt'])

        run = self.capture(offline_run(self.base, responder))
        self.assertIn('停滞：', run['unit']['reason'])
        self.assertEqual(run['unit']['issue_history'][0]['status'], 'OPEN')
        self.assertEqual(len(run['unit']['history']), 2)
        self.assertEqual(run['unit']['stats']['repairs'], 1)
        self.assertFinalized(run, 'NOT_MET')

    def test_e7_insufficient_repair_time_not_met_still_finalizes(self):
        def configure(raw):
            raw['units'][0].update(first_round='review', max_seconds=9, stage_timeout_seconds=60, max_repairs=2)
            (Path(raw['source']) / 'build.py').write_text(
                BUILD + "if Path('value.txt').read_text() == 'initial': raise SystemExit(1)\n")

        def responder(c, code, r, n, clock):
            clock.advance(2)

        run = self.capture(controlled_run(self.base, configure, responder, gate_seconds=2))
        self.assertIn('时间不够返修', run['unit']['reason'])
        self.assertEqual([(c['role'], c['round']) for c in run['contexts']], [('reviewer', 1)])
        self.assertEqual(run['unit']['history'][0]['timing'],
                         {'developer_seconds': 0, 'gate_seconds': 2, 'review_seconds': 2})
        self.assertEqual(run['unit']['stats']['repairs'], 0)
        self.assertEqual(run['data']['budget'].get('repairs', 0), 0)
        self.assertFinalized(run, 'NOT_MET')

    def saveTampered(self, run, data):
        atomic_json(run['path'] / 'manifest.json', data)
        return audit(run['root'], data['run_id'])

    def test_advisory_with_effective_resolution_is_rejected(self):
        run = self.capture(offline_run(self.base, mixed))
        self.assertFinalized(run)
        data = copy.deepcopy(run['data'])
        resolved, advice = data['units']['check']['result']['issue_history']
        decision = copy.deepcopy(resolved['resolution'])
        decision['id'] = advice['id']
        advice.update(resolution=decision, resolution_attempts=[copy.deepcopy(decision)])
        path = Path(decision['report_path'])
        wrapper = load_json(path)
        wrapper['report']['issue_resolutions'].append({k: decision[k] for k in ('id', 'note', 'evidence')})
        # Keep the forged closure structurally bound; the new state rule must reject it, not a stale file hash.
        atomic_json(path, wrapper, readonly=True)
        data['integrity'][str(path.relative_to(run['path']))] = file_hash(path)
        ordinary = copy.deepcopy(data['units']['check']['result'])
        ordinary['issue_history'][1]['status'] = 'RESOLVED'
        unit = load_json(run['path'] / 'rules.json')['units'][0]
        self.assertEqual(issue_history_errors(ordinary, unit, run['path'], data['run_id'], 'check'), [])
        check = self.saveTampered(run, data)
        self.assertFalse(check['integrity_ok'])
        self.assertEqual(check['errors'], ['check: 建议项不能具有有效解决记录'])

    def test_deferred_without_marker_is_rejected(self):
        run = self.capture(offline_run(self.base, deferred, setup=unchanged))
        self.assertFinalized(run)
        data = copy.deepcopy(run['data'])
        del data['units']['check']['result']['issue_history'][1]['deferred']
        check = self.saveTampered(run, data)
        self.assertFalse(check['integrity_ok'])
        self.assertEqual(check['errors'], ['check: 遗留发现种类、标记或级别不一致'])

    def nonblockingRuns(self):
        for name in ('advisory', 'deferred'):
            base = self.base / name
            base.mkdir()
            run = (offline_run(base, advisory, first_round='review') if name == 'advisory' else
                   offline_run(base, deferred, setup=unchanged))
            run = self.capture(run, base)
            self.assertFinalized(run)
            yield name, run

    def test_nonblocking_statuses_require_consistent_kind_and_severity(self):
        for name, run in self.nonblockingRuns():
            variants = [{'kind': 'rule_gap'}, {'severity': 'blocking'}, {'severity': None}] if name == 'advisory' else [
                {'kind': 'rule_gap'}, {'severity': 'advisory'}, {'deferred': {}}, {'deferred': False}]
            for extra in variants:
                with self.subTest(state=name, extra=extra):
                    data = copy.deepcopy(run['data'])
                    item = data['units']['check']['result']['issue_history'][-1]
                    item.update(extra)
                    item['id'] = finding_id(data['run_id'], 'check', item['kind'], item['description'], item['criterion_ids'])
                    if item['kind'] == 'rule_gap':
                        result = data['units']['check']['result']
                        result['rule_gaps'] = rule_gaps(result['issue_history'])
                        result['historical_rule_gaps'] = rule_gaps(result['issue_history'], historical=True)
                    check = self.saveTampered(run, data)
                    self.assertFalse(check['integrity_ok'])
                    expected = '建议项种类或级别不一致' if name == 'advisory' else '遗留发现种类、标记或级别不一致'
                    self.assertEqual(check['errors'], ['check: ' + expected])

    def test_nonblocking_statuses_keep_identity_origins_and_rule_gap_projection(self):
        for name, run in self.nonblockingRuns():
            for fault, expected in (('id', '问题 ID 重复或与原始提出不匹配'),
                                    ('source', '问题记录来源不是本运行本单元的已接受报告'),
                                    ('candidate', '问题记录来源绑定不匹配'),
                                    ('raw', '历史 issue 原始记录不匹配'),
                                    ('suggested_fix', '历史 issue 原始建议被改写'),
                                    ('rule_gaps', '当前/历史规则缺口投影不匹配'),
                                    ('historical_rule_gaps', '当前/历史规则缺口投影不匹配')):
                with self.subTest(state=name, fault=fault):
                    data = copy.deepcopy(run['data'])
                    unit = data['units']['check']['result']
                    item = unit['issue_history'][-1]
                    if fault == 'id':
                        item['id'] += '-forged'
                    elif fault in ('source', 'candidate'):
                        key = 'report_path' if fault == 'source' else 'candidate_hash'
                        item['source'][key] += '-forged'
                        item['occurrences'][0]['source'][key] = item['source'][key]
                    elif fault == 'raw':
                        item['occurrences'][0]['reported']['counterexample'] = '伪造反例'
                    elif fault == 'suggested_fix':
                        item['suggested_fix'] = '伪造建议'
                    else:
                        unit[fault] = ['伪造规则缺口']
                    check = self.saveTampered(run, data)
                    self.assertFalse(check['integrity_ok'])
                    self.assertEqual(check['errors'], ['check: ' + expected])


if __name__ == '__main__':
    unittest.main()
