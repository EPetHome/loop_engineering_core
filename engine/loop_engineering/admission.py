"""Central admission for managed schema-v2 runs. UI/hooks cannot substitute for it."""
from __future__ import annotations
import json
from pathlib import Path
from .common import LoopError, IntegrityError, digest, file_hash, tree_manifest, load_json
from .ledger import Ledger, state_path


def installation_identity() -> dict:
    bundle = Path(__file__).resolve().parents[2]
    files = {}
    for directory in ('engine/loop_engineering', 'adapters', 'extensions', 'plugins/loop-guard'):
        for p in sorted((bundle / directory).rglob('*')):
            if p.is_file() and not p.is_symlink() and '__pycache__' not in p.parts and p.suffix in ('.py', '.ts', '.js', '.json', '.md'):
                # Test sources don't affect dispatch; plugin SKILL/config do.
                if p.name.startswith('test_'):
                    continue
                files[p.relative_to(bundle).as_posix()] = file_hash(p)
    for name in ('run_loop.py', 'loop_guard.py', 'engine/loop.py'):
        if (bundle / name).is_file():
            files[name] = file_hash(bundle / name)
    return {'version': '0.4.0', 'sha256': digest(files), 'files': files}


def inspect_input(rules: dict) -> dict:
    return tree_manifest(Path(rules['source']), rules['exclude_paths'],
                         rules['limits']['max_source_files'], rules['limits']['max_source_bytes'])


def deny_legacy_in_managed(root: Path, rules: dict):
    if (root / '.loop-managed.json').exists():
        raise LoopError('此数据根已登记为受管根，旧规则不能绕过准备；使用 loop_guard.py')
    state = state_path()
    if (state / 'guard.sqlite3').exists():
        for project in Ledger(state).objects('project'):
            if Path(project['rules']['source']).resolve() == Path(rules['source']).resolve():
                raise LoopError('该源项目已经登记受管，不能走 schema v1 旁路')


def claim_creation(root: Path, rules: dict, rid: str, admission: dict | None,
                   parent=None, input_override=None, seed=None) -> tuple[dict, str, bool]:
    if not admission:
        raise LoopError('schema v2 必须先 prepare/seal，再由用户批准启动；不得直接 create_run')
    if input_override is not None or seed is not None:
        raise LoopError('受管运行不接受隐式 input_override/seed；请显式准备选定候选的 verify 任务')
    ledger = Ledger(Path(admission['state']))
    prepared = ledger.get('prepared', admission['prepared_id'])
    if digest(rules) != prepared['rules_hash'] or str(root.resolve()) != prepared['root']:
        raise IntegrityError('准备回执与规则或数据根不匹配')
    if installation_identity()['sha256'] != prepared['installation_hash']:
        raise IntegrityError('准备后引擎/适配器/插件发生变化，请重新准备')
    if digest(inspect_input(rules)) != prepared['input_hash']:
        raise IntegrityError('准备后输入文件发生变化，不使用旧准备结论启动')
    auth = ledger.authorization(admission['authorization_id'])
    if auth['project'] != prepared['project_id']:
        raise LoopError('授权项目不匹配')
    binding = {'prepared_id': prepared['id'], 'rules_hash': prepared['rules_hash'],
               'input_hash': prepared['input_hash'], 'installation_hash': prepared['installation_hash'],
               'parent': parent}
    record, created = ledger.claim(prepared['launch_request_id'], auth['id'], prepared['project_id'],
                                   str(root.resolve()), rid, binding)
    proof = {'state': str(ledger.state), 'prepared_id': prepared['id'],
             'authorization_id': auth['id'], 'request_id': prepared['launch_request_id'], **binding}
    return proof, record['run_id'], created


def verify_run(root: Path, data: dict, rules: dict, *, check_installation: bool = True):
    if rules.get('schema_version') != 2:
        deny_legacy_in_managed(root, rules)
        return
    proof = data.get('admission')
    if not proof:
        raise IntegrityError('受管运行缺少准入记录')
    ledger = Ledger(Path(proof['state']))
    claim = ledger.launch(proof['request_id'])
    ledger.authorization(proof['authorization_id'])
    if (claim['run_id'] != data['run_id'] or claim['root'] != str(root.resolve()) or
            claim['authorization'] != proof['authorization_id'] or claim['binding']['rules_hash'] != digest(rules) or
            proof['input_hash'] != claim['binding']['input_hash'] or
            proof['installation_hash'] != claim['binding']['installation_hash']):
        raise IntegrityError('运行身份/规则与启动账本不一致')
    if check_installation and installation_identity()['sha256'] != proof['installation_hash']:
        raise IntegrityError('运行期间安装实现改变')
    if data.get('input') and data['input']['hash'] != proof['input_hash']:
        raise IntegrityError('实际复制输入不等于已封存输入')


def reserve(data: dict, dimensions: list[str], operation: str) -> bool:
    proof = data.get('admission')
    if not proof:
        return True  # Only legacy v1; Controller independently rejects unadmitted v2.
    return Ledger(Path(proof['state'])).reserve_many(proof['authorization_id'], dimensions, operation, data['run_id'])
