"""Local CLI. Routine observability invokes no models."""
from __future__ import annotations
import argparse
import copy
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

from . import __version__
from .adapters import ENGINE_DIR, command, program_available
from .audit import audit, export_candidate
from .checksums import checksums
from .common import LoopError, IntegrityError, atomic_json, atomic_write, load_json, lock_busy
from .engine import Controller
from .rules import load_rules, normalize, render_rules
from .storage import create_run, STOP_LABELS
from .supervisor import EXIT_CODES, recover, supervise


def run_id(root: Path, value: str | None) -> str:
    if value and value != 'latest':
        if '/' in value or '\\' in value or value in ('.', '..'):
            raise LoopError('无效运行编号')
        if not (root / 'runs' / value / 'manifest.json').is_file():
            raise LoopError('找不到运行：' + value)
        return value
    entries = list_runs(root)
    if not entries:
        raise LoopError('还没有运行记录')
    return entries[0]['run_id']


def list_runs(root: Path) -> list[dict]:
    entries = []
    for path in (root / 'runs').glob('*/manifest.json'):
        try:
            entries.append(load_json(path))
        except LoopError:
            continue
    return sorted(entries, key=lambda x: x['created_epoch'], reverse=True)


def launch(root: Path, rules: dict, background: bool, as_json=False, parent=None, input_override=None, seed=None) -> int:
    if os.name != 'posix':
        raise LoopError('本版本仅支持 macOS / Linux / WSL 执行；原生 Windows 不启动。')
    rid = create_run(root, rules, parent, input_override, seed)
    run = root / 'runs' / rid
    info = {'run_id': rid, 'root': str(root), 'result_path': str(run / 'result.md'), 'report_path': str(run / 'report.html')}
    if as_json:
        print(json.dumps(info, ensure_ascii=False), flush=True)
    else:
        print(f'运行：{rid}\n结果：{run / "result.md"}\n离线报告：{run / "report.html"}', flush=True)
    if background:
        with (run / 'supervisor.log').open('ab') as log:
            subprocess.Popen([sys.executable, str(ENGINE_DIR / 'loop.py'), '_supervise', rid, '--root', str(root)],
                             stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
        return 0
    code = supervise(root, rid)
    if not as_json:
        d = load_json(run / 'manifest.json')
        print(f'\n停止：{STOP_LABELS[d["result"]["stop"]]}。人工验收未进行。')
    return code


def doctor(plan: Path | None, tools: bool) -> int:
    report = {'engine': __version__, 'python': sys.version.split()[0], 'platform': sys.platform,
              'runtime_supported': os.name == 'posix' and sys.version_info >= (3, 10),
              'credentials': '未验证账户、模型可用性或额度；不会读取/打印密钥', 'tools': {}}
    for name in ('codex', 'pi'):
        path = shutil.which(name)
        item = {'installed': bool(path), 'path': path, 'version': None}
        if path and tools:
            try:
                p = subprocess.run([path, '--version'], capture_output=True, text=True, timeout=8,
                                   env={**os.environ, 'PI_OFFLINE': '1'})
                item['version'] = (p.stdout or p.stderr).strip()[:500]
                item['exit_code'] = p.returncode
            except (OSError, subprocess.SubprocessError) as exc:
                item['error'] = str(exc)
        report['tools'][name] = item
    if plan:
        rules = load_rules(plan)
        report['plan_valid'] = True
        report['source_exists'] = Path(rules['source']).is_dir()
        report['members'] = {}
        for name, agent in rules['agents'].items():
            values = {'python': sys.executable, 'engine': str(ENGINE_DIR), 'code': rules['source'],
                      'workspace': '.', 'context': 'context.json', 'response': 'response.json',
                      'schema': 'schema.json', 'role': 'developer', 'unit': 'doctor'}
            args, _ = command(agent, 'developer', values)
            report['members'][name] = {'program_found': program_available(args), 'executable': args[0]}
    print(json.dumps(report, ensure_ascii=False, indent=2))
    bad_members = any(not x['program_found'] for x in report.get('members', {}).values())
    return 0 if report['runtime_supported'] and report.get('source_exists', True) and not bad_members else 4


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog='loop.py', description='Loop Engineering：启动一次，自动开发/评审，停止交结果。')
    p.add_argument('--version', action='version', version=__version__)
    sub = p.add_subparsers(dest='command', required=True)
    def root_arg(c):
        c.add_argument('--root', type=Path, default=Path('loop-data'), help='运行数据根目录，默认 ./loop-data；不能放在源项目内')
    d = sub.add_parser('doctor', help='环境检查，不调用模型')
    d.add_argument('--plan', type=Path)
    d.add_argument('--check-tools', action='store_true', help='同时运行已安装 CLI 的 --version')
    v = sub.add_parser('validate', help='检查规则格式、边界、依赖，不调用成员')
    v.add_argument('plan', type=Path)
    v.add_argument('--render', type=Path, help='保存自动生成的人读规则')
    for name in ('run', 'start'):
        c = sub.add_parser(name, help='前台受监督运行' if name == 'run' else '启动本地后台监督进程')
        c.add_argument('plan', type=Path)
        root_arg(c)
        c.add_argument('--json', action='store_true')
    d = sub.add_parser('demo', help='离线协议桩演示，不调用真实模型')
    d.add_argument('--dag', action='store_true', help='两个并行单元加一个集成单元')
    root_arg(d)
    d.add_argument('--json', action='store_true')
    for name in ('status', 'result', 'audit', 'recover', 'stop', 'retry'):
        c = sub.add_parser(name, help={'status': '状态总览', 'result': '读取结果', 'audit': '核对保存的指纹',
            'recover': '恢复已失去调度者的运行并补齐结果', 'stop': '请求本地进程停止并交结果',
            'retry': '创建新运行；单单元复用合法候选代码，不继承评审'}[name])
        c.add_argument('run_id', nargs='?', default='latest')
        root_arg(c)
        if name in ('status', 'audit', 'retry'):
            c.add_argument('--json', action='store_true')
        if name == 'status':
            c.add_argument('--all', action='store_true')
        if name == 'retry':
            c.add_argument('--background', action='store_true')
    e = sub.add_parser('export', help='总收尾有效通过且审计完整后导出已达标候选；不覆盖已有目录')
    e.add_argument('run_id', nargs='?', default='latest')
    e.add_argument('--to', type=Path, required=True)
    e.add_argument('--unit')
    root_arg(e)
    init = sub.add_parser('init', help='创建待填写的真实任务规则，不自动运行')
    init.add_argument('--source', type=Path, required=True)
    init.add_argument('--out', type=Path, default=Path('task.json'))
    sub.add_parser('selftest', help='运行随包自动化测试，不调用真实模型')
    sums = sub.add_parser('checksums', help='核对引擎目录的 SHA256SUMS，不调用模型')
    sums.add_argument('--write', action='store_true', help='按当前普通文件重新生成 SHA256SUMS')
    for name in ('_worker', '_supervise'):
        c = sub.add_parser(name, help=argparse.SUPPRESS)
        c.add_argument('run_id')
        root_arg(c)
    return p


def main(argv=None) -> int:
    os.umask(0o077)
    args = build_parser().parse_args(argv)
    try:
        cmd = args.command
        if cmd == 'doctor':
            return doctor(args.plan, args.check_tools)
        if cmd == 'checksums':
            return checksums(ENGINE_DIR, args.write)
        if cmd == 'validate':
            r = load_rules(args.plan)
            if args.render:
                if args.render.exists():
                    raise LoopError('输出已存在，拒绝覆盖：' + str(args.render))
                atomic_write(args.render, render_rules(r))
            print('规则结构、依赖与边界检查通过。业务口径和模型凭据尚未验证。')
            return 0
        if cmd == 'init':
            if args.out.exists():
                raise LoopError('规则文件已存在，拒绝覆盖')
            r = load_json(ENGINE_DIR / 'templates' / 'task.template.json')
            r['source'] = str(args.source.expanduser().resolve())
            atomic_json(args.out, r)
            print(f'已创建 {args.out}。请与拍板人填写 TODO，确认后 validate，再 run/start。')
            return 0
        if cmd == 'selftest':
            return subprocess.call([sys.executable, '-m', 'unittest', 'discover', '-s', str(ENGINE_DIR / 'tests'), '-v'], cwd=ENGINE_DIR)
        root = args.root.expanduser().resolve()
        if cmd in ('run', 'start'):
            return launch(root, load_rules(args.plan), cmd == 'start', args.json)
        if cmd == 'demo':
            print('离线协议桩演示：不会调用 Pi、Codex 或付费 API。', file=sys.stderr)
            file = 'dag.json' if args.dag else 'demo.json'
            return launch(root, load_rules(ENGINE_DIR / 'examples' / file), False, args.json)
        rid = run_id(root, args.run_id)
        run = root / 'runs' / rid
        if cmd == '_worker':
            Controller(root, rid).execute()
            return 0
        if cmd == '_supervise':
            return supervise(root, rid)
        if cmd == 'status':
            records = list_runs(root) if args.all else [load_json(run / 'manifest.json')]
            if args.json:
                print(json.dumps(records, ensure_ascii=False, indent=2))
            else:
                for data in records:
                    current_run = root / 'runs' / data['run_id']
                    state = STOP_LABELS[data['result']['stop']] if data['result'] else data['state']
                    live = lock_busy(current_run / 'supervisor.lock') or lock_busy(current_run / 'owner.lock')
                    if data['state'] != 'TERMINAL' and not live:
                        state += ' / 未检测到持锁进程，可 recover'
                    print(f'\n{data["run_id"]} | {state}')
                    if data['result']:
                        finalization = data['result'].get('finalization') or {}
                        print('  总收尾核对：' + finalization.get('status', 'UNKNOWN（旧记录未确认）'))
                    for uid, u in data['units'].items():
                        label = STOP_LABELS[u['result']['stop']] if u['result'] else u['phase']
                        print(f'  {uid:18} {label:14} round={u["round"]} calls={u["stats"]["member_invocations"]}'
                              f'  last_step={u.get("last_step_at", "—")} last_output={u.get("last_output_at", "—")}')
                        activity = u.get('member_activity') or {}
                        print(f'    member_stage={activity.get("phase", "unknown")}'
                              f' last_event={activity.get("last_event_at") or "未知"}'
                              f' basis={activity.get("basis") or "无事件依据"}'
                              f' tools={json.dumps(activity.get("tool_calls", []), ensure_ascii=False)}')
                        if u.get('member_usage'):
                            print('    member_usage=' + json.dumps(u['member_usage'], ensure_ascii=False))
            return 0
        if cmd == 'result':
            data = load_json(run / 'manifest.json')
            if data['state'] != 'TERMINAL':
                print('运行尚未停止；使用 status 查看状态。')
                return 1
            from .storage import markdown_result
            print(markdown_result(data))
            return 0
        if cmd == 'audit':
            check = audit(root, rid)
            print(json.dumps(check, ensure_ascii=False, indent=2))
            return 0 if check['integrity_ok'] else 5
        if cmd == 'recover':
            result = recover(root, rid)
            finalization = result.get('finalization') or {}
            print('已生成结果：' + str(run / 'result.md') + '\n总收尾核对：' + finalization.get('status', 'UNKNOWN（旧记录未确认）'))
            return EXIT_CODES[result['stop']]
        if cmd == 'stop':
            if load_json(run / 'manifest.json')['state'] == 'TERMINAL':
                print('运行已经停止；结果不变。')
            else:
                atomic_write(run / 'cancel', 'explicit user stop\n')
                print('停止请求已写入。监督/执行器会收尾；没有存活调度者时使用 recover。')
            return 0
        if cmd == 'retry':
            data = load_json(run / 'manifest.json')
            if data['state'] != 'TERMINAL':
                raise LoopError('上一运行尚未停止；先检查 status 或 recover')
            rules = load_json(run / 'rules.json')
            # Damaged rules must not be silently reused.
            from .common import digest
            if digest(rules) != data['rule_hash']:
                raise IntegrityError('旧规则已经被修改，不能 retry；请修复正本后按新规则启动')
            if not data.get('input'):
                return launch(root, rules, args.background, args.json, parent=rid)
            check = audit(root, rid)
            if not check['integrity_ok']:
                raise IntegrityError('旧记录完整性检查失败，不能复用检查点：' + '; '.join(check['errors'][:3]))
            seed = None
            if len(rules['units']) == 1:
                seed = next(iter(data['units'].values()))['result'].get('candidate')
                if seed:
                    from .engine import verify_candidate
                    verify_candidate(seed, rules['limits'])
            return launch(root, rules, args.background, args.json, parent=rid,
                          input_override=data['input']['path'], seed=seed)
        if cmd == 'export':
            target = export_candidate(root, rid, args.to, args.unit)
            print('已导出到新目录：' + str(target) + '\n未修改原始项目或基线；由拍板人决定是否合并。')
            return 0
    except (LoopError, OSError, KeyError, ValueError) as exc:
        print(f'错误：{exc}', file=sys.stderr)
        return 4
    return 4
