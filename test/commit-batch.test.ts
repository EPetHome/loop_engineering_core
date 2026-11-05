import "./test-env.ts";
import "./helpers/git-runtime.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkedTree, commitBatch, workingTree, type BatchCommit } from "../commit-batch.ts";
import { createGitEvidence } from "../git.ts";
import { childExec } from "../hosts/review-hook.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "loop-commit-batch-")), repo = join(root, "repo"); mkdirSync(repo);
  const git = (cwd: string, ...args: string[]) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  };
  git(repo, "init", "-qb", "release"); git(repo, "config", "user.email", "batch@example.com"); git(repo, "config", "user.name", "batch");
  writeFileSync(join(repo, ".autoreview.json"), JSON.stringify({ localFiles: ["local"] }));
  mkdirSync(join(repo, "local")); writeFileSync(join(repo, "local", "secret"), "base local\n");
  writeFileSync(join(repo, "code.txt"), "base\n"); git(repo, "add", "."); git(repo, "commit", "-qm", "base");
  const base = git(repo, "rev-parse", "HEAD");
  return { root, repo, base, git, close: () => rmSync(root, { recursive: true, force: true }) };
}

test("批次提交：冻结快照含未跟踪文件/链接，localFiles 与 commitAll 同口径排除", async () => {
  const f = fixture();
  try {
    f.git(f.repo, "switch", "-c", "feat/one");
    writeFileSync(join(f.repo, "docs.md"), "批次文档\n"); f.git(f.repo, "add", "docs.md"); f.git(f.repo, "commit", "-qm", "chore: 批次文档");
    writeFileSync(join(f.repo, "local", "secret"), "private change\n"); writeFileSync(join(f.repo, "new.txt"), "checked\n");
    symlinkSync("new.txt", join(f.repo, "link"));
    const snapshot = await createGitEvidence(childExec, f.repo).snapshot();
    const expected = checkedTree(f.repo, snapshot, f.root);
    let saved: BatchCommit[] = [];
    const records = commitBatch({ id: "one", name: "新批次", release: "release", scratch: f.root, candidates: [
      { cwd: f.repo, branch: "feat/one", candidate: snapshot, conclusions: ["段：甲；门禁：通过；评审：通过；验收：未配置"] },
    ], save: (value) => { saved = value; } });
    assert.deepEqual(records, saved); assert.equal(f.git(f.repo, "rev-list", "--count", `${f.base}..HEAD`), "1");
    assert.equal(f.git(f.repo, "rev-parse", "HEAD^{tree}"), expected);
    assert.equal(f.git(f.repo, "show", "HEAD:local/secret"), "base local");
    assert.equal(readFileSync(join(f.repo, "local", "secret"), "utf8"), "private change\n");
    assert.match(f.git(f.repo, "status", "--porcelain"), /local\/secret/); assert.equal(f.git(f.repo, "diff", "--cached"), "");
    assert.match(f.git(f.repo, "ls-tree", "HEAD", "link"), /^120000 blob/);
  } finally { f.close(); }
});

test("批次提交：多个分支分别压缩，每个分支一个提交，历史引用不覆盖", () => {
  const f = fixture();
  try {
    const a = join(f.root, "a"), b = join(f.root, "b");
    f.git(f.repo, "worktree", "add", "-b", "feat/a", a, "release"); f.git(f.repo, "worktree", "add", "-b", "fix/b", b, "release");
    for (const cwd of [a, b]) {
      writeFileSync(join(cwd, "docs.md"), "docs\n"); f.git(cwd, "add", "."); f.git(cwd, "commit", "-qm", "chore: 文档");
      writeFileSync(join(cwd, "new.txt"), `${cwd}\n`);
    }
    const records = commitBatch({ id: "multi", name: "多分支批次", release: "release", scratch: f.root,
      candidates: [a, b].map((cwd, index) => ({ cwd, branch: index ? "fix/b" : "feat/a", candidate: workingTree(cwd, f.root).tree, conclusions: [`段：${index}`] })), save: () => {} });
    assert.equal(records.length, 2); assert.notEqual(records[0].preSquash[0], records[1].preSquash[0]);
    for (const item of records) {
      assert.equal(f.git(item.cwd, "rev-list", "--count", `${f.base}..HEAD`), "1");
      assert.equal(f.git(item.cwd, "rev-parse", "HEAD^{tree}"), item.tree);
      assert.equal(f.git(item.cwd, "status", "--porcelain"), "");
    }
    assert.equal(f.git(a, "log", "-1", "--format=%s"), "feat: 多分支批次");
    assert.equal(f.git(b, "log", "-1", "--format=%s"), "fix: 多分支批次");
  } finally { f.close(); }
});
