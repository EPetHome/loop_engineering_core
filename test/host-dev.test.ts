import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EXT_DIR } from "../config.ts";
import { checkPlugin, launchArgs, resolveHost } from "../hosts/dev.ts";

test("宿主参数：自动审批、精确续接、含空格的任务仍为文件引用", () => {
  assert.deepEqual(launchArgs("claude", "/tmp/任务 a.md", "session-1"), ["--permission-mode", "auto", "--resume", "session-1", '请读取并执行 @"/tmp/任务 a.md"']);
  assert.deepEqual(launchArgs("codex", "/tmp/任务 a.md", "session-2", ["--model", "chosen"]), ["resume", "session-2", "--approve-for-me", "--model", "chosen", '请读取并执行 @"/tmp/任务 a.md"']);
  assert.throws(() => launchArgs("claude", '/tmp/a"b.md'), /双引号/);
});

test("未启用或安装的 Hook 已过期时不能声称 Loop 已加载", () => {
  assert.throws(() => checkPlugin("codex", { installed: [] }), /未启用/);
  assert.throws(() => checkPlugin("claude", [{ id: "autoreview@autoreview-local", enabled: false }]), /未启用/);
  assert.throws(() => checkPlugin("claude", [{ id: "autoreview@autoreview-local", enabled: true, installPath: "/unused" }], () => '{"hooks":{}}'), /不一致/);
});

test("显式指定的宿主失效时不偷偷换程序", () => {
  assert.throws(() => resolveHost("codex", { ...process.env, CODEX_BIN: "/not-installed/codex" }), /CODEX_BIN/);
});

test("启动入口：只读预览、明确初始化、保留配置和环境、把任务交给所选宿主", () => {
  const root = mkdtempSync(join(tmpdir(), "loop-host-dev-"));
  try {
    const cwd = join(root, "开发 空格"), task = join(root, "任务.md"), command = join(root, "host"), log = join(root, "launched.json");
    // 临时插件目录：不读本机安装缓存；Hook 指当前检出，但节点路径保持仓库模板里的值。
    const plugin = join(root, "plugin");
    mkdirSync(cwd);
    mkdirSync(join(plugin, "hooks"), { recursive: true });
    const hooks = JSON.parse(readFileSync(join(EXT_DIR, "plugins/autoreview/hooks/hooks.json"), "utf8"));
    for (const groups of Object.values(hooks.hooks) as any[]) {
      for (const group of groups) for (const hook of group.hooks) {
        hook.command = hook.command.replace(/\S*\/hosts\/hook\.ts/, join(EXT_DIR, "hosts/hook.ts"));
      }
    }
    writeFileSync(join(plugin, "hooks/hooks.json"), JSON.stringify(hooks));
    const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
    for (const args of [["init", "-q"], ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "baseline"]]) {
      const result = spawnSync("git", args, { cwd, env: gitEnv, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
    }
    writeFileSync(task, "开发任务\n同意授权：全部\n");
    writeFileSync(command, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') console.log('test host');
else if (args[0] === '--help') console.log('"auto" --approve-for-me');
else if (args[0] === 'plugin') {
  const p = {id:'autoreview@autoreview-local', pluginId:'autoreview@autoreview-local', enabled: !process.env.DISABLED_PLUGIN, version:'test', installPath:${JSON.stringify(plugin)}, source:{path:${JSON.stringify(plugin)}}};
  console.log(JSON.stringify(args.includes('--marketplace') ? {installed:[p]} : [p]));
} else fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify({args, cwd:process.cwd(), deny:process.env.EXISTING_DENY, devRoot:process.env.AUTOREVIEW_DEV_ROOT}));
`);
    chmodSync(command, 0o755);
    const env = { ...gitEnv, CLAUDE_BIN: command, CODEX_BIN: command, CODEX_HOME: join(root, "codex-home"), EXISTING_DENY: "preserved" };
    const run = (args: string[], extra = {}) => spawnSync(process.execPath, [join(EXT_DIR, "hosts/dev.ts"), ...args], { cwd, env: { ...env, ...extra }, encoding: "utf8" });
    let result = run(["claude", task]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--init/);
    result = run(["codex", task, "--init", "--dry-run"]);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!existsSync(join(cwd, ".autoreview.json")));
    assert.ok(!existsSync(log));
    assert.match(result.stdout, /--approve-for-me/);
    assert.ok(result.stdout.includes(`AUTOREVIEW_DEV_ROOT='${realpathSync(cwd)}'`), "dry-run 打印启动时项目根");
    assert.doesNotMatch(result.stdout, /同意授权/);
    result = run(["claude", task, "--init"], { DISABLED_PLUGIN: "1" });
    assert.equal(result.status, 2);
    assert.ok(!existsSync(join(cwd, ".autoreview.json")), "前置失败不应留下启用配置");
    result = run(["claude", task, "--init"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(cwd, ".autoreview.json"), "utf8"), "{}\n");
    let launched = JSON.parse(readFileSync(log, "utf8"));
    assert.deepEqual(launched.args, launchArgs("claude", realpathSync(task)));
    assert.equal(launched.deny, "preserved");
    assert.equal(launched.devRoot, realpathSync(cwd), "启动进程把项目根传给宿主和 Hook");
    const config = '{"maxRepairs":2}\n';
    writeFileSync(join(cwd, ".autoreview.json"), config);
    result = run(["codex", task, "--init", "--session", "exact-id"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(cwd, ".autoreview.json"), "utf8"), config);
    launched = JSON.parse(readFileSync(log, "utf8"));
    assert.deepEqual(launched.args, launchArgs("codex", realpathSync(task), "exact-id"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
