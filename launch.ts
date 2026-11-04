/** 正式启动组及运行代次：候选 spawn 不能覆盖已经取得运行权的活动身份。 */
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { batchInfoPath, canonicalBatchFile, eventLock, recordBatchInfo, type BatchInfo } from "./events.ts";
import { readJson, writeJsonAtomic } from "./pipeline-core.ts";
import { ownedProcessGroupAlive, processGroup, processStartTime, releaseProcessTree, signalOwnedProcessGroup, type SessionGroup } from "./procs.ts";

export interface BatchLaunch extends SessionGroup {
  batchFile: string;
  stage: string | null;
  /** spawn 身份用于前台取消；runId 绑定实际取得的运行权。 */
  id?: string;
  runId?: string;
  active?: boolean;
}
export interface BatchRun { runId: string; launch?: BatchLaunch; release: () => void }
export const launchPath = (dir: string, stage: string | null): string => join(dir, stage === null ? "batch.launch.json" : `${stage.replace(/[/\\:*?"<>|\s]+/g, "_")}.launch.json`);
const spawned = new WeakMap<ChildProcess, BatchLaunch>();

/** 只有实际执行器取得运行锁后才能发布活动组。队列入口另传其运行锁代次。 */
export function beginBatchRun(info: BatchInfo, grantedRunId?: string): BatchRun {
  const id = process.env.AUTOREVIEW_LAUNCH_ID || randomUUID(), runId = grantedRunId ?? randomUUID();
  if (!info.batch.file) return { runId, release: () => {} };
  let unlock: () => void;
  try { unlock = eventLock(join(info.dir, ".batch.run.lock"), 0); }
  catch (error) { throw new Error(`本批运行权不可用，未重复启动：${String(error)}`); }
  let launch: BatchLaunch | undefined;
  try {
    const group = { pid: process.pid, processStarted: processStartTime(process.pid), token: process.env.AUTOREVIEW_PROCESS_OWNER ?? "" };
    if (processGroup(process.pid) === process.pid && ownedProcessGroupAlive(group) === true) {
      launch = { ...group, batchFile: canonicalBatchFile(info.batch.file), stage: null, id, runId, active: true };
    }
    // 这次已经取得运行权；未取得的候选不写 batch.info / batch.launch / phase。
    writeJsonAtomic(batchInfoPath(info.dir), info);
    if (launch) writeJsonAtomic(launchPath(info.dir, null), launch);
  } catch (error) { unlock(); throw error; }
  return { runId, launch, release: () => {
    try {
      const current = readJson<BatchLaunch>(launchPath(info.dir, null));
      if (launch && current && current.runId === runId && current.pid === launch.pid && current.processStarted === launch.processStarted) {
        writeJsonAtomic(launchPath(info.dir, null), { ...current, active: false });
      }
    } finally { unlock(); }
  } };
}

/** 根执行器先留候选，自己取得运行权后发布；段由已持权的编排/前台入口派发。 */
export function startBatchProcess(info: BatchInfo, stage: string | null, command: string, args: string[], options: SpawnOptions): ChildProcess {
  const token = randomUUID(), id = randomUUID();
  const path = launchPath(info.dir, stage);
  const unlock = stage === null ? () => {} : eventLock(`${path}.publish.lock`, 0);
  try {
    if (stage !== null) {
      const previous = readJson<BatchLaunch>(path);
      if (previous && previous.active !== false && ownedProcessGroupAlive(previous) !== false) throw new Error(`段 ${stage} 仍有活动启动或归属未确认，未覆盖登记`);
    }
    const child = spawn(command, args, { ...options, detached: true,
      env: { ...(options.env ?? process.env), AUTOREVIEW_PROCESS_OWNER: token, AUTOREVIEW_LAUNCH_ID: id } });
    child.on("error", () => {}); // 后台入口也不能产生未处理 error；前台等待器另报启动失败。
    if (child.pid) {
      const record: BatchLaunch = { batchFile: canonicalBatchFile(info.batch.file), stage, pid: child.pid,
        processStarted: processStartTime(child.pid), token, id, runId: id, active: stage !== null };
      spawned.set(child, record);
      try {
        writeJsonAtomic(join(info.dir, "launches", `${id}.json`), record);
        if (stage !== null) { recordBatchInfo(info); writeJsonAtomic(path, record); }
      } catch (error) {
        releaseProcessTree({ pgid: record.pid, started: record.processStarted, token });
        throw error;
      }
    }
    return child;
  } finally { unlock(); }
}

/** 前台等待器按本次 spawn 的不可变身份转发取消，子进程收尾前不退出。 */
export async function runBatchCommand(info: BatchInfo, stage: string | null, command: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv; capture: boolean }): Promise<{ status: number; stdout: string; stderr: string; error?: Error }> {
  const child = startBatchProcess(info, stage, command, args, { cwd: options.cwd, env: options.env, stdio: options.capture ? ["inherit", "pipe", "pipe"] : "inherit" });
  const group = spawned.get(child);
  let stdout = "", stderr = "", error: Error | undefined;
  child.stdout?.on("data", (data) => { stdout += data; });
  child.stderr?.on("data", (data) => { stderr += data; });
  child.once("error", (value) => { error = value; });
  return new Promise((accept) => {
    let settled = false, cancelling = false, cancellationCode = 1;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const handlers = (["SIGINT", "SIGTERM", "SIGHUP"] as const).map((signal) => ({ signal, handler: () => cancel(signal) }));
    const finish = (status: number | null): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      for (const { signal, handler } of handlers) process.off(signal, handler);
      accept({ status: cancelling && !status ? cancellationCode : status ?? 1, stdout, stderr, error });
    };
    const cancel = (signal: NodeJS.Signals): void => {
      if (settled || cancelling) return;
      cancelling = true;
      cancellationCode = signal === "SIGINT" ? 130 : signal === "SIGHUP" ? 129 : 143;
      const result = group ? signalOwnedProcessGroup(group, signal) : { signalled: false, reason: "没有本次启动的完整组身份" };
      if (result.reason) stderr += `\nLoop 取消未确认：${result.reason}\n`;
      // 正常关闭仍由 close 返回；超出有界收尾后仅补偿本次 spawn，并明确失败。
      timer = setTimeout(() => {
        if (settled) return;
        const released = group && releaseProcessTree({ pgid: group.pid, started: group.processStarted, token: group.token });
        const detail = released ? "前台取消收尾超时，已按本次身份结束残留组" : "前台取消资源释放未确认，保留登记";
        error = new Error(detail); stderr += `\n${detail}\n`;
        child.stdout?.destroy(); child.stderr?.destroy(); child.unref();
        finish(cancellationCode);
      }, 130_000); // 容纳现有默认 120 秒外部 cleanup，再有界补偿。
    };
    for (const { signal, handler } of handlers) process.on(signal, handler);
    child.once("close", finish);
  });
}

/** Terminal 只输入短脚本路径；完整命令与身份通过私有文件传递，不经过终端行缓冲。 */
export function terminalStageCommand(info: BatchInfo, stage: string, cwd: string, script: string): { command: string; release: () => void } {
  const root = mkdtempSync(join(tmpdir(), "loop-terminal-")), token = randomUUID();
  const file = join(root, "payload.json"), wrapper = join(root, "start.sh");
  const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
  const release = () => rmSync(root, { recursive: true, force: true });
  try {
    writeFileSync(file, JSON.stringify({ info, stage, cwd, script, token, root }), { mode: 0o600 });
    writeFileSync(wrapper, `#!/bin/sh\nexec ${[process.execPath, fileURLToPath(import.meta.url), "--payload", file, token].map(quote).join(" ")}\n`, { mode: 0o700 });
    const command = `/bin/sh ${quote(wrapper)}`;
    if (Buffer.byteLength(command) >= 1024) throw new Error("系统临时目录路径过长，无法安全派发 Terminal 短命令");
    return { command, release };
  } catch (error) { release(); throw error; }
}

/** Terminal 只打开窗口；窗口内仍由同一启动器建立独立组，绝不结束终端自己的组。 */
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let [raw, stage, cwd, script] = process.argv.slice(2);
  try {
    let info: BatchInfo;
    if (raw === "--payload") {
      const file = stage, token = cwd;
      const payload = JSON.parse(readFileSync(file, "utf8"));
      if (!token || payload.token !== token || resolve(file) !== join(payload.root, "payload.json")) throw new Error("Terminal 启动文件身份不匹配，未执行或删除");
      ({ info, stage, cwd, script } = payload);
      // 只删除持有随机凭据的这一份生成物；不按名称/年龄扫描系统临时目录。
      rmSync(payload.root, { recursive: true });
    } else info = JSON.parse(raw) as BatchInfo;
    if (!info.batch?.file || !info.dir || !stage || !cwd || !script) throw new Error("缺少批次启动身份");
    void runBatchCommand(info, stage, "/bin/sh", ["-c", script], { cwd, capture: false })
      .then((result) => { process.exitCode = result.status; })
      .catch((error) => { process.stderr.write(`Loop 启动失败：${String(error)}\n`); process.exitCode = 1; });
  } catch (error) { process.stderr.write(`Loop 启动失败：${String(error)}\n`); process.exitCode = 1; }
}
