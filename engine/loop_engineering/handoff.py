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


def finding_id(run_id: str, unit_id: str, kind: str, description: str, criterion_ids: list[str]) -> str:
    return kind + '-' + digest({'run_id': run_id, 'unit_id': unit_id, 'kind': kind,
                               'description': description, 'criterion_ids': sorted(criterion_ids)})


def rebind_history(history: list[dict], candidate_hash: str, round_number: int) -> list[dict]:
    result = copy.deepcopy(history)
    for item in result:
        resolution = item.get('resolution') or {}
        if item['status'] == 'RESOLVED' and (resolution.get('candidate_hash') != candidate_hash or
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
            result.append(item)
            by_id[fid] = item
        item = by_id[fid]
        if occurrence not in item['occurrences']:
            item['occurrences'].append(occurrence)
        item.update(status='OPEN', state_note='已提出；尚无对本候选有效的评审显式解决。',
                    state_candidate_hash=candidate_hash, state_round=round_number)
    return result


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
        bound = {ref: copy.deepcopy(evidence_index[ref]) for ref in proposed['evidence'] if ref in evidence_index}
        if len(bound) != len(set(proposed['evidence'])) or any(e.get('candidate_hash') != candidate_hash for e in bound.values()):
            raise LoopError('问题解决证据未绑定当前候选')
        item = by_id[proposed['id']]
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
