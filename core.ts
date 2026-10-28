/**
 * core.ts — 纯函数集合，不导入 pi。
 *
 * 负责：交付标记判断、评审输出解析、下一步决策、返修消息拼接（评审、门禁）、
 * 评审输入拼接、总结渲染、注入给开发方的约定。所有函数可被 Node 直接单测。
 */
import { createHash } from "node:crypto";
import {
  ACCEPTANCE_CONVENTION, authorizationLine, formatCriteria, renderAcceptanceLines, type AcceptanceRecord, type Criteria, type Grants,
} from "./acceptance-core.ts";

export const MARKER_DELIVERED = "【交付完成】";
export const MARKER_DECISION = "【需要你决定】";
/** 开发方约定，pi 扩展与宿主 Hook 注入同一份原文。 */
export const CONVENTION = [
  "【自动评审约定】",
  "- 交付时最后一行写【交付完成】，评审会立即开始；不写的话，程序检测到改动也会自动评审。",
  "- 需要用户决定时，最后一行写【需要你决定】。",
  "- 收到「自动评审」消息后，逐条写「第 N 条：已修」或「第 N 条：异议：理由」。",
  "- 需求可能只写了目标、已拍板、边界和验收标准：现状自己读代码了解，没写到的细节按现有代码习惯做，拿不准的写进交付说明。",
].join("\n");

/** 配了门禁（.autoreview.json 的 gate）时追加在开发约定后面注入。 */
export function gateConvention(command: string): string {
  return [
    "【门禁约定】",
    `- 开发时做改动相关的定向自测；交付后由程序统一执行完整门禁：${command}。不要求你在交付前重复执行同一份完整门禁。`,
    "- 产品检查失败会带证据返回原会话；明确环境和检查方法故障不计业务返修。原因不明时先诊断，不修改产品绕过检查。",
  ].join("\n");
}

/** 注入给开发方的约定全文：开发约定，配了验收再追加验收约定，配了门禁再追加门禁约定。 */
export function conventionText(options: { acceptance?: boolean; gate?: string; experience?: string } = {}): string {
  return [CONVENTION, options.acceptance ? ACCEPTANCE_CONVENTION : "", options.gate ? gateConvention(options.gate) : "", options.experience ?? ""]
    .filter(Boolean).join("\n");
}

/** 返修消息和总结里保留的门禁输出：最后 40 行，最多 4000 字。 */
export const GATE_TAIL_LINES = 40;
const GATE_TAIL_CHARS = 4000;
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
  /** 本轮的验收结果（配了 acceptance 时）。 */
  acceptance?: AcceptanceRecord;
  /** 本轮的门禁结果（配了 gate 时）。 */
  gate?: GateRecord;
  /** 验收后置时，整体轮次可能未通过；单独保留已取得的静态评审结论。 */
  reviewConclusion?: string;
};

/**
 * 门禁的一次执行。只有命令跑完并且退出码非 0 才算「不通过」打回开发方；
 * 超时、命令找不到（126/127）、起不来都暂停，不冤枉开发方。
 */
export interface GateRecord {
  command: string;
  result: "通过" | "不通过" | "超时" | "无法执行" | "环境阻塞" | "检查方法故障" | "原因待诊断";
  durationMs: number;
  exitCode?: number;
  /** 输出最后几行（stdout 与 stderr 按出现顺序合在一起）。 */
  outputTail?: string;
  /** 完整输出所在的日志文件。 */
  logPath?: string;
  detail?: string;
  cleanup?: string;
}

/** 验收命令（--autoreview-accept-cmd）的一次执行；与自动验收无关，只有 pi 扩展配置了验收命令时才有。 */
export interface AcceptRunRecord {
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
  /** required 必须通过才允许段接力；advisory 只记录附加检查。 */
  mode?: "required" | "advisory";
  candidate?: string;
  readyEpoch?: string;
  inputsFingerprint?: string;
  failureKind?: import("./failure.ts").FailureKind;
  cleanup?: string;
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
  /** 冻结的验收标准（配了 acceptance 时）。 */
  criteria?: Criteria;
  /** 你对 [授权] 条目的答复。 */
  grants?: Grants;
  /** 最近一次验收没通过的条目。 */
  unresolvedAcceptance?: string;
  /** 需要你做的事（暂停时怎么继续、人工验收的条目、接入提醒），放在总结开头。 */
  todos?: string[];
  /** 最近一次验收命令的执行结果。 */
  acceptRun?: AcceptRunRecord;
  /** 开发基线之后开发方新增的提交数（只记录，不评判）。 */
  newCommits?: number;
  /** 开发期间发现变化的来源文件与时间。 */
  sourceChanges?: { path: string; at: string }[];
  /** 拿不到文件列表时的说明（如「来源有变化（第 3 版）」）。 */
  sourceChangeNote?: string;
  /** 本次完成已登记的交付总表；只在状态为完成时写进总结开头。 */
  ledger?: { path: string; pending: { id: string; kind: "部分验证" | "人工" }[]; failed?: boolean };
  /** 完成后的运行材料瘦身结果；删除失败仅提示。 */
  materialCleanup?: string;
  /** Pi 开发会话启动时确认未注册 Ponytail；只在完成总结开头提醒，不改变结果。 */
  ponytailMissing?: boolean;
}

export interface ReviewInputOptions {
  currentCriteria?: string;
  projectContext?: string;
  experienceChecklist?: string;
  round: number;
  /** 没有成功检查点时，即使调用轮次大于 1 也重送首轮材料。 */
  firstReview?: boolean;
  requirement?: string;
  deliveryNote: string;
  previousMustFix?: string;
  diff: string;
  diffStat: string;
  untracked: string[];
  /** 此前验收记录，仅供静态评审复查，不能作为当前候选已验收的依据。 */
  acceptance?: string;
  /** 本轮通过的门禁命令（门禁通过后才会评审）。 */
  gate?: string;
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

/** 门禁输出的尾巴：最后 GATE_TAIL_LINES 行，再按字数截一次（单行很长时也不撑爆返修消息）。 */
export function gateOutputTail(output: string): string {
  const lines = output.trimEnd().split(/\r?\n/).slice(-GATE_TAIL_LINES).join("\n");
  return lines.length <= GATE_TAIL_CHARS ? lines : `…${lines.slice(-GATE_TAIL_CHARS)}`;
}

/** 门禁结果的一句话写法，返修消息、总结共用。 */
export function gateLabel(record: GateRecord): string {
  return record.result === "不通过" ? `不通过（退出码 ${record.exitCode ?? "未知"}）` : record.result;
}

/** 发回开发方的门禁返修消息：命令、退出码、输出尾巴和完整日志位置。 */
export function buildGateRepairMessage(repairRound: number, record: GateRecord): string {
  return [
    `【门禁 · 第 ${repairRound} 次返修】`,
    `门禁命令${gateLabel(record)}，这一轮没有验收、没有评审。`,
    "",
    `$ ${record.command}`,
    `输出最后 ${GATE_TAIL_LINES} 行：`,
    "```text",
    record.outputTail?.trim() || "（没有输出）",
    "```",
    ...(record.logPath ? [`完整输出：${record.logPath}`] : []),
    "",
    "根据失败证据定位根因及相关调用方，修复后做必要的定向自测；完整门禁由程序重跑，不必再次自跑整套。修好了最后一行写【交付完成】。无法归因时如实说明，不更改产品或检查标准凑通过。",
  ].join("\n");
}

/** 总结里一轮门禁的几行；没通过时带输出尾巴。 */
export function renderGateLines(record: GateRecord): string[] {
  const lines = [`门禁：${gateLabel(record)}（耗时 ${Math.round(record.durationMs / 1000)} 秒${record.logPath ? `；完整输出：${record.logPath}` : ""}）`];
  if (record.detail) lines.push(`门禁说明：${record.detail}`);
  if (record.cleanup) lines.push(`资源：${record.cleanup}`);
  if (record.result !== "通过" && record.outputTail?.trim()) lines.push("门禁输出最后几行：", "```text", record.outputTail.trimEnd(), "```");
  return lines;
}

/** 拼评审输入：尚无成功评审时带需求原文，否则带成功检查点的必修。 */
export function buildReviewInput(options: ReviewInputOptions): string {
  const parts: string[] = [];
  if (options.projectContext) parts.push("## 项目来源与代码定位", options.projectContext);
  if (options.experienceChecklist) parts.push("## 对照清单", options.experienceChecklist);
  if (options.currentCriteria) parts.push("## 当前验收标准与授权（覆盖历史消息中的旧版本）", options.currentCriteria);
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
  if (options.gate) {
    parts.push(`## 门禁\n程序已在项目目录执行门禁命令 ${options.gate}，退出码 0（通过）。你不需要再跑它。`);
  }
  if (options.acceptance) parts.push(options.acceptance);
  return `${parts.join("\n\n")}\n`;
}

/**
 * 由开发会话 id 推出固定的子会话 id：rev 评审、acc 验收方、acc-strong 重验、acc-report 只读补报告、crit 起草标准。
 * 格式不合法时退化为 sha256 派生的 UUID 形式；评审沿用旧算法，已有评审会话 id 不变。
 */
export function deriveSessionId(kind: "rev" | "acc" | "acc-strong" | "acc-report" | "crit", devSessionId: string): string {
  const candidate = `autoreview-${kind}-${devSessionId}`;
  if (/^[A-Za-z0-9]$/.test(candidate) || /^[A-Za-z0-9][A-Za-z0-9._-]*[A-Za-z0-9]$/.test(candidate)) {
    return candidate;
  }
  const digest = createHash("sha256").update(kind === "rev" ? devSessionId : `${kind}:${devSessionId}`).digest("hex").slice(0, 32);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
}

export function deriveReviewerSessionId(devSessionId: string): string {
  return deriveSessionId("rev", devSessionId);
}

/** 验收命令结果的一句话写法，总结、通知和状态命令共用。 */
export function acceptRunLabel(record: AcceptRunRecord): string {
  return record.result === "不通过" ? `不通过（退出码 ${record.exitCode ?? "未知"}）` : record.result;
}

/** 渲染总结（6.13 格式），每轮评审后覆盖写。 */
export function renderSummary(input: SummaryInput): string {
  const lines: string[] = [];
  const status = input.status === "暂停" ? `暂停（${input.pauseReason ?? "未知原因"}）` : input.status;
  lines.push("# 自动评审总结");
  if (input.status === "完成" && input.ponytailMissing) lines.push("未加载 Ponytail（开发角色要求加载）");
  if (input.status === "完成" && input.ledger) {
    if (input.ledger.failed) lines.push(`- 交付总表写入失败：${input.ledger.path}（会话照常完成）`);
    else {
      const pending = input.ledger.pending.length > 0
        ? `（${input.ledger.pending.map((item) => `${item.id} ${item.kind}`).join("、")}）` : "";
      lines.push(`- 已登记到交付总表：${input.ledger.path}；待回写原单${pending}`);
    }
  }
  lines.push(`- 项目：${input.cwd}`);
  lines.push(`- 开发会话：${input.devSessionId}　评审会话：${input.reviewerSessionId}`);
  lines.push(`- 状态：${status}`);
  lines.push(`- 评审 ${input.rounds.length} 次，返修 ${input.repairs} 次`);
  if (input.status === "完成" && input.materialCleanup) lines.push(`- ${input.materialCleanup}`);
  if (input.acceptRun) {
    lines.push(`- 验收命令：${acceptRunLabel(input.acceptRun)}`);
    lines.push(`- 验收命令用途：${input.acceptRun.mode === "required" ? "本段必需验收" : "附加检查"}`);
  }
  if (input.newCommits) lines.push(`- 开发方新增提交：${input.newCommits} 个（基线之后，只记录不评判）`);
  if (input.notes) lines.push(`- 说明：${input.notes}`);
  const sourceChanges = input.sourceChanges ?? [];
  if (sourceChanges.length > 0 || input.sourceChangeNote) {
    lines.push("## 开发期间来源变化");
    if (sourceChanges.length > 0) lines.push(...sourceChanges.map((change) => `- ${change.path}（${change.at}）`));
    else lines.push(input.sourceChangeNote!);
  }
  if (input.todos && input.todos.length > 0) {
    lines.push("## 需要你做的事");
    lines.push(...input.todos.map((todo, index) => `${index + 1}. ${todo}`));
  }
  if (input.criteria) {
    const source = input.criteria.source === "用户" ? "你写的" : "自动起草，未经你确认";
    lines.push(`## 验收标准（${source}；第 ${input.criteria.version} 版）`);
    lines.push(formatCriteria(input.criteria.items));
    const authorization = authorizationLine(input.criteria, input.grants);
    if (authorization) lines.push(`授权：${authorization}`);
  }
  const bullets = (items: string[], prefix = ""): void => {
    lines.push(...(items.length > 0 ? items.map((item) => `- ${prefix}${item}`) : ["- 无"]));
  };
  const accept = input.acceptRun;
  if (accept) {
    lines.push("## 验收命令");
    lines.push(`- 命令：${accept.command}`);
    lines.push(`- 触发：${accept.trigger === "auto" ? `第 ${accept.round} 轮评审完成后自动执行` : "手动 /accept"}`);
    lines.push(`- 开始：${accept.startedAt}${accept.durationMs === undefined ? "" : `，耗时 ${Math.round(accept.durationMs / 1000)} 秒`}`);
    lines.push(`- 结果：${acceptRunLabel(accept)}`);
    if (accept.detail) lines.push(`- 说明：${accept.detail}`);
    if (accept.cleanup) lines.push(`- 资源：${accept.cleanup}`);
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
    if (round.gate) lines.push(...renderGateLines(round.gate));
    if (round.acceptance) lines.push(...renderAcceptanceLines(round.acceptance));
  }
  if (input.status === "暂停" && input.unresolvedMustFix?.trim()) {
    lines.push("## 未解决的必修");
    lines.push(input.unresolvedMustFix.trim());
  }
  if (input.status === "暂停" && input.unresolvedAcceptance?.trim()) {
    lines.push("## 未通过的验收标准");
    lines.push(input.unresolvedAcceptance.trim());
  }
  if (input.changedFiles && input.changedFiles.length > 0) {
    const stage = /^(验收|门禁)期间工作区变了$/.exec(input.pauseReason ?? "")?.[1] ?? "评审";
    lines.push(`## ${stage}期间变化的工作区文件`);
    lines.push(...input.changedFiles.map((file) => `- ${file}`));
  }
  lines.push("## 小问题汇总（待你决定）");
  bullets(input.rounds.flatMap((round) => round.minor.map((item) => `第 ${round.round} 轮：${item}`)));
  lines.push("## 需求疑问（待你决定）");
  bullets(input.rounds.flatMap((round) => round.questions.map((item) => `第 ${round.round} 轮：${item}`)));
  if (input.rounds.some((round) => round.acceptance)) {
    lines.push("## 验收额外发现（待你决定）");
    bullets(input.rounds.flatMap((round) => (round.acceptance?.extra ?? []).map((item) => `第 ${round.round} 轮：${item}`)));
  }
  lines.push("## 改动文件（git status --short）");
  lines.push(input.gitStatusShort.trim() || "（干净）");
  return `${lines.join("\n")}\n`;
}
