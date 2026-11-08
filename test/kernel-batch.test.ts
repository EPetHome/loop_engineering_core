import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";
import { kernelFixture, fakeKernelLauncher, reviewer } from "./helpers/kernel-fixture.ts";
import { legacyKernelInputs } from "./helpers/legacy-kernel-inputs.ts";
import { contributionProblems, createKernelRun, currentCandidate, executeNode, qualification, queryKernel } from "../kernel.ts";
import { readRun, readTaskRun, taskDefinition, taskIds, taskView, updateRun, updateTaskRun } from "../node-ledger.ts";
import { checkInputs, deliverCandidate, workspaceGuard } from "../kernel-workspace.ts";
import { advanceBatch, advanceManaged, attachSession, completeManagedDelivery, consumeManagedRepair, continueAcceptanceTask, prepareManagedContinuation, mergeManaged, recordManagedUserInput } from "../kernel-session.ts";
import { integrateTask, recoverBatchIntegration } from "../batch-integration.ts";
import { applyPendingCardChange, reconcileRemovedGate, recordCardControl, requestCardChange } from "../kernel-controls.ts";
import { abandonKernel, integrateKernel, launchKernel, managedLaunchArgs, releaseKernelWorkspace, resumeManaged, resumeTerminalTasks, settleTaskRemoval, stopKernel } from "../kernel-runtime.ts";
import { readLocalQueue } from "../local-node-queue.ts";
import { createChildExec, handleReviewEvent } from "../hosts/review-hook.ts";
import { developerActive } from "../kernel-session.ts";
import { runTestNode } from "../test-node.ts";
import { parseArgs } from "../loop.ts";
import { kernelCLI } from "../kernel-cli.ts";
import { ownedProcessGroupAlive, processStartTime } from "../procs.ts";
const TESTER = fileURLToPath(new URL("./fake-tester.mjs", import.meta.url));
function fixture(names = ["甲", "乙"], results: { fail?: string[]; unknown?: string[] }[] = []) {
  const f = kernelFixture(["开发评审", "测试", "验收"], "printf 'ok\\n'");
  const standard = join(f.repo, "验收标准.md");
  writeFileSync(join(f.repo, ".autoreview.json"), JSON.stringify({ release: "dev", localFiles: ["local.txt"], acceptance: { reset: "printf reset", cleanup: "printf released" } }));
  f.card.tasks = names.map((name) => ({ name, prompt: "prompt.md", scope: [`${name}.txt`], test: "printf ok" })); f.card.acceptance = "验收标准.md";
  for (const name of names) writeFileSync(join(f.repo, `${name}.txt`), "base\n");
  writeFileSync(standard, `## 验收标准\n${names.flatMap((name) => [1, 2].map((n) => `[${name}] 操作：执行功能 ${name}${n}\n    预期：看到了结果`)).map((text, i) => `A${i + 1}. ${text}`).join("\n")}\n`);
  writeFileSync(f.file, JSON.stringify(f.card)); f.git(f.repo, "add", "."); f.git(f.repo, "commit", "-qm", "batch fixture");
  Object.assign(process.env, { AUTOREVIEW_ACCEPTANCE_CMD: TESTER, FAKE_STATE_DIR: join(f.root, "tester"), FAKE_ACC_MODE: "pass", FAKE_ACC_RESULTS: JSON.stringify(results), FAKE_ACC_FAIL: "", FAKE_ACC_FAIL_ONCE: "", FAKE_ACC_UNKNOWN: "" });
  const calls = () => existsSync(join(f.root, "tester", "acc-calls.log")) ? readFileSync(join(f.root, "tester", "acc-calls.log"), "utf8").trim().split("\n").map((line) => {
    const [round, input, , runDir] = line.split("\t"), section = readFileSync(input, "utf8").split(/^## 验收标准（.*$/m)[1]?.split(/^## /m)[0] ?? "";
    return { round: Number(round), ids: [...section.matchAll(/^(A\d+)\./gm)].map((m) => m[1]), runDir };
  }) : [];
  const deliver = async (path: string, name: string, text = `${name} changed\n`) => {
    const run = readTaskRun(path, name); writeFileSync(join(run.worktree, `${name}.txt`), text);
    return completeManagedDelivery(path, "【交付完成】", { exec: f.exec, callReviewer: reviewer, task: run.taskId });
  };
  return { ...f, standard, calls, deliver };
}
async function until(predicate: () => boolean, label: string, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) { if (Date.now() >= deadline) throw new Error(`等待超时：${label}`); await sleep(20); }
}
test("统一验收向独立验收方明确只读候选及临时副本运行边界", async () => {
  const f = fixture();
  try {
    const path = f.start(); await f.deliver(path, "甲");
    const b = readTaskRun(path, "乙"); writeFileSync(join(b.worktree, "乙.txt"), "B changed\n");
    let calls = 0;
    await completeManagedDelivery(path, "【交付完成】", { exec: f.exec, callReviewer: reviewer, task: b.taskId, acceptanceExec: async (cmd, args, opts) => {
      calls++; assert.equal(opts.env?.GIT_OPTIONAL_LOCKS, "0", "验收方及其 Git 只读命令不能触发 index 刷新"); return f.exec(cmd, args, opts);
    } });
    assert.ok(calls > 0);
    const run = readRun(path), text = readFileSync(join(f.calls()[0].runDir, "input.md"), "utf8");
    assert.ok(text.includes(run.candidate!.commit));
    assert.match(text, /受检工作区是只读候选/); assert.match(text, /包括被 Git 忽略的 node_modules、dist/);
    assert.match(text, /系统临时目录/); assert.match(text, /不得把另一版本的结果当成当前通过/);
    assert.equal(run.results.filter((r) => r.node === "验收").at(-1)!.status, "通过");
  } finally { f.cleanup(); }
});
test("A4：缺验收/归属、多义/未知/非法路径/空标准/重复任务/逆序/缺命令均在资源前拒绝", () => {
  const f = fixture();
  try {
    const refs = f.git(f.repo, "show-ref"), trees = f.git(f.repo, "worktree", "list", "--porcelain"), original = readFileSync(f.standard, "utf8");
    const reject = (mutate: (c: any) => void, error: RegExp, standard = original) => {
      const c = structuredClone(f.card); mutate(c); writeFileSync(f.file, JSON.stringify(c)); writeFileSync(f.standard, standard);
      assert.throws(() => createKernelRun(f.file, f.repo), error);
      assert.equal(f.git(f.repo, "show-ref"), refs); assert.equal(f.git(f.repo, "worktree", "list", "--porcelain"), trees); assert.equal(existsSync(join(f.root, "kernel")), false);
    };
    reject((c) => c.flow.splice(2, 1), /并行批次必须带验收/);
    reject(() => {}, /A1.*归属缺失/, original.replace("[甲]", ""));
    reject(() => {}, /A1.*归属多义/, original.replace("[甲]", "[甲] [乙]"));
    reject(() => {}, /A1.*归属未知/, original.replace("[甲]", "[陌生]"));
    reject((c) => c.acceptance = "/tmp/standard", /相对/);
    reject(() => {}, /标准为空/, "## 验收标准\n");
    reject(() => {}, /A1.*标准为空/, "## 验收标准\nA1. [甲]\n");
    reject((c) => c.tasks[1].name = "甲", /任务重名/);
    reject((c) => c.flow = ["开发评审", "验收", "测试"], /逆序/);
    reject((c) => delete c.tasks[1].test, /乙.*测试命令/);
  } finally { f.cleanup(); }
});
test("显式任务上下文不串账；单账本 query 只读；同名跨仓库身份隔离", async () => {
  const f = fixture();
  try {
    const path = f.start(), run = readRun(path); assert.equal(taskIds(run).length, 2);
    assert.throws(() => taskDefinition(run), /显式/); assert.throws(() => readTaskRun(path, "不存在"), /未知/);
    const result = await f.deliver(path, "乙"); assert.equal(result.status, "没验证");
    assert.equal(readRun(path).batch!.contributions.length, 1); assert.equal(readRun(path).batch!.contributions[0].task, readTaskRun(path, "乙").taskId);
    assert.equal(readRun(path).results.filter((r) => r.task === readTaskRun(path, "甲").taskId).length, 0);
    const original = readFileSync(path, "utf8"); queryKernel(path); assert.equal(readFileSync(path, "utf8"), original);
    const other = kernelFixture(["开发评审"]);
    try { const p = other.start(); assert.notEqual(readRun(p).id, run.id); assert.notEqual(p, path); } finally { other.cleanup(); }
  } finally { f.cleanup(); }
});
test("头less续跑精确原会话及任务，机器继续信封不更新授权/用户版本或清零次数", () => {
  const f = fixture();
  try {
    const path = f.start(), a = readTaskRun(path, "甲"); attachSession(path, "pi", "original-a", join(a.dir, "session.jsonl"), a.taskId);
    updateTaskRun(path, a.taskId, (r) => { r.repairs = 2; r.counters = { 验收: { repairs: 2, recoveries: 1 } }; });
    prepareManagedContinuation(path, a.taskId!); const run = readTaskRun(path, "甲"), launch = managedLaunchArgs(path, a.taskId);
    assert.equal(launch.env.AUTOREVIEW_KERNEL_TASK, a.taskId); assert.ok(launch.args.includes(run.session!.log!)); assert.ok(launch.args.includes(`@${run.repair!.file}`)); assert.deepEqual(launch.args.slice(-2), ["--", "-p"]);
    assert.equal(consumeManagedRepair(path, `@"${run.repair!.file}"`, { files: [{ path: run.repair!.file, text: run.repair!.message }] }, a.taskId), true);
    assert.equal(readTaskRun(path, "甲").repairs, 2); assert.equal(readTaskRun(path, "甲").counters!.验收!.repairs, 2); assert.equal(readTaskRun(path, "甲").userVersion, 0);
  } finally { f.cleanup(); }
});
test("原生交互续跑去掉 print，保留原任务/会话；无终端拒绝，整批拆成独立窗口", async () => {
  const f = fixture();
  try {
    const path = f.start(), a = readTaskRun(path, "甲"); attachSession(path, "pi", "original-a", join(a.dir, "session.jsonl"), a.taskId);
    updateTaskRun(path, a.taskId, (r) => { r.repairs = 2; });
    const original = readFileSync(path, "utf8"), normal = managedLaunchArgs(path, a.taskId), native = managedLaunchArgs(path, a.taskId, true);
    assert.deepEqual(normal.args.slice(-2), ["--", "-p"]); assert.equal(native.args.includes("-p"), false);
    assert.equal(native.cwd, a.worktree); assert.equal(native.env.AUTOREVIEW_KERNEL_TASK, a.taskId); assert.ok(native.args.includes(join(a.dir, "session.jsonl")));
    const args = { command: "续跑", batch: f.file, task: "甲", launcher: "terminal", dryRun: true, json: false, rest: [] };
    assert.match((await kernelCLI(args, f.repo))!.lines.join("\n"), /原生 Pi 界面/);
    await assert.rejects(() => kernelCLI({ ...args, json: true }, f.repo), /不带 --json/);
    const batch = (await kernelCLI({ ...args, task: undefined }, f.repo))!;
    assert.equal(batch.commands.length, 2); assert.match(batch.lines[0], /独立原生 Pi 窗口/);
    assert.match((await kernelCLI({ ...args, command: "启动", task: undefined }, f.repo))!.lines.join("\n"), /原生 Pi 界面/);
    if (!process.stdin.isTTY || !process.stdout.isTTY) await assert.rejects(() => kernelCLI({ ...args, dryRun: false }, f.repo), /需要交互终端/);
    assert.equal(readFileSync(path, "utf8"), original, "只读预检和被拒的入口不改变会话、次数或账本");
  } finally { f.cleanup(); }
});
test("关闭窗口后只刷新过期的开发续跑信封，原会话/次数/历史保留", () => {
  const f = fixture();
  try {
    const path = f.start(), a = readTaskRun(path, "甲"); attachSession(path, "pi", "original-a", join(a.dir, "session.jsonl"), a.taskId);
    updateTaskRun(path, a.taskId, (r) => { r.repairs = 2; }); prepareManagedContinuation(path, a.taskId!);
    const old = readTaskRun(path, "甲").repair!;
    updateTaskRun(path, a.taskId, (r) => { r.epoch = (r.epoch ?? 0) + 1; }); prepareManagedContinuation(path, a.taskId!);
    const current = readTaskRun(path, "甲"); assert.notEqual(current.repair!.id, old.id); assert.equal(current.repair!.epoch, current.epoch);
    assert.equal(current.repairs, 2); assert.equal(current.session!.id, "original-a"); assert.equal(existsSync(old.file), true);
    prepareManagedContinuation(path, a.taskId!); assert.equal(readTaskRun(path, "甲").repair!.id, current.repair!.id);
  } finally { f.cleanup(); }
});
test("原生窗口流水线逐任务开独立窗口，参数安全传递；部分失败不重派，活动任务拒绝重复开窗", () => {
  const f = fixture(["甲'一", "乙"]);
  try {
    const path = f.start(), original = readFileSync(path, "utf8"), calls: any[] = [];
    const execute = ((command: string, args: string[]) => { calls.push({ command, args }); return { status: calls.length === 1 ? 0 : 1, stderr: "fixture refusal" }; }) as typeof spawnSync;
    const result = resumeTerminalTasks(path, false, execute);
    assert.equal(result.ok, false); assert.deepEqual(result.opened, ["甲'一"]); assert.equal(calls.length, 2);
    assert.equal(calls[0].command, "osascript"); assert.match(calls[0].args[1], /item 1 of argv/);
    assert.ok(calls[0].args[2].includes("'甲'\\''一'")); assert.match(calls[0].args[2], /'--launcher' 'terminal'/);
    assert.equal(readFileSync(path, "utf8"), original, "开窗只是启动请求，不冒充已接续或改任务身份");
    updateTaskRun(path, "乙", (r) => { r.activity = { id: "active", node: "开发评审", kind: "developing", pid: process.pid, started: processStartTime(process.pid) }; });
    assert.throws(() => resumeTerminalTasks(path, false, execute), /仍活动/); assert.equal(calls.length, 2);
  } finally { f.cleanup(); }
});
test("只修乙测试命令可在甲开发时生效，甲活动/评审输入不变，全局改变仍等待边界", () => {
  const f = fixture();
  try {
    const path = f.start(); updateTaskRun(path, "甲", (r) => { r.activity = { id: "dev-a", node: "开发评审", kind: "developing", pid: process.pid, started: processStartTime(process.pid) }; });
    const before = readTaskRun(path, "甲"), reviewed = checkInputs(before, "开发评审").hash;
    const bReview = checkInputs(readTaskRun(path, "乙"), "开发评审").hash, bTest = checkInputs(readTaskRun(path, "乙"), "测试").hash;
    const change = requestCardChange(path, { from: f.replacement((c) => { c.tasks[1].test = "printf changed"; }), source: "cli:automation" });
    assert.equal(change.state, "applied"); assert.deepEqual(readTaskRun(path, "甲").activity, before.activity); assert.equal(readTaskRun(path, "甲").epoch, before.epoch);
    assert.equal(checkInputs(readTaskRun(path, "甲"), "开发评审").hash, reviewed); assert.equal(checkInputs(readTaskRun(path, "乙"), "开发评审").hash, bReview);
    assert.notEqual(checkInputs(readTaskRun(path, "乙"), "测试").hash, bTest);
    const global = requestCardChange(path, { from: f.replacement((c) => { c.limits = { 测试: { timeoutMin: 25 } }; }), source: "cli:automation" });
    assert.equal(global.state, "pending"); assert.deepEqual(readTaskRun(path, "甲").activity, before.activity);
  } finally { f.cleanup(); }
});
test("废弃 gate 删除须有匹配原配置，不接纳其他变更，保留旧哈希且不改变检查输入", async () => {
  const f = fixture();
  try {
    const cfg = join(f.repo, ".autoreview.json"), raw = JSON.parse(readFileSync(cfg, "utf8")); raw.gate = { cmd: "obsolete" };
    writeFileSync(cfg, JSON.stringify(raw)); const original = join(f.root, "original.json"); writeFileSync(original, readFileSync(cfg));
    const path = f.start(), run = readRun(path), before = run.localHashes[".autoreview.json"];
    delete raw.gate; const bytes = JSON.stringify(raw), roots = [run.repo, run.worktree, ...run.taskRecords!.map((t) => t.worktree)];
    for (const root of roots) writeFileSync(join(root, ".autoreview.json"), bytes);
    const input = checkInputs(readTaskRun(path, "甲"), "开发评审").hash;
    writeFileSync(cfg, JSON.stringify({ ...raw, reviewerThinking: "low" })); assert.throws(() => reconcileRemovedGate(path, original), /不只是删除/);
    assert.equal(readRun(path).localHashes[".autoreview.json"], before); writeFileSync(cfg, bytes);
    const evidence = reconcileRemovedGate(path, original), after = readRun(path);
    assert.equal(after.localHashHistory![0].before, before); assert.notEqual(after.localHashes[".autoreview.json"], before); assert.equal(existsSync(evidence), true);
    assert.equal(checkInputs(readTaskRun(path, "甲"), "开发评审").hash, input); assert.equal(reconcileRemovedGate(path, original), evidence);
    await f.deliver(path, "甲"); assert.equal(readRun(path).batch!.contributions.length, 1, "严格集成校验使用已证明的配置迁移，而非跳过校验");
  } finally { f.cleanup(); }
});
test("受控改测试后汇总只同步登记的新卡，业务贡献与检查仍按原任务核对", async () => {
  const f = fixture();
  try {
    const path = f.start(), change = requestCardChange(path, { from: f.replacement((c) => { c.tasks[0].test = "printf changed"; }), source: "cli:automation" });
    assert.equal(change.state, "applied");
    await f.deliver(path, "甲"); await f.deliver(path, "乙");
    const run = readRun(path); assert.equal(queryKernel(path).status, "可合入");
    assert.equal(f.git(run.worktree, "show", "HEAD:开发卡.json"), readFileSync(f.file, "utf8").trim());
    assert.equal(run.batch!.contributions.length, 2); assert.equal(f.calls().length, 1);
  } finally { f.cleanup(); }
});
test("A6：只退甲，甲原通过项也重验，乙分支/检查不变，精确两次调用无末尾 full，合法映射推 bare origin/dev", async () => {
  const f = fixture(["甲", "乙"], [{ fail: ["A1"] }, {}]);
  try {
    f.card.flow.push("提交"); writeFileSync(f.file, JSON.stringify(f.card));
    const path = f.start();
    assert.equal((await f.deliver(path, "乙")).status, "没验证");
    const before = readTaskRun(path, "乙"), count = readRun(path).results.filter((r) => r.task === before.taskId).length;
    const failed = await f.deliver(path, "甲"); assert.equal(failed.failure, "product", JSON.stringify(failed));
    assert.match(failed.message!, /A1\./); assert.equal(failed.message!.includes("A3."), false);
    assert.equal(readTaskRun(path, "乙").repair, undefined); assert.deepEqual(f.calls().map((c) => c.ids), [["A1", "A2", "A3", "A4"]]);
    assert.equal(readTaskRun(path, "甲").counters!.验收!.repairs, 1);
    const output = await f.deliver(path, "甲", "甲 repaired\n"); assert.equal(output.status, "通过", JSON.stringify(queryKernel(path)));
    assert.deepEqual(f.calls().map((c) => c.ids), [["A1", "A2", "A3", "A4"], ["A1", "A2"]]);
    assert.equal(readTaskRun(path, "乙").candidate!.commit, before.candidate!.commit); assert.equal(readRun(path).results.filter((r) => r.task === before.taskId).length, count);
    const after = readRun(path); assert.equal(after.publication!.push, "成功"); assert.equal(f.git(f.origin, "rev-parse", "dev"), after.publication!.commit);
    assert.deepEqual(f.git(f.origin, "for-each-ref", "--format=%(refname)"), "refs/heads/dev");
    assert.equal(after.acceptanceState!.bindings!.A3.round, 1); assert.notEqual(after.acceptanceState!.bindings!.A3.tree, after.candidate!.tree); assert.match(after.acceptanceState!.bindings!.A3.reason!, /未在新树实测/);
    assert.equal(after.publication!.taskChecks!.length, 2); assert.equal(new Set(after.publication!.taskChecks!.map((c) => c.candidate.tree)).has(after.publication!.tree), false, "合法任务树与批次树不同不妨碍发布");
    const checks = queryKernel(path).checks; await releaseKernelWorkspace(path); assert.equal(readRun(path).release.status, "已释放", JSON.stringify(queryKernel(path).release)); assert.deepEqual(queryKernel(path).checks, checks);
    assert.equal(f.git(f.repo, "worktree", "list", "--porcelain").includes(after.worktree), false);
    assert.equal(readLocalQueue().items.length, 0);
  } finally { f.cleanup(); }
});
test("单任务可选验收沿用原工作区；责任任务旧通过项仍重验，无额外 full", async () => {
  const f = fixture(["甲"], [{ fail: ["A1"] }, {}]);
  try {
    const path = f.start(); assert.equal(readRun(path).taskRecords, undefined); assert.equal((await f.deliver(path, "甲")).failure, "product");
    assert.equal((await f.deliver(path, "甲", "fixed\n")).status, "通过"); assert.deepEqual(f.calls().map((c) => c.ids), [["A1", "A2"], ["A1", "A2"]]); assert.equal(queryKernel(path).status, "可合入");
  } finally { f.cleanup(); }
});
test("甲丙同轮返修：甲回来不能验，丙汇入后仅验一次联合集合", async () => {
  const f = fixture(["甲", "乙", "丙"], [{ fail: ["A1", "A5"] }, {}]);
  try {
    const path = f.start(); await f.deliver(path, "乙"); await f.deliver(path, "甲"); await f.deliver(path, "丙");
    assert.deepEqual(readRun(path).acceptanceState!.plan!.repairTasks.sort(), [readTaskRun(path, "甲").taskId, readTaskRun(path, "丙").taskId].sort());
    const round = structuredClone(readRun(path).acceptanceState!.plan!), a = readTaskRun(path, "甲");
    recordManagedUserInput(path, "补充：修复时保留本任务原有行为", "pi:interactive", undefined, undefined, a.taskId);
    await f.deliver(path, "甲", "甲 fixed\n"); assert.equal(f.calls().length, 1);
    assert.deepEqual(readRun(path).acceptanceState!.plan!.repairTasks, round.repairTasks); assert.deepEqual(readRun(path).acceptanceState!.plan!.waitFor, round.waitFor);
    assert.equal(readTaskRun(path, "甲").counters!.验收!.repairs, 1); assert.equal(readTaskRun(path, "丙").counters!.验收!.repairs, 1);
    await advanceBatch(path); assert.equal(f.calls().length, 1);
    await f.deliver(path, "丙", "丙 fixed\n");
    assert.deepEqual(f.calls().map((c) => c.ids), [["A1", "A2", "A3", "A4", "A5", "A6"], ["A1", "A2", "A5", "A6"]]);
    assert.equal(queryKernel(path).status, "可合入");
  } finally { f.cleanup(); }
});
test("真实补充要求不能掩盖共享验收方法变化；原范围/责任集合及沿用材料保留", async () => {
  const f = fixture(["甲", "乙"], [{ fail: ["A1"] }]);
  try {
    const path = f.start(); await f.deliver(path, "甲"); await f.deliver(path, "乙");
    const before = structuredClone(readRun(path).acceptanceState!), a = readTaskRun(path, "甲");
    recordManagedUserInput(path, "补充要求", "pi:interactive", undefined, undefined, a.taskId);
    const config = JSON.parse(readFileSync(join(f.repo, ".autoreview.json"), "utf8")); config.acceptance.reset = "printf changed-method"; writeFileSync(join(f.repo, ".autoreview.json"), JSON.stringify(config));
    const result = await f.deliver(path, "甲", "甲 fixed\n"); assert.equal(result.status, "中断"); assert.match(result.reason!, /共享验收方法|受控确认/);
    const after = readRun(path).acceptanceState!; assert.equal(f.calls().length, 1); assert.deepEqual(after.plan!.ids, before.plan!.ids); assert.deepEqual(after.plan!.repairTasks, before.plan!.repairTasks);
    assert.deepEqual(after.bindings, before.bindings); assert.equal(readTaskRun(path, "甲").counters!.验收!.repairs, 1); assert.equal(after.planRefreshes, undefined);
  } finally { f.cleanup(); }
});
test("重复交付只集成一次；候选替换/吸收其他来源后移出，不重新带回移出代码；剩余完整重验一次", async () => {
  const f = fixture(["甲", "乙"], [{ fail: ["A1"] }, {}]);
  try {
    const path = f.start(); await f.deliver(path, "甲"); const first = readRun(path).batch!.integrations.length;
    assert.equal(integrateTask(path, readTaskRun(path, "甲").taskId!).ok, true); assert.equal(readRun(path).batch!.integrations.length, first);
    const batch = readRun(path), b = readTaskRun(path, "乙");
    f.git(b.worktree, "merge", "--no-ff", "-m", "absorb registered batch", batch.candidate!.commit);
    await f.deliver(path, "乙"); assert.equal(f.calls().length, 1);
    const root = readRun(path); assert.equal(f.git(root.worktree, "show", "HEAD:甲.txt"), "甲 changed");
    assert.throws(() => requestCardChange(path, { removeTask: "甲", source: "machine:managed-session" }), /真实用户决定/);
    recordCardControl(path, "移出任务甲", "pi:interactive");
    const change = requestCardChange(path, { removeTask: "甲", source: "machine:managed-session" }); assert.equal(change.state, "pending");
    await settleTaskRemoval(path); assert.equal(readRun(path).changes!.at(-1)!.state, "applied", JSON.stringify(queryKernel(path)));
    assert.equal(readFileSync(f.standard, "utf8").includes("[甲]"), true, "原标准不删改");
    assert.equal(f.git(readRun(path).worktree, "show", "HEAD:甲.txt"), "base"); assert.equal(f.git(readRun(path).worktree, "show", "HEAD:乙.txt"), "乙 changed");
    await advanceBatch(path); assert.deepEqual(f.calls().map((c) => c.ids), [["A1", "A2", "A3", "A4"], ["A3", "A4"]]);
    assert.equal(readRun(path).batch!.removed.length, 1); assert.ok(readRun(path).batch!.integrations.at(-1)!.history);
  } finally { f.cleanup(); }
});
test("改任务测试只失效该任务测试及责任验收项；标准改版必须真实确认，旧授权/例外失效", async () => {
  const f = fixture();
  try {
    const path = f.start(); await f.deliver(path, "甲"); await f.deliver(path, "乙");
    const a = readTaskRun(path, "甲"), b = readTaskRun(path, "乙"), review = checkInputs(a, "开发评审").hash, other = readRun(path).results.filter((r) => r.task === b.taskId).length;
    const from = f.replacement((c) => c.tasks[0].test = "printf changed-test"); requestCardChange(path, { from, source: "cli:automation" });
    assert.equal(checkInputs(readTaskRun(path, "甲"), "开发评审").hash, review); await advanceManaged(path, { task: a.taskId, testExec: f.exec });
    assert.deepEqual(f.calls().map((c) => c.ids), [["A1", "A2", "A3", "A4"], ["A1", "A2"]]); assert.equal(readRun(path).results.filter((r) => r.task === b.taskId).length, other);
    const standardVersion = readRun(path).acceptanceState!.criteria.version;
    writeFileSync(f.standard, readFileSync(f.standard, "utf8").replace("看到了结果", "符合新标准"));
    const confirm = f.replacement(() => {});
    assert.throws(() => requestCardChange(path, { from: confirm, source: "machine:managed-session" }), /真实用户决定/);
    recordCardControl(path, "确认本批验收标准", "pi:interactive"); requestCardChange(path, { from: confirm, source: "machine:managed-session" });
    assert.equal(readRun(path).acceptanceState!.criteria.version, standardVersion + 1); assert.equal(readRun(path).acceptanceState!.grants, undefined);
    await advanceBatch(path); assert.deepEqual(f.calls().at(-1)!.ids, ["A1", "A2", "A3", "A4"]);
  } finally { f.cleanup(); }
});
test("验收上限三选一；只提高责任任务额度，次数不清零，机器不能代选", async () => {
  const f = fixture(["甲", "乙"], [{ fail: ["A1"] }]);
  try {
    f.card.limits = { 验收: { maxRepairs: 0, timeoutMin: 1 } }; writeFileSync(f.file, JSON.stringify(f.card));
    const path = f.start(); await f.deliver(path, "乙"); await f.deliver(path, "甲");
    const a = readTaskRun(path, "甲"); assert.equal(a.stopped, true); assert.match(a.stopReason!, /--from.*--remove-task.*放弃/s); assert.equal(a.counters!.验收!.repairs, 0);
    updateTaskRun(path, a.taskId, (r) => { r.stopped = false; });
    assert.throws(() => developerActive(path, a.taskId), /额度/); assert.equal((await f.deliver(path, "甲", "manual bypass\n")).status, "中断");
    assert.equal(readTaskRun(path, "甲").counters!.验收!.repairs, 0); updateTaskRun(path, a.taskId, (r) => { r.stopped = true; });
    const from = f.replacement((c) => c.tasks[0].limits = { 验收: { maxRepairs: 2 } });
    assert.throws(() => requestCardChange(path, { from, source: "machine:managed-session" }), /真实用户决定/);
    recordCardControl(path, "继续修任务甲", "pi:rpc"); requestCardChange(path, { from, source: "machine:managed-session" });
    continueAcceptanceTask(path, a.taskId); assert.equal(readTaskRun(path, "甲").counters!.验收!.repairs, 1); assert.equal(readTaskRun(path, "乙").counters!.验收, undefined);
    assert.equal(readRun(path).card.tasks[1].limits, undefined); assert.equal(readTaskRun(path, "甲").repair!.node, "验收");
  } finally { f.cleanup(); }
});
test("A5：真实两个宿主进程有屏障证明重叠，先就绪乙先汇入；测试/验收同一槽，全部资源按身份释放", async () => {
  const f = fixture(); let path: string | undefined;
  try {
    fakeKernelLauncher(f); process.env.FAKE_STATE_DIR = join(f.root, "tester"); const barrier = join(f.root, "barrier"); mkdirSync(barrier); process.env.KERNEL_FAKE_BARRIER = barrier;
    const worker = join(f.root, "slot-worker.mjs");
    writeFileSync(worker, `import {existsSync,writeFileSync} from 'node:fs'; import {join} from 'node:path'; import {setTimeout as sleep} from 'node:timers/promises';\nconst [root,name]=process.argv.slice(2);\nif(name==='验收') {const overlap=['甲','乙'].some(n=>existsSync(join(root,n+'.test.started'))&&!existsSync(join(root,n+'.test.ended')));writeFileSync(join(root,'acceptance-safety.json'),JSON.stringify({overlap,at:Date.now(),pid:process.pid}));if(overlap)process.exit(92);}else {writeFileSync(join(root,name+'.test.started'),JSON.stringify({at:Date.now(),pid:process.pid}));const deadline=Date.now()+45000;while(!existsSync(join(root,name+'.test.go'))){if(Date.now()>deadline)process.exit(91);await sleep(20);}writeFileSync(join(root,name+'.test.ended'),JSON.stringify({at:Date.now(),pid:process.pid}));}`);
    for (const t of f.card.tasks) t.test = `node '${worker}' '${barrier}' '${t.name}'`;
    writeFileSync(f.file, JSON.stringify(f.card));
    const config = JSON.parse(readFileSync(join(f.repo, ".autoreview.json"), "utf8")); config.acceptance.reset = `node '${worker}' '${barrier}' '验收'`; writeFileSync(join(f.repo, ".autoreview.json"), JSON.stringify(config));
    path = f.start(); await launchKernel(path, true);
    await until(() => ["甲", "乙"].every((n) => existsSync(join(barrier, `${n}.started`))), "两个独立宿主到屏障");
    const run = readRun(path), [a, b] = [readTaskRun(path, "甲"), readTaskRun(path, "乙")];
    assert.notEqual(a.launch!.pid, b.launch!.pid); assert.equal(ownedProcessGroupAlive(a.launch!), true); assert.equal(ownedProcessGroupAlive(b.launch!), true);
    assert.equal(a.activity!.kind, "developing"); assert.equal(b.activity!.kind, "developing"); assert.notEqual(a.session!.id, b.session!.id);
    assert.equal(readLocalQueue().items.length, 0, "开发不占本机槽");
    writeFileSync(join(barrier, "乙.go"), "go"); await until(() => existsSync(join(barrier, "乙.test.started")), "乙测试取得槽");
    assert.equal(readTaskRun(path, "甲").activity!.kind, "developing");
    writeFileSync(join(barrier, "甲.go"), "go"); await until(() => readLocalQueue().items.length === 2, "甲测试排队");
    assert.equal(readLocalQueue().items.filter((t) => t.state === "active").length, 1); assert.equal(readTaskRun(path, "甲").activity!.kind, "waiting");
    assert.equal(existsSync(join(barrier, "甲.test.started")), false);
    writeFileSync(join(barrier, "乙.test.go"), "go"); await until(() => readRun(path!).batch!.contributions.length === 1 && existsSync(join(barrier, "甲.test.started")), "乙先汇入而甲仍测试");
    assert.equal(readRun(path).batch!.contributions[0].task, b.taskId); assert.equal(f.calls().length, 0);
    writeFileSync(join(barrier, "甲.test.go"), "go"); await until(() => queryKernel(path!).status === "可合入", "全部汇入后统一验收");
    const endedB = JSON.parse(readFileSync(join(barrier, "乙.test.ended"), "utf8")), startedA = JSON.parse(readFileSync(join(barrier, "甲.test.started"), "utf8"));
    assert.ok(endedB.at <= startedA.at); assert.equal(JSON.parse(readFileSync(join(barrier, "acceptance-safety.json"), "utf8")).overlap, false);
    await until(() => readRun(path!).taskRecords!.every((t) => ownedProcessGroupAlive(t.supervisor!) === false), "启动消费者结束");
    assert.deepEqual(readRun(path).batch!.integrations.map((i) => i.task), [b.taskId, a.taskId]); assert.equal(f.calls().length, 1);
    assert.equal(readLocalQueue().items.length, 0); const q = await abandonKernel(path, "terminal:tty"); assert.equal(q.release.status, "已释放", JSON.stringify(q.release));
    assert.equal(existsSync(run.worktree), false); for (const t of run.taskRecords!) assert.equal(existsSync(t.worktree), false);
  } finally { if (path) await stopKernel(path).catch(() => {}); f.cleanup(); }
});
test("集成冲突只回本任务原会话；保留批次头/其他任务结果，不扣验收次数", async () => {
  const f = fixture();
  try {
    for (const t of f.card.tasks) t.scope.push("shared.txt"); writeFileSync(f.file, JSON.stringify(f.card));
    writeFileSync(join(f.repo, "shared.txt"), "base\n"); f.git(f.repo, "add", "."); f.git(f.repo, "commit", "-qm", "shared fixture");
    const path = f.start(), a = readTaskRun(path, "甲"), b = readTaskRun(path, "乙");
    attachSession(path, "pi", "original-a", join(a.dir, "session"), a.taskId); attachSession(path, "pi", "original-b", join(b.dir, "session"), b.taskId);
    writeFileSync(join(b.worktree, "shared.txt"), "B\n"); await f.deliver(path, "乙"); const head = readRun(path).candidate!.commit, count = readRun(path).results.filter((r) => r.task === b.taskId).length;
    writeFileSync(join(a.worktree, "shared.txt"), "A\n"); const output = await f.deliver(path, "甲");
    assert.match(output.message!, /汇入冲突/); assert.match(output.message!, /已集成来源/); assert.equal(readTaskRun(path, "甲").repair!.session, "original-a");
    assert.equal(readRun(path).candidate!.commit, head); assert.equal(readRun(path).results.filter((r) => r.task === b.taskId).length, count); assert.equal(f.calls().length, 0);
    assert.equal(readTaskRun(path, "乙").repair, undefined); assert.equal(readTaskRun(path, "甲").counters?.验收, undefined);
    assert.throws(() => consumeManagedRepair(path, output.message!, undefined, b.taskId), /任务|会话/);
    assert.equal(consumeManagedRepair(path, output.message!, undefined, a.taskId), true);
  } finally { f.cleanup(); }
});
test("同文件混合来源无法证明时暂停具体任务；不猜删除或重新带入撤回代码", async () => {
  const f = fixture();
  try {
    f.card.tasks[1].scope.push("甲.txt"); writeFileSync(f.file, JSON.stringify(f.card)); const path = f.start();
    await f.deliver(path, "甲"); const before = readRun(path).candidate!.commit, b = readTaskRun(path, "乙");
    f.git(b.worktree, "merge", "--no-ff", "-m", "absorb", readTaskRun(path, "甲").candidate!.commit); const result = await f.deliver(path, "乙");
    assert.match(result.reason!, /同文件混合贡献/); assert.equal(readRun(path).candidate!.commit, before); assert.equal(readTaskRun(path, "甲").repair, undefined);
  } finally { f.cleanup(); }
});
test("任务停止/迟到回包不停止其他真实活动、不覆盖新尝试；查询无副作用；CLI task 参数一致", async () => {
  const f = fixture();
  try {
    const path = f.start(), a = readTaskRun(path, "甲"), b = readTaskRun(path, "乙");
    developerActive(path, b.taskId);
    let finish!: () => void; const hold = new Promise<void>((ok) => finish = ok);
    const work = executeNode(path, "开发评审", async (i) => { await hold; return { status: "通过", evidence: [i.evidenceDir], operations: [], released: true }; }, { task: a.taskId });
    await stopKernel(path, false, a.taskId);
    assert.equal(readRun(path).stopped, undefined); assert.equal(queryKernel(path).status, "进行中"); assert.equal(readTaskRun(path, "乙").activity!.kind, "developing");
    updateTaskRun(path, a.taskId, (r) => { r.stopped = false; r.activity = { ...b.activity!, id: "new-attempt", kind: "developing", node: "开发评审", pid: process.pid, started: readTaskRun(path, b.taskId).activity!.started }; });
    finish(); assert.equal((await work).stale, true); assert.equal(readTaskRun(path, "甲").activity!.id, "new-attempt"); assert.equal(readRun(path).results.at(-1)!.status, "中断");
    const raw = readFileSync(path, "utf8"); queryKernel(path); assert.equal(readFileSync(path, "utf8"), raw);
    const args = parseArgs(["重跑", f.file, "--node", "测试", "--task", "甲", "--dry-run", "--json"]); assert.equal(args.task, "甲"); assert.equal((await kernelCLI(args, f.repo))!.kernel, 1);
    assert.throws(() => parseArgs(["合入", f.file, "--task", "甲"]), /--task/);
    await assert.rejects(() => kernelCLI(parseArgs(["重跑", f.file, "--node", "验收", "--task", "甲", "--dry-run"]), f.repo), /批次级/);
  } finally { f.cleanup(); }
});
test("验收环境失败保留固定范围/通过评审，有限恢复不扣产品次数；写源码后还原仍使结果无效", async () => {
  const f = fixture();
  try {
    const path = f.start(); await f.deliver(path, "甲");
    const fail = async () => ({ code: 75, stdout: "", stderr: "EADDRINUSE", killed: false, processesReleased: true });
    const b = readTaskRun(path, "乙"); writeFileSync(join(b.worktree, "乙.txt"), "B\n");
    const output = await completeManagedDelivery(path, "【交付完成】", { exec: f.exec, callReviewer: reviewer, task: b.taskId, acceptanceExec: fail });
    assert.equal(output.status, "没验证"); const old = readRun(path); assert.equal(old.counters!.验收!.recoveries, 1); assert.equal(old.acceptanceState!.round, 1);
    assert.equal(new Set(output.operations.map((s) => /deadline (\d+)/.exec(s)?.[1]).filter(Boolean)).size, 1, "恢复共用取得槽后的同一 deadline");
    const ids = old.acceptanceState!.plan!.ids; assert.equal(old.taskRecords!.some((t) => !!t.repair), false); assert.equal(old.results.filter((r) => r.node === "开发评审" && r.status === "通过").length, 2);
    updateRun(path, (r) => { r.stopped = false; });
    await advanceBatch(path); assert.deepEqual(f.calls().map((c) => c.ids), [ids]); assert.equal(readRun(path).counters!.验收!.recoveries, 1);
    const a = readTaskRun(path, "甲"), original = readFileSync(join(a.worktree, "甲.txt"), "utf8");
    const from = f.replacement((c) => c.tasks[0].test = "printf new-command"); requestCardChange(path, { from, source: "cli:automation" });
    const mutation = await executeNode(path, "测试", async (i) => { writeFileSync(join(a.worktree, "甲.txt"), "illegal\n"); await sleep(10); writeFileSync(join(a.worktree, "甲.txt"), original); return { status: "通过", evidence: [i.evidenceDir], operations: [], released: true }; }, { task: a.taskId });
    assert.equal(mutation.status, "中断"); assert.equal(readFileSync(join(a.worktree, "甲.txt"), "utf8"), original);
  } finally { f.cleanup(); }
});
test("真实授权不从标准文件获取；拒绝/撤回不改成通过，人工项单列", async () => {
  const f = fixture();
  try {
    writeFileSync(f.standard, readFileSync(f.standard, "utf8").replace("[甲]", "[甲] [授权]") + "同意授权：A1\nA5. [人工] 操作：看布局\n    预期：主观满意\n");
    const path = f.start(); await f.deliver(path, "甲"); const output = await f.deliver(path, "乙");
    assert.match(output.reason!, /授权/); assert.equal(f.calls().length, 0); assert.equal(readRun(path).acceptanceState!.round, 0); assert.equal(readLocalQueue().items.length, 0);
    const a = readTaskRun(path, "甲"); recordManagedUserInput(path, "不授权：A1", "pi:interactive", undefined, undefined, a.taskId);
    updateRun(path, (r) => { r.stopped = false; }); await advanceBatch(path);
    const s = readRun(path).acceptanceState!; assert.equal(s.previous!.items.find((i) => i.id === "A1")!.verdict, "需人工"); assert.equal(s.previous!.items.find((i) => i.id === "A5")!.verdict, "需人工");
    recordManagedUserInput(path, "同意授权：A1", "pi:interactive", undefined, undefined, a.taskId);
    assert.equal(qualification(readRun(path)).missing.some((s) => s.includes("/ 验收 /")), true, "真实授权改变后旧验收不复用");
    await advanceBatch(path); recordManagedUserInput(path, "不授权：A1", "pi:rpc", undefined, undefined, a.taskId);
    assert.deepEqual(readRun(path).acceptanceState!.grants!.approved, []); assert.equal(qualification(readRun(path)).missing.some((s) => s.includes("/ 验收 /")), true, "真实撤权不能沿用原通过结论");
  } finally { f.cleanup(); }
});
test("多任务 dev 前进拒绝未检查树；整合入口给全部原任务引入可核对来源，重新交付后才验收/发布", async () => {
  const f = fixture();
  try {
    const path = f.start(), base = readRun(path).base; await f.deliver(path, "甲"); await f.deliver(path, "乙");
    writeFileSync(join(f.repo, "advanced.txt"), "new dev source\n"); f.git(f.repo, "add", "advanced.txt"); f.git(f.repo, "commit", "-qm", "dev advanced");
    const result = await mergeManaged(path); assert.equal(result.status, "没验证"); assert.match(result.reason!, /整合/); assert.equal(f.calls().length, 1);
    assert.equal((await integrateKernel(path)).ok, true); assert.equal(readRun(path).base, base); assert.ok(readRun(path).batch!.targetSource);
    await f.deliver(path, "甲"); assert.equal(f.calls().length, 1, "另一任务的新树尚未检查，不能验收");
    await f.deliver(path, "乙"); assert.equal(f.calls().length, 2); assert.equal((await mergeManaged(path)).status, "通过", JSON.stringify(queryKernel(path)));
    assert.equal(f.git(f.repo, "show", "dev:advanced.txt"), "new dev source"); assert.equal(readRun(path).results.filter((r) => r.node === "开发评审" && r.status === "通过").length, 4);
  } finally { f.cleanup(); }
});
test("例外发布包含测试失败任务的当前代码：缺来源/旧贡献均先重建，远端文件与冻结映射一致", async (t) => {
  for (const oldContribution of [false, true]) await t.test(oldContribution ? "替换旧贡献" : "补齐缺贡献", async () => {
    const f = fixture(["甲", "乙"], [{ fail: ["A1"] }]);
    try {
      const fail = join(f.root, "fail-a-test"); if (!oldContribution) writeFileSync(fail, "fail");
      f.card.tasks[0].test = `if [ -f '${fail}' ]; then echo 'AssertionError: A failed' >&2; exit 1; else printf ok; fi`; writeFileSync(f.file, JSON.stringify(f.card));
      const path = f.start();
      if (oldContribution) { await f.deliver(path, "甲", "甲 old\n"); await f.deliver(path, "乙"); writeFileSync(fail, "fail"); }
      const failed = await f.deliver(path, "甲", "甲 latest\n"); assert.equal(failed.failure, "product");
      if (!oldContribution) await f.deliver(path, "乙");
      const before = readRun(path), a = readTaskRun(path, "甲"), b = readTaskRun(path, "乙"), count = before.results.filter((r) => r.task === b.taskId).length;
      assert.notEqual(f.git(before.worktree, "show", "HEAD:甲.txt"), "甲 latest", "正常集成不能提前接纳测试失败任务");
      await assert.rejects(() => mergeManaged(path), /普通合入被拒绝/);
      const decision = recordManagedUserInput(path, "合入本批", "pi:interactive")!, frozen = readRun(path);
      assert.equal(f.git(frozen.worktree, "show", "HEAD:甲.txt"), "甲 latest"); assert.equal(decision.mapping!.length, 2);
      assert.equal(decision.mapping!.find((c) => c.task === a.taskId)!.candidate.commit, a.candidate!.commit);
      assert.equal((await mergeManaged(path, { accept: true, decision })).status, "通过"); const published = readRun(path).publication!;
      assert.equal(f.git(f.origin, "show", "dev:甲.txt"), "甲 latest"); assert.equal(f.git(f.origin, "show", "dev:乙.txt"), "乙 changed");
      assert.equal(f.git(f.origin, "rev-parse", "dev"), published.commit); assert.deepEqual(published.mapping, decision.mapping);
      for (const source of published.mapping!) assert.deepEqual(published.taskChecks!.find((c) => c.task === source.task)!.candidate, source.candidate);
      assert.equal(published.taskChecks!.find((c) => c.task === a.taskId)!.checks.find((c) => c.node === "测试")!.result, undefined);
      assert.equal(readRun(path).results.filter((r) => r.task === b.taskId).length, count); assert.deepEqual(readTaskRun(path, "甲").counters, a.counters);
      assert.ok(readRun(path).decisions.at(-1)!.missing.some((s) => s.includes("甲 / 测试"))); assert.equal(queryKernel(path).checks.includes("甲 / 测试：通过"), false);
      assert.equal(f.calls().length, oldContribution ? 1 : 0, "例外不偷偷追加验收");
      await releaseKernelWorkspace(path); assert.equal(readRun(path).release.status, "已释放");
    } finally { f.cleanup(); }
  });
});
test("两任务测试失败后真实 TTY 取消例外，仍可逐一正常返修或移出未通过任务后普通合入", async (t) => {
  const cancel = String.raw`
import os, pty, re, select, signal, sys, time, json
pid, fd = pty.fork()
if pid == 0:
    os.execv(sys.argv[1], [sys.argv[1], "合入", sys.argv[2], "--接受未验证", "--json"])
data, sent, done, status = b"", False, False, None
deadline = time.monotonic() + 30
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
        if not sent and re.search("请输入「合入 ([0-9a-f]{8})」".encode("utf-8"), data):
            os.write(fd, "取消\n".encode("utf-8"))
            sent = True
        waited, state = os.waitpid(pid, os.WNOHANG)
        if waited:
            status, done = state, True
            break
finally:
    if not done:
        os.killpg(pid, signal.SIGKILL)
        _, status = os.waitpid(pid, 0)
    os.close(fd)
print(json.dumps({"sent": sent, "timeout": not done, "code": os.waitstatus_to_exitcode(status), "transcript": data.decode("utf-8", errors="replace")}))
`;
  for (const remove of [false, true]) await t.test(remove ? "取消后移出甲，乙修好" : "取消后甲乙逐一修好", async () => {
    const f = fixture();
    try {
      f.card.flow.push("提交");
      for (const task of f.card.tasks) task.test = `if [ -f '${join(f.root, `fixed-${task.name}`)}' ]; then printf ok; else echo 'AssertionError: failed' >&2; exit 1; fi`;
      writeFileSync(f.file, JSON.stringify(f.card)); const path = f.start();
      for (const name of ["甲", "乙"]) assert.equal((await f.deliver(path, name, `${name} broken\n`)).failure, "product");
      const result = spawnSync("python3", ["-c", cancel, fileURLToPath(new URL("../bin/loop", import.meta.url)), f.file], { cwd: f.repo, env: process.env, encoding: "utf8", timeout: 45000 });
      assert.equal(result.status, 0, result.stderr || result.stdout); const actual = JSON.parse(result.stdout);
      assert.equal(actual.timeout, false, actual.transcript); assert.equal(actual.sent, true, actual.transcript); assert.equal(actual.code, 1, actual.transcript); assert.match(actual.transcript, /用户未确认/);
      const preview = readRun(path); assert.equal(preview.decisions.length, 0); assert.equal(preview.publication, undefined); assert.equal(preview.batch!.contributions.length, 2);
      assert.equal(preview.batch!.integrations.at(-1)!.task, "user:exception"); assert.equal(f.calls().length, 0); assert.equal(queryKernel(path).status, "等你决定");
      await assert.rejects(() => mergeManaged(path), /普通合入被拒绝/);
      if (remove) {
        recordCardControl(path, "移出任务甲", "pi:interactive"); requestCardChange(path, { removeTask: "甲", source: "machine:managed-session" });
        await settleTaskRemoval(path); const changed = readRun(path);
        assert.equal(changed.changes!.at(-1)!.state, "applied", JSON.stringify(queryKernel(path))); assert.equal(changed.pendingCard, undefined);
        assert.equal(f.git(changed.worktree, "show", "HEAD:甲.txt"), "base"); assert.equal(changed.batch!.contributions.length, 1);
      } else {
        writeFileSync(join(f.root, "fixed-甲"), "fixed"); await f.deliver(path, "甲", "甲 fixed\n"); const partial = readRun(path);
        assert.equal(partial.batch!.contributions.find((c) => c.task === readTaskRun(path, "甲").taskId)!.candidate.commit, readTaskRun(path, "甲").candidate!.commit);
        assert.equal(f.git(partial.worktree, "show", "HEAD:甲.txt"), "甲 fixed"); assert.equal(f.git(partial.worktree, "show", "HEAD:乙.txt"), "乙 broken");
      }
      assert.equal(f.calls().length, 0, "另一任务尚未通过，不能开始统一验收"); assert.equal(readRun(path).publication, undefined);
      await assert.rejects(() => executeNode(path, "验收", async () => { assert.fail("不能绕过未通过任务进入验收"); }, { localSlot: true }), /测试|结论映射/);
      await assert.rejects(() => mergeManaged(path), /普通合入被拒绝/); assert.equal(f.git(f.origin, "for-each-ref", "--format=%(refname)"), "");
      writeFileSync(join(f.root, "fixed-乙"), "fixed"); assert.equal((await f.deliver(path, "乙", "乙 fixed\n")).status, "通过");
      const done = readRun(path); assert.equal(done.publication!.push, "成功"); assert.equal(done.publication!.decision, undefined); assert.equal(done.decisions.length, 0);
      assert.deepEqual(f.calls().map((c) => c.ids), [remove ? ["A3", "A4"] : ["A1", "A2", "A3", "A4"]]);
      assert.equal(f.git(f.origin, "show", "dev:甲.txt"), remove ? "base" : "甲 fixed"); assert.equal(f.git(f.origin, "show", "dev:乙.txt"), "乙 fixed");
      assert.equal(done.results.filter((r) => r.node === "测试" && r.status === "不通过").length, 2, "取消/返修不改写原失败历史");
      await releaseKernelWorkspace(path); assert.equal(readRun(path).release.status, "已释放"); assert.equal(readLocalQueue().items.length, 0);
    } finally { f.cleanup(); }
  });
});
test("例外不能豁免缺失/不一致的来源记录，也不能覆盖确认后的新任务候选", async () => {
  for (const changedCandidate of [false, true]) {
    const f = fixture();
    try {
      const path = f.start(); await f.deliver(path, "甲"); await f.deliver(path, "乙");
      const decision = recordManagedUserInput(path, "合入本批", "pi:interactive")!;
      if (changedCandidate) {
        const a = readTaskRun(path, "甲"); writeFileSync(join(a.worktree, "甲.txt"), "new after confirmation\n"); updateTaskRun(path, a.taskId, (r) => { r.candidate = deliverCandidate(r); });
      } else updateRun(path, (r) => { r.batch!.contributions = r.batch!.contributions.filter((c) => c.task !== r.taskRecords![0].id); });
      await assert.rejects(() => mergeManaged(path, { accept: true, decision }), /来源|映射|装配/);
      if (changedCandidate) {
        const fresh = recordManagedUserInput(path, "合入本批", "pi:interactive")!;
        assert.notEqual(fresh.candidate.tree, decision.candidate.tree); assert.equal(fresh.mapping!.find((c) => c.task === readTaskRun(path, "甲").taskId)!.candidate.commit, readTaskRun(path, "甲").candidate!.commit);
      } else assert.throws(() => recordManagedUserInput(path, "合入本批", "pi:interactive"), /映射|装配/);
      assert.equal(readRun(path).publication, undefined); assert.equal(f.git(f.origin, "for-each-ref", "--format=%(refname)"), "");
    } finally { f.cleanup(); }
  }
});
test("多任务普通拒绝逐项欠验收；真实用户例外绑定批次树和来源映射，欠项不改成通过，只推 bare dev", async () => {
  const f = fixture();
  try {
    const path = f.start(); await f.deliver(path, "甲"); const b = readTaskRun(path, "乙"); writeFileSync(join(b.worktree, "乙.txt"), "B\n");
    await completeManagedDelivery(path, "【交付完成】", { exec: f.exec, callReviewer: reviewer, task: b.taskId, acceptanceExec: async () => ({ code: 75, stdout: "", stderr: "EADDRINUSE", killed: false, processesReleased: true }) });
    await assert.rejects(() => mergeManaged(path), /普通合入被拒绝[\s\S]*批次 \/ 验收[\s\S]*重跑/);
    const decision = recordManagedUserInput(path, "合入本批", "pi:interactive")!; assert.ok(decision.missing.length);
    assert.equal((await mergeManaged(path, { accept: true, decision })).status, "通过"); const run = readRun(path);
    assert.equal(run.publication!.decision, decision.id); assert.equal(run.publication!.taskChecks!.length, 2); assert.equal(run.publication!.nodeChecks!.验收!.result, undefined);
    assert.equal(run.results.filter((r) => r.node === "验收" && r.status === "通过").length, 0); assert.equal(f.git(f.origin, "rev-parse", "dev"), run.publication!.commit);
    await releaseKernelWorkspace(path); assert.equal(readRun(path).release.status, "已释放"); assert.equal(queryKernel(path).status, "已合入"); assert.equal(queryKernel(path).checks.includes("验收：通过"), false);
  } finally { f.cleanup(); }
});
test("旧单任务 v1/v2 真实旧指纹通过记录可查/复用/普通合入；查询不迁移、不重绑", async () => {
  for (const version of [1, 2]) {
    const f = kernelFixture(version === 1 ? ["开发评审"] : ["开发评审", "测试"], "exit 91");
    try {
      if (version === 1) { delete f.card.tasks[0].test; writeFileSync(f.file, JSON.stringify(f.card)); }
      const path = f.start(); f.candidate(path);
      updateRun(path, (r) => {
        delete (r.card.limits as any).验收;
        if (version === 1) { delete r.inputVersion; delete r.counters; delete r.cardRevision; delete (r.card.limits as any).测试; }
        r.repairs = 2;
        for (const node of r.card.flow) {
          const old = legacyKernelInputs(r, node), evidence = join(r.dir, `legacy-${node}.json`);
          writeFileSync(evidence, JSON.stringify({ source: "b97e154 前两步指纹算法", node, ...old }));
          r.results.push({ id: `legacy-${node}`, task: r.card.tasks[0].name, node, candidate: r.candidate!, inputs: old.hash,
            started: r.created, ended: r.created, status: "通过", evidence: [evidence], operations: ["前两步已有通过记录夹具"], released: true });
        }
        assert.equal(checkInputs(r).hash, legacyKernelInputs(r).hash, "完整发布输入也保持旧元组身份");
      });
      const before = readRun(path), raw = readFileSync(path, "utf8");
      assert.equal(queryKernel(path).status, "可合入"); assert.equal(readFileSync(path, "utf8"), raw);
      const prompt = before.card.tasks[0].prompt, original = readFileSync(prompt);
      writeFileSync(prompt, "changed input\n"); assert.ok(queryKernel(path).missing.length); assert.equal(readFileSync(path, "utf8"), raw); writeFileSync(prompt, original);
      await resumeManaged(path, false, "开发评审");
      for (const node of before.card.flow) assert.equal((await executeNode(path, node, async () => { throw new Error("不能重跑旧通过节点"); })).status, "通过");
      assert.deepEqual(readRun(path).results, before.results); assert.equal(readRun(path).repairs, 2);
      assert.equal((await mergeManaged(path)).status, "通过"); assert.equal(readRun(path).taskRecords, undefined);
      assert.deepEqual(readRun(path).results.filter((r) => r.node !== "提交"), before.results);
      assert.equal(readRun(path).publication!.push, "成功"); await releaseKernelWorkspace(path); assert.equal(readRun(path).release.status, "已释放");
    } finally { f.cleanup(); }
  }
});
test("集成 CAS 后中断可按精确意图恢复；未知写入保留；查询不恢复事务", async () => {
  for (const mode of ["normal", "dirty", "exception", "repair", "remove"]) {
    const dirty = mode === "dirty", f = fixture();
    try {
      if (mode === "exception") { f.card.tasks[0].test = "echo 'AssertionError: failed' >&2; exit 1"; writeFileSync(f.file, JSON.stringify(f.card)); }
      if (mode === "repair" || mode === "remove") {
        for (const task of f.card.tasks) task.test = `if [ -f '${join(f.root, `fixed-${task.name}`)}' ]; then printf ok; else echo 'AssertionError: failed' >&2; exit 1; fi`;
        writeFileSync(f.file, JSON.stringify(f.card));
      }
      const path = f.start(); await f.deliver(path, "甲");
      if (["exception", "repair", "remove"].includes(mode)) { await f.deliver(path, "乙"); recordManagedUserInput(path, "合入本批", "pi:interactive"); }
      if (mode === "repair") { writeFileSync(join(f.root, "fixed-甲"), "fixed"); await f.deliver(path, "甲", "甲 fixed\n"); }
      if (mode === "remove") {
        recordCardControl(path, "移出任务甲", "pi:interactive"); requestCardChange(path, { removeTask: "甲", source: "machine:managed-session" }); await settleTaskRemoval(path);
      }
      const run = readRun(path), entry = run.batch!.integrations.at(-1)!, previous = run.batch!.integrations.slice(0, -1), version = run.batch!.version - 1;
      f.git(f.repo, "update-ref", `refs/heads/${run.branch}`, entry.before.commit, entry.after.commit); f.git(run.worktree, "read-tree", "-m", "-u", entry.after.commit, entry.before.commit);
      updateRun(path, (r) => { r.candidate = entry.before; r.batch!.version = version; r.batch!.contributions = previous.at(-1)?.mapping ?? []; r.batch!.integrations = previous; r.decisions = [];
        if (entry.control) { r.pendingCard = entry.control; const c = r.changes!.find((c) => c.id === entry.control)!; c.state = "prepared"; }
        r.batch!.pending = { id: entry.id, before: entry.before.commit, after: entry.after.commit, version, entry, guard: workspaceGuard(r), epoch: r.epoch }; });
      f.git(f.repo, "update-ref", `refs/heads/${run.branch}`, entry.after.commit, entry.before.commit);
      if (dirty) writeFileSync(join(run.worktree, "unknown.txt"), "keep");
      const raw = readFileSync(path, "utf8"); queryKernel(path); assert.equal(readFileSync(path, "utf8"), raw);
      if (dirty) { assert.throws(() => recoverBatchIntegration(path), /保留|变化/); assert.equal(readFileSync(join(run.worktree, "unknown.txt"), "utf8"), "keep"); assert.ok(readRun(path).batch!.pending); }
      else {
        recoverBatchIntegration(path); assert.equal(readRun(path).batch!.pending, undefined); assert.equal(readRun(path).candidate!.commit, entry.after.commit);
        if (mode === "normal") assert.equal(integrateTask(path, readTaskRun(path, "甲").taskId!).ok, true);
        else {
          if (entry.control) { assert.equal(applyPendingCardChange(path), true); assert.equal(readRun(path).pendingCard, undefined); }
          assert.deepEqual(contributionProblems(readRun(path), false), []);
          assert.ok(qualification(readRun(path)).missing.some((s) => s.includes(`${mode === "exception" ? "甲" : "乙"} / 测试`)));
          assert.equal(readRun(path).decisions.length, 0); assert.equal(readRun(path).publication, undefined);
        }
        assert.equal(readRun(path).batch!.integrations.length, run.batch!.integrations.length);
      }
    } finally { f.cleanup(); }
  }
});
test("多任务 Claude/Codex 实际 Hook 入口按任务定位原会话，验收只回甲，乙不重跑", async (t) => {
  for (const host of ["claude", "codex"] as const) await t.test(host, async () => {
    const f = fixture(["甲", "乙"], [{ fail: ["A1"] }, {}]);
    try {
      f.card.host = host; writeFileSync(f.file, JSON.stringify(f.card)); const path = f.start(), batch = readRun(path);
      Object.assign(process.env, { AUTOREVIEW_KERNEL_LEDGER: path, AUTOREVIEW_KERNEL_RUN: batch.id, AUTOREVIEW_HOST: host, AUTOREVIEW_REVIEWER_CMD: fileURLToPath(new URL("./fake-reviewer.mjs", import.meta.url)), FAKE_MODE: "pass" });
      const bind = (name: string) => { const r = readTaskRun(path, name); Object.assign(process.env, { AUTOREVIEW_KERNEL_TASK: r.taskId, AUTOREVIEW_DEV_ROOT: r.worktree }); return { cwd: r.worktree, session_id: `${host}-${name}` }; };
      for (const name of ["甲", "乙"]) {
        const event = bind(name), r = readTaskRun(path, name);
        await handleReviewEvent({ ...event, hook_event_name: "SessionStart" }); await handleReviewEvent({ ...event, hook_event_name: "UserPromptSubmit", prompt: `@"${taskDefinition(r).prompt}"` });
        writeFileSync(join(r.worktree, `${name}.txt`), `${name} hook\n`); await handleReviewEvent({ ...event, hook_event_name: "Stop", last_assistant_message: "【交付完成】" });
      }
      const a = readTaskRun(path, "甲"), b = readTaskRun(path, "乙"), count = readRun(path).results.filter((r) => r.task === b.taskId).length;
      const plan = structuredClone(readRun(path).acceptanceState!.plan!), oldBinding = structuredClone(readRun(path).acceptanceState!.bindings!.A3);
      assert.equal(a.repair!.session, `${host}-甲`); assert.equal(b.repair, undefined); assert.notEqual(a.session!.id, b.session!.id);
      const event = bind("甲"), version = a.userVersion;
      await handleReviewEvent({ ...event, hook_event_name: "UserPromptSubmit", prompt: a.repair!.message }); assert.equal(readTaskRun(path, "甲").userVersion, version);
      const supplement = join(f.root, "补充要求.md"); writeFileSync(supplement, "补充：修复失败项时保留已有兼容行为\n");
      await handleReviewEvent({ ...event, hook_event_name: "UserPromptSubmit", prompt: `@"${supplement}"` });
      assert.equal(readTaskRun(path, "甲").userVersion, version + 1); assert.deepEqual(readRun(path).acceptanceState!.plan!.repairTasks, plan.repairTasks);
      assert.deepEqual(readRun(path).acceptanceState!.plan!.waitFor, plan.waitFor); assert.equal(readTaskRun(path, "甲").counters!.验收!.repairs, 1);
      writeFileSync(join(a.worktree, "甲.txt"), "甲 hook fixed\n"); await handleReviewEvent({ ...event, hook_event_name: "Stop", last_assistant_message: "【交付完成】" });
      assert.deepEqual(f.calls().map((c) => c.ids), [["A1", "A2", "A3", "A4"], ["A1", "A2"]]); assert.equal(readTaskRun(path, "乙").candidate!.commit, b.candidate!.commit); assert.equal(queryKernel(path).status, "可合入");
      assert.equal(readRun(path).results.filter((r) => r.task === b.taskId).length, count); assert.equal(readTaskRun(path, "甲").counters!.验收!.repairs, 1);
      const refresh = readRun(path).acceptanceState!.planRefreshes!.at(-1)!; assert.deepEqual(refresh.tasks, [a.taskId]); assert.deepEqual(refresh.ids, plan.ids); assert.notEqual(refresh.from, refresh.to);
      assert.equal(readRun(path).acceptanceState!.bindings!.A3.tree, oldBinding.tree); assert.equal(readRun(path).acceptanceState!.bindings!.A3.round, oldBinding.round);
    } finally { f.cleanup(); }
  });
});
