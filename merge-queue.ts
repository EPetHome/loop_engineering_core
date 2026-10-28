/** 本机合入队列。只有 loop 开工登记的 git 批次参与；执行器不依赖开发宿主。 */
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, closeSync, cpSync, existsSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { loadGateConfig, loadProjectLayout } from "./config.ts";
import { hookInputBridgeAvailable } from "./hosts/inbox-bridge.ts";
import { inboxPath, readJson, statusPath, writeJsonAtomic, writeStageStatus, type InboxMessage, type StageStatus } from "./pipeline-core.ts";
import { processStartTime, readProcs, reapProcs } from "./procs.ts";
import { createRunResource, managedShell, releaseRunResource } from "./resources.ts";
import { inScope, type StageScope } from "./scope.ts";
import { loadContext } from "./project-context.ts";
import { gitResult, gitText, shellQuote, worktrees } from "./workspace.ts";

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
}
interface Source { branch: string; cwd: string; head: string; tree: string; commit: string }
interface Qualification { stage: string; session: string; epoch: string; inbox: number; sourceInputs?: string }
interface Delivery { stage: string; seq: number; message: string; mustFix: string; sent?: boolean; resumed?: boolean }
export interface QueueEntry {
  id: string; batch: string; name: string; order: number; status: "pending" | "testing" | "ready" | "returning" | "returned" | "blocked" | "merging" | "merged";
  createdAt: string; updatedAt: string; qualification: Qualification[]; sources: Source[];
  base?: string; result?: string; tree?: string; attempt: number; log?: string; output?: string; reason?: string; gate?: { cmd: string; timeoutMin: number };
  conflicts?: string[]; deliveries?: Delivery[]; notified?: boolean; runtimeGate?: string; runtimeStash?: { ref: string; hash: string };
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
function change<T>(dir: string, fn: (state: MergeQueue) => T): T {
  const release = lock(dir, "record", true);
  if (!release) throw new Error("合入队列记录正在写入，请稍后重试");
  try { const state = load(dir), result = fn(state); writeJsonAtomic(statePath(dir), state); return result; }
  finally { release(); }
}
function update(dir: string, id: string, patch: Partial<QueueEntry>): QueueEntry {
  return change(dir, (state) => {
    const entry = state.entries.find((item) => item.id === id);
    if (!entry) throw new Error("队列条目已不存在");
    Object.assign(entry, patch, { updatedAt: stamp() }); return entry;
  });
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
    const batch: QueueBatch = { ...value, file: canonical(value.file), dir: canonical(value.dir), project: canonical(value.project),
      stages: value.stages.map((stage) => ({ ...stage, cwd: canonical(stage.cwd) })),
      id: hash([value.name, value.stages.map((stage) => [stage.name, stage.branch])]) };
    for (const stage of batch.stages) {
      const top = realpathSync(gitText(stage.cwd, ["rev-parse", "--show-toplevel"]));
      if (top === repo || commonDir(top) !== common || overlaps(top, dir)) throw new Error(`合入队列只接收独立的本仓库开发 worktree：${stage.cwd}`);
    }
    const previous = state.batches.find((item) => item.id === batch.id);
    if (previous) Object.assign(previous, batch); else state.batches.push(batch);
    writeJsonAtomic(statePath(dir), state);
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
  const top = gitText(cwd, ["rev-parse", "--show-toplevel"]);
  const project = loadProjectLayout(cwd);
  const index = join(state.dir, `index-${randomUUID()}`);
  const env = { ...process.env, GIT_INDEX_FILE: index };
  const run = (args: string[]): string => {
    const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: top, env, encoding: "utf8", timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
    if (result.status !== 0) throw new Error(`冻结批次失败：${result.stderr || result.stdout || result.error}`);
    return result.stdout.trim();
  };
  try {
    const head = run(["rev-parse", "HEAD"]);
    run(["read-tree", head]);
    run(["add", "-A", "--", "."]);
    for (const file of project.layout.localFiles) {
      const path = relative(top, resolve(project.root, file));
      if (within(top, resolve(top, path))) run(["reset", "-q", head, "--", path]);
    }
    const tree = run(["write-tree"]);
    if (run(["rev-parse", "HEAD"]) !== head) throw new Error("冻结批次期间分支已变化，请在完成后重试");
    return { head, tree };
  } finally { rmSync(index, { force: true }); rmSync(`${index}.lock`, { force: true }); }
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
    result.push({ stage: stage.name, session: status.sessionId, epoch: status.readyEpoch, inbox: status.inbox, sourceInputs: status.sourceInputs });
  }
  return result;
}
function enqueue(dir: string, batchId: string, requireE2e: boolean): boolean {
  return change(dir, (state) => {
    const batch = state.batches.find((item) => item.id === batchId)!;
    if (batch.stages.length > 1 && !requireE2e) return false;
    const qualification = qualifications(batch);
    if (!qualification) return false;
    const signature = hash(qualification);
    if (state.entries.some((entry) => entry.batch === batchId && hash(entry.qualification) === signature)) return false;
    // 同一批次的新完成资格取代旧候选；旧的失败记录继续保留。
    for (const entry of state.entries) if (entry.batch === batchId && ["pending", "testing", "ready", "blocked"].includes(entry.status)) {
      entry.status = "blocked"; entry.reason = "本批已有新的完成资格";
    }
    const id = randomUUID(), sources: Source[] = [];
    for (const stage of batch.stages) {
      if (sources.some((source) => source.branch === stage.branch)) continue;
      if (gitText(stage.cwd, ["branch", "--show-current"]) !== stage.branch) throw new Error(`批次工作区分支已变化：${stage.cwd}`);
      const snapshot = sourceTree(state, stage.cwd);
      const commit = snapshot.tree === gitText(state.repo, ["rev-parse", `${snapshot.head}^{tree}`]) ? snapshot.head
        : gitText(state.repo, ["-c", "core.hooksPath=/dev/null", "commit-tree", snapshot.tree, "-p", snapshot.head, "-m", `chore: 合入候选快照\n\n批次：${batch.name}`]);
      gitText(state.repo, ["-c", "core.hooksPath=/dev/null", "update-ref", `refs/loop/queue/${id}/source-${sources.length}`, commit]);
      sources.push({ cwd: stage.cwd, branch: stage.branch, ...snapshot, commit });
    }
    state.entries.push({ id, batch: batchId, name: batch.name, qualification, sources, order: state.nextOrder++, status: "pending", attempt: 0, createdAt: stamp(), updatedAt: stamp() });
    return true;
  });
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
    if (batch.stages.length === 1) enqueue(state.dir, batch.id, false);
    else maybeIntegrate(state.dir, batch.id);
  }
  if (options.status.event === "done" || state.entries.some((entry) => entry.batch === batch.id && ["pending", "testing", "ready"].includes(entry.status))) kickMergeQueue(state.repo);
}
export function queueBatchComplete(repo: string, file: string, e2ePassed: boolean): void {
  const batch = registeredQueueBatch(repo, file);
  if (!batch || (batch.stages.length > 1 && !e2ePassed)) return;
  enqueue(queueDir(repo), batch.id, e2ePassed);
  kickMergeQueue(repo);
}

function launch(dir: string, mode: string, extra: string[] = []): void {
  const fd = openSync(join(dir, "worker.log"), "a", 0o600), token = randomUUID();
  const marker = join(dir, `executor-${token}.json`);
  writeJsonAtomic(marker, { token, mode, pid: 0, started: "" });
  const finished = () => { if (readJson<LockOwner>(marker)?.token === token) rmSync(marker, { force: true }); };
  try {
    // 队列/恢复会话是独立消费者；不能继承已完成流水线的归属标记而被其收尾误杀。
    const env: NodeJS.ProcessEnv = { ...process.env, AUTOREVIEW_PIPELINE_LAUNCH_TOKEN: "", AUTOREVIEW_QUEUE_EXECUTOR_ID: token };
    for (const key of ["AUTOREVIEW_PROCESS_OWNER", "AUTOREVIEW_RUN_ID", "AUTOREVIEW_TEMP_DIR", "AUTOREVIEW_EVIDENCE_DIR", "AUTOREVIEW_RUN_DIR"]) delete env[key];
    if (process.env.AUTOREVIEW_RUN_ID) delete env.TMPDIR;
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), mode, dir, ...extra], {
      cwd: dir, detached: true, stdio: ["ignore", fd, fd], env,
    });
    if (child.pid) writeJsonAtomic(marker, { token, mode, pid: child.pid, started: processStartTime(child.pid) });
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
function maybeIntegrate(dir: string, batchId: string): void {
  const state = load(dir), batch = state.batches.find((item) => item.id === batchId)!;
  const entry = state.entries.filter((item) => item.batch === batchId).at(-1);
  if (batch.stages.length < 2 || !entry || entry.status !== "returned" || !qualifications(batch)) return;
  if (entry.deliveries?.some((item) => !item.sent)) return;
  launch(dir, "integrate", [batchId]);
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
  const currentQualification = qualifications(batch);
  if (!currentQualification || hash(currentQualification) !== hash(entry.qualification)) return "批次完成资格已变化，需要原开发会话重新完成检查";
  for (const source of entry.sources) {
    if (gitText(source.cwd, ["branch", "--show-current"]) !== source.branch) return "批次工作区已切换分支";
    const current = sourceTree(state, source.cwd);
    if (current.head !== source.head || current.tree !== source.tree) return "批次候选已变化，需要原开发会话重新完成门禁和评审";
  }
  return undefined;
}
function notify(state: MergeQueue, entry: QueueEntry): void {
  const message = `可合入：${entry.name}；请执行 loop 合入 ${state.batches.find((item) => item.id === entry.batch)!.file}`;
  writeFileSync(join(state.dir, `${entry.id}.notification.txt`), `${message}\n`);
  if (process.platform === "darwin") spawnSync("osascript", ["-e", `display notification ${JSON.stringify(message)} with title "Loop 合入队列"`], { timeout: 15_000 });
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
  const deliveries: Delivery[] = [];
  for (const [stage, target] of targets) {
    const old = readJson<InboxMessage>(inboxPath(batch.dir, stage));
    const status = readJson<StageStatus>(statusPath(batch.dir, stage));
    // 不覆盖尚未消费的流水线返修。
    if (old && (status?.inbox ?? 0) < old.seq) throw new Error(`${stage} 尚有未消费的收件箱消息，保留失败记录，稍后重试退回`);
    const mustFix = `${reason}\n文件：${target.files.join("、") || "未能从门禁输出定位失败文件"}\n${target.fallback ? `无法唯一确定文件归属，退回最后一段「${last}」。\n` : ""}`;
    deliveries.push({ stage, seq: Math.max(old?.seq ?? 0, status?.inbox ?? 0) + 1, mustFix,
      message: `【合入队列返修】\n批次：${batch.name}\n发布分支：${batch.release}（${entry.base}）\n${mustFix}\n${entry.output ?? ""}\n完整门禁日志：${entry.log ?? "（合并冲突，未运行门禁）"}\n请先合进最新发布分支 ${batch.release}，解决冲突或修复失败，定向自检后重走门禁和评审；最后一行写【交付完成】。完成后自动回到队尾。` });
  }
  update(state.dir, entry.id, { status: "returning", reason, conflicts: entry.conflicts, deliveries });
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
  update(state.dir, entry.id, { status: "returned" });
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
      const entry = state.entries.filter((item) => ["pending", "testing", "ready", "returning", "merging"].includes(item.status)).sort((a, b) => a.order - b.order)[0];
      if (!entry) return;
      const batch = state.batches.find((item) => item.id === entry.batch)!;
      if (entry.status === "merging") return; // 用户合入中断，只能由下一次用户合入恢复运行版。
      if (entry.status === "returning") { deliverReturns(state, batch, entry); continue; }
      const problem = qualificationProblem(state, batch, entry);
      if (problem) { update(state.dir, entry.id, { status: "blocked", reason: problem }); continue; }
      if (entry.status === "ready") {
        if (gitText(state.repo, ["rev-parse", `refs/heads/${batch.release}`]) === entry.base && entry.runtimeGate === hash(loadGateConfig(batch.project))) {
          if (!entry.notified) { notify(state, entry); update(state.dir, entry.id, { notified: true }); }
          return; // 等用户合入，后续批次不提前测。
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
      const { createChildExec } = await import("./hosts/hook.ts");
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
        returnToDeveloper(state, batch, entry, paths, `项目门禁不通过（退出码 ${result.code}${result.killed ? "，中断或超时" : ""}）`);
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
    retry = state.entries.some((entry) => entry.status === "pending") && !state.entries.some((entry) => ["ready", "testing", "returning", "merging"].includes(entry.status));
    if (retry) kickMergeQueue(state.repo);
  }
}

/** 唯一修改发布分支的调用方是 loop 合入；持有同一执行锁直到恢复运行版未提交改动。 */
export async function mergeQueuedBatch(repo: string, batch: QueueBatch, dryRun: boolean,
  apply: (entry: QueueEntry, save: (patch: Partial<QueueEntry>) => void) => void): Promise<QueueEntry> {
  const state = readMergeQueue(repo)!;
  const release = dryRun ? () => {} : lock(state.dir, "worker");
  if (!release) throw new Error("合入队列正在测试或处理其他合入，请稍后查看 loop 状态");
  try {
    const latest = load(state.dir);
    const entry = latest.entries.filter((item) => item.batch === batch.id).at(-1);
    if (!entry) throw new Error("本批尚未完成并通过合入队列门禁，未合入");
    if (entry.status === "merged") return entry;
    if (entry.status === "merging" && !dryRun) {
      apply(entry, (patch) => { Object.assign(entry, update(state.dir, entry.id, patch)); });
      return update(state.dir, entry.id, { status: "merged", reason: "用户合入已恢复完成" });
    }
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
    if (!dryRun) {
      update(state.dir, entry.id, { status: "merging" });
      apply(entry, (patch) => { Object.assign(entry, update(state.dir, entry.id, patch)); });
      return update(state.dir, entry.id, { status: "merged", reason: "用户已合入测试过的提交" });
    }
    return entry;
  } finally { release(); if (!dryRun) kickMergeQueue(repo); }
}

async function main(): Promise<void> {
  const [mode, dir, batchId, stage] = process.argv.slice(2);
  const state = load(resolve(dir));
  const token = process.env.AUTOREVIEW_QUEUE_EXECUTOR_ID;
  const marker = token && /^[0-9a-f-]{36}$/.test(token) ? join(state.dir, `executor-${token}.json`) : undefined;
  if (marker) writeJsonAtomic(marker, { token, mode, pid: process.pid, started: processStartTime(process.pid) });
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
    const release = lock(state.dir, `integration-${batchId}`);
    if (!release) return;
    try {
      const latest = load(state.dir), batch = latest.batches.find((item) => item.id === batchId)!;
      const entry = latest.entries.filter((item) => item.batch === batchId).at(-1);
      if (!entry || entry.status !== "returned" || !qualifications(batch)) return;
      const procs = join(state.dir, `integration-${batchId}.procs.json`);
      reapProcs(procs);
      if (readProcs(procs).length) throw new Error("上次整合编排释放未确认，未重复启动");
      const { createChildExec } = await import("./hosts/hook.ts");
      const result = await createChildExec(procs)(process.execPath, [join(HERE, "pipeline.ts"), batch.file, "--from", "e2e", "--project-root", batch.project, "--default-workspace", "dev分支"],
        { cwd: state.repo, timeout: 24 * 60 * 60_000, role: "队列返修后整合编排" });
      if (result.code !== 0) console.error(result.stderr || result.stdout);
    } finally { release(); }
  } else throw new Error("未知队列执行模式");
  } finally { if (marker && readJson<LockOwner>(marker)?.pid === process.pid) rmSync(marker, { force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main().catch((error) => { console.error(error); process.exitCode = 1; });
