/** loop／merge：按功能独立运行，夹具与状态不跨测试进程共享。 */
/** bin/loop 的开工、启动、状态、合入；测试仓库、worktree 和 methods.json 都建在系统临时目录。 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { git, fixture, loop, jsonOf } from "./helpers/loop-fixture.ts";

test("A7 合入没有冲突时本地合并、不推送；有冲突时中止并恢复原状", async (t) => {
  await t.test("没有冲突：发布分支多一个合并结果，远端没变", () => {
    const f = fixture();
    const remote = join(f.root, "remote.git"); git(f.root, ["init", "--bare", "-q", remote]);
    git(f.repo, ["remote", "add", "origin", remote]);
    git(f.repo, ["push", "-q", "origin", "main"]);
    writeFileSync(join(f.repo, "README.md"), "user stash\n");
    git(f.repo, ["stash", "push", "--quiet", "-m", "user stash"]);
    const userStash = git(f.repo, ["rev-parse", "refs/stash"]);
    const branch = join(f.root, "merge-wt");
    git(f.repo, ["worktree", "add", "-b", "feat/合并", branch, "main"]);
    writeFileSync(join(branch, "merged.txt"), "merged\n");
    git(branch, ["add", "merged.txt"]); git(branch, ["commit", "-qm", "feat: 合并"]);
    writeFileSync(join(branch, "pending.txt"), "pending\n");
    writeFileSync(join(f.repo, "README.md"), "dirty release\n");
    writeFileSync(join(f.repo, "prompt.md"), "staged prompt\n");
    git(f.repo, ["add", "prompt.md"]);
    writeFileSync(join(f.repo, "prompt.md"), "worktree prompt\n");
    writeFileSync(join(f.repo, "未提交.txt"), "keep\n");
    const batch = join(f.root, "merge.json");
    writeFileSync(batch, JSON.stringify({ name: "合并批次", branch: "feat/合并", stages: { 甲: { cwd: branch, start: "true" } }, steps: [["甲"]] }));
    const merged = loop(f.repo, ["合入", batch, "--json"]);
    assert.equal(merged.status, 0, merged.stderr);
    const result = jsonOf(merged);
    assert.equal(result.pushed, false);
    assert.deepEqual(result.uncommitted, ["README.md", "prompt.md", "未提交.txt"].sort(), "无关改动保留并列出");
    assert.equal(readFileSync(join(f.repo, "README.md"), "utf8"), "dirty release\n");
    assert.equal(readFileSync(join(f.repo, "未提交.txt"), "utf8"), "keep\n");
    assert.equal(readFileSync(join(f.repo, "prompt.md"), "utf8"), "worktree prompt\n", "未暂存的修改恢复");
    assert.equal(git(f.repo, ["show", ":prompt.md"]), "staged prompt", "暂存内容恢复");
    assert.match(git(f.repo, ["diff", "--cached", "--name-only"]), /prompt\.md/);
    assert.match(git(f.repo, ["diff", "--name-only"]), /prompt\.md/);
    assert.doesNotMatch(git(f.repo, ["show", "--name-only", "--format=", "HEAD"]), /prompt\.md/, "暂存改动没有进入合并提交");
    assert.equal(readFileSync(join(f.repo, "pending.txt"), "utf8"), "pending\n", "合入前先提交批次分支上的未提交改动");
    assert.equal(git(f.repo, ["log", "--merges", "--format=%s", "-1"]), "feat: 合并");
    assert.equal(git(f.repo, ["rev-parse", "origin/main"]), git(f.repo, ["rev-parse", "main^1"]), "没有推送");
    assert.equal(git(f.repo, ["rev-parse", "refs/stash"]), userStash, "用户原有的 stash 还在栈顶");
    assert.match(git(f.repo, ["stash", "list", "--format=%s"]), /user stash/);
    assert.equal(git(f.repo, ["for-each-ref", "--format=%(refname)", "refs/loop/merge-stash"]), "", "本次临时引用已清理");
  });
  await t.test("有冲突：中止合并，运行版恢复原状，列出冲突文件", () => {
    const f = fixture();
    const branch = join(f.root, "conflict-wt");
    git(f.repo, ["worktree", "add", "-b", "feat/冲突", branch, "main"]);
    writeFileSync(join(branch, "README.md"), "branch\n");
    git(branch, ["add", "README.md"]); git(branch, ["commit", "-qm", "feat: 冲突"]);
    writeFileSync(join(f.repo, "README.md"), "release\n");
    git(f.repo, ["add", "README.md"]); git(f.repo, ["commit", "-qm", "release change"]);
    const before = git(f.repo, ["rev-parse", "HEAD"]);
    const batch = join(f.root, "conflict.json");
    writeFileSync(batch, JSON.stringify({ name: "冲突批次", branch: "feat/冲突", stages: { 甲: { cwd: branch, start: "true" } }, steps: [["甲"]] }));
    const merged = loop(f.repo, ["合入", batch, "--json"]);
    assert.notEqual(merged.status, 0);
    const result = jsonOf(merged);
    assert.deepEqual(result.conflicts, ["README.md"]);
    assert.equal(git(f.repo, ["rev-parse", "HEAD"]), before);
    assert.equal(git(f.repo, ["status", "--porcelain"]), "");
  });
  await t.test("未提交文件和批次分支改动重叠：合入前停下，发布分支和项目根都不动", () => {
    const f = fixture();
    const branch = join(f.root, "overlap-wt");
    git(f.repo, ["worktree", "add", "-b", "feat/重叠", branch, "main"]);
    writeFileSync(join(branch, "README.md"), "branch change\n");
    git(branch, ["add", "README.md"]); git(branch, ["commit", "-qm", "feat: 重叠"]);
    writeFileSync(join(f.repo, "README.md"), "runtime dirty\n");
    const before = git(f.repo, ["rev-parse", "HEAD"]);
    const batch = join(f.root, "overlap.json");
    writeFileSync(batch, JSON.stringify({ name: "重叠批次", branch: "feat/重叠", stages: { 甲: { cwd: branch, start: "true" } }, steps: [["甲"]] }));
    const merged = loop(f.repo, ["合入", batch, "--json"]);
    assert.notEqual(merged.status, 0);
    const result = jsonOf(merged);
    assert.deepEqual(result.files, ["README.md"]);
    assert.equal(git(f.repo, ["rev-parse", "HEAD"]), before);
    assert.equal(readFileSync(join(f.repo, "README.md"), "utf8"), "runtime dirty\n");
    assert.match(git(f.repo, ["status", "--porcelain"]), /README\.md/);
  });
  await t.test("第二个分支冲突：两个合并都退回，无关的已跟踪和未跟踪改动保留", () => {
    const f = fixture();
    const first = join(f.root, "merge-first"), second = join(f.root, "merge-second");
    git(f.repo, ["worktree", "add", "-b", "feat/一", first, "main"]);
    writeFileSync(join(first, "one.txt"), "one\n");
    git(first, ["add", "one.txt"]); git(first, ["commit", "-qm", "feat: 一"]);
    git(f.repo, ["worktree", "add", "-b", "feat/二", second, "main"]);
    writeFileSync(join(second, "README.md"), "second branch\n");
    git(second, ["add", "README.md"]); git(second, ["commit", "-qm", "feat: 二"]);
    writeFileSync(join(f.repo, "README.md"), "release newer\n");
    git(f.repo, ["add", "README.md"]); git(f.repo, ["commit", "-qm", "release: 冲突来源"]);
    writeFileSync(join(f.repo, "prompt.md"), "staged prompt\n");
    git(f.repo, ["add", "prompt.md"]);
    writeFileSync(join(f.repo, "prompt.md"), "dirty prompt\n");
    writeFileSync(join(f.repo, "保留.txt"), "keep\n");
    const before = git(f.repo, ["rev-parse", "HEAD"]);
    const batch = join(f.root, "two-merges.json");
    writeFileSync(batch, JSON.stringify({ name: "两个合并", stages: {
      甲: { cwd: first, branch: "feat/一", start: "true" },
      乙: { cwd: second, branch: "feat/二", start: "true" },
    }, steps: [["甲"], ["乙"]] }));
    const merged = loop(f.repo, ["合入", batch, "--json"]);
    assert.notEqual(merged.status, 0);
    const result = jsonOf(merged);
    assert.deepEqual(result.conflicts, ["README.md"]);
    assert.equal(git(f.repo, ["rev-parse", "HEAD"]), before, "两个合并都退回合入前 HEAD");
    assert.equal(readFileSync(join(f.repo, "prompt.md"), "utf8"), "dirty prompt\n", "无关的已跟踪改动保留");
    assert.equal(git(f.repo, ["show", ":prompt.md"]), "staged prompt", "暂存内容在回退后仍保留");
    assert.match(git(f.repo, ["diff", "--cached", "--name-only"]), /prompt\.md/);
    assert.match(git(f.repo, ["diff", "--name-only"]), /prompt\.md/);
    assert.equal(readFileSync(join(f.repo, "保留.txt"), "utf8"), "keep\n", "无关的未跟踪文件保留");
    assert.equal(git(f.repo, ["log", "--merges", "--format=%s"]).includes("feat: 一"), false);
  });
});

test("合入期间 stash 栈变化时只保留本次记录，不按位置删别人的 stash", () => {
  const f = fixture();
  const branch = join(f.root, "hook-merge");
  git(f.repo, ["worktree", "add", "-b", "feat/钩子合入", branch, "main"]);
  writeFileSync(join(branch, "merged.txt"), "merged\n");
  git(branch, ["add", "merged.txt"]); git(branch, ["commit", "-qm", "feat: 钩子合入"]);
  const other = join(f.root, "hook-other");
  git(f.repo, ["worktree", "add", "-b", "feat/钩子其它", other, "main"]);
  writeFileSync(join(other, "README.md"), "other dirty\n");
  const hooks = join(f.repo, ".git", "hooks");
  mkdirSync(hooks, { recursive: true });
  const hook = join(hooks, "post-merge");
  const quoted = other.replace(/'/g, "'\\''");
  writeFileSync(hook, `#!/bin/sh\ngit -C '${quoted}' stash push --quiet -m 'other worktree stash' >/dev/null 2>&1 || true\n`);
  chmodSync(hook, 0o755);
  writeFileSync(join(f.repo, "prompt.md"), "main dirty\n");
  const batch = join(f.root, "hook-merge.json");
  writeFileSync(batch, JSON.stringify({ name: "钩子合入", branch: "feat/钩子合入", stages: { 甲: { cwd: branch, start: "true" } }, steps: [["甲"]] }));
  const merged = loop(f.repo, ["合入", batch, "--json"]);
  assert.equal(merged.status, 0, `${merged.stdout}\n${merged.stderr}`);
  assert.equal(readFileSync(join(f.repo, "prompt.md"), "utf8"), "main dirty\n", "本次 stash 已恢复");
  const list = git(f.repo, ["stash", "list", "--format=%s"]);
  assert.match(list, /other worktree stash/, "合入期间新增的 stash 没有被删除");
  assert.doesNotMatch(list, /loop 合入：临时保存运行版未提交改动/, "本次改动不写共享 stash 栈");
  assert.equal(git(f.repo, ["for-each-ref", "--format=%(refname)", "refs/loop/merge-stash"]), "", "本次独立引用已清理");
});

test("保存 stash 时其他 worktree 同时新增 stash，也不认错或删除", () => {
  const f = fixture();
  const branch = join(f.root, "race-merge");
  git(f.repo, ["worktree", "add", "-b", "feat/并发合入", branch, "main"]);
  writeFileSync(join(branch, "merged.txt"), "merged\n");
  git(branch, ["add", "merged.txt"]); git(branch, ["commit", "-qm", "feat: 并发合入"]);
  const other = join(f.root, "race-other");
  git(f.repo, ["worktree", "add", "-b", "feat/并发其它", other, "main"]);
  writeFileSync(join(other, "README.md"), "other dirty\n");
  const hooks = join(f.repo, ".git", "hooks");
  mkdirSync(hooks, { recursive: true });
  const hook = join(hooks, "reference-transaction");
  const state = join(f.root, "race-hook-done");
  const quote = (value: string): string => value.replace(/'/g, "'\\''");
  writeFileSync(hook, `#!/bin/sh\n[ "$1" = "prepared" ] || exit 0\nwhile IFS=' ' read -r old new ref; do\n  case "$ref" in\n    refs/loop/merge-stash/*)\n      if [ ! -f '${quote(state)}' ]; then\n        : > '${quote(state)}'\n        git -C '${quote(other)}' stash push --quiet -m 'concurrent stash' >/dev/null 2>&1 || true\n      fi\n      ;;\n  esac\ndone\n`);
  chmodSync(hook, 0o755);
  writeFileSync(join(f.repo, "prompt.md"), "main dirty\n");
  const batch = join(f.root, "race-merge.json");
  writeFileSync(batch, JSON.stringify({ name: "并发合入", branch: "feat/并发合入", stages: { 甲: { cwd: branch, start: "true" } }, steps: [["甲"]] }));
  const merged = loop(f.repo, ["合入", batch, "--json"]);
  assert.equal(merged.status, 0, `${merged.stdout}\n${merged.stderr}`);
  assert.equal(readFileSync(join(f.repo, "prompt.md"), "utf8"), "main dirty\n", "本次改动已恢复");
  assert.match(git(f.repo, ["stash", "list", "--format=%s"]), /concurrent stash/, "并发新增的 stash 保留");
  assert.equal(git(f.repo, ["for-each-ref", "--format=%(refname)", "refs/loop/merge-stash"]), "", "本次独立引用已清理");
});

test("批次工作区未提交改动和项目根重叠时，合入前停下且不自动提交", () => {
  const f = fixture();
  const branch = join(f.root, "both-dirty");
  git(f.repo, ["worktree", "add", "-b", "feat/双方改动", branch, "main"]);
  const branchHead = git(branch, ["rev-parse", "HEAD"]);
  writeFileSync(join(branch, "README.md"), "workspace dirty\n");
  writeFileSync(join(f.repo, "README.md"), "runtime dirty\n");
  const mainHead = git(f.repo, ["rev-parse", "HEAD"]);
  const batch = join(f.root, "both-dirty.json");
  writeFileSync(batch, JSON.stringify({ name: "双方改动", branch: "feat/双方改动", stages: { 甲: { cwd: branch, start: "true" } }, steps: [["甲"]] }));
  const merged = loop(f.repo, ["合入", batch, "--json"]);
  assert.notEqual(merged.status, 0);
  const result = jsonOf(merged);
  assert.deepEqual(result.files, ["README.md"]);
  assert.equal(git(f.repo, ["rev-parse", "HEAD"]), mainHead);
  assert.equal(git(branch, ["rev-parse", "HEAD"]), branchHead, "批次工作区没有自动提交");
  assert.equal(readFileSync(join(f.repo, "README.md"), "utf8"), "runtime dirty\n");
  assert.equal(readFileSync(join(branch, "README.md"), "utf8"), "workspace dirty\n");
  assert.match(git(branch, ["status", "--porcelain"]), /README\.md/);
});

test("清理 stash 前发现未跟踪文件挡住 HEAD 路径时，不覆盖它", () => {
  const f = fixture();
  mkdirSync(join(f.repo, "dir"));
  writeFileSync(join(f.repo, "dir", "a.txt"), "tracked\n");
  git(f.repo, ["add", "dir/a.txt"]); git(f.repo, ["commit", "-qm", "tracked dir"]);
  const branch = join(f.root, "block-merge");
  git(f.repo, ["worktree", "add", "-b", "feat/阻挡", branch, "main"]);
  writeFileSync(join(branch, "merged.txt"), "merged\n");
  git(branch, ["add", "merged.txt"]); git(branch, ["commit", "-qm", "feat: 阻挡"]);
  rmSync(join(f.repo, "dir", "a.txt"));
  rmSync(join(f.repo, "dir"), { recursive: true });
  writeFileSync(join(f.repo, "dir"), "untracked blocker\n");
  git(f.repo, ["add", "-A", "--", "dir/a.txt"]);
  const before = git(f.repo, ["rev-parse", "HEAD"]);
  const batch = join(f.root, "block-merge.json");
  writeFileSync(batch, JSON.stringify({ name: "阻挡", branch: "feat/阻挡", stages: { 甲: { cwd: branch, start: "true" } }, steps: [["甲"]] }));
  const merged = loop(f.repo, ["合入", batch, "--json"]);
  assert.notEqual(merged.status, 0);
  const result = jsonOf(merged);
  assert.deepEqual(result.files, ["dir"]);
  assert.match(String(result.error), /未跟踪文件挡在 HEAD 路径上/);
  assert.equal(git(f.repo, ["rev-parse", "HEAD"]), before);
  assert.equal(readFileSync(join(f.repo, "dir"), "utf8"), "untracked blocker\n", "未跟踪文件内容保留");
  assert.match(git(f.repo, ["status", "--porcelain"]), /D  dir\/a\.txt/);
  assert.match(git(f.repo, ["status", "--porcelain"]), /\?\? dir/);
  assert.equal(git(f.repo, ["for-each-ref", "--format=%(refname)", "refs/loop/merge-stash"]), "", "没有创建临时引用");
  assert.equal(git(f.repo, ["stash", "list"]), "", "没有动共享 stash");
});

test("未跟踪文件扫描失败时不合入，项目根和索引不变", () => {
  const realGit = String(spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8", env: process.env }).stdout).trim();
  assert.ok(realGit, "找不到真实 git");
  const cases: Array<[string, string]> = [["空白", ""], ["部分", "partial"]];
  for (const [label, output] of cases) {
    const f = fixture();
    const branch = join(f.root, `scan-${label}`);
    git(f.repo, ["worktree", "add", "-b", `feat/扫描-${label}`, branch, "main"]);
    writeFileSync(join(branch, "merged.txt"), "merged\n");
    git(branch, ["add", "merged.txt"]); git(branch, ["commit", "-qm", `feat: 扫描-${label}`]);
    writeFileSync(join(f.repo, "README.md"), "runtime staged\n");
    git(f.repo, ["add", "README.md"]);
    const beforeHead = git(f.repo, ["rev-parse", "HEAD"]);
    const beforeStatus = git(f.repo, ["status", "--porcelain"]);
    const beforeIndex = git(f.repo, ["show", ":README.md"]);
    const fake = join(f.root, "fake-git");
    mkdirSync(fake, { recursive: true });
    const wrapper = join(fake, "git");
    const quote = (value: string): string => value.replace(/'/g, "'\\''");
    writeFileSync(wrapper, `#!/bin/sh\ncase " $* " in\n  *" ls-files --others -z "*) ${output ? `printf '${output}'` : ":"}; exit 1 ;;\nesac\nexec '${quote(realGit)}' "$@"\n`);
    chmodSync(wrapper, 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = `${fake}:${originalPath ?? ""}`;
    let merged: { status: number; stdout: string; stderr: string };
    try {
      const batch = join(f.root, `scan-${label}.json`);
      writeFileSync(batch, JSON.stringify({ name: `扫描-${label}`, branch: `feat/扫描-${label}`, stages: { 甲: { cwd: branch, start: "true" } }, steps: [["甲"]] }));
      merged = loop(f.repo, ["合入", batch, "--json"]);
    } finally {
      process.env.PATH = originalPath;
    }
    assert.notEqual(merged.status, 0);
    assert.match(String(jsonOf(merged).error), /无法完整扫描运行版未跟踪文件/, label);
    assert.equal(git(f.repo, ["rev-parse", "HEAD"]), beforeHead, label);
    assert.equal(git(f.repo, ["status", "--porcelain"]), beforeStatus, label);
    assert.equal(git(f.repo, ["show", ":README.md"]), beforeIndex, label);
    assert.equal(git(f.repo, ["for-each-ref", "--format=%(refname)", "refs/loop/merge-stash"]), "", label);
    assert.doesNotMatch(git(f.repo, ["log", "--merges", "--format=%s"]), new RegExp(`feat: 扫描-${label}`), label);
  }
});

test("合入前发现运行版已有未完成的合并就停下，不中止用户的合并", () => {
  const f = fixture();
  const conflict = join(f.root, "user-merge");
  git(f.repo, ["worktree", "add", "-b", "feat/用户合并", conflict, "main"]);
  writeFileSync(join(conflict, "README.md"), "user branch\n");
  git(conflict, ["add", "README.md"]); git(conflict, ["commit", "-qm", "feat: 用户合并"]);
  const other = join(f.root, "user-other");
  git(f.repo, ["worktree", "add", "-b", "feat/无关", other, "main"]);
  writeFileSync(join(other, "other.txt"), "other\n");
  git(other, ["add", "other.txt"]); git(other, ["commit", "-qm", "feat: 无关"]);
  writeFileSync(join(f.repo, "README.md"), "main version\n");
  git(f.repo, ["add", "README.md"]); git(f.repo, ["commit", "-qm", "release change"]);
  const merge = spawnSync("git", ["-c", "core.quotePath=false", "merge", "--no-ff", "feat/用户合并"], {
    cwd: f.repo, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  });
  assert.notEqual(merge.status, 0);
  writeFileSync(join(f.repo, "README.md"), "resolved by user\n");
  git(f.repo, ["add", "README.md"]);
  const before = git(f.repo, ["rev-parse", "HEAD"]);
  const batch = join(f.root, "existing-merge.json");
  writeFileSync(batch, JSON.stringify({ name: "已有合并", branch: "feat/无关", stages: { 甲: { cwd: other, start: "true" } }, steps: [["甲"]] }));
  const merged = loop(f.repo, ["合入", batch, "--json"]);
  assert.notEqual(merged.status, 0);
  const result = jsonOf(merged);
  assert.equal(result.mergeInProgress, true);
  assert.match(String(result.error), /已有未完成的合并/);
  assert.equal(git(f.repo, ["rev-parse", "HEAD"]), before);
  assert.ok(git(f.repo, ["rev-parse", "--verify", "MERGE_HEAD"]), "用户的 MERGE_HEAD 还在");
  assert.equal(readFileSync(join(f.repo, "README.md"), "utf8"), "resolved by user\n", "手工解决的内容保留");
  assert.equal(git(f.repo, ["show", ":README.md"]), "resolved by user", "手工解决的内容仍在暂存区");
  assert.match(git(f.repo, ["status", "--porcelain"]), /M  README\.md/);
});
