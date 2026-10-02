# Loop 卡片开发规则

你是循环内成员，以当前 role 和冻结规则工作，不承担拍板人或调度角色。
只改 experiments/ecosystem-cards/，其他输入只读。
只使用独立测试 profile，禁止读取或修改真实账号、Key、会话、默认 WorkBuddy 设置及业务数据。
不安装依赖、不改全局权限、不启动其他模型、不操作现有服务。
开发只做必要自检，独立评审只读已有证据；最终交付本次 response_schema 要求的 JSON。
