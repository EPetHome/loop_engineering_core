/** bin/loop 的开工、启动、状态、合入；测试仓库、worktree 和 methods.json 都建在系统临时目录。 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import { parsePlan, stageScript } from "../pipeline.ts";
import { readMethodsRecord, recordGateTree } from "../methods.ts";
import { commitAll } from "../workspace.ts";
import { createChildExec } from "../hosts/hook.ts";
import { changedSince, outOfScope } from "../scope.ts";

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

test("A1 开工只要求运行版停在发布分支；批次文档随批次分支提交，无关改动保留", async () => {
  const f = fixture();
  const batch = join(f.repo, "批次-文档.json");
  const prompt = join(f.repo, "提示词-文档.md");
  writeFileSync(prompt, "按本批文档实现\n");
  writeFileSync(batch, JSON.stringify({ name: "文档批次", branch: "feat/文档",
    stages: { 甲: { prompt: "提示词-文档.md", workspace: "dev分支" } }, steps: [["甲"]] }, null, 2));
  writeFileSync(join(f.repo, "README.md"), "dirty runtime\n");
  writeFileSync(join(f.repo, "notes.txt"), "untracked\n");
  const opened = loop(f.repo, ["开工", batch, "--json"]);
  assert.equal(opened.status, 0, `${opened.stdout}\n${opened.stderr}`);
  const result = jsonOf(opened);
  assert.equal(result.ok, true);
  assert.ok(!existsSync(batch), "批次文件已从项目根移走");
  assert.ok(!existsSync(prompt), "提示词已从项目根移走");
  assert.equal(readFileSync(join(f.repo, "README.md"), "utf8"), "dirty runtime\n", "无关的已跟踪改动保留");
  assert.equal(readFileSync(join(f.repo, "notes.txt"), "utf8"), "untracked\n", "无关的未跟踪文件保留");
  assert.deepEqual(result.uncommitted, ["README.md", "notes.txt"].sort());
  const docs = result.batchDocs as Record<string, unknown>;
  assert.deepEqual(docs.files, ["批次-文档.json", "提示词-文档.md"].sort());
  assert.deepEqual(docs.restore, docs.files);
  assert.equal(docs.committed, true);
  assert.equal(docs.commit, git(f.worktree, ["rev-parse", "HEAD"]));
  const log = git(f.worktree, ["show", "-s", "--format=%s%n%b", "HEAD"]);
  assert.match(log, /^feat: 批次文档/m);
  assert.match(log, /批次：文档批次/);
  assert.deepEqual(git(f.worktree, ["show", "--name-only", "--format=", "HEAD"]).split("\n").filter(Boolean).sort(),
    ["批次-文档.json", "提示词-文档.md"].sort());
  const baseline = git(f.worktree, ["rev-parse", "HEAD"]);
  const exec = createChildExec();
  const scope = { allow: ["src/"] };
  assert.deepEqual(outOfScope(await changedSince(exec, f.worktree, baseline), scope), [], "开工文档不算开发越界");
  writeFileSync(join(f.worktree, "越界.txt"), "outside scope\n");
  assert.deepEqual(outOfScope(await changedSince(exec, f.worktree, baseline), scope), ["越界.txt"], "后续越界改动仍会检出");
});

test("A2 发布分支上已跟踪的提示词在项目根改过，也搬进批次分支并恢复", () => {
  const f = fixture();
  const absolutePrompt = join(f.repo, "prompt.md");
  const rawBatch = JSON.parse(readFileSync(f.batch, "utf8"));
  rawBatch.stages.甲.prompt = absolutePrompt;
  writeFileSync(f.batch, JSON.stringify(rawBatch, null, 2));
  git(f.repo, ["add", "batch.json"]); git(f.repo, ["commit", "-qm", "batch absolute prompt"]);
  writeFileSync(absolutePrompt, "修改后的提示词\n");
  const opened = loop(f.repo, ["开工", f.batch, "--json"]);
  assert.equal(opened.status, 0, `${opened.stdout}\n${opened.stderr}`);
  const result = jsonOf(opened);
  const docs = result.batchDocs as Record<string, unknown>;
  assert.deepEqual(docs.files, ["batch.json", "prompt.md"].sort(), "批次文件也因绝对路径改写进入提交");
  assert.equal(readFileSync(join(f.worktree, "prompt.md"), "utf8"), "修改后的提示词\n", "改过的提示词进了批次分支");
  assert.equal(readFileSync(join(f.repo, "prompt.md"), "utf8"), "做一件事\n", "项目根恢复成发布分支的内容");
  assert.deepEqual(result.uncommitted, []);
  assert.match(git(f.worktree, ["show", "-s", "--format=%s%n%b", "HEAD"]), /feat: 批次文档[\s\S]*批次：测试批次/);
  // 批次文件已随绝对提示词改写到开发空间；用开发空间里的批次文件启动时不能读回旧提示词。
  const started = loop(f.repo, ["启动", join(f.worktree, "batch.json"), "--dry-run", "--json"]);
  assert.equal(started.status, 0, `${started.stdout}\n${started.stderr}`);
  const workspacePrompt = join(f.worktree, "prompt.md").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(String(jsonOf(started).startCommand), new RegExp(workspacePrompt));
  const workspaceBatch = join(f.worktree, "batch.json");
  const plan = parsePlan(JSON.parse(readFileSync(workspaceBatch, "utf8")), f.worktree, process.env,
    { projectRoot: f.repo, batchFile: workspaceBatch });
  assert.equal(plan.stages.get("甲")!.prompt, join(f.worktree, "prompt.md"), "流水线入口解析开发空间批次文件时也指向新提示词");
});

test("A3 开工 --dry-run 列出要搬的批次文档和要恢复的项目根文件，不改任何东西", () => {
  const f = fixture();
  const batch = join(f.repo, "批次-文档.json");
  const prompt = join(f.repo, "提示词-文档.md");
  writeFileSync(prompt, "按本批文档实现\n");
  writeFileSync(batch, JSON.stringify({ name: "文档批次", branch: "feat/文档",
    stages: { 甲: { prompt: "提示词-文档.md", workspace: "dev分支" } }, steps: [["甲"]] }, null, 2));
  writeFileSync(join(f.repo, "README.md"), "dirty runtime\n");
  const before = git(f.repo, ["rev-parse", "HEAD"]);
  const dry = loop(f.repo, ["开工", batch, "--dry-run", "--json"]);
  assert.equal(dry.status, 0, dry.stderr);
  const result = jsonOf(dry);
  const docs = result.batchDocs as Record<string, unknown>;
  assert.deepEqual(docs.files, ["批次-文档.json", "提示词-文档.md"].sort());
  assert.deepEqual(docs.restore, docs.files);
  assert.deepEqual(result.uncommitted, ["README.md"]);
  assert.ok(!existsSync(f.worktree), "dry-run 不建 worktree");
  assert.equal(git(f.repo, ["branch", "--list", "feat/文档"]), "", "dry-run 不建分支");
  assert.equal(git(f.repo, ["rev-parse", "HEAD"]), before);
  assert.ok(existsSync(batch) && existsSync(prompt), "dry-run 不搬文件");
  assert.equal(readFileSync(join(f.repo, "README.md"), "utf8"), "dirty runtime\n");
});

test("A5 开工输出用开发空间里的批次文件路径，loop 启动能取到提示词并经过 bin/pi-dev", () => {
  const f = fixture();
  const dir = join(f.repo, "docs", "batches", "文档批次");
  const batch = join(dir, "批次.json");
  const prompt = join(f.repo, "docs", "prompt", "提示词-文档.md");
  const criteria = join(f.repo, "docs", "prompt", "验收-文档.md");
  mkdirSync(dir, { recursive: true }); mkdirSync(dirname(prompt), { recursive: true });
  writeFileSync(prompt, "按本批文档实现\n");
  writeFileSync(criteria, "## 验收标准\n1. 操作：执行本批\n   预期：通过\n");
  writeFileSync(batch, JSON.stringify({ name: "文档批次", branch: "feat/文档",
    stages: { 甲: { prompt, workspace: "dev分支" } }, steps: [["甲"]],
    e2e: { workDir: ".", criteria } }, null, 2));
  const opened = jsonOf(loop(f.repo, ["开工", batch, "--json"]));
  const workspaceBatch = join(f.worktree, "docs", "batches", "文档批次", "批次.json");
  assert.ok(existsSync(workspaceBatch));
  const moved = JSON.parse(readFileSync(workspaceBatch, "utf8"));
  assert.equal(moved.stages.甲.prompt, join(f.worktree, "docs", "prompt", "提示词-文档.md"), "批次文件里的绝对提示词路径改到开发空间");
  assert.equal(moved.e2e.criteria, join(f.worktree, "docs", "prompt", "验收-文档.md"), "批次文件里的绝对验收标准路径改到开发空间");
  const quoted = workspaceBatch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(String(opened.startCommand), new RegExp(quoted));
  assert.match(String(opened.statusCommand), new RegExp(quoted));
  assert.match(String(opened.mergeCommand), new RegExp(quoted));
  const started = loop(f.repo, ["启动", workspaceBatch, "--dry-run", "--json"]);
  assert.equal(started.status, 0, `${started.stdout}\n${started.stderr}`);
  const startedJson = jsonOf(started);
  assert.match(String(startedJson.startCommand), /bin\/pi-dev/);
  const command = String((startedJson.commands as string[])[0]);
  assert.match(command, /docs\/prompt\/提示词-文档\.md/);
  const status = loop(f.repo, ["状态", workspaceBatch, "--json"]);
  assert.equal(status.status, 0, `${status.stdout}\n${status.stderr}`);
  assert.deepEqual((jsonOf(status).stages as Array<Record<string, unknown>>).map((entry) => entry.stage), ["甲"]);
  const mergeDry = loop(f.repo, ["合入", workspaceBatch, "--dry-run", "--json"]);
  assert.equal(mergeDry.status, 0, `${mergeDry.stdout}\n${mergeDry.stderr}`);
  const fromWorkspace = loop(f.worktree, ["启动", workspaceBatch, "--dry-run", "--json"]);
  assert.equal(fromWorkspace.status, 0, `${fromWorkspace.stdout}\n${fromWorkspace.stderr}`);
});

test("多段流水线使用开发空间批次文件，仓库外相对引用保持原目标", () => {
  const f = fixture();
  const workspace = join(f.root, "workspaces", "wt");
  const marker = JSON.parse(readFileSync(join(f.repo, ".autoreview.json"), "utf8"));
  marker.workspaces = { dev分支: workspace };
  writeFileSync(join(f.repo, ".autoreview.json"), JSON.stringify(marker, null, 2));
  git(f.repo, ["add", ".autoreview.json"]); git(f.repo, ["commit", "-qm", "custom workspace"]);
  const batchDir = join(f.repo, "docs", "batches", "多段");
  const internal = join(f.repo, "docs", "prompt", "内部.md");
  const external = join(f.root, "external-prompt.md");
  mkdirSync(batchDir, { recursive: true }); mkdirSync(dirname(internal), { recursive: true });
  writeFileSync(internal, "内部提示词\n");
  writeFileSync(external, "外部提示词\n");
  const batch = join(batchDir, "批次.json");
  writeFileSync(batch, JSON.stringify({ name: "多段", branch: "feat/多段", stages: {
    甲: { prompt: relative(batchDir, external), workspace: "dev分支" },
    乙: { prompt: internal, workspace: "dev分支" },
  }, steps: [["甲"], ["乙"]] }, null, 2));
  const opened = loop(f.repo, ["开工", batch, "--json"]);
  assert.equal(opened.status, 0, `${opened.stdout}\n${opened.stderr}`);
  assert.equal((jsonOf(opened).workspaces as Array<Record<string, unknown>>)[0].path, workspace);
  const movedBatch = join(workspace, "docs", "batches", "多段", "批次.json");
  const moved = JSON.parse(readFileSync(movedBatch, "utf8"));
  assert.equal(moved.stages.甲.prompt, external, "仓库外相对引用改写为原绝对目标");
  assert.equal(moved.stages.乙.prompt, join(workspace, "docs", "prompt", "内部.md"), "仓库内绝对引用改到开发空间");
  const plan = parsePlan(moved, dirname(movedBatch), process.env, { projectRoot: f.repo, batchFile: movedBatch });
  assert.equal(plan.stages.get("甲")!.prompt, external);
  assert.equal(plan.stages.get("乙")!.prompt, join(workspace, "docs", "prompt", "内部.md"));
  assert.equal(plan.steps.length, 2);
});

test("依赖路径与实际搬运范围一致：全局和段级 Ponytail 能启动，验收说明可读取", async (t) => {
  for (const level of ["全局", "段级"] as const) for (const location of ["批次外", "批次内"] as const) {
    for (const pathKind of ["绝对", "相对"] as const) await t.test(`${level}·${location}·${pathKind}`, () => {
      const f = fixture();
      const batchDir = join(f.repo, "docs", "batches", "依赖");
      const resources = location === "批次内" ? join(batchDir, "resources") : join(f.repo, "dependencies");
      mkdirSync(batchDir, { recursive: true }); mkdirSync(resources, { recursive: true });
      const extension = join(resources, "ponytail.js"), guide = join(resources, "guide.md");
      writeFileSync(extension, "// local extension\n");
      writeFileSync(guide, "操作说明原文\n");
      writeFileSync(join(batchDir, "验收.md"), "## 验收标准\nA1. [甲] 操作：执行\n    预期：通过\n");
      const ref = (file: string): string => pathKind === "绝对" ? file : relative(batchDir, file);
      const ponytail = { extension: ref(extension), mode: "full" };
      const batch = join(batchDir, "批次.json");
      writeFileSync(batch, JSON.stringify({ name: "依赖", branch: "feat/依赖",
        ...(level === "全局" ? { pi: { ponytail } } : {}),
        stages: { 甲: { prompt: "../../../prompt.md", workspace: "dev分支", ...(level === "段级" ? { ponytail } : {}) } },
        steps: [["甲"]], e2e: { workDir: f.repo, criteria: "验收.md", acceptance: { guide: ref(guide) } },
      }, null, 2));
      const opened = loop(f.repo, ["开工", batch, "--json"]);
      assert.equal(opened.status, 0, `${opened.stdout}\n${opened.stderr}`);
      const expected = (file: string): string => location === "批次内" ? join(f.worktree, relative(f.repo, file)) : file;
      for (const file of [extension, guide]) {
        assert.equal(existsSync(file), location === "批次外", "只移走本批实际搬运的文件");
        assert.equal(existsSync(join(f.worktree, relative(f.repo, file))), location === "批次内");
      }
      const log = join(f.root, "pi-args.log");
      writeFileSync(process.env.PI_BIN!, `#!/bin/sh\nprintf '%s\\n' "$@" > '${log}'\n`);
      const permission = join(f.root, "home", ".pi", "agent", "extensions", "pi-permission-system");
      mkdirSync(permission, { recursive: true });
      writeFileSync(join(permission, "config.json"), JSON.stringify({ yoloMode: true }));
      const movedBatch = join(f.worktree, relative(f.repo, batch));
      const started = loop(f.repo, ["启动", movedBatch, "--json"]);
      assert.equal(started.status, 0, `${started.stdout}\n${started.stderr}`);
      assert.ok(readFileSync(log, "utf8").split("\n").includes(expected(extension)), "pi-dev 传入可用的扩展路径");
      const plan = parsePlan(JSON.parse(readFileSync(movedBatch, "utf8")), dirname(movedBatch), process.env,
        { projectRoot: f.repo, batchFile: movedBatch });
      assert.equal(plan.stages.get("甲")!.ponytail!.extension, expected(extension));
      assert.equal(plan.e2e!.acceptance.guide, expected(guide));
      assert.equal(readFileSync(plan.e2e!.acceptance.guide!, "utf8"), "操作说明原文\n");
    });
  }
});

test("非同级工作区配合相对 cwd，搬运后能从原目录实际启动", async (t) => {
  for (const entry of ["prompt", "start"] as const) await t.test(entry, () => {
    const f = fixture();
    const workspace = join(f.root, "workspaces", "dev");
    git(f.repo, ["worktree", "add", "-b", "feat/相对目录", workspace, "main"]);
    const batchDir = join(f.repo, "docs", "batches", "相对目录");
    mkdirSync(batchDir, { recursive: true });
    const batch = join(batchDir, "批次.json");
    const log = join(f.root, "started-cwd.log");
    writeFileSync(process.env.PI_BIN!, `#!/bin/sh\npwd > '${log}'\n`);
    const source = { name: "相对目录", branch: "feat/相对目录", stages: {
      甲: { cwd: relative(batchDir, workspace), ...(entry === "prompt"
        ? { prompt: "../../../prompt.md" } : { start: `pwd > '${log}'` }) },
    }, steps: [["甲"]] };
    writeFileSync(batch, JSON.stringify(source, null, 2));
    const opened = loop(f.repo, ["开工", batch, "--json"]);
    assert.equal(opened.status, 0, `${opened.stdout}\n${opened.stderr}`);
    const movedBatch = join(workspace, "docs", "batches", "相对目录", "批次.json");
    const permission = join(f.root, "home", ".pi", "agent", "extensions", "pi-permission-system");
    mkdirSync(permission, { recursive: true });
    writeFileSync(join(permission, "config.json"), JSON.stringify({ yoloMode: true }));
    const started = loop(f.repo, ["启动", movedBatch, "--json"]);
    assert.equal(started.status, 0, `${started.stdout}\n${started.stderr}`);
    assert.equal(jsonOf(started).cwd, workspace);
    assert.equal(readFileSync(log, "utf8").trim(), workspace, "启动进程实际位于原 cwd");
    const plan = parsePlan(JSON.parse(readFileSync(movedBatch, "utf8")), dirname(movedBatch), process.env,
      { projectRoot: f.repo, batchFile: movedBatch });
    assert.equal(plan.stages.get("甲")!.cwd, workspace, "直接流水线入口也保留原 cwd");
  });
});

test("原生开发空间批次保留相对引用解析，不按 worktree 来源重定位", () => {
  const f = fixture();
  const wt = join(f.root, "dev", "wt");
  git(f.repo, ["worktree", "add", "-b", "feat/原生", wt, "main"]);
  const prompt = join(f.root, "dev", "prompt.md");
  const criteria = join(f.root, "dev", "criteria.md");
  mkdirSync(dirname(prompt), { recursive: true });
  writeFileSync(prompt, "原生提示词\n");
  writeFileSync(criteria, "## 验收标准\n1. 操作：执行\n   预期：通过\n");
  const batch = join(wt, "批次.json");
  writeFileSync(batch, JSON.stringify({ name: "原生", branch: "feat/原生",
    stages: { 甲: { prompt: "../prompt.md", workspace: "dev分支" } }, steps: [["甲"]],
    e2e: { workDir: ".", criteria: "../criteria.md" } }, null, 2));
  const plan = parsePlan(JSON.parse(readFileSync(batch, "utf8")), wt, process.env,
    { batchFile: batch, projectRoot: f.repo });
  assert.equal(plan.stages.get("甲")!.prompt, prompt, "相对提示词按批次所在目录解析");
  assert.equal(plan.e2e!.criteriaFile, criteria, "相对验收标准按批次所在目录解析");
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

test("被忽略的同名文件不被覆盖：搬运前列出全部未跟踪目标并保留两边文档", async (t) => {
  for (const kind of ["文件", "链接", "悬空链接", "目录"] as const) await t.test(kind, () => {
    const f = fixture();
    git(f.repo, ["worktree", "add", "-b", "feat/测试", f.worktree, "main"]);
    git(f.worktree, ["rm", "prompt.md"]);
    writeFileSync(join(f.worktree, ".gitignore"), ".env.local\nprompt.md\nz-prompt.md\n");
    git(f.worktree, ["add", ".gitignore"]); git(f.worktree, ["commit", "-qm", "ignore local prompts"]);
    const target = join(f.worktree, "prompt.md");
    const outside = join(f.root, "local-prompt.md");
    if (kind === "文件") writeFileSync(target, "local original\n");
    else if (kind === "目录") {
      mkdirSync(target); writeFileSync(join(target, "keep.md"), "local original\n");
    } else {
      if (kind === "链接") writeFileSync(outside, "local original\n");
      symlinkSync(outside, target);
    }
    writeFileSync(join(f.worktree, "z-prompt.md"), "another local original\n");
    writeFileSync(join(f.repo, "prompt.md"), "new batch prompt\n");
    writeFileSync(join(f.repo, "z-prompt.md"), "another batch prompt\n");
    const raw = JSON.parse(readFileSync(f.batch, "utf8"));
    raw.stages.乙 = { prompt: "z-prompt.md" }; raw.steps.push(["乙"]);
    writeFileSync(f.batch, JSON.stringify(raw, null, 2));
    const beforeBatch = readFileSync(join(f.worktree, "batch.json"), "utf8");
    const beforeHead = git(f.worktree, ["rev-parse", "HEAD"]);
    assert.equal(git(f.worktree, ["status", "--porcelain"]), "", "忽略文件不会触发普通脏检查");
    for (const flags of [[], ["--dry-run"]]) {
      const opened = loop(f.repo, ["开工", f.batch, "--json", ...flags]);
      assert.notEqual(opened.status, 0);
      if (kind === "文件") assert.equal(readFileSync(target, "utf8"), "local original\n");
      else if (kind === "目录") assert.equal(readFileSync(join(target, "keep.md"), "utf8"), "local original\n");
      else {
        assert.equal(lstatSync(target).isSymbolicLink(), true, "不替换未跟踪的链接本身");
        assert.equal(readlinkSync(target), outside);
        if (kind === "链接") assert.equal(readFileSync(outside, "utf8"), "local original\n");
        else assert.equal(existsSync(outside), false);
      }
      assert.equal(readFileSync(join(f.worktree, "z-prompt.md"), "utf8"), "another local original\n");
      assert.equal(readFileSync(join(f.worktree, "batch.json"), "utf8"), beforeBatch, "冲突前不写其他批次文档");
      const result = jsonOf(opened);
      assert.match(String(result.error), /未跟踪.*不覆盖/);
      assert.deepEqual(result.files, ["prompt.md", "z-prompt.md"]);
      assert.equal(git(f.worktree, ["rev-parse", "HEAD"]), beforeHead);
      assert.equal(git(f.worktree, ["status", "--porcelain"]), "");
      assert.equal(readFileSync(join(f.repo, "prompt.md"), "utf8"), "new batch prompt\n");
      assert.equal(readFileSync(f.batch, "utf8"), JSON.stringify(raw, null, 2));
    }
  });
});

test("同名文档是被忽略的未跟踪文件时，切换批次分支前就拒绝覆盖", () => {
  const f = fixture();
  git(f.repo, ["branch", "feat/测试", "main"]);
  git(f.repo, ["worktree", "add", "-b", "feat/当前", f.worktree, "main"]);
  git(f.worktree, ["rm", "prompt.md"]);
  writeFileSync(join(f.worktree, ".gitignore"), ".env.local\nprompt.md\n");
  git(f.worktree, ["add", ".gitignore"]); git(f.worktree, ["commit", "-qm", "ignore local prompt"]);
  writeFileSync(join(f.worktree, "prompt.md"), "local original\n");
  writeFileSync(join(f.repo, "prompt.md"), "new batch prompt\n");
  const opened = loop(f.repo, ["开工", f.batch, "--json"]);
  assert.equal(readFileSync(join(f.worktree, "prompt.md"), "utf8"), "local original\n", "checkout 也不能覆盖本地内容");
  assert.notEqual(opened.status, 0);
  assert.deepEqual(jsonOf(opened).files, ["prompt.md"]);
  assert.equal(git(f.worktree, ["branch", "--show-current"]), "feat/当前");
});

test("批次文档从符号链接改成普通文件时安全搬运，外部文件不被覆盖", () => {
  const f = fixture();
  const outside = join(f.root, "outside-prompt.md");
  writeFileSync(outside, "outside original\n");
  rmSync(join(f.repo, "prompt.md"));
  symlinkSync(outside, join(f.repo, "prompt.md"));
  git(f.repo, ["add", "-A"]); git(f.repo, ["commit", "-qm", "prompt symlink"]);
  rmSync(join(f.repo, "prompt.md"));
  writeFileSync(join(f.repo, "prompt.md"), "new prompt\n");
  const opened = loop(f.repo, ["开工", f.batch, "--json"]);
  assert.equal(opened.status, 0, `${opened.stdout}\n${opened.stderr}`);
  assert.equal(readFileSync(outside, "utf8"), "outside original\n", "没有写穿开发空间里的符号链接");
  const target = join(f.worktree, "prompt.md");
  assert.equal(lstatSync(target).isSymbolicLink(), false, "开发空间里保存成普通文件");
  assert.equal(readFileSync(target, "utf8"), "new prompt\n");
  assert.equal(lstatSync(join(f.repo, "prompt.md")).isSymbolicLink(), true, "项目根恢复成发布分支的符号链接");
  assert.equal(readlinkSync(join(f.repo, "prompt.md")), outside);
  assert.match(git(f.worktree, ["show", "--summary", "--format=", "HEAD"]), /mode change 120000 => 100644 prompt\.md/);
});

test("开发空间父路径是符号链接时拒绝搬批次文档，不写仓库外", () => {
  const f = fixture();
  const outside = join(f.root, "outside-docs");
  mkdirSync(outside);
  writeFileSync(join(outside, "prompt.md"), "outside original\n");
  symlinkSync(outside, join(f.repo, "docs"));
  git(f.repo, ["add", "docs"]); git(f.repo, ["commit", "-qm", "docs symlink"]);
  rmSync(join(f.repo, "docs"));
  mkdirSync(join(f.repo, "docs"));
  writeFileSync(join(f.repo, "docs", "prompt.md"), "new prompt\n");
  const rawBatch = JSON.parse(readFileSync(f.batch, "utf8"));
  rawBatch.stages.甲.prompt = "docs/prompt.md";
  writeFileSync(f.batch, JSON.stringify(rawBatch, null, 2));
  git(f.repo, ["add", "batch.json"]); git(f.repo, ["commit", "-qm", "batch under docs"]);
  const opened = loop(f.repo, ["开工", f.batch, "--json"]);
  assert.notEqual(opened.status, 0);
  assert.match(String(jsonOf(opened).error), /父路径是符号链接/);
  assert.equal(readFileSync(join(outside, "prompt.md"), "utf8"), "outside original\n", "没有写到链接目标");
  assert.equal(readFileSync(join(f.repo, "docs", "prompt.md"), "utf8"), "new prompt\n", "拒绝时项目根文件保留");
  assert.equal(lstatSync(join(f.worktree, "docs")).isSymbolicLink(), true, "开发空间里的父路径没有被替换");
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
    writeFileSync(join(f.repo, "README.md"), "user stash\n");
    git(f.repo, ["stash", "push", "--quiet", "-m", "user stash"]);
    const userStash = git(f.repo, ["rev-parse", "refs/stash"]);
    const branch = join(f.root, "merge-wt");
    git(f.repo, ["worktree", "add", "-b", "feat/合并", branch, "main"]);
    writeFileSync(join(branch, "merged.txt"), "merged\n");
    git(branch, ["add", "merged.txt"]); git(branch, ["commit", "-qm", "feat: 合并"]);
    writeFileSync(join(branch, "pending.txt"), "pending\n");
    writeFileSync(join(f.repo, "README.md"), "dirty release\n");
    writeFileSync(join(f.repo, "prompt.md"), "staged prompt\n");
    git(f.repo, ["add", "prompt.md"]);
    writeFileSync(join(f.repo, "prompt.md"), "worktree prompt\n");
    writeFileSync(join(f.repo, "未提交.txt"), "keep\n");
    const batch = join(f.root, "merge.json");
    writeFileSync(batch, JSON.stringify({ name: "合并批次", branch: "feat/合并", stages: { 甲: { cwd: branch, start: "true" } }, steps: [["甲"]] }));
    const merged = loop(f.repo, ["合入", batch, "--json"]);
    assert.equal(merged.status, 0, merged.stderr);
    const result = jsonOf(merged);
    assert.equal(result.pushed, false);
    assert.deepEqual(result.uncommitted, ["README.md", "prompt.md", "未提交.txt"].sort(), "无关改动保留并列出");
    assert.equal(readFileSync(join(f.repo, "README.md"), "utf8"), "dirty release\n");
    assert.equal(readFileSync(join(f.repo, "未提交.txt"), "utf8"), "keep\n");
    assert.equal(readFileSync(join(f.repo, "prompt.md"), "utf8"), "worktree prompt\n", "未暂存的修改恢复");
    assert.equal(git(f.repo, ["show", ":prompt.md"]), "staged prompt", "暂存内容恢复");
    assert.match(git(f.repo, ["diff", "--cached", "--name-only"]), /prompt\.md/);
    assert.match(git(f.repo, ["diff", "--name-only"]), /prompt\.md/);
    assert.doesNotMatch(git(f.repo, ["show", "--name-only", "--format=", "HEAD"]), /prompt\.md/, "暂存改动没有进入合并提交");
    assert.equal(readFileSync(join(f.repo, "pending.txt"), "utf8"), "pending\n", "合入前先提交批次分支上的未提交改动");
    assert.equal(git(f.repo, ["log", "--merges", "--format=%s", "-1"]), "feat: 合并");
    assert.equal(git(f.repo, ["rev-parse", "origin/main"]), git(f.repo, ["rev-parse", "main^1"]), "没有推送");
    assert.equal(git(f.repo, ["rev-parse", "refs/stash"]), userStash, "用户原有的 stash 还在栈顶");
    assert.match(git(f.repo, ["stash", "list", "--format=%s"]), /user stash/);
    assert.equal(git(f.repo, ["for-each-ref", "--format=%(refname)", "refs/loop/merge-stash"]), "", "本次临时引用已清理");
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
  await t.test("未提交文件和批次分支改动重叠：合入前停下，发布分支和项目根都不动", () => {
    const f = fixture();
    const branch = join(f.root, "overlap-wt");
    git(f.repo, ["worktree", "add", "-b", "feat/重叠", branch, "main"]);
    writeFileSync(join(branch, "README.md"), "branch change\n");
    git(branch, ["add", "README.md"]); git(branch, ["commit", "-qm", "feat: 重叠"]);
    writeFileSync(join(f.repo, "README.md"), "runtime dirty\n");
    const before = git(f.repo, ["rev-parse", "HEAD"]);
    const batch = join(f.root, "overlap.json");
    writeFileSync(batch, JSON.stringify({ name: "重叠批次", branch: "feat/重叠", stages: { 甲: { cwd: branch, start: "true" } }, steps: [["甲"]] }));
    const merged = loop(f.repo, ["合入", batch, "--json"]);
    assert.notEqual(merged.status, 0);
    const result = jsonOf(merged);
    assert.deepEqual(result.files, ["README.md"]);
    assert.equal(git(f.repo, ["rev-parse", "HEAD"]), before);
    assert.equal(readFileSync(join(f.repo, "README.md"), "utf8"), "runtime dirty\n");
    assert.match(git(f.repo, ["status", "--porcelain"]), /README\.md/);
  });
  await t.test("第二个分支冲突：两个合并都退回，无关的已跟踪和未跟踪改动保留", () => {
    const f = fixture();
    const first = join(f.root, "merge-first"), second = join(f.root, "merge-second");
    git(f.repo, ["worktree", "add", "-b", "feat/一", first, "main"]);
    writeFileSync(join(first, "one.txt"), "one\n");
    git(first, ["add", "one.txt"]); git(first, ["commit", "-qm", "feat: 一"]);
    git(f.repo, ["worktree", "add", "-b", "feat/二", second, "main"]);
    writeFileSync(join(second, "README.md"), "second branch\n");
    git(second, ["add", "README.md"]); git(second, ["commit", "-qm", "feat: 二"]);
    writeFileSync(join(f.repo, "README.md"), "release newer\n");
    git(f.repo, ["add", "README.md"]); git(f.repo, ["commit", "-qm", "release: 冲突来源"]);
    writeFileSync(join(f.repo, "prompt.md"), "staged prompt\n");
    git(f.repo, ["add", "prompt.md"]);
    writeFileSync(join(f.repo, "prompt.md"), "dirty prompt\n");
    writeFileSync(join(f.repo, "保留.txt"), "keep\n");
    const before = git(f.repo, ["rev-parse", "HEAD"]);
    const batch = join(f.root, "two-merges.json");
    writeFileSync(batch, JSON.stringify({ name: "两个合并", stages: {
      甲: { cwd: first, branch: "feat/一", start: "true" },
      乙: { cwd: second, branch: "feat/二", start: "true" },
    }, steps: [["甲"], ["乙"]] }));
    const merged = loop(f.repo, ["合入", batch, "--json"]);
    assert.notEqual(merged.status, 0);
    const result = jsonOf(merged);
    assert.deepEqual(result.conflicts, ["README.md"]);
    assert.equal(git(f.repo, ["rev-parse", "HEAD"]), before, "两个合并都退回合入前 HEAD");
    assert.equal(readFileSync(join(f.repo, "prompt.md"), "utf8"), "dirty prompt\n", "无关的已跟踪改动保留");
    assert.equal(git(f.repo, ["show", ":prompt.md"]), "staged prompt", "暂存内容在回退后仍保留");
    assert.match(git(f.repo, ["diff", "--cached", "--name-only"]), /prompt\.md/);
    assert.match(git(f.repo, ["diff", "--name-only"]), /prompt\.md/);
    assert.equal(readFileSync(join(f.repo, "保留.txt"), "utf8"), "keep\n", "无关的未跟踪文件保留");
    assert.equal(git(f.repo, ["log", "--merges", "--format=%s"]).includes("feat: 一"), false);
  });
});

test("合入期间 stash 栈变化时只保留本次记录，不按位置删别人的 stash", () => {
  const f = fixture();
  const branch = join(f.root, "hook-merge");
  git(f.repo, ["worktree", "add", "-b", "feat/钩子合入", branch, "main"]);
  writeFileSync(join(branch, "merged.txt"), "merged\n");
  git(branch, ["add", "merged.txt"]); git(branch, ["commit", "-qm", "feat: 钩子合入"]);
  const other = join(f.root, "hook-other");
  git(f.repo, ["worktree", "add", "-b", "feat/钩子其它", other, "main"]);
  writeFileSync(join(other, "README.md"), "other dirty\n");
  const hooks = join(f.repo, ".git", "hooks");
  mkdirSync(hooks, { recursive: true });
  const hook = join(hooks, "post-merge");
  const quoted = other.replace(/'/g, "'\\''");
  writeFileSync(hook, `#!/bin/sh\ngit -C '${quoted}' stash push --quiet -m 'other worktree stash' >/dev/null 2>&1 || true\n`);
  chmodSync(hook, 0o755);
  writeFileSync(join(f.repo, "prompt.md"), "main dirty\n");
  const batch = join(f.root, "hook-merge.json");
  writeFileSync(batch, JSON.stringify({ name: "钩子合入", branch: "feat/钩子合入", stages: { 甲: { cwd: branch, start: "true" } }, steps: [["甲"]] }));
  const merged = loop(f.repo, ["合入", batch, "--json"]);
  assert.equal(merged.status, 0, `${merged.stdout}\n${merged.stderr}`);
  assert.equal(readFileSync(join(f.repo, "prompt.md"), "utf8"), "main dirty\n", "本次 stash 已恢复");
  const list = git(f.repo, ["stash", "list", "--format=%s"]);
  assert.match(list, /other worktree stash/, "合入期间新增的 stash 没有被删除");
  assert.doesNotMatch(list, /loop 合入：临时保存运行版未提交改动/, "本次改动不写共享 stash 栈");
  assert.equal(git(f.repo, ["for-each-ref", "--format=%(refname)", "refs/loop/merge-stash"]), "", "本次独立引用已清理");
});

test("保存 stash 时其他 worktree 同时新增 stash，也不认错或删除", () => {
  const f = fixture();
  const branch = join(f.root, "race-merge");
  git(f.repo, ["worktree", "add", "-b", "feat/并发合入", branch, "main"]);
  writeFileSync(join(branch, "merged.txt"), "merged\n");
  git(branch, ["add", "merged.txt"]); git(branch, ["commit", "-qm", "feat: 并发合入"]);
  const other = join(f.root, "race-other");
  git(f.repo, ["worktree", "add", "-b", "feat/并发其它", other, "main"]);
  writeFileSync(join(other, "README.md"), "other dirty\n");
  const hooks = join(f.repo, ".git", "hooks");
  mkdirSync(hooks, { recursive: true });
  const hook = join(hooks, "reference-transaction");
  const state = join(f.root, "race-hook-done");
  const quote = (value: string): string => value.replace(/'/g, "'\\''");
  writeFileSync(hook, `#!/bin/sh\n[ "$1" = "prepared" ] || exit 0\nwhile IFS=' ' read -r old new ref; do\n  case "$ref" in\n    refs/loop/merge-stash/*)\n      if [ ! -f '${quote(state)}' ]; then\n        : > '${quote(state)}'\n        git -C '${quote(other)}' stash push --quiet -m 'concurrent stash' >/dev/null 2>&1 || true\n      fi\n      ;;\n  esac\ndone\n`);
  chmodSync(hook, 0o755);
  writeFileSync(join(f.repo, "prompt.md"), "main dirty\n");
  const batch = join(f.root, "race-merge.json");
  writeFileSync(batch, JSON.stringify({ name: "并发合入", branch: "feat/并发合入", stages: { 甲: { cwd: branch, start: "true" } }, steps: [["甲"]] }));
  const merged = loop(f.repo, ["合入", batch, "--json"]);
  assert.equal(merged.status, 0, `${merged.stdout}\n${merged.stderr}`);
  assert.equal(readFileSync(join(f.repo, "prompt.md"), "utf8"), "main dirty\n", "本次改动已恢复");
  assert.match(git(f.repo, ["stash", "list", "--format=%s"]), /concurrent stash/, "并发新增的 stash 保留");
  assert.equal(git(f.repo, ["for-each-ref", "--format=%(refname)", "refs/loop/merge-stash"]), "", "本次独立引用已清理");
});

test("批次工作区未提交改动和项目根重叠时，合入前停下且不自动提交", () => {
  const f = fixture();
  const branch = join(f.root, "both-dirty");
  git(f.repo, ["worktree", "add", "-b", "feat/双方改动", branch, "main"]);
  const branchHead = git(branch, ["rev-parse", "HEAD"]);
  writeFileSync(join(branch, "README.md"), "workspace dirty\n");
  writeFileSync(join(f.repo, "README.md"), "runtime dirty\n");
  const mainHead = git(f.repo, ["rev-parse", "HEAD"]);
  const batch = join(f.root, "both-dirty.json");
  writeFileSync(batch, JSON.stringify({ name: "双方改动", branch: "feat/双方改动", stages: { 甲: { cwd: branch, start: "true" } }, steps: [["甲"]] }));
  const merged = loop(f.repo, ["合入", batch, "--json"]);
  assert.notEqual(merged.status, 0);
  const result = jsonOf(merged);
  assert.deepEqual(result.files, ["README.md"]);
  assert.equal(git(f.repo, ["rev-parse", "HEAD"]), mainHead);
  assert.equal(git(branch, ["rev-parse", "HEAD"]), branchHead, "批次工作区没有自动提交");
  assert.equal(readFileSync(join(f.repo, "README.md"), "utf8"), "runtime dirty\n");
  assert.equal(readFileSync(join(branch, "README.md"), "utf8"), "workspace dirty\n");
  assert.match(git(branch, ["status", "--porcelain"]), /README\.md/);
});

test("清理 stash 前发现未跟踪文件挡住 HEAD 路径时，不覆盖它", () => {
  const f = fixture();
  mkdirSync(join(f.repo, "dir"));
  writeFileSync(join(f.repo, "dir", "a.txt"), "tracked\n");
  git(f.repo, ["add", "dir/a.txt"]); git(f.repo, ["commit", "-qm", "tracked dir"]);
  const branch = join(f.root, "block-merge");
  git(f.repo, ["worktree", "add", "-b", "feat/阻挡", branch, "main"]);
  writeFileSync(join(branch, "merged.txt"), "merged\n");
  git(branch, ["add", "merged.txt"]); git(branch, ["commit", "-qm", "feat: 阻挡"]);
  rmSync(join(f.repo, "dir", "a.txt"));
  rmSync(join(f.repo, "dir"), { recursive: true });
  writeFileSync(join(f.repo, "dir"), "untracked blocker\n");
  git(f.repo, ["add", "-A", "--", "dir/a.txt"]);
  const before = git(f.repo, ["rev-parse", "HEAD"]);
  const batch = join(f.root, "block-merge.json");
  writeFileSync(batch, JSON.stringify({ name: "阻挡", branch: "feat/阻挡", stages: { 甲: { cwd: branch, start: "true" } }, steps: [["甲"]] }));
  const merged = loop(f.repo, ["合入", batch, "--json"]);
  assert.notEqual(merged.status, 0);
  const result = jsonOf(merged);
  assert.deepEqual(result.files, ["dir"]);
  assert.match(String(result.error), /未跟踪文件挡在 HEAD 路径上/);
  assert.equal(git(f.repo, ["rev-parse", "HEAD"]), before);
  assert.equal(readFileSync(join(f.repo, "dir"), "utf8"), "untracked blocker\n", "未跟踪文件内容保留");
  assert.match(git(f.repo, ["status", "--porcelain"]), /D  dir\/a\.txt/);
  assert.match(git(f.repo, ["status", "--porcelain"]), /\?\? dir/);
  assert.equal(git(f.repo, ["for-each-ref", "--format=%(refname)", "refs/loop/merge-stash"]), "", "没有创建临时引用");
  assert.equal(git(f.repo, ["stash", "list"]), "", "没有动共享 stash");
});

test("未跟踪文件扫描失败时不合入，项目根和索引不变", () => {
  const realGit = String(spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8", env: process.env }).stdout).trim();
  assert.ok(realGit, "找不到真实 git");
  const cases: Array<[string, string]> = [["空白", ""], ["部分", "partial"]];
  for (const [label, output] of cases) {
    const f = fixture();
    const branch = join(f.root, `scan-${label}`);
    git(f.repo, ["worktree", "add", "-b", `feat/扫描-${label}`, branch, "main"]);
    writeFileSync(join(branch, "merged.txt"), "merged\n");
    git(branch, ["add", "merged.txt"]); git(branch, ["commit", "-qm", `feat: 扫描-${label}`]);
    writeFileSync(join(f.repo, "README.md"), "runtime staged\n");
    git(f.repo, ["add", "README.md"]);
    const beforeHead = git(f.repo, ["rev-parse", "HEAD"]);
    const beforeStatus = git(f.repo, ["status", "--porcelain"]);
    const beforeIndex = git(f.repo, ["show", ":README.md"]);
    const fake = join(f.root, "fake-git");
    mkdirSync(fake, { recursive: true });
    const wrapper = join(fake, "git");
    const quote = (value: string): string => value.replace(/'/g, "'\\''");
    writeFileSync(wrapper, `#!/bin/sh\ncase " $* " in\n  *" ls-files --others -z "*) ${output ? `printf '${output}'` : ":"}; exit 1 ;;\nesac\nexec '${quote(realGit)}' "$@"\n`);
    chmodSync(wrapper, 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = `${fake}:${originalPath ?? ""}`;
    let merged: { status: number; stdout: string; stderr: string };
    try {
      const batch = join(f.root, `scan-${label}.json`);
      writeFileSync(batch, JSON.stringify({ name: `扫描-${label}`, branch: `feat/扫描-${label}`, stages: { 甲: { cwd: branch, start: "true" } }, steps: [["甲"]] }));
      merged = loop(f.repo, ["合入", batch, "--json"]);
    } finally {
      process.env.PATH = originalPath;
    }
    assert.notEqual(merged.status, 0);
    assert.match(String(jsonOf(merged).error), /无法完整扫描运行版未跟踪文件/, label);
    assert.equal(git(f.repo, ["rev-parse", "HEAD"]), beforeHead, label);
    assert.equal(git(f.repo, ["status", "--porcelain"]), beforeStatus, label);
    assert.equal(git(f.repo, ["show", ":README.md"]), beforeIndex, label);
    assert.equal(git(f.repo, ["for-each-ref", "--format=%(refname)", "refs/loop/merge-stash"]), "", label);
    assert.doesNotMatch(git(f.repo, ["log", "--merges", "--format=%s"]), new RegExp(`feat: 扫描-${label}`), label);
  }
});

test("合入前发现运行版已有未完成的合并就停下，不中止用户的合并", () => {
  const f = fixture();
  const conflict = join(f.root, "user-merge");
  git(f.repo, ["worktree", "add", "-b", "feat/用户合并", conflict, "main"]);
  writeFileSync(join(conflict, "README.md"), "user branch\n");
  git(conflict, ["add", "README.md"]); git(conflict, ["commit", "-qm", "feat: 用户合并"]);
  const other = join(f.root, "user-other");
  git(f.repo, ["worktree", "add", "-b", "feat/无关", other, "main"]);
  writeFileSync(join(other, "other.txt"), "other\n");
  git(other, ["add", "other.txt"]); git(other, ["commit", "-qm", "feat: 无关"]);
  writeFileSync(join(f.repo, "README.md"), "main version\n");
  git(f.repo, ["add", "README.md"]); git(f.repo, ["commit", "-qm", "release change"]);
  const merge = spawnSync("git", ["-c", "core.quotePath=false", "merge", "--no-ff", "feat/用户合并"], {
    cwd: f.repo, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  });
  assert.notEqual(merge.status, 0);
  writeFileSync(join(f.repo, "README.md"), "resolved by user\n");
  git(f.repo, ["add", "README.md"]);
  const before = git(f.repo, ["rev-parse", "HEAD"]);
  const batch = join(f.root, "existing-merge.json");
  writeFileSync(batch, JSON.stringify({ name: "已有合并", branch: "feat/无关", stages: { 甲: { cwd: other, start: "true" } }, steps: [["甲"]] }));
  const merged = loop(f.repo, ["合入", batch, "--json"]);
  assert.notEqual(merged.status, 0);
  const result = jsonOf(merged);
  assert.equal(result.mergeInProgress, true);
  assert.match(String(result.error), /已有未完成的合并/);
  assert.equal(git(f.repo, ["rev-parse", "HEAD"]), before);
  assert.ok(git(f.repo, ["rev-parse", "--verify", "MERGE_HEAD"]), "用户的 MERGE_HEAD 还在");
  assert.equal(readFileSync(join(f.repo, "README.md"), "utf8"), "resolved by user\n", "手工解决的内容保留");
  assert.equal(git(f.repo, ["show", ":README.md"]), "resolved by user", "手工解决的内容仍在暂存区");
  assert.match(git(f.repo, ["status", "--porcelain"]), /M  README\.md/);
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
  const dirtyRuntime = loop(f.repo, ["开工", f.batch, "--json"]);
  assert.equal(dirtyRuntime.status, 0, `${dirtyRuntime.stdout}\n${dirtyRuntime.stderr}`);
  assert.deepEqual(jsonOf(dirtyRuntime).uncommitted, ["dirty.txt"]);
  assert.equal(readFileSync(join(f.repo, "dirty.txt"), "utf8"), "x");
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
