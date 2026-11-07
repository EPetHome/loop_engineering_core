/** 单任务内核：只认卡、候选和统一节点结果；不导入节点实现或节点私有状态。 */
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { readDevelopmentCard, type NodeName } from "./development-card.ts";
import { eventLock } from "./events.ts";
import { gitResult, gitText } from "./workspace.ts";
import { activityAlive, atomicRun, finishAttempt, kernelRoot, ledgerPath, readRun, repositoryIdentity, updateRun, validResult, type Candidate, type KernelRun, type NodeResult } from "./node-ledger.ts";
import { assertWorkspace, checkInputs, createWorkspace, dirtyPaths, frozenCardProblem, localCopyPlan, managedConfig, workspaceGuard, fileDigest } from "./kernel-workspace.ts";
import { processStartTime } from "./procs.ts";
import { acquireLocalSlot, bindLocalResource, consumerProblem, localTicketView, releaseLocalSlot } from "./local-node-queue.ts";
import type { RunResource } from "./resources.ts";

export interface NodeInput { ledger: string; attempt: string; evidenceDir: string; run: KernelRun; candidate: Candidate; inputs: string;
  signal?: AbortSignal; deadline?: number; procsFile?: string; registerResource?: (resource: RunResource) => void }
export interface NodeOutput { status: NodeResult["status"]; reason?: string; failure?: NodeResult["failure"]; evidence: string[]; operations: string[]; released: boolean; message?: string; stale?: boolean }
export type NodeExecutor = (input: NodeInput) => Promise<NodeOutput>;
const stamp = (): string => new Date().toISOString();
export function createKernelRun(file: string, cwd: string, dryRun = false): { path: string; run?: KernelRun; lines: string[] } {
  const repo = realpathSync(gitText(cwd, ["rev-parse", "--show-toplevel"]));
  file = realpathSync(file);
  const parsed = readDevelopmentCard(file, repo);
  managedConfig(repo); // 配置/来源声明等启动错误先发现，绝不先建目录。
  const base = gitText(repo, ["rev-parse", `refs/heads/${parsed.card.base}`]);
  const target = gitText(repo, ["rev-parse", "refs/heads/dev"]);
  const localFiles = localCopyPlan(repo, base), identity = repositoryIdentity(repo);
  const path = ledgerPath(repo, file), id = randomUUID();
  const run: KernelRun = { v: 1, inputVersion: 2, cardRevision: 0, epoch: 0, counters: {}, changes: [], revision: 0, id, repo, common: identity.common, file, dir: dirname(path), card: parsed.card, cardHash: parsed.hash,
    base, targetAtStart: target, created: stamp(), branch: `chore/loop-${id}`, worktree: join(kernelRoot(), "worktrees", identity.key, id, "task"),
    workspaceCreated: false, localFiles, localHashes: Object.fromEntries(localFiles.map((p) => [p, fileDigest(join(repo, p))])),
    results: [], repairs: 0, userVersion: 0, userInputs: [], decisions: [], release: { status: "未释放", details: [] } };
  checkInputs(run);
  if (dryRun) return { path, lines: ["开发卡及配置核对通过；未建目录/分支，未启动模型", `目标 dev；开工依据 ${base}`, parsed.card.flow.includes("测试") ? `测试：已安排 ${parsed.card.tasks[0].test}（未执行）` : "测试、验收：没验证（本次未安排）"] };
  const unlock = eventLock(`${path}.start.lock`);
  try {
    if (existsSync(path)) throw new Error(`本卡已有登记，不重复开工；请用 ${kernelCommand("状态", file)} 或 ${kernelCommand("续跑", file)}`);
    atomicRun(path, run);
    writeFileSync(join(run.dir, "frozen-card.json"), parsed.content, { flag: "wx", mode: 0o600 });
    try {
      createWorkspace(run); run.workspaceCreated = true;
      // 初始候选亦是可查询、可受控例外合入的代码身份。
      run.candidate = { commit: base, tree: gitText(run.repo, ["rev-parse", `${base}^{tree}`]) };
      checkInputs(run); atomicRun(path, run);
    } catch (error) {
      run.workspaceCreated = existsSync(join(run.worktree, ".git"));
      run.stopReason = `创建失败：${String(error)}`; run.stopped = true; atomicRun(path, run); throw error;
    }
    writeKernelSummary(path);
    return { path, run, lines: [`已创建隐藏任务空间：${run.worktree}`, `任务分支：${run.branch}`] };
  } finally { unlock(); }
}
export function kernelCommand(action: string, file: string, ...args: string[]): string {
  const quote = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`;
  const probe = gitResult(dirname(file), ["rev-parse", "--show-toplevel"]);
  const cwd = probe.status === 0 ? probe.stdout.trim() : process.cwd();
  return `cd ${quote(cwd)} && ${[join(dirname(fileURLToPath(import.meta.url)), "bin", "loop"), action, file, ...args].map(quote).join(" ")}`;
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
export function qualification(run: KernelRun): { candidate?: Candidate; inputs?: string; missing: string[] } {
  const missing: string[] = [];
  const cardProblem = frozenCardProblem(run); if (cardProblem) missing.push(cardProblem);
  let candidate: Candidate | undefined, inputs: string | undefined;
  try { candidate = currentCandidate(run); } catch (error) { missing.push(String(error)); }
  try { inputs = checkInputs(run).hash; } catch (error) { missing.push(String(error)); }
  const beforeSubmit = run.card.flow.includes("提交") ? run.card.flow.slice(0, run.card.flow.indexOf("提交")) : run.card.flow;
  for (const node of beforeSubmit) {
    let nodeInputs: string | undefined; try { nodeInputs = checkInputs(run, node).hash; } catch { /* 缺项已列出 */ }
    if (!candidate || !nodeInputs || !validResult(run, node, candidate, nodeInputs))
      missing.push(`${run.card.tasks[0].name} / ${node} / 树 ${candidate?.tree ?? run.candidate?.tree ?? "无候选"}：缺少当前输入的有效通过结论（旧结论不可放行）；补救：${node === "测试" ? kernelCommand("重跑", run.file, "--node", "测试", "--json") : kernelCommand("续跑", run.file)}`);
  }
  return { candidate, inputs, missing };
}
export function provenExternalMerge(run: KernelRun): string | undefined {
  if (!run.candidate || run.publication?.local === "merged") return undefined;
  const target = "refs/heads/dev";
  if (run.candidate.commit !== run.base && gitResult(run.repo, ["merge-base", "--is-ancestor", run.candidate.commit, target]).status === 0) return run.candidate.commit;
  // 只认目标真实历史中的同树提交；内容相似、patch-id 相近都不是证明。
  const history = gitText(run.repo, ["log", "--format=%H %T", target]).split("\n");
  return history.map((line) => line.split(" ")).find(([commit, tree]) => tree === run.candidate!.tree && commit !== run.base)?.[0];
}
export function queryKernel(path: string): Record<string, any> {
  const run = readRun(path), external = provenExternalMerge(run);
  const a = run.activity;
  const alive = activityAlive(a);
  const publication = run.publication ? { ...run.publication,
    push: run.publication.push === "进行中" && (run.stopped || alive !== true) ? "未确认" : run.publication.push,
    recordedPush: run.publication.push } : null;
  const locallyMerged = run.publication?.local === "merged" || (run.publication?.local === "intent" && gitResult(run.repo, ["merge-base", "--is-ancestor", run.publication.commit, "refs/heads/dev"]).status === 0);
  // 工作区释放不使已发布时的检查变成“缺失”；例外欠项保留，不补成通过。
  const q = locallyMerged ? { missing: run.decisions.find((d) => d.id === run.publication?.decision)?.missing ?? [] } : qualification(run);
  const submission = [...run.results].reverse().find((r) => r.node === "提交");
  const blockedPublication = submission && submission.status !== "通过" && submission.reason === run.stopReason;
  const status = locallyMerged || external ? "已合入" : run.abandoned ? "已放弃" : !run.stopped && alive && a?.kind !== "waiting" ? "进行中" : blockedPublication ? "等你决定" : !q.missing.length ? "可合入" : "等你决定";
  let queue: ReturnType<typeof localTicketView> | undefined;
  if (a?.ticket) { try { queue = localTicketView(a.ticket); } catch { /* 只读保守展示 */ } }
  const node = a?.node ?? (locallyMerged ? "提交" : run.blockedNode ?? "开发评审");
  const checks = nodeCheckLines(run);
  const reason = a?.kind === "waiting" && alive === true ? `本机排队第 ${queue?.position ?? "未知"} 位（自动等待，无需操作）` : external ? "已合入（Loop 外）；没有伪造检查通过，远端与释放需另行核实" : locallyMerged ? `已合入（本地）；推送：${publication?.push ?? "未确认"}；${publication?.push === "未确认" ? "推送执行已不活动或归属未确认，远端结果未知，不自动重试；" : ""}${run.publication?.reason ?? ""}`
    : run.stopReason || (a && !alive ? "登记节点已不执行或身份无法确认" : q.missing[0]) || "卡上前置结论均有效";
  const attemptDir = join(run.dir, "attempts");
  const attempts = existsSync(attemptDir) ? readdirSync(attemptDir, { withFileTypes: true }).filter((d) => d.isDirectory() && /^[0-9a-f-]{36}$/.test(d.name)).map((d) => {
    const request = join(attemptDir, d.name, "attempt.json");
    const result = run.results.find((r) => r.id === d.name);
    try { return { ...JSON.parse(readFileSync(request, "utf8")), status: result?.status ?? "结果未确认", evidence: request }; }
    catch { return { id: d.name, status: "尝试记录无法读取", evidence: request }; }
  }) : [];
  return { ok: true, kernel: 1, id: run.id, card: run.file, name: run.card.name, status, task: run.card.tasks[0].name,
    node, reason, checks, queue, counters: { ...run.counters, 开发评审: { repairs: run.repairs, recoveries: 0 } }, limits: run.card.limits, cardRevision: run.cardRevision ?? 0, pendingCardChange: run.pendingCard ?? null, cardChanges: run.changes ?? [], repairReceipt: run.repair, abandonment: run.abandonment, candidate: run.candidate, missing: q.missing,
    activity: alive && !run.stopped ? a : null, externalMerge: external ?? null, publication,
    release: run.release, notes: run.notes ?? [], decisions: run.decisions, integrations: run.integrations ?? [], attempts, results: run.results, summary: join(run.dir, "summary.md"), ledger: path,
    lines: [`${status}：${run.card.name} / ${run.card.tasks[0].name} / ${node}`, reason,
      ...q.missing, ...(blockedPublication && !locallyMerged ? [`处理上述原因后：${kernelCommand(run.publication ? "续跑" : "合入", run.file)}`] : []), ...checks, ...(run.blockedNode === "测试" && run.stopped ? testRemedies(run) : []), `资源：${run.release.status}${run.release.details.length ? `；${run.release.details.join("；")}` : ""}`, `总结：${join(run.dir, "summary.md")}`] };
}
export function testRemedies(run: KernelRun): string[] {
  return [kernelCommand("重跑", run.file, "--node", "测试", "--json"), kernelCommand("改卡", run.file, "--remove-node", "测试", "--json"), kernelCommand("放弃", run.file, "--json")];
}
export function nodeCheckLines(run: KernelRun): string[] {
  return (["开发评审", "测试", "验收", "部署"] as NodeName[]).map((node) => {
    if (!run.card.flow.includes(node)) return `${node === "开发评审" ? "评审" : node}：没验证（本次未安排）`;
    const last = [...run.results].reverse().find((r) => r.node === node);
    let valid = false;
    const publication = run.publication;
    try {
      if (publication?.local === "merged") {
        // 发布检查是该已发布候选的历史事实，不因合法移除临时目录重新计算输入。
        const bound = publication.nodeChecks?.[node];
        if (bound?.result && publication.tree === publication.candidate.tree) {
          valid = validResult(run, node, publication.candidate, bound.inputs)?.id === bound.result;
        } else if (!publication.nodeChecks && run.inputVersion !== 2) {
          valid = !!validResult(run, node, publication.candidate, publication.inputs); // 第一步完整指纹记录。
        }
      } else valid = !!run.candidate && !!validResult(run, node, run.candidate, checkInputs(run, node).hash);
    } catch { /* 缺发布绑定或证据时不伪造通过。 */ }
    return `${node === "开发评审" ? "评审" : node}：${valid ? "通过" : last ? `${last.status === "通过" ? "没验证（旧通过已失效）" : last.status}；${last.reason ?? "旧结论对当前输入无效"}` : "没验证（尚未执行）"}`;
  });
}
export async function executeNode(path: string, node: NodeName, executor: NodeExecutor, options: { signal?: AbortSignal; localSlot?: boolean } = {}): Promise<NodeOutput> {
  const initial = readRun(path), problem = frozenCardProblem(initial);
  if (problem) { updateRun(path, (r) => { r.stopped = true; r.stopReason = problem; }); throw new Error(problem); }
  if (initial.stopped || initial.abandoned || initial.pendingCard) throw new Error("任务已停止、放弃或有待应用改卡，不能自动推进");
  if (node !== "提交" && !initial.card.flow.includes(node)) throw new Error(`卡上未安排 ${node}`);
  const candidate = currentCandidate(initial), inputs = checkInputs(initial, node).hash;
  if (node === "测试" && !validResult(initial, "开发评审", candidate, checkInputs(initial, "开发评审").hash)) throw new Error("测试只能在当前开发评审通过之后执行");
  const previous = validResult(initial, node, candidate, inputs);
  if (previous) return { status: "通过", evidence: previous.evidence, operations: ["同树、同输入复用原结论"], released: true };
  const id = randomUUID(), token = randomUUID(), started = stamp(), guard = workspaceGuard(initial), epoch = initial.epoch ?? 0;
  const evidenceDir = join(initial.dir, "attempts", id), procsFile = join(evidenceDir, "test.procs.json");
  const run = updateRun(path, (r) => {
    if (r.stopped || r.abandoned || r.pendingCard || (r.epoch ?? 0) !== epoch) throw new Error("执行控制版本变化");
    if (r.userVersion !== initial.userVersion || checkInputs(r, node).hash !== inputs || workspaceGuard(r) !== guard) throw new Error("节点启动边界候选或输入变化，未调用执行器");
    if (r.activity && r.activity.kind !== "developing" && activityAlive(r.activity) !== false) throw new Error("节点已有活动尝试或归属未确认，未并发执行");
    r.candidate = candidate; r.blockedNode = node;
    r.activity = { id, node, kind: options.localSlot ? "waiting" : node === "开发评审" ? "reviewing" : "submitting", pid: process.pid, started: processStartTime(process.pid),
      ...(options.localSlot ? { procs: procsFile, ticket: id } : {}) };
    return structuredClone(r);
  });
  mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
  const request = join(evidenceDir, "attempt.json");
  writeFileSync(request, JSON.stringify({ id, node, task: run.card.tasks[0].name, candidate, inputs, started, epoch }, null, 2));
  const controller = new AbortController(), abort = (): void => controller.abort();
  if (options.signal?.aborted) controller.abort(); else options.signal?.addEventListener("abort", abort, { once: true });
  const live = (): void => {
    const current = readRun(path);
    if (current.stopped || current.abandoned || current.activity?.id !== id || current.userVersion !== run.userVersion || (current.epoch ?? 0) !== epoch) throw new Error("节点已取消或用户/控制版本变化");
  };
  const watch = setInterval(() => { try { live(); } catch { controller.abort(); } }, 100);
  let output: NodeOutput, acquired = false, invoked = false;
  try {
    if (options.localSlot) {
      await acquireLocalSlot({ id, token, ledger: path, run: run.id, common: run.common, task: run.card.tasks[0].name, node: "测试", tree: candidate.tree, inputs, epoch,
        pid: process.pid, started: processStartTime(process.pid), procs: procsFile }, controller.signal, live);
      acquired = true;
      updateRun(path, (r) => {
        live();
        if (r.pendingCard || frozenCardProblem(r) || checkInputs(r, node).hash !== inputs || workspaceGuard(r) !== guard) throw new Error("排队期间卡或候选变化，未执行测试");
        const reviewInputs = checkInputs(r, "开发评审").hash;
        if (!validResult(r, "开发评审", candidate, reviewInputs)) throw new Error("缺当前开发评审结论，未执行测试");
        r.activity!.kind = "testing"; r.activity!.deadline = Date.now() + r.card.limits.测试.timeoutMin * 60_000;
      });
    }
    live(); controller.signal.throwIfAborted(); invoked = true;
    output = await executor({ ledger: path, attempt: id, evidenceDir, run: readRun(path), candidate, inputs, signal: controller.signal,
      deadline: readRun(path).activity?.deadline, procsFile, registerResource: options.localSlot ? (resource) => bindLocalResource(id, token, resource) : undefined });
  } catch (error) { output = { status: "没验证", reason: String(error), failure: controller.signal.aborted ? "environment" : "unknown", evidence: [request], operations: [], released: !invoked && !consumerProblem(procsFile) }; }
  finally { clearInterval(watch); options.signal?.removeEventListener("abort", abort); }
  if (acquired) releaseLocalSlot(id, token, output.released, output.reason);
  let current = { candidate, inputs: "失效" };
  try {
    if (workspaceGuard(readRun(path)) !== guard || frozenCardProblem(readRun(path))) throw new Error("检查期间工作区、索引或卡变化");
    current = { candidate: currentCandidate(readRun(path)), inputs: checkInputs(readRun(path), node).hash };
  } catch (error) { output = { ...output, status: "中断", reason: String(error) }; }
  const fresh = finishAttempt(path, { id, candidate, inputs, userVersion: run.userVersion, epoch }, { id, task: run.card.tasks[0].name, node, candidate, inputs,
    started, ended: stamp(), status: output.status, reason: output.reason, failure: output.failure, evidence: output.evidence, operations: output.operations, released: output.released }, current);
  if (!fresh) output = { ...output, status: "中断", reason: "候选、输入或尝试身份已变化；旧结果无效", message: undefined, stale: true };
  if (fresh) updateRun(path, (r) => {
    if (!output.released) r.release = { status: "未确认", details: [output.reason ?? "节点消费者释放未确认"] };
    if (!r.activity && !r.stopped) r.stopReason = output.status === "通过" ? undefined : output.reason ?? output.status;
  });
  writeKernelSummary(path); return output;
}
export function writeKernelSummary(path: string): void {
  const q = queryKernel(path), run = readRun(path);
  const lines = ["# Loop 单任务总结", ...q.lines, ...(run.notes ?? []).map((s) => `说明：${s}`), "", "## 节点证据"];
  for (const r of run.results) lines.push(`- ${r.task} / ${r.node}：${r.status}；commit ${r.candidate.commit}；tree ${r.candidate.tree}；输入 ${r.inputs}；尝试 ${r.id}；开始 ${r.started}；结束 ${r.ended ?? "未确认"}；释放 ${r.released ? "已确认" : "未确认"}；${r.reason ?? ""}`,
    ...r.operations.map((s) => `  - 操作：${s}`), ...r.evidence.map((p) => `  - 证据：${p}`));
  for (const c of run.changes ?? []) lines.push(`- 改卡 ${c.id}：${c.state}；发起来源 ${c.source}；请求 ${c.at}；生效 ${c.appliedAt ?? "未生效"}；用户决定 ${c.authorization ?? "无额外决定"}；${c.reason ?? ""}`,
    `  - 原卡/提案：${join(run.dir, "card-changes", c.id)}；新 flow ${c.card.flow.join(" → ")}；测试 ${c.card.tasks[0].test ?? "未安排"}；限额 ${JSON.stringify(c.card.limits)}`);
  if (run.abandonment) lines.push(`- 放弃：${run.abandonment.at}；来源 ${run.abandonment.source}；HEAD ${run.abandonment.head ?? "无"}；保留 ref ${run.abandonment.history ?? "无"}；资源 ${run.release.status}`);
  for (const integration of run.integrations ?? []) lines.push(`- dev 整合：${integration.target.commit} → ${integration.candidate.commit}/${integration.candidate.tree}；范围来源 ${integration.scopeBase}；证据 ${integration.evidence}`);
  for (const d of run.decisions) lines.push(`- 用户例外决定 ${d.id}：${d.at}；来源 ${d.source}；${d.text}；候选 ${d.candidate.commit}/${d.candidate.tree}；输入 ${d.inputs ?? "历史身份缺失"}；用户版本 ${d.userVersion ?? "未知"}`, ...d.missing.map((s) => `  - 欠项：${s}`));
  writeFileSync(join(run.dir, "summary.md"), `${lines.join("\n")}\n`);
}
