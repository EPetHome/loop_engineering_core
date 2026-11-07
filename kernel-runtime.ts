/** 新卡会话启动/停止/释放；argv 直接 spawn，后台也不拼长终端输入。 */
import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, rmdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { activityAlive, atomicRun, readRun, updateRun } from "./node-ledger.ts";
import { currentCandidate, kernelCommand, queryKernel, writeKernelSummary } from "./kernel.ts";
import { assertWorkspace, dirtyPaths, fileDigest, frozenCardProblem, gitRaw, managedConfig, taskScopeBaseline, workspaceGuard } from "./kernel-workspace.ts";
import { ownedProcessGroupAlive, processStartTime, readProcs, reapProcs, stopSessionGroup } from "./procs.ts";
import { gitResult, gitText } from "./workspace.ts";
import { advanceManaged, pauseManaged, reportManaged } from "./kernel-session.ts";
import { createChildExec } from "./hosts/review-hook.ts";
import { runPreparation, type PreparationState } from "./preparation.ts";
import { systemNotify } from "./notify.ts";
import { eventLock } from "./events.ts";
import { applyPendingCardChange } from "./kernel-controls.ts";
import { checkInputs } from "./kernel-workspace.ts";
import { validResult } from "./node-ledger.ts";
import { consumerProblem, readLocalQueue, recoverLocalQueue, releaseLocalSlot } from "./local-node-queue.ts";
import { releaseProc } from "./procs.ts";
import { sendNativeRepair } from "./hosts/native-inbox.ts";

const ROOT = dirname(fileURLToPath(import.meta.url));
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
export function managedLaunchArgs(path: string): { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv } {
  const run = readRun(path), session = run.session;
  const args = ["开发", run.card.host, "--cwd", run.worktree];
  if (session) {
    if (session.host !== run.card.host || (session.host === "pi" && !session.log)) throw new Error("无法精确恢复原会话，保留候选；原 Pi 会话日志未登记");
    args.push("--session", session.host === "pi" ? session.log! : session.id);
    if (run.repair && run.repair.state !== "read") args.push(`@${run.repair.file}`);
  } else args.push(`@${run.card.tasks[0].prompt}`);
  return { command: join(ROOT, "bin/loop"), args, cwd: run.worktree, env: { ...process.env,
    LOOP_DIR: ROOT, AUTOREVIEW_KERNEL_REPAIR: run.repair?.id ?? "", AUTOREVIEW_KERNEL_LEDGER: path, AUTOREVIEW_KERNEL_RUN: run.id, AUTOREVIEW_SINGLE_NODE: "1",
    AUTOREVIEW_BATCH_FILE: "", AUTOREVIEW_STAGE: "", AUTOREVIEW_PIPELINE_DIR: "", AUTOREVIEW_PIPELINE_LAUNCH: "", AUTOREVIEW_BASE_REV: "" } };
}
/** 开发节点的受控基线整合：只引入可核对的 dev 来源，不改卡或扩大任务范围，不借旧评审放行新树。 */
export async function integrateKernel(path: string, dryRun = false): Promise<Record<string, any>> {
  const run = readRun(path);
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
      atomicRun(path, r); // 被中断也保留真实活动/证据，不伪造完成。
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
export async function releaseKernelWorkspace(path: string): Promise<void> {
  const run = readRun(path), reasons: string[] = [];
  if (run.publication?.local !== "merged" && !run.abandoned) return;
  if (run.activity) reasons.push("节点活动尚未结束");
  if (run.launch && ownedProcessGroupAlive(run.launch) !== false) reasons.push("原开发会话/工具进程释放未确认");
  if (run.session && !run.launch) reasons.push("宿主缺少本次独立进程组登记，归属与释放未确认");
  const procs = join(run.dir, "review.procs.json");
  reapKnownProcs(procs, reasons);
  if (run.worker && ownedProcessGroupAlive(run.worker) !== false) reasons.push("测试 worker 释放未确认");
  for (const attempt of run.results) reapKnownProcs(join(run.dir, "attempts", attempt.id, "test.procs.json"), reasons);
  if (readLocalQueue().items.some((t) => t.ledger === path)) reasons.push("本批本机槽/票据释放未确认");
  try {
    if (existsSync(run.worktree)) {
      assertWorkspace(run);
      if (run.abandoned) {
        if (dirtyPaths(run).length) reasons.push(`未保存成果保留：${dirtyPaths(run).join("、")}`);
        const head = gitText(run.worktree, ["rev-parse", "HEAD"]);
        if (!run.abandonment?.history || gitText(run.repo, ["rev-parse", run.abandonment.history]) !== head) reasons.push("放弃保留 ref 未覆盖当前 HEAD");
      } else currentCandidate(run);
      const unknown = gitRaw(run.worktree, ["ls-files", "--others", "-z"]).split("\0").filter(Boolean).filter((p) => !run.localFiles.includes(p));
      if (unknown.length) reasons.push(`未知归属文件保留：${unknown.join("、")}`);
      for (const p of run.localFiles) if (!existsSync(join(run.worktree, p)) || fileDigest(join(run.worktree, p)) !== run.localHashes[p]) reasons.push(`本机文件变更保留：${p}`);
      if (!reasons.length) {
        // 当前候选已留任务分支和 pre-squash ref；只强制移除核对为原样的登记本机文件。
        gitText(run.repo, ["-c", "core.hooksPath=/dev/null", "worktree", "remove", "--force", run.worktree]);
      }
    }
    if (existsSync(run.worktree)) reasons.push(`工作目录未释放：${run.worktree}`);
    else if (run.workspaceParentCreated) {
      try { rmdirSync(dirname(run.worktree)); } // 只删除明确登记且已空的本批父目录，不递归清理未知内容。
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") reasons.push(`本批父目录保留（未知内容或释放失败）：${dirname(run.worktree)}；${String(error)}`); }
    }
  } catch (error) { reasons.push(String(error)); }
  updateRun(path, (r) => { r.release = { status: reasons.length ? "未确认" : "已释放", details: reasons }; });
  writeKernelSummary(path);
}
export async function stopKernel(path: string, dryRun = false): Promise<Record<string, any>> {
  const initial = readRun(path);
  if (dryRun) return { ...queryKernel(path), dryRun: true, lines: ["只读核对，未停止、未删除候选或证据"] };
  if (initial.publication?.local === "merged" && initial.release.status === "已释放") return queryKernel(path);
  // 先撤销运行代次，迟到的模型返回无权推进。
  pauseManaged(path, "已停止：用户停止本任务，成果和证据保留；停止不是放弃");
  const details: string[] = [];
  for (const group of [initial.launch, initial.supervisor, initial.worker]) if (group) {
    const stopped = await stopSessionGroup({ pid: group.pid, processStarted: group.processStarted }, false, group);
    // 宿主退出会让启动器同时结束；释放边界竞争要重读身份，不能把已消失的原组误报未知。
    if (!stopped.stopped && ownedProcessGroupAlive(group) !== false) details.push(stopped.reason ?? "资源停止未确认");
  }
  const procs = join(initial.dir, "review.procs.json");
  for (let i = 0; i < 20 && readProcs(procs).length; i++) await sleep(100); // 等已取消执行器自行确认释放，不猜测身份。
  reapKnownProcs(procs, details);
  for (const ticket of readLocalQueue().items.filter((t) => t.ledger === path && t.run === initial.id)) {
    for (const file of [ticket.procs, `${ticket.procs}.cleanup`]) {
      const problem = consumerProblem(file);
      if (problem?.includes("损坏") || problem?.includes("未知归属")) { details.push(problem); continue; }
      for (const entry of readProcs(file)) if (!releaseProc(file, entry.pgid, entry)) details.push(`消费者释放未确认：${file}`);
    }
    releaseLocalSlot(ticket.id, ticket.token, !consumerProblem(ticket.procs) && !consumerProblem(`${ticket.procs}.cleanup`));
  }
  recoverLocalQueue();
  if (initial.publication?.local === "merged") {
    await releaseKernelWorkspace(path); return { ...queryKernel(path), ok: !details.length && readRun(path).release.status === "已释放" };
  }
  updateRun(path, (r) => { r.release = { status: "未释放", details: ["停止保留工作区、任务分支和全部证据", ...details] }; });
  writeKernelSummary(path); return { ...queryKernel(path), ok: details.length === 0 };
}
/** --launcher background 使用独立组；默认前台保持原生宿主终端。 */
export async function launchKernel(path: string, background = false): Promise<Record<string, any>> {
  const unlock = eventLock(`${path}.launch.lock`);
  try { return await launchKernelOwned(path, background); }
  finally { unlock(); }
}
async function launchKernelOwned(path: string, background: boolean): Promise<Record<string, any>> {
  const run = readRun(path), problem = frozenCardProblem(run);
  if (problem) throw new Error(problem);
  if (!run.publication || run.publication.local === "intent") {
    const active = activityAlive(run.activity);
    if (active === undefined) throw new Error("原活动归属无法确认，不能猜测重启；请先核对停止记录");
    if (active === false && [run.launch, run.supervisor].some((g) => g && ownedProcessGroupAlive(g) !== false)) {
      const stopped = await stopKernel(path);
      if (!stopped.ok) throw new Error(`原会话停止未确认：${JSON.stringify(stopped.release)}`);
    }
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
    await releaseKernelWorkspace(path); return queryKernel(path);
  }
  assertWorkspace(run);
  for (const group of [run.launch, run.supervisor]) if (group && ownedProcessGroupAlive(group) !== false) throw new Error("原会话/启动器仍活着或归属未确认，不重复启动；先停止");
  updateRun(path, (r) => { r.stopped = false; r.stopReason = undefined; });
  if (!background) { await superviseKernel(path); return queryKernel(path); }
  const token = randomUUID(), log = join(run.dir, "launch.log"), fd = openSync(log, "a", 0o600);
  try {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--supervise", path, run.id], { detached: true, cwd: run.repo,
      stdio: ["ignore", fd, fd], env: { ...process.env, AUTOREVIEW_PROCESS_OWNER: token } });
    await new Promise<void>((ok, no) => { child.once("spawn", ok); child.once("error", no); });
    const group = { pid: child.pid!, processStarted: processStartTime(child.pid!), token };
    updateRun(path, (r) => { r.supervisor = group; if (!r.activity && r.session?.launchId === run.session?.launchId) r.activity = { id: randomUUID(), node: "开发评审", kind: "starting", pid: group.pid, started: group.processStarted }; });
    child.unref();
    return { ...queryKernel(path), lines: [`已派发新卡；日志：${log}`, `查询：${kernelCommand("状态", run.file)}`, `停止：${kernelCommand("停止", run.file)}`] };
  } catch (error) { pauseManaged(path, `启动失败：${String(error)}；恢复入口：${kernelCommand("续跑", run.file)}`); throw error; }
  finally { closeSync(fd); }
}
async function superviseKernel(path: string): Promise<void> {
  const initial = readRun(path);
  let child: ReturnType<typeof spawn> | undefined, timer: ReturnType<typeof setInterval> | undefined;
  const controller = new AbortController();
  const cancelWatch = setInterval(() => { if (readRun(path).stopped) controller.abort(); }, 250);
  const interrupt = (): void => { controller.abort(); pauseManaged(path, "启动会话被中断；已有成果保留"); };
  for (const s of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(s, interrupt);
  try {
    updateRun(path, (r) => { r.activity = { id: randomUUID(), node: "开发评审", kind: "starting", pid: process.pid, started: processStartTime(process.pid) }; });
    const preparation = managedConfig(initial.worktree).preparation;
    if (preparation) {
      const statePath = join(initial.dir, "preparation-state.json");
      const state: PreparationState = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};
      const result = await runPreparation({ config: preparation, cwd: initial.worktree, state, exec: createChildExec(join(initial.dir, "review.procs.json")),
        runDir: join(initial.dir, "preparation"), signal: controller.signal, env: { ...process.env, AUTOREVIEW_BASE_REV: initial.base },
        saveState: () => writeFileSync(statePath, JSON.stringify(state)) });
      if (!result.ok) throw new Error(`准备阻塞：${result.reason}；证据 ${result.log}`);
    }
    if (readRun(path).stopped) return;
    const launch = managedLaunchArgs(path), token = randomUUID();
    child = spawn(launch.command, launch.args, { cwd: launch.cwd, env: { ...launch.env, AUTOREVIEW_PROCESS_OWNER: token, AUTOREVIEW_KERNEL_LAUNCH: token }, detached: true, stdio: "inherit" });
    await new Promise<void>((ok, no) => { child!.once("spawn", ok); child!.once("error", no); });
    const group = { pid: child.pid!, processStarted: processStartTime(child.pid!), token };
    updateRun(path, (r) => { r.launch = group; if (!r.session) r.activity = { id: randomUUID(), node: "开发评审", kind: "starting", pid: group.pid, started: group.processStarted }; });
    let stopping = false;
    const requested = Number(process.env.AUTOREVIEW_KERNEL_STARTUP_TIMEOUT_MS);
    const startupMs = Number.isFinite(requested) && requested > 0 ? Math.min(60_000, Math.max(50, requested)) : 60_000;
    const readyBy = Date.now() + startupMs;
    timer = setInterval(() => {
      const r = readRun(path);
      if (r.session?.launchId !== token && !r.stopped && Date.now() >= readyBy) pauseManaged(path, `启动未获宿主确认（${startupMs}ms）；请核对扩展/Hook、信任及 ${join(r.dir, "launch.log")}，然后 ${kernelCommand("续跑", r.file)}`);
      if (stopping || (!readRun(path).stopped && !(r.publication?.local === "merged" && !r.activity))) return;
      stopping = true;
      void stopSessionGroup({ pid: group.pid, processStarted: group.processStarted }, false, group).finally(() => { stopping = false; });
    }, 500);
    const code = await new Promise<number | null>((ok) => child!.once("close", (status) => ok(status)));
    const current = readRun(path);
    if (!current.publication && !current.stopped) pauseManaged(path, `${!current.session || current.session.launchId !== token ? `启动失败（退出码 ${code}），未取得宿主会话身份；日志 ${join(current.dir, "launch.log")}` : `开发会话已退出（退出码 ${code}），节点不再执行`}；恢复入口：${kernelCommand("续跑", current.file)}`);
  } catch (error) { pauseManaged(path, `启动失败：${String(error)}；恢复入口：${kernelCommand("续跑", initial.file)}`); }
  finally {
    if (timer) clearInterval(timer); clearInterval(cancelWatch);
    for (const s of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.off(s, interrupt);
    if (readRun(path).publication?.local === "merged") await releaseKernelWorkspace(path);
    writeKernelSummary(path);
    await systemNotify("Loop 单任务", queryKernel(path).lines.join("\n"));
  }
}
export async function deliverManagedRepair(path: string): Promise<void> {
  const run = readRun(path), repair = run.repair;
  if (!repair || repair.state === "read" || !run.session) return;
  if (run.stopped || run.abandoned || run.userVersion !== repair.userVersion) return;
  const groupState = run.launch ? ownedProcessGroupAlive(run.launch) : undefined;
  if (groupState === false) { await launchKernel(path, true); return; }
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
async function runManagedWorker(path: string, request: string): Promise<void> {
  const controller = new AbortController();
  const stop = (): void => { controller.abort(); pauseManaged(path, "测试 worker 被中断，成果/证据保留"); };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, stop);
  try {
    if (readRun(path).workerRequest !== request) throw new Error("worker 派发身份过期");
    let before = readRun(path), output = await advanceManaged(path, { signal: controller.signal });
    for (;;) {
      const current = readRun(path);
      if (!output.stale || current.stopped || current.abandoned || current.activity || current.cardRevision === before.cardRevision) break;
      before = current; output = await advanceManaged(path, { signal: controller.signal });
    }
    if (output.message) await deliverManagedRepair(path);
  } catch (error) {
    const r = readRun(path);
    if (r.workerRequest === request && !r.activity) pauseManaged(path, String(error));
  } finally {
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.off(signal, stop);
    updateRun(path, (r) => { if (r.workerRequest === request) { r.workerRequest = undefined; if (r.worker?.pid === process.pid) r.worker = undefined; } });
    if (readRun(path).publication?.local === "merged") await releaseKernelWorkspace(path);
    writeKernelSummary(path);
  }
}
export async function resumeManaged(path: string, background = false, node?: string, dryRun = false): Promise<Record<string, any>> {
  const initial = readRun(path);
  if (node && !["开发评审", "测试"].includes(node)) throw new Error("重跑仅接受 --node 开发评审|测试；提交请用统一合入，不自动重推");
  if (initial.abandoned) throw new Error("已放弃，不恢复或重新派工");
  if (dryRun) return { ...queryKernel(path), dryRun: true, lines: ["只读核对，未启动节点或创建票据"] };
  applyPendingCardChange(path);
  let run = readRun(path);
  if (run.publication) return launchKernel(path, background);
  if (frozenCardProblem(run)) throw new Error(frozenCardProblem(run));
  if (run.release.status === "未确认") throw new Error("资源释放未确认；先用停止入口核对，不能重跑抢槽");
  if (run.activity && activityAlive(run.activity) !== false) throw new Error("节点仍执行/排队或归属未确认，不重复派工");
  let reviewed = false;
  try { reviewed = !!validResult(run, "开发评审", currentCandidate(run), checkInputs(run, "开发评审").hash); }
  catch (error) { if (node === "测试") throw error; }
  if (node === "测试" && !run.card.flow.includes("测试")) throw new Error("当前卡未安排测试");
  if (node === "测试" && !reviewed) throw new Error(`测试前缺当前开发评审；${kernelCommand("续跑", run.file)}`);
  if (node === "开发评审" && reviewed) return { ...queryKernel(path), lines: ["开发评审同树同输入，复用原通过结论", ...queryKernel(path).lines] };
  const last = run.results.filter((r) => r.node === "测试").at(-1);
  if (node === "开发评审" || !reviewed || !node && run.card.flow.includes("测试") && last?.failure === "product" && run.repair?.attempt === last.id && run.repair.inputs === checkInputs(run, "测试").hash) {
    updateRun(path, (r) => { r.stopped = false; });
    if (run.launch && ownedProcessGroupAlive(run.launch) === true && run.repair) { await deliverManagedRepair(path); return queryKernel(path); }
    return launchKernel(path, background);
  }
  const request = randomUUID();
  updateRun(path, (r) => {
    if (r.worker && ownedProcessGroupAlive(r.worker) !== false || r.activity && activityAlive(r.activity) !== false) throw new Error("原 worker 仍活动或身份未知");
    r.stopped = false; r.stopReason = undefined; r.workerRequest = request;
  });
  run = readRun(path);
  if (!background) { await runManagedWorker(path, request); return queryKernel(path); }
  const token = randomUUID(), fd = openSync(join(run.dir, "node-worker.log"), "a", 0o600);
  try {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--advance", path, run.id, request], { cwd: run.repo, detached: true,
      env: { ...process.env, AUTOREVIEW_PROCESS_OWNER: token }, stdio: ["ignore", fd, fd] });
    await new Promise<void>((ok, no) => { child.once("spawn", ok); child.once("error", no); });
    updateRun(path, (r) => { if (r.workerRequest === request) r.worker = { pid: child.pid!, processStarted: processStartTime(child.pid!), token }; });
    child.unref(); return { ...queryKernel(path), dispatched: request, lines: [`已派发节点 worker（不代表通过）：${request}`, `日志：${join(run.dir, "node-worker.log")}`, ...queryKernel(path).lines] };
  } catch (error) { pauseManaged(path, `节点派发失败：${String(error)}`); throw error; }
  finally { closeSync(fd); }
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
  });
  const stopped = await stopKernel(path);
  await releaseKernelWorkspace(path); await reportManaged(path);
  return { ...queryKernel(path), ok: stopped.ok !== false && readRun(path).release.status === "已释放" };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , action, path, id] = process.argv;
  if (!["--supervise", "--advance"].includes(action) || readRun(path).id !== id) throw new Error("启动器身份不匹配");
  void (action === "--advance" ? runManagedWorker(path, process.argv[5]) : superviseKernel(path)).catch((error) => { process.stderr.write(`${String(error)}\n`); process.exitCode = 1; });
}
