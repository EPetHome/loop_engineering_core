/**
 * pi 自动评审扩展：交付标记触发评审，必修回送原开发会话。
 * 失败调用不推进成功检查点；git 取证失败或指纹变化只暂停；暂停后你再让开发方干活即恢复自动评审。
 * 加载：pi -e /Users/Admin/Desktop/loop/autoreview.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { ACCEPTANCE_CONVENTION, criteriaFromUser } from "./acceptance-core.ts";
import { checkAcceptanceBudget, loadAcceptanceConfig, type AcceptanceConfig } from "./config.ts";
import { classifyMarker, CONVENTION, deriveReviewerSessionId, renderSummary } from "./core.ts";
import { createGitEvidence, GitReadError, type Exec } from "./git.ts";
import { reapProcs } from "./procs.ts";
import {
  DEFAULT_MAX_REPAIRS, DEFAULT_MODEL, DEFAULT_THINKING, DEFAULT_TIMEOUT_MIN, INTERRUPTED,
  checkedFingerprint, errorText, newReviewState, runReviewRound, tail,
  type ReviewConfig, type ReviewState,
} from "./review.ts";

interface Lifecycle { active: boolean }
interface ReviewTask { lifecycle: Lifecycle; controller: AbortController }

function flagString(pi: ExtensionAPI, name: string, fallback: string): string {
  const value = pi.getFlag(name);
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}
function positiveInt(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
function lastAssistantText(entries: SessionEntry[]): string {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry.type !== "message") continue;
    const message = entry.message as { role?: string; content?: unknown };
    if (message.role !== "assistant") continue;
    if (typeof message.content === "string") return message.content;
    if (Array.isArray(message.content)) {
      return message.content
        .filter((block): block is { type: "text"; text: string } =>
          Boolean(block) && typeof block === "object" && (block as { type?: string }).type === "text",
        )
        .map((block) => block.text).join("\n");
    }
    return "";
  }
  return "";
}

export default function autoreviewExtension(pi: ExtensionAPI): void {
  let state = newReviewState();
  let gitAvailability: "unknown" | "available" | "unsupported" = "unknown";
  let unavailableReason = "不是 git 仓库，自动评审已关闭";
  let reviewRunning = false;
  let lifecycle: Lifecycle = { active: true };
  let activeTask: ReviewTask | undefined;

  const live = (life: Lifecycle, signal?: AbortSignal): boolean => life.active && !signal?.aborted;
  const checkLive = (life: Lifecycle, signal?: AbortSignal): void => {
    if (!live(life, signal)) throw new Error(INTERRUPTED);
  };
  // role 只给宿主 Hook 的进程登记用；pi 的子进程由 pi.exec 和会话关闭时的 abort 管。
  const wrappedExec = (life: Lifecycle, signal?: AbortSignal): Exec => async (cmd, args, { role: _role, ...options }) => {
    checkLive(life, signal);
    const res = await pi.exec(cmd, args, options);
    checkLive(life, signal);
    return res;
  };
  const evidence = (ctx: ExtensionContext, life: Lifecycle, signal?: AbortSignal) =>
    createGitEvidence(wrappedExec(life, signal), ctx.cwd, signal);
  const dataDir = (ctx: ExtensionContext): string => join(homedir(), ".pi-autoreview", basename(ctx.cwd));
  const summaryPath = (ctx: ExtensionContext): string => join(dataDir(ctx), `${ctx.sessionManager.getSessionId()}.md`);
  const procsPath = (ctx: ExtensionContext): string => join(dataDir(ctx), `${ctx.sessionManager.getSessionId()}.procs.json`);
  /** .autoreview.json 的 acceptance 一节；配置非法时抛错（评审路径里会变成暂停）。 */
  const acceptanceConfig = (ctx: ExtensionContext): AcceptanceConfig | undefined => loadAcceptanceConfig(ctx.cwd);
  /** 只用于注入约定和取标准：配置非法时当作没配，错误留给评审路径报。 */
  const acceptanceEnabled = (ctx: ExtensionContext): boolean => {
    try { return acceptanceConfig(ctx) !== undefined; } catch { return false; }
  };
  const saveState = (life: Lifecycle): void => {
    checkLive(life);
    pi.appendEntry("autoreview-state", state);
  };
  const updateStatus = (ctx: ExtensionContext, life: Lifecycle): void => {
    checkLive(life);
    let text: string | undefined;
    if (state.phase === "reviewing") text = `自动评审中（第 ${state.rounds.length + 1} 轮）`;
    else if (state.phase === "paused") text = "自动评审：暂停";
    else if (gitAvailability === "available" && state.phase === "done") text = "自动评审：完成";
    else if (gitAvailability === "available" && !state.enabled) text = "自动评审：已关闭";
    ctx.ui.setStatus("autoreview", text);
  };
  const notifyUser = async (
    ctx: ExtensionContext, body: string, type: "info" | "warning", life: Lifecycle, signal?: AbortSignal,
  ): Promise<void> => {
    if (!live(life, signal)) return;
    try { ctx.ui.notify(body, type); } catch { /* 无 UI 时仍尝试系统通知 */ }
    if (!live(life, signal)) return;
    try {
      const escaped = body.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      await pi.exec("osascript", ["-e", `display notification "${escaped}" with title "自动评审"`], { timeout: 15_000, signal });
    } catch { /* 通知失败不影响成果 */ }
  };
  const writeSummary = async (
    ctx: ExtensionContext, status: "进行中" | "完成" | "暂停", life: Lifecycle,
    pauseReason?: string, unresolvedMustFix?: string, changedFiles?: string[], notes?: string, signal?: AbortSignal,
  ): Promise<void> => {
    checkLive(life, signal);
    let gitStatusShort: string;
    try {
      gitStatusShort = await evidence(ctx, life, signal).statusShort();
    } catch (error) {
      checkLive(life, signal);
      if (status !== "暂停") throw error;
      gitStatusShort = `（${errorText(error)}；无法确认是否干净）`;
    }
    checkLive(life, signal);
    const devSessionId = ctx.sessionManager.getSessionId();
    const text = renderSummary({
      cwd: ctx.cwd, devSessionId,
      reviewerSessionId: state.reviewerSessionId ?? deriveReviewerSessionId(devSessionId),
      status, pauseReason, rounds: state.rounds, repairs: state.repairs,
      unresolvedMustFix, changedFiles, gitStatusShort, notes,
      criteria: state.criteria, unresolvedAcceptance: state.unresolvedAcceptance,
    });
    const file = summaryPath(ctx);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  };

  /** 错误处理的副作用逐个隔离；任何一步失败都不能挡住后面的通知。 */
  const pause = async (
    ctx: ExtensionContext, reason: string, life: Lifecycle,
    unresolvedMustFix = state.unresolvedMustFix, changedFiles?: string[], notes?: string, signal?: AbortSignal,
  ): Promise<void> => {
    if (!live(life, signal)) return;
    state.phase = "paused";
    state.pauseReason = reason;
    state.unresolvedMustFix = unresolvedMustFix;
    state.awaitingRepair = false;
    const errors: string[] = [];
    try { saveState(life); } catch (error) { errors.push(`状态保存失败：${errorText(error)}`); }
    try { updateStatus(ctx, life); } catch (error) { errors.push(`状态栏更新失败：${errorText(error)}`); }
    try {
      await writeSummary(ctx, "暂停", life, reason, unresolvedMustFix, changedFiles, notes, signal);
    } catch (error) { errors.push(`总结写入失败：${errorText(error)}`); }
    if (!live(life, signal)) return;
    await notifyUser(ctx, `${basename(ctx.cwd)}：暂停（${reason}）${errors.length ? `；${errors.join("；")}` : ""}`, "warning", life, signal);
  };
  const pauseForError = async (ctx: ExtensionContext, error: unknown, life: Lifecycle, signal?: AbortSignal): Promise<void> => {
    if (!live(life, signal)) return;
    const reason = error instanceof GitReadError ? error.message : "评审失败";
    await pause(ctx, reason, life, state.unresolvedMustFix, undefined, `扩展内部错误：${errorText(error)}`, signal);
  };

  /** 取证异常保持 unknown；只有明确非 git/无提交才关闭，手动评审可重探 unknown。 */
  const probeRepository = async (ctx: ExtensionContext, life: Lifecycle, signal?: AbortSignal): Promise<boolean> => {
    gitAvailability = "unknown";
    const git = evidence(ctx, life, signal);
    const repository = await git.isRepository();
    checkLive(life, signal);
    const head = repository ? await git.initialHead() : undefined;
    checkLive(life, signal);
    if (repository && head) {
      gitAvailability = "available";
      return true;
    }
    gitAvailability = "unsupported";
    unavailableReason = repository ? "仓库还没有提交，自动评审已关闭" : "不是 git 仓库，自动评审已关闭";
    state.enabled = false;
    if (state.phase === "reviewing") state.phase = "idle";
    saveState(life);
    updateStatus(ctx, life);
    ctx.ui.notify(unavailableReason, "warning");
    return false;
  };

  const currentConfig = (ctx: ExtensionContext): ReviewConfig => {
    const config: ReviewConfig = {
      maxRepairs: positiveInt(flagString(pi, "autoreview-max-repairs", String(DEFAULT_MAX_REPAIRS)), DEFAULT_MAX_REPAIRS),
      reviewerModel: flagString(pi, "autoreview-reviewer-model", DEFAULT_MODEL),
      reviewerThinking: flagString(pi, "autoreview-reviewer-thinking", DEFAULT_THINKING),
      reviewTimeoutMin: positiveInt(flagString(pi, "autoreview-review-timeout-min", String(DEFAULT_TIMEOUT_MIN)), DEFAULT_TIMEOUT_MIN),
      reviewerCmd: flagString(pi, "autoreview-reviewer-cmd", ""),
    };
    const acceptance = acceptanceConfig(ctx);
    if (!acceptance) return config;
    checkAcceptanceBudget(config.reviewTimeoutMin, acceptance);
    return { ...config, acceptance };
  };

  const runReview = async (ctx: ExtensionContext, round: number, task: ReviewTask): Promise<void> => {
    const { lifecycle: life, controller } = task;
    const signal = controller.signal;
    const cwd = ctx.cwd;
    const outcome = await runReviewRound({
      cwd, devSessionId: ctx.sessionManager.getSessionId(), round,
      deliveryNote: lastAssistantText(ctx.sessionManager.getEntries()),
      state, config: currentConfig(ctx),
      exec: wrappedExec(life, signal),
      checkLive: () => checkLive(life, signal),
      onProgress: (text) => { if (live(life, signal)) ctx.ui.setStatus("autoreview", text); },
      writeInput: (name, text) => {
        const dir = join(homedir(), ".pi-autoreview", basename(cwd));
        mkdirSync(dir, { recursive: true });
        const path = join(dir, name);
        writeFileSync(path, text);
        return path;
      },
      writeSummary: (status) => writeSummary(ctx, status, life, undefined, undefined, undefined, undefined, signal),
      saveState: () => saveState(life),
      signal,
      acceptanceDir: join(dataDir(ctx), "acceptance", ctx.sessionManager.getSessionId()),
      procsFile: procsPath(ctx),
    });
    checkLive(life, signal);
    if (outcome.kind === "done") {
      state.phase = "done";
      state.awaitingRepair = false;
      saveState(life);
      updateStatus(ctx, life);
      await notifyUser(ctx, `${basename(cwd)}：完成（评审 ${state.rounds.length} 次，返修 ${state.repairs} 次）`, "info", life, signal);
      return;
    }
    if (outcome.kind === "paused") {
      await pause(ctx, outcome.reason!, life, state.unresolvedMustFix, outcome.changedFiles, outcome.notes, signal);
      return;
    }
    // 后面的保存与消息交接是同步的，异步准备完成前不能提前解锁 phase。
    state.phase = "idle";
    saveState(life);
    updateStatus(ctx, life);
    const message = outcome.message!;
    if (ctx.isIdle()) pi.sendUserMessage(message);
    else pi.sendUserMessage(message, { deliverAs: "followUp" });
  };

  /** 整个后台入口都在 try 内；收尾没有能再次拒绝的副作用。 */
  const startReview = async (ctx: ExtensionContext, trigger: "auto" | "command"): Promise<void> => {
    const life = lifecycle;
    let task: ReviewTask | undefined;
    try {
      if (!life.active || (trigger === "auto" && (!state.enabled || gitAvailability !== "available"))) return;
      if (gitAvailability === "unsupported") { ctx.ui.notify(unavailableReason, "warning"); return; }
      if (reviewRunning || state.phase === "reviewing") {
        ctx.ui.notify("自动评审：已有评审在进行", "warning");
        return;
      }
      task = { lifecycle: life, controller: new AbortController() };
      activeTask = task;
      reviewRunning = true;
      if (trigger === "command" || state.phase === "done") state.repairs = 0;
      state.phase = "reviewing";
      state.pauseReason = undefined;
      state.awaitingRepair = false;
      const round = state.rounds.length + 1;
      saveState(life);
      updateStatus(ctx, life);
      if (gitAvailability === "unknown" && !await probeRepository(ctx, life, task.controller.signal)) return;
      await runReview(ctx, round, task);
    } catch (error) {
      await pauseForError(ctx, error, life, task?.controller.signal);
    } finally {
      if (task && activeTask === task) {
        reviewRunning = false;
        activeTask = undefined;
      }
    }
  };

  pi.registerFlag("autoreview-max-repairs", { type: "string", default: String(DEFAULT_MAX_REPAIRS), description: "自动评审返修上限" });
  pi.registerFlag("autoreview-reviewer-model", { type: "string", default: DEFAULT_MODEL, description: "评审模型" });
  pi.registerFlag("autoreview-reviewer-thinking", { type: "string", default: DEFAULT_THINKING, description: "评审思考档位" });
  pi.registerFlag("autoreview-review-timeout-min", { type: "string", default: String(DEFAULT_TIMEOUT_MIN), description: "单次评审保护时长（分钟）" });
  pi.registerFlag("autoreview-reviewer-cmd", { type: "string", default: "", description: "仅测试：外部评审命令" });

  pi.registerCommand("review", {
    description: "立即评审当前改动（返修计数重新算）",
    handler: async (_args, ctx) => {
      if (!lifecycle.active) return;
      if (gitAvailability === "unsupported") { ctx.ui.notify(unavailableReason, "warning"); return; }
      if (reviewRunning || state.phase === "reviewing") { ctx.ui.notify("自动评审：已有评审在进行", "warning"); return; }
      if (!ctx.isIdle()) { ctx.ui.notify("自动评审：开发方正在运行，等停下来再评审", "warning"); return; }
      void startReview(ctx, "command");
    },
  });
  pi.registerCommand("review-off", {
    description: "关闭自动评审",
    handler: async (_args, ctx) => {
      const life = lifecycle;
      if (!life.active) return;
      try {
        state.enabled = false; saveState(life); updateStatus(ctx, life);
        ctx.ui.notify("自动评审已关闭", "info");
      } catch (error) { await pauseForError(ctx, error, life); }
    },
  });
  pi.registerCommand("review-on", {
    description: "打开自动评审",
    handler: async (_args, ctx) => {
      const life = lifecycle;
      if (!life.active) return;
      if (gitAvailability === "unsupported") { ctx.ui.notify(unavailableReason, "warning"); return; }
      try {
        state.enabled = true; saveState(life); updateStatus(ctx, life);
        ctx.ui.notify("自动评审已打开", "info");
      } catch (error) { await pauseForError(ctx, error, life); }
    },
  });
  pi.registerCommand("review-status", {
    description: "显示自动评审状态",
    handler: async (_args, ctx) => {
      if (!lifecycle.active) return;
      if (gitAvailability === "unsupported") { ctx.ui.notify(unavailableReason, "warning"); return; }
      const devSessionId = ctx.sessionManager.getSessionId();
      const phase = state.phase === "reviewing" ? `评审中（第 ${state.rounds.length + 1} 轮）`
        : state.phase === "paused" ? `暂停（${state.pauseReason ?? "未知原因"}）`
        : state.phase === "done" ? "完成" : "空闲";
      ctx.ui.notify([
        `自动评审：${state.enabled ? "开启" : "关闭"}`, `状态：${phase}`,
        `评审 ${state.rounds.length} 次，返修 ${state.repairs} 次`,
        `评审会话：${state.reviewerSessionId ?? deriveReviewerSessionId(devSessionId)}`, `总结：${summaryPath(ctx)}`,
        `自动验收：${!acceptanceEnabled(ctx) ? "未配置" : state.criteria
          ? `标准第 ${state.criteria.version} 版（${state.criteria.items.length} 条，${state.criteria.source === "用户" ? "你写的" : "自动起草"}）`
          : "还没有标准（需求里没有「## 验收标准」时，第一次验收前自动起草）"}`,
      ].join("\n"), "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const life: Lifecycle = { active: true };
    lifecycle = life;
    state = newReviewState();
    gitAvailability = "unknown";
    reviewRunning = false;
    activeTask = undefined;
    try {
      // 上次 pi 进程异常退出时留下的被测系统（登记者已死）先清掉。
      reapProcs(procsPath(ctx));
      const entries = ctx.sessionManager.getEntries();
      for (let i = entries.length - 1; i >= 0; i -= 1) {
        const entry = entries[i];
        if (entry.type === "custom" && entry.customType === "autoreview-state" && entry.data) {
          state = { ...newReviewState(), ...(entry.data as ReviewState) };
          break;
        }
      }
      if (!await probeRepository(ctx, life)) return;
      if (state.phase === "reviewing") await pause(ctx, INTERRUPTED, life);
      else updateStatus(ctx, life);
      checkLive(life);
      if (state.phase === "paused") {
        ctx.ui.notify(`自动评审：上次暂停（${state.pauseReason ?? "未知原因"}），给开发方发消息继续干活即恢复自动评审，或输入 /review 立即评审`, "info");
      }
    } catch (error) { await pauseForError(ctx, error, life); }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (!lifecycle.active) return;
    const interrupted = state.phase === "reviewing";
    lifecycle.active = false;
    activeTask?.controller.abort();
    activeTask = undefined;
    reviewRunning = false;
    // abort 后的异步关停未必来得及跑完：同步杀掉本进程登记的被测系统。
    try { reapProcs(procsPath(ctx), { ownerPid: process.pid }); } catch { /* 尽力 */ }
    if (!interrupted) return;
    // 旧任务已失效；只有 shutdown 本身能在处理函数返回前使用仍有效的上下文。
    const cleanup: Lifecycle = { active: true };
    try { await pause(ctx, INTERRUPTED, cleanup); }
    finally { cleanup.active = false; }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const life = lifecycle;
    if (!life.active || gitAvailability === "unsupported") return;
    try {
      // 上次 git 探测异常（不是明确的非 git）时重新探测；仍失败照旧暂停。
      if (gitAvailability === "unknown" && (reviewRunning || !await probeRepository(ctx, life))) return;
      checkLive(life);
      // 暂停后你再让开发方干活就是接管：解除暂停，下次停下照常自动评审，返修计数重新算。
      // 返修消息发出前 phase 已是 idle，不会走到这里。
      if (state.phase === "paused") {
        const reason = state.pauseReason ?? "未知原因";
        state.phase = "idle";
        state.pauseReason = undefined;
        state.awaitingRepair = false;
        state.repairs = 0;
        saveState(life);
        updateStatus(ctx, life);
        ctx.ui.notify(`自动评审：已恢复（上次暂停：${reason}）`, "info");
      }
      if (state.requirement === undefined && event.prompt.trim()) {
        state.requirement = event.prompt;
        saveState(life);
      }
      if (state.baseline === undefined) {
        const snap = await evidence(ctx, life).snapshot();
        checkLive(life);
        state.baseline = snap.ref;
        state.baselineUntracked = snap.untracked.map(({ path }) => path);
        state.baselineFingerprint = snap.fingerprint;
        saveState(life);
      }
      // 验收标准只认用户消息：返修消息里不会出现「## 验收标准」标题。
      const acceptance = acceptanceEnabled(ctx);
      const criteria = acceptance ? criteriaFromUser(event.prompt, state.criteria) : undefined;
      if (criteria) {
        state.criteria = criteria;
        saveState(life);
        ctx.ui.notify(`自动验收：已记录验收标准第 ${criteria.version} 版（${criteria.items.length} 条）`, "info");
      }
      if (state.enabled) {
        const convention = acceptance ? `${CONVENTION}\n${ACCEPTANCE_CONVENTION}` : CONVENTION;
        const existing = event.systemPromptOptions.appendSystemPrompt ?? "";
        event.systemPromptOptions.appendSystemPrompt = existing ? `${existing}\n\n${convention}` : convention;
      }
    } catch (error) { await pauseForError(ctx, error, life); }
  });

  pi.on("agent_settled", async (_event, ctx) => {
    const life = lifecycle;
    if (!life.active || gitAvailability !== "available" || reviewRunning || state.phase === "reviewing") return;
    try {
      const marker = classifyMarker(lastAssistantText(ctx.sessionManager.getEntries()));
      if (marker === "decision") {
        if (state.phase === "paused") return;
        await pause(ctx, "开发方需要你决定", life);
        return;
      }
      // 暂停状态不自动评审，等你发消息让开发方继续（before_agent_start 解除）或输入 /review。
      if (state.phase === "paused") return;
      if (marker === "none") {
        const baseline = checkedFingerprint(state);
        if (!state.enabled || !baseline) return;
        const current = await evidence(ctx, life).snapshot();
        checkLive(life);
        if (current.fingerprint === baseline) {
          if (state.awaitingRepair) await pause(ctx, "返修后没有任何改动", life);
          return;
        }
        // 没有交付标记但有未评审改动：直接评审，与写了【交付完成】一样。
        void startReview(ctx, "auto");
        return;
      }
      if (state.enabled) void startReview(ctx, "auto");
    } catch (error) { await pauseForError(ctx, error, life); }
  });
}
