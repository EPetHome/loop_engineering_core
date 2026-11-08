/** 配置装配保留于单会话/只评审；旧段 Pi 参数不再启用旧编排。 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { EXT_DIR } from "../config.ts";
import { readMethodsRecord } from "../methods.ts";
import { sourceInputsProblem } from "../project-context.ts";
import { kernelFixture } from "./helpers/kernel-fixture.ts";
import { legacyFixture } from "./helpers/pipeline-fixture.ts";
function fixture() {
  const f = kernelFixture(["开发评审"]), agent = join(f.root, "agent"), permission = join(f.root, "permission.ts"), launches = join(f.root, "launches");
  mkdirSync(join(agent, "extensions/pi-permission-system"), { recursive: true }); writeFileSync(join(agent, "extensions/pi-permission-system/config.json"), '{"yoloMode":true}'); writeFileSync(join(agent, "settings.json"), '{"defaultProjectTrust":"always"}'); writeFileSync(permission, "// fixture\n");
  const marker = JSON.parse(readFileSync(join(f.repo, ".autoreview.json"), "utf8")); marker.reviewTimeoutMin = 90; marker.acceptance.timeoutMin = 999; marker.context = { sources: [{ id: "need", path: "prompt.md", role: "requirement" }] }; writeFileSync(join(f.repo, ".autoreview.json"), JSON.stringify(marker));
  Object.assign(process.env, { PI_BIN: join(EXT_DIR, "test/fake-config-pi.mjs"), PI_CODING_AGENT_DIR: agent, PERMISSION_EXTENSION: permission, PI_NODE_BIN: dirname(process.execPath), FAKE_CONFIG_LOG: launches, UNRELATED_SECRET: "do-not-copy" });
  const run = (...args: string[]) => spawnSync(join(EXT_DIR, "bin/loop"), args, { cwd: f.repo, env: { ...process.env, NODE_NO_WARNINGS: "1" }, encoding: "utf8", timeout: 30_000 });
  return { ...f, launches, run, record: () => JSON.parse(readFileSync(join(launches, "standalone.json"), "utf8")) };
}
test("非预览单会话实际经过权限检查：验收时限大于评审仍启动，flag > env > 文件", () => {
  const f = fixture(); try { const args = ["开发", "pi", "--cwd", f.repo, "--no-ponytail", join(f.repo, "prompt.md")]; assert.equal(f.run(...args).status, 0); assert.deepEqual(f.record().effectiveConfig.reviewTimeoutMin, { value: 90, source: "file" }); process.env.AUTOREVIEW_REVIEW_TIMEOUT_MIN = "110"; assert.equal(f.run(...args, "--", "--autoreview-review-timeout-min", "120").status, 0); assert.deepEqual(f.record().effectiveConfig.reviewTimeoutMin, { value: 120, source: "flag" }); assert.ok(readMethodsRecord(f.repo)?.permissionFingerprint); assert.doesNotMatch(JSON.stringify(f.record().overrides), /UNRELATED_SECRET|do-not-copy|HOME/); assert.equal(sourceInputsProblem(f.repo, f.record().sourceInputs, f.record().overrides), undefined); } finally { f.cleanup(); }
});
test("精确单会话恢复沿用 argv/真实覆盖，不选择最近会话；非法 flag 仍拒绝", () => {
  const f = fixture(); try { const r = f.run("开发", "pi", "--cwd", f.repo, "--no-ponytail", "--session", "original-session", "--", "--autoreview-review-timeout-min", "150"); assert.equal(r.status, 0, r.stderr); assert.equal(f.record().sessionId, "original-session"); assert.equal(f.record().resumed, true); assert.equal(f.record().effectiveConfig.reviewTimeoutMin.value, 150); const bad = f.run("开发", "pi", "--cwd", f.repo, "--no-ponytail", "--session", "original-session", "--", "--autoreview-review-timeout-min", "invalid"); assert.notEqual(bad.status, 0); } finally { f.cleanup(); }
});
test("旧 pi.args、段覆盖、Terminal/后台环境均无副作用拒绝，不创建窗口命令或完成资格", () => {
  const f = legacyFixture(); try { f.raw.pi = { args: ["--autoreview-review-timeout-min", "120"] }; f.raw.stages.甲.args = ["--autoreview-review-timeout-min", "150"]; f.save(); for (const launcher of ["terminal", "background"]) f.refuse("启动", ["--launcher", launcher], true); } finally { f.cleanup(); }
});
test("独立只评审启动保留显式时限及来源，实际子执行器不回退旧 parsePlan", () => {
  const f = fixture(); try { const file = join(f.root, "report.json"), head = f.git(f.repo, "rev-parse", "HEAD"); writeFileSync(file, JSON.stringify({ recipe: "review-only", review: { repo: f.repo, base: head, head } })); process.env.AUTOREVIEW_REVIEWER_CMD = join(EXT_DIR, "test/fake-reviewer.mjs"); process.env.FAKE_MODE = "pass"; process.env.FAKE_STATE_DIR = join(f.root, "reviewer"); const r = f.run("启动", file, "--autoreview-review-timeout-min", "150", "--json"); assert.equal(r.status, 0, r.stderr + r.stdout); assert.deepEqual(JSON.parse(r.stdout).effectiveConfig.reviewTimeoutMin, { value: 150, source: "flag" }); assert.equal(existsSync(join(f.root, "pipeline")), false); } finally { f.cleanup(); }
});
