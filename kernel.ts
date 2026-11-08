/** 内核：卡、显式任务身份、候选、统一节点结果。查询不迁移、不派工。 */
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, watch as watchFiles, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { inside, ownedCriteria, readDevelopmentCard, type NodeName } from "./development-card.ts";
import { parseAcceptanceConfig, readMarker } from "./config.ts";
import { eventLock } from "./events.ts";
import { gitResult, gitText } from "./workspace.ts";
import { activityAlive, atomicRun, finishAttempt, kernelRoot, ledgerPath, readRun, readTaskRun, repositoryIdentity, taskDefinition, taskIdentity, taskIds, taskView, updateRun, updateTaskRun, validResult, type Candidate, type KernelRun, type NodeResult } from "./node-ledger.ts";
import { assertWorkspace, checkInputs, createWorkspace, dirtyPaths, frozenCardProblem, localCopyPlan, managedConfig, workspaceGuard, fileDigest, freezeDeploymentPlan } from "./kernel-workspace.ts";
import { acquireProjectExecution } from "./project-execution.ts";
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
  const review = parsed.card.review;
  const base = gitText(repo, ["rev-parse", "--verify", "--end-of-options", review ? `${review.base}^{commit}` : `refs/heads/${parsed.card.base}`]);
  const head = review ? gitText(repo, ["rev-parse", "--verify", "--end-of-options", `${review.head}^{commit}`]) : undefined;
  const target = head ?? gitText(repo, ["rev-parse", "refs/heads/dev"]);
  const localFiles = review ? [] : localCopyPlan(repo, base), identity = repositoryIdentity(repo), path = ledgerPath(repo, file), id = randomUUID();
  const run: KernelRun = { v: 1, inputVersion: 2, cardRevision: 0, epoch: 0, counters: {}, changes: [], revision: 0, id, repo, common: identity.common, file, dir: dirname(path), card: parsed.card, cardHash: parsed.hash,
    base, targetAtStart: target, created: stamp(), branch: `chore/loop-${id}`, worktree: join(kernelRoot(), "worktrees", identity.key, id, "task"), workspaceCreated: false,
    localFiles, localHashes: Object.fromEntries(localFiles.map((p) => [p, fileDigest(join(repo, p))])), results: [], repairs: 0, userVersion: 0, userInputs: [], decisions: [], release: { status: "未释放", details: [] } };
  if (review) { run.branch = ""; run.reviewComparison = { base: { commit: base, tree: gitText(repo, ["rev-parse", `${base}^{tree}`]) }, head: { commit: head!, tree: gitText(repo, ["rev-parse", `${head}^{tree}`]) } }; }
  if (run.card.flow.includes("部署")) run.deploymentPlan = freezeDeploymentPlan(repo);
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
  if (run.card.nature === "评审") run.reviewInputs = { hash: checked.hash, files: checked.files };
  for (const [key, path] of Object.entries(checked.paths).filter(([key]) => key.startsWith("验收方法/原目录/") && !key.endsWith("/"))) {
    if (inside(repo, path)) {
      const rel = relative(repo, path);
      if (gitResult(repo, ["cat-file", "-e", `${base}:${rel}`]).status !== 0 && !localFiles.includes(rel)) throw new Error(`验收方法未在开工树或 localFiles 登记：${path}；请先登记，未创建分支/目录`);
    }
  }
  for (const tid of run.taskRecords ? taskIds(run) : []) checkInputs(taskView(run, tid));
  if (dryRun && run.reviewComparison) return { path, lines: ["只评审卡核对通过；未建分离检出、未启动模型", `固定比较 ${run.reviewComparison.base.commit}/${run.reviewComparison.base.tree} → ${run.reviewComparison.head.commit}/${run.reviewComparison.head.tree}`, "仅出静态报告；无开发宿主、任务提交、推送或部署"] };
  if (dryRun) return { path, lines: ["开发卡及配置核对通过；未建目录/分支，未启动模型", `目标 dev；开工依据 ${base}`, ...run.card.tasks.map((t) => `${t.name} 测试：${run.card.flow.includes("测试") ? `已安排 ${t.test}（未执行）` : "没验证（本次未安排）"}`), `验收：${run.card.flow.includes("验收") ? "已安排，全部到齐后统一执行" : "没验证（本次未安排）"}`] };
  const unlock = eventLock(`${path}.start.lock`);
  try {
    if (existsSync(path)) throw new Error(`本卡已有登记，不重复开工；请用 ${kernelCommand("状态", file)} 或 ${kernelCommand("续跑", file)}`);
    atomicRun(path, run); writeFileSync(join(run.dir, "frozen-card.json"), parsed.content, { flag: "wx", mode: 0o600 });
    try {
      createWorkspace(run); run.workspaceCreated = true;
      run.candidate = run.reviewComparison?.head ?? { commit: base, tree: gitText(run.repo, ["rev-parse", `${base}^{tree}`]) };
      for (const task of run.taskRecords ?? []) {
        mkdirSync(task.dir, { recursive: true, mode: 0o700 }); createWorkspace(taskView(run, task.id));
        task.workspaceCreated = true; task.workspaceParentCreated = true; task.candidate = { ...run.candidate };
      }
      checkInputs(run); atomicRun(path, run);
    } catch (error) { run.workspaceCreated = existsSync(join(run.worktree, ".git")); run.stopReason = `创建失败：${String(error)}`; run.stopped = true; atomicRun(path, run); throw error; }
    writeKernelSummary(path); return { path, run, lines: run.reviewComparison ? [`已登记只评审固定比较 ${run.reviewComparison.base.commit} → ${run.reviewComparison.head.commit}`, `隐藏分离检出：${run.worktree}；无开发/发布任务分支`] : [`已创建隐藏${run.taskRecords ? "批次及独立任务" : "任务"}空间：${run.worktree}`, `批次分支：${run.branch}`] };
  } finally { unlock(); }
}
export function kernelCommand(action: string, file: string, ...args: string[]): string {
  const quote = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`, probe = gitResult(dirname(file), ["rev-parse", "--show-toplevel"]);
  return `cd ${quote(probe.status === 0 ? probe.stdout.trim() : process.cwd())} && ${[join(dirname(fileURLToPath(import.meta.url)), "bin", "loop"), action, file, ...args].map(quote).join(" ")}`;
}
export function currentCandidate(run: KernelRun): Candidate {
  if (!run.candidate) throw new Error("没有登记候选；请续跑原开发会话并交付");
  if (run.card.nature === "评审" && run.candidate.commit !== run.reviewComparison?.head.commit) throw new Error("只评审登记候选与固定 head 不一致，不能换成同树其他提交");
  if (run.release.status === "已释放") return run.candidate;
  assertWorkspace(run);
  if (dirtyPaths(run).length) throw new Error(`有未提交/未跟踪/索引变化，不能放行旧候选：${dirtyPaths(run).join("、")}`);
  const commit = gitText(run.worktree, ["rev-parse", "HEAD"]), tree = gitText(run.worktree, ["rev-parse", "HEAD^{tree}"]);
  if (run.card.nature === "评审" && commit !== run.reviewComparison!.head.commit) throw new Error("只评审检出 HEAD 已改变，即使同树也不能更换受评提交");
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
  if (run.card.nature === "评审") return { candidate: run.candidate, missing: ["只评审卡仅出报告，永不取得开发合入资格（接受未验证也不能合入）"] };
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
  if (run.card.nature === "评审" || !run.candidate || run.publication?.local === "merged") return undefined;
  if (run.candidate.commit !== run.base && gitResult(run.repo, ["merge-base", "--is-ancestor", run.candidate.commit, "refs/heads/dev"]).status === 0) return run.candidate.commit;
  return gitText(run.repo, ["log", "--format=%H %T", "refs/heads/dev"]).split("\n").map((l) => l.split(" ")).find(([c, t]) => t === run.candidate!.tree && c !== run.base)?.[0];
}
export function testRemedies(run: KernelRun): string[] {
  const task = run.taskId ? ["--task", taskDefinition(run).name] : [];
  const node = run.blockedNode === "验收" ? "验收" : "测试";
  return [kernelCommand("重跑", run.file, "--node", node, ...task, "--json"), kernelCommand("改卡", run.file, "--remove-node", node, "--json"), kernelCommand("放弃", run.file, "--json")];
}
export function nodeCheckLines(run: KernelRun): string[] {
  return ([run.card.nature === "评审" ? "评审" : "开发评审", "测试", "验收", "部署"] as NodeName[]).flatMap((node) => {
    if (!run.card.flow.includes(node)) return [`${node === "开发评审" ? "评审" : node}：没验证（本次未安排）`];
    const views = run.taskRecords && ["开发评审", "测试"].includes(node) ? taskIds(run).map((id) => taskView(run, id)) : [run];
    return views.map((view) => {
      const identity = ["验收", "提交", "部署"].includes(node) && run.taskRecords ? run.id : taskIdentity(view);
      const last = [...run.results].reverse().find((r) => r.node === node && r.task === identity);
      let valid = false;
      try {
        const p = run.publication;
        if (node === "部署") valid = !!p && !!validResult(view, node, { commit: p.commit, tree: p.tree }, checkInputs(run, node).hash);
        else if (p?.local === "merged") {
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
  const onlyReview = run.card.nature === "评审", lastReview = run.results.filter((r) => r.node === "评审").at(-1);
  let reviewValid = false, reviewProblem: string | undefined;
  if (onlyReview) try {
    const checked = checkInputs(run, "评审"); if (existsSync(run.worktree)) currentCandidate(run);
    reviewProblem = frozenCardProblem(run);
    reviewValid = !reviewProblem && !!lastReview && lastReview.status !== "中断" && !!lastReview.ended && lastReview.released && lastReview.inputs === checked.hash
      && lastReview.candidate.commit === run.reviewComparison?.head.commit && lastReview.evidence.length > 0 && lastReview.evidence.every(existsSync)
      && !!run.reviewReport && existsSync(run.reviewReport.report) && existsSync(run.reviewReport.json);
  } catch (error) { reviewProblem = String(error); }
  const q = onlyReview ? { missing: reviewProblem ? [reviewProblem] : lastReview && !reviewValid ? ["只评审对象/输入/目录或证据已变化，旧报告结论无效；请核对后仅重跑评审"] : [] } : merged ? { missing: run.decisions.find((d) => d.id === run.publication?.decision)?.missing ?? [] } : qualification(run);
  const tasks = taskIds(run).map((id) => {
    const t = taskView(run, id), a = t.activity, live = activityAlive(a);
    let queue; if (a?.ticket) { try { queue = localTicketView(a.ticket); } catch { /* 只读 */ } }
    return { id, name: taskDefinition(t).name, status: !t.stopped && live === true && a?.kind !== "waiting" ? "进行中" : "等你决定", node: a?.node ?? t.blockedNode ?? (onlyReview ? "评审" : "开发评审"),
      reason: a?.kind === "waiting" && live ? a.ticket && queue?.ticket?.state === "waiting" ? `本机排队第 ${queue.position} 位（自动等待，无需操作）` : "等待同项目检查/部署/发布执行边界（自动等待，无需操作）" : !t.stopped && a && live === true ? `${a.kind === "developing" ? "原会话开发" : a.node}正在执行` : !t.stopped && !run.activity && !q.missing.length && !onlyReview ? "本任务已交付；卡上检查已完成" : t.stopReason ?? (a && live !== true ? "登记节点已不执行或身份无法确认" : run.batch?.contributions.some((c) => c.task === id && c.candidate.commit === t.candidate?.commit) ? "已汇入，等待批次统一验收/原会话返修" : "无节点执行"),
      activity: !t.stopped && live ? a : null, processIdentity: live === undefined ? "未确认" : live ? "存活" : "无活动", queue, candidate: t.candidate, branch: t.branch, worktree: t.worktree, session: t.session, launchMode: t.launchMode ?? null, consumerReleases: t.consumerReleases ?? [],
      integrated: !!run.batch?.contributions.some((c) => c.task === id && c.candidate.commit === t.candidate?.commit), counters: onlyReview ? {} : { ...t.counters, 开发评审: { repairs: t.repairs, recoveries: 0 } }, release: t.release, repairReceipt: t.repair };
  });
  const active = !run.stopped && ([run.activity, ...(run.taskRecords ?? []).map((t) => t.activity)].some((a) => activityAlive(a) === true && a?.kind !== "waiting"));
  const submission = [...run.results].reverse().find((r) => r.node === "提交"), blockedPublication = submission && submission.status !== "通过" && submission.reason === run.stopReason;
  const resourceUnknown = run.release.status === "未确认" || run.taskRecords?.some((t) => !t.removed && t.release.status === "未确认");
  const status = merged || external ? "已合入" : run.abandoned ? "已放弃" : active ? "进行中" : onlyReview || blockedPublication || resourceUnknown || q.missing.length ? "等你决定" : "可合入";
  const first = tasks.find((t) => t.activity) ?? tasks.find((t) => t.reason !== "无节点执行") ?? tasks[0];
  const deployment = run.deploymentAttempts?.at(-1);
  const node = run.activity?.node ?? (merged ? run.card.flow.includes("部署") ? "部署" : "提交" : run.blockedNode ?? first?.node ?? (onlyReview ? "评审" : "开发评审"));
  const reason = onlyReview ? `${active ? "只评审执行中" : lastReview ? "只评审已结束" : "只评审待执行"}；${active ? "静态评审正在执行" : lastReview ? reviewValid ? `${lastReview.status}；${lastReview.reason ?? ""}` : "没验证（旧结论失效）" : run.stopReason ?? q.missing[0] ?? "无节点执行"}；仅供查看报告，无自动返修/合入` : external ? "已合入（Loop 外）；没有伪造检查通过，远端与释放需另行核实" : merged ? `已合入（本地）；推送：${publication?.push ?? "未确认"}；${publication?.push === "未确认" ? "推送执行已不活动或归属未确认，远端结果未知，不自动重试；" : ""}${run.publication?.reason ?? ""}${run.stopped ? `；剩余节点已停止：${run.stopReason ?? "用户停止"}` : ""}` : !active && resourceUnknown ? `资源释放未确认；请先核对：${kernelCommand("停止", run.file, "--json")}；不能冒称完成或直接重跑` : !active && !run.stopped && !q.missing.length && !blockedPublication ? "卡上前置结论均有效；本任务已交付，可用统一合入入口（不暗加提交）" : run.stopReason || (first?.reason !== "无节点执行" ? first?.reason : undefined) || q.missing[0] || "卡上前置结论均有效";
  let queue; if (run.activity?.ticket) { try { queue = localTicketView(run.activity.ticket); } catch { /* 只读 */ } } else queue = first?.queue;
  const acceptanceItems = run.acceptanceState?.criteria.items.map((item) => {
    const owner = run.acceptanceState!.owners[item.id], removed = (run.batch?.removed ?? []).some((t) => t.name === owner);
    const result = run.acceptanceState!.previous?.items.find((i) => i.id === item.id);
    return { ...item, owner, status: removed ? "没验证（任务移出本批）" : result?.verdict ?? "没验证", binding: run.acceptanceState!.bindings?.[item.id], source: result?.source };
  }) ?? [];
  const versions = run.publication ? { local: gitText(run.repo, ["rev-parse", "refs/heads/dev"]), remote: run.publication.remoteCommit ?? "未确认（仅本次推送记录，无远端查询）", running: deployment?.running ?? "未确认", rollback: deployment?.rollback ?? null } : null;
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
    ...(onlyReview ? [`报告：${run.reviewReport?.report ?? "尚无报告"}；${reviewValid ? "输入仍匹配" : "未验证/失效"}`, kernelCommand("重跑", run.file, "--node", "评审", "--json")] : []),
    ...(versions ? [`版本：本地 ${versions.local}；远端（本次推送记录）${versions.remote}；运行（最近成功部署命令）${versions.running}；回退 ${deployment?.rollback?.state ?? "未执行"}`] : []),
    ...(run.card.flow.includes("部署") && merged ? [`部署：${deployment?.status ?? (run.stopped ? "已停止（未启动）" : publication?.push !== "成功" ? "未执行（推送未成功）" : "等待")}；${deployment?.reason ?? "只按卡接续部署；不重复推送"}`, kernelCommand("重跑", run.file, "--node", "部署", "--json"), kernelCommand("停止", run.file, "--json")] : []),
    ...(blockedPublication && !merged ? [`处理上述原因后：${kernelCommand(run.publication ? "续跑" : "合入", run.file)}`] : []),
    ...(!merged ? taskIds(run).flatMap((id) => { const t = taskView(run, id); return t.blockedNode === "测试" && t.stopped ? testRemedies(t) : []; }) : []),
    ...(run.blockedNode === "验收" && run.stopped && !merged ? testRemedies(run) : []), `资源：${run.release.status}；${run.release.details.join("；")}`, `总结：${join(run.dir, "summary.md")}`];
  return { ok: true, kernel: 1, id: run.id, card: run.file, name: run.card.name, status, launchMode: run.launchMode ?? null, task: run.taskRecords ? "批次" : first?.name, tasks, node, reason, checks, queue, counters: onlyReview ? {} : { ...run.counters, 开发评审: { repairs: run.repairs, recoveries: 0 } }, limits: onlyReview ? { 评审: { timeoutMin: run.card.limits.开发评审.timeoutMin } } : run.card.limits,
    cardRevision: run.cardRevision ?? 0, pendingCardChange: run.pendingCard ?? null, cardChanges: run.changes ?? [], repairReceipt: run.repair, abandonment: run.abandonment, candidate: run.candidate, missing: q.missing,
    activity: alive && !run.stopped ? run.activity : null, reviewReport: run.reviewReport, reviewComparison: run.reviewComparison, reviewValid, deployment: deployment ?? null, versions, externalMerge: external ?? null, publication, release: run.release, notes: run.notes ?? [], decisions: run.decisions, controlDecisions: run.controlDecisions ?? [], integrations: run.batch?.integrations ?? run.integrations ?? [], acceptance: run.acceptanceState, acceptanceItems, removedTasks: run.batch?.removed ?? [], attempts, testWorkspaces: run.testWorkspaces ?? [], consumerReleases: run.consumerReleases ?? [], results: run.results, summary: join(run.dir, "summary.md"), ledger: path, lines };
}
export async function executeNode(path: string, node: NodeName, executor: NodeExecutor, options: { signal?: AbortSignal; localSlot?: boolean; task?: string } = {}): Promise<NodeOutput> {
  const task = options.task, read = () => readTaskRun(path, task), change = <T>(cb: (r: KernelRun) => T) => updateTaskRun(path, task, cb);
  const initial = read(), problem = frozenCardProblem(initial);
  if (problem) { change((r) => { r.stopped = true; r.stopReason = problem; }); throw new Error(problem); }
  if (initial.stopped || initial.abandoned || initial.pendingCard) throw new Error("任务已停止、放弃或有待应用改卡，不能自动推进");
  if (initial.card.nature === "评审" && node !== "评审") throw new Error("只评审卡只能执行评审节点，不授予开发/提交/部署资格");
  if (["开发评审", "测试"].includes(node)) taskDefinition(initial);
  if (node !== "提交" && !initial.card.flow.includes(node)) throw new Error(`卡上未安排 ${node}`);
  if (node === "部署" && (initial.publication?.local !== "merged" || initial.publication.push !== "成功")) throw new Error("部署需要明确的本批本地发布及 origin/dev 推送成功；未自动部署/重推");
  const candidate = node === "部署" ? { commit: initial.publication!.commit, tree: initial.publication!.tree } : currentCandidate(initial), inputs = checkInputs(initial, node).hash;
  if (node === "测试" && !validResult(initial, "开发评审", candidate, checkInputs(initial, "开发评审").hash)) throw new Error("测试只能在当前开发评审通过之后执行");
  if (node === "验收" && contributionProblems(initial).length) throw new Error(contributionProblems(initial).join("\n"));
  if (node === "验收" && !initial.taskRecords) for (const prerequisite of ["开发评审", ...(initial.card.flow.includes("测试") ? ["测试"] : [])] as NodeName[]) {
    if (!validResult(initial, prerequisite, candidate, checkInputs(initial, prerequisite).hash)) throw new Error(`验收缺当前 ${prerequisite} 通过结论`);
  }
  const previous = validResult(initial, node, candidate, inputs);
  if (previous) return { status: "通过", evidence: previous.evidence, operations: ["同树、同输入复用原结论"], released: true, acceptance: previous.acceptance };
  const inputPaths = Object.values(checkInputs(initial, node).paths);
  const inputMetadata = (): string => JSON.stringify(inputPaths.map((p) => {
    const path = existsSync(p) ? p : dirname(p);
    try { const s = lstatSync(path, { bigint: true }); return [p, path, `${s.dev}:${s.ino}:${s.mode}:${s.mtimeNs}:${s.ctimeNs}`]; } catch { return [p, "未知/缺失"]; }
  }));
  const inputGuard = inputMetadata(), readOnlyCheck = ["开发评审", "评审", "测试", "验收"].includes(node); // 提交/部署的预期输入转换由各自事务守卫核对。
  const id = randomUUID(), token = randomUUID(), started = stamp(), guard = node === "部署" ? "发布后部署" : workspaceGuard(initial), epoch = initial.epoch ?? 0;
  const evidenceDir = join(initial.dir, "attempts", id), procsFile = node === "开发评审" || node === "评审" ? join(initial.dir, "review.procs.json") : join(evidenceDir, "test.procs.json");
  const run = change((r) => {
    if (r.stopped || r.abandoned || r.pendingCard || (r.epoch ?? 0) !== epoch) throw new Error("执行控制版本变化");
    if (r.userVersion !== initial.userVersion || checkInputs(r, node).hash !== inputs || node !== "部署" && workspaceGuard(r) !== guard) throw new Error("节点启动边界候选或输入变化，未调用执行器");
    if (r.activity && r.activity.kind !== "developing" && activityAlive(r.activity) !== false) throw new Error("节点已有活动尝试或归属未确认，未并发执行");
    if (node !== "部署") r.candidate = candidate; r.blockedNode = node;
    r.activity = { id, node, kind: options.localSlot || node === "部署" ? "waiting" : node === "开发评审" || node === "评审" ? "reviewing" : "submitting", pid: process.pid, started: processStartTime(process.pid), ...(options.localSlot ? { procs: procsFile, ticket: id } : {}) };
    return structuredClone(r);
  });
  mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
  const identity = node === "验收" || node === "提交" || node === "部署" ? run.taskRecords ? run.id : taskIdentity(run) : taskIdentity(run);
  const request = join(evidenceDir, "attempt.json"), requestData = { id, node, task: identity, candidate, inputs, started, epoch, invoked: false, workspaceGuard: guard, inputMetadata: JSON.parse(inputGuard) };
  writeFileSync(request, JSON.stringify(requestData, null, 2));
  const controller = new AbortController();
  let changed = false;
  const interruption: NonNullable<NodeResult["interruption"]> = { validity: { candidate: "未知", inputs: "未知", control: true } };
  const cancel = (kind: string, reason: string, path?: string, event?: string): void => {
    interruption.trigger ??= { kind, reason, path, event, at: stamp() }; controller.abort(reason);
  };
  const abort = (): void => cancel("cancel", read().stopReason ?? String(options.signal?.reason ?? "调用方取消"));
  const invalidate = (kind: string, event: string, file?: string): void => {
    (interruption.observations ??= []).push({ kind, event, path: file, at: stamp() });
    changed = true; cancel(kind, `${kind === "index" ? "索引" : "候选文件"}事件：${file ?? "路径未知"}`, file, event);
  };
  let fileWatch: ReturnType<typeof watchFiles> | undefined, indexWatch: ReturnType<typeof watchFiles> | undefined;
  if (options.signal?.aborted) abort(); else options.signal?.addEventListener("abort", abort, { once: true });
  const live = (): void => {
    const r = read();
    if (changed) throw new Error(interruption.trigger?.reason ?? "候选/索引变化");
    if (r.stopped || r.abandoned || r.activity?.id !== id || r.userVersion !== run.userVersion || (r.epoch ?? 0) !== epoch) throw new Error(r.stopReason ?? "节点已取消或用户/控制版本变化");
    if (checkInputs(r, node).hash !== inputs || readOnlyCheck && inputMetadata() !== inputGuard) throw new Error("已登记输入/卡/配置/标准/授权文件变化（含瞬时写回）");
  };
  const watch = setInterval(() => { try { live(); } catch (error) { cancel("control/input", String(error)); } }, 100);
  let output: NodeOutput, acquired = false, invoked = false, projectRelease: ((released: boolean) => void) | undefined;
  try {
    if (node !== "部署") {
      fileWatch = watchFiles(run.worktree, { recursive: true }, (event, file) => invalidate("workspace", event, file ? join(run.worktree, file.toString()) : undefined));
      const index = gitText(run.worktree, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
      indexWatch = watchFiles(dirname(index), (event, file) => { if (!file || file === "index" || file === "index.lock") invalidate("index", event, file ? join(dirname(index), file.toString()) : undefined); });
    }
    if (options.localSlot) {
      await acquireLocalSlot({ id, token, ledger: path, run: run.id, common: run.common, task: identity, node: node === "验收" ? "验收" : "测试", tree: candidate.tree, inputs, epoch,
        pid: process.pid, started: processStartTime(process.pid), procs: procsFile }, controller.signal, live); acquired = true;
      change((r) => {
        live(); if (r.pendingCard || frozenCardProblem(r) || checkInputs(r, node).hash !== inputs || workspaceGuard(r) !== guard) throw new Error("排队期间卡或候选变化，未执行节点");
        if (node === "测试" && !validResult(r, "开发评审", candidate, checkInputs(r, "开发评审").hash)) throw new Error("缺当前开发评审结论，未执行测试");
        r.activity!.kind = node === "验收" ? "accepting" : "testing";
      });
    }
    if (["开发评审", "评审", "测试", "验收"].includes(node)) {
      const kind = read().activity!.kind;
      projectRelease = await acquireProjectExecution(run.worktree, "check", procsFile, controller.signal, live, () => change((r) => { live(); r.activity!.kind = "waiting"; }));
      change((r) => {
        live(); if (r.pendingCard) throw new Error("下一安全边界有待应用改卡，未启动旧命令"); r.activity!.kind = kind;
        if (options.localSlot) { if (node === "验收") r.acceptanceState!.round++; r.activity!.deadline = Date.now() + (node === "验收" ? r.card.limits.验收 : r.card.limits.测试).timeoutMin * 60_000; }
      });
    }
    live(); controller.signal.throwIfAborted(); requestData.invoked = true; writeFileSync(request, JSON.stringify(requestData, null, 2)); invoked = true;
    output = await executor({ ledger: path, taskId: run.taskId, attempt: id, evidenceDir, run: read(), candidate, inputs, signal: controller.signal, deadline: read().activity?.deadline, procsFile, registerResource: options.localSlot ? (resource) => bindLocalResource(id, token, resource) : undefined });
  } catch (error) { output = { status: "没验证", reason: String(error), failure: controller.signal.aborted ? "environment" : "unknown", evidence: [request], operations: [], released: !invoked && !consumerProblem(procsFile) }; }
  finally { await new Promise<void>((ok) => setImmediate(ok)); clearInterval(watch); fileWatch?.close(); indexWatch?.close(); options.signal?.removeEventListener("abort", abort); }
  projectRelease?.(output.released);
  if (acquired) releaseLocalSlot(id, token, output.released, output.reason);
  let current = { candidate, inputs: "失效" };
  interruption.executorReason = output.reason;
  try {
    interruption.validity.candidate = !changed && (node === "部署" || workspaceGuard(read()) === guard);
    interruption.validity.inputs = !frozenCardProblem(read()) && checkInputs(read(), node).hash === inputs && (!readOnlyCheck || inputMetadata() === inputGuard);
    if (!interruption.validity.candidate || !interruption.validity.inputs) throw new Error(interruption.trigger?.reason ?? "检查期间候选/索引或已登记输入变化");
    current = { candidate: node === "部署" ? candidate : currentCandidate(read()), inputs: checkInputs(read(), node).hash };
  } catch (error) { cancel("guard", String(error)); output = { ...output, status: "中断", reason: [interruption.trigger?.reason, output.reason].filter(Boolean).join("；") }; }
  if (controller.signal.aborted) output = { ...output, status: "中断", reason: [interruption.trigger?.reason ?? "节点已取消", output.reason].filter(Boolean).join("；"), message: undefined };
  const diagnostic = join(evidenceDir, "interruption.json"); output.evidence = [...new Set([...output.evidence, diagnostic])];
  const fresh = finishAttempt(path, { id, candidate, inputs, userVersion: run.userVersion, epoch, task }, { id, task: identity, node, candidate, inputs, started, ended: stamp(), status: output.status, reason: output.reason, failure: output.failure, evidence: output.evidence, operations: output.operations, released: output.released, acceptance: output.acceptance, interruption }, current);
  writeFileSync(diagnostic, JSON.stringify(interruption, null, 2));
  if (!fresh) output = { ...output, status: "中断", reason: [output.reason, interruption.protectionReason].filter(Boolean).join("；"), message: undefined, stale: true };
  if (node === "评审") {
    const report = join(evidenceDir, "report.md"), json = join(evidenceDir, "report.json");
    const previous = existsSync(json) ? JSON.parse(readFileSync(json, "utf8")) : { baseline: run.reviewComparison!.base.commit, candidate: candidate.commit, comparison: run.reviewComparison, inputs, evidence: output.evidence };
    writeFileSync(json, JSON.stringify({ ...previous, status: output.status, reason: output.reason, valid: fresh && output.status !== "中断", released: output.released }, null, 2));
    writeFileSync(report, `${existsSync(report) ? readFileSync(report, "utf8") : "# 只评审报告\n"}\n## 内核有效性\n结果：${output.status}；${output.reason ?? "输入/目录守卫通过"}\n本次仅报告，无开发合入资格。\n`);
    change((r) => { if (!r.reviewReport || r.reviewReport.attempt === id) r.reviewReport = { report, json, attempt: id }; });
  }
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
