/**
 * ledger.ts — 交付总表：追加结果索引，用户直接查看 Loop 总结。
 *
 * 只追加、不覆盖；每段一次写完。这里只做记录，任何失败都不改变评审/验收状态，
 * 由调用方决定怎么提示。
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { stripCriteriaSection, type AcceptanceRecord } from "./acceptance-core.ts";
import type { QueueAcceptance } from "./pipeline-core.ts";
import type { BatchCommit } from "./commit-batch.ts";
import { relaySourceLines, type RelaySource } from "./pa-records.ts";

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
export function pendingItems(record?: AcceptanceRecord, qualified?: QueueAcceptance | null): PendingItem[] {
  if (qualified === null) return [{ id: "验收结论", kind: "部分验证", reason: "历史队列缺少验收结论；免重复评审未补做验收" }];
  if (qualified) return [...qualified.partial.map((item): PendingItem => ({ id: item.id, kind: "部分验证", reason: oneLine(item.detail, 160) })),
    ...qualified.manual.map((item): PendingItem => ({ id: item.id, kind: "人工" }))];
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

export function resultLine(record: AcceptanceRecord | undefined, rounds: number, repairs: number, qualified?: QueueAcceptance | null): string {
  const partial = qualified === null || (qualified ? qualified.partial.length + qualified.manual.length > 0 : record?.verdict === "部分验证");
  const result = partial ? "完成（部分验证）" : "完成";
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
  paRelays?: RelaySource[];
}

/** 转达读取后即单独留来源；即使之后暂停，也不能等完成才让 PA 对账。 */
export function appendPARelayRecord(record: { project: string; session: string; summary: string; source: RelaySource }, path = deliveryLedgerPath()): string {
  return appendSegment([
    `## ${ledgerStamp()} · ${oneLine(record.project, 500)} · 会话 ${oneLine(record.session, 200)}`,
    "- 类型：用户原话，经 PA 转达（非完成结论）",
    ...relaySourceLines([record.source]), `- 总结：${oneLine(record.summary, 1000)}`, "",
  ].join("\n"), path);
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
    ...relaySourceLines(record.paRelays),
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
  return appendSegment(renderLedgerRecord(record), path);
}

/** 合入另追加本批的收尾段，不改写并发会话已追加的正文。entry 身份用于崩溃恢复去重。 */
export function appendMergeRecord(record: { project: string; batch: string; entry: string; commit: string; file: string; manual: { id: string; text: string; detail: string }[] }, path = deliveryLedgerPath()): string {
  const marker = `<!-- loop-merge:${record.entry} -->`;
  try { if (readFileSync(path, "utf8").includes(marker)) return path; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return appendSegment([
    `## ${ledgerStamp()} · ${oneLine(record.project, 500)} · 会话 批次-${oneLine(record.entry, 200)}`,
    marker, `- 批次：${oneLine(record.batch, 240)}`, `- 批次文件：${oneLine(record.file, 1000)}`,
    `- 已合入 ${record.commit}`,
    ...record.manual.map((item) => `- [ ] ${oneLine(item.id, 120)} 人工：${oneLine(item.text, 1000)}${item.detail ? `；${oneLine(item.detail, 500)}` : ""}`), "",
  ].join("\n"), path);
}

/** 批次完成的提交记录独立追加；不覆盖各段的原始交付记录。 */
export function appendBatchCommitRecord(record: { project: string; batch: string; entry: string; file: string; commits: BatchCommit[];
  conclusions: string[]; pending: { id: string; text: string; detail: string }[] }, path = deliveryLedgerPath()): string {
  return appendSegment([
    `## ${ledgerStamp()} · ${oneLine(record.project, 500)} · 会话 批次-${oneLine(record.entry, 200)}`,
    `- 批次：${oneLine(record.batch, 240)}`, `- 批次文件：${oneLine(record.file, 1000)}`,
    ...record.commits.flatMap((item) => [`- 已提交 ${item.branch} ${item.commit}`, ...item.preSquash.map((ref) => `- 中间历史：${ref}`)]),
    ...record.conclusions.map((line) => `- ${oneLine(line, 2000)}`),
    ...record.pending.map((item) => `- [ ] ${oneLine(item.id, 120)} 待验：${oneLine(item.text, 1000)}；${oneLine(item.detail, 500)}`), "",
  ].join("\n"), path);
}

export interface MissLedgerRecord {
  at?: Date;
  project: string;
  session: string;
  round: number;
  defect: string;
  discovery: string;
  summary: string;
  snapshot: string | null;
  draft: string;
}

/** 事后登记另起一段；不覆盖原完成记录，也不改总结。 */
export function appendMissRecord(record: MissLedgerRecord, path = deliveryLedgerPath()): string {
  const text = [
    `## ${ledgerStamp(record.at)} · ${oneLine(record.project, 500)} · 会话 ${oneLine(record.session, 200)}`,
    "- 类型：漏网（事后登记，未重新评审）",
    `- 项目：${oneLine(record.project, Infinity)}`,
    `- 会话：${oneLine(record.session, Infinity)}`,
    `- 轮次：${record.round}`,
    `- 问题：${oneLine(record.defect, Infinity)}`,
    `- 发现方式：${oneLine(record.discovery, Infinity)}`,
    `- 总结：${oneLine(record.summary, Infinity)}`,
    `- 快照：${record.snapshot ?? "null（历史轮次缺少可复原快照）"}`,
    `- 案例草稿：${record.draft}`, "",
  ].join("\n");
  return appendSegment(text, path);
}

function appendSegment(text: string, path: string): string {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // 每段自带结尾空行：O_APPEND 单次写入就能保证段间分隔，两个会话同时完成也不会粘在一起。
  appendFileSync(path, `${text}\n`, { mode: 0o600 });
  return path;
}
