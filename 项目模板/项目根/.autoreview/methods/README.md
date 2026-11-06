# 项目方法（只写一份）

这里放项目固定、每批复用的检查方法。它进仓库，不放进批次目录；每批只写 `批次.json` 和提示词。

- `prepare.sh`：准备检查与已知环境恢复，对应 `preparation.check` / `preparation.recover`。
- `self-check.sh`：方法自测，对应 `methods.selfCheck`。`bin/loop 开工` 在方法指纹变化时执行一次；它会拒绝模板里没替换的 `<占位符>`，不会空跑通过。
- 准备、自检只核对方法与运行条件，不运行项目测试。开发方自行做受影响的定向自检，Loop 不运行、不判定。旧 gate 字段已停用并忽略；不再提供 gate.sh，也不在批次目录写门禁或启动脚本。

项目方法拿到的环境变量：`AUTOREVIEW_BASE_REV`（本段开工依据）、`AUTOREVIEW_BATCH_FILE`（`批次.json` 绝对路径）、`AUTOREVIEW_STAGE`（段名），以及准备/验收执行器提供的 `AUTOREVIEW_RUN_DIR`、`AUTOREVIEW_RUN_ID`、`AUTOREVIEW_TEMP_DIR`、`AUTOREVIEW_EVIDENCE_DIR`、`TMPDIR`。批次参数由方法自己读 `AUTOREVIEW_BATCH_FILE`。

启动会话不需要项目方法拼命令：写 `prompt` 的段由 `bin/pi-dev` 统一启动。
