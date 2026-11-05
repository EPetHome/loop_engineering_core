/**
 * pipeline-core.ts — 流水线的共用约定：pi 扩展（每一段的会话）和 pipeline.ts（编排）都用。
 *
 * 每一段会话由流水线启动时带两个环境变量：AUTOREVIEW_PIPELINE_DIR（流水线目录）、AUTOREVIEW_STAGE（段名）。
 * 扩展把这一段的状态写到 <目录>/<段>.status.json；编排程序把整批验收返修写到 <目录>/<段>.inbox.json，
 * 扩展读到后发给开发方。没有这两个环境变量的会话完全不受影响。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { AcceptanceRecord } from "./acceptance-core.ts";
import type { Snapshot } from "./git.ts";
import { captureProjectConfigOverrides, type ProjectConfigOverrides } from "./config.ts";

export interface QueueAcceptanceItem { id: string; text: string; detail: string }
/** 明确的空数组表示未配置验收或全部通过；缺字段的历史 done 不授予自动合入资格。 */
export interface QueueAcceptance { failed: QueueAcceptanceItem[]; partial: QueueAcceptanceItem[]; manual: QueueAcceptanceItem[] }
export function queueAcceptance(record?: AcceptanceRecord): QueueAcceptance {
  const result: QueueAcceptance = { failed: [], partial: [], manual: [] };
  for (const item of record?.items ?? []) {
    const target = item.verdict === "不通过" ? result.failed : item.verdict === "无法验证" ? result.partial : item.verdict === "需人工" ? result.manual : undefined;
    target?.push({ id: item.id, text: item.text, detail: item.detail });
  }
  if (record?.verdict === "不通过" && !result.failed.length) result.failed.push({ id: "验收", text: "验收不通过", detail: record.reason ?? "" });
  if (record?.verdict === "无法验收" || (record?.verdict === "部分验证" && !result.partial.length && !result.manual.length)) result.partial.push({ id: "验收", text: record.verdict, detail: record.reason ?? "" });
  return result;
}

/** 提交说明引用真实检查结论；历史未知不能写成未配置或通过。 */
export function completionChecks(round?: { gate?: { result: string }; conclusion?: string; reviewConclusion?: string; acceptance?: AcceptanceRecord }, qualified?: QueueAcceptance | null): NonNullable<StageStatus["checks"]> {
  let acceptance: string = round?.acceptance?.verdict ?? "未配置";
  if (qualified === null) acceptance = "历史结论未知，未补做验收";
  else if (qualified) {
    acceptance = "沿用原完成资格（无欠项）";
    if (qualified.failed.length) acceptance = "不通过";
    else if (qualified.partial.length || qualified.manual.length) acceptance = "部分验证（见总表欠项）";
  }
  return { gate: qualified !== undefined ? "沿用原完成资格（见总结）" : round?.gate?.result ?? "未配置",
    review: round?.reviewConclusion ?? round?.conclusion ?? "见段总结", acceptance };
}

export const PIPELINE_DIR_ENV = "AUTOREVIEW_PIPELINE_DIR";
export const STAGE_ENV = "AUTOREVIEW_STAGE";
/** 只有 pipeline.ts 真正启动段时才设置：段会话据此采用准备前确定的开工依据。 */
export const PIPELINE_LAUNCH_ENV = "AUTOREVIEW_PIPELINE_LAUNCH";
/** 一次性启动回报身份：只有真正启动段的 bin/pi-dev 持有，成功后不再传给子进程。 */
export const PIPELINE_LAUNCH_TOKEN_ENV = "AUTOREVIEW_PIPELINE_LAUNCH_TOKEN";
/** 仅测试：扩展轮询收件箱、编排程序轮询状态的间隔（毫秒）。 */
export const POLL_ENV = "AUTOREVIEW_PIPELINE_POLL_MS";

/** 段的事件：开会话、评审完成、暂停、收到返修后没改代码、启动入口失败。 */
export type StageEvent = "started" | "done" | "paused" | "no-change" | "startup-failed";

export interface StageStatus {
  batchFile?: string;
  runId?: string;
  stage: string;
  sessionId: string;
  /** 原开发宿主及进程身份；队列只恢复同一会话，不能按 PID 猜归属。 */
  host?: string;
  pid?: number;
  processStarted?: string;
  /** 本启动器持有的原宿主 PTY 输入通道身份；只用于自动返修投递，不属于完成资格。 */
  inputBridge?: string;
  summary: string;
  event: StageEvent;
  /** 本次完成资格的身份；恢复重发保持，任何重验或输入失效后重新生成。 */
  readyEpoch?: string;
  /** 当前完成资格的验收结论；人工与无法验证分开，不把人工项当作部分验证阻断。 */
  acceptance?: QueueAcceptance;
  /** 检查通过时冻结的候选（含未跟踪文件），提交前必须核对。 */
  candidate?: Snapshot | string;
  checks?: { gate: string; review: string; acceptance: string };
  /** 此资格所依据的冻结来源版本；消费者在接力边界核对实际文件。 */
  sourceInputs?: string;
  /** 此段实际使用的显式评审覆盖；消费者复核来源时不能改用自身进程的默认预算。 */
  configOverrides?: ProjectConfigOverrides;
  /** 每写一次加 1；编排程序据此认出「派发之后的新事件」。 */
  seq: number;
  /** 已经收下的最后一条收件箱序号。 */
  inbox: number;
  pauseReason?: string;
  /** no-change 时开发方的回复原文（为什么不改）。 */
  reply?: string;
  updatedAt: string;
}

export interface InboxMessage {
  seq: number;
  /** 发给开发方的返修消息。 */
  message: string;
  /** 交给评审当作「上一轮必修」复查的条目原文。 */
  mustFix: string;
}

export interface StageLink { dir: string; stage: string }

/** 会话由流水线启动时返回它属于哪个目录、哪一段；否则 undefined。 */
export function stageFromEnv(env: NodeJS.ProcessEnv = process.env): StageLink | undefined {
  const dir = env[PIPELINE_DIR_ENV]?.trim();
  const stage = env[STAGE_ENV]?.trim();
  return dir && stage ? { dir, stage } : undefined;
}

export function pollMs(env: NodeJS.ProcessEnv = process.env, fallback = 2000): number {
  const value = Number(env[POLL_ENV]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** 段名做文件名：去掉路径分隔符等不能进文件名的字符。 */
const fileSafe = (stage: string): string => stage.replace(/[/\\:*?"<>|\s]+/g, "_");
export const statusPath = (dir: string, stage: string): string => join(dir, `${fileSafe(stage)}.status.json`);
export const inboxPath = (dir: string, stage: string): string => join(dir, `${fileSafe(stage)}.inbox.json`);

export function readJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return undefined; }
}

/** 先写临时文件再改名：另一方读到的要么是旧的，要么是完整的新文件。 */
export function writeJsonAtomic(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(temp, path);
}

/** 写一次段状态：序号接着上一次的往上加。 */
export function writeStageStatus(link: StageLink, status: Omit<StageStatus, "stage" | "seq" | "updatedAt">): StageStatus {
  const path = statusPath(link.dir, link.stage);
  const previous = readJson<StageStatus>(path);
  const batchFile = status.batchFile ?? process.env.AUTOREVIEW_BATCH_FILE;
  const next: StageStatus = { ...status, configOverrides: captureProjectConfigOverrides(status.configOverrides), ...(batchFile ? { batchFile: resolve(batchFile) } : {}), runId: status.runId ?? process.env.AUTOREVIEW_LAUNCH_ID, stage: link.stage, seq: (previous?.seq ?? 0) + 1, updatedAt: new Date().toISOString() };
  writeJsonAtomic(path, next);
  return next;
}
