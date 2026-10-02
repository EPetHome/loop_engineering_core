#!/usr/bin/env python3
"""U3 验收：门禁限次重跑（累计达标加护栏）。

用法（在引擎目录下）：python3 acceptance/check_u3.py    全部通过退出 0，否则退出 1。

口径来自拍板人对「结果不稳定的真跑检查」定下的出口：
  同一份候选上，没过的门禁可以限次重跑，重跑通过算通过；
  失败的那次保留下来并写进结论；
  同一个原因出现两次算机制问题，不再重跑，必须回去修；
  候选一改，之前的全部作废，从头再来。
"""
import sys
from _harness2 import Checker, flaky, reason, run_task, stats, stop, validate_task


def with_gates(*gates, repairs=0):
    """把示例任务的门禁换成按次数表现的门禁；S1 关联全部门禁。"""
    def customize(task, work):
        unit = task['units'][0]
        unit['gates'] = [flaky(work, gid, **extra) for gid, extra in gates]
        unit['criteria'][0]['gate_ids'] = [gid for gid, _ in gates]
        unit['max_repairs'] = repairs
    return customize


def record(case, name='r001-G1'):
    return case['gates'].get(name) or {}


def attempts(case, name='r001-G1'):
    value = record(case, name).get('attempts')
    return value if isinstance(value, list) else []


def column(case, key, name='r001-G1'):
    return [a.get(key) for a in attempts(case, name)]


def main() -> int:
    check = Checker('U3 验收')

    case = 'A 不写 max_reruns（默认 0）'
    a = run_task(plan={'G1': ['fail:json-invalid', 'pass']}, customize=with_gates(('G1', {})))
    check.expect(case, '总停止类型（不重跑，照旧未达标）', stop(a), 'NOT_MET')
    check.expect(case, '门禁执行次数', len(attempts(a)), 1)
    check.expect(case, '门禁记录 reruns', record(a).get('reruns'), 0)
    check.expect(case, '门禁记录 passed_after_rerun', record(a).get('passed_after_rerun'), False)
    check.expect(case, '单元计数 gate_reruns（为 0 也要有）', stats(a).get('gate_reruns'), 0)

    case = 'B 允许重跑 1 次，第 2 次通过'
    b = run_task(plan={'G1': ['fail:json-invalid', 'pass']}, customize=with_gates(('G1', {'max_reruns': 1})))
    check.expect(case, '总停止类型', stop(b), 'PASSED')
    check.expect(case, '退出码', b['exit_code'], 0)
    check.expect(case, '门禁最终状态', record(b).get('status'), 'PASS')
    check.expect(case, '每次执行的状态', column(b, 'status'), ['FAIL', 'PASS'])
    check.expect(case, '每次执行的序号 attempt', column(b, 'attempt'), [1, 2])
    check.expect(case, '每次执行的原因 reason（通过的那次为 null）', column(b, 'reason'), ['json-invalid', None])
    check.expect(case, '门禁记录 reruns', record(b).get('reruns'), 1)
    check.expect(case, '门禁记录 passed_after_rerun', record(b).get('passed_after_rerun'), True)
    check.expect(case, '门禁记录 repeated_reason', record(b).get('repeated_reason', '（没有这个字段）'), None)
    check.expect(case, '单元计数 gate_reruns', stats(b).get('gate_reruns'), 1)
    logs = column(b, 'stdout')
    check.expect_true(case, '两次执行各有自己的输出日志，互不覆盖',
                      len(logs) == 2 and all(isinstance(p, str) for p in logs) and logs[0] != logs[1], f'实际 {logs!r}')
    check.expect_true(case, '失败那次的原因写进了 result.md', 'json-invalid' in b['result_md'])
    index = (((b['unit'] or {}).get('result') or {}).get('evidence') or {}).get('gate:G1') or {}
    check.expect(case, '结果的证据索引里 gate:G1 带着两次执行', len(index.get('attempts') or []), 2)
    seen = [s for s in b['saw'] if s['role'] == 'reviewer']
    seen_attempts = ((seen[0]['gate_evidence'] or {}).get('G1') or {}).get('attempts') if seen else None
    check.expect(case, '评审方拿到的门禁证据里能看到两次执行', len(seen_attempts or []), 2)

    case = 'C 允许重跑 1 次，两次都没过（原因不同）'
    c = run_task(plan={'G1': ['fail:json-invalid', 'fail:quote-changed']}, customize=with_gates(('G1', {'max_reruns': 1})))
    check.expect(case, '总停止类型', stop(c), 'NOT_MET')
    check.expect(case, '每次执行的状态', column(c, 'status'), ['FAIL', 'FAIL'])
    check.expect(case, '门禁最终状态', record(c).get('status'), 'FAIL')
    check.expect(case, 'repeated_reason（原因不同，不算重复）', record(c).get('repeated_reason', '（没有这个字段）'), None)

    case = 'D 允许重跑 3 次，同一原因出现两次'
    d = run_task(plan={'G1': ['fail:json-invalid', 'fail:json-invalid', 'pass']}, customize=with_gates(('G1', {'max_reruns': 3})))
    check.expect(case, '总停止类型（不再重跑，回去修）', stop(d), 'NOT_MET')
    check.expect(case, '门禁执行次数（第 2 次之后就停）', len(attempts(d)), 2)
    check.expect(case, '门禁最终状态', record(d).get('status'), 'FAIL')
    check.expect(case, 'repeated_reason', record(d).get('repeated_reason'), 'json-invalid')

    case = 'E 允许重跑 3 次，原因各不相同，第 3 次通过'
    e = run_task(plan={'G1': ['fail:json-invalid', 'fail:quote-changed', 'pass']}, customize=with_gates(('G1', {'max_reruns': 3})))
    check.expect(case, '总停止类型', stop(e), 'PASSED')
    check.expect(case, '每次执行的状态', column(e, 'status'), ['FAIL', 'FAIL', 'PASS'])
    check.expect(case, '单元计数 gate_reruns', stats(e).get('gate_reruns'), 2)

    case = 'F 两个门禁先后因同一原因失败'
    f = run_task(plan={'G1': ['fail:json-invalid', 'pass'], 'G2': ['fail:json-invalid', 'pass']},
                 customize=with_gates(('G1', {'max_reruns': 1}), ('G2', {'max_reruns': 1})))
    check.expect(case, 'G1 重跑后通过', record(f, 'r001-G1').get('status'), 'PASS')
    check.expect(case, 'G2 执行次数（原因和 G1 那次相同，不给重跑）', len(attempts(f, 'r001-G2')), 1)
    check.expect(case, 'G2 最终状态', record(f, 'r001-G2').get('status'), 'FAIL')
    check.expect(case, 'G2 的 repeated_reason', record(f, 'r001-G2').get('repeated_reason'), 'json-invalid')
    check.expect(case, '总停止类型', stop(f), 'NOT_MET')

    case = 'G 失败时没写原因（从严：算同一个原因）'
    g = run_task(plan={'G1': ['fail', 'fail', 'pass']}, customize=with_gates(('G1', {'max_reruns': 2})))
    check.expect(case, '每次执行的原因', column(g, 'reason'), ['unspecified', 'unspecified'])
    check.expect(case, 'repeated_reason', record(g).get('repeated_reason'), 'unspecified')
    check.expect(case, '总停止类型', stop(g), 'NOT_MET')

    case = 'H 返修之后从头再来'
    h = run_task(plan={'G1': ['fail:json-invalid', 'fail:json-invalid', 'fail:json-invalid', 'pass']},
                 customize=with_gates(('G1', {'max_reruns': 1}), repairs=1))
    check.expect(case, '总停止类型（第 2 轮：失败一次、重跑通过）', stop(h), 'PASSED')
    check.expect(case, '业务返修次数', stats(h).get('repairs'), 1)
    check.expect(case, '第 1 轮的记录还在，状态 FAIL', record(h, 'r001-G1').get('status'), 'FAIL')
    check.expect(case, '第 1 轮执行次数', len(attempts(h, 'r001-G1')), 2)
    check.expect(case, '第 2 轮每次执行的状态（上一轮的原因不带过来）', column(h, 'status', 'r002-G1'), ['FAIL', 'PASS'])
    check.expect(case, '单元计数 gate_reruns（两轮合计）', stats(h).get('gate_reruns'), 2)

    case = 'I 门禁超时不重跑'
    i = run_task(plan={'G1': ['sleep', 'pass']}, customize=with_gates(('G1', {'max_reruns': 1, 'timeout_seconds': 1})))
    check.expect(case, '总停止类型（环境问题仍是推不动）', stop(i), 'BLOCKED')
    check.expect(case, '门禁执行次数', len(attempts(i)), 1)
    check.expect(case, '那次执行的状态', column(i, 'status'), ['UNKNOWN'])

    case = 'J 规则检查'
    for value, ok in ((0, True), (5, True), (6, False), (-1, False), (True, False), (1.5, False), ('1', False)):
        code = validate_task(with_gates(('G1', {'max_reruns': value})))
        check.expect_true(case, f'max_reruns={value!r} ' + ('接受' if ok else '拒绝'), (code == 0) == ok, f'validate 退出码 {code}')

    return check.finish()


if __name__ == '__main__':
    sys.exit(main())
