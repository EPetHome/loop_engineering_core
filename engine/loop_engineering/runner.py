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
from loop_engineering.observability import timing_fields
from loop_engineering.pi_events import EventError, PiEvents


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


def _quota_exceeded(spec: dict) -> bool:
    """Group identical limits across roots; never follow symlinks or double count."""
    groups = {}
    for entry in spec.get('quotas', []):
        key = (entry.get('group', str(entry['path'])), entry['max_files'], entry['max_bytes'])
        groups.setdefault(key, []).append(Path(entry['path']))
    for (_, max_files, max_bytes), roots in groups.items():
        count, total, seen = 0, 0, set()
        for root in roots:
            if not root.exists():
                continue
            for base, dirs, files in os.walk(root, followlinks=False):
                for name in dirs + files:
                    p = Path(base) / name
                    key = str(p.absolute())
                    if key in seen:
                        continue
                    seen.add(key)
                    try:
                        info = p.lstat()
                    except FileNotFoundError:
                        continue
                    count += 1
                    total += info.st_size
                    if count > max_files or total > max_bytes:
                        return True
    return False


def guard(job: Path) -> int:
    from loop_engineering.diagnostics import PrefixLog
    from loop_engineering import outcomes
    import uuid
    spec = load_json(job / 'job.json')
    owner = spec['owner_pid']
    begin, wall_begin = time.monotonic(), time.time()
    last_output, last_quota = begin, 0.0
    total, stdout_bytes, reason, proc, collector = 0, 0, None, None, None
    terminate_requested = False
    control_r = control_w = None
    control_buffer = bytearray()
    control_error, adapter_outcome, cause_chain = None, None, []
    nonce = uuid.uuid4().hex
    outputs, sel = {}, selectors.DefaultSelector()
    soft = bool(spec.get('soft_diagnostics'))
    control_enabled = spec.get('adapter_protocol') == outcomes.PROTOCOL
    def cancel(*_):
        nonlocal terminate_requested
        terminate_requested = True
    signal.signal(signal.SIGTERM, cancel)
    signal.signal(signal.SIGINT, cancel)
    with FileLock(job / 'guardian.lock'):
        try:
            if spec.get('pi_json'):
                collector = PiEvents(job, spec.get('max_event_bytes', spec['max_log_bytes']),
                    diagnostic_bytes=spec['max_log_bytes'] if soft else None,
                    legacy_bytes=spec.get('max_event_bytes', spec['max_log_bytes']),
                    persist_interval=.5 if soft else 0)
            env = outcomes.clean_child_env(dict(os.environ))
            pass_fds = ()
            if control_enabled:
                control_r, control_w = os.pipe()
                os.set_blocking(control_r, False)
                env.update(LOOP_CONTROL_FD=str(control_w), LOOP_CONTROL_NONCE=nonce)
                pass_fds = (control_w,)
            with (job / 'stdin.txt').open('rb') as source:
                proc = subprocess.Popen(spec['argv'], cwd=spec['cwd'], stdin=source,
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env,
                    start_new_session=True, close_fds=True, pass_fds=pass_fds)
            if control_w is not None:
                os.close(control_w)
                control_w = None
            atomic_json(job / 'process.json', {'guardian_pid': os.getpid(), 'guardian_start': process_identity(os.getpid()),
                        'child_pid': proc.pid, 'child_start': process_identity(proc.pid),
                        'pgid': proc.pid, 'owner_pid': owner, 'started_at': now()})
            sel.register(proc.stdout, selectors.EVENT_READ, 'stdout')
            sel.register(proc.stderr, selectors.EVENT_READ, 'stderr')
            if control_r is not None:
                sel.register(control_r, selectors.EVENT_READ, 'control')
            for name in ('stdout', 'stderr'):
                path = job / (name + '.log')
                # Final report stdout is critical, not a diagnostic prefix.
                diagnostic = soft and (name == 'stderr' or spec.get('stdout_kind') == 'diagnostic')
                outputs[name] = PrefixLog(path, spec['max_log_bytes']) if diagnostic else path.open('wb')
            leader_finished, stop_at = False, None
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
                    elif current - last_quota >= 1:
                        last_quota = current
                        if _quota_exceeded(spec):
                            reason = 'disk_limit'
                    if reason:
                        stop_at = current
                        kill_group(proc.pid)
                if proc.poll() is not None and not leader_finished:
                    kill_group(proc.pid, .05)
                    leader_finished = True
                for key, _ in sel.select(.08):
                    fd = key.fd
                    try:
                        data = os.read(fd, 65536)
                    except BlockingIOError:
                        continue
                    if not data:
                        sel.unregister(key.fileobj)
                        if key.data != 'control':
                            key.fileobj.close()
                        continue
                    if key.data == 'control':
                        control_buffer.extend(data)
                        if len(control_buffer) > 8192:
                            control_error = 'oversized adapter control record'
                            if reason is None:
                                reason, stop_at = 'adapter_protocol_error', current
                                kill_group(proc.pid)
                            control_buffer.clear()
                        while b'\n' in control_buffer:
                            line, _, rest = control_buffer.partition(b'\n')
                            control_buffer = bytearray(rest)
                            try:
                                record = outcomes.decode(bytes(line), nonce)
                                if record['kind'] == 'activity':
                                    last_output = current
                                elif adapter_outcome is not None:
                                    raise ValueError('duplicate adapter outcome')
                                else:
                                    adapter_outcome = {k: v for k, v in record.items() if k != 'nonce'}
                            except (ValueError, TypeError, UnicodeError) as exc:
                                control_error = str(exc)
                        continue
                    last_output = current
                    total += len(data)
                    if key.data == 'stdout':
                        stdout_bytes += len(data)
                    if not soft:
                        remaining = max(0, spec['max_log_bytes'] - (total - len(data)))
                        if key.data == 'stdout' and collector is not None:
                            collector.feed(data[:remaining])
                        else:
                            outputs[key.data].write(data[:remaining])
                        if total > spec['max_log_bytes'] and reason is None:
                            reason, stop_at = 'log_limit', current
                            kill_group(proc.pid)
                    elif key.data == 'stdout' and collector is not None:
                        collector.feed(data)  # NEVER send a retention-truncated stream to this parser.
                    elif key.data == 'stdout' and spec.get('stdout_kind', 'response') == 'response':
                        maximum = spec.get('max_response_bytes', 1024 * 1024)
                        remaining = max(0, maximum - (stdout_bytes - len(data)))
                        outputs['stdout'].write(data[:remaining])
                        if stdout_bytes > maximum and reason is None:
                            reason, stop_at = 'response_limit', current
                            kill_group(proc.pid)
                    else:
                        outputs[key.data].write(data)
                    outputs[key.data].flush()
                if stop_at is not None and current - stop_at > 3:
                    break
            # An exited leader can close its pipes before the process is reaped.
            while proc.poll() is None and reason is None:
                if terminate_requested or Path(spec['cancel_file']).exists() or (job / 'cancel').exists():
                    reason = 'cancelled'
                elif time.monotonic() - begin >= spec['timeout_seconds'] or time.time() >= spec['deadline_epoch']:
                    reason = 'timeout'
                else:
                    time.sleep(.05)
            if proc.poll() is None:
                kill_group(proc.pid)
            proc.wait(timeout=3)
            raw_reason = 'ok' if proc.returncode == 0 else 'nonzero_exit'
            if control_buffer:
                control_error = 'unterminated control record'
            if control_enabled:
                if control_error or adapter_outcome is None:
                    cause_chain.append({'origin': 'guardian', 'reason': 'adapter_protocol_error',
                                        'detail': control_error or 'missing adapter outcome'})
                    reason = reason or 'adapter_protocol_error'
                else:
                    cause_chain.append(adapter_outcome)
                    if adapter_outcome['reason'] == 'ok' and proc.returncode != 0:
                        reason = reason or 'adapter_protocol_error'
                    else:
                        reason = reason or adapter_outcome['reason']
            reason = reason or raw_reason
            if collector is not None:
                body = collector.finish(reason, spec.get('pi_delivery', 'json'),
                                        spec.get('max_response_bytes', spec['max_log_bytes']))
                outputs['stdout'].write(body)
            if _quota_exceeded(spec):
                reason = reason if reason != 'ok' else 'disk_limit'
            result = {'reason': reason, 'exit_code': proc.returncode, 'finished_at': now(),
                      **timing_fields(begin, wall_begin, time.monotonic(), time.time()),
                      'output_bytes': total, 'causes': cause_chain}
        except BaseException as exc:
            if proc:
                kill_group(proc.pid)
                with contextlib.suppress(subprocess.SubprocessError):
                    proc.wait(timeout=2)
            result = {'reason': exc.reason if isinstance(exc, EventError) else
                                ('launch_error' if proc is None else 'guardian_error'),
                      'exit_code': proc.returncode if proc else None,
                      'error': f'{type(exc).__name__}: {exc}', 'finished_at': now(),
                      **timing_fields(begin, wall_begin, time.monotonic(), time.time()),
                      'output_bytes': total, 'causes': cause_chain}
        finally:
            sel.close()
            if proc:
                kill_group(proc.pid, .05)
                for stream in (proc.stdout, proc.stderr):
                    if stream and not stream.closed:
                        stream.close()
            for fd in (control_r, control_w):
                if fd is not None:
                    with contextlib.suppress(OSError):
                        os.close(fd)
            for out in outputs.values():
                out.flush()
                if hasattr(out, 'fileno'):
                    os.fsync(out.fileno())
                out.close()
        if collector is not None and collector.activity.get('running'):
            with contextlib.suppress(Exception):
                collector.finish(result['reason'])
        atomic_json(job / 'receipt.json', result)
    return 0


if __name__ == '__main__':
    raise SystemExit(guard(Path(sys.argv[1]).resolve()))
