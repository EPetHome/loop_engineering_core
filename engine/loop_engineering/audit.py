"""Read-only verification and explicit, never-overwrite artifact export."""
from __future__ import annotations
from pathlib import Path
from .common import (LoopError, IntegrityError, copy_manifest, digest, file_hash, load_json, safe_child)
from .engine import verify_candidate, snapshot_manifest


def audit(root: Path, rid: str) -> dict:
    run = root / 'runs' / rid
    data = load_json(run / 'manifest.json')
    errors = []
    try:
        rules = load_json(run / 'rules.json')
        if digest(rules) != data['rule_hash']:
            errors.append('有效规则指纹变化')
        limits = rules['limits']
    except (LoopError, KeyError) as exc:
        errors.append(str(exc))
        limits = {'max_source_files': 30000, 'max_source_bytes': 512 * 1024 * 1024}
    for relative, expected in data['integrity'].items():
        try:
            p = safe_child(run, relative)
            if not p.is_file() or file_hash(p) != expected:
                errors.append('冻结文件变化：' + relative)
        except (LoopError, OSError) as exc:
            errors.append(str(exc))
    if data.get('input'):
        try:
            actual = snapshot_manifest(Path(data['input']['path']), limits)
            if actual != data['input']['manifest'] or digest(actual) != data['input']['hash']:
                errors.append('原始输入快照发生变化')
        except (LoopError, OSError) as exc:
            errors.append(str(exc))
    for uid, state in data['units'].items():
        result = state.get('result')
        if not result:
            continue
        c = result.get('candidate')
        if c:
            try:
                verify_candidate(c, limits)
            except (LoopError, OSError, KeyError) as exc:
                errors.append(uid + ': ' + str(exc))
        if result['stop'] == 'PASSED':
            if not c or not result.get('reviewed') or any(r['status'] != 'PASS' for r in result['criteria']):
                errors.append(uid + ': 达标记录不完整')
            for ref, e in result.get('evidence', {}).items():
                if e.get('candidate_hash') != c['hash']:
                    errors.append(uid + ': 证据与候选不匹配：' + ref)
                if ref.startswith('code:'):
                    p = Path(e['path'])
                    if not p.is_file() or p.is_symlink() or file_hash(p) != e['sha256']:
                        errors.append(uid + ': 证据文件变化：' + ref)
    return {'run_id': rid, 'integrity_ok': not errors, 'errors': errors,
            'scope': '检查保存的规则、交接、门禁日志、输入快照及候选文件指纹；不重新判定业务语义，不防同账号恶意改写整个清单。'}


def export_candidate(root: Path, rid: str, destination: Path, uid: str | None = None) -> Path:
    run = root / 'runs' / rid
    data, rules = load_json(run / 'manifest.json'), load_json(run / 'rules.json')
    if data['state'] != 'TERMINAL':
        raise LoopError('运行尚未停止，不能导出正式候选')
    check = audit(root, rid)
    if not check['integrity_ok']:
        raise IntegrityError('完整性检查失败，拒绝导出：' + '; '.join(check['errors'][:5]))
    if uid is None:
        if rules['completion']['mode'] == 'integration':
            uid = rules['completion']['unit']
        elif len(data['units']) == 1:
            uid = next(iter(data['units']))
        else:
            raise LoopError('多个独立成果需要用 --unit 明确选择')
    if uid not in data['units']:
        raise LoopError('未知单元：' + uid)
    result = data['units'][uid]['result']
    if result['stop'] != 'PASSED':
        raise LoopError('该候选尚未达标；请在结果记录中查看未验证代码，不作为正式导出')
    c = result['candidate']
    manifest = verify_candidate(c, rules['limits'])
    target = destination.expanduser().resolve()
    copy_manifest(Path(c['path']), target, manifest, readonly=False)
    return target
