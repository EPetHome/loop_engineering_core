/** P1/P3/P5/P8 旧编排成功断言改为无副作用迁移；并行/回流由 kernel-batch 的实际入口覆盖。 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";
import * as pipeline from "../pipeline.ts";
import { createKernelRun } from "../kernel.ts";
import { beginBatchRun, runBatchCommand } from "../launch.ts";
import { legacyFixture } from "./helpers/pipeline-fixture.ts";
test("P1/P2 旧卡所有形态，包括损坏字段与可执行 start，在资源前统一拒绝", () => {
  const f = legacyFixture();
  try {
    for (const raw of [f.raw, { ...f.raw, steps: ["未知", "甲", "甲"] }, { workflow: "without-acceptance" }, { stages: {} }, { steps: [] }, { ...f.raw, e2e: f.raw.acceptance }, { ...f.raw, acceptance: undefined }]) { writeFileSync(f.oldFile, JSON.stringify(raw)); for (const dry of [[], ["--dry-run"]]) f.refuse("启动", dry); }
  } finally { f.cleanup(); }
});
test("P3/P5/P8 不再有同仓库串行调度器或内部绕过；旧后台/验收续跑只诊断", async () => {
  const f = legacyFixture();
  try {
    for (const key of ["parsePlan", "runPipeline", "dispatchBatches", "stageScript", "launchTerminal", "launchBackground"]) assert.equal(Object.hasOwn(pipeline, key), false, key);
    f.raw.stages.乙 = { cwd: f.repo, start: `touch '${f.executed}'` }; f.save();
    f.refuse("启动", ["--launcher", "background"], true);
    f.refuse("续跑", ["--id", "old-pa-request"]);
    const info = { project: f.repo, batch: { file: f.oldFile, name: "legacy", recipe: "develop" }, dir: f.raw.dir, stages: [{ stage: "甲", cwd: f.repo }] }, untouched = f.snapshot();
    assert.throws(() => beginBatchRun(info), /已停用/);
    for (const recipe of ["develop", "review-only"]) await assert.rejects(runBatchCommand({ ...info, batch: { ...info.batch, recipe } }, "甲", "/bin/sh", ["-c", `touch '${f.executed}'`], { cwd: f.repo, capture: true }), /已停用/);
    assert.deepEqual(f.snapshot(), untouched, "内部段启动也不能创建锁、目录或模型进程");
    for (const from of ["验收", "e2e"]) f.pipeline("--from", from, "--launcher", "background");
    const before = f.snapshot(), launch = spawnSync(process.execPath, [fileURLToPath(new URL("../launch.ts", import.meta.url)), "--payload", f.oldFile, "old-token"], { cwd: f.repo, env: process.env, encoding: "utf8" });
    assert.equal(launch.status, 2); assert.match(launch.stderr, /旧段启动脚本已停用/); assert.deepEqual(f.snapshot(), before);
  } finally { f.cleanup(); }
});
test("P2/P12 新卡非法提示词/范围/标准/limits 仍在创建资源前拒绝", () => {
  const f = legacyFixture();
  try { for (const change of [(c: any) => c.tasks[0].prompt = "../outside.md", (c: any) => c.tasks[0].scope = ["../src"], (c: any) => c.flow = ["提交"], (c: any) => c.limits = { 测试: { timeoutMin: -1 } }, (c: any) => c.acceptance = "missing.md"]) { const c = structuredClone(f.card); change(c); writeFileSync(f.file, JSON.stringify(c)); const before = f.snapshot(); assert.throws(() => createKernelRun(f.file, f.repo)); assert.deepEqual(f.snapshot(), before); } } finally { f.cleanup(); }
});
