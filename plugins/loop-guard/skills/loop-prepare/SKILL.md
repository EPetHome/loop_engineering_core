---
name: loop-prepare
description: 在用户明确要求准备或编排Loop任务时使用。先按会话类型准备：受约束准备目录只用九个准备工具；普通会话按AGENTS.md由AI写计划并登记。不编写通用启动器，不运行真实业务，不代替用户启动。
---

# Loop 受控准备

先判断当前会话是哪一种，再按对应流程准备。

## 一、受约束准备目录（目录含 .loop-guard-prep.json）

Loop Guard Hooks只在含 .loop-guard-prep.json 的专用准备目录内拒绝通用工具；在那里只用 loop_guard 的九个准备工具，不能跑命令、不能写文件。

九个工具：loop_project_info / loop_project_list / loop_project_read，loop_prepare_begin / patch / check / probe / seal / status。

- 项目必须已登记：先用 loop_project_info 读固定配置，再 begin；项目未登记时说明本目录不做登记，请先在普通会话按 AGENTS.md 登记完成。不默认读引擎源码或历史手册。
- 流程：loop_prepare_begin → 按本次业务变化loop_prepare_patch → loop_prepare_check → loop_prepare_seal。
- 需要业务材料时用loop_project_read/list。缺业务决定就向用户说明具体缺项，不猜。
- 只有check返回一个已授权question_id才调用loop_prepare_probe；不要自己生成命令或安装依赖。
- 配置关联由程序编译；不手工修改配方生成的门禁输出/参数来绕过检查。
- READY后交精确命令和未验证项并结束，不再追加测试。seal不会替用户授权或启动。
- 缺执行能力时保存草稿并说明NEEDS_CAPABILITY，不在准备过程修改Loop核心、Hook、适配器、预算或通用工具。
- 本目录写不了业务断言、也不能登记配方；缺断言时如实说明，回到普通会话按 AGENTS.md 补写并登记。
- 模型不得调用人工CLI批准、启动或充值。通过规则结构检查不等于模型账号、真实Pi、安全沙箱或业务通过。

## 二、普通会话（目录不含 .loop-guard-prep.json）

按 AGENTS.md 办：AI 自己起草业务验收脚本和 plan.json，自己执行登记与准备，不用停下来向用户要 project_id。

- 流程：register <项目ID> <plan.json> --root <数据根> → begin <项目ID> →（需要改任务内容时 patch）→ seal；seal 会重新检查，不要依赖缓存的 check 结果。
- 项目 ID 由 AI 自己取，不能覆盖已有 ID；构建命令、输出、模型或可修改范围有变化时换一个新 ID 重新登记。
- 续轮：用 derive 从上一轮已登记项目原样复制规则、按需只改 source（换源码目录或 --copy-source 复制成可写副本），产出新计划后再登记、准备。
- 中途停下的运行：用 continue 起草续接计划（去掉已达标单元、默认从续接单元最新候选接着做、带上未解决问题但不带建议项）；没评审过的候选会先评审，可以用 --from-round 指定轮次（与 --fresh-unit 互斥）。再登记、准备；不要手写续接计划。
- register、launch 要在宿主环境执行，不要放在 AI 工具自带的沙箱里。
- 不代替用户启动：不执行 launch，不用 --approve；seal 返回的启动命令交给用户，由用户看预览、输入 yes。

## 两类会话共同遵守

不编写通用启动器，不运行真实业务，不代替用户启动；不在准备过程修改Loop核心、Hook、适配器、预算或通用工具。
