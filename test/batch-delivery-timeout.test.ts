/** batch-delivery／timeout：按功能独立运行，夹具与状态不跨测试进程共享。 */
import "./test-env.ts";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { inboxPath } from "../pipeline-core.ts";
import { recoverMergeQueue } from "../merge-queue.ts";
import { fixture } from "./helpers/batch-delivery-fixture.ts";

test("队列测试超时：如实通知分钟数、日志与调整方法，不退回开发会话、不计次数", async () => {
  const f = fixture();
  try {
    f.advance(); writeFileSync(join(f.root, "mode"), "timeout"); writeFileSync(join(f.batches[0].cwd, "code.txt"), "checked\n"); f.complete();
    await f.until(() => f.queue().entries[0]?.testTimeout === true, 90_000); await f.idle();
    const entry = f.queue().entries[0]; assert.equal(entry.status, "blocked"); assert.equal(entry.returnCount, undefined); assert.equal(entry.deliveries, undefined);
    assert.ok(!existsSync(inboxPath(f.batches[0].dir, "dev"))); assert.match(f.notice(), /测试超过时限（1 分钟）[\s\S]*完整日志：[\s\S]*gate.timeoutMin[\s\S]*reviewTimeoutMin/);
    assert.doesNotMatch(f.notice(), /与已合入批次冲突/); assert.match(readFileSync(entry.log!, "utf8"), /TEST_OUTPUT/);
    recoverMergeQueue(f.repo); await f.idle(); assert.equal(f.gates().filter((item) => item.queued).length, 1, "状态查询不无限重试同一次超时");
  } finally { await f.close(); }
});
