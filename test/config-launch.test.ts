/** 配置覆盖装配回归：真实 pi-dev / 权限检查 / 流水线，模型及 Terminal 为替身，全部产物位于私有临时目录。 */
import "./test-env.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { EXT_DIR, PROJECT_CONFIG_ENV } from "../config.ts";
import { readMethodsRecord } from "../methods.ts";
import { sourceInputsProblem } from "../project-context.ts";
import { shellQuote } from "../workspace.ts";

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "loop-config-launch-")));
  const home = join(root, "home"), bin = join(root, "bin"), launches = join(root, "launches");
  mkdirSync(home); mkdirSync(bin);
  const agent = join(home, ".pi", "agent");
  mkdirSync(join(agent, "extensions", "pi-permission-system"), { recursive: true });
  writeFileSync(join(agent, "extensions", "pi-permission-system", "config.json"), '{"yoloMode":true}');
  writeFileSync(join(agent, "settings.json"), '{"defaultProjectTrust":"always"}');
  const permission = join(root, "permission.ts"); writeFileSync(permission, "// 替身通过现有配置检查，不加载真实权限扩展。\n");
  const pa = join(root, "pa.json"); writeFileSync(pa, JSON.stringify({ pa: { localNotify: false, eventsDir: join(root, "events") } }));
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agent,
    PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH}`, LOOP_DIR: EXT_DIR,
    PI_BIN: join(EXT_DIR, "test/fake-config-pi.mjs"), PI_NODE_BIN: dirname(process.execPath), PERMISSION_EXTENSION: permission,
    AUTOREVIEW_PROJECTS_ROOT: join(root, "projects"), AUTOREVIEW_RESOURCE_ROOT: join(root, "resources"),
    AUTOREVIEW_MERGE_QUEUE_ROOT: join(root, "queues"), AUTOREVIEW_PIPELINE_POLL_MS: "10", LOOP_PA_CONFIG: pa,
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", FAKE_CONFIG_LOG: launches, UNRELATED_SECRET: "do-not-copy",
  };
  for (const key of PROJECT_CONFIG_ENV) delete env[key];
  const windows = join(root, "windows.jsonl");
  // 真实 launchTerminal 生成 AppleScript；替身解码窗口命令后在独立、缺失配置覆盖的环境中实际执行。
  writeFileSync(join(bin, "osascript"), `#!${process.execPath}
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const input = process.argv.slice(2).join('\\n');
const match = /tell application "Terminal" to do script "((?:\\\\.|[^"\\\\])*)"/.exec(input);
if (!match) process.exit(0);
const command = JSON.parse('"' + match[1] + '"');
const env = { ...process.env };
delete env.AUTOREVIEW_REVIEW_TIMEOUT_MIN;
delete env.AUTOREVIEW_REVIEWER_CMD;
fs.appendFileSync(${JSON.stringify(windows)}, JSON.stringify({ command, inheritedTimeout: env.AUTOREVIEW_REVIEW_TIMEOUT_MIN ?? null }) + '\\n');
const run = spawnSync('/bin/sh', ['-c', command], { env, encoding:'utf8', timeout:30000 });
process.stdout.write(run.stdout || ''); process.stderr.write(run.stderr || '');
process.exit(run.status ?? 1);
`);
  chmodSync(join(bin, "osascript"), 0o755);
  const repo = (name: string, timeout?: number) => {
    const cwd = join(root, name); mkdirSync(cwd);
    writeFileSync(join(cwd, "need.md"), "配置覆盖装配\n");
    writeFileSync(join(cwd, "prompt.md"), "替身不调用模型\n");
    writeFileSync(join(cwd, ".autoreview.json"), JSON.stringify({
      ...(timeout === undefined ? {} : { reviewTimeoutMin: timeout }),
      gate: { cmd: "true", timeoutMin: 20 }, acceptance: { timeoutMin: 60 },
      preparation: { check: 'printf prepared > "$AUTOREVIEW_RUN_DIR/config-probe.txt"' },
      context: { sources: [{ id: "need", path: "need.md", role: "requirement" }] },
    }));
    for (const args of [["init", "-q", "-b", "main"], ["-c", "user.name=test", "-c", "user.email=test@example.com", "add", "."],
      ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-qm", "fixture"]]) {
      const run = spawnSync("git", args, { cwd, env, encoding: "utf8" }); assert.equal(run.status, 0, run.stderr);
    }
    return cwd;
  };
  const run = (cwd: string, entry: string, args: string[]) => spawnSync(join(EXT_DIR, entry), args, { cwd, env, encoding: "utf8", timeout: 60_000 });
  return { root, env, launches, windows, repo, run, close: () => rmSync(root, { recursive: true, force: true }) };
}

const json = (path: string): any => JSON.parse(readFileSync(path, "utf8"));

test("返修 1：非 dry-run 的 pi-dev 追加 flag 贯穿权限检查；不足预算仍阻止启动", () => {
  const f = fixture();
  try {
    const cwd = f.repo("standalone");
    const args = ["--cwd", cwd, "--no-ponytail", join(cwd, "prompt.md")];
    const invalid = f.run(cwd, "bin/pi-dev", args);
    assert.notEqual(invalid.status, 0); assert.match(invalid.stderr, /必须小于一轮总预算/);
    assert.ok(!existsSync(f.launches), "预算不足没有启动替身 Pi");
    const valid = f.run(cwd, "bin/pi-dev", [...args, "--", "--autoreview-review-timeout-min", "120"]);
    assert.equal(valid.status, 0, valid.stdout + valid.stderr);
    assert.deepEqual(json(join(f.launches, "standalone.json")).effectiveConfig.reviewTimeoutMin, { value: 120, source: "flag" });
    assert.ok(readMethodsRecord(cwd, f.env)?.permissionFingerprint, "实际经过权限检查并留下记录");
  } finally { f.close(); }
});

test("返修 1：非 dry-run 单段启动以 pi.args 补足预算并携带完成资格覆盖", () => {
  const f = fixture();
  try {
    const cwd = f.repo("single"), file = join(f.root, "single.json"), dir = join(f.root, "pipeline");
    writeFileSync(file, JSON.stringify({ name: "single", dir, pi: { ponytail: false, args: ["--autoreview-review-timeout-min", "120"] },
      stages: { 甲: { cwd, prompt: join(cwd, "prompt.md") } } }));
    const result = f.run(cwd, "bin/loop", ["启动", file, "--json"]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.ok(readMethodsRecord(cwd, f.env)?.permissionFingerprint);
    assert.equal(json(join(f.launches, "甲.json")).effectiveConfig.reviewTimeoutMin.value, 120);
    const status = json(join(dir, "甲.status.json"));
    assert.equal(status.configOverrides.reviewTimeoutMin, "120");
    assert.doesNotMatch(JSON.stringify(status.configOverrides), /UNRELATED_SECRET|do-not-copy|HOME/);
    assert.equal(sourceInputsProblem(cwd, status.sourceInputs, status.configOverrides), undefined);
  } finally { f.close(); }
});

test("返修 1/2：非 dry-run 多段的准备、Terminal 窗口、最终资格沿用覆盖且段 flag 优先", () => {
  const f = fixture();
  try {
    const a = f.repo("first"), b = f.repo("second");
    const file = join(f.root, "multi.json"), dir = join(f.root, "pipeline");
    writeFileSync(file, JSON.stringify({ name: "multi", dir, pi: { ponytail: false, args: ["--autoreview-review-timeout-min", "120"] },
      stages: { 甲: { cwd: a, prompt: join(a, "prompt.md") }, 乙: { cwd: b, prompt: join(b, "prompt.md"), args: ["--autoreview-review-timeout-min", "150"] } } }));
    const result = f.run(a, "bin/loop", ["启动", file, "--launcher", "terminal", "--json"]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(readFileSync(join(dir, "pipeline.finished"), "utf8").trim(), "0", "真实流水线完成资格复核通过");
    for (const [name, cwd, value] of [["甲", a, 120], ["乙", b, 150]] as const) {
      assert.ok(readMethodsRecord(cwd, f.env)?.permissionFingerprint);
      assert.equal(json(join(f.launches, `${name}.json`)).effectiveConfig.reviewTimeoutMin.value, value);
      assert.equal(readFileSync(join(dir, "preparation", name, "config-probe.txt"), "utf8"), "prepared", "真实准备方法在启动前执行");
    }
    assert.equal(readFileSync(f.windows, "utf8").trim().split("\n").length, 2);
  } finally { f.close(); }
});

test("返修 2：入口预算跨 Terminal 环境断点传递，文件 90 和缺省 60 均实际取 120", () => {
  for (const fileTimeout of [90, undefined]) {
    const f = fixture();
    try {
      const a = f.repo("first", fileTimeout), b = f.repo("second", fileTimeout);
      const file = join(f.root, "multi.json"), dir = join(f.root, "pipeline");
      writeFileSync(file, JSON.stringify({ name: "terminal", dir, pi: { ponytail: false },
        stages: { 甲: { cwd: a, prompt: join(a, "prompt.md") }, 乙: { cwd: b, prompt: join(b, "prompt.md"), args: ["--autoreview-review-timeout-min", "150"] } } }));
      const result = f.run(a, "bin/loop", ["启动", file, "--launcher", "terminal", "--autoreview-review-timeout-min", "120", "--json"]);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(json(join(f.launches, "甲.json")).effectiveConfig.reviewTimeoutMin.value, 120);
      assert.deepEqual(json(join(f.launches, "乙.json")).effectiveConfig.reviewTimeoutMin, { value: 150, source: "flag" });
      const windows = readFileSync(f.windows, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      assert.equal(windows.length, 2);
      for (const window of windows) {
        assert.equal(window.inheritedTimeout, null, "替身 Terminal 没有继承入口的预算变量");
        assert.ok(window.command.includes(shellQuote("AUTOREVIEW_REVIEW_TIMEOUT_MIN='120'").slice(1, -1)), "窗口内脚本显式携带预算");
      }
    } finally { f.close(); }
  }
});
