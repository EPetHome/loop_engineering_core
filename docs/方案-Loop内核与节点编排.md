# Loop 内核与节点编排实施方案

当前阶段：**第四步外层第 2 次评审的唯一必须修改已返修并完成真实进程定向验证，待外层复审；未提交、发布或真实部署**。2026-11-07 用户要求完成第四步、用最新 Loop、新分支 `refactor/xxxx-step4`。已从本机已发布 dev `5f23127` 建立 `refactor/loop-kernel-step4`，前三步历史记录保留，不把其中“待复审”等旧时态当作当前进度。dev 与本机 origin/dev 记录同为 `5f23127`；本次没有通过联网或业务复跑补验历史发布。

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
| 第 5 步 | 删除旧 workflow/每段验收/共用预算/workspaces/旧开工与独立 accept-cmd 路径 | 先交删除清单并获用户确认，再删除；旧工作目录逐个核对归属和成果后另行确认清理 |

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
