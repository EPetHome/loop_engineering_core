---
name: loop-prepare
description: 在用户明确要求准备或编排Loop任务时使用。通过已登记能力和专用工具准备，不编写通用启动器，不运行真实业务，不代替用户启动。
---

# Loop 受控准备

Loop Guard Hooks只在含 .loop-guard-prep.json 的专用准备目录内拒绝通用工具；在那里只用 loop_guard 的九个准备工具。

先从用户取得已登记的project_id，调用loop_project_info了解固定配置。不默认读引擎源码或历史手册。
普通流程：loop_prepare_begin → 按本次业务变化loop_prepare_patch → loop_prepare_check → loop_prepare_seal。
需要业务材料时用loop_project_read/list。缺业务决定就向用户说明具体缺项，不猜。
只有check返回一个已授权question_id才调用loop_prepare_probe；不要自己生成命令或安装依赖。
配置关联由程序编译；不手工修改配方生成的门禁输出/参数来绕过检查。
READY后交精确命令和未验证项并结束，不再追加测试。seal不会替用户授权或启动。
缺执行能力时保存草稿并说明NEEDS_CAPABILITY，不在准备过程修改Loop核心、Hook、适配器、预算或通用工具。
没有适用的业务断言时，先在循环外明确/编写断言，再由用户登记所需配方；本版本准备接口不允许执行任意新脚本。
模型不得调用人工CLI批准、启动或充值。通过规则结构检查不等于模型账号、真实Pi、安全沙箱或业务通过。
