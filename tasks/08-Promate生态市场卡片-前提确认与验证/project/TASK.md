# 任务：生态市场卡片——前提确认、缺陷修复与真实验证

本文件是给 Loop 内 Pi 成员的执行提示词。用户已要求“开始吧”，由循环外助手准备规则和命令，用户启动一次 Loop。只按当前 context 的 unit/role 工作，不启动其他 Agent、不接管调度。

## 目标、起点与范围

完成原需求第九节第 2 项的小切片：一座本机目录市场、一张只含名称/简介/版本的空壳卡片，真实显示、安装、停用、启用、卸载、重装及同身份升级。保留真实证据，不能用 CLI、样例或登记文件伪造桌面成功。

起点是上轮第三候选，hash 为 `78130dbc68d071ae63b7ceeb4328e448d5c9776020fb23847badc5aa28d4761f`，旧结果 NOT_MET。代码已复制进本次 source，所有旧证据仅供定位问题，不继承旧 PASS。完整历史保持不动。

已知问题：摘要 `name` 被当作标题，`displayName` 在已查原生路径中不起作用；外层系统沙箱与 Chromium 沙箱叠加启动失败；非目标资源比较会把合法空登记容器误判为变化。完整依据见 `reference/续接基线.md` 和 `reference/上轮最终评审.json`。

本轮必须保持正确名称、同身份升级、不重复卡片。“改名仍保持身份”是此前额外加入的要求，本轮按用户刚确认的方法单列为待定，不作为通过条件，也不能声称已支持；这没有回写旧规则。中文输入名称仍须原样正确显示，不能换成摘要、英文样例或截断文字规避缺陷。若原生宿主不支持必要字段/身份方式，明确说明具体限制并停止。

不做技能本体、后台同步、平台接口、专家团发布、生产装配、提交或合并；不改原 Promate、不改旧候选、不改 Loop 引擎或其他任务。

## 先读什么

1. 本次 context、response_schema、规则 criteria、AGENTS.md、本文件。
2. reference/需求原文.md 第九节第 2 项；reference/续接基线.md；reference/上轮最终评审.json。
3. experiments/ecosystem-cards/ 的当前实现，尤其 integration/index.mjs、isolation.mjs、candidate.mjs、evidence.mjs、card-generation/index.mjs、card-state/index.mjs。
4. acceptance/check.mjs 的当前冻结检查，再读需要用到的现有测试和 first-connect/native-install.mjs。旧 README、历史自测、host-contract 记录不是本轮事实；以本次规则优先。

## 执行顺序与停止条件

两个单元严格串行，`cards` 依赖 `host-ready` PASSED。引擎原生依赖调度负责阻止环境未通过时启动业务开发，不另造调度器。

当前安装已由另一轮授权更新为 Loop 0.3.0；本轮使用该现有入口，显式设置 developer_session=fresh、reviewer_exec=false、max_reruns=0。不启用返修会话复用，避免它额外套用的系统沙箱干扰宿主隔离验证；不据此宣称新引擎的真实会话收益已验证。

### host-ready：只确认真实隔离桌面

Sol/max 开发，Astra/xhigh 静态复核。只允许修改 integration/、`readiness-findings.md` 和 `readiness-source.json`，不改生成器、状态识别器、fs-safety 或其他模块。

先核对宿主名称与安装身份的原生读取链，写 `readiness-findings.md`：宿主版本/文件摘要、名称读取字段、安装键来源、当前已证实与未知、需要后续验证的接法。可以只读 `/Applications/WorkBuddy.app/Contents`；不要运行旧研究脚本主程序或把旧片段当当前结论。

复用现有集成入口和管理进程逻辑，给 `integration/index.mjs` 增加 `--preflight-only` 模式；不新建第二套宿主框架。此模式只建立受保护的独立 profile、启动原装宿主、确认真实窗口和可见插件市场、留证并清理；不安装/停用/卸载卡片，不请求业务模型。

先读旧失败原始日志，再选择有源码或系统依据的最小调整；同一已失败方案不原样重试，最多尝试两个有明确区别的隔离方案，每次先确认边界。禁止把 `--no-sandbox`、关闭 SIP、绕过 TCC、去签名、改宿主包或登录认证作为方案；禁止把仅改 HOME/profile 环境变量当系统隔离完成。

找不到可用且满足保护要求的接法，或需要本轮未授权的新账号、虚拟机、凭据、权限时，保存当前日志、已试方案和准确缺项，报告相关标准 UNKNOWN。`blocked=true` 表示“本轮已授权条件下无法继续”，不要求证明所有可能方案都不成立。开发阻断交付后当前引擎会直接保留候选并停止，可能显示 NOT_MET，不能伪称已经独立评审。也不得为了调用评审而虚填可继续。

本单元 `max_repairs=0`，不进入业务返修；门禁失败后评审如实判断，后续 cards 为 NOT_RUN。格式修复最多每角色一次，不得借格式修复修改代码或重跑宿主。

### cards：前提通过后再修复与验证

继承 host-ready 通过的候选差异，Sol/max 在 experiments/ecosystem-cards/ 内修复，Astra/xhigh 静态复核。最多一次业务返修。

1. 先让新的冻结核心检查暴露名称问题和资源比较问题，记录具体失败断言；不要为了“先失败”篡改检查或候选。可分别调用 `acceptance/check.mjs a`、`resources`，只输出到自己的 workspace。
2. 用宿主支持的名称和身份接法修正生成器。保持 resourceId 与安装身份映射稳定、同名升级不复制卡片；不能为修名称省略路径、归属、符号链接、异常恢复保护。
3. 修正 foreignResources：缺失与合法空容器按语义比较，保留真实非目标字段和文件检查。验证“仅目标变化不误报”和“其他资源变化能检出”，不能直接忽略整个 settings/registry。
4. 复用受影响自测，补必要反例，检查通过后再运行集成。不得默认跑原插件全仓测试或安装依赖。
5. 集成只使用本轮新建独立环境，按 market-visible → install → disable → enable → uninstall → reinstall → upgrade 完成。版本 1.0.0 → 1.0.1，名称原样正确、同一身份、只有一张卡片。每步把真实界面、宿主原始登记/输出和只读状态识别结果对照。
6. 在测试 profile 中准备能证明保护作用的非目标测试资源；使用宿主原生操作登记，不手写宿主业务记录冒充已安装。仅目标操作不影响该资源，文件/字段差异有依据；空快照相等不能作为操作期间保护通过。
7. 更新实验 README，写明如何体验这一版、已验证/未验证、证据路径和恢复办法。正式项目未合并，不能宣称原入口已生效。

G1 运行核心生成、状态识别和真实 foreignResources 的定向检查。G2 先读取同轮 G1 回执，只有 PASS 才调用真实七步；这是冻结门禁的保护，不依赖成员口头保证。G2 入口应由引擎执行，开发自检可直接调用 integration/index.mjs，不伪造 G1 回执。

若本阶段发生环境/权限前提退化，开发或评审记录 `blocked=true` 与具体 rule_gaps，停止；仅可修复的业务缺陷才使用一次返修。不要等用户在循环中点击，也不自动开新运行。

## 接口与证据

继续保留 generateMarket({outputRoot,ownerId,marketName,card}) 和 readCardState({profile,marketName,pluginName}) 两个接口。card 包含 resourceId、name、description、version；不可读、损坏、矛盾和归属异常返回 null/原因或明确拒绝，不误报正常。

集成入口保持 `node experiments/ecosystem-cards/integration/index.mjs --workspace <本次目录> --report <本次JSON>`，环境前提阶段额外传 `--preflight-only`。所有原始证据与 PNG 在 workspace 内，真实 profile 在本次 `/private/tmp/loop-card-*` 根中。门禁 HOME 是引擎临时目录，不能据此推断真实用户 profile。

两种模式均须先建立报告，再做可能失败的预检；失败、超时、正常退出都保存日志和可确认归属进程的清理记录。不把未尝试写 PASS，不遗漏真实失败原因。

preflight 报告格式：`mode:"preflight"`、candidateCodeRoot、candidateUnchanged、hostVersion、hostBuildUnchanged、profile、boundary.pass、managedProcessesStopped、status；preflight 对象含 `profileIsolated`、`nativeProtectionRetained`、`marketPanelVisible`、`rawEvidencePath`、`screenshotPath`。三项布尔必须由实际观察支持。rawEvidence 包含启动命令、身份与 profile 对照、边界检测、原始宿主输出、真实窗口与插件市场依据；记录名字映射调查位置。保留当前七步数组时，所有 attempted 必须为 false。

两种模式各自判断完成条件：预检未跑七步不能声称操作期间资源保护通过，也不能因此永远无法返回预检 PASS。完整模式仍必须满足七步和资源保护全部标准，不降低其条件。

完整报告保留既有字段：candidateCodeRoot、candidateUnchanged、hostVersion、hostBuildUnchanged、profile、boundary、card、otherResourcesUnchanged、managedProcessesStopped、steps。七个 step 各出现一次，包含 action、attempted、status、foreignResourcesUnchanged、rawEvidencePath、screenshotPath。每份 rawEvidence 对应本步，保存 state、native、before/after、nameVerification（expected、titles、correct）和操作、清理所需依据。预检的截图不能挪给安装步骤。

完整模式沿用原集成测试卡：resourceId=`loop-ecology-shell-probe`，name=`Loop 空壳卡片`，初始版本 1.0.0；不能换成英文或摘要测试卡避开中文名称问题。

截图来自本轮可确认归属的真实窗口；不能伪造 PNG、修改 DOM 标题、注入安装结果或手写状态登记。只读 DOM/原生调用取证和原生控件操作可以使用；原生接口调用须有本轮输出，不能将 headless 成功替代真实界面。

保护真实用户账号、Key、会话、默认配置、业务数据；只允许本机测试通信，禁止业务模型或平台请求。保留证据及恢复根，不删除未知目录，不 killall、不按端口杀未知进程，不留下脱离管理的后台任务。

## 独立评审与结果

评审只有 read/grep/find/ls，读取当前冻结候选和 context 指向的本轮门禁记录、日志和截图；不执行测试、接口、桌面、构建或修改文件。依据本轮标准核对真实性、名称、身份、状态、资源保护和清理；如实区分 FAIL 与 UNKNOWN。

标准以本次 task.json/context 为准，旧 S1—S7 编号不是本轮标准。响应只输出 schema 要求的一个 JSON，开发 candidate_hash 填空，评审填 context 的完整摘要；代码证据用 code:，门禁用 gate:（只供评审），外部证据路径放 note。独立评审尚未发生的条款，开发可填 UNKNOWN；不要另开 Agent 补它。

若 context 提供 issue_history，评审须用当前候选证据逐项判断；已解决项用 schema 支持的 issue_resolutions 明确绑定已有 ID，不靠不再提及自动关项。历史缺口与当前待办分开，不能用上一候选的证据解决本轮问题。

开发 Sol/max；评审 Astra/xhigh；长日志由现有统一入口自动调用 ds4.1/xhigh 简报。配置参数不等于实际加载已验证。简报必须区分历史已解决缺口和最后一轮仍未通过项，不能把旧 S6 问题继续当待办。

原冻结候选、旧运行、新任务的 source、acceptance/、reference/、first-connect/、marketplace/、tests/、AGENTS.md、CLAUDE.md、TASK.md 均不可由成员修改。只改引擎给的工作副本和本单元允许路径。
