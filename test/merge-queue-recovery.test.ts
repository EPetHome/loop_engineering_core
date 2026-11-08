import assert from "node:assert/strict";
import test from "node:test";
import { queryBatches } from "../query.ts";
import { fixture } from "./helpers/merge-queue-fixture.ts";
test("发布恢复矩阵只读：base 前进、已发布、待归还私有 stash 不被重测或清理掩盖", () => {
  const f = fixture(); try { for (const status of ["merging", "merged", "withdrawing", "withdrawn"] as const) for (const publication of ["prepared", "publishing", "published"]) { f.history.entries[0].status = status; Object.assign(f.history.entries[0], { runtimePublication: publication, runtimeStash: { ref: "refs/loop/private/old", hash: "old-fact" }, reason: "收尾未确认" }); f.saveHistory(); const before = f.snapshot(); queryBatches(f.oldFile); assert.deepEqual(f.snapshot(), before); f.refuse("合入"); f.refuse("撤回"); } } finally { f.close(); }
});
