/** 旧开工/派发不再执行；单会话脚本透传及旧命令在权限/模型前拒绝。 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";
import { legacyFixture } from "./helpers/pipeline-fixture.ts";
import { LOOP_ROOT, fixture, loop } from "./helpers/loop-fixture.ts";
test("旧开工/启动的预算、并行、后台和内部开关均不能恢复旧调度", () => {
  const f = legacyFixture(); try { for (const action of ["开工", "启动"]) { f.refuse(action, ["--autoreview-review-timeout-min", "120"]); f.refuse(action, ["--dry-run"], true); } } finally { f.cleanup(); }
});
test("单会话 Pi 与原入口逐字透传空格和引号；不暗加测试/提交", () => {
  const f = fixture(), args = ["--cwd", f.repo, "--dry-run", join(f.repo, "prompt.md"), "--", "--autoreview-review-timeout-min", "120", "--name", "含 空格'名称"];
  const direct = spawnSync(join(LOOP_ROOT, "bin/pi-dev"), args, { cwd: f.repo, env: process.env, encoding: "utf8" }); const wrapped = loop(f.repo, ["开发", "pi", ...args]); assert.equal(direct.status, 0, direct.stderr); assert.equal(wrapped.status, 0, wrapped.stderr); assert.equal(wrapped.stdout, direct.stdout); assert.doesNotMatch(wrapped.stdout, /accept-cmd|git commit|git push/);
});
test("旧 accept-cmd/mode/timeout 两种参数形式在权限检查/模型启动前给迁移说明", () => {
  const f = fixture(); for (const flag of ["cmd", "mode", "timeout-min"]) for (const args of [[`--autoreview-accept-${flag}`, "touch sentinel"], [`--autoreview-accept-${flag}=touch sentinel`]]) { const r = loop(f.repo, ["开发", "pi", "--cwd", f.repo, join(f.repo, "prompt.md"), "--", ...args]); assert.equal(r.status, 2); assert.match(r.stderr, /旧独立验收命令已停用.*tasks\[\]\.test/); }
});
