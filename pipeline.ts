#!/usr/bin/env node
/**
 * pipeline.ts — 多段流水线：几段 pi 会话按计划并行或串行完成后，程序跑 e2e 收尾；
 * e2e 没通过的条目按「[段名]」标签退回那一段的会话修，修完自动重跑，直到通过、暂停或超过轮数。
 *
 * 用法：node pipeline.ts <计划.json> [--launcher terminal|background] [--from e2e]
 *   terminal（macOS 默认）：每段开一个终端窗口跑它的启动命令，你可以看、可以插话；
 *   background：后台跑，输出写 <流水线目录>/<段>.log；
 *   --from e2e：各段已经完成、窗口还开着（比如上次 e2e 暂停后处理好了），直接从联调准备 / e2e 接着跑。
 * 退出码：0 完成；1 e2e 超过轮数仍没通过；2 暂停（需要你处理）；3 计划文件有错。
 *
 * 每段的会话必须加载 autoreview.ts：扩展按 AUTOREVIEW_PIPELINE_DIR / AUTOREVIEW_STAGE 写状态、读收件箱。
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  extractCriteria, formatFailedItems, type AcceptanceItemResult, type AcceptanceRecord, type Criteria, type CriterionItem,
} from "./acceptance-core.ts";
import { acceptanceRunDir, runAcceptanceStage } from "./acceptance.ts";
import { parseAcceptanceConfig, type AcceptanceConfig } from "./config.ts";
import { createChildExec } from "./hosts/hook.ts";
import { blockerHint } from "./onboarding.ts";
import {
  inboxPath, PIPELINE_DIR_ENV, pollMs, readJson, STAGE_ENV, statusPath, writeJsonAtomic,
  type InboxMessage, type StageStatus,
} from "./pipeline-core.ts";
import { DEFAULT_MODEL, DEFAULT_THINKING } from "./review.ts";

export const DEFAULT_MAX_ROUNDS = 3;
/** 段开窗后这么久还没报状态，提醒你检查启动命令有没有加载 autoreview.ts。 */
const SILENCE_MS = 3 * 60_000;

export interface StagePlan { name: string; start: string; cwd: string }
export interface E2ePlan {
  workDir: string;
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
  /** 流水线目录：状态、收件箱、e2e 材料、报告都在这里。 */
  dir: string;
  stages: Map<string, StagePlan>;
  /** 每一步里的段并行跑，步与步之间串行。 */
  steps: string[][];
  prepare?: string;
  e2e?: E2ePlan;
}

export class PlanError extends Error {}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !value.trim()) throw new PlanError(`计划文件的 ${label} 必须是非空字符串`);
  return value.trim();
};
const fileSafe = (name: string): string => name.replace(/[/\\:*?"<>|\s]+/g, "_");

/** 标准开头的「[段名]」：返回归属和去掉标签后的原文。 */
export function parseOwner(item: string): { owner?: string; text: string } {
  const match = /^\[([^\]\n]+)\]\s*/.exec(item);
  return match ? { owner: match[1].trim(), text: item.slice(match[0].length) } : { text: item };
}

/** 解析并校验计划文件；相对路径按计划文件所在目录解析。 */
export function parsePlan(raw: unknown, planDir: string, env: NodeJS.ProcessEnv = process.env): Plan {
  if (!isObject(raw)) throw new PlanError("计划文件必须是 JSON 对象");
  const name = text(raw.name, "name");
  if (!isObject(raw.stages) || Object.keys(raw.stages).length === 0) throw new PlanError("计划文件的 stages 至少要有一段");
  const stages = new Map<string, StagePlan>();
  for (const [stage, value] of Object.entries(raw.stages)) {
    if (!isObject(value)) throw new PlanError(`stages.${stage} 必须是对象`);
    const cwd = value.cwd === undefined ? planDir : resolve(planDir, text(value.cwd, `stages.${stage}.cwd`));
    stages.set(stage, { name: stage, start: text(value.start, `stages.${stage}.start`), cwd });
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
    e2e = { workDir, requirement, items, owners, acceptance, maxRounds };
  }
  return { name, dir, stages, steps, prepare, e2e };
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

/** cwd 所在的 git 仓库根目录；不是 git 仓库就用 cwd 本身。 */
export function repoKey(cwd: string): string {
  const res = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  return res.status === 0 && res.stdout.trim() ? res.stdout.trim() : resolve(cwd);
}

const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;

/** 段的启动脚本：进目录、带上流水线环境变量，再跑计划里的启动命令。 */
export function stageScript(plan: Plan, stage: StagePlan): string {
  return `cd ${shellQuote(stage.cwd)} && export ${PIPELINE_DIR_ENV}=${shellQuote(plan.dir)} ${STAGE_ENV}=${shellQuote(stage.name)} && ${stage.start}`;
}

export interface PipelineIO {
  launch: (stage: StagePlan, script: string) => void;
  notify: (message: string) => void;
  log: (message: string) => void;
  pollMs: number;
  silenceMs: number;
}

/** 跑一条流水线，返回退出码（见文件头）。 */
export async function runPipeline(plan: Plan, io: PipelineIO, options: { fromE2e?: boolean } = {}): Promise<number> {
  mkdirSync(plan.dir, { recursive: true });
  const report: string[] = [`# 流水线报告：${plan.name}`, "", `- 开始：${new Date().toLocaleString("zh-CN", { hour12: false })}`, `- 目录：${plan.dir}`];
  const finish = (code: number, line: string): number => {
    report.push("", `## 结果`, line);
    writeFileSync(resolve(plan.dir, "report.md"), `${report.join("\n")}\n`);
    writeFileSync(resolve(plan.dir, "pipeline.finished"), `${code}\n`);
    io.notify(`流水线 ${plan.name}：${line}`);
    return code;
  };
  const sleep = (ms: number) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
  rmSync(resolve(plan.dir, "pipeline.finished"), { force: true });

  /** 等某一段出现「派发之后」的完成或没改动；暂停时提醒你，接着等你在它的窗口里处理。 */
  const waitStage = async (stage: string, afterSeq: number, inboxSeq = 0): Promise<StageStatus> => {
    const started = Date.now();
    let notifiedPause = 0;
    let warnedSilence = false;
    for (;;) {
      const status = readJson<StageStatus>(statusPath(plan.dir, stage));
      if (status && status.seq > afterSeq && status.inbox >= inboxSeq) {
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
      await sleep(io.pollMs);
    }
  };
  const currentSeq = (stage: string): number => readJson<StageStatus>(statusPath(plan.dir, stage))?.seq ?? 0;

  if (options.fromE2e) {
    const notDone = [...plan.stages.keys()].filter((stage) => readJson<StageStatus>(statusPath(plan.dir, stage))?.event !== "done");
    if (notDone.length > 0) return finish(2, `--from e2e 需要各段都已完成，${notDone.join("、")} 还没有`);
    report.push("- 从 e2e 接着跑（各段已完成）");
  } else {
    for (const stage of plan.stages.keys()) {
      rmSync(statusPath(plan.dir, stage), { force: true });
      rmSync(inboxPath(plan.dir, stage), { force: true });
    }
    for (const [index, step] of plan.steps.entries()) {
      io.log(`第 ${index + 1} 步：启动 ${step.join("、")}`);
      for (const stage of step) io.launch(plan.stages.get(stage)!, stageScript(plan, plan.stages.get(stage)!));
      await Promise.all(step.map((stage) => waitStage(stage, 0)));
      report.push(`- 第 ${index + 1} 步完成：${step.join("、")}（${new Date().toLocaleTimeString("zh-CN", { hour12: false })}）`);
    }
  }
  const e2e = plan.e2e;
  if (!e2e) return finish(0, "各段都已完成（计划里没有 e2e）");

  if (plan.prepare) {
    io.log("联调准备");
    const code = await new Promise<number>((resolveCode) => {
      const child = spawn("/bin/sh", ["-c", plan.prepare!], { cwd: e2e.workDir, stdio: "inherit" });
      child.on("close", (exitCode) => resolveCode(exitCode ?? 1));
      child.on("error", () => resolveCode(127));
    });
    if (code !== 0) return finish(2, `联调准备失败（退出码 ${code}）：修好后用 --from e2e 接着跑`);
    report.push("- 联调准备完成");
  }

  const criteria: Criteria = { source: "用户", items: e2e.items, version: 1, updatedAt: new Date().toISOString() };
  const state = { requirement: e2e.requirement, criteria };
  const procsFile = resolve(plan.dir, "procs.json");
  const inboxSeq = new Map<string, number>([...plan.stages.keys()].map((stage) => [stage, readJson<InboxMessage>(inboxPath(plan.dir, stage))?.seq ?? 0]));
  let previousFailed: string[] = [];
  for (let round = 1; round <= e2e.maxRounds; round += 1) {
    io.log(`e2e 第 ${round} 轮`);
    const stage = await runAcceptanceStage({
      workDir: e2e.workDir, devSessionId: `pipeline-${plan.name}`, round, deliveryNote: "", state, config: e2e.acceptance,
      reviewerModel: DEFAULT_MODEL, reviewerThinking: DEFAULT_THINKING, exec: createChildExec(procsFile),
      runDir: acceptanceRunDir(resolve(plan.dir, "e2e"), round), procsFile,
      deadline: Date.now() + e2e.acceptance.timeoutMin * 60_000, now: Date.now, previousFailed,
      saveState: () => {}, onProgress: io.log,
    });
    if (stage.kind === "paused") return finish(2, `e2e 暂停：${stage.reason}。${stage.hint}；处理好后用 --from e2e 接着跑`);
    const { record } = stage;
    report.push(`- e2e 第 ${round} 轮：${record.verdict}（材料：${record.runDir}）`);
    if (record.verdict === "通过") return finish(0, "e2e 全部通过，流水线完成");
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
    for (const batch of dispatchBatches([...byStage.keys()], (name) => repoKey(plan.stages.get(name)!.cwd))) {
      const waits = batch.map((name) => {
        const seq = (inboxSeq.get(name) ?? 0) + 1;
        inboxSeq.set(name, seq);
        const afterSeq = currentSeq(name);
        writeJsonAtomic(inboxPath(plan.dir, name), { seq, ...buildRepairMessage(name, round, byStage.get(name)!, record.runDir) });
        report.push(`  - 退回 ${name}：${byStage.get(name)!.map((item) => item.id).join("、")}`);
        io.log(`e2e 第 ${round} 轮：退回 ${name}（${byStage.get(name)!.map((item) => item.id).join("、")}）`);
        return waitStage(name, afterSeq, seq).then((status) => ({ name, status }));
      });
      for (const { name, status } of await Promise.all(waits)) {
        if (status.event === "no-change") {
          return finish(2, `${name} 收到 e2e 返修后没改代码，回复：${(status.reply ?? "").trim().slice(0, 500) || "（无）"}。由你决定归谁，改好后用 --from e2e 接着跑`);
        }
      }
    }
    previousFailed = failedIds;
  }
  return finish(1, "e2e 没有跑完");
}

/** macOS：开一个终端窗口跑脚本。 */
function launchTerminal(_stage: StagePlan, script: string): void {
  const escaped = script.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  spawnSync("osascript", ["-e", `tell application "Terminal" to do script "${escaped}"`, "-e", "tell application \"Terminal\" to activate"]);
}

function launchBackground(dir: string) {
  return (stage: StagePlan, script: string): void => {
    const out = openSync(resolve(dir, `${fileSafe(stage.name)}.log`), "a");
    spawn("/bin/sh", ["-c", script], { detached: true, stdio: ["ignore", out, out] }).unref();
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
  const planPath = args.find((arg, index) => !arg.startsWith("--") && !["--launcher", "--from"].includes(args[index - 1] ?? ""));
  const flag = (name: string) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
  if (!planPath) {
    console.log("用法：node pipeline.ts <计划.json> [--launcher terminal|background] [--from e2e]");
    process.exitCode = 3;
    return;
  }
  let plan: Plan;
  try {
    plan = parsePlan(JSON.parse(readFileSync(planPath, "utf8")), dirname(resolve(planPath)));
  } catch (error) {
    console.log(`计划文件有错：${(error as Error).message}`);
    process.exitCode = 3;
    return;
  }
  mkdirSync(plan.dir, { recursive: true });
  const launcher = flag("--launcher") ?? (process.platform === "darwin" ? "terminal" : "background");
  process.exitCode = await runPipeline(plan, {
    launch: launcher === "terminal" ? launchTerminal : launchBackground(plan.dir),
    notify: notifySystem,
    log: (message) => console.log(`[流水线] ${message}`),
    pollMs: pollMs(process.env, 2000),
    silenceMs: SILENCE_MS,
  }, { fromE2e: flag("--from") === "e2e" });
  console.log(`报告：${resolve(plan.dir, "report.md")}`);
}

const entry = process.argv[1] ? resolve(process.argv[1]) : "";
if (entry === fileURLToPath(import.meta.url)) void main();
