/** 门禁继承流水线身份时，单测入口仍使用自己的临时仓库、基线与会话。 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const STARTUP = new URL("./test-env.ts", import.meta.url).href;
const launchEnv = (root: string) => ({
  AUTOREVIEW_BASE_REV: "ffffffffffffffffffffffffffffffffffffffff",
  AUTOREVIEW_BATCH_FILE: join(root, "批次.json"),
  AUTOREVIEW_STAGE: "外层段",
  AUTOREVIEW_DEV_ROOT: root,
  AUTOREVIEW_PIPELINE_DIR: join(root, "pipeline"),
  AUTOREVIEW_PIPELINE_LAUNCH: "1",
  AUTOREVIEW_PIPELINE_LAUNCH_TOKEN: "outer-launch-token",
});

test("测试启动隔离只清除外层启动身份，保留资源归属与普通环境", () => {
  const outer = launchEnv(tmpdir());
  const preserved = { AUTOREVIEW_RUN_ID: "outer-resource", AUTOREVIEW_TEMP_DIR: tmpdir(), TEST_ENV_SENTINEL: "keep" };
  const keys = [...Object.keys(outer), ...Object.keys(preserved), "PATH"];
  const result = spawnSync(process.execPath, ["--input-type=module", "-e",
    `await import(${JSON.stringify(STARTUP)}); console.log(JSON.stringify(Object.fromEntries(${JSON.stringify(keys)}.map(key => [key, process.env[key]]))))`],
    { encoding: "utf8", env: { ...process.env, ...outer, ...preserved } });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { ...preserved, PATH: process.env.PATH });
});

test("测试入口隔离：带流水线上下文执行 Pi、Hook、评审的真实回归场景", () => {
  const root = mkdtempSync(join(tmpdir(), "autoreview-test-env-"));
  try {
    const outer = launchEnv(root);
    mkdirSync(outer.AUTOREVIEW_PIPELINE_DIR);
    const batch = JSON.stringify({ stages: { 外层段: { scope: { deny: [""] } } } });
    writeFileSync(outer.AUTOREVIEW_BATCH_FILE, batch);
    const env: Record<string, string | undefined> = { ...process.env, ...outer };
    // 新开独立 Node 测试运行器，不继承当前测试 worker 的内部身份；流水线身份全部保留。
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ["--test", "--test-reporter=spec",
      "--test-name-pattern=^G6 B5|^H3 Stop|^评审预算：首次用掉",
      "test/autoreview.test.ts", "test/hook.test.ts", "test/review.test.ts"],
      { cwd: ROOT, encoding: "utf8", env, timeout: 60_000 });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /G6 B5/);
    assert.match(result.stdout, /H3 Stop/);
    assert.match(result.stdout, /评审预算：首次用掉/);
    assert.match(result.stdout, /pass 3/);
    assert.equal(readFileSync(outer.AUTOREVIEW_BATCH_FILE, "utf8"), batch, "不改外层批次文件");
    assert.equal(existsSync(join(outer.AUTOREVIEW_PIPELINE_DIR, "外层段.status.json")), false, "不回报到外层流水线");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
