/** 验收方专用的轻量观测扩展：记录即时工具生命周期，不等待整批 toolResult 消息落盘。 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

interface ToolActivityEvent {
  type: "tool_execution_start" | "tool_execution_end";
  toolCallId: string;
  toolName: string;
}

export const toolEventsPath = (runDir: string, call: string): string => join(runDir, "tool-events", `${call}.jsonl`);

export function recordToolActivity(runDir: string, call: string, event: ToolActivityEvent): void {
  if (!/^[0-9a-f-]{36}$/.test(call) || readFileSync(join(runDir, "call-id"), "utf8").trim() !== call) return;
  const path = toolEventsPath(runDir, call);
  mkdirSync(dirname(path), { recursive: true });
  // 不记录命令、结果或凭据；只保存调用身份与起止关系。start 还可能处在准备/排队阶段，不能据此计算执行超时。
  appendFileSync(path, JSON.stringify({ call, type: event.type, toolCallId: event.toolCallId, toolName: event.toolName }) + "\n");
}

export default function acceptanceEvents(pi: ExtensionAPI): void {
  const call = process.env.AUTOREVIEW_ACCEPTANCE_CALL;
  if (!call) return;
  pi.on("tool_execution_start", (event, ctx) => recordToolActivity(ctx.cwd, call, event));
  pi.on("tool_execution_end", (event, ctx) => recordToolActivity(ctx.cwd, call, event));
}
