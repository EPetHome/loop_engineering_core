/**
 * config.ts — 项目配置的唯一读取、字段解析与预算校验入口。
 * 显式 flag / 环境变量 → .autoreview.json → 默认值；各宿主共用。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PreparationConfig } from "./preparation.ts";
import type { ContextConfig } from "./project-context.ts";
import type { ReviewConfig } from "./review.ts";

export const DEFAULT_MODEL = "openai-codex/gpt-6-astra";
export const DEFAULT_THINKING = "xhigh";
/** 单会话静态评审自身的返修上限；新卡各节点另有独立 limits。 */
export const DEFAULT_MAX_REPAIRS = 4;
export const DEFAULT_TIMEOUT_MIN = 60;

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

/** PA 属于用户，不进入项目配置；每次读取以便通知开关即时生效。 */
export interface PAConfig { eventsDir?: string; localNotify: boolean }
export function readPAConfig(env: NodeJS.ProcessEnv = process.env): PAConfig {
  const file = env.LOOP_PA_CONFIG || join(homedir(), ".pi-autoreview", "config.json");
  let raw;
  try { raw = JSON.parse(readFileSync(file, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { localNotify: true }; throw error; }
  const pa = raw?.pa;
  if (pa === undefined) return { localNotify: true };
  if (!pa || typeof pa !== "object" || Array.isArray(pa)) throw new Error(`${file} 的 pa 必须是对象`);
  if (pa.eventsDir !== undefined && (typeof pa.eventsDir !== "string" || !isAbsolute(pa.eventsDir))) throw new Error(`${file} 的 pa.eventsDir 必须是绝对路径`);
  if (pa.localNotify !== undefined && typeof pa.localNotify !== "boolean") throw new Error(`${file} 的 pa.localNotify 必须是布尔值`);
  return { ...(pa.eventsDir ? { eventsDir: pa.eventsDir } : {}), localNotify: pa.localNotify ?? true };
}

export const MARKER_FILE = ".autoreview.json";
export const configurationHash = (data: unknown): string => createHash("sha256").update(JSON.stringify(data)).digest("hex");
export const DEFAULT_ACCEPTANCE_MODEL = "opencode-go/deepseek-v4.1-flash";
export const DEFAULT_ACCEPTANCE_TIMEOUT_MIN = 20;
export const DEFAULT_ACCEPTANCE_IDLE_TIMEOUT_SEC = 300;
export const DEFAULT_READY_TIMEOUT_SEC = 60;
export const DEFAULT_RESET_TIMEOUT_SEC = 120;
export const DEFAULT_ERROR_PATTERNS = ["ERROR", "FATAL", "Traceback", "Unhandled", "panic:"];
export const LOOP_TEST_STATUS = "Loop 未运行测试";
export const ACCEPT_COMMAND_MIGRATION = "旧独立验收命令已停用：请使用 version:1 开发卡，在 flow 加入「测试」并填写 tasks[].test；单会话只做开发评审，不执行旧命令。";

export interface AcceptanceConfig {
  /** .autoreview.json 所在目录：相对路径按它解析，提示里的目标文件也按它算。 */
  root: string;
  /** 被测系统启动命令（sh -c，在开发目录执行）；不写表示没有常驻服务，验收方直接调用命令。 */
  start?: string;
  /** 就绪检查：GET 返回状态码小于 500 即就绪。 */
  readyUrl?: string;
  /** 就绪检查：系统输出里出现这句即就绪。 */
  readyLog?: string;
  readyTimeoutSec: number;
  /** 重置数据的命令（sh -c，在开发目录执行，环境同被测系统）：每次调验收方前由程序执行，只重置数据、不重启服务。 */
  reset?: string;
  /** 测试库、容器等项目资源的幂等释放脚本，只处理本轮运行身份。 */
  cleanup?: string;
  resetTimeoutSec: number;
  /** 额外收集的日志文件（绝对路径，按 .autoreview.json 所在目录解析）。 */
  logs: string[];
  errorPatterns: string[];
  ignorePatterns: string[];
  /** 项目操作说明文件（绝对路径），原文交给验收方。 */
  guide?: string;
  /** 项目维护的可复用黑盒操作脚本目录；每轮复制到运行目录。 */
  actions?: string;
  model: string;
  thinking?: string;
  /** 强模型：起草标准、重验、断线后只读补报告都用它；不写就用评审模型。 */
  strongModel?: string;
  /** 无输出、会话或证据变化且没有实测工具正在执行时，结束本次验收方调用。 */
  idleTimeoutSec: number;
  /** 验收执行器的独立时限，不从静态评审预算扣除。 */
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
  const actions = optionalString(data, "actions");
  if (actions && (isAbsolute(actions) || !relative(root, resolve(root, actions)) || relative(root, resolve(root, actions)).startsWith("..")
    || /(^|[/\\])(?:\.git|\.ssh|\.aws|node_modules)(?:[/\\]|$)/.test(actions))) throw new Error("acceptance.actions 必须是项目内的专用动作目录");
  return {
    root,
    start: optionalString(data, "start"),
    readyUrl,
    readyLog: optionalString(data, "readyLog"),
    readyTimeoutSec: positiveInt(data, "readyTimeoutSec", DEFAULT_READY_TIMEOUT_SEC),
    reset: optionalString(data, "reset"),
    ...(optionalString(data, "cleanup") ? { cleanup: optionalString(data, "cleanup") } : {}),
    resetTimeoutSec: positiveInt(data, "resetTimeoutSec", DEFAULT_RESET_TIMEOUT_SEC),
    logs: stringList(data, "logs", []).map((path) => resolve(root, path)),
    errorPatterns: stringList(data, "errorPatterns", DEFAULT_ERROR_PATTERNS),
    ignorePatterns: stringList(data, "ignorePatterns", []),
    guide: guide === undefined ? undefined : resolve(root, guide),
    ...(actions ? { actions: resolve(root, actions) } : {}),
    model: nonEmptyString(data, "model", DEFAULT_ACCEPTANCE_MODEL, "acceptance.model"),
    thinking: optionalString(data, "thinking"),
    strongModel: optionalString(data, "strongModel"),
    timeoutMin: positiveInt(data, "timeoutMin", DEFAULT_ACCEPTANCE_TIMEOUT_MIN),
    idleTimeoutSec: positiveInt(data, "idleTimeoutSec", DEFAULT_ACCEPTANCE_IDLE_TIMEOUT_SEC),
    env: { ...(envValue as Record<string, string> | undefined) },
    testerCmd: env.AUTOREVIEW_ACCEPTANCE_CMD?.trim() ?? "",
    drafterCmd: env.AUTOREVIEW_CRITERIA_CMD?.trim() ?? "",
  };
}

/** 项目方法：路径相对于 .autoreview.json 所在目录；selfCheck/probe 用 sh -c 执行。 */
export interface MethodsConfig { paths: string[]; selfCheck?: string; probe?: string }

/** 解析 methods 一节；没写返回 undefined。字段非法时抛错。 */
export function parseMethodsConfig(raw: unknown, root: string): MethodsConfig | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${MARKER_FILE} 的 methods 必须是 JSON 对象`);
  const data = raw as Record<string, unknown>;
  if (!Array.isArray(data.paths) || data.paths.length === 0) throw new Error(`${MARKER_FILE} 的 methods.paths 必须是非空字符串数组`);
  const paths = data.paths.map((item: unknown, index: number) => {
    if (typeof item !== "string" || !item.trim()) throw new Error(`${MARKER_FILE} 的 methods.paths[${index}] 必须是非空路径`);
    const path = item.trim();
    const resolved = resolve(root, path);
    const rel = relative(root, resolved);
    if (isAbsolute(path) || !rel || rel.startsWith("..") || rel === "") throw new Error(`${MARKER_FILE} 的 methods.paths[${index}] 必须是项目内的路径`);
    return rel.replace(/\\/g, "/");
  });
  const command = (key: "selfCheck" | "probe"): string | undefined => {
    const value = data[key];
    if (value === undefined) return undefined;
    if (typeof value !== "string" || !value.trim()) throw new Error(`${MARKER_FILE} 的 methods.${key} 必须是非空字符串`);
    return value.trim();
  };
  const selfCheck = command("selfCheck"), probe = command("probe");
  return { paths, ...(selfCheck ? { selfCheck } : {}), ...(probe ? { probe } : {}) };
}

/** 兼容旧配置：已停用的字段只提醒，不再授予发布或推送权限。 */
export interface MergeConfig { auto: boolean; push: boolean }
export function parseMergeConfig(raw: unknown): MergeConfig {
  if (raw === undefined) return { auto: false, push: false };
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${MARKER_FILE} 的 merge 必须是 JSON 对象`);
  const data = raw as Record<string, unknown>;
  // 旧字段只读忽略；权限由新卡和统一合入入口决定，解析/查询不刷屏。
  return { auto: false, push: false };
}
export interface DeploymentConfig { enabled: boolean; cmd?: string; check?: string; timeoutMin: number }
export function parseDeploymentConfig(raw: unknown): DeploymentConfig {
  if (raw === undefined) return { enabled: false, timeoutMin: 10 };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${MARKER_FILE} 的 deployment 必须是 JSON 对象`);
  const data = raw as Record<string, unknown>;
  if (data.enabled !== undefined && typeof data.enabled !== "boolean") throw new Error(`${MARKER_FILE} 的 deployment.enabled 必须是布尔值`);
  const enabled = data.enabled === true, commands: { cmd?: string; check?: string } = {};
  for (const key of ["cmd", "check"] as const) {
    if (enabled || data[key] !== undefined) commands[key] = nonEmptyString(data, key, "", `deployment.${key}`);
    if (enabled && !commands[key]) throw new Error(`${MARKER_FILE} 的 deployment.${key} 必须写`);
  }
  const timeoutMin = nonNegativeInt(data, "timeoutMin", 10, "deployment.timeoutMin");
  if (!timeoutMin) throw new Error(`${MARKER_FILE} 的 deployment.timeoutMin 必须大于 0`);
  return { enabled, ...commands, timeoutMin };
}
/** 发布分支、开发工作区、本机文件和项目方法的位置；没写的用默认值。 */
export interface ProjectLayout {
  release: string;
  localFiles: string[];
  methods?: MethodsConfig;
}

export function parseProjectLayout(raw: Record<string, unknown>, root: string): ProjectLayout {
  parseMergeConfig(raw.merge);
  parseDeploymentConfig(raw.deployment);
  const release = raw.release === undefined ? "main" : nonEmptyString(raw, "release", "main");
  const localFiles: string[] = [];
  if (raw.localFiles !== undefined) {
    if (!Array.isArray(raw.localFiles) || raw.localFiles.some((item) => typeof item !== "string" || !item.trim())) {
      throw new Error(`${MARKER_FILE} 的 localFiles 必须是非空字符串数组`);
    }
    for (const item of raw.localFiles as string[]) {
      const path = item.trim();
      const rel = relative(root, resolve(root, path));
      if (isAbsolute(path) || !rel || rel.startsWith("..")) throw new Error(`${MARKER_FILE} 的 localFiles 必须是项目内的相对路径：${path}`);
      localFiles.push(path);
    }
  }
  const methods = parseMethodsConfig(raw.methods, root);
  return { release, localFiles, ...(methods ? { methods } : {}) };
}

/** 从 cwd 向上找 .autoreview.json 并解析布局；没有标记文件时用默认布局。 */
export function loadProjectLayout(cwd: string): { root: string; layout: ProjectLayout } {
  const root = findProjectRoot(cwd) ?? resolve(cwd);
  let raw: Record<string, unknown> = {};
  if (existsSync(join(root, MARKER_FILE))) raw = readMarker(root);
  return { root, layout: parseProjectLayout(raw, root) };
}

/** 旧 gate 不解析类型或命令，也不再参与任何执行与预算。 */
export function warnDisabledGate(raw: Record<string, unknown>): void {
  if (Object.hasOwn(raw, "gate")) console.error("旧 gate 配置已停用；新卡仍按 flow 执行显式测试");
}

const object = (raw: unknown, label: string): Record<string, unknown> => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${label} 必须是对象`);
  return raw as Record<string, unknown>;
};
const string = (raw: unknown, label: string): string => {
  if (typeof raw !== "string" || !raw.trim()) throw new Error(`${label} 必须是非空字符串`);
  return raw.trim();
};
const number = (raw: unknown, fallback: number, label: string, min = 0): number => {
  const value = raw ?? fallback;
  if (!Number.isSafeInteger(value) || (value as number) < min) throw new Error(`${label} 必须是大于等于 ${min} 的整数`);
  return value as number;
};

export function parsePreparation(raw: unknown, root: string): PreparationConfig | undefined {
  if (raw === undefined) return undefined;
  const data = object(raw, "preparation");
  let repair: PreparationConfig["repair"];
  if (data.repair !== undefined) {
    const r = object(data.repair, "preparation.repair");
    if (!Array.isArray(r.paths) || !r.paths.length) throw new Error("preparation.repair.paths 必须列出允许修改的项目文件或目录");
    const paths = r.paths.map((value) => {
      const path = string(value, "preparation.repair.paths");
      const rel = relative(resolve(root), resolve(root, path));
      if (isAbsolute(path) || !rel || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
        || /(^|[/\\])(AGENTS\.md|CLAUDE\.md|\.git|\.autoreview\.json)([/\\]|$)/.test(path)) {
        throw new Error(`preparation.repair.paths 不能越出项目、指向整个项目或稳定规则：${path}`);
      }
      return rel;
    });
    repair = { model: string(r.model, "preparation.repair.model"), thinking: string(r.thinking ?? "high", "preparation.repair.thinking"), paths,
      ...(r.ponytail !== undefined ? { ponytail: resolve(root, string(r.ponytail, "preparation.repair.ponytail")) } : {}) };
  }
  return {
    root: resolve(root), check: string(data.check, "preparation.check"),
    recover: data.recover === undefined ? undefined : string(data.recover, "preparation.recover"),
    timeoutMin: number(data.timeoutMin, 10, "preparation.timeoutMin", 1),
    maxRecoveries: number(data.maxRecoveries, 1, "preparation.maxRecoveries"),
    maxRepairs: number(data.maxRepairs, 1, "preparation.maxRepairs"), repair,
  };
}

const contextRoles = new Set(["rules", "requirement", "design", "guide", "code"]);
export const CONTEXT_IGNORED = /(^|[/\\])(?:\.git|node_modules|target|dist|\.venv|\.aws|\.ssh|\.pi-autoreview|logs?|temp)(?:[/\\]|$)|(^|[/\\])(?:\.env(?:\..*)?|auth\.json|credentials(?:\..*)?)$/;

export function parseContext(raw: unknown, configRoot: string): ContextConfig | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("context 必须是对象");
  const data = raw as Record<string, unknown>;
  if (data.root !== undefined && (typeof data.root !== "string" || !data.root.trim())) throw new Error("context.root 必须是非空路径");
  const root = resolve(configRoot, (data.root as string) ?? ".");
  if (!Array.isArray(data.sources) || !data.sources.length) throw new Error("context.sources 必须明确列出来源");
  const sources: ContextConfig["sources"] = data.sources.map((raw, index) => {
    const source = typeof raw === "string" ? { path: raw, role: "guide" } : raw;
    if (!source || typeof source !== "object" || typeof source.path !== "string" || !source.path.trim()) throw new Error(`context.sources[${index}] 缺少 path`);
    const path = relative(root, resolve(root, source.path));
    if (!path || isAbsolute(source.path) || path.startsWith("..") || CONTEXT_IGNORED.test(path)) throw new Error(`context 来源越界或属于排除区域：${source.path}`);
    const role = source.role ?? "guide";
    if (!contextRoles.has(role)) throw new Error(`context.sources[${index}].role 无效`);
    const id = source.id ?? path;
    if (typeof id !== "string" || !id.trim()) throw new Error("context 来源 id 必须是非空字符串");
    const dependsOn = source.dependsOn ?? [];
    if (!Array.isArray(dependsOn) || dependsOn.some((v) => typeof v !== "string")) throw new Error("context.dependsOn 必须是来源 id 数组");
    if (source.optional !== undefined && typeof source.optional !== "boolean") throw new Error("context.optional 必须是布尔值");
    return { id, path, role: role as ContextConfig["sources"][number]["role"], dependsOn, optional: source.optional === true };
  });
  const ids = new Set(sources.map((s) => s.id));
  if (ids.size !== sources.length || sources.some((s) => s.dependsOn.some((id) => !ids.has(id)))) throw new Error("context 来源 id 重复或依赖不存在");
  const maxChars = data.maxChars ?? 12000, intervalSec = data.intervalSec ?? 0;
  if (!Number.isSafeInteger(maxChars) || (maxChars as number) < 1000 || (maxChars as number) > 100000) throw new Error("context.maxChars 必须在 1000—100000 之间");
  if (!Number.isSafeInteger(intervalSec) || (intervalSec as number) < 0 || ((intervalSec as number) > 0 && (intervalSec as number) < 30)) throw new Error("context.intervalSec 必须为 0 或不小于 30 的整数");
  return { root, sources, maxChars: maxChars as number, intervalSec: intervalSec as number };
}

export type ConfigSource = "flag" | "env" | "file" | "default";
export interface ProjectConfigOverrides {
  maxRepairs?: string | number;
  reviewerModel?: string;
  reviewerThinking?: string;
  reviewTimeoutMin?: string | number;
  reviewerCmd?: string;
  env?: NodeJS.ProcessEnv;
  /** 段级验收覆盖；显式身份优先于进程环境，避免编排器误读其他段。 */
  batchFile?: string;
  stage?: string;
  /** 接入工具校验尚未落盘的候选配置；不写入文件。 */
  marker?: Record<string, unknown>;
}
const PROJECT_CONFIG_FLAGS = {
  "--autoreview-max-repairs": "maxRepairs",
  "--autoreview-reviewer-model": "reviewerModel",
  "--autoreview-reviewer-thinking": "reviewerThinking",
  "--autoreview-review-timeout-min": "reviewTimeoutMin",
  "--autoreview-reviewer-cmd": "reviewerCmd",
} as const;

/** 只提取 Loop 评审参数；其他 Pi 参数原样留给宿主，字段校验仍由 resolveProjectConfig 负责。 */
export function projectConfigOverridesFromArgs(args: string[]): ProjectConfigOverrides {
  const overrides: ProjectConfigOverrides = {};
  for (let index = 0; index < args.length; index += 1) {
    const [flag, ...inline] = args[index].split("=");
    if (!Object.hasOwn(PROJECT_CONFIG_FLAGS, flag)) continue;
    const value = inline.length ? inline.join("=") : args[++index];
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} 需要一个值`);
    overrides[PROJECT_CONFIG_FLAGS[flag as keyof typeof PROJECT_CONFIG_FLAGS]] = value;
  }
  return overrides;
}

/** 恢复原会话时只重放原始 flag；空值清除启动模板里的旧 flag，不把环境/文件值升级为 flag。 */
export function projectConfigArgs(overrides: ProjectConfigOverrides): string[] {
  return Object.entries(PROJECT_CONFIG_FLAGS).flatMap(([flag, key]) => [flag, String(overrides[key] ?? "")]);
}

/** 只携带影响项目配置的环境，不把 HOME、凭证等整个进程环境写入段状态。 */
export const PROJECT_CONFIG_ENV = ["AUTOREVIEW_REVIEW_TIMEOUT_MIN", "AUTOREVIEW_REVIEWER_CMD"] as const;
export function captureProjectConfigOverrides(overrides: ProjectConfigOverrides = {}, env: NodeJS.ProcessEnv = process.env): ProjectConfigOverrides {
  const source = overrides.env ?? env;
  return {
    maxRepairs: overrides.maxRepairs, reviewerModel: overrides.reviewerModel, reviewerThinking: overrides.reviewerThinking,
    reviewTimeoutMin: overrides.reviewTimeoutMin, reviewerCmd: overrides.reviewerCmd,
    batchFile: overrides.batchFile ?? source.AUTOREVIEW_BATCH_FILE, stage: overrides.stage ?? source.AUTOREVIEW_STAGE,
    env: Object.fromEntries(PROJECT_CONFIG_ENV.filter((key) => source[key] !== undefined).map((key) => [key, source[key]])),
  };
}

export interface ResolvedProjectConfig extends ReviewConfig {
  methods?: MethodsConfig;
  context?: ContextConfig;
  raw: Record<string, unknown>;
  effectiveConfig: { reviewTimeoutMin: { value: number; source: ConfigSource } };
}

/** root 是标记文件所在目录；undefined 表示尚未接入，使用默认配置。每次读取，不缓存旧值。 */
export function resolveProjectConfig(root: string | undefined, overrides: ProjectConfigOverrides = {}): ResolvedProjectConfig {
  const data = overrides.marker ?? (root ? readMarker(root) : {});
  const env = overrides.env ?? process.env;
  const explicit = (value: string | number | undefined): value is string | number => value !== undefined && value !== "";
  const intFlag = (value: string | number, flag: string): number => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`--${flag} 必须是非负整数`);
    return parsed;
  };
  const envTimeout = Number.parseInt(env.AUTOREVIEW_REVIEW_TIMEOUT_MIN ?? "", 10);
  let source: ConfigSource, reviewTimeoutMin: number;
  if (explicit(overrides.reviewTimeoutMin)) {
    source = "flag"; reviewTimeoutMin = intFlag(overrides.reviewTimeoutMin, "autoreview-review-timeout-min");
  } else if (Number.isFinite(envTimeout) && envTimeout > 0) {
    source = "env"; reviewTimeoutMin = envTimeout;
  } else {
    source = data.reviewTimeoutMin !== undefined ? "file" : "default";
    reviewTimeoutMin = nonNegativeInt(data, "reviewTimeoutMin", DEFAULT_TIMEOUT_MIN);
  }
  const configRoot = root ?? process.cwd();
  const acceptance = parseAcceptanceConfig(data.acceptance, configRoot, env);
  parseDeploymentConfig(data.deployment);
  const preparation = parsePreparation(data.preparation, configRoot);
  const methods = parseMethodsConfig(data.methods, configRoot);
  const context = parseContext(data.context, configRoot);
  return {
    singleNode: true,
    maxRepairs: explicit(overrides.maxRepairs) ? intFlag(overrides.maxRepairs, "autoreview-max-repairs") : nonNegativeInt(data, "maxRepairs", DEFAULT_MAX_REPAIRS),
    reviewerModel: overrides.reviewerModel?.trim() || nonEmptyString(data, "reviewerModel", DEFAULT_MODEL),
    reviewerThinking: overrides.reviewerThinking?.trim() || nonEmptyString(data, "reviewerThinking", DEFAULT_THINKING),
    reviewTimeoutMin,
    reviewerCmd: overrides.reviewerCmd?.trim() || env.AUTOREVIEW_REVIEWER_CMD?.trim() || nonEmptyString(data, "reviewerCmd", ""),
    ...(acceptance ? { acceptance } : {}), ...(preparation ? { preparation } : {}),
    ...(methods ? { methods } : {}), ...(context ? { context } : {}),
    configurationHash: configurationHash({ ...data, gate: undefined }), raw: data, effectiveConfig: { reviewTimeoutMin: { value: reviewTimeoutMin, source } },
  };
}

/** 验收节点/配置工具使用；静态评审不会因此执行验收。 */
export function loadAcceptanceConfig(cwd: string, env: NodeJS.ProcessEnv = process.env): AcceptanceConfig | undefined {
  const root = findProjectRoot(cwd);
  return resolveProjectConfig(root, { env }).acceptance;
}
