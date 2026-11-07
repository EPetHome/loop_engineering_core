/** 机器结论账本；Markdown 交付索引不是资格数据库。短锁 + 原子替换 + 尝试代次核对。 */
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { canonicalBatchFile, eventLock } from "./events.ts";
import { digest, type DevelopmentCard, type NodeName } from "./development-card.ts";
import { gitText } from "./workspace.ts";
import type { FailureKind } from "./failure.ts";
import { processStartTime, type SessionGroup } from "./procs.ts";

export interface Candidate { commit: string; tree: string }
export interface NodeResult {
  id: string; task: string; node: NodeName; candidate: Candidate; inputs: string;
  started: string; ended?: string; status: "通过" | "不通过" | "没验证" | "中断";
  failure?: FailureKind; reason?: string; evidence: string[]; operations: string[]; released: boolean;
}
export interface CardChange {
  id: string; source: string; authorization?: string; userVersion: number; at: string; expectedHash: string; content: string; card: DevelopmentCard;
  before: string; state: "pending" | "prepared" | "applied" | "rejected"; appliedAt?: string; reason?: string;
}
export interface RepairEnvelope {
  id: string; token: string; session: string; host: string; attempt: string; candidate: Candidate; inputs: string; userVersion: number; epoch: number;
  message: string; hash: string; file: string; state: "pending" | "sent" | "read" | "unknown"; at: string; readAt?: string;
}
export interface InputSnapshot { files: Record<string, string>; paths: Record<string, string>; requirement: string }
export interface UserDecision { id: string; at: string; source: string; text: string; candidate: Candidate; inputs: string; userVersion: number; missing: string[] }
export interface KernelRun {
  v: 1; revision: number; id: string; repo: string; common: string; file: string; dir: string;
  card: DevelopmentCard; cardHash: string; base: string; targetAtStart: string; created: string;
  branch: string; worktree: string; workspaceCreated: boolean; workspaceParentCreated?: boolean; localFiles: string[]; localHashes: Record<string, string>;
  candidate?: Candidate; results: NodeResult[]; repairs: number; userVersion: number; userInputs: string[]; userFiles?: string[];
  /** 最近一次真实用户引用时确认的原始文本内容哈希；不凭磁盘的新内容自动更新。 */
  userFileVersions?: Record<string, string>;
  inputVersion?: 2; cardRevision?: number; epoch?: number;
  counters?: Partial<Record<NodeName, { repairs: number; recoveries: number }>>;
  blockedNode?: NodeName; changes?: CardChange[]; pendingCard?: string;
  controlDecisions?: { id: string; source: string; text: string; at: string; cardHash: string; userVersion: number; action: "remove-test"; used?: string }[];
  worker?: SessionGroup; workerRequest?: string;
  repair?: RepairEnvelope;
  native?: { launch: string; command: string; childPid: number; childStarted: string; binding: string };
  abandonment?: { at: string; source: string; head?: string; history?: string };
  activity?: { id: string; node: NodeName; kind: "starting" | "developing" | "reviewing" | "submitting" | "waiting" | "testing"; pid: number; started: string; session?: string; procs?: string; ticket?: string; deadline?: number };
  session?: { host: "pi" | "claude" | "codex"; id: string; log?: string; pid: number; started: string; launchId?: string };
  launch?: SessionGroup; supervisor?: SessionGroup; stopReason?: string; stopped?: boolean; abandoned?: boolean;
  decisions: UserDecision[]; notes?: string[];
  integrations?: { at: string; from: Candidate; target: Candidate; candidate: Candidate; scopeBase: string; imported: string[]; evidence: string }[];
  publication?: { candidate: Candidate; inputs: string; targetBefore: string; commit: string; tree: string; history: string;
    inputSnapshot?: InputSnapshot; inputRoot?: string;
    /** 发布边界绑定的实际通过记录；没有 result 表示该节点作为用户例外欠项保留。 */
    nodeChecks?: Partial<Record<NodeName, { inputs: string; result?: string }>>;
    at: string; local: "intent" | "merged"; push: "未开始" | "进行中" | "成功" | "失败"; reason?: string; decision?: string; origin: string };
  release: { status: "未释放" | "已释放" | "未确认"; details: string[] };
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
/** 历史决定保留，但只有本候选、本输入、本用户版本的决定仍有授权效力。 */
export function findUserDecision(run: KernelRun, candidate: Candidate | undefined, inputs: string | undefined, missing: string[], id?: string): UserDecision | undefined {
  return [...run.decisions].reverse().find((d) => (!id || d.id === id) && d.userVersion === run.userVersion && typeof inputs === "string" && d.inputs === inputs
    && d.candidate.commit === candidate?.commit && d.candidate.tree === candidate.tree && JSON.stringify(d.missing) === JSON.stringify(missing));
}
export function validResult(run: KernelRun, node: NodeName, candidate: Candidate, inputs: string): NodeResult | undefined {
  return [...run.results].reverse().find((r) => r.task === run.card.tasks[0].name && r.node === node && r.candidate.tree === candidate.tree
    && r.inputs === inputs && r.status === "通过" && Boolean(r.ended) && r.released && r.evidence.length > 0 && r.evidence.every((p) => existsSync(p)));
}
/** 迟到结果仍留历史，但绝不清掉新执行身份或覆盖新候选。 */
export function finishAttempt(path: string, expected: { id: string; candidate: Candidate; inputs: string; userVersion: number; epoch?: number }, result: NodeResult, current: { candidate: Candidate; inputs: string }): boolean {
  return updateRun(path, (run) => {
    const fresh = run.activity?.id === expected.id && !run.stopped && !run.abandoned && run.userVersion === expected.userVersion
      && (run.epoch ?? 0) === (expected.epoch ?? 0) && run.candidate?.tree === expected.candidate.tree && current.candidate.tree === expected.candidate.tree && current.inputs === expected.inputs;
    run.results.push(fresh ? result : { ...result, status: "中断", reason: "候选、输入、停止状态或尝试代次变化；迟到结果不可放行" });
    if (run.activity?.id === expected.id) { run.activity = undefined; if (!fresh) run.stopReason = "检查期间候选或输入变化，旧结果无效"; }
    return fresh;
  });
}
