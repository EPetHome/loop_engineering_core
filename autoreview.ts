/**
 * pi 自动评审扩展：交付标记触发评审（配了门禁先跑门禁），必修回送原开发会话；评审完成后执行验收命令（如有配置）。
 * 失败调用不推进成功检查点；git 取证失败或指纹变化只暂停；暂停后你再让开发方干活即恢复自动评审。
 * 加载：pi -e /Users/Admin/Desktop/loop/autoreview.ts
 */
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { authorizationLine, criteriaFromUser, grantsFromUser, isLoopMessage, typedByUser } from "./acceptance-core.ts";
import { checkRoundBudget, configurationHash, findProjectRoot, readMarker, parseAcceptanceConfig, parseGateConfig, loadAcceptanceConfig, loadGateConfig, type AcceptanceConfig, type GateConfig } from "./config.ts";
import {
  acceptRunLabel, classifyMarker, conventionText, deriveReviewerSessionId, renderSummary, type AcceptRunRecord,
} from "./core.ts";
import { createGitEvidence, GitReadError, type Exec, type ExecResult } from "./git.ts";
import { acceptanceTodos, conventionNotice } from "./onboarding.ts";
import { experienceInjection, experienceSession, experienceTodos } from "./experience.ts";
import { finishExperience } from "./experience-draft.ts";
import {
  inboxPath, PIPELINE_LAUNCH_TOKEN_ENV, pollMs, readJson, stageFromEnv, statusPath, writeStageStatus,
  type InboxMessage, type StageEvent, type StageLink,
} from "./pipeline-core.ts";
import { processStartTime, reapProcs } from "./procs.ts";
import { queueStageEvent } from "./merge-queue.ts";
import { classifyFailure, failureLabel } from "./failure.ts";
import { loadPreparation, parsePreparation, runPreparation } from "./preparation.ts";
import { methodEnv } from "./method-env.ts";
import { createChildExec, expandFileRefs } from "./hosts/hook.ts";
import { appendLedgerRecord, deliveryLedgerPath, pendingItems, projectRootOf, resultLine, taskTitle, type PendingItem } from "./ledger.ts";
import { createRunResource, managedShell, reapRunResources, releaseRunResource, resourceLine, type RunResource } from "./resources.ts";
import { materialSession, recordMaterialSession, slimCompletedSession } from "./materials.ts";
import { isRegisteredSource, loadContext, recordProjectOutcome, recordSourceChange, refreshContext, type ContextConfig, type ContextResult } from "./project-context.ts";
import {
  DEFAULT_MAX_REPAIRS, DEFAULT_MODEL, DEFAULT_THINKING, DEFAULT_TIMEOUT_MIN, INTERRUPTED,
  checkedFingerprint, errorText, lastAcceptance, newReviewState, nowStamp, runReviewRound, sourcesOnlyWorkspaceChange, tail,
  type ReviewConfig, type ReviewState,
} from "./review.ts";

interface Lifecycle { active: boolean }
interface ReviewTask { lifecycle: Lifecycle; controller: AbortController; finished: Promise<void>; finish: () => void }
/**
 * pi 扩展独有的状态，挂在评审状态上一起存：验收命令记录（与自动验收无关）；
 * 流水线收件箱已收下的序号、正在等开发方处理的那一条。
 */
type LedgerState = { session: string; path: string; pending: PendingItem[]; failed?: boolean };
type PiState = ReviewState & { needsInputReview?: boolean; readyEpoch?: string; pendingAcceptanceCandidate?: string; pendingAcceptanceInputs?: string; acceptRun?: AcceptRunRecord; inboxHandled?: number; awaitingInbox?: number; ledger?: LedgerState };

const DEFAULT_ACCEPT_TIMEOUT_MIN = 120;
/** 总结里保留的验收命令输出行数；完整输出写日志文件。 */
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

export default function autoreviewExtension(pi: ExtensionAPI, execOverride?: Exec): void {
  // 自定义 start 不经过 bin/pi-dev；扩展加载即撤掉一次性启动回报身份，门禁子进程不能改写父段状态。
  if (process.env[PIPELINE_LAUNCH_TOKEN_ENV]) delete process.env[PIPELINE_LAUNCH_TOKEN_ENV];
  let state: PiState = newReviewState();
  const experienceOwner = randomUUID();
  const trackExperienceSession = (ctx: ExtensionContext, active: boolean): void =>
    experienceSession(ctx.cwd, `pi:${ctx.sessionManager.getSessionId()}:${process.pid}:${experienceOwner}`, active);
  let gitAvailability: "unknown" | "available" | "unsupported" = "unknown";
  let unavailableReason = "不是 git 仓库，自动评审已关闭";
  /** 评审或验收命令任务在跑；两者互斥，期间不自动评审。 */
  let reviewRunning = false;
  /** 当前开发回合独立于上一次评审完成态；普通追加消息也可能继续编辑。 */
  let developerRunning = false;
  let lifecycle: Lifecycle = { active: true };
  let activeTask: ReviewTask | undefined;
  /** 由流水线启动时：属于哪个流水线目录、哪一段；收件箱轮询用的最近一次上下文。 */
  let pipelineLink: StageLink | undefined;
  let inboxTimer: ReturnType<typeof setInterval> | undefined;
  let contextTimer: ReturnType<typeof setInterval> | undefined;
  let inboxBusy = false;
  let cleanupWork: Promise<void> | undefined;
  let cleanupRecordPath: string | undefined;
  let latestCtx: ExtensionContext | undefined;
  /** 本次 Pi 开发会话启动时是否确认没注册 Ponytail；取不到命令时保持 false（无法判断）。 */
  let ponytailMissing = false;

  /**
   * 所有扩展的工厂都已加载后（session_start）再读实际注册的命令。
   * 只提醒、不拦截：读取失败或返回异常当作无法判断，不影响会话。
   */
  const checkPonytail = (ctx: ExtensionContext): void => {
    ponytailMissing = false;
    let commands: ReturnType<ExtensionAPI["getCommands"]>;
    try { commands = pi.getCommands(); } catch { return; }
    if (!Array.isArray(commands)) return;
    try {
      ponytailMissing = !commands.some((command) => command?.name === "ponytail");
    } catch { ponytailMissing = false; return; }
    if (!ponytailMissing) return;
    try { ctx.ui.notify("未加载 Ponytail（开发角色要求加载）；本次会话照常继续。", "warning"); } catch { /* 提醒失败不影响会话 */ }
  };

  const live = (life: Lifecycle, signal?: AbortSignal): boolean => life.active && !signal?.aborted;
  const checkLive = (life: Lifecycle, signal?: AbortSignal): void => {
    if (!live(life, signal)) throw new Error(INTERRUPTED);
  };
  // Pi 与 Hook 共用进程组执行器；测试可注入现有执行器，不改变宿主 API。
  const wrappedExec = (ctx: ExtensionContext, life: Lifecycle, signal?: AbortSignal): Exec => async (cmd, args, options) => {
    checkLive(life, signal);
    const res = await (execOverride ?? createChildExec(procsPath(ctx)))(cmd, args, options);
    checkLive(life, signal);
    return res;
  };
  const evidence = (ctx: ExtensionContext, life: Lifecycle, signal?: AbortSignal) =>
    createGitEvidence(wrappedExec(ctx, life, signal), ctx.cwd, signal);
  const dataDir = (ctx: ExtensionContext): string => join(homedir(), ".pi-autoreview", basename(ctx.cwd));
  const summaryPath = (ctx: ExtensionContext): string => join(dataDir(ctx), `${ctx.sessionManager.getSessionId()}.md`);
  const procsPath = (ctx: ExtensionContext): string => join(dataDir(ctx), `${ctx.sessionManager.getSessionId()}.procs.json`);
  /** .autoreview.json 的 acceptance 一节；配置非法时抛错（评审路径里会变成暂停）。 */
  const acceptanceConfig = (ctx: ExtensionContext): AcceptanceConfig | undefined => loadAcceptanceConfig(ctx.cwd);
  /** 只用于注入约定和取标准：配置非法时当作没配，错误留给评审路径报。 */
  const acceptanceEnabled = (ctx: ExtensionContext): boolean => {
    try { return acceptanceConfig(ctx) !== undefined; } catch { return false; }
  };
  /** .autoreview.json 的 gate 一节；配置非法时抛错（评审路径里会变成暂停）。 */
  const gateConfig = (ctx: ExtensionContext): GateConfig | undefined => loadGateConfig(ctx.cwd);
  /** 只用于注入约定：配置非法时当作没配，错误留给评审路径报。 */
  const gateCommand = (ctx: ExtensionContext): string | undefined => {
    try { return gateConfig(ctx)?.cmd; } catch { return undefined; }
  };
  const saveState = (life: Lifecycle): void => {
    checkLive(life);
    if (state.phase !== "done") state.materialCleanup = undefined;
    pi.appendEntry("autoreview-state", state);
    if (latestCtx) {
      trackExperienceSession(latestCtx, lifecycle.active && (developerRunning || state.phase !== "done"));
      recordMaterialSession(sessionMaterials(latestCtx));
    }
  };
  const sessionMaterials = (ctx: ExtensionContext) => materialSession(ctx.sessionManager.getSessionId(), ctx.cwd, summaryPath(ctx),
    state.acceptRun?.result === "进行中" ? "accepting" : state.phase,
    state.rounds.flatMap((round) => round.acceptance ? [round.acceptance.runDir] : []));
  const slimMaterials = (ctx: ExtensionContext, life: Lifecycle): void => {
    if (sessionMaterials(ctx).phase !== "done") return;
    state.materialCleanup = slimCompletedSession(sessionMaterials(ctx));
    saveState(life);
  };
  /** 流水线里的段：把完成、暂停、返修后没改动写进状态文件，编排程序据此接力。写失败不影响评审。 */
  const reportStage = (ctx: ExtensionContext, event: StageEvent, extra: { pauseReason?: string; reply?: string } = {}): boolean => {
    if (!pipelineLink) return true;
    try {
      const status = {
        sessionId: ctx.sessionManager.getSessionId(), host: "pi", pid: process.pid, processStarted: processStartTime(process.pid),
        summary: summaryPath(ctx), event, ...(event === "done" ? { readyEpoch: state.readyEpoch, sourceInputs: state.inputsFingerprint } : {}), inbox: state.inboxHandled ?? 0, ...extra,
      };
      writeStageStatus(pipelineLink, status);
      queueStageEvent({ cwd: ctx.cwd, file: process.env.AUTOREVIEW_BATCH_FILE, stage: pipelineLink.stage, status });
      return true;
    } catch {
      // 不能写入失效状态时，也不能留下旧的 done 供消费者接力。
      if (event !== "done") { try { rmSync(statusPath(pipelineLink.dir, pipelineLink.stage), { force: true }); } catch { /* 调用方仍收到失败 */ } }
      return false;
    }
  };
  const updateStatus = (ctx: ExtensionContext, life: Lifecycle): void => {
    checkLive(life);
    let text: string | undefined;
    if (state.acceptRun?.result === "进行中") text = "验收命令执行中";
    else if (state.phase === "reviewing") text = `自动评审中（第 ${state.rounds.length + 1} 轮）`;
    else if (state.phase === "paused") text = "自动评审：暂停";
    else if (gitAvailability === "available" && state.phase === "done") text = "自动评审：完成";
    else if (gitAvailability === "available" && !state.enabled) text = "自动评审：已关闭";
    ctx.ui.setStatus("autoreview", text);
  };
  /** detail 只显示在 pi 界面里（下一步怎么做），系统通知保持简短。 */
  const notifyUser = async (
    ctx: ExtensionContext, body: string, type: "info" | "warning", life: Lifecycle, signal?: AbortSignal, detail?: string,
  ): Promise<void> => {
    if (!live(life, signal)) return;
    try { ctx.ui.notify(detail ? `${body}\n${detail}` : body, type); } catch { /* 无 UI 时仍尝试系统通知 */ }
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
    // 提交数只是记录，取不到就不写。
    let newCommits: number | undefined;
    try { if (state.baseline) newCommits = await evidence(ctx, life, signal).commitsSince(state.baseline); } catch { checkLive(life, signal); }
    const devSessionId = ctx.sessionManager.getSessionId();
    let acceptance: AcceptanceConfig | undefined;
    try { acceptance = acceptanceConfig(ctx); } catch { acceptance = undefined; }
    const todos = acceptanceTodos({
      acceptance, host: "pi", phase: state.phase, pauseHint: state.pauseHint,
      criteria: state.criteria, lastAcceptance: lastAcceptance(state),
    });
    if (status === "完成") todos.push(...experienceTodos(ctx.cwd, state.experienceDraft?.error));
    const text = renderSummary({
      cwd: ctx.cwd, devSessionId,
      reviewerSessionId: state.reviewerSessionId ?? deriveReviewerSessionId(devSessionId),
      status, pauseReason, rounds: state.rounds, repairs: state.repairs,
      unresolvedMustFix, changedFiles, gitStatusShort, notes,
      criteria: state.criteria, grants: state.grants, unresolvedAcceptance: state.unresolvedAcceptance, todos, acceptRun: state.acceptRun, newCommits,
      sourceChanges: state.sourceChanges, sourceChangeNote: state.sourceChangeNote,
      ponytailMissing, materialCleanup: state.materialCleanup,
      ledger: state.phase === "done" && state.ledger
        ? { path: state.ledger.path, pending: state.ledger.pending, failed: state.ledger.failed } : undefined,
    });
    const file = summaryPath(ctx);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  };

  /** 错误处理的副作用逐个隔离；任何一步失败都不能挡住后面的通知。 */
  const pause = async (
    ctx: ExtensionContext, reason: string, life: Lifecycle,
    unresolvedMustFix = state.unresolvedMustFix, changedFiles?: string[], notes?: string, signal?: AbortSignal, hint?: string,
  ): Promise<void> => {
    if (!live(life, signal)) return;
    state.phase = "paused";
    state.pauseReason = reason;
    state.pauseHint = hint;
    state.unresolvedMustFix = unresolvedMustFix;
    state.awaitingRepair = false;
    state.awaitingInbox = undefined;
    const errors: string[] = [];
    try { saveState(life); } catch (error) { errors.push(`状态保存失败：${errorText(error)}`); }
    reportStage(ctx, "paused", { pauseReason: reason });
    try { updateStatus(ctx, life); } catch (error) { errors.push(`状态栏更新失败：${errorText(error)}`); }
    try {
      await writeSummary(ctx, "暂停", life, reason, unresolvedMustFix, changedFiles, notes, signal);
    } catch (error) { errors.push(`总结写入失败：${errorText(error)}`); }
    if (!live(life, signal)) return;
    await notifyUser(ctx, `${basename(ctx.cwd)}：暂停（${reason}）${errors.length ? `；${errors.join("；")}` : ""}`, "warning", life, signal, hint);
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
    const root = findProjectRoot(ctx.cwd);
    const marker = root ? readMarker(root) : {};
    const acceptance = root ? parseAcceptanceConfig(marker.acceptance, root) : undefined;
    const gate = parseGateConfig(marker.gate);
    checkRoundBudget(config.reviewTimeoutMin, acceptance, gate);
    return { ...config, ...(acceptance ? { acceptance } : {}), ...(gate ? { gate } : {}), preparation: root ? parsePreparation(marker.preparation, root) : undefined, configurationHash: configurationHash(marker) };
  };

  const acceptCommand = (): string => flagString(pi, "autoreview-accept-cmd", "");
  const acceptMode = (): "required" | "advisory" => {
    const value = flagString(pi, "autoreview-accept-mode", "required");
    if (value !== "required" && value !== "advisory") throw new Error("autoreview-accept-mode 必须是 required 或 advisory");
    return value;
  };
  const acceptTimeoutMs = (): number => Math.max(60_000,
    positiveInt(flagString(pi, "autoreview-accept-timeout-min", String(DEFAULT_ACCEPT_TIMEOUT_MIN)), DEFAULT_ACCEPT_TIMEOUT_MIN) * 60_000);
  // 来源内容变化不再让验收结果作废；这里绑定用户输入、标准、授权、配置和命令。
  const acceptanceInputs = (ctx: ExtensionContext, config = currentConfig(ctx)): string => createHash("sha256").update(JSON.stringify({
    requirement: state.requirement, criteria: state.criteria, grants: state.grants,
    config, command: acceptCommand(), mode: acceptMode(),
  })).digest("hex");
  const newAcceptRun = (trigger: AcceptRunRecord["trigger"]): AcceptRunRecord => ({
    command: acceptCommand(), trigger, round: state.rounds.length, startedAt: nowStamp(), result: "进行中",
    mode: acceptMode(), candidate: state.pendingAcceptanceCandidate, inputsFingerprint: state.pendingAcceptanceInputs, readyEpoch: state.readyEpoch,
  });

  /**
   * 来源内容变化不再暂停：把记录的版本更新为当前版本，变化写进总结；
   * 返回要阻塞的说明（缺失是配置错误，照旧暂停）。
   */
  const absorbSourceChanges = (context: ContextResult): { problem?: string; changed: boolean } => {
    if (context.snapshot.missing.length) return { problem: `上游来源缺失：${context.snapshot.missing.join("、")}`, changed: false };
    if (state.inputsFingerprint === undefined) { state.inputsFingerprint = context.snapshot.inputsFingerprint; return { changed: false }; }
    if (state.inputsFingerprint === context.snapshot.inputsFingerprint) return { changed: false };
    recordSourceChange(state, context.changes, context.snapshot.revision);
    state.inputsFingerprint = context.snapshot.inputsFingerprint;
    return { changed: true };
  };

  /**
   * 发布完成前核对来源：内容变化只记录，缺失/配置移除返回问题。
   * 需要写交付索引的调用方用返回的 config，避免重复读盘。
   */
  const checkPublishSources = (ctx: ExtensionContext, life: Lifecycle): { problem?: string; config?: ContextConfig } => {
    const config = loadContext(ctx.cwd);
    if (!config) return { problem: state.inputsFingerprint ? "上游来源配置已移除，需要重新确认输入" : undefined };
    const absorbed = absorbSourceChanges(refreshContext(config));
    if (absorbed.changed) saveState(life);
    return { problem: absorbed.problem, config };
  };

  /** 写交付索引；发布 done 前仍核对来源缺失，有问题就不写、交给调用方暂停。 */
  const recordOutcome = (ctx: ExtensionContext, life: Lifecycle): string | undefined => {
    const { problem, config } = checkPublishSources(ctx, life);
    if (problem || !config) return problem;
    return recordProjectOutcome(config, ctx.sessionManager.getSessionId(), state.phase, summaryPath(ctx));
  };

  /**
   * 完成时往交付总表追加一段。同一会话已有本完成态对应的段时不重复写；
   * 写入失败只提示，不让会话暂停或影响完成状态。
   */
  const recordLedger = async (ctx: ExtensionContext, life: Lifecycle): Promise<void> => {
    const session = ctx.sessionManager.getSessionId();
    if (state.ledger?.session === session) return;
    // 只认本轮（最后一段）的验收结果，避免配置去掉后把旧记录当成当前欠项。
    const acceptance = state.rounds[state.rounds.length - 1]?.acceptance;
    const pending = pendingItems(acceptance);
    const record = {
      project: projectRootOf(ctx.cwd), session, task: taskTitle(state.requirement),
      result: resultLine(acceptance, state.rounds.length, state.repairs),
      summary: summaryPath(ctx), pending,
    };
    let problem: string | undefined;
    try {
      state.ledger = { session, path: appendLedgerRecord(record), pending };
    } catch (error) {
      problem = `交付总表写入失败：${errorText(error)}`;
      // 写入失败也在总结里写明该往哪查，但不冒充已登记。
      state.ledger = { session, path: deliveryLedgerPath(), pending, failed: true };
    }
    try { saveState(life); } catch (error) { problem = problem ?? `状态保存失败：${errorText(error)}`; }
    if (!live(life)) return;
    if (problem) await notifyUser(ctx, `${basename(ctx.cwd)}：${problem}；会话照常完成`, "warning", life, undefined, `总表：${deliveryLedgerPath()}`);
  };

  /** 所有完成发布入口共用：恢复也不能把旧记录当成当前候选的资格。 */
  const completionProblem = async (ctx: ExtensionContext, life: Lifecycle, signal?: AbortSignal, requireCommandResult = true): Promise<string | undefined> => {
    if (!state.pendingAcceptanceCandidate || !state.pendingAcceptanceInputs || !state.readyEpoch) return "完成记录缺少候选或输入依据，需要重新评审";
    const git = evidence(ctx, life, signal);
    const candidate = await git.snapshot();
    checkLive(life, signal);
    if (state.pendingAcceptanceInputs !== acceptanceInputs(ctx)) return "候选或输入版本变化，原评审结果不能放行当前候选";
    // 工作区指纹变了：有来源信息时只有已登记来源文件的内容变化才放行；代码等候选改动照旧。
    // 没有来源配置时保持原有严格比较。
    const contextConfig = loadContext(ctx.cwd);
    if (candidate.fingerprint !== state.pendingAcceptanceCandidate) {
      const before = state.lastSnapshotDetails;
      // 程序提交会把 HEAD 和未跟踪文件状态改掉，但内容没变：按有效内容放行。
      // 真实内容或文件模式变化仍会得到不同指纹，继续走来源豁免或拒绝。
      let sameContent = false;
      if (before) {
        try { sameContent = await git.contentFingerprint(before) === await git.contentFingerprint(candidate); }
        catch { sameContent = false; }
      }
      const sourcesOnly = !sameContent && contextConfig && before
        ? await sourcesOnlyWorkspaceChange(git, before, candidate, (path) => isRegisteredSource(contextConfig, ctx.cwd, path))
        : false;
      if (!sameContent && !sourcesOnly) return "候选或输入版本变化，原评审结果不能放行当前候选";
    }
    // 取证完成后再核对来源：内容变化只记录；缺失/配置移除照旧阻塞，也能接住取证窗口里的删除。
    if (!contextConfig) {
      if (state.inputsFingerprint) return "上游来源配置已移除，需要重新确认输入";
    } else {
      const absorbed = absorbSourceChanges(refreshContext(contextConfig));
      if (absorbed.problem) return absorbed.problem;
      if (absorbed.changed) saveState(life);
    }
    if (requireCommandResult && acceptCommand() && acceptMode() === "required") {
      const result = state.acceptRun;
      if (result?.mode !== "required" || result.result !== "通过" || result.command !== acceptCommand()
        || result.candidate !== state.pendingAcceptanceCandidate || result.inputsFingerprint !== state.pendingAcceptanceInputs || result.readyEpoch !== state.readyEpoch) return "当前必需验收尚未通过，不能接力";
    }
    return undefined;
  };

  /** 按当前阶段重写总结，验收命令开始、结束、中断时用。 */
  const rewriteSummary = async (ctx: ExtensionContext, life: Lifecycle, signal?: AbortSignal): Promise<void> => {
    if (state.phase === "paused") {
      await writeSummary(ctx, "暂停", life, state.pauseReason, state.unresolvedMustFix, undefined, undefined, signal);
    } else {
      await writeSummary(ctx, state.phase === "done" ? "完成" : "进行中", life, undefined, undefined, undefined, undefined, signal);
    }
  };

  const invalidateCompletion = async (ctx: ExtensionContext, life: Lifecycle, note = "用户输入已更新，旧完成资格已撤销；等待按新输入检查。"): Promise<void> => {
    const previous = activeTask;
    previous?.controller.abort();
    state.pendingAcceptanceCandidate = undefined; state.pendingAcceptanceInputs = undefined; state.acceptRun = undefined; state.readyEpoch = undefined;
    state.needsInputReview = true; state.awaitingRepair = false;
    // 完成资格已撤销：下一次完成要新登记一段，不能沿用旧的总表路径。
    state.ledger = undefined;
    state.phase = "idle"; state.pauseReason = undefined; state.pauseHint = undefined;
    try {
      if (!reportStage(ctx, "started")) throw new Error("无法保存输入失效状态，旧接力标记已尝试移除，请检查存储");
      saveState(life); updateStatus(ctx, life);
      await writeSummary(ctx, "进行中", life, undefined, undefined, undefined, note);
    } finally { await previous?.finished; }
    checkLive(life);
  };

  const invalidateSources = async (ctx: ExtensionContext, life: Lifecycle, problem: string): Promise<void> => {
    await invalidateCompletion(ctx, life, `${problem}；旧完成资格已撤销。`);
    await pause(ctx, problem, life, undefined, undefined, undefined, undefined, "查看 /review-inputs；确认来源后再 accept，业务计数与原输入保留。");
  };

  /** 先结束本轮检查再让开发方接手，避免新一轮停下时仍被 reviewRunning 拦住。 */
  const deliverRepair = (ctx: ExtensionContext, message: string, life: Lifecycle): void => {
    const task = activeTask;
    const input = JSON.stringify([state.requirement, state.criteria, state.grants]);
    void (task?.finished ?? Promise.resolve()).then(() => {
      if (!live(life, task?.controller.signal) || input !== JSON.stringify([state.requirement, state.criteria, state.grants])) return;
      if (ctx.isIdle()) pi.sendUserMessage(message);
      else pi.sendUserMessage(message, { deliverAs: "followUp" });
    }).catch((error) => { if (live(life)) void pauseForError(ctx, error, life); });
  };

  /** 验收命令结果落盘并通知；副作用逐个隔离，任何一步失败都不能挡住通知。 */
  const finishAcceptRun = async (
    ctx: ExtensionContext, record: AcceptRunRecord, life: Lifecycle, signal?: AbortSignal,
  ): Promise<void> => {
    if (!live(life, signal)) return;
    if (record.mode === "required") {
      if (record.result === "通过") {
        const problem = await completionProblem(ctx, life, signal);
        if (problem) { record.result = "不通过"; record.detail = problem; record.failureKind = "unknown"; }
      }
      if (record.result === "通过") {
        await collectExperience(ctx, life, signal);
        const latestProblem = await completionProblem(ctx, life, signal);
        if (latestProblem) { await pause(ctx, latestProblem, life, undefined, undefined, undefined, signal); return; }
        state.phase = "done";
        state.awaitingRepair = false;
        state.pauseReason = undefined;
        state.pauseHint = undefined;
        saveState(life);
        // 落盘后先写一次「进行中」：这段取证窗口里来源被删能在写交付和总表前被看见。
        await writeSummary(ctx, "进行中", life, undefined, undefined, undefined, undefined, signal);
        // 发布前再核对一次来源，缺失就不写交付、不发 done。
        const sourceProblem = recordOutcome(ctx, life);
        if (sourceProblem) {
          await pause(ctx, sourceProblem, life, undefined, undefined, undefined, signal, "补齐 context.sources 登记的文件后再继续接力。");
          return;
        }
        await recordLedger(ctx, life);
        slimMaterials(ctx, life);
        // 状态和总表都落盘后再发布完成总结；外部只看总结判断终态，不能抢跑。
        await writeSummary(ctx, "完成", life, undefined, undefined, undefined, undefined, signal);
        reportStage(ctx, "done");
      } else if (record.failureKind === "product" && state.repairs < currentConfig(ctx).maxRepairs) {
        state.pendingAcceptanceCandidate = undefined;
        state.repairs += 1;
        state.phase = "idle";
        state.awaitingRepair = true;
        state.unresolvedAcceptance = `必需验收命令不通过：${record.command}\n${record.outputTail ?? record.detail ?? ""}`;
        saveState(life);
        const message = `【自动验收 · 第 ${state.repairs} 次返修】\n${state.unresolvedAcceptance}\n请按失败证据修复并定向自测，完整检查由程序执行。最后一行写【交付完成】。`;
        deliverRepair(ctx, message, life);
      } else {
        await pause(ctx, `必需验收命令${acceptRunLabel(record)}${record.failureKind ? `（${failureLabel(record.failureKind)}）` : ""}`,
          life, state.unresolvedMustFix, undefined, record.detail, signal, "保留候选与计数；处理阻塞后用 /accept 继续本段验收");
      }
    }
    const errors: string[] = [];
    try {
      saveState(life);
      if (record.mode === "advisory") slimMaterials(ctx, life);
    } catch (error) { errors.push(`状态保存失败：${errorText(error)}`); }
    try { updateStatus(ctx, life); } catch (error) { errors.push(`状态栏更新失败：${errorText(error)}`); }
    try { await rewriteSummary(ctx, life, signal); } catch (error) { errors.push(`总结写入失败：${errorText(error)}`); }
    if (!live(life, signal)) return;
    const hint = record.result === "中断" ? "，输入 /accept 重新执行" : `，详情见 ${summaryPath(ctx)}`;
    await notifyUser(
      ctx, `${basename(ctx.cwd)}：验收命令${acceptRunLabel(record)}${hint}${errors.length ? `；${errors.join("；")}` : ""}`,
      record.result === "通过" ? "info" : "warning", life, signal,
    );
  };

  /**
   * 执行验收命令：在项目目录用 /bin/sh -c 跑，退出码 0 为通过。
   * 不抛错，评审状态不受验收命令影响；会话关闭时直接返回，由关闭处理器记为中断。
   */
  const runAcceptCommand = async (ctx: ExtensionContext, task: ReviewTask, record: AcceptRunRecord, deadline = Date.now() + acceptTimeoutMs(), attempt = 1): Promise<void> => {
    const { lifecycle: life, controller } = task;
    const signal = controller.signal;
    if (!live(life, signal)) return;
    // 开始前的落盘失败不阻止执行，结束时会再写一次并在通知里报告。
    try { saveState(life); } catch { /* 见 finishAcceptRun */ }
    try { updateStatus(ctx, life); } catch { /* 见 finishAcceptRun */ }
    try { await rewriteSummary(ctx, life, signal); } catch { /* 见 finishAcceptRun */ }
    if (!live(life, signal)) return;
    const startedTs = Date.now();
    record.failureKind = undefined; record.detail = undefined;
    try {
      let res: ExecResult | undefined;
      let failure = "";
      let resource: RunResource | undefined;
      try {
        resource = createRunResource(`accept:${ctx.sessionManager.getSessionId()}:r${record.round}`, undefined, procsPath(ctx));
        res = await wrappedExec(ctx, life, signal)("/bin/sh", ["-c", managedShell(record.command, resource)], {
          cwd: ctx.cwd, timeout: Math.max(1, deadline - Date.now()), signal, role: "验收命令", env: methodEnv(state.baseline) });
      } catch (error) { failure = errorText(error); }
      finally {
        if (resource) { releaseRunResource(resource); record.cleanup = resourceLine(resource); }
      }
      if (!live(life, signal)) return;
      record.durationMs = Date.now() - startedTs;
      if (!res) {
        record.result = "无法执行";
        record.detail = tail(failure, 300);
        record.failureKind = "environment";
      } else {
        record.exitCode = res.code;
        record.result = res.killed ? "超时" : res.code === 0 ? "通过" : "不通过";
        if (res.killed) record.detail = `超过 ${Math.round(acceptTimeoutMs() / 60_000)} 分钟被终止`;
        const stderr = res.stderr.trim() ? `\n[stderr]\n${res.stderr.trimEnd()}` : "";
        record.outputTail = tailLines(`${res.stdout.trimEnd()}${stderr}`, ACCEPT_TAIL_LINES);
        if (res.code !== 0 || res.killed) record.failureKind = classifyFailure(res.code, `${res.stdout}\n${res.stderr}`, res.killed).kind;
        const logPath = join(dataDir(ctx), `accept-${ctx.sessionManager.getSessionId()}-r${record.round}.log`);
        try {
          mkdirSync(dirname(logPath), { recursive: true });
          (attempt === 1 ? writeFileSync : appendFileSync)(logPath, [`\n尝试 ${attempt}`, `$ ${record.command}`, `退出码：${res.code}${res.killed ? "（被终止）" : ""}`, "", "[stdout]", res.stdout, "[stderr]", res.stderr].join("\n"));
          record.logPath = logPath;
        } catch (error) {
          record.detail = [record.detail, `日志写入失败：${errorText(error)}`].filter(Boolean).join("；");
        }
      }
      if (resource?.status === "cleanup-failed") {
        record.result = "无法执行";
        record.failureKind = "environment";
        record.detail = `临时资源释放未确认：${resource.detail}`;
      }
    } catch (error) {
      if (!live(life, signal)) return;
      record.durationMs = Date.now() - startedTs;
      record.result = "无法执行";
      record.detail = tail(errorText(error), 300);
      record.failureKind = "unknown";
    }
    if (record.mode === "required" && record.result !== "通过" && ["environment", "method"].includes(record.failureKind ?? "")
      && Date.now() < deadline) {
      const config = loadPreparation(ctx.cwd);
      if (config) {
        const prepared = await runPreparation({ config, cwd: ctx.cwd, state, exec: wrappedExec(ctx, life, signal), signal, procsFile: procsPath(ctx),
          env: methodEnv(state.baseline),
          runDir: join(dataDir(ctx), "preparation", ctx.sessionManager.getSessionId()), saveState: () => saveState(life),
          failure: record.failureKind, evidence: record.outputTail ?? record.detail });
        checkLive(life, signal);
        if (prepared.ok && Date.now() < deadline) {
          // 恢复后用同一套来源豁免判定：只有已登记来源文件变化不拦重试；代码变化、缺失照旧。
          const git = evidence(ctx, life, signal);
          const candidate = await git.snapshot();
          checkLive(life, signal);
          const contextConfig = loadContext(ctx.cwd);
          const absorbed = contextConfig ? absorbSourceChanges(refreshContext(contextConfig)) : undefined;
          if (absorbed?.changed) saveState(life);
          if (absorbed?.problem) {
            record.result = "无法执行"; record.failureKind = "environment"; record.detail = absorbed.problem;
          } else {
            const before = state.lastSnapshotDetails;
            const sourcesOnly = contextConfig && candidate.fingerprint !== record.candidate && before
              ? await sourcesOnlyWorkspaceChange(git, before, candidate, (path) => isRegisteredSource(contextConfig!, ctx.cwd, path))
              : false;
            if (candidate.fingerprint === record.candidate || sourcesOnly) {
              record.result = "进行中"; saveState(life);
              return runAcceptCommand(ctx, task, record, deadline, attempt + 1);
            }
            record.detail = "恢复后候选发生变化，需要重新评审";
          }
        } else record.detail = prepared.reason ?? "验收恢复时间预算用完";
      }
    }
    await finishAcceptRun(ctx, record, life, signal);
  };

  /** 会话关闭或恢复时发现验收命令没跑完：记为中断，提示 /accept。 */
  const interruptAcceptRun = async (ctx: ExtensionContext, life: Lifecycle): Promise<void> => {
    const record = state.acceptRun;
    if (!record || record.result !== "进行中") return;
    record.result = "中断";
    record.detail = "会话关闭或重载，验收命令没有跑完";
    await finishAcceptRun(ctx, record, life);
  };

  /** 手动 /accept：独立任务，与评审互斥。 */
  const startAcceptRun = async (ctx: ExtensionContext): Promise<void> => {
    const life = lifecycle;
    if (!life.active || reviewRunning) return;
    if (acceptMode() === "required" && (!state.pendingAcceptanceCandidate || state.pendingAcceptanceInputs !== acceptanceInputs(ctx))) {
      ctx.ui.notify("还没有完成本候选的静态评审和配置验收，请先 /review；/accept 不能跳过必修。", "warning");
      return;
    }
    const completion = Promise.withResolvers<void>();
    const task: ReviewTask = { lifecycle: life, controller: new AbortController(), finished: completion.promise, finish: completion.resolve };
    activeTask = task;
    reviewRunning = true;
    try {
      if (acceptMode() === "required") {
        const problem = await completionProblem(ctx, life, task.controller.signal, false);
        if (problem) { await pause(ctx, problem, life, undefined, undefined, undefined, task.controller.signal); return; }
      }
      if (acceptMode() === "required") state.readyEpoch = randomUUID();
      state.acceptRun = newAcceptRun("command");
      if (state.acceptRun.mode === "required") {
        // 再次完成的验收要重新登记一段，不能沿用上一次的完成态。
        state.ledger = undefined;
        state.phase = "accepting";
        saveState(life);
        reportStage(ctx, "started");
      }
      await runAcceptCommand(ctx, task, state.acceptRun);
    } catch (error) {
      if (live(life, task.controller.signal)) await pauseForError(ctx, error, life, task.controller.signal);
    } finally {
      if (activeTask === task) {
        reviewRunning = false;
        activeTask = undefined;
      }
      task.finish();
    }
  };

  const collectExperience = async (ctx: ExtensionContext, life: Lifecycle, signal?: AbortSignal): Promise<void> => {
    await finishExperience({ cwd: ctx.cwd, session: ctx.sessionManager.getSessionId(), state, config: currentConfig(ctx),
      exec: wrappedExec(ctx, life, signal), signal, summary: summaryPath(ctx) });
    checkLive(life, signal);
  };

  const runReview = async (ctx: ExtensionContext, round: number, task: ReviewTask): Promise<void> => {
    const { lifecycle: life, controller } = task;
    const signal = controller.signal;
    const cwd = ctx.cwd;
    const usedConfig = currentConfig(ctx);
    const outcome = await runReviewRound({
      cwd, devSessionId: ctx.sessionManager.getSessionId(), round,
      deliveryNote: lastAssistantText(ctx.sessionManager.getEntries()),
      state, config: usedConfig, getConfig: () => currentConfig(ctx),
      exec: wrappedExec(ctx, life, signal),
      checkLive: () => checkLive(life, signal),
      onProgress: (text) => { if (live(life, signal)) ctx.ui.setStatus("autoreview", text); },
      writeInput: (name, text) => {
        const dir = dataDir(ctx);
        mkdirSync(dir, { recursive: true });
        const path = join(dir, name);
        writeFileSync(path, text);
        return path;
      },
      // 完成总结等状态和总表落盘后再写，避免外部把“总结已出现”当成终态抢先结束会话。
      writeSummary: (status) => writeSummary(ctx, status === "完成" ? "进行中" : status, life, undefined, undefined, undefined, undefined, signal),
      saveState: () => saveState(life),
      signal,
      acceptanceDir: join(dataDir(ctx), "acceptance", ctx.sessionManager.getSessionId()),
      procsFile: procsPath(ctx),
      cleanupExec: execOverride ?? createChildExec(`${procsPath(ctx)}.cleanup`),
      onCleanup: (work, path) => { cleanupWork = work; cleanupRecordPath = path; },
    });
    checkLive(life, signal);
    if (outcome.kind === "done") {
      state.awaitingRepair = false;
      state.awaitingInbox = undefined;
      // 评审完成必触发验收命令：「进行中」与完成一起保存，中途关闭也能在关闭或恢复时记为中断。
      state.readyEpoch = randomUUID();
      state.pendingAcceptanceCandidate = state.lastFingerprint;
      state.pendingAcceptanceInputs = acceptanceInputs(ctx, usedConfig);
      // 新一轮评审意味着要重新登记完成结果。
      state.ledger = undefined;
      const acceptRun = acceptCommand() ? newAcceptRun("auto") : undefined;
      state.acceptRun = acceptRun;
      if (acceptRun?.mode !== "required") await collectExperience(ctx, life, signal);
      state.phase = acceptRun?.mode === "required" ? "accepting" : "done";
      if (state.phase === "done") {
        const problem = await completionProblem(ctx, life, signal);
        if (problem) { await pause(ctx, problem, life, undefined, undefined, undefined, signal); return; }
      }
      saveState(life);
      updateStatus(ctx, life);
      if (state.phase === "done") {
        const sourceProblem = recordOutcome(ctx, life);
        if (sourceProblem) {
          await pause(ctx, sourceProblem, life, undefined, undefined, undefined, signal, "补齐 context.sources 登记的文件后再继续接力。");
          return;
        }
        await recordLedger(ctx, life);
        slimMaterials(ctx, life);
        await writeSummary(ctx, "完成", life, undefined, undefined, undefined, undefined, signal);
      }
      reportStage(ctx, state.phase === "done" ? "done" : "started");
      await notifyUser(
        ctx, `${basename(cwd)}：${state.phase === "accepting" ? "评审通过，等待本段必需验收" : `完成（评审 ${state.rounds.length} 次，返修 ${state.repairs} 次）`}${acceptRun ? "，开始执行验收命令" : ""}`,
        "info", life, signal, outcome.hint,
      );
      if (acceptRun) await runAcceptCommand(ctx, task, acceptRun);
      return;
    }
    if (outcome.kind === "paused") {
      await pause(ctx, outcome.reason!, life, state.unresolvedMustFix, outcome.changedFiles, outcome.notes, signal, outcome.hint);
      return;
    }
    // 后面的保存与消息交接是同步的，异步准备完成前不能提前解锁 phase。
    state.phase = "idle";
    saveState(life);
    updateStatus(ctx, life);
    const message = outcome.message!;
    deliverRepair(ctx, message, life);
  };

  /**
   * 流水线收件箱：编排程序把 e2e 没通过、归这一段的条目写进来，开发方空闲时发给它。
   * 发之前把评审起点重定到此刻，下一轮评审只看这次返修的改动（同一仓库里别的段的改动不算到这一段头上）；
   * 这些条目当作「上一轮必修」交给评审复查。
   */
  const checkInbox = async (): Promise<void> => {
    const link = pipelineLink;
    const ctx = latestCtx;
    const life = lifecycle;
    if (!link || !ctx || inboxBusy || !life.active || reviewRunning || state.phase === "reviewing" || gitAvailability !== "available") return;
    const inbox = readJson<InboxMessage>(inboxPath(link.dir, link.stage));
    if (!inbox || !(inbox.seq > (state.inboxHandled ?? 0)) || !ctx.isIdle()) return;
    inboxBusy = true;
    try {
      const snap = await evidence(ctx, life).snapshot();
      checkLive(life);
      state.lastSnapshot = snap.ref;
      state.lastUntracked = snap.untracked.map(({ path }) => path);
      // 同一 worktree 串行时，别的段已经交付的改动不算本段越界；只检查本次整合返修。
      state.scopeBaseline = snap.ref;
      state.scopeBaselineUntrackedDetails = snap.untracked.map((item) => ({ ...item }));
      state.lastFingerprint = snap.fingerprint;
      state.lastCheckedFingerprint = snap.fingerprint;
      state.unresolvedMustFix = inbox.mustFix;
      // 机器派发保留业务返修计数，只有用户明确接管才重置。
      state.pendingAcceptanceCandidate = undefined; state.readyEpoch = undefined;
      state.awaitingRepair = false;
      state.acceptRun = undefined; state.phase = "idle"; state.pauseReason = undefined; state.pauseHint = undefined;
      state.ledger = undefined;
      state.inboxHandled = inbox.seq;
      state.awaitingInbox = inbox.seq;
      saveState(life);
      updateStatus(ctx, life);
      if (!reportStage(ctx, "started")) throw new Error("无法撤销旧流水线完成状态");
      await writeSummary(ctx, "进行中", life, undefined, undefined, undefined, "收到整合返修，旧接力资格已撤销。");
      pi.sendUserMessage(inbox.message);
    } catch (error) {
      await pauseForError(ctx, error, life);
    } finally {
      inboxBusy = false;
    }
  };

  /** 整个后台入口都在 try 内；收尾没有能再次拒绝的副作用。 */
  const startReview = async (ctx: ExtensionContext, trigger: "auto" | "command"): Promise<void> => {
    const life = lifecycle;
    let task: ReviewTask | undefined;
    try {
      if (!life.active || (trigger === "auto" && (!state.enabled || gitAvailability !== "available"))) return;
      if (gitAvailability === "unsupported") { ctx.ui.notify(unavailableReason, "warning"); return; }
      if (reviewRunning || state.phase === "reviewing") {
        ctx.ui.notify("自动评审：已有评审或验收命令在进行", "warning");
        return;
      }
      const completion = Promise.withResolvers<void>();
      task = { lifecycle: life, controller: new AbortController(), finished: completion.promise, finish: completion.resolve };
      activeTask = task;
      reviewRunning = true;
      cleanupWork = undefined; cleanupRecordPath = undefined;
      if (trigger === "command" || (state.phase === "done" && state.awaitingInbox === undefined)) state.repairs = 0;
      const wasDone = state.phase === "done";
      state.needsInputReview = false; state.readyEpoch = undefined;
      state.phase = "reviewing";
      state.pauseReason = undefined;
      state.awaitingRepair = false;
      // 新一轮评审意味着代码可能变了，上一次验收命令结果不再对应当前代码。
      state.acceptRun = undefined;
      state.pendingAcceptanceCandidate = undefined;
      if (wasDone && !reportStage(ctx, "started")) throw new Error("无法撤销旧完成资格");
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
      task?.finish();
    }
  };

  pi.registerFlag("autoreview-max-repairs", { type: "string", default: String(DEFAULT_MAX_REPAIRS), description: "自动评审返修上限" });
  pi.registerFlag("autoreview-reviewer-model", { type: "string", default: DEFAULT_MODEL, description: "评审模型" });
  pi.registerFlag("autoreview-reviewer-thinking", { type: "string", default: DEFAULT_THINKING, description: "评审思考档位" });
  pi.registerFlag("autoreview-review-timeout-min", { type: "string", default: String(DEFAULT_TIMEOUT_MIN), description: "单次评审保护时长（分钟）" });
  pi.registerFlag("autoreview-reviewer-cmd", { type: "string", default: "", description: "仅测试：外部评审命令" });
  pi.registerFlag("autoreview-accept-cmd", { type: "string", default: "", description: "评审完成后执行的验收命令（在项目目录用 /bin/sh -c 执行，退出码 0 为通过）" });
  pi.registerFlag("autoreview-accept-mode", { type: "string", default: "required", description: "后置命令用途：required（默认，通过后才接力）或 advisory（只记录附加检查）" });
  pi.registerFlag("autoreview-accept-timeout-min", { type: "string", default: String(DEFAULT_ACCEPT_TIMEOUT_MIN), description: "验收命令时限（分钟）" });

  pi.registerCommand("review-inputs", {
    description: "查看来源版本；accept 显式接收当前资料版本（不修改业务标准或授权）",
    handler: async (args, ctx) => {
      if (reviewRunning) { ctx.ui.notify("检查正在进行，不能更换输入版本", "warning"); return; }
      const config = loadContext(ctx.cwd);
      if (!config) { ctx.ui.notify("没有配置 context.sources", "info"); return; }
      const result = refreshContext(config);
      const absorbed = absorbSourceChanges(result);
      if (args.trim() === "accept") {
        if (result.snapshot.missing.length) { ctx.ui.notify(`缺少来源：${result.snapshot.missing.join("、")}`, "warning"); return; }
        const resumed = Boolean(state.pauseReason?.startsWith("上游来源"));
        if (resumed) {
          state.phase = "idle"; state.pauseReason = undefined; state.pauseHint = undefined;
        }
        saveState(lifecycle);
        if (absorbed.changed || resumed) await rewriteSummary(ctx, lifecycle);
        ctx.ui.notify("已接收当前资料版本，业务返修计数保持不变；验收标准和授权仍以用户明确消息为准。输入 /review 继续检查。", "info");
      } else {
        // 已完成的会话之后来源变化：保持完成，只补记；缺失和配置移除照旧暂停。
        if (state.phase === "done" && absorbed.problem) await invalidateSources(ctx, lifecycle, absorbed.problem);
        else {
          if (absorbed.changed) saveState(lifecycle);
          // 变化可能已被会话恢复等路径吸收，只要记录里有变化就重写总结（幂等）。
          if (state.phase === "done" && (absorbed.changed || state.sourceChanges?.length || state.sourceChangeNote)) await rewriteSummary(ctx, lifecycle);
        }
        ctx.ui.notify(`${result.path}\n来源第 ${result.snapshot.revision} 版；${result.snapshot.missing.length ? `缺少来源：${result.snapshot.missing.join("、")}` : "内容变化自动采用新版本，开发与评审照常继续"}`, "info");
      }
    },
  });

  pi.registerCommand("review", {
    description: "立即评审当前改动（返修计数重新算）",
    handler: async (_args, ctx) => {
      if (!lifecycle.active) return;
      if (gitAvailability === "unsupported") { ctx.ui.notify(unavailableReason, "warning"); return; }
      if (reviewRunning || state.phase === "reviewing") { ctx.ui.notify("自动评审：已有评审或验收命令在进行", "warning"); return; }
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
      if (reviewRunning || state.phase === "reviewing") { ctx.ui.notify("自动评审：已有评审或验收命令在进行", "warning"); return; }
      if (!ctx.isIdle()) { ctx.ui.notify("自动评审：开发方正在运行，等停下来再执行验收命令", "warning"); return; }
      void startAcceptRun(ctx);
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
        : state.phase === "done" ? "完成" : state.phase === "accepting" ? "必需验收中" : state.needsInputReview ? "待按新输入检查" : "空闲";
      ctx.ui.notify([
        `自动评审：${state.enabled ? "开启" : "关闭"}`, `状态：${phase}`,
        `评审 ${state.rounds.length} 次，返修 ${state.repairs} 次`,
        `验收命令：${state.acceptRun ? acceptRunLabel(state.acceptRun) : acceptCommand() ? "未执行" : "未配置"}`,
        `门禁：${gateCommand(ctx) ?? "未配置"}`,
        `评审会话：${state.reviewerSessionId ?? deriveReviewerSessionId(devSessionId)}`, `总结：${summaryPath(ctx)}`,
        `自动验收：${!acceptanceEnabled(ctx) ? "未配置" : state.criteria
          ? `标准第 ${state.criteria.version} 版（${state.criteria.items.length} 条，${state.criteria.source === "用户" ? "你写的" : "自动起草"}）`
          : "还没有标准（需求里没有「## 验收标准」时，第一次验收前自动起草）"}`,
        ...(state.criteria && authorizationLine(state.criteria, state.grants) ? [`授权：${authorizationLine(state.criteria, state.grants)}`] : []),
      ].join("\n"), "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const life: Lifecycle = { active: true };
    lifecycle = life;
    state = newReviewState();
    gitAvailability = "unknown";
    reviewRunning = false;
    developerRunning = false;
    activeTask = undefined;
    cleanupWork = undefined; cleanupRecordPath = undefined;
    latestCtx = ctx;
    pipelineLink = stageFromEnv(process.env);
    trackExperienceSession(ctx, true);
    checkPonytail(ctx);
    if (inboxTimer) clearInterval(inboxTimer);
    if (contextTimer) clearInterval(contextTimer);
    inboxTimer = undefined;
    try {
      // 上次 pi 进程异常退出时留下的被测系统（登记者已死）先清掉。
      reapProcs(procsPath(ctx));
      reapProcs(`${procsPath(ctx)}.cleanup`);
      reapRunResources();
      const contextConfig = loadContext(ctx.cwd);
      if (contextConfig?.intervalSec) {
        let checking = false;
        contextTimer = setInterval(() => {
          if (checking || !life.active) return;
          checking = true;
          void (async () => {
            let problem: string | undefined;
            try {
              // 配置被移除也是配置错误，照旧暂停；只有内容变化自动换版本。
              const latest = loadContext(ctx.cwd);
              if (!latest) problem = state.inputsFingerprint ? "上游来源配置已移除，需要重新确认输入" : undefined;
              else {
                const absorbed = absorbSourceChanges(refreshContext(latest));
                problem = absorbed.problem;
                if (absorbed.changed) {
                  saveState(life);
                  // 已完成的会话保持完成，只把变化补进总结；进行中的评审会随本轮总结一起写。
                  if (state.phase === "done") await rewriteSummary(ctx, life);
                }
              }
              reapRunResources();
            } catch (error) { problem = `上游来源无法核对：${errorText(error)}`; }
            if (problem && (state.phase === "done" || reviewRunning)) await invalidateSources(ctx, life, problem);
          })().catch((error) => { if (life.active) ctx.ui.notify(`来源巡检：${errorText(error)}`, "warning"); }).finally(() => { checking = false; });
        }, contextConfig.intervalSec * 1000);
        contextTimer.unref?.();
      }
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
      // 上次进程没走到关闭处理器（崩溃、强杀）时，验收命令仍是「进行中」。
      if (state.acceptRun?.result === "进行中") await interruptAcceptRun(ctx, life);
      else if (state.phase === "accepting") await pause(ctx, "必需验收尚未确认完成", life);
      else if (state.acceptRun?.result === "中断") ctx.ui.notify("自动评审：上次验收命令被中断，输入 /accept 重新执行", "info");
      checkLive(life);
      if (state.phase === "done" && state.awaitingInbox === undefined) {
        const beforeSources = state.inputsFingerprint;
        const problem = await completionProblem(ctx, life);
        if (problem) await pause(ctx, `恢复完成依据失效：${problem}`, life, undefined, undefined, undefined, undefined, "保留计数和成果，重新评审后再继续接力。");
        else {
          // 完成的会话之后来源变化：保持完成，只把变化补进总结。
          if (beforeSources !== state.inputsFingerprint) await writeSummary(ctx, "完成", life);
          // 总结处理结束后、发布 done 前再核对一次：这段异步窗口里来源可能被删。
          const finalProblem = checkPublishSources(ctx, life).problem;
          if (finalProblem) await pause(ctx, `恢复完成依据失效：${finalProblem}`, life, undefined, undefined, undefined, undefined, "补齐 context.sources 登记的文件后再继续接力。");
          else {
            // 本进程没登记过这个完成态（重启、进程异常退出后的恢复）：核对通过后补写一段。
            if (!state.ledger || state.ledger.session !== ctx.sessionManager.getSessionId()) await recordLedger(ctx, life);
            if (!state.materialCleanup) slimMaterials(ctx, life);
            // 状态与总表都确认后再发布完成总结。
            await writeSummary(ctx, "完成", life);
          }
        }
      }
      // 流水线里的段：报一次当前状态（重开的会话如果已经完成或暂停，就照实报；e2e 返修还没处理完时只报 started，
      // 免得编排程序误以为已经修好），开始看收件箱。
      if (pipelineLink) {
        const event = state.awaitingInbox !== undefined ? "started" : state.phase === "done" ? "done" : state.phase === "paused" ? "paused" : "started";
        reportStage(ctx, event, { pauseReason: state.pauseReason });
        inboxTimer = setInterval(() => void checkInbox(), pollMs());
        inboxTimer.unref?.();
      }
      if (state.phase === "paused") {
        ctx.ui.notify(`自动评审：上次暂停（${state.pauseReason ?? "未知原因"}），给开发方发消息继续干活即恢复自动评审，或输入 /review 立即评审`, "info");
      }
      // 开了验收但项目里没有（或是旧版）验收标准写法：每个会话提醒一次「复制【块 1】到哪」。
      if (!state.conventionNoticed) {
        let notice: string | undefined;
        try {
          const acceptance = acceptanceConfig(ctx);
          notice = acceptance ? conventionNotice(acceptance.root, "pi") : undefined;
        } catch { notice = undefined; }
        if (notice) {
          ctx.ui.notify(notice, "info");
          state.conventionNoticed = true;
          saveState(life);
        }
      }
      trackExperienceSession(ctx, developerRunning || state.phase !== "done");
    } catch (error) { await pauseForError(ctx, error, life); }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (inboxTimer) clearInterval(inboxTimer);
    if (contextTimer) clearInterval(contextTimer);
    inboxTimer = undefined;
    if (!lifecycle.active) return;
    const interrupted = state.phase === "reviewing";
    const accepting = state.acceptRun?.result === "进行中";
    lifecycle.active = false;
    developerRunning = false;
    activeTask?.controller.abort();
    activeTask = undefined;
    reviewRunning = false;
    // abort 后的异步关停未必来得及跑完：同步杀掉本进程登记的被测系统。
    try { reapProcs(procsPath(ctx), { ownerPid: process.pid }); } catch { /* 尽力 */ }
    // 等实际的资源收尾完成；普通评审取消没有此等待。清理命令自身有独立超时。
    if (cleanupWork) await cleanupWork;
    trackExperienceSession(ctx, false);
    if (!interrupted && !accepting) return;
    // 旧任务已失效；只有 shutdown 本身能在处理函数返回前使用仍有效的上下文。
    const cleanup: Lifecycle = { active: true };
    try {
      const released = cleanupRecordPath ? readJson<{ status: string; reason?: string }>(cleanupRecordPath) : undefined;
      const cleanupNote = cleanupRecordPath ? `外部资源释放：${released?.status ?? "未确认"}；记录：${cleanupRecordPath}${released?.reason ? `；${released.reason}` : ""}` : undefined;
      if (interrupted) await pause(ctx, INTERRUPTED, cleanup, undefined, undefined, cleanupNote);
      else await interruptAcceptRun(ctx, cleanup);
    } finally { cleanup.active = false; }
  });

  // 原生 input 事件保留来源，发生在技能/模板展开之前；扩展消息不能产生用户权限。
  pi.on("input", async (event, ctx) => {
    const life = lifecycle;
    if (!life.active || !["interactive", "rpc"].includes(event.source) || isLoopMessage(event.text)) return { action: "continue" as const };
    latestCtx = ctx;
    const before = JSON.stringify([state.requirement, state.criteria, state.grants]);
    const hadReview = state.rounds.length > 0 || state.phase === "done" || reviewRunning;
    try {
      developerRunning = true;
      if (state.phase === "paused" && gitAvailability !== "unsupported") {
        const reason = state.pauseReason;
        state.phase = "idle"; state.pauseReason = undefined; state.pauseHint = undefined; state.awaitingRepair = false; state.repairs = 0;
        ctx.ui.notify(`自动评审：已恢复（上次暂停：${reason ?? "未知原因"}）`, "info");
      }
      const prompt = event.text.includes('<file name="') ? event.text : expandFileRefs(event.text, ctx.cwd);
      if (state.requirement === undefined && prompt.trim()) state.requirement = prompt;
      const criteria = criteriaFromUser(prompt, state.criteria);
      if (criteria) { state.criteria = criteria; state.grants = undefined; }
      const grants = grantsFromUser(typedByUser(event.text), state.criteria, state.grants);
      if (grants) state.grants = grants;
      if (hadReview && before !== JSON.stringify([state.requirement, state.criteria, state.grants])) await invalidateCompletion(ctx, life);
      else { saveState(life); updateStatus(ctx, life); }
      if (criteria) ctx.ui.notify(`自动验收：已记录验收标准第 ${criteria.version} 版（${criteria.items.length} 条）`, "info");
      if (grants && state.criteria) ctx.ui.notify(`自动验收：已记录你的授权（${authorizationLine(state.criteria, grants) ?? "标准里没有对应的条目"}）`, "info");
      return { action: "continue" as const };
    } catch (error) {
      activeTask?.controller.abort();
      await pauseForError(ctx, error, life);
      return { action: "handled" as const };
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    latestCtx = ctx;
    const life = lifecycle;
    if (!life.active) return;
    // Pi 1.2 的插件消息没有 prompt，不能当成用户接管、需求或授权。
    const prompt = event.messageType === "custom" || isLoopMessage(event.prompt ?? "") ? undefined : event.prompt;
    // 来源内容变化不再撤销完成资格，这里只比较用户输入（需求、标准、授权）。
    const previousInputs = JSON.stringify([state.requirement, state.criteria, state.grants]);
    const hadReview = state.rounds.length > 0 || state.phase === "done" || reviewRunning;
    try {
      checkLive(life);
      developerRunning = true;
      trackExperienceSession(ctx, true);
      if (gitAvailability === "unsupported") return;
      // 上次 git 探测异常（不是明确的非 git）时重新探测；仍失败照旧暂停。
      if (gitAvailability === "unknown" && (reviewRunning || !await probeRepository(ctx, life))) return;
      const contextConfig = loadContext(ctx.cwd);
      if (state.enabled && contextConfig) {
        const context = refreshContext(contextConfig, prompt ?? `${state.requirement ?? ""} ${state.unresolvedMustFix ?? ""}`);
        const absorbed = absorbSourceChanges(context);
        if (absorbed.problem) {
          await pause(ctx, absorbed.problem, life);
          ctx.abort();
          return;
        }
        if (absorbed.changed) saveState(life);
        event.systemPromptOptions.sections ??= {};
        event.systemPromptOptions.sections.autoreview_context = context.text;
      }
      if (state.baseline === undefined) {
        const snap = await evidence(ctx, life).snapshot();
        checkLive(life);
        // 流水线在准备前已经确定开工依据并传进来；会话不能另取一次 stash，否则准备和门禁会不同。
        const inherited = process.env.AUTOREVIEW_PIPELINE_LAUNCH === "1" ? process.env.AUTOREVIEW_BASE_REV?.trim() : undefined;
        state.baseline = inherited || snap.ref;
        state.baselineUntracked = snap.untracked.map(({ path }) => path);
        state.baselineUntrackedDetails = snap.untracked.map((item) => ({ ...item }));
        state.baselineFingerprint = snap.fingerprint;
        saveState(life);
      }
      if (state.enabled && prompt !== undefined) {
        const preparation = loadPreparation(ctx.cwd);
        if (preparation) {
          const result = await runPreparation({ config: preparation, cwd: ctx.cwd, state,
            env: methodEnv(state.baseline),
            exec: wrappedExec(ctx, life), procsFile: procsPath(ctx), runDir: join(dataDir(ctx), "preparation", ctx.sessionManager.getSessionId()),
            saveState: () => saveState(life), onProgress: (text) => ctx.ui.notify(text, "info") });
          checkLive(life);
          if (!result.ok) {
            await pause(ctx, `开发前准备未通过：${result.reason}`, life);
            ctx.abort();
            return;
          }
        }
        if (contextConfig) {
          // 准备期间来源变化同样不暂停：更新记录的版本，下一轮用新来源。
          const latest = absorbSourceChanges(refreshContext(contextConfig));
          if (latest.problem) {
            await pause(ctx, latest.problem, life);
            ctx.abort();
            return;
          }
          if (latest.changed) saveState(life);
        }
      }
      if (prompt !== undefined && hadReview && !state.needsInputReview && previousInputs !== JSON.stringify([state.requirement, state.criteria, state.grants])) await invalidateCompletion(ctx, life);
      const acceptance = acceptanceEnabled(ctx);
      if (state.enabled) {
        const convention = conventionText({ acceptance, gate: gateCommand(ctx), experience: experienceInjection(ctx.cwd) });
        const existing = event.systemPromptOptions.appendSystemPrompt ?? "";
        event.systemPromptOptions.appendSystemPrompt = existing ? `${existing}\n\n${convention}` : convention;
      }
    } catch (error) { await pauseForError(ctx, error, life); ctx.abort(); }
  });

  pi.on("agent_settled", async (_event, ctx) => {
    latestCtx = ctx;
    const life = lifecycle;
    developerRunning = false;
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
      if (state.needsInputReview) { if (state.enabled) void startReview(ctx, "auto"); return; }
      // 流水线 e2e 返修：有改动就评审（不看标记）；没改代码多半是认为不归自己，报给编排程序（它会找你），不评审。
      if (state.awaitingInbox !== undefined) {
        const current = await evidence(ctx, life).snapshot();
        checkLive(life);
        if (current.fingerprint !== checkedFingerprint(state)) {
          if (state.enabled) void startReview(ctx, "auto");
          return;
        }
        state.awaitingInbox = undefined;
        saveState(life);
        reportStage(ctx, "no-change", { reply: lastAssistantText(ctx.sessionManager.getEntries()) });
        return;
      }
      if (marker === "none") {
        const baseline = checkedFingerprint(state);
        if (!state.enabled || !baseline) return;
        const current = await evidence(ctx, life).snapshot();
        checkLive(life);
        if (current.fingerprint === baseline) {
          if (state.awaitingRepair) await pause(ctx, "返修后没有任何改动", life);
          else if (state.phase === "done") trackExperienceSession(ctx, false);
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
