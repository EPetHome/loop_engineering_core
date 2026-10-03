"""Session ownership/fallback counterexamples. No Pi or model invocation."""
import copy
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from loop_engineering.adapters import ENGINE_DIR, member_prompt
from loop_engineering.common import LoopError, atomic_json, load_json
from loop_engineering.protocol import validate_report
from loop_engineering.rules import normalize
from loop_engineering.sessions import (DeveloperSessions, PI_MEMBER, SessionBusy, SessionLock,
                                      pi_session, session_contents, supports_reuse)
from loop_engineering.session_sandbox import protect


ENTRY_TIME = '2026-10-01T00:00:00.000Z'
USAGE = {'input': 10, 'output': 2, 'cacheRead': 0, 'cacheWrite': 0, 'totalTokens': 12,
         'cost': {'input': 0, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0, 'total': 0}}
USER = {'role': 'user', 'content': 'old checkout', 'timestamp': 1}
ASSISTANT = {'role': 'assistant', 'content': [{'type': 'text', 'text': 'answer'}],
             'api': 'anthropic-messages', 'provider': 'chosen-provider', 'model': 'chosen-model',
             'usage': USAGE, 'stopReason': 'stop', 'timestamp': 2}
TOOL = {'role': 'toolResult', 'toolCallId': 'call-1', 'toolName': 'read',
        'content': [{'type': 'text', 'text': 'result'}], 'isError': False, 'timestamp': 3}
SYSTEM = {'role': 'system', 'content': '', 'sections': {'cwd': '/old-checkout', 'removed': None},
          'toolsAdded': [{'name': 'read', 'description': 'Read files', 'parameters': {}}],
          'toolsRemoved': [{'name': 'write'}], 'timestamp': 0}


def v3_entry(entry_type, **payload):
    return {'type': entry_type, 'id': 'bad', 'parentId': None, 'timestamp': ENTRY_TIME, **payload}


class LocalStore:
    def __init__(self, root, rid):
        self.root, self.rid = root, rid
        self.run = root / 'runs' / rid
        self.run.mkdir(parents=True)
        self.events, self.sealed = [], []

    def event(self, *args, **kwargs):
        self.events.append((args, kwargs))

    def seal(self, path):
        self.sealed.append(path)


class SessionContract(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.work = Path(self.tmp.name).resolve()
        self.store = LocalStore(self.work / 'data', 'run-one')
        self.unit = {'id': 'u', 'developer_session': 'reuse_repairs', 'criteria': [{'id': 'S'}]}
        self.agent = {'kind': 'command', 'identity': 'dev', 'output': 'stdout', 'inherit_env': [],
                      'argv': [sys.executable, str(PI_MEMBER), '--model', 'chosen-model', '--thinking', 'max', '--tools', 'read,bash,edit,write']}
        self.sessions = DeveloperSessions(self.store, self.unit, 'developer')
        self.sessions.__enter__()
        self.addCleanup(self.sessions.__exit__, None, None, None)
        self.sequence = 0

    def context(self, round=1, role='developer', protocol=False):
        self.sequence += 1
        attempt = f'{role}-{self.sequence}'
        code = self.store.root / 'checkouts' / self.store.rid / 'u' / attempt
        code.mkdir(parents=True)
        (code / 'x.py').write_text('value=1\n')
        workspace = self.store.run / 'units/u/attempts' / attempt
        workspace.mkdir(parents=True)
        return {'run_id': self.store.rid, 'unit_id': 'u', 'role': role, 'rule_hash': 'rules',
                'unit_input_hash': 'input', 'attempt_id': attempt, 'round': round,
                'code_path': str(code), 'workspace_path': str(workspace), 'candidate_hash': '',
                'unit': self.unit, 'protocol_repair_only': protocol, 'feedback': {'failed': 'S'} if round > 1 else None}

    def select(self, context, agent=None):
        context['session'] = self.sessions.select(context, agent or self.agent)
        atomic_json(Path(context['workspace_path']) / 'context.json', context)
        return context['session']

    def seed(self):
        c = self.context()
        self.select(c)
        with pi_session(c, Path(c['code_path'])) as flags:
            self.assertEqual(flags[:2], ['--session', c['session']['session_path']])
        self.sessions.complete(c, True, 'accepted')
        return c

    def test_fresh_default_never_creates_or_discovers_a_session(self):
        fresh = DeveloperSessions(self.store, {'id': 'u'}, 'developer')
        c = self.context()
        c['session'] = fresh.select(c, self.agent)
        self.assertEqual(c['session']['mode'], 'fresh')
        self.assertIsNone(c['session']['session_path'])
        self.assertFalse(fresh.map_path.exists())
        with pi_session(c, Path(c['code_path'])) as flags:
            self.assertEqual(flags, ['--no-session'])

    def test_rebinding_keeps_id_header_fields_and_exact_historical_entries(self):
        first = self.seed()
        path = Path(first['session']['session_path'])
        header = json.loads(path.read_bytes().split(b'\n', 1)[0])
        header['extra'] = {'future': 'preserved'}
        history = (json.dumps(v3_entry('message', id='old-entry', message=USER)) + '\n').encode()
        path.write_bytes(json.dumps(header).encode() + b'\n' + history)
        c = self.context(2)
        s = self.select(c)
        self.assertEqual(s['mode'], 'reuse_repairs')
        self.assertEqual(s['session_path'], str(path))
        self.assertIn(first['code_path'], s['previous_code_paths'])
        with pi_session(c, Path(c['code_path'])) as flags:
            self.assertNotIn('--continue', flags)
            with self.assertRaises(SessionBusy):
                with SessionLock(path.with_suffix('.lock')): pass
            rebound, raw = session_contents(path, header['id'], c['code_path'])
            self.assertEqual(raw, history)
            self.assertEqual(rebound, {**header, 'cwd': c['code_path']})
        self.sessions.complete(c, True, 'accepted')
        self.assertTrue(load_json(self.sessions.map_path)['ready'])
        prompt = member_prompt(c)
        for value in (c['attempt_id'], c['code_path'], '旧 attempt/候选/回执不再有效', '显式续接'):
            self.assertIn(value, prompt)
        self.assertNotIn('这是全新会话', prompt)

    def test_binding_mismatch_falls_back_without_touching_old_session(self):
        first = self.seed()
        old_path = Path(first['session']['session_path'])
        before = old_path.read_bytes()
        original = load_json(self.sessions.map_path)
        for key in ('run_id', 'unit_id', 'role', 'rule_hash', 'unit_input_hash', 'developer_config_hash'):
            with self.subTest(binding=key):
                forged = copy.deepcopy(original)
                forged['binding'][key] = 'another-owner'
                atomic_json(self.sessions.map_path, forged)
                c = self.context(2)
                s = self.select(c)
                self.assertEqual(s['mode'], 'fresh')
                self.assertIn('binding mismatch', s['reason'])
                self.assertNotEqual(s['session_path'], str(old_path))
                self.assertEqual(old_path.read_bytes(), before)

    def test_developer_configuration_and_environment_cannot_be_inherited(self):
        self.seed()
        original = load_json(self.sessions.map_path)
        for key, value in (('identity', 'other-dev'), ('argv', self.agent['argv'][:-1] + ['read']),
                           ('inherit_env', ['SESSION_TEST_SETTING'])):
            with self.subTest(config=key):
                atomic_json(self.sessions.map_path, original)
                agent = {**self.agent, key: value}
                with patch.dict(os.environ, SESSION_TEST_SETTING='different'):
                    s = self.select(self.context(2), agent)
                self.assertEqual(s['mode'], 'fresh')
                self.assertIn('config', s['reason'])

    def test_other_run_and_unit_create_separate_mappings(self):
        first = self.seed()
        for rid, uid in (('run-two', 'u'), ('run-three', 'different-unit')):
            with self.subTest(run=rid, unit=uid):
                store = LocalStore(self.store.root, rid)
                unit = {**self.unit, 'id': uid}
                c = self.context()
                c.update(run_id=rid, unit_id=uid)
                with DeveloperSessions(store, unit, 'developer') as other:
                    s = other.select(c, self.agent)
                self.assertNotEqual(s['session_path'], first['session']['session_path'])
                self.assertEqual(s['mode'], 'fresh')
                self.assertEqual(s['previous_code_paths'], [])

    def test_missing_session_and_missing_mapping_have_explicit_fresh_reason(self):
        first = self.seed()
        path = Path(first['session']['session_path'])
        path.unlink()
        s = self.select(self.context(2))
        self.assertEqual(s['mode'], 'fresh')
        self.assertIn('missing', s['reason'])
        self.sessions.map_path.unlink()
        s = self.select(self.context(3))
        self.assertEqual(s['mode'], 'fresh')
        self.assertIn('mapping missing', s['reason'])

    def test_corrupt_header_or_tree_is_not_guessed_or_overwritten(self):
        first = self.seed()
        path = Path(first['session']['session_path'])
        original = load_json(self.sessions.map_path)
        header = json.loads(path.read_text())
        for body in (b'broken\n', json.dumps({**header, 'cwd': 'wrong'}).encode() + b'\n',
                     json.dumps(header).encode() + b'\n{"type":"message","id":"e","parentId":"absent"}\n',
                     json.dumps(header).encode() + b'\n{"type":"custom","id":"e"}\n{"type":"custom","id":"e"}\n',
                     json.dumps(header).encode(),
                     json.dumps(header).encode() + b'\n{"type":"custom","id":"a","id":"b"}\n'):
            with self.subTest(body=body):
                path.write_bytes(body)
                atomic_json(self.sessions.map_path, original)
                s = self.select(self.context(2))
                self.assertEqual(s['mode'], 'fresh')
                self.assertIn('fallback_fresh', s['reason'])
                self.assertNotEqual(s['session_path'], str(path))
                self.assertEqual(path.read_bytes(), body)

    def assert_corrupt_fresh(self, first, record, body):
        path = Path(first['session']['session_path'])
        owner = Path(first['session']['owner_path'])
        owner_before = owner.read_bytes()
        path.write_bytes(body)
        atomic_json(self.sessions.map_path, record)
        c = self.context(2)
        s = self.select(c)
        self.assertEqual(s['mode'], 'fresh')
        self.assertIn('fallback_fresh: corrupt session:', s['reason'])
        self.assertNotEqual(s['session_path'], str(path))
        mapping = load_json(self.sessions.map_path)
        self.assertEqual(mapping['reason'], s['reason'])
        self.assertEqual(mapping['attempt_id'], c['attempt_id'])
        self.assertEqual(self.store.events[-1][1]['reason'], s['reason'])
        # The new file is usable; neither selection nor the adapter edits the
        # damaged old file/header, even when the new checkout has a different cwd.
        with pi_session(c, Path(c['code_path'])) as flags:
            self.assertEqual(flags[1], s['session_path'])
            header, _ = session_contents(Path(s['session_path']), s['session_id'], c['code_path'])
            self.assertEqual(header['cwd'], c['code_path'])
        self.assertEqual(path.read_bytes(), body)
        self.assertEqual(owner.read_bytes(), owner_before)
        self.assertEqual((Path(first['code_path']) / 'x.py').read_text(), 'value=1\n')

    def test_valid_v3_payloads_and_optional_metadata_are_kept_byte_exact(self):
        first = self.seed()
        path = Path(first['session']['session_path'])
        header = path.read_bytes()
        messages = [SYSTEM, USER, {**USER, 'content': [{'type': 'image', 'data': 'AA==', 'mimeType': 'image/png'}]},
                    {**ASSISTANT, 'content': [{'type': 'thinking', 'thinking': 'reason', 'thinkingSignature': 'opaque'},
                     {'type': 'text', 'text': 'answer'}, {'type': 'toolCall', 'id': 'call-1', 'name': 'read', 'arguments': {'path': 'x.py'}}]}, TOOL]
        entries = [v3_entry('message', id=f'm{i}', message=m) for i, m in enumerate(messages)]
        entries += [v3_entry('model_change', provider='chosen-provider', modelId='chosen-model'),
                    v3_entry('thinking_level_change', thinkingLevel='max'),
                    v3_entry('usage', kind='future-operation', provider='chosen-provider', model='chosen-model', usage=USAGE),
                    v3_entry('compaction', summary='summary', firstKeptEntryId='m1', tokensBefore=42),
                    v3_entry('compaction', summary='keep none', firstKeptEntryId='e9', tokensBefore=42,
                             systemMessage=SYSTEM, usage=USAGE, fromHook=False, details={'extension': [None, 1]}),
                    v3_entry('branch_summary', fromId='m4', summary='branch', usage=USAGE, fromHook=True),
                    v3_entry('custom', customType='extension-state', data={'arbitrary': [None, False, 'a\u2028b']}),
                    v3_entry('custom', customType='extension-without-data'),
                    v3_entry('custom_message', customType='extension-context', content='injected', display=False),
                    v3_entry('context_edit', targetId='m1', replacement=None),
                    v3_entry('context_edit', targetId='m3', replacement={'content': [{'type': 'text', 'text': 'assistant'}]}),
                    v3_entry('context_edit', targetId='m4', replacement={'content': [{'type': 'text', 'text': 'tool'}]}),
                    v3_entry('context_edit', targetId='e13', replacement={'content': [{'type': 'text', 'text': 'patched'}]}),
                    v3_entry('label', targetId='m1', label='bookmark'),
                    v3_entry('label', targetId='m1'), v3_entry('session_info', name='display only')]
        for i, entry in enumerate(entries):
            if i >= len(messages): entry['id'] = f'e{i}'
            entry['parentId'] = entries[i - 1]['id'] if i else None
            entry['futureMetadata'] = {'kept': True}
        history = b''.join((json.dumps(e, ensure_ascii=False) + '\r\n').encode() for e in entries)
        path.write_bytes(header + history)
        c = self.context(2)
        self.assertEqual(self.select(c)['mode'], 'reuse_repairs')
        with pi_session(c, Path(c['code_path'])):
            rebound, raw = session_contents(path, c['session']['session_id'], c['code_path'])
            self.assertEqual(raw, history)
            self.assertEqual(rebound['id'], first['session']['session_id'])
        self.sessions.complete(c, True, 'accepted')
        self.assertTrue(load_json(self.sessions.map_path)['ready'])

    def test_pi087_samples_survive_acceptance_rebinding_and_next_repair(self):
        sample = load_json(ENGINE_DIR / 'tests/fixtures/pi-0.87.1.json')
        first = self.context()
        self.select(first)
        path = Path(first['session']['session_path'])
        history = b''.join((json.dumps(e) + '\n').encode() for e in sample['session_entries'])
        path.write_bytes(path.read_bytes() + history)
        for c in (first, self.context(2), self.context(3)):
            if c is not first:
                selected = self.select(c)
                self.assertEqual(selected['mode'], 'reuse_repairs')
                self.assertEqual(selected['session_path'], str(path))
            with pi_session(c, Path(c['code_path'])):
                header, raw = session_contents(path, first['session']['session_id'], c['code_path'])
                self.assertEqual(header['cwd'], c['code_path'])
                self.assertEqual(raw, history)
            self.sessions.complete(c, True, 'accepted')
            self.assertTrue(load_json(self.sessions.map_path)['ready'])

    def test_pi087_invalid_replacements_and_system_blocks_still_fall_back(self):
        first = self.seed()
        record = load_json(self.sessions.map_path)
        header = Path(first['session']['session_path']).read_bytes()
        prefix = (json.dumps(v3_entry('message', id='root', message=USER)) + '\n').encode()
        entries = [v3_entry('context_edit', targetId='root', replacement=value)
                   for value in ('bare string', [{'type': 'text', 'text': 'bare array'}],
                                 {}, {'content': None}, {'content': 1},
                                 {'content': [{'type': 'text'}]})]
        entries += [v3_entry('message', message={**SYSTEM, 'content': content})
                    for content in ([{'type': 'image', 'data': 'AA==', 'mimeType': 'image/png'}],
                                    [{'type': 'text', 'text': False}])]
        entries.append(v3_entry('session_info', name=None))
        for entry in entries:
            with self.subTest(entry=entry):
                self.assert_corrupt_fresh(first, record, header + prefix + (json.dumps(entry) + '\n').encode())

    def test_valid_json_but_corrupt_messages_fall_back_without_touching_old_bytes(self):
        first = self.seed()
        record = load_json(self.sessions.map_path)
        header = Path(first['session']['session_path']).read_bytes()
        # The first case is the independent review's exact message=null counterexample.
        entries = [v3_entry('message', message=None), v3_entry('message')]
        bad_messages = [[], 'not an object', {}, {**USER, 'role': None}, {**USER, 'role': 'unknown-extension'},
                        {**USER, 'timestamp': True}, {**USER, 'content': None}, {**USER, 'content': 1},
                        {**USER, 'content': [None]}, {**USER, 'content': [{'type': 'text'}]},
                        {**USER, 'content': [{'type': 'text', 'text': False}]},
                        {**USER, 'content': [{'type': 'image', 'data': 'AA=='}]},
                        {**USER, 'content': [{'type': 'image', 'data': None, 'mimeType': 'image/png'}]},
                        {**ASSISTANT, 'content': 'array required'},
                        {**ASSISTANT, 'content': [{'type': 'thinking', 'thinking': None}]},
                        {**ASSISTANT, 'content': [{'type': 'toolCall', 'id': 'call', 'name': 'read', 'arguments': []}]},
                        {**ASSISTANT, 'usage': None}, {**ASSISTANT, 'usage': {**USAGE, 'input': True}},
                        {**ASSISTANT, 'usage': {**USAGE, 'cost': {'total': 0}}},
                        {**TOOL, 'toolCallId': None}, {**TOOL, 'toolName': ''}, {**TOOL, 'isError': 'false'},
                        {**TOOL, 'content': 'array required'}, {**SYSTEM, 'sections': []},
                        {**SYSTEM, 'sections': {'cwd': False}}, {**SYSTEM, 'toolsAdded': [None]},
                        {**SYSTEM, 'toolsAdded': [{'name': 'read', 'description': 'Read', 'parameters': []}]},
                        {**SYSTEM, 'toolsRemoved': ['write']}]
        for valid, fields in ((USER, ('role', 'content', 'timestamp')),
                              (ASSISTANT, ('content', 'api', 'provider', 'model', 'usage', 'stopReason', 'timestamp')),
                              (TOOL, ('toolCallId', 'toolName', 'content', 'isError', 'timestamp')),
                              (SYSTEM, ('content', 'timestamp'))):
            bad_messages.extend({k: v for k, v in valid.items() if k != field} for field in fields)
        entries += [v3_entry('message', message=m) for m in bad_messages]
        for entry in entries:
            with self.subTest(entry=entry):
                body = header + (json.dumps(entry) + '\n').encode()
                self.assert_corrupt_fresh(first, record, body)

    def test_other_known_entry_payloads_and_references_are_not_guessed(self):
        first = self.seed()
        record = load_json(self.sessions.map_path)
        header = Path(first['session']['session_path']).read_bytes()
        prefix = (json.dumps(v3_entry('message', id='root', message=USER)) + '\n').encode()
        cases = [({'type': 'model_change', 'provider': 'chosen-provider', 'modelId': 'chosen-model'},
                  {'provider': None, 'modelId': []}),
                 ({'type': 'thinking_level_change', 'thinkingLevel': 'high'}, {'thinkingLevel': 'unsupported'}),
                 ({'type': 'usage', 'kind': 'future-kind', 'provider': 'p', 'model': 'm', 'usage': USAGE},
                  {'kind': None, 'provider': [], 'model': False, 'usage': {}}),
                 ({'type': 'compaction', 'summary': 'summary', 'firstKeptEntryId': 'root', 'tokensBefore': 10},
                  {'summary': [], 'firstKeptEntryId': 'absent', 'tokensBefore': -1}),
                 ({'type': 'context_edit', 'targetId': 'root', 'replacement': None},
                  {'targetId': 'absent', 'replacement': {}}),
                 ({'type': 'branch_summary', 'fromId': 'root', 'summary': 'branch'}, {'fromId': 'absent', 'summary': None}),
                 ({'type': 'custom', 'customType': 'extension-state'}, {'customType': None}),
                 ({'type': 'custom_message', 'customType': 'extension-context', 'content': 'context', 'display': True},
                  {'customType': [], 'content': [{'type': 'text'}], 'display': 1}),
                 ({'type': 'label', 'targetId': 'root'}, {'targetId': 'absent'}),
                 ({'type': 'session_info', 'name': 'display'}, {'name': False})]
        invalid = []
        for valid, wrong in cases:
            for field, value in wrong.items():
                if valid['type'] != 'session_info':  # Pi's name is optional; explicit non-strings are not.
                    invalid.append({k: v for k, v in valid.items() if k != field})
                invalid.append({**valid, field: value})
        invalid += [{'type': 'compaction', 'summary': 'summary', 'firstKeptEntryId': 'root', 'tokensBefore': 10,
                     'systemMessage': None},
                    {'type': 'compaction', 'summary': 'summary', 'firstKeptEntryId': 'root', 'tokensBefore': 10,
                     'systemMessage': USER},
                    {'type': 'branch_summary', 'fromId': 'root', 'summary': 'branch', 'usage': None},
                    {'type': 'branch_summary', 'fromId': 'root', 'summary': 'branch', 'fromHook': 'yes'},
                    {'type': 'label', 'targetId': 'root', 'label': None}, {'type': 'future-unknown-entry'}]
        for payload in invalid:
            with self.subTest(payload=payload):
                entry = v3_entry(payload['type'], parentId='root', **{k: v for k, v in payload.items() if k != 'type'})
                self.assert_corrupt_fresh(first, record, header + prefix + (json.dumps(entry) + '\n').encode())

    def test_adapter_rechecks_corrupt_payload_before_any_header_rebind(self):
        first = self.seed()
        c = self.context(2)
        self.assertEqual(self.select(c)['mode'], 'reuse_repairs')
        path = Path(c['session']['session_path'])
        body = path.read_bytes() + (json.dumps(v3_entry('message', message=None)) + '\n').encode()
        path.write_bytes(body)  # Damage between selection and the adapter's file lease.
        mapping_before = self.sessions.map_path.read_bytes()
        with self.assertRaisesRegex(LoopError, 'message must be an object'):
            with pi_session(c, Path(c['code_path'])):
                self.fail('damaged session must not yield CLI flags or start Pi')
        self.assertEqual(path.read_bytes(), body)
        self.assertEqual(json.loads(body.split(b'\n')[0])['cwd'], first['code_path'])
        self.assertEqual(self.sessions.map_path.read_bytes(), mapping_before)

    def test_corrupt_payload_after_delivery_cannot_become_reusable(self):
        c = self.context()
        self.select(c)
        path = Path(c['session']['session_path'])
        body = path.read_bytes() + (json.dumps(v3_entry('message', message=None)) + '\n').encode()
        path.write_bytes(body)
        self.sessions.complete(c, True, 'accepted protocol')
        mapping = load_json(self.sessions.map_path)
        self.assertFalse(mapping['ready'])
        self.assertIn('session_unusable_after_delivery: corrupt session:', mapping['reason'])
        s = self.select(self.context(2))
        self.assertEqual(s['mode'], 'fresh')
        self.assertNotEqual(s['session_path'], str(path))
        self.assertIn('previous session not accepted', s['reason'])
        self.assertEqual(path.read_bytes(), body)

    def test_bad_entry_base_and_nonfinite_json_never_select_the_old_file(self):
        first = self.seed()
        record = load_json(self.sessions.map_path)
        header = Path(first['session']['session_path']).read_bytes()
        valid = v3_entry('message', message=USER)
        entries = [{k: v for k, v in valid.items() if k != 'timestamp'},
                   {**valid, 'timestamp': None}, {**valid, 'timestamp': 'not ISO'},
                   {k: v for k, v in valid.items() if k != 'parentId'},
                   {**valid, 'parentId': []}]
        lines = [(json.dumps(entry) + '\n').encode() for entry in entries]
        lines.append(b'{"type":"custom","id":"bad","parentId":null,"timestamp":"2026-10-01T00:00:00Z",'
                     b'"customType":"state","data":1e999}\n')
        for line in lines:
            with self.subTest(line=line):
                self.assert_corrupt_fresh(first, record, header + line)

    def test_foreign_session_or_owner_is_never_modified(self):
        first = self.seed()
        original = load_json(self.sessions.map_path)
        user_session = self.work / 'user-session.jsonl'
        user_session.write_text('user owned existing conversation\n')
        forged = {**original, 'session_path': str(user_session)}
        atomic_json(self.sessions.map_path, forged)
        self.assertEqual(self.select(self.context(2))['mode'], 'fresh')
        self.assertEqual(user_session.read_text(), 'user owned existing conversation\n')
        atomic_json(self.sessions.map_path, original)
        owner = Path(original['owner_path'])
        bad_owner = {**load_json(owner), 'binding': {'run_id': 'someone-else'}}
        atomic_json(owner, bad_owner)
        s = self.select(self.context(2))
        self.assertEqual(s['mode'], 'fresh')
        self.assertIn('owner binding mismatch', s['reason'])
        self.assertEqual(load_json(owner), bad_owner)

    def test_failed_execution_and_same_round_infra_retry_are_fresh(self):
        first = self.seed()
        self.sessions.complete(first, False, 'execution_failed: nonzero_exit')
        c = self.context(1)
        s = self.select(c)
        self.assertEqual(s['mode'], 'fresh')
        self.assertNotEqual(s['session_path'], first['session']['session_path'])
        self.assertIn('execution_failed', s['reason'])
        self.sessions.complete(c, True, 'accepted')
        s = self.select(self.context(1))
        self.assertEqual(s['mode'], 'fresh')
        self.assertIn('not a consecutive business repair', s['reason'])

    def test_protocol_repair_is_new_and_cannot_seed_next_business_reuse(self):
        first = self.seed()
        c = self.context(1, protocol=True)
        s = self.select(c)
        self.assertEqual(s['mode'], 'fresh')
        self.assertEqual(s['reason'], 'protocol_repair_always_fresh')
        self.assertNotEqual(s['session_path'], first['session']['session_path'])
        self.sessions.complete(c, True, 'format_only_not_reusable')
        s = self.select(self.context(2))
        self.assertEqual(s['mode'], 'fresh')
        self.assertIn('format_only_not_reusable', s['reason'])

    def test_corrupt_ready_after_protocol_repair_cannot_reuse_or_rebind_old_session(self):
        self.seed()
        repair = self.context(1, protocol=True)
        self.select(repair)
        path = Path(repair['session']['session_path'])
        with pi_session(repair, Path(repair['code_path'])):
            history = (json.dumps(v3_entry('message', id='format-entry', message=USER)) + '\n').encode()
            path.write_bytes(path.read_bytes() + history)
        self.sessions.complete(repair, True, 'format_only_not_reusable')
        original = load_json(self.sessions.map_path)
        self.assertIs(original['ready'], False)
        before = path.read_bytes()
        owner = Path(repair['session']['owner_path'])
        owner_before = owner.read_bytes()
        # Start from an accepted format-only delivery, which must never seed
        # business reuse. Truthy strings/numbers are not boolean eligibility.
        for fields in [{}, *[{'ready': value} for value in ('false', 1, 'true', 0, 1.0, None, [], {})]]:
            with self.subTest(fields=fields):
                damaged = {k: v for k, v in original.items() if k != 'ready'} | fields
                atomic_json(self.sessions.map_path, damaged)
                c = self.context(2)
                s = self.select(c)
                self.assertEqual(s['mode'], 'fresh')
                self.assertEqual(s['reason'], 'fallback_fresh: corrupt session mapping: ready must be a boolean')
                self.assertNotEqual(s['session_path'], str(path))
                self.assertNotEqual(s['session_id'], repair['session']['session_id'])
                mapping = load_json(self.sessions.map_path)
                self.assertIs(mapping['ready'], False)
                self.assertEqual(mapping['reason'], s['reason'])
                self.assertEqual(mapping['attempt_id'], c['attempt_id'])
                self.assertEqual(self.store.events[-1][1]['reason'], s['reason'])
                with pi_session(c, Path(c['code_path'])) as flags:
                    self.assertEqual(flags[1], s['session_path'])
                    header, _ = session_contents(Path(s['session_path']), s['session_id'], c['code_path'])
                    self.assertEqual(header['cwd'], c['code_path'])
                # Selection and the adapter both leave the rejected conversation
                # and its owner/history/cwd intact, rather than masking damage.
                self.assertEqual(path.read_bytes(), before)
                self.assertEqual(owner.read_bytes(), owner_before)
                header, raw = session_contents(path, repair['session']['session_id'], repair['code_path'])
                self.assertEqual(header['cwd'], repair['code_path'])
                self.assertEqual(raw, history)
                self.assertEqual((Path(repair['code_path']) / 'x.py').read_text(), 'value=1\n')

    def test_reviewer_never_receives_the_developer_session(self):
        first = self.seed()
        for round in (1, 2):
            c = self.context(round, role='reviewer')
            review = DeveloperSessions(self.store, self.unit, 'reviewer')
            c['session'] = review.select(c, self.agent)
            self.assertEqual(c['session']['mode'], 'fresh')
            self.assertIsNone(c['session']['session_path'])
            with pi_session(c, Path(c['code_path'])) as flags:
                self.assertEqual(flags, ['--no-session'])
        self.assertEqual(load_json(self.sessions.map_path)['session_path'], first['session']['session_path'])

    def test_mapping_lock_contention_refuses_selection(self):
        other = DeveloperSessions(self.store, self.unit, 'developer')
        with self.assertRaises(SessionBusy):
            other.__enter__()
        self.assertFalse(self.sessions.map_path.exists())

    def test_session_lock_contention_does_not_reallocate_or_overwrite_mapping(self):
        c = self.seed()
        before = self.sessions.map_path.read_bytes()
        with SessionLock(Path(c['session']['session_path']).with_suffix('.lock')):
            with self.assertRaises(SessionBusy): self.select(self.context(2))
        self.assertEqual(self.sessions.map_path.read_bytes(), before)

    def test_adapter_checks_context_and_mapping_before_rebinding(self):
        self.seed()
        c = self.context(2)
        self.select(c)
        path = Path(c['session']['session_path'])
        before = path.read_bytes()
        for key in ('attempt_id', 'rule_hash', 'unit_input_hash', 'role'):
            bad = {**c, key: 'wrong'}
            with self.subTest(key=key), self.assertRaises(LoopError):
                with pi_session(bad, Path(c['code_path'])): pass
            self.assertEqual(path.read_bytes(), before)
        mapping = load_json(self.sessions.map_path)
        atomic_json(self.sessions.map_path, {**mapping, 'attempt_id': 'expired'})
        with self.assertRaises(LoopError):
            with pi_session(c, Path(c['code_path'])): pass
        self.assertEqual(path.read_bytes(), before)

    def test_session_symlink_and_hardlink_cannot_be_reopened(self):
        c = self.seed()
        path = Path(c['session']['session_path'])
        record = load_json(self.sessions.map_path)
        actual = self.work / 'external'
        path.rename(actual)
        path.symlink_to(actual)
        self.assertEqual(self.select(self.context(2))['mode'], 'fresh')
        path.unlink()
        os.link(actual, path)
        atomic_json(self.sessions.map_path, record)
        self.assertEqual(self.select(self.context(2))['mode'], 'fresh')
        self.assertEqual(actual.read_bytes(), path.read_bytes())

    def test_old_receipt_is_rejected_even_in_same_conversation(self):
        first = self.seed()
        c = self.context(2)
        self.select(c)
        report = {'attempt_id': first['attempt_id'], 'role': 'developer', 'candidate_hash': '',
                  'summary': 'old report', 'blocked': False, 'issues': [], 'rule_gaps': [],
                  'criteria': [{'id': 'S', 'status': 'PASS', 'note': 'old', 'evidence': ['code:x.py']}]}
        with self.assertRaisesRegex(LoopError, '过期'):
            validate_report(report, c, Path(c['code_path']), {})

    def test_unavailable_platform_or_failed_probe_refuses_enabling_reuse(self):
        c = self.context()
        self.select(c)
        argv = ['not-invoked']
        with patch('loop_engineering.session_sandbox.sys.platform', 'linux'), \
             patch('loop_engineering.session_sandbox.subprocess.run', side_effect=AssertionError('must not launch')):
            with self.assertRaisesRegex(LoopError, 'unavailable'):
                protect(argv, c, Path(c['code_path']), Path(c['workspace_path']), 5)
        # Test the failed-probe branch independently of the host OS. No real sandbox run.
        with patch('loop_engineering.session_sandbox.sys.platform', 'darwin'), \
             patch('loop_engineering.session_sandbox.SANDBOX') as sandbox, \
             patch('loop_engineering.session_sandbox.os.access', return_value=True), \
             patch('loop_engineering.session_sandbox.subprocess.run') as run:
            sandbox.is_file.return_value = True
            run.return_value.returncode = 1
            run.return_value.stderr = b'sandbox denied by host'
            with self.assertRaisesRegex(LoopError, 'probe failed'):
                protect(argv, c, Path(c['code_path']), Path(c['workspace_path']), 5)
        self.assertEqual(load_json(Path(c['workspace_path']) / 'session-protection.json')['status'], 'FAIL')


class SessionPolicy(unittest.TestCase):
    def test_supported_adapter_identity_is_not_a_model_or_script_name_heuristic(self):
        good = {'kind': 'command', 'output': 'stdout', 'argv': ['{python}', str(PI_MEMBER)]}
        self.assertTrue(supports_reuse(good))
        for argv in (['bash', str(PI_MEMBER)], ['{python}', '/elsewhere/pi_member.py'],
                     ['bash', '-c', str(PI_MEMBER)], ['pi', '--continue']):
            self.assertFalse(supports_reuse({**good, 'argv': argv}))
        self.assertFalse(supports_reuse({**good, 'output': 'file'}))

    def test_unsupported_adapter_policy_rejected_at_rule_validation(self):
        raw = load_json(ENGINE_DIR / 'examples/demo.json')
        raw['units'][0]['developer_session'] = 'reuse_repairs'
        for agent in ({'kind': 'pi', 'identity': 'developer'}, {'kind': 'codex', 'identity': 'developer'},
                      {'kind': 'command', 'identity': 'developer', 'argv': ['some-wrapper'], 'output': 'stdout'}):
            with self.subTest(agent=agent):
                raw['agents']['dev'] = agent
                with self.assertRaisesRegex(LoopError, 'reuse_repairs'):
                    normalize(raw, ENGINE_DIR)

    def test_invalid_policy_and_session_override_flags_are_rejected(self):
        raw = load_json(ENGINE_DIR / 'examples/demo.json')
        for value in (True, 1, None, '', 'continue', []):
            raw['units'][0]['developer_session'] = value
            with self.subTest(policy=value), self.assertRaises(LoopError): normalize(raw, ENGINE_DIR)
        raw['units'][0]['developer_session'] = 'fresh'
        for flag in ('--session-dir', '--no-session', '--continue', '--session-id'):
            raw['agents']['dev'] = {'kind': 'pi', 'identity': 'developer', 'extra_args': [flag]}
            with self.subTest(flag=flag), self.assertRaises(LoopError): normalize(raw, ENGINE_DIR)
