/**
 * procs.ts — 长进程登记：评审、验收方、被测系统都自成进程组，组号记到文件里。
 *
 * Hook 进程被宿主杀掉时，自成进程组的子进程不会跟着退出；没有登记就再也找不回来，
 * 恢复后还会和新起的同名会话撞车。这里只用同步调用，信号处理函数里也能用。
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface ProcEntry {
  pgid: number;
  role: string;
  command: string;
  /** 组长进程的启动时间（ps lstart）；进程号被复用后对不上就不杀。 */
  started: string;
  ownerPid: number;
  at: string;
  token?: string;
}

/** 组长进程的启动时间；进程不存在时为空字符串。 */
export function processStartTime(pid: number): string {
  const res = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 5000 });
  return res.status === 0 ? (res.stdout ?? "").trim() : "";
}

/** 进程组里还有没有进程（组长可能先退出，后代仍在）。 */
function groupAlive(pgid: number): boolean | undefined {
  const res = spawnSync("ps", ["-A", "-o", "pgid=,stat="], { encoding: "utf8", timeout: 5000 });
  if (res.status !== 0) return undefined;
  return (res.stdout ?? "").split("\n").some((line) => Number.parseInt(line.trim(), 10) === pgid && !/\sZ/.test(line));
}

export function readProcs(file: string): ProcEntry[] {
  try {
    const data = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return Array.isArray(data) ? data.filter((item): item is ProcEntry => Number.isInteger(item?.pgid) && item.pgid > 1) : [];
  } catch {
    return [];
  }
}

function writeProcs(file: string, entries: ProcEntry[]): void {
  if (entries.length === 0) {
    rmSync(file, { force: true });
    return;
  }
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(entries, null, 2));
  renameSync(tmp, file);
}

/** 登记一个刚启动、自成进程组的子进程（pid 即组号）。 */
export function registerProc(file: string, pid: number, role: string, command: string, token?: string): void {
  const entries = readProcs(file).filter((entry) => entry.pgid !== pid);
  entries.push({ pgid: pid, role, command, started: processStartTime(pid), ownerPid: process.pid, token, at: new Date().toISOString() });
  writeProcs(file, entries);
}

export function unregisterProc(file: string, pgid: number): void {
  const entries = readProcs(file);
  const rest = entries.filter((entry) => entry.pgid !== pgid);
  if (rest.length !== entries.length) writeProcs(file, rest);
}

export function killGroup(pgid: number, signal: NodeJS.Signals = "SIGKILL"): void {
  try { process.kill(-pgid, signal); } catch { /* 已经退出 */ }
}

function ownerAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** 只清理可证明归属的进程组；查询/清理失败保留登记，不能凭进程号猜。 */
export function releaseProc(file: string, pgid: number): boolean {
  const entry = readProcs(file).find((item) => item.pgid === pgid);
  if (!entry) return true;
  const alive = groupAlive(pgid);
  if (alive === false) { unregisterProc(file, pgid); return true; }
  if (alive === undefined) return false;
  const leader = processStartTime(pgid);
  if (leader && entry.started && leader !== entry.started) {
    unregisterProc(file, pgid); // PID 已复用，旧资源已不存在，绝不杀新进程。
    return true;
  }
  let ours = Boolean(leader && entry.started && leader === entry.started);
  if (!ours && entry.token) {
    const listed = spawnSync("ps", ["-A", "-o", "pid=,pgid="], { encoding: "utf8", timeout: 5000 });
    if (listed.status !== 0) return false;
    const members = listed.stdout.trim().split("\n").map((line) => line.trim().split(/\s+/).map(Number)).filter(([, group]) => group === pgid);
    ours = members.some(([pid]) => {
      const env = spawnSync("ps", ["eww", "-p", String(pid), "-o", "command="], { encoding: "utf8", timeout: 5000 });
      return env.status === 0 && env.stdout.split(/\s+/).includes(`AUTOREVIEW_PROCESS_OWNER=${entry.token}`);
    });
  }
  if (!ours) return false;
  killGroup(pgid);
  for (let i = 0; i < 10; i++) {
    if (groupAlive(pgid) === false) { unregisterProc(file, pgid); return true; }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  return false;
}

/** 默认只回收失去宿主的资源；信号处理可限定为本宿主。失败记录留给下次补漏。 */
export function reapProcs(file: string, options: { ownerPid?: number } = {}): ProcEntry[] {
  const released: ProcEntry[] = [];
  for (const entry of readProcs(file)) {
    const mine = options.ownerPid !== undefined ? entry.ownerPid === options.ownerPid : !ownerAlive(entry.ownerPid);
    if (mine && releaseProc(file, entry.pgid)) released.push(entry);
  }
  return released;
}
