/**
 * Pi 单会话静态评审扩展：交付触发独立评审，必修回送原开发会话；不编排验收或发布。
 * 失败调用不推进成功检查点；git 取证失败或指纹变化只暂停；暂停后你再让开发方干活即恢复自动评审。
 * 加载：pi -e /Users/Admin/Desktop/loop/autoreview.ts
 */
import { createHash, randomUUID } from "node:crypto";
import kernelPi from "./kernel-pi.ts";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { authorizationLine, criteriaFromUser, grantsFromUser, isLoopMessage, typedByUser } from "./acceptance-core.ts";
import { ACCEPT_COMMAND_MIGRATION as ACCEPT_MIGRATION, LOOP_TEST_STATUS, captureProjectConfigOverrides, findProjectRoot, resolveProjectConfig } from "./config.ts";
import {
  classifyMarker, conventionText, deriveReviewerSessionId, renderSummary,
} from "./core.ts";
import { createGitEvidence, GitReadError, type Exec } from "./git.ts";
import { acceptanceTodos } from "./onboarding.ts";
import { auditLoopConfig, loopConfigMark } from "./config-audit.ts";
import { developerQuestion, pauseAction, pauseText, preservePause } from "./blockers.ts";
import { productionAction } from "./production-loop.ts";
import { experienceInjection, experienceSession, experienceTodos } from "./experience.ts";
import { finishExperience } from "./experience-draft.ts";
import {
  completionChecks, pollMs, queueAcceptance, stageFromEnv, statusPath, writeStageStatus,
  type StageEvent, type StageLink,
} from "./pipeline-core.ts";
import { processStartTime, reapProcs } from "./procs.ts";
import type { FailureKind } from "./failure.ts";
import { batchInfo, observeStage } from "./events.ts";
import { consumeRelay } from "./pa.ts";
import { hasRelayHeader, rememberPAInput, relayMessage, wordRecords } from "./pa-records.ts";
import { systemNotify } from "./notify.ts";
import { runPreparation } from "./preparation.ts";
import { methodEnv } from "./method-env.ts";
import { createChildExec, expandFileRefs } from "./hosts/review-hook.ts";
import { ReviewerCallFailure } from "./static-review.ts";
import { appendLedgerRecord, appendPARelayRecord, deliveryLedgerPath, pendingItems, projectRootOf, resultLine, taskTitle, type PendingItem } from "./ledger.ts";
import { reapRunResources } from "./resources.ts";
import { materialSession, recordMaterialSession, slimCompletedSession } from "./materials.ts";
import { isRegisteredSource, recordProjectOutcome, recordSourceChange, refreshContext, type ContextConfig, type ContextResult } from "./project-context.ts";
import {
  INTERRUPTED,
  checkedFingerprint, errorText, lastAcceptance, newReviewState, runReviewRound, sourcesOnlyWorkspaceChange,
  type ReviewConfig, type ReviewState,
} from "./review.ts";

interface Lifecycle { active: boolean }
interface ReviewTask { lifecycle: Lifecycle; controller: AbortController; finished: Promise<void>; finish: () => void }
/** 单会话完成依据与交付索引；旧自动验收/队列状态不参与执行。 */
type LedgerState = { session: string; path: string; pending: PendingItem[]; failed?: boolean };
type PiState = ReviewState & { needsInputReview?: boolean; readyEpoch?: string; pendingAcceptanceCandidate?: string; pendingAcceptanceInputs?: string; ledger?: LedgerState };

function flagString(pi: ExtensionAPI, name: string, fallback: string): string {
  const value = pi.getFlag(name);
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
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
  // 问题单归档属于共用服务，新卡与旧单会话均保留，不依赖评审节点内部状态。
  pi.on("tool_result", async (event, ctx) => {
    if (event.isError || !["write", "edit"].includes(event.toolName)) return;
    const touched = { paths: typeof event.input.path === "string" ? [event.input.path] : [] };
    const roots = [...new Set(productionAction(touched, ctx.cwd)?.files.filter((file) => file.kind === "issue").map((file) => file.root) ?? [])];
    if (!roots.length) return;
    const { archiveResolvedIssues } = await import("./issue-archive.ts");
    const lines = roots.flatMap((root) => archiveResolvedIssues(root, false, touched.paths.map((path) => resolve(ctx.cwd, path))).lines);
    if (lines.length) return { content: [...event.content, { type: "text" as const, text: lines.join("\n") }] };
  });
  // 新卡与单会话都只给旧参数/命令迁移说明，没有执行器或完成门槛。
  for (const name of ["autoreview-accept-cmd", "autoreview-accept-mode", "autoreview-accept-timeout-min"]) pi.registerFlag(name, { type: "string", default: "", description: ACCEPT_MIGRATION });
  pi.registerCommand("accept", { description: ACCEPT_MIGRATION, handler: async (_args, ctx) => { ctx.ui.notify(ACCEPT_MIGRATION, "warning"); } });
  if (process.env.AUTOREVIEW_KERNEL_LEDGER) { kernelPi(pi, execOverride); return; }
  let state: PiState = newReviewState();
  const experienceOwner = randomUUID();
  const trackExperienceSession = (ctx: ExtensionContext, active: boolean): void =>
    experienceSession(ctx.cwd, `pi:${ctx.sessionManager.getSessionId()}:${process.pid}:${experienceOwner}`, active);
  let gitAvailability: "unknown" | "available" | "unsupported" = "unknown";
  let unavailableReason = "不是 git 仓库，自动评审已关闭";
  /** 当前静态评审在跑，期间不重复调用。 */
  let reviewRunning = false;
  /** 当前开发回合独立于上一次评审完成态；普通追加消息也可能继续编辑。 */
  let developerRunning = false;
  let lifecycle: Lifecycle = { active: true };
  let activeTask: ReviewTask | undefined;
  /** 由流水线启动时：属于哪个流水线目录、哪一段；收件箱轮询用的最近一次上下文。 */
  let pipelineLink: StageLink | undefined;
  let inboxTimer: ReturnType<typeof setInterval> | undefined;
  let contextTimer: ReturnType<typeof setInterval> | undefined;
  const wordsDispatched = new Set<string>();
  let verifiedRelayPrompt: string | undefined;
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
    try { checkLive(life, signal); }
    catch (error) { throw new ReviewerCallFailure(error, true, false); } // 尚未调用执行器，没有新消费者。
    const res = await (execOverride ?? createChildExec(procsPath(ctx)))(cmd, args, options);
    try { checkLive(life, signal); }
    catch (error) {
      // 撤销旧结论不能丢掉真实释放事实；缺失/否定的证明仍按未知保留，取消不自动重试。
      throw new ReviewerCallFailure(error, res.processesReleased === true, false);
    }
    return res;
  };
  const evidence = (ctx: ExtensionContext, life: Lifecycle, signal?: AbortSignal) =>
    createGitEvidence(wrappedExec(ctx, life, signal), ctx.cwd, signal);
  const dataDir = (ctx: ExtensionContext): string => join(homedir(), ".pi-autoreview", basename(ctx.cwd));
  const summaryPath = (ctx: ExtensionContext): string => join(dataDir(ctx), `${ctx.sessionManager.getSessionId()}.md`);
  const procsPath = (ctx: ExtensionContext): string => join(dataDir(ctx), `${ctx.sessionManager.getSessionId()}.procs.json`);
  const saveState = (life: Lifecycle): void => {
    checkLive(life);
    if (state.phase !== "done") state.materialCleanup = undefined;
    pi.appendEntry("autoreview-state", state);
    if (latestCtx) {
      trackExperienceSession(latestCtx, lifecycle.active && (developerRunning || state.phase !== "done"));
      recordMaterialSession(sessionMaterials(latestCtx));
      if (state.phase === "reviewing") observe(latestCtx, "reviewing");
    }
  };
  const sessionMaterials = (ctx: ExtensionContext) => materialSession(ctx.sessionManager.getSessionId(), ctx.cwd, summaryPath(ctx), state.phase,
    state.rounds.flatMap((round) => round.acceptance ? [round.acceptance.runDir] : []));
  const slimMaterials = (ctx: ExtensionContext, life: Lifecycle): void => {
    if (sessionMaterials(ctx).phase !== "done") return;
    state.materialCleanup = slimCompletedSession(sessionMaterials(ctx));
    saveState(life);
  };
  const observe = (ctx: ExtensionContext, phase: "running" | "reviewing" | "paused" | "done", extra: { via?: "user" | "auto"; replay?: boolean } = {}): void => {
    const id = ctx.sessionManager.getSessionId();
    observeStage({ cwd: ctx.cwd, summary: summaryPath(ctx), state, phase, reason: phase === "paused" ? state.pauseReason : undefined,
      failureKind: phase === "paused" ? state.pauseFailureKind : undefined, question: lastAssistantText(ctx.sessionManager.getEntries()),
      session: { host: "pi", id, pid: process.pid, processStarted: processStartTime(process.pid),
        ...(process.env.PI_SESSION_ID === id && process.env.PI_SESSION_FILE ? { log: process.env.PI_SESSION_FILE } : {}) }, ...extra });
  };
  /** 流水线里的段：把完成、暂停、返修后没改动写进状态文件，编排程序据此接力。写失败不影响评审。 */
  const reportStage = (ctx: ExtensionContext, event: StageEvent, extra: { pauseReason?: string; reply?: string } = {}, replay = false): boolean => {
    observe(ctx, event === "done" ? "done" : event === "paused" ? "paused" : "running", { replay });
    if (!pipelineLink) return true;
    try {
      const status = {
        sessionId: ctx.sessionManager.getSessionId(), host: "pi", pid: process.pid, processStarted: processStartTime(process.pid),
        summary: summaryPath(ctx), event, configOverrides: captureProjectConfigOverrides(projectOverrides()), ...(event === "done" ? { readyEpoch: state.readyEpoch, candidate: state.lastSnapshotDetails, checks: completionChecks(state.rounds.at(-1)), sourceInputs: state.inputsFingerprint, acceptance: queueAcceptance() } : {}), inbox: 0, ...extra,
      };
      writeStageStatus(pipelineLink, status);
      return true;
    } catch (error) {
      if (event === "done") throw error;
      // 不能写入失效状态时，也不能留下旧的 done 供消费者接力。
      try { rmSync(statusPath(pipelineLink.dir, pipelineLink.stage), { force: true }); } catch { /* 调用方仍收到失败 */ }
      return false;
    }
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
  /** detail 只显示在 pi 界面里（下一步怎么做），系统通知保持简短。 */
  const notifyUser = async (
    ctx: ExtensionContext, body: string, type: "info" | "warning", life: Lifecycle, signal?: AbortSignal, detail?: string,
  ): Promise<void> => {
    if (!live(life, signal)) return;
    body += `\n测试：${LOOP_TEST_STATUS}`;
    try { ctx.ui.notify(detail ? `${body}\n${detail}` : body, type); } catch { /* 无 UI 时仍尝试系统通知 */ }
    if (!live(life, signal)) return;
    await systemNotify("自动评审", body, { exec: (cmd, args, options) => pi.exec(cmd, args, options), signal });
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
    const todos = acceptanceTodos({
      acceptance: undefined, host: "pi", phase: state.phase, pauseHint: state.pauseHint,
      criteria: state.criteria, lastAcceptance: lastAcceptance(state),
    });
    if (status === "完成") todos.push(...experienceTodos(ctx.cwd, state.experienceDraft?.error));
    const text = renderSummary({
      singleNode: true, acceptanceConfigured: false,
      cwd: ctx.cwd, devSessionId,
      reviewerSessionId: state.reviewerSessionId ?? deriveReviewerSessionId(devSessionId),
      status, pauseReason, rounds: state.rounds, repairs: state.repairs,
      unresolvedMustFix, changedFiles, gitStatusShort, notes,
      criteria: state.criteria, grants: state.grants, paRelays: state.paRelays, todos, newCommits,
      sourceChanges: state.sourceChanges, sourceChangeNote: state.sourceChangeNote,
      loopConfigChanges: state.loopConfigChanges, pauseDetail: state.pauseDetail, blockerHistory: state.blockerHistory,
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
    unresolvedMustFix = state.unresolvedMustFix, changedFiles?: string[], notes?: string, signal?: AbortSignal, hint?: string, failureKind?: FailureKind,
  ): Promise<void> => {
    if (!live(life, signal)) return;
    state.phase = "paused";
    state.pauseReason = reason;
    state.pauseFailureKind = failureKind;
    state.pauseHint = hint ?? pauseAction(reason);
    state.pauseDetail = { reason, ...(notes ? { error: notes } : {}), question: developerQuestion(lastAssistantText(ctx.sessionManager.getEntries())), action: state.pauseHint };
    state.unresolvedMustFix = unresolvedMustFix;
    state.awaitingRepair = false;
    const errors: string[] = [];
    try {
      auditLoopConfig(state, ctx.cwd);
      const path = preservePause(dataDir(ctx), state.pauseDetail);
      state.pauseDetail.evidence = path;
      (state.blockerHistory ??= []).push(path);
    } catch (error) { errors.push(`暂停原文保存失败：${errorText(error)}`); }
    try { saveState(life); } catch (error) { errors.push(`状态保存失败：${errorText(error)}`); }
    reportStage(ctx, "paused", { pauseReason: reason });
    try { updateStatus(ctx, life); } catch (error) { errors.push(`状态栏更新失败：${errorText(error)}`); }
    try {
      await writeSummary(ctx, "暂停", life, reason, unresolvedMustFix, changedFiles, notes, signal);
    } catch (error) { errors.push(`总结写入失败：${errorText(error)}`); }
    if (!live(life, signal)) return;
    await notifyUser(ctx, `${basename(ctx.cwd)}：暂停（${reason}）${errors.length ? `；${errors.join("；")}` : ""}\n${pauseText(state.pauseDetail)}`, "warning", life, signal);
  };
  const pauseForError = async (ctx: ExtensionContext, error: unknown, life: Lifecycle, signal?: AbortSignal): Promise<void> => {
    if (!live(life, signal)) return;
    const reason = error instanceof GitReadError ? error.message : "评审失败";
    await pause(ctx, reason, life, state.unresolvedMustFix, undefined, `扩展内部错误：${error instanceof Error ? error.stack ?? error.message : String(error)}`, signal, pauseAction("内部错误"));
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

  const projectOverrides = () => ({
    maxRepairs: flagString(pi, "autoreview-max-repairs", ""),
    reviewerModel: flagString(pi, "autoreview-reviewer-model", ""),
    reviewerThinking: flagString(pi, "autoreview-reviewer-thinking", ""),
    reviewTimeoutMin: flagString(pi, "autoreview-review-timeout-min", ""),
    reviewerCmd: flagString(pi, "autoreview-reviewer-cmd", ""),
  });
  const projectConfig = (ctx: Pick<ExtensionContext, "cwd">) => resolveProjectConfig(findProjectRoot(ctx.cwd), projectOverrides());
  const loadContext = (cwd: string) => projectConfig({ cwd }).context;
  const loadPreparation = (cwd: string) => projectConfig({ cwd }).preparation;
  const currentConfig = (ctx: ExtensionContext): ReviewConfig => {
    const { raw, effectiveConfig, methods, context, ...config } = projectConfig(ctx);
    return config;
  };

  // 完成依据只绑定本次静态评审输入，不含废弃命令/模式。
  const acceptanceInputs = (ctx: ExtensionContext, config = currentConfig(ctx)): string => createHash("sha256").update(JSON.stringify({
    requirement: state.requirement, criteria: state.criteria, grants: state.grants, config,
  })).digest("hex");

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
      summary: summaryPath(ctx), checks: { ...completionChecks(state.rounds.at(-1)), test: "没验证（本次未安排）", acceptance: "没验证（本次未安排）" }, pending, paRelays: state.paRelays,
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
  const completionProblem = async (ctx: ExtensionContext, life: Lifecycle, signal?: AbortSignal): Promise<string | undefined> => {
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
      // 按冻结的 Git 规范化哈希比较，允许仅提交；原未跟踪文件仍核对原始字节和模式，
      // 不能让 clean/EOL 转换掩盖评审之后的真实改动。
      let sameContent = false;
      if (before && !sameContent) {
        try { sameContent = await git.sameContent(before, candidate); }
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
    return undefined;
  };

  /** 输入、来源或状态变化时重写同一份总结。 */
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
    state.pendingAcceptanceCandidate = undefined; state.pendingAcceptanceInputs = undefined; state.readyEpoch = undefined;
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
      observe(ctx, "running");
      if (ctx.isIdle()) pi.sendUserMessage(message);
      else pi.sendUserMessage(message, { deliverAs: "followUp" });
    }).catch((error) => { if (live(life)) void pauseForError(ctx, error, life); });
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
      snapshotDir: join(dataDir(ctx), "review-snapshots"),
      procsFile: procsPath(ctx),
    });
    checkLive(life, signal);
    if (outcome.kind === "done") {
      state.awaitingRepair = false;
      // 完成依据绑定当前静态评审候选和输入。
      state.readyEpoch = randomUUID();
      state.pendingAcceptanceCandidate = state.lastFingerprint;
      state.pendingAcceptanceInputs = acceptanceInputs(ctx, usedConfig);
      // 新一轮评审意味着要重新登记完成结果。
      state.ledger = undefined;
      await collectExperience(ctx, life, signal);
      state.phase = "done";
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
      reportStage(ctx, "done");
      await notifyUser(ctx, `${basename(cwd)}：完成（评审 ${state.rounds.length} 次，返修 ${state.repairs} 次）\n交付报告：${summaryPath(ctx)}`, "info", life, signal, outcome.hint);
      return;
    }
    if (outcome.kind === "paused") {
      await pause(ctx, outcome.reason!, life, state.unresolvedMustFix, outcome.changedFiles, outcome.notes, signal, outcome.hint, outcome.failureKind);
      return;
    }
    // 后面的保存与消息交接是同步的，异步准备完成前不能提前解锁 phase。
    state.phase = "idle";
    saveState(life);
    updateStatus(ctx, life);
    const message = outcome.message!;
    deliverRepair(ctx, message, life);
  };

  /** 仅投递有原会话身份的 PA 用户原话；旧机器返修收件箱不再执行。 */
  const checkInbox = async (): Promise<void> => {
    const link = pipelineLink;
    const ctx = latestCtx;
    const life = lifecycle;
    if (!link || !ctx || !life.active || reviewRunning || state.phase === "reviewing" || gitAvailability !== "available") return;
    if (!ctx.isIdle()) return;
    try {
      if (["paused", "done"].includes(state.phase)) {
        const word = wordRecords(link.dir, link.stage).find((row) => row.state === "delivered" && !wordsDispatched.has(row.id)
          && row.session?.host === "pi" && row.session.id === ctx.sessionManager.getSessionId());
        if (word) {
          wordsDispatched.add(word.id);
          pi.sendUserMessage(relayMessage(word.id, word.text));
          return;
        }
      }
    } catch (error) { await pauseForError(ctx, error, life); return; }
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
      const completion = Promise.withResolvers<void>();
      task = { lifecycle: life, controller: new AbortController(), finished: completion.promise, finish: completion.resolve };
      activeTask = task;
      reviewRunning = true;
      if (trigger === "command" || state.phase === "done") state.repairs = 0;
      const wasDone = state.phase === "done";
      state.needsInputReview = false; state.readyEpoch = undefined;
      state.phase = "reviewing";
      state.pauseReason = undefined;
      state.awaitingRepair = false;
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

  pi.registerFlag("autoreview-max-repairs", { type: "string", default: "", description: "自动评审返修上限" });
  pi.registerFlag("autoreview-reviewer-model", { type: "string", default: "", description: "评审模型" });
  pi.registerFlag("autoreview-reviewer-thinking", { type: "string", default: "", description: "评审思考档位" });
  pi.registerFlag("autoreview-review-timeout-min", { type: "string", default: "", description: "单次评审保护时长（分钟）" });
  pi.registerFlag("autoreview-reviewer-cmd", { type: "string", default: "", description: "仅测试：外部评审命令" });

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
        : state.phase === "done" ? "完成" : state.phase === "accepting" ? "旧验收停点（需迁移）" : state.needsInputReview ? "待按新输入检查" : "空闲";
      ctx.ui.notify([
        `自动评审：${state.enabled ? "开启" : "关闭"}`, `状态：${phase}`,
        `评审 ${state.rounds.length} 次，返修 ${state.repairs} 次`,
        "测试/验收：没验证（本次未安排）",
        `测试：${LOOP_TEST_STATUS}`,
        `评审会话：${state.reviewerSessionId ?? deriveReviewerSessionId(devSessionId)}`, `总结：${summaryPath(ctx)}`,
        `标准：${state.criteria ? `第 ${state.criteria.version} 版（仅供静态评审核对）` : "尚未记录"}`,
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
    latestCtx = ctx;
    pipelineLink = stageFromEnv(process.env);
    wordsDispatched.clear();
    verifiedRelayPrompt = undefined;
    trackExperienceSession(ctx, true);
    checkPonytail(ctx);
    if (["autoreview-accept-cmd", "autoreview-accept-mode", "autoreview-accept-timeout-min"].some((name) => flagString(pi, name, ""))) ctx.ui.notify(ACCEPT_MIGRATION, "warning");
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
      if (state.phase === "accepting") await pause(ctx, ACCEPT_MIGRATION, life);
      checkLive(life);
      if (state.phase === "done") {
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
      // 流水线里的段：报一次当前状态（重开的会话如果已经完成或暂停，就照实报；整批验收返修还没处理完时只报 started，
      // 免得编排程序误以为已经修好），开始看收件箱。
      if (pipelineLink) {
        const event = state.phase === "done" ? "done" : state.phase === "paused" ? "paused" : "started";
        reportStage(ctx, event, { pauseReason: state.pauseReason }, entries.some((entry) => entry.type === "custom" && entry.customType === "autoreview-state"));
        inboxTimer = setInterval(() => void checkInbox(), pollMs());
        inboxTimer.unref?.();
      }
      if (state.phase === "paused") {
        ctx.ui.notify(`自动评审：上次暂停（${state.pauseReason ?? "未知原因"}），给开发方发消息继续干活即恢复自动评审，或输入 /review 立即评审`, "info");
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
    lifecycle.active = false;
    developerRunning = false;
    activeTask?.controller.abort();
    activeTask = undefined;
    reviewRunning = false;
    // abort 后的异步关停未必来得及跑完：同步杀掉本进程登记的被测系统。
    try { reapProcs(procsPath(ctx), { ownerPid: process.pid }); } catch { /* 尽力 */ }
    trackExperienceSession(ctx, false);
    if (!interrupted) return;
    // 旧任务已失效；只有 shutdown 本身能在处理函数返回前使用仍有效的上下文。
    const cleanup: Lifecycle = { active: true };
    try {
      await pause(ctx, INTERRUPTED, cleanup);
    } finally { cleanup.active = false; }
  });

  // 原生 input 事件保留来源，发生在技能/模板展开之前；扩展消息不能产生用户权限。
  pi.on("input", async (event, ctx) => {
    const life = lifecycle;
    verifiedRelayPrompt = undefined;
    if (!life.active) return { action: "continue" as const };
    const relay = hasRelayHeader(event.text) && pipelineLink && process.env.AUTOREVIEW_BATCH_FILE
      ? await consumeRelay({ message: event.text, info: batchInfo(process.env.AUTOREVIEW_BATCH_FILE, ctx.cwd, pipelineLink.dir), stage: pipelineLink.stage,
        session: { host: "pi", id: ctx.sessionManager.getSessionId() }, summary: summaryPath(ctx) }) : undefined;
    const raw = relay?.text ?? event.text, provenance = { verifiedRelay: Boolean(relay) };
    if ((!relay && !["interactive", "rpc"].includes(event.source)) || isLoopMessage(raw, provenance)) return { action: "continue" as const };
    latestCtx = ctx;
    const before = JSON.stringify([state.requirement, state.criteria, state.grants]);
    const hadReview = state.rounds.length > 0 || state.phase === "done" || reviewRunning;
    try {
      developerRunning = true;
      if (relay) state.repairs = 0;
      if (state.phase === "paused" && gitAvailability !== "unsupported") {
        const reason = state.pauseReason;
        state.phase = "idle"; state.pauseReason = undefined; state.pauseHint = undefined; state.awaitingRepair = false; state.repairs = 0;
        observe(ctx, "running", relay ? {} : { via: "user" });
        ctx.ui.notify(`自动评审：已恢复（上次暂停：${reason ?? "未知原因"}）`, "info");
      }
      const prompt = raw.includes('<file name="') ? raw : expandFileRefs(raw, ctx.cwd);
      if (state.requirement === undefined && prompt.trim()) state.requirement = prompt;
      const criteria = criteriaFromUser(prompt, state.criteria, provenance);
      if (criteria) { state.criteria = criteria; state.grants = undefined; }
      const typed = typedByUser(raw, provenance);
      const grants = grantsFromUser(typed, state.criteria, state.grants);
      if (grants) state.grants = grants;
      rememberPAInput(state, relay, grants && relay ? typed : undefined);
      if (relay) {
        try { appendPARelayRecord({ project: projectRootOf(ctx.cwd), session: ctx.sessionManager.getSessionId(), summary: summaryPath(ctx), source: state.paRelays!.at(-1)! }); }
        catch (error) { ctx.ui.notify(`PA 来源写入交付总表失败（编号 ${relay.id}）：${String(error)}`, "warning"); }
      }
      if (hadReview && (relay || before !== JSON.stringify([state.requirement, state.criteria, state.grants]))) await invalidateCompletion(ctx, life);
      else { saveState(life); updateStatus(ctx, life); }
      if (criteria) ctx.ui.notify(`自动验收：已记录验收标准第 ${criteria.version} 版（${criteria.items.length} 条）`, "info");
      if (grants && state.criteria) ctx.ui.notify(`自动验收：已记录你的授权（${authorizationLine(state.criteria, grants) ?? "标准里没有对应的条目"}）`, "info");
      if (relay) { await rewriteSummary(ctx, life); verifiedRelayPrompt = raw; }
      return relay ? { action: "transform" as const, text: raw } : { action: "continue" as const };
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
    const provenance = { verifiedRelay: event.messageType !== "custom" && verifiedRelayPrompt !== undefined && verifiedRelayPrompt === event.prompt };
    verifiedRelayPrompt = undefined;
    const prompt = event.messageType === "custom" || isLoopMessage(event.prompt ?? "", provenance) ? undefined : event.prompt;
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
        state.baseline = snap.ref;
        state.baselineUntracked = snap.untracked.map(({ path }) => path);
        state.baselineUntrackedDetails = snap.untracked.map((item) => ({ ...item }));
        state.baselineFingerprint = snap.fingerprint;
        state.loopConfigMark = loopConfigMark(ctx.cwd);
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
            await pause(ctx, `开发前准备未通过：${result.reason}`, life, undefined, undefined, result.log, undefined, undefined, result.kind);
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
      if (state.enabled) {
        const convention = conventionText({ singleNode: true, experience: experienceInjection(ctx.cwd) });
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
