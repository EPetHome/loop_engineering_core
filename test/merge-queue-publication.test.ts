/** merge-queue／publication：按功能独立运行，夹具与状态不跨测试进程共享。 */
import "./test-env.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { inboxPath, readJson, type InboxMessage, type QueueAcceptance } from "../pipeline-core.ts";
import { fixture, autoConfig, autoComplete, automaticMerged, notification } from "./helpers/merge-queue-fixture.ts";

test("A4 发布基线变化拒绝合入，自动在新基线上重测；批次候选变化不能沿用旧评审资格", async () => {
  const f = fixture(1);
  try {
    f.write(0, "src/a.txt", "a\n"); f.complete(0); await f.ready(0);
    const first = f.queue().entries[0].result;
    writeFileSync(join(f.repo, "external.txt"), "new release\n"); f.git(f.repo, "add", "external.txt"); f.git(f.repo, "commit", "-qm", "other release");
    const base = f.git(f.repo, "rev-parse", "HEAD");
    const denied = f.cli("合入", f.batches[0].file); assert.equal(denied.ok, false); assert.match(denied.error, /发布分支已经变化/);
    assert.equal(f.git(f.repo, "rev-parse", "HEAD"), base);
    await f.until(() => { const entry = f.queue().entries[0]; return entry.attempt >= 2 && entry.status === "ready"; }); await f.idle();
    assert.equal(f.queue().entries[0].base, base); assert.notEqual(f.queue().entries[0].result, first);
    f.write(0, "src/a.txt", "unreviewed\n");
    const changed = f.cli("合入", f.batches[0].file); assert.equal(changed.ok, false); assert.match(changed.error, /候选已变化/);
    assert.equal(f.git(f.repo, "rev-parse", "HEAD"), base);
  } finally { await f.close(); }
});

test("A4 合入核对之后发布分支并发变化：Git 比较交换拒绝，不把旧测试结果盖上去", async () => {
  const f = fixture(1);
  try {
    f.write(0, "src/a.txt", "a\n"); f.complete(0); await f.ready(0);
    const entry = f.queue().entries[0], tree = f.git(f.repo, "rev-parse", "HEAD^{tree}");
    const external = f.git(f.repo, "commit-tree", tree, "-p", entry.base!, "-m", "concurrent release");
    const realGit = spawnSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
    const wrapper = join(f.root, "bin", "git"), once = join(f.root, "concurrent-update");
    writeFileSync(wrapper, `#!/bin/sh\ncase " $* " in\n *" update-ref refs/heads/main "*)\n if [ ! -f '${once}' ]; then : > '${once}'; '${realGit}' update-ref refs/heads/main '${external}' '${entry.base}'; fi;;\nesac\nexec '${realGit}' "$@"\n`); chmodSync(wrapper, 0o755);
    const denied = f.cli("合入", f.batches[0].file); assert.equal(denied.ok, false); assert.match(denied.error, /发布分支已经变化/);
    assert.equal(f.git(f.repo, "rev-parse", "HEAD"), external); assert.ok(!existsSync(join(f.repo, "src/a.txt")));
    await f.until(() => { const entry = f.queue().entries[0]; return entry.status === "ready" && entry.base === external; }); await f.idle();
  } finally { await f.close(); }
});

test("用户合入 A1/A6：精确发布测过的提交，无评审；两个人工记账，不重叠暂存改动恢复", async () => {
  const f = fixture(1);
  try {
    autoConfig(f); f.write(0, "src/a.txt", "auto\n");
    writeFileSync(join(f.repo, "unrelated.txt"), "staged\n"); f.git(f.repo, "add", "unrelated.txt"); writeFileSync(join(f.repo, "unrelated.txt"), "unstaged\n");
    const before = f.devEvidence(f.batches[0].cwd), cached = f.git(f.repo, "diff", "--cached", "--binary");
    const acceptance: QueueAcceptance = { failed: [], partial: [], manual: [
      { id: "A1", text: "人工判断一", detail: "未验" }, { id: "A2", text: "人工判断二", detail: "未验" },
    ] };
    autoComplete(f, 0, acceptance); const entry = await automaticMerged(f, 0);
    assert.equal(f.git(f.repo, "rev-parse", "HEAD"), entry.result); assert.equal(f.git(f.repo, "rev-parse", "HEAD^{tree}"), entry.tree);
    assert.equal(f.git(f.repo, "diff", "--cached", "--binary"), cached); assert.equal(readFileSync(join(f.repo, "unrelated.txt"), "utf8"), "unstaged\n");
    assert.deepEqual(f.devEvidence(f.batches[0].cwd), before); assert.ok(!existsSync(join(f.root, "sessions.jsonl")), "队列不启动开发/评审会话");
    assert.match(notification(f, entry.id), /可合入[\s\S]*已提交[\s\S]*推送失败，本机提交保留/);
    const ledger = readFileSync(entry.ledger!, "utf8"); assert.match(ledger, new RegExp(`已提交 feat/b0 ${entry.sources[0].commit}`));
    assert.match(ledger, /甲\/A1 待验：人工判断一/); assert.match(ledger, /甲\/A2 待验：人工判断二/);
    const again = f.cli("状态"); assert.equal(again.ok, true); await f.idle(); assert.equal(readFileSync(entry.ledger!, "utf8"), ledger, "恢复不重复记账");
  } finally { await f.close(); }
});

test("用户合入 A3：A 先合入，B 文本冲突附文件与批次说明；原会话解冲突后到队尾并显式合入", async () => {
  const f = fixture();
  try {
    autoConfig(f); f.mode("hold");
    f.write(0, "shared.txt", "A version\n"); f.git(f.batches[0].cwd, "add", "shared.txt"); f.git(f.batches[0].cwd, "commit", "-qm", "feat: A 统一共享文案的原因");
    f.write(1, "shared.txt", "B version\n"); autoComplete(f, 0); await f.until(() => existsSync(f.events)); autoComplete(f, 1);
    writeFileSync(join(f.root, "release"), "go"); await automaticMerged(f, 0); await f.until(() => f.queue().entries[1]?.status === "returned"); await f.idle();
    const first = f.queue().entries[0], returned = f.queue().entries[1], inbox = readJson<InboxMessage>(inboxPath(f.batches[1].dir, "甲"))!;
    assert.equal(first.status, "merged"); assert.match(inbox.message, /已先合入的批次：批次0/); assert.match(inbox.message, /shared\.txt/); assert.match(inbox.message, /feat: 批次0/);
    const dev = f.batches[1].cwd;
    spawnSync("git", ["merge", "main", "--no-edit"], { cwd: dev });
    f.write(1, "shared.txt", "resolved A+B\n"); f.git(dev, "add", "shared.txt"); f.git(dev, "commit", "-qm", "fix: resolve A+B");
    f.mode("pass"); autoComplete(f, 1); const merged = await automaticMerged(f, 1);
    assert.ok(merged.order > returned.order); assert.equal(f.git(f.repo, "rev-parse", "HEAD"), merged.result);
    assert.equal(readFileSync(join(f.repo, "shared.txt"), "utf8"), "resolved A+B\n");
  } finally { await f.close(); }
});

test("自动 A6：运行版重叠的未提交、未跟踪/忽略文件阻止发布且保留", async (t) => {
  for (const kind of ["tracked", "untracked", "ignored"]) await t.test(kind, async () => {
    const f = fixture(1);
    try {
      autoConfig(f); const path = kind === "tracked" ? "shared.txt" : "src/a.txt"; f.write(0, path, "candidate\n");
      mkdirSync(dirname(join(f.repo, path)), { recursive: true }); writeFileSync(join(f.repo, path), "runtime dirty\n");
      if (kind === "ignored") {
        // info/exclude 在 worktree 间共用；先提交候选，避免同时把开发侧的未跟踪候选也忽略掉。
        f.git(f.batches[0].cwd, "add", "src/a.txt"); f.git(f.batches[0].cwd, "commit", "-qm", "feat: tracked candidate");
        writeFileSync(join(f.repo, ".git", "info", "exclude"), "src/a.txt\n");
      }
      const base = f.git(f.repo, "rev-parse", "HEAD"); autoComplete(f, 0); await f.ready(0);
      assert.equal(f.git(f.repo, "rev-parse", "HEAD"), base); assert.equal(readFileSync(join(f.repo, path), "utf8"), "runtime dirty\n");
      const denied = f.cli("合入", f.batches[0].file); assert.equal(denied.ok, false); assert.match(denied.error, /未提交改动[\s\S]*同一个文件/);
    } finally { await f.close(); }
  });
});

test("自动：测试中 release 过期，重测通过后直接合入新基线的结果", async () => {
  const f = fixture(1);
  try {
    autoConfig(f); f.write(0, "src/a.txt", "a\n"); f.mode("hold"); autoComplete(f, 0); await f.until(() => existsSync(f.events));
    writeFileSync(join(f.repo, "unrelated.txt"), "new release\n"); f.git(f.repo, "add", "unrelated.txt"); f.git(f.repo, "commit", "-qm", "feat: release advanced");
    const base = f.git(f.repo, "rev-parse", "HEAD"); writeFileSync(join(f.root, "release"), "go");
    const merged = await automaticMerged(f, 0); assert.ok(merged.attempt >= 2); assert.equal(merged.base, base); assert.equal(f.git(f.repo, "rev-parse", "HEAD"), merged.result);
  } finally { await f.close(); }
});
