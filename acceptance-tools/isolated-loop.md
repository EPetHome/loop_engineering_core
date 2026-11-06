# 共用内层验收隔离

入口：`acceptance-tools/isolated-loop.mjs`。Node ≥ 22.18，使用现有 POSIX `ps`、`procs.ts` 与 `resources.ts`；不安装依赖、不修改全局环境。每次运行新建私有根，共用方法而不共用活数据。

## 可复制的最小操作

```bash
cd '/Users/Admin/Desktop/loop-共用验收隔离'
EVIDENCE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/loop-isolation-evidence.XXXXXX")"
node acceptance-tools/isolated-loop.mjs \
  --target "$PWD" --evidence-dir "$EVIDENCE_DIR" --label A1 \
  --write-path sample/result.json --timeout-sec 30 -- \
  node -e 'const fs=require("node:fs"); const result={root:process.env.LOOP_ISOLATION_ROOT,candidate:process.env.LOOP_CANDIDATE_ROOT,home:process.env.HOME}; fs.mkdirSync("sample"); fs.writeFileSync("sample/result.json",JSON.stringify(result)); console.log(JSON.stringify(result));'
printf '正式证据保留在：%s\n' "$EVIDENCE_DIR"
```

预期：打印本轮私有路径；最后一行 `ISOLATION_REPORT=<绝对路径>`。成功报告中 `commandExitCode=0`、`processesReleased=true`、`rootReleased=true`，私有根已不存在；原始日志和报告仍在证据目录。此命令是使用示例，不是 A1 业务验收。

一般接口：

```text
node <方法所在Loop根>/acceptance-tools/isolated-loop.mjs \
  --target <只读候选Loop根> --evidence-dir <已有的明确证据目录> \
  --label A1 [--write-path <路径>]... [--timeout-sec N] -- COMMAND ARGS...
```

- `--help` 仅打印说明，不访问候选、创建环境或启动进程。
- `--label` 为字母开头、最多 41 字符的字母/数字/下划线/连字符短名称；同名也不复用目录。
- 时限默认 180 秒，可设 1—3600 秒。超时终止及收尾另有有界等待；工作进程失去响应时，监督者最多等命令时限加 25 秒，非零保留现场，不把监督者退出当成后代已释放。
- `COMMAND ARGS...` 原样按 argv 派发，不自动展开环境变量，也不隐式执行 shell。需要 shell 时显式使用 `/bin/sh -c '…'`，私有变量应在单引号包住的内层命令中展开。
- 命令 cwd 是私有根。受控脚本可按绝对路径读取候选和已安装工具；建立仓库、批次及 worktree 必须在私有根内，不能对候选仓库执行开工或写操作。

## 环境与声明路径

私有根由调用方的 `TMPDIR` / `os.tmpdir()` 决定，在该父目录下 `mkdtemp`，使用物理路径；不硬编码另一个系统临时父目录。调用方给出独立外层时，内层自然嵌套在其临时目录。候选根只读，临时父目录与证据目录不得位于候选内。

在工作进程及任何内层命令启动前安装子进程专用的 allowlist 环境：

| 变量 | 本轮落点 |
|---|---|
| `LOOP_ISOLATION_ROOT` / `LOOP_ISOLATION_ID` | 唯一私有根 / 随机身份 |
| `LOOP_CANDIDATE_ROOT` | 规范化后的只读候选根 |
| `HOME` | `home`；含 pipelines、events 元数据、Hook 会话及交付记录 |
| `AUTOREVIEW_MERGE_QUEUE_ROOT` / `AUTOREVIEW_RESOURCE_ROOT` / `AUTOREVIEW_PROJECTS_ROOT` | `queues` / `resources` / `projects` |
| `PI_CODING_AGENT_DIR` / `CODEX_HOME` / `CLAUDE_CONFIG_DIR` | `agent` / `codex` / `claude` |
| `TMPDIR`、`TMP`、`TEMP` | 同一个私有 `temp`；后台删除 `TMPDIR` 后仍有备用值 |
| `LOOP_PA_CONFIG` | **真实存在**的 `pa.json`，`pa.eventsDir` 指向 `paEvents`、`pa.localNotify=false` |
| `XDG_*_HOME`、Git 全局配置、npm 用户配置/缓存 | 私有配置、数据、状态及缓存；Git 禁用系统配置和凭据交互 |
| `AUTOREVIEW_RUN_ID` / `AUTOREVIEW_TEMP_DIR` / `AUTOREVIEW_EVIDENCE_DIR` / `AUTOREVIEW_RUN_DIR` | 工作进程新建的受管资源身份及其私有目录 |

仅保留可执行工具 `PATH`、语言/时区等基础值，不复制真实模型密钥或用户配置。外层 `AUTOREVIEW_*`、Pi/Claude/Codex 会话及启动身份全部丢弃，随后只新增本轮资源身份。默认队列 launcher 为 `background`，不启动真实 Terminal。场景如需内层批次身份，应在受控命令里按本轮私有路径显式创建，不能依赖外层继承。工具的环境操作不修改调用宿主的 `process.env`。

**显式输出必须声明**：批次 `dir`、workspace、问题单回写、日志、准备输出、状态根及事件路径等，除自动生成的私有状态路径外，都应通过重复 `--write-path` 声明。相对路径按新私有根解释；绝对路径、已有符号链接及其后面的 `..` 按物理路径核对；悬空链接无法证明归属，拒绝。不是字符串前缀判断。全部声明在工作进程/样本命令派发前验证，任一越界即非零指出原输入和实际路径。

`--write-path` 不创建目标、不代替脚本配置，也不解析任意 shell 或批次文件。新根不能预置后复用，因此场景应从私有根变量生成所有动态路径，并在调用前声明其他已知输出。`--write-path` 不允许额外开放外层路径；`--evidence-dir` 是唯一显式外部输出例外，只允许本轮唯一材料，不覆盖其他轮次。

## 证据、退出与收尾

每轮只在 `<evidence-dir>/<label>-isolation-随机后缀>/` 新建自己的文件：

- `stdout.log`、`stderr.log`：命令双流逐字节存档，同时转发到调用方；不修改 Node 警告、不加时间戳、不混合双流。
- `input.json`：实际命令 argv、路径和受控环境；`ownership.json`：工作进程、主命令、受管资源与已观察消费者身份。
- `before-process-cleanup.json`、`before-root-cleanup.json`：删除前的持久快照；`procs.json` / `consumers.json` 在释放未确认时保留。
- `worker-result.json`、`report.json`：实际命令结果、收尾结果、工具 SHA-256 和候选 Git HEAD（不可取得时为 null）。HEAD 只是基线；未提交候选应由 Loop 快照补充完整版本证据。

报告至少包含 `root`、`paths.home/queues/resources/projects/agent/paEvents`、`commandExitCode`、`processesReleased`、`rootReleased`、`stdoutLog`、`stderrLog`。另有 `id`、`commandStarted`、`commandOutcome`（原始 code/signal）、`resourceStatus`、`ownership`、`exitCode` 等。失败或保留现场时 `reason` 非空。最终报告在收尾之后才写，不预写成功。

主命令自成进程组，用现有登记/释放函数回收其随机 owner 及后代。另按唯一 `LOOP_ISOLATION_ROOT` 扫描脱离原组、甚至换过 owner/清过 run ID 的消费者；记录 PID、启动时间和组身份，发信号前重核。独立组复用 `releaseProc`，共享组只处理已核对的单进程，不向外层组发信号。确认原组、已登记组、已观察身份均结束且连续扫描为空，才报告 `processesReleased=true`；扫描失败不是空列表。

`SIGINT` / `SIGTERM` / `SIGHUP` 转达本轮命令，留出短暂正常收尾时间，必要时按身份强制结束。先保存原始日志、路径、原因和归属，再释放资源；最后检查根目录 inode/dev、真实路径与随机登记一致，才删除本轮根。

| 结果 | 退出 / 私有根 |
|---|---|
| 正常且释放确认 | 0，清理私有根；证据保留 |
| 命令非零 | 保持命令非零码（如 23），保留私有根与原因 |
| 命令不存在 / 不可执行 | 127 / 126，保留证据及现场 |
| 超时 | 124，`reason` 标明超时；原始退出信号另存 |
| 取消 | SIGINT=130、SIGTERM=143、SIGHUP=129，原因保留信号 |
| 配置/观察/收尾故障 | 非零（通常 75），未知消费者或身份变化时不删除根 |
| 派发前声明拒绝 | 非零；没有启动消费者时可释放刚建的空私有环境 |

失败根不自动回收。只按本轮报告、根标记、真实路径和消费者事实核对后再作有授权的补偿；不能依据名字、年龄、端口或某个 PID 猜测删除/终止。`SIGKILL`、宿主掉电等无法当场收尾：没有有效回执就保持未确认，不能宣称已释放。

## 后续批次复用与验证边界

后续批次从已合入基线使用同一入口，每条调用给自己的正式证据目录；不要复制另一套隔离器，也不要传上轮私有根。私有根成功后会删除，想保留的观察内容应在命令结束前输出到双流或本轮唯一报告，不在根内保留唯一一份正式证据。

这是**受控验收方法，不是操作系统沙箱**。环境变量不能阻止任意恶意程序使用硬编码绝对路径、删除隔离标记或偷偷取得凭据。受控消费者须继承本轮根标记；显式配置完整声明、候选不写外部目录是使用前提。越界反例只指向独立外层临时哨兵，不拿真实用户目录探测，不清理历史演示登记。真实 Terminal 重建环境须由相应批次另验，后台结论不能代替。

开发定向检查：`node --test test/acceptance-isolation.test.ts`。本批 S 的独立评审、门禁、A1—A5 自动验收和 required 实操仍由 Loop 执行，按 `docs/prompt/验收说明-共用验收隔离.md` 使用协调方固定 bootstrap；必须在其兜底收尾前观察本工具的实际释放，不能将外层清理算作候选成功。单测及本工具报告均不能替代独立验收。
