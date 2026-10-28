/** Hook 宿主原会话通道：PTY 只转发用户输入；返修走原生收件 API，绝不操作草稿。 */
import { constants, accessSync, chmodSync, cpSync, existsSync, lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inboxPath, pollMs, readJson, statusPath, type InboxMessage, type StageStatus } from "../pipeline-core.ts";
import { processStartTime } from "../procs.ts";
import { localInboxSocket, nativeCommand, nativeLaunch, sendNativeRepair, type ClaudeInbox } from "./native-inbox.ts";

interface Bridge {
  token: string; host: string; sessionId?: string; pid: number; started: string; childPid: number; childStarted: string;
  socket?: string;
}
interface NativeBinding { token: string; sessionId: string; childPid: number; childStarted: string; channel: ClaudeInbox }
interface RepairDispatch { seq: number; sessionId: string; signal: string; id?: string; prepared?: boolean; sent?: boolean; sentAt?: number; warning?: string }
interface BridgeInput { token: string; dispatches: RepairDispatch[]; error?: string }
type BridgeIdentity = Pick<StageStatus, "sessionId" | "host" | "pid" | "processStarted" | "inputBridge">;
interface PtySubscription { dispose(): void }
interface Pty {
  pid: number; write(data: string | Buffer): void; resize(cols: number, rows: number): void; kill(signal?: string): void;
  onData(listener: (data: string) => void): PtySubscription;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): PtySubscription;
}
interface PtyModule { spawn(file: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; name: string; cols: number; rows: number }): Pty }
export const inputBridgePath = (dir: string, stage: string): string => statusPath(dir, stage).replace(/\.status\.json$/, ".input-bridge.json");
export const inputStatePath = (dir: string, stage: string): string => statusPath(dir, stage).replace(/\.status\.json$/, ".input-state.json");
export function nativeDeliveryWarning(dir: string, stage: string, session: string, seq: number): string | undefined {
  const input = readJson<BridgeInput>(inputStatePath(dir, stage));
  return Array.isArray(input?.dispatches) ? input.dispatches.find((item) => item.sessionId === session && item.seq === seq)?.warning : undefined;
}
const HERE = dirname(fileURLToPath(import.meta.url));
const nativeBindingPath = (bridge: Bridge): string | undefined => bridge.socket ? join(dirname(bridge.socket), "session-binding.json") : undefined;
function nativeBinding(bridge: Bridge): ClaudeInbox | undefined {
  const path = nativeBindingPath(bridge), binding = path ? readJson<NativeBinding>(path) : undefined;
  return binding?.token === bridge.token && binding.sessionId === bridge.sessionId && binding.childPid === bridge.childPid
    && binding.childStarted === bridge.childStarted && binding.channel.socket === bridge.socket ? binding.channel : undefined;
}
/** 只净化显示控制字节；返修走原生消息而非键盘，日志仍保留原文。 */
export const repairText = (message: string): string => message.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");

/** 会话收件令牌只在本机私有记录中保存，临时文件与最终文件从创建起均为 0600。 */
function writePrivate(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  try { renameSync(temp, path); } finally { rmSync(temp, { force: true }); }
}

/** 随机派发凭据与原宿主、会话、进程绑定；包装/带前缀的程序消息仍不能更改用户权限。 */
export function bridgeRepairSequence(dir: string, stage: string, identity: BridgeIdentity, prompt: string): number | undefined {
  if (!identity.inputBridge) return undefined;
  const bridge = readJson<Bridge>(inputBridgePath(dir, stage)), input = readJson<BridgeInput>(inputStatePath(dir, stage));
  if (!bridge || bridge.token !== identity.inputBridge || bridge.host !== identity.host || bridge.sessionId !== identity.sessionId
    || bridge.pid !== identity.pid || bridge.started !== identity.processStarted || input?.token !== identity.inputBridge || !Array.isArray(input.dispatches)) return undefined;
  return input.dispatches.find((dispatch) => dispatch.sessionId === identity.sessionId && Number.isInteger(dispatch.seq) && dispatch.seq > 0
    && typeof dispatch.signal === "string" && /^【合入队列返修】\[[0-9a-f-]{36}\]$/.test(dispatch.signal) && prompt.includes(dispatch.signal))?.seq;
}

/** Hook 绑定实际会话；只接收本次启动指定的 Claude socket，绝不沿用外层会话凭据。 */
export function bindHookInputBridge(dir: string, stage: string, status: Omit<StageStatus, "stage" | "seq" | "updatedAt">,
  native?: { socket?: string; token?: string; mode?: string }): void {
  const path = inputBridgePath(dir, stage), bridge = readJson<Bridge>(path);
  if (bridge && bridge.token === status.inputBridge && bridge.pid === status.pid && bridge.started === status.processStarted && bridge.host === status.host) {
    if (status.host === "claude" && bridge.socket && native?.socket === bridge.socket && native.token && localInboxSocket(bridge.socket)) {
      // 令牌不进入流水线目录（该目录可由项目自定义）；仅存本次启动的私有系统临时目录。
      writePrivate(nativeBindingPath(bridge)!, { token: bridge.token, sessionId: status.sessionId, childPid: bridge.childPid, childStarted: bridge.childStarted,
        channel: { socket: bridge.socket, token: native.token, ...(native.mode ? { fromMode: native.mode === "bypassPermissions" ? "bypass" : "prompting" } : {}) } } satisfies NativeBinding);
    }
    writePrivate(path, { ...bridge, sessionId: status.sessionId });
  }
}
export function hookInputBridgeAvailable(dir: string, stage: string, status: StageStatus): boolean {
  const bridge = readJson<Bridge>(inputBridgePath(dir, stage));
  return Boolean(bridge && status.inputBridge && bridge.token === status.inputBridge && bridge.host === status.host && bridge.sessionId === status.sessionId
    && bridge.pid === status.pid && bridge.started === status.processStarted && bridge.started && processStartTime(bridge.pid) === bridge.started
    && bridge.childStarted && processStartTime(bridge.childPid) === bridge.childStarted
    && (status.host === "codex" || (nativeBinding(bridge) && bridge.socket && localInboxSocket(bridge.socket))));
}

/** 复用已安装 node-pty；macOS helper 缺执行位时仅修复本次私有副本。 */
function terminalModule(dir: string, token: string, env: NodeJS.ProcessEnv): { module: PtyModule; cleanup: () => void } {
  const source = env.AUTOREVIEW_NODE_PTY || "/Users/Admin/.pi/agent/npm/node_modules/node-pty";
  const platform = `${process.platform}-${process.arch}`, helper = join(source, "prebuilds", platform, "spawn-helper");
  let runtime: string | undefined, created = false;
  const cleanup = () => { if (created && runtime && existsSync(runtime) && !lstatSync(runtime).isSymbolicLink()) rmSync(runtime, { recursive: true }); };
  try {
    if (process.platform === "darwin" && existsSync(helper)) {
      let executable = true;
      try { accessSync(helper, constants.X_OK); } catch { executable = false; }
      if (!executable) {
        runtime = join(dir, `host-pty-${token}`);
        mkdirSync(runtime, { mode: 0o700 }); created = true;
        cpSync(join(source, "lib"), join(runtime, "lib"), { recursive: true });
        cpSync(join(source, "prebuilds", platform), join(runtime, "prebuilds", platform), { recursive: true });
        cpSync(join(source, "package.json"), join(runtime, "package.json"));
        cpSync(join(source, "LICENSE"), join(runtime, "LICENSE"));
        chmodSync(join(runtime, "prebuilds", platform, "spawn-helper"), 0o700);
      }
    }
    const module = createRequire(import.meta.url)(runtime ?? source) as PtyModule;
    if (typeof module.spawn !== "function") throw new Error("node-pty 没有 spawn 接口");
    return { module, cleanup };
  } catch (error) {
    cleanup();
    throw new Error(`无法启动原会话通道：${String(error)}；用 AUTOREVIEW_NODE_PTY 指向可用的已安装 node-pty（不自动安装或修改全局包）`);
  }
}

export interface HookHostOptions {
  command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; dir: string; stage: string; host: string; token: string;
  isIdle: (status: StageStatus) => boolean;
  onExit: (code: number | null, signal: NodeJS.Signals | null) => void;
}

/** 返修开始前由共享 Hook 引擎固定基线。重试保留同一个派发 ID，不重复重置基线/计数。 */
function dispatcher(options: HookHostOptions, env: NodeJS.ProcessEnv): { stop: () => Promise<void> } {
  const bridgePath = inputBridgePath(options.dir, options.stage), statePath = inputStatePath(options.dir, options.stage);
  const controller = new AbortController();
  let closed = false, running: Promise<void> | undefined, lastError = "";
  const run = async () => {
    const bridge = readJson<Bridge>(bridgePath), input = readJson<BridgeInput>(statePath);
    const status = readJson<StageStatus>(statusPath(options.dir, options.stage)), inbox = readJson<InboxMessage>(inboxPath(options.dir, options.stage));
    if (!bridge || bridge.token !== options.token || input?.token !== options.token || !status || !inbox || !inbox.message.startsWith("【合入队列返修】")) return;
    if (!hookInputBridgeAvailable(options.dir, options.stage, status)) return;
    let delivery = input.dispatches.find((item) => item.seq === inbox.seq && item.sessionId === status.sessionId);
    if (delivery?.sent) {
      const warning = status.inbox < inbox.seq && Date.now() - (delivery.sentAt ?? Date.now()) >= 5000
        ? "原生接口已提交，但开发会话尚未确认收件；请检查该宿主的原生收件策略或运行状态，返修保留且不会改动草稿" : undefined;
      if (warning !== delivery.warning) {
        delivery.warning = warning; writePrivate(statePath, input);
        if (warning) process.stderr.write(`[Loop] ${warning}\n`);
      }
      return;
    }
    if (!delivery && (status.inbox >= inbox.seq || status.event !== "done" || !options.isIdle(status))) return;
    if (delivery?.prepared && status.inbox >= inbox.seq) { delivery.sent = true; writePrivate(statePath, input); return; }
    if (!delivery) {
      const id = randomUUID(); delivery = { seq: inbox.seq, sessionId: status.sessionId, id, signal: `【合入队列返修】[${id}]` };
      input.dispatches.push(delivery); writePrivate(statePath, input);
    }
    const assertOwner = () => {
      controller.signal.throwIfAborted();
      if (readJson<Bridge>(bridgePath)?.token !== options.token || readJson<BridgeInput>(statePath)?.token !== options.token) throw new Error("原会话通道已更换，本次派发停止");
    };
    assertOwner();
    if (!delivery.prepared) {
      const response = await nativeCommand(process.execPath, [join(HERE, "hook.ts")], options.cwd, { ...env, AUTOREVIEW_HOST: options.host }, controller.signal,
        JSON.stringify({ hook_event_name: "LoopQueueRepair", cwd: options.cwd, session_id: status.sessionId, prompt: delivery.signal }));
      assertOwner();
      let prepared: { ok?: boolean; seq?: number } | undefined;
      try { prepared = response.trim() ? JSON.parse(response) : undefined; }
      catch { throw new Error("原会话返修准备应答不可用，未发送消息"); }
      if (!prepared?.ok || prepared.seq !== inbox.seq) throw new Error("原会话尚不能接收返修，收件箱和派发凭据保留");
      delivery.prepared = true; writePrivate(statePath, input);
    }
    assertOwner();
    await sendNativeRepair({ command: options.command, host: options.host, cwd: options.cwd, env, sessionId: status.sessionId,
      message: `${delivery.signal}\n${repairText(inbox.message)}`, id: delivery.id!, claude: nativeBinding(bridge),
      childPid: bridge.childPid, childStarted: bridge.childStarted, signal: controller.signal });
    assertOwner(); delivery.sent = true; delivery.sentAt = Date.now(); input.error = undefined; writePrivate(statePath, input); lastError = "";
  };
  const timer = setInterval(() => {
    if (closed || running) return;
    running = run().catch((error) => {
      if (closed) return;
      const reason = String(error);
      if (reason !== lastError) process.stderr.write(`[Loop] 原生返修投递未确认，等待重试：${reason}\n`);
      lastError = reason;
    }).finally(() => { running = undefined; });
  }, pollMs(options.env));
  timer.unref();
  return { stop: async () => { closed = true; clearInterval(timer); controller.abort(); await running; } };
}

/** 终端只透传用户输入；正常交互、恢复会话、未发送草稿均不影响独立的原生收件通道。 */
export function launchHookHost(options: HookHostOptions): void {
  mkdirSync(options.dir, { recursive: true });
  const native = nativeLaunch(options.command, options.args, options.host, options.cwd, options.env);
  let runtime: ReturnType<typeof terminalModule>;
  try { runtime = terminalModule(options.dir, options.token, options.env); } catch (error) { native.cleanup(); throw error; }
  const path = inputBridgePath(options.dir, options.stage), inputPath = inputStatePath(options.dir, options.stage), started = processStartTime(process.pid);
  writePrivate(inputPath, { token: options.token, dispatches: [] } satisfies BridgeInput);
  let terminal: Pty;
  try {
    terminal = runtime.module.spawn(options.command, native.args, { cwd: options.cwd, env: { ...native.env, AUTOREVIEW_DEV_INPUT_BRIDGE: options.token },
      name: process.env.TERM || "xterm-256color", cols: process.stdout.columns || 80, rows: process.stdout.rows || 24 });
  } catch (error) { rmSync(inputPath, { force: true }); runtime.cleanup(); native.cleanup(); throw error; }
  let closed = false, relay: ReturnType<typeof dispatcher> | undefined;
  const wasRaw = process.stdin.isRaw, signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
  const forwardSignal = (signal: NodeJS.Signals) => { if (!closed) terminal.kill(signal); };
  const forwardInput = (data: Buffer) => terminal.write(data);
  const resize = () => { if (!closed) terminal.resize(process.stdout.columns || 80, process.stdout.rows || 24); };
  const cleanup = () => {
    process.stdin.off("data", forwardInput); process.stdin.pause();
    if (process.stdin.isTTY) process.stdin.setRawMode?.(Boolean(wasRaw));
    process.stdout.off("resize", resize); for (const signal of signals) process.off(signal, forwardSignal);
    if (readJson<Bridge>(path)?.token === options.token) rmSync(path, { force: true });
    if (readJson<BridgeInput>(inputPath)?.token === options.token) rmSync(inputPath, { force: true });
    runtime.cleanup(); native.cleanup();
  };
  terminal.onData((data) => process.stdout.write(data));
  terminal.onExit(({ exitCode, signal }) => {
    closed = true;
    void (relay?.stop() ?? Promise.resolve()).finally(() => { cleanup(); options.onExit(signal ? null : exitCode, signal === 2 ? "SIGINT" : signal ? "SIGTERM" : null); });
  });
  try {
    const childStarted = processStartTime(terminal.pid);
    if (!started || !childStarted) throw new Error("无法核对宿主及原会话进程身份");
    writePrivate(path, { token: options.token, host: options.host, pid: process.pid, started, childPid: terminal.pid, childStarted, socket: native.socket } satisfies Bridge);
    if (process.stdin.isTTY) process.stdin.setRawMode?.(true);
    process.stdin.on("data", forwardInput); process.stdin.resume(); process.stdout.on("resize", resize);
    for (const signal of signals) process.on(signal, forwardSignal);
    relay = dispatcher(options, { ...native.env, AUTOREVIEW_DEV_INPUT_BRIDGE: options.token });
  } catch (error) { terminal.kill(); closed = true; cleanup(); throw error; }
}
