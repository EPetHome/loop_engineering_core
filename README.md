# Loop Engineering

**第一次来的 LLM 只需先读 [AGENTS.md](AGENTS.md)，再处理本次需求。** 它规定任务拆分、并行/串行判断、规则填写、必要检查和准备停止条件；不要求先研究引擎或阅读历史。

当前本地版本：**0.3.0**，包含 Pi 兼容修复和按需简报。Loop 是本地 Python 开发循环：用户启动一次，程序安排开发 → 门禁 → 独立评审 → 必要返修 → 总收尾 → 交付。程序达标不等于用户验收，不自动合并原项目；真实会话复用收益仍未验证。仓库：`github.com/EPetHome/loop_engineering_core`，当前开发在 `dev` 分支。

## 准备与启动

复用本任务适用的规则；需要新建时使用 [规则模板](engine/templates/task.template.json)，本机 Pi 配置见 [规则参考](engine/docs/03-规则配置参考.md) 的“本机 Pi 组合配置”片段。目标、范围、标准、依赖关系、配置与预算明确后，准备者做必要检查并给用户一条启动命令，不预先实现成功解或完整演练。

本机工作目录为 `/Users/Admin/Desktop/loop`，Python 使用 `/opt/homebrew/bin/python3.12`。任务路径须替换为真实文件；第一条只做规则结构检查，第二条由用户用于真实启动：

```bash
cd /Users/Admin/Desktop/loop
/opt/homebrew/bin/python3.12 engine/loop.py validate "tasks/<任务>/task.json"
/opt/homebrew/bin/python3.12 run_loop.py "tasks/<任务>/task.json" --root /Users/Admin/Desktop/loop/loop-data
```

每次执行都会创建新运行，不要重复启动同一任务。`--root` 必须在规则的 `source` 之外。默认只生成程序汇总；需要 AI 简报时，在这一次启动命令末尾追加 `--brief`，不要事后为摘要重新启动业务。

成员默认新会话 `fresh`；仅在任务明确配置且满足支持条件时使用 `reuse_repairs`。Pi 适配器的 `idle_output_seconds` 保持 0，阶段/总时限、取消和日志上限仍有效。具体模型、工具和预算以该任务规则为准，不由旧示例决定。

## 运行与结果

- 启动时打印唯一运行编号；指定运行的权威状态在 `loop-data/runs/<运行编号>/manifest.json`。
- 停止后先看同目录 `交付结果.md`，按需看 `result.md`、`report.html` 和 `delivery-overview.json`；候选代码位于 `loop-data/artifacts/`。AI 简报仅显式请求时生成，失败不改原结果或退出码。
- 运行数据都在指定 `--root`；`temp/` 是用户资料区，不生成工作文档、日志或压缩包。
- 需要停止时在运行终端按 Ctrl+C；保留候选和停止原因。导出、合并和更新基线由用户决定，旧通过结论不替代当前候选验收。

## 目录速览

| 路径 | 内容 |
|---|---|
| `run_loop.py` | 唯一启动入口，默认只交程序汇总 |
| `AGENTS.md` / `CLAUDE.md` | 新 LLM 的当前入口，两者内容相同 |
| `engine/` | 引擎程序、模板与手册；改它先读 `engine/AGENTS.md` |
| `adapters/` | 本机成员接法（`pi_member.py`） |
| `tasks/` | 任务规则与各自说明 |
| `tests/`、`test_run_loop.py` | 组合入口离线测试；引擎自身测试在 `engine/tests/` |
| `docs/` | 组合交付与本机验证记录；`docs/archive/` 是历史归档 |
| `scripts/package_loop.py` | 用户要求时才打完整源码包 |
| `loop-data/` | 运行记录与候选，按 `--root` 生成，不入版本管理 |
| `temp/` | 用户资料区，只读，不在此生成文档或缓存 |

## 只在有具体问题时查

| 需要什么 | 查哪里 |
|---|---|
| 给新 LLM 准备任务 | [AGENTS.md](AGENTS.md) |
| 填规则、本机 Pi agents、并串行字段 | [规则模板](engine/templates/task.template.json)、[规则参考](engine/docs/03-规则配置参考.md) 对应部分 |
| 接不同成员工具或排查权限 | [成员接入](engine/docs/04-成员工具接入.md) |
| 停止、恢复或结果导出 | [故障处理](engine/docs/06-故障停止与恢复.md)、[结果与导出](engine/docs/05-结果验收与导出.md) |
| 本机自检与回归 | `engine/loop.py selftest`、`tests/`、[本机验收](engine/docs/09-测试报告与本机验收.md) |
| 查版本改动或历史原因 | [CHANGELOG](engine/CHANGELOG.md)、[历史归档](docs/archive/README.md)，不是启动必读资料 |

只有用户要求打包时使用 `scripts/package_loop.py --out <目标zip>`（由 Python 执行）；归档和新 LLM 入口随完整源码包保留，不包含任务项目、运行数据或凭据。
