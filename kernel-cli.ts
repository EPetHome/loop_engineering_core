/** 新卡统一 CLI。旧引擎继续内部保留，但启动旧卡必须给迁移提示。 */
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { contributionProblems, createKernelRun, qualification, queryKernel } from "./kernel.ts";
import { findUserDecision, kernelRoot, ledgerPath, readRun } from "./node-ledger.ts";
import { abandonKernel, integrateKernel, launchKernel, releaseKernelWorkspace, resumeManaged, settleTaskRemoval, stopKernel } from "./kernel-runtime.ts";
import { mergeManaged, recordManagedUserInput } from "./kernel-session.ts";
import { gitResult } from "./workspace.ts";
import { controlSource, requestCardChange } from "./kernel-controls.ts";
import { prepareExceptionCandidate } from "./batch-integration.ts";

interface Args { task?: string; removeTask?: string; node?: string; from?: string; removeNode?: string; reviewTimeoutMin?: string; recheck?: boolean; command?: string; batch?: string; dryRun: boolean; json: boolean; acceptUnverified?: boolean; launcher?: string; rest: string[]; stage?: string; id?: string; all?: boolean }
export function findKernelLedger(file: string, cwd = process.cwd()): string | undefined {
  const probe = gitResult(dirname(resolve(file)), ["rev-parse", "--show-toplevel"]);
  try {
    const path = ledgerPath(probe.status === 0 ? probe.stdout.trim() : cwd, file);
    return existsSync(path) ? path : undefined;
  } catch { return undefined; }
}
export function queryKernelRuns(): Record<string, any>[] {
  const root = join(kernelRoot(), "runs"), results: Record<string, any>[] = [];
  if (!existsSync(root)) return results;
  for (const repo of readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory())) {
    for (const card of readdirSync(join(root, repo.name), { withFileTypes: true }).filter((d) => d.isDirectory())) {
      const path = join(root, repo.name, card.name, "ledger.json");
      if (!existsSync(path)) continue;
      try { results.push(queryKernel(path)); } catch (error) { results.push({ ok: false, kernel: 1, ledger: path, status: "等你决定", reason: String(error) }); }
    }
  }
  return results;
}
function ttyDecision(path: string): ReturnType<typeof recordManagedUserInput> {
  // 机器管道不能把卡内授权/命令参数当用户决定。真实 TTY 显示候选与欠项后要求随机确认。
  if (!process.stdin.isTTY) return undefined;
  let fd: number | undefined;
  try {
    fd = openSync("/dev/tty", "r+");
    prepareExceptionCandidate(path);
    const run = readRun(path), checked = qualification(run), challenge = randomUUID().slice(0, 8);
    if (!checked.candidate || !checked.inputs) throw new Error("候选/检查输入无法冻结，不能接受例外");
    const shown = { candidate: checked.candidate, inputs: checked.inputs, userVersion: run.userVersion, missing: checked.missing };
    writeSync(fd, `任务 ${run.card.name}/${run.card.tasks.map((t) => t.name).join("、")}\n候选 ${shown.candidate.commit}/${shown.candidate.tree}\n检查输入 ${shown.inputs}；用户版本 ${shown.userVersion}\n本次冻结欠项：\n${shown.missing.join("\n") || "无前置欠项"}\n未通过/没验证仍原样保留，不改写结论\n接受以上候选与逐项欠项请输入「合入 ${challenge}」：`);
    const buffer = Buffer.alloc(1), bytes: number[] = [];
    while (bytes.length < 200 && readSync(fd, buffer, 0, 1, null)) { if (buffer[0] === 10) break; bytes.push(buffer[0]); }
    const text = Buffer.from(bytes).toString("utf8").trim(); // 读完后一次解码，不能逐字节破坏中文。
    if (text !== `合入 ${challenge}`) throw new Error("用户未确认，未合入");
    return recordManagedUserInput(path, text, "terminal:tty", undefined, shown);
  } finally { if (fd !== undefined) closeSync(fd); }
}
export async function kernelCLI(args: Args, cwd = process.cwd()): Promise<Record<string, any> | undefined> {
  const command = args.command;
  if (!command || !["启动", "状态", "查询", "停止", "续跑", "整合", "合入", "重跑", "改卡", "放弃"].includes(command)) return undefined;
  if (!args.batch) {
    if (command === "状态") {
      const batches = queryKernelRuns();
      return { ok: true, kernel: 1, batches, lines: batches.length ? batches.flatMap((b) => b.lines ?? [b.reason]) : ["没有新卡内核登记；旧版历史使用 loop 查询 --all --json（不恢复旧队列）"] };
    }
    if (["重跑", "改卡", "放弃"].includes(command)) throw new Error(`${command} 需要已登记的开发卡路径`);
    return undefined;
  }
  const file = resolve(args.batch), path = findKernelLedger(file, cwd);
  // 启动始终先校验新版，不允许旧批次偷偷回退；其余旧历史命令暂保留。
  if (command !== "启动" && !path) {
    if (args.task) throw new Error("--task 只用于已登记的新开发卡；未回退旧引擎或停止旧批次");
    if (["重跑", "改卡", "放弃"].includes(command)) throw new Error("开发卡尚未登记，未调用旧引擎");
    if (existsSync(file)) {
      let raw: any; try { raw = JSON.parse(readFileSync(file, "utf8")); } catch { /* 明确新卡文件名仍不能回退旧路径 */ }
      if (file.endsWith("/开发卡.json") || raw && ["version", "nature", "tasks", "flow"].some((k) => Object.hasOwn(raw, k))) {
        return { ok: false, kernel: 1, status: "等你决定", reason: "开发卡尚未登记，没有可合入候选；请先启动开发卡", lines: ["开发卡尚未登记；没有调用旧引擎、创建资源或启动检查"] };
      }
    }
    if (args.acceptUnverified) throw new Error("受控例外只接受已登记的新开发卡，不能豁免旧引擎保护");
    return undefined;
  }
  if (args.rest.length || args.stage || args.id) throw new Error("新开发卡不接受旧段、PA 续跑编号或额外位置参数");
  if (args.task && !["续跑", "重跑", "停止", "整合"].includes(command)) throw new Error("--task 仅用于续跑/重跑/停止/整合");
  if (args.reviewTimeoutMin !== undefined || args.recheck) throw new Error("新卡不采用旧批次预算/重检开关；开发评审限额须写在 limits.开发评审");
  if (args.launcher && !["启动", "续跑", "重跑"].includes(command)) throw new Error("新卡 --launcher 只用于启动/续跑/重跑");
  if (args.launcher && args.launcher !== "background") throw new Error("新卡默认在当前终端前台启动；后台可用 --launcher background，不经过终端长文本粘贴");
  if (command === "启动") {
    const result = createKernelRun(file, cwd, args.dryRun);
    if (args.dryRun) return { ok: true, kernel: 1, dryRun: true, lines: result.lines };
    return { ...await launchKernel(result.path, args.json || args.launcher === "background"), command };
  }
  if (!path) throw new Error("没有内核登记");
  if (["状态", "查询"].includes(command)) return { ...queryKernel(path), command };
  if (command === "停止") return { ...await stopKernel(path, args.dryRun, args.task), command };
  if (command === "整合") return { ...await integrateKernel(path, args.dryRun, args.task), command };
  if (command === "放弃") return { ...await abandonKernel(path, controlSource(), args.dryRun), command };
  if (command === "改卡") {
    let change = requestCardChange(path, { removeTask: args.removeTask, removeNode: args.removeNode, from: args.from ? resolve(args.from) : undefined, source: controlSource(), dryRun: args.dryRun });
    if (!args.dryRun && change.removeTasks?.length) { await settleTaskRemoval(path); change = readRun(path).changes!.find((c) => c.id === change.id)!; }
    if (args.dryRun || readRun(path).changes?.find((c) => c.id === change.id)?.state !== "applied") return { ...queryKernel(path), command, change, dryRun: args.dryRun };
    const r = readRun(path);
    if (r.workerRequest) return { ...queryKernel(path), command, change, dispatched: r.workerRequest, lines: ["改卡已应用，原登记 worker 在边界接续新卡", ...queryKernel(path).lines] };
    const candidate = r.candidate;
    if (!candidate || qualification(r).missing.some((s) => s.includes("/ 开发评审 /"))) return { ...queryKernel(path), command, change };
    const next = await resumeManaged(path, true, change.removeTasks?.length ? "验收" : r.taskRecords ? undefined : r.card.flow.includes("测试") ? "测试" : undefined);
    return { ...next, command, change };
  }
  if (command === "续跑" || command === "重跑") {
    if (command === "重跑" && !args.node) throw new Error("重跑需要 --node 开发评审|测试|验收");
    return { ...await resumeManaged(path, args.json || args.launcher === "background", args.node, args.dryRun, args.task), command };
  }
  const run = readRun(path);
  const q = qualification(run);
  const currentDecision = contributionProblems(run, false).length ? undefined : findUserDecision(run, q.candidate, q.inputs, q.missing);
  const decision = args.acceptUnverified && !args.dryRun ? currentDecision ?? ttyDecision(path) : undefined;
  const output = await mergeManaged(path, { accept: args.acceptUnverified, decision, dryRun: args.dryRun });
  if (!args.dryRun && readRun(path).publication?.local === "merged") await releaseKernelWorkspace(path);
  return { ...queryKernel(path), ok: output.status === "通过", command, outcome: output, dryRun: args.dryRun };
}
