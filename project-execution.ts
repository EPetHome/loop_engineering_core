/** 项目检查读租约 / 部署独占租约。短锁只登记身份，不跨命令等待；与本机测试槽无关。 */
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { eventLock } from "./events.ts";
import { gitResult } from "./workspace.ts";
import { processStartTime } from "./procs.ts";
import { consumerProblem } from "./local-node-queue.ts";

interface Lease { token: string; pid: number; started: string; mode: "check" | "deploy"; procs: string; blocked?: boolean }
export async function acquireProjectExecution(cwd: string, mode: Lease["mode"], procs: string, signal?: AbortSignal, live: () => void = () => {}, waiting: () => void = () => {}): Promise<(released: boolean) => void> {
  const probe = gitResult(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (probe.status !== 0) return () => {}; // 旧单会话非 Git 行为不变。
  const file = join(probe.stdout.trim(), "loop-project-execution.json"), lock = `${file}.lock`, token = randomUUID();
  const mine: Lease = { token, pid: process.pid, started: processStartTime(process.pid), mode, procs };
  if (!mine.started) throw new Error("项目执行租约无法核对进程启动身份");
  const change = <T>(fn: (rows: Lease[]) => T): T => {
    const unlock = eventLock(lock);
    try {
      const rows: Lease[] = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
      if (!Array.isArray(rows) || rows.some((r) => !r.token || !r.started || !Number.isSafeInteger(r.pid) || r.pid < 2 || !["check", "deploy"].includes(r.mode) || typeof r.procs !== "string")) throw new Error(`项目租约身份损坏，保留：${file}`);
      const result = fn(rows), temp = `${file}.${randomUUID()}.tmp`;
      try { writeFileSync(temp, JSON.stringify(rows), { mode: 0o600, flag: "wx" }); renameSync(temp, file); }
      finally { rmSync(temp, { force: true }); }
      return result;
    } finally { unlock(); }
  };
  for (;;) {
    signal?.throwIfAborted(); live();
    const granted = change((rows) => {
      for (let i = rows.length - 1; i >= 0; i--) {
        const r = rows[i], start = processStartTime(r.pid);
        let dead = !!start && start !== r.started;
        if (!start) try { process.kill(r.pid, 0); } catch (e) { dead = (e as NodeJS.ErrnoException).code === "ESRCH"; }
        if (dead && !r.blocked && !consumerProblem(r.procs) && !consumerProblem(`${r.procs}.cleanup`)) rows.splice(i, 1);
      }
      const blocked = rows.find((r) => r.blocked);
      if (blocked) throw new Error(`同项目消费者释放未确认，保留阻塞租约；请核对原登记而非盲目等待/重试：${blocked.procs || file}`);
      if (rows.some((r) => mode === "deploy" || r.mode === "deploy")) return false;
      rows.push(mine); return true;
    });
    if (granted) break;
    waiting();
    await sleep(100, undefined, { signal });
  }
  return (released) => change((rows) => {
    const at = rows.findIndex((r) => r.token === token && r.pid === mine.pid && r.started === mine.started);
    if (at < 0) return; // 统一停止已按本尝试登记路径结清，不删除其他 token。
    if (released && !consumerProblem(procs) && !consumerProblem(`${procs}.cleanup`)) rows.splice(at, 1);
    else rows[at].blocked = true;
  });
}
/** 仅统一停止在撤销执行代次、核对消费者后按明确登记路径调用；查询不补偿。 */
export function settleProjectExecution(cwd: string, procs: string[]): void {
  const probe = gitResult(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]); if (probe.status !== 0) return;
  const file = join(probe.stdout.trim(), "loop-project-execution.json"), unlock = eventLock(`${file}.lock`);
  try {
    if (!existsSync(file)) return;
    const rows: Lease[] = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray(rows) || rows.some((r) => !r.token || !r.started || typeof r.procs !== "string")) throw new Error("项目执行租约损坏，未补偿释放");
    const kept = rows.filter((r) => !procs.includes(r.procs) || consumerProblem(r.procs) || consumerProblem(`${r.procs}.cleanup`));
    const temp = `${file}.${randomUUID()}.tmp`;
    try { writeFileSync(temp, JSON.stringify(kept), { mode: 0o600, flag: "wx" }); renameSync(temp, file); }
    finally { rmSync(temp, { force: true }); }
  } finally { unlock(); }
}
