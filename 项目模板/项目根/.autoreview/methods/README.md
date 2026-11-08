# 项目方法（只写一份）

- prepare.sh 对应 preparation.check/recover，独立有限恢复/方法修复预算；占位符未替换如实失败。
- self-check.sh 对应 methods.selfCheck，新卡开发启动前按方法指纹执行，未变跳过；受管消费者/资源留证并确认释放。它只检查方法和运行条件，不代替业务测试。
- 每批只写新卡和提示词。测试命令写 tasks[].test，验收标准写卡 acceptance 路径，实际流程由 flow 决定。旧 gate、workspaces、开工、段 workflow 和后置命令均不执行。

方法取得任务冻结 AUTOREVIEW_BASE_REV、已登记 AUTOREVIEW_BATCH_FILE 与任务名 AUTOREVIEW_STAGE，以及执行器提供的 RUN_DIR/RUN_ID/TEMP_DIR/EVIDENCE_DIR/TMPDIR。所有释放脚本幂等且只处理本轮资源，不碰真实账号/生产数据；项目来源与路径保护不因自动执行而放宽。

会话统一 `bin/loop 启动`；临时单会话 `bin/loop 开发` 只开发评审。没有每批自造启动器或旧流水线兼容开关。
