#!/usr/bin/env node
/** 旧流水线的迁移诊断。没有解析器、派发器或可绕过的执行开关。 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
export const PIPELINE_MIGRATION = "旧批次/流水线已停用：请新建 version:1 开发卡；stages 改为 tasks（prompt、scope），workflow/steps 改为 flow（开发评审、测试、验收、提交、部署），测试命令写 tasks[].test；使用 bin/loop 启动 <开发卡.json>，无需开工，不使用 workspaces。";
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.error(PIPELINE_MIGRATION);
  process.exitCode = 2;
}
