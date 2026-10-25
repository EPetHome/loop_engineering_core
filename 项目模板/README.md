# 项目模板：接入 loop 的项目长什么样

本目录是「接入 loop 的项目」的样板，开发 loop 时用来对照上下游：代码放在哪、开发空间在哪、文档放在哪、项目方法怎么写、每批只准备什么、loop 从哪一步接手、做完交给谁。

新做法是 git worktree + 项目方法只写一份 + 每批一份 `批次.json`。`项目根/` 是一个 git 仓库的骨架（模板本身不是仓库），`<尖括号>` 里是要替换的内容。Promate 仍用旧的非 git `dev分支/` 结构（兼容做法见文末），按用户决定不迁移；本模板不表示它已经迁移。

- `项目根/` 下按真实位置摆好每类文件的骨架。
- 会变的写法规则（提示词怎么写、验收标准怎么写、`.autoreview.json` 有哪些字段）不在这里重复，指向 [README-验收标准.md](../README-验收标准.md)、[工具清单.md](../工具清单.md) 和 [README.md](../README.md)。
- 每个骨架文件开头有「模板说明」：这个文件做什么、谁写谁读。Promate 实例只作历史对照，不当成已迁移。

## 目录

```
项目模板/
├── README.md                          本页
└── 项目根/                             一个接入 loop 的 git 仓库骨架
    ├── AGENTS.md                      协调方规则（只放稳定内容）
    ├── CLAUDE.md                      只有一行 @AGENTS.md
    ├── .autoreview.json.示例          复制成 .autoreview.json，替换占位符；进仓库
    ├── .autoreview/
    │   ├── methods/                   项目固定方法，只写一份，进仓库
    │   │   ├── README.md              方法说明
    │   │   ├── self-check.sh          方法自测；占位符没替换就报方法错误
    │   │   ├── gate.sh                门禁命令（替换示例）
    │   │   └── prepare.sh             准备检查与恢复（替换示例）
    │   └── CONVENTIONS.md             接入后由 setup-acceptance.ts 写入【块 1】
    ├── .gitignore.示例                本机忽略规则示例；复制到 .git/info/exclude，不提交验收环境
    ├── deploy/acceptance/             分支专属、只在本机：隔离验收环境（localFiles 声明）
    │   ├── start.sh
    │   ├── reset-data.sh
    │   ├── release.sh
    │   └── GUIDE.md
    ├── docs/
    │   ├── baseline/                  基线四页：项目现在在哪
    │   │   ├── 当前基线与入口.md
    │   │   ├── 主线图.md
    │   │   ├── 当前能力.md
    │   │   └── 尚未完成与后续顺序.md
    │   ├── requirements/              需求书；做完的移进 xxx/
    │   │   └── 需求-示例.md
    │   ├── prompt/                    方案、提示词、启动说明；执行完的移进 xx/
    │   │   ├── 方案-示例.md
    │   │   ├── 提示词-示例.md
    │   │   └── 启动说明.md
    │   └── batches/                   每批一个批次目录
    │       └── 示例批次-20261012/
    │           ├── 批次.json          本批参数；prompt 字段引用提示词
    │           └── 结果.md            本批唯一的结果
    ├── 线上/                           运行版代码所在位置（示例；可以换成 src/ 或其他目录）
    │   └── 说明.md
    └── dev分支说明.md                  worktree 开发空间与兼容说明

项目外：
../<仓库目录名>-dev分支/                git worktree 开发空间（.autoreview.json 的 workspaces 可改）
~/.pi-autoreview/<项目目录名>/          loop 状态、总结、门禁日志、验收材料
```

开发空间不在 `项目根/` 里，也不进模板目录。`loop 开工` 在运行版目录外创建或复用 worktree，并在里面切批次分支。

## 和 Promate 对照

| 模板 | 作用 | Promate 实际位置 / 说明 |
|---|---|---|
| `项目根/` | 一个 git 仓库骨架 | `/Users/Admin/Desktop/Promate` 仍是旧结构：项目根不是 git 仓库，代码在 `线上/`，开发在手工同步的 `dev分支/` |
| `AGENTS.md`、`CLAUDE.md` | 协调方规则 | 同名 |
| `.autoreview.json` | 项目配置：发布分支、工作区、本机文件、方法、门禁、验收 | 旧版在 `dev分支/.autoreview.json` |
| `.autoreview/methods/` | 项目固定方法 | Promate 旧版把门禁等放在批次目录，尚未迁移 |
| `docs/baseline/` | 基线四页 | `重新出发/00-基线/`（07、06、02、03） |
| `docs/requirements/` | 需求书 | `新需求/<线>/`，做完的在 `新需求/xxx/` |
| `docs/prompt/` | 方案、提示词、启动说明 | `coding/prompt/`（启动说明叫 `pi启动方式.md`） |
| `docs/batches/<批次>/` | 批次参数和结果 | `coding/docs/<批次>-<日期>/`；新模板只放 `批次.json` 和 `结果.md` |
| `线上/` | 运行版代码所在位置 | `Promate产品中台/` 和 `promate-frontend/`，各有团队 .git；旧流程仍由协调方合入 |
| 开发空间 | worktree + 批次分支 | 旧 `dev分支/`；并行时 `dev分支2/` |
| 模板没放 | 产品依据、问题清单 | `文档/`、`iusses/` |

## 谁在干活

- 用户：拍板，做业务验收，授权合入和推送。需要时在终端执行协调方给出的同一条命令，不打开文件夹。
- 协调方（Claude Code，工作目录在运行版项目根）：写需求、方案、提示词和 `批次.json`；执行 `bin/loop 开工` / `启动`，核对状态和结果；维护项目方法与基线；用户授权后执行 `bin/loop 合入`。
- 项目维护者：维护 `.autoreview/methods/`（门禁、准备、棘轮、自测）和验收环境；方法只写一份。
- 开发方（Pi）：在 worktree 的批次分支里改代码；不提交。段完成后由程序提交。
- 评审方、验收方：由 loop 启动，评审方只读。

## 一批从需求到上线

```
① 头脑风暴（用户和协调方在聊天里）
② 需求书 docs/requirements/          用户在聊天里拍板，当轮写回需求书
③ 方案 docs/prompt/方案-*.md          要点先聊，拍板后才写
④ 提示词 docs/prompt/提示词-*.md       四节；验收标准先给用户看
⑤ 写 docs/batches/<批次>/批次.json 和提示词
   → 协调方在运行版执行 bin/loop 开工 <批次.json>
      建/切 worktree、从发布分支拉批次分支、检查并复制 localFiles、按指纹自测
   → 执行 bin/loop 启动 <批次.json>
      单段直接开会话；多段交给流水线
─────────────────── loop 管的部分 ───────────────────
⑥ Loop 准备 → Pi 开发与定向自检 → 门禁 → 静态评审 →（自动验收/必需验收命令） → 返修（最多 4 次）→ 完成 / 暂停
   每段完成时程序按 <类型>: <描述> 提交；串行的下一段以这次提交为开工依据
   产出：~/.pi-autoreview/<项目目录名>/<会话>.md；Pi 另外写 docs/batches/<批次>/结果.md
──────────────────────────────────────────────────────
⑦ 协调方核对：bin/loop 状态、loop 总结、结果.md 和原始日志
⑧ 用户授权合入：协调方在运行版执行 bin/loop 合入 <批次.json>
   本地 merge --no-ff 批次分支，不推送；先留改前备份；冲突时中止并报告
⑨ 用户业务验收（[人工] 条目和 loop 判「需人工」的条目）→ 在基线「待你核销」里核销
⑩ 归档：提示词标题下写「✅ 已执行」，移进 xx/；主线图留一行
```

批次目录里不再放门禁、棘轮、启动脚本或 `.autoreview.json` 副本。每批只写 `批次.json` 和结果；提示词在 `docs/prompt/`，由 `批次.json` 的 `stages.<段>.prompt` 引用。门禁和准备来自 `.autoreview/methods/`，启动统一经过 `bin/pi-dev`。模板里的 `deploy/acceptance/` 骨架随仓库交付；接入时把 `.gitignore.示例` 的内容复制到项目的 `.git/info/exclude`（或项目自己的 `.gitignore`），让真实本机文件只在本地存在。

## 规则分四层

原则：稳定的规则写进常驻文件，会变的只写一个指向。常驻文件只放稳定边界；动态来源、运行状态和可变写法各有位置。

1. 用户全局 `~/.claude/CLAUDE.md`：管输出格式。规定「出 pi 提示词」前，先读 loop 的 `工具清单.md`；需要细节时再查 README。
2. 项目 `AGENTS.md`：分工、流程、分支与合入、评审边界、上线与数据保护、沟通方式。
3. 外部文档：写法规则看 loop 的 `README-验收标准.md`，工具和字段看 `工具清单.md`；项目自己的选择（模型、工具组合、批次分支命名）看 `docs/prompt/启动说明.md`。
4. 提示词和 `批次.json`：每批一份。loop 会自动往 Pi 的系统提示里追加开发约定。

## 改 loop 时对照哪里

| 改 loop 的哪一块 | 对照模板的哪里 | 相关缺口 |
|---|---|---|
| `core.ts` 开发约定、`autoreview.ts` | `提示词-示例.md`；`AGENTS.md`（Pi 也会读到） | 1、7 |
| `review.ts` 门禁、`scope.ts` 越界 | `.autoreview/methods/gate.sh`；`批次.json` 的 `scope` | 2 |
| `git.ts`、`config.ts`、`workspace.ts` | `dev分支说明.md` 的 worktree；`.autoreview.json.示例` 的 `release` / `workspaces` / `localFiles` | 3 |
| `hosts/hook.ts`（Claude Code 插件） | `AGENTS.md` 的评审边界 | 3 |
| `acceptance.ts`、`setup-acceptance.ts` | `.autoreview.json.示例`、`deploy/acceptance/` | 9 |
| `onboarding.ts` 提示文案 | `AGENTS.md`「沟通」 | 10 |
| `pipeline.ts`、`loop.ts` | `批次.json`、`docs/batches/` | 3、9 |
| 总结（`~/.pi-autoreview/`） | `结果.md`、`当前基线与入口.md`「待你核销」 | 5、6、11 |
| 暂停和恢复 | `结果.md` 的当前结论；loop 总结 | 8 |
| 开工、启动、状态、合入 | `启动说明.md`「开工」、`线上/说明.md`、`工具清单.md` | 4、5 |

## 接入项目仍需核对

本模板展示职责与目录，不自动迁移 Promate 或其他项目。项目维护者仍需确认实际发布分支、测试库隔离、准备/恢复/释放脚本和来源范围。机器可读段状态、交付索引和原始证据由 Loop 生成；合入发布分支、生产数据备份和业务核销继续按各项目授权。

自动归档只写交付索引，业务基线的语义调整仍由维护者依据证据处理。模板是结构样板，不是空脚本也能通过的运行成品；占位符未替换时，`bin/loop 开工` 会在方法自测阶段报 `AUTOREVIEW_FAILURE=method` 并列出未替换的占位符，不会空跑通过。

## 本次迭代的管理入口

- `AGENTS.md`：稳定职责与来源链接，普通准备、归档和定时刷新不写它。
- `.autoreview/CONVENTIONS.md`：可变任务/验收写法，由接入命令维护。
- `.autoreview/methods/`：项目固定方法，只写一份；门禁、棘轮、准备、自测都在这里。
- `批次.json`：每批参数；字段见 [工具清单.md](../工具清单.md) 的「批次.json 字段」。
- `context.sources`：项目维护者声明需求、方案、方法和源码位置；`changes.jsonl` 记录增删改与受影响依赖，`contents/<SHA>` 留内容版本。
- `preparation.check/recover/repair.paths`：已有方法优先、已知故障有限恢复、方法失效才调用受限模型。
- 批次结果只引用 Loop 总结与交付索引，不复制多个“当前结论”；不可改坏的行为和来源版本写在同一任务文件中。
- `acceptance.actions` 固化重复操作，`cleanup` 释放本轮项目资源；动作可复用，旧通过结论不可盲用。

完整字段、限制和恢复方式见 [工具清单.md](../工具清单.md) 与 [运行与维护](../项目文档/运行与维护.md)。

## 兼容：非 git 项目与外部基线

外部基线（`GIT_DIR` / `GIT_WORK_TREE`）和 rsync 同步只为不是 git 仓库的历史项目保留，不再是模板默认流程。新项目用运行版 + worktree 后，不需要每批同步、不需要把开工点提交到 `~/.pi-autoreview/git-baselines/`。Promate 等已有项目是否迁移，由用户单独决定；未授权迁移时继续按原流程运行。
