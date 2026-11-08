/** 旧开工文档搬运停用；拒绝必须保护两边原始字节、暂存/忽略文件、路径与链接。 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createKernelRun } from "../kernel.ts";
import { readRun } from "../node-ledger.ts";
import { legacyFixture } from "./helpers/pipeline-fixture.ts";
test("旧开工不再提交/搬运/恢复文档：原用户暂存、未暂存、忽略同名文件全部保留", () => {
  const f = legacyFixture();
  try {
    writeFileSync(join(f.repo, "file.txt"), "用户暂存"); f.git(f.repo, "add", "file.txt"); writeFileSync(join(f.repo, "file.txt"), "暂存后继续修改"); writeFileSync(join(f.repo, "local.txt"), "用户本机输入"); writeFileSync(join(f.repo, "prompt.md"), "未提交的任务文件");
    mkdirSync(join(f.root, "existing")); writeFileSync(join(f.root, "existing", "prompt.md"), "忽略同名原文件");
    f.raw.stages.甲.cwd = join(f.root, "existing"); f.save(); f.refuse("开工"); f.refuse("开工", ["--dry-run"]);
    assert.equal(readFileSync(join(f.root, "existing", "prompt.md"), "utf8"), "忽略同名原文件");
  } finally { f.cleanup(); }
});
test("链接提示词、父路径和非同级绝对/相对引用：旧入口拒绝，不写穿外部目标", () => {
  const f = legacyFixture();
  try { const outside = join(f.root, "outside.md"); writeFileSync(outside, "outside original\r\n"); symlinkSync(outside, join(f.repo, "link.md")); f.raw.stages.甲.prompt = "link.md"; f.save(); f.refuse("开工"); f.refuse("启动"); assert.equal(readFileSync(outside, "utf8"), "outside original\r\n"); } finally { f.cleanup(); }
});
test("新卡装配冻结已提交提示词；原用户未提交资料不被搬入或恢复", () => {
  const f = legacyFixture();
  try { const original = readFileSync(join(f.repo, "prompt.md")); writeFileSync(join(f.repo, "prompt.md"), "用户新原文"); const run = readRun(createKernelRun(f.file, f.repo).path); assert.deepEqual(readFileSync(join(run.worktree, "prompt.md")), original); assert.equal(readFileSync(join(f.repo, "prompt.md"), "utf8"), "用户新原文"); } finally { f.cleanup(); }
});
