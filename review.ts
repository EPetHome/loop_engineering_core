/**
 * review.ts — 自动评审一轮的共用流程，pi 扩展与宿主 Hook 共用。
 *
 * 负责：取快照 → 拼输入 → 调评审（失败重试 1 次）→ 解析 → 比较指纹 → 决定完成/返修/暂停。
 * exec、状态读写、总结、进度等副作用全部通过参数注入；调用方负责把 outcome 变成
 * pi 的返修消息或宿主的 block JSON。
 */
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildRepairMessage, buildReviewInput, decideNext, deriveReviewerSessionId, parseReview,
  type ParsedReview, type RoundRecord,
} from "./core.ts";
import { createGitEvidence, type Exec, type ExecResult } from "./git.ts";

const EXT_DIR = dirname(fileURLToPath(import.meta.url));

export const PI_BIN = "/Users/Admin/.local/bin/pi";
export const PERMISSION_EXT = "/Users/Admin/.pi/agent/npm/node_modules/@gotgenes/pi-permission-system/src/index.ts";
export const REVIEW_PROMPT_PATH = join(EXT_DIR, "review-prompt.md");
export const DEFAULT_MODEL = "openai-codex/gpt-6-astra";
export const DEFAULT_THINKING = "xhigh";
export const DEFAULT_MAX_REPAIRS = 3;
export const DEFAULT_TIMEOUT_MIN = 60;
/** 取消正在进行的评审时使用的固定原因。 */
export const INTERRUPTED = "评审被中断（会话关闭或重载）";

export interface ReviewState {
  enabled: boolean;
  requirement?: string;
  baseline?: string;
  baselineUntracked?: string[];
  baselineFingerprint?: string;
  /** 下列三个字段只在成功评审后更新，不受失败调用影响。 */
  lastSnapshot?: string;
  lastUntracked?: string[];
  lastFingerprint?: string;
  reviewerSessionId?: string;
  rounds: RoundRecord[];
  repairs: number;
  phase: "idle" | "reviewing" | "done" | "paused";
  pauseReason?: string;
  unresolvedMustFix?: string;
  awaitingRepair?: boolean;
}

export interface ReviewConfig {
  maxRepairs: number;
  reviewerModel: string;
  reviewerThinking: string;
  reviewTimeoutMin: number;
  /** 仅测试：外部评审命令；语义同 pi 扩展的 autoreview-reviewer-cmd。 */
  reviewerCmd: string;
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
  /** 写评审输入文件，返回绝对路径。 */
  writeInput: (name: string, text: string) => string;
  /** 成功评审后的总结（完成/进行中）；抛错由调用方处理。 */
  writeSummary?: (status: "进行中" | "完成") => Promise<void>;
  saveState: () => Promise<void> | void;
  /** 自定义评审调用；缺省用 pi CLI 或 config.reviewerCmd。 */
  callReviewer?: (reviewerSessionId: string, round: number, timeoutMs: number, inputPath: string) => Promise<ExecResult>;
  /** 时间源（测试可注入）；缺省 Date.now。 */
  now?: () => number;
  signal?: AbortSignal;
}

export function newReviewState(): ReviewState {
  return { enabled: true, rounds: [], repairs: 0, phase: "idle" };
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
      const raw = config.reviewerCmd;
      const cmd = raw.includes("/") && !isAbsolute(raw) ? resolve(EXT_DIR, raw) : raw;
      return exec(cmd, [String(round), inputPath, reviewerSessionId], { cwd, timeout: timeoutMs, signal });
    }
    const args = [
      "--offline", "-p", "--session-id", reviewerSessionId, "--model", config.reviewerModel, "--thinking", config.reviewerThinking,
      "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes",
      "--tools", "read,grep,find,ls,bash", "-e", PERMISSION_EXT,
      "--append-system-prompt", REVIEW_PROMPT_PATH, `@${inputPath}`,
    ];
    return exec(PI_BIN, args, { cwd, timeout: timeoutMs, signal });
  };
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
  // 首次调用加 1 次重试共用同一份时间预算；重试只能用剩余时间。
  const deadline = startedTs + timeoutMs;

  const before = await git.snapshot();
  live();
  if (state.baseline === undefined) {
    state.baseline = before.head;
    state.baselineUntracked = [];
    state.baselineFingerprint = before.fingerprint;
    await deps.saveState();
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
  });
  const inputPath = deps.writeInput(`review-input-${deps.devSessionId}-r${deps.round}.md`, inputText);
  const reviewerSessionId = state.reviewerSessionId ?? deriveReviewerSessionId(deps.devSessionId);
  state.reviewerSessionId = reviewerSessionId;
  await deps.saveState();

  let parsed: ParsedReview | undefined;
  let lastError = "";
  let timedOut = false;
  for (let attempt = 1; attempt <= 2 && !parsed; attempt += 1) {
    const remaining = deadline - now();
    if (attempt > 1 && remaining < 60_000) {
      // 时间预算不足 1 分钟就不再重试，按「评审超时」暂停。
      timedOut = true;
      lastError = `第 ${attempt} 次评审不再重试：两次尝试共用 ${Math.round(timeoutMs / 60_000)} 分钟已用完（剩余 ${Math.max(0, Math.round(remaining / 1000))} 秒）`;
      break;
    }
    const attemptTimeout = attempt === 1 ? timeoutMs : Math.max(60_000, remaining);
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
    recheck: parsed?.recheck ?? [], note: parsed?.note, failed: parsed ? undefined : lastError,
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
  state.unresolvedMustFix = parsed.mustFix.length > 0 ? parsed.mustFixRaw : undefined;
  const action = decideNext(parsed.mustFix.length, state.repairs, config.maxRepairs);
  if (action === "done") {
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
