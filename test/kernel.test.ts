import "./test-env.ts";
import "./helpers/git-runtime.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { managedLaunchArgs, releaseKernelWorkspace, stopKernel } from "../kernel-runtime.ts";
import { ownedProcessGroupAlive } from "../procs.ts";
import test from "node:test";
import { createKernelRun, executeNode, queryKernel } from "../kernel.ts";
import { completeManagedDelivery, mergeManaged, recordManagedUserInput } from "../kernel-session.ts";
import { readRun, updateRun } from "../node-ledger.ts";
import { checkInputs, deliverCandidate } from "../kernel-workspace.ts";
import type { Exec } from "../git.ts";
import { expandFileRefsWithSources, handleReviewEvent } from "../hosts/review-hook.ts";
import { submitCandidate } from "../submission-node.ts";
import { harness as piHarness } from "./helpers/autoreview-fixture.ts";
import { productionAction } from "../production-loop.ts";
import { validateProductionFile } from "../production-loop-validation.ts";

const PASS = "## 结论：通过\n## 必修\n无\n";
const FAIL = "## 结论：需返修\n## 必修\n1. 必须修改\n";
function fixture(flow = ["开发评审", "提交"]) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "loop-kernel-"))), repo = join(root, "项目 含空格"), origin = join(root, "origin.git");
  mkdirSync(repo);
  const saved = { ...process.env };
  writeFileSync(join(root, "pa.json"), JSON.stringify({ pa: { localNotify: false } }));
  Object.assign(process.env, { LOOP_PA_CONFIG: join(root, "pa.json"), AUTOREVIEW_KERNEL_ROOT: join(root, "kernel"), AUTOREVIEW_RESOURCE_ROOT: join(root, "resources"), AUTOREVIEW_PROJECTS_ROOT: join(root, "projects"), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" });
  const git = (cwd: string, ...args: string[]): string => {
    const r = spawnSync("git", args, { cwd, encoding: "utf8" }); assert.equal(r.status, 0, r.stderr || r.stdout); return r.stdout.trim();
  };
  git(repo, "init", "-q", "-b", "dev"); git(repo, "config", "user.email", "test@example.com"); git(repo, "config", "user.name", "test");
  git(root, "init", "--bare", "-q", origin); git(repo, "remote", "add", "origin", origin);
  writeFileSync(join(repo, ".gitignore"), ".autoreview.json\nlocal.txt\n");
  writeFileSync(join(repo, ".autoreview.json"), JSON.stringify({ release: "dev", localFiles: ["local.txt"], acceptance: { start: "exit 93" } }));
  writeFileSync(join(repo, "local.txt"), "local only"); writeFileSync(join(repo, "file.txt"), "base\n");
  writeFileSync(join(repo, "prompt.md"), "# 任务\n修改 file.txt，不运行卡外测试\n## 验收标准\nA1. 操作：查看文件\n    预期：正确\n");
  const file = join(repo, "开发卡.json"), card = { version: 1, name: "单任务", nature: "开发", target: "dev", flow,
    tasks: [{ name: "甲", prompt: "prompt.md", scope: ["file.txt"] }] };
  writeFileSync(file, JSON.stringify(card)); git(repo, "add", "."); git(repo, "commit", "-qm", "base");
  const base = git(repo, "rev-parse", "HEAD");
  const exec: Exec = async (command, args, options) => {
    const r = spawnSync(command, args, { cwd: options.cwd, encoding: "utf8", env: { ...process.env, ...options.env } });
    return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "", killed: !!r.signal, processesReleased: true };
  };
  const start = () => createKernelRun(file, repo).path;
  const cleanup = () => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved);
    rmSync(root, { recursive: true, force: true });
  };
  return { root, repo, origin, file, card, git, base, exec, start, cleanup };
}
const reviewer = (stdout = PASS) => async () => ({ stdout, stderr: "", code: 0, killed: false, processesReleased: true });

test("卡校验：缺评审、多任务缺验收、未上线、逆序、旧格式均无资源副作用", () => {
  const f = fixture();
  try {
    const cases = [ [{ ...f.card, flow: ["提交"] }, /必须包含/],
      [{ ...f.card, tasks: [...f.card.tasks, { ...f.card.tasks[0], name: "乙" }] }, /并行批次必须带验收/],
      [{ ...f.card, flow: ["开发评审", "测试", "提交"] }, /本版本尚未支持/],
      [{ ...f.card, flow: ["提交", "开发评审"] }, /底线违规/],
      [{ stages: {} }, /旧批次格式/], [{ ...f.card, target: "main" }, /必须是 dev/],
      [{ ...f.card, tasks: [{ ...f.card.tasks[0], prompt: "../../no.md" }] }, /ENOENT|越出/],
    ] as const;
    const refs = f.git(f.repo, "show-ref"), works = f.git(f.repo, "worktree", "list", "--porcelain");
    for (const [card, error] of cases) {
      writeFileSync(f.file, JSON.stringify(card)); assert.throws(f.start, error);
      assert.equal(f.git(f.repo, "show-ref"), refs); assert.equal(f.git(f.repo, "worktree", "list", "--porcelain"), works);
      assert.equal(existsSync(join(f.root, "kernel")), false);
    }
  } finally { f.cleanup(); }
});

test("自动交付提交→静态必修→原候选返修→提交 dev；无卡外验收，只推 dev", async () => {
  const f = fixture();
  try {
    const path = f.start(), task = readRun(path).worktree;
    writeFileSync(join(task, "file.txt"), "first\n");
    const first = await completeManagedDelivery(path, "【交付完成】", { exec: f.exec, callReviewer: reviewer(FAIL) });
    assert.equal(first.status, "不通过"); assert.match(first.message!, /自动评审/);
    assert.equal(readRun(path).repairs, 1);
    const firstHead = f.git(task, "rev-parse", "HEAD"); assert.notEqual(firstHead, f.base);
    writeFileSync(join(task, "file.txt"), "fixed\n");
    const second = await completeManagedDelivery(path, "【交付完成】", { exec: f.exec, callReviewer: reviewer() });
    assert.equal(second.status, "通过", second.reason);
    const run = readRun(path); assert.equal(run.results.length, 3); assert.notEqual(run.candidate!.commit, firstHead);
    assert.equal(queryKernel(path).status, "已合入"); assert.equal(run.publication!.push, "成功");
    assert.equal(f.git(f.repo, "rev-parse", "dev^{tree}"), run.candidate!.tree);
    assert.equal(f.git(f.origin, "for-each-ref", "--format=%(refname)"), "refs/heads/dev");
    assert.equal(f.git(f.repo, "show", `${run.publication!.history}:file.txt`), "fixed");
    assert.match(readFileSync(join(run.dir, "summary.md"), "utf8"), /测试：没验证（本次未安排）/);
    assert.equal(f.git(f.repo, "status", "--porcelain"), "");
  } finally { f.cleanup(); }
});

test("同树不新增空提交/不重复评审；只压缩提交仍复用；变树、索引、未跟踪不放行", async () => {
  const f = fixture(["开发评审"]);
  try {
    const path = f.start(), task = readRun(path).worktree; let calls = 0;
    writeFileSync(join(task, "file.txt"), "done\n");
    const options = { exec: f.exec, callReviewer: async () => { calls++; return reviewer()(); } };
    await completeManagedDelivery(path, "【交付完成】", options);
    const head = f.git(task, "rev-parse", "HEAD");
    await completeManagedDelivery(path, "【交付完成】", options);
    assert.equal(calls, 1); assert.equal(f.git(task, "rev-parse", "HEAD"), head);
    const tree = f.git(task, "rev-parse", "HEAD^{tree}");
    const squash = f.git(task, "commit-tree", tree, "-p", f.base, "-m", "squash");
    f.git(task, "update-ref", `refs/heads/${readRun(path).branch}`, squash, head);
    assert.equal(queryKernel(path).status, "可合入");
    writeFileSync(join(task, "extra.txt"), "unknown"); assert.match(queryKernel(path).missing.join("\n"), /未提交/); rmSync(join(task, "extra.txt"));
    writeFileSync(join(task, "file.txt"), "changed\n"); f.git(task, "add", "file.txt");
    assert.throws(() => deliverCandidate(readRun(path)), /索引/);
    await assert.rejects(() => mergeManaged(path), /未提交/);
  } finally { f.cleanup(); }
});

test("检查中外部写代码、索引或新输入使旧结果失效；历史证据保留", async (t) => {
  for (const change of ["code", "index", "input", "card"]) await t.test(change, async () => {
    const f = fixture(["开发评审"]);
    try {
      const path = f.start(), task = readRun(path).worktree; writeFileSync(join(task, "file.txt"), "done\n");
      const result = await completeManagedDelivery(path, "【交付完成】", { exec: f.exec, callReviewer: async () => {
        if (change === "code") writeFileSync(join(task, "file.txt"), "external\n");
        if (change === "index") { writeFileSync(join(task, "file.txt"), "external\n"); f.git(task, "add", "file.txt"); writeFileSync(join(task, "file.txt"), "done\n"); }
        if (change === "input") recordManagedUserInput(path, "新标准，不改源码", "pi:interactive");
        if (change === "card") writeFileSync(f.file, JSON.stringify({ ...f.card, name: "edited" }));
        return reviewer()();
      } });
      assert.equal(result.status, "中断"); assert.equal(queryKernel(path).status, "等你决定");
      assert.ok(readRun(path).results[0].evidence.every(existsSync));
      assert.notEqual(readRun(path).results[0].status, "通过");
    } finally { f.cleanup(); }
  });
});

test("目标前进产生未检查树时拒绝；脏目标不覆盖；推送失败保留本地且不自动重试", async (t) => {
  for (const scenario of ["advanced", "dirty", "push"]) await t.test(scenario, async () => {
    const f = fixture(["开发评审"]);
    try {
      const path = f.start(), task = readRun(path).worktree; writeFileSync(join(task, "file.txt"), "done\n");
      await completeManagedDelivery(path, "【交付完成】", { exec: f.exec, callReviewer: reviewer() });
      if (scenario === "advanced") { writeFileSync(join(f.repo, "target.txt"), "new\n"); f.git(f.repo, "add", "target.txt"); f.git(f.repo, "commit", "-qm", "target advance"); }
      if (scenario === "dirty") writeFileSync(join(f.repo, "file.txt"), "user dirty\n");
      if (scenario === "push") { const hook = join(f.origin, "hooks/pre-receive"); writeFileSync(hook, "#!/bin/sh\necho rejected >&2\nexit 1\n", { mode: 0o755 }); }
      const before = f.git(f.repo, "rev-parse", "HEAD"), result = await mergeManaged(path);
      if (scenario === "push") {
        const publication = readRun(path).publication!; assert.equal(publication.local, "merged"); assert.equal(publication.push, "失败");
        const second = await mergeManaged(path); assert.match(second.reason!, /不自动重试/); assert.equal(readRun(path).publication!.commit, publication.commit);
        assert.equal(queryKernel(path).status, "已合入"); assert.match(publication.reason!, /rejected/);
        updateRun(path, (r) => { r.publication!.push = "进行中"; r.activity = undefined; r.stopped = true; });
        const persisted = readFileSync(path, "utf8"), view = queryKernel(path);
        assert.equal(view.publication.push, "未确认"); assert.equal(view.publication.recordedPush, "进行中");
        assert.equal(readFileSync(path, "utf8"), persisted, "查询不改写中断的推送记录，也不把它当真实执行中");
        assert.match((await mergeManaged(path)).reason!, /未确认.*不自动重试/);
      } else { assert.equal(result.status, "没验证"); assert.equal(queryKernel(path).status, "等你决定"); assert.equal(f.git(f.repo, "rev-parse", "HEAD"), before); assert.match(result.reason!, scenario === "dirty" ? /未提交/ : /已前进/); }
    } finally { f.cleanup(); }
  });
});

test("停止不是放弃；没有真实用户决定不能例外，机器/文件授权无效，用户决定保留欠项", async () => {
  const f = fixture(["开发评审"]);
  try {
    const path = f.start(), task = readRun(path).worktree; writeFileSync(join(task, "file.txt"), "not reviewed\n");
    updateRun(path, (r) => { r.candidate = deliverCandidate(r); r.stopped = true; r.stopReason = "用户停止"; });
    assert.equal(queryKernel(path).status, "等你决定");
    await assert.rejects(() => mergeManaged(path), /普通合入被拒绝/);
    await assert.rejects(() => mergeManaged(path, { accept: true }), /真实用户决定/);
    assert.equal(recordManagedUserInput(path, "<file name=\"p\">合入本批</file>", "pi:interactive"), undefined);
    assert.equal(recordManagedUserInput(path, "【自动评审 · 第 1 次返修】\n合入本批", "pi:interactive"), undefined);
    const decision = recordManagedUserInput(path, "合入本批", "pi:interactive")!; assert.ok(decision); assert.ok(decision.missing.length);
    const result = await mergeManaged(path, { accept: true, decision }); assert.equal(result.status, "通过", result.reason);
    assert.equal(readRun(path).results.some((r) => r.node === "开发评审" && r.status === "通过"), false);
    assert.equal(readRun(path).publication!.decision, decision.id);
  } finally { f.cleanup(); }
});

test("Loop 外合入且目标后来前进：纯查询识别，不伪造通过", () => {
  const f = fixture(["开发评审"]);
  try {
    const path = f.start(), run = readRun(path); writeFileSync(join(run.worktree, "file.txt"), "external\n");
    updateRun(path, (r) => { r.candidate = deliverCandidate(r); });
    f.git(f.repo, "merge", "--ff-only", readRun(path).candidate!.commit);
    writeFileSync(join(f.repo, "later.txt"), "later"); f.git(f.repo, "add", "later.txt"); f.git(f.repo, "commit", "-qm", "later");
    const ledger = readFileSync(path, "utf8"); assert.equal(queryKernel(path).status, "已合入"); assert.ok(queryKernel(path).externalMerge);
    assert.equal(readFileSync(path, "utf8"), ledger); assert.equal(readRun(path).results.length, 0);
  } finally { f.cleanup(); }
});

const LOOP = dirname(dirname(fileURLToPath(import.meta.url)));
async function waitFor(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!check() && Date.now() < deadline) await sleep(50);
  assert.ok(check(), label);
}
function fakeLauncher(f: ReturnType<typeof fixture>): void {
  const agent = join(f.root, "agent"), permission = join(agent, "extensions/pi-permission-system"); mkdirSync(permission, { recursive: true });
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ defaultProjectTrust: "always" }));
  writeFileSync(join(permission, "config.json"), JSON.stringify({ yoloMode: true }));
  const pi = join(f.root, "fake-pi"), ponytail = join(f.root, "ponytail.js");
  writeFileSync(pi, `#!/bin/sh\nexec '${process.execPath}' '${join(LOOP, "test/fake-kernel-pi.mjs")}' "$@"\n`, { mode: 0o755 });
  writeFileSync(ponytail, "export default function() {}\n");
  Object.assign(process.env, { PI_BIN: pi, PI_CODING_AGENT_DIR: agent, PONYTAIL_EXTENSION: ponytail,
    AUTOREVIEW_REVIEWER_CMD: join(LOOP, "test/fake-reviewer.mjs"), FAKE_MODE: "pass-after-1", FAKE_STATE_DIR: join(f.root, "reviewer") });
}

test("真实 bin/loop→pi-dev→Pi适配替身→原会话返修→dev发布→隐藏 worktree 释放", async () => {
  const f = fixture(); let path: string | undefined;
  try {
    const nested = join(...Array.from({ length: 6 }, (_, i) => `${i}-long-path-with-spaces-${"a".repeat(45)}`), "中文提示词.md");
    mkdirSync(dirname(join(f.repo, nested)), { recursive: true }); writeFileSync(join(f.repo, nested), "# 完整长路径提示词\n");
    f.card.tasks[0].prompt = nested; writeFileSync(f.file, JSON.stringify(f.card)); f.git(f.repo, "add", "."); f.git(f.repo, "commit", "-qm", "long path fixture");
    fakeLauncher(f);
    const cli = spawnSync(join(LOOP, "bin/loop"), ["启动", f.file, "--json"], { cwd: f.repo, env: process.env, encoding: "utf8", timeout: 30_000 });
    assert.equal(cli.status, 0, `${cli.stdout}\n${cli.stderr}`);
    const result = JSON.parse(cli.stdout); path = result.ledger; assert.ok(path);
    await waitFor(() => readRun(path!).release.status === "已释放", `发布/释放完成；${readRun(path!).stopReason}`);
    const run = readRun(path!); assert.equal(run.publication!.push, "成功"); assert.equal(run.session!.id, "fake-original-session");
    assert.equal(run.repairs, 1); assert.ok(existsSync(join(run.dir, "repair-1.json"))); assert.equal(existsSync(run.worktree), false); assert.equal(existsSync(dirname(run.worktree)), false, "本批隐藏父目录也按登记释放");
    assert.ok(f.git(f.repo, "show-ref", run.branch)); assert.ok(f.git(f.repo, "show-ref", run.publication!.history));
    assert.equal(f.git(f.repo, "worktree", "list", "--porcelain").includes(run.worktree), false);
    assert.equal(f.git(f.origin, "for-each-ref", "--format=%(refname)"), "refs/heads/dev");
    const argv = JSON.parse(readFileSync(join(run.dir, "host-argv.json"), "utf8")); assert.ok(argv.includes(`@${run.card.tasks[0].prompt}`));
    await waitFor(() => !run.supervisor || ownedProcessGroupAlive(run.supervisor) === false, "本批启动器已结束");
    const status = spawnSync(join(LOOP, "bin/loop"), ["查询", f.file, "--json"], { cwd: f.repo, env: process.env, encoding: "utf8" });
    assert.equal(JSON.parse(status.stdout).status, "已合入");
  } finally { if (path && existsSync(path)) await stopKernel(path); f.cleanup(); }
});

test("新卡会话空闲不报 running；CLI 停止与查询一致；启动失败可恢复且不清零次数", async () => {
  const f = fixture(["开发评审"]); let path: string | undefined;
  try {
    fakeLauncher(f); process.env.KERNEL_FAKE_ACTION = "idle";
    const cli = spawnSync(join(LOOP, "bin/loop"), ["启动", f.file, "--json"], { cwd: f.repo, env: process.env, encoding: "utf8" });
    assert.equal(cli.status, 0, cli.stderr); path = JSON.parse(cli.stdout).ledger;
    await waitFor(() => !!readRun(path!).session, "宿主已登记");
    assert.equal(queryKernel(path!).status, "等你决定", "空闲会话存活不是节点执行");
    const stopped = spawnSync(join(LOOP, "bin/loop"), ["停止", f.file, "--json"], { cwd: f.repo, env: process.env, encoding: "utf8" });
    assert.equal(stopped.status, 0, stopped.stdout + stopped.stderr); assert.equal(JSON.parse(stopped.stdout).status, "等你决定");
    assert.equal(existsSync(readRun(path!).worktree), true);
    const launch = managedLaunchArgs(path!); assert.ok(launch.args.includes(readRun(path!).session!.log!));
    updateRun(path!, (r) => { r.repairs = 3; });
    process.env.PI_BIN = join(f.root, "missing-pi");
    const resumed = spawnSync(join(LOOP, "bin/loop"), ["续跑", f.file, "--json"], { cwd: f.repo, env: process.env, encoding: "utf8" });
    assert.equal(resumed.status, 0, resumed.stdout + resumed.stderr);
    await waitFor(() => !!readRun(path!).stopReason?.includes("启动失败"), "启动失败已登记");
    assert.equal(queryKernel(path!).status, "等你决定"); assert.equal(readRun(path!).repairs, 3);
    assert.match(readRun(path!).stopReason!, /续跑/);
    Object.assign(process.env, { PI_BIN: join(f.root, "fake-pi"), KERNEL_FAKE_ACTION: "no-ack", AUTOREVIEW_KERNEL_STARTUP_TIMEOUT_MS: "100" });
    const retry = spawnSync(join(LOOP, "bin/loop"), ["续跑", f.file, "--json"], { cwd: f.repo, env: process.env, encoding: "utf8" });
    assert.equal(retry.status, 0, retry.stdout + retry.stderr);
    await waitFor(() => !!readRun(path!).stopReason?.includes("未获宿主确认"), "宿主未确认时有界失败");
    assert.equal(queryKernel(path!).status, "等你决定"); assert.equal(readRun(path!).repairs, 3);
  } finally { if (path && existsSync(path)) await stopKernel(path); f.cleanup(); }
});

test("资源保护：未登记忽略文件、未提交成果、本机文件变化都不强删", async (t) => {
  for (const kind of ["unknown", "dirty", "local", "parent"]) await t.test(kind, async () => {
    const f = fixture(["开发评审"]);
    try {
      const path = f.start(), run = readRun(path); writeFileSync(join(run.worktree, "file.txt"), "done\n");
      await completeManagedDelivery(path, "【交付完成】", { exec: f.exec, callReviewer: reviewer() }); await mergeManaged(path);
      if (kind === "unknown") writeFileSync(join(run.worktree, "unknown.txt"), "owned by someone else");
      if (kind === "dirty") writeFileSync(join(run.worktree, "file.txt"), "unsaved work");
      if (kind === "local") writeFileSync(join(run.worktree, "local.txt"), "changed local");
      const unknownParent = join(dirname(run.worktree), "unknown-parent-file.txt");
      if (kind === "parent") writeFileSync(unknownParent, "unknown owner");
      await releaseKernelWorkspace(path); assert.equal(readRun(path).release.status, "未确认"); assert.equal(existsSync(run.worktree), kind !== "parent");
      if (kind === "parent") assert.equal(readFileSync(unknownParent, "utf8"), "unknown owner", "只释放本批空目录，不递归删未知内容");
    } finally { f.cleanup(); }
  });
});

test("新卡 Claude/Codex Hook 实际入口：程序提交、原会话 block 返修、共享状态，无旧验收/队列", async (t) => {
  for (const host of ["claude", "codex"] as const) await t.test(host, async () => {
    const f = fixture(["开发评审"]);
    try {
      const path = f.start(), run = readRun(path);
      Object.assign(process.env, { AUTOREVIEW_KERNEL_LEDGER: path, AUTOREVIEW_KERNEL_RUN: run.id, AUTOREVIEW_DEV_ROOT: run.worktree, AUTOREVIEW_HOST: host,
        AUTOREVIEW_REVIEWER_CMD: join(LOOP, "test/fake-reviewer.mjs"), FAKE_MODE: "pass-after-1", FAKE_STATE_DIR: join(f.root, "reviewer") });
      const event = { cwd: run.worktree, session_id: "original-host-session" };
      await handleReviewEvent({ ...event, hook_event_name: "SessionStart" });
      await handleReviewEvent({ ...event, hook_event_name: "UserPromptSubmit", prompt: `请读取并执行 @"${run.card.tasks[0].prompt}"` });
      writeFileSync(join(run.worktree, "file.txt"), "first\n");
      const first = JSON.parse((await handleReviewEvent({ ...event, hook_event_name: "Stop", last_assistant_message: "【交付完成】" }))!);
      assert.equal(first.decision, "block"); assert.match(first.reason, /自动评审/);
      writeFileSync(join(run.worktree, "file.txt"), "fixed\n");
      const second = JSON.parse((await handleReviewEvent({ ...event, hook_event_name: "Stop", last_assistant_message: "【交付完成】" }))!);
      assert.match(second.hookSpecificOutput.additionalContext, /可合入/); assert.equal(queryKernel(path).status, "可合入");
      assert.equal(readRun(path).repairs, 1); assert.equal(readRun(path).session!.id, event.session_id);
      assert.equal(f.git(run.worktree, "rev-list", "--count", `${f.base}..HEAD`), "2"); assert.equal(f.git(f.repo, "rev-parse", "HEAD"), f.base);
      assert.equal(existsSync(join(f.root, "queues")), false);
    } finally { f.cleanup(); }
  });
});

test("旧单会话保护：新 single-node 标志不执行配置验收/accept-cmd，也不自动提交用户文件", async () => {
  const old = process.env.AUTOREVIEW_SINGLE_NODE; process.env.AUTOREVIEW_SINGLE_NODE = "1";
  const h = piHarness({ flags: { "autoreview-accept-cmd": "exit 99" } });
  try {
    h.write(".autoreview.json", JSON.stringify({ acceptance: { start: "exit 99", timeoutMin: 999 } }));
    await h.event("session_start"); await h.begin();
    const head = h.git("rev-parse", "HEAD"); h.write("file.txt", "done\n"); h.assistant(); await h.event("agent_settled"); await h.terminal();
    assert.equal(h.state().phase, "done"); assert.equal(h.accepts.length, 0); assert.equal(h.git("rev-parse", "HEAD"), head);
    assert.match(h.summary(), /验收：没验证（本次未安排）/);
  } finally { await h.close(); if (old === undefined) delete process.env.AUTOREVIEW_SINGLE_NODE; else process.env.AUTOREVIEW_SINGLE_NODE = old; }
});

test("旧尝试迟到不覆盖新活动或新输入；没有释放证明的评审不能通过", async () => {
  const f = fixture(["开发评审"]);
  try {
    const path = f.start(), run = readRun(path); writeFileSync(join(run.worktree, "file.txt"), "candidate\n"); updateRun(path, (r) => { r.candidate = deliverCandidate(r); });
    let release!: () => void; const waiting = new Promise<void>((ok) => { release = ok; });
    const work = executeNode(path, "开发评审", async (input) => { await waiting; return { status: "通过", evidence: [input.evidenceDir], operations: ["替身迟到"], released: true }; });
    await waitFor(() => !!readRun(path).activity, "第一次执行已登记");
    updateRun(path, (r) => { r.userVersion++; r.activity = { id: "new-attempt", node: "开发评审", kind: "developing", pid: process.pid, started: r.activity!.started }; });
    release(); const result = await work; assert.equal(result.status, "中断"); assert.equal(readRun(path).activity!.id, "new-attempt");
    assert.equal(readRun(path).results[0].status, "中断");
    updateRun(path, (r) => { r.activity = undefined; });
    const noProof = await completeManagedDelivery(path, "【交付完成】", { exec: f.exec, callReviewer: async () => ({ stdout: PASS, code: 0, stderr: "", killed: false }) });
    assert.equal(noProof.status, "没验证"); assert.match(noProof.reason!, /释放未确认/);
  } finally { f.cleanup(); }
});

test("新卡无需手动提交卡：目标无交集的用户暂存、未暂存、未跟踪内容原样保留", async () => {
  const f = fixture();
  try {
    const file = join(f.repo, "新开发卡.json"); writeFileSync(file, JSON.stringify(f.card));
    const path = createKernelRun(file, f.repo).path, run = readRun(path);
    writeFileSync(join(f.repo, "prompt.md"), "user staged\n"); f.git(f.repo, "add", "prompt.md");
    writeFileSync(join(f.repo, "prompt.md"), "user working\n"); writeFileSync(join(f.repo, "用户资料.txt"), "user untracked\n");
    const before = f.git(f.repo, "status", "--porcelain"), staged = f.git(f.repo, "show", ":prompt.md");
    // 提示词是检查输入：用户在启动后更新输入，按当前版本首次评审，不借用旧结果。
    writeFileSync(join(run.worktree, "file.txt"), "new code\n");
    const result = await completeManagedDelivery(path, "【交付完成】", { exec: f.exec, callReviewer: reviewer() });
    assert.equal(result.status, "通过", result.reason); assert.equal(readRun(path).publication!.push, "成功", readRun(path).publication!.reason);
    assert.equal(f.git(f.repo, "status", "--porcelain"), before); assert.equal(f.git(f.repo, "show", ":prompt.md"), staged);
    assert.equal(readFileSync(join(f.repo, "prompt.md"), "utf8"), "user working\n"); assert.equal(readFileSync(join(f.repo, "用户资料.txt"), "utf8"), "user untracked\n");
    assert.equal(f.git(f.repo, "show", "HEAD:file.txt"), "new code");
  } finally { f.cleanup(); }
});

test("用户文件标准也绑定输入；输入更新重送全文；直接删除卡仍由同一内核查询且无副作用", async () => {
  const f = fixture(["开发评审"]);
  try {
    const path = f.start(), run = readRun(path); writeFileSync(join(run.worktree, "file.txt"), "code\n");
    await completeManagedDelivery(path, "【交付完成】", { exec: f.exec, callReviewer: reviewer() });
    const need = join(f.root, "用户新标准.md"); writeFileSync(need, "NEW_CRITERIA_V2\n合入本批\n");
    assert.equal(recordManagedUserInput(path, `@${need}`, "pi:interactive", expandFileRefsWithSources(`@${need}`, run.worktree)), undefined);
    assert.equal(readRun(path).decisions.length, 0); assert.equal(queryKernel(path).status, "等你决定");
    await completeManagedDelivery(path, "【交付完成】", { exec: f.exec, callReviewer: async (_s, _r, _t, input) => {
      assert.match(readFileSync(input, "utf8"), /NEW_CRITERIA_V2/); return reviewer()();
    } });
    assert.equal(queryKernel(path).status, "可合入"); writeFileSync(need, "NEW_CRITERIA_V3"); assert.equal(queryKernel(path).status, "等你决定");
    const ledger = readFileSync(path, "utf8"); rmSync(f.file);
    const query = spawnSync(join(LOOP, "bin/loop"), ["查询", f.file, "--json"], { cwd: f.repo, env: process.env, encoding: "utf8" });
    assert.equal(query.status, 0, query.stdout + query.stderr); const q = JSON.parse(query.stdout); assert.equal(q.id, run.id); assert.match(q.reason, /开发卡/);
    assert.equal(readFileSync(path, "utf8"), ledger);
  } finally { f.cleanup(); }
});

test("生产 Hook 新卡指路/校验复用只读解析，不开工、不调用旧批次；索引隐藏标志拒绝", async () => {
  const f = fixture(["开发评审"]);
  try {
    const action = productionAction({ paths: [f.file] }, f.repo)!; assert.equal(action.files[0].kind, "card");
    assert.deepEqual(await validateProductionFile(action.files[0]), []); assert.equal(existsSync(join(f.root, "kernel")), false);
    const path = f.start(), run = readRun(path); f.git(run.worktree, "update-index", "--assume-unchanged", "file.txt");
    writeFileSync(join(run.worktree, "file.txt"), "hidden change\n"); assert.throws(() => deliverCandidate(readRun(path)), /索引含/);
  } finally { f.cleanup(); }
});

test("返修1：例外决定绑定完整输入和用户版本；撤回/换标准后原决定保留但所有入口拒绝复用", async (t) => {
  for (const change of ["撤回", "新标准", "文件变化"]) await t.test(change, async () => {
    const f = fixture(["开发评审"]);
    try {
      const path = f.start(), run = readRun(path); writeFileSync(join(run.worktree, "file.txt"), "candidate\n");
      updateRun(path, (r) => { r.candidate = deliverCandidate(r); });
      const first = recordManagedUserInput(path, "合入本批", "pi:interactive")!;
      assert.equal(typeof first.inputs, "string"); assert.equal(first.userVersion, 0);
      writeFileSync(join(f.repo, "file.txt"), "dirty target\n");
      assert.equal((await mergeManaged(path, { accept: true, decision: first })).status, "没验证");
      writeFileSync(join(f.repo, "file.txt"), "base\n");
      if (change === "文件变化") writeFileSync(join(f.repo, "prompt.md"), "updated requirement\n");
      else recordManagedUserInput(path, change === "撤回" ? "撤回先前合入决定，不再同意按现状合入" : "## 验收标准\nA1. 新标准", "pi:interactive");
      assert.equal(readRun(path).decisions[0].id, first.id);
      await assert.rejects(() => mergeManaged(path, { accept: true, decision: first }), /真实用户决定/);
      const cli = spawnSync(join(LOOP, "bin/loop"), ["合入", f.file, "--接受未验证", "--json"], { cwd: f.repo, env: process.env, encoding: "utf8" });
      assert.notEqual(cli.status, 0); assert.match(JSON.parse(cli.stdout).error, /真实用户决定/);
      const direct = await executeNode(path, "提交", (i) => submitCandidate(i, first));
      assert.equal(direct.status, "没验证"); assert.match(direct.reason!, /决定已过期/); assert.equal(readRun(path).publication, undefined);
      const fresh = recordManagedUserInput(path, "合入本批", "pi:interactive")!;
      assert.notEqual(fresh.id, first.id); assert.notEqual(fresh.inputs, first.inputs);
      const published = await mergeManaged(path, { accept: true, decision: fresh }); assert.equal(published.status, "通过", published.reason);
      assert.equal(readRun(path).publication!.decision, fresh.id); assert.equal(readRun(path).decisions.length, 2);
    } finally { f.cleanup(); }
  });
});

test("返修2/3：实际 Claude/Codex Hook 引用外部标准后变更拒绝合入；再次引用原提示词并追加标准不能漏记", async (t) => {
  for (const host of ["claude", "codex"] as const) await t.test(host, async () => {
    const f = fixture(["开发评审"]);
    try {
      const path = f.start(), run = readRun(path), need = join(f.root, "外部 标准.md"); writeFileSync(need, "EXTERNAL_CRITERIA_V1\n");
      Object.assign(process.env, { AUTOREVIEW_KERNEL_LEDGER: path, AUTOREVIEW_KERNEL_RUN: run.id, AUTOREVIEW_DEV_ROOT: run.worktree, AUTOREVIEW_HOST: host,
        AUTOREVIEW_REVIEWER_CMD: join(LOOP, "test/fake-reviewer.mjs"), FAKE_MODE: "pass", FAKE_STATE_DIR: join(f.root, "reviewer") });
      const event = { cwd: run.worktree, session_id: "original-host-session" };
      await handleReviewEvent({ ...event, hook_event_name: "SessionStart" });
      await handleReviewEvent({ ...event, hook_event_name: "UserPromptSubmit", prompt: `@"${need}"` });
      writeFileSync(join(run.worktree, "file.txt"), "code\n");
      await handleReviewEvent({ ...event, hook_event_name: "Stop", last_assistant_message: "【交付完成】" });
      assert.equal(queryKernel(path).status, "可合入"); assert.ok(readRun(path).userFiles!.includes(need));
      const first = readRun(path).results[0], version = readRun(path).userVersion, commit = readRun(path).candidate!.commit;
      writeFileSync(need, "EXTERNAL_CRITERIA_V2\n");
      assert.equal(queryKernel(path).status, "等你决定"); await assert.rejects(() => mergeManaged(path), /普通合入被拒绝/);
      await handleReviewEvent({ ...event, hook_event_name: "UserPromptSubmit", prompt: `@"${run.card.tasks[0].prompt}" @"${need}"\n## 验收标准\nA1. NEW_APPENDED_CRITERIA` });
      assert.equal(readRun(path).userVersion, version + 1); assert.match(queryKernel(path).missing.join("\n"), /缺少/);
      await handleReviewEvent({ ...event, hook_event_name: "Stop", last_assistant_message: "【交付完成】" });
      const last = readRun(path).results.at(-1)!; assert.notEqual(last.id, first.id); assert.notEqual(last.inputs, first.inputs);
      assert.equal(readRun(path).candidate!.commit, commit, "同树重评审不造空提交");
      const input = last.evidence.find((p) => p.endsWith("/input.md"))!;
      assert.match(readFileSync(input, "utf8"), /NEW_APPENDED_CRITERIA/); assert.match(readFileSync(input, "utf8"), /EXTERNAL_CRITERIA_V2/);
      assert.equal(queryKernel(path).status, "可合入");
    } finally { f.cleanup(); }
  });
});

test("引用快照：实际 Hook 仅续跑交付不重新引用时拒绝 V1 检查绑定 V2；历史通过保留", async (t) => {
  for (const host of ["claude", "codex"] as const) await t.test(host, async () => {
    const f = fixture(["开发评审"]);
    try {
      const path = f.start(), run = readRun(path), need = join(f.root, "外部 标准.md"); writeFileSync(need, "CONFIRMED_REFERENCE_V1\n");
      Object.assign(process.env, { AUTOREVIEW_KERNEL_LEDGER: path, AUTOREVIEW_KERNEL_RUN: run.id, AUTOREVIEW_DEV_ROOT: run.worktree, AUTOREVIEW_HOST: host,
        AUTOREVIEW_REVIEWER_CMD: join(LOOP, "test/fake-reviewer.mjs"), FAKE_MODE: "pass", FAKE_STATE_DIR: join(f.root, "reviewer") });
      const event = { cwd: run.worktree, session_id: "original-host-session" };
      await handleReviewEvent({ ...event, hook_event_name: "SessionStart" });
      await handleReviewEvent({ ...event, hook_event_name: "UserPromptSubmit", prompt: `@"${need}"` });
      writeFileSync(join(run.worktree, "file.txt"), "code\n");
      await handleReviewEvent({ ...event, hook_event_name: "Stop", last_assistant_message: "【交付完成】" });
      assert.equal(queryKernel(path).status, "可合入");
      const first = readRun(path).results[0], confirmed = readRun(path).userFileVersions![need], candidate = readRun(path).candidate!;
      assert.equal(typeof confirmed, "string"); assert.match(readRun(path).userInputs[0], /CONFIRMED_REFERENCE_V1/);
      writeFileSync(need, "UNCONFIRMED_REFERENCE_V2\n");
      await handleReviewEvent({ ...event, hook_event_name: "SessionStart", source: "resume" });
      const resumed = await handleReviewEvent({ ...event, hook_event_name: "UserPromptSubmit", prompt: "继续，按原任务交付" });
      assert.match(resumed!, /重新引用/);
      const delivered = await handleReviewEvent({ ...event, hook_event_name: "Stop", last_assistant_message: "【交付完成】" });
      assert.match(delivered!, /仅续跑不会自动采用新标准/);
      const current = readRun(path); assert.equal(current.results.length, 1); assert.equal(current.results[0].id, first.id);
      assert.equal(current.results[0].status, "通过", "历史 V1 结论不改写"); assert.deepEqual(current.candidate, candidate);
      assert.equal(current.userFileVersions![need], confirmed); assert.equal(current.repairs, 0);
      assert.equal(readFileSync(join(f.root, "reviewer/count"), "utf8"), "1", "不能把 V1 展开文本送去重审并登记到 V2");
      assert.throws(() => checkInputs(current), /重新引用/); assert.equal(queryKernel(path).status, "等你决定");
      await assert.rejects(() => mergeManaged(path), /普通合入被拒绝/); assert.equal(readRun(path).publication, undefined);
      await assert.rejects(async () => recordManagedUserInput(path, "合入本批", `${host}:UserPromptSubmit`), /检查输入无法冻结/);
    } finally { f.cleanup(); }
  });
});

test("引用快照：展开后登记前文件已变更也不得混用版本；旧记录缺少确认身份时保守拒绝", () => {
  const f = fixture(["开发评审"]);
  try {
    const path = f.start(), run = readRun(path), need = join(f.root, "标准.md"); writeFileSync(need, "SNAPSHOT_V1\n");
    const raw = `@${need}`, material = expandFileRefsWithSources(raw, run.worktree);
    writeFileSync(need, "SNAPSHOT_V2\n"); recordManagedUserInput(path, raw, "pi:interactive", material);
    assert.throws(() => checkInputs(readRun(path)), /重新引用/); assert.equal(readRun(path).results.length, 0);
    recordManagedUserInput(path, raw, "pi:interactive", expandFileRefsWithSources(raw, run.worktree));
    assert.doesNotThrow(() => checkInputs(readRun(path)), "真实用户重新引用后可核对当前版本");
    updateRun(path, (r) => { delete r.userFileVersions; });
    assert.throws(() => checkInputs(readRun(path)), /缺少确认快照/);
  } finally { f.cleanup(); }
});

test("返修4：修改已登记 guide 的真实 Git 合入/推送不使自身输入失效；非候选外部改写仍失效", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.repo, "README.md"), "old guide\n");
    const config = JSON.parse(readFileSync(join(f.repo, ".autoreview.json"), "utf8"));
    config.context = { sources: [{ id: "guide", path: "README.md", role: "guide" }] };
    writeFileSync(join(f.repo, ".autoreview.json"), JSON.stringify(config));
    f.card.tasks[0].scope = ["file.txt", "README.md"]; writeFileSync(f.file, JSON.stringify(f.card));
    f.git(f.repo, "add", "."); f.git(f.repo, "commit", "-qm", "guide fixture");
    const path = f.start(), run = readRun(path), guide = join(f.repo, "README.md");
    const reference = `@"${guide}"`;
    recordManagedUserInput(path, reference, "pi:interactive", expandFileRefsWithSources(reference, run.worktree));
    assert.ok(readRun(path).userFileVersions![guide], "该用例须实际登记带空格路径的用户引用");
    writeFileSync(join(run.worktree, "README.md"), "checked new guide\n");
    const output = await completeManagedDelivery(path, "【交付完成】", { exec: f.exec, callReviewer: reviewer() });
    assert.equal(output.status, "通过", output.reason);
    const publication = readRun(path).publication!; assert.equal(publication.local, "merged"); assert.equal(publication.push, "成功", publication.reason);
    assert.equal(readFileSync(join(f.repo, "README.md"), "utf8"), "checked new guide\n");
    const after = checkInputs(readRun(path)); assert.equal(after.hash, publication.inputs); assert.ok(after.publicationChanges.includes(join(f.repo, "README.md")));
    assert.ok(readRun(path).results.every((r) => r.status === "通过")); assert.equal(f.git(f.origin, "rev-parse", "dev"), publication.commit);
    writeFileSync(join(f.repo, "README.md"), "external authority change\n");
    assert.throws(() => checkInputs(readRun(path)), /重新引用/, "只归一化已发布树的更新，不静默采用外部变更的引用内容");
  } finally { f.cleanup(); }
});

test("返修5：目标前进后统一整合 dev，scope 不扩张，新树重新评审后完成合入/推送", async () => {
  const f = fixture();
  try {
    const path = f.start(), run = readRun(path); writeFileSync(join(run.worktree, "file.txt"), "task change\n");
    writeFileSync(join(f.repo, "target.txt"), "incoming dev\n"); f.git(f.repo, "add", "target.txt"); f.git(f.repo, "commit", "-qm", "dev advances");
    const target = f.git(f.repo, "rev-parse", "HEAD"); let calls = 0;
    const options = { exec: f.exec, callReviewer: async () => { calls++; return reviewer()(); } };
    await completeManagedDelivery(path, "【交付完成】", options);
    assert.equal(queryKernel(path).status, "等你决定"); assert.equal(readRun(path).publication, undefined);
    assert.match(readRun(path).stopReason!, /整合/); const oldTree = readRun(path).candidate!.tree;
    const integrated = spawnSync(join(LOOP, "bin/loop"), ["整合", f.file, "--json"], { cwd: f.repo, env: process.env, encoding: "utf8" });
    assert.equal(integrated.status, 0, integrated.stdout + integrated.stderr);
    const after = readRun(path), integration = after.integrations!.at(-1)!;
    assert.equal(after.base, f.base); assert.deepEqual(after.card.tasks[0].scope, { allow: ["file.txt"] });
    assert.equal(integration.target.commit, target); assert.equal(integration.scopeBase, target); assert.ok(integration.imported.includes("target.txt"));
    assert.notEqual(after.candidate!.tree, oldTree); assert.equal(queryKernel(path).status, "等你决定");
    await assert.rejects(() => mergeManaged(path), /普通合入被拒绝/);
    const second = await completeManagedDelivery(path, "【交付完成】", options); assert.equal(second.status, "通过", second.reason);
    assert.equal(calls, 2, "新树不得复用旧树通过"); assert.equal(readRun(path).candidate!.commit, integration.candidate.commit, "整合完成后的交付不造空提交");
    assert.equal(readRun(path).publication!.push, "成功", readRun(path).publication!.reason); assert.equal(readRun(path).repairs, 0);
    assert.equal(f.git(f.repo, "show", "HEAD:target.txt"), "incoming dev"); assert.equal(f.git(f.repo, "show", "HEAD:file.txt"), "task change");
    assert.equal(f.git(f.origin, "rev-parse", "dev"), readRun(path).publication!.commit);
  } finally { f.cleanup(); }
});

test("返修5反例：整合目标不能洗白真正越界提交，即使越界内容碰巧与 dev 相同", async (t) => {
  for (const forged of [false, true]) await t.test(forged ? "先越界伪造目标文件" : "无关越界文件", async () => {
    const f = fixture(["开发评审"]);
    try {
      const path = f.start(), run = readRun(path); writeFileSync(join(run.worktree, "file.txt"), "task change\n");
      await completeManagedDelivery(path, "【交付完成】", { exec: f.exec, callReviewer: reviewer() });
      writeFileSync(join(f.repo, "target.txt"), "incoming dev\n"); f.git(f.repo, "add", "target.txt"); f.git(f.repo, "commit", "-qm", "dev advances");
      const bad = forged ? "target.txt" : "bad.txt"; writeFileSync(join(run.worktree, bad), forged ? "incoming dev\n" : "unauthorized\n");
      f.git(run.worktree, "add", bad); f.git(run.worktree, "commit", "-qm", "unowned outside change");
      f.git(run.worktree, "merge", "--no-edit", "dev"); const head = f.git(run.worktree, "rev-parse", "HEAD");
      const result = await completeManagedDelivery(path, "【交付完成】", { exec: f.exec, callReviewer: async () => { assert.fail("越界不能进入评审"); } });
      assert.equal(result.status, "中断"); assert.match(result.reason!, /范围外变更/); assert.ok(result.reason!.includes(bad));
      assert.equal(f.git(run.worktree, "rev-parse", "HEAD"), head); assert.equal(readRun(path).results.length, 1); assert.equal(readRun(path).publication, undefined);
    } finally { f.cleanup(); }
  });
});

test("真实 PTY 例外入口：中文确认可解码、取消不授权、等待确认期间改标准须重新确认", () => {
  const driver = String.raw`
import os, pty, re, select, signal, sys, time, json
pid, fd = pty.fork()
if pid == 0:
    os.execv(sys.argv[1], [sys.argv[1], "合入", sys.argv[2], "--接受未验证", "--json"])
data = b""
sent = False
done = False
status = None
deadline = time.monotonic() + 20
try:
    while time.monotonic() < deadline:
        ready, _, _ = select.select([fd], [], [], 0.1)
        if ready:
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                chunk = b""
            if not chunk:
                _, status = os.waitpid(pid, 0)
                done = True
                break
            data += chunk
        match = re.search("请输入「合入 ([0-9a-f]{8})」".encode("utf-8"), data)
        if match and not sent:
            if sys.argv[3] == "race":
                with open(sys.argv[4], "w") as f:
                    f.write("changed while waiting for confirmation\n")
            reply = ("取消" if sys.argv[3] == "cancel" else "合入 " + match.group(1).decode()) + "\n"
            os.write(fd, reply.encode("utf-8"))
            sent = True
        waited, state = os.waitpid(pid, os.WNOHANG)
        if waited:
            status = state
            done = True
            break
finally:
    if not done:
        os.killpg(pid, signal.SIGKILL)
        _, status = os.waitpid(pid, 0)
    os.close(fd)
print(json.dumps({"sent": sent, "timeout": not done, "code": os.waitstatus_to_exitcode(status), "transcript": data.decode("utf-8", errors="replace")}))
`;
  for (const mode of ["confirm", "cancel", "race"]) {
    const f = fixture(["开发评审"]);
    try {
      const path = f.start(), run = readRun(path); writeFileSync(join(run.worktree, "file.txt"), "unreviewed candidate\n");
      updateRun(path, (r) => { r.candidate = deliverCandidate(r); r.stopped = true; });
      const result = spawnSync("python3", ["-c", driver, join(LOOP, "bin/loop"), f.file, mode, join(f.repo, "prompt.md")], { cwd: f.repo, env: process.env, encoding: "utf8", timeout: 30_000 });
      assert.equal(result.status, 0, result.stderr || result.stdout); const actual = JSON.parse(result.stdout);
      assert.equal(actual.timeout, false, actual.transcript); assert.equal(actual.sent, true, actual.transcript);
      assert.equal(actual.code, mode === "confirm" ? 0 : 1, actual.transcript);
      const current = readRun(path);
      if (mode === "confirm") {
        assert.equal(current.publication!.push, "成功"); assert.equal(current.decisions[0].source, "terminal:tty");
        assert.match(current.decisions[0].text, /^合入 [0-9a-f]{8}$/); assert.equal(current.decisions[0].candidate.commit, current.candidate!.commit);
        assert.ok(current.decisions[0].missing.length); assert.equal(current.results.some((r) => r.node === "开发评审" && r.status === "通过"), false);
      } else { assert.equal(current.publication, undefined); assert.equal(current.decisions.length, 0); }
    } finally { f.cleanup(); }
  }
});
