/** 机器结论账本；Markdown 交付索引不是资格数据库。短锁 + 原子替换 + 尝试代次核对。 */
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { canonicalBatchFile, eventLock } from "./events.ts";
import { digest, type DevelopmentCard, type DevelopmentTask, type NodeName } from "./development-card.ts";
import type { AcceptanceRecord, Criteria, Grants } from "./acceptance-core.ts";
import { gitText } from "./workspace.ts";
import type { RunResource } from "./resources.ts";
import type { DeploymentConfig } from "./config.ts";
import type { FailureKind } from "./failure.ts";
import { processStartTime, type ProcEntry, type SessionGroup } from "./procs.ts";

export interface Candidate { commit: string; tree: string }
export interface NodeResult {
  id: string; task: string; node: NodeName; candidate: Candidate; inputs: string;
  started: string; ended?: string; status: "通过" | "不通过" | "没验证" | "中断";
  failure?: FailureKind; reason?: string; evidence: string[]; operations: string[]; released: boolean;
  acceptance?: AcceptanceRecord;
  interruption?: { trigger?: { kind: string; path?: string; event?: string; at: string; reason: string }; observations?: { kind: string; path?: string; event: string; at: string }[]; executorReason?: string;
    validity: { candidate: boolean | "未知"; inputs: boolean | "未知"; control: boolean }; protectionReason?: string };
}
export interface TestWorkspace { attempt: string; run: string; task?: string; candidate: Candidate; inputs: string; source: string; parent: string; path: string; identity: string; state: "creating" | "active" | "released" | "retained"; reason?: string }
export interface ConsumerRelease { attempt: string; captured: string; consumers: { file: string; entry: ProcEntry }[]; confirmed?: string; previousProblems?: string[] }
export interface DeploymentPlan { config: DeploymentConfig; cwd: string; common: string }
export interface DeploymentAttempt {
  id: string; inputs: string; publication: Candidate; config: DeploymentConfig; cwd: string; started: string; ended?: string;
  status: "waiting" | "deploying" | "checking" | "rolling-back" | "redeploying" | "succeeded" | "failed" | "rolled-back" | "blocked" | "cancelled";
  category?: "command" | "check" | "timeout" | "cancelled" | "release" | "identity" | "unknown"; reason?: string; released: boolean;
  log: string; procs: string; running?: string; retryOf?: string; binding?: { hash: string; files: Record<string, string>; paths: Record<string, string> };
  calls: { command: string; phase: string; commit: string; started: string; ended?: string; code?: number; killed?: boolean; released?: boolean; resource?: RunResource }[];
  rollback?: { from: string; to: string; state: "intent" | "applied" | "recovered" | "failed"; at: string; reason?: string };
}
export interface CardChange {
  id: string; source: string; authorization?: string; userVersion: number; at: string; expectedHash: string; content: string; card: DevelopmentCard;
  before: string; deploymentPlan?: DeploymentPlan; reviewInputs?: { hash: string; files: Record<string, string> }; removeTasks?: string[]; acceptanceVersion?: { path: string; hash: string }; installed?: boolean; state: "pending" | "prepared" | "applied" | "rejected"; appliedAt?: string; reason?: string;
}
export interface RepairEnvelope {
  id: string; token: string; session: string; host: string; attempt: string; candidate: Candidate; inputs: string; userVersion: number; epoch: number;
  message: string; hash: string; file: string; state: "pending" | "sent" | "read" | "unknown"; at: string; readAt?: string;
  taskId?: string; node?: NodeName; batchVersion?: number;
}
export interface InputSnapshot { files: Record<string, string>; paths: Record<string, string>; requirement: string }
export interface UserDecision { id: string; at: string; source: string; text: string; candidate: Candidate; inputs: string; userVersion: number; missing: string[]; mapping?: Contribution[] }
export interface KernelRun {
  v: 1; revision: number; id: string; repo: string; common: string; file: string; dir: string;
  card: DevelopmentCard; cardHash: string; base: string; targetAtStart: string; created: string;
  branch: string; worktree: string; workspaceCreated: boolean; workspaceParentCreated?: boolean; localFiles: string[]; localHashes: Record<string, string>;
  reviewComparison?: { base: Candidate; head: Candidate };
  reviewInputs?: { hash: string; files: Record<string, string> };
  reviewReport?: { report: string; json: string; attempt: string };
  deploymentPlan?: DeploymentPlan; deploymentAttempts?: DeploymentAttempt[];
  testWorkspaces?: TestWorkspace[];
  consumerReleases?: ConsumerRelease[];
  candidate?: Candidate; results: NodeResult[]; repairs: number; userVersion: number; userInputs: string[]; userFiles?: string[];
  /** 最近一次真实用户引用时确认的原始文本内容哈希；不凭磁盘的新内容自动更新。 */
  userFileVersions?: Record<string, string>;
  inputVersion?: 2; cardRevision?: number; epoch?: number;
  counters?: Partial<Record<NodeName, { repairs: number; recoveries: number }>>;
  blockedNode?: NodeName; changes?: CardChange[]; pendingCard?: string;
  controlDecisions?: { id: string; source: string; text: string; at: string; cardHash: string; userVersion: number; action: "remove-test" | "remove-acceptance" | "remove-task" | "raise-acceptance" | "change-acceptance"; acceptance?: { path: string; hash: string }; task?: string; used?: string }[];
  /** 只在内存上下文出现，不写第二份账本。新多任务的任务运行字段唯一存于 taskRecords。 */
  taskId?: string; taskRecords?: TaskRecord[];
  batch?: { version: number; targetSource?: Candidate; contributions: Contribution[]; integrations: BatchIntegration[]; pending?: { id: string; before: string; after: string; version: number; entry?: BatchIntegration; guard?: string; epoch?: number }; removed: { id: string; name: string; at: string; source: string; history?: string }[] };
  acceptanceState?: { criteria: Criteria; hash: string; owners: Record<string, string>; grants?: Grants; round: number;
    plan?: { ids: string[]; repairTasks: string[]; mapping: string; signature: string; basis?: string; pendingInputs?: string[]; waitFor?: { task: string; candidate: string }[] }; previous?: AcceptanceRecord;
    planRefreshes?: { at: string; from: string; to: string; tasks: string[]; ids: string[]; mapping: string }[];
    bindings?: Record<string, { tree: string; round: number; task?: string; candidate?: string; inputs: string; reason?: string }> };
  worker?: SessionGroup; workerRequest?: string;
  repair?: RepairEnvelope;
  delivery?: { candidate: Candidate; inputs: string; userVersion: number; at: string };
  /** 用户的开发会话前后台选择，独立于可撤销的一次性开窗请求。 */
  launchMode?: "terminal" | "background";
  terminal?: { request: string; at: string; script: string; owner?: { pid: number; started: string }; state: "requested" | "claimed" | "failed"; reason?: string };
  native?: { launch: string; command: string; childPid: number; childStarted: string; binding: string };
  abandonment?: { at: string; source: string; head?: string; history?: string };
  activity?: { id: string; node: NodeName; kind: "starting" | "developing" | "reviewing" | "submitting" | "waiting" | "testing" | "accepting" | "deploying"; pid: number; started: string; session?: string; procs?: string; ticket?: string; deadline?: number };
  session?: { host: "pi" | "claude" | "codex"; id: string; log?: string; pid: number; started: string; launchId?: string };
  launch?: SessionGroup; supervisor?: SessionGroup; stopReason?: string; stopped?: boolean; abandoned?: boolean;
  decisions: UserDecision[]; notes?: string[];
  integrations?: { at: string; from: Candidate; target: Candidate; candidate: Candidate; scopeBase: string; imported: string[]; evidence: string }[];
  publication?: { candidate: Candidate; inputs: string; targetBefore: string; commit: string; tree: string; history: string;
    inputSnapshot?: InputSnapshot; inputRoot?: string; remoteCommit?: string;
    /** 发布边界绑定的实际通过记录；没有 result 表示该节点作为用户例外欠项保留。 */
    nodeChecks?: Partial<Record<NodeName, { inputs: string; result?: string }>>;
    taskChecks?: { task: string; candidate: Candidate; checks: { node: NodeName; inputs: string; result?: string }[] }[]; mapping?: Contribution[];
    at: string; local: "intent" | "merged"; push: "未开始" | "进行中" | "成功" | "失败"; reason?: string; decision?: string; origin: string };
  release: { status: "未释放" | "已释放" | "未确认"; details: string[] };
}
/** 显式上下文投影：不是另一份 run；写回仍持同一个账本短锁。 */
export const TASK_FIELDS = ["dir", "branch", "worktree", "workspaceCreated", "workspaceParentCreated", "candidate", "repairs", "userVersion", "userInputs", "userFiles", "userFileVersions", "epoch", "counters", "consumerReleases", "blockedNode", "worker", "workerRequest", "repair", "delivery", "launchMode", "terminal", "native", "activity", "session", "launch", "supervisor", "stopReason", "stopped", "abandoned", "release", "integrations", "abandonment"] as const;
export type TaskRecord = Pick<KernelRun, typeof TASK_FIELDS[number]> & { id: string; name: string; definition?: DevelopmentTask; removed?: boolean };
export interface Contribution { task: string; candidate: Candidate; base: string; patchBase: string; contribution: string; inputs: Record<string, string>; checks: string[]; epoch: number; userVersion: number }
export interface BatchIntegration { id: string; task: string; at: string; before: Candidate; after: Candidate; mapping: Contribution[]; history: string; evidence: string; order: number; control?: string; targetSource?: Candidate }
export function taskDefinition(run: KernelRun): DevelopmentTask {
  const record = run.taskRecords?.find((r) => r.id === run.taskId);
  const task = run.taskId ? run.card.tasks.find((t) => t.name === record?.name) ?? record?.definition : run.card.tasks.length === 1 ? run.card.tasks[0] : undefined;
  if (!task) throw new Error("多任务节点必须显式指定任务身份 --task <任务名>");
  return task;
}
export function taskIdentity(run: KernelRun): string { return run.taskId ?? taskDefinition(run).name; }
export function taskIds(run: KernelRun): string[] { return run.taskRecords ? run.taskRecords.filter((t) => !t.removed).map((t) => t.id) : [taskDefinition(run).name]; }
export function taskView(run: KernelRun, id?: string): KernelRun {
  if (!run.taskRecords) { if (id && id !== taskDefinition(run).name) throw new Error(`未知任务：${id}`); return run; }
  if (!id) return run;
  const task = run.taskRecords.find((t) => t.id === id || t.name === id);
  if (!task) throw new Error(`未知任务：${id}`);
  const view = { ...run, taskId: task.id };
  for (const key of TASK_FIELDS) (view as any)[key] = task[key];
  view.stopped = run.stopped || task.stopped; view.abandoned = run.abandoned || task.abandoned || task.removed;
  return view;
}
export function readTaskRun(path: string, task?: string): KernelRun { return taskView(readRun(path), task); }
export function updateTaskRun<T>(path: string, task: string | undefined, change: (run: KernelRun) => T): T {
  return updateRun(path, (run) => {
    if (!run.taskRecords || !task) return change(run);
    const view = taskView(run, task), before = view.userVersion, value = change(view);
    const record = run.taskRecords.find((t) => t.id === view.taskId)!;
    for (const key of TASK_FIELDS) (record as any)[key] = view[key];
    for (const key of Object.keys(view)) if (key !== "taskId" && !(TASK_FIELDS as readonly string[]).includes(key)) (run as any)[key] = (view as any)[key];
    if (before !== view.userVersion) { run.userVersion++; run.epoch = (run.epoch ?? 0) + 1; }
    return value;
  });
}
export function activityAlive(activity: KernelRun["activity"]): boolean | undefined {
  if (!activity) return false;
  if (!Number.isSafeInteger(activity.pid) || activity.pid < 2 || !activity.started) return undefined;
  const started = processStartTime(activity.pid);
  if (started) return started === activity.started;
  try { process.kill(activity.pid, 0); return undefined; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? false : undefined; }
}
export const kernelRoot = (): string => resolve(process.env.AUTOREVIEW_KERNEL_ROOT || join(homedir(), ".pi-autoreview", "kernel"));
export function repositoryIdentity(repo: string): { common: string; key: string } {
  const common = realpathSync(gitText(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
  return { common, key: digest(common) };
}
export function ledgerPath(repo: string, file: string): string {
  return join(kernelRoot(), "runs", repositoryIdentity(repo).key, digest(canonicalBatchFile(file)), "ledger.json");
}
export function readRun(path: string): KernelRun {
  const run = JSON.parse(readFileSync(path, "utf8")) as KernelRun;
  if (run.v !== 1 || !run.id || !Number.isSafeInteger(run.revision) || resolve(path) !== join(run.dir, "ledger.json")) throw new Error(`内核账本身份损坏：${path}`);
  if (repositoryIdentity(run.repo).common !== run.common) throw new Error("仓库共用目录身份变化，保留账本与资源");
  return run;
}
export function atomicRun(path: string, run: KernelRun): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  try { writeFileSync(temp, `${JSON.stringify(run, null, 2)}\n`, { mode: 0o600, flag: "wx" }); renameSync(temp, path); }
  finally { rmSync(temp, { force: true }); }
}
export function updateRun<T>(path: string, change: (run: KernelRun) => T): T {
  const release = eventLock(`${path}.lock`);
  try { const run = readRun(path), value = change(run); run.revision += 1; atomicRun(path, run); return value; }
  finally { release(); }
}
/** 只接受同一尝试已登记消费者的后续实际释放回执，不改变当时的业务结论。 */
export function confirmedConsumerRelease(run: KernelRun, attempt: string): boolean {
  const receipts = [...(run.consumerReleases ?? []), ...(!run.taskId ? (run.taskRecords ?? []).flatMap((t) => t.consumerReleases ?? []) : [])];
  return receipts.some((r) => r.attempt === attempt && !!r.confirmed && r.consumers.length > 0);
}
/** 历史决定保留，但只有本候选、本输入、本用户版本的决定仍有授权效力。 */
export function findUserDecision(run: KernelRun, candidate: Candidate | undefined, inputs: string | undefined, missing: string[], id?: string): UserDecision | undefined {
  return [...run.decisions].reverse().find((d) => (!id || d.id === id) && d.userVersion === run.userVersion && typeof inputs === "string" && d.inputs === inputs
    && d.candidate.commit === candidate?.commit && d.candidate.tree === candidate.tree && JSON.stringify(d.missing) === JSON.stringify(missing)
    && (!d.mapping || JSON.stringify(d.mapping) === JSON.stringify(run.batch?.contributions)));
}
export function validResult(run: KernelRun, node: NodeName, candidate: Candidate, inputs: string): NodeResult | undefined {
  return [...run.results].reverse().find((r) => r.task === (node === "验收" || node === "提交" || node === "部署" ? run.taskRecords ? run.id : taskIdentity(run) : taskIdentity(run)) && r.node === node && r.candidate.tree === candidate.tree
    && r.inputs === inputs && r.status === "通过" && Boolean(r.ended) && r.released && r.evidence.length > 0 && r.evidence.every((p) => existsSync(p)));
}
/** 迟到结果仍留历史，但绝不清掉新执行身份或覆盖新候选。 */
export function finishAttempt(path: string, expected: { id: string; candidate: Candidate; inputs: string; userVersion: number; epoch?: number; task?: string }, result: NodeResult, current: { candidate: Candidate; inputs: string }): boolean {
  return updateTaskRun(path, expected.task, (run) => {
    const fresh = run.activity?.id === expected.id && !run.stopped && !run.abandoned && run.userVersion === expected.userVersion
      && (run.epoch ?? 0) === (expected.epoch ?? 0) && run.candidate?.tree === expected.candidate.tree && current.candidate.tree === expected.candidate.tree && current.inputs === expected.inputs;
    const protectionReason = fresh ? undefined : "候选、输入、停止状态或尝试代次变化；迟到结果不可放行";
    if (result.interruption) { result.interruption.validity.control = !run.stopped && !run.abandoned && run.userVersion === expected.userVersion && (run.epoch ?? 0) === (expected.epoch ?? 0); result.interruption.protectionReason = protectionReason; }
    const reason = [result.reason, protectionReason].filter(Boolean).join("；");
    run.results.push(fresh ? result : { ...result, status: "中断", reason });
    if (!result.released && !confirmedConsumerRelease(run, result.id)) run.release = { status: "未确认", details: [...new Set([...run.release.details, result.reason ?? "节点消费者释放未知，旧结果无效不等于资源已释放"])] };
    if (run.activity?.id === expected.id) {
      run.activity = undefined;
      if (!fresh) { run.stopped = true; run.stopReason = reason; }
    }
    return fresh;
  });
}
