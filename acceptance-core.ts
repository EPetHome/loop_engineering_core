/**
 * acceptance-core.ts — 自动验收的纯函数，不导入 pi、不起进程。
 *
 * 负责：从用户消息取「## 验收标准」、解析起草结果和验收方报告、扫日志、核对证据、
 * 逐条判定、拼验收方输入和返修消息、验收约定原文。判定只看逐条结果和证据，不信验收方自报的结论。
 * 开头标了「[人工]」的条目不交给验收方，判为「需人工」，完成时列给用户人工验收。
 */

/** 配了 acceptance 的项目，追加在开发约定后面注入。 */
export const ACCEPTANCE_CONVENTION = [
  "【自动验收约定】",
  "- 用户让你起草需求或提示词时，末尾加「## 验收标准」：每条写「操作」和「预期」，只写外部看得到的结果（命令输出、页面、接口返回、数据变化、日志），一条只验一个行为，最多 10 条，只覆盖本次需求。",
  "- 验收方只能用命令、接口、无头浏览器和读日志、文件来验；只能在桌面应用图形界面里做、必须用真实账号或外部平台、要人主观判断的条目，开头标「[人工]」，由用户验收。",
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
/** 判定结果多一种「需人工」：标了 [人工] 的条目，程序不交给验收方。 */
export type ResultVerdict = ItemVerdict | "需人工";

/** 条目开头（可以在别的 [标签] 或「操作：」之后）写了「[人工]」或「【人工】」。 */
const MANUAL_TAG = /^\s*(?:[[【][^\]】\n]*[\]】]\s*)*(?:操作\s*[:：]\s*)?[[【]\s*人工\s*[\]】]/;

/** 标了 [人工] 的验收标准：验收方验不了，由用户人工验收。 */
export function isManualCriterion(text: string): boolean {
  return MANUAL_TAG.test(text);
}

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

/**
 * 无法验证的原因，决定后续怎么走：验收方没做好 → 换强模型重验；没配启动、缺工具 → 暂停并告诉你复制哪一块；
 * 系统被关掉、数据不干净 → 暂停交给你（不算开发方的错）；
 * 其他（标准含糊、环境不通）→ 个别条目留给人工，全部都这样才暂停。
 */
export type UnknownCause = "系统被关掉" | "数据不干净" | "验收方" | "没配启动" | "缺工具" | "其他";

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
}

export interface AcceptanceRecord {
  /** 部分验证：其余全部通过，只有个别条目没法自动验证或标了 [人工]（留给你人工验收），照常进入评审。 */
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
  note?: string;
  /** 收尾时清理端口上残留进程的记录。 */
  cleanup?: string[];
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
  /** 按标准顺序逐条判定；标了 [人工] 的不看验收方报告，直接记「需人工」。 */
  const each = (judge: (criterion: CriterionItem) => AcceptanceItemResult): void => {
    for (const criterion of input.criteria) {
      items.push(isManualCriterion(criterion.text) ? { ...criterion, verdict: "需人工", detail: MANUAL_DETAIL } : judge(criterion));
    }
  };
  if (input.report) {
    const report = input.report;
    each((criterion) => {
      const reported = report.items.find((item) => item.id === criterion.id);
      const evidencePath = `${input.runDir}/evidence/${criterion.id}.txt`;
      const content = input.evidence(criterion.id);
      if (!reported) {
        return { ...criterion, verdict: "无法验证", detail: "验收方没有报告这一条", evidenceProblem: true, cause: "验收方" };
      }
      if (reported.verdict === "无法验证") {
        const reason = reported.fields["原因"] || "验收方没写原因";
        return {
          ...criterion, verdict: "无法验证", detail: `原因：${reason}`,
          cause: classifyUnknown(criterion, reason, content, input.hasService, Boolean(stopped)),
        };
      }
      const excerpt = normalize(reported.fields["证据摘录"] ?? "");
      let problem = "";
      if (!content || !content.includes(`=== ${criterion.id} `)) problem = `没有用 ./ev 或 ./browser 留下证据（${evidencePath}）`;
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
    each((criterion) => ({ ...criterion, verdict: "无法验证", detail: `原因：${input.reportError || "验收方没有给出报告"}`, cause: "验收方" }));
  } else {
    // 系统没能正常运行：自动的条目没有实测，不逐条列；[人工] 条目照样列给你。
    for (const criterion of input.criteria) {
      if (isManualCriterion(criterion.text)) items.push({ ...criterion, verdict: "需人工", detail: MANUAL_DETAIL });
    }
  }
  if (input.logErrors.length > 0) {
    // 被关掉时，日志里的错误可能是关停时打的：这一轮不据此打回，留给你看。
    items.push(stopped
      ? { id: "G2", text: G2_TEXT, verdict: "无法验证", cause: "系统被关掉", detail: `系统被关掉前后日志里有错误（可能是关停时打的），这一轮不据此打回：\n${input.logErrors.join("\n")}` }
      : { id: "G2", text: G2_TEXT, verdict: "不通过", detail: input.logErrors.join("\n") });
  }
  const failed = items.some((item) => item.verdict === "不通过");
  const unknown = items.filter((item) => item.verdict === "无法验证");
  const manual = items.filter((item) => item.verdict === "需人工");
  const automatic = input.criteria.length - manual.length;
  const ids = unknown.map((item) => item.id).join("、");
  const blocker = (["系统被关掉", "数据不干净", "没配启动", "缺工具", "验收方"] as const).find((cause) => unknown.some((item) => item.cause === cause))
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
  if (verdict === "部分验证") {
    const manualIds = manual.map((item) => item.id).join("、");
    record.reason = `${[ids && `${ids} 没能自动验证`, manualIds && `${manualIds} 标了 [人工]`].filter(Boolean).join("，")}，需要人工验收`;
  }
  if (input.systemFailure && input.report === undefined) record.note = "系统没能正常运行，其余标准没有实测";
  // 被关掉时验收方的自报结论没有意义，不再提示对比。
  const claimed = input.report?.conclusion ?? "";
  if (claimed && !stopped && !claimed.startsWith(automaticVerdict)) record.note = `验收方自报「${claimed}」，程序按逐条结果判为「${automaticVerdict}」`;
  return record;
}

/** 数据状态说明：配了重置时程序每次验收前都重置；没配时提醒验收方不要自己清数据。 */
export function dataStateNote(resetConfigured: boolean): string {
  return resetConfigured
    ? "程序在每次验收前都已把数据重置到初始状态。"
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
      : `用 ./ev 或 ./browser 重新实测这些条目。${dataStateNote(false)}`,
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
    // 标了 [人工] 的条目不给验收方看，免得它去碰桌面应用或真实账号。
    formatCriteria(options.criteria.items.filter((item) => !isManualCriterion(item.text))),
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
  const allManual = record.items.length > 0 && record.items.every((item) => item.verdict === "需人工");
  const summary = allManual
    ? `验收标准全部标了 [人工]，程序没有启动系统实测，由用户人工验收；你照常评审，不需要启动系统或跑端到端测试。`
    : record.verdict === "部分验证"
      ? `程序已经启动系统、按验收标准黑盒实测：其余全部通过，${record.reason}；验收期间系统日志没有错误。你不需要再启动系统或跑端到端测试。`
      : "程序已经启动系统、按验收标准黑盒实测，全部通过，验收期间系统日志没有错误。你不需要再启动系统或跑端到端测试。";
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
  for (const item of record.cleanup ?? []) lines.push(`验收收尾：${item}`);
  if (record.reason) lines.push(`验收说明：${record.reason}`);
  if (record.note) lines.push(`验收提示：${record.note}`);
  for (const item of record.items) {
    lines.push(`- ${item.id}：${item.verdict}${item.verdict === "通过" ? "" : ` —— ${item.detail.split("\n")[0]}`}`);
  }
  return lines;
}
