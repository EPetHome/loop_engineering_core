/**
 * acceptance-core.ts — 自动验收的纯函数，不导入 pi、不起进程。
 *
 * 负责：从用户消息取「## 验收标准」、解析起草结果和验收方报告、扫日志、核对证据、
 * 逐条判定、拼验收方输入和返修消息、验收约定原文。判定只看逐条结果和证据，不信验收方自报的结论。
 * 开头标了「[人工]」的条目不交给验收方，判为「需人工」，完成时列给用户人工验收；
 * 标了「[授权]」的条目等用户亲手写「同意授权：A4」后照常交给验收方，用户不授权就和 [人工] 一样留给用户。
 */

import { resolve } from "node:path";

/** 配了 acceptance 的项目，追加在开发约定后面注入。 */
export const ACCEPTANCE_CONVENTION = [
  "【自动验收约定】",
  "- 用户让你起草需求或提示词时，末尾加「## 验收标准」：每条写「操作」和「预期」，只写外部看得到的结果（命令输出、页面、接口返回、数据变化、日志），一条只验一个行为，最多 10 条，只覆盖本次需求。",
  "- 要用用户的真实账号、凭证、外部平台或会产生真实后果、又没有测试替身的条目，开头标「[授权]」：用户同意后程序照常执行；要用户主观拍板的条目开头标「[人工]」，由用户验收。图形界面操作、步骤多、耗时长都不算。不要替用户写「同意授权」。",
  "- 用户消息里的「同意授权：…」「不授权：…」是给程序的：你不用处理，回一句收到，最后一行写【交付完成】。",
  "- 开发时不要补写或修改验收标准，标准只认用户发来的。",
  "- 交付说明里写清新功能怎么用（命令、地址、参数），验收方按它操作。",
  "- 收到「自动验收」消息后，逐条写「A2：已修」。认为标准本身（预期、范围或授权）不对，写「A2：异议：理由」，交用户决定；认可标准但质疑验收方法、环境或失败归因，写「A2：方法存疑：理由」，程序照常验收，理由随该条交给验收方并写进总结。",
].join("\n");
/** 起草时最多保留的条数；用户自己写的不截断，只在总结里提示。 */
export const MAX_CRITERIA = 10;

export interface CriterionItem {
  id: string;
  text: string;
  /** 只在一轮验收里用：[授权] 条目用户不授权，交给用户人工验收（不写进冻结的标准）。 */
  declined?: boolean;
}

export interface Criteria {
  source: "用户" | "自动起草";
  items: CriterionItem[];
  version: number;
  updatedAt: string;
}

export type ItemVerdict = "通过" | "不通过" | "无法验证";
/** 判定结果多一种「需人工」：标了 [人工]，或 [授权] 条目用户不授权，程序不交给验收方。 */
export type ResultVerdict = ItemVerdict | "需人工";

/** 条目开头（可以在别的 [标签] 或「操作：」之后）写了「[名字]」或「【名字】」。 */
const leadingTag = (name: string): RegExp =>
  new RegExp(`^\\s*(?:[[【][^\\]】\\n]*[\\]】]\\s*)*(?:操作\\s*[:：]\\s*)?[[【]\\s*${name}\\s*[\\]】]`);
const MANUAL_TAG = leadingTag("人工");
const AUTH_TAG = leadingTag("授权");

/** 标了 [人工] 的验收标准：要用户主观拍板，由用户人工验收。 */
export function isManualCriterion(text: string): boolean {
  return MANUAL_TAG.test(text);
}

/** 标了 [授权] 的验收标准：要用用户的真实账号、凭证、外部平台或会产生真实后果，用户同意后才执行。 */
export function isAuthorizationCriterion(text: string): boolean {
  return AUTH_TAG.test(text) && !MANUAL_TAG.test(text);
}

/** 这一条交给用户：标了 [人工]，或 [授权] 条目用户不授权。 */
export function forUser(item: CriterionItem): boolean {
  return isManualCriterion(item.text) || item.declined === true;
}

/** 用户对 [授权] 条目的答复，跟着标准版本走：标准换了版本要重新授权。 */
export interface Grants {
  version: number;
  approved: string[];
  denied: string[];
}

/** 「同意授权：A4、A5」「同意授权：全部」「不授权：A4」（也认「不同意授权」），可以是列表项。 */
const GRANT_LINE = /^\s*(?:[-*]\s*)?(不同意授权|不授权|同意授权)\s*[：:]?\s*((?:全部|所有)[。.!！]?|A\s*\d+.*?)\s*$/i;

/**
 * 从用户亲手写的文字里取授权答复，只认当前标准里的 [授权] 条目；没有这类行返回 undefined。
 * 调用方只传用户打的字：不含 @文件 展开的内容，也不含程序自己发的返修消息，免得模型替用户授权。
 */
export function grantsFromUser(text: string, criteria: Criteria | undefined, previous?: Grants): Grants | undefined {
  if (!criteria) return undefined;
  const authIds = criteria.items.filter((item) => isAuthorizationCriterion(item.text)).map((item) => item.id);
  const base = previous?.version === criteria.version ? previous : undefined;
  const approved = new Set(base?.approved ?? []);
  const denied = new Set(base?.denied ?? []);
  let found = false;
  for (const line of text.split(/\r?\n/)) {
    const match = GRANT_LINE.exec(unbold(line));
    if (!match) continue;
    found = true;
    const value = match[2].replace(/[。.！!]+$/, "").trim();
    const ids = /^(全部|所有)$/.test(value) ? authIds
      : [...value.matchAll(/A\s*(\d+)/gi)].map((id) => `A${id[1]}`).filter((id) => authIds.includes(id));
    for (const id of ids) {
      if (match[1] === "同意授权") { approved.add(id); denied.delete(id); } else { denied.add(id); approved.delete(id); }
    }
  }
  return found ? { version: criteria.version, approved: [...approved], denied: [...denied] } : undefined;
}

/** 程序自己发给开发方的消息（返修、门禁、流水线 e2e 返修）：不是用户打的字。 */
const LOOP_MESSAGE = /^\s*【(?:(?:自动评审|自动验收|门禁|流水线 e2e 返修) · |合入队列返修】|流程等待】|流程准备】)/;
export const isLoopMessage = (prompt: string): boolean => LOOP_MESSAGE.test(prompt);

/** 用户亲手打的字：程序自己发的消息不算，pi 展开的 <file> 块去掉（宿主 Hook 直接传没展开的原文）。 */
export function typedByUser(prompt: string): string {
  if (LOOP_MESSAGE.test(prompt)) return "";
  return prompt.replace(/<file name="[^"]*">[\s\S]*?<\/file>/g, "");
}

/** 授权状态的一句话（总结、状态命令用）；标准里没有 [授权] 条目返回 undefined。 */
export function authorizationLine(criteria: Criteria, grants?: Grants): string | undefined {
  const status = authorizationStatus(criteria, grants);
  const parts = [
    status.approved.length && `${status.approved.join("、")} 你已同意`,
    status.denied.length && `${status.denied.join("、")} 你不授权（留给你人工验收）`,
    status.pending.length && `${status.pending.join("、")} 等你答复`,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join("；") : undefined;
}

/** 当前标准里 [授权] 条目的状态：已同意、不授权、还没答复。 */
export function authorizationStatus(criteria: Criteria, grants?: Grants): { approved: string[]; denied: string[]; pending: string[] } {
  const ids = criteria.items.filter((item) => isAuthorizationCriterion(item.text)).map((item) => item.id);
  const current = grants?.version === criteria.version ? grants : undefined;
  return {
    approved: ids.filter((id) => current?.approved.includes(id)),
    denied: ids.filter((id) => current?.denied.includes(id)),
    pending: ids.filter((id) => !current?.approved.includes(id) && !current?.denied.includes(id)),
  };
}

/** 要你人工验收的条目按原因分开说：没能自动验证、标了 [人工]、你没授权。 */
export function handOverParts(items: Pick<AcceptanceItemResult, "id" | "text" | "verdict">[]): string[] {
  const ids = (pick: (item: Pick<AcceptanceItemResult, "id" | "text" | "verdict">) => boolean): string =>
    items.filter(pick).map((item) => item.id).join("、");
  const unknown = ids((item) => item.verdict === "无法验证");
  const tagged = ids((item) => item.verdict === "需人工" && isManualCriterion(item.text));
  const declined = ids((item) => item.verdict === "需人工" && !isManualCriterion(item.text));
  return [unknown && `${unknown} 没能自动验证`, tagged && `${tagged} 标了 [人工]`, declined && `${declined} 你没授权`].filter(Boolean);
}

/** 等授权时给你的提示：哪几条、要做什么、怎么答复。 */
export function authorizationHint(criteria: Criteria, pending: string[]): string {
  const items = criteria.items.filter((item) => pending.includes(item.id))
    .map((item) => `${item.id}（${item.text.split("\n")[0].replace(/^\s*[[【]\s*授权\s*[\]】]\s*/, "")}）`).join("；");
  const ids = pending.join("、");
  return `验收标准里有要你授权的条目：${items}。同意就回复「同意授权：${ids}」（全部同意写「同意授权：全部」）；`
    + `不同意就回复「不授权：${ids}」，这几条留给你人工验收。回复后自动继续`;
}

export interface ReportItem {
  /** 程序合并时发现同次调用的明确结论冲突，不能当成部分验证放行。 */
  conflict?: string;
  id: string;
  verdict: ItemVerdict;
  /** 「- 键：值」字段：复现、预期、实际、证据摘录、相关日志、原因。 */
  fields: Record<string, string>;
}

export interface ParsedAcceptance {
  conclusion: string;
  items: ReportItem[];
  extra: string[];
}

/**
 * 无法验证的原因，决定后续怎么走：验收方没做好 → 换强模型重验；没配启动、缺工具 → 暂停并告诉你复制哪一块；
 * 系统被关掉、数据不干净 → 暂停交给你（不算开发方的错）；
 * 其他（标准含糊、环境不通）→ 个别条目留给人工，全部都这样才暂停。
 */
export type UnknownCause = "系统被关掉" | "数据不干净" | "验收方" | "验收方模型断线" | "没配启动" | "缺工具" | "其他";

export interface AcceptanceItemResult {
  id: string;
  /** 标准原文；G1/G2 是程序自带的全局标准。 */
  text: string;
  verdict: ResultVerdict;
  /** 给开发方和总结看的说明。 */
  detail: string;
  /** 证据有问题（可以让验收方重做一次）。 */
  evidenceProblem?: boolean;
  /** 无法验证时的原因分类。 */
  cause?: UnknownCause;
  /** 从本次证据的命令行提取，不采信模型自报；脚本必须是本轮实际新建的文件。 */
  execution?: { commands: string[]; scripts: string[] };
}

export interface AcceptanceRecord {
  /** 部分验证：其余全部通过，只有个别条目没法自动验证或标了 [人工]（留给你人工验收），已完成静态评审后继续检查其余完成条件。 */
  verdict: "通过" | "部分验证" | "不通过" | "无法验收";
  items: AcceptanceItemResult[];
  logErrors: string[];
  extra: string[];
  runDir: string;
  durationMs: number;
  /** 无法验收、部分验证的说明。 */
  reason?: string;
  /** 无法验收时卡在哪类原因上。 */
  blocker?: UnknownCause;
  /** 验收方没做好，换强模型重验过。 */
  escalated?: boolean;
  /** 模型断线后的处理记录；补报告不是从头重验。 */
  recovery?: { reason: string; attempted: boolean; error?: string };
  note?: string;
  /** 收尾时清理端口上残留进程的记录。 */
  cleanup?: string[];
  failureKind?: import("./failure.ts").FailureKind;
  /** 开发方对验收方法的存疑（理由随条目交验收方，并写进总结）；照常判定，不作为通过依据。 */
  methodDoubts?: { id: string; reason: string }[];
}

const ITEM_START = /^(?:[-*]\s*)?(?:A\s*)?(\d+)\s*[.、．:：)）]\s*(.*)$/i;
const BULLET_START = /^[-*]\s+(.*)$/;
/** 模型爱加粗（**A1**：通过）；粗体标记在这些行里没有意义，匹配前去掉。 */
const unbold = (line: string): string => line.replace(/\*\*/g, "");

/** 取「## 验收标准」一节到下一个一、二级标题；条目统一重新编号为 A1、A2…。没有返回 undefined。 */
export function extractCriteria(text: string | undefined): CriterionItem[] | undefined {
  if (!text) return undefined;
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => /^##(?!#)\s*验收标准\s*[:：]?\s*$/.test(line.trim()));
  if (start < 0) return undefined;
  const items: string[] = [];
  for (const raw of lines.slice(start + 1)) {
    if (/^#{1,2}(?!#)\s/.test(raw.trim())) break;
    const indented = /^\s/.test(raw);
    const line = unbold(raw).trim();
    if (!line || GRANT_LINE.test(line)) continue;
    const numbered = indented ? null : ITEM_START.exec(line);
    const bullet = indented || numbered ? null : BULLET_START.exec(line);
    if (numbered) items.push(numbered[2].trim());
    else if (bullet) items.push(bullet[1].replace(/^A\d+\s*[.、．:：]?\s*/i, "").trim());
    else if (items.length > 0) items[items.length - 1] = `${items[items.length - 1]}\n${line}`;
  }
  const kept = items.map((item) => item.trim()).filter(Boolean);
  return kept.length > 0 ? kept.map((item, index) => ({ id: `A${index + 1}`, text: item })) : undefined;
}

/** 去掉需求里的「## 验收标准」一节（验收方输入里标准单独列出，避免出现两份）。 */
export function stripCriteriaSection(text: string): string {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => /^##(?!#)\s*验收标准\s*[:：]?\s*$/.test(line.trim()));
  if (start < 0) return text;
  const rest = lines.slice(start + 1).findIndex((line) => /^#{1,2}(?!#)\s/.test(line.trim()));
  const end = rest < 0 ? lines.length : start + 1 + rest;
  return [...lines.slice(0, start), ...lines.slice(end)].join("\n").trim();
}

/** 用户消息里带「## 验收标准」时生成新一版标准（替换旧的）；没有返回 undefined。只对用户发来的消息调用。 */
export function criteriaFromUser(prompt: string, previous?: Criteria): Criteria | undefined {
  if (isLoopMessage(prompt)) return undefined;
  const items = extractCriteria(prompt);
  if (!items) return undefined;
  return { source: "用户", items, version: (previous?.version ?? 0) + 1, updatedAt: new Date().toISOString() };
}

/** 按「A1. 第一行\n    续行」排版。 */
export function formatCriteria(items: CriterionItem[]): string {
  return items.map((item) => {
    const [first, ...rest] = item.text.split("\n");
    return [`${item.id}. ${first}`, ...rest.map((line) => `    ${line}`)].join("\n");
  }).join("\n");
}

/** 解析起草结果；超过 MAX_CRITERIA 条只保留前面的。 */
export function parseCriteriaDraft(output: string): { ok: true; items: CriterionItem[]; note?: string } | { ok: false; error: string } {
  if (!output.trim()) return { ok: false, error: "起草输出为空" };
  const items = extractCriteria(output);
  if (!items) return { ok: false, error: "起草输出里没有「## 验收标准」条目" };
  if (items.length <= MAX_CRITERIA) return { ok: true, items };
  return { ok: true, items: items.slice(0, MAX_CRITERIA), note: `起草了 ${items.length} 条，只保留前 ${MAX_CRITERIA} 条` };
}

interface Section {
  title: string;
  body: string;
}

function splitSections(output: string): Section[] {
  const sections: Section[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const match = /^##(?!#)\s+(.+?)\s*$/.exec(raw);
    if (match) sections.push({ title: match[1], body: "" });
    else if (sections.length > 0) sections[sections.length - 1].body += `${raw}\n`;
  }
  return sections;
}

const REPORT_ITEM = /^(?:#{3,6}\s*)?(?:[-*]\s*)?([AG]\d+)\s*[：:]\s*(不通过|无法验证|通过)/;
/** 只认这几个字段名，续行里的「http://…」之类不会被当成字段。 */
const REPORT_FIELD = /^[-*]?\s*(复现|预期|实际|证据摘录|相关日志|原因)\s*[：:]\s*(.*)$/;

/** 解析验收方报告。缺「## 逐条结果」或一条结果都没有视为解析失败。 */
export function parseAcceptanceReport(output: string): { ok: true; report: ParsedAcceptance } | { ok: false; error: string } {
  if (!output.trim()) return { ok: false, error: "验收输出为空" };
  const sections = splitSections(output);
  const results = sections.find((section) => section.title === "逐条结果");
  if (!results) return { ok: false, error: "缺少「## 逐条结果」标题" };
  const items: ReportItem[] = [];
  let lastKey = "";
  for (const raw of results.body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const start = REPORT_ITEM.exec(unbold(line));
    if (start) {
      items.push({ id: start[1].toUpperCase(), verdict: start[2] as ItemVerdict, fields: {} });
      lastKey = "";
      continue;
    }
    const current = items[items.length - 1];
    if (!current) continue;
    const field = REPORT_FIELD.exec(line.replace(/^([-*]?\s*)\*\*([^*]+)\*\*/, "$1$2"));
    if (field) {
      lastKey = field[1];
      current.fields[lastKey] = field[2].trim();
    } else if (lastKey) {
      current.fields[lastKey] = `${current.fields[lastKey]}\n${line}`.trim();
    }
  }
  if (items.length === 0) return { ok: false, error: "「## 逐条结果」里没有任何条目" };
  const conclusionSection = sections.find((section) => section.title.startsWith("结论"));
  const inline = conclusionSection ? /^结论\s*[：:]\s*(.*)$/.exec(conclusionSection.title) : null;
  const extraBody = sections.find((section) => section.title === "额外发现")?.body ?? "";
  const extra = extraBody.split(/\r?\n/)
    .map((line) => line.trim().replace(/^[-*]\s+/, ""))
    .filter((line) => line && line !== "无");
  return { ok: true, report: { conclusion: inline?.[1].trim() ?? "", items, extra } };
}

/** 更正只覆盖自己本次提交的条目；历史结果不能覆盖新检查点，同次冲突须重验。 */
export function mergeAcceptanceReports(previous?: ParsedAcceptance, current?: ParsedAcceptance, checkpoints?: ParsedAcceptance): ParsedAcceptance | undefined {
  if (!previous && !current && !checkpoints) return undefined;
  const merged = new Map((previous?.items ?? []).map((item) => [item.id, item]));
  const saved = new Map((checkpoints?.items ?? []).map((item) => [item.id, item]));
  for (const item of saved.values()) merged.set(item.id, item);
  const reported = new Map<string, ReportItem>();
  for (const item of current?.items ?? []) {
    const other = saved.get(item.id), duplicate = reported.get(item.id);
    const conflict = duplicate?.conflict || ((other && other.verdict !== item.verdict) || (duplicate && duplicate.verdict !== item.verdict)
      ? "本次报告与检查点或重复条目的结论冲突，请重新实测并提交一致结果" : undefined);
    const value = { ...item, ...(conflict ? { conflict } : {}) };
    reported.set(item.id, value); merged.set(item.id, value);
  }
  return { conclusion: current?.conclusion ?? checkpoints?.conclusion ?? previous!.conclusion,
    items: [...merged.values()], extra: current?.extra ?? previous?.extra ?? checkpoints?.extra ?? [] };
}

/** 扫日志里含错误关键字、且不含忽略关键字的行；去重，最多 max 行。 */
export function scanLogs(text: string, patterns: string[], ignore: string[], max = 20): string[] {
  if (patterns.length === 0) return [];
  const found: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || !patterns.some((pattern) => line.includes(pattern))) continue;
    if (ignore.some((pattern) => line.includes(pattern)) || found.includes(line)) continue;
    found.push(line);
    if (found.length >= max) break;
  }
  return found;
}

/** 摘录比对：去掉首尾引号，空白折叠成一个空格。 */
function normalize(text: string): string {
  return text.trim().replace(/^[`「『"'“]+|[`」』"'”]+$/g, "").replace(/\s+/g, " ").trim();
}

/**
 * 开发方回复里对验收条目的回应，分两组：
 * - objections：对标准本身的异议（「A2：异议：理由」），只有这组暂停等用户决定；
 * - doubts：认可标准、质疑验收方法或失败归因（「G2：方法存疑：理由」），照常验收。
 * 同一行里同时出现两种写法时按异议处理。
 */
export interface ObjectionGroups {
  objections: string[];
  doubts: { id: string; reason: string }[];
}
export function findObjections(text: string): ObjectionGroups {
  const objections = new Set<string>();
  const doubts = new Map<string, string>();
  for (const raw of unbold(text).split(/\r?\n/)) {
    const objection = /^\s*[-*]?\s*([AG]\d+)\s*[：:]\s*异议\s*[：:]?\s*(.*)$/.exec(raw);
    if (objection) { objections.add(objection[1].toUpperCase()); continue; }
    const doubt = /^\s*[-*]?\s*([AG]\d+)\s*[：:]\s*方法存疑\s*[：:]?\s*(.*)$/.exec(raw);
    if (doubt) doubts.set(doubt[1].toUpperCase(), doubt[2].trim());
  }
  return { objections: [...objections], doubts: [...doubts].map(([id, reason]) => ({ id, reason })) };
}

export interface JudgeInput {
  criteria: CriterionItem[];
  /** 验收方报告；验收方两次都没给出可解析的报告时为空。 */
  report?: ParsedAcceptance;
  reportError?: string;
  /** 验收方断线/挂住；没有有效报告和证据的条目据此写明原因。 */
  testerDisconnected?: string;
  /** 本轮验收方新建的脚本/浏览器步骤文件（绝对路径）。 */
  writtenScripts?: string[];
  /** 读 evidence/<id>.txt；不存在返回 undefined。 */
  evidence: (id: string) => string | undefined;
  /** 系统没能启动或中途崩溃的说明（G1 不通过，算开发方的）。 */
  systemFailure?: string;
  /** 系统在验收途中被关掉（信号或无错误的正常退出）：G1 无法验证，之后留的证据不算数，不打回开发方。 */
  systemStopped?: { detail: string; at: number };
  logErrors: string[];
  runDir: string;
  /** 配置了怎么启动被测系统（acceptance.start）。 */
  hasService: boolean;
}

const UNREACHABLE = /连不上|无法连接|连接被拒|拒绝连接|connection refused|ECONNREFUSED|failed to connect|couldn't connect|could not connect|ERR_CONNECTION/i;
const NEEDS_URL = /https?:\/\/|localhost|127\.0\.0\.1/i;
/** browser.mjs 找不到 Playwright 时写进证据的固定文字。 */
export const NO_PLAYWRIGHT = "缺少 Playwright";
const BLOCKER_TEXT: Record<UnknownCause, string> = {
  系统被关掉: "被测系统在验收途中被关掉了（多半是验收方或重置命令关的，不是开发方的问题）",
  数据不干净: "被测系统的数据不是初始状态，依赖初始状态的标准没法验",
  验收方: "验收方没按要求留证据或输出格式不对",
  验收方模型断线: "验收方模型断线或挂住，部分条目缺少有效证据或补写报告",
  没配启动: "没有配置怎么启动被测系统",
  缺工具: "缺少浏览器工具 Playwright",
  其他: "全部标准都没能验证",
};

/** 验收方按提示词报数据问题时用的说法。 */
export const DIRTY_DATA = /数据不是初始状态|数据不干净/;

/**
 * 验收方报「无法验证」时归类：系统被关掉后连不上 → 缺工具 → 数据不干净 → 没配启动（标准或原因里要连系统，却没配 start）→ 其他。
 */
function classifyUnknown(
  criterion: CriterionItem, reason: string, evidence: string | undefined, hasService: boolean, systemStopped: boolean,
): UnknownCause {
  if (systemStopped && UNREACHABLE.test(reason)) return "系统被关掉";
  if (/验收方模型断线|验收方.*挂住/.test(reason)) return "验收方模型断线";
  if (evidence?.includes(NO_PLAYWRIGHT) || /playwright|浏览器工具/i.test(reason)) return "缺工具";
  if (DIRTY_DATA.test(reason)) return "数据不干净";
  if (!hasService && (UNREACHABLE.test(reason) || NEEDS_URL.test(reason) || NEEDS_URL.test(criterion.text))) return "没配启动";
  return "其他";
}

/** 被关掉的信号，以及 sh 转述子进程被这些信号关掉时的退出码（128 + 信号号）。 */
const STOP_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP", "SIGKILL"];
const STOP_CODES = [129, 130, 137, 143];

/**
 * 验收途中系统退出，是被关掉还是自己崩了：
 * 被 TERM/INT/HUP/KILL 关掉（或 sh 转述的 129/130/137/143）→ 被关掉；退出码 0 且日志没有错误 → 被关掉；
 * 其余（非 0 退出码、SIGSEGV/SIGABRT 之类，或正常退出但日志有错误）→ 崩溃，算开发方的。
 */
export function classifySystemExit(exit: { code: number | null; signal: string | null }, logErrors: string[]): "被关掉" | "崩溃" {
  if (exit.signal && STOP_SIGNALS.includes(exit.signal)) return "被关掉";
  if (exit.code !== null && STOP_CODES.includes(exit.code)) return "被关掉";
  if (exit.code === 0 && logErrors.length === 0) return "被关掉";
  return "崩溃";
}

/** 证据文件里这一条最后一次留证据的时间（./ev、./browser 的块头「=== A1 #n <ISO 时间>」）。 */
export function lastEvidenceAt(content: string | undefined, id: string): number | undefined {
  if (!content) return undefined;
  let last: number | undefined;
  for (const match of content.matchAll(new RegExp(`^=== ${id} #\\d+ (\\S+)`, "gm"))) {
    const at = Date.parse(match[1]);
    if (!Number.isNaN(at)) last = at;
  }
  return last;
}

const G1_TEXT = "系统能按配置启动、就绪，并在验收过程中一直运行";
const G2_TEXT = "验收期间系统日志里没有错误";
const MANUAL_DETAIL = "标了 [人工]：程序不交给验收方，需要你人工验收";
const DECLINED_DETAIL = "标了 [授权]，你没有授权：程序不执行，需要你人工验收";

/** 和通过/不通过的证据检查使用同一条规则，不因补报告而放宽。 */
export const hasEvidence = (content: string | undefined, id: string): content is string => Boolean(content?.includes(`=== ${id} `));

/** 只取证据块头紧随的 $ 行，避免把标准输出里打印的命令当成实际执行。 */
export function evidenceExecution(content: string | undefined, runDir: string, writtenScripts: string[] = []): NonNullable<AcceptanceItemResult["execution"]> {
  const commands: string[] = [], scripts = new Set<string>(), written = new Set(writtenScripts);
  const lines = (content ?? "").split(/\r?\n/);
  for (let i = 0; i < lines.length - 1; i += 1) {
    if (!/^=== [AG]\d+ #\d+ /.test(lines[i]) || !lines[i + 1].startsWith("$ ")) continue;
    const command = lines[i + 1].slice(2).trim();
    if (commands.length < 3) commands.push(command.length > 240 ? `${command.slice(0, 239)}…` : command);
    const cwd = lines[i + 2]?.startsWith("目录：") ? lines[i + 2].slice(3) : runDir;
    const tokenize = (text: string): string[] => text.match(/"(?:\\.|[^"\\])*"|'[^']*'|[^\s;&|()<>]+/g) ?? [];
    const tokens = tokenize(command);
    for (let index = 0; index < tokens.length && index < 1000; index += 1) {
      const token = tokens[index];
      let path = token;
      try { if (token.startsWith('"')) path = JSON.parse(token); else if (token.startsWith("'")) path = token.slice(1, -1); } catch { continue; }
      if (written.has(resolve(cwd, path))) scripts.add(resolve(cwd, path));
      if (["-c", "-lc"].includes(tokens[index - 1])) tokens.push(...tokenize(path));
    }
  }
  return { commands, scripts: [...scripts] };
}

function failDetail(item: ReportItem, evidencePath: string): string {
  const order = ["复现", "预期", "实际", "相关日志"];
  const lines = order.filter((key) => item.fields[key]).map((key) => `${key}：${item.fields[key]}`);
  lines.push(`证据：${evidencePath}`);
  return lines.join("\n");
}

/**
 * 逐条判定。通过/不通过都必须有工具写下的证据，且证据摘录确实在证据文件里，否则降为无法验证。
 * 没配启动时「连不上」不算开发方的错：报了不通过也改判为无法验证。
 * 有不通过（含 G1/G2）→ 不通过；无法验证里有验收方没做好、没配启动、缺工具，或者全部都没验证 → 无法验收；
 * 其余只有个别条目无法验证 → 部分验证（留给人工）；全部通过 → 通过。
 * 标了 [人工] 的条目记「需人工」，不影响打回和暂停；其余全部通过时整体算部分验证，完成时列给你。
 */
export function judgeAcceptance(input: JudgeInput): Omit<AcceptanceRecord, "durationMs"> {
  const items: AcceptanceItemResult[] = [];
  const stopped = input.systemStopped;
  if (input.systemFailure) {
    items.push({ id: "G1", text: G1_TEXT, verdict: "不通过", detail: input.systemFailure });
  } else if (stopped) {
    items.push({ id: "G1", text: G1_TEXT, verdict: "无法验证", detail: stopped.detail, cause: "系统被关掉" });
  }
  /** 交给你的条目（[人工]、不授权的 [授权]）不看验收方报告，直接记「需人工」。 */
  const toUser = (criterion: CriterionItem): AcceptanceItemResult => ({
    id: criterion.id, text: criterion.text, verdict: "需人工", detail: criterion.declined ? DECLINED_DETAIL : MANUAL_DETAIL,
  });
  /** 按标准顺序逐条判定。 */
  const each = (judge: (criterion: CriterionItem) => AcceptanceItemResult): void => {
    for (const criterion of input.criteria) items.push(forUser(criterion) ? toUser(criterion) : judge(criterion));
  };
  if (input.report || input.testerDisconnected) {
    each((criterion) => {
      const reported = input.report?.items.find((item) => item.id === criterion.id);
      const evidencePath = `${input.runDir}/evidence/${criterion.id}.txt`;
      const content = input.evidence(criterion.id);
      const disconnected = (): AcceptanceItemResult => ({
        ...criterion, verdict: "无法验证", cause: "验收方模型断线",
        detail: `原因：验收方模型断线；${hasEvidence(content, criterion.id) ? "已有证据，但没有可核对的完整报告" : "未留下该条的有效实测证据"}；${input.testerDisconnected}`,
      });
      if (!reported) {
        if (input.testerDisconnected) return disconnected();
        return { ...criterion, verdict: "无法验证", detail: `原因：验收报告漏项，未提交 ${criterion.id} 的实测结果与证据摘录，程序无法核对该条是否符合预期`, evidenceProblem: true, cause: "验收方" };
      }
      if (reported.conflict) return { ...criterion, verdict: "无法验证", detail: reported.conflict, evidenceProblem: true, cause: "验收方" };
      if (input.testerDisconnected && !hasEvidence(content, criterion.id)) return disconnected();
      if (reported.verdict === "无法验证") {
        const reason = reported.fields["原因"]?.trim();
        if (!reason || /^(?:验收方没有报告这一条|验收方没写原因|无法验证|无法判断|未验证|未知|无|暂无|N\/A|unknown)$/i.test(reason)) {
          if (input.testerDisconnected) return disconnected();
          return { ...criterion, verdict: "无法验证", detail: "原因：验收报告未说明无法执行的步骤或具体阻塞条件，无法核实该条的实测结果", evidenceProblem: true, cause: "验收方" };
        }
        return {
          ...criterion, verdict: "无法验证", detail: `原因：${input.testerDisconnected ? "验收方模型断线；已有证据不足以补判：" : ""}${reason}`,
          cause: input.testerDisconnected ? "验收方模型断线" : classifyUnknown(criterion, reason, content, input.hasService, Boolean(stopped)),
        };
      }
      const excerpt = normalize(reported.fields["证据摘录"] ?? "");
      let problem = "";
      if (!hasEvidence(content, criterion.id)) problem = `没有用 ./ev 或 ./browser 留下证据（${evidencePath}）`;
      else if (excerpt.length < 2) problem = "没有写证据摘录";
      else if (!normalize(content).includes(excerpt)) problem = `证据摘录在 ${evidencePath} 里找不到`;
      if (problem) {
        return { ...criterion, verdict: "无法验证", detail: `原因：报告「${reported.verdict}」，但${problem}`, evidenceProblem: true, cause: "验收方" };
      }
      // 系统被关掉之后，连到的可能是别人重启的进程或者根本连不上：这时留的证据不算数。
      const lastAt = lastEvidenceAt(content, criterion.id);
      if (stopped && (lastAt === undefined || lastAt >= stopped.at)) {
        return {
          ...criterion, verdict: "无法验证", cause: "系统被关掉",
          detail: `原因：报告「${reported.verdict}」，但证据是在被测系统被关掉之后留的，不算数`,
        };
      }
      const observed = [reported.fields["实际"], reported.fields["证据摘录"], reported.fields["相关日志"]].join("\n");
      if (reported.verdict === "不通过" && !input.hasService && UNREACHABLE.test(observed)) {
        return {
          ...criterion, verdict: "无法验证", cause: "没配启动",
          detail: "原因：连不上被测系统，但 .autoreview.json 没有配置怎么启动它（验收方报了不通过，程序改判为无法验证，不算开发方的错）",
        };
      }
      return {
        ...criterion, verdict: reported.verdict,
        detail: reported.verdict === "通过" ? `证据摘录：${reported.fields["证据摘录"]}` : failDetail(reported, evidencePath),
      };
    });
  } else if (stopped) {
    each((criterion) => ({ ...criterion, verdict: "无法验证", detail: "原因：被测系统被关掉，没有完成实测", cause: "系统被关掉" }));
  } else if (!input.systemFailure) {
    each((criterion) => ({ ...criterion, verdict: "无法验证", detail: `原因：${input.reportError || "验收方未返回可解析报告，缺少逐条实测结果与证据摘录，无法核对是否符合预期"}`, cause: "验收方" }));
  } else {
    // 系统没能正常运行：自动的条目没有实测，不逐条列；交给你的条目照样列出来。
    for (const criterion of input.criteria) if (forUser(criterion)) items.push(toUser(criterion));
  }
  if (input.logErrors.length > 0) {
    // 被关掉时，日志里的错误可能是关停时打的：这一轮不据此打回，留给你看。
    items.push(stopped
      ? { id: "G2", text: G2_TEXT, verdict: "无法验证", cause: "系统被关掉", detail: `系统被关掉前后日志里有错误（可能是关停时打的），这一轮不据此打回：\n${input.logErrors.join("\n")}` }
      : { id: "G2", text: G2_TEXT, verdict: "不通过", detail: input.logErrors.join("\n") });
  }
  for (const item of items) {
    if (!forUser(item)) item.execution = evidenceExecution(input.evidence(item.id), input.runDir, input.writtenScripts);
  }
  const failed = items.some((item) => item.verdict === "不通过");
  const unknown = items.filter((item) => item.verdict === "无法验证");
  const manual = items.filter((item) => item.verdict === "需人工");
  const automatic = input.criteria.length - manual.length;
  const ids = unknown.map((item) => item.id).join("、");
  const blocker = (["系统被关掉", "数据不干净", "没配启动", "缺工具", "验收方模型断线", "验收方"] as const).find((cause) => unknown.some((item) => item.cause === cause))
    ?? (unknown.length > 0 && unknown.length === automatic ? "其他" : undefined);
  // 验收方只拿到自动的条目：它自报的结论和这个比；[人工] 条目只把「通过」变成「部分验证」。
  const automaticVerdict = failed ? "不通过" : unknown.length === 0 ? "通过" : blocker ? "无法验收" : "部分验证";
  const verdict = automaticVerdict === "通过" && manual.length > 0 ? "部分验证" : automaticVerdict;
  const record: Omit<AcceptanceRecord, "durationMs"> = {
    verdict, items, logErrors: input.logErrors, extra: input.report?.extra ?? [], runDir: input.runDir,
  };
  if (verdict === "无法验收") {
    record.blocker = blocker;
    record.reason = `${BLOCKER_TEXT[blocker!]}（${ids}）`;
  }
  if (verdict === "部分验证") record.reason = `${handOverParts(items).join("，")}，需要人工验收`;
  if (input.systemFailure && input.report === undefined) record.note = "系统没能正常运行，其余标准没有实测";
  // 被关掉时验收方的自报结论没有意义，不再提示对比。
  const claimed = input.report?.conclusion ?? "";
  if (claimed && !stopped && !claimed.startsWith(automaticVerdict)) record.note = `验收方自报「${claimed}」，程序按逐条结果判为「${automaticVerdict}」`;
  return record;
}

/** 数据状态说明：配了重置时程序每次验收前都重置；没配时提醒验收方不要自己清数据。 */
export function dataStateNote(resetConfigured: boolean): string {
  return resetConfigured
    ? "程序在首次验收和换强模型重验前已把数据重置到初始状态；同一次格式更正保留数据。"
    : "程序没有配置数据重置：数据可能还留着之前操作的结果。依赖初始状态、现在做不了的条目报「无法验证」，原因写「数据不是初始状态」；不要自己清数据、重启或关闭系统。";
}

/**
 * 证据有问题的条目，发回同一个验收会话重做一次。
 * 重做前程序重置过数据时，之前操作留下的数据已经不在了，要从 A1 起全部重测。
 */
export function buildCorrectionInput(record: Omit<AcceptanceRecord, "durationMs">, resetDone = false): string {
  const problems = record.items.filter((item) => item.evidenceProblem).map((item) => `- ${item.id}：${item.detail}`);
  return [
    resetDone ? "## 证据有问题，请从头重做" : "## 证据有问题，请重做这几条",
    ...problems,
    "",
    resetDone
      ? "程序已把数据重置到初始状态，之前操作留下的数据已经不在了：请按标准顺序从 A1 起全部重新实测。"
      : `已经留对的证据不用重跑。用 ./ev 或 ./browser 重新实测这些条目。同一次更正未重置数据，不要自己清数据、重启或关闭系统。`,
    "证据摘录必须从 evidence/<条目>.txt 里原样复制。不要启动、停止、重启被测系统。",
    "然后按系统提示里的格式，重新输出全部条目的结果。",
  ].join("\n") + "\n";
}

export interface AcceptanceInputOptions {
  round: number;
  requirement?: string;
  criteria: Criteria;
  workDir: string;
  runDir: string;
  baseUrl?: string;
  systemLog?: string;
  logFiles: string[];
  guide?: string;
  deliveryNote: string;
  previousFailed: string[];
  /** 配置了 acceptance.reset（程序每次验收前重置数据）。 */
  resetConfigured?: boolean;
  /** 用户已同意授权的 [授权] 条目。 */
  authorized?: string[];
  /** 开发方的「方法存疑」条目：照常实测，理由只作核对提示。 */
  methodDoubts?: { id: string; reason: string }[];
}

/** 拼验收方输入：环境、工具、需求、标准、操作说明、开发方的使用说明。 */
export function buildAcceptanceInput(options: AcceptanceInputOptions): string {
  const env = [
    `- 你的当前目录（运行目录）：${options.runDir}`,
    `- 被测项目目录：${options.workDir}（只在这里运行命令，不要读源码）`,
    options.baseUrl ? `- 系统地址：${options.baseUrl}（程序已经启动好）`
      : "- 系统没有常驻服务：直接调用命令来验收；标准要访问网址却连不上时，报「无法验证」，原因写「连不上被测系统」",
    options.systemLog ? `- 系统输出日志（实时写入）：${options.systemLog}` : "",
    options.baseUrl ? "- 被测系统由程序启动和关停：不要启动、停止、重启它，不要 kill 任何进程" : "",
    `- 数据：${dataStateNote(Boolean(options.resetConfigured))}`,
    ...options.logFiles.map((file) => `- 系统日志：${file}`),
    "- 留证据跑命令：./ev A1 -- <命令>；在项目目录里跑：./ev A1 --cwd <项目目录> -- <命令>",
    "- 操作网页：./browser A1 <步骤文件.json>",
  ].filter(Boolean);
  const parts = [
    "## 你的任务",
    `第 ${options.round} 轮验收：按下面的验收标准逐条黑盒实测，留下证据，按系统提示里的格式报告。`,
    "## 环境",
    env.join("\n"),
    "## 需求原文",
    stripCriteriaSection(options.requirement ?? "").trim() || "（没有记录需求原文，只按验收标准验收）",
    `## 验收标准（第 ${options.criteria.version} 版，来源：${options.criteria.source === "用户" ? "用户" : "自动起草"}）`,
    // 交给用户的条目不给验收方看，免得它去碰真实账号、正式数据。
    formatCriteria(options.criteria.items.filter((item) => !forUser(item))),
    ...(options.authorized?.length ? [
      "## 用户授权",
      `用户已同意你在这几条里按标准使用真实账号、真实环境：${options.authorized.join("、")}。只在这几条里用，不要扩大到别的条目；其余条目仍然不碰真实账号、正式数据和外部平台。`,
    ] : []),
    "## 操作说明（项目提供）",
    options.guide?.trim() || "（无）",
    "## 开发方的交付说明（只用来知道怎么操作，不能当作通过的依据）",
    options.deliveryNote.trim() || "（无）",
    ...(options.methodDoubts?.length ? [
      "## 开发方对验收方法的存疑（照常实测）",
      options.methodDoubts.map((item) => `- ${item.id}：${item.reason || "（没写理由）"}`).join("\n")
      + "\n开发方认可标准、只质疑方法或失败归因：这些条目照常判定，不能因为它的一句说明就记通过；按标准和你自己实测的证据报告。",
    ] : []),
  ];
  if (options.previousFailed.length > 0) {
    parts.push("## 上一轮", `上一轮没通过：${options.previousFailed.join("、")}。这一轮全部标准都要重新实测，上一轮的证据不算。`);
  }
  return `${parts.join("\n\n")}\n`;
}

/** 只读补判只列已有证据的条目，不提供重测动作或开发方自报的结果。 */
export function buildRecoveryInput(criteria: Criteria, runDir: string, ids: string[]): string {
  return [
    "## 只根据已有证据补写报告",
    "上一位验收方模型断线或挂住。不要重新实测，不运行命令，不写文件，不启动、停止或重置系统。只读下面的证据，按系统提示格式补写报告。",
    "证据不足以判断预期时必须报「无法验证」并写明具体缺失；不得从命令退出码或标准文字推定通过。证据摘录必须从证据中原样复制。",
    `## 验收标准（第 ${criteria.version} 版）`,
    formatCriteria(criteria.items.filter((item) => !forUser(item) && ids.includes(item.id))),
    "## 已有证据（只读）",
    ...ids.map((id) => `- ${id}：${runDir}/evidence/${id}.txt`),
    "未列出的条目没有可供补判的证据，不得补成通过。",
  ].join("\n\n") + "\n";
}

/** 拼起草输入：只给需求原文。 */
export function buildCriteriaDraftInput(requirement: string): string {
  return `## 需求原文\n\n${requirement.trim()}\n`;
}

/** 不通过的条目：标准原文 + 复现/预期/实际/日志/证据，每条一块。 */
export function formatFailedItems(record: Pick<AcceptanceRecord, "items">): string {
  return record.items.filter((item) => item.verdict === "不通过").map((item) => {
    const [first, ...rest] = item.text.split("\n");
    const body = [...rest, ...item.detail.split("\n")].map((line) => `    ${line}`);
    return [`${item.id}. ${first}`, ...body].join("\n");
  }).join("\n\n");
}

/** 发回开发方的验收返修消息：只带不通过的条目。 */
export function buildAcceptanceRepairMessage(repairRound: number, record: AcceptanceRecord): string {
  return [
    `【自动验收 · 第 ${repairRound} 次返修】`,
    "以下验收标准实测没有通过（标准外的发现已记录在总结里，这次不用处理）：",
    "",
    formatFailedItems(record),
    "",
    `完整材料（系统日志、证据）：${record.runDir}`,
    "请逐条处理：修好的写「A2：已修」；认为标准本身有问题的写「A2：异议：理由」（异议交用户决定）；认可标准、只质疑验收方法或失败归因的写「A2：方法存疑：理由」（照常验收，理由交给验收方核对）。全部处理完，最后一行写【交付完成】。",
  ].join("\n");
}

/** 评审输入里的验收结果：告诉评审不用再启动系统。 */
export function renderAcceptanceForReview(record: AcceptanceRecord): string {
  const allManual = record.items.length > 0 && record.items.every((item) => item.verdict === "需人工");
  const summary = allManual
    ? "此前验收标准全部交给用户，程序没有启动系统实测。"
    : `此前验收记录：${record.verdict}。${record.reason ?? ""}这不是当前候选已通过的依据；本轮静态评审不要启动系统或重跑 E2E。`;
  return [
    "## 验收结果",
    summary,
    ...record.items.map((item) => `- ${item.id}：${item.verdict} —— ${item.text.split("\n")[0]}`),
  ].join("\n");
}

/** 总结里一轮验收的几行。 */
export function renderAcceptanceLines(record: AcceptanceRecord): string[] {
  const lines = [`验收：${record.verdict}（耗时 ${Math.round(record.durationMs / 1000)} 秒；材料：${record.runDir}）`];
  if (record.escalated) lines.push("验收方：第一位没按要求做，已换强模型重验");
  if (record.recovery) lines.push(`验收方：${record.recovery.reason}；${record.recovery.attempted ? "已用强模型只读已有证据补写报告（未重新实测）" : "未调用补报告"}${record.recovery.error ? `；${record.recovery.error}` : ""}`);
  for (const item of record.cleanup ?? []) lines.push(`验收收尾：${item}`);
  if (record.reason) lines.push(`验收说明：${record.reason}`);
  if (record.methodDoubts?.length) {
    lines.push(`验收方法存疑（照常验收，不作为通过依据）：${record.methodDoubts.map((item) => `${item.id}：${item.reason || "（没写理由）"}`).join("；")}`);
  }
  if (record.note) lines.push(`验收提示：${record.note}`);
  for (const item of record.items) {
    const detail = item.verdict === "无法验证" ? item.detail.replace(/\s*\n\s*/g, "；") : item.detail.split("\n")[0];
    lines.push(`- ${item.id}：${item.verdict}${item.verdict === "通过" ? "" : ` —— ${detail}`}`);
    const execution = item.execution;
    for (const command of execution?.commands ?? []) lines.push(`  实际命令：$ ${command}`);
    for (const script of execution?.scripts ?? []) lines.push(`  验收方脚本：${script}`);
    if (!execution?.commands.length && !execution?.scripts.length) {
      lines.push(`  实际执行：${item.verdict === "需人工" ? "未执行（交给用户）" : item.id === "G2" ? `程序扫描系统日志（${record.runDir}/system.log、logs/）` : "未留下命令或脚本证据"}`);
    }
  }
  return lines;
}
