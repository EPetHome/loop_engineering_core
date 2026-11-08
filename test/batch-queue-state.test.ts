import assert from "node:assert/strict";
import test from "node:test";
import { queryBatches } from "../query.ts";
import { fixture } from "./helpers/merge-queue-fixture.ts";
test("旧队列 FIFO/资格撤销/停止记录只读，查询不恢复、不改变历史顺序或发布候选", () => {
  const f = fixture(); try { f.history.entries.push({ ...f.history.entries[0], id: "later", order: 2, status: "ready" }); for (const status of ["pending", "checking", "blocked", "returned", "stopped"] as const) { f.history.entries[0].status = status; f.saveHistory(); const before = f.snapshot(); queryBatches(f.oldFile); assert.deepEqual(f.snapshot(), before); assert.deepEqual(f.read().entries.map((e) => e.id), ["entry", "later"]); f.refuse("合入"); } } finally { f.close(); }
});
