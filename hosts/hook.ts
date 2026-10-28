/**
 * hosts/hook.ts — Claude Code / Codex 共用的自动评审 Hook 入口。
 *
 * 一个可执行文件按 hook_event_name 分派：
 *   SessionStart / UserPromptSubmit → 注入开发约定；本会话第一次提交时记需求原文与基线；
 *     暂停或评审中断后再提交即恢复自动评审
 *   Stop → 交付标记触发评审；有必修用 {"decision":"block","reason":…} 打回原会话
 *
 * 只有用 bin/loop-dev 启动的会话才是开发会话：启动器设置 AUTOREVIEW_DEV_ROOT=<项目根>，
 * Hook 只认这个变量，项目根也不随会话中途 cd 改变。没有变量的直接会话不注入评审约定、
 * 不记录状态、不评审或暂停；唯一例外是 SessionStart 的交付总表待回写提醒。
 * 任何异常都只暂停并放行（退出 0），绝不卡宿主、绝不输出非法 JSON。
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { authorizationLine, criteriaFromUser, grantsFromUser, isLoopMessage, typedByUser } from "../acceptance-core.ts";
import {
  checkRoundBudget, configurationHash, findProjectRoot, HERMES_BIN, MARKER_FILE, nonEmptyString, nonNegativeInt, parseAcceptanceConfig, parseGateConfig, readMarker,
} from "../config.ts";
import { classifyMarker, conventionText, deriveReviewerSessionId, renderSummary } from "../core.ts";
import { createGitEvidence, type Exec, type ExecResult } from "../git.ts";
import { appendLedgerRecord, deliveryLedgerPath, pendingItems, projectRootOf, readLedgerForReminder, resultLine, taskTitle, writebackReminder } from "../ledger.ts";
import { acceptanceTodos, conventionNotice } from "../onboarding.ts";
import { experienceInjection, experienceSession, experienceTodos, hookExperienceDir, hookExperienceStates, type HookExperienceActivity } from "../experience.ts";
import { finishExperience } from "../experience-draft.ts";
import { queueStageEvent } from "../merge-queue.ts";
import { bindHookInputBridge, bridgeRepairSequence } from "./inbox-bridge.ts";
import { inboxPath, readJson, statusPath, type InboxMessage, type StageStatus } from "../pipeline-core.ts";
import { processStartTime, reapProcs, registerProc, releaseProc, releaseProcessTree } from "../procs.ts";
import { reapRunResources } from "../resources.ts";
import { materialSession, recordMaterialSession, slimCompletedSession } from "../materials.ts";
import { parsePreparation } from "../preparation.ts";
import { isRegisteredSource, loadContext, projectRootHash, recordProjectOutcome, recordSourceChange, refreshContext } from "../project-context.ts";
import {
  DEFAULT_MAX_REPAIRS, DEFAULT_MODEL, DEFAULT_THINKING, DEFAULT_TIMEOUT_MIN,
  checkedFingerprint, errorText, lastAcceptance, newReviewState, runReviewRound, sourcesOnlyWorkspaceChange, tail,
  type ReviewConfig, type ReviewState,
} from "../review.ts";

const INTERRUPTED = "评审被中断（宿主超时或中断）";
/** Stop Hook 内部评审保护时长上限（分钟）；默认与 pi 扩展一致。 */
const DEFAULT_TIMEOUT_ENV = "AUTOREVIEW_REVIEW_TIMEOUT_MIN";

export interface HookEvent {
  hook_event_name?: string;
  cwd?: string;
  session_id?: string;
  transcript_path?: string;
  last_assistant_message?: string;
  stop_hook_active?: boolean;
  prompt?: string;
  /** Codex 扩展字段，用来识别宿主。 */
  turn_id?: string;
  [key: string]: unknown;
}

export interface HookState extends ReviewState {
  userInputVersion?: string; resumeAfterInputChange?: boolean;
  queueReadyEpoch?: string; queueInboxHandled?: number; queuePreparedSeq?: number;
  experienceActivity?: HookExperienceActivity;
  /** 本进程最近一次往交付总表写的段：同一完成态不重复追加，总结里的总表路径与它一致。 */
  ledger?: { session: string; path: string; pending: { id: string; kind: "部分验证" | "人工" }[]; failed?: boolean };
  /** 本会话已经注入过待回写提醒（同一会话只注入一次）。 */
  ledgerNoticed?: boolean;
}

export interface HookPaths {
  dir: string;
  state: string;
  summary: string;
  lock: string;
  /** 长进程登记（评审、验收方、被测系统）。 */
  procs: string;
}

interface HookContext {
  host: string;
  /** .autoreview.json 所在目录，只用于读配置。 */
  configRoot: string;
  /** 宿主会话工作目录：git 取证与评审都在这里。 */
  workDir: string;
  /** 宿主当前目录：只用于解析用户消息里的相对 @文件，不改变固定评审根。 */
  promptDir: string;
  sessionId: string;
  paths: HookPaths;
  exec: Exec;
  config: ReviewConfig;
  configError?: string;
  permissionMode?: string;
}

/**
 * 外部 exec：子进程 PATH 自己补 hermes 的 node；超时杀整个进程组并有界结束等待。
 * 带 role 的长进程登记到 procsFile：Hook 被宿主杀掉后，下一次事件据此清理。
 */
export const createChildExec = (procsFile?: string): Exec => (command, args, options) => new Promise<ExecResult>((resolvePromise) => {
  const token = randomUUID();
  // 项目方法要求的环境变量只覆盖指定项；进程登记和 PATH 仍由程序控制。
  const env = { ...process.env, ...(options.env ?? {}), AUTOREVIEW_PROCESS_OWNER: token, PATH: `${HERMES_BIN}:${process.env.PATH ?? ""}` };
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let killed = false;
  let done = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reapTimer: ReturnType<typeof setTimeout> | undefined;
  let registered: number | undefined;
  let started = "";
  let onAbort: (() => void) | undefined;
  let stopNotified = false, stopObservationFailed = false;
  const beforeStop = (): void => {
    if (stopNotified) return;
    stopNotified = true;
    try { options.onBeforeStop?.(); }
    catch (error) {
      stopObservationFailed = true;
      stderr.push(Buffer.from(`\nAUTOREVIEW_FAILURE=environment 调用终止状态观测失败：${errorText(error)}\n`));
    }
  };
  const finish = (code: number, killedFlag: boolean): void => {
    if (done) return;
    done = true;
    beforeStop();
    if (stopObservationFailed) code = 75;
    if (timer) clearTimeout(timer);
    if (reapTimer) clearTimeout(reapTimer);
    // 同一个 signal 会给很多次调用用：结束后摘掉监听，免得堆积，也免得事后误杀复用的进程组号。
    if (onAbort) options.signal?.removeEventListener("abort", onAbort);
    let processesReleased: boolean | undefined;
    if (options.role && child?.pid) {
      let released = false;
      try {
        released = registered !== undefined && procsFile ? releaseProc(procsFile, registered, {
          pgid: child.pid, role: options.role, command, started, token, ownerPid: process.pid, at: new Date().toISOString(),
        }) : releaseProcessTree({ pgid: child.pid, started, token });
      } catch { /* 无法确认时保留登记并阻止完成，不把已退出的原组当成全部释放。 */ }
      processesReleased = released;
      if (!released) {
        stderr.push(Buffer.from("\nAUTOREVIEW_FAILURE=environment 子进程释放未确认，登记已保留\n"));
        if (code === 0) code = 75;
      }
    }
    resolvePromise({
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
      code, killed: killedFlag,
      ...(processesReleased !== undefined ? { processesReleased } : {}),
    });
  };
  let child: ReturnType<typeof spawn> | undefined;
  try {
    // detached 让子进程成为进程组组长，超时或取消时可以连同后代一起杀掉。
    // 取消不交给 spawn 的 signal：它只杀组长，还会抢先结束，让下面的整组清理来不及跑。
    child = spawn(command, args, {
      cwd: options.cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true,
    });
  } catch (error) {
    process.stderr.write(`autoreview hook: 无法启动 ${command}：${errorText(error)}\n`);
    finish(1, false);
    return;
  }
  if (options.role && child.pid) started = processStartTime(child.pid);
  if (options.role && procsFile && child.pid) {
    try {
      registerProc(procsFile, child.pid, options.role, command, token);
      registered = child.pid;
    } catch (error) {
      stderr.push(Buffer.from(`AUTOREVIEW_FAILURE=environment 进程登记失败：${errorText(error)}\n`));
      beforeStop();
      killed = true;
      try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); }
    }
  }
  const collect = (target: Buffer[]) => (chunk: Buffer): void => {
    target.push(Buffer.from(chunk));
    options.onOutput?.(chunk.toString("utf8"));
  };
  child.stdout?.on("data", collect(stdout));
  child.stderr?.on("data", collect(stderr));
  child.on("error", (error) => {
    const aborted = (error as NodeJS.ErrnoException).name === "AbortError";
    finish(1, killed || aborted);
  });
  child.on("close", (code, signal) => finish(code ?? 1, killed || Boolean(signal)));
  const killTree = (): void => {
    beforeStop();
    killed = true;
    if (!child) return;
    const pid = child.pid;
    try {
      if (pid) process.kill(-pid, "SIGKILL");
      else child.kill("SIGKILL");
    } catch {
      try { child.kill("SIGKILL"); } catch { /* 已经退出 */ }
    }
    // 后代可能仍持有 stdout/stderr，close 不一定到达：有界清理，绝不无限等。
    if (!done) reapTimer ??= setTimeout(() => finish(137, true), 250);
  };
  // 取消（被测系统退出、会话关闭等）时和超时一样连同后代一起杀掉，不留验收方起的子进程。
  if (options.signal?.aborted) killTree();
  else if (options.signal) {
    onAbort = killTree;
    options.signal.addEventListener("abort", onAbort, { once: true });
  }
  if (options.timeout > 0) timer = setTimeout(killTree, options.timeout);
});

export const childExec: Exec = createChildExec();

/**
 * 宿主识别：AUTOREVIEW_HOST 可强制指定；Codex 的 UserPromptSubmit/Stop 带 turn_id，
 * 但 SessionStart 没有，所以再看宿主注入的环境变量与 transcript 路径。
 */
export function detectHost(event: HookEvent, env: NodeJS.ProcessEnv = process.env): string {
  const forced = env.AUTOREVIEW_HOST?.trim();
  if (forced) return forced;
  if (event.turn_id !== undefined && event.turn_id !== null) return "codex";
  const transcript = typeof event.transcript_path === "string" ? event.transcript_path : "";
  if (transcript.includes("/.codex/")) return "codex";
  if (transcript.includes("/.claude/")) return "claude";
  if (env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT) return "claude";
  // 两个宿主都会提供 CLAUDE_PLUGIN_ROOT，不能单凭兼容变量判为 Codex。
  if (env.PLUGIN_ROOT) return "codex";
  return "claude";
}

export { findProjectRoot };

const DEV_ROOT_ENV = "AUTOREVIEW_DEV_ROOT";

/** 启动器写入的项目根；没有或为空表示不是开发会话。 */
export function devProjectRoot(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env[DEV_ROOT_ENV]?.trim();
  return raw ? resolve(raw) : undefined;
}

/** 读 .autoreview.json（可以是 {}）；可选字段非法时抛错，由统一收口记暂停。 */
export function loadConfig(root: string, env: NodeJS.ProcessEnv = process.env): ReviewConfig {
  const data = readMarker(root);
  const envTimeout = Number.parseInt(env[DEFAULT_TIMEOUT_ENV] ?? "", 10);
  const config: ReviewConfig = {
    maxRepairs: nonNegativeInt(data, "maxRepairs", DEFAULT_MAX_REPAIRS),
    reviewerModel: nonEmptyString(data, "reviewerModel", DEFAULT_MODEL),
    reviewerThinking: nonEmptyString(data, "reviewerThinking", DEFAULT_THINKING),
    reviewTimeoutMin: Number.isFinite(envTimeout) && envTimeout > 0
      ? envTimeout : nonNegativeInt(data, "reviewTimeoutMin", DEFAULT_TIMEOUT_MIN),
    reviewerCmd: env.AUTOREVIEW_REVIEWER_CMD?.trim() ?? "",
  };
  const acceptance = parseAcceptanceConfig(data.acceptance, root, env);
  const gate = parseGateConfig(data.gate);
  checkRoundBudget(config.reviewTimeoutMin, acceptance, gate);
  const preparation = parsePreparation(data.preparation, root);
  return { ...config, configurationHash: configurationHash(data), ...(acceptance ? { acceptance } : {}), ...(gate ? { gate } : {}), ...(preparation ? { preparation } : {}) };
}

/** 注入给开发方的约定：配了验收再追加验收约定，配了门禁再追加门禁约定。 */
function conventionFor(ctx: HookContext): string {
  return conventionText({ acceptance: Boolean(ctx.config.acceptance), gate: ctx.config.gate?.cmd, experience: experienceInjection(ctx.configRoot) });
}

/** 状态和总结都放在 ~/.pi-autoreview/<项目目录名>/<宿主>-<会话id>.*。 */
export function hookPaths(projectDir: string, host: string, sessionId: string): HookPaths {
  const dir = hookExperienceDir(projectDir);
  const stem = `${safeName(host)}-${safeName(sessionId) || "unknown"}`;
  return {
    dir,
    state: join(dir, `${stem}.state.json`),
    summary: join(dir, `${stem}.md`),
    lock: join(dir, `${stem}.lock`),
    procs: join(dir, `${stem}.procs.json`),
  };
}

function safeName(text: string): string {
  return text.replace(/[^A-Za-z0-9._-]/g, "_");
}

export function sessionIdOf(event: HookEvent): string {
  const direct = typeof event.session_id === "string" ? event.session_id.trim() : "";
  if (direct) return direct;
  const transcript = typeof event.transcript_path === "string" ? event.transcript_path.trim() : "";
  if (transcript) return basename(transcript).replace(/\.[^.]*$/, "") || "unknown";
  return "unknown";
}

class StateCorruptError extends Error {
  constructor(detail: string) {
    super(`状态文件无法使用：${detail}`);
    this.name = "StateCorruptError";
  }
}

const PHASES = new Set(["idle", "reviewing", "done", "paused"]);

/** 只有文件不存在才初始化；读取/解析/结构非法都抛错，由统一收口暂停。 */
const USER_INPUT_CHANGED = "用户输入在检查期间更新，旧检查已停止";
const stateBases = new WeakMap<HookState, HookState>();
const inputKeys = ["requirement", "criteria", "grants", "inputsFingerprint", "userInputVersion", "resumeAfterInputChange"] as const;
const rememberState = (state: HookState): HookState => { stateBases.set(state, structuredClone(state)); return state; };
const copyInputs = (target: HookState, source: HookState): void => { for (const key of inputKeys) (target as any)[key] = source[key]; };

/** 只锁同步读改写；评审/模型和资源收尾从不持有这个短锁。 */
function withStateWriteLock<T>(file: string, action: () => T): T {
  const lock = `${file}.write.lock`, recovery = `${lock}.recovery`, token = randomUUID();
  const deadline = Date.now() + 2000;
  mkdirSync(dirname(file), { recursive: true });
  const owner = () => { try { return JSON.parse(readFileSync(join(lock, "owner.json"), "utf8")); } catch { return undefined; } };
  for (;;) {
    try { mkdirSync(lock); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const previous = owner();
      if (Number.isInteger(previous?.pid) && previous.pid > 1 && !processAlive(previous.pid)) {
        let elected = false;
        try {
          mkdirSync(recovery); elected = true;
          const current = owner();
          if (current?.token === previous.token && !processAlive(current.pid)) rmSync(lock, { recursive: true, force: true });
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
        finally { if (elected) rmSync(recovery, { recursive: true, force: true }); }
      }
      if (Date.now() >= deadline) throw new Error("状态写入忙或锁归属未确认，未覆盖已有状态");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try { writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, token })); return action(); }
  finally { rmSync(lock, { recursive: true, force: true }); }
}

function loadStateFile(file: string): HookState {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return rememberState(newReviewState());
    throw new StateCorruptError(`无法读取：${errorText(error)}`);
  }
  let data: unknown;
  try { data = JSON.parse(raw); } catch (error) { throw new StateCorruptError(`不是合法 JSON：${errorText(error)}`); }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new StateCorruptError("不是 JSON 对象");
  const state = { ...newReviewState(), ...(data as HookState) };
  if (!Array.isArray(state.rounds)) throw new StateCorruptError("rounds 不是数组");
  if (typeof state.repairs !== "number" || !Number.isFinite(state.repairs)) throw new StateCorruptError("repairs 不是数字");
  if (!PHASES.has(state.phase)) throw new StateCorruptError(`phase 非法：${String(state.phase)}`);
  return rememberState(state);
}

/** 收口路径专用：损坏时保留证据并回到新状态，保证不会再次抛出同一错误。 */
function loadStateFileForRecovery(file: string): HookState {
  try {
    return loadStateFile(file);
  } catch (error) {
    try {
      const evidence = `${file}.corrupt-${Date.now()}`;
      renameSync(file, evidence);
      process.stderr.write(`autoreview hook: 状态文件损坏，已保留到 ${evidence}：${errorText(error)}\n`);
    } catch (moveError) {
      process.stderr.write(`autoreview hook: 损坏状态文件无法保留：${errorText(moveError)}\n`);
    }
    return newReviewState();
  }
}

function writeStateFile(file: string, state: HookState): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, file);
}

function saveStateFile(file: string, state: HookState): void {
  withStateWriteLock(file, () => {
    const latest = loadStateFile(file), base = stateBases.get(state) ?? newReviewState();
    if (state.phase === "done" && latest.userInputVersion !== state.userInputVersion) throw new Error(USER_INPUT_CHANGED);
    const next = { ...latest };
    for (const key of new Set([...Object.keys(base), ...Object.keys(state)])) {
      if (JSON.stringify((base as any)[key]) !== JSON.stringify((state as any)[key])) (next as any)[key] = (state as any)[key];
    }
    if (latest.userInputVersion !== state.userInputVersion) copyInputs(next, latest);
    writeStateFile(file, next);
    stateBases.set(state, structuredClone(state));
  });
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** 锁文件存在且属于活进程；不存在、读不出或进程已死都算 false。 */
function lockAlive(lockPath: string): boolean {
  let pid: unknown;
  try { pid = (JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: unknown }).pid; } catch { pid = undefined; }
  return typeof pid === "number" && Number.isInteger(pid) && pid > 0 && processAlive(pid);
}

/** 返回 acquired（新建）/ busy（活进程持有）/ stale（死进程残留）。 */
function acquireLock(lockPath: string): "acquired" | "busy" | "stale" {
  try {
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { flag: "wx" });
    return "acquired";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return lockAlive(lockPath) ? "busy" : "stale";
}

function releaseLock(lockPath: string): void {
  try { rmSync(lockPath, { force: true }); } catch { /* 尽力 */ }
}

/** additionalContext 只给模型看；要让你看到的话放 systemMessage（只对 Claude Code 输出，Codex 是否支持未实测）。 */
function contextOutput(ctx: HookContext, eventName: string, additionalContext: string, userText?: string): string {
  const output: Record<string, unknown> = { hookSpecificOutput: { hookEventName: eventName, additionalContext } };
  if (userText && ctx.host === "claude") output.systemMessage = userText;
  return JSON.stringify(output);
}

/** Stop 时只给你看的一句话（不阻止停下）；不是 Claude Code 时不输出。 */
function userOutput(ctx: HookContext, text: string | undefined): string | undefined {
  return text && ctx.host === "claude" ? JSON.stringify({ systemMessage: text }) : undefined;
}

function contentText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts = content
    .filter((block): block is Record<string, unknown> => Boolean(block) && typeof block === "object")
    .map((block) => (typeof block.text === "string" ? block.text : ""))
    .filter((text) => text.length > 0);
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function assistantTextOf(record: unknown): string | undefined {
  if (!record || typeof record !== "object") return undefined;
  const obj = record as Record<string, unknown>;
  const payload = obj.payload && typeof obj.payload === "object" ? obj.payload as Record<string, unknown> : undefined;
  for (const candidate of [obj, payload]) {
    if (!candidate || candidate.role !== "assistant") continue;
    const text = contentText(candidate.content);
    if (text !== undefined) return text;
  }
  // Claude Code transcript：{"type":"assistant","message":{role,content}}。
  const message = obj.message && typeof obj.message === "object" ? obj.message as Record<string, unknown> : undefined;
  if (message?.role === "assistant") return contentText(message.content);
  return undefined;
}

/** 从 transcript（JSONL）里取最后一条助手消息；优先宿主的 last_assistant_message。 */
export function lastAssistantFromTranscript(jsonl: string): string {
  const lines = jsonl.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line) continue;
    let record: unknown;
    try { record = JSON.parse(line); } catch { continue; }
    const text = assistantTextOf(record);
    if (text !== undefined) return text;
  }
  return "";
}

export function lastAssistantMessage(event: HookEvent): string {
  if (typeof event.last_assistant_message === "string" && event.last_assistant_message.trim()) {
    return event.last_assistant_message;
  }
  const path = typeof event.transcript_path === "string" ? event.transcript_path : "";
  if (!path) return "";
  try { return lastAssistantFromTranscript(readFileSync(path, "utf8")); } catch { return ""; }
}

/** SessionStart 只有 10 秒时限，那里发通知要传更短的 timeoutMs。 */
async function notify(body: string, exec: Exec, timeoutMs = 15_000): Promise<void> {
  process.stderr.write(`[autoreview] ${body}\n`);
  try {
    const escaped = body.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    await exec("osascript", ["-e", `display notification "${escaped}" with title "自动评审"`], { cwd: homedir(), timeout: timeoutMs });
  } catch { /* 通知失败不影响评审结果 */ }
}

async function writeSummary(
  ctx: HookContext, state: HookState, status: "进行中" | "完成" | "暂停",
  pauseReason?: string, changedFiles?: string[], notes?: string,
): Promise<void> {
  let gitStatusShort: string;
  try {
    gitStatusShort = await createGitEvidence(ctx.exec, ctx.workDir).statusShort();
  } catch (error) {
    // 只有暂停总结允许降级；完成/进行中的取证失败向外抛，统一收口成暂停。
    if (status !== "暂停") throw error;
    gitStatusShort = `（${errorText(error)}；无法确认是否干净）`;
  }
  // 提交数只是记录，取不到就不写。
  let newCommits: number | undefined;
  try { if (state.baseline) newCommits = await createGitEvidence(ctx.exec, ctx.workDir).commitsSince(state.baseline); } catch { /* 不影响总结 */ }
  const todos = acceptanceTodos({
    acceptance: ctx.config.acceptance, host: ctx.host, phase: state.phase, pauseHint: state.pauseHint,
    criteria: state.criteria, lastAcceptance: lastAcceptance(state),
  });
  if (status === "完成") todos.push(...experienceTodos(ctx.configRoot, state.experienceDraft?.error));
  recordMaterialSession(materialSession(`${ctx.host}-${ctx.sessionId}`, ctx.workDir, ctx.paths.summary, state.phase,
    state.rounds.flatMap((round) => round.acceptance ? [round.acceptance.runDir] : [])));
  const text = renderSummary({
    materialCleanup: state.materialCleanup,
    cwd: ctx.workDir, devSessionId: `${ctx.host}-${ctx.sessionId}`, todos,
    reviewerSessionId: state.reviewerSessionId ?? deriveReviewerSessionId(`${ctx.host}-${ctx.sessionId}`),
    criteria: state.criteria, grants: state.grants, unresolvedAcceptance: state.unresolvedAcceptance,
    status, pauseReason, rounds: state.rounds, repairs: state.repairs,
    unresolvedMustFix: state.unresolvedMustFix, changedFiles, gitStatusShort, notes, newCommits,
    sourceChanges: state.sourceChanges, sourceChangeNote: state.sourceChangeNote,
    ledger: state.phase === "done" && state.ledger
      ? { path: state.ledger.path, pending: state.ledger.pending, failed: state.ledger.failed } : undefined,
  });
  mkdirSync(dirname(ctx.paths.summary), { recursive: true });
  writeFileSync(ctx.paths.summary, text);
}

/**
 * 完成时往交付总表追加一段：同一会话本完成态已登记过就不重复写；
 * 失败只提示，不暂停、不影响完成状态。
 */
async function recordLedger(ctx: HookContext, state: HookState): Promise<string | undefined> {
  const session = `${ctx.host}-${ctx.sessionId}`;
  if (state.ledger?.session === session) return undefined;
  // 只认本轮（最后一段）的验收结果，避免配置去掉后把旧记录当成当前欠项。
  const record = state.rounds[state.rounds.length - 1]?.acceptance;
  const pending = pendingItems(record);
  let problem: string | undefined;
  try {
    const path = appendLedgerRecord({
      project: projectRootOf(ctx.workDir), session, task: taskTitle(state.requirement),
      result: resultLine(record, state.rounds.length, state.repairs), summary: ctx.paths.summary, pending,
    });
    state.ledger = { session, path, pending };
  } catch (error) {
    problem = `交付总表写入失败：${errorText(error)}`;
    // 写入失败也在总结里写明该往哪查，但不冒充已登记。
    state.ledger = { session, path: deliveryLedgerPath(), pending, failed: true };
  }
  if (problem) {
    process.stderr.write(`[autoreview] ${problem}；会话照常完成\n`);
    await notify(`${basename(ctx.workDir)}：${problem}；会话照常完成`, ctx.exec);
  }
  return problem;
}

/** 暂停：存状态、写总结、尽力通知；每一步失败都不阻断下一步。hint 是给你的下一步。 */
async function pause(
  ctx: HookContext, state: HookState, reason: string, changedFiles?: string[], notes?: string, hint?: string,
): Promise<void> {
  try { const current = loadStateFile(ctx.paths.state); if (current.userInputVersion !== state.userInputVersion) copyInputs(state, current); } catch { /* 保留原错误现场 */ }
  state.phase = "paused";
  state.pauseReason = reason;
  state.pauseHint = hint;
  state.awaitingRepair = false;
  try { saveStateFile(ctx.paths.state, state); } catch (error) {
    process.stderr.write(`autoreview hook: 状态保存失败：${errorText(error)}\n`);
  }
  try { await writeSummary(ctx, state, "暂停", reason, changedFiles, notes); } catch (error) {
    process.stderr.write(`autoreview hook: 总结写入失败：${errorText(error)}\n`);
  }
  // Claude Code 里下一步走 systemMessage；其他宿主只有系统通知，就把下一步带上。
  await notify(`${basename(ctx.workDir)}：暂停（${reason}）${hint && ctx.host !== "claude" ? `。${hint}` : ""}`, ctx.exec);
}

/** 没有活进程持锁时，清掉上一个 Hook 被杀后留下的子进程。 */
function reapOrphans(ctx: HookContext): void {
  if (lockAlive(ctx.paths.lock)) return;
  for (const entry of [...reapProcs(ctx.paths.procs), ...reapProcs(`${ctx.paths.procs}.cleanup`)]) {
    process.stderr.write(`[autoreview] 已清理残留进程：${entry.role}（进程组 ${entry.pgid}）\n`);
  }
  reapRunResources();
}

async function sessionStart(ctx: HookContext): Promise<string | undefined> {
  reapOrphans(ctx);
  const state = loadStateFile(ctx.paths.state);
  state.experienceActivity = newHookActivity(ctx);
  saveStateFile(ctx.paths.state, state);
  experienceSession(ctx.configRoot, `${ctx.host}-${ctx.sessionId}`, true);
  if (state.enabled === false) return undefined;
  const git = createGitEvidence(ctx.exec, ctx.workDir);
  const repository = await git.isRepository();
  const head = repository ? await git.initialHead() : undefined;
  if (!repository || !head) {
    state.enabled = false;
    state.phase = "idle";
    saveStateFile(ctx.paths.state, state);
    return contextOutput(ctx, "SessionStart", repository ? "仓库还没有提交，自动评审已关闭" : "不是 git 仓库，自动评审已关闭");
  }
  // 开了验收但项目里没有（或是旧版）验收标准写法：每个会话提醒一次「复制【块 1】到哪」。
  let notice: string | undefined;
  if (ctx.config.acceptance && !state.conventionNoticed) {
    try { notice = conventionNotice(ctx.config.acceptance.root, ctx.host); } catch { notice = undefined; }
    if (notice) {
      state.conventionNoticed = true;
      if (ctx.host !== "claude") await notify(notice, ctx.exec, 3000);
    }
  }
  // 本项目有未回写的段才追加一句；读取失败、格式不认识或超时就跳过，不报错、不拦截。
  // 提醒同时进 additionalContext（协调方 AI 要看到）和 systemMessage（人能看到；Codex 只有通知）。
  const reminder = state.ledgerNoticed ? undefined : ledgerReminder(ctx);
  if (reminder) {
    state.ledgerNoticed = true;
    notice = notice ? `${notice}\n${reminder}` : reminder;
    if (ctx.host !== "claude") await notify(reminder, ctx.exec, 3000);
  }
  saveStateFile(ctx.paths.state, state);
  return contextOutput(ctx, "SessionStart", reminder ? `${conventionFor(ctx)}\n${reminder}` : conventionFor(ctx), notice);
}

/** SessionStart 的待回写提醒：只看本项目，失败一律当作没有提醒。 */
function ledgerReminder(ctx: HookContext): string | undefined {
  try {
    const text = readLedgerForReminder();
    return text === undefined ? undefined : writebackReminder(text, projectRootOf(ctx.workDir));
  } catch { return undefined; }
}

/**
 * 你再提交消息就是接管：解除暂停、清掉被中断评审的残留（死锁、卡住的 reviewing），
 * 下一次 Stop 照常自动评审，返修计数重新算。活进程还在评审时一律不动。
 * Stop 的 block 续跑不经过 UserPromptSubmit；即使经过，那时 phase 已是 idle、锁已释放。
 */
function resumeOnPrompt(ctx: HookContext, state: HookState): void {
  if (lockAlive(ctx.paths.lock)) return;
  // 锁的持有者死了，它起的评审等子进程可能还活着：先清掉，再算恢复。
  reapOrphans(ctx);
  releaseLock(ctx.paths.lock);
  if (state.phase !== "paused" && state.phase !== "reviewing") return;
  const previous = state.phase === "paused" ? `暂停：${state.pauseReason ?? "未知原因"}` : INTERRUPTED;
  process.stderr.write(`[autoreview] 已恢复自动评审（上次${previous}）\n`);
  state.phase = "idle";
  state.pauseReason = undefined;
  state.pauseHint = undefined;
  state.awaitingRepair = false;
  state.repairs = 0;
}

/** 引用文件的上限：最多 3 个，每个不超过 200KB，二进制不读。 */
const MAX_REF_FILES = 3;
const MAX_REF_BYTES = 200 * 1024;

/**
 * 宿主交给 Hook 的 prompt 不展开「@文件」（pi 会展开）：把能读到的引用文件原文附在后面，
 * 需求原文和验收标准都按展开后的算，两个宿主与 pi 一致。读不到的 @ 当普通文字。
 */
export function expandFileRefs(prompt: string, cwd: string): string {
  const blocks: string[] = [];
  const seen = new Set<string>();
  for (const match of prompt.matchAll(/(?:^|\s)@("[^"]+"|\S+)/g)) {
    const ref = match[1].replace(/^"|"$/g, "").replace(/[，。,.;；:：)）]+$/, "");
    if (!ref || seen.has(ref) || blocks.length >= MAX_REF_FILES) continue;
    seen.add(ref);
    const path = resolve(cwd, ref.startsWith("~/") ? join(homedir(), ref.slice(2)) : ref);
    try {
      const stat = statSync(path);
      if (!stat.isFile() || stat.size > MAX_REF_BYTES) continue;
      const text = readFileSync(path, "utf8");
      if (!text.includes("\0")) blocks.push(`\n\n--- @${ref} ---\n${text}`);
    } catch { /* 不是文件 */ }
  }
  return `${prompt}${blocks.join("")}`;
}

type ActivityContext = Pick<HookContext, "configRoot" | "host" | "sessionId" | "paths">;
function newHookActivity(ctx: ActivityContext): HookExperienceActivity {
  const activity: HookExperienceActivity = { root: ctx.configRoot, host: ctx.host, session: ctx.sessionId, turn: randomUUID(), active: true,
    ...(process.env.AUTOREVIEW_DEV_RUN_ID ? { runId: process.env.AUTOREVIEW_DEV_RUN_ID } : {}) };
  // 身份取证失败只能留下待核对状态，不能成为用户授权/输入版本落盘的前置条件。
  try { activity.projectId = projectRootHash(ctx.configRoot); } catch { /* 无身份记录按旧版保守核对 */ }
  return activity;
}
/** 只结束当前回合；旧 Stop 或旧启动器不得清掉新输入/另一次启动的活动记录。 */
function releaseHookExperience(ctx: ActivityContext, turn: string | undefined, ownStop = false): void {
  withStateWriteLock(ctx.paths.state, () => {
    const current = loadStateFile(ctx.paths.state);
    if (current.experienceActivity?.turn !== turn || current.phase !== "done" || current.awaitingRepair || current.resumeAfterInputChange
      || (!ownStop && lockAlive(ctx.paths.lock))) return;
    // 登记损坏不等于消费者已结束，不使用容错的 readProcs，也不按 PID 猜测归属。
    const stopped = [ctx.paths.procs, `${ctx.paths.procs}.cleanup`].every((file) => {
      try {
        if (!lstatSync(file).isFile()) return false;
        const entries = JSON.parse(readFileSync(file, "utf8")); return Array.isArray(entries) && entries.length === 0;
      }
      catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
    });
    if (!stopped) return;
    current.experienceActivity = { ...(current.experienceActivity ?? newHookActivity(ctx)), active: false };
    writeStateFile(ctx.paths.state, current);
    experienceSession(ctx.configRoot, `${ctx.host}-${ctx.sessionId}`, false);
  });
}
/** loop-dev 已观测所启动宿主退出；仅处理该次随机启动身份关联的已完成会话。 */
export function endHostExperienceSessions(root: string, host: string, runId: string): void {
  for (const { file, activity } of hookExperienceStates(root)) {
    if (activity.host !== host || activity.runId !== runId) continue;
    const paths = hookPaths(root, host, activity.session);
    if (paths.state !== file) throw new Error(`宿主结束时会话身份无法核对：${file}`);
    releaseHookExperience({ configRoot: root, host, sessionId: activity.session, paths }, activity.turn);
  }
}

function reportQueueStage(ctx: HookContext, state: HookState, event: "started" | "done"): void {
  const pid = Number(process.env.AUTOREVIEW_DEV_PID) || process.ppid;
  const status = { sessionId: ctx.sessionId, host: ctx.host, pid, processStarted: process.env.AUTOREVIEW_DEV_STARTED || processStartTime(pid),
    inputBridge: process.env.AUTOREVIEW_DEV_INPUT_BRIDGE, summary: ctx.paths.summary,
    event, readyEpoch: event === "done" ? state.queueReadyEpoch : undefined, sourceInputs: state.inputsFingerprint, inbox: state.queueInboxHandled ?? 0 };
  const dir = process.env.AUTOREVIEW_PIPELINE_DIR, stage = process.env.AUTOREVIEW_STAGE;
  if (dir && stage) bindHookInputBridge(dir, stage, status, { socket: process.env.CLAUDE_CODE_MESSAGING_SOCKET,
    token: process.env.CLAUDE_CODE_MESSAGING_TOKEN, mode: ctx.permissionMode });
  queueStageEvent({ cwd: ctx.workDir, file: process.env.AUTOREVIEW_BATCH_FILE, stage, status });
}
async function consumeQueueInbox(ctx: HookContext, state: HookState, expectedSeq?: number, stillIdle?: () => boolean, prepareOnly = false): Promise<string | undefined> {
  const dir = process.env.AUTOREVIEW_PIPELINE_DIR, stage = process.env.AUTOREVIEW_STAGE;
  if (!dir || !stage) return undefined;
  const inbox = readJson<InboxMessage>(inboxPath(dir, stage));
  if (!inbox || !inbox.message.startsWith("【合入队列返修】") || inbox.seq <= (state.queueInboxHandled ?? 0)
    || (expectedSeq !== undefined && inbox.seq !== expectedSeq)) return undefined;
  if (lockAlive(ctx.paths.lock)) return undefined;
  if (state.queuePreparedSeq === inbox.seq) {
    if (!prepareOnly) {
      state.queueInboxHandled = inbox.seq; state.queuePreparedSeq = undefined;
      saveStateFile(ctx.paths.state, state); reportQueueStage(ctx, state, "started");
    }
    return inbox.message;
  }
  const snap = await createGitEvidence(ctx.exec, ctx.workDir).snapshot();
  if (stillIdle && !stillIdle()) return undefined;
  state.lastSnapshot = snap.ref; state.lastUntracked = snap.untracked.map(({ path }) => path);
  state.lastFingerprint = snap.fingerprint; state.lastCheckedFingerprint = snap.fingerprint;
  state.scopeBaseline = snap.ref; state.scopeBaselineUntrackedDetails = snap.untracked;
  state.unresolvedMustFix = inbox.mustFix;
  if (!prepareOnly) state.queueInboxHandled = inbox.seq;
  state.queuePreparedSeq = prepareOnly ? inbox.seq : undefined; state.queueReadyEpoch = undefined;
  state.phase = "idle"; state.awaitingRepair = false; state.pauseReason = undefined; state.pauseHint = undefined;
  state.ledger = undefined; state.resumeAfterInputChange = true;
  saveStateFile(ctx.paths.state, state);
  reportQueueStage(ctx, state, "started");
  return inbox.message;
}
/** 原生收件通道发送前先固定返修基线；这不是用户输入，不改授权/标准，也不调用模型。 */
async function prepareNativeQueueRepair(ctx: HookContext, event: HookEvent): Promise<string> {
  const dir = process.env.AUTOREVIEW_PIPELINE_DIR, stage = process.env.AUTOREVIEW_STAGE;
  const token = process.env.AUTOREVIEW_DEV_INPUT_BRIDGE, pid = Number(process.env.AUTOREVIEW_DEV_PID) || process.ppid;
  const seq = dir && stage && token && typeof event.prompt === "string" ? bridgeRepairSequence(dir, stage,
    { sessionId: ctx.sessionId, host: ctx.host, pid, processStarted: process.env.AUTOREVIEW_DEV_STARTED || processStartTime(pid), inputBridge: token }, event.prompt) : undefined;
  const refused = () => JSON.stringify({ ok: false });
  if (seq === undefined || !dir || !stage || ctx.configError) return refused();
  const state = loadStateFile(ctx.paths.state), inbox = readJson<InboxMessage>(inboxPath(dir, stage));
  if (state.enabled === false || !inbox || inbox.seq !== seq || lockAlive(ctx.paths.lock)) return refused();
  if ((state.queueInboxHandled ?? 0) >= seq || state.queuePreparedSeq === seq) return JSON.stringify({ ok: true, seq }); // 已准备的重试不能重置基线。
  const expected = readJson<StageStatus>(statusPath(dir, stage));
  const inputVersion = state.userInputVersion;
  const stillIdle = () => {
    const current = readJson<StageStatus>(statusPath(dir, stage));
    return state.phase === "done" && expected?.event === "done" && current?.event === "done" && current.sessionId === ctx.sessionId
      && current.inputBridge === token && current.readyEpoch === expected.readyEpoch && !lockAlive(ctx.paths.lock)
      && loadStateFile(ctx.paths.state).userInputVersion === inputVersion;
  };
  if (!stillIdle() || !await consumeQueueInbox(ctx, state, seq, stillIdle, true)) return refused();
  await writeSummary(ctx, state, "进行中", undefined, undefined, "合入队列返修已准备，等待原生收件通道处理；修复前基线和业务计数保留。");
  return JSON.stringify({ ok: true, seq });
}

async function userPromptSubmit(ctx: HookContext, event: HookEvent): Promise<string | undefined> {
  const raw = typeof event.prompt === "string" ? event.prompt : "";
  const expanded = expandFileRefs(raw, ctx.promptDir);
  const dir = process.env.AUTOREVIEW_PIPELINE_DIR, stage = process.env.AUTOREVIEW_STAGE;
  const pid = Number(process.env.AUTOREVIEW_DEV_PID) || process.ppid;
  const dispatched = dir && stage && process.env.AUTOREVIEW_DEV_INPUT_BRIDGE ? bridgeRepairSequence(dir, stage,
    { sessionId: ctx.sessionId, host: ctx.host, pid, processStarted: process.env.AUTOREVIEW_DEV_STARTED || processStartTime(pid), inputBridge: process.env.AUTOREVIEW_DEV_INPUT_BRIDGE }, raw) : undefined;
  const machine = dispatched !== undefined || isLoopMessage(raw) || /--- @[^\n]+ ---\n【合入队列返修】/.test(expanded);
  if (machine) {
    const state = loadStateFile(ctx.paths.state), repair = await consumeQueueInbox(ctx, state, dispatched);
    return contextOutput(ctx, "UserPromptSubmit", [conventionFor(ctx), repair].filter(Boolean).join("\n\n"));
  }
  // 相对引用保持宿主当前目录语义；固定项目根只用于配置、Git 取证、状态和评审。
  const prompt = expandFileRefs(typeof event.prompt === "string" ? event.prompt : "", ctx.promptDir);
  const typed = typedByUser(typeof event.prompt === "string" ? event.prompt : "");
  let notice: string | undefined, criteriaNotice: string | undefined, invalidatedDone = false;
  // 权限和标准先独立落盘；配置、来源索引、Git 都不得成为吞掉撤权的前置条件。
  withStateWriteLock(ctx.paths.state, () => {
    const state = loadStateFile(ctx.paths.state);
    const before = JSON.stringify(inputKeys.slice(0, 4).map((key) => state[key]));
    const wasRunning = lockAlive(ctx.paths.lock), wasDone = state.phase === "done";
    if (state.enabled !== false) resumeOnPrompt(ctx, state);
    if (state.requirement === undefined && prompt.trim()) state.requirement = prompt;
    const criteria = criteriaFromUser(prompt, state.criteria);
    if (criteria) { state.criteria = criteria; state.grants = undefined; criteriaNotice = `已记录验收标准第 ${criteria.version} 版（${criteria.items.length} 条）`; }
    const grants = grantsFromUser(typed, state.criteria, state.grants);
    if (grants && state.criteria) { state.grants = grants; notice = `自动验收：已记录你的授权（${authorizationLine(state.criteria, grants) ?? "标准里没有对应的条目"}）`; }
    if (before !== JSON.stringify(inputKeys.slice(0, 4).map((key) => state[key]))) {
      state.userInputVersion = randomUUID();
      if (wasRunning || state.rounds.length > 0) state.resumeAfterInputChange = true;
      if (wasDone) { state.phase = "idle"; state.pauseReason = undefined; invalidatedDone = true; }
    }
    state.experienceActivity = newHookActivity(ctx);
    writeStateFile(ctx.paths.state, state);
  });
  if (criteriaNotice) process.stderr.write(`[autoreview] ${criteriaNotice}\n`);
  if (notice) process.stderr.write(`[autoreview] ${notice}\n`);
  if (notice && ctx.host !== "claude") await notify(notice, ctx.exec, 3000);
  let state = loadStateFile(ctx.paths.state);
  reportQueueStage(ctx, state, "started");
  // 授权与输入版本已经独立落盘；经验锁、登记读写失败不能吞掉撤权或旧检查的取消信号。
  experienceSession(ctx.configRoot, `${ctx.host}-${ctx.sessionId}`, true);
  if (state.enabled === false) return contextOutput(ctx, "UserPromptSubmit", conventionFor(ctx), notice);
  if (ctx.configError) {
    await pause(ctx, state, "项目配置不可用，用户输入已保存", undefined, ctx.configError,
      `当前 AUTOREVIEW_DEV_ROOT=${ctx.workDir}；修正它指向的项目根后再提交。`);
    return userOutput(ctx, [`自动评审暂停（项目配置不可用）。${ctx.configError}`, notice].filter(Boolean).join("\n"));
  }
  if (state.baseline === undefined && state.requirement?.trim() && !lockAlive(ctx.paths.lock)) {
    const snap = await createGitEvidence(ctx.exec, ctx.workDir).snapshot();
    state.baseline = snap.ref; state.baselineUntracked = snap.untracked.map(({ path }) => path); state.baselineFingerprint = snap.fingerprint;
    saveStateFile(ctx.paths.state, state);
  }
  const contextConfig = loadContext(ctx.workDir);
  const context = contextConfig ? refreshContext(contextConfig, prompt) : undefined;
  if (context?.snapshot.missing.length) {
    // 缺失是配置错误，照旧暂停并写明缺哪个文件。
    await pause(ctx, state, `上游来源缺失：${context.snapshot.missing.join("、")}`, undefined, undefined, "补齐 context.sources 登记的文件后再提交。");
    return userOutput(ctx, notice);
  }
  if (context) {
    let sourceChanged = false;
    withStateWriteLock(ctx.paths.state, () => {
      const current = loadStateFile(ctx.paths.state);
      if (current.inputsFingerprint === undefined) {
        current.inputsFingerprint = context.snapshot.inputsFingerprint;
        writeStateFile(ctx.paths.state, current);
      } else if (current.inputsFingerprint !== context.snapshot.inputsFingerprint) {
        // 来源内容变化不再撤销完成资格：更新版本、记一笔，由总结呈现。
        recordSourceChange(current, context.changes, context.snapshot.revision);
        current.inputsFingerprint = context.snapshot.inputsFingerprint;
        writeStateFile(ctx.paths.state, current);
        sourceChanged = true;
      }
    });
    if (sourceChanged) {
      state = loadStateFile(ctx.paths.state);
      if (state.phase === "done") await writeSummary(ctx, state, "完成");
    }
  }
  if (invalidatedDone) { state = loadStateFile(ctx.paths.state); await writeSummary(ctx, state, "进行中", undefined, undefined, "用户输入已更新，旧完成资格已撤销。"); }
  return contextOutput(ctx, "UserPromptSubmit", conventionFor(ctx), notice);
}

/**
 * Stop 持锁期间宿主发来 SIGTERM/SIGINT/SIGHUP：杀掉本进程登记的子进程组，
 * 状态记暂停「评审被中断」，释放锁再退出。SIGKILL 拦不住，交给下一次事件清理。
 */
function guardSignals(ctx: HookContext, controller: AbortController, finished: () => Promise<void>, cleanupRecord: () => string | undefined): () => void {
  const signals: NodeJS.Signals[] = ["SIGTERM", "SIGINT", "SIGHUP"];
  let stopping = false;
  const handler = (signal: NodeJS.Signals): void => {
    if (stopping) return;
    stopping = true;
    controller.abort();
    try { reapProcs(ctx.paths.procs, { ownerPid: process.pid }); } catch { /* 失败保留登记 */ }
    void (async () => {
      try {
        // 业务执行已取消；独立 cleanup 有自己的超时，完成后才释放宿主锁。
        await finished();
        const state = loadStateFile(ctx.paths.state);
        state.phase = "paused"; state.pauseReason = INTERRUPTED; state.awaitingRepair = false;
        saveStateFile(ctx.paths.state, state);
        const path = cleanupRecord();
        let detail = path ? `外部资源释放记录：${path}` : undefined;
        if (path) { try { const record = JSON.parse(readFileSync(path, "utf8")); detail = `外部资源释放：${record.status}；记录：${path}；${record.reason ?? ""}`; } catch { /* 未确认 */ } }
        await writeSummary(ctx, state, "暂停", INTERRUPTED, undefined, detail);
      } catch (error) { process.stderr.write(`[autoreview] 中断收尾未确认：${errorText(error)}\n`); }
      finally {
        releaseLock(ctx.paths.lock);
        process.stderr.write(`[autoreview] 收到 ${signal}，已等待资源收尾并暂停\n`);
        process.exit(signal === "SIGINT" ? 130 : signal === "SIGHUP" ? 129 : 143);
      }
    })();
  };
  for (const signal of signals) process.on(signal, handler);
  return () => { for (const signal of signals) process.off(signal, handler); };
}

/** 未交付提醒已按新规则移除：无标记但有改动时直接评审。 */
async function stop(ctx: HookContext, event: HookEvent): Promise<string | undefined> {
  let state = loadStateFile(ctx.paths.state);
  if (state.enabled === false) return undefined;
  const prepared = state.queuePreparedSeq;
  const queuedRepair = await consumeQueueInbox(ctx, state);
  if (queuedRepair && prepared === undefined) return JSON.stringify({ decision: "block", reason: queuedRepair });
  // 原生通道可能不触发 UserPromptSubmit；首次 Stop 仅确认收件，按发送前的基线评审修复。
  const text = lastAssistantMessage(event);
  const marker = classifyMarker(text);
  if (marker === "decision") {
    if (state.phase === "paused") return undefined;
    await pause(ctx, state, "开发方需要你决定");
    return undefined;
  }
  // 暂停状态不自动评审，等你再提交消息（UserPromptSubmit 解除，与 pi 扩展一致）。
  if (state.phase === "paused" && !state.resumeAfterInputChange) return undefined;
  if (marker === "none" && !state.resumeAfterInputChange) {
    const baseline = checkedFingerprint(state);
    if (!baseline) return undefined;
    const current = await createGitEvidence(ctx.exec, ctx.workDir).snapshot();
    if (current.fingerprint === baseline) {
      if (state.awaitingRepair) await pause(ctx, state, "返修后没有任何改动");
      else releaseHookExperience(ctx, state.experienceActivity?.turn);
      return undefined;
    }
    // 没有交付标记但有未评审改动：直接评审，与写了【交付完成】一样。
  }

  const lock = withStateWriteLock(ctx.paths.state, () => acquireLock(ctx.paths.lock));
  if (lock === "stale") {
    reapProcs(ctx.paths.procs);
    releaseLock(ctx.paths.lock);
    await pause(ctx, state, INTERRUPTED);
    return undefined;
  }
  if (lock === "busy") {
    if (state.resumeAfterInputChange) return JSON.stringify({ decision: "block", reason: "【流程等待】上一轮正在按新输入停止并释放资源；等待它结束后再交付，无需修改产品。" });
    process.stderr.write("autoreview hook: 已有评审在进行，放行\n");
    return undefined;
  }
  state = withStateWriteLock(ctx.paths.state, () => loadStateFile(ctx.paths.state));
  const userInputVersion = state.userInputVersion;
  const repairsBefore = state.repairs;
  const controller = new AbortController();
  const changedInputReason = USER_INPUT_CHANGED;
  let inputStamp = "";
  const checkUserInputs = (force = true): void => {
    controller.signal.throwIfAborted();
    try {
      const stat = statSync(ctx.paths.state), stamp = `${stat.ino}:${stat.mtimeMs}:${stat.size}`;
      if (force || stamp !== inputStamp) {
        inputStamp = stamp;
        if (loadStateFile(ctx.paths.state).userInputVersion !== userInputVersion) throw new Error(changedInputReason);
      }
    } catch { controller.abort(new Error(changedInputReason)); }
    controller.signal.throwIfAborted();
  };
  const inputWatch = setInterval(() => { try { checkUserInputs(false); } catch { /* 主任务处理取消 */ } }, 250);
  inputWatch.unref();
  let running: Promise<void> = Promise.resolve();
  let cleanupRecord: string | undefined;
  const unguard = guardSignals(ctx, controller, () => running, () => cleanupRecord);
  try {
    // 上一轮已完成后再次交付：按 pi 规则开新一轮，返修计数清零。
    if (state.phase === "done" && !state.resumeAfterInputChange) state.repairs = 0;
    // 同一会话返修后再次完成：新的一段重新登记，旧段仍按自己的勾选处理。
    state.ledger = undefined;
    state.resumeAfterInputChange = false;
    state.phase = "reviewing";
    state.materialCleanup = undefined;
    state.pauseReason = undefined;
    state.awaitingRepair = false;
    saveStateFile(ctx.paths.state, state);
    experienceSession(ctx.configRoot, `${ctx.host}-${ctx.sessionId}`, true);
    const round = state.rounds.length + 1;
    const work = runReviewRound({
      cwd: ctx.workDir, devSessionId: `${ctx.host}-${ctx.sessionId}`, round,
      deliveryNote: text, state, config: ctx.config, getConfig: () => loadConfig(ctx.configRoot), exec: ctx.exec,
      signal: controller.signal, checkLive: checkUserInputs,
      cleanupExec: createChildExec(`${ctx.paths.procs}.cleanup`), onCleanup: (_work, path) => { cleanupRecord = path; },
      writeInput: (name, content) => {
        mkdirSync(ctx.paths.dir, { recursive: true });
        const file = join(ctx.paths.dir, name);
        writeFileSync(file, content);
        return file;
      },
      // 完成总结等状态和总表落盘后再写，避免外部把“总结已出现”当成终态抢先结束会话。
      writeSummary: (status) => writeSummary(ctx, state, status === "完成" ? "进行中" : status),
      saveState: () => saveStateFile(ctx.paths.state, state),
      acceptanceDir: join(ctx.paths.dir, "acceptance", basename(ctx.paths.state, ".state.json")),
      procsFile: ctx.paths.procs,
    });
    running = work.then(() => {}, () => {});
    const outcome = await work;
    controller.signal.throwIfAborted();
    if (outcome.kind === "done") {
      const previousDraft = state.experienceDraft?.signature;
      const drafting = finishExperience({ cwd: ctx.configRoot, session: `${ctx.host}-${ctx.sessionId}`, state,
        config: ctx.config, exec: ctx.exec, signal: controller.signal, summary: ctx.paths.summary });
      running = drafting;
      await drafting;
      checkUserInputs();
      const context = loadContext(ctx.workDir);
      if (previousDraft !== state.experienceDraft?.signature) {
        // 独立调用可能等待数分钟；不能沿用等待前的候选与配置发布完成。
        const git = createGitEvidence(ctx.exec, ctx.workDir, controller.signal), candidate = await git.snapshot();
        checkUserInputs();
        const before = state.lastSnapshotDetails;
        const sourcesOnly = context && before && candidate.fingerprint !== state.lastFingerprint
          ? await sourcesOnlyWorkspaceChange(git, before, candidate, (path) => isRegisteredSource(context, ctx.workDir, path)) : false;
        if ((candidate.fingerprint !== state.lastFingerprint && !sourcesOnly) || JSON.stringify(loadConfig(ctx.configRoot)) !== JSON.stringify(ctx.config)) {
          await pause(ctx, state, "经验起草期间候选或配置已变化，原检查结果已失效");
          return undefined;
        }
      }
      // 发布前核对来源：内容变化不阻塞，缺失就不写交付、不发完成。
      const sourceProblem = context ? recordProjectOutcome(context, `${ctx.host}-${ctx.sessionId}`, "done", ctx.paths.summary) : undefined;
      if (sourceProblem) {
        await pause(ctx, state, sourceProblem, undefined, undefined, "补齐 context.sources 登记的文件后再接力。");
        return userOutput(ctx, sourceProblem);
      }
      state.phase = "done";
      state.awaitingRepair = false;
      await recordLedger(ctx, state);
      try { saveStateFile(ctx.paths.state, state); } catch (error) {
        process.stderr.write(`autoreview hook: 状态保存失败：${errorText(error)}\n`);
      }
      checkUserInputs();
      state.materialCleanup = slimCompletedSession(materialSession(`${ctx.host}-${ctx.sessionId}`, ctx.workDir, ctx.paths.summary, state.phase,
        state.rounds.flatMap((round) => round.acceptance ? [round.acceptance.runDir] : [])));
      saveStateFile(ctx.paths.state, state);
      // 状态和总表都落盘后再发布完成总结。
      await writeSummary(ctx, state, "完成");
      state.queueReadyEpoch = randomUUID(); saveStateFile(ctx.paths.state, state);
      reportQueueStage(ctx, state, "done");
      const done = `完成（评审 ${state.rounds.length} 次，返修 ${state.repairs} 次）`;
      await notify(`${basename(ctx.workDir)}：${done}${outcome.hint ? `；${outcome.hint}` : ""}`, ctx.exec);
      checkUserInputs();
      releaseHookExperience(ctx, state.experienceActivity?.turn, true);
      return userOutput(ctx, outcome.hint && `自动评审${done}。${outcome.hint}`);
    }
    if (outcome.kind === "paused") {
      const reason = outcome.reason ?? "评审失败";
      await pause(ctx, state, reason, outcome.changedFiles, outcome.notes, outcome.hint);
      return userOutput(ctx, outcome.hint && `自动评审暂停（${reason}）。${outcome.hint}`);
    }
    state.phase = "idle";
    saveStateFile(ctx.paths.state, state);
    return JSON.stringify({ decision: "block", reason: outcome.message ?? "" });
  } catch (error) {
    if ((error as Error)?.message === changedInputReason) controller.abort(error);
    if (!controller.signal.aborted) throw error;
    if ((controller.signal.reason as Error)?.message === changedInputReason) {
      try { copyInputs(state, loadStateFile(ctx.paths.state)); } catch { /* 暂停保留诊断 */ }
      state.repairs = repairsBefore; state.resumeAfterInputChange = true;
      await pause(ctx, state, changedInputReason, undefined, "最新标准和授权已保留；下次交付按新输入继续，不计业务返修。");
    }
    return undefined; // 操作系统信号由信号处理器负责记录并退出。
  } finally {
    clearInterval(inputWatch);
    if (!controller.signal.aborted || (controller.signal.reason as Error)?.message === changedInputReason) { unguard(); releaseLock(ctx.paths.lock); }
  }
}

/** 没有 AUTOREVIEW_DEV_ROOT 的直接会话：只允许 SessionStart 的待回写提醒，其他一律不动作。 */
function passiveSessionStart(event: HookEvent, host: string, workDir: string): string | undefined {
  if (event.hook_event_name !== "SessionStart") return undefined;
  let reminder: string | undefined;
  try {
    const text = readLedgerForReminder();
    reminder = text === undefined ? undefined : writebackReminder(text, projectRootOf(workDir));
  } catch { reminder = undefined; }
  if (!reminder) return undefined;
  const output: Record<string, unknown> = { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: reminder } };
  if (host === "claude") output.systemMessage = reminder;
  return JSON.stringify(output);
}

/** 开发会话的项目根不可用：按项目配置不可用暂停，不留“内部错误”的误导。 */
async function configUnavailable(ctx: HookContext): Promise<string | undefined> {
  const detail = ctx.configError ?? "项目配置不可用";
  const state = loadStateFileForRecovery(ctx.paths.state);
  await pause(ctx, state, "项目配置不可用", undefined, detail,
    `当前 AUTOREVIEW_DEV_ROOT=${ctx.workDir}；修正它指向的项目根（须有 .autoreview.json）后再提交。`);
  return userOutput(ctx, `自动评审暂停（项目配置不可用）。${detail}`);
}

async function dispatch(event: HookEvent): Promise<string | undefined> {
  const host = detectHost(event), sessionId = sessionIdOf(event);
  const eventCwd = resolve(event.cwd?.trim() || process.cwd());
  const root = devProjectRoot();
  // 不是 bin/loop-dev 启动的会话：评审相关的事一律不做，只保留总表待回写提醒。
  if (!root) return passiveSessionStart(event, host, eventCwd);
  const paths = hookPaths(root, host, sessionId), kind = event.hook_event_name;
  const marker = join(root, MARKER_FILE);
  let config: ReviewConfig = { maxRepairs: DEFAULT_MAX_REPAIRS, reviewerModel: DEFAULT_MODEL, reviewerThinking: DEFAULT_THINKING, reviewTimeoutMin: DEFAULT_TIMEOUT_MIN, reviewerCmd: "" };
  let configError: string | undefined;
  if (!existsSync(marker)) {
    configError = `项目配置不可用（AUTOREVIEW_DEV_ROOT=${root}）：${marker} 不存在`;
  } else {
    try { config = loadConfig(root); }
    catch (error) {
      // 与现有行为一致：只有 UserPromptSubmit 把配置错误收成暂停，其他事件仍走内部错误收口。
      if (kind !== "UserPromptSubmit") throw error;
      configError = `项目配置不可用（AUTOREVIEW_DEV_ROOT=${root}）：${errorText(error)}`;
    }
  }
  const ctx: HookContext = { host, configRoot: root, workDir: root, promptDir: eventCwd, sessionId, paths, exec: createChildExec(paths.procs), config, configError,
    permissionMode: typeof event.permission_mode === "string" ? event.permission_mode : undefined };
  if (kind === "SessionStart") return configError ? configUnavailable(ctx) : sessionStart(ctx);
  if (kind === "UserPromptSubmit") return userPromptSubmit(ctx, event);
  if (kind === "LoopQueueRepair") return prepareNativeQueueRepair(ctx, event);
  if (kind === "Stop") return configError ? configUnavailable(ctx) : stop(ctx, event);
  return undefined;
}

/** 异常收口：开发会话才记暂停、写总结、尽力通知，然后放行（退出 0）。 */
async function recover(event: HookEvent, error: unknown): Promise<undefined> {
  const detail = errorText(error);
  process.stderr.write(`autoreview hook 内部错误：${detail}\n`);
  const root = devProjectRoot();
  if (!root) return undefined;
  const host = detectHost(event);
  const sessionId = sessionIdOf(event);
  const ctx: HookContext = {
    host, configRoot: root, workDir: root, promptDir: resolve(event.cwd?.trim() || process.cwd()),
    sessionId, paths: hookPaths(root, host, sessionId), exec: childExec,
    config: { maxRepairs: DEFAULT_MAX_REPAIRS, reviewerModel: DEFAULT_MODEL, reviewerThinking: DEFAULT_THINKING, reviewTimeoutMin: DEFAULT_TIMEOUT_MIN, reviewerCmd: "" },
  };
  const state = loadStateFileForRecovery(ctx.paths.state);
  if (!existsSync(join(root, MARKER_FILE))) {
    await pause(ctx, state, "项目配置不可用", undefined, `项目配置不可用（AUTOREVIEW_DEV_ROOT=${root}）：${join(root, MARKER_FILE)} 不存在`);
  } else {
    await pause(ctx, state, "自动评审内部错误", undefined, `Hook 异常：${tail(detail, 300)}`);
  }
  return undefined;
}

function readStdin(timeoutMs = 5000): Promise<string> {
  return new Promise((resolvePromise) => {
    const chunks: Buffer[] = [];
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolvePromise(Buffer.concat(chunks).toString("utf8"));
    };
    const timer = setTimeout(() => {
      try { process.stdin.destroy(); } catch { /* 忽略 */ }
      finish();
    }, timeoutMs);
    if (process.stdin.isTTY) { finish(); return; }
    process.stdin.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    process.stdin.on("end", finish);
    process.stdin.on("error", finish);
  });
}

export async function main(): Promise<void> {
  const raw = await readStdin();
  if (!raw.trim()) {
    process.stderr.write("autoreview hook: 没有收到输入\n");
    return;
  }
  if (process.env.AUTOREVIEW_DEBUG_EVENT) {
    try { appendFileSync(process.env.AUTOREVIEW_DEBUG_EVENT, `${raw.trim()}\n`); } catch { /* 调试记录失败不影响评审 */ }
  }
  if (process.env.AUTOREVIEW_DEBUG_ENV) {
    try {
      const keys = Object.keys(process.env).filter((key) => /^(CLAUDE|CODEX)/.test(key)).sort();
      appendFileSync(process.env.AUTOREVIEW_DEBUG_ENV, `${JSON.stringify(keys)}\n`);
    } catch { /* 调试记录失败不影响评审 */ }
  }
  let event: HookEvent;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("输入必须是 JSON 对象");
    event = parsed as HookEvent;
  } catch (error) {
    process.stderr.write(`autoreview hook: 无法解析输入：${errorText(error)}\n`);
    return;
  }
  try {
    const output = await dispatch(event);
    if (output) process.stdout.write(`${output}\n`);
  } catch (error) {
    const output = await recover(event, error);
    if (output) process.stdout.write(`${output}\n`);
  }
}

const entry = process.argv[1] ? resolve(process.argv[1]) : "";
if (entry === fileURLToPath(import.meta.url)) void main();
