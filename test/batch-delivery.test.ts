import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fixture, reviewer } from "./helpers/batch-delivery-fixture.ts";
import { completeManagedDelivery, mergeManaged } from "../kernel-session.ts";
import { readRun } from "../node-ledger.ts";
test("新发布只推 origin/dev；远端拒推保留本地事实与 Git 原因，不强推、不自动重试", async () => {
  const f = fixture(["开发评审"]); try { const rejected = join(f.root, "push.log"); writeFileSync(join(f.origin, "hooks/pre-receive"), `#!/bin/sh\necho reject >> '${rejected}'\necho REJECT_SENTINEL >&2\nexit 1\n`, { mode: 0o755 }); const path = f.start(); writeFileSync(join(readRun(path).worktree, "file.txt"), "candidate"); await completeManagedDelivery(path, "【交付完成】", { exec: f.exec, callReviewer: reviewer }); const out = await mergeManaged(path); assert.notEqual(out.status, "通过"); const run = readRun(path); assert.equal(run.publication?.local, "merged"); assert.equal(run.publication?.push, "失败"); assert.match(run.publication?.reason ?? "", /REJECT_SENTINEL/); assert.equal(existsSync(rejected), true); const head = f.git(f.repo, "rev-parse", "dev"); await mergeManaged(path); assert.equal(f.git(f.repo, "rev-parse", "dev"), head); assert.equal(f.git(f.origin, "for-each-ref"), ""); } finally { f.cleanup(); }
});
