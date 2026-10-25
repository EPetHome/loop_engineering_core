/** bin/loop 的开工、启动、状态、合入；测试仓库、worktree 和 methods.json 都建在系统临时目录。 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import { parsePlan, stageScript } from "../pipeline.ts";
import { readMethodsRecord, recordGateTree } from "../methods.ts";
import { commitAll } from "../workspace.ts";

const LOOP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOOP_BIN = join(LOOP_ROOT, "bin", "loop");
const FAKE_STAGE = fileURLToPath(new URL("./fake-stage.mjs", import.meta.url));
const saved: Record<string, string | undefined> = {};
const roots: string[] = [];

function envSet(key: string, value: string): void {
  if (!(key in saved)) saved[key] = process.env[key];
  process.env[key] = value;
}

function head(): void {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "autoreview-loop-")));
  roots.push(root);
  const bin = join(root, "bin"); mkdirSync(bin);
  writeFileSync(join(bin, "osascript"), "#!/bin/sh\nexit 0\n"); chmodSync(join(bin, "osascript"), 0o755);
  const pi = join(root, "pi"); writeFileSync(pi, "#!/bin/sh\nexit 0\n"); chmodSync(pi, 0o755);
  for (const name of ["permission.ts", "ponytail.js", "autoreview.ts"]) writeFileSync(join(root, name), "");
  envSet("HOME", join(root, "home")); mkdirSync(join(root, "home"));
  envSet("AUTOREVIEW_PROJECTS_ROOT", join(root, "projects"));
  envSet("PI_BIN", pi);
  envSet("PI_NODE_BIN", dirname(process.execPath));
  envSet("PERMISSION_EXTENSION", join(root, "permission.ts"));
  envSet("PONYTAIL_EXTENSION", join(root, "ponytail.js"));
  envSet("LOOP_DIR", LOOP_ROOT);
  envSet("PATH", `${bin}:${process.env.PATH ?? ""}`);
  return root;
}

after(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  const res = spawnSync("git", ["-c", "core.quotePath=false", ...args], { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
  assert.equal(res.status, 0, `${args.join(" ")}\n${res.stderr || res.stdout}`);
  return res.stdout.trim();
}

interface Fixture { root: string; repo: string; worktree: string; batch: string; gateLog: string; selfLog: string; methods: string }

function fixture(options: { gate?: boolean } = {}): Fixture {
  const root = head();
  const repo = join(root, "repo"); mkdirSync(repo);
  git(repo, ["init", "-q"]); git(repo, ["checkout", "-b", "main"]);
  git(repo, ["config", "user.email", "loop@example.com"]); git(repo, ["config", "user.name", "loop"]);
  const gateLog = join(root, "gate.log"), selfLog = join(root, "self.log");
  const methods = join(repo, "methods", "check.sh");
  mkdirSync(dirname(methods), { recursive: true });
  writeFileSync(methods, "echo method-v1\n");
  writeFileSync(join(repo, ".gitignore"), ".env.local\n");
  writeFileSync(join(repo, ".env.local"), "secret\n");
  writeFileSync(join(repo, "README.md"), "base\n");
  writeFileSync(join(repo, "prompt.md"), "做一件事\n");
  writeFileSync(join(repo, ".autoreview.json"), JSON.stringify({
    release: "main",
    localFiles: [".env.local"],
    methods: { paths: ["methods"], selfCheck: `echo self >> ${JSON.stringify(selfLog)}`, probe: "true" },
    ...(options.gate === false ? {} : { gate: { cmd: `echo gate >> ${JSON.stringify(gateLog)}`, timeoutMin: 1 } }),
  }, null, 2));
  git(repo, ["add", "-A"]); git(repo, ["commit", "-qm", "init"]);
  const batch = join(repo, "batch.json");
  writeFileSync(batch, JSON.stringify({
    name: "测试批次", branch: "feat/测试",
    stages: { 甲: { prompt: "prompt.md", workspace: "dev分支" } },
    steps: [["甲"]],
  }, null, 2));
  git(repo, ["add", "batch.json"]); git(repo, ["commit", "-qm", "batch"]);
  return { root, repo, worktree: join(root, "repo-dev分支"), batch, gateLog, selfLog, methods };
}

function loop(cwd: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const res = spawnSync(LOOP_BIN, args, { cwd, encoding: "utf8", env: process.env, timeout: 120_000 });
  return { status: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function jsonOf(run: { stdout: string; stderr: string }): Record<string, unknown> {
  assert.ok(run.stdout.trim(), `标准输出为空；stderr：${run.stderr}`);
  return JSON.parse(run.stdout) as Record<string, unknown>;
}

const count = (path: string): number => existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").length : 0;

test("A1 开工建 worktree 和分支；启动命令经过 bin/pi-dev 并加载权限扩展、autoreview、Ponytail", () => {
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
});

test("A2 第二次开工指纹未变：跳过 selfCheck 和基线空跑", () => {
  const f = fixture();
  assert.equal(loop(f.repo, ["开工", f.batch, "--json"]).status, 0);
  assert.equal(count(f.selfLog), 1);
  assert.equal(count(f.gateLog), 1);
  const second = loop(f.repo, ["开工", f.batch]);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /指纹未变，跳过方法自测/);
  assert.equal(count(f.selfLog), 1, "selfCheck 没有执行");
  assert.equal(count(f.gateLog), 1, "基线空跑门禁没有执行");
});

test("A3 方法文件变化会重跑自测；--recheck 在指纹未变时也执行", () => {
  const f = fixture();
  assert.equal(loop(f.repo, ["开工", f.batch]).status, 0);
  writeFileSync(join(f.worktree, "methods/check.sh"), "echo method-v2\n");
  git(f.worktree, ["add", "methods/check.sh"]); git(f.worktree, ["commit", "-qm", "change method"]);
  const changed = loop(f.repo, ["开工", f.batch, "--json"]);
  assert.equal(changed.status, 0, changed.stderr);
  assert.match(String((jsonOf(changed).methods as Record<string, unknown>).changed), /methods\/check\.sh/);
  assert.equal(count(f.selfLog), 2);
  assert.equal(count(f.gateLog), 2);
  const beforeGate = count(f.gateLog);
  const recheck = loop(f.repo, ["开工", f.batch, "--recheck", "--json"]);
  assert.equal(recheck.status, 0, recheck.stderr);
  assert.ok((jsonOf(recheck).methods as Record<string, unknown>).selfCheck, "--recheck 重新执行了 selfCheck");
  assert.equal(count(f.selfLog), 3, "--recheck 重新执行 selfCheck");
  assert.equal(count(f.gateLog), beforeGate + 1, "--recheck 也重新空跑门禁");
});

test("A4 运行版或开发空间有未提交改动就停下，改动原样保留", () => {
  const f = fixture();
  assert.equal(loop(f.repo, ["开工", f.batch]).status, 0);
  writeFileSync(join(f.repo, "运行版改动.txt"), "keep\n");
  const dirtyRuntime = loop(f.repo, ["开工", f.batch, "--json"]);
  assert.notEqual(dirtyRuntime.status, 0);
  assert.match(String(jsonOf(dirtyRuntime).error), /运行版有未提交改动/);
  assert.equal(readFileSync(join(f.repo, "运行版改动.txt"), "utf8"), "keep\n");
  rmSync(join(f.repo, "运行版改动.txt"));

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

function writeStage(base: string, stage: string): string {
  return `printf '${stage}\\n' > stage-${stage}.txt && '${process.execPath}' '${FAKE_STAGE}' fix`;
}

test("单段启动写入现有流水线状态，loop 状态能读到阶段、轮次、暂停原因和总结", () => {
  const f = fixture();
  const script = join(f.root, "single-status.mjs");
  writeFileSync(script, `import { mkdirSync, writeFileSync } from "node:fs";\nimport { join } from "node:path";\nconst dir = process.env.AUTOREVIEW_PIPELINE_DIR; const stage = process.env.AUTOREVIEW_STAGE;\nmkdirSync(dir, { recursive: true });\nconst summary = join(dir, stage + ".md"); writeFileSync(summary, "# 总结\\n评审 2 次，返修 1 次\\n");\nwriteFileSync(join(dir, stage + ".status.json"), JSON.stringify({ stage, sessionId: "single", summary, event: "paused", pauseReason: "等你决定", seq: 1, inbox: 0, updatedAt: new Date().toISOString() }));\n`);
  writeFileSync(f.batch, JSON.stringify({ name: "单段批次", branch: "feat/单段", stages: { 甲: { workspace: "dev分支", start: `"${process.execPath}" "${script}"` } }, steps: [["甲"]] }, null, 2));
  git(f.repo, ["add", "batch.json"]); git(f.repo, ["commit", "-qm", "single batch"]);
  assert.equal(loop(f.repo, ["开工", f.batch]).status, 0);
  const started = loop(f.repo, ["启动", f.batch, "--json"]);
  assert.equal(started.status, 0, started.stderr);
  assert.equal(jsonOf(started).ok, true);
  const status = jsonOf(loop(f.repo, ["状态", f.batch, "--json"]));
  const entry = (status.stages as Array<Record<string, unknown>>)[0];
  assert.equal(entry.event, "paused");
  assert.equal(entry.pauseReason, "等你决定");
  assert.equal(entry.round, 2);
  assert.match(String(entry.summary), /单段批次\/甲\.md$/);
});

test("A5 串行两段同一个 worktree：每段完成后程序提交，甲的完成资格保留", () => {
  const f = fixture();
  const plan = {
    name: "串行批次", branch: "feat/串行",
    stages: {
      甲: { start: writeStage(f.root, "甲") },
      乙: { start: writeStage(f.root, "乙") },
    },
    steps: [["甲"], ["乙"]], maxParallel: 1,
    dir: join(f.root, "pipeline"),
  };
  writeFileSync(f.batch, JSON.stringify(plan, null, 2));
  git(f.repo, ["add", "batch.json"]); git(f.repo, ["commit", "-qm", "serial batch"]);
  assert.equal(loop(f.repo, ["开工", f.batch]).status, 0);
  const started = loop(f.repo, ["启动", f.batch, "--launcher", "background", "--json"]);
  assert.equal(started.status, 0, `${started.stdout}\n${started.stderr}`);
  assert.equal(jsonOf(started).ok, true);
  assert.equal(git(f.worktree, ["rev-list", "--count", "main..HEAD"]), "2", "两段各一次提交");
  const log = git(f.worktree, ["log", "--format=%s%n%b", "main..HEAD"]);
  assert.match(log, /feat: 串行/);
  assert.match(log, /批次：串行批次/);
  assert.match(log, /段：甲/);
  assert.match(log, /段：乙/);
  const status = JSON.parse(readFileSync(join(f.root, "pipeline", "甲.status.json"), "utf8"));
  assert.equal(status.event, "done");
  assert.ok(status.readyEpoch, "提交后甲的完成资格仍然有效");
});

test("启动前发现工作区分支和批次不一致就停下", () => {
  const f = fixture();
  git(f.repo, ["worktree", "add", "-b", "feat/其他", f.worktree, "main"]);
  const batch = join(f.root, "branch-mismatch.json");
  writeFileSync(batch, JSON.stringify({ name: "分支不符", branch: "feat/要求", stages: { 甲: { start: "true" } }, steps: [["甲"]] }));
  const started = loop(f.repo, ["启动", batch, "--json"]);
  assert.notEqual(started.status, 0);
  assert.match(String(jsonOf(started).error), /批次要求 feat\/要求/);
});

test("A6 并行两段各在自己的 worktree 和分支完成，并各自提交", () => {
  const f = fixture();
  const wtA = join(f.root, "wt-甲"), wtB = join(f.root, "wt-乙");
  git(f.repo, ["worktree", "add", "-b", "feat/甲", wtA, "main"]);
  git(f.repo, ["worktree", "add", "-b", "feat/乙", wtB, "main"]);
  const plan = {
    name: "并行批次",
    stages: {
      甲: { cwd: wtA, branch: "feat/甲", start: writeStage(f.root, "甲") },
      乙: { cwd: wtB, branch: "feat/乙", start: writeStage(f.root, "乙") },
    },
    steps: [["甲", "乙"]], maxParallel: 2,
    dir: join(f.root, "pipeline-parallel"),
  };
  const batch = join(f.root, "parallel.json"); writeFileSync(batch, JSON.stringify(plan, null, 2));
  const started = loop(f.repo, ["启动", batch, "--launcher", "background", "--json"]);
  assert.equal(started.status, 0, `${started.stdout}\n${started.stderr}`);
  assert.equal(jsonOf(started).ok, true);
  for (const [name, path] of [["甲", wtA], ["乙", wtB]] as const) {
    assert.equal(git(path, ["branch", "--show-current"]), `feat/${name}`);
    assert.match(git(path, ["log", "-1", "--format=%s%n%b"]), new RegExp(`feat: ${name}[\\s\\S]*段：${name}`));
  }
  const launched = ["甲", "乙"].map((name) => {
    const file = join(f.root, "pipeline-parallel", `${name}.events.log`);
    return Number(readFileSync(file, "utf8").split("\n").find((line) => line.includes("launched"))!.split(" ")[0]);
  });
  assert.ok(Math.abs(launched[0] - launched[1]) < 2_000, "两段在同一步里启动");
});

test("A7 合入没有冲突时本地合并、不推送；有冲突时中止并恢复原状", async (t) => {
  await t.test("没有冲突：发布分支多一个合并结果，远端没变", () => {
    const f = fixture();
    const remote = join(f.root, "remote.git"); git(f.root, ["init", "--bare", "-q", remote]);
    git(f.repo, ["remote", "add", "origin", remote]);
    git(f.repo, ["push", "-q", "origin", "main"]);
    const branch = join(f.root, "merge-wt");
    git(f.repo, ["worktree", "add", "-b", "feat/合并", branch, "main"]);
    writeFileSync(join(branch, "merged.txt"), "merged\n");
    git(branch, ["add", "merged.txt"]); git(branch, ["commit", "-qm", "feat: 合并"]);
    writeFileSync(join(branch, "pending.txt"), "pending\n");
    const batch = join(f.root, "merge.json");
    writeFileSync(batch, JSON.stringify({ name: "合并批次", branch: "feat/合并", stages: { 甲: { cwd: branch, start: "true" } }, steps: [["甲"]] }));
    const merged = loop(f.repo, ["合入", batch, "--json"]);
    assert.equal(merged.status, 0, merged.stderr);
    const result = jsonOf(merged);
    assert.equal(result.pushed, false);
    assert.equal(readFileSync(join(f.repo, "pending.txt"), "utf8"), "pending\n", "合入前先提交批次分支上的未提交改动");
    assert.equal(git(f.repo, ["log", "--merges", "--format=%s", "-1"]), "feat: 合并");
    assert.equal(git(f.repo, ["rev-parse", "origin/main"]), git(f.repo, ["rev-parse", "main^1"]), "没有推送");
  });
  await t.test("有冲突：中止合并，运行版恢复原状，列出冲突文件", () => {
    const f = fixture();
    const branch = join(f.root, "conflict-wt");
    git(f.repo, ["worktree", "add", "-b", "feat/冲突", branch, "main"]);
    writeFileSync(join(branch, "README.md"), "branch\n");
    git(branch, ["add", "README.md"]); git(branch, ["commit", "-qm", "feat: 冲突"]);
    writeFileSync(join(f.repo, "README.md"), "release\n");
    git(f.repo, ["add", "README.md"]); git(f.repo, ["commit", "-qm", "release change"]);
    const before = git(f.repo, ["rev-parse", "HEAD"]);
    const batch = join(f.root, "conflict.json");
    writeFileSync(batch, JSON.stringify({ name: "冲突批次", branch: "feat/冲突", stages: { 甲: { cwd: branch, start: "true" } }, steps: [["甲"]] }));
    const merged = loop(f.repo, ["合入", batch, "--json"]);
    assert.notEqual(merged.status, 0);
    const result = jsonOf(merged);
    assert.deepEqual(result.conflicts, ["README.md"]);
    assert.equal(git(f.repo, ["rev-parse", "HEAD"]), before);
    assert.equal(git(f.repo, ["status", "--porcelain"]), "");
  });
});

test("A8 流水线写 prompt 的段都经过 bin/pi-dev；ponytail:false 和段级模型覆盖照常", () => {
  const root = head();
  try {
    writeFileSync(join(root, "a.md"), "a"); writeFileSync(join(root, "b.md"), "b");
    const plan = parsePlan({ name: "提示词", stages: {
      甲: { prompt: "a.md", ponytail: false },
      乙: { prompt: "b.md", model: "override/model" },
    } }, root, {});
    const jia = plan.stages.get("甲")!.start, yi = plan.stages.get("乙")!.start;
    assert.match(jia, /bin\/pi-dev/);
    assert.match(jia, /--no-ponytail/);
    assert.doesNotMatch(jia, /--ponytail '/);
    assert.match(yi, /bin\/pi-dev/);
    assert.match(yi, /'--model' 'override\/model'/);
    assert.doesNotMatch(yi, /--no-ponytail/);
    const off = spawnSync(join(LOOP_ROOT, "bin", "pi-dev"), ["--no-ponytail", "--cwd", root, join(root, "a.md"), "--dry-run"], { encoding: "utf8", env: process.env });
    assert.equal(off.status, 0, off.stderr);
    assert.doesNotMatch(off.stdout, /ponytail\.js|PONYTAIL_DEFAULT_MODE/, "--no-ponytail 真的不加载");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("候选门禁通过时按树哈希记入 methods.json（供开工识别基线已有失败）", () => {
  const f = fixture();
  const tree = git(f.repo, ["rev-parse", "HEAD^{tree}"]);
  assert.equal(recordGateTree(f.repo, tree, process.env), true);
  assert.deepEqual(readMethodsRecord(f.repo, process.env)?.gateTrees, [tree]);
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
  const error = loop(f.repo, ["开工", f.batch, "--json"]);
  assert.notEqual(error.status, 0);
  const failure = jsonOf(error);
  assert.equal(failure.ok, false);
  assert.match(String(failure.error), /运行版有未提交改动/);
});

test("A5 启动入口检查权限自动执行：失败退出、修好后通过、指纹不变时跳过且不改配置", () => {
  const f = fixture();
  try {
    assert.equal(loop(f.repo, ["开工", f.batch]).status, 0);
    mkdirSync(join(f.root, "home", ".pi", "agent"), { recursive: true });
    writeFileSync(join(f.root, "home", ".pi", "agent", "trust.json"), JSON.stringify({ [realpathSync(f.worktree)]: true }));
    const configDir = join(f.worktree, ".pi", "extensions", "pi-permission-system");
    mkdirSync(configDir, { recursive: true });
    const config = join(configDir, "config.json");
    const denied = JSON.stringify({ yoloMode: false, permission: { bash: { "*": "ask" }, edit: "ask", write: "ask" } }, null, 2);
    writeFileSync(config, denied);
    const first = loop(f.repo, ["启动", f.batch, "--json"]);
    assert.notEqual(first.status, 0);
    const failure = jsonOf(first);
    assert.equal(failure.ok, false);
    assert.match(String(failure.stderr), /权限自动执行检查未通过/);
    assert.match(String(failure.stderr), /bash|edit|write/);
    assert.equal(readFileSync(config, "utf8"), denied, "检查不改用户配置");

    writeFileSync(config, JSON.stringify({ yoloMode: true }, null, 2));
    const second = loop(f.repo, ["启动", f.batch, "--json"]);
    assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
    assert.equal(jsonOf(second).ok, true);
    const record = readMethodsRecord(f.worktree, process.env);
    assert.ok(record?.permissionFingerprint, "通过后记下权限检查指纹");

    // 配置改回不能自动执行，但方法指纹没变：跳过检查，不重新拦截。
    writeFileSync(config, denied);
    const third = loop(f.repo, ["启动", f.batch, "--json"]);
    assert.equal(third.status, 0, `${third.stdout}\n${third.stderr}`);
    assert.equal(jsonOf(third).ok, true);
  } finally { /* 根目录由 after 统一清理 */ }
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

test("A5 流水线段启动入口失败时写回 startup-failed，编排程序不必等会话", () => {
  const f = fixture();
  try {
    assert.equal(loop(f.repo, ["开工", f.batch]).status, 0);
    mkdirSync(join(f.root, "home", ".pi", "agent"), { recursive: true });
    writeFileSync(join(f.root, "home", ".pi", "agent", "trust.json"), JSON.stringify({ [realpathSync(f.worktree)]: true }));
    const project = join(f.worktree, ".pi", "extensions", "pi-permission-system");
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "config.json"), JSON.stringify({ yoloMode: false, permission: { bash: { "*": "ask" }, edit: "ask", write: "ask" } }, null, 2));
    const pipelineDir = join(f.root, "pipeline-status");
    const run = spawnSync(join(LOOP_ROOT, "bin", "pi-dev"), ["--cwd", f.worktree, "--no-ponytail", join(f.worktree, "prompt.md")], {
      encoding: "utf8", timeout: 30_000,
      env: { ...process.env, AUTOREVIEW_PIPELINE_DIR: pipelineDir, AUTOREVIEW_STAGE: "甲", AUTOREVIEW_PIPELINE_LAUNCH: "1", AUTOREVIEW_PIPELINE_LAUNCH_TOKEN: "1" },
    });
    assert.equal(run.status, 2);
    const status = JSON.parse(readFileSync(join(pipelineDir, "甲.status.json"), "utf8"));
    assert.equal(status.event, "startup-failed");
    assert.match(status.pauseReason, /权限自动执行检查未通过/);
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

test("A5 启动成功后子进程不再持有回报身份，不能覆盖父段状态", () => {
  const f = fixture();
  try {
    assert.equal(loop(f.repo, ["开工", f.batch]).status, 0);
    mkdirSync(join(f.root, "home", ".pi", "agent"), { recursive: true });
    writeFileSync(join(f.root, "home", ".pi", "agent", "trust.json"), JSON.stringify({ [realpathSync(f.worktree)]: true }));
    const project = join(f.worktree, ".pi", "extensions", "pi-permission-system");
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "config.json"), JSON.stringify({ yoloMode: false, permission: { bash: { "*": "ask" }, edit: "ask", write: "ask" } }, null, 2));
    const pipelineDir = join(f.root, "parent-pipeline");
    mkdirSync(pipelineDir, { recursive: true });
    const statusFile = join(pipelineDir, "甲.status.json");
    const parent = JSON.stringify({ stage: "甲", sessionId: "parent", summary: "", event: "done", readyEpoch: "e", seq: 3, inbox: 0 });
    writeFileSync(statusFile, parent);
    // 模拟已启动父段里的子进程：仍有流水线目录和段名，但启动回报身份已在父 pi-dev 启动时撤掉。
    const child = spawnSync(join(LOOP_ROOT, "bin", "pi-dev"), ["--cwd", f.worktree, "--no-ponytail", join(f.worktree, "prompt.md")], {
      encoding: "utf8", timeout: 30_000,
      env: { ...process.env, AUTOREVIEW_PIPELINE_DIR: pipelineDir, AUTOREVIEW_STAGE: "甲", AUTOREVIEW_PIPELINE_LAUNCH: "1" },
    });
    assert.equal(child.status, 2);
    assert.equal(readFileSync(statusFile, "utf8"), parent, "子进程权限检查失败不能改写父段状态");
  } finally { /* 根目录由 after 统一清理 */ }
});

test("A5 自定义 start 直接启动 Pi：门禁里的权限失败不能回报父段启动失败", () => {
  const f = fixture();
  try {
    assert.equal(loop(f.repo, ["开工", f.batch]).status, 0);
    mkdirSync(join(f.root, "home", ".pi", "agent"), { recursive: true });
    writeFileSync(join(f.root, "home", ".pi", "agent", "trust.json"), JSON.stringify({ [realpathSync(f.worktree)]: true }));
    const project = join(f.worktree, ".pi", "extensions", "pi-permission-system");
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "config.json"), JSON.stringify({ yoloMode: false, permission: { bash: { "*": "ask" }, edit: "ask", write: "ask" } }, null, 2));
    const nested = join(f.worktree, "nested-start.sh");
    writeFileSync(nested, `#!/bin/sh\n# 自定义 start 的 Pi 加载 autoreview 后，扩展会撤掉一次性启动身份\nunset AUTOREVIEW_PIPELINE_LAUNCH_TOKEN\nexec '${join(LOOP_ROOT, "bin", "pi-dev")}' --cwd '${f.worktree}' --no-ponytail '${join(f.worktree, "prompt.md")}'\n`);
    chmodSync(nested, 0o755);
    const pipelineDir = join(f.root, "custom-start-pipeline");
    mkdirSync(pipelineDir, { recursive: true });
    const statusFile = join(pipelineDir, "甲.status.json");
    const parent = JSON.stringify({ stage: "甲", sessionId: "parent", summary: "", event: "done", readyEpoch: "e", seq: 3, inbox: 0 });
    writeFileSync(statusFile, parent);
    const plan = parsePlan({ name: "自定义启动", stages: { 甲: { cwd: f.worktree, start: nested } }, steps: [["甲"]], dir: pipelineDir }, f.repo, {});
    const run = spawnSync("/bin/sh", ["-c", stageScript(plan, plan.stages.get("甲")!)], {
      cwd: f.worktree, encoding: "utf8", env: process.env, timeout: 30_000,
    });
    assert.equal(run.status, 2, `${run.stdout}\n${run.stderr}`);
    assert.equal(readFileSync(statusFile, "utf8"), parent, "自定义启动链路的子进程不能改写父段状态");
  } finally { /* 根目录由 after 统一清理 */ }
});

test("A5 包装脚本调用 pi-dev：启动失败仍回传编排并非零退出，不无限等待", () => {
  const f = fixture();
  try {
    assert.equal(loop(f.repo, ["开工", f.batch]).status, 0);
    mkdirSync(join(f.root, "home", ".pi", "agent"), { recursive: true });
    writeFileSync(join(f.root, "home", ".pi", "agent", "trust.json"), JSON.stringify({ [realpathSync(f.worktree)]: true }));
    const project = join(f.worktree, ".pi", "extensions", "pi-permission-system");
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "config.json"), JSON.stringify({ yoloMode: false, permission: { bash: { "*": "ask" }, edit: "ask", write: "ask" } }, null, 2));
    const wrapper = join(f.worktree, "launch.sh");
    writeFileSync(wrapper, `#!/bin/sh\nexec '${join(LOOP_ROOT, "bin", "pi-dev")}' --cwd '${f.worktree}' --no-ponytail '${join(f.worktree, "prompt.md")}'\n`);
    chmodSync(wrapper, 0o755);
    writeFileSync(f.batch, JSON.stringify({ name: "包装启动失败", branch: "feat/测试",
      stages: { 甲: { start: wrapper }, 乙: { start: wrapper } }, steps: [["甲"], ["乙"]], maxParallel: 1 }, null, 2));
    const started = Date.now();
    const run = loop(f.repo, ["启动", f.batch, "--launcher", "background", "--json"]);
    assert.notEqual(run.status, 0);
    assert.ok(Date.now() - started < 15_000, "包装脚本启动失败没有让编排一直等待");
    const result = jsonOf(run);
    assert.equal(result.ok, false);
    assert.match(`${result.stdout}\n${result.stderr}`, /段 甲 启动失败|权限自动执行检查未通过/);
  } finally { /* 根目录由 after 统一清理 */ }
});

test("A6 .autoreview.json 或批次 scope 写错时报字段名和原因，不启动会话", () => {
  const f = fixture();
  const marker = join(f.repo, ".autoreview.json");
  const original = readFileSync(marker, "utf8");
  writeFileSync(marker, JSON.stringify({ methods: { paths: "methods" } }, null, 2));
  const badMethods = loop(f.repo, ["启动", f.batch, "--json"]);
  assert.notEqual(badMethods.status, 0);
  assert.match(String(jsonOf(badMethods).error), /methods\.paths/);
  assert.match(String(jsonOf(badMethods).error), /非空字符串数组/);
  writeFileSync(marker, original);

  const goodBatch = readFileSync(f.batch, "utf8");
  writeFileSync(f.batch, JSON.stringify({ name: "坏 scope", branch: "feat/坏", stages: { 甲: { prompt: "prompt.md", scope: { allow: "src/" } } }, steps: [["甲"]] }, null, 2));
  const badScope = loop(f.repo, ["启动", f.batch, "--json"]);
  assert.notEqual(badScope.status, 0);
  assert.match(String(jsonOf(badScope).error), /stages\.甲\.scope\.allow/);
  assert.match(String(jsonOf(badScope).error), /字符串数组/);
  writeFileSync(f.batch, goodBatch);
});
