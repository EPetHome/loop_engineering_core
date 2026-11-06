/** merge-queue／commit：按功能独立运行，夹具与状态不跨测试进程共享。 */
import "./test-env.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { queueBatchComplete, queueDir, queueStageEvent as realQueueStageEvent, registerQueueBatch } from "../merge-queue.ts";
import { readJson, statusPath, type StageStatus } from "../pipeline-core.ts";
import { parsePlan, runPipeline } from "../pipeline.ts";
import { workingTree } from "../commit-batch.ts";
import { queueStageEvent, ROOT, fixture, autoConfig, autoComplete, notification } from "./helpers/merge-queue-fixture.ts";

test("提交 A1/A3：含批次文档压成一个；重发幂等，推前重压，推后追加且可再次普通推送", async () => {
  const f = fixture(1);
  try {
    const dev = f.batches[0].cwd, base = f.git(f.repo, "rev-parse", "main");
    f.write(0, "batch-doc.md", "批次文档\n"); f.git(dev, "add", "batch-doc.md"); f.git(dev, "commit", "-qm", "chore: 批次文档");
    const before = f.git(dev, "rev-parse", "HEAD"); f.write(0, "src/a.txt", "one\n"); const candidate = workingTree(dev, queueDir(f.repo)).tree;
    f.complete(0, "first"); await f.ready(0);
    let record = f.queue().batches[0].commits![0];
    assert.equal(f.git(dev, "rev-list", "--count", `${base}..HEAD`), "1");
    assert.equal(f.git(dev, "rev-parse", "HEAD^{tree}"), candidate); assert.equal(record.tree, candidate);
    assert.equal(f.git(dev, "rev-parse", record.preSquash[0]), before);
    assert.equal(f.git(dev, "log", "-1", "--format=%s"), "feat: 批次0");
    assert.match(f.git(dev, "log", "-1", "--format=%b"), /段：甲[\s\S]*测试：Loop 未运行测试[\s\S]*评审：[\s\S]*验收：[\s\S]*pre-squash/);
    const ledger = readFileSync(f.queue().entries[0].ledger!, "utf8");
    assert.match(ledger, new RegExp(`${record.branch} ${record.commit}`));
    assert.match(ledger, /段：甲；测试：Loop 未运行测试；评审：没有记录；验收：没有记录；交付报告：/);
    assert.doesNotMatch(ledger, /完成资格已确认/);
    assert.ok(notification(f, f.queue().entries[0].id).includes(`交付报告：${join(f.root, "summary-0.md")}`));
    assert.match(notification(f, f.queue().entries[0].id), /已提交 feat\/b0 [0-9a-f]+。推送失败，本机提交保留/);
    assert.doesNotMatch(notification(f, f.queue().entries[0].id), /要推到远端|要不要推/);
    assert.ok(!existsSync(join(f.root, "sessions.jsonl")), "压缩不启动新的开发/评审会话");
    const first = record.commit; f.complete(0, "first"); await f.idle(); assert.equal(f.queue().entries.length, 1); assert.equal(f.git(dev, "rev-parse", "HEAD"), first);
    f.write(0, "src/a.txt", "two\n"); f.complete(0, "second"); await f.ready(0);
    assert.equal(f.git(dev, "rev-list", "--count", `${base}..HEAD`), "1");
    const remote = join(f.root, "remote.git"); f.git(f.root, "init", "--bare", "-q", remote); f.git(f.repo, "remote", "add", "origin", remote);
    assert.equal(f.cli("推送", f.batches[0].file).ok, true); const pushed = f.queue().batches[0].commits![0].pushed!;
    f.write(0, "src/a.txt", "three\n"); f.complete(0, "third"); await f.ready(0);
    record = f.queue().batches[0].commits![0];
    assert.equal(f.git(dev, "rev-list", "--count", `${base}..HEAD`), "2"); assert.equal(f.git(dev, "rev-parse", "HEAD^"), pushed);
    assert.match(f.git(dev, "log", "-1", "--format=%b"), /推送后的追加改动/);
    assert.equal(f.cli("推送", f.batches[0].file).ok, true); assert.equal(f.git(remote, "rev-parse", "feat/b0"), record.commit);
  } finally { await f.close(); }
});

test("提交 A2：三段无整批验收，运行中逐段提交，最后整体压缩并进队", async () => {
  const f = fixture(1);
  try {
    const dev = f.batches[0].cwd, file = join(f.root, "serial.json"), dir = join(f.root, "serial"), base = f.git(f.repo, "rev-parse", "main");
    f.write(0, "batch-doc.md", "docs\n"); f.git(dev, "add", "."); f.git(dev, "commit", "-qm", "chore: 批次文档");
    const names = ["甲", "乙", "丙"], raw = { name: "三段串行", branch: f.batches[0].branch, dir, stages: Object.fromEntries(names.map((name) => [name, { cwd: dev, start: "true" }])), steps: names.map((name) => [name]) };
    writeFileSync(file, JSON.stringify(raw)); registerQueueBatch(f.repo, { name: raw.name, file, dir, project: f.repo, release: "main", steps: raw.steps, stages: names.map((name) => ({ name, cwd: dev, branch: raw.branch, start: "true" })) });
    const counts: string[] = [];
    const code = await runPipeline(parsePlan(raw, f.root, process.env, { batchFile: file, projectRoot: f.repo }), {
      launch: (stage) => {
        counts.push(f.git(dev, "rev-list", "--count", `${base}..HEAD`)); f.write(0, `${stage.name}.txt`, `${stage.name}\n`);
        queueStageEvent({ cwd: dev, file, stage: stage.name, status: { sessionId: stage.name, event: "done", readyEpoch: stage.name, summary: "", inbox: 0 } });
      }, notify: () => {}, log: () => {}, pollMs: 20, silenceMs: 1000,
      preflightEnv: { pi: process.env.PI_BIN, permission: process.env.PERMISSION_EXTENSION, autoreview: join(ROOT, "autoreview.ts"), playwright: () => true },
    });
    assert.equal(code, 0, readFileSync(join(dir, "report.md"), "utf8")); assert.deepEqual(counts, ["1", "2", "3"]);
    await f.until(() => f.queue().entries[0]?.status === "ready"); await f.idle();
    const record = f.queue().batches.find((batch) => batch.name === raw.name)!.commits![0];
    assert.equal(f.git(dev, "rev-list", "--count", `${base}..HEAD`), "1");
    assert.equal(f.git(dev, "rev-list", "--count", `${base}..${record.preSquash[0]}`), "4");
    assert.equal(f.queue().entries[0].sources[0].commit, f.git(dev, "rev-parse", "HEAD"));
  } finally { await f.close(); }
});

test("提交 A4：检查后新增文件拒绝提交，分支不变并暂停", async () => {
  const f = fixture(1);
  try {
    const dev = f.batches[0].cwd; f.write(0, "src/a.txt", "checked\n"); const candidate = workingTree(dev, queueDir(f.repo)).tree, head = f.git(dev, "rev-parse", "HEAD");
    f.write(0, "late.txt", "not checked\n");
    assert.throws(() => realQueueStageEvent({ cwd: dev, file: f.batches[0].file, stage: "甲", status: { sessionId: "checked", event: "done", readyEpoch: "checked", summary: "", inbox: 0, candidate } }), /候选已变化/);
    assert.equal(f.git(dev, "rev-parse", "HEAD"), head); assert.equal(f.queue().entries.length, 0);
    assert.equal(readJson<StageStatus>(statusPath(f.batches[0].dir, "甲"))!.event, "paused");
  } finally { await f.close(); }
});

test("提交 A5：替身制造提交树不一致，恢复分支和索引，暂停且不进队", async () => {
  const f = fixture(1);
  try {
    const dev = f.batches[0].cwd, head = f.git(dev, "rev-parse", "HEAD"), tree = f.git(dev, "rev-parse", "HEAD^{tree}");
    f.write(0, "src/a.txt", "checked\n"); const before = f.evidence(dev), realGit = spawnSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
    const wrapper = join(f.root, "bin", "git"), marker = join(f.root, "updated");
    writeFileSync(wrapper, `#!/bin/sh\ncase " $* " in\n *" update-ref refs/heads/feat/b0 "*) : > '${marker}';;\nesac\ncase " $* " in\n *" rev-parse "*"^{tree}"*) if [ -f '${marker}' ]; then echo '${tree}'; exit 0; fi;;\nesac\nexec '${realGit}' "$@"\n`); chmodSync(wrapper, 0o755);
    assert.throws(() => f.complete(0), /树与候选树不一致[\s\S]*已恢复[\s\S]*暂停/);
    rmSync(wrapper); assert.equal(f.git(dev, "rev-parse", "HEAD"), head); assert.deepEqual(f.evidence(dev), before); assert.equal(f.queue().entries.length, 0);
    const batch = f.queue().batches[0]; assert.equal(f.git(dev, "rev-parse", `refs/loop/batches/${batch.id}/pre-squash/1`), head);
    assert.equal(readJson<StageStatus>(statusPath(f.batches[0].dir, "甲"))!.event, "paused");
  } finally { await f.close(); }
});

test("提交 A6/A7：旧自动配置只提醒；推送只发批次分支，远端分歧拒绝且不强推", async () => {
  const f = fixture(1);
  try {
    const remote = join(f.root, "remote.git"); f.git(f.root, "init", "--bare", "-q", remote);
    f.git(f.repo, "remote", "add", "origin", remote);
    const base = f.git(f.repo, "rev-parse", "main");
    autoConfig(f, true); f.write(0, "src/a.txt", "push\n"); autoComplete(f, 0); await f.ready(0);
    assert.equal(f.git(f.repo, "rev-parse", "main"), base);
    assert.equal(f.git(remote, "for-each-ref", "--format=%(refname)", "refs/heads"), "refs/heads/feat/b0", "批次完成已自动推送同名分支");
    const preview = f.cli("推送", f.batches[0].file, "--dry-run"); assert.equal(preview.ok, true); assert.equal(preview.pushed, null);
    const outsideBatch = join(f.root, "outside-batch.json"); writeFileSync(outsideBatch, readFileSync(f.batches[0].file));
    assert.equal(f.cli("推送", outsideBatch, "--dry-run").ok, true, "与其他子命令一样支持仓库外的批次入口");
    assert.equal(f.git(remote, "for-each-ref", "--format=%(refname)", "refs/heads"), "refs/heads/feat/b0", "dry-run 不改变已经自动推送的远端");
    const pushed = f.cli("推送", f.batches[0].file); assert.equal(pushed.ok, true);
    const commit = f.queue().batches[0].commits![0]; assert.equal(commit.pushed, commit.commit);
    assert.equal(pushed.v, 1); assert.equal(pushed.action, "推送"); assert.equal(pushed.branch, "feat/b0"); assert.equal(pushed.remote, "origin"); assert.equal(pushed.pushed, commit.commit);
    assert.equal(f.git(remote, "for-each-ref", "--format=%(refname)", "refs/heads"), "refs/heads/feat/b0");
    assert.equal(f.git(f.repo, "config", "branch.feat/b0.remote"), "origin");
    assert.equal(f.git(f.repo, "config", "branch.feat/b0.merge"), "refs/heads/feat/b0");
    const foreign = f.git(f.repo, "commit-tree", `${commit.commit}^{tree}`, "-p", commit.commit, "-m", "remote advance");
    f.git(f.repo, "push", "origin", `${foreign}:refs/heads/feat/b0`);
    f.write(0, "src/a.txt", "local advance\n"); autoComplete(f, 0); await f.ready(0);
    const rejected = f.cli("推送", f.batches[0].file); assert.equal(rejected.ok, false); assert.match(rejected.error, /未强推[\s\S]*(rejected|fetch first|non-fast-forward)/i);
    assert.equal(rejected.v, 1); assert.equal(rejected.action, "推送"); assert.equal(rejected.branch, "feat/b0"); assert.equal(rejected.remote, "origin"); assert.equal(rejected.pushed, null);
    assert.ok(rejected.reason.category); assert.ok(rejected.reason.text);
    assert.equal(f.git(remote, "rev-parse", "refs/heads/feat/b0"), foreign);
    assert.equal(f.queue().batches[0].commits![0].pushed, commit.commit, "失败不覆盖上次成功推送记录");
    assert.equal(f.git(f.repo, "rev-parse", "main"), base);
    const merged = f.cli("合入", f.batches[0].file); assert.equal(merged.ok, true); await f.idle();
    assert.equal(merged.v, 1); assert.equal(merged.action, "合入"); assert.equal(merged.release, "main"); assert.equal(merged.merged, f.git(f.repo, "rev-parse", "main")); assert.equal(merged.queueStatus, "merged");
    assert.equal(f.git(remote, "for-each-ref", "--format=%(refname)", "refs/heads"), "refs/heads/feat/b0");
  } finally { await f.close(); }
});
