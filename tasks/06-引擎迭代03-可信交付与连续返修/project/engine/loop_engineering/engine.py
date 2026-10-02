"""Bounded single-unit loop + static dependency DAG.

One worker owns the manifest. Members only propose reports. The engine binds
reports to immutable candidates and independently executes every required gate.
"""
from __future__ import annotations
import concurrent.futures
import contextlib
import copy
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import traceback
import uuid

from .adapters import ENGINE_DIR, command, expand, member_prompt
from .common import (LoopError, IntegrityError, FileLock, atomic_json, atomic_write, changes,
                     check_boundary, copy_manifest, digest, environment, file_hash,
                     load_json, matches, now, safe_child, tree_manifest)
from .protocol import evaluate, validate_report, response_schema, scratch_file
from .rules import ancestors, topological
from .runner import kill_group, process_identity
from .storage import Store, render_views


class Stop(Exception):
    def __init__(self, stop: str, reason: str):
        self.stop, self.reason = stop, reason
        super().__init__(reason)


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
        self.gates, self.gaps, self.feedback, self.history = {}, [], None, []
        self.scratch_evidence = {}
        self.round = 1

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
        self.check_time()
        for name in ('job.json', 'stdin.txt', 'receipt.json', 'stdout.log', 'stderr.log'):
            p = job / name
            if p.is_file():
                self.store.seal(p)
        return receipt

    def make_input(self) -> tuple[Path, dict]:
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

    def member(self, role: str, base_path: Path, base_manifest: dict) -> tuple[dict, Path, dict, str]:
        agent = self.rules['agents'][self.unit[role]]
        protocol_repair, last_error, invalid_excerpt = False, '', ''
        reviewer_exec = role == 'reviewer' and self.unit.get('reviewer_exec', False)
        scratch = None
        while True:
            self.check_time()
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
                       'scratch_path': str(scratch) if scratch is not None else None,
                       'output_mode': output, 'adapter_kind': agent['kind'], 'unit': role_unit, 'limits': self.limits,
                       'feedback': self.feedback if role == 'developer' else None,
                       'developer_delivery': self.history[-1].get('developer') if role == 'reviewer' and self.history else None,
                       'gate_evidence': self.gates if role == 'reviewer' else {},
                       'history_index': str(self.workspace),
                       'protocol_repair_only': protocol_repair,
                       'protocol_error': last_error, 'invalid_response_excerpt': invalid_excerpt,
                       'response_schema': response_schema()}
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
            if not self.store.reserve_call(self.uid, self.limits['max_member_invocations']):
                raise Stop('NOT_MET', '成员调用总预算已耗尽。')
            member_env = environment(agent['inherit_env'])
            member_env.update(LOOP_CONTEXT=str(context_path), LOOP_RESPONSE=str(response),
                              LOOP_CODE=str(code), LOOP_ATTEMPT_ID=attempt, LOOP_ROLE=role, LOOP_UNIT_ID=self.uid)
            member_env.pop('LOOP_SCRATCH', None)
            if scratch is not None:
                member_env['LOOP_SCRATCH'] = str(scratch)
            receipt = self.run_job(args, code, adir / 'job', prompt,
                                   self.unit['stage_timeout_seconds'], self.unit['idle_output_seconds'],
                                   member_env, 'developing' if role == 'developer' else 'reviewing')
            self.store.assert_integrity()
            actual = snapshot_manifest(code, self.limits)
            if role == 'reviewer' or protocol_repair:
                if actual != base_manifest:
                    raise IntegrityError('只读评审/格式修复阶段修改了代码')
            else:
                check_boundary(self.input_manifest, actual, self.unit['writable_paths'], self.unit['protected_paths'])
            if receipt['reason'] != 'ok':
                if receipt['reason'] in ('timeout', 'idle_timeout', 'cancelled', 'controller_lost', 'log_limit'):
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
            except (LoopError, TypeError, KeyError) as exc:
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
            self.store.seal(response)
            scratch_evidence = {}
            if scratch is not None:
                refs = {ref for row in report['criteria'] for ref in row['evidence'] if ref.startswith('scratch:')}
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
            self.store.unit(self.uid, last_step_at=now())
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
                for p in changes(manifest, after):
                    if p in manifest or not (matches(p, gate['output_paths']) or
                            (p.endswith('/') and any(x.startswith(p) for x in gate['output_paths']))):
                        raise IntegrityError(f'门禁 {gid} 修改了受测源码/验收资产或未声明输出：{p}')
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
            self.store.unit(self.uid, last_step_at=now())
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
        self.store.unit(self.uid, phase='finalizing', active_job=None)
        result = {'stop': stop, 'reason': reason, 'candidate': self.candidate,
                  'last_reviewed_candidate': self.last_reviewed,
                  'reviewed': bool(self.last_reviewed and self.candidate and self.last_reviewed['hash'] == self.candidate['hash']),
                  'criteria': rows, 'rule_gaps': sorted(set(self.gaps)),
                  'evidence': self.evidence_index(rows), 'history': self.history,
                  'workspace': str(self.workspace)}
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
                self.store.unit(self.uid, round=self.round)
                dev, code, manifest, delivery = self.member('developer', base_path, base_manifest)
                self.gaps += dev['rule_gaps']
                self.candidate = self.freeze_candidate(code, manifest, delivery)
                self.rows, self.gates, self.scratch_evidence = None, {}, {}
                self.history.append({'round': self.round, 'candidate': self.candidate, 'developer': dev,
                                     'delivery_path': delivery, 'review_path': None})
                # Persist candidate pointer before validation so crash recovery can preserve it.
                self.store.unit(self.uid, checkpoint=self.candidate, last_step_at=now())
                if dev['blocked']:
                    raise Stop('NOT_MET', '开发方记录了阻断目标的规则缺口：' + dev['summary'])
                self.run_gates(manifest)
                if any(g['status'] == 'UNKNOWN' for g in self.gates.values()):
                    raise Stop('BLOCKED', '至少一个必需门禁没有获得有效执行结果，未把环境问题当作业务通过。')
                review, _, _, review_path = self.member('reviewer', Path(self.candidate['path']), manifest)
                self.store.assert_integrity()
                verify_candidate(self.candidate, self.limits)
                self.last_reviewed = dict(self.candidate)
                self.rows = evaluate(review, self.unit, self.gates)
                self.gaps += review['rule_gaps']
                self.history[-1].update(review_path=review_path, review=review, evaluated=self.rows)
                if all(r['status'] == 'PASS' for r in self.rows) and not review['blocked']:
                    self.check_time()
                    self.finish('PASSED', '当前候选的全部标准有效通过，必需门禁通过；待拍板人验收。')
                    return
                if review['blocked']:
                    raise Stop('NOT_MET', '评审记录了阻断达标的规则缺口：' + review['summary'])
                if self.round - 1 >= self.unit['max_repairs']:
                    raise Stop('NOT_MET', '业务返修上限已到；保留未通过标准和当前候选。')
                self.check_time()
                self.feedback = {'summary': review['summary'], 'criteria': self.rows,
                                 'issues': review['issues'], 'rule_gaps': review['rule_gaps']}
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
                    'rule_gaps': self.gaps, 'evidence': {}, 'history': self.history, 'workspace': str(self.workspace)})


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
                limits = self.rules['limits']
                source = Path(self.store.data['input_override'] or self.rules['source'])
                manifest = snapshot_manifest(source, limits, self.rules['exclude_paths'])
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
                            if self.store.data['budget']['member_invocations'] >= limits['max_member_invocations']:
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
            try:
                self.store.assert_integrity()
                for state in self.store.data['units'].values():
                    result = state.get('result')
                    if result and result['stop'] == 'PASSED':
                        verify_candidate(result['candidate'], self.rules['limits'])
            except (LoopError, OSError) as exc:
                self.store.patch(final_integrity_error=str(exc))
            source_drift, source_drift_error = [], None
            if self.store.data['input']:
                try:
                    source = Path(self.store.data['input_override'] or self.rules['source'])
                    current = snapshot_manifest(source, self.rules['limits'], self.rules['exclude_paths'])
                    source_drift = changes(self.store.data['input']['manifest'], current)
                except (LoopError, OSError) as exc:
                    source_drift_error = f'原项目收尾核对失败：{type(exc).__name__}: {exc}'
            self.store.finish_run(source_drift=source_drift, source_drift_error=source_drift_error)
            render_views(self.store.root, self.store.rid)
