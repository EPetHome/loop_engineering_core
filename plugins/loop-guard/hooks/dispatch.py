#!/usr/bin/env python3
"""Loop Guard hook, one file for Codex and Claude Code.

It enforces only inside a preparation workspace: the session cwd or one of its parents
holds .loop-guard-prep.json. Everywhere else it prints nothing and exits 0, so enabling
the plugin never changes ordinary coding sessions.

Inside the workspace every tool is denied except the nine Loop preparation MCP tools
and a few host meta tools. Deny is exit 2 with the reason on stderr, which both hosts
support. Allow differs per host: Claude Code gets permissionDecision "allow" (no prompt
for these nine tools); Codex gets no output and keeps its own approval flow. Stop never
requests another model turn. Admission and launch checks do not depend on this hook.
Keep this file Python 3.9 compatible: hosts may run the system python3.
"""
import json
import os
from pathlib import Path
import re
import sys

MARKER = '.loop-guard-prep.json'
TOOLS = ('loop_prepare_begin', 'loop_prepare_patch', 'loop_prepare_check', 'loop_prepare_probe',
         'loop_prepare_seal', 'loop_prepare_status', 'loop_project_info', 'loop_project_list',
         'loop_project_read')
# Codex keeps plain MCP names (mcp__server__tool); Claude Code prefixes plugin servers
# as mcp__plugin_<plugin>_<server>__tool.
MCP_TOOL = re.compile(r'^mcp__(?:plugin_loop-guard_)?loop_guard__(?:' + '|'.join(TOOLS) + r')$')
META = {'claude': {'ToolSearch', 'AskUserQuestion'}, 'codex': {'update_plan'}}
SKILLS = {'loop-guard:loop-prepare', 'loop-prepare'}
CONTEXT = ('Loop受控准备模式：只用loop_guard MCP提供的项目读取与准备工具。流程begin→patch→check→seal；'
           '没有明确未决问题不probe。不要自己写通用启动器/计数器；READY后交命令结束。'
           '缺能力如实报告，不修改引擎，不调用模型，不替用户启动。Hook不证明宿主沙箱已生效。')
DENY = ('Loop准备模式不允许该工具。读取用loop_project_read/list，修改任务用loop_prepare_patch，'
        '核实执行条件仅用已授权loop_prepare_probe；缺能力保存草稿，不现场开发引擎或启动业务。')


def host(event):
    forced = os.environ.get('LOOP_GUARD_HOST')
    if forced in ('codex', 'claude'):
        return forced
    return 'codex' if 'turn_id' in event else 'claude'  # turn_id is a documented Codex extension


def prep_root(cwd):
    try:
        start = Path(cwd or os.getcwd()).resolve()
    except (OSError, RuntimeError):
        return None
    for directory in (start,) + tuple(start.parents):
        if (directory / MARKER).is_file():
            return directory
    return None


def allowed(event, which):
    name = event.get('tool_name')
    if not isinstance(name, str):
        return False
    if MCP_TOOL.match(name) or name in META[which]:
        return True
    if which == 'codex' and name in TOOLS:
        return True  # Codex feature non_prefixed_mcp_tool_names drops the mcp__ prefix
    if which == 'claude' and name == 'Skill':
        tool_input = event.get('tool_input')
        return isinstance(tool_input, dict) and tool_input.get('skill') in SKILLS
    return False


def decide(event):
    """Return (exit_code, stdout_json_or_None, stderr_text_or_None)."""
    kind = event.get('hook_event_name', '')
    if prep_root(event.get('cwd')) is None:
        return 0, None, None
    if kind in ('SessionStart', 'UserPromptSubmit'):
        return 0, {'hookSpecificOutput': {'hookEventName': kind, 'additionalContext': CONTEXT}}, None
    if kind != 'PreToolUse':
        return 0, None, None  # In particular Stop NEVER requests another model turn.
    which = host(event)
    if not allowed(event, which):
        return 2, None, DENY
    if which == 'claude':
        return 0, {'hookSpecificOutput': {'hookEventName': 'PreToolUse', 'permissionDecision': 'allow',
                                          'permissionDecisionReason': '准备专用接口；服务端再次检查参数、版本与已登记权限'}}, None
    return 0, None, None


def main():
    try:
        raw = sys.stdin.buffer.read(1024 * 1024 + 1)
        if len(raw) > 1024 * 1024:
            raise ValueError('hook input too large')
        event = json.loads(raw)
        if not isinstance(event, dict):
            raise ValueError('hook input must be an object')
        code, out, err = decide(event)
    except Exception as exc:
        # Hosts run hooks with the session cwd, so an unreadable event is still scoped.
        if prep_root(None) is None:
            return 0
        code, out, err = 2, None, 'Loop Guard无法读取Hook事件，拒绝该动作：' + str(exc)
    if out is not None:
        print(json.dumps(out, ensure_ascii=False))
    if err:
        print(err, file=sys.stderr)
    return code


if __name__ == '__main__':
    raise SystemExit(main())
