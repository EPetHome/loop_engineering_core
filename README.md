# pi 自动评审扩展（autoreview）

给 pi 开发会话加一个 `-e`：开发方写完（写不写【交付完成】都行），扩展自动让独立评审检查改动；有必修就发回**同一个**开发会话返修，最多 3 次；没有必修或到达上限就停下，弹 macOS 通知并写总结。配置了验收命令时，评审完成后自动执行验收命令（例如本仓库的 E2E），结果写进总结并通知你。

同一套评审规则也做成了 Claude Code / Codex 插件（`plugins/autoreview/`，本地市场 `autoreview-local`）：宿主里由 Stop Hook 调评审，有必修时用 `{"decision":"block","reason":…}` 在原会话返修。安装后只有带 `.autoreview.json` 的项目才生效。

## Claude Code / Codex 用法

- 在项目根目录（或某个上级目录）放 `.autoreview.json`，可以是 `{}`；可选 `maxRepairs`、`reviewerModel`、`reviewerThinking`、`reviewTimeoutMin`。
- 开发方最后一行写【交付完成】触发评审；有必修时 Hook 把返修消息发回同一会话，最多 `maxRepairs` 次。
- 状态与总结写到 `~/.pi-autoreview/<项目目录名>/<宿主>-<会话id>.state.json` 和 `.md`，不写进项目。
- Codex 首次安装后需要在 Codex 里用 `/hooks` 确认信任；未经信任时 Hook 不执行。
- 联调可用假评审：`AUTOREVIEW_REVIEWER_CMD=/Users/Admin/Desktop/loop/test/fake-reviewer.mjs`、`FAKE_MODE=pass|pass-after-1|always-fix|fail|modify`。

## 启动

保留日常启动配置，加载权限扩展与自动评审扩展（替换下面的占位符）：

```bash
cd <你的项目>
PATH="/Users/Admin/.hermes/node/bin:$PATH" /Users/Admin/.local/bin/pi \
  --offline \
  --model openai-codex/gpt-6.1-sol \
  --thinking max \
  --no-extensions --no-skills --no-prompt-templates --no-themes \
  --tools <按任务选> \
  -e /Users/Admin/.pi/agent/npm/node_modules/@gotgenes/pi-permission-system/src/index.ts \
  -e /Users/Admin/Desktop/loop/autoreview.ts \
  "@<提示词绝对路径>"
```

`--tools` 例如 `read,edit,write,bash`，按任务选择。

在本仓库开发时再加 `--autoreview-accept-cmd "node test/e2e.mjs"`，评审完成后自动跑 E2E 实操验收（见下面「验收命令」）。

没有标记不代表已经评审过，可以用 `/review-status` 查。
完成后也可以手动 `/review`。
要接着用同一个开发会话，在上述配置中加 `--session <开发会话id>` 精确恢复，不要只用 `pi -c`（可能选到评审会话）。

## 交付标记

| 标记 | 含义 | 扩展动作 |
|---|---|---|
| 【交付完成】 | 开发方完成本轮全部工作（含自测） | 自动开始评审 |
| 【需要你决定】 | 开发方卡住，需要你拍板 | 不评审，暂停并通知你 |

收到返修消息后，开发方要逐条回应：修好的写「第 N 条：已修」，不同意的写「第 N 条：异议：理由」，全部处理完再以【交付完成】结尾。这两个约定由扩展自动追加进开发方的系统提示，你不需要改自己的提示词。

无标记时由程序判断：工作区与上次成功评审（没评审过就是开发基线）的指纹相比有变化就直接评审，和写了【交付完成】一样；没有变化且刚发过返修消息时暂停（原因「返修后没有任何改动」）；其他情况什么都不做。暂停后等你输入 `/review` 恢复。

## 命令

| 命令 | 作用 |
|---|---|
| `/review` | 不管有没有标记，立即评审当前改动；返修计数从这一次重新算 |
| `/review-off` | 关闭自动评审 |
| `/review-on` | 打开自动评审 |
| `/review-status` | 显示状态、轮次、返修次数、验收结果、评审会话 id、总结文件路径 |
| `/accept` | 立即执行验收命令（需要配置 `--autoreview-accept-cmd`） |

## flag

| flag | 默认 | 用途 |
|---|---|---|
| `--autoreview-max-repairs` | `3` | 返修上限 |
| `--autoreview-reviewer-model` | `openai-codex/gpt-6-astra` | 评审模型 |
| `--autoreview-reviewer-thinking` | `xhigh` | 评审思考档位 |
| `--autoreview-review-timeout-min` | `60` | 一轮评审（首次 + 1 次重试）共用的总时限（分钟） |
| `--autoreview-reviewer-cmd` | 空 | 仅测试：外部评审命令 |
| `--autoreview-accept-cmd` | 空 | 评审完成后执行的验收命令；空表示不验收 |
| `--autoreview-accept-timeout-min` | `120` | 验收命令时限（分钟） |

## 规则边界

- 评审只读、只跑只读命令；评审前后比对工作区指纹，不一致就暂停。
- 只把「必修」发回开发方；小问题和需求疑问只写进总结，交你决定。
- 只支持已有提交的 git 仓库；不是 git 仓库或尚无提交时，开会话提示并关闭。
- git 取证失败会暂停，不把错误当作「没有改动」。
- 一次评审失败（超时、非 0 退出、输出为空、解析不出格式）会在同一个评审会话里重试 1 次；两次尝试共用 `reviewTimeoutMin`（默认 60 分钟）的预算，重试只能用剩余时间，剩余不足 1 分钟就不再重试并暂停（原因「评审超时」）。
- 任何异常都是暂停，不是终止：不回滚、不删成果。输入 `/review` 可以接着来；失败不会推进成功评审检查点。
- 关闭或重载会取消正在跑的评审；恢复中断会话时提示 `/review`，不会自动重启。

## 验收命令

- 触发：只要配置了 `--autoreview-accept-cmd`，每次评审结论为完成（状态「完成」）都会立即执行，不靠开发方自觉；返修轮和任何暂停都不执行。
- 执行：在项目目录用 `/bin/sh -c` 运行，退出码 0 为「通过」，非 0 为「不通过（退出码 N）」，超过时限为「超时」，起不来为「无法执行」。验收期间状态栏显示「自动验收中」，不自动评审，`/review` 会提示等待。
- 结果：总结状态行下多一行「- 验收：…」，「## 验收」一节写命令、触发方式、耗时、输出最后 20 行；完整输出在 `~/.pi-autoreview/<项目目录名>/accept-<开发会话id>-r<轮次>.log`。结束时弹通知。
- 中断：验收中关闭或重载会话，记为「中断」；恢复会话时提示，输入 `/accept` 重跑，不会自动重跑。
- 开始新一轮评审时清掉上一次验收结果（代码可能已经变了）。
- Claude Code / Codex 插件暂不支持验收命令（Stop Hook 有时限）。

## E2E 实操验收（本仓库）

`node test/e2e.mjs [A1 …]`：依托 pi 真实跑一遍开发与评审，开发方和真实评审都用 `opencode-go/deepseek-v4.1-flash`，驱动只发一条需求，全程不提醒。

| 场景 | 开发方 / 评审 | 预期 |
|---|---|---|
| A1 真实开发 + 真实评审 | ds4.1 / ds4.1 | 完成；评审能解析；`test_calc.py` 能跑、`add` 正确；评审会话复用 |
| A2 返修一次后通过 | ds4.1 / 假评审 | 完成，评审 2 返修 1；返修消息和第 2 轮输入正确 |
| A3 达到返修上限 | ds4.1 / 假评审 | 暂停（达到返修上限），成果还在 |
| A4 评审失败 | ds4.1 / 假评审 | 暂停（评审失败），重试 1 次 |
| A5 评审改了文件 | ds4.1 / 假评审 | 暂停（评审改动了工作区） |
| A6 不写标记也会评审 | ds4.1 / 假评审 | 完成（开发方写了标记则无法判定） |
| A7 评审完成后自动执行验收命令 | ds4.1 / 假评审 | 完成，验收命令执行 1 次，结果进总结 |

每个场景还要满足：零人工干预、只有一个开发会话、没有新提交、总结计数与会话状态一致。结果三种：🟢 通过、🔴 不通过（产品问题）、⚪ 无法判定（模型行为或环境问题，重跑即可）。报告在系统临时目录 `autoreview-e2e-*/report.md`，通过的场景清理现场，其余保留现场，看完手动删。退出码：0 全部通过，1 有不通过，2 验收未完成。

## 总结

写到 `~/.pi-autoreview/<项目目录名>/<开发会话id>.md`，每轮评审后覆盖写一次，包括验收结果（如有）、各轮必修/小问题/需求疑问、未解决必修和改动文件。
