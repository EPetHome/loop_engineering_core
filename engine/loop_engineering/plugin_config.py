"""Create the dedicated preparation workspace. Never edits a host's global configuration.

One plugin (plugins/loop-guard) serves Codex and Claude Code. Its hooks enforce only
inside a directory holding .loop-guard-prep.json, so this module creates exactly that
directory plus the runtime file the MCP bridge reads.
"""
from pathlib import Path
import json
import shlex
from .common import LoopError, atomic_json, atomic_write

MARKETPLACE = 'loop-guard-local'
PLUGIN = 'loop-guard@' + MARKETPLACE
DEFAULT_RUNTIME = Path.home() / '.loop040' / 'runtime.json'
INSTRUCTIONS = """# Loop 受控准备目录

这是 Loop 0.4.0 的专用准备会话目录。本目录下的会话只用 loop_guard 的九个准备工具：
loop_project_info/list/read 读项目，loop_prepare_begin → patch → check → seal 准备任务。
Bash、改文件、子代理都会被 Hook 拒绝；这是设计，不要绕过，也不要在别处替用户启动。
READY 并 seal 后，把启动命令交给用户在终端执行，然后结束。缺能力就说明 NEEDS_CAPABILITY。
"""


def generate(socket_path: Path, out: Path, runtime: Path = DEFAULT_RUNTIME):
    bundle = Path(__file__).resolve().parents[2]
    out = out.expanduser().resolve()
    if out.exists():
        raise LoopError('准备目录已存在，拒绝覆盖')
    runtime = runtime.expanduser().resolve()
    if runtime == out or runtime.is_relative_to(out):
        raise LoopError('runtime.json 不能放在准备目录里')
    out.mkdir(parents=True, mode=0o700)
    runtime.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    atomic_json(runtime, {'socket': str(socket_path.expanduser().absolute())})
    atomic_json(out / '.loop-guard-prep.json', {'version': '0.4.0', 'bundle': str(bundle), 'runtime': str(runtime),
                                                'note': 'loop-guard Hook 只在含本文件的目录内生效'})
    atomic_write(out / 'AGENTS.md', INSTRUCTIONS)   # Codex
    atomic_write(out / 'CLAUDE.md', INSTRUCTIONS)   # Claude Code
    # Same content `claude plugin install --scope project` writes; enables the plugin here only.
    atomic_json(out / '.claude' / 'settings.json', {
        'extraKnownMarketplaces': {MARKETPLACE: {'source': {'source': 'directory', 'path': str(bundle)}}},
        'enabledPlugins': {PLUGIN: True}})
    q = shlex.quote
    steps = {
        'claude_code': ['cd ' + q(str(out)),
                        'claude plugin marketplace add ' + q(str(bundle)) + ' --scope project',
                        'claude plugin install ' + PLUGIN + ' --scope project',
                        'claude mcp list   # 应显示 plugin:loop-guard:loop_guard ✔ Connected；只在本目录可见',
                        'claude   # 然后 /hooks 应列出 loop-guard 的 4 个 Hook'],
        'codex': ['codex plugin marketplace add ' + q(str(bundle)),
                  'codex plugin add ' + PLUGIN,
                  'cd ' + q(str(out)) + ' && codex，然后在 /hooks 审阅并信任 loop-guard 的 4 个 Hook',
                  'Codex 插件是全局启用的；Hook 只在本目录生效，其他会话只多出 9 个准备工具'],
    }
    return {'workspace': str(out), 'runtime': str(runtime), 'plugin': PLUGIN, 'next_steps': steps,
            'installed': False, 'host_verified': False}
