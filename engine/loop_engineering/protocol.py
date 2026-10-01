"""Only valid, current reports may cross a develop/review boundary."""
from __future__ import annotations
from pathlib import Path
from .common import LoopError, safe_child
from .rules import fields, text

STATUSES = ('PASS', 'FAIL', 'UNKNOWN')


def response_schema() -> dict:
    def obj(properties):
        return {'type': 'object', 'properties': properties, 'required': list(properties), 'additionalProperties': False}
    s = {'type': 'string'}
    arr = lambda x: {'type': 'array', 'items': x}
    return obj({
        'attempt_id': s, 'role': {'type': 'string', 'enum': ['developer', 'reviewer']},
        'candidate_hash': s, 'summary': s, 'blocked': {'type': 'boolean'},
        'criteria': arr(obj({'id': s, 'status': {'type': 'string', 'enum': list(STATUSES)},
                             'note': s, 'evidence': arr(s)})),
        'issues': arr(obj({'criterion_id': s, 'description': s, 'suggested_fix': s})),
        'rule_gaps': arr(s),
    })


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
    for row in report['criteria']:
        fields(row, ['id', 'status', 'note', 'evidence'], ['id', 'status', 'note', 'evidence'], '标准结论')
        if not isinstance(row['id'], str) or row['id'] in received or row['id'] not in expected:
            raise LoopError('标准 ID 未知或重复')
        received.add(row['id'])
        if row['status'] not in STATUSES:
            raise LoopError('标准状态必须是 PASS / FAIL / UNKNOWN')
        text(row['note'], 'criterion.note')
        if not isinstance(row['evidence'], list) or any(not isinstance(e, str) for e in row['evidence']):
            raise LoopError('evidence 必须是字符串数组')
        if row['status'] == 'PASS' and not row['evidence']:
            raise LoopError('PASS 必须给出当前成果的证据引用')
        for evidence in row['evidence']:
            if evidence.startswith('code:'):
                p = safe_child(code, evidence[5:])
                if not p.is_file():
                    raise LoopError(f'证据文件不存在：{evidence}')
            elif evidence.startswith('gate:'):
                if context['role'] != 'reviewer' or evidence[5:] not in gates:
                    raise LoopError(f'门禁证据不存在：{evidence}')
            else:
                raise LoopError('证据只接受 code:项目内文件 或 gate:门禁ID，不接受其他运行路径或网址')
    if received != expected:
        raise LoopError(f'缺少标准：{sorted(expected - received)}')
    if not isinstance(report['issues'], list):
        raise LoopError('issues 必须是数组')
    for issue in report['issues']:
        fields(issue, ['criterion_id', 'description', 'suggested_fix'],
               ['criterion_id', 'description', 'suggested_fix'], '修复项')
        if issue['criterion_id'] not in expected:
            raise LoopError('修复项不得引入冻结规则之外的完成标准')
        text(issue['description'], 'issue.description')
        text(issue['suggested_fix'], 'issue.suggested_fix')
    if not isinstance(report['rule_gaps'], list) or any(not isinstance(g, str) or not g.strip() for g in report['rule_gaps']):
        raise LoopError('rule_gaps 必须是文字数组')
    if report['blocked'] and not report['rule_gaps']:
        raise LoopError('blocked=true 必须说明无法继续的规则缺口')
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
