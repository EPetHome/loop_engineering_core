/**
 * core.ts — 纯函数集合，不导入 pi。
 *
 * 负责：交付标记判断、评审输出解析、下一步决策、返修消息拼接、
 * 评审输入拼接、总结渲染。所有函数可被 Node 直接单测。
 */
import { createHash } from "node:crypto";

export const MARKER_DELIVERED = "【交付完成】";
export const MARKER_DECISION = "【需要你决定】";
/** 开发方约定，pi 扩展与宿主 Hook 注入同一份原文。 */
export const CONVENTION = [
  "【自动评审约定】",
  "- 交付时最后一行写【交付完成】，评审会立即开始；不写的话，程序检测到改动也会自动评审。",
  "- 需要用户决定时，最后一行写【需要你决定】。",
  "- 收到「自动评审」消息后，逐条写「第 N 条：已修」或「第 N 条：异议：理由」。",
].join("\n");
/** 超过这个字节数的 diff 不再原文附给评审。 */
export const MAX_DIFF_BYTES = 200 * 1024;

export type Marker = "delivered" | "decision" | "none";

export interface ParsedReview {
  /** 评审自报结论；解析不到时为空字符串。 */
  conclusion: string;
  /** 「## 必修」一节原文（没有必修时为「无」）。 */
  mustFixRaw: string;
  /** 必修条目，按「数字.」行切分。 */
  mustFix: string[];
  /** 小问题条目。 */
  minor: string[];
  /** 需求疑问条目。 */
  questions: string[];
  /** 上轮必修复查条目。 */
  recheck: string[];
  /** 结论和条数矛盾等提示。 */
  note?: string;
}

export type RoundRecord = ParsedReview & {
  round: number;
  startedAt: string;
  durationMs: number;
  /** 本轮评审失败时的错误摘要。 */
  failed?: string;
};

/** 验收命令的一次执行；只有 pi 扩展配置了验收命令时才有。 */
export interface AcceptanceRecord {
  command: string;
  trigger: "auto" | "command";
  /** 触发时已完成的评审轮数。 */
  round: number;
  startedAt: string;
  result: "进行中" | "通过" | "不通过" | "超时" | "中断" | "无法执行";
  durationMs?: number;
  exitCode?: number;
  /** 完整输出所在的日志文件。 */
  logPath?: string;
  /** 输出最后几行，写进总结。 */
  outputTail?: string;
  detail?: string;
}

export interface SummaryInput {
  cwd: string;
  devSessionId: string;
  reviewerSessionId: string;
  status: "进行中" | "完成" | "暂停";
  pauseReason?: string;
  rounds: RoundRecord[];
  repairs: number;
  unresolvedMustFix?: string;
  changedFiles?: string[];
  gitStatusShort: string;
  notes?: string;
  acceptance?: AcceptanceRecord;
}

export interface ReviewInputOptions {
  round: number;
  /** 没有成功检查点时，即使调用轮次大于 1 也重送首轮材料。 */
  firstReview?: boolean;
  requirement?: string;
  deliveryNote: string;
  previousMustFix?: string;
  diff: string;
  diffStat: string;
  untracked: string[];
}

/** 判断开发方最后一条回复的标记：只看最后一个非空行。 */
export function classifyMarker(text: string): Marker {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  const last = lines.length > 0 ? lines[lines.length - 1] : "";
  if (last === MARKER_DELIVERED) return "delivered";
  if (last === MARKER_DECISION) return "decision";
  return "none";
}

interface Section {
  title: string;
  body: string;
}

/** 按行首「## 」切分标题；## 必修 缺失由调用方判定为解析失败。 */
function splitSections(output: string): Section[] {
  const sections: Section[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const match = /^##(?!#)\s+(.+?)\s*$/.exec(raw);
    if (match) {
      sections.push({ title: match[1], body: "" });
    } else if (sections.length > 0) {
      sections[sections.length - 1].body += `${raw}\n`;
    }
  }
  return sections;
}

/** 提取列表条目：数字编号或项目符号；续行并入上一条。 */
function listItems(body: string, pattern: RegExp): string[] {
  const items: string[] = [];
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    const match = pattern.exec(line);
    if (match) items.push(match[1].trim());
    else if (line && items.length > 0) items[items.length - 1] = `${items[items.length - 1]} ${line}`.trim();
  }
  return items;
}

const numberedItems = (body: string): string[] => listItems(body, /^\d+\.\s*(.*)$/);
const bulletItems = (body: string): string[] =>
  listItems(body, /^[-*]\s+(.*)$/).filter((item) => item.length > 0 && item !== "无");

/** 解析评审输出。缺「## 必修」标题视为解析失败。 */
export function parseReview(output: string): { ok: true; review: ParsedReview } | { ok: false; error: string } {
  if (!output.trim()) return { ok: false, error: "评审输出为空" };
  const sections = splitSections(output);
  const find = (title: string): Section | undefined => sections.find((section) => section.title === title);
  const must = find("必修");
  if (!must) return { ok: false, error: "缺少「## 必修」标题" };

  const conclusionSection = sections.find((section) => section.title.startsWith("结论"));
  let conclusion = "";
  if (conclusionSection) {
    const inline = /^结论\s*[：:]\s*(.*)$/.exec(conclusionSection.title);
    if (inline && inline[1].trim()) conclusion = inline[1].trim();
    else conclusion = conclusionSection.body.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
  }

  const mustFix = numberedItems(must.body);
  const review: ParsedReview = {
    conclusion,
    mustFixRaw: must.body.trim() || "无",
    mustFix,
    minor: bulletItems(find("小问题")?.body ?? ""),
    questions: bulletItems(find("需求疑问")?.body ?? ""),
    recheck: bulletItems(find("上轮必修复查")?.body ?? ""),
  };
  if (conclusion.includes("通过") && !conclusion.includes("需返修") && mustFix.length > 0) {
    review.note = `结论写「${conclusion}」但列出 ${mustFix.length} 条必修，按 ${mustFix.length} 条必修处理`;
  } else if (conclusion.includes("需返修") && mustFix.length === 0) {
    review.note = `结论写「${conclusion}」但未列出必修，按无必修处理`;
  }
  return { ok: true, review };
}

/** 下一步动作：无必修→完成；有必修未到上限→返修；到上限→暂停。 */
export function decideNext(mustFixCount: number, repairs: number, maxRepairs: number): "repair" | "pause" | "done" {
  if (mustFixCount === 0) return "done";
  return repairs < maxRepairs ? "repair" : "pause";
}

/** 拼发回开发方的返修消息（6.6 格式）。 */
export function buildRepairMessage(repairRound: number, mustFixRaw: string): string {
  return [
    `【自动评审 · 第 ${repairRound} 次返修】`,
    "评审发现以下必修（小问题已记录在总结里，这次不用处理）：",
    "",
    mustFixRaw.trim() || "无",
    "",
    "请逐条处理：修好的写「第 N 条：已修」；不同意的写「第 N 条：异议：理由」。全部处理完，最后一行写【交付完成】。",
  ].join("\n");
}

/** 拼评审输入：尚无成功评审时带需求原文，否则带成功检查点的必修。 */
export function buildReviewInput(options: ReviewInputOptions): string {
  const parts: string[] = [];
  if (options.firstReview ?? options.round <= 1) {
    parts.push("## 需求原文", options.requirement?.trim() || "本会话没有记录需求原文（手动 /review），请按改动本身和项目文档评审");
    parts.push("## 开发方交付说明", options.deliveryNote.trim() || "（无）");
  } else {
    parts.push("## 开发方最新回复", options.deliveryNote.trim() || "（无）");
    parts.push("## 上一轮必修", options.previousMustFix?.trim() || "无");
  }

  const change: string[] = ["## 本轮改动"];
  if (Buffer.byteLength(options.diff, "utf8") > MAX_DIFF_BYTES) {
    change.push("改动太大，请自己读文件。", "", options.diffStat.trim() || "（无 diff --stat）");
  } else {
    change.push(options.diff.trim() || "（无受跟踪改动）");
  }
  change.push("", "新增未跟踪文件：");
  change.push(...(options.untracked.length > 0 ? options.untracked.map((path) => `- ${path}`) : ["- 无"]));
  parts.push(change.join("\n"));
  return `${parts.join("\n\n")}\n`;
}

/** 由开发会话 id 推出固定的评审会话 id；格式不合法时退化为 sha256 派生的 UUID 形式。 */
export function deriveReviewerSessionId(devSessionId: string): string {
  const candidate = `autoreview-rev-${devSessionId}`;
  if (/^[A-Za-z0-9]$/.test(candidate) || /^[A-Za-z0-9][A-Za-z0-9._-]*[A-Za-z0-9]$/.test(candidate)) {
    return candidate;
  }
  const digest = createHash("sha256").update(devSessionId).digest("hex").slice(0, 32);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
}

/** 验收结果的一句话写法，总结、通知和状态命令共用。 */
export function acceptanceLabel(record: AcceptanceRecord): string {
  return record.result === "不通过" ? `不通过（退出码 ${record.exitCode ?? "未知"}）` : record.result;
}

/** 渲染总结（6.13 格式），每轮评审后覆盖写。 */
export function renderSummary(input: SummaryInput): string {
  const lines: string[] = [];
  const status = input.status === "暂停" ? `暂停（${input.pauseReason ?? "未知原因"}）` : input.status;
  lines.push("# 自动评审总结");
  lines.push(`- 项目：${input.cwd}`);
  lines.push(`- 开发会话：${input.devSessionId}　评审会话：${input.reviewerSessionId}`);
  lines.push(`- 状态：${status}`);
  lines.push(`- 评审 ${input.rounds.length} 次，返修 ${input.repairs} 次`);
  if (input.acceptance) lines.push(`- 验收：${acceptanceLabel(input.acceptance)}`);
  if (input.notes) lines.push(`- 说明：${input.notes}`);
  const bullets = (items: string[], prefix = ""): void => {
    lines.push(...(items.length > 0 ? items.map((item) => `- ${prefix}${item}`) : ["- 无"]));
  };
  const accept = input.acceptance;
  if (accept) {
    lines.push("## 验收");
    lines.push(`- 命令：${accept.command}`);
    lines.push(`- 触发：${accept.trigger === "auto" ? `第 ${accept.round} 轮评审完成后自动执行` : "手动 /accept"}`);
    lines.push(`- 开始：${accept.startedAt}${accept.durationMs === undefined ? "" : `，耗时 ${Math.round(accept.durationMs / 1000)} 秒`}`);
    lines.push(`- 结果：${acceptanceLabel(accept)}`);
    if (accept.detail) lines.push(`- 说明：${accept.detail}`);
    if (accept.logPath) lines.push(`- 完整输出：${accept.logPath}`);
    if (accept.outputTail?.trim()) lines.push("输出最后几行：", "```text", accept.outputTail.trimEnd(), "```");
  }
  lines.push("## 各轮");
  for (const round of input.rounds) {
    lines.push(`### 第 ${round.round} 轮（${round.startedAt}，耗时 ${Math.round(round.durationMs / 1000)} 秒）`);
    lines.push(`结论：${round.conclusion || "未解析"}`);
    lines.push("必修：");
    lines.push(round.mustFixRaw.trim() || "无");
    lines.push("小问题：");
    bullets(round.minor);
    lines.push("需求疑问：");
    bullets(round.questions);
    lines.push("上轮必修复查：");
    bullets(round.recheck);
    if (round.note) lines.push(`提示：${round.note}`);
    if (round.failed) lines.push(`错误：${round.failed}`);
  }
  if (input.status === "暂停" && input.unresolvedMustFix?.trim()) {
    lines.push("## 未解决的必修");
    lines.push(input.unresolvedMustFix.trim());
  }
  if (input.changedFiles && input.changedFiles.length > 0) {
    lines.push("## 评审期间变化的工作区文件");
    lines.push(...input.changedFiles.map((file) => `- ${file}`));
  }
  lines.push("## 小问题汇总（待你决定）");
  bullets(input.rounds.flatMap((round) => round.minor.map((item) => `第 ${round.round} 轮：${item}`)));
  lines.push("## 需求疑问（待你决定）");
  bullets(input.rounds.flatMap((round) => round.questions.map((item) => `第 ${round.round} 轮：${item}`)));
  lines.push("## 改动文件（git status --short）");
  lines.push(input.gitStatusShort.trim() || "（干净）");
  return `${lines.join("\n")}\n`;
}
