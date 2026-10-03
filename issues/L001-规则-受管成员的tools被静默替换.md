# L001 规则：受管成员的 --tools 被静默替换

- 现象：v2 计划一律走受管模式，pi_member.py 会按角色整个替换 plan.json 里成员 argv 的 `--tools`：开发方换成 `read,edit,write,grep,find,ls,loop_build,loop_submit_check`，评审方换成 `read,grep,find,ls,loop_submit_check`。替换时不报错也不提示，plan 字段和实际行为对不上；在 plan 里加上 bash 等工具也会被悄悄去掉。实际工具集不会比代码规定的更宽，不是安全问题。
- 来源：2026-10-03 AI 发现（梳理"提示词 → pi 命令"的封装时读代码发现）；共 1 次
- 证据：adapters/pi_member.py:37（按角色给工具集）、adapters/pi_member.py:237-238（覆盖 argv）、engine/loop_engineering/engine.py:319（v2 即受管）、examples040/project-template.v2.json（模板里写的 `--tools`）
- 修复：
