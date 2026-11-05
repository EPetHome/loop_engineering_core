#!/bin/sh
# 准备检查与已知环境恢复：对应 preparation.check / preparation.recover。
# 把 <项目> 替换为真实依赖、端口、测试库和恢复命令；不能降低检查标准。
set -eu
case "${1:-check}" in
  check)
    echo 'AUTOREVIEW_FAILURE=method 请实现 <项目> 的准备检查' >&2
    exit 78
    ;;
  recover)
    echo 'AUTOREVIEW_FAILURE=environment 请实现 <项目> 的已知环境恢复' >&2
    exit 75
    ;;
  *) echo "用法：$0 check|recover" >&2; exit 2 ;;
esac
