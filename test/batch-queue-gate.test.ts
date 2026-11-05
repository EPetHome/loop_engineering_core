/** batch-queue-gate：独立进程隔离环境，保持全部场景与断言。 */
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

test("队列门禁／失败门禁留下诊断文件或改了跟踪文件，仍清理并带输出退回，不阻塞下一批", async (t) => {
  for (const kind of ["untracked", "tracked"]) await t.test(kind, async () => {
    const f = fixture();
    try {
      f.write(0, "src/a.txt", "bad\n"); f.write(1, "src/b.txt", "bad\n");
      const runtime = f.evidence(f.repo), developers = f.batches.map((batch) => f.devEvidence(batch.cwd));
      f.mode(`fail-dirty-${kind}`); f.complete(0); f.complete(1);
      await f.until(() => f.queue().entries.length === 2 && f.queue().entries.every((entry) => entry.status === "returned")); await f.idle();
      assert.equal(f.git(f.queue().workspace, "status", "--porcelain"), ""); assert.ok(!existsSync(join(f.queue().workspace, "diagnostic.txt")));
      for (const [index, entry] of f.queue().entries.entries()) {
        assert.match(readJson<InboxMessage>(inboxPath(f.batches[index].dir, "甲"))!.message, /GATE_OUTPUT_SENTINEL/);
        assert.match(readFileSync(entry.log!, "utf8"), /GATE_OUTPUT_SENTINEL/);
        assert.doesNotMatch(notification(f, entry.id), /可合入/);
      }
      assert.deepEqual(f.evidence(f.repo), runtime); assert.deepEqual(f.batches.map((batch) => f.devEvidence(batch.cwd)), developers);
    } finally { await f.close(); }
  });
  await t.test("成功门禁改了候选仍不能通过", async () => {
    const f = fixture(1);
    try {
      f.write(0, "src/a.txt", "a\n"); f.mode("pass-dirty-tracked"); f.complete(0);
      await f.until(() => /门禁改变了测试工作区/.test(f.queue().entries[0]?.reason ?? "")); await f.idle();
      const entry = f.queue().entries[0]; assert.notEqual(entry.status, "ready");
      assert.doesNotMatch(notification(f, entry.id), /可合入/); assert.equal(f.git(f.queue().workspace, "status", "--porcelain"), "");
    } finally { await f.close(); }
  });
});

test("自动 A4/A5：合得上但门禁失败标为批次间冲突；第三次停止自动排队，不进入用户接管清零", async () => {
  const f = fixture();
  try {
    f.write(0, "src/a.txt", "a\n"); autoComplete(f, 0); await automaticMerged(f, 0); // 无 merge 配置也必须第三次停止。
    f.mode("fail"); f.write(1, "src/b.txt", "b\n");
    for (let count = 1; count <= 3; count += 1) {
      autoComplete(f, 1); await f.until(() => f.queue().entries.at(-1)?.status === (count === 3 ? "stopped" : "returned")); await f.idle();
      const entry = f.queue().entries.at(-1)!; assert.equal(entry.returnCount, count); assert.equal(entry.conflictKind, "integration");
      assert.match(readJson<InboxMessage>(inboxPath(f.batches[1].dir, "甲"))!.message, /与已合入批次冲突[\s\S]*不记为本批自身缺陷/);
    }
    const stopped = f.queue().entries.at(-1)!; assert.match(notification(f, stopped.id), /第 3 次退回，停止自动排队/);
    const length = f.queue().entries.length, previousCommit = f.queue().batches[1].commits![0].commit;
    f.mode("pass"); f.write(1, "src/b.txt", "finished after stop\n"); autoComplete(f, 1); f.cli("状态"); await f.idle();
    assert.equal(f.queue().entries.length, length, "停止后不再自动排队");
    assert.notEqual(f.queue().batches[1].commits![0].commit, previousCommit, "停止排队不阻止正常完成提交，仍能交给用户推送");
  } finally { await f.close(); }
});
