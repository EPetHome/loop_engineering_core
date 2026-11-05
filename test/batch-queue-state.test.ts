/** batch-queue-state：独立进程隔离环境，保持全部场景与断言。 */
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

test("A1/A2/A3/A8 自动 FIFO；可合入前不改发布版；合入的提交和树就是测过的结果；开发脏改动原样保留", async () => {
  const f = fixture();
  try {
    f.write(0, "src/a.txt", "a\n"); f.write(1, "src/b.txt", "b\n");
    writeFileSync(join(f.repo, "unrelated.txt"), "staged\n"); f.git(f.repo, "add", "unrelated.txt"); writeFileSync(join(f.repo, "unrelated.txt"), "unstaged\n");
    const runtime = f.evidence(f.repo), developers = f.batches.map((batch) => f.devEvidence(batch.cwd));
    f.mode("hold"); f.complete(0); f.complete(1);
    await f.until(() => f.queue().entries[0]?.status === "testing" && existsSync(f.events));
    assert.deepEqual(f.queue().entries.map((entry) => entry.status), ["testing", "pending"]);
    const status = f.cli("状态"); assert.deepEqual(status.queue.map((entry: any) => entry.position), [1, 2]);
    assert.equal(f.cli("合入", f.batches[1].file).ok, false, "不能绕过队头");
    writeFileSync(join(f.root, "release"), "go"); await f.ready(0);
    assert.deepEqual(f.queue().entries.map((entry) => entry.status), ["ready", "pending"]);
    const first = f.queue().entries[0];
    assert.match(readFileSync(join(queueDir(f.repo), `${first.id}.notification.txt`), "utf8"), /可合入/);
    assert.deepEqual(f.evidence(f.repo), runtime, "测试不碰运行版、暂存区和未提交内容");
    assert.deepEqual(f.batches.map((batch) => f.devEvidence(batch.cwd)), developers, "程序提交不改变开发树或本机文件");
    const merged = f.cli("合入", f.batches[0].file); assert.equal(merged.ok, true, JSON.stringify(merged));
    assert.equal(f.git(f.repo, "rev-parse", "HEAD"), first.result); assert.equal(f.git(f.repo, "rev-parse", "HEAD^{tree}"), first.tree);
    assert.equal(readFileSync(join(f.repo, "src/a.txt"), "utf8"), "a\n");
    assert.equal(readFileSync(join(f.repo, "unrelated.txt"), "utf8"), "unstaged\n"); assert.equal(f.git(f.repo, "show", ":unrelated.txt"), "staged");
    await f.ready(1); assert.equal(f.queue().entries[1].base, first.result);
    assert.equal(f.cli("合入", f.batches[0].file).ok, true, "重复用户合入幂等");
    assert.equal(f.git(f.repo, "rev-parse", "HEAD"), first.result);
    assert.deepEqual(f.batches.map((batch) => f.devEvidence(batch.cwd)), developers);
  } finally { await f.close(); }
});

test("队列工作区／第一批已测试后仍能开工第二批；只豁免核对过身份的队列 worktree", async () => {
  const f = fixture(2, 1);
  try {
    f.write(0, "src/a.txt", "a\n"); f.complete(0); await f.ready(0);
    const opened = f.cli("开工", f.batches[1].file); assert.equal(opened.ok, true, JSON.stringify(opened));
    f.write(1, "src/b.txt", "b\n"); f.complete(1); await f.idle();
    assert.deepEqual(f.queue().entries.map((entry) => entry.status), ["ready", "pending"]);
    assert.equal(f.cli("合入", f.batches[0].file).ok, true); await f.ready(1);
    const registration = f.queue().batches[0];
    f.git(f.queue().workspace, "switch", "-c", "feat/not-owned");
    assert.throws(() => registerQueueBatch(f.repo, registration), /测试工作区身份不符/);
  } finally { await f.close(); }
});

test("队列资格／队头完成资格撤销后退出活动队列，后续批次继续；旧结果不可合入", async (t) => {
  for (const phase of ["ready", "testing"]) await t.test(phase, async () => {
    const f = fixture();
    try {
      f.write(0, "src/a.txt", "a\n"); f.write(1, "src/b.txt", "b\n");
      const runtime = f.evidence(f.repo), developers = f.batches.map((batch) => f.devEvidence(batch.cwd));
      if (phase === "testing") f.mode("hold");
      f.complete(0); f.complete(1);
      if (phase === "ready") await f.ready(0); else await f.until(() => existsSync(f.events));
      const status = readJson<StageStatus>(statusPath(f.batches[0].dir, "甲"))!;
      queueStageEvent({ cwd: f.batches[0].cwd, file: f.batches[0].file, stage: "甲", status: { ...status, event: "started", readyEpoch: undefined } });
      writeFileSync(join(f.root, "release"), "go"); await f.ready(1);
      assert.equal(f.queue().entries[0].status, "blocked"); assert.match(f.queue().entries[0].reason!, /完成资格已变化/);
      const denied = f.cli("合入", f.batches[0].file); assert.equal(denied.ok, false); assert.match(denied.error, /完成资格已变化/);
      assert.deepEqual(f.evidence(f.repo), runtime); assert.deepEqual(f.batches.map((batch) => f.devEvidence(batch.cwd)), developers);
    } finally { await f.close(); }
  });
});

test("队列资格／整合重验撤销正在测试的旧资格，失败/中断未回报新结果也不会发布旧结果", async () => {
  const f = fixture(1);
  try {
    autoConfig(f); f.write(0, "src/a.txt", "candidate\n"); const { file, passed, partial } = multiReady(f), base = f.git(f.repo, "rev-parse", "HEAD");
    f.mode("hold"); const firstEpoch = queueBatchRecheck(f.repo, file); queueBatchComplete(f.repo, file, true, passed, firstEpoch);
    await f.until(() => existsSync(f.events) && f.queue().entries[0]?.status === "testing");
    const secondEpoch = queueBatchRecheck(f.repo, file); writeFileSync(join(f.root, "release"), "go"); await f.idle();
    assert.equal(f.queue().entries[0].status, "blocked"); assert.match(f.queue().entries[0].reason!, /整批验收完成资格已变化/); assert.equal(f.git(f.repo, "rev-parse", "HEAD"), base);
    queueBatchComplete(f.repo, file, true, passed, firstEpoch); await f.idle(); assert.equal(f.queue().entries.length, 1, "迟到的通过不能覆盖新一轮");
    queueBatchComplete(f.repo, file, false, partial, secondEpoch); await f.idle();
    assert.equal(f.queue().entries.length, 1, "部分验证不进队"); assert.equal(f.queue().entries[0].status, "blocked");
    assert.equal(f.git(f.repo, "rev-parse", "HEAD"), base);
    queueBatchComplete(f.repo, file, true, passed, secondEpoch);
    await f.until(() => f.queue().entries[1]?.status === "ready" && Boolean(f.queue().entries[1]?.notified)); await f.idle();
  } finally { await f.close(); }
});
