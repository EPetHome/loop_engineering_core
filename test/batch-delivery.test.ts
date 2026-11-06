/** batch-delivery：按功能独立运行，夹具与状态不跨测试进程共享。 */
import "./test-env.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { workingTree } from "../commit-batch.ts";
import { queueAcceptance } from "../pipeline-core.ts";
import { queueCommitNotice, queueStageEvent, recoverMergeQueue, registerQueueBatch } from "../merge-queue.ts";
import { fixture } from "./helpers/batch-delivery-fixture.ts";

test("批次自动推送：不运行或复用测试，核对后自动提交目标分支，默认不部署", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.batches[0].cwd, "code.txt"), "checked\n"); f.complete();
    await f.until(() => f.queue().entries[0]?.status === "merged"); await f.idle();
    const batch = f.queue().batches[0], entry = f.queue().entries[0], commit = batch.commits![0];
    assert.equal(f.git(f.remote, "rev-parse", commit.branch), commit.commit); assert.equal(commit.pushed, commit.commit);
    assert.equal(f.git(f.repo, "rev-parse", f.release), entry.result); assert.equal(f.git(f.remote, "rev-parse", f.release), f.base);
    assert.deepEqual(f.gates(), []); assert.equal(Object.hasOwn(entry, "reusedTest"), false);
    assert.equal(entry.testConclusion, "Loop 未运行测试");
    assert.match(f.notice(), /已自动提交到目标分支[\s\S]*Loop 未运行测试[\s\S]*已推送到 origin\/feat\/delivery-0/);
    assert.doesNotMatch(f.notice(), /要不要推|要推到远端|请执行.*推送/); assert.equal(entry.deployment?.status, "disabled"); assert.deepEqual(f.deployments(), []);
    assert.match(readFileSync(entry.ledger!, "utf8"), /部署：未开启/); assert.match(readFileSync(entry.ledger!, "utf8"), /Loop 未运行测试/);
    assert.match(queueCommitNotice(f.batches[0].cwd, { AUTOREVIEW_BATCH_FILE: f.batches[0].file, AUTOREVIEW_STAGE: "dev" }), /部署：未开启/);
    recoverMergeQueue(f.repo); await f.idle(); assert.equal(f.queue().entries.length, 1);
  } finally { await f.close(); }
});

test("批次远端分歧：自动推送失败保留本机提交和 Git 原因，不强推、不自动重试", async () => {
  const f = fixture({ release: "main" });
  try {
    const foreign = f.git(f.repo, "commit-tree", `${f.base}^{tree}`, "-p", f.base, "-m", "remote-only");
    f.git(f.repo, "push", "-q", "origin", `${foreign}:refs/heads/${f.batches[0].branch}`);
    writeFileSync(join(f.batches[0].cwd, "code.txt"), "local\n"); f.complete(); await f.until(() => f.queue().entries[0]?.status === "ready"); await f.idle();
    const commit = f.queue().batches[0].commits![0]; assert.equal(f.git(f.batches[0].cwd, "rev-parse", "HEAD"), commit.commit);
    assert.equal(f.git(f.remote, "rev-parse", f.batches[0].branch), foreign); assert.equal(commit.pushed, undefined);
    assert.match(f.notice(), /推送失败，本机提交保留[\s\S]*(rejected|fetch first|non-fast-forward)/i);
    recoverMergeQueue(f.repo); await f.idle(); assert.equal(f.queue().batches[0].commits![0].pushResult?.status, "failed"); assert.equal(f.queue().entries.length, 1);
  } finally { await f.close(); }
});

test("目标分支前进：核对最新目标加候选后自动提交，不运行测试或推目标分支", async () => {
  const f = fixture();
  try {
    const base = f.advance(); writeFileSync(join(f.batches[0].cwd, "code.txt"), "checked\n"); f.complete();
    await f.until(() => f.queue().entries[0]?.status === "merged"); await f.idle();
    const entry = f.queue().entries[0], gates = f.gates().filter((item) => item.queued);
    assert.equal(gates.length, 0); assert.equal(entry.base, base);
    assert.equal(Object.hasOwn(entry, "reusedTest"), false); assert.equal(entry.testConclusion, "Loop 未运行测试");
    assert.equal(f.git(f.repo, "rev-parse", f.release), entry.result); assert.equal(f.git(f.remote, "rev-parse", f.release), f.base);
    assert.equal(readFileSync(join(f.repo, "code.txt"), "utf8"), "checked\n");
  } finally { await f.close(); }
});

test("主分支保护：main 和 master 都保留可合入，不自动提交", async (t) => {
  for (const release of ["main", "master"]) await t.test(release, async () => {
    const f = fixture({ release });
    try {
      writeFileSync(join(f.batches[0].cwd, "code.txt"), "checked\n"); f.complete(); await f.until(() => f.queue().entries[0]?.status === "ready" && Boolean(f.queue().entries[0].notified)); await f.idle();
      assert.equal(f.git(f.repo, "rev-parse", release), f.base); assert.match(f.notice(), new RegExp(`${release} 由你自己合`));
      assert.equal(f.gates().filter((item) => item.queued).length, 0);
    } finally { await f.close(); }
  });
});

test("旧测试证据缺失或树不匹配均忽略，不执行队列测试", async (t) => {
  for (const kind of ["missing", "different-tree"]) await t.test(kind, async () => {
    const f = fixture({ release: "main" });
    try {
      writeFileSync(join(f.batches[0].cwd, "code.txt"), "checked\n");
      if (kind === "missing") f.complete(0, false);
      else {
        const batch = f.batches[0], candidate = workingTree(batch.cwd, f.root).tree;
        queueStageEvent({ cwd: batch.cwd, file: batch.file, stage: "dev", status: { sessionId: "old-tree", event: "done", readyEpoch: randomUUID(), summary: "", inbox: 0, candidate, acceptance: queueAcceptance(),
          ...{ test: { candidate: f.git(f.repo, "rev-parse", "HEAD^{tree}"), result: "通过", command: f.config.gate.cmd, round: 1, startedAt: new Date().toISOString() } } } });
      }
      await f.until(() => f.queue().entries[0]?.status === "ready"); await f.idle();
      assert.deepEqual(f.gates(), []); assert.equal(Object.hasOwn(f.queue().entries[0], "reusedTest"), false);
    } finally { await f.close(); }
  });
});

test("自动提交比较交换：发布边界发生并发提交时不覆盖，重新核对最新目标后继续", async () => {
  const f = fixture();
  try {
    const realGit = spawnSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
    const external = f.git(f.repo, "commit-tree", `${f.base}^{tree}`, "-p", f.base, "-m", "concurrent target commit");
    const wrapper = join(f.root, "bin", "git"), marker = join(f.root, "cas-raced");
    writeFileSync(wrapper, `#!/bin/sh\ncase " $* " in\n *" update-ref refs/heads/release "*) if [ ! -f '${marker}' ]; then : > '${marker}'; '${realGit}' update-ref refs/heads/release '${external}' '${f.base}' || exit 1; fi;;\nesac\nexec '${realGit}' "$@"\n`); chmodSync(wrapper, 0o755);
    writeFileSync(join(f.batches[0].cwd, "code.txt"), "checked\n"); f.complete();
    await f.until(() => f.queue().entries[0]?.status === "merged"); await f.idle();
    const entry = f.queue().entries[0]; assert.ok(entry.attempt >= 2); assert.equal(entry.base, external);
    assert.deepEqual(f.gates(), [], "CAS 拒绝后重新核对整合结果，不运行测试");
    assert.equal(f.git(f.repo, "merge-base", external, entry.result!), external); assert.equal(f.git(f.repo, "rev-parse", "HEAD"), entry.result);
  } finally { await f.close(); }
});

test("不同目标分支独立排队：main 等待手动合入不阻塞另一个运行版的自动提交", async () => {
  const f = fixture({ release: "main", count: 2 });
  try {
    const runtime = join(f.root, "release-runtime"), file = join(f.root, "secondary.json"), dir = join(f.root, "secondary");
    f.git(f.repo, "worktree", "add", "-qb", "release", runtime, f.base);
    for (const cwd of [runtime, f.batches[1].cwd]) {
      writeFileSync(join(cwd, ".autoreview.json"), JSON.stringify({ ...f.config, release: "release" }));
      f.git(cwd, "add", ".autoreview.json"); f.git(cwd, "commit", "-qm", "secondary target configuration");
    }
    writeFileSync(file, JSON.stringify({ name: "secondary", dir, stages: { dev: { workflow: "without-acceptance" } } }));
    registerQueueBatch(runtime, { name: "secondary", file, dir, project: runtime, release: "release", stages: [{ name: "dev", cwd: f.batches[1].cwd, branch: f.batches[1].branch, start: "true" }], steps: [["dev"]] });
    writeFileSync(join(f.batches[0].cwd, "code.txt"), "main candidate\n"); f.complete();
    await f.until(() => f.queue().entries[0]?.status === "ready");
    writeFileSync(join(f.batches[1].cwd, "code.txt"), "release candidate\n");
    queueStageEvent({ cwd: f.batches[1].cwd, file, stage: "dev", status: { sessionId: "secondary", event: "done", readyEpoch: randomUUID(), candidate: workingTree(f.batches[1].cwd, f.root).tree, summary: "", inbox: 0, acceptance: queueAcceptance() } });
    await f.until(() => f.queue().entries[1]?.status === "merged"); await f.idle();
    assert.equal(f.queue().entries[0].status, "ready"); assert.equal(f.git(f.repo, "rev-parse", "main"), f.base);
    assert.equal(f.git(runtime, "rev-parse", "HEAD"), f.queue().entries[1].result); assert.equal(readFileSync(join(runtime, "code.txt"), "utf8"), "release candidate\n");
    assert.equal(readFileSync(join(f.repo, "code.txt"), "utf8"), "base\n");
  } finally { await f.close(); }
});
