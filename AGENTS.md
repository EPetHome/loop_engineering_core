# pi 自动评审扩展

本仓库现在是 pi 自动评审扩展 + Claude Code / Codex 插件（旧的 Loop 0.4.0 已删除，代码留在 git 历史 `f16edc4`）。配了 `acceptance` 的项目在评审前先做自动验收（黑盒实操 + 系统日志 + 程序判定）；配了 `--autoreview-accept-cmd` 时评审完成后再执行验收命令（本仓库用它跑 E2E），两者互不相干。

## 文件

- `autoreview.ts`：pi 扩展入口。注册事件与命令、成功评审检查点、可取消评审任务、返修消息、评审完成后的验收命令（`--autoreview-accept-cmd`、`/accept`）、通知和总结。
- `review.ts`：一轮的共用流程（快照、先验收、输入、调用重试、解析、指纹比较、完成/返修/暂停决策），pi 扩展与宿主 Hook 共用。
- `acceptance.ts`：自动验收一轮的流程（异议检查、取或起草标准、查端口、启停被测系统、记系统日志、调验收方并在证据有问题时重做 1 次、截日志、判定）。
- `acceptance-core.ts`：验收纯函数（取「## 验收标准」、解析报告、扫日志、核对证据、逐条判定、验收方输入与返修消息）与验收约定原文。
- `config.ts`：`.autoreview.json` 查找与字段校验（含 `acceptance` 一节）、本机路径常量。
- `onboarding.ts`：接入手册的复制块（只在 `README-验收标准.md` 维护一份）、项目里的目标文件、写法段缺失或过期、「把【块 N】复制到 <完整路径>」提示、总结「需要你做的事」。
- `setup-acceptance.ts`：接入命令，探测项目类型、启动命令和端口，先给计划、确认后写 `.autoreview.json` 和【块 1】；可重复跑。
- `hosts/hook.ts`：Claude Code / Codex 的 Hook 入口，按 `hook_event_name` 分派 SessionStart / UserPromptSubmit / Stop。
- `git.ts`：git 快照、指纹、NUL 路径列表和 diff 取证，注入 exec 便于测试。
- `procs.ts`：长进程登记（评审等子进程自成进程组，组号记到 `<宿主>-<会话id>.procs.json`），Hook 被杀后据此清理孤儿。
- `core.ts`：纯函数（标记判断、评审解析、下一步决策、消息/输入/总结渲染）与开发约定原文，不导入 pi。
- `review-prompt.md`：评审规则，通过 `--append-system-prompt` 原样交给评审。
- `acceptance-prompt.md`、`criteria-prompt.md`：验收方规则、起草验收标准规则，同样原样交给模型；示例格式由单测核对能被解析。
- `acceptance-tools/`：验收方的工具，`ev.mjs`（跑命令留证据）、`browser.mjs`（无头 Chromium 操作网页留证据）；每轮在运行目录生成 `./ev`、`./browser` 包装脚本。
- `README-验收标准.md`：接入手册，【块 1】写法段（带版本与起止标记）、【块 2】启动配置、【块 3】浏览器工具；程序提示和接入命令都引用它，单测核对三块都在且能用。
- `plugins/autoreview/`：插件清单与 `hooks/hooks.json`；根目录 `.claude-plugin/marketplace.json`、`.agents/plugins/marketplace.json` 是本地市场 `autoreview-local`。
- `test/*.test.ts`：core 单测、验收单测（含真起被测系统）、接入单测（手册、提示、接入命令）、fake pi 入口回归、git 取证、宿主 Hook 回归、E2E 判定与驱动回归；`test/fake-reviewer.mjs`、`test/fake-tester.mjs`、`test/fake-drafter.mjs`：假评审、假验收方、假起草方；`test/e2e.mjs`：E2E 实操验收（RPC 驱动 pi，场景 A1–A7，含验收命令；尚未覆盖自动验收）。
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

E2E 实操验收（开发方与真实评审都用 ds4.1-flash，几到几十分钟；不加参数跑 A1–A7 全部）：

```bash
PATH="/Users/Admin/.hermes/node/bin:$PATH" node test/e2e.mjs A1
```

验收标准写在 `test/e2e.mjs` 的 `SCENARIOS` 和 `commonChecks` 里；报告在系统临时目录 `autoreview-e2e-*/report.md`。开发本仓库时用 `--autoreview-accept-cmd "node test/e2e.mjs"`，评审完成后由扩展自动执行，开发方不用自己跑、也不在简报里自报结果。

## Claude Code / Codex 插件

- 本仓库是本地市场 `autoreview-local`，插件名 `autoreview`；Hook 命令直接执行 `hosts/hook.ts`，改代码立即生效。
- 只有当前目录或某个上级目录存在 `.autoreview.json` 的项目才生效；字段可选：`maxRepairs`、`reviewerModel`、`reviewerThinking`、`reviewTimeoutMin`、`acceptance`（字段见 README「自动验收」，pi 扩展也读这一节）。
- 开发方最后一行写【交付完成】触发评审；不写标记但工作区有未评审改动时也会自动评审。有必修时 Stop Hook 返回 `{"decision":"block","reason":…}`，宿主在原会话继续返修，最多 `maxRepairs`（默认 4，验收打回和评审打回共用）次。
- 自动验收：先验收后评审，共用一轮 `reviewTimeoutMin`；验收不通过直接打回、不评审；验收标准只从用户消息（UserPromptSubmit / `before_agent_start`）的「## 验收标准」取，冻结，用户再发新的才替换；开发方写「A2：异议」时暂停交用户。
- 无法验证分原因：验收方没做好 → 同会话重做 1 次、再换强模型（`strongModel`，默认评审模型）另开会话重验 1 次；没配启动（连不上也改判，不打回）、缺工具、全部没验证 → 暂停并给出「复制【块 N】到 <路径>」；只有个别条目 → 部分验证，照常评审，完成时列给人工。
- 给用户看的提示走 `systemMessage`（只对 Claude Code）、pi `ctx.ui.notify`、系统通知、总结「需要你做的事」；`additionalContext` 只有模型看得到。写法段缺失或过期每个会话提醒一次（`conventionNoticed`）。
- 宿主交给 Hook 的消息不展开 `@文件`，`expandFileRefs` 自己展开（最多 3 个、每个 200KB、跳过二进制），需求原文和验收标准按展开后的算。
- 「返修后没有任何改动」比较的是 `lastCheckedFingerprint`（最近一次给出结论时的指纹，含验收不通过），评审 diff 的基线仍是上次成功评审。
- 暂停或评审被中断（死锁 + `reviewing`）后，用户再提交消息即恢复自动评审、返修计数清零：Hook 在 UserPromptSubmit 做，pi 扩展在 `before_agent_start` 做；活进程持锁时不动。
- Stop Hook 收到 SIGTERM/SIGINT/SIGHUP 时先杀掉自己登记的子进程组再退出；被 SIGKILL 时，下一次 SessionStart / UserPromptSubmit / Stop（死锁）先清理登记里的残留进程（核对启动时间，防止进程号复用误杀）。
- 状态与总结在 `~/.pi-autoreview/<项目目录名>/<宿主>-<会话id>.state.json` / `.md`。
- Codex 首次安装后需要在 Codex 里用 `/hooks` 确认信任 Hook。
- 测试用假评审：环境变量 `AUTOREVIEW_REVIEWER_CMD`（语义同 `autoreview-reviewer-cmd`）、`FAKE_MODE`、`FAKE_STATE_DIR`。
- 测试用假验收方 / 假起草方：`AUTOREVIEW_ACCEPTANCE_CMD`、`AUTOREVIEW_CRITERIA_CMD`（两个宿主都读环境变量）、`FAKE_ACC_MODE=pass|lazy|garbage|modify|unreachable`、`FAKE_ACC_STRONG`（换强模型时的模式）、`FAKE_ACC_FAIL=A2`、`FAKE_ACC_UNKNOWN=A3`、`FAKE_ACC_URL`、`FAKE_DRAFT_MODE`。

## 改动纪律

- 只改本仓库，不 commit/add/stash/reset（交付留给用户）。
- `docs/` 是历史资料，`temp/` 是用户资料区，一行不动。
- 不乱建文件；测试产物（含临时 HOME、会话、总结）只写系统临时目录，收尾清理。例外：E2E 的报告和未通过场景的现场留在 `autoreview-e2e-*`，由用户看完删除。
- E2E 验收口径（`test/e2e.mjs` 的场景与断言）由用户定，改动要在交付说明里写明改了哪条、为什么。
- 开发方约定文本和 `review-prompt.md` 是产品行为，改动要连同单测一起。
