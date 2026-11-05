/** 共享CLI进程的契约：输出及退出码与真实命令行一致，每次重新读取配置。 */
import "./test-env.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fixture, LOOP } from "./helpers/merge-queue-fixture.ts";

test("测试CLI／复用进程与命令行输出一致，配置变化不沿用旧结果", async () => {
  const f = fixture(1), marker = join(f.repo, ".autoreview.json"), original = readFileSync(marker);
  try {
    const compare = (...args: string[]) => {
      const reused = f.cli(...args);
      const fresh = spawnSync(process.execPath, [LOOP, ...args, "--json"], { cwd: f.repo, env: process.env, encoding: "utf8" });
      assert.equal(reused.code, fresh.status, fresh.stderr);
      const { code, ...result } = reused;
      assert.deepEqual(result, JSON.parse(fresh.stdout));
      return reused;
    };
    assert.equal(compare("状态", "--dry-run").ok, true);
    const head = f.git(f.repo, "rev-parse", "HEAD");
    assert.equal(compare("合入", f.batches[0].file, "--dry-run").ok, true);
    assert.equal(f.git(f.repo, "rev-parse", "HEAD"), head, "预览不发布提交");
    writeFileSync(marker, JSON.stringify({ ...JSON.parse(original.toString()), reviewTimeoutMin: 1, gate: { cmd: "true", timeoutMin: 2 } }));
    const invalid = compare("开工", f.batches[0].file, "--dry-run");
    assert.equal(invalid.ok, false); assert.match(invalid.error, /必须小于一轮总预算/);
  } finally { writeFileSync(marker, original); await f.close(); }
});
