/** batch-queue-repair：独立进程隔离环境，保持全部场景与断言。 */
import "./test-env.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { mergeQueuedBatch, queueBatchComplete, queueBatchRecheck, queueDir, queueReviewedResult, registerQueueBatch } from "../merge-queue.ts";
import { inboxPath, queueAcceptance, readJson, statusPath, writeJsonAtomic, type InboxMessage, type StageStatus } from "../pipeline-core.ts";
import { processStartTime } from "../procs.ts";
import { captureProjectConfigOverrides, parseMergeConfig } from "../config.ts";
import { loadContext, refreshContext } from "../project-context.ts";
import type { AcceptanceRecord } from "../acceptance-core.ts";
import { queueStageEvent, fixture, repeatableMulti, autoConfig, autoComplete, automaticMerged, notification, multiReady } from "./helpers/merge-queue-fixture.ts";

test("A5 冲突在干净测试工作区退回；修好重走完成事件后排到队尾", async () => {
  const f = fixture();
  try {
    f.write(0, "shared.txt", "branch\n"); f.write(1, "src/b.txt", "b\n");
    writeFileSync(join(f.repo, "shared.txt"), "release\n"); f.git(f.repo, "add", "shared.txt"); f.git(f.repo, "commit", "-qm", "release conflict");
    const before = f.batches.map((batch) => f.devEvidence(batch.cwd));
    f.complete(0); f.complete(1); await f.ready(1);
    const entry = f.queue().entries[0]; assert.equal(entry.status, "returned");
    const inbox = readJson<InboxMessage>(inboxPath(f.batches[0].dir, "甲"))!;
    assert.match(inbox.message, /shared\.txt/); assert.match(inbox.message, /合进最新发布分支/);
    assert.equal(f.git(f.queue().workspace, "status", "--porcelain"), "");
    assert.deepEqual(f.batches.map((batch) => f.devEvidence(batch.cwd)), before);
    // 以下是替身原开发会话自己的返修，不是队列修改开发空间。
    const dev = f.batches[0].cwd;
    spawnSync("git", ["merge", "main", "--no-edit"], { cwd: dev });
    f.write(0, "shared.txt", "resolved\n"); f.git(dev, "add", "shared.txt"); f.git(dev, "commit", "-qm", "developer resolves conflict");
    f.complete(0, "repaired-epoch");
    assert.deepEqual(f.queue().entries.map((item) => item.status), ["returned", "ready", "pending"]);
    assert.ok(f.queue().entries[2].order > f.queue().entries[1].order);
  } finally { await f.close(); }
});

test("A7 杀掉合并执行器后按身份恢复；不丢批次、不自动或重复合入", async () => {
  const f = fixture();
  try {
    f.write(0, "src/a.txt", "a\n"); f.write(1, "src/b.txt", "b\n"); f.mode("hold");
    const base = f.git(f.repo, "rev-parse", "HEAD"); f.complete(0); f.complete(1);
    await f.until(() => existsSync(f.events));
    const owner = readJson<{ pid: number; started: string; token: string }>(f.workerLock())!;
    assert.equal(processStartTime(owner.pid), owner.started); assert.ok(owner.token);
    process.kill(owner.pid, "SIGKILL");
    await f.until(() => processStartTime(owner.pid) !== owner.started, "测试执行器确已停止");
    f.mode("pass"); const recovered = f.cli("状态"); assert.equal(recovered.ok, true);
    await f.until(() => { const entry = f.queue().entries[0]; return entry.status === "ready" && entry.attempt >= 2; }); await f.idle();
    assert.equal(f.queue().entries.length, 2); assert.equal(f.queue().entries[1].status, "pending");
    assert.equal(f.git(f.repo, "rev-parse", "HEAD"), base);
    assert.equal(f.cli("合入", f.batches[0].file).ok, true); const merged = f.git(f.repo, "rev-parse", "HEAD");
    await f.ready(1); assert.equal(f.cli("合入", f.batches[0].file).ok, true); assert.equal(f.git(f.repo, "rev-parse", "HEAD"), merged);
  } finally { await f.close(); }
});
