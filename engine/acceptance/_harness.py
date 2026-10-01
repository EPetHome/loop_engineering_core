"""验收脚本的公用部分（拍板人写的标准，成员不得修改）。

在临时目录里准备一份示例项目和一个不调模型的成员桩，用**当前这份引擎代码**跑一次完整循环，
再把权威记录读回来给各验收脚本判断。不联网、不调用任何模型、不在引擎目录里留文件。
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

STUB = r'''
import json, os, sys
from pathlib import Path
dev_mode, rev_mode, original = sys.argv[1], sys.argv[2], Path(sys.argv[3])
c = json.load(open(os.environ['LOOP_CONTEXT'], encoding='utf-8'))
role, code, repair = c['role'], Path(c['code_path']), c['protocol_repair_only']
mode = dev_mode if role == 'developer' else rev_mode
GOOD = "def can_resend(status: str, expired: bool) -> bool:\n    return status == 'pending' and expired is True\n"

def deliver(bad_evidence=None):
    rows = []
    for cr in c['unit']['criteria']:
        ev = ['gate:' + cr['gate_ids'][0]] if (role == 'reviewer' and cr['gate_ids']) else ['code:invites.py']
        if bad_evidence:
            ev = ev + [bad_evidence]
        rows.append({'id': cr['id'], 'status': 'PASS', 'note': '验收桩', 'evidence': ev})
    report = {'attempt_id': c['attempt_id'], 'role': role, 'candidate_hash': c['candidate_hash'],
              'summary': '验收桩交付', 'blocked': False, 'criteria': rows, 'issues': [], 'rule_gaps': []}
    Path(c['response_path']).write_text(json.dumps(report, ensure_ascii=False), encoding='utf-8')

wrong = mode == 'bad-always' or (mode == 'bad-once' and not repair)
if role == 'developer':
    if not repair:
        (code / 'invites.py').write_text(GOOD, encoding='utf-8')
        if mode == 'touch-original':
            (original / 'baseline.md').write_text('被循环里的成员改过\n', encoding='utf-8')
        if mode == 'add-original':
            (original / '新增文件.txt').write_text('x', encoding='utf-8')
        if mode == 'delete-original':
            (original / 'tests' / 'test_invites.py').unlink()
        if mode == 'ignored-original':
            (original / '.DS_Store').write_bytes(b'x')
            (original / '__pycache__').mkdir(exist_ok=True)
            (original / '__pycache__' / 'x.pyc').write_bytes(b'x')
    deliver('gate:G1' if wrong else None)          # 开发方引用门禁：引擎必须拒收
else:
    deliver('/tmp/工作区里的某个文件.json' if wrong else None)   # 绝对路径当证据：引擎必须拒收
'''


def _force_remove(func, path, _exc):
    os.chmod(path, stat.S_IRWXU)
    parent = os.path.dirname(path)
    os.chmod(parent, stat.S_IRWXU)
    func(path)


def run_case(dev_mode: str, rev_mode: str, max_protocol_retries: int = 1) -> dict:
    """跑一次循环，返回 {exit_code, run, unit, result_json, result_md, stdout, stderr}。"""
    work = Path(tempfile.mkdtemp(prefix='loop-accept-'))
    try:
        project = work / 'project'
        shutil.copytree(ENGINE / 'examples' / 'demo_project', project)
        stub = work / 'stub_member.py'
        stub.write_text(STUB, encoding='utf-8')
        agent = lambda identity: {'kind': 'command', 'identity': identity, 'output': 'file',
                                  'argv': ['{python}', str(stub), dev_mode, rev_mode, str(project)]}
        task = {
            'schema_version': 1, 'task_id': 'accept', 'title': '验收用例', 'source': str(project),
            'agents': {'dev': agent('accept-developer'), 'review': agent('accept-reviewer')},
            'limits': {'max_wall_seconds': 90, 'max_member_invocations': 12},
            'units': [{
                'id': 'invite', 'goal': '修复邀请重发判断', 'depends_on': [],
                'writable_paths': ['invites.py'], 'protected_paths': ['tests/', 'baseline.md'],
                'developer': 'dev', 'reviewer': 'review',
                'max_repairs': 0, 'max_infra_retries': 0, 'max_protocol_retries': max_protocol_retries,
                'stage_timeout_seconds': 20, 'max_seconds': 80,
                'criteria': [{'id': 'S1', 'text': '四个冻结用例全部通过', 'gate_ids': ['G1']},
                             {'id': 'S2', 'text': '只改 invites.py', 'gate_ids': []}],
                'gates': [{'id': 'G1', 'argv': ['{python}', '-m', 'unittest', 'discover', '-s', 'tests'],
                           'timeout_seconds': 20}],
            }],
        }
        plan = work / 'task.json'
        plan.write_text(json.dumps(task, ensure_ascii=False), encoding='utf-8')
        env = dict(os.environ, LOOP_NO_NOTIFY='1', PYTHONDONTWRITEBYTECODE='1')
        done = subprocess.run([sys.executable, str(ENGINE / 'loop.py'), 'run', str(plan), '--root', str(work / 'data')],
                              capture_output=True, text=True, env=env, timeout=150)
        runs = sorted((work / 'data' / 'runs').iterdir()) if (work / 'data' / 'runs').is_dir() else []
        if len(runs) != 1:
            return {'exit_code': done.returncode, 'run': None, 'unit': None, 'result_json': None, 'result_md': '',
                    'stdout': done.stdout, 'stderr': done.stderr}
        manifest = json.loads((runs[0] / 'manifest.json').read_text(encoding='utf-8'))
        result_json = runs[0] / 'result.json'
        result_md = runs[0] / 'result.md'
        return {'exit_code': done.returncode, 'run': manifest.get('result'), 'unit': manifest['units']['invite'],
                'result_json': json.loads(result_json.read_text(encoding='utf-8')) if result_json.is_file() else None,
                'result_md': result_md.read_text(encoding='utf-8') if result_md.is_file() else '',
                'stdout': done.stdout, 'stderr': done.stderr}
    finally:
        shutil.rmtree(work, onerror=_force_remove)


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
