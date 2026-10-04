"""Read bounded optional member projections and aggregate without inventing coverage.

Invocation budget counters stay in storage. Missing telemetry is not an execution
failure, and an observed subtotal is never substituted for an unknown total.
"""
from __future__ import annotations
from pathlib import Path
import math

from .common import LoopError, load_json
from .pi_events import TOKEN_FIELDS, number

PROJECTION_BYTES = 256 * 1024
READ_COUNTS = ('reads', 'distinct_files', 'repeat_reads', 'cross_reads')


def tool_counts(value):
    return isinstance(value, dict) and all(isinstance(k, str) and k and type(v) is int and v >= 0
                                          for k, v in value.items())


def read_paths(value):
    return isinstance(value, list) and all(isinstance(p, dict) and isinstance(p.get('path'), str)
                                         and p['path'] and type(p.get('outside')) is bool for p in value)


def read_observation(workspace: Path) -> dict:
    result = {'activity': None, 'usage': None, 'errors': []}
    for name in ('activity', 'usage'):
        path = workspace / (name + '.json')
        if not path.exists() and not path.is_symlink():
            continue
        try:
            value = load_json(path, PROJECTION_BYTES)
            if not isinstance(value, dict):
                raise ValueError('projection is not an object')
            if name == 'activity':
                if not isinstance(value.get('phase'), str) or not (
                        value.get('last_event_at') is None or isinstance(value['last_event_at'], str)):
                    raise ValueError('invalid activity fields')
            else:
                tokens = value.get('tokens')
                if not isinstance(tokens, dict):
                    raise ValueError('invalid token dimensions')
                value = {**value, 'tokens': {key: tokens.get(key) for key in TOKEN_FIELDS}}
                for field in ('assistant_messages', 'tool_calls'):
                    value.setdefault(field, None)
                if any(x is not None and not number(x) for x in
                       [value['assistant_messages'], value['tool_calls'], *value['tokens'].values()]):
                    raise ValueError('invalid usage numbers')
                # Bad optional cost dimensions do not erase existing token coverage.
                checks = {**{field: lambda x: type(x) is int and x >= 0 for field in READ_COUNTS},
                          'tools_by_name': tool_counts, 'read_paths': read_paths}
                for field, valid in checks.items():
                    value.setdefault(field, None)
                    if value[field] is not None and not valid(value[field]):
                        result['errors'].append('usage.' + field + ': 无效的成本统计，保留为未知')
                        value[field] = None
                # No current adapter verifies bottom-level HTTP completeness or account prices.
                value.update(api_requests=None, cost=None)
            result[name] = value
        except (LoopError, OSError, ValueError, TypeError, RecursionError) as exc:
            result['errors'].append(name + ': ' + str(exc)[:300])
    return result


def summarize(records: list[dict], expected: int | None) -> dict:
    usages = [r.get('usage') for r in records]
    receipts = [r.get('receipt') for r in records]
    complete = expected is not None and len(records) == expected
    def sum_field(values, signed=False):
        valid = lambda x: number(x) or (signed and isinstance(x, float) and math.isfinite(x)) or (
            signed and isinstance(x, int) and not isinstance(x, bool))
        known = [x for x in values if valid(x)]
        try:
            total = sum(known)
            if not valid(total):
                total = None
        except OverflowError:
            total = None
        return (total if complete and len(known) == expected else None,
                {'known_processes': len(known), 'expected_processes': expected,
                 'observed_total': total if known else None})
    usage, coverage = {}, {}
    for field in ('assistant_messages', 'tool_calls', *READ_COUNTS):
        values = [u.get(field) if u else None for u in usages]
        usage[field], coverage[field] = sum_field(values)
    tools = [u.get('tools_by_name') if u else None for u in usages]
    known_tools = [t for t in tools if isinstance(t, dict) and tool_counts(t)]
    totals = {}
    for counts in known_tools:
        for name, count in counts.items():
            totals[name] = totals.get(name, 0) + count
    usage['tools_by_name'] = totals if complete and expected and len(known_tools) == expected else None
    coverage['tools_by_name'] = {'known_processes': len(known_tools), 'expected_processes': expected,
                                 'observed_total': totals if known_tools else None}
    usage['tokens'], coverage['tokens'] = {}, {}
    for key in TOKEN_FIELDS:
        values = [(u.get('tokens') or {}).get(key) if u else None for u in usages]
        usage['tokens'][key], coverage['tokens'][key] = sum_field(values)
    if expected == 0:
        # No invocation is known, but no model meter exists either.
        usage.update(assistant_messages=None, tool_calls=None, tokens=dict.fromkeys(TOKEN_FIELDS),
                     **dict.fromkeys(READ_COUNTS))
    usage.update(api_requests=None, cost=None)
    coverage.update(source='member usage projections, including failed/retried attempts',
                    api_requests='unknown: model rounds are not complete HTTP request counts',
                    cost='unknown: provider estimates/zero are not verified account charges',
                    scope='assistant message_end only; summarization and hidden usage excluded',
                    usage_reports=sum(u is not None for u in usages), expected_processes=expected)
    usage['coverage'] = coverage
    process = {'process_invocations': expected, 'recorded_attempts': len(records),
               'receipt_count': sum(r is not None for r in receipts),
               'timing_discrepancy': any((r or {}).get('timing_discrepancy') is True for r in receipts),
               'scope': 'sum of command guardian spans, not engine end-to-end time or model-only latency',
               'coverage': {}}
    for field in ('elapsed_seconds', 'wall_elapsed_seconds'):
        process[field], process['coverage'][field] = sum_field([(r or {}).get(field) for r in receipts],
                                                             signed=field == 'wall_elapsed_seconds')
    return {'usage': usage, 'processes': process}


def cost_sessions(records: list[dict]) -> list[dict]:
    """Finalize one unit's observations; never reparse retained raw events."""
    ordered = sorted(enumerate(records), key=lambda pair:
                     pair[1]['call_order'] if type(pair[1].get('call_order')) is int else pair[0])
    sessions, seen, prior_known = [], set(), True
    for _, record in ordered:
        usage = record.get('usage')
        paths = usage.get('read_paths') if isinstance(usage, dict) else None
        known = read_paths(paths)
        keys = {(p['outside'], p['path']) for p in paths} if isinstance(paths, list) and known else set()
        cross_reads = len(keys & seen) if known and prior_known else None
        if isinstance(usage, dict):
            usage['cross_reads'] = cross_reads
        seen.update(keys)
        prior_known = prior_known and known
        u, receipt = usage or {}, record.get('receipt') or {}
        session = {'attempt_id': record.get('attempt_id'), 'role': record.get('role'),
                   'round': record.get('round'), 'elapsed_seconds': receipt.get('elapsed_seconds'),
                   'code_map_provided': record.get('code_map_provided'),
                   'off_map_reads': record.get('off_map_reads'), 'off_map_status': record.get('off_map_status', 'unknown')}
        session.update({field: u.get(field) for field in ('assistant_messages', 'tool_calls', *READ_COUNTS)})
        session.update({key: (u.get('tokens') or {}).get(key) for key in ('input', 'cache_read', 'output')})
        sessions.append(session)
    return sessions


def engine_summary(data: dict) -> dict:
    records = [r for state in data.get('units', {}).values()
               for r in state.get('member_observations', {}).values()]
    result = data.get('result') or {}
    expected = result.get('member_invocations', (data.get('budget') or {}).get('member_invocations'))
    return summarize(records, expected)


def timing_fields(begin: float, wall_begin: float, current: float, wall_current: float) -> dict:
    elapsed, wall = round(current - begin, 3), round(wall_current - wall_begin, 3)
    difference = round(abs(wall - elapsed), 3)
    discrepancy = difference > 2
    return {'elapsed_seconds': elapsed, 'wall_elapsed_seconds': wall,
            'timing_discrepancy': discrepancy, 'timing_difference_seconds': difference,
            'timing_note': 'Both cover the guardian command span (launch, execution, draining, cleanup). '
                           'elapsed_seconds uses monotonic; wall_elapsed_seconds uses epoch wall clock. '
                           + ('Difference exceeds 2 seconds; clock/scheduling/suspend behavior is not diagnosed; '
                              'do not attribute it directly to the model.' if discrepancy else
                              'No difference over 2 seconds; neither is model-only time.')}
