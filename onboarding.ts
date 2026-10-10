/**
 * onboarding.ts — 接入自动验收：接入手册（README-验收标准.md）里的复制块、项目里的目标文件、
 * 写法段是缺失还是过期、给用户的「把【块 N】复制到 <完整路径>」提示和「需要你做的事」清单。
 * 宿主 Hook、pi 扩展和接入命令共用；块的内容只在接入手册里维护一份。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AcceptanceRecord, Criteria } from "./acceptance-core.ts";
import { EXT_DIR, MARKER_FILE, type AcceptanceConfig } from "./config.ts";

export const GUIDE_DOC = join(EXT_DIR, "README-验收标准.md");
export const SETUP_SCRIPT = join(EXT_DIR, "setup-acceptance.ts");

export type BlockId = 1 | 2 | 3;
/** 写法段的起止标记；起始标记带版本号。 */
export const BLOCK_START = /<!--\s*autoreview:acceptance\s+v(\d+)/;
export const BLOCK_END = "<!-- /autoreview:acceptance -->";
/** 标记出现之前手抄的旧写法段（只有标题，没有版本），算第 0 版。 */
const LEGACY_HEADING = /^##\s*起草需求时写验收标准（自动验收）\s*$/m;

/** 取接入手册里「## 【块 N】」标题后的第一个代码块（不含围栏）。 */
export function extractBlock(doc: string, id: BlockId): string | undefined {
  const lines = doc.split(/\r?\n/);
  const heading = lines.findIndex((line) => line.startsWith(`## 【块 ${id}】`));
  if (heading < 0) return undefined;
  const open = lines.findIndex((line, index) => index > heading && /^(`{3,})/.test(line));
  if (open < 0) return undefined;
  const fence = /^(`{3,})/.exec(lines[open])![1];
  const close = lines.findIndex((line, index) => index > open && line.trim() === fence);
  return close < 0 ? undefined : lines.slice(open + 1, close).join("\n");
}

export function readBlock(id: BlockId): string {
  const block = extractBlock(readFileSync(GUIDE_DOC, "utf8"), id);
  if (block === undefined) throw new Error(`接入手册里找不到【块 ${id}】：${GUIDE_DOC}`);
  return block;
}

/** 文本里写法段的版本：有标记取标记上的版本，只有旧标题算 0，都没有返回 undefined。 */
export function blockVersion(text: string): number | undefined {
  const marked = BLOCK_START.exec(text);
  if (marked) return Number(marked[1]);
  return LEGACY_HEADING.test(text) ? 0 : undefined;
}

export type HostKind = "claude" | "codex" | "pi" | string;

/** 头脑风暴的模型读哪个文件：Codex、pi 读 AGENTS.md；Claude Code 读 CLAUDE.md，除非它用 @AGENTS.md 引入。 */
export function conventionTarget(root: string, host: HostKind): string {
  if (host !== "claude") return join(root, "AGENTS.md");
  const claude = join(root, "CLAUDE.md");
  const imports = existsSync(claude) && /^\s*@AGENTS\.md\s*$/m.test(readFileSync(claude, "utf8"));
  return imports ? join(root, "AGENTS.md") : claude;
}

export interface ConventionStatus {
  file: string;
  status: "缺失" | "旧版" | "最新";
  version?: number;
  latest: number;
}

export function conventionStatus(root: string, host: HostKind): ConventionStatus {
  const file = conventionTarget(root, host);
  const latest = blockVersion(readBlock(1)) ?? 0;
  const version = existsSync(file) ? blockVersion(readFileSync(file, "utf8")) : undefined;
  const status = version === undefined ? "缺失" : version < latest ? "旧版" : "最新";
  return { file, status, version, latest };
}

/** 「把接入手册的【块 N】复制到 <目标>，然后 …」；块 3 是在目录里执行。 */
export function copyNotice(id: BlockId, target: string, then = "", project?: string): string {
  const action = id === 3
    ? `在 ${target} 里执行 ${GUIDE_DOC} 的【块 3】（安装 Playwright 和 Chromium）`
    : `把 ${GUIDE_DOC} 的【块 ${id}】复制到 ${target}`;
  const setup = project && id !== 3 ? `。也可以直接跑：node ${SETUP_SCRIPT} ${project}` : "";
  return `${action}${then ? `，然后${then}` : ""}${setup}`;
}

/** 写法段缺失或过期时的提醒；最新时返回 undefined。 */
export function conventionNotice(root: string, host: HostKind): string | undefined {
  const status = conventionStatus(root, host);
  if (status.status === "最新") return undefined;
  if (status.status === "缺失") {
    return `自动验收：项目里还没有「验收标准」写法，头脑风暴时模型不会把标准写进需求。${copyNotice(1, `${status.file} 末尾`, "", root)}`;
  }
  return `自动验收：${status.file} 里的「验收标准」写法是旧版（v${status.version}，最新 v${status.latest}）。`
    + `把 ${GUIDE_DOC} 的【块 1】整段替换进去（从标记到标记）。也可以直接跑：node ${SETUP_SCRIPT} ${root}`;
}

export function configFile(acceptance: AcceptanceConfig): string {
  return join(acceptance.root, MARKER_FILE);
}

const RESUME = "再给开发方发一条消息继续";

/** 无法验收时给你的下一步：按卡住的原因指到具体的块和文件。 */
export function blockerHint(record: AcceptanceRecord, workDir: string, acceptance: AcceptanceConfig): string {
  switch (record.blocker) {
    case "没配启动":
      return copyNotice(2, configFile(acceptance), `改好启动命令和端口，${RESUME}`, acceptance.root);
    case "缺工具":
      return copyNotice(3, workDir, RESUME);
    case "验收方":
      return `验收方没按要求留证据或输出格式不对${record.escalated ? "（已换强模型重验，仍然不行）" : ""}，原因见总结；${RESUME}，会重新验收`;
    default:
      return `全部标准都没能验证，多半是环境问题（数据库、测试账号等）或标准写得含糊：修好环境，或给开发方发一条带「## 验收标准」的新消息；${RESUME}`;
  }
}

/** 部分验证时的提醒：哪些条目要你人工验收。 */
export function manualHint(record: AcceptanceRecord | undefined): string | undefined {
  if (record?.verdict !== "部分验证") return undefined;
  const ids = record.items.filter((item) => item.verdict === "无法验证").map((item) => item.id).join("、");
  return `${ids} 没能自动验证，需要你人工验收（原因见总结「需要你做的事」）`;
}

export interface TodoInput {
  acceptance?: AcceptanceConfig;
  host: HostKind;
  phase: string;
  pauseHint?: string;
  criteria?: Criteria;
  lastAcceptance?: AcceptanceRecord;
}

/** 总结开头「需要你做的事」：暂停时怎么继续、要人工验收的条目、自动起草的标准、写法段缺失或过期。 */
export function acceptanceTodos(input: TodoInput): string[] {
  const todos: string[] = [];
  if (input.phase === "paused" && input.pauseHint) todos.push(input.pauseHint);
  if (!input.acceptance) return todos;
  const record = input.lastAcceptance;
  if (record?.verdict === "部分验证") {
    for (const item of record.items.filter((entry) => entry.verdict === "无法验证")) {
      todos.push(`人工验收 ${item.id}（${item.text.split("\n")[0]}）：程序没能自动验证，${item.detail}`);
    }
  }
  if (input.criteria?.source === "自动起草") {
    todos.push("验收标准是自动起草的（见下面「验收标准」一节）：不满意就给开发方发一条带「## 验收标准」的消息替换");
  }
  try {
    const notice = conventionNotice(input.acceptance.root, input.host);
    if (notice) todos.push(notice.replace(/^自动验收：/, ""));
  } catch { /* 接入手册读不到时不提醒 */ }
  return todos;
}
