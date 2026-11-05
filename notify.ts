/** 唯一的桌面通知出口；界面提示、systemMessage 和终端启动不经过这里。 */
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { readPAConfig } from "./config.ts";
import type { Exec } from "./git.ts";

export function systemNotify(title: string, body: string, options: { exec?: Exec; timeoutMs?: number; signal?: AbortSignal } = {}): void | Promise<void> {
  process.stderr.write(`[${title}] ${body}\n`);
  try {
    if (!readPAConfig().localNotify) return;
    const script = `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`;
    if (options.exec) return options.exec("osascript", ["-e", script], { cwd: homedir(), timeout: options.timeoutMs ?? 15_000, signal: options.signal }).then(() => {}, () => {});
    if (process.platform === "darwin") spawnSync("osascript", ["-e", script], { timeout: options.timeoutMs ?? 15_000 });
  } catch (error) { process.stderr.write(`[${title}] 系统通知未发送：${String(error)}\n`); }
}
