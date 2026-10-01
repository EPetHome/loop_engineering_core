"""Per-command guardian. Owns a process group, bounds output, watches its controller.

Not a containment sandbox: commands that intentionally detach into other sessions,
remote jobs, and commands with same-UID hostile access are outside this guarantee.
"""
from __future__ import annotations
import contextlib
import os
from pathlib import Path
import selectors
import signal
import subprocess
import sys
import time

if __package__ in (None, ''):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from loop_engineering.common import FileLock, atomic_json, load_json, now


def process_identity(pid: int) -> str | None:
    try:
        if sys.platform.startswith('linux'):
            raw = Path(f'/proc/{pid}/stat').read_text()
            rest = raw[raw.rfind(')') + 2:].split()
            return 'linux:' + rest[19]  # field 22, process start ticks
        value = subprocess.run(['ps', '-p', str(pid), '-o', 'lstart='], capture_output=True,
                               text=True, timeout=2).stdout.strip()
        return 'ps:' + value if value else None
    except (OSError, subprocess.SubprocessError, IndexError):
        return None


def kill_group(pgid: int, grace: float = 0.3) -> None:
    if pgid <= 1 or pgid == os.getpgrp():
        return
    with contextlib.suppress(ProcessLookupError, PermissionError):
        os.killpg(pgid, signal.SIGTERM)
    end = time.monotonic() + grace
    while time.monotonic() < end:
        try:
            os.killpg(pgid, 0)
        except ProcessLookupError:
            return
        except PermissionError:
            break
        time.sleep(0.02)
    with contextlib.suppress(ProcessLookupError, PermissionError):
        os.killpg(pgid, signal.SIGKILL)


def guard(job: Path) -> int:
    spec = load_json(job / 'job.json')
    owner = spec['owner_pid']
    begin = time.monotonic()
    last_output = begin
    total, reason, proc = 0, None, None
    terminate_requested = False
    def cancel(*_):
        nonlocal terminate_requested
        terminate_requested = True
    signal.signal(signal.SIGTERM, cancel)
    signal.signal(signal.SIGINT, cancel)
    with FileLock(job / 'guardian.lock'):
        try:
            with (job / 'stdin.txt').open('rb') as source:
                proc = subprocess.Popen(spec['argv'], cwd=spec['cwd'], stdin=source,
                                        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                        start_new_session=True, close_fds=True)
            atomic_json(job / 'process.json', {'guardian_pid': os.getpid(), 'guardian_start': process_identity(os.getpid()),
                        'child_pid': proc.pid, 'child_start': process_identity(proc.pid),
                        'pgid': proc.pid, 'owner_pid': owner, 'started_at': now()})
            sel = selectors.DefaultSelector()
            sel.register(proc.stdout, selectors.EVENT_READ, 'stdout')
            sel.register(proc.stderr, selectors.EVENT_READ, 'stderr')
            outputs = {name: (job / (name + '.log')).open('wb') for name in ('stdout', 'stderr')}
            leader_finished = False
            try:
                while sel.get_map():
                    current = time.monotonic()
                    if reason is None:
                        if terminate_requested or (job / 'cancel').exists() or Path(spec['cancel_file']).exists():
                            reason = 'cancelled'
                        elif os.getppid() != owner:
                            reason = 'controller_lost'
                        elif current - begin > spec['timeout_seconds'] or time.time() > spec['deadline_epoch']:
                            reason = 'timeout'
                        elif spec['idle_output_seconds'] and current - last_output > spec['idle_output_seconds']:
                            reason = 'idle_timeout'
                        if reason:
                            kill_group(proc.pid)
                    if proc.poll() is not None and not leader_finished:
                        # No background children are allowed to survive a member's completion.
                        kill_group(proc.pid, 0.05)
                        leader_finished = True
                    for key, _ in sel.select(0.08):
                        data = os.read(key.fileobj.fileno(), 65536)
                        if not data:
                            sel.unregister(key.fileobj)
                            key.fileobj.close()
                            continue
                        last_output = time.monotonic()
                        remaining = max(0, spec['max_log_bytes'] - total)
                        outputs[key.data].write(data[:remaining])
                        outputs[key.data].flush()
                        total += len(data)
                        if total > spec['max_log_bytes'] and reason is None:
                            reason = 'log_limit'
                            kill_group(proc.pid)
                    if reason and current - begin > spec['timeout_seconds'] + 3 and proc.poll() is not None:
                        break
                proc.wait(timeout=3)
            finally:
                sel.close()
                for f in outputs.values():
                    f.flush()
                    os.fsync(f.fileno())
                    f.close()
                kill_group(proc.pid, 0.05)
            reason = reason or ('ok' if proc.returncode == 0 else 'nonzero_exit')
            result = {'reason': reason, 'exit_code': proc.returncode, 'finished_at': now(),
                      'elapsed_seconds': round(time.monotonic() - begin, 3), 'output_bytes': total}
        except BaseException as exc:
            if proc:
                kill_group(proc.pid)
                with contextlib.suppress(Exception):
                    proc.wait(timeout=2)
            result = {'reason': 'launch_error' if proc is None else 'guardian_error', 'exit_code': None,
                      'error': f'{type(exc).__name__}: {exc}', 'finished_at': now(),
                      'elapsed_seconds': round(time.monotonic() - begin, 3), 'output_bytes': total}
        atomic_json(job / 'receipt.json', result)
    return 0


if __name__ == '__main__':
    raise SystemExit(guard(Path(sys.argv[1]).resolve()))
