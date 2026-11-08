/**
 * review.ts — 自动评审一轮的共用流程，pi 扩展与宿主 Hook 共用。
 *
 * 负责：取快照 → 拼输入 → 静态评审（失败重试 1 次）
 * → 解析 → 比较指纹 → 决定完成/返修/暂停。只负责静态评审，绝不编排验收或发布。
 * exec、状态读写、总结、进度等副作用全部通过参数注入；调用方负责把 outcome 变成
 * pi 的返修消息或宿主的 block JSON。
 */
import { dirname, join, relative, resolve } from "node:path";
import { executeStaticReview, staticReviewer, REVIEW_PROMPT_PATH } from "./static-review.ts";
import { auditLoopConfig, type ConfigAudit } from "./config-audit.ts";
import type { PauseDetail } from "./blockers.ts";
import type { AcceptanceState } from "./acceptance.ts";
import {
  authorizationLine, formatCriteria, type AcceptanceRecord,
} from "./acceptance-core.ts";
import {
  buildRepairMessage, buildReviewInput, decideNext, deriveReviewerSessionId,
  type ParsedReview, type RoundRecord,
} from "./core.ts";
import { findProjectRoot, PERMISSION_EXT, PI_BIN, type AcceptanceConfig } from "./config.ts";
import { createGitEvidence, type Exec, type ExecResult, type Snapshot } from "./git.ts";
import { methodEnv as buildMethodEnv } from "./method-env.ts";
import { saveReviewSnapshot } from "./snapshots.ts";
import { experienceInjection, markExperienceRecurrence } from "./experience.ts";
import { changedSince, outOfScope, stageScopeFromEnv, type StageScope } from "./scope.ts";
import type { FailureKind } from "./failure.ts";
import { runPreparation, type PreparationConfig, type PreparationState } from "./preparation.ts";
import { isRegisteredSource, loadContext, recordSourceChange, refreshContext, type SourceChangeMark } from "./project-context.ts";

export { PI_BIN, PERMISSION_EXT };
export { REVIEW_PROMPT_PATH };
export { DEFAULT_MODEL, DEFAULT_THINKING, DEFAULT_MAX_REPAIRS, DEFAULT_TIMEOUT_MIN } from "./config.ts";
/** 取消正在进行的评审时使用的固定原因。 */
export const INTERRUPTED = "评审被中断（会话关闭或重载）";

export interface ReviewState extends AcceptanceState, PreparationState, ConfigAudit {
  /** 独立经验起草的输入指纹与软失败；不参与完成资格。 */
  experienceDraft?: { signature: string; error?: string };
  inputsFingerprint?: string;
  enabled: boolean;
  userInputVia?: "user" | "pa";
  userInputCount?: number;
  paRelays?: import("./pa-records.ts").RelaySource[];
  baseline?: string;
  baselineUntracked?: string[];
  /** 开工时未跟踪文件的内容哈希和模式；只豁免确实没变的文件。 */
  baselineUntrackedDetails?: Snapshot["untracked"];
  baselineFingerprint?: string;
  /** 在调用评审前落盘；中断或失败轮次的材料也保留，不依赖源仓库 Git 对象。 */
  reviewSnapshots?: { round: number; path: string }[];
  /** 越界检查起点：整合返修收到时重置到当时快照；普通返修不重置。 */
  scopeBaseline?: string;
  scopeBaselineUntrackedDetails?: Snapshot["untracked"];
  /** 下列字段只在成功评审后更新，不受失败调用影响。 */
  lastSnapshot?: string;
  lastUntracked?: string[];
  lastFingerprint?: string;
  /** 最后一个成功评审用的完整快照：判断后续指纹变化是否只来自已登记来源文件。 */
  lastSnapshotDetails?: Snapshot;
  /** 最近一次对代码给出结论（越界或验收不通过、评审成功）时的指纹，用来判断「返修后没有任何改动」。 */
  lastCheckedFingerprint?: string;
  reviewerSessionId?: string;
  rounds: RoundRecord[];
  repairs: number;
  phase: "idle" | "reviewing" | "accepting" | "done" | "paused";
  materialCleanup?: string;
  pauseReason?: string;
  /** 原执行器的分类随暂停持久化；事件与查询不重新从日志推断。 */
  pauseFailureKind?: FailureKind;
  /** 暂停时给你看的下一步（写进总结「需要你做的事」），恢复时清掉。 */
  pauseHint?: string;
  pauseDetail?: PauseDetail;
  blockerHistory?: string[];
  unresolvedMustFix?: string;
  /** 最近一次验收没通过的条目（暂停时写进总结）。 */
  unresolvedAcceptance?: string;
  awaitingRepair?: boolean;
  /** 开发期间发现变化的来源文件与时间（总结「开发期间来源变化」一节）。 */
  sourceChanges?: SourceChangeMark[];
  /** 拿不到文件列表时的说明（如「来源有变化（第 3 版）」）。 */
  sourceChangeNote?: string;
}

export interface ReviewConfig {
  singleNode?: boolean;
  configurationHash?: string;
  maxRepairs: number;
  reviewerModel: string;
  reviewerThinking: string;
  reviewTimeoutMin: number;
  /** 仅测试：外部评审命令；语义同 pi 扩展的 autoreview-reviewer-cmd。 */
  reviewerCmd: string;
  /** 只读配置兼容/审计；静态评审绝不执行它。验收由内核独立节点调用。 */
  acceptance?: AcceptanceConfig;
  preparation?: PreparationConfig;
}

export interface ReviewOutcome {
  kind: "done" | "repair" | "paused" | "report";
  /** report：只返回静态评审，不进入开发交付与返修。 */
  review?: ParsedReview;
  record?: RoundRecord;
  /** kind=repair：发回开发方的返修消息。 */
  message?: string;
  /** kind=paused：暂停原因。 */
  reason?: string;
  /** kind=paused：评审期间变化的工作区文件。 */
  changedFiles?: string[];
  /** kind=paused：写入总结「说明」的细节（评审失败原因等）。 */
  notes?: string;
  /** 给你看的下一步：暂停时怎么处理、完成时哪些条目要人工验收。 */
  hint?: string;
  failureKind?: FailureKind;
}

export interface ReviewDeps {
  sink?: "repair" | "report";
  getConfig?: () => ReviewConfig;
  projectContext?: string;
  checkInputs?: () => ReviewOutcome | undefined;
  /** 只有已登记来源文件能命中的路径判定：命中的工作区变化不算候选改动。 */
  sourceCover?: (path: string) => boolean;
  cwd: string;
  devSessionId: string;
  round: number;
  /** 开发方最后一条回复原文，作为交付说明送评审。 */
  deliveryNote: string;
  state: ReviewState;
  config: ReviewConfig;
  exec: Exec;
  /** 生命周期检查；取消后应抛错，review.ts 不再推进。 */
  checkLive?: () => void;
  /** 评审重试等进度文本。 */
  onProgress?: (text: string) => void;
  /** 写评审输入、越界检查日志等材料文件，返回绝对路径。 */
  writeInput: (name: string, text: string) => string;
  /** 本机保留类快照根；默认在输入文件旁的 review-snapshots/。 */
  snapshotDir?: string;
  /** 成功评审后的总结（完成/进行中）；抛错由调用方处理。 */
  writeSummary?: (status: "进行中" | "完成") => Promise<void>;
  saveState: () => Promise<void> | void;
  /** 自定义评审调用；缺省用 pi CLI 或 config.reviewerCmd。 */
  callReviewer?: (reviewerSessionId: string, round: number, timeoutMs: number, inputPath: string) => Promise<ExecResult>;
  /** 时间源（测试可注入）；缺省 Date.now。 */
  now?: () => number;
  signal?: AbortSignal;
  /** 进程登记文件：被测系统登记进去。 */
  procsFile?: string;
  /** 启动入口交给会话的环境变量；缺省读 process.env。 */
  env?: NodeJS.ProcessEnv;
  /** 本段 scope；缺省从 AUTOREVIEW_BATCH_FILE / AUTOREVIEW_STAGE 读。 */
  scope?: StageScope;
}

export function newReviewState(): ReviewState {
  return { enabled: true, rounds: [], repairs: 0, phase: "idle" };
}

/** 最近一轮的验收结果（总结和提醒用）。 */
export function lastAcceptance(state: ReviewState): AcceptanceRecord | undefined {
  return [...state.rounds].reverse().find((round) => round.acceptance)?.acceptance;
}

/** 无标记时比较用的指纹：最近一次给出结论时 → 上次成功评审 → 开发基线。 */
export function checkedFingerprint(state: ReviewState): string | undefined {
  return state.lastCheckedFingerprint ?? state.lastFingerprint ?? state.baselineFingerprint;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function tail(text: string, max: number): string {
  const trimmed = (text ?? "").trim();
  return trimmed.length <= max ? trimmed : `…${trimmed.slice(-max)}`;
}

export function nowStamp(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

/** 旧组合入口兼容导出；新开发节点直接使用无验收/队列依赖的执行器。 */
export function defaultCallReviewer(deps: ReviewDeps) { return staticReviewer(deps); }

interface RoundClock {
  startedAt: string;
  startedTs: number;
  now: () => number;
}

/** 没走到评审的越界检查也记进 rounds，便于总结。 */
function pushUnreviewedRound(
  deps: ReviewDeps, clock: RoundClock, conclusion: string, extra: Pick<RoundRecord, "scope">,
): void {
  deps.state.rounds.push({
    round: deps.round, startedAt: clock.startedAt, durationMs: clock.now() - clock.startedTs, conclusion,
    mustFixRaw: "", mustFix: [], minor: [], questions: [], recheck: [], ...extra,
  });
}

/**
 * 工作区指纹变化里是不是只有已登记来源文件的内容变化。
 * 没有来源信息、一个文件都没变、或混有其他候选改动时都返回 false（照旧阻断）。
 */
export async function sourcesOnlyWorkspaceChange(
  git: ReturnType<typeof createGitEvidence>, before: Snapshot, after: Snapshot, covers?: (path: string) => boolean,
): Promise<boolean> {
  if (!covers) return false;
  const changed = await git.changedFiles(before, after);
  return changed.length > 0 && changed.every(covers);
}

/**
 * 越界检查：评审之前对比开工依据以来的改动文件（含未跟踪文件）与批次段的 scope。
 * 有越界就按产品失败返修，不进入评审和验收。
 */
async function scopeStep(
  deps: ReviewDeps, before: Snapshot, clock: RoundClock,
): Promise<{ outcome: ReviewOutcome } | undefined> {
  const { state } = deps;
  const scope = deps.scope ?? stageScopeFromEnv(deps.env ?? process.env);
  if (!scope) return undefined;
  // 整合返修只检查收到返修之后的改动；普通返修仍用原开工依据。
  const base = state.scopeBaseline ?? state.baseline;
  if (!base) return undefined;
  const projectRoot = findProjectRoot(deps.cwd) ?? deps.cwd;
  const prefix = relative(projectRoot, deps.cwd).replace(/\\/g, "/");
  const toProject = (path: string): string => prefix ? `${prefix}/${path}`.replace(/\/{2,}/g, "/") : path;
  const details = state.scopeBaseline
    ? state.scopeBaselineUntrackedDetails
    : state.baselineUntrackedDetails;
  const baselineUntracked = (details ?? []).map((item) => ({ ...item, path: toProject(item.path) }));
  const files = await changedSince(deps.exec, projectRoot, base, { signal: deps.signal, baselineUntracked });
  // Loop 自己的配置单独审计，不算业务越界；只豁免这个确切路径，不豁免其他点文件。
  const outside = outOfScope(files.filter((path) => resolve(projectRoot, path) !== resolve(projectRoot, ".autoreview.json")), scope);
  if (outside.length === 0) return undefined;
  const record: NonNullable<RoundRecord["scope"]> = { files: outside };
  try {
    record.logPath = deps.writeInput(`scope-${deps.devSessionId}-r${deps.round}.log`,
      [`$ 越界检查`, `检查起点：${base}`, "越界文件：", ...outside.map((path) => `- ${path}`), ""].join("\n"));
  } catch { /* 日志写失败不改变越界结论 */ }
  pushUnreviewedRound(deps, clock, "未评审（越界改动）", { scope: record });
  state.lastCheckedFingerprint = before.fingerprint;
  if (decideNext(1, state.repairs, deps.config.maxRepairs) === "pause") {
    return { outcome: { kind: "paused", reason: "达到返修上限" } };
  }
  state.repairs += 1;
  state.awaitingRepair = true;
  await deps.writeSummary?.("进行中");
  deps.checkLive?.();
  return { outcome: { kind: "repair", message: [
    `【越界检查 · 第 ${state.repairs} 次返修】`,
    `这些文件不在 allow 里或落在 deny 里：${outside.join("、")}`,
    ...(record.logPath ? [`完整记录：${record.logPath}`] : []),
    "请按批次范围修复，做必要的定向自检；最后一行写【交付完成】。",
  ].join("\n") } };
}

/**
 * 跑一轮评审。返回结果前不改 phase、不发通知不写暂停总结，由调用方决定副作用；
 * 「完成/进行中」总结由 deps.writeSummary 在返回前写完，保证与旧 pi 扩展顺序一致。
 */
async function runOneReviewRound(deps: ReviewDeps): Promise<ReviewOutcome> {
  const { state, config, cwd } = deps;
  const signal = deps.signal;
  const live = (): void => { deps.checkLive?.(); };
  const timeoutMs = Math.max(60_000, Math.round(config.reviewTimeoutMin * 60_000));
  const callReviewer = deps.callReviewer ?? defaultCallReviewer(deps);
  const git = createGitEvidence(deps.exec, cwd, signal);
  const startedAt = nowStamp();
  const now = deps.now ?? Date.now;
  const startedTs = now();
  // 静态评审首次调用与一次重试共用自己的预算，不预留/扣减验收时限。
  const deadline = startedTs + timeoutMs;

  const before = await git.snapshot();
  live();
  if (state.baseline === undefined) {
    state.baseline = before.head;
    state.baselineUntracked = [];
    state.baselineUntrackedDetails = [];
    state.baselineFingerprint = before.fingerprint;
    await deps.saveState();
  }
  const clock: RoundClock = { startedAt, startedTs, now };
  const scope = deps.sink === "report" ? undefined : await scopeStep(deps, before, clock);
  if (scope) return scope.outcome;
  const changedBeforeReview = deps.checkInputs?.();
  if (changedBeforeReview) return changedBeforeReview;
  const firstReview = state.lastSnapshot === undefined;
  const baseRef = firstReview ? state.baseline! : state.lastSnapshot!;
  const baseUntracked = (firstReview ? state.baselineUntracked : state.lastUntracked) ?? [];
  const { diff, stat } = await git.diff(baseRef, before.ref);
  live();
  const inputText = buildReviewInput({
    projectContext: deps.projectContext,
    experienceChecklist: experienceInjection(cwd, true),
    currentCriteria: state.criteria ? `第 ${state.criteria.version} 版，来源：${state.criteria.source}\n${formatCriteria(state.criteria.items)}\n授权：${authorizationLine(state.criteria, state.grants) ?? "无授权条目"}` : undefined,
    round: deps.round, firstReview, requirement: state.requirement,
    deliveryNote: deps.deliveryNote, previousMustFix: state.unresolvedMustFix,
    diff, diffStat: stat, untracked: git.newUntrackedFiles(before, baseUntracked),
  });
  const inputPath = deps.writeInput(`review-input-${deps.devSessionId}-r${deps.round}.md`, inputText);
  const snapshot = await saveReviewSnapshot({ exec: deps.exec, cwd, session: deps.devSessionId, round: deps.round,
    baseline: baseRef, candidate: before, input: inputText, inputPath, root: deps.snapshotDir, signal });
  live();
  state.reviewSnapshots ??= [];
  state.reviewSnapshots.push({ round: deps.round, path: snapshot });
  const reviewerSessionId = state.reviewerSessionId ?? deriveReviewerSessionId(deps.devSessionId);
  state.reviewerSessionId = reviewerSessionId;
  await deps.saveState();
  deps.onProgress?.(`自动评审中（第 ${deps.round} 轮）`);

  const { parsed, error: lastError, timedOut, logs: reviewLogs, released: consumersReleased } = await executeStaticReview({
    session: reviewerSessionId, developer: deps.devSessionId, round: deps.round, input: inputPath,
    deadline, timeoutMs, requireRelease: deps.sink === "report",
    now, live, progress: deps.onProgress, call: callReviewer, write: deps.writeInput,
  });
  const record: RoundRecord = {
    round: deps.round, startedAt, durationMs: now() - startedTs,
    conclusion: parsed?.conclusion ?? "", reviewConclusion: parsed?.conclusion, mustFixRaw: parsed?.mustFixRaw ?? "",
    mustFix: parsed?.mustFix ?? [], minor: parsed?.minor ?? [], questions: parsed?.questions ?? [],
    recheck: parsed?.recheck ?? [], note: parsed?.note, failed: parsed ? undefined : lastError, snapshot, consumersReleased, ...(reviewLogs.length ? { reviewLogs } : {}),
  };
  state.rounds.push(record);
  const after = await git.snapshot();
  live();
  // 已登记来源文件的内容变化不作废评审结果；其他工作区改动照旧暂停。
  if (before.fingerprint !== after.fingerprint && !await sourcesOnlyWorkspaceChange(git, before, after, deps.sourceCover)) {
    const changed = await git.changedFiles(before, after);
    live();
    return {
      kind: "paused",
      reason: changed.length ? "评审改动了工作区" : "工作区或提交发生了变化",
      changedFiles: changed,
    };
  }
  if (!parsed) return { kind: "paused", reason: timedOut ? "评审超时" : "评审失败", notes: lastError };

  const changedBeforeAcceptance = deps.checkInputs?.();
  if (changedBeforeAcceptance) return changedBeforeAcceptance;
  if (deps.sink === "report") return { kind: "report", review: parsed, record };
  const experienceRoot = findProjectRoot(cwd);
  if (experienceRoot && parsed.mustFix.length) {
    parsed.mustFixRaw = markExperienceRecurrence(experienceRoot, deps.devSessionId, parsed.mustFixRaw);
    record.mustFixRaw = parsed.mustFixRaw;
  }
  state.lastSnapshot = before.ref;
  state.lastUntracked = before.untracked.map(({ path }) => path);
  state.lastSnapshotDetails = before;
  state.lastFingerprint = before.fingerprint;
  state.lastCheckedFingerprint = before.fingerprint;
  state.unresolvedMustFix = parsed.mustFix.length > 0 ? parsed.mustFixRaw : undefined;
  const action = decideNext(parsed.mustFix.length, state.repairs, config.maxRepairs);
  if (action === "done") {
    const changedInputs = deps.checkInputs?.();
    if (changedInputs) return changedInputs;
    await deps.writeSummary?.("完成");
    live();
    return { kind: "done" };
  }
  if (action === "pause") return { kind: "paused", reason: "达到返修上限" };
  state.repairs += 1;
  state.awaitingRepair = true;
  await deps.writeSummary?.("进行中");
  live();
  return { kind: "repair", message: buildRepairMessage(state.repairs, parsed.mustFixRaw) };
}

/** 准备和自动恢复有自己的有限预算；不进入用户接管路径，不清零业务计数。 */
export async function runReviewRound(deps: ReviewDeps): Promise<ReviewOutcome> {
  const { acquireProjectExecution } = await import("./project-execution.ts");
  const { consumerProblem } = await import("./local-node-queue.ts");
  const release = await acquireProjectExecution(deps.cwd, "check", deps.procsFile ?? "", deps.signal, deps.checkLive);
  const before = deps.state.rounds.length;
  let released = true;
  try { const result = await runReviewRoundOwned(deps); released = deps.state.rounds.slice(before).every((r) => r.consumersReleased !== false); return result; }
  finally { release(released && !consumerProblem(deps.procsFile ?? "") && !consumerProblem(`${deps.procsFile}.cleanup`)); }
}
async function runReviewRoundOwned(deps: ReviewDeps): Promise<ReviewOutcome> {
  auditLoopConfig(deps.state, deps.cwd);
  if (deps.sink === "report") {
    // 复用同一评审调用/解析/预算；不运行项目方法、不采用开发队列资格。
    return runOneReviewRound({ ...deps, config: { ...deps.config, maxRepairs: 0, preparation: undefined } });
  }
  // 绑定实际使用的输入；父目录配置不一定在当前 Git 工作区里。
  const configVersion = JSON.stringify(deps.config);
  const requirement = deps.state.requirement, criteria = JSON.stringify(deps.state.criteria), grants = JSON.stringify(deps.state.grants);
  const existingCheck = deps.checkInputs;
  const executionInputs = (): ReviewOutcome | undefined => {
    if (deps.getConfig && JSON.stringify(deps.getConfig()) !== configVersion) return { kind: "paused", reason: "检查期间配置已变化，旧结果不能放行新配置", hint: "按当前配置重新评审与验收。" };
    const changedCriteria = criteria === undefined ? deps.state.criteria && deps.state.criteria.source !== "自动起草" : JSON.stringify(deps.state.criteria) !== criteria;
    if (deps.state.requirement !== requirement || JSON.stringify(deps.state.grants) !== grants || changedCriteria) return { kind: "paused", reason: "检查期间需求、标准或授权已变化，旧结果已失效" };
    return existingCheck?.();
  };
  deps = { ...deps, checkInputs: executionInputs };
  deps.checkLive?.();
  const initialChange = executionInputs(); if (initialChange) return initialChange;
  const contextConfig = loadContext(deps.cwd, deps.config);
  if (contextConfig) {
    const context = refreshContext(contextConfig, `${deps.state.requirement ?? ""}\n${deps.deliveryNote}`);
    if (context.snapshot.missing.length) return { kind: "paused", reason: `上游来源缺失：${context.snapshot.missing.join("、")}` };
    if (deps.state.inputsFingerprint === undefined) deps.state.inputsFingerprint = context.snapshot.inputsFingerprint;
    else if (deps.state.inputsFingerprint !== context.snapshot.inputsFingerprint) {
      // 来源内容变化换用新版本继续，只记录；版本由调用方随后落盘。
      recordSourceChange(deps.state, context.changes, context.snapshot.revision);
      deps.state.inputsFingerprint = context.snapshot.inputsFingerprint;
    }
    const checkInputs = (): ReviewOutcome | undefined => {
      const changed = executionInputs(); if (changed) return changed;
      const current = refreshContext(contextConfig);
      if (current.snapshot.missing.length) return { kind: "paused", reason: `上游来源缺失：${current.snapshot.missing.join("、")}`, hint: "补齐 context.sources 登记的文件后继续。" };
      if (deps.state.inputsFingerprint !== current.snapshot.inputsFingerprint) {
        recordSourceChange(deps.state, current.changes, current.snapshot.revision);
        deps.state.inputsFingerprint = current.snapshot.inputsFingerprint;
      }
      return undefined;
    };
    const blocked = checkInputs();
    if (blocked) return blocked;
    // 命中已登记来源文件的路径变化（含目录）不算候选改动。
    const sourceCover = (path: string): boolean => isRegisteredSource(contextConfig, deps.cwd, path);
    deps = { ...deps, projectContext: context.text, checkInputs, sourceCover };
    await deps.saveState();
  }
  const preparation = deps.config.preparation;
  // 开工依据必须早于准备：准备和验收都读同一个 state.baseline，不能让准备改写它。
  // 没有会话启动时记录的快照（手动 /review）时，以 HEAD 为基线，让启动前的未提交改动进入评审。
  if (deps.state.baseline === undefined) {
    const snap = await createGitEvidence(deps.exec, deps.cwd, deps.signal).snapshot();
    deps.state.baseline = snap.head;
    deps.state.baselineUntracked = [];
    deps.state.baselineUntrackedDetails = [];
    deps.state.baselineFingerprint = snap.fingerprint;
    await deps.saveState();
  }
  const preparationBase = deps.state.baseline;
  const prepare = async (outcome?: ReviewOutcome): Promise<ReviewOutcome | undefined> => {
    if (!preparation) return outcome;
    const dir = dirname(deps.writeInput(`preparation-${deps.devSessionId}.md`, "准备记录见同名目录；业务返修计数保持原值。\n"));
    const result = await runPreparation({
      config: preparation, cwd: deps.cwd, state: deps.state, exec: deps.exec, procsFile: deps.procsFile,
      env: buildMethodEnv(preparationBase, {}, deps.env ?? process.env),
      runDir: join(dir, `preparation-${deps.devSessionId}`), signal: deps.signal,
      saveState: deps.saveState, onProgress: deps.onProgress,
      failure: outcome?.failureKind, evidence: outcome?.notes ?? outcome?.reason,
    });
    deps.checkLive?.();
    if (!result.ok) return {
      kind: "paused", reason: `准备阻塞：${result.reason}`, failureKind: result.kind,
      hint: `准备记录：${result.log}。处理对应阻塞后继续；未改变业务返修次数。`,
    };
    return undefined;
  };
  const blocked = await prepare();
  if (blocked) return blocked;
  let round = deps.round;
  for (;;) {
    const repairs = deps.state.repairs;
    const outcome = await runOneReviewRound({ ...deps, round });
    if (outcome.kind === "done") {
      const git = createGitEvidence(deps.exec, deps.cwd, deps.signal);
      const current = await git.snapshot();
      deps.checkLive?.();
      if (current.fingerprint !== deps.state.lastFingerprint) {
        const candidate = deps.state.lastSnapshotDetails;
        const sourcesOnly = candidate ? await sourcesOnlyWorkspaceChange(git, candidate, current, deps.sourceCover) : false;
        if (!sourcesOnly) return { kind: "paused", reason: "发布前候选变化，原检查结果已失效" };
      }
    }
    const changedInputs = deps.checkInputs?.();
    if (changedInputs) { deps.state.repairs = repairs; await deps.saveState(); return changedInputs; }
    if (!preparation || outcome.kind !== "paused" || !["environment", "method"].includes(outcome.failureKind ?? "")) return outcome;
    const blocked = await prepare(outcome);
    if (blocked) return blocked;
    round = deps.state.rounds.length + 1;
  }
}
