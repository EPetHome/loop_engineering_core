"""Offline counterexamples for review fixes and code-map coverage/cost; no models."""
import copy
import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest
from typing import Any
from unittest.mock import patch

from helpers import Controller, create_prepared_run, prepared, project
from loop_engineering import adapters, handoff
from loop_engineering.common import LoopError, atomic_write, load_json
from loop_engineering.engine import UnitEngine
from loop_engineering.observability import cost_sessions, summarize
from loop_engineering.pi_events import EventError, PiEvents
from loop_engineering.protocol import validate_report
from loop_engineering.storage import Store, markdown_result
from test_repair_merge040 import instruction_blocks

READ_FIELDS = ('reads', 'distinct_files', 'repeat_reads', 'read_paths', 'tools_by_name')
MAP_SENTENCE = ('交付时提供 code_map（最多 8000 字）：列出本单元每个新建、修改或删除的文件的相对路径、'
                '各自做什么、对应哪些标准，以及关键的取舍；可以用以 / 结尾的目录前缀统一覆盖，程序会核对有没有漏写。')


def issue(severity='blocking', description='同一个问题', **extra):
    return {'criterion_id': 'C', 'description': description, 'suggested_fix': '修复结果',
            'severity': severity, 'counterexample': '输入 1 得到 2，预期为 1',
            'locations': ['value.txt:1'], 'spec_refs': ['C'], 'files': ['value.txt'], **extra}


def report(context, issues=(), status='PASS'):
    return {'attempt_id': context['attempt_id'], 'role': context['role'],
            'candidate_hash': context['candidate_hash'], 'summary': 'OFFLINE, no model', 'blocked': False,
            'criteria': [{'id': 'C', 'status': status, 'note': 'checked', 'evidence': ['code:value.txt']}],
            'issues': list(issues), 'rule_gaps': []}


def wire(events):
    return b''.join(json.dumps(e, ensure_ascii=False).encode() + b'\n' for e in events)


def reads(paths):
    events = []
    for i, path in enumerate(paths):
        events.extend([{'type': 'tool_execution_start', 'toolCallId': str(i), 'toolName': 'read',
                        'args': {'path': path}}, {'type': 'tool_execution_end', 'toolCallId': str(i)}])
    return events


def final(r=None):
    return [{'type': 'message_end', 'message': {'role': 'assistant', 'stopReason': 'stop',
             'content': [{'type': 'text', 'text': json.dumps(r or {'ok': True})}],
             'usage': {'input': 10, 'output': 3, 'cacheRead': 20, 'cacheWrite': 0}}},
            {'type': 'agent_end', 'willRetry': False}, {'type': 'agent_settled'}]


def usage(events):
    p = PiEvents(None, 65536, code_path='/code')
    p.feed(wire([{'type': 'session', 'cwd': '/code'}] + events + final()))
    p.finish('ok')
    return p.usage()


def offline_run(base, responder, *, first_round='develop', fail_first=False, setup=None,
                writable=('value.txt',), retries=2):
    raw = project(base, True)
    raw['units'][0].update(first_round=first_round, writable_paths=list(writable), max_protocol_retries=retries)
    source = Path(raw['source'])
    if setup:
        setup(source)
    if fail_first:
        with (source / 'build.py').open('a') as out:
            out.write("\nif Path('value.txt').read_text() == 'round-1': raise SystemExit(1)\n")
    state, root, draft = prepared(base, raw)
    rid, _, _ = create_prepared_run(state, root, draft)
    contexts, prompts, reservations = [], [], []
    original_reserve = Store.reserve_operation

    def reserve(owner, dimension, *args, **kwargs):
        reservations.append(dimension)
        return original_reserve(owner, dimension, *args, **kwargs)

    def job(owner, argv, code, job, stdin, timeout, idle, env, phase):
        c = load_json(Path(env['LOOP_CONTEXT']))
        contexts.append(c); prompts.append(stdin)
        r = report(c)
        events = responder(c, code, r, len(contexts) - 1)
        job.mkdir(parents=True, exist_ok=True)
        if events is not None:
            p = PiEvents(job.parent, 65536, code_path=code)
            p.feed(wire([{'type': 'session', 'cwd': str(code)}] + events + final(r)))
            p.finish('ok')
        atomic_write(job / 'stdout.log', json.dumps(r, ensure_ascii=False))
        return {'reason': 'ok', 'exit_code': 0, 'elapsed_seconds': 1.25, 'wall_elapsed_seconds': 1.25}

    with patch.object(UnitEngine, 'run_job', job), patch.object(Store, 'reserve_operation', reserve):
        Controller(root, rid).execute()
    run = root / 'runs' / rid
    data = load_json(run / 'manifest.json')
    errors = [Path(c['workspace_path']) / 'protocol-error.txt' for c in contexts]
    errors = [p.read_text() for p in errors if p.exists()]
    accepted = [load_json(Path(c['workspace_path']) / 'accepted.json') for c in contexts
                if (Path(c['workspace_path']) / 'accepted.json').exists()]
    evidence = os.environ.get('LOOP_FIX_EVIDENCE')
    if evidence:
        dest = Path(evidence) / base.name
        shutil.copytree(run, dest)
        (dest / 'captured-prompts.json').write_text(json.dumps(prompts, ensure_ascii=False, indent=2))
        (dest / 'reservations.json').write_text(json.dumps(reservations))
    return {'data': data, 'unit': data['units']['check']['result'], 'contexts': contexts, 'prompts': prompts,
            'errors': errors, 'accepted': accepted, 'reservations': reservations, 'markdown': (run / 'result.md').read_text()}


class ReviewProtocolFix(unittest.TestCase):
    def setUp(self):
        t = tempfile.TemporaryDirectory()
        self.addCleanup(t.cleanup)
        self.code = Path(t.name)
        (self.code / 'value.txt').write_text('one\ntwo\n')
        self.context = {'attempt_id': 'a', 'role': 'reviewer', 'candidate_hash': 'h', 'managed_tools': True,
                        'run_id': 'r', 'unit_id': 'u', 'round': 2, 'issue_history': [],
                        'unit': {'criteria': [{'id': 'C', 'gate_ids': ['G']}], 'review_scope': 'frozen'}}
        self.gates = {'G': {'status': 'PASS', 'candidate_hash': 'h'}}

    def validate(self, r):
        return validate_report(r, self.context, self.code, self.gates)

    def history(self, item):
        return handoff.record_findings([], report(self.context, [item]), 'r', 'u', 1, 'h', 'accepted')

    def test_same_report_duplicate_identity_rejects_even_when_metadata_differs(self):
        self.context['round'] = 1
        for initial, later in (('advisory', 'blocking'), ('blocking', 'advisory'), ('blocking', 'blocking')):
            with self.subTest(initial=initial, later=later):
                second = issue(later, suggested_fix='另一修法', files=['other.txt'])
                with self.assertRaisesRegex(LoopError, '标准 C.*同一个问题.*重复.*合并成一条'):
                    self.validate(report(self.context, [issue(initial), second], 'FAIL'))

    def test_issue_identity_does_not_strip_whitespace_or_case(self):
        items = [issue('advisory', d) for d in ('Bug', 'bug', ' Bug', 'Bug ')]
        self.validate(report(self.context, items))
        history = handoff.record_findings([], report(self.context, items), 'r', 'u', 1, 'h', 'accepted')
        self.assertEqual(len(history), 4)
        self.assertEqual(len({i['id'] for i in history}), 4)

    def test_known_blocking_relabelled_advisory_cannot_erase_metadata(self):
        history = self.history(issue())
        original = copy.deepcopy(history)
        self.context['issue_history'] = history
        bad = issue('advisory', counterexample='', locations=[], spec_refs=[])
        with self.assertRaisesRegex(LoopError, 'counterexample|locations'):
            self.validate(report(self.context, [bad], 'FAIL'))
        self.assertEqual(history, original)
        ledger = handoff.record_findings(history, report(self.context, [bad]), 'r', 'u', 2, 'h2', 'accepted2')
        self.assertEqual((ledger[0]['severity'], ledger[0]['status']), ('blocking', 'OPEN'))
        for field in ('counterexample', 'locations', 'spec_refs'):
            self.assertEqual(ledger[0][field], original[0][field])
        self.assertEqual(ledger[0]['occurrences'][-1]['reported'], bad)

    def test_known_blocking_can_omit_metadata_regardless_of_reported_level(self):
        original = self.history(issue())
        self.context['issue_history'] = original
        for severity in ('blocking', 'advisory'):
            item = issue(severity)
            for field in ('counterexample', 'locations', 'spec_refs'):
                del item[field]
            r = report(self.context, [item], 'FAIL')
            self.validate(r)
            ledger = handoff.record_findings(original, r, 'r', 'u', 2, 'h2', 'accepted2')
            for field in ('severity', 'counterexample', 'locations', 'spec_refs'):
                self.assertEqual(ledger[0][field], original[0][field])

    def test_new_blocking_still_requires_both_metadata_fields(self):
        for missing in ('counterexample', 'locations'):
            with self.subTest(missing=missing):
                item = issue(); del item[missing]
                with self.assertRaisesRegex(LoopError, missing):
                    self.validate(report(self.context, [item], 'FAIL'))

    def test_known_advisory_relabelled_blocking_needs_no_blocking_metadata(self):
        self.context['issue_history'] = self.history(issue('advisory'))
        item = issue('blocking')
        del item['counterexample']; del item['locations']
        self.validate(report(self.context, [item]))
        with self.assertRaisesRegex(LoopError, '没有必须修'):
            self.validate(report(self.context, [item], 'FAIL'))

    def test_supplied_known_blocking_metadata_is_checked_using_effective_level(self):
        self.context['issue_history'] = self.history(issue())
        cases: list[dict[str, Any]] = [{'counterexample': ''}, {'counterexample': '  '}, {'locations': []},
                                      {'locations': ['value.txt:99']}, {'locations': ['../value.txt:1']}]
        for extra in cases:
            with self.subTest(extra=extra), self.assertRaises(LoopError):
                self.validate(report(self.context, [issue('advisory', **extra)], 'FAIL'))

    def test_empty_metadata_never_overwrites_ledger_and_nonempty_updates_do(self):
        history = self.history(issue())
        for extra in ({'counterexample': '  ', 'locations': [], 'spec_refs': []},
                      {'counterexample': None, 'locations': [None], 'spec_refs': ['']}):
            with self.subTest(extra=extra):
                ledger = handoff.record_findings(history, report(self.context, [issue(**extra)]),
                                                'r', 'u', 2, 'h2', 'accepted2')
                for field in ('counterexample', 'locations', 'spec_refs'):
                    self.assertEqual(ledger[0][field], history[0][field])
        item = issue(counterexample='另一输入出错', locations=['value.txt:2'], spec_refs=['C.2'])
        self.context['issue_history'] = history
        r = report(self.context, [item], 'FAIL'); self.validate(r)
        ledger = handoff.record_findings(history, r, 'r', 'u', 2, 'h2', 'accepted2')
        for field in ('counterexample', 'locations', 'spec_refs'):
            self.assertEqual(ledger[0][field], item[field])


class EventCoverageFix(unittest.TestCase):
    def assertUnknown(self, u):
        for field in READ_FIELDS:
            self.assertIsNone(u[field], field)

    def test_unmatched_end_makes_all_read_statistics_and_later_cross_reads_unknown(self):
        u = usage([{'type': 'tool_execution_end', 'toolCallId': 'r1', 'toolName': 'read'}])
        self.assertUnknown(u)
        self.assertIsNone(u['tool_calls'])
        records = [{'usage': u, 'call_order': 0}, {'usage': usage(reads(['a'])), 'call_order': 1},
                   {'usage': usage(reads(['a'])), 'call_order': 2}]
        self.assertEqual([s['cross_reads'] for s in cost_sessions(records)], [None, None, None])
        self.assertIsNone(summarize(records, 3)['usage']['reads'])

    def test_tool_events_missing_id_or_start_name_make_read_statistics_unknown(self):
        for event in ({'type': 'tool_execution_end', 'toolName': 'read'},
                      {'type': 'tool_execution_start', 'toolName': 'read', 'args': {'path': 'a'}},
                      {'type': 'tool_execution_start', 'toolCallId': 'r1'},
                      {'type': 'tool_execution_start', 'toolCallId': 'r1', 'toolName': ''}):
            with self.subTest(event=event):
                events = [event]
                if event.get('toolCallId'):
                    events.append({'type': 'tool_execution_end', 'toolCallId': 'r1'})
                self.assertUnknown(usage(events))

    def test_observed_subtotals_live_only_in_coverage(self):
        u = usage(reads(['a', 'a']) + [{'type': 'tool_execution_end', 'toolCallId': 'missing'}])
        self.assertUnknown(u)
        self.assertEqual(u['coverage']['reads_observed'], 2)
        self.assertEqual(u['coverage']['distinct_files_observed'], 1)
        self.assertEqual(u['coverage']['repeat_reads_observed'], 1)
        self.assertEqual(u['coverage']['read_paths_observed'], [{'path': 'a', 'outside': False}])
        self.assertEqual(u['coverage']['tools_by_name_observed'], {'read': 2})
        aggregate = summarize([{'usage': u}], 1)['usage']
        self.assertIsNone(aggregate['reads'])
        self.assertIsNone(aggregate['coverage']['reads']['observed_total'])

    def test_invalid_jsonl_record_does_not_claim_complete_read_statistics(self):
        p = PiEvents(None, 65536, code_path='/code')
        p.feed(wire([{'type': 'session', 'cwd': '/code'}] + reads(['a'])))
        p.feed(b'not-json\n'); p.feed(wire(final()))
        with self.assertRaises(EventError):
            p.finish('ok')
        self.assertUnknown(p.usage())

    def test_complete_stream_without_tools_keeps_true_zero_counts(self):
        u = usage([])
        self.assertEqual([u[f] for f in ('reads', 'distinct_files', 'repeat_reads')], [0, 0, 0])
        self.assertEqual(u['read_paths'], []); self.assertEqual(u['tools_by_name'], {})


class MapCoverageFix(unittest.TestCase):
    def test_exact_posix_paths_and_directory_prefixes_need_path_boundaries(self):
        for text, path in (('`src/`', 'src/a.py'), ('src/sub/：实现', 'src/sub/b.py'),
                           ('(a.py)', 'a.py'), ('中文说明：src/a.py；C', 'src/a.py'),
                           ('[目录有 空格/]', '目录有 空格/a.py')):
            with self.subTest(text=text, path=path):
                self.assertTrue(handoff.code_map_covers(text, path))
        for text, path in (('data.py', 'a.py'), ('src/old.py', 'src/old'), ('othersrc/', 'src/a.py'),
                           ('/src/a.py', 'src/a.py'), ('prefix-src/', 'src/a.py'),
                           ('src/a.py.bak', 'src/a.py'), ('src/a.py/child', 'src/a.py'),
                           ('src/abc', 'src/a.py'), ('a.pyx', 'a.py')):
            with self.subTest(text=text, path=path):
                self.assertFalse(handoff.code_map_covers(text, path))

    def test_coverage_error_lists_twenty_paths_and_remaining_count(self):
        after = {f'src/f{i:02}.py': {'kind': 'file'} for i in range(23)}
        with self.assertRaises(LoopError) as caught:
            handoff.validate_code_map('unrelated', {}, after)
        message = str(caught.exception)
        for i in range(20):
            self.assertIn(f'src/f{i:02}.py', message)
        self.assertNotIn('src/f20.py', message)
        self.assertIn('另有 3 条', message)
        self.assertIn('以 / 结尾的目录前缀', message)

    def test_empty_file_changes_accept_any_map_and_ignore_directory_only_changes(self):
        unchanged = {'value.txt': {'kind': 'file', 'sha256': 'same'}}
        handoff.validate_code_map('arbitrary', unchanged, unchanged)
        handoff.validate_code_map('arbitrary', {}, {'empty/': {'kind': 'dir'}})

    def test_developer_map_instruction_is_the_single_requested_sentence(self):
        for name, block in instruction_blocks().items():
            if '开发' in name:
                self.assertEqual(block.count(MAP_SENTENCE), 1)
            else:
                self.assertNotIn(MAP_SENTENCE, block)

    def test_read_guidance_includes_diffs_and_only_open_blocking_issue_paths(self):
        ctx = {'code_map': {'round': 1, 'text': 'src/ `exact.py`'},
               'comparison': {'changed_from_input': ['input.py'], 'changed_from_previous': ['previous.py']},
               'issue_history': [{'kind': 'issue', 'status': 'OPEN', 'severity': 'blocking',
                                  'files': ['issue.py'], 'locations': ['location.py:2-3']},
                                 {'kind': 'issue', 'status': 'OPEN', 'files': ['legacy.py']},
                                 {'kind': 'issue', 'status': 'OPEN', 'severity': 'advisory', 'files': ['advice.py']},
                                 {'kind': 'issue', 'status': 'UNKNOWN', 'files': ['unknown.py']},
                                 {'kind': 'issue', 'status': 'RESOLVED', 'files': ['closed.py']},
                                 {'kind': 'rule_gap', 'status': 'OPEN', 'files': ['gap.py']}]}
        manifest = {p: {'kind': 'file'} for p in ('src/a.py', 'src/b.py', 'exact.py', 'off.py')}
        guide = handoff.read_guidance(ctx, manifest)
        self.assertEqual(set(guide['paths']), {'src/a.py', 'src/b.py', 'exact.py', 'input.py', 'previous.py',
                                             'issue.py', 'location.py', 'legacy.py'})
        self.assertEqual(guide['code_map'], ctx['code_map']['text'])


class ReviewFixEngine(unittest.TestCase):
    def setUp(self):
        t = tempfile.TemporaryDirectory(prefix=self._testMethodName + '-')
        self.addCleanup(t.cleanup)
        self.base = Path(t.name)

    def assertPassed(self, run):
        self.assertEqual(run['data']['result']['stop'], 'PASSED', run['unit']['reason'])
        self.assertEqual(run['markdown'], markdown_result(run['data']))

    def test_duplicate_then_advisory_fail_are_format_repaired_without_developer_or_repairs(self):
        def responder(c, code, r, n):
            r['issues'] = [issue('advisory')]
            if n == 0:
                r['issues'].append(issue())
            r['criteria'][0]['status'] = 'FAIL' if n < 2 else 'PASS'
            return reads(['value.txt'])
        run = offline_run(self.base, responder, first_round='review', retries=1)
        self.assertEqual(run['data']['result']['stop'], 'BLOCKED')
        self.assertIn('交付协议修复已耗尽', run['unit']['reason'])
        self.assertEqual([c['role'] for c in run['contexts']], ['reviewer'] * 2)
        self.assertEqual([c['protocol_repair_only'] for c in run['contexts']], [False, True])
        self.assertEqual(len(run['errors']), 2)
        self.assertIn('合并成一条', run['errors'][0]); self.assertIn('只有建议项时请判 PASS', run['errors'][1])
        self.assertEqual(run['data']['budget'].get('repairs', 0), 0)
        self.assertNotIn('repairs', run['reservations'])
        self.assertEqual(run['unit']['issue_history'], [])
        self.assertEqual(run['accepted'], [])

    def test_missing_modified_file_is_rejected_then_fixed_with_readonly_code(self):
        def setup(source):
            (source / 'src').mkdir(); (source / 'src/changed.py').write_text('old')
        def responder(c, code, r, n):
            if c['role'] == 'developer':
                if not c['protocol_repair_only']:
                    (code / 'value.txt').write_text('fixed'); (code / 'src/changed.py').write_text('new')
                else:
                    self.assertEqual((code / 'src/changed.py').read_text(), 'new')
                    self.assertEqual((code / 'src/changed.py').stat().st_mode & 0o222, 0)
                r['code_map'] = 'value.txt' if n == 0 else 'value.txt src/changed.py'
            return reads(['value.txt'])
        run = offline_run(self.base, responder, setup=setup, writable=('value.txt', 'src/'))
        self.assertPassed(run)
        self.assertEqual(len(run['errors']), 1); self.assertIn('src/changed.py', run['errors'][0])
        self.assertTrue(run['contexts'][1]['protocol_repair_only'])
        self.assertEqual(run['unit']['stats']['protocol_retries_by_role']['developer'], 1)
        self.assertEqual(run['unit']['stats']['repairs'], 0)
        self.assertEqual(run['accepted'][0]['report']['code_map'], 'value.txt src/changed.py')

    def test_directory_prefix_covers_multiple_new_modified_and_deleted_files(self):
        def setup(source):
            (source / 'src').mkdir()
            for name in ('a.py', 'b.py', 'deleted.py'):
                (source / 'src' / name).write_text('old')
        def responder(c, code, r, n):
            if c['role'] == 'developer':
                for name in ('a.py', 'b.py', 'new.py'):
                    (code / 'src' / name).write_text('new')
                (code / 'src/deleted.py').unlink()
                r['code_map'] = 'src/：C 的改动'
            return reads(['value.txt'])
        run = offline_run(self.base, responder, setup=setup, writable=('src/',))
        self.assertPassed(run); self.assertEqual(run['errors'], [])
        self.assertEqual(run['unit']['stats']['protocol_retries'], 0)

    def test_deleted_file_missing_from_map_blocks_when_protocol_retries_are_exhausted(self):
        def setup(source):
            (source / 'old.txt').write_text('obsolete')
        def responder(c, code, r, n):
            if c['role'] == 'developer':
                (code / 'old.txt').unlink(); r['code_map'] = 'value.txt'
            return reads(['value.txt'])
        run = offline_run(self.base, responder, setup=setup, writable=('old.txt',), retries=0)
        self.assertEqual(run['data']['result']['stop'], 'BLOCKED')
        self.assertIn('交付协议修复已耗尽', run['unit']['reason'])
        self.assertIn('old.txt', run['errors'][0]); self.assertEqual(len(run['contexts']), 1)

    def test_repair_omitting_map_invalidates_old_map_for_next_reviewer(self):
        def responder(c, code, r, n):
            if c['role'] == 'developer':
                (code / 'value.txt').write_text('round-' + str(c['round']))
                if c['round'] == 1:
                    r['code_map'] = 'value.txt'
            return reads(['value.txt'])
        run = offline_run(self.base, responder, fail_first=True)
        self.assertPassed(run)
        self.assertEqual(run['contexts'][2]['code_map'], {'round': 1, 'text': 'value.txt'})
        self.assertIsNone(run['contexts'][3]['code_map'])
        self.assertIsNone(run['data']['units']['check']['code_map'])
        self.assertEqual(run['unit']['cost_sessions'][3]['off_map_status'], 'no_map')

    def test_reviewer_prompt_has_one_8000_character_map_and_evidence_keeps_full_delivery(self):
        code_map = 'value.txt ' + '图' * (8000 - len('value.txt '))
        def responder(c, code, r, n):
            if c['role'] == 'developer':
                (code / 'value.txt').write_text('fixed'); r['code_map'] = code_map
            return reads(['value.txt'])
        run = offline_run(self.base, responder)
        self.assertPassed(run)
        self.assertEqual(run['prompts'][1].count(code_map), 1)
        self.assertEqual(run['accepted'][0]['report']['code_map'], code_map)
        self.assertEqual(run['contexts'][1]['developer_delivery']['code_map'], code_map)
        self.assertNotIn('code_map', adapters.prompt_view(run['contexts'][1])['developer_delivery'])

    def test_developer_repair_off_map_reads_count_distinct_inside_files_only(self):
        def setup(source):
            for name in ('core/a.py', 'core/b.py', 'problems/location.py', 'off/x.py', 'off/y.py'):
                p = source / name; p.parent.mkdir(parents=True, exist_ok=True); p.write_text('one\ntwo\n')
        def responder(c, code, r, n):
            if c['role'] == 'developer':
                (code / 'value.txt').write_text('round-' + str(c['round']))
                r['code_map'] = 'value.txt core/'
                if c['round'] == 2:
                    return reads(['core/a.py', 'core/b.py', 'problems/location.py', 'off/x.py', 'off/y.py',
                                  'off/x.py', '/outside/file'])
            elif c['round'] == 1:
                r['issues'] = [issue(files=[], locations=['problems/location.py:1-2'])]
                r['criteria'][0]['status'] = 'FAIL'
            else:
                r['issue_resolutions'] = [{'id': c['issue_history'][0]['id'], 'note': 'fixed',
                                          'evidence': ['code:value.txt']}]
            return reads(['value.txt'])
        run = offline_run(self.base, responder, setup=setup)
        self.assertPassed(run)
        session = run['unit']['cost_sessions'][2]
        self.assertEqual((session['role'], session['off_map_reads'], session['off_map_status']),
                         ('developer', 2, 'known'))
        records = list(run['unit']['member_observations'].values())
        repair = next(r for r in records if r['role'] == 'developer' and r['round'] == 2)
        self.assertEqual(repair['off_map_reads'], 2)
        self.assertIn('problems/location.py', repair['read_guidance']['paths'])
        self.assertIn('core/a.py', repair['read_guidance']['paths'])
        self.assertIn('跨会话重读 | 地图外读取 | 输入', run['markdown'])
        self.assertIn('| 7 | 7 | 6 | 1 | 0 | 2 | 10 |', run['markdown'])

    def test_first_developer_with_known_reads_but_no_map_displays_no_map(self):
        def responder(c, code, r, n):
            return reads(['value.txt'])
        run = offline_run(self.base, responder)
        self.assertPassed(run)
        for session in run['unit']['cost_sessions']:
            self.assertIsNone(session['off_map_reads']); self.assertEqual(session['off_map_status'], 'no_map')
        self.assertIn('| 无地图 |', run['markdown'])
        self.assertNotIn('地图外读取', run['markdown'].split('停止类型')[0])

    def test_unknown_read_coverage_displays_unknown_and_taints_later_cross_reads(self):
        def responder(c, code, r, n):
            if c['role'] == 'developer':
                (code / 'value.txt').write_text('round-' + str(c['round'])); r['code_map'] = 'value.txt'
            if c['role'] == 'reviewer' and c['round'] == 1:
                return [{'type': 'tool_execution_end', 'toolCallId': 'r1', 'toolName': 'read'}]
            return reads(['value.txt'])
        run = offline_run(self.base, responder, fail_first=True)
        self.assertPassed(run)
        sessions = run['unit']['cost_sessions']
        self.assertIsNone(sessions[1]['off_map_reads']); self.assertEqual(sessions[1]['off_map_status'], 'unknown')
        self.assertIsNone(sessions[2]['cross_reads']); self.assertIsNone(sessions[3]['cross_reads'])
        self.assertIn('读文件 未知 次、跨会话重读 未知 次', run['markdown'])
        self.assertIn('| 无地图 |', run['markdown'])
        self.assertIn('| 1.25 秒 | 1 | 未知 | 未知 | 未知 | 未知 | 未知 | 未知 | 10 | 20 | 3 | 否 |',
                      run['markdown'])

    def test_unknown_reads_take_precedence_over_absent_map(self):
        def responder(c, code, r, n):
            return [{'type': 'tool_execution_end', 'toolCallId': 'missing'}]
        run = offline_run(self.base, responder, first_round='review')
        self.assertPassed(run)
        session = run['unit']['cost_sessions'][0]
        self.assertIsNone(session['off_map_reads']); self.assertEqual(session['off_map_status'], 'unknown')
        self.assertNotIn('| 无地图 |', run['markdown'])

    def test_map_range_also_covers_new_files_read_after_the_invocation_starts(self):
        def responder(c, code, r, n):
            if c['role'] == 'developer':
                (code / 'value.txt').write_text('round-' + str(c['round'])); r['code_map'] = 'value.txt new/'
                if c['round'] == 2:
                    (code / 'new').mkdir(); (code / 'new/future.py').write_text('new')
                    return reads(['new/future.py'])
            return reads(['value.txt'])
        run = offline_run(self.base, responder, fail_first=True, writable=('value.txt', 'new/'))
        self.assertPassed(run)
        self.assertEqual(run['unit']['cost_sessions'][2]['off_map_reads'], 0)


if __name__ == '__main__':
    unittest.main()
