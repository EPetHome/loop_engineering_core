"""No-model task preparation. RPC exposes preparation, never approval or launch."""
from __future__ import annotations
import copy
import json
import os
import re
from pathlib import Path
import shlex
import shutil
import stat
import sys
import time
import uuid
from .common import LoopError, FileLock, atomic_json, atomic_write, digest, load_json, matches, now
from .ledger import Ledger
from .rules import normalize, render_rules
from .admission import inspect_input, installation_identity
from .capabilities import capability_summary, compile_unit, unit_selftest_cap, round_selftest_cap
from .adapters import managed_tools
from .sessions import supports_reuse

MAX_ACTIONS = 40


def _tail(path: Path, lines: int = 25) -> str:
    try:
        data = path.read_bytes()[-16384:].decode('utf-8', 'replace')
    except OSError:
        return ''
    return '\n'.join(data.splitlines()[-lines:])


def verification_targets(rules: dict, skip: list[str] = ()) -> tuple[list[str], dict]:
    """Profiles a unit really uses. Budgeted scenario-only profiles need a human decision."""
    used, plain = set(), set()
    for u in rules['units']:
        used.update(u.get('build_profiles', []))
        plain.update(u.get('build_profiles', []))
        for g in u.get('gates', []):
            if g.get('profile'):
                used.add(g['profile'])
                if not g.get('budget_key'):
                    plain.add(g['profile'])
    unknown = sorted(set(skip) - set(rules['execution_profiles']))
    if unknown:
        raise LoopError('--skip-verify 引用了不存在的配方：' + ', '.join(unknown))
    skipped = {n: '人工 --skip-verify' for n in skip if n in used}
    skipped.update({n: '仅被带 budget_key 的场景门禁使用，登记时不自动执行' for n in used - plain - set(skip)})
    return sorted(plain - set(skip)), skipped


def verify_profiles(state: Path, project_id: str, rules: dict, skip: list[str] = (), log=None) -> dict:
    """Run every used profile once on the current source, through the same executor as gates.

    A profile counts as verified only if it really ran: required reports exist and, when it
    declares outputs, at least one appeared. A non-zero exit with that evidence is reported as
    VERIFIED_NONZERO (feature may not exist yet). Anything else -- missing reports, no output at
    all, undeclared outputs, timeouts, sandbox/config errors -- rejects the registration before
    any model time is spent. A profile that cannot run on the current source must be skipped
    explicitly with --skip-verify; it is then shown as unverified in the preview.
    """
    from .execution import execute_recipe
    from .common import copy_manifest
    targets, skipped = verification_targets(rules, skip)
    base = Path(state) / 'registrations' / (project_id + '-' + uuid.uuid4().hex[:8])
    manifest = inspect_input(rules)
    frozen = base / 'input'
    copy_manifest(Path(rules['source']), frozen, manifest)
    if inspect_input(rules) != manifest:
        raise LoopError('登记验证复制期间原始输入改变')
    results, failed = {}, []
    for name in targets:
        profile = rules['execution_profiles'][name]
        if log:
            log(f'登记验证：运行配方 {name}（上限 {profile["timeout_seconds"]} 秒，不调用模型）')
        execution = base / name
        record = execute_recipe(frozen, manifest, profile, execution, rules['limits'], purpose='REGISTER',
                                security=rules['security'], deadline=time.time() + profile['timeout_seconds'],
                                cancel_file=base / 'cancel', binding={'project_id': project_id})
        ok = record['reason'] in ('ok', 'nonzero_exit')
        entry = {'status': ('VERIFIED' if record['reason'] == 'ok' else 'VERIFIED_NONZERO') if ok else 'FAILED',
                 'reason': record['reason'], 'error': record.get('error'),
                 'outputs': record.get('outputs', []), 'receipt': str(execution / 'build-receipt.json'),
                 'profile_key': _probe_key(rules, name)}
        if ok and profile['output_paths'] and not entry['outputs']:
            ok = False
            entry.update(status='FAILED', reason='no_output',
                         error='声明了 output_paths，但当前源码上一个输出都没产生，无法验证声明')
        if record['reason'] != 'ok':
            entry['stdout_tail'] = _tail(execution / 'job/stdout.log')
            entry['stderr_tail'] = _tail(execution / 'job/stderr.log')
        if not ok:
            failed.append(name)
        results[name] = entry
    report = {'verified_at': now(), 'directory': str(base), 'profiles': results, 'skipped': skipped,
              'note': '登记验证只核对执行条件与输出声明，不代表业务门禁已通过'}
    if failed:
        raise LoopError('登记验证未通过，未登记。先按 stderr/stdout 排除环境问题；确认某个配方只是因功能未实现而无法在当前源码上运行时，'
                        '用 --skip-verify ' + ' --skip-verify '.join(failed) + ' 显式跳过（预览会标为未验证）。详情：'
                        + json.dumps({n: {k: results[n].get(k) for k in ('reason', 'error', 'stderr_tail', 'stdout_tail')}
                                      for n in failed}, ensure_ascii=False))
    return report


def register_project(state: Path, project_id: str, raw: dict, base: Path, root: Path,
                     require_probes: list[str] = (), *, verify: bool = False,
                     skip_verify: list[str] = (), log=None) -> dict:
    from .rules import ident
    ident(project_id, 'project_id')
    rules = normalize(raw, base)
    if rules['schema_version'] != 2:
        raise LoopError('先明确转换成 schema_version=2，旧规则不自动升级')
    root = root.expanduser().resolve()
    source = Path(rules['source'])
    if root == source or root.is_relative_to(source):
        raise LoopError('运行根不能位于源码内')
    for profile in rules['execution_profiles'].values():
        if profile.get('cache_dir'):
            cache = Path(profile['cache_dir'])
            for restricted in (root, state.expanduser().resolve()):
                if cache == restricted or cache.is_relative_to(restricted) or restricted.is_relative_to(cache):
                    raise LoopError('缓存不能覆盖数据根或Guard授权目录')
    for name in require_probes:
        if name not in rules['execution_profiles'] or not rules['execution_profiles'][name]['probe_allowed']:
            raise LoopError('require-probe 必须引用显式 probe_allowed 配方')
    allowed = sorted(set(p for u in rules['units'] for p in u['writable_paths']))
    protected = sorted(set(p for u in rules['units'] for p in u['protected_paths']))
    ledger = Ledger(state)
    project = {'id': project_id, 'revision': 1, 'root': str(root), 'rules': rules,
               'writable_paths': allowed, 'protected_paths': protected,
               'require_probes': list(require_probes), 'created_at': now()}
    root.mkdir(parents=True, exist_ok=True)
    marker = root / '.loop-managed.json'
    if marker.exists():
        old = load_json(marker)
        if old.get('state') != str(ledger.state):
            raise LoopError('数据根属于另一控制目录，请选新根')
    if verify:
        try:
            ledger.get('project', project_id)
        except LoopError:
            pass
        else:
            raise LoopError('项目ID已登记，不覆盖；能力变更请用新的登记ID')
        project['verification'] = verify_profiles(ledger.state, project_id, rules, skip_verify, log)
    ledger.put('project', project_id, project, create_only=True)
    for name, entry in (project.get('verification') or {}).get('profiles', {}).items():
        # A registration run is the same executor as a probe; reuse it for require_probes.
        ledger.put('probe', project_id + ':' + entry['profile_key'],
                   {'environment_valid': True, 'record': entry, 'profile_key': entry['profile_key']})
    atomic_json(marker, {'state': str(ledger.state), 'managed_schema': 2})
    return project


def _constraints(project: dict, raw: dict):
    approved = project['rules']
    for key in ('source', 'agents', 'execution_profiles', 'security', 'exclude_paths'):
        if raw.get(key) != approved.get(key):
            raise LoopError('普通编排不得修改已登记配置：' + key)
    for name, amount in raw.get('limits', {}).items():
        if name not in approved['limits'] or type(amount) is not int or amount > approved['limits'][name]:
            raise LoopError('普通编排不得扩大限额：' + name)
    for key, amount in raw.get('operation_budgets', {}).items():
        if key not in approved['operation_budgets'] or type(amount) is not int or amount > approved['operation_budgets'][key]:
            raise LoopError('普通编排不得增加操作额度')
    # Compare each unit with the registered unit of the same id: staged plans may protect a
    # file early and remove it in a later unit. Units added during preparation get the
    # strictest bound (all registered writable/protected paths).
    registered = {u['id']: u for u in approved.get('units', [])}
    for unit in raw.get('units', []):
        base = registered.get(unit.get('id'))
        writable = base['writable_paths'] if base else project['writable_paths']
        protected = base['protected_paths'] if base else project['protected_paths']
        for path in unit.get('writable_paths', []):
            if not matches(path, writable):
                raise LoopError('普通编排不得扩大源码修改范围：' + str(unit.get('id')) + ' ' + path)
        if not set(protected).issubset(unit.get('protected_paths', [])):
            raise LoopError('不得移除登记时的保护路径：' + str(unit.get('id')))


UNBOUNDED = re.compile(r'全部|所有|完整|任何|全量|穷尽|充分|一切')


def criteria_warnings(rules: dict) -> list[str]:
    """Non-blocking: open-ended criteria give a reviewer no finish line (2026-10-03 lesson)."""
    found = []
    for u in rules['units']:
        for c in u['criteria']:
            words = sorted(set(UNBOUNDED.findall(c['text'])))
            if words:
                found.append(f'{u["id"]}/{c["id"]} 含"{"、".join(words)}"，可能没有终点；'
                             '建议改成明确清单，能用程序检查的写成门禁')
    return found


def time_warnings(rules: dict) -> list[str]:
    """Stage limits alone may already exceed the unit's entire repair budget."""
    found = []
    for u in rules['units']:
        if not u.get('developer'):
            continue
        seconds, stage, repairs = u['max_seconds'], u['stage_timeout_seconds'], u['max_repairs']
        required = (repairs + 1) * stage
        if seconds < required:
            found.append(f'单元 {u["id"]} 的时限 {seconds:g} 秒，按阶段时限 {stage:g} 秒算最多只够约 '
                         f'{int(seconds // stage)} 轮开发，返修上限 {repairs} 次可能用不满；'
                         f'建议把单元时限至少调到 {required:g}，或者调低阶段时限')
    return found


INLINE_SCRIPT_BYTES = 4096


def argv_warnings(rules: dict) -> list[str]:
    """Non-blocking: a script hidden in argv cannot be reviewed in the preview (2026-10-03 lesson)."""
    found = []
    for name, profile in rules.get('execution_profiles', {}).items():
        size = sum(len(str(a).encode('utf-8')) for a in profile.get('argv', []))
        if size > INLINE_SCRIPT_BYTES:
            found.append(f'配方 {name} 的命令参数共 {size} 字节，像是把脚本内联进了配置；'
                         '建议把验收脚本放进源码的指定位置，配方只引用它的路径')
    return found


def _get_prep(ledger: Ledger, prep_id: str, revision: int | None = None) -> dict:
    from .rules import ident
    ident(prep_id, 'prep_id')
    prep = ledger.get('prep', prep_id)
    if revision is not None and prep['revision'] != revision:
        raise LoopError('revision 不一致，请读取最新准备状态')
    return prep


def begin(state: Path, project_id: str) -> dict:
    ledger = Ledger(state)
    project = ledger.get('project', project_id)
    pid = 'prep-' + uuid.uuid4().hex
    prep = {'id': pid, 'project_id': project_id, 'revision': 1, 'status': 'DRAFT',
            'rules': copy.deepcopy(project['rules']), 'actions': 1, 'created_at': now(),
            'capabilities': capability_summary(), 'checks': None, 'probes': {}}
    ledger.put('prep', pid, prep, create_only=True)
    return prep


def patch(state: Path, prep_id: str, expected_revision: int, changes: dict) -> dict:
    from .rules import ident
    ident(prep_id, 'prep_id')
    ledger = Ledger(state)
    with FileLock(ledger.state / 'locks' / (prep_id + '.lock')):
        prep = _get_prep(ledger, prep_id, expected_revision)
        if prep.get('prepared_id'):
            raise LoopError('已封存；新任务/修订必须创建新准备，不能改旧回执')
        if not isinstance(changes, dict) or set(changes) - {'title', 'task_id', 'notes', 'units', 'completion', 'limits', 'operation_budgets'}:
            raise LoopError('patch 仅接受业务规则和收紧预算，不接受任意路径/命令/程序')
        if prep['actions'] >= MAX_ACTIONS:
            raise LoopError('准备动作预算耗尽，草稿保留；不继续探测')
        raw = copy.deepcopy(prep['rules'])
        raw.update(changes)
        _constraints(ledger.get('project', prep['project_id']), raw)
        if raw == prep['rules']:
            return prep
        prep.update(rules=raw, revision=expected_revision + 1, status='DRAFT', checks=None,
                    actions=prep['actions'] + 1)
        ledger.put('prep', prep_id, prep, expected_revision=expected_revision)
        return prep


def _probe_key(rules: dict, name: str) -> str:
    from .common import file_hash
    source = Path(rules['source'])
    relevant = {}
    patterns = ['**/pom.xml', '**/build.gradle', '**/build.gradle.kts', '**/package.json', '**/package-lock.json', '**/.mvn/**']
    for pattern in patterns:
        for path in source.glob(pattern):
            if path.is_file() and not path.is_symlink() and not any(p in ('node_modules', '.git', 'target') for p in path.parts):
                relevant[path.relative_to(source).as_posix()] = file_hash(path)
    profile = rules['execution_profiles'][name]
    from .adapters import expand, ENGINE_DIR
    argv = expand(profile['argv'], {'python': sys.executable, 'engine': str(ENGINE_DIR), 'code': str(source), 'cache': profile.get('cache_dir') or ''})
    # Include referenced source scripts, not just conventional build descriptors.
    for arg in argv:
        path = Path(arg) if Path(arg).is_absolute() else source / profile['cwd'] / arg
        try:
            if path.is_file() and not path.is_symlink():
                relevant[str(path)] = file_hash(path)
        except OSError:
            # An argument that cannot be a path (e.g. inline code over NAME_MAX) is not a source file.
            continue
    exe = shutil.which(argv[0])
    if exe:
        relevant['executable'] = file_hash(Path(exe))
    return digest({'profile': profile, 'files': relevant, 'python': sys.version})


def check(state: Path, prep_id: str, revision: int, *, refresh: bool = False) -> dict:
    from .rules import ident
    ident(prep_id, 'prep_id')
    ledger = Ledger(state)
    with FileLock(ledger.state / 'locks' / (prep_id + '.lock')):
        prep = _get_prep(ledger, prep_id, revision)
        if prep['checks'] is not None and not refresh:
            return {**prep['checks'], 'cached': True,
                    'note': '同 revision 结构检查缓存；输入和动态条件在 seal/launch 重新核对'}
        project = ledger.get('project', prep['project_id'])
        issues = []
        raw = copy.deepcopy(prep['rules'])
        try:
            _constraints(project, raw)
        except LoopError as exc:
            issues.append({'kind': 'CONFIG', 'detail': str(exc)})
        # Collect ALL profile linkage conflicts, not just the first unit.
        for u in raw.get('units', []):
            try:
                compile_unit(u, project['rules']['execution_profiles'])
            except (LoopError, KeyError, TypeError) as exc:
                issues.append({'kind': 'CONFIG', 'unit': u.get('id'), 'detail': str(exc)})
        rules = None
        try:
            rules = normalize(raw, Path(project['rules']['source']))
        except (LoopError, KeyError, TypeError, ValueError) as exc:
            issues.append({'kind': 'CONFIG', 'detail': str(exc)})
        if rules:
            from .adapters import expand, ENGINE_DIR, command
            source = Path(rules['source'])
            if not source.is_dir() or source.is_symlink():
                issues.append({'kind': 'ENVIRONMENT', 'detail': 'source 不存在或为链接'})
            if rules['security'] == 'strict' and (sys.platform != 'darwin' or not Path('/usr/bin/sandbox-exec').is_file()):
                issues.append({'kind': 'CAPABILITY', 'detail': 'strict 需要本机 macOS sandbox-exec；不自动降级'})
            for name, profile in rules['execution_profiles'].items():
                cwd = source / profile['cwd']
                argv = expand(profile['argv'], {'python': sys.executable, 'engine': str(ENGINE_DIR),
                                               'code': str(source), 'workspace': str(ledger.state), 'cache': profile.get('cache_dir') or ''})
                if not cwd.is_dir():
                    issues.append({'kind': 'ENVIRONMENT', 'profile': name, 'detail': 'cwd 不存在'})
                if not shutil.which(argv[0]):
                    issues.append({'kind': 'ENVIRONMENT', 'profile': name, 'detail': '程序不存在：' + argv[0]})
            for u in rules['units']:
                for role in ('developer', 'reviewer'):
                    member = u.get(role)
                    if member is None:
                        continue
                    vals = {'python': sys.executable, 'engine': str(ENGINE_DIR), 'code': str(source), 'workspace': str(ledger.state),
                            'context': 'context.json', 'response': 'response.json', 'schema': 'schema.json', 'unit': u['id'], 'role': role}
                    args, _ = command(rules['agents'][member], role, vals)
                    if not shutil.which(args[0]):
                        issues.append({'kind': 'ENVIRONMENT', 'unit': u['id'], 'detail': '成员程序不存在：' + args[0]})
            for name in project['require_probes']:
                key = _probe_key(rules, name)
                try:
                    cache = ledger.get('probe', project['id'] + ':' + key)
                except LoopError:
                    cache = None
                if not cache or not cache.get('environment_valid'):
                    issues.append({'kind': 'PROBE', 'question_id': 'profile:' + name, 'profile': name,
                                   'detail': '已授权的一次执行条件探测尚未完成；不要求新业务已通过'})
        result = {'status': 'READY' if not issues else ('NEEDS_CAPABILITY' if any(x['kind'] == 'CAPABILITY' for x in issues) else 'INVALID'),
                  'revision': revision, 'issues': issues, 'cached': False,
                  'warnings': criteria_warnings(rules) + argv_warnings(rules) + time_warnings(rules) if rules else [],
                  'coverage': ['规则结构', '全部已声明配方关联', '程序和路径存在性'],
                  'not_verified': ['业务正确性', '真实模型/账号/额度', '未来自定义构建副作用', '宿主 Hook 实际生效'],
                  'checked_at': now()}
        prep.update(checks=result, status=result['status'])
        ledger.put('prep', prep_id, prep, expected_revision=revision)
        return result


def probe(state: Path, prep_id: str, revision: int, question_id: str) -> dict:
    ledger = Ledger(state)
    prep = _get_prep(ledger, prep_id, revision)
    if prep.get('prepared_id') or prep['status'] == 'READY':
        raise LoopError('已经就绪/封存，不再启动额外探测')
    checks = check(state, prep_id, revision)
    matches_q = [x for x in checks['issues'] if x.get('question_id') == question_id and x['kind'] == 'PROBE']
    if len(matches_q) != 1:
        raise LoopError('没有对应的已授权未决问题；不接受任意探测')
    name = matches_q[0]['profile']
    project = ledger.get('project', prep['project_id'])
    rules = normalize(prep['rules'], Path(project['rules']['source']))
    if not rules['execution_profiles'][name]['probe_allowed']:
        raise LoopError('配方没有探测授权')
    key = _probe_key(rules, name)
    with FileLock(ledger.state / 'locks' / ('probe-' + key + '.lock')), FileLock(ledger.state / 'locks' / (prep_id + '.lock')):
        prep = _get_prep(ledger, prep_id, revision)
        if prep['actions'] >= MAX_ACTIONS or key in prep['probes']:
            raise LoopError('同一问题/配置已探测或动作预算耗尽；先检查已有证据，不原样重复')
        prep['actions'] += 1
        prep['probes'][key] = {'state': 'STARTED'}
        ledger.put('prep', prep_id, prep, expected_revision=revision)
        from .execution import execute_recipe
        path = ledger.state / 'probes' / prep_id / key
        from .common import copy_manifest
        frozen = path.parent / (key + '-input')
        manifest = inspect_input(rules)
        copy_manifest(Path(rules['source']), frozen, manifest)
        if inspect_input(rules) != manifest:
            raise LoopError('探测复制期间原始输入改变')
        record = execute_recipe(frozen, manifest, rules['execution_profiles'][name],
                                path, rules['limits'], purpose='PROBE', security=rules['security'],
                                deadline=time.time() + min(120, rules['execution_profiles'][name]['timeout_seconds']),
                                cancel_file=path.parent / 'cancel', binding={'prep_id': prep_id, 'revision': revision})
        # An exit 1 may be expected before implementation. Output/command integrity must be known.
        valid = record['reason'] in ('ok', 'nonzero_exit')
        entry = {'environment_valid': valid, 'record': record, 'profile_key': key}
        ledger.put('probe', project['id'] + ':' + key, entry)
        prep = _get_prep(ledger, prep_id, revision)
        prep['probes'][key] = entry
        prep['checks'] = None
        ledger.put('prep', prep_id, prep, expected_revision=revision)
        return entry


def seal(state: Path, prep_id: str, revision: int) -> dict:
    ledger = Ledger(state)
    prep = _get_prep(ledger, prep_id, revision)
    if prep.get('prepared_id'):
        return ledger.get('prepared', prep['prepared_id'])
    report = check(state, prep_id, revision, refresh=True)
    if report['status'] != 'READY':
        raise LoopError('未就绪：' + str(report['issues']))
    with FileLock(ledger.state / 'locks' / (prep_id + '.lock')):
        prep = _get_prep(ledger, prep_id, revision)
        if prep.get('prepared_id'):
            return ledger.get('prepared', prep['prepared_id'])
        project = ledger.get('project', prep['project_id'])
        rules = normalize(prep['rules'], Path(project['rules']['source']))
        manifest = inspect_input(rules)
        prepared_id = 'prepared-' + uuid.uuid4().hex
        record = {'id': prepared_id, 'prep_id': prep_id, 'revision': revision,
                  'project_id': prep['project_id'], 'rules': rules, 'rules_hash': digest(rules),
                  'input_hash': digest(manifest), 'root': project['root'],
                  'installation_hash': installation_identity()['sha256'], 'checks': report,
                  'launch_request_id': 'launch-' + uuid.uuid4().hex, 'created_at': now()}
        directory = ledger.state / 'prepared' / prepared_id
        atomic_json(directory / 'rules.json', rules, readonly=True)
        atomic_write(directory / 'preview.md', render_preview(rules, project['rules'], directory / 'rules.json',
                                                              project.get('verification'), report.get('warnings', [])),
                     readonly=True)
        command = [sys.executable, str(Path(__file__).resolve().parents[2] / 'loop_guard.py'),
                   '--state', str(ledger.state), 'launch', prepared_id]
        record.update(preview_path=str(directory / 'preview.md'), launch_command=shlex.join(command))
        ledger.put('prepared', prepared_id, record, create_only=True)
        prep.update(status='SEALED', prepared_id=prepared_id)
        ledger.put('prep', prep_id, prep, expected_revision=revision)
        return record



def _member_option(argv: list[str], flag: str) -> str | None:
    """Read explicit CLI values, including --name=value; like argparse, last wins."""
    value = None
    for index, item in enumerate(argv):
        if item == '--':
            break
        if item.startswith(flag + '='):
            value = item[len(flag) + 1:]
        elif item == flag and index + 1 < len(argv):
            value = argv[index + 1]
    return value


def _member_preview(rules: dict) -> list[str]:
    lines = ['', '## 成员配置（按单元与实际调用角色）']
    count = 0
    for unit in rules['units']:
        for role in ('developer', 'reviewer'):
            if role == 'developer' and unit['kind'] == 'verify':
                continue
            if role == 'reviewer' and unit.get('review_mode') == 'gates':
                continue
            name = unit.get(role)
            if not name:
                continue
            agent = rules['agents'][name]
            args = agent.get('argv', []) if agent['kind'] == 'command' else agent.get('extra_args', [])
            model = _member_option(args, '--model') or agent.get('model') or '未指定（由宿主选择，未核实）'
            provider = _member_option(args, '--provider') or agent.get('provider')
            if provider:
                model = provider + '/' + model
            thinking = _member_option(args, '--thinking') or '未指定（由宿主选择，未核实）'
            configured = _member_option(args, '--tools')
            lines += [f'- {unit["id"]} / {role} / {name}（身份：{agent["identity"]}）',
                      f'  模型：{model}；思考档位：{thinking}',
                      '  配置 --tools：' + (configured if configured is not None else '未指定')]
            if rules.get('schema_version') == 2 and supports_reuse(agent):
                actual = managed_tools({'role': role, 'protocol_repair_only': False})
                lines.append('  实际 --tools：' + actual +
                             ('；与配置一致' if actual == configured else '；受管模式按角色替换配置 --tools'))
                if unit.get('max_protocol_retries', 0):
                    readonly = managed_tools({'role': role, 'protocol_repair_only': True})
                    lines.append('  格式修复实际 --tools：' + readonly + '（只读）')
            else:
                lines.append('  实际工具：未核实（由该适配器及其扩展决定；以上为配置值）')
            count += 1
    if not count:
        lines.append('- 本次没有成员调用。')
    return lines


def render_preview(rules: dict, approved: dict, rules_path: Path, verification: dict | None = None,
                   warnings: list[str] = ()) -> str:
    """Human decision preview; full normalized JSON is a separate authoritative file."""
    changed = [key for key in ('title', 'task_id', 'notes', 'units', 'completion', 'limits', 'operation_budgets')
               if rules.get(key) != approved.get(key)]
    lines = ['# 启动预览：' + rules['title'], '', '仅表示可启动，不代表业务通过或模型账户可用。',
             '源项目：' + rules['source'], '安全模式：' + rules['security'],
             '相对登记配置变化：' + (', '.join(changed) if changed else '无'),
             '完整有效规则（请核对语义与授权）：' + str(rules_path),
             '全局时间上限：' + str(rules['limits']['max_wall_seconds']) + ' 秒；不是预计耗时。',
             '成员/自测/门禁/返修上限：' + '/'.join(str(rules['limits'][x]) for x in
                ('max_member_invocations','max_selftests','max_gate_executions','max_total_repairs')),
             '额外操作额度：' + json.dumps(rules['operation_budgets'], ensure_ascii=False)]
    if verification is None:
        lines.append('配方登记验证：未执行（登记时 --no-verify 或旧登记）；输出声明未经实际运行核对')
    else:
        for name, entry in verification['profiles'].items():
            lines.append('配方登记验证：%s=%s，实际输出 %s%s' % (name, entry['status'], json.dumps(entry['outputs'], ensure_ascii=False),
                                                         '；' + entry['warning'] if entry.get('warning') else ''))
        for name, why in verification['skipped'].items():
            lines.append('配方登记验证：%s=未验证（%s）' % (name, why))
    # The yes also approves what the machine will run: list every registered command.
    lines += ['', '## 将执行的构建/检查命令（按 yes 即同时批准）']
    for name, profile in rules.get('execution_profiles', {}).items():
        lines.append('- %s：`%s`（目录 %s；输出 %s；网络 %s）' % (
            name, shlex.join(profile['argv']), profile['cwd'], ', '.join(profile['output_paths']) or '无',
            '允许' if profile['network'] else '关闭'))
    # 2026-10-03: a unit required deleting 30 files that no member could delete; show the tool set up front.
    agents = rules.get('agents', {})
    pi_agents = sorted(n for n, a in agents.items() if supports_reuse(a))
    others = sorted(set(agents) - set(pi_agents))
    lines += _member_preview(rules)
    lines += ['', '## 成员能做什么（验收要求的操作必须在这里面，否则先补配方或调整验收）']
    if pi_agents:
        lines += ['- Pi 成员：' + ', '.join(pi_agents) + '。',
                  '- 担任开发时：读、改、写、搜索文件；loop_build 只跑本单元配方自测；'
                  'loop_submit_check 交付前查边界；loop_delete 删除、loop_copy 逐字节复制，二者只限本单元可改范围。'
                  '不能执行任意命令、不能安装依赖或联网下载。',
                  '- 担任评审时：只读（读、搜索文件和 loop_submit_check）；' +
                  ('schema v2 不提供评审执行命令，机械检查必须写成门禁。' if rules.get('schema_version') == 2
                   else '单元开启 reviewer_exec 时可在取证目录执行只读取证命令。')]
    if others:
        lines.append('- 其他成员（' + ', '.join(others) + '）：能力由各自适配器决定，Loop 未核实。')
    if warnings:
        lines += ['', '## ⚠ 验收标准提醒（不阻断）'] + ['- ' + w for w in warnings]
    for u in rules['units']:
        lines += ['', '## ' + u['id'] + ' / ' + u['kind'], u['goal'],
                  '依赖：' + ', '.join(u['depends_on']) + '；候选来源：' + str(u.get('input_from') or '本次输入/引擎合成'),
                  '开发：' + str(u.get('developer')) + '；评审：' + str(u.get('reviewer')) + ' / ' + u['review_mode'],
                  '可改：' + ', '.join(u['writable_paths']) + '；保护：' + ', '.join(u['protected_paths']),
                  '返修：最多 %s 次；评审口径：%s' % (u.get('max_repairs'), '问题清单冻结' if u.get('review_scope', 'frozen') == 'frozen' else '开放'),
                  '过线口径：' + u.get('review_bar', '默认（违反标准原文 / 可复现的错误 / 破坏下游才算必须修）')]
        if u.get('developer'):
            lines.append(f'时限可容纳约 {int(u["max_seconds"] // u["stage_timeout_seconds"])} 轮（按阶段时限）')
            if u.get('build_profiles'):
                rounds = u['max_repairs'] + 1
                shares = ' / '.join(str(round_selftest_cap(rules, u, r)) for r in range(1, rounds + 1))
                lines.append(f'自测：单元 {unit_selftest_cap(rules, u)} 次，按 {rounds} 轮累计分配（{shares}）')
        if u.get('first_round') == 'review':
            lines.append('第 1 轮：只跑门禁和评审（不开发）')
        lines += ['- ' + c['id'] + '：' + c['text'] + '；门禁：' + ', '.join(c['gate_ids']) for c in u['criteria']]
    lines += ['', '准备工具不会替用户批准新运行。完整规则中的模型、命令、授权仍以人工确认结果为准。']
    return '\n'.join(lines) + '\n'


def _make_tree_writable(root: Path) -> None:
    """Owner-write for every copied path: the chosen source may be read-only everywhere."""
    for base, dirs, files in os.walk(root):
        for name in dirs + files:
            path = Path(base) / name
            if not path.is_symlink():
                os.chmod(path, path.stat().st_mode | stat.S_IWUSR)
    os.chmod(root, root.stat().st_mode | stat.S_IWUSR)


def derive_plan(state: Path, project_id: str, new_project_id: str, out: Path, *,
                source: Path | None = None, copy_source: Path | None = None) -> dict:
    """Draft a new plan from a registered project without registering or starting anything.

    The registered rules are copied verbatim so the user only edits what really changes.
    --source replaces just the source path. --copy-source first clones the source (the
    --source one when given, otherwise the previously registered source) into a new
    directory kept writable for the current user, then points the draft at the copy.
    The draft still goes through register -> begin -> seal before the user can start it.
    """
    from .rules import ident
    ident(new_project_id, 'project_id')
    ledger = Ledger(state)
    project = ledger.get('project', project_id)
    out = Path(out).expanduser().absolute()
    if out.exists():
        raise LoopError('输出文件已存在，不覆盖：' + str(out))
    chosen = None
    if source is not None or copy_source is not None:
        chosen = (Path(source).expanduser() if source is not None
                  else Path(project['rules']['source'])).resolve()
        if not chosen.is_dir():
            raise LoopError('源码目录不存在：' + str(chosen))
    destination = Path(copy_source).expanduser().resolve() if copy_source is not None else None
    if destination is not None:
        if destination.exists():
            raise LoopError('目标目录已存在，不覆盖：' + str(destination))
        if destination == chosen or chosen.is_relative_to(destination) or destination.is_relative_to(chosen):
            raise LoopError('复制目标与源码目录不能互相嵌套：' + str(destination))
    rules = copy.deepcopy(project['rules'])
    if destination is not None:
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(chosen, destination, symlinks=False)
        _make_tree_writable(destination)
        rules['source'] = str(destination)
    elif chosen is not None:
        rules['source'] = str(chosen)
    guard = Path(__file__).resolve().parents[2] / 'loop_guard.py'
    root = project['root']
    q = lambda v: shlex.quote(str(v))
    next_commands = [f'{q(sys.executable)} {q(guard)} --state {q(state)} register '
                     f'{q(new_project_id)} {q(out)} --root {q(root)}',
                     f'{q(sys.executable)} {q(guard)} --state {q(state)} begin {q(new_project_id)}']
    atomic_write(out, json.dumps(rules, ensure_ascii=False, indent=2) + '\n')
    return {'plan': str(out), 'project_id': new_project_id, 'based_on': project_id,
            'source': rules['source'], 'root': root, 'next_commands': next_commands}


def continue_plan(root: Path, run_id: str, project_id: str, out: Path, *, fresh_unit: bool = False,
                  from_round: int | None = None) -> dict:
    """Draft a plan that resumes a stopped multi-unit run (managed runs refuse retry/seed).

    PASSED units are dropped: their results are already inside the chosen source. The single
    unit that can resume uses its latest/selected candidate (or its frozen input with
    fresh_unit); an unreviewed candidate is reviewed before development. Open issues
    from that candidate's ledger are appended to its goal. The draft then goes
    through the normal register -> begin -> seal -> user launch; nothing is started here.
    """
    from .rules import ident, ancestors
    from .engine import verify_candidate, snapshot_manifest
    from .common import IntegrityError
    if from_round is not None:
        if fresh_unit:
            raise LoopError('--from-round 与 --fresh-unit 互斥；请只选择一种续接来源')
        if type(from_round) is not int or from_round < 1:
            raise LoopError('--from-round 必须是正整数；请指定历史中的候选轮次')
    ident(project_id, 'project_id')
    runs = Path(root).expanduser().resolve() / 'runs'
    run = runs / run_id
    if run.parent != runs or not (run / 'manifest.json').is_file():
        raise LoopError('找不到该运行：' + run_id)
    out = Path(out).expanduser().absolute()
    if out.exists():
        raise LoopError('输出文件已存在，不覆盖：' + str(out))
    manifest, rules = load_json(run / 'manifest.json'), load_json(run / 'rules.json')
    if manifest['state'] != 'TERMINAL':
        raise LoopError('运行尚未停止；先 stop 并等它结束，再续接')
    if digest(rules) != manifest['rule_hash']:
        raise IntegrityError('运行规则已被修改，不能据此续接')
    if rules.get('schema_version') != 2:
        raise LoopError('只支持 schema v2 受管运行')
    units, states = rules['units'], manifest['units']
    passed = {uid for uid, s in states.items() if (s.get('result') or {}).get('stop') == 'PASSED'}
    remaining = [u for u in units if u['id'] not in passed]
    if not remaining:
        raise LoopError('全部单元都已达标，无需续接')
    frontier = [u for u in remaining if all(d in passed for d in u['depends_on'])]
    if len(frontier) != 1:
        raise LoopError('可续接的单元不止一个（并行分支）：' + ', '.join(u['id'] for u in frontier) + '；本命令只处理单一续接点，请手工编排')
    resume = frontier[0]
    if passed - ancestors(units, resume['id']):
        raise LoopError('有已达标单元不在续接单元的上游，成果需要合并；本命令不自动合并，请手工编排')
    state = states[resume['id']]
    result = state.get('result') or {}
    issue_history = result.get('issue_history', state.get('issue_history')) or []
    reviewed = bool(result.get('reviewed'))
    candidate = None if fresh_unit else result.get('candidate')
    if from_round is not None:
        history = result.get('history') or []
        selected = next((h for h in history if h.get('round') == from_round), None)
        if not selected or not selected.get('candidate'):
            available = sorted(h['round'] for h in history if h.get('candidate'))
            raise LoopError(f'单元 {resume["id"]} 第 {from_round} 轮没有可用候选；可选轮次：'
                            + ('、'.join(map(str, available)) or '无') + '。请改用其中一轮或 --fresh-unit')
        candidate = selected['candidate']
        reviewed = bool(selected.get('review'))
        issue_history = selected.get('issue_history') or []
    candidate_round = from_round if from_round is not None else (candidate.get('round') if candidate else None)
    # verify already skips development on every round and cannot declare first_round.
    first_round = 'review' if candidate and not reviewed and resume['kind'] != 'verify' else 'develop'
    if candidate:
        verify_candidate(candidate, rules['limits'])
        source, origin = candidate['path'], f'{resume["id"]} 单元第 {candidate_round} 轮候选'
    elif state.get('input_path'):
        source, origin = state['input_path'], f'{resume["id"]} 的冻结输入（上游成果已合入）'
        if digest(snapshot_manifest(Path(source), rules['limits'])) != state.get('input_hash'):
            raise IntegrityError('续接单元的冻结输入指纹不匹配')
    else:
        leaves = [p for p in passed if not any(p in ancestors(units, q) for q in passed)]
        if not passed:
            source, origin = manifest['input']['path'], '上次运行的冻结原始输入'
        elif len(leaves) == 1:
            leaf = states[leaves[0]]['result']['candidate']
            verify_candidate(leaf, rules['limits'])
            source, origin = leaf['path'], f'{leaves[0]} 的达标候选'
        else:
            raise LoopError('多个已达标上游需要合并成果；本命令不自动合并，请手工编排')
    raw = copy.deepcopy(rules)
    raw['source'] = str(source)
    if (raw.get('completion') or {}).get('unit') in passed:
        raise LoopError('收尾单元已达标但仍有未达标单元，请手工确认收尾方式')
    kept = []
    for u in units:
        if u['id'] in passed:
            continue
        u = copy.deepcopy(u)
        if u.get('input_from') in passed:
            raise LoopError(f'单元 {u["id"]} 的 input_from 指向已达标单元，请手工编排')
        u['depends_on'] = [d for d in u['depends_on'] if d not in passed]
        if u['id'] == resume['id'] and u['kind'] != 'verify':
            u['first_round'] = first_round
        kept.append(u)
    raw['units'] = kept
    header = (f'【续接信息，与下文冲突时以本段为准】续接自运行 {run_id}。'
              + (f'已达标单元 {"、".join(sorted(passed))} 的成果已包含在本次源码中，不重做。' if passed else '')
              + f'源码来自 {origin}（{source}）。'
              + ('续接单元第 1 轮只跑门禁和评审（不开发），未达标再按本轮评审意见返修。' if first_round == 'review' else ''))
    raw['notes'] = header + '\n' + rules.get('notes', '')
    open_items = [i for i in issue_history if i.get('kind') == 'issue'
                  and i.get('status') not in ('RESOLVED', 'ADVISORY') and not i.get('deferred')] if candidate else []
    if open_items or first_round == 'review':
        if first_round == 'review':
            lines = [f'【续接，与上文冲突时以本段为准】上次运行留下 {len(open_items)} 个未解决问题；'
                     f'当前代码是第 {candidate_round} 轮候选，开发方已声称处理，但还没有评审。'
                     '评审逐条核对：已解决的不再列出，仍未解决的重新列为问题。开发方只处理评审本轮列出的问题。']
        else:
            lines = [f'【续接，与上文冲突时以本段为准】上次运行留下 {len(open_items)} 个未解决问题，请先逐条修复：']
        for item in open_items:
            files = []
            for occurrence in item.get('occurrences') or []:
                reported = occurrence.get('reported') if isinstance(occurrence, dict) else None
                for name in (reported.get('files') or [] if isinstance(reported, dict) else []):
                    if name not in files:
                        files.append(name)
            lines.append(f'- [{",".join(item.get("criterion_ids") or [])}] {item.get("description")}'
                         + (f'（{"；".join(files)}）' if files else ''))
        next(u for u in kept if u['id'] == resume['id'])['goal'] += '\n' + '\n'.join(lines)
    normalize(copy.deepcopy(raw), out.parent)
    atomic_write(out, json.dumps(raw, ensure_ascii=False, indent=2) + '\n')
    deferred = sum(1 for i in issue_history if i.get('deferred'))
    return {'plan': str(out), 'project_id': project_id, 'resume_unit': resume['id'], 'source': str(source),
            'first_round': first_round, 'from_round': from_round,
            'origin': origin, 'dropped_passed_units': sorted(passed), 'units': [u['id'] for u in kept],
            'carried_open_issues': len(open_items), 'deferred_findings_not_carried': deferred,
            'next': '用新的项目编号登记这份计划（会实跑配方），再 begin → seal，启动命令交给用户'}
