/** 同卡受控变更：先校验再记请求，边界应用；来源和授权与机器返修分开。 */
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { digest, parseDevelopmentCard } from "./development-card.ts";
import { activityAlive, atomicRun, readRun, updateRun, validResult, type CardChange } from "./node-ledger.ts";
import { checkInputs, frozenCardProblem } from "./kernel-workspace.ts";
import { writeKernelSummary } from "./kernel.ts";
import { readLocalQueue, releaseLocalSlot } from "./local-node-queue.ts";

const now = (): string => new Date().toISOString();
function install(file: string, content: string, mode = 0o600): void {
  const temp = join(dirname(file), `.loop-card-${randomUUID()}.tmp`);
  try { writeFileSync(temp, content, { mode, flag: "wx" }); renameSync(temp, file); }
  finally { rmSync(temp, { force: true }); }
}
/** 真实交互适配层调用；原话确认仅绑定当前卡，不能由命令行开关/机器文字伪造。 */
export function recordCardControl(path: string, text: string, source: string): boolean {
  if (!["pi:interactive", "pi:rpc", "claude:UserPromptSubmit", "codex:UserPromptSubmit", "terminal:tty"].includes(source) || !/^(?:去掉|移除|取消)本批(?:必需)?测试(?:节点)?[。！!\s]*$/.test(text.trim())) return false;
  updateRun(path, (r) => { (r.controlDecisions ??= []).push({ id: randomUUID(), source, text, at: now(), cardHash: r.cardHash, userVersion: r.userVersion, action: "remove-test" }); });
  return true;
}
export function controlSource(env: NodeJS.ProcessEnv = process.env): string {
  if (env.AUTOREVIEW_KERNEL_LEDGER) return "machine:managed-session";
  return process.stdin.isTTY ? "terminal:tty" : "cli:automation";
}
export function requestCardChange(path: string, options: { removeNode?: string; from?: string; source: string; dryRun?: boolean }): CardChange {
  const run = readRun(path), problem = frozenCardProblem(run);
  if (problem) throw new Error(problem);
  if (run.abandoned || run.publication || run.pendingCard) throw new Error("已放弃/已发布或有 pending 改卡请求，拒绝重复请求");
  if (!!options.removeNode === !!options.from) throw new Error("改卡须且只能选 --remove-node 或 --from");
  const before = readFileSync(run.file, "utf8"), raw = JSON.parse(before);
  let content: string;
  if (options.removeNode) {
    if (options.removeNode !== "测试" || !raw.flow.includes("测试")) throw new Error("只能移除本卡已安排的测试；不可移除开发评审或未上线节点");
    raw.flow = raw.flow.filter((n: string) => n !== "测试"); content = `${JSON.stringify(raw, null, 2)}\n`;
  } else content = readFileSync(options.from!, "utf8");
  const parsed = parseDevelopmentCard(content, run.file, run.repo), card = parsed.card;
  if (["base", "target", "nature", "host"].some((k) => (card as any)[k] !== (run.card as any)[k])
    || JSON.stringify(card.tasks.map(({ test: _test, ...task }) => task)) !== JSON.stringify(run.card.tasks.map(({ test: _test, ...task }) => task))) throw new Error("改卡不能替换启动时任务身份、prompt/scope、分支或宿主；请另建卡");
  const removing = run.card.flow.includes("测试") && (!card.flow.includes("测试") || /^无[:：]/.test(card.tasks[0].test ?? "") && !/^无[:：]/.test(run.card.tasks[0].test ?? ""));
  const authorization = [...(run.controlDecisions ?? [])].reverse().find((d) => !d.used && d.cardHash === run.cardHash && d.userVersion === run.userVersion && d.action === "remove-test");
  if (removing && options.source !== "terminal:tty" && !authorization) throw new Error("移除必需测试须真实用户决定：请在交互终端执行，或原会话亲手输入「移除本批测试节点」；机器返修不能自行移除测试");
  const change: CardChange = { id: randomUUID(), source: options.source, authorization: authorization?.id, userVersion: run.userVersion, at: now(), before, expectedHash: run.cardHash, card, content, state: "pending" };
  if (options.dryRun) return change;
  updateRun(path, (r) => {
    if (r.cardHash !== change.expectedHash || r.pendingCard || frozenCardProblem(r) || r.abandoned || r.publication) throw new Error("请求边界卡版本或任务状态变化");
    if (authorization) {
      const decision = r.controlDecisions?.find((d) => d.id === authorization.id && !d.used && d.userVersion === r.userVersion && d.cardHash === r.cardHash);
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
  let oldTicket: string | undefined;
  const applied = updateRun(path, (r) => {
    const c = r.changes?.find((c) => c.id === r.pendingCard);
    if (!c) return false;
    if (r.publication || r.abandoned) throw new Error("已发布/放弃，保留待处理改卡记录");
    if (c.userVersion !== r.userVersion) {
      c.state = "rejected"; c.reason = "请求后真实用户输入/撤权版本变化，请按当前决定重新提出改卡"; r.pendingCard = undefined; r.stopped = true; r.stopReason = c.reason; return false;
    }
    if (r.activity && r.activity.kind !== "waiting" && activityAlive(r.activity) !== false) return false;
    // 消费者未释放不能把“无 activity”误当安全边界。
    if (r.release.status === "未确认") throw new Error("资源释放未确认，改卡未应用");
    const actual = digest(readFileSync(r.file)), nextHash = digest(c.content);
    if (actual !== c.expectedHash && !(c.state === "prepared" && actual === nextHash)) {
      const observed = join(r.dir, "card-changes", c.id, `observed-${randomUUID()}.json`);
      writeFileSync(observed, readFileSync(r.file), { mode: 0o600 });
      c.state = "rejected"; c.reason = `开发卡直接修改，未覆盖；现场 ${observed}`; r.stopped = true; r.stopReason = c.reason; r.pendingCard = undefined; return false;
    }
    parseDevelopmentCard(c.content, r.file, r.repo);
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
    oldTicket = r.activity?.kind === "waiting" ? r.activity.ticket : undefined;
    if (r.activity?.kind === "waiting") r.activity = undefined;
    r.card = c.card; r.cardHash = nextHash; r.cardRevision = (r.cardRevision ?? 0) + 1; r.epoch = (r.epoch ?? 0) + 1;
    c.state = "applied"; c.appliedAt = now(); r.pendingCard = undefined; r.stopReason = undefined;
    return true;
  });
  if (oldTicket) {
    const ticket = readLocalQueue().items.find((t) => t.id === oldTicket && t.ledger === path);
    if (ticket) releaseLocalSlot(ticket.id, ticket.token, true);
  }
  return applied;
}
