"""Pi wire counterexamples. Every subprocess is a local deterministic stub, not Pi."""
import copy
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest

PROJECT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT / 'engine'))
from loop_engineering.pi_events import EventError, PiEvents

PI_SAMPLE = json.loads((PROJECT / 'engine/tests/fixtures/pi-0.87.1.json').read_text())


def compaction_events(reason='threshold', summary_retry=False):
    events = copy.deepcopy(PI_SAMPLE['compaction'])
    if summary_retry:
        events[1:1] = copy.deepcopy(PI_SAMPLE['summarization_retry'])
    for event in events:
        if 'reason' in event:
            event['reason'] = reason
    return events


def message(text='{"answer":2}', usage=None, stop='stop'):
    m = {'role': 'assistant', 'content': [{'type': 'text', 'text': text}], 'stopReason': stop}
    if usage is not None:
        m['usage'] = usage
    return {'type': 'message_end', 'message': m}


def wire(events):
    return ''.join(json.dumps(e, ensure_ascii=False) + '\n' for e in events).encode('utf-8')


def final_events(**kw):
    return [message(**kw), {'type': 'agent_end', 'messages': [], 'willRetry': False}, {'type': 'agent_settled'}]


def uncorrelated_tool_events():
    for kind in ('tool_execution_start', 'tool_execution_update', 'tool_execution_end'):
        for fields in ({}, {'toolCallId': None}, {'toolCallId': ''}, {'toolCallId': 7}):
            yield {'type': kind, 'toolName': 'read', **fields}
    for kind in ('tool_execution_update', 'tool_execution_end'):
        yield {'type': kind, 'toolCallId': 'unseen', 'toolName': 'read'}


class EventProjection(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.work = Path(self.tmp.name)
        self.parser = PiEvents(self.work, 65536)
        self.addCleanup(lambda: self.parser.finish('cancelled') if self.parser.activity['running'] else None)

    def usage(self):
        return json.loads((self.work / 'usage.json').read_text())

    def test_byte_packets_utf8_and_unicode_separators_are_not_frames(self):
        text = json.dumps({'answer': '中文\u2028甲\u2029乙'}, ensure_ascii=False)
        data = wire([{'type': 'session'}] + final_events(text=text)).replace(b'\n', b'\r\n')
        for byte in data:
            self.parser.feed(bytes([byte]))
        self.assertEqual(json.loads(self.parser.finish('ok')), {'answer': '中文\u2028甲\u2029乙'})
        self.assertEqual((self.work / 'pi-events.jsonl').read_bytes(), data)

    def test_multiple_assistants_only_latest_complete_text_blocks(self):
        last = message()
        last['message']['content'] = [{'type': 'thinking', 'thinking': 'not a report'},
                                      {'type': 'text', 'text': '{"answer":'}, {'type': 'text', 'text': '2}'}]
        self.parser.feed(wire([message('{"answer":1}'), {'type': 'turn_start'}, last, {'type': 'agent_settled'}]))
        self.assertEqual(json.loads(self.parser.finish('ok')), {'answer': 2})
        self.assertEqual(self.usage()['assistant_messages'], 2)

    def test_only_message_end_usage_not_repeated_payloads(self):
        usage = {'input': 100, 'output': 20, 'cacheRead': 30, 'cacheWrite': 0, 'cost': {'total': 0}}
        m = message(usage=usage)
        self.parser.feed(wire([{'type': 'message_update', 'usage': usage}, m,
            {'type': 'turn_end', 'message': m['message']},
            {'type': 'agent_end', 'messages': [m['message']], 'willRetry': False}, {'type': 'agent_settled'}]))
        self.parser.finish('ok')
        u = self.usage()
        self.assertEqual(u['assistant_messages'], 1)
        self.assertEqual(u['tokens'], {'input': 100, 'output': 20, 'cache_read': 30, 'cache_write': 0})
        self.assertIsNone(u['cost'])
        self.assertIsNone(u['api_requests'])

    def test_missing_dimensions_unknown_with_observed_subtotal(self):
        self.parser.feed(wire([message(usage={'input': 5, 'output': 2, 'cacheRead': 0}),
            {'type': 'turn_start'}] + final_events(usage={'input': 7, 'cacheWrite': 4})))
        self.parser.finish('ok')
        u = self.usage()
        self.assertEqual(u['tokens'], {'input': 12, 'output': None, 'cache_read': None, 'cache_write': None})
        self.assertEqual(u['coverage']['tokens']['output']['observed_total'], 2)
        self.assertEqual(u['coverage']['tokens']['output']['known_messages'], 1)

    def test_bad_numeric_fields_do_not_become_zero(self):
        self.parser.feed(wire(final_events(usage={'input': True, 'output': -1, 'cacheRead': '10', 'cacheWrite': None})))
        self.parser.finish('ok')
        self.assertEqual(set(self.usage()['tokens'].values()), {None})

    def test_nonzero_provider_estimate_is_not_an_account_bill(self):
        self.parser.feed(wire(final_events(usage={'input': 1, 'cost': {'total': 5.5}})))
        self.parser.finish('ok')
        self.assertIsNone(self.usage()['cost'])
        self.assertIn('not verified', self.usage()['coverage']['cost'])

    def test_tool_ids_correlate_even_with_identical_names(self):
        self.parser.feed(wire([{'type': 'turn_start'},
            {'type': 'tool_execution_start', 'toolCallId': 'a', 'toolName': 'read'},
            {'type': 'tool_execution_start', 'toolCallId': 'b', 'toolName': 'read'},
            {'type': 'tool_execution_update', 'toolCallId': 'a', 'partialResult': {'text': 'waiting'}},
            {'type': 'tool_execution_end', 'toolCallId': 'a'}]))
        a = json.loads((self.work / 'activity.json').read_text())
        self.assertEqual(a['phase'], 'tools')
        self.assertEqual(a['tool_calls'], [{'toolCallId': 'b', 'toolName': 'read'}])
        self.parser.feed(wire([{'type': 'tool_execution_end', 'toolCallId': 'b'}] + final_events()))
        self.parser.finish('ok')
        self.assertEqual(self.usage()['tool_calls'], 2)

    def test_unmatched_tool_does_not_close_another_id(self):
        self.parser.feed(wire([{'type': 'tool_execution_start', 'toolCallId': 'a', 'toolName': 'read'},
            {'type': 'tool_execution_end', 'toolCallId': 'other', 'toolName': 'read'}]))
        self.assertEqual(self.parser.activity['phase'], 'unknown')
        self.assertIn('a', self.parser.active_tools)
        self.assertIsNone(self.usage()['tool_calls'])

    def test_uncorrelated_tool_events_invalidate_settled_old_response(self):
        for event in uncorrelated_tool_events():
            for repeat_settled in (False, True):
                with self.subTest(event=event, repeat_settled=repeat_settled):
                    p = PiEvents(None, 65536)
                    old = message('{"answer":1}')
                    p.feed(wire([old, {'type': 'agent_settled'}, event]))
                    self.assertIsNone(p.candidate)
                    self.assertFalse(p.settled)
                    self.assertTrue(p.pending_work)
                    self.assertEqual(p.activity['phase'], 'unknown')
                    self.assertIsNone(p.usage()['tool_calls'])
                    if repeat_settled:
                        # Repeated payloads and idle notifications are not a new message_end.
                        p.feed(wire([{'type': 'turn_end', 'message': old['message']},
                            {'type': 'agent_end', 'messages': [old['message']], 'willRetry': False},
                            {'type': 'agent_settled'}]))
                    with self.assertRaises(EventError) as exc:
                        p.finish('ok')
                    self.assertEqual(exc.exception.reason, 'invalid_response')

    def test_matching_later_tool_lifecycle_cannot_restore_old_reply(self):
        for event in uncorrelated_tool_events():
            with self.subTest(event=event):
                p = PiEvents(None, 65536)
                p.feed(wire(final_events(text='{"answer":1}') + [event,
                    {'type': 'tool_execution_start', 'toolCallId': 'seen', 'toolName': 'read'},
                    {'type': 'tool_execution_end', 'toolCallId': 'seen', 'toolName': 'read'},
                    {'type': 'agent_settled'}]))
                self.assertFalse(p.active_tools)
                self.assertTrue(p.pending_work)
                self.assertIsNone(p.candidate)
                self.assertIsNone(p.usage()['tool_calls'])
                with self.assertRaises(EventError): p.finish('ok')

    def test_new_completed_response_after_uncorrelated_tool_is_deliverable(self):
        for event in uncorrelated_tool_events():
            with self.subTest(event=event):
                p = PiEvents(None, 65536)
                p.feed(wire(final_events(text='{"answer":1}', usage={'input': 3}) + [event]
                            + final_events(text='{"answer":3}', usage={'input': 5})))
                self.assertEqual(json.loads(p.finish('ok')), {'answer': 3})
                u = p.usage()
                self.assertEqual(u['assistant_messages'], 2)
                self.assertEqual(u['tokens']['input'], 8)
                self.assertIsNone(u['tool_calls'])  # Recovery is not complete tool-count coverage.
                self.assertTrue(u['coverage']['final_response_settled'])

    def test_uncorrelated_tool_then_incomplete_response_cannot_reuse_old_reply(self):
        for event in uncorrelated_tool_events():
            for tail in ([{'type': 'message_update', 'assistantMessageEvent':
                              {'type': 'text_delta', 'delta': '{"answer":3}'}}, {'type': 'agent_settled'}],
                         [message('{"answer":3}', stop='error'), {'type': 'agent_settled'}],
                         [message('{"answer":3}', stop='length'), {'type': 'agent_settled'}],
                         [message('{"answer":3}')],
                         [{'type': 'message_end', 'message': {'role': 'toolResult',
                            'toolCallId': 'unseen', 'content': [{'type': 'text', 'text': '{"answer":3}'}]}},
                          {'type': 'agent_settled'}],
                         final_events(text='not a JSON response')):
                with self.subTest(event=event, tail=tail):
                    p = PiEvents(None, 65536)
                    p.feed(wire(final_events(text='{"answer":1}') + [event] + tail))
                    with self.assertRaises(EventError): p.finish('ok')

    def test_unmatched_id_cannot_close_live_tool_or_deliver_before_its_end(self):
        for close_tool in (False, True):
            with self.subTest(close_tool=close_tool):
                p = PiEvents(None, 65536)
                p.feed(wire(final_events(text='{"answer":1}') + [
                    {'type': 'tool_execution_start', 'toolCallId': 'a', 'toolName': 'read'},
                    {'type': 'tool_execution_end', 'toolCallId': 'other', 'toolName': 'read'}]
                    + final_events(text='{"answer":3}')))
                self.assertIn('a', p.active_tools)
                self.assertFalse(p.settled)
                if close_tool:
                    p.feed(wire([{'type': 'tool_execution_end', 'toolCallId': 'a'},
                                 {'type': 'agent_settled'}]))
                    self.assertFalse(p.active_tools)
                    self.assertTrue(p.pending_work)
                    self.assertIsNone(p.candidate)  # A response preceding tool completion is stale.
                with self.assertRaises(EventError): p.finish('ok')

    def test_waiting_responding_and_tool_stages_need_events(self):
        self.assertEqual(self.parser.activity['phase'], 'unknown')
        self.assertIsNone(self.parser.activity['last_event_at'])
        self.parser.feed(wire([{'type': 'turn_start'}]))
        first = self.parser.activity['last_event_at']
        self.assertEqual(self.parser.activity['phase'], 'waiting')
        self.parser.feed(wire([{'type': 'message_update', 'assistantMessageEvent': {'type': 'thinking_delta', 'delta': 'x'}}]))
        self.assertEqual(self.parser.activity['phase'], 'responding')
        self.assertNotEqual(first, self.parser.activity['last_event_at'])

    def test_partial_or_error_or_unsettled_cannot_deliver(self):
        for events in ([{'type': 'message_update', 'assistantMessageEvent': {'type': 'text_delta', 'delta': '{"answer":2}'}}],
                       [message(stop='error'), {'type': 'agent_settled'}],
                       [message(stop='length'), {'type': 'agent_settled'}], [message()]):
            with self.subTest(events=events):
                p = PiEvents(None, 65536)
                p.feed(wire(events))
                with self.assertRaises(EventError): p.finish('ok')

    def test_retry_then_success_counts_ends_and_no_hidden_requests(self):
        self.parser.feed(wire([message(stop='error', usage={'input': 2}),
            {'type': 'auto_retry_start', 'attempt': 1}, {'type': 'agent_start'},
            {'type': 'auto_retry_end', 'success': True}] + final_events(usage={'input': 3})))
        self.assertEqual(json.loads(self.parser.finish('ok')), {'answer': 2})
        self.assertEqual(self.usage()['tokens']['input'], 5)
        self.assertEqual(self.usage()['coverage']['retry_events'], 1)
        self.assertIsNone(self.usage()['api_requests'])

    def test_old_response_invalidated_by_retry_or_new_turn(self):
        for more in ([{'type': 'auto_retry_start'}, {'type': 'auto_retry_end', 'success': False}],
                     [{'type': 'agent_end', 'willRetry': True}], [{'type': 'turn_start'}],
                     [{'type': 'message_start', 'message': {'role': 'assistant'}}]):
            p = PiEvents(None, 65536)
            p.feed(wire(final_events() + more + [{'type': 'agent_settled'}]))
            with self.assertRaises(EventError): p.finish('ok')

    def test_compaction_usage_excluded_and_old_response_cannot_escape(self):
        self.parser.feed(wire(final_events() + [{'type': 'compaction_start', 'reason': 'overflow'},
            {'type': 'compaction_end', 'result': {'usage': {'input': 9000}}, 'willRetry': True},
            {'type': 'agent_settled'}]))
        with self.assertRaises(EventError): self.parser.finish('ok')
        self.assertEqual(self.usage()['assistant_messages'], 1)
        self.assertIsNone(self.usage()['tokens']['input'])
        self.assertEqual(self.usage()['coverage']['compaction_events'], 1)

    def test_compaction_then_new_completed_response(self):
        self.parser.feed(wire([{'type': 'compaction_start'}, {'type': 'compaction_end', 'result': {'summary': 'x'}},
            {'type': 'agent_start'}] + final_events(usage={'input': 4})))
        self.assertEqual(json.loads(self.parser.finish('ok')), {'answer': 2})
        self.assertEqual(self.usage()['tokens']['input'], 4)

    def test_successful_no_retry_compaction_keeps_completed_reply(self):
        for reason in ('threshold', 'overflow', 'manual'):
            for summary_retry in (False, True):
                with self.subTest(reason=reason, summary_retry=summary_retry):
                    p = PiEvents(None, 65536)
                    p.feed(wire(final_events(usage={'input': 3})[:-1]
                                + compaction_events(reason, summary_retry)))
                    self.assertFalse(p.settled)  # Compaction end alone is not settlement.
                    p.feed(wire([{'type': 'agent_settled'}]))
                    self.assertEqual(json.loads(p.finish('ok')), {'answer': 2})
                    self.assertEqual(p.usage()['tokens']['input'], 3)
                    self.assertEqual(p.usage()['coverage']['compaction_events'], 1)

    def test_incomplete_failed_or_unknown_compaction_cannot_recover_old_reply(self):
        start, end = compaction_events()
        invalid = [[start], [end], [start, start, end]]
        for field, value in (('result', None), ('result', {}), ('result', 'summary'),
                             ('aborted', True), ('aborted', 0), ('willRetry', True),
                             ('willRetry', 0), ('errorMessage', 'failed'), ('reason', 'overflow')):
            invalid.append([start, {**end, field: value}])
        for field in ('result', 'aborted', 'willRetry', 'reason'):
            invalid.append([start, {k: v for k, v in end.items() if k != field}])
        invalid.append([{**start, 'reason': 'unknown'}, {**end, 'reason': 'unknown'}])
        for events in invalid:
            with self.subTest(events=events):
                p = PiEvents(None, 65536)
                p.feed(wire(final_events() + events + [{'type': 'agent_settled'}]))
                with self.assertRaises(EventError): p.finish('ok')
        p = PiEvents(None, 65536)
        p.feed(wire(final_events() + compaction_events()))
        with self.assertRaises(EventError): p.finish('ok')  # Requires settlement after maintenance.

    def test_work_during_or_after_compaction_invalidates_old_reply(self):
        start, end = compaction_events()
        work = [{'type': 'turn_start'}, {'type': 'auto_retry_start'},
                {'type': 'message_start', 'message': {'role': 'assistant'}},
                {'type': 'message_update'}, {'type': 'message_end', 'message': {'role': 'user'}},
                {'type': 'queue_update', 'followUp': ['new task']},
                {'type': 'tool_execution_end', 'toolCallId': 'unseen'},
                {'type': 'summarization_retry_attempt_start', 'source': 'branchSummary'}]
        for event in work:
            for events in ([start, event, end], [start, end, event]):
                with self.subTest(events=events):
                    p = PiEvents(None, 65536)
                    p.feed(wire(final_events() + events + [{'type': 'agent_settled'}]))
                    with self.assertRaises(EventError): p.finish('ok')

    def test_compaction_retry_requires_new_completed_reply(self):
        start, end = compaction_events('overflow')
        for fields in ({'willRetry': True}, {'result': None, 'errorMessage': 'failed'}):
            p = PiEvents(None, 65536)
            p.feed(wire(final_events() + [start, {**end, **fields}, {'type': 'agent_start'}]
                        + final_events(text='{"answer":3}')))
            self.assertEqual(json.loads(p.finish('ok')), {'answer': 3})

    def test_pending_compaction_blocks_even_a_new_completed_reply(self):
        p = PiEvents(None, 65536)
        p.feed(wire([compaction_events()[0]] + final_events()))
        with self.assertRaises(EventError): p.finish('ok')

    def test_malformed_or_truncated_stream_is_not_legacy_fallback(self):
        for middle in (b'not-json\n', b'{"type":"message_end",broken}\n', b'\xff\n'):
            p = PiEvents(None, 65536)
            p.feed(wire([{'type': 'agent_start'}]) + middle + wire(final_events()))
            with self.assertRaises(EventError): p.finish('ok')
        self.parser.feed(wire(final_events()) + b'{"type":')
        with self.assertRaises(EventError): self.parser.finish('ok')

    def test_single_line_memory_cap(self):
        p = PiEvents(None, 128)
        with self.assertRaises(EventError) as exc: p.feed(b'x' * 129)
        self.assertEqual(exc.exception.reason, 'log_limit')
        self.assertLessEqual(len(p.buffer), 128)
        p.finish('log_limit')

    def test_user_followup_and_queued_work_cannot_reuse_old_response(self):
        for more in ([{'type': 'message_start', 'message': {'role': 'user'}}],
                     [{'type': 'message_end', 'message': {'role': 'user'}}],
                     [{'type': 'queue_update', 'followUp': ['new prompt'], 'steering': []}]):
            p = PiEvents(None, 65536)
            p.feed(wire(final_events() + more + [{'type': 'agent_settled'}]))
            with self.assertRaises(EventError): p.finish('ok')

    def test_duplicate_json_keys_never_get_normalized_into_valid_report(self):
        self.parser.feed(wire(final_events(text='{"answer":1,"answer":2}')))
        with self.assertRaises(EventError): self.parser.finish('ok')

    def test_overflow_usage_is_unknown_without_crashing_collector(self):
        self.parser.feed(wire([message(usage={'input': 1e308}), {'type': 'turn_start'}]
                              + final_events(usage={'input': 1e308})))
        self.assertEqual(json.loads(self.parser.finish('ok')), {'answer': 2})
        self.assertIsNone(self.usage()['tokens']['input'])
        self.assertEqual(self.usage()['coverage']['tokens']['input']['known_messages'], 1)

    def test_independent_workspace_does_not_show_previous_activity(self):
        self.parser.finish('cancelled')
        (self.work / 'activity.json').write_text('{"phase":"completed","last_event_at":"old"}')
        p = PiEvents(self.work, 65536)
        self.assertFalse((self.work / 'activity.json').exists())
        self.assertIsNone(p.activity['last_event_at'])
        p.finish('cancelled')

    def test_legacy_text_has_unknown_coverage_not_observed_zero(self):
        self.parser.feed(b'```json\n{"answer":2}\n```\n')
        self.assertEqual(json.loads(self.parser.finish('ok')), {'answer': 2})
        self.assertIsNone(self.usage()['assistant_messages'])
        self.assertIsNone(self.usage()['tool_calls'])
        self.assertIsNone(self.parser.activity['last_event_at'])
        self.assertEqual(self.parser.activity['phase'], 'unknown')


class ForegroundCollector(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.work = Path(self.tmp.name)
        self.workspace = self.work / 'attempt'
        self.workspace.mkdir()
        self.context = {'workspace_path': str(self.workspace),
                        'unit': {'stage_timeout_seconds': 5},
                        'limits': {'max_log_bytes': 1024 * 1024, 'max_response_bytes': 65536}}

    def start(self, source):
        fake = self.work / 'program'
        fake.write_text('#!' + sys.executable + '\nimport sys,os,time,json\nsys.stdin.read()\n' + source)
        fake.chmod(0o700)
        extension = self.work / 'offline-permission.ts'
        extension.write_text('// deterministic wire fixture only')
        c = self.work / 'context.json'
        c.write_text(json.dumps(self.context))
        env = dict(os.environ, LOOP_CONTEXT=str(c), LOOP_PI_BIN=str(fake))
        out, err = (self.work / 'out').open('wb'), (self.work / 'err').open('wb')
        self.addCleanup(out.close)
        self.addCleanup(err.close)
        p = subprocess.Popen([sys.executable, str(PROJECT / 'adapters/pi_member.py'), '--model', 'offline/protocol',
            '--thinking', 'max', '--tools', 'read', '--permission-extension', str(extension)], stdin=subprocess.PIPE, stdout=out, stderr=err, env=env)
        p.stdin.write(b'offline prompt')
        p.stdin.close()
        self.addCleanup(lambda: (p.kill(), p.wait()) if p.poll() is None else None)
        return p

    def wait(self, p):
        code = p.wait(timeout=10)
        return code, (self.work / 'out').read_bytes()

    def emitted(self):
        return 'os.write(1, ' + repr(wire(final_events(usage={'input': 3}))) + ')\n'

    def test_simultaneous_large_stderr_and_packeted_stdout_drained(self):
        source = 'os.write(2,b"diagnostic tools waiting responding\\n"*9000)\n'
        source += 'for b in ' + repr(wire(final_events())) + ':\n os.write(1,bytes([b]))\n'
        p = self.start(source)
        code, out = self.wait(p)
        self.assertEqual(code, 0, (self.work / 'err').read_text())
        self.assertEqual(json.loads(out), {'answer': 2})
        self.assertGreater((self.workspace / 'pi-stderr.log').stat().st_size, 200000)
        self.assertNotIn('diagnostic', out.decode())

    def test_uncorrelated_tool_events_after_settled_exit_zero_cannot_deliver(self):
        for event in uncorrelated_tool_events():
            for repeat_settled in (False, True):
                with self.subTest(event=event, repeat_settled=repeat_settled):
                    events = final_events(text='{"answer":1}', usage={'input': 3}) + [event]
                    if repeat_settled:
                        events.append({'type': 'agent_settled'})
                    code, out = self.wait(self.start('os.write(1, ' + repr(wire(events)) + ')\n'))
                    self.assertEqual(code, 2, (self.work / 'err').read_text())
                    self.assertEqual(out, b'')
                    activity = json.loads((self.workspace / 'activity.json').read_text())
                    self.assertEqual(activity['finish_reason'], 'invalid_response')
                    self.assertEqual(activity['phase'], 'unknown')
                    self.assertFalse(activity['running'])
                    usage = json.loads((self.workspace / 'usage.json').read_text())
                    self.assertEqual(usage['tokens']['input'], 3)
                    self.assertIsNone(usage['tool_calls'])
                    self.assertFalse(usage['coverage']['final_response_settled'])

    def test_uncorrelated_tool_then_new_final_delivers_only_new_json(self):
        for event in uncorrelated_tool_events():
            with self.subTest(event=event):
                events = final_events(text='{"answer":1}', usage={'input': 3}) + [event]
                events += final_events(text='{"answer":3}', usage={'input': 5})
                code, out = self.wait(self.start('os.write(1, ' + repr(wire(events)) + ')\n'))
                self.assertEqual(code, 0, (self.work / 'err').read_text())
                self.assertEqual(json.loads(out), {'answer': 3})
                usage = json.loads((self.workspace / 'usage.json').read_text())
                self.assertEqual(usage['assistant_messages'], 2)
                self.assertEqual(usage['tokens']['input'], 8)
                self.assertIsNone(usage['tool_calls'])
                self.assertTrue(usage['coverage']['final_response_settled'])

    def test_uncorrelated_tool_then_partial_or_unsettled_response_exits_nonzero(self):
        for event in ({'type': 'tool_execution_start', 'toolName': 'read'},
                      {'type': 'tool_execution_end', 'toolCallId': 'unseen', 'toolName': 'read'}):
            for tail in ([{'type': 'message_update', 'assistantMessageEvent':
                              {'type': 'text_delta', 'delta': '{"answer":3}'}}, {'type': 'agent_settled'}],
                         [message('{"answer":3}', stop='error'), {'type': 'agent_settled'}],
                         [message('{"answer":3}', stop='length'), {'type': 'agent_settled'}],
                         [message('{"answer":3}')]):
                with self.subTest(event=event, tail=tail):
                    events = final_events(text='{"answer":1}') + [event] + tail
                    code, out = self.wait(self.start('os.write(1, ' + repr(wire(events)) + ')\n'))
                    self.assertEqual(code, 2, (self.work / 'err').read_text())
                    self.assertEqual(out, b'')
                    activity = json.loads((self.workspace / 'activity.json').read_text())
                    self.assertEqual(activity['finish_reason'], 'invalid_response')

    def test_diagnostic_soft_limits_preserve_complete_delivery(self):
        # 0.4 deliberate contract change: diagnostics retained per stream; parsing is complete.
        self.context['limits']['max_log_bytes'] = 4096
        code, out = self.wait(self.start('os.write(2,b"x"*60000)\n' + self.emitted()))
        self.assertEqual(code, 0, (self.work / 'err').read_text())
        self.assertEqual(json.loads(out), {'answer': 2})
        for name in ('pi-events.jsonl', 'pi-stderr.log'):
            self.assertLessEqual((self.workspace / name).stat().st_size, 4096)
        retention = json.loads((self.workspace / 'pi-stderr.log.retention.json').read_text())
        self.assertFalse(retention['complete'])
        self.assertEqual(retention['observed_bytes'], 60000)
        self.assertEqual(json.loads((self.workspace / 'activity.json').read_text())['finish_reason'], 'ok')

    def test_no_newline_oversize_is_bounded_and_stops(self):
        self.context['limits']['max_log_bytes'] = 1024
        self.context['limits']['max_event_bytes'] = 1024
        code, out = self.wait(self.start('os.write(1,b"x"*100000)\ntime.sleep(5)\n'))
        self.assertNotEqual(code, 0)
        self.assertEqual(out, b'')
        self.assertEqual((self.workspace / 'pi-events.jsonl').stat().st_size, 1024)

    def test_error_exit_does_not_deliver_even_completed_json(self):
        code, out = self.wait(self.start(self.emitted() + 'sys.exit(7)\n'))
        self.assertEqual(code, 7)
        self.assertEqual(out, b'')
        self.assertEqual(json.loads((self.workspace / 'usage.json').read_text())['tokens']['input'], 3)

    def test_compaction_wire_delivers_only_successful_settled_zero_exit(self):
        for reason, retry in (('threshold', False), ('overflow', False), ('threshold', True)):
            events = final_events()[:-1] + compaction_events(reason, retry) + [{'type': 'agent_settled'}]
            with self.subTest(reason=reason, summary_retry=retry):
                code, out = self.wait(self.start('os.write(1, ' + repr(wire(events)) + ')\n'))
                self.assertEqual(code, 0, (self.work / 'err').read_text())
                self.assertEqual(json.loads(out), {'answer': 2})
        start, end = compaction_events()
        tails = [[start], [start, {**end, 'aborted': True}],
                 [start, {**end, 'result': None, 'errorMessage': 'failed'}],
                 [start, {**end, 'willRetry': True}],
                 [start, {'type': 'message_start', 'message': {'role': 'user'}}, end]]
        for tail in tails:
            with self.subTest(tail=tail):
                events = final_events()[:-1] + tail + [{'type': 'agent_settled'}]
                code, out = self.wait(self.start('os.write(1, ' + repr(wire(events)) + ')\n'))
                self.assertEqual(code, 2)
                self.assertEqual(out, b'')
        events = final_events()[:-1] + compaction_events()
        code, out = self.wait(self.start('os.write(1, ' + repr(wire(events)) + ')\n'))
        self.assertEqual((code, out), (2, b''))
        events += [{'type': 'agent_settled'}]
        code, out = self.wait(self.start('os.write(1, ' + repr(wire(events)) + ')\nsys.exit(7)\n'))
        self.assertEqual((code, out), (7, b''))

    def test_signal_cancellation_is_foreground_and_no_delivery(self):
        p = self.start('os.write(1,' + repr(wire([{'type': 'turn_start'}])) + ')\ntime.sleep(5)\n')
        until = time.monotonic() + 3
        while not (self.workspace / 'activity.json').exists() and time.monotonic() < until:
            time.sleep(.02)
        self.assertIsNone(p.poll())
        p.send_signal(signal.SIGTERM)
        code, out = self.wait(p)
        self.assertNotEqual(code, 0)
        self.assertEqual(out, b'')
        self.assertEqual(json.loads((self.workspace / 'activity.json').read_text())['finish_reason'], 'cancelled')

    def test_cancel_file_is_observed(self):
        p = self.start('os.write(1,' + repr(wire([{'type': 'turn_start'}])) + ')\ntime.sleep(5)\n')
        (self.workspace / 'cancel').touch()
        code, out = self.wait(p)
        self.assertNotEqual(code, 0)
        self.assertEqual(out, b'')

    def test_hard_timeout_not_extended_by_continuous_activity(self):
        self.context['unit']['stage_timeout_seconds'] = .35
        begin = time.monotonic()
        source = 'for i in range(100):\n os.write(1,b\'{"type":"message_update"}\\n\')\n time.sleep(.03)\n'
        code, out = self.wait(self.start(source))
        self.assertLess(time.monotonic() - begin, 2)
        self.assertNotEqual(code, 0)
        self.assertEqual(out, b'')
        self.assertEqual(json.loads((self.workspace / 'activity.json').read_text())['finish_reason'], 'timeout')

    def test_inherited_deadline_not_reset(self):
        job = self.workspace / 'job'
        job.mkdir()
        (job / 'job.json').write_text(json.dumps({'timeout_seconds': 3, 'deadline_epoch': time.time() + .3,
            'cancel_file': str(self.work / 'cancel')}))
        begin = time.monotonic()
        code, out = self.wait(self.start('time.sleep(5)\n'))
        self.assertLess(time.monotonic() - begin, 2)
        self.assertNotEqual(code, 0)
        self.assertEqual(out, b'')

    def test_silent_text_logs_do_not_infer_activity(self):
        code, out = self.wait(self.start('os.write(2,b"waiting on model; tool read started\\n")\nprint("{\\"answer\\":2}")\n'))
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out), {'answer': 2})
        a = json.loads((self.workspace / 'activity.json').read_text())
        self.assertEqual(a['phase'], 'unknown')
        self.assertIsNone(a['last_event_at'])

    def test_cancel_after_settled_before_process_exit_still_cannot_deliver(self):
        p = self.start(self.emitted() + 'time.sleep(5)\n')
        until = time.monotonic() + 3
        while time.monotonic() < until:
            path = self.workspace / 'activity.json'
            if path.exists() and json.loads(path.read_text()).get('phase') == 'completed': break
            time.sleep(.02)
        self.assertIsNone(p.poll())
        p.send_signal(signal.SIGINT)
        code, out = self.wait(p)
        self.assertNotEqual(code, 0)
        self.assertEqual(out, b'')
        self.assertEqual(json.loads((self.workspace / 'usage.json').read_text())['tokens']['input'], 3)

    def test_closed_output_pipes_do_not_allow_unbounded_process_wait(self):
        self.context['unit']['stage_timeout_seconds'] = .35
        begin = time.monotonic()
        code, out = self.wait(self.start(self.emitted() + 'os.close(1)\nos.close(2)\ntime.sleep(5)\n'))
        self.assertLess(time.monotonic() - begin, 2)
        self.assertNotEqual(code, 0)
        self.assertEqual(out, b'')

    def test_response_size_limit_cannot_leak_partial_json(self):
        self.context['limits']['max_response_bytes'] = 4
        code, out = self.wait(self.start(self.emitted()))
        self.assertNotEqual(code, 0)
        self.assertEqual(out, b'')
