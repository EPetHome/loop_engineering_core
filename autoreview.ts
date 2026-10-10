/**
 * pi 自动评审扩展：交付标记触发评审，必修回送原开发会话；评审完成后执行验收命令（如有配置）。
 * 失败调用不推进成功检查点；git 取证失败或指纹变化只暂停。
 * 加载：pi -e /Users/Admin/Desktop/loop/autoreview.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  acceptanceLabel, classifyMarker, CONVENTION, deriveReviewerSessionId, renderSummary, type AcceptanceRecord,
} from "./core.ts";
import { createGitEvidence, GitReadError, type Exec, type ExecResult } from "./git.ts";
import {
  DEFAULT_MAX_REPAIRS, DEFAULT_MODEL, DEFAULT_THINKING, DEFAULT_TIMEOUT_MIN, INTERRUPTED,
  errorText, newReviewState, nowStamp, runReviewRound, tail,
  type ReviewConfig, type ReviewState,
} from "./review.ts";

interface Lifecycle { active: boolean }
interface ReviewTask { lifecycle: Lifecycle; controller: AbortController }
/** pi 扩展独有的验收记录挂在评审状态上一起存。 */
type PiState = ReviewState & { acceptance?: AcceptanceRecord };

const DEFAULT_ACCEPT_TIMEOUT_MIN = 120;
/** 总结里保留的验收输出行数；完整输出写日志文件。 */
const ACCEPT_TAIL_LINES = 20;

function flagString(pi: ExtensionAPI, name: string, fallback: string): string {
  const value = pi.getFlag(name);
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}
function positiveInt(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
function tailLines(text: string, count: number): string {
  return text.trimEnd().split(/\r?\n/).slice(-count).join("\n");
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
  let state: PiState = newReviewState();
  let gitAvailability: "unknown" | "available" | "unsupported" = "unknown";
  let unavailableReason = "不是 git 仓库，自动评审已关闭";
  /** 评审或验收任务在跑；两者互斥，期间不自动评审。 */
  let reviewRunning = false;
  let lifecycle: Lifecycle = { active: true };
  let activeTask: ReviewTask | undefined;

  const live = (life: Lifecycle, signal?: AbortSignal): boolean => life.active && !signal?.aborted;
  const checkLive = (life: Lifecycle, signal?: AbortSignal): void => {
    if (!live(life, signal)) throw new Error(INTERRUPTED);
  };
  const wrappedExec = (life: Lifecycle, signal?: AbortSignal): Exec => async (cmd, args, options) => {
    checkLive(life, signal);
    const res = await pi.exec(cmd, args, options);
    checkLive(life, signal);
    return res;
  };
  const evidence = (ctx: ExtensionContext, life: Lifecycle, signal?: AbortSignal) =>
    createGitEvidence(wrappedExec(life, signal), ctx.cwd, signal);
  const dataDir = (cwd: string): string => join(homedir(), ".pi-autoreview", basename(cwd));
  const summaryPath = (ctx: ExtensionContext): string => join(dataDir(ctx.cwd), `${ctx.sessionManager.getSessionId()}.md`);
  const saveState = (life: Lifecycle): void => {
    checkLive(life);
    pi.appendEntry("autoreview-state", state);
  };
  const updateStatus = (ctx: ExtensionContext, life: Lifecycle): void => {
    checkLive(life);
    let text: string | undefined;
    if (state.acceptance?.result === "进行中") text = "自动验收中";
    else if (state.phase === "reviewing") text = `自动评审中（第 ${state.rounds.length + 1} 轮）`;
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
      unresolvedMustFix, changedFiles, gitStatusShort, notes, acceptance: state.acceptance,
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

  const currentConfig = (): ReviewConfig => ({
    maxRepairs: positiveInt(flagString(pi, "autoreview-max-repairs", String(DEFAULT_MAX_REPAIRS)), DEFAULT_MAX_REPAIRS),
    reviewerModel: flagString(pi, "autoreview-reviewer-model", DEFAULT_MODEL),
    reviewerThinking: flagString(pi, "autoreview-reviewer-thinking", DEFAULT_THINKING),
    reviewTimeoutMin: positiveInt(flagString(pi, "autoreview-review-timeout-min", String(DEFAULT_TIMEOUT_MIN)), DEFAULT_TIMEOUT_MIN),
    reviewerCmd: flagString(pi, "autoreview-reviewer-cmd", ""),
  });
  const acceptCommand = (): string => flagString(pi, "autoreview-accept-cmd", "");
  const acceptTimeoutMs = (): number => Math.max(60_000,
    positiveInt(flagString(pi, "autoreview-accept-timeout-min", String(DEFAULT_ACCEPT_TIMEOUT_MIN)), DEFAULT_ACCEPT_TIMEOUT_MIN) * 60_000);
  const newAcceptance = (trigger: AcceptanceRecord["trigger"]): AcceptanceRecord => ({
    command: acceptCommand(), trigger, round: state.rounds.length, startedAt: nowStamp(), result: "进行中",
  });

  /** 按当前阶段重写总结，验收开始、结束、中断时用。 */
  const rewriteSummary = async (ctx: ExtensionContext, life: Lifecycle, signal?: AbortSignal): Promise<void> => {
    if (state.phase === "paused") {
      await writeSummary(ctx, "暂停", life, state.pauseReason, state.unresolvedMustFix, undefined, undefined, signal);
    } else {
      await writeSummary(ctx, state.phase === "done" ? "完成" : "进行中", life, undefined, undefined, undefined, undefined, signal);
    }
  };

  /** 验收结果落盘并通知；副作用逐个隔离，任何一步失败都不能挡住通知。 */
  const finishAcceptance = async (
    ctx: ExtensionContext, record: AcceptanceRecord, life: Lifecycle, signal?: AbortSignal,
  ): Promise<void> => {
    if (!live(life, signal)) return;
    const errors: string[] = [];
    try { saveState(life); } catch (error) { errors.push(`状态保存失败：${errorText(error)}`); }
    try { updateStatus(ctx, life); } catch (error) { errors.push(`状态栏更新失败：${errorText(error)}`); }
    try { await rewriteSummary(ctx, life, signal); } catch (error) { errors.push(`总结写入失败：${errorText(error)}`); }
    if (!live(life, signal)) return;
    const hint = record.result === "中断" ? "，输入 /accept 重新验收" : `，详情见 ${summaryPath(ctx)}`;
    await notifyUser(
      ctx, `${basename(ctx.cwd)}：验收${acceptanceLabel(record)}${hint}${errors.length ? `；${errors.join("；")}` : ""}`,
      record.result === "通过" ? "info" : "warning", life, signal,
    );
  };

  /**
   * 执行验收命令：在项目目录用 /bin/sh -c 跑，退出码 0 为通过。
   * 不抛错，评审状态不受验收影响；会话关闭时直接返回，由关闭处理器记为中断。
   */
  const runAcceptance = async (ctx: ExtensionContext, task: ReviewTask, record: AcceptanceRecord): Promise<void> => {
    const { lifecycle: life, controller } = task;
    const signal = controller.signal;
    if (!live(life, signal)) return;
    // 开始前的落盘失败不阻止执行，结束时会再写一次并在通知里报告。
    try { saveState(life); } catch { /* 见 finishAcceptance */ }
    try { updateStatus(ctx, life); } catch { /* 见 finishAcceptance */ }
    try { await rewriteSummary(ctx, life, signal); } catch { /* 见 finishAcceptance */ }
    if (!live(life, signal)) return;
    const startedTs = Date.now();
    try {
      let res: ExecResult | undefined;
      let failure = "";
      try {
        res = await pi.exec("/bin/sh", ["-c", record.command], { cwd: ctx.cwd, timeout: acceptTimeoutMs(), signal });
      } catch (error) { failure = errorText(error); }
      if (!live(life, signal)) return;
      record.durationMs = Date.now() - startedTs;
      if (!res) {
        record.result = "无法执行";
        record.detail = tail(failure, 300);
      } else {
        record.exitCode = res.code;
        record.result = res.killed ? "超时" : res.code === 0 ? "通过" : "不通过";
        if (res.killed) record.detail = `超过 ${Math.round(acceptTimeoutMs() / 60_000)} 分钟被终止`;
        const stderr = res.stderr.trim() ? `\n[stderr]\n${res.stderr.trimEnd()}` : "";
        record.outputTail = tailLines(`${res.stdout.trimEnd()}${stderr}`, ACCEPT_TAIL_LINES);
        const logPath = join(dataDir(ctx.cwd), `accept-${ctx.sessionManager.getSessionId()}-r${record.round}.log`);
        try {
          mkdirSync(dirname(logPath), { recursive: true });
          writeFileSync(logPath, [`$ ${record.command}`, `退出码：${res.code}${res.killed ? "（被终止）" : ""}`, "", "[stdout]", res.stdout, "[stderr]", res.stderr].join("\n"));
          record.logPath = logPath;
        } catch (error) {
          record.detail = [record.detail, `日志写入失败：${errorText(error)}`].filter(Boolean).join("；");
        }
      }
    } catch (error) {
      if (!live(life, signal)) return;
      record.durationMs = Date.now() - startedTs;
      record.result = "无法执行";
      record.detail = tail(errorText(error), 300);
    }
    await finishAcceptance(ctx, record, life, signal);
  };

  /** 会话关闭或恢复时发现验收没跑完：记为中断，提示 /accept。 */
  const interruptAcceptance = async (ctx: ExtensionContext, life: Lifecycle): Promise<void> => {
    const record = state.acceptance;
    if (!record || record.result !== "进行中") return;
    record.result = "中断";
    record.detail = "会话关闭或重载，验收没有跑完";
    await finishAcceptance(ctx, record, life);
  };

  /** 手动 /accept：独立任务，与评审互斥。 */
  const startAcceptance = async (ctx: ExtensionContext): Promise<void> => {
    const life = lifecycle;
    if (!life.active || reviewRunning) return;
    const task: ReviewTask = { lifecycle: life, controller: new AbortController() };
    activeTask = task;
    reviewRunning = true;
    try {
      state.acceptance = newAcceptance("command");
      await runAcceptance(ctx, task, state.acceptance);
    } catch (error) {
      if (live(life, task.controller.signal)) ctx.ui.notify(`自动评审：验收失败：${errorText(error)}`, "warning");
    } finally {
      if (activeTask === task) {
        reviewRunning = false;
        activeTask = undefined;
      }
    }
  };

  const runReview = async (ctx: ExtensionContext, round: number, task: ReviewTask): Promise<void> => {
    const { lifecycle: life, controller } = task;
    const signal = controller.signal;
    const cwd = ctx.cwd;
    const outcome = await runReviewRound({
      cwd, devSessionId: ctx.sessionManager.getSessionId(), round,
      deliveryNote: lastAssistantText(ctx.sessionManager.getEntries()),
      state, config: currentConfig(),
      exec: wrappedExec(life, signal),
      checkLive: () => checkLive(life, signal),
      onProgress: (text) => { if (live(life, signal)) ctx.ui.setStatus("autoreview", text); },
      writeInput: (name, text) => {
        const dir = dataDir(cwd);
        mkdirSync(dir, { recursive: true });
        const path = join(dir, name);
        writeFileSync(path, text);
        return path;
      },
      writeSummary: (status) => writeSummary(ctx, status, life, undefined, undefined, undefined, undefined, signal),
      saveState: () => saveState(life),
      signal,
    });
    checkLive(life, signal);
    if (outcome.kind === "done") {
      state.phase = "done";
      state.awaitingRepair = false;
      // 评审完成必触发验收：「进行中」与完成一起保存，中途关闭也能在关闭或恢复时记为中断。
      const acceptance = acceptCommand() ? newAcceptance("auto") : undefined;
      state.acceptance = acceptance;
      saveState(life);
      updateStatus(ctx, life);
      await notifyUser(
        ctx, `${basename(cwd)}：完成（评审 ${state.rounds.length} 次，返修 ${state.repairs} 次）${acceptance ? "，开始验收" : ""}`,
        "info", life, signal,
      );
      if (acceptance) await runAcceptance(ctx, task, acceptance);
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
        ctx.ui.notify("自动评审：已有评审或验收在进行", "warning");
        return;
      }
      task = { lifecycle: life, controller: new AbortController() };
      activeTask = task;
      reviewRunning = true;
      if (trigger === "command" || state.phase === "done") state.repairs = 0;
      state.phase = "reviewing";
      state.pauseReason = undefined;
      state.awaitingRepair = false;
      // 新一轮评审意味着代码可能变了，上一次验收结果不再对应当前代码。
      state.acceptance = undefined;
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
  pi.registerFlag("autoreview-accept-cmd", { type: "string", default: "", description: "评审完成后执行的验收命令（在项目目录用 /bin/sh -c 执行，退出码 0 为通过）" });
  pi.registerFlag("autoreview-accept-timeout-min", { type: "string", default: String(DEFAULT_ACCEPT_TIMEOUT_MIN), description: "验收命令时限（分钟）" });

  pi.registerCommand("review", {
    description: "立即评审当前改动（返修计数重新算）",
    handler: async (_args, ctx) => {
      if (!lifecycle.active) return;
      if (gitAvailability === "unsupported") { ctx.ui.notify(unavailableReason, "warning"); return; }
      if (reviewRunning || state.phase === "reviewing") { ctx.ui.notify("自动评审：已有评审或验收在进行", "warning"); return; }
      if (!ctx.isIdle()) { ctx.ui.notify("自动评审：开发方正在运行，等停下来再评审", "warning"); return; }
      void startReview(ctx, "command");
    },
  });
  pi.registerCommand("accept", {
    description: "立即执行验收命令",
    handler: async (_args, ctx) => {
      if (!lifecycle.active) return;
      if (gitAvailability === "unsupported") { ctx.ui.notify(unavailableReason, "warning"); return; }
      if (!acceptCommand()) { ctx.ui.notify("自动评审：没有配置验收命令（--autoreview-accept-cmd）", "warning"); return; }
      if (reviewRunning || state.phase === "reviewing") { ctx.ui.notify("自动评审：已有评审或验收在进行", "warning"); return; }
      if (!ctx.isIdle()) { ctx.ui.notify("自动评审：开发方正在运行，等停下来再验收", "warning"); return; }
      void startAcceptance(ctx);
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
        `验收：${state.acceptance ? acceptanceLabel(state.acceptance) : acceptCommand() ? "未执行" : "未配置"}`,
        `评审会话：${state.reviewerSessionId ?? deriveReviewerSessionId(devSessionId)}`, `总结：${summaryPath(ctx)}`,
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
      const entries = ctx.sessionManager.getEntries();
      for (let i = entries.length - 1; i >= 0; i -= 1) {
        const entry = entries[i];
        if (entry.type === "custom" && entry.customType === "autoreview-state" && entry.data) {
          state = { ...newReviewState(), ...(entry.data as PiState) };
          break;
        }
      }
      if (!await probeRepository(ctx, life)) return;
      if (state.phase === "reviewing") await pause(ctx, INTERRUPTED, life);
      else updateStatus(ctx, life);
      checkLive(life);
      // 上次进程没走到关闭处理器（崩溃、强杀）时，验收仍是「进行中」。
      if (state.acceptance?.result === "进行中") await interruptAcceptance(ctx, life);
      else if (state.acceptance?.result === "中断") ctx.ui.notify("自动评审：上次验收被中断，输入 /accept 重新验收", "info");
      checkLive(life);
      if (state.phase === "paused") ctx.ui.notify(`自动评审：上次暂停（${state.pauseReason ?? "未知原因"}），输入 /review 继续`, "info");
    } catch (error) { await pauseForError(ctx, error, life); }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (!lifecycle.active) return;
    const interrupted = state.phase === "reviewing";
    const accepting = state.acceptance?.result === "进行中";
    lifecycle.active = false;
    activeTask?.controller.abort();
    activeTask = undefined;
    reviewRunning = false;
    if (!interrupted && !accepting) return;
    // 旧任务已失效；只有 shutdown 本身能在处理函数返回前使用仍有效的上下文。
    const cleanup: Lifecycle = { active: true };
    try {
      if (interrupted) await pause(ctx, INTERRUPTED, cleanup);
      else await interruptAcceptance(ctx, cleanup);
    } finally { cleanup.active = false; }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const life = lifecycle;
    if (!life.active || gitAvailability !== "available") return;
    try {
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
      if (state.enabled) {
        const existing = event.systemPromptOptions.appendSystemPrompt ?? "";
        event.systemPromptOptions.appendSystemPrompt = existing ? `${existing}\n\n${CONVENTION}` : CONVENTION;
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
      // 暂停状态不自动评审，等用户输入 /review。
      if (state.phase === "paused") return;
      if (marker === "none") {
        const baseline = state.lastFingerprint ?? state.baselineFingerprint;
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
