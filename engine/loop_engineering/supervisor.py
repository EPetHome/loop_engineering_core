"""No-model supervisor and explicit orphan recovery."""
from __future__ import annotations
import contextlib
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
import traceback

from .adapters import ENGINE_DIR
from .common import LoopError, FileLock, atomic_json, atomic_write, load_json, lock_busy, now
from .runner import kill_group, process_identity
from .storage import Store, notify, render_views

EXIT_CODES = {'PASSED': 0, 'NOT_MET': 2, 'BLOCKED': 3}


def recover(root: Path, rid: str, internal=False) -> dict:
    run = root / 'runs' / rid
    if not internal and lock_busy(run / 'supervisor.lock'):
        raise LoopError('监督进程仍在运行；不能接管。需要停止时使用 stop 命令。')
    with FileLock(run / 'owner.lock'):
        store = Store(root, rid)
        if store.data['state'] == 'TERMINAL':
            render_views(root, rid)
            return store.data['result']
        atomic_write(run / 'cancel', 'orphan recovery\n')
        unresolved = []
        # Guardians are notified through cancellation files and their controller-parent check.
        jobs = list((run / 'units').glob('*/attempts/*/job')) + list((run / 'units').glob('*/gates/*/job'))
        for job in jobs:
            atomic_write(job / 'cancel', 'recovery\n')
        deadline = time.monotonic() + 4
        while any(lock_busy(job / 'guardian.lock') for job in jobs) and time.monotonic() < deadline:
            time.sleep(0.1)
        for job in jobs:
            meta_path = job / 'process.json'
            if not meta_path.exists():
                continue
            try:
                meta = load_json(meta_path)
                child_ok = meta.get('child_start') and process_identity(meta['child_pid']) == meta['child_start']
                guardian_ok = meta.get('guardian_start') and process_identity(meta['guardian_pid']) == meta['guardian_start']
                if child_ok:
                    kill_group(meta['pgid'])
                if guardian_ok and lock_busy(job / 'guardian.lock'):
                    os.kill(meta['guardian_pid'], signal.SIGTERM)
                    time.sleep(0.2)
                    if process_identity(meta['guardian_pid']) == meta['guardian_start']:
                        os.kill(meta['guardian_pid'], signal.SIGKILL)
                if not (job / 'receipt.json').exists():
                    unresolved.append(str(job) + ': 没有完整回执；已处理可验证归属的进程，未确认的外部副作用仍未知。')
            except (OSError, LoopError, KeyError) as exc:
                unresolved.append(str(job) + ': ' + str(exc))
        # Use original criterion IDs saved in the authoritative manifest even if rules.json was damaged.
        for uid, state in store.data['units'].items():
            if state['state'] == 'TERMINAL':
                continue
            ids = state.get('criterion_ids', [])
            store.finish_unit(uid, {'stop': 'BLOCKED', 'reason': '运行进程异常退出；程序恢复后补齐终态。旧通过不自动继承。',
                'candidate': state.get('checkpoint'), 'reviewed': False,
                'criteria': [{'id': c, 'status': 'UNKNOWN', 'note': '故障恢复，未获得完整有效结论', 'evidence': []} for c in ids],
                'rule_gaps': [], 'evidence': {}, 'history': [], 'recovery_notes': unresolved})
        store.event('orphan_recovered', unresolved=unresolved)
        # No final-check flags: even all-PASSED units cannot attest to a lost
        # finish_run commit. Do not rescan, rerun members or infer from [] here.
        store.finish_run()
        render_views(root, rid)
        return store.data['result']


def supervise(root: Path, rid: str) -> int:
    root = root.resolve()
    run = root / 'runs' / rid
    with FileLock(run / 'supervisor.lock'):
        data = load_json(run / 'manifest.json')
        if data['state'] == 'TERMINAL':
            render_views(root, rid)
            return EXIT_CODES[data['result']['stop']]
        atomic_json(run / 'supervisor.json', {'pid': os.getpid(), 'start_identity': process_identity(os.getpid()), 'started_at': now()})
        old_handlers = {}
        def request_stop(*_):
            atomic_write(run / 'cancel', 'supervisor signal\n')
        for sig in (signal.SIGINT, signal.SIGTERM):
            old_handlers[sig] = signal.signal(sig, request_stop)
        if hasattr(signal, 'SIGHUP'):
            old_handlers[signal.SIGHUP] = signal.signal(signal.SIGHUP, signal.SIG_IGN)
        worker = None
        try:
            with (run / 'controller.log').open('ab') as log:
                worker = subprocess.Popen([sys.executable, str(ENGINE_DIR / 'loop.py'), '_worker', rid,
                                           '--root', str(root)], stdin=subprocess.DEVNULL, stdout=log, stderr=log)
                atomic_json(run / 'worker.json', {'pid': worker.pid, 'start_identity': process_identity(worker.pid)})
                cancel_since = None
                final_deadline = data['created_epoch'] + data['max_wall_seconds'] + 8
                while worker.poll() is None:
                    if (run / 'cancel').exists() and cancel_since is None:
                        cancel_since = time.monotonic()
                    if time.time() > final_deadline or (cancel_since is not None and time.monotonic() - cancel_since > 8):
                        worker.terminate()
                        try:
                            worker.wait(timeout=3)
                        except subprocess.TimeoutExpired:
                            worker.kill()
                            worker.wait(timeout=3)
                        break
                    time.sleep(0.1)
            result = recover(root, rid, internal=True)
            # Notifications are a separate best-effort side effect, not a completion criterion.
            with contextlib.suppress(Exception):
                notify(root, rid)
            return EXIT_CODES[result['stop']]
        except Exception:
            # A failed supervisor operation must not leave its worker running unowned.
            with contextlib.suppress(Exception):
                atomic_write(run / 'supervisor-error.txt', traceback.format_exc())
                atomic_write(run / 'cancel', 'supervisor failure\n')
            if worker is not None and worker.poll() is None:
                with contextlib.suppress(OSError, subprocess.SubprocessError):
                    worker.terminate()
                    try:
                        worker.wait(timeout=3)
                    except subprocess.TimeoutExpired:
                        worker.kill()
                        worker.wait(timeout=3)
            result = recover(root, rid, internal=True)
            with contextlib.suppress(Exception):
                notify(root, rid)
            return EXIT_CODES[result['stop']]
        finally:
            for sig, handler in old_handlers.items():
                signal.signal(sig, handler)
