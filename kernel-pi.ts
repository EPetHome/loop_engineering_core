/** Pi 新卡适配；业务结果来自同一内核，不读取旧 ReviewState 或旧 phase。 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { queryKernel } from "./kernel.ts";
import { readTaskRun, updateTaskRun, type KernelRun } from "./node-ledger.ts";
import { attachSession, completeManagedDelivery, consumeManagedRepair, developerActive, deployManaged, managedLedger, managedReleaseProblem, managedMergeRequest, mergeManaged, pauseManaged, recordManagedUserInput, managedDeliveryIntent, MANAGED_CONVENTION } from "./kernel-session.ts";
import { createChildExec, expandFileRefsWithSources } from "./hosts/review-hook.ts";
import type { Exec } from "./git.ts";
import { experienceInjection } from "./experience.ts";
import { ACCEPT_COMMAND_MIGRATION } from "./config.ts";
import { consumeRelay, paInfo, recordManagedRelay } from "./pa.ts";
import { hasRelayHeader, relayMessage, wordRecords } from "./pa-records.ts";

function assistantText(ctx: ExtensionContext): string {
  for (const entry of [...ctx.sessionManager.getEntries()].reverse()) {
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    const content = entry.message.content;
    return typeof content === "string" ? content : content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
  }
  return "";
}
export default function kernelPi(pi: ExtensionAPI, execOverride?: Exec): void {
  const task = process.env.AUTOREVIEW_KERNEL_TASK || undefined;
  const readRun = (path: string) => readTaskRun(path, task), updateRun = <T>(path: string, fn: (r: KernelRun) => T) => updateTaskRun(path, task, fn);
  let path: string | undefined, controller: AbortController | undefined, pending: Promise<unknown> | undefined, inbox: ReturnType<typeof setInterval> | undefined;
  let uiContext: ExtensionContext | undefined, lastLedger = "", lastStatus = "", lastNotice = "";
  const paDispatched = new Set<string>();
  const refresh = (ctx: ExtensionContext, force = false): void => {
    if (!path) return;
    try {
      const bytes = readFileSync(path, "utf8");
      if (!force && bytes === lastLedger) return;
      lastLedger = bytes;
      const q = queryKernel(path), own = q.tasks.find((t: any) => t.id === task || !task), run = readRun(path);
      const result = run.publication ? q.status : run.release.status === "未确认" ? "资源释放未确认" : !q.missing.length ? "流程已完成" : own?.status ?? q.status;
      const phase = own?.activity?.kind === "developing" ? "开发" : own?.activity?.kind === "waiting" ? "排队" : own?.repairReceipt && own.repairReceipt.state !== "read" && !run.stopped ? "等待原会话返修" : own?.integrated && q.missing.length && !run.stopped ? "已汇入，等待批次" : result;
      const rounds = q.attempts.filter((a: any) => a.node === "开发评审" && a.task === (run.taskId ?? own?.name)).length;
      const status = `${own?.name ?? q.task} / ${own?.node ?? q.node} / ${phase}；评审第 ${rounds} 轮（返修 ${run.repairs}）；测试返修 ${run.counters?.测试?.repairs ?? 0}；验收轮次 ${run.acceptanceState?.round ?? 0}`;
      const reason = !own?.activity && !q.missing.length && !run.stopped ? q.reason : own?.activity ? own.reason : own?.reason !== "无节点执行" ? own?.reason : q.reason;
      const lines = [status, `本任务：${reason ?? "无节点执行"}`, ...(run.taskRecords ? [`整批：${q.status} / ${q.node}；${q.reason}`] : []),
        ...(!own?.activity ? q.lines.filter((l: string) => l.includes("补救：") || l.startsWith("cd ")).slice(0, 2) : [])];
      const signature = JSON.stringify(lines);
      if (signature !== lastStatus) { ctx.ui.setStatus("loop-kernel", status); ctx.ui.setWidget?.("loop-kernel", lines); lastStatus = signature; }
      const notice = !own?.activity ? lines.join("\n") : "";
      if (notice && notice !== lastNotice) { ctx.ui.notify(notice, run.stopped ? "warning" : "info"); lastNotice = notice; }
    } catch (error) {
      const message = `Loop 状态读取失败：${String(error)}；请用 /loop-status 核对`;
      if (lastNotice !== message) { ctx.ui.setStatus("loop-kernel", message); ctx.ui.notify(message, "warning"); lastNotice = message; }
    }
  };
  const show = (ctx: ExtensionContext): void => { refresh(ctx, true); if (path) ctx.ui.notify(queryKernel(path).lines.join("\n"), "info"); };
  const merge = async (ctx: ExtensionContext, accept: boolean): Promise<void> => {
    if (!path) return;
    const decision = accept && !readRun(path).publication ? recordManagedUserInput(path, "合入本批", "pi:interactive") : undefined;
    await mergeManaged(path, { accept, decision }); show(ctx);
  };
  for (const name of ["review-status", "loop-status"]) pi.registerCommand(name, { description: "读取本任务及批次的统一内核状态", handler: async (_a, ctx) => show(ctx) });
  pi.registerCommand("loop-merge", { description: "统一合入；--接受未验证 须由用户明确执行", handler: async (args, ctx) => {
    if (args.trim() && args.trim() !== "--接受未验证") throw new Error("用法：/loop-merge [--接受未验证]");
    await merge(ctx, args.trim() === "--接受未验证");
  } });
  for (const name of ["review-off", "loop-stop"]) pi.registerCommand(name, { description: "停止本任务，保留成果", handler: async (_a, ctx) => {
    if (path) pauseManaged(path, "已停止：用户停止本任务", task); controller?.abort(); ctx.abort(); show(ctx);
  } });
  pi.registerCommand("review-on", { description: "原会话继续开发评审，不清零次数", handler: async (_a, ctx) => {
    if (path) updateRun(path, (r) => { if (r.publication || r.abandoned) throw new Error("任务已发布或放弃"); const releaseProblem = managedReleaseProblem(path!, r); if (releaseProblem) throw new Error(releaseProblem); r.stopped = false; r.stopReason = undefined; }); show(ctx);
  } });
  pi.on("session_start", async (_event, ctx) => {
    if (typeof pi.getFlag === "function" && ["autoreview-accept-cmd", "autoreview-accept-mode", "autoreview-accept-timeout-min"].some((name) => pi.getFlag(name))) ctx.ui.notify(ACCEPT_COMMAND_MIGRATION, "warning");
    path = managedLedger(ctx.cwd);
    if (!path) throw new Error("缺少受管任务登记");
    const file = ctx.sessionManager.getSessionFile?.() ?? process.env.PI_SESSION_FILE;
    const session = ctx.sessionManager.getSessionId(), current = readRun(path);
    // 重载已停止的原会话仍可只读显示停点；不能借重载认领新会话或自动解停。
    if (!(current.stopped && current.session?.id === session)) attachSession(path, "pi", session, file, task);
    if (!pi.getCommands().some((c) => c.name === "ponytail")) ctx.ui.notify("未加载 Ponytail（开发角色要求加载）", "warning");
    uiContext = ctx; lastLedger = ""; lastStatus = ""; lastNotice = ""; refresh(ctx);
    if (inbox) clearInterval(inbox);
    inbox = setInterval(() => {
      refresh(ctx);
      if (!path || pending || !ctx.isIdle()) return;
      const run = readRun(path), repair = run.repair;
      if (!run.activity) {
        const info = paInfo(run.file), name = info.stages.find((s) => s.cwd === run.worktree)?.stage;
        const word = name && wordRecords(info.dir, run.taskId ?? name).find((w) => w.state === "delivered" && w.session?.host === "pi" && w.session.id === ctx.sessionManager.getSessionId() && !paDispatched.has(w.id));
        if (word) { paDispatched.add(word.id); pi.sendUserMessage(relayMessage(word.id, word.text)); return; }
      }
      if (!repair || !["pending", "sent"].includes(repair.state) || run.stopped || run.activity || !pi.sendMessage) return;
      try {
        if (consumeManagedRepair(path, repair.message, undefined, task)) pi.sendMessage({ customType: "loop-repair", content: repair.message, display: true }, { triggerTurn: true });
      } catch (error) { ctx.ui.notify(String(error), "warning"); }
    }, 250); inbox.unref?.();
  });
  pi.on("input", async (event, ctx) => {
    if (!path) return { action: "continue" };
    const run = readRun(path), info = paInfo(run.file), name = info.stages.find((s) => s.cwd === run.worktree)?.stage;
    const relay = name && hasRelayHeader(event.text) ? await consumeRelay({ message: event.text, info, stage: name, session: { host: "pi", id: ctx.sessionManager.getSessionId() }, summary: join(run.dir, "summary.md") }) : undefined;
    if (hasRelayHeader(event.text) && !relay) return { action: "handled" };
    if (!relay && !["interactive", "rpc"].includes(event.source)) return { action: "continue" };
    const raw = relay ? relay.text : event.text, materials = expandFileRefsWithSources(raw, ctx.cwd);
    if (consumeManagedRepair(path, raw, materials, task)) return { action: "continue" };
    if (run.publication && managedMergeRequest(run, raw)) { await mergeManaged(path); show(ctx); return { action: "handled" }; }
    const decision = recordManagedUserInput(path, raw, relay ? "pi:interactive" : `pi:${event.source}`, materials, undefined, task);
    if (relay) recordManagedRelay(path, task, relay);
    if (decision) { await mergeManaged(path, { accept: true, decision }); show(ctx); return { action: "handled" }; }
    controller?.abort(); await pending;
    const until = Date.now() + 5000;
    while (readRun(path).activity && ["waiting", "testing"].includes(readRun(path).activity!.kind) && Date.now() < until) await new Promise((ok) => setTimeout(ok, 50));
    return relay ? { action: "transform", text: raw } : { action: "continue" };
  });
  pi.on("before_agent_start", async (event, ctx) => {
    if (!path) return;
    try {
      developerActive(path, task); refresh(ctx);
      const existing = event.systemPromptOptions.appendSystemPrompt ?? "";
      event.systemPromptOptions.appendSystemPrompt = `${existing}\n\n${MANAGED_CONVENTION}\n${experienceInjection(readRun(path).repo)}`;
    } catch (error) { ctx.ui.notify(String(error), "warning"); ctx.abort(); }
  });
  // actionable 边界回送原会话；不用 notification-only 的 agent_settled 请求续跑。
  pi.on("agent_before_settle", async (event, ctx) => {
    if (!path || pending) return;
    if (event.outcome !== "completed") { pauseManaged(path, "开发回合中断，等待用户决定", task); return; }
    const run = readRun(path), text = assistantText(ctx);
    if (run.stopped) return;
    const intent = managedDeliveryIntent(run, text);
    if (!intent.advance) { updateRun(path, (r) => { if (r.activity?.kind === "developing") r.activity = undefined; r.stopReason = intent.reason; }); refresh(ctx); return; }
    controller = new AbortController();
    const watch = setInterval(() => { if (path && readRun(path).stopped) controller?.abort(); }, 250);
    const work = run.publication ? deployManaged(path, controller.signal) : completeManagedDelivery(path, text, { exec: execOverride ?? createChildExec(join(run.dir, "review.procs.json")), signal: controller.signal, task });
    pending = work;
    try {
      refresh(ctx); const result = await work; refresh(ctx, true);
      if (result.message) {
        consumeManagedRepair(path, result.message, undefined, task);
        developerActive(path, task);
        return { entries: [{ type: "custom_message" as const, customType: "loop-repair", content: result.message, display: true }], continue: true };
      }
    } catch (error) {
      if (!readRun(path).stopped) pauseManaged(path, `本任务接续中断：${String(error)}；请核对 /loop-status 后显式续跑原任务`, task);
      refresh(ctx, true);
    } finally { clearInterval(watch); pending = undefined; controller = undefined; }
  });
  pi.on("agent_settled", async (event) => {
    if (path && !pending && readRun(path).activity?.kind === "developing") {
      if (event.aborted) pauseManaged(path, "开发回合已中断", task);
      else updateRun(path, (r) => { r.activity = undefined; });
    }
  });
  pi.on("session_shutdown", async () => {
    if (inbox) clearInterval(inbox); inbox = undefined;
    controller?.abort(); await pending;
    if (path && readRun(path).activity) pauseManaged(path, "会话已关闭；候选和证据保留", task);
    uiContext?.ui.setStatus("loop-kernel", undefined); uiContext?.ui.setWidget?.("loop-kernel", undefined); uiContext = undefined;
  });
}
