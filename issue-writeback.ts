/** 问题单共用安全文件操作与只读历史结构。旧开工预写/队列冲突消解/合入回写已删除。 */
import { randomUUID } from "node:crypto";
import { accessSync, constants, lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
export interface IssueWriteback {
  path: string; repoPath?: string; status: "planned" | "prepared" | "external" | "written" | "skipped" | "failed";
  detail: string; stateLine?: string;
}
/** 历史问题单引用的只读解析，不再参与旧卡执行。 */
export function parseIssuePaths(value: unknown, planDir: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((path) => typeof path !== "string" || !path.trim() || /[\r\n\0]/.test(path))) throw new Error("issues 必须是非空路径字符串的数组");
  return [...new Set(value.map((path: string) => resolve(planDir, path.trim())))];
}
/** 归档器只认第一个正文标题之前、独占一行的唯一单头状态，不搜索/改写正文。 */
export function stateField(content: string): RegExpMatchArray {
  const end = /^## /m.exec(content)?.index ?? content.length, fields = [...content.slice(0, end).matchAll(/^状态[：:][^\r\n]*/gm)];
  if (fields.length !== 1) throw new Error("单头没有唯一的「状态：」行，不会回写");
  return fields[0];
}
/** 不跟随问题单及父目录链接，也不经硬链接改写别处。 */
export function regularFile(path: string, writable = false): void {
  for (let parent = path;; parent = dirname(parent)) {
    const info = lstatSync(parent);
    if (info.isSymbolicLink()) throw new Error(`路径是符号链接：${parent}`);
    if (parent === path && (!info.isFile() || info.nlink !== 1)) throw new Error("不是独立的普通文件");
    if (parent === path && writable && !(info.mode & 0o222)) throw new Error("文件只读，写不进去");
    if (dirname(parent) === parent) break;
  }
  if (writable) accessSync(path, constants.W_OK);
}
/** 同目录完整临时文件 + 原文 CAS；不能覆盖等待期间的新正文。issue-archive.ts 使用。 */
export function writeIssue(path: string, content: string, expected: string): void {
  regularFile(path, true);
  const temp = join(dirname(path), `.loop-issue-${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, content, { flag: "wx", mode: lstatSync(path).mode & 0o777 });
    if (readFileSync(path, "utf8") !== expected) throw new Error("问题单在回写期间变化，保留新内容，不会回写");
    renameSync(temp, path);
  } finally { rmSync(temp, { force: true }); }
}
