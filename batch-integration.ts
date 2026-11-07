/** 贡献与批次 Git 装配；不调用模型、测试、验收或提交节点。 */
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { eventLock } from "./events.ts";
import { digest, type NodeName } from "./development-card.ts";
import { batchAssemblyProblem, contributionProblems, currentCandidate, kernelCommand } from "./kernel.ts";
import { checkInputs, dirtyPaths, fileDigest, frozenCardProblem, gitRaw, taskScopeBaseline, workspaceGuard } from "./kernel-workspace.ts";
import { activityAlive, atomicRun, readRun, taskDefinition, taskIds, taskView, updateRun, validResult, type Candidate, type Contribution, type KernelRun } from "./node-ledger.ts";
import { outOfScope } from "./scope.ts";
import { gitResult, gitText } from "./workspace.ts";
import { consumerProblem, readLocalQueue } from "./local-node-queue.ts";
const ancestor = (r: KernelRun, a: string, b: string) => gitResult(r.repo, ["merge-base", "--is-ancestor", a, b]).status === 0;
/** 只复制本任务可证明的完整贡献。吸收来源若与本任务同文件混合，不能猜测剥离。 */
function contribution(run: KernelRun, task: string, acceptUnverified = false): Contribution {
  const view = taskView(run, task), candidate = currentCandidate(view), definition = taskDefinition(view);
  taskScopeBaseline(view, candidate.commit);
  const inputs: Record<string, string> = {}, checks: string[] = [];
  for (const node of ["开发评审", ...(run.card.flow.includes("测试") ? ["测试"] : [])] as NodeName[]) {
    inputs[node] = checkInputs(view, node).hash; const result = validResult(view, node, candidate, inputs[node]);
    if (!result && !acceptUnverified) throw new Error(`${definition.name} 缺当前 ${node} 通过结论，未集成`);
    if (result) checks.push(result.id);
  }
  const prior = run.batch?.contributions.find((c) => c.task === task);
  if (acceptUnverified && prior && JSON.stringify(prior.candidate) === JSON.stringify(candidate) && prior.base === run.base && prior.epoch === (view.epoch ?? 0) && prior.userVersion === view.userVersion
    && JSON.stringify(prior.inputs) === JSON.stringify(inputs) && JSON.stringify(prior.checks) === JSON.stringify(checks)) return prior;
  const sources = (run.batch?.integrations ?? []).filter((i) => ancestor(run, i.after.commit, candidate.commit));
  const absorbed = [...(sources.at(-1)?.mapping ?? []), ...(run.batch?.integrations ?? []).flatMap((i) => i.mapping).filter((c) => ancestor(run, c.candidate.commit, candidate.commit) || ancestor(run, c.contribution, candidate.commit))].filter((c) => c.task !== task);
  const paths = gitRaw(run.repo, ["diff", "--name-only", "--no-renames", "-z", run.base, candidate.commit, "--"]).split("\0").filter(Boolean);
  const own = paths.filter((p) => !outOfScope([p], definition.scope).length);
  for (const source of absorbed) {
    const incoming = gitRaw(run.repo, ["diff", "--name-only", "--no-renames", "-z", run.base, source.contribution, "--"]).split("\0").filter(Boolean);
    const ambiguous = own.filter((p) => incoming.includes(p));
    if (ambiguous.length) throw new Error(`任务 ${definition.name} 吸收其他任务后存在同文件混合贡献，无法安全证明替换/移出：${ambiguous.join("、")}；保留成果，请原会话从冻结基线重新交付本任务独立贡献`);
  }
  const index = join(view.dir, `contribution-index-${randomUUID()}`), env = { ...process.env, GIT_INDEX_FILE: index };
  try {
    const read = spawnSync("git", ["read-tree", run.base], { cwd: run.repo, env, encoding: "utf8" }); if (read.status !== 0) throw new Error(read.stderr);
    if (own.length) {
      const patch = spawnSync("git", ["--literal-pathspecs", "diff", "--binary", "--full-index", "--no-renames", run.base, candidate.commit, "--", ...own], { cwd: run.repo, maxBuffer: 32 * 1024 * 1024 });
      if (patch.status !== 0) throw new Error(patch.stderr.toString());
      const apply = spawnSync("git", ["apply", "--cached", "--binary", "--whitespace=nowarn", "-"], { cwd: run.repo, env, input: patch.stdout, encoding: "utf8" });
      if (apply.status !== 0) throw new Error(`贡献提取失败，未修改产品：${apply.stderr}`);
    }
    const tree = spawnSync("git", ["write-tree"], { cwd: run.repo, env, encoding: "utf8" }); if (tree.status !== 0) throw new Error(tree.stderr);
    const commit = gitText(run.repo, ["commit-tree", tree.stdout.trim(), "-p", run.base, "-m", `Loop ${acceptUnverified ? "已登记" : "已检查"}贡献 ${task}\n来源 ${candidate.commit}\n实测树 ${candidate.tree}`]);
    return { task, candidate, base: run.base, patchBase: sources.at(-1)?.after.commit ?? run.base, contribution: commit, inputs, checks, epoch: view.epoch ?? 0, userVersion: view.userVersion };
  } finally { rmSync(index, { force: true }); rmSync(`${index}.lock`, { force: true }); }
}
function compose(run: KernelRun, mapping: Contribution[]): Candidate {
  const source = run.batch?.targetSource;
  if (source && (!ancestor(run, run.targetAtStart, source.commit) || !ancestor(run, source.commit, "refs/heads/dev"))) throw new Error("登记 dev 来源已改换历史，未装配未知代码");
  let head = source?.commit ?? run.base;
  for (const c of mapping) {
    const merged = gitResult(run.repo, ["merge-tree", "--write-tree", head, c.contribution]);
    if (merged.status !== 0) throw new Error(`任务 ${c.task} 汇入冲突；已集成来源 ${mapping.slice(0, mapping.indexOf(c)).map((s) => `${s.task}:${s.candidate.commit}`).join("、") || "冻结基线"}\n${merged.stdout}\n${merged.stderr}`);
    const tree = merged.stdout.split("\n")[0].trim();
    head = gitText(run.repo, ["commit-tree", tree, "-p", head, "-p", c.contribution, "-m", `Loop 批次贡献 ${c.task}\n候选 ${c.candidate.commit}\n检查 ${c.checks.join(",")}`]);
  }
  return { commit: head, tree: gitText(run.repo, ["rev-parse", `${head}^{tree}`]) };
}
/** 批次 worktree 只接受登记本机文件；未知忽略文件也不能被 checkout/释放覆盖。 */
function cleanBatch(run: KernelRun): void {
  currentCandidate(run);
  const problem = batchAssemblyProblem(run); if (problem) throw new Error(problem);
  if (activityAlive(run.activity) !== false || run.batch?.pending) throw new Error("批次节点/集成事务尚未结束");
  const unknown = gitRaw(run.worktree, ["ls-files", "--others", "-z"]).split("\0").filter(Boolean).filter((p) => !run.localFiles.includes(p));
  if (unknown.length || dirtyPaths(run).length) throw new Error(`批次目录含未知/未保存成果：${unknown.join("、")}`);
  for (const p of run.localFiles) if (fileDigest(join(run.worktree, p)) !== run.localHashes[p]) throw new Error(`批次本机文件变化：${p}`);
}
/** 登记源码与通过资格分开：保留贡献可缺检查，但已有通过声明必须仍有原记录/证据。 */
function verifyContribution(run: KernelRun, c: Contribution, mode: "ready" | "registered" | "exception"): void {
  const view = taskView(run, c.task), current = mode !== "registered";
  if (current && (view.candidate?.commit !== c.candidate.commit || view.userVersion !== c.userVersion || (view.epoch ?? 0) !== c.epoch)) throw new Error("任务候选/控制代次已变化，未集成");
  if (!current && !run.batch!.contributions.some((old) => old.task === c.task && JSON.stringify(old) === JSON.stringify(c))) throw new Error("保留贡献只接受已登记映射，不能夹带其他任务在途候选");
  const checked: string[] = [];
  for (const [node, hash] of Object.entries(c.inputs)) {
    if (current && checkInputs(view, node as NodeName).hash !== hash) throw new Error("任务检查输入已变化，未集成");
    const result = validResult(view, node as NodeName, c.candidate, hash);
    if (result) checked.push(result.id);
    if (mode === "ready" && !c.checks.includes(result?.id ?? "")) throw new Error("任务检查证据已变化，未集成");
  }
  if (mode === "exception" && JSON.stringify(c.checks) !== JSON.stringify(checked)) throw new Error("例外确认前检查快照变化，须重新冻结来源");
  if (mode === "registered") for (const id of c.checks) {
    const record = view.results.find((r) => r.id === id), hash = record && c.inputs[record.node];
    if (!record || !["开发评审", "测试"].includes(record.node) || typeof hash !== "string" || validResult({ ...view, results: [record] }, record.node, c.candidate, hash)?.id !== id) throw new Error("保留贡献已有检查声明的原记录或证据缺失");
  }
}
function install(path: string, run: KernelRun, mapping: Contribution[], task: string, cardChange?: string, acceptUnverified = false): void {
  cleanBatch(run);
  const before = currentCandidate(run), after = compose(run, mapping), id = randomUUID(), version = run.batch!.version, guard = workspaceGuard(run);
  const evidence = join(run.dir, `batch-integration-${id}.json`), history = `refs/loop/kernel/${run.id}/batch-history/${version}-${id}`;
  const entry = { id, task, at: new Date().toISOString(), before, after, mapping, history, evidence, order: run.batch!.integrations.length + 1, control: cardChange, targetSource: run.batch?.targetSource };
  writeFileSync(evidence, JSON.stringify(entry, null, 2), { mode: 0o600 });
  updateRun(path, (r) => {
    if (r.stopped && !acceptUnverified || r.abandoned || r.pendingCard && r.pendingCard !== cardChange || r.batch!.version !== version || r.epoch !== run.epoch || r.cardHash !== run.cardHash || frozenCardProblem(r) || workspaceGuard(r) !== guard) throw new Error("集成边界输入、控制或批次头变化，未覆盖");
    for (const c of mapping) verifyContribution(r, c, acceptUnverified ? "exception" : !cardChange && c.task === task ? "ready" : "registered");
    if (acceptUnverified) assertExceptionIdle(r, path);
    gitText(r.repo, ["update-ref", history, before.commit, "0".repeat(40)]);
    r.batch!.pending = { id, before: before.commit, after: after.commit, version, entry, guard, epoch: r.epoch }; atomicRun(path, r);
    gitText(r.repo, ["update-ref", `refs/heads/${r.branch}`, after.commit, before.commit]);
    gitText(r.worktree, ["-c", "core.hooksPath=/dev/null", "read-tree", "-m", "-u", before.commit, after.commit]);
    r.candidate = after; r.batch!.version++; r.batch!.contributions = mapping; r.batch!.integrations.push(entry); r.batch!.pending = undefined;
  });
}
function assertExceptionIdle(run: KernelRun, path: string): void {
  if (run.abandoned || run.publication || run.pendingCard || run.release.status === "未确认" || run.taskRecords?.some((t) => t.release.status === "未确认")
    || [run.activity, ...(run.taskRecords ?? []).map((t) => t.activity)].some(Boolean) || readLocalQueue().items.some((t) => t.ledger === path)) throw new Error("例外来源冻结前须停止节点并确认资源；不会合入在途或未知成果");
  for (const dir of [run.dir, ...(run.taskRecords ?? []).map((t) => t.dir)]) { const problem = consumerProblem(join(dir, "review.procs.json")); if (problem) throw new Error(problem); }
}
/** 只由真实用户例外入口在确认前调用：冻结全部当前登记候选，允许欠检查，不允许欠来源。 */
export function prepareExceptionCandidate(path: string): void {
  const unlock = eventLock(`${path}.integration.lock`);
  try {
    const run = readRun(path); if (!run.batch) return;
    assertExceptionIdle(run, path); cleanBatch(run);
    const mapping = taskIds(run).map((id) => contribution(run, id, true));
    if (!contributionProblems(run, false).length && JSON.stringify(mapping) === JSON.stringify(run.batch.contributions)) return;
    install(path, run, mapping, "user:exception", undefined, true);
  } finally { unlock(); }
}
/** 仅显式恢复入口调用；只处理精确 before/after 与原始工作区证明，不由查询补写。 */
export function recoverBatchIntegration(path: string): void {
  const unlock = eventLock(`${path}.integration.lock`);
  try {
    updateRun(path, (r) => {
      const p = r.batch?.pending; if (!p) return;
      if (!p.entry || !p.guard || p.epoch !== r.epoch || r.batch!.version !== p.version || activityAlive(r.activity) !== false) throw new Error("批次集成意图缺少原始证明或控制代次变化，保留事务与成果，未猜测恢复");
      const head = gitText(r.worktree, ["rev-parse", "HEAD"]);
      if (head !== p.before && head !== p.after) throw new Error("批次头不等于意图两端，保留现场");
      if (workspaceGuard(r, p.before) !== p.guard) throw new Error("集成中断后工作区/索引/本机文件变化，保留未保存成果，未自动覆盖");
      if (head === p.after) {
        if (p.entry.control && p.entry.control !== r.pendingCard) throw new Error("恢复时受控重建事务已变化，保留现场");
        for (const c of p.entry.mapping) verifyContribution(r, c, p.entry.task === "user:exception" ? "exception" : !p.entry.control && c.task === p.entry.task ? "ready" : "registered");
        gitText(r.worktree, ["-c", "core.hooksPath=/dev/null", "read-tree", "-m", "-u", p.before, p.after]);
        r.candidate = p.entry.after; r.batch!.contributions = p.entry.mapping; r.batch!.version++;
        if (!r.batch!.integrations.some((i) => i.id === p.id)) r.batch!.integrations.push(p.entry);
      }
      r.batch!.pending = undefined;
    });
  } finally { unlock(); }
}
export function rebuildBatch(path: string, retained: string[], cardChange?: string): void {
  const unlock = eventLock(`${path}.integration.lock`);
  try {
    const run = readRun(path); if (!run.batch) return;
    const mapping = run.batch.contributions.filter((c) => retained.includes(c.task));
    if (cardChange && run.batch.integrations.some((i) => i.control === cardChange && i.after.commit === run.candidate?.commit && JSON.stringify(i.mapping) === JSON.stringify(mapping))) return;
    install(path, run, mapping, "user:remove-task", cardChange);
  } finally { unlock(); }
}
export function integrateTask(path: string, task: string): { ok: boolean; reason?: string; evidence: string[]; message?: string; failure?: "product" | "environment" } {
  const unlock = eventLock(`${path}.integration.lock`);
  const expected = taskView(readRun(path), task);
  try {
    const run = readRun(path), view = taskView(run, task), id = view.taskId!;
    if (!run.batch || !id) throw new Error("缺少批次/任务身份");
    const prior = run.batch.contributions.find((c) => c.task === id);
    if (prior && prior.candidate.commit === view.candidate?.commit && prior.epoch === (view.epoch ?? 0) && prior.userVersion === view.userVersion && Object.entries(prior.inputs).every(([n, hash]) => checkInputs(view, n as NodeName).hash === hash && prior.checks.includes(validResult(view, n as NodeName, prior.candidate, hash)?.id ?? ""))) return { ok: true, evidence: [] };
    const c = contribution(run, id), mapping = run.batch.contributions.filter((c) => c.task !== id);
    mapping.push(c); install(path, run, mapping, id);
    return { ok: true, evidence: [readRun(path).batch!.integrations.at(-1)!.evidence] };
  } catch (error) {
    const reason = String(error), run = readRun(path), view = taskView(run, task), id = randomUUID(), token = randomUUID();
    if (run.stopped || run.pendingCard || view.stopped || view.candidate?.commit !== expected.candidate?.commit || view.userVersion !== expected.userVersion || view.epoch !== expected.epoch || run.batch?.pending || activityAlive(run.activity) !== false) return {
      ok: false, failure: "environment", reason: `集成已取消/等待边界或意图未确认，未向任务发送旧返修。${reason}；补救：${kernelCommand("续跑", run.file, "--task", taskDefinition(view).name)}`, evidence: [] };
    const evidence = join(view.dir, `integration-conflict-${id}.md`);
    const message = `【Loop 集成返修】[${id}:${token}]\n仅任务 ${taskDefinition(view).name} 返回原开发评审会话；不扣验收次数。\n${reason}\n已集成来源：${JSON.stringify(run.batch?.contributions)}\n请在原 scope 内交付可证明的独立贡献；不能夹带其他任务来源或编辑批次目录。最后写【交付完成】。`;
    writeFileSync(evidence, message, { mode: 0o600 });
    updateRun(path, (r) => { const t = r.taskRecords!.find((t) => t.id === view.taskId)!;
      t.stopReason = reason; t.blockedNode = "开发评审";
      if (view.candidate && !t.stopped) t.repair = { id, token, taskId: t.id, node: "开发评审", attempt: id, candidate: view.candidate, inputs: checkInputs(taskView(r, t.id), "开发评审").hash, userVersion: t.userVersion, epoch: t.epoch ?? 0,
        session: t.session?.id ?? "unattached", host: t.session?.host ?? r.card.host, message, hash: digest(message), file: evidence, state: "pending", at: new Date().toISOString() };
    });
    return { ok: false, failure: "product", reason, evidence: [evidence], message };
  } finally { unlock(); }
}
