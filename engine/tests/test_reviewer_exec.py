"""U4 回归：评审命令取证、引用协议和封存；仅运行本地离线成员桩。"""
import copy
import json
import os
from pathlib import Path
import shutil
import stat
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from loop_engineering.adapters import ENGINE_DIR, command, member_prompt
from loop_engineering.audit import audit
from loop_engineering.common import LoopError, file_hash, load_json
from loop_engineering.engine import Controller
from loop_engineering.protocol import validate_report
from loop_engineering.rules import normalize
from loop_engineering.storage import create_run


GOOD = "def can_resend(status: str, expired: bool) -> bool:\n    return status == 'pending' and expired is True\n"
MEMBER = r'''
import json, os, subprocess, sys
from pathlib import Path
c = json.loads(Path(os.environ['LOOP_CONTEXT']).read_text(encoding='utf-8'))
code, role, mode = Path(c['code_path']), c['role'], sys.argv[1]
scratch = c['scratch_path']
enabled = role == 'reviewer' and c['unit']['reviewer_exec']
ref = 'code:invites.py'
status = 'PASS'
if not enabled:
    assert scratch is None
    assert 'LOOP_SCRATCH' not in os.environ
else:
    scratch = Path(scratch)
    assert scratch.is_dir() and os.access(scratch, os.W_OK)
    assert os.environ['LOOP_SCRATCH'] == str(scratch)
    assert not scratch.resolve().is_relative_to(code.resolve())
if role == 'developer':
    if not c['protocol_repair_only']:
        (code / 'invites.py').write_text("def can_resend(status: str, expired: bool) -> bool:\n    return status == 'pending' and expired is True\n", encoding='utf-8')
    if mode == 'developer-cites':
        ref = 'scratch:note.txt'
elif enabled:
    if not c['protocol_repair_only']:
        (scratch / 'scripts').mkdir()
        script = scratch / 'scripts/read_candidate.py'
        script.write_text('import sys\nfrom pathlib import Path\nprint(Path(sys.argv[1]).read_text(), end="")\n', encoding='utf-8')
        (scratch / '取证').mkdir()
        # Actually execute a read-only command. Both script and output stay in scratch.
        with (scratch / '取证/result.txt').open('w', encoding='utf-8') as output:
            subprocess.run([sys.executable, str(script), str(code / 'invites.py')], stdout=output, check=True)
        (scratch / 'unused.txt').write_text('not cited\n', encoding='utf-8')
        (scratch / 'first.txt').write_text('collected before repair\n', encoding='utf-8')
    else:
        assert (scratch / 'first.txt').read_text() == 'collected before repair\n'
        assert (scratch / 'unused.txt').read_text() == 'not cited\n'
        assert (scratch / 'scripts/read_candidate.py').is_file()
    ref = 'scratch:取证/result.txt'
    if mode == 'bad-once':
        ref = 'scratch:first.txt' if c['protocol_repair_only'] else '/invalid-evidence.txt'
    if mode == 'loop-once':
        if not c['protocol_repair_only']:
            (scratch / 'loop').symlink_to('loop', target_is_directory=True)
            ref = 'scratch:loop/result.txt'
        else:
            assert (scratch / 'loop').is_symlink()
            assert os.readlink(scratch / 'loop') == 'loop'
            assert '取证引用不接受符号链接' in c['protocol_error']
    if mode == 'big':
        (scratch / 'unreferenced-big.txt').write_bytes(b'x' * 5000)
    if mode == 'fail-first-round':
        # A new business review must not inherit the previous candidate's scratch.
        assert not (scratch / ('round-%d.txt' % (c['round'] - 1))).exists()
        name = 'round-%d.txt' % c['round']
        (scratch / name).write_text(str(c['round']))
        ref = 'scratch:' + name
        status = 'FAIL' if c['round'] == 1 else 'PASS'
if role == 'reviewer' and mode == 'disabled-cites':
    ref = 'scratch:missing.txt'
if role == 'reviewer' and mode == 'mutate':
    os.chmod(code, 0o700)
    os.chmod(code / 'invites.py', 0o600)
    (code / 'invites.py').write_text('tampered = True\n')
rows = [{'id': cr['id'], 'status': status if cr['id'] == 'S2' else 'PASS',
         'note': 'offline command evidence',
         'evidence': ['gate:' + g for g in cr['gate_ids']] if role == 'reviewer' and cr['gate_ids'] else [ref]}
        for cr in c['unit']['criteria']]
r = {'attempt_id': c['attempt_id'], 'role': role, 'candidate_hash': c['candidate_hash'],
     'summary': 'offline evidence delivery', 'blocked': False, 'criteria': rows, 'issues': [], 'rule_gaps': []}
Path(c['response_path']).write_text(json.dumps(r, ensure_ascii=False), encoding='utf-8')
'''


class ReviewerExecContractTests(unittest.TestCase):
    def test_rule_default_and_strict_boolean(self):
        raw = load_json(ENGINE_DIR / 'examples/demo.json')
        original = copy.deepcopy(raw)
        self.assertIs(normalize(raw, ENGINE_DIR / 'examples')['units'][0]['reviewer_exec'], False)
        self.assertEqual(raw, original)
        for value in (True, False):
            raw['units'][0]['reviewer_exec'] = value
            self.assertIs(normalize(raw, ENGINE_DIR / 'examples')['units'][0]['reviewer_exec'], value)
        for value in (None, 0, 1, 1.0, 'true', 'false', 'yes', [], {}):
            with self.subTest(value=value):
                raw['units'][0]['reviewer_exec'] = value
                with self.assertRaisesRegex(LoopError, 'reviewer_exec'):
                    normalize(raw, ENGINE_DIR / 'examples')

    def test_pi_only_adds_bash_and_write_to_enabled_reviewer(self):
        agent = {'kind': 'pi', 'extra_args': []}
        for enabled, expected in ((False, 'read,grep,find,ls'), (True, 'read,bash,write,grep,find,ls')):
            args, output = command(agent, 'reviewer', {}, reviewer_exec=enabled)
            self.assertEqual(args[args.index('--tools') + 1], expected)
            self.assertEqual(output, 'stdout')
            self.assertNotIn('edit', expected.split(','))
        off = command(agent, 'developer', {}, reviewer_exec=False)
        self.assertEqual(command(agent, 'developer', {}, reviewer_exec=True), off)
        self.assertEqual(off[0][off[0].index('--tools') + 1], 'read,bash,edit,write,grep,find,ls')

    def test_codex_and_command_arguments_do_not_change(self):
        values = {'python': '/python', 'code': '/candidate', 'schema': '/schema', 'response': '/response'}
        agents = [{'kind': 'codex', 'extra_args': []},
                  {'kind': 'command', 'argv': ['{python}', 'wrapper.py', '--tools', 'read'], 'output': 'file'}]
        for agent in agents:
            with self.subTest(kind=agent['kind']):
                off = command(agent, 'reviewer', values, reviewer_exec=False)
                self.assertEqual(command(agent, 'reviewer', values, reviewer_exec=True), off)
        self.assertIn('read-only', command(agents[0], 'reviewer', values, reviewer_exec=True)[0])
        self.assertEqual(agents[1]['argv'], ['{python}', 'wrapper.py', '--tools', 'read'])

    def test_prompt_has_four_explicit_permissions_and_boundaries_only_when_enabled(self):
        context = {'role': 'reviewer', 'unit': {'reviewer_exec': True}, 'scratch_path': '/evidence/own'}
        prompt = member_prompt(context)
        self.assertIn('评审方可以执行只读的取证命令', prompt)
        self.assertIn('取证目录：/evidence/own。脚本和输出只能写在这个取证目录里', prompt)
        self.assertIn('不得修改候选副本、门禁证据、规则、交接记录和原始项目', prompt)
        self.assertIn('scratch:<相对路径>；只有开启取证的评审方可以这样引用', prompt)
        context['unit']['reviewer_exec'] = False
        context['scratch_path'] = None
        self.assertNotIn('scratch:', member_prompt(context))
        context.update(role='developer', unit={'reviewer_exec': True})
        self.assertNotIn('scratch:', member_prompt(context))


class ScratchProtocolTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='loop-scratch-protocol-')
        self.path = Path(self.temp.name)
        self.code, self.scratch = self.path / 'code', self.path / 'scratch'
        self.code.mkdir()
        self.scratch.mkdir()
        (self.code / 'x.py').write_text('x = 1\n')
        self.context = {'attempt_id': 'current', 'role': 'reviewer', 'candidate_hash': 'hash',
                        'unit': {'reviewer_exec': True, 'criteria': [{'id': 'S1'}]},
                        'scratch_path': str(self.scratch), 'limits': {'max_log_bytes': 64}}
        self.report = {'attempt_id': 'current', 'role': 'reviewer', 'candidate_hash': 'hash',
                       'summary': 'scratch evidence validation', 'blocked': False, 'issues': [], 'rule_gaps': [],
                       'criteria': [{'id': 'S1', 'status': 'PASS', 'note': 'offline', 'evidence': ['code:x.py']}]}

    def tearDown(self):
        self.temp.cleanup()

    def validate(self, ref):
        self.report['criteria'][0]['evidence'] = [ref]
        return validate_report(self.report, self.context, self.code, {})

    def test_enabled_reviewer_can_cite_nested_unicode_regular_file(self):
        (self.scratch / '取证').mkdir()
        (self.scratch / '取证/note.txt').write_text('evidence\n')
        self.assertEqual(self.validate('scratch:取证/note.txt'), self.report)

    def test_disabled_reviewer_and_developer_cannot_cite_existing_scratch_file(self):
        (self.scratch / 'note.txt').write_text('evidence\n')
        self.context['unit']['reviewer_exec'] = False
        with self.assertRaises(LoopError):
            self.validate('scratch:note.txt')
        self.context['unit']['reviewer_exec'] = True
        self.context['role'] = self.report['role'] = 'developer'
        self.context['candidate_hash'] = self.report['candidate_hash'] = ''
        with self.assertRaises(LoopError):
            self.validate('scratch:note.txt')

    def test_missing_escape_absolute_directory_and_special_file_are_rejected(self):
        (self.scratch / 'dir').mkdir()
        os.mkfifo(self.scratch / 'pipe')
        for relative in ('missing.txt', '', '../code/x.py', '/absolute.txt', 'dir', 'dir/', 'pipe', 'dir/../x.py', 'a\\b'):
            with self.subTest(relative=relative):
                with self.assertRaises(LoopError):
                    self.validate('scratch:' + relative)

    def test_links_including_internal_parent_directory_are_rejected(self):
        (self.scratch / 'real').mkdir()
        (self.scratch / 'real/note.txt').write_text('inside\n')
        (self.scratch / 'file-link').symlink_to(self.scratch / 'real/note.txt')
        (self.scratch / 'dir-link').symlink_to(self.scratch / 'real', target_is_directory=True)
        (self.scratch / 'escape').symlink_to(self.code, target_is_directory=True)
        for relative in ('file-link', 'dir-link/note.txt', 'escape/x.py'):
            with self.subTest(relative=relative):
                with self.assertRaises(LoopError):
                    self.validate('scratch:' + relative)

    def test_looping_links_at_leaf_or_in_parent_are_protocol_errors(self):
        (self.scratch / 'loop').symlink_to('loop', target_is_directory=True)
        (self.scratch / 'left').symlink_to('right', target_is_directory=True)
        (self.scratch / 'right').symlink_to('left', target_is_directory=True)
        for relative in ('loop', 'loop/result.txt', 'left/result.txt', 'right/result.txt'):
            with self.subTest(relative=relative):
                with self.assertRaisesRegex(LoopError, '符号链接'):
                    self.validate('scratch:' + relative)

    def test_missing_or_symlink_scratch_root_is_protocol_error(self):
        self.context['scratch_path'] = None
        with self.assertRaises(LoopError):
            self.validate('code:x.py')
        link = self.path / 'root-link'
        link.symlink_to(self.scratch, target_is_directory=True)
        self.context['scratch_path'] = str(link)
        with self.assertRaises(LoopError):
            self.validate('code:x.py')

    def test_total_counts_unreferenced_and_cache_files_and_allows_exact_limit(self):
        self.context['limits']['max_log_bytes'] = 10
        (self.scratch / 'note.txt').write_bytes(b'1234')
        (self.scratch / '__pycache__').mkdir()
        (self.scratch / '__pycache__/unused.pyc').write_bytes(b'123456')
        self.validate('scratch:note.txt')
        (self.scratch / '.env').write_bytes(b'!')
        # Even a code-only delivery cannot bypass the directory size check.
        with self.assertRaisesRegex(LoopError, 'max_log_bytes'):
            self.validate('code:x.py')

    def test_unreferenced_symlink_is_not_followed_or_deleted(self):
        outside = self.path / 'outside.txt'
        outside.write_bytes(b'x' * 128)
        link = self.scratch / 'unreferenced-link'
        link.symlink_to(outside)
        self.validate('code:x.py')
        self.assertTrue(link.is_symlink())

    def test_invalid_reference_is_rejected_for_fail_and_unknown_too(self):
        for status in ('FAIL', 'UNKNOWN'):
            self.report['criteria'][0]['status'] = status
            with self.assertRaises(LoopError):
                self.validate('scratch:missing.txt')


class ReviewerExecTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='loop-reviewer-exec-')
        self.path = Path(self.temp.name).resolve()
        self.root, self.source = self.path / 'data', self.path / 'source'
        shutil.copytree(ENGINE_DIR / 'examples/demo_project', self.source)
        self.stub = self.path / 'member.py'
        self.stub.write_text(MEMBER, encoding='utf-8')
        self.raw = load_json(ENGINE_DIR / 'examples/demo.json')
        self.raw['source'] = str(self.source)
        self.raw['limits']['max_wall_seconds'] = 60
        self.raw['units'][0].update(max_repairs=0, max_protocol_retries=0, max_seconds=55)
        for agent in self.raw['agents'].values():
            agent.update(argv=['{python}', str(self.stub), 'good'], inherit_env=['LOOP_SCRATCH'])

    def tearDown(self):
        self.temp.cleanup()

    def execute(self, enabled=True, reviewer='good', developer='good', protocol_retries=0, repairs=0):
        self.raw['units'][0].update(reviewer_exec=enabled, max_protocol_retries=protocol_retries, max_repairs=repairs)
        self.raw['agents']['dev']['argv'][-1] = developer
        self.raw['agents']['review']['argv'][-1] = reviewer
        self.rid = create_run(self.root, normalize(self.raw, self.path))
        self.run = self.root / 'runs' / self.rid
        # Explicit inheritance cannot leak a caller's scratch into disabled roles.
        with patch.dict(os.environ, {'LOOP_SCRATCH': '/not-this-attempt'}):
            Controller(self.root, self.rid).execute()
        self.data = load_json(self.run / 'manifest.json')
        self.unit = self.data['units']['invite']
        self.result = self.unit['result']
        self.assertEqual(load_json(self.run / 'units/invite/result.json'), self.result)
        return self.data['result']['stop']

    def contexts(self, role):
        return [load_json(p) for p in self.run.glob('units/invite/attempts/' + role + '-*/context.json')]

    def test_enabled_command_evidence_is_indexed_sealed_and_audited_without_deleting_other_files(self):
        self.assertEqual(self.execute(), 'PASSED')
        developer, = self.contexts('developer')
        reviewer, = self.contexts('reviewer')
        self.assertIsNone(developer['scratch_path'])
        scratch = Path(reviewer['scratch_path'])
        self.assertFalse(scratch.is_relative_to(Path(reviewer['code_path'])))
        entry = self.result['evidence']['scratch:取证/result.txt']
        referenced = scratch / '取证/result.txt'
        self.assertEqual(referenced.read_text(), GOOD)
        self.assertEqual(entry, {'path': str(referenced), 'sha256': file_hash(referenced),
                                 'candidate_hash': self.result['candidate']['hash']})
        self.assertEqual(self.data['integrity'][referenced.relative_to(self.run).as_posix()], file_hash(referenced))
        self.assertEqual(stat.S_IMODE(referenced.stat().st_mode) & 0o222, 0)
        accepted = load_json(Path(reviewer['workspace_path']) / 'accepted.json')
        self.assertEqual(accepted['scratch_evidence']['scratch:取证/result.txt'], entry)
        unused = scratch / 'unused.txt'
        self.assertEqual(unused.read_text(), 'not cited\n')
        self.assertTrue(unused.stat().st_mode & stat.S_IWUSR)
        self.assertTrue((scratch / 'scripts/read_candidate.py').is_file())
        self.assertNotIn(unused.relative_to(self.run).as_posix(), self.data['integrity'])
        self.assertTrue(audit(self.root, self.rid)['integrity_ok'])
        unused.write_text('unreferenced file remains mutable\n')
        self.assertTrue(audit(self.root, self.rid)['integrity_ok'])
        referenced.chmod(0o600)
        referenced.write_text('changed after acceptance\n')
        self.assertFalse(audit(self.root, self.rid)['integrity_ok'])

    def test_disabled_reference_is_protocol_error_but_plain_delivery_still_passes(self):
        self.assertEqual(self.execute(enabled=False, reviewer='disabled-cites'), 'BLOCKED')
        self.assertIn('交付协议修复已耗尽', self.result['reason'])
        reviewer, = self.contexts('reviewer')
        self.assertIsNone(reviewer['scratch_path'])
        prompt = (Path(reviewer['workspace_path']) / 'job/stdin.txt').read_text()
        self.assertNotIn('scratch:', prompt)
        self.assertEqual(self.execute(enabled=False), 'PASSED')

    def test_developer_reference_is_protocol_error_and_reviewer_is_not_started(self):
        self.assertEqual(self.execute(developer='developer-cites'), 'BLOCKED')
        self.assertIn('交付协议修复已耗尽', self.result['reason'])
        self.assertEqual(self.unit['stats']['member_invocations'], 1)
        self.assertFalse(self.contexts('reviewer'))

    def test_candidate_mutation_is_detected_with_either_switch_value(self):
        for enabled in (True, False):
            with self.subTest(enabled=enabled):
                self.assertEqual(self.execute(enabled=enabled, reviewer='mutate'), 'BLOCKED')
                self.assertIn('修改了代码', self.result['reason'])
                self.assertFalse(self.result['reviewed'])

    def test_protocol_retry_copies_all_collected_contents_to_new_writable_directory(self):
        self.assertEqual(self.execute(reviewer='bad-once', protocol_retries=1), 'PASSED')
        contexts = sorted(self.contexts('reviewer'), key=lambda c: c['protocol_repair_only'])
        self.assertEqual([c['protocol_repair_only'] for c in contexts], [False, True])
        first, second = [Path(c['scratch_path']) for c in contexts]
        self.assertNotEqual(first, second)
        for scratch in (first, second):
            self.assertTrue(scratch.stat().st_mode & stat.S_IWUSR)
            self.assertEqual((scratch / 'first.txt').read_text(), 'collected before repair\n')
            self.assertEqual((scratch / 'unused.txt').read_text(), 'not cited\n')
            self.assertEqual((scratch / '取证/result.txt').read_text(), GOOD)
            self.assertTrue((scratch / 'scripts/read_candidate.py').is_file())
        self.assertEqual(self.result['evidence']['scratch:first.txt']['path'], str(second / 'first.txt'))
        self.assertTrue((first / 'first.txt').stat().st_mode & stat.S_IWUSR)
        self.assertFalse((second / 'first.txt').stat().st_mode & 0o222)
        self.assertEqual(self.unit['stats']['protocol_retries_by_role'], {'developer': 0, 'reviewer': 1})
        self.assertTrue(audit(self.root, self.rid)['integrity_ok'])

    def test_looping_intermediate_link_uses_protocol_retry_and_accepts_legal_redelivery(self):
        self.assertEqual(self.execute(reviewer='loop-once', protocol_retries=1), 'PASSED')
        contexts = sorted(self.contexts('reviewer'), key=lambda c: c['protocol_repair_only'])
        self.assertEqual([c['protocol_repair_only'] for c in contexts], [False, True])
        first, second = [Path(c['scratch_path']) for c in contexts]
        self.assertNotEqual(first, second)
        for scratch in (first, second):
            self.assertTrue((scratch / 'loop').is_symlink())
            self.assertEqual(os.readlink(scratch / 'loop'), 'loop')
            self.assertEqual((scratch / 'first.txt').read_text(), 'collected before repair\n')
            self.assertEqual((scratch / '取证/result.txt').read_text(), GOOD)
        error = (Path(contexts[0]['workspace_path']) / 'protocol-error.txt').read_text()
        self.assertIn('取证引用不接受符号链接：loop/result.txt', error)
        self.assertEqual(contexts[1]['protocol_error'], error.strip())
        self.assertIn('scratch:loop/result.txt', contexts[1]['invalid_response_excerpt'])
        events = [json.loads(line) for line in (self.run / 'events.jsonl').read_text().splitlines()]
        retries = [e for e in events if e['event'] == 'protocol_retry' and e['role'] == 'reviewer']
        self.assertEqual(len(retries), 1)
        self.assertEqual(retries[0]['attempt'], contexts[0]['attempt_id'])
        self.assertEqual(self.unit['stats']['member_invocations'], 3)
        self.assertEqual(self.unit['stats']['protocol_retries_by_role'], {'developer': 0, 'reviewer': 1})
        self.assertEqual(self.unit['stats']['repairs'], 0)
        self.assertEqual(self.unit['stats']['infra_retries'], 0)
        self.assertEqual(self.result['evidence']['scratch:取证/result.txt']['path'], str(second / '取证/result.txt'))
        self.assertFalse((second / '取证/result.txt').stat().st_mode & 0o222)
        self.assertFalse((self.run / 'units/invite/engine-error.txt').exists())
        self.assertTrue(audit(self.root, self.rid)['integrity_ok'])

    def test_unreferenced_oversize_file_is_a_delivery_format_error(self):
        self.raw['limits']['max_log_bytes'] = 4096
        self.assertEqual(self.execute(reviewer='big'), 'BLOCKED')
        self.assertIn('交付协议修复已耗尽', self.result['reason'])
        self.assertIn('max_log_bytes', self.result['reason'])

    def test_business_review_gets_fresh_scratch_and_old_accepted_evidence_remains_audited(self):
        self.assertEqual(self.execute(reviewer='fail-first-round', repairs=1), 'PASSED')
        first, second = sorted(self.contexts('reviewer'), key=lambda c: c['round'])
        self.assertNotEqual(first['scratch_path'], second['scratch_path'])
        self.assertNotIn('scratch:round-1.txt', self.result['evidence'])
        self.assertIn('scratch:round-2.txt', self.result['evidence'])
        old_file = Path(first['scratch_path']) / 'round-1.txt'
        self.assertEqual(old_file.stat().st_mode & 0o222, 0)
        self.assertTrue(audit(self.root, self.rid)['integrity_ok'])
        old_file.chmod(0o600)
        old_file.write_text('changed historical accepted evidence')
        self.assertFalse(audit(self.root, self.rid)['integrity_ok'])


if __name__ == '__main__':
    unittest.main()
