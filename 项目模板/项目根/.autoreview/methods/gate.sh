#!/bin/sh
# 门禁：对应 .autoreview.json 的 gate.cmd。由 Loop 执行，退出码 0 通过。
# 把下面的示例命令替换为项目真实检查（单测、类型检查、lint、结构棘轮等）。
# 规则：日志写项目外或 AUTOREVIEW_RUN_DIR；不要让门禁改动工作区；不要用空成功命令。
set -eu
case "${1:-check}" in
  check) ;;
  *) echo "用法：$0 check" >&2; exit 2 ;;
esac

echo 'AUTOREVIEW_FAILURE=method 请把 <模块> 的示例门禁替换为项目真实检查' >&2
exit 78
