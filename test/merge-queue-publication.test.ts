import assert from "node:assert/strict";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { kernelFixture, reviewer } from "./helpers/kernel-fixture.ts";
import { completeManagedDelivery, mergeManaged } from "../kernel-session.ts";
import { readRun } from "../node-ledger.ts";
test("目标前进产生未检查树时统一合入拒绝，不暗查/自动重测，保留用户索引与内容", async () => {
  const f = kernelFixture(["开发评审"]); try { const path = f.start(); writeFileSync(join(readRun(path).worktree, "file.txt"), "candidate"); let calls = 0; await completeManagedDelivery(path, "【交付完成】", { exec: f.exec, callReviewer: async () => { calls++; return reviewer(); } }); writeFileSync(join(f.repo, "forward.txt"), "external advance"); f.git(f.repo, "add", "forward.txt"); f.git(f.repo, "commit", "-qm", "advance"); const head = f.git(f.repo, "rev-parse", "dev"); const output = await mergeManaged(path); assert.notEqual(output.status, "通过"); assert.match(output.reason ?? "", /目标|整合|检查/); assert.equal(calls, 1); assert.equal(f.git(f.repo, "rev-parse", "dev"), head); assert.equal(readRun(path).publication, undefined); } finally { f.cleanup(); }
});
test("目标重叠用户暂存改动不能被提交节点覆盖，拒绝不 stash/reset 或推送", async () => {
  const f = kernelFixture(["开发评审"]); try { const path = f.start(); writeFileSync(join(readRun(path).worktree, "file.txt"), "candidate"); await completeManagedDelivery(path, "【交付完成】", { exec: f.exec, callReviewer: reviewer }); writeFileSync(join(f.repo, "file.txt"), "staged original"); f.git(f.repo, "add", "file.txt"); const index = f.git(f.repo, "write-tree"); writeFileSync(join(f.repo, "file.txt"), "unstaged original"); const result = await mergeManaged(path); assert.notEqual(result.status, "通过"); assert.equal(f.git(f.repo, "write-tree"), index); assert.equal(readFileSync(join(f.repo, "file.txt"), "utf8"), "unstaged original"); assert.equal(f.git(f.origin, "for-each-ref"), ""); } finally { f.cleanup(); }
});
