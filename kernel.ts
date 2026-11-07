/** 内核：卡、显式任务身份、候选、统一节点结果。查询不迁移、不派工。 */
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, watch as watchFiles, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { inside, ownedCriteria, readDevelopmentCard, type NodeName } from "./development-card.ts";
import { parseAcceptanceConfig, readMarker } from "./config.ts";
import { eventLock } from "./events.ts";
import { gitResult, gitText } from "./workspace.ts";
import { activityAlive, atomicRun, finishAttempt, kernelRoot, ledgerPath, readRun, readTaskRun, repositoryIdentity, taskDefinition, taskIdentity, taskIds, taskView, updateRun, updateTaskRun, validResult, type Candidate, type KernelRun, type NodeResult } from "./node-ledger.ts";
import { assertWorkspace, checkInputs, createWorkspace, dirtyPaths, frozenCardProblem, localCopyPlan, managedConfig, workspaceGuard, fileDigest } from "./kernel-workspace.ts";
import { processStartTime } from "./procs.ts";
import { acquireLocalSlot, bindLocalResource, consumerProblem, localTicketView, releaseLocalSlot } from "./local-node-queue.ts";
import type { RunResource } from "./resources.ts";
export interface NodeInput { ledger: string; taskId?: string; attempt: string; evidenceDir: string; run: KernelRun; candidate: Candidate; inputs: string;
  signal?: AbortSignal; deadline?: number; procsFile?: string; registerResource?: (resource: RunResource) => void }
export interface NodeOutput { status: NodeResult["status"]; reason?: string; failure?: NodeResult["failure"]; evidence: string[]; operations: string[]; released: boolean; message?: string; stale?: boolean; acceptance?: NodeResult["acceptance"] }
export type NodeExecutor = (input: NodeInput) => Promise<NodeOutput>;
const stamp = (): string => new Date().toISOString();
export function createKernelRun(file: string, cwd: string, dryRun = false): { path: string; run?: KernelRun; lines: string[] } {
  const repo = realpathSync(gitText(cwd, ["rev-parse", "--show-toplevel"])); file = realpathSync(file);
  const parsed = readDevelopmentCard(file, repo); managedConfig(repo);
  if (parsed.card.flow.includes("验收") && !parseAcceptanceConfig(readMarker(repo).acceptance, repo, process.env)) throw new Error("验收节点缺少项目 acceptance 配置；命令行项目也须显式配置 acceptance:{}");
  const base = gitText(repo, ["rev-parse", `refs/heads/${parsed.card.base}`]), target = gitText(repo, ["rev-parse", "refs/heads/dev"]);
  const localFiles = localCopyPlan(repo, base), identity = repositoryIdentity(repo), path = ledgerPath(repo, file), id = randomUUID();
  const run: KernelRun = { v: 1, inputVersion: 2, cardRevision: 0, epoch: 0, counters: {}, changes: [], revision: 0, id, repo, common: identity.common, file, dir: dirname(path), card: parsed.card, cardHash: parsed.hash,
    base, targetAtStart: target, created: stamp(), branch: `chore/loop-${id}`, worktree: join(kernelRoot(), "worktrees", identity.key, id, "task"), workspaceCreated: false,
    localFiles, localHashes: Object.fromEntries(localFiles.map((p) => [p, fileDigest(join(repo, p))])), results: [], repairs: 0, userVersion: 0, userInputs: [], decisions: [], release: { status: "未释放", details: [] } };
  if (run.card.tasks.length > 1) {
    run.worktree = join(kernelRoot(), "worktrees", identity.key, id, "batch", "worktree");
    run.batch = { version: 0, contributions: [], integrations: [], removed: [] };
    run.taskRecords = run.card.tasks.map((task) => { const tid = randomUUID(); return { id: tid, name: task.name, definition: task, dir: join(run.dir, "tasks", tid),
      branch: `chore/loop-${id}-${tid}`, worktree: join(kernelRoot(), "worktrees", identity.key, id, tid, "task"), workspaceCreated: false,
      repairs: 0, userVersion: 0, userInputs: [], epoch: 0, counters: {}, release: { status: "未释放", details: [] } }; });
  }
  if (run.card.acceptance) {
    const standard = ownedCriteria(run.card.acceptance, run.card.tasks.map((t) => t.name));
    run.acceptanceState = { criteria: { source: "用户", items: standard.items, version: 1, updatedAt: run.created }, hash: standard.hash, owners: standard.owners, round: 0 };
  }
  const checked = checkInputs(run);
  for (const [key, path] of Object.entries(checked.paths).filter(([key]) => key.startsWith("验收方法/原目录/") && !key.endsWith("/"))) {
    if (inside(repo, path)) {
      const rel = relative(repo, path);
      if (gitResult(repo, ["cat-file", "-e", `${base}:${rel}`]).status !== 0 && !localFiles.includes(rel)) throw new Error(`验收方法未在开工树或 localFiles 登记：${path}；请先登记，未创建分支/目录`);
    }
  }
  for (const tid of run.taskRecords ? taskIds(run) : []) checkInputs(taskView(run, tid));
  if (dryRun) return { path, lines: ["开发卡及配置核对通过；未建目录/分支，未启动模型", `目标 dev；开工依据 ${base}`, ...run.card.tasks.map((t) => `${t.name} 测试：${run.card.flow.includes("测试") ? `已安排 ${t.test}（未执行）` : "没验证（本次未安排）"}`), `验收：${run.card.flow.includes("验收") ? "已安排，全部到齐后统一执行" : "没验证（本次未安排）"}`] };
  const unlock = eventLock(`${path}.start.lock`);
  try {
    if (existsSync(path)) throw new Error(`本卡已有登记，不重复开工；请用 ${kernelCommand("状态", file)} 或 ${kernelCommand("续跑", file)}`);
    atomicRun(path, run); writeFileSync(join(run.dir, "frozen-card.json"), parsed.content, { flag: "wx", mode: 0o600 });
    try {
      createWorkspace(run); run.workspaceCreated = true;
      run.candidate = { commit: base, tree: gitText(run.repo, ["rev-parse", `${base}^{tree}`]) };
      for (const task of run.taskRecords ?? []) {
        mkdirSync(task.dir, { recursive: true, mode: 0o700 }); createWorkspace(taskView(run, task.id));
        task.workspaceCreated = true; task.workspaceParentCreated = true; task.candidate = { ...run.candidate };
      }
      checkInputs(run); atomicRun(path, run);
    } catch (error) { run.workspaceCreated = existsSync(join(run.worktree, ".git")); run.stopReason = `创建失败：${String(error)}`; run.stopped = true; atomicRun(path, run); throw error; }
    writeKernelSummary(path); return { path, run, lines: [`已创建隐藏${run.taskRecords ? "批次及独立任务" : "任务"}空间：${run.worktree}`, `批次分支：${run.branch}`] };
  } finally { unlock(); }
}
export function kernelCommand(action: string, file: string, ...args: string[]): string {
  const quote = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`, probe = gitResult(dirname(file), ["rev-parse", "--show-toplevel"]);
  return `cd ${quote(probe.status === 0 ? probe.stdout.trim() : process.cwd())} && ${[join(dirname(fileURLToPath(import.meta.url)), "bin", "loop"), action, file, ...args].map(quote).join(" ")}`;
}
export function currentCandidate(run: KernelRun): Candidate {
  if (!run.candidate) throw new Error("没有登记候选；请续跑原开发会话并交付");
  if (run.release.status === "已释放") return run.candidate;
  assertWorkspace(run);
  if (dirtyPaths(run).length) throw new Error(`有未提交/未跟踪/索引变化，不能放行旧候选：${dirtyPaths(run).join("、")}`);
  const commit = gitText(run.worktree, ["rev-parse", "HEAD"]), tree = gitText(run.worktree, ["rev-parse", "HEAD^{tree}"]);
  if (tree !== run.candidate.tree) throw new Error(`候选树已变化：登记 ${run.candidate.tree}，当前 ${tree}；原会话重新交付`);
  return { commit, tree };
}
/** 汇总树必须仍是登记装配结果；检查欠项可以例外，未知/丢失的代码来源不可以。 */
export function batchAssemblyProblem(run: KernelRun): string | undefined {
  if (!run.batch) return undefined;
  if (run.batch.pending) return "批次集成事务未确认，保留原映射并停止推进";
  const last = run.batch.integrations.at(-1);
  if (!last) return run.batch.contributions.length || run.candidate?.commit !== run.base ? "批次没有可证明的装配记录" : undefined;
  if (last.after.commit !== run.candidate?.commit || last.after.tree !== run.candidate?.tree || JSON.stringify(last.mapping) !== JSON.stringify(run.batch.contributions)) return "批次汇总树/任务映射与登记装配记录不一致";
  return undefined;
}
export function contributionProblems(run: KernelRun, requireChecks = true): string[] {
  if (!run.batch) return [];
  const missing: string[] = [], assembly = batchAssemblyProblem(run);
  if (assembly) missing.push(assembly);
  if (JSON.stringify(run.batch.integrations.at(-1)?.targetSource) !== JSON.stringify(run.batch.targetSource)) missing.push("当前 dev 来源尚未装配进批次");
  for (const tid of taskIds(run)) {
    const task = taskView(run, tid), contribution = run.batch.contributions.find((c) => c.task === tid);
    try {
      const candidate = currentCandidate(task);
      if (task.activity) throw new Error("任务仍有开发/检查、排队或未结清尝试；不能把旧候选当作本轮已就绪");
      if (!contribution || contribution.candidate.commit !== candidate.commit || contribution.candidate.tree !== candidate.tree || contribution.epoch !== (task.epoch ?? 0) || contribution.userVersion !== task.userVersion) throw new Error("当前候选尚未有效汇入批次");
      for (const node of ["开发评审", ...(run.card.flow.includes("测试") ? ["测试"] : [])] as NodeName[]) {
        const hash = checkInputs(task, node).hash, result = validResult(task, node, candidate, hash);
        if (contribution.inputs[node] !== hash) throw new Error(`${node} 输入版本映射已失效`);
        if (requireChecks && (!result || !contribution.checks.includes(result.id))) throw new Error(`${node} 结论映射已失效`);
      }
    } catch (error) { missing.push(`${taskDefinition(task).name} / 集成：${String(error)}；补救：${kernelCommand("续跑", run.file, "--task", taskDefinition(task).name)}`); }
  }
  if (run.batch.contributions.some((c) => !taskIds(run).includes(c.task))) missing.push("批次仍含已移出任务的贡献");
  return missing;
}
export function qualification(run: KernelRun): { candidate?: Candidate; inputs?: string; missing: string[] } {
  const missing: string[] = [], problem = frozenCardProblem(run); if (problem) missing.push(problem);
  let candidate: Candidate | undefined, inputs: string | undefined;
  try { candidate = currentCandidate(run); } catch (e) { missing.push(String(e)); }
  try { inputs = checkInputs(run).hash; } catch (e) { missing.push(String(e)); }
  const before = run.card.flow.includes("提交") ? run.card.flow.slice(0, run.card.flow.indexOf("提交")) : run.card.flow;
  for (const node of before) {
    const views = run.taskRecords && ["开发评审", "测试"].includes(node) ? taskIds(run).map((id) => taskView(run, id)) : [run];
    for (const view of views) {
      let c: Candidate | undefined, hash: string | undefined;
      try { c = currentCandidate(view); hash = checkInputs(view, node).hash; } catch { /* 具体输入缺项在上文/贡献核对 */ }
      if (!c || !hash || !validResult(view, node, c, hash)) {
        const name = node === "验收" ? "批次" : taskDefinition(view).name;
        missing.push(`${name} / ${node} / 树 ${c?.tree ?? view.candidate?.tree ?? "无候选"}：缺少当前输入的有效通过结论（旧结论不可放行）；补救：${kernelCommand(node === "开发评审" ? "续跑" : "重跑", run.file, ...(node === "开发评审" ? [] : ["--node", node, "--json"]), ...(view.taskId ? ["--task", name] : []))}`);
      }
    }
  }
  missing.push(...contributionProblems(run));
  return { candidate, inputs, missing };
}
export function provenExternalMerge(run: KernelRun): string | undefined {
  if (!run.candidate || run.publication?.local === "merged") return undefined;
  if (run.candidate.commit !== run.base && gitResult(run.repo, ["merge-base", "--is-ancestor", run.candidate.commit, "refs/heads/dev"]).status === 0) return run.candidate.commit;
  return gitText(run.repo, ["log", "--format=%H %T", "refs/heads/dev"]).split("\n").map((l) => l.split(" ")).find(([c, t]) => t === run.candidate!.tree && c !== run.base)?.[0];
}
export function testRemedies(run: KernelRun): string[] {
  const task = run.taskId ? ["--task", taskDefinition(run).name] : [];
  const node = run.blockedNode === "验收" ? "验收" : "测试";
  return [kernelCommand("重跑", run.file, "--node", node, ...task, "--json"), kernelCommand("改卡", run.file, "--remove-node", node, "--json"), kernelCommand("放弃", run.file, "--json")];
}
export function nodeCheckLines(run: KernelRun): string[] {
  return (["开发评审", "测试", "验收", "部署"] as NodeName[]).flatMap((node) => {
    if (!run.card.flow.includes(node)) return [`${node === "开发评审" ? "评审" : node}：没验证（本次未安排）`];
    const views = run.taskRecords && ["开发评审", "测试"].includes(node) ? taskIds(run).map((id) => taskView(run, id)) : [run];
    return views.map((view) => {
      const identity = ["验收", "提交"].includes(node) && run.taskRecords ? run.id : taskIdentity(view);
      const last = [...run.results].reverse().find((r) => r.node === node && r.task === identity);
      let valid = false;
      try {
        const p = run.publication;
        if (p?.local === "merged") {
          const taskCheck = p.taskChecks?.find((c) => c.task === view.taskId), bound = taskCheck ? taskCheck.checks.find((c) => c.node === node) : p.nodeChecks?.[node];
          valid = !!bound?.result && validResult(view, node, taskCheck?.candidate ?? p.candidate, bound.inputs)?.id === bound.result;
          if (!p.nodeChecks && run.inputVersion !== 2) valid = !!validResult(view, node, p.candidate, p.inputs);
        } else valid = !!view.candidate && !!validResult(view, node, view.candidate, checkInputs(view, node).hash);
      } catch { /* 不补造通过 */ }
      return `${view.taskId ? `${taskDefinition(view).name} / ` : ""}${node === "开发评审" ? "评审" : node}：${valid ? "通过" : last ? `${last.status === "通过" ? "没验证（旧通过已失效）" : last.status}；${last.reason ?? "旧结论对当前输入无效"}` : "没验证（尚未执行）"}`;
    });
  });
}
export function queryKernel(path: string): Record<string, any> {
  const run = readRun(path), external = provenExternalMerge(run), alive = activityAlive(run.activity);
  const publication = run.publication ? { ...run.publication, push: run.publication.push === "进行中" && (run.stopped || alive !== true) ? "未确认" : run.publication.push, recordedPush: run.publication.push } : null;
  const merged = run.publication?.local === "merged" || (run.publication?.local === "intent" && gitResult(run.repo, ["merge-base", "--is-ancestor", run.publication.commit, "refs/heads/dev"]).status === 0);
  const q = merged ? { missing: run.decisions.find((d) => d.id === run.publication?.decision)?.missing ?? [] } : qualification(run);
  const tasks = taskIds(run).map((id) => {
    const t = taskView(run, id), a = t.activity, live = activityAlive(a);
    let queue; if (a?.ticket) { try { queue = localTicketView(a.ticket); } catch { /* 只读 */ } }
    return { id, name: taskDefinition(t).name, status: !t.stopped && live === true && a?.kind !== "waiting" ? "进行中" : "等你决定", node: a?.node ?? t.blockedNode ?? "开发评审",
      reason: a?.kind === "waiting" && live ? `本机排队第 ${queue?.position ?? "未知"} 位（自动等待，无需操作）` : t.stopReason ?? (a && live !== true ? "登记节点已不执行或身份无法确认" : "无节点执行"),
      activity: !t.stopped && live ? a : null, processIdentity: live === undefined ? "未确认" : live ? "存活" : "无活动", queue, candidate: t.candidate, branch: t.branch, worktree: t.worktree, session: t.session,
      integrated: !!run.batch?.contributions.some((c) => c.task === id && c.candidate.commit === t.candidate?.commit), counters: { ...t.counters, 开发评审: { repairs: t.repairs, recoveries: 0 } }, release: t.release, repairReceipt: t.repair };
  });
  const active = !run.stopped && ([run.activity, ...(run.taskRecords ?? []).map((t) => t.activity)].some((a) => activityAlive(a) === true && a?.kind !== "waiting"));
  const submission = [...run.results].reverse().find((r) => r.node === "提交"), blockedPublication = submission && submission.status !== "通过" && submission.reason === run.stopReason;
  const status = merged || external ? "已合入" : run.abandoned ? "已放弃" : active ? "进行中" : blockedPublication || q.missing.length ? "等你决定" : "可合入";
  const first = tasks.find((t) => t.activity) ?? tasks.find((t) => t.reason !== "无节点执行") ?? tasks[0];
  const node = run.activity?.node ?? (merged ? "提交" : run.blockedNode ?? first?.node ?? "开发评审");
  const reason = external ? "已合入（Loop 外）；没有伪造检查通过，远端与释放需另行核实" : merged ? `已合入（本地）；推送：${publication?.push ?? "未确认"}；${publication?.push === "未确认" ? "推送执行已不活动或归属未确认，远端结果未知，不自动重试；" : ""}${run.publication?.reason ?? ""}` : run.stopReason || (first?.reason !== "无节点执行" ? first?.reason : undefined) || q.missing[0] || "卡上前置结论均有效";
  let queue; if (run.activity?.ticket) { try { queue = localTicketView(run.activity.ticket); } catch { /* 只读 */ } } else queue = first?.queue;
  const acceptanceItems = run.acceptanceState?.criteria.items.map((item) => {
    const owner = run.acceptanceState!.owners[item.id], removed = (run.batch?.removed ?? []).some((t) => t.name === owner);
    const result = run.acceptanceState!.previous?.items.find((i) => i.id === item.id);
    return { ...item, owner, status: removed ? "没验证（任务移出本批）" : result?.verdict ?? "没验证", binding: run.acceptanceState!.bindings?.[item.id], source: result?.source };
  }) ?? [];
  const checks = nodeCheckLines(run), attempts: any[] = [];
  for (const dir of [run.dir, ...(run.taskRecords ?? []).map((t) => t.dir)]) {
    const root = join(dir, "attempts"); if (!existsSync(root)) continue;
    for (const d of readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && /^[0-9a-f-]{36}$/.test(d.name))) {
      const request = join(root, d.name, "attempt.json"), result = run.results.find((r) => r.id === d.name);
      try { attempts.push({ ...JSON.parse(readFileSync(request, "utf8")), status: result?.status ?? "结果未确认", evidence: request }); } catch { attempts.push({ id: d.name, status: "尝试记录无法读取", evidence: request }); }
    }
  }
  const lines = [`${status}：${run.card.name} / ${run.taskRecords ? "批次" : first?.name} / ${node}`, reason,
    ...(run.taskRecords ? tasks.map((t) => `${t.name} / ${t.node}：${t.status}；${t.reason}；汇入 ${t.integrated ? "已汇入" : "未汇入"}；资源 ${t.release.status}`) : []), ...q.missing, ...checks, ...acceptanceItems.map((i) => `${i.id} / ${i.owner ?? "人工"}：${i.status}${i.binding ? `；原实测树 ${i.binding.tree} / 第 ${i.binding.round} 轮；${i.binding.reason ?? "实测"}` : ""}`),
    ...(blockedPublication && !merged ? [`处理上述原因后：${kernelCommand(run.publication ? "续跑" : "合入", run.file)}`] : []),
    ...(!merged ? taskIds(run).flatMap((id) => { const t = taskView(run, id); return t.blockedNode === "测试" && t.stopped ? testRemedies(t) : []; }) : []),
    ...(run.blockedNode === "验收" && run.stopped && !merged ? testRemedies(run) : []), `资源：${run.release.status}；${run.release.details.join("；")}`, `总结：${join(run.dir, "summary.md")}`];
  return { ok: true, kernel: 1, id: run.id, card: run.file, name: run.card.name, status, task: run.taskRecords ? "批次" : first?.name, tasks, node, reason, checks, queue, counters: { ...run.counters, 开发评审: { repairs: run.repairs, recoveries: 0 } }, limits: run.card.limits,
    cardRevision: run.cardRevision ?? 0, pendingCardChange: run.pendingCard ?? null, cardChanges: run.changes ?? [], repairReceipt: run.repair, abandonment: run.abandonment, candidate: run.candidate, missing: q.missing,
    activity: alive && !run.stopped ? run.activity : null, externalMerge: external ?? null, publication, release: run.release, notes: run.notes ?? [], decisions: run.decisions, controlDecisions: run.controlDecisions ?? [], integrations: run.batch?.integrations ?? run.integrations ?? [], acceptance: run.acceptanceState, acceptanceItems, removedTasks: run.batch?.removed ?? [], attempts, results: run.results, summary: join(run.dir, "summary.md"), ledger: path, lines };
}
export async function executeNode(path: string, node: NodeName, executor: NodeExecutor, options: { signal?: AbortSignal; localSlot?: boolean; task?: string } = {}): Promise<NodeOutput> {
  const task = options.task, read = () => readTaskRun(path, task), change = <T>(cb: (r: KernelRun) => T) => updateTaskRun(path, task, cb);
  const initial = read(), problem = frozenCardProblem(initial);
  if (problem) { change((r) => { r.stopped = true; r.stopReason = problem; }); throw new Error(problem); }
  if (initial.stopped || initial.abandoned || initial.pendingCard) throw new Error("任务已停止、放弃或有待应用改卡，不能自动推进");
  if (["开发评审", "测试"].includes(node)) taskDefinition(initial);
  if (node !== "提交" && !initial.card.flow.includes(node)) throw new Error(`卡上未安排 ${node}`);
  const candidate = currentCandidate(initial), inputs = checkInputs(initial, node).hash;
  if (node === "测试" && !validResult(initial, "开发评审", candidate, checkInputs(initial, "开发评审").hash)) throw new Error("测试只能在当前开发评审通过之后执行");
  if (node === "验收" && contributionProblems(initial).length) throw new Error(contributionProblems(initial).join("\n"));
  if (node === "验收" && !initial.taskRecords) for (const prerequisite of ["开发评审", ...(initial.card.flow.includes("测试") ? ["测试"] : [])] as NodeName[]) {
    if (!validResult(initial, prerequisite, candidate, checkInputs(initial, prerequisite).hash)) throw new Error(`验收缺当前 ${prerequisite} 通过结论`);
  }
  const previous = validResult(initial, node, candidate, inputs);
  if (previous) return { status: "通过", evidence: previous.evidence, operations: ["同树、同输入复用原结论"], released: true, acceptance: previous.acceptance };
  const id = randomUUID(), token = randomUUID(), started = stamp(), guard = workspaceGuard(initial), epoch = initial.epoch ?? 0;
  const evidenceDir = join(initial.dir, "attempts", id), procsFile = join(evidenceDir, "test.procs.json");
  const run = change((r) => {
    if (r.stopped || r.abandoned || r.pendingCard || (r.epoch ?? 0) !== epoch) throw new Error("执行控制版本变化");
    if (r.userVersion !== initial.userVersion || checkInputs(r, node).hash !== inputs || workspaceGuard(r) !== guard) throw new Error("节点启动边界候选或输入变化，未调用执行器");
    if (r.activity && r.activity.kind !== "developing" && activityAlive(r.activity) !== false) throw new Error("节点已有活动尝试或归属未确认，未并发执行");
    r.candidate = candidate; r.blockedNode = node;
    r.activity = { id, node, kind: options.localSlot ? "waiting" : node === "开发评审" ? "reviewing" : "submitting", pid: process.pid, started: processStartTime(process.pid), ...(options.localSlot ? { procs: procsFile, ticket: id } : {}) };
    return structuredClone(r);
  });
  mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
  const identity = node === "验收" || node === "提交" ? run.taskRecords ? run.id : taskIdentity(run) : taskIdentity(run);
  const request = join(evidenceDir, "attempt.json"); writeFileSync(request, JSON.stringify({ id, node, task: identity, candidate, inputs, started, epoch }, null, 2));
  const controller = new AbortController(), abort = (): void => controller.abort();
  let changed = false;
  const invalidate = (): void => { changed = true; controller.abort(); };
  let fileWatch: ReturnType<typeof watchFiles> | undefined, indexWatch: ReturnType<typeof watchFiles> | undefined;
  if (options.signal?.aborted) controller.abort(); else options.signal?.addEventListener("abort", abort, { once: true });
  const live = (): void => { const r = read(); if (changed || r.stopped || r.abandoned || r.activity?.id !== id || r.userVersion !== run.userVersion || (r.epoch ?? 0) !== epoch || checkInputs(r, node).hash !== inputs) throw new Error("节点已取消或用户/控制/输入版本变化"); };
  const watch = setInterval(() => { try { live(); } catch { controller.abort(); } }, 100);
  let output: NodeOutput, acquired = false, invoked = false;
  try {
    fileWatch = watchFiles(run.worktree, { recursive: true }, invalidate);
    const index = gitText(run.worktree, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
    indexWatch = watchFiles(dirname(index), (_event, file) => { if (file === "index" || file === "index.lock") invalidate(); });
    if (options.localSlot) {
      await acquireLocalSlot({ id, token, ledger: path, run: run.id, common: run.common, task: identity, node: node === "验收" ? "验收" : "测试", tree: candidate.tree, inputs, epoch,
        pid: process.pid, started: processStartTime(process.pid), procs: procsFile }, controller.signal, live); acquired = true;
      change((r) => {
        live(); if (r.pendingCard || frozenCardProblem(r) || checkInputs(r, node).hash !== inputs || workspaceGuard(r) !== guard) throw new Error("排队期间卡或候选变化，未执行节点");
        if (node === "测试" && !validResult(r, "开发评审", candidate, checkInputs(r, "开发评审").hash)) throw new Error("缺当前开发评审结论，未执行测试");
        if (node === "验收") r.acceptanceState!.round++;
        r.activity!.kind = node === "验收" ? "accepting" : "testing"; r.activity!.deadline = Date.now() + (node === "验收" ? r.card.limits.验收 : r.card.limits.测试).timeoutMin * 60_000;
      });
    }
    live(); controller.signal.throwIfAborted(); invoked = true;
    output = await executor({ ledger: path, taskId: run.taskId, attempt: id, evidenceDir, run: read(), candidate, inputs, signal: controller.signal, deadline: read().activity?.deadline, procsFile, registerResource: options.localSlot ? (resource) => bindLocalResource(id, token, resource) : undefined });
  } catch (error) { output = { status: "没验证", reason: String(error), failure: controller.signal.aborted ? "environment" : "unknown", evidence: [request], operations: [], released: !invoked && !consumerProblem(procsFile) }; }
  finally { await new Promise<void>((ok) => setImmediate(ok)); clearInterval(watch); fileWatch?.close(); indexWatch?.close(); options.signal?.removeEventListener("abort", abort); }
  if (acquired) releaseLocalSlot(id, token, output.released, output.reason);
  let current = { candidate, inputs: "失效" };
  try { if (changed || workspaceGuard(read()) !== guard || frozenCardProblem(read())) throw new Error("检查期间工作区、索引或卡变化"); current = { candidate: currentCandidate(read()), inputs: checkInputs(read(), node).hash }; }
  catch (error) { output = { ...output, status: "中断", reason: String(error) }; }
  const fresh = finishAttempt(path, { id, candidate, inputs, userVersion: run.userVersion, epoch, task }, { id, task: identity, node, candidate, inputs, started, ended: stamp(), status: output.status, reason: output.reason, failure: output.failure, evidence: output.evidence, operations: output.operations, released: output.released, acceptance: output.acceptance }, current);
  if (!fresh) output = { ...output, status: "中断", reason: "候选、输入或尝试身份已变化；旧结果无效", message: undefined, stale: true };
  if (fresh) change((r) => { if (!output.released) r.release = { status: "未确认", details: [output.reason ?? "节点消费者释放未确认"] }; if (!r.activity && !r.stopped) r.stopReason = output.status === "通过" ? undefined : output.reason ?? output.status; });
  writeKernelSummary(path); return output;
}
export function writeKernelSummary(path: string): void {
  const q = queryKernel(path), run = readRun(path), lines = ["# Loop 批次总结", ...q.lines, ...(run.notes ?? []).map((s) => `说明：${s}`), "", "## 节点证据"];
  for (const r of run.results) lines.push(`- ${r.task} / ${r.node}：${r.status}；commit ${r.candidate.commit}；tree ${r.candidate.tree}；输入 ${r.inputs}；尝试 ${r.id}；开始 ${r.started}；结束 ${r.ended ?? "未确认"}；释放 ${r.released ? "已确认" : "未确认"}；${r.reason ?? ""}`, ...r.operations.map((s) => `  - 操作：${s}`), ...r.evidence.map((p) => `  - 证据：${p}`));
  for (const c of run.changes ?? []) lines.push(`- 改卡 ${c.id}：${c.state}；发起来源 ${c.source}；请求 ${c.at}；生效 ${c.appliedAt ?? "未生效"}；用户决定 ${c.authorization ?? "无额外决定"}；${c.reason ?? ""}`, `  - 原卡/提案：${join(run.dir, "card-changes", c.id)}；新 flow ${c.card.flow.join(" → ")}；限额 ${JSON.stringify(c.card.limits)}`);
  if (run.abandonment) lines.push(`- 放弃：${run.abandonment.at}；来源 ${run.abandonment.source}；保留 ref ${run.abandonment.history ?? "无"}；资源 ${run.release.status}`);
  for (const i of run.integrations ?? []) lines.push(`- dev 整合：${i.target.commit} → ${i.candidate.commit}/${i.candidate.tree}；范围来源 ${i.scopeBase}；证据 ${i.evidence}`);
  for (const i of run.batch?.integrations ?? []) lines.push(`- 批次汇入 #${i.order}：${i.task}；${i.before.commit} → ${i.after.commit}/${i.after.tree}；历史 ${i.history}；证据 ${i.evidence}`);
  for (const [id, b] of Object.entries(run.acceptanceState?.bindings ?? {})) lines.push(`- ${id}：实测树 ${b.tree}；轮次 ${b.round}；${b.reason ?? "本轮实测"}`);
  for (const d of run.decisions) lines.push(`- 用户例外决定 ${d.id}：${d.at}；来源 ${d.source}；${d.text}；候选 ${d.candidate.commit}/${d.candidate.tree}；输入 ${d.inputs ?? "历史身份缺失"}；用户版本 ${d.userVersion ?? "未知"}`, ...d.missing.map((s) => `  - 欠项：${s}`));
  writeFileSync(join(run.dir, "summary.md"), `${lines.join("\n")}\n`);
}
