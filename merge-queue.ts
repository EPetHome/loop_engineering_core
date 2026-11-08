/** 旧队列只读历史与显式安全停止。没有登记、检查、返修、恢复、发布或部署调度器。 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalBatchFile, eventLock } from "./events.ts";
import { readJson, writeJsonAtomic, type QueueAcceptance } from "./pipeline-core.ts";
import { processStartTime, readProcs, type ProcEntry, type SessionGroup } from "./procs.ts";
import { gitResult, gitText } from "./workspace.ts";
import type { DeploymentConfig, ProjectConfigOverrides } from "./config.ts";
import type { BatchCommit } from "./commit-batch.ts";
import type { StageScope } from "./scope.ts";
import type { IssueWriteback } from "./issue-writeback.ts";

export interface QueueStage { name: string; cwd: string; branch: string; start: string; prompt?: string; scope?: StageScope; configOverrides?: ProjectConfigOverrides }
interface LockOwner { pid: number; started: string; token: string }
export interface QueueBatch {
  id: string; name: string; file: string; dir: string; project: string; release: string; stopped?: boolean;
  stages: QueueStage[]; steps: string[][]; commits?: BatchCommit[]; issues?: IssueWriteback[];
  acceptance?: boolean; e2e?: boolean; integrationEpoch?: string; integrationCheck?: { owner: LockOwner; procs: string };
}
export interface QueueDeployment {
  status: "disabled" | "waiting" | "deploying" | "checking" | "rolling-back" | "redeploying" | "succeeded" | "rolled-back" | "blocked" | "failed" | "stopped";
  config: DeploymentConfig; log?: string; reason?: string; procs?: string; stopRequested?: boolean;
}
export interface QueueEntry {
  id: string; batch: string; name: string; order: number; status: "pending" | "checking" | "ready" | "returning" | "returned" | "blocked" | "merging" | "merged" | "stopped" | "withdrawing" | "withdrawn";
  createdAt: string; updatedAt: string; attempt: number; reason?: string; result?: string; tree?: string; base?: string;
  qualification: { stage: string; session: string; epoch: string; inbox: number; acceptance?: QueueAcceptance }[];
  sources: { branch: string; cwd: string; head: string; tree: string; commit: string }[];
  returnCount?: number; deployment?: QueueDeployment;
}
export interface MergeQueue { version: 1; repo: string; common: string; dir: string; workspace: string; nextOrder: number; batches: QueueBatch[]; entries: QueueEntry[] }
export interface DeploymentStop { entry: string; inFlight: boolean; executors: SessionGroup[]; unknown: boolean }
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const commonDir = (repo: string): string => realpathSync(gitText(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
export function queueDir(repo: string): string {
  return join(canonicalBatchFile(process.env.AUTOREVIEW_MERGE_QUEUE_ROOT || join(homedir(), ".pi-autoreview", "merge-queues")), hash(commonDir(repo)));
}
function load(dir: string): MergeQueue {
  const path = join(dir, "queue.json");
  let state: MergeQueue;
  try { state = JSON.parse(readFileSync(path, "utf8")); } catch (error) { throw new Error(`无法读取合入队列记录 ${path}：${String(error)}`); }
  if (state.version !== 1 || state.dir !== dir || state.workspace !== join(dir, "worktree") || !Array.isArray(state.batches) || !Array.isArray(state.entries)) throw new Error(`合入队列记录不可用：${path}`);
  if (commonDir(state.repo) !== state.common) throw new Error("旧队列仓库身份已变化，保留记录，未继续");
  // 原状态/字段完整保留，尤其不将历史 blocked/testing 变为 pending 或伪造新账本。
  return state;
}
export function readMergeQueue(repo: string): MergeQueue | undefined {
  const dir = queueDir(repo);
  return existsSync(join(dir, "queue.json")) ? load(dir) : undefined;
}
export function registeredQueueBatch(repo: string, file: string): QueueBatch | undefined {
  if (gitResult(repo, ["rev-parse", "--git-common-dir"]).status !== 0) return undefined;
  const state = readMergeQueue(repo);
  const exact = state?.batches.find((b) => canonicalBatchFile(b.file) === canonicalBatchFile(file));
  if (exact) return exact;
  // 仅作为停止候选；stop.ts 还须证明同仓库、同一相对路径与完整批次登记身份。
  const raw = readJson<{ name?: string; branch?: string; stages?: Record<string, { branch?: string }> }>(file);
  return raw && state?.batches.find((b) => b.name === raw.name && b.stages.every((s) => s.branch === (raw.stages?.[s.name]?.branch ?? raw.branch)));
}
function deadOwner(owner: LockOwner): boolean {
  const started = processStartTime(owner.pid);
  if (started) return started !== owner.started;
  try { process.kill(owner.pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}
/** 仅撤销旧资格并冻结确切消费者，实际停止/释放由 stop.ts 按身份核对。 */
export function stopQueueBatch(repo: string, batch: QueueBatch, dryRun = false): { entries: string[]; procs: string[]; consumers: { path: string; proc: ProcEntry }[]; deployments: DeploymentStop[] } {
  const initial = readMergeQueue(repo);
  if (!initial) throw new Error("旧队列登记不存在，未确认停止");
  const apply = (state: MergeQueue) => {
    const target = state.batches.find((b) => b.id === batch.id && canonicalBatchFile(b.file) === canonicalBatchFile(batch.file));
    if (!target) throw new Error("旧队列批次归属变化，未停止");
    const entries = state.entries.filter((e) => e.batch === target.id && !["merged", "withdrawn"].includes(e.status));
    const deploying = state.entries.filter((e) => e.batch === target.id && e.deployment && !["disabled", "succeeded", "rolled-back", "failed"].includes(e.deployment.status));
    if (entries.some((e) => e.status === "merging" || e.status === "withdrawing" && !deploying.includes(e))) throw new Error("旧发布/撤回事务尚未收尾，保留事实；旧引擎已停用，请人工核对候选、目标及资源，不会自动恢复发布");
    const procs = entries.some((e) => ["checking", "testing"].includes(e.status)) ? [join(state.dir, "gate.procs.json")] : [];
    const consumers = procs.flatMap((path) => readProcs(path).map((proc) => ({ path, proc })));
    const deployments = deploying.map((entry): DeploymentStop => {
      const executors: SessionGroup[] = []; let unknown = false;
      for (const file of readdirSync(state.dir).filter((name) => /^executor-[0-9a-f-]+\.json$/.test(name))) {
        const owner = readJson<LockOwner & { mode: string; target?: string }>(join(state.dir, file));
        if (owner?.mode !== "deploy" || owner.target !== entry.id) continue;
        if (!owner.started || !owner.token || owner.pid < 2) { unknown = true; continue; }
        if (!deadOwner(owner)) executors.push({ pid: owner.pid, processStarted: owner.started, token: owner.token });
      }
      const runtime = realpathSync(gitText(target.project, ["rev-parse", "--show-toplevel"]));
      const shared = join(state.dir, `deploy-${hash(relative(runtime, target.project))}.procs.json`);
      const specific = join(state.dir, `deploy-${entry.id}.procs.json`), path = entry.deployment!.procs ?? shared;
      if (path !== shared && path !== specific) unknown = true;
      else {
        procs.push(path);
        consumers.push(...readProcs(path).filter((proc) => path === specific || executors.some((owner) => owner.pid === proc.ownerPid)).map((proc) => ({ path, proc })));
      }
      return { entry: entry.id, inFlight: !["waiting", "stopped"].includes(entry.deployment!.status), executors, unknown };
    });
    if (!dryRun) {
      target.stopped = true;
      for (const entry of entries) if (entry.status !== "withdrawing") Object.assign(entry, { status: "stopped", reason: "已停止；旧队列仅供历史读取", updatedAt: new Date().toISOString() });
      for (const entry of deploying) {
        const pending = ["waiting", "stopped"].includes(entry.deployment!.status);
        entry.deployment = { ...entry.deployment!, stopRequested: true, status: pending ? "stopped" : "blocked", reason: pending ? "待执行部署已取消" : "后续部署、检查与回退已取消；已启动动作的结果未确认，保留现场" };
      }
    }
    return { entries: entries.map((e) => e.id), procs, consumers, deployments };
  };
  if (dryRun) return apply(initial);
  const publish = eventLock(join(initial.dir, "publish.lock"));
  try {
    const record = eventLock(join(initial.dir, "record.lock"));
    try { const state = load(initial.dir), result = apply(state); writeJsonAtomic(join(state.dir, "queue.json"), state); return result; }
    finally { record(); }
  } finally { publish(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.error("旧合入队列执行器、重检/免审、批次分支推送与独立部署已停用；请使用 bin/loop 合入 <version:1 开发卡.json>（可加 --仅本地），部署按卡执行；历史只读查询或按登记停止，不恢复旧事务");
  process.exitCode = 2;
}
