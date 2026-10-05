# pi 自动评审扩展

本仓库现在是 pi 自动评审扩展（旧的 Loop 0.4.0 已删除，代码留在 git 历史 `f16edc4`）。

## 文件

- `autoreview.ts`：扩展入口。注册事件与命令、取 git 快照/指纹、调评审子进程、发返修消息、通知和写总结。
- `core.ts`：纯函数（标记判断、评审解析、下一步决策、消息/输入/总结渲染），不导入 pi。
- `review-prompt.md`：评审规则，通过 `--append-system-prompt` 原样交给评审。
- `test/core.test.ts`：core 单测；`test/fake-reviewer.mjs`：联调假评审；`test/e2e.mjs`：RPC 联调驱动。
- `docs/`：历史资料，不改；`temp/`：用户资料区，不碰。

## 怎么跑

单测：

```bash
PATH="/Users/Admin/.hermes/node/bin:$PATH" node --test test/core.test.ts
```

确认扩展能加载：

```bash
pi --offline --no-extensions -e ./autoreview.ts --help
```

联调（会调用模型，几到几十分钟；不加参数跑 R1–R6 全部）：

```bash
PATH="/Users/Admin/.hermes/node/bin:$PATH" node test/e2e.mjs R1
```

## 改动纪律

- 只改本仓库，不 commit/add/stash/reset（交付留给用户）。
- `docs/` 是历史资料，`temp/` 是用户资料区，一行不动。
- 不乱建文件；测试产物写到 `/private/tmp/` 或 `~/.pi-autoreview/`，收尾清理。
- 开发方约定文本和 `review-prompt.md` 是产品行为，改动要连同单测一起。
