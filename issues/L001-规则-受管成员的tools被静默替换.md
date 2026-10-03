# L001 规则：受管成员的 --tools 被静默替换

- 现象：v2 计划一律走受管模式，pi_member.py 会按角色整个替换 plan.json 里成员 argv 的 `--tools`：开发方换成 `read,edit,write,grep,find,ls,loop_build,loop_submit_check`，评审方换成 `read,grep,find,ls,loop_submit_check`。替换时不报错也不提示，plan 字段和实际行为对不上；在 plan 里加上 bash 等工具也会被悄悄去掉。实际工具集不会比代码规定的更宽，不是安全问题。
- 来源：2026-10-03 AI 发现（梳理"提示词 → pi 命令"的封装时读代码发现）；共 1 次
- 证据：adapters/pi_member.py:37（按角色给工具集）、adapters/pi_member.py:237-238（覆盖 argv）、engine/loop_engineering/engine.py:319（v2 即受管）、examples040/project-template.v2.json（模板里写的 `--tools`）
- 修复：保留按角色固定的受管工具集；适配器在替换时向 stderr 明示配置与实际工具（含格式修复只读阶段）。预览与适配器共用工具策略；v2 模板补齐实际工具，接口文档明确 --tools 不能扩大或缩小受管能力。
- 验证：2026-10-03，针对性测试 9 项通过；完整离线回归 422 项通过、1 项 Linux 专用检查在 Mac 跳过。本机 Pi 0.87.1 开发/评审/格式修复工具与模型档位验证通过；真实 register → begin → check → seal 通过，未启动业务或调用模型。
- 证据：`/Users/Admin/Documents/Codex/2026-10-03/task/evidence/L001-L002/`（`release/report.json`、`local-acceptance-with-catalog/report.json`、对应预览与原始日志）。
