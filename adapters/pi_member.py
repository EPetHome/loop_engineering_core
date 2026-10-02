#!/usr/bin/env python3
"""Foreground command adapter: Pi JSONL activity on disk, final report on stdout.

Existing --model/--thinking/--tools and permission-extension conventions remain.
LOOP_CONTEXT supplies workspace/limits; --workspace also supports independent use.
Legacy text-only programs are accepted only after a successful process exit, with
unknown event/usage coverage. They are never a fallback for an incomplete JSONL run.
"""
from __future__ import annotations

import argparse
import contextlib
import os
from pathlib import Path
import selectors
import signal
import subprocess
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine'))
from loop_engineering.common import LoopError, load_json
from loop_engineering.pi_events import EventError, PiEvents, extract_json
from loop_engineering.sessions import pi_session
from loop_engineering.session_sandbox import protect

PI_DEFAULT = "/Users/Admin/.local/bin/pi"
NODE_BIN = "/Users/Admin/.hermes/node/bin"
PERMISSION_EXT = "/Users/Admin/.pi/agent/npm/node_modules/@gotgenes/pi-permission-system/src/index.ts"
TAIL_MESSAGE = "按上面的说明完成任务。最终回复只输出一个 JSON 对象，不加 Markdown 围栏，不加任何前后说明。"
DEFAULT_LOG_BYTES = 8 * 1024 * 1024


def collect(argv, prompt, env, workspace, max_bytes, timeout, deadline=None,
            cancel_files=(), max_response_bytes=1024 * 1024):
    """Drain both pipes and stdin without buffering a process-sized communicate().

Pi inherits this process group. The engine guardian owns/cleans that group; the
adapter never starts a new session or extends a deadline when activity arrives.
"""
    events = PiEvents(workspace, max_bytes)
    proc, total, reason, stopped_at = None, 0, None, None
    requested = False
    previous = {}
    stderr_log = None
    sel = selectors.DefaultSelector()
    begin = time.monotonic()
    def cancel(*_):
        nonlocal requested
        requested = True
    try:
        for sig in (signal.SIGTERM, signal.SIGINT):
            previous[sig] = signal.signal(sig, cancel)
        if workspace is not None:
            path = workspace / 'pi-stderr.log'
            if path.is_symlink():
                raise EventError('collector_error', 'refusing symlink pi-stderr.log')
            stderr_log = path.open('wb')
        proc = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, env=env, close_fds=True)
        for pipe, name in ((proc.stdout, 'stdout'), (proc.stderr, 'stderr'), (proc.stdin, 'stdin')):
            os.set_blocking(pipe.fileno(), False)
            sel.register(pipe, selectors.EVENT_WRITE if name == 'stdin' else selectors.EVENT_READ, name)
        remaining_prompt = memoryview(prompt.encode('utf-8'))
        while sel.get_map():
            current = time.monotonic()
            if reason is None:
                if requested or any(path.exists() for path in cancel_files):
                    reason = 'cancelled'
                elif current - begin >= timeout or (deadline is not None and time.time() >= deadline):
                    reason = 'timeout'
            if reason and stopped_at is None:
                stopped_at = current
                if proc.poll() is None:
                    proc.terminate()
            if stopped_at is not None:
                if current - stopped_at > .3 and proc.poll() is None:
                    proc.kill()
                if current - stopped_at > 1:
                    break  # Do not wait forever for inherited pipes on a failed call.
            for key, _ in sel.select(.05):
                if key.data == 'stdin':
                    try:
                        count = os.write(key.fileobj.fileno(), remaining_prompt[:65536]) if remaining_prompt else 0
                        remaining_prompt = remaining_prompt[count:]
                    except BrokenPipeError:
                        remaining_prompt = remaining_prompt[:0]
                    if not remaining_prompt:
                        sel.unregister(key.fileobj)
                        key.fileobj.close()
                    continue
                data = os.read(key.fileobj.fileno(), 65536)
                if not data:
                    sel.unregister(key.fileobj)
                    key.fileobj.close()
                    continue
                available = max(0, max_bytes - total)
                admitted = data[:available]
                total += len(data)
                if key.data == 'stdout':
                    events.feed(admitted)
                elif stderr_log:
                    stderr_log.write(admitted)
                    stderr_log.flush()
                if total > max_bytes and reason is None:
                    reason = 'log_limit'
        # Closed pipes do not imply the process exited. Bound that wait as well.
        while proc.poll() is None and reason is None:
            if requested or any(path.exists() for path in cancel_files):
                reason = 'cancelled'
            elif time.monotonic() - begin >= timeout or (deadline is not None and time.time() >= deadline):
                reason = 'timeout'
            else:
                time.sleep(.05)
        if reason and proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=.3)
            except subprocess.TimeoutExpired:
                proc.kill()
        proc.wait(timeout=2)
        reason = reason or ('ok' if proc.returncode == 0 else 'nonzero_exit')
        body = events.finish(reason, max_response_bytes=max_response_bytes)
        if reason != 'ok':
            print('pi_member: stopped: ' + reason, file=sys.stderr)
            return proc.returncode if proc.returncode and proc.returncode > 0 else 2
        sys.stdout.buffer.write(body)
        sys.stdout.buffer.flush()
        return 0
    except (LoopError, OSError, ValueError, EventError, subprocess.SubprocessError) as exc:
        reason = exc.reason if isinstance(exc, EventError) else 'collector_error'
        print('pi_member: ' + reason + ': ' + str(exc)[:500], file=sys.stderr)
        if events.activity.get('running'):
            events.finish(reason)
        return 2
    finally:
        if proc:
            if proc.poll() is None:
                proc.kill()
            with contextlib.suppress(subprocess.SubprocessError):
                proc.wait(timeout=2)
            for pipe in (proc.stdin, proc.stdout, proc.stderr):
                pipe.close()
        sel.close()
        if stderr_log:
            stderr_log.close()
        for sig, handler in previous.items():
            signal.signal(sig, handler)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--model', required=True)
    ap.add_argument('--thinking', required=True)
    ap.add_argument('--tools', required=True)
    ap.add_argument('--workspace', type=Path)
    ap.add_argument('--timeout-seconds', type=float)
    args = ap.parse_args()
    try:
        context_path = os.environ.get('LOOP_CONTEXT')
        context = load_json(Path(context_path), 1024 * 1024) if context_path else {}
        limits, unit = context.get('limits', {}), context.get('unit', {})
        workspace = args.workspace or (Path(context['workspace_path']) if context.get('workspace_path') else None)
        max_bytes = limits.get('max_log_bytes', DEFAULT_LOG_BYTES)
        timeout = unit.get('stage_timeout_seconds', 3000)
        if args.timeout_seconds is not None:
            timeout = min(timeout, args.timeout_seconds)
        cancel_files, deadline = [], None
        if workspace is not None:
            cancel_files += [workspace / 'cancel', workspace / 'job' / 'cancel']
            job_path = workspace / 'job' / 'job.json'
            if job_path.exists():
                spec = load_json(job_path, 1024 * 1024)
                timeout = min(timeout, spec['timeout_seconds'])
                deadline = spec['deadline_epoch']
                cancel_files.append(Path(spec['cancel_file']))
        if max_bytes <= 0 or timeout <= 0:
            raise ValueError('limits must be positive')
        prompt = sys.stdin.read(limits.get('max_context_bytes', 262144) + 1)
        if len(prompt.encode('utf-8')) > limits.get('max_context_bytes', 262144):
            raise ValueError('stdin exceeds max_context_bytes')
        if not prompt.strip():
            raise ValueError('标准输入里没有提示')
        env = dict(os.environ)
        env['PATH'] = NODE_BIN + os.pathsep + env.get('PATH', '')
        name = 'loop-%s-%s' % (os.environ.get('LOOP_UNIT_ID', 'unit'), os.environ.get('LOOP_ATTEMPT_ID', 'attempt'))
        argv = [os.environ.get('LOOP_PI_BIN', PI_DEFAULT), '--offline', '--mode', 'json',
                '--model', args.model, '--thinking', args.thinking,
                '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes',
                '--tools', args.tools, '-e', PERMISSION_EXT, '--name', name]
        cwd = Path.cwd().resolve()
        if context.get('code_path') and Path(context['code_path']).resolve() != cwd:
            raise LoopError('current process cwd differs from authoritative code_path')
        if (context.get('session') or {}).get('policy') == 'reuse_repairs' and workspace is None:
            raise LoopError('reuse_repairs requires the engine-owned attempt workspace')
        argv = protect(argv, context, cwd, workspace, timeout)
        with pi_session(context, cwd) as session_flags:
            argv += session_flags + ['-p', TAIL_MESSAGE]
            print('pi_member: JSONL foreground call; raw streams in workspace, final JSON only on stdout', file=sys.stderr)
            return collect(argv, prompt, env, workspace, max_bytes, timeout, deadline,
                           cancel_files, limits.get('max_response_bytes', 1024 * 1024))
    except (LoopError, OSError, ValueError, KeyError) as exc:
        print('pi_member: ' + str(exc)[:500], file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
