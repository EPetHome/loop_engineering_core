/**
 * acceptance.ts — 自动验收一轮的流程，经 review.ts 由 pi 扩展与宿主 Hook 共用。
 *
 * 负责：异议检查 → 取或起草验收标准（冻结）→ 查端口、启动被测系统、等就绪、记系统日志
 * → 调验收方（证据有问题在同一会话重做 1 次）→ 关停系统、截取日志、扫错误 → 程序逐条判定。
 * 被测系统自成进程组并登记，任何退出路径都会关停；判定交给 acceptance-core.ts 的纯函数。
 */
import { spawn } from "node:child_process";
import { appendFileSync, chmodSync, closeSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { basename, dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  buildAcceptanceInput, buildCorrectionInput, buildCriteriaDraftInput, extractCriteria, findObjections,
  judgeAcceptance, parseAcceptanceReport, parseCriteriaDraft, scanLogs,
  type AcceptanceRecord, type Criteria, type ParsedAcceptance,
} from "./acceptance-core.ts";
import { EXT_DIR, HERMES_BIN, PERMISSION_EXT, PI_BIN, resolveTestCmd, type AcceptanceConfig } from "./config.ts";
import { deriveSessionId } from "./core.ts";
import type { Exec, ExecResult } from "./git.ts";
import { killGroup, reapProcs, registerProc, unregisterProc } from "./procs.ts";

export const ACCEPTANCE_PROMPT_PATH = join(EXT_DIR, "acceptance-prompt.md");
export const CRITERIA_PROMPT_PATH = join(EXT_DIR, "criteria-prompt.md");
const TOOLS_DIR = join(EXT_DIR, "acceptance-tools");
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
  | { kind: "paused"; reason: string; notes?: string };

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
async function ensureCriteria(deps: AcceptanceDeps): Promise<Criteria | { reason: string; notes?: string }> {
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
    return { reason: "没有需求原文，无法起草验收标准", notes: "给开发方发一条带「## 验收标准」的消息，下次停下时按它验收" };
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
          "--model", config.criteriaModel ?? deps.reviewerModel, "--thinking", deps.reviewerThinking,
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
  return { reason: "验收标准起草失败", notes: lastError };
}

// —— 被测系统 ——

interface RunningSystem {
  exitInfo: () => { code: number | null; signal: string | null } | undefined;
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
  const closed = new Promise<void>((resolveClosed) => {
    child.on("error", (error) => {
      appendFileSync(logPath, `[${timestamp()}] [autoreview] 无法启动：${errorText(error)}\n`);
      exit ??= { code: 127, signal: null };
      resolveClosed();
    });
    child.on("close", (code, signal) => {
      flush("out", true); flush("err", true);
      exit ??= { code, signal };
      resolveClosed();
    });
  });
  return {
    exitInfo: () => exit,
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
function portBusy(url: URL): Promise<boolean> {
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

async function callTester(deps: AcceptanceDeps, inputPath: string, timeout: number): Promise<ExecResult> {
  const { config } = deps;
  const sessionId = deriveSessionId("acc", deps.devSessionId);
  const options = { cwd: deps.runDir, timeout, signal: deps.signal, role: "验收方" };
  if (config.testerCmd) {
    return deps.exec(resolveTestCmd(config.testerCmd), [String(deps.round), inputPath, sessionId, deps.runDir], options);
  }
  return deps.exec(PI_BIN, [
    "--offline", "-p", "--session-id", sessionId, "--model", config.model,
    ...(config.thinking ? ["--thinking", config.thinking] : []),
    "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes",
    "--tools", "read,write,bash,grep,find,ls", "-e", PERMISSION_EXT,
    "--append-system-prompt", ACCEPTANCE_PROMPT_PATH, `@${inputPath}`,
  ], options);
}

/**
 * 最多两次：第 1 次按输入实测；输出解析不了、或通过/不通过的证据对不上时，
 * 在同一会话里发更正要求重做 1 次。两次共用验收截止时间。
 */
async function runTester(deps: AcceptanceDeps, criteria: Criteria, inputPath: string): Promise<{ report?: ParsedAcceptance; error: string }> {
  const evidence = (id: string) => readIfExists(join(deps.runDir, "evidence", `${id}.txt`));
  let report: ParsedAcceptance | undefined;
  let error = "";
  let input = inputPath;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const remaining = deps.deadline - deps.now();
    if (remaining < 60_000) {
      error ||= "验收时间用完";
      break;
    }
    deps.onProgress?.(`自动验收中（第 ${deps.round} 轮${attempt > 1 ? "，重做" : ""}）`);
    let result: ExecResult | undefined;
    try {
      result = await callTester(deps, input, remaining);
    } catch (callError) {
      error = `第 ${attempt} 次验收调用失败：${tailText(errorText(callError), 300)}`;
    }
    deps.checkLive?.();
    if (result) error = execError(result, `第 ${attempt} 次验收`);
    if (result && !error) {
      const parsed = parseAcceptanceReport(result.stdout);
      if (parsed.ok) report = parsed.report;
      else error = `第 ${attempt} 次验收输出无法解析：${parsed.error}`;
    }
    if (attempt === 2) break;
    if (report && !error) {
      const preview = judgeAcceptance({ criteria: criteria.items, report, evidence, logErrors: [], runDir: deps.runDir });
      if (!preview.items.some((item) => item.evidenceProblem)) break;
      input = join(deps.runDir, "correction.md");
      writeFileSync(input, buildCorrectionInput(preview));
    } else if (result && !result.killed && result.code === 0 && result.stdout.trim()) {
      input = join(deps.runDir, "correction.md");
      writeFileSync(input, `## 上次输出无法解析\n${error}\n\n已经留下的证据不用重跑；请按系统提示里的格式，重新输出全部条目的结果。\n`);
    }
  }
  return { report, error: report ? "" : error };
}

/**
 * 跑一轮验收。返回 judged 时由 review.ts 决定返修、暂停或继续评审；
 * paused 只用于不是开发方造成的情况（异议、标准缺失、端口被占用）。
 */
export async function runAcceptanceStage(deps: AcceptanceDeps): Promise<AcceptanceStage> {
  const objections = findObjections(deps.deliveryNote);
  if (objections.length > 0) {
    return {
      kind: "paused", reason: `开发方对验收标准有异议（${objections.join("、")}）`,
      notes: "验收标准只有你能改：同意就发一条带「## 验收标准」的新消息替换；不同意就直接让开发方按原标准继续",
    };
  }
  const criteria = await ensureCriteria(deps);
  deps.checkLive?.();
  if (!("items" in criteria)) return { kind: "paused", reason: criteria.reason, notes: criteria.notes };

  const { config, runDir } = deps;
  const startedAt = deps.now();
  rmSync(runDir, { recursive: true, force: true });
  mkdirSync(join(runDir, "evidence"), { recursive: true });
  writeTools(runDir, deps.workDir);
  const logPath = join(runDir, "system.log");
  writeFileSync(logPath, "");
  if (deps.procsFile) reapProcs(deps.procsFile);

  const offsets = logOffsets(config.logs);
  let system: RunningSystem | undefined;
  let systemFailure: string | undefined;
  let tester: { report?: ParsedAcceptance; error: string } = { error: "" };
  try {
    if (config.start) {
      if (config.readyUrl && await portBusy(new URL(config.readyUrl))) {
        const url = new URL(config.readyUrl);
        return {
          kind: "paused", reason: `端口 ${url.port || url.protocol} 已被占用（环境问题，不算开发方的错）`,
          notes: `启动被测系统前 ${config.readyUrl} 已经有程序在监听；关掉它后发消息让开发方继续即可`,
        };
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
        deliveryNote: deps.deliveryNote, previousFailed: deps.previousFailed,
      }));
      tester = await runTester(deps, criteria, inputPath);
      const exit = system?.exitInfo();
      if (exit) {
        systemFailure = `系统在验收过程中退出了（退出码 ${exit.code ?? exit.signal}）\n系统输出最后几行：\n${tailText(readIfExists(logPath) ?? "", 1500) || "（无输出）"}`;
      }
    }
  } finally {
    await system?.stop();
  }

  const logTexts = [readIfExists(logPath) ?? ""];
  if (config.logs.length > 0) mkdirSync(join(runDir, "logs"), { recursive: true });
  config.logs.forEach((file, index) => {
    const text = readAppended(file, offsets.get(file) ?? 0);
    writeFileSync(join(runDir, "logs", `${index + 1}-${basename(file)}`), text);
    logTexts.push(text);
  });
  const logErrors = scanLogs(logTexts.join("\n"), config.errorPatterns, config.ignorePatterns);
  const judged = judgeAcceptance({
    criteria: criteria.items, report: tester.report, reportError: tester.error,
    evidence: (id) => readIfExists(join(runDir, "evidence", `${id}.txt`)),
    systemFailure, logErrors, runDir,
  });
  const record: AcceptanceRecord = { ...judged, durationMs: deps.now() - startedAt };
  writeFileSync(join(runDir, "result.json"), JSON.stringify(record, null, 2));
  return { kind: "judged", record };
}

/** 运行目录：~/.pi-autoreview/<项目>/acceptance/<会话>/r<轮次>。 */
export function acceptanceRunDir(baseDir: string, round: number): string {
  return join(baseDir, `r${round}`);
}
