"""Explicit, engine-owned Pi sessions; never discover a user's recent session.

The mapping lease covers selection through protocol acceptance. The adapter takes
an additional file lease while rebinding the header and running Pi. Neither lock
is deleted. Mutable conversation files are not candidate/evidence snapshots.
"""
from __future__ import annotations

import contextlib
from datetime import datetime
import json
import math
import os
from pathlib import Path
import stat
import uuid

from .common import LoopError, atomic_json, atomic_write, digest, environment, load_json, now

PI_MEMBER = Path(__file__).resolve().parents[2] / 'adapters' / 'pi_member.py'
SESSION_BYTES = 32 * 1024 * 1024


def supports_reuse(agent: dict) -> bool:
    """Only the shipped foreground adapter has the ownership/OS guard contract."""
    if agent['kind'] != 'command' or agent.get('output') != 'stdout':
        return False
    args = agent.get('argv', [])
    # Direct script or Python + exact script, not a shell/wrapper with opaque args.
    index = 0 if len(args) and Path(args[0]).name == PI_MEMBER.name else 1
    if len(args) <= index:
        return False
    path = args[index].replace('{engine}', str(PI_MEMBER.parent.parent / 'engine'))
    if not Path(path).is_absolute() or Path(path).resolve() != PI_MEMBER:
        return False
    if index == 1:
        executable = args[0]
        if executable != '{python}' and not Path(executable).name.startswith('python'):
            return False
    return True


def owned_path(path: Path, root: Path) -> Path:
    """Reject links in every component, not just the leaf; require our namespace."""
    if not path.is_absolute() or not path.is_relative_to(root):
        raise LoopError('session path outside engine-owned namespace')
    for part in (path, *path.parents):
        if part.is_symlink():
            raise LoopError('symlink in session ownership path: ' + str(part))
        if part.is_relative_to(root) and part.exists() and part.stat().st_uid != os.getuid():
            raise LoopError('session path belongs to another user')
    return path


class SessionBusy(LoopError):
    """A live file lease is never treated as a corrupt/missing session."""


class SessionLock:
    def __init__(self, path: Path):
        self.path, self.fd = path, None

    def __enter__(self):
        if os.name != 'posix':
            raise LoopError('session locking requires POSIX')
        import fcntl
        owned_path(self.path, self.path.parent)
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        fd = os.open(self.path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1:
                raise LoopError('invalid session lock ownership')
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except (OSError, LoopError) as exc:
            os.close(fd)
            if isinstance(exc, BlockingIOError):
                raise SessionBusy('session lock busy: ' + str(self.path)) from exc
            raise LoopError('session lock invalid: ' + str(self.path)) from exc
        self.fd = fd
        return self

    def __exit__(self, *_):
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None


def binding(context: dict, agent: dict) -> dict:
    # Hash effective inherited environment, never persist credential values.
    config = digest({'agent': agent, 'environment': environment(agent.get('inherit_env', []))})
    return {k: context[k] for k in ('run_id', 'unit_id', 'role', 'rule_hash', 'unit_input_hash')} | {
        'developer_config_hash': config}


def _require(condition: bool, field: str):
    if not condition:
        raise ValueError('invalid session payload: ' + field)


def _strings(value: dict, *fields: str):
    for field in fields:
        _require(isinstance(value.get(field), str), field + ' must be a string')


def _number(value) -> bool:
    return type(value) in (int, float) and value >= 0 and (type(value) is int or math.isfinite(value))


def _iso_timestamp(value):
    _require(isinstance(value, str) and 'T' in value, 'entry timestamp')
    datetime.fromisoformat(value.replace('Z', '+00:00'))


def _usage(value):
    _require(isinstance(value, dict), 'usage must be an object')
    for field in ('input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'):
        _require(_number(value.get(field)), 'usage.' + field)
    cost = value.get('cost')
    _require(isinstance(cost, dict), 'usage.cost must be an object')
    for field in ('input', 'output', 'cacheRead', 'cacheWrite', 'total'):
        _require(_number(cost.get(field)), 'usage.cost.' + field)


def _content(value, allowed=('text', 'image'), strings=True):
    if strings and isinstance(value, str):
        return
    _require(isinstance(value, list), 'message content must be ' + ('a string or ' if strings else '') + 'an array')
    for block in value:
        _require(isinstance(block, dict), 'content block must be an object')
        kind = block.get('type')
        _require(isinstance(kind, str) and kind in allowed, 'unsupported content block type')
        if kind == 'text':
            _strings(block, 'text')
        elif kind == 'image':
            _strings(block, 'data', 'mimeType')
        elif kind == 'thinking':
            _strings(block, 'thinking')
        elif kind == 'toolCall':
            _strings(block, 'id', 'name')
            _require(bool(block['id']) and bool(block['name']), 'toolCall identity')
            _require(isinstance(block.get('arguments'), dict), 'toolCall.arguments')


def _message(value):
    """Validate persisted message shapes, not the partial JSONL event stream.

    Unknown roles/blocks fail closed to fresh, rather than guessing an extension
    schema. Optional provider/extension metadata is preserved without rewriting.
    """
    _require(isinstance(value, dict), 'message must be an object')
    role = value.get('role')
    _require(isinstance(role, str), 'message.role')
    _require(_number(value.get('timestamp')), 'message.timestamp')
    if role == 'user':
        _content(value.get('content'))
    elif role == 'assistant':
        _content(value.get('content'), ('text', 'thinking', 'toolCall'), strings=False)
        _strings(value, 'api', 'provider', 'model', 'stopReason')
        _require(all(value[field] for field in ('api', 'provider', 'model', 'stopReason')), 'assistant metadata')
        _usage(value.get('usage'))
    elif role == 'toolResult':
        _strings(value, 'toolCallId', 'toolName')
        _require(bool(value['toolCallId']) and bool(value['toolName']), 'toolResult identity')
        _require(type(value.get('isError')) is bool, 'toolResult.isError')
        _content(value.get('content'), strings=False)
    elif role == 'system':
        _strings(value, 'content')
        if 'sections' in value:
            sections = value['sections']
            _require(isinstance(sections, dict), 'system.sections')
            _require(all(item is None or isinstance(item, str) for item in sections.values()), 'system section patch')
        for field in ('toolsAdded', 'toolsRemoved'):
            if field not in value:
                continue
            _require(isinstance(value[field], list), 'system.' + field)
            for tool in value[field]:
                _require(isinstance(tool, dict), 'system tool must be an object')
                _strings(tool, 'name')
                _require(bool(tool['name']), 'system tool name')
                if field == 'toolsAdded':
                    _strings(tool, 'description')
                    _require(isinstance(tool.get('parameters'), dict), 'system tool parameters')
    else:
        raise ValueError('unsupported session message role: ' + role)


def _entry_payload(entry: dict, preceding: dict):
    """Required v3 payloads from reference/pi-session-format.md.

    This is shared by selection, acceptance, and the adapter's pre-write check.
    References are resolved only against this explicit file, never other sessions.
    """
    kind = entry['type']
    if kind == 'message':
        _message(entry.get('message'))
    elif kind == 'model_change':
        _strings(entry, 'provider', 'modelId')
        _require(bool(entry['provider']) and bool(entry['modelId']), 'model_change identity')
    elif kind == 'thinking_level_change':
        level = entry.get('thinkingLevel')
        _require(isinstance(level, str) and level in ('off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'),
                 'thinkingLevel')
    elif kind == 'usage':
        _strings(entry, 'kind', 'provider', 'model')  # Unknown usage kinds are valid.
        _usage(entry.get('usage'))
    elif kind == 'compaction':
        _strings(entry, 'summary', 'firstKeptEntryId')
        _require(entry['firstKeptEntryId'] in preceding or entry['firstKeptEntryId'] == entry['id'], 'firstKeptEntryId')
        _require(_number(entry.get('tokensBefore')), 'tokensBefore')
        if 'systemMessage' in entry:
            _message(entry['systemMessage'])
            _require(entry['systemMessage']['role'] == 'system', 'compaction.systemMessage role')
    elif kind == 'context_edit':
        _strings(entry, 'targetId')
        target = preceding.get(entry['targetId'])
        _require(target is not None, 'context_edit.targetId')
        role = target['message']['role'] if target['type'] == 'message' else None
        _require(role in ('user', 'assistant', 'toolResult') or target['type'] == 'custom_message', 'context_edit target type')
        _require('replacement' in entry, 'context_edit.replacement missing')
        if entry['replacement'] is not None:
            allowed = ('text', 'thinking', 'toolCall') if role == 'assistant' else ('text', 'image')
            _content(entry['replacement'], allowed)  # Pi normalizes string replacements for array roles.
    elif kind == 'branch_summary':
        _strings(entry, 'fromId', 'summary')
        _require(entry['fromId'] in preceding, 'branch_summary.fromId')
    elif kind in ('custom', 'custom_message'):
        _strings(entry, 'customType')
        _require(bool(entry['customType']), 'customType')
        # Extension data/details are arbitrary and may be absent.
        if kind == 'custom_message':
            _content(entry.get('content'))
            _require(type(entry.get('display')) is bool, 'custom_message.display')
    elif kind == 'label':
        _strings(entry, 'targetId')
        _require(entry['targetId'] in preceding, 'label.targetId')
        if 'label' in entry:  # Omitted label clears the bookmark.
            _strings(entry, 'label')
    elif kind == 'session_info':
        _strings(entry, 'name')
    else:
        raise ValueError('unsupported session entry type: ' + kind)
    if kind in ('compaction', 'branch_summary'):
        if 'usage' in entry:
            _usage(entry['usage'])
        if 'fromHook' in entry:
            _require(type(entry['fromHook']) is bool, kind + '.fromHook')


def session_contents(path: Path, session_id: str, cwd: str) -> tuple[dict, bytes]:
    if path.is_symlink() or not path.is_file():
        raise LoopError('session missing or not a regular file')
    info = path.stat()
    if info.st_uid != os.getuid() or info.st_nlink != 1 or info.st_size > SESSION_BYTES:
        raise LoopError('session ownership/size invalid')
    data = path.read_bytes()
    first, separator, history = data.partition(b'\n')
    if not separator or not data.endswith(b'\n'):
        raise LoopError('session truncated')
    def unique(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError('duplicate session key')
            result[key] = value
        return result
    def finite_float(value):
        number = float(value)
        if not math.isfinite(number):
            raise ValueError('nonfinite session value')
        return number
    def parse(line):
        value = json.loads(line, object_pairs_hook=unique, parse_float=finite_float,
                           parse_constant=lambda _: (_ for _ in ()).throw(ValueError('nonfinite session value')))
        if not isinstance(value, dict):
            raise ValueError('session entry is not an object')
        return value
    try:
        header = parse(first)
        if (header.get('type') != 'session' or type(header.get('version')) is not int
                or header['version'] != 3 or header.get('id') != session_id
                or header.get('cwd') != cwd or not isinstance(header.get('timestamp'), str)):
            raise ValueError('session header identity/cwd mismatch')
        _iso_timestamp(header['timestamp'])
        entries = {}
        for line in history.split(b'\n')[:-1]:
            entry = parse(line)
            eid, parent = entry.get('id'), entry.get('parentId')
            if (not isinstance(entry.get('type'), str) or entry['type'] == 'session'
                    or not isinstance(eid, str) or not eid or eid in entries
                    or 'parentId' not in entry or (parent is not None and
                        (not isinstance(parent, str) or parent not in entries))):
                raise ValueError('session history identity/tree invalid')
            _iso_timestamp(entry.get('timestamp'))
            _entry_payload(entry, entries)
            entries[eid] = entry
    except (ValueError, UnicodeError, TypeError, RecursionError) as exc:
        raise LoopError('corrupt session: ' + str(exc)) from exc
    return header, history


class DeveloperSessions:
    def __init__(self, store, unit: dict, role: str):
        self.store, self.unit, self.role = store, unit, role
        self.workspace = store.run / 'units' / unit['id']
        self.directory = self.workspace / 'sessions'
        self.map_path = self.directory / 'developer.json'
        self.policy = unit.get('developer_session', 'fresh')
        self.lock = None

    def __enter__(self):
        if self.policy == 'reuse_repairs' and self.role == 'developer':
            owned_path(self.directory, self.workspace)
            self.lock = SessionLock(self.directory / 'mapping.lock')
            self.lock.__enter__()  # Contention rejects the invocation, never guesses a session.
        return self

    def __exit__(self, *exc):
        if self.lock:
            self.lock.__exit__(*exc)

    def select(self, context: dict, agent: dict) -> dict:
        previous = []
        for path in sorted((self.workspace / 'attempts').glob('*/context.json')):
            old = load_json(path)
            if old['run_id'] != context['run_id'] or old['unit_id'] != context['unit_id']:
                raise LoopError('previous checkout context ownership mismatch')
            previous.append(old['code_path'])
        selection = {'policy': self.policy, 'mode': 'fresh', 'session_path': None,
                     'previous_code_paths': previous, 'reason': 'default_fresh',
                     'guard_roots': [], 'binding': None}
        if self.policy != 'reuse_repairs':
            return selection
        # Protect all earlier checkouts, gates and frozen candidates, not only
        # the conversation's developer paths. The adapter excludes current cwd.
        selection['guard_roots'] = [str(self.store.root / name) for name in
                                    ('checkouts', 'artifacts', 'snapshots')]
        if self.role != 'developer':
            selection['reason'] = 'reviewer_always_fresh'
            return selection
        if not self.lock or not supports_reuse(agent):
            raise LoopError('reuse_repairs requires the shipped local Pi command adapter')
        bound = binding(context, agent)
        selection.update(binding=bound, map_path=str(self.map_path))
        old = None
        reason = 'first_business_attempt' if context['round'] == 1 else 'fallback_fresh: mapping missing'
        try:
            if self.map_path.exists() or self.map_path.is_symlink():
                owned_path(self.map_path, self.directory)
                old = load_json(self.map_path, 1024 * 1024)
                if not isinstance(old, dict):
                    raise LoopError('corrupt session mapping: not an object')
                if old.get('binding') != bound:
                    raise LoopError('mapping binding mismatch (run/unit/role/rules/input/config)')
                if type(old.get('ready')) is not bool:
                    raise LoopError('corrupt session mapping: ready must be a boolean')
                if old['ready'] is not True:
                    raise LoopError('previous session not accepted: ' + str(old.get('reason', 'unknown')))
                if old['round'] != context['round'] - 1 or not context.get('feedback'):
                    raise LoopError('not a consecutive business repair')
                self.verify_record(old, old['code_path'])
        except SessionBusy:
            raise
        except (LoopError, OSError, KeyError, TypeError, ValueError) as exc:
            reason, old = 'fallback_fresh: ' + str(exc)[:400], None
        if context['protocol_repair_only']:
            reason, old = 'protocol_repair_always_fresh', None
        if old is not None:
            selection.update(mode='reuse_repairs', session_path=old['session_path'],
                             session_id=old['session_id'], owner_path=old['owner_path'],
                             previous_cwd=old['code_path'], reason='consecutive_business_repair')
        else:
            sid = str(uuid.uuid4())
            path = owned_path(self.directory / (sid + '.jsonl'), self.directory)
            owner = self.directory / (sid + '.owner.json')
            # Valid v3 header is pre-created: --session opens this exact file,
            # including the first call. --name is display-only, never selection.
            if path.exists() or owner.exists():
                raise LoopError('refusing to overwrite any existing session')
            atomic_write(path, json.dumps({'type': 'session', 'version': 3, 'id': sid,
                                           'timestamp': now(), 'cwd': context['code_path']}) + '\n')
            atomic_json(owner, {'binding': bound, 'session_id': sid, 'session_path': str(path)}, readonly=True)
            self.store.seal(owner)
            selection.update(session_path=str(path), session_id=sid, owner_path=str(owner),
                             previous_cwd=context['code_path'], reason=reason)
        record = {**selection, 'round': context['round'], 'attempt_id': context['attempt_id'],
                  'code_path': context['code_path'], 'ready': False}
        atomic_json(self.map_path, record)
        self.store.event('session_selected', self.unit['id'], attempt=context['attempt_id'],
                         mode=selection['mode'], reason=selection['reason'], session_path=selection['session_path'])
        return selection

    def verify_record(self, record: dict, cwd: str):
        path = owned_path(Path(record['session_path']), self.directory)
        owner_path = owned_path(Path(record['owner_path']), self.directory)
        if path != self.directory / (record['session_id'] + '.jsonl') or owner_path != path.with_suffix('.owner.json'):
            raise LoopError('session mapping path identity mismatch')
        owner = load_json(owner_path, 65536)
        if owner != {'binding': record['binding'], 'session_id': record['session_id'], 'session_path': str(path)}:
            raise LoopError('session owner binding mismatch')
        with SessionLock(path.with_suffix('.lock')):
            session_contents(path, record['session_id'], cwd)

    def complete(self, context: dict, accepted: bool, reason: str):
        selected = context['session']
        if self.role != 'developer' or selected.get('session_path') is None:
            return
        record = load_json(self.map_path, 1024 * 1024)
        if record['attempt_id'] != context['attempt_id'] or record['binding'] != selected['binding']:
            raise LoopError('session acceptance ownership mismatch')
        ready = accepted and not context['protocol_repair_only']
        if ready:
            try:
                self.verify_record(record, context['code_path'])
            except SessionBusy:
                raise
            except (LoopError, OSError, KeyError, TypeError, ValueError) as exc:
                ready, reason = False, 'session_unusable_after_delivery: ' + str(exc)[:400]
        record.update(ready=ready, reason=reason)
        atomic_json(self.map_path, record)


@contextlib.contextmanager
def pi_session(context: dict, cwd: Path):
    """Adapter file lease + exact ownership check + atomic tool-cwd rebinding."""
    selected = context.get('session') or {}
    if selected.get('mode', 'fresh') not in ('fresh', 'reuse_repairs'):
        raise LoopError('unknown session mode')
    path_string = selected.get('session_path')
    if path_string is None:
        if selected.get('mode', 'fresh') != 'fresh':
            raise LoopError('reuse requested without explicit session path')
        yield ['--no-session']
        return
    if (context['role'] != 'developer' or context['protocol_repair_only'] and selected['mode'] != 'fresh'
            or selected.get('policy') != 'reuse_repairs'):
        raise LoopError('session role/policy mismatch')
    workspace = Path(context['workspace_path']).resolve()
    directory = workspace.parent.parent / 'sessions'
    if workspace.name != context['attempt_id'] or workspace.parent.name != 'attempts':
        raise LoopError('session attempt workspace mismatch')
    bound = selected['binding']
    if any(bound[k] != context[k] for k in ('run_id', 'unit_id', 'role', 'rule_hash', 'unit_input_hash')):
        raise LoopError('session context binding mismatch')
    path = owned_path(Path(path_string), directory)
    owner_path = owned_path(Path(selected['owner_path']), directory)
    map_path = owned_path(Path(selected['map_path']), directory)
    if (path != directory / (selected['session_id'] + '.jsonl')
            or owner_path != path.with_suffix('.owner.json') or map_path != directory / 'developer.json'):
        raise LoopError('session path identity mismatch')
    with SessionLock(path.with_suffix('.lock')):
        owner = load_json(owner_path, 65536)
        mapping = load_json(map_path, 1024 * 1024)
        if (owner != {'binding': bound, 'session_id': selected['session_id'], 'session_path': str(path)}
                or mapping.get('binding') != bound or mapping.get('attempt_id') != context['attempt_id']
                or mapping.get('code_path') != str(cwd) or mapping.get('session_path') != str(path)
                or mapping.get('ready') is not False):
            raise LoopError('session map/owner/current attempt mismatch')
        header, history = session_contents(path, selected['session_id'], selected['previous_cwd'])
        header['cwd'] = str(cwd)
        # SessionManager.open in Pi 0.87.1 restores header cwd; main.js uses it
        # to create tools. Passing subprocess cwd alone would reopen old tools.
        atomic_write(path, json.dumps(header, ensure_ascii=False).encode('utf-8') + b'\n' + history)
        session_contents(path, selected['session_id'], str(cwd))
        yield ['--session', str(path), '--session-dir', str(directory)]
