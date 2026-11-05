/** 接入与验收的下一步提示；规则只在 Loop 仓库维护，不读取项目规则副本。 */
import { join } from "node:path";
import { handOverParts, isManualCriterion, type AcceptanceRecord, type Criteria } from "./acceptance-core.ts";
import { EXT_DIR, MARKER_FILE, type AcceptanceConfig } from "./config.ts";
import { shellQuote } from "./workspace.ts";

export const GUIDE_DOC = join(EXT_DIR, "README-验收标准.md");
const LOOP_BIN = join(EXT_DIR, "bin", "loop");
export const CONFIG_SECTION = "可选配置：被测系统怎么启动";
export const BROWSER_SECTION = "可选配置：浏览器工具";

export function browserHint(workDir: string, then = ""): string {
  return `在 ${workDir} 里按 ${GUIDE_DOC}「${BROWSER_SECTION}」安装 Playwright 和 Chromium${then ? `，然后${then}` : ""}`;
}

export function configFile(acceptance: AcceptanceConfig): string {
  return join(acceptance.root, MARKER_FILE);
}

const RESUME = "再给开发方发一条消息继续";

/** 无法验收时给你的下一步：指向项目配置或 Loop 仓库里的说明。 */
export function blockerHint(record: AcceptanceRecord, workDir: string, acceptance: AcceptanceConfig): string {
  switch (record.blocker) {
    case "系统被关掉":
      return `被测系统在验收途中被关掉了，多半是验收方自己关的（或重置命令重启了服务），不是开发方的问题，这一轮作废、没有打回开发方。`
        + `需要干净数据的项目请在 ${configFile(acceptance)} 配置 acceptance.reset（只重置数据、不重启服务，写法见 ${GUIDE_DOC}「${CONFIG_SECTION}」）；${RESUME}，会重新验收`;
    case "数据不干净":
      return acceptance.reset
        ? `配置的 acceptance.reset 没能把数据恢复到初始状态（见总结里验收方给的原因）：检查 ${configFile(acceptance)} 里的重置命令，${RESUME}`
        : `验收需要干净的初始数据，但 ${configFile(acceptance)} 没有配置 acceptance.reset：按 ${GUIDE_DOC}「${CONFIG_SECTION}」加上重置命令（只重置数据、不重启服务），${RESUME}`;
    case "没配启动":
      return `在 ${configFile(acceptance)} 配置 acceptance.start 和就绪地址/端口（见 ${GUIDE_DOC}「${CONFIG_SECTION}」），${RESUME}。需要探测配置可执行：${shellQuote(LOOP_BIN)} 接入 ${shellQuote(acceptance.root)}（已有 acceptance 保留，需按说明补全）`;
    case "缺工具":
      return browserHint(workDir, RESUME);
    case "验收方模型断线":
      return `验收方模型断线或挂住，不是被测系统超时或崩溃；已有证据和补报告结果已保留在 ${record.runDir}。恢复模型连接后${RESUME}，会重新验收`;
    case "验收方":
      return `验收方没按要求留证据或输出格式不对${record.escalated ? "（已换强模型重验，仍然不行）" : ""}，原因见总结；${RESUME}，会重新验收`;
    default:
      return `全部标准都没能验证，多半是环境问题（数据库、测试账号等）或标准写得含糊：修好环境，或给开发方发一条带「## 验收标准」的新消息；${RESUME}`;
  }
}

/** 部分验证时的提醒：哪些条目要你人工验收。 */
export function manualHint(record: AcceptanceRecord | undefined): string | undefined {
  if (record?.verdict !== "部分验证") return undefined;
  return `${handOverParts(record.items).join("，")}，需要你人工验收（原因见总结「需要你做的事」）`;
}

export interface TodoInput {
  acceptance?: AcceptanceConfig;
  host: string;
  phase: string;
  pauseHint?: string;
  criteria?: Criteria;
  lastAcceptance?: AcceptanceRecord;
}

/** 总结开头「需要你做的事」：暂停的下一步、人工验收、自动起草的标准。 */
export function acceptanceTodos(input: TodoInput): string[] {
  const todos: string[] = [];
  if (input.phase === "paused" && input.pauseHint) todos.push(input.pauseHint);
  if (!input.acceptance) return todos;
  const record = input.lastAcceptance;
  if (record?.verdict === "部分验证") {
    for (const item of record.items.filter((entry) => entry.verdict === "无法验证" || entry.verdict === "需人工")) {
      const why = item.verdict === "无法验证" ? `程序没能自动验证，${item.detail}`
        : isManualCriterion(item.text) ? "标了 [人工]，程序不自动验" : "你没授权，程序不执行";
      todos.push(`人工验收 ${item.id}（${item.text.split("\n")[0]}）：${why}`);
    }
  }
  if (input.criteria?.source === "自动起草") {
    todos.push("验收标准是自动起草的（见下面「验收标准」一节）：不满意就给开发方发一条带「## 验收标准」的消息替换");
  }
  return todos;
}
