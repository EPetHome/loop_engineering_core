# 11 CLI 命令速查

所有命令在包含 loop.py 的根目录运行；另一路径运行时写该脚本绝对路径。以下 RUN_ID、task.json 和目录为需替换的参数，不是 shell 环境变量。

| 命令 | 作用 | 调用模型？ |
|---|---|---|
| `python3 loop.py --version` | 引擎版本 | 否 |
| `python3 loop.py doctor` | Python/POSIX 与 CLI 存在性 | 否 |
| `python3 loop.py doctor --plan task.json --check-tools` | 规则/源码/成员程序与可选版本检查 | 否 |
| `python3 loop.py init --source /path/project --out task.json` | 创建带 TODO 的真实规则草稿 | 否 |
| `python3 loop.py validate task.json --render readable.md` | 规则结构校验与生成人读视图 | 否 |
| `python3 loop.py demo [--dag] [--root ./loop-data]` | 离线成员协议桩演示 | 否 |
| `python3 loop.py run task.json --root ./loop-data` | 前台、有监督的正式运行 | 取决于配置 |
| `python3 loop.py start task.json --root ./loop-data` | 本地后台监督运行 | 取决于配置 |
| `python3 loop.py status [RUN_ID] --root ./loop-data [--all]` | 当前状态或所有运行 | 否 |
| `python3 loop.py result [RUN_ID] --root ./loop-data` | 从权威记录生成并打印结果 | 否 |
| `python3 loop.py audit [RUN_ID] --root ./loop-data` | 校验已存证据和成果指纹 | 否 |
| `python3 loop.py stop [RUN_ID] --root ./loop-data` | 请求停止本次受管工作 | 否 |
| `python3 loop.py recover [RUN_ID] --root ./loop-data` | 接管孤儿记录并收尾，或重建终态视图 | 否 |
| `python3 loop.py retry [RUN_ID] --root ./loop-data [--background]` | 按旧规则创建新运行，不继承旧 PASS | 取决于配置 |
| `python3 loop.py export [RUN_ID] --root ./loop-data --to NEW_DIR [--unit ID]` | 导出已达标代码到不存在的目录 | 否 |
| `python3 loop.py selftest` | 运行随包测试与故障注入 | 否 |

`[]` 表示可选，实际命令不要输入方括号。`--json` 支持 run/start/demo/status/audit/retry；run 等输出启动信息，status 输出完整清单，audit 输出检查对象。stdout 的启动成功 JSON 不等于任务最终成功。

省略 RUN_ID 或写 latest，选择数据根目录中**最近创建**的运行。根目录 latest.json / latest.md 是最近发布阅读结果的指针，两者含义可能不同。多任务使用显式编号，避免混淆。

## 退出码

| 代码 | 意义 |
|---:|---|
| 0 | 命令成功；前台 run/demo 表示达标，start 只表示已提交启动 |
| 1 | result 请求时运行尚未停止；或 unittest 自身测试失败 |
| 2 | 前台执行或 recover 结果未达标；argparse 参数用法错误也可能返回 2，需看输出 |
| 3 | 前台执行或 recover 结果推不动 |
| 4 | 规则/环境/CLI使用错误或无法启动 |
| 5 | audit 完整性检查失败 |

status/result 查询成功不意味着业务达标，要读停止字段。后台运行不把最终业务退出码传回早已结束的 start 命令，使用结果文件查询。

配置预检失败会拒绝创建运行；还未正式接受的非法任务没有运行结果。数据根目录无法创建、存储不可写也不能保证生成报告。对已创建且可读写存储的运行，程序尽力收尾并保存最小结果。
