"""Offline counterexamples for code maps and streaming member-cost projections."""
import copy
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from helpers import project, prepared, create_prepared_run
from loop_engineering.adapters import member_prompt, prompt_view
from loop_engineering.common import LoopError, atomic_json, atomic_write, load_json
from loop_engineering.engine import Controller, UnitEngine
from loop_engineering.observability import read_observation, summarize
from loop_engineering.pi_events import PiEvents
from loop_engineering.protocol import response_schema, validate_report
from loop_engineering.storage import markdown_result


COST_FIELDS = ('tools_by_name', 'reads', 'distinct_files', 'repeat_reads', 'read_paths', 'cross_reads')
REPAIR_GUIDE = '先读 code_map 和 issue_history 里待解决问题指出的位置（files，有 locations 时按行号），只在需要时再读其他文件；不要通读目录或整份规格'
REVIEW_GUIDE = '先看 comparison 的完整差异和 code_map，细读改动的地方和待解决问题所在的位置；没改动的代码只在核对问题时再读'


def wire(events):
    return b''.join(json.dumps(e, ensure_ascii=False).encode() + b'\n' for e in events)


def tools(paths):
    events = []
    for i, path in enumerate(paths):
        event = {'type': 'tool_execution_start', 'toolCallId': str(i), 'toolName': 'read',
                 'args': {} if path is None else {'path': path}}
        events.extend([event, {'type': 'tool_execution_end', 'toolCallId': str(i)}])
    return events


def final(report=None):
    return [{'type': 'message_end', 'message': {
        'role': 'assistant', 'stopReason': 'stop',
        'content': [{'type': 'text', 'text': json.dumps(report or {'ok': True})}],
        'usage': {'input': 10, 'output': 3, 'cacheRead': 20, 'cacheWrite': 0}}},
        {'type': 'agent_end', 'willRetry': False}, {'type': 'agent_settled'}]


def projection(paths, code='/code', **kwargs):
    p = PiEvents(None, 65536, **kwargs)
    p.feed(wire([{'type': 'session', 'cwd': code}] + tools(paths) + final()))
    p.finish('ok')
    return p.usage()


def report_context(role='developer', round_number=1):
    context = {'attempt_id': 'current', 'role': role, 'candidate_hash': 'hash' if role == 'reviewer' else '',
               'round': round_number, 'managed_tools': True, 'protocol_repair_only': False,
               'unit': {'criteria': [{'id': 'C', 'gate_ids': []}]}, 'limits': {}}
    report = {'attempt_id': context['attempt_id'], 'role': role, 'candidate_hash': context['candidate_hash'],
              'summary': 'offline', 'blocked': False, 'criteria': [
                  {'id': 'C', 'status': 'UNKNOWN', 'note': 'offline', 'evidence': []}],
              'issues': [], 'rule_gaps': []}
    return report, context


class StreamingCost(unittest.TestCase):
    def test_reads_are_normalized_ordered_and_deduplicated_by_call_id(self):
        p = PiEvents(None, 65536)
        events = [{'type': 'session', 'cwd': '/code'}] + tools(['a', 'b', '/code/./a', '/outside/x'])
        edit = {'type': 'tool_execution_start', 'toolCallId': 'edit', 'toolName': 'edit', 'args': {'path': 'a'}}
        events += [edit, edit, {'type': 'tool_execution_end', 'toolCallId': 'edit'}] + final()
        p.feed(wire(events)); p.finish('ok')
        usage = p.usage()
        self.assertEqual((usage['reads'], usage['distinct_files'], usage['repeat_reads']), (4, 3, 1))
        self.assertEqual(usage['tools_by_name'], {'read': 4, 'edit': 1})
        self.assertEqual(usage['tool_calls'], 5)
        self.assertEqual(usage['read_paths'], [
            {'path': 'a', 'outside': False}, {'path': 'b', 'outside': False},
            {'path': '/outside/x', 'outside': True}])

    def test_parent_escape_and_sibling_prefix_are_outside(self):
        usage = projection(['../external/x', '/code/../external/x', '/code-other/x', 'sub/../a'])
        self.assertEqual(usage['read_paths'], [
            {'path': '/external/x', 'outside': True}, {'path': '/code-other/x', 'outside': True},
            {'path': 'a', 'outside': False}])
        self.assertEqual(usage['repeat_reads'], 1)

    def test_read_without_path_counts_only_the_call(self):
        usage = projection([None, '', 'a', None])
        self.assertEqual(usage['reads'], 4)
        self.assertEqual(usage['distinct_files'], 1)
        self.assertEqual(usage['repeat_reads'], 0)
        self.assertEqual(usage['read_paths'], [{'path': 'a', 'outside': False}])

    def test_session_cwd_overrides_engine_context_fallback(self):
        with tempfile.TemporaryDirectory() as t:
            context = Path(t) / 'context.json'
            atomic_json(context, {'code_path': '/fallback'})
            with patch.dict(os.environ, {'LOOP_CONTEXT': str(context), 'LOOP_CODE': '/fallback'}):
                p = PiEvents(None, 65536)
                p.feed(wire(tools(['/fallback/a', '../external']) + final()))
                p.finish('ok')
                self.assertEqual(p.usage()['read_paths'], [
                    {'path': 'a', 'outside': False}, {'path': '/external', 'outside': True}])
                usage = projection(['/session/a', '/fallback/a'], code='/session')
                self.assertEqual(usage['read_paths'], [
                    {'path': 'a', 'outside': False}, {'path': '/fallback/a', 'outside': True}])

    def test_statistics_keep_consuming_after_raw_log_is_truncated(self):
        with tempfile.TemporaryDirectory() as t:
            p = PiEvents(Path(t), 65536, diagnostic_bytes=64, legacy_bytes=65536, persist_interval=.5)
            p.feed(wire([{'type': 'session', 'cwd': '/code'}]))
            p.feed(wire(tools(['a'] * 100) + final()))
            p.finish('ok')
            retention = load_json(Path(t) / 'pi-events.jsonl.retention.json')
            self.assertFalse(retention['complete'])
            usage = read_observation(Path(t))['usage']
            self.assertEqual(usage['reads'], 100)
            self.assertEqual(usage['repeat_reads'], 99)
            self.assertEqual(usage['tokens']['cache_read'], 20)

    def test_text_adapter_never_claims_zero_event_statistics(self):
        p = PiEvents(None, 65536)
        p.feed(b'{"ok":true}')
        p.finish('ok')
        for field in COST_FIELDS:
            self.assertIsNone(p.usage()[field], field)

    def test_old_projection_remains_valid_with_unknown_new_fields(self):
        with tempfile.TemporaryDirectory() as t:
            old = {'assistant_messages': 2, 'tool_calls': 1, 'tokens': {'input': 10}}
            atomic_json(Path(t) / 'usage.json', old)
            observation = read_observation(Path(t))
            self.assertFalse(observation['errors'])
            self.assertEqual(observation['usage']['tokens']['input'], 10)
            for field in COST_FIELDS:
                self.assertIsNone(observation['usage'][field], field)

    def test_invalid_new_statistics_do_not_destroy_old_token_coverage(self):
        with tempfile.TemporaryDirectory() as t:
            usage = projection(['a'])
            usage.update(reads=True, tools_by_name={'read': -1}, read_paths='not a list')
            atomic_json(Path(t) / 'usage.json', usage)
            observation = read_observation(Path(t))
            self.assertEqual(observation['usage']['tokens']['input'], 10)
            self.assertIsNone(observation['usage']['reads'])
            self.assertIsNone(observation['usage']['tools_by_name'])
            self.assertIsNone(observation['usage']['read_paths'])
            self.assertTrue(observation['errors'])

    def test_aggregation_is_additive_and_preserves_original_coverage(self):
        usage = projection(['a', 'a'])
        usage['cross_reads'] = 0
        complete = summarize([{'usage': usage}, {'usage': usage}], 2)['usage']
        self.assertEqual(complete['reads'], 4)
        self.assertEqual(complete['tools_by_name'], {'read': 4})
        self.assertEqual(complete['tokens']['input'], 20)
        partial = summarize([{'usage': usage}, {'usage': None}], 2)['usage']
        self.assertIsNone(partial['reads'])
        self.assertIsNone(partial['tools_by_name'])
        self.assertEqual(partial['coverage']['reads']['observed_total'], 2)
        self.assertIsNone(partial['tokens']['input'])
        self.assertEqual(partial['coverage']['tokens']['input']['observed_total'], 10)
        self.assertIsNone(summarize([], 0)['usage']['reads'])


class CodeMapProtocol(unittest.TestCase):
    def validate(self, report, context):
        with tempfile.TemporaryDirectory() as t:
            return validate_report(report, context, Path(t), {})

    def test_optional_code_map_and_exact_unicode_character_limit(self):
        schema = response_schema()
        self.assertIn('code_map', schema['properties'])
        self.assertNotIn('code_map', schema['required'])
        report, context = report_context()
        self.validate(report, context)
        report['code_map'] = '图' * 8000
        self.validate(report, context)
        report['code_map'] += '图'
        with self.assertRaisesRegex(LoopError, 'code_map.*8000'):
            self.validate(report, context)

    def test_map_must_be_nonempty_text_and_reviewer_cannot_provide_it(self):
        report, context = report_context()
        for value in (None, 4, [], '', ' \n\t '):
            with self.subTest(value=value), self.assertRaisesRegex(LoopError, 'code_map'):
                self.validate({**report, 'code_map': value}, context)
        report, context = report_context('reviewer')
        with self.assertRaisesRegex(LoopError, '评审方.*code_map'):
            self.validate({**report, 'code_map': 'a: C'}, context)

    def test_prompt_keeps_map_and_exact_round_specific_reading_guides(self):
        _, context = report_context(round_number=2)
        context['code_map'] = {'round': 1, 'text': 'a: C; offline choice'}
        prompt = member_prompt(context)
        self.assertIn(REPAIR_GUIDE, prompt)
        self.assertIn('8000', prompt)
        self.assertIn('每个新建、修改或删除的文件的相对路径', prompt)
        self.assertIn('可以用以 / 结尾的目录前缀统一覆盖，程序会核对有没有漏写', prompt)
        self.assertIn('在上一份地图的基础上更新，不要从头重写', prompt)
        self.assertEqual(prompt_view(context)['code_map'], context['code_map'])
        _, review = report_context('reviewer', 2)
        self.assertIn(REVIEW_GUIDE, member_prompt(review))
        _, first = report_context()
        self.assertIsNone(prompt_view(first)['code_map'])
        self.assertNotIn(REPAIR_GUIDE, member_prompt(first))
        _, first_review = report_context('reviewer')
        self.assertNotIn(REVIEW_GUIDE, member_prompt(first_review))


class EngineCost(unittest.TestCase):
    def run_fixture(self, base, *, maps=('value.txt: C; 改写值以通过门禁。', None), events=True,
                    max_context_bytes=None, rejected_first_map=False):
        raw = project(base, developer=True)
        source = Path(raw['source'])
        with (source / 'build.py').open('a') as f:
            f.write("\nif Path('value.txt').read_text() == 'round-1': raise SystemExit(1)\n")
        if max_context_bytes is not None:
            raw['limits']['max_context_bytes'] = max_context_bytes
        state, root, draft = prepared(base, raw)
        rid, sealed, _ = create_prepared_run(state, root, draft)
        contexts, prompts = [], []
        rejected = False

        def run_job(engine, argv, code, job, stdin, timeout, idle, env, phase):
            nonlocal rejected
            context = load_json(Path(env['LOOP_CONTEXT']))
            contexts.append(context); prompts.append(stdin)
            job.mkdir(parents=True, exist_ok=True)
            report = {'attempt_id': context['attempt_id'], 'role': context['role'],
                      'candidate_hash': context['candidate_hash'], 'summary': 'offline stub, not a model',
                      'blocked': False, 'criteria': [
                          {'id': 'C', 'status': 'PASS', 'note': 'offline', 'evidence': ['code:value.txt']}],
                      'issues': [], 'rule_gaps': []}
            if context['role'] == 'developer':
                if not context['protocol_repair_only']:
                    (code / 'value.txt').write_text('round-' + str(context['round']))
                code_map = maps[min(context['round'] - 1, len(maps) - 1)]
                if code_map is not None:
                    report['code_map'] = code_map
                if rejected_first_map and not rejected:
                    report['code_map'] = 'x' * 8001
                    rejected = True
            if events:
                p = PiEvents(job.parent, 65536, diagnostic_bytes=64, legacy_bytes=65536, code_path=code)
                paths = [str(code / 'value.txt'), 'value.txt', '/outside/shared']
                p.feed(wire([{'type': 'session', 'cwd': str(code)}] + tools(paths) + final(report)))
                p.finish('ok')
            atomic_write(job / 'stdout.log', json.dumps(report))
            return {'reason': 'ok', 'exit_code': 0, 'elapsed_seconds': 1.25, 'wall_elapsed_seconds': 1.25}

        with patch.object(UnitEngine, 'run_job', run_job), patch.dict(os.environ, {'LOOP_NO_NOTIFY': '1'}):
            Controller(root, rid).execute()
        data = load_json(root / 'runs' / rid / 'manifest.json')
        return data, contexts, prompts, root / 'runs' / rid / 'result.md'

    def test_failed_gate_repair_and_reviewer_receive_last_accepted_map(self):
        with tempfile.TemporaryDirectory() as t:
            data, contexts, prompts, result_path = self.run_fixture(Path(t))
            self.assertEqual(data['result']['stop'], 'PASSED', data['result'])
            self.assertEqual([(c['role'], c['round']) for c in contexts],
                             [('developer', 1), ('reviewer', 1), ('developer', 2), ('reviewer', 2)])
            self.assertIsNone(contexts[0]['code_map'])
            for context in contexts[1:3]:
                self.assertEqual(context['code_map'], {'round': 1, 'text': 'value.txt: C; 改写值以通过门禁。'})
            self.assertIsNone(contexts[3]['code_map'])
            self.assertIn(REPAIR_GUIDE, prompts[2]); self.assertIn(REVIEW_GUIDE, prompts[3])
            result = data['units']['check']['result']
            self.assertEqual(result['history'][0]['gates']['G']['status'], 'FAIL')
            sessions = result['cost_sessions']
            self.assertEqual([s['cross_reads'] for s in sessions], [0, 2, 2, 2])
            self.assertEqual([s['code_map_provided'] for s in sessions], [True, False, False, False])
            for record in result['member_observations'].values():
                self.assertIsNotNone(record['usage']['cross_reads'])
            self.assertEqual(data['result']['member_usage']['reads'], 12)
            self.assertEqual(data['result']['member_usage']['cross_reads'], 6)
            md = result_path.read_text()
            self.assertIn('#### 成本', md)
            self.assertIn('运行合计：缓存读取 80 token、读文件 12 次、跨会话重读 6 次', md)
            self.assertIn('成员用量：`', md)
            self.assertIn('会话内重读 | 跨会话重读', md)
            self.assertIn('| 1.25 秒 | 1 | 3 | 3 | 2 | 1 | 0 | 无地图 | 10 | 20 | 3 | 是 |', md)
            self.assertEqual(md, markdown_result(data))
            # The per-attempt projection stays sealed; cross-session fields live in the final manifest.
            for record in result['member_observations'].values():
                self.assertIsNone(load_json(Path(record['workspace']) / 'usage.json')['cross_reads'])

    def test_new_map_replaces_old_only_after_accepted_developer_delivery(self):
        with tempfile.TemporaryDirectory() as t:
            data, contexts, _, _ = self.run_fixture(Path(t), maps=('  value.txt: first map  ', 'value.txt: updated map'))
            self.assertEqual(data['result']['stop'], 'PASSED')
            self.assertEqual(contexts[2]['code_map'], {'round': 1, 'text': 'value.txt: first map'})
            self.assertEqual(contexts[3]['code_map'], {'round': 2, 'text': 'value.txt: updated map'})

    def test_rejected_map_does_not_leak_into_format_repair_context(self):
        with tempfile.TemporaryDirectory() as t:
            data, contexts, _, _ = self.run_fixture(Path(t), rejected_first_map=True)
            self.assertEqual(data['result']['stop'], 'PASSED', data['result'])
            self.assertTrue(contexts[1]['protocol_repair_only'])
            self.assertIsNone(contexts[1]['code_map'])
            sessions = data['units']['check']['result']['cost_sessions']
            self.assertIsNone(sessions[0]['code_map_provided'])
            self.assertTrue(sessions[1]['code_map_provided'])

    def test_missing_map_is_accepted_and_command_statistics_are_unknown(self):
        with tempfile.TemporaryDirectory() as t:
            data, contexts, _, result_path = self.run_fixture(Path(t), maps=(None,), events=False)
            self.assertEqual(data['result']['stop'], 'PASSED', data['result'])
            self.assertTrue(all(c['code_map'] is None for c in contexts))
            sessions = data['units']['check']['result']['cost_sessions']
            for session in sessions:
                for field in ('assistant_messages', 'tool_calls', 'reads', 'distinct_files', 'repeat_reads',
                              'cross_reads', 'input', 'cache_read', 'output'):
                    self.assertIsNone(session[field], field)
                self.assertFalse(session['code_map_provided'])
            self.assertIn('| 1.25 秒 | 未知 | 未知 | 未知 | 未知 | 未知 | 未知 | 未知 | 未知 | 未知 | 未知 | 否 |',
                          result_path.read_text())
            self.assertIn('缓存读取 未知 token、读文件 未知 次、跨会话重读 未知 次', result_path.read_text())

    def test_code_map_does_not_bypass_existing_context_byte_limit(self):
        with tempfile.TemporaryDirectory() as t:
            code_map = 'value.txt ' + '图' * (8000 - len('value.txt '))
            data, contexts, _, _ = self.run_fixture(Path(t), maps=(code_map, None), max_context_bytes=24000)
            self.assertEqual(data['result']['stop'], 'BLOCKED', data['result'])
            self.assertIn('上下文包超过上限', data['units']['check']['result']['reason'])
            self.assertEqual(len(contexts), 1)

    def test_cross_session_comparison_uses_call_order_not_attempt_sort_order(self):
        from loop_engineering.observability import cost_sessions
        records = [
            {'attempt_id': 'a-second', 'role': 'reviewer', 'round': 1, 'call_order': 1,
             'usage': projection(['same', '/outside/shared'], code='/review')},
            {'attempt_id': 'z-first', 'role': 'developer', 'round': 1, 'call_order': 0,
             'usage': projection(['same', '/outside/shared'], code='/develop')}]
        sessions = cost_sessions(records)
        self.assertEqual([s['attempt_id'] for s in sessions], ['z-first', 'a-second'])
        self.assertEqual([s['cross_reads'] for s in sessions], [0, 2])
        # Each invocation of cost_sessions represents one unit, never a run-wide path set.
        self.assertEqual(cost_sessions([copy.deepcopy(records[0])])[0]['cross_reads'], 0)

    def test_unknown_previous_session_does_not_invent_complete_cross_read_count(self):
        from loop_engineering.observability import cost_sessions
        records = [{'usage': None}, {'usage': projection(['a'])}]
        sessions = cost_sessions(records)
        self.assertIsNone(sessions[0]['cross_reads'])
        self.assertIsNone(sessions[1]['cross_reads'])
        self.assertIsNone(records[1]['usage']['cross_reads'])


if __name__ == '__main__':
    unittest.main()
