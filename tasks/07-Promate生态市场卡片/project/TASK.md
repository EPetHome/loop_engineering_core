# 任务：本机生态市场空壳卡片

你是 Loop 启动的 Pi 成员，按本次上下文的 role 执行开发或独立评审。用户已授权本项开发，并要求按实际依赖轻量编排，用户只负责启动 Loop 和看结果。没有 Loop 上下文，不自行启动开发或其他 Agent。

## 目标与范围

完成需求第九节第 2 项：在隔离的真实 WorkBuddy 环境里，一座本机目录市场的一张空壳卡片能够显示、安装、停用、启用、卸载、再次安装和同身份更新，程序能准确识别状态。卡片只有名称、简介和版本，不带业务内容、技能、脚本、钩子或 MCP 服务。

交付可复用实验实现和真实证据，本次不做平台目录接口、技能本体分发、自动升级、专家团或正式发布。0.2.16 已完成能力不重开开发，卡片文件落盘不等于桌面可见。

## 编排与角色

本轮只有一个完整开发单元 cards，不固定 A/B 并行。卡片格式、原生操作和状态读取存在直接依赖，按“确认宿主接法 → 实现卡片与状态识别 → 集成验证”顺序完成。

开发：openai-codex/gpt-6.1-sol，max；评审：openai-codex/gpt-6-astra，xhigh。开发交付后，引擎冻结候选、执行两道功能门禁，再交独立评审；未通过按具体问题返修。最多返修 2 次，单次成员 50 分钟，整次 4 小时、12 次成员调用。

使用当前已验收的迭代 01 引擎，不依赖未合并的新字段。另一轮引擎迭代 03 独立进行，不改它的引擎、输入或规则；会话复用不提前启用。

## 读取与修改范围

- 当前 code_path 是插件源码的独立副本，不是原 Promate。
- 先读本文件、AGENTS.md、reference/需求原文.md 第九节第 2 项，以及 first-connect/native-install.mjs 的原生调用和记录读取方法。
- reference/host-isolation.py 和 reference/既有宿主研究.md 仅供复用隔离方法，不执行旧脚本主程序，不把旧结果作为本次证据。
- 只修改 experiments/ecosystem-cards/；卡片生成、状态读取、集成是同一单元中的代码分工。
- acceptance/、原插件、原测试、reference、AGENTS.md、CLAUDE.md 和 TASK.md 只读。不得改标准、删断言、提交、推送、发布或合并。

## 开发顺序与边界

1. 核对原装宿主的目录市场、卡片操作与记录格式。可只读 /Applications/WorkBuddy.app/Contents，不读真实用户 profile、账号、Key 或会话。
2. 优先复用现有代码和 Node 标准库，不安装依赖、不另建插件管理框架。先实现下文两个接口和最小自测，再接真实宿主。
3. 真实操作只在新建 /private/tmp/loop-card-* 根目录与独立 profile 中进行，使用系统沙箱防止访问真实用户资料，先验证隔离边界再启动宿主。只允许本机测试通信，不调业务模型、平台、飞书或生产数据，不绕过宿主安全保护。
4. 本机静态核对为 WorkBuddy 5.6.2；桌面代码支持 WORKBUDDY_CONFIG_DIR、CODEBUDDY_CONFIG_DIR、WORKBUDDY_USER_DATA_DIR 和 WORKBUDDY_REMOTE_DEBUGGING_PORT。它们只是静态依据，本次隔离桌面尚未实测，不能直接声称可用。
5. 只做必要定向自检，不做无关全仓检查；引擎在冻结候选的新副本上运行核心检查和真实宿主流程。

无法建立隔离桌面或宿主缺少必要能力时，保存具体阻断与原始证据，相关标准标 UNKNOWN，阻断性的缺口写入 rule_gaps。不得改用真实用户环境，不把目标降为 CLI/headless 通过，不在循环中等用户点击或提供凭据。

## 内部接口

- card-generation/index.mjs 导出 generateMarket({ outputRoot, ownerId, marketName, card })；card 含 resourceId、name、description、version；返回 marketRoot、marketName、pluginName、resourceId、version。身份由稳定资源 ID 决定，改名或升级不复制身份；拒绝路径越界、符号链接和归属未知的覆盖，失败保留旧输出。
- card-state/index.mjs 导出 readCardState({ profile, marketName, pluginName })；返回 marketRegistered、installed、enabled、version、reason。只读指定 profile，异常或矛盾不能误报正常；无法判断的值为 null 并给原因，不按同名目录存在猜安装状态。
- 相对路径基于 experiments/ecosystem-cards/；关键正反例见只读 acceptance/check.mjs。样例检查只证明逻辑，不证明宿主实测。

## 集成入口与证据

integration/index.mjs 接收 --workspace <门禁工作目录> --report <结果JSON路径>。代码必须来自当前候选；证据、截图和日志写到 workspace，宿主 profile 位于本次新建 /private/tmp/loop-card-* 根目录。门禁 HOME 可能是临时目录，不用它推断真实 profile。

真实流程依次为 market-visible、install、disable、enable、uninstall、reinstall、upgrade。使用宿主原生操作，不手写安装、市场或启用登记来冒充宿主成功。版本 1.0.0 → 1.0.1，同轮身份始终一致，每步保留原始宿主输出/状态和真实桌面截图。

结果 JSON 包含 candidateCodeRoot、status、hostVersion、profile、otherResourcesUnchanged、managedProcessesStopped、steps；每个 step 含 action、status、rawEvidencePath、screenshotPath。证据路径是 workspace 内的绝对路径。截图必须来自本次隔离桌面，门禁只检查证据完整性，真实性与界面含义仍由独立评审检查。

不能满足的步骤如实失败，不造 PASS。正常、失败、中断都清理本次可确认归属的进程，保留证据及恢复材料；不得 killall、按端口杀未知进程或留下脱离管理的后台任务。

## 评审与交付

评审只读当前候选、冻结标准、输入及门禁证据，不执行额外测试、接口或桌面操作。检查原生操作是否真实、证据是否来自当前候选、身份是否稳定、状态是否准确、异常是否被掩盖，以及其他市场和插件是否受保护。

程序 PASS 只是必要条件。假截图、手写宿主安装记录、只看 CLI 退出码、旧证据或样例冒充真跑均不得通过。缺少必要桌面证据也不得判定完成。

按 response_schema 和响应模板交付唯一 JSON，标准不增不减。开发方引用 code:，自测写 note；评审可引用 code: 和 gate:。截图与日志绝对路径放 note，不发明当前引擎不支持的引用类型。

本次规则的 criteria 是唯一正式完成标准。开发自评不是最终结果，循环达标不等于人工验收。引擎停止后，统一入口按日志长度自动调用 ds4.1 简报，结果集中到本次交付结果.md，用户无需另开简报 Agent。
