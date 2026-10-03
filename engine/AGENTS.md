# Loop 0.4.0 内核开发约定

当前入口与状态先读上级README、AGENTS.md、docs040/01与05。engine/docs中的0.3说明描述旧schema v1，不覆盖schema v2新增准入、配方、verify与预算。

日常任务准备使用上级loop_guard.py和插件MCP，不在任务目录重写内核能力。修改内核时以具体故障反例为闭环，保留原独立评审、最终核对、证据绑定和导出约束。运行安装回归看tools/verify_release.py；不要把全回归变成每任务准备条件。

源码中audit-only是显式离线诊断模式，不是安全沙箱。真实Mac/Pi/Codex能力的结论必须有本机记录，不从离线fixture推断。不要默认调用模型、启停用户旧任务或扩大权限。
