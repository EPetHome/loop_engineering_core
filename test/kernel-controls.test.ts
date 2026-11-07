import assert from "node:assert/strict";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { kernelFixture } from "./helpers/kernel-fixture.ts";
import { readDevelopmentCard } from "../development-card.ts";
import { checkInputs } from "../kernel-workspace.ts";
import { executeNode, queryKernel } from "../kernel.ts";
import { readRun, updateRun } from "../node-ledger.ts";
import { applyPendingCardChange, recordCardControl, requestCardChange } from "../kernel-controls.ts";
import { abandonKernel } from "../kernel-runtime.ts";

test("四种 flow、独立限额与测试原因只读校验", () => {
  const f = kernelFixture();
  try {
    for (const flow of [["开发评审"], ["开发评审", "提交"], ["开发评审", "测试"], ["开发评审", "测试", "提交"]]) {
      writeFileSync(f.file, JSON.stringify({ ...f.card, flow })); const c = readDevelopmentCard(f.file, f.repo).card;
      assert.equal(c.limits.测试.maxRepairs, 3); assert.equal(c.limits.测试.timeoutMin, 20); assert.equal(c.limits.开发评审.timeoutMin, 60);
    }
    const exact = "printf x\\ "; f.card.tasks[0].test = exact; writeFileSync(f.file, JSON.stringify(f.card));
    assert.equal(readDevelopmentCard(f.file, f.repo).card.tasks[0].test, exact, "不能 trim 掉测试命令中的语义字节");
    for (const value of ["", "无：", "无：  "]) { f.card.tasks[0].test = value; writeFileSync(f.file, JSON.stringify(f.card)); assert.throws(f.start, /测试|test/); }
    assert.equal(existsSync(join(f.root, "kernel")), false);
  } finally { f.cleanup(); }
});
test("受控改测试只失效测试；展示名和次数不失效；新旧原文/来源/时间保留", async () => {
  const f = kernelFixture();
  try {
    const path = f.start(); f.candidate(path);
    await executeNode(path, "开发评审", async (i) => ({ status: "通过", evidence: [i.evidenceDir], operations: ["评审替身"], released: true }));
    const before = readRun(path), review = checkInputs(before, "开发评审").hash, testing = checkInputs(before, "测试").hash;
    const from = f.replacement((c) => { c.tasks[0].test = "printf changed"; c.name = "改名"; c.limits = { 测试: { maxRepairs: 8 } }; });
    const change = requestCardChange(path, { from, source: "cli:automation" });
    assert.equal(change.state, "applied"); assert.equal(change.source, "cli:automation"); assert.ok(change.at && change.appliedAt);
    assert.equal(checkInputs(readRun(path), "开发评审").hash, review); assert.notEqual(checkInputs(readRun(path), "测试").hash, testing);
    assert.equal(readRun(path).results.length, 1); assert.equal(readRun(path).cardRevision, 1);
    const persisted = readFileSync(path, "utf8"); queryKernel(path); assert.equal(readFileSync(path, "utf8"), persisted);
  } finally { f.cleanup(); }
});
test("机器不得移除必需测试；真实用户控制决定一次性且来源留史", () => {
  const f = kernelFixture();
  try {
    const path = f.start();
    assert.throws(() => requestCardChange(path, { removeNode: "测试", source: "machine:managed-session" }), /真实用户决定/);
    assert.equal(recordCardControl(path, "移除本批测试节点", "machine"), false);
    assert.equal(recordCardControl(path, "移除本批测试节点", "pi:interactive"), true);
    const changed = requestCardChange(path, { removeNode: "测试", source: "machine:managed-session" });
    assert.equal(changed.state, "applied"); assert.ok(changed.authorization); assert.equal(readRun(path).controlDecisions![0].used, changed.id);
    assert.deepEqual(readRun(path).card.flow, ["开发评审"]);
  } finally { f.cleanup(); }
});
test("改卡 prepared 两端恢复、真实用户撤回使 pending 失效", () => {
  for (const mode of ["before", "after", "revoke"]) {
    const f = kernelFixture();
    try {
      const path = f.start(), from = f.replacement((c) => { c.tasks[0].test = "echo updated"; });
      const source = requestCardChange(path, { from, source: "cli:automation", dryRun: true });
      updateRun(path, (r) => { r.activity = undefined; r.changes = [{ ...source, state: "prepared" }]; r.pendingCard = source.id; if (mode === "revoke") r.userVersion++; });
      if (mode === "after") writeFileSync(f.file, source.content);
      const persisted = readFileSync(path, "utf8"); queryKernel(path); assert.equal(readFileSync(path, "utf8"), persisted);
      assert.equal(applyPendingCardChange(path), mode !== "revoke");
      assert.equal(readRun(path).changes![0].state, mode === "revoke" ? "rejected" : "applied");
    } finally { f.cleanup(); }
  }
});
test("放弃干净 worktree 安全释放；脏/暂存/未知忽略/本机文件原样保留，保留分支和 ref", async () => {
  for (const mode of ["clean", "dirty", "staged", "ignored", "local"]) {
    const f = kernelFixture();
    try {
      const path = f.start(); f.candidate(path); const run = readRun(path);
      if (mode === "dirty" || mode === "staged") { writeFileSync(join(run.worktree, "file.txt"), "unsaved"); if (mode === "staged") f.git(run.worktree, "add", "file.txt"); }
      if (mode === "ignored") {
        const exclude = f.git(run.worktree, "rev-parse", "--path-format=absolute", "--git-path", "info/exclude");
        appendFileSync(exclude, "\nunknown.local\n"); writeFileSync(join(run.worktree, "unknown.local"), "unknown owner");
      }
      if (mode === "local") writeFileSync(join(run.worktree, "local.txt"), "changed local");
      const output = await abandonKernel(path, "terminal:tty");
      assert.equal(output.status, "已放弃"); const last = readRun(path); assert.ok(last.abandonment!.history); assert.ok(f.git(f.repo, "show-ref", last.abandonment!.history!));
      assert.equal(existsSync(run.worktree), mode !== "clean");
      if (mode === "dirty" || mode === "staged") assert.equal(readFileSync(join(run.worktree, "file.txt"), "utf8"), "unsaved");
      assert.ok(f.git(f.repo, "show-ref", run.branch)); assert.equal(existsSync(path), true);
      await abandonKernel(path, "terminal:tty");
    } finally { f.cleanup(); }
  }
});
test("活动边界 pending、直接编辑拒绝并保留三方内容、不能替换归属", async () => {
  const f = kernelFixture();
  try {
    const path = f.start(); f.candidate(path);
    let done!: () => void; const wait = new Promise<void>((ok) => { done = ok; });
    const work = executeNode(path, "开发评审", async (i) => { await wait; return { status: "通过", evidence: [i.evidenceDir], operations: [], released: true }; });
    const from = f.replacement((c) => { c.tasks[0].test = "printf next"; });
    const request = requestCardChange(path, { from, source: "cli:automation" }); assert.equal(request.state, "pending");
    assert.equal(readRun(path).card.tasks[0].test, f.card.tasks[0].test);
    done(); await work; assert.equal(applyPendingCardChange(path), true);
    const bad = f.replacement((c) => { c.tasks[0].scope = ["."]; }); assert.throws(() => requestCardChange(path, { from: bad, source: "terminal:tty" }), /身份|scope/);
    updateRun(path, (r) => { r.pendingCard = request.id; const c = r.changes![0]; c.state = "pending"; c.expectedHash = r.cardHash; });
    writeFileSync(f.file, "{\"external\":true}"); assert.equal(applyPendingCardChange(path), false);
    assert.equal(readFileSync(f.file, "utf8"), "{\"external\":true}"); assert.equal(readRun(path).changes![0].state, "rejected");
  } finally { f.cleanup(); }
});
