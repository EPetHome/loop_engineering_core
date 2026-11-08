# Loop 内核与节点编排实施方案

当前阶段：**第五步第一批已发布；第五步第二批 C1—C8 开发及定向程序覆盖完成，外层第 2 轮静态评审通过（0 条必须修改、2 条建议）。用户本次已授权提交源分支、统一合入 dev 及本机部署；发布事实以本节后的实际发布记录和证据为准，不将旧检查伪造为发布卡结论。** 用户已明确要求“开始第二批，如果要loop的话，最后给我启动指令，我自己来”。本次执行下方八类旧路径清理，保持五步顺序；第一批真实窗口体验及业务/人工验收仍未验证，不因第二批开工补记通过，也不自动追加真实模型验收。

第一批发布事实：第6轮外层静态评审通过，源提交 `ccb95d0` 已推送 `origin/refactor/loop-kernel-step5-flow`；统一发布提交 `e170e31787e4d96aedf1f9adbcdafa9ef16794c3` 已合入并推送 dev，本地入口更新、原有修改保留、发布临时资源释放有记录。发布卡自身评审缺项保留，不与源代码外层评审混称。证据：`/Users/Admin/.pi-autoreview/deployments/loop-kernel-step5-flow-y04HhxGB/final-verification.json`。下文第一批“待复评/尚未启动”等描述保留当时历史，不代表当前发布状态。

第四步发布已完成：源提交 `0f98dfc` 经统一 `bin/loop 合入` 压缩为 `623bd10435904e908a30b9c7896e422d82494ac5`，已合入本地 dev 并推送 origin/dev，发布卡登记工作区已释放。用户明确接受“发布卡缺少本卡有效开发评审记录”；旧外层第 3 轮静态评审通过和既有 59+4 条兼容检查不伪造为本卡检查通过，也不代表真实部署或业务验收通过。13 个重叠文件按已核对合并结果恢复，其他既有文件逐字保护核对无差异。证据目录：`/Users/Admin/.pi-autoreview/deployments/loop-kernel-step4-20261107-pbln8hew/`，见 `publication-verification.json`、`publication-output.log`、`plan.json`。

本批唯一任务文件：[第 5 步第二批提示词](prompt/提示词-Loop内核与节点编排-5第二批旧路径清理.md)。[第一批提示词](prompt/提示词-Loop内核与节点编排-5第一批流程修复.md)作为历史保留。权威需求仍为 [Loop内核与节点编排](../issues/【req】Loop内核与节点编排.md)；第一批六项必须修改、两项建议及未验条件原文保留，不由清理批追认通过。

## 第 5 步第二批：旧路径清理实施安排

### 基线与本机既有修改

工作目录 `/Users/Admin/.pi-autoreview/worktrees/loop-kernel-step5-cleanup`，分支 `refactor/loop-kernel-step5-cleanup`，提交基线 `e170e31`。为避免第一批发布时才合并本机修改，本次准备已把主目录当前相关的19份源码/测试/现用说明复制到独立工作区；每份与主目录逐字核对，清单及字节备份在 `/Users/Admin/.pi-autoreview/preparations/loop-kernel-step5-cleanup-20261107/inherited.json` 和 `local-baseline/`。这些是继承内容，不算本批新增成果；不要还原成 dev 旧版或覆盖主目录。

继承功能包括仅本地发布、经用户确认追加一个任务文件范围、原活 Pi 私有收件箱恢复、任务卡元数据同步、无关任务并行及现有 Git/候选保护；旧队列指定 release 的实现也留有来源。C6旧发布执行被移除时，旧 `--release` 路径只给明确迁移诊断，不另造新目标分支发布能力，不碰 main。其余相关保留功能不能随清理退化。

只复制本机原 `.autoreview.json`，保持既有 auto、deny、模型配置。主目录 `.gitignore`、历史文档删除/归档、旧批次、eval、本机辅助目录和旧 worktree 全部保留，不随本批复制、恢复或清理。主目录只允许协调方更新本方案与第二批提示词；产品修改只发生在第二批工作区。外层 Loop 始终加载主目录当前 `autoreview.ts`，不让开发中的清理代码评审自己。

### 本次清理清单与替代位置

本节把前期候选按已合入第一批及本机当前调用链复核，作为用户“开始第二批”的执行范围。按函数/字段/入口分支清理，不能按文件名整删。列出的旧执行能力必须真正移除，不能只藏在 `legacyCompatibility:true`、环境变量或默认关闭的分支后面；历史读取和准确迁移诊断允许保留。

| 项 | 删除或改变的旧逻辑 | 必须保留/承接的位置 |
|---|---|---|
| C1 旧 workflow、每段验收 | `config.ts` 的 StageWorkflow/parseStageWorkflow/workflowSteps/batchStageConfiguration；`review.ts/acceptanceStep` 与评审后验收分支；pipeline 的段级 workflow 解释 | 新卡固定 flow、kernel-session 节点推进、acceptance-node 批次统一验收。保留 parseAcceptanceConfig、标准、人工/授权和验收执行器。旧字段不能继续控制流程；不改写项目配置。 |
| C2 定向复验后追加 full | `acceptance.ts/runAcceptanceStage` 中定向成功后再调用 full 的包装，以及 review/pipeline 调用者 | runAcceptanceOnce/runAcceptanceAttempt、证据、来源、授权及资源收尾；首次和移出任务等需求明确要求的全量条目范围仍保留，不能误删成“永不完整验收”。 |
| C3 评审/验收共用次数与时限 | checkRoundBudget、评审 deadline 与验收 deadline 取最小值、验收失败使用 ReviewState.repairs 的路径 | 新卡各节点独立 limits/counters/deadline；单会话评审自身 maxRepairs/reviewTimeoutMin、preparation 独立恢复预算保留。 |
| C4 workspaces 与旧开工两步 | ProjectLayout.workspaces、旧目录名推导、loop.ts/cmdOpen 及仅为旧开工服务的 loadBatch/resolveStageMap 装配 | 新卡一次启动 createKernelRun/createWorkspace/launchKernel，localFiles、准备/方法/权限/来源检查照常。旧开工只给明确新入口说明，不建目录/分支；已有目录不迁移、不删除。 |
| C5 同仓库串行旧流水线和旧卡执行 | pipeline.ts 的旧 parsePlan 开发卡解析、dispatchBatches/runPipeline，loop.ts 的 legacyCompatibility 执行分流，旧后台重新派发路径 | 新卡任务并行、测试/验收本机槽、目标分支发布锁与批次贡献。旧 stages/workflow/steps 卡在创建资源前拒绝并提示迁移；pipeline-core 的通用原子读写/事件类型按真实调用者保留。 |
| C6 旧队列再次检查、免审及批次分支推送 | review.ts/queueReviewedResult、merge-queue.ts/runMergeQueue 的旧检查/返修/免审、commit-batch.ts 的旧提交推送路径 | node-ledger/validResult、统一合入资格和 submission-node；只推 dev 的新发布规则、真实例外决定、用户未提交内容及释放保护保留。第四步部署/回退/项目互斥不删除；旧记录只读展示，不伪造新账本。 |
| C7 独立 accept-cmd | autoreview.ts 的旧参数解析、acceptCommand/acceptMode、独立命令执行及完成门槛、`/accept`，core.ts 对应旧状态/总结分支 | 新卡 tasks[].test/test-node；旧参数/命令给明确迁移说明、不执行。`bin/loop 开发 pi|claude|codex` 继续只有开发评审，原会话返修/停止/恢复可用，不暗加测试或提交。 |
| C8 现用说明与模板 | CLI 帮助、README、工具清单、运行维护及项目模板中仍指导使用旧 workflow/workspaces/开工/accept-cmd 的内容 | 统一指向真实新入口、固定节点及字段。历史文档原样保留；稳定规则 AGENTS.md/CLAUDE.md 不改，不向接入项目复制新规则。 |

共享依赖不能误删：`workspace.ts` 的 gitResult/gitText/worktrees/worktreeForBranch 被新内核和部署直接使用；`pipeline-core.ts` 的原子 JSON/事件工具被 resources/materials/methods/project-context 等使用；`review.ts/autoreview.ts/hosts/review-hook.ts` 仍承载正常单会话。可以移除无调用的旧专有函数/类型，但不为删文件搬出一套通用框架。

`review-only.ts` 的独立 `loop 评审` 入口必须仍能评审已有提交并只出报告；拆除其 ReviewPlan/旧 parseRecipe 依赖时，复用现有只评审解析和执行接缝。PA 已有查询、消息、授权来源、请求去重与原会话身份语义保留；`pa-resume.ts` 中重开旧 pipeline 的部分改为旧卡迁移拒绝/适用新入口衔接，不能再偷偷启动已作废旧批次，也不顺带扩建 PA 协议。历史任务资源按既有归属提供安全停止/诊断，不能因读旧记录触发恢复或发布。

### 对应测试调整清单

不整文件删除现有测试，不修改或运行 `test/e2e.mjs`。以下过时行为断言按本次已授权行为替换；同一测试内的独有保护必须迁到新入口继续验证，不能只删到绿。需要删除表外测试文件或改变表外能力时，先保留并单列，不扩大本批。

| 现有测试位置 | 本批替换的旧期待 | 必须保留的反例/新覆盖 |
|---|---|---|
| test/workflow.test.ts；test/pipeline.test.ts 的 P1/P3/P5/P8 与旧启动/派发用例 | 接受旧卡、workflow 控制验收、同仓库强制串行、开工成功 | 旧卡无副作用拒绝、正确迁移提示；新卡原有并行/归属/原会话回流覆盖；非法路径/配置和启动失败保护。 |
| test/acceptance-recheck.test.ts 的“完成前完整验收/定向后full”场景；pipeline 同类场景 | 定向通过后再追加完整重验 | 精确复验、首次/移出任务合法完整范围；标准/授权变化、沿用证据来源、未验证/人工项不伪通过。 |
| test/config.test.ts 共用预算及 workflow/workspaces 场景 | 验收时限必须小于评审时限、依旧 workspaces 创建目录 | 节点独立限额、非法输入在资源前拒绝、旧字段不执行且不改用户配置；新卡 localFiles 与配置优先级。 |
| test/autoreview-delivery.test.ts 的必需/附加验收命令及 PA A3；相关 autoreview/hook/fixture 场景 | 独立 accept-cmd 运行及控制完成 | 旧参数迁移且不执行、新测试节点承接；释放证明、失败分类、单会话评审/返修/通知/真实用户输入。 |
| test/loop-documents.test.ts、test/preflight.test.ts 及 workflow 中混合的开工保护 | 旧开工执行/文档搬运流程 | 源文件、用户暂存/忽略文件、链接、localFiles、方法与准备的保护在新入口继续成立；不删除独有反例。 |
| test/*queue*.test.ts、test/recipes.test.ts、test/merge-queue-target.test.ts 的旧执行行为 | 旧队列再次检查/免审、批次分支推送、旧指定 release 发布 | 新提交节点只发布已检查候选，目标/用户内容/进程/停止/回退保护；只评审入口及纯报告不开发语义。旧目标参数只留迁移诊断测试。 |

`test/kernel*.test.ts`、第四步部署/只评审、第一批产物证明/窗口适配、单会话及继承的 scope/native-Pi 测试作为受影响保护基线。开发时在本节记录最终“原断言 → 新入口/新断言”，交付列明全部实际改动及原因，不再新增平行测试台账。

### 实施顺序与完成条件

先核对本次继承差异与调用者，移走保留入口对旧编排的依赖，再按 C1—C7 删除旧执行分支；按依赖分组执行最小充分验证，最后同步 C8。每组自检通过继续，不等用户逐步验收。旧实现无生产调用后才处理专有死代码；少量迁移诊断或历史读取不等于保留旧执行引擎。

完成须同时满足：新卡六节点/单多任务/原会话恢复不退化；旧卡、开工、旧独立验收命令不能再执行资源动作；没有提交节点暗查、定向后追加 full、共用产品次数/时限或新旧双调度；保留能力均有实际入口及受影响测试证据。仅把旧代码改名/藏入兼容开关，或只删README，不算完成。

测试使用已有 node:test/fixture、本地临时 Git/bare origin 及模型替身，按调用影响选文件/名字，不跑全仓、真实模型业务、浏览器/后端联调、真实部署/远端或额外自动验收；类型检查复用已安装工具。测试临时文件按实际归属释放，失败证据保留；不清理旧运行目录或按名字/PID猜测释放。现有真实用户入口和资源不受本批检查影响。

交付前分别列明继承内容、本批删除/迁移内容、定向程序结果、外层静态评审、实际装配及仍未验证的窗口/业务项。未经用户当次明确发布指令，不 add/commit/合入/push；不把“开始第二批”当发布授权。发布时由实现者对照本次 inherited.json 与主目录最新变化做有界差异保护，不能直接整目录覆盖；新增本机变化需明确列出，避免把准备基线之外的内容悄悄带入。

### 第二批准备与启动记录（2026-11-07）

准备目录：`/Users/Admin/.pi-autoreview/preparations/loop-kernel-step5-cleanup-20261107/`。已建立独立工作区、保存主目录改动及19份继承文件指纹，更新同一方案并生成本批唯一提示词。未修改主目录产品代码、未删除旧实现/测试/文档/工作目录、未提交或推送本批。

本次重新核对真实 Pi 包为 `@earendil-works/pi-coding-agent` 1.3.0，实际入口 `/Users/Admin/.local/bin/pi`。选择 read/edit/write/bash，加载当前权限扩展、主目录 autoreview 和 Ponytail full；保留原全局 yoloMode=true 和明确 deny，无新项目覆盖。`--offline` 仅关闭启动联网检查，仍正常连接开发及评审模型，不安装或恢复其他插件。

已完成的准备检查：当前 Pi 参数解析器接受本次启动参数；现有标准解析器完整提取9条标准；正式 `bin/loop 开发 pi` dry-run 指向正确工作区、三项扩展与新会话；启动脚本语法、文档/继承差异空白检查通过。真实权限扩展处理器模拟 read/edit/write/bash 均放行、0次询问，未执行探针工具或调用模型。证据为 `prompt-check.json`、`launch-dry-run.log`、`permission-handler-check.json`。未执行产品测试/构建、真实窗口、业务或外层评审。

**本批未启动，用户自行执行启动命令。** 会话 ID `2092b4cd-c3af-4f23-9d9c-41a711a71737`；脚本 `start-step5-cleanup.sh` 内已固定工作目录、清除其他批次身份、原生前台 Pi、唯一提示词及本次信任参数。实际启动后才能核对加载、模型执行和外层评审情况，准备检查不冒充开发完成或业务通过。

## 第二批实施与验证记录（2026-11-08 UTC）

本节是本工作区实际实施记录，不改写上方准备时“尚未启动”的历史。工作区 `/Users/Admin/.pi-autoreview/worktrees/loop-kernel-step5-cleanup`，分支 `refactor/loop-kernel-step5-cleanup`，HEAD 仍为 `e170e31787e4d96aedf1f9adbcdafa9ef16794c3`。仅修改本工作区授权文件；没有 add/commit/stash/reset/合入/push，没有覆盖主目录产品、其他仓库或旧 worktree。当前目录没有方案引用的 `issues/【req】Loop内核与节点编排.md`，未补建/关闭原单；按本方案及本批提示词 A1—A9 实施，不降低原标准。

### 继承差异与本批差异分列

启动时核对 inherited.json 的19份 SHA-256，全部匹配，未整仓重读 local-baseline。继承的仅本地合入、scope 单文件增补、原活 Pi 私有收件箱、未知/过期返修拒绝、卡元数据同步、无关任务并行和 Git/候选保护不是本批新成果。起点已有的未提交差异不还原、不丢弃、不擅自提交。最终逐文件指纹见 `/tmp/loop-step5-cleanup-checks-bunzxv/inheritance-final.json`。

| 继承文件 | 本批在继承基线上的处理 |
|---|---|
| acceptance-node.ts、batch-integration.ts、kernel-controls.ts、kernel-session.ts、kernel-workspace.ts、kernel.ts、submission-node.ts | 与继承清单仍逐字一致；保留统一验收、贡献/元数据、仅本地、范围及释放保护 |
| test/kernel-batch.test.ts、test/kernel-scope-control.test.ts、test/native-pi-owner.test.ts | 与继承清单仍逐字一致；作为正常/反例基线执行，没有把其原有功能计为本批成果 |
| kernel-cli.ts | 仅将文件头“旧引擎内部保留”改为已删除的准确说明；继承的本地模式/任务控制保留 |
| kernel-runtime.ts | 在原活 Pi/窗口/恢复实现之外接回方法自测；不改其既有模式、归属或收件箱语义 |
| node-ledger.ts | 增加已有 PA RelaySource 形状的任务来源记录，不改变原有发布/控制决定或次数 |
| loop.ts | 保留新卡、单会话外围、只评审、PA、问题单/经验/维护入口；删除旧开工/启动/合入装配及内部兼容分流；仍传递 --仅本地 |
| merge-queue.ts、test/merge-queue-target.test.ts | 按已授权 C6 停用继承的旧 --release 执行并改迁移拒绝；不迁成任意目标发布、不碰 main |
| test/kernel.test.ts | 只补可选断言说明的空字符串类型兜底，不改继承的业务断言 |
| README.md、工具清单.md | 同步 C8，但继续说明继承的本地发布、单文件增补、原活 Pi 和无关任务并行 |

### C1—C8 实际删除与承接

| 清单 | 实际删除/改变的符号和分支 | 仍在使用的承接调用链 |
|---|---|---|
| C1 | config 的 StageWorkflow/parseStageWorkflow/workflowSteps/stageAcceptance/batchStageConfiguration，review.acceptanceStep 及评审后 workflow/验收分支，旧段解释器 | development-card 固定 flow → kernel-session/acceptance-node；parseAcceptanceConfig、标准/授权和验收执行器保留。旧字段不解析流程或段预算、不改用户配置 |
| C2 | runAcceptanceStage 的“定向后 full”包装及调用者；无调用的旧验收目录/开工 reset 空跑助手 | acceptance-node → runAcceptanceOnce → 内部单轮 attempt；首次及移出任务后的完整范围由原内核计划决定。定向成功不多跑第二轮 |
| C3 | checkRoundBudget、static-review.reservedMs、评审/验收 deadline 取最小值、验收失败扣 ReviewState.repairs | 单会话只保留自己的评审预算/次数；新卡各节点 limits/counters/deadline 和 preparation 有限恢复独立，排队不计执行时限 |
| C4 | ProjectLayout.workspaces/workspacePath；loop.cmdOpen/loadBatch/旧 repo 装配、文档搬运/恢复/提交、仅旧开工的前检/空跑；preflight.ts；旧问题单开工预写/队列状态冲突消解/合入回写 | createKernelRun/createWorkspace/launchKernel；localFiles、来源/权限/准备保留。methods.selfCheck 脱离旧开工接回新卡启动前，按指纹缓存，受管执行/释放并守候选输入 |
| C5 | pipeline.parsePlan/dispatchBatches/runPipeline、旧 Pi/Stage/Plan 专有类型、串行/Terminal/后台派发；loop legacyCompatibility 分流；launch 的旧段锁/派发/覆盖分支和 terminalStageCommand | 新卡六节点/并行任务/本机槽/发布锁。pipeline.ts、launch.ts 直接旧脚本只短拒绝；launch 共用启动组只供 review-only，内部旧段参数也在锁/目录/模型前拒绝 |
| C6 | queueReviewedResult/queueCommittedResult、旧队列完成入队/再次检查/免审/返修/自动恢复/重定目标；runMergeQueue、mergeQueuedBatch、retargetQueueBatch、commitBatch/pushBatch、workspace.commitAll 等专有写操作 | submission-node 只发布当前 validResult/候选/输入/贡献及真实决定，不暗查；只 dev/仅本地/失败不重推。merge-queue 仅旧 JSON/归属及显式安全停止，直接 worker 脚本拒绝；不将历史 blocked/testing/e2e 改成可执行 pending/新通过 |
| C7 | acceptCommand/acceptMode/acceptTimeoutMs、run/start/finish/interruptAcceptRun、独立命令执行/恢复/完成门槛；core.AcceptRunRecord/旧命令总结；Pi/Hook 的旧机器收件箱派发和队列免审 | bin/loop 开发三宿主仍仅静态评审；/accept 与旧参数仅诊断，含新卡直接扩展入口；bin 参数空格/等号两形式在权限检查/模型前拒绝。真实用户输入/撤权、单会话返修/通知/来源/停止/续接保留 |
| C8 | 现用帮助、README、工具清单、运行维护、项目模板 JSON/配置/说明不再指导旧执行 | 新卡、单会话及纯报告入口一致；模板既有“批次.json”文件名保留但内容改 version:1。不改模板稳定规则。README-验收标准原文保留，运行时指路明确仅取写法，旧执行要求由新卡/独立 limits 替代 |

没有把旧实现搬进 legacy、新模块或关闭开关。没有引入通用流程引擎/产物 DSL/PA 新协议。原 gate 不执行、类型不校验、不自动删除；配置解析静默，仅新卡实际启动提醒一次。auto 和明确 deny 保留，不把自动执行当发布授权。

保留模块及真实消费者：workspace 的 Git/worktree 归属供 kernel/workspace/submission/deployment；pipeline-core 原子 JSON 供 resources/materials/methods/project-context/宿主/PA/停止；review/autoreview/hosts 保留单会话；review-only 独立解析仅报告配方，loop 直接评审与只评审卡均可用；部署/回退、测试产物/真实输入保护仍走原内核。IssueWriteback 只读历史类型及 regularFile/stateField/writeIssue 供旧记录/issue-archive；归档 CLI 和两类工具完成事件仍用同一归档器，不自动关单。

**表外数据能力单列保留，不假称新的生产执行入口：** batch-refs 的纯历史路径重定位与 parseIssuePaths 仍由 batch-refs/issue-contract 测试消费；pa-records 的旧 grant 绑定/合并数据助手仍有 pa-grants 反例（可能写绑定数据，但不投递、不启动、不会成为新内核授权），生产查询只用 readPAGrants/wordRecords；ledger 的历史批次格式化/追加助手仍有 ledger 测试，不参与 validResult/发布资格。未擅删这些表外能力或测试，未把它们接回执行。StageStatus/QueueBatch/QueueEntry/BatchCommit 的旧字段仅历史展示/归属停止，消费者为 query/stop/PA/宿主观测；不据旧记录生成新账本通过项。

### 拆依赖时发现并修正的保护缺口

- 方法自测原先只在旧开工：接回新卡开发启动前，仍用 methods 指纹/paths/selfCheck/probe；失败不启动模型，不把它变成业务测试。改为受管消费者/资源和项目检查租约，方法改变候选/输入时停下。纯报告不执行项目方法。
- 权限缓存反例揭示：方法未变时，旧批准缓存会跳过后来 trust/no-approve/deny 的变化。缓存现绑定实际信任决定、全局/项目权限原字节、扩展和 Pi 入口；不修改用户权限、不新增授权渠道。先前批准后明确 no-approve/deny 的反例均拒绝。
- 直接只评审继续存在，但不能用 finally 抹去未知消费者/脏检出：单轮结构化记录 consumersReleased；报告模式缺/否定回执立即停止重试、保留阻塞租约，损坏登记/目录或 HEAD 身份变化、未保存及 ignored 输出保留 retainedWorktree。两处纯内存测试明确声明未启动消费者；真实执行器回执不补造。新增6类反例和原正常/超时/中断报告均覆盖。
- PA 仅使用既有 id/header/原文哈希/用户来源协议：新卡续跑走已有内核 worker，JSON 收据形状稳定去重；旧卡确定性拒绝，连拒绝收据/锁目录也不建，旧成功缓存不重启。新卡原话按既有任务 UUID 存储，合法名称文件化碰撞不串消息/误去重；原会话/进程/正文核对后才消费。开发环境含新卡身份不能伪装 PA 用户送话。编号续跑仍整批，不静默忽略 --task（单任务用原统一续跑、不附 --id），不扩协议；旧 grant-file 不读取/代填新授权，历史授权只读对账。

### 断言变化 → 替代覆盖及原因

没有整文件删除 node:test，没有修改/删除/运行 test/e2e.mjs；旧成功期待不再代表当前产品行为，以下是实际替换范围，独有保护保留于原文件或已有内核反例，不以“只要不崩”代替断言。

| 测试位置 | 原断言 → 当前断言/承接 |
|---|---|
| workflow；pipeline 的 P1/P2/P3/P5/P8；pipeline-startup；acceptance-rename | 旧 workflow/steps/串行/平铺或 e2e 卡可执行 → 公共 CLI、直接脚本、legacyCompatibility:true 及内部段启动均在资源前迁移拒绝；新卡非法路径/标准/限额仍资源前拒绝。新并行屏障、回流/归属/精确验收保留在 kernel-batch 原断言 |
| acceptance-recheck | 定向后 full/为 full 预留预算 → 一次精确复验、原树/轮次/证据沿用；首次/显式完整范围、同文改版/改内容/真实授权变化、缺历史身份仍完整；无法验证暂停、人工/拒绝授权不伪通过；报告不写“尚非最终完整” |
| acceptance-checkpoint/correction/tools/resources/system/recovery | 仅将导入接到 runAcceptanceOnce（局部别名便于原反例不动），原有证据、工具/授权、断线、进程/端口/释放断言不删；acceptance.test 只替换共用预算期待 |
| config、review、config-launch | 验收必须小于评审/预留后预算/旧段覆盖 → 独立限额、静态首次/一次重试只用自己的剩余时限；正常 Pi flag > env > 文件和精确 session 实际贯穿权限/来源；旧段参数/窗口分流拒绝；非法有效配置仍报错、不改原文 |
| autoreview-accept-command/acceptance；hook-acceptance/policy | 自动/手动 required/advisory 命令或每段验收控制完成 → 全部旧参数/命令仅迁移、零执行/命令资源；单会话标准仅静态核对、没验证不通过。准备/脏基线/机器来源/规则副本原文和即时静态返修交接保留，新测试节点产品/环境/恢复/释放反例由 kernel-test-node 承接 |
| autoreview-delivery；hook-delivery | 未执行命令的 TMPDIR/必需验收完成/部分验证总表 → 无旧资源动作、只追加真实静态报告、测试/验收没验证；瘦身保留证据/脚本/小文件、不可写只提示、Ponytail、问题/通知/故障原文/PA 查询与上限继续断言；会话 done 不冒充批次提交/发布 |
| autoreview-input/sources；hook-input/session | 旧命令输出或正在验收的授权取消 → 真实静态必修/在途静态调用的机器消息隔离和授权取消；文件内授权不算、撤权先落盘、标准改版入新静态全文；CRLF/过滤/原始字节/模式/子目录/来源缺失/恢复取证窗口与巡检等独有反例保留。旧 mode/命令结果不控制完成，真实候选/输入变化仍失效 |
| autoreview-queue；hook-queue | done 入队/机器收件箱/队列同树免审 → 单会话仍报告状态但不提交/入队，旧消息不发返修或改标准/授权/计数；正常静态评审与新增提交记录保留，新内核信封/宿主真实原生收件由 kernel-test-node/batch 原场景承接 |
| loop、loop-launch、loop-documents、preflight、loop-merge | 旧开工搬文档/切分支/提交、旧合入 stash → 迁移拒绝仍逐字保护用户暂存/未暂存/忽略同名/源文档/链接/父路径/已有 MERGE_HEAD/stash；新卡冻结已提交资料，不搬原区未提交内容；localFiles 越界/链接、方法指纹/失败/权限仍实际验证 |
| batch-queue-state/completion/acceptance/repair/gate/stash/publish-locks | 旧 FIFO 重压/重验/免审/冲突退最后一段/恢复发布 → 历史原文/顺序/欠项/次数只读，旧启动/合入/恢复拒绝，锁未知/活 owner 有界拒绝。跨仓库 FIFO、责任回流、资格撤销、完整贡献与发布锁由 local-node-queue/kernel-batch/kernel 原反例承接 |
| merge-queue、target、commit、publication、recovery、withdraw、inbox；commit-batch | 旧重检/压缩/批次推送/任意 release/撤回/恢复 → 旧 API 不存在、脚本非零迁移、原事务/stash/收件箱/控制字节只读不重启；新提交只发已检查候选、只 dev/仅本地、不暗查、不推任务分支、不重推、目标前进/脏用户区/检查后新增/链接及本机文件保护有正反断言 |
| batch-delivery/timeout/deployment/deployment-wait；batch-queue-native-claude/codex | 旧队列推批次/部署调度/原生返修 → 新统一发布/本地事实/拒推不重试；历史待办只能取消、在途副作用未知保留；实际项目检查/部署双向互斥、cmd/check/回退、停止/配置/目标保护及原生草稿/精确会话由第四步和 kernel-test-node 原场景保留 |
| recipes、stop-safety、pa-pipeline/relay | 原 parsePlan/后台旧 pipeline/旧整批 grant 复活 → 独立只评审解析及正常/失败/中断/纯报告保留；旧 PA 明确零资源拒绝，重复编号不读/重发、直接写历史授权仍可查；新内核 PA worker、正确任务/原会话、错误归属/伪头/开发环境、任务名碰撞不串账有反例。跨项目同名/复制品、共享组/错误启动时间/无身份、旧发布未知事务不假称停止 |
| loop-issues、issue-contract | 旧开工/队列问题单状态自动回写 → 不走旧执行；原规范正文/CRLF/单头与正文区分、并发原文 CAS、只读/缺失/链接/硬链接/父路径保护及同一归档器保留；issue-archive 的真实工具适配反例未删 |
| core、events、tool-manifest、template、production-loop、cli-worker | 旧命令总结/旧段原因数量阈值/parsePlan 文档抽取/开工模板 → 不渲染旧命令资格；每个实际保留来源提取非空、共享停点与所有原因分类仍逐项检查，不用删除旧引擎后的条数制造失败；新卡/任务白名单及配置 helper 双向字段对照并保留“增/删源码字段必须失败”反例；真实模板占位符在模型前失败；官方 Hook 的只读/范围/重定向/heredoc/路径/去重保护保留 |
| fixture、继承测试类型补强 | 旧模拟调度器改为临时 Git/bare origin 的前后字节/索引/ref/资源快照，不搬死引擎；kernel fixture 可保存本次 owner/启动时间及证据。可选错误说明补空串、空参数补 {}、env 明确 ProcessEnv 仅类型/诊断文本，不改比较条件。3份起点未跟踪测试不作为新增成果 |

### 实际命令、失败与闭环

证据根 **`/tmp/loop-step5-cleanup-checks-bunzxv/`**。`check-commands.json` 从本原会话实际工具调用逐字提取原始命令及 timeout；`test-log-results.json` 只汇总真实 TAP，不把内部循环膨胀成 node:test 数量。以下 `node --test` 均使用 `env -u AUTOREVIEW_SINGLE_NODE -u AUTOREVIEW_KERNEL_LEDGER -u AUTOREVIEW_KERNEL_RUN -u AUTOREVIEW_KERNEL_TASK NODE_NO_WARNINGS=1`；需要的资源/通知/HOME/队列/模型/宿主和 Git origin 全在各自临时夹具。额外证据变量/完整参数以原始命令为准。不是固定全仓测试集合，没有依赖安装、真实业务模型/浏览器/后端数据库/远端或额外验收；本机短服务/工具仅为已有 fixture。

| 实际检查主体/范围 | 日志与结果（原失败不删除） |
|---|---|
| config/review/autoreview 第一组 | config-review-single-1：88/89；唯一失败仍期待清除旧启动令牌，改为旧令牌无执行/回报能力；round-isolation-2 该项已过 |
| acceptance-recheck/config/autoreview | round-isolation-2：69/71；授权反例未设置授权项，变化无实际授权效果。修为真实授权变化后，final-precise-increments 中该父/3子均过；不是降低验收断言 |
| kernel-batch/kernel/kernel-controls/step4 定向基线 | kernel-boundary-1：4/4 |
| pipeline/workflow/preflight/documents/launch/queue/commit/publication/PA 初组 | entry-publication-1：23/24；测试误把提交节点的失败 NodeOutput 当 throw，改断言状态/原因及目标不动；methods-pa-issues-1 两项 publication 反例通过 |
| 单会话/Hook/交付/历史停止/只评审 | retained-adapters-1：52/52 |
| 方法自测、PA relay/grants、问题单实际归档及发布保护 | methods-pa-issues-1：33/33 |
| 现用清单/模板/标准写法保护 | docs-template-1：12/15，清单表提取误限反引号、模板缺停用词；修为完整双向表提取及准确说明。manifest-config-launch-2：8/8；模板/保护原通过项不重复扩大 |
| 生产 Hook 指路/解析/缺文件/heredoc/项目状态及 README/帮助 | production-guidance-1：8/9；ENOENT 只带缺失父目录，补明原引用完整路径；production-missing-path-2：1/1；末次 cli-and-guidance-final 相关指路再过 |
| 23份旧队列/开工/交付/历史及新对应保护文件 | migration-history-groups-1：30/31，权限缓存确实复用了过期批准；实际修复后 permission-cache-fixed：1/1，含批准后 no-approve/deny 反例 |
| core/acceptance 及 checkpoint/correction/tools/resources/system/recovery | acceptance-executor-core-1：91/91，单轮导入后的原反例保留 |
| 用户输入/来源/普通会话/两宿主/通知事件 | retained-inputs-sources-1：101/110；9计数为旧约定/共用预算/旧引擎原因条数期待。同步当前约定/独立预算及实际原因完整性后 retained-contract-fixed：9/9；未删独有原文/路径/故障/释放反例 |
| kernel-batch/kernel-test-node/kernel-controls/step4/scope/native 原集成命令 | kernel-integrated-1 被工具450秒上限中断，无失败 TAP；已输出前29个批次顶层场景通过。未宣称该整命令通过，也未重跑已完成29项；kernel-batch-remainder-1 只跑剩余 CAS 恢复/双宿主 Hook：4/4（2顶层+2子例） |
| kernel/kernel-controls/kernel-scope-control/native-pi-owner | kernel-base-controls-1：61/61，含继承本地模式/未知身份/范围控制 |
| kernel-test-node | kernel-test-node-1：12/12 |
| kernel-step4/kernel-step4-review2 | kernel-step4-retained-1：48/48，含纯报告、部署/回退、互斥、停止和真实/缺失回执；预期拒推日志仍保留 |
| kernel-step5-flow 受影响适配、状态、窗口替身、构建/缓存、真实输入与释放恢复 | kernel-step5-retained-1：13/13；不是实际窗口/业务通过 |
| local-node-queue 原跨仓库 FIFO/停止/改卡/未知登记 | local-slot-regression-1：4/4 |
| 直接只评审资源补强 | direct-review-release-final：11/17；新增清理守卫把带换行 HEAD 与 trim 后对象比较，错误保留6个正常/超时检出。补 trim 后 direct-review-release-fixed：13/13（原失败6项+新增6子及父），正常和真实超时/信号均收尾，缺回执/脏/ignored/损坏登记/同树不同 HEAD 均保留；没有只删反例到绿 |
| 末次精确复验/预算/纯报告渲染/旧直接脚本 | final-precise-increments：16/16 |
| PA 迁移/新 worker/旧源环境边界 | pa-migration-final：9/11；2项是首回内存 undefined 与持久 JSON 形状不同、拒绝 helper 未取 reason.text；规范同一收据形状/结构化原因后 pa-worker-receipt-fixed：2/2 |
| 新卡直接扩展旧参数、实际只评审启动、内部旧段拒绝、正常取消/缺回执 | last-entry-and-receipts：8/8 |
| 旧队列 worker 脚本、内部旧段、只评审正例及迁移指路 | cli-and-guidance-final：5/5 |
| PA 整批续跑不吞 --task、任务 UUID/名称碰撞、原会话消息、旧缓存/归属 | pa-task-identity-final：4/4；实际内核 worker 仅一次评审，未启动开发宿主/发布 |

交付说明增量后，仅复核 `node --test test/tool-manifest.test.ts test/single-entry-docs.test.ts`：`document-delivery-final.log` **9/9**；末次空白/稳定原文核对通过，没有重复扩大运行验证。

类型工具仅复用已安装 TypeScript/Node/Pi 类型。旧 ES2023 临时脚本不认识既有 Promise.withResolvers，换为匹配 Node22 的 ESNext 临时检查参数，不加包；后续显式检查完整依赖。集成首次22条为测试可选断言说明/空 helper 参数，及一次旧 launch 测试类型尚未同步，均做类型/说明兜底不改变比较值。**`types-final.jsonl`：114入口及其依赖，0诊断。** 原始 types-*.jsonl 均保留。

pi-lens 实际 touchFile/collectDiagnostics，禁自动安装、finally shutdown：lens-final（28文件182诊断）、lens-increments-final（17文件180）、lens-last-final（19文件164）及最后 PA/身份4文件增量有真实输出，不是空缓存。推断工程仍有缺 Node/Pi 类型等基线诊断，**不把退出0当零诊断通过**；显式既有类型依赖的 strict 结果另列如上。未为清空基线增加依赖。

其余集成核对：`git diff --check`；`bash -n bin/loop bin/pi-dev bin/loop-dev`；两份受改 mjs fixture 的 `node --check`；78份产品/hosts TS 的 AST 声明/调用扫描，已退役符号声明/调用为0，保留模块导入消费者见 `static-call-audit.json`。`protected-boundaries.json` 核对6份稳定/原标准/e2e原文 SHA 与 HEAD 相同、其他历史 docs/temp 无差异、暂存为空；不将静态核对当程序运行证明。

### 资源、保留场景和未验证项

`final-resources.json` 按本次保存的身份/账本核对：245份夹具快照根已不存在；158条测试检出及专用父目录不存在；234条运行资源目录不存在；36条登记启动组无存活/未知归属，测试标记无存活进程。负面“释放未知/失败”历史不改成通过。工具超时遗留的一个本次夹具以其他本次证据中的相同 owner PID/启动时间、run/task/attempt、Git common/本地 origin/全部 worktree 归属核对，原消费者/两资源及检出均已释放，先完整留证再收尾：`timeout-fixture-candidates.json`、`timeout-fixture-snapshot/`、`timeout-fixture-release.json/.log`；没有发送任何信号或按名字/年龄杀进程。

直接只评审清理守卫调试失败留下6份检出候选，源夹具登记已随旧夹具释放，**原样保留为失败场景，不按名称/年龄认领删除**：系统临时目录 `loop-review-3ANSrV`、`loop-review-3LT1Za`、`loop-review-3rXqx2`、`loop-review-b5DWIh`、`loop-review-cjXov3`、`loop-review-pA2zAm`。完整绝对路径/Git引用在 final-resources.json；当前与其原夹具环境匹配的进程0、各目录 lsof 开放引用0。它们不作为业务通过/可接力证据，后续不凭消失的登记猜测清理。修复后的正常/中断检出及新反例的本次明确归属测试产物已确认收尾；测试的纯内存反例只在确知没有启动消费者时释放自己的副本，不给生产路径补回执。证据根与本开发工作区有意保留，旧任务/目录未清理。

分层结论：**源码 C1—C8 实施及受影响程序覆盖完成；外层独立静态评审等待本次交付触发，有必须修改继续原会话返修。** 本工作区清理代码不负责外层评审自己，第一批/前四步旧通过记录不追认为本批通过。

**未验证且不偷偷补跑：** 真实 Terminal/Pi/Claude/Codex 窗口及人工体验，正式插件安装/信任和外部 worker 的真实装配，真实模型业务、浏览器/后端数据库联调、真实远端/部署与业务/人工验收。程序替身不代表这些已通过；第一批真实体验仍按原未验事项保留。没有发布可接力卡、没有把环境恢复当业务返修、没有自动关需求/问题单。后续若用户明确授权发布，仍须统一 `bin/loop 合入`，先对照 inherited.json 核对主目录后来新增修改，不能覆盖。

### 第二批外层评审与本次发布授权（2026-11-08）

外层第 1 次调用耗尽预算，保留原失败；第 2 轮于 `2026-11-08 05:13:19` 开始，71 秒返回“通过”，0 条必须修改、0 次返修。证据：`/Users/Admin/.pi-autoreview/loop-kernel-step5-cleanup/2092b4cd-c3af-4f23-9d9c-41a711a71737.md` 及第 2 轮完整源码快照。此结论是外层静态评审，不是业务验收或发布卡的新账本通过。

两条建议单列延期，不改产品源码、不阻断本次发布：一是 PA 续跑包装的“请求受理”和底层 `ok:false` 启动结果分开显示；二是新卡查询任务视图补充已有 paRelays 的只读来源导航。底层失败和来源证据均保留，运行行为按原报告记未验证。

用户本次真实原话“部署，合入，提交分支到仓库”，消息 `89982ac6`（`2026-11-08T10:25:17.226Z`），明确授权本批源分支提交/推送、统一合入 dev 与本机入口更新；不解释为修改 main、强推、覆盖无关改动或接受缺失检查。

发布证据根：`/Users/Admin/.pi-autoreview/deployments/loop-kernel-step5-cleanup-20261108-Sq92vsz6/`。已核对主目录19份继承文件与 inherited.json 逐字相同，无后来新增的继承源码变化；主方案与本批准备版本相同，本批提示词与源文件相同。主目录21个重叠文件均为已继承/本任务准备内容，将在完整字节/模式备份及输入核对后受控消纳到新版本；其余主目录既有改动、历史删除/归档、配置、辅助目录不纳入提交，逐字保护，不 stash/reset 或整目录覆盖。

源分支提交包含本批清理和必须保留的继承源码/测试，继承功能仍不计作新增成果；先保全并推送 `refactor/loop-kernel-step5-cleanup`。发布使用隔离候选及现有稳定内核，正常完成发布卡自身静态节点，既有外层报告不直接写成 validResult；不启动另一个开发会话，不补跑业务/窗口/e2e、不生成例外授权。有效检查齐备后仅通过 `bin/loop 合入` 合入 dev/推 origin/dev。Loop 本机部署是更新主目录的 CLI/Pi/Hook 入口并核对装配，不是替用户部署业务服务或补记真实窗口通过。

实际源提交、发布提交、远端确认、主目录保护、入口核验和消费者释放，均以该证据根 `plan.json` / `final-verification.json` 及发布卡查询为准；结果尚未生成或未确认时不称已发布，不发布可接力状态。上方“本批未提交/待外层评审”的段落保留开发交付当时事实；真实窗口/业务/人工验收仍未验证，不以本次发布追认通过。

## 第 5 步第一批：流程修复实施安排

### 基线、执行方与授权

- 工作目录：`/Users/Admin/.pi-autoreview/worktrees/loop-kernel-step5-flow`；分支：`refactor/loop-kernel-step5-flow`；基线：已发布 dev `623bd10`。不从第四步源分支或旧 dev 开发。
- 开发仍用 Pi＋Loop 单会话，由主目录已发布的 `autoreview.ts` 做外层静态评审，返修回原开发会话；开发中的新卡不能负责评审自己。第二批只读梳理与第一批开发可并行，不运行第二个产品修改任务。
- 已授权本批开发、受影响定向检查、必要类型检查和第一批可见开发会话启动。主目录产品文件、第四步工作区、其他项目、历史文档和旧工作目录保持只读；只在本工作区修改本批内容。仅复制原 `.autoreview.json`，保留 gate、已有 auto、deny 和全局配置。
- 本批交付前不自行 add/commit/合入/push，不改 main；本次第四步发布授权不延伸为第五步预先发布授权。第一批不删旧路径/测试，不运行 `test/e2e.mjs` 或全仓测试，不新增自动验收批次，不跑真实业务模型或外部业务联调。

### 既有补丁完整去向

主目录全部修改继续保留。`preparations/loop-kernel-step5-flow-20261107/before.json` 保存本轮准备前已修改文件指纹，`local-reference.patch` 保存相关源码和测试的参考差异；该差异混有本批外内容，不能整包应用。下表是处理安排，不是已迁入或已验证声明。

| 既有改动 | 第一批处理 |
|---|---|
| `kernel-cli.ts/kernel-runtime.ts` 显式 terminal 开窗 | 按差异复用，改成 Pi 开发任务默认可见；保留明确 background 和正确单任务/多任务恢复。当前开窗实现依赖 macOS Terminal/osascript，其他平台明确能力边界，不静默降为后台。 |
| `git.ts/static-review.ts` 只读 Git 无可选索引锁 | 复用并保留第四步执行/释放边界，不能整文件覆盖第四步代码。 |
| `kernel-controls.ts/node-ledger.ts` 仅删除 gate 的配置核销 | 核对其调用者和已登记历史；本批不通过删用户配置解决刷屏。确属流程所需的兼容增量才迁入，不降低其他输入变化保护。 |
| `kernel-controls.ts` 只改测试命令不打断其他开发任务 | 在受控改卡及持续进度的相关路径核对复用，保留执行中节点和真实输入变更的保护。 |
| `kernel-session.ts` 续跑提示重新发送条件 | 纳入交付/续跑接续，保留候选、输入、会话、代次及信封去重。 |
| `batch-integration.ts` 受控卡元数据同步 | 纳入批次汇入/接续的兼容核对；不可覆盖未知卡版本，不混入范围外任务贡献。 |
| `loop.ts/kernel-cli.ts/kernel-session.ts/submission-node.ts/node-ledger.ts` 的仅本地合入 | 主目录原样保留，本批不顺带迁入新能力、不删除；与窗口/续跑补丁混在同一文件的改动按函数/差异拆开。 |
| `loop.ts/merge-queue.ts` 旧队列 `--release` 改目标 | 主目录原样保留，不作为第五步新增功能，不在第一批删除；第二批清理旧调用链时列出具体影响，再由用户确认。 |
| 文档删除/归档、其他文档及本机辅助资料 | 不带入第一批。10 个删除标记中6份在 `docs/【已完成】/` 有字节相同副本，是迁移；另外4项尚未找到相同副本，保留现场，不还原/删除/提交。`.gitignore`、本机 `.autoreview/`、`.claude/`、eval 和旧批次材料不夹带。 |

上述6份迁移为：全流程优化方案、交付总表、流水线与项目模板标准、运行不停、放手交付需求、返修收敛验收用例。另4项是旧单一入口批次卡、两份单一入口提示词及 `iusses/启动要求只写在维护文档导致协调方漏加载Ponytail.md`。这里只核实文件去向，不宣称这些历史操作已获本轮授权。

### 最小实现顺序

1. 核对新卡启动、Pi/Hook 交付、统一账本、节点执行与返回的调用链；先复用窗口/Git/续跑补丁，完成默认可见启动、gate 去重和新卡自动接续的共同判断。保留旧单会话完成判断，普通讨论、用户停止和真实补充要求不能误推进。
2. 让持续状态直接读取同一内核账本，并覆盖外部 worker 推进、排队、返修、暂停及完成；不另造状态系统。与中断原因和下一步提示一起处理，不能窗口仍开着就显示运行中。
3. 修复检查保护与受控产物兼容，同时改监听和前后比对。优先复用第四步已有 `workspaceGuard(..., includeIgnored)` 接缝，但不能只传 false，也不能仅凭 Git 忽略规则放行全部写入。明确识别受控构建/缓存产物，跟踪文件、索引、非忽略新增文件、标准/授权/配置/已登记输入始终保护；无法可靠区分时保留保护，采用真正接入执行、证据及释放的最小隔离方案。常规实现取舍由开发方依据代码与反例完成，不交用户选算法。
4. 按单任务和多任务覆盖自动衔接、原会话返修、中断/续跑、有效结果复用；同时覆盖 Node 构建、已忽略 Python 缓存正常完成，以及源码/索引/输入变化仍中断。两项建议同批完成，保持建议分级。

### 验证职责与交付条件

开发方复用受影响的 `node:test`、现有 fixture 和类型工具；每批最小充分验证通过即继续，最终检查各批集成结果。重点使用 kernel、test-node、controls、batch、config 和真实 Pi/Hook 适配边界已有测试；按影响选择，不把清单变全量。报告实际执行命令、原始失败与修复后结果、改动的断言及原因；没有新问题不反复重跑。

协调方负责第一批开发窗口和后续客观的单/多任务窗口检查，提供实际操作入口；开发方负责准备可直接使用的隔离示例、启动/恢复命令、日志与归属清理。真实模型测试任务、外部业务及发布仍按当次授权；不能用替身、进程存在或空 `notify/setStatus` 断言冒充窗口体验。用户只需判断最终体验；需要用户参与时在聊天逐步给完整命令、预期结果和预计时长，不让用户找文件夹。

本批没有额外自动验收或 e2e 流程。源码、自检、外层静态评审、实际窗口、业务验收分别报告；缺实际窗口证据就保留未验证和未完成项，不把开发启动当第五步完成。第一批完成并可用后再复核第二批清单。

### 第一批准备与启动记录（2026-11-07）

已建立上述第五步独立工作区/分支，仅复制原 `.autoreview.json` 与本批方案/提示词；产品补丁未预先应用。唯一开发会话 ID：`9a11998b-2b4f-443d-86fb-35e1b26ee9f2`。准备记录：`/Users/Admin/.pi-autoreview/preparations/loop-kernel-step5-flow-20261107/`。

本次重新核对 Pi 真实包为 `@earendil-works/pi-coding-agent` 1.3.0；程序路径仍位于名字为1.2.0的目录，版本以包内容为准。选择 read/edit/write/bash 足以完成源码、文件与定向检查，加载权限扩展、主目录 autoreview 和 Ponytail full。只关闭无关扩展/技能/模板/主题发现，不卸载插件；`--offline` 只关闭启动联网检查，正常模型连接保留。

`prompt-check.json` 记录当前安装解析器接受全部参数、10条标准完整提取，9条客观项与1条人工项；`launch-dry-run.log` 核对正式 Loop 命令、显式扩展和新会话；`permission-handler-check.json` 记录真实权限处理器模拟四工具，全部放行且0次询问，未执行探针工具/模型。全局 yoloMode=true，无新增项目覆盖或权限改写。启动脚本语法及文档 diff 检查通过；未重复执行第四步或第五步产品测试。

**当前未启动 Pi。** 自动开窗尝试被电脑控制工具明确拒绝：`Computer Use is not allowed to use the app 'com.apple.Terminal' for safety reasons.` 不换技术绕过该限制，不伪称窗口已打开。可直接执行 `/bin/bash /Users/Admin/.pi-autoreview/preparations/loop-kernel-step5-flow-20261107/start-step5-flow.sh` 启动前台原生 Pi；实际会话、扩展运行与开发成果须启动后核对。用户无需寻找文件夹或另装依赖。第一批产品、真实窗口及业务效果均尚未验证。

## 第 5 步第一批实施与验证记录（2026-11-07）

工作区 `/Users/Admin/.pi-autoreview/worktrees/loop-kernel-step5-flow`；分支 `refactor/loop-kernel-step5-flow`；HEAD 仍为 `623bd10435904e908a30b9c7896e422d82494ac5`。本节记录准备之后的开发结果，不改写上文准备时未启动窗口的历史。没有 add/commit/stash/reset/合入/push 本工作区；测试 Git 操作全部在本次系统临时夹具及本地 bare origin。主目录产品文件、全局配置、原需求、稳定规则、历史证据、用户 temp/ 均未修改。

### 六项必须修改与两项建议

| 分级 / 项目 | 实际实现及程序依据 | 尚待核对 |
|---|---|---|
| 必修 1：默认可见 Pi | `kernel-cli.ts/kernel-runtime.ts` 正常 Pi 开发启动/续跑按需要逐任务请求独立 Terminal 窗口；默认不加 print，JSON 不暗选后台。私有短脚本、一次性请求、原会话身份先登记；活动/待确认/未知身份不重复派工，部分失败逐任务给原因/命令，不转后台。显式 background 保留，目录/会话/次数不换；只评审不开开发会话。落实 macOS，其他平台可查询并明确提示显式后台。 | A1 真实 Terminal 打开、输入、前后台体验未验证。 |
| 必修 2：gate 去重 | 两个配置解析入口不再打印提示；仅新卡实际启动登记后提醒一次，重复解析/查询/轮询/续跑静默。任意 gate 仍忽略、不执行、不校验，不删改用户配置。 | 真实窗口长时间运行体验待观察。 |
| 必修 3：持续状态 | `kernel-pi.ts` 从 session_start 起按账本内容变化刷新同一 queryKernel 的状态栏/小部件；评审开始、外部 worker、排队、轮次/返修、暂停原因、完成及释放未知同步。本任务与整批分列，不以空闲/窗口存活冒充执行，不把一个任务停下说成全批暂停。关闭清理轮询/状态，重载停止的原会话仍只读显示、不解停，通知按变化去重。 | 已记录并断言实际 setStatus/notify/setWidget 调用；不是对真实 TUI 的人工验收，A3/A10 未验证。 |
| 必修 4：交付/返修/恢复 | `kernel-session.ts` 的 managedMarker/managedDeliveryIntent 为 Pi/Hook 共用接缝；仅首/末独立行标记，程序提交冻结交付候选、输入和用户版本。干净程序候选、无新增改动但欠检查、可信原会话返修可接续；讨论、新要求、决定、停止不借旧候选推进。更新过期续跑信封，保留原文/次数并复用有效检查；不能推进时提示原因和下一步。旧 `autoreview.ts/core.ts` 完成/跳过语义零改动。 | 三宿主真实模型回复/装配未验证；实际适配程序场景已覆盖。 |
| 必修 5：产物保护 | 原地无法可靠归属，采用最小候选隔离检出 `test-workspace.ts`：卡上原命令、既有依赖/本机文件副本，无新安装体系。原目录全量 ignored/文件/索引监听和前后守卫保留，检查输入另核对 inode/ctime。隔离完整带入 Git 树、本机及既有 ignored 文件，原有输入不从快照/指纹省略；默认保护为输入，仅实际 Node I/O 证明完整替换且未消费旧内容时确认重建产物，源码/登记输入/依赖永不提升；记录新生成/重建产物与具体目录事件证据；记录路径/规则/哈希/事件，不回写候选。CPython 以本次 PYTHONPYCACHEPREFIX 在登记资源的全新目录重建缓存，既有/失效 .pyc 不回写，路径/哈希/释放记 test.json.runtimeCache。消费者释放确认才删检出/缓存，未知保留，releaseUnproven 防止死亡所有者/空登记核销。复用 GIT_OPTIONAL_LOCKS=0，保留第四步项目互斥及真实释放回执。 | Node 构建/Python 缓存原命令正例已执行；真实业务依赖装配未验证。登记输入/依赖仍受保护，不按忽略规则授权改写；原目录 ignored 写入仍有完整守卫。 |
| 必修 6：中断停点 | executeNode → finishAttempt 分列原触发/执行器原因与旧结果保护结论；stale 不再抹去原因，迟到结果不覆盖新活动或通过。源文件/索引/输入变化、取消、释放未知不给通过，提供补救入口；恢复不清零，不为接续重放旧动作，未知释放不能恢复编辑/抢槽。提交/部署的合法输入转换仍由原事务守卫核对。 | 停点是否易懂由 A10 判断，不以技术检查替代。 |
| 建议 1：中断证据 | 复用 attempt.json、results[].interruption、interruption.json，保存原始原因、已知路径/时间、候选/输入/控制有效性及单列保护原因，未知不编造；测试另有 test.json/check-workspace.json 和同账本 testWorkspaces。 | 不声称找回 Word/PA 历史记录缺失的唯一触发事件。 |
| 建议 2：准确文案 | 提醒为“旧 gate 配置已停用；新卡仍按 flow 执行显式测试”；通知按实际对象分单任务/批次。完成不残留“等待验收”，资源未知不称完成/可合入。 | 真实通知观感未验证。 |

必要兼容增量：只改乙测试可在甲仍开发时受控生效，检查中的节点仍守原边界。批次仅把冻结基线/登记旧卡同步到已确认新卡，未知元数据拒绝。目标卡须字节/模式匹配冻结卡、无用户暂存，才由私有索引精确同步；其他用户内容仍逐字保护。没有迁入 reconcileRemovedGate/删除配置功能，本批保留 gate；没有迁入 `--仅本地`、旧队列 `--release`、eval、本机配置、归档/历史删除或第二批清理。

### 实际命令、原始失败与闭环

证据根 **`/tmp/loop-step5-checks-mBQO33/`**。下表 node:test 命令实际均带 `env -u AUTOREVIEW_SINGLE_NODE`，隔离外层身份；fixture 自建 Git、bare origin、kernel/queue/resources/projects、通知及模型/宿主替身。没有真实业务模型、后端、浏览器、远端发布/部署、全仓测试或 test/e2e.mjs。内部循环场景不膨胀为 node:test 计数。

| 检查命令（本工作区） | 日志与结果 |
|---|---|
| `node --test test/kernel-step5-flow.test.ts test/config.test.ts` | `launch-handoff-1.log`：12/12。 |
| `node --test --test-name-pattern='A6 隔离\|A7/A8' test/kernel-step5-flow.test.ts` | `isolation-1.log`：0/2，check-ignore 不接受 literal-pathspecs，且首个取消可早于文件回调。修复参数并分列后续已知路径观察；`isolation-2.log`：2/2，含 Node/Python 正例与 12 类保护反例。 |
| `node --test test/kernel-step5-flow.test.ts`，`LOOP_STEP5_EVIDENCE=.../flow-evidence` | `flow-integrated-1.log`：9/10；新多任务 fixture 误继承 `acceptance.start=exit 93`。明确临时 CLI 方法，不改产品断言；`--test-name-pattern='A5/A9'` → `card-fixture-fixed.log` 1/1。 |
| `node --test --test-concurrency=1 test/kernel-controls.test.ts test/kernel-test-node.test.ts` | `node-controls-regression.log`：16/18；两项合法提交转换被新增元数据误判。限定只读检查元数据守卫，提交/部署保留原事务转换核对；`--test-name-pattern='同次尝试首次\|A7/A9' test/kernel-test-node.test.ts` → `node-publication-fixed.log` 2/2。 |
| `node --test test/kernel.test.ts` | `kernel-regression.log`：39/46（含父/子用例），7 个计数失败同为上述发布转换。`--test-name-pattern='停止不是放弃\|返修1：例外\|修改已登记 guide\|真实 PTY' test/kernel.test.ts` → `publication-guard-fixed.log` 7/7，旧断言保留。 |
| `node --test --test-name-pattern='A5：真实\|A6：只退甲\|甲丙同轮返修\|任务停止/迟到\|旧单任务 v1/v2\|多任务 Claude/Codex\|改任务测试' test/kernel-batch.test.ts` | `batch-regression.log`：4/9；开工时尚未提交到基线的卡旧版本未被新同步逻辑识别。改为仅接受真实冻结基线或登记版本，未知内容仍拒绝。 |
| `node --test --test-name-pattern='A5：真实\|A6：只退甲\|多任务 Claude/Codex' test/kernel-batch.test.ts` | `batch-card-fixed.log`：4/5；双宿主屏障/Hook 通过，A6 暴露目标有与冻结新卡完全相同的未暂存卡。`--test-name-pattern='A6：只退甲'` → `batch-publication-metadata.log` 仍失败（私有索引旧卡 not uptodate）；补精确元数据索引转换后 `batch-publication-metadata-2.log` 1/1。未删旧断言。 |
| `node --test --test-name-pattern='目标前进产生未检查树\|新卡无需手动提交卡\|修改已登记 guide' test/kernel.test.ts` | `target-protection-final.log`：6/6，含目标前进/脏目标/拒推及无交集用户内容保留。 |
| `node --test --test-name-pattern='A11 发布\|A14 真实进程\|A15/A16\|A17 CLI\|A17 Pi\|第[1234]条' test/kernel-step4.test.ts test/kernel-step4-review1.test.ts` | `step4-regression.log`：22/22，部署/只评审、进程互斥、监督/释放、失败不重做及评审释放证明。 |
| `node --test --test-name-pattern='旧 gate\|旧gate\|项目配置复用布局' test/review.test.ts test/workflow.test.ts test/loop.test.ts test/hook-acceptance.test.ts test/production-loop.test.ts` | `gate-shared-regression.log`：13/14，新断言误读 harness 不返回的 stderr。harness 本就要求 stderr 空，去掉多余访问；`--test-name-pattern='项目配置复用布局' test/production-loop.test.ts` → `gate-fixture-fixed.log` 1/1。 |
| `node --test --test-name-pattern='A4 Pi/Hook\|A4 标记' test/kernel-step5-flow.test.ts`，证据 `.../handoff-final-evidence` | `handoff-final.log`：2/2，内部包含三宿主 × 首行标记、真实输入后的干净程序候选、欠检查、讨论、决定、停止，共 18 个适配场景；不只直接调用内核。 |
| `node --test --test-name-pattern='A1\|A3\|A5/A9\|A7/A8' test/kernel-step5-flow.test.ts`，证据 `.../final-increment-evidence` | `final-increment.log`：6/6，实际 UI 变化/生命周期、未知释放拒绝恢复及冻结卡推本地 bare；用户暂存/模式变化/未知卡仍拒绝。 |
| `node --test --test-concurrency=1 test/host-dev.test.ts test/kernel-step4-review2.test.ts`，`LOOP_STEP4_REVIEW2_EVIDENCE=.../legacy-receipt-evidence` | `legacy-receipts-permission.log`：9/9，保留自动审批/精确续接及旧单会话 input/quit/reload 的真实回执；缺失/否定回执仍 blocked。 |
| `node --test --test-name-pattern='新卡会话空闲' test/kernel.test.ts` | `idle-no-duplicate.log`：1/1，空闲不称执行中，停止后精确续跑，启动失败有界诊断、次数不变。 |
| `node --test --test-name-pattern='A1/A2\|A3 状态\|A3/A5\|A5/A9' test/kernel-step5-flow.test.ts`，证据 `.../status-final-evidence` | `status-final.log`：4/4，Linux 诊断不拦查询/后台预览，释放未知不称完成，原会话重载/单任务暂停不影响其他活动。最后任务行完成原因增量：`--test-name-pattern='A5/A9'` → `summary-final.log` 1/1（`.../summary-final-evidence`）。 |
| `node --test --test-name-pattern='A6\|A7/A8' test/kernel-step5-flow.test.ts`，证据 `.../cache-final-evidence` | `runtime-cache-final.log`：3/3，新增已有失效 Python 缓存仍执行原命令、缓存通道链接拒绝及资源未知不删缓存；实际短进程退出后恢复/空登记停止也不能洗白未知释放。 |
| `node --test --test-concurrency=1 test/local-node-queue.test.ts` | `queue-release-final.log`：4/4，真实跨仓库 FIFO/排队与运行停止、边界改卡、死亡 worker 归属保护保留。 |
| `node --test --test-name-pattern='A2 产品测试\|同次尝试首次\|真实命令超时' test/kernel-test-node.test.ts` | `cache-node-regression.log`：3/3，缓存增量后保留原会话产品返修、同次恢复及超时/未知回执/源码写入拒绝。 |
| `node /tmp/loop-step5-checks-mBQO33/reproduce-original-cwd.mjs` | `original-cwd-reproduction.log`、`original-cwd-node/`、`original-cwd-python/`：只读取 HEAD 原 test-node.ts，在临时 fixture 原地执行 Node/Python，均被严格保护中断，保留实际路径/原因。仅证明此受控复现，不声称历史 Word/PA 的唯一原因。修后正例见 A6 的 check-workspace.json。 |

类型检查实际复用 `/tmp/loop-step4-checks-kmykqT/types-check.mjs`（只读副本已存本证据根），不安装/升级依赖：`types-1.jsonl` 10 入口、`types-2.jsonl` 16 入口均 0；`types-3.jsonl` 扩入受改旧测试后报 8 项可选断言说明/隐式 any/闭包可空，补类型和空说明，不改预期。`types-4.jsonl` 19 入口、`types-final.jsonl` 20 入口及依赖均 **0 诊断**；最后 `types-status-final.jsonl` 13 入口、`types-display-final.jsonl` 3 入口仍 0。覆盖 config/git/static-review、kernel CLI/runtime/session/Pi/Hook、kernel/ledger/workspace/controls/batch/submission、test-node/test-workspace/新测试、受改旧测试及 loop.ts。缓存收尾增量使用本证据根脚本 `node types-check.mjs test-node.ts test-workspace.ts local-node-queue.ts test/kernel-step5-flow.test.ts` → `types-cache-final.jsonl`，4 入口及依赖 0 诊断。

pi-lens 实际调用已安装 LSPService 的 touchFile/collectDiagnostics，禁安装、finally shutdown；使用 `/tmp/loop-step4-checks-kmykqT/lens-check.mjs`，脚本/loader 副本已保存。`lens-1.jsonl/.err`（16 文件）、`lens-final.jsonl/.err`（12 文件）、`lens-status-final.jsonl/.err`（显示增量 3 文件）及 `lens-cache-final.jsonl/.err`（缓存/队列增量 4 文件，实际命令 `node lens-check.mjs test-node.ts test-workspace.ts local-node-queue.ts test/kernel-step5-flow.test.ts`）保留请求结果。推断工程仍报缺 Node/Pi 类型等基线诊断，**不把空缓存或退出码当零诊断通过**；显式既有类型依赖的 strict 结果如上。

其余实际检查：`node --check test/helpers/step5-window-example.mjs`；`env -u AUTOREVIEW_SINGLE_NODE node test/helpers/step5-window-example.mjs` → `window-examples.json`；`node .../final-evidence-check.mjs` → `final-resource-and-examples.log/.json`（内部对两份 wrapper 做 `/bin/sh -n` 和 `启动 --dry-run --json`，日志 `example-single-dry-run.log`、`example-batch-dry-run.log`，无 kernel 登记/模型启动）；`git diff --check` 通过。HEAD/分支及受保护文件零差异已核对。新增的 test-workspace.ts、窗口示例和新测试另以 `git diff --no-index --check /dev/null <文件>` 核对（新增差异退出码 1 不是空白错误），`untracked-whitespace-final.log` 为 0 空白诊断；收尾发现的单个尾空格已去除，不改变行为。

收尾补强：已有 Python 缓存不能仅因重新检出的时间变化而被判作输入改写。保留原任务和隔离副本的既有文件保护，改用逐尝试登记的 PYTHONPYCACHEPREFIX 输出通道，哈希/路径在释放前取证；不改原命令或全局环境。执行器缺失回执时 RunResource 标 retained，票据保存 releaseUnproven，恢复/停止不能凭所有者死亡或空登记删除缓存/抢槽。首次交付时新测试文件有 11 个顶层场景，以此前阶段集加后续定向增量覆盖，未宣称最终整文件或全仓重跑。A6 原断言扩为同时核对 Git 隔离产物与专用缓存资源的证据/释放，未削弱原目录不变、原命令、候选/输入或链接保护。

### 断言变化、资源与分层结论

- 既有行为断言变化：review.test 将重复解析 gate 12 条警告改为 0；loop/workflow/hook-acceptance/production-loop 的旧提示断言改为静默（最后一个 harness 本就要求 stderr 空）。不执行 gate、不占预算、状态/配置保护断言保留。
- 8 个原后台 Pi CLI 夹具调用在 kernel、kernel-test-node、step4、step4-review1 中加显式 background，不借 JSON 选后台。主目录旧“仅显式 terminal 开窗/terminal 与 JSON 互斥”断言未迁入；新增默认单/多任务/JSON 开窗、显式后台、去重/部分失败的调用捕获。单会话、权限、来源、用户内容及释放断言不删不降；8 项类型修补不改预期。`test/e2e.mjs` 零差异、未运行。
- 消费者、槽/资源、临时检出按 owner/启动时间/run/task/attempt/Git 共用目录/目录身份收尾。缓存增量后执行 `node /tmp/loop-step5-checks-mBQO33/final-evidence-check.mjs --resources-only`（`final-resource-and-examples-cache.log`，不重复示例解析），`final-resource-and-examples.json` 核对 102 份保存的账本副本、4 个登记组均不存活、77 条测试检出记录的目录/父目录和 77 条测试资源目录均不存在。历史未知释放反例未改成通过；纯内存替身未启动消费者的事实仅用于夹具自身收尾，不给生产路径补回执。
- 初检有 1 份“释放未知”纯内存 fixture 隔离副本被旧 fixture.cleanup 漏收（源仓库先删）。依 `.git` 精确来源引用及 7 份完整 fixture 字节/身份核对归属，不按名字/年龄/PID 猜删；保留 `early-fixture-snapshot/`、`early-fixture-release.json`，执行 `settle-early-fixture.mjs` 精确收尾。后续明确收自己的未启动替身目录并保留未知结果，没有杀其他进程/删未知用户目录。
- 实际开发 worktree、日志/证据及下述仅准备的人工示例有意保留；旧 worktree 未清理。**源码和定向程序覆盖完成**；独立静态评审待外层 Loop，必修仍回原会话。六项必修与两项建议分别如表，不自动关原单、不称第五步整体完成。
- **未验证**：真实 Terminal 开窗/交互补充要求/持续体验/原窗口与外部 worker 的真实装配；真实模型、业务后端/浏览器、真实部署/远端和 A10 人工体验。A1/A3/A10 的实际窗口部分仍是第五步未完成项，不拿替身、进程存活或开发启动当业务通过。

### 协调方窗口核对入口（仅准备，未启动）

示例根 `/private/var/folders/11/sxl0444d11xbqzz8pz0lr2nm0000gp/T/loop-window-example-XH8ORF`，清单 `examples.json`。single/repo 是 `[开发评审, 测试]` 单任务；batch/repo 是 `[开发评审, 测试, 验收]` 两任务；origin 均为本地 bare，无外部业务地址。两卡未安排自动提交/部署，正常检查结束为可合入。wrapper 固定自己的 kernel/queue/resources/projects/通知根并隔离外层身份，不改全局 auto/deny。以下须协调方按模型启动授权手动执行，不是本轮已做的窗口验收：

```bash
D='/private/var/folders/11/sxl0444d11xbqzz8pz0lr2nm0000gp/T/loop-window-example-XH8ORF'
example() { name="$1"; action="$2"; shift 2; "$D/$name/run-loop.sh" "$action" "$D/$name/repo/开发卡.json" "$@"; }
example single 启动
example batch 启动
example single 查询 --json
example batch 查询 --json
# 在原 Pi 窗口输入补充要求，观察首行标记、评审/返修、测试、汇入/统一验收。
example batch 停止 --task 甲 --json
example batch 续跑 --task 甲
# 后台对照先明确停止，不另开验收卡：
example single 停止 --json
example single 续跑 --launcher background --json
# 体验结束先留证据/成果，再按登记收尾：
example single 放弃 --json
example batch 放弃 --json
```

预期单任务 1 个、批次 2 个独立可输入 Pi 窗口；JSON 不改窗口选择，后台无新窗口；活动任务不重派；gate 启动最多一条，查询/续跑不刷屏；本任务与批次进度分列，排队不写执行中，完成/停点/下一步易懂。模型耗时不保证固定秒数，可随时用停止；空闲窗口不是正在检查。收尾同时核对 release 和 testWorkspaces；未知消费者/未提交成果不删，不能凭放弃返回就猜测可删除。

第二批仍只读；第一批实际可用后须重新核对清单并获用户明确确认，才有删除授权。

## 第 5 步第一批：外层第 1 轮评审返修记录

本节保留此前实现与检查的原时态。后续评审指出“停止旧枚举自锁”和“未登记 ignored 输入被省略”仍不满足要求；本节相关“已修”不作为最终结论，以下后续两项返修记录覆盖当前实现。旧日志保留，不把增加方法登记后的通过冒充原条件兼容已通过。

本原会话收到四项必须修改，全部接受；评审记录的小问题本轮未处理。下列记录覆盖首次交付结论的时态，不改写既有失败日志。工作区、分支及 HEAD `623bd10435904e908a30b9c7896e422d82494ac5` 不变，未提交/合入/推送或执行第二批删除；未改主目录、原需求/用户标准、稳定规则、`autoreview.ts/core.ts` 或 `test/e2e.mjs`。

### 逐条处理

1. **第 1 条：已修。** `managedDeliveryIntent` 不再以脏文件单独授权。无首/末交付标记时，先核对当前用户版本/输入/候选的交付上下文，或原会话、候选、代次、任务、完整消息哈希与相关输入均有效的已读返修信封；脏文件仅决定有新候选待检查。新讨论要求不能借旧交付或旧信封推进。Pi、Claude、Codex 真实适配入口均验证“已有修改＋新讨论要求”，含此前已有交付/已读信封的对照：HEAD/工作内容不变、零检查/提交/推送；原会话可信返修无标记仍可推进，已有干净交付/欠检查回归保留。
2. **第 2 条：已修。** `stopKernel` 对所有性质根据未结清事实保留“未确认”，不再只保护只评审。停止后继续核对票据、隔离检出及原释放详情；同一个 `managedReleaseProblem` 被续跑、开发、Pi review-on 和开窗/启动使用，不靠 stopped 或单个枚举解禁。单/多任务的缺回执反例经真正 stopKernel 后仍拒绝续跑和开启开发，保留候选/历史与未交付修改；原消费者没有证明时不核销租约，也不清零次数。夹具仅在确知未启动任何消费者的事实下收尾自己的副本，不改写产品未知结果。
3. **第 3 条：已修。** 隔离装配改为 Git 候选＋localFiles/登记方法与引用输入＋node_modules/.venv/venv 既有依赖目录，和测试输入指纹共用 `testingFileSource`，不把所有 ignored 工作状态误作依赖。未登记旧构建/缓存不带入新检出、不删原目录；`inputPlan.inputs/omitted` 分列来源、路径/哈希与理由，只有原命令在干净候选重新生成的输出才登记为本次产物。真实数据使用已有 localFiles/methods.paths/引用登记，不新增安装体系、产物 DSL 或流程引擎。已执行“先自行构建 dist/built.js，再交付”的相同原命令；dist 中登记数据、跟踪文件及 Node 依赖仍不可改写，原产物/输入不被回写，工作产物变化不使有效检查失效。
4. **第 4 条：已修。** 在同一任务账本中保存 `launchMode`，与可撤销的 terminal 请求分开。停止只撤销请求，不清前后台偏好；默认续跑沿用原选择，显式 launcher 才改选择。检查 worker 后台运输不等于后台开发授权；返修按保存模式恢复原会话。仅本 worker 的请求、返修、候选/代次、任务/会话及 PID/启动时间/owner 匹配时允许交接，不绕过其他活动身份或已有窗口请求；旧请求不能反转后来明确的后台选择。单/多任务共 8 个路径覆盖默认可见、JSON 节点 worker、原后台默认续跑、显式切后台；真实 FIFO 屏障后停止/恢复，原命令只执行一次、有效评审不重跑、候选/目录/会话/计数保持，重复待认领请求不重派。可见开窗只以 osascript 替身捕获请求，真实窗口体验仍未验证。

### 本轮命令、失败与验证闭环

证据根 **`/tmp/loop-step5-review1-xVwL8l/`**。以下 node:test 命令实际均以 `env -u AUTOREVIEW_SINGLE_NODE` 隔离外层；模型、Pi 和系统开窗使用明确替身，Git/本地 bare origin、FIFO、进程组、资源及通知均在本次临时根。没有真实模型卡、业务服务、浏览器、远端/部署、全仓或 e2e。

| 实际命令 | 原始日志与结果 |
|---|---|
| `LOOP_STEP5_EVIDENCE=.../before-evidence node --test --test-name-pattern='第[1234]条' test/kernel-step5-flow.test.ts` | `before.log`：0/4，分别实证讨论导致自动提交、停止把未知改为未释放、已有 dist 覆盖被拒、默认返修未请求可见窗口。每个父场景遇首个失败即停止，不声称基线已跑完其所有内部组合。 |
| `LOOP_STEP5_EVIDENCE=.../fix12-evidence node --test --test-name-pattern='第[12]条' test/kernel-step5-flow.test.ts` | `fix12.log`：2/2，先验证交付边界与停止保护，再继续其他修复。 |
| `LOOP_STEP5_EVIDENCE=.../fix3-evidence node --test --test-name-pattern='第3条\|A6 \|A7 已忽略' test/kernel-step5-flow.test.ts` | `fix3.log`：4/4，含已有 Node 输出、Python 缓存、登记依赖变化。 |
| `LOOP_STEP5_EVIDENCE=.../fix4-evidence node --test --test-name-pattern='第4条' test/kernel-step5-flow.test.ts` | `fix4.log`：1/1，初版单/多任务六个前后台组合；随后增加 JSON 节点 worker 的真实交接对照。 |
| `LOOP_STEP5_EVIDENCE=.../final-evidence node --test --test-name-pattern='第[1234]条' test/kernel-step5-flow.test.ts` | `final.log`：3/4，第 1、2、3 条通过；第 4 条暴露 macOS 对已复制 local.txt 的延迟通知被当作输入修改，原命令本身未写该输入。证据保留，不将此异常说成产品断言失败。 |
| `LOOP_STEP5_EVIDENCE=.../guard-evidence node --test --test-name-pattern='第3条' test/kernel-step5-flow.test.ts` | `guard.log`：2/2。对已逐项证明字节/inode/ctime 等完全不变的输入接受原样通知，事件仍记录；登记输入/依赖目录另冻结元数据。新反例在真实监听回调模拟初始化通知，并实际写后还原/输入目录内创建后删除，后两者仍拒绝，未关监听或笼统放行目录事件。 |
| `LOOP_STEP5_EVIDENCE=.../worker-final-evidence node --test --test-name-pattern='第4条' test/kernel-step5-flow.test.ts` | `worker-final.log`：1/1，内部 8 个组合全部通过，包括真正后台 Node worker 向可见原会话交接；没有真实 Terminal 实证。 |
| `node --test --test-concurrency=1 test/local-node-queue.test.ts test/kernel-controls.test.ts` | `queue-controls.log`：10/10，真实 FIFO、排队/执行停止、改卡、损坏归属和既有控制断言保留。 |
| `node --test --test-name-pattern='A3 环境\|A2 产品\|同次尝试首次\|真实命令超时\|新卡 Claude/Codex 实际启动' test/kernel-test-node.test.ts` | `node-regression.log`：5/5，有限恢复、原会话产品返修、已知/未知回执、真实超时/源码写入及原生通道保持。 |
| `node --test --test-name-pattern='A4 Pi/Hook\|A3/A5\|A7/A8' test/kernel-step5-flow.test.ts` | `adapter-regression.log`：3/3，干净交付/欠检查、真实原会话返修/停止恢复、逐项中断保护回归。 |
| `LOOP_STEP5_EVIDENCE=.../input-final-evidence node --test --test-name-pattern='第3条\|A7 已忽略\|A1/A2\|A1 显式' test/kernel-step5-flow.test.ts` | `input-final.log`：5/5，装配/指纹共用判断后验证 Node 重建、完整输入保护、旧工作产物不失效通过、默认单/多任务与后台模式查询来源。 |
| `node --test --test-name-pattern='旧单任务 v1/v2' test/kernel-batch.test.ts` | `legacy-inputs.log`：1/1，真实旧指纹可查/复用/普通合入；查询不迁移、不重绑旧结果。 |

类型诊断：复用既有脚本 `/tmp/loop-step5-checks-mBQO33/types-check.mjs`，`types-1.jsonl`、`types-final.jsonl`、`types-guard-final.jsonl`（各 7 入口）和 `types-input-final.jsonl`（最终 9 入口及依赖）均 0 诊断。最终命令：`node /tmp/loop-step5-checks-mBQO33/types-check.mjs kernel-session.ts kernel-runtime.ts kernel-pi.ts kernel-cli.ts kernel.ts kernel-workspace.ts node-ledger.ts test-workspace.ts test/kernel-step5-flow.test.ts`。没有安装/升级依赖。

pi-lens：对同样 7/9 个入口实际 touchFile/collectDiagnostics，记录 `lens-final.jsonl/.err`、`lens-input-final.jsonl/.err`；使用同根 `lens-check.mjs`，禁安装并 finally shutdown。推断工程仍有缺 Node/Pi 类型等基线诊断，不把退出码或空缓存当零诊断；显式类型依赖的 strict 结果单列如上。

### 断言、资源及交付边界

- 新增四项必修和初始化通知补充共 5 个顶层场景，当前该文件共 16 项，以本轮定向集和上述回归覆盖，未重复全文件/全仓。第 1 条修后含三宿主 × 无旧上下文/有旧交付及已读信封两种讨论反例，另有可信返修正例；第 4 条内部 8 个组合不膨胀为 node:test 项数。
- 保留此前所有断言；既有 ignored 依赖 fixture 仍用原 `cat runtime/value.txt` 和“仅测试失效、评审保留”断言，只增加已有 `methods.paths` 输入登记，使其确为需装配的真实输入，不再靠所有 ignored 文件隐式带入。没有修改真实项目配置/卡、原需求或用户标准，没有删构建、改无测试或动 e2e。
- `node /tmp/loop-step5-review1-xVwL8l/verify-release.mjs` → `release-verification.log/.json`：核对 52 份账本副本、31 条登记组记录均不存活、51 条隔离检出/父目录及 51 条运行资源目录均不存在；按本轮 run UUID 查询对应 runtime 活动为 0。只核对本次归属，未猜杀/猜删。缺回执反例保留原未知结果，纯内存替身资料仅由夹具根据未启动消费者的已知事实收尾。证据、开发 worktree 和先前仅准备的人工示例有意保留。
- `git diff --check` 通过；新增三个文件的 `git diff --no-index --check /dev/null <文件>` 空白诊断为 0（`whitespace.log`，退出码 1 仅表示新增差异）；受保护文件仍零差异，HEAD/分支不变；未提交/合入/推送。四项必须修改已修，等待外层复评。真实 Terminal/Pi 窗口的开窗、持续交互及业务/人工验收继续未验证，不称第五步整体完成；第二批仍无删除授权。

## 第 5 步第一批：后续两项必须修改返修记录

本节保留当时原实现与检查记录。单进程证明遗漏重命名来源、只支持窄入口的问题，由下文第 2 次返修覆盖；不把当时裸 Node 的通过冒充 npm/Node 测试入口已验证。

本原会话继续处理释放自锁与真实 ignored 输入兼容两项意见，全部接受；不处理评审另记的小问题。工作区/分支、HEAD `623bd10435904e908a30b9c7896e422d82494ac5` 及不提交/发布、不删第二批旧路径的边界不变。本节明确撤回此前“省略未登记 ignored 工作态并要求登记”的兼容策略，不改变原需求或用户标准。

### 逐条处理

1. **第 1 条：已修。** 停止核销不再调用把旧“未确认”作为原因的普通准入分支；核销分支只检查具体未结事项。`consumerReleases` 在停止前保存该尝试的实际进程登记（PID、启动时间、owner/token、工具组及原路径），即使后来原登记已正常删除，仍用原身份重新确认整棵消费者树，写实际确认时间和先前问题。随后按新证明释放票据/资源/隔离目录，清理对应项目租约，保存正常的“未释放（保留工作区）”。原业务记录和当时执行器回执不追改成通过。
   - 缺失身份、原始缺回执且无具体消费者、`releaseUnproven` 继续拒绝；已调用但没有结束记录的尝试仍是具体未结项。`attempt.json.invoked` 区分明确未执行与执行后丢失回执，不能仅靠所有者退出/空登记核销。
   - 真实进程正例：首次人为注入 ps 身份查询失败，停止保留未确认；恢复查询、进程自然退出并按原登记确认释放/清理资源后，第二次停止成功，原目录/候选/会话及次数恢复。另有多任务按任务名操作的真实消费者/票据/隔离目录正例；缺回执反例仍拒绝。统一按稳定任务身份核对，不把任务名误当内部 UUID。
   - `procs.ts` 保留原已知工具组，不能在登记已删除后丢失它们；后续真实回执也可用于安全收尾原资源，但旧候选/控制代次变化仍拒绝原检查结果，不重放动作、不清零预算。
2. **第 2 条：已修。** 既有 ignored 文件恢复完整带入，并恢复全部原输入指纹；原 `cat runtime/value.txt` 无需新增 methods/localFiles/任何配置登记即可运行。恢复原条件 fixture，断言原命令一次执行、真实输出、输入变更使测试失效、评审保留。
   - 为兼容“已有 Node 输出再构建”而不放行全部 ignored，增加单用途 Node 重建证明：原命令仍执行一次，输入先完整带入；仅当实际完整替换前没有消费旧内容、证据通道和退出/释放完整时，才把隔离副本中的普通 ignored 旧文件提升为本次产物。原目录不回写，源码/本机/已登记输入/依赖目录绝不提升。
   - `node-output-proof.ts/node-output-observer.cjs` 是该执行边界的可选证明，不安装全局扩展、不新增登记 DSL/流程/诊断服务。仅可完整观测的单一 Node 调用启用，独立 fd 通道与原始 stdout/stderr 分离，校验本次随机身份、签名链、顺序及唯一开始/退出回执。复杂 shell、额外预加载、原生/子进程/调试消费者等没有完整证明时仍按输入保护，不假称支持所有构建器。
   - 未登记 ignored 输入的 CJS/ESM/文件描述符/模块加载/别名读后写或写回、伪证据、未观测消费者均不提升；实际 Node 写入源码、本机文件、登记数据、Node 依赖也全部拒绝。Node 同一原命令覆盖已有 dist 正例继续通过，Python 专用缓存通道保留。

### 实际命令、原始失败与结果

证据根 **`/tmp/loop-step5-review2-VSnhM1/`**。node:test 命令均实际带 `env -u AUTOREVIEW_SINGLE_NODE` 隔离外层；Git、bare origin、队列、进程、资源、通知及模型/宿主替身都在本次临时根，未启动真实模型卡、业务服务、浏览器、远端/部署、全仓或 e2e。

| 命令（本工作区） | 日志与结果 |
|---|---|
| `LOOP_STEP5_EVIDENCE=.../before-evidence node --test --test-name-pattern='后续第[12]条' test/kernel-step5-flow.test.ts` | `before.log`：0/2；真实原消费者已退出/登记资源已结清后仍被旧枚举自锁，以及原 cat 因 ignored 输入没带入失败，均已实证。 |
| `LOOP_STEP5_EVIDENCE=.../release-evidence node --test --test-name-pattern='后续第1条\|第2条：真实停止\|A7/A8' test/kernel-step5-flow.test.ts` | `release-fix.log`：3/3，先验证正例和继续保护缺回执，再实施输入兼容。`types-release.jsonl` 有 1 项可空类型错误（保留原工具组时的 saved 可空），已用可空访问修复，不改运行预期。 |
| `LOOP_STEP5_EVIDENCE=.../input-evidence node --test --test-name-pattern='后续第2条\|第3条：先自检\|A7 已忽略' test/kernel-step5-flow.test.ts` | `input-fix.log`：3/3，无登记的原 cat、原 Node 重建命令和原 ignored 输入失效规则通过；`types-input.jsonl` 11 入口 0。 |
| `LOOP_STEP5_EVIDENCE=.../protection-evidence node --test --test-name-pattern='后续第2条' test/kernel-step5-flow.test.ts` | `protection.log`：3/3，含 8 个消费/别名/不可观测/伪证据对照及 4 个强输入实际 Node 写入反例；不膨胀为 node:test 项数。 |
| `node --test --test-concurrency=1 test/procs.test.ts test/local-node-queue.test.ts` | `procs-queue.log`：7/7，独立工具组、登记删除/清空 owner 的消费者、终止观测及 FIFO/停止回收保护保持；`types-proof.jsonl` 11 入口 0。 |
| `LOOP_STEP5_EVIDENCE=.../final-evidence node --test --test-name-pattern='后续第[12]条\|第3条：先自检' test/kernel-step5-flow.test.ts` | `final.log`：6/6，后续两项正负例及已有 Node 输出重新构建闭环。 |
| `node --test --test-concurrency=1 --test-name-pattern='第1条\|第3条\|A2 产品测试\|同次尝试首次\|真实命令超时\|跨仓库真实\|排队取消\|waiting 边界\|死亡 worker' test/kernel-step4-review2.test.ts test/kernel-step4-review1.test.ts test/kernel-test-node.test.ts test/local-node-queue.test.ts` | `shared-regression.log`：21/21（含父/子用例），旧单会话取消/真实回执、缺回执 blocked、只评审/共享执行、产品返修/环境恢复、超时和队列释放保持。 |
| `node --test --test-name-pattern='旧单任务 v1/v2' test/kernel-batch.test.ts` | `legacy-inputs.log`：1/1，真实旧指纹可查/复用/普通合入，查询不迁移、不重绑。 |
| `LOOP_STEP5_EVIDENCE=.../release-final-evidence node --test --test-name-pattern='后续第1条\|第2条：真实停止' test/kernel-step5-flow.test.ts` | `release-final.log`：4/4，新增多任务按名字停止的实际证明核销，票据/隔离目录/正常续跑与计数保持；原缺回执仍拒绝。 |
| `node --test --test-concurrency=1 test/local-node-queue.test.ts test/kernel-controls.test.ts` | `controls-final.log`：10/10。 |
| `LOOP_STEP5_EVIDENCE=.../build-final-evidence node --test --test-name-pattern='第3条：先自检\|后续第2条：原配置' test/kernel-step5-flow.test.ts` | `build-final.log`：2/2，最终唯一开始/退出回执校验后，Node 重建和无登记原 cat 仍通过。 |

类型与实际诊断：`types-final.jsonl`、`types-delivery.jsonl` 最终各 12 入口及依赖 0，`types-reconcile-final.jsonl` 核销增量 11 入口 0；`node --check node-output-observer.cjs` 通过。脚本为 `/tmp/loop-step5-checks-mBQO33/types-check.mjs`，实际参数包括 node-output-proof、test-workspace/test-node、kernel/workspace/runtime/session、git/Hook、ledger/procs、新测试。pi-lens 对同样入口及 CJS 实际 touchFile/collectDiagnostics，记录 `lens-final.jsonl/.err`、`lens-delivery.jsonl/.err`；禁安装、finally shutdown。推断工程缺 Node/Pi 类型的基线诊断继续保留，不把空缓存/退出码当零诊断。脚本/loader 只读副本存本证据根。

### 断言、收尾及未验证

- 撤回上一轮为 runtime fixture 添加 methods.paths 的改动；恢复原命令、原配置/路径和原输入变更断言，不要求真实用户登记。原“省略工作态所以变化不使测试失效”断言改为更严格的“全部 ignored 快照变化仍失效”；本轮没有通过省略指纹、丢输入或放行全部 ignored 保留通过。`inputPlan.omitted` 为空，提升必须有本次 Node I/O 证明。原需求/用户标准、真实配置、稳定规则和 e2e 均未改。
- 当前新测试文件 22 个顶层场景，仍以实际定向增量覆盖，不假称最终整文件/全仓重跑；原始 0/2 失败、后续成功及可空类型失败均保留。
- `node /tmp/loop-step5-review2-VSnhM1/verify-release.mjs` → `release-verification.log/.json`：58 份保存账本，10 条登记组/原消费者身份记录均已退出；60 条检查工作区/父目录和 60 条运行资源目录均不存在，按本轮 UUID 查 runtime 活动为 0。仅按本次登记取证，不猜杀/猜删；缺回执反例保留当时没验证/未知结果，纯内存替身副本仅由夹具基于已知未启动事实收尾。开发 worktree、历史/本轮证据和先前人工示例有意保留。
- `git diff --check` 通过；5 个新增源码/示例文件另以 `git diff --no-index --check /dev/null <文件>` 检查（新增差异退出码 1 非空白错误），`whitespace.log` 为 0 空白诊断。受保护文件零差异；未提交/合入/推送或第二批删除，HEAD/分支不变；等待外层复评。真实 Terminal/Pi 交互、真实业务以及未完整观测的构建器写入仍未验证，不称第五步整体完成。

## 第 5 步第一批：第 2 次返修记录——重命名与常规命令入口

本原会话接受两项必须修改，不处理评审另记的小问题。工作区/分支、HEAD `623bd10435904e908a30b9c7896e422d82494ac5`、不提交/合入/推送及不执行第二批删除的边界不变。主目录、真实配置、原需求/用户标准、稳定规则、旧 `autoreview.ts/core.ts` 完成语义与 `test/e2e.mjs` 不修改。

### 逐条处理

1. **第 1 条：已修。** 原输入或包含原输入的目录被重命名时，其内容可能通过新路径继续被消费；此时保守标记整次证明不可完整观测，不批准任何旧文件提升，而不是只在目标路径记录 replace。覆盖同步、Promise 和目录重命名 × 覆盖/原字节写回共 6 个反例；临时文件清除后也不能使原输入通过。源码/登记输入/依赖继续由原指纹和元数据独立保护。新生成临时产物原子重命名到已有输出的正例保持，不要求删构建或改命令。
2. **第 2 条：已修。** 原命令入口识别扩展为经过验证的 Node 可执行文件/Node shebang 工具（如 npm），不再排除 `node --test`。通过 ChildProcess 实际启动边界观察 Node/Node-shebang 子进程，以及仅委派一条已验证 Node 调用的系统 shell；原卡仍为 `npm run build` 或 `node --test test/example.test.ts`，没有改成裸 Node。
   - 本次身份/能力只沿已验证消费者树传递，逐进程保留开始/退出、父子委派、启动结果和签名链；缺节点、错父节点、未退出或出现未覆盖消费者时不得提升。仅导入 child_process/Node 测试基础设施不再等同于发生未知消费；实际原生/同步外部调用、未观测线程/调试/网络等仍保守拒绝。
   - 证据 fd 追加到未占用位置，保留已有业务 IPC；Node 测试 worker 和 npm 之下的 Node fork 均有真实回执。多进程帧分片后校验并重组，按首次片段出现的全局顺序判断原内容是否先被读取，不用签名完整替代读取来源完整。
   - Node/npm 正例均先在原任务目录自行构建留下已有 `dist/built.cjs`，再执行同一原命令；原目录哈希不变，只有隔离副本重建产物被提升，消费者/临时资源正常释放。npm 正例含 Node fork、业务 IPC fd3 和原子临时文件替换；新增证据通道不占用业务 fd3。跨 Node 消费者先读后写仍拒绝，完整保留既有输入/依赖保护。

### 本轮检查与原始失败

证据根 **`/tmp/loop-step5-review3-W8emtx/`**。node:test 命令实际均带 `env -u AUTOREVIEW_SINGLE_NODE`，并隔离 Git/bare origin、npm cache/userconfig、队列、资源、通知及宿主/模型替身。不安装/升级依赖，不跑真实模型、业务服务/浏览器、远端/部署、全仓或 e2e。

| 实际命令 | 日志与结果 |
|---|---|
| `LOOP_STEP5_EVIDENCE=.../before-evidence node --test --test-name-pattern='本轮第[12]条' test/kernel-step5-flow.test.ts` | `before.log`：0/2；重命名消费被误记通过、npm 原命令已有产物重建被中断，均已实证。循环遇首个失败停止，不声称基线已运行其全部组合。 |
| `LOOP_STEP5_EVIDENCE=.../rename-evidence node --test --test-name-pattern='本轮第1条\|第3条：先自检' test/kernel-step5-flow.test.ts` | `rename-fix.log`：2/2；先验证 6 个重命名反例与原重建正例，再扩展消费者树。 |
| `LOOP_STEP5_EVIDENCE=.../entries-evidence node --test --test-name-pattern='本轮第2条' test/kernel-step5-flow.test.ts` | `entries-1.log`：npm 真实入口已通过；Node 测试 fixture 继承外层 NODE_TEST_CONTEXT，Node 主动跳过嵌套测试，导致自检没生成文件。不是产品已通过或删除构建；仅隔离外层测试身份，保留原卡命令和断言。 |
| `LOOP_STEP5_EVIDENCE=.../entries2-evidence node --test --test-name-pattern='本轮第2条' test/kernel-step5-flow.test.ts` | `entries-2.log`：1/1，原 npm 与 Node 测试命令均实际执行并通过。 |
| `LOOP_STEP5_EVIDENCE=.../final-evidence node --test --test-name-pattern='本轮第[12]条\|后续第2条保护\|后续第2条强输入' test/kernel-step5-flow.test.ts` | `final.log`：4/4，含重命名 6 反例、npm/Node 测试 2 原入口（npm 含业务 IPC）、跨消费者读取/别名/伪证据及源码/本机/登记输入/依赖写入保护。内部组合不膨胀为 node:test 项数。 |
| `node --test --test-concurrency=1 --test-name-pattern='第1条\|第3条\|A2 产品测试\|同次尝试首次\|真实命令超时\|跨仓库真实\|排队取消\|waiting 边界\|死亡 worker' test/kernel-step4-review2.test.ts test/kernel-step4-review1.test.ts test/kernel-test-node.test.ts test/local-node-queue.test.ts` | `shared-regression.log`：18/21（含父/子计数）；并行验证时，旧只评审用例的 3500ms 墙钟取消触发，两个子例和父例失败，其他通过。没有改阈值或断言。 |
| `node --test --test-name-pattern='第3条：评审程序不存在' test/kernel-step4-review1.test.ts` | `shared-timeout-recheck.log`：4/4，仅独立补验失败项；真实返回/缺回执保留阻塞、不得盲重试的原断言通过。不把此结果声称为负载压力验收。 |

类型/诊断：`node --check node-output-observer.cjs` 通过；`types-1.jsonl`（4 入口）、`types-final.jsonl`（6 入口及依赖）均 0。实际使用既有 `/tmp/loop-step5-checks-mBQO33/types-check.mjs`，参数覆盖 node-output-proof/test-workspace/test-node/git/共享 Hook/新测试。pi-lens 对同样入口及 CJS 实际 touchFile/collectDiagnostics，结果 `lens-final.jsonl/.err`；禁安装、finally shutdown。推断工程缺 Node/Pi 类型的基线诊断保留，不把空缓存或退出码当零诊断。脚本/loader 副本保存本证据根。

### 断言变化、资源及分层结论

- 新增两项顶层测试，当前文件共 24 项，以本轮定向集和共享回归覆盖，未默认重跑整文件/全仓。未改用户标准、未删断言、未改原测试入口或去掉构建。旧“opaque-consumer”fixture 从仅导入模块改为真实调用 native cat：因为模块导入本身没有消费者，改后仍断言未完整观测消费不能放行；另增加已观测 Node 子消费者读取后父进程改写的拒绝反例。Node/npm 正例加入新临时文件原子替换，保证修来源漏洞不阻断该正常重建。
- `node /tmp/loop-step5-review3-W8emtx/verify-release.mjs` → `release-verification.log/.json`：34 份账本副本、36 条检查空间/父目录和 36 条资源目录均已收尾；本轮登记 runtime 活动 0，未猜杀/猜删。没有真实部署/模型会话。源开发 worktree、历史/本轮证据和先前仅准备的人工窗口示例保留。
- `git diff --check` 通过，受保护文件零差异，HEAD/分支不变，未提交/发布或执行第二批清理。两项必须修改已修，待外层复评；真实 Pi/Terminal 窗口、业务体验，以及未完整观测的其他构建器继续未验证，不称第五步整体完成。

## 第 5 步第二批前期只读候选清单（历史）

本清单已并行静态梳理，仅作为第一批完成后复核的候选范围。位置以准备时主目录和第四步源码为依据；最终必须按第一批合入后的实际调用关系更新。不能按文件名整删共享模块，也不能以删测试消除失败。

| 候选清理对象 | 旧函数/入口 | 替代与必须保留 |
|---|---|---|
| workflow 与每段验收编排 | `config.ts` 的 StageWorkflow/parseStageWorkflow/workflowSteps/batchStageConfiguration；`review.ts` 的 acceptanceStep 与流程分支；`pipeline.ts` 段配置 | 新卡 flow、内核推进、acceptance-node；保留 parseAcceptanceConfig 和验收执行能力。 |
| 定向成功后追加 full | `acceptance.ts/runAcceptanceStage` 及 review/pipeline 调用者 | 保留 runAcceptanceOnce/runAcceptanceAttempt、标准/授权、证据与资源；新内核决定精确复验集合。 |
| 评审/验收共用预算 | checkRoundBudget、跨节点共用 deadline/repairs | 保留单会话评审自身预算、preparation 预算和新节点独立 limits；不全局删 maxRepairs。 |
| workspaces、旧开工两步 | ProjectLayout.workspaces、旧目录推导、loop.ts/cmdOpen 及旧批次装配 | 新 createKernelRun/createWorkspace/launchKernel；保留 localFiles、准备/权限/来源/问题单。workspace.ts 的共享 Git 和归属工具不能整删。 |
| 旧串行流水线和旧卡执行 | parsePlan/dispatchBatches/runPipeline、legacyCompatibility 旧调度 | 新任务并行与 batch-integration；保留旧卡明确迁移拒绝。pipeline-core 的原子存储等被多个模块复用，不能整删。 |
| 旧队列重复检查、免审、批次分支推送 | queueReviewedResult、runMergeQueue 的旧检查返修、commit-batch 旧推送 | 账本 validResult、统一资格和 submission-node；保留历史、真实用户决定、候选/资源保护、第四步部署/回退/互斥。 |
| 独立 accept-cmd | autoreview.ts 的参数、执行与完成门槛、core.ts 对应状态/总结 | 卡上 test/test-node；旧参数保留准确迁移诊断。单会话开发、静态评审和原会话返修必须持续可用。 |
| 旧说明与模板适配 | CLI 帮助、README、工具清单、运行维护和模板中的旧字段/入口 | 同步现用说明；历史文档和旧工作目录另列，不在本批自动删除。 |

特别保留：`pa-resume.ts` 和 `review-only.ts` 仍依赖旧 parsePlan；不能因删流水线连带删 PA 或直接只评审能力。`autoreview.ts/hosts/review-hook.ts/review.ts` 仍承载单会话；第二批只拆旧编排耦合，不取消其配置、来源、原会话返修、通知和证据能力。经验库、归档、人工/授权、方法和资源边界均保留。

测试候选逐条映射：workflow/pipeline 的旧格式接受与串行断言，acceptance-recheck 的追加 full 断言，config 的共用预算断言，autoreview-delivery 的 accept-cmd 断言，分别改为对应新行为。loop-documents/preflight/queue/recipes 中的本机文件、来源、权限、失败分类、进程与回退断言迁到新入口后继续保留，不能整文件删除。kernel、第四步与旧单会话相关保护继续保留；`test/e2e.mjs` 不改不删。

执行第二批前逐项列明：最终旧调用者、保留能力的承接入口、每条拟删测试的替代断言。清单经用户确认后才实施。旧 worktree 须另核对归属和成果，再单独确认；本轮没有清理任何旧目录。

## 第 4 步阶段原记录（历史）

第四步实施时的阶段记录：**第四步外层第 2 次评审的唯一必须修改已返修并完成真实进程定向验证，待外层复审；未提交、发布或真实部署**。2026-11-07 用户要求完成第四步、用最新 Loop、新分支 `refactor/xxxx-step4`。已从本机已发布 dev `5f23127` 建立 `refactor/loop-kernel-step4`，前三步历史记录保留，不把其中“待复审”等旧时态当作当前进度。dev 与本机 origin/dev 记录同为 `5f23127`；本次没有通过联网或业务复跑补验历史发布。

本次唯一任务文件：[第 4 步提示词](prompt/提示词-Loop内核与节点编排-4部署与只评审.md)。权威需求只读：`/Users/Admin/Desktop/loop/issues/【req】Loop内核与节点编排.md`。五步名称与顺序不变，第五步删除旧路径及旧 worktree 须另列清单确认，不在本步执行。

## 第 4 步实施方案

### 目标、入口与边界

本步将部署和只评审接入开发卡。开发卡写部署才在提交之后部署；只评审卡只检查明确的已有提交并出报告。完成以两条真实产品路径、统一账本/控制/释放及相关回归成立为准，不以新增解析字段或启动开发会话代替交付。

- 产品工作目录 `/Users/Admin/.pi-autoreview/worktrees/loop-kernel-step4`，分支 `refactor/loop-kernel-step4`，基线 `5f23127`。
- 按权威需求继续 **Pi + Loop 单会话开发评审**，不是用尚未实现的第四步卡开发自己。外层从 `/Users/Admin/Desktop/loop/bin/loop 开发 pi` 加载当前 `autoreview.ts`；本工作区代码仅用于产品修改和隔离验证。
- 主目录已有的 `loop.ts`、`merge-queue.ts`、文档等改动保留，不带入新分支；仅复制本机 `.autoreview.json`，不改旧 gate、不恢复全量测试。原需求、稳定规则、旧 worktree、temp/ 和全局配置不修改。
- 本次开发和定向检查已授权；真实仓库 add/commit/合入/推送、真实部署尚未授权。产品部署、推送、回退只用系统临时 Git 和本地 bare origin 验证。普通步骤自检通过就继续，最终交外层静态评审。

### 已核对源码与改动顺序

1. `development-card.ts` 已有六个固定节点名字，但只接受开发性质和开发评审/测试/验收/提交。先扩为部署及单任务只评审的合法组合，完整只读校验后才建资源；开发多任务必带验收、纯测试底线继续保留。
2. `config.ts` 已有 `DeploymentConfig`（enabled/cmd/check/timeoutMin）；`merge-queue.ts/runDeployment` 有项目互斥、版本守卫、cmd/check 和检查失败回退。抽出最小必要能力，不让新节点读旧队列状态，不复制整套旧编排。
3. `kernel-session.ts/mergeManaged`、`kernel-runtime.ts/resumeManaged` 和 CLI/宿主收尾存在 publication 早退或随即释放。必须统一接续“发布 → 已安排部署 → 收尾”，部署绑定压缩后的实际发布提交，不能被已合入状态或提前释放吞掉。
4. `kernel-workspace.ts/checkInputs` 的新版配置投影主动排除 deployment，`node-ledger.ts` 的 activity/结果/任务字段仍偏开发检查。只增加本步必要部署/只评审输入与状态，保留真实旧账本指纹，不使改部署连带重评审。
5. `review-only.ts` 现有入口经 `runReviewRound` 走旧组合层；新卡改复用 `static-review.ts` 的调用/解析/证据与既有报告格式。受评 base/head 固定，隐藏隔离检出，不形成开发提交、不派返修、不获取合入资格。
6. `kernel.ts` 的五态、结论行、外部合入识别、工作区守卫，及 `kernel-controls.ts`、`kernel-cli.ts`、`kernel-pi.ts`、`hosts/kernel-hook.ts` 要逐条处理新性质和发布后活动。最后同步帮助/README/运行与维护及受影响测试，不清理旧实现。

### 本步必须处理的行为

开发卡只有安排部署且本次本地合入和 origin/dev 推送成功，才执行项目部署。缺配置在建资源前拒绝；没安排就不执行。每个部署动作绑定真实发布身份、配置、目录和进程；按项目与其他检查互斥，排队不伪报运行。成功只执行一次；中断且副作用未知时保留现场，不盲目重试。仅重跑部署不重新开发、评审、测试、验收或推送。

沿用旧部署的明确失败语义：cmd 失败停止；cmd 成功、check 失败且目标仍为本批、上一版明确且用户内容安全时，回退本机版本并重新部署上一版。目标前进、脏文件、停止或资源未知则保留现场。不强推远端，不将本地回退说成远端回退；本地、远端、运行版本分别展示。原发布/检查记录保留，回退事务的预期版本变化与未授权源码写入分开核对。

只评审卡为单任务 `nature:评审`、`flow:[评审]`，明确已有 base/head，文件输入只读。不混开发或部署节点，不新增多任务底线例外。需求/标准、比较范围、模型和输入版本都进结论身份；分支后来移动不换对象。只出必须修改/建议报告，无开发宿主和返修；正常结束释放隔离检出。查询不能因为受评提交已经在 dev 上就称已合入，也不能出现可合入；在既有五态中明确“只评审已结束”和真实报告结果。

所有控制入口按性质接受合法操作：只评审仅重跑评审，部署仅在安全明确状态重跑；停止/改卡/迟到结果不覆盖新控制决定。已发布后停止只取消余下动作，不撤销历史发布。卡没安排的节点继续标没验证。清理只认本批登记，未知/脏目录保留；报告/证据与分支历史不删除。

### 验证与完成条件

新增验收 A11—A17 位于第四步提示词：部署成功/不重复、非法卡及推送失败不部署、失败安全回退、停止/配置/中断竞态及互斥、只评审纯报告/不写用户区、非法只评审与候选固定、前三步及旧入口回归。原需求 A1—A10 原文不变。

开发按卡与输入 → 部署执行和发布接续 → 只评审执行 → 控制/查询/释放 → 三宿主受影响集成顺序做最小充分验证，复用 node:test、kernel fixture 和现有部署/recipe 测试。系统临时根隔离 Git/bare origin、模型替身、队列、资源及通知；禁全量和真实业务/远端部署，不改 test/e2e.mjs。旧“尚未支持”断言按新需求改变时逐条记录；不删测试、不弱化安全断言。

完成后开发方在本节追加实际命令、日志、结果、资源、断言变化和未验证项，交外层 Loop 静态评审返修；不自行提交/发布。源码、自检、外层评审、真实部署及业务验收分列。与旧问题单的关系仅作证据对照，不自动关单，不补记前三步未验项。

### 第 4 步准备与启动记录

已建上述分支/目录，原主目录文件指纹保存于 `/Users/Admin/.pi-autoreview/preparations/loop-kernel-step4-20261107/before.json`。没有提交、合入或推送。任务按源码核对后编写；启动与权限检查结果以该 preparation 目录及本节后续实际记录为准。

本次重新核实的 Pi：入口 `/Users/Admin/.local/bin/pi`，真实包 `@earendil-works/pi-coding-agent` 1.3.0（安装目录名仍是 1.2.0，不能据目录名认版本）；当前参数解析支持 offline、显式扩展、工具名单、会话名、session-id 和本次 approve。权限扩展为 `/Users/Admin/.pi/agent/npm/node_modules/@gotgenes/pi-permission-system/src/index.ts`；Ponytail 为 `/Users/Admin/.codex/plugins/cache/ponytail/ponytail/4.13.0/pi-extension/index.js`，均实际存在。

按本次开发阶段选择 read/edit/write/bash，加载权限、当前 autoreview、Ponytail full；不加载不相关浏览器/MCP/其他开发 Agent，不卸载任何插件。全局 yoloMode=true，新目录无项目覆盖；不改持久配置。`--offline` 仅关闭启动联网检查，正常模型连接保留。运行前用真实权限处理器模拟四工具，再核对正式入口参数和启动后会话实际状态；启动成功不等于第四步完成。

准备检查实际结果：真实权限扩展处理器模拟 read/edit/write/bash 均放行、0 次询问，没有执行这些探针工具或调用模型；正式入口 dry-run 正确指向三项扩展、本任务文件及精确新会话 `1042a590-6ddd-4c14-a827-03110cc4052d`；启动脚本语法与文档 diff 检查通过。第四步 7 条标准能由现有解析器完整提取：本页文档 A11—A17 对应会话运行编号 A1—A7。第一次错误地期望解析器保留文档编号的检查失败，随后依据现有规则修正检查并明确映射，没有修改产品解析器或标准内容。

原始结果：上述 preparation 目录的 `permission-handler-check.json`、`launch-dry-run.log`、`prompt-check.json`；前台启动脚本 `start-step4.sh`，实际启动状态另记 `startup.json`。准备没有运行产品测试/构建、真实部署或远端发布。

## 第 4 步实施与验证记录

工作目录 `/Users/Admin/.pi-autoreview/worktrees/loop-kernel-step4`；分支 `refactor/loop-kernel-step4`；真实 HEAD 仍为 `5f2312782ad59e3f0bb63f0b4fa38029bb9b455a`。保留本轮原有方案/提示词准备改动，未 add/commit/stash/reset/merge/push 真实仓库，未修改桌面运行版或本机 deployment 配置。未启动嵌套真实开发/评审 Agent；独立静态评审交外层已发布 Loop。

### 实际实现

- **卡和输入**：保留 version:1、前三步开发卡及真实旧 v1/v2 指纹；开发固定顺序扩到提交后的可选部署。无提交的部署卡、缺失/禁用/非法配置在资源前拒绝，无部署卡不隐含部署。单任务只评审为 `nature:评审, flow:[评审], tasks:[{name}], review:{base,head,requirement?,criteria?,note?}`；不要求开发 prompt/scope/target/host 或存在 dev，不 fetch。多任务只评审、混入开发/检查/发布及纯测试卡仍拒绝。
- **独立身份**：只评审首次冻结明确 commit/tree，分支移动不换对象，同树换 HEAD 也拒绝；文件、模型和时限有已确认快照，变化须受控改卡确认，查询不迁移、不采用新输入。部署有独立 deploymentPlan/输入指纹，绑定实际压缩发布 commit/tree、配置、方法文件及执行 cwd/Git 共用目录；修改 deployment 不重跑未变的前置检查，旧算法不通过迁移伪造结论。
- **部署执行及生命周期**：`deployment-exec.ts` 抽取新旧共用命令、日志、进程和资源执行边界；`deployment-node.ts` 不引用其他节点或旧队列状态。`kernel-session.ts` 统一发布后的接续，CLI、worker、Pi 和两类 Hook 的 publication 路径均核对部署后收尾。推送失败、未完成提交意图及 Loop 外合入不自动部署/重推；同一成功部署只复用，安全失败仅重跑部署，不重新开发/评审/测试/验收/提交/推送。
- **实际互斥及回退**：`project-execution.ts` 用 Git 共用目录的短锁登记检查读租约/部署独占租约，接通新节点与旧静态评审、组合评审、验收、队列发布和部署的实际执行边界；部署不占全机测试槽。每个 cmd/check/重部署前后核对版本、目录、origin、源码/索引、配置与消费者。cmd 失败只停部署；check 失败且条件完整时，用登记意图、反向 CAS 和私有索引回退本机 dev，再以原 cmd 执行上一版方法。只归一化 Git 可证明的预期方法转换；脏内容、挡路文件、目标前进、停止/超时、未知消费者或副作用不自动回退/重做。没有远端强推/撤回或再次自动推送；本地、最近远端推送确认、最近成功部署命令和回退分列，未知不冒充实时业务结果。
- **只评审执行**：`review-node.ts` 直接复用 `static-review.ts` 的调用、格式解析和最多一次失败重试，不调用 runReviewRound、开发交付、准备或队列。隐藏分离检出中保留范围、base/head/tree、必须修改/建议、模型、耗时、调用原文、快照和证据。有必修只记不通过，不发返修；调用失败记没验证。Git 取证也登记实际消费者；取证失败且已确认释放可正常收尾，缺释放证明不能凭空登记洗白。目录/索引/输入守卫使迟到结论无效，用户原工作区的暂存/未暂存/未跟踪内容不进入候选、不被改动。
- **控制/展示/释放**：只评审从不取得合入资格，普通/接受未验证合入及整合均拒绝；五态中用“等你决定”明确显示“只评审已结束”、结果、报告及资源，不误判 Loop 外合入，不显示成开发交付。已发布停止/放弃只取消剩余活动，不撤销发布事实。发布后禁止改卡及追加部署授权，冻结配置变更先拒绝；未知在途命令、回退意图和释放未知保留现场，不能盲重跑。正常结束按登记释放干净空间，分支/历史/报告/证据保留。
- **使用说明**：README、工具清单、运行与维护及 CLI 帮助同步第 4 步字段、完整示例、补救命令和真实验证边界。旧直接评审/部署入口保留，第五步旧路径/工作目录删除未实施；稳定规则、原需求、用户标准及 `test/e2e.mjs` 未修改。

### 原始命令、日志与结果

证据根：`/tmp/loop-step4-checks-kmykqT/`。程序用例各有独立系统临时 Git、本地 bare origin、kernel/projects/resources/local-queue、通知配置和模型/宿主替身；不使用真实远端、真实部署或业务模型。以下均在本工作目录运行，日志保留原失败/中断，不将初检改成通过。

| 原始命令 | 日志与结果 |
|---|---|
| `node --test test/kernel-step4.test.ts` | `step4-foundation.log` 初检 9/13（只评审快照指纹构造错误）；修复后 `review-foundation-2.log` 定向通过。`step4-integrated-1.log` 30/33（含父用例，回退后重跑未在派发前明确拒绝）；修复后 `new-integration-2.log` 对该项通过，但新增两项夹具错误，后续如下。阶段完整集 `step4-final.log` **41/41**。之后只新增两项释放证明反例，按影响定向验证，不重复扩大完整集。 |
| `node --test --test-name-pattern='A14 真实进程\|A14 停止部署\|A13/A14\|A14 配置\|A16 只评审运行' test/kernel-step4.test.ts` | `boundaries-1.log` 14/17：停止与进程返回竞争误记 blocked 而非 cancelled，已修。`node --test --test-name-pattern='A14 停止部署' test/kernel-step4.test.ts` → `stops-2.log` 通过。真实进程屏障记录读者开始/结束、部署开始/结束及后续读者开始/结束，双向实际互斥，不靠固定等待或 Promise.all 声称互斥。 |
| `node --test --test-name-pattern='A13 check\|第四步 README\|已登记的部署方法\|A17 CLI\|A17 Pi' test/kernel-step4.test.ts` | `new-integration-2.log` 8/10：新增帮助测试误期望 exit 0（既有帮助为 2），方法回退夹具误用了成功 check；修正夹具而非产品语义。`node --test --test-name-pattern='第四步 README\|已登记的部署方法' test/kernel-step4.test.ts` → `fixtures-3.log` **2/2**，实际解析 README 两张完整卡示例，方法回退执行新/旧各自脚本。 |
| `node --test --test-concurrency=1 test/kernel-controls.test.ts test/kernel-test-node.test.ts` | `prior-nodes.log` 首次检查受工具 120 秒总时限中断；`prior-nodes-2.log` 17/18：项目执行边界新增 await 期间过早标 waiting，导致旧 pending 改卡断言失败。改为真实竞争才标等待，未启动旧命令的边界拒绝 pending；`node --test --test-name-pattern='活动边界 pending' test/kernel-controls.test.ts` → `control-boundary-3.log` 通过，旧断言未改。 |
| `node --test --test-concurrency=1 test/kernel.test.ts test/kernel-controls.test.ts test/kernel-test-node.test.ts test/local-node-queue.test.ts` | `kernel-regression.log` 66/68（含父用例）：仅旧推送失败复用提示缺少“不自动重试”原文，已保留原 Git 原因及该提示。`node --test --test-name-pattern='目标前进产生未检查树' test/kernel.test.ts` → `push-compat-2.log` **4/4**；其余通过项不重复执行。 |
| `node --test --test-concurrency=1 test/kernel-batch.test.ts test/acceptance-recheck.test.ts test/acceptance-recovery.test.ts` | `batch-regression.log` 前 **43 个顶层场景通过**，包括旧单任务真实旧指纹、普通/例外合入、精确重验、双宿主屏障和旧验收恢复；随后达到工具 480 秒总时限，并非产品判定失败。`node --test --test-name-pattern='集成 CAS 后中断\|多任务 Claude/Codex' test/kernel-batch.test.ts` → `batch-remaining.log` **4/4**，只补剩余场景。 |
| `node --test --test-concurrency=1 test/batch-delivery-deployment.test.ts test/batch-delivery-deployment-wait.test.ts test/recipes.test.ts` | `legacy-deployment-review.log` **24/24**，保留旧部署等待/边界/失败回退及旧直接只评审行为。 |
| `node --test --test-name-pattern='A12/A16\|A11 发布\|A15/A16\|第四步 README\|A17 Pi\|A14 停止部署\|A16 只评审' test/kernel-step4.test.ts` | `final-boundaries.log` **20/20**：收尾控制版本、只评审展示/精确对象及三入口受影响边界复核。 |
| `node --test --test-name-pattern='缺少消费者释放证明\|只评审运行中' test/kernel-step4.test.ts` | `review-release-final.log` **5/5**：补“空登记不等于释放证明；停止不能洗白后重跑”。 |
| `node --test --test-name-pattern='A15\|A16 只评审\|A17 CLI' test/kernel-step4.test.ts` | `review-proof-final.log` **12/12**：最后补取证失败的已释放/未知释放区别，以及实际 CLI、固定对象、模型替身三种报告和运行中失效。 |

诊断原始命令：

```bash
node /tmp/loop-step3-checks-hWvPgT/types-check.mjs development-card.ts node-ledger.ts kernel.ts kernel-workspace.ts kernel-session.ts kernel-runtime.ts kernel-cli.ts kernel-controls.ts kernel-pi.ts hosts/kernel-hook.ts submission-node.ts static-review.ts development-node.ts test-node.ts acceptance-node.ts review-node.ts deployment-node.ts deployment-exec.ts project-execution.ts merge-queue.ts acceptance.ts review.ts stop.ts loop.ts test/kernel-step4.test.ts
# types-final.jsonl：25 个受影响入口，affectedErrors=0、otherBaselineDiagnostics=0。
node /tmp/loop-step4-checks-kmykqT/types-check.mjs review-node.ts kernel-runtime.ts test/kernel-step4.test.ts
# types-proof-final.jsonl：最终释放证明增量，3 个入口及依赖 0 诊断。
node /tmp/loop-step3-checks-hWvPgT/lens-check.mjs development-card.ts node-ledger.ts kernel.ts kernel-workspace.ts kernel-session.ts kernel-runtime.ts kernel-cli.ts kernel-controls.ts kernel-pi.ts hosts/kernel-hook.ts submission-node.ts static-review.ts development-node.ts test-node.ts acceptance-node.ts review-node.ts deployment-node.ts deployment-exec.ts project-execution.ts merge-queue.ts acceptance.ts review.ts stop.ts loop.ts test/kernel-step4.test.ts
# lens-final.jsonl / .err：真实 LSP touchFile/collectDiagnostics 请求，非空缓存；禁安装，finally shutdown。
node /tmp/loop-step4-checks-kmykqT/lens-check.mjs review-node.ts test/kernel-step4.test.ts
# lens-proof-final.jsonl / .err：最终增量实际请求。
git diff --check
```

复用已安装 TypeScript/Node/Pi 类型，不安装/升级依赖。pi-lens 推断工程仍报缺 Node/Pi 类型的真实诊断，**不冒称 LSP 清零**；显式既有类型依赖的 strict 检查为 0。初次新增测试的可选断言说明参数及闭包可空类型错误分别保留于 `types-nodes.jsonl`、`types-current.jsonl`，均已修复。诊断脚本和 loader 的只读副本已保留在本证据根，便于复核。

### A11—A17 对应与断言边界

文档 A11—A17 对应本会话解析编号 A1—A7，顺序不变，未为保留文档编号改通用抽取器或原需求 A1—A10。

| 文档 / 会话 | 隔离程序依据 |
|---|---|
| A11 / A1 | 单任务真正发布/推 bare dev 后 cmd/check，各用实际压缩提交；CLI/Pi/Hook 重复接续不再部署；分支/历史可查，干净空间释放。 |
| A12 / A2 | 未安排不部署；部署无提交、非法配置/比较/多任务只评审在资源前拒绝；真实 bare hook 拒推时本地事实及 Git 原因保留，无部署/重推。 |
| A13 / A3 | cmd 失败及只重跑部署；check 失败、本地回退/重新部署/恢复失败；目标前进、脏源码、消费者未释放、超时、停止、写后还原均不回退。另验证已检查方法随回退切换到上一版，远端仍为发布提交。 |
| A14 / A4 | 实际进程屏障双向互斥、排队不占测试槽；排队/部署/check 停止，check 返回后停止和持久回退意图中断；直接改配置/卡暂停，恢复冻结输入后仅部署；发布前受控确认、发布后拒绝改卡。未知副作用不盲重做。 |
| A15 / A5 | 无必修、有必修/建议、格式失败三种报告；原用户文件/索引逐字不变，无开发/返修/测试/验收/提交/部署；正常释放。取证失败已释放可结束，缺证明/未知消费者保留。 |
| A16 / A6 | 非法输入资源前拒绝；分支后来移动仍固定原对象，同树换头拒绝；标准/文件/模型/目录变化使旧结论失效，需受控确认；普通/接受未验证合入拒绝，不判 Loop 外合入；查询不写迁移，有效通过报告复用。 |
| A17 / A7 | 上述当前单/多任务、普通/例外发布、真实旧账本、精确重验、三宿主替身适配及旧直接只评审/部署回归；节点未互相引用。 |

既有测试断言 **零删除、零修改**；只扩展 `test/fake-kernel-pi.mjs` 的可选重复 settle 场景，缺省行为不变。新增 `test/kernel-step4.test.ts`，包括 README 示例/帮助的实际解析行为。上述新夹具修正不是削弱旧断言；`test/e2e.mjs` 场景及断言零差异、未运行。新测试当前 43 个计数项以阶段完整集加最后两项定向增量覆盖，不声称最后重跑了全文件或全仓。

### 资源及中断收尾

各正常夹具在 finally 按自身临时根释放；消费者按随机 owner、PID 启动时间、run/task/attempt、Git common-dir 和登记路径核对。未知/脏目录反例验证产品保留，夹具只清自己的模拟资料。成功场景核对空本机队列、登记消费者结束、任务/批次/分离 worktree 删除，分支/ref/日志在运行中保留供断言。

两次工具总时限中断留下的样本，不按名字/年龄/PID 猜删：由 TAP 的 62290 / 69221、账本中相同 PID 的完整启动时间和 run UUID 反查，核对原仓库/本地 bare origin、随机进程 owner 及 Git 共用目录后，执行 `/tmp/loop-step4-checks-kmykqT/settle-interrupted.mjs`。两个 run：`d182f13b-9eba-46a9-b490-17d0df83e2af`、`5e9be967-6ba4-4755-9aef-4b32c200bd9e`。先保留原账本/失败材料及 candidate-history.bundle，再用统一放弃/停止按身份释放假宿主、全部 worktree/票据和资源，确认释放后只删除这两个已证明归属的临时根；不是清理旧开发工作区。`interrupted-release.log`、`interrupted-<run>/release.json` 和前后账本保留真实释放证明。最终 `final-consumer-check.json` 的精确本次标记匹配为 0；未杀同名进程、端口占用者或其他任务。

实际开发 worktree 是用户指定空间，仍保留；没有清理旧 worktree、历史资料、真实全局状态或用户 temp/。pi-lens 均 finally shutdown。证据根有意保留，临时测试运行空间/消费者已结清；没有未确认的本次测试消费者。

### 旧问题单相关部分逐项依据（只读对照，不关单）

只读核对桌面原单相关描述/边界，不回写或关闭它们；早年拟方案不覆盖本次权威内核需求，不把本步程序替身当原业务复现。

| 旧问题标题 | 本步依据与不冒领的范围 |
|---|---|
| 开工全量基线测试阻断批次启动 | 新卡在资源前只读校验，无隐含基线；A12/A16 与旧 gate 忽略回归保留。未重放原项目全量基线事故。 |
| 基线门禁报错难以定位 | 新节点各保留原始调用/命令日志和下一步，非法卡不半开工；不修原项目门禁脚本，也不补验旧开工诊断。 |
| 全量测试同时运行导致门禁假失败 | 保留卡命令、本机测试/验收槽；部署用另一项目执行边界，真实屏障证明不抢测试槽。不恢复旧 gate，也不声称手工全量负载已治理。 |
| 队列通过后合入仍重复评审 | 发布绑定原检查，重复部署/续跑/宿主回调不再评审或推送；旧同树、旧账本及多任务映射回归通过。原历史业务仍待核销。 |
| 自动评审完成提示与合入条件不一致 | 本地发布、远端记录、部署/回退、资源和只评审报告分别显示；不能用报告取得合入资格。真实通知体验/原业务请求配对未复演。 |
| 非产品失败阻断整批合入 | 部署失败不扣开发/测试/验收次数、不抹通过/发布；只评审有必修也不返修；前三步普通/真实用户例外回归保留。原环境/方法案例未实操。 |
| 批次已合入但状态仍显示运行中 | 状态按同账本活动；发布后停部署不隐藏，版本分列；只评审即使 head 在 dev 也不判已合入。旧外部合入只读识别回归通过，不批量改历史 running。 |
| 配置错误发现晚且暂停无通知 | 部署/比较合法性资源前拒绝，冻结变更在边界拦下，原因/日志/补救可查；不扩修浏览器、过期 guide 语义及项目准备缺口。 |
| 运行中改批次配置导致整批验收不启动 | 受控变更及相关输入投影保留；deployment 独立，直接改卡/配置不启动旧命令。原单 scope 扩大要求与当前冻结 scope 不同，本步不新增扩大 scope 能力或宣称旧事故修复。 |
| 合入队列锁在持有者释放瞬间误报身份不明 | 保留旧锁逻辑及旧部署等待边界回归；新项目租约用短锁/精确 token。未单独复现原 record/publish 瞬时锁窗口，不冒领本步修复。 |
| 启动命令截断导致流水线空等 | 保留 argv/精确会话与有界宿主确认；实际 CLI/Pi 替身及只评审独立 worker 通过。未操作真实 Terminal 或验证旧队列长命令业务。 |
| 门禁误把测试失败判为磁盘不足 | 分类器未改，当前测试节点 ENOSPC/冲突/未知定向回归保留；部署是部署失败，不转成开发产品返修。原 PA 事故未回放。 |
| 升级后缺少项目迁移提示 | 当前帮助/README/工具清单/运行维护同步，新卡旧格式拒绝与真实示例解析回归；不代迁接入项目、不更新真实插件/信任或做宿主采样。 |
| 验收超时丢弃已有证据 | 仅新增项目执行互斥包装，旧恢复/证据/预算定向回归通过；不实施原单独立报告预算、时长预估等内部余项，不称已解决。 |
| 验收演示数据写入真实状态目录 | 复用隔离夹具，所有本轮状态/通知/证据落私有临时根，按归属结清中断消费者。没有处理原历史污染记录，未据此验收其全部共用方法。 |
| 测试写死等待秒数在机器繁忙时误判失败 | 新用例以进程/文件屏障验证，不靠固定等待宣称并行；两次总检查时限中断如实保留并只补剩余。未改旧墙钟断言、未做禁止的双全量压力运行。 |
| 调用链排查遗漏子组件 | 本步核对卡→运行/会话→内核/账本/工作区、CLI/Pi/Hook 及旧执行复用边界；不扩为原业务准备流程或授权范围治理。 |
| 协调汇报反复要求用户决策 | 普通实现及自检直接推进，仅业务授权/未知外部副作用留人工；没有改项目模板/稳定规则，不当作本步产品修复。 |

### 分层交付结论

- **源码、自检**：上述两条产品路径、控制/查询/资源及受影响回归已实现并验证；没有全仓测试、真实模型业务验收、真实远端推送或真实部署。
- **独立静态评审**：待外层 Loop；开发自检不冒称独立评审通过。有必须修改仍在本原会话返修。
- **【必须修改】**：自检已发现项均已修复、失败反例闭环；当前没有已知未解决的必须修改。不把外部条件或未验业务当代码缺陷，也不降低用户标准制造通过。
- **【建议】**：后续可改善未知副作用的人工核对引导；本步不添加强制忽略/远端撤回策略，不阻断此次源码交付。
- **未验证**：真实 Pi/Claude/Codex 模型质量、实际宿主安装/信任装配、真实系统通知体验、真实部署/回退及远端状态、真实浏览器/后端/账号业务验收、Loop 自身 dev 自举发布。前三步原有未验项继续保留；本轮没有自行提交/发布授权。

### 第 4 步外层第 1 次评审返修

来源：本原会话收到的四项必须修改；外层记录的小问题本轮不处理。原工作区、分支、真实 HEAD 及提交/发布边界不变。以下更新覆盖初次交付时“无已知未解决必须项”的时态，不改写之前失败日志或前三步历史。

- **第 1 条：已修。** `deployManaged()` 区分首次自动接续、已有终态复用和明确单节点重跑。Pi/Hook 重复回调、普通续跑与已发布合入不再重做已失败命令；成功仍复用，未知副作用仍拒绝。只有 `重跑 --node 部署` 派发绑定上一尝试 ID 的重跑意图，前台/后台 worker 均传递该身份；`deployment-node.ts` 在登记新尝试的同一账本短锁再核对原 ID/控制身份，防止迟到或重复意图重做，并以 `retryOf` 留史。测试中 cmd 先记录外部操作再退出 1，Pi 重复 settle 和两类 Hook 重复 Stop 都只执行一次；合入/普通续跑不重做，明确后台重跑才新增一次，前置检查及发布记录不变。
- **第 2 条：已修。** 宿主监督器读同一份批次快照，再投影任务状态；收尾同时核对任务活动、批次活动，以及已安排且推送成功的部署是否已结束。提交到部署登记之间的安全接续空隙也不提前停宿主。新增真实双 Pi 宿主/测试/统一验收/推 bare dev 后的部署屏障：最后一个任务承载批次部署，部署进程产生跨越 500ms 监督器轮询的 1500ms 检查点，核对批次执行 PID 对应原 session、原进程组及监督器仍存活，放开屏障后 cmd/check 成功才释放全部空间。不是用任务 activity 为空推断批次无活动。
- **第 3 条：已修。** `createChildExec` 明确记录 `processStarted`：不存在的程序保留 ENOENT 原文，明确未启动时没有消费者，可提供已释放证明；已启动或证据未知不据空登记补通过。共享静态调用把执行/租约等待纳入本次剩余时限，以结构化失败保留释放/可重试事实；未知释放立即结束自动重试，不能申请自己留下的 blocked 租约继续等待。项目租约遇 blocked 明确拒绝并保留原 token/登记，不自动删除。只评审报告保留真实调用原文及没验证终态。三条真实执行反例覆盖“程序不存在（最多两次有界调用，无 blocked）”“程序确实启动、返回时模拟丢释放证明”“实际执行后抛错丢失回执”；后两者只调用一次，未知租约逐字保留，目录/结论不洗白。
- **第 4 条：已修。** 发布后路径不再读取任务级测试/验收返修状态，`postNode` 分支不会调用 `taskDefinition(batch)`。含测试的多任务批次部署失败后，普通续跑只返回原失败；批次级 `重跑 --node 部署` 可用，成功后两种重复入口均只复用。测试冻结原任务候选/次数/测试/验收/提交结果及 publication，核对全部不变，并用 bare origin 的真实 pre-receive 记录证明只推送一次。多任务覆盖还发现 `nodeCheckLines` 把部署误作任务身份、导致含部署的多任务卡创建/查询报错，已按同一批次级身份修复；这是四项必修的实际入口阻断，不是扩修小问题。

#### 本轮命令、原始失败与闭环

证据根 `/tmp/loop-step4-review1-uasQGd/`；全部 Git/bare origin、假宿主/模型、部署产物及状态仍在各自系统临时根。不调用真实业务模型/浏览器/后端，不嵌套真实开发或评审 Agent。

```bash
LOOP_STEP4_REVIEW1_EVIDENCE=/tmp/loop-step4-review1-uasQGd/reproduce-evidence node --test test/kernel-step4-review1.test.ts
# reproduce.log：首轮新夹具单任务重复空提交的设置错误；同时暴露多任务部署展示身份错误和第 3 条超时自等待，原始失败保留。
LOOP_STEP4_REVIEW1_EVIDENCE=/tmp/loop-step4-review1-uasQGd/reproduce2-evidence node --test --test-name-pattern='第1条|第2条|第4条' test/kernel-step4-review1.test.ts
# reproduce2.log：修正夹具及必要的展示身份后，实际复现重复部署、监督器提前结束承载者、发布后两个批次命令均报 taskDefinition 错误。
LOOP_STEP4_REVIEW1_EVIDENCE=/tmp/loop-step4-review1-uasQGd/fix124-evidence node --test --test-name-pattern='第1条|第2条|第4条' test/kernel-step4-review1.test.ts
# fix124.log：6/6。
LOOP_STEP4_REVIEW1_EVIDENCE=/tmp/loop-step4-review1-uasQGd/fix3-evidence node --test --test-name-pattern='第3条' test/kernel-step4-review1.test.ts
# fix3.log：4/4。
LOOP_STEP4_REVIEW1_EVIDENCE=/tmp/loop-step4-review1-uasQGd/final-evidence node --test test/kernel-step4-review1.test.ts
# review1-final.log：10/10；随后增加一项内存替身显式释放失败的兼容反例，当前文件共 11 个计数项，按后续增量验证。
node --test test/kernel-step4.test.ts
# step4-regression.log：43/43。
node --test --test-concurrency=1 test/review.test.ts test/procs.test.ts test/hook-process.test.ts test/recipes.test.ts
# shared-review-regression.log：52/56；仅旧 Hook 验收 cleanup 三个信号及其父用例失败：测试进程继承外层 AUTOREVIEW_SINGLE_NODE=1，验收本就未安排。未改断言或生产行为。
env -u AUTOREVIEW_SINGLE_NODE node --test --test-name-pattern='Hook 验收中收到可捕获信号' test/hook-process.test.ts
# hook-cleanup-isolated.log：4/4，按旧兼容场景清除单会话身份后实际执行验收/cleanup。
env -u AUTOREVIEW_SINGLE_NODE node --test --test-name-pattern='真实 bin/loop|新卡会话空闲|非受管|新单会话|新卡无需|旧账本|目标前进产生未检查树' test/kernel.test.ts
# kernel-targeted.log：7/7。
env -u AUTOREVIEW_SINGLE_NODE node --test --test-name-pattern='A5：真实两个宿主|A6：只退甲|真实旧指纹' test/kernel-batch.test.ts
# batch-targeted.log：3/3，真实双宿主、精确重验和真实旧账本保留。
env -u AUTOREVIEW_SINGLE_NODE node --test --test-name-pattern='旧单会话保护|没有释放证明' test/kernel.test.ts
# legacy-pi-proof.log：初检 1/2，纯内存评审替身未声明消费者事实；明确声明“未启动、无消费者”后 legacy-pi-proof-fixed.log 2/2。
env -u AUTOREVIEW_SINGLE_NODE node --test --test-name-pattern='G17 Ponytail|配置核对 A6/A7' test/autoreview-delivery.test.ts
# pi-mock-regression.log：5/6，内存替身抛异常同样缺已知未启动证明；未通过清除未知租约放行。
env -u AUTOREVIEW_SINGLE_NODE node --test --test-name-pattern='配置核对 A6/A7' test/autoreview-delivery.test.ts
# pi-mock-error-fixed.log：1/1，声明内存异常未启动且保留原异常类别/全文后，原后续完成及历史证据断言通过。
LOOP_STEP4_REVIEW1_EVIDENCE=/tmp/loop-step4-review1-uasQGd/proof-evidence node --test --test-name-pattern='第2条|第3条' test/kernel-step4-review1.test.ts
# proof-compat-final.log：6/6，最终屏障与已知/未知释放、内存显式释放失败。
LOOP_STEP4_REVIEW1_EVIDENCE=/tmp/loop-step4-review1-uasQGd/proof-final-evidence node --test --test-name-pattern='第3条' test/kernel-step4-review1.test.ts
# retry-proof-final.log：5/5，最后明确异常证明传递的增量复核。
node /tmp/loop-step4-checks-kmykqT/types-check.mjs kernel-session.ts kernel-runtime.ts kernel.ts git.ts static-review.ts project-execution.ts review-node.ts deployment-node.ts node-ledger.ts hosts/review-hook.ts test/kernel-step4-review1.test.ts test/helpers/autoreview-fixture.ts
# types-delivery.jsonl：12 个受影响入口及依赖 0 诊断，otherBaselineDiagnostics=0。
node /tmp/loop-step4-checks-kmykqT/lens-check.mjs kernel-session.ts kernel-runtime.ts kernel.ts git.ts static-review.ts project-execution.ts review-node.ts deployment-node.ts node-ledger.ts hosts/review-hook.ts test/kernel-step4-review1.test.ts
node /tmp/loop-step4-checks-kmykqT/lens-check.mjs static-review.ts test/helpers/autoreview-fixture.ts
# lens-final / lens-proof-final：实际 LSP touchFile/collectDiagnostics，禁安装，finally shutdown；推断工程缺 Node/Pi 类型的诊断仍保留，不称空缓存或 LSP 清零。
git diff --check
```

没有删除、跳过或放宽既有测试断言；新增 `test/kernel-step4-review1.test.ts`，复用既有 fixture/假宿主/假验收方。`test/helpers/autoreview-fixture.ts` 仅为**纯内存**模型回执/异常明确声明没有启动进程，显式 `processesReleased:false` 或结构化未知异常原样保留；真实命令仍走原 externalExec/createChildExec，不能由该默认值补造释放。本轮新增专门反例验证显式失败仍暂停且只调用一次，未通过改生产保护迁就夹具。`test/e2e.mjs` 零修改、未运行。

#### 资源和分层结论

新夹具的正常及失败路径先按原登记停止，再核对 launch/supervisor/worker 随机 owner/PID 启动时间和命令 procs，确认实际消费者结束后才清自己的临时根；原账本、命令输出、部署屏障/原宿主检查点及 `release-proof.json` 保存在本证据根的各 `*-evidence/<run>/`。未知释放反例故意保留产品的 blocked/未确认记录，夹具用原真实执行器已释放的独立观察证明模拟丢回执；不会修改产品账本把它补成通过。初始化失败的临时资料不按名字/年龄猜删；初始化阶段尚未派发消费者。没有清理旧 worktree 或用户 temp/，没有操作真实部署配置、真实 dev、真实远端或全局权限。所有实际启动的本轮消费者按登记结清，LSP 服务均 shutdown。最终 `final-release-check.json` 核对 7 份新收尾证明及相应临时根已移除，本工作树精确启动标记的剩余消费者为 0；逻辑未知反例仍保持未确认记录，不冒充产品已恢复。

【必须修改】四条均已修复并完成上述程序验证；待外层复审，不自行宣布独立评审通过。

【建议】本轮外层明确无需处理的小问题未实施；原建议及未知副作用人工核对边界保留。

未验证项不变：真实模型质量、实际宿主安装/信任与业务装配、真实通知体验、真实远端/部署/回退、真实账号/浏览器/后端业务验收、Loop 自身 dev 自举发布；前三步原有未验项继续保留。未提交、推送或发布真实仓库。

### 第 4 步外层第 2 次评审返修

来源：本原会话收到的唯一必须修改；本轮小问题不处理。工作目录、分支和真实 HEAD 仍与本页开头相同，未提交或发布。本节是第 1 次返修之后的新事实，不将此前“待复审”改成已经独立评审通过。

**第 1 条：已修。** 真实进程反例确认该静态推断：旧 Pi 的 `wrappedExec()` 在生命周期取消后丢弃已经返回的执行回执，导致静态调用把“旧结论失效”误当成“消费者释放未知”。只修改适配层的回执传递：

- 执行器尚未被调用时已取消，明确没有本次新消费者，以结构化失败记录这一事实，不继续执行或重试。
- 执行器返回后才发现生命周期/输入已撤销，仍抛错阻止旧结果进入结论；同时通过既有 `ReviewerCallFailure` 携带严格的 `res.processesReleased === true` 事实，`retryable:false`。确认释放只用于归还本次租约，绝不授予旧结论资格。
- 没有回执的执行异常、缺少或否定的释放证明仍为未知。没有修改项目租约的 blocked 保留/回收规则，没有调用恢复清理去“洗白”未知，没有删除真实历史租约，也没有扩大或迁移旧结论。
- 运行维护说明同步这一区分；原用户标准、授权、稳定规则、前三步历史和本轮小问题均未修改。

#### 实际验证、原始失败和结果

证据根 `/tmp/loop-step4-review2-YENOsv/`。新增 `test/kernel-step4-review2.test.ts` 复用既有 Pi 事件夹具及真实 `createChildExec`；模型是普通 Node 脚本替身，不启动真实 Agent。所有 HOME、Git、资源、模型脚本和通知配置都在各自系统临时根；清除外层受管身份，明确按旧单会话开发评审行为验证。

真实进程屏障先确认模型进程已启动、随机 owner 与 `.procs.json` 相同、启动时间/进程组可核对且实际存活，并确认组合评审和静态调用的两个读租约都在。分别在评审中更新标准、quit、reload；观察执行器真实回执 `processesReleased:true` 和原进程组已结束，再验证旧结论没有通过、没有产品返修、关闭后旧任务不调用 Pi/ctx。正常取消的租约归零，同项目部署互斥边界可取得并归还（**没有执行部署命令**），原会话恢复后第二次评审成功；更新标准的第二次输入明确是当前第 2 版，用户 HEAD/未提交文件不被自动提交或改写。

另两项反例在真实命令已结束后模拟调用方丢失/否定释放回执：即使进程登记为空，产品仍保存 blocked；再次 `/review` 不调用模型，租约 token/内容不变。真实原始回执单独留证，不拿夹具观察到的物理结束去伪造产品已经收到证明。

```bash
LOOP_STEP4_REVIEW2_EVIDENCE=/tmp/loop-step4-review2-YENOsv/reproduce-evidence node --test test/kernel-step4-review2.test.ts
# reproduce.log：2/5；三个“实际已释放”的取消场景按原断言失败，两个未知保护反例通过。每例原回执/租约、输入及状态材料保留。
LOOP_STEP4_REVIEW2_EVIDENCE=/tmp/loop-step4-review2-YENOsv/fixed-evidence node --test test/kernel-step4-review2.test.ts
# fixed.log：5/5；未改弱反例或断言。
env -u AUTOREVIEW_SINGLE_NODE node --test --test-name-pattern='G8 B7|总结关闭边界|G7 B6|G9 无标记|手动评审基线' test/autoreview.test.ts
# lifecycle-regression.log：18/18，旧关闭、UI 能力撤销、手动/自动评审和异常收尾保留。
env -u AUTOREVIEW_SINGLE_NODE node --test --test-name-pattern='done 接受新来源|检查中修改上级配置' test/autoreview-sources.test.ts
# input-regression.log：7/7，标准/授权与配置失效保护不变。
node --test --test-name-pattern='第3条' test/kernel-step4-review1.test.ts
# unknown-proof-regression.log：5/5，第 1 次返修的明确未启动/未知释放、blocked 保护及内存显式失败继续有效。
node /tmp/loop-step4-checks-kmykqT/types-check.mjs autoreview.ts test/kernel-step4-review2.test.ts
# types.jsonl：ES2023 工具配置不包含既有 Promise.withResolvers，两个库级诊断原样保留；没有改产品代码回避。
node /tmp/loop-step4-review2-YENOsv/types-check.mjs autoreview.ts test/kernel-step4-review2.test.ts
# types-es2024.jsonl：按实际 Node v22.23.1 及已有 Promise.withResolvers 的 ES2024 API 检查，strict affectedErrors=0、otherBaselineDiagnostics=0；TypeScript 5.9.3 为已安装版本。仅在系统临时根调整验证脚本，未改项目/全局配置，未安装/升级依赖。
node /tmp/loop-step4-checks-kmykqT/lens-check.mjs autoreview.ts test/kernel-step4-review2.test.ts
# lens.jsonl / lens.err：真实 LSP touchFile/collectDiagnostics，禁安装并 finally shutdown；原推断工程缺 Node/Pi 类型的诊断不冒称清零，不用空缓存报告通过。
git diff --check
```

旧测试/夹具断言零修改、零删除，本轮只新增上述反例并改 `autoreview.ts` 的生命周期回执适配；`static-review.ts`、`project-execution.ts`、提交/部署节点及第 1 次返修行为本轮没有修改。受影响检查通过后未重复扩大到全仓或真实业务；`test/e2e.mjs` 零修改、未运行。

#### 资源与分层交付

各场景先取消其原任务并等待真实执行回执，再按原 owner/PID 启动时间确认进程组结束、登记消费者为空、租约已正常归还或明确保留 blocked。`reproduce-evidence/` 和 `fixed-evidence/` 保存输入、真实回执、原状态/报告与 `release-proof.json`；负例的逻辑未知仍保留在证据中，实际夹具消费者由真实执行器确认结束后，才删除自身临时根。没有按名称、年龄、端口或裸 PID 猜测清理，没有清理其他 worktree、用户 temp/ 或真实全局状态。最终 `final-release-check.json` 按原随机 owner/启动时间复核五组实际消费者已结束、五个夹具根已释放；负例的逻辑 blocked 仍保留在证据中，未补造产品恢复。LSP 服务已 shutdown。

【必须修改】本轮唯一项已修并完成上述真实进程与定向程序验证，待外层复审；不自行宣告独立评审通过。

【建议】本轮明确无需处理的小问题未实施。

未验证项沿用：真实 Pi/Claude/Codex 模型业务质量、实际宿主安装/信任及业务装配、真实系统通知体验、真实远端/部署/回退、真实账号/浏览器/后端业务验收、Loop 自身 dev 自举发布；前三步未验项不变。本轮没有真实 add/commit/stash/reset/merge/push 或部署。

## 前三步历史记录（保留原时态）

第三步历史记录中的阶段：**外层第 2 次评审的一条必须修改已返修并完成程序验证，待外层复审**（不是独立评审通过、业务验收通过或真实发布）。最新记录见下文「第 2 次评审返修」，第 1 次三项返修保留；此前首次交付记录保留原始时态。本开发会话收到本页关联提示词后在 `step3` 实施；前台准备/启动的历史原样保留，不把准备记录当产品交付。2026-11-06 用户要求开始第三步、分支为 `step3`，由协调方写好方案与 Loop 任务并在可见终端前台启动。下文第三步方案是当时执行依据；后面的第一、二步章节保留历史，不再代表当前进度或本次授权。

前两步发布事实：第一步 `f014331`、第二步 `d8408fa` 的成果已压缩合入 `dev` 的 `b97e154`，真实 origin/dev 推送和本次发布 worktree 释放有记录；第二步外层第 4 轮静态评审通过、无必须修改。发布卡按用户接受未验证处理，没有伪造本卡开发评审/测试结论。完整“新卡启动真实开发至普通自动合入”及第二步真实业务验收仍未验证，不在第三步准备中补记通过。证据：`/Users/Admin/.pi-autoreview/deployments/loop-kernel-step2-20261106-92fe5a24/plan.json` 及其中账本/检查日志。

权威需求只读：`/Users/Admin/Desktop/loop/issues/【req】Loop内核与节点编排.md`。本次唯一任务文件：[第 3 步提示词](prompt/提示词-Loop内核与节点编排-3并行与统一验收.md)。用户的五步名称、顺序和验收原文不改；第四、五步不提前实施。

## 第 5 步已确认补充：新卡单任务与多任务的流程衔接、Pi 状态及检查保护

用户于 2026-11-07 先要求将默认可见 Pi 窗口和 gate 提示刷屏放到第五步，随后加入自动衔接、持续状态显示及构建误中断，并明确将产品智能体“Word通知修复”调查中的必修和建议一并纳入。该卡只有一个任务，已证明影响范围不能限定为批次并行：共用缺口覆盖新开发卡的单任务与多任务；多任务另需覆盖成果汇入及返修投递。Loop 自身重构使用的旧单会话自动评审正常，不能证明新卡入口完整可用。第四步按原任务继续；本节只登记第五步范围与完成条件，不代表修复已实施或验证通过。第五步实施方须将本节全部必修和建议纳入该步方案与任务提示词，保留五步顺序及发现分级。

### 必须修改

1. **恢复默认可见、可交互的 Pi 窗口。** 正常启动 Pi 开发批次时，每个被启动的开发任务打开独立 Pi 终端窗口，能看到执行过程并输入补充要求；不能因为是多任务而默认添加 `-p` 改为非交互执行。只有明确选择后台运行时才不显示窗口。续跑沿用原任务、工作区和会话，保留既有 auto 模式及权限边界；核对已有活动身份，避免重复派工。窗口启动失败须明确报告，不静默改为后台。此要求针对开发任务，不给只评审卡增加开发会话。
2. **消除旧 gate 提示持续刷屏。** 配置解析继续忽略旧 `gate`，但不直接打印弃用提示；如需提醒，由批次启动入口统一输出，同一次批次运行最多一次。轮询、子任务、续跑和状态查询不重复输出。保留输入变化检查及调度保护，不通过关闭检查、删改用户配置或恢复 gate 测试来消除刷屏。
3. **恢复新卡单任务与多任务在 Pi 中的持续流程显示。** 复用内核同一份账本，在任务窗口持续显示当前任务、节点、轮次、排队、返修、暂停原因及完成结果；评审开始即明确显示，外部节点 worker 推进也须同步到原窗口。不能只在启动、手动查询或整段调用结束时通知一次，不能用开窗或进程存在代替流程可见。区分当前任务与整批状态，排队不显示正在执行，一个任务停下不把其他活动任务显示成全批暂停；`stopped=false` 或 Pi 窗口仍存活不代表节点正在执行，无活动时明确停点。沿用现有查询来源，不另造一套状态。源码依据：`autoreview.ts` 的内核分流及旧 `setStatus`、`kernel-pi.ts` 的 `show` 与事件处理。
4. **补齐交付、返修和续跑后的自动衔接。** 不再以“没有末行完成标记且没有未提交改动”直接推断本任务无需推进；结合当前候选、交付上下文及必需节点有效结论，决定进入评审、接续测试或等待统一验收。覆盖完成标记放在回复开头、候选已由程序提交而工作区干净、恢复后没有新增改动但仍欠检查的情形；未识别或不能安全推进时明确显示原因与下一步，不能静默结束。保留“需要你决定”、停止、普通讨论及真实用户补充要求的边界，不能把正文任意出现标记当成授权。Pi 与 `hosts/kernel-hook.ts` 的相同跳过逻辑一起核对；返修仍回原会话，不重复派工、不清零次数、不重跑仍有效的检查。此缺口直接阻断新卡的自动检查，不能留到第五步交付之后。
5. **解决正常构建及缓存产物被当作候选修改而中断。** 卡上测试包含构建或运行时缓存写入时，应能生成受控产物并完成原测试命令；同时覆盖 Node 构建与 Python `__pycache__/*.pyc`，不只修某个项目的 `dist`。核对 `test-node.ts` 的实际执行目录、`kernel.ts` 的文件/索引监听及 `kernel-workspace.ts` 的前后校验，明确区分受控构建/缓存写入与源码、索引、标准或授权变化；后者仍使结果失效。现有保护也会检查 Git 已忽略文件，不能把“已加入 .gitignore”当作已经解决；也不能笼统豁免全部忽略文件。复用并保留已有只读 Git 的 `GIT_OPTIONAL_LOCKS=0` 修复。若采用隔离检查目录，须真正接入卡上命令执行并绑定当前候选、输入、证据与资源释放，不能只留下提案；不能仅关监听或降低保护来制造通过。已有 PA 构建中断记录，以及 Word 单任务中测试启动后约 64 毫秒写入 `.pyc`、再约 52 毫秒被中断的记录；Word 缓存已被 Git 忽略，检查时源码/暂存区无差异、HEAD 与登记候选一致，但当时日志未保留触发路径，唯一触发事件仍未复现确认。两者不能记为产品断言失败；单个项目后来改用隔离命令通过，也不能冒充内核共用问题已修复。这一执行缺口直接阻断卡上测试及后续验收。
6. **明确检查中断后的处理与停点。** 核对 `executeNode → finishAttempt → advanceManaged → kernelPi`：当前取消原因会被通用“旧结果失效”覆盖，再以 `stale` 直接返回。正常受控产物不应触发这条中断路径；真正发生候选/输入变化、用户停止或资源未释放时，继续拒绝旧结果，明确显示哪个节点停下、为什么及可执行的下一步，不能静默闲置或把窗口仍开着显示成继续推进。可恢复的环境失败按已有额度和授权处理，不清零次数；真实停止或过期结果不得为实现自动接续而重放动作。此项与第 3、5 项一起处理，避免只改显示或只让一次测试跑过，却仍留下一停就无提示的流程缺口。

### 建议（已纳入第五步安排，保留非核心阻断项分级）

1. **保留中断的具体触发证据。** 在现有尝试记录中保留触发文件/索引路径、事件时间、原始取消原因及候选/输入有效性判断；无法取得的字段明确记未知。`finishAttempt` 的旧结果保护结论与原始原因分别保留，不能只剩“候选、输入、停止状态或尝试代次变化”而丢失定位线索。复用已有日志与账本，不另建诊断系统。
2. **修正 gate 提示及单任务/批次文案。** 如保留 gate 提醒，应准确表述为“旧 gate 配置已停用；新卡仍按 flow 执行显式测试”，不能继续笼统宣称“Loop 不运行项目测试”。共用通知按实际对象区分单任务与批次，避免多任务仍写“Loop 单任务”。去重要求仍按必修第 2 项执行，不恢复 gate 或要求用户删配置。

### 实施顺序与完成条件

- 先核对、复用已有启动、窗口及只读 Git 补丁，按差异整合，保护各工作区已有成果；接入第四步成果时保留本节新增要求，不能被该工作区的旧版第五步文字覆盖。完成上述六项必修并验证新卡单任务与多任务入口可用后，再按用户确认的删除清单清理旧路径。两项建议同批安排并逐项报告完成或未完成，不混成核心功能阻断。旧工作目录仍逐个核对归属和成果、另行确认清理。
- 复用受影响定向测试：配置重复解析零提示；一次批次运行最多一条弃用提醒；默认可见启动与显式后台分别走正确路径；续跑保持原会话且不重复派工。原“重复解析产生多条警告”的断言须按本次要求修改并说明原因，不弱化输入变化、权限及资源保护断言。
- 补足宿主适配边界的定向覆盖，不能仅直接调用 `completeManagedDelivery` 证明自动触发可用：完成标记在开头、无新增改动且检查未完、原会话返修、停止/续跑、有效结论复用、普通讨论不误触发；断言持续状态随节点及外部 worker 变化，不能将 `notify/setStatus` 空实现视作显示验证。按实际影响同步 Pi 与 Hook 的共同判断测试。
- 检查保护须同时覆盖正反例：正常构建及 Git 已忽略的 Python 缓存写入后继续完成卡上测试；真实源码、索引或输入变化仍中断；取消、消费者未释放或证据失效不得记通过。确认中断后显示真实停点与下一步，停止不重放、恢复不清零次数；诊断记录保留原始原因与可取得的触发路径。保持卡上原测试范围，不用删构建、删断言、改成无测试或放宽标准掩盖问题。
- 第五步交付前分别检查正常入口启动的单任务新卡和多任务 Pi 批次：前者按自身 flow 完成开发、评审/返修及测试；后者各开发任务窗口可见、可输入补充要求，能看到“开发 → 评审／原会话返修 → 测试 → 汇入 → 统一验收”的实际进展。两者都覆盖无新增改动但欠检查时正常接续、中断后沿原任务和会话恢复、计数及证据保留、外部节点进展同步到窗口；不为单任务暗加未安排的验收或提交。保留旧 `gate` 的配置持续运行时不刷屏，状态查询及续跑不重复提示，提示语不否认新卡显式测试；显式后台运行不自动弹窗。
- 程序检查、实际窗口体验与业务结果分别报告。仅证明命令可解析、进程存在、模型在底层运行或替身测试通过，不等于完整批次体验通过；未实际核对时写“未验证”，对应项继续保留为第五步未完成项。PA 任务基础已有的产品必须修改单列，不能混作 Loop 缺陷或因本次修复而视为通过。

## 第 3 步实施方案

### 目标与实施方式

本步把已可用的单任务路径扩展成多个任务各自开发、统一验收的批次。完成标志是两个任务真正并行、先完成者先汇入，只有责任任务收到验收返修，同轮全部返修汇入后按已确认范围重验，最终发布资格与证据一致。不是只增加 tasks 数组解析或模拟“并行”状态。

开发工作区 `/Users/Admin/.pi-autoreview/worktrees/loop-kernel-step3`，分支 `step3`，从已提交 dev `b97e154` 建出。外层仍用 `/Users/Admin/Desktop/loop/bin/loop 开发 pi` 加载桌面已发布 `autoreview.ts`；开发中的 step3 代码只在隔离夹具内运行，不负责评审自己。桌面未提交修改和前两步工作区只读。只复制原 `.autoreview.json`，旧 gate 仍忽略，不恢复全量测试。

本轮已授权第三步开发及必要定向检查，先核对本方案后直接实施；每批最小充分自检通过即继续，外层 Loop 在交付时独立静态评审并回原会话返修。无需为普通实现选择重复请示。遇到真实业务取舍、越出本步权限或无法安全解释的来源才停下说明，不把可延期建议升级为前置门槛。

### 1. 源码依据与最小改动位置

| 已核对的第二步实现 | 第三步改动 |
|---|---|
| `DevelopmentCard.tasks` 为单元素 tuple，解析器拒绝验收/多任务 | 扩为任务列表和验收标准引用；先做底线与全部输入校验 |
| `KernelRun` 顶层只有一套候选、worktree、session/activity、repair/计数；`validResult` 直接用 tasks[0] | 一份批次账本内保存显式任务记录与独立批次状态；全部调用者传任务身份，不能只扩大数组 |
| `completeManagedDelivery → advanceManaged → mergeManaged` 直接发布单任务 | 任务就绪先进入批次集成，所有任务就绪才验收，再按 flow 提交 |
| `local-node-queue.ts` 已有全本机 FIFO、身份与释放检查 | 测试/验收共用同一槽，不创建第二个验收队列 |
| `pipeline.ts/dispatchBatches` 同仓库串行，`routeFailures` 已有归属分组逻辑 | 复用或抽出归属纯函数；不把旧串行调度当作新并行实现 |
| `acceptance.ts/runAcceptanceStage` 会在定向复验成功后追加 full；内部仅保留旧通过项 | 新节点复用单轮执行能力，显式传实测/沿用集合，按责任任务纳入原已通过项，移除新卡路径的额外 full |
| `submission-node.ts` 以单候选核对全部前置节点、压缩与 CAS 发布 | 绑定批次树和各任务的检查/集成来源映射，保留 dev 保护及发布后结论展示 |

主要落点：`development-card.ts`、`node-ledger.ts`、`kernel.ts`、`kernel-workspace.ts`、`kernel-session.ts`、`kernel-runtime.ts`、`kernel-controls.ts`、`kernel-cli.ts`、`kernel-pi.ts`、`hosts/kernel-hook.ts`、`hosts/dev.ts` 及必要共享能力。可新增职责单一的 `batch-integration.ts` 与 `acceptance-node.ts`。验收内部仅抽本步必要接缝，旧入口保留行为直到第五步；不把旧 pipeline/review 组合层套进新节点。

### 2. 卡、身份与旧记录兼容

保留 version:1，新增 `acceptance` 字符串相对路径，继续用 `flow` 声明固定顺序。单任务保留四种现有组合且可选验收；两任务及以上必须带验收。仅开发性质，本步不开放部署、只评审或纯测试性质。

标准沿用 `## 验收标准` 的 A 编号与 `[任务名]`。每条非人工项必须唯一归属存在的任务；授权项同时保留真实授权检查；跨任务条目必须指定一个责任任务。共享既有标签/条目解析，但补足启动时的缺归属、未知归属、多义归属拒绝，不能由模型推断归属。范围、提示词、标准、Git 分支、localFiles、配置和路径全部通过后才建资源。验收运行配置复用项目 acceptance，标准和顺序由卡明确指定；缺少必要方法要给具体诊断，不回退旧隐含验收。

建议账本由批次记录和按稳定 ID 索引的任务记录组成；显示名不是唯一运行身份。每个任务保留自身 branch/worktree/candidate、session/activity、输入/用户版本、尝试、计数、返修信封和释放状态。批次保存共同 base、汇总 branch/worktree、集成清单、验收轮次/返修集合、控制代次、发布绑定与释放。任务节点通过小型上下文选中本任务，不创建“伪造的另一个批次账本”。新增必要类型即可，避免通用层。

旧单任务账本按内存兼容视图读为一任务，只有明确写操作才做必要升级；查询不写迁移，不伪造新版结论。现有单任务 API 的默认任务只能用于确实只有一个任务的记录；多任务未指定身份应明确拒绝。停止某任务不把全批 stopped 置真；整批停止/放弃才影响全体。

### 3. 并行、贡献与批次汇入

全部任务从冻结共同基线开独立任务分支/隐藏目录并各自启动宿主。优先复用现有 argv 启动、进程登记、原会话恢复和返修通道。开发会话可以同时活动；开发评审不占测试/验收槽，测试和验收只有实际获得本机槽时才启动 deadline。

任务完成卡上前置节点后马上提交内核的集成请求。集成按实际就绪顺序短暂串行；不把所有任务串行化。每次记录 task ID、任务候选/树、基线、相关输入、检查记录 ID、集成前后头/树、来源路径和顺序。CAS + 意图记录处理重复回调、崩溃恢复及并发提交，不在账本短锁中等待模型或长任务。

集成只组合已检查的任务贡献，不编辑产品文件解决冲突。冲突退回本次请求任务原会话，带批次已纳入来源和冲突清单；其余任务继续，验收返修次数不变。开发方解决后重新提交/评审/测试。原 scope 与可证明来源保护要继续有效。

关键约束：替换某任务候选或移出任务时必须消除旧贡献，不能把新头简单 merge 上去就算替换。以冻结基线和保留任务最新贡献重新组成候选，并保存旧批次 ref；任务为处理冲突吸收的其他任务来源必须登记，不能在移出甲后通过乙的历史把甲重新带回。用已有 Git 树/私有索引能力表达来源，无法证明安全时停具体任务，不静默丢数据。单任务可沿用现有目录作为批次候选，不为形式额外创建无用目录。

任务评审/测试结论绑定其实际受测树；批次统一验收绑定集成树，附全部任务候选映射。不能要求两者树字面相同，也不能用“合并无冲突”冒充批次验收通过。原未变任务结论沿用的依据是来源映射和输入仍一致。

### 4. 单轮验收与同轮返修

`acceptance-node.ts` 只运行验收并返回统一结果和条目记录；节点不派返修、不读 ReviewState、不调用提交。内核在全部当前任务的有效候选已汇入且无在途改动时冻结一轮：batch candidate、任务映射、标准/授权哈希、轮次、实测条目与沿用条目，然后竞争本机槽。

从 `acceptance.ts` 提取或增加新卡专用的单轮接缝；保留模型调用、报告校正、证据、被测系统资源收尾、人工/授权处理。新路径不调用“定向后完整验收”包装，传入的实测集合也不能再被内部“旧通过项全部沿用”缩小。旧路径到第五步前继续保持自己的接口。

初次验收覆盖当前全部自动条目。产品失败只按失败条目责任任务派发；无归属的运行系统故障按已确认失败分类停验收，不随便归给所有开发方。每条回发绑定 task/session/attempt/候选/版本/随机 token，仅发该任务的条目和证据；sent/read/unknown 保持区分。

本轮返修集合一经冻结，等待集合内全部任务重新开发评审、测试并汇入，才创建下一轮。不为每个返修返回单独验一次。下一轮实测集合严格为“不通过项 + 返修任务名下全部项”；未返修任务的通过项沿用原树/轮次/证据并写明原因，且核对其候选来源、标准、授权、相关方法输入没有变化。缺证据或输入变更不能补造通过，按真实缺项处理。

定向重验通过后不在提交前追加完整验收。用户已明确接受可能漏掉被其他任务返修破坏的旧通过项，这不是实现者增设门槛的理由。环境/方法/未知只做有限恢复，不扣产品次数、不发产品返修、不推翻前面有效结论；仍失败则保留原轮次范围，通知只重跑验收/合法改卡/放弃的完整命令。

验收缺省时限沿用现有 20 分钟，独立 maxRepairs=3、maxRecoveries=1。产品返修按责任任务计数，记录全批实测轮次但不把它当共享返修扣款；恢复、重试、校正、收尾共用本轮剩余 deadline，排队不计时。暂停/续跑/改卡不清零；超时、取消、消费者未释放或非开发节点写源码不能记产品失败或通过。

### 5. 上限选择、移出和受控改卡

达到某任务验收返修上限时，只让该任务等用户决定；通知列出继续修、移出任务、整批放弃，不能代选。继续修通过受控改卡提高该任务验收额度，保留旧计数和其他任务额度；建议最小字段为 `tasks[].limits.验收.maxRepairs`，其他限额仍继承批次节点缺省。实现可用同等简洁方式，但必须在卡、命令、帮助和测试中一致。

扩展现有重跑/续跑/停止的 `--task`，验收重跑是批次级，不接受误导的任务级验收执行。`改卡 --remove-task <名>` 复用第二步真实用户决定、pending/prepared/applied 与下一边界生效机制。移出先保存成果和证据、停该任务并确认资源，再重建剩余候选；原标准不删写，移出条目标没验证，剩余条目完整重验一次。剩余多任务不能删验收；零任务需要明确整批放弃，不自动合入空批。

直接改卡仍暂停；有活动节点的受控请求在下一边界生效，与取得执行权共用控制代次。改某任务测试只失效相关测试和依赖批次资格，不重评审其他未变任务；标准/授权变化按真实确认版本处理，旧例外决定作废。未知归属、脏目录和未保存成果不得强清。

### 6. 状态、发布与完成判断

五态保留，展示每个任务的实际活动、当前节点、排队、失败和原因；有任务在开发而另一个失败时不把全批写成停止。Pi/Hook/CLI 使用同一查询，不从旧 phase 推断状态，不借查询恢复队列。

普通发布冻结当前批次树及每任务检查记录/贡献映射、验收结果/沿用明细；拿到目标锁再核对。未安排提交只给可合入，不暗加节点。dev 前进产生新树时返回具体缺项/整合入口，提交节点不偷偷检查；继续前两步只推 origin/dev、不强推、不自动重推及未提交目标工作区保护。例外只豁免真实用户接受的欠项，仍验证候选、版本、main 与资源边界，不将没验证改为通过。

合入或放弃的资源释放扩展到本批全部任务与批次目录、消费者和本机票据。保存任务分支、旧汇总 ref、结果和失败证据；未确认归属或脏成果保留并逐项报告。发布后即使工作目录已删除，也按发布时绑定展示真实检查与沿用来源。

### 7. 验证、边界与交付

原需求 A4（非法卡）、A5（真并行与先完成先汇入）、A6（责任返修及精确重验）为本步主验收；A7—A10 保留结论复用、状态、例外和释放的跨任务回归。基于既有 `node:test` 与 kernel fixture 新增少量集成覆盖：两个消费者实际重叠、测试与验收无重叠、任务候选替换/吸收来源后移出、两任务同轮返修汇齐才验、旧通过责任项必重验、未返修任务不被重复派工、没有末尾 full、旧单任务账本兼容、真实用户决定与迟到回包。

分批顺序：卡与任务账本兼容 → 独立任务启动/就绪集成 → 单轮验收与条目身份 → 责任回发/汇齐/精确重验 → 上限选择/移出/改卡 → 三宿主与统一发布/释放集成。依赖逻辑验证通过再继续；只跑受影响集合，不跑全量、不修改 `test/e2e.mjs`，不删弱既有断言。旧“不支持多任务/验收”断言按本步要求改为合法支持和非法拒绝，交付列明变化。

程序检查全部使用系统临时 Git/bare origin、替身宿主/验收方、隔离的 kernel/resource/projects/local-queue 根；有界进程与屏障取证，不用固定长等待制造并行证据。真实模型质量、真实宿主业务路径、业务验收和真实发布单列未验证；本次外层模型用于开发与静态评审，不算业务验收。真实 dev 合入/推送、本机部署和旧目录清理留待后续明确授权，不继承上一轮发布授权。

### 第 3 步准备与启动记录

- 已创建分支 `step3` 和上文隐藏 worktree，基线 b97e154；只复制原 `.autoreview.json`，未提交/合入/推送，桌面既有改动保持。
- 2026-11-06 重新核对：Pi 入口 `/Users/Admin/.local/bin/pi`，真实包 `@earendil-works/pi-coding-agent` 版本 1.3.0；目录仍名 `pi-versions/1.2.0`，不据目录名判断版本。已读当前 CLI 参数解析及正式启动器。
- 按本任务选择 read/edit/write/bash；权限扩展、已发布 autoreview、Ponytail full 足够承担开发与外层评审。不启用全局后台任务、浏览器、MCP、额外子 Agent 或不相关技能；不卸载它们。
- 权限扩展 `/Users/Admin/.pi/agent/npm/node_modules/@gotgenes/pi-permission-system/src/index.ts`；Ponytail `/Users/Admin/.codex/plugins/cache/ponytail/ponytail/4.13.0/pi-extension/index.js`。全局 yoloMode 当前 true；项目无覆盖。保持明确 deny 和本次任务边界，不修改持久配置。
- 启动前用已有权限处理器模拟 read/edit/write/bash，不执行工具或模型；再核对正式入口 dry-run，之后在新 Terminal 窗口前台启动。结果和实际窗口/会话身份写 `/Users/Admin/.pi-autoreview/preparations/loop-kernel-step3-20261106/`，不把检查计划写成已通过。
- `--offline` 只关闭 Pi 启动联网检查，模型仍正常连接；`--approve` 仅本次项目信任；不添加 accept-cmd、不使用 --json/--launcher background。开发会话命名“Loop内核第3步 · step3”。

启动准备实际结果：已按真实权限处理器模拟四个工具，0 次询问；正式入口 dry-run 已通过，三项扩展、工具名单和任务路径正确。电脑控制工具禁止操作 Terminal，尚未启动 Pi，未改成后台。可复制前台命令：`bash /Users/Admin/.pi-autoreview/preparations/loop-kernel-step3-20261106/start-step3.sh`。原始检查和未启动状态见上述 preparation 目录；此记录不代表实际会话已加载。

### 第 3 步实施与验证记录

开发实施工作目录 `/Users/Admin/.pi-autoreview/worktrees/loop-kernel-step3`，分支 `step3`，基线 `b97e1545053b588d0e1011da7f346096ddf9f6c8`。既有方案/本提示词未提交内容保留；未 add/commit/stash/reset/merge/push 真实仓库，未部署桌面运行版，未启动额外真实开发/评审 Agent。仅执行隔离程序验证及只读宿主 help。

#### 已实施

- `development-card.ts`：version:1 多任务、固定顺序、单任务可选验收、多任务必需验收，非人工条目唯一责任归属、标准/方法/路径前置检查；验收独立默认 3/20/1，任务级额度覆盖。提示词内容绑定每次节点输入；保持前两步真实用户文件引用后的确认版本保护，未真实引用的初始卡提示词仍按原路径内容进入首次检查，不额外改变单任务约定。
- `node-ledger.ts`：一份账本的 `taskRecords` 保存稳定 ID、候选、工作区、原会话/进程、输入版本、尝试、次数、返修及释放；显式上下文投影仍写同一个短锁，不生成伪任务账本。顶层只作批次集成/验收/发布。旧单任务字段继续兼容，query 不迁移、不派工。
- `kernel-runtime.ts`/三宿主适配：独立任务进程和隐藏空间真并行；Pi/Claude print、Codex exec 使用精确会话与受管继续信封，无共享 TUI/最近会话猜测。保留原单任务交互入口、auto/yolo 与已有 deny。Codex exec/resume 自动审批参数仅用已安装 CLI 的 help 只读核实，不代表真实模型装配通过。
- `batch-integration.ts`：先就绪先装配已检查贡献，CAS + 意图/前后树 + 历史 ref + 输入/检查映射；重复候选幂等，候选替换/移出从冻结基线与保留贡献重建。直接或经批次吸收的其他任务来源会剥离；同文件混合无法证明时只暂停该任务，不猜删除。冲突只回本任务原会话，不扣验收次数。CAS 后中断按精确意图恢复，未知字节/索引/控制变化保留现场。其他任务在途时保留其上次有效贡献，不冒充它的新候选已就绪。
- `acceptance.ts`/`acceptance-node.ts`：增加新卡单轮接缝，复用真实模型调用、证据、人工/授权、系统启动/释放；不走旧“定向后 full”包装。测试与验收共用同一 FIFO，取得槽后才起 deadline；恢复/报告/收尾共用剩余预算，1 分钟卡也不被旧最小预算门槛挡住。非开发节点写源码后还原也通过原始字节/索引、inode/ctime 与监测失效，证据保留。
- 内核责任调度：同轮责任集合固定，汇齐才验“不通过项 + 返修任务名下全部项”；未返修项保留旧树/轮次/证据，核对标准、授权、相关方法及任务输入未变。非产品有限恢复不扣任务产品次数，不派产品返修，原范围与有效结论保留。
- 控制/发布：CLI 加 `--task`、批次 `重跑 --node 验收`、`改卡 --remove-task`；原会话可记录继续修/移出/标准确认的真实决定，绑定版本和标准哈希，机器/文件不能代签。提高额度不清零、不自动扩张其他任务。标准改版清旧授权；改测试只失效该任务测试和依赖验收。移出先保留 ref/停消费者再重建，原标准不编辑，剩余完整重验、移出项记没验证。提交绑定各任务实测树/检查与汇总验收树的来源映射；dev 前进用内核逐任务整合并登记 dev 来源，不由提交节点偷偷检查。普通/例外均保留目标、候选及资源保护，只推 origin/dev。全部终态资源按登记释放，未知/脏内容保留。
- 当前 README、工具清单及运行维护同步新字段、三种上限选择、标准确认、移出、查询与宿主执行模式；第四步节点、第五步旧路径删除均未实施，未修改 `test/e2e.mjs`、稳定规则或原需求。

#### 原始检查与阶段结果（日志保留在系统临时目录）

证据根：`/tmp/loop-step3-checks-hWvPgT/`，夹具的 Git/bare origin、kernel/projects/resources/local-queue、通知及假宿主均在每例自己的系统临时根，按归属 finally 释放；不复用外层身份/scope。检查脚本亦在此根，不是产品任务/报告副本。

1. `node --test test/kernel-controls.test.ts` → 通过，`foundation.log`。
2. `node --test test/kernel-test-node.test.ts` → 通过，`test-node-regression.log`。
3. `node --test test/kernel.test.ts` → 初次有 2 项：旧“验收未上线”预期需按本步改为缺 acceptance 拒绝；查询理由回归遗漏输入缺项，已修复。原始 `kernel-regression.log` 保留，最终回归见下文。
4. `node --test test/kernel-batch.test.ts` → `batch-1.log` 初次 6/7，A5 的假宿主设置覆盖了验收计数目录；修夹具，不改产品断言。`parallel-2.log` 同一已知失败保留；修复并加入真实双测试排队屏障后 `parallel-3.log` 通过。`batch-2.log` 的“写源码后还原”反例发现异步文件通知可合并，已补 inode/ctime/目录元数据守卫；`batch-target-3.log` 定向 5 例、`batch-4.log` 完整批次集合通过。
5. `node --test test/kernel-controls.test.ts test/kernel-test-node.test.ts` → `regression-2.log` 中旧正文篡改真实输入用例发现拒收处理不能吞掉用户原文；修为不伪报已读/不授权但仍记录真实输入，`node --test --test-name-pattern='机器信封核对接收完整正文' test/kernel-test-node.test.ts` → `receipt-3.log` 通过。
6. `node --test test/host-dev.test.ts` → `host-dev.log` 通过；只读 `/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex --help`、`exec --help`、`exec resume --help`、`exec --approve-for-me resume --help` → `codex-*.txt`，均未调用业务模型或信任/配置变更。
7. 实际调用已安装 pi-lens `LSPService.touchFile(...collectDiagnostics:true,clientScope:'primary')`，`PI_LENS_DISABLE_LSP_INSTALL=1`，在 finally shutdown。首次直接加载缺 Pi 包解析，`lens-1.err` 保留；用临时 ESM loader 指向已安装 Pi（不安装、不改全局）后 `lens-2.jsonl`/`lens-3.jsonl` 有真实 TypeScript 返回，不是空缓存。发现并修复 NodeName 类型与 prior 可空错误；原生推断工程缺 Node/Pi 类型的诊断不记为通过。复用已安装 TypeScript、显式指向已有 @types/node/Pi 类型的 `types-check.mjs`，17 个受影响产品入口 `types-1.jsonl` 为 0 诊断。交付前当前快照再复核见下文。

#### 断言变化与未验证边界

- 只改现有 `test/kernel.test.ts` 一条旧预期：`[开发评审,验收,提交]` 由“尚未支持”改为“缺 acceptance 路径拒绝”，因为本步已上线验收；其余非法卡无副作用底线保留。
- `test/host-dev.test.ts` 仅新增 Codex 并行 exec/精确 resume 参数断言，不改旧单会话预期。`test/fake-kernel-pi.mjs` 仅扩为按任务身份的屏障/文件，旧单任务场景保留；fixture 清除外层任务/启动/scope 身份。新增 `test/kernel-batch.test.ts` 覆盖 A4—A10、并行区间/槽互斥、精确调用范围、贡献来源/移出、上限、改卡/授权、迟到、旧账本和三宿主适配，不删除旧测试。
- `test/e2e.mjs` 场景和断言 **零修改**，未运行；旧验收入口的末尾 full 保留到第 5 步，本步只为新卡去掉额外 full。
- 【必须修改】开发自检发现项已修复，当前没有已知未解决的必须修改；独立静态评审尚待外层 Loop，不将自检写成独立评审通过。
- 【建议】同文件混合来源无法独立剥离时，当前按需求安全暂停，后续可改善原会话引导；不阻断本步，不为此建立通用平台。
- 未验证：真实 Pi/Claude/Codex 模型的完整开发质量、实际账号/信任装配、真实浏览器/后端业务验收、真实远端 dev 发布与本机部署。前两步的真实自举/业务未验项原样保留，本次替身程序检查不替它们补验。

#### 交付前集成复核与收尾

实际工作目录仍为本页开头的 step3。原始命令与日志：

```bash
node --test --test-concurrency=1 test/kernel.test.ts test/kernel-controls.test.ts test/kernel-test-node.test.ts test/local-node-queue.test.ts test/host-dev.test.ts
# integration-kernel.log：72 项，初检 68 通过/4 失败（含父用例）；未掩盖初检失败。
node --test --test-concurrency=1 test/kernel-batch.test.ts test/acceptance-recheck.test.ts test/acceptance-recovery.test.ts
# integration-batch.log：59/59 通过，新卡精确重验与旧入口 full/证据恢复语义分开覆盖。
node --test --test-name-pattern='新卡无需手动提交卡|返修1：例外决定' test/kernel.test.ts
# compat-repair.log：5/5。
node --test --test-name-pattern='waiting 边界改卡' test/local-node-queue.test.ts
# queue-repair.log：1/1。
node --test --test-name-pattern='A6|单任务可选验收|头less|改任务测试|验收上限|真实授权|多任务 Claude/Codex' test/kernel-batch.test.ts
# batch-compat.log：9/9。
node --test --test-name-pattern='验收上限' test/kernel-batch.test.ts
# limit-final.log：1/1，补充“开启开发也不能绕过上限记账”反例。
node --test --test-name-pattern='真实授权' test/kernel-batch.test.ts
# authorization-final.log：1/1，授权未决定不排队/不调用验收方/不增加实测轮次；真实撤权使旧结论失效。
node /tmp/loop-step3-checks-hWvPgT/types-check.mjs development-card.ts node-ledger.ts kernel.ts kernel-workspace.ts kernel-session.ts kernel-runtime.ts kernel-cli.ts kernel-controls.ts kernel-pi.ts hosts/kernel-hook.ts hosts/dev.ts batch-integration.ts acceptance-node.ts acceptance.ts submission-node.ts development-node.ts test-node.ts
node /tmp/loop-step3-checks-hWvPgT/types-check.mjs loop.ts
# types-current.jsonl / types-cli.jsonl：受影响 18 个产品入口均 0 诊断，未安装依赖。
node /tmp/loop-step3-checks-hWvPgT/lens-check.mjs development-card.ts node-ledger.ts kernel.ts kernel-workspace.ts kernel-session.ts kernel-runtime.ts kernel-controls.ts batch-integration.ts acceptance-node.ts kernel-cli.ts kernel-pi.ts hosts/kernel-hook.ts hosts/dev.ts acceptance.ts submission-node.ts development-node.ts test-node.ts
node /tmp/loop-step3-checks-hWvPgT/lens-check.mjs kernel.ts kernel-session.ts kernel-controls.ts
node /tmp/loop-step3-checks-hWvPgT/lens-check.mjs kernel-session.ts
node /tmp/loop-step3-checks-hWvPgT/lens-check.mjs loop.ts
# lens-final / lens-repair / lens-authorization / lens-cli：实际 LSP 请求；缺类型环境诊断仍原样保留，不作“LSP 清零”宣传。
git diff --check
# 通过；branch=step3，HEAD 仍 b97e1545053b588d0e1011da7f346096ddf9f6c8。
```

初检回归修复事实：新增的初始提示词确认快照误改变了前两步“未真实引用的卡提示词可在首次检查按当前内容采用”的约定，已撤回这部分扩张；真实用户引用后的确认保护保留。等待边界改卡把顶层 epoch 加了两次，已改为批次只加一次、各任务等待身份分别加一次。上述原测试断言均未修改；按失败与受影响范围定向复核闭环，不把初检日志改成通过，也不在无新疑点后重复扩大检查。

资源：真实双宿主替身测试确认独立进程组同时存活/会话不同、双测试只一槽、验收不重叠、先乙后甲汇入；结束后按登记确认消费者死亡、队列为空、全部任务及批次 worktree 删除，任务分支与历史 ref 保留。旧验收测试也核对 procs/资源释放；脏/未知归属反例按产品约定保留，夹具最终仅清理自身系统临时根。pi-lens 服务均 finally shutdown；检查日志与复核脚本保留在证据根。实际本开发 worktree 是用户指定空间，未删除；未清理任何旧 worktree 或用户 temp/资料。

分层结论：开发静态自检完成；独立静态评审交外层、尚未由开发方冒称通过。隔离程序验证及真实进程/Git/CLI/Hook 的替身装配已验证；真实模型质量、真实宿主信任/账号装配、用户业务验收及真实发布未验证。当前没有已知未解决的【必须修改】，建议仍仅为上文安全暂停情形的使用引导。

旧问题单：不回写/关闭外层问题单，不把本次替身结果升级成关单依据；前两步逐单记录保留。本步按权威需求标题逐项对照新卡接缝（不是原业务复现）：

| 旧问题标题 | 本步对照结果/依据 |
| --- | --- |
| 开工全量基线测试阻断批次启动 | 新卡仅前置只读校验，无隐含基线；非法卡无副作用、旧配置验收不被单会话执行的回归保留 |
| 全量测试同时运行导致门禁假失败 | 卡上命令 + 测试/验收共用 FIFO；真实进程屏障与互斥反例通过，不治理旧全量套件 |
| 队列通过后合入仍重复评审 | 同树/输入复用；A6 未返修任务分支与检查数不变，提交只核对映射 |
| 自动评审完成提示与合入条件不一致 | CLI/Pi/Hook 共用 query/qualification；普通拒绝逐项补救，静态自检与业务结论分列 |
| 非产品失败阻断整批合入 | 任务运行独立；验收非产品不派返修/不扣产品次数；用户例外仍绑定候选与资源 |
| 批次已合入但状态仍显示运行中 | 发布事实与进程/推送/释放分列，保留 Loop 外合入只读识别回归 |
| 配置错误发现晚且暂停无通知 | 标准/方法/卡前置校验，未决授权不启动验收；通知替身已验，真实系统通知未验 |
| 运行中改批次配置导致整批验收不启动 | 受控事务、相关输入投影、等待边界接续及标准确认反例通过；直接改卡暂停 |
| 合入队列锁在持有者释放瞬间误报身份不明 | 保留前两步目标锁/身份边界；本步未单独复现该旧队列瞬时态，不宣称修复旧路径 |
| 启动命令截断导致流水线空等 | 新卡 argv 与精确会话登记、超时保护、双消费者屏障覆盖；真实宿主业务未验 |
| 门禁误把测试失败判为磁盘不足 | 共用分类器未改，前两步 ENOSPC/产品断言定向回归保留，不新增旧门禁逻辑 |
| 升级后缺少项目迁移提示 | 新卡拒绝旧格式、不回退；当前说明同步。不代项目迁移，真实升级未验 |
| 验收超时丢弃已有证据 | 本步单轮接缝/旧恢复测试保留证据；原验收内部缺陷另留，不宣称本步关单 |
| 验收演示数据写入真实状态目录 | 新夹具与运行身份/cwd 隔离；原业务场景未验，不扩修其内部缺陷 |
| 测试写死等待秒数在机器繁忙时误判失败 | 新增屏障取证、不靠固定长等待宣称并行；旧测试治理未实施 |
| 调用链排查遗漏子组件 | 本步核对显式任务调用链及三适配入口，不扩为全仓治理 |
| 协调汇报反复要求用户决策 | 普通自检直接继续，仅真实授权/额度/移出等用户控制留决定；非本步代码关单 |

关联历史“合入退回无通知且缺少例外入口”沿用统一普通/真实用户例外入口与历史记录；本步新增多任务来源映射/验收欠项例外的隔离反例，不替真实业务验收。

### 第 1 次评审返修

来源：本会话收到的外层「自动评审 · 第 1 次返修」三条必须修改；不处理本轮明确无需处理的小问题。工作区/分支/真实仓库边界不变。

- **第 1 条：已修。** `prepareExceptionCandidate()` 仅在真实用户合入入口、终端显示确认内容之前，按全部当前登记候选冻结完整批次树和来源映射。测试失败任务也纳入当前贡献；已有旧贡献从基线重建替换，不与旧代码叠加。欠检查不伪造通过，但源码/候选/输入/装配记录与资源身份不可豁免。`contributionProblems(..., false)` 与发布 CAS 边界独立强制核对来源；`taskChecks` 仅绑定映射中实际通过的记录，决定/发布均留完整 mapping。冻结事务的 CAS 恢复允许如实保留未通过项，不授予发布决定。新增两种反例分别验证“从未汇入的甲”与“甲有旧贡献、当前测试失败”，都断言临时 bare `origin/dev` 实际含甲最新文件与乙文件、映射/检查候选一致、失败未改通过；再覆盖缺失/被篡改来源、确认后换候选及例外冻结恢复。
- **第 2 条：已修。** 真实任务输入更新会在保留责任集合/等待集合/次数的同时标记计划待刷新、撤销旧派工。计划额外冻结标准、授权和共享方法的 basis；安全边界仅在全部新检查与贡献到齐、旧通过项的未变任务输入/原实测材料可证明时刷新签名，并记 `planRefreshes`。不取消签名校验、不清轮次/返修次数、不追加 full。新增/强化 Claude/Codex 实际 UserPromptSubmit 事件：验收只退甲后，用户再引用补充要求，甲完成正常修复后只验 A1/A2，乙分支/检查数与旧实测树/轮次不变；甲丙同轮补充要求仍汇齐才验一次。共享方法另有变化时拒绝借补充输入洗白，原范围和材料保留。
- **第 3 条：已修。** 无任务记录的单任务继续使用旧 `提示词：路径` 键，无验收的第二步完整输入也保留旧 `[review, testing, flow, cardRevision, cardHash]` 元组；多任务/验收只在其实际消费者上扩展。不迁移、不重绑旧结论。`test/helpers/legacy-kernel-inputs.ts` 冻结 b97e154 前两步只读算法（与当前 `checkInputs` 独立），构造实际旧完整指纹/节点指纹的通过记录而非调用新节点生成记录，覆盖 v1/v2 查询不写、输入变化拒绝、无变化续跑复用、普通合入/推 bare dev、历史结果/次数不变及释放。

本轮证据根 `/tmp/loop-step3-review1-xAPIn1/`。旧算法原始依据由只读 `git show HEAD:kernel-workspace.ts` / `git show HEAD:node-ledger.ts` 保存到此根，未修改真实 HEAD；所有业务/Git/资源/通知仍在各夹具自己的系统临时根。

实际检查命令（在本工作目录执行）：

```bash
node --test --test-name-pattern='真实旧指纹' test/kernel-batch.test.ts
# legacy-1.log：1/1。
node --test --test-name-pattern='甲丙同轮返修|多任务 Claude/Codex' test/kernel-batch.test.ts
# input-plan-1.log：4/4。
node --test --test-name-pattern='例外发布包含|例外不能豁免|多任务普通拒绝' test/kernel-batch.test.ts
# exception-1.log：5/5。
node --test test/kernel-batch.test.ts
# batch-integration.log：27/27，含最终新增的来源恢复与共享方法反例。
node --test --test-concurrency=1 test/kernel.test.ts test/kernel-controls.test.ts test/kernel-test-node.test.ts test/local-node-queue.test.ts
# kernel-integration.log：68/68；前次交付的单任务/等待改卡回归也在本次完整受影响集合中通过。
node /tmp/loop-step3-checks-hWvPgT/lens-check.mjs kernel-workspace.ts kernel-session.ts node-ledger.ts kernel-controls.ts kernel.ts batch-integration.ts kernel-cli.ts submission-node.ts acceptance-node.ts
# lens.jsonl/lens.err：实际 pi-lens 请求，禁安装、finally shutdown；原生推断工程缺 Node/Pi 类型不冒称清零。
node /tmp/loop-step3-checks-hWvPgT/types-check.mjs kernel-workspace.ts kernel-session.ts node-ledger.ts kernel-controls.ts kernel.ts batch-integration.ts kernel-cli.ts submission-node.ts acceptance-node.ts test/helpers/legacy-kernel-inputs.ts test/kernel-batch.test.ts
# types.jsonl：11 个受影响入口 0 诊断（包含旧指纹夹具与行为测试），复用已安装类型依赖。
git diff --check
```

【必须修改】本轮三项已修并通过上述隔离程序验证，当前无已知未修必须项；待外层静态复审，不自行宣布独立评审通过。

【建议】未扩修外层本轮明确不用处理的小问题。没有修改 `test/e2e.mjs` 或降低旧断言；只新增反例、强化原“旧账本”及真实输入场景。当前 README/工具清单同步例外来源与计划刷新语义。夹具结束按登记停消费者、清空队列/释放空间；日志、旧算法依据与诊断证据保留在系统临时证据根。

未验证项仍为真实模型质量、真实宿主账号/信任装配、真实业务验收、真实 dev/origin/dev 发布与部署；前两步未验项不变。未 add/commit/stash/reset/merge/push 真实仓库，未操作用户 temp/ 或旧 worktree。

### 第 2 次评审返修

来源：本会话外层「自动评审 · 第 2 次返修」唯一必须修改；本轮小问题仍不扩修。工作区仍为 `/Users/Admin/.pi-autoreview/worktrees/loop-kernel-step3`，分支 `step3`。

**第 1 条：已修。** 采用评审建议中的第二种方式：让后续替换、移出及其 CAS 恢复安全处理已登记但未通过的贡献，不另建待确认副账本。`batch-integration.ts` 统一 `verifyContribution()` 三种边界：

- 新的普通任务汇入（ready）仍须当前候选/用户版本/控制代次/输入一致，且全部必需任务检查已有有效通过记录。
- 保留的旧贡献（registered）必须与原已登记映射逐字一致；允许其尚缺通过项，但已声明的通过 ID 仍须有对应任务/节点/树/原输入、结束、释放和证据。只保留源码事实，不授予新通过资格，不检查其他任务的在途候选，更不覆盖其工作区。
- 例外确认前的冻结（exception）仍核对全部当前来源及实际检查快照；确认取消不发布、不生成用户决定。正常替换/移出和中断恢复使用同一校验，不因保留未通过快照互相等待。`contributionProblems()`、普通验收入口及提交前/CAS 的资格门槛未放宽，未通过任务仍阻止普通验收与发布。

新增完整真实 PTY 反例（系统临时 Git/bare origin，不调用真实模型）：两任务实际测试命令均产品失败 → CLI `合入 --接受未验证 --json` 显示冻结候选 → 输入“取消” → 断言无例外决定、无发布。分两路验证：① 甲修好先汇入，乙仍失败时直接执行验收/普通合入均拒绝，乙再修好后统一验收一次并普通自动合入，bare `origin/dev` 实际文件为甲乙各自修好内容；② 取消后受控移出甲，事务从 prepared 正常完成、无 pending，保留乙未通过快照，乙修好后仅完整验剩余 A3/A4 并普通发布，远端甲恢复冻结基线、乙为新内容。两路均断言原失败记录保留、发布不是例外、槽清空/工作区释放。

原 CAS 反例另补“普通替换仍保留一个未通过快照”和“移出重建仍保留未通过快照”的中断/恢复，并检查控制事务不重复装配、不补成通过、不授予发布决定。既有例外漏代码、来源不一致、前轮精确重验、旧账本及 Hook 场景保留。

本轮证据根 `/tmp/loop-step3-review2-FtVo1c/`，原始命令：

```bash
node --test --test-name-pattern='两任务测试失败后真实 TTY 取消例外' test/kernel-batch.test.ts
# reproduce.log：修改产品前按原断言复现两路失败（替换未汇入、移出停 prepared）；没有弱化断言。
# cancel-repair.log：修复后同命令 3/3（含父用例）通过。
node --test --test-name-pattern='集成 CAS 后中断|例外发布包含|例外不能豁免' test/kernel-batch.test.ts
# retained-recovery.log：5/5 通过，含普通替换/移出保留未通过快照的恢复。
node --test test/kernel-batch.test.ts
# batch-integration.log：30/30 通过，完整受影响集合。
node --test --test-name-pattern='真实 PTY 例外入口' test/kernel.test.ts
# single-tty.log：1/1，通过原单任务中文确认/取消/改输入竞态断言。
node /tmp/loop-step3-checks-hWvPgT/lens-check.mjs batch-integration.ts test/kernel-batch.test.ts
# lens.jsonl / lens.err：实际 pi-lens 检查，禁安装、finally shutdown，不用空缓存报通过；推断工程缺类型环境说明沿用。
node /tmp/loop-step3-checks-hWvPgT/types-check.mjs batch-integration.ts test/kernel-batch.test.ts
# types.jsonl：2 个受影响入口及依赖共 0 诊断，复用已安装 Node/Pi 类型。
git diff --check
```

【必须修改】本轮唯一项已修并完成上述程序验证，待外层复审；不冒称独立评审通过。

【建议】未处理本轮明确不要求处理的小问题。仅同步 README/工具清单的取消后语义；未改 `test/e2e.mjs`、原需求、验收标准或稳定规则。所有新夹具为系统临时根；PTY 子进程按本次 fork 归属等待/停止，测试消费者与队列按登记释放。保留原始复现失败日志及检查证据；未清理用户 temp/、旧 worktree 或开发工作区。未提交、合入、推送真实仓库，未部署。

未验证项继续为真实模型/宿主业务装配、真实用户业务验收、真实远端发布与本机部署；不把本次替身流程补记为前两步业务通过。

## 前两步历史记录

以下为原第一、二步方案和交付前记录，保留原始时态以便追溯；其中“当前阶段”“待评审”“未合入”等不覆盖本文开头的最新发布事实，历史启动命令不用于本次。

原稿日期：2026-11-06。当前阶段：**阶段 B 的第二步代码、ENOSPC 漏项、第 2 轮三项必须修改及本次 mc 存储水位兼容返修已补修并完成相关定向验证，待外层 Loop 评审当前最终代码**。方案阶段已由外层 Loop 静态评审通过、无必须修改，协调方已明确继续同一会话实施。开发起点仍为第一步 `refactor/loop-kernel-step1` 的 `f014331`；第一步运行工作区和桌面仓库保持只读。当前实际证据见下文「阶段 B 实施与验证记录」，不另建报告或任务书。第二步代码已收到外层第 2 轮三项必须修改，本轮均已补修；原评审及暂停历史保留，当前最终快照待外层重新评审，不能写成代码评审已通过。真实模型/宿主装配、真实远端发布、第一步真实自举及业务验收均未验证，不记为已完成。

权威需求只读：[【req】Loop内核与节点编排](/Users/Admin/Desktop/loop/issues/【req】Loop内核与节点编排.md)。当前执行文件：[第 2 步提示词](prompt/提示词-Loop内核与节点编排-2测试节点.md)。第一步准备记录保留在本文历史章节；本方案不替代需求、用户授权或验收标准，字段、文件拆分和内部命令是实现设计。

## 前两步推进建议（历史）

按需求规定的五步迁移。第 1 步先打通单任务的「开发评审 → 提交」，把候选、结论、实际运行状态和合入资格交给内核；先解决“已经停了却显示运行中”“已经检查却重复检查”“没有队列记录就不能合入”。测试、并行验收、部署和旧代码清理按原顺序接入，不提前实现。

开发评审保留一个完整循环：开发、静态评审、原会话返修；内部拆出纯评审执行函数不等于把开发与评审拆成两个流程节点。复用现有评审模型调用、解析、消息回发和资源管理，不搭通用流程引擎、不引入数据库或新依赖。

第一步起草时尚无新卡启动能力，因此当时只准备 Pi 单会话，不生成旧 `批次.json`，不执行旧 `开工`，不附加全量实操验收命令。现在第一步源码已经存在。用户明确要求直接从第一步分支继续第二步，覆盖原先“先合入 dev 再写下一步”的执行顺序；不以尚未合入 dev 阻断，也不把这一授权说成第一步真实自举验收已通过。

本轮在 `/Users/Admin/.pi-autoreview/worktrees/loop-kernel-step2`，由外层 Loop 使用只读第一步版本负责静态评审与同会话返修；不嵌套启动 Agent。方案阶段的无必须修改结论和协调方实施指令已收到，当前执行阶段 B。以下历史分析保留，第二步设计以「第 2 步实施方案」为准，实际进展/证据以下文实施记录为准。

## 第 1 步起草时的现状（历史）

以下是 2026-11-06 起草时的静态源码事实，不是当前源码清单，也不是运行验收结论。

| 现状 | 对方案的影响 |
|---|---|
| 已提交 dev 为 `fbe1441`；自动测试门禁已停用 | 不恢复 gate；开发者仍做相关定向自检 |
| `review.ts/runReviewRound` 同时依赖验收、准备、来源与 `queueReviewedResult`；`ReviewState` 混合多种状态 | 先抽纯评审执行部分；旧入口暂留组合层，新节点不得借旧组合层继续串验收与队列 |
| `autoreview.ts`、`hosts/review-hook.ts` 均调用上述共用函数，完成发布又依赖队列 | Pi 与两个 Hook 的接线一起核对；不得只改 Pi 后留下另两种入口失效 |
| `ledger.ts` 当前只是 Markdown 交付索引，失败不改变完成状态 | 不能把它当机器结论账本；新增一个小型结构化账本，Markdown 仍为展示出口 |
| `git.ts` 已有树、工作区指纹及内容比较；`commit-batch.ts` 已有私有索引、压缩历史与条件更新分支 | 复用 Git 身份及防并发覆盖机制；不能只用含 HEAD 的旧 fingerprint 判断同树复用 |
| `commit-batch.ts/pushBatch` 推批次分支；旧合入入口返回“未推送” | 新提交节点单独落实“只推目标 dev”，不能原样套用旧推送函数 |
| `loop.ts/cmdStatus` 可能恢复队列；`query.ts` 顶层状态仍取旧 phase | 新查询统一走纯读取的内核状态计算；查询不得偷偷启动队列或模型 |
| `bin/pi-dev` 已有自动权限检查，显式加载权限、autoreview、Ponytail | 本次直接复用入口，不手写第二套启动器 |

运行版有用户未提交改动，涉及 `loop.ts`、`merge-queue.ts`、`工具清单.md`、`test/merge-queue-target.test.ts` 等，也有历史文档移动。它们不属于本次开发基线，不回滚、不提交、不导入隔离工作区。特别是已有 `--release` 相关改动与新提交入口有文件重叠，后续正式集成必须逐项保留并核对，不能强制覆盖。

## 内核与节点怎样分工

```text
启动/停止/查询/合入命令，Pi 与宿主适配
  → 内核：卡检查、调度、候选与结论、活动身份、通知
      → 固定节点执行器
          开发评审：宿主会话 + 纯静态评审 + 原会话返修
          测试（第 2 步）：本机排队 + 卡上命令 + 有限恢复
          提交：目标分支排队 + 合入 + 推送
      ← 节点返回结果和证据，内核写账本、决定后续

旧单会话适配 → 同一纯评审能力
旧批次代码：迁移期间留存，但不作为新卡的暗中回退路径
```

第 1 步已经增加 `kernel.ts`、`development-card.ts`、`node-ledger.ts` 及工作区、会话、运行与入口适配模块。第 2 步沿这些接缝扩展，新增文件和具体调用点见下文，不为目录整齐整仓搬家。内核通过入口传入的固定执行器表调用节点；表只接纳六种已确认节点，不提供任意插件注册。

统一输入至少包含批次/任务 ID、候选提交和树、卡版本、相关检查输入版本、尝试 ID。统一输出包含结果、失败分类、证据和实际操作；结果区分通过、不通过、没验证、中断。节点内部状态不互相继承，评审代码不读提交队列，提交代码不读 `ReviewState`。

准备检查、来源存在性、权限与资源登记在内核或入口边界执行。需要保留的经验库、问题单回写等通过既有服务接入；新节点不为此相互调用。问题单只在对应步骤实证完成、按原规则核实后回写，不能第 1 步结束就关闭整张五步需求。

## 开发卡：先实现一个可用子集

建议文件名仍放在 `docs/batches/<批次>/`，使用 `开发卡.json` 区分旧格式。相对路径全部相对于卡文件目录；提示词不存在、路径越界、分支非法、任务重名等在创建分支和目录前报错。

第 1 步已支持如下结构；这是字段示例，不是本轮启动真实卡的授权：

```json
{
  "version": 1,
  "name": "单任务示例",
  "nature": "开发",
  "base": "dev",
  "target": "dev",
  "flow": ["开发评审", "提交"],
  "tasks": [
    {
      "name": "内核",
      "prompt": "../../prompt/提示词-示例.md",
      "scope": ["kernel.ts", "test/kernel.test.ts"]
    }
  ],
  "limits": {
    "开发评审": { "maxRepairs": 4, "timeoutMin": 60 }
  }
}
```

第 1 步允许单任务 `[开发评审]` 与 `[开发评审, 提交]`。前者保留候选和结论，结束后可由显式合入命令处理；不得暗中补一个提交节点。`base` 缺省取 `target`，启动时解析并冻结提交。Loop 卡的目标固定为 dev，不碰 main。分支名和临时目录由程序生成并登记，不让用户填 workspaces。

已知但未上线的测试、验收、评审、部署节点要明确报“本版本尚未支持”；未知节点、重复或逆序节点都拒绝，不忽略、不退回旧引擎。两任务缺验收的卡必须指出底线错误；其他多任务卡说明第 3 步上线，不创建资源。旧 `stages/workflow/steps` 卡提示字段迁移位置，不能继续启动已作废的批次。

卡中全部列出的检查都是必需检查，不添加 optional 开关。缺省开发评审返修 4 次；第 2、3 步分别接入测试、验收各 3 次，时限各自独立。提交、部署的基础设施失败不使用产品返修次数。各节点只读取自己的限额。

运行开始冻结规范化卡和原文件内容哈希。第 1 步即检测运行中直接改文件：下个边界停止推进、通知，不静默采用。受控改卡命令在第 2 步实现，旧成功结论是否仍有效由其相关输入版本决定，不能只因卡里改了说明文字就全部失效。

需求的典型“测试性质”示例只有 `[测试]`，与底线 1、3 冲突。第二步已拍板继续保留底线、拒绝纯测试性质卡，不自行添加例外，也不因此阻断开发性质卡上的测试节点。

## 结论以什么为准

结论账本放在 `~/.pi-autoreview/`，按 Git 共用目录身份和批次 ID 隔离，不能只按仓库目录名分组。同名批次、不同 worktree 和不同仓库不会串账。

一条结论至少保存：节点、任务或批次、候选提交、代码树、检查输入版本、实际命令/操作、结果、失败分类、证据路径、开始/结束时间、尝试 ID、资源释放状态。旧记录保留，不覆盖成当前通过。采用现有原子文件写法和短锁；不为此做通用事件溯源框架。

复用同时检查：代码树相同、相关需求/标准/授权/检查配置相同、记录确实通过、证据仍在、旧运行已结束且释放确认。同树压缩或提交信息变化不触发重评审；实际代码或相关检查输入变化，旧结论失去当前资格，但历史证据仍保留。未跟踪文件、索引和正在写入的文件不能藏在“HEAD 没变”后面。

开发方交付后，程序先在所属任务分支提交本轮允许范围内的修改，再对该提交评审；无变化不制造空提交。范围与本机文件排除先于提交；自动提交失败不能写成评审通过。开发方不自行提交。评审过程中再次发生代码写入，本轮结果无效。旧尝试迟到返回时，不得覆盖新候选或新尝试。

“只有开发评审可改代码”约束节点的产品编辑行为；提交节点按账本发布已检查代码、程序保存快照或提交，不是允许它修改产品内容。非开发节点的日志、证据和缓存写专属运行目录，不能通过扩大忽略列表把源码变化隐藏掉。

第 3 步的定向验收复用是需求已明确接受的例外：返修任务的新条目绑定新批次候选；未返修任务的通过项注明原实测树、轮次及沿用原因，并验证其任务来源未变。不能把旧证据改写为新树实测。重验集合严格为“不通过项 + 返修任务名下全部项”，不再偷偷补完整重验。移出任务后另按需求重建批次并完整重验剩余条目。

## 停止、查询、合入

内核只给五种批次状态：进行中、等你决定、可合入、已合入、已放弃。状态优先核对发布/放弃事实，再查本批节点的登记身份与实际活动，再查必需结论；旧 phase 文件只是历史线索。空闲终端进程还在，不代表节点仍执行。归属或存活无法核实时写明“无法确认”，不能假称进行中或已释放。

停止只取消本批已登记活动、等待释放，不删除已提交候选和证据，也不等于放弃。没有运行中的节点且必需结论不足，显示“等你决定：任务 / 节点 / 原因”；全部检查有效且尚未发布，显示可合入。查询不调用模型，不恢复队列，不启动资源。

第 1 步新增卡的 `启动/停止/状态/查询/合入` 都接同一内核；Pi 状态命令和宿主上下文只渲染这一查询的结果，不能各算一套完成条件。旧历史记录单列其旧版来源，不强行伪造新账本结论。

普通合入逐项检查所有已安排的前置节点，提交节点自己的成功记录不能反过来成为首次提交的前提；部署排在提交之后，也不成为合入前提。拒绝时列出任务、节点、候选树、缺项和实际已实现的补救命令。第 1 步的补救可以精确续接原开发会话，不能打印尚未实现的“重跑测试”。

例外合入建议沿用 `bin/loop 合入 <卡> --接受未验证`。它只豁免明确列出的未通过/未验证检查，不豁免候选身份、资源归属、main 保护、真实用户决定和数据保护。提示词、开发方输出、卡文件、机器返修消息均不能充当用户决定。保留现有真实用户输入来源机制，记录原话来源或用户操作、决定时间、完整欠项与候选；不另建一个可被模型自行填写的“已授权”开关。自动调度绝不加这个参数。

在对话中收到用户明确合入指令后的代理执行，与用户直接输入例外命令走同一处理函数；开发方无指令时不能替用户执行。当前准备与首次开发会话均不执行真实合入或推送。

## 提交与目录处理

新卡启动时直接完成检查、建分支、建隐藏 worktree、复制允许的本机文件并启动。第 1 步单任务可直接以任务候选为批次候选，不多建一个无实际作用的工作目录；第 3 步才加入多任务汇总的批次分支。

隐藏目录建议为 `~/.pi-autoreview/worktrees/<仓库标识>/<批次ID>/<任务ID>/`。每条记录同时绑定 Git 共用目录、分支、路径、运行 ID。复制 `.autoreview.json` 和已声明 localFiles，保留原来的忽略和安全检查，不复制用户资料、完整 .pi 会话目录或密钥集合。项目配置中的旧 gate 仍只提醒忽略。

提交按“仓库身份 + 目标分支”排队。队列只互斥发布，不再调用评审/测试/验收；发现资格缺失由内核决定回到哪个节点。拿到锁后再次核对候选、必需结论与目标头，采用现有条件更新方式防止覆盖并发提交。

若 dev 在检查后前进，先核对将发布的实际树：与已检查候选相同才能复用；不同则保留旧结果，返回具体缺项，把更新基线/冲突处理交回开发评审。不能将“无文本冲突”当作新树已经检查，也不能在提交节点偷偷再评审。锁释放竞争先重读锁身份，不能仅因锁文件消失就认定未知持有者。

新提交节点按需求发布 dev 后只推 `origin/dev`，不推任务分支/批次分支，不强推。推送意图、开始与结果先后落盘；失败保留本地提交和 Git 原因，不自动重试。状态显示“已合入（本地），推送失败/待确认”，不能混成完整交付成功；后续显式重试只推原记录的提交。真实仓库的发布操作仍遵循当次用户决定与统一入口。

压缩提交前保存历史 ref，任务历史可追溯。发布前后树必须相同；压缩不能触发一次新的评审。沿用原有发布与恢复保护，不覆盖运行目录原有改动；冲突逐项说明，不自动 stash、reset 或手工绕开统一合入入口。

Loop 外合入先以可证明的 Git 关系认定：记录的提交已经是目标祖先，或保存的最终发布候选对应目标历史中的同树提交。目标后来继续前进也要能认出；无法证明的内容相似不得直接认定。状态注明“已合入（Loop 外）”，推送情况另列，不伪造节点通过。

合入或明确放弃后，先确认成果已留在分支/历史 ref、停止本批会话和子进程、确认释放，再移除确属本批的 worktree 和临时目录；分支、账本、日志、失败证据保留。目录中出现未登记写入、未提交成果、仍在使用或归属不明时不强删，报告具体残留；“已合入”事实与“资源尚未释放、未完成交付”分开。旧的 18 个 worktree 不在本次清理范围。

## 五步安排与完成条件

| 步骤 | 实施内容 | 完成条件 |
|---|---|---|
| 第 1 步 | 单任务卡；内核与账本；自动任务提交；隐藏目录；开发评审、提交；统一状态、停止、普通/例外合入 | 新卡完成 Loop 自身真实改动并合进 dev；同树复用、变树拒绝、推送与资源状态均有证据 |
| 第 2 步 | 测试节点；本机执行槽；独立预算；有限恢复；单节点重跑、受控改卡、放弃 | 产品失败回原会话；环境失败不扣产品次数；只重跑失败节点，通知给出可执行命令 |
| 第 3 步 | 多任务并行；批次分支；按完成顺序汇入；统一验收；归属返修；定向重验与移出任务 | 两任务真并行，测试/验收串行占用本机名额；只退回责任任务，全部返修汇入后统一重验 |
| 第 4 步 | 部署节点；只评审节点接卡 | 部署 cmd/check/回退沿用；只评审已有提交只出报告，不开发、不发返修 |
| 第 5 步 | 先补齐新卡单任务与多任务的交付/返修/续跑衔接、持续状态、构建/缓存兼容、中断处理、可见 Pi 窗口及 gate 去重；同批安排具体中断证据和提示文案建议，再删除旧 workflow/每段验收/共用预算/workspaces/旧开工与独立 accept-cmd 路径 | 两类新卡按各自 flow 可见、可交互地推进与恢复；多任务覆盖汇入及统一验收；正常产物不误中断、真实输入变化仍受保护，中断有明确停点且不刷屏；必修与建议分别报告。再交删除清单并获用户确认后删除；旧工作目录逐个核对归属和成果后另行确认清理。补充要求见本文「第 5 步已确认补充」 |

第 2 步测试/第 3 步验收共用本机名额，默认 1；锁必须跨批次、跨仓库生效。开发评审不占这个名额，失败任务不拖住其他任务。每个节点独立次数和截止时间，环境恢复不清零或消耗产品次数。

第 3 步统一验收只在所有任务就绪后执行；冲突退回冲突任务的开发评审，不扣验收次数。某任务达到验收上限，通知用户选择继续修、移出任务或整批放弃；程序不得代选。运行中改卡经命令校验，在边界切换版本；并行任务不能通过去掉验收绕过底线。

第 4 步保留 `[人工]`、`[授权]` 语义：缺真实授权停对应检查、人工结论单列，不把它们写成自动通过。第 5 步不得删除表外能力，不以删测试消除失败。

后续仍按五步顺序推进。当前用户已授权从第一步分支直接准备并继续第二步，第二步使用同一方案和同一任务文件；第 3—5 步不在本次实施授权内。

## 第 2 步实施方案

### 1. 基线与真实接入点

本节设计依据来自方案阶段对工作区 `f014331` 源码及相关测试的只读核对；只读第一步工作区的 HEAD 当时也为 `f014331`。不读取桌面 dev 的未提交产品代码作为开发或运行基线。方案阶段未执行下面列出的程序验证；阶段 B 的实际证据见实施记录。

| 当前调用点 | 第二步的最小接法 |
|---|---|
| `readDevelopmentCard()` 仅允许两个第一步 flow，任务字段不接受 test | 保留 version:1、单任务、dev 和底线校验，扩展测试字段与节点独立限额；提出卡先只读校验，再允许任何副作用 |
| Pi `agent_before_settle`、Hook `Stop` → `completeManagedDelivery()` → `executeNode(开发评审)` → 直接 `mergeManaged()` | 把评审后的直接合入改成固定节点推进函数；按账本依次选择测试、提交，不调用旧 review/pipeline 组合层 |
| `executeNode()` 把非开发节点都当作 submitting，`checkInputs()` 给所有节点同一个哈希 | 活动身份改为通用执行阶段，按节点取得相关输入；排队身份与实际执行活动分开；结束仍由 `finishAttempt()` 拦截迟到结果 |
| `qualification()` 给所有缺项打印续跑，`queryKernel()` 默认开发评审且固定写未安排测试 | 用结构化缺项与当前停点生成重跑/续跑命令；所有入口和总结从同一节点行渲染当前有效结论 |
| `reviewDevelopment()` 只按 `run.repairs` 判断静态必修返修 | 保留此计数语义；测试产品返修使用测试自己的计数，不借评审计数，不读取开发节点私有 state |
| `managedLaunchArgs()` 可精确恢复原会话，但没有机器测试返修投递；新卡 `hosts/dev.ts` 目前走普通 spawn | 正常交付边界继续复用 Pi 的原回合 continue 和 Hook 的 block；独立测试重跑另接带身份的机器信封、原生收件与精确恢复，不能把返修当用户输入 |
| `stopKernel()` 只处理 launch/supervisor/review.procs；`releaseKernelWorkspace()` 只接受已合入 | 纳入测试 worker、测试进程登记、本机票据；共享安全释放逻辑增加明确放弃情形，不按文件名或 PID 猜归属 |

固定执行器仍由 `kernel-session.ts` 装配。内核只处理卡、候选、通用输入/结果/计数与活动身份；开发评审、测试、提交实现不互相导入。只增加直线编排所需的推进分支，不建立可注册插件、任意图或另一套旧流水线。

### 2. 卡、命令与独立预算

新增支持 `[开发评审, 测试]`、`[开发评审, 测试, 提交]`，第一步两种 flow 不变。评审、验收、部署及多任务卡仍按原底线/未上线提示拒绝；`nature` 仍只能是开发。

```json
{
  "version": 1,
  "name": "单任务测试示例",
  "nature": "开发",
  "target": "dev",
  "flow": ["开发评审", "测试", "提交"],
  "tasks": [{
    "name": "甲",
    "prompt": "../../prompt/提示词-示例.md",
    "scope": ["src/example.ts", "test/example.test.ts"],
    "test": "node --test test/example.test.ts"
  }],
  "limits": {
    "开发评审": { "maxRepairs": 4, "timeoutMin": 60 },
    "测试": { "maxRepairs": 3, "timeoutMin": 20, "maxRecoveries": 1 }
  }
}
```

- `tasks[0].test` 是卡上唯一测试命令，含测试节点时必填：非空、无 NUL 的单行字符串；显式 `无：<非空原因>` 表示没有可跑测试。无测试节点时可保留该字段作后续受控加节点使用，但绝不执行。空值、空原因、未知任务/限额字段在建分支前报错。命令从任务 worktree 根运行，不从卡目录或桌面运行版运行。
- 字段默认值为测试返修 3 次、每次测试节点执行预算 20 分钟、自动恢复最多 1 次；这些是实现缺省值，不是新增业务验收要求。maxRepairs/maxRecoveries 为非负安全整数，timeoutMin 为正安全整数。开发评审仍是 4 次、每轮 60 分钟；不要求测试时限小于评审时限。
- maxRepairs 计“已发起的产品返修”，不是命令启动次数。第一轮失败且尚有额度时，先登记返修编号再回发；额度 3 允许三次产品返修，之后仍失败才停。静态必修只增加开发评审计数，测试产品失败只增加测试计数。环境/方法/未知、超时、中断、排队、恢复均不增加产品计数。
- 一个测试尝试取得本机槽后开始 deadline；原命令、恢复动作和同命令重试共用剩余时间，恢复不能刷新 deadline。排队不占测试预算。显式重跑形成新尝试和新 deadline，但已用产品/自动恢复计数持久保留；改卡只改上限，不清零已用次数。安全收尾有界执行，预算耗尽不再启动命令，也不能省略收尾来释放槽。
- `无：原因` 不排队、不执行、不扣次数，留下“没验证：原因”记录；它不是通过。卡上仍保留必需测试时，普通合入仍缺该结论，只能经受控去掉测试或真实用户例外处理。

### 3. 账本、节点输入与历史兼容

在现有账本增量增加：输入格式版本、卡版本/改卡历史与 pending 请求、按节点的产品返修/恢复计数、执行控制代次、测试排队/worker 身份、阻塞节点、机器返修信封及回执、放弃和保留记录。尝试继续使用 UUID；保存 command、cwd、完整输出日志、退出码、取消/超时事实、开始/截止/结束时间、原始失败分类、恢复动作与资源释放证明。开发评审的旧 repairs 映射到本节点计数，不改历史含义。

把 `checkInputs()` 的文件取证与输入投影分离：取证继续复用同一次字节读取、用户引用确认哈希、来源检查和发布转换证明；不能因拆哈希删掉这些保护。

| 身份/投影 | 内容与失效范围 |
|---|---|
| 公共检查输入 | 真实用户版本、需求/标准/授权原文及已确认引用、规则、非 code 来源、任务身份及有语义的本机输入；这些改变会影响相关检查，引用内容未重新确认时直接阻止推进 |
| 开发评审输入 | 公共输入 + prompt/scope + 有效评审模型/思考/命令及评审 timeout；不含测试命令/测试限额、flow 的测试开关或卡的格式、展示名称 |
| 测试输入 | 公共输入 + 卡上精确测试字符串 + 测试 timeout + 实际使用的准备/恢复方法配置和本机方法内容；不含评审模型/评审限额。任务树另行绑定，不以 HEAD 提交号代替树 |
| 发布/用户例外输入 | 当前 flow/必需集合、卡版本、所有相关节点投影和完整输入快照、用户版本；仅测试变化也必须使旧例外决定过期，提交边界再次核对 |
| 原卡字节哈希 | 单独用于直接编辑检测和改卡事务，不再把整卡原始字节塞进所有节点输入 |

`.autoreview.json` 的已知有效配置按实际消费者投影，不能一边移除卡哈希、一边仍以整份 configurationHash 间接耦合测试和评审。旧 gate、未安排的验收/部署不进入新卡检查或执行；未知语义的本机文件仍保守纳入相关公共输入，不猜测“无影响”。原目录/任务目录的配置差异继续可见，不静默覆盖本机文件。

只改测试命令或测试 timeout：保留当前树的开发评审，通过测试的旧记录留历史但不再授予新测试资格。只调产品/恢复次数上限不改变已通过结论；改评审 timeout 只使评审输入变化。改展示名或 JSON 排版不使检查重跑。去掉测试只改变必需集合，不删除或涂改此前失败。源码树、索引、未跟踪内容和输入保护仍由 `currentCandidate()` / `workspaceGuard()` 检查。

`validResult()` / `finishAttempt()` / `qualification()` 必须使用同一节点投影；提交的综合指纹不得拿去查评审/测试结果。保留通过、证据存在、结束及 released 的全部复用条件；同树压缩不复查，代码改变后的旧结论保留为历史、不授予当前资格。

历史 v1 记录不直接冒充新投影：未改卡的第一步 run 可继续用原完整指纹核对原结论；首次需要转换时，仅可依据保存的 frozen-card、inputs.json 等完整证据重建并核对投影，记迁移来源。缺快照就明确缺项、回原会话重交付，不能凭新卡 hash 补造通过。查询不做迁移或写盘。

### 4. 跨仓库本机执行槽

新增 `local-node-queue.ts`，默认全用户本机路径 `~/.pi-autoreview/local-node-queue/queue.json`，固定一个槽；不能按仓库、卡路径、Loop checkout 或 `AUTOREVIEW_KERNEL_ROOT` 分出多个生产队列。仅提供 `AUTOREVIEW_LOCAL_QUEUE_ROOT` 供定向测试隔离；同一测试中的多个仓库、进程必须共用该根。队列接口接纳固定的测试/验收名额类型，但本步只装配测试，不接入验收节点。

1. 在账本先登记执行请求，再用 `eventLock()` 短锁原子登记 FIFO 票据；用同一个 UUID 幂等关联两处记录。票据绑定 canonical ledger、Git common-dir、run/task/node、候选树、节点输入、控制代次、worker PID/启动时间/随机 owner，以及独立 procs 文件/资源 ID。名字相同不能串票。
2. 等待由本次受管 worker 异步轮询，不占账本锁、发布锁或全局短锁；全局锁只做登记、选择、状态 CAS。把现有 executeNode 的启动边界细分为 request → waiting → executing → finalizing：先持久化 attempt.json/请求身份，取得槽并在同卡控制边界取得执行权后才登记实际 activity、开始 deadline 和调用执行器。取槽前、执行器真正启动前各重读卡、候选、输入、前置评审、停止/放弃和控制代次，失效就取消自己的票据，不启动旧命令。
3. 排队票据不设置为实际节点活动。状态为“等你决定：甲 / 测试 / 本机排队第 N 位（自动等待，无需操作）”，另列 waiting worker 存活信息；只有命令或有界恢复真实执行才显示进行中。队列位置只读计算，查询不派工、不清孤儿、不调用模型。
4. 测试成功、产品失败、非产品失败、取消或异常均在 finally 核对本次消费者/临时资源，再按票据 token 释放。有限恢复仍占同一个槽；转返修或等待用户之前必须释放。可正常释放的失败不得拖住别的批次。
5. 停止/放弃先撤销 run 控制代次，再取消本批 waiting 票据、向已登记 worker/测试进程发取消，等待释放回执。不能撤销另一批票据或提前把仍运行的槽让给下一批。
6. worker 死亡不等于测试后代退出。派工/显式恢复命令可在短锁取得“核对释放”责任后，放锁，按登记调用 procs/resources 补偿，再持短锁 CAS 释放旧票。扫描失败、身份未知、登记损坏或消费者释放未确认时保留占位并通知；这是资源安全阻塞，不是假称已释放。不能按超时、锁年龄或 PID 猜测抢槽。只读查询绝不执行此补偿。
7. 不跨异步执行持有全局锁，也不在全局队列锁内取得账本写锁；需要更新两处时按请求 ID 重读/CAS、可恢复落盘，防止停止、取消、放槽竞争或进程中断造成重派。

### 5. 测试执行、失败归因与有限恢复

新增 `test-node.ts`，只接收统一 NodeInput/返回 NodeOutput；不导入开发/提交节点。入口装配执行依赖：`createChildExec(<本尝试 test.procs.json>)`、`createRunResource()` / `managedShell()`、`classifyFailure()`。通过 `/bin/sh -c` 原样执行卡上那条命令，cwd 为任务目录；包装只设置受管运行/证据/临时目录、身份和预算，不拼入额外测试。输出和临时产物在登记目录，完整日志/原始退出事实先保存再分类，不以截断尾部作唯一依据。

成功须同时满足退出 0、未超时/取消、原始工作区与索引未变、相关输入未变、消费者及临时资源释放确认。缺释放证明即使退出 0 也不能通过。测试或恢复写了产品内容，整次结果中断、旧评审不再对新内容有效，停止并给原会话交付入口，不能偷偷提交这些改动。

| 分支 | 账本与后续 |
|---|---|
| 产品断言/编译失败 | 原输出、命令、候选树、证据路径返回内核；有测试返修额度则幂等登记测试返修并回同一开发会话，不扣评审次数；到上限停在测试节点通知 |
| 环境/方法/未知 | 保留已通过评审，只暂停当前测试；在独立恢复额度与本次 deadline 内先使用已登记的适用恢复方法，再重试同一测试命令；仍失败给三条处理命令 |
| 超时/用户取消/调用入口错误 | 明确保存超时或取消事实，不仅看输出中的 FAIL；不算产品返修；用户主动停止后不自动恢复或回发开发 |
| 无测试原因/缺证据/释放未确认 | 没验证或中断，不包装为通过，不自动合入 |

共享 `failure.ts` 按有效故障来源分类：通过项/标题、引用与代码样本、expected/actual、孤立 ENOSPC 不作为存储错误；实际错误行的 ENOSPC/存储故障仍优先保护，并保留与 product 声明的冲突说明。其余显式 75/78、AUTOREVIEW_FAILURE 与有效故障证据冲突时记 unknown，模糊失败也不猜产品。端口 EADDRINUSE/address already in use 沿用已有识别。反例必须包含“通过名含 ENOSPC + 真实产品断言”，disk/full 不能替代该覆盖。只有输出证据明确为产品才退回开发。

恢复优先复用 `runPreparation()` 的已有 check/recover 与资源登记：给它独立持久化的测试恢复 state，按本次剩余时限裁剪，关闭 repair 模型和所有产品写入路径。环境有已登记 recover 才执行该动作；方法/未知可先运行已有只读 check 诊断，不能调用受限修复模型改源码或降低标准。没有适用方法时记录原因，最多按尚余恢复额度重试同一条测试命令；不能无限试探、安装依赖、杀占端口的未知进程或调用旧全量检查。

一次 maxRecoveries 额度明确指“一轮至多一次适用 recover（及只读条件复查）+ 至多一次原测试命令重试”，进入该轮前先持久化消耗 1；缺 recover 时仍最多重试一次原命令。调用准备服务时将其内部环境恢复次数裁剪为本轮至多一次且不超项目原上限、方法修复次数设 0，不能让准备服务和测试外层各自再展开完整重试循环。已用轮数及准备服务动作计数均保留，重新评审、续跑、机器消息不清零。恢复执行失败或释放未确认时不得启动下一条测试；缺适用方法但允许原命令重试的情况也必须先确认上一调用已释放。额度耗尽或仍失败按需求第 6 节通知，不把环境修复算业务返修。

### 6. 固定推进与同一会话返修

`completeManagedDelivery()` 保留“程序提交 → 开发评审”原子循环。开发评审通过后调用固定的 `advanceManaged()`：读取卡及账本 → 测试（若安排且无有效结果）→ 提交（若安排且所有必需检查有效）→ 结束。推进函数和命令入口共用，不把调度写进 `reviewDevelopment()` / `submitCandidate()`。

- 有效通过直接复用；无测试安排不创建测试尝试。测试返回产品失败时，内核生成含完整实际命令、退出事实、失败输出、候选及证据路径的机器返修消息，测试自己的返修计数先于投递持久化，同一失败尝试不重复扣数。
- 原交付调用仍在时，最终 NodeOutput.message 经 `kernel-pi.ts` 的原 `agent_before_settle` continue 或 `hosts/kernel-hook.ts` 的 Stop block 返回；不先宣布评审完成/可合入。代码修好再交付仍走 deliverCandidate → 开发评审 → 测试；测试次数不挤占评审次数。
- `重跑 --node 测试` 不调用 deliverCandidate、不启动评审模型、不重开开发会话。先只读核对当前树的有效开发评审；缺失则拒绝并附精确续跑命令。测试通过后仍按当前 flow 推进，未安排提交不暗加提交。
- 独立重跑若再次出现产品失败，登记机器返修信封：绑定 run、原 session host/id、失败尝试、候选、节点输入、userVersion、控制代次、随机 token 和内容 hash，状态区分 pending/sent/read/unknown。Pi 复用已有发送/原会话收件方式；Claude/Codex 复用 `hosts/native-inbox.ts` 的 nativeLaunch/sendNativeRepair，不复用旧 ReviewState/合入队列 state。
- `hosts/dev.ts` 增加“受管新卡”启动分支，为该原宿主登记真实 child PID/启动时间和私有原生通道；Hook 绑定本次启动/会话凭据。不能误以为当前新卡已经装配了旧队列的收件桥。原宿主已退出时由 runtime 按原 Pi 日志/宿主 ID 精确恢复，带一次性机器信封路径；不发送原始任务作新用户需求、不选择最近会话、不新建替代开发会话。
- 机器信封在 Pi input / Hook UserPromptSubmit **先于** recordManagedUserInput 校验并消费；仅匹配显示前缀不足以证明机器来源。文件内容、会话、尝试/代次或 token 不符时不消费，也不授予用户授权。真实用户的新消息/撤权照常登记并撤销旧资格；机器返修不增 userVersion、不替换标准/授权、不清零任何次数。`attachSession()` 不得无条件清掉另一个节点/worker 的执行身份；`developerActive()` 不能覆盖在途测试。真实用户要重新开发时先撤销旧请求、取消测试并确认其停止，再进入开发边界，不能让同一任务测试与源码编辑并行。
- 投递成功不等于已读取，回执落盘后才标 read；重复投递/恢复不重复返修。原会话活着但归属/通道未知时保留 pending/unknown 并给完整恢复命令，不强杀用户会话、注入终端输入或新开一个会话。先释放测试槽，再处理恢复/回发，不让等待模型或用户占本机名额。

### 7. 命令、改卡事务与放弃

以下是第二步要真实实现的命令，不是现在可执行的功能。都支持 --dry-run（纯读、无票据/worker/卡写入）与 --json；缺参、重复/越权选项、未登记卡明确拒绝，不回退旧引擎。`kernelCommand()` 扩展为安全 argv/参数引用生成器，必须保留中文、空格和单引号路径。

```bash
bin/loop 重跑 <开发卡.json> --node 测试 --json
bin/loop 重跑 <开发卡.json> --node 开发评审 --json
bin/loop 改卡 <开发卡.json> --remove-node 测试 --json
bin/loop 改卡 <开发卡.json> --from <替换卡.json> --json
bin/loop 放弃 <开发卡.json> --json
```

单任务隐含唯一任务，不提前加入多任务选择/移出任务命令。重跑仅接受本步开发评审/测试；已有效通过的节点返回复用而不强跑，提交仍用统一合入，不借重跑自动重推。`续跑` 按真实停点选择原开发会话或已通过评审后的测试推进，不再无条件拉起开发；任何恢复都不清零计数。重跑/续跑接受 --launcher background，--json 也后台派发登记 worker；前台等待同一执行结果。改卡/放弃本身不接受 --launcher：改卡返回请求/应用事实，应用后需执行下游时由同一登记推进 worker 承接并返回身份，放弃等待有界安全收尾。仅派发时明确写“已派发”，不冒充测试通过。

非产品失败通知与总结必须完整给出本卡的三条命令（真实绝对 bin/loop、卡路径及 cd，经统一引用）：

1. `重跑 <卡> --node 测试 --json`：外部环境修好后，只重跑测试。
2. `改卡 <卡> --remove-node 测试 --json`：重新校验并移除测试，边界生效后按保留下来的必需结论继续。
3. `放弃 <卡> --json`：保留成果和证据后停止并安全释放。

有资源未确认时，命令先核对/收尾登记资源再继续，绝不绕过身份保护。产品到上限也列明原因、原会话续跑及改限额入口，不替用户清零或擅自放弃。

**受控改卡事务：**

- `--remove-node` 与 `--from` 二选一；替换文件只提供内容，所有 prompt 等相对路径仍按原卡目录解析。复用同一个只读解析器（拆出按内容解析函数），不能先写原卡再发现不合法。
- 本步支持修改展示 name、合法 flow、任务 test、节点 limits；base/target/nature/host、任务数量/身份/prompt/scope 为启动时任务与会话归属，运行中替换它们明确拒绝，须另建卡，不静默换任务/范围。仍验证全部底线；开发评审不可移除，不能加未上线节点或去掉多任务必需验收。保留已有用户引用确认规则，改卡不是确认新标准或授权的入口。
- 命令核对原卡字节与当前冻结版本，保存请求 ID、原/新原文和规范卡、请求时间、差异、预期 cardRevision/hash；只允许一个 pending 请求。活动节点中仅登记请求，不改原文件/执行中命令；在下一个节点完成且释放、下一节点尚未取得运行权的边界重验并生效。没有活动节点时该命令本身就是边界，可立即切换并按账本继续。排队尚未执行也属于可切换边界：撤销旧请求控制代次/票据，再按新输入排队；与 worker 取执行权共用同卡控制边界，不能把 waiting 误当空闲而同时启动新旧命令。
- 用账本短锁/同卡控制锁序列化“生效与下一节点派发”，保存 prepared 写前意图和原文备份，再原子安装新卡与冻结快照，最后登记 applied 时间/新版本/失效节点并推进。替换前重核文件身份和预期字节；发现非预期编辑就保留观察到的原文、拒绝覆盖。pending 请求与当前尝试分别绑定版本，旧节点结果先按旧输入留证，再计算新卡下资格，不能用迟到返回按新输入记通过。
- 中断恢复仅接受原 hash 或本事务精确新 hash：原 hash 可继续未完成事务，新 hash 可按写前意图核对收尾，其他内容一律暂停、保留三方原文；查询只展示、不补偿。请求/准备/应用/拒绝/中断原因和时间永久保留，初始 frozen-card 原文也归档，不能覆盖到无法追溯。直接编辑在任何进出边界发现都暂停/通知，不悄悄采纳或报告成内部错误。
- 应用不触碰候选代码或清零次数；只使相关投影失效。移除测试且评审仍有效时可直接推进提交；修改测试命令则仅执行新测试；增加测试必须补当前树的测试结论；未安排提交时仍只到可合入。卡版本变化使旧用户例外决定失效。

**放弃：**

- 是显式终态，不等于停止。先保存放弃意图、当前候选/真实 HEAD、任务分支和不可变保留 ref、现有日志证据清单，再撤销控制代次，禁止迟到输出发布或再次派工。已实际合入的卡不能伪造为已放弃，保留已合入事实，只收尾其资源；放弃不是回滚/撤回/推送入口。
- 取消自己的 waiting 票据，按 immutable launch/worker/进程组身份停本批消费者；收尾后再次核对 HEAD、索引、跟踪/未跟踪/忽略文件、本机文件哈希及 worktree/common-dir/分支归属。未提交或用户暂存成果保留在原目录，不擅自提交、reset、stash；未知忽略文件、被改本机文件或父目录未知内容也保留。
- 仅在成果已由分支/ref 保存、消费者和槽已释放且目录无未保存内容时，复用原安全 worktree 删除路径；原样登记本机文件可随 worktree 移除，父目录只 rmdir 已登记空目录。保留任务分支、历史 ref、账本、输出日志、失败/中断证据和改卡史。
- 标“已放弃”与“资源已释放/未确认”分列；不能删除时列具体路径/原因，返回未完成资源收尾而不宣称交付完成。重复放弃幂等，仅核对本次未完成收尾，不能清掉其他卡资源或历史。

### 8. 状态、合入、通知与总结

`queryKernel()` 继续是五态纯读入口。没有实际节点执行不能显示进行中；增加 blockedNode、waiting/ticket、当前节点有效性、计数/限额、deadline、pendingCardChange、repairReceipt、abandonment 等明细，不从旧 phase 推断状态。无活动时 node 取真实缺项/阻塞节点，不再固定开发评审。Pi、两个 Hook 和终端只渲染同一查询结果。

当前结果每任务/节点一行：实际命令或操作、当前结果/历史已失效原因、commit/tree/输入版本、证据、资源；测试无安排写“没验证（本次未安排）”，无测试原因和受控移除单列，验收/部署未安排绝不假称通过。保留历史失败及改卡前原结果，不把环境恢复写成产品返修。

提交边界将每个前置节点的输入指纹与实际通过记录 ID 固定在 `publication.nodeChecks`；已发布的查询/总结据此及原证据展示，不因合法删除 worktree 重算失效，例外欠项不补成通过。普通合入按每个必需节点自己的当前输入核对；前者全部有效时不重评审/不重测试，变树/输入/索引/证据缺失按节点列欠项并给已实现的重跑或原会话续跑命令。处于排队、消费者未释放、直接改卡/事务未收尾时不能借普通或例外入口绕过安全检查。

继续使用统一 `mergeManaged()`、`submitCandidate()` 和真实用户输入/TTY 决定机制；例外只豁免明确接受的检查欠项，不豁免候选、卡、资源、main/目标保护。综合输入/卡版本、候选或标准变更必须重新确认。记录测试不通过/没验证、用户原话来源与时间，绝不改写检查通过。仍只推 origin/dev，不推任务分支，不自动重试推送；本地合入、远端结果、资源释放分别报告。

成功、失败到上限、非产品恢复耗尽、直接改卡、改卡应用/拒绝、放弃和释放故障均走同一总结/通知渲染；先写证据/状态再通知，通知失败仅记录，不篡改节点结论。交付总表的 test 值取当前账本，不再固定未安排或仅取评审输出；流程最终停在测试时，即使评审已通过，也不能把该批写成可合入。

### 9. 文件落点与实施顺序

| 最小文件集合 | 变更 |
|---|---|
| 新 `test-node.ts`、`local-node-queue.ts`、`kernel-controls.ts` | 分别实现命令节点、跨仓库 FIFO/归属释放、受控改卡事务；不新建通用流程引擎 |
| `development-card.ts` | 内容解析复用、测试字段/独立限额/新 flow 与受控变更校验 |
| `node-ledger.ts`、`kernel-workspace.ts` | 增量账本、每节点输入与综合发布输入、版本/计数/历史及候选保护 |
| `kernel.ts` | 通用执行边界、排队与实际活动区分、逐节点资格、统一状态/总结/补救命令 |
| `kernel-session.ts` | 固定装配和推进、产品返修归属、机器信封/回执、最终交付记录 |
| `kernel-runtime.ts` | 测试 worker 的派发/取消、按停点恢复、精确恢复原会话、安全放弃/释放 |
| `loop.ts`、`kernel-cli.ts` | 参数/帮助/命令分派、dry-run、JSON 与新卡不回退保护 |
| `kernel-pi.ts`、`hosts/kernel-hook.ts`、`hosts/dev.ts` | 原回合返修、独立重跑后的机器来源校验/原生收件与原宿主绑定；不改全局信任/权限 |
| `development-node.ts`、`submission-node.ts` | 仅适配各自输入和统一当前检查展示；提交保留全部 CAS/目标工作区/用户例外/推送保护 |
| `failure.ts` | 明确端口环境归因及必要反例；其余优先直接复用 |
| `README.md`、`工具清单.md`、`项目文档/运行与维护.md`，必要的 `production-loop.ts` 指路及其契约测试 | 只同步当前新卡字段、命令、能力边界和指路标题；保留旧历史说明，不改接入项目规则或用户验收标准 |
| `test/kernel.test.ts`、新 `test/kernel-test-node.test.ts` / `test/local-node-queue.test.ts` / `test/kernel-controls.test.ts`，受影响的宿主/归因/工具清单测试 | 复用 node:test；必要时抽取现有 kernel fixture 到 `test/helpers/`，不建第二套框架 |

`resources.ts`、`procs.ts`、`preparation.ts`、`hosts/native-inbox.ts` 默认直接复用；确需增加受管上下文/释放身份参数时才做最小改动并配对应测试，不顺便整理旧模块。外层 Loop 的第一步运行工作区、桌面仓库始终只读。

实施依赖顺序：卡/账本/输入投影与反例 → 本机队列取消/释放验证 → 测试命令与恢复 → 固定推进/原会话回发 → 三条控制命令与事务/放弃 → 统一展示和集成定向检查。每批通过最小必要检查后继续，不逐步等用户验收；方案阶段仅记录设计，阶段 B 按该顺序实施并核实。

### 10. 定向验证计划与需求映射（实施后执行）

| 原要求 | 定向程序验证，不代替真实业务验收 |
|---|---|
| A2 / 第 1、4、6 节 | 精确记录只执行卡上测试；断言失败回原 session；修改后评审、测试顺序正确；评审/测试各自计数和上限，机器消息不改变标准/授权 |
| A3 / 第 6 节 | 环境/方法/未知与端口、超时/取消，恢复有界且 deadline 不刷新；三条命令可解析；测试重跑不调用评审，原通过证据仍有效 |
| A7 | 同树/同输入不产生新检查；压缩提交复用；代码、索引、未跟踪/输入变化拒绝；只改测试字段不重评审，测试变更使旧例外决定失效 |
| A8 | 测试停点、排队、无消费者、进程身份未知；Pi/Hook/CLI 同一五态和原因；普通合入列任务/节点/树/缺项及完整命令，查询不改盘/恢复/派工 |
| A9 | 在临时仓库和本地 bare origin 验证真实用户来源/TTY 例外；机器/文件伪授权拒绝；保留欠项、时间和原话，不伪造测试通过，只推 dev |
| 第 3、5 节本机名额 | 独立 CLI 进程、不同仓库/不同卡共用队列，以文件屏障/真实起止区间证明不重叠和 FIFO；失败/取消释放后下一张继续，死 worker 后代未确认时不能抢槽；同名卡不串取消 |
| 第 8 节 | 运行/静止时合法改卡、底线拒绝无副作用；在途结果/改卡边界竞争、prepared 两端中断、直接编辑、历史/时间保留、仅受影响节点失效 |
| 第 7、11 节资源边界 | 停止不等于放弃；放弃保留分支/ref/证据；干净目录释放、脏文件/用户暂存/未知忽略/本机变更/错误归属全部保留；迟到回调不复活，重复命令幂等 |

优先逐批执行新增/受影响文件，例如：

```bash
cd /Users/Admin/.pi-autoreview/worktrees/loop-kernel-step2
node --test test/kernel-test-node.test.ts test/local-node-queue.test.ts test/kernel-controls.test.ts
node --test test/kernel.test.ts
# 仅在改动触及下列能力时选择对应文件，不把它们当额外固定全量：
node --test test/failure.test.ts test/procs.test.ts test/resources.test.ts
node --test test/host-dev.test.ts test/tool-manifest.test.ts test/single-entry-docs.test.ts
```

测试夹具的 kernel/resource/projects/local-queue 根、通知配置、Git 仓库及 bare origin 全在系统临时目录，按登记释放；不能读取或派发本机真实卡、污染真实全局队列、发真实桌面通知或推真实远端。并发测试用就绪屏障和真实登记条件，不靠固定等待制造通过。改变第一步“测试尚未支持”的断言为“缺测试命令拒绝/合法测试卡可解析”；未上线评审/验收/部署和非法底线断言保留。新增四种 flow 的准确测试/未安排显示，不把旧单会话测试断言改成卡语义。

最终仅对本次受影响集合做一次集成复核；不运行 `test/*.test.ts`、`test/e2e.mjs` 或真实业务卡，不删旧测试。若节点接缝使既有断言需变化，交付逐条列明原断言、新行为及需求依据。真实模型、真实 Pi/Claude/Codex 装配/信任、真实 origin/dev 发布、第一步自举与第二步业务验收均另列未验证，不能由这些替身程序检查推定通过。

阶段 A 交付时的历史记录：A2、A3、A7—A9 及第 6、8 节当时仅完成纸面覆盖，第二步代码、程序验证、真实装配和业务验收均未执行；随后方案已通过外层 Loop 静态评审，协调方已明确继续实施。当前阶段 B 的实现/检查事实见下一节，真实装配与业务验收仍未执行。

## 阶段 B 实施与验证记录

已完成测试节点、本机跨仓库 FIFO、按节点输入投影及独立计数/预算、固定推进与同会话回流、重跑/改卡/放弃、统一查询/通知/总结的实现和受影响程序验证。保留第一步提交与原会话入口，不实现后三步或真实发布。本轮所有 Git 发布程序场景仅使用临时仓库及本地 bare origin；未提交或推送本开发分支。

- 改卡请求新增真实发起来源及用户版本，移除必需测试/改为无测试必须真实终端或绑定当前卡的原会话用户决定，机器返修不能自行移除。
- 机器回发在共享入口核对**实际接收完整正文**及哈希；文件引用必须是精确单一引用包装，Claude 原生包装须同时匹配本次宿主启动/通道。正确 token 下篡改正文、追加撤权、引用后追加内容不被吞为机器消息，真实输入照常更新。
- 恢复实现调整：直接复用项目已登记 preparation check/recover 配置、受管 exec/resources/procs，而不调用包含方法修复模型/内部重试循环的旧组合服务；每轮恢复与一次原测试重试仍用同一剩余预算。未增加依赖或模型修复调用。
- ENOSPC 补修前的受影响集成检查 **108/108 通过**（退出 0）：`node --test test/kernel.test.ts test/kernel-test-node.test.ts test/local-node-queue.test.ts test/kernel-controls.test.ts test/failure.test.ts test/procs.test.ts test/resources.test.ts test/host-dev.test.ts test/tool-manifest.test.ts test/single-entry-docs.test.ts test/production-loop.test.ts`。完整日志 `/var/folders/11/sxl0444d11xbqzz8pz0lr2nm0000gp/T/loop-step2-integration-final.TyXNV3`。包含最后 parser 对命令原始字节（末尾转义空格）的反例、真实 CLI/Pi 生命周期替身的测试返修到 dev/bare origin、两宿主实际启动/原生通道回同一 session、跨仓库排队/取消/改卡、放弃与发布保护。
- 集成后静态收尾补严队列缺少 procs/归属字段不能视为无消费者、cleanup 登记未知时不能先删资源；只重跑受影响队列文件，**4/4 通过**（退出 0），日志 `/var/folders/11/sxl0444d11xbqzz8pz0lr2nm0000gp/T/loop-step2-queue-final.Ix59j6`。其余已通过检查无新影响，不重复扩大。
- 本轮按旧问题去向补修此前遗漏的「门禁误把测试失败判为磁盘不足」根因：共享分类器不再对整份输出任意 ENOSPC 优先归环境，按真实故障行识别；保留真实写入/存储错误优先，记录有效故障行与冲突声明，其他冲突或模糊输出记未知。问题单仅只读核对、未改写或关闭。此前 108 项证据不覆盖该误判，不冒称先前已解决。
- 本轮最小复核：`node --test test/failure.test.ts` **11/11 通过**（含通过名+断言/显式 product、真实 ENOSPC+衍生断言、引用样本、相互冲突声明与未知），日志 `/var/folders/11/sxl0444d11xbqzz8pz0lr2nm0000gp/T/loop-step2-enospc-classifier.nMyfxA`；`node --test --test-name-pattern 'ENOSPC|A2 产品测试失败' test/kernel-test-node.test.ts` **2/2 通过**，日志 `/var/folders/11/sxl0444d11xbqzz8pz0lr2nm0000gp/T/loop-step2-enospc-node.f06mmU`。后者实际执行受管命令并以四组可控故障输出验证：通过名不吞原会话产品返修、真实存储/冲突/未知不扣产品次数、原开发评审仍有效及槽释放；不是仅测字符串，也不冒充真实填满磁盘或原项目事故验收。其余既有通过证据保留，不扩大复跑。
- 外层第 2 轮三项必须修改已补修，原始评审 `/Users/Admin/.pi-autoreview/loop-kernel-step2/01a1b351-e690-7323-81b7-3b07da9924b5.md` 只读保留：① 同次自动重试最终成功时清除本次局部旧 failure，终态按最终退出/释放事实决定，首次失败的原始 calls/日志保留；② `loop-kernel` 原生回发对 Codex/Claude 的明确拒绝和异常应答均报未确认、保留原信封/计数并通知恢复入口，不再记 sent；③ 发布时绑定每个前置节点的实际输入/通过记录，清理后按绑定及证据展示，保留例外欠项，不重写结果历史或计数。
- 第 2 轮三项补修时针对三项及 ENOSPC 的最小复核：`node --test --test-name-pattern '同次尝试|A7/A9|loop-kernel 原生拒收|新卡 Claude/Codex 实际启动|ENOSPC' test/kernel-test-node.test.ts` **5/5 通过**，日志 `/var/folders/11/sxl0444d11xbqzz8pz0lr2nm0000gp/T/loop-step2-r2-repairs.WL7abV`。含首次 75/自动重试 0 后直接提交、两宿主拒绝/损坏应答、两宿主正常原生投递对照、正常及例外发布清理前后结论/欠项一致、历史/计数不变。
- 发布接缝的受影响回归：`node --test --test-name-pattern '自动交付提交|同树不新增|目标前进产生|资源保护|真实 bin/loop|修改已登记 guide' test/kernel.test.ts` **13/13 通过**，日志 `/var/folders/11/sxl0444d11xbqzz8pz0lr2nm0000gp/T/loop-step2-r2-publication.GJIDeL`；共享分类 `node --test test/failure.test.ts` **11/11 通过**，日志 `/var/folders/11/sxl0444d11xbqzz8pz0lr2nm0000gp/T/loop-step2-r2-failure.CqEpn0`。未重跑无关集合、未清零外层轮次或产品计数，未改动历史评审/暂停记录。
- 本次自动评审第 1 次返修第 1 条：**已修**。`failure.ts` 仅为真实命令错误前缀补回既有 `mc:`，继续排除通过项/标题、引用及代码样本，不退回整份输出任意关键词匹配。保留 `test/review.test.ts:21` 的原断言不变；新增 mc 水位诊断伴随 `AssertionError: upload failed` 的实际节点覆盖，确认进入有限环境恢复、测试产品返修计数为 0、不给开发会话发产品返修、原开发评审仍有效且槽已释放。旧历史及全部计数不清零。
- 本次最小复核：`node --test test/failure.test.ts` **11/11 通过**，包含真实 mc 错误/衍生断言及通过标题、引用/样本对照，日志 `/var/folders/11/sxl0444d11xbqzz8pz0lr2nm0000gp/T/loop-step2-mc-classifier.vcwre1`；`node --test --test-name-pattern '失败归因：资源错误|ENOSPC 共享归因' test/review.test.ts test/kernel-test-node.test.ts` **2/2 通过**，复用原有存储水位断言并验证实际节点分流/有限恢复，日志 `/var/folders/11/sxl0444d11xbqzz8pz0lr2nm0000gp/T/loop-step2-mc-routing-final.yAmwCq`。其余通过证据保留，不扩大复跑，不处理本轮未要求的小问题；真实 MinIO/业务验收仍未验证。
- 已修正的验证失败：生产指路仍断言第 1 步标题、工具清单提取未覆盖旧有整合命令，按实际标题/白名单同步后契约检查 17/17 通过。首次集成 107/108 的唯一失败为新增原生宿主替身源脚本无执行位，改用已有夹具相同的私有可执行 Node 包装后，用例复核 1/1 通过（`/var/folders/11/sxl0444d11xbqzz8pz0lr2nm0000gp/T/loop-step2-native-recheck.wmgwZV`），随后纳入上面的 108/108 集成。原失败日志 `/var/folders/11/sxl0444d11xbqzz8pz0lr2nm0000gp/T/loop-step2-integration.pAm9mO` 保留；未降低或跳过断言，不计业务返修。
- 此前 pi-lens 曾对 16 个产品路径实际发起诊断（不代表本轮最终代码的完整 LSP 结论），返回 23 条辅助 ast-grep 告警及 1 个未确认项；没有完整 LSP 通过结论，**完整 LSP 未验证**。18 条为第一步既有字典 any/抛错边界风格，5 条涉及本次新增的通用结果类型、预期抛错与布尔互斥检查；已按上下文区分，不为清空风格告警扩大重构。原始结果 `/var/folders/11/sxl0444d11xbqzz8pz0lr2nm0000gp/T/loop-step2-lens-probe-Zw3Chy/result.json`。
- 本次私有诊断 MCP/LSP 按原登记 pid/启动时间/随机 owner 核对并释放全部消费者；IPC 依本次启动记录核对归属、连接拒绝及前后 inode/dev 后释放，私有 loader 已移除。证明 `/var/folders/11/sxl0444d11xbqzz8pz0lr2nm0000gp/T/loop-step2-lens-probe-Zw3Chy/release-confirmation.json`。不以 exit=1、SIGTERM 已发送或单独组长退出作释放证明；不继续排查或改造诊断工具。

断言变更：第一步测试节点“不支持”改为“缺 test 命令拒绝”，另外保留验收节点未上线反例；生产指路标题断言更新为第 2 步；工具清单命令一致性提取新增内核白名单，不能漏记新命令。新增测试未删弱原有场景；`test/e2e.mjs` 无改动、未运行。方案/程序验证、外层代码静态评审、真实装配、业务验收分别报告，不能互相替代。

## 第 1 步验证安排与旧问题单去向（历史分工）

以下保留第一步起草时的验证分工，不表示当前仍处于只做文档的阶段；第二步已实施的检查与实际证据以上一节记录为准。

第 1 步自检围绕新卡解析、候选与账本、开发评审、提交与状态、宿主兼容，优先复用现有 `node:test` 和 Git 临时仓库。修改哪部分就运行相关测试，不跑 `test/*.test.ts`。提交与推送测试使用系统临时目录里的本地 bare origin，不接触真实远端。

现有覆盖重点：`review.test.ts`、`git.test.ts`、`commit-batch.test.ts`、`loop-launch.test.ts`、`query.test.ts`、`stop-safety.test.ts`、`host-dev.test.ts`、`autoreview.test.ts`、`hook.test.ts`，以及触及的具体队列/配置用例；这不是要求全跑的固定清单，由改动选择。新行为在最接近的测试处增加必要反例，禁止新建平行测试框架。

依赖方向用源码静态核对；程序测试用替身只证明控制流程。真实模型行为、真实 dev 合入/远端推送、真实宿主装配分别留证据，没执行就写未验证。准备本方案时不执行产品测试、浏览器、模型会话或业务验收。

`test/e2e.mjs` 不在第 1 步默认运行或删改范围。已有“没有新提交”断言适用于旧单会话，不能直接改成新卡规则；新卡的自动提交应增加独立覆盖。确实要调整原断言或删除测试时，先给清单、理由和替代覆盖，按用户边界处理。

旧问题单按需求原表逐张核对，不一概宣布新架构已经解决：

- 第 1 步重点：队列通过仍重复评审、完成提示与合入不一致、非产品失败阻断整批合入、已合入仍运行中、锁释放竞争、启动截断、迁移提示，以及启动时配置错误发现晚的相关部分。
- 第 2 步：全量同时运行造成假失败（确认不恢复全量并落实本机排队）、失败归因误判、节点通知与受控改卡。
- 第 3 步：运行中改批次导致整批验收不启动、多任务失败隔离。
- 基线相关两单以已停用的 `fbe1441` 和实际证据核销，不算本次新增成果。
- 验收超时丢证据、演示数据写真实状态目录、测试固定等待、调用链排查遗漏、协调汇报问题继续独立保留。

交付逐项写清“已实现 / 已程序验证 / 已装配 / 已真实验收”，涉及旧问题单仍需用户核实后才关闭。用户需求 A1、A7、A10 属于第 1 步主验收；A8、A9 本步先以开发评审暂停覆盖通用状态和例外入口，原文的测试节点场景留第 2 步，不偷换为已完成。A2、A3 留第 2 步，A4—A6 的完整多任务行为留第 3 步。

## 第 1 步准备与启动记录（历史，不是本轮操作指令）

本节转录第一步原稿准备记录；下面权限检查、dry-run、路径/版本和未启动等描述都是当时的记录，不是本轮重新执行或核实的结论。

第一步起草时已准备隐藏工作目录 `/Users/Admin/.pi-autoreview/worktrees/loop-kernel-step1`，分支 `refactor/loop-kernel-step1`，从已提交 dev `fbe1441` 建出。只复制原 `.autoreview.json`；它没有 acceptance，旧 gate 已停用。未提交、未合入、未推送，未启动 Pi。这个目录是首次开发的准备空间，不是新内核已经建出的工作目录；后续由协调方按本批身份处理，不能冒充新功能已验收。

开发加载运行版 `/Users/Admin/Desktop/loop/autoreview.ts`，避免开发中的代码评审自己；开发方仅修改隔离目录。源码与任务文档分开存放，原始需求和本方案在运行仓库只读。

本次核对到的 Pi 入口为 `/Users/Admin/.local/bin/pi`；实际包 `@earendil-works/pi-coding-agent` 的 package.json 标为 `1.3.0`，路径目录仍名为 `pi-versions/1.2.0`，不能据目录名判断版本。已读当前启动器和已安装 CLI 参数解析源码。权限扩展与 Ponytail 路径均存在：

- 权限：`/Users/Admin/.pi/agent/npm/node_modules/@gotgenes/pi-permission-system/src/index.ts`。
- Ponytail：`/Users/Admin/.codex/plugins/cache/ponytail/ponytail/4.13.0/pi-extension/index.js`，模式 full。
- 开发工具选 `read,edit,write,bash`，覆盖源码阅读、修改和定向命令；本任务不需要浏览器或新增插件。保留项目规则加载。

原生权限处理器已在这个工作目录用模拟调用检查，四种工具均无需确认，未执行工具；全局 yoloMode 保持原值 true，未修改 deny、信任或全局配置。证据为 `/Users/Admin/.pi-autoreview/preparations/loop-kernel-step1-20261106/permission-handler-check.json`。启动时仍由既有入口核对权限；实际模型连接、扩展完整运行和业务效果尚未验证。

已对下列启动参数执行入口 `--dry-run`：退出码 0，确认工作目录、带 @ 的完整任务路径、三项显式扩展及 `--approve` 均正确传递；没有启动 Pi。文档链接、示例 JSON 与 10 条本步验收目标已做静态核对。

在「终端」复制执行即可开启新会话，不能用于续接旧会话：

```bash
cd /Users/Admin/Desktop/loop
env -u AUTOREVIEW_BATCH_FILE -u AUTOREVIEW_STAGE -u AUTOREVIEW_PIPELINE_DIR -u AUTOREVIEW_PIPELINE_LAUNCH -u AUTOREVIEW_PIPELINE_LAUNCH_TOKEN -u AUTOREVIEW_BASE_REV -u AUTOREVIEW_DEV_ROOT \
  LOOP_DIR=/Users/Admin/Desktop/loop \
  /Users/Admin/Desktop/loop/bin/loop 开发 pi \
  --cwd /Users/Admin/.pi-autoreview/worktrees/loop-kernel-step1 \
  --name "Loop内核第1步" \
  "@/Users/Admin/Desktop/loop/docs/prompt/提示词-Loop内核与节点编排-1单任务内核.md" \
  -- --approve
```

入口自带 `--offline`，仅关闭 Pi 启动联网检查，不禁止正常模型连接；`--approve` 仅沿用本次项目信任方式，不改持久权限配置。不加 `--autoreview-accept-cmd`。预期进入名为“Loop内核第1步”的 Pi 会话并加载任务；若前置检查失败，保留原错误，不通过关闭权限保护来继续。

以上记录只说明第一步当时的准备事实，不表示现在未启动或未实施。第一步代码已完成的依据为本方案开头所列分支与提交；真实集成、推送和新卡自举仍据实际证据分别报告。原先“先合入再写下一步”的安排，现已由用户本次“从第一步分支继续第二步”的明确指令覆盖。本轮不执行上面的历史启动命令，不将方案准备或静态评审写成第二步产品交付。
