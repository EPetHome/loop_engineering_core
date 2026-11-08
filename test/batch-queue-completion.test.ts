import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fixture } from "./helpers/merge-queue-fixture.ts";
test("旧 done/ready/部分验证和重复事件不再压缩、提交或入队；缺验收不能补造通过", () => {
  const f = fixture(); try { mkdirSync(f.info.dir, { recursive: true }); for (const acceptance of [undefined, { failed: [], partial: [], manual: [] }, { failed: [], partial: [{ id: "A1", text: "未验证", detail: "原原因" }], manual: [] }]) { writeFileSync(join(f.info.dir, "甲.status.json"), JSON.stringify({ stage: "甲", sessionId: "old", event: "done", readyEpoch: "old", acceptance, inbox: 0 })); f.refuse("启动"); f.refuse("合入"); const before = f.bytes(); f.read(); assert.deepEqual(f.bytes(), before); } } finally { f.close(); }
});
