# pi 自动评审扩展

本仓库现在是 pi 自动评审扩展 + Claude Code / Codex 插件（旧的 Loop 0.4.0 已删除，代码留在 git 历史 `f16edc4`）。

## 文件

- `autoreview.ts`：pi 扩展入口。注册事件与命令、成功评审检查点、可取消评审任务、返修消息、通知和总结。
- `review.ts`：评审一轮的共用流程（快照、输入、调用重试、解析、指纹比较、完成/返修/暂停决策），pi 扩展与宿主 Hook 共用。
- `hosts/hook.ts`：Claude Code / Codex 的 Hook 入口，按 `hook_event_name` 分派 SessionStart / UserPromptSubmit / Stop。
- `git.ts`：git 快照、指纹、NUL 路径列表和 diff 取证，注入 exec 便于测试。
- `core.ts`：纯函数（标记判断、评审解析、下一步决策、消息/输入/总结渲染）与开发约定原文，不导入 pi。
- `review-prompt.md`：评审规则，通过 `--append-system-prompt` 原样交给评审。
- `plugins/autoreview/`：插件清单与 `hooks/hooks.json`；根目录 `.claude-plugin/marketplace.json`、`.agents/plugins/marketplace.json` 是本地市场 `autoreview-local`。
- `test/*.test.ts`：core 单测、fake pi 入口回归、git 取证、宿主 Hook 回归和联调断言测试；`test/fake-reviewer.mjs`：联调假评审；`test/e2e.mjs`：RPC 联调驱动。
- `docs/`：历史资料，不改；`temp/`：用户资料区，不碰。

## 怎么跑

单测：

```bash
PATH="/Users/Admin/.hermes/node/bin:$PATH" node --test test/*.test.ts
```

确认扩展能加载：

```bash
pi --offline --no-extensions -e ./autoreview.ts --help
```

联调（会调用模型，几到几十分钟；不加参数跑 R1–R6 全部）：

```bash
PATH="/Users/Admin/.hermes/node/bin:$PATH" node test/e2e.mjs R1
```

## Claude Code / Codex 插件

- 本仓库是本地市场 `autoreview-local`，插件名 `autoreview`；Hook 命令直接执行 `hosts/hook.ts`，改代码立即生效。
- 只有当前目录或某个上级目录存在 `.autoreview.json` 的项目才生效；字段可选：`maxRepairs`、`reviewerModel`、`reviewerThinking`、`reviewTimeoutMin`。
- 开发方最后一行写【交付完成】触发评审；不写标记但工作区有未评审改动时也会自动评审。有必修时 Stop Hook 返回 `{"decision":"block","reason":…}`，宿主在原会话继续返修，最多 `maxRepairs`（默认 3）次。
- 暂停或评审被中断（死锁 + `reviewing`）后，用户再提交消息即恢复自动评审、返修计数清零：Hook 在 UserPromptSubmit 做，pi 扩展在 `before_agent_start` 做；活进程持锁时不动。
- 状态与总结在 `~/.pi-autoreview/<项目目录名>/<宿主>-<会话id>.state.json` / `.md`。
- Codex 首次安装后需要在 Codex 里用 `/hooks` 确认信任 Hook。
- 测试用假评审：环境变量 `AUTOREVIEW_REVIEWER_CMD`（语义同 `autoreview-reviewer-cmd`）、`FAKE_MODE`、`FAKE_STATE_DIR`。

## 改动纪律

- 只改本仓库，不 commit/add/stash/reset（交付留给用户）。
- `docs/` 是历史资料，`temp/` 是用户资料区，一行不动。
- 不乱建文件；测试产物（含临时 HOME、会话、总结）只写系统临时目录，收尾清理。
- 开发方约定文本和 `review-prompt.md` 是产品行为，改动要连同单测一起。
