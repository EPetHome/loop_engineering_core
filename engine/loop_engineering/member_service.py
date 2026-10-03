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
from .common import LoopError, atomic_json, digest
from .execution import inspect_developer_delivery, execute_recipe
from .capabilities import unit_selftest_cap


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
                raw = self.rfile.readline(16385)
                try:
                    if len(raw) > 16384 or not raw.endswith(b'\n'):
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
        if set(request) - {'token', 'method', 'recipe_id', 'request_id'}:
            raise LoopError('unsupported member request fields')
        method = request.get('method')
        if method == 'hello':
            self.handshake = True
            return {'attempt_id': self.context['attempt_id'], 'profiles': self.context['unit'].get('build_profiles', []),
                    'tools': ['loop_build', 'loop_submit_check'], 'arbitrary_shell': False}
        if method not in ('build', 'submit_check'):
            raise LoopError('unsupported member operation')
        with self.lock:
            self.owner.check_time()
            self.owner.store.assert_integrity()
            manifest = inspect_developer_delivery(self.code, self.owner.input_manifest, self.owner.unit,
                                                  self.owner.limits, self.owner.rules.get('execution_profiles'))
            if self.context['role'] != 'developer' or self.context['protocol_repair_only']:
                if manifest != self.base:
                    raise LoopError('readonly member modified code')
                if method == 'build':
                    raise LoopError('reviewer/format-only members cannot start development builds')
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

    def __exit__(self, *_):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=3)
        self.temp.cleanup()
