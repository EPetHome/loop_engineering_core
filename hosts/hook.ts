/**
 * hosts/hook.ts — Claude Code / Codex 共用的自动评审 Hook 入口。
 *
 * 一个可执行文件按 hook_event_name 分派：
 *   SessionStart / UserPromptSubmit → 注入开发约定；本会话第一次提交时记需求原文与基线
 *   Stop → 交付标记触发评审；有必修用 {"decision":"block","reason":…} 打回原会话
 *
 * 只有当前目录或某个上级目录存在 .autoreview.json 的项目才生效，普通会话零影响。
 * 任何异常都只暂停并放行（退出 0），绝不卡宿主、绝不输出非法 JSON。
 */
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyMarker, CONVENTION, deriveReviewerSessionId, renderSummary } from "../core.ts";
import { createGitEvidence, type Exec, type ExecResult } from "../git.ts";
import {
  DEFAULT_MAX_REPAIRS, DEFAULT_MODEL, DEFAULT_THINKING, DEFAULT_TIMEOUT_MIN,
  errorText, newReviewState, runReviewRound, tail,
  type ReviewConfig, type ReviewState,
} from "../review.ts";

const HERMES_BIN = "/Users/Admin/.hermes/node/bin";
const MARKER_FILE = ".autoreview.json";
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

export interface HookState extends ReviewState {}

export interface HookPaths {
  dir: string;
  state: string;
  summary: string;
  lock: string;
}

interface HookContext {
  host: string;
  /** .autoreview.json 所在目录，只用于读配置。 */
  configRoot: string;
  /** 宿主会话工作目录：git 取证与评审都在这里。 */
  workDir: string;
  sessionId: string;
  paths: HookPaths;
  exec: Exec;
  config: ReviewConfig;
}

/** 外部 exec：子进程 PATH 自己补 hermes 的 node；超时杀整个进程组并有界结束等待。 */
export const childExec: Exec = (command, args, options) => new Promise<ExecResult>((resolvePromise) => {
  const env = { ...process.env, PATH: `${HERMES_BIN}:${process.env.PATH ?? ""}` };
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let killed = false;
  let done = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reapTimer: ReturnType<typeof setTimeout> | undefined;
  const finish = (code: number, killedFlag: boolean): void => {
    if (done) return;
    done = true;
    if (timer) clearTimeout(timer);
    if (reapTimer) clearTimeout(reapTimer);
    resolvePromise({
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
      code, killed: killedFlag,
    });
  };
  let child;
  try {
    // detached 让子进程成为进程组组长，超时时可以连同后代一起杀掉。
    child = spawn(command, args, {
      cwd: options.cwd, env, stdio: ["ignore", "pipe", "pipe"], signal: options.signal, detached: true,
    });
  } catch (error) {
    process.stderr.write(`autoreview hook: 无法启动 ${command}：${errorText(error)}\n`);
    finish(1, false);
    return;
  }
  child.stdout?.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
  child.on("error", (error) => {
    const aborted = (error as NodeJS.ErrnoException).name === "AbortError";
    finish(1, killed || aborted);
  });
  child.on("close", (code, signal) => finish(code ?? 1, killed || Boolean(signal)));
  if (options.timeout > 0) {
    timer = setTimeout(() => {
      killed = true;
      const pid = child.pid;
      try {
        if (pid) process.kill(-pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        try { child.kill("SIGKILL"); } catch { /* 已经退出 */ }
      }
      // 后代可能仍持有 stdout/stderr，close 不一定到达：有界清理，绝不无限等。
      reapTimer = setTimeout(() => finish(137, true), 250);
    }, options.timeout);
  }
});

/**
 * 宿主识别：AUTOREVIEW_HOST 可强制指定；Codex 的 UserPromptSubmit/Stop 带 turn_id，
 * 但 SessionStart 没有，所以再看宿主注入的环境变量与 transcript 路径。
 */
export function detectHost(event: HookEvent, env: NodeJS.ProcessEnv = process.env): string {
  const forced = env.AUTOREVIEW_HOST?.trim();
  if (forced) return forced;
  if (event.turn_id !== undefined && event.turn_id !== null) return "codex";
  if (env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT) return "claude";
  // Codex 的 Claude 插件兼容层会设置 CLAUDE_PLUGIN_ROOT，但不设 CLAUDECODE。
  if (env.CLAUDE_PLUGIN_ROOT) return "codex";
  const transcript = typeof event.transcript_path === "string" ? event.transcript_path : "";
  if (transcript.includes("/.codex/")) return "codex";
  if (transcript.includes("/.claude/")) return "claude";
  return "claude";
}

/** 从 cwd 向上找 .autoreview.json 所在目录；找不到返回 undefined。 */
export function findProjectRoot(cwd: string | undefined): string | undefined {
  let dir: string;
  try {
    dir = resolve(cwd?.trim() || process.cwd());
  } catch {
    return undefined;
  }
  for (;;) {
    if (existsSync(join(dir, MARKER_FILE))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function nonNegativeInt(data: Record<string, unknown>, key: string, fallback: number): number {
  const value = data[key];
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${MARKER_FILE} 的 ${key} 必须是非负整数`);
  }
  return value;
}

function nonEmptyString(data: Record<string, unknown>, key: string, fallback: string): string {
  const value = data[key];
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !value.trim()) throw new Error(`${MARKER_FILE} 的 ${key} 必须是非空字符串`);
  return value.trim();
}

/** 读 .autoreview.json（可以是 {}）；可选字段非法时抛错，由统一收口记暂停。 */
export function loadConfig(root: string, env: NodeJS.ProcessEnv = process.env): ReviewConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(root, MARKER_FILE), "utf8"));
  } catch (error) {
    throw new Error(`无法解析 ${MARKER_FILE}：${errorText(error)}`);
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${MARKER_FILE} 必须是 JSON 对象`);
  const data = raw as Record<string, unknown>;
  const envTimeout = Number.parseInt(env[DEFAULT_TIMEOUT_ENV] ?? "", 10);
  return {
    maxRepairs: nonNegativeInt(data, "maxRepairs", DEFAULT_MAX_REPAIRS),
    reviewerModel: nonEmptyString(data, "reviewerModel", DEFAULT_MODEL),
    reviewerThinking: nonEmptyString(data, "reviewerThinking", DEFAULT_THINKING),
    reviewTimeoutMin: Number.isFinite(envTimeout) && envTimeout > 0
      ? envTimeout : nonNegativeInt(data, "reviewTimeoutMin", DEFAULT_TIMEOUT_MIN),
    reviewerCmd: env.AUTOREVIEW_REVIEWER_CMD?.trim() ?? "",
  };
}

/** 状态和总结都放在 ~/.pi-autoreview/<项目目录名>/<宿主>-<会话id>.*。 */
export function hookPaths(projectDir: string, host: string, sessionId: string): HookPaths {
  const dir = join(homedir(), ".pi-autoreview", safeName(basename(projectDir)) || "project");
  const stem = `${safeName(host)}-${safeName(sessionId) || "unknown"}`;
  return {
    dir,
    state: join(dir, `${stem}.state.json`),
    summary: join(dir, `${stem}.md`),
    lock: join(dir, `${stem}.lock`),
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
function loadStateFile(file: string): HookState {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return newReviewState();
    throw new StateCorruptError(`无法读取：${errorText(error)}`);
  }
  let data: unknown;
  try { data = JSON.parse(raw); } catch (error) { throw new StateCorruptError(`不是合法 JSON：${errorText(error)}`); }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new StateCorruptError("不是 JSON 对象");
  const state = { ...newReviewState(), ...(data as HookState) };
  if (!Array.isArray(state.rounds)) throw new StateCorruptError("rounds 不是数组");
  if (typeof state.repairs !== "number" || !Number.isFinite(state.repairs)) throw new StateCorruptError("repairs 不是数字");
  if (!PHASES.has(state.phase)) throw new StateCorruptError(`phase 非法：${String(state.phase)}`);
  return state;
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

function saveStateFile(file: string, state: HookState): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, file);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
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
  let pid: unknown;
  try { pid = (JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: unknown }).pid; } catch { pid = undefined; }
  if (typeof pid === "number" && Number.isInteger(pid) && pid > 0 && processAlive(pid)) return "busy";
  return "stale";
}

function releaseLock(lockPath: string): void {
  try { rmSync(lockPath, { force: true }); } catch { /* 尽力 */ }
}

function contextOutput(eventName: string, additionalContext: string): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: eventName, additionalContext } });
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

async function notify(body: string, exec: Exec): Promise<void> {
  process.stderr.write(`[autoreview] ${body}\n`);
  try {
    const escaped = body.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    await exec("osascript", ["-e", `display notification "${escaped}" with title "自动评审"`], { cwd: homedir(), timeout: 15_000 });
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
  const text = renderSummary({
    cwd: ctx.workDir, devSessionId: `${ctx.host}-${ctx.sessionId}`,
    reviewerSessionId: state.reviewerSessionId ?? deriveReviewerSessionId(`${ctx.host}-${ctx.sessionId}`),
    status, pauseReason, rounds: state.rounds, repairs: state.repairs,
    unresolvedMustFix: state.unresolvedMustFix, changedFiles, gitStatusShort, notes,
  });
  mkdirSync(dirname(ctx.paths.summary), { recursive: true });
  writeFileSync(ctx.paths.summary, text);
}

/** 暂停：存状态、写总结、尽力通知；每一步失败都不阻断下一步。 */
async function pause(
  ctx: HookContext, state: HookState, reason: string, changedFiles?: string[], notes?: string,
): Promise<void> {
  state.phase = "paused";
  state.pauseReason = reason;
  state.awaitingRepair = false;
  try { saveStateFile(ctx.paths.state, state); } catch (error) {
    process.stderr.write(`autoreview hook: 状态保存失败：${errorText(error)}\n`);
  }
  try { await writeSummary(ctx, state, "暂停", reason, changedFiles, notes); } catch (error) {
    process.stderr.write(`autoreview hook: 总结写入失败：${errorText(error)}\n`);
  }
  await notify(`${basename(ctx.workDir)}：暂停（${reason}）`, ctx.exec);
}

async function sessionStart(ctx: HookContext): Promise<string | undefined> {
  const state = loadStateFile(ctx.paths.state);
  if (state.enabled === false) return undefined;
  const git = createGitEvidence(ctx.exec, ctx.workDir);
  const repository = await git.isRepository();
  const head = repository ? await git.initialHead() : undefined;
  if (!repository || !head) {
    state.enabled = false;
    state.phase = "idle";
    saveStateFile(ctx.paths.state, state);
    return contextOutput("SessionStart", repository ? "仓库还没有提交，自动评审已关闭" : "不是 git 仓库，自动评审已关闭");
  }
  saveStateFile(ctx.paths.state, state);
  return contextOutput("SessionStart", CONVENTION);
}

async function userPromptSubmit(ctx: HookContext, event: HookEvent): Promise<string | undefined> {
  const state = loadStateFile(ctx.paths.state);
  if (state.enabled === false) return undefined;
  const prompt = typeof event.prompt === "string" ? event.prompt : "";
  if (state.requirement === undefined && prompt.trim()) {
    state.requirement = prompt;
    const snap = await createGitEvidence(ctx.exec, ctx.workDir).snapshot();
    state.baseline = snap.ref;
    state.baselineUntracked = snap.untracked.map(({ path }) => path);
    state.baselineFingerprint = snap.fingerprint;
  }
  saveStateFile(ctx.paths.state, state);
  return contextOutput("UserPromptSubmit", CONVENTION);
}

/** 未交付提醒已按新规则移除：无标记但有改动时直接评审。 */
async function stop(ctx: HookContext, event: HookEvent): Promise<string | undefined> {
  const state = loadStateFile(ctx.paths.state);
  if (state.enabled === false) return undefined;
  const text = lastAssistantMessage(event);
  const marker = classifyMarker(text);
  if (marker === "decision") {
    if (state.phase === "paused") return undefined;
    await pause(ctx, state, "开发方需要你决定");
    return undefined;
  }
  // 暂停状态不自动评审（与 pi 扩展一致）。
  if (state.phase === "paused") return undefined;
  if (marker === "none") {
    const baseline = state.lastFingerprint ?? state.baselineFingerprint;
    if (!baseline) return undefined;
    const current = await createGitEvidence(ctx.exec, ctx.workDir).snapshot();
    if (current.fingerprint === baseline) {
      if (state.awaitingRepair) await pause(ctx, state, "返修后没有任何改动");
      return undefined;
    }
    // 没有交付标记但有未评审改动：直接评审，与写了【交付完成】一样。
  }

  const lock = acquireLock(ctx.paths.lock);
  if (lock === "stale") {
    releaseLock(ctx.paths.lock);
    await pause(ctx, state, INTERRUPTED);
    return undefined;
  }
  if (lock === "busy") {
    process.stderr.write("autoreview hook: 已有评审在进行，放行\n");
    return undefined;
  }
  try {
    // 上一轮已完成后再次交付：按 pi 规则开新一轮，返修计数清零。
    if (state.phase === "done") state.repairs = 0;
    state.phase = "reviewing";
    state.pauseReason = undefined;
    state.awaitingRepair = false;
    saveStateFile(ctx.paths.state, state);
    const round = state.rounds.length + 1;
    const outcome = await runReviewRound({
      cwd: ctx.workDir, devSessionId: `${ctx.host}-${ctx.sessionId}`, round,
      deliveryNote: text, state, config: ctx.config, exec: ctx.exec,
      writeInput: (name, content) => {
        mkdirSync(ctx.paths.dir, { recursive: true });
        const file = join(ctx.paths.dir, name);
        writeFileSync(file, content);
        return file;
      },
      writeSummary: (status) => writeSummary(ctx, state, status),
      saveState: () => saveStateFile(ctx.paths.state, state),
    });
    if (outcome.kind === "done") {
      state.phase = "done";
      state.awaitingRepair = false;
      saveStateFile(ctx.paths.state, state);
      await notify(`${basename(ctx.workDir)}：完成（评审 ${state.rounds.length} 次，返修 ${state.repairs} 次）`, ctx.exec);
      return undefined;
    }
    if (outcome.kind === "paused") {
      await pause(ctx, state, outcome.reason ?? "评审失败", outcome.changedFiles, outcome.notes);
      return undefined;
    }
    state.phase = "idle";
    saveStateFile(ctx.paths.state, state);
    return JSON.stringify({ decision: "block", reason: outcome.message ?? "" });
  } finally {
    releaseLock(ctx.paths.lock);
  }
}

async function dispatch(event: HookEvent): Promise<string | undefined> {
  const root = findProjectRoot(event.cwd);
  if (!root) {
    process.stderr.write("autoreview hook: 没有 .autoreview.json，跳过\n");
    return undefined;
  }
  const host = detectHost(event);
  const sessionId = sessionIdOf(event);
  const workDir = resolve(event.cwd?.trim() || process.cwd());
  const ctx: HookContext = {
    host, configRoot: root, workDir, sessionId,
    paths: hookPaths(workDir, host, sessionId),
    exec: childExec,
    config: loadConfig(root),
  };
  const kind = event.hook_event_name;
  if (kind === "SessionStart") return sessionStart(ctx);
  if (kind === "UserPromptSubmit") return userPromptSubmit(ctx, event);
  if (kind === "Stop") return stop(ctx, event);
  return undefined;
}

/** 异常收口：记暂停、写总结、尽力通知，然后放行（退出 0）。 */
async function recover(event: HookEvent, error: unknown): Promise<undefined> {
  const detail = errorText(error);
  process.stderr.write(`autoreview hook 内部错误：${detail}\n`);
  const root = findProjectRoot(event.cwd);
  if (!root) return undefined;
  const host = detectHost(event);
  const sessionId = sessionIdOf(event);
  const workDir = resolve(event.cwd?.trim() || process.cwd());
  const ctx: HookContext = {
    host, configRoot: root, workDir, sessionId, paths: hookPaths(workDir, host, sessionId), exec: childExec,
    config: { maxRepairs: DEFAULT_MAX_REPAIRS, reviewerModel: DEFAULT_MODEL, reviewerThinking: DEFAULT_THINKING, reviewTimeoutMin: DEFAULT_TIMEOUT_MIN, reviewerCmd: "" },
  };
  const state = loadStateFileForRecovery(ctx.paths.state);
  await pause(ctx, state, "自动评审内部错误", undefined, `Hook 异常：${tail(detail, 300)}`);
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
