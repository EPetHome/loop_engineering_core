/** 已登记原生收件通道的 PA 用户消息；旧队列轮询/自动返修派发已删除。 */
import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readJson, statusPath, type StageStatus } from "../pipeline-core.ts";
import { processStartTime } from "../procs.ts";
import { localInboxSocket, sendNativeRepair, type ClaudeInbox } from "./native-inbox.ts";
interface Bridge { token: string; host: string; sessionId?: string; pid: number; started: string; childPid: number; childStarted: string; socket?: string; command?: string }
interface NativeBinding { token: string; sessionId: string; childPid: number; childStarted: string; channel: ClaudeInbox }
export const inputBridgePath = (dir: string, stage: string): string => statusPath(dir, stage).replace(/\.status\.json$/, ".input-bridge.json");
const nativeBindingPath = (bridge: Bridge): string | undefined => bridge.socket ? join(dirname(bridge.socket), "session-binding.json") : undefined;
function nativeBinding(bridge: Bridge): ClaudeInbox | undefined {
  const path = nativeBindingPath(bridge), binding = path ? readJson<NativeBinding>(path) : undefined;
  return binding?.token === bridge.token && binding.sessionId === bridge.sessionId && binding.childPid === bridge.childPid && binding.childStarted === bridge.childStarted && binding.channel.socket === bridge.socket ? binding.channel : undefined;
}
function writePrivate(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  try { renameSync(temp, path); } finally { rmSync(temp, { force: true }); }
}
/** 只绑定仍匹配启动身份的原生会话，不创建新宿主或队列派发器。 */
export function bindHookInputBridge(dir: string, stage: string, status: Omit<StageStatus, "stage" | "seq" | "updatedAt">, native?: { socket?: string; token?: string; mode?: string }): void {
  const path = inputBridgePath(dir, stage), bridge = readJson<Bridge>(path);
  if (bridge && bridge.token === status.inputBridge && bridge.pid === status.pid && bridge.started === status.processStarted && bridge.host === status.host) {
    if (status.host === "claude" && bridge.socket && native?.socket === bridge.socket && native.token && localInboxSocket(bridge.socket)) writePrivate(nativeBindingPath(bridge)!, { token: bridge.token, sessionId: status.sessionId, childPid: bridge.childPid, childStarted: bridge.childStarted, channel: { socket: bridge.socket, token: native.token, ...(native.mode ? { fromMode: native.mode === "bypassPermissions" ? "bypass" : "prompting" } : {}) } } satisfies NativeBinding);
    writePrivate(path, { ...bridge, sessionId: status.sessionId });
  }
}
export function hookInputBridgeAvailable(dir: string, stage: string, status: StageStatus): boolean {
  const bridge = readJson<Bridge>(inputBridgePath(dir, stage));
  return Boolean(bridge && status.inputBridge && bridge.token === status.inputBridge && bridge.host === status.host && bridge.sessionId === status.sessionId && bridge.pid === status.pid && bridge.started === status.processStarted && bridge.started && processStartTime(bridge.pid) === bridge.started && bridge.childStarted && processStartTime(bridge.childPid) === bridge.childStarted && (status.host === "codex" || nativeBinding(bridge) && bridge.socket && localInboxSocket(bridge.socket)));
}
/** 只投递用户原话；不启动、不恢复会话，不用终端键盘或草稿。 */
export async function deliverHookWords(dir: string, stage: string, status: StageStatus, message: string, id: string, cwd = process.cwd()): Promise<void> {
  if (!hookInputBridgeAvailable(dir, stage, status)) throw new Error("原宿主收件通道或进程身份无法核对");
  const bridge = readJson<Bridge>(inputBridgePath(dir, stage))!;
  await sendNativeRepair({ command: bridge.command ?? (status.host === "codex" ? process.env.CODEX_BIN || "codex" : "claude"), host: status.host!, cwd, env: process.env, sessionId: status.sessionId, message, id, from: "loop-pa", claude: nativeBinding(bridge), childPid: bridge.childPid, childStarted: bridge.childStarted, signal: new AbortController().signal });
}
