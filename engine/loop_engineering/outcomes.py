"""Trusted adapter/guardian control protocol. Model text is never a control input."""
from __future__ import annotations
import json
import os
import time

PROTOCOL = 'loop-outcome-v1'
REASONS = frozenset({'ok', 'nonzero_exit', 'launch_error', 'collector_error', 'invalid_response',
                    'response_limit', 'event_limit', 'log_limit', 'timeout', 'idle_timeout',
                    'cancelled', 'controller_lost', 'config_error', 'output_violation',
                    'disk_limit', 'evidence_limit', 'build_limit', 'sandbox_unavailable',
                    'transient_service_error', 'adapter_protocol_error', 'guardian_error'})
CONTROL_ENV = ('LOOP_CONTROL_FD', 'LOOP_CONTROL_NONCE')
# Unknown nonzero exits are deliberately NOT retryable. No stderr keyword guessing.
RETRYABLE = frozenset({'transient_service_error'})


def emit(kind: str, **fields) -> None:
    fd, nonce = os.environ.get(CONTROL_ENV[0]), os.environ.get(CONTROL_ENV[1])
    if fd is None or not nonce:
        return
    record = {'protocol': PROTOCOL, 'nonce': nonce, 'kind': kind, **fields}
    body = (json.dumps(record, ensure_ascii=False, separators=(',', ':'), allow_nan=False) + '\n').encode()
    if len(body) > 4096:
        return
    try:
        os.write(int(fd), body)
    except (OSError, ValueError):
        pass  # A missing control channel is rejected by the guardian, never upgraded to success.


def clean_child_env(env: dict) -> dict:
    return {k: v for k, v in env.items() if k not in CONTROL_ENV}


def decode(line: bytes, nonce: str) -> dict:
    from .pi_events import parse_json
    value = parse_json(line.decode('utf-8'))
    if not isinstance(value, dict) or value.get('protocol') != PROTOCOL or value.get('nonce') != nonce:
        raise ValueError('control identity mismatch')
    if value.get('kind') not in ('activity', 'outcome'):
        raise ValueError('unknown control kind')
    if value['kind'] == 'outcome':
        if value.get('reason') not in REASONS or type(value.get('exit_code')) not in (int, type(None)):
            raise ValueError('invalid outcome')
    return value
