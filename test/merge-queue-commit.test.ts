import assert from "node:assert/strict";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { kernelFixture, reviewer } from "./helpers/kernel-fixture.ts";
import { completeManagedDelivery, mergeManaged } from "../kernel-session.ts";
import { readRun } from "../node-ledger.ts";
test("提交节点只发布已检查候选；压缩/发布不重新评审，不推任务/批次分支，历史 ref 保留", async () => {
  const f = kernelFixture(["开发评审"]); try { const path = f.start(); writeFileSync(join(readRun(path).worktree, "file.txt"), "checked"); let calls = 0; await completeManagedDelivery(path, "【交付完成】", { exec: f.exec, callReviewer: async () => { calls++; return reviewer(); } }); const before = readRun(path); assert.equal(f.git(f.origin, "for-each-ref"), ""); const result = await mergeManaged(path); assert.equal(result.status, "通过", result.reason ?? ""); assert.equal(calls, 1); const run = readRun(path); assert.equal(run.candidate!.tree, before.candidate!.tree); assert.equal(f.git(f.origin, "for-each-ref", "--format=%(refname)"), "refs/heads/dev"); assert.equal(f.git(f.repo, "show", `${run.publication!.history}:file.txt`), "checked"); assert.equal((await mergeManaged(path)).status, "通过"); assert.equal(calls, 1); } finally { f.cleanup(); }
});
test("检查后新增/修改用户输入拒绝合入，未检查文件和本机文件不夹带", async () => {
  const f = kernelFixture(["开发评审"]); try { const path = f.start(); writeFileSync(join(readRun(path).worktree, "file.txt"), "checked"); await completeManagedDelivery(path, "【交付完成】", { exec: f.exec, callReviewer: reviewer }); const run = readRun(path), head = f.git(f.repo, "rev-parse", "dev"); writeFileSync(join(run.worktree, "outside.txt"), "unreviewed"); await assert.rejects(mergeManaged(path), /未提交|候选|范围/); assert.equal(f.git(f.repo, "rev-parse", "dev"), head); assert.equal(readFileSync(join(run.worktree, "outside.txt"), "utf8"), "unreviewed"); } finally { f.cleanup(); }
});
