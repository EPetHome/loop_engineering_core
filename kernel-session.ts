/** 入口装配：固定开发评审/提交执行器；Pi、宿主 Hook 与 CLI 使用同一账本和状态。 */
import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { authorizationHint, authorizationStatus, forUser, grantsFromUser, typedByUser, type UserPromptProvenance } from "./acceptance-core.ts";
import { classifyMarker } from "./core.ts";
import { digest } from "./development-card.ts";
import { acceptanceBasis, acceptanceSignature, checkInputs, deliverCandidate, dirtyPaths, frozenCardProblem, nativePiOwnerConfirmed, reusedAcceptanceItems, taskAcceptanceInputs } from "./kernel-workspace.ts";
import { contributionProblems, currentCandidate, executeNode, kernelCommand, nodeCheckLines, qualification, queryKernel, writeKernelSummary, type NodeOutput } from "./kernel.ts";
import { activityAlive, confirmedConsumerRelease, findUserDecision, kernelRoot, readRun, readTaskRun, taskDefinition, taskIdentity, taskIds, taskView, updateRun, updateTaskRun, type KernelRun, type UserDecision } from "./node-ledger.ts";
import { reviewDevelopment } from "./development-node.ts";
import { submitCandidate } from "./submission-node.ts";
import { appendLedgerRecord, appendMergeRecord } from "./ledger.ts";
import { systemNotify } from "./notify.ts";
import { ownedProcessGroupAlive, processStartTime, readProcs } from "./procs.ts";
import type { Exec } from "./git.ts";
import type { ReviewerCall } from "./static-review.ts";
import { runTestNode } from "./test-node.ts";
import { applyPendingCardChange, recordCardControl } from "./kernel-controls.ts";
import { createChildExec } from "./hosts/review-hook.ts";
import { consumerProblem, readLocalQueue } from "./local-node-queue.ts";
import { validResult } from "./node-ledger.ts";
import { integrateTask, prepareExceptionCandidate } from "./batch-integration.ts";
import { gitText } from "./workspace.ts";
import { runAcceptanceNode } from "./acceptance-node.ts";
import { runReviewNode } from "./review-node.ts";
import { deploymentUncertainty, runDeploymentNode } from "./deployment-node.ts";

export const MANAGED_CONVENTION = ["【Loop 受管开发任务】", "开发评审是一个原子节点；修复仍在本会话。最后一行写【交付完成】；需要用户决定写【需要你决定】。",
  "不要自行 git add/commit/merge/push；交付边界由程序仅提交卡上范围内改动。不要暂存本机文件或用户既有改动。",
  "自行做必要的定向自检，不跑全量；Loop 不运行卡外测试、验收、部署。只有卡上安排的测试才由程序执行；机器返修不得自行移除必需测试，改卡必须记录来源并保留用户决定。"].join("\n");

export function managedLedger(cwd: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const path = env.AUTOREVIEW_KERNEL_LEDGER;
  if (!path) return undefined;
  const run = readTaskRun(path, env.AUTOREVIEW_KERNEL_TASK);
  if (run.taskRecords && !run.taskId) throw new Error("多任务宿主缺少显式 AUTOREVIEW_KERNEL_TASK");
  const releasedPublication = run.release.status === "已释放" && run.publication?.local === "merged";
  const actual = releasedPublication && !existsSync(cwd) ? resolve(cwd) : realpathSync(cwd);
  if (run.id !== env.AUTOREVIEW_KERNEL_RUN || actual !== run.worktree || run.release.status === "已释放" && !releasedPublication) throw new Error("受管任务身份不符，拒绝采用用户工作区");
  return path;
}
export function attachSession(path: string, host: "pi" | "claude" | "codex", id: string, log?: string, task?: string): void {
  if (!id.trim() || id === "unknown" || /[\0\r\n]/.test(id)) throw new Error("宿主没有可精确恢复的会话身份，未认领任务");
  updateTaskRun(path, task, (r) => {
    if (r.card.nature === "评审" || r.publication) throw new Error("只评审/已发布任务不启动开发宿主；仅查询或接续已安排部署");
    if (r.stopped || r.abandoned) throw new Error("本任务已停止；需显式续跑");
    if (r.session?.id && r.session.id !== id) throw new Error("不允许新会话冒充原开发会话；请精确恢复原 ID");
    const owner = host !== "pi" && r.launch ? { pid: r.launch.pid, started: r.launch.processStarted } : { pid: process.pid, started: processStartTime(process.pid) };
    r.session = { host, id, log, ...owner, launchId: process.env.AUTOREVIEW_KERNEL_LAUNCH };
    if (r.activity?.kind === "starting") r.activity = undefined; // 不覆盖正在排队/执行的其他节点。
  });
}
export function prepareManagedContinuation(path: string, task?: string): void {
  updateTaskRun(path, task, (r) => {
    if (!r.session) return;
    const previous = r.repair;
    if (previous && previous.state !== "read" && previous.userVersion === r.userVersion && previous.epoch === (r.epoch ?? 0)
      && previous.candidate.tree === r.candidate?.tree && previous.inputs === checkInputs(r, previous.node === "测试" ? "测试" : "开发评审").hash) return;
    const context = previous && !previous.message.startsWith("【Loop 开发续跑】") ? `\n\n上次原会话返修上下文（历史次数保留，不重放检查动作）：\n${previous.message}` : "";
    const id = randomUUID(), token = randomUUID(), message = `【Loop 开发续跑】[${id}:${token}]\n继续本原会话的冻结任务 ${taskDefinition(r).name}，保留未提交成果、标准/授权及全部历史次数。不是新用户授权；不要自行提交/合入。完成后写【交付完成】。${context}`;
    const file = join(r.dir, `continue-${id}.md`); writeFileSync(file, message, { mode: 0o600, flag: "wx" });
    r.repair = { id, token, taskId: r.taskId, node: "开发评审", attempt: id, candidate: r.candidate!, inputs: checkInputs(r, "开发评审").hash, userVersion: r.userVersion, epoch: r.epoch ?? 0,
      session: r.session.id, host: r.session.host, message, hash: digest(message), file, state: "pending", at: new Date().toISOString() };
  });
}
/** 同一账本的释放事实也约束停止后的开发/派工；枚举状态不能覆盖未结清票据或检出。 */
export function managedReleaseProblem(path: string, run: KernelRun, reconciling = false): string | undefined {
  if (!reconciling && (run.release.status === "未确认" || !run.taskId && run.taskRecords?.some((t) => !t.removed && t.release.status === "未确认"))) return "资源释放未确认；请核对原消费者和释放回执，停止不是释放证明";
  const all = !!run.taskRecords && !run.taskId, identity = all ? undefined : taskIdentity(run);
  const ticket = readLocalQueue().items.find((t) => t.ledger === path && t.run === run.id && (all || t.task === identity));
  if (ticket) return `资源释放未确认；本机票据 ${ticket.id} 尚未结清：${ticket.reason ?? ticket.state}`;
  const checkout = run.testWorkspaces?.find((e) => e.state !== "released" && (all || e.task === run.taskId));
  if (checkout) return `资源释放未确认；隔离检出保留：${checkout.path}；${checkout.reason ?? checkout.state}`;
  const missing = run.results.find((r) => (all || r.task === identity) && !r.released && !confirmedConsumerRelease(run, r.id));
  if (missing) return `资源释放未确认；尝试 ${missing.id} 缺少执行器回执或已登记消费者的实际释放证明`;
  for (const dir of [run.dir, ...(all ? (run.taskRecords ?? []).filter((t) => !t.removed).map((t) => t.dir) : [])]) {
    const root = join(dir, "attempts"); if (!existsSync(root)) continue;
    for (const entry of readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && /^[0-9a-f-]{36}$/.test(e.name))) {
      if (run.results.some((r) => r.id === entry.name) || confirmedConsumerRelease(run, entry.name)) continue;
      try { const request = JSON.parse(readFileSync(join(root, entry.name, "attempt.json"), "utf8")); if (request.invoked === false) continue; }
      catch { /* 请求/调用回执缺失也是具体未结项，不凭所有者退出核销。 */ }
      return `资源释放未确认；尝试 ${entry.name} 缺少调用结束/消费者释放回执`;
    }
  }
  const pending = [...(run.consumerReleases ?? []), ...(all ? (run.taskRecords ?? []).flatMap((t) => t.consumerReleases ?? []) : [])].find((r) => !r.confirmed);
  return pending ? `资源释放未确认；尝试 ${pending.attempt} 的原消费者仍待核对` : undefined;
}
export function developerActive(path: string, task?: string): void {
  updateTaskRun(path, task, (r) => {
    if (r.card.nature === "评审") throw new Error("只评审不允许开发、返修或修改候选");
    if (r.stopped || r.publication || r.abandoned) throw new Error("任务已停止或已发布，不再自动开发");
    const releaseProblem = managedReleaseProblem(path, r); if (releaseProblem) throw new Error(releaseProblem);
    if (r.blockedNode === "验收" && r.acceptanceState?.plan?.repairTasks.includes(taskIdentity(r))) throw new Error("验收返修等待真实用户提高本任务额度并续跑、移出或放弃；不能用开启开发绕过额度记账");
    if (r.activity && !["starting", "developing"].includes(r.activity.kind) && activityAlive(r.activity) !== false) throw new Error("测试/检查仍执行或归属未确认，停止并确认释放后才能编辑源码");
    const problem = frozenCardProblem(r); if (problem) throw new Error(problem);
    checkInputs(r); // 进入开发/返修边界也不能静默采用未重新确认的引用内容。
    r.activity = { id: randomUUID(), node: "开发评审", kind: "developing", pid: r.session?.pid ?? process.pid, started: r.session?.started ?? processStartTime(process.pid), session: r.session?.id };
    r.stopReason = undefined;
  });
}
export function pauseManaged(path: string, reason: string, task?: string): void {
  updateTaskRun(path, task, (r) => { r.activity = undefined; r.stopReason = reason; r.stopped = true; r.epoch = (r.epoch ?? 0) + 1; });
  writeKernelSummary(path);
}
export function managedMergeRequest(run: KernelRun, raw: string): boolean {
  return new RegExp(`^合入(?:本批|这批|[「"']?${run.card.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[」"']?)(?:\\s*(?:--接受未验证|接受未验证|按现状))?[。！!\\s]*$`).test(typedByUser(raw).trim());
}
/** 仅适配层已核对来源为 interactive/rpc 或宿主 UserPromptSubmit 时调用；机器消息/文件块不授权。 */
export function recordManagedUserInput(path: string, raw: string, source: string, materials?: { text: string; files: { path: string; text: string }[] }, shown?: Pick<UserDecision, "candidate" | "inputs" | "userVersion" | "missing">, task?: string, provenance: UserPromptProvenance = {}): UserDecision | undefined {
  if (consumeManagedRepair(path, raw, materials, task)) return undefined;
  const known = [readRun(path).repair, ...(readRun(path).taskRecords ?? []).map((t) => t.repair)].filter(Boolean);
  const envelope = known.find((e) => raw.startsWith(`${e!.message}\n`) || raw.startsWith(`<cross-session-message>\n${e!.message}\n</cross-session-message>\n`));
  const genuine = envelope ? raw.slice(raw.startsWith("<cross-session-message>") ? `<cross-session-message>\n${envelope.message}\n</cross-session-message>\n`.length : envelope.message.length + 1) : raw;
  const invalidEnvelope = !envelope && /^(?:<cross-session-message>\n)?【Loop (?:(?:测试|验收|集成)返修|开发续跑)】/.test(raw); // 不伪报已读；真实入口原文仍记新输入，但伪信封正文不授予权限。
  const text = typedByUser(genuine, provenance).trim();
  if (!text || !["pi:interactive", "pi:rpc", "claude:UserPromptSubmit", "codex:UserPromptSubmit", "terminal:tty"].includes(source)) return undefined;
  if (recordCardControl(path, text, source)) return undefined;
  let run = readRun(path);
  if (managedMergeRequest(run, text) || source === "terminal:tty" && /^合入 [0-9a-f]{8}$/.test(text)) {
    if (run.card.nature === "评审") throw new Error("只评审卡仅出报告，不支持合入（包括接受未验证）");
    if (run.publication) return undefined; // 发布事实不需要新的例外决定；适配层直接接续剩余节点。
    prepareExceptionCandidate(path); run = readRun(path);
    const q = qualification(run), candidate = currentCandidate(run);
    if (!q.inputs) throw new Error("检查输入无法冻结，修复输入后才能确认例外合入");
    if (shown && (candidate.commit !== shown.candidate.commit || candidate.tree !== shown.candidate.tree || q.inputs !== shown.inputs
      || run.userVersion !== shown.userVersion || JSON.stringify(q.missing) !== JSON.stringify(shown.missing))) throw new Error("确认期间候选、标准或用户版本变化，请按当前内容重新确认");
    const decision: UserDecision = { id: randomUUID(), at: new Date().toISOString(), source, text, candidate, inputs: q.inputs, userVersion: run.userVersion, missing: q.missing, ...(run.batch ? { mapping: structuredClone(run.batch.contributions) } : {}) };
    updateRun(path, (r) => {
      const current = currentCandidate(r);
      if (r.userVersion !== decision.userVersion || checkInputs(r).hash !== decision.inputs || current.commit !== candidate.commit || current.tree !== candidate.tree) throw new Error("用户决定期间候选或输入变化");
      r.decisions.push(decision);
    });
    writeKernelSummary(path); return decision;
  }
  const grants = !invalidEnvelope && run.acceptanceState && grantsFromUser(text, run.acceptanceState.criteria, run.acceptanceState.grants);
  if (grants) {
    updateRun(path, (r) => { r.acceptanceState!.grants = grants; r.userVersion++; r.epoch = (r.epoch ?? 0) + 1; r.acceptanceState!.plan = undefined; });
    return undefined;
  }
  // 普通新输入仅撤销本任务检查及依赖批次资格；不清零次数或丢掉本轮责任集合。
  if (run.taskRecords && !task) throw new Error("多任务补充要求必须显式指定原任务身份");
  updateTaskRun(path, task, (r) => {
    const state = r.acceptanceState, plan = state?.plan;
    if (plan) {
      const batch = readRun(path);
      if (!plan.basis && plan.signature === acceptanceSignature(batch)) plan.basis = acceptanceBasis(batch);
      plan.pendingInputs = [...new Set([...(plan.pendingInputs ?? []), taskIdentity(r)])];
      plan.ids = [...new Set([...plan.ids, ...state!.criteria.items.filter((i) => state!.owners[i.id] === taskDefinition(r).name).map((i) => i.id)])];
    }
    r.userVersion += 1; r.userInputs.push(materials?.text ?? raw);
    r.userFiles = [...new Set([...(r.userFiles ?? []), ...(materials?.files ?? []).map((f) => resolve(r.worktree, f.path))])];
    for (const file of materials?.files ?? []) (r.userFileVersions ??= {})[resolve(r.worktree, file.path)] = digest(Buffer.from(file.text, "utf8"));
    r.stopReason = "真实用户输入更新，需按当前输入重新交付";
  });
  return undefined;
}
export async function mergeManaged(path: string, options: { accept?: boolean; decision?: UserDecision; automatic?: boolean; dryRun?: boolean; localOnly?: boolean } = {}): Promise<NodeOutput> {
  const run = readRun(path);
  if (run.card.nature === "评审") throw new Error("只评审卡仅出报告，不能合入（接受未验证也不允许）");
  if (run.publication) return options.dryRun ? { status: "没验证", reason: "已有发布；只读查询部署，未执行", evidence: [], operations: [], released: true } : deployManaged(path);
  const q = qualification(run);
  // 例外只豁免缺少结论；卡、候选、目标、资源身份始终不能豁免。
  if (!q.candidate) throw new Error(`合入身份核对失败：\n${q.missing.join("\n")}`);
  currentCandidate(run);
  const cardProblem = frozenCardProblem(run); if (cardProblem) throw new Error(cardProblem);
  if (run.pendingCard || run.release.status === "未确认" || run.taskRecords?.some((t) => t.release.status === "未确认") || readLocalQueue().items.some((t) => t.ledger === path) || run.abandoned || [run.activity, ...(run.taskRecords ?? []).map((t) => t.activity)].some((a) => activityAlive(a) !== false)) throw new Error("还有节点活动、归属未确认或任务已放弃，未合入；先停止并确认资源");
  for (const view of [run, ...(run.taskRecords ?? []).map((t) => taskView(run, t.id))]) {
    for (const group of [view.launch, view.supervisor, view.worker]) if (group && ownedProcessGroupAlive(group) === undefined
      && !(group === view.launch && nativePiOwnerConfirmed(view, path))) throw new Error("登记消费者进程身份未确认，普通/例外均不能发布");
  }
  for (const dir of [run.dir, ...(run.taskRecords ?? []).map((t) => t.dir)]) {
    const procs = join(dir, "review.procs.json");
    if (existsSync(procs)) {
      const raw = JSON.parse(readFileSync(procs, "utf8"));
      if (!Array.isArray(raw) || raw.length || readProcs(procs).length) throw new Error("评审消费者释放未确认，不能合入；请先用统一停止入口核对并释放登记进程");
    }
  }
  for (const result of run.results.filter((r) => !r.released)) {
    const problem = consumerProblem(join(run.taskRecords?.find((t) => t.id === result.task)?.dir ?? run.dir, "attempts", result.id, "test.procs.json"));
    if (problem) throw new Error(problem);
  }
  if (q.missing.length && !options.accept) throw new Error(`普通合入被拒绝：\n${q.missing.join("\n")}`);
  if (options.automatic && options.accept) throw new Error("自动调度禁止接受未验证");
  const sources = contributionProblems(run, false);
  if (sources.length) throw new Error(`批次来源不完整或已过期，例外不能豁免；请真实用户重新确认「合入本批」以冻结全部当前任务贡献：\n${sources.join("\n")}`);
  const decision = findUserDecision(run, q.candidate, q.inputs, q.missing, options.decision?.id);
  if (options.dryRun) return { status: q.missing.length ? "没验证" : "通过", reason: `只读核对，未发布；${options.localOnly ? "本次仅本地合入 dev，不请求远端推送；" : ""}例外执行仍须真实用户决定`, evidence: [], operations: q.missing, released: true };
  if (options.accept && !decision) throw new Error("没有绑定本候选与逐项欠项的真实用户决定；请在原会话亲手输入「合入本批」，或在交互终端确认统一命令；卡/提示词/机器消息不算授权");
  updateRun(path, (r) => {
    if (r.userVersion !== run.userVersion || checkInputs(r).hash !== q.inputs) throw new Error("合入交接前检查输入或用户决定已变化");
    r.stopped = false; r.stopReason = undefined; if (r.activity && activityAlive(r.activity) === false) r.activity = undefined;
  }); // 停止不是放弃，允许显式发布已登记候选。
  const result = await executeNode(path, "提交", (input) => submitCandidate(input, options.accept ? decision : undefined, options.localOnly));
  const published = readRun(path).publication;
  if (published?.local === "merged") {
    try { appendMergeRecord({ project: run.repo, batch: run.card.name, entry: `${run.id}:${published.commit}`, commit: published.commit, file: run.file, manual: [],
      notes: [`候选树：${published.tree}`, `推送 origin/dev：${published.push}；${published.reason ?? ""}`, ...nodeCheckLines(readRun(path)),
        ...(options.accept && decision ? [`用户接受未验证：${decision.source}；${decision.at}；${decision.text}`, ...decision.missing] : [])] }, process.env.AUTOREVIEW_KERNEL_ROOT ? join(kernelRoot(), "交付记录.md") : undefined); }
    catch (error) { updateRun(path, (r) => { (r.notes ??= []).push(`合入索引写入失败：${String(error)}`); }); }
  }
  writeKernelSummary(path);
  if (published?.local === "merged" && published.push === "成功" && run.card.flow.includes("部署")) return deployManaged(path);
  return result;
}
/** 发布后的唯一接续入口；不会再次评审/提交/推送。 */
export async function deployManaged(path: string, signal?: AbortSignal, exec?: Exec, retryAttempt?: string): Promise<NodeOutput> {
  const run = readRun(path), p = run.publication;
  if (!run.card.flow.includes("部署")) return { status: p && ["成功", "未请求"].includes(p.push) ? "通过" : "没验证", reason: `本地发布记录已存在；推送 ${queryKernel(path).publication?.push ?? "未开始"}，不自动重试推送。${p?.reason ?? ""}；部署：没验证（本次未安排）`, evidence: [], operations: [], released: true };
  if (p?.local !== "merged" || p.push !== "成功") return { status: "没验证", reason: `部署未执行：发布/推送未成功（${p?.push ?? "无发布身份"}）；不自动重推`, evidence: [], operations: [], released: true };
  const prior = run.deploymentAttempts?.at(-1), uncertain = deploymentUncertainty(prior);
  if (uncertain) throw new Error(uncertain);
  const existing = validResult(run, "部署", { commit: p.commit, tree: p.tree }, checkInputs(run, "部署").hash);
  if (!existing && prior && retryAttempt !== prior.id) {
    if (retryAttempt) throw new Error("部署重跑意图已过期；当前尝试已变化，请按当前记录重新明确重跑");
    const result = run.results.find((r) => r.node === "部署" && r.id === prior.id);
    return { status: result?.status ?? "没验证", reason: `${prior.reason ?? "已有部署尝试，结果待核对"}；自动回调/普通续跑不重复执行。明确重跑：${kernelCommand("重跑", run.file, "--node", "部署", "--json")}`,
      evidence: result?.evidence ?? [prior.log], operations: ["保留已有部署尝试；未重做命令/检查/回退"], released: prior.released };
  }
  if (!prior && retryAttempt) throw new Error("部署重跑绑定的原尝试已不存在，未执行");
  if (!existing && gitText(run.repo, ["rev-parse", "refs/heads/dev"]) !== p.commit) throw new Error(`当前本地 dev ${gitText(run.repo, ["rev-parse", "refs/heads/dev"])} 已不在本批发布 ${p.commit}；远端本次推送 ${p.remoteCommit ?? "未确认"}；保留回退/发布记录，不自动重发旧版本`);
  const output = await executeNode(path, "部署", (input) => runDeploymentNode(input, exec ?? createChildExec(input.procsFile), retryAttempt), { signal });
  await reportManaged(path);
  await (await import("./kernel-runtime.ts")).releaseKernelWorkspace(path);
  return output;
}
export async function reviewManaged(path: string, options: { signal?: AbortSignal; exec?: Exec; callReviewer?: ReviewerCall } = {}): Promise<NodeOutput> {
  if (readRun(path).card.nature !== "评审") throw new Error("当前不是只评审卡");
  const output = await executeNode(path, "评审", (input) => runReviewNode(input, options.exec ?? createChildExec(input.procsFile), options.callReviewer), { signal: options.signal });
  await reportManaged(path); return output;
}
export interface DeliveryOptions { exec: Exec; signal?: AbortSignal; callReviewer?: ReviewerCall; testExec?: Exec; acceptanceExec?: Exec; task?: string }
/** 新卡边界标记；不改变旧单会话的末行语义，也不接受正文/引用中的任意标记。 */
export function managedMarker(text: string): ReturnType<typeof classifyMarker> {
  const lines = text.trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const edges = [lines[0], lines.at(-1)];
  if (edges.includes("【需要你决定】")) return "decision";
  return edges.includes("【交付完成】") ? "delivered" : "none";
}
/** 两宿主共用的交付判断；只有当前输入的已登记候选/交付/原会话返修才能在无标记时接续。 */
export function managedDeliveryIntent(run: KernelRun, text: string): { advance: boolean; reason?: string } {
  if (run.stopped || run.abandoned) return { advance: false, reason: run.stopReason ?? "任务已停止；请显式续跑原任务" };
  if (run.publication || managedMarker(text) !== "none") return { advance: true };
  const reason = "本回合未识别为交付，未执行检查；完成任务后请发送首行或末行独立的【交付完成】；需要用户决定请写【需要你决定】";
  try {
    const dirty = dirtyPaths(run).length > 0, candidate = dirty ? run.candidate : currentCandidate(run), inputs = checkInputs(run, "开发评审").hash;
    if (!candidate) return { advance: false, reason: "没有登记候选；请在原会话明确交付【交付完成】" };
    const repair = run.repair;
    const context = run.delivery?.userVersion === run.userVersion && run.delivery.inputs === inputs && run.delivery.candidate.tree === candidate.tree
      || repair?.state === "read" && repair.userVersion === run.userVersion && repair.epoch === (run.epoch ?? 0)
      && repair.session === run.session?.id && repair.host === run.session?.host && repair.taskId === run.taskId
      && repair.candidate.tree === candidate.tree && repair.inputs === checkInputs(run, repair.node === "测试" ? "测试" : "开发评审").hash && digest(repair.message) === repair.hash;
    if (!context) return { advance: false, reason }; // 脏文件只说明候选变化，不证明本回合交付。
    const pending = dirty || !validResult(run, "开发评审", candidate, inputs)
      || run.card.flow.includes("测试") && !validResult(run, "测试", candidate, checkInputs(run, "测试").hash)
      || run.taskRecords && !run.batch?.contributions.some((c) => c.task === run.taskId && c.candidate.commit === candidate.commit)
      || run.card.flow.includes("验收") && !validResult(run, "验收", candidate, checkInputs(run, "验收").hash)
      || run.card.flow.includes("提交");
    return context && pending ? { advance: true } : { advance: false, reason: pending ? reason : "本任务已交付；有效检查保留，等待批次后续或用户补充要求" };
  } catch (error) { return { advance: false, reason: `不能安全接续：${String(error)}；请处理后在原会话重新交付【交付完成】，或用续跑/状态入口核对` }; }
}
export function consumeManagedRepair(path: string, raw: string, materials?: { files: { path: string; text: string }[] }, task?: string): boolean {
  const run = readTaskRun(path, task), repair = run.repair;
  if (!repair) {
    const all = [readRun(path).repair, ...(readRun(path).taskRecords ?? []).map((t) => t.repair)].filter(Boolean);
    if (all.some((e) => raw === e!.message || raw === `<cross-session-message>\n${e!.message}\n</cross-session-message>` || [`@${e!.file}`, `@"${e!.file}"`, `请读取并执行 @"${e!.file}"`].includes(raw))) throw new Error("机器返修任务/原会话不匹配，拒收");
    return false;
  }
  // 核对真正收到的完整正文，不把“包含正确 token”或保存副本自洽当作来源证明。
  const native = run.native, launch = process.env.AUTOREVIEW_KERNEL_LAUNCH;
  const trustedClaude = repair.host === "claude" && !!launch && native?.launch === launch && run.session?.launchId === launch
    && process.env.AUTOREVIEW_KERNEL_NATIVE_BINDING === native.binding;
  const wrapper = `<cross-session-message>\n${repair.message}\n</cross-session-message>`;
  const body = trustedClaude && raw === wrapper ? raw.slice("<cross-session-message>\n".length, -"\n</cross-session-message>".length) : raw;
  const exactBody = body === repair.message && digest(body) === repair.hash;
  const references = [`@${repair.file}`, `@"${repair.file}"`, `请读取并执行 @"${repair.file}"`];
  const byFile = references.includes(raw) && materials?.files.length === 1
    && resolve(materials.files[0].path) === repair.file && digest(materials.files[0].text) === repair.hash;
  // 包装之外有追加文本（包括撤权）必须留给真实输入路径，不能吞掉。
  if (!exactBody && !byFile) return false;
  if (repair.session !== run.session?.id || repair.host !== run.session?.host || repair.userVersion !== run.userVersion || repair.epoch !== (run.epoch ?? 0)
    || repair.candidate.tree !== run.candidate?.tree || repair.inputs !== checkInputs(run, repair.node === "验收" || repair.node === "开发评审" ? "开发评审" : "测试").hash || repair.taskId && repair.taskId !== run.taskId || digest(repair.message) !== repair.hash) throw new Error("机器返修的原会话/候选/输入身份已失效");
  if (repair.state === "read") return true;
  updateTaskRun(path, task, (r) => { if (r.repair?.id === repair.id) { r.repair.state = "read"; r.repair.readAt = new Date().toISOString(); } });
  return true;
}
export async function reportManaged(path: string): Promise<void> {
  const run = readRun(path), q = queryKernel(path), checks = nodeCheckLines(run);
  writeKernelSummary(path);
  const checkLine = (label: string): string => checks.filter((line) => line.startsWith(`${label}：`) || line.includes(` / ${label}：`)).map((line) => line.startsWith(`${label}：`) ? line.slice(label.length + 1) : line).join("；");
  try { appendLedgerRecord({ project: run.repo, session: `${run.id}:${run.revision}`, task: run.card.name, result: `${q.status}；${q.reason}`, summary: join(run.dir, "summary.md"),
    checks: { test: checkLine("测试"), review: checkLine("评审"), acceptance: checkLine("验收") }, pending: [] }, process.env.AUTOREVIEW_KERNEL_ROOT ? join(kernelRoot(), "交付记录.md") : undefined); }
  catch (error) { updateRun(path, (r) => { (r.notes ??= []).push(`交付索引写入失败：${String(error)}`); }); }
  await systemNotify(run.taskRecords ? "Loop 批次" : "Loop 单任务", q.lines.join("\n"));
}
/** 上限后的显式继续只使用该任务已提高额度；不清零旧计数、不重验旧失败树。 */
export function continueAcceptanceTask(path: string, task?: string): boolean {
  const run = readTaskRun(path, task), id = run.taskId ?? taskDefinition(run).name;
  if (run.blockedNode !== "验收" || !run.acceptanceState?.plan?.repairTasks.includes(id)) return false;
  const definition = taskDefinition(run), limit = definition.limits?.验收.maxRepairs ?? run.card.limits.验收.maxRepairs;
  if ((run.counters?.验收?.repairs ?? 0) >= limit) throw new Error(`任务 ${definition.name} 达到验收返修上限；请真实用户提高该任务 limits.验收.maxRepairs、移出任务或放弃整批；次数不清零`);
  updateTaskRun(path, task, (r) => {
    const counter = (r.counters ??= {}).验收 ??= { repairs: 0, recoveries: 0 }; counter.repairs++;
    const id = randomUUID(), token = randomUUID(), own = r.acceptanceState!.previous!.items.filter((i) => i.verdict === "不通过" && r.acceptanceState!.owners[i.id] === definition.name);
    const message = `【Loop 验收返修】[${id}:${token}]\n用户受控提高本任务额度；累计第 ${counter.repairs} 次验收返修（不清零）。\n${own.map((i) => `${i.id}. ${i.text}\n${i.detail}`).join("\n\n")}\n仅本原会话修复，最后写【交付完成】。`;
    const file = join(r.dir, `acceptance-repair-${id}.md`); writeFileSync(file, message, { mode: 0o600, flag: "wx" });
    r.repair = { id, token, taskId: r.taskId, node: "验收", attempt: r.results.filter((v) => v.node === "验收").at(-1)!.id, session: r.session?.id ?? "unattached", host: r.session?.host ?? r.card.host,
      candidate: r.candidate!, inputs: checkInputs(r, "开发评审").hash, userVersion: r.userVersion, epoch: r.epoch ?? 0, message, hash: digest(message), file, state: "pending", at: new Date().toISOString() };
    r.stopped = false; r.blockedNode = "开发评审"; r.stopReason = "用户决定继续原会话验收返修";
  }); return true;
}
/** 全部有效贡献到齐才冻结一轮；同轮责任集合固定，不按单个返回触发验收。 */
export async function advanceBatch(path: string, options: { signal?: AbortSignal; acceptanceExec?: Exec; task?: string } = {}): Promise<NodeOutput> {
  let run = readRun(path);
  const waiting: NodeOutput = { status: "没验证", reason: "等待本轮活跃/返修任务全部重新评审、测试并汇入", evidence: [], operations: [], released: true };
  if (run.stopped || run.abandoned || run.publication || run.pendingCard || activityAlive(run.activity) !== false || contributionProblems(run).length) return waiting;
  if (run.acceptanceState?.plan?.waitFor?.some((w) => taskView(run, w.task).candidate?.commit === w.candidate)) return waiting;
  if (run.card.flow.includes("验收")) {
    const auth = authorizationStatus(run.acceptanceState!.criteria, run.acceptanceState!.grants);
    if (auth.pending.length) {
      const reason = `等你授权：${authorizationHint(run.acceptanceState!.criteria, auth.pending)}`;
      const paused = updateRun(path, (r) => {
        if (r.userVersion !== run.userVersion || r.epoch !== run.epoch || r.pendingCard || activityAlive(r.activity) !== false) return false;
        r.blockedNode = "验收"; r.stopped = true; r.stopReason = reason; return true;
      });
      if (!paused) return waiting;
      await reportManaged(path);
      return { status: "没验证", reason, evidence: [], operations: ["真实授权尚未决定，未排队/未调用验收方/未增加实测轮次"], released: true };
    }
    updateRun(path, (r) => {
      if (r.stopped || r.pendingCard || activityAlive(r.activity) !== false || contributionProblems(r).length) return;
      const state = r.acceptanceState!;
      if (!state.plan) state.plan = { ids: state.criteria.items.filter((i) => !forUser(i) && (!state.owners[i.id] || r.card.tasks.some((t) => t.name === state.owners[i.id]))).map((i) => i.id),
        repairTasks: [], mapping: JSON.stringify(r.batch?.contributions ?? r.candidate), signature: acceptanceSignature(r), basis: acceptanceBasis(r) };
      const plan = state.plan;
      if (plan.pendingInputs?.length) {
        if (!plan.basis || plan.basis !== acceptanceBasis(r)) throw new Error("补充要求之外的标准、授权或共享验收方法已变化；原责任集合/范围保留，须按当前来源受控确认");
        reusedAcceptanceItems(r); // 仅未变任务、有原实测材料的条目可沿用。
        const from = plan.signature, to = acceptanceSignature(r), mapping = JSON.stringify(r.batch?.contributions ?? r.candidate);
        (state.planRefreshes ??= []).push({ at: new Date().toISOString(), from, to, tasks: [...plan.pendingInputs], ids: [...plan.ids], mapping });
        plan.signature = to; plan.mapping = mapping; plan.pendingInputs = undefined;
      }
    });
    run = readRun(path);
    let output: NodeOutput;
    try { output = await executeNode(path, "验收", (input) => runAcceptanceNode(input, options.acceptanceExec ?? createChildExec(input.procsFile)), { signal: options.signal, localSlot: true }); }
    catch (error) { if (readRun(path).activity) return waiting; throw error; }
    if (output.stale) return output;
    if (applyPendingCardChange(path)) return advanceBatch(path, options);
    if (output.status !== "通过") {
      updateRun(path, (r) => {
        if (r.stopped || r.userVersion !== run.userVersion) return;
        r.blockedNode = "验收";
        if (output.failure !== "product" || !output.released || !output.acceptance) {
          r.stopped = true; r.stopReason = output.reason ?? "验收未完成，原范围与有效结论保留"; return;
        }
        const state = r.acceptanceState!, record = output.acceptance;
        const failures = record.items.filter((i) => i.verdict === "不通过");
        const names = [...new Set(failures.map((i) => state.owners[i.id]))];
        const repairTasks = names.map((name) => r.taskRecords?.find((t) => t.name === name)?.id ?? name);
        for (const item of record.items.filter((i) => record.scope?.tested.includes(i.id))) {
          const task = r.taskRecords?.find((t) => t.name === state.owners[item.id]), view = task ? taskView(r, task.id) : r;
          (state.bindings ??= {})[item.id] = { tree: run.candidate!.tree, round: record.scope!.round, task: task?.id, candidate: view.candidate?.commit, inputs: taskAcceptanceInputs(view) };
        }
        state.previous = record;
        const ids = state.criteria.items.filter((i) => failures.some((f) => f.id === i.id) || names.includes(state.owners[i.id])).map((i) => i.id);
        state.plan = { ids, repairTasks, waitFor: repairTasks.map((id) => ({ task: id, candidate: taskView(r, id).candidate!.commit })), mapping: JSON.stringify(r.batch?.contributions ?? r.candidate), signature: acceptanceSignature(r), basis: acceptanceBasis(r) };
        const attempt = r.results.filter((v) => v.node === "验收").at(-1)!;
        for (const tid of repairTasks) {
          const view = taskView(r, tid), definition = taskDefinition(view), counter = (view.counters ??= {}).验收 ??= { repairs: 0, recoveries: 0 };
          const limit = definition.limits?.验收.maxRepairs ?? r.card.limits.验收.maxRepairs;
          if (counter.repairs >= limit) {
            view.stopped = true; view.blockedNode = "验收";
            view.stopReason = `任务 ${definition.name} 达到验收返修上限 ${limit}，旧计数 ${counter.repairs} 保留。三选一：继续修（在替换卡提高 tasks[].limits.验收.maxRepairs 后）${kernelCommand("改卡", r.file, "--from", "/替换卡.json", "--json")}；移出任务：${kernelCommand("改卡", r.file, "--remove-task", definition.name, "--json")}；整批放弃：${kernelCommand("放弃", r.file, "--json")}`;
          } else {
            counter.repairs++; const id = randomUUID(), token = randomUUID();
            const own = failures.filter((i) => state.owners[i.id] === definition.name);
            const message = `【Loop 验收返修】[${id}:${token}]\n仅责任任务 ${definition.name} 第 ${counter.repairs} 次验收返修，其他任务不变。\n${own.map((i) => `${i.id}. ${i.text}\n${i.detail}`).join("\n\n")}\n证据：${output.evidence.join("、")}\n只在本原开发评审会话修复；不能改标准、授权或代选移出。重新评审/测试并汇入后，等同轮任务到齐再验 ${ids.join("、")}。最后写【交付完成】。`;
            const file = join(view.dir, `acceptance-repair-${id}.md`); writeFileSync(file, message, { mode: 0o600, flag: "wx" });
            view.repair = { id, token, taskId: view.taskId, node: "验收", batchVersion: r.batch?.version, attempt: attempt.id, session: view.session?.id ?? "unattached", host: view.session?.host ?? r.card.host,
              candidate: view.candidate!, inputs: checkInputs(view, "开发评审").hash, userVersion: view.userVersion, epoch: view.epoch ?? 0, message, hash: digest(message), file, state: "pending", at: new Date().toISOString() };
            view.stopReason = "验收产品失败，仅本任务返回原开发评审会话"; view.blockedNode = "开发评审";
          }
          if (r.taskRecords) Object.assign(r.taskRecords.find((t) => t.id === view.taskId)!, { counters: view.counters, stopped: view.stopped, blockedNode: view.blockedNode, stopReason: view.stopReason, repair: view.repair });
          else Object.assign(r, { counters: view.counters, stopped: view.stopped, blockedNode: view.blockedNode, stopReason: view.stopReason, repair: view.repair });
        }
      });
      const current = readRun(path), own = options.task ? taskView(current, options.task) : !current.taskRecords ? current : undefined;
      if (own?.repair?.node === "验收" && own.repair.state !== "read" && !own.stopped) output.message = own.repair.message;
      for (const t of current.taskRecords ?? []) if (t.id !== own?.taskId && t.launch && t.repair?.node === "验收" && !t.stopped) await (await import("./kernel-runtime.ts")).deliverManagedRepair(path, t.id);
      await reportManaged(path); return output;
    }
    updateRun(path, (r) => {
      if (output.acceptance) {
        const s = r.acceptanceState!; s.previous = output.acceptance;
        for (const item of output.acceptance.items) {
          if (!output.acceptance.scope?.tested.includes(item.id)) { const b = s.bindings?.[item.id]; if (b) b.reason = "沿用：未返修任务的候选、相关输入、标准/授权未变；未在新树实测"; continue; }
          const task = r.taskRecords?.find((t) => t.name === s.owners[item.id]), view = task ? taskView(r, task.id) : r;
          (s.bindings ??= {})[item.id] = { tree: run.candidate!.tree, round: output.acceptance.scope.round, task: task?.id, candidate: view.candidate?.commit, inputs: taskAcceptanceInputs(view) };
        }
      }
    });
  }
  run = readRun(path);
  const output = run.card.flow.includes("提交") ? await mergeManaged(path, { automatic: true }) : { status: "通过" as const, evidence: [], operations: ["统一验收完成；未暗加提交或末尾全验"], released: true };
  await reportManaged(path); return output;
}
/** 固定直线推进，节点之间仅通过账本交换结果。 */
export async function advanceManaged(path: string, options: { signal?: AbortSignal; testExec?: Exec; acceptanceExec?: Exec; task?: string; deploymentRetry?: string } = {}): Promise<NodeOutput> {
  applyPendingCardChange(path);
  const task = options.task, read = () => readTaskRun(path, task), change = <T>(fn: (r: KernelRun) => T) => updateTaskRun(path, task, fn);
  let run = read();
  if (run.card.nature === "评审") return reviewManaged(path, options);
  if (run.publication) return deployManaged(path, options.signal, undefined, options.deploymentRetry);
  if (run.taskRecords && !task) return advanceBatch(path, options);
  if (run.stopped || run.abandoned || run.publication) throw new Error("任务已停止/放弃/发布，不能自动推进");
  const candidate = currentCandidate(run);
  if (!validResult(run, "开发评审", candidate, checkInputs(run, "开发评审").hash)) throw new Error(`缺当前开发评审结论；请在原会话续跑交付`);
  let output: NodeOutput = { status: "通过", evidence: [], operations: ["已有开发评审结论"], released: true };
  if (run.card.flow.includes("测试")) {
    output = await executeNode(path, "测试", (input) => runTestNode(input, options.testExec ?? createChildExec(input.procsFile)),
      { signal: options.signal, task, localSlot: !/^无[:：]/.test(taskDefinition(run).test!) });
    if (output.stale) return output;
    if (applyPendingCardChange(path)) return advanceManaged(path, options);
    const last = read().results.filter((r) => r.node === "测试" && r.task === taskIdentity(run)).at(-1);
    if (output.status !== "通过") {
      change((r) => {
        r.blockedNode = "测试";
        const counter = (r.counters ??= {}).测试 ??= { repairs: 0, recoveries: 0 };
        if (output.failure === "product" && output.released && !r.stopped && counter.repairs < r.card.limits.测试.maxRepairs && last) {
          if (r.repair?.attempt === last.id) { output.message = r.repair.message; return; }
          counter.repairs++;
          const id = randomUUID(), token = randomUUID();
          const message = `【Loop 测试返修】[${id}:${token}]\n测试产品失败，第 ${counter.repairs} 次测试返修（独立于静态评审次数）。\n任务 ${taskDefinition(r).name}；候选 ${candidate.commit}/${candidate.tree}\n实际命令：${taskDefinition(r).test}\n原因：${output.reason}\n失败输出摘录：\n${output.evidence.filter((p) => p.endsWith("test.log") && existsSync(p)).map((p) => readFileSync(p, "utf8").slice(-8000)).join("\n")}\n完整输出与证据：${output.evidence.join("、")}\n只在本原开发会话修复并定向自检；交付后先重新开发评审再测试。不得自行移除必需测试或降低标准。最后写【交付完成】。`;
          const file = join(r.dir, `test-repair-${id}.md`); writeFileSync(file, message, { flag: "wx", mode: 0o600 });
          r.repair = { id, token, taskId: r.taskId, node: "测试", attempt: last.id, session: r.session?.id ?? "unattached", host: r.session?.host ?? r.card.host, candidate, inputs: checkInputs(r, "测试").hash,
            userVersion: r.userVersion, epoch: r.epoch ?? 0, message, hash: digest(message), file, state: "pending", at: new Date().toISOString() };
          output.message = message; r.stopReason = "测试产品失败，返修回原开发会话";
        } else {
          r.stopped = true; r.stopReason = output.failure === "product" ? "达到测试返修上限；提高卡上测试限额后再继续，计数不清零" : output.reason ?? output.status;
          if (!output.released) r.release = { status: "未确认", details: [r.stopReason] };
        }
      });
      if (!output.message) await reportManaged(path);
      else writeKernelSummary(path);
      return output;
    }
    applyPendingCardChange(path); run = read();
  }
  if (run.taskRecords) {
    const integrated = integrateTask(path, task!);
    if (!integrated.ok) return { status: integrated.failure === "environment" ? "没验证" : "不通过", failure: integrated.failure ?? "product", reason: integrated.reason, evidence: integrated.evidence, operations: ["按已检查贡献集成；冲突仅退回当前任务"], released: true, message: integrated.message };
    return advanceBatch(path, options);
  }
  if (run.card.flow.includes("验收")) return advanceBatch(path, options);
  if (run.card.flow.includes("提交")) output = await mergeManaged(path, { automatic: true });
  await reportManaged(path); return output;
}
export async function completeManagedDelivery(path: string, text: string, options: DeliveryOptions): Promise<NodeOutput> {
  const task = options.task, read = () => readTaskRun(path, task), change = <T>(fn: (r: KernelRun) => T) => updateTaskRun(path, task, fn);
  let run = read();
  if (run.card.nature === "评审") throw new Error("只评审不接受开发交付，不创建任务提交");
  if (run.stopped || run.abandoned || run.publication || run.activity && !["starting", "developing"].includes(run.activity.kind)) return { status: "中断", reason: run.stopReason ?? "已有节点执行或任务停止", evidence: [], operations: [], released: true };
  if (run.blockedNode === "验收" && run.acceptanceState?.plan?.repairTasks.includes(taskIdentity(run))) return { status: "中断", reason: "验收返修额度尚未通过受控继续登记；请提高本任务额度后续跑，不能绕过旧次数", evidence: [], operations: [], released: true };
  if (managedMarker(text) === "decision") { pauseManaged(path, "开发方需要你决定", task); return { status: "中断", reason: "开发方需要你决定", evidence: [], operations: [], released: true }; }
  try {
    change((r) => { if (r.activity?.kind === "developing") r.activity = undefined; });
    applyPendingCardChange(path); run = read();
    const candidate = deliverCandidate(run);
    change((r) => { if (r.userVersion !== run.userVersion || r.stopped) throw new Error("交付期间输入或停止状态变化"); r.candidate = candidate; r.activity = undefined; });
    change((r) => { r.delivery = { candidate, inputs: checkInputs(r, "开发评审").hash, userVersion: r.userVersion, at: new Date().toISOString() }; });
    writeFileSync(join(run.dir, "delivery.md"), text);
    const output = await executeNode(path, "开发评审", (input) => reviewDevelopment(input, { ...options, signal: input.signal }), { signal: options.signal, task });
    if (output.stale) return output;
    const handoff = change((r) => {
      if (r.userVersion !== run.userVersion || r.activity || r.stopped || r.candidate?.tree !== candidate.tree) return false;
      if (output.message) r.repairs++;
      else if (output.status !== "通过") { r.stopped = true; r.stopReason = output.reason ?? output.status; if (!output.released) r.release = { status: "未确认", details: [r.stopReason] }; }
      return true;
    });
    if (!handoff) return { ...output, status: "中断", reason: "交接前输入或活动变化", message: undefined, stale: true };
    applyPendingCardChange(path);
    if (output.status === "通过") { const next = await advanceManaged(path, options); return run.taskRecords || run.card.flow.includes("测试") || run.card.flow.includes("验收") || run.card.flow.includes("部署") ? next : output; }
    if (!output.message) await reportManaged(path); else writeKernelSummary(path);
    return output;
  } catch (error) {
    const current = read();
    if (current.userVersion === run.userVersion && !current.activity) pauseManaged(path, String(error), task);
    return { status: "中断", reason: String(error), evidence: [], operations: [], released: false };
  }
}
