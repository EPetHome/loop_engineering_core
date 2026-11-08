import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { createCLIWorker } from "./helpers/cli-worker.ts";
import { legacyFixture } from "./helpers/pipeline-fixture.ts";
test("复用 CLI 进程与正式命令行旧入口拒绝一致，无配置/队列缓存恢复", async () => {
  const f = legacyFixture(), worker = createCLIWorker(f.root, f.repo); try { for (const cmd of ["开工", "启动", "合入"]) { const args = [cmd, f.oldFile, "--json"], a = worker.call(args), b = spawnSync(process.execPath, [fileURLToPath(new URL("../loop.ts", import.meta.url)), ...args], { cwd: f.repo, env: process.env, encoding: "utf8" }); assert.equal(a.status, b.status); assert.deepEqual(JSON.parse(a.stdout), JSON.parse(b.stdout)); } } finally { await worker.close(); f.cleanup(); }
});
