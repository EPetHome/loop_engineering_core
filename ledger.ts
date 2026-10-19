/**
 * ledger.ts — 交付总表：会话完成时追加一段，宿主开会话时提醒把结果回写原单。
 *
 * 只追加、不覆盖；每段一次写完。这里只做记录和解析，任何失败都不改变评审/验收状态，
 * 由调用方决定怎么提示。
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { stripCriteriaSection, type AcceptanceRecord } from "./acceptance-core.ts";

export const LEDGER_FILE = "交付记录.md";

/** 总表位置：~/.pi-autoreview/交付记录.md，本机所有项目共用一份。 */
export function deliveryLedgerPath(): string {
  return join(homedir(), ".pi-autoreview", LEDGER_FILE);
}

function canonical(path: string): string {
  try { return realpathSync.native(path); } catch { return resolve(path); }
}

/** 交付记录里的项目路径：Git 顶层目录；没有 Git 时用当前目录。 */
export function projectRootOf(cwd: string): string {
  try {
    const out = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf8", timeout: 2000, maxBuffer: 64 * 1024, stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (out) return canonical(out);
  } catch { /* 不是 Git 或 git 不可用：记当前目录 */ }
  return canonical(cwd);
}

function oneLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max)}…`;
}

/** 任务名：需求第一个标题；没有标题取前 40 字。 */
export function taskTitle(requirement = ""): string {
  let fenced = false;
  // 「## 验收标准」一节不是任务标题的一部分；没有别的标题时取需求前 40 字。
  const source = stripCriteriaSection(requirement);
  for (const line of source.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    const heading = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading?.[1].trim()) return oneLine(heading[1], 120);
  }
  const plain = source
    .replace(/<file\b[^>]*>/gi, "")
    .replace(/<\/file>/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  return oneLine(plain, 40) || "未记录任务";
}

export type PendingKind = "部分验证" | "人工";

export interface PendingItem {
  id: string;
  kind: PendingKind;
  /** 只用于「部分验证」，取与总结相同的逐条验收结果原因。 */
  reason?: string;
}

/** 欠项只从验收的结构化结果取，不解析总结展示文字。 */
export function pendingItems(record?: AcceptanceRecord): PendingItem[] {
  if (!record) return [];
  return record.items.flatMap((item): PendingItem[] => {
    if (item.verdict === "无法验证") {
      const reason = oneLine(item.detail.replace(/^原因[：:]\s*/, ""), 160) || "程序没能自动验证";
      return [{ id: item.id, kind: "部分验证", reason }];
    }
    if (item.verdict === "需人工") return [{ id: item.id, kind: "人工" }];
    return [];
  });
}

export function resultLine(record: AcceptanceRecord | undefined, rounds: number, repairs: number): string {
  const result = record?.verdict === "部分验证" ? "完成（部分验证）" : "完成";
  return `${result}；评审 ${rounds} 次，返修 ${repairs} 次`;
}

export interface LedgerRecord {
  at?: Date;
  project: string;
  session: string;
  task: string;
  result: string;
  summary: string;
  pending: PendingItem[];
}

export function ledgerStamp(date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 一段的完整文本；每段一次写入。 */
export function renderLedgerRecord(record: LedgerRecord): string {
  const lines = [
    `## ${ledgerStamp(record.at)} · ${oneLine(record.project, 500)} · 会话 ${oneLine(record.session, 200)}`,
    `- 任务：${oneLine(record.task, 240)}`,
    `- 结果：${oneLine(record.result, 200)}`,
    `- 总结：${oneLine(record.summary, 1000)}`,
    "- [ ] 已回写原单",
    ...record.pending.map((item) => item.kind === "人工"
      ? `- [ ] ${oneLine(item.id, 40)} 人工`
      : `- [ ] ${oneLine(item.id, 40)} 部分验证：${oneLine(item.reason ?? "程序没能自动验证", 160)}`),
  ];
  return `${lines.join("\n")}\n`;
}

/**
 * 追加一段。用 O_APPEND 一次写入，不读改写整份总表；两个会话同时完成也不会互相覆盖。
 * 目录创建或写入失败直接抛错，由调用方提示，不影响会话完成。
 */
export function appendLedgerRecord(record: LedgerRecord, path = deliveryLedgerPath()): string {
  const text = renderLedgerRecord(record);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // 每段自带结尾空行：O_APPEND 单次写入就能保证段间分隔，两个会话同时完成也不会粘在一起。
  appendFileSync(path, `${text}\n`, { mode: 0o600 });
  return path;
}

/**
 * SessionStart 用：读取失败、不是普通文件或明显过大就跳过提醒。
 * 本地文件读取受 SessionStart 时限约束，这里再做一个便宜的耗时兜底。
 */
export function readLedgerForReminder(path = deliveryLedgerPath(), maxBytes = 8 * 1024 * 1024): string | undefined {
  const started = Date.now();
  try {
    const info = statSync(path);
    if (!info.isFile() || info.size > maxBytes) return undefined;
    const text = readFileSync(path, "utf8");
    return Date.now() - started > 1000 ? undefined : text;
  } catch { return undefined; }
}

export interface LedgerSegment {
  at: string;
  project: string;
  session: string;
  writeback: "checked" | "unchecked" | "none";
}

function writebackState(line: string): "checked" | "unchecked" | undefined {
  const match = /^\s*-\s*\[([^\]]*)\]\s*已回写原单/.exec(line);
  if (!match) return undefined;
  return /^[xX✓]$/.test(match[1].trim()) ? "checked" : "unchecked";
}

/** 解析总表里的段；格式不认识的段直接跳过，不影响其他段。 */
export function parseLedger(text: string): LedgerSegment[] {
  const segments: LedgerSegment[] = [];
  const lines = text.split(/\r?\n/);
  let current: LedgerSegment | undefined;
  const finish = (): void => {
    if (current) segments.push(current);
    current = undefined;
  };
  for (const line of lines) {
    if (/^##(?!#)\s/.test(line)) {
      finish();
      const rest = line.replace(/^##\s+/, "");
      const parts = rest.split(" · ");
      if (parts.length < 3) continue;
      const sessionPart = parts[parts.length - 1];
      const session = /^会话\s+(.+)$/.exec(sessionPart)?.[1]?.trim();
      if (!session) continue;
      current = {
        at: parts[0].trim(),
        project: parts.slice(1, -1).join(" · ").trim(),
        session,
        writeback: "none",
      };
      continue;
    }
    if (!current) continue;
    const state = writebackState(line);
    if (state && current.writeback === "none") current.writeback = state;
  }
  finish();
  return segments;
}

/** 同一会话只看最后一段；返回本项目还有几个会话的最后一段没勾「已回写原单」。 */
export function pendingWritebackCount(text: string, project: string): number {
  const target = canonical(project);
  const last = new Map<string, LedgerSegment>();
  for (const segment of parseLedger(text)) {
    if (canonical(segment.project) !== target) continue;
    last.set(segment.session, segment);
  }
  return [...last.values()].filter((segment) => segment.writeback === "unchecked").length;
}

export function writebackReminder(text: string, project: string, path = deliveryLedgerPath()): string | undefined {
  const count = pendingWritebackCount(text, project);
  if (count === 0) return undefined;
  return `交付总表里本项目有 ${count} 段待回写原单：${path}。按 .autoreview/CONVENTIONS.md「收尾回写」处理。`;
}
