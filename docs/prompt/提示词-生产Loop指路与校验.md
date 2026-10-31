# 生产 Loop 时按需指路，写错配置当场报错（Claude Code 与 Codex）

## 目标

协调方写 Loop 配置（批次配置、项目配置、提示词）时，规则只靠「先读 README」一句文字；Loop 更新后配置出错明显增多，错误要到 `bin/loop 开工 / 启动` 才暴露。现在 Loop 插件 hook 在协调方会话里只给交付总表待回写提醒（`hosts/hook.ts` 的 `passiveSessionStart`），不传规则，也不检查写出来的配置。

做两件事：

1. 只在「生产 Loop」的动作上触发：本会话第一次给一张指路卡（规则在哪个文件哪一节、本项目是否已接入批次流程）；写出的配置用 Loop 程序自身的解析校验，出错当场把报错交给模型，正确时不输出。
2. 接入命令替换写法块时输出变更摘要，并列出同一仓库其他工作区里的旧版副本。

完整背景、事实和设计见 `/Users/Admin/Desktop/loop/iusses/升级后旧启动方式无提示导致接入项目未迁移批次流程.md`（只读）「处理方向」1、2。

## 已拍板

- **协调方**：任何加载了本插件 hook 的会话，目前是 Claude Code 和 Codex，两边行为一致。不按 `AUTOREVIEW_DEV_ROOT` 区分：`bin/loop-dev` 开发会话同样适用，原有评审、返修行为不变。pi 会话不加载这个 hook，不在范围内。
- **触发只看动作**，做了下表之一才触发；其余（读文件、讨论、写业务代码、普通命令）一律不输出：

| 生产 Loop 的动作 | hook 做什么 |
|---|---|
| 写/改 `docs/batches/**/批次.json` | 程序校验；本会话首次时附指路卡 |
| 写/改项目根 `.autoreview.json` | 程序校验；本会话首次时附指路卡 |
| 写/改 `.autoreview/methods/**`、`**/prompt/提示词-*.md` | 本会话首次时给指路卡 |
| 用命令行写上面这些文件（重定向、脚本等） | 命令文本里出现上述路径时，执行后按磁盘上的文件校验；首次时给指路卡 |
| 运行 `bin/loop`、`bin/pi-dev` | 本会话首次时给指路卡 |

  除 `.autoreview.json` 本身外，所在项目没有 `.autoreview.json` 的动作不触发。
- **不用 `if` 字段**：两个宿主共用 `plugins/autoreview/hooks/hooks.json`，Codex 只能按工具名匹配。新增一条 PostToolUse，工具名匹配 `Write|Edit|MultiEdit|Bash|apply_patch`（Codex 的 `exec_command` 按 `Bash` 匹配）。是否属于上表由脚本判断；范围外立即退出 0、不输出、不加载校验相关模块。
- **判断、指路、校验只写一份，与宿主无关**；宿主只负责把输入换成「本次触及的路径 + 命令文本」：
  - Claude Code：Write / Edit / MultiEdit 取 `tool_input.file_path`；Bash 取 `tool_input.command`。
  - Codex：`apply_patch` 取 `tool_input.command` 里的 `*** Add File:` / `*** Update File:` / `*** Move to:` 行；Bash（含 `exec_command`）取 `tool_input.command`。
- **渐进**：会话开始不新增内容（现有待回写提醒保留）；本会话第一次生产动作给指路卡；校验出错给 Loop 程序的报错原文，加一句指向对应规则那一节；校验通过不输出。同一次写入同时命中时合成一条输出。
- **指路卡**不超过 6 行，只写文件名 + 绝对路径 + 一句描述 + 本项目状态，不写规则正文；内容在代码里只维护一份。覆盖：任务提示词与验收标准（`README-验收标准.md`）；批次配置与开工、启动、合入（`README.md` 对应各节）；项目配置、方法与迁移（`项目文档/运行与维护.md`「项目配置示例」「迁移与检查」）；一行「合入走 `bin/loop 合入`（合入队列），不要在会话里手动 git 合并」。
- **本项目状态**：原始 `.autoreview.json` 里 `release`、`workspaces`、`methods` 一个都没有，且仓库里没有任何 `docs/batches/*/批次.json` 时，写「本项目未接入批次流程，迁移见「迁移与检查」」；否则不写这一行。要看原始 JSON，不能看解析后的配置（`release` 不写也会默认成 `main`）。
- **校验不另写规则**：`批次.json` 用 `loop.ts` 的 `loadBatch`（只读）；`.autoreview.json` 用 `config.ts` 现有的解析函数。批次配置引用的提示词等文件尚未写出时，只提示「尚未找到」，不当错误。
- **输出**只用 PostToolUse 的 `hookSpecificOutput.additionalContext`，两个宿主一致；不用 `decision: "block"`（Codex 会把工具结果整个换掉）。不撤销、不拦截后续操作；hook 任何异常都静默退出 0。
- **「本会话首次」**按宿主 + `session_id` 记；收到 `source` 为 `compact` 的 SessionStart 时清掉标记。同一文件的同一条报错，本会话不重复输出。
- **采样开关**：某个环境变量（名字你定）指向目录时，把 PostToolUse 的原始输入原样存一份，供合入后在真实宿主里核对；默认关。
- **写法块变更摘要**：接入命令替换写法块时，输出「vN → vM」和新增、删除的条款原文；用 `git worktree list` 找同一仓库其他工作区里版本更旧的 `.autoreview/CONVENTIONS.md`，只列出路径，不修改。

## 边界

- 代码主要涉及：`plugins/autoreview/hooks/hooks.json`；`hosts/hook.ts`（PostToolUse 分派、compact 清标记）；新增一个与宿主无关的模块放判断、指路、校验（名字你定）；`setup-acceptance.ts` / `onboarding.ts`（变更摘要）。用法同步到 `README.md`「Claude Code / Codex 用法」和 `工具清单.md` 对应各节，写明部署步骤：Claude Code 重新加载插件、Codex 在 `/hooks` 里重新信任，给出可复制命令。
- 测试放在 `test/`：按两个宿主官方 hooks 文档的字段构造输入样本（Claude Code：Write、Edit、Bash；Codex：`apply_patch`、Bash），一律在系统临时目录里的 git 仓库中运行。
- 不改 `项目文档/`、`项目模板/`（迁移清单由协调方在本批合入后另写）；不改 `review-prompt.md`、`test/e2e.mjs` 的场景和断言、`eval/`、`iusses/`、`temp/`、`.autoreview.json`。
- 不修改本机 `~/.claude`、`~/.codex` 下的配置和插件安装，不启动真实 Claude Code / Codex 会话；不提交，不推送。

## 验收标准

A1. 操作：用 Claude Code 和 Codex 两种输入样本，分别送进读文件、普通 Bash 命令、编辑业务代码文件，各 20 次并计时
    预期：全部退出 0、没有任何输出，也没有加载校验相关模块；每次耗时的中位数写进交付说明
A2. 操作：同一会话先写 `docs/prompt/提示词-x.md`，再写一份正确的 `docs/batches/x/批次.json`（两种宿主各做一遍）
    预期：第一次写入后输出指路卡（不超过 6 行，含三个文件的绝对路径）；第二次没有输出
A3. 操作：写一份缺 `stages` 的 `批次.json`，分别用文件编辑样本和 Bash 重定向样本各写一次（两种宿主各做一遍）
    预期：都输出与 `bin/loop 开工` 相同的报错原文，并指向 README 对应一节；同一报错同会话不重复；改正后再写没有输出
A4. 操作：写一份引用了不存在的提示词文件、其余正确的 `批次.json`
    预期：只提示「尚未找到」，不作为错误
A5. 操作：在原始 `.autoreview.json` 没有 `release`、`workspaces`、`methods`，也没有 `docs/batches/*/批次.json` 的临时项目里，送一条运行 `bin/pi-dev` 的 Bash 样本；再在已有这些配置的临时项目里送一次
    预期：前者的指路卡写明「本项目未接入批次流程」和迁移说明位置；后者没有这一行
A6. 操作：送一条 `source` 为 `compact` 的 SessionStart，再做一次生产动作
    预期：重新输出一次指路卡
A7. 操作：带 `AUTOREVIEW_DEV_ROOT` 的开发会话做 A2、A3 的动作
    预期：输出与 A2、A3 相同；该类会话原有的 Stop 评审测试照常通过
A8. 操作：对写法块为 v5 的临时项目运行 `node setup-acceptance.ts`，同一仓库另一个工作区留一份 v5 副本
    预期：输出写明 v5 → v6 及新增条款原文；列出另一个工作区旧副本的路径，且该文件未被修改
A9. [人工] 操作：合入后按交付说明重新加载 Claude Code 插件、在 Codex `/hooks` 里重新信任，两个宿主各开一个会话写一份缺 `stages` 的 `批次.json`，并打开采样开关
    预期：两边都看到报错和指路卡；采到的原始输入字段与测试样本一致
A10. 操作：执行 `PATH="/Users/Admin/.hermes/node/bin:$PATH" node --test test/*.test.ts`
    预期：全部通过；其中有测试核对指路卡指向的每个文件和标题都真实存在
