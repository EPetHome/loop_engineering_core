import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { legacyFixture } from "./helpers/pipeline-fixture.ts";
import { LOOP_ROOT, fixture } from "./helpers/loop-fixture.ts";
test("旧开工全部停用：方法自测、可见目录、切分支、文档提交与队列登记均不执行", () => {
  const f = legacyFixture(); try { f.refuse("开工"); f.refuse("开工", ["--recheck"]); f.refuse("开工", ["--dry-run"]); } finally { f.cleanup(); }
});
test("权限检查按实际 approve/no-approve 和全局 defaultProjectTrust；auto/deny 不改成逐工具批准", () => {
  const f = fixture(), project = join(f.repo, ".pi/extensions/pi-permission-system"), agent = join(f.root, "home/.pi/agent"), global = join(agent, "extensions/pi-permission-system");
  mkdirSync(project, { recursive: true }); mkdirSync(global, { recursive: true });
  writeFileSync(join(project, "config.json"), JSON.stringify({ yoloMode: true }));
  writeFileSync(join(global, "config.json"), JSON.stringify({ yoloMode: false, permission: { bash: { "*": "ask" }, edit: "ask", write: "ask" } }));
  const run = (trust?: string) => spawnSync(join(LOOP_ROOT, "bin/pi-dev"), ["--cwd", f.repo, "--no-ponytail", join(f.repo, "prompt.md"), ...(trust ? ["--", trust] : [])], { encoding: "utf8", env: process.env, timeout: 30_000 });
  const untrusted = run("--no-approve"); assert.notEqual(untrusted.status, 0); assert.match(untrusted.stderr, /权限自动执行检查未通过/);
  assert.equal(run("--approve").status, 0);
  // 修改信任配置会改变方法指纹；不会把一次通过错误用于新的信任状态。
  for (const trust of ["never", "ask", "always"]) { writeFileSync(join(agent, "settings.json"), JSON.stringify({ defaultProjectTrust: trust })); const r = run(); if (trust === "always") assert.equal(r.status, 0, r.stderr); else assert.notEqual(r.status, 0); }
  assert.notEqual(run("--no-approve").status, 0, "缓存通过后明确 no-approve 仍拒绝");
  writeFileSync(join(global, "config.json"), JSON.stringify({ yoloMode: true, permission: { bash: { "*": "deny" } } }));
  assert.notEqual(run("--approve").status, 0, "缓存与 yolo 都不能绕过明确 deny");
});
