import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";
import { eventLock } from "../events.ts";
import { nativePiOwnerConfirmed } from "../kernel-workspace.ts";
import type { KernelRun } from "../node-ledger.ts";
import { processStartTime } from "../procs.ts";

test("原生 Pi 身份须同时匹配原会话头、工作目录、父启动锁和 PID 启动时间；不凭名字/PID 放行", { skip: process.platform !== "darwin" }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "loop-native-owner-"))), ledger = join(root, "ledger.json"), log = join(root, "session.jsonl");
  const token = randomUUID(), session = randomUUID(), unlock = eventLock(`${ledger}.甲.launch.lock`);
  const child = spawn(process.execPath, ["-e", "process.title='pi'; setInterval(()=>{},1000)"], { cwd: root, detached: true, stdio: "ignore" });
  try {
    await new Promise<void>((ok, no) => { child.once("spawn", ok); child.once("error", no); }); await sleep(100);
    const pid = child.pid!, started = processStartTime(pid);
    const run = { worktree: root, card: { host: "pi", tasks: [{ name: "甲" }] },
      session: { host: "pi", id: session, log, pid, started, launchId: token }, launch: { pid, processStarted: started, token } } as KernelRun;
    writeFileSync(log, JSON.stringify({ type: "session", id: session, cwd: root }) + "\n");
    assert.equal(nativePiOwnerConfirmed(run, ledger), true);
    assert.equal(nativePiOwnerConfirmed({ ...run, session: { ...run.session!, started: "wrong" } }, ledger), false);
    assert.equal(nativePiOwnerConfirmed({ ...run, session: { ...run.session!, launchId: "wrong" } }, ledger), false);
    assert.equal(nativePiOwnerConfirmed({ ...run, worktree: tmpdir() }, ledger), false);
    writeFileSync(log, JSON.stringify({ type: "session", id: "another-session", cwd: root }) + "\n");
    assert.equal(nativePiOwnerConfirmed(run, ledger), false);
    writeFileSync(log, JSON.stringify({ type: "session", id: session, cwd: root }) + "\n"); unlock();
    assert.equal(nativePiOwnerConfirmed(run, ledger), false);
  } finally {
    child.kill("SIGTERM"); await new Promise<void>((ok) => { if (child.exitCode !== null || child.signalCode !== null) ok(); else child.once("close", () => ok()); });
    unlock(); rmSync(root, { recursive: true, force: true });
  }
});
