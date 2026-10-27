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
  /** 已确认归属的独立工具组；清理未确认时保留，后续补漏不能忘掉已失去组长的命令。 */
  toolGroups?: number[];
  /** 这次进程属于哪次运行（资源编号）；旧登记没有，按身份不明继续保护。 */
  runId?: string;
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

/** 登记一个刚启动、自成进程组的子进程（pid 即组号）；runId 标记它属于哪次运行。 */
export function registerProc(file: string, pid: number, role: string, command: string, token?: string, runId?: string): void {
  const entries = readProcs(file).filter((entry) => entry.pgid !== pid);
  entries.push({ pgid: pid, role, command, started: processStartTime(pid), ownerPid: process.pid, token, ...(runId ? { runId } : {}), at: new Date().toISOString() });
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

/** Pi 的 bash 工具有自己的进程组；按继承的随机 owner 标记查找，不能只看原组是否消失。 */
function tokenProcesses(token: string): { pid: number; pgid: number }[] | undefined {
  const listed = spawnSync("ps", ["eww", "-A", "-o", "pid=,pgid=,stat=,command="], {
    encoding: "utf8", timeout: 5000, maxBuffer: 32 * 1024 * 1024,
  });
  if (listed.status !== 0) return undefined;
  return listed.stdout.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!match || match[3].startsWith("Z") || !match[4].split(/\s+/).includes(`AUTOREVIEW_PROCESS_OWNER=${token}`)) return [];
    const pid = Number(match[1]);
    return pid > 1 && pid !== process.pid ? [{ pid, pgid: Number(match[2]) }] : [];
  });
}

/** 原组及脱离原组的工具都须停止；扫描失败或无法证明归属时返回 false，不发布释放成功。 */
export function releaseProcessTree(entry: Pick<ProcEntry, "pgid" | "started" | "token" | "toolGroups">): boolean {
  const toolGroups = new Set<number>(entry.toolGroups ?? []);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const alive = groupAlive(entry.pgid);
    const owned = entry.token ? tokenProcesses(entry.token) : [];
    if (alive === undefined || owned === undefined) return false;
    const leader = alive ? processStartTime(entry.pgid) : "";
    const reused = Boolean(leader && entry.started && leader !== entry.started);
    const remainingGroups = [...toolGroups].map(groupAlive);
    if (remainingGroups.some((state) => state === undefined)) return false;
    if ((!alive || reused) && owned.length === 0 && remainingGroups.every((state) => state === false)) return true;
    if (alive && !reused) {
      const ours = Boolean(leader && entry.started && leader === entry.started)
        || owned.some((item) => item.pgid === entry.pgid);
      if (!ours) return false;
      killGroup(entry.pgid);
    }
    for (const { pid } of owned) {
      // 杀之前再核对标记，避免扫描与发送信号之间 PID 被复用后误杀。
      const current = spawnSync("ps", ["eww", "-p", String(pid), "-o", "pgid=,stat=,command="], { encoding: "utf8", timeout: 5000 });
      if (current.status !== 0) { if (ownerAlive(pid)) return false; else continue; }
      const identity = /^\s*(\d+)\s+(\S+)/.exec(current.stdout);
      if (identity?.[2].startsWith("Z")) continue;
      if (!current.stdout.split(/\s+/).includes(`AUTOREVIEW_PROCESS_OWNER=${entry.token}`)) return false;
      // 已确认归属的工具组长：关停整个工具组，含工具自行更改环境变量的同组命令，并再次确认该组消失。
      try {
        if (Number(identity?.[1]) === pid) {
          toolGroups.add(pid); entry.toolGroups = [...toolGroups]; killGroup(pid);
        }
        else process.kill(pid, "SIGKILL");
      }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false; }
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  return false;
}

/** 查询和清理全部成功才注销；原组消失不再等于本次调用的消费者全部消失。 */
export function releaseProc(file: string, pgid: number, expected?: ProcEntry): boolean {
  const saved = readProcs(file).find((item) => item.pgid === pgid);
  const entry = expected ? { ...expected, toolGroups: saved?.token === expected.token ? saved?.toolGroups : undefined } : saved;
  if (!entry) return true;
  if (!releaseProcessTree(entry)) {
    if (!saved || saved.token === entry.token) {
      writeProcs(file, [...readProcs(file).filter((item) => item.pgid !== pgid), entry]);
    }
    return false;
  }
  // 执行器保留启动时的身份，不以登记被移除作为释放证明，也不能注销 PID 复用后的另一条登记。
  if (!expected || saved?.token === expected.token) unregisterProc(file, pgid);
  return true;
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
