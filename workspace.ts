/** 共用 Git 查询与 worktree 归属。旧开工/提交专有写操作已移除。 */
import { spawnSync } from "node:child_process";
export interface GitOutput { status: number; stdout: string; stderr: string }
export interface Worktree { path: string; branch?: string; bare: boolean; detached: boolean }
export function gitResult(cwd: string, args: string[], timeout = 120_000): GitOutput {
  const res = spawnSync("git", ["-c", "core.quotePath=false", ...args], { cwd, encoding: "utf8", timeout, maxBuffer: 8 * 1024 * 1024 });
  return { status: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}
export function gitText(cwd: string, args: string[], label = `git ${args.join(" ")}`): string {
  const res = gitResult(cwd, args);
  if (res.status !== 0) throw new Error(`${label} 失败（退出码 ${res.status}）：${(res.stderr || res.stdout).trim().slice(-600) || "无错误输出"}`);
  return res.stdout.trim();
}
export function worktrees(repoRoot: string): Worktree[] {
  const output = gitText(repoRoot, ["worktree", "list", "--porcelain"]), list: Worktree[] = [];
  let current: Worktree | undefined;
  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) { current = { path: line.slice(9), bare: false, detached: false }; list.push(current); }
    else if (current && line.startsWith("branch refs/heads/")) current.branch = line.slice(18);
    else if (current && line === "bare") current.bare = true;
    else if (current && line === "detached") current.detached = true;
  }
  return list;
}
export function worktreeForBranch(repoRoot: string, branch: string): Worktree | undefined { return worktrees(repoRoot).find((item) => item.branch === branch); }
export const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;
