#!/usr/bin/env node
/** bin/loop：新卡唯一编排入口，保留单会话、纯报告、PA、历史查询/安全停止与维护。 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findProjectRoot, resolveProjectConfig } from "./config.ts";
import { approveExperience, candidateCount, compactExperience, experienceFile, importExperience, readExperienceStore, rejectExperience } from "./experience.ts";
import { cleanupMaterialHistory } from "./materials.ts";
import { registerMiss } from "./misses.ts";
import { materialCleanupLine, materialCleanupNotes } from "./resources.ts";
import { batchInfo, eventReason } from "./events.ts";
import { queryBatches } from "./query.ts";
import { kernelCLI, queryKernelRuns } from "./kernel-cli.ts";
import { paInfo, sendWords } from "./pa.ts";
import { resumeBatch } from "./pa-resume.ts";
import { parseReviewOnlyPlan, runReviewOnly } from "./review-only.ts";
import { stopBatch } from "./stop.ts";
import { runBatchCommand } from "./launch.ts";
import { PIPELINE_MIGRATION } from "./pipeline.ts";

const LOOP_ROOT = dirname(fileURLToPath(import.meta.url));
export class LoopError extends Error {
  data: Record<string, unknown>;
  constructor(message: string, data: Record<string, unknown> = {}) { super(message); this.data = data; }
}
interface ParsedArgs { localOnly?: boolean; release?: string; task?: string; removeTask?: string; node?: string; from?: string; removeNode?: string; acceptUnverified?: boolean; reviewTimeoutMin?: string; base?: string; head?: string; requirement?: string; criteria?: string; note?: string; command?: string; batch?: string; all?: boolean; json: boolean; dryRun: boolean; apply: boolean; recheck: boolean; launcher?: string; round?: number; stage?: string; id?: string; textFile?: string; grantFile?: string; wait?: number; rest: string[] }
export function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = { json: false, dryRun: false, apply: false, recheck: false, rest: [] };
  const values: Record<string, keyof ParsedArgs> = { "--node": "node", "--from": "from", "--remove-node": "removeNode", "--task": "task", "--remove-task": "removeTask", "--release": "release", "--base": "base", "--head": "head", "--requirement": "requirement", "--criteria": "criteria", "--note": "note", "--stage": "stage", "--id": "id", "--text-file": "textFile", "--grant-file": "grantFile", "--launcher": "launcher", "--autoreview-review-timeout-min": "reviewTimeoutMin" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg in values) {
      const key = values[arg], value = argv[++i];
      if (!value || value.startsWith("--") || result[key] !== undefined) throw new LoopError(`${arg} 需要一个值且不能重复`);
      (result as any)[key] = value;
    } else if (arg === "--wait" || arg === "--round") {
      const key = arg === "--wait" ? "wait" : "round", value = Number(argv[++i]);
      if (!Number.isFinite(value) || value < (key === "round" ? 1 : 0) || (key === "round" ? !Number.isSafeInteger(value) : value > 3600) || result[key] !== undefined) throw new LoopError(`${arg} 数值非法或重复`);
      result[key] = value;
    } else if (arg === "--接受未验证") result.acceptUnverified = true;
    else if (arg === "--仅本地") result.localOnly = true;
    else if (arg === "--json") result.json = true;
    else if (arg === "--all") result.all = true;
    else if (arg === "--dry-run") result.dryRun = true;
    else if (arg === "--recheck") result.recheck = true;
    else if (arg === "--apply") result.apply = true;
    else if (["-h", "--help"].includes(arg)) result.command = "帮助";
    else if (arg.startsWith("--")) throw new LoopError(`未知选项：${arg}`);
    else if (!result.command) result.command = arg;
    else if (!result.batch) result.batch = arg;
    else result.rest.push(arg);
  }
  const only = (condition: boolean, allowed: string[], message: string) => { if (condition && !allowed.includes(result.command ?? "")) throw new LoopError(message); };
  only(result.node !== undefined, ["重跑"], "--node 只用于新卡重跑");
  only(result.reviewTimeoutMin !== undefined, ["开工", "启动"], "--autoreview-review-timeout-min 只用于启动；新卡使用独立 limits");
  only([result.from, result.removeNode, result.removeTask].some((v) => v !== undefined), ["改卡"], "--from、--remove-node、--remove-task 只用于新卡改卡");
  only(result.task !== undefined, ["续跑", "重跑", "停止", "整合"], "--task 只用于新卡续跑/重跑/停止/整合");
  only(Boolean(result.localOnly || result.acceptUnverified || result.release !== undefined), ["合入"], "--仅本地、--接受未验证 只用于新卡合入；--release 已停用");
  only(result.stage !== undefined, ["送话", "停止"], "--stage 只用于 loop 送话/历史停止");
  only(result.textFile !== undefined || result.wait !== undefined, ["送话"], "--text-file、--wait 只用于 loop 送话");
  only([result.base, result.head, result.requirement, result.criteria, result.note].some((v) => v !== undefined), ["评审"], "--base、--head、--requirement、--criteria、--note 只用于 loop 评审");
  only(result.grantFile !== undefined, ["续跑"], "--grant-file 只用于 loop 续跑");
  only(result.id !== undefined, ["送话", "续跑"], "--id 只用于 loop 送话/续跑");
  only(result.round !== undefined, ["漏网"], "--round 只用于 loop 漏网");
  only(result.apply, ["清理"], "--apply 只用于 loop 清理");
  if (result.all && (result.command !== "查询" || result.batch)) throw new LoopError("--all 只用于查询，不能同时指定卡");
  if (result.apply && result.dryRun) throw new LoopError("--apply 与 --dry-run 不能同时使用");
  return result;
}

export function cmdCleanup(args: ParsedArgs): Record<string, unknown> {
  if (args.batch || args.rest.length || args.recheck || args.launcher) throw new LoopError("loop 清理不接受批次文件、--recheck 或 --launcher");
  const cleanup = cleanupMaterialHistory({ apply: args.apply });
  const lines = [args.apply ? "按登记瘦身已完成会话（只处理运行材料）" : "预览：不删除、不改写任何文件；加 --apply 才执行",
    ...cleanup.paths.map((path) => `${args.apply ? "已删除" : "将删除"}：${path}`),
    ...cleanup.retained.map((item) => `保留：${item.path}（${item.kind}，不参与清理）`), materialCleanupLine(cleanup), ...materialCleanupNotes(cleanup),
    `完成会话 ${cleanup.sessions.filter((s) => s.phase === "done").length} 个；跳过未完成会话 ${cleanup.sessions.filter((s) => s.phase !== "done").length} 个`];
  return { ok: cleanup.failures.length === 0, command: "清理", dryRun: !args.apply, ...cleanup, lines };
}
export function cmdMiss(args: ParsedArgs): Record<string, unknown> {
  if (!args.batch || args.rest.length !== 3 || args.recheck || args.launcher) throw new LoopError("用法：loop 漏网 <项目目录> <会话ID> <问题描述> <发现方式> [--round N] [--dry-run] [--json]");
  const result = registerMiss({ project: args.batch, session: args.rest[0], defect: args.rest[1], discovery: args.rest[2], round: args.round, dryRun: args.dryRun });
  return { ok: true, command: "漏网", dryRun: args.dryRun, ...result, lines: [args.dryRun ? `预览（未写入）：${result.ledger}` : `已追加漏网记录：${result.ledger}`, `${args.dryRun ? "将生成" : "已生成"}案例草稿：${result.draftPath}`, `轮次：${result.draft.round}；${result.draft.replayReason}`, "未修改原会话状态和总结；未重新评审；草稿须核对后再收入 eval/cases/"] };
}
export function cmdExperience(args: ParsedArgs): Record<string, unknown> {
  const action = args.batch, project = args.rest[0], value = args.rest[1];
  if (!action || !["列出", "导入", "批准", "拒绝"].includes(action) || !project || args.rest.length > 2 || (action === "列出" ? value !== undefined : !value) || args.recheck || args.launcher) throw new LoopError("用法：loop 经验 <列出|导入|批准|拒绝> <项目目录> [候选文件|候选ID|全部] [--dry-run] [--json]");
  const root = findProjectRoot(resolve(project));
  if (!root) throw new LoopError(`项目目录及上级没有 .autoreview.json：${project}`);
  const candidates = action === "列出" ? readExperienceStore(root).candidates.filter((item) => item.status === "pending") : action === "导入" ? importExperience(root, resolve(value!), args.dryRun) : action === "批准" ? approveExperience(root, value!, args.dryRun) : rejectExperience(root, value!, args.dryRun);
  const lines = [`${args.dryRun ? `预览${action}（未写入）` : action}：${root}；${candidates.length} 条`, ...candidates.map((item) => `${compactExperience(item)}\n出现次数：${candidateCount(item)} 个不同开发会话；状态：${item.status}${item.approvedId ? `；写入 ${item.approvedId}` : ""}\n${[...item.metadata, ...item.evidence.map((line) => `证据：${line}`)].join("\n")}`)];
  if (action === "批准" && !args.dryRun) lines.push(`已写入：${experienceFile(root)}；未提交、未推送`);
  return { ok: true, command: "经验", action, project: root, dryRun: args.dryRun, candidates, lines };
}
async function cmdPA(args: ParsedArgs): Promise<Record<string, unknown>> {
  if (args.task) throw new LoopError("PA 编号续跑为批次级，不接受 --task；单任务请用 bin/loop 续跑 <开发卡.json> --task <任务名>，不要附带 --id");
  if (!args.batch || !args.id || args.rest.length || args.launcher || args.recheck || (args.command === "送话" && (!args.stage || !args.textFile))) throw new LoopError("用法：loop 送话 <卡.json> --stage <任务> --id <编号> --text-file <文件|-> [--wait 秒] --json；loop 续跑 <卡.json> --id <编号> --json");
  const info = paInfo(resolve(args.batch));
  const input = (file: string) => () => readFileSync(file === "-" ? 0 : resolve(file), "utf8");
  return args.command === "送话" ? sendWords({ info, stage: args.stage!, id: args.id, readText: input(args.textFile!), wait: args.wait, dryRun: args.dryRun }) : resumeBatch({ info, id: args.id, readGrant: args.grantFile ? input(args.grantFile) : undefined, dryRun: args.dryRun });
}
async function cmdReview(args: ParsedArgs): Promise<Record<string, unknown>> {
  if (args.batch || args.rest.length || !args.base || !args.head || args.recheck || args.launcher) throw new LoopError("用法：loop 评审 --base <提交或分支> --head <提交或分支> [--requirement 文件] [--criteria 文件] [--note 文件] [--json]");
  return runReviewOnly({ repo: process.cwd(), base: args.base, head: args.head, ...(args.requirement ? { requirement: resolve(args.requirement) } : {}), ...(args.criteria ? { criteria: resolve(args.criteria) } : {}), ...(args.note ? { note: resolve(args.note) } : {}) }, { dryRun: args.dryRun });
}
function executionResult(command: string | undefined, result: Record<string, unknown>): Record<string, unknown> {
  if (result.kernel === 1 || !["推送", "合入", "停止"].includes(command ?? "")) return result;
  return { v: 1, action: command, ...result, reason: result.reason ?? eventReason(result.ok === false ? String(result.error ?? "执行失败") : ""), ...(command === "合入" ? { release: null, merged: null, queueStatus: null } : {}), ...(command === "推送" ? { branch: null, remote: "origin", pushed: null } : {}) };
}
const USAGE = `用法：
  bin/loop 接入 <项目目录> [--yes] [--dry-run]
  bin/loop 开发 <pi|claude|codex> [开发参数…]（仅开发评审，不验收、不提交）
  loop 启动 <开发卡.json> [--launcher terminal|background] [--dry-run] [--json]
  loop 状态 [<开发卡.json>] [--json]
  loop 查询 [<卡.json> | --all] --json（历史只读，不恢复旧队列）
  loop 停止 <卡.json> [--task 任务名] [--dry-run] --json
  loop 续跑 <开发卡.json> [--task 任务名] [--launcher terminal|background] [--dry-run] [--json]
  loop 整合 <开发卡.json> [--task 任务名] [--dry-run] [--json]
  loop 合入 <开发卡.json> [--仅本地] [--接受未验证] [--dry-run] [--json]
  loop 重跑 <开发卡.json> --node 开发评审|评审|测试|验收|部署 [--task 任务名] [--dry-run] [--json]
  loop 改卡 <开发卡.json> (--remove-node 测试|验收 | --remove-task 任务名 | --from 替换卡.json) [--dry-run] [--json]
  loop 放弃 <开发卡.json> [--dry-run] [--json]
  loop 评审 --base <提交或分支> --head <提交或分支> [--requirement 文件] [--criteria 文件] [--note 文件] [--json]
  loop 送话 <卡.json> --stage <任务> --id <编号> --text-file <文件|-> [--wait 秒] --json
  loop 续跑 <开发卡.json> --id <编号> [--dry-run] --json（PA 请求去重）
  loop 清理 [--apply | --dry-run] [--json]
  loop 归档问题单 <项目目录> [--dry-run] [--json]
  loop 漏网 <项目目录> <会话ID> <问题描述> <发现方式> [--round N] [--dry-run] [--json]
  loop 经验 <列出|导入|批准|拒绝> <项目目录> [候选文件|候选ID|全部] [--dry-run] [--json]
开发卡 flow：开发评审 → 可选测试 → 可选验收 → 可选提交 → 可选部署。
只评审卡：nature:评审、flow:[评审]、review.base/head；limits.评审.timeoutMin 默认 60；只出报告，禁止合入。
旧开工、stages/workflow/steps、workspaces、独立 accept-cmd、旧队列推送/撤回及 --release 已停用；迁移到新卡和统一合入。`;

/** 额外内部参数不授予执行旧流程的能力。 */
export async function main(argv = process.argv.slice(2), ..._ignored: unknown[]): Promise<number> {
  let args: ParsedArgs | undefined;
  try {
    args = parseArgs(argv);
    if (!args.command || args.command === "帮助") { console.error(USAGE); return 2; }
    if (args.release !== undefined) throw new LoopError("旧队列 --release 改目标已停用；请使用 bin/loop 合入 <开发卡.json>，只处理既定 dev；不发布任意目标、不碰 main");
    if (["开工", "推送", "撤回"].includes(args.command)) throw new LoopError(PIPELINE_MIGRATION + " 发布请用 bin/loop 合入 <开发卡.json>（可加 --仅本地）；不推任务/批次分支。");
    let result: Record<string, any> | undefined;
    if (args.command === "启动" && args.batch) {
      const file = resolve(args.batch), raw = JSON.parse(readFileSync(file, "utf8"));
      if (raw?.recipe === "review-only") {
        const plan = parseReviewOnlyPlan(raw, dirname(file));
        const configOverrides = { reviewTimeoutMin: args.reviewTimeoutMin };
        const effectiveConfig = resolveProjectConfig(findProjectRoot(plan.review.repo), configOverrides).effectiveConfig;
        if (args.dryRun) result = await runReviewOnly(plan.review, { file, name: plan.name, dir: plan.dir, dryRun: true, configOverrides });
        else {
          const run = await runBatchCommand(batchInfo(file, plan.review.repo, plan.dir), null, process.execPath, [join(LOOP_ROOT, "review-only.ts"), file], { cwd: process.cwd(), capture: true, env: { ...process.env, ...(args.reviewTimeoutMin !== undefined ? { AUTOREVIEW_REVIEW_TIMEOUT_MIN: String(effectiveConfig.reviewTimeoutMin.value) } : {}) } });
          if (!run.stdout.trim()) throw new Error(`评审启动失败：${run.stderr || run.error}`);
          result = { ...JSON.parse(run.stdout), ...(args.reviewTimeoutMin !== undefined ? { effectiveConfig } : {}) };
        }
      }
    }
    if (!result && args.command === "续跑" && args.id) result = await cmdPA(args);
    if (!result) result = await kernelCLI(args);
    if (!result) {
      if (args.command === "评审") result = await cmdReview(args);
      else if (args.command === "停止") {
        if (!args.batch || args.rest.length || args.recheck || args.launcher) throw new LoopError("用法：loop 停止 <历史批次.json> [--stage 段] --json");
        result = await stopBatch(resolve(args.batch), { stage: args.stage, dryRun: args.dryRun });
      } else if (args.command === "查询" || args.command === "状态") {
        if (args.rest.length || args.recheck || args.launcher) throw new LoopError("用法：loop 查询 [<卡.json> | --all] --json");
        const history = queryBatches(args.batch);
        result = args.batch ? history : { ...history, batches: [...queryKernelRuns(), ...history.batches] };
      } else if (args.command === "送话") result = await cmdPA(args);
      else if (["启动", "续跑", "合入", "整合"].includes(args.command)) throw new LoopError(PIPELINE_MIGRATION);
      else if (args.command === "清理") result = cmdCleanup(args);
      else if (args.command === "漏网") result = cmdMiss(args);
      else if (args.command === "经验") result = cmdExperience(args);
      else if (args.command === "归档问题单") {
        if (!args.batch || args.rest.length) throw new LoopError("用法：loop 归档问题单 <项目目录> [--dry-run] [--json]");
        result = (await import("./issue-archive.ts")).archiveResolvedIssues(resolve(args.batch), args.dryRun);
      } else throw new LoopError(`未知子命令：${args.command}\n${USAGE}`);
    }
    result = executionResult(args.command, result);
    console.log(args.json ? JSON.stringify(result, null, 2) : Array.isArray(result.lines) && result.lines.length ? result.lines.join("\n") : JSON.stringify(result, null, 2));
    return typeof result.exitCode === "number" ? result.exitCode : result.ok === false ? 1 : 0;
  } catch (error) {
    const message = (error as Error).message;
    const result = executionResult(args?.command ?? argv[0], { ok: false, command: args?.command ?? argv[0], dryRun: args?.dryRun ?? argv.includes("--dry-run"), error: message, ...(error instanceof LoopError ? error.data : {}) });
    if (args?.json ?? argv.includes("--json")) console.log(JSON.stringify(result, null, 2)); else console.error(`loop: ${message}`);
    return args?.command === "评审" ? 2 : 1;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().then((code) => { process.exitCode = code; });
