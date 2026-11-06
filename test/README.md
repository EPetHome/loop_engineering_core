# 测试组织与覆盖去向

Loop 不运行项目测试；开发方按影响范围执行定向文件，例如 `node --test test/review.test.ts test/config.test.ts`。场景按功能拆分到独立测试进程；可变 HOME、Git 仓库、队列和环境不在并行用例间共享。临时材料由夹具释放，`e2e.mjs` 的场景和断言不属于本轮整理范围。

## 功能入口

- `hook*.test.ts`：Hook 会话、评审、验收、输入、进程、并发、经验及交付。
- `autoreview*.test.ts`：Pi 会话、必需／附加验收命令、验收、来源、授权、队列、经验及交付。
- `acceptance*.test.ts`：解析和证据、系统、格式更正、检查点、资源、断线、实测工具及定向复验。
- `batch-queue*.test.ts`、`merge-queue*.test.ts`：批次资格、FIFO、候选核对、原会话收件、提交、发布、事务恢复及撤回。
- `batch-delivery*.test.ts`：推送、不运行/不复用旧测试、部署及旧超时命令忽略。
- `loop*.test.ts`、`pipeline*.test.ts`：开工、文档搬运、启动、合入保护、编排和启动失败收束。
- 其他原功能文件保持原覆盖；`helpers/` 只承载夹具与共同操作，不重复注册测试。

## 合并对应表

旧用例编号仅作追溯，不再用轮次命名新增用例。没有直接删除独有场景；下列合并移除了重复入口，保留原有输入差异及独有断言。

| 原用例 | 当前覆盖 |
|---|---|
| Loop 开工 A1/A2/A3 | `loop.test.ts`：开工／方法指纹与执行次数，首次、跳过、变化、强制执行共用仓库 |
| Hook H1、普通 Claude、A7 普通 Codex | `hook-session.test.ts`：普通会话隔离，配置有无及宿主参数表 |
| Hook H3/H4、A4、A7 开发 Codex、两宿主原生返修 | `hook.test.ts`：评审返修生命周期；决定暂停、必修过滤、需求与次数、通知、锁释放均保留 |
| Hook H8 识别及 Codex 无 turn_id | `hook-session.test.ts`：纯识别规则和真实入口分别覆盖 |
| Hook A5、相对文件、不可用根、H 返修1 | `hook-session.test.ts`：固定项目根、相对文件解析、无效根；错误分支不并掉 |
| Hook H11 通过项与 H12 约定项 | `hook-acceptance-policy.test.ts`：两宿主、无副本／旧副本及标准冻结、证据、总结；H11 失败分支仍在 `hook-acceptance.test.ts` |
| Pi G11 通过项与 G12 约定项 | `autoreview-acceptance.test.ts`：运行时约定、标准、实际验收结果；失败和配置错误仍独立覆盖 |
| 六个评审首次／重试预算用例 | `review.test.ts`：七行预算参数表；仅共享不可变基线，每行重建状态和时钟 |
| 验收 A3/A15 | `acceptance.test.ts`：报告格式参数表；粗体标准及异议断言分别并入标准、异议测试；提示词契约 A14 保留 |
| 验收 A10/A11/A17/A23 | `acceptance-correction.test.ts`：同会话更正、强模型成功／失败、标准冻结、reset 复用 |
| 验收 A34、取消 reject、正常返回缺释放证明 | `acceptance-resources.test.ts`：释放证明参数表；真实独立进程组与扫描失败另行保留 |
| Pi 必需验收期间仓库内／外来源变化 | `autoreview-sources.test.ts`：来源变化／必需验收结果保持；发布窗口缺失测试另行保留 |
| 流水线未报状态、未执行命令、静默并行段、phase-only | `pipeline-startup.test.ts`：启动确认参数表；真实进程、显式失败和已暂停会话仍保留实际入口 |
| 队列原生收件、草稿、终端提交、原会话恢复 | `batch-queue-native-{claude,codex}.test.ts`：两宿主各四行，共用 `nativeRepairCases` 和真实收件校验 |
| 多段结构化结论、必需整批验收的失败／部分验证／通过 | `batch-queue-acceptance.test.ts`：提交与入队资格；开工后新增配置的真实流水线另行保留 |
| 中断后 stash 恢复、手动恢复、历史自动恢复、旧推送意图 | `batch-queue-stash.test.ts`：六行事务状态矩阵；真实 CAS 竞争与恢复失败仍独立覆盖 |
| 等待段评审、等待整批验收、流水线开发／暂停后放行 | `batch-delivery-deployment-wait.test.ts`：四行检查活动参数表；启动边界重读、停止、回退仍独立覆盖 |

## 夹具边界

- 队列等待观察产品原子落盘的真实 JSON，避免每个轮询周期重新启动 Git；正式断言仍调用真实 `readMergeQueue` 复核身份。
- 队列状态类测试在私有 CLI 进程复用真实 `loop.ts` 调度函数，不模拟 Git、检查或结果。`cli-worker.test.ts` 对比实际命令行退出码与完整 JSON，并检查配置更新。启动、停止及竞争测试仍使用独立命令行进程。
- `test-env.test.ts` 的子运行器继续实际执行 Pi、Hook、评审预算三个入口的所有选中子项，防止路径或名字变化后空选假绿。
- 经验导入的默认材料是既有20条草稿的脱敏副本；保留原断言，也保留 `AUTOREVIEW_EXPERIENCE_SEED` 外部材料入口，不因缺省个人路径跳过。
- 原一分钟门禁超时改为旧超时命令不执行的回归；队列并发窗口改由真实 Git 合并边界等待，返修场景用文本冲突。20秒并行工具及生产指路各20次采样保留，不因本次改动降低次数。
- macOS仅在当前Git是系统启动器、`xcrun`找到同版本且同`exec-path`的真实Git时，测试才用私有单命令入口减少启动器开销；不缓存Git结果、不替换其他命令，不越过自定义／故障Git。版本、工具路径、初始化模板及hooks布局均有等价测试；其他平台或探测失败保持原环境，结束后释放私有入口。
