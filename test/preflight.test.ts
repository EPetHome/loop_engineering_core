/** 旧开工空跑已删除；新卡只读前检与 localFiles/guide 路径保护仍在资源前执行。 */
import assert from "node:assert/strict";
import { readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createKernelRun } from "../kernel.ts";
import { runMethodsSelfTest } from "../methods.ts";
import { launchKernel } from "../kernel-runtime.ts";
import { readRun } from "../node-ledger.ts";
import { fileURLToPath } from "node:url";
import { legacyFixture } from "./helpers/pipeline-fixture.ts";
test("旧开工不调用空跑评审、reset、cleanup 或项目方法，即使有验收配置", () => {
  const f = legacyFixture();
  try { f.raw.prepare = `touch '${f.executed}'`; f.raw.acceptance.reset = f.raw.prepare; f.raw.acceptance.cleanup = f.raw.prepare; f.save(); f.refuse("开工"); f.refuse("开工", ["--recheck"]); } finally { f.cleanup(); }
});
test("新入口 localFiles 绝对/越界/链接在资源前拒绝，不借其他项目配置", () => {
  const f = legacyFixture();
  try { const marker = join(f.repo, ".autoreview.json"), initial = JSON.parse(readFileSync(marker, "utf8")); const outside = join(f.root, "input.txt"); writeFileSync(outside, "protect"); symlinkSync(outside, join(f.repo, "link.txt"));
    for (const config of [{ ...initial, localFiles: ["../input.txt"] }, { ...initial, localFiles: [outside] }, { ...initial, localFiles: ["link.txt"] }]) { writeFileSync(marker, JSON.stringify(config)); const before = f.snapshot(); assert.throws(() => createKernelRun(f.file, f.repo)); assert.deepEqual(f.snapshot(), before); }
    assert.equal(readFileSync(outside, "utf8"), "protect");
  } finally { f.cleanup(); }
});
test("方法自测脱离旧开工仍可用：按指纹跳过/变化重验，真实消费者和缓存资源释放", async () => {
  const f = legacyFixture();
  try {
    const marker = join(f.repo, ".autoreview.json"), log = join(f.root, "self.log"), raw = JSON.parse(readFileSync(marker, "utf8"));
    raw.methods = { paths: ["prompt.md"], selfCheck: `printf x >> '${log}'` }; writeFileSync(marker, JSON.stringify(raw));
    const path = f.start(), run = readRun(path), options = { loopRoot: fileURLToPath(new URL("..", import.meta.url)), procsFile: join(run.dir, "methods.procs.json") };
    assert.equal((await runMethodsSelfTest(run.worktree, options)).skipped, false); assert.equal((await runMethodsSelfTest(run.worktree, options)).skipped, true);
    writeFileSync(join(run.worktree, "prompt.md"), "method input changed"); assert.equal((await runMethodsSelfTest(run.worktree, options)).skipped, false); assert.equal(readFileSync(log, "utf8"), "xx");
  } finally { f.cleanup(); }
});
test("新卡实际启动的方法自测失败在模型前停下，不绕过占位符/方法失败", async () => {
  const f = legacyFixture();
  try {
    const marker = join(f.repo, ".autoreview.json"), raw = JSON.parse(readFileSync(marker, "utf8")); raw.methods = { paths: ["prompt.md"], selfCheck: "echo 'AUTOREVIEW_FAILURE=method 未替换的占位符 <项目>' >&2; exit 78" }; writeFileSync(marker, JSON.stringify(raw));
    const path = f.start(); await launchKernel(path); const run = readRun(path); assert.equal(run.stopped, true); assert.match(run.stopReason!, /方法自测未通过.*AUTOREVIEW_FAILURE=method/s); assert.equal(run.session, undefined); assert.equal(run.repairs, 0);
  } finally { f.cleanup(); }
});
