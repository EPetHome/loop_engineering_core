import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { kernelFixture, reviewer } from "./helpers/kernel-fixture.ts";
import { applyPendingCardChange, recordCardControl, recordScopeControl, requestCardChange } from "../kernel-controls.ts";
import { executeNode } from "../kernel.ts";
import { checkInputs, deliverCandidate } from "../kernel-workspace.ts";
import { readRun, readTaskRun, updateRun, updateTaskRun, validResult } from "../node-ledger.ts";
import { processStartTime } from "../procs.ts";
import { deliverManagedRepair, resumeManaged } from "../kernel-runtime.ts";
import { completeManagedDelivery, consumeManagedRepair } from "../kernel-session.ts";

function fixture(batch = false) {
  const f = kernelFixture(batch ? ["开发评审", "测试", "验收"] : ["开发评审", "测试"]);
  for (const name of ["extra.txt", "second.txt", "deny.txt"]) writeFileSync(join(f.repo, name), name);
  f.card.tasks[0].scope = { allow: ["file.txt"], deny: ["deny.txt"] };
  if (batch) {
    f.card.tasks.push({ name: "乙", prompt: "prompt.md", scope: ["second.txt"], test: "printf ok" });
    f.card.acceptance = "criteria.md";
    writeFileSync(join(f.repo, "criteria.md"), "## 验收标准\nA1. [甲] 操作：查甲\n    预期：有结果\nA2. [乙] 操作：查乙\n    预期：有结果\n");
  }
  writeFileSync(f.file, JSON.stringify(f.card)); f.git(f.repo, "add", "."); f.git(f.repo, "commit", "-qm", "scope fixture");
  return f;
}
const add = (f: ReturnType<typeof fixture>, file = "extra.txt") => f.replacement((c) => c.tasks[0].scope.allow.push(file));

test("scope 增补须绑定真实用户的任务/精确文件/卡版本，一次性留史且保留成果和次数", async () => {
  const f = fixture();
  try {
    const path = f.start(); f.candidate(path);
    await executeNode(path, "开发评审", async (i) => ({ status: "通过", evidence: [i.evidenceDir], operations: [], released: true }));
    updateRun(path, (r) => { r.repairs = 2; r.counters = { 测试: { repairs: 1, recoveries: 1 } }; r.session = { host: "pi", id: "original", pid: process.pid, started: processStartTime(process.pid), log: "original.log" }; });
    const before = readRun(path), review = checkInputs(before, "开发评审").hash;
    assert.throws(() => requestCardChange(path, { from: add(f), source: "cli:automation" }), /真实用户决定/);
    assert.equal(recordScopeControl(path, "甲", "extra.txt", "自行批准", "machine:managed-session"), false);
    assert.equal(recordCardControl(path, "补充任务「甲」范围：extra.txt", "pi:interactive"), true);
    assert.throws(() => requestCardChange(path, { from: add(f, "second.txt"), source: "cli:automation" }), /真实用户决定/);
    const proposed = add(f), preview = requestCardChange(path, { from: proposed, source: "cli:automation", dryRun: true });
    assert.equal(preview.scopeAddition!.file, "extra.txt"); assert.equal(readRun(path).controlDecisions!.at(-1)!.used, undefined);
    const change = requestCardChange(path, { from: proposed, source: "cli:automation" }), after = readRun(path);
    assert.equal(change.state, "applied"); assert.ok(change.authorization);
    assert.deepEqual(after.card.tasks[0].scope, { allow: ["file.txt", "extra.txt"], deny: ["deny.txt"] });
    assert.equal(after.controlDecisions!.at(-1)!.used, change.id);
    for (const key of ["session", "candidate", "repairs", "counters", "results", "worktree", "branch"] as const) assert.deepEqual(after[key], before[key], key);
    assert.notEqual(checkInputs(after, "开发评审").hash, review);
    assert.equal(validResult(after, "开发评审", after.candidate!, checkInputs(after, "开发评审").hash), undefined);
    assert.equal(readFileSync(join(after.dir, "card-changes", change.id, "before.json"), "utf8"), change.before);
    assert.throws(() => requestCardChange(path, { from: add(f, "second.txt"), source: "cli:automation" }), /真实用户决定/);
    writeFileSync(join(after.worktree, "extra.txt"), "authorized repair\n");
    assert.ok(deliverCandidate(after).commit);
    rmSync(join(after.worktree, "extra.txt")); mkdirSync(join(after.worktree, "extra.txt")); writeFileSync(join(after.worktree, "extra.txt", "outside.txt"), "not a single-file grant\n");
    assert.throws(() => deliverCandidate(after), /范围外/);
  } finally { f.cleanup(); }
});

test("scope 增补拒绝目录、链接、未跟踪路径、deny 绕过、范围替换和夹带改卡", () => {
  const f = fixture();
  try {
    const path = f.start(), run = readRun(path);
    writeFileSync(join(run.worktree, "untracked.txt"), "not tracked");
    symlinkSync("file.txt", join(run.worktree, "link.txt"));
    for (const file of [".", "../extra.txt", "deny.txt", "link.txt", "untracked.txt", "file.txt", "extra.txt/"]) {
      assert.throws(() => recordScopeControl(path, "甲", file, "明确同意", "pi:interactive"), /scope|ENOENT/);
    }
    const mutations = [
      (c: any) => c.tasks[0].scope.allow = ["extra.txt"],
      (c: any) => { c.tasks[0].scope.allow.push("extra.txt"); delete c.tasks[0].scope.deny; },
      (c: any) => { c.tasks[0].scope.allow.push("extra.txt"); c.tasks[0].test = "printf different"; },
      (c: any) => c.tasks[0].scope.allow.push("extra.txt", "second.txt"),
      (c: any) => c.tasks[0].prompt = "extra.txt",
    ];
    for (const mutate of mutations) assert.throws(() => requestCardChange(path, { from: f.replacement(mutate), source: "terminal:tty" }), /scope|身份/);
    assert.deepEqual(readRun(path).changes, run.changes); assert.deepEqual(readRun(path).card, run.card);
  } finally { f.cleanup(); }
});

test("scope 增补只等待责任任务，其他正在评审的任务身份/输入/活动不变", async () => {
  const f = fixture(true);
  try {
    const path = f.start(), a = readTaskRun(path, "甲"), b = readTaskRun(path, "乙");
    await executeNode(path, "开发评审", async (i) => ({ status: "通过", evidence: [i.evidenceDir], operations: [], released: true }), { task: b.taskId });
    updateRun(path, (r) => {
      const a = r.taskRecords![0], b = r.taskRecords![1]; a.repairs = 2;
      b.activity = { id: "unrelated-review", node: "开发评审", kind: "reviewing", pid: process.pid, started: processStartTime(process.pid) };
      b.session = { host: "pi", id: "other-session", pid: process.pid, started: processStartTime(process.pid) };
    });
    const before = readRun(path), hash = checkInputs(readTaskRun(path, "乙"), "开发评审").hash;
    recordScopeControl(path, "甲", "extra.txt", "只补甲的 extra.txt", "codex:UserPromptSubmit");
    const changed = requestCardChange(path, { from: add(f), source: "cli:automation" });
    assert.equal(changed.state, "applied");
    const after = readRun(path);
    assert.deepEqual(after.taskRecords![1], before.taskRecords![1]); assert.deepEqual(after.results, before.results);
    assert.equal(checkInputs(readTaskRun(path, "乙"), "开发评审").hash, hash);
    assert.equal(readTaskRun(path, "甲").repairs, 2); assert.equal(readTaskRun(path, "甲").taskId, a.taskId);
  } finally { f.cleanup(); }
});

test("scope 增补在责任任务检查结束后应用；撤回或文件变成链接时不采用旧决定", async () => {
  for (const mode of ["finish", "revoke", "link"]) {
    const f = fixture(); let done!: () => void;
    try {
      const path = f.start(); f.candidate(path);
      const gate = new Promise<void>((resolve) => { done = resolve; });
      const running = executeNode(path, "开发评审", async (i) => { await gate; return { status: "通过", evidence: [i.evidenceDir], operations: [], released: true }; });
      recordScopeControl(path, "甲", "extra.txt", "明确增加 extra.txt", "pi:interactive");
      assert.equal(requestCardChange(path, { from: add(f), source: "cli:automation" }).state, "pending");
      done(); await running;
      if (mode === "revoke") updateRun(path, (r) => { r.userVersion++; });
      if (mode === "link") { const p = join(readRun(path).worktree, "extra.txt"); rmSync(p); symlinkSync("file.txt", p); assert.throws(() => applyPendingCardChange(path), /scope/); }
      else assert.equal(applyPendingCardChange(path), mode === "finish");
      assert.equal(readRun(path).card.tasks[0].scope.allow!.includes("extra.txt"), mode === "finish");
    } finally { done?.(); f.cleanup(); }
  }
});

test("scope 修正后的显式续跑只投递原活 Pi，会话/次数保留且在途检查不能被绕过", async () => {
  const f = fixture(true);
  try {
    const path = f.start(), task = readTaskRun(path, "甲").taskId!;
    updateTaskRun(path, task, (r) => {
      r.stopped = true; r.blockedNode = "开发评审"; r.repairs = 2; r.stopReason = "范围遗漏";
      r.session = { host: "pi", id: "original-pi", log: "same-session.jsonl", pid: process.pid, started: processStartTime(process.pid), launchId: "original-launch" };
      r.launch = { pid: process.pid, processStarted: processStartTime(process.pid), token: "original-launch" };
    });
    recordScopeControl(path, "甲", "extra.txt", "明确增补并恢复", "codex:UserPromptSubmit");
    requestCardChange(path, { from: add(f), source: "cli:automation" });
    const before = readTaskRun(path, task);
    updateTaskRun(path, task, (r) => { r.activity = { id: "still-reviewing", node: "开发评审", kind: "reviewing", pid: process.pid, started: processStartTime(process.pid) }; });
    await assert.rejects(() => resumeManaged(path, true, undefined, false, task), /节点仍执行/);
    assert.equal(readTaskRun(path, task).repair, undefined);
    updateTaskRun(path, task, (r) => { r.activity = undefined; });
    const result = await resumeManaged(path, true, undefined, false, task), after = readTaskRun(path, task);
    assert.match(result.lines[0], /原 Pi 私有收件箱/); assert.equal(after.stopped, false);
    for (const key of ["session", "launch", "candidate", "repairs", "counters", "userVersion", "epoch", "results"] as const) assert.deepEqual(after[key], before[key], key);
    assert.equal(after.repair!.session, "original-pi"); assert.equal(after.repair!.state, "pending");
    updateTaskRun(path, task, (r) => { r.repair!.state = "unknown"; });
    await deliverManagedRepair(path, task);
    assert.equal(readTaskRun(path, task).repair!.state, "pending", "原 Pi 无可读环境标记也可接收已绑定私有信封，不杀组或新开会话");
    assert.equal(consumeManagedRepair(path, after.repair!.message, undefined, task), true);
    assert.equal(readTaskRun(path, task).repair!.state, "read");
    updateTaskRun(path, task, (r) => {
      r.stopped = true; r.repair!.state = "pending"; r.repair!.message = "【Loop 集成返修】保留原问题"; r.repair!.inputs = "stale-input";
    });
    await assert.rejects(() => resumeManaged(path, true, undefined, false, task), /未读返修信封/);
    assert.equal(readTaskRun(path, task).stopped, true); assert.equal(readTaskRun(path, task).repair!.inputs, "stale-input");
  } finally { f.cleanup(); }
});

test("甲增补仍 pending 时乙能完成评审、排队测试并汇入，不被全局 pending 暂停", async () => {
  const f = fixture(true); let done!: () => void, started!: () => void;
  try {
    const path = f.start(), a = readTaskRun(path, "甲"), b = readTaskRun(path, "乙");
    const gate = new Promise<void>((resolve) => { done = resolve; });
    const reached = new Promise<void>((resolve) => { started = resolve; });
    const running = executeNode(path, "开发评审", async (i) => { started(); await gate; return { status: "通过", evidence: [i.evidenceDir], operations: [], released: true }; }, { task: a.taskId });
    await reached;
    recordScopeControl(path, "甲", "extra.txt", "确认增补甲的文件", "pi:interactive");
    assert.equal(requestCardChange(path, { from: add(f), source: "cli:automation" }).state, "pending");
    updateTaskRun(path, b.taskId, (r) => {
      r.stopped = true; r.blockedNode = undefined; // 首次交付在节点登记之前暂停，也应恢复原会话。
      r.session = { host: "pi", id: "original-b", log: "original-b.log", pid: process.pid, started: processStartTime(process.pid), launchId: "b-launch" };
      r.launch = { pid: process.pid, processStarted: processStartTime(process.pid), token: "b-launch" };
    });
    const resumed = await resumeManaged(path, true, undefined, false, b.taskId);
    assert.match(resumed.lines[0], /原 Pi 私有收件箱/); assert.ok(readRun(path).pendingCard);
    const receipt = readTaskRun(path, b.taskId).repair!;
    assert.equal(consumeManagedRepair(path, receipt.message, undefined, b.taskId), true);
    writeFileSync(join(b.worktree, "second.txt"), "independent B change\n");
    await completeManagedDelivery(path, "【交付完成】", { exec: f.exec, testExec: f.exec, callReviewer: reviewer, task: b.taskId });
    const checked = readTaskRun(path, b.taskId);
    assert.notEqual(checked.stopped, true); assert.equal(checked.activity, undefined);
    assert.ok(validResult(checked, "开发评审", checked.candidate!, checkInputs(checked, "开发评审").hash));
    assert.ok(validResult(checked, "测试", checked.candidate!, checkInputs(checked, "测试").hash));
    assert.ok(readRun(path).batch!.contributions.some((c) => c.task === b.taskId));
    assert.ok(readRun(path).pendingCard);
    done(); await running; assert.equal(applyPendingCardChange(path), true);
    assert.notEqual(readTaskRun(path, b.taskId).stopped, true);
  } finally { done?.(); f.cleanup(); }
});
