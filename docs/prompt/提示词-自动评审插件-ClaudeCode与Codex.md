# 任务：把自动评审做成 Claude Code / Codex 插件，覆盖旧 loop-guard 插件

> 执行方：pi（opencode-go/deepseek-v4.1-flash）　·　生成日期：2026-10-04　·　**不提交**
> 工作目录：`/Users/Admin/Desktop/loop`（git 仓库，分支 dev）
> **本会话挂着 `autoreview.ts` 自己运行**：你交付后会自动请 Astra 评审，有必修会发回本会话。不要 `/reload`。

## 一、目标

用户在 pi 里已经能用自动评审（`autoreview.ts`）。现在要让用户**用 Claude Code 或 Codex 开发时也一样**：

```
开发方（Claude Code / Codex）最后一行写【交付完成】
  → Stop Hook 调用评审（Astra，经 pi -p，每个开发会话固定复用一个评审会话）
  → 有必修：Hook 返回 {"decision":"block","reason":<返修消息>}，宿主在【同一个会话】里接着返修
  → 没有必修，或返修满 3 次：放行停下，弹 macOS 通知，写总结
```

同时把两边装着的旧 `loop-guard` 插件卸掉，换成新插件。

## 二、背景（先看懂现状）

- 仓库现状：pi 扩展 `autoreview.ts` + `core.ts`（纯函数）+ `git.ts`（git 取证）+ `review-prompt.md`；测试 `test/*.test.ts` 共 49 项，全部通过。用法见 `README.md`。
- 上一轮复核和返修记录：`docs/prompt/复核结论-自动评审扩展-20261004.md`、`docs/prompt/自动评审扩展-返修简报-20261004.md`。B1–B7 的经验在这次新做的宿主 Hook 里同样适用：路径用 `-z`；git 失败就暂停；成功评审才更新检查点；快照存提交 id；比较指纹；异常收口。
- 宿主版本：Claude Code `2.1.288`（`/Users/Admin/.local/bin/claude`）；Codex `codex-cli 0.159.2`（`/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex`，PATH 里那个 npm 版已损坏，**只能用这个绝对路径**）。
- 已核实：Codex 程序里有 Stop Hook 的输入字段 `stop_hook_active`、`last_assistant_message`、`transcript_path`，也支持输出 `decision: block`（`reason` 不能为空）。Claude Code 的 Stop Hook 是同样的约定。两边都支持 `hookSpecificOutput.additionalContext`。**具体字段以实测为准，写进简报。**
- 旧插件的装法（以 `git show loop-0.4.0-final:<路径>` 为参考，看清两边插件清单和 hooks.json 的格式）：
  - 文件：`plugins/loop-guard/{plugin.json,.claude-plugin/plugin.json,.codex-plugin/plugin.json,hooks/loop-guard-hooks.json}`；`.claude-plugin/marketplace.json`、`.agents/plugins/marketplace.json`（这两个市场的源目录都是本仓库根目录）
  - Claude Code：`~/.claude/plugins/installed_plugins.json` 里有 `loop-guard@loop-guard-local`，scope 为 project，projectPath 是 `/Users/Admin/.loop040/prep`；`~/.loop040/prep/.claude/settings.json` 里启用了它，还登记了市场 `loop-guard-local`
  - Codex：`~/.codex/config.toml` 里有 `[marketplaces.loop-guard-local]`、`[plugins."loop-guard@loop-guard-local"]`，以及 4 条 `[hooks.state."loop-guard@…"]`
- 两边都有插件管理命令：`claude plugin …`（marketplace / install / uninstall / enable / disable）和 `codex plugin …`（add / list / marketplace / remove）。先看 `--help`。

## 三、已拍板的规则（不要改）

1. **评审规则、分级、返修消息、交付标记、返修上限 3 次、没有总时限、评审单次保护 60 分钟、任何异常都只暂停**：全部和 pi 扩展一致，复用 `core.ts`、`git.ts`、`review-prompt.md`，不要另写一套。
2. **按项目开启**：只有当前目录或它的某个上级目录里有 `.autoreview.json` 时，Hook 才生效；否则立即退出 0、不输出任何内容。普通会话完全不受影响。`.autoreview.json` 可以是 `{}`，可选字段为 `maxRepairs`、`reviewerModel`、`reviewerThinking`、`reviewTimeoutMin`。
3. **复用会话，禁止新开**：返修靠 Stop Hook 的 `block` 加 `reason`，宿主在原会话里继续。评审会话 id 为 `autoreview-rev-<宿主>-<会话id>`，每轮复用。
4. **评审方仍是 Astra**：`openai-codex/gpt-6-astra` + `xhigh`，调用方式和 pi 扩展的 6.8 相同（`pi --offline -p --session-id … --append-system-prompt review-prompt.md "@输入文件"`）。
5. **开发约定**（交付标记那几行）通过 `SessionStart` / `UserPromptSubmit` 的 `additionalContext` 注入，原文与 `autoreview.ts` 里的 `CONVENTION` 相同。
6. **需求原文** = 本会话第一次 `UserPromptSubmit` 的 `prompt`。同一时刻取开发基线快照。
7. **未交付提醒**、【需要你决定】通知、刚发过返修却没写标记就暂停：行为和 pi 扩展一致。
8. **状态和总结**放在 `~/.pi-autoreview/<项目目录名>/<宿主>-<会话id>.state.json` 和 `.md`，不写进项目。
9. **pi 扩展保持可用**：49 项测试继续全部通过。

## 四、边界

### ✅ 允许修改

- 新建 `hosts/hook.ts`：一个入口，按 `hook_event_name` 分派 SessionStart / UserPromptSubmit / Stop
- 把 `autoreview.ts` 里与宿主无关的「评审一轮 / 状态机 / 调评审子进程」逻辑抽到新文件 `review.ts`，由 pi 扩展和宿主 Hook 共用（高内聚，不重复）；pi 扩展只保留接入 pi 的代码
- 修改 `core.ts`、`git.ts`、`autoreview.ts`、`test/**`、`README.md`、`AGENTS.md`
- 新建插件：`plugins/autoreview/`（`.claude-plugin/plugin.json`、`.codex-plugin/plugin.json`、`hooks/hooks.json`）；重建根目录的 `.claude-plugin/marketplace.json`、`.agents/plugins/marketplace.json`（市场名 `autoreview-local`）
- 本机安装（见 6.4）：动 `~/.claude/**`、`~/.codex/config.toml`、`~/.loop040/prep/.claude/settings.json` 之前，先备份到 `.bak/<时间戳>/`。**优先用官方 CLI**；CLI 做不到时才手改，并在简报里写明
- 新建简报：`docs/prompt/自动评审插件-交付简报-20261004.md`

### 🔴 禁止

- `review-prompt.md`、`CLAUDE.md`、`.gitignore`，以及 `docs/` 下已有文件
- git 写操作（commit、add、stash push、reset、checkout、tag）
- **不要在本仓库放 `.autoreview.json`**（用户在这个目录里用 Claude Code 时不能被评审打断）
- `~/.pi/agent/**`；`~/.pi-autoreview/loop/` 不许删
- Codex 和 Claude Code 里其他插件、其他 Hook（例如 `~/.codex/hooks.json` 里的 LLM Wiki）一律不动
- 测试只能写入 `os.tmpdir()`

### ⚪ 明确不做

- 给宿主加手动 `/review` 命令（宿主里只要让开发方回复一行【交付完成】，就能触发评审）
- 让评审方换成 Claude 或 Codex
- 删除 `~/.loop040` 运行数据

## 五、必读

1. `autoreview.ts`、`core.ts`、`git.ts`、`test/autoreview.test.ts`
2. 旧插件（参考格式）：`git show loop-0.4.0-final:plugins/loop-guard/.claude-plugin/plugin.json`，以及同目录的 `.codex-plugin/plugin.json`、`hooks/loop-guard-hooks.json`、`hooks/dispatch.py`；`git show loop-0.4.0-final:.claude-plugin/marketplace.json`、`git show loop-0.4.0-final:.agents/plugins/marketplace.json`
3. `claude plugin --help` 及其子命令的 `--help`；`codex plugin --help` 及其子命令的 `--help`
4. `~/.codex/hooks.json`（看 Codex 的 Hook 写法，只读，不改）

## 六、改造规格

### 6.1 插件 Hook 配置（两边共用一份 `hooks/hooks.json`）

- 命令一律写绝对路径：`/Users/Admin/.hermes/node/bin/node /Users/Admin/Desktop/loop/hosts/hook.ts`。直接执行仓库里的文件，改代码马上生效，不依赖插件缓存的副本。
- `SessionStart`、`UserPromptSubmit` 的 timeout 设 10 秒；`Stop` 设 3700 秒（覆盖 60 分钟评审保护，再留余量）。**实测宿主是否真的按 3700 秒执行；如果宿主有更低的上限，把实际上限写进简报，并在 Hook 里把评审保护时长降到这个上限以内。**
- 宿主识别：输入里有 `turn_id` 就是 Codex，否则是 Claude Code（旧 dispatch.py 用的就是这个办法）；另外允许用环境变量 `AUTOREVIEW_HOST` 强制指定。

### 6.2 `hosts/hook.ts` 的行为

| 事件 | 动作 |
|---|---|
| 任何事件，且找不到 `.autoreview.json` | 立即退出 0，不输出 |
| 非 git 仓库，或仓库没有提交 | SessionStart 时输出一句提示（additionalContext），之后都退出 0 |
| SessionStart | 注入开发约定 |
| UserPromptSubmit | 注入开发约定；本会话第一次提交时，记下需求原文和开发基线 |
| Stop，最后一行是【交付完成】 | 同步跑评审（含失败重试 1 次）。有必修且没到上限：输出 `{"decision":"block","reason":<返修消息>}`。没有必修：放行，记完成，通知。到达上限、评审失败、评审改了工作区：放行，记暂停，通知 |
| Stop，最后一行是【需要你决定】 | 放行，通知 |
| Stop，没有标记 | 刚发过返修就暂停并通知；否则按「未交付提醒」规则提醒一次；放行 |

- 最后一条助手消息：优先用 `last_assistant_message`；没有这个字段时，从 `transcript_path` 里读。
- **不能因为 `stop_hook_active=true` 就跳过评审**：返修后的复评正是在这种状态下发生的。死循环由返修上限兜住。
- 同一会话同一时刻只允许一个评审：用状态目录里的锁文件，里面记 pid。发现锁属于已经死掉的进程（例如宿主超时把 Hook 杀了），就把状态记成「评审被中断」暂停，并通知用户。
- 任何异常都要收口：Hook 自己出错时，**放行停下**（退出 0），记暂停，尽力通知。绝不能把宿主卡死，也不能输出不合法的 JSON。

### 6.3 共用模块 `review.ts`

把「取快照 → 拼输入 → 调评审（重试） → 解析 → 比较指纹 → 决定完成 / 返修 / 暂停 → 写总结」整理成一个函数。exec、通知、状态读写都通过参数注入。pi 扩展用 `appendEntry` 做持久化；宿主 Hook 用 state.json。两边都调这一个函数。

### 6.4 本机安装（先备份）

1. **卸旧**：
   - Claude Code：卸掉 `loop-guard@loop-guard-local`（project scope，项目目录 `/Users/Admin/.loop040/prep`），移除市场 `loop-guard-local`，从 `~/.loop040/prep/.claude/settings.json` 去掉对它的启用。
   - Codex：用 `codex plugin remove` 卸掉 `loop-guard@loop-guard-local`，用 `codex plugin marketplace remove` 移除市场。之后检查 `config.toml` 里 `loop-guard` 相关的条目还剩什么，写进简报。
2. **装新**：两边都用本仓库作为本地市场 `autoreview-local`，安装 `autoreview@autoreview-local`。Claude Code 用 **user scope**（全局安装；有没有 `.autoreview.json` 决定生不生效）。
3. **核对**：Claude Code 用 `claude plugin details autoreview@autoreview-local`，Codex 用 `codex plugin list`，确认两边都装上并启用了。
4. Codex 的 Hook 需要用户在 Codex 里用 `/hooks` 确认信任。这一步你做不了，写进简报的「用户待办」。联调时如果 Hook 因为没被信任而没执行，如实记录。

## 七、设计约束（陷阱）

1. 本会话挂着旧版本的 `autoreview.ts`：不要 `/reload`，也不要在本会话里测扩展命令。重构 pi 扩展后，用单测和新起的 pi 进程验证。
2. 交付时，最后一条回复以单独一行【交付完成】结尾；收到返修后，逐条写「第 N 条：已修」或「第 N 条：异议：理由」。评审提出超出本派单范围的意见时，写「异议：超出范围（第四章明确不做）」。
3. Hook 的 stdout 只能输出宿主认识的 JSON，或者什么都不输出。调试信息写到 stderr 或日志文件。
4. Hook 运行时，宿主给的 PATH 里可能没有 hermes 的 node，也没有 pi。所以 node 和 pi 都用绝对路径，子进程的 PATH 自己补上 `/Users/Admin/.hermes/node/bin`。
5. `claude -p` 和 `codex exec` 联调会用真实模型：开发方选最便宜的模型（以 `--help` 和模型列表为准），评审用假评审（通过环境变量 `AUTOREVIEW_REVIEWER_CMD` 注入，语义同 pi 扩展的 `autoreview-reviewer-cmd`）。真实 Astra 评审只在每个宿主跑一次。
6. 不要为了联调，在用户的真实项目里或者本仓库里放 `.autoreview.json`。玩具仓库放在 `/private/tmp/autoreview-host-*`，收尾时删掉。

## 八、开发习惯

- 顺序：抽 `review.ts`，确认 49 项旧测试仍然全部通过 → 写 `hosts/hook.ts` 和它的无模型测试 → 做插件文件 → 备份、卸旧、装新 → 两边联调 → 文档。
- 先红后绿：Hook 的关键行为先写测试。

## 九、验收

### 9.0 开工前

```bash
cd /Users/Admin/Desktop/loop
git log -1 --format='%H %s'; git status --short       # 记录
PATH="/Users/Admin/.hermes/node/bin:$PATH" node --test test/*.test.ts 2>&1 | grep -E '^# (pass|fail)'   # 49 / 0
TS=$(date +%Y%m%d-%H%M%S); mkdir -p .bak/$TS
cp ~/.claude/plugins/installed_plugins.json ~/.claude/plugins/known_marketplaces.json ~/.codex/config.toml ~/.loop040/prep/.claude/settings.json .bak/$TS/
cp ~/.claude/settings.json .bak/$TS/claude-settings.json 2>/dev/null || true
shasum -a 256 ~/.codex/hooks.json ~/.pi/agent/settings.json > .bak/$TS/untouched.sha
```

### 9.1 无模型测试（`node --test test/*.test.ts`）

| # | 场景 | 期望 |
|---|---|---|
| H1 | 找不到 `.autoreview.json` | 退出 0，stdout 为空 |
| H2 | SessionStart / UserPromptSubmit | 输出 additionalContext，内容是开发约定；第一次提交时记下需求原文和基线 |
| H3 | Stop + 【交付完成】，假评审返回 1 条必修 | 输出合法 JSON，`decision=block`，`reason` 就是返修消息 |
| H4 | 接着 Stop（`stop_hook_active=true`）+【交付完成】，假评审通过 | 放行（无 block），状态为完成，发出通知 |
| H5 | 达到上限 / 评审失败两次 / 评审改了工作区 | 放行，暂停原因正确 |
| H6 | 锁文件属于已死进程 | 记成「评审被中断」暂停，并通知 |
| H7 | Hook 内部抛错 | 退出 0，stdout 为空或合法 JSON，状态记暂停 |
| H8 | 宿主识别：有 `turn_id` / 没有 / 用 `AUTOREVIEW_HOST` 强制 | 分别判为 codex / claude / 强制指定的值 |
| H9 | 原有 49 项 | 全部通过 |

### 9.2 卫生

| # | 标准 |
|---|---|
| C1 | HEAD 不变；暂存区为空；`review-prompt.md`、`CLAUDE.md`、`.gitignore`、已有 docs 没有 diff |
| C2 | `~/.codex/hooks.json`、`~/.pi/agent/settings.json` 的 sha256 和 `untouched.sha` 一致 |
| C3 | 跑完单测后，`git status --short` 不变 |
| C4 | 本仓库和用户的真实项目里都没有 `.autoreview.json`；`/private/tmp/autoreview-host-*` 已清理 |

### 9.3 安装核对

| # | 标准 |
|---|---|
| I1 | Claude Code：`loop-guard` 已卸，市场 `loop-guard-local` 已移除，`~/.loop040/prep/.claude/settings.json` 不再启用它；`autoreview@autoreview-local` 已在 user scope 安装并启用 |
| I2 | Codex：`loop-guard` 已卸，市场已移除；`autoreview@autoreview-local` 已安装；列出 `config.toml` 中残留的 `loop-guard` 条目（如果有） |

### 9.4 联调（玩具仓库里放 `.autoreview.json`，开发方用便宜模型，评审用假评审）

| # | 宿主 | 场景 | 期望 |
|---|---|---|---|
| E1 | Claude Code（`claude -p`） | 假评审：第 1 次有必修，第 2 次通过 | 同一会话内返修 1 次，状态完成；会话 id 不变 |
| E2 | Claude Code | 假评审先睡 90 秒，再通过 | Hook 没有被宿主提前杀掉（证明自定义 timeout 生效） |
| E3 | Codex（`codex exec`） | 同 E1 | 同 E1；Hook 如果因为没被信任而没执行，标 🔴 并写明 |
| E4 | Codex | 同 E2 | 同 E2 |
| E5 | 两个宿主各一次 | 真实 Astra 评审 | 能解析；记录耗时 |

每个场景都记录：零干预触发了没有（开发方自己写了标记）；有没有人工或驱动的提醒。

## 十、收尾：不提交

不 commit、不 add。清理玩具仓库。保留 `.bak/<时间戳>/`。

## 十一、交付简报

写到 `docs/prompt/自动评审插件-交付简报-20261004.md`，最后一条回复贴同样的内容并以【交付完成】结尾：

1. H、C、I、E 各项逐项标 🟢/🔴，失败的原样贴出输出
2. 实测发现：两个宿主 Stop Hook 实际收到的输入字段、timeout 的实际上限、Codex 信任机制、`stop_hook_active` 的表现
3. 改动清单：每个文件一句话，附行数；附 `git status --short`；本机配置改了哪些（附备份路径）
4. **用户待办**：例如在 Codex 里用 `/hooks` 信任；在要启用的项目里放 `.autoreview.json`
5. 自评记录：每轮自动评审的必修和处理方式
6. 偏离与未完成

## 十二、给评审方的说明

- 本轮范围以第一、三、四、六章为准，第四章「明确不做」里的内容不能列为必修。
- 联调会调用真实模型，开发方已经跑过并写进简报，**评审方不要重跑联调，也不要执行安装或卸载命令**。可以跑单测：`PATH="/Users/Admin/.hermes/node/bin:$PATH" node --test test/*.test.ts`。
