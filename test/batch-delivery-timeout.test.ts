import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { kernelFixture, reviewer } from "./helpers/kernel-fixture.ts";
import { completeManagedDelivery, mergeManaged } from "../kernel-session.ts";
import { readRun } from "../node-ledger.ts";
test("旧无限 gate 不运行，统一提交节点不暗查；本地模式无远端请求", async () => {
  const f = kernelFixture(["开发评审"]); try { const marker = join(f.repo, ".autoreview.json"), raw = JSON.parse(readFileSync(marker, "utf8")); raw.gate = { cmd: "sleep 999", timeoutMin: 999 }; writeFileSync(marker, JSON.stringify(raw)); const path = f.start(); writeFileSync(join(readRun(path).worktree, "file.txt"), "checked"); let calls = 0; await completeManagedDelivery(path, "【交付完成】", { exec: f.exec, callReviewer: async () => { calls++; return reviewer(); } }); assert.equal((await mergeManaged(path, { localOnly: true })).status, "通过"); assert.equal(calls, 1); assert.equal(readRun(path).publication!.push, "未请求"); } finally { f.cleanup(); }
});
