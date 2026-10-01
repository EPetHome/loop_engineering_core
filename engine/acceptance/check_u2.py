#!/usr/bin/env python3
"""U2 验收：运行结束时发现原项目被动过，总停止类型为「推不动」，并在结果里列出被动过的路径。

用法（在引擎目录下）：python3 acceptance/check_u2.py    全部通过退出 0，否则退出 1。
"""
import sys
from _harness import Checker, run_case


def drift(case):
    return (case['result_json'] or {}).get('source_drift', '（结果里没有 source_drift 字段）')


def main() -> int:
    check = Checker('U2 验收')

    a = run_case('good', 'good')
    check.expect('A 原项目没被动', '总停止类型', (a['run'] or {}).get('stop'), 'PASSED')
    check.expect('A 原项目没被动', '退出码', a['exit_code'], 0)
    check.expect('A 原项目没被动', 'result.json 里的 source_drift', drift(a), [])

    b = run_case('touch-original', 'good')
    check.expect('B 成员改了原项目里已有的文件', '总停止类型', (b['run'] or {}).get('stop'), 'BLOCKED')
    check.expect('B 成员改了原项目里已有的文件', '退出码', b['exit_code'], 3)
    check.expect_true('B 成员改了原项目里已有的文件', 'source_drift 列出 baseline.md',
                      isinstance(drift(b), list) and 'baseline.md' in drift(b), f'实际 {drift(b)!r}')
    check.expect_true('B 成员改了原项目里已有的文件', 'result.md 里写出 baseline.md', 'baseline.md' in b['result_md'])

    c = run_case('add-original', 'good')
    check.expect('C 成员在原项目里新增文件', '总停止类型', (c['run'] or {}).get('stop'), 'BLOCKED')
    check.expect_true('C 成员在原项目里新增文件', 'source_drift 列出 新增文件.txt',
                      isinstance(drift(c), list) and '新增文件.txt' in drift(c), f'实际 {drift(c)!r}')

    d = run_case('delete-original', 'good')
    check.expect('D 成员删了原项目里的文件', '总停止类型', (d['run'] or {}).get('stop'), 'BLOCKED')
    check.expect_true('D 成员删了原项目里的文件', 'source_drift 列出 tests/test_invites.py',
                      isinstance(drift(d), list) and 'tests/test_invites.py' in drift(d), f'实际 {drift(d)!r}')

    e = run_case('ignored-original', 'good')
    check.expect('E 只出现被排除的文件（.DS_Store、__pycache__）', '总停止类型', (e['run'] or {}).get('stop'), 'PASSED')
    check.expect('E 只出现被排除的文件（.DS_Store、__pycache__）', 'source_drift', drift(e), [])
    return check.finish()


if __name__ == '__main__':
    sys.exit(main())
