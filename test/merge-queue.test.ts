/** 旧队列不再授予免审/合入资格，历史只读不恢复。 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import * as queue from "../merge-queue.ts";
import { parseMergeConfig } from "../config.ts";
import { queryBatches } from "../query.ts";
import { fixture } from "./helpers/merge-queue-fixture.ts";
test("无任何旧登记/检查/免审/恢复/发布入口；旧字段不授予权限", () => {
  for (const key of ["runMergeQueue", "registerQueueBatch", "queueReviewedResult", "queueStageEvent", "recoverMergeQueue", "pushQueueBatch", "mergeQueuedBatch", "retargetQueueBatch"]) assert.equal(Object.hasOwn(queue, key), false, key);
  assert.deepEqual(parseMergeConfig({ auto: true, push: true }), { auto: false, push: false });
  const f = fixture(); try { const before = f.snapshot(), direct = spawnSync(process.execPath, [fileURLToPath(new URL("../merge-queue.ts", import.meta.url)), "--worker", f.queueFile], { cwd: f.repo, env: process.env, encoding: "utf8" }); assert.equal(direct.status, 2); assert.match(direct.stderr, /旧合入队列执行器.*已停用.*bin\/loop 合入/); assert.deepEqual(f.snapshot(), before); } finally { f.close(); }
});
test("历史 blocked/testing/旧门禁与 e2e 元数据不改为 pending，不生成新通过记录", () => {
  const f = fixture();
  try { for (const status of ["pending", "checking", "testing", "ready", "blocked", "returning", "merging", "withdrawn"] as any[]) { (f.history.entries[0] as any).status = status; Object.assign(f.history.entries[0], { gate: { command: "do-not-run" }, testTimeout: true, reason: "原失败事实", integrationEpoch: "old" }); f.saveHistory(); const before = f.bytes(); assert.equal(f.read().entries[0].status, status); queryBatches(f.oldFile); assert.deepEqual(f.bytes(), before); } } finally { f.close(); }
});
test("旧合入、推送与改目标在普通/预览均拒绝，用户材料/队列原文不改", () => {
  const f = fixture(); try { for (const command of ["合入", "推送", "撤回"]) { f.refuse(command); f.refuse(command, ["--dry-run"]); } } finally { f.close(); }
});
