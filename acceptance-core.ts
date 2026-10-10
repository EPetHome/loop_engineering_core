/**
 * acceptance-core.ts — 自动验收的纯函数，不导入 pi、不起进程。
 *
 * 负责：从用户消息取「## 验收标准」、解析起草结果和验收方报告、扫日志、核对证据、
 * 逐条判定、拼验收方输入和返修消息、验收约定原文。判定只看逐条结果和证据，不信验收方自报的结论。
 */

/** 配了 acceptance 的项目，追加在开发约定后面注入。 */
export const ACCEPTANCE_CONVENTION = [
  "【自动验收约定】",
  "- 用户让你起草需求或提示词时，末尾加「## 验收标准」：每条写「操作」和「预期」，只写外部看得到的结果（命令输出、页面、接口返回、数据变化、日志），一条只验一个行为，最多 10 条，只覆盖本次需求。",
  "- 开发时不要补写或修改验收标准，标准只认用户发来的。",
  "- 交付说明里写清新功能怎么用（命令、地址、参数），验收方按它操作。",
  "- 收到「自动验收」消息后，逐条写「A2：已修」或「A2：异议：理由」；异议交用户决定。",
].join("\n");
/** 起草时最多保留的条数；用户自己写的不截断，只在总结里提示。 */
export const MAX_CRITERIA = 10;

export interface CriterionItem {
  id: string;
  text: string;
}

export interface Criteria {
  source: "用户" | "自动起草";
  items: CriterionItem[];
  version: number;
  updatedAt: string;
}

export type ItemVerdict = "通过" | "不通过" | "无法验证";

export interface ReportItem {
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

export interface AcceptanceItemResult {
  id: string;
  /** 标准原文；G1/G2 是程序自带的全局标准。 */
  text: string;
  verdict: ItemVerdict;
  /** 给开发方和总结看的说明。 */
  detail: string;
  /** 证据有问题（可以让验收方重做一次）。 */
  evidenceProblem?: boolean;
}

export interface AcceptanceRecord {
  verdict: "通过" | "不通过" | "无法验收";
  items: AcceptanceItemResult[];
  logErrors: string[];
  extra: string[];
  runDir: string;
  durationMs: number;
  /** 无法验收的原因。 */
  reason?: string;
  note?: string;
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
    if (!line) continue;
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

/** 开发方回复里对验收标准提异议的编号（A2：异议…）。 */
export function findObjections(text: string): string[] {
  const ids = new Set<string>();
  for (const match of unbold(text).matchAll(/^\s*[-*]?\s*([AG]\d+)\s*[：:]\s*异议/gm)) ids.add(match[1].toUpperCase());
  return [...ids];
}

export interface JudgeInput {
  criteria: CriterionItem[];
  /** 验收方报告；验收方两次都没给出可解析的报告时为空。 */
  report?: ParsedAcceptance;
  reportError?: string;
  /** 读 evidence/<id>.txt；不存在返回 undefined。 */
  evidence: (id: string) => string | undefined;
  /** 系统没能启动或中途退出的说明（G1）。 */
  systemFailure?: string;
  logErrors: string[];
  runDir: string;
}

const G1_TEXT = "系统能按配置启动、就绪，并在验收过程中一直运行";
const G2_TEXT = "验收期间系统日志里没有错误";

function failDetail(item: ReportItem, evidencePath: string): string {
  const order = ["复现", "预期", "实际", "相关日志"];
  const lines = order.filter((key) => item.fields[key]).map((key) => `${key}：${item.fields[key]}`);
  lines.push(`证据：${evidencePath}`);
  return lines.join("\n");
}

/**
 * 逐条判定。通过/不通过都必须有工具写下的证据，且证据摘录确实在证据文件里，否则降为无法验证。
 * 有不通过（含 G1/G2）→ 不通过；否则有无法验证 → 无法验收；否则通过。
 */
export function judgeAcceptance(input: JudgeInput): Omit<AcceptanceRecord, "durationMs"> {
  const items: AcceptanceItemResult[] = [];
  if (input.systemFailure) {
    items.push({ id: "G1", text: G1_TEXT, verdict: "不通过", detail: input.systemFailure });
  }
  if (input.report) {
    for (const criterion of input.criteria) {
      const reported = input.report.items.find((item) => item.id === criterion.id);
      const evidencePath = `${input.runDir}/evidence/${criterion.id}.txt`;
      if (!reported) {
        items.push({ ...criterion, verdict: "无法验证", detail: "验收方没有报告这一条", evidenceProblem: true });
        continue;
      }
      if (reported.verdict === "无法验证") {
        items.push({ ...criterion, verdict: "无法验证", detail: `原因：${reported.fields["原因"] || "验收方没写原因"}` });
        continue;
      }
      const content = input.evidence(criterion.id);
      const excerpt = normalize(reported.fields["证据摘录"] ?? "");
      let problem = "";
      if (!content || !content.includes(`=== ${criterion.id} `)) problem = `没有用 ./ev 或 ./browser 留下证据（${evidencePath}）`;
      else if (excerpt.length < 2) problem = "没有写证据摘录";
      else if (!normalize(content).includes(excerpt)) problem = `证据摘录在 ${evidencePath} 里找不到`;
      if (problem) {
        items.push({ ...criterion, verdict: "无法验证", detail: `原因：报告「${reported.verdict}」，但${problem}`, evidenceProblem: true });
        continue;
      }
      items.push({
        ...criterion, verdict: reported.verdict,
        detail: reported.verdict === "通过" ? `证据摘录：${reported.fields["证据摘录"]}` : failDetail(reported, evidencePath),
      });
    }
  } else if (!input.systemFailure) {
    for (const criterion of input.criteria) {
      items.push({ ...criterion, verdict: "无法验证", detail: `原因：${input.reportError || "验收方没有给出报告"}` });
    }
  }
  if (input.logErrors.length > 0) {
    items.push({ id: "G2", text: G2_TEXT, verdict: "不通过", detail: input.logErrors.join("\n") });
  }
  const failed = items.some((item) => item.verdict === "不通过");
  const unknown = items.filter((item) => item.verdict === "无法验证");
  const verdict = failed ? "不通过" : unknown.length > 0 ? "无法验收" : "通过";
  const record: Omit<AcceptanceRecord, "durationMs"> = {
    verdict, items, logErrors: input.logErrors, extra: input.report?.extra ?? [], runDir: input.runDir,
  };
  if (verdict === "无法验收") record.reason = `${unknown.map((item) => item.id).join("、")} 无法验证`;
  if (input.systemFailure && input.report === undefined) record.note = "系统没能正常运行，其余标准没有实测";
  const claimed = input.report?.conclusion ?? "";
  if (claimed && !claimed.startsWith(verdict)) record.note = `验收方自报「${claimed}」，程序按逐条结果判为「${verdict}」`;
  return record;
}

/** 证据有问题的条目，发回同一个验收会话重做一次。 */
export function buildCorrectionInput(record: Omit<AcceptanceRecord, "durationMs">): string {
  const problems = record.items.filter((item) => item.evidenceProblem).map((item) => `- ${item.id}：${item.detail}`);
  return [
    "## 证据有问题，请重做这几条",
    ...problems,
    "",
    "用 ./ev 或 ./browser 重新实测这些条目；证据摘录必须从 evidence/<条目>.txt 里原样复制。",
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
}

/** 拼验收方输入：环境、工具、需求、标准、操作说明、开发方的使用说明。 */
export function buildAcceptanceInput(options: AcceptanceInputOptions): string {
  const env = [
    `- 你的当前目录（运行目录）：${options.runDir}`,
    `- 被测项目目录：${options.workDir}（只在这里运行命令，不要读源码）`,
    options.baseUrl ? `- 系统地址：${options.baseUrl}（程序已经启动好）` : "- 系统没有常驻服务：直接调用命令来验收",
    options.systemLog ? `- 系统输出日志（实时写入）：${options.systemLog}` : "",
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
    formatCriteria(options.criteria.items),
    "## 操作说明（项目提供）",
    options.guide?.trim() || "（无）",
    "## 开发方的交付说明（只用来知道怎么操作，不能当作通过的依据）",
    options.deliveryNote.trim() || "（无）",
  ];
  if (options.previousFailed.length > 0) {
    parts.push("## 上一轮", `上一轮没通过：${options.previousFailed.join("、")}。这一轮全部标准都要重新实测，上一轮的证据不算。`);
  }
  return `${parts.join("\n\n")}\n`;
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
    "请逐条处理：修好的写「A2：已修」；认为标准本身有问题的写「A2：异议：理由」（异议交用户决定）。全部处理完，最后一行写【交付完成】。",
  ].join("\n");
}

/** 评审输入里的验收结果：告诉评审不用再启动系统。 */
export function renderAcceptanceForReview(record: AcceptanceRecord): string {
  return [
    "## 验收结果",
    "程序已经启动系统、按验收标准黑盒实测，全部通过，验收期间系统日志没有错误。你不需要再启动系统或跑端到端测试。",
    ...record.items.map((item) => `- ${item.id}：${item.verdict} —— ${item.text.split("\n")[0]}`),
  ].join("\n");
}

/** 总结里一轮验收的几行。 */
export function renderAcceptanceLines(record: AcceptanceRecord): string[] {
  const lines = [`验收：${record.verdict}（耗时 ${Math.round(record.durationMs / 1000)} 秒；材料：${record.runDir}）`];
  if (record.reason) lines.push(`验收说明：${record.reason}`);
  if (record.note) lines.push(`验收提示：${record.note}`);
  for (const item of record.items) {
    lines.push(`- ${item.id}：${item.verdict}${item.verdict === "通过" ? "" : ` —— ${item.detail.split("\n")[0]}`}`);
  }
  return lines;
}
