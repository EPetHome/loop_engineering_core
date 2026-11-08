import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "./helpers/merge-queue-fixture.ts";
import { queryBatches } from "../query.ts";
test("旧 stash/发布恢复矩阵不再执行归还、reset、补推送；未知事务原样供人工核对", () => {
  const f = fixture(); try { for (const status of ["ready", "merging", "merged", "blocked"] as const) { f.history.entries[0].status = status; Object.assign(f.history.entries[0], { runtimeStash: { ref: "refs/loop/private", hash: "old" }, pushRequested: true, runtimePublication: "published" }); f.saveHistory(); const before = f.snapshot(); queryBatches(f.oldFile); assert.deepEqual(f.snapshot(), before); f.refuse("合入"); f.refuse("推送"); } } finally { f.close(); }
});
