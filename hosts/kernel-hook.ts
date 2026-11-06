/** 新卡宿主适配：只使用内核结果，Stop 的 block 继续原宿主会话。 */
import { join } from "node:path";
import { classifyMarker } from "../core.ts";
import { queryKernel } from "../kernel.ts";
import { dirtyPaths } from "../kernel-workspace.ts";
import { readRun, updateRun } from "../node-ledger.ts";
import { attachSession, completeManagedDelivery, developerActive, managedLedger, mergeManaged, pauseManaged, recordManagedUserInput, MANAGED_CONVENTION } from "../kernel-session.ts";
import { createChildExec, expandFileRefsWithSources, lastAssistantMessage, sessionIdOf } from "./review-hook.ts";
import { detectHost, type HookEvent } from "./hook.ts";
import { experienceInjection } from "../experience.ts";

export async function handleKernelHook(event: HookEvent): Promise<string | undefined> {
  const root = process.env.AUTOREVIEW_DEV_ROOT || event.cwd || process.cwd();
  const path = managedLedger(root);
  if (!path) throw new Error("新卡 Hook 缺少受管身份");
  const host = detectHost(event) === "codex" ? "codex" : "claude", id = sessionIdOf(event);
  const context = (text: string): string => JSON.stringify({ hookSpecificOutput: { hookEventName: event.hook_event_name, additionalContext: text } });
  try {
    if (event.hook_event_name === "SessionStart") {
      attachSession(path, host, id, event.transcript_path);
      return context(`${MANAGED_CONVENTION}\n${experienceInjection(readRun(path).repo)}\n${queryKernel(path).lines.join("\n")}`);
    }
    if (event.hook_event_name === "UserPromptSubmit") {
      const raw = event.prompt ?? "";
      // 不根据引用前缀猜测启动消息；每条真实输入（包括再次引用原提示词）都登记完整材料。
      const decision = recordManagedUserInput(path, raw, `${host}:UserPromptSubmit`, expandFileRefsWithSources(raw, event.cwd ?? root));
      if (decision) {
        await mergeManaged(path, { accept: true, decision });
        return JSON.stringify({ decision: "block", reason: queryKernel(path).lines.join("\n") });
      }
      developerActive(path);
      return context(`${MANAGED_CONVENTION}\n${experienceInjection(readRun(path).repo)}`);
    }
    if (event.hook_event_name !== "Stop") return undefined;
    const run = readRun(path), text = lastAssistantMessage(event);
    if (run.stopped || run.publication) return context(queryKernel(path).lines.join("\n"));
    if (classifyMarker(text) === "none" && !dirtyPaths(run).length) { updateRun(path, (r) => { r.activity = undefined; }); return undefined; }
    const controller = new AbortController();
    const stop = (): void => { controller.abort(); pauseManaged(path, "评审被宿主中断，成果和证据保留"); };
    const signals = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
    for (const s of signals) process.on(s, stop);
    const version = run.userVersion;
    const watch = setInterval(() => { const current = readRun(path); if (current.stopped || current.userVersion !== version) controller.abort(); }, 250);
    try {
      const result = await completeManagedDelivery(path, text, { exec: createChildExec(join(run.dir, "review.procs.json")), signal: controller.signal });
      if (result.message) { developerActive(path); return JSON.stringify({ decision: "block", reason: result.message }); }
      return context(queryKernel(path).lines.join("\n"));
    } finally { clearInterval(watch); for (const s of signals) process.off(s, stop); }
  } catch (error) { pauseManaged(path, String(error)); return context(queryKernel(path).lines.join("\n")); }
}
