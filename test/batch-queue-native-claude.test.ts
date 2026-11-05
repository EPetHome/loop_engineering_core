/** Claude原生收件在独立测试进程运行，不与Codex共享HOME、终端或队列。 */
import test from "node:test";
import { nativeRepairCases, liveHookRepair } from "./helpers/merge-queue-fixture.ts";

test("队列返修／Claude原生收件：同会话、草稿、终端提交和精确恢复", async (t) => {
  for (const item of nativeRepairCases) await t.test(item.name, () => liveHookRepair("claude", item.draft, item.scenario));
});
