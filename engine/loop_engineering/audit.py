"""Read-only verification and explicit, never-overwrite artifact export."""
from __future__ import annotations
from pathlib import Path
from .common import (LoopError, IntegrityError, copy_manifest, digest, file_hash, load_json, safe_child)
from .engine import verify_candidate, snapshot_manifest
from .storage import finalization_binding
from .handoff import finding_id, resolution_gates, rule_gaps


def finalization_errors(data: dict) -> list[str]:
    """Validate a saved attestation without performing or inferring completion."""
    result = data.get('result') or {}
    finalization = result.get('finalization')
    if finalization is None:
        return []  # Legacy records can be intact, but their completion is unknown.
    if not isinstance(finalization, dict):
        return ['总收尾 finalization 记录无效']
    errors = []
    if finalization.get('status') not in ('PASS', 'FAIL', 'UNKNOWN'):
        errors.append('总收尾状态无效')
    for key, expected in finalization_binding(data).items():
        if key not in finalization or finalization[key] != expected:
            errors.append('总收尾绑定不匹配：' + key)
    if finalization.get('status') == 'PASS':
        if not (data.get('input') or {}).get('hash'):
            errors.append('总收尾 PASS 缺少有效输入绑定')
        if (result.get('source_drift') != [] or result.get('source_drift_error')
                or result.get('integrity_error') or data.get('final_integrity_error')):
            errors.append('总收尾 PASS 与原项目/完整性异常或未知记录矛盾')
        checks = finalization.get('checks')
        if checks is not None and checks != {'integrity': 'PASS', 'source': 'PASS'}:
            errors.append('总收尾 PASS 与核对状态矛盾')
    return errors


def issue_history_errors(result: dict, unit: dict, run: Path, rid: str, uid: str) -> list[str]:
    """Check stored origin/closure bindings, not the reviewer's business semantics."""
    if 'issue_history' not in result:
        return []  # Read legacy terminal records without migrating them.
    errors, seen = [], set()
    history = result['issue_history']
    candidates = {h['round']: h['candidate'] for h in result.get('history', []) if h.get('candidate')}
    current = result.get('candidate')
    if current:
        candidates[current['round']] = current

    def accepted(source):
        path = run / 'units' / uid / 'attempts' / source['attempt_id'] / 'accepted.json'
        if Path(source['report_path']) != path.resolve():
            raise IntegrityError('问题记录来源不是本运行本单元的已接受报告')
        wrapper, context = load_json(path), load_json(path.parent / 'context.json')
        if (wrapper['attempt_id'] != source['attempt_id'] or wrapper['role'] != source['role'] or
                wrapper['candidate_hash'] != source['candidate_hash'] or context['round'] != source['round']):
            raise IntegrityError('问题记录来源绑定不匹配')
        candidate = candidates.get(source['round'])
        if candidate and candidate['hash'] != source['candidate_hash']:
            raise IntegrityError('问题记录与来源轮次候选不匹配')
        return wrapper, context

    for item in history:
        try:
            fid = item['id']
            if fid in seen or fid != finding_id(rid, uid, item['kind'], item['description'], item['criterion_ids']):
                raise IntegrityError('问题 ID 重复或与原始提出不匹配')
            seen.add(fid)
            if (item['kind'] not in ('issue', 'rule_gap') or
                    item['status'] not in ('OPEN', 'RESOLVED', 'UNKNOWN', 'ADVISORY', 'DEFERRED')):
                raise IntegrityError('历史问题种类或状态无效')
            if item['status'] == 'ADVISORY' and (item['kind'] != 'issue' or item.get('severity') != 'advisory'):
                raise IntegrityError('建议项种类或级别不一致')
            if item['status'] == 'DEFERRED' and (item['kind'] != 'issue' or not item.get('deferred') or
                    item.get('severity') == 'advisory'):
                raise IntegrityError('遗留发现种类、标记或级别不一致')
            if not item['occurrences'] or item['source'] != item['occurrences'][0]['source']:
                raise IntegrityError('历史问题丢失原始来源')
            if item['kind'] == 'issue' and item['suggested_fix'] != item['occurrences'][0]['reported']['suggested_fix']:
                raise IntegrityError('历史 issue 原始建议被改写')
            for occurrence in item['occurrences']:
                wrapper, _ = accepted(occurrence['source'])
                raw = occurrence['reported']
                if item['kind'] == 'issue':
                    if (raw not in wrapper['report']['issues'] or raw['description'] != item['description'] or
                            [raw['criterion_id']] != item['criterion_ids']):
                        raise IntegrityError('历史 issue 原始记录不匹配')
                elif raw not in wrapper['report']['rule_gaps'] or raw != item['description'] or item['criterion_ids']:
                    raise IntegrityError('历史 rule_gap 原始记录不匹配')
            for decision in item['resolution_attempts']:
                wrapper, context = accepted(decision)
                proposal = {k: decision[k] for k in ('id', 'note', 'evidence')}
                if (decision['role'] != 'reviewer' or decision['id'] != fid or not decision['evidence'] or
                        proposal not in wrapper['report'].get('issue_resolutions', []) or
                        fid not in {x['id'] for x in context.get('issue_history', [])}):
                    raise IntegrityError('解决记录不是评审对已知 ID 的显式声明')
                candidate_hash = decision['candidate_hash']
                gates = context['gate_evidence']
                checks = {gid: {'status': gates.get(gid, {}).get('status', 'UNKNOWN'),
                                'candidate_hash': gates.get(gid, {}).get('candidate_hash')}
                          for gid in resolution_gates(item, decision['evidence'], unit)}
                valid = all(g['status'] == 'PASS' and g['candidate_hash'] == candidate_hash for g in checks.values())
                if checks != decision['gate_checks'] or type(decision['applied']) is not bool or decision['applied'] != valid:
                    raise IntegrityError('解决状态与关联门禁核对不匹配')
                index = decision['evidence_index']
                if set(index) != set(decision['evidence']):
                    raise IntegrityError('解决证据索引不完整')
                for ref, evidence in index.items():
                    if evidence.get('candidate_hash') != candidate_hash:
                        raise IntegrityError('解决证据与候选不匹配')
                    if ref.startswith(('code:', 'scratch:')):
                        path = Path(evidence['path'])
                        if ref.startswith('code:'):
                            candidate = candidates.get(decision['round'])
                            base = Path(candidate['path']) if candidate else Path(context['code_path'])
                            if path != safe_child(base, ref[5:]):
                                raise IntegrityError('解决代码证据路径不匹配')
                        elif evidence != wrapper.get('scratch_evidence', {}).get(ref):
                            raise IntegrityError('解决取证引用未被封存或来源不匹配')
                        if path.is_symlink() or not path.is_file() or file_hash(path) != evidence['sha256']:
                            raise IntegrityError('解决证据文件变化')
                    elif ref.startswith('gate:'):
                        gate = gates[ref[5:]]
                        if any(evidence.get(k) != gate[k] for k in ('candidate_hash', 'status', 'stdout', 'stderr')):
                            raise IntegrityError('解决门禁证据绑定不匹配')
                    else:
                        raise IntegrityError('解决证据引用无效')
            resolution = item.get('resolution')
            if resolution and (resolution not in item['resolution_attempts'] or not resolution['applied']):
                raise IntegrityError('有效解决缺少已接受处理依据')
            if item['status'] == 'ADVISORY' and resolution:
                raise IntegrityError('建议项不能具有有效解决记录')
            if item['status'] == 'RESOLVED' and (not current or not resolution or
                    resolution['candidate_hash'] != current['hash'] or resolution['round'] != current['round'] or
                    not item['resolution_attempts'][-1]['applied']):
                raise IntegrityError('已解决问题沿用了旧候选或无效门禁证据')
        except (LoopError, OSError, KeyError, TypeError, ValueError, IndexError) as exc:
            errors.append(uid + ': ' + str(exc))
    if history and (result.get('rule_gaps') != rule_gaps(history) or
                    result.get('historical_rule_gaps') != rule_gaps(history, historical=True)):
        errors.append(uid + ': 当前/历史规则缺口投影不匹配')
    return errors


def audit(root: Path, rid: str) -> dict:
    run = root / 'runs' / rid
    data = load_json(run / 'manifest.json')
    errors = []
    try:
        rules = load_json(run / 'rules.json')
        if digest(rules) != data['rule_hash']:
            errors.append('有效规则指纹变化')
        limits = rules['limits']
    except (LoopError, OSError, KeyError, TypeError, ValueError) as exc:
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
        except (LoopError, OSError, KeyError, TypeError, ValueError) as exc:
            errors.append(str(exc))
    for uid, state in data['units'].items():
        if state.get('input_path'):
            try:
                frozen = load_json(run / 'units' / uid / 'input.json')
                actual = snapshot_manifest(Path(state['input_path']), limits)
                if (actual != frozen['manifest'] or digest(actual) != state['input_hash'] or
                        frozen['hash'] != state['input_hash'] or frozen['path'] != state['input_path']):
                    errors.append(uid + ': 本单元冻结输入快照发生变化')
            except (LoopError, OSError, KeyError, TypeError, ValueError) as exc:
                errors.append(uid + ': ' + str(exc))
        result = state.get('result')
        if not result:
            continue
        c = result.get('candidate')
        historical = [h['candidate'] for h in result.get('history', []) if h.get('candidate')]
        checked = set()
        for candidate in historical + ([c] if c else []):
            if candidate['path'] in checked:
                continue
            checked.add(candidate['path'])
            try:
                verify_candidate(candidate, limits)
            except (LoopError, OSError, KeyError, TypeError, ValueError) as exc:
                errors.append(uid + ': ' + str(exc))
        try:
            unit = next(u for u in rules['units'] if u['id'] == uid)
            errors.extend(issue_history_errors(result, unit, run, rid, uid))
        except (LoopError, OSError, KeyError, TypeError, ValueError, StopIteration, UnboundLocalError) as exc:
            errors.append(uid + ': 问题历史无法核对：' + str(exc))
        if result['stop'] == 'PASSED':
            program_only = (rules.get('schema_version') == 2 and unit.get('kind') == 'verify'
                            and unit.get('review_mode') == 'gates' and unit.get('reviewer') is None)
            if (not c or (not result.get('reviewed') and not program_only) or not result.get('criteria')
                    or any(r['status'] != 'PASS' for r in result['criteria'])):
                errors.append(uid + ': 达标记录不完整')
            if program_only:
                expected = {x['id']: x for x in unit['criteria']}
                rows = result.get('criteria', [])
                if len(rows) != len(expected) or {x['id'] for x in rows} != set(expected):
                    errors.append(uid + ': 程序验证标准集合不完整')
                current = next((h for h in result.get('history', []) if c and h['candidate']['hash'] == c['hash']
                                and h['round'] == c['round']), None)
                gates = (current or {}).get('gates', {})
                for cid, criterion in expected.items():
                    if not criterion['gate_ids']:
                        errors.append(uid + ': 程序验证不得代替纯语义标准')
                    for gid in criterion['gate_ids']:
                        g = gates.get(gid, {})
                        receipt_path = run / 'units' / uid / 'gates' / f'r{c["round"]:03d}-{gid}' / 'evidence.json'
                        try:
                            saved = load_json(receipt_path)
                            if (saved != g or g.get('status') != 'PASS' or g.get('purpose') != 'GATE'
                                    or g.get('candidate_hash') != c['hash'] or g.get('rule_hash') != data['rule_hash']
                                    or g.get('receipt', {}).get('reason') != 'ok'):
                                raise IntegrityError('程序验证缺少当前候选的完整门禁回执')
                            evidence = result.get('evidence', {}).get('gate:' + gid, {})
                            if evidence.get('status') != 'PASS' or evidence.get('candidate_hash') != c['hash']:
                                raise IntegrityError('程序验证门禁证据投影不匹配')
                        except (LoopError, OSError, KeyError, TypeError, ValueError) as exc:
                            errors.append(uid + ': ' + str(exc))
            for ref, e in result.get('evidence', {}).items():
                try:
                    if not c or e.get('candidate_hash') != c['hash']:
                        errors.append(uid + ': 证据与候选不匹配：' + ref)
                    if ref.startswith(('code:', 'scratch:')):
                        p = Path(e['path'])
                        if not p.is_file() or p.is_symlink() or file_hash(p) != e['sha256']:
                            errors.append(uid + ': 证据文件变化：' + ref)
                except (LoopError, OSError, KeyError, TypeError, ValueError) as exc:
                    errors.append(uid + ': ' + str(exc))
    errors.extend(finalization_errors(data))
    return {'run_id': rid, 'integrity_ok': not errors, 'errors': errors,
            'scope': '检查保存的规则、交接、门禁日志、已接受的取证引用、运行及单元输入快照、当前/历史候选、问题来源与解决证据及已记录的总收尾绑定；完整性通过不代表总收尾已完成，不重新判定业务语义，不防同账号恶意改写整个清单。'}


def export_candidate(root: Path, rid: str, destination: Path, uid: str | None = None) -> Path:
    run = root / 'runs' / rid
    data, rules = load_json(run / 'manifest.json'), load_json(run / 'rules.json')
    if uid is None:
        if rules['completion']['mode'] == 'integration':
            uid = rules['completion']['unit']
        elif len(data['units']) == 1:
            uid = next(iter(data['units']))
        else:
            raise LoopError('多个独立成果需要用 --unit 明确选择')
    if uid not in data['units']:
        raise LoopError('未知单元：' + uid)
    state = data['units'][uid]
    result = state.get('result') or {}
    c = result.get('candidate') or state.get('checkpoint')
    location = '；候选保留位置：' + (c['path'] if c else '尚无冻结候选，工作副本见运行记录')
    if data['state'] != 'TERMINAL':
        raise LoopError('运行尚未停止，不能导出正式候选' + location)
    if result.get('stop') != 'PASSED':
        raise LoopError('该候选尚未达标，不作为正式导出' + location)
    finalization = (data.get('result') or {}).get('finalization')
    if finalization is None:
        raise LoopError('旧运行缺少 finalization，总收尾核对未知；拒绝正式导出，不改写旧记录' + location)
    if not isinstance(finalization, dict) or finalization.get('status') != 'PASS':
        status = finalization.get('status', 'UNKNOWN') if isinstance(finalization, dict) else 'UNKNOWN'
        raise LoopError('总收尾核对为 ' + str(status) + '（异常或未知），拒绝正式导出' + location)
    check = audit(root, rid)
    if not check['integrity_ok']:
        raise IntegrityError('完整性或总收尾绑定检查失败，拒绝导出：' + '; '.join(check['errors'][:5]) + location)
    manifest = verify_candidate(c, rules['limits'])
    destination = destination.expanduser()
    # resolve() would erase a dangling target link and silently create its referent.
    if destination.exists() or destination.is_symlink():
        raise IntegrityError('目标已存在，拒绝覆盖：' + str(destination))
    target = destination.resolve()
    copy_manifest(Path(c['path']), target, manifest, readonly=False)
    return target
