/** Pi 新卡适配；业务结果来自同一内核，不读取旧 ReviewState 或旧 phase。 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { classifyMarker } from "./core.ts";
import { dirtyPaths } from "./kernel-workspace.ts";
import { queryKernel } from "./kernel.ts";
import { readRun, updateRun } from "./node-ledger.ts";
import { attachSession, completeManagedDelivery, consumeManagedRepair, developerActive, managedLedger, mergeManaged, pauseManaged, recordManagedUserInput, MANAGED_CONVENTION } from "./kernel-session.ts";
import { createChildExec, expandFileRefsWithSources } from "./hosts/review-hook.ts";
import type { Exec } from "./git.ts";
import { experienceInjection } from "./experience.ts";

function assistantText(ctx: ExtensionContext): string {
  for (const entry of [...ctx.sessionManager.getEntries()].reverse()) {
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    const content = entry.message.content;
    return typeof content === "string" ? content : content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
  }
  return "";
}
export default function kernelPi(pi: ExtensionAPI, execOverride?: Exec): void {
  let path: string | undefined, controller: AbortController | undefined, pending: Promise<unknown> | undefined, inbox: ReturnType<typeof setInterval> | undefined;
  const show = (ctx: ExtensionContext): void => { if (path) ctx.ui.notify(queryKernel(path).lines.join("\n"), "info"); };
  const merge = async (ctx: ExtensionContext, accept: boolean): Promise<void> => {
    if (!path) return;
    const decision = accept ? recordManagedUserInput(path, "合入本批", "pi:interactive") : undefined;
    await mergeManaged(path, { accept, decision }); show(ctx);
  };
  for (const name of ["review-status", "loop-status"]) pi.registerCommand(name, { description: "读取单任务内核统一状态", handler: async (_a, ctx) => show(ctx) });
  pi.registerCommand("loop-merge", { description: "统一合入；--接受未验证 须由用户明确执行", handler: async (args, ctx) => {
    if (args.trim() && args.trim() !== "--接受未验证") throw new Error("用法：/loop-merge [--接受未验证]");
    await merge(ctx, args.trim() === "--接受未验证");
  } });
  for (const name of ["review-off", "loop-stop"]) pi.registerCommand(name, { description: "停止本任务，保留成果", handler: async (_a, ctx) => {
    if (path) pauseManaged(path, "已停止：用户停止本任务"); controller?.abort(); ctx.abort(); show(ctx);
  } });
  pi.registerCommand("review-on", { description: "原会话继续开发评审，不清零次数", handler: async (_a, ctx) => {
    if (path) updateRun(path, (r) => { if (r.publication || r.abandoned) throw new Error("任务已发布或放弃"); r.stopped = false; r.stopReason = undefined; }); show(ctx);
  } });
  pi.on("session_start", async (_event, ctx) => {
    path = managedLedger(ctx.cwd);
    if (!path) throw new Error("缺少受管任务登记");
    const file = ctx.sessionManager.getSessionFile?.() ?? process.env.PI_SESSION_FILE;
    attachSession(path, "pi", ctx.sessionManager.getSessionId(), file);
    if (!pi.getCommands().some((c) => c.name === "ponytail")) ctx.ui.notify("未加载 Ponytail（开发角色要求加载）", "warning");
    show(ctx);
    if (inbox) clearInterval(inbox);
    inbox = setInterval(() => {
      if (!path || pending || !ctx.isIdle()) return;
      const run = readRun(path), repair = run.repair;
      if (!repair || !["pending", "sent"].includes(repair.state) || run.stopped || run.activity || !pi.sendMessage) return;
      try {
        if (consumeManagedRepair(path, repair.message)) pi.sendMessage({ customType: "loop-repair", content: repair.message, display: true }, { triggerTurn: true });
      } catch (error) { ctx.ui.notify(String(error), "warning"); }
    }, 250);
  });
  pi.on("input", async (event, ctx) => {
    if (!path || !["interactive", "rpc"].includes(event.source)) return { action: "continue" };
    const materials = expandFileRefsWithSources(event.text, ctx.cwd);
    if (consumeManagedRepair(path, event.text, materials)) return { action: "continue" };
    const decision = recordManagedUserInput(path, event.text, `pi:${event.source}`, materials);
    if (decision) { await mergeManaged(path, { accept: true, decision }); show(ctx); return { action: "handled" }; }
    controller?.abort(); await pending;
    const until = Date.now() + 5000;
    while (readRun(path).activity && ["waiting", "testing"].includes(readRun(path).activity!.kind) && Date.now() < until) await new Promise((ok) => setTimeout(ok, 50));
    return { action: "continue" };
  });
  pi.on("before_agent_start", async (event, ctx) => {
    if (!path) return;
    try {
      developerActive(path);
      const existing = event.systemPromptOptions.appendSystemPrompt ?? "";
      event.systemPromptOptions.appendSystemPrompt = `${existing}\n\n${MANAGED_CONVENTION}\n${experienceInjection(readRun(path).repo)}`;
    } catch (error) { ctx.ui.notify(String(error), "warning"); ctx.abort(); }
  });
  // actionable 边界回送原会话；不用 notification-only 的 agent_settled 请求续跑。
  pi.on("agent_before_settle", async (event, ctx) => {
    if (!path || pending) return;
    if (event.outcome !== "completed") { pauseManaged(path, "开发回合中断，等待用户决定"); return; }
    const run = readRun(path), text = assistantText(ctx);
    if (run.stopped || run.publication) return;
    if (classifyMarker(text) === "none" && !dirtyPaths(run).length) { updateRun(path, (r) => { r.activity = undefined; }); return; }
    controller = new AbortController();
    const watch = setInterval(() => { if (path && readRun(path).stopped) controller?.abort(); }, 250);
    const work = completeManagedDelivery(path, text, { exec: execOverride ?? createChildExec(join(run.dir, "review.procs.json")), signal: controller.signal });
    pending = work;
    try {
      const result = await work; show(ctx);
      if (result.message) {
        consumeManagedRepair(path, result.message);
        developerActive(path);
        return { entries: [{ type: "custom_message" as const, customType: "loop-repair", content: result.message, display: true }], continue: true };
      }
    } finally { clearInterval(watch); pending = undefined; controller = undefined; }
  });
  pi.on("agent_settled", async (event) => {
    if (path && !pending && readRun(path).activity?.kind === "developing") {
      if (event.aborted) pauseManaged(path, "开发回合已中断");
      else updateRun(path, (r) => { r.activity = undefined; });
    }
  });
  pi.on("session_shutdown", async () => {
    if (inbox) clearInterval(inbox); inbox = undefined;
    controller?.abort(); await pending;
    if (path && readRun(path).activity) pauseManaged(path, "会话已关闭；候选和证据保留");
  });
}
