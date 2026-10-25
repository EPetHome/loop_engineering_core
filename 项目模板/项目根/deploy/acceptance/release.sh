#!/bin/sh
# 用 AUTOREVIEW_RUN_ID 标识本轮拥有的外部资源，幂等释放；不按名称/年龄批量删除。
# 若项目只有 Loop 临时目录和受管进程，经核实后可明确写“无外部资源”并退出 0。
echo 'AUTOREVIEW_FAILURE=method 尚未定义项目资源释放方法' >&2
exit 78
