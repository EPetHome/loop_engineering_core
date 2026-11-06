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

export interface NodeInput { ledger: string; attempt: string; evidenceDir: string; run: KernelRun; candidate: Candidate; inputs: string }
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
  const run: KernelRun = { v: 1, revision: 0, id, repo, common: identity.common, file, dir: dirname(path), card: parsed.card, cardHash: parsed.hash,
    base, targetAtStart: target, created: stamp(), branch: `chore/loop-${id}`, worktree: join(kernelRoot(), "worktrees", identity.key, id, "task"),
    workspaceCreated: false, localFiles, localHashes: Object.fromEntries(localFiles.map((p) => [p, fileDigest(join(repo, p))])),
    results: [], repairs: 0, userVersion: 0, userInputs: [], decisions: [], release: { status: "未释放", details: [] } };
  checkInputs(run);
  if (dryRun) return { path, lines: ["开发卡及配置核对通过；未建目录/分支，未启动模型", `目标 dev；开工依据 ${base}`, "测试、验收：没验证（本次未安排）"] };
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
export function kernelCommand(action: string, file: string): string {
  const quote = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`;
  const probe = gitResult(dirname(file), ["rev-parse", "--show-toplevel"]);
  const cwd = probe.status === 0 ? probe.stdout.trim() : process.cwd();
  return `cd ${quote(cwd)} && ${[join(dirname(fileURLToPath(import.meta.url)), "bin", "loop"), action, file].map(quote).join(" ")}`;
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
  for (const node of beforeSubmit) if (!candidate || !inputs || !validResult(run, node, candidate, inputs))
    missing.push(`${run.card.tasks[0].name} / ${node} / 树 ${candidate?.tree ?? run.candidate?.tree ?? "无候选"}：缺少当前输入的有效通过结论；补救：${kernelCommand("续跑", run.file)}`);
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
  const status = locallyMerged || external ? "已合入" : run.abandoned ? "已放弃" : !run.stopped && alive ? "进行中" : blockedPublication ? "等你决定" : !q.missing.length ? "可合入" : "等你决定";
  const reason = external ? "已合入（Loop 外）；没有伪造检查通过，远端与释放需另行核实" : locallyMerged ? `已合入（本地）；推送：${publication?.push ?? "未确认"}；${publication?.push === "未确认" ? "推送执行已不活动或归属未确认，远端结果未知，不自动重试；" : ""}${run.publication?.reason ?? ""}`
    : run.stopReason || (a && !alive ? "登记节点已不执行或身份无法确认" : q.missing[0]) || "卡上前置结论均有效";
  const attemptDir = join(run.dir, "attempts");
  const attempts = existsSync(attemptDir) ? readdirSync(attemptDir, { withFileTypes: true }).filter((d) => d.isDirectory() && /^[0-9a-f-]{36}$/.test(d.name)).map((d) => {
    const request = join(attemptDir, d.name, "attempt.json");
    const result = run.results.find((r) => r.id === d.name);
    try { return { ...JSON.parse(readFileSync(request, "utf8")), status: result?.status ?? "结果未确认", evidence: request }; }
    catch { return { id: d.name, status: "尝试记录无法读取", evidence: request }; }
  }) : [];
  return { ok: true, kernel: 1, id: run.id, card: run.file, name: run.card.name, status, task: run.card.tasks[0].name,
    node: a?.node ?? (locallyMerged ? "提交" : "开发评审"), reason, candidate: run.candidate, missing: q.missing,
    activity: alive && !run.stopped ? a : null, externalMerge: external ?? null, publication,
    release: run.release, notes: run.notes ?? [], decisions: run.decisions, integrations: run.integrations ?? [], attempts, results: run.results, summary: join(run.dir, "summary.md"), ledger: path,
    lines: [`${status}：${run.card.name} / ${run.card.tasks[0].name} / ${a?.node ?? (locallyMerged ? "提交" : "开发评审")}`, reason,
      ...q.missing, ...(blockedPublication && !locallyMerged ? [`处理上述原因后：${kernelCommand(run.publication ? "续跑" : "合入", run.file)}`] : []), "测试：没验证（本次未安排）", "验收：没验证（本次未安排）", `资源：${run.release.status}${run.release.details.length ? `；${run.release.details.join("；")}` : ""}`, `总结：${join(run.dir, "summary.md")}`] };
}
export async function executeNode(path: string, node: NodeName, executor: NodeExecutor): Promise<NodeOutput> {
  const initial = readRun(path), problem = frozenCardProblem(initial);
  if (problem) { updateRun(path, (r) => { r.stopped = true; r.activity = undefined; r.stopReason = problem; }); throw new Error(problem); }
  if (initial.stopped || initial.abandoned) throw new Error("任务已停止或放弃，不能自动推进");
  const candidate = currentCandidate(initial), inputs = checkInputs(initial).hash;
  if (validResult(initial, node, candidate, inputs)) return { status: "通过", evidence: validResult(initial, node, candidate, inputs)!.evidence, operations: ["同树、同输入复用原结论"], released: true };
  const id = randomUUID(), started = stamp(), guard = workspaceGuard(initial);
  const run = updateRun(path, (r) => {
    if (r.stopped || r.abandoned) throw new Error("任务已停止；先续跑，不能用迟到交付自动推进");
    if (r.userVersion !== initial.userVersion || checkInputs(r).hash !== inputs || workspaceGuard(r) !== guard) throw new Error("节点启动边界候选或输入变化，未调用执行器");
    if (r.activity && ["reviewing", "submitting"].includes(r.activity.kind) && activityAlive(r.activity) !== false) throw new Error("节点已有活动尝试或归属未确认，未并发执行");
    r.candidate = candidate;
    r.activity = { id, node, kind: node === "开发评审" ? "reviewing" : "submitting", pid: process.pid, started: processStartTime(process.pid) };
    return structuredClone(r);
  });
  const evidenceDir = join(run.dir, "attempts", id); mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
  const request = join(evidenceDir, "attempt.json");
  writeFileSync(request, JSON.stringify({ id, node, task: run.card.tasks[0].name, candidate, inputs, started }, null, 2));
  let output: NodeOutput;
  try { output = await executor({ ledger: path, attempt: id, evidenceDir, run, candidate, inputs }); }
  catch (error) { output = { status: "没验证", reason: String(error), failure: "unknown", evidence: [request, evidenceDir], operations: [], released: false }; }
  let current = { candidate, inputs: "失效" };
  try {
    if (workspaceGuard(readRun(path)) !== guard || frozenCardProblem(readRun(path))) throw new Error("检查期间工作区、索引或卡变化");
    current = { candidate: currentCandidate(readRun(path)), inputs: checkInputs(readRun(path)).hash };
  } catch (error) { output = { ...output, status: "中断", reason: String(error) }; }
  const fresh = finishAttempt(path, { id, candidate, inputs, userVersion: run.userVersion }, { id, task: run.card.tasks[0].name, node, candidate, inputs,
    started, ended: stamp(), status: output.status, reason: output.reason, failure: output.failure, evidence: output.evidence, operations: output.operations, released: output.released }, current);
  if (!fresh) output = { ...output, status: "中断", reason: "候选、输入或尝试身份已变化；旧结果无效", message: undefined, stale: true };
  if (fresh) updateRun(path, (r) => { if (!r.activity && !r.stopped) r.stopReason = output.status === "通过" ? undefined : output.reason ?? output.status; });
  writeKernelSummary(path);
  return output;
}
export function writeKernelSummary(path: string): void {
  const q = queryKernel(path), run = readRun(path);
  const lines = ["# Loop 单任务总结", ...q.lines, ...(run.notes ?? []).map((s) => `说明：${s}`), "", "## 节点证据"];
  for (const r of run.results) lines.push(`- ${r.task} / ${r.node}：${r.status}；commit ${r.candidate.commit}；tree ${r.candidate.tree}；输入 ${r.inputs}；尝试 ${r.id}；${r.reason ?? ""}`,
    ...r.operations.map((s) => `  - 操作：${s}`), ...r.evidence.map((p) => `  - 证据：${p}`));
  for (const integration of run.integrations ?? []) lines.push(`- dev 整合：${integration.target.commit} → ${integration.candidate.commit}/${integration.candidate.tree}；范围来源 ${integration.scopeBase}；证据 ${integration.evidence}`);
  for (const d of run.decisions) lines.push(`- 用户例外决定 ${d.id}：${d.at}；来源 ${d.source}；${d.text}；候选 ${d.candidate.commit}/${d.candidate.tree}；输入 ${d.inputs ?? "历史身份缺失"}；用户版本 ${d.userVersion ?? "未知"}`, ...d.missing.map((s) => `  - 欠项：${s}`));
  writeFileSync(join(run.dir, "summary.md"), `${lines.join("\n")}\n`);
}
