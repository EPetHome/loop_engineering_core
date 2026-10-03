#!/usr/bin/env python3
"""Human terminal + preparation CLI. No approval/start API is exposed via MCP."""
from __future__ import annotations
import argparse,shlex
import json
import os
from pathlib import Path
import sys

BUNDLE = Path(__file__).resolve().parent
sys.path.insert(0, str(BUNDLE / 'engine'))
from loop_engineering.common import LoopError, FileLock, load_json, atomic_json
from loop_engineering.ledger import Ledger, state_path
from loop_engineering import prep


def maxima_for(rules):
    names = {'member_invocations': 'max_member_invocations', 'selftests': 'max_selftests',
             'gate_executions': 'max_gate_executions', 'repairs': 'max_total_repairs'}
    return {**{k: rules['limits'][v] for k, v in names.items()},
            **{'operation:' + k: v for k, v in rules['operation_budgets'].items()}}


def launch_prepared(state: Path, prepared_id: str, *, approve=False, authorization=None, brief=False):
    from loop_engineering.storage import create_run
    from loop_engineering.supervisor import supervise
    ledger = Ledger(state)
    record = ledger.get('prepared', prepared_id)
    root = Path(record['root'])
    # The lock is deliberately short and held only over claim/create, not a business run.
    with FileLock(ledger.state / 'locks' / (prepared_id + '-launch.lock')):
        try:
            existing = ledger.launch(record['launch_request_id'])
        except LoopError:
            existing = None
        if existing:
            manifest = root / 'runs' / existing['run_id'] / 'manifest.json'
            if not manifest.is_file():
                raise LoopError('启动已认领但创建未完成；待人工核对，不重新分配次数')
            data = load_json(manifest)
            print(json.dumps({'run_id': existing['run_id'], 'already_started': True,
                              'state': data['state'], 'result': str(manifest.parent / 'result.md')}, ensure_ascii=False))
            # Explicitly no supervise/recover/relaunch here.
            return {'PASSED': 0, 'NOT_MET': 2, 'BLOCKED': 3}.get((data.get('result') or {}).get('stop'), 0)
        print(Path(record['preview_path']).read_text(), flush=True)
        print('这会创建真实业务运行；若成员配置连接模型，将消耗账号额度。', flush=True)
        if not approve:
            if not sys.stdin.isatty() or input('确认启动以上精确任务？输入 yes: ').strip() != 'yes':
                raise LoopError('未批准，不创建运行。非交互人工脚本需要显式 --approve')
        try:
            approval = ledger.get('approval', prepared_id)
        except LoopError:
            approval = None
        if approval:
            if authorization and authorization != approval['authorization_id']:
                raise LoopError('该准备已有授权，不能换授权重复计数')
            aid = approval['authorization_id']
        elif authorization:
            auth = ledger.authorization(authorization)
            if auth['project'] != record['project_id']:
                raise LoopError('授权不属于本项目')
            aid = authorization
            ledger.put('approval', prepared_id, {'authorization_id': aid}, create_only=True)
        else:
            aid = ledger.authorize(record['project_id'], maxima_for(record['rules']))
            ledger.put('approval', prepared_id, {'authorization_id': aid}, create_only=True)
        rid = create_run(root, record['rules'], admission={'state': str(ledger.state),
                         'prepared_id': prepared_id, 'authorization_id': aid})
    print(f'运行：{rid}\n授权：{aid}\n结果：{root / "runs" / rid / "result.md"}', flush=True)
    code = supervise(root, rid)
    from run_loop import deliver
    try:
        deliver(root / 'runs' / rid, brief=brief)
    except Exception as exc:
        print('阅读入口生成失败，原始结果保留：' + str(exc), file=sys.stderr)
    return code


def parser():
    p = argparse.ArgumentParser(description='Loop 0.4.0 受控准备与人工启动；MCP无启动权限')
    p.add_argument('--state', type=Path, default=state_path())
    p.add_argument('--version', action='version', version='0.4.0')
    sub = p.add_subparsers(dest='command', required=True)
    r = sub.add_parser('register', help='人工登记一份已审v2项目配置，不调用模型')
    r.add_argument('project_id'); r.add_argument('plan', type=Path); r.add_argument('--root', type=Path, required=True)
    r.add_argument('--require-probe', action='append', default=[])
    r.add_argument('--skip-verify', action='append', default=[], metavar='PROFILE',
                   help='登记时不实际运行该配方；输出声明保持未验证并写入预览')
    r.add_argument('--no-verify', action='store_true', help='完全跳过登记验证（仅限离线夹具）')
    b = sub.add_parser('begin'); b.add_argument('project_id')
    for name in ('check', 'seal'):
        c=sub.add_parser(name); c.add_argument('prep_id'); c.add_argument('--revision', type=int, required=True)
    c=sub.add_parser('patch'); c.add_argument('prep_id'); c.add_argument('changes', type=Path); c.add_argument('--revision', type=int, required=True)
    c=sub.add_parser('probe'); c.add_argument('prep_id'); c.add_argument('question_id'); c.add_argument('--revision',type=int,required=True)
    c=sub.add_parser('status'); c.add_argument('prep_id')
    c=sub.add_parser('budget'); c.add_argument('authorization_id')
    c=sub.add_parser('launch'); c.add_argument('prepared_id'); c.add_argument('--approve',action='store_true'); c.add_argument('--authorization'); c.add_argument('--brief',action='store_true')
    c=sub.add_parser('continue',help='从已停止的多单元运行起草续接计划：去掉已达标单元、从续接单元最新候选接着做；不登记不启动')
    c.add_argument('run_id'); c.add_argument('--root',type=Path,required=True); c.add_argument('--project-id',required=True)
    c.add_argument('--out',type=Path,required=True,help='续接计划文件，必须不存在')
    c.add_argument('--fresh-unit',action='store_true',help='续接单元从其冻结输入重做，不用上次候选')
    d=sub.add_parser('derive',help='从已登记项目起草新计划：规则原样另存，只改 source；不登记不启动')
    d.add_argument('project_id',help='上一轮已登记的项目ID')
    d.add_argument('--project-id',dest='new_project_id',required=True,metavar='NEW_PROJECT_ID',help='新项目ID')
    d.add_argument('--out',type=Path,required=True,help='新计划文件，必须不存在')
    d.add_argument('--source',type=Path,help='换一个源码目录；计划里只改 source')
    d.add_argument('--copy-source',type=Path,help='把源码复制到该新目录（必须不存在）并让计划指向可写副本')
    c=sub.add_parser('serve'); c.add_argument('--socket',type=Path,required=True)
    c=sub.add_parser('plugin-config',help='生成专用准备目录（Codex 与 Claude Code 共用一个插件）')
    c.add_argument('--socket',type=Path,required=True); c.add_argument('--out',type=Path,required=True,help='准备目录，必须不存在')
    c.add_argument('--runtime',type=Path,help='MCP桥读取的运行配置，默认 ~/.loop040/runtime.json')
    sub.add_parser('capabilities')
    sub.add_parser('doctor')
    return p


def main(argv=None):
    args=parser().parse_args(argv)
    state=args.state.expanduser().resolve()
    try:
        name=args.command
        if name=='register':
            result=prep.register_project(state,args.project_id,load_json(args.plan),args.plan.parent,args.root,args.require_probe,
                                         verify=not args.no_verify,skip_verify=args.skip_verify,
                                         log=lambda text:print(text,file=sys.stderr,flush=True))
            result={'id':result['id'],'root':result['root'],'verification':result.get('verification','NOT_RUN (--no-verify)'),
                    'writable_paths':result['writable_paths'],'protected_paths':result['protected_paths']}
        elif name=='begin': result=prep.begin(state,args.project_id)
        elif name=='patch': result=prep.patch(state,args.prep_id,args.revision,load_json(args.changes))
        elif name=='check': result=prep.check(state,args.prep_id,args.revision)
        elif name=='probe': result=prep.probe(state,args.prep_id,args.revision,args.question_id)
        elif name=='seal': result=prep.seal(state,args.prep_id,args.revision)
        elif name=='status': result=Ledger(state).get('prep',args.prep_id)
        elif name=='budget': result=Ledger(state).authorization(args.authorization_id)
        elif name=='continue':
            result=prep.continue_plan(args.root,args.run_id,args.project_id,args.out,fresh_unit=args.fresh_unit)
            q=lambda v:shlex.quote(str(v))
            result['next_commands']=[f'{q(sys.executable)} {q(Path(__file__).resolve())} --state {q(state)} register {q(args.project_id)} {q(result["plan"])} --root {q(Path(args.root).expanduser().resolve())}',
                                     f'{q(sys.executable)} {q(Path(__file__).resolve())} --state {q(state)} begin {q(args.project_id)}',
                                     '再 seal <prep_id> --revision <N>，把返回的启动命令交给用户']
        elif name=='derive':
            result=prep.derive_plan(state,args.project_id,args.new_project_id,args.out,
                                    source=args.source,copy_source=args.copy_source)
        elif name=='launch': return launch_prepared(state,args.prepared_id,approve=args.approve,authorization=args.authorization,brief=args.brief)
        elif name=='serve':
            from loop_engineering.guard_server import serve
            serve(state,args.socket); return 0
        elif name=='capabilities': result=prep.capability_summary()
        elif name=='doctor':
            import shutil
            result={'python':sys.version,'platform':sys.platform,'pi_found':shutil.which('pi'),
                    'strict_sandbox_available':sys.platform=='darwin' and Path('/usr/bin/sandbox-exec').is_file(),
                    'hooks_verified':False,'real_model_verified':False,
                    'note':'仅存在性检查。宿主信任、沙箱实际拒绝与真实模型待人工验收。'}
        else:
            from loop_engineering.plugin_config import generate
            result=generate(args.socket,args.out,**({'runtime':args.runtime} if args.runtime else {}))
        print(json.dumps(result,ensure_ascii=False,indent=2))
        return 0 if not isinstance(result,dict) or result.get('status') not in ('INVALID','NEEDS_CAPABILITY') else 4
    except (LoopError,OSError,ValueError,KeyError,TypeError) as exc:
        print(json.dumps({'error':str(exc),'model_calls':0 if args.command!='launch' else 'unknown'},ensure_ascii=False),file=sys.stderr)
        return 4

if __name__=='__main__':
    raise SystemExit(main())
