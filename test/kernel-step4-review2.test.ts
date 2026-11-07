/** 第二次评审：旧 Pi 生命周期取消不得丢弃真实释放回执；不清除未知租约。 */
import "./test-env.ts";
import "./helpers/git-runtime.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { harness, PASS, type Result } from "./helpers/autoreview-fixture.ts";
import { createChildExec } from "../hosts/review-hook.ts";
import { ownedProcessGroupAlive, readProcs, type ProcEntry } from "../procs.ts";
import { consumerProblem } from "../local-node-queue.ts";
import { acquireProjectExecution } from "../project-execution.ts";

async function until(check: () => unknown, description: string) {
  const deadline = Date.now() + 15_000;
  while (!check()) { if (Date.now() >= deadline) throw new Error(`屏障未到：${description}`); await new Promise((r) => setTimeout(r, 20)); }
}
const group = (p: ProcEntry) => ({ pid: p.pgid, processStarted: p.started, token: p.token! });
const criteria = (version: number) => `需求原文\n## 验收标准\nA1. 操作：检查 REVISION_${version}\n    预期：符合第 ${version} 版\n`;

for (const action of ["input", "quit", "reload"] as const) {
  test(`第1条：真实评审进程中 ${action}，保留已释放事实、撤销旧结论，并可再次评审`, async () => {
    await lifecycleCase(action, "confirmed");
  });
}
for (const proof of ["missing", "unknown"] as const) {
  test(`第1条反例：取消后 ${proof} 释放证明仍保留 blocked，不能据空登记洗白`, async () => {
    await lifecycleCase("input", proof);
  });
}

async function lifecycleCase(action: "input" | "quit" | "reload", proof: "confirmed" | "missing" | "unknown") {
  const saved = { ...process.env };
  for (const key of ["AUTOREVIEW_KERNEL_LEDGER", "AUTOREVIEW_KERNEL_RUN", "AUTOREVIEW_KERNEL_TASK", "AUTOREVIEW_KERNEL_LAUNCH", "AUTOREVIEW_KERNEL_REPAIR", "AUTOREVIEW_KERNEL_NATIVE_BINDING", "AUTOREVIEW_DEV_ROOT", "AUTOREVIEW_SCOPE", "AUTOREVIEW_SCOPE_FILE"]) delete process.env[key];
  process.env.AUTOREVIEW_SINGLE_NODE = "1";
  const h = harness(), evidence = process.env.LOOP_STEP4_REVIEW2_EVIDENCE;
  const dir = join(h.home, ".pi-autoreview", "repo"), procs = join(dir, "unit-dev.procs.json");
  const leaseFile = join(h.git("rev-parse", "--path-format=absolute", "--git-common-dir"), "loop-project-execution.json");
  const leases = (): any[] => existsSync(leaseFile) ? JSON.parse(readFileSync(leaseFile, "utf8")) : [];
  const ready = join(h.root, "reviewer-ready.json"), script = join(h.root, "reviewer-barrier.mjs");
  const real = createChildExec(procs), inputs: string[] = [], receipts: Result[] = [];
  let job: Promise<Result> | undefined, first: ProcEntry | undefined;
  writeFileSync(script, `import {writeFileSync} from 'node:fs';\nconst [mode,ready]=process.argv.slice(2);\nif(mode==='block') {writeFileSync(ready,JSON.stringify({pid:process.pid,owner:process.env.AUTOREVIEW_PROCESS_OWNER}));console.log(${JSON.stringify(PASS)});setInterval(()=>{},1000);} else console.log(${JSON.stringify(PASS)});\n`);
  writeFileSync(join(h.root, "pa.json"), JSON.stringify({ pa: { localNotify: false } })); process.env.LOOP_PA_CONFIG = join(h.root, "pa.json");
  h.externalExec = (call) => {
    if (call.options.role !== "评审") return undefined;
    assert.equal(call.command, "/fake-reviewer", "只能调用本夹具的模型替身");
    inputs.push(readFileSync(call.args[1], "utf8")); const number = inputs.length;
    writeFileSync(join(h.root, `input-${number}.md`), inputs[number - 1]);
    job = (async () => {
      const result = await real(process.execPath, [script, number === 1 ? "block" : "pass", ready], { ...call.options, cwd: h.repo, timeout: 30_000, role: "评审" });
      receipts.push(result); writeFileSync(join(h.root, `receipt-${number}.json`), JSON.stringify(result, null, 2));
      if (number === 1 && proof !== "confirmed") return { ...result, processesReleased: proof === "missing" ? undefined : false };
      return result;
    })();
    return job;
  };
  try {
    await h.event("session_start"); await h.begin(criteria(1)); h.write("file.txt", "uncommitted change\n");
    const head = h.git("rev-parse", "HEAD");
    await h.command(); await until(() => existsSync(ready) && readProcs(procs).length === 1, "真实模型替身及进程登记均已就绪");
    first = readProcs(procs)[0]; const observed = JSON.parse(readFileSync(ready, "utf8"));
    assert.equal(first.pgid, observed.pid); assert.equal(first.token, observed.owner); assert.equal(ownedProcessGroupAlive(group(first)), true);
    assert.equal(h.state().phase, "reviewing"); assert.equal(leases().filter((l) => l.mode === "check").length, 2, "组合评审与静态调用实际持有各自租约");
    if (action === "input") await h.event("input", { source: "interactive", text: criteria(2) });
    else await h.event("session_shutdown", { reason: action });
    const afterCancellationCalls = h.apiCalls.length;
    await until(() => receipts.length === 1 && leases().every((l) => l.blocked), "回执已返回且原租约已结清或明确保留 blocked");
    assert.equal(receipts[0].processesReleased, true, "原真实执行器已按随机 owner/启动时间确认释放");
    assert.equal(receipts[0].processStarted, true); assert.equal(ownedProcessGroupAlive(group(first)), false);
    assert.equal(consumerProblem(procs), undefined);
    assert.equal(h.state().rounds.some((r) => r.conclusion === "通过"), false, "旧执行已取消，释放成功不等于旧结论有效");
    assert.equal(h.messages.length, 0, "取消不发产品返修");
    if (action === "input") {
      assert.equal(h.state().phase, "idle"); assert.match(JSON.stringify(h.state()), /REVISION_2/);
    } else {
      assert.equal(h.state().phase, "paused"); assert.equal(h.apiCalls.length, afterCancellationCalls, "关闭返回后旧任务不得再调用 Pi/ctx");
    }
    const beforeRecovery = structuredClone(leases());
    if (proof === "confirmed") {
      assert.deepEqual(beforeRecovery, [], "正常取消不能把已释放的执行变成永久 blocked");
      const unlock = await acquireProjectExecution(h.repo, "deploy", join(h.root, "probe.procs.json"), AbortSignal.timeout(2000)); unlock(true);
      assert.deepEqual(leases(), [], "同项目部署边界也可以正常取得并释放；没有执行真实部署");
      if (action !== "input") { await h.event("session_start"); await h.begin("恢复原任务"); }
      await h.command(); await h.terminal(); assert.equal(h.state().phase, "done", h.summary());
      assert.equal(inputs.length, 2); assert.equal(receipts[1].processesReleased, true); assert.deepEqual(leases(), []);
      if (action === "input") {
        const current = inputs[1].split("## 当前验收标准与授权（覆盖历史消息中的旧版本）")[1]?.split("\n## ")[0];
        assert.match(current ?? "", /第 2 版/); assert.match(current ?? "", /REVISION_2/);
      }
      assert.equal(h.git("rev-parse", "HEAD"), head, "旧单会话不自动提交用户工作区");
      assert.equal(readFileSync(join(h.repo, "file.txt"), "utf8"), "uncommitted change\n");
    } else {
      assert.ok(beforeRecovery.some((l) => l.blocked), "缺少/否定的释放证明不能凭登记为空洗白");
      await h.command(); await h.terminal(); assert.equal(h.state().phase, "paused");
      assert.equal(inputs.length, 1, "未知释放不重新调用模型"); assert.deepEqual(leases(), beforeRecovery);
      assert.match(h.summary(), /释放未确认/);
    }
  } finally {
    await h.event("session_shutdown", { reason: "quit" }); await job;
    await until(() => leases().every((l) => l.blocked), "本轮任务已停止写入租约");
    assert.equal(consumerProblem(procs), undefined);
    if (first) assert.equal(ownedProcessGroupAlive(group(first)), false);
    if (evidence) {
      const to = join(evidence, `${action}-${proof}`); mkdirSync(to, { recursive: true });
      for (const file of ["input-1.md", "input-2.md", "receipt-1.json", "receipt-2.json"]) if (existsSync(join(h.root, file))) cpSync(join(h.root, file), join(to, file));
      if (existsSync(dir)) cpSync(dir, join(to, "state-evidence"), { recursive: true });
      writeFileSync(join(to, "release-proof.json"), JSON.stringify({ root: h.root, first, firstAlive: first ? ownedProcessGroupAlive(group(first)) : null, procsProblem: consumerProblem(procs) ?? null, leases: leases(), receipts, inputs: inputs.length, phase: h.state()?.phase }, null, 2));
    }
    await h.close(); assert.equal(existsSync(h.root), false);
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved);
  }
}
