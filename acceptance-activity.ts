/** 识别验收方正在等待的实测动作；空闲时限只约束模型等待，不替代工具自身的超时。 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { processStartTime } from "./procs.ts";
import { toolEventsPath } from "./acceptance-events.ts";

/** 有执行中、准备中或待收尾的工具；不据消息时间制造工具超时，执行时限由实际后端负责。 */
export type ActionState = "running" | undefined;

export function createActionObserver(runDir: string, sessionDir: string, call: string, since: number): () => ActionState {
  let cached = "", pending = new Set<string>();
  return () => {
    let active = false;
    const dir = join(runDir, "active-actions", call);
    let actions: string[];
    try { actions = readdirSync(dir).filter((name) => name.endsWith(".json")); } catch { actions = []; }
    for (const name of actions) {
      try {
        const action = JSON.parse(readFileSync(join(dir, name), "utf8"));
        if (action.call !== call || !Number.isInteger(action.pid) || action.pid < 2 || !action.started
          || processStartTime(action.pid) !== action.started) continue;
        active = true;
      } catch { /* 原子替换或已经结束的动作，下次扫描再确认。 */ }
    }
    // Pi 的 bash 包括直接命令、脚本编写与 ./browser；用未配对的工具调用识别等待，不能把单纯会话静默算模型断线。
    let sessions: string[];
    try { sessions = readdirSync(sessionDir).filter((name) => name.endsWith(".jsonl")); } catch { sessions = []; }
    const text = sessions.map((name) => { try { return readFileSync(join(sessionDir, name), "utf8"); } catch { return ""; } }).join("\n");
    let events = "";
    try { events = readFileSync(toolEventsPath(runDir, call), "utf8"); } catch { /* 尚无工具执行事件。 */ }
    const version = JSON.stringify([text, events]);
    if (version !== cached) {
      cached = version;
      const calls = new Set<string>();
      for (const line of text.split("\n")) {
        try {
          const entry = JSON.parse(line), message = entry.type === "message" ? entry.message : undefined;
          const at = Date.parse(entry.timestamp);
          if (message?.role === "assistant" && Array.isArray(message.content) && (!Number.isFinite(at) || at >= since)) {
            for (const tool of message.content) {
              if (tool.type !== "toolCall" || tool.name !== "bash" || typeof tool.id !== "string") continue;
              calls.add(tool.id);
            }
          } else if (message?.role === "toolResult" && typeof message.toolCallId === "string") calls.delete(message.toolCallId);
        } catch { /* 未写完整的一行不作为活动证据。 */ }
      }
      // Pi 并行批次先独立发出 tool_execution_end，整批 Promise.all 后才持久化 toolResult。
      // 即时结束事件优先于会话中的未配对提示；start 仅表示在途，不用于计算排队/准备时间。
      for (const line of events.split("\n")) {
        try {
          const event = JSON.parse(line);
          if (event.call !== call || typeof event.toolCallId !== "string") continue;
          if (event.type === "tool_execution_start") calls.add(event.toolCallId);
          else if (event.type === "tool_execution_end") calls.delete(event.toolCallId);
        } catch { /* 尚未写完整的一行不改变工具状态。 */ }
      }
      pending = calls;
    }
    return active || pending.size ? "running" : undefined;
  };
}
