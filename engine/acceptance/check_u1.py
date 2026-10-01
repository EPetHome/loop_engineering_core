#!/usr/bin/env python3
"""U1 验收：交付格式修复额度按角色分开；证据校验不放宽。

用法（在引擎目录下）：python3 acceptance/check_u1.py    全部通过退出 0，否则退出 1。
成员桩故意犯的两种格式错，正是第一次真实试跑里出现过的：
开发方把门禁写进证据；评审方把绝对路径写进证据。两种都必须继续被拒收。
"""
import sys
from _harness import Checker, run_case


def stats(case):
    return (case['unit'] or {}).get('stats', {})


def main() -> int:
    check = Checker('U1 验收')

    a = run_case('bad-once', 'bad-once', max_protocol_retries=1)
    check.expect('A 双方各错一次、额度各 1 次', '总停止类型', (a['run'] or {}).get('stop'), 'PASSED')
    check.expect('A 双方各错一次、额度各 1 次', '退出码', a['exit_code'], 0)
    check.expect('A 双方各错一次、额度各 1 次', '格式修复总次数 protocol_retries', stats(a).get('protocol_retries'), 2)
    check.expect('A 双方各错一次、额度各 1 次', '按角色计数 protocol_retries_by_role',
                 stats(a).get('protocol_retries_by_role'), {'developer': 1, 'reviewer': 1})
    check.expect('A 双方各错一次、额度各 1 次', '成员启动次数', stats(a).get('member_invocations'), 4)

    b = run_case('good', 'bad-always', max_protocol_retries=1)
    check.expect('B 评审方一直错', '总停止类型', (b['run'] or {}).get('stop'), 'BLOCKED')
    check.expect('B 评审方一直错', '按角色计数', stats(b).get('protocol_retries_by_role'), {'developer': 0, 'reviewer': 1})

    c = run_case('bad-always', 'good', max_protocol_retries=1)
    check.expect('C 开发方一直错', '总停止类型', (c['run'] or {}).get('stop'), 'BLOCKED')
    check.expect('C 开发方一直错', '按角色计数', stats(c).get('protocol_retries_by_role'), {'developer': 1, 'reviewer': 0})
    check.expect('C 开发方一直错', '成员启动次数（评审方不应被启动）', stats(c).get('member_invocations'), 2)

    d = run_case('bad-once', 'good', max_protocol_retries=0)
    check.expect('D 额度为 0', '总停止类型', (d['run'] or {}).get('stop'), 'BLOCKED')
    check.expect('D 额度为 0', '成员启动次数', stats(d).get('member_invocations'), 1)

    e = run_case('good', 'good', max_protocol_retries=1)
    check.expect('E 双方都不出错', '总停止类型', (e['run'] or {}).get('stop'), 'PASSED')
    check.expect('E 双方都不出错', '格式修复总次数', stats(e).get('protocol_retries'), 0)
    check.expect('E 双方都不出错', '按角色计数（为 0 也要有这个字段）',
                 stats(e).get('protocol_retries_by_role'), {'developer': 0, 'reviewer': 0})
    return check.finish()


if __name__ == '__main__':
    sys.exit(main())
