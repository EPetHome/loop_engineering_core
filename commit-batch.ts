/** 已登记批次的本地提交。私有索引核对候选，CAS 更新分支，不清理或改写工作文件。 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gitBlobHash, type Snapshot } from "./git.ts";
import { branchType, checkBranchName, gitText, localFilePaths } from "./workspace.ts";

export interface BatchCommit {
  branch: string; cwd: string; base: string; commit: string; tree: string;
  preSquash: string[]; pushed?: string;
}
export interface CommitCandidate { branch: string; cwd: string; candidate: Snapshot | string; conclusions: string[] }
const changed = (): Error => new Error("批次候选已变化，需要原开发会话重新完成门禁和评审；未提交");

/** 不接触真实索引；历史未跟踪文件使用冻结哈希，绝不拿当前内容冒充检查候选。 */
function withIndex<T>(cwd: string, scratch: string, fn: (run: (args: string[], input?: Buffer) => string, top: string) => T): T {
  const top = gitText(cwd, ["rev-parse", "--show-toplevel"]), index = join(scratch, `index-${randomUUID()}`);
  const run = (args: string[], input?: Buffer): string => {
    const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: top,
      env: { ...process.env, GIT_INDEX_FILE: index }, input, encoding: "utf8", timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
    if (result.status !== 0) throw new Error(`核对批次树失败：${result.stderr || result.stdout || result.error}`);
    return result.stdout.trim();
  };
  try { return fn(run, top); }
  finally { rmSync(index, { force: true }); rmSync(`${index}.lock`, { force: true }); }
}
export function workingTree(cwd: string, scratch: string): { head: string; tree: string } {
  return withIndex(cwd, scratch, (run) => {
    const head = run(["rev-parse", "HEAD"]);
    run(["read-tree", head]); run(["add", "-A", "--", "."]);
    for (const path of localFilePaths(cwd)) run(["reset", "-q", head, "--", path]);
    const tree = run(["write-tree"]);
    if (head !== run(["rev-parse", "HEAD"])) throw changed();
    return { head, tree };
  });
}
export function checkedTree(cwd: string, candidate: Snapshot | string, scratch: string): string {
  if (typeof candidate === "string") return candidate;
  return withIndex(cwd, scratch, (run, top) => {
    run(["read-tree", candidate.tree]);
    const prefix = gitText(cwd, ["rev-parse", "--show-prefix"]);
    for (const file of candidate.untracked) {
      const path = `${prefix}${file.path}`, absolute = join(top, path), info = lstatSync(absolute);
      const bytes = info.isSymbolicLink() ? readlinkSync(absolute, { encoding: "buffer" }) : readFileSync(absolute);
      const mode = info.isSymbolicLink() ? "120000" : info.mode & 0o111 ? "100755" : "100644";
      if (gitBlobHash(bytes) !== file.hash || mode !== file.mode) throw changed();
      const blob = info.isSymbolicLink() ? run(["hash-object", "-w", "--stdin"], bytes) : run(["hash-object", "-w", "--", path]);
      if (blob !== (file.gitHash ?? file.hash)) throw changed();
      run(["update-index", "--add", "--cacheinfo", mode, blob, path]);
    }
    for (const path of localFilePaths(cwd)) run(["reset", "-q", candidate.head, "--", path]);
    return run(["write-tree"]);
  });
}

/** 所有分支先核对再开始提交；一个分支一个本批提交，推过的提交作为追加边界。 */
export function commitBatch(options: { id: string; name: string; release: string; scratch: string; candidates: CommitCandidate[];
  previous?: BatchCommit[]; save: (records: BatchCommit[]) => void }): BatchCommit[] {
  const records = [...(options.previous ?? [])];
  const plans = options.candidates.map((source) => {
    checkBranchName(source.branch);
    if (gitText(source.cwd, ["branch", "--show-current"]) !== source.branch) throw new Error(`批次工作区分支已变化：${source.cwd}`);
    const expected = checkedTree(source.cwd, source.candidate, options.scratch), current = workingTree(source.cwd, options.scratch);
    if (current.tree !== expected) throw changed();
    return { source, expected, head: current.head };
  });
  for (const { source, expected, head } of plans) {
    const old = records.find((item) => item.branch === source.branch);
    if (old?.commit === head && old.tree === expected) continue; // 重发完成/整合代次变化不制造空追加。
    // 返修合进了最新 release 时，分叉点随之推进；不能压掉已解决冲突的祖先关系。
    const base = gitText(source.cwd, ["merge-base", head, `refs/heads/${options.release}`]);
    const parent = old?.pushed ?? base;
    gitText(source.cwd, ["merge-base", "--is-ancestor", parent, head], "核对推送后的历史边界");
    const prefix = `refs/loop/batches/${options.id}/pre-squash/`;
    const refs = gitText(source.cwd, ["for-each-ref", "--format=%(refname)", prefix]).split("\n").filter(Boolean);
    const sequence = Math.max(0, ...refs.map((ref) => Number(ref.slice(prefix.length)) || 0)) + 1;
    const ref = `${prefix}${sequence}`;
    gitText(source.cwd, ["-c", "core.hooksPath=/dev/null", "update-ref", ref, head, "0".repeat(head.length)]);
    const history = [...(old?.preSquash ?? []), ref];
    const message = `${branchType(source.branch)}: ${options.name}\n\n批次：${options.name}\n${old?.pushed ? "推送后的追加改动\n" : ""}${source.conclusions.join("\n")}\n\n中间历史：\n${history.join("\n")}`;
    const parents = ["-p", parent];
    if (old?.pushed && gitText(source.cwd, ["merge-base", parent, base]) !== base) parents.push("-p", base);
    const commit = gitText(source.cwd, ["-c", "core.hooksPath=/dev/null", "commit-tree", expected, ...parents, "-m", message]);
    const latest = workingTree(source.cwd, options.scratch);
    if (latest.head !== head || latest.tree !== expected) throw changed();
    const indexPath = gitText(source.cwd, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
    const index = existsSync(indexPath) ? readFileSync(indexPath) : undefined;
    gitText(source.cwd, ["-c", "core.hooksPath=/dev/null", "update-ref", `refs/heads/${source.branch}`, commit, head]);
    try {
      if (gitText(source.cwd, ["rev-parse", `${commit}^{tree}`]) !== expected) throw new Error("压缩后的树与候选树不一致");
      gitText(source.cwd, ["-c", "core.hooksPath=/dev/null", "read-tree", expected]);
    } catch (error) {
      gitText(source.cwd, ["-c", "core.hooksPath=/dev/null", "update-ref", `refs/heads/${source.branch}`, head, commit], "恢复压缩前分支");
      if (index) writeFileSync(indexPath, index); else rmSync(indexPath, { force: true });
      throw new Error(`${String(error)}；已恢复到 ${ref}，暂停，未进合入队列`);
    }
    const record: BatchCommit = { branch: source.branch, cwd: source.cwd, base, commit, tree: expected, preSquash: history, ...(old?.pushed ? { pushed: old.pushed } : {}) };
    const at = records.findIndex((item) => item.branch === source.branch);
    if (at < 0) records.push(record); else records[at] = record;
    options.save(records);
  }
  return records;
}
