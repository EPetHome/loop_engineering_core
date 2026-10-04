"""Read-only version comparisons and an append-only, per-unit findings ledger.

Origin reports never change. Status is a current-candidate projection, not an
inferred consequence of a criterion passing or a finding disappearing.
"""
from __future__ import annotations
import copy
import difflib
import json
import os
from pathlib import Path
import re

from .common import LoopError, changes, digest, file_hash, safe_child


def _text(path: Path, manifest: dict, relative: str) -> str | None:
    if manifest.get(relative, {}).get('kind') != 'file':
        return ''
    data = safe_child(path, relative).read_bytes()
    if b'\0' in data:
        return None
    try:
        return data.decode('utf-8')
    except UnicodeError:
        return None


def make_comparison(unit_input: Path, input_manifest: dict, code: Path, manifest: dict,
                    previous: dict | None, previous_manifest: dict | None,
                    previous_review: dict | None, diff_path: Path) -> dict:
    """Keep full bodies in frozen trees and complete diffs outside the prompt.

    The new file is not advertised until it has been flushed and sealed by the
    caller. Binary/type/mode changes have exact metadata and indexed full bodies.
    No diff or rule is silently shortened to meet the context budget.
    """
    comp = {'unit_input': {'path': str(unit_input), 'hash': digest(input_manifest)},
            'current': {'path': str(code), 'hash': digest(manifest)},
            'previous_candidate': copy.deepcopy(previous),
            'changed_from_input': changes(input_manifest, manifest),
            'changed_from_previous': changes(previous_manifest, manifest) if previous is not None else [],
            'previous_review': copy.deepcopy(previous_review)}
    comparisons = [('unit_input', unit_input, input_manifest, comp['changed_from_input'])]
    if previous is not None:
        comparisons.append(('previous_candidate', Path(previous['path']), previous_manifest,
                            comp['changed_from_previous']))
    with diff_path.open('x', encoding='utf-8', newline='') as out:
        out.write('Loop comparison: current is the attempt starting tree, not a future delivery.\n')
        for label, before_path, before, delta in comparisons:
            out.write('\n' + json.dumps({'against': label, 'path': str(before_path),
                      'hash': digest(before), 'current_hash': digest(manifest)}, ensure_ascii=False) + '\n')
            for relative in delta:
                out.write('\n' + json.dumps({'path': relative, 'before': before.get(relative),
                          'after': manifest.get(relative)}, ensure_ascii=False, sort_keys=True) + '\n')
                old, new = _text(before_path, before, relative), _text(code, manifest, relative)
                if old is None or new is None:
                    out.write('Binary content: read the indexed frozen/current file; hashes above bind all bytes.\n')
                    continue
                for line in difflib.unified_diff(old.splitlines(keepends=True), new.splitlines(keepends=True),
                                                fromfile=label + '/' + relative, tofile='current/' + relative):
                    out.write(line)
                    if not line.endswith('\n'):
                        out.write('\n\\ No newline at end of file\n')
        out.flush()
        os.fsync(out.fileno())
    os.chmod(diff_path, 0o400)
    comp['diff_index'] = {'path': str(diff_path), 'sha256': file_hash(diff_path),
                          'bytes': diff_path.stat().st_size}
    return comp


def code_map_covers(text: str, relative: str) -> bool:
    names = [relative] + [relative[:i + 1] for i, char in enumerate(relative) if char == '/']
    return any(re.search(r'(?<![\w./-])' + re.escape(name) + r'(?![\w./-])', text) for name in names)


def validate_code_map(text: str, before: dict, after: dict) -> None:
    missing = [p for p in changes(before, after)
               if (before.get(p, {}).get('kind') == 'file' or after.get(p, {}).get('kind') == 'file')
               and not code_map_covers(text, p)]
    if missing:
        extra = f'；另有 {len(missing) - 20} 条' if len(missing) > 20 else ''
        raise LoopError('code_map 漏写改动文件：' + '、'.join(missing[:20]) + extra
                        + '；请补齐相对路径，也可以用以 / 结尾的目录前缀统一覆盖；只改报告，不要改代码')


def read_guidance(context: dict, manifest: dict) -> dict:
    code_map = context.get('code_map')
    text = code_map.get('text') if isinstance(code_map, dict) else None
    paths = {p for p, info in manifest.items() if info.get('kind') == 'file' and text is not None
             and code_map_covers(text, p)}
    comparison = context.get('comparison') or {}
    paths.update(comparison.get('changed_from_input') or [])
    paths.update(comparison.get('changed_from_previous') or [])
    for item in context.get('issue_history') or []:
        if item.get('kind') != 'issue' or item.get('status') != 'OPEN' or item.get('severity') == 'advisory':
            continue
        paths.update(item.get('files') or [])
        paths.update(location.rsplit(':', 1)[0] for location in item.get('locations') or [])
    # Keep the map predicate too: directory guidance may cover files created during this call.
    return {'code_map': text, 'paths': sorted(paths)}


def finding_id(run_id: str, unit_id: str, kind: str, description: str, criterion_ids: list[str]) -> str:
    return kind + '-' + digest({'run_id': run_id, 'unit_id': unit_id, 'kind': kind,
                               'description': description, 'criterion_ids': sorted(criterion_ids)})


def rebind_history(history: list[dict], candidate_hash: str, round_number: int) -> list[dict]:
    result = copy.deepcopy(history)
    for item in result:
        resolution = item.get('resolution') or {}
        if item.get('severity') == 'advisory':
            item['status'] = 'ADVISORY'
        elif item['status'] == 'RESOLVED' and (resolution.get('candidate_hash') != candidate_hash or
                                              resolution.get('round') != round_number):
            item['status'] = 'UNKNOWN'
            item['state_note'] = '新候选/业务轮尚未显式复核；旧解决证据不继承。'
        item.update(state_candidate_hash=candidate_hash, state_round=round_number)
    return result


def record_findings(history: list[dict], report: dict, run_id: str, unit_id: str,
                    round_number: int, candidate_hash: str, accepted_path: str) -> list[dict]:
    result = rebind_history(history, candidate_hash, round_number)
    by_id = {item['id']: item for item in result}
    source = {'round': round_number, 'role': report['role'], 'attempt_id': report['attempt_id'],
              'candidate_hash': candidate_hash, 'report_path': accepted_path}
    findings = [('issue', issue['description'], [issue['criterion_id']], issue, issue['suggested_fix'])
                for issue in report['issues']]
    findings += [('rule_gap', gap, [], gap, '') for gap in report['rule_gaps']]
    for kind, description, criterion_ids, original, fix in findings:
        fid = finding_id(run_id, unit_id, kind, description, criterion_ids)
        occurrence = {'source': copy.deepcopy(source), 'reported': copy.deepcopy(original)}
        if fid not in by_id:
            item = {'id': fid, 'kind': kind, 'description': description, 'criterion_ids': criterion_ids,
                    'suggested_fix': fix, 'source': copy.deepcopy(source), 'occurrences': [],
                    'resolution_attempts': [], 'resolution': None}
            if kind == 'issue':
                item.update(severity=original.get('severity', 'blocking'),
                            counterexample=original.get('counterexample', ''),
                            locations=copy.deepcopy(original.get('locations', [])),
                            spec_refs=copy.deepcopy(original.get('spec_refs', [])))
            result.append(item)
            by_id[fid] = item
        item = by_id[fid]
        if occurrence not in item['occurrences']:
            item['occurrences'].append(occurrence)
        if kind == 'issue':
            for name in ('counterexample', 'locations', 'spec_refs'):
                value = original.get(name)
                valid = (isinstance(value, str) and bool(value.strip()) if name == 'counterexample' else
                         isinstance(value, list) and bool(value) and all(isinstance(v, str) and v.strip() for v in value))
                if valid:
                    item[name] = copy.deepcopy(value)
        if item.get('severity') == 'advisory' or item.get('status') == 'ADVISORY':
            item.update(status='ADVISORY', state_note='建议项，不阻断，交拍板人决定',
                        state_candidate_hash=candidate_hash, state_round=round_number)
            continue
        if item.get('deferred'):
            item.update(status='DEFERRED', state_candidate_hash=candidate_hash, state_round=round_number)
            continue
        item.update(status='OPEN', state_note='已提出；尚无对本候选有效的评审显式解决。',
                    state_candidate_hash=candidate_hash, state_round=round_number)
    return result


def freeze_review(rows: list[dict], report: dict, history: list[dict], known_before: set[str],
                  changed: set[str], unit: dict, gates: dict, run_id: str, unit_id: str,
                  round_number: int) -> tuple[list[dict], list[dict], list[dict], bool]:
    """Issue-list freeze for repair rounds.

    A criterion FAIL keeps blocking only for a failed gate, a known issue that is still not
    resolved, or a new issue touching a file changed this round (a regression). New findings
    about unchanged code are marked DEFERRED: kept for the decision maker, no further repair.
    Returns (rows, history, deferred_items, regression_only). regression_only means every
    blocking FAIL came from new problems in changed files, with nothing known left open.
    """
    rows, history = copy.deepcopy(rows), copy.deepcopy(history)
    by_item = {item['id']: item for item in history}
    criteria = {c['id']: c for c in unit['criteria']}
    deferred, regression_only = [], False
    reasons_seen = []
    for row in rows:
        if row['status'] != 'FAIL':
            continue
        cid = row['id']
        if any(gates.get(g, {}).get('status') == 'FAIL' for g in criteria[cid]['gate_ids']):
            reasons_seen.append('gate')
            continue
        known_open = any(item['kind'] == 'issue' and cid in item['criterion_ids'] and item['id'] in known_before
                         and item['status'] not in ('RESOLVED', 'ADVISORY')
                         and item.get('severity', 'blocking') != 'advisory' and not item.get('deferred') for item in history)
        new_in_scope, new_out = False, []
        for issue in report['issues']:
            if issue['criterion_id'] != cid:
                continue
            fid = finding_id(run_id, unit_id, 'issue', issue['description'], [cid])
            if by_item[fid].get('status') == 'ADVISORY' or by_item[fid].get('severity') == 'advisory':
                continue
            if fid in known_before:
                continue  # re-reported known issue: covered by known_open
            if set(issue.get('files', [])) & changed:
                new_in_scope = True
            else:
                new_out.append(fid)
        if known_open:
            reasons_seen.append('known')
            continue
        if new_in_scope:
            reasons_seen.append('regression')
            continue
        # Only late discoveries about unchanged code: record, do not block.
        for fid in new_out:
            item = by_item[fid]
            item['deferred'] = {'round': round_number, 'files': next(
                (i.get('files', []) for i in report['issues']
                 if finding_id(run_id, unit_id, 'issue', i['description'], [cid]) == fid), [])}
            item.update(status='DEFERRED', state_note=f'第 {round_number} 轮新发现，位于本轮未改动的代码；'
                        '按问题清单冻结规则记为遗留，不触发返修，交拍板人决定。')
            deferred.append(copy.deepcopy(item))
        row['status'] = 'PASS'
        row['note'] += '；问题清单冻结：本轮新发现位于未改动代码，记为遗留，不阻断'
    regression_only = bool(reasons_seen) and set(reasons_seen) == {'regression'}
    return rows, history, deferred, regression_only


def resolution_gates(item: dict, evidence: list[str], unit: dict) -> list[str]:
    # A gap has no criterion mapping: conservatively require all required gates.
    related = [c for c in unit['criteria'] if not item['criterion_ids'] or c['id'] in item['criterion_ids']]
    return sorted({g for c in related for g in c['gate_ids']} |
                  {ref[5:] for ref in evidence if ref.startswith('gate:')})


def apply_resolutions(history: list[dict], report: dict, unit: dict, gates: dict,
                      candidate_hash: str, round_number: int, accepted_path: str,
                      evidence_index: dict) -> list[dict]:
    result = rebind_history(history, candidate_hash, round_number)
    by_id = {item['id']: item for item in result}
    for proposed in report.get('issue_resolutions', []):
        if report['role'] != 'reviewer' or proposed['id'] not in by_id or not proposed['evidence']:
            raise LoopError('仅评审能用当前证据显式解决已知问题 ID')
        item = by_id[proposed['id']]
        if item.get('status') == 'ADVISORY' or item.get('severity') == 'advisory':
            raise LoopError('建议项不需要关闭；请从 issue_resolutions 移除该 ADVISORY 项，交拍板人决定')
        bound = {ref: copy.deepcopy(evidence_index[ref]) for ref in proposed['evidence'] if ref in evidence_index}
        if len(bound) != len(set(proposed['evidence'])) or any(e.get('candidate_hash') != candidate_hash for e in bound.values()):
            raise LoopError('问题解决证据未绑定当前候选')
        checks = {gid: {'status': gates.get(gid, {}).get('status', 'UNKNOWN'),
                        'candidate_hash': gates.get(gid, {}).get('candidate_hash')}
                  for gid in resolution_gates(item, proposed['evidence'], unit)}
        barriers = {gid: (g['status'] if g['candidate_hash'] == candidate_hash else 'UNKNOWN')
                    for gid, g in checks.items()
                    if g['status'] != 'PASS' or g['candidate_hash'] != candidate_hash}
        applied = not barriers
        decision = {**copy.deepcopy(proposed), 'round': round_number, 'role': report['role'],
                    'attempt_id': report['attempt_id'], 'report_path': accepted_path,
                    'candidate_hash': candidate_hash, 'evidence_index': bound, 'gate_checks': checks,
                    'applied': applied, 'reason': '评审显式解决，证据绑定当前候选。' if applied else
                        '解决未生效；关联门禁未有效通过：' + json.dumps(barriers, ensure_ascii=False)}
        item['resolution_attempts'].append(decision)
        item.update(status='RESOLVED' if applied else ('OPEN' if 'FAIL' in barriers.values() else 'UNKNOWN'),
                    state_note=decision['reason'])
        if applied:
            item['resolution'] = copy.deepcopy(decision)
    return result


def rule_gaps(history: list[dict], *, historical: bool = False) -> list[str]:
    return sorted({item['description'] for item in history if item['kind'] == 'rule_gap' and
                   (historical or item['status'] != 'RESOLVED')})
