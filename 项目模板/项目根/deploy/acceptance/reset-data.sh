#!/bin/sh
# 模板说明：重置数据（.autoreview.json 的 acceptance.reset）。程序在每次调用验收方之前执行它。
# 规则：只清测试数据，不启停服务，不做 DDL；可以重复执行；成功时打印一行固定文字；凭据只在容器内传递，不打印、不写文件。
# 由协调方准备，不交给被验收的开发方写。
# Promate 实例：dev分支/deploy/acceptance/reset-data.sh（旧流程）
set -eu
# <在测试库里用事务 DML 清空本批相关的表，恢复种子数据>
echo 'RESET_OK'
