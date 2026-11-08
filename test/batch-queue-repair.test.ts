import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fixture } from "./helpers/merge-queue-fixture.ts";
test("旧返修、冲突及死亡执行器不触发自动重开或候选豁免，原故障/次数/收件箱原文保留", () => {
  const f = fixture(); try { f.history.entries[0].status = "returned"; Object.assign(f.history.entries[0], { returnCount: 3, reason: "原冲突", deliveries: [{ stage: "甲", seq: 2, message: "旧机器消息" }] }); f.saveHistory(); writeFileSync(join(f.info.dir, "甲.inbox.json"), '{"seq":2,"message":"旧消息","mustFix":"A1"}'); f.refuse("续跑"); f.refuse("合入"); assert.equal(f.read().entries[0].returnCount, 3); } finally { f.close(); }
});
