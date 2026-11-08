/** 新卡宿主适配：只使用内核结果，Stop 的 block 继续原宿主会话。 */
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { queryKernel } from "../kernel.ts";
import { readTaskRun, updateTaskRun, type KernelRun } from "../node-ledger.ts";
import { attachSession, completeManagedDelivery, consumeManagedRepair, developerActive, deployManaged, managedLedger, managedMergeRequest, mergeManaged, pauseManaged, recordManagedUserInput, managedDeliveryIntent, MANAGED_CONVENTION } from "../kernel-session.ts";
import { createChildExec, expandFileRefsWithSources, lastAssistantMessage, sessionIdOf } from "./review-hook.ts";
import { detectHost, type HookEvent } from "./hook.ts";
import { experienceInjection } from "../experience.ts";
import { consumeRelay, paInfo, recordManagedRelay } from "../pa.ts";
import { hasRelayHeader } from "../pa-records.ts";

export async function handleKernelHook(event: HookEvent): Promise<string | undefined> {
  const task = process.env.AUTOREVIEW_KERNEL_TASK || undefined;
  const readRun = (path: string) => readTaskRun(path, task), updateRun = <T>(path: string, fn: (r: KernelRun) => T) => updateTaskRun(path, task, fn);
  const root = process.env.AUTOREVIEW_DEV_ROOT || event.cwd || process.cwd();
  const path = managedLedger(root);
  if (!path) throw new Error("新卡 Hook 缺少受管身份");
  const host = detectHost(event) === "codex" ? "codex" : "claude", id = sessionIdOf(event);
  const context = (text: string): string => JSON.stringify({ hookSpecificOutput: { hookEventName: event.hook_event_name, additionalContext: text } });
  try {
    if (event.hook_event_name === "SessionStart") {
      attachSession(path, host, id, event.transcript_path, task);
      const run = readRun(path), native = run.native;
      if (native && native.launch === run.session?.launchId && native.binding === process.env.AUTOREVIEW_KERNEL_NATIVE_BINDING) {
        const socket = process.env.CLAUDE_CODE_MESSAGING_SOCKET, token = process.env.CLAUDE_CODE_MESSAGING_TOKEN;
        writeFileSync(native.binding, JSON.stringify({ launch: native.launch, session: id, childPid: native.childPid, childStarted: native.childStarted,
          ...(host === "claude" && socket && token ? { channel: { socket, token } } : {}) }), { mode: 0o600 });
      }
      return context(`${MANAGED_CONVENTION}\n${experienceInjection(readRun(path).repo)}\n${queryKernel(path).lines.join("\n")}`);
    }
    if (event.hook_event_name === "UserPromptSubmit") {
      const incoming = event.prompt ?? "", run = readRun(path), info = paInfo(run.file), name = info.stages.find((s) => s.cwd === run.worktree)?.stage;
      const relay = name && hasRelayHeader(incoming) ? await consumeRelay({ message: incoming, info, stage: name, session: { host, id }, summary: join(run.dir, "summary.md") }) : undefined;
      if (hasRelayHeader(incoming) && !relay) return context("PA 用户原话核对失败，未采用输入或授权");
      const raw = relay ? relay.text : incoming;
      // 不根据引用前缀猜测启动消息；每条真实输入（包括再次引用原提示词）都登记完整材料。
      const materials = expandFileRefsWithSources(raw, event.cwd ?? root);
      if (consumeManagedRepair(path, raw, materials, task)) { developerActive(path, task); return context(`${MANAGED_CONVENTION}\n机器返修信封已核对；用户标准、授权与次数保持原值`); }
      if (readRun(path).publication && managedMergeRequest(readRun(path), raw)) { await mergeManaged(path); return JSON.stringify({ decision: "block", reason: queryKernel(path).lines.join("\n") }); }
      const decision = recordManagedUserInput(path, raw, `${host}:UserPromptSubmit`, materials, undefined, task);
      if (relay) recordManagedRelay(path, task, relay);
      if (decision) {
        await mergeManaged(path, { accept: true, decision });
        return JSON.stringify({ decision: "block", reason: queryKernel(path).lines.join("\n") });
      }
      const until = Date.now() + 5000;
      while (readRun(path).activity && ["waiting", "testing"].includes(readRun(path).activity!.kind) && Date.now() < until) await new Promise((ok) => setTimeout(ok, 50));
      developerActive(path, task);
      return context(`${MANAGED_CONVENTION}\n${experienceInjection(readRun(path).repo)}${relay ? `\n【PA 转达已核对】\n${raw}` : ""}`);
    }
    if (event.hook_event_name !== "Stop") return undefined;
    const run = readRun(path), text = lastAssistantMessage(event);
    if (run.stopped) return context(queryKernel(path).lines.join("\n"));
    const intent = managedDeliveryIntent(run, text);
    if (!intent.advance) { updateRun(path, (r) => { if (r.activity?.kind === "developing") r.activity = undefined; r.stopReason = intent.reason; }); return context(queryKernel(path).lines.join("\n")); }
    const controller = new AbortController();
    const stop = (): void => { controller.abort(); pauseManaged(path, "评审被宿主中断，成果和证据保留", task); };
    const signals = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
    for (const s of signals) process.on(s, stop);
    const version = run.userVersion;
    const watch = setInterval(() => { const current = readRun(path); if (current.stopped || current.userVersion !== version) controller.abort(); }, 250);
    try {
      const result = run.publication ? await deployManaged(path, controller.signal) : await completeManagedDelivery(path, text, { exec: createChildExec(join(run.dir, "review.procs.json")), signal: controller.signal, task });
      if (result.message) { consumeManagedRepair(path, result.message, undefined, task); developerActive(path, task); return JSON.stringify({ decision: "block", reason: result.message }); }
      return context(queryKernel(path).lines.join("\n"));
    } finally { clearInterval(watch); for (const s of signals) process.off(s, stop); }
  } catch (error) { pauseManaged(path, String(error), task); return context(queryKernel(path).lines.join("\n")); }
}
