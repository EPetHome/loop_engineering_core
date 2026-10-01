"""One authoritative manifest per run. Markdown and HTML are rebuildable views."""
from __future__ import annotations
import copy
import html
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import threading
import time
import uuid

from . import __version__
from .common import (LoopError, IntegrityError, atomic_json, atomic_write, canonical, digest,
                     file_hash, FileLock, load_json, now, tree_manifest)
from .rules import render_rules
from .protocol import response_schema

STOP_LABELS = {'PASSED': '达标', 'NOT_MET': '未达标', 'BLOCKED': '推不动', 'NOT_RUN': '未执行'}


def engine_identity() -> dict:
    root = Path(__file__).resolve().parent
    files = {p.name: file_hash(p) for p in sorted(root.glob('*.py'))}
    return {'version': __version__, 'sha256': digest(files), 'files': files}


def create_run(root: Path, rules: dict, parent: str | None = None,
               input_override: str | None = None, seed: dict | None = None) -> str:
    source = Path(rules['source']).resolve()
    root = root.expanduser().resolve()
    if root == source or root.is_relative_to(source):
        raise LoopError('运行数据根目录不能位于源项目内部；请选择项目旁边的目录。')
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(root, 0o700)
    rid = rules['task_id'] + '-' + time.strftime('%Y%m%dT%H%M%S', time.gmtime()) + '-' + uuid.uuid4().hex[:8]
    run = root / 'runs' / rid
    run.mkdir(parents=True, mode=0o700)
    atomic_json(run / 'rules.json', rules, readonly=True)
    atomic_write(run / 'rules.md', render_rules(rules), readonly=True)
    atomic_json(run / 'response.schema.json', response_schema(), readonly=True)
    manifest = {'schema_version': 1, 'run_id': rid, 'task_id': rules['task_id'], 'title': rules['title'],
                'state': 'CREATED', 'created_at': now(), 'created_epoch': time.time(),
                'max_wall_seconds': rules['limits']['max_wall_seconds'],
                'engine': engine_identity(), 'rule_hash': digest(rules),
                'parent_run': parent, 'input_override': input_override, 'seed_candidate': seed,
                'budget': {'member_invocations': 0}, 'input': None,
                'environment': {'python': sys.version, 'platform': platform.platform(), 'executable': sys.executable},
                'integrity': {str(p.relative_to(run)): file_hash(p) for p in
                              [run / 'rules.json', run / 'rules.md', run / 'response.schema.json']},
                'units': {u['id']: {'state': 'PENDING', 'phase': 'pending', 'round': 0,
                                  'criterion_ids': [c['id'] for c in u['criteria']],
                                  'stats': {'member_invocations': 0, 'repairs': 0, 'infra_retries': 0,
                                            'protocol_retries': 0,
                                            'protocol_retries_by_role': {'developer': 0, 'reviewer': 0}},
                                  'result': None} for u in rules['units']},
                'result': None}
    atomic_json(run / 'manifest.json', manifest)
    return rid


class Store:
    def __init__(self, root: Path, rid: str):
        self.root, self.rid = root.resolve(), rid
        self.run = self.root / 'runs' / rid
        self.data = load_json(self.run / 'manifest.json')
        self.lock = threading.RLock()

    def commit(self):
        atomic_json(self.run / 'manifest.json', self.data)

    def event(self, kind: str, uid: str | None = None, **details):
        with self.lock:
            record = {'time': now(), 'event': kind, 'unit_id': uid, **details}
            with (self.run / 'events.jsonl').open('ab') as f:
                f.write(canonical(record) + b'\n')
                f.flush()
                os.fsync(f.fileno())

    def patch(self, **values):
        with self.lock:
            if self.data['state'] == 'TERMINAL':
                raise IntegrityError('终态清单不可修改')
            self.data.update(values)
            self.commit()

    def unit(self, uid: str, **values):
        with self.lock:
            target = self.data['units'][uid]
            if target['state'] == 'TERMINAL':
                raise IntegrityError(f'单元 {uid} 的终态不可修改')
            target.update(values)
            self.commit()

    def counter(self, uid: str, key: str):
        with self.lock:
            self.data['units'][uid]['stats'][key] += 1
            self.commit()

    def protocol_retry(self, uid: str, role: str):
        with self.lock:
            stats = self.data['units'][uid]['stats']
            stats['protocol_retries'] += 1
            stats['protocol_retries_by_role'][role] += 1
            self.commit()

    def reserve_call(self, uid: str, maximum: int) -> bool:
        with self.lock:
            if self.data['budget']['member_invocations'] >= maximum:
                return False
            self.data['budget']['member_invocations'] += 1
            self.data['units'][uid]['stats']['member_invocations'] += 1
            self.commit()
            return True

    def seal(self, path: Path):
        with self.lock:
            relative = path.relative_to(self.run).as_posix()
            self.data['integrity'][relative] = file_hash(path)
            os.chmod(path, 0o400)
            self.commit()

    def assert_integrity(self):
        with self.lock:
            entries = dict(self.data['integrity'])
        for relative, expected in entries.items():
            p = self.run / relative
            if p.is_symlink() or not p.is_file() or file_hash(p) != expected:
                raise IntegrityError('冻结文件发生变化：' + relative)
        if engine_identity()['sha256'] != self.data['engine']['sha256']:
            raise IntegrityError('引擎运行期间自身代码发生变化')

    def finish_unit(self, uid: str, result: dict):
        with self.lock:
            state = self.data['units'][uid]
            if state['state'] == 'TERMINAL':
                return
            result.update(unit_id=uid, run_id=self.rid, rule_hash=self.data['rule_hash'],
                          stats=copy.deepcopy(state['stats']), finished_at=now())
            state.update(state='TERMINAL', phase='terminal', result=result, last_step_at=now())
            self.commit()  # status + full result are in the same atomic record
            self.event('unit_stopped', uid, stop=result['stop'], reason=result['reason'])

    def finish_run(self, source_drift: list[str] | None = None, source_drift_error: str | None = None):
        with self.lock:
            if self.data['state'] == 'TERMINAL':
                return
            results = {k: v['result'] for k, v in self.data['units'].items()}
            if any(v is None for v in results.values()):
                raise IntegrityError('仍有未收尾单元，不能提交总结果')
            values = [v['stop'] for v in results.values()]
            stop = 'PASSED' if all(v == 'PASSED' for v in values) else ('BLOCKED' if 'BLOCKED' in values else 'NOT_MET')
            source_drift = source_drift or []
            if self.data.get('final_integrity_error') or source_drift or source_drift_error:
                stop = 'BLOCKED'
            summary = '；'.join(f'{k}：{STOP_LABELS[v["stop"]]}' for k, v in results.items())
            if source_drift:
                summary += '；原项目发生变化，请核对 source_drift 列出的路径；未自动还原。'
            if source_drift_error:
                summary += '；' + source_drift_error
            self.data.update(state='TERMINAL', result={
                'stop': stop, 'finished_at': now(), 'run_id': self.rid, 'summary': summary,
                'source_drift': source_drift, 'source_drift_error': source_drift_error,
                'elapsed_seconds': round(time.time() - self.data['created_epoch'], 3),
                'member_invocations': self.data['budget']['member_invocations'],
                'token_usage': None, 'cost': None,
                'cost_note': '只统计成员进程调用；不等于模型 API 请求数。token 和费用未计量。',
                'human_acceptance': 'NOT_PERFORMED', 'integrity_error': self.data.get('final_integrity_error')})
            self.commit()
            self.event('run_stopped', stop=stop)


def markdown_result(data: dict) -> str:
    r = data['result']
    lines = [f'# Loop 结果：{data["title"]}', '',
             f'**停止类型：{STOP_LABELS[r["stop"]]}**', '', r['summary'], '',
             f'- 运行：`{data["run_id"]}`', f'- 父运行：`{data["parent_run"] or "无"}`',
             f'- 规则指纹：`{data["rule_hash"]}`', f'- 引擎：`{data["engine"]["version"]}`',
             f'- 成员调用：{r["member_invocations"]}；总耗时：{r["elapsed_seconds"]} 秒。',
             '- token / 金额：未计量。一次成员调用可能包含多次模型请求。',
             '- 人工验收：未进行。达标不等于拍板人已认可；不自动合并、不更新基线。',
             '', '最终完整性异常：' + str(r.get('integrity_error') or '未发现'), '',
             '## 原项目收尾核对', '', '核对异常：' + str(r.get('source_drift_error') or '未记录'), '']
    if r.get('source_drift'):
        lines += ['变动路径（source_drift，未自动还原）：', '']
        lines += [f'- `{rel}`' for rel in r['source_drift']]
    else:
        lines += ['source_drift：`[]`（未列出差异；故障恢复补写结果时不做核对）。']
    lines += ['', '## 单元结果', '']
    for uid, state in data['units'].items():
        v = state['result']
        lines += [f'### {uid} — {STOP_LABELS[v["stop"]]}', '', v['reason'], '']
        if v.get('candidate'):
            c = v['candidate']
            lines += [f'- 候选代码：`{c["path"]}`', f'- 候选指纹：`{c["hash"]}`',
                      f'- 已评审本候选：{v.get("reviewed", False)}',
                      f'- 改动清单：`{c["metadata_path"]}`', '']
        lines += ['| 标准 | 最终状态 | 说明 | 证据 |', '|---|---|---|---|']
        for row in v.get('criteria', []):
            clean = lambda value: str(value).replace('|', '／').replace('\n', '<br>')
            lines.append('| ' + ' | '.join(clean(row.get(k, '')) for k in ('id', 'status', 'note', 'evidence')) + ' |')
        lines += ['', '规则缺口：' + ('；'.join(v.get('rule_gaps', [])) or '未记录'),
                  '', '计数：`' + json.dumps(v['stats'], ensure_ascii=False) + '`', '']
        if v.get('evidence'):
            lines += ['证据索引（当前候选绑定）：', '', '```json',
                      json.dumps(v['evidence'], ensure_ascii=False, indent=2), '```', '']
        if v.get('last_reviewed_candidate') and not v.get('reviewed'):
            lines += ['上次评审对象与当前候选不同；不继承上次通过。', '']
    lines += ['## 边界', '',
              '本结果仅基于冻结标准、当前候选代码和本次证据。原始项目未由引擎覆盖。',
              '同账号防误改不是安全沙箱。未支持脱离进程组的后台作业、生产发布和外部不可逆动作。',
              '完整过程见 events.jsonl 与 units/<单元>/。manifest.json 是权威记录，其他文件可重新生成。', '']
    return '\n'.join(lines)


def render_views(root: Path, rid: str) -> None:
    run = root / 'runs' / rid
    data = load_json(run / 'manifest.json')
    if data['state'] != 'TERMINAL':
        return
    md = markdown_result(data)
    atomic_write(run / 'result.md', md, readonly=True)
    atomic_json(run / 'result.json', data['result'], readonly=True)
    for uid, state in data['units'].items():
        atomic_json(run / 'units' / uid / 'result.json', state['result'], readonly=True)
    document = '''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Loop Engineering 运行结果</title><style>body{font:16px/1.75 system-ui,sans-serif;max-width:1100px;margin:40px auto;padding:0 24px;background:#f4f5f7;color:#20252c}header{border-bottom:3px solid #35496d;padding-bottom:18px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:white;border:1px solid #d7dce3;border-radius:12px;padding:28px;font:14px/1.8 ui-monospace,monospace}.small{font-size:13px;color:#5d6675}</style><header><h1>Loop Engineering</h1><p>停止交结果 · 人工验收在循环之外</p></header><p class="small">离线只读报告；不会联网、执行代码或自动刷新。</p><pre>'''
    document += html.escape(md) + '</pre></html>'
    atomic_write(run / 'report.html', document, readonly=True)
    with FileLock(root / 'latest.lock'):
        atomic_json(root / 'latest.json', {'run_id': rid, 'result': str(run / 'result.md'), 'updated_at': now()})
        atomic_write(root / 'latest.md', f'# 最近生成的结果\n\n运行：{rid}\n\n结果：{run / "result.md"}\n\n报告：{run / "report.html"}\n')


def notify(root: Path, rid: str) -> None:
    run = root / 'runs' / rid
    data = load_json(run / 'manifest.json')
    notification = run / 'notification.json'
    if notification.exists():
        return
    title, message = 'Loop Engineering', STOP_LABELS[data['result']['stop']] + '：' + data['title']
    outcome = {'attempted_at': now(), 'delivered': False}
    try:
        if os.environ.get('LOOP_NO_NOTIFY') == '1':
            outcome['reason'] = 'disabled_by_environment'
        elif sys.platform == 'darwin':
            script = 'on run argv\ndisplay notification (item 2 of argv) with title (item 1 of argv)\nend run'
            p = subprocess.run(['osascript', '-e', script, title, message], capture_output=True, timeout=4)
            outcome.update(delivered=p.returncode == 0, exit_code=p.returncode)
        elif sys.platform.startswith('linux'):
            p = subprocess.run(['notify-send', title, message], capture_output=True, timeout=4)
            outcome.update(delivered=p.returncode == 0, exit_code=p.returncode)
        else:
            outcome['reason'] = 'platform_not_supported'
    except (OSError, subprocess.SubprocessError) as exc:
        outcome['reason'] = str(exc)
    atomic_json(notification, outcome)
