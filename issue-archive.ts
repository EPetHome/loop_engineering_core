/** 已由用户核销的单子自动归档；不把合入或测试通过当成关单。 */
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { eventLock } from "./events.ts";
import { regularFile, stateField, writeIssue } from "./issue-writeback.ts";

export const ISSUE_HISTORY = "【history】";
const closed = (text: string): boolean => {
  try { return /^状态[：:]\s*已解决(?:[（(；;·\s]|$)/.test(stateField(text)[0]) && /关闭原因[：:]\s*(?:完成|重复|不做)/.test(stateField(text)[0]); }
  catch { return false; }
};
const ignored = new Set([".git", ".bak", "temp", "node_modules", ".venv", "venv", "target", "dist", "build", ".next", "test", "tests", "eval", "runtime", "runs", "batches", "xx", "xxx", "【已完成】", "原始证据", "备份", "raw", "example", "samples", "data"]);

/** 只改当前 Markdown 与来源配置；嵌套工程仅检查配置，不扫描其业务文件。 */
function referenceFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isFile() && !entry.name.startsWith("提示词-") && (entry.name.endsWith(".md") || entry.name === ".autoreview.json")) files.push(path);
      if (entry.isDirectory() && entry.name === "eval") {
        for (const name of ["README.md", "判定点.md"]) if (existsSync(join(path, name))) files.push(join(path, name));
      }
      if (!entry.isDirectory() || ignored.has(entry.name) || entry.name.startsWith(".")) continue;
      if (existsSync(join(path, ".git")) || existsSync(join(path, ".autoreview.json"))) {
        if (existsSync(join(path, ".autoreview.json"))) files.push(join(path, ".autoreview.json"));
      } else walk(path);
    }
  };
  walk(root);
  return files;
}

/** 移动单子时重算相对链接；其他文件只替换实际指向该单的引用。 */
export function archiveReferences(text: string, from: string, to: string, moves: ReadonlyMap<string, string>): string {
  const target = (value: string): string => {
    const split = value.indexOf("#"), path = split < 0 ? value : value.slice(0, split), anchor = split < 0 ? "" : value.slice(split);
    if (!path || /^[a-z][a-z\d+.-]*:/i.test(path)) return value;
    let decoded: string;
    try { decoded = decodeURIComponent(path); } catch { return value; }
    const old = resolve(dirname(from), decoded), next = moves.get(old) ?? old;
    if (next === old && dirname(from) === dirname(to)) return value;
    return (isAbsolute(decoded) ? next : relative(dirname(to), next)) + anchor;
  };
  let result = text.replace(/(\[[^\]\n]*\]\()(<[^>\n]+>|[^)\n]+)(\))/g, (all, before: string, value: string, after: string) => {
    const angled = value.startsWith("<") && value.endsWith(">");
    const raw = angled ? value.slice(1, -1) : value, next = target(raw);
    return next === raw ? all : `${before}${angled || next.includes(" ") ? `<${next}>` : next}${after}`;
  });
  if (from !== to) result = result.replace(/`(\.\.\/[^`\n]+)`/g, (_all, value: string) => `\`${target(value)}\``);
  for (const [old, next] of moves) {
    result = result.replaceAll(old, next).replaceAll(encodeURI(old), encodeURI(next));
    result = result.replaceAll(`issues/${basename(old)}`, `issues/${ISSUE_HISTORY}/${basename(old)}`);
  }
  return result;
}

/** 先完整准备、检查引用再删除旧路径；失败保留或恢复原文，不覆盖同名归档。 */
export function archiveResolvedIssues(root: string, dryRun = false, paths?: readonly string[]): { ok: boolean; archived: string[]; lines: string[] } {
  root = resolve(root);
  const issues = join(root, "issues"), history = join(issues, ISSUE_HISTORY);
  const archived: string[] = [], lines: string[] = [];
  if (!existsSync(issues)) return { ok: true, archived, lines };
  if (lstatSync(issues).isSymbolicLink() || !lstatSync(issues).isDirectory()) return { ok: false, archived, lines: ["问题单目录不是普通目录，未归档"] };
  let unlock: (() => void) | undefined;
  type Change = { from: string; to: string; before: string; after: string; mode: number };
  const changes: Change[] = [], written: Change[] = [];
  try {
    for (let dir = issues;; dir = dirname(dir)) {
      if (lstatSync(dir).isSymbolicLink()) throw new Error(`目录经过符号链接，未归档：${dir}`);
      if (dirname(dir) === dir) break;
    }
    if (!dryRun) unlock = eventLock(join(issues, ".archive.lock"), 500);
    const moves = new Map<string, string>();
    for (const entry of readdirSync(issues, { withFileTypes: true })) {
      if (!entry.isFile() || !/^【(?:bug|req)】.+\.md$/.test(entry.name)) continue;
      const from = join(issues, entry.name);
      if (paths && !paths.includes(from)) continue;
      regularFile(from);
      if (closed(readFileSync(from, "utf8"))) moves.set(from, join(history, entry.name));
    }
    if (!moves.size) return { ok: true, archived, lines };
    if (existsSync(history) && (lstatSync(history).isSymbolicLink() || !lstatSync(history).isDirectory())) throw new Error("归档目标不是普通目录");
    for (const to of moves.values()) if (existsSync(to)) throw new Error(`归档已有同名文件，保留两边：${to}`);
    for (const from of referenceFiles(root)) {
      const to = moves.get(from) ?? from, before = readFileSync(from, "utf8"), after = archiveReferences(before, from, to, moves);
      if (from === to && before === after) continue;
      regularFile(from, true);
      changes.push({ from, to, before, after, mode: lstatSync(from).mode & 0o777 });
    }
    for (const from of moves.keys()) if (!changes.some((item) => item.from === from)) throw new Error(`问题单未进入归档计划：${from}`);
    if (dryRun) return { ok: true, archived: [...moves.values()], lines: [...moves.values()].map((path) => `将归档：${path}`) };
    if (!existsSync(history)) mkdirSync(history);
    for (const item of changes) if (readFileSync(item.from, "utf8") !== item.before) throw new Error(`归档期间文件变化，未覆盖：${item.from}`);
    // 先放好完整归档副本，引用更新完成后才移除原文件。
    for (const item of changes.filter((item) => item.from !== item.to)) {
      writeFileSync(item.to, item.after, { flag: "wx", mode: item.mode }); written.push(item);
    }
    for (const item of changes.filter((item) => item.from === item.to)) {
      writeIssue(item.from, item.after, item.before); written.push(item);
    }
    for (const item of changes.filter((item) => item.from !== item.to)) {
      if (readFileSync(item.from, "utf8") !== item.before) throw new Error(`归档期间问题单变化，保留新内容：${item.from}`);
      unlinkSync(item.from); archived.push(item.to);
    }
    return { ok: true, archived, lines: archived.map((path) => `问题单已归档：${path}`) };
  } catch (error) {
    for (const item of written.reverse()) {
      try {
        if (item.from === item.to) {
          if (readFileSync(item.from, "utf8") === item.after) writeIssue(item.from, item.before, item.after);
        } else {
          if (!existsSync(item.from)) writeFileSync(item.from, item.before, { flag: "wx", mode: item.mode });
          if (readFileSync(item.from, "utf8") === item.before && readFileSync(item.to, "utf8") === item.after) unlinkSync(item.to);
        }
      } catch { lines.push(`归档恢复未完成，保留现场：${item.from} → ${item.to}`); }
    }
    return { ok: false, archived: [], lines: [`问题单归档未完成：${String(error)}`, ...lines] };
  } finally { unlock?.(); }
}
