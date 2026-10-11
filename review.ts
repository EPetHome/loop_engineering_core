/**
 * review.ts — 自动评审一轮的共用流程，pi 扩展与宿主 Hook 共用。
 *
 * 负责：取快照 →（配了 gate 时先跑门禁：不通过直接返修，不验收、不评审）
 * →（配了 acceptance 时再验收：不通过直接返修、不评审）→ 拼输入 → 调评审（失败重试 1 次）
 * → 解析 → 比较指纹 → 决定完成/返修/暂停。门禁、验收与评审共用一轮总预算。
 * exec、状态读写、总结、进度等副作用全部通过参数注入；调用方负责把 outcome 变成
 * pi 的返修消息或宿主的 block JSON。
 */
import { join } from "node:path";
import { acceptanceRunDir, runAcceptanceStage, type AcceptanceState } from "./acceptance.ts";
import {
  buildAcceptanceRepairMessage, formatFailedItems, renderAcceptanceForReview, type AcceptanceRecord,
} from "./acceptance-core.ts";
import {
  buildGateRepairMessage, buildRepairMessage, buildReviewInput, decideNext, deriveReviewerSessionId, gateOutputTail,
  parseReview, type GateRecord, type ParsedReview, type RoundRecord,
} from "./core.ts";
import { EXT_DIR, PERMISSION_EXT, PI_BIN, resolveTestCmd, type AcceptanceConfig, type GateConfig } from "./config.ts";
import { createGitEvidence, type Exec, type ExecResult, type Snapshot } from "./git.ts";
import { blockerHint, manualHint } from "./onboarding.ts";

export { PI_BIN, PERMISSION_EXT };
export const REVIEW_PROMPT_PATH = join(EXT_DIR, "review-prompt.md");
export const DEFAULT_MODEL = "openai-codex/gpt-6-astra";
export const DEFAULT_THINKING = "xhigh";
/** 门禁、验收打回和评审打回共用。 */
export const DEFAULT_MAX_REPAIRS = 4;
export const DEFAULT_TIMEOUT_MIN = 60;
/** 取消正在进行的评审时使用的固定原因。 */
export const INTERRUPTED = "评审被中断（会话关闭或重载）";

export interface ReviewState extends AcceptanceState {
  enabled: boolean;
  baseline?: string;
  baselineUntracked?: string[];
  baselineFingerprint?: string;
  /** 下列三个字段只在成功评审后更新，不受失败调用影响。 */
  lastSnapshot?: string;
  lastUntracked?: string[];
  lastFingerprint?: string;
  /** 最近一次对代码给出结论（门禁或验收不通过、评审成功）时的指纹，用来判断「返修后没有任何改动」。 */
  lastCheckedFingerprint?: string;
  reviewerSessionId?: string;
  rounds: RoundRecord[];
  repairs: number;
  phase: "idle" | "reviewing" | "done" | "paused";
  pauseReason?: string;
  /** 暂停时给你看的下一步（写进总结「需要你做的事」），恢复时清掉。 */
  pauseHint?: string;
  /** 本会话已经提醒过写法段缺失或过期（每个会话只提醒一次）。 */
  conventionNoticed?: boolean;
  unresolvedMustFix?: string;
  /** 最近一次验收没通过的条目（暂停时写进总结）。 */
  unresolvedAcceptance?: string;
  awaitingRepair?: boolean;
}

export interface ReviewConfig {
  maxRepairs: number;
  reviewerModel: string;
  reviewerThinking: string;
  reviewTimeoutMin: number;
  /** 仅测试：外部评审命令；语义同 pi 扩展的 autoreview-reviewer-cmd。 */
  reviewerCmd: string;
  /** .autoreview.json 的 acceptance 一节；没有就不验收。 */
  acceptance?: AcceptanceConfig;
  /** .autoreview.json 的 gate 一节；没有就不跑门禁。 */
  gate?: GateConfig;
}

export interface ReviewOutcome {
  kind: "done" | "repair" | "paused";
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
}

export interface ReviewDeps {
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
  /** 写评审输入、门禁日志等材料文件，返回绝对路径。 */
  writeInput: (name: string, text: string) => string;
  /** 成功评审后的总结（完成/进行中）；抛错由调用方处理。 */
  writeSummary?: (status: "进行中" | "完成") => Promise<void>;
  saveState: () => Promise<void> | void;
  /** 自定义评审调用；缺省用 pi CLI 或 config.reviewerCmd。 */
  callReviewer?: (reviewerSessionId: string, round: number, timeoutMs: number, inputPath: string) => Promise<ExecResult>;
  /** 时间源（测试可注入）；缺省 Date.now。 */
  now?: () => number;
  signal?: AbortSignal;
  /** 验收材料目录（每轮一个 r<轮次> 子目录）；配了 acceptance 时必须给。 */
  acceptanceDir?: string;
  /** 进程登记文件：被测系统登记进去。 */
  procsFile?: string;
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

/** 缺省评审调用：测试命令优先，否则走 pi CLI（与 pi 扩展 6.8 相同）。 */
function defaultCallReviewer(deps: ReviewDeps) {
  const { config, exec, cwd, signal } = deps;
  return async (reviewerSessionId: string, round: number, timeoutMs: number, inputPath: string): Promise<ExecResult> => {
    if (config.reviewerCmd) {
      const cmd = resolveTestCmd(config.reviewerCmd);
      return exec(cmd, [String(round), inputPath, reviewerSessionId], { cwd, timeout: timeoutMs, signal, role: "评审" });
    }
    const args = [
      "--offline", "-p", "--session-id", reviewerSessionId, "--model", config.reviewerModel, "--thinking", config.reviewerThinking,
      "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes",
      "--tools", "read,grep,find,ls,bash", "-e", PERMISSION_EXT,
      "--append-system-prompt", REVIEW_PROMPT_PATH, `@${inputPath}`,
    ];
    return exec(PI_BIN, args, { cwd, timeout: timeoutMs, signal, role: "评审" });
  };
}

interface RoundClock {
  startedAt: string;
  startedTs: number;
  deadline: number;
  now: () => number;
}

/** 门禁和验收没走到评审的轮次也记进 rounds，便于总结。 */
function pushUnreviewedRound(
  deps: ReviewDeps, clock: RoundClock, conclusion: string, extra: Pick<RoundRecord, "gate" | "acceptance">,
): void {
  deps.state.rounds.push({
    round: deps.round, startedAt: clock.startedAt, durationMs: clock.now() - clock.startedTs, conclusion,
    mustFixRaw: "", mustFix: [], minor: [], questions: [], recheck: [], ...extra,
  });
}

/** sh 的「命令找不到」「不能执行」：多半是环境或配置问题，不算开发方的错。 */
const SHELL_CANNOT_RUN = new Set([126, 127]);

/**
 * 门禁这一步：在开发目录用 /bin/sh -c 执行 gate.cmd，退出码 0 才往下走。
 * 命令跑完且退出码非 0 → 打回开发方（这一轮不验收、不评审）；超时、命令找不到、起不来 → 暂停；
 * 门禁改了项目里的文件 → 暂停。通过返回记录，接着验收或评审。
 */
async function gateStep(
  deps: ReviewDeps, before: Snapshot, git: ReturnType<typeof createGitEvidence>, clock: RoundClock,
): Promise<{ outcome: ReviewOutcome } | { record: GateRecord }> {
  const { state, config } = deps;
  const gate = config.gate!;
  const live = (): void => { deps.checkLive?.(); };
  const startedTs = clock.now();
  const timeout = Math.min(gate.timeoutMin * 60_000, clock.deadline - startedTs);
  deps.onProgress?.(`门禁命令执行中（第 ${deps.round} 轮）`);
  let res: ExecResult | undefined;
  let failure = "";
  try {
    // stderr 并进 stdout：返修消息里的输出和在终端里看到的顺序一致。
    res = await deps.exec("/bin/sh", ["-c", `exec 2>&1\n${gate.cmd}`], { cwd: deps.cwd, timeout, signal: deps.signal, role: "门禁" });
  } catch (error) { failure = errorText(error); }
  live();
  const output = res ? `${res.stdout}${res.stderr.trim() ? `\n${res.stderr}` : ""}` : "";
  const record: GateRecord = { command: gate.cmd, result: "通过", durationMs: clock.now() - startedTs };
  if (!res) {
    record.result = "无法执行";
    record.detail = tail(failure, 300);
  } else {
    record.exitCode = res.code;
    record.outputTail = gateOutputTail(output);
    if (res.killed) {
      record.result = "超时";
      record.detail = `超过 ${Math.round(timeout / 60_000)} 分钟没跑完，被终止`;
    } else if (SHELL_CANNOT_RUN.has(res.code)) {
      record.result = "无法执行";
      record.detail = `退出码 ${res.code}：命令找不到或不能执行`;
    } else if (res.code !== 0) record.result = "不通过";
    record.logPath = deps.writeInput(
      `gate-${deps.devSessionId}-r${deps.round}.log`,
      [`$ ${gate.cmd}`, `退出码：${res.code}${res.killed ? "（被终止）" : ""}`, "", output].join("\n"),
    );
  }
  const middle = await git.snapshot();
  live();
  if (middle.fingerprint !== before.fingerprint) {
    pushUnreviewedRound(deps, clock, "未评审（门禁期间工作区变了）", { gate: record });
    const changed = await git.changedFiles(before, middle);
    live();
    return {
      outcome: {
        kind: "paused", reason: "门禁期间工作区变了", changedFiles: changed,
        notes: "门禁命令改了项目里的文件：把构建产物、缓存、报告加进 .gitignore，或让命令写到项目外面",
      },
    };
  }
  if (record.result === "通过") return { record };
  if (record.result !== "不通过") {
    pushUnreviewedRound(deps, clock, `未评审（门禁${record.result}）`, { gate: record });
    return {
      outcome: {
        kind: "paused", reason: `门禁${record.result}`,
        notes: [record.detail, record.outputTail && `输出最后几行：${tail(record.outputTail, 300)}`].filter(Boolean).join("；"),
        hint: `检查 .autoreview.json 的 gate（命令：${gate.cmd}，时限 ${gate.timeoutMin} 分钟）能在项目目录跑完，再发消息继续`,
      },
    };
  }
  pushUnreviewedRound(deps, clock, "未评审（门禁不通过）", { gate: record });
  state.lastCheckedFingerprint = before.fingerprint;
  if (decideNext(1, state.repairs, config.maxRepairs) === "pause") {
    return { outcome: { kind: "paused", reason: "达到返修上限" } };
  }
  state.repairs += 1;
  state.awaitingRepair = true;
  await deps.writeSummary?.("进行中");
  live();
  return { outcome: { kind: "repair", message: buildGateRepairMessage(state.repairs, record) } };
}

/**
 * 验收这一步：不通过就打回（这一轮不评审），无法验收、被暂停或改了工作区就暂停；
 * 通过返回记录，接着评审。没通过的轮次也记进 rounds，便于总结。
 * 验收的时限从验收开始算（前面的门禁不占验收自己的时间），仍不超过一轮总预算。
 */
async function acceptanceStep(
  deps: ReviewDeps, before: Snapshot, git: ReturnType<typeof createGitEvidence>, clock: RoundClock, gate?: GateRecord,
): Promise<{ outcome: ReviewOutcome } | { record: AcceptanceRecord }> {
  const { state, config } = deps;
  const acceptance = config.acceptance!;
  if (!deps.acceptanceDir) throw new Error("配置了 acceptance 但没有给验收材料目录");
  const live = (): void => { deps.checkLive?.(); };
  const previous = lastAcceptance(state);
  const stage = await runAcceptanceStage({
    workDir: deps.cwd, devSessionId: deps.devSessionId, round: deps.round, deliveryNote: deps.deliveryNote,
    state, config: acceptance, reviewerModel: config.reviewerModel, reviewerThinking: config.reviewerThinking,
    exec: deps.exec, runDir: acceptanceRunDir(deps.acceptanceDir, deps.round), procsFile: deps.procsFile,
    deadline: Math.min(clock.now() + acceptance.timeoutMin * 60_000, clock.deadline), now: clock.now,
    previousFailed: previous ? previous.items.filter((item) => item.verdict !== "通过").map((item) => item.id) : [],
    signal: deps.signal, checkLive: deps.checkLive, onProgress: deps.onProgress, saveState: deps.saveState,
  });
  live();
  if (stage.kind === "paused") return { outcome: { kind: "paused", reason: stage.reason, notes: stage.notes, hint: stage.hint } };
  const record = stage.record;
  const pushRound = (conclusion: string): void => pushUnreviewedRound(deps, clock, conclusion, { gate, acceptance: record });
  const middle = await git.snapshot();
  live();
  if (middle.fingerprint !== before.fingerprint) {
    pushRound("未评审（验收期间工作区变了）");
    const changed = await git.changedFiles(before, middle);
    live();
    return {
      outcome: {
        kind: "paused", reason: "验收期间工作区变了", changedFiles: changed,
        notes: "被测系统或验收方改了项目里的文件：把运行时产物加进 .gitignore，或用 acceptance.env 让系统写到 $AUTOREVIEW_RUN_DIR",
      },
    };
  }
  if (record.verdict === "通过" || record.verdict === "部分验证") {
    state.unresolvedAcceptance = undefined;
    return { record };
  }
  if (record.verdict === "无法验收") {
    pushRound("未评审（无法验收）");
    const unknown = record.items.filter((item) => item.verdict === "无法验证").map((item) => `${item.id}：${item.detail}`);
    return {
      outcome: {
        kind: "paused", reason: `无法验收：${record.reason ?? "有标准无法验证"}`, notes: unknown.join("；"),
        hint: blockerHint(record, deps.cwd, acceptance),
      },
    };
  }
  pushRound("未评审（验收不通过）");
  state.lastCheckedFingerprint = before.fingerprint;
  state.unresolvedAcceptance = formatFailedItems(record);
  if (decideNext(1, state.repairs, config.maxRepairs) === "pause") {
    return { outcome: { kind: "paused", reason: "达到返修上限" } };
  }
  state.repairs += 1;
  state.awaitingRepair = true;
  await deps.writeSummary?.("进行中");
  live();
  return { outcome: { kind: "repair", message: buildAcceptanceRepairMessage(state.repairs, record) } };
}

/**
 * 跑一轮评审。返回结果前不改 phase、不发通知不写暂停总结，由调用方决定副作用；
 * 「完成/进行中」总结由 deps.writeSummary 在返回前写完，保证与旧 pi 扩展顺序一致。
 */
export async function runReviewRound(deps: ReviewDeps): Promise<ReviewOutcome> {
  const { state, config, cwd } = deps;
  const signal = deps.signal;
  const live = (): void => { deps.checkLive?.(); };
  const timeoutMs = Math.max(60_000, Math.round(config.reviewTimeoutMin * 60_000));
  const callReviewer = deps.callReviewer ?? defaultCallReviewer(deps);
  const git = createGitEvidence(deps.exec, cwd, signal);
  const startedAt = nowStamp();
  const now = deps.now ?? Date.now;
  const startedTs = now();
  // 一轮总预算：门禁、验收（如果有）、评审首次调用和 1 次重试共用；后面的只能用剩余时间。
  const deadline = startedTs + timeoutMs;

  const before = await git.snapshot();
  live();
  if (state.baseline === undefined) {
    state.baseline = before.head;
    state.baselineUntracked = [];
    state.baselineFingerprint = before.fingerprint;
    await deps.saveState();
  }
  const clock: RoundClock = { startedAt, startedTs, deadline, now };
  let gate: GateRecord | undefined;
  if (config.gate) {
    const step = await gateStep(deps, before, git, clock);
    if ("outcome" in step) return step.outcome;
    gate = step.record;
  }
  let acceptance: AcceptanceRecord | undefined;
  if (config.acceptance) {
    const step = await acceptanceStep(deps, before, git, clock, gate);
    if ("outcome" in step) return step.outcome;
    acceptance = step.record;
  }
  const firstReview = state.lastSnapshot === undefined;
  const baseRef = firstReview ? state.baseline! : state.lastSnapshot!;
  const baseUntracked = (firstReview ? state.baselineUntracked : state.lastUntracked) ?? [];
  const { diff, stat } = await git.diff(baseRef, before.ref);
  live();
  const inputText = buildReviewInput({
    round: deps.round, firstReview, requirement: state.requirement,
    deliveryNote: deps.deliveryNote, previousMustFix: state.unresolvedMustFix,
    diff, diffStat: stat, untracked: git.newUntrackedFiles(before, baseUntracked),
    acceptance: acceptance ? renderAcceptanceForReview(acceptance) : undefined, gate: gate?.command,
  });
  const inputPath = deps.writeInput(`review-input-${deps.devSessionId}-r${deps.round}.md`, inputText);
  const reviewerSessionId = state.reviewerSessionId ?? deriveReviewerSessionId(deps.devSessionId);
  state.reviewerSessionId = reviewerSessionId;
  await deps.saveState();
  // 门禁、验收改过进度文字，进入评审时改回来。
  if (gate || acceptance) deps.onProgress?.(`自动评审中（第 ${deps.round} 轮）`);

  let parsed: ParsedReview | undefined;
  let lastError = "";
  let timedOut = false;
  for (let attempt = 1; attempt <= 2 && !parsed; attempt += 1) {
    const remaining = deadline - now();
    if (remaining < 60_000) {
      // 时间预算不足 1 分钟就不再调用，按「评审超时」暂停。
      timedOut = true;
      lastError = attempt > 1
        ? `第 ${attempt} 次评审不再重试：两次尝试共用 ${Math.round(timeoutMs / 60_000)} 分钟已用完（剩余 ${Math.max(0, Math.round(remaining / 1000))} 秒）`
        : `门禁和验收用掉了本轮预算，评审剩余不足 1 分钟（剩余 ${Math.max(0, Math.round(remaining / 1000))} 秒）`;
      break;
    }
    const attemptTimeout = remaining;
    try {
      const result = await callReviewer(reviewerSessionId, deps.round, attemptTimeout, inputPath);
      live();
      if (result.killed) {
        timedOut = true;
        lastError = `第 ${attempt} 次评审超时或被终止（退出码 ${result.code}）`;
      } else if (result.code !== 0) lastError = `第 ${attempt} 次评审退出码 ${result.code}：${tail(result.stderr, 300)}`;
      else if (!result.stdout.trim()) lastError = `第 ${attempt} 次评审输出为空`;
      else {
        const outcome = parseReview(result.stdout);
        if (outcome.ok) parsed = outcome.review;
        else lastError = `第 ${attempt} 次评审输出无法解析：${outcome.error}`;
      }
    } catch (error) {
      live();
      lastError = `第 ${attempt} 次评审调用失败：${tail(errorText(error), 300)}`;
    }
    if (!parsed) {
      live();
      deps.onProgress?.(`自动评审中（第 ${deps.round} 轮，重试 ${attempt}）`);
    }
  }
  live();
  const record: RoundRecord = {
    round: deps.round, startedAt, durationMs: now() - startedTs,
    conclusion: parsed?.conclusion ?? "", mustFixRaw: parsed?.mustFixRaw ?? "",
    mustFix: parsed?.mustFix ?? [], minor: parsed?.minor ?? [], questions: parsed?.questions ?? [],
    recheck: parsed?.recheck ?? [], note: parsed?.note, failed: parsed ? undefined : lastError, acceptance, gate,
  };
  state.rounds.push(record);
  const after = await git.snapshot();
  live();
  if (before.fingerprint !== after.fingerprint) {
    const changed = await git.changedFiles(before, after);
    live();
    return {
      kind: "paused",
      reason: changed.length ? "评审改动了工作区" : "工作区或提交发生了变化",
      changedFiles: changed,
    };
  }
  if (!parsed) return { kind: "paused", reason: timedOut ? "评审超时" : "评审失败", notes: lastError };

  state.lastSnapshot = before.ref;
  state.lastUntracked = before.untracked.map(({ path }) => path);
  state.lastFingerprint = before.fingerprint;
  state.lastCheckedFingerprint = before.fingerprint;
  state.unresolvedMustFix = parsed.mustFix.length > 0 ? parsed.mustFixRaw : undefined;
  const action = decideNext(parsed.mustFix.length, state.repairs, config.maxRepairs);
  if (action === "done") {
    await deps.writeSummary?.("完成");
    live();
    return { kind: "done", hint: manualHint(acceptance) };
  }
  if (action === "pause") return { kind: "paused", reason: "达到返修上限" };
  state.repairs += 1;
  state.awaitingRepair = true;
  await deps.writeSummary?.("进行中");
  live();
  return { kind: "repair", message: buildRepairMessage(state.repairs, parsed.mustFixRaw) };
}
