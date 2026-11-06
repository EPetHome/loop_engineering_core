/** loop：按功能独立运行，夹具与状态不跨测试进程共享。 */
/** bin/loop 的开工、启动、状态、合入；测试仓库、worktree 和 methods.json 都建在系统临时目录。 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { methodsRecordPath, readMethodsRecord } from "../methods.ts";
import { commitAll } from "../workspace.ts";
import { LOOP_ROOT, git, fixture, loop, jsonOf, count } from "./helpers/loop-fixture.ts";

test("开工／方法指纹与执行次数：首次执行、未变跳过、变化与强制重查", () => {
  const f = fixture();
  const opened = jsonOf(loop(f.repo, ["开工", f.batch, "--json"]));
  assert.equal(opened.ok, true);
  const workspace = opened.workspaces as Array<Record<string, unknown>>;
  assert.equal(workspace[0].path, f.worktree);
  assert.equal(git(f.worktree, ["branch", "--show-current"]), "feat/测试");
  assert.equal(readFileSync(join(f.worktree, ".env.local"), "utf8"), "secret\n", "本机文件从运行版复制");
  assert.match(String(opened.startCommand), /bin\/loop.*启动/);
  assert.ok(existsSync(join(f.root, "projects")), "方法记录写在测试自己的数据目录");

  const started = jsonOf(loop(f.repo, ["启动", f.batch, "--dry-run", "--json"]));
  assert.equal(started.ok, true);
  assert.match(String(started.startCommand), /bin\/pi-dev/);
  const command = String((started.commands as string[])[0]);
  assert.match(command, /permission\.ts/);
  assert.match(command, /autoreview\.ts/);
  assert.match(command, /ponytail\.js/);
  assert.match(command, /PONYTAIL_DEFAULT_MODE=full/);
  assert.doesNotMatch(command, /GIT_DIR/);

  assert.equal(count(f.selfLog), 1);
  assert.equal(count(f.gateLog), 0);
  const second = loop(f.repo, ["开工", f.batch]);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /指纹未变，跳过方法自测/);
  assert.equal(count(f.selfLog), 1, "selfCheck 没有执行");
  assert.equal(count(f.gateLog), 0, "停用 gate 始终不执行");

  writeFileSync(join(f.worktree, "methods/check.sh"), "echo method-v2\n");
  git(f.worktree, ["add", "methods/check.sh"]); git(f.worktree, ["commit", "-qm", "change method"]);
  const changed = loop(f.repo, ["开工", f.batch, "--json"]);
  assert.equal(changed.status, 0, changed.stderr);
  assert.match(String((jsonOf(changed).methods as Record<string, unknown>).changed), /methods\/check\.sh/);
  assert.equal(count(f.selfLog), 2);
  assert.equal(count(f.gateLog), 0);
  const beforeGate = count(f.gateLog);
  const recheck = loop(f.repo, ["开工", f.batch, "--recheck", "--json"]);
  assert.equal(recheck.status, 0, recheck.stderr);
  assert.ok((jsonOf(recheck).methods as Record<string, unknown>).selfCheck, "--recheck 重新执行了 selfCheck");
  assert.equal(count(f.selfLog), 3, "--recheck 重新执行 selfCheck");
  assert.equal(count(f.gateLog), beforeGate, "--recheck 只重新检查方法，不运行 gate");
});

test("A6 运行版不在发布分支时不开工，项目根、分支和 worktree 都不变", () => {
  const f = fixture();
  git(f.repo, ["checkout", "-b", "feat/别的分支"]);
  const before = git(f.repo, ["rev-parse", "HEAD"]);
  const opened = loop(f.repo, ["开工", f.batch, "--json"]);
  assert.notEqual(opened.status, 0);
  const result = jsonOf(opened);
  assert.equal(result.branch, "feat/别的分支");
  assert.match(String(result.error), /发布分支 main/);
  assert.equal(git(f.repo, ["branch", "--show-current"]), "feat/别的分支");
  assert.equal(git(f.repo, ["rev-parse", "HEAD"]), before);
  assert.ok(!existsSync(f.worktree), "没有建 worktree");
  assert.equal(git(f.repo, ["branch", "--list", "feat/测试"]), "");
});

test("A4 运行版未提交改动不阻断开工；开发空间有未提交改动仍停下，改动原样保留", () => {
  const f = fixture();
  writeFileSync(join(f.repo, "运行版改动.txt"), "keep\n");
  const opened = loop(f.repo, ["开工", f.batch, "--json"]);
  assert.equal(opened.status, 0, `${opened.stdout}\n${opened.stderr}`);
  assert.match(opened.stdout, /未提交，不在本批分支上：运行版改动\.txt/);
  assert.deepEqual(jsonOf(opened).uncommitted, ["运行版改动.txt"]);
  assert.equal(readFileSync(join(f.repo, "运行版改动.txt"), "utf8"), "keep\n");

  writeFileSync(join(f.worktree, "README.md"), "workspace change\n");
  const dirtyWorkspace = loop(f.repo, ["开工", f.batch, "--json"]);
  assert.notEqual(dirtyWorkspace.status, 0);
  assert.match(String(jsonOf(dirtyWorkspace).error), /开发空间有未提交改动/);
  assert.equal(readFileSync(join(f.worktree, "README.md"), "utf8"), "workspace change\n");
  assert.match(git(f.worktree, ["status", "--porcelain"]), /README\.md/);
});

test("目标分支缺少忽略规则时拒绝复制本机文件", () => {
  const f = fixture();
  git(f.repo, ["worktree", "add", "-b", "feat/缺忽略", f.worktree, "main"]);
  writeFileSync(join(f.worktree, ".gitignore"), "");
  git(f.worktree, ["add", ".gitignore"]); git(f.worktree, ["commit", "-qm", "feat: 缺忽略"]);
  writeFileSync(f.batch, JSON.stringify({ name: "缺忽略批次", branch: "feat/缺忽略",
    stages: { 甲: { prompt: "prompt.md", workspace: "dev分支" } }, steps: [["甲"]] }, null, 2));
  git(f.repo, ["add", "batch.json"]); git(f.repo, ["commit", "-qm", "batch"]);
  const opened = loop(f.repo, ["开工", f.batch, "--json"]);
  assert.notEqual(opened.status, 0);
  assert.match(String(jsonOf(opened).error), /目标工作区没有忽略 localFiles：\.env\.local/);
  assert.ok(!existsSync(join(f.worktree, ".env.local")), "拒绝时没有复制本机文件");
});

test("自动提交不会纳入声明的本机文件", () => {
  const f = fixture();
  git(f.repo, ["checkout", "-b", "feat/本机文件"]);
  const marker = JSON.parse(readFileSync(join(f.repo, ".autoreview.json"), "utf8"));
  marker.localFiles = [".env.local", "secret.txt"];
  writeFileSync(join(f.repo, ".autoreview.json"), JSON.stringify(marker, null, 2));
  git(f.repo, ["add", ".autoreview.json"]); git(f.repo, ["commit", "-qm", "declare local file"]);
  mkdirSync(join(f.repo, "src"));
  writeFileSync(join(f.repo, "secret.txt"), "do not commit\n");
  writeFileSync(join(f.repo, "src", "code.txt"), "code\n");
  const result = commitAll(join(f.repo, "src"), "feat/本机文件", "本机文件批次", "甲");
  assert.equal(result.committed, true);
  const files = git(f.repo, ["show", "--name-only", "--format=", "HEAD"]).split("\n").filter(Boolean);
  assert.ok(files.includes("src/code.txt"));
  assert.ok(!files.includes("secret.txt"), "本机文件不能被自动提交");
  assert.match(git(f.repo, ["status", "--porcelain"]), /\?\? secret\.txt/);
});

test("切换分支前发现目标已跟踪本机文件就拒绝，原文件保留", () => {
  const f = fixture();
  const other = join(f.root, "conflict-branch");
  git(f.repo, ["worktree", "add", "-b", "feat/冲突", other, "main"]);
  writeFileSync(join(other, ".env.local"), "branch secret\n");
  git(other, ["add", "-f", ".env.local"]); git(other, ["commit", "-qm", "feat: 跟踪本机文件"]);
  git(f.repo, ["worktree", "remove", "--force", other]);
  git(f.repo, ["worktree", "add", "-b", "feat/当前", f.worktree, "main"]);
  writeFileSync(join(f.worktree, ".env.local"), "keep-me\n");
  writeFileSync(f.batch, JSON.stringify({ name: "冲突批次", branch: "feat/冲突",
    stages: { 甲: { prompt: "prompt.md", workspace: "dev分支" } }, steps: [["甲"]] }, null, 2));
  git(f.repo, ["add", "batch.json"]); git(f.repo, ["commit", "-qm", "batch"]);
  const opened = loop(f.repo, ["开工", f.batch, "--json"]);
  assert.notEqual(opened.status, 0);
  assert.match(String(jsonOf(opened).error), /已跟踪本机文件 \.env\.local/);
  assert.equal(readFileSync(join(f.worktree, ".env.local"), "utf8"), "keep-me\n", "拒绝时原文件内容保留");
  assert.equal(git(f.worktree, ["branch", "--show-current"]), "feat/当前", "没有切换分支");
});

test("切换分支前检查父路径被文件或符号链接替换，拒绝并保留本机文件", () => {
  for (const kind of ["普通文件", "符号链接"] as const) {
    const f = fixture();
    const marker = JSON.parse(readFileSync(join(f.repo, ".autoreview.json"), "utf8"));
    marker.localFiles = ["config/private.env"];
    writeFileSync(join(f.repo, ".autoreview.json"), JSON.stringify(marker, null, 2));
    writeFileSync(join(f.repo, ".gitignore"), ".env.local\nconfig/\n");
    mkdirSync(join(f.repo, "config"));
    writeFileSync(join(f.repo, "config", "private.env"), "runtime secret\n");
    git(f.repo, ["add", ".autoreview.json", ".gitignore"]); git(f.repo, ["commit", "-qm", "declare parent local file"]);

    const other = join(f.root, `parent-${kind}`);
    git(f.repo, ["worktree", "add", "-b", "feat/父路径冲突", other, "main"]);
    if (kind === "普通文件") writeFileSync(join(other, "config"), "target file\n");
    else symlinkSync("README.md", join(other, "config"));
    git(other, ["add", "config"]); git(other, ["commit", "-qm", `feat: ${kind}占住父路径`]);
    git(f.repo, ["worktree", "remove", "--force", other]);

    git(f.repo, ["worktree", "add", "-b", "feat/当前", f.worktree, "main"]);
    mkdirSync(join(f.worktree, "config"), { recursive: true });
    writeFileSync(join(f.worktree, "config", "private.env"), "keep-parent\n");
    writeFileSync(f.batch, JSON.stringify({ name: "父路径冲突批次", branch: "feat/父路径冲突",
      stages: { 甲: { prompt: "prompt.md", workspace: "dev分支" } }, steps: [["甲"]] }, null, 2));
    git(f.repo, ["add", "batch.json"]); git(f.repo, ["commit", "-qm", "batch"]);
    const opened = loop(f.repo, ["开工", f.batch, "--json"]);
    assert.notEqual(opened.status, 0);
    assert.match(String(jsonOf(opened).error), /已跟踪本机文件 config\/private\.env/);
    assert.equal(readFileSync(join(f.worktree, "config", "private.env"), "utf8"), "keep-parent\n", kind);
    assert.equal(git(f.worktree, ["branch", "--show-current"]), "feat/当前", kind);
  }
});

test("显式 cwd 的本仓库 worktree 同样做脏检查和方法自测", () => {
  const f = fixture();
  const wt = join(f.root, "explicit-wt");
  git(f.repo, ["worktree", "add", "-b", "feat/显式", wt, "main"]);
  const batch = join(f.root, "explicit.json");
  writeFileSync(batch, JSON.stringify({ name: "显式批次", branch: "feat/显式", stages: { 甲: { cwd: wt, start: "true" } }, steps: [["甲"]] }));
  writeFileSync(join(wt, "README.md"), "dirty explicit cwd\n");
  const dirty = loop(f.repo, ["开工", batch, "--json"]);
  assert.notEqual(dirty.status, 0);
  assert.match(String(jsonOf(dirty).error), /开发空间有未提交改动/);
  assert.equal(readFileSync(join(wt, "README.md"), "utf8"), "dirty explicit cwd\n");
  assert.equal(count(f.selfLog), 0, "脏检查失败前不执行方法自测");
  git(wt, ["checkout", "--", "README.md"]);
  const clean = loop(f.repo, ["开工", batch, "--json"]);
  assert.equal(clean.status, 0, clean.stderr);
  assert.equal(count(f.selfLog), 1, "显式 cwd 也要跑方法自测");
});

test("开工不再记录门禁树；旧 gate 只提醒并忽略，仍登记队列", () => {
  const f = fixture();
  const opened = loop(f.repo, ["开工", f.batch, "--json"]);
  assert.equal(opened.status, 0, opened.stderr);
  assert.match(opened.stderr, /gate 已停用并忽略/);
  assert.equal(count(f.gateLog), 0);
  const record = readMethodsRecord(f.worktree, process.env)!;
  assert.equal(Object.hasOwn(record, "gateTrees"), false);
  const path = methodsRecordPath(f.worktree, process.env);
  writeFileSync(path, JSON.stringify({ ...record, gateTrees: ["old-tree"] }));
  assert.equal(Object.hasOwn(readMethodsRecord(f.worktree, process.env)!, "gateTrees"), false);
  assert.equal(readMethodsRecord(f.worktree, process.env)!.fingerprint, record.fingerprint);
  assert.equal((jsonOf(loop(f.repo, ["状态", "--dry-run", "--json"])).ok), true);
});

test("A9 子命令 --json 可解析；--dry-run 不改文件、分支或 worktree", () => {
  const f = fixture();
  const dry = loop(f.repo, ["开工", f.batch, "--dry-run", "--json"]);
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(jsonOf(dry).dryRun, true);
  assert.ok(!existsSync(f.worktree), "dry-run 不建 worktree");
  assert.equal(git(f.repo, ["branch", "--list", "feat/测试"]), "");
  assert.ok(!existsSync(join(f.root, "projects")), "dry-run 不写 methods.json");

  assert.equal(loop(f.repo, ["开工", f.batch]).status, 0);
  const branchBefore = git(f.worktree, ["rev-parse", "HEAD"]);
  const record = join(f.root, "projects");
  const recordStat = statSync(record).mtimeMs;
  const startDry = loop(f.repo, ["启动", f.batch, "--dry-run", "--json"]);
  assert.equal(startDry.status, 0, startDry.stderr);
  assert.equal(jsonOf(startDry).dryRun, true);
  const status = loop(f.repo, ["状态", f.batch, "--json"]);
  assert.equal(status.status, 0, status.stderr);
  assert.deepEqual((jsonOf(status).stages as Array<Record<string, unknown>>).map((item) => item.stage), ["甲"]);
  const mergeDry = loop(f.repo, ["合入", f.batch, "--dry-run", "--json"]);
  assert.equal(mergeDry.status, 0, mergeDry.stderr);
  assert.equal(jsonOf(mergeDry).dryRun, true);
  assert.equal(git(f.worktree, ["rev-parse", "HEAD"]), branchBefore);
  assert.equal(git(f.repo, ["rev-parse", "HEAD"]), git(f.repo, ["rev-parse", "main"]));
  assert.equal(statSync(record).mtimeMs, recordStat, "其他 dry-run 不重写方法记录");

  writeFileSync(join(f.repo, "dirty.txt"), "x");
  const dirtyRuntime = loop(f.repo, ["开工", f.batch, "--json"]);
  assert.equal(dirtyRuntime.status, 0, `${dirtyRuntime.stdout}\n${dirtyRuntime.stderr}`);
  assert.deepEqual(jsonOf(dirtyRuntime).uncommitted, ["dirty.txt"]);
  assert.equal(readFileSync(join(f.repo, "dirty.txt"), "utf8"), "x");
});

test("A5 权限检查按实际 --approve / --no-approve 判断项目信任，不代替用户授权", () => {
  const f = fixture();
  try {
    assert.equal(loop(f.repo, ["开工", f.batch]).status, 0);
    const project = join(f.worktree, ".pi", "extensions", "pi-permission-system");
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "config.json"), JSON.stringify({ yoloMode: true }, null, 2));
    const global = join(f.root, "home", ".pi", "agent", "extensions", "pi-permission-system");
    mkdirSync(global, { recursive: true });
    writeFileSync(join(global, "config.json"), JSON.stringify({ yoloMode: false, permission: { bash: { "*": "ask" }, edit: "ask", write: "ask" } }, null, 2));
    const run = (trust: string) => spawnSync(join(LOOP_ROOT, "bin", "pi-dev"),
      ["--cwd", f.worktree, "--no-ponytail", join(f.worktree, "prompt.md"), "--", trust],
      { encoding: "utf8", env: process.env, timeout: 30_000 });
    const untrusted = run("--no-approve");
    assert.notEqual(untrusted.status, 0);
    assert.match(untrusted.stderr, /权限自动执行检查未通过/);
    const approved = run("--approve");
    assert.equal(approved.status, 0, `${approved.stdout}\n${approved.stderr}`);
  } finally { /* 根目录由 after 统一清理 */ }
});

test("A5 无信任记录时按全局 defaultProjectTrust 判断，不把 always 误判为未信任", () => {
  const f = fixture();
  try {
    assert.equal(loop(f.repo, ["开工", f.batch]).status, 0);
    const project = join(f.worktree, ".pi", "extensions", "pi-permission-system");
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "config.json"), JSON.stringify({ yoloMode: true }, null, 2));
    const agent = join(f.root, "home", ".pi", "agent");
    const global = join(agent, "extensions", "pi-permission-system");
    mkdirSync(global, { recursive: true });
    writeFileSync(join(global, "config.json"), JSON.stringify({ yoloMode: false, permission: { bash: { "*": "ask" }, edit: "ask", write: "ask" } }, null, 2));
    const run = () => spawnSync(join(LOOP_ROOT, "bin", "pi-dev"),
      ["--cwd", f.worktree, "--no-ponytail", join(f.worktree, "prompt.md")],
      { encoding: "utf8", env: process.env, timeout: 30_000 });
    writeFileSync(join(agent, "settings.json"), JSON.stringify({ defaultProjectTrust: "never" }));
    assert.notEqual(run().status, 0, "never 不能使用项目配置");
    writeFileSync(join(agent, "settings.json"), JSON.stringify({ defaultProjectTrust: "ask" }));
    assert.notEqual(run().status, 0, "无交互界面的 ask 不能算自动执行");
    writeFileSync(join(agent, "settings.json"), JSON.stringify({ defaultProjectTrust: "always" }));
    const allowed = run();
    assert.equal(allowed.status, 0, `${allowed.stdout}\n${allowed.stderr}`);
  } finally { /* 根目录由 after 统一清理 */ }
});
