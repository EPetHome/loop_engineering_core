/** 原生会话收件通道；不操作终端输入，不新建开发会话，不改变宿主权限。 */
import { execFile, spawnSync } from "node:child_process";
import { lstatSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { worktrees } from "../workspace.ts";
import { processStartTime } from "../procs.ts";

export interface ClaudeInbox { socket: string; token: string; fromMode?: "prompting" | "bypass" }
export interface NativeLaunch { args: string[]; env: NodeJS.ProcessEnv; socket?: string; cleanup: () => void }

export function nativeLaunch(command: string, args: string[], host: string, cwd: string, env: NodeJS.ProcessEnv): NativeLaunch {
  const childEnv = { ...env };
  // 不能沿用外层 Claude 的收件地址或子进程令牌；新宿主须发布自己的通道。
  delete childEnv.CLAUDE_CODE_MESSAGING_SOCKET; delete childEnv.CLAUDE_CODE_MESSAGING_TOKEN;
  if (host === "codex") {
    const probe = spawnSync(command, ["queue", "--help"], { cwd, env: childEnv, encoding: "utf8", timeout: 10_000 });
    if (probe.status !== 0 || !probe.stdout.includes("--thread") || !probe.stdout.includes("--message")) throw new Error("已登记队列的 Codex 需要支持 queue --thread --message 的本地宿主");
    return { args, env: childEnv, cleanup: () => {} };
  }
  if (host !== "claude") throw new Error(`未知原生宿主：${host}`);
  if (args.some((arg) => arg === "--messaging-socket-path" || arg.startsWith("--messaging-socket-path="))) throw new Error("队列会话的 messaging-socket-path 由 Loop 按本次启动身份分配，不能覆盖");
  // Darwin Unix socket 地址上限约 104 字节；长 TMPDIR 只回退到系统的 /tmp，不碰用户目录。
  const base = Buffer.byteLength(join(tmpdir(), "loop-inbox-XXXXXX", "in.sock")) < 100 ? tmpdir() : "/tmp";
  const dir = realpathSync(mkdtempSync(join(base, "loop-inbox-"))), identity = lstatSync(dir), socket = join(dir, "in.sock");
  const cleanup = () => {
    const current = lstatSync(dir, { throwIfNoEntry: false });
    if (current && !current.isSymbolicLink() && current.dev === identity.dev && current.ino === identity.ino) rmSync(dir, { recursive: true });
  };
  try {
    for (const tree of worktrees(cwd)) {
      const path = relative(realpathSync(tree.path), dir);
      if (!isAbsolute(path) && path !== ".." && !path.startsWith("../")) throw new Error("原生收件临时目录不能位于运行版或开发 worktree 内");
    }
    const probe = spawnSync(command, ["--messaging-socket-path", socket, "--help"], { cwd, env: childEnv, encoding: "utf8", timeout: 10_000 });
    if (probe.status !== 0) throw new Error("已登记队列的 Claude 需要支持本地 messaging-socket-path 的宿主");
    return { args: ["--messaging-socket-path", socket, ...args], env: childEnv, socket, cleanup };
  } catch (error) { cleanup(); throw error; }
}

export function localInboxSocket(socket: string): boolean {
  try {
    const parent = lstatSync(dirname(socket)), leaf = lstatSync(socket), uid = process.getuid?.();
    return parent.isDirectory() && !parent.isSymbolicLink() && (parent.mode & 0o077) === 0 && leaf.isSocket()
      && (uid === undefined || (parent.uid === uid && leaf.uid === uid));
  } catch { return false; }
}

export function nativeCommand(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, signal: AbortSignal, input?: string): Promise<string> {
  return new Promise((accept, reject) => {
    const child = execFile(command, args, { cwd, env, signal, timeout: 30_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`原会话通道调用失败：${(stderr || error.code || "未知错误").toString().slice(-600)}`));
      else accept(stdout);
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
  });
}

export async function sendNativeRepair(options: { command: string; host: string; cwd: string; env: NodeJS.ProcessEnv; sessionId: string; message: string;
  id: string; claude?: ClaudeInbox; childPid: number; childStarted: string; signal: AbortSignal }): Promise<void> {
  const { signal } = options;
  signal.throwIfAborted();
  if (processStartTime(options.childPid) !== options.childStarted) throw new Error("原宿主进程身份已变化，未发送到其他会话");
  if (options.host === "codex") {
    await nativeCommand(options.command, ["queue", "--thread", options.sessionId, "--message", options.message, "--cd", options.cwd], options.cwd, options.env, signal);
    return;
  }
  const channel = options.claude;
  if (!channel || !localInboxSocket(channel.socket)) throw new Error("Claude 尚未发布可核对的本地原生收件通道");
  await new Promise<void>((accept, reject) => {
    const socket = createConnection(channel.socket);
    const fail = (error: Error) => { socket.destroy(); reject(error); };
    const cancel = () => fail(new Error("原会话投递已取消"));
    signal.addEventListener("abort", cancel, { once: true });
    socket.setTimeout(5000, () => fail(new Error("原生收件通道超时")));
    socket.on("error", () => fail(new Error("原生收件通道连接失败")));
    socket.on("connect", () => {
      if (signal.aborted || processStartTime(options.childPid) !== options.childStarted) { cancel(); return; }
      socket.end(`${JSON.stringify({ type: "auth", token: channel.token })}\n${JSON.stringify({ type: "user", session_id: options.sessionId,
        uuid: options.id, msg_id: options.id, from: "loop-merge-queue", ...(channel.fromMode ? { from_mode: channel.fromMode } : {}),
        message: { role: "user", content: options.message } })}\n`);
    });
    socket.on("end", accept);
    socket.on("close", (hadError) => { signal.removeEventListener("abort", cancel); if (!hadError) accept(); });
  });
}
