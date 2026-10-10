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
}

/** 组长进程的启动时间；进程不存在时为空字符串。 */
function startTime(pid: number): string {
  const res = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 5000 });
  return res.status === 0 ? (res.stdout ?? "").trim() : "";
}

/** 进程组里还有没有进程（组长可能先退出，后代仍在）。 */
function groupAlive(pgid: number): boolean {
  const res = spawnSync("ps", ["-A", "-o", "pgid="], { encoding: "utf8", timeout: 5000 });
  return (res.stdout ?? "").split("\n").some((line) => Number.parseInt(line.trim(), 10) === pgid);
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
export function registerProc(file: string, pid: number, role: string, command: string): void {
  const entries = readProcs(file).filter((entry) => entry.pgid !== pid);
  entries.push({ pgid: pid, role, command, started: startTime(pid), ownerPid: process.pid, at: new Date().toISOString() });
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

/**
 * 杀掉登记里仍活着的进程组并移出登记，返回被杀的条目。
 * 默认只处理登记者已经死掉的条目（孤儿）；给了 ownerPid 时只处理这个进程登记的条目（信号处理用）。
 * 组长还在且启动时间对得上才杀；组长不在但组里还有后代也杀；进程号被别的进程复用时只移出登记。
 */
export function reapProcs(file: string, options: { ownerPid?: number } = {}): ProcEntry[] {
  const entries = readProcs(file);
  if (entries.length === 0) return [];
  const killed: ProcEntry[] = [];
  const kept: ProcEntry[] = [];
  for (const entry of entries) {
    const mine = options.ownerPid !== undefined ? entry.ownerPid === options.ownerPid : !ownerAlive(entry.ownerPid);
    if (!mine) {
      kept.push(entry);
      continue;
    }
    const leader = startTime(entry.pgid);
    // 登记时没取到启动时间（ps 失败）就只能信组号。
    const ours = leader ? !entry.started || leader === entry.started : groupAlive(entry.pgid);
    if (ours) {
      killGroup(entry.pgid);
      killed.push(entry);
    }
  }
  writeProcs(file, kept);
  return killed;
}
