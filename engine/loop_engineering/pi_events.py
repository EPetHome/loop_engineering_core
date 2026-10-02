"""Bounded Pi 0.87 JSONL projection. Deltas are activity, never a delivery.

Only LF frames records (U+2028/U+2029 in JSON strings are ordinary data).
The caller bounds the *combined* raw stdout/stderr and owns process deadlines.
"""
from __future__ import annotations

from datetime import datetime, timezone
import json
import math
from pathlib import Path

from .common import atomic_json

TOKEN_FIELDS = {'input': 'input', 'output': 'output',
                'cache_read': 'cacheRead', 'cache_write': 'cacheWrite'}


class EventError(Exception):
    def __init__(self, reason: str, message: str):
        self.reason = reason
        super().__init__(message)


def number(value):
    if isinstance(value, bool):
        return False
    if isinstance(value, int):
        return value >= 0
    return isinstance(value, float) and math.isfinite(value) and value >= 0


def parse_json(text):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError('duplicate JSON key: ' + key)
            result[key] = value
        return result
    return json.loads(text, object_pairs_hook=pairs,
                      parse_constant=lambda x: (_ for _ in ()).throw(ValueError(x)))


def extract_json(text: str):
    """Keep the existing wrapper's fence/preamble compatibility, not event extraction."""
    body = text.strip()
    if body.startswith('```'):
        # Do not split on Unicode separators, even in a legacy text response.
        lines = body.split('\n')[1:]
        if lines and lines[-1].strip().startswith('```'):
            lines.pop()
        body = '\n'.join(lines).strip()
    candidates = [body]
    start, end = body.find('{'), body.rfind('}')
    if start != -1 and end > start:
        candidates.append(body[start:end + 1])
    for candidate in candidates:
        try:
            value = parse_json(candidate)
        except (ValueError, RecursionError):
            continue
        if isinstance(value, dict):
            return value
    return None


class PiEvents:
    def __init__(self, workspace: Path | None, max_bytes: int):
        self.workspace, self.max_bytes = workspace, max_bytes
        self.buffer, self.legacy = bytearray(), bytearray()
        self.raw = None
        self.event_mode, self.invalid_prefix, self.invalid = False, False, False
        self.messages, self.tool_ids, self.active_tools = 0, set(), {}
        self.unmatched_tools = False
        self.token_totals = dict.fromkeys(TOKEN_FIELDS, 0)
        self.token_known = dict.fromkeys(TOKEN_FIELDS, 0)
        self.retries, self.compactions = 0, 0
        self.candidate, self.settled = None, False
        self.pending_work = False
        self.compaction_reason = None
        self.activity = {'phase': 'unknown', 'basis': None, 'last_event_at': None,
                         'last_event_type': None, 'running': True, 'tool_calls': [],
                         'note': 'No event evidence yet; phase is the last observed stage, not a liveness claim.'}
        if workspace is not None:
            workspace.mkdir(parents=True, exist_ok=True)
            path = workspace / 'pi-events.jsonl'
            if path.is_symlink():
                raise EventError('collector_error', 'refusing symlink pi-events.jsonl')
            self.raw = path.open('wb')
            activity_path = workspace / 'activity.json'
            if activity_path.is_symlink():
                self.raw.close()
                raise EventError('collector_error', 'refusing symlink activity.json')
            # A repeated independent invocation must not expose a prior run's event.
            activity_path.unlink(missing_ok=True)
        self.persist()

    def usage(self):
        tokens = {key: self.token_totals[key] if self.messages and self.token_known[key] == self.messages
                  else None for key in TOKEN_FIELDS}
        return {'assistant_messages': self.messages if self.event_mode else None,
                'tool_calls': len(self.tool_ids) if self.event_mode and not self.unmatched_tools else None,
                'tokens': tokens, 'api_requests': None, 'cost': None,
                'coverage': {
                    'source': 'message_end' if self.event_mode else 'no_jsonl_events',
                    'assistant_messages': 'observed message_end records only',
                    'tool_calls': 'unique toolCallId at execution_start; unmatched lifecycle makes count unknown',
                    'tokens': {key: {'known_messages': self.token_known[key],
                                     'observed_messages': self.messages,
                                     'observed_total': self.token_totals[key] if self.token_known[key] else None}
                               for key in TOKEN_FIELDS},
                    'api_requests': 'unknown: assistant turns do not expose all HTTP requests/retries',
                    'cost': 'unknown: provider prices, including reported zero, are not verified account charges',
                    'scope': 'assistant message_end usage only; hidden requests and compaction/branch-summary usage excluded',
                    'retry_events': self.retries, 'compaction_events': self.compactions,
                    'stream_valid': not self.invalid,
                    'finish_reason': self.activity.get('finish_reason'),
                    'final_response_settled': self.settled,
                }}

    def persist(self):
        self.activity['tool_calls'] = [{'toolCallId': key, 'toolName': name}
                                       for key, name in self.active_tools.items()]
        if self.workspace is not None:
            # A live activity file starts at the first event, not at process launch.
            # Absence before then is unknown; a text-only/failed call gets a final
            # unknown record. This avoids presenting an empty event as activity.
            if self.activity['last_event_at'] or not self.activity['running']:
                atomic_json(self.workspace / 'activity.json', self.activity)
            atomic_json(self.workspace / 'usage.json', self.usage())

    def phase(self, phase, basis):
        self.activity.update(phase=phase, basis=basis)

    def new_work(self):
        self.candidate, self.settled = None, False
        self.pending_work = True

    def event(self, event):
        kind = event['type']
        self.activity.update(last_event_at=datetime.now(timezone.utc).isoformat(), last_event_type=kind)
        if kind in ('agent_start', 'turn_start'):
            self.new_work()
            self.phase('waiting', kind)
        elif kind == 'message_start' and (event.get('message') or {}).get('role') in ('assistant', 'user'):
            self.new_work()
            self.phase('waiting', kind)
        elif kind == 'message_update':
            self.new_work()
            self.phase('responding', kind)
        elif kind == 'message_end':
            message = event.get('message') or {}
            if message.get('role') == 'assistant':
                self.messages += 1
                usage = message.get('usage') or {}
                for key, source in TOKEN_FIELDS.items():
                    value = usage.get(source)
                    if number(value):
                        try:
                            total = self.token_totals[key] + value
                            if number(total):
                                self.token_totals[key] = total
                                self.token_known[key] += 1
                        except OverflowError:
                            pass  # Unrepresentable totals are incomplete, not zero.
                self.candidate, self.settled = None, False
                self.pending_work = message.get('stopReason') != 'stop'
                content = message.get('content')
                if message.get('stopReason') == 'stop' and isinstance(content, list):
                    texts = [block['text'] for block in content if isinstance(block, dict)
                             and block.get('type') == 'text' and isinstance(block.get('text'), str)]
                    self.candidate = ''.join(texts) or None
                self.phase('waiting' if self.candidate else 'unknown', kind)
            elif message.get('role') == 'user':
                self.new_work()
                self.phase('waiting', kind)
        elif kind == 'queue_update' and (event.get('steering') or event.get('followUp')):
            self.new_work()
            self.phase('waiting', kind)
        elif kind.startswith('tool_execution_'):
            # Every lifecycle event is later work, even without a usable/matched
            # ID. Neither an end nor agent_settled can resurrect an old reply;
            # only a subsequent completed assistant message can be a candidate.
            self.new_work()
            call_id = event.get('toolCallId')
            if not isinstance(call_id, str) or not call_id:
                self.unmatched_tools = True
                self.phase('unknown', 'tool event lacks toolCallId')
            elif kind == 'tool_execution_start':
                self.tool_ids.add(call_id)
                self.active_tools[call_id] = event.get('toolName')
                self.phase('tools', kind)
            elif call_id not in self.active_tools:
                self.unmatched_tools = True
                self.phase('unknown', 'unmatched toolCallId: ' + call_id)
            elif kind == 'tool_execution_end':
                del self.active_tools[call_id]
                self.phase('tools' if self.active_tools else 'waiting', kind)
            else:
                self.phase('tools', kind)
        elif kind == 'auto_retry_start':
            self.new_work()
            self.retries += 1
            self.phase('waiting', kind)
        elif kind in ('summarization_retry_scheduled', 'summarization_retry_attempt_start'):
            # A summary request can retry without rerunning the completed turn.
            if self.compaction_reason is None or (kind == 'summarization_retry_attempt_start' and
                    (event.get('source') != 'compaction' or event.get('reason') != self.compaction_reason)):
                self.new_work()
            self.retries += 1
            self.phase('waiting', kind)
        elif kind == 'auto_retry_end':
            if event.get('success') is False:
                self.new_work()
                self.phase('unknown', kind)
        elif kind == 'compaction_start':
            if self.compaction_reason is not None:
                self.new_work()  # Overlapping maintenance cannot certify an old reply.
            self.compaction_reason = event.get('reason') or 'unknown'
            self.settled = False
            self.compactions += 1
            self.phase('waiting', kind)
        elif kind == 'compaction_end':
            result = event.get('result')
            completed = (self.compaction_reason in ('threshold', 'overflow', 'manual')
                         and event.get('reason') == self.compaction_reason
                         and event.get('aborted') is False and event.get('willRetry') is False
                         and event.get('errorMessage') is None and isinstance(result, dict)
                         and isinstance(result.get('summary'), str)
                         and isinstance(result.get('firstKeptEntryId'), str)
                         and number(result.get('tokensBefore')))
            self.compaction_reason = None
            self.settled = False
            if not completed:
                self.new_work()
            self.phase('waiting' if event.get('result') else 'unknown', kind)
        elif kind == 'agent_end':
            if event.get('willRetry') is True:
                self.new_work()
            self.phase('waiting', kind)
        elif kind == 'agent_settled':
            self.settled = bool(self.candidate and not self.pending_work and not self.active_tools
                                and self.compaction_reason is None)
            self.phase('completed' if self.settled else 'unknown', kind)
        elif kind not in ('session', 'turn_end', 'queue_update', 'entry_appended',
                          'session_info_changed', 'thinking_level_changed', 'summarization_retry_finished'):
            self.phase('unknown', kind)
        self.persist()

    def record(self, line: bytes):
        try:
            value = parse_json(line.decode('utf-8'))
        except (ValueError, UnicodeError, RecursionError):
            value = None
        if isinstance(value, dict) and isinstance(value.get('type'), str):
            if not self.event_mode:
                self.event_mode = True
                self.invalid = self.invalid_prefix
                self.legacy.clear()
            try:
                self.event(value)
            except (TypeError, AttributeError, KeyError, ValueError) as exc:
                self.invalid = True
                self.new_work()
                self.phase('unknown', 'invalid event shape: ' + type(exc).__name__)
                self.persist()
        elif line.strip():
            if self.event_mode:
                self.invalid = True
                self.new_work()
                self.phase('unknown', 'invalid JSONL record')
                self.persist()
            else:
                self.invalid_prefix = True

    def feed(self, data: bytes):
        if self.raw:
            self.raw.write(data)
            self.raw.flush()
        if not self.event_mode:
            if len(self.legacy) + len(data) > self.max_bytes:
                raise EventError('log_limit', 'legacy stdout exceeds max_log_bytes')
            self.legacy.extend(data)
        start = 0
        while start < len(data):
            end = data.find(b'\n', start)
            part = data[start:] if end < 0 else data[start:end]
            if len(self.buffer) + len(part) > self.max_bytes:
                raise EventError('log_limit', 'single JSONL line exceeds max_log_bytes')
            self.buffer.extend(part)
            if end < 0:
                break
            line = bytes(self.buffer).removesuffix(b'\r')
            self.buffer.clear()
            self.record(line)
            start = end + 1

    def finish(self, reason: str, delivery: str = 'json', max_response_bytes: int | None = None) -> bytes:
        error, body = None, b''
        try:
            if reason != 'ok':
                return b''
            if self.buffer:
                if self.event_mode:
                    self.invalid = True
                    raise EventError('invalid_response', 'unterminated JSONL record')
                self.record(bytes(self.buffer))
                self.buffer.clear()
            if self.event_mode:
                if self.invalid or not self.settled or not self.candidate or self.pending_work or self.active_tools:
                    raise EventError('invalid_response', 'no settled, completed final assistant response')
                text = self.candidate
            else:
                text = self.legacy.decode('utf-8')
            if delivery == 'json':
                value = extract_json(text)
                if value is None:
                    raise EventError('invalid_response', 'final assistant text has no JSON object')
                body = (json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + '\n').encode('utf-8')
            else:
                if not text.strip():
                    raise EventError('invalid_response', 'final assistant text is empty')
                body = (text.strip() + '\n').encode('utf-8')
            if max_response_bytes is not None and len(body) > max_response_bytes:
                raise EventError('response_limit', 'completed response exceeds max_response_bytes')
        except (UnicodeError, ValueError, EventError) as exc:
            error = exc if isinstance(exc, EventError) else EventError('invalid_response', str(exc))
            reason = error.reason
        finally:
            self.activity.update(running=False, finish_reason=reason)
            if reason != 'ok':
                self.phase('unknown', reason)
            self.persist()
            if self.raw:
                self.raw.close()
                self.raw = None
            self.buffer.clear()
            self.legacy.clear()
        if error:
            raise error
        return body
