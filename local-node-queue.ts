/** 全用户本机 FIFO；短锁不跨等待/执行，死亡所有者先核对登记消费者，绝不按年龄抢槽。 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { eventLock } from "./events.ts";
import { processStartTime, reapProcs } from "./procs.ts";
import { releaseRunResource, type RunResource } from "./resources.ts";

export interface LocalTicket {
  id: string; token: string; ledger: string; run: string; common: string; task: string; node: "测试" | "验收";
  tree: string; inputs: string; epoch: number; pid: number; started: string; procs: string;
  seq: number; at: string; state: "waiting" | "active" | "checking" | "blocked"; reason?: string; checker?: { pid: number; started: string; token: string };
  resource?: RunResource;
}
interface Queue { v: 1; next: number; items: LocalTicket[] }
export const localQueueRoot = (): string => resolve(process.env.AUTOREVIEW_LOCAL_QUEUE_ROOT || join(homedir(), ".pi-autoreview", "local-node-queue"));
const path = (): string => join(localQueueRoot(), "queue.json");
export function readLocalQueue(): Queue {
  if (!existsSync(path())) return { v: 1, next: 1, items: [] };
  const q = JSON.parse(readFileSync(path(), "utf8")) as Queue;
  if (q.v !== 1 || !Number.isSafeInteger(q.next) || q.next < 1 || !Array.isArray(q.items) || q.items.some((t) =>
    [t.id, t.token, t.ledger, t.run, t.common, t.task, t.tree, t.inputs, t.started, t.procs].some((v) => typeof v !== "string" || !v)
    || !Number.isSafeInteger(t.pid) || t.pid < 2 || !Number.isSafeInteger(t.seq) || t.seq < 1 || !Number.isSafeInteger(t.epoch) || t.epoch < 0
    || !["测试", "验收"].includes(t.node) || !["waiting", "active", "checking", "blocked"].includes(t.state)
    || t.checker && (!Number.isSafeInteger(t.checker.pid) || t.checker.pid < 2 || !t.checker.started || !t.checker.token))) throw new Error("本机队列身份损坏，保留队列，未派工");
  return q;
}
function change<T>(action: (q: Queue) => T): T {
  const unlock = eventLock(join(localQueueRoot(), "queue.lock"));
  try {
    const q = readLocalQueue(), value = action(q), temp = `${path()}.${randomUUID()}.tmp`;
    try { writeFileSync(temp, JSON.stringify(q, null, 2), { mode: 0o600, flag: "wx" }); renameSync(temp, path()); }
    finally { rmSync(temp, { force: true }); }
    return value;
  } finally { unlock(); }
}
function alive(owner: { pid: number; started: string }): boolean | undefined {
  const start = processStartTime(owner.pid);
  if (start) return start === owner.started;
  try { process.kill(owner.pid, 0); return undefined; }
  catch (e) { return (e as NodeJS.ErrnoException).code === "ESRCH" ? false : undefined; }
}
/** 原始 JSON 损坏不能由 readProcs 的空数组容错洗成已释放。 */
export function consumerProblem(file: string): string | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const rows = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray(rows) || rows.some((r) => !Number.isSafeInteger(r.pgid) || r.pgid < 2 || !r.started || !r.token || !Number.isSafeInteger(r.ownerPid))) return `未知归属进程登记：${file}`;
    if (rows.length) return `消费者释放未确认：${file}`;
  } catch { return `进程登记损坏：${file}`; }
  return undefined;
}
/** 仅有副作用的派工/停止入口调用，查询绝不调用。 */
export function recoverLocalQueue(): void {
  for (const item of readLocalQueue().items) {
    if (alive(item) !== false) continue;
    const checkToken = randomUUID();
    const claimed = change((q) => {
      const t = q.items.find((v) => v.id === item.id && v.token === item.token);
      if (!t || t.checker && alive(t.checker) !== false) return false;
      t.state = "checking"; t.checker = { pid: process.pid, started: processStartTime(process.pid), token: checkToken }; return true;
    });
    if (!claimed) continue;
    let problem: string | undefined;
    for (const file of [item.procs, `${item.procs}.cleanup`]) {
      const raw = consumerProblem(file);
      if (raw?.includes("损坏") || raw?.includes("未知归属")) { problem = raw; break; }
      reapProcs(file, { ownerPid: item.pid }); problem ??= consumerProblem(file);
    }
    if (!problem && item.resource) {
      const resource = releaseRunResource(item.resource);
      if (resource.status !== "released") problem = resource.detail ?? "临时资源释放未确认";
    }
    change((q) => {
      const t = q.items.find((v) => v.id === item.id && v.token === item.token && v.checker?.token === checkToken);
      if (!t) return;
      if (problem) { t.state = "blocked"; t.reason = problem; t.checker = undefined; }
      else q.items = q.items.filter((v) => v !== t);
    });
  }
}
export function releaseLocalSlot(id: string, token: string, released: boolean, reason?: string): void {
  const saved = readLocalQueue().items.find((t) => t.id === id && t.token === token);
  let resourceProblem: string | undefined;
  if (released && saved?.resource && !consumerProblem(saved.procs) && !consumerProblem(`${saved.procs}.cleanup`)) {
    const resource = releaseRunResource(saved.resource);
    if (resource.status !== "released") resourceProblem = resource.detail ?? "临时资源释放未确认";
  }
  change((q) => {
    const ticket = q.items.find((t) => t.id === id && t.token === token);
    if (!ticket) return;
    const problem = consumerProblem(ticket.procs) ?? consumerProblem(`${ticket.procs}.cleanup`) ?? resourceProblem;
    if (released && !problem) q.items = q.items.filter((t) => t !== ticket);
    else { ticket.state = "blocked"; ticket.reason = problem ?? reason ?? "资源释放未确认"; }
  });
}
export function bindLocalResource(id: string, token: string, resource: RunResource): void {
  change((q) => { const t = q.items.find((t) => t.id === id && t.token === token); if (!t || t.state !== "active") throw new Error("本机执行槽身份变化"); t.resource = resource; });
}
export async function acquireLocalSlot(request: Omit<LocalTicket, "seq" | "at" | "state">, signal: AbortSignal, live: () => void): Promise<LocalTicket> {
  mkdirSync(localQueueRoot(), { recursive: true, mode: 0o700 });
  live(); signal.throwIfAborted(); recoverLocalQueue();
  change((q) => {
    if (q.items.some((t) => t.id === request.id)) throw new Error("本机请求已登记，不重复排队");
    q.items.push({ ...request, seq: q.next++, at: new Date().toISOString(), state: "waiting" });
  });
  try {
    for (;;) {
      signal.throwIfAborted(); live(); recoverLocalQueue();
      const granted = change((q) => {
        const mine = q.items.find((t) => t.id === request.id && t.token === request.token);
        if (!mine) throw new Error("本机排队已被取消");
        if (mine.state === "blocked") throw new Error(mine.reason ?? "槽释放未确认");
        if (!q.items.some((t) => t !== mine && t.state !== "waiting") && q.items.filter((t) => t.state === "waiting").sort((a, b) => a.seq - b.seq)[0] === mine) {
          mine.state = "active"; return structuredClone(mine);
        }
        return undefined;
      });
      if (granted) { live(); return granted; }
      await sleep(100, undefined, { signal });
    }
  } catch (e) { releaseLocalSlot(request.id, request.token, true); throw e; }
}
export function localTicketView(id: string): { position: number; ticket?: LocalTicket } {
  const items = readLocalQueue().items, ticket = items.find((t) => t.id === id);
  return { ticket, position: ticket ? items.filter((t) => t.seq <= ticket.seq).length : 0 };
}
