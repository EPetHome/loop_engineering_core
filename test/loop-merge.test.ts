/** 旧合入与 stash 路径停用，不触碰并发用户资料；统一新发布的候选保护见 kernel/提交节点。 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { legacyFixture } from "./helpers/pipeline-fixture.ts";
test("旧合入在冲突/脏目录/暂存/忽略挡路/未完成合并时统一拒绝，不 stash/reset/commit", () => {
  const f = legacyFixture(); try { f.git(f.repo, "push", "-q", "origin", "dev"); writeFileSync(join(f.repo, "file.txt"), "staged original"); f.git(f.repo, "add", "file.txt"); writeFileSync(join(f.repo, "file.txt"), "unstaged original"); writeFileSync(join(f.repo, "local.txt"), "ignored original"); writeFileSync(join(f.repo, "untracked.txt"), "untracked original"); const gitDir = f.git(f.repo, "rev-parse", "--absolute-git-dir"), head = f.git(f.repo, "rev-parse", "HEAD"); writeFileSync(join(gitDir, "MERGE_HEAD"), head + "\n"); for (const dry of [[], ["--dry-run"]]) { f.refuse("合入", dry); assert.equal(readFileSync(join(gitDir, "MERGE_HEAD"), "utf8"), head + "\n"); } assert.equal(f.git(f.repo, "stash", "list"), ""); assert.equal(readFileSync(join(f.repo, "file.txt"), "utf8"), "unstaged original"); } finally { f.cleanup(); }
});
test("已有用户 stash 与其他 worktree 的 stash 引用不被旧拒绝入口枚举、归还或删除", () => {
  const f = legacyFixture(); try { writeFileSync(join(f.repo, "file.txt"), "stashed user"); f.git(f.repo, "stash", "push", "-m", "user stash"); const stash = f.git(f.repo, "rev-parse", "refs/stash"), before = f.git(f.repo, "stash", "list"); f.refuse("合入"); assert.equal(f.git(f.repo, "rev-parse", "refs/stash"), stash); assert.equal(f.git(f.repo, "stash", "list"), before); } finally { f.cleanup(); }
});
