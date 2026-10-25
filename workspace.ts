/** 批次分支和工作区的 git 操作；只做本地提交与合并，不推送。 */
import { spawnSync } from "node:child_process";
import { relative, resolve } from "node:path";
import { loadProjectLayout } from "./config.ts";

export interface GitOutput { status: number; stdout: string; stderr: string }
export interface Worktree { path: string; branch?: string; bare: boolean; detached: boolean }

const ERROR_TAIL = 600;

export function gitResult(cwd: string, args: string[], timeout = 120_000): GitOutput {
  const res = spawnSync("git", ["-c", "core.quotePath=false", ...args], { cwd, encoding: "utf8", timeout, maxBuffer: 8 * 1024 * 1024 });
  return { status: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

export function gitText(cwd: string, args: string[], label = `git ${args.join(" ")}`): string {
  const res = gitResult(cwd, args);
  if (res.status !== 0) {
    const detail = (res.stderr || res.stdout).trim().slice(-ERROR_TAIL) || "无错误输出";
    throw new Error(`${label} 失败（退出码 ${res.status}）：${detail}`);
  }
  return res.stdout.trim();
}

export const isClean = (cwd: string): boolean => gitText(cwd, ["status", "--porcelain", "-z"]) === "";

export const currentBranch = (cwd: string): string | undefined => {
  const branch = gitText(cwd, ["branch", "--show-current"]);
  return branch || undefined;
};

export const currentTree = (cwd: string): string => gitText(cwd, ["rev-parse", "--verify", "HEAD^{tree}"]);

export const currentHead = (cwd: string): string => gitText(cwd, ["rev-parse", "--verify", "HEAD"]);

export const branchExists = (cwd: string, branch: string): boolean =>
  gitResult(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).status === 0;

export function worktrees(repoRoot: string): Worktree[] {
  const output = gitText(repoRoot, ["worktree", "list", "--porcelain"]);
  const list: Worktree[] = [];
  let current: Worktree | undefined;
  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length), bare: false, detached: false };
      list.push(current);
    } else if (current && line.startsWith("branch refs/heads/")) {
      current.branch = line.slice("branch refs/heads/".length);
    } else if (current && line === "bare") current.bare = true;
    else if (current && line === "detached") current.detached = true;
  }
  return list;
}

export function worktreeForBranch(repoRoot: string, branch: string): Worktree | undefined {
  return worktrees(repoRoot).find((item) => item.branch === branch);
}

export function branchType(branch: string): string | undefined {
  const match = /^([^/]+)\/(.+)$/.exec(branch);
  return match?.[1];
}

export function checkBranchName(branch: string): void {
  const match = /^(feat|fix|refactor|docs|test|chore)\/(.+)$/.exec(branch);
  if (!match) throw new Error(`分支名必须是 <类型>/<描述>，类型取 feat、fix、refactor、docs、test、chore：${branch}`);
}

/** 程序提交的说明：<类型>: <描述>，正文写批次名和段名。 */
export function stageCommitMessage(branch: string, batchName: string, stage: string): string {
  const match = /^([^/]+)\/(.+)$/.exec(branch);
  if (!match) throw new Error(`无法从分支名生成提交说明：${branch}`);
  return `${match[1]}: ${match[2]}\n\n批次：${batchName}\n段：${stage}`;
}

export interface CommitResult { committed: boolean; commit?: string; branch?: string; reason?: string }

/** 提交工作区里尚未提交的改动；没有改动就不创建空提交。 */
export function commitAll(cwd: string, branch: string, batchName: string, stage: string, dryRun = false): CommitResult {
  const actual = currentBranch(cwd);
  if (actual !== branch) throw new Error(`工作区当前分支是 ${actual ?? "detached"}，不是批次分支 ${branch}；不提交`);
  if (isClean(cwd)) return { committed: false, branch };
  if (dryRun) return { committed: false, branch, reason: "有未提交改动，dry-run 未提交" };
  const message = stageCommitMessage(branch, batchName, stage);
  // 一律在仓库根执行 add/reset/commit，子目录段也使用同一个路径基准。
  const repoRoot = gitText(cwd, ["rev-parse", "--show-toplevel"]);
  const add = gitResult(repoRoot, ["add", "-A"]);
  if (add.status !== 0) throw new Error(`git add 失败：${(add.stderr || add.stdout).trim().slice(-ERROR_TAIL)}`);
  // 声明的本机文件不进仓库：即使目标分支漏了忽略规则，也不能被自动提交带进去。
  const project = loadProjectLayout(cwd);
  const localPaths = project.layout.localFiles
    .map((local) => relative(repoRoot, resolve(project.root, local)))
    .filter((rel) => rel && !rel.startsWith(".."));
  for (const rel of localPaths) {
    const reset = gitResult(repoRoot, ["reset", "-q", "--", rel]);
    if (reset.status !== 0) throw new Error(`git reset 本机文件失败（${rel}）：${(reset.stderr || reset.stdout).trim().slice(-ERROR_TAIL)}`);
  }
  const stagedResult = gitResult(repoRoot, ["diff", "--cached", "--name-only", "-z"]);
  if (stagedResult.status !== 0) throw new Error(`git diff --cached 失败：${(stagedResult.stderr || stagedResult.stdout).trim().slice(-ERROR_TAIL)}`);
  const staged = stagedResult.stdout.split("\0").filter(Boolean);
  const leaked = staged.filter((path) => localPaths.some((rel) => path === rel || path.startsWith(`${rel}/`)));
  if (leaked.length) throw new Error(`声明的本机文件仍进入待提交集合：${leaked.join("、")}`);
  if (staged.length === 0) return { committed: false, branch, reason: "只有本机文件改动，未创建提交" };
  const commit = gitResult(repoRoot, ["commit", "-m", message]);
  if (commit.status !== 0) throw new Error(`git commit 失败：${(commit.stderr || commit.stdout).trim().slice(-ERROR_TAIL)}`);
  return { committed: true, branch, commit: gitText(repoRoot, ["rev-parse", "HEAD"]) };
}

export const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;
