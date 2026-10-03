"""macOS Seatbelt protection for old checkouts, inherited by bash descendants.

This deliberately is not a whole-machine or network sandbox. Unsupported hosts
fail closed for the opt-in policy; chmod or a model instruction is not a guard.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import uuid

from .common import LoopError, atomic_json

SANDBOX = Path('/usr/bin/sandbox-exec')


def profile(cwd: Path, roots: list[str], session_file: str | None = None) -> str:
    cwd = cwd.resolve()
    rules = ['(version 1)', '(allow default)']
    for value in roots:
        path = Path(value).resolve()
        if path == cwd or path.is_relative_to(cwd):
            raise LoopError('invalid protection root inside current code_path')
        predicate = '(subpath ' + json.dumps(str(path), ensure_ascii=False) + ')'
        exceptions = []
        if cwd.is_relative_to(path):
            exceptions.append('(require-not (subpath ' + json.dumps(str(cwd), ensure_ascii=False) + '))')
        if session_file is not None and Path(session_file).is_relative_to(path):
            exceptions.append('(require-not (literal ' + json.dumps(session_file, ensure_ascii=False) + '))')
        if exceptions:
            predicate = '(require-all ' + predicate + ' ' + ' '.join(exceptions) + ')'
        rules.append('(deny file-write* ' + predicate + ')')
        # Deny renaming/deleting protected namespace ancestors as well.
        for parent in path.parents:
            rules.append('(deny file-write* (literal ' + json.dumps(str(parent), ensure_ascii=False) + '))')
    return '\n'.join(rules) + '\n'


# Both the capability probe and actual invocation stay foreground in the engine
# process group. A shell invoking Python tests an opaque payload, not a path-
# aware Pi extension. The parent checks bytes and cleanup independently.
PROBE = '''
import json, sys
from pathlib import Path
old, alias, current = map(Path, sys.argv[1:])
blocked = []
for path in (old, alias):
    try: path.write_bytes(b"FORBIDDEN")
    except OSError: blocked.append(True)
    else: blocked.append(False)
current.write_bytes(b"current writable")
print(json.dumps(blocked))
raise SystemExit(0 if all(blocked) else 17)
'''


def protect(argv: list[str], context: dict, cwd: Path, workspace: Path, timeout: float) -> list[str]:
    selected = context.get('session') or {}
    if selected.get('policy', 'fresh') != 'reuse_repairs':
        return argv
    if sys.platform != 'darwin' or not SANDBOX.is_file() or not os.access(SANDBOX, os.X_OK):
        raise LoopError('reuse_repairs unavailable: macOS sandbox-exec protection required')
    roots = selected.get('guard_roots')
    if not isinstance(roots, list) or not roots or any(not isinstance(p, str) or not Path(p).is_absolute() for p in roots):
        raise LoopError('reuse_repairs missing explicit protection roots')
    # Validate the data namespace, rather than trusting arbitrary context paths.
    code = Path(context['code_path']).resolve()
    if code != cwd or code.name != context['attempt_id'] or code.parent.name != context['unit_id']:
        raise LoopError('sandbox current code_path/attempt mismatch')
    root = code.parent.parent.parent.parent
    if code.parent.parent.name != context['run_id'] or code.parent.parent.parent.name != 'checkouts':
        raise LoopError('sandbox checkout run ownership mismatch')
    expected = [str(root / name) for name in ('checkouts', 'artifacts', 'snapshots')]
    if roots != expected or workspace.resolve() != root / 'runs' / context['run_id'] / 'units' / context['unit_id'] / 'attempts' / context['attempt_id']:
        raise LoopError('sandbox namespace/workspace mismatch')
    session_root = workspace.parent.parent / 'sessions'
    effective_roots = roots + [str(session_root)]
    session_file = selected.get('session_path')
    if session_file is not None and Path(session_file).parent != session_root:
        raise LoopError('sandbox session path outside owned directory')
    writable_code = context['role'] == 'developer' and not context['protocol_repair_only']
    current = (cwd if writable_code else workspace) / ('.loop-protection-probe-' + uuid.uuid4().hex)
    evidence = {'backend': 'macOS sandbox-exec', 'current_code_path': str(cwd),
                'protected_roots': effective_roots, 'status': 'FAIL'}
    try:
        with tempfile.TemporaryDirectory(prefix='loop-protection-', dir=workspace) as temporary:
            probe_root = Path(temporary).resolve()
            old = probe_root / 'old' / 'sentinel'
            old.parent.mkdir()
            old.write_bytes(b'unchanged')
            alias = probe_root / 'alias'
            alias.symlink_to(old.parent, target_is_directory=True)
            guarded = profile(cwd, effective_roots + [str(old.parent)], session_file)
            command = [str(SANDBOX), '-p', guarded, '/bin/bash', '-c',
                       'exec "$@"', 'loop-protection', sys.executable, '-c', PROBE,
                       str(old), str(alias / old.name), str(current)]
            result = subprocess.run(command, stdin=subprocess.DEVNULL, capture_output=True,
                                    timeout=min(timeout, 5), close_fds=True)
            blocked = json.loads(result.stdout) if result.returncode == 0 else None
            if (blocked != [True, True] or old.read_bytes() != b'unchanged'
                    or not current.is_file() or current.read_bytes() != b'current writable'):
                raise LoopError('sandbox capability probe failed: ' + result.stderr.decode('utf-8', errors='replace')[:300])
            evidence.update(status='PASS', absolute_write_denied=True, symlink_write_denied=True,
                            bash_python_descendant=True, current_writable=True if writable_code else None,
                            probe_write_path=str(current), readonly_current=not writable_code)
        effective = profile(cwd, effective_roots, session_file)
        evidence['profile'] = effective
        return [str(SANDBOX), '-p', effective, *argv]
    except (OSError, ValueError, subprocess.SubprocessError) as exc:
        raise LoopError('sandbox capability unavailable: ' + str(exc)[:300]) from exc
    finally:
        if current.exists():
            current.unlink()
        atomic_json(workspace / 'session-protection.json', evidence)
