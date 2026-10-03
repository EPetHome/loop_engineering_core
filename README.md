# Loop 0.4.0

本地开发循环：你定目标，AI 做准备，Loop 管住执行（开发 → 自测 → 门禁 → 独立评审 → 有限返修），停止后交出结果。

你需要做的：和 AI 把任务聊清楚，然后在启动预览上输入 `yes`，最后验收结果。其余步骤和规则见 [AGENTS.md](AGENTS.md)。

| 目录 | 内容 |
|---|---|
| `loop_guard.py` | 登记、准备、启动的入口 |
| `engine/` | 引擎（调度、门禁、评审、记录） |
| `adapters/`、`extensions/` | Pi 成员接法与成员工具 |
| `plugins/loop-guard/` | 准备插件（Codex 与 Claude Code 共用） |
| `docs040/` | 架构、使用、配置、安全边界 |
| `tests/`、`tests040/`、`tools/verify_release.py` | 离线回归 |
| `temp/` | 你的资料区 |
