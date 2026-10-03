"""Local preparation-only controller. Never exposes approval, run, shell or file writes.

Run outside the model's writable sandbox. Same-user administrative access remains
outside this protection. Socket requests are deliberately restricted even when a
model knows the socket path. Client disconnects do not grant extra authority.
"""
from __future__ import annotations
import json
import os
from pathlib import Path
import socket
import socketserver
import stat
from .common import LoopError, FileLock, excluded, safe_child
from .ledger import Ledger
from . import prep

MAX_FRAME = 2 * 1024 * 1024
TOOLS = {
    'loop_prepare_begin': ('project_id',),
    'loop_prepare_patch': ('prep_id', 'revision', 'changes'),
    'loop_prepare_check': ('prep_id', 'revision'),
    'loop_prepare_probe': ('prep_id', 'revision', 'question_id'),
    'loop_prepare_seal': ('prep_id', 'revision'),
    'loop_prepare_status': ('prep_id',),
    'loop_project_info': ('project_id',),
    'loop_project_list': ('project_id', 'path'),
    'loop_project_read': ('project_id', 'path', 'start_line', 'max_lines'),
}


def _bounded_path(project: dict, rel: str) -> Path:
    if not isinstance(rel, str) or not rel or rel.startswith('/') or '..' in Path(rel).parts:
        raise LoopError('必须使用项目内相对路径')
    # Deliberate deny for secrets and external/symbolic files. This is not a secret scanner.
    if any(p.startswith('.env') or p in ('.git', '.ssh', '.aws', 'node_modules') or p.endswith(('.pem', '.key')) for p in Path(rel).parts):
        raise LoopError('敏感/依赖目录不由准备工具读取')
    source = Path(project['rules']['source'])
    if rel == '.':
        return source
    current = source
    for part in Path(rel).parts:
        current = current / part
        if current.is_symlink():
            raise LoopError('不通过符号链接读取项目内容')
    return safe_child(source, rel)


def dispatch(state: Path, request: dict) -> dict:
    if not isinstance(request, dict) or set(request) - {'method', 'args'}:
        raise LoopError('invalid request envelope')
    method, args = request.get('method'), request.get('args', {})
    if method not in TOOLS or not isinstance(args, dict) or set(args) - set(TOOLS[method]):
        raise LoopError('operation is not a preparation capability')
    # All accepted ids are validated before they participate in filesystem paths.
    from .rules import ident
    for field in ('prep_id', 'project_id'):
        if field in args:
            ident(args[field], field)
    if 'revision' in args and (type(args['revision']) is not int or args['revision'] < 1):
        raise LoopError('revision 必须为正整数')
    ledger = Ledger(state)
    if method == 'loop_prepare_begin':
        result = prep.begin(state, args['project_id'])
        return compact_prep(result, include_rules=True)
    if method == 'loop_prepare_patch':
        return compact_prep(prep.patch(state, args['prep_id'], args['revision'], args['changes']))
    if method == 'loop_prepare_check':
        return prep.check(state, args['prep_id'], args['revision'])
    if method == 'loop_prepare_probe':
        return prep.probe(state, args['prep_id'], args['revision'], args['question_id'])
    if method == 'loop_prepare_seal':
        sealed = prep.seal(state, args['prep_id'], args['revision'])
        return {k: sealed[k] for k in ('id', 'prep_id', 'project_id', 'revision', 'rules_hash', 'input_hash',
                'installation_hash', 'checks', 'launch_request_id', 'preview_path', 'launch_command')}
    if method == 'loop_prepare_status':
        return compact_prep(ledger.get('prep', args['prep_id']))
    project = ledger.get('project', args['project_id'])
    if method == 'loop_project_info':
        return {'project_id': project['id'], 'rules': project['rules'], 'root': project['root'],
                'require_probes': project['require_probes'], 'capabilities': prep.capability_summary()}
    path = _bounded_path(project, args.get('path', '.'))
    if method == 'loop_project_list':
        if not path.is_dir():
            raise LoopError('not a directory')
        entries = []
        for child in sorted(path.iterdir()):
            rel = child.relative_to(Path(project['rules']['source'])).as_posix()
            if child.is_symlink() or excluded(rel, project['rules']['exclude_paths']):
                continue
            if len(entries) == 300:
                return {'entries': entries, 'truncated': True}
            entries.append({'path': rel, 'kind': 'directory' if child.is_dir() else 'file'})
        return {'entries': entries, 'truncated': False}
    start, count = args.get('start_line', 1), args.get('max_lines', 160)
    if type(start) is not int or type(count) is not int or start < 1 or not 1 <= count <= 200:
        raise LoopError('line range out of bounds')
    if not path.is_file() or path.stat().st_size > 1024 * 1024:
        raise LoopError('只读取1MiB以内的普通文本；大文件请在循环外定向提取')
    text = path.read_text(encoding='utf-8')
    if '\x00' in text:
        raise LoopError('binary content refused')
    lines = text.splitlines()
    selected = lines[start-1:start-1+count]
    if len('\n'.join(selected).encode()) > 64000:
        raise LoopError('单次读取超过64KiB，请缩小范围')
    return {'path': args['path'], 'start_line': start, 'lines': selected,
            'total_lines': len(lines), 'next_line': start + len(selected) if start-1+len(selected) < len(lines) else None}


def compact_prep(value: dict, include_rules: bool = False) -> dict:
    keys = ['id', 'project_id', 'revision', 'status', 'actions', 'checks', 'prepared_id']
    if include_rules:
        keys += ['rules', 'capabilities']
    return {k: value[k] for k in keys if k in value}


def call(socket_path: Path, request: dict, timeout: float = 180) -> dict:
    payload = json.dumps(request, ensure_ascii=False, allow_nan=False).encode() + b'\n'
    if len(payload) > MAX_FRAME:
        raise LoopError('request too large')
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
        sock.settimeout(timeout)
        sock.connect(str(socket_path))
        sock.sendall(payload)
        with sock.makefile('rb') as stream:
            raw = stream.readline(MAX_FRAME + 1)
    if len(raw) > MAX_FRAME or not raw.endswith(b'\n'):
        raise LoopError('invalid controller response')
    reply = json.loads(raw)
    if not reply.get('ok'):
        raise LoopError(reply.get('error', 'controller refused'))
    return reply['result']


def serve(state: Path, socket_path: Path):
    ledger = Ledger(state)
    socket_path = socket_path.expanduser().absolute()
    if len(os.fsencode(socket_path)) >= 100:
        raise LoopError('Unix socket路径过长，请使用短的用户私有目录')
    socket_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with FileLock(ledger.state / 'server.lock'):
        if socket_path.exists() or socket_path.is_symlink():
            if not stat.S_ISSOCK(socket_path.lstat().st_mode):
                raise LoopError('已有路径不是socket，拒绝删除')
            # Lock guarantees only this state; probe to avoid deleting a live other service.
            try:
                with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as probe:
                    probe.settimeout(.3)
                    probe.connect(str(socket_path))
            except OSError:
                socket_path.unlink()
            else:
                raise LoopError('socket已有服务，不替换')
        class Handler(socketserver.StreamRequestHandler):
            def handle(self):
                self.connection.settimeout(10)
                try:
                    raw = self.rfile.readline(MAX_FRAME+1)
                    if len(raw) > MAX_FRAME or not raw.endswith(b'\n'):
                        raise LoopError('invalid frame')
                    reply = {'ok': True, 'result': dispatch(ledger.state, json.loads(raw))}
                except Exception as exc:
                    reply = {'ok': False, 'error': str(exc)[:2000]}
                body = json.dumps(reply, ensure_ascii=False, allow_nan=False).encode() + b'\n'
                if len(body) > MAX_FRAME:
                    body = b'{"ok":false,"error":"response too large"}\n'
                try:
                    self.wfile.write(body)
                except (BrokenPipeError, ConnectionResetError):
                    pass
        class Server(socketserver.ThreadingUnixStreamServer):
            daemon_threads = False
        server = Server(str(socket_path), Handler)
        os.chmod(socket_path, 0o600)
        print('Loop Guard preparation-only socket: ' + str(socket_path), flush=True)
        try:
            server.serve_forever(poll_interval=.2)
        except KeyboardInterrupt:
            pass
        finally:
            server.server_close()
            socket_path.unlink(missing_ok=True)
