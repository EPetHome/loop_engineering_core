#!/usr/bin/env node
/**
 * loop.ts — bin/loop 的实现：开工、启动、状态、合入。
 *
 * 所有子命令支持 --dry-run（只核对、只打印，不改文件或分支）和 --json（标准输出一个 JSON 对象）。
 * 只做本地操作，不推送；开发方不提交，段完成时由流水线按分支名生成提交说明。
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectLayout, workspacePath, type ProjectLayout } from "./config.ts";
import { runMethodsSelfTest, type MethodsRunResult } from "./methods.ts";
import { parsePlan, type Plan } from "./pipeline.ts";
import { readJson, statusPath } from "./pipeline-core.ts";
import type { StageStatus } from "./pipeline-core.ts";
import {
  branchExists, checkBranchName, commitAll, currentBranch, gitResult, gitText, isClean, shellQuote,
  stageCommitMessage, worktreeForBranch, worktrees, type CommitResult,
} from "./workspace.ts";

const LOOP_ROOT = dirname(fileURLToPath(import.meta.url));
const LOOP_BIN = join(LOOP_ROOT, "bin", "loop");
const PIPELINE = join(LOOP_ROOT, "pipeline.ts");

export class LoopError extends Error {
  data: Record<string, unknown>;
  constructor(message: string, data: Record<string, unknown> = {}) { super(message); this.data = data; }
}

interface ParsedArgs { command?: string; batch?: string; json: boolean; dryRun: boolean; recheck: boolean; launcher?: string; rest: string[] }

export function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = { json: false, dryRun: false, recheck: false, rest: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") result.json = true;
    else if (arg === "--dry-run") result.dryRun = true;
    else if (arg === "--recheck") result.recheck = true;
    else if (arg === "--launcher") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) throw new LoopError("--launcher 需要一个值（terminal 或 background）");
      result.launcher = value; i += 1;
    } else if (arg.startsWith("--")) throw new LoopError(`未知选项：${arg}`);
    else if (!result.command) result.command = arg;
    else if (!result.batch) result.batch = arg;
    else result.rest.push(arg);
  }
  return result;
}

interface Repo { root: string; projectRoot: string; layout: ProjectLayout }

export function repoOf(cwd: string): Repo {
  const res = gitResult(cwd, ["rev-parse", "--show-toplevel"]);
  if (res.status !== 0 || !res.stdout.trim()) throw new LoopError(`当前目录不是 git 仓库：${cwd}（${(res.stderr || res.stdout).trim().slice(-300)}）`);
  const root = res.stdout.trim();
  const project = loadProjectLayout(root);
  return { root, projectRoot: project.root, layout: project.layout };
}

const readBatch = (path: string): Record<string, unknown> => {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, "utf8")); } catch (error) { throw new LoopError(`无法读取批次文件 ${path}：${(error as Error).message}`); }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new LoopError(`批次文件必须是 JSON 对象：${path}`);
  return raw as Record<string, unknown>;
};

const text = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !value.trim()) throw new LoopError(`${label} 必须是非空字符串`);
  return value.trim();
};

interface WorkspaceUse {
  name: string;
  path: string;
  branch: string;
  explicit: boolean;
  stages: string[];
  exists: boolean;
  registered: boolean;
}

interface BatchPlan {
  raw: Record<string, unknown>;
  path: string;
  planDir: string;
  plan: Plan;
  branch?: string;
  /** 开工要创建或切换的工作区。 */
  workspaces: WorkspaceUse[];
  /** 段里显式写了 cwd 的本仓库 worktree：不创建，但同样核对脏改动和分支。 */
  checks: WorkspaceUse[];
  stages: Map<string, { branch?: string; workspace?: string; cwd: string; prompt?: string }>;
}

/** 把 workspace 名字换成绝对 cwd；批次文件可以只写工作区名字。 */
function normalizedRaw(repo: Repo, raw: Record<string, unknown>): Record<string, unknown> {
  const copy = structuredClone(raw);
  if (copy.stages === null || typeof copy.stages !== "object" || Array.isArray(copy.stages)) throw new LoopError("批次文件的 stages 必须是对象");
  for (const [name, value] of Object.entries(copy.stages as Record<string, unknown>)) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new LoopError(`stages.${name} 必须是对象`);
    const stage = value as Record<string, unknown>;
    if (stage.cwd !== undefined && stage.workspace !== undefined) throw new LoopError(`stages.${name} 的 cwd 和 workspace 只能写一个`);
    if (stage.cwd === undefined) {
      const workspace = stage.workspace === undefined ? "dev分支" : text(stage.workspace, `stages.${name}.workspace`);
      stage.cwd = workspacePath(repo.projectRoot, repo.layout, workspace);
      // parsePlan 只认绝对 cwd；workspace 名字已经换算过。
      delete stage.workspace;
    }
  }
  return copy;
}

export function loadBatch(repo: Repo, path: string): BatchPlan {
  const absolute = resolve(path);
  const raw = readBatch(absolute);
  const planDir = dirname(absolute);
  const normalized = normalizedRaw(repo, raw);
  const plan = parsePlan(normalized, planDir, process.env, { batchFile: absolute });
  const branch = raw.branch === undefined ? undefined : text(raw.branch, "branch");
  const stages = new Map<string, { branch?: string; workspace?: string; cwd: string; prompt?: string }>();
  const byPath = new Map<string, WorkspaceUse>();
  const checksByPath = new Map<string, WorkspaceUse>();
  const knownWorktrees = worktrees(repo.root);
  for (const [name, value] of Object.entries(raw.stages as Record<string, unknown>)) {
    const stage = value as Record<string, unknown>;
    const workspace = stage.workspace === undefined ? "dev分支" : text(stage.workspace, `stages.${name}.workspace`);
    const stageBranch = stage.branch === undefined ? branch : text(stage.branch, `stages.${name}.branch`);
    const explicit = stage.cwd !== undefined;
    const pathValue = explicit ? resolve(planDir, text(stage.cwd, `stages.${name}.cwd`))
      : (repo.layout.workspaces[workspace] ?? workspacePath(repo.projectRoot, repo.layout, workspace));
    const planned = plan.stages.get(name)!;
    stages.set(name, { ...(stageBranch ? { branch: stageBranch } : {}), ...(stage.workspace === undefined ? {} : { workspace }), cwd: planned.cwd, ...(planned.prompt ? { prompt: planned.prompt } : {}) });
    if (explicit) {
      const registered = knownWorktrees.find((item) => resolve(item.path) === resolve(pathValue));
      if (!registered) continue;
      const key = resolve(registered.path);
      const branch = stageBranch ?? "";
      const existing = checksByPath.get(key);
      if (existing) {
        if (branch && existing.branch !== branch) throw new LoopError(`显式 cwd ${pathValue} 里的段要求不同分支：${existing.branch} 和 ${branch}`);
        existing.stages.push(name);
      } else checksByPath.set(key, { name, path: key, branch, explicit: true, stages: [name], exists: true, registered: true });
      continue;
    }
    const key = resolve(pathValue);
    const existing = byPath.get(key);
    if (existing) {
      if (stageBranch && existing.branch !== stageBranch) throw new LoopError(`工作区 ${workspace} 里的段要求不同分支：${existing.branch} 和 ${stageBranch}`);
      existing.stages.push(name);
    } else byPath.set(key, { name: workspace, path: key, branch: stageBranch ?? "", explicit: false, stages: [name], exists: existsSync(key), registered: false });
  }
  return { raw, path: absolute, planDir, plan, ...(branch ? { branch } : {}), workspaces: [...byPath.values()], checks: [...checksByPath.values()], stages };
}

const branchOfStage = (batch: BatchPlan, stage: string): string | undefined => batch.stages.get(stage)?.branch ?? batch.branch;

function startCommand(batch: BatchPlan): string {
  return `${shellQuote(LOOP_BIN)} 启动 ${shellQuote(batch.path)}`;
}

function checkClean(repo: Repo, workspace: WorkspaceUse): void {
  const res = gitResult(workspace.path, ["status", "--porcelain", "-z"]);
  if (res.status !== 0) throw new LoopError(`无法读取开发空间状态：${workspace.path}（${(res.stderr || res.stdout).trim().slice(-300)}）`);
  if (res.stdout !== "") {
    const files = res.stdout.split("\0").filter(Boolean).join("、");
    throw new LoopError(`开发空间有未提交改动，未继续：${workspace.path}；${files}`, { workspace: workspace.path, files });
  }
}

function checkRuntime(repo: Repo, dryRun: boolean): void {
  const branch = currentBranch(repo.root);
  if (branch !== repo.layout.release) {
    throw new LoopError(`运行版必须停在发布分支 ${repo.layout.release}，现在是 ${branch ?? "detached"}`, { branch, release: repo.layout.release });
  }
  const res = gitResult(repo.root, ["status", "--porcelain", "-z"]);
  if (res.status !== 0) throw new LoopError(`无法读取运行版状态：${(res.stderr || res.stdout).trim().slice(-300)}`);
  if (res.stdout !== "") {
    const files = res.stdout.split("\0").filter(Boolean).join("、");
    throw new LoopError(`运行版有未提交改动，未继续：${repo.root}；${files}`, { files, dryRun });
  }
}

function checkIgnored(repo: Repo, layout: ProjectLayout): void {
  for (const path of layout.localFiles) {
    const absolute = resolve(repo.projectRoot, path);
    const rel = relative(repo.root, absolute);
    if (rel.startsWith("..")) throw new LoopError(`localFiles 不在仓库里：${path}`);
    const ignored = gitResult(repo.root, ["check-ignore", "-q", "--", rel]);
    if (ignored.status !== 0) throw new LoopError(`localFiles 没有被 git 忽略：${path}；先写进 .gitignore 或 .git/info/exclude`);
  }
}

function ensureWorktree(repo: Repo, workspace: WorkspaceUse): string {
  const registered = worktrees(repo.root).find((item) => resolve(item.path) === workspace.path);
  workspace.registered = Boolean(registered);
  if (registered) {
    if (registered.branch && registered.branch !== workspace.branch && !isClean(workspace.path)) checkClean(repo, workspace);
    if (registered.branch !== workspace.branch) {
      if (branchExists(repo.root, workspace.branch)) gitText(workspace.path, ["checkout", workspace.branch], `切换到分支 ${workspace.branch}`);
      else gitText(workspace.path, ["checkout", "-b", workspace.branch, repo.layout.release], `从 ${repo.layout.release} 新建分支 ${workspace.branch}`);
    }
    return "已存在";
  }
  if (existsSync(workspace.path)) {
    throw new LoopError(`开发空间路径已存在，但不是这个仓库的 worktree：${workspace.path}；不覆盖，请先确认归属`);
  }
  const parent = dirname(workspace.path);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
  if (branchExists(repo.root, workspace.branch)) {
    gitText(repo.root, ["worktree", "add", workspace.path, workspace.branch], `git worktree add ${workspace.path} ${workspace.branch}`);
  } else {
    gitText(repo.root, ["worktree", "add", "-b", workspace.branch, workspace.path, repo.layout.release],
      `git worktree add -b ${workspace.branch} ${workspace.path} ${repo.layout.release}`);
  }
  workspace.registered = true;
  return "新建";
}

/** 切换/创建分支之前先看目标提交里有没有这些本机路径，避免 checkout 覆盖被忽略的本地文件。 */
function checkTargetLocalPaths(repo: Repo, workspace: WorkspaceUse): void {
  const target = branchExists(repo.root, workspace.branch) ? workspace.branch : repo.layout.release;
  const listed = gitText(repo.root, ["ls-tree", "-r", "--name-only", "-z", target]).split("\0").filter(Boolean);
  const projectRel = relative(repo.root, repo.projectRoot);
  for (const path of repo.layout.localFiles) {
    const rel = relative(workspace.path, resolve(workspace.path, projectRel, path));
    if (!rel || rel.startsWith("..")) continue;
    if (listed.some((item) => item === rel || item.startsWith(`${rel}/`) || rel.startsWith(`${item}/`))) {
      throw new LoopError(`目标分支 ${target} 已跟踪本机文件 ${rel}；切换会覆盖被忽略的本地文件，未继续`);
    }
  }
}

/** 目标工作区也必须忽略这些本机文件，且没有把它们纳入版本控制。 */
function checkLocalFilesTarget(repo: Repo, workspace: WorkspaceUse): void {
  const root = gitText(workspace.path, ["rev-parse", "--show-toplevel"]);
  const projectRel = relative(repo.root, repo.projectRoot);
  for (const path of repo.layout.localFiles) {
    const rel = relative(root, resolve(workspace.path, projectRel, path));
    if (!rel || rel.startsWith("..")) throw new LoopError(`localFiles 不在开发空间里：${path} → ${workspace.path}`);
    const tracked = gitResult(workspace.path, ["ls-files", "--error-unmatch", "--", rel]);
    if (tracked.status === 0) throw new LoopError(`localFiles 在目标工作区已被 git 跟踪：${path}；不复制本机文件`);
    const ignored = gitResult(workspace.path, ["check-ignore", "-q", "--", rel]);
    if (ignored.status !== 0) throw new LoopError(`目标工作区没有忽略 localFiles：${path}；不复制本机文件，请把忽略规则提交到该分支`);
  }
}

function copyLocalFiles(repo: Repo, workspace: WorkspaceUse): string[] {
  const copied: string[] = [];
  const projectRel = relative(repo.root, repo.projectRoot);
  for (const path of repo.layout.localFiles) {
    const source = resolve(repo.projectRoot, path);
    const target = resolve(workspace.path, projectRel, path);
    if (!existsSync(source) || existsSync(target)) continue;
    const info = lstatSync(source);
    mkdirSync(dirname(target), { recursive: true });
    if (info.isDirectory()) cpSync(source, target, { recursive: true });
    else copyFileSync(source, target);
    copied.push(path);
  }
  return copied;
}

function methodsSummary(result: MethodsRunResult): Record<string, unknown> {
  return {
    skipped: result.skipped,
    changed: result.changed,
    fingerprint: result.fingerprint,
    ...(result.selfCheck ? { selfCheck: result.selfCheck } : {}),
    ...(result.baseline ? { baseline: result.baseline } : {}),
    written: result.written,
  };
}

function methodsLines(result: MethodsRunResult): string[] {
  if (result.skipped) return ["方法自测：指纹未变，跳过方法自测"];
  const lines = [`方法自测：执行一次（${result.changed.length ? result.changed.join("；") : "强制重新自测"}）`];
  if (result.selfCheck) lines.push(`  selfCheck：通过（${result.selfCheck.command}）`);
  if (result.baseline) lines.push(`  基线空跑门禁：${result.baseline.cached ? "树已在缓存里，跳过" : "通过"}`);
  if (result.written) lines.push("  methods.json 已更新");
  return lines;
}

async function cmdOpen(args: ParsedArgs): Promise<Record<string, unknown>> {
  if (!args.batch) throw new LoopError("用法：loop 开工 <批次.json> [--dry-run] [--json] [--recheck]");
  const repo = repoOf(process.cwd());
  const batch = loadBatch(repo, args.batch);
  if (!batch.branch && ![...batch.stages.values()].some((stage) => stage.branch)) throw new LoopError("批次.json 的 branch 必须写 <类型>/<描述>");
  const branchOwners = new Map<string, string>();
  for (const workspace of [...batch.workspaces, ...batch.checks]) {
    if (!workspace.branch) {
      if (batch.workspaces.includes(workspace)) throw new LoopError(`工作区 ${workspace.name} 的段没有指定分支`);
      continue;
    }
    checkBranchName(workspace.branch);
    const owner = branchOwners.get(workspace.branch);
    if (owner && owner !== workspace.path) {
      throw new LoopError(`两个开发空间不能检出同一个分支 ${workspace.branch}：${owner} 和 ${workspace.path}；并行时给每段写自己的 branch`);
    }
    branchOwners.set(workspace.branch, workspace.path);
  }
  // 先只核对，任何一项不过都不建 worktree、不切分支。
  checkRuntime(repo, args.dryRun);
  checkIgnored(repo, repo.layout);
  for (const workspace of batch.workspaces) {
    const rel = relative(repo.root, workspace.path);
    if (rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"))) {
      throw new LoopError(`开发空间不能是运行版本身或嵌套在运行版里：${workspace.path}；worktree 要放在运行版目录外`);
    }
    const registered = worktrees(repo.root).find((item) => resolve(item.path) === workspace.path);
    workspace.registered = Boolean(registered);
    if (registered) checkClean(repo, workspace);
    else if (existsSync(workspace.path)) throw new LoopError(`开发空间路径已存在，但不是这个仓库的 worktree：${workspace.path}；不覆盖，请先确认归属`);
    const holder = worktreeForBranch(repo.root, workspace.branch);
    if (holder && resolve(holder.path) !== workspace.path) {
      throw new LoopError(`分支 ${workspace.branch} 已经在另一个 worktree 检出：${holder.path}`);
    }
    checkTargetLocalPaths(repo, workspace);
  }
  for (const check of batch.checks) {
    if (!existsSync(check.path)) throw new LoopError(`段 ${check.stages.join("、")} 的 cwd 不存在：${check.path}`);
    checkClean(repo, check);
    if (check.branch && currentBranch(check.path) !== check.branch) {
      throw new LoopError(`段 ${check.stages.join("、")} 的目录在分支 ${currentBranch(check.path) ?? "detached"}，批次要求 ${check.branch}；未开工`);
    }
  }
  const lines = [
    `运行版：${repo.root}（发布分支 ${repo.layout.release}，工作区干净）`,
    `批次：${batch.plan.name}${batch.branch ? `，分支 ${batch.branch}` : ""}`,
  ];
  const resultWorkspaces: Record<string, unknown>[] = [];
  let primary: string | undefined = batch.workspaces[0]?.path ?? batch.checks[0]?.path ?? [...batch.stages.values()].find((stage) => existsSync(stage.cwd))?.cwd;
  for (const workspace of batch.workspaces) {
    let action = workspace.exists ? "已存在" : "将新建";
    if (!args.dryRun) {
      action = ensureWorktree(repo, workspace);
      checkLocalFilesTarget(repo, workspace);
    } else if (workspace.exists) checkLocalFilesTarget(repo, workspace);
    const copied = args.dryRun ? [] : copyLocalFiles(repo, workspace);
    lines.push(`开发空间：${workspace.name} → ${workspace.path}（${action}）；分支 ${workspace.branch}${copied.length ? `；已复制本机文件 ${copied.join("、")}` : ""}`);
    resultWorkspaces.push({ name: workspace.name, path: workspace.path, branch: workspace.branch, action, localFiles: copied });
  }
  let methods: Record<string, unknown>;
  if (!primary) {
    methods = { skipped: false, changed: ["没有可用的开发空间"], written: false };
    lines.push("方法自测：没有可用的开发空间，未执行");
  } else if (!existsSync(primary)) {
    methods = { skipped: false, changed: ["开发空间尚未建立"], written: false, planned: true };
    lines.push("方法自测：开发空间尚未建立，开工后执行");
  } else {
    const run = runMethodsSelfTest(primary, { loopRoot: LOOP_ROOT, recheck: args.recheck, dryRun: args.dryRun, env: process.env });
    methods = methodsSummary(run);
    lines.push(...methodsLines(run));
  }
  const start = startCommand(batch);
  lines.push(`启动：${start}`);
  return { ok: true, command: "开工", dryRun: args.dryRun, repo: repo.root, release: repo.layout.release,
    batch: batch.plan.name, branch: batch.branch, workspaces: resultWorkspaces, localFiles: repo.layout.localFiles, methods, startCommand: start, lines };
}

function commandString(argv: string[]): string {
  const quote = (value: string): string => /^[\w./:=@-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
  return argv.map(quote).join(" ");
}

async function cmdStart(args: ParsedArgs): Promise<Record<string, unknown>> {
  if (!args.batch) throw new LoopError("用法：loop 启动 <批次.json> [--dry-run] [--json] [--launcher terminal|background]");
  const repo = repoOf(process.cwd());
  const batch = loadBatch(repo, args.batch);
  const names = batch.plan.steps.flat();
  for (const [name, stage] of batch.plan.stages) {
    const branch = batch.stages.get(name)?.branch;
    if (!branch) continue;
    if (!existsSync(stage.cwd)) {
      if (!args.dryRun) throw new LoopError(`段 ${name} 的目录不存在：${stage.cwd}；先执行 loop 开工`);
      continue;
    }
    const actual = currentBranch(stage.cwd);
    if (actual !== branch) throw new LoopError(`段 ${name} 的目录在分支 ${actual ?? "detached"}，批次要求 ${branch}；未启动`);
  }
  if (names.length === 1) {
    const stage = batch.plan.stages.get(names[0])!;
    const command = stage.start;
    if (args.dryRun) {
      let printed = command;
      if (stage.prompt) {
        const res = spawnSync("/bin/sh", ["-c", command], { cwd: stage.cwd, encoding: "utf8",
          env: { ...process.env, PI_DEV_DRY_RUN: "1", AUTOREVIEW_PIPELINE_DIR: batch.plan.dir,
            AUTOREVIEW_STAGE: stage.name, AUTOREVIEW_BATCH_FILE: batch.path } });
        if (res.status !== 0) throw new LoopError(`生成启动命令失败：${(res.stderr || res.stdout).trim().slice(-500)}`);
        printed = res.stdout.trim();
      }
      const lines = [`启动：${command}`, ...(printed !== command ? [`经过 pi-dev 的实际命令：${printed}`] : [])];
      return { ok: true, command: "启动", dryRun: true, mode: "single", stage: stage.name, cwd: stage.cwd, startCommand: command, commands: [printed], lines };
    }
    const res = spawnSync("/bin/sh", ["-c", command], { cwd: stage.cwd, encoding: args.json ? "utf8" : undefined, stdio: args.json ? "pipe" : "inherit",
      env: { ...process.env, AUTOREVIEW_PIPELINE_DIR: batch.plan.dir, AUTOREVIEW_STAGE: stage.name, AUTOREVIEW_BATCH_FILE: batch.path } });
    return { ok: (res.status ?? 1) === 0, command: "启动", dryRun: false, mode: "single", stage: stage.name, cwd: stage.cwd,
      exitCode: res.status, ...(args.json ? { stdout: res.stdout, stderr: res.stderr } : {}), lines: [`启动：${command}`] };
  }
  const argv = [process.execPath, PIPELINE, batch.path, "--project-root", repo.projectRoot, "--default-workspace", "dev分支",
    ...(args.launcher ? ["--launcher", args.launcher] : [])];
  if (args.dryRun) {
    const command = commandString(argv);
    return { ok: true, command: "启动", dryRun: true, mode: "pipeline", stages: names, commands: [command], lines: [`流水线：${command}`] };
  }
  const res = spawnSync(argv[0], argv.slice(1), { cwd: repo.root, encoding: args.json ? "utf8" : undefined,
    stdio: args.json ? "pipe" : "inherit" });
  return { ok: (res.status ?? 1) === 0, command: "启动", dryRun: false, mode: "pipeline", stages: names,
    exitCode: res.status, ...(args.json ? { stdout: res.stdout, stderr: res.stderr } : {}),
    lines: [`流水线已结束（退出码 ${res.status}）：${names.join("、")}`] };
}

const EVENT_LABEL: Record<string, string> = { started: "进行中", done: "完成", paused: "暂停", "no-change": "没改动", "startup-failed": "启动失败" };

/** 总结里「评审 N 次」就是本段实际轮次；读不到时留空，不用状态序号冒充。 */
function summaryRounds(path: string | undefined): number | undefined {
  if (!path || !existsSync(path)) return undefined;
  try {
    const matches = [...readFileSync(path, "utf8").matchAll(/评审\s*(\d+)\s*次/g)];
    return matches.length ? Number(matches[matches.length - 1][1]) : undefined;
  } catch { return undefined; }
}

function statusEntries(batch: BatchPlan): Record<string, unknown>[] {
  const entries: Record<string, unknown>[] = [];
  for (const stage of batch.plan.stages.keys()) {
    const status = readJson<StageStatus>(statusPath(batch.plan.dir, stage));
    entries.push({
      stage, dir: batch.plan.dir,
      event: status?.event ?? "未开始",
      phase: status ? (EVENT_LABEL[status.event] ?? status.event) : "未开始",
      round: summaryRounds(status?.summary) ?? null,
      seq: status?.seq ?? 0,
      pauseReason: status?.pauseReason,
      summary: status?.summary,
      updatedAt: status?.updatedAt,
    });
  }
  return entries;
}

function scanStatuses(): Record<string, unknown>[] {
  const root = join(homedir(), ".pi-autoreview", "pipelines");
  if (!existsSync(root)) return [];
  const entries: Record<string, unknown>[] = [];
  for (const name of readdirSafe(root)) {
    const dir = join(root, name);
    for (const file of readdirSafe(dir)) {
      if (!file.endsWith(".status.json")) continue;
      const status = readJson<StageStatus>(join(dir, file));
      if (!status) continue;
      entries.push({ stage: status.stage, dir, event: status.event, phase: EVENT_LABEL[status.event] ?? status.event,
        round: summaryRounds(status.summary) ?? null, seq: status.seq, pauseReason: status.pauseReason, summary: status.summary, updatedAt: status.updatedAt });
    }
  }
  return entries.sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
}

function readdirSafe(path: string): string[] {
  try { return readdirSync(path); } catch { return []; }
}

async function cmdStatus(args: ParsedArgs): Promise<Record<string, unknown>> {
  const entries = args.batch ? statusEntries(loadBatch(repoOf(process.cwd()), args.batch)) : scanStatuses();
  const lines = entries.length ? entries.map((entry) => {
    const reason = entry.pauseReason ? `；暂停原因：${entry.pauseReason}` : "";
    const round = entry.round === undefined || entry.round === null ? "未知" : String(entry.round);
    return `${entry.stage}：${entry.phase}；轮次：${round}（状态序号 ${entry.seq}）${reason}；总结：${entry.summary ?? "（无）"}；目录：${entry.dir}`;
  }) : ["没有找到段状态"];
  return { ok: true, command: "状态", dryRun: args.dryRun, stages: entries, lines };
}

async function cmdMerge(args: ParsedArgs): Promise<Record<string, unknown>> {
  if (!args.batch) throw new LoopError("用法：loop 合入 <批次.json> [--dry-run] [--json]");
  const repo = repoOf(process.cwd());
  const batch = loadBatch(repo, args.batch);
  const branches = [...new Set([...batch.stages.keys()].map((stage) => branchOfStage(batch, stage)).filter((branch): branch is string => Boolean(branch)))];
  if (!branches.length) throw new LoopError("批次.json 没有指定分支，无法合入");
  checkRuntime(repo, args.dryRun);
  const stageNames = (branch: string): string[] =>
    [...batch.stages.entries()].filter(([, value]) => value.branch === branch).map(([name]) => name);
  const staged: CommitResult[] = [];
  for (const branch of branches) {
    checkBranchName(branch);
    if (branch === repo.layout.release) throw new LoopError(`批次分支不能就是发布分支：${branch}`);
    const holder = worktreeForBranch(repo.root, branch);
    if (!holder || resolve(holder.path) === repo.root) continue;
    if (isClean(holder.path)) continue;
    if (args.dryRun) {
      staged.push({ committed: false, branch, reason: "有未提交改动，dry-run 未提交" });
      continue;
    }
    staged.push(commitAll(holder.path, branch, batch.plan.name, stageNames(branch).join("、") || "合入前"));
  }
  const original = gitText(repo.root, ["rev-parse", "HEAD"]);
  const merges: Record<string, unknown>[] = [];
  for (const branch of branches) {
    if (args.dryRun) {
      merges.push({ branch, action: "将合并", commit: undefined });
      continue;
    }
    const merge = gitResult(repo.root, ["merge", "--no-ff", branch, "-m", stageCommitMessage(branch, batch.plan.name, stageNames(branch).join("、") || "合入发布分支")]);
    if (merge.status !== 0) {
      const conflicts = gitText(repo.root, ["diff", "--name-only", "--diff-filter=U", "-z"]).split("\0").filter(Boolean);
      gitResult(repo.root, ["merge", "--abort"]);
      if (gitText(repo.root, ["rev-parse", "HEAD"]) !== original) {
        // 本次命令已经产生的合并结果也退回，保证恢复运行时原状。
        gitResult(repo.root, ["reset", "--hard", original]);
      }
      throw new LoopError(`合并 ${branch} 有冲突，已中止并恢复原状：${conflicts.join("、") || "（未列出冲突文件）"}`,
        { branch, conflicts, original });
    }
    merges.push({ branch, action: "已合并", commit: branchExists(repo.root, branch) ? gitText(repo.root, ["rev-parse", "HEAD"]) : undefined });
  }
  const lines = args.dryRun
    ? [`将提交：${staged.length ? staged.map((item) => item.branch).join("、") : "（没有未提交改动）"}`,
       `将合入 ${repo.layout.release}：${branches.join("、")}；不推送`]
    : [`已合入 ${repo.layout.release}：${merges.map((item) => item.branch).join("、")}`,
       `提交：${staged.filter((item) => item.committed).map((item) => item.branch).join("、") || "（没有）"}；未推送`];
  return { ok: true, command: "合入", dryRun: args.dryRun, release: repo.layout.release, branches, commits: staged, merges, pushed: false, lines };
}

const USAGE = `用法：
  loop 开工 <批次.json> [--dry-run] [--json] [--recheck]
  loop 启动 <批次.json> [--dry-run] [--json] [--launcher terminal|background]
  loop 状态 [<批次.json>] [--dry-run] [--json]
  loop 合入 <批次.json> [--dry-run] [--json]`;

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  let args: ParsedArgs;
  try { args = parseArgs(argv); } catch (error) {
    const json = argv.includes("--json"), dryRun = argv.includes("--dry-run");
    const result = { ok: false, command: argv[0], dryRun, error: (error as Error).message };
    if (json) console.log(JSON.stringify(result, null, 2)); else console.error(`loop: ${(error as Error).message}\n${USAGE}`);
    return 2;
  }
  if (!args.command || ["-h", "--help", "帮助"].includes(args.command)) {
    console.error(USAGE);
    if (args.json) console.log(JSON.stringify({ ok: false, command: args.command ?? null, dryRun: args.dryRun, error: "缺子命令" }, null, 2));
    return 2;
  }
  try {
    let result: Record<string, unknown>;
    if (args.command === "开工") result = await cmdOpen(args);
    else if (args.command === "启动") result = await cmdStart(args);
    else if (args.command === "状态") result = await cmdStatus(args);
    else if (args.command === "合入") result = await cmdMerge(args);
    else throw new LoopError(`未知子命令：${args.command}\n${USAGE}`);
    if (args.json) console.log(JSON.stringify(result, null, 2));
    else {
      const lines = Array.isArray(result.lines) ? result.lines as string[] : [];
      console.log(lines.length ? lines.join("\n") : JSON.stringify(result, null, 2));
    }
    return result.ok === false ? 1 : 0;
  } catch (error) {
    const data = error instanceof LoopError ? error.data : {};
    const result = { ok: false, command: args.command, dryRun: args.dryRun, error: (error as Error).message, ...data };
    if (args.json) console.log(JSON.stringify(result, null, 2));
    else console.error(`loop: ${(error as Error).message}`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; });
}
