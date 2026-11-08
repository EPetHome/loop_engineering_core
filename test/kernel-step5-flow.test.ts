import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import childProcess, { spawn, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";
import { fakeKernelLauncher, kernelFixture, reviewer } from "./helpers/kernel-fixture.ts";
import kernelPi from "../kernel-pi.ts";
import { kernelCLI } from "../kernel-cli.ts";
import { launchKernel, managedLaunchArgs, resumeManaged, resumeTerminalTasks, stopKernel } from "../kernel-runtime.ts";
import { advanceManaged, attachSession, completeManagedDelivery, developerActive, managedDeliveryIntent, managedMarker, mergeManaged, pauseManaged, prepareManagedContinuation } from "../kernel-session.ts";
import { deliverCandidate, managedConfig } from "../kernel-workspace.ts";
import { executeNode, queryKernel } from "../kernel.ts";
import { readRun, readTaskRun, updateRun, updateTaskRun } from "../node-ledger.ts";
import { createChildExec, handleReviewEvent } from "../hosts/review-hook.ts";
import { runTestNode } from "../test-node.ts";
import { acquireLocalSlot, localQueueRoot, readLocalQueue, recoverLocalQueue, releaseLocalSlot } from "../local-node-queue.ts";
import { parseArgs } from "../loop.ts";
import { releaseTestWorkspace } from "../test-workspace.ts";
import { createRunResource, releaseRunResource } from "../resources.ts";
import { fileDigest } from "../kernel-workspace.ts";
import { randomUUID } from "node:crypto";
import { checkInputs } from "../kernel-workspace.ts";
import { requestCardChange } from "../kernel-controls.ts";
import { ownedProcessGroupAlive, processStartTime, readProcs, registerProc, releaseProc } from "../procs.ts";
function finishFixture(f: ReturnType<typeof kernelFixture>) {
  if (process.env.LOOP_STEP5_EVIDENCE && existsSync(join(f.root, "kernel"))) {
    const target = join(process.env.LOOP_STEP5_EVIDENCE, randomUUID()); mkdirSync(target, { recursive: true });
    cpSync(join(f.root, "kernel"), join(target, "kernel"), { recursive: true });
  }
  f.cleanup();
}

async function until(check: () => boolean, label: string) {
  const end = Date.now() + 15000;
  while (!check() && Date.now() < end) await sleep(20);
  assert.ok(check(), label);
}
function multi(f: ReturnType<typeof kernelFixture>) {
  const config = JSON.parse(readFileSync(join(f.repo, ".autoreview.json"), "utf8")); config.acceptance = { reset: "printf reset", cleanup: "printf released" };
  writeFileSync(join(f.repo, ".autoreview.json"), JSON.stringify(config));
  f.card.flow = ["开发评审", "测试", "验收"];
  f.card.tasks = ["甲", "乙"].map((name) => ({ name, prompt: "prompt.md", scope: [`${name}.txt`], test: "printf ok" }));
  f.card.acceptance = "标准.md";
  writeFileSync(join(f.repo, "标准.md"), "## 验收标准\nA1. [甲] 操作：查看甲\n    预期：正确\nA2. [乙] 操作：查看乙\n    预期：正确\n");
  for (const name of ["甲", "乙"]) writeFileSync(join(f.repo, `${name}.txt`), "base");
  writeFileSync(f.file, JSON.stringify(f.card)); f.git(f.repo, "add", "."); f.git(f.repo, "commit", "-qm", "multi");
}
function piAdapter(path: string, exec?: any) {
  const run = readTaskRun(path, process.env.AUTOREVIEW_KERNEL_TASK), events = new Map<string, any>(), commands = new Map<string, any>(), entries: any[] = [];
  const statuses: (string | undefined)[] = [], notifications: string[] = [], widgets: (string[] | undefined)[] = [];
  const ctx: any = { cwd: run.worktree, hasUI: true, mode: "tui", abort() {}, isIdle: () => true,
    sessionManager: { getEntries: () => entries, getSessionId: () => "step5-original", getSessionFile: () => join(run.dir, "session.jsonl") },
    ui: { notify: (text: string) => notifications.push(text), setStatus: (_key: string, text?: string) => statuses.push(text), setWidget: (_key: string, lines?: string[]) => widgets.push(lines) } };
  Object.assign(process.env, { AUTOREVIEW_KERNEL_LEDGER: path, AUTOREVIEW_KERNEL_RUN: run.id });
  kernelPi({ on: (name: string, fn: any) => events.set(name, fn), registerCommand: (name: string, spec: any) => commands.set(name, spec), getCommands: () => [{ name: "ponytail" }], sendMessage() {} } as any, exec);
  return { ctx, statuses, notifications, widgets, entries, event: (name: string, value: any = {}) => events.get(name)?.(value, ctx), command: (name: string) => commands.get(name).handler("", ctx),
    reply: (text: string) => entries.push({ type: "message", message: { role: "assistant", content: [{ type: "text", text }] } }) };
}

test("A1/A2 默认 Pi 单/多任务开窗，JSON 不选择后台；请求去重、部分失败不转后台；解析和查询零 gate 提示", async () => {
  for (const count of [1, 2]) {
    const f = kernelFixture(["开发评审"]);
    try {
      if (count === 2) multi(f);
      const config = JSON.parse(readFileSync(join(f.repo, ".autoreview.json"), "utf8")); config.gate = { arbitrary: true };
      writeFileSync(join(f.repo, ".autoreview.json"), JSON.stringify(config));
      const bin = join(f.root, "bin"); mkdirSync(bin);
      const captures = join(f.root, "terminal-calls.jsonl");
      writeFileSync(join(bin, "osascript"), `#!${process.execPath}\nrequire('fs').appendFileSync(${JSON.stringify(captures)}, JSON.stringify(process.argv.slice(2))+'\\n');\n`, { mode: 0o755 });
      process.env.PATH = `${bin}:${process.env.PATH}`;
      const warnings: string[] = [], original = console.error; console.error = (s) => warnings.push(String(s));
      try {
        for (let i = 0; i < 3; i++) managedConfig(f.repo);
        assert.deepEqual(warnings, []);
        const output = (await kernelCLI(parseArgs(["启动", f.file, "--json"]), f.repo))!;
        assert.equal(output.opened.length, count); assert.equal(output.ok, true, JSON.stringify(output));
        assert.ok(output.tasks.every((t: any) => t.launchMode === "terminal"), "查询投影使用同一账本的开发前后台选择");
        assert.deepEqual(warnings, ["旧 gate 配置已停用；新卡仍按 flow 执行显式测试"]);
        const path = output.ledger, initial = readRun(path);
        for (let i = 0; i < 3; i++) { queryKernel(path); managedConfig(f.repo); }
        const resumed = resumeTerminalTasks(path); assert.equal(resumed.opened.length, 0); assert.equal(resumed.active.length, count);
        assert.equal(readFileSync(captures, "utf8").trim().split("\n").length, count);
        assert.equal(warnings.length, 1); assert.equal(readFileSync(join(f.repo, ".autoreview.json"), "utf8"), JSON.stringify(config));
        const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
        try {
          Object.defineProperty(process, "platform", { value: "linux" });
          await assert.rejects(() => kernelCLI(parseArgs(["启动", f.file, "--json"]), f.repo), /macOS.*background/);
          assert.equal((await kernelCLI(parseArgs(["查询", f.file, "--json"]), f.repo))!.kernel, 1, "其他平台查询不被开窗诊断拦截");
          await kernelCLI(parseArgs(["续跑", f.file, "--launcher", "background", "--dry-run", "--json"]), f.repo);
        } finally { Object.defineProperty(process, "platform", platform); }
        for (const t of initial.taskRecords ?? [initial]) assert.match(readFileSync(t.terminal!.script, "utf8"), /--terminal/);
        if (count === 2) {
          for (const t of initial.taskRecords!) updateTaskRun(path, t.id, (r) => { r.terminal = undefined; });
          let calls = 0;
          const failed = resumeTerminalTasks(path, false, (() => ({ status: ++calls === 1 ? 0 : 1, stderr: "fixture denied" })) as any);
          assert.deepEqual(failed.opened, ["甲"]); assert.equal(failed.ok, false); assert.match(failed.launchErrors[0].reason, /乙.*未转后台/);
          assert.equal(readTaskRun(path, "乙").supervisor, undefined);
        }
      } finally { console.error = original; }
    } finally { finishFixture(f); }
  }
});

test("A1 显式后台不弹窗；可见 argv 不含 print；原会话续跑保留目录、身份与次数", async () => {
  const f = kernelFixture(["开发评审"]); let path: string | undefined;
  try {
    fakeKernelLauncher(f); process.env.KERNEL_FAKE_ACTION = "idle";
    const output = (await kernelCLI(parseArgs(["启动", f.file, "--launcher", "background", "--json"]), f.repo))!; path = output.ledger;
    await until(() => !!readRun(path!).session, "后台宿主已登记");
    const r = readRun(path!); assert.equal(r.terminal, undefined); assert.equal(queryKernel(path!).launchMode, "background");
    const argv = JSON.parse(readFileSync(join(r.dir, "host-argv.json"), "utf8")); assert.ok(argv.includes("-p"));
    assert.ok(!managedLaunchArgs(path!, undefined, true).args.includes("-p"));
    await stopKernel(path!); updateRun(path!, (r) => { r.repairs = 2; r.stopped = false; });
    prepareManagedContinuation(path!); const resumed = readRun(path!), launch = managedLaunchArgs(path!, undefined, true);
    assert.equal(resumed.repairs, 2); assert.equal(resumed.session!.id, r.session!.id); assert.equal(launch.cwd, r.worktree); assert.ok(launch.args.includes(r.session!.log!));
    assert.ok(launch.args.includes(`@${resumed.repair!.file}`));
  } finally { if (path) await stopKernel(path); finishFixture(f); }
});

test("A3 状态实际 setStatus/notify 持续反映外部 worker、排队、停止；关闭/重载释放轮询", async () => {
  const f = kernelFixture(["开发评审"]); let h: ReturnType<typeof piAdapter> | undefined;
  try {
    const path = f.start(); h = piAdapter(path); await h.event("session_start");
    await h.event("before_agent_start", { systemPromptOptions: {} }); assert.ok(h.statuses.at(-1)?.includes("开发"));
    updateRun(path, (r) => { r.activity!.kind = "waiting"; });
    await until(() => h!.statuses.at(-1)?.includes("排队") === true, "外部排队同步原窗口");
    let release!: () => void;
    updateRun(path, (r) => { r.activity = undefined; });
    const execution = executeNode(path, "开发评审", async (i) => { await new Promise<void>((ok) => { release = ok; }); return { status: "通过", evidence: [i.evidenceDir], operations: [], released: true }; });
    await until(() => h!.statuses.at(-1)?.includes("进行中") === true, "评审尚未结束已显示执行中");
    assert.match(h.statuses.at(-1)!, /开发评审/); release(); await execution;
    await until(() => h!.notifications.some((s) => s.includes("流程已完成")), "完成通知同步");
    updateRun(path, (r) => { r.release = { status: "未确认", details: ["模拟释放回执未知"] }; });
    await until(() => h!.statuses.at(-1)?.includes("资源释放未确认") === true, "有效检查不等于资源释放，不能冒称完成");
    assert.equal(queryKernel(path).status, "等你决定");
    updateRun(path, (r) => { r.release = { status: "未释放", details: [] }; }); // 纯 UI 夹具未启动消费者。
    pauseManaged(path, "用户停止，下一步续跑原任务");
    await until(() => h!.widgets.at(-1)?.some((l) => l.includes("用户停止")) === true, "停点原因同步");
    const notices = h.notifications.length; await sleep(550); assert.equal(h.notifications.length, notices, "通知不刷屏");
    await h.event("session_shutdown"); const n = h.statuses.length; assert.equal(h.statuses.at(-1), undefined);
    updateRun(path, (r) => { r.stopReason = "外部变化"; }); await sleep(550); assert.equal(h.statuses.length, n, "关闭后停止监听");
    h = piAdapter(path); await h.event("session_start");
    assert.ok(h.widgets.at(-1)?.some((l) => l.includes("外部变化")), "重载原会话仍显示停点，不自动解停");
    updateRun(path, (r) => { r.stopReason = "重载后的外部变化"; });
    await until(() => h!.widgets.at(-1)?.some((l) => l.includes("重载后的外部变化")) === true, "新生命周期继续同步，旧轮询不复活");
  } finally { await h?.event("session_shutdown"); finishFixture(f); }
});

test("A4 Pi/Hook 实际适配接续开头标记、干净已提交候选及欠检查；普通讨论/决定/停止不误触发", async () => {
  for (const host of ["pi", "claude", "codex"]) for (const mode of ["first", "clean", "pending", "discussion", "decision", "stop"]) {
    const f = kernelFixture(["开发评审", "测试"], "printf ok"); let h: ReturnType<typeof piAdapter> | undefined;
    try {
      fakeKernelLauncher(f);
      const path = f.start(), run = readRun(path);
      Object.assign(process.env, { AUTOREVIEW_KERNEL_LEDGER: path, AUTOREVIEW_KERNEL_RUN: run.id, AUTOREVIEW_DEV_ROOT: run.worktree, AUTOREVIEW_HOST: host });
      if (host === "pi") { h = piAdapter(path, f.exec); await h.event("session_start"); await h.event("before_agent_start", { systemPromptOptions: {} }); }
      else { await handleReviewEvent({ cwd: run.worktree, session_id: "step5-original", hook_event_name: "SessionStart" }); }
      if (h) await h.event("input", { source: "interactive", text: "请按冻结任务开发" });
      else await handleReviewEvent({ cwd: run.worktree, session_id: "step5-original", hook_event_name: "UserPromptSubmit", prompt: "请按冻结任务开发" });
      if (!["discussion", "decision", "stop"].includes(mode)) {
        writeFileSync(join(run.worktree, "file.txt"), "candidate");
        if (mode !== "first") updateRun(path, (r) => { r.candidate = deliverCandidate(r); });
        if (mode === "pending") {
          updateRun(path, (r) => { r.activity = undefined; });
          await executeNode(path, "开发评审", async (i) => ({ status: "通过", evidence: [i.evidenceDir], operations: [], released: true }));
          developerActive(path);
        }
      }
      if (mode === "stop") pauseManaged(path, "用户停止");
      const text = mode === "first" ? "【交付完成】\n实现和自检如下" : mode === "decision" ? "【需要你决定】\n请先确认" : "普通讨论：正文提到【交付完成】不算交付";
      if (h) { h.reply(text); await h.event("agent_before_settle", { outcome: "completed" }); }
      else await handleReviewEvent({ cwd: run.worktree, session_id: "step5-original", hook_event_name: "Stop", last_assistant_message: text });
      const current = readRun(path), should = ["first", "clean", "pending"].includes(mode);
      assert.equal(current.results.some((r) => r.node === "测试" && r.status === "通过"), should, `${host}/${mode}: ${queryKernel(path).reason}`);
      assert.equal(current.results.filter((r) => r.node === "开发评审").length, should ? 1 : 0, `${host}/${mode}`);
      if (!should) assert.match(queryKernel(path).reason, mode === "decision" ? /需要你决定/ : mode === "stop" ? /用户停止/ : /未识别/);
      assert.equal(current.session!.id, "step5-original");
    } finally { await h?.event("session_shutdown"); finishFixture(f); }
  }
});

test("A6 隔离原命令生成 Node 构建及已忽略 Python 缓存；原目录不写入，产物证据/消费者/检出释放", async () => {
  const commands = [
    `node -e "require('fs').mkdirSync('dist',{recursive:true});require('fs').writeFileSync('dist/built.js','module.exports=42');if(require('./dist/built.js')!==42)throw Error('bad')"`,
    `python3 -c 'import cache_input; assert cache_input.VALUE == 42'`,
  ];
  for (const command of commands) {
    const f = kernelFixture(["开发评审", "测试"], command);
    try {
      writeFileSync(join(f.repo, ".gitignore"), ".autoreview.json\nlocal.txt\ndist/\n__pycache__/\n");
      writeFileSync(join(f.repo, "cache_input.py"), "VALUE = 42\n");
      f.git(f.repo, "add", "."); f.git(f.repo, "commit", "-qm", "build inputs");
      const path = f.start(); writeFileSync(join(readRun(path).worktree, "file.txt"), "candidate");
      const output = await completeManagedDelivery(path, "【交付完成】", { exec: f.exec, callReviewer: reviewer });
      assert.equal(output.status, "通过", JSON.stringify(output));
      const run = readRun(path), testResult = run.results.find((r) => r.node === "测试")!;
      const evidence = JSON.parse(readFileSync(testResult.evidence.find((e) => e.endsWith("check-workspace.json"))!, "utf8"));
      assert.equal(evidence.candidate.tree, run.candidate!.tree); assert.equal(evidence.inputs, testResult.inputs);
      const report = JSON.parse(readFileSync(testResult.evidence.find((e) => e.endsWith("test.json"))!, "utf8"));
      assert.equal(evidence.release, "released"); assert.equal(evidence.consumersReleased, true);
      const artifacts = [...evidence.artifacts, ...report.runtimeCache.artifacts]; assert.ok(artifacts.length);
      assert.ok(artifacts.every((a: any) => a.hash && a.path)); assert.ok(evidence.artifacts.every((a: any) => a.rule));
      assert.equal(report.runtimeCache.variable, "PYTHONPYCACHEPREFIX"); assert.equal(report.runtimeCache.release, "released");
      assert.equal(existsSync(report.runtimeCache.path), false); assert.equal(existsSync(evidence.path), false);
      assert.equal(existsSync(join(run.worktree, "dist")), false); assert.equal(existsSync(join(run.worktree, "__pycache__")), false);
      assert.equal(readLocalQueue().items.length, 0); assert.ok(run.testWorkspaces!.every((e) => e.state === "released"));
      assert.equal(report.command, command); assert.equal(report.calls[0].command, command); assert.notEqual(report.calls[0].cwd, run.worktree);
    } finally { finishFixture(f); }
  }
});

test("A6 既有失效 Python 缓存不被误当输入改写；缓存定向到登记资源，越界缓存通道不放行", async () => {
  const command = `python3 -c 'import cache_input; assert cache_input.VALUE == 43'`;
  const f = kernelFixture(["开发评审", "测试"], command);
  try {
    writeFileSync(join(f.repo, ".gitignore"), ".autoreview.json\nlocal.txt\n__pycache__/\n");
    writeFileSync(join(f.repo, "cache_input.py"), "VALUE = 42\n"); f.card.tasks[0].scope.push("cache_input.py");
    writeFileSync(f.file, JSON.stringify(f.card)); f.git(f.repo, "add", "."); f.git(f.repo, "commit", "-qm", "python cache fixture");
    const path = f.start(), run = readRun(path);
    const cached = spawnSync("python3", ["-c", "import cache_input"], { cwd: run.worktree, encoding: "utf8", env: { ...process.env, PYTHONPYCACHEPREFIX: "" } });
    assert.equal(cached.status, 0, cached.stderr);
    const file = join(run.worktree, "__pycache__", readdirSync(join(run.worktree, "__pycache__"))[0]), hash = fileDigest(file);
    writeFileSync(join(run.worktree, "cache_input.py"), "VALUE = 43\n# 使旧缓存失效，原命令必须读取本候选的新源码\n");
    writeFileSync(join(run.worktree, "file.txt"), "candidate");
    const output = await completeManagedDelivery(path, "【交付完成】", { exec: f.exec, callReviewer: reviewer });
    assert.equal(output.status, "通过", output.reason ?? ""); assert.equal(fileDigest(file), hash, "原任务既有缓存不被改写");
    const result = readRun(path).results.find((r) => r.node === "测试")!, report = JSON.parse(readFileSync(result.evidence.find((e) => e.endsWith("test.json"))!, "utf8"));
    assert.equal(report.command, command); assert.ok(report.runtimeCache.artifacts.some((a: any) => a.path.includes("cache_input")));
    assert.ok(report.runtimeCache.artifacts.every((a: any) => a.hash)); assert.equal(report.runtimeCache.release, "released"); assert.equal(existsSync(report.runtimeCache.path), false);
    // 重测另一个输入，让替身在专用缓存根制造链接；保留根外的夹具文件，不能记通过。
    const target = join(f.root, "outside-cache"); mkdirSync(target); writeFileSync(join(target, "owner.txt"), "keep");
    updateRun(path, (r) => { r.userVersion++; });
    await executeNode(path, "开发评审", async (i) => ({ status: "通过", evidence: [i.evidenceDir], operations: [], released: true }));
    const refused = await executeNode(path, "测试", (i) => runTestNode(i, async (_c, _a, options) => {
      symlinkSync(target, options.env!.PYTHONPYCACHEPREFIX!); return { code: 0, stdout: "ok", stderr: "", killed: false, processesReleased: true };
    }), { localSlot: true });
    assert.notEqual(refused.status, "通过"); assert.match(refused.reason!, /链接/); assert.equal(readFileSync(join(target, "owner.txt"), "utf8"), "keep");
  } finally { finishFixture(f); }
});

test("A7/A8 原候选/索引/非忽略新增/输入瞬时写回仍中断，保留原触发原因和保护结论，不扣返修次数", async () => {
  for (const mode of ["source", "restore", "index", "new", "local", "card", "config", "cancel", "release", "isolate-source", "isolate-new", "isolate-link"]) {
    const f = kernelFixture(["开发评审", "测试"], "printf ok"); let path: string | undefined;
    try {
      writeFileSync(join(f.repo, ".gitignore"), ".autoreview.json\nlocal.txt\ncache/\n");
      f.git(f.repo, "add", "."); f.git(f.repo, "commit", "-qm", "cache ignore");
      path = f.start(); f.candidate(path); const run = readRun(path);
      await executeNode(path, "开发评审", async (i) => ({ status: "通过", evidence: [i.evidenceDir], operations: [], released: true }));
      const controller = new AbortController();
      const output = await executeNode(path, "测试", (i) => runTestNode(i, async (_cmd, _args, options) => {
        const root = mode.startsWith("isolate-") ? options.cwd : run.worktree;
        if (["source", "restore", "isolate-source"].includes(mode)) { writeFileSync(join(root, "file.txt"), "changed"); if (mode === "restore") writeFileSync(join(root, "file.txt"), "delivered\n"); }
        if (mode === "index") { f.git(root, "update-index", "--assume-unchanged", "file.txt"); f.git(root, "update-index", "--no-assume-unchanged", "file.txt"); }
        if (["new", "isolate-new"].includes(mode)) writeFileSync(join(root, "non-ignored.txt"), "new");
        if (mode === "local") { writeFileSync(join(root, "local.txt"), "changed"); writeFileSync(join(root, "local.txt"), "local only"); }
        if (mode === "card") { const before = readFileSync(f.file); writeFileSync(f.file, "{}"); writeFileSync(f.file, before); }
        if (mode === "config") { const file = join(f.repo, ".autoreview.json"), before = readFileSync(file); writeFileSync(file, "{}"); writeFileSync(file, before); }
        if (mode === "cancel") { pauseManaged(path!, "真实用户停止测试"); controller.abort("真实用户停止测试"); }
        if (mode === "isolate-link") { mkdirSync(join(root, "cache")); symlinkSync(join(run.worktree, "file.txt"), join(root, "cache/link")); }
        if (mode === "release") { const prefix = options.env!.PYTHONPYCACHEPREFIX!; mkdirSync(prefix); writeFileSync(join(prefix, "unknown.pyc"), "模拟未启动替身的缓存，生产回执未知"); }
        return { code: 0, stdout: "ok", stderr: "", killed: false, processesReleased: mode !== "release" };
      }), { localSlot: true, signal: controller.signal });
      assert.notEqual(output.status, "通过", mode); const current = readRun(path), result = current.results.at(-1)!;
      assert.notEqual(result.status, "通过", mode); assert.equal(current.counters?.测试?.repairs ?? 0, 0);
      assert.ok(result.interruption); assert.ok(result.evidence.every(existsSync));
      if (["source", "restore", "index", "new", "card", "config", "cancel"].includes(mode)) assert.ok(result.interruption!.trigger, `${mode}: ${JSON.stringify(result)}`);
      if (["source", "restore", "index", "new"].includes(mode)) { assert.ok(result.interruption!.observations?.some((e) => e.path), `${mode}: ${JSON.stringify(result.interruption)}`); assert.ok(result.interruption!.protectionReason); }
      if (mode === "cancel") assert.match(result.reason!, /真实用户停止测试/);
      if (mode === "release") {
        assert.equal(output.released, false); assert.equal(current.testWorkspaces!.at(-1)!.state, "retained");
        assert.throws(() => developerActive(path!), /资源释放未确认/);
        const report = JSON.parse(readFileSync(result.evidence.find((e) => e.endsWith("test.json"))!, "utf8"));
        assert.equal(report.resource.status, "retained"); assert.equal(report.runtimeCache.release, "retained");
        assert.ok(existsSync(join(report.runtimeCache.path, "unknown.pyc")), "未知释放不能删除运行时缓存");
        const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(require('child_process').execFileSync('ps',['-p',String(process.pid),'-o','lstart='],{encoding:'utf8'}))"], { encoding: "utf8" });
        assert.equal(dead.status, 0); const queue = readLocalQueue(), ticket = queue.items[0];
        assert.equal(ticket.releaseUnproven, true); ticket.pid = dead.pid; ticket.started = dead.stdout.trim();
        writeFileSync(join(localQueueRoot(), "queue.json"), JSON.stringify(queue)); // 仅本 fixture：真实短进程的退出/启动事实，模拟原 worker 已退出。
        recoverLocalQueue(); assert.equal(readLocalQueue().items.length, 1, "所有者死亡不补造释放回执");
        releaseLocalSlot(ticket.id, ticket.token, true); assert.equal(readLocalQueue().items.length, 1, "空登记不能由停止/恢复核销未知证明");
        assert.ok(existsSync(join(report.runtimeCache.path, "unknown.pyc")));
        assert.equal(releaseRunResource(report.resource).status, "released", "仅夹具以确知未启动消费者的事实收尾，原未知结果不改写");
        // 此替身从未启动命令；仅夹具收尾以该事实释放自己的隔离目录，不改写产品的未知结果。
        assert.equal(releaseTestWorkspace(path, current.testWorkspaces!.at(-1)!, true), undefined);
      }
      else assert.equal(current.testWorkspaces!.at(-1)!.state, "released", mode);
    } finally { if (path) await stopKernel(path); finishFixture(f); }
  }
});

test("A3/A5 一个任务停止不冒充全批暂停；原 Pi 返修、停止后继续和重复交付不清零/不重做有效检查", async () => {
  const batch = kernelFixture(); let window: ReturnType<typeof piAdapter> | undefined;
  try {
    multi(batch); const path = batch.start(), a = readTaskRun(path, "甲"); process.env.AUTOREVIEW_KERNEL_TASK = a.taskId;
    window = piAdapter(path); await window.event("session_start"); developerActive(path, "乙"); pauseManaged(path, "甲停止；请续跑甲", "甲");
    await until(() => window!.widgets.at(-1)?.some((l) => l.includes("整批：进行中")) === true, "乙继续开发，整批不报暂停");
    assert.ok(window.widgets.at(-1)!.some((l) => l.includes("甲停止"))); assert.equal(queryKernel(path).status, "进行中");
  } finally { await window?.event("session_shutdown"); finishFixture(batch); }
  const f = kernelFixture(["开发评审", "测试"], `node -e "if(require('fs').readFileSync('file.txt','utf8')!=='fixed'){console.error('AssertionError: fix');process.exit(1)}"`);
  let h: ReturnType<typeof piAdapter> | undefined;
  try {
    fakeKernelLauncher(f); const path = f.start(); h = piAdapter(path, f.exec); await h.event("session_start");
    await h.event("before_agent_start", { systemPromptOptions: {} }); writeFileSync(join(readRun(path).worktree, "file.txt"), "broken"); h.reply("【交付完成】\n首轮");
    const repair = await h.event("agent_before_settle", { outcome: "completed" }); assert.equal(repair.continue, true); assert.match(repair.entries[0].content, /AssertionError/);
    const failed = readRun(path); assert.equal(failed.counters!.测试!.repairs, 1); assert.equal(failed.session!.id, "step5-original");
    await h.command("review-off"); const stopped = readRun(path); await h.event("agent_before_settle", { outcome: "completed" }); assert.equal(readRun(path).results.length, stopped.results.length, "停止不重放动作");
    await h.command("review-on"); await h.event("before_agent_start", { systemPromptOptions: {} }); writeFileSync(join(failed.worktree, "file.txt"), "fixed"); h.reply("【交付完成】\n返修完成");
    await h.event("agent_before_settle", { outcome: "completed" }); const done = readRun(path);
    assert.equal(done.counters!.测试!.repairs, 1); assert.equal(done.session!.id, failed.session!.id); assert.equal(done.worktree, failed.worktree);
    assert.notEqual(done.candidate!.commit, failed.candidate!.commit); assert.equal(done.results.at(-1)!.status, "通过");
    await h.event("agent_before_settle", { outcome: "completed" }); assert.equal(readRun(path).results.length, done.results.length, "有效检查复用");
  } finally { await h?.event("session_shutdown"); finishFixture(f); }
});

test("A5/A9 受控测试改卡不打断另一开发任务；汇入只同步已登记卡版本，不夹带未知元数据", async () => {
  const f = kernelFixture();
  try {
    multi(f); const path = f.start(); developerActive(path, "甲"); const a = readTaskRun(path, "甲"), review = checkInputs(a, "开发评审").hash;
    const change = requestCardChange(path, { from: f.replacement((c) => { c.tasks[1].test = "printf changed"; }), source: "cli:automation" });
    assert.equal(change.state, "applied"); assert.deepEqual(readTaskRun(path, "甲").activity, a.activity); assert.equal(readTaskRun(path, "甲").epoch, a.epoch); assert.equal(checkInputs(readTaskRun(path, "甲"), "开发评审").hash, review);
    updateTaskRun(path, "甲", (r) => { r.activity = undefined; });
    const tester = new URL("./fake-tester.mjs", import.meta.url).pathname;
    Object.assign(process.env, { AUTOREVIEW_ACCEPTANCE_CMD: tester, FAKE_STATE_DIR: join(f.root, "tester"), FAKE_ACC_MODE: "pass" });
    for (const name of ["甲", "乙"]) {
      const r = readTaskRun(path, name); writeFileSync(join(r.worktree, `${name}.txt`), `${name} done`);
      const output = await completeManagedDelivery(path, "【交付完成】", { exec: f.exec, callReviewer: reviewer, task: r.taskId });
      if (name === "乙") assert.equal(output.status, "通过", JSON.stringify(output));
    }
    const done = readRun(path); assert.equal(done.batch!.contributions.length, 2); assert.equal(queryKernel(path).status, "可合入"); assert.match(queryKernel(path).reason, /前置结论均有效/); assert.ok(queryKernel(path).tasks.every((t: any) => t.reason.includes("检查已完成")));
    assert.equal(f.git(done.worktree, "show", "HEAD:开发卡.json"), readFileSync(f.file, "utf8").trim());
    const frozen = readFileSync(f.file), mode = lstatSync(f.file).mode & 0o777;
    f.git(f.repo, "add", "开发卡.json");
    assert.match((await mergeManaged(path)).reason!, /重叠|用户|索引/, "用户暂存的冻结卡也不能当程序元数据覆盖");
    f.git(f.repo, "restore", "--staged", "--", "开发卡.json"); // 仅撤销本夹具刚创建的暂存。
    chmodSync(f.file, mode | 0o111); assert.match((await mergeManaged(path)).reason!, /重叠|模式|未知/); chmodSync(f.file, mode);
    writeFileSync(f.file, JSON.stringify({ ...f.card, name: "未知卡版本" })); await assert.rejects(() => mergeManaged(path), /直接修改|卡/); writeFileSync(f.file, frozen);
    const published = await mergeManaged(path); assert.equal(published.status, "通过", published.reason ?? "");
    assert.equal(readRun(path).publication!.push, "成功"); assert.equal(f.git(f.origin, "show", "dev:开发卡.json"), frozen.toString().trim());
  } finally { finishFixture(f); }
});

test("A7 已忽略的既有执行依赖仍是输入，变化后测试旧通过失效而评审不重做", async () => {
  const f = kernelFixture(["开发评审", "测试"], "cat runtime/value.txt");
  try {
    writeFileSync(join(f.repo, ".gitignore"), ".autoreview.json\nlocal.txt\nruntime/\n");
    f.git(f.repo, "add", "."); f.git(f.repo, "commit", "-qm", "ignored runtime input");
    const path = f.start(), run = readRun(path); mkdirSync(join(run.worktree, "runtime")); writeFileSync(join(run.worktree, "runtime/value.txt"), "v1");
    writeFileSync(join(run.worktree, "file.txt"), "candidate"); await completeManagedDelivery(path, "【交付完成】", { exec: f.exec, callReviewer: reviewer });
    assert.equal(queryKernel(path).status, "可合入"); writeFileSync(join(run.worktree, "runtime/value.txt"), "v2");
    const q = queryKernel(path); assert.equal(q.status, "等你决定"); assert.ok(q.checks.includes("评审：通过")); assert.ok(!q.checks.includes("测试：通过"));
  } finally { finishFixture(f); }
});

test("A4 标记仅首末独立行，旧 classifyMarker 未改；真实补充要求不借旧候选自动重放", () => {
  const f = kernelFixture(["开发评审"]);
  try {
    assert.equal(managedMarker("【交付完成】\n说明"), "delivered");
    assert.equal(managedMarker("说明\n【交付完成】\n讨论"), "none");
    const path = f.start(); f.candidate(path);
    updateRun(path, (r) => { r.userVersion++; r.userInputs.push("先讨论，不交付"); });
    assert.equal(managedDeliveryIntent(readRun(path), "普通讨论").advance, false);
  } finally { finishFixture(f); }
});

test("第1条：Pi/Hook 已有修改加新讨论不能交付、提交或推送；可信返修仍能推进", async () => {
  for (const host of ["pi", "claude", "codex"]) for (const priorDelivery of [false, true]) {
    const f = kernelFixture(["开发评审", "测试", "提交"]); let h: ReturnType<typeof piAdapter> | undefined;
    try {
      fakeKernelLauncher(f); const path = f.start(), run = readRun(path);
      Object.assign(process.env, { AUTOREVIEW_KERNEL_LEDGER: path, AUTOREVIEW_KERNEL_RUN: run.id, AUTOREVIEW_DEV_ROOT: run.worktree, AUTOREVIEW_HOST: host });
      if (host === "pi") { h = piAdapter(path, f.exec); await h.event("session_start"); }
      else await handleReviewEvent({ cwd: run.worktree, session_id: "original-discussion", hook_event_name: "SessionStart" });
      if (priorDelivery) {
        writeFileSync(join(run.worktree, "file.txt"), "previous delivery"); updateRun(path, (r) => { r.candidate = deliverCandidate(r); });
        prepareManagedContinuation(path); const envelope = readRun(path).repair!.message;
        if (h) await h.event("input", { source: "interactive", text: envelope });
        else await handleReviewEvent({ cwd: run.worktree, session_id: "original-discussion", hook_event_name: "UserPromptSubmit", prompt: envelope });
        assert.equal(readRun(path).repair!.state, "read"); assert.equal(readRun(path).userVersion, 0);
      }
      writeFileSync(join(run.worktree, "file.txt"), "unfinished candidate"); const head = f.git(run.worktree, "rev-parse", "HEAD");
      const discussion = "先只讨论方案，保留当前未完成修改，不交付";
      if (h) { await h.event("input", { source: "interactive", text: discussion }); await h.event("before_agent_start", { systemPromptOptions: {} }); h.reply("这是方案讨论，不是交付。"); await h.event("agent_before_settle", { outcome: "completed" }); }
      else { await handleReviewEvent({ cwd: run.worktree, session_id: "original-discussion", hook_event_name: "UserPromptSubmit", prompt: discussion }); await handleReviewEvent({ cwd: run.worktree, session_id: "original-discussion", hook_event_name: "Stop", last_assistant_message: "这是方案讨论，不是交付。" }); }
      assert.equal(f.git(run.worktree, "rev-parse", "HEAD"), head, `${host} 不得自动提交脏文件`);
      assert.equal(readRun(path).results.length, 0); assert.equal(readRun(path).publication, undefined);
      assert.equal(f.git(f.origin, "for-each-ref", "--format=%(refname)"), ""); assert.match(queryKernel(path).reason, /未识别/);
      assert.equal(readFileSync(join(run.worktree, "file.txt"), "utf8"), "unfinished candidate");
    } finally { await h?.event("session_shutdown"); finishFixture(f); }
  }
  const f = kernelFixture(["开发评审"]); let h: ReturnType<typeof piAdapter> | undefined;
  try {
    fakeKernelLauncher(f); process.env.FAKE_MODE = "pass-after-1"; const path = f.start(); h = piAdapter(path, f.exec);
    await h.event("session_start"); await h.event("before_agent_start", { systemPromptOptions: {} }); writeFileSync(join(readRun(path).worktree, "file.txt"), "first"); h.reply("【交付完成】");
    assert.equal((await h.event("agent_before_settle", { outcome: "completed" })).continue, true);
    writeFileSync(join(readRun(path).worktree, "file.txt"), "repair without marker"); h.reply("已按本原会话的评审返修完成。");
    await h.event("agent_before_settle", { outcome: "completed" }); assert.equal(queryKernel(path).status, "可合入"); assert.equal(readRun(path).repairs, 1);
  } finally { await h?.event("session_shutdown"); finishFixture(f); }
});

test("第2条：真实停止入口不能核销缺失回执，单/多任务的续跑、开启开发仍拒绝", async () => {
  for (const count of [1, 2]) {
    const f = kernelFixture(); let path: string | undefined, h: ReturnType<typeof piAdapter> | undefined;
    try {
      if (count === 2) multi(f); fakeKernelLauncher(f); process.env.KERNEL_FAKE_ACTION = "idle";
      path = f.start(); const run = readTaskRun(path, count === 2 ? "甲" : undefined), task = run.taskId;
      process.env.AUTOREVIEW_KERNEL_TASK = task ?? ""; h = piAdapter(path); await h.event("session_start");
      writeFileSync(join(run.worktree, count === 2 ? "甲.txt" : "file.txt"), "candidate"); updateTaskRun(path, task, (r) => { r.candidate = deliverCandidate(r); });
      await executeNode(path, "开发评审", async (i) => ({ status: "通过", evidence: [i.evidenceDir], operations: [], released: true }), { task });
      const output = await executeNode(path, "测试", (i) => runTestNode(i, async () => ({ code: 0, stdout: "ok", stderr: "", killed: false })), { task, localSlot: true });
      assert.equal(output.released, false); const before = readTaskRun(path, task), countBefore = before.results.length;
      await stopKernel(path, false, task);
      assert.equal(readTaskRun(path, task).release.status, "未确认", "停止不能将释放未知降为未释放");
      writeFileSync(join(run.worktree, count === 2 ? "甲.txt" : "file.txt"), "unfinished after unknown release");
      await assert.rejects(() => resumeManaged(path!, true, undefined, false, task), /释放未确认/);
      await assert.rejects(() => h!.command("review-on"), /释放未确认/);
      updateTaskRun(path, task, (r) => { r.stopped = false; }); // 仅反例验证开发守卫不能单靠 stopped。
      assert.throws(() => developerActive(path!, task), /释放未确认/); updateTaskRun(path, task, (r) => { r.stopped = true; });
      assert.equal(readTaskRun(path, task).results.length, countBefore); assert.deepEqual(readTaskRun(path, task).candidate, before.candidate);
      assert.equal(readTaskRun(path, task).workerRequest, undefined);
      if (count === 2) { await stopKernel(path); assert.equal(readRun(path).release.status, "未确认"); }
    } finally {
      await h?.event("session_shutdown");
      if (path) {
        // 上面的 Exec 是未启动进程的纯内存替身；只据夹具事实释放它自己的资料，产品未知结果不改写。
        for (const e of readRun(path).testWorkspaces ?? []) if (e.state !== "released") {
          const result = readRun(path).results.find((r) => r.id === e.attempt)!;
          const report = JSON.parse(readFileSync(result.evidence.find((v) => v.endsWith("test.json"))!, "utf8")); releaseRunResource(report.resource);
          assert.equal(releaseTestWorkspace(path, e, true), undefined);
        }
        await stopKernel(path);
      }
      finishFixture(f);
    }
  }
});

test("第3条：先自检已有 Node 输出再交付仍跑原命令；真实依赖、登记输入和跟踪文件不放行", async () => {
  const command = `node -e "const f=require('fs');f.mkdirSync('dist',{recursive:true});f.writeFileSync('dist/built.js','module.exports='+require('fixture-dep')*JSON.parse(f.readFileSync('dist/settings.json')).factor);if(require('./dist/built.js')!==42)throw Error('AssertionError: build')"`;
  const f = kernelFixture(["开发评审", "测试"], command);
  try {
    writeFileSync(join(f.repo, ".gitignore"), ".autoreview.json\nlocal.txt\ndist/\nnode_modules/\n"); mkdirSync(join(f.repo, "dist"));
    writeFileSync(join(f.repo, "dist/settings.json"), '{"factor":2}'); writeFileSync(join(f.repo, "dist/tracked.txt"), "tracked input");
    const cfg = JSON.parse(readFileSync(join(f.repo, ".autoreview.json"), "utf8")); cfg.localFiles.push("dist/settings.json"); writeFileSync(join(f.repo, ".autoreview.json"), JSON.stringify(cfg));
    f.git(f.repo, "add", "."); f.git(f.repo, "add", "-f", "dist/tracked.txt"); f.git(f.repo, "commit", "-qm", "build fixture");
    const path = f.start(), run = readRun(path); mkdirSync(join(run.worktree, "node_modules/fixture-dep"), { recursive: true });
    writeFileSync(join(run.worktree, "node_modules/fixture-dep/index.js"), "module.exports=21");
    const selfCheck = spawnSync("/bin/sh", ["-c", command], { cwd: run.worktree, encoding: "utf8" }); assert.equal(selfCheck.status, 0, selfCheck.stderr);
    const original = fileDigest(join(run.worktree, "dist/built.js")); writeFileSync(join(run.worktree, "file.txt"), "candidate");
    const result = await completeManagedDelivery(path, "【交付完成】", { exec: f.exec, callReviewer: reviewer }); assert.equal(result.status, "通过", result.reason ?? "");
    assert.equal(fileDigest(join(run.worktree, "dist/built.js")), original);
    const checked = readRun(path).results.find((r) => r.node === "测试")!, report = JSON.parse(readFileSync(checked.evidence.find((p) => p.endsWith("test.json"))!, "utf8"));
    assert.equal(report.command, command); assert.equal(report.calls[0].command, command);
    const isolated = JSON.parse(readFileSync(checked.evidence.find((p) => p.endsWith("check-workspace.json"))!, "utf8"));
    assert.ok(isolated.artifacts.some((a: any) => a.path === "dist/built.js")); assert.equal(isolated.release, "released");
    assert.equal(isolated.inputPlan.omitted.length, 0, "不再省略未知 ignored 输入");
    assert.ok(isolated.inputPlan.inputs.some((p: any) => p.path === "dist/built.js" && p.hash === original));
    assert.ok(isolated.nodeProofs.some((p: any) => p.outputs.includes("dist/built.js")), "依据本次完整替换且未消费旧内容的实际证明提升产物");
    const artifact = join(run.worktree, "dist/built.js"), bytes = readFileSync(artifact);
    writeFileSync(artifact, "developer rebuilt working output"); assert.ok(!queryKernel(path).checks.includes("测试：通过"), "未知 ignored 快照变化仍使旧结果失效，不永久豁免任何路径"); writeFileSync(artifact, bytes);
    for (const file of ["dist/settings.json", "dist/tracked.txt", "node_modules/fixture-dep/index.js"]) {
      const hash = fileDigest(join(run.worktree, file)); updateRun(path, (r) => { r.userVersion++; });
      await executeNode(path, "开发评审", async (i) => ({ status: "通过", evidence: [i.evidenceDir], operations: [], released: true }));
      const refused = await executeNode(path, "测试", (i) => runTestNode(i, async (_c, _a, options) => {
        writeFileSync(join(options.cwd, file), "bad input mutation"); return { code: 0, stdout: "ok", stderr: "", killed: false, processesReleased: true };
      }), { localSlot: true });
      assert.notEqual(refused.status, "通过", file); assert.equal(fileDigest(join(run.worktree, file)), hash);
    }
  } finally { finishFixture(f); }
});

test("第3条补充：原样输入的延迟初始化通知可核对，写回/输入目录瞬时创建仍拒绝", async (t) => {
  const original = fs.watch; let notification: ((event: string, file: string) => void) | undefined;
  t.mock.method(fs, "watch", ((...args: any[]) => {
    if (args[1]?.recursive && String(args[0]).endsWith("/worktree")) notification = args[2];
    return Reflect.apply(original, fs, args);
  }) as typeof fs.watch);
  syncBuiltinESMExports();
  try {
    for (const mode of ["unchanged", "restore", "directory-transient"]) {
      const f = kernelFixture();
      try {
        const cfg = JSON.parse(readFileSync(join(f.repo, ".autoreview.json"), "utf8")); cfg.methods = { paths: ["input-dir"] };
        writeFileSync(join(f.repo, ".autoreview.json"), JSON.stringify(cfg)); writeFileSync(join(f.repo, ".gitignore"), ".autoreview.json\nlocal.txt\ninput-dir/\n");
        mkdirSync(join(f.repo, "input-dir")); writeFileSync(join(f.repo, "input-dir/value.txt"), "input"); f.git(f.repo, "add", "."); f.git(f.repo, "commit", "-qm", "notification fixture");
        const path = f.start(), run = readRun(path); mkdirSync(join(run.worktree, "input-dir")); writeFileSync(join(run.worktree, "input-dir/value.txt"), "input"); f.candidate(path);
        await executeNode(path, "开发评审", async (i) => ({ status: "通过", evidence: [i.evidenceDir], operations: [], released: true }));
        notification = undefined;
        const result = await executeNode(path, "测试", (i) => runTestNode(i, async (_c, _a, options) => {
          assert.ok(notification, "真实监听已建立，捕获的是同一监听回调");
          notification("rename", "local.txt"); notification("rename", "input-dir"); // 模拟 OS 延迟投递复制通知，不改文件。
          if (mode === "restore") { const p = join(options.cwd, "local.txt"), bytes = readFileSync(p); writeFileSync(p, "changed"); writeFileSync(p, bytes); }
          if (mode === "directory-transient") { const p = join(options.cwd, "input-dir/transient"); writeFileSync(p, "temporary"); fs.unlinkSync(p); }
          return { code: 0, stdout: "ok", stderr: "", killed: false, processesReleased: true };
        }), { localSlot: true });
        if (mode === "unchanged") assert.equal(result.status, "通过", result.reason ?? "");
        else assert.notEqual(result.status, "通过", mode);
        assert.equal(readFileSync(join(run.worktree, "local.txt"), "utf8"), "local only");
      } finally { finishFixture(f); }
    }
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test("后续第1条：暂未确认后取得原消费者真实释放证明，再停止可恢复原任务", async (t) => {
  const f = kernelFixture(["开发评审"]); let path: string | undefined, actor: ReturnType<typeof spawn> | undefined, closed: Promise<unknown> | undefined;
  let resource: ReturnType<typeof createRunResource> | undefined, procs: string | undefined;
  const gate = join(f.root, "actor-exit"), ready = join(f.root, "actor-ready");
  try {
    fakeKernelLauncher(f); process.env.KERNEL_FAKE_ACTION = "idle"; path = f.start(); f.candidate(path); const run = readRun(path);
    const log = join(run.dir, "fake-pi-session.jsonl"); writeFileSync(log, "fixture original session"); attachSession(path, "pi", "fake-original-session", log);
    updateRun(path, (r) => { r.repairs = 2; r.counters = { 测试: { repairs: 1, recoveries: 1 } }; });
    await executeNode(path, "开发评审", async (i) => {
      procs = i.procsFile!; resource = createRunResource("late-release-proof", 0, procs); const token = randomUUID();
      actor = spawn(process.execPath, ["-e", `const f=require('fs');f.writeFileSync(${JSON.stringify(ready)},'ready');const t=setInterval(()=>{if(f.existsSync(${JSON.stringify(gate)})){clearInterval(t);process.exit(0)}},10)`], { detached: true, stdio: "ignore", env: { ...process.env, AUTOREVIEW_PROCESS_OWNER: token } });
      await new Promise<void>((ok, no) => { actor!.once("spawn", ok); actor!.once("error", no); }); closed = new Promise((ok) => actor!.once("close", ok));
      registerProc(procs, actor.pid!, "review-fixture", process.execPath, token, resource.id); await until(() => existsSync(ready), "真实登记消费者已启动");
      return { status: "没验证", reason: "模拟执行器当时无法确认释放，登记仍完整", failure: "environment", evidence: [i.evidenceDir], operations: [], released: false };
    });
    const before = readRun(path), record = readProcs(procs!)[0], originalSpawn = childProcess.spawnSync;
    t.mock.method(childProcess, "spawnSync", ((command: any, args: any, ...rest: any[]) => {
      if (command === "ps" && args?.includes("eww")) return { pid: 0, status: 1, signal: null, stdout: "", stderr: "simulated temporary ps failure" };
      return Reflect.apply(originalSpawn, childProcess, [command, args, ...rest]);
    }) as typeof childProcess.spawnSync); syncBuiltinESMExports();
    try { await stopKernel(path); assert.equal(readRun(path).release.status, "未确认"); assert.doesNotThrow(() => process.kill(actor!.pid!, 0)); }
    finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
    writeFileSync(gate, "exit"); await closed;
    assert.equal(releaseProc(procs!, record.pgid, record), true); assert.equal(releaseRunResource(resource!).status, "released");
    const stopped = await stopKernel(path); assert.equal(stopped.ok, true, JSON.stringify(stopped)); assert.equal(readRun(path).release.status, "未释放", "新释放事实应核销具体未结项，不能旧枚举自证未知");
    assert.equal(readRun(path).results[0].status, "没验证"); assert.equal(readRun(path).results[0].released, false, "原业务/执行器结论不补造成通过");
    await resumeManaged(path, true); await until(() => !!readRun(path!).launch && readRun(path!).session?.launchId === readRun(path!).launch!.token, "原会话已恢复");
    developerActive(path); const resumed = readRun(path); assert.deepEqual(resumed.candidate, before.candidate); assert.equal(resumed.session!.id, before.session!.id);
    assert.equal(resumed.repairs, 2); assert.deepEqual(resumed.counters, before.counters); assert.equal(resumed.worktree, before.worktree);
  } finally {
    t.mock.restoreAll(); syncBuiltinESMExports(); writeFileSync(gate, "exit"); await closed;
    if (procs) for (const p of readProcs(procs)) releaseProc(procs, p.pgid, p);
    if (resource) releaseRunResource(resource); if (path) await stopKernel(path); finishFixture(f);
  }
});

test("后续第1条多任务：按任务名停止后取得真实证明，票据与隔离检出可核销", async (t) => {
  const f = kernelFixture(); let path: string | undefined, actor: ReturnType<typeof spawn> | undefined, closed: Promise<unknown> | undefined, procs: string | undefined, resource: ReturnType<typeof createRunResource> | undefined;
  const gate = join(f.root, "test-actor-exit"), ready = join(f.root, "test-actor-ready");
  try {
    multi(f); path = f.start(); const run = readTaskRun(path, "甲"), task = run.taskId!;
    writeFileSync(join(run.worktree, "甲.txt"), "candidate"); updateTaskRun(path, task, (r) => { r.candidate = deliverCandidate(r); r.counters = { 测试: { repairs: 1, recoveries: 1 } }; });
    await executeNode(path, "开发评审", async (i) => ({ status: "通过", evidence: [i.evidenceDir], operations: [], released: true }), { task });
    await executeNode(path, "测试", (i) => runTestNode(i, async () => {
      procs = i.procsFile!; resource = readLocalQueue().items.find((v) => v.id === i.attempt)!.resource!; const token = randomUUID();
      actor = spawn(process.execPath, ["-e", `const f=require('fs');f.writeFileSync(${JSON.stringify(ready)},'ready');const t=setInterval(()=>{if(f.existsSync(${JSON.stringify(gate)})){clearInterval(t);process.exit(0)}},10)`], { detached: true, stdio: "ignore", env: { ...process.env, AUTOREVIEW_PROCESS_OWNER: token } });
      await new Promise<void>((ok, no) => { actor!.once("spawn", ok); actor!.once("error", no); }); closed = new Promise((ok) => actor!.once("close", ok));
      registerProc(procs, actor.pid!, "test-fixture", process.execPath, token, resource.id); await until(() => existsSync(ready), "真实测试消费者已登记");
      return { code: 0, stdout: "fixture still running", stderr: "", killed: false, processesReleased: false };
    }), { task, localSlot: true });
    const before = readTaskRun(path, task), record = readProcs(procs!)[0], original = childProcess.spawnSync;
    assert.ok(!readLocalQueue().items[0].releaseUnproven, "这是原消费者身份完整、暂未释放，不是丢失身份回执");
    t.mock.method(childProcess, "spawnSync", ((command: any, args: any, ...rest: any[]) => command === "ps" && args?.includes("eww") ? { pid: 0, status: 1, signal: null, stdout: "", stderr: "temporary query failure" } : Reflect.apply(original, childProcess, [command, args, ...rest])) as typeof childProcess.spawnSync); syncBuiltinESMExports();
    try { await stopKernel(path, false, "甲"); assert.equal(readTaskRun(path, task).release.status, "未确认"); }
    finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
    writeFileSync(gate, "exit"); await closed; assert.equal(releaseProc(procs!, record.pgid, record), true); assert.equal(releaseRunResource(resource!).status, "released");
    const stopped = await stopKernel(path, false, "甲"); assert.equal(stopped.ok, true, JSON.stringify(stopped));
    assert.equal(readTaskRun(path, task).release.status, "未释放"); assert.equal(readLocalQueue().items.length, 0); assert.ok(readRun(path).testWorkspaces!.every((v) => v.state === "released"));
    await resumeManaged(path, false, "测试", false, "甲"); const resumed = readTaskRun(path, task);
    assert.equal(resumed.results.filter((r) => r.task === task && r.node === "测试").at(-1)!.status, "通过"); assert.deepEqual(resumed.counters, before.counters); assert.deepEqual(resumed.candidate, before.candidate);
  } finally {
    t.mock.restoreAll(); syncBuiltinESMExports(); writeFileSync(gate, "exit"); await closed;
    if (procs) for (const p of readProcs(procs)) releaseProc(procs, p.pgid, p); if (resource) releaseRunResource(resource);
    if (path) { for (const e of readRun(path).testWorkspaces ?? []) if (e.state !== "released") releaseTestWorkspace(path, e, true); await stopKernel(path); }
    finishFixture(f);
  }
});

test("后续第1条保护：已调用但丢失结束回执不能凭旧状态核销，明确未调用可收尾", async () => {
  for (const invoked of [true, false]) {
    const f = kernelFixture(["开发评审"]);
    try {
      fakeKernelLauncher(f); process.env.KERNEL_FAKE_ACTION = "idle"; const path = f.start(), run = readRun(path), id = randomUUID(), dir = join(run.dir, "attempts", id); mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "attempt.json"), JSON.stringify({ id, node: "开发评审", task: "甲", invoked }));
      updateRun(path, (r) => { r.release = { status: "未确认", details: ["模拟中断时未结清状态"] }; });
      const stopped = await stopKernel(path); assert.equal(stopped.ok, !invoked);
      if (invoked) { assert.equal(readRun(path).release.status, "未确认"); await assert.rejects(() => resumeManaged(path, true), /释放未确认/); }
      else assert.equal(readRun(path).release.status, "未释放");
    } finally { finishFixture(f); }
  }
});

test("后续第2条：原配置未登记的 ignored 输入照常带入，原 cat 命令及输入保护保持", async () => {
  const command = "cat runtime/value.txt", f = kernelFixture(["开发评审", "测试"], command);
  try {
    writeFileSync(join(f.repo, ".gitignore"), ".autoreview.json\nlocal.txt\nruntime/\n"); f.git(f.repo, "add", "."); f.git(f.repo, "commit", "-qm", "original ignored input condition");
    const path = f.start(), run = readRun(path); mkdirSync(join(run.worktree, "runtime")); writeFileSync(join(run.worktree, "runtime/value.txt"), "original ignored input\n");
    writeFileSync(join(run.worktree, "file.txt"), "candidate"); const output = await completeManagedDelivery(path, "【交付完成】", { exec: f.exec, callReviewer: reviewer });
    assert.equal(output.status, "通过", output.reason ?? ""); const result = readRun(path).results.find((r) => r.node === "测试")!;
    const report = JSON.parse(readFileSync(result.evidence.find((p) => p.endsWith("test.json"))!, "utf8"));
    assert.equal(report.calls[0].command, command); assert.match(report.calls[0].stdout, /original ignored input/); assert.equal(report.calls.length, 1);
    assert.ok(Object.keys(checkInputs(readRun(path), "测试").files).some((p) => p.includes("runtime/value.txt")));
    assert.equal(JSON.parse(readFileSync(join(f.repo, ".autoreview.json"), "utf8")).methods, undefined, "不新增登记前提");
    writeFileSync(join(run.worktree, "runtime/value.txt"), "changed input"); assert.ok(!queryKernel(path).checks.includes("测试：通过")); assert.ok(queryKernel(path).checks.includes("评审：通过"));
  } finally { finishFixture(f); }
});

test("后续第2条保护：真实 ignored 输入读后写、别名、未观测消费者和伪证据不提升产物", async () => {
  const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`, node = (s: string, esm = false) => `node ${esm ? "--input-type=module " : ""}-e ${quote(s)}`;
  const cases = [
    ["read-writeback", node(`const f=require("fs"),p="runtime/value.txt",v=f.readFileSync(p);f.writeFileSync(p,"bad");f.writeFileSync(p,v)`)],
    ["promise-read", node(`import f from "node:fs/promises";const p="runtime/value.txt",v=await f.readFile(p);await f.writeFile(p,v)`, true)],
    ["descriptor-read", node(`const f=require("fs"),p="runtime/value.txt",fd=f.openSync(p,"r+"),b=Buffer.alloc(2);f.readSync(fd,b,0,2,0);f.writeFileSync(p,"v1");f.closeSync(fd)`)],
    ["module-read", node(`const f=require("fs");require("./runtime/value.json");f.writeFileSync("runtime/value.json",JSON.stringify({value:2}))`)],
    ["alias-read", node(`const f=require("fs");f.readFileSync("runtime/alias");f.writeFileSync("runtime/value.txt","changed")`)],
    ["opaque-consumer", node(`require("node:child_process").spawnSync("cat",["runtime/value.txt"]);require("fs").writeFileSync("runtime/value.txt","changed")`)],
    ["observed-node-consumer", node(`const c=require("node:child_process").spawn(process.execPath,["-e",'require("fs").readFileSync("runtime/value.txt")']);c.on("close",()=>require("fs").writeFileSync("runtime/value.txt","changed"))`)],
    ["shell-input", `cat runtime/value.txt >/dev/null; ${node(`require("fs").writeFileSync("runtime/value.txt","changed")`)}`],
    ["forged-proof", node(`const f=require("fs");if(process.env.LOOP_NODE_OUTPUT_KEY)throw Error("capability leaked");f.writeSync(3,"LOOP_NODE_OUTPUT_V1 e30= "+"0".repeat(64)+"\\n");f.writeFileSync("runtime/value.txt","changed")`)],
  ];
  for (const [name, command] of cases) {
    const f = kernelFixture(["开发评审", "测试"], command);
    try {
      writeFileSync(join(f.repo, ".gitignore"), ".autoreview.json\nlocal.txt\nruntime/\n"); f.git(f.repo, "add", "."); f.git(f.repo, "commit", "-qm", "read provenance fixture");
      const path = f.start(), run = readRun(path); mkdirSync(join(run.worktree, "runtime"));
      writeFileSync(join(run.worktree, "runtime/value.txt"), "v1"); writeFileSync(join(run.worktree, "runtime/value.json"), '{"value":1}'); symlinkSync("value.txt", join(run.worktree, "runtime/alias"));
      writeFileSync(join(run.worktree, "file.txt"), "candidate"); const output = await completeManagedDelivery(path, "【交付完成】", { exec: f.exec, callReviewer: reviewer });
      assert.notEqual(output.status, "通过", name); assert.equal(readFileSync(join(run.worktree, "runtime/value.txt"), "utf8"), "v1");
      assert.equal(readFileSync(join(run.worktree, "runtime/value.json"), "utf8"), '{"value":1}'); assert.equal(readRun(path).counters?.测试?.repairs ?? 0, 0, name);
      const record = readRun(path).results.find((r) => r.node === "测试")!, isolated = JSON.parse(readFileSync(record.evidence.find((p) => p.endsWith("check-workspace.json"))!, "utf8"));
      assert.equal(isolated.promoted.length, 0, name); assert.equal(isolated.inputPlan.omitted.length, 0, name);
    } finally { finishFixture(f); }
  }
});

test("后续第2条强输入：实际 Node 全量写入也不能提升源码、本机文件、登记输入或依赖", async () => {
  for (const target of ["file.txt", "local.txt", "runtime/declared.txt", "node_modules/fixture-dep/index.js"]) {
    const command = `node -e 'require("fs").writeFileSync(${JSON.stringify(target)},"changed")'`, f = kernelFixture(["开发评审", "测试"], command);
    try {
      writeFileSync(join(f.repo, ".gitignore"), ".autoreview.json\nlocal.txt\nruntime/\nnode_modules/\n");
      const cfg = JSON.parse(readFileSync(join(f.repo, ".autoreview.json"), "utf8")); cfg.methods = { paths: ["runtime/declared.txt"] }; writeFileSync(join(f.repo, ".autoreview.json"), JSON.stringify(cfg));
      f.git(f.repo, "add", "."); f.git(f.repo, "commit", "-qm", "hard inputs fixture"); const path = f.start(), run = readRun(path);
      mkdirSync(join(run.worktree, "runtime")); writeFileSync(join(run.worktree, "runtime/declared.txt"), "declared"); writeFileSync(join(run.worktree, "runtime/other.txt"), "unregistered");
      mkdirSync(join(run.worktree, "node_modules/fixture-dep"), { recursive: true }); writeFileSync(join(run.worktree, "node_modules/fixture-dep/index.js"), "module.exports=21");
      writeFileSync(join(run.worktree, "file.txt"), "candidate"); const before = fileDigest(join(run.worktree, target));
      const output = await completeManagedDelivery(path, "【交付完成】", { exec: f.exec, callReviewer: reviewer }); assert.notEqual(output.status, "通过", target);
      assert.equal(fileDigest(join(run.worktree, target)), before); const result = readRun(path).results.find((r) => r.node === "测试")!;
      const proof = JSON.parse(readFileSync(result.evidence.find((p) => p.endsWith("check-workspace.json"))!, "utf8")); assert.ok(!proof.promoted.includes(target));
    } finally { finishFixture(f); }
  }
});

test("本轮第1条：重命名后读取旧 ignored 输入再覆盖或写回不得提升产物", async () => {
  const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
  for (const api of ["sync", "promise", "directory"]) for (const restore of [false, true]) {
    const input = api === "directory" ? "data/input/value.txt" : "runtime/value.txt", moved = api === "directory" ? "data/moved/value.txt" : "runtime/tmp.txt";
    const program = api === "promise" ? `const f=require("fs/promises");(async()=>{await f.rename(${JSON.stringify(input)},${JSON.stringify(moved)});const v=await f.readFile(${JSON.stringify(moved)});await f.writeFile(${JSON.stringify(input)},${restore ? "v" : '"changed"'});await f.unlink(${JSON.stringify(moved)})})()`
      : api === "directory" ? `const f=require("fs");f.renameSync("data/input","data/moved");const v=f.readFileSync("data/moved/value.txt");f.mkdirSync("data/input");f.writeFileSync("data/input/value.txt",${restore ? "v" : '"changed"'});f.rmSync("data/moved",{recursive:true})`
      : `const f=require("fs");f.renameSync(${JSON.stringify(input)},${JSON.stringify(moved)});const v=f.readFileSync(${JSON.stringify(moved)});f.writeFileSync(${JSON.stringify(input)},${restore ? "v" : '"changed"'});f.unlinkSync(${JSON.stringify(moved)})`;
    const f = kernelFixture(["开发评审", "测试"], `node -e ${quote(program)}`);
    try {
      writeFileSync(join(f.repo, ".gitignore"), ".autoreview.json\nlocal.txt\nruntime/\ndata/\n"); f.git(f.repo, "add", "."); f.git(f.repo, "commit", "-qm", "rename provenance fixture");
      const path = f.start(), run = readRun(path); mkdirSync(dirname(join(run.worktree, input)), { recursive: true }); writeFileSync(join(run.worktree, input), "original bytes");
      writeFileSync(join(run.worktree, "file.txt"), "candidate"); const result = await completeManagedDelivery(path, "【交付完成】", { exec: f.exec, callReviewer: reviewer });
      assert.notEqual(result.status, "通过", `${api}/${restore}: 原内容被消费后不能成为产物`); assert.equal(readFileSync(join(run.worktree, input), "utf8"), "original bytes");
      const record = readRun(path).results.find((r) => r.node === "测试")!, proof = JSON.parse(readFileSync(record.evidence.find((p) => p.endsWith("check-workspace.json"))!, "utf8"));
      assert.ok(!proof.promoted.includes(input)); assert.equal(readRun(path).counters?.测试?.repairs ?? 0, 0);
    } finally { finishFixture(f); }
  }
});

test("本轮第2条：npm 原构建入口及 Node 原测试入口均可重建已有产物并保留消费者证据", async () => {
  for (const command of ["npm run build", "node --test test/example.test.ts"]) {
    const f = kernelFixture(["开发评审", "测试"], command);
    try {
      delete process.env.NODE_TEST_CONTEXT; // 外层 node:test 身份不属于要验证的独立卡命令，否则 Node 会跳过嵌套测试。
      Object.assign(process.env, { npm_config_update_notifier: "false", npm_config_audit: "false", npm_config_fund: "false", npm_config_cache: join(f.root, "npm-cache"), npm_config_userconfig: join(f.root, "npmrc") }); writeFileSync(join(f.root, "npmrc"), "");
      writeFileSync(join(f.repo, ".gitignore"), ".autoreview.json\nlocal.txt\ndist/\n");
      writeFileSync(join(f.repo, "package.json"), JSON.stringify({ name: "loop-build-fixture", private: true, type: "module", scripts: { build: "node ipc-build.cjs" } }));
      const build = 'const f=require("fs");f.mkdirSync("dist",{recursive:true});f.writeFileSync("dist/new.cjs","module.exports=42");f.renameSync("dist/new.cjs","dist/built.cjs")'; writeFileSync(join(f.repo, "build.cjs"), build);
      writeFileSync(join(f.repo, "ipc-build.cjs"), 'const c=require("child_process").fork("ipc-worker.cjs",[],{stdio:["ignore","ignore","ignore","ipc"]});let seen=false;c.on("message",v=>{require("assert/strict").equal(v,42);seen=true});c.on("close",code=>{if(code||!seen)process.exitCode=1});');
      writeFileSync(join(f.repo, "ipc-worker.cjs"), 'require("./build.cjs");process.send(require("./dist/built.cjs"),()=>process.disconnect());');
      mkdirSync(join(f.repo, "test")); writeFileSync(join(f.repo, "test/example.test.ts"), 'import test from "node:test";import assert from "node:assert/strict";import {createRequire} from "node:module";const require=createRequire(import.meta.url);test("original build",()=>{require("../build.cjs");assert.equal(require("../dist/built.cjs"),42)});');
      f.git(f.repo, "add", "."); f.git(f.repo, "commit", "-qm", "ordinary node entry fixtures"); const path = f.start(), run = readRun(path);
      const self = spawnSync("/bin/sh", ["-c", command], { cwd: run.worktree, env: process.env, encoding: "utf8" }); assert.equal(self.status, 0, self.stdout + self.stderr);
      const original = fileDigest(join(run.worktree, "dist/built.cjs")); writeFileSync(join(run.worktree, "file.txt"), "candidate");
      const result = await completeManagedDelivery(path, "【交付完成】", { exec: f.exec, callReviewer: reviewer }); assert.equal(result.status, "通过", `${command}: ${result.reason}`);
      assert.equal(fileDigest(join(run.worktree, "dist/built.cjs")), original); const record = readRun(path).results.find((r) => r.node === "测试")!;
      const report = JSON.parse(readFileSync(record.evidence.find((p) => p.endsWith("test.json"))!, "utf8")), proof = JSON.parse(readFileSync(record.evidence.find((p) => p.endsWith("check-workspace.json"))!, "utf8"));
      assert.equal(report.command, command); assert.equal(report.calls.length, 1); assert.equal(report.calls[0].command, command); assert.equal(report.calls[0].processesReleased, true);
      assert.ok(proof.promoted.includes("dist/built.cjs")); assert.ok(proof.nodeProofs.some((p: any) => p.events.filter((e: any) => e.type === "begin").length >= 2));
      if (command === "npm run build") assert.ok(proof.nodeProofs.some((p: any) => p.events.some((e: any) => e.type === "begin" && e.fd > 3)), "新增证据 fd 不能占用已有业务 IPC fd3");
      assert.equal(proof.release, "released"); assert.equal(existsSync(proof.path), false); assert.equal(readLocalQueue().items.length, 0);
    } finally { finishFixture(f); }
  }
});

test("第4条：可见/后台偏好跨测试排队停止恢复保留；单/多任务返修不静默切后台", async () => {
  for (const count of [1, 2]) for (const mode of ["terminal", "terminal-node-worker", "background", "override-background"]) {
    const f = kernelFixture(); let path: string | undefined, job: Promise<unknown> | undefined, blocker: { id: string; token: string } | undefined;
    try {
      if (count === 2) multi(f);
      const calls = join(f.root, "terminal-calls.jsonl"), bin = join(f.root, "bin"); mkdirSync(bin);
      writeFileSync(join(bin, "osascript"), `#!${process.execPath}\nrequire('fs').appendFileSync(${JSON.stringify(calls)},JSON.stringify(process.argv.slice(2))+'\\n');\n`, { mode: 0o755 }); process.env.PATH = `${bin}:${process.env.PATH}`;
      const invoked = join(f.root, "test-invoked"); f.card.tasks[0].test = `printf ran >> '${invoked}'; echo 'AssertionError: requires repair' >&2; exit 1`;
      writeFileSync(f.file, JSON.stringify(f.card)); fakeKernelLauncher(f); process.env.KERNEL_FAKE_ACTION = "idle"; path = f.start();
      const task = count === 2 ? readTaskRun(path, "甲").taskId : undefined;
      if (mode === "background") {
        await launchKernel(path, true); await until(() => !!readTaskRun(path!, task).session, "原后台宿主已登记");
      } else {
        resumeTerminalTasks(path);
        const token = randomUUID(), dead = spawnSync(process.execPath, ["-e", "process.stdout.write(require('child_process').execFileSync('ps',['-p',String(process.pid),'-o','lstart='],{encoding:'utf8'}))"], { encoding: "utf8", env: { ...process.env, AUTOREVIEW_PROCESS_OWNER: token } }); assert.equal(dead.status, 0);
        const run = readTaskRun(path, task), log = join(run.dir, "fake-pi-session.jsonl"); writeFileSync(log, "fixture session");
        attachSession(path, "pi", task ? `fake-${task}` : "fake-original-session", log, task);
        updateTaskRun(path, task, (r) => { r.terminal!.state = "claimed"; r.terminal!.owner = { pid: dead.pid, started: dead.stdout.trim() }; r.launch = { pid: dead.pid, processStarted: dead.stdout.trim(), token }; });
      }
      const run = readTaskRun(path, task), oldSession = structuredClone(run.session!), name = count === 2 ? "甲.txt" : "file.txt";
      writeFileSync(join(run.worktree, name), "candidate"); updateTaskRun(path, task, (r) => { r.candidate = deliverCandidate(r); });
      await executeNode(path, "开发评审", async (i) => ({ status: "通过", evidence: [i.evidenceDir], operations: [], released: true }), { task });
      const checkedCandidate = structuredClone(readTaskRun(path, task).candidate), reviewed = readRun(path).results.filter((r) => r.node === "开发评审").map((r) => r.id);
      blocker = { id: randomUUID(), token: randomUUID() }; const procs = join(f.root, "blocker.procs.json"); writeFileSync(procs, "[]");
      await acquireLocalSlot({ ...blocker, ledger: join(f.root, "owned-blocker"), run: "owned-blocker", common: run.common, task: "blocker", node: "测试", tree: run.candidate!.tree, inputs: "owned", epoch: 0, pid: process.pid, started: processStartTime(process.pid), procs }, new AbortController().signal, () => {});
      job = advanceManaged(path, { task });
      await until(() => readLocalQueue().items.some((t) => t.ledger === path && t.state === "waiting"), "真实队列已在阻塞票据之后等待");
      assert.equal(existsSync(invoked), false); await stopKernel(path, false, task); await job; job = undefined;
      assert.equal(existsSync(invoked), false); releaseLocalSlot(blocker.id, blocker.token, true); blocker = undefined;
      const opens = () => existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).length : 0, before = opens();
      const args = [mode === "terminal-node-worker" ? "重跑" : "续跑", f.file, ...(task ? ["--task", "甲"] : []), ...(mode === "terminal-node-worker" ? ["--node", "测试"] : []), ...(mode === "override-background" ? ["--launcher", "background"] : []), "--json"];
      await kernelCLI(parseArgs(args), f.repo);
      await until(() => !!readTaskRun(path!, task).repair, "测试产品返修信封已登记");
      if (mode.startsWith("terminal")) await until(() => readTaskRun(path!, task).terminal?.state === "requested" && opens() === before + 1, "节点 worker 的返修也已请求可见窗口");
      const current = readTaskRun(path, task); assert.equal(current.counters!.测试!.repairs, 1); assert.equal(current.session!.id, oldSession.id); assert.equal(current.worktree, run.worktree);
      assert.equal(readFileSync(invoked, "utf8"), "ran", "停止不重放原命令，恢复只执行一次");
      assert.deepEqual(current.candidate, checkedCandidate); assert.deepEqual(readRun(path).results.filter((r) => r.node === "开发评审").map((r) => r.id), reviewed, "有效评审不重跑，候选和来源不换");
      if (mode.startsWith("terminal")) {
        assert.equal(opens(), before + 1, "默认恢复必须请求原任务可见返修窗口，不能 print"); assert.equal(current.launchMode, "terminal"); assert.equal(current.terminal!.state, "requested");
        assert.equal(ownedProcessGroupAlive(current.launch!), false, "未偷偷派发后台开发宿主");
        await kernelCLI(parseArgs(args), f.repo); assert.equal(opens(), before + 1, "待认领窗口不重复派工");
      } else {
        await until(() => { const r = readTaskRun(path!, task); return !!r.launch && r.launch.pid !== run.launch?.pid && r.session?.launchId === r.launch.token; }, "原会话已精确后台恢复");
        assert.equal(opens(), before); assert.equal(readTaskRun(path, task).launchMode, "background");
        const argv = JSON.parse(readFileSync(join(run.dir, "host-argv.json"), "utf8")); assert.ok(argv.includes("-p")); assert.ok(argv.includes(oldSession.log!));
      }
    } finally {
      if (path) await stopKernel(path); await job;
      if (blocker) releaseLocalSlot(blocker.id, blocker.token, true);
      finishFixture(f);
    }
  }
});
