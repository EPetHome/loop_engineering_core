"""迭代 02 验收脚本的公用部分（拍板人写的标准，成员不得修改）。

和 _harness.py 一样：在临时目录里准备示例项目和不调模型的成员桩，用**当前这份引擎代码**
跑一次完整循环，把权威记录读回来。不联网、不调用任何模型、不在引擎目录里留文件。
比 _harness.py 多出来的：门禁可以按「第几次执行」安排通过或失败；成员桩会把自己看到的
上下文记下来；可以在清理之前对运行目录再做动作（例如改一个证据文件后跑 audit）。
"""
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
from pathlib import Path

ENGINE = Path(__file__).resolve().parents[1]

# 门禁桩：按 plan.json 里给这个门禁排好的结果，第 n 次执行取第 n 个（用完后重复最后一个）。
# 结果写法：pass ｜ fail（不写原因）｜ fail:<原因> ｜ sleep（睡到超时）
FLAKY_GATE = r'''
import json, sys, time
from pathlib import Path
plan_path, gate = Path(sys.argv[1]), sys.argv[2]
plan = json.loads(plan_path.read_text(encoding='utf-8'))[gate]
counter = plan_path.parent / ('count-' + gate)
n = int(counter.read_text()) if counter.exists() else 0
counter.write_text(str(n + 1))
outcome = plan[min(n, len(plan) - 1)]
print('门禁桩 %s 第 %d 次执行：%s' % (gate, n + 1, outcome), flush=True)
if outcome == 'sleep':
    time.sleep(60)
if outcome == 'pass':
    sys.exit(0)
if outcome.startswith('fail:'):
    print('一些别的输出')
    print('LOOP_FAIL_REASON=' + outcome[5:])
sys.exit(1)
'''

STUB = r'''
import json, os, sys
from pathlib import Path
dev_mode, rev_mode, work = sys.argv[1], sys.argv[2], Path(sys.argv[3])
c = json.load(open(os.environ['LOOP_CONTEXT'], encoding='utf-8'))
role, code, repair = c['role'], Path(c['code_path']), c['protocol_repair_only']
mode = dev_mode if role == 'developer' else rev_mode
GOOD = "def can_resend(status: str, expired: bool) -> bool:\n    return status == 'pending' and expired is True\n"
scratch = c.get('scratch_path', '（上下文里没有 scratch_path 这个键）')
is_dir = isinstance(scratch, str) and Path(scratch).is_dir()

saw = {'role': role, 'round': c['round'], 'repair': repair, 'scratch_path': scratch,
       'scratch_is_dir': is_dir, 'scratch_writable': bool(is_dir and os.access(scratch, os.W_OK)),
       'env_scratch': os.environ.get('LOOP_SCRATCH'), 'code_path': c['code_path'],
       'workspace_path': c['workspace_path'], 'gate_evidence': c.get('gate_evidence')}
n = len(list(work.glob('saw-*.json')))
(work / ('saw-%03d-%s.json' % (n, role))).write_text(json.dumps(saw, ensure_ascii=False), encoding='utf-8')

def deliver(extra=None, only=None):
    rows = []
    for cr in c['unit']['criteria']:
        if role == 'reviewer' and cr['gate_ids']:
            ev = ['gate:' + g for g in cr['gate_ids']]
        elif only:
            ev = [only]
        else:
            ev = ['code:invites.py']
        if extra:
            ev = ev + [extra]
        rows.append({'id': cr['id'], 'status': 'PASS', 'note': '验收桩', 'evidence': ev})
    report = {'attempt_id': c['attempt_id'], 'role': role, 'candidate_hash': c['candidate_hash'],
              'summary': '验收桩交付', 'blocked': False, 'criteria': rows, 'issues': [], 'rule_gaps': []}
    Path(c['response_path']).write_text(json.dumps(report, ensure_ascii=False), encoding='utf-8')

def put(relative, body):
    target = Path(scratch) / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(body, encoding='utf-8')

if role == 'developer':
    if not repair:
        (code / 'invites.py').write_text(GOOD, encoding='utf-8')
    deliver('scratch:x.txt' if mode == 'cite-scratch' else None)
elif mode == 'good':
    deliver()
elif mode == 'scratch-ok':
    put('取证/sessions.json', '{"取证": "评审方自己跑命令得到的结果"}\n')
    deliver(only='scratch:取证/sessions.json')
elif mode == 'scratch-not-written':
    deliver(extra='scratch:x.txt')
elif mode == 'scratch-escape':
    deliver(extra='scratch:../context.json')
elif mode == 'scratch-symlink':
    os.symlink('/etc/hosts', Path(scratch) / 'link.txt')
    deliver(extra='scratch:link.txt')
elif mode == 'mutate-code':
    put('note.txt', 'x\n')
    target = code / 'invites.py'
    os.chmod(code, 0o700)
    os.chmod(target, 0o600)
    target.write_text('被评审方改过\n', encoding='utf-8')
    deliver(only='scratch:note.txt')
elif mode == 'scratch-big':
    put('big.txt', 'x' * 10240)
    deliver(only='scratch:big.txt')
elif mode == 'scratch-bad-once':
    if not repair:
        put('first.txt', '第一次尝试里取到的证据\n')
        deliver(extra='/tmp/绝对路径不是合法证据.json')
    else:
        deliver(only='scratch:first.txt')
else:
    raise SystemExit('未知桩模式：' + mode)
'''


def _force_remove(func, path, _exc):
    os.chmod(path, stat.S_IRWXU)
    os.chmod(os.path.dirname(path), stat.S_IRWXU)
    func(path)


def _read(path: Path):
    return json.loads(path.read_text(encoding='utf-8')) if path.is_file() else None


def engine_cli(*args, cwd=None, timeout=120):
    env = dict(os.environ, LOOP_NO_NOTIFY='1', PYTHONDONTWRITEBYTECODE='1')
    return subprocess.run([sys.executable, str(ENGINE / 'loop.py'), *args], capture_output=True, text=True,
                          env=env, cwd=cwd, timeout=timeout)


def base_task(project: Path, stub: Path, work: Path, dev: str, rev: str) -> dict:
    agent = lambda identity: {'kind': 'command', 'identity': identity, 'output': 'file',
                              'argv': ['{python}', str(stub), dev, rev, str(work)]}
    return {
        'schema_version': 1, 'task_id': 'accept2', 'title': '迭代 02 验收用例', 'source': str(project),
        'agents': {'dev': agent('accept-developer'), 'review': agent('accept-reviewer')},
        'limits': {'max_wall_seconds': 120, 'max_member_invocations': 12},
        'units': [{
            'id': 'invite', 'goal': '修复邀请重发判断', 'depends_on': [],
            'writable_paths': ['invites.py'], 'protected_paths': ['tests/', 'baseline.md'],
            'developer': 'dev', 'reviewer': 'review',
            'max_repairs': 0, 'max_infra_retries': 0, 'max_protocol_retries': 0,
            'stage_timeout_seconds': 20, 'max_seconds': 100,
            'criteria': [{'id': 'S1', 'text': '四个冻结用例全部通过', 'gate_ids': ['G1']},
                         {'id': 'S2', 'text': '只改 invites.py', 'gate_ids': []}],
            'gates': [{'id': 'G1', 'argv': ['{python}', '-m', 'unittest', 'discover', '-s', 'tests'],
                       'timeout_seconds': 20}],
        }],
    }


def flaky(work: Path, gate_id: str, **extra) -> dict:
    """一个按 plan 表现的门禁；extra 可带 max_reruns、timeout_seconds 等。"""
    gate = {'id': gate_id, 'argv': ['{python}', str(work / 'flaky_gate.py'), str(work / 'plan.json'), gate_id],
            'timeout_seconds': 20}
    gate.update(extra)
    return gate


def run_task(dev='good', rev='good', plan=None, customize=None, after=None) -> dict:
    """跑一次循环。

    plan：{门禁ID: [结果, ...]}，给按次数表现的门禁用。
    customize(task, work)：在启动前改规则（加门禁、改上限、开关）。
    after(work, run_dir)：循环停下之后、清理之前执行，返回值放进结果的 'after'。
    """
    work = Path(tempfile.mkdtemp(prefix='loop-accept2-'))
    try:
        project = work / 'project'
        shutil.copytree(ENGINE / 'examples' / 'demo_project', project)
        stub = work / 'stub_member.py'
        stub.write_text(STUB, encoding='utf-8')
        (work / 'flaky_gate.py').write_text(FLAKY_GATE, encoding='utf-8')
        (work / 'plan.json').write_text(json.dumps(plan or {}, ensure_ascii=False), encoding='utf-8')
        task = base_task(project, stub, work, dev, rev)
        if customize:
            customize(task, work)
        plan_path = work / 'task.json'
        plan_path.write_text(json.dumps(task, ensure_ascii=False), encoding='utf-8')
        done = engine_cli('run', str(plan_path), '--root', str(work / 'data'), timeout=200)
        runs = sorted((work / 'data' / 'runs').iterdir()) if (work / 'data' / 'runs').is_dir() else []
        out = {'exit_code': done.returncode, 'stdout': done.stdout, 'stderr': done.stderr, 'run': None, 'unit': None,
               'result_json': None, 'result_md': '', 'saw': [], 'gates': {}, 'prompts': {}, 'after': None}
        if len(runs) != 1:
            return out
        run_dir = runs[0]
        manifest = _read(run_dir / 'manifest.json') or {}
        out.update(run=manifest.get('result'), unit=(manifest.get('units') or {}).get('invite'),
                   result_json=_read(run_dir / 'result.json'),
                   result_md=(run_dir / 'result.md').read_text(encoding='utf-8') if (run_dir / 'result.md').is_file() else '')
        out['saw'] = [_read(p) for p in sorted(work.glob('saw-*.json'))]
        for path in sorted((run_dir / 'units' / 'invite' / 'gates').glob('*/evidence.json')):
            out['gates'][path.parent.name] = _read(path)
        for path in sorted((run_dir / 'units' / 'invite' / 'attempts').glob('*/job/stdin.txt')):
            out['prompts'][path.parent.parent.name] = path.read_text(encoding='utf-8')
        if after:
            out['after'] = after(work, run_dir)
        return out
    finally:
        shutil.rmtree(work, onerror=_force_remove)


def validate_task(customize) -> int:
    """只做规则检查（loop.py validate），返回退出码。"""
    work = Path(tempfile.mkdtemp(prefix='loop-accept2-'))
    try:
        project = work / 'project'
        shutil.copytree(ENGINE / 'examples' / 'demo_project', project)
        task = base_task(project, work / 'stub_member.py', work, 'good', 'good')
        customize(task, work)
        plan_path = work / 'task.json'
        plan_path.write_text(json.dumps(task, ensure_ascii=False), encoding='utf-8')
        return engine_cli('validate', str(plan_path)).returncode
    finally:
        shutil.rmtree(work, onerror=_force_remove)


def stop(case) -> str:
    return (case['run'] or {}).get('stop')


def stats(case) -> dict:
    return (case['unit'] or {}).get('stats', {})


def reason(case) -> str:
    return ((case['unit'] or {}).get('result') or {}).get('reason', '')


class Checker:
    def __init__(self, title: str):
        self.title, self.failures, self.count = title, [], 0

    def expect(self, case: str, what: str, actual, expected):
        self.count += 1
        ok = actual == expected
        print(('  通过 ' if ok else '  不通过 ') + f'[{case}] {what}：实际 {actual!r}' + ('' if ok else f'，应为 {expected!r}'))
        if not ok:
            self.failures.append(f'[{case}] {what}')

    def expect_true(self, case: str, what: str, condition, detail=''):
        self.count += 1
        print(('  通过 ' if condition else '  不通过 ') + f'[{case}] {what}' + ('' if condition else f'：{detail}'))
        if not condition:
            self.failures.append(f'[{case}] {what}')

    def finish(self) -> int:
        print(f'\n{self.title}：{self.count - len(self.failures)}/{self.count} 项通过')
        for failure in self.failures:
            print('  未通过：' + failure)
        return 1 if self.failures else 0
