/** 同卡受控变更：先校验再记请求，边界应用；来源和授权与机器返修分开。 */
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { digest, ownedCriteria, parseDevelopmentCard } from "./development-card.ts";
import { activityAlive, atomicRun, readRun, taskIds, taskView, updateRun, validResult, type CardChange } from "./node-ledger.ts";
import { acceptanceBasis, acceptanceSignature, checkInputs, frozenCardProblem } from "./kernel-workspace.ts";
import { writeKernelSummary } from "./kernel.ts";
import { consumerProblem, readLocalQueue, releaseLocalSlot } from "./local-node-queue.ts";
import { rebuildBatch } from "./batch-integration.ts";
import { ownedProcessGroupAlive } from "./procs.ts";

const now = (): string => new Date().toISOString();
function install(file: string, content: string, mode = 0o600): void {
  const temp = join(dirname(file), `.loop-card-${randomUUID()}.tmp`);
  try { writeFileSync(temp, content, { mode, flag: "wx" }); renameSync(temp, file); }
  finally { rmSync(temp, { force: true }); }
}
/** 真实交互适配层调用；原话确认仅绑定当前卡，不能由命令行开关/机器文字伪造。 */
export function recordCardControl(path: string, text: string, source: string): boolean {
  if (!["pi:interactive", "pi:rpc", "claude:UserPromptSubmit", "codex:UserPromptSubmit", "terminal:tty"].includes(source)) return false;
  const node = /^(?:去掉|移除|取消)本批(?:必需)?(测试|验收)(?:节点)?[。！!\s]*$/.exec(text.trim());
  const task = /^(移出任务|继续修任务)\s*[「"']?(.+?)[」"']?[。！!]*$/.exec(text.trim());
  const standard = /^确认本批验收标准[。！!\s]*$/.test(text.trim());
  if (!node && !task && !standard) return false;
  const action = standard ? "change-acceptance" : node ? node[1] === "测试" ? "remove-test" : "remove-acceptance" : task![1] === "移出任务" ? "remove-task" : "raise-acceptance";
  updateRun(path, (r) => {
    if (task && !r.card.tasks.some((t) => t.name === task[2])) throw new Error(`未知任务：${task[2]}`);
    (r.controlDecisions ??= []).push({ id: randomUUID(), source, text, at: now(), cardHash: r.cardHash, userVersion: r.userVersion, action, task: task?.[2], ...(standard && r.card.acceptance ? { acceptance: { path: r.card.acceptance, hash: digest(readFileSync(r.card.acceptance)) } } : {}) });
  });
  return true;
}
export function controlSource(env: NodeJS.ProcessEnv = process.env): string {
  if (env.AUTOREVIEW_KERNEL_LEDGER) return "machine:managed-session";
  return process.stdin.isTTY ? "terminal:tty" : "cli:automation";
}
export function requestCardChange(path: string, options: { removeNode?: string; removeTask?: string; from?: string; source: string; dryRun?: boolean }): CardChange {
  const run = readRun(path), problem = frozenCardProblem(run);
  if (problem) throw new Error(problem);
  if (run.abandoned || run.publication || run.pendingCard) throw new Error("已放弃/已发布或有 pending 改卡请求，拒绝重复请求");
  if ([options.removeNode, options.removeTask, options.from].filter(Boolean).length !== 1) throw new Error("改卡须且只能选 --remove-node、--remove-task 或 --from");
  const before = readFileSync(run.file, "utf8"), raw = JSON.parse(before);
  let content: string;
  if (options.removeNode) {
    if (!["测试", "验收"].includes(options.removeNode) || !raw.flow.includes(options.removeNode)) throw new Error("只能移除本卡已安排的测试/单任务验收；不可移除开发评审");
    raw.flow = raw.flow.filter((n: string) => n !== options.removeNode); content = `${JSON.stringify(raw, null, 2)}\n`;
  } else if (options.removeTask) {
    if (!raw.tasks.some((t: any) => t.name === options.removeTask)) throw new Error(`未知任务：${options.removeTask}`);
    if (raw.tasks.length === 1) throw new Error("零任务只能明确整批放弃；请用 放弃 <卡>，不能自动合入空批");
    raw.tasks = raw.tasks.filter((t: any) => t.name !== options.removeTask); content = `${JSON.stringify(raw, null, 2)}\n`;
  } else content = readFileSync(options.from!, "utf8");
  const parsed = parseDevelopmentCard(content, run.file, run.repo, run.taskRecords?.map((t) => t.name)), card = parsed.card;
  const removed = run.card.tasks.filter((t) => !card.tasks.some((n) => n.name === t.name));
  const retained = run.card.tasks.filter((t) => !removed.includes(t));
  if (["base", "target", "nature", "host"].some((k) => (card as any)[k] !== (run.card as any)[k])
    || JSON.stringify(card.tasks.map(({ test: _test, limits: _limits, ...task }) => task)) !== JSON.stringify(retained.map(({ test: _test, limits: _limits, ...task }) => task))) throw new Error("改卡不能替换启动时任务身份、prompt/scope、顺序、分支或宿主；请另建卡");
  if (run.card.flow.includes("验收") && card.limits.验收.maxRepairs > (run.card.limits.验收?.maxRepairs ?? 3)) throw new Error("继续修只能提高指定 tasks[].limits.验收.maxRepairs，不自动扩大其他任务额度");
  const actions: { action: "remove-test" | "remove-acceptance" | "remove-task" | "raise-acceptance" | "change-acceptance"; task?: string; acceptance?: { path: string; hash: string } }[] = [];
  const acceptanceVersion = card.flow.includes("验收") && card.acceptance ? { path: card.acceptance, hash: digest(readFileSync(card.acceptance)) } : undefined;
  if (acceptanceVersion && (acceptanceVersion.path !== run.card.acceptance || acceptanceVersion.hash !== run.acceptanceState?.hash)) actions.push({ action: "change-acceptance", acceptance: acceptanceVersion });
  if (run.card.flow.includes("测试") && (!card.flow.includes("测试") || card.tasks.some((t) => /^无[:：]/.test(t.test ?? "") && !/^无[:：]/.test(run.card.tasks.find((o) => o.name === t.name)?.test ?? "")))) actions.push({ action: "remove-test" });
  if (run.card.flow.includes("验收") && !card.flow.includes("验收")) actions.push({ action: "remove-acceptance" });
  for (const t of removed) actions.push({ action: "remove-task", task: t.name });
  for (const t of card.tasks) if ((t.limits?.验收.maxRepairs ?? card.limits.验收.maxRepairs) > (run.card.tasks.find((o) => o.name === t.name)?.limits?.验收.maxRepairs ?? run.card.limits.验收.maxRepairs)) actions.push({ action: "raise-acceptance", task: t.name });
  const authorizations = actions.map((action) => [...(run.controlDecisions ?? [])].reverse().find((d) => !d.used && d.cardHash === run.cardHash && d.userVersion === run.userVersion && d.action === action.action && d.task === action.task && (!action.acceptance || JSON.stringify(d.acceptance) === JSON.stringify(action.acceptance))));
  if (actions.length && options.source !== "terminal:tty" && authorizations.some((d) => !d)) throw new Error("移除必需测试/验收、移出任务或提高验收额度须真实用户决定：交互终端执行，或原会话亲手输入「移除本批测试节点」「移出任务甲」「继续修任务甲」「确认本批验收标准」；机器返修不能代选或降低标准");
  const authorization = authorizations.find(Boolean);
  const change: CardChange = { id: randomUUID(), source: options.source, authorization: authorization?.id, userVersion: run.userVersion, at: now(), before, expectedHash: run.cardHash, card, content, acceptanceVersion, removeTasks: removed.map((t) => run.taskRecords!.find((r) => r.name === t.name)!.id), state: "pending" };
  if (options.dryRun) return change;
  updateRun(path, (r) => {
    if (r.cardHash !== change.expectedHash || r.pendingCard || frozenCardProblem(r) || r.abandoned || r.publication) throw new Error("请求边界卡版本或任务状态变化");
    for (const authorization of authorizations.filter(Boolean)) {
      const decision = r.controlDecisions?.find((d) => d.id === authorization!.id && !d.used && d.userVersion === r.userVersion && d.cardHash === r.cardHash);
      if (!decision) throw new Error("用户改卡决定已失效"); decision.used = change.id;
    }
    const dir = join(r.dir, "card-changes", change.id); mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, "before.json"), before, { mode: 0o600, flag: "wx" });
    writeFileSync(join(dir, "proposed.json"), content, { mode: 0o600, flag: "wx" });
    (r.changes ??= []).push(change); r.pendingCard = change.id;
  });
  applyPendingCardChange(path); writeKernelSummary(path); return readRun(path).changes!.find((c) => c.id === change.id)!;
}
/** 每个节点进出/显式续跑调用；query 不调用。pending 与取得节点运行权共用账本短锁。 */
export function applyPendingCardChange(path: string): boolean {
  const oldTickets: string[] = [];
  let rebuilding: string | undefined;
  const applied = updateRun(path, (r) => {
    const c = r.changes?.find((c) => c.id === r.pendingCard);
    if (!c) return false;
    if (r.publication || r.abandoned) throw new Error("已发布/放弃，保留待处理改卡记录");
    if (c.userVersion !== r.userVersion) {
      c.state = "rejected"; c.reason = "请求后真实用户输入/撤权版本变化，请按当前决定重新提出改卡"; r.pendingCard = undefined; r.stopped = true; r.stopReason = c.reason; return false;
    }
    if ([r.activity, ...(r.taskRecords ?? []).map((t) => t.activity)].some((a) => a && a.kind !== "waiting" && activityAlive(a) !== false)) return false;
    for (const id of c.removeTasks ?? []) {
      const t = taskView(r, id);
      if (!t.abandonment?.history || [t.launch, t.supervisor, t.worker].some((g) => g && ownedProcessGroupAlive(g) !== false) || consumerProblem(join(t.dir, "review.procs.json")) || readLocalQueue().items.some((ticket) => ticket.ledger === path && ticket.task === id)) return false;
    }
    // 消费者未释放不能把“无 activity”误当安全边界。
    if (r.release.status === "未确认") throw new Error("资源释放未确认，改卡未应用");
    const actual = digest(readFileSync(r.file)), nextHash = digest(c.content);
    if (actual !== c.expectedHash && !(c.state === "prepared" && actual === nextHash)) {
      const observed = join(r.dir, "card-changes", c.id, `observed-${randomUUID()}.json`);
      writeFileSync(observed, readFileSync(r.file), { mode: 0o600 });
      c.state = "rejected"; c.reason = `开发卡直接修改，未覆盖；现场 ${observed}`; r.stopped = true; r.stopReason = c.reason; r.pendingCard = undefined; return false;
    }
    parseDevelopmentCard(c.content, r.file, r.repo, r.taskRecords?.map((t) => t.name));
    if (c.acceptanceVersion && digest(readFileSync(c.acceptanceVersion.path)) !== c.acceptanceVersion.hash) {
      c.state = "rejected"; c.reason = "验收标准在确认/请求后又变化，未采用；请真实用户按当前版本重新确认"; r.pendingCard = undefined; r.stopped = true; r.stopReason = c.reason; return false;
    }
    if (c.installed) { rebuilding = c.id; return true; }
    // v1 仅在完整旧指纹仍有效且证据存在时可证明地转投影；不改写旧历史。
    if (r.inputVersion !== 2) {
      const legacy = checkInputs(r).hash, passing = r.results.filter((v) => !!r.candidate && validResult(r, v.node, r.candidate, legacy)?.id === v.id);
      r.inputVersion = 2;
      for (const result of passing) r.results.push({ ...result, id: randomUUID(), inputs: checkInputs(r, result.node).hash,
        operations: [...result.operations, `完整旧指纹 ${legacy} 仍有效，迁移自 ${result.id}；未重新实测`] });
    }
    const info = lstatSync(r.file);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error("卡文件身份不安全，未替换");
    c.state = "prepared"; atomicRun(path, r); // 中断后只接受原 hash/精确新 hash。
    if (digest(readFileSync(r.file)) !== actual) throw new Error("安装前卡又被直接修改，未替换");
    install(r.file, c.content, info.mode & 0o777);
    install(join(r.dir, "frozen-card.json"), c.content);
    for (const view of [r, ...(r.taskRecords ?? []).filter((t) => !t.removed)]) if (view.activity?.kind === "waiting") { if (view.activity.ticket) oldTickets.push(view.activity.ticket); view.activity = undefined; if (view !== r) view.epoch = (view.epoch ?? 0) + 1; }
    const changedTasks = c.card.tasks.filter((t) => t.test !== r.card.tasks.find((o) => o.name === t.name)?.test || c.card.flow.includes("测试") !== r.card.flow.includes("测试")).map((t) => t.name);
    const acceptanceChanged = c.card.acceptance && (c.card.acceptance !== r.card.acceptance || digest(readFileSync(c.card.acceptance)) !== r.acceptanceState?.hash);
    r.card = c.card; r.cardHash = nextHash; r.cardRevision = (r.cardRevision ?? 0) + 1; r.epoch = (r.epoch ?? 0) + 1;
    if (acceptanceChanged) {
      const standard = ownedCriteria(r.card.acceptance!, r.taskRecords?.map((t) => t.name) ?? r.card.tasks.map((t) => t.name));
      r.acceptanceState = { criteria: { source: "用户", items: standard.items, version: (r.acceptanceState?.criteria.version ?? 0) + 1, updatedAt: now() }, hash: standard.hash, owners: standard.owners, round: r.acceptanceState?.round ?? 0 };
    }
    if (r.acceptanceState?.previous && changedTasks.length && !acceptanceChanged) {
      const s = r.acceptanceState, pending = s.plan?.waitFor?.length ? s.plan : undefined;
      s.plan = { ids: s.criteria.items.filter((i) => pending?.ids.includes(i.id) || changedTasks.includes(s.owners[i.id])).map((i) => i.id), repairTasks: pending?.repairTasks ?? [], waitFor: pending?.waitFor,
        mapping: JSON.stringify(r.batch?.contributions ?? r.candidate), signature: acceptanceSignature(r), basis: pending?.basis ?? acceptanceBasis(r), pendingInputs: pending?.pendingInputs };
    }
    if (r.acceptanceState?.plan && !r.acceptanceState.plan.pendingInputs?.length && r.acceptanceState.plan.signature !== acceptanceSignature(r)) r.acceptanceState.plan = undefined;
    for (const id of c.removeTasks ?? []) {
      const task = r.taskRecords!.find((t) => t.id === id)!; task.removed = true;
      if (!r.batch!.removed.some((t) => t.id === id)) r.batch!.removed.push({ id, name: task.name, at: now(), source: c.source, history: task.abandonment?.history });
    }
    if (c.removeTasks?.length) { r.acceptanceState!.plan = undefined; r.stopped = false; r.stopReason = "移出意图已冻结，等待贡献重建与全部剩余条目重验"; c.installed = true; rebuilding = c.id; }
    else { c.state = "applied"; c.appliedAt = now(); r.pendingCard = undefined; r.stopReason = undefined; }
    return true;
  });
  for (const oldTicket of oldTickets) {
    const ticket = readLocalQueue().items.find((t) => t.id === oldTicket && t.ledger === path);
    if (ticket) releaseLocalSlot(ticket.id, ticket.token, true);
  }
  if (rebuilding) {
    try {
      rebuildBatch(path, taskIds(readRun(path)), rebuilding);
      updateRun(path, (r) => { const c = r.changes!.find((c) => c.id === rebuilding)!; if (r.pendingCard !== rebuilding) throw new Error("移出事务代次变化"); c.state = "applied"; c.appliedAt = now(); r.pendingCard = undefined; });
    } catch (error) { updateRun(path, (r) => { r.stopped = true; r.stopReason = `移出贡献重建未完成，保留成果和事务：${String(error)}`; }); return false; }
  }
  return applied;
}
