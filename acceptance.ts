/**
 * acceptance.ts — 自动验收一轮的流程，经 review.ts 由 pi 扩展与宿主 Hook 共用。
 *
 * 负责：异议检查 → 取或起草验收标准（冻结）→ 查端口、启动被测系统、等就绪、记系统日志
 * → 每次调验收方前按配置重置数据 → 调验收方（证据有问题在同一会话重做 1 次，还不行换强模型重验 1 次）
 * → 关停系统、清理端口上的残留进程、截取日志、扫错误 → 程序逐条判定。
 * 被测系统自成进程组并登记，任何退出路径都会关停；验收途中系统退出就立即停掉验收方，
 * 按退出方式分「被关掉」（不怪开发方）和「崩溃」；判定交给 acceptance-core.ts 的纯函数。
 */
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, closeSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { basename, dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  buildAcceptanceInput, buildCorrectionInput, buildCriteriaDraftInput, classifySystemExit, dataStateNote, extractCriteria,
  findObjections, isManualCriterion, judgeAcceptance, parseAcceptanceReport, parseCriteriaDraft, scanLogs,
  type AcceptanceRecord, type Criteria, type ParsedAcceptance,
} from "./acceptance-core.ts";
import { EXT_DIR, HERMES_BIN, MARKER_FILE, PERMISSION_EXT, PI_BIN, resolveTestCmd, type AcceptanceConfig } from "./config.ts";
import { deriveSessionId } from "./core.ts";
import type { Exec, ExecResult } from "./git.ts";
import { killGroup, reapProcs, registerProc, unregisterProc } from "./procs.ts";

export const ACCEPTANCE_PROMPT_PATH = join(EXT_DIR, "acceptance-prompt.md");
export const CRITERIA_PROMPT_PATH = join(EXT_DIR, "criteria-prompt.md");
const TOOLS_DIR = join(EXT_DIR, "acceptance-tools");
/** 系统在验收途中退出后，收尾时盯端口的时长。 */
const WATCH_PORT_MS = 10_000;
/** 截取单个日志文件的上限，防止把巨型日志读进内存。 */
const MAX_LOG_BYTES = 2 * 1024 * 1024;

/** 验收用到的会话状态；ReviewState 在此基础上扩展。 */
export interface AcceptanceState {
  requirement?: string;
  criteria?: Criteria;
}

export interface AcceptanceDeps {
  /** 开发目录：被测系统在这里启动。 */
  workDir: string;
  devSessionId: string;
  round: number;
  deliveryNote: string;
  state: AcceptanceState;
  config: AcceptanceConfig;
  /** 起草验收标准默认用评审模型。 */
  reviewerModel: string;
  reviewerThinking: string;
  exec: Exec;
  /** 本轮运行目录（不在项目里）：日志、证据、验收方输入都写这里。 */
  runDir: string;
  /** 进程登记文件；被测系统登记进去，Hook 被杀后可清理。 */
  procsFile?: string;
  /** 本轮验收的截止时间（毫秒时间戳）。 */
  deadline: number;
  now: () => number;
  /** 上一轮没通过的条目，提醒验收方全部重测。 */
  previousFailed: string[];
  signal?: AbortSignal;
  checkLive?: () => void;
  onProgress?: (text: string) => void;
  saveState: () => Promise<void> | void;
}

export type AcceptanceStage =
  | { kind: "judged"; record: AcceptanceRecord }
  /** hint：给你看的下一步（怎么处理、处理完怎么继续）。 */
  | { kind: "paused"; reason: string; notes?: string; hint: string };

const shellQuote = (text: string): string => `'${text.replace(/'/g, "'\\''")}'`;
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);
const tailText = (text: string, max: number): string => {
  const trimmed = (text ?? "").trim();
  return trimmed.length <= max ? trimmed : `…${trimmed.slice(-max)}`;
};
const readIfExists = (path: string): string | undefined => {
  try { return readFileSync(path, "utf8"); } catch { return undefined; }
};

/** 执行结果 → 错误说明；成功返回空字符串。 */
function execError(result: ExecResult, label: string): string {
  if (result.killed) return `${label}超时或被终止（退出码 ${result.code}）`;
  if (result.code !== 0) return `${label}退出码 ${result.code}：${tailText(result.stderr, 300)}`;
  if (!result.stdout.trim()) return `${label}输出为空`;
  return "";
}

// —— 验收标准 ——

/** 已有标准直接用；需求里有「## 验收标准」就采用；否则由起草模型只看需求原文起草，冻结进状态。 */
async function ensureCriteria(deps: AcceptanceDeps): Promise<Criteria | { reason: string; notes?: string; hint: string }> {
  const { state, config } = deps;
  if (state.criteria) return state.criteria;
  const updatedAt = new Date().toISOString();
  const fromRequirement = extractCriteria(state.requirement);
  if (fromRequirement) {
    state.criteria = { source: "用户", items: fromRequirement, version: 1, updatedAt };
    await deps.saveState();
    return state.criteria;
  }
  if (!state.requirement?.trim()) {
    const hint = "给开发方发一条带「## 验收标准」的消息，下次停下时按它验收";
    return { reason: "没有需求原文，无法起草验收标准", notes: hint, hint };
  }
  deps.onProgress?.(`自动验收：起草验收标准（第 ${deps.round} 轮）`);
  const baseDir = dirname(deps.runDir);
  mkdirSync(baseDir, { recursive: true });
  const inputPath = join(baseDir, "criteria-input.md");
  writeFileSync(inputPath, buildCriteriaDraftInput(state.requirement));
  const sessionId = deriveSessionId("crit", deps.devSessionId);
  let lastError = "";
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const remaining = deps.deadline - deps.now();
    if (remaining < 60_000) {
      lastError ||= "验收时间用完";
      break;
    }
    const timeout = Math.min(10 * 60_000, remaining);
    let result: ExecResult;
    try {
      result = config.drafterCmd
        ? await deps.exec(resolveTestCmd(config.drafterCmd), [inputPath, sessionId], { cwd: baseDir, timeout, signal: deps.signal, role: "起草验收标准" })
        : await deps.exec(PI_BIN, [
          "--offline", "-p", "--session-id", sessionId,
          "--model", config.strongModel ?? deps.reviewerModel, "--thinking", deps.reviewerThinking,
          "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes",
          "--tools", "read", "-e", PERMISSION_EXT, "--append-system-prompt", CRITERIA_PROMPT_PATH, `@${inputPath}`,
        ], { cwd: baseDir, timeout, signal: deps.signal, role: "起草验收标准" });
    } catch (error) {
      deps.checkLive?.();
      lastError = `第 ${attempt} 次起草调用失败：${tailText(errorText(error), 300)}`;
      continue;
    }
    deps.checkLive?.();
    lastError = execError(result, `第 ${attempt} 次起草`);
    if (lastError) continue;
    const parsed = parseCriteriaDraft(result.stdout);
    if (!parsed.ok) {
      lastError = `第 ${attempt} 次起草无法解析：${parsed.error}`;
      continue;
    }
    state.criteria = { source: "自动起草", items: parsed.items, version: 1, updatedAt };
    await deps.saveState();
    return state.criteria;
  }
  return {
    reason: "验收标准起草失败", notes: lastError,
    hint: "起草失败的原因见总结；给开发方发一条带「## 验收标准」的消息，下次停下时按它验收",
  };
}

// —— 被测系统 ——

interface RunningSystem {
  exitInfo: () => { code: number | null; signal: string | null } | undefined;
  /** 退出时刻（墙上时间，和证据块头的时间可比）。 */
  exitedAt: () => number | undefined;
  /** 进程退出（或起不来）时完成。 */
  closed: Promise<void>;
  stop: () => Promise<void>;
}

function timestamp(): string {
  const now = new Date();
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`;
}

/** sh -c 启动被测系统：自成进程组并登记；stdout/stderr 逐行加时间戳写进 system.log。 */
function startSystem(deps: AcceptanceDeps, logPath: string): RunningSystem {
  const { config } = deps;
  const env = {
    ...process.env, PATH: `${HERMES_BIN}:${process.env.PATH ?? ""}`, ...config.env, AUTOREVIEW_RUN_DIR: deps.runDir,
  };
  const child = spawn("/bin/sh", ["-c", config.start!], { cwd: deps.workDir, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const pid = child.pid;
  if (pid && deps.procsFile) {
    try { registerProc(deps.procsFile, pid, "被测系统", config.start!); } catch { /* 登记失败不影响验收 */ }
  }
  const pending: Record<"out" | "err", string> = { out: "", err: "" };
  const flush = (stream: "out" | "err", final: boolean): void => {
    const lines = pending[stream].split("\n");
    pending[stream] = final ? "" : lines.pop() ?? "";
    const text = lines.filter((line, index) => line || index < lines.length - 1)
      .map((line) => `[${timestamp()}]${stream === "err" ? " [stderr]" : ""} ${line}\n`).join("");
    if (text) appendFileSync(logPath, text);
  };
  const onData = (stream: "out" | "err") => (chunk: Buffer): void => {
    pending[stream] += chunk.toString("utf8");
    flush(stream, false);
  };
  child.stdout?.on("data", onData("out"));
  child.stderr?.on("data", onData("err"));
  let exit: { code: number | null; signal: string | null } | undefined;
  let exitedAt: number | undefined;
  const closed = new Promise<void>((resolveClosed) => {
    child.on("error", (error) => {
      appendFileSync(logPath, `[${timestamp()}] [autoreview] 无法启动：${errorText(error)}\n`);
      exit ??= { code: 127, signal: null };
      exitedAt ??= Date.now();
      resolveClosed();
    });
    child.on("close", (code, signal) => {
      flush("out", true); flush("err", true);
      exit ??= { code, signal };
      exitedAt ??= Date.now();
      resolveClosed();
    });
  });
  return {
    exitInfo: () => exit,
    exitedAt: () => exitedAt,
    closed,
    stop: async () => {
      if (pid && !exit) {
        killGroup(pid, "SIGTERM");
        const stopped = await Promise.race([closed.then(() => true), sleep(3000).then(() => false)]);
        if (!stopped) {
          killGroup(pid, "SIGKILL");
          await Promise.race([closed, sleep(1000)]);
        }
      } else if (pid) {
        // 组长退出了，后代可能还在：一并清掉。
        killGroup(pid, "SIGKILL");
      }
      if (pid && deps.procsFile) {
        try { unregisterProc(deps.procsFile, pid); } catch { /* 尽力 */ }
      }
    },
  };
}

/** 有进程在这个地址上监听就算占用。 */
export function portBusy(url: URL): Promise<boolean> {
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  const host = url.hostname.replace(/^\[|\]$/g, "");
  return new Promise((resolveBusy) => {
    const socket = connect({ host, port });
    const done = (busy: boolean): void => { socket.destroy(); resolveBusy(busy); };
    socket.setTimeout(1000, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

async function httpReady(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000), redirect: "manual" });
    await res.body?.cancel();
    return res.status < 500;
  } catch {
    return false;
  }
}

/** 等就绪：网址返回小于 500、或输出里出现约定的句子；都没配就看 2 秒后进程还在。 */
async function waitReady(deps: AcceptanceDeps, system: RunningSystem, logPath: string): Promise<string | undefined> {
  const { config } = deps;
  const started = Date.now();
  const limit = started + Math.min(config.readyTimeoutSec * 1000, Math.max(0, deps.deadline - deps.now()));
  for (;;) {
    deps.signal?.throwIfAborted();
    const exit = system.exitInfo();
    if (exit) return `系统启动后就退出了（退出码 ${exit.code ?? exit.signal}）`;
    if (config.readyUrl) {
      if (await httpReady(config.readyUrl)) return undefined;
    } else if (config.readyLog) {
      if ((readIfExists(logPath) ?? "").includes(config.readyLog)) return undefined;
    } else if (Date.now() - started >= 2000) {
      return undefined;
    }
    if (Date.now() >= limit) return `系统在 ${Math.round((limit - started) / 1000)} 秒内没有就绪`;
    await sleep(300);
  }
}

/** ps 的 etime（[[天-]时:]分:秒）→ 秒。 */
export function parseElapsed(text: string): number | undefined {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(text.trim());
  if (!match) return undefined;
  const [, days, hours, minutes, seconds] = match;
  return ((Number(days ?? 0) * 24 + Number(hours ?? 0)) * 60 + Number(minutes)) * 60 + Number(seconds);
}

interface Listener { pid: number; command: string; startedAt?: number }

/** 在端口上监听的进程（需要 lsof）：命令行和启动时间（ps 的 etime 推算）。 */
function listeners(port: string): Listener[] {
  const listed = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8", timeout: 5000 });
  const pids = [...new Set((listed.stdout ?? "").split(/\s+/).map(Number).filter((pid) => pid > 0 && pid !== process.pid))];
  return pids.map((pid) => {
    const ps = (field: string) => (spawnSync("ps", ["-o", `${field}=`, "-p", String(pid)], { encoding: "utf8", timeout: 5000 }).stdout ?? "").trim();
    const elapsed = parseElapsed(ps("etime"));
    return { pid, command: ps("command") || "未知命令", startedAt: elapsed === undefined ? undefined : Date.now() - elapsed * 1000 };
  });
}

const portOf = (url: URL): string => url.port || (url.protocol === "https:" ? "443" : "80");

/** 端口被占时给你看的「谁占着」。 */
export function describeListeners(url: URL): string {
  const found = listeners(portOf(url));
  return found.length > 0 ? found.map((item) => `pid ${item.pid}（${item.command}）`).join("、") : "找不到占用的进程（需要 lsof）";
}

/**
 * 关停被测系统后端口还被占着：验收开始后才起的进程（多半是验收方自己重启的，用 setsid 之类逃出了进程组）清掉，
 * 更早就在的只记下来不动。watchMs 内持续盯着端口，接住启动慢、晚一点才占上端口的进程。返回写进总结的说明。
 */
async function cleanupPort(config: AcceptanceConfig, since: number, watchMs: number): Promise<string[]> {
  if (!config.readyUrl) return [];
  const url = new URL(config.readyUrl);
  const port = portOf(url);
  const notes: string[] = [];
  const seen = new Set<number>();
  const killed: number[] = [];
  const until = Date.now() + watchMs;
  for (;;) {
    if (await portBusy(url)) {
      const found = listeners(port).filter((item) => !seen.has(item.pid));
      if (found.length === 0 && seen.size === 0) {
        notes.push(`验收结束后端口 ${port} 仍被占用，但找不到占用的进程（需要 lsof）；下一轮可能因端口被占用而暂停`);
        break;
      }
      for (const item of found) {
        seen.add(item.pid);
        if (item.startedAt === undefined || item.startedAt < since - 2000) {
          notes.push(`端口 ${port} 被 pid ${item.pid}（${item.command}）占用，它在验收开始前就在，没有动它`);
          continue;
        }
        try {
          process.kill(item.pid, "SIGTERM");
          killed.push(item.pid);
          notes.push(`端口 ${port} 上有验收期间起的进程 pid ${item.pid}（${item.command}），不是程序启动的被测系统，已关掉`);
        } catch (error) {
          notes.push(`端口 ${port} 上有验收期间起的进程 pid ${item.pid}（${item.command}），关不掉：${errorText(error)}`);
        }
      }
    }
    if (Date.now() >= until) break;
    await sleep(200);
  }
  for (let i = 0; i < 30 && killed.length > 0 && await portBusy(url); i += 1) await sleep(100);
  for (const pid of killed) {
    try { process.kill(pid, 0); process.kill(pid, "SIGKILL"); } catch { /* 已经退出 */ }
  }
  return notes;
}

/** 记下日志文件当前长度，结束后只截取新增部分。 */
function logOffsets(files: string[]): Map<string, number> {
  const offsets = new Map<string, number>();
  for (const file of files) {
    try { offsets.set(file, statSync(file).size); } catch { offsets.set(file, 0); }
  }
  return offsets;
}

function readAppended(file: string, offset: number): string {
  let size: number;
  try { size = statSync(file).size; } catch { return ""; }
  const from = size < offset ? 0 : offset;
  const start = Math.max(from, size - MAX_LOG_BYTES);
  const length = size - start;
  if (length <= 0) return "";
  const buffer = Buffer.alloc(length);
  const fd = openSync(file, "r");
  try { readSync(fd, buffer, 0, length, start); } finally { closeSync(fd); }
  return buffer.toString("utf8");
}

// —— 验收方 ——

/** 运行目录里的 ./ev 和 ./browser：补上运行目录（和项目目录）后转给仓库里的工具。 */
function writeTools(runDir: string, workDir: string): void {
  const node = shellQuote(process.execPath);
  const scripts: Record<string, string> = {
    ev: `exec ${node} ${shellQuote(join(TOOLS_DIR, "ev.mjs"))} ${shellQuote(runDir)} "$@"`,
    browser: `exec ${node} ${shellQuote(join(TOOLS_DIR, "browser.mjs"))} ${shellQuote(runDir)} ${shellQuote(workDir)} "$@"`,
  };
  for (const [name, line] of Object.entries(scripts)) {
    const file = join(runDir, name);
    writeFileSync(file, `#!/bin/sh\n${line}\n`);
    chmodSync(file, 0o755);
  }
}

/** strong：换强模型（另开会话）重验。 */
async function callTester(deps: AcceptanceDeps, inputPath: string, timeout: number, strong = false): Promise<ExecResult> {
  const { config } = deps;
  const sessionId = deriveSessionId(strong ? "acc-strong" : "acc", deps.devSessionId);
  const options = { cwd: deps.runDir, timeout, signal: deps.signal, role: "验收方" };
  if (config.testerCmd) {
    return deps.exec(resolveTestCmd(config.testerCmd), [String(deps.round), inputPath, sessionId, deps.runDir], options);
  }
  const model = strong ? ["--model", config.strongModel ?? deps.reviewerModel, "--thinking", deps.reviewerThinking]
    : ["--model", config.model, ...(config.thinking ? ["--thinking", config.thinking] : [])];
  return deps.exec(PI_BIN, [
    "--offline", "-p", "--session-id", sessionId, ...model,
    "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes",
    "--tools", "read,write,bash,grep,find,ls", "-e", PERMISSION_EXT,
    "--append-system-prompt", ACCEPTANCE_PROMPT_PATH, `@${inputPath}`,
  ], options);
}

interface TesterRun {
  report?: ParsedAcceptance;
  error: string;
  escalated: boolean;
  /** 重置数据失败的说明（环境问题，暂停）。 */
  resetFailure?: string;
}

const resetLogOf = (runDir: string): string => join(runDir, "reset.log");

/**
 * 重置数据：在开发目录用 sh -c 跑 acceptance.reset，环境同被测系统；输出写 reset.log（不进 system.log，
 * 以免重置时打的错误被当成系统错误）。没配置返回空串；失败返回说明。
 */
async function runReset(deps: AcceptanceDeps, label: string): Promise<string> {
  const { config } = deps;
  if (!config.reset) return "";
  deps.onProgress?.(`自动验收：重置数据（第 ${deps.round} 轮${label}）`);
  const timeout = Math.max(1000, Math.min(config.resetTimeoutSec * 1000, deps.deadline - deps.now()));
  const env = [
    `PATH=${HERMES_BIN}:${process.env.PATH ?? ""}`, `AUTOREVIEW_RUN_DIR=${deps.runDir}`,
    ...Object.entries(config.env).map(([key, value]) => `${key}=${value}`),
  ];
  const log = (text: string): void => appendFileSync(resetLogOf(deps.runDir), `=== ${timestamp()}${label ? ` ${label.replace(/^，/, "")}` : ""}\n$ ${config.reset}\n${text}\n`);
  let result: ExecResult;
  try {
    result = await deps.exec("/usr/bin/env", [...env, "/bin/sh", "-c", config.reset], {
      cwd: deps.workDir, timeout, signal: deps.signal, role: "重置数据",
    });
  } catch (error) {
    deps.checkLive?.();
    log(`无法执行：${errorText(error)}`);
    return `重置命令无法执行：${tailText(errorText(error), 300)}`;
  }
  log([`退出码：${result.code}${result.killed ? "（超时或被终止）" : ""}`, "--- 标准输出", result.stdout.trimEnd(), "--- 标准错误", result.stderr.trimEnd()].join("\n"));
  if (result.killed) return `重置命令超时或被终止（时限 ${config.resetTimeoutSec} 秒）`;
  if (result.code !== 0) return `重置命令退出码 ${result.code}：${tailText(result.stderr || result.stdout, 300)}`;
  return "";
}

/**
 * 第 1 次按输入实测；输出解析不了、或通过/不通过的证据对不上时，在同一会话里发更正要求重做 1 次；
 * 还是验收方的问题（证据对不上、漏报、没给出报告）就换强模型另开会话从头重验 1 次。共用验收截止时间。
 * 每次调用前按配置重置数据；被测系统一退出就不再继续（再试只是对着空端口白跑）。
 */
async function runTester(deps: AcceptanceDeps, criteria: Criteria, inputPath: string, systemDown: () => boolean): Promise<TesterRun> {
  const evidence = (id: string) => readIfExists(join(deps.runDir, "evidence", `${id}.txt`));
  const hasService = Boolean(deps.config.start);
  const testerFault = (report?: ParsedAcceptance): boolean => !report || judgeAcceptance({
    criteria: criteria.items, report, evidence, logErrors: [], runDir: deps.runDir, hasService,
  }).items.some((item) => item.cause === "验收方");
  let report: ParsedAcceptance | undefined;
  let error = "";
  let input = inputPath;
  let escalated = false;
  const resetConfigured = Boolean(deps.config.reset);
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const strong = attempt === 3;
    if (systemDown()) break;
    if (strong) {
      if (!testerFault(report)) break;
      input = join(deps.runDir, "strong.md");
      writeFileSync(input, `${readFileSync(inputPath, "utf8")}\n## 说明\n上一位验收方没按要求留证据或输出格式不对，请你从头逐条实测；evidence/ 里已有的证据可以参考，但每条都要自己用工具再验一次。${dataStateNote(resetConfigured)}\n`);
    }
    if (deps.deadline - deps.now() < 60_000) {
      error ||= "验收时间用完";
      break;
    }
    const resetFailure = await runReset(deps, attempt === 1 ? "" : strong ? "，换强模型前" : "，重做前");
    deps.checkLive?.();
    if (resetFailure) return { report, error, escalated, resetFailure };
    if (systemDown()) break;
    const remaining = deps.deadline - deps.now();
    if (remaining < 60_000) {
      error ||= "验收时间用完";
      break;
    }
    deps.onProgress?.(`自动验收中（第 ${deps.round} 轮${attempt === 2 ? "，重做" : strong ? "，换强模型重验" : ""}）`);
    let result: ExecResult | undefined;
    try {
      result = await callTester(deps, input, remaining, strong);
    } catch (callError) {
      error = `第 ${attempt} 次验收调用失败：${tailText(errorText(callError), 300)}`;
    }
    deps.checkLive?.();
    if (strong) escalated = true;
    if (result) error = execError(result, `第 ${attempt} 次验收`);
    if (result && !error) {
      const parsed = parseAcceptanceReport(result.stdout);
      if (parsed.ok) report = parsed.report;
      else error = `第 ${attempt} 次验收输出无法解析：${parsed.error}`;
    }
    if (strong || systemDown()) break;
    if (attempt === 2) continue;
    if (report && !error) {
      const preview = judgeAcceptance({ criteria: criteria.items, report, evidence, logErrors: [], runDir: deps.runDir, hasService });
      if (!preview.items.some((item) => item.evidenceProblem)) break;
      input = join(deps.runDir, "correction.md");
      writeFileSync(input, buildCorrectionInput(preview, resetConfigured));
    } else if (result && !result.killed && result.code === 0 && result.stdout.trim()) {
      input = join(deps.runDir, "correction.md");
      writeFileSync(input, `## 上次输出无法解析\n${error}\n\n已经留下的证据不用重跑；请按系统提示里的格式，重新输出全部条目的结果。\n`);
    }
  }
  return { report, error: report ? "" : error, escalated };
}

/**
 * 跑一轮验收。返回 judged 时由 review.ts 决定返修、暂停或继续评审；
 * paused 只用于不是开发方造成的情况（异议、标准缺失、端口被占用）。
 */
export async function runAcceptanceStage(deps: AcceptanceDeps): Promise<AcceptanceStage> {
  const objections = findObjections(deps.deliveryNote);
  if (objections.length > 0) {
    const hint = `开发方对 ${objections.join("、")} 有异议（理由见它的回复）。验收标准只有你能改：同意就发一条带「## 验收标准」的新消息替换；不同意就发消息让它按原标准继续`;
    return { kind: "paused", reason: `开发方对验收标准有异议（${objections.join("、")}）`, notes: hint, hint };
  }
  const criteria = await ensureCriteria(deps);
  deps.checkLive?.();
  if (!("items" in criteria)) return { kind: "paused", reason: criteria.reason, notes: criteria.notes, hint: criteria.hint };

  const { config, runDir } = deps;
  // 标准全部标了 [人工]：没有要验收方做的，不启动系统、不调验收方，整轮记部分验证，完成时列给你。
  if (criteria.items.every((item) => isManualCriterion(item.text))) {
    rmSync(runDir, { recursive: true, force: true });
    mkdirSync(runDir, { recursive: true });
    const record: AcceptanceRecord = {
      ...judgeAcceptance({ criteria: criteria.items, evidence: () => undefined, logErrors: [], runDir, hasService: Boolean(config.start) }),
      durationMs: 0,
    };
    writeFileSync(join(runDir, "result.json"), JSON.stringify(record, null, 2));
    return { kind: "judged", record };
  }
  const startedAt = deps.now();
  /** 墙上时间：判断端口上的进程是不是验收开始后才起的。 */
  const wallStart = Date.now();
  rmSync(runDir, { recursive: true, force: true });
  mkdirSync(join(runDir, "evidence"), { recursive: true });
  writeTools(runDir, deps.workDir);
  const logPath = join(runDir, "system.log");
  writeFileSync(logPath, "");
  if (deps.procsFile) reapProcs(deps.procsFile);

  const offsets = logOffsets(config.logs);
  let system: RunningSystem | undefined;
  let systemFailure: string | undefined;
  let tester: TesterRun = { error: "", escalated: false };
  /** 验收方开始实测之后系统退出的情况（启动阶段就退出的算 notReady）。 */
  let exitDuringTest: { code: number | null; signal: string | null } | undefined;
  let exitedAt: number | undefined;
  try {
    if (config.start) {
      if (config.readyUrl && await portBusy(new URL(config.readyUrl))) {
        const url = new URL(config.readyUrl);
        const hint = `启动被测系统前 ${config.readyUrl} 已经有程序在监听：${describeListeners(url)}。`
          + `如果是上一轮验收留下的就关掉它（或改 ${join(config.root, MARKER_FILE)} 里的端口），再给开发方发一条消息继续`;
        return { kind: "paused", reason: `端口 ${portOf(url)} 已被占用（环境问题，不算开发方的错）`, notes: hint, hint };
      }
      deps.onProgress?.(`自动验收：启动被测系统（第 ${deps.round} 轮）`);
      system = startSystem(deps, logPath);
      const notReady = await waitReady(deps, system, logPath);
      deps.checkLive?.();
      if (notReady) systemFailure = `${notReady}\n系统输出最后几行：\n${tailText(readIfExists(logPath) ?? "", 1500) || "（无输出）"}`;
    }
    if (!systemFailure) {
      const inputPath = join(runDir, "input.md");
      writeFileSync(inputPath, buildAcceptanceInput({
        round: deps.round, requirement: deps.state.requirement, criteria, workDir: deps.workDir, runDir,
        baseUrl: config.readyUrl ? new URL(config.readyUrl).origin : undefined,
        systemLog: config.start ? logPath : undefined, logFiles: config.logs,
        guide: config.guide ? readIfExists(config.guide) ?? `（操作说明文件读不到：${config.guide}）` : undefined,
        deliveryNote: deps.deliveryNote, previousFailed: deps.previousFailed, resetConfigured: Boolean(config.reset),
      }));
      // 系统一退出就停掉验收方和重置命令；外层取消也一并传下去。
      const testerAbort = new AbortController();
      const stopTester = (): void => testerAbort.abort();
      deps.signal?.addEventListener("abort", stopTester, { once: true });
      void system?.closed.then(stopTester);
      try {
        tester = await runTester({ ...deps, signal: testerAbort.signal }, criteria, inputPath, () => Boolean(system?.exitInfo()));
      } finally {
        deps.signal?.removeEventListener("abort", stopTester);
      }
      exitDuringTest = system?.exitInfo();
      exitedAt = system?.exitedAt();
    }
  } finally {
    await system?.stop();
  }
  // 验收方自己起的进程（比如重启出来的服务）可能逃出了进程组，还占着端口；
  // 系统是在验收途中退出的，多盯一会儿，接住晚一点才占上端口的重启进程。
  const cleanup = system ? await cleanupPort(config, wallStart, exitDuringTest ? WATCH_PORT_MS : 0) : [];

  const logTexts = [readIfExists(logPath) ?? ""];
  if (config.logs.length > 0) mkdirSync(join(runDir, "logs"), { recursive: true });
  config.logs.forEach((file, index) => {
    const text = readAppended(file, offsets.get(file) ?? 0);
    writeFileSync(join(runDir, "logs", `${index + 1}-${basename(file)}`), text);
    logTexts.push(text);
  });
  const logErrors = scanLogs(logTexts.join("\n"), config.errorPatterns, config.ignorePatterns);

  if (tester.resetFailure) {
    const resetLog = resetLogOf(runDir);
    const hint = `检查 ${join(config.root, MARKER_FILE)} 里的 acceptance.reset（输出见 ${resetLog}），修好后再给开发方发一条消息继续`;
    const stoppedToo = exitDuringTest ? ["被测系统也在这时退出了（重置命令可能重启或关掉了服务：reset 只该重置数据）"] : [];
    return {
      kind: "paused", reason: "验收前重置数据失败（环境问题，不算开发方的错）",
      notes: [tester.resetFailure, ...stoppedToo, ...cleanup].join("；"), hint,
    };
  }

  // 验收途中系统退出：被关掉（信号、或无错误的正常退出）不怪开发方，崩溃才算 G1 不通过。
  let systemStopped: { detail: string; at: number } | undefined;
  if (exitDuringTest) {
    const how = `退出码 ${exitDuringTest.code ?? exitDuringTest.signal}`;
    const output = `系统输出最后几行：\n${tailText(readIfExists(logPath) ?? "", 1500) || "（无输出）"}`;
    if (classifySystemExit(exitDuringTest, logErrors) === "被关掉") {
      systemStopped = {
        at: exitedAt ?? Date.now(),
        detail: `系统在验收途中被关掉了（${how}），多半是验收方或重置命令关的，不是开发方的问题\n${output}`,
      };
    } else {
      systemFailure = `系统在验收过程中退出了（${how}）\n${output}`;
    }
  }
  const judged = judgeAcceptance({
    criteria: criteria.items, report: tester.report, reportError: tester.error,
    evidence: (id) => readIfExists(join(runDir, "evidence", `${id}.txt`)),
    systemFailure, systemStopped, logErrors, runDir, hasService: Boolean(config.start),
  });
  const record: AcceptanceRecord = { ...judged, durationMs: deps.now() - startedAt };
  if (tester.escalated) record.escalated = true;
  if (cleanup.length > 0) record.cleanup = cleanup;
  writeFileSync(join(runDir, "result.json"), JSON.stringify(record, null, 2));
  return { kind: "judged", record };
}

/** 运行目录：~/.pi-autoreview/<项目>/acceptance/<会话>/r<轮次>。 */
export function acceptanceRunDir(baseDir: string, round: number): string {
  return join(baseDir, `r${round}`);
}
