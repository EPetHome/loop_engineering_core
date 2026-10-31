/** 生产 Loop 的动作过滤、渐进指路及会话去重。只依赖 Node；命中配置后才加载校验器。 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface Touched { paths: string[]; command?: string }
type Kind = "batch" | "config" | "guide";
export interface ProductionAction { files: { path: string; kind: Kind; root: string }[]; roots: string[] }
const LOOP_ROOT = dirname(fileURLToPath(import.meta.url));

/** 标题用真实完整标题，测试逐一核对；指路卡正文只维护这一份。 */
export const PRODUCTION_RULES = [
  { file: "README-验收标准.md", sections: ["【块 1】验收标准、任务提示词与收尾回写的写法 → 复制到项目的 `.autoreview/CONVENTIONS.md`", "起草任务提示词（自动评审 v2）"], description: "任务提示词与验收标准" },
  { file: "README.md", sections: ["流水线与批次（几段并行 / 串行 + e2e 收尾）", "开工、启动、状态与合入（bin/loop）"], description: "批次配置与开工、启动、合入" },
  { file: "项目文档/运行与维护.md", sections: ["项目配置示例", "迁移与检查"], description: "项目配置、方法与迁移" },
] as const;
const ruleLine = (index: number): string => {
  const rule = PRODUCTION_RULES[index];
  return `${join(LOOP_ROOT, rule.file)}「${rule.sections.join("」「")}」`;
};

function pathKind(path: string): Kind | undefined {
  if (/(?:^|\/)\.autoreview\.json$/.test(path)) return "config";
  if (/(?:^|\/)docs\/batches\/.+\/批次\.json$/.test(path)) return "batch";
  if (/(?:^|\/)\.autoreview\/methods\/.+/.test(path) || /(?:^|\/)prompt\/提示词-[^/]+\.md$/.test(path)) return "guide";
  return undefined;
}

/** 不解析配置；只在字符串候选命中后查项目标记。 */
function projectRoot(path: string): string | undefined {
  let dir = path;
  for (;;) {
    if (existsSync(join(dir, ".autoreview.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

interface ShellWord { text: string; heredoc?: boolean }

/** 小型 shell 词法器：heredoc 正文原样挂在所属命令的输入位置，不再按 shell 拆词/去引号。 */
function shellWords(command: string): ShellWord[] {
  const words: ShellWord[] = [];
  const pending: { token: ShellWord; stripTabs: boolean }[] = [];
  let word = "", quote = "", escaped = false, started = false;
  let delimiter: { stripTabs: boolean } | undefined;
  const flush = (): void => {
    if (started) {
      const token = { text: word };
      words.push(token);
      if (delimiter) { pending.push({ token, ...delimiter }); delimiter = undefined; }
    }
    word = ""; started = false;
  };
  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    if (escaped) { word += char; escaped = false; continue; }
    if (char === "\\" && quote !== "'") { escaped = true; started = true; continue; }
    if (quote) { if (char === quote) quote = ""; else word += char; continue; }
    if (char === "'" || char === '"') { quote = char; started = true; continue; }
    if (char === "#" && !started) {
      const newline = command.indexOf("\n", index);
      index = newline < 0 ? command.length : newline - 1; // 注释中的 << 不登记为输入。
    } else if (char === "\n") {
      flush();
      let cursor = index + 1;
      for (const { token, stripTabs } of pending) {
        const start = cursor;
        let end = cursor;
        while (cursor < command.length) {
          const newline = command.indexOf("\n", cursor), lineEnd = newline < 0 ? command.length : newline;
          const line = command.slice(cursor, lineEnd).replace(/\r$/, "");
          end = cursor;
          cursor = newline < 0 ? command.length : newline + 1;
          if ((stripTabs ? line.replace(/^\t+/, "") : line) === token.text) break;
          end = cursor;
        }
        const body = command.slice(start, end);
        token.text = stripTabs ? body.replace(/^\t+/gm, "") : body;
        token.heredoc = true;
      }
      pending.length = 0;
      words.push({ text: ";" }); index = cursor - 1;
    } else if (/\s/.test(char)) flush();
    else if (command.startsWith("<<<", index)) {
      flush(); words.push({ text: "<<<" }); index += 2; // here-string 不是 heredoc。
    } else if (command.startsWith("<<", index)) {
      flush(); words.push({ text: "<<" });
      delimiter = { stripTabs: command[index + 2] === "-" };
      index += delimiter.stripTabs ? 2 : 1;
    } else if (/[;&|<>]/.test(char)) { flush(); words.push({ text: char }); }
    else { word += char; started = true; }
  }
  flush();
  for (const { token } of pending) { token.text = ""; token.heredoc = true; }
  return words;
}

/** 从参数及内联脚本的字符串常量中取路径；不扫描磁盘猜测脚本的副作用。 */
function pathCandidates(words: string[]): string[] {
  return words.flatMap((word) => [word, ...(/\s/.test(word) ? shellWords(word).map((token) => token.text) : []), ...[...word.matchAll(/["'`]([^"'`\n]+)["'`]/g)].map((match) => match[1])])
    .map((word) => word.replace(/^(?:--[^=]+=)/, ""));
}

export function productionAction(touched: Touched, cwd = process.cwd()): ProductionAction | undefined {
  const files = new Map<string, ProductionAction["files"][number]>(), roots = new Set<string>();
  const add = (value: string, base: string): void => {
    const path = resolve(base, value), kind = pathKind(path); // 范围外连文件系统都不访问。
    if (!kind) return;
    const root = kind === "config" ? dirname(path) : projectRoot(dirname(path));
    if (!root) return;
    // methods 必须属于标记根；嵌套目录中的同名业务路径不是项目方法。
    if (kind === "guide" && path.includes("/.autoreview/methods/") && !relative(root, path).startsWith(".autoreview/methods/")) return;
    files.set(path, { path, kind, root }); roots.add(root);
  };
  for (const path of touched.paths) add(path, cwd);
  if (touched.command) {
    let base = resolve(cwd), segment: ShellWord[] = [];
    const visit = (): void => {
      if (!segment.length) return;
      let words = segment.map((token) => token.text);
      const bodies = segment.filter((token) => token.heredoc).map((token) => token.text);
      while (words[0] && (/^[A-Za-z_]\w*=/.test(words[0]) || ["env", "command", "exec"].includes(words[0]))) words = words.slice(1);
      const cmd = words[0] ?? "";
      if (cmd === "cd" && words[1]) { base = resolve(base, words[1]); segment = []; return; }
      const redirects = words.some((word) => word === ">");
      const name = cmd.split("/").at(-1) ?? "";
      const shell = ["bash", "sh", "zsh"].includes(name);
      const scriptIndex = shell ? words.findIndex((word) => /^-[a-z]*c$/.test(word)) : -1;
      const scripts = scriptIndex >= 0 && words[scriptIndex + 1] ? [words[scriptIndex + 1]] : shell ? bodies : [];
      if (scripts.length) {
        for (const script of scripts) {
          const nested = productionAction({ paths: [], command: script }, base);
          for (const file of nested?.files ?? []) { files.set(file.path, file); roots.add(file.root); }
          for (const root of nested?.roots ?? []) roots.add(root);
        }
        for (const target of words.filter((_, index) => index > 0 && words[index - 1] === ">")) add(target, base);
        segment = []; return;
      }
      const launcher = /(?:^|\/)bin\/(?:loop|pi-dev)$/.test(cmd)
        || (shell && /(?:^|\/)bin\/(?:loop|pi-dev)$/.test(words[1] ?? ""));
      const inlineRead = /(?:readFile(?:Sync)?|read_text|read_bytes|json\.load|print|console\.(?:log|info|error))\s*\(/.test(words.join(" "))
        && !/(?:write|append|rename|replace|unlink|remove|mkdir|open)\w*\s*\(/.test(words.join(" "));
      const readOnly = ["cat", "head", "tail", "less", "more", "ls", "find", "rg", "grep", "pwd", "stat", "test", "wc", "diff", "git", "jq"].includes(name)
        || (["sed", "awk", "yq"].includes(name) && !words.some((word) => /^-i/.test(word)))
        || ["echo", "printf"].includes(name) || inlineRead;
      if ((!readOnly || redirects) && !launcher) {
        // 只读命令带重定向时只看输出目标，不把读取的配置当成写入。
        const targets = readOnly ? words.filter((_, index) => index > 0 && words[index - 1] === ">") : words;
        for (const path of pathCandidates(targets)) add(path, base);
      }
      if (launcher) {
        const root = projectRoot(base);
        if (root) roots.add(root);
      }
      segment = [];
    };
    for (const word of shellWords(touched.command)) {
      if (!word.heredoc && [";", "&", "|"].includes(word.text)) visit(); else segment.push(word);
    }
    visit();
  }
  return roots.size ? { files: [...files.values()], roots: [...roots] } : undefined;
}

function hasBatch(root: string): boolean {
  // 状态口径是仓库内 docs/batches/*/批次.json，不看解析默认值。
  const batches = join(root, "docs", "batches");
  try { return readdirSync(batches, { withFileTypes: true }).some((entry) => entry.isDirectory() && existsSync(join(batches, entry.name, "批次.json"))); }
  catch { return false; }
}

export function productionCard(roots: string[]): string {
  const lines = ["Loop 规则按需读：", ...PRODUCTION_RULES.map((rule, index) => `- ${rule.description} → ${ruleLine(index)}`),
    "合入走 bin/loop 合入（合入队列），不要在会话里手动 git 合并。"];
  const unmigrated = roots.filter((root) => {
    try {
      const raw = JSON.parse(readFileSync(join(root, ".autoreview.json"), "utf8"));
      return raw && typeof raw === "object" && !["release", "workspaces", "methods"].some((key) => Object.hasOwn(raw, key)) && !hasBatch(root);
    } catch { return false; } // 配置错误由程序校验报告，不猜项目状态。
  });
  if (unmigrated.length) lines.push(`本项目未接入批次流程，迁移见「迁移与检查」（${unmigrated.join("、")}）。`);
  return lines.join("\n");
}

function statePath(host: string, session: string | undefined): string | undefined {
  if (!session?.trim()) return undefined; // 不把缺 ID 的不同会话混为同一个 unknown。
  const hash = createHash("sha256").update(JSON.stringify([host, session])).digest("hex");
  return join(homedir(), ".pi-autoreview", "production-loop", hash);
}

export function resetProductionCard(host: string, session: string | undefined): void {
  const path = statePath(host, session);
  if (path) rmSync(join(path, "card"), { force: true }); // 只清指路标记，保留本会话报错去重。
}

export async function productionContext(action: ProductionAction, host: string, session: string | undefined): Promise<string | undefined> {
  const path = statePath(host, session);
  if (path) mkdirSync(path, { recursive: true, mode: 0o700 });
  // wx 原子占位，宿主并行工具也不会重复注入；各标记独立，无需长锁或清理猜测进程。
  const claim = (name: string): boolean => {
    if (!path) return true;
    try { writeFileSync(join(path, name), "", { flag: "wx", mode: 0o600 }); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return false; throw error; }
  };
  const output: string[] = [];
  if (claim("card")) output.push(productionCard(action.roots));
  const configFiles = action.files.filter((file) => file.kind !== "guide");
  if (configFiles.length) {
    const { validateProductionFile } = await import("./production-loop-validation.ts");
    for (const file of configFiles) {
      if (!existsSync(file.path)) continue; // 删除/移动前的旧路径不校验。
      for (const report of await validateProductionFile(file)) {
        const key = createHash("sha256").update(JSON.stringify([file.path, report])).digest("hex");
        if (!claim(key)) continue;
        output.push(`${file.path}：\n${report}\n规则见 ${ruleLine(file.kind === "batch" ? 1 : 2)}。`);
      }
    }
  }
  return output.length ? output.join("\n\n") : undefined;
}
