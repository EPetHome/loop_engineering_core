/** 旧 workflow 不执行；新卡 flow 与配置/独立预算、历史报告保留。 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { parseProjectLayout, resolveProjectConfig } from "../config.ts";
import { completionChecks } from "../pipeline-core.ts";
import { renderSummary } from "../core.ts";
import { legacyFixture } from "./helpers/pipeline-fixture.ts";
test("旧 workflow 任意值/验收/开工/环境均不再决定执行或预算，项目原文不改", () => {
  const f = legacyFixture();
  try {
    for (const workflow of ["with-acceptance", "without-acceptance", "invalid", null]) { f.raw.stages.甲.workflow = workflow; f.save(); f.refuse("开工"); f.refuse("启动", [], true); }
    const file = join(f.repo, ".autoreview.json"), data = { workflow: "invalid", workspaces: "ignored", gate: { cmd: "exit 99" }, reviewTimeoutMin: 1, acceptance: { timeoutMin: 999 } }; writeFileSync(file, JSON.stringify(data)); const before = readFileSync(file);
    const config = resolveProjectConfig(f.repo, { env: { AUTOREVIEW_BATCH_FILE: "/missing", AUTOREVIEW_STAGE: "甲" } });
    assert.equal(Object.hasOwn(config, "workflow"), false); assert.equal(config.reviewTimeoutMin, 1); assert.equal(config.acceptance?.timeoutMin, 999); assert.equal(Object.hasOwn(parseProjectLayout(data, f.repo), "workspaces"), false); assert.deepEqual(readFileSync(file), before);
  } finally { f.cleanup(); }
});
test("交付缺结论如实展示；历史验收不伪造新检查", () => {
  assert.deepEqual(completionChecks(), { test: "Loop 未运行测试", review: "没有记录", acceptance: "没有记录" });
  const text = renderSummary({ cwd: "/tmp/project", devSessionId: "old", reviewerSessionId: "reviewer", status: "完成", rounds: [], repairs: 0, gitStatusShort: "" }); assert.match(text, /Loop 未运行测试/); assert.doesNotMatch(text, /完成资格已确认/);
});
