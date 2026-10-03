"""One execution path for preparation probes, developer selftests and gates.

SELF_TEST is not GATE. The executor never accepts a caller-supplied source exclusion
for developer delivery. Scratch outputs do not enlarge editable source permissions.
"""
from __future__ import annotations
import contextlib
import functools
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import uuid

from .common import (LoopError, IntegrityError, atomic_json, atomic_write, copy_manifest,
                     changes, check_boundary, digest, tree_manifest, matches, environment,
                     safe_child, file_hash, now, FileLock)
from .capabilities import V2_LIMITS


class ExecutionError(LoopError):
    def __init__(self, reason: str, message: str):
        self.reason = reason
        super().__init__(message)


def inspect_developer_delivery(code: Path, base_manifest: dict, unit: dict, limits: dict,
                               profiles: dict | None = None) -> dict:
    actual = tree_manifest(code, max_files=limits['max_source_files'], max_bytes=limits['max_source_bytes'])
    # Deliberately no source_excludes argument. Real delivery and submit_check are identical.
    for name in unit.get('build_profiles', []):
        for rel in actual:
            if matches(rel, (profiles or {})[name]['output_paths']):
                raise IntegrityError('交付树包含构建临时产物，请使用 loop_build，不自动清理/豁免：' + rel)
    check_boundary(base_manifest, actual, unit['writable_paths'], unit['protected_paths'])
    return actual


def new_output_roots(before: dict, paths: list[str]) -> list[str]:
    """Collapse new files to the first directory that did not exist before."""
    roots = set()
    for p in paths:
        parts = p.rstrip('/').split('/')
        root = p
        for i in range(1, len(parts)):
            candidate = '/'.join(parts[:i]) + '/'
            if candidate not in before:
                root = candidate
                break
        roots.add(root)
    return sorted(r for r in roots if not any(r != o and o.endswith('/') and r.startswith(o) for o in roots))


def inspect_gate_outputs(before: dict, after: dict, output_paths: list[str], limits: dict) -> None:
    covered = sorted(p for p in before if matches(p, output_paths))
    if covered:
        raise ExecutionError('config_error', '输出路径覆盖既有源码/验收资产：' + ', '.join(covered[:20]))
    new_size = 0
    new_count = 0
    modified, undeclared = [], []
    for p in changes(before, after):
        if p in before:
            modified.append(p)
        elif not (matches(p, output_paths) or (p.endswith('/') and any(x.startswith(p) for x in output_paths))):
            undeclared.append(p)
        else:
            new_count += 1
            new_size += after.get(p, {}).get('bytes', 0)
    # Report every violation at once: one missing declaration must not cost one run each.
    if modified or undeclared:
        parts = []
        if modified:
            parts.append('修改了既有源码/验收资产 %d 项：%s' % (len(modified), ', '.join(sorted(modified)[:20])))
        if undeclared:
            parts.append('未声明的新输出（需人工核对后加入配方 output_paths）：'
                         + json.dumps(new_output_roots(before, undeclared), ensure_ascii=False))
        raise ExecutionError('output_violation', '构建' + '；'.join(parts))
    if new_size > limits['max_build_bytes'] or new_count > limits['max_build_files']:
        raise ExecutionError('build_limit', '派生产物独立配额已耗尽')


@functools.lru_cache(maxsize=1)
def darwin_user_temp() -> Path | None:
    """HotSpot attach files live here on macOS regardless of TMPDIR/java.io.tmpdir."""
    try:
        done = subprocess.run(['/usr/bin/getconf', 'DARWIN_USER_TEMP_DIR'], capture_output=True,
                              text=True, timeout=5, check=True)
    except (OSError, subprocess.SubprocessError):
        return None
    value = done.stdout.strip()
    return Path(value).resolve() if value.startswith('/') else None


def sbpl_string(path) -> str:
    """SBPL string literal. Keep UTF-8 as is: a \\uXXXX escape would name a different path,
    so every write under a non-ASCII directory would be denied (same rule as session_sandbox)."""
    return json.dumps(str(path), ensure_ascii=False)


def sbpl_regex(path: Path) -> str:
    text = str(path)
    if '"' in text or '\n' in text or '\\' in text:
        raise ExecutionError('config_error', '沙箱路径含不支持字符：' + text)
    return re.escape(text)


def sandbox_command(argv: list[str], writes: list[Path], *, network: bool, mode: str,
                    protected: list[Path] = (), write_files: list[Path] = (),
                    write_regexes: list[str] = (), jvm_attach: bool = False) -> list[str]:
    if mode == 'audit-only':
        return argv
    sandbox = Path('/usr/bin/sandbox-exec')
    if sys.platform != 'darwin' or not sandbox.is_file():
        raise ExecutionError('sandbox_unavailable', 'strict 模式要求 macOS sandbox-exec；不静默降级')
    allowed = ' '.join('(subpath ' + sbpl_string(p.resolve()) + ')' for p in writes)
    if not allowed:
        raise ExecutionError('config_error', '沙箱未声明写入目录')
    allowed += ''.join(' (literal ' + sbpl_string(p) + ')' for p in write_files)
    allowed += ''.join(' (regex #"' + r + '")' for r in write_regexes)
    policy = ['(version 1)', '(allow default)',
              '(deny file-write* (require-not (require-any ' + allowed + ' (literal "/dev/null"))))']
    if not network:
        policy.append('(deny network*)')
    temp = darwin_user_temp() if jvm_attach else None
    if temp is not None:
        # JVM attach (Mockito inline/Byte Buddy, jcmd) needs these files and a local socket
        # in the per-user temp dir. Signals stay inside this sandbox so a build cannot wake
        # the attach listener of an unrelated JVM; see docs040/04 for the remaining limit.
        attach = '#"^' + sbpl_regex(temp) + r'/\.(attach_pid[0-9]+|java_pid[0-9]+(\.tmp)?)$"'
        policy += ['(allow file-write* (regex ' + attach + '))',
                   '(allow network* (local unix-socket (path-regex ' + attach + ')))',
                   '(deny signal)', '(allow signal (target same-sandbox))']
    for p in protected:
        policy.append('(deny file-write* (subpath ' + sbpl_string(p.resolve()) + '))')
    return [str(sandbox), '-p', '\n'.join(policy), *argv]


def run_command(argv: list[str], cwd: Path, job: Path, env: dict, timeout: float,
                deadline: float, cancel_file: Path, limits: dict, quotas: list[dict] = ()) -> dict:
    from .runner import process_identity, kill_group
    from .adapters import ENGINE_DIR
    job.mkdir(parents=True, exist_ok=False)
    timeout = min(timeout, deadline - time.time())
    if timeout <= 0 or cancel_file.exists():
        raise ExecutionError('cancelled' if cancel_file.exists() else 'timeout', '构建尚未开始，已取消或超时')
    atomic_write(job / 'stdin.txt', '', readonly=True)
    spec = {'argv': argv, 'cwd': str(cwd), 'owner_pid': os.getpid(),
            'owner_start': process_identity(os.getpid()), 'timeout_seconds': timeout,
            'deadline_epoch': deadline, 'idle_output_seconds': 0,
            'cancel_file': str(cancel_file), 'max_log_bytes': limits['max_log_bytes'],
            'soft_diagnostics': True, 'stdout_kind': 'diagnostic', 'quotas': list(quotas)}
    atomic_json(job / 'job.json', spec, readonly=True)
    with (job / 'guardian.log').open('wb') as log:
        proc = subprocess.Popen([sys.executable, str(ENGINE_DIR / 'loop_engineering/runner.py'), str(job)],
                                stdin=subprocess.DEVNULL, stdout=log, stderr=log, env=env, start_new_session=True)
        try:
            proc.wait(timeout=timeout + 10)
        except subprocess.TimeoutExpired:
            atomic_write(job / 'cancel', 'executor watchdog\n')
            process = job / 'process.json'
            from .common import load_json
            if process.exists():
                identity = load_json(process)
                if identity.get('child_start') == process_identity(identity['child_pid']):
                    kill_group(identity['pgid'])
            proc.kill()
            proc.wait(timeout=3)
            raise ExecutionError('guardian_error', '构建守护器未按期退出')
    from .common import load_json
    if not (job / 'receipt.json').is_file():
        raise ExecutionError('guardian_error', '构建没有完整回执')
    return load_json(job / 'receipt.json')


def execute_recipe(source: Path, manifest: dict, profile: dict, execution: Path, limits: dict,
                   *, purpose: str, security: str, deadline: float, cancel_file: Path,
                   binding: dict | None = None, run_quotas: list[dict] = ()) -> dict:
    """Execute only a previously selected/frozen profile, never model-supplied argv."""
    from .adapters import expand, ENGINE_DIR
    limits = {**V2_LIMITS, **limits}
    execution = execution.resolve()
    if execution.exists():
        raise ExecutionError('config_error', '构建目录已存在，拒绝重用')
    execution.mkdir(parents=True)
    checkout, home, tmp = execution / 'source', execution / 'home', execution / 'tmp'
    reports = execution / 'evidence'
    for path in (home, tmp, reports):
        path.mkdir(mode=0o700)
    record = {'purpose': purpose, 'candidate_hash': digest(manifest), 'profile_hash': digest(profile),
              'binding': binding or {}, 'security': security, 'created_at': now(), 'reports': {},
              'status': 'UNKNOWN', 'reason': None}
    try:
        if tree_manifest(source, max_files=limits['max_source_files'], max_bytes=limits['max_source_bytes']) != manifest:
            raise ExecutionError('output_violation', '构建前源码指纹改变')
        copy_manifest(source, checkout, manifest)
        if tree_manifest(source, max_files=limits['max_source_files'], max_bytes=limits['max_source_bytes']) != manifest:
            raise ExecutionError('output_violation', '复制构建副本期间代码改变')
        if any(matches(p, profile['output_paths']) for p in manifest):
            raise ExecutionError('config_error', '构建输出与候选中已有内容重合')
        cwd = checkout if profile['cwd'] == '.' else checkout / profile['cwd']
        if not cwd.is_dir() or not cwd.resolve().is_relative_to(checkout):
            raise ExecutionError('config_error', '构建 cwd 不存在或越界')
        cache = Path(profile['cache_dir']) if profile.get('cache_dir') else None
        if cache is not None:
            if cache.is_symlink():
                raise ExecutionError('config_error', '缓存变为链接')
            cache.mkdir(parents=True, exist_ok=True, mode=0o700)
        args = expand(profile['argv'], {'python': sys.executable, 'engine': str(ENGINE_DIR),
                                       'code': str(checkout), 'workspace': str(execution), 'cache': str(cache) if cache else ''})
        wrapped = sandbox_command(args, [execution] + ([cache] if cache else []), network=profile['network'],
                                  mode=security, jvm_attach=True)

        env = environment(profile.get('inherit_env', []), gate_home=home)
        env.update(TMPDIR=str(tmp), TMP=str(tmp), TEMP=str(tmp), PYTHONDONTWRITEBYTECODE='1')
        # On macOS java.io.tmpdir ignores TMPDIR and points at the per-user temp dir, which the
        # sandbox does not allow. Forked test JVMs (surefire) inherit this, Mockito writes its
        # agent jar there. Keep every JVM's temp files inside this build instead.
        tmp_option = '-Djava.io.tmpdir=' + (json.dumps(str(tmp), ensure_ascii=False) if ' ' in str(tmp) else str(tmp))
        env['JAVA_TOOL_OPTIONS'] = (env.get('JAVA_TOOL_OPTIONS', '') + ' ' + tmp_option).strip()
        quotas = [{'path': str(execution), 'max_files': limits['max_build_files'] + limits['max_source_files'],
                   'max_bytes': limits['max_build_bytes'] + limits['max_source_bytes'] + limits['max_evidence_bytes']}]
        cache_lock = None
        if cache is not None:
            cache_lock = FileLock(cache.parent / ('.' + cache.name + '.loop.lock'))
            while True:
                try:
                    cache_lock.__enter__()
                    break
                except LoopError:
                    if cancel_file.exists() or time.time() >= deadline:
                        raise ExecutionError('timeout', '等待受管缓存锁超时；不并发破坏共享缓存')
                    time.sleep(.1)
            quotas.append({'path': str(cache), 'max_files': profile['max_cache_files'], 'max_bytes': profile['max_cache_bytes']})
        try:
            receipt = run_command(wrapped, cwd, execution / 'job', env, profile['timeout_seconds'],
                                  deadline, cancel_file, limits, [*quotas, *run_quotas])
        finally:
            if cache_lock is not None:
                cache_lock.__exit__(None, None, None)

        record.update(argv=args, cwd=str(cwd), receipt=receipt,
                      stdout=str(execution / 'job/stdout.log'), stderr=str(execution / 'job/stderr.log'))
        after = tree_manifest(checkout, max_files=limits['max_source_files'] + limits['max_build_files'],
                              max_bytes=limits['max_source_bytes'] + limits['max_build_bytes'])
        inspect_gate_outputs(manifest, after, profile['output_paths'], limits)
        record['outputs'] = new_output_roots(manifest, [p for p in changes(manifest, after) if p not in manifest])
        if tree_manifest(source, max_files=limits['max_source_files'], max_bytes=limits['max_source_bytes']) != manifest:
            raise ExecutionError('output_violation', '构建中或构建后编辑树改变，自测结果不能绑定当前代码')
        size = 0
        for rel in profile['evidence_paths']:
            path = safe_child(checkout, rel)
            if not path.is_file():
                raise ExecutionError('evidence_limit', '必需报告缺失：' + rel)
            size += path.stat().st_size
            if size > limits['max_evidence_bytes']:
                raise ExecutionError('evidence_limit', '必需证据超过独立额度')
            dest = reports / rel
            atomic_write(dest, path.read_bytes(), readonly=True)
            record['reports'][rel] = {'path': str(dest), 'sha256': file_hash(dest)}
        record['reason'] = receipt['reason']
        record['status'] = 'PASS' if receipt['reason'] == 'ok' else ('FAIL' if receipt['reason'] == 'nonzero_exit' else 'UNKNOWN')
    except (LoopError, OSError, ValueError) as exc:
        record.update(status='UNKNOWN', reason=getattr(exc, 'reason', 'output_violation'), error=str(exc))
    finally:
        record['finished_at'] = now()
        atomic_json(execution / 'build-receipt.json', record, readonly=True)
    return record
