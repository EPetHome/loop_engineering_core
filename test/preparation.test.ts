import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";
import { fakeKernelLauncher, kernelFixture } from "./helpers/kernel-fixture.ts";
import { parsePreparation, runPreparation, type PreparationState } from "../preparation.ts";
import { launchKernel, managedLaunchArgs, stopKernel } from "../kernel-runtime.ts";
import { queryKernel } from "../kernel.ts";
import { readRun, updateRun } from "../node-ledger.ts";
import { attachSession, consumeManagedRepair, prepareManagedContinuation } from "../kernel-session.ts";
import { readMethodsRecord, runMethodsSelfTest } from "../methods.ts";

const quote = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`;
async function until(check: () => boolean, detail: () => string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!check() && Date.now() < deadline) await sleep(30);
  assert.ok(check(), detail());
}
function configure(f: ReturnType<typeof kernelFixture>, preparation?: object, methods?: object): void {
  const file = join(f.repo, ".autoreview.json"), raw = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(file, JSON.stringify({ ...raw, preparation, methods }));
}

test("准备补装：推断 method、unknown 和产品断言均先恢复；登记次数续跑不清零", async () => {
  for (const message of ["Error: Cannot find module 'core'", "opaque failure", "AssertionError: core unavailable"]) {
    const f = kernelFixture(["开发评审"]);
    try {
      const flag = join(f.root, "ready"), state: PreparationState = {}, saved: string[] = [];
      const config = parsePreparation({ check: `test -f ${quote(flag)} || { printf '%s\\n' ${quote(message)} >&2; exit 1; }`, recover: `touch ${quote(flag)}`, maxRecoveries: 1 }, f.repo)!;
      const deps = { config, cwd: f.repo, state, exec: f.exec, runDir: join(f.root, "preparation"), saveState: () => { saved.push(JSON.stringify(state)); } };
      const first = await runPreparation(deps);
      assert.equal(first.ok, true, first.reason); assert.deepEqual(state.preparationAttempts, { environment: 1, method: 0 });
      assert.equal(saved.length, 1); assert.match(readFileSync(first.log, "utf8"), /recover #1 exit=0[\s\S]*check exit=0/);
      rmSync(flag);
      const resumed = await runPreparation({ ...deps, state: JSON.parse(saved[0]) });
      assert.equal(resumed.ok, false); assert.match(resumed.reason!, /补装次数用完，未补装.*剩余补装次数：0.*下一步命令/);
      assert.ok(resumed.reason!.includes(message)); assert.equal(saved.length, 1);
    } finally { f.cleanup(); }
  }
});

test("准备 A1：新卡缺依赖补装复查后启动开发", async () => {
  const f = kernelFixture(["开发评审"]); let path: string | undefined;
  try {
    writeFileSync(join(f.repo, ".gitignore"), `${readFileSync(join(f.repo, ".gitignore"), "utf8")}node_modules/\ndist/\n`);
    f.git(f.repo, "add", ".gitignore"); f.git(f.repo, "commit", "-qm", "ignored dependencies");
    configure(f, { check: `node -e "require('core')"`, recover: "mkdir -p node_modules/core; printf 'module.exports=1' > node_modules/core/index.js", maxRecoveries: 1 });
    fakeKernelLauncher(f); process.env.KERNEL_FAKE_ACTION = "idle";
    path = f.start(); const initial = readRun(path); assert.equal(existsSync(join(initial.worktree, "node_modules")), false);
    await launchKernel(path, true);
    await until(() => !!readRun(path!).session, () => JSON.stringify(queryKernel(path!)));
    const run = readRun(path); assert.equal(run.preparationStatus!.ready, true); assert.equal(run.stopped, false);
    assert.match(readFileSync(join(run.dir, "preparation/preparation.log"), "utf8"), /Cannot find module[\s\S]*recover #1 exit=0[\s\S]*check exit=0/);
    assert.ok(JSON.parse(readFileSync(join(run.dir, "host-argv.json"), "utf8")).includes(`@${run.card.tasks[0].prompt}`));
  } finally { if (path) await stopKernel(path); f.cleanup(); }
});

test("准备 A2/A3：声明方法错误、无恢复或恢复仍失败均写明原因并启动开发，开工信封保留原任务", async () => {
  for (const mode of ["marker", "exit78", "missing", "exhausted", "still-failed"]) {
    const f = kernelFixture(["开发评审"]); let path: string | undefined;
    try {
      const flag = join(f.root, "recovered"), message = mode === "marker" ? "AUTOREVIEW_FAILURE=method broken entry" : "Error: Cannot find module 'core'";
      configure(f, { check: `printf '%s\\n' ${quote(message)} >&2; exit ${mode === "exit78" ? 78 : 1}`, ...(mode !== "missing" ? { recover: `touch ${quote(flag)}` } : {}), maxRecoveries: mode === "exhausted" ? 0 : 1 });
      fakeKernelLauncher(f); process.env.KERNEL_FAKE_ACTION = "idle";
      path = f.start(); await launchKernel(path, true);
      await until(() => !!readRun(path!).session, () => JSON.stringify(queryKernel(path!)));
      const run = readRun(path), status = queryKernel(path);
      const reason = mode === "marker" || mode === "exit78" ? /项目声明方法错误，未补装/ : mode === "missing" ? /未配置 recover，未补装/ : /补装次数用完，未补装/;
      assert.equal(run.stopped, false); assert.equal(run.preparationStatus!.ready, false); assert.equal(run.repairs, 0);
      assert.equal(existsSync(flag), mode === "still-failed");
      assert.match(status.lines.join("\n"), /环境未就绪/); assert.match(status.lines.join("\n"), reason);
      assert.match(readFileSync(join(run.dir, "summary.md"), "utf8"), /原始错误：.*剩余补装次数：\d.*下一步命令/);
      const argv = JSON.parse(readFileSync(join(run.dir, "host-argv.json"), "utf8")); assert.ok(argv.includes(`@${run.preparationStatus!.startupFile}`));
      const envelope = readFileSync(run.preparationStatus!.startupFile!, "utf8");
      assert.match(envelope, /环境未就绪/); assert.match(envelope, reason); assert.ok(envelope.includes(message));
      assert.ok(envelope.includes(readFileSync(run.card.tasks[0].prompt, "utf8")));
    } finally { if (path) await stopKernel(path); f.cleanup(); }
  }
});

test("准备 A3：续跑信封带当前环境原因，恢复后去掉旧告警，不清零次数或改用户版本", () => {
  const f = kernelFixture(["开发评审"]);
  try {
    const path = f.start(), initial = readRun(path); attachSession(path, "pi", "original", join(initial.dir, "session.jsonl"));
    updateRun(path, (r) => { r.repairs = 2; r.counters = { 测试: { repairs: 1, recoveries: 1 } }; r.preparationStatus = { ready: false, reasons: ["Cannot find module core；未配置 recover，未补装"], at: "now" }; });
    prepareManagedContinuation(path); const warned = readRun(path), repair = warned.repair!;
    assert.match(repair.message, /环境未就绪.*\nCannot find module/); assert.ok(managedLaunchArgs(path).args.includes(`@${repair.file}`));
    prepareManagedContinuation(path); assert.equal(readRun(path).repair!.id, repair.id);
    updateRun(path, (r) => { r.preparationStatus = { ready: true, reasons: [], at: "later" }; });
    prepareManagedContinuation(path); const ready = readRun(path);
    assert.equal(ready.repair!.id, repair.id); assert.doesNotMatch(ready.repair!.message, /环境未就绪/);
    assert.equal(consumeManagedRepair(path, ready.repair!.message), true); assert.equal(readRun(path).userVersion, 0);
    assert.equal(ready.repairs, 2); assert.deepEqual(ready.counters, warned.counters);
  } finally { f.cleanup(); }
});

test("准备 A4：方法自检失败不缓存通过指纹，仍启动开发并通知原始原因", async () => {
  const f = kernelFixture(["开发评审"]); let path: string | undefined;
  try {
    configure(f, undefined, { paths: ["prompt.md"], selfCheck: "printf 'AUTOREVIEW_FAILURE=method selfCheck unavailable\\n' >&2; exit 78" });
    fakeKernelLauncher(f); process.env.KERNEL_FAKE_ACTION = "idle";
    path = f.start(); await launchKernel(path, true);
    await until(() => !!readRun(path!).session, () => JSON.stringify(queryKernel(path!)));
    const run = readRun(path); assert.equal(run.stopped, false); assert.equal(run.preparationStatus!.ready, false);
    assert.match(queryKernel(path).lines.join("\n"), /环境未就绪.*方法自测未通过.*selfCheck unavailable/);
    assert.match(readFileSync(run.preparationStatus!.startupFile!, "utf8"), /selfCheck unavailable/);
    assert.equal(readMethodsRecord(run.worktree)?.fingerprint ?? "", "", "权限检查可单独留记录，但不得缓存方法自测通过指纹");
    const again = await runMethodsSelfTest(run.worktree, { loopRoot: fileURLToPath(new URL("..", import.meta.url)), procsFile: join(run.dir, "methods.procs.json") });
    assert.equal(again.skipped, false); assert.equal(again.selfCheck!.passed, false); assert.equal(again.written, false);
  } finally { if (path) await stopKernel(path); f.cleanup(); }
});

test("准备 A5：准备检查和方法自检即使失败，改候选、输入或稳定规则仍禁止启动", async () => {
  for (const kind of ["preparation", "methods"]) for (const target of ["file.txt", "AGENTS.md", "input"]) {
    const f = kernelFixture(["开发评审"]);
    try {
      const command = `printf changed > ${target === "input" ? quote(join(f.repo, "prompt.md")) : target}; exit 1`;
      configure(f, kind === "preparation" ? { check: command } : undefined, kind === "methods" ? { paths: ["prompt.md"], selfCheck: command } : undefined);
      const path = f.start(); await launchKernel(path);
      const run = readRun(path); assert.equal(run.stopped, true); assert.equal(run.session, undefined);
      assert.match(run.stopReason!, /改动候选\/输入或稳定规则/); assert.equal(existsSync(join(run.dir, "host-argv.json")), false);
    } finally { f.cleanup(); }
  }
});

test("准备 A5：恢复失败也不能掩盖越界或稳定规则改动", async () => {
  for (const file of ["file.txt", "AGENTS.md"]) {
    const f = kernelFixture(["开发评审"]);
    try {
      const config = parsePreparation({ check: "echo 'Cannot find module core' >&2; exit 1", recover: `printf changed > ${file}; exit 1` }, f.repo)!;
      const result = await runPreparation({ config, cwd: f.repo, exec: f.exec, state: {}, runDir: join(f.root, "preparation"), saveState: () => {} });
      assert.equal(result.ok, false); assert.equal(result.blocked, true); assert.match(result.reason!, /越出修改范围|稳定规则/);
    } finally { f.cleanup(); }
  }
});
