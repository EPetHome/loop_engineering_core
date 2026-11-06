/** 旧超时 gate 不得阻断队列，也不再产生超时暂停。 */
import "./test-env.ts";
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { inboxPath } from "../pipeline-core.ts";
import { recoverMergeQueue } from "../merge-queue.ts";
import { fixture } from "./helpers/batch-delivery-fixture.ts";

test("旧 gate 会无限等待也不运行；目标前进后直接核对并合入，不暂停或计返修", async () => {
  const f = fixture();
  try {
    f.advance(); writeFileSync(join(f.root, "mode"), "timeout");
    writeFileSync(join(f.batches[0].cwd, "code.txt"), "checked\n"); f.complete();
    await f.until(() => f.queue().entries[0]?.status === "merged"); await f.idle();
    const entry = f.queue().entries[0];
    assert.equal(entry.returnCount, undefined); assert.equal(entry.deliveries, undefined);
    assert.equal(entry.testConclusion, "Loop 未运行测试");
    assert.equal(existsSync(inboxPath(f.batches[0].dir, "dev")), false);
    assert.match(f.notice(), /Loop 未运行测试/); assert.doesNotMatch(f.notice(), /测试超过时限|测试通过/);
    assert.deepEqual(f.gates(), []);
    recoverMergeQueue(f.repo); await f.idle();
    assert.deepEqual(f.gates(), []); assert.equal(f.queue().entries.length, 1);
  } finally { await f.close(); }
});
