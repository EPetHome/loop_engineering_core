/** A3：按项目模板接入临时 git 项目，占位符不替换时 loop 开工应报方法错误。 */
import "./helpers/git-runtime.ts";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { inScope, parseStageScope } from "../scope.ts";
import { kernelFixture } from "./helpers/kernel-fixture.ts";
import { createKernelRun } from "../kernel.ts";
import { launchKernel } from "../kernel-runtime.ts";
import { readRun } from "../node-ledger.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TEMPLATE = join(ROOT, "项目模板", "项目根");
const LOOP = join(ROOT, "bin", "loop");
const BATCH = "docs/batches/示例批次-20261012/批次.json";

test("A3 模板新卡实际装配：占位符方法失败不启动模型，配置原文不改", async () => {
  const f = kernelFixture(["开发评审"]);
  try {
    cpSync(TEMPLATE, f.repo, { recursive: true });
    writeFileSync(join(f.repo, ".autoreview.json"), readFileSync(join(f.repo, ".autoreview.json.示例")));
    writeFileSync(join(f.repo, ".git/info/exclude"), readFileSync(join(f.repo, ".gitignore.示例")));
    f.git(f.repo, "add", "-A"); f.git(f.repo, "commit", "-qm", "template fixture");
    process.env.PI_BIN = join(f.root, "must-not-launch-model");
    const path = createKernelRun(join(f.repo, BATCH), f.repo).path;
    await launchKernel(path);
    const run = readRun(path); assert.equal(run.stopped, true); assert.equal(run.session, undefined);
    assert.match(run.stopReason!, /方法自测未通过|AUTOREVIEW_FAILURE=method/); assert.match(run.stopReason!, /未替换的占位符|<[^>\n]+>/);
    assert.equal(readFileSync(join(f.repo, ".autoreview.json"), "utf8"), readFileSync(join(f.repo, ".autoreview.json.示例"), "utf8"));
  } finally { f.cleanup(); }
});

test("模板骨架随仓库交付：不配置 gate，验收环境文件没有被忽略", () => {
  const config = JSON.parse(readFileSync(join(TEMPLATE, ".autoreview.json.示例"), "utf8"));
  assert.equal(Object.hasOwn(config, "gate"), false);
  assert.equal(existsSync(join(TEMPLATE, ".autoreview/methods/gate.sh")), false);
  const files = [
    "deploy/acceptance/start.sh",
    "deploy/acceptance/reset-data.sh",
    "deploy/acceptance/release.sh",
    "deploy/acceptance/GUIDE.md",
    ".gitignore.示例",
  ];
  for (const file of files) {
    const absolute = join(TEMPLATE, file);
    assert.ok(existsSync(absolute), `模板缺少文件：${file}`);
    const ignored = spawnSync("git", ["-C", ROOT, "check-ignore", "-q", "--", relative(ROOT, absolute)], { encoding: "utf8" });
    assert.notEqual(ignored.status, 0, `模板文件被忽略，不会随仓库交付：${file}`);
  }
});

test("示例批次 scope 允许业务文件和结果，拒绝其他批次文件", () => {
  const batch = JSON.parse(readFileSync(join(TEMPLATE, BATCH), "utf8"));
  const scope = parseStageScope(batch.tasks[0].scope, "示例任务 scope");
  assert.ok(scope, "示例批次应写 scope");
  assert.equal(inScope("线上/说明.md", scope), true);
  assert.equal(inScope("docs/batches/示例批次-20261012/结果.md", scope), true);
  assert.equal(inScope("docs/batches/示例批次-20261012/批次.json", scope), false);
  assert.equal(inScope(".autoreview/methods/gate.sh", scope), false);
});
