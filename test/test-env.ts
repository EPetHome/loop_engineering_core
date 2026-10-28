/**
 * 仅供会创建独立开发会话的单测入口使用。
 * 外层 Loop 的启动身份不属于临时测试仓库；具体场景需在导入后显式设置自己的身份。
 * 保留 PATH、资源运行身份及其他环境，不能改变生产执行器的环境传递行为。
 */
import { fileURLToPath } from "node:url";

// 完成路径新增的独立起草不调用真实模型；需要其他行为的用例显式覆盖，产物仍由夹具隔离。
process.env.AUTOREVIEW_EXPERIENCE_CMD = fileURLToPath(new URL("./fake-experience.mjs", import.meta.url));

for (const key of [
  "AUTOREVIEW_BASE_REV", "AUTOREVIEW_BATCH_FILE", "AUTOREVIEW_STAGE", "AUTOREVIEW_DEV_ROOT", "AUTOREVIEW_DEV_RUN_ID",
  "AUTOREVIEW_PIPELINE_DIR", "AUTOREVIEW_PIPELINE_LAUNCH", "AUTOREVIEW_PIPELINE_LAUNCH_TOKEN",
]) delete process.env[key];
