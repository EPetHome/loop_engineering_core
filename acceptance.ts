/**
 * acceptance.ts — 自动验收一轮的流程，经 review.ts 由 pi 扩展与宿主 Hook 共用。
 *
 * 负责：异议检查（标准异议暂停等用户；方法存疑照常验收）→ 取或起草验收标准（冻结）→ [授权] 条目等你答复 → 查端口、启动被测系统、等就绪、记系统日志
 * → 首次及强模型重验前按配置重置数据 → 调验收方（证据有问题在同一会话重做 1 次，还不行换强模型重验 1 次）
 * → 验收方挂住/断线时用强模型只读已有证据补报告 → 关停系统、清理端口上的残留进程、截取日志、扫错误 → 程序逐条判定。
 * 被测系统自成进程组并登记，任何退出路径都会关停；验收途中系统退出就立即停掉验收方，
 * 按退出方式分「被关掉」（不怪开发方）和「崩溃」；判定交给 acceptance-core.ts 的纯函数。
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cpSync, lstatSync, readdirSync, appendFileSync, chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  buildAcceptanceInput, buildCorrectionInput, buildCriteriaDraftInput, buildRecoveryInput, classifySystemExit, dataStateNote, extractCriteria, hasEvidence,
  authorizationHint, authorizationStatus, findObjections, mergeAcceptanceReports, forUser, judgeAcceptance, parseAcceptanceReport, parseCriteriaDraft,
  scanLogs, type AcceptanceRecord, type Criteria, type Grants, type ParsedAcceptance,
} from "./acceptance-core.ts";
import { EXT_DIR, HERMES_BIN, MARKER_FILE, PERMISSION_EXT, PI_BIN, resolveTestCmd, type AcceptanceConfig } from "./config.ts";
import { deriveSessionId } from "./core.ts";
import { createActionObserver } from "./acceptance-activity.ts";
import { toolEventsPath } from "./acceptance-events.ts";
import type { Exec, ExecResult } from "./git.ts";
import { killGroup, reapProcs, registerProc, releaseProc } from "./procs.ts";
import { classifyFailure, classifyTesterFailure, failureLabel, testerDiagnostics } from "./failure.ts";
import { createRunResource, releaseRunResource, resourceLine, type RunResource } from "./resources.ts";

export const ACCEPTANCE_PROMPT_PATH = join(EXT_DIR, "acceptance-prompt.md");
export const CRITERIA_PROMPT_PATH = join(EXT_DIR, "criteria-prompt.md");
export const RECOVERY_PROMPT_PATH = join(EXT_DIR, "acceptance-recovery-prompt.md");
export const ACCEPTANCE_EVENTS_PATH = join(EXT_DIR, "acceptance-events.ts");
const TOOLS_DIR = join(EXT_DIR, "acceptance-tools");
/** 系统在验收途中退出后，收尾时盯端口的时长。 */
const WATCH_PORT_MS = 10_000;
/** 截取单个日志文件的上限，防止把巨型日志读进内存。 */
const MAX_LOG_BYTES = 2 * 1024 * 1024;
const SCRIPT_FILE = /\.(?:[cm]?[jt]sx?|py|sh|bash|zsh|rb|pl|ps1|json)$/i;

/** 验收用到的会话状态；ReviewState 在此基础上扩展。 */
export interface AcceptanceState {
  requirement?: string;
  criteria?: Criteria;
  /** 用户对 [授权] 条目的答复（只认用户亲手写的「同意授权：…」「不授权：…」）。 */
  grants?: Grants;
  /** 已经处理过的开发方回复（按回复原文的哈希）：同一条旧回复里的异议不再重复触发暂停。 */
  objectionsHandled?: string;
}

export interface AcceptanceDeps {
  /** 收尾不受业务取消信号或失效宿主上下文阻断。 */
  cleanupExec?: Exec;
  onCleanup?: (work: Promise<void>, recordPath: string) => void;
  resource?: RunResource;
  callId?: string;
  /** 整合验收采用的各段资格身份，仅存审计材料，不作为通过证据。 */
  upstreamEpochs?: unknown;
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
  /** 交给项目方法的环境变量（AUTOREVIEW_BASE_REV 等）；被测系统、重置、验收命令共用。 */
  env?: NodeJS.ProcessEnv;
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
  | { kind: "paused"; reason: string; notes?: string; hint: string; failureKind?: import("./failure.ts").FailureKind };

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
  const processToken = randomUUID();
  const env = {
    ...process.env, AUTOREVIEW_PROCESS_OWNER: processToken, PATH: `${HERMES_BIN}:${process.env.PATH ?? ""}`, ...config.env, ...(deps.env ?? {}), AUTOREVIEW_RUN_DIR: deps.runDir,
    ...(deps.resource ? { AUTOREVIEW_RUN_ID: deps.resource.id, AUTOREVIEW_TEMP_DIR: deps.resource.dir, AUTOREVIEW_EVIDENCE_DIR: deps.resource.evidenceDir, TMPDIR: deps.resource.evidenceDir } : {}),
  };
  const child = spawn("/bin/sh", ["-c", config.start!], { cwd: deps.workDir, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const pid = child.pid;
  if (pid && deps.procsFile) {
    try { registerProc(deps.procsFile, pid, "被测系统", config.start!, processToken, deps.resource?.id); } catch { /* 登记失败不影响验收 */ }
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
      }
      if (pid && deps.procsFile) {
        if (!releaseProc(deps.procsFile, pid)) throw new Error("被测系统子进程释放未确认，登记已保留");
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
async function cleanupPort(config: AcceptanceConfig, since: number, watchMs: number, resourceId?: string): Promise<string[]> {
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
        // 时间和端口只能帮助发现；只有本轮唯一标识能确认进程属于本任务。
        const env = spawnSync("ps", ["eww", "-p", String(item.pid), "-o", "command="], { encoding: "utf8", timeout: 5000 });
        const owned = resourceId && env.status === 0 && new RegExp(`(?:^|\\s)AUTOREVIEW_RUN_ID=${resourceId}(?:\\s|$)`).test(env.stdout ?? "");
        if (!owned) {
          notes.push(`端口 ${port} 的 pid ${item.pid} 无法确认属于本轮，未关闭；需检查归属`);
          continue;
        }
        try {
          process.kill(item.pid, "SIGTERM");
          killed.push(item.pid);
          notes.push(`端口 ${port} 上有验收期间起的进程 pid ${item.pid}（${item.command}），不是程序启动的被测系统，已发出关闭请求`);
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
    const env = spawnSync("ps", ["eww", "-p", String(pid), "-o", "command="], { encoding: "utf8", timeout: 5000 });
    if (resourceId && env.status === 0 && env.stdout.split(/\s+/).includes(`AUTOREVIEW_RUN_ID=${resourceId}`)) {
      try { process.kill(pid, "SIGKILL"); } catch { /* 已经退出 */ }
    }
  }
  if (await portBusy(url)) notes.push(`资源释放未确认：端口 ${port} 仍被占用，未关闭未知归属进程`);
  else if (killed.length) notes.push(`端口 ${port} 已释放`);
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
    result: `exec ${node} ${shellQuote(join(TOOLS_DIR, "result.mjs"))} ${shellQuote(runDir)} "$@"`,
    ev: `exec ${node} ${shellQuote(join(TOOLS_DIR, "ev.mjs"))} ${shellQuote(runDir)} "$@"`,
    browser: `exec ${node} ${shellQuote(join(TOOLS_DIR, "browser.mjs"))} ${shellQuote(runDir)} ${shellQuote(workDir)} "$@"`,
  };
  for (const [name, line] of Object.entries(scripts)) {
    const file = join(runDir, name);
    writeFileSync(file, `#!/bin/sh\n${line}\n`);
    chmodSync(file, 0o755);
  }
}

/** 只看本次调用的活动文件，不以被测系统的持续日志输出延长验收方空闲时间。 */
function activityStamp(paths: string[]): string {
  const entries: string[] = [];
  const visit = (path: string): void => {
    try {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) return;
      entries.push(`${path}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`);
      if (stat.isDirectory()) for (const name of readdirSync(path).sort()) visit(join(path, name));
    } catch { /* 文件尚未创建或正在替换，下次轮询再看。 */ }
  };
  for (const path of paths) visit(path);
  return entries.join("\n");
}

/** 用于把实际新建并执行的脚本关联到条目；不扫描依赖、旧代次和程序证据。 */
function scriptFiles(runDir: string): string[] {
  const files: string[] = [];
  const visit = (path: string): void => {
    try {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) return;
      if (stat.isDirectory()) {
        for (const name of readdirSync(path)) {
          if (["evidence", "checkpoints", "tester-sessions", "actions", "node_modules", ".git"].includes(name) || name.startsWith("attempt-")) continue;
          visit(join(path, name));
        }
      } else if (SCRIPT_FILE.test(path)) files.push(path);
    } catch { /* 验收方可能删除临时脚本，不据此猜路径。 */ }
  };
  visit(runDir);
  // write 工具可能把脚本写到本轮外的临时目录；只从本轮会话的成功写入记录取路径，不扫描用户目录。
  for (const phase of ["tester", "strong"]) {
    const dir = join(runDir, "tester-sessions", phase);
    let names: string[];
    try { names = readdirSync(dir).filter((name) => name.endsWith(".jsonl")); } catch { continue; }
    for (const name of names) {
      const writes = new Map<string, string>();
      for (const line of (readIfExists(join(dir, name)) ?? "").split("\n")) {
        try {
          const entry = JSON.parse(line), message = entry.type === "message" ? entry.message : undefined;
          if (message?.role === "assistant" && Array.isArray(message.content)) {
            for (const call of message.content) {
              const path = call.arguments?.path;
              if (call.type === "toolCall" && call.name === "write" && typeof call.id === "string" && typeof path === "string") writes.set(call.id, resolve(runDir, path));
            }
          } else if (message?.role === "toolResult" && message.toolName === "write" && message.isError === false) {
            const path = writes.get(message.toolCallId);
            if (path && SCRIPT_FILE.test(path)) files.push(path);
          }
        } catch { /* 忽略未知记录和中断时尚未写完整的一行。 */ }
      }
    }
  }
  return [...new Set(files)];
}

type TesterCallResult = ExecResult & { stalled: boolean; actionPending?: boolean };

/** strong 是从头重验；recovery 是独立会话、仅 read 工具、只补报告。两者都使用 strongModel。 */
async function callTester(deps: AcceptanceDeps, inputPath: string, timeout: number, strong = false, recovery = false): Promise<TesterCallResult> {
  const { config } = deps;
  const sessionId = deriveSessionId(recovery ? "acc-report" : strong ? "acc-strong" : "acc", deps.devSessionId);
  const sessionDir = join(deps.runDir, "tester-sessions", recovery ? "report" : strong ? "strong" : "tester");
  mkdirSync(sessionDir, { recursive: true });
  const controller = new AbortController();
  const signal = deps.signal ? AbortSignal.any([deps.signal, controller.signal]) : controller.signal;
  const idleMs = config.idleTimeoutSec * 1000;
  const paths = [sessionDir, toolEventsPath(deps.runDir, deps.callId ?? ""), join(deps.runDir, "evidence"), join(deps.runDir, "checkpoints", deps.callId ?? "")];
  let stamp = activityStamp(paths), lastActivity = Date.now(), stalled = false;
  let actionAtStop: boolean | undefined;
  const observeAction = createActionObserver(deps.runDir, sessionDir, deps.callId ?? "", Date.now());
  const timer = setInterval(() => {
    if (signal.aborted) return;
    const action = observeAction();
    if (action) {
      lastActivity = Date.now();
      return;
    }
    const current = activityStamp(paths);
    if (current !== stamp) { stamp = current; lastActivity = Date.now(); }
    if (Date.now() - lastActivity >= idleMs) {
      stalled = true;
      controller.abort();
    }
  }, Math.min(1000, Math.max(10, idleMs / 4)));
  // 归因取终止边界的最新状态：预算/取消先留现场，再由执行器清理；不能用轮询缓存或清理后的进程消失代替。
  const actionOnReturn = (): boolean => actionAtStop ?? Boolean(observeAction());
  const options = { cwd: deps.runDir, timeout, signal, role: "验收方", onOutput: () => { lastActivity = Date.now(); },
    onBeforeStop: () => { if (actionAtStop === undefined) actionAtStop = Boolean(observeAction()); },
    ...(deps.env ? { env: deps.env } : {}) };
  const execute: Exec = (command, args, opts) => deps.resource
    ? deps.exec("/usr/bin/env", [`AUTOREVIEW_ACCEPTANCE_CALL=${deps.callId ?? ""}`, `AUTOREVIEW_RUN_ID=${deps.resource.id}`, `AUTOREVIEW_TEMP_DIR=${deps.resource.dir}`, `AUTOREVIEW_EVIDENCE_DIR=${deps.resource.evidenceDir}`, `TMPDIR=${deps.resource.evidenceDir}`, command, ...args], opts)
    : deps.exec(command, args, opts);
  try {
    let result: ExecResult;
    if (config.testerCmd) {
      result = await execute(resolveTestCmd(config.testerCmd), [String(deps.round), inputPath, sessionId, deps.runDir], options);
    } else {
      const model = strong || recovery ? ["--model", config.strongModel ?? deps.reviewerModel, "--thinking", deps.reviewerThinking]
        : ["--model", config.model, ...(config.thinking ? ["--thinking", config.thinking] : [])];
      result = await execute(PI_BIN, [
        "--offline", "-p", "--session-id", sessionId, "--session-dir", sessionDir, ...model,
        "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-mcp",
        "--tools", recovery ? "read" : "read,write,bash,grep,find,ls", "-e", PERMISSION_EXT, "-e", ACCEPTANCE_EVENTS_PATH,
        "--append-system-prompt", recovery ? RECOVERY_PROMPT_PATH : ACCEPTANCE_PROMPT_PATH, `@${inputPath}`,
      ], options);
    }
    if (result.processesReleased !== true) {
      result = { ...result, code: 75, processesReleased: false, stderr: `${result.stderr}\nAUTOREVIEW_FAILURE=environment 子进程释放未确认，不能补判或发布完成\n` };
    }
    // 原始诊断只留运行材料，不把 Pi 的无关启动告警带进暂停原因。
    writeFileSync(join(deps.runDir, `tester-${deps.callId}.log`), `${result.stdout}\n--- stderr\n${result.stderr}`);
    return { ...result, stalled, actionPending: actionOnReturn() };
  } catch (error) {
    // reject 没有提供进程释放证明；即使已有全部证据，也只能保留结果并暂停，不能擅自补判。
    return { stdout: "", stderr: `${errorText(error)}\nAUTOREVIEW_FAILURE=environment 子进程释放未确认，执行器取消时未提供释放证明\n`,
      code: 75, killed: true, stalled, actionPending: actionOnReturn(), processesReleased: false };
  } finally { clearInterval(timer); }
}

interface TesterRun {
  report?: ParsedAcceptance;
  error: string;
  escalated: boolean;
  recovery?: AcceptanceRecord["recovery"];
  processesReleased?: boolean;
  /** 断线时冻结已有证据，过期调用或补报告不能凭后来写入的证据补成通过。 */
  evidence?: Map<string, string | undefined>;
  executionFailure?: { kind: import("./failure.ts").FailureKind; reason: string };
  /** 重置数据失败的说明（环境问题，暂停）。 */
  resetFailure?: string;
}

const resetLogOf = (runDir: string): string => join(runDir, "reset.log");

/**
 * 重置数据：在开发目录用 sh -c 跑 acceptance.reset，环境同被测系统；输出写 reset.log（不进 system.log，
 * 以免重置时打的错误被当成系统错误）。没配置返回空串；失败返回说明。
 */
async function runReset(deps: AcceptanceDeps, label: string, cleanup = false): Promise<string> {
  const { config } = deps;
  const command = cleanup ? config.cleanup : config.reset;
  if (!command) return "";
  if (!cleanup) deps.onProgress?.(`自动验收：重置数据（第 ${deps.round} 轮${label}）`);
  const timeout = Math.max(1000, Math.min(config.resetTimeoutSec * 1000, cleanup ? Infinity : deps.deadline - deps.now()));
  const env = [
    `PATH=${HERMES_BIN}:${process.env.PATH ?? ""}`,
    ...Object.entries(config.env).map(([key, value]) => `${key}=${value}`),
    ...Object.entries(deps.env ?? {}).map(([key, value]) => `${key}=${value}`),
    // 项目环境不能覆盖程序分配的资源身份与证据目录。
    `AUTOREVIEW_RUN_DIR=${deps.runDir}`,
    ...(deps.resource ? [`AUTOREVIEW_RUN_ID=${deps.resource.id}`, `AUTOREVIEW_TEMP_DIR=${deps.resource.dir}`, `AUTOREVIEW_EVIDENCE_DIR=${deps.resource.evidenceDir}`, `TMPDIR=${deps.resource.evidenceDir}`] : []),
  ];
  const log = (text: string): void => appendFileSync(cleanup ? join(deps.runDir, "cleanup.log") : resetLogOf(deps.runDir), `=== ${timestamp()}${label ? ` ${label.replace(/^，/, "")}` : ""}\n$ ${command}\n${text}\n`);
  let result: ExecResult;
  try {
    result = await (cleanup ? deps.cleanupExec ?? deps.exec : deps.exec)("/usr/bin/env", [...env, "/bin/sh", "-c", command], {
      cwd: deps.workDir, timeout, signal: cleanup ? undefined : deps.signal, role: cleanup ? "释放项目资源" : "重置数据",
    });
  } catch (error) {
    if (!cleanup) deps.checkLive?.();
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
 * 首次和强模型从头重验前按配置重置数据，更正和只读补报告不重置；被测系统一退出就不再继续。
 * 模型断线/挂住时冻结现有证据，另开一次只读强模型补报告，仍共用本轮截止时间。
 */
async function runTester(deps: AcceptanceDeps, criteria: Criteria, inputPath: string, systemDown: () => boolean): Promise<TesterRun> {
  let savedEvidence: TesterRun["evidence"];
  const evidence = (id: string) => savedEvidence ? savedEvidence.get(id) : readIfExists(join(deps.runDir, "evidence", `${id}.txt`));
  const hasService = Boolean(deps.config.start);
  const testerFault = (report?: ParsedAcceptance): boolean => !report || judgeAcceptance({
    criteria: criteria.items, report, evidence, logErrors: [], runDir: deps.runDir, hasService,
  }).items.some((item) => item.cause === "验收方");
  let report: ParsedAcceptance | undefined;
  let error = "";
  let executionFailure: TesterRun["executionFailure"];
  let recovery: TesterRun["recovery"];
  let processesReleased: boolean | undefined;
  const noteRelease = (result: ExecResult): void => {
    if (result.processesReleased !== undefined) processesReleased = processesReleased === false ? false : result.processesReleased;
  };
  let input = inputPath;
  let escalated = false;
  let attemptId = "", callId = "";
  const checkpoints = (): ParsedAcceptance | undefined => {
    const items = criteria.items.filter((item) => !forUser(item)).flatMap(({ id }) => {
      try {
        const value = JSON.parse(readFileSync(join(deps.runDir, "checkpoints", callId, `${id}.json`), "utf8"));
        if (value.attempt !== attemptId || value.call !== callId || value.id !== id || !["通过", "不通过", "无法验证"].includes(value.verdict)
          || !value.fields || typeof value.fields !== "object" || Array.isArray(value.fields)
          || Object.values(value.fields).some((v) => typeof v !== "string")) return [];
        return [{ id, verdict: value.verdict, fields: value.fields }];
      } catch { return []; }
    });
    return items.length ? { conclusion: "逐条检查点（仍需证据核对）", items, extra: [] } : undefined;
  };
  const recover = async (reason: string): Promise<void> => {
    savedEvidence = new Map(criteria.items.map(({ id }) => [id, evidence(id)]));
    recovery = { reason, attempted: false };
    const preview = judgeAcceptance({ criteria: criteria.items, report, evidence, logErrors: [], runDir: deps.runDir, hasService });
    const ids = criteria.items.filter((item) => !forUser(item) && hasEvidence(evidence(item.id), item.id)
      && !report?.items.find((entry) => entry.id === item.id)?.conflict
      && preview.items.find((entry) => entry.id === item.id)?.verdict === "无法验证").map(({ id }) => id);
    if (!ids.length) { recovery.error = "没有待补判的有效证据；已提交结果仍按证据核对"; return; }
    const remaining = deps.deadline - deps.now();
    if (remaining < 60_000) { recovery.error = "剩余验收预算不足 1 分钟，未补写报告；已有报告和检查点照常按证据判定"; return; }
    if (systemDown() || deps.signal?.aborted) return;
    const recoveryPath = join(deps.runDir, "recovery.md");
    writeFileSync(recoveryPath, buildRecoveryInput(criteria, deps.runDir, ids));
    callId = randomUUID(); writeFileSync(join(deps.runDir, "call-id"), callId);
    recovery.attempted = true;
    deps.onProgress?.(`自动验收：验收方模型断线，用强模型只读已有证据补报告（第 ${deps.round} 轮）`);
    try {
      const result = await callTester({ ...deps, callId }, recoveryPath, remaining, false, true);
      noteRelease(result);
      deps.checkLive?.();
      if (result.code !== 0 || result.killed || result.stalled) {
        const failure = classifyTesterFailure(result.code, `${result.stdout}\n${result.stderr}`, result.killed, result.stalled);
        recovery.error = `补报告未正常结束：${failure.reason}`;
        if (!failure.disconnected) executionFailure = failure;
      }
      const parsed = parseAcceptanceReport(result.stdout);
      if (parsed.ok) report = mergeAcceptanceReports(report, { ...parsed.report, items: parsed.report.items.filter((item) => ids.includes(item.id)) });
      else recovery.error ||= `补报告无法解析：${parsed.error}`;
    } catch (callError) {
      deps.checkLive?.();
      recovery.error = `补报告调用失败：${tailText(testerDiagnostics(errorText(callError)), 300) || "没有有效诊断"}`;
    }
  };
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
    // 格式/证据更正复用本次已完成动作；重置、强模型重验则开启新证据代次。
    if (attempt === 1 || strong) {
      if (attempt > 1) {
        const archive = join(deps.runDir, `attempt-${attemptId}`); mkdirSync(archive);
        for (const name of ["evidence", "checkpoints"]) {
          if (existsSync(join(deps.runDir, name))) renameSync(join(deps.runDir, name), join(archive, name));
        }
        mkdirSync(join(deps.runDir, "evidence"));
        report = undefined;
      }
      attemptId = randomUUID(); writeFileSync(join(deps.runDir, "attempt-id"), attemptId);
    }
    const resetFailure = attempt === 1 || strong ? await runReset(deps, attempt === 1 ? "" : "，换强模型前") : "";
    deps.checkLive?.();
    if (resetFailure) return { report, error, escalated, resetFailure };
    if (systemDown()) break;
    const remaining = deps.deadline - deps.now();
    if (remaining < 60_000) {
      error ||= "验收时间用完";
      break;
    }
    deps.onProgress?.(`自动验收中（第 ${deps.round} 轮${attempt === 2 ? "，重做" : strong ? "，换强模型重验" : ""}）`);
    let result: TesterCallResult | undefined;
    let disconnected = "";
    let currentReport: ParsedAcceptance | undefined;
    callId = randomUUID(); writeFileSync(join(deps.runDir, "call-id"), callId);
    try {
      result = await callTester({ ...deps, callId }, input, remaining, strong);
    } catch (callError) {
      const clean = testerDiagnostics(errorText(callError));
      error = `第 ${attempt} 次验收调用失败：${tailText(clean, 300) || "没有有效诊断"}`;
      executionFailure = { kind: "unknown", reason: `${error}；无法确认验收方及工具进程已停止` };
    }
    deps.checkLive?.();
    if (strong) escalated = true;
    if (result) {
      noteRelease(result);
      error = execError({ ...result, stderr: testerDiagnostics(result.stderr) }, `第 ${attempt} 次验收`);
      if (result.code !== 0 || result.killed || result.stalled) {
        const failure = classifyTesterFailure(result.code, `${result.stdout}\n${result.stderr}`, result.killed, result.stalled);
        if (failure.disconnected && result.actionPending) {
          executionFailure = { kind: "environment", reason: "被测命令或验收工具仍在执行时调用被终止（整轮预算耗尽或中断）；不是验收方模型断线" };
        } else if (failure.disconnected) disconnected = result.stalled ? `${failure.reason}，空闲时限 ${deps.config.idleTimeoutSec} 秒` : failure.reason;
        else executionFailure = failure;
      }
      // 即使进程后来断线，也保留此前已完整输出的报告和逐条检查点。
      const parsed = parseAcceptanceReport(result.stdout);
      if (parsed.ok) currentReport = parsed.report;
      else if (!error) error = `第 ${attempt} 次验收输出无法解析：${parsed.error}`;
    }
    report = mergeAcceptanceReports(report, currentReport, checkpoints());
    if (systemDown() || deps.signal?.aborted) break;
    if (disconnected) { await recover(disconnected); break; }
    if (executionFailure || strong) break;
    if (report && !testerFault(report)) { error = ""; break; }
    if (attempt === 2) continue;
    if (report && !error) {
      const preview = judgeAcceptance({ criteria: criteria.items, report, evidence, logErrors: [], runDir: deps.runDir, hasService });
      if (!preview.items.some((item) => item.evidenceProblem)) break;
      input = join(deps.runDir, "correction.md");
      writeFileSync(input, buildCorrectionInput(preview, false));
    } else if (result && !result.killed && result.code === 0 && result.stdout.trim()) {
      input = join(deps.runDir, "correction.md");
      writeFileSync(input, `## 上次输出无法解析\n${error}\n\n已经留下的证据不用重跑；请按系统提示里的格式，重新输出全部条目的结果。\n`);
    }
  }
  return { report, error: report ? "" : error, escalated, executionFailure, recovery, evidence: savedEvidence, processesReleased };
}

/**
 * 跑一轮验收。返回 judged 时由 review.ts 决定返修、暂停或继续评审；
 * paused 只用于不是开发方造成的情况（异议、标准缺失、端口被占用）。
 */
export async function runAcceptanceStage(deps: AcceptanceDeps): Promise<AcceptanceStage> {
  const groups = findObjections(deps.deliveryNote);
  // 同一条旧回复只处理一次：记下回复指纹，用户回复后重复验收不再因它暂停。
  const replyKey = createHash("sha256").update(deps.deliveryNote).digest("hex");
  if (groups.objections.length > 0 && deps.state.objectionsHandled !== replyKey) {
    deps.state.objectionsHandled = replyKey;
    await deps.saveState();
    const hint = `开发方对 ${groups.objections.join("、")} 有异议（理由见它的回复）。验收标准只有你能改：同意就发一条带「## 验收标准」的新消息替换；不同意就发消息让它按原标准继续`;
    return { kind: "paused", reason: `开发方对验收标准有异议（${groups.objections.join("、")}）`, notes: hint, hint };
  }
  const methodDoubts = groups.doubts;
  const frozen = await ensureCriteria(deps);
  deps.checkLive?.();
  if (!("items" in frozen)) return { kind: "paused", reason: frozen.reason, notes: frozen.notes, hint: frozen.hint };
  // [授权] 条目要你先答复：同意就照常交给验收方，不授权就留给你人工验收；还没答复就停下来问你。
  const auth = authorizationStatus(frozen, deps.state.grants);
  if (auth.pending.length > 0) {
    const hint = authorizationHint(frozen, auth.pending);
    return { kind: "paused", reason: `等你授权（${auth.pending.join("、")}）`, notes: hint, hint };
  }
  const criteria: Criteria = auth.denied.length === 0 ? frozen
    : { ...frozen, items: frozen.items.map((item) => auth.denied.includes(item.id) ? { ...item, declined: true } : item) };

  // 恢复或重复调用不能覆盖旧轮证据；新轮有独立目录，报告记录实际位置。
  if (existsSync(deps.runDir)) deps = { ...deps, runDir: `${deps.runDir}-${randomUUID().slice(0, 8)}` };
  const { config, runDir } = deps;
  // 标准全部交给你（[人工] 或不授权）：没有要验收方做的，不启动系统、不调验收方，整轮记部分验证，完成时列给你。
  if (criteria.items.every(forUser)) {
    rmSync(runDir, { recursive: true, force: true });
    mkdirSync(runDir, { recursive: true });
    if (deps.upstreamEpochs) writeFileSync(join(runDir, "upstream.json"), JSON.stringify(deps.upstreamEpochs, null, 2));
    const record: AcceptanceRecord = {
      ...judgeAcceptance({ criteria: criteria.items, evidence: () => undefined, logErrors: [], runDir, hasService: Boolean(config.start) }),
      durationMs: 0,
      ...(methodDoubts.length ? { methodDoubts } : {}),
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
  if (deps.upstreamEpochs) writeFileSync(join(runDir, "upstream.json"), JSON.stringify(deps.upstreamEpochs, null, 2));
  if (config.actions) {
    const check = (path: string): void => {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error(`验收动作不能使用符号链接：${path}`);
      if (stat.isDirectory()) for (const name of readdirSync(path)) check(join(path, name));
    };
    check(config.actions);
    cpSync(config.actions, join(runDir, "actions"), { recursive: true, dereference: false });
  }
  const logPath = join(runDir, "system.log");
  writeFileSync(logPath, "");
  if (deps.procsFile) reapProcs(deps.procsFile);

  const initialScripts = new Set(scriptFiles(runDir));
  const offsets = logOffsets(config.logs);
  let resource: RunResource;
  try { resource = createRunResource(`acceptance:${deps.devSessionId}:r${deps.round}`, undefined, deps.procsFile); }
  catch (error) { return { kind: "paused", reason: `验收环境阻塞：${errorText(error)}`, hint: "释放已授权的资源或恢复容量后继续，业务返修次数保持不变。", failureKind: "environment" }; }
  deps = { ...deps, resource };
  let cleanupDone = (): void => {};
  const cleanupPath = join(runDir, "cleanup-task.json");
  const cleanupState = { runId: resource.id, workDir: deps.workDir, configRoot: config.root,
    tempDir: resource.dir, status: "pending", reason: "", log: join(runDir, "cleanup.log") };
  let system: RunningSystem | undefined;
  let systemFailure: string | undefined;
  let tester: TesterRun = { error: "", escalated: false };
  /** 验收方开始实测之后系统退出的情况（启动阶段就退出的算 notReady）。 */
  let exitDuringTest: { code: number | null; signal: string | null } | undefined;
  let exitedAt: number | undefined;
  let cleanup: string[] = [];
  try {
  if (config.cleanup) {
    writeFileSync(cleanupPath, JSON.stringify(cleanupState, null, 2), { mode: 0o600 });
    deps.onCleanup?.(new Promise<void>((resolve) => { cleanupDone = resolve; }), cleanupPath);
  }

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
        authorized: auth.approved, methodDoubts,
      }) + (config.actions ? "\n## 复用项目动作\n当前目录 actions/ 是项目提供的固定操作脚本，只按指南调用并通过 ./ev 留证据；不要重写已有步骤，不沿用旧验收结论。\n" : ""));
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
      if (tester.processesReleased === true) cleanup.push("验收方调用及工具子进程已按归属确认停止（含独立进程组）");
      exitDuringTest = system?.exitInfo();
      exitedAt = system?.exitedAt();
    }
  } finally {
    try {
      try { await system?.stop(); } catch (error) { cleanup.push(`资源释放未确认：${errorText(error)}`); }
      cleanup.push(...(system ? await cleanupPort(config, wallStart, exitDuringTest ? WATCH_PORT_MS : 0, resource.id) : []));
    } finally {
      try {
        if (config.cleanup) {
          cleanupState.status = "running";
          writeFileSync(cleanupPath, JSON.stringify(cleanupState, null, 2), { mode: 0o600 });
          let failure: string;
          try { failure = await runReset({ ...deps, signal: undefined }, "，释放资源", true); }
          catch (error) { failure = errorText(error); }
          cleanupState.status = failure ? "failed" : "released"; cleanupState.reason = failure;
          writeFileSync(cleanupPath, JSON.stringify(cleanupState, null, 2), { mode: 0o600 });
          cleanup.push(failure ? `资源释放未确认：${failure}；见 cleanup.log` : "项目资源释放脚本：通过（见 cleanup.log）");
        }
      } finally { try { releaseRunResource(resource); } finally { cleanupDone(); } }
      cleanup.push(resourceLine(resource));
    }
  }

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
    evidence: (id) => tester.evidence ? tester.evidence.get(id) : readIfExists(join(runDir, "evidence", `${id}.txt`)),
    testerDisconnected: tester.recovery ? [tester.recovery.reason, tester.recovery.error].filter(Boolean).join("；") : undefined,
    writtenScripts: scriptFiles(runDir).filter((path) => !initialScripts.has(path)),
    systemFailure, systemStopped, logErrors, runDir, hasService: Boolean(config.start),
  });
  const record: AcceptanceRecord = { ...judged, durationMs: deps.now() - startedAt, ...(methodDoubts.length ? { methodDoubts } : {}) };
  const g1 = record.items.find((item) => item.id === "G1");
  if (g1 && config.start) g1.execution = { commands: [config.start.length > 240 ? `${config.start.slice(0, 239)}…` : config.start], scripts: [] };
  if (tester.recovery) record.recovery = tester.recovery;
  if (tester.executionFailure && !exitDuringTest) {
    record.verdict = "无法验收"; record.failureKind = tester.executionFailure.kind;
    record.reason = `验收执行未正常结束：${tester.executionFailure.reason}；逐项结果保留，不能发布完成`;
  }
  const failure = classifyFailure(1, [systemFailure ?? "", ...logErrors].join("\n"));
  if (failure.kind === "environment" || failure.kind === "method") {
    record.verdict = "无法验收";
    record.failureKind = failure.kind;
    record.reason = `${failureLabel(failure.kind)}：${failure.reason}`;
    for (const item of record.items.filter((item) => item.id === "G1" || item.id === "G2")) {
      item.verdict = "无法验证";
      item.cause = "其他";
    }
  }
  if (resource.status === "cleanup-failed" || cleanup.some((line) => /无法确认属于本轮|资源释放未确认/.test(line))) {
    record.verdict = "无法验收";
    record.failureKind = "environment";
    record.reason = "资源释放或归属尚未确认，不能接力到下一轮";
  }
  if (tester.escalated) record.escalated = true;
  if (cleanup.length > 0) record.cleanup = cleanup;
  writeFileSync(join(runDir, "result.json"), JSON.stringify(record, null, 2));
  return { kind: "judged", record };
}

/** 运行目录：~/.pi-autoreview/<项目>/acceptance/<会话>/r<轮次>。 */
export function acceptanceRunDir(baseDir: string, round: number): string {
  return join(baseDir, `r${round}`);
}
