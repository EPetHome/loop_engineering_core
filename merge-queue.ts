/** 本机合入队列。只有 loop 开工登记的 git 批次参与；执行器不依赖开发宿主。 */
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, closeSync, cpSync, existsSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { loadGateConfig, loadProjectLayout } from "./config.ts";
import { commitBatch, workingTree, type BatchCommit } from "./commit-batch.ts";
import { batchInfo, eventReason, phasePath, pushEvent, recordBatchInfo, reportUncommittedBatch, writePhase, type BatchInfo, type PhaseRecord } from "./events.ts";
import { systemNotify } from "./notify.ts";
import { hookInputBridgeAvailable } from "./hosts/inbox-bridge.ts";
import { inboxPath, queueAcceptance, readJson, statusPath, writeJsonAtomic, writeStageStatus, type InboxMessage, type StageStatus, type QueueAcceptance, type QueueAcceptanceItem } from "./pipeline-core.ts";
import { processStartTime, readProcs, reapProcs } from "./procs.ts";
import { createRunResource, managedShell, releaseRunResource } from "./resources.ts";
import { inScope, type StageScope } from "./scope.ts";
import { loadContext } from "./project-context.ts";
import { gitResult, gitText, shellQuote, worktrees } from "./workspace.ts";
import { appendBatchCommitRecord, appendMergeRecord } from "./ledger.ts";
import type { AcceptanceRecord } from "./acceptance-core.ts";
import type { Snapshot } from "./git.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const stamp = (): string => new Date().toISOString();
const within = (parent: string, path: string): boolean => { const rel = relative(parent, path); return !rel || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`)); };
const overlaps = (a: string, b: string): boolean => within(a, b) || within(b, a);

export interface QueueStage {
  name: string; cwd: string; branch: string; start: string; prompt?: string; scope?: StageScope;
}
export interface QueueBatch {
  id: string; name: string; file: string; dir: string; project: string; release: string;
  stages: QueueStage[]; steps: string[][];
  /** 最近核对的整批验收开关；实际完成资格仍须绑定本轮配置，文件缺失不能当成未配置。 */
  acceptance?: boolean;
  /** 兼容旧队列记录/登记参数；读取时归一化为 acceptance，新记录不再写它。 */
  e2e?: boolean;
  /** 最近一次整批验收的身份；开验即更新，不能在新一轮期间沿用旧完成资格。 */
  integrationEpoch?: string;
  commits?: BatchCommit[];
  commitSignature?: string;
  commitLedger?: string;
  /** 最近一次流水线实际处理的段资格；失败/部分验证也记下，不能在状态查询中无限重验。 */
  lastRunQualification?: string;
}
export interface QueuePipelineRun {
  dir: string; batch: string; token: string; acceptance: boolean; configuration: string;
  qualification?: string; release: () => void;
}
interface Source { branch: string; cwd: string; head: string; tree: string; commit: string }
interface Qualification { stage: string; session: string; epoch: string; inbox: number; sourceInputs?: string; acceptance?: QueueAcceptance }
interface Delivery { stage: string; seq: number; message: string; mustFix: string; sent?: boolean; resumed?: boolean }
export interface QueueEntry {
  id: string; batch: string; name: string; order: number; status: "pending" | "testing" | "ready" | "returning" | "returned" | "blocked" | "merging" | "merged" | "stopped" | "withdrawing" | "withdrawn";
  createdAt: string; updatedAt: string; qualification: Qualification[]; sources: Source[];
  base?: string; result?: string; tree?: string; attempt: number; log?: string; output?: string; reason?: string; gate?: { cmd: string; timeoutMin: number };
  conflicts?: string[]; deliveries?: Delivery[]; notified?: boolean; runtimeGate?: string; runtimeStash?: { ref: string; hash: string };
  /** prepared 确认尚未发布；publishing 表示 CAS 结果未确认；published 保留已发布的收尾责任。 */
  runtimePublication?: "prepared" | "publishing" | "published";
  integration?: QueueAcceptance; integrationEpoch?: string; returnCount?: number; autoStopped?: boolean; conflictKind?: "text" | "integration";
  automatic?: boolean; pushRequested?: boolean; mergeNotified?: boolean; ledger?: string; ledgerError?: string;
  push?: { status: "started" | "succeeded" | "failed"; reason?: string };
}
export interface MergeQueue {
  version: 1; repo: string; common: string; dir: string; workspace: string; nextOrder: number;
  batches: QueueBatch[]; entries: QueueEntry[];
}
interface LockOwner { pid: number; started: string; token: string }
function deadOwner(owner: LockOwner): boolean {
  const started = processStartTime(owner.pid);
  if (started) return started !== owner.started;
  try { process.kill(owner.pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}

function canonical(path: string): string {
  const absolute = resolve(path);
  let parent = absolute;
  while (!existsSync(parent) && dirname(parent) !== parent) parent = dirname(parent);
  return resolve(realpathSync(parent), relative(parent, absolute));
}
function commonDir(repo: string): string { return realpathSync(gitText(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"])); }
export function queueDir(repo: string): string {
  return join(canonical(process.env.AUTOREVIEW_MERGE_QUEUE_ROOT || join(homedir(), ".pi-autoreview", "merge-queues")), hash(commonDir(repo)));
}
const statePath = (dir: string): string => join(dir, "queue.json");
function load(dir: string): MergeQueue {
  // 非空但损坏的记录不能当作空队列覆盖。
  let state: MergeQueue;
  try { state = JSON.parse(readFileSync(statePath(dir), "utf8")) as MergeQueue; }
  catch (error) { throw new Error(`无法读取合入队列记录 ${statePath(dir)}：${String(error)}`); }
  if (state.version !== 1 || state.dir !== dir || state.workspace !== join(dir, "worktree") || !Array.isArray(state.entries) || !Array.isArray(state.batches)) throw new Error(`合入队列记录不可用：${statePath(dir)}`);
  if (commonDir(state.repo) !== state.common) throw new Error("合入队列仓库身份已变化，保留记录，未继续");
  for (const batch of state.batches) {
    batch.acceptance ??= batch.e2e; // 兼容旧队列开关，integration / integrationEpoch 保持原样。
    delete batch.e2e;
  }
  return state;
}
export function readMergeQueue(repo: string): MergeQueue | undefined {
  const dir = queueDir(repo);
  return existsSync(statePath(dir)) ? load(dir) : undefined;
}

/** 硬链接原子发布完整身份，避免创建锁与写身份之间被杀留下空锁；不按 PID 猜测归属。 */
function lock(dir: string, name: string, wait = false): (() => void) | undefined {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${name}.lock`), token = randomUUID();
  const mine: LockOwner = { pid: process.pid, started: processStartTime(process.pid), token };
  if (!mine.started) throw new Error("无法核对队列执行器进程身份");
  const temp = join(dir, `lock-${token}.tmp`);
  writeFileSync(temp, JSON.stringify(mine), { flag: "wx", mode: 0o600 });
  const deadline = Date.now() + (wait ? 15_000 : 0);
  try {
    for (;;) {
      try {
        linkSync(temp, path);
        return () => { const owner = readJson<LockOwner>(path); if (owner?.token === token) rmSync(path); };
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      const old = readJson<LockOwner>(path);
      if (!old?.started || !old.token || !Number.isInteger(old.pid) || old.pid < 2) throw new Error(`队列锁身份不明，未删除：${path}`);
      if (deadOwner(old)) {
        // 竞争回收者也须串行；拿到回收锁后重读，不能删掉另一执行器刚获得的锁。
        const reclaim = `${path}.reclaim`;
        try {
          linkSync(temp, reclaim);
          try { if (readJson<LockOwner>(path)?.token === old.token) rmSync(path); }
          finally { rmSync(reclaim); }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          const owner = readJson<LockOwner>(reclaim);
          if (owner && deadOwner(owner) && readJson<LockOwner>(reclaim)?.token === owner.token) rmSync(reclaim);
        }
        if (Date.now() <= deadline + 1000) continue;
      }
      if (Date.now() >= deadline) return undefined;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  } finally { rmSync(temp, { force: true }); }
}
/** 顺序固定为 publish → record；撤销/换代与最终发布串行，持有到 Git CAS 和运行版收尾结束。 */
function publication<T>(dir: string, fn: () => T): T {
  const release = lock(dir, "publish", true);
  if (!release) throw new Error("合入发布或资格更新正在执行，请稍后重试");
  try { return fn(); } finally { release(); }
}
function change<T>(dir: string, fn: (state: MergeQueue) => T): T {
  const release = lock(dir, "record", true);
  if (!release) throw new Error("合入队列记录正在写入，请稍后重试");
  try { const state = load(dir), result = fn(state); writeJsonAtomic(statePath(dir), state); return result; }
  finally { release(); }
}
function update(dir: string, id: string, patch: Partial<QueueEntry>): QueueEntry {
  const entry = change(dir, (state) => {
    const entry = state.entries.find((item) => item.id === id);
    if (!entry) throw new Error("队列条目已不存在");
    Object.assign(entry, patch, { updatedAt: stamp() }); return entry;
  });
  try { if (patch.status !== undefined) reportQueue(load(dir), entry); } catch (error) { process.stderr.write(`[Loop PA] 队列事件未发送：${String(error)}\n`); }
  return entry;
}
function batchEventInfo(batch: QueueBatch): BatchInfo {
  let info: BatchInfo;
  try { info = batchInfo(batch.file, batch.project, batch.dir); }
  catch { info = { project: batch.project, batch: { file: batch.file, name: batch.name, recipe: "develop" }, dir: batch.dir, stages: [] }; }
  return { ...info, project: batch.project,
    stages: batch.stages.map((stage) => ({ stage: stage.name, cwd: stage.cwd, branch: stage.branch, ...(stage.prompt ? { prompt: stage.prompt } : {}) })) };
}
function reportQueue(state: MergeQueue, entry: QueueEntry): void {
  try {
    const batch = state.batches.find((item) => item.id === entry.batch);
    if (!batch) return;
    const active = state.entries.filter((item) => ["pending", "testing", "ready", "returning", "merging", "withdrawing"].includes(item.status)).sort((a, b) => a.order - b.order);
    pushEvent(batchEventInfo(batch), null, "queue", eventReason(entry.reason), { queue: statePath(state.dir), ...(entry.log ? { log: entry.log } : {}) },
      { queueStatus: entry.status, position: active.findIndex((item) => item.id === entry.id) + 1 || null, returnCount: entry.returnCount ?? 0, reason: entry.reason ?? null, log: entry.log ?? null });
  } catch (error) { process.stderr.write(`[Loop PA] 队列事件未发送：${String(error)}\n`); }
}

export function registerQueueBatch(repo: string, value: Omit<QueueBatch, "id">): void {
  repo = realpathSync(repo);
  const dir = queueDir(repo), common = commonDir(repo);
  // 队列目录及固定工作区不得位于任何用户 worktree 里，也不得包住它们。
  const parent = dirname(dir), previous = existsSync(statePath(dir)) ? load(dir) : undefined;
  for (const item of worktrees(repo)) {
    if (!overlaps(dir, realpathSync(item.path))) continue;
    if (previous && resolve(item.path) === previous.workspace) { checkOwnedWorkspace(previous); continue; }
    throw new Error(`合入队列必须位于运行版和开发空间以外：${dir}`);
  }
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (realpathSync(parent) !== parent) throw new Error("合入队列根目录不能经过符号链接");
  const release = lock(dir, "record", true);
  if (!release) throw new Error("合入队列记录忙");
  try {
    const state: MergeQueue = existsSync(statePath(dir)) ? load(dir)
      : { version: 1, repo, common, dir, workspace: join(dir, "worktree"), nextOrder: 1, batches: [], entries: [] };
    const raw = readJson<{ acceptance?: unknown; e2e?: unknown }>(value.file); // 兼容旧批次字段。
    const batch: QueueBatch = { ...value, acceptance: value.acceptance ?? value.e2e ?? Boolean(raw?.acceptance ?? raw?.e2e), file: canonical(value.file), dir: canonical(value.dir), project: canonical(value.project),
      stages: value.stages.map((stage) => ({ ...stage, cwd: canonical(stage.cwd) })),
      id: hash([value.name, value.stages.map((stage) => [stage.name, stage.branch])]) };
    delete batch.e2e; // 旧登记参数只读，不写回。
    for (const stage of batch.stages) {
      const top = realpathSync(gitText(stage.cwd, ["rev-parse", "--show-toplevel"]));
      if (top === repo || commonDir(top) !== common || overlaps(top, dir)) throw new Error(`合入队列只接收独立的本仓库开发 worktree：${stage.cwd}`);
    }
    const previous = state.batches.find((item) => item.id === batch.id);
    if (previous) Object.assign(previous, batch); else state.batches.push(batch);
    writeJsonAtomic(statePath(dir), state);
    recordBatchInfo(batchEventInfo(batch));
  } finally { release(); }
}

function batchFor(state: MergeQueue, file: string): QueueBatch | undefined {
  return state.batches.find((batch) => batch.file === canonical(file));
}
export function registeredQueueBatch(repo: string, file: string): QueueBatch | undefined {
  if (gitResult(repo, ["rev-parse", "--git-common-dir"]).status !== 0) return undefined;
  const state = readMergeQueue(repo);
  if (!state) return undefined;
  const exact = batchFor(state, file);
  if (exact) return exact;
  // 发布分支上的批次文件和搬入 worktree 的那份可作为同一入口，但不信任同名的其他计划。
  const raw = readJson<{ name?: string; branch?: string; stages?: Record<string, { branch?: string }> }>(file);
  return raw && state.batches.find((batch) => batch.name === raw.name && batch.stages.every((stage) => stage.branch === (raw.stages?.[stage.name]?.branch ?? raw.branch)));
}

/** 私有 index 冻结有效工作区（含未跟踪文件）；只写队列记录与 Git 对象，不碰开发索引/分支/文件。 */
function sourceTree(state: MergeQueue, cwd: string): { head: string; tree: string } {
  return workingTree(cwd, state.dir);
}
function qualifications(batch: QueueBatch): Qualification[] | undefined {
  const result: Qualification[] = [];
  for (const stage of batch.stages) {
    const status = readJson<StageStatus>(statusPath(batch.dir, stage.name));
    const inbox = readJson<InboxMessage>(inboxPath(batch.dir, stage.name));
    if (status?.event !== "done" || !status.readyEpoch || status.inbox < (inbox?.seq ?? 0)) return undefined;
    // 队列只检查来源仍存在，不刷新项目索引或改写开发状态。
    const context = loadContext(stage.cwd);
    if ((!context && status.sourceInputs) || context?.sources.some((source) => !source.optional && !existsSync(resolve(context.root, source.path)))) return undefined;
    result.push({ stage: stage.name, session: status.sessionId, epoch: status.readyEpoch, inbox: status.inbox, sourceInputs: status.sourceInputs, ...(status.acceptance ? { acceptance: status.acceptance } : {}) });
  }
  return result;
}
function enqueue(dir: string, batchId: string, requireAcceptance: boolean, integration?: QueueAcceptance, integrationEpoch?: string, expectedIntegrationEpoch = false, run?: QueuePipelineRun): BatchCommit[] | undefined {
  return publication(dir, () => change(dir, (state) => {
    const batch = state.batches.find((item) => item.id === batchId)!;
    if (run) checkPipelineRun(run, batch);
    if (batch.stages.length > 1 && !requireAcceptance) return;
    const stopped = state.entries.some((entry) => entry.batch === batchId && entry.autoStopped);
    const qualification = qualifications(batch);
    if (!qualification) return;
    if (run?.qualification && hash(qualification) !== run.qualification) throw new Error("整批完成资格已变化，未提交旧验收结果");
    if (batch.stages.length > 1) {
      if (expectedIntegrationEpoch && batch.integrationEpoch !== integrationEpoch) return; // 旧验收晚到，不能覆盖更新的一轮。
      batch.integrationEpoch = integrationEpoch;
    }
    const previous = state.entries.filter((entry) => entry.batch === batchId).at(-1);
    if (previous?.status === "merged" && previous.result && previous.tree && batch.stages.every((stage) => {
      const current = sourceTree(state, stage.cwd);
      return current.head === previous.result && current.tree === previous.tree;
    })) return;
    const signature = hash([qualification, integration, integrationEpoch]);
    const duplicate = Boolean(previous && previous.status !== "blocked" && hash([previous.qualification, previous.integration, previous.integrationEpoch]) === signature)
      || (stopped && batch.commitSignature === signature);
    if (duplicate && !run) return; // 宿主重放不重做提交核对，也不补发历史 phase/事件。
    // 持有运行权的新调用仍由提交模块核对现有提交，但不重复入队或登记；新资格才撤销旧候选。
    for (const entry of state.entries) if (!duplicate && entry.batch === batchId && ["pending", "testing", "ready", "blocked"].includes(entry.status)) {
      entry.status = "blocked"; entry.reason = "本批已有新的完成资格";
    }
    const integrationConclusions: string[] = [];
    if (batch.stages.length > 1) {
      let conclusion = batch.acceptance ? "通过（流水线确认）" : "未配置，跳过";
      if (integration) {
        conclusion = "通过";
        if (integration.failed.length) conclusion = "不通过";
        else if (integration.partial.length || integration.manual.length) conclusion = "部分验证（见总表欠项）";
      }
      integrationConclusions.push(`整批验收：${conclusion}`);
    }
    const candidates = [...new Set(batch.stages.map((stage) => stage.branch))].map((branch) => {
      const stages = batch.stages.filter((stage) => stage.branch === branch);
      const statuses = stages.map((stage) => ({ stage, status: readJson<StageStatus>(statusPath(batch.dir, stage.name))! }))
        .sort((a, b) => a.status.updatedAt.localeCompare(b.status.updatedAt));
      const selected = statuses.at(-1)!;
      if (!selected.status.candidate) throw new Error("完成记录缺少候选树，需要原开发会话重新检查；未提交");
      return { branch, cwd: selected.stage.cwd, candidate: selected.status.candidate, conclusions: statuses.map(({ status: item }) =>
        `段：${item.stage}；门禁：${item.checks?.gate ?? "完成资格已确认"}；评审：${item.checks?.review ?? "完成资格已确认"}；验收：${item.checks?.acceptance ?? "见段总结"}；总结：${item.summary}`).concat(integrationConclusions) };
    });
    const stageDetails = batch.stages.map((stage) => {
      const phase = readJson<PhaseRecord>(phasePath(batch.dir, stage.name)), status = readJson<StageStatus>(statusPath(batch.dir, stage.name));
      return { stage: stage.name, evidence: phase?.evidence ?? (status?.summary ? { summary: status.summary } : {}), detail: phase?.detail ?? {
        gate: status?.checks?.gate ?? "未验证", review: { verdict: status?.checks?.review ?? "未验证", mustFix: null, suggestions: null },
        acceptance: { verdict: status?.checks?.acceptance ?? "未验证", ...(status?.acceptance ?? { failed: [], partial: [], manual: [] }) } } };
    });
    const detail = stageDetails.length === 1 ? stageDetails[0].detail : {
      gate: stageDetails.map((item) => ({ stage: item.stage, result: item.detail.gate })),
      review: { stages: stageDetails.map((item) => ({ stage: item.stage, ...item.detail.review as object })) },
      acceptance: { verdict: !batch.acceptance ? "未配置" : integration?.partial.length || integration?.manual.length ? "部分验证" : "通过", ...(integration ?? { failed: [], partial: [], manual: [] }) } };
    const evidence = stageDetails.length === 1 ? stageDetails[0].evidence : { summary: join(batch.dir, "report.md"), ...Object.fromEntries(stageDetails.flatMap((item) => Object.entries(item.evidence).map(([key, value]) => [`${item.stage}.${key}`, value]))) };
    const commits = commitBatch({ id: batch.id, name: batch.name, release: batch.release, scratch: state.dir, candidates, previous: batch.commits,
      event: { info: batchEventInfo(batch), detail: { ...detail, completion: signature }, evidence },
      save: (records) => { batch.commits = records; writeJsonAtomic(statePath(dir), state); } });
    if (duplicate) return commits;
    const id = randomUUID(), sources: Source[] = commits.map((item) => ({ cwd: item.cwd, branch: item.branch, head: item.commit, tree: item.tree, commit: item.commit }));
    for (const [index, source] of sources.entries()) gitText(state.repo, ["-c", "core.hooksPath=/dev/null", "update-ref", `refs/loop/queue/${id}/source-${index}`, source.commit]);
    const entry: QueueEntry = { id, batch: batchId, name: batch.name, qualification, sources, ...(integration ? { integration } : {}), ...(integrationEpoch ? { integrationEpoch } : {}), order: state.nextOrder++, status: "pending", attempt: 0, createdAt: stamp(), updatedAt: stamp() };
    try { entry.ledger = appendBatchCommitRecord({ project: state.repo, batch: batch.name, entry: id, file: batch.file, commits,
      conclusions: candidates.flatMap((item) => item.conclusions), pending: [...qualification.flatMap((item) => [...(item.acceptance?.partial ?? []), ...(item.acceptance?.manual ?? [])].map((pending) => ({ ...pending, id: `${item.stage}/${pending.id}` }))), ...[...(integration?.partial ?? []), ...(integration?.manual ?? [])].map((item) => ({ ...item, id: `整批验收/${item.id}` }))] }); }
    catch (error) { entry.ledgerError = String(error); }
    batch.commitSignature = signature; batch.commitLedger = entry.ledger;
    if (!stopped) state.entries.push(entry);
    notify(state, entry, commits.map((item) => `已提交 ${item.branch} ${item.commit.slice(0, 8)}。要推到远端就执行：bin/loop 推送 ${shellQuote(batch.file)}`).join("\n") + (entry.ledgerError ? `\n交付总表写入失败：${entry.ledgerError}` : "") + (stopped ? "\n同一批次已第 3 次退回，停止自动排队，等待用户决定。" : ""));
    return commits;
  }));
}

/** 由 Pi/Hook 已确认完成的边界调用；非开工项目没有任何副作用。 */
export function queueStageEvent(options: { cwd: string; file?: string; stage?: string; status: Omit<StageStatus, "stage" | "seq" | "updatedAt"> }): void {
  if (!options.file || !options.stage) return;
  const repo = gitResult(options.cwd, ["rev-parse", "--show-toplevel"]);
  if (repo.status !== 0) return;
  const state = readMergeQueue(repo.stdout.trim());
  if (!state) return;
  const batch = registeredQueueBatch(state.repo, options.file);
  if (!batch || !batch.stages.some((stage) => stage.name === options.stage && stage.cwd === canonical(options.cwd))) return;
  writeStageStatus({ dir: batch.dir, stage: options.stage }, options.status);
  if (options.status.event === "done") {
    try {
      if (batch.stages.length === 1) enqueue(state.dir, batch.id, false);
      else maybeIntegrate(state.dir, batch.id);
    } catch (error) {
      writeStageStatus({ dir: batch.dir, stage: options.stage }, { ...options.status, event: "paused", pauseReason: String(error) });
      const info = batchEventInfo(batch), reason = eventReason(`提交核对失败：${String(error)}`), evidence = { queue: statePath(state.dir), summary: options.status.summary };
      writePhase(info, null, "failed", { status: "failed", ...reason, evidence, detail: { exitCode: 1 } });
      pushEvent(info, null, "failed", reason, evidence, { exitCode: 1 });
      throw error;
    }
  }
  if (options.status.event === "done" || state.entries.some((entry) => entry.batch === batch.id && ["pending", "testing", "ready"].includes(entry.status))) kickMergeQueue(state.repo);
}
/** 完成宿主的末条通知也带上可复制的推送入口，避免被普通完成提示覆盖。 */
export function queueCommitNotice(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!env.AUTOREVIEW_BATCH_FILE || !env.AUTOREVIEW_STAGE) return "";
  const batch = registeredQueueBatch(cwd, env.AUTOREVIEW_BATCH_FILE);
  if (!batch?.commits?.length) return "";
  return batch.commits.map((item) => `已提交 ${item.branch} ${item.commit.slice(0, 8)}。要推到远端就执行：bin/loop 推送 ${shellQuote(batch.file)}`).join("\n");
}

/** 用户显式推送；与提交共用发布锁，仅推登记的批次头，不强推、不推 release。 */
export function pushQueueBatch(repo: string, batch: QueueBatch, dryRun: boolean): BatchCommit[] {
  const perform = (): BatchCommit[] => {
    const state = readMergeQueue(repo)!, current = state.batches.find((item) => item.id === batch.id)!;
    const commits = current.commits;
    if (!commits?.length) throw new Error("本批尚无程序确认的批次提交，请先完成检查");
    gitText(repo, ["remote", "get-url", "origin"], "核对 origin");
    for (const item of commits) {
      if (item.branch === batch.release || gitText(repo, ["rev-parse", `refs/heads/${item.branch}`]) !== item.commit) throw new Error(`批次分支头已变化，需重新完成检查：${item.branch}`);
    }
    if (dryRun) return commits;
    for (const item of commits) {
      const ref = `refs/heads/${item.branch}`;
      const result = gitResult(repo, ["-c", "core.hooksPath=/dev/null", "push", "--no-follow-tags", "--recurse-submodules=no", "--", "origin", `${item.commit}:${ref}`]);
      if (result.status !== 0) throw new Error(`推送 ${item.branch} 到 origin 失败，未强推：${(result.stderr || result.stdout).trim()}`);
      // 每个成功分支立即记下确实推送的提交；其他分支失败也不能忘记已推历史。
      change(state.dir, (latest) => { latest.batches.find((candidate) => candidate.id === batch.id)!.commits!.find((commit) => commit.branch === item.branch)!.pushed = item.commit; });
      item.pushed = item.commit;
      gitText(repo, ["config", `branch.${item.branch}.remote`, "origin"]);
      gitText(repo, ["config", `branch.${item.branch}.merge`, ref]);
    }
    return commits;
  };
  return dryRun ? perform() : publication(queueDir(repo), perform);
}

function batchConfiguration(file: string): { acceptance: boolean; signature: string } {
  try {
    const text = readFileSync(file, "utf8"), raw = JSON.parse(text);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("批次文件必须是对象");
    if (raw.acceptance !== undefined && raw.e2e !== undefined) throw new Error("acceptance 和 e2e 只能写一个"); // 兼容旧批次。
    return { acceptance: raw.acceptance !== undefined || raw.e2e !== undefined, signature: hash(text) };
  } catch (error) { throw new Error(`无法核对本轮批次配置 ${file}：${String(error)}`); }
}
function checkPipelineRun(run: QueuePipelineRun, batch: QueueBatch): void {
  if (run.batch !== batch.id || readJson<LockOwner>(join(run.dir, `integration-${batch.id}.lock`))?.token !== run.token) throw new Error("本批流水线运行身份已变化，未采用旧完成结果");
  if (batchConfiguration(batch.file).signature !== run.configuration) throw new Error("本轮运行期间批次配置已变化，请按当前计划重新检查；未提交");
}
/** 正常启动与队列续跑共用同一把运行锁；在任何异步准备/开发/验收之前登记。 */
export function beginQueuePipeline(repo: string, file: string, acceptance: boolean): QueuePipelineRun | undefined {
  const batch = registeredQueueBatch(repo, file);
  if (!batch || batch.stages.length < 2) return undefined;
  const dir = queueDir(repo), release = lock(dir, `integration-${batch.id}`);
  if (!release) throw new Error("本批流水线正在运行，未重复启动");
  try {
    const configuration = batchConfiguration(batch.file);
    if (configuration.acceptance !== acceptance) throw new Error("本轮计划与当前批次文件的整批验收配置不一致，请重新加载计划");
    publication(dir, () => change(dir, (state) => { state.batches.find((item) => item.id === batch.id)!.acceptance = acceptance; }));
    const qualification = qualifications(batch);
    return { dir, batch: batch.id, token: readJson<LockOwner>(join(dir, `integration-${batch.id}.lock`))!.token,
      acceptance, configuration: configuration.signature, qualification: qualification ? hash(qualification) : undefined, release };
  } catch (error) { release(); throw error; }
}
export function endQueuePipeline(run: QueuePipelineRun): void {
  try {
    if (run.qualification) publication(run.dir, () => change(run.dir, (state) => {
      state.batches.find((item) => item.id === run.batch)!.lastRunQualification = run.qualification;
    }));
  } finally { run.release(); }
  // 活动流水线退出前到达的新 done 也不能丢；释放运行锁后再决定是否接着收尾。
  maybeIntegrate(run.dir, run.batch);
}

/** 整合重验开始即撤销旧资格；失败或中断也不能留旧的通过结果供恢复执行器发布。 */
export function queueBatchRecheck(repo: string, file: string, run?: QueuePipelineRun): string | undefined {
  const batch = registeredQueueBatch(repo, file);
  if (!batch || batch.stages.length < 2) return undefined;
  const epoch = randomUUID();
  publication(queueDir(repo), () => change(queueDir(repo), (state) => {
    if (run) {
      checkPipelineRun(run, batch);
      const qualification = qualifications(batch);
      run.qualification = qualification ? hash(qualification) : undefined;
    }
    state.batches.find((item) => item.id === batch.id)!.integrationEpoch = epoch;
    for (const entry of state.entries) if (entry.batch === batch.id && ["pending", "testing", "ready", "blocked"].includes(entry.status)) {
      Object.assign(entry, { status: "blocked", reason: "整批验收正在重验，旧完成资格已撤销", updatedAt: stamp() });
    }
  }));
  return epoch;
}
/** 返回本次由提交模块核对成功的提交；未登记、资格不足和迟到结果都不冒充完成。 */
export function queueBatchComplete(repo: string, file: string, acceptancePassed: boolean, record?: AcceptanceRecord, integrationEpoch?: string, run?: QueuePipelineRun): BatchCommit[] | undefined {
  const batch = registeredQueueBatch(repo, file);
  if (!batch) return;
  if (run) checkPipelineRun(run, batch);
  const configured = run?.acceptance ?? (batchConfiguration(batch.file).acceptance || batch.acceptance === true || Boolean(record) || integrationEpoch !== undefined);
  // 本轮确实跑过但未通过的验收，绝不能被开工时的“未配置”覆盖。
  const passed = acceptancePassed && (!record || record.verdict === "通过");
  const eligible = passed || (!configured && !record);
  if (run) {
    const current = qualifications(batch), signature = current ? hash(current) : undefined;
    if (run.acceptance && run.qualification && signature !== run.qualification) throw new Error("整批完成资格已变化，未采用旧验收结果");
    run.qualification = signature;
  }
  if (batch.stages.length > 1 && !eligible) {
    const applied = publication(queueDir(repo), () => change(queueDir(repo), (state) => {
      const current = state.batches.find((item) => item.id === batch.id)!;
      if (integrationEpoch !== undefined && current.integrationEpoch !== integrationEpoch) return false;
      current.integrationEpoch = integrationEpoch ?? (record ? hash(record) : current.integrationEpoch);
      const qualification = qualifications(current);
      if (qualification) current.lastRunQualification = hash(qualification);
      for (const entry of state.entries) if (entry.batch === batch.id && ["pending", "testing", "ready", "blocked"].includes(entry.status)) {
        Object.assign(entry, { status: "blocked", reason: "整批验收未通过，旧完成资格已撤销", updatedAt: stamp() });
      }
      return true;
    }));
    if (applied) reportUncommittedBatch(batchEventInfo(batch), record);
    kickMergeQueue(repo);
    return;
  }
  const integration = batch.stages.length > 1 && record ? queueAcceptance(record) : undefined;
  const epoch = batch.stages.length > 1 ? integrationEpoch ?? (record ? hash(record) : undefined) : undefined;
  const commits = enqueue(queueDir(repo), batch.id, eligible, integration, epoch, integrationEpoch !== undefined, run);
  kickMergeQueue(repo);
  return commits;
}

function launch(dir: string, mode: string, extra: string[] = []): void {
  const fd = openSync(join(dir, "worker.log"), "a", 0o600), token = randomUUID();
  const marker = join(dir, `executor-${token}.json`);
  writeJsonAtomic(marker, { token, mode, target: extra[0], pid: 0, started: "" });
  const finished = () => { if (readJson<LockOwner>(marker)?.token === token) rmSync(marker, { force: true }); };
  try {
    // 队列/恢复会话是独立消费者；不能继承已完成流水线的归属标记而被其收尾误杀。
    const env: NodeJS.ProcessEnv = { ...process.env, AUTOREVIEW_PIPELINE_LAUNCH_TOKEN: "", AUTOREVIEW_QUEUE_EXECUTOR_ID: token };
    for (const key of ["AUTOREVIEW_PROCESS_OWNER", "AUTOREVIEW_RUN_ID", "AUTOREVIEW_TEMP_DIR", "AUTOREVIEW_EVIDENCE_DIR", "AUTOREVIEW_RUN_DIR"]) delete env[key];
    if (process.env.AUTOREVIEW_RUN_ID) delete env.TMPDIR;
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), mode, dir, ...extra], {
      cwd: dir, detached: true, stdio: ["ignore", fd, fd], env,
    });
    if (child.pid) writeJsonAtomic(marker, { token, mode, target: extra[0], pid: child.pid, started: processStartTime(child.pid) });
    child.on("error", (error) => { finished(); writeFileSync(join(dir, "launch-error.log"), `${stamp()} ${error}\n`); });
    child.once("exit", finished);
    child.unref();
  } finally { closeSync(fd); }
}
export function kickMergeQueue(repo: string): void {
  const state = readMergeQueue(repo);
  if (!state) return;
  const owner = readJson<LockOwner>(join(state.dir, "worker.lock"));
  if (owner?.started && !deadOwner(owner)) return;
  launch(state.dir, "worker");
}
function integrationNeeded(state: MergeQueue, batch: QueueBatch): boolean {
  if (batch.stages.length < 2) return false;
  const entry = state.entries.filter((item) => item.batch === batch.id).at(-1), current = qualifications(batch);
  if (!current || entry?.deliveries?.some((item) => !item.sent)) return false;
  const handled = batch.lastRunQualification ?? (entry ? hash(entry.qualification) : undefined);
  return handled !== undefined && hash(current) !== handled;
}
function maybeIntegrate(dir: string, batchId: string): void {
  const release = lock(dir, `integration-dispatch-${batchId}`);
  if (!release) return;
  try {
    const state = load(dir), batch = state.batches.find((item) => item.id === batchId)!;
    if (!integrationNeeded(state, batch)) return;
    const running = readJson<LockOwner>(join(dir, `integration-${batchId}.lock`));
    if (running && !deadOwner(running)) return;
    // 触发器已发出但尚未进入流水线时，也要去重，不能只检查运行锁。
    for (const file of readdirSync(dir).filter((name) => /^executor-[0-9a-f-]+\.json$/.test(name))) {
      const owner = readJson<LockOwner & { mode: string; target?: string }>(join(dir, file));
      if (owner?.mode === "integrate" && owner.target === batchId && (!owner.pid || !deadOwner(owner))) return;
    }
    launch(dir, "integrate", [batchId]);
  } finally { release(); }
}
/** 状态也是恢复触发器；dry-run 调用方只读 readMergeQueue。 */
export function recoverMergeQueue(repo: string): void {
  const state = readMergeQueue(repo);
  if (!state) return;
  for (const batch of state.batches) {
    if (batch.stages.length === 1) enqueue(state.dir, batch.id, false);
    else maybeIntegrate(state.dir, batch.id);
    const entry = state.entries.filter((item) => item.batch === batch.id).at(-1);
    if (entry?.status === "returned") for (const delivery of entry.deliveries ?? []) resumeDelivery(state, batch, entry, delivery);
  }
  kickMergeQueue(repo);
}

function ownedWorkspace(state: MergeQueue): void {
  if (realpathSync(state.dir) !== state.dir || lstatSync(state.dir).isSymbolicLink()) throw new Error("测试工作区父目录归属已变化");
  for (const item of worktrees(state.repo)) {
    if (resolve(item.path) === state.workspace) continue;
    if (overlaps(state.workspace, realpathSync(item.path))) throw new Error("测试工作区与用户工作区重叠");
  }
  const holder = worktrees(state.repo).find((item) => resolve(item.path) === state.workspace);
  if (!holder) {
    if (existsSync(state.workspace)) throw new Error(`固定测试目录已存在但未登记为队列 worktree，未覆盖：${state.workspace}`);
    gitText(state.repo, ["-c", "core.hooksPath=/dev/null", "worktree", "add", "--detach", state.workspace, "HEAD"]);
  }
  checkOwnedWorkspace(state);
}
/** 只有记录、Git 登记和实际目录都匹配的自有 detached worktree 才能豁免重叠检查。 */
function checkOwnedWorkspace(state: MergeQueue): void {
  const holder = worktrees(state.repo).find((item) => resolve(item.path) === state.workspace);
  if (!holder?.detached || holder.bare || holder.branch || lstatSync(state.dir).isSymbolicLink() || realpathSync(state.dir) !== state.dir
    || lstatSync(state.workspace).isSymbolicLink() || realpathSync(state.workspace) !== state.workspace || commonDir(state.workspace) !== state.common
    || canonical(gitText(state.workspace, ["rev-parse", "--show-toplevel"])) !== state.workspace
    || gitText(state.workspace, ["branch", "--show-current"])) throw new Error("测试工作区身份不符或不再是 detached，未清理");
}
const testGit = (state: MergeQueue, args: string[]): string => gitText(state.workspace, ["-c", "core.hooksPath=/dev/null", "-c", "rerere.enabled=false", ...args]);
function resetWorkspace(state: MergeQueue, base: string): void {
  ownedWorkspace(state);
  testGit(state, ["reset", "--hard", base]);
  testGit(state, ["clean", "-ffdqx"]);
  if (testGit(state, ["status", "--porcelain"]) || gitResult(state.workspace, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]).status === 0) throw new Error("测试工作区未恢复干净");
}
function testBatchFile(state: MergeQueue, batch: QueueBatch): string {
  for (const root of [state.repo, ...batch.stages.map((stage) => gitText(stage.cwd, ["rev-parse", "--show-toplevel"]))]) {
    if (!within(root, batch.file)) continue;
    const target = resolve(state.workspace, relative(root, batch.file));
    if (existsSync(target)) return target;
  }
  const target = join(state.dir, `${batch.id}.batch.json`);
  writeFileSync(target, readFileSync(batch.file));
  return target;
}
function copyTestLocalFiles(state: MergeQueue, batch: QueueBatch, workDir: string): void {
  const project = loadProjectLayout(batch.project);
  for (const file of project.layout.localFiles) {
    const source = resolve(project.root, file), target = resolve(workDir, file);
    if (!existsSync(source)) continue;
    // 只复制显式声明且两侧忽略的文件；不经测试树里的链接写到其他工作区。
    for (let path = target; path !== state.workspace; path = dirname(path)) {
      if (!within(state.workspace, path)) throw new Error("本机文件越出测试工作区");
      if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error(`测试本机文件路径是符号链接：${path}`);
    }
    if (gitResult(project.root, ["check-ignore", "-q", "--", file]).status !== 0 || gitResult(workDir, ["check-ignore", "-q", "--", file]).status !== 0
      || gitText(workDir, ["ls-files", "--", file])) throw new Error(`本机文件未被两侧忽略或已跟踪：${file}`);
    if (lstatSync(source).isSymbolicLink()) throw new Error(`本机文件来源是符号链接，未复制：${source}`);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(source, target, { recursive: true, dereference: false });
  }
}
function qualificationProblem(state: MergeQueue, batch: QueueBatch, entry: QueueEntry): string | undefined {
  const latest = load(state.dir);
  if (batch.stages.length > 1 && latest.batches.find((item) => item.id === batch.id)?.integrationEpoch !== entry.integrationEpoch) return "整批验收完成资格已变化，旧结果已失效";
  if (latest.entries.filter((item) => item.batch === batch.id).at(-1)?.id !== entry.id) return "本批已有新的完成资格，旧结果已失效";
  const currentQualification = qualifications(batch);
  if (!currentQualification || hash(currentQualification) !== hash(entry.qualification)) return "批次完成资格已变化，需要原开发会话重新完成检查";
  for (const source of entry.sources) {
    if (gitText(source.cwd, ["branch", "--show-current"]) !== source.branch) return "批次工作区已切换分支";
    const current = sourceTree(state, source.cwd);
    if (current.head !== source.head || current.tree !== source.tree) return "批次候选已变化，需要原开发会话重新完成门禁和评审";
  }
  return undefined;
}
function notify(state: MergeQueue, entry: QueueEntry, text?: string): void {
  const batch = state.batches.find((item) => item.id === entry.batch)!;
  const conclusions = [...entry.qualification.map((item) => ({ label: item.stage, acceptance: item.acceptance })), ...(entry.integration ? [{ label: "整批验收", acceptance: entry.integration }] : [])]
    .flatMap(({ label, acceptance }) => [...(acceptance?.partial ?? []).map((item) => `${label}：${item.id} 部分验证：${item.text}；${item.detail}`),
      ...(acceptance?.failed ?? []).map((item) => `${label}：${item.id} 不通过：${item.text}；${item.detail}`),
      ...(acceptance?.manual ?? []).map((item) => `${label}/${item.id}：${item.text}；${item.detail}`)]);
  const message = text ?? `可合入：${entry.name}；请执行 loop 合入 ${batch.file}\n${(batch.commits ?? []).map((item) => `已提交 ${item.branch} ${item.commit.slice(0, 8)}。要推到远端就执行：bin/loop 推送 ${shellQuote(batch.file)}`).join("\n")}\n${conclusions.join("\n")}`;
  writeFileSync(join(state.dir, `${entry.id}.notification.txt`), `${message}\n`);
  const current = readJson<MergeQueue>(statePath(state.dir))?.entries.find((item) => item.id === entry.id) ?? entry;
  reportQueue({ ...state, entries: state.entries.some((item) => item.id === current.id) ? state.entries.map((item) => item.id === current.id ? current : item) : [...state.entries, current] }, current);
  systemNotify("Loop 合入队列", message);
}
function manualItems(entry: QueueEntry): QueueAcceptanceItem[] {
  return [...entry.qualification.flatMap((item) => (item.acceptance?.manual ?? []).map((manual) => ({ ...manual, id: `${item.stage}/${manual.id}` }))),
    ...(entry.integration?.manual ?? []).map((item) => ({ ...item, id: `整批验收/${item.id}` }))];
}
function precedingChanges(state: MergeQueue, batch: QueueBatch, entry: QueueEntry): string {
  if (!entry.base) return "";
  const bases = [...new Set(entry.sources.map((source) => gitText(state.repo, ["merge-base", source.head, entry.base!])))];
  const commits = [...new Set(bases.flatMap((base) => gitText(state.repo, ["log", "--format=%h %s%n%b", "--name-only", `${base}..${entry.base}`]).split("\n")))].filter(Boolean);
  const batches = state.entries.filter((other) => other.batch !== batch.id && other.status === "merged" && other.result
    && gitResult(state.repo, ["merge-base", "--is-ancestor", other.result, entry.base!]).status === 0).map((other) => other.name);
  return `已先合入的批次：${batches.join("、") || "发布分支上的其他提交"}\n改动文件及提交说明：\n${commits.join("\n") || "（本批分叉以来发布分支没有新增提交）"}`;
}

/** 开工只提示显式 allow 前缀的交集，不阻止并行，也不推断未声明范围。 */
export function scopeOverlapWarnings(repo: string, name: string, stages: { name: string; cwd: string; scope?: StageScope }[]): string[] {
  const state = readMergeQueue(repo);
  if (!state) return [];
  const warnings: string[] = [];
  for (const batch of state.batches) {
    if (batch.name === name) continue;
    const latest = state.entries.filter((entry) => entry.batch === batch.id).at(-1);
    if (latest && ["merged", "withdrawn"].includes(latest.status)) continue;
    for (const stage of stages) for (const other of batch.stages) {
      const intersections = (stage.scope?.allow ?? []).flatMap((path) => (other.scope?.allow ?? []).filter((target) => overlaps(resolve(loadProjectLayout(repo).root, path), resolve(batch.project, target))).map((target) => `${path} / ${target}`));
      if (intersections.length) warnings.push(`scope.allow 与进行中批次「${batch.name}」的 ${other.name} 重叠：${intersections.join("、")}；建议改为串行（不阻止开工）`);
    }
  }
  return warnings;
}

function finishLegacyMerge(state: MergeQueue, batch: QueueBatch, entry: QueueEntry): void {
  const manual = manualItems(entry);
  if (!entry.mergeNotified) {
    try { entry.ledger = appendMergeRecord({ project: state.repo, batch: batch.name, entry: entry.id, commit: entry.result!, file: batch.file, manual }); entry.ledgerError = undefined; }
    catch (error) { entry.ledgerError = String(error); }
    update(state.dir, entry.id, { ledger: entry.ledger, ledgerError: entry.ledgerError });
  }
  // 只收尾停用前已经发布的事务；即使旧意图要求推送，也绝不再推 release。
  if (entry.push?.status === "started") {
    entry.push = { status: "failed", reason: "历史推送结果未确认；自动推送已停用，未重试" };
    update(state.dir, entry.id, { push: entry.push });
  }
  notify(state, entry, `历史合入已收尾：${entry.name}；已合入 ${entry.result}；自动推送已停用${entry.ledgerError ? `；交付总表写入失败：${entry.ledgerError}` : ""}${manual.length ? `\n待人工验收：\n${manual.map((item) => `- ${item.id}：${item.text}；${item.detail}`).join("\n")}` : ""}`);
  update(state.dir, entry.id, { mergeNotified: true });
}
async function recoverLegacyMerge(state: MergeQueue, batch: QueueBatch, entry: QueueEntry): Promise<void> {
  const { applyQueuedResult } = await import("./loop.ts");
  try {
    const merged = mergeLocked(state, batch, false, (candidate, save) => applyQueuedResult(state.repo, batch.release, candidate, save), true, entry.id);
    if (merged.status === "merged") finishLegacyMerge(state, batch, merged);
  } catch (error) {
    publication(state.dir, () => {
      const fresh = load(state.dir).entries.find((item) => item.id === entry.id)!;
      const head = gitText(state.repo, ["rev-parse", `refs/heads/${batch.release}`]);
      const unpublished = fresh.runtimePublication === "prepared" || (fresh.runtimePublication === undefined && head === fresh.base);
      if (["merging", "ready"].includes(fresh.status) && unpublished && !fresh.runtimeStash && head !== fresh.result) {
        const problem = qualificationProblem(state, batch, fresh), stale = head !== fresh.base;
        update(state.dir, entry.id, { status: problem ? "blocked" : stale ? "pending" : "ready", notified: false,
          reason: problem ?? (stale ? "发布分支已经变化，确认尚未发布且无待恢复副作用，自动重新测试" : String(error)) });
      }
    });
    throw error;
  }
}

/** 程序压缩只改变历史，不能让原完成资格失效或启动新一轮评审。 */
export function queueCommittedResult(cwd: string, snapshot: Snapshot, env: NodeJS.ProcessEnv, epoch?: string): boolean {
  if (!env.AUTOREVIEW_BATCH_FILE || !env.AUTOREVIEW_STAGE || !epoch) return false;
  const batch = registeredQueueBatch(cwd, env.AUTOREVIEW_BATCH_FILE);
  const stage = batch?.stages.find((item) => item.name === env.AUTOREVIEW_STAGE && item.cwd === canonical(cwd));
  if (!batch || !stage) return false;
  const status = readJson<StageStatus>(statusPath(batch.dir, stage.name));
  const inbox = readJson<InboxMessage>(inboxPath(batch.dir, stage.name));
  const record = batch.commits?.find((item) => item.branch === stage.branch);
  if (status?.event !== "done" || status.readyEpoch !== epoch || status.inbox < (inbox?.seq ?? 0)
    || record?.commit !== snapshot.head || record.tree !== snapshot.tree || snapshot.untracked.length) return false;
  return gitText(cwd, ["branch", "--show-current"]) === record.branch;
}

/** 只豁免已登记本批、完整提交与完整工作树都等于已测结果的会话。 */
export function queueReviewedResult(cwd: string, snapshot: Snapshot, env: NodeJS.ProcessEnv): { entry: QueueEntry; acceptance: QueueAcceptance | null } | undefined {
  if (!env.AUTOREVIEW_BATCH_FILE || !env.AUTOREVIEW_STAGE || snapshot.untracked.length || snapshot.tree !== gitText(cwd, ["rev-parse", "HEAD^{tree}"])) return undefined;
  const batch = registeredQueueBatch(cwd, env.AUTOREVIEW_BATCH_FILE);
  if (!batch || !batch.stages.some((stage) => stage.name === env.AUTOREVIEW_STAGE && stage.cwd === canonical(cwd))) return undefined;
  const state = readMergeQueue(cwd)!;
  const entry = state.entries.filter((item) => item.batch === batch.id).at(-1);
  if (!entry || !["ready", "merging", "merged"].includes(entry.status) || !entry.result || !entry.tree || entry.result !== snapshot.head || entry.tree !== snapshot.tree) return undefined;
  const top = gitText(cwd, ["rev-parse", "--show-toplevel"]);
  if (gitText(top, ["status", "--porcelain", "--untracked-files=all"]) || gitText(cwd, ["rev-parse", `refs/loop/queue/${entry.id}/result`]) !== entry.result) return undefined;
  return { entry, acceptance: entry.qualification.find((item) => item.stage === env.AUTOREVIEW_STAGE)?.acceptance ?? null };
}

function returnToDeveloper(state: MergeQueue, batch: QueueBatch, entry: QueueEntry, files: string[], reason: string): void {
  const targets = new Map<string, { files: string[]; fallback: boolean }>();
  const last = batch.steps.flat().at(-1)!;
  for (const file of files.length ? files : [""]) {
    const owners = batch.stages.filter((stage) => {
      const top = gitText(stage.cwd, ["rev-parse", "--show-toplevel"]), absolute = resolve(top, file);
      if (!file) return false;
      if (stage.scope?.allow) return inScope(relative(stage.cwd, absolute).replace(/\\/g, "/"), stage.scope);
      return stage.cwd !== top && within(stage.cwd, absolute);
    });
    const name = owners.length === 1 ? owners[0].name : last;
    const target = targets.get(name) ?? { files: [], fallback: false };
    if (file) target.files.push(file);
    target.fallback ||= owners.length !== 1;
    targets.set(name, target);
  }
  const count = state.entries.filter((item) => item.batch === batch.id && (item.returnCount || ["returning", "returned", "stopped"].includes(item.status))).length + 1;
  const prior = precedingChanges(state, batch, entry);
  const stop = count >= 3;
  if (stop) reason += "；同一批次第 3 次退回，停止自动排队，请用户决定后续取舍";
  const deliveries: Delivery[] = [];
  for (const [stage, target] of targets) {
    const old = readJson<InboxMessage>(inboxPath(batch.dir, stage));
    const status = readJson<StageStatus>(statusPath(batch.dir, stage));
    // 不覆盖尚未消费的流水线返修。
    if (old && (status?.inbox ?? 0) < old.seq) throw new Error(`${stage} 尚有未消费的收件箱消息，保留失败记录，稍后重试退回`);
    const mustFix = `${reason}\n文件：${target.files.join("、") || "未能从门禁输出定位失败文件"}\n${target.fallback ? `无法唯一确定文件归属，退回最后一段「${last}」。\n` : ""}`;
    deliveries.push({ stage, seq: Math.max(old?.seq ?? 0, status?.inbox ?? 0) + 1, mustFix,
      message: `【合入队列返修】\n批次：${batch.name}\n发布分支：${batch.release}（${entry.base}）\n${mustFix}\n${prior}\n${entry.output ?? ""}\n完整门禁日志：${entry.log ?? "（合并冲突，未运行门禁）"}\n请先合进最新发布分支 ${batch.release}，解决冲突或修复失败，定向自检后重走门禁和评审；最后一行写【交付完成】。${stop ? "已停止自动排队，完成后等待用户处理。" : "完成后自动回到队尾。"}` });
  }
  update(state.dir, entry.id, { status: "returning", reason, conflicts: entry.conflicts, deliveries, returnCount: count, autoStopped: stop, conflictKind: entry.conflictKind });
  if (stop) notify(state, entry, `${entry.name}：${reason}`);
}
function resumeDelivery(state: MergeQueue, batch: QueueBatch, entry: QueueEntry, delivery: Delivery): void {
  const status = readJson<StageStatus>(statusPath(batch.dir, delivery.stage));
  if (!status?.sessionId) throw new Error(`找不到 ${delivery.stage} 的原开发会话，收件箱已保留，未新建会话`);
  if (status.inbox >= delivery.seq) return;
  if (status.pid && status.processStarted && processStartTime(status.pid) === status.processStarted) {
    if (!status.host || status.host === "pi" || hookInputBridgeAvailable(batch.dir, delivery.stage, status)) return;
    throw new Error(`${delivery.stage} 的原宿主仍存活，但没有可核对的原会话输入通道；返修保留在收件箱，未伪称已投递`);
  }
  const argv = [fileURLToPath(import.meta.url), "session", state.dir, entry.id, delivery.stage];
  if ((process.env.AUTOREVIEW_MERGE_QUEUE_LAUNCHER ?? (process.platform === "darwin" ? "terminal" : "background")) === "terminal") {
    // 与流水线相同的 Terminal 入口：恢复原会话 ID，而不是在无 TTY 的日志管道里启动交互式 Pi。
    const env = ["PATH", "HOME", "AUTOREVIEW_MERGE_QUEUE_ROOT", "LOOP_DIR", "PI_BIN", "PI_NODE_BIN", "PERMISSION_EXTENSION", "PONYTAIL_EXTENSION"]
      .filter((key) => process.env[key] !== undefined).map((key) => `${key}=${shellQuote(process.env[key]!)}`).join(" ");
    const script = `${env} ${[process.execPath, ...argv].map(shellQuote).join(" ")}`;
    const result = spawnSync("osascript", ["-e", `tell application "Terminal" to do script ${JSON.stringify(script)}`], { timeout: 15_000 });
    if (result.status !== 0) throw new Error("无法恢复原会话的终端，收件箱已保留");
  } else launch(state.dir, "session", [entry.id, delivery.stage]);
}
async function runDeveloperSession(state: MergeQueue, entry: QueueEntry, stageName: string): Promise<void> {
  const batch = state.batches.find((item) => item.id === entry.batch)!;
  const delivery = entry.deliveries?.find((item) => item.stage === stageName);
  if (!delivery) return;
  const release = lock(state.dir, `session-${hash([batch.id, stageName])}`);
  if (!release) return;
  try {
  const status = readJson<StageStatus>(statusPath(batch.dir, delivery.stage));
  if (!status?.sessionId || status.inbox >= delivery.seq || (status.pid && status.processStarted && processStartTime(status.pid) === status.processStarted)) return;
  const stage = batch.stages.find((item) => item.name === delivery.stage)!;
  let command: string;
  if (status.host && status.host !== "pi") command = [join(HERE, "bin", "loop-dev"), status.host, "--cwd", stage.cwd, "--session", status.sessionId, join(state.dir, `${entry.id}-${delivery.stage.replace(/[^\w\u4e00-\u9fff-]/g, "_")}.repair.md`)].map(shellQuote).join(" ");
  else if (stage.prompt) command = stage.start.replace(shellQuote(stage.prompt), `--session ${shellQuote(status.sessionId)}`);
  else command = [join(HERE, "bin", "pi-dev"), "--cwd", stage.cwd, "--session", status.sessionId].map(shellQuote).join(" ");
  if (status.host && status.host !== "pi") {
    const prompt = join(state.dir, `${entry.id}-${delivery.stage.replace(/[^\w\u4e00-\u9fff-]/g, "_")}.repair.md`);
    writeFileSync(prompt, delivery.message);
  }
  await new Promise<void>((done, fail) => {
    const child = spawn("/bin/sh", ["-c", command], { cwd: stage.cwd, stdio: "inherit", env: {
      ...process.env, AUTOREVIEW_PIPELINE_DIR: batch.dir, AUTOREVIEW_STAGE: stage.name, AUTOREVIEW_BATCH_FILE: batch.file,
      AUTOREVIEW_PIPELINE_LAUNCH: "", AUTOREVIEW_PIPELINE_LAUNCH_TOKEN: "",
    } });
    child.on("error", fail); child.on("exit", () => done());
  });
  } finally { release(); }
}
function deliverReturns(state: MergeQueue, batch: QueueBatch, entry: QueueEntry): void {
  for (const delivery of entry.deliveries ?? []) {
    const path = inboxPath(batch.dir, delivery.stage), old = readJson<InboxMessage>(path);
    if (!delivery.sent) {
      if (old && old.seq >= delivery.seq && old.message !== delivery.message) throw new Error("收件箱已被其他派发占用，未覆盖");
      if (!old || old.seq < delivery.seq) writeJsonAtomic(path, { seq: delivery.seq, message: delivery.message, mustFix: delivery.mustFix });
      delivery.sent = true;
      update(state.dir, entry.id, { deliveries: entry.deliveries });
    }
    if (!delivery.resumed) {
      resumeDelivery(state, batch, entry, delivery);
      delivery.resumed = true;
      update(state.dir, entry.id, { deliveries: entry.deliveries });
    }
  }
  update(state.dir, entry.id, { status: entry.autoStopped ? "stopped" : "returned" });
  if (entry.autoStopped) notify(state, entry, `${entry.name}：${entry.reason}`);
}

export async function runMergeQueue(repo: string, signal?: AbortSignal): Promise<void> {
  const initial = readMergeQueue(repo);
  if (!initial) return;
  const release = lock(initial.dir, "worker");
  if (!release) return;
  let retry = false;
  try {
    const procs = join(initial.dir, "gate.procs.json");
    reapProcs(procs);
    if (readProcs(procs).length) throw new Error("上次队列门禁资源释放未确认，未复用测试工作区");
    for (;;) {
      signal?.throwIfAborted();
      const state = load(initial.dir);
      for (const merged of state.entries.filter((item) => item.status === "merged" && item.automatic && !item.mergeNotified)) finishLegacyMerge(state, state.batches.find((item) => item.id === merged.batch)!, merged);
      const entry = state.entries.filter((item) => ["pending", "testing", "ready", "returning", "merging", "withdrawing"].includes(item.status)).sort((a, b) => a.order - b.order)[0];
      if (!entry) return;
      const batch = state.batches.find((item) => item.id === entry.batch)!;
      if (entry.status === "withdrawing") return; // 撤回意图只由用户的同一命令恢复。
      if (entry.status === "merging") {
        if (!entry.automatic) return; // 手动意图只由用户恢复；自动意图按持久化身份收尾。
        try { await recoverLegacyMerge(state, batch, entry); } catch (error) {
          const fresh = load(state.dir).entries.find((item) => item.id === entry.id)!;
          if (["pending", "blocked"].includes(fresh.status)) continue;
          notify(state, fresh, `${fresh.status === "merging" ? "自动合入待恢复" : "可合入"}：${entry.name}；${String(error)}`); return;
        }
        continue;
      }
      if (entry.status === "returning") { deliverReturns(state, batch, entry); continue; }
      const problem = qualificationProblem(state, batch, entry);
      if (problem) { update(state.dir, entry.id, { status: "blocked", reason: problem }); continue; }
      if (entry.status === "ready") {
        if (gitText(state.repo, ["rev-parse", `refs/heads/${batch.release}`]) === entry.base && entry.runtimeGate === hash(loadGateConfig(batch.project))) {
          if (!entry.notified) { notify(state, entry); update(state.dir, entry.id, { notified: true }); }
          return; // 默认保持旧行为：停在可合入，后续批次不提前测。
        }
      }
      const base = gitText(state.repo, ["rev-parse", `refs/heads/${batch.release}`]);
      Object.assign(entry, { status: "testing", base, result: undefined, tree: undefined, notified: false, attempt: entry.attempt + 1, reason: undefined });
      update(state.dir, entry.id, entry);
      resetWorkspace(state, base);
      let conflict = false;
      for (const source of entry.sources) {
        const merge = gitResult(state.workspace, ["-c", "core.hooksPath=/dev/null", "-c", "rerere.enabled=false", "merge", "--no-ff", "--no-edit", source.commit, "-m", `chore: 合入队列 ${batch.name}`]);
        if (merge.status !== 0) {
          entry.conflicts = testGit(state, ["diff", "--name-only", "--diff-filter=U", "-z"]).split("\0").filter(Boolean);
          resetWorkspace(state, base);
          if (!entry.conflicts.length) throw new Error(`测试工作区合并失败：${merge.stderr || merge.stdout}`);
          entry.conflictKind = "text";
          returnToDeveloper(state, batch, entry, entry.conflicts, "合并冲突，请合进最新发布分支并解决列出的冲突文件");
          conflict = true; break;
        }
      }
      if (conflict) continue;
      entry.result = testGit(state, ["rev-parse", "HEAD"]);
      entry.tree = testGit(state, ["rev-parse", "HEAD^{tree}"]);
      testGit(state, ["update-ref", `refs/loop/queue/${entry.id}/result`, entry.result]);
      update(state.dir, entry.id, { result: entry.result, tree: entry.tree });
      const workDir = resolve(state.workspace, relative(state.repo, batch.project));
      copyTestLocalFiles(state, batch, workDir);
      const gate = loadGateConfig(workDir) ?? loadGateConfig(batch.project);
      if (!gate) throw new Error("项目没有配置 gate，不能宣布可合入；请配置项目门禁后再次触发队列");
      const { createChildExec } = await import("./hosts/review-hook.ts");
      const resource = createRunResource(`merge-queue:${entry.id}`, undefined, procs);
      entry.log = join(state.dir, `${entry.id}-a${entry.attempt}.gate.log`);
      entry.runtimeGate = hash(loadGateConfig(batch.project));
      update(state.dir, entry.id, { log: entry.log, runtimeGate: entry.runtimeGate, gate });
      writeFileSync(entry.log, "");
      let result;
      try {
        result = await createChildExec(procs)("/bin/sh", ["-c", managedShell(gate.cmd, resource)], { cwd: workDir, timeout: gate.timeoutMin * 60_000, signal, role: "合入队列门禁", onOutput: (chunk) => appendFileSync(entry.log!, chunk),
          env: { AUTOREVIEW_BASE_REV: base, AUTOREVIEW_BATCH_FILE: testBatchFile(state, batch), AUTOREVIEW_STAGE: "", AUTOREVIEW_RUN_DIR: state.dir } });
        const output = `${result.stdout}${result.stderr}`;
        writeFileSync(entry.log, output);
        entry.output = output.trimEnd().split(/\r?\n/).slice(-40).join("\n");
        update(state.dir, entry.id, { output: entry.output });
      } finally { releaseRunResource(resource); }
      if (resource.status !== "released" || result.processesReleased !== true) throw new Error("队列门禁资源释放未确认，未发布结果");
      signal?.throwIfAborted();
      // 失败门禁可留下诊断文件或修改跟踪文件：先留输出、恢复测试区，再可靠退回。
      if (result.code !== 0 || result.killed) {
        const paths = testGit(state, ["ls-tree", "-r", "--name-only", "-z", entry.result!]).split("\0").filter((path) => path && `${result.stdout}${result.stderr}`.includes(path));
        resetWorkspace(state, base);
        entry.conflictKind = "integration";
        returnToDeveloper(state, batch, entry, paths, `与已合入批次冲突（本批完成资格中门禁已通过，不记为本批自身缺陷）：项目门禁不通过（退出码 ${result.code}${result.killed ? "，中断或超时" : ""}）`);
        continue;
      }
      // 成功门禁仍不得把修改后的内容冒充测过的提交。
      if (testGit(state, ["status", "--porcelain"]) || testGit(state, ["rev-parse", "HEAD"]) !== entry.result) {
        resetWorkspace(state, base);
        throw new Error("门禁改变了测试工作区；输出保留，不能宣布可合入");
      }
      const latestProblem = qualificationProblem(state, batch, entry);
      if (latestProblem) { update(state.dir, entry.id, { status: "blocked", reason: latestProblem }); continue; }
      if (gitText(state.repo, ["rev-parse", `refs/heads/${batch.release}`]) !== base || entry.runtimeGate !== hash(loadGateConfig(batch.project))) { update(state.dir, entry.id, { status: "pending", reason: "发布分支或门禁配置已经变化，自动重新测试" }); continue; }
      update(state.dir, entry.id, { status: "ready", reason: "门禁通过，等待用户执行 loop 合入" });
    }
  } catch (error) {
    const state = load(initial.dir), entry = state.entries.filter((item) => ["testing", "returning"].includes(item.status)).sort((a, b) => a.order - b.order)[0];
    if (entry) update(state.dir, entry.id, { reason: String(error) });
    throw error;
  } finally {
    release();
    const state = load(initial.dir);
    retry = state.entries.some((entry) => entry.status === "pending") && !state.entries.some((entry) => ["ready", "testing", "returning", "merging", "withdrawing"].includes(entry.status));
    if (retry) kickMergeQueue(state.repo);
  }
}

/** 手动与自动合入共用全部资格、候选与结果核对；调用方已持有执行锁。 */
function mergeLocked(state: MergeQueue, batch: QueueBatch, dryRun: boolean,
  apply: (entry: QueueEntry, save: (patch: Partial<QueueEntry>) => void) => void, automatic = false, entryId?: string): QueueEntry {
    const latest = load(state.dir), entries = latest.entries.filter((item) => item.batch === batch.id);
    // 恢复按原事务 ID，不把后到的完成事件当成已经发布事务的替身。
    const entry = entryId ? entries.find((item) => item.id === entryId) : entries.find((item) => item.status === "merging") ?? entries.at(-1);
    if (!entry) throw new Error("本批尚未完成并通过合入队列门禁，未合入");
    if (automatic && entry.status !== "merging") throw new Error("只允许收尾已持久化的历史自动合入事务");
    if (entry.status === "merged") return entry;
    if (entry.status === "merging" && !dryRun) return publication(state.dir, () => {
      const current = load(state.dir).entries.find((item) => item.id === entry.id);
      if (current?.status !== "merging") throw new Error("合入意图或完成资格已变化，未恢复旧发布");
      const save = (patch: Partial<QueueEntry>) => { Object.assign(current, update(state.dir, current.id, patch)); };
      const head = gitText(state.repo, ["rev-parse", `refs/heads/${batch.release}`]);
      if (head !== current.result) {
        // 升级时 CAS 意图可能停在调用前；发布仍在 base 且运行版索引仍为 base，
        // 可以确认没有待 checkout 的发布结果。只归还资源并转回用户合入，不重发 CAS。
        const legacyUnpublished = automatic && current.runtimePublication === "publishing" && head === current.base
          && gitText(state.repo, ["write-tree"]) === gitText(state.repo, ["rev-parse", `${current.base}^{tree}`]);
        if (current.runtimePublication === "published" || (current.runtimePublication === "publishing" && !legacyUnpublished) || (head !== current.base && current.runtimePublication !== "prepared") || (head !== current.base && current.runtimeStash)) {
          throw new Error("发布分支已经变化；发布结果或资源收尾仍需核对，保留原合入意图");
        }
        if (legacyUnpublished) save({ runtimePublication: "prepared" });
        // 手动与历史自动事务共用：尚未发布时先归还用户的 stash，再检查可能已被撤销的资格。
        if (current.runtimeStash) apply({ ...current, result: current.base, tree: gitText(state.repo, ["rev-parse", `${current.base}^{tree}`]) }, save);
        const problem = qualificationProblem(state, batch, current);
        if (problem) { save({ status: "blocked", reason: problem }); throw new Error(problem); }
        const latestHead = gitText(state.repo, ["rev-parse", `refs/heads/${batch.release}`]);
        const stale = latestHead !== current.base ? "发布分支已经变化"
          : current.runtimeGate && current.runtimeGate !== hash(loadGateConfig(batch.project)) ? "门禁配置已经变化" : undefined;
        if (stale) { save({ status: "pending", notified: false, reason: `${stale}，尚未发布，自动重新测试` }); throw new Error(`${stale}，已安排自动重新测试`); }
        if (automatic) {
          save({ status: "ready", automatic: false, notified: false, pushRequested: false, runtimePublication: "prepared", reason: "自动合入已停用，等待用户执行 loop 合入" });
          return current;
        }
        save({ runtimePublication: "prepared" });
      }
      // HEAD 已是测过的结果时只收尾；新一轮资格不能让已发布事务丢失 checkout/stash 责任。
      apply(current, save);
      return update(state.dir, current.id, { status: "merged", reason: `${automatic ? "自动" : "用户"}合入已恢复完成` });
    });
    if (!["pending", "testing", "ready"].includes(entry.status)) throw new Error(`本批还不可合入：${entry.status}；${entry.reason ?? "等待原会话完成检查"}`);
    const head = gitText(state.repo, ["rev-parse", `refs/heads/${batch.release}`]);
    const stale = entry.base && entry.base !== head ? "发布分支已经变化"
      : entry.runtimeGate && entry.runtimeGate !== hash(loadGateConfig(batch.project)) ? "门禁配置已经变化" : undefined;
    if (stale) {
      if (!dryRun) update(state.dir, entry.id, { status: "pending", notified: false, reason: `${stale}，自动重新测试` });
      throw new Error(`${stale}，本次不合入，已安排自动重新测试`);
    }
    const problem = qualificationProblem(state, batch, entry);
    if (problem) { if (!dryRun) update(state.dir, entry.id, { status: "blocked", reason: problem }); throw new Error(problem); }
    if (entry.status !== "ready" || !entry.result || !entry.tree) throw new Error(`本批还不可合入：${entry.status}；${entry.reason ?? "等待队列门禁"}`);
    if (gitText(state.repo, ["rev-parse", `refs/loop/queue/${entry.id}/result`]) !== entry.result
      || gitText(state.repo, ["rev-parse", `${entry.result}^{tree}`]) !== entry.tree) throw new Error("测过的合并结果身份不符，未合入");
    if (!dryRun) return publication(state.dir, () => {
      const current = load(state.dir).entries.find((item) => item.id === entry.id);
      const identity = (item: QueueEntry) => hash([item.qualification, item.integration, item.integrationEpoch, item.sources, item.base, item.result, item.tree, item.runtimeGate]);
      if (current?.status !== "ready" || identity(current) !== identity(entry)) throw new Error("批次完成资格或测过结果已变化，未取得发布资格");
      const problem = qualificationProblem(state, batch, current);
      if (problem) { update(state.dir, current.id, { status: "blocked", reason: problem }); throw new Error(problem); }
      Object.assign(current, update(state.dir, current.id, { status: "merging", runtimePublication: "prepared", automatic: false }));
      apply(current, (patch) => { Object.assign(current, update(state.dir, current.id, patch)); });
      return update(state.dir, current.id, { status: "merged", reason: "用户已合入测试过的提交" });
    });
    return entry;
}

export async function mergeQueuedBatch(repo: string, batch: QueueBatch, dryRun: boolean,
  apply: (entry: QueueEntry, save: (patch: Partial<QueueEntry>) => void) => void): Promise<QueueEntry> {
  const state = readMergeQueue(repo)!;
  const release = dryRun ? () => {} : lock(state.dir, "worker");
  if (!release) throw new Error("合入队列正在测试或处理其他合入，请稍后查看 loop 状态");
  try { return mergeLocked(state, batch, dryRun, apply); }
  finally { release(); if (!dryRun) kickMergeQueue(repo); }
}

/** 只在发布仍停在本批结果时反向 CAS；复用运行版保护，不推送、不重新合并。 */
export async function withdrawQueuedBatch(repo: string, batch: QueueBatch, dryRun: boolean,
  apply: (entry: QueueEntry, save: (patch: Partial<QueueEntry>) => void, begin: () => void) => void): Promise<QueueEntry> {
  const state = readMergeQueue(repo)!;
  const release = dryRun ? () => {} : lock(state.dir, "worker");
  if (!release) throw new Error("合入队列正在执行，请稍后撤回");
  try {
    const entry = load(state.dir).entries.filter((item) => item.batch === batch.id).at(-1);
    if (!entry || !["merged", "withdrawing", "withdrawn"].includes(entry.status) || !entry.base || !entry.result) throw new Error("本批没有已合入记录，不能撤回");
    if (entry.status === "withdrawn") return entry;
    const head = gitText(state.repo, ["rev-parse", `refs/heads/${batch.release}`]);
    if (head !== entry.result && !(entry.status === "withdrawing" && head === entry.base)) {
      const reason = "发布分支已不在本批合入提交（之后已有其他提交或批次合入），未撤回、未改动 release";
      if (!dryRun) notify(state, entry, `${entry.name}：${reason}`);
      throw new Error(reason);
    }
    if (!dryRun) {
      const reverse = { ...entry, base: entry.result, result: entry.base, tree: gitText(state.repo, ["rev-parse", `${entry.base}^{tree}`]) };
      apply(reverse, (patch) => {
        // ready 只表示本次未发布且临时改动已恢复；拒绝不留下阻塞队列的撤回事务。
        if (patch.status) patch = { ...patch, status: patch.status === "ready" ? "merged" : "withdrawing" };
        Object.assign(reverse, patch); Object.assign(entry, update(state.dir, entry.id, patch));
      }, () => {
        // 运行版真正开始变化前再记意图；纯检查拒绝保持 merged。
        if (entry.status !== "withdrawing") Object.assign(entry, update(state.dir, entry.id, { status: "withdrawing", runtimePublication: "prepared" }));
      });
      const result = update(state.dir, entry.id, { status: "withdrawn", reason: `已撤回到 ${entry.base}；未推送` });
      notify(state, result, `${entry.name}：${result.reason}`);
      return result;
    }
    return entry;
  } finally { release(); }
}

async function main(): Promise<void> {
  const [mode, dir, batchId, stage] = process.argv.slice(2);
  const state = load(resolve(dir));
  const token = process.env.AUTOREVIEW_QUEUE_EXECUTOR_ID;
  const marker = token && /^[0-9a-f-]{36}$/.test(token) ? join(state.dir, `executor-${token}.json`) : undefined;
  if (marker) writeJsonAtomic(marker, { token, mode, target: batchId, pid: process.pid, started: processStartTime(process.pid) });
  let integrateAgain = false;
  try {
  if (mode === "worker") {
    const controller = new AbortController(), cancel = () => controller.abort();
    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, cancel);
    try { await runMergeQueue(state.repo, controller.signal); }
    finally { for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.off(signal, cancel); }
  } else if (mode === "session") {
    const entry = state.entries.find((item) => item.id === batchId);
    if (entry) await runDeveloperSession(state, entry, stage);
  } else if (mode === "integrate") {
      const latest = load(state.dir), batch = latest.batches.find((item) => item.id === batchId)!;
      if (!integrationNeeded(latest, batch)) return;
      const qualification = qualifications(batch);
      if (!qualification) return;
      const attempted = hash(qualification);
      const procs = join(state.dir, `integration-${batchId}.procs.json`);
      reapProcs(procs);
      if (readProcs(procs).length) throw new Error("上次整合编排释放未确认，未重复启动");
      const { createChildExec } = await import("./hosts/review-hook.ts");
      const result = await createChildExec(procs)(process.execPath, [join(HERE, "pipeline.ts"), batch.file, "--from", "验收", "--project-root", batch.project, "--default-workspace", "dev分支"],
        { cwd: state.repo, timeout: 24 * 60 * 60_000, role: "队列返修后整合编排" });
      if (result.code !== 0) console.error(result.stderr || result.stdout);
      // 仅正常收尾过的运行可以立即接新资格；崩溃/入口失败保留待恢复资格，等下一次状态或 done 重试。
      integrateAgain = load(state.dir).batches.find((item) => item.id === batchId)!.lastRunQualification === attempted;
  } else throw new Error("未知队列执行模式");
  } finally {
    if (marker && readJson<LockOwner>(marker)?.pid === process.pid) rmSync(marker, { force: true });
    if (mode === "integrate" && integrateAgain) maybeIntegrate(state.dir, batchId);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main().catch((error) => { console.error(error); process.exitCode = 1; });
