"""Bounded single-unit loop + static dependency DAG.

One worker owns the manifest. Members only propose reports. The engine binds
reports to immutable candidates and independently executes every required gate.
"""
from __future__ import annotations
import concurrent.futures
import contextlib
import copy
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import traceback
import uuid

from .adapters import ENGINE_DIR, command, expand, member_prompt, prompt_view
from .common import (LoopError, IntegrityError, FileLock, atomic_json, atomic_write, changes,
                     check_boundary, copy_manifest, digest, environment, file_hash,
                     load_json, matches, now, safe_child, tree_manifest)
from .protocol import evaluate, validate_report, response_schema, scratch_file
from .handoff import (make_comparison, record_findings, apply_resolutions, rule_gaps, freeze_review,
                      validate_code_map, code_map_covers, read_guidance)
from .rules import ancestors, topological
from .runner import kill_group, process_identity
from .storage import Store, render_views
from .observability import read_observation, cost_sessions
from .sessions import DeveloperSessions, supports_reuse
from .execution import inspect_developer_delivery, execute_recipe, new_output_roots
from .member_service import MemberService


class Stop(Exception):
    def __init__(self, stop: str, reason: str):
        self.stop, self.reason = stop, reason
        super().__init__(reason)


def repair_time_reserve(deadline: float, timing: dict, current: float | None = None) -> int:
    current = time.time() if current is None else current
    remaining = deadline - current
    reserve = math.ceil((timing['gate_seconds'] + timing['review_seconds']) * 1.25)
    available, need = remaining - reserve, 0.5 * timing['developer_seconds']
    if available <= 0 or available < need:
        raise Stop('NOT_MET', f'时间不够返修：剩余 {remaining / 60:.1f} 分钟，扣除门禁和复审预留 {reserve / 60:.1f} 分钟后，'
                             f'不足上一轮开发用时的一半（{need / 60:.1f} 分钟）；未开始返修，保留当前候选和问题清单')
    return reserve


def unknown_rows(unit: dict, note: str) -> list[dict]:
    return [{'id': c['id'], 'status': 'UNKNOWN', 'note': note, 'evidence': []} for c in unit['criteria']]


def snapshot_manifest(path: Path, limits: dict, excludes=None) -> dict:
    return tree_manifest(path, excludes, limits['max_source_files'], limits['max_source_bytes'])


def verify_candidate(candidate: dict, limits: dict) -> dict:
    path = Path(candidate['path'])
    manifest = snapshot_manifest(path, limits)
    if digest(manifest) != candidate['hash']:
        raise IntegrityError('候选成果指纹不匹配：' + str(path))
    meta = load_json(Path(candidate['metadata_path']))
    if meta['candidate_hash'] != candidate['hash'] or meta['manifest'] != manifest:
        raise IntegrityError('候选成果元数据不匹配')
    return manifest


def gate_failure_reason(stdout: Path) -> str:
    """Use the last stdout marker, including an empty marker overriding earlier ones."""
    reason = 'unspecified'
    with stdout.open(encoding='utf-8', errors='replace') as log:
        for line in log:
            if line.startswith('LOOP_FAIL_REASON='):
                reason = line[len('LOOP_FAIL_REASON='):].strip()[:200] or 'unspecified'
    return reason


class UnitEngine:
    def __init__(self, controller: 'Controller', unit: dict):
        self.controller, self.store, self.rules, self.unit = controller, controller.store, controller.rules, unit
        self.uid, self.limits = unit['id'], self.rules['limits']
        self.workspace = self.store.run / 'units' / self.uid
        self.workspace.mkdir(parents=True, exist_ok=True)
        self.deadline = min(controller.deadline, time.time() + unit['max_seconds'])
        self.input_path, self.input_manifest = None, None
        self.candidate, self.last_reviewed, self.rows = None, None, None
        self.gates, self.feedback, self.history = {}, None, []
        self.issue_history = []
        self.code_map = None
        self.scratch_evidence = {}
        self.round = 1
        self.repair_reserve = 0
        self.developer_deadline = self.deadline

    @contextlib.contextmanager
    def time_stage(self, key: str):
        started = time.time()
        try:
            yield
        finally:
            self.history[-1]['timing'][key] = round(max(0, time.time() - started), 1)
            self.store.unit(self.uid, history=copy.deepcopy(self.history), last_step_at=now())

    def repair_timeout(self):
        raise Stop('NOT_MET', f'返修开发用完了本轮可用时间（已为门禁和复审预留 {self.repair_reserve / 60:.1f} 分钟），'
                             '没有交付；保留上一候选和问题清单')

    def check_time(self):
        if (self.store.run / 'cancel').exists():
            raise Stop('BLOCKED', '已收到停止请求；当前进程组已取消，不再启动新工作。')
        if time.time() >= self.deadline:
            raise Stop('NOT_MET', '运行总时限或单元时限已到。')

    def heartbeat(self, phase: str, job: Path):
        values = {'phase': phase, 'engine_seen_at': now()}
        logs = [job / 'stdout.log', job / 'stderr.log']
        existing = [p for p in logs if p.exists() and p.stat().st_size]
        if existing:
            stamp = max(p.stat().st_mtime for p in existing)
            values['last_output_at'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(stamp))
        self.store.unit(self.uid, **values)
        self.observe_member(phase, job)

    def observe_member(self, phase: str, job: Path, receipt: dict | None = None, *, report: dict | None = None,
                       guidance: dict | None = None):
        if phase not in ('developing', 'reviewing'):
            return
        workspace = job.parent
        records = self.store.data['units'][self.uid].get('member_observations', {})
        old = records.get(workspace.name, {})
        observation = read_observation(workspace)
        observation.update(round=self.round, call_order=old.get('call_order', len(records)))
        guidance = guidance if guidance is not None else old.get('read_guidance')
        if guidance is not None:
            observation['read_guidance'] = guidance
        usage = observation.get('usage') or {}
        complete = all(usage.get(field) is not None for field in
                       ('reads', 'distinct_files', 'repeat_reads', 'read_paths', 'tools_by_name'))
        off_map, status = None, 'unknown'
        if complete and guidance is not None:
            if guidance['code_map'] is None:
                status = 'no_map'
            else:
                guided = set(guidance['paths'])
                off_map = len({p['path'] for p in usage['read_paths'] if not p['outside']
                               and p['path'] not in guided and not code_map_covers(guidance['code_map'], p['path'])})
                status = 'known'
        observation.update(off_map_reads=off_map, off_map_status=status)
        if report is not None:
            observation['code_map_provided'] = 'code_map' in report
        self.store.member_observation(self.uid, workspace.name,
            'developer' if phase == 'developing' else 'reviewer', workspace, observation, receipt)

    def seal_observation(self, workspace: Path):
        for name in ('pi-events.jsonl', 'pi-stderr.log', 'activity.json', 'usage.json', 'session-protection.json',
                     'pi-events.jsonl.retention.json', 'pi-stderr.log.retention.json'):
            path = workspace / name
            if path.is_file() and not path.is_symlink():
                self.store.seal(path)

    def quota_specs(self):
        if self.rules['schema_version'] != 2:
            return []
        return [{'path': str(self.store.root / area / self.store.rid), 'group': 'run',
                 'max_bytes': self.limits['max_run_bytes'], 'max_files': self.limits['max_run_files']}
                for area in ('runs', 'checkouts', 'snapshots', 'artifacts')]

    def run_job(self, argv: list[str], code: Path, job: Path, stdin: str,
                timeout: float, idle: float, env: dict, phase: str) -> dict:
        self.check_time()
        job.mkdir(parents=True, exist_ok=True)
        timeout = min(timeout, self.deadline - time.time())
        atomic_write(job / 'stdin.txt', stdin, readonly=True)
        spec = {'argv': argv, 'cwd': str(code), 'owner_pid': os.getpid(),
                'owner_start': process_identity(os.getpid()), 'timeout_seconds': timeout,
                'idle_output_seconds': idle, 'deadline_epoch': self.deadline,
                'cancel_file': str(self.store.run / 'cancel'), 'max_log_bytes': self.limits['max_log_bytes']}
        if env.get('LOOP_ADAPTER_PROTOCOL') == 'loop-outcome-v1':
            spec.update(adapter_protocol='loop-outcome-v1', soft_diagnostics=True, stdout_kind='response',
                        max_response_bytes=self.limits['max_response_bytes'],
                        max_event_bytes=self.limits.get('max_event_bytes', 8*1024*1024))
        if self.rules['schema_version'] == 2:
            spec['quotas'] = [{'path': str(self.store.root / area / self.store.rid),
                               'group': 'run', 'max_bytes': self.limits['max_run_bytes'], 'max_files': self.limits['max_run_files']}
                              for area in ('runs', 'checkouts', 'snapshots', 'artifacts')]
        atomic_json(job / 'job.json', spec, readonly=True)
        self.store.event('command_started', self.uid, phase=phase, job=str(job), argv=argv)
        env = dict(env)
        with (job / 'guardian.log').open('wb') as log:
            guardian = subprocess.Popen([sys.executable, str(ENGINE_DIR / 'loop_engineering' / 'runner.py'), str(job)],
                                        stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                                        env=env, start_new_session=True)
            self.store.unit(self.uid, phase=phase, active_job=str(job), engine_seen_at=now())
            started, heartbeat_at = time.monotonic(), 0
            while guardian.poll() is None:
                current = time.monotonic()
                if current - heartbeat_at > 1:
                    self.heartbeat(phase, job)
                    heartbeat_at = current
                if current - started > timeout + 8:
                    atomic_write(job / 'cancel', 'guardian watchdog deadline\n')
                    meta_path = job / 'process.json'
                    if meta_path.exists():
                        meta = load_json(meta_path)
                        if meta.get('child_start') and process_identity(meta['child_pid']) == meta['child_start']:
                            kill_group(meta['pgid'])
                    guardian.kill()
                    guardian.wait(timeout=3)
                    raise Stop('BLOCKED', '进程守护器未按期退出；已尝试清理可确认归属的进程组。')
                time.sleep(0.08)
        self.store.unit(self.uid, active_job=None, engine_seen_at=now())
        receipt_path = job / 'receipt.json'
        if not receipt_path.exists():
            raise Stop('BLOCKED', '进程守护器没有交付执行回执：' + str(job))
        receipt = load_json(receipt_path)
        self.store.event('command_finished', self.uid, phase=phase, job=str(job), **receipt)
        self.observe_member(phase, job, receipt)
        if phase in ('developing', 'reviewing'):
            self.seal_observation(job.parent)
        # Guardian cleanup may cross the unit deadline; retain the more specific reserved-time stop.
        reserved_timeout = (phase == 'developing' and receipt['reason'] == 'timeout' and self.repair_reserve > 0
                            and self.developer_deadline == self.deadline - self.repair_reserve)
        if (self.store.run / 'cancel').exists() or not reserved_timeout:
            self.check_time()
        for name in ('job.json', 'stdin.txt', 'receipt.json', 'stdout.log', 'stderr.log'):
            p = job / name
            if p.is_file():
                self.store.seal(p)
        return receipt

    def make_input(self) -> tuple[Path, dict]:
        if self.unit.get('kind') == 'verify' and self.unit.get('input_from'):
            result = self.store.data['units'][self.unit['input_from']]['result']
            if not result or result['stop'] != 'PASSED':
                raise IntegrityError('verify 依赖尚未达标')
            candidate = result['candidate']
            actual = verify_candidate(candidate, self.limits)
            frozen = self.store.root / 'snapshots' / self.store.rid / ('unit-' + self.uid)
            copy_manifest(Path(candidate['path']), frozen, actual, readonly=True)
            atomic_json(self.workspace / 'input.json', {'hash': digest(actual), 'manifest': actual,
                'path': str(frozen), 'input_from': self.unit['input_from']}, readonly=True)
            self.store.seal(self.workspace / 'input.json')
            self.store.unit(self.uid, input_hash=digest(actual), input_path=str(frozen), last_step_at=now())
            return frozen, actual
        source_info = self.store.data['input']
        source, initial = Path(source_info['path']), source_info['manifest']
        work = self.store.root / 'checkouts' / self.store.rid / self.uid / 'assemble-input'
        copy_manifest(source, work, initial)
        current = dict(initial)
        all_ancestors = ancestors(self.rules['units'], self.uid)
        for dep in topological(self.rules['units']):
            if dep not in all_ancestors:
                continue
            result = self.store.data['units'][dep]['result']
            if not result or result['stop'] != 'PASSED':
                raise IntegrityError('尝试读取未达标依赖')
            candidate = result['candidate']
            candidate_manifest = verify_candidate(candidate, self.limits)
            meta = load_json(Path(candidate['metadata_path']))
            before = meta['base_manifest']
            delta = changes(before, candidate_manifest)
            for rel in sorted(delta, key=lambda p: (p.count('/'), p), reverse=True):
                if rel in candidate_manifest:
                    continue
                if current.get(rel) != before.get(rel):
                    raise IntegrityError('依赖删除冲突：' + rel)
                p = work / rel
                if before[rel]['kind'] == 'dir':
                    if p.exists():
                        p.rmdir()
                else:
                    p.unlink()
                current.pop(rel, None)
            for rel in sorted(delta, key=lambda p: (p.count('/'), p)):
                if rel not in candidate_manifest:
                    continue
                desired = candidate_manifest[rel]
                if current.get(rel) != before.get(rel) and current.get(rel) != desired:
                    raise IntegrityError('依赖合并冲突：' + rel)
                p = work / rel
                old = current.get(rel)
                if old and old['kind'] != desired['kind']:
                    if old['kind'] == 'dir':
                        p.rmdir()
                    else:
                        p.unlink()
                if desired['kind'] == 'dir':
                    p.mkdir(parents=True, exist_ok=True)
                else:
                    p.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(safe_child(Path(candidate['path']), rel), p)
                    os.chmod(p, 0o700 if desired['executable'] else 0o600)
                current[rel] = desired
        actual = snapshot_manifest(work, self.limits)
        if actual != current:
            raise IntegrityError('依赖组合后的输入清单不一致')
        frozen = self.store.root / 'snapshots' / self.store.rid / ('unit-' + self.uid)
        copy_manifest(work, frozen, actual, readonly=True)
        atomic_json(self.workspace / 'input.json', {'hash': digest(actual), 'manifest': actual,
                                                  'path': str(frozen), 'dependencies': sorted(all_ancestors)}, readonly=True)
        self.store.seal(self.workspace / 'input.json')
        self.store.unit(self.uid, input_hash=digest(actual), input_path=str(frozen), last_step_at=now())
        return frozen, actual

    def comparison(self, code: Path, manifest: dict, adir: Path) -> dict:
        if snapshot_manifest(self.input_path, self.limits) != self.input_manifest:
            raise IntegrityError('本单元冻结输入发生变化')
        previous = next((h for h in reversed(self.history) if h['round'] == self.round - 1), None)
        candidate = previous['candidate'] if previous else None
        previous_manifest = verify_candidate(candidate, self.limits) if candidate else None
        review = (load_json(Path(previous['review_path']))['report']
                  if previous and previous.get('review_path') else None)
        comp = make_comparison(self.input_path, self.input_manifest, code, manifest,
                               candidate, previous_manifest, review, adir / 'comparison.diff')
        comp['previous_review_path'] = previous.get('review_path') if previous else None
        self.store.seal(adir / 'comparison.diff')
        return comp

    def member(self, role: str, base_path: Path, base_manifest: dict) -> tuple[dict, Path, dict, str]:
        with DeveloperSessions(self.store, self.unit, role) as sessions:
            return self._member(role, base_path, base_manifest, sessions)

    def _member(self, role: str, base_path: Path, base_manifest: dict,
                sessions: DeveloperSessions) -> tuple[dict, Path, dict, str]:
        agent = self.rules['agents'][self.unit[role]]
        protocol_repair, last_error, invalid_excerpt = False, '', ''
        reviewer_exec = role == 'reviewer' and self.unit.get('reviewer_exec', False)
        scratch = None
        while True:
            self.check_time()
            if role == 'developer' and self.repair_reserve > 0 and time.time() >= self.deadline - self.repair_reserve:
                self.repair_timeout()
            self.store.assert_integrity()
            attempt = f'{role}-r{self.round:03d}-' + uuid.uuid4().hex[:12]
            adir = self.workspace / 'attempts' / attempt
            adir.mkdir(parents=True)
            if reviewer_exec:
                previous_scratch, scratch = scratch, adir / 'scratch'
                if previous_scratch is None:
                    scratch.mkdir(mode=0o700)
                else:
                    # Fresh attempt, same collected contents; never follow links while copying.
                    shutil.copytree(previous_scratch, scratch, symlinks=True)
                    os.chmod(scratch, 0o700)
            code = self.store.root / 'checkouts' / self.store.rid / self.uid / attempt
            copy_manifest(base_path, code, base_manifest, readonly=(role == 'reviewer' or protocol_repair))
            response = adir / 'response.json'
            context_path = adir / 'context.json'
            values = {'python': sys.executable, 'engine': str(ENGINE_DIR), 'code': str(code),
                      'workspace': str(adir), 'context': str(context_path), 'response': str(response),
                      'schema': str(self.store.run / 'response.schema.json'), 'role': role, 'unit': self.uid}
            args, output = command(agent, role, values, reviewer_exec=reviewer_exec)
            role_unit = {k: v for k, v in self.unit.items() if k not in ('developer', 'reviewer')}
            context = {'schema_version': 1, 'run_id': self.store.rid, 'unit_id': self.uid,
                       'attempt_id': attempt, 'role': role, 'member_identity': agent['identity'],
                       'task_title': self.rules['title'], 'task_notes': self.rules['notes'],
                       'round': self.round, 'rule_hash': self.store.data['rule_hash'],
                       'input_hash': digest(base_manifest), 'unit_input_hash': digest(self.input_manifest),
                       'candidate_hash': self.candidate['hash'] if role == 'reviewer' else '',
                       'code_path': str(code), 'workspace_path': str(adir), 'response_path': str(response),
                       'context_path': str(context_path),
                       'scratch_path': str(scratch) if scratch is not None else None,
                       'output_mode': output, 'adapter_kind': agent['kind'], 'unit': role_unit, 'limits': self.limits,
                       'feedback': self.feedback if role == 'developer' else None,
                       'developer_delivery': self.history[-1].get('developer') if role == 'reviewer' and self.history else None,
                       'gate_evidence': self.gates if role == 'reviewer' else {},
                       'history_index': str(self.workspace),
                       'comparison': self.comparison(code, base_manifest, adir),
                       'issue_history': copy.deepcopy(self.issue_history),
                       'code_map': copy.deepcopy(self.code_map),
                       'protocol_repair_only': protocol_repair,
                       'protocol_error': last_error, 'invalid_response_excerpt': invalid_excerpt,
                       'response_schema': response_schema()}
            if role == 'developer':
                context['developer_timeout_seconds'] = max(0, min(self.unit['stage_timeout_seconds'],
                                                                  self.deadline - self.repair_reserve - time.time()))
            context['managed_tools'] = self.rules['schema_version'] == 2
            if context['managed_tools']:
                context['execution_profiles'] = self.rules['execution_profiles']
                context['security'] = self.rules['security']
            context['session'] = sessions.select(context, agent)
            atomic_json(adir / 'session-choice.json', context['session'], readonly=True)
            self.store.seal(adir / 'session-choice.json')
            template = {'attempt_id': attempt, 'role': role,
                        'candidate_hash': context['candidate_hash'], 'summary': '尚未评估', 'blocked': False,
                        'criteria': [{'id': c['id'], 'status': 'UNKNOWN', 'note': '尚未评估', 'evidence': []}
                                     for c in self.unit['criteria']], 'issues': [], 'rule_gaps': []}
            template_path = adir / 'response.template.json'
            atomic_json(template_path, template, readonly=True)
            self.store.seal(template_path)
            context['response_template_path'] = str(template_path)
            prompt = member_prompt(context)
            if protocol_repair:
                prompt = '本次仅修复交付格式：代码已冻结，严禁再改代码。依据现有代码重新提交合法 JSON，使用本次新的 attempt_id。\n' + prompt
            if len(prompt.encode('utf-8')) > self.limits['max_context_bytes']:
                raise Stop('BLOCKED', '上下文包超过上限，未静默截断有效规则。请缩小规则或拆分任务。')
            atomic_json(context_path, context, readonly=True)
            self.store.seal(context_path)
            if not self.store.reserve_call(self.uid, self.limits['max_member_invocations'], attempt):
                raise Stop('NOT_MET', '成员调用总预算已耗尽。')
            member_env = environment(agent['inherit_env'])
            member_env.update(LOOP_CONTEXT=str(context_path), LOOP_RESPONSE=str(response),
                              LOOP_CODE=str(code), LOOP_ATTEMPT_ID=attempt, LOOP_ROLE=role, LOOP_UNIT_ID=self.uid)
            member_env.pop('LOOP_SCRATCH', None)
            if scratch is not None:
                member_env['LOOP_SCRATCH'] = str(scratch)
            if supports_reuse(agent) or agent.get('outcome_protocol') == 'loop-outcome-v1':
                member_env['LOOP_ADAPTER_PROTOCOL'] = 'loop-outcome-v1'
            phase = 'developing' if role == 'developer' else 'reviewing'
            self.observe_member(phase, adir / 'job', guidance=read_guidance(prompt_view(context), base_manifest))
            service_context = MemberService(self, context, code, base_manifest) if context['managed_tools'] else contextlib.nullcontext(None)
            with service_context as service:
                if service is not None:
                    member_env.update(service.env())
                timeout, reserve_limited = self.unit['stage_timeout_seconds'], False
                if role == 'developer':
                    current = time.time()
                    available = self.deadline - self.repair_reserve - current
                    reserve_limited = self.repair_reserve > 0 and available <= timeout
                    self.developer_deadline = min(current + timeout, self.deadline - self.repair_reserve)
                    timeout = min(timeout, available)
                    if reserve_limited and timeout <= 0:
                        self.repair_timeout()
                receipt = self.run_job(args, code, adir / 'job', prompt, timeout,
                                       self.unit['idle_output_seconds'], member_env, phase)
                if service is not None and supports_reuse(agent) and not service.handshake and receipt['reason'] == 'ok':
                    receipt = {**receipt, 'reason': 'config_error', 'detail': 'Loop Pi extension did not complete handshake'}

            self.observe_member(phase, adir / 'job', receipt)
            self.store.assert_integrity()
            actual = snapshot_manifest(code, self.limits)
            if role == 'reviewer' or protocol_repair:
                if actual != base_manifest:
                    raise IntegrityError('只读评审/格式修复阶段修改了代码')
            else:
                actual = inspect_developer_delivery(code, self.input_manifest, self.unit, self.limits,
                                                    self.rules.get('execution_profiles'))
            if receipt['reason'] != 'ok':
                sessions.complete(context, False, 'execution_failed: ' + receipt['reason'])
                if receipt['reason'] == 'timeout' and reserve_limited:
                    self.repair_timeout()
                from .outcomes import RETRYABLE
                if receipt['reason'] in ('timeout', 'idle_timeout', 'cancelled', 'controller_lost', 'log_limit') or (self.rules['schema_version'] == 2 and receipt['reason'] not in RETRYABLE):
                    raise Stop('BLOCKED', '成员执行停止：' + receipt['reason'])
                stats = self.store.data['units'][self.uid]['stats']
                if stats['infra_retries'] < self.unit['max_infra_retries']:
                    self.store.counter(self.uid, 'infra_retries')
                    self.store.event('infra_retry', self.uid, attempt=attempt, reason=receipt['reason'])
                    continue
                raise Stop('BLOCKED', '成员启动/执行失败，基础设施重试已耗尽：' + receipt['reason'])
            if output == 'stdout':
                raw_path = adir / 'job' / 'stdout.log'
                # A copied response remains immutable; the original raw stream is retained.
                atomic_write(response, raw_path.read_bytes())
            try:
                report = load_json(response, self.limits['max_response_bytes'])
                validate_report(report, context, code, self.gates)
                if context['managed_tools'] and role == 'developer' and 'code_map' in report:
                    if self.input_manifest is None:
                        raise IntegrityError('缺少单元输入清单，无法核对 code_map')
                    validate_code_map(report['code_map'], self.input_manifest, actual)
            except (LoopError, TypeError, KeyError) as exc:
                sessions.complete(context, False, 'protocol_rejected: ' + str(exc)[:400])
                last_error = str(exc)
                if response.is_file() and not response.is_symlink():
                    invalid_excerpt = response.read_bytes()[:4096].decode('utf-8', errors='replace')
                atomic_write(adir / 'protocol-error.txt', last_error + '\n', readonly=True)
                self.store.seal(adir / 'protocol-error.txt')
                stats = self.store.data['units'][self.uid]['stats']
                if stats['protocol_retries_by_role'][role] >= self.unit['max_protocol_retries']:
                    raise Stop('BLOCKED', '交付协议修复已耗尽：' + last_error)
                self.store.protocol_retry(self.uid, role)
                self.store.event('protocol_retry', self.uid, role=role, attempt=attempt, error=last_error)
                frozen = self.store.root / 'snapshots' / self.store.rid / ('protocol-' + attempt)
                copy_manifest(code, frozen, actual, readonly=True)
                base_path, base_manifest = frozen, actual
                protocol_repair = True
                continue
            sessions.complete(context, True, 'accepted_business_delivery' if not protocol_repair else 'format_only_not_reusable')
            self.store.seal(response)
            scratch_evidence = {}
            if scratch is not None:
                evidence_rows = report['criteria'] + report.get('issue_resolutions', [])
                refs = {ref for row in evidence_rows for ref in row['evidence'] if ref.startswith('scratch:')}
                for ref in sorted(refs):
                    path = scratch_file(scratch, ref[8:])
                    self.store.seal(path)
                    scratch_evidence[ref] = {'path': str(path), 'sha256': file_hash(path),
                                             'candidate_hash': digest(actual)}
                self.scratch_evidence = scratch_evidence
            wrapper = {'attempt_id': attempt, 'role': role, 'rule_hash': self.store.data['rule_hash'],
                       'input_hash': digest(base_manifest), 'candidate_hash': digest(actual),
                       'received_at': now(), 'report': report}
            if scratch is not None:
                wrapper['scratch_evidence'] = scratch_evidence
            accepted = adir / 'accepted.json'
            atomic_json(accepted, wrapper, readonly=True)
            self.store.seal(accepted)
            self.issue_history = record_findings(self.issue_history, report, self.store.rid, self.uid,
                                                 self.round, digest(actual), str(accepted))
            if role == 'reviewer':
                self.issue_history = apply_resolutions(self.issue_history, report, self.unit, self.gates,
                                                       digest(actual), self.round, str(accepted),
                                                       self.evidence_index(report.get('issue_resolutions', [])))
            # Persist accepted findings before the next member/step, including on
            # failure paths. Recovery uses this ledger without inferring closure.
            if role == 'developer':
                self.code_map = {'round': self.round, 'text': report['code_map'].strip()} if 'code_map' in report else None
            self.observe_member(phase, adir / 'job', receipt, report=report)
            self.store.unit(self.uid, issue_history=copy.deepcopy(self.issue_history),
                            code_map=copy.deepcopy(self.code_map), last_step_at=now())
            self.store.event('handoff_accepted', self.uid, role=role, attempt=attempt, candidate_hash=digest(actual))
            return report, code, actual, str(accepted)

    def freeze_candidate(self, code: Path, manifest: dict, delivery: str) -> dict:
        dest = self.store.root / 'artifacts' / self.store.rid / self.uid / f'round-{self.round:03d}'
        copy_manifest(code, dest / 'code', manifest, readonly=True)
        metadata = {'run_id': self.store.rid, 'unit_id': self.uid, 'round': self.round,
                    'rule_hash': self.store.data['rule_hash'], 'input_hash': digest(self.input_manifest),
                    'candidate_hash': digest(manifest), 'manifest': manifest, 'base_manifest': self.input_manifest,
                    'changed_paths': changes(self.input_manifest, manifest), 'developer_delivery': delivery}
        # Metadata and reports remain in the handoff workspace, code remains outside it.
        meta_path = self.workspace / f'candidate-{self.round:03d}.json'
        atomic_json(meta_path, metadata, readonly=True)
        self.store.seal(meta_path)
        return {'path': str(dest / 'code'), 'hash': digest(manifest), 'metadata_path': str(meta_path),
                'round': self.round, 'input_hash': digest(self.input_manifest)}

    def run_gates(self, manifest: dict):
        if self.rules['schema_version'] == 2:
            return self.run_profile_gates(manifest)
        self.gates = {}
        # Reasons are shared across gates, but never across candidates/repair rounds.
        failed_reasons = set()
        if self.history:
            self.history[-1]['gates'] = self.gates
        for gate in self.unit['gates']:
            gid = gate['id']
            location = self.workspace / 'gates' / f'r{self.round:03d}-{gid}'
            attempts, repeated_reason = [], None
            for attempt in range(1, gate.get('max_reruns', 0) + 2):
                self.check_time()
                self.store.assert_integrity()
                verify_candidate(self.candidate, self.limits)
                # Keep first paths unchanged. A separate namespace prevents reruns
                # from colliding with first executions of IDs such as G1-a002.
                execution = location if attempt == 1 else location / f'attempt-{attempt:03d}'
                checkout = self.store.root / 'checkouts' / self.store.rid / self.uid
                code = (checkout / f'gate-r{self.round:03d}-{gid}' if attempt == 1 else
                        checkout / 'gate-reruns' / f'r{self.round:03d}-{gid}' / f'attempt-{attempt:03d}')
                copy_manifest(Path(self.candidate['path']), code, manifest)
                if any(matches(p, gate['output_paths']) for p in manifest):
                    raise IntegrityError(f'门禁 {gid} 的输出范围与已有源码重合')
                values = {'python': sys.executable, 'engine': str(ENGINE_DIR), 'code': str(code),
                          'workspace': str(execution), 'unit': self.uid}
                args = expand(gate['argv'], values)
                receipt = self.run_job(args, code, execution / 'job', '', gate['timeout_seconds'], 0,
                                       environment(gate_home=execution / 'home'), 'testing')
                if attempt > 1:
                    self.store.counter(self.uid, 'gate_reruns')
                self.store.assert_integrity()
                after = snapshot_manifest(code, self.limits)
                # Tests may create explicitly declared new scratch files, never modify existing assets.
                bad = [p for p in changes(manifest, after)
                       if p in manifest or not (matches(p, gate['output_paths']) or
                           (p.endswith('/') and any(x.startswith(p) for x in gate['output_paths'])))]
                if bad:
                    modified = sorted(p for p in bad if p in manifest)
                    roots = new_output_roots(manifest, [p for p in bad if p not in manifest])
                    raise IntegrityError(f'门禁 {gid} 修改了受测源码/验收资产或未声明输出：'
                                         f'既有资产 {modified[:20]}；未声明新输出（一次列全）{roots}')
                status = 'PASS' if receipt['reason'] == 'ok' else ('FAIL' if receipt['reason'] == 'nonzero_exit' else 'UNKNOWN')
                stdout, stderr = execution / 'job' / 'stdout.log', execution / 'job' / 'stderr.log'
                reason = gate_failure_reason(stdout) if status == 'FAIL' else None
                attempts.append({'attempt': attempt, 'status': status, 'exit_code': receipt['exit_code'],
                                 'reason': reason, 'stdout': str(stdout), 'stderr': str(stderr)})
                if status != 'FAIL':
                    break  # PASS is final; infrastructure UNKNOWN must not be retried.
                if reason in failed_reasons:
                    repeated_reason = reason
                    break
                failed_reasons.add(reason)
            record = {'id': gid, 'status': status, 'candidate_hash': self.candidate['hash'],
                      'rule_hash': self.store.data['rule_hash'], 'input_hash': digest(self.input_manifest),
                      'argv': args, 'receipt': receipt, 'stdout': str(stdout), 'stderr': str(stderr),
                      'attempts': attempts, 'reruns': len(attempts) - 1,
                      'passed_after_rerun': status == 'PASS' and len(attempts) > 1,
                      'repeated_reason': repeated_reason}
            path = location / 'evidence.json'
            atomic_json(path, record, readonly=True)
            self.store.seal(path)
            self.gates[gid] = record
            self.store.unit(self.uid, history=copy.deepcopy(self.history), last_step_at=now())
        verify_candidate(self.candidate, self.limits)

    def run_profile_gates(self, manifest: dict):
        self.gates = {}
        if self.history:
            self.history[-1]['gates'] = self.gates
        failed_reasons = set()
        for gate in self.unit['gates']:
            gid = gate['id']
            location = self.workspace / 'gates' / f'r{self.round:03d}-{gid}'
            attempts, repeated_reason = [], None
            for number in range(1, gate['max_reruns'] + 2):
                self.check_time()
                self.store.assert_integrity()
                verify_candidate(self.candidate, self.limits)
                if not self.store.reserve_operation('gate_executions', f'gate:{self.round}:{gid}:{number}',
                                                     self.limits['max_gate_executions'], self.uid, gate.get('budget_key')):
                    raise Stop('NOT_MET', '门禁或场景累计预算已耗尽，不创建新额度')
                execution = location / f'execution-{number:03d}'
                self.store.unit(self.uid, phase='testing', last_step_at=now())
                build = execute_recipe(Path(self.candidate['path']), manifest,
                    self.rules['execution_profiles'][gate['profile']], execution, self.limits,
                    purpose='GATE', security=self.rules['security'], deadline=self.deadline,
                    cancel_file=self.store.run / 'cancel',
                    binding={'run_id': self.store.rid, 'unit_id': self.uid, 'round': self.round, 'gate_id': gid}, run_quotas=self.quota_specs())
                if number > 1:
                    self.store.counter(self.uid, 'gate_reruns')
                # Seal only authority/diagnostics, not volatile scratch trees.
                for path in execution.rglob('*'):
                    if path.is_file() and not path.is_symlink() and path.relative_to(execution).parts[0] in ('evidence', 'job'):
                        self.store.seal(path)
                self.store.seal(execution / 'build-receipt.json')
                status = build['status']
                receipt = build.get('receipt', {'reason': build['reason'], 'exit_code': None})
                # Preserve executor failures even if the command itself exited zero.
                if build['status'] == 'UNKNOWN':
                    receipt = {**receipt, 'reason': build['reason'], 'error': build.get('error')}
                stdout, stderr = execution / 'job/stdout.log', execution / 'job/stderr.log'
                for path in (stdout, stderr):
                    if not path.exists():
                        atomic_write(path, '')
                        self.store.seal(path)
                reason = gate_failure_reason(stdout) if status == 'FAIL' else build['reason']
                attempts.append({'attempt': number, 'status': status, 'exit_code': receipt['exit_code'],
                                 'reason': reason, 'stdout': str(stdout), 'stderr': str(stderr)})
                if status != 'FAIL':
                    break
                if reason in failed_reasons:
                    repeated_reason = reason
                    break
                failed_reasons.add(reason)
            record = {'id': gid, 'status': status, 'candidate_hash': self.candidate['hash'],
                      'rule_hash': self.store.data['rule_hash'], 'input_hash': digest(self.input_manifest),
                      'argv': build.get('argv', []), 'receipt': receipt, 'stdout': str(stdout), 'stderr': str(stderr),
                      'attempts': attempts, 'reruns': len(attempts)-1,
                      'passed_after_rerun': status == 'PASS' and len(attempts)>1,
                      'repeated_reason': repeated_reason, 'build_receipt': str(execution / 'build-receipt.json'),
                      'reports': build['reports'], 'purpose': 'GATE'}
            path = location / 'evidence.json'
            atomic_json(path, record, readonly=True)
            self.store.seal(path)
            self.gates[gid] = record
            self.store.unit(self.uid, history=copy.deepcopy(self.history), last_step_at=now())
        verify_candidate(self.candidate, self.limits)

    def evidence_index(self, rows: list[dict]) -> dict:
        result = {}
        if self.candidate:
            for row in rows:
                for ref in row['evidence']:
                    if ref.startswith('code:'):
                        p = safe_child(Path(self.candidate['path']), ref[5:])
                        if p.is_file():
                            result[ref] = {'path': str(p), 'sha256': file_hash(p), 'candidate_hash': self.candidate['hash']}
                    elif ref.startswith('scratch:') and ref in self.scratch_evidence:
                        result[ref] = dict(self.scratch_evidence[ref])
                    elif ref.startswith('gate:') and ref[5:] in self.gates:
                        record = self.gates[ref[5:]]
                        result[ref] = {'candidate_hash': record['candidate_hash'], 'status': record['status'],
                                       'stdout': record['stdout'], 'stderr': record['stderr'],
                                       'exit_code': record['receipt']['exit_code'],
                                       'attempts': copy.deepcopy(record['attempts'])}
        return result

    def finish(self, stop: str, reason: str):
        rows = self.rows or unknown_rows(self.unit, '没有获得针对当前候选的完整有效评审')
        for c in self.unit['criteria']:
            row = next(x for x in rows if x['id'] == c['id'])
            for gid in c['gate_ids']:
                if gid in self.gates:
                    if 'gate:' + gid not in row['evidence']:
                        row['evidence'].append('gate:' + gid)
                    if self.gates[gid]['status'] == 'FAIL':
                        row['status'] = 'FAIL'
                    elif self.gates[gid]['status'] == 'UNKNOWN':
                        row['status'] = 'UNKNOWN'
        records = copy.deepcopy(self.store.data['units'][self.uid].get('member_observations', {}))
        sessions = cost_sessions(list(records.values()))
        self.store.unit(self.uid, phase='finalizing', active_job=None, member_observations=records)
        result = {'stop': stop, 'reason': reason, 'candidate': self.candidate, 'cost_sessions': sessions,
                  'last_reviewed_candidate': self.last_reviewed,
                  'reviewed': bool(self.last_reviewed and self.candidate and self.last_reviewed['hash'] == self.candidate['hash']),
                  'criteria': rows, 'rule_gaps': rule_gaps(self.issue_history),
                  'historical_rule_gaps': rule_gaps(self.issue_history, historical=True),
                  'issue_history': copy.deepcopy(self.issue_history),
                  'deferred_findings': [copy.deepcopy(i) for i in self.issue_history if i.get('deferred')],
                  'advisory_findings': [copy.deepcopy(i) for i in self.issue_history if i.get('status') == 'ADVISORY'],
                  'evidence': self.evidence_index(rows), 'history': self.history,
                  'workspace': str(self.workspace), 'verification_mode': self.unit.get('review_mode', 'independent')}
        self.store.finish_unit(self.uid, result)

    def execute(self):
        self.store.unit(self.uid, state='RUNNING', phase='preflight', started_at=now(), round=1)
        try:
            self.check_time()
            self.input_path, self.input_manifest = self.make_input()
            base_path, base_manifest = self.input_path, self.input_manifest
            seed = self.store.data.get('seed_candidate')
            if seed and len(self.rules['units']) == 1:
                base_manifest = verify_candidate(seed, self.limits)
                check_boundary(self.input_manifest, base_manifest, self.unit['writable_paths'], self.unit['protected_paths'])
                base_path = Path(seed['path'])
                self.store.event('checkpoint_reused_as_code_only', self.uid, candidate=seed['hash'])
            while True:
                self.check_time()
                self.history.append({'round': self.round, 'candidate': None, 'developer': None,
                                     'delivery_path': None, 'review_path': None,
                                     'issue_history': copy.deepcopy(self.issue_history),
                                     'timing': {'developer_seconds': 0.0, 'gate_seconds': 0.0, 'review_seconds': 0.0}})
                self.store.unit(self.uid, round=self.round, history=copy.deepcopy(self.history))
                review_first = self.round == 1 and self.unit.get('first_round') == 'review'
                if self.unit.get('kind') == 'verify' or review_first:
                    code, manifest = (self.input_path, self.input_manifest) if review_first else (base_path, base_manifest)
                    delivery = str(self.workspace / ('review-first-input.json' if review_first else 'verification-input.json'))
                    atomic_json(Path(delivery), {'origin': 'program', 'kind': 'review_first' if review_first else 'verify',
                                                'input_hash': digest(manifest)}, readonly=True)
                    self.store.seal(Path(delivery))
                    dev = None
                else:
                    with self.time_stage('developer_seconds'):
                        dev, code, manifest, delivery = self.member('developer', base_path, base_manifest)
                self.candidate = self.freeze_candidate(code, manifest, delivery)
                self.rows, self.gates, self.scratch_evidence = None, {}, {}
                self.history[-1].update(candidate=self.candidate, developer=dev, delivery_path=delivery,
                                        issue_history=copy.deepcopy(self.issue_history))
                # Persist candidate pointer before validation so crash recovery can preserve it.
                self.store.unit(self.uid, checkpoint=self.candidate, history=copy.deepcopy(self.history), last_step_at=now())
                if dev and dev['blocked']:
                    raise Stop('NOT_MET', '开发方记录了阻断目标的规则缺口：' + dev['summary'])
                with self.time_stage('gate_seconds'):
                    self.run_gates(manifest)
                unknown = [gid + '：' + str(g['receipt'].get('error') or g['receipt'].get('reason'))[:1500]
                           for gid, g in self.gates.items() if g['status'] == 'UNKNOWN']
                if unknown:
                    raise Stop('BLOCKED', '至少一个必需门禁没有获得有效执行结果，未把环境问题当作业务通过。'
                               + '；'.join(unknown))
                if self.unit.get('kind') == 'verify' and self.unit['review_mode'] == 'gates':
                    self.rows = [{'id': c['id'], 'status': 'PASS' if all(self.gates[g]['status']=='PASS' for g in c['gate_ids']) else 'FAIL',
                                  'note': '按显式 gates-only 规则，仅程序证据；未执行独立模型评审',
                                  'evidence': ['gate:' + g for g in c['gate_ids']]} for c in self.unit['criteria']]
                    if all(x['status'] == 'PASS' for x in self.rows):
                        self.finish('PASSED', '本候选的程序验收通过；规则未要求模型评审，仍待用户验收。')
                    else:
                        self.finish('NOT_MET', '验证阶段未达标，停止该依赖链，不自动回到开发。')
                    return
                known_before = {item['id'] for item in self.issue_history}
                with self.time_stage('review_seconds'):
                    review, _, _, review_path = self.member('reviewer', Path(self.candidate['path']), manifest)
                self.store.assert_integrity()
                verify_candidate(self.candidate, self.limits)
                self.last_reviewed = dict(self.candidate)
                self.rows = evaluate(review, self.unit, self.gates)
                deferred, regression_only = [], False
                if (self.rules['schema_version'] == 2 and self.round >= 2
                        and self.unit.get('review_scope', 'frozen') == 'frozen'):
                    previous = verify_candidate(self.history[-2]['candidate'], self.limits)
                    changed = {p for p in changes(previous, manifest) if not p.endswith('/')}
                    self.rows, self.issue_history, deferred, regression_only = freeze_review(
                        self.rows, review, self.issue_history, known_before, changed, self.unit, self.gates,
                        self.store.rid, self.uid, self.round)
                    self.store.unit(self.uid, issue_history=copy.deepcopy(self.issue_history), last_step_at=now())
                open_at_start = {i['id'] for i in self.history[-1]['issue_history']
                                 if i.get('kind') == 'issue' and i.get('status') == 'OPEN'
                                 and not i.get('deferred') and i.get('severity', 'blocking') != 'advisory'}
                self.history[-1].update(review_path=review_path, review=review, evaluated=self.rows,
                                        issue_history=copy.deepcopy(self.issue_history),
                                        deferred=deferred, regression_only=regression_only)
                self.store.unit(self.uid, history=copy.deepcopy(self.history), last_step_at=now())
                if all(r['status'] == 'PASS' for r in self.rows) and not review['blocked']:
                    self.check_time()
                    self.finish('PASSED', '当前候选的全部标准有效通过，必需门禁通过；待拍板人验收。')
                    return
                if review['blocked']:
                    raise Stop('NOT_MET', '评审记录了阻断达标的规则缺口：' + review['summary'])
                if self.unit.get('kind') == 'verify':
                    raise Stop('NOT_MET', '独立验证未达标，不自动回到开发')
                if regression_only and len(self.history) >= 2 and self.history[-2].get('regression_only'):
                    raise Stop('NOT_MET', '不收敛：连续两轮的修复都在改动处引入了新问题，已有问题却都已解决；'
                                          '请收紧验收标准或拆小任务后再跑，不再继续消耗返修。')
                if (self.rules['schema_version'] == 2 and self.round >= 2 and open_at_start
                        and not any(i['id'] in open_at_start and i.get('status') == 'RESOLVED' for i in self.issue_history)):
                    raise Stop('NOT_MET', f'停滞：本轮返修没有关掉任何已知的必须修问题（仍有 {len(open_at_start)} 个），'
                                          '继续返修大概率白跑；已停下交拍板人决定')
                if self.round - 1 >= self.unit['max_repairs']:
                    raise Stop('NOT_MET', '业务返修上限已到；保留未通过标准和当前候选。')
                self.repair_reserve = repair_time_reserve(self.deadline, self.history[-1]['timing'])
                self.check_time()
                issue_severities = {(i['description'], cid): i.get('severity', 'blocking')
                                    for i in self.issue_history if i.get('kind') == 'issue'
                                    for cid in i.get('criterion_ids', [])}
                self.feedback = {'summary': review['summary'], 'criteria': self.rows,
                                 'issues': [i for i in review['issues'] if issue_severities.get(
                                     (i['description'], i['criterion_id']), i.get('severity', 'blocking')) == 'blocking'],
                                 'rule_gaps': review['rule_gaps']}
                if self.rules['schema_version'] == 2 and not self.store.reserve_operation('repairs', f'repair:{self.round}',
                    self.limits['max_total_repairs'], self.uid):
                    raise Stop('NOT_MET', '累计业务返修额度耗尽')
                self.store.counter(self.uid, 'repairs')
                self.store.event('repair_scheduled', self.uid, previous_round=self.round)
                base_path, base_manifest = Path(self.candidate['path']), manifest
                self.round += 1
        except Stop as exc:
            self.finish(exc.stop, exc.reason)
        except BaseException as exc:
            atomic_write(self.workspace / 'engine-error.txt', traceback.format_exc())
            # Evidence may be unavailable after tampering; do not allow a secondary exception
            # to prevent minimal result publication.
            try:
                self.finish('BLOCKED', f'{type(exc).__name__}: {exc}')
            except BaseException as secondary:
                self.store.finish_unit(self.uid, {'stop': 'BLOCKED', 'reason': f'{exc}；收尾降级：{secondary}',
                    'candidate': self.candidate, 'reviewed': False, 'criteria': unknown_rows(self.unit, '完整性或收尾失败'),
                    'rule_gaps': rule_gaps(self.issue_history),
                    'historical_rule_gaps': rule_gaps(self.issue_history, historical=True),
                    'issue_history': copy.deepcopy(self.issue_history),
                    'evidence': {}, 'history': self.history, 'workspace': str(self.workspace)})


class Controller:
    def __init__(self, root: Path, rid: str):
        self.store = Store(root, rid)
        self.rules = load_json(self.store.run / 'rules.json')
        self.deadline = self.store.data['created_epoch'] + self.rules['limits']['max_wall_seconds']

    def skip(self, unit: dict, reason: str):
        self.store.finish_unit(unit['id'], {'stop': 'NOT_RUN', 'reason': reason, 'candidate': None,
            'reviewed': False, 'criteria': unknown_rows(unit, '单元未执行'), 'rule_gaps': [], 'evidence': {}, 'history': []})

    def execute(self):
        if self.store.data['state'] == 'TERMINAL':
            render_views(self.store.root, self.store.rid)
            return
        with FileLock(self.store.run / 'owner.lock'):
            self.store.assert_integrity()
            self.store.patch(state='RUNNING', worker_pid=os.getpid(), worker_started_at=now())
            try:
                from .admission import verify_run
                verify_run(self.store.root, self.store.data, self.rules)
                limits = self.rules['limits']
                source = Path(self.store.data['input_override'] or self.rules['source'])
                manifest = snapshot_manifest(source, limits, self.rules['exclude_paths'])
                if self.store.data.get('admission') and digest(manifest) != self.store.data['admission']['input_hash']:
                    raise IntegrityError('启动复制前输入与准备回执不同')
                frozen = self.store.root / 'snapshots' / self.store.rid / 'source'
                copy_manifest(source, frozen, manifest, readonly=True)
                if snapshot_manifest(source, limits, self.rules['exclude_paths']) != manifest:
                    raise IntegrityError('创建输入快照期间原始项目发生变化')
                self.store.patch(input={'path': str(frozen), 'hash': digest(manifest), 'manifest': manifest})
                order = topological(self.rules['units'])
                by_id = {u['id']: u for u in self.rules['units']}
                pending, active, held = set(order), {}, set()
                with concurrent.futures.ThreadPoolExecutor(max_workers=limits['max_parallel']) as pool:
                    while pending or active:
                        for future in list(active):
                            if not future.done():
                                continue
                            uid, resources = active.pop(future)
                            held -= resources
                            future.result()
                        for uid in order:
                            if uid not in pending:
                                continue
                            u = by_id[uid]
                            states = [self.store.data['units'][d] for d in u['depends_on']]
                            failed = [d for d in u['depends_on'] if self.store.data['units'][d]['result'] and
                                      self.store.data['units'][d]['result']['stop'] != 'PASSED']
                            if failed:
                                self.skip(u, '依赖未达标：' + ', '.join(failed))
                                pending.remove(uid)
                                continue
                            if (self.store.run / 'cancel').exists() or time.time() >= self.deadline:
                                self.skip(u, '运行停止请求或总时限已到，未启动此单元。')
                                pending.remove(uid)
                                continue
                            if (not (u.get('kind') == 'verify' and u.get('review_mode') == 'gates') and
                                    self.store.data['budget']['member_invocations'] >= limits['max_member_invocations']):
                                self.skip(u, '成员调用预算已耗尽，未启动此单元。')
                                pending.remove(uid)
                                continue
                            if len(active) >= limits['max_parallel'] or any(s['state'] != 'TERMINAL' for s in states):
                                continue
                            resources = set(u['resources'])
                            if resources & held:
                                continue
                            held |= resources
                            future = pool.submit(UnitEngine(self, u).execute)
                            active[future] = uid, resources
                            pending.remove(uid)
                        if pending or active:
                            time.sleep(0.08)
            except BaseException as exc:
                atomic_write(self.store.run / 'controller-error.txt', traceback.format_exc())
                atomic_write(self.store.run / 'cancel', 'controller failure\n')
                for u in self.rules['units']:
                    if self.store.data['units'][u['id']]['state'] != 'TERMINAL':
                        self.store.finish_unit(u['id'], {'stop': 'BLOCKED', 'reason': f'调度失败：{type(exc).__name__}: {exc}',
                            'candidate': self.store.data['units'][u['id']].get('checkpoint'), 'reviewed': False,
                            'criteria': unknown_rows(u, '调度失败，未获得完整结论'), 'rule_gaps': [], 'evidence': {}, 'history': []})
            # Keep final check outcomes in memory until the single finish_run commit.
            # A lost worker cannot leave a separately persisted claim of completion.
            integrity_checked, integrity_error = False, None
            try:
                self.store.assert_integrity()
                from .audit import audit
                check = audit(self.store.root, self.store.rid)
                if not check['integrity_ok']:
                    raise IntegrityError('; '.join(check['errors']))
                integrity_checked = True
            except (LoopError, OSError, KeyError, TypeError, ValueError) as exc:
                integrity_error = f'{type(exc).__name__}: {exc}'
            source_checked = False
            source_drift, source_drift_error = [], None
            if self.store.data['input']:
                try:
                    source = Path(self.store.data['input_override'] or self.rules['source'])
                    current = snapshot_manifest(source, self.rules['limits'], self.rules['exclude_paths'])
                    source_drift = changes(self.store.data['input']['manifest'], current)
                    source_checked = True
                except (LoopError, OSError, KeyError, TypeError, ValueError) as exc:
                    source_drift_error = f'原项目收尾核对失败：{type(exc).__name__}: {exc}'
            self.store.finish_run(source_drift=source_drift, source_drift_error=source_drift_error,
                                  integrity_checked=integrity_checked, source_checked=source_checked,
                                  integrity_error=integrity_error)
            render_views(self.store.root, self.store.rid)
