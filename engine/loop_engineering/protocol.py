"""Only valid, current reports may cross a develop/review boundary."""
from __future__ import annotations
import os
from pathlib import Path
import stat
from .common import LoopError, relative_path, safe_child
from .rules import fields, text

STATUSES = ('PASS', 'FAIL', 'UNKNOWN')


def response_schema() -> dict:
    def obj(properties):
        return {'type': 'object', 'properties': properties, 'required': list(properties), 'additionalProperties': False}
    s = {'type': 'string'}
    arr = lambda x: {'type': 'array', 'items': x}
    schema = obj({
        'attempt_id': s, 'role': {'type': 'string', 'enum': ['developer', 'reviewer']},
        'candidate_hash': s, 'summary': s, 'blocked': {'type': 'boolean'},
        'criteria': arr(obj({'id': s, 'status': {'type': 'string', 'enum': list(STATUSES)},
                             'note': s, 'evidence': arr(s)})),
        'issues': arr(obj({'criterion_id': s, 'description': s, 'suggested_fix': s})),
        'rule_gaps': arr(s),
    })
    # Optional for backward compatibility; old reports remain valid unchanged.
    schema['properties']['issue_resolutions'] = arr(obj({'id': s, 'note': s, 'evidence': arr(s)}))
    # Optional: project-relative files an issue is about. Required for reviewers from round 2
    # of a frozen-scope v2 unit, so the engine can tell regressions from late discoveries.
    schema['properties']['issues']['items']['properties']['files'] = arr(s)
    return schema


def frozen_scope(context: dict) -> bool:
    return (bool(context.get('managed_tools')) and context['role'] == 'reviewer' and context.get('round', 1) >= 2
            and context['unit'].get('review_scope', 'frozen') == 'frozen')


def scratch_file(root: Path, relative: str) -> Path:
    """Reject links in every path component, even links pointing inside the root."""
    relative_path(relative)
    current = root
    if root.is_symlink() or not root.is_dir():
        raise LoopError('取证目录不存在或是符号链接')
    for part in Path(relative).parts:
        current = current / part
        if current.is_symlink():
            raise LoopError(f'取证引用不接受符号链接：{relative}')
    # Reject links before resolving: a looping intermediate link makes resolve()
    # raise RuntimeError on Python 3.12, bypassing delivery-format retries.
    path = safe_child(root, relative)
    if not path.is_file():
        raise LoopError(f'取证引用必须指向已存在的普通文件：{relative}')
    return path


def report_scratch(context: dict) -> Path | None:
    if context['role'] != 'reviewer' or not context['unit'].get('reviewer_exec', False):
        return None
    value = context.get('scratch_path')
    if not isinstance(value, str) or not value:
        raise LoopError('缺少评审方取证目录')
    root = Path(value)
    try:
        if root.is_symlink() or not root.is_dir():
            raise LoopError('取证目录不存在或是符号链接')
        size = 0
        def scan_error(exc):
            raise exc
        # No source/cache exclusions: unreferenced regular files count too.
        for base, _, files in os.walk(root, followlinks=False, onerror=scan_error):
            for name in files:
                info = (Path(base) / name).lstat()
                if stat.S_ISREG(info.st_mode):
                    size += info.st_size
                    if size > context['limits'].get('max_evidence_bytes', context['limits']['max_log_bytes']):
                        raise LoopError('取证目录普通文件总大小超过 limits.max_log_bytes')
    except OSError as exc:
        raise LoopError(f'取证目录无法核对：{exc}') from exc
    return root


def validate_evidence(evidence: list[str], context: dict, code: Path, gates: dict,
                      scratch: Path | None, *, resolution: bool = False) -> None:
    if not isinstance(evidence, list) or any(not isinstance(e, str) for e in evidence):
        raise LoopError('evidence 必须是字符串数组')
    for ref in evidence:
        if ref.startswith('code:'):
            if not safe_child(code, ref[5:]).is_file():
                raise LoopError(f'证据文件不存在：{ref}')
        elif ref.startswith('gate:'):
            if context['role'] != 'reviewer' or ref[5:] not in gates:
                raise LoopError(f'门禁证据不存在：{ref}')
            if resolution and gates[ref[5:]].get('candidate_hash') != context['candidate_hash']:
                raise LoopError(f'问题解决不得使用旧候选门禁证据：{ref}')
        elif ref.startswith('scratch:'):
            if scratch is None:
                raise LoopError('取证引用仅允许开启 reviewer_exec 的评审方使用')
            try:
                scratch_file(scratch, ref[8:])
            except OSError as exc:
                raise LoopError(f'取证文件无法核对：{ref}: {exc}') from exc
        else:
            raise LoopError('证据只接受本次允许的文件或门禁引用，不接受其他运行路径或网址')


def validate_report(report: dict, context: dict, code: Path, gates: dict) -> dict:
    fields(report, response_schema()['properties'], response_schema()['required'], '成员交付')
    if report['attempt_id'] != context['attempt_id'] or report['role'] != context['role']:
        raise LoopError('过期或错误成员交付：attempt_id / role 不匹配')
    expected_hash = context['candidate_hash'] if context['role'] == 'reviewer' else ''
    if report['candidate_hash'] != expected_hash:
        raise LoopError('candidate_hash 不匹配；开发方填空字符串，评审方填写上下文里的完整指纹')
    if type(report['blocked']) is not bool:
        raise LoopError('blocked 必须是布尔值')
    text(report['summary'], 'summary')
    if not isinstance(report['criteria'], list):
        raise LoopError('criteria 必须是数组')
    expected = {c['id'] for c in context['unit']['criteria']}
    received = set()
    scratch = report_scratch(context)
    for row in report['criteria']:
        fields(row, ['id', 'status', 'note', 'evidence'], ['id', 'status', 'note', 'evidence'], '标准结论')
        if not isinstance(row['id'], str) or row['id'] in received or row['id'] not in expected:
            raise LoopError('标准 ID 未知或重复')
        received.add(row['id'])
        if row['status'] not in STATUSES:
            raise LoopError('标准状态必须是 PASS / FAIL / UNKNOWN')
        text(row['note'], 'criterion.note')
        validate_evidence(row['evidence'], context, code, gates, scratch)
        if row['status'] == 'PASS' and not row['evidence']:
            raise LoopError('PASS 必须给出当前成果的证据引用')
    if received != expected:
        raise LoopError(f'缺少标准：{sorted(expected - received)}')
    if not isinstance(report['issues'], list):
        raise LoopError('issues 必须是数组')
    frozen = frozen_scope(context)
    for issue in report['issues']:
        fields(issue, ['criterion_id', 'description', 'suggested_fix', 'files'],
               ['criterion_id', 'description', 'suggested_fix'], '修复项')
        if issue['criterion_id'] not in expected:
            raise LoopError('修复项不得引入冻结规则之外的完成标准')
        text(issue['description'], 'issue.description')
        text(issue['suggested_fix'], 'issue.suggested_fix')
        files = issue.get('files', [])
        if not isinstance(files, list) or any(not isinstance(f, str) for f in files):
            raise LoopError('issue.files 必须是项目内相对路径数组')
        for f in files:
            relative_path(f)
        if frozen and not files:
            raise LoopError('第 2 轮起评审提出的每个问题都必须在 issue.files 写明相关文件（项目内相对路径）')
    if frozen:
        # A blocking FAIL must point at something: a failed gate, an open known issue, or an
        # issue in this report. Otherwise nothing tells the developer what to repair.
        open_known = {cid for item in context.get('issue_history', [])
                      if item.get('kind') == 'issue' and item.get('status') != 'RESOLVED' and not item.get('deferred')
                      for cid in item.get('criterion_ids', [])}
        reported = {issue['criterion_id'] for issue in report['issues']}
        by_id = {c['id']: c for c in context['unit']['criteria']}
        for row in report['criteria']:
            gate_failed = any(gates.get(g, {}).get('status') == 'FAIL' for g in by_id[row['id']]['gate_ids'])
            if row['status'] == 'FAIL' and not gate_failed and row['id'] not in open_known | reported:
                raise LoopError(f'标准 {row["id"]} 判 FAIL 但没有对应的问题：请在 issues 写明问题与 files，'
                                '或说明哪个已知问题仍未解决')
    if not isinstance(report['rule_gaps'], list) or any(not isinstance(g, str) or not g.strip() for g in report['rule_gaps']):
        raise LoopError('rule_gaps 必须是文字数组')
    if report['blocked'] and not report['rule_gaps']:
        raise LoopError('blocked=true 必须说明无法继续的规则缺口')
    resolutions = report.get('issue_resolutions', [])
    if not isinstance(resolutions, list):
        raise LoopError('issue_resolutions 必须是数组')
    if resolutions and context['role'] != 'reviewer':
        raise LoopError('开发方不得声明解决历史问题；仅评审能显式关项')
    known = {item['id'] for item in context.get('issue_history', [])}
    resolved = set()
    for resolution in resolutions:
        fields(resolution, ['id', 'note', 'evidence'], ['id', 'note', 'evidence'], '问题解决')
        if not isinstance(resolution['id'], str) or resolution['id'] not in known or resolution['id'] in resolved:
            raise LoopError('问题解决 ID 未知或重复')
        resolved.add(resolution['id'])
        text(resolution['note'], 'issue_resolution.note')
        validate_evidence(resolution['evidence'], context, code, gates, scratch, resolution=True)
        if not resolution['evidence']:
            raise LoopError('问题解决必须提供当前候选有效证据')
    return report


def evaluate(report: dict, unit: dict, gates: dict) -> list[dict]:
    by_id = {r['id']: r for r in report['criteria']}
    result = []
    for criterion in unit['criteria']:
        row = dict(by_id[criterion['id']])
        row['review_status'] = row['status']
        row['evidence'] = list(row['evidence'])
        failures = [g for g in criterion['gate_ids'] if gates[g]['status'] == 'FAIL']
        unknown = [g for g in criterion['gate_ids'] if gates[g]['status'] == 'UNKNOWN']
        if failures:
            row['status'] = 'FAIL'
            row['note'] += '；程序门禁失败：' + ', '.join(failures)
        elif unknown:
            row['status'] = 'UNKNOWN'
            row['note'] += '；程序门禁无法判断：' + ', '.join(unknown)
        row['evidence'] = sorted(set(row['evidence'] + ['gate:' + g for g in criterion['gate_ids']]))
        result.append(row)
    return result
