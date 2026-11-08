import assert from "node:assert/strict";
import { symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import * as old from "../commit-batch.ts";
import { kernelFixture } from "./helpers/kernel-fixture.ts";
import { readRun } from "../node-ledger.ts";
import { deliverCandidate } from "../kernel-workspace.ts";
test("旧提交/批次分支推送/全工作区提交函数已删除", async () => { for (const key of ["commitBatch", "pushBatch", "checkedTree", "workingTree"]) assert.equal(Object.hasOwn(old, key), false); const workspace = await import("../workspace.ts"); assert.equal(Object.hasOwn(workspace, "commitAll"), false); });
test("新候选私有索引包含允许新文件/链接，但不含 localFiles；用户索引保持", () => {
  const f = kernelFixture(["开发评审"]); try { f.card.tasks[0].scope = ["file.txt", "new.txt", "link"]; writeFileSync(f.file, JSON.stringify(f.card)); const path = f.start(), run = readRun(path), index = f.git(run.worktree, "write-tree"); writeFileSync(join(run.worktree, "new.txt"), "new"); symlinkSync("new.txt", join(run.worktree, "link")); const c = deliverCandidate(run); assert.match(f.git(run.worktree, "ls-tree", c.commit, "link"), /^120000/); assert.equal(f.git(run.worktree, "show", `${c.commit}:new.txt`), "new"); assert.equal(f.git(run.worktree, "ls-tree", c.commit, "local.txt"), ""); assert.equal(f.git(run.worktree, "write-tree"), f.git(run.worktree, "rev-parse", `${c.commit}^{tree}`), "仅更新程序提交对应索引"); assert.notEqual(c.tree, index); } finally { f.cleanup(); }
});
