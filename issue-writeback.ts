/** 问题单回写是附带动作：仓库内开工预写，仓库外合入后写；失败只作提示。 */
import { randomUUID } from "node:crypto";
import { accessSync, constants, lstatSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { gitResult, worktrees } from "./workspace.ts";
import { deliveryLedgerPath } from "./ledger.ts";

export interface IssueWriteback {
  path: string;
  repoPath?: string;
  status: "planned" | "prepared" | "external" | "written" | "skipped" | "failed";
  detail: string;
  /** 开工实际写入的整行；只用它消除程序状态行带来的文本冲突。 */
  stateLine?: string;
}

export function parseIssuePaths(value: unknown, planDir: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((path) => typeof path !== "string" || !path.trim() || /[\r\n\0]/.test(path))) {
    throw new Error("issues 必须是非空路径字符串的数组");
  }
  return [...new Set(value.map((path: string) => resolve(planDir, path.trim())))];
}

const within = (root: string, path: string): string | undefined => {
  const rel = relative(root, path);
  return rel && !isAbsolute(rel) && rel !== ".." && !rel.startsWith("../") ? rel : undefined;
};

/** 只认第一个正文二级标题之前、独占一行的单头状态；不搜索或改写正文。 */
function stateField(content: string): RegExpMatchArray {
  // 用原文偏移；标题只界定范围，不参与替换。
  const end = /^## /m.exec(content)?.index ?? content.length;
  const fields = [...content.slice(0, end).matchAll(/^状态[：:][^\r\n]*/gm)];
  if (fields.length !== 1) throw new Error("单头没有唯一的「状态：」行，不会回写");
  return fields[0];
}
function replaceState(content: string, line: string): string {
  const field = stateField(content), start = field.index!;
  return content.slice(0, start) + line + content.slice(start + field[0].length);
}
function pendingLine(batch: string): string {
  return `状态：已合入待验·${batch.replace(/[\r\n]/g, " ")}；未验证项见本批交付总表（${deliveryLedgerPath()}，按批次名查找）或 Loop 总结。`;
}

/** 不跟随问题单或父目录中的链接，也不通过硬链接改写别处。 */
function regularFile(path: string, writable = false): void {
  for (let parent = path;; parent = dirname(parent)) {
    const info = lstatSync(parent);
    if (info.isSymbolicLink()) throw new Error(`路径是符号链接：${parent}`);
    if (parent === path && (!info.isFile() || info.nlink !== 1)) throw new Error("不是独立的普通文件");
    if (parent === path && writable && !(info.mode & 0o222)) throw new Error("文件只读，写不进去");
    if (dirname(parent) === parent) break;
  }
  if (writable) accessSync(path, constants.W_OK);
}
/** 同目录临时文件写全后替换，避免写失败截断原单；不覆盖等待期间的新正文。 */
function writeIssue(path: string, content: string, expected: string): void {
  regularFile(path, true);
  const temp = join(dirname(path), `.loop-issue-${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, content, { flag: "wx", mode: lstatSync(path).mode & 0o777 });
    if (readFileSync(path, "utf8") !== expected) throw new Error("问题单在回写期间变化，保留新内容，不会回写");
    renameSync(temp, path);
  } finally { rmSync(temp, { force: true }); }
}
function tracked(root: string, path: string): void {
  const result = gitResult(root, ["--literal-pathspecs", "ls-files", "--error-unmatch", "--", path]);
  if (result.status !== 0) throw new Error("文件未纳入本仓库，不会回写");
}
function reason(error: unknown): string {
  return (error as NodeJS.ErrnoException).code === "ENOENT" ? "找不到文件，不会回写" : String(error);
}
export function issueWritebackLines(issues: readonly IssueWriteback[] = []): string[] {
  return issues.map((issue) => `问题单：${issue.path}；${issue.detail}`);
}

/** 返回确定的前后内容供搬运校验；撤销函数仅归还本次预写，不碰运行版。 */
export function prepareIssueWritebacks(paths: readonly string[], repo: string, target: string | undefined, batch: string, dryRun: boolean) {
  const issues: IssueWriteback[] = [], files: string[] = [];
  const saved = new Map<string, { before: string; after: string }>();
  const roots = paths.length ? worktrees(repo).map((item) => item.path) : [];
  const rollbackFile = (rel: string): void => {
    const path = resolve(target!, rel);
    const change = saved.get(rel)!;
    writeIssue(path, change.before, change.after);
    const reset = gitResult(target!, ["--literal-pathspecs", "reset", "-q", "HEAD", "--", rel]);
    if (reset.status !== 0) throw new Error(reset.stderr || reset.stdout);
  };
  for (const path of paths) {
    const root = roots.find((root) => within(root, path));
    const rel = root && within(root, path);
    if (rel && issues.some((issue) => issue.repoPath === rel)) continue;
    const issue: IssueWriteback = { path: rel ? resolve(repo, rel) : path, ...(rel ? { repoPath: rel } : {}), status: "skipped", detail: "" };
    issues.push(issue);
    try {
      regularFile(path);
      if (!rel) {
        issue.status = "external"; issue.detail = "仓库外问题单，开工不写；合入目标分支成功后直接回写，失败不阻断";
        continue;
      }
      if (rel === ".git" || rel.startsWith(".git/")) throw new Error("Git 元数据不是问题单，不会回写");
      tracked(root!, rel);
      if (!target) throw new Error("没有可随批次提交的开发空间，不会回写");
      // dry-run 尚未建 worktree 时，只读目标分支来源；真正写入前再核对目标。
      const destination = dryRun ? path : resolve(target, rel);
      regularFile(destination, true);
      if (!dryRun) tracked(target, rel);
      const original = readFileSync(destination, "utf8"), line = pendingLine(batch);
      const updated = replaceState(original, line);
      issue.stateLine = line;
      if (!dryRun && updated !== original) {
        saved.set(rel, { before: original, after: updated });
        try {
          writeIssue(destination, updated, original);
          const add = gitResult(target, ["--literal-pathspecs", "add", "--", rel]);
          if (add.status !== 0) throw new Error(add.stderr || add.stdout);
        } catch (error) {
          if (readFileSync(destination, "utf8") === updated) rollbackFile(rel);
          saved.delete(rel); throw error;
        }
        files.push(rel);
      }
      issue.status = dryRun ? "planned" : "prepared";
      issue.detail = dryRun ? "将随批次文档预写「已合入待验」，未执行" : "已随批次文档预写「已合入待验」，随合入生效；撤回即恢复";
    } catch (error) { issue.detail = `${reason(error)}；仅提示，不阻断开工或合入`; }
  }
  return { issues, files, changes: saved, rollback(error: unknown) {
    for (const [rel] of saved) {
      rollbackFile(rel);
      const issue = issues.find((item) => item.repoPath === rel)!;
      issue.status = "failed"; issue.detail = `未能随批次文档提交，不会回写：${reason(error)}；仅提示，不阻断`;
    }
    saved.clear(); // 已撤销的状态替换不能再进入搬运文档的校验期望。
  } };
}

/** 一次合入的结果单独保存，重复收尾不重写用户后来验收/关闭的单子。 */
export function finishIssueWritebacks(issues: readonly IssueWriteback[], batch: string): IssueWriteback[] {
  return issues.map((original) => {
    const issue = { ...original };
    if (issue.status === "prepared") return { ...issue, status: "written", detail: "单头回写已随本批提交进入目标分支；未验证项见本批交付总表或总结" };
    if (issue.status !== "external") return issue;
    try {
      regularFile(issue.path, true);
      const content = readFileSync(issue.path, "utf8");
      const updated = replaceState(content, pendingLine(batch));
      if (updated !== content) writeIssue(issue.path, updated, content);
      issue.status = "written"; issue.detail = "合入成功后已直接回写仓库外单头；未验证项见本批交付总表或总结";
    } catch (error) { issue.status = "failed"; issue.detail = `仓库外单头没写进去：${reason(error)}；仅提示，不影响已成功的合入`; }
    return issue;
  });
}

/** 只在队列测试前消除自动状态行引起的冲突；真正的正文/状态分歧仍交回开发方。 */
export function resolveIssueStatusConflicts(workspace: string, issues: readonly IssueWriteback[] = []): void {
  for (const issue of issues) {
    if (issue.status !== "prepared" || !issue.repoPath || !issue.stateLine) continue;
    const rel = issue.repoPath;
    const unmerged = gitResult(workspace, ["--literal-pathspecs", "ls-files", "-u", "--", rel]);
    if (unmerged.status !== 0 || !unmerged.stdout.trim()) continue;
    const modes = unmerged.stdout.trim().split("\n").map((line) => line.split(" ")[0]);
    if (modes.length !== 3 || modes.some((mode) => mode !== modes[0] || !/^100(644|755)$/.test(mode))) continue;
    const versions = [1, 2, 3].map((stage) => gitResult(workspace, ["show", `:${stage}:${rel}`]));
    if (versions.some((result) => result.status !== 0)) continue;
    const [base, ours, theirs] = versions.map((result) => result.stdout);
    let normalizedOurs = ours, normalizedTheirs = theirs;
    try {
      const before = stateField(base)[0], left = stateField(ours)[0], right = stateField(theirs)[0];
      if (left === before && right === issue.stateLine) normalizedTheirs = replaceState(theirs, before);
      else if (left === issue.stateLine && right === before) normalizedOurs = replaceState(ours, before);
      else continue;
    } catch { continue; }
    const temp = mkdtempSync(join(tmpdir(), "loop-issue-merge-"));
    try {
      const paths = ["ours", "base", "theirs"].map((name) => join(temp, name));
      [normalizedOurs, base, normalizedTheirs].forEach((content, index) => writeFileSync(paths[index], content));
      const merged = gitResult(workspace, ["merge-file", "-p", ...paths]);
      if (merged.status !== 0) continue;
      regularFile(resolve(workspace, rel), true);
      writeFileSync(resolve(workspace, rel), replaceState(merged.stdout, issue.stateLine));
      const add = gitResult(workspace, ["--literal-pathspecs", "add", "--", rel]);
      if (add.status !== 0) throw new Error(add.stderr || add.stdout);
    } finally { rmSync(temp, { recursive: true, force: true }); }
  }
}
