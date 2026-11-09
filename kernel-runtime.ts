/** 新卡会话启动/停止/释放；argv 直接 spawn，后台也不拼长终端输入。 */
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, rmdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { activityAlive, atomicRun, confirmedConsumerRelease, pendingCardBlocks, readRun, readTaskRun, taskDefinition, taskIds, taskView, updateRun, updateTaskRun, type KernelRun } from "./node-ledger.ts";
import { currentCandidate, kernelCommand, queryKernel, writeKernelSummary } from "./kernel.ts";
import { assertTestEnvironment, assertWorkspace, dirtyPaths, fileDigest, frozenCardProblem, gitRaw, managedConfig, taskScopeBaseline, workspaceGuard, createWorkspace } from "./kernel-workspace.ts";
import { ownedProcessGroupAlive, processStartTime, readProcs, reapProcs, stopSessionGroup } from "./procs.ts";
import { gitResult, gitText, shellQuote } from "./workspace.ts";
import { advanceManaged, continueAcceptanceTask, deployManaged, managedReleaseProblem, pauseManaged, prepareManagedContinuation, reportManaged } from "./kernel-session.ts";
import { recoverBatchIntegration } from "./batch-integration.ts";
import { createChildExec } from "./hosts/review-hook.ts";
import { runPreparation, type PreparationState } from "./preparation.ts";
import { runMethodsSelfTest } from "./methods.ts";
import { failureLine, recoveryDecision } from "./failure.ts";
import { systemNotify } from "./notify.ts";
import { eventLock } from "./events.ts";
import { applyPendingCardChange } from "./kernel-controls.ts";
import { checkInputs } from "./kernel-workspace.ts";
import { validResult } from "./node-ledger.ts";
import { consumerProblem, readLocalQueue, recoverLocalQueue, releaseLocalSlot } from "./local-node-queue.ts";
import { releaseProc } from "./procs.ts";
import { settleProjectExecution } from "./project-execution.ts";
import { deploymentUncertainty } from "./deployment-node.ts";
import { sendNativeRepair } from "./hosts/native-inbox.ts";
import { releaseTestWorkspace } from "./test-workspace.ts";
import { releaseRunResource, resourceLine } from "./resources.ts";

const ROOT = dirname(fileURLToPath(import.meta.url));
function context(task?: string) {
  return { readRun: (path: string) => readTaskRun(path, task), updateRun: <T>(path: string, change: (r: KernelRun) => T) => updateTaskRun(path, task, change),
    pauseManaged: (path: string, reason: string) => pauseManaged(path, reason, task) };
}
function reapKnownProcs(file: string, details: string[]): void {
  try {
    if (existsSync(file)) {
      const rows = JSON.parse(readFileSync(file, "utf8"));
      if (!Array.isArray(rows) || rows.some((r) => !Number.isSafeInteger(r.pgid) || r.pgid < 2 || !r.started || !r.token || !Number.isSafeInteger(r.ownerPid))) throw new Error("进程登记损坏或身份不完整");
    }
    reapProcs(file);
    if (readProcs(file).length) details.push(`登记消费者释放未确认：${file}`);
  } catch (error) { details.push(`未知归属进程登记保留：${file}；${String(error)}`); }
}
/** 新会话与恢复都使用既有正式宿主入口；不保存包含凭证的整个进程环境。 */
export function managedLaunchArgs(path: string, task?: string, interactive = false): { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv } {
  const { readRun } = context(task);
  const run = readRun(path), session = run.session;
  if (run.card.nature === "评审") throw new Error("只评审不启动开发宿主");
  const args = ["开发", run.card.host, "--cwd", run.worktree];
  if (session) {
    if (session.host !== run.card.host || (session.host === "pi" && !session.log)) throw new Error("无法精确恢复原会话，保留候选；原 Pi 会话日志未登记");
    args.push("--session", session.host === "pi" ? session.log! : session.id);
    if (run.repair && run.repair.state !== "read") args.push(`@${run.repair.file}`);
  } else args.push(`@${run.preparationStatus?.startupFile ?? taskDefinition(run).prompt}`);
  if (!interactive && run.card.host !== "codex") args.push("--", "-p");
  return { command: join(ROOT, "bin/loop"), args, cwd: run.worktree, env: { ...process.env,
    LOOP_DIR: ROOT, AUTOREVIEW_KERNEL_TASK: run.taskId ?? "", AUTOREVIEW_KERNEL_REPAIR: run.repair?.id ?? "", AUTOREVIEW_KERNEL_LEDGER: path, AUTOREVIEW_KERNEL_RUN: run.id, AUTOREVIEW_SINGLE_NODE: "1",
    AUTOREVIEW_BATCH_FILE: "", AUTOREVIEW_STAGE: "", AUTOREVIEW_PIPELINE_DIR: "", AUTOREVIEW_PIPELINE_LAUNCH: "", AUTOREVIEW_BASE_REV: "" } };
}
/** 开发节点的受控基线整合：只引入可核对的 dev 来源，不改卡或扩大任务范围，不借旧评审放行新树。 */
export async function integrateKernel(path: string, dryRun = false, task?: string): Promise<Record<string, any>> {
  const { readRun, updateRun } = context(task);
  const run = readRun(path);
  if (run.card.nature === "评审") throw new Error("只评审固定已有提交，不支持整合开发分支");
  if (run.taskRecords && !task) {
    if (run.pendingCard || [run.activity, ...run.taskRecords.map((t) => t.activity)].some((a) => activityAlive(a) !== false)) throw new Error("整合前须结束所有任务/批次活动与 pending 改卡；成果保留");
    const results = [];
    for (const id of taskIds(run)) { const result = await integrateKernel(path, dryRun, id); results.push(result); if (result.ok === false) return result; }
    if (!dryRun) updateRun(path, (r) => {
      const commit = gitText(r.repo, ["rev-parse", "refs/heads/dev"]);
      if (r.pendingCard || taskIds(r).some((id) => { const t = taskView(r, id); return activityAlive(t.activity) !== false || gitResult(r.repo, ["merge-base", "--is-ancestor", commit, t.candidate!.commit]).status !== 0; })) throw new Error("整合期间 dev/任务活动变化，未采纳新来源；请重新整合");
      r.batch!.targetSource = { commit, tree: gitText(r.repo, ["rev-parse", `${commit}^{tree}`]) }; r.batch!.version++; r.epoch = (r.epoch ?? 0) + 1;
      if (r.acceptanceState) r.acceptanceState.plan = undefined;
      r.stopped = false; r.stopReason = "已逐任务引入可核对 dev 来源；冻结开工依据不变，各原会话重新交付后装配新批次并验收";
    });
    return { ...queryKernel(path), dryRun, integrations: results.map((r) => r.integrations), lines: [dryRun ? "只读核对全部任务；未引入 dev 来源" : `已登记 dev 来源，请各原会话重新交付：${kernelCommand("续跑", run.file)}`, ...queryKernel(path).lines] };
  }
  if (run.publication || run.abandoned || activityAlive(run.activity) !== false) throw new Error("已有发布意图、任务已放弃或节点仍活动；先处理发布记录/停止，再整合");
  const problem = frozenCardProblem(run); if (problem) throw new Error(problem);
  const unlock = eventLock(join(run.common, "loop-kernel-dev.lock"));
  const id = randomUUID(), evidence = join(run.dir, `integration-${id}.log`);
  try {
    const from = currentCandidate(run); taskScopeBaseline(run, from.commit);
    const targetCommit = gitText(run.repo, ["rev-parse", "refs/heads/dev"]);
    gitText(run.repo, ["merge-base", "--is-ancestor", run.targetAtStart, targetCommit], "核对 dev 来源没有改换历史");
    const target = { commit: targetCommit, tree: gitText(run.repo, ["rev-parse", `${targetCommit}^{tree}`]) };
    if (gitResult(run.repo, ["merge-base", "--is-ancestor", targetCommit, from.commit]).status === 0) return { ...queryKernel(path), lines: ["任务已包含当前 dev，没有新建整合提交", ...queryKernel(path).lines] };
    const proposed = gitResult(run.repo, ["merge-tree", "--write-tree", from.commit, targetCommit]);
    if (proposed.status !== 0) throw new Error(`整合有冲突，尚未改动任务目录；原会话须在原 scope 内处理，不能夹带范围外解决：${proposed.stdout}\n${proposed.stderr}`);
    const tree = proposed.stdout.split("\n")[0].trim();
    const touched = gitRaw(run.repo, ["diff", "--name-only", "--no-renames", "-z", from.commit, tree, "--"]).split("\0").filter(Boolean);
    const overlaps = (a: string, b: string): boolean => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
    const untracked = (): string[] => gitRaw(run.worktree, ["ls-files", "--others", "-z"]).split("\0").filter(Boolean).sort();
    const collide = [...untracked(), ...run.localFiles].filter((p) => touched.some((t) => overlaps(p, t)));
    if (collide.length) throw new Error(`dev 来源覆盖本机文件/未知成果，未整合：${collide.join("、")}`);
    if (dryRun) return { ...queryKernel(path), dryRun: true, lines: [`只读核对：可整合 dev ${targetCommit}；预期新树 ${tree}；未修改任务目录`] };
    const guard = workspaceGuard(run);
    const unknown = (): string => JSON.stringify(untracked().map((p) => [p, fileDigest(join(run.worktree, p))]));
    const beforeUnknown = unknown();
    writeFileSync(evidence, `原候选 ${from.commit}/${from.tree}\n目标 dev ${targetCommit}/${target.tree}\n计划树 ${tree}\n`, { mode: 0o600 });
    updateRun(path, (r) => {
      if (r.userVersion !== run.userVersion || activityAlive(r.activity) !== false || r.publication || workspaceGuard(r) !== guard
        || gitText(r.repo, ["rev-parse", "refs/heads/dev"]) !== targetCommit) throw new Error("整合边界输入、活动、候选或目标变化");
      r.activity = { id, node: "开发评审", kind: "developing", pid: process.pid, started: processStartTime(process.pid) };
      if (!r.taskId) atomicRun(path, r); // 多任务绝不把上下文投影写成第二份账本。
      gitText(r.worktree, ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "merge", "--no-ff", "--no-verify", "-m", `chore: 整合 dev\n\nLoop 任务 ${r.id}\n来源 ${targetCommit}`, targetCommit]);
      const candidate = { commit: gitText(r.worktree, ["rev-parse", "HEAD"]), tree: gitText(r.worktree, ["rev-parse", "HEAD^{tree}"]) };
      if (candidate.tree !== tree || dirtyPaths(r).length || unknown() !== beforeUnknown) throw new Error("整合期间发生并发写入；成果保留，不授予新候选资格");
      const scope = taskScopeBaseline(r, candidate.commit);
      (r.integrations ??= []).push({ at: new Date().toISOString(), from, target, candidate, scopeBase: scope.base, imported: scope.imported, evidence });
      r.candidate = candidate; r.activity = undefined; r.stopReason = "已整合可核对的 dev 来源；请原会话再次交付，变化后的树须重新开发评审";
      writeFileSync(evidence, `${readFileSync(evidence, "utf8")}已整合 ${candidate.commit}/${candidate.tree}\n范围基线 ${scope.base}\n仅 dev 来源免越界：${scope.imported.join("、")}\n`);
    });
    writeKernelSummary(path);
    return { ...queryKernel(path), lines: [`已整合 dev，原开工依据和卡 scope 未改；继续：${kernelCommand("续跑", run.file)}`, ...queryKernel(path).lines] };
  } catch (error) {
    if (!dryRun) updateRun(path, (r) => { if (r.userVersion === run.userVersion && (!r.activity || r.activity.id === id)) { r.activity = undefined; r.stopped = true; r.stopReason = String(error); } });
    if (!dryRun) writeKernelSummary(path);
    return { ...queryKernel(path), ok: false, error: String(error), lines: [String(error), ...queryKernel(path).lines] };
  } finally { unlock(); }
}
export async function releaseKernelWorkspace(path: string, task?: string): Promise<void> {
  const { readRun, updateRun } = context(task);
  const run = readRun(path), reasons: string[] = [];
  if (run.taskRecords && !task) {
    for (const t of run.taskRecords) await releaseKernelWorkspace(path, t.id);
    for (const t of readRun(path).taskRecords!) if (t.release.status !== "已释放") reasons.push(`${t.name}：${t.release.details.join("；") || t.release.status}`);
  }
  const record = run.taskRecords?.find((t) => t.id === run.taskId);
  // taskView 继承批次 publication，不代表已移出/放弃的任务也发布了；只认冻结发布映射中的本任务候选。
  const merged = run.publication?.local === "merged" && (!run.taskId || !!record && !record.removed && !record.abandoned
    && run.publication.mapping?.some((c) => c.task === run.taskId && c.candidate.commit === run.candidate?.commit && c.candidate.tree === run.candidate?.tree));
  const reviewEnded = run.card.nature === "评审" && run.results.some((r) => r.node === "评审" && r.ended);
  if (!merged && !run.abandoned && !reviewEnded) return;
  if (!run.stopped && run.publication?.push === "成功" && run.card.flow.includes("部署") && !run.deploymentAttempts?.at(-1)?.ended) reasons.push("卡上部署尚未收尾，不提前移除其所需空间");
  if (deploymentUncertainty(run.deploymentAttempts?.at(-1))) reasons.push("部署副作用未确认；保留现场与资源登记，须人工核对");
  if (reviewEnded && run.results.filter((r) => r.node === "评审").at(-1)?.released === false && run.release.status === "未确认") reasons.push("只评审消费者缺少释放证明；不能因登记为空就删除现场");
  if (run.release.status === "已释放") return;
  if (run.activity) reasons.push("节点活动尚未结束");
  if (run.launch && ownedProcessGroupAlive(run.launch) !== false) reasons.push("原开发会话/工具进程释放未确认");
  if (run.session && !run.launch) reasons.push("宿主缺少本次独立进程组登记，归属与释放未确认");
  const procs = join(run.dir, "review.procs.json");
  reapKnownProcs(procs, reasons);
  if (run.worker && ownedProcessGroupAlive(run.worker) !== false) reasons.push("测试 worker 释放未确认");
  for (const attempt of run.results) reapKnownProcs(join(run.dir, "attempts", attempt.id, "test.procs.json"), reasons);
  for (const attempt of run.deploymentAttempts ?? []) reapKnownProcs(attempt.procs, reasons);
  if (readLocalQueue().items.some((t) => t.ledger === path)) reasons.push("本批本机槽/票据释放未确认");
  for (const entry of readRun(path).testWorkspaces?.filter((e) => e.state !== "released" && (!task || e.task === run.taskId)) ?? []) reasons.push(`测试隔离检出尚未释放：${entry.path}；${entry.reason ?? "消费者/目录未知"}`);
  try {
    if (existsSync(run.worktree)) {
      assertWorkspace(run);
      if (run.abandoned) {
        if (dirtyPaths(run).length) reasons.push(`未保存成果保留：${dirtyPaths(run).join("、")}`);
        const head = gitText(run.worktree, ["rev-parse", "HEAD"]);
        if (!run.abandonment?.history || gitText(run.repo, ["rev-parse", run.abandonment.history]) !== head) reasons.push("放弃保留 ref 未覆盖当前 HEAD");
      } else currentCandidate(run);
      const unknown = gitRaw(run.worktree, ["ls-files", "--others", ...(merged ? ["--exclude-standard"] : []), "-z"]).split("\0").filter(Boolean).filter((p) => !run.localFiles.includes(p));
      if (unknown.length) reasons.push(`未知归属文件保留：${unknown.join("、")}`);
      for (const p of run.localFiles) if (!existsSync(join(run.worktree, p)) || fileDigest(join(run.worktree, p)) !== run.localHashes[p]) reasons.push(`本机文件变更保留：${p}`);
    }
    if (!reasons.length) for (const environment of run.testEnvironments ?? []) {
      if (environment.state === "released") continue;
      let reason: string | undefined;
      try {
        assertTestEnvironment(environment, run);
        const released = releaseRunResource(environment.resource);
        if (released.status !== "released") reason = resourceLine(released);
      } catch (error) { reason = String(error); }
      updateRun(path, (r) => { Object.assign(r.testEnvironments!.find((e) => e.id === environment.id)!, environment, { state: reason ? "retained" : "released", reason }); });
      if (reason) reasons.push(`补装依赖缓存保留：${environment.id}；${reason}`);
    }
    if (!reasons.length && existsSync(run.worktree)) {
      // 当前候选已留任务分支和 pre-squash ref；已合入时 ignored 文件可重建，本机文件仍须核对原样。
      gitText(run.repo, ["-c", "core.hooksPath=/dev/null", "worktree", "remove", "--force", run.worktree]);
    }
    if (existsSync(run.worktree)) reasons.push(`工作目录未释放：${run.worktree}`);
    else if (run.workspaceParentCreated) {
      try { rmdirSync(dirname(run.worktree)); } // 只删除明确登记且已空的本批父目录，不递归清理未知内容。
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") reasons.push(`本批父目录保留（未知内容或释放失败）：${dirname(run.worktree)}；${String(error)}`); }
    }
  } catch (error) { reasons.push(String(error)); }
  if (run.taskRecords && !task && !reasons.length) {
    try { rmdirSync(dirname(dirname(run.worktree))); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") reasons.push(`本批根目录保留：${String(error)}`); }
  }
  updateRun(path, (r) => { r.release = { status: reasons.length ? "未确认" : "已释放", details: reasons }; });
  writeKernelSummary(path);
}
/** 保存尚未结清尝试的真实消费者身份；后续登记消失也不能用空数组冒充释放证明。 */
function rememberStopConsumers(path: string, task: string | undefined, run: KernelRun): void {
  const owner = run.taskId ?? (run.taskRecords ? run.id : taskDefinition(run).name);
  const attempts = new Map(run.results.filter((r) => r.task === owner && !r.released && !confirmedConsumerRelease(run, r.id)).map((r) => [r.id, { id: r.id, node: r.node, started: r.started, ended: r.ended }]));
  if (run.activity && !attempts.has(run.activity.id)) attempts.set(run.activity.id, { id: run.activity.id, node: run.activity.node, started: run.created, ended: undefined });
  for (const attempt of attempts.values()) {
    const procs = ["开发评审", "评审"].includes(attempt.node) ? join(run.dir, "review.procs.json") : run.deploymentAttempts?.find((r) => r.id === attempt.id)?.procs ?? join(run.dir, "attempts", attempt.id, "test.procs.json");
    const consumers = [procs, `${procs}.cleanup`].flatMap((file) => {
      const problem = consumerProblem(file); if (problem && /未知归属|损坏/.test(problem)) return [];
      return readProcs(file).filter((entry) => Date.parse(entry.at) >= Date.parse(attempt.started) && (!attempt.ended || Date.parse(entry.at) <= Date.parse(attempt.ended))).map((entry) => ({ file, entry }));
    });
    if (!consumers.length) continue;
    updateTaskRun(path, task, (r) => {
      const receipts = r.consumerReleases ??= [], saved = receipts.find((v) => v.attempt === attempt.id);
      if (saved?.confirmed) return;
      if (saved) { for (const c of consumers) if (!saved.consumers.some((v) => v.file === c.file && v.entry.pgid === c.entry.pgid && v.entry.started === c.entry.started && v.entry.token === c.entry.token)) saved.consumers.push(c); }
      else receipts.push({ attempt: attempt.id, captured: new Date().toISOString(), consumers });
    });
  }
}
function confirmStopConsumers(path: string, task: string | undefined): void {
  for (const receipt of readTaskRun(path, task).consumerReleases ?? []) {
    if (receipt.confirmed) continue;
    const files = [...new Set(receipt.consumers.map((c) => c.file))];
    if (files.some((file) => /未知归属|损坏/.test(consumerProblem(file) ?? ""))) continue;
    if (!receipt.consumers.length || !receipt.consumers.every((c) => releaseProc(c.file, c.entry.pgid, c.entry)) || files.some(consumerProblem)) continue;
    updateTaskRun(path, task, (r) => {
      const current = r.consumerReleases?.find((v) => v.attempt === receipt.attempt);
      if (current && !current.confirmed && JSON.stringify(current.consumers) === JSON.stringify(receipt.consumers)) {
        current.previousProblems = [...r.release.details]; current.confirmed = new Date().toISOString();
      }
    });
  }
}
export async function stopKernel(path: string, dryRun = false, task?: string): Promise<Record<string, any>> {
  const { readRun, updateRun, pauseManaged } = context(task);
  const initial = readRun(path);
  if (dryRun) return { ...queryKernel(path), dryRun: true, lines: ["只读核对，未停止、未删除候选或证据"] };
  if ((initial.publication?.local === "merged" || initial.card.nature === "评审") && initial.release.status === "已释放" && !initial.activity) return queryKernel(path);
  rememberStopConsumers(path, task, initial);
  // 先撤销运行代次，迟到的模型返回无权推进。
  pauseManaged(path, "已停止：用户停止本任务，成果和证据保留；停止不是放弃");
  updateRun(path, (r) => { r.terminal = undefined; });
  const details: string[] = [];
  if (initial.taskRecords && !task) for (const t of initial.taskRecords.filter((t) => !t.removed)) { const result = await stopKernel(path, false, t.id); if (!result.ok) details.push(`${t.name} 停止未确认`); }
  for (const group of [initial.launch, initial.supervisor, initial.worker]) if (group) {
    const stopped = await stopSessionGroup({ pid: group.pid, processStarted: group.processStarted }, false, group);
    // 宿主退出会让启动器同时结束；释放边界竞争要重读身份，不能把已消失的原组误报未知。
    if (!stopped.stopped && ownedProcessGroupAlive(group) !== false) details.push(stopped.reason ?? "资源停止未确认");
  }
  rememberStopConsumers(path, task, initial);
  const procs = join(initial.dir, "review.procs.json");
  if (initial.card.nature === "评审" && initial.results.filter((r) => r.node === "评审").at(-1)?.released === false && !initial.consumerReleases?.some((r) => r.attempt === initial.results.filter((v) => v.node === "评审").at(-1)?.id) && !readProcs(procs).length) details.push("原只评审消费者未提供释放证明，且无可核对的原进程登记；保留现场，不能假称释放");
  for (let i = 0; i < 20 && readProcs(procs).length; i++) await sleep(100); // 等已取消执行器自行确认释放，不猜测身份。
  for (const file of [procs, ...(readRun(path).deploymentAttempts ?? []).map((a) => a.procs)]) {
    const problem = consumerProblem(file);
    if (problem?.includes("未知归属") || problem?.includes("损坏")) { details.push(problem); continue; }
    for (const entry of readProcs(file)) if (!releaseProc(file, entry.pgid, entry)) details.push(`消费者释放未确认：${file}`);
    reapKnownProcs(file, details);
  }
  for (const ticket of readLocalQueue().items.filter((t) => t.ledger === path && t.run === initial.id && (!task || t.task === (initial.taskId ?? taskDefinition(initial).name)))) {
    for (const file of [ticket.procs, `${ticket.procs}.cleanup`]) {
      const problem = consumerProblem(file);
      if (problem?.includes("损坏") || problem?.includes("未知归属")) { details.push(problem); continue; }
      for (const entry of readProcs(file)) if (!releaseProc(file, entry.pgid, entry)) details.push(`消费者释放未确认：${file}`);
    }
    confirmStopConsumers(path, task);
    const current = readRun(path), result = current.results.find((r) => r.id === ticket.id);
    let neverInvoked = ticket.state === "waiting";
    try { neverInvoked ||= JSON.parse(readFileSync(join(initial.dir, "attempts", ticket.id, "attempt.json"), "utf8")).invoked === false; } catch { /* 无开始/结束事实不补造证明。 */ }
    const known = result?.released === true || confirmedConsumerRelease(current, ticket.id) || neverInvoked;
    releaseLocalSlot(ticket.id, ticket.token, known && !consumerProblem(ticket.procs) && !consumerProblem(`${ticket.procs}.cleanup`));
  }
  recoverLocalQueue(); confirmStopConsumers(path, task);
  for (const entry of readRun(path).testWorkspaces?.filter((e) => e.state !== "released" && (!task || e.task === initial.taskId)) ?? []) {
    const attempt = entry.consumerAttempt ?? entry.attempt, result = readRun(path).results.find((r) => r.id === attempt);
    if (!result?.released && !confirmedConsumerRelease(readRun(path), attempt)) { details.push(`隔离测试原消费者缺少释放证明，保留：${entry.path}`); continue; }
    const problem = releaseTestWorkspace(path, entry, true); if (problem) details.push(problem);
  }
  const unresolved = managedReleaseProblem(path, readRun(path), true);
  if (unresolved) details.push(unresolved);
  if (!details.length) settleProjectExecution(initial.repo, [procs, ...(readRun(path).deploymentAttempts ?? []).map((a) => a.procs), ...initial.results.map((r) => join(initial.dir, "attempts", r.id, "test.procs.json"))]);
  if (initial.publication?.local === "merged") {
    await releaseKernelWorkspace(path); return { ...queryKernel(path), ok: !details.length && readRun(path).release.status === "已释放" };
  }
  updateRun(path, (r) => { r.release = { status: details.length ? "未确认" : "未释放", details: [...new Set(["停止保留工作区、任务分支和全部证据", ...details])] }; });
  writeKernelSummary(path); return { ...queryKernel(path), ok: details.length === 0 };
}
/** --launcher background 使用独立组；默认前台保持原生宿主终端。 */
export async function launchKernel(path: string, background = false, task?: string, interactive = false): Promise<Record<string, any>> {
  const batch = readRun(path);
  if (batch.card.nature === "评审") return resumeManaged(path, background);
  if (batch.taskRecords && !task && !batch.publication) {
    updateRun(path, (r) => { if (r.abandoned) throw new Error("已放弃"); r.stopped = false; });
    const work = taskIds(batch).map((id) => launchKernel(path, background, id));
    const results = await Promise.allSettled(work);
    const failed = results.filter((r) => r.status === "rejected");
    return { ...queryKernel(path), ok: !failed.length, launchErrors: failed.map((r) => String((r as PromiseRejectedResult).reason)) };
  }
  const unlock = eventLock(`${path}.${task ?? "batch"}.launch.lock`);
  try { return await launchKernelOwned(path, background, task, interactive); }
  finally { unlock(); }
}
async function launchKernelOwned(path: string, background: boolean, task?: string, interactive = false): Promise<Record<string, any>> {
  const { readRun, updateRun, pauseManaged } = context(task);
  const run = readRun(path), problem = frozenCardProblem(run);
  if (problem) throw new Error(problem);
  const releaseProblem = managedReleaseProblem(path, run); if (releaseProblem) throw new Error(releaseProblem);
  if (!run.publication || run.publication.local === "intent") {
    const active = activityAlive(run.activity);
    if (active === undefined) throw new Error("原活动归属无法确认，不能猜测重启；请先核对停止记录");
    if (active === false && [run.launch, run.supervisor].some((g) => g && ownedProcessGroupAlive(g) !== false)) throw new Error("原会话/启动器仍存活或归属未确认；空闲不是执行中，也不据此重启。请回原窗口继续，或先停止再续跑");
  }
  if (run.publication?.local === "intent") {
    for (const group of [run.launch, run.supervisor]) if (group && ownedProcessGroupAlive(group) !== false) throw new Error("发布/原会话仍活动或归属未确认，先停止后再续跑");
    // 显式续跑也在锁内重读：不能把刚完成的并发 CAS 当成失败意图撤销。
    run.publication = updateRun(path, (r) => {
      if (r.publication?.local === "intent" && r.publication.push === "未开始"
        && gitResult(r.repo, ["merge-base", "--is-ancestor", r.publication.commit, "refs/heads/dev"]).status === 1) {
        writeFileSync(join(r.dir, `publication-unconfirmed-${randomUUID()}.json`), JSON.stringify(r.publication, null, 2));
        r.publication = undefined;
      }
      return r.publication;
    });
  }
  if (run.publication) {
    if (run.publication.local === "intent") updateRun(path, (r) => {
      if (!r.publication || gitResult(r.repo, ["merge-base", "--is-ancestor", r.publication.commit, "refs/heads/dev"]).status !== 0) throw new Error("无法证明发布意图已合入；保留记录，未覆盖目标、未推送");
      r.publication.local = "merged"; r.publication.reason = "Git 证明本地已合入；目标工作区及远端结果未确认，未自动重试推送";
    });
    if (!run.stopped) await deployManaged(path);
    await releaseKernelWorkspace(path); return queryKernel(path);
  }
  assertWorkspace(run);
  for (const group of [run.launch, run.supervisor]) if (group && ownedProcessGroupAlive(group) !== false) throw new Error("原会话/启动器仍活着或归属未确认，不重复启动；先停止");
  updateRun(path, (r) => { r.stopped = false; r.stopReason = undefined; r.launchMode = interactive ? "terminal" : "background"; if (background) r.terminal = undefined; });
  if (!background) { await superviseKernel(path, task, interactive); return queryKernel(path); }
  const token = randomUUID(), log = join(run.dir, "launch.log"), fd = openSync(log, "a", 0o600);
  try {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--supervise", path, run.id, task ?? ""], { detached: true, cwd: run.repo,
      stdio: ["ignore", fd, fd], env: { ...process.env, AUTOREVIEW_PROCESS_OWNER: token } });
    await new Promise<void>((ok, no) => { child.once("spawn", ok); child.once("error", no); });
    const group = { pid: child.pid!, processStarted: processStartTime(child.pid!), token };
    updateRun(path, (r) => { r.supervisor = group; if (!r.activity && r.session?.launchId === run.session?.launchId) r.activity = { id: randomUUID(), node: "开发评审", kind: "starting", pid: group.pid, started: group.processStarted }; });
    child.unref();
    return { ...queryKernel(path), lines: [`已派发新卡；日志：${log}`, `查询：${kernelCommand("状态", run.file)}`, `停止：${kernelCommand("停止", run.file)}`] };
  } catch (error) { pauseManaged(path, `启动失败：${String(error)}；恢复入口：${kernelCommand("续跑", run.file)}`); throw error; }
  finally { closeSync(fd); }
}
async function superviseKernel(path: string, task?: string, interactive = false): Promise<void> {
  const { readRun, updateRun, pauseManaged } = context(task);
  const initial = readRun(path);
  let child: ReturnType<typeof spawn> | undefined, timer: ReturnType<typeof setInterval> | undefined;
  const controller = new AbortController();
  const cancelWatch = setInterval(() => { if (readRun(path).stopped) controller.abort(); }, 250);
  const interrupt = (): void => { controller.abort(); pauseManaged(path, "启动会话被中断；已有成果保留"); };
  for (const s of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(s, interrupt);
  try {
    updateRun(path, (r) => { r.activity = { id: randomUUID(), node: "开发评审", kind: "starting", pid: process.pid, started: processStartTime(process.pid) }; });
    const configuration = managedConfig(initial.worktree, initial.inputVersion === 2);
    const reasons: string[] = [];
    const guard = (includeIgnored: boolean): string => {
      const run = readRun(path);
      return JSON.stringify([workspaceGuard(run, undefined, includeIgnored), checkInputs(run, "开发评审").files]);
    };
    const preparation = configuration.preparation;
    let usedRecoveries = 0;
    if (preparation) {
      const statePath = join(initial.dir, "preparation-state.json");
      const state: PreparationState = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};
      const before = guard(false); // 补装可写 ignored 依赖，但不能改候选、本机文件或登记输入。
      let result;
      try {
        result = await runPreparation({ config: preparation, cwd: initial.worktree, state, exec: createChildExec(join(initial.dir, "review.procs.json")),
          runDir: join(initial.dir, "preparation"), signal: controller.signal, env: { ...process.env, AUTOREVIEW_BASE_REV: initial.base },
          saveState: () => writeFileSync(statePath, JSON.stringify(state)) });
      } finally { if (guard(false) !== before) throw new Error("准备过程改动候选/输入或稳定规则，未启动开发；保留用户成果"); }
      usedRecoveries = state.preparationAttempts?.environment ?? 0;
      if (result.blocked) throw new Error(result.reason);
      if (!result.ok) reasons.push(`准备未通过：${result.reason}；证据 ${result.log}`);
    }
    if (configuration.methods) {
      const before = guard(true);
      let result;
      try {
        result = await runMethodsSelfTest(initial.worktree, { loopRoot: ROOT, procsFile: join(initial.dir, "review.procs.json"), signal: controller.signal, env: { ...process.env, AUTOREVIEW_BASE_REV: initial.base, AUTOREVIEW_BATCH_FILE: initial.file, AUTOREVIEW_STAGE: taskDefinition(initial).name } });
      } finally { if (guard(true) !== before) throw new Error("方法自测改动候选/输入或稳定规则，未启动开发；请修正方法并保留用户成果"); }
      if (result.selfCheck && !result.selfCheck.passed) {
        const check = result.selfCheck, recovery = recoveryDecision(check.exitCode, check.output, preparation, usedRecoveries);
        reasons.push(`方法自测未通过；原始错误：${failureLine(check.exitCode, check.output)}；${recovery.allowed ? "本轮准备已结束，方法自检未额外补装" : recovery.reason}；剩余补装次数：${recovery.remaining}；下一步命令：cd ${shellQuote(initial.worktree)} && ${check.command}`);
      }
    }
    if (readRun(path).stopped || controller.signal.aborted) return;
    updateRun(path, (r) => {
      r.preparationStatus = { ready: !reasons.length, reasons, at: new Date().toISOString() };
      if (reasons.length && !r.session) {
        const file = join(r.dir, `start-${randomUUID()}.md`);
        writeFileSync(file, `【Loop 开工环境说明】\n环境未就绪（不阻断开发，不代表检查通过）：\n${reasons.join("\n")}\n\n以下为本卡原始任务：\n${readFileSync(taskDefinition(r).prompt, "utf8")}`, { mode: 0o600, flag: "wx" });
        r.preparationStatus.startupFile = file;
      }
    });
    writeKernelSummary(path);
    prepareManagedContinuation(path, task);
    const launch = managedLaunchArgs(path, task, interactive), token = randomUUID();
    child = spawn(launch.command, launch.args, { cwd: launch.cwd, env: { ...launch.env, AUTOREVIEW_PROCESS_OWNER: token, AUTOREVIEW_KERNEL_LAUNCH: token }, detached: true, stdio: "inherit" });
    await new Promise<void>((ok, no) => { child!.once("spawn", ok); child!.once("error", no); });
    const group = { pid: child.pid!, processStarted: processStartTime(child.pid!), token };
    updateRun(path, (r) => { r.launch = group; if (!r.session) r.activity = { id: randomUUID(), node: "开发评审", kind: "starting", pid: group.pid, started: group.processStarted }; });
    let stopping = false;
    const requested = Number(process.env.AUTOREVIEW_KERNEL_STARTUP_TIMEOUT_MS);
    const startupMs = Number.isFinite(requested) && requested > 0 ? Math.min(60_000, Math.max(50, requested)) : 60_000;
    const readyBy = Date.now() + startupMs;
    timer = setInterval(() => {
      const batch = readTaskRun(path), r = task ? taskView(batch, task) : batch;
      if (r.session?.launchId !== token && !r.stopped && Date.now() >= readyBy) pauseManaged(path, `启动未获宿主确认（${startupMs}ms）；请核对扩展/Hook、信任及 ${join(r.dir, "launch.log")}，然后 ${kernelCommand("续跑", r.file)}`);
      const deploymentPending = batch.card.flow.includes("部署") && batch.publication?.push === "成功" && !batch.deploymentAttempts?.at(-1)?.ended;
      const publicationSettled = batch.publication?.local === "merged" && !r.activity && !batch.activity && !deploymentPending;
      if (stopping || (!r.stopped && !publicationSettled)) return;
      stopping = true;
      void stopSessionGroup({ pid: group.pid, processStarted: group.processStarted }, false, group).finally(() => { stopping = false; });
    }, 500);
    const code = await new Promise<number | null>((ok) => child!.once("close", (status) => ok(status)));
    const current = readRun(path);
    const integrated = current.batch?.contributions.some((c) => c.task === current.taskId && c.candidate.commit === current.candidate?.commit);
    if (integrated && !current.activity) updateRun(path, (r) => { r.stopReason = "任务已汇入，等待统一验收或原会话返修"; });
    else if (!current.publication && !current.stopped) pauseManaged(path, `${!current.session || current.session.launchId !== token ? `启动失败（退出码 ${code}），未取得宿主会话身份；日志 ${join(current.dir, "launch.log")}` : `开发会话已退出（退出码 ${code}），节点不再执行`}；恢复入口：${kernelCommand("续跑", current.file)}`);
  } catch (error) { pauseManaged(path, `启动失败：${String(error)}；恢复入口：${kernelCommand("续跑", initial.file)}`); }
  finally {
    if (timer) clearInterval(timer); clearInterval(cancelWatch);
    for (const s of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.off(s, interrupt);
    if (readRun(path).publication?.local === "merged") await releaseKernelWorkspace(path);
    writeKernelSummary(path);
    await systemNotify(initial.taskRecords ? "Loop 批次" : "Loop 单任务", queryKernel(path).lines.join("\n"));
  }
}
export async function deliverManagedRepair(path: string, task?: string, workerRequest?: string): Promise<void> {
  const { readRun, updateRun } = context(task);
  const run = readRun(path), repair = run.repair;
  if (!repair || repair.state === "read" || !run.session) return;
  if (run.stopped || run.abandoned || run.userVersion !== repair.userVersion) return;
  const session = run.session, launch = run.launch;
  if (session.host === "pi" && session.log && launch && session.launchId === launch.token && session.pid === launch.pid
    && session.started === launch.processStarted && processStartTime(session.pid) === session.started) {
    if (repair.session !== session.id || repair.epoch !== run.epoch || repair.taskId !== run.taskId || repair.candidate.tree !== run.candidate?.tree
      || repair.inputs !== checkInputs(run, repair.node === "验收" || repair.node === "开发评审" ? "开发评审" : "测试").hash) throw new Error("原返修信封与当前任务/输入不匹配，未重新投递");
    // 原 Pi 的私有轮询自行核对信封并留已读回执；无需为投递消息取得 OS 杀组权限。
    if (repair.state === "unknown") updateRun(path, (r) => { if (r.repair?.id === repair.id && r.repair.state === "unknown") { r.repair.state = "pending"; r.stopReason = undefined; } });
    return;
  }
  const groupState = run.launch ? ownedProcessGroupAlive(run.launch) : undefined;
  if (groupState === false) {
    if (run.card.host === "pi" && (run.launchMode ?? "terminal") === "terminal") {
      const result = resumeTerminalTasks(path, false, spawnSync, task, workerRequest ? { request: workerRequest, repair: repair.id } : undefined);
      if (result.launchErrors.length || !result.opened.length) {
        updateRun(path, (r) => { if (r.repair?.id === repair.id) r.stopReason = `原 Pi 窗口返修接续未确认；未静默转后台。请核对原窗口/停止后：${kernelCommand("续跑", r.file, ...(task ? ["--task", taskDefinition(r).name] : []))}`; });
        await reportManaged(path);
      }
    } else await launchKernel(path, true, task);
    return;
  }
  if (run.session.host === "pi" && groupState === true) return; // session_start 的私有收件轮询负责接受。
  try {
    const native = run.native;
    if (groupState !== true || !native || native.launch !== run.session.launchId) throw new Error("原会话归属或原生通道未确认");
    const binding = JSON.parse(readFileSync(native.binding, "utf8"));
    if (binding.launch !== native.launch || binding.session !== run.session.id || binding.childPid !== native.childPid || binding.childStarted !== native.childStarted) throw new Error("原生收件身份不匹配");
    await sendNativeRepair({ command: native.command, host: run.session.host, cwd: run.worktree, env: process.env, sessionId: run.session.id,
      message: repair.message, id: repair.id, from: "loop-kernel", claude: binding.channel, childPid: native.childPid, childStarted: native.childStarted, signal: new AbortController().signal });
    updateRun(path, (r) => { if (r.repair?.id === repair.id && r.repair.state !== "read") r.repair.state = "sent"; });
  } catch (error) {
    updateRun(path, (r) => { if (r.repair?.id === repair.id && r.repair.state !== "read") { r.repair.state = "unknown"; r.stopReason = `返修投递未确认：${String(error)}；请精确恢复原会话：${kernelCommand("续跑", r.file)}`; } });
    await reportManaged(path);
  }
}
async function runManagedWorker(path: string, request: string, task?: string, deploymentRetry?: string): Promise<void> {
  const { readRun, updateRun, pauseManaged } = context(task);
  const controller = new AbortController();
  const stop = (): void => { controller.abort(); pauseManaged(path, "测试 worker 被中断，成果/证据保留"); };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, stop);
  try {
    if (readRun(path).workerRequest !== request) throw new Error("worker 派发身份过期");
    let before = readRun(path), output = await advanceManaged(path, { signal: controller.signal, task, deploymentRetry });
    for (;;) {
      const current = readRun(path);
      if (!output.stale || current.stopped || current.abandoned || current.activity || current.cardRevision === before.cardRevision) break;
      before = current; output = await advanceManaged(path, { signal: controller.signal, task, deploymentRetry });
    }
    if (output.message) await deliverManagedRepair(path, task, request);
  } catch (error) {
    const r = readRun(path);
    if (r.workerRequest === request && !r.activity) pauseManaged(path, String(error));
  } finally {
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.off(signal, stop);
    updateRun(path, (r) => { if (r.workerRequest === request) { r.workerRequest = undefined; if (r.worker?.pid === process.pid) r.worker = undefined; } });
    if (readRun(path).publication?.local === "merged" || readRun(path).card.nature === "评审") await releaseKernelWorkspace(path);
    writeKernelSummary(path);
  }
}
/** macOS Terminal 只执行短的私有脚本；请求先登记，原会话活动/未确认时不重复开窗。 */
export function resumeTerminalTasks(path: string, dryRun = false, execute: typeof spawnSync = spawnSync, task?: string, handoff?: { request: string; repair: string }): Record<string, any> {
  const run = readRun(path);
  if (run.card.nature !== "开发" || run.card.host !== "pi") throw new Error("可见开发窗口仅支持 Pi 开发卡；其他宿主请明确选择 --launcher background");
  if (process.platform !== "darwin") throw new Error("当前可见 Pi 窗口依赖 macOS Terminal；其他平台请明确选择 --launcher background");
  if (run.abandoned || run.publication || run.pendingCard || frozenCardProblem(run)) throw new Error(run.stopReason ?? "已有发布/放弃、待应用改卡或卡输入变化，未打开开发窗口");
  const ids = task ? [taskView(run, task).taskId ?? task] : taskIds(run);
  const opened: string[] = [], active: string[] = [], launchErrors: { task: string; reason: string; command: string }[] = [];
  for (const id of ids) {
    const unlock = eventLock(`${path}.${run.taskRecords ? id : "batch"}.launch.lock`);
    try {
      const r = readTaskRun(path, id), name = taskDefinition(r).name, command = kernelCommand("续跑", run.file, ...(run.taskRecords ? ["--task", name] : []));
      const ownHandoff = !!handoff && r.workerRequest === handoff.request && r.repair?.id === handoff.repair && r.repair.state !== "read"
        && r.repair.userVersion === r.userVersion && r.repair.epoch === (r.epoch ?? 0) && r.repair.candidate.tree === r.candidate?.tree
        && r.repair.session === r.session?.id && r.repair.host === r.session?.host && r.repair.taskId === r.taskId && !r.stopped && !r.activity && (!r.worker || ownedProcessGroupAlive(r.worker) === false
          || r.worker.pid === process.pid && r.worker.token === process.env.AUTOREVIEW_PROCESS_OWNER && ownedProcessGroupAlive(r.worker) === true);
      if (r.terminal?.state === "requested" || r.terminal?.state === "claimed" && (!r.terminal.owner || activityAlive({ ...r.terminal.owner, id: r.terminal.request, node: "开发评审", kind: "starting" }) !== false) || activityAlive(r.activity) !== false || [r.launch, r.supervisor, ...(ownHandoff ? [] : [r.worker])].some((g) => g && ownedProcessGroupAlive(g) !== false)) { active.push(name); continue; }
      const releaseProblem = managedReleaseProblem(path, r); if (releaseProblem) throw new Error(releaseProblem);
      if (dryRun) { opened.push(name); continue; }
      const request = randomUUID(), script = join(r.dir, `terminal-${request}.sh`);
      const quote = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`;
      // 不序列化凭证或整个环境；只传本次运行定位和已有启动器的显式覆盖项。
      const keys = ["AUTOREVIEW_KERNEL_ROOT", "AUTOREVIEW_LOCAL_QUEUE_ROOT", "AUTOREVIEW_RESOURCE_ROOT", "AUTOREVIEW_PROJECTS_ROOT", "LOOP_PA_CONFIG", "PI_BIN", "PI_CODING_AGENT_DIR", "PONYTAIL_EXTENSION", "AUTOREVIEW_REVIEWER_CMD", "AUTOREVIEW_EXPERIENCE_CMD"];
      writeFileSync(script, `#!/bin/sh\nexport PATH=${quote(dirname(process.execPath))}:"$PATH"\n${keys.filter((k) => process.env[k]).map((k) => `export ${k}=${quote(process.env[k]!)}`).join("\n")}\nexec ${[process.execPath, fileURLToPath(import.meta.url), "--terminal", path, run.id, request, r.taskId ?? ""].map(quote).join(" ")}\n`, { mode: 0o700, flag: "wx" });
      updateTaskRun(path, id, (r) => { r.launchMode = "terminal"; r.terminal = { request, at: new Date().toISOString(), script, state: "requested" }; r.stopped = false; r.stopReason = `已请求独立 Pi 窗口，等待宿主确认；未确认请核对窗口或先停止再 ${command}`; });
      if (run.taskRecords) updateRun(path, (r) => { r.stopped = false; });
      const result = execute("osascript", ["-e", 'on run argv\ntell application "Terminal" to do script (item 1 of argv)\ntell application "Terminal" to activate\nend run', `/bin/sh ${quote(script)}`], { encoding: "utf8", timeout: 15_000 });
      if (result.error || result.status !== 0) {
        const reason = `任务 ${name} 窗口未打开：${result.error || result.stderr || result.status}；未转后台`;
        updateTaskRun(path, id, (r) => { if (r.terminal?.request === request) { r.terminal.state = "failed"; r.terminal.reason = reason; r.stopped = true; r.stopReason = `${reason}；下一步：${command}`; } });
        launchErrors.push({ task: name, reason, command });
      } else opened.push(name);
    } catch (error) { launchErrors.push({ task: taskDefinition(readTaskRun(path, id)).name, reason: String(error), command: kernelCommand("续跑", run.file, ...(run.taskRecords ? ["--task", taskDefinition(readTaskRun(path, id)).name] : [])) }); }
    finally { unlock(); }
  }
  if (!dryRun) writeKernelSummary(path);
  return { ...queryKernel(path), ok: !launchErrors.length, dryRun, opened, active, launchErrors, lines: [`${dryRun ? "只读核对，未实际打开" : "已请求打开"}独立 Pi 窗口：${opened.join("、") || "无"}；活动或待确认任务未重复派工：${active.join("、") || "无"}`, ...launchErrors.map((e) => `${e.reason}；下一步：${e.command}`), ...queryKernel(path).lines] };
}
export async function resumeManaged(path: string, background = false, node?: string, dryRun = false, task?: string, terminal = false, launcher?: "terminal" | "background"): Promise<Record<string, any>> {
  const { readRun, updateRun, pauseManaged } = context(task);
  const initial = readRun(path);
  if (node && !["开发评审", "评审", "测试", "验收", "部署"].includes(node)) throw new Error("重跑仅接受 --node 开发评审|评审|测试|验收|部署；提交请用统一合入，不自动重推");
  if (initial.card.nature === "评审" && (node && node !== "评审" || task)) throw new Error("只评审只支持重跑 --node 评审（单任务不使用 --task），不会转成开发续跑");
  if (initial.card.nature !== "评审" && node === "评审") throw new Error("开发卡不能切换为只评审");
  if (node === "部署" && (!initial.card.flow.includes("部署") || task)) throw new Error("部署是已安排卡的批次级节点，不接受 --task");
  if (node && node !== "部署" && initial.publication) throw new Error("已发布后仅支持重跑部署；不能重新开发、检查、提交或推送");
  if (node === "验收" && task) throw new Error("验收为批次级，不接受 --task");
  if (initial.taskRecords && !task && node !== "验收" && !initial.publication) {
    if (dryRun) return queryKernel(path);
    const results = await Promise.allSettled(taskIds(initial).map((id) => resumeManaged(path, background, node, false, id, terminal, launcher)));
    const opened = results.flatMap((r) => r.status === "fulfilled" ? r.value.opened ?? [] : []);
    const active = results.flatMap((r) => r.status === "fulfilled" ? r.value.active ?? [] : []);
    const launchErrors = results.flatMap((r, i) => r.status === "rejected" ? [{ task: taskDefinition(taskView(initial, taskIds(initial)[i])).name, reason: String(r.reason), command: kernelCommand("续跑", initial.file, "--task", taskDefinition(taskView(initial, taskIds(initial)[i])).name) }] : r.value.launchErrors ?? []);
    const q = queryKernel(path);
    return { ...q, ok: results.every((r) => r.status === "fulfilled" && r.value.ok !== false), opened, active, launchErrors,
      lines: [...(terminal ? [`已请求可见窗口：${opened.join("、") || "无"}；活动/待确认任务未重派：${active.join("、") || "无"}`] : []), ...launchErrors.map((e: any) => `${e.task}：${e.reason}；下一步：${e.command}`), ...q.lines] };
  }
  if (initial.abandoned) throw new Error("已放弃，不恢复或重新派工");
  if (dryRun) return { ...queryKernel(path), dryRun: true, lines: ["只读核对，未启动节点或创建票据"] };
  if (readRun(path).batch?.pending) recoverBatchIntegration(path);
  applyPendingCardChange(path);
  if (task && readTaskRun(path, task).stopped && !readTaskRun(path, task).abandoned) updateTaskRun(path, undefined, (r) => { r.stopped = false; });
  if (!initial.publication && node !== "验收" && (!initial.taskRecords || task)) continueAcceptanceTask(path, task);
  let run = readRun(path);
  const postNode = run.card.nature === "评审" || !!run.publication;
  const launchMode = launcher ?? run.launchMode ?? (terminal ? "terminal" : "background"), visible = run.card.host === "pi" && launchMode === "terminal";
  if (run.publication) {
    const uncertain = deploymentUncertainty(run.deploymentAttempts?.at(-1)); if (uncertain) throw new Error(uncertain);
    if (run.publication.local === "intent" || !run.card.flow.includes("部署") || run.publication.push !== "成功") return launchKernel(path, background, task);
    const p = run.publication, deployed = validResult(run, "部署", { commit: p.commit, tree: p.tree }, checkInputs(run, "部署").hash);
    const local = gitText(run.repo, ["rev-parse", "refs/heads/dev"]);
    if (!deployed && local !== p.commit) throw new Error(`当前本地 dev ${local} 已不在本批发布 ${p.commit}；远端本次推送 ${p.remoteCommit ?? "未确认"}；保留回退/发布记录，不自动重发旧版本`);
  }
  if (node === "部署" && !run.publication) throw new Error("尚未成功发布，不能只重跑部署");
  if (frozenCardProblem(run)) throw new Error(frozenCardProblem(run));
  const releaseProblem = managedReleaseProblem(path, run); if (releaseProblem) throw new Error(releaseProblem);
  if (visible && (run.terminal?.state === "requested" || run.activity && activityAlive(run.activity) !== false)) return { ...queryKernel(path), active: [taskDefinition(run).name], opened: [], lines: ["原任务仍活动/待确认，不重复派工；请查看原窗口或查询状态", ...queryKernel(path).lines] };
  if (run.activity && activityAlive(run.activity) !== false) throw new Error("节点仍执行/排队或归属未确认，不重复派工");
  // 显式恢复开发评审停点的原活 Pi；只投递私有收件箱，不获得杀组/新开宿主权限。
  const scopeRecovery = !node && !postNode && run.taskRecords && run.taskId && run.stopped && (!run.blockedNode || run.blockedNode === "开发评审")
    && (dirtyPaths(run).length > 0 || !run.candidate || !validResult(run, "开发评审", run.candidate, checkInputs(run, "开发评审").hash));
  const session = run.session, launch = run.launch;
  if (scopeRecovery && session?.host === "pi" && session.log && launch && session.launchId === launch.token
    && session.pid === launch.pid && session.started === launch.processStarted && processStartTime(session.pid) === session.started) {
    if (run.workerRequest || run.worker && ownedProcessGroupAlive(run.worker) !== false || consumerProblem(join(run.dir, "review.procs.json"))
      || consumerProblem(join(run.dir, "review.procs.json.cleanup")) || readLocalQueue().items.some((t) => t.ledger === path && t.task === run.taskId)) throw new Error("原任务还有检查消费者或排队，不能投递开发续跑");
    updateRun(path, (r) => {
      if (pendingCardBlocks(r) || r.publication || r.abandoned || r.activity || r.epoch !== run.epoch || r.userVersion !== run.userVersion
        || r.session?.id !== session.id || r.session?.launchId !== session.launchId || processStartTime(session.pid) !== session.started) throw new Error("原会话/任务状态变化，未投递续跑");
      r.stopped = false; r.stopReason = undefined;
    });
    try {
      const pending = readRun(path).repair;
      const continuation = pending?.file === join(run.dir, `continue-${pending?.id}.md`) && pending.message.startsWith("【Loop 开发续跑】");
      if (pending && pending.state !== "read" && !continuation && (!["pending", "sent"].includes(pending.state)
        || pending.session !== session.id || pending.host !== session.host || pending.userVersion !== run.userVersion || pending.epoch !== run.epoch
        || pending.candidate.tree !== run.candidate?.tree || pending.taskId !== run.taskId
        || pending.inputs !== checkInputs(run, pending.node === "验收" || pending.node === "开发评审" ? "开发评审" : "测试").hash)) throw new Error("原未读返修信封与当前输入不匹配；保留原证据，未投递开发续跑");
      prepareManagedContinuation(path, task);
      const current = readRun(path), repair = current.repair;
      if (!repair || !["pending", "sent", "read"].includes(repair.state) || repair.session !== current.session?.id || repair.host !== current.session?.host
        || repair.userVersion !== current.userVersion || repair.epoch !== current.epoch || repair.candidate.tree !== current.candidate?.tree
        || repair.inputs !== checkInputs(current, repair.node === "验收" || repair.node === "开发评审" ? "开发评审" : "测试").hash
        || repair.taskId !== current.taskId) throw new Error("原未读返修信封与当前输入不匹配；保留原证据，未投递开发续跑");
    }
    catch (error) { pauseManaged(path, `原会话续跑准备失败：${String(error)}`); throw error; }
    writeKernelSummary(path);
    return { ...queryKernel(path), lines: ["续跑已放入原 Pi 私有收件箱；等待原会话核对已读，没有停止或新建宿主", ...queryKernel(path).lines] };
  }
  if (run.card.nature === "评审") {
    const valid = run.candidate && validResult(run, "评审", run.candidate, checkInputs(run, "评审").hash);
    if (valid) return { ...queryKernel(path), lines: ["同一受评对象与输入，复用原有效报告", ...queryKernel(path).lines] };
    if (!existsSync(run.worktree)) updateRun(path, (r) => { createWorkspace(r); r.workspaceCreated = true; r.release = { status: "未释放", details: [] }; });
  }
  let reviewed = postNode || node === "验收";
  if (!postNode && node !== "验收") try { reviewed = !!validResult(run, "开发评审", currentCandidate(run), checkInputs(run, "开发评审").hash); }
  catch (error) { if (node === "测试") throw error; }
  if (node === "测试" && !run.card.flow.includes("测试")) throw new Error("当前卡未安排测试");
  if (node === "测试" && !reviewed) throw new Error(`测试前缺当前开发评审；${kernelCommand("续跑", run.file)}`);
  if (node === "开发评审" && reviewed) return { ...queryKernel(path), lines: ["开发评审同树同输入，复用原通过结论", ...queryKernel(path).lines] };
  if (node === "验收" && !run.card.flow.includes("验收")) throw new Error("当前卡未安排验收");
  const last = postNode || node === "验收" ? undefined : run.results.filter((r) => r.node === "测试" && r.task === (run.taskId ?? taskDefinition(run).name)).at(-1);
  if (!postNode && (node === "开发评审" || !reviewed || !node && run.repair?.node === "验收" && run.acceptanceState?.plan?.waitFor?.some((w) => w.task === (run.taskId ?? taskDefinition(run).name) && w.candidate === run.candidate?.commit) || !node && run.card.flow.includes("测试") && last?.failure === "product" && run.repair?.attempt === last.id && run.repair.inputs === checkInputs(run, "测试").hash)) {
    updateRun(path, (r) => { r.stopped = false; });
    if (run.launch && ownedProcessGroupAlive(run.launch) === true && run.repair) { await deliverManagedRepair(path, task); return queryKernel(path); }
    if (visible) return resumeTerminalTasks(path, false, spawnSync, task);
    return launchKernel(path, run.card.host === "pi" ? true : background, task);
  }
  const request = randomUUID(), deploymentRetry = node === "部署" ? run.deploymentAttempts?.at(-1)?.id : undefined;
  updateRun(path, (r) => {
    if (r.worker && ownedProcessGroupAlive(r.worker) !== false || r.activity && activityAlive(r.activity) !== false) throw new Error("原 worker 仍活动或身份未知");
    r.stopped = false; r.stopReason = undefined; r.workerRequest = request;
    if (!postNode) { r.launchMode = launchMode; if (launcher === "background") r.terminal = undefined; }
  });
  run = readRun(path);
  if (!background) { await runManagedWorker(path, request, task, deploymentRetry); return queryKernel(path); }
  const token = randomUUID(), fd = openSync(join(run.dir, "node-worker.log"), "a", 0o600);
  try {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--advance", path, run.id, request, task ?? "", deploymentRetry ?? ""], { cwd: run.repo, detached: true,
      env: { ...process.env, AUTOREVIEW_PROCESS_OWNER: token }, stdio: ["ignore", fd, fd] });
    await new Promise<void>((ok, no) => { child.once("spawn", ok); child.once("error", no); });
    updateRun(path, (r) => { if (r.workerRequest === request) r.worker = { pid: child.pid!, processStarted: processStartTime(child.pid!), token }; });
    child.unref(); return { ...queryKernel(path), dispatched: request, lines: [`已派发节点 worker（不代表通过）：${request}`, `日志：${join(run.dir, "node-worker.log")}`, ...queryKernel(path).lines] };
  } catch (error) { pauseManaged(path, `节点派发失败：${String(error)}`); throw error; }
  finally { closeSync(fd); }
}
/** 已授权移出事务：先保存原 HEAD/ref，按任务身份停消费者，再允许边界重建。 */
export async function settleTaskRemoval(path: string): Promise<Record<string, any>> {
  const run = readRun(path), c = run.changes?.find((c) => c.id === run.pendingCard);
  if (!c?.removeTasks?.length) return queryKernel(path);
  for (const id of c.removeTasks) {
    updateRun(path, (r) => {
      if (r.pendingCard !== c.id || r.userVersion !== c.userVersion) throw new Error("移出意图/真实用户版本已变化");
      const t = r.taskRecords!.find((t) => t.id === id)!;
      const head = existsSync(t.worktree) ? gitText(t.worktree, ["rev-parse", "HEAD"]) : t.candidate?.commit;
      if (head && !t.abandonment) {
        const history = `refs/loop/kernel/${r.id}/removed/${id}/${c.id}`; gitText(r.repo, ["update-ref", history, head, "0".repeat(40)]);
        t.abandonment = { at: new Date().toISOString(), source: c.source, head, history };
      }
    });
    const stopped = await stopKernel(path, false, id);
    if (!stopped.ok) return { ...queryKernel(path), ok: false, reason: "移出任务资源停止未确认，事务与成果保留" };
  }
  applyPendingCardChange(path);
  for (const id of c.removeTasks) if (readRun(path).taskRecords!.find((t) => t.id === id)?.removed) await releaseKernelWorkspace(path, id);
  return queryKernel(path);
}
export async function abandonKernel(path: string, source: string, dryRun = false): Promise<Record<string, any>> {
  const run = readRun(path);
  if (dryRun) return { ...queryKernel(path), dryRun: true, lines: ["只读核对，未放弃、停止或删除成果"] };
  if (run.publication) { await stopKernel(path); await releaseKernelWorkspace(path); return queryKernel(path); }
  if (!run.abandoned) updateRun(path, (r) => {
    const head = existsSync(r.worktree) ? gitText(r.worktree, ["rev-parse", "HEAD"]) : r.candidate?.commit;
    const history = head ? `refs/loop/kernel/${r.id}/abandoned/${randomUUID()}` : undefined;
    if (history) gitText(r.repo, ["update-ref", history, head!, "0".repeat(40)]);
    r.abandonment = { at: new Date().toISOString(), source, head, history }; r.abandoned = true; r.stopped = true; r.epoch = (r.epoch ?? 0) + 1;
    for (const t of r.taskRecords ?? []) {
      const head = existsSync(t.worktree) ? gitText(t.worktree, ["rev-parse", "HEAD"]) : t.candidate?.commit;
      const history = head ? `refs/loop/kernel/${r.id}/abandoned/${t.id}/${randomUUID()}` : undefined;
      if (history) gitText(r.repo, ["update-ref", history, head!, "0".repeat(40)]);
      t.abandonment = { at: r.abandonment.at, source, head, history }; t.abandoned = true; t.stopped = true; t.epoch = (t.epoch ?? 0) + 1;
    }
  });
  const stopped = await stopKernel(path);
  await releaseKernelWorkspace(path); await reportManaged(path);
  return { ...queryKernel(path), ok: stopped.ok !== false && readRun(path).release.status === "已释放" };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , action, path, id] = process.argv;
  if (!["--supervise", "--advance", "--terminal"].includes(action) || readRun(path).id !== id) throw new Error("启动器身份不匹配");
  const terminal = async (): Promise<void> => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Pi 可见窗口需要独立交互终端，未静默转后台");
    const task = process.argv[6] || undefined;
    updateTaskRun(path, task, (r) => {
      if (r.stopped || r.abandoned || r.launchMode === "background" || r.terminal?.request !== process.argv[5] || r.terminal.state !== "requested") throw new Error("开窗请求过期/已认领，不重复启动");
      r.terminal.state = "claimed"; r.terminal.owner = { pid: process.pid, started: processStartTime(process.pid) };
    });
    await launchKernel(path, false, task, true);
  };
  void (action === "--terminal" ? terminal() : action === "--advance" ? runManagedWorker(path, process.argv[5], process.argv[6] || undefined, process.argv[7] || undefined) : superviseKernel(path, process.argv[5] || undefined)).catch((error) => { process.stderr.write(`${String(error)}\n`); process.exitCode = 1; });
}
