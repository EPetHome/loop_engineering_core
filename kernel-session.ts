/** 入口装配：固定开发评审/提交执行器；Pi、宿主 Hook 与 CLI 使用同一账本和状态。 */
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { typedByUser } from "./acceptance-core.ts";
import { classifyMarker } from "./core.ts";
import { digest } from "./development-card.ts";
import { checkInputs, deliverCandidate, frozenCardProblem } from "./kernel-workspace.ts";
import { currentCandidate, executeNode, qualification, queryKernel, writeKernelSummary, type NodeOutput } from "./kernel.ts";
import { activityAlive, findUserDecision, kernelRoot, readRun, updateRun, type UserDecision } from "./node-ledger.ts";
import { reviewDevelopment } from "./development-node.ts";
import { submitCandidate } from "./submission-node.ts";
import { appendLedgerRecord, appendMergeRecord } from "./ledger.ts";
import { systemNotify } from "./notify.ts";
import { processStartTime, readProcs } from "./procs.ts";
import type { Exec } from "./git.ts";
import type { ReviewerCall } from "./static-review.ts";

export const MANAGED_CONVENTION = ["【Loop 受管单任务】", "开发评审是一个原子节点；修复仍在本会话。最后一行写【交付完成】；需要用户决定写【需要你决定】。",
  "不要自行 git add/commit/merge/push；交付边界由程序仅提交卡上范围内改动。不要暂存本机文件或用户既有改动。",
  "自行做必要的定向自检，不跑全量；Loop 不运行卡外测试、验收、部署。测试和验收：没验证（本次未安排）。"].join("\n");

export function managedLedger(cwd: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const path = env.AUTOREVIEW_KERNEL_LEDGER;
  if (!path) return undefined;
  const run = readRun(path);
  if (run.id !== env.AUTOREVIEW_KERNEL_RUN || realpathSync(cwd) !== run.worktree || run.release.status === "已释放") throw new Error("受管任务身份不符，拒绝采用用户工作区");
  return path;
}
export function attachSession(path: string, host: "pi" | "claude" | "codex", id: string, log?: string): void {
  if (!id.trim() || id === "unknown" || /[\0\r\n]/.test(id)) throw new Error("宿主没有可精确恢复的会话身份，未认领任务");
  updateRun(path, (r) => {
    if (r.stopped || r.abandoned) throw new Error("本任务已停止；需显式续跑");
    if (r.session?.id && r.session.id !== id) throw new Error("不允许新会话冒充原开发会话；请精确恢复原 ID");
    const owner = host !== "pi" && r.launch ? { pid: r.launch.pid, started: r.launch.processStarted } : { pid: process.pid, started: processStartTime(process.pid) };
    r.session = { host, id, log, ...owner, launchId: process.env.AUTOREVIEW_KERNEL_LAUNCH };
    r.activity = undefined; // 会话启动/存活不等于节点仍在执行。
  });
}
export function developerActive(path: string): void {
  updateRun(path, (r) => {
    if (r.stopped || r.publication || r.abandoned) throw new Error("任务已停止或已发布，不再自动开发");
    const problem = frozenCardProblem(r); if (problem) throw new Error(problem);
    checkInputs(r); // 进入开发/返修边界也不能静默采用未重新确认的引用内容。
    r.activity = { id: randomUUID(), node: "开发评审", kind: "developing", pid: r.session?.pid ?? process.pid, started: r.session?.started ?? processStartTime(process.pid), session: r.session?.id };
    r.stopReason = undefined;
  });
}
export function pauseManaged(path: string, reason: string): void {
  updateRun(path, (r) => { r.activity = undefined; r.stopReason = reason; r.stopped = true; });
  writeKernelSummary(path);
}
/** 仅适配层已核对来源为 interactive/rpc 或宿主 UserPromptSubmit 时调用；机器消息/文件块不授权。 */
export function recordManagedUserInput(path: string, raw: string, source: string, materials?: { text: string; files: { path: string; text: string }[] }, shown?: Pick<UserDecision, "candidate" | "inputs" | "userVersion" | "missing">): UserDecision | undefined {
  const text = typedByUser(raw).trim();
  if (!text || !["pi:interactive", "pi:rpc", "claude:UserPromptSubmit", "codex:UserPromptSubmit", "terminal:tty"].includes(source)) return undefined;
  const run = readRun(path);
  const merge = new RegExp(`^合入(?:本批|这批|[「"']?${run.card.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[」"']?)(?:\\s*(?:--接受未验证|接受未验证|按现状))?[。！!\\s]*$`);
  if (merge.test(text) || source === "terminal:tty" && /^合入 [0-9a-f]{8}$/.test(text)) {
    const q = qualification(run), candidate = currentCandidate(run);
    if (!q.inputs) throw new Error("检查输入无法冻结，修复输入后才能确认例外合入");
    if (shown && (candidate.commit !== shown.candidate.commit || candidate.tree !== shown.candidate.tree || q.inputs !== shown.inputs
      || run.userVersion !== shown.userVersion || JSON.stringify(q.missing) !== JSON.stringify(shown.missing))) throw new Error("确认期间候选、标准或用户版本变化，请按当前内容重新确认");
    const decision: UserDecision = { id: randomUUID(), at: new Date().toISOString(), source, text, candidate, inputs: q.inputs, userVersion: run.userVersion, missing: q.missing };
    updateRun(path, (r) => {
      const current = currentCandidate(r);
      if (r.userVersion !== decision.userVersion || checkInputs(r).hash !== decision.inputs || current.commit !== candidate.commit || current.tree !== candidate.tree) throw new Error("用户决定期间候选或输入变化");
      r.decisions.push(decision);
    });
    writeKernelSummary(path); return decision;
  }
  // 普通新输入撤销旧检查资格；不清零返修计数。机器原会话返修不走这里。
  updateRun(path, (r) => {
    r.userVersion += 1; r.userInputs.push(materials?.text ?? raw);
    r.userFiles = [...new Set([...(r.userFiles ?? []), ...(materials?.files ?? []).map((f) => resolve(r.worktree, f.path))])];
    for (const file of materials?.files ?? []) (r.userFileVersions ??= {})[resolve(r.worktree, file.path)] = digest(Buffer.from(file.text, "utf8"));
    r.stopReason = "真实用户输入更新，需按当前输入重新交付";
  });
  return undefined;
}
export async function mergeManaged(path: string, options: { accept?: boolean; decision?: UserDecision; automatic?: boolean; dryRun?: boolean } = {}): Promise<NodeOutput> {
  const run = readRun(path), q = qualification(run);
  if (run.publication) return { status: run.publication.push === "成功" ? "通过" : "没验证", reason: `本地发布记录已存在；推送 ${queryKernel(path).publication?.push}，不自动重试。${run.publication.reason ?? ""}`, evidence: [], operations: [], released: true };
  // 例外只豁免缺少结论；卡、候选、目标、资源身份始终不能豁免。
  if (!q.candidate) throw new Error(`合入身份核对失败：\n${q.missing.join("\n")}`);
  currentCandidate(run);
  const cardProblem = frozenCardProblem(run); if (cardProblem) throw new Error(cardProblem);
  if (run.abandoned || run.activity && activityAlive(run.activity) !== false) throw new Error("还有节点活动、归属未确认或任务已放弃，未合入；先停止并确认资源");
  const procs = join(run.dir, "review.procs.json");
  if (existsSync(procs)) {
    const raw = JSON.parse(readFileSync(procs, "utf8"));
    if (!Array.isArray(raw) || raw.length || readProcs(procs).length) throw new Error("评审消费者释放未确认，不能合入；请先用统一停止入口核对并释放登记进程");
  }
  if (q.missing.length && !options.accept) throw new Error(`普通合入被拒绝：\n${q.missing.join("\n")}`);
  if (options.automatic && options.accept) throw new Error("自动调度禁止接受未验证");
  const decision = findUserDecision(run, q.candidate, q.inputs, q.missing, options.decision?.id);
  if (options.dryRun) return { status: q.missing.length ? "没验证" : "通过", reason: "只读核对，未发布；例外执行仍须真实用户决定", evidence: [], operations: q.missing, released: true };
  if (options.accept && !decision) throw new Error("没有绑定本候选与逐项欠项的真实用户决定；请在原会话亲手输入「合入本批」，或在交互终端确认统一命令；卡/提示词/机器消息不算授权");
  updateRun(path, (r) => {
    if (r.userVersion !== run.userVersion || checkInputs(r).hash !== q.inputs) throw new Error("合入交接前检查输入或用户决定已变化");
    r.stopped = false; r.stopReason = undefined; if (r.activity && activityAlive(r.activity) === false) r.activity = undefined;
  }); // 停止不是放弃，允许显式发布已登记候选。
  const result = await executeNode(path, "提交", (input) => submitCandidate(input, options.accept ? decision : undefined));
  const published = readRun(path).publication;
  if (published?.local === "merged") {
    try { appendMergeRecord({ project: run.repo, batch: run.card.name, entry: `${run.id}:${published.commit}`, commit: published.commit, file: run.file, manual: [],
      notes: [`候选树：${published.tree}`, `推送 origin/dev：${published.push}；${published.reason ?? ""}`, "测试、验收：没验证（本次未安排）",
        ...(options.accept && decision ? [`用户接受未验证：${decision.source}；${decision.at}；${decision.text}`, ...decision.missing] : [])] }, process.env.AUTOREVIEW_KERNEL_ROOT ? join(kernelRoot(), "交付记录.md") : undefined); }
    catch (error) { updateRun(path, (r) => { (r.notes ??= []).push(`合入索引写入失败：${String(error)}`); }); }
  }
  writeKernelSummary(path); return result;
}
export async function completeManagedDelivery(path: string, text: string, options: { exec: Exec; signal?: AbortSignal; callReviewer?: ReviewerCall }): Promise<NodeOutput> {
  let run = readRun(path);
  if (run.stopped || run.abandoned || run.publication || run.activity && ["reviewing", "submitting"].includes(run.activity.kind)) return { status: "中断", reason: run.stopReason ?? "任务已停止、已发布或已有检查执行", evidence: [], operations: [], released: true };
  if (classifyMarker(text) === "decision") { pauseManaged(path, "开发方需要你决定"); return { status: "中断", reason: "开发方需要你决定", evidence: [], operations: [], released: true }; }
  try {
    const candidate = deliverCandidate(run);
    updateRun(path, (r) => { if (r.userVersion !== run.userVersion || r.stopped) throw new Error("交付期间输入或停止状态变化"); r.candidate = candidate; r.activity = undefined; });
    writeFileSync(join(run.dir, "delivery.md"), text);
    const output = await executeNode(path, "开发评审", (input) => reviewDevelopment(input, options));
    if (output.stale) return output;
    const handoff = updateRun(path, (r) => {
      if (r.userVersion !== run.userVersion || r.activity || r.stopped || r.candidate?.tree !== candidate.tree) return false;
      if (output.message) r.repairs += 1;
      else if (output.status !== "通过") { r.stopped = true; r.stopReason = output.reason ?? output.status; }
      return true;
    });
    if (!handoff) return { ...output, status: "中断", reason: "交接前输入或活动变化，旧执行不再推进", message: undefined, stale: true };
    run = readRun(path);
    if (output.status === "通过" && run.card.flow.includes("提交")) await mergeManaged(path, { automatic: true });
    writeKernelSummary(path);
    if (!output.message) {
      const q = queryKernel(path);
      try { appendLedgerRecord({ project: run.repo, session: run.id, task: run.card.name, result: `${q.status}；${q.reason}`, summary: join(run.dir, "summary.md"),
        checks: { test: "没验证（本次未安排）", review: output.status, acceptance: "没验证（本次未安排）" }, pending: [] }, process.env.AUTOREVIEW_KERNEL_ROOT ? join(kernelRoot(), "交付记录.md") : undefined); }
      catch (error) { updateRun(path, (r) => { (r.notes ??= []).push(`交付索引写入失败：${String(error)}`); }); }
    }
    if (!output.message) await systemNotify("Loop 单任务", queryKernel(path).lines.join("\n"));
    return output;
  } catch (error) {
    const current = readRun(path);
    if (current.userVersion === run.userVersion && (!current.activity || current.activity.id === run.activity?.id)) pauseManaged(path, String(error));
    return { status: "中断", reason: String(error), evidence: [], operations: [], released: false };
  }
}
