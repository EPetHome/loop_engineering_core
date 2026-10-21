#!/bin/bash
# 模板说明：批次工具。check 子命令就是 loop 门禁（.autoreview.json 的 gate.cmd），由协调方写，开发方不改。
# 规则：日志写在本批目录，不写进开发分支（否则 loop 会报「门禁期间工作区变了」）；退出码 0 表示通过；
#       历史失败放进本目录的 已知失败.txt，名单以外的失败才算不通过；工具链版本（JDK、Node）在这里固定。
# 开工时先在开工基线上空跑一次，确认结果是通过或只剩已知失败。
# Promate 实例：coding/docs/P0缺陷修复-20261012/P0缺陷修复-工具.sh
set -uo pipefail
B=$(cd "$(dirname "$0")" && pwd)   # 本批目录
W=/path/to/项目根/dev分支           # 换成 dev分支 的绝对路径
[ "${1:-}" = check ] || { echo "用法：$0 check"; exit 2; }
# 模板不可空跑成功；实施者配置真实检查后移除此拒绝段。
echo 'AUTOREVIEW_FAILURE=method 请配置真实门禁命令及已知失败基线' >&2
exit 78
s=$(date +%Y%m%dT%H%M%S); rc=0

# 1. 后端单测（示例：固定 JDK、Maven 离线、只测本批相关模块）
# ( cd "$W" && JAVA_HOME=<JDK> mvn -o -pl <模块> -am test ) > "$B/后端-门禁-$s.log" 2>&1 || rc=1

# 2. 前端检查（示例：类型检查 + lint + 单测）
# ( cd "$W/<前端目录>" && <类型检查> && <lint> && <单测> ) > "$B/前端-门禁-$s.log" 2>&1 || rc=1

# 3. 有历史失败的全量测试：只看名单以外的失败
# <跑全量，把失败用例名逐行写进 "$B/全量-门禁-$s-失败.txt">
# new=$(comm -23 <(sort -u "$B/全量-门禁-$s-失败.txt") <(sort -u "$B/已知失败.txt"))
# [ -z "$new" ] || { rc=1; echo "名单外失败："; echo "$new"; }

# 变量后面紧跟中文标点时一律写成 ${var} 的形式（Promate P0 批的门禁曾因尾行这类写法退出 1，来源是 Pi 记录）
echo "门禁退出码 ${rc}；日志在 ${B}（前缀 *-门禁-${s}）"
exit "$rc"
