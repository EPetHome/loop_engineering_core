#!/usr/bin/env node
/**
 * loop.ts — bin/loop 的实现：开工、启动、状态、合入。
 *
 * 所有子命令支持 --dry-run（只核对、只打印，不改文件或分支）和 --json（标准输出一个 JSON 对象）。
 * 只做本地操作，不推送；开发方不提交，段完成时由流水线按分支名生成提交说明。
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { remapBatchReferences } from "./batch-refs.ts";
import { loadProjectLayout, workspacePath, type ProjectLayout } from "./config.ts";
import { runMethodsSelfTest, type MethodsRunResult } from "./methods.ts";
import { parsePlan, type Plan } from "./pipeline.ts";
import { readJson, statusPath } from "./pipeline-core.ts";
import type { StageStatus } from "./pipeline-core.ts";
import {
  branchExists, branchType, checkBranchName, commitAll, currentBranch, gitResult, gitText, isClean, shellQuote,
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

function mainWorktree(root: string): string {
  const list = gitResult(root, ["worktree", "list", "--porcelain"]);
  if (list.status !== 0) return root;
  const first = list.stdout.split("\n").find((line) => line.startsWith("worktree "));
  return first ? first.slice("worktree ".length) : root;
}

export function repoOf(cwd: string): Repo {
  const res = gitResult(cwd, ["rev-parse", "--show-toplevel"]);
  if (res.status !== 0 || !res.stdout.trim()) throw new LoopError(`当前目录不是 git 仓库：${cwd}（${(res.stderr || res.stdout).trim().slice(-300)}）`);
  const root = mainWorktree(res.stdout.trim());
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
  const plan = parsePlan(normalized, planDir, process.env, { batchFile: absolute, projectRoot: repo.projectRoot });
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

function batchCommand(command: string, path: string): string {
  return `${shellQuote(LOOP_BIN)} ${command} ${shellQuote(path)}`;
}

function checkClean(repo: Repo, workspace: WorkspaceUse): void {
  const res = gitResult(workspace.path, ["status", "--porcelain", "-z"]);
  if (res.status !== 0) throw new LoopError(`无法读取开发空间状态：${workspace.path}（${(res.stderr || res.stdout).trim().slice(-300)}）`);
  if (res.stdout !== "") {
    const files = res.stdout.split("\0").filter(Boolean).join("、");
    throw new LoopError(`开发空间有未提交改动，未继续：${workspace.path}；${files}`, { workspace: workspace.path, files });
  }
}

interface WorkingChange { path: string; status: string }

/** 工作区里未提交的文件；改名的两端都算，供输出和合入前的交集检查使用。 */
function workingChanges(root: string, label: string): WorkingChange[] {
  const res = gitResult(root, ["status", "--porcelain", "-z", "--untracked-files=all"]);
  if (res.status !== 0) throw new LoopError(`无法读取${label}状态：${(res.stderr || res.stdout).trim().slice(-300)}`);
  const tokens = res.stdout.split("\0");
  const changes: WorkingChange[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const entry = tokens[index];
    if (!entry) continue;
    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    if (!path) continue;
    changes.push({ path, status });
    if (/[RC]/.test(status)) {
      const original = tokens[index + 1];
      if (original) { changes.push({ path: original, status }); index += 1; }
    }
  }
  return changes;
}

/** 批次工作区里会被 commitAll 自动提交的路径；声明的本机文件不参与。 */
function autoCommitPaths(workspacePath: string): string[] {
  const changes = workingChanges(workspacePath, "批次工作区");
  const project = loadProjectLayout(workspacePath);
  const root = gitText(workspacePath, ["rev-parse", "--show-toplevel"]);
  const local = project.layout.localFiles
    .map((path) => relative(root, resolve(project.root, path)).replace(/\\/g, "/"))
    .filter((path) => path && path !== ".." && !path.startsWith("../"));
  return changes.map((change) => change.path)
    .filter((path) => !local.some((rel) => path === rel || path.startsWith(`${rel}/`)));
}

/** 开工和合入只要求运行版停在发布分支；未提交改动由命令自己列出来。 */
function checkRuntime(repo: Repo): WorkingChange[] {
  const branch = currentBranch(repo.root);
  if (branch !== repo.layout.release) {
    throw new LoopError(`运行版必须停在发布分支 ${repo.layout.release}，现在是 ${branch ?? "detached"}`, { branch, release: repo.layout.release });
  }
  return workingChanges(repo.root, "运行版");
}

/** 仓库根目录内的相对路径；仓库外和 .git 下的路径返回 undefined。 */
function insideRepo(repoRoot: string, absolute: string): string | undefined {
  const rel = relative(repoRoot, absolute);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return undefined;
  const normalized = rel.split("\\").join("/");
  if (normalized === ".git" || normalized.startsWith(".git/")) return undefined;
  return normalized;
}

function filesUnder(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...filesUnder(path));
    else files.push(path);
  }
  return files;
}

interface BatchDocs {
  branch?: string;
  target?: WorkspaceUse;
  /** 相对仓库根、相对发布分支 HEAD 有变化的批次文档。 */
  files: string[];
  /** 开工输出里的 启动 / 状态 / 合入 该用的批次文件路径。 */
  batchPath: string;
}

/** 批次文档：批次目录里的全部文件、各段 prompt、e2e.criteria；只取仓库内且相对 HEAD 有变化的。 */
function batchDocsPlan(repo: Repo, batch: BatchPlan, changes: WorkingChange[]): BatchDocs {
  const branch = batch.branch ?? [...batch.stages.values()].find((stage) => stage.branch)?.branch;
  const target = branch ? [...batch.workspaces, ...batch.checks].find((workspace) => workspace.branch === branch) : undefined;
  const dir = resolve(dirname(batch.path));
  const candidates = new Set<string>([resolve(batch.path)]);
  const dirRel = relative(repo.root, dir);
  const dirInside = dirRel === "" || (!dirRel.startsWith("..") && !isAbsolute(dirRel));
  // 批次文件直接放在仓库根或项目根时，不把同目录的无关文件都算成本批文档。
  if (dirInside && dir !== resolve(repo.root) && dir !== resolve(repo.projectRoot)) {
    for (const file of filesUnder(dir)) candidates.add(resolve(file));
  }
  for (const stage of batch.plan.stages.values()) if (stage.prompt) candidates.add(resolve(stage.prompt));
  if (batch.plan.e2e) candidates.add(resolve(batch.plan.e2e.criteriaFile));

  const byPath = new Map(changes.map((change) => [change.path, change]));
  const files: string[] = [];
  for (const absolute of candidates) {
    const rel = insideRepo(repo.root, absolute);
    if (!rel) continue;
    const change = byPath.get(rel);
    if (!change || change.status.includes("D") || !existsSync(absolute)) continue;
    files.push(rel);
  }
  const batchRel = insideRepo(repo.root, batch.path);
  if (target && batchRel) {
    const mapped = remapBatchReferences(batch.raw, repo.root, target.path, batch.path, new Set(files));
    if (JSON.stringify(mapped) !== JSON.stringify(batch.raw)) files.push(batchRel);
  }
  return {
    ...(branch ? { branch } : {}), ...(target ? { target } : {}),
    files: [...new Set(files)].sort(),
    batchPath: batchRel && target ? resolve(target.path, batchRel) : batch.path,
  };
}

interface FileDoc { kind: "file"; content: Buffer }
interface LinkDoc { kind: "link"; target: string }
type DocContent = FileDoc | LinkDoc;

function lstatSafe(path: string): ReturnType<typeof lstatSync> | undefined {
  try { return lstatSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** 目标父路径不能被符号链接带到仓库外；create=false 时只核对，不建目录。 */
function ensureSafeParents(targetRoot: string, rel: string, create = true): void {
  let current = targetRoot;
  for (const part of rel.split("/").slice(0, -1)) {
    current = join(current, part);
    const info = lstatSafe(current);
    if (!info) { if (!create) return; mkdirSync(current); continue; }
    if (info.isSymbolicLink()) throw new LoopError(`开发空间里的父路径是符号链接，未继续：${rel} → ${current}`);
    if (!info.isDirectory()) throw new LoopError(`开发空间里的父路径不是目录，未继续：${rel} → ${current}`);
  }
}

/** 写入任何批次文档前核对全部目标；忽略规则不能作为覆盖本地内容的许可。 */
function checkBatchDocTargets(target: WorkspaceUse, files: string[]): void {
  const listed = gitResult(target.path, ["--literal-pathspecs", "ls-files", "--cached", "-z", "--", ...files]);
  if (listed.status !== 0) {
    throw new LoopError(`无法核对开发空间批次文档的跟踪状态：${target.path}（${(listed.stderr || listed.stdout).trim().slice(-300)}）`,
      { workspace: target.path, files });
  }
  const tracked = new Set(listed.stdout.split("\0").filter(Boolean));
  const blocked = files.filter((rel) => {
    ensureSafeParents(target.path, rel, false);
    return !tracked.has(rel) && Boolean(lstatSafe(resolve(target.path, rel)));
  });
  if (blocked.length) {
    throw new LoopError(`开发空间的批次文档目标已有未跟踪内容（含被忽略的），不覆盖：${blocked.join("、")}`,
      { workspace: target.path, files: blocked });
  }
}

let tempCounter = 0;

/** 用临时文件替换目标本身，不跟随目标已有的符号链接写入。 */
function writeDocSafely(targetRoot: string, rel: string, doc: DocContent): void {
  ensureSafeParents(targetRoot, rel);
  const destination = resolve(targetRoot, rel);
  const existing = lstatSafe(destination);
  if (existing?.isDirectory()) throw new LoopError(`开发空间里的目标路径是目录，未继续：${rel} → ${destination}`);
  const temp = join(dirname(destination), `.loop-doc-${process.pid}-${tempCounter++}.tmp`);
  try {
    rmSync(temp, { force: true });
    if (doc.kind === "link") symlinkSync(doc.target, temp);
    else writeFileSync(temp, doc.content);
    renameSync(temp, destination);
  } finally {
    rmSync(temp, { force: true });
  }
}

function rewriteBatchDocument(source: string, repoRoot: string, targetRoot: string, files: readonly string[]): string {
  const original = readFileSync(source, "utf8");
  let raw: unknown;
  try { raw = JSON.parse(original); } catch { return original; }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return original;
  const mapped = remapBatchReferences(raw as Record<string, unknown>, repoRoot, targetRoot, source, new Set(files));
  return JSON.stringify(mapped) === JSON.stringify(raw) ? original : `${JSON.stringify(mapped, null, 2)}\n`;
}

function copyBatchDocs(repo: Repo, target: WorkspaceUse, files: string[], batchPath: string): Map<string, DocContent> {
  // 新建/切换 worktree 后再核对一次，冲突时不留下部分写入的批次文档。
  checkBatchDocTargets(target, files);
  const expected = new Map<string, DocContent>();
  for (const rel of files) {
    const source = resolve(repo.root, rel);
    let doc: DocContent;
    if (resolve(source) === resolve(batchPath)) {
      doc = { kind: "file", content: Buffer.from(rewriteBatchDocument(source, repo.root, target.path, files)) };
    } else {
      const info = lstatSync(source);
      doc = info.isSymbolicLink()
        ? { kind: "link", target: readlinkSync(source) }
        : { kind: "file", content: readFileSync(source) };
    }
    writeDocSafely(target.path, rel, doc);
    expected.set(rel, doc);
  }
  return expected;
}

/** 恢复项目根之前，确认开发空间里的内容与要保存的一致。 */
function verifyCopiedDocs(target: WorkspaceUse, expected: Map<string, DocContent>): void {
  for (const [rel, doc] of expected) {
    const destination = resolve(target.path, rel);
    const info = lstatSafe(destination);
    if (!info) throw new LoopError(`开发空间里没有保存批次文档：${rel}`, { files: [...expected.keys()] });
    if (doc.kind === "link") {
      if (!info.isSymbolicLink() || readlinkSync(destination) !== doc.target) {
        throw new LoopError(`开发空间里的批次文档没有按原样保存：${rel}`, { files: [...expected.keys()] });
      }
      continue;
    }
    if (info.isSymbolicLink() || info.isDirectory() || !readFileSync(destination).equals(doc.content)) {
      throw new LoopError(`开发空间里的批次文档内容没有按原样保存：${rel}`, { files: [...expected.keys()] });
    }
  }
}

interface BatchDocsCommit { committed: boolean; commit?: string; files: string[] }

function commitBatchDocs(workspace: WorkspaceUse, branch: string, batchName: string, files: string[]): BatchDocsCommit {
  const actual = currentBranch(workspace.path);
  if (actual !== branch) throw new LoopError(`开发空间当前分支是 ${actual ?? "detached"}，不是批次分支 ${branch}；不提交批次文档`);
  const root = gitText(workspace.path, ["rev-parse", "--show-toplevel"]);
  const add = gitResult(root, ["add", "-A", "--", ...files]);
  if (add.status !== 0) throw new LoopError(`git add 批次文档失败：${(add.stderr || add.stdout).trim().slice(-300)}`, { files });
  const stagedResult = gitResult(root, ["diff", "--cached", "--name-only", "-z"]);
  if (stagedResult.status !== 0) throw new LoopError(`git diff --cached 失败：${(stagedResult.stderr || stagedResult.stdout).trim().slice(-300)}`, { files });
  const staged = stagedResult.stdout.split("\0").filter(Boolean);
  const expected = new Set(files);
  const extra = staged.filter((path) => !expected.has(path));
  if (extra.length) throw new LoopError(`批次文档提交出现范围外的改动，未继续：${extra.join("、")}`, { files: extra });
  if (staged.length === 0) return { committed: false, files };
  const type = branchType(branch);
  if (!type) throw new LoopError(`无法从分支名生成批次文档提交说明：${branch}`, { files });
  const commit = gitResult(root, ["commit", "-m", `${type}: 批次文档\n\n批次：${batchName}`]);
  if (commit.status !== 0) throw new LoopError(`批次文档提交失败：${(commit.stderr || commit.stdout).trim().slice(-300)}`, { files });
  return { committed: true, commit: gitText(root, ["rev-parse", "HEAD"]), files: staged };
}

/** 批次文档提交成功后，把项目根里这些路径恢复成发布分支 HEAD 的状态。 */
function restoreProjectDocs(repo: Repo, files: string[]): void {
  for (const rel of files) {
    const absolute = resolve(repo.root, rel);
    const tracked = gitResult(repo.root, ["cat-file", "-e", `HEAD:${rel}`]).status === 0;
    if (tracked) {
      const restore = gitResult(repo.root, ["checkout", "HEAD", "--", rel]);
      if (restore.status !== 0) throw new LoopError(`恢复项目根文件失败：${rel}；${(restore.stderr || restore.stdout).trim().slice(-300)}`, { files });
      continue;
    }
    gitResult(repo.root, ["reset", "-q", "--", rel]);
    rmSync(absolute, { force: true });
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
  const runtimeChanges = checkRuntime(repo);
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
  const docs = batchDocsPlan(repo, batch, runtimeChanges);
  if (docs.files.length && !docs.target) {
    throw new LoopError(`批次文档需要搬进分支 ${docs.branch ?? "（未指定）"} 的开发空间，但没有找到对应的工作区；给该分支写 workspace 或已登记的 cwd`,
      { files: docs.files, branch: docs.branch });
  }
  // 必须早于 checkout：Git 切分支本身也可能覆盖被忽略的同名文件；dry-run 同样报告冲突。
  if (docs.files.length && docs.target?.registered) checkBatchDocTargets(docs.target, docs.files);
  const docPaths = new Set(docs.files);
  const uncommitted = [...new Set(runtimeChanges.map((change) => change.path).filter((path) => !docPaths.has(path)))].sort();
  const lines = [`运行版：${repo.root}（发布分支 ${repo.layout.release}）`];
  if (uncommitted.length) lines.push(`未提交，不在本批分支上：${uncommitted.join("、")}`);
  lines.push(`批次：${batch.plan.name}${batch.branch ? `，分支 ${batch.branch}` : ""}`);
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
  let docsCommit: BatchDocsCommit = { committed: false, files: [] };
  if (docs.files.length) {
    if (args.dryRun) {
      lines.push(`批次文档：将搬入 ${docs.target!.path}（${docs.files.join("、")}）；项目根将恢复：${docs.files.join("、")}`);
    } else {
      const expected = copyBatchDocs(repo, docs.target!, docs.files, batch.path);
      docsCommit = commitBatchDocs(docs.target!, docs.branch!, batch.plan.name, docs.files);
      verifyCopiedDocs(docs.target!, expected);
      restoreProjectDocs(repo, docs.files);
      lines.push(`批次文档：${docsCommit.committed
        ? `已提交到 ${docs.target!.path}（${docs.files.join("、")}）`
        : `分支上已有相同内容，未建空提交（${docs.files.join("、")}）`}；项目根已恢复：${docs.files.join("、")}`);
    }
  } else {
    lines.push("批次文档：没有需要搬的文件");
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
  const start = batchCommand("启动", docs.batchPath);
  const status = batchCommand("状态", docs.batchPath);
  const merge = batchCommand("合入", docs.batchPath);
  lines.push(`启动：${start}`, `状态：${status}`, `合入：${merge}`);
  return { ok: true, command: "开工", dryRun: args.dryRun, repo: repo.root, release: repo.layout.release,
    batch: batch.plan.name, branch: batch.branch, workspaces: resultWorkspaces, localFiles: repo.layout.localFiles,
    uncommitted,
    batchDocs: { ...(docs.branch ? { branch: docs.branch } : {}), ...(docs.target ? { workspace: docs.target.path } : {}),
      files: docs.files, restore: docs.files, committed: docsCommit.committed, ...(docsCommit.commit ? { commit: docsCommit.commit } : {}) },
    methods, startCommand: start, statusCommand: status, mergeCommand: merge, lines };
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

function checkNoExistingMerge(repo: Repo): void {
  const mergeHead = gitResult(repo.root, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
  if (mergeHead.status !== 0) return;
  const status = gitText(repo.root, ["status", "--porcelain"]);
  throw new LoopError(`运行版已有未完成的合并（MERGE_HEAD 存在），未继续；先完成或中止那次合并；项目根状态：${status || "（干净）"}`,
    { mergeInProgress: true, status });
}

/** 本次临时保存的 stash commit 和私有引用。 */
interface ProjectStash { ref: string; hash: string }

/** 未跟踪文件挡在 HEAD 要写回的路径上时，清理会覆盖它们；返回这些路径。 */
function untrackedBlockers(root: string): string[] {
  const head = gitText(root, ["ls-tree", "-r", "--name-only", "-z", "HEAD"]).split("\0").filter(Boolean);
  const scan = gitResult(root, ["ls-files", "--others", "-z"]);
  if (scan.status !== 0) {
    throw new LoopError(`无法完整扫描运行版未跟踪文件，未合入：${(scan.stderr || scan.stdout).trim().slice(-300) || "git 未返回错误信息"}`);
  }
  const others = scan.stdout.split("\0").filter(Boolean);
  if (!head.length || !others.length) return [];
  const files = new Set(head);
  const dirs = new Set<string>();
  for (const file of head) {
    const parts = file.split("/");
    for (let index = 1; index < parts.length; index += 1) dirs.add(parts.slice(0, index).join("/"));
  }
  const blocked = new Set<string>();
  for (const path of others) {
    if (files.has(path) || dirs.has(path)) { blocked.add(path); continue; }
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      if (files.has(parts.slice(0, index).join("/"))) { blocked.add(path); break; }
    }
  }
  return [...blocked].sort();
}

/**
 * 用 stash commit + 独立私有 ref 保存项目根的已跟踪未提交改动（含暂存状态）。
 * 不读写共享的 refs/stash，避免其他 worktree 同时 push 时认错或删错记录。
 */
function stashProjectChanges(repo: Repo, changes: WorkingChange[]): ProjectStash | undefined {
  if (!changes.some((change) => !change.status.startsWith("??"))) return undefined;
  const blockers = untrackedBlockers(repo.root);
  if (blockers.length) {
    throw new LoopError(`运行版有未跟踪文件挡在 HEAD 路径上，清理会覆盖它们，未合入：${blockers.join("、")}`,
      { files: blockers });
  }
  const created = gitResult(repo.root, ["stash", "create", `loop 合入：临时保存运行版未提交改动 ${randomUUID()}`]);
  if (created.status !== 0) {
    throw new LoopError(`无法临时保存运行版未提交改动，未合入：${(created.stderr || created.stdout).trim().slice(-300)}`,
      { files: changes.map((change) => change.path) });
  }
  const hash = created.stdout.trim();
  if (!hash) throw new LoopError("无法临时保存运行版未提交改动，未合入");
  const ref = `refs/loop/merge-stash/${randomUUID()}`;
  const pin = gitResult(repo.root, ["update-ref", ref, hash]);
  if (pin.status !== 0) {
    throw new LoopError(`无法为临时保存的改动创建独立引用，未合入：${(pin.stderr || pin.stdout).trim().slice(-300)}`,
      { stash: hash });
  }
  // 改动已经钉在独立 ref 上，再把已跟踪的工作区/索引恢复到 HEAD；未跟踪文件保留。
  const reset = gitResult(repo.root, ["read-tree", "--reset", "-u", "HEAD"]);
  if (reset.status !== 0) {
    throw new LoopError(`临时保存的改动已写入 ${ref}，但无法清理运行版已跟踪改动，未合入；${(reset.stderr || reset.stdout).trim().slice(-300)}`,
      { stash: ref, hash });
  }
  return { ref, hash };
}

/** 恢复临时保存的改动和索引状态，然后删除本次的独立 ref；失败时保留 ref。 */
function restoreProjectStash(repo: Repo, stash: ProjectStash): void {
  const apply = gitResult(repo.root, ["stash", "apply", "--index", stash.hash]);
  if (apply.status !== 0) {
    const head = gitText(repo.root, ["rev-parse", "HEAD"]);
    const status = gitText(repo.root, ["status", "--porcelain"]);
    throw new LoopError(`合入后无法恢复运行版未提交改动；当前提交 ${head}；改动仍在 ${stash.ref}；项目根状态：${status || "（干净）"}`,
      { stash: stash.ref, hash: stash.hash, head, status, restoreStashFailed: true });
  }
  // 只删除本次的独立 ref；万一引用已变化，update-ref 的比较交换会失败并保留记录。
  gitResult(repo.root, ["update-ref", "-d", stash.ref, stash.hash]);
}

async function cmdMerge(args: ParsedArgs): Promise<Record<string, unknown>> {
  if (!args.batch) throw new LoopError("用法：loop 合入 <批次.json> [--dry-run] [--json]");
  const repo = repoOf(process.cwd());
  const batch = loadBatch(repo, args.batch);
  const branches = [...new Set([...batch.stages.keys()].map((stage) => branchOfStage(batch, stage)).filter((branch): branch is string => Boolean(branch)))];
  if (!branches.length) throw new LoopError("批次.json 没有指定分支，无法合入");
  checkNoExistingMerge(repo);
  const dirty = checkRuntime(repo);
  const stageNames = (branch: string): string[] =>
    [...batch.stages.entries()].filter(([, value]) => value.branch === branch).map(([name]) => name);

  // 先算批次分支相对发布分支改了哪些文件，和运行版未提交文件求交集；有交集就不动任何分支。
  const changed = new Map<string, string[]>();
  for (const branch of branches) {
    checkBranchName(branch);
    if (branch === repo.layout.release) throw new LoopError(`批次分支不能就是发布分支：${branch}`);
    if (!branchExists(repo.root, branch)) throw new LoopError(`批次分支不存在：${branch}`, { branch });
    const diff = gitResult(repo.root, ["diff", "--name-only", "-z", "--no-renames", `${repo.layout.release}...${branch}`]);
    if (diff.status !== 0) {
      throw new LoopError(`无法读取分支 ${branch} 相对 ${repo.layout.release} 的改动：${(diff.stderr || diff.stdout).trim().slice(-300)}`, { branch });
    }
    const paths = diff.stdout.split("\0").filter(Boolean);
    const holder = worktreeForBranch(repo.root, branch);
    if (holder && resolve(holder.path) !== resolve(repo.root)) paths.push(...autoCommitPaths(holder.path));
    changed.set(branch, paths);
  }
  const dirtyPaths = new Set(dirty.map((change) => change.path));
  const overlap = [...new Set([...changed.values()].flat().filter((path) => dirtyPaths.has(path)))].sort();
  if (overlap.length) {
    throw new LoopError(`运行版未提交改动与本次合并碰到同一个文件，未合入：${overlap.join("、")}`, { files: overlap, branches });
  }
  const uncommitted = [...dirtyPaths].sort();

  const staged: CommitResult[] = [];
  for (const branch of branches) {
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
  const stash = args.dryRun ? undefined : stashProjectChanges(repo, dirty);
  const merges: Record<string, unknown>[] = [];
  let failure: unknown;
  try {
    for (const branch of branches) {
      if (args.dryRun) {
        merges.push({ branch, action: "将合并", commit: undefined });
        continue;
      }
      const merge = gitResult(repo.root, ["merge", "--no-ff", branch, "-m", stageCommitMessage(branch, batch.plan.name, stageNames(branch).join("、") || "合入发布分支")]);
      if (merge.status !== 0) {
        const conflicts = gitResult(repo.root, ["diff", "--name-only", "--diff-filter=U", "-z"]).stdout.split("\0").filter(Boolean);
        gitResult(repo.root, ["merge", "--abort"]);
        let head = gitText(repo.root, ["rev-parse", "HEAD"]);
        let mergeHead = gitResult(repo.root, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]).status === 0;
        if (head !== original || mergeHead) {
          // 用 --keep 退回本次命令产生的合并结果；运行版里无关的未提交改动必须在恢复 stash 后原样保留。
          const reset = gitResult(repo.root, ["reset", "--keep", original]);
          head = gitText(repo.root, ["rev-parse", "HEAD"]);
          mergeHead = gitResult(repo.root, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]).status === 0;
          if (reset.status !== 0 || head !== original || mergeHead) {
            const status = gitText(repo.root, ["status", "--porcelain"]);
            throw new LoopError(`合并 ${branch} 有冲突，已中止，但无法在不丢未提交改动的前提下退回 ${original}；当前提交 ${head}；未继续强制重置；项目根状态：${status || "（干净）"}`,
              { branch, conflicts, original, head, status, rollbackFailed: true });
          }
        }
        throw new LoopError(`合并 ${branch} 有冲突，已中止并恢复原状：${conflicts.join("、") || "（未列出冲突文件）"}`,
          { branch, conflicts, original });
      }
      merges.push({ branch, action: "已合并", commit: gitText(repo.root, ["rev-parse", "HEAD"]) });
    }
  } catch (error) {
    failure = error;
  }
  if (stash) {
    try { restoreProjectStash(repo, stash); } catch (error) {
      const previous = failure instanceof Error ? `；本次合入错误：${failure.message}` : "";
      throw new LoopError(`${(error as Error).message}${previous}`,
        { ...(error instanceof LoopError ? error.data : {}), ...(failure instanceof LoopError ? failure.data : {}), rollbackFailed: true });
    }
  }
  if (failure) throw failure;
  const uncommittedLine = uncommitted.length ? `未提交，不在本批合并范围：${uncommitted.join("、")}` : "运行版没有未提交改动";
  const lines = args.dryRun
    ? [`将提交：${staged.length ? staged.map((item) => item.branch).join("、") : "（没有未提交改动）"}`,
       `将合入 ${repo.layout.release}：${branches.join("、")}；不推送`, uncommittedLine]
    : [`已合入 ${repo.layout.release}：${merges.map((item) => item.branch).join("、")}`,
       `提交：${staged.filter((item) => item.committed).map((item) => item.branch).join("、") || "（没有）"}；未推送`, uncommittedLine];
  return { ok: true, command: "合入", dryRun: args.dryRun, release: repo.layout.release, branches,
    uncommitted, commits: staged, merges, pushed: false, lines };
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
