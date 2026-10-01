#!/usr/bin/env python3
"""U4 验收：评审方可以执行只读的取证命令，自己取到的证据可以引用、可以追溯。

用法（在引擎目录下）：python3 acceptance/check_u4.py    全部通过退出 0，否则退出 1。

单元规则里 reviewer_exec 为 true 时：评审方每次启动都有一个自己的取证目录（上下文里的
scratch_path），脚本和输出只能写在那里；引用其中的文件写 scratch:<相对路径>。
不开这个开关时，一切照旧。无论开不开，评审方改了候选副本都要被发现。
"""
import hashlib
import json
import os
import stat
import sys
from pathlib import Path
from _harness2 import Checker, engine_cli, reason, run_task, stats, stop, validate_task


def exec_on(**unit_extra):
    def customize(task, work):
        task['units'][0]['reviewer_exec'] = True
        task['units'][0].update(unit_extra)
    return customize


def saw(case, role):
    return [s for s in case['saw'] if s['role'] == role]


def prompts(case, role):
    return [text for name, text in case['prompts'].items() if name.startswith(role + '-')]


def main() -> int:
    check = Checker('U4 验收')

    def tamper_then_audit(work, run_dir):
        before = engine_cli('audit', run_dir.name, '--root', str(work / 'data')).returncode
        manifest = json.loads((run_dir / 'manifest.json').read_text(encoding='utf-8'))
        index = (manifest['units']['invite'].get('result') or {}).get('evidence') or {}
        located = (index.get('scratch:取证/sessions.json') or {}).get('path')
        if not isinstance(located, str) or not Path(located).is_file():
            return {'before': before, 'after': None}
        target = Path(located)
        os.chmod(target.parent, stat.S_IRWXU)
        os.chmod(target, stat.S_IRWXU)
        target.write_text('被改过\n', encoding='utf-8')
        after = engine_cli('audit', run_dir.name, '--root', str(work / 'data')).returncode
        return {'before': before, 'after': after}

    case = 'A 开关打开，评审方引用自己取到的证据'
    a = run_task(rev='scratch-ok', customize=exec_on(), after=tamper_then_audit)
    check.expect(case, '总停止类型', stop(a), 'PASSED')
    check.expect(case, '退出码', a['exit_code'], 0)
    rev = saw(a, 'reviewer')
    check.expect_true(case, '评审方上下文里有 scratch_path，是一个已存在、可写的目录',
                      bool(rev) and rev[0]['scratch_is_dir'] and rev[0]['scratch_writable'], f'实际 {rev[:1]!r}')
    check.expect_true(case, '环境变量 LOOP_SCRATCH 与 scratch_path 相同',
                      bool(rev) and rev[0]['env_scratch'] == rev[0]['scratch_path'], f'实际 {rev[:1]!r}')
    check.expect_true(case, '取证目录不在候选副本里面',
                      bool(rev) and isinstance(rev[0]['scratch_path'], str)
                      and not Path(rev[0]['scratch_path']).resolve().is_relative_to(Path(rev[0]['code_path']).resolve()))
    dev = saw(a, 'developer')
    check.expect(case, '开发方上下文里 scratch_path 为 null', dev[0]['scratch_path'] if dev else '（没有记录）', None)
    entry = (((a['unit'] or {}).get('result') or {}).get('evidence') or {}).get('scratch:取证/sessions.json') or {}
    expected = hashlib.sha256('{"取证": "评审方自己跑命令得到的结果"}\n'.encode('utf-8')).hexdigest()
    check.expect(case, '结果的证据索引里有这条引用，指纹与文件内容一致', entry.get('sha256'), expected)
    check.expect_true(case, '证据索引里记了文件位置 path', isinstance(entry.get('path'), str) and entry['path'].endswith('sessions.json'),
                      f'实际 {entry!r}')
    check.expect_true(case, '给评审方的提示里讲了 scratch: 引用和取证目录',
                      bool(prompts(a, 'reviewer')) and all('scratch:' in p for p in prompts(a, 'reviewer'))
                      and bool(rev) and isinstance(rev[0]['scratch_path'], str) and rev[0]['scratch_path'] in prompts(a, 'reviewer')[0])
    check.expect(case, '改动之前 audit 通过', (a['after'] or {}).get('before'), 0)
    check.expect(case, '被引用的取证文件事后被改，audit 能发现（退出码 5）', (a['after'] or {}).get('after'), 5)

    case = 'B 不开开关（默认）'
    b = run_task(rev='scratch-not-written')
    rev = saw(b, 'reviewer')
    check.expect(case, '评审方上下文里 scratch_path 为 null', rev[0]['scratch_path'] if rev else '（没有记录）', None)
    check.expect(case, '引用 scratch: 被拒收，总停止类型', stop(b), 'BLOCKED')
    check.expect_true(case, '停止原因是交付格式', '交付协议修复已耗尽' in reason(b), reason(b))
    check.expect_true(case, '给评审方的提示里不出现 scratch:',
                      bool(prompts(b, 'reviewer')) and all('scratch:' not in p for p in prompts(b, 'reviewer')))
    plain = run_task()
    check.expect(case, '不引用 scratch: 时照旧达标', stop(plain), 'PASSED')

    case = 'C 开关打开，开发方引用 scratch:'
    c = run_task(dev='cite-scratch', customize=exec_on())
    check.expect(case, '总停止类型', stop(c), 'BLOCKED')
    check.expect(case, '成员启动次数（评审方不应被启动）', stats(c).get('member_invocations'), 1)

    for label, mode in (('D 引用的文件不存在', 'scratch-not-written'), ('E 引用越出取证目录', 'scratch-escape'),
                        ('F 引用的是符号链接', 'scratch-symlink')):
        x = run_task(rev=mode, customize=exec_on())
        check.expect(label, '总停止类型', stop(x), 'BLOCKED')
        check.expect_true(label, '停止原因是交付格式', '交付协议修复已耗尽' in reason(x), reason(x))

    case = 'G 开关打开，评审方改了候选副本'
    g = run_task(rev='mutate-code', customize=exec_on())
    check.expect(case, '总停止类型', stop(g), 'BLOCKED')
    check.expect_true(case, '停止原因指出评审阶段改了代码', '修改了代码' in reason(g), reason(g))

    case = 'H 取证目录超过大小上限'
    def small_logs(task, work):
        exec_on()(task, work)
        task['limits']['max_log_bytes'] = 4096
    h = run_task(rev='scratch-big', customize=small_logs)
    check.expect(case, '总停止类型', stop(h), 'BLOCKED')
    check.expect_true(case, '停止原因是交付格式', '交付协议修复已耗尽' in reason(h), reason(h))

    case = 'K 评审方第一次交付格式错，修格式时取证目录里的东西还在'
    k = run_task(rev='scratch-bad-once', customize=exec_on(max_protocol_retries=1))
    check.expect(case, '总停止类型', stop(k), 'PASSED')
    check.expect(case, '按角色的格式修复计数', stats(k).get('protocol_retries_by_role'), {'developer': 0, 'reviewer': 1})
    entry = (((k['unit'] or {}).get('result') or {}).get('evidence') or {}).get('scratch:first.txt') or {}
    check.expect(case, '第一次取到的证据在修格式那次仍可引用',
                 entry.get('sha256'), hashlib.sha256('第一次尝试里取到的证据\n'.encode('utf-8')).hexdigest())

    case = 'L 规则检查'
    for value, ok in ((True, True), (False, True), ('yes', False), (1, False), (None, False)):
        def customize(task, work, value=value):
            task['units'][0]['reviewer_exec'] = value
        code = validate_task(customize)
        check.expect_true(case, f'reviewer_exec={value!r} ' + ('接受' if ok else '拒绝'), (code == 0) == ok, f'validate 退出码 {code}')

    return check.finish()


if __name__ == '__main__':
    sys.exit(main())
