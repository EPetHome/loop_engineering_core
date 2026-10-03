"""Attempt-scoped local build service. Pi never chooses code_path or argv."""
from __future__ import annotations
import hmac
import json
import os
from pathlib import Path
import secrets
import socketserver
import tempfile
import threading
import uuid
from .common import LoopError, atomic_json, atomic_write, digest, matches, relative_path, safe_child, writable_change
from .execution import inspect_developer_delivery, execute_recipe
from .capabilities import unit_selftest_cap

MAX_REQUEST_BYTES = 262144
MAX_FILE_OPERATION_PATHS = 500


class MemberService:
    def __init__(self, owner, context: dict, code: Path, base_manifest: dict):
        self.owner, self.context, self.code, self.base = owner, context, code, base_manifest
        self.token = secrets.token_hex(32)
        self.temp = None
        self.lock = threading.Lock()
        self.completed = {}
        self.handshake = False

    def __enter__(self):
        self.temp = tempfile.TemporaryDirectory(prefix='loop-member-')
        self.socket_path = Path(self.temp.name) / 'rpc.sock'
        instance = self
        class Handler(socketserver.StreamRequestHandler):
            def handle(self):
                self.connection.settimeout(10)
                raw = self.rfile.readline(MAX_REQUEST_BYTES + 1)
                try:
                    if len(raw) > MAX_REQUEST_BYTES or not raw.endswith(b'\n'):
                        raise LoopError('invalid member request frame')
                    request = json.loads(raw)
                    if not isinstance(request, dict) or not hmac.compare_digest(str(request.get('token', '')), instance.token):
                        raise LoopError('attempt token mismatch')
                    reply = {'ok': True, 'result': instance.dispatch(request)}
                except Exception as exc:
                    reply = {'ok': False, 'error': str(exc)[:2000]}
                self.wfile.write((json.dumps(reply, ensure_ascii=False, allow_nan=False) + '\n').encode())
        class Server(socketserver.ThreadingUnixStreamServer):
            daemon_threads = False
        self.server = Server(str(self.socket_path), Handler)
        os.chmod(self.socket_path, 0o600)
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={'poll_interval': .1}, daemon=True)
        self.thread.start()
        return self

    def env(self):
        return {'LOOP_MEMBER_SOCKET': str(self.socket_path), 'LOOP_MEMBER_TOKEN': self.token}

    def dispatch(self, request: dict):
        if set(request) - {'token', 'method', 'recipe_id', 'request_id', 'paths', 'source', 'targets'}:
            raise LoopError('unsupported member request fields')
        method = request.get('method')
        if method == 'hello':
            self.handshake = True
            return {'attempt_id': self.context['attempt_id'], 'profiles': self.context['unit'].get('build_profiles', []),
                    'tools': ['loop_build', 'loop_submit_check', 'loop_delete', 'loop_copy'], 'arbitrary_shell': False}
        if method not in ('build', 'submit_check', 'delete', 'copy'):
            raise LoopError('unsupported member operation')
        with self.lock:
            self.owner.check_time()
            self.owner.store.assert_integrity()
            manifest = inspect_developer_delivery(self.code, self.owner.input_manifest, self.owner.unit,
                                                  self.owner.limits, self.owner.rules.get('execution_profiles'))
            if self.context['role'] != 'developer' or self.context['protocol_repair_only']:
                if manifest != self.base:
                    raise LoopError('readonly member modified code')
                if method in ('build', 'delete', 'copy'):
                    raise LoopError('reviewer/format-only members cannot build or change files')
            if method == 'delete':
                return self.delete(request.get('paths'))
            if method == 'copy':
                return self.copy(request.get('source'), request.get('targets'))
            if method == 'submit_check':
                return {'candidate_hash': digest(manifest), 'status': 'BOUNDARY_OK',
                        'note': '仅交付边界检查；不代表门禁/独立评审通过'}
            recipe = request.get('recipe_id')
            if recipe not in self.owner.unit.get('build_profiles', []):
                raise LoopError('self-test profile not authorized for this unit')
            request_id = request.get('request_id')
            if not isinstance(request_id, str) or not request_id or len(request_id) > 160:
                raise LoopError('build requires bounded request_id')
            key = (recipe, request_id)
            if key in self.completed:
                return self.completed[key]
            cap = unit_selftest_cap(self.owner.rules, self.owner.unit)
            used = self.owner.store.data['units'][self.owner.uid]['stats'].get('selftests', 0)
            if used >= cap:
                raise LoopError(f'本单元自测额度已用完（{used}/{cap} 次）；请直接交付，由正式门禁检查')
            if not self.owner.store.reserve_operation('selftests', self.context['attempt_id'] + ':' + recipe + ':' + request_id, self.owner.limits['max_selftests'], self.owner.uid):
                raise LoopError('self-test budget exhausted')
            self.owner.store.counter(self.owner.uid, 'selftests')
            execution = self.owner.workspace / 'selftests' / self.context['attempt_id'] / ('build-' + uuid.uuid4().hex)
            profile = self.owner.rules['execution_profiles'][recipe]
            record = execute_recipe(self.code, manifest, profile, execution, self.owner.limits,
                purpose='SELF_TEST', security=self.owner.rules['security'], deadline=self.owner.deadline,
                cancel_file=self.owner.store.run / 'cancel',
                binding={k: self.context[k] for k in ('run_id', 'unit_id', 'attempt_id')}, run_quotas=self.owner.quota_specs())
            for path in execution.rglob('*'):
                if path.is_file() and not path.is_symlink() and 'source' not in path.relative_to(execution).parts and 'home' not in path.relative_to(execution).parts and 'tmp' not in path.relative_to(execution).parts:
                    self.owner.store.seal(path)
            reply = {'status': record['status'], 'reason': record['reason'], 'candidate_hash': record['candidate_hash'],
                     'purpose': 'SELF_TEST', 'receipt_path': str(execution / 'build-receipt.json'),
                     'stdout': record.get('stdout'), 'stderr': record.get('stderr'),
                     'error': record.get('error'), 'note': '不是正式门禁证据，开发方不得引用 gate:'}
            self.completed[key] = reply
            self.owner.store.event('selftest_finished', self.owner.uid, **reply)
            return reply

    def _relative(self, value) -> str:
        """Accept a code_path-relative path, or an absolute path inside this attempt's code_path."""
        if not isinstance(value, str) or not value:
            raise LoopError('文件路径必须是非空字符串')
        if os.path.isabs(value):
            for root in {os.path.normpath(str(self.code)), os.path.realpath(str(self.code))}:
                rel = os.path.relpath(os.path.normpath(value), root)
                if not rel.startswith('..'):
                    value = rel
                    break
            else:
                raise LoopError('路径不在本次 code_path 内：' + value)
        return relative_path(value.replace(os.sep, '/'))

    def _writable_file(self, value) -> tuple[str, Path]:
        rel = self._relative(value)
        unit = self.owner.unit
        outputs = [p for name in unit.get('build_profiles', [])
                   for p in self.owner.rules['execution_profiles'][name]['output_paths']]
        if not writable_change(rel, unit['writable_paths'], unit['protected_paths']) or matches(rel, outputs):
            raise LoopError('超出本单元可修改范围，或是构建临时产物：' + rel)
        return rel, safe_child(self.code, rel)

    def _paths(self, values, name: str) -> list:
        if not isinstance(values, list) or not values or len(values) > MAX_FILE_OPERATION_PATHS:
            raise LoopError(f'{name} 必须是 1—{MAX_FILE_OPERATION_PATHS} 个路径的数组')
        return values

    def delete(self, paths) -> dict:
        # Validate every path before touching any file, so a bad entry changes nothing.
        plan = []
        for value in self._paths(paths, 'paths'):
            rel, target = self._writable_file(value)
            if target.is_symlink() or not target.is_file():
                raise LoopError('只能删除已存在的普通文件（不删目录）：' + rel)
            if rel not in [r for r, _ in plan]:
                plan.append((rel, target))
        for _, target in plan:
            target.unlink()
        deleted = [rel for rel, _ in plan]
        self.owner.store.event('member_files_deleted', self.owner.uid, attempt_id=self.context['attempt_id'], paths=deleted)
        return {'deleted': deleted, 'note': '已在本次 code_path 删除；交付时仍按本单元范围核对'}

    def copy(self, source, targets) -> dict:
        source_rel = self._relative(source)
        origin = safe_child(self.code, source_rel)
        if origin.is_symlink() or not origin.is_file():
            raise LoopError('复制源必须是 code_path 内已存在的普通文件：' + source_rel)
        if origin.stat().st_size > self.owner.limits['max_source_bytes']:
            raise LoopError('复制源超过源码体积上限')
        data = origin.read_bytes()
        executable = bool(origin.stat().st_mode & 0o111)
        plan = []
        for value in self._paths(targets, 'targets'):
            rel, target = self._writable_file(value)
            if rel == source_rel:
                raise LoopError('目标与复制源相同：' + rel)
            if target.is_symlink() or (target.exists() and not target.is_file()):
                raise LoopError('目标已存在且不是普通文件：' + rel)
            if rel not in [r for r, _ in plan]:
                plan.append((rel, target))
        for _, target in plan:
            atomic_write(target, data)
            os.chmod(target, 0o700 if executable else 0o600)
        copied = [rel for rel, _ in plan]
        self.owner.store.event('member_files_copied', self.owner.uid, attempt_id=self.context['attempt_id'],
                               source=source_rel, paths=copied)
        return {'source': source_rel, 'copied': copied, 'bytes': len(data),
                'note': '逐字节复制，已存在的目标被覆盖；交付时仍按本单元范围核对'}

    def __exit__(self, *_):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=3)
        self.temp.cleanup()
