/**
 * config.ts — .autoreview.json 的查找与字段校验，宿主 Hook 和 pi 扩展共用。
 *
 * 评审字段由宿主 Hook 读（pi 扩展用 flag）；acceptance 一节两边都从这里读，
 * 只有写了 acceptance 的项目才做自动验收。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 本仓库根目录：提示词、验收工具、测试命令的相对路径都按它解析。 */
export const EXT_DIR = dirname(fileURLToPath(import.meta.url));
// 本机路径（评审、验收方、起草都用同一个 pi 和权限扩展）。
export const PI_BIN = "/Users/Admin/.local/bin/pi";
export const PERMISSION_EXT = "/Users/Admin/.pi/agent/npm/node_modules/@gotgenes/pi-permission-system/src/index.ts";
export const HERMES_BIN = "/Users/Admin/.hermes/node/bin";

/** 测试命令：含「/」的相对路径按本仓库根目录解析。 */
export function resolveTestCmd(raw: string): string {
  return raw.includes("/") && !isAbsolute(raw) ? resolve(EXT_DIR, raw) : raw;
}

export const MARKER_FILE = ".autoreview.json";
export const DEFAULT_ACCEPTANCE_MODEL = "opencode-go/deepseek-v4.1-flash";
export const DEFAULT_ACCEPTANCE_TIMEOUT_MIN = 20;
export const DEFAULT_READY_TIMEOUT_SEC = 60;
export const DEFAULT_ERROR_PATTERNS = ["ERROR", "FATAL", "Traceback", "Unhandled", "panic:"];

export interface AcceptanceConfig {
  /** 被测系统启动命令（sh -c，在开发目录执行）；不写表示没有常驻服务，验收方直接调用命令。 */
  start?: string;
  /** 就绪检查：GET 返回状态码小于 500 即就绪。 */
  readyUrl?: string;
  /** 就绪检查：系统输出里出现这句即就绪。 */
  readyLog?: string;
  readyTimeoutSec: number;
  /** 额外收集的日志文件（绝对路径，按 .autoreview.json 所在目录解析）。 */
  logs: string[];
  errorPatterns: string[];
  ignorePatterns: string[];
  /** 项目操作说明文件（绝对路径），原文交给验收方。 */
  guide?: string;
  model: string;
  thinking?: string;
  /** 起草验收标准的模型；不写就用评审模型。 */
  criteriaModel?: string;
  /** 一轮里验收最多用多少分钟，从一轮总预算（reviewTimeoutMin）里扣。 */
  timeoutMin: number;
  /** 给被测系统的额外环境变量。 */
  env: Record<string, string>;
  /** 仅测试：外部验收方命令（AUTOREVIEW_ACCEPTANCE_CMD）。 */
  testerCmd: string;
  /** 仅测试：外部起草命令（AUTOREVIEW_CRITERIA_CMD）。 */
  drafterCmd: string;
}

/** 从 cwd 向上找 .autoreview.json 所在目录；找不到返回 undefined。 */
export function findProjectRoot(cwd: string | undefined): string | undefined {
  let dir: string;
  try {
    dir = resolve(cwd?.trim() || process.cwd());
  } catch {
    return undefined;
  }
  for (;;) {
    if (existsSync(join(dir, MARKER_FILE))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** 读 .autoreview.json（可以是 {}）；不是 JSON 对象时抛错。 */
export function readMarker(root: string): Record<string, unknown> {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(root, MARKER_FILE), "utf8"));
  } catch (error) {
    throw new Error(`无法解析 ${MARKER_FILE}：${errorText(error)}`);
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${MARKER_FILE} 必须是 JSON 对象`);
  return raw as Record<string, unknown>;
}

export function nonNegativeInt(data: Record<string, unknown>, key: string, fallback: number, label = key): number {
  const value = data[key];
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${MARKER_FILE} 的 ${label} 必须是非负整数`);
  }
  return value;
}

function positiveInt(data: Record<string, unknown>, key: string, fallback: number): number {
  const value = nonNegativeInt(data, key, fallback, `acceptance.${key}`);
  if (value === 0) throw new Error(`${MARKER_FILE} 的 acceptance.${key} 必须大于 0`);
  return value;
}

export function nonEmptyString(data: Record<string, unknown>, key: string, fallback: string, label = key): string {
  const value = data[key];
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !value.trim()) throw new Error(`${MARKER_FILE} 的 ${label} 必须是非空字符串`);
  return value.trim();
}

function optionalString(data: Record<string, unknown>, key: string): string | undefined {
  return data[key] === undefined ? undefined : nonEmptyString(data, key, "", `acceptance.${key}`);
}

function stringList(data: Record<string, unknown>, key: string, fallback: string[]): string[] {
  const value = data[key];
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`${MARKER_FILE} 的 acceptance.${key} 必须是非空字符串数组`);
  }
  return value.map((item: string) => item.trim());
}

/** 解析 acceptance 一节；没写返回 undefined（不做验收）。字段非法时抛错。 */
export function parseAcceptanceConfig(
  raw: unknown, root: string, env: NodeJS.ProcessEnv = process.env,
): AcceptanceConfig | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${MARKER_FILE} 的 acceptance 必须是 JSON 对象`);
  const data = raw as Record<string, unknown>;
  const readyUrl = optionalString(data, "readyUrl");
  if (readyUrl !== undefined) {
    let url: URL;
    try { url = new URL(readyUrl); } catch { throw new Error(`${MARKER_FILE} 的 acceptance.readyUrl 不是合法网址`); }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`${MARKER_FILE} 的 acceptance.readyUrl 只支持 http/https`);
  }
  const envValue = data.env;
  if (envValue !== undefined && (envValue === null || typeof envValue !== "object" || Array.isArray(envValue)
    || Object.values(envValue).some((item) => typeof item !== "string"))) {
    throw new Error(`${MARKER_FILE} 的 acceptance.env 必须是字符串键值对象`);
  }
  const guide = optionalString(data, "guide");
  return {
    start: optionalString(data, "start"),
    readyUrl,
    readyLog: optionalString(data, "readyLog"),
    readyTimeoutSec: positiveInt(data, "readyTimeoutSec", DEFAULT_READY_TIMEOUT_SEC),
    logs: stringList(data, "logs", []).map((path) => resolve(root, path)),
    errorPatterns: stringList(data, "errorPatterns", DEFAULT_ERROR_PATTERNS),
    ignorePatterns: stringList(data, "ignorePatterns", []),
    guide: guide === undefined ? undefined : resolve(root, guide),
    model: nonEmptyString(data, "model", DEFAULT_ACCEPTANCE_MODEL, "acceptance.model"),
    thinking: optionalString(data, "thinking"),
    criteriaModel: optionalString(data, "criteriaModel"),
    timeoutMin: positiveInt(data, "timeoutMin", DEFAULT_ACCEPTANCE_TIMEOUT_MIN),
    env: { ...(envValue as Record<string, string> | undefined) },
    testerCmd: env.AUTOREVIEW_ACCEPTANCE_CMD?.trim() ?? "",
    drafterCmd: env.AUTOREVIEW_CRITERIA_CMD?.trim() ?? "",
  };
}

/** 验收从一轮总预算里扣，必须给评审留时间。 */
export function checkAcceptanceBudget(reviewTimeoutMin: number, acceptance: AcceptanceConfig | undefined): void {
  if (acceptance && acceptance.timeoutMin >= reviewTimeoutMin) {
    throw new Error(`${MARKER_FILE} 的 acceptance.timeoutMin（${acceptance.timeoutMin}）必须小于一轮总预算 reviewTimeoutMin（${reviewTimeoutMin}）`);
  }
}

/** pi 扩展用：从 cwd 向上找 .autoreview.json，只取 acceptance 一节。 */
export function loadAcceptanceConfig(cwd: string, env: NodeJS.ProcessEnv = process.env): AcceptanceConfig | undefined {
  const root = findProjectRoot(cwd);
  return root ? parseAcceptanceConfig(readMarker(root).acceptance, root, env) : undefined;
}
