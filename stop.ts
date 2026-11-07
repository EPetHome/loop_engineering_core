/** 显式停止：只按持久身份结束独立进程组；仅释放其登记的资源，保留源码与证据。 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { batchInfo, batchInfoPath, canonicalBatchFile, eventReason, phasePath, pushEvent, writePhase, type BatchInfo, type PhaseRecord } from "./events.ts";
import { settleProjectExecution } from "./project-execution.ts";
import { registeredQueueBatch, stopQueueBatch, type QueueBatch } from "./merge-queue.ts";
import { readJson, statusPath, writeStageStatus, type StageStatus } from "./pipeline-core.ts";
import { ownedProcessGroupAlive, processStartTime, readProcs, releaseProc, stopSessionGroup } from "./procs.ts";
import { releaseRunResource, resourceRoot, type RunResource } from "./resources.ts";
import { gitResult, worktrees } from "./workspace.ts";
import { launchPath, type BatchLaunch } from "./launch.ts";

export async function stopBatch(file: string, options: { stage?: string; dryRun?: boolean } = {}): Promise<Record<string, unknown>> {
  const requested = batchInfo(file, process.cwd());
  const rejected = (text: string): Record<string, unknown> => ({ v: 1, ok: false, action: "停止", command: "停止", batch: resolve(file), dryRun: Boolean(options.dryRun),
    stopped: [], skipped: [{ path: requested.dir, reason: text }], resources: [], queueStatus: null, reason: eventReason(text), lines: [text] });
  const location = gitResult(dirname(file), ["rev-parse", "--show-toplevel"]);
  const fallback = location.status === 0 ? location : gitResult(process.cwd(), ["rev-parse", "--show-toplevel"]);
  const candidate = fallback.status === 0 ? registeredQueueBatch(fallback.stdout.trim(), file) : undefined;
  // 名称/分支相同还不够；只接受登记原文件及同仓库 worktree 内同一相对位置的别名。
  const registration = candidate && registeredAlias(fallback.stdout.trim(), candidate, file) ? candidate : undefined;
  const dir = registration?.dir ?? requested.dir;
  const metadata = batchInfoPath(dir), recorded = readJson<BatchInfo>(metadata);
  const allowed = [canonicalBatchFile(file), ...(registration ? [canonicalBatchFile(registration.file)] : [])];
  const matches = (path?: string): boolean => Boolean(path && allowed.includes(canonicalBatchFile(path)));
  if (!recorded?.batch?.file || !matches(recorded.batch.file) || canonicalBatchFile(recorded.dir) !== canonicalBatchFile(dir)
    || (registration && canonicalBatchFile(recorded.project) !== canonicalBatchFile(registration.project))) return rejected("批次归属不匹配或没有登记，未停止、未释放资源、未覆盖状态");
  const info = recorded;
  const binding = readFileSync(metadata, "utf8");
  const checkScope = (): void => { if (readFileSync(metadata, "utf8") !== binding) throw new Error("停止期间批次归属已变化，未继续操作状态或资源"); };
  if (options.stage && !info.stages.some((item) => item.stage === options.stage)) throw new Error(`批次没有段：${options.stage}`);
  const stages = info.stages.filter((item) => !options.stage || item.stage === options.stage);
  const stopped: Record<string, unknown>[] = [], skipped: Record<string, unknown>[] = [], resources: Record<string, unknown>[] = [];
  const registries = new Set<string>();
  const owners = new Map<number, string>();
  const reason = eventReason("已停止");
  const readTargets = () => [null, ...stages.map((item) => item.stage)].map((stage) => {
    const phase = readJson<PhaseRecord>(phasePath(info.dir, stage));
    const status = stage === null ? undefined : readJson<StageStatus>(statusPath(info.dir, stage));
    const launch = readJson<BatchLaunch>(launchPath(info.dir, stage));
    return { stage, phase, status, launch };
  });
  const validateTargets = (targets: ReturnType<typeof readTargets>): string | undefined => {
    for (const target of targets) {
      if (target.phase && !matches(target.phase.batchFile)) return "会话状态的批次归属无法核对，未停止";
      if (target.launch && (!matches(target.launch.batchFile) || target.launch.stage !== target.stage)) return "进程组登记的批次归属不匹配，未停止";
      if (target.status && !matches(target.status.batchFile)) {
        const session = target.phase?.session;
        const same = session && target.status.sessionId === session.id && (target.status.host ?? "pi") === session.host
          && target.status.pid === session.pid && target.status.processStarted === session.processStarted;
        if (!same) {
          // 迟到的旧 done 不用于身份、总结、资源或状态回写。
          if (!target.status.batchFile && !target.status.pid && target.phase?.session) target.status = undefined;
          else return "段状态的批次归属无法核对，未停止";
        }
      }
    }
    return undefined;
  };
  // 在任何信号、队列撤销或文件写入之前核对所有待用的状态与启动登记。
  let targets = readTargets();
  const invalid = validateTargets(targets);
  if (invalid) return rejected(invalid);
  checkScope();
  const queuePreview = registration ? stopQueueBatch(fallback.stdout.trim(), registration, true) : undefined;
  if (!targets.some((target) => target.phase?.session || target.status?.pid || target.launch) && !queuePreview?.deployments.length) return rejected("没有可核对的活动身份，未确认停止");
  // 范围核对通过后才撤销队列资格，阻止结束会话时的迟到 done 重新入队。
  const queue = registration ? stopQueueBatch(fallback.stdout.trim(), registration, options.dryRun) : { entries: [], procs: [], consumers: [], deployments: [] };
  // 队列恢复派发与停止共用发布锁；撤销后重取，不能漏掉撤销前刚登记的新开发组。
  targets = readTargets();
  const changed = validateTargets(targets);
  if (changed) return rejected(changed);
  // 部署有自己的监督组和逐条目的命令登记；不借用已完成开发会话的身份，也不停止同项目其他批次。
  for (const deployment of queue.deployments) {
    for (const executor of deployment.executors) {
      checkScope();
      const result = await stopSessionGroup(executor, options.dryRun, executor);
      const entry = { kind: "deployment", entry: deployment.entry, ...executor, ...result };
      if (result.stopped) stopped.push(entry); else skipped.push(entry);
    }
    if (deployment.unknown || deployment.inFlight) skipped.push({ kind: "deployment", entry: deployment.entry,
      reason: deployment.unknown ? "部署执行器身份不完整，后续动作已取消，释放与执行结果需核对" : "后续部署、检查和自动回退已取消；已启动动作的执行结果未确认，保留现场" });
  }
  for (const { stage, phase, status, launch } of targets) {
    checkScope();
    let session = phase?.session ?? (status?.pid ? { host: status.host ?? "pi", id: status.sessionId, pid: status.pid, processStarted: status.processStarted, runId: status.runId } : undefined);
    // 活动组只由取得运行权的执行器发布；发布组与 phase 之间的短暂窗口也不能沿用旧代次。
    let unconfirmed: string | undefined;
    if (launch?.active === true && launch.runId && session?.runId !== launch.runId) {
      const alive = ownedProcessGroupAlive(launch);
      if (alive === true) session = undefined;
      else if (alive === undefined) unconfirmed = `当前恢复组 ${launch.pid} 的归属未确认，未触碰`;
    }
    session ??= launch ? { host: stage === null && info.batch.recipe === "develop" ? "pipeline" : "launcher", id: launch.runId ?? launch.token,
      pid: launch.pid, processStarted: launch.processStarted, runId: launch.runId } : undefined;
    const group = launch && (!session?.runId || session.runId === launch.runId) ? launch : undefined;
    // 未记录编排身份的旧批次仍允许停止明确登记的段；不猜它的父进程。
    if (!session && (stage === null || (!phase && !status && !launch) || (queue.deployments.length && status?.event === "done"))) continue;
    const summary = phase?.evidence.summary ?? status?.summary;
    let result: Awaited<ReturnType<typeof stopSessionGroup>>;
    if (unconfirmed) result = { stopped: false, reason: unconfirmed };
    else if (!session || !["pi", "claude", "codex", "pipeline", "pipeline-launch", "review-only", "launcher"].includes(session.host) || !session.id) result = { stopped: false, reason: "宿主或会话身份登记不完整" };
    else result = await stopSessionGroup(session, options.dryRun, group);
    checkScope();
    const entry = { stage, session: session ?? null, ...(unconfirmed && launch ? { pid: launch.pid } : {}), ...result };
    if (result.stopped) {
      stopped.push(entry);
      if (session?.pid && session.processStarted) owners.set(session.pid, session.processStarted);
      if (summary?.endsWith(".md")) registries.add(`${summary.slice(0, -3)}.procs.json`);
      if (stage === null && session && ["pipeline", "pipeline-launch"].includes(session.host)) {
        registries.add(join(info.dir, "procs.json")); registries.add(join(info.dir, "prepare.procs.json"));
        for (const item of info.stages) registries.add(join(info.dir, `${item.stage.replace(/[/\\:*?"<>|\s]+/g, "_")}.prepare.procs.json`));
      }
      if (!options.dryRun && stage !== null && status) writeStageStatus({ dir: info.dir, stage }, { ...status, event: "paused", readyEpoch: undefined, candidate: undefined, pauseReason: "已停止" });
    } else skipped.push(entry);
    if (!options.dryRun) {
      const detail = { stopped: result.stopped, skipped: !result.stopped };
      writePhase(info, stage, "failed", { status: "failed", ...reason, session, evidence: phase?.evidence ?? (summary ? { summary } : {}), detail });
      if (stage !== null) pushEvent(info, stage, "failed", reason, phase?.evidence ?? {}, detail);
    }
  }
  // 共享队列登记只处理撤销时冻结的消费者，不能顺手杀掉接着运行的另一批消费者。
  for (const { path, proc } of queue.consumers) {
    checkScope();
    const released = options.dryRun ? undefined : releaseProc(path, proc.pgid, proc);
    resources.push({ path, pgid: proc.pgid, released: released ?? null });
    if (released === false) skipped.push({ path, pid: proc.pgid, reason: "队列或部署消费者释放未确认，保留登记" });
  }
  if (queue.procs.length && !options.dryRun) await sleep(500); // 等执行器观察停止并完成既有 finally。
  // 归属从资源记录的 owner 身份或上述确切登记文件取得；不按目录名/年龄猜会话。
  const root = resourceRoot();
  const registered: RunResource[] = [];
  if (existsSync(root)) for (const name of readdirSync(root).filter((name) => /^[0-9a-f-]+\.json$/.test(name))) {
    let resource: RunResource;
    try { resource = JSON.parse(readFileSync(join(root, name), "utf8")); } catch { continue; }
    if (!resource.procsFile || !["active", "cleanup-failed"].includes(resource.status)) continue;
    const queueResource = queue.entries.some((id) => resource.label === `merge-queue:${id}`)
      || (queue.procs.includes(resource.procsFile) && queue.deployments.some((item) => resource.label.startsWith(`deployment:${item.entry}:`)));
    if (!queueResource && !registries.has(resource.procsFile) && owners.get(resource.ownerPid) !== resource.ownerStarted) continue;
    registered.push(resource);
    if (!queueResource) registries.add(resource.procsFile);
  }
  for (const path of [...registries].flatMap((path) => [path, `${path}.cleanup`])) {
    for (const proc of readProcs(path)) {
      checkScope();
      const started = processStartTime(proc.pgid);
      if (started && started !== proc.started) {
        skipped.push({ path, pid: proc.pgid, reason: "登记进程启动时间不匹配，未触碰" }); continue;
      }
      const released = options.dryRun ? undefined : releaseProc(path, proc.pgid, proc);
      resources.push({ path, pgid: proc.pgid, released: released ?? null });
      if (released === false) skipped.push({ path, pid: proc.pgid, reason: "登记进程释放未确认或身份不匹配，保留" });
    }
  }
  for (const resource of registered) {
    checkScope();
    const result = options.dryRun ? resource : releaseRunResource(resource);
    resources.push({ id: resource.id, path: resource.dir, status: result.status, detail: result.detail });
    if (!options.dryRun && result.status === "cleanup-failed") skipped.push({ path: resource.dir, reason: result.detail });
  }
  // 宿主的既有信号收尾负责外部 cleanup；未确认的项目资源单列，不假称已经释放。
  for (const { phase } of targets) if (phase?.evidence.acceptance) {
    const path = join(phase.evidence.acceptance, "cleanup-task.json"), cleanup = readJson<{ status: string; reason?: string }>(path);
    if (cleanup && cleanup.status !== "released") skipped.push({ path, reason: `外部资源释放未确认：${cleanup.status}；${cleanup.reason ?? ""}` });
  }
  if (!options.dryRun && !skipped.length && fallback.status === 0) settleProjectExecution(fallback.stdout.trim(), [...registries, ...queue.procs]);
  const result = { v: 1, ok: skipped.length === 0, action: "停止", command: "停止", dryRun: Boolean(options.dryRun), batch: resolve(file),
    stage: options.stage ?? null, stopped, skipped, resources, queueStatus: queue.entries.length || queue.deployments.length ? "stopped" : null, queueEntries: queue.entries, reason };
  if (!options.dryRun) {
    const detail = { stage: options.stage ?? null, stopped, skipped, queueStatus: result.queueStatus };
    const previous = readJson<PhaseRecord>(phasePath(info.dir, null));
    checkScope();
    writePhase(info, null, "failed", { status: "failed", ...reason, evidence: previous?.evidence ?? {}, session: previous?.session, detail });
    pushEvent(info, null, "failed", reason, previous?.evidence ?? {}, detail);
  }
  return { ...result, lines: [`${options.dryRun ? "预览停止" : skipped.length ? "停止未完全确认" : "已停止"}：${info.batch.name}；会话 ${stopped.length} 个，未触碰/未确认 ${skipped.length} 项`,
    "工作区、分支、总结和证据保留", ...skipped.map((item) => JSON.stringify(item))] };
}

function registeredAlias(repo: string, batch: QueueBatch, file: string): boolean {
  const requested = canonicalBatchFile(file), source = canonicalBatchFile(batch.file);
  if (requested === source) return true;
  const inside = (root: string, path: string): string | undefined => {
    const rel = relative(canonicalBatchFile(root), path);
    return rel && rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(rel) ? rel : undefined;
  };
  const trees = worktrees(repo);
  const sourceRelative = trees.map((tree) => inside(tree.path, source)).find(Boolean);
  return Boolean(sourceRelative && trees.some((tree) => inside(tree.path, requested) === sourceRelative));
}
