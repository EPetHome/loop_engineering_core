#!/usr/bin/env node
/**
 * pipeline.ts — 多段流水线：几段 pi 会话按计划并行或串行完成后，程序跑 e2e 收尾；
 * e2e 没通过的条目按「[段名]」标签退回那一段的会话修，修完自动重跑，直到通过、暂停或超过轮数。
 *
 * 用法：node pipeline.ts <计划.json> [--launcher terminal|background] [--from e2e]
 *   terminal（macOS 默认）：每段开一个终端窗口跑它的启动命令，你可以看、可以插话；
 *   background：后台跑，输出写 <流水线目录>/<段>.log；
 *   --from e2e：各段已经完成、窗口还开着（比如上次 e2e 暂停后处理好了），直接从联调准备 / e2e 接着跑。
 * 退出码：0 完成；1 e2e 超过轮数仍没通过或段启动入口失败；2 暂停（需要你处理）；3 计划文件有错。
 *
 * 每段写 prompt（提示词文件）时，程序按你日常的配置生成 pi 启动命令（加载权限扩展和 autoreview.ts）；
 * 写 start 时原样执行，那条命令里的 pi 必须加载 autoreview.ts。开任何窗口之前先做开跑前检查，有一项不过就不开跑。
 */
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  authorizationStatus, extractCriteria, formatFailedItems, grantsFromUser, isAuthorizationCriterion, isManualCriterion,
  type AcceptanceItemResult, type AcceptanceRecord, type Criteria, type CriterionItem,
} from "./acceptance-core.ts";
import { acceptanceRunDir, describeListeners, portBusy, runAcceptanceStage } from "./acceptance.ts";
import { EXT_DIR, loadProjectLayout, parseAcceptanceConfig, PERMISSION_EXT, PI_BIN, workspacePath, type AcceptanceConfig } from "./config.ts";
import { reapProcs } from "./procs.ts";
import { createChildExec } from "./hosts/hook.ts";
import { createGitEvidence } from "./git.ts";
import { blockerHint } from "./onboarding.ts";
import {
  inboxPath, PIPELINE_DIR_ENV, PIPELINE_LAUNCH_ENV, PIPELINE_LAUNCH_TOKEN_ENV, pollMs, readJson, STAGE_ENV, statusPath, writeJsonAtomic,
  type InboxMessage, type StageStatus,
} from "./pipeline-core.ts";
import { DEFAULT_MODEL, DEFAULT_THINKING } from "./review.ts";
import { loadPreparation, runPreparation, type PreparationState } from "./preparation.ts";
import { loadContext, refreshContext, sourceInputsProblem } from "./project-context.ts";
import { createRunResource, managedShell, reapRunResources, releaseRunResource, resourceLine } from "./resources.ts";
import { methodEnv } from "./method-env.ts";
import { parseStageScope, type StageScope } from "./scope.ts";
import { commitAll, currentBranch } from "./workspace.ts";
import { queueBatchComplete } from "./merge-queue.ts";

export const DEFAULT_MAX_ROUNDS = 3;
/** 每段 pi 的默认配置（你日常的启动配置），计划的 pi 一节和每段自己的同名字段可以覆盖。 */
export const DEFAULT_PI: PiOptions = { model: "openai-codex/gpt-6.1-sol", thinking: "max", tools: "read,edit,write,bash", args: [] };
const AUTOREVIEW_PATH = join(EXT_DIR, "autoreview.ts");
export const PI_DEV = join(EXT_DIR, "bin", "pi-dev");
const snapshotRef = async (cwd: string, signal?: AbortSignal): Promise<string | undefined> => {
  try { return (await createGitEvidence(createChildExec(), cwd, signal).snapshot()).ref; } catch { return undefined; }
};
const BROWSER_TOOL = join(EXT_DIR, "acceptance-tools", "browser.mjs");
/** 段开窗后这么久还没报状态，提醒你检查启动命令有没有加载 autoreview.ts。 */
const SILENCE_MS = 3 * 60_000;

export interface PiOptions {
  model: string; thinking: string; tools: string; args: string[];
  ponytail?: { extension: string; mode: "off" | "lite" | "full" | "ultra" };
  /** 显式写了 ponytail: false；启动入口据此关闭 Ponytail。 */
  ponytailDisabled?: boolean;
}
export interface StagePlan {
  name: string;
  /** 实际执行的启动命令：写了 start 就是它，写了 prompt 就是由 bin/pi-dev 生成的命令。 */
  start: string;
  cwd: string;
  /** 写了 prompt 时的提示词文件（绝对路径）。 */
  prompt?: string;
  ponytail?: PiOptions["ponytail"];
  workspace?: string;
  branch?: string;
  /** 流水线启动前确定的开工依据；准备和会话都用它，避免脏工作区各取一次快照。 */
  baseline?: string;
  /** 本段允许/禁止修改的路径前缀；没写不做越界检查。 */
  scope?: StageScope;
}
export interface E2ePlan {
  workDir: string;
  /** 验收标准所在文件（[授权] 条目的「同意授权：…」也写在这里）。 */
  criteriaFile: string;
  /** 验收标准所在文件的原文（交给验收方当需求原文）。 */
  requirement: string;
  /** 去掉了「[段名]」标签的标准。 */
  items: CriterionItem[];
  /** 条目 → 归哪一段；没标的是 undefined。 */
  owners: Map<string, string | undefined>;
  acceptance: AcceptanceConfig;
  maxRounds: number;
}
export interface Plan {
  name: string;
  /** 批次分支（批次.json 的 branch）；写了才在段完成时由程序提交。 */
  branch?: string;
  /** 批次文件绝对路径；启动会话时交给扩展读 scope 等项目参数。 */
  file?: string;
  /** 流水线目录：状态、收件箱、e2e 材料、报告都在这里。 */
  dir: string;
  stages: Map<string, StagePlan>;
  /** 每一步里的段并行跑，步与步之间串行。 */
  steps: string[][];
  prepare?: string;
  e2e?: E2ePlan;
  maxParallel?: number;
}

export class PlanError extends Error {}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !value.trim()) throw new PlanError(`计划文件的 ${label} 必须是非空字符串`);
  return value.trim();
};
const fileSafe = (name: string): string => name.replace(/[/\\:*?"<>|\s]+/g, "_");
const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;

/**
 * 标准开头的「[段名]」：返回归属和去掉段名后的原文。标了 [人工] 的条目不自动验、不退回，没有归属，原文不动；
 * [授权] 标签不是段名，写在段名前后都行，保留在原文里。
 */
export function parseOwner(item: string): { owner?: string; text: string } {
  if (isManualCriterion(item)) return { text: item };
  const auth = /^\s*[[【]\s*授权\s*[\]】]\s*/.exec(item)?.[0] ?? "";
  const rest = item.slice(auth.length);
  const match = /^\[([^\]\n]+)\]\s*/.exec(rest);
  return match ? { owner: match[1].trim(), text: `${auth}${rest.slice(match[0].length)}` } : { text: item };
}

/** 读 model / thinking / tools / args 覆盖 base（计划的 pi 一节和每段都用这几个字段名）。 */
function piOptions(value: Record<string, unknown>, label: string, base: PiOptions, planDir: string): PiOptions {
  const pick = (key: "model" | "thinking" | "tools"): string => value[key] === undefined ? base[key] : text(value[key], `${label}.${key}`);
  let args = base.args;
  if (value.args !== undefined) {
    if (!Array.isArray(value.args) || value.args.some((item) => typeof item !== "string")) throw new PlanError(`${label}.args 必须是字符串数组`);
    args = value.args as string[];
  }
  let ponytail = base.ponytail;
  let ponytailDisabled = base.ponytailDisabled;
  if (value.ponytail === false) { ponytail = undefined; ponytailDisabled = true; }
  else if (value.ponytail !== undefined) {
    if (!isObject(value.ponytail)) throw new PlanError(`${label}.ponytail 必须是对象或 false`);
    const mode = value.ponytail.mode ?? "full";
    if (!["off", "lite", "full", "ultra"].includes(String(mode))) throw new PlanError(`${label}.ponytail.mode 无效`);
    ponytail = { extension: resolve(planDir, text(value.ponytail.extension, `${label}.ponytail.extension`)), mode: mode as NonNullable<PiOptions["ponytail"]>["mode"] };
    ponytailDisabled = false;
  }
  return { model: pick("model"), thinking: pick("thinking"), tools: pick("tools"), args,
    ...(ponytail ? { ponytail } : {}), ...(ponytailDisabled ? { ponytailDisabled: true } : {}) };
}

/** 按提示词生成一段的启动命令：统一经过 bin/pi-dev，段级覆盖照常传入。 */
export function piCommand(planName: string, stage: string, prompt: string, pi: PiOptions, cwd = "."): string {
  const args = [PI_DEV, "--cwd", cwd, "--model", pi.model, "--thinking", pi.thinking, "--tools", pi.tools,
    "--name", `${planName}·${stage}`];
  if (pi.ponytail) args.push("--ponytail", pi.ponytail.extension, "--ponytail-mode", pi.ponytail.mode);
  else if (pi.ponytailDisabled) args.push("--no-ponytail");
  args.push(prompt);
  if (pi.args.length) args.push("--", ...pi.args);
  return args.map(shellQuote).join(" ");
}

/** 解析并校验计划文件；相对路径按计划文件所在目录解析。 */
export function parsePlan(raw: unknown, planDir: string, env: NodeJS.ProcessEnv = process.env, options: { projectRoot?: string; defaultWorkspace?: string; batchFile?: string } = {}): Plan {
  if (!isObject(raw)) throw new PlanError("计划文件必须是 JSON 对象");
  const name = text(raw.name, "name");
  if (!isObject(raw.stages) || Object.keys(raw.stages).length === 0) throw new PlanError("计划文件的 stages 至少要有一段");
  if (raw.pi !== undefined && !isObject(raw.pi)) throw new PlanError("计划文件的 pi 必须是对象");
  const planPi = raw.pi === undefined ? DEFAULT_PI : piOptions(raw.pi, "pi", DEFAULT_PI, planDir);
  const batchBranch = raw.branch === undefined ? undefined : text(raw.branch, "branch");
  const project = loadProjectLayout(options.projectRoot ?? planDir);
  const stages = new Map<string, StagePlan>();
  for (const [stage, value] of Object.entries(raw.stages)) {
    if (!isObject(value)) throw new PlanError(`stages.${stage} 必须是对象`);
    if (value.cwd !== undefined && value.workspace !== undefined) throw new PlanError(`stages.${stage} 的 cwd 和 workspace 只能写一个`);
    const workspace = value.workspace === undefined ? undefined : text(value.workspace, `stages.${stage}.workspace`);
    const cwd = value.cwd !== undefined ? resolve(planDir, text(value.cwd, `stages.${stage}.cwd`))
      : workspace !== undefined ? workspacePath(project.root, project.layout, workspace)
      : options.defaultWorkspace !== undefined ? workspacePath(project.root, project.layout, options.defaultWorkspace)
      : planDir;
    const branch = value.branch === undefined ? batchBranch : text(value.branch, `stages.${stage}.branch`);
    let scope;
    try { scope = parseStageScope(value.scope, `计划文件的 stages.${stage}.scope`); }
    catch (error) { throw new PlanError((error as Error).message); }
    if ((value.prompt === undefined) === (value.start === undefined)) {
      throw new PlanError(`stages.${stage} 要写 prompt（提示词文件，推荐）或 start（自己的启动命令），两个只能写一个`);
    }
    if (value.prompt !== undefined) {
      const prompt = resolve(planDir, text(value.prompt, `stages.${stage}.prompt`));
      const pi = piOptions(value, `stages.${stage}`, planPi, planDir);
      stages.set(stage, { name: stage, start: piCommand(name, stage, prompt, pi, cwd), cwd, prompt,
        ...(pi.ponytail ? { ponytail: pi.ponytail } : {}), ...(workspace ? { workspace } : {}), ...(branch ? { branch } : {}),
        ...(scope ? { scope } : {}) });
    } else {
      stages.set(stage, { name: stage, start: text(value.start, `stages.${stage}.start`), cwd,
        ...(workspace ? { workspace } : {}), ...(branch ? { branch } : {}), ...(scope ? { scope } : {}) });
    }
  }
  let steps: string[][];
  if (raw.steps === undefined) steps = [[...stages.keys()]];
  else {
    if (!Array.isArray(raw.steps) || raw.steps.length === 0) throw new PlanError("计划文件的 steps 必须是非空数组");
    steps = raw.steps.map((step, index) => {
      const names = Array.isArray(step) ? step : [step];
      if (names.length === 0) throw new PlanError(`steps 第 ${index + 1} 步是空的`);
      return names.map((item) => text(item, `steps 第 ${index + 1} 步的段名`));
    });
  }
  const listed = steps.flat();
  for (const stage of listed) {
    if (!stages.has(stage)) throw new PlanError(`steps 里的「${stage}」在 stages 里没有`);
    if (listed.indexOf(stage) !== listed.lastIndexOf(stage)) throw new PlanError(`「${stage}」在 steps 里出现了不止一次`);
  }
  for (const stage of stages.keys()) {
    if (!listed.includes(stage)) throw new PlanError(`段「${stage}」没有排进 steps`);
  }
  const dir = raw.dir === undefined
    ? resolve(homedir(), ".pi-autoreview", "pipelines", fileSafe(name))
    : resolve(planDir, text(raw.dir, "dir"));
  const prepare = raw.prepare === undefined ? undefined : text(raw.prepare, "prepare");

  let e2e: E2ePlan | undefined;
  if (raw.e2e !== undefined) {
    if (!isObject(raw.e2e)) throw new PlanError("计划文件的 e2e 必须是对象");
    const workDir = resolve(planDir, text(raw.e2e.workDir, "e2e.workDir"));
    const criteriaFile = resolve(planDir, text(raw.e2e.criteria, "e2e.criteria"));
    if (!existsSync(criteriaFile)) throw new PlanError(`e2e.criteria 指的文件不存在：${criteriaFile}`);
    const requirement = readFileSync(criteriaFile, "utf8");
    const parsed = extractCriteria(requirement);
    if (!parsed) throw new PlanError(`${criteriaFile} 里没有「## 验收标准」条目`);
    const owners = new Map<string, string | undefined>();
    const items = parsed.map((item) => {
      const { owner, text: rest } = parseOwner(item.text);
      if (owner !== undefined && !stages.has(owner)) throw new PlanError(`${item.id} 标的段「${owner}」在 stages 里没有`);
      owners.set(item.id, owner);
      return { id: item.id, text: rest };
    });
    const maxRounds = raw.e2e.maxRounds === undefined ? DEFAULT_MAX_ROUNDS : raw.e2e.maxRounds;
    if (typeof maxRounds !== "number" || !Number.isInteger(maxRounds) || maxRounds < 1) throw new PlanError("e2e.maxRounds 必须是正整数");
    let acceptance: AcceptanceConfig;
    try {
      acceptance = parseAcceptanceConfig(raw.e2e.acceptance ?? {}, planDir, env)!;
    } catch (error) {
      throw new PlanError(`e2e.acceptance：${(error as Error).message.replace(/^\.autoreview\.json 的 /, "")}`);
    }
    e2e = { workDir, criteriaFile, requirement, items, owners, acceptance, maxRounds };
  }
  const maxParallel = raw.maxParallel ?? 2;
  if (!Number.isSafeInteger(maxParallel) || (maxParallel as number) < 1) throw new PlanError("maxParallel 必须是正整数");
  return { name, dir, stages, steps, prepare, e2e, maxParallel: maxParallel as number,
    ...(batchBranch ? { branch: batchBranch } : {}), ...(options.batchFile ? { file: resolve(options.batchFile) } : {}) };
}

/** e2e 没通过的条目按归属分组；系统级的 G1/G2 和没标归属的条目没法派，单独列出。 */
export function routeFailures(
  record: Pick<AcceptanceRecord, "items">, owners: Map<string, string | undefined>,
): { byStage: Map<string, AcceptanceItemResult[]>; unrouted: AcceptanceItemResult[] } {
  const byStage = new Map<string, AcceptanceItemResult[]>();
  const unrouted: AcceptanceItemResult[] = [];
  for (const item of record.items.filter((entry) => entry.verdict === "不通过")) {
    const owner = owners.get(item.id);
    if (!owner) { unrouted.push(item); continue; }
    byStage.set(owner, [...(byStage.get(owner) ?? []), item]);
  }
  return { byStage, unrouted };
}

/** 同一个 git 仓库里的段一次只派一个（同时改会让评审的改动混在一起），不同仓库的同时派。 */
export function dispatchBatches(stages: string[], repoOf: (stage: string) => string): string[][] {
  const queues = new Map<string, string[]>();
  for (const stage of stages) queues.set(repoOf(stage), [...(queues.get(repoOf(stage)) ?? []), stage]);
  const batches: string[][] = [];
  while ([...queues.values()].some((queue) => queue.length > 0)) {
    batches.push([...queues.values()].filter((queue) => queue.length > 0).map((queue) => queue.shift()!));
  }
  return batches;
}

/** 发给某一段的 e2e 返修：消息给开发方，条目原文给评审当「上一轮必修」。 */
export function buildRepairMessage(stage: string, round: number, items: AcceptanceItemResult[], runDir: string): Omit<InboxMessage, "seq"> {
  const mustFix = formatFailedItems({ items });
  const message = [
    `【流水线 e2e 返修 · 第 ${round} 轮】`,
    `各段都完成后跑的整合 e2e 验收，下面这些条目没通过，归你（${stage}）负责；别的段负责的部分不要改：`,
    "",
    mustFix,
    "",
    `完整材料（系统日志、证据）：${runDir}`,
    "修好后照常交付，会自动评审。认为不是你的问题就不要改代码，逐条写「A3：不归我：理由」。",
  ].join("\n");
  return { message, mustFix };
}

export interface Check { name: string; ok: boolean; detail: string }
/** 开跑前检查用到的本机路径和 Playwright 探测；测试可以替换。 */
export interface PreflightEnv { pi: string; permission: string; autoreview: string; playwright: (workDir: string) => boolean }

const defaultPreflightEnv = (): PreflightEnv => ({
  pi: PI_BIN, permission: PERMISSION_EXT, autoreview: AUTOREVIEW_PATH,
  playwright: (workDir) => spawnSync(process.execPath, [BROWSER_TOOL, "--check", workDir], { encoding: "utf8", timeout: 30_000 }).status === 0,
});
const isDir = (path: string): boolean => { try { return statSync(path).isDirectory(); } catch { return false; } };
/** 标准里要开网页、点页面时，e2e 需要 Playwright。 */
const NEEDS_BROWSER = /页面|网页|浏览器|点击|按钮|输入框|表单/;

/**
 * 开跑前检查（不调用模型，几秒钟）：目录、git 仓库、提示词、pi 和扩展、同一步里目录不重复、e2e 端口、[授权] 答复、Playwright。
 * fromE2e 时只查 e2e 相关的几项。
 */
export async function preflight(plan: Plan, options: { fromE2e?: boolean; env?: Partial<PreflightEnv> } = {}): Promise<Check[]> {
  const env = { ...defaultPreflightEnv(), ...options.env };
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string): void => { if (!checks.some((check) => check.name === name)) checks.push({ name, ok, detail }); };
  const needsPi = (!options.fromE2e && [...plan.stages.values()].some((stage) => stage.prompt))
    || Boolean(plan.e2e && !plan.e2e.acceptance.testerCmd);
  if (!options.fromE2e) {
    for (const stage of plan.stages.values()) {
      add(`${stage.name} 的目录`, isDir(stage.cwd), stage.cwd);
      const head = isDir(stage.cwd) && spawnSync("git", ["-C", stage.cwd, "rev-parse", "--verify", "HEAD"], { encoding: "utf8" }).status === 0;
      add(`${stage.name} 的目录是有提交的 git 仓库`, head, head ? stage.cwd : "自动评审只在有提交的 git 仓库里工作");
      if (stage.prompt) add(`${stage.name} 的提示词`, existsSync(stage.prompt), stage.prompt);
      if (stage.ponytail) add(`${stage.name} 的 Ponytail 原生扩展`, existsSync(stage.ponytail.extension), `${stage.ponytail.extension}；声明模式 ${stage.ponytail.mode}`);
    }
    for (const [index, step] of plan.steps.entries()) {
      const dirs = step.map((stage) => resolve(plan.stages.get(stage)!.cwd));
      const clash = step.filter((_, i) => dirs.indexOf(dirs[i]) !== i);
      add(`第 ${index + 1} 步里并行的段不在同一目录`, clash.length === 0, clash.length ? `${clash.join("、")} 和同一步的别的段在同一个目录，改动会混在一起` : step.join("、"));
    }
  }
  if (needsPi) {
    add("pi", existsSync(env.pi), env.pi);
    add("权限扩展", existsSync(env.permission), env.permission);
  }
  if (!options.fromE2e && [...plan.stages.values()].some((stage) => stage.prompt)) add("autoreview.ts", existsSync(env.autoreview), env.autoreview);
  const e2e = plan.e2e;
  if (e2e) {
    add("e2e 工作目录", isDir(e2e.workDir), e2e.workDir);
    if (e2e.acceptance.readyUrl) {
      const url = new URL(e2e.acceptance.readyUrl);
      const busy = await portBusy(url);
      add(`e2e 的地址 ${url.host} 现在空着`, !busy, busy ? `已经有程序在监听：${describeListeners(url)}` : e2e.acceptance.readyUrl);
    }
    if (e2e.items.some((item) => isAuthorizationCriterion(item.text))) {
      const criteria: Criteria = { source: "用户", items: e2e.items, version: 1, updatedAt: "" };
      const pendingGrants = authorizationStatus(criteria, grantsFromUser(e2e.requirement, criteria)).pending;
      add("e2e 的 [授权] 条目都已答复", pendingGrants.length === 0, pendingGrants.length === 0 ? "已答复"
        : `${pendingGrants.join("、")} 还没答复：在 ${e2e.criteriaFile} 里加一行「同意授权：${pendingGrants.join("、")}」或「不授权：${pendingGrants.join("、")}」`);
    }
    if (e2e.items.some((item) => !isManualCriterion(item.text) && NEEDS_BROWSER.test(item.text))) {
      const found = isDir(e2e.workDir) && env.playwright(e2e.workDir);
      add("Playwright（e2e 要操作网页）", found, found ? "找到了" : `找不到：在 ${e2e.workDir} 里执行接入手册的【块 3】`);
    }
  }
  return checks;
}

/** cwd 所在的 git 仓库根目录；不是 git 仓库就用 cwd 本身。 */
export function repoKey(cwd: string): string {
  const res = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  return res.status === 0 && res.stdout.trim() ? res.stdout.trim() : resolve(cwd);
}

/** 段的启动脚本：进目录、带上流水线环境变量，再跑计划里的启动命令。 */
export function stageScript(plan: Plan, stage: StagePlan): string {
  const batch = plan.file ? ` AUTOREVIEW_BATCH_FILE=${shellQuote(plan.file)}` : "";
  const baseline = stage.baseline ? ` AUTOREVIEW_BASE_REV=${shellQuote(stage.baseline)}` : "";
  // 所有段入口都持有一份启动身份：prompt 由 pi-dev 撤掉，自定义 start 由 autoreview 扩展加载时撤掉。
  const token = ` ${PIPELINE_LAUNCH_TOKEN_ENV}=${shellQuote(randomUUID())}`;
  return `cd ${shellQuote(stage.cwd)} && export ${PIPELINE_DIR_ENV}=${shellQuote(plan.dir)} ${STAGE_ENV}=${shellQuote(stage.name)} ${PIPELINE_LAUNCH_ENV}=1${batch}${baseline}${token} && ${stage.start}`;
}

class StageStartupFailure extends Error {
  stage: string;
  constructor(stage: string, reason: string) { super(reason); this.stage = stage; }
}

export interface PipelineIO {
  launch: (stage: StagePlan, script: string) => void;
  notify: (message: string) => void;
  log: (message: string) => void;
  pollMs: number;
  silenceMs: number;
  /** 测试用：替换开跑前检查里的本机路径和 Playwright 探测。 */
  preflightEnv?: Partial<PreflightEnv>;
}

/** 跑一条流水线，返回退出码（见文件头）。 */
export async function runPipeline(plan: Plan, io: PipelineIO, options: { fromE2e?: boolean; signal?: AbortSignal } = {}): Promise<number> {
  mkdirSync(plan.dir, { recursive: true });
  reapRunResources();
  // 必须先处理本流水线的孤儿，再检查端口；开发会话不在此清理范围。
  for (const file of ["procs.json", "procs.json.cleanup", "prepare.procs.json", ...[...plan.stages.keys()].map((name) => `${fileSafe(name)}.prepare.procs.json`)]) reapProcs(resolve(plan.dir, file));
  let cleanupRecordPath: string | undefined;
  let completionEpochs: string | undefined;
  const completed = new Set<string>();
  const readiness = (names: Iterable<string> = plan.stages.keys(), inspectSources = true) => {
    const invalid: string[] = [], epochs: [string, string, string, number][] = [];
    for (const name of names) {
      const status = readJson<StageStatus>(statusPath(plan.dir, name));
      const message = readJson<InboxMessage>(inboxPath(plan.dir, name));
      if (status?.event !== "done" || typeof status.readyEpoch !== "string" || !status.readyEpoch
        || (status.inbox ?? 0) < (message?.seq ?? 0)) invalid.push(name);
      else {
        try {
          if (inspectSources && sourceInputsProblem(plan.stages.get(name)!.cwd, status.sourceInputs)) { invalid.push(name); continue; }
          epochs.push([name, status.sessionId, status.readyEpoch, status.inbox ?? 0]);
        } catch { invalid.push(name); } // 无法读取真实来源时不能只相信旧 done。
      }
    }
    return { invalid, token: JSON.stringify(epochs) };
  };
  const report: string[] = [`# 流水线报告：${plan.name}`, "", `- 开始：${new Date().toLocaleString("zh-CN", { hour12: false })}`, `- 目录：${plan.dir}`];
  let e2ePassed = false;
  const finish = (code: number, line: string): number => {
    if (code === 0) {
      const latest = readiness();
      if (latest.invalid.length || (completionEpochs && latest.token !== completionEpochs)) { code = 2; line = "完成前段资格已变化，本批结果不能用于新的输入；开发会话与计数保留"; }
    }
    if (code === 0 && plan.file) {
      try { queueBatchComplete(plan.stages.values().next().value!.cwd, plan.file, e2ePassed); }
      catch (error) { code = 2; line = `完成后进合入队列失败：${(error as Error).message}；成果与段资格保留，修复后 --from e2e 重试`; }
    }
    report.push("", `## 结果`, line);
    writeFileSync(resolve(plan.dir, "report.md"), `${report.join("\n")}\n`);
    writeFileSync(resolve(plan.dir, "pipeline.finished"), `${code}\n`);
    io.notify(`流水线 ${plan.name}：${line}`);
    return code;
  };
  rmSync(resolve(plan.dir, "pipeline.finished"), { force: true });

  try {
  options.signal?.throwIfAborted();
  // 开跑前检查：有一项不过就不开任何窗口。
  const checks = await preflight(plan, { fromE2e: options.fromE2e, env: io.preflightEnv });
  report.push("", "## 开跑前检查", ...checks.map((check) => `- ${check.ok ? "🟢" : "🔴"} ${check.name}：${check.detail}`), "");
  for (const check of checks) io.log(`${check.ok ? "🟢" : "🔴"} ${check.name}：${check.detail}`);
  const failed = checks.filter((check) => !check.ok);
  if (failed.length > 0) {
    return finish(2, `开跑前检查没通过：${failed.map((check) => `${check.name}（${check.detail}）`).join("；")}`);
  }

  /** 等某一段出现「派发之后」的完成或没改动；暂停时提醒你，接着等你在它的窗口里处理。 */
  const waitStage = async (stage: string, afterSeq: number, inboxSeq = 0, signal = options.signal): Promise<StageStatus> => {
    const started = Date.now();
    let notifiedPause = 0;
    let warnedSilence = false;
    for (;;) {
      signal?.throwIfAborted();
      const status = readJson<StageStatus>(statusPath(plan.dir, stage));
      if (status && status.seq > afterSeq && status.inbox >= inboxSeq) {
        if (status.event === "startup-failed") throw new StageStartupFailure(stage, status.pauseReason ?? "启动入口失败，没有启动会话");
        if (status.event === "done" && !status.readyEpoch) return { ...status, event: "paused", pauseReason: "旧完成记录没有资格身份，请用当前扩展重新检查" };
        if (status.event === "done" || status.event === "no-change") return status;
        if (status.event === "paused" && notifiedPause !== status.seq) {
          notifiedPause = status.seq;
          io.notify(`流水线 ${plan.name}：${stage} 暂停（${status.pauseReason ?? "原因见它的总结"}），在它的窗口里处理，流水线会接着等`);
        }
      }
      if (!status && !warnedSilence && Date.now() - started > io.silenceMs) {
        warnedSilence = true;
        io.notify(`流水线 ${plan.name}：还没收到「${stage}」的状态，确认它的启动命令加载了 autoreview.ts（-e …/autoreview.ts）`);
      }
      await sleep(io.pollMs, undefined, { signal });
    }
  };
  const currentSeq = (stage: string): number => readJson<StageStatus>(statusPath(plan.dir, stage))?.seq ?? 0;

  if (options.fromE2e) {
    const notDone = readiness().invalid;
    if (notDone.length > 0) return finish(2, `--from e2e 需要各段都已完成，${notDone.join("、")} 还没有`);
    report.push("- 从 e2e 接着跑（各段已完成）");
  } else {
    const concurrency = plan.maxParallel ?? 2;
    for (const stage of plan.stages.keys()) {
      rmSync(statusPath(plan.dir, stage), { force: true });
      rmSync(inboxPath(plan.dir, stage), { force: true });
    }
    for (const [index, step] of plan.steps.entries()) {
      options.signal?.throwIfAborted();
      for (const group of dispatchBatches(step, (name) => repoKey(plan.stages.get(name)!.cwd))) {
        for (let offset = 0; offset < group.length; offset += concurrency) {
          const batch = group.slice(offset, offset + concurrency);
          const invalidBefore = readiness(completed).invalid;
          if (invalidBefore.length) return finish(2, `上游段资格已失效：${invalidBefore.join("、")}；未启动下游`);
          for (const stage of batch) {
            const current = plan.stages.get(stage)!;
            const branch = current.branch ?? plan.branch;
            if (!branch) continue;
            let actual: string | undefined;
            try { actual = currentBranch(current.cwd); } catch (error) {
              return finish(2, `${stage} 的目录无法读取分支：${(error as Error).message}；未启动会话`);
            }
            if (actual !== branch) return finish(2, `${stage} 的目录在分支 ${actual ?? "detached"}，批次要求 ${branch}；未启动会话`);
          }
          const prepared = await Promise.all(batch.map(async (name) => {
            const stage = plan.stages.get(name)!;
            stage.baseline = await snapshotRef(stage.cwd, options.signal);
            if (!stage.baseline) return `${name}：无法读取开工依据`;
            const context = loadContext(stage.cwd);
            if (context) {
              const source = refreshContext(context);
              report.push(`- ${name} 来源版本 ${source.snapshot.revision}：${source.path}`);
              if (source.snapshot.missing.length) return `${name} 缺少来源：${source.snapshot.missing.join("、")}`;
            }
            const config = loadPreparation(stage.cwd);
            if (!config) return undefined;
            const file = resolve(plan.dir, `${fileSafe(name)}.preparation.json`);
            const state = readJson<PreparationState>(file) ?? {};
            const result = await runPreparation({ config, cwd: stage.cwd, state, signal: options.signal,
              exec: createChildExec(resolve(plan.dir, `${fileSafe(name)}.prepare.procs.json`)), procsFile: resolve(plan.dir, `${fileSafe(name)}.prepare.procs.json`),
              env: methodEnv(stage.baseline, { batchFile: plan.file, stage: name }),
              runDir: resolve(plan.dir, "preparation", fileSafe(name)), saveState: () => writeJsonAtomic(file, state), onProgress: io.log });
            return result.ok ? undefined : `${name}：${result.reason}（${result.log}）`;
          }));
          const blocked = prepared.filter(Boolean);
          if (blocked.length) return finish(2, `准备未完成：${blocked.join("；")}`);
          options.signal?.throwIfAborted();
          const invalidAfter = readiness(completed).invalid;
          if (invalidAfter.length) return finish(2, `上游段资格已失效：${invalidAfter.join("、")}；未启动下游`);
          io.log(`第 ${index + 1} 步：启动 ${batch.join("、")}`);
          for (const stage of batch) io.launch(plan.stages.get(stage)!, stageScript(plan, plan.stages.get(stage)!));
          let statuses: StageStatus[];
          const startupAbort = new AbortController();
          const waitSignal = options.signal ? AbortSignal.any([options.signal, startupAbort.signal]) : startupAbort.signal;
          try { statuses = await Promise.all(batch.map((stage) => waitStage(stage, 0, 0, waitSignal))); }
          catch (error) {
            // 一段启动失败就收束同批其他等待；只停编排轮询，不杀已经启动的开发会话。
            startupAbort.abort();
            if (error instanceof StageStartupFailure) return finish(1, `段 ${error.stage} 启动失败：${error.message}；未启动下游`);
            throw error;
          }
          if (statuses.some((status) => status.event !== "done")) return finish(2, "段未取得当前完成资格，未启动下游");
          for (const stage of batch) {
            const current = plan.stages.get(stage)!;
            const branch = current.branch ?? plan.branch;
            if (branch) {
              try {
                const commit = commitAll(current.cwd, branch, plan.name, stage);
                if (commit.committed) {
                  report.push(`- ${stage} 完成提交：${commit.commit}（${branch}）`);
                  io.log(`${stage} 完成提交：${branch} ${commit.commit}`);
                }
              } catch (error) {
                return finish(2, `${stage} 完成提交失败：${(error as Error).message}`);
              }
            }
          }
          for (const stage of batch) completed.add(stage);
          const invalid = readiness(completed).invalid;
          if (invalid.length) return finish(2, `已完成段资格被撤销：${invalid.join("、")}；未启动下游或整合验收`);
        }
      }
      report.push(`- 第 ${index + 1} 步完成：${step.join("、")}（${new Date().toLocaleTimeString("zh-CN", { hour12: false })}）`);
    }
  }
  const ready = readiness();
  if (ready.invalid.length) return finish(2, `整合前段资格无效：${ready.invalid.join("、")}`);
  const e2e = plan.e2e;
  if (!e2e) return finish(0, "各段都已完成（计划里没有 e2e）");

  if (plan.prepare) {
    io.log("联调准备");
    const resource = createRunResource(`pipeline:${plan.name}:prepare`, 0, resolve(plan.dir, "prepare.procs.json"));
    let code: number;
    try {
      const result = await createChildExec(resolve(plan.dir, "prepare.procs.json"))("/bin/sh", ["-c", managedShell(plan.prepare, resource)],
        { cwd: e2e.workDir, timeout: 10 * 60_000, signal: options.signal, role: "联调准备",
          env: methodEnv(await snapshotRef(e2e.workDir, options.signal), { batchFile: plan.file }) });
      writeFileSync(resolve(plan.dir, "prepare.log"), `${result.stdout}\n${result.stderr}`);
      options.signal?.throwIfAborted();
      code = result.code;
    } finally { releaseRunResource(resource); report.push(`- ${resourceLine(resource)}`); }
    if (resource.status !== "released") return finish(2, "联调准备资源释放未确认");
    if (code !== 0) return finish(2, `联调准备失败（退出码 ${code}）：修好后用 --from e2e 接着跑`);
    report.push("- 联调准备完成");
  }

  const criteria: Criteria = { source: "用户", items: e2e.items, version: 1, updatedAt: new Date().toISOString() };
  // [授权] 条目的答复写在标准文件里（你自己的文件）；没答复的停下来问你，不让验收方先动手。
  const grants = grantsFromUser(e2e.requirement, criteria);
  const pending = authorizationStatus(criteria, grants).pending;
  if (pending.length > 0) {
    return finish(2, `e2e 标准里 ${pending.join("、")} 要你授权：同意就在 ${e2e.criteriaFile} 里加一行「同意授权：${pending.join("、")}」，`
      + `不同意就加「不授权：${pending.join("、")}」（这几条留给你人工验收），再用 --from e2e 接着跑`);
  }
  const state = { requirement: e2e.requirement, criteria, grants };
  const procsFile = resolve(plan.dir, "procs.json");
  const inboxSeq = new Map<string, number>([...plan.stages.keys()].map((stage) => [stage, readJson<InboxMessage>(inboxPath(plan.dir, stage))?.seq ?? 0]));
  let previousFailed: string[] = [];
  for (let round = 1; round <= e2e.maxRounds; round += 1) {
    options.signal?.throwIfAborted();
    io.log(`e2e 第 ${round} 轮`);
    const expected = readiness();
    if (expected.invalid.length) return finish(2, `整合验收前段资格已失效：${expected.invalid.join("、")}`);
    const integration = new AbortController();
    const cancel = () => integration.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", cancel, { once: true });
    if (options.signal?.aborted) cancel();
    let invalidated = false;
    let sourcesCheckedAt = 0;
    const check = (inspectSources = true) => {
      const current = readiness(undefined, inspectSources);
      if (inspectSources) sourcesCheckedAt = Date.now();
      if (current.invalid.length || current.token !== expected.token) { invalidated = true; integration.abort(new Error("段完成资格已变化")); }
      integration.signal.throwIfAborted();
    };
    const watch = setInterval(() => { try { check(Date.now() - sourcesCheckedAt >= 30_000); } catch { /* 主任务结束后记录失效 */ } }, Math.min(io.pollMs, 250));
    let stage: Awaited<ReturnType<typeof runAcceptanceStage>>;
    try {
      check();
      const onlyStage = plan.stages.size === 1 ? [...plan.stages.keys()][0] : undefined;
      stage = await runAcceptanceStage({
      workDir: e2e.workDir, devSessionId: `pipeline-${plan.name}`, round, deliveryNote: "", state, config: e2e.acceptance,
      env: methodEnv(await snapshotRef(e2e.workDir, integration.signal), { batchFile: plan.file, stage: onlyStage }),
      reviewerModel: DEFAULT_MODEL, reviewerThinking: DEFAULT_THINKING, exec: createChildExec(procsFile),
      signal: integration.signal, checkLive: check, upstreamEpochs: JSON.parse(expected.token),
      cleanupExec: createChildExec(`${procsFile}.cleanup`), onCleanup: (_work, path) => { cleanupRecordPath = path; },
      runDir: acceptanceRunDir(resolve(plan.dir, "e2e"), round), procsFile,
      deadline: Date.now() + e2e.acceptance.timeoutMin * 60_000, now: Date.now, previousFailed,
      saveState: () => {}, onProgress: io.log,
    });
      check();
      completionEpochs = expected.token;
    } catch (error) {
      if (invalidated && !options.signal?.aborted) {
        if (cleanupRecordPath) { const cleanup = readJson<{ status: string }>(cleanupRecordPath); report.push(`- 外部资源释放：${cleanup?.status ?? "未确认"}；${cleanupRecordPath}`); }
        return finish(2, "整合验收期间段完成资格变化，本轮结果已失效；开发会话和计数保留");
      }
      throw error;
    } finally { clearInterval(watch); options.signal?.removeEventListener("abort", cancel); }
    if (stage.kind === "paused") return finish(2, `e2e 暂停：${stage.reason}。${stage.hint}；处理好后用 --from e2e 接着跑`);
    const { record } = stage;
    report.push(`- e2e 第 ${round} 轮：${record.verdict}（材料：${record.runDir}）`);
    if (record.verdict === "通过") { e2ePassed = true; return finish(0, "e2e 全部通过，流水线完成"); }
    if (record.verdict === "部分验证") return finish(0, `e2e 通过，但 ${record.reason}（材料：${record.runDir}）`);
    if (record.verdict === "无法验收") {
      return finish(2, `e2e 无法验收：${record.reason}。${blockerHint(record, e2e.workDir, e2e.acceptance)}；处理好后用 --from e2e 接着跑`);
    }
    const failedIds = record.items.filter((item) => item.verdict === "不通过").map((item) => item.id);
    if (round === e2e.maxRounds) return finish(1, `e2e 第 ${round} 轮仍有 ${failedIds.join("、")} 没通过，已到 ${e2e.maxRounds} 轮上限（材料：${record.runDir}）`);
    const { byStage, unrouted } = routeFailures(record, e2e.owners);
    if (unrouted.length > 0) {
      return finish(2, `e2e 有条目没法确定归谁：${unrouted.map((item) => item.id).join("、")}（没标 [段名]，或是 G1/G2 系统级问题），材料：${record.runDir}`);
    }
    for (const group of dispatchBatches([...byStage.keys()], (name) => repoKey(plan.stages.get(name)!.cwd))) {
      for (let offset = 0; offset < group.length; offset += plan.maxParallel ?? 2) {
      const batch = group.slice(offset, offset + (plan.maxParallel ?? 2));
      const repairAbort = new AbortController();
      const repairSignal = options.signal ? AbortSignal.any([options.signal, repairAbort.signal]) : repairAbort.signal;
      const waits = batch.map((name) => {
        const seq = (inboxSeq.get(name) ?? 0) + 1;
        inboxSeq.set(name, seq);
        const afterSeq = currentSeq(name);
        writeJsonAtomic(inboxPath(plan.dir, name), { seq, ...buildRepairMessage(name, round, byStage.get(name)!, record.runDir) });
        report.push(`  - 退回 ${name}：${byStage.get(name)!.map((item) => item.id).join("、")}`);
        io.log(`e2e 第 ${round} 轮：退回 ${name}（${byStage.get(name)!.map((item) => item.id).join("、")}）`);
        return waitStage(name, afterSeq, seq, repairSignal).then((status) => ({ name, status }));
      });
      let waited: Array<{ name: string; status: StageStatus }>;
      try { waited = await Promise.all(waits); }
      catch (error) {
        repairAbort.abort();
        if (error instanceof StageStartupFailure) return finish(1, `段 ${error.stage} 启动失败：${error.message}`);
        throw error;
      }
      for (const { name, status } of waited) {
        if (status.event === "no-change") {
          return finish(2, `${name} 收到 e2e 返修后没改代码，回复：${(status.reply ?? "").trim().slice(0, 500) || "（无）"}。由你决定归谁，改好后用 --from e2e 接着跑`);
        }
      }
    }
    }
    previousFailed = failedIds;
  }
  return finish(1, "e2e 没有跑完");
  } catch (error) {
    if (!options.signal?.aborted) throw error;
    if (cleanupRecordPath) {
      const cleanup = readJson<{ status: string; reason?: string }>(cleanupRecordPath);
      report.push(`- 外部资源释放：${cleanup?.status ?? "未确认"}；记录：${cleanupRecordPath}；${cleanup?.reason ?? ""}`);
    }
    return finish(2, "流水线已取消并完成有界收尾；开发会话保留，处理后可恢复");
  }
}

/** macOS：开一个终端窗口跑脚本。 */
function launchTerminal(_stage: StagePlan, script: string): void {
  const escaped = script.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  spawnSync("osascript", ["-e", `tell application "Terminal" to do script "${escaped}"`, "-e", "tell application \"Terminal\" to activate"]);
}

function launchBackground(dir: string) {
  return (stage: StagePlan, script: string): void => {
    const out = openSync(resolve(dir, `${fileSafe(stage.name)}.log`), "a");
    try { spawn("/bin/sh", ["-c", script], { detached: true, stdio: ["ignore", out, out] }).unref(); }
    finally { closeSync(out); }
  };
}

function notifySystem(message: string): void {
  console.log(`[流水线] ${message}`);
  if (process.platform !== "darwin") return;
  const escaped = message.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  spawnSync("osascript", ["-e", `display notification "${escaped}" with title "自动评审流水线"`]);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const planPath = args.find((arg, index) => !arg.startsWith("--") && !["--launcher", "--from", "--project-root", "--default-workspace"].includes(args[index - 1] ?? ""));
  const flag = (name: string) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
  if (!planPath) {
    console.log("用法：node pipeline.ts <计划.json> [--launcher terminal|background] [--from e2e] [--project-root <目录>] [--default-workspace <名字>]");
    process.exitCode = 3;
    return;
  }
  let plan: Plan;
  try {
    plan = parsePlan(JSON.parse(readFileSync(planPath, "utf8")), dirname(resolve(planPath)), process.env, {
      projectRoot: flag("--project-root"), defaultWorkspace: flag("--default-workspace"), batchFile: resolve(planPath) });
  } catch (error) {
    console.log(`计划文件有错：${(error as Error).message}`);
    process.exitCode = 3;
    return;
  }
  mkdirSync(plan.dir, { recursive: true });
  const launcher = flag("--launcher") ?? (process.platform === "darwin" ? "terminal" : "background");
  const controller = new AbortController();
  const signals: NodeJS.Signals[] = ["SIGTERM", "SIGINT", "SIGHUP"];
  const cancel = () => controller.abort();
  for (const signal of signals) process.on(signal, cancel);
  try {
  process.exitCode = await runPipeline(plan, {
    launch: launcher === "terminal" ? launchTerminal : launchBackground(plan.dir),
    notify: notifySystem,
    log: (message) => console.log(`[流水线] ${message}`),
    pollMs: pollMs(process.env, 2000),
    silenceMs: SILENCE_MS,
  }, { fromE2e: flag("--from") === "e2e", signal: controller.signal });
  } finally { for (const signal of signals) process.off(signal, cancel); }
  console.log(`报告：${resolve(plan.dir, "report.md")}`);
}

const entry = process.argv[1] ? resolve(process.argv[1]) : "";
if (entry === fileURLToPath(import.meta.url)) void main();
