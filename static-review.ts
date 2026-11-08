/** 静态评审执行器：只调用、重试、解析和留证；不认识验收、队列或宿主内部状态。 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { EXT_DIR, PERMISSION_EXT, PI_BIN, resolveTestCmd } from "./config.ts";
import { parseReview, type ParsedReview } from "./core.ts";
import { acquireProjectExecution } from "./project-execution.ts";
import type { Exec, ExecResult } from "./git.ts";

export const REVIEW_PROMPT_PATH = join(EXT_DIR, "review-prompt.md");
export interface StaticConfig { reviewerModel: string; reviewerThinking: string; reviewerCmd: string }
export type ReviewerCall = (session: string, round: number, timeout: number, input: string) => Promise<ExecResult>;
export class ReviewerCallFailure extends Error {
  readonly processesReleased: boolean; readonly retryable: boolean;
  constructor(error: unknown, processesReleased: boolean, retryable: boolean) {
    super(error instanceof Error ? error.message : String(error), { cause: error }); this.name = "ReviewerCallFailure";
    this.processesReleased = processesReleased; this.retryable = retryable;
  }
}
export function staticReviewer(options: { cwd: string; config: StaticConfig; exec: Exec; signal?: AbortSignal; env?: NodeJS.ProcessEnv; procsFile?: string }): ReviewerCall {
  return async (session, round, timeout, input) => {
    const deadline = Date.now() + timeout, signal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(Math.max(1, Math.min(2_147_483_647, Math.floor(timeout))))]);
    let release: ((released: boolean) => void) | undefined, released = true, invoked = false;
    try {
      release = await acquireProjectExecution(options.cwd, "check", options.procsFile ?? "", signal);
      signal.throwIfAborted(); invoked = true; released = false;
      const remaining = Math.max(1, deadline - Date.now());
      const result = await (options.config.reviewerCmd
        ? options.exec(resolveTestCmd(options.config.reviewerCmd), [String(round), input, session], { cwd: options.cwd, timeout: remaining, signal, role: "评审", env: { ...options.env, GIT_OPTIONAL_LOCKS: "0" } })
        : options.exec(options.env?.PI_BIN || PI_BIN, ["--offline", "-p", "--session-id", session,
          "--model", options.config.reviewerModel, "--thinking", options.config.reviewerThinking,
          "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--tools", "read,grep,find,ls,bash",
          "-e", PERMISSION_EXT, "--append-system-prompt", REVIEW_PROMPT_PATH, `@${input}`],
        { cwd: options.cwd, timeout: remaining, signal, role: "评审", env: { ...options.env, GIT_OPTIONAL_LOCKS: "0" } }));
      released = result.processesReleased === true;
      if (!released) throw new Error(`评审消费者释放未确认，未继续调用：${result.stdout}\n${result.stderr}`);
      return result;
    } catch (error) {
      if (error instanceof ReviewerCallFailure) { released = error.processesReleased; throw error; }
      throw new ReviewerCallFailure(error, released, invoked && released);
    } finally { release?.(released); }
  };
}

export async function executeStaticReview(options: {
  session: string; developer: string; round: number; input: string; deadline: number; timeoutMs: number;
  keepOutput?: boolean; requireRelease?: boolean; now?: () => number; live?: () => void; progress?: (text: string) => void;
  call: ReviewerCall; write: (name: string, text: string) => string;
}): Promise<{ parsed?: ParsedReview; error: string; timedOut: boolean; logs: string[]; released: boolean }> {
  const now = options.now ?? Date.now, logs: string[] = [];
  let parsed: ParsedReview | undefined, error = "", timedOut = false, released = true;
  for (let attempt = 1; attempt <= 2 && !parsed; attempt += 1) {
    const remaining = options.deadline - now();
    if (remaining <= 0 || (attempt > 1 && remaining < 60_000)) {
      timedOut = true;
      error = attempt > 1
        ? `第 ${attempt} 次评审不再重试：两次尝试共用 ${Math.round(options.timeoutMs / 60_000)} 分钟已用完（剩余 ${Math.max(0, Math.round(remaining / 1000))} 秒）`
        : `首次静态评审预算已用完（剩余 ${Math.max(0, Math.round(remaining / 1000))} 秒）`;
      break;
    }
    let raw = "", retryable = true;
    try {
      const result = await options.call(options.session, options.round, remaining, options.input);
      raw = `${result.stdout}\n${result.stderr}`;
      released &&= options.requireRelease ? result.processesReleased === true : result.processesReleased !== false;
      options.live?.();
      if (result.killed) { timedOut = true; error = `第 ${attempt} 次评审超时或被终止（退出码 ${result.code}）`; }
      else if (result.code !== 0) error = `第 ${attempt} 次评审退出码 ${result.code}：${raw}`;
      else if (!result.stdout.trim()) error = `第 ${attempt} 次评审输出为空`;
      else {
        const outcome = parseReview(result.stdout);
        if (outcome.ok) parsed = outcome.review;
        else error = `第 ${attempt} 次评审输出无法解析：${outcome.error}`;
      }
      // 成功原文同样保留；账本指向实际证据，不只保存模型结论摘要。
      if (parsed && options.keepOutput) logs.push(options.write(`review-output-${options.developer}-r${options.round}-${randomUUID()}.md`, result.stdout));
    } catch (failure) {
      if (failure instanceof ReviewerCallFailure) { released &&= failure.processesReleased; retryable = failure.retryable; }
      else released &&= !options.requireRelease;
      options.live?.();
      raw = failure instanceof Error ? failure.stack ?? failure.message : String(failure);
      error = `第 ${attempt} 次评审调用失败：${raw}`;
    }
    if (!released) { parsed = undefined; error = `${error || "评审返回但无法核对消费者"}；消费者释放未确认，已停止自动重试`; }
    if (!parsed) {
      try { logs.push(options.write(`review-error-${options.developer}-r${options.round}-a${attempt}-${randomUUID()}.log`, raw || error)); }
      catch (failure) { error += `\n错误原文写盘失败：${String(failure)}`; }
      options.live?.();
      if (!released || !retryable) break;
      options.progress?.(`自动评审中（第 ${options.round} 轮，重试 ${attempt}）`);
    }
  }
  options.live?.();
  return { parsed, error, timedOut, logs, released };
}
