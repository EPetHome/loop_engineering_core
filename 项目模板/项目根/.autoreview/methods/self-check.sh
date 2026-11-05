#!/bin/sh
# 方法自测：先拒绝未替换的模板占位符，再确认方法入口存在。
# Loop 在方法指纹变化时调用一次；输出 AUTOREVIEW_FAILURE=method 并退出 78 表示方法无效。
set -eu

matches=$(grep -RInE '<[^>]+>' .autoreview/methods .autoreview.json deploy/acceptance 2>/dev/null | grep -v -e '/self-check.sh:' -e '/methods/README.md:' || true)
if [ -n "${matches}" ]; then
  echo 'AUTOREVIEW_FAILURE=method 还有未替换的占位符：' >&2
  echo "${matches}" >&2
  echo '请先替换这些 <占位符>，再执行 loop 开工。' >&2
  exit 78
fi

for file in .autoreview/methods/gate.sh .autoreview/methods/prepare.sh; do
  [ -f "${file}" ] || { echo "AUTOREVIEW_FAILURE=method 缺少方法入口：${file}" >&2; exit 78; }
  sh -n "${file}" || { echo "AUTOREVIEW_FAILURE=method 方法脚本语法错误：${file}" >&2; exit 78; }
done

echo '方法自测通过：占位符已替换，方法入口存在'
