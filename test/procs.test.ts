/** 跨组释放的行为验证：直接检查存活进程和持续写入，不用空登记表代替资源释放。 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createChildExec } from "../hosts/hook.ts";
import { processStartTime, readProcs, reapProcs, registerProc, releaseProc } from "../procs.ts";

const running = (pid: number): boolean => {
  const ps = spawnSync("ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8" });
  return ps.status === 0 && !ps.stdout.trim().startsWith("Z");
};

test("登记被移除也须释放独立工具组及同组清空 owner 的命令，不能误杀别的调用", async () => {
  const root = mkdtempSync(join(tmpdir(), "autoreview-detached-tool-"));
  const procs = join(root, "procs.json"), info = join(root, "spawned.json"), writes = join(root, "writes");
  const foreign = spawn(process.execPath, ["-e", "setTimeout(()=>{},30000)"], { detached: true, stdio: "ignore", env: { ...process.env, AUTOREVIEW_PROCESS_OWNER: "another-call" } });
  const workerCode = `const fs=require('node:fs'); setInterval(()=>fs.appendFileSync(${JSON.stringify(writes)},'tick\\n'),50); setTimeout(()=>process.exit(),30000);`;
  const toolCode = `const {spawn,spawnSync}=require('node:child_process'); const fs=require('node:fs');
    const env={...process.env}; delete env.AUTOREVIEW_PROCESS_OWNER;
    const worker=spawn(process.execPath,['-e',${JSON.stringify(workerCode)}],{env,stdio:'ignore'});
    const started=pid=>spawnSync('ps',['-p',String(pid),'-o','lstart='],{encoding:'utf8'}).stdout.trim();
    fs.writeFileSync(${JSON.stringify(info)},JSON.stringify([{pid:process.pid,started:started(process.pid)},{pid:worker.pid,started:started(worker.pid)}]));
    setTimeout(()=>process.exit(),30000);`;
  const launch = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(toolCode)}],{detached:true,stdio:'ignore'}).unref(); setTimeout(()=>console.log('REMOVE_REGISTRY'),200); setTimeout(()=>{},30000);`;
  try {
    let removed = false, stopNotifications = 0, toolWasRunningAtStop = false;
    const result = await createChildExec(procs)(process.execPath, ["-e", launch], { cwd: root, timeout: 2000, role: "验收方", onOutput: (text) => {
      if (text.includes("REMOVE_REGISTRY")) { rmSync(procs, { force: true }); removed = true; }
    }, onBeforeStop: () => {
      stopNotifications += 1;
      if (existsSync(info)) toolWasRunningAtStop = JSON.parse(readFileSync(info, "utf8")).every((item: { pid: number }) => running(item.pid));
    } });
    assert.equal(stopNotifications, 1, "中止与 close 只能通知一次，不能用清理后的状态覆盖中止现场");
    assert.equal(toolWasRunningAtStop, true, "终止观测必须先于独立工具组清理");
    assert.equal(removed, true, "即使登记表已空，仍须用启动时的身份做真实清理");
    assert.equal(result.killed, true);
    assert.ok(existsSync(info), "工具与命令均已真实启动");
    const spawned: { pid: number; started: string }[] = JSON.parse(readFileSync(info, "utf8"));
    for (const item of spawned) assert.equal(running(item.pid), false, "Pi 原组之外的工具及命令都必须停止");
    const before = readFileSync(writes, "utf8");
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(readFileSync(writes, "utf8"), before, "返回之后不能继续操作数据");
    assert.deepEqual(readProcs(procs), []);
    assert.equal(running(foreign.pid!), true, "不同随机归属标记的进程不能被清理");
  } finally {
    // 只补偿本测试 spawn 回执中记录、且启动身份仍匹配的进程，不按名字/端口猜测归属。
    reapProcs(procs, { ownerPid: process.pid });
    if (existsSync(info)) for (const item of JSON.parse(readFileSync(info, "utf8"))) {
      if (item.started && processStartTime(item.pid) === item.started && running(item.pid)) process.kill(item.pid, "SIGKILL");
    }
    if (foreign.exitCode === null && !foreign.signalCode) foreign.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});

test("终止观测失败也必须清理进程并明确暂停，不能妨碍回收或补成通过", async () => {
  const root = mkdtempSync(join(tmpdir(), "autoreview-stop-observation-")), file = join(root, "procs.json");
  let pid: number | undefined, notifications = 0;
  try {
    const result = await createChildExec(file)(process.execPath, ["-e", "setTimeout(()=>{},30000)"], { cwd: root, timeout: 200, role: "验收方",
      onBeforeStop: () => { notifications += 1; pid = readProcs(file)[0]?.pgid; throw new Error("observer unavailable"); } });
    assert.equal(notifications, 1);
    assert.equal(result.killed, true);
    assert.equal(result.code, 75);
    assert.match(result.stderr, /调用终止状态观测失败/);
    assert.equal(result.processesReleased, true);
    assert.ok(pid);
    assert.equal(running(pid!), false);
    assert.deepEqual(readProcs(file), []);
  } finally {
    reapProcs(file, { ownerPid: process.pid });
    rmSync(root, { recursive: true, force: true });
  }
});

test("补漏不能忘记已识别但尚未消失的工具组；仅在确认停止后注销", async () => {
  const root = mkdtempSync(join(tmpdir(), "autoreview-tool-group-")), file = join(root, "procs.json");
  const tool = spawn(process.execPath, ["-e", "setTimeout(()=>{},30000)"], { detached: true, stdio: "ignore" });
  try {
    registerProc(file, 999_999_998, "已退出的验收方", "fixture", "completed-owner");
    const entry = readProcs(file)[0]; entry.toolGroups = [tool.pid!];
    writeFileSync(file, JSON.stringify([entry]));
    assert.equal(releaseProc(file, entry.pgid), false, "原组不存在、随机标记已消失，也不能忘记尚未停止的已识别工具组");
    assert.deepEqual(readProcs(file)[0].toolGroups, [tool.pid]);
    assert.equal(running(tool.pid!), true, "身份无法复核时不向未知组盲目发送信号");
    const closed = new Promise<void>((resolve) => tool.once("close", () => resolve())); tool.kill("SIGKILL"); await closed;
    assert.equal(releaseProc(file, entry.pgid), true);
    assert.deepEqual(readProcs(file), []);
  } finally {
    if (tool.exitCode === null && !tool.signalCode) tool.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});
