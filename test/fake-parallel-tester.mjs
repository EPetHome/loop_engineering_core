#!/usr/bin/env node
/** 模拟 Pi 的并行批次：各工具结束即发事件，全部 Promise.all 完成后才写 toolResult。 */
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { recordToolActivity } from "../acceptance-events.ts";

const [round, input, sessionId, runDir] = process.argv.slice(2);
mkdirSync(process.env.FAKE_STATE_DIR, { recursive: true });
appendFileSync(join(process.env.FAKE_STATE_DIR, "acc-calls.log"), `${round}\t${input}\t${sessionId}\t${runDir}\n`);
const call = process.env.AUTOREVIEW_ACCEPTANCE_CALL;
const session = join(runDir, "tester-sessions", "tester", "parallel.jsonl");
const tools = [
  { id: "A1", timeout: 5, delay: 0 },
  { id: "A2", timeout: 30, delay: 20_000 },
];
writeFileSync(session, JSON.stringify({ type: "message", timestamp: new Date().toISOString(), message: { role: "assistant", content:
  tools.map(({ id, timeout }) => ({ type: "toolCall", id, name: "bash", arguments: { command: `./ev ${id}`, timeout } })),
} }) + "\n");
const outcomes = await Promise.all(tools.map(({ id, timeout, delay }) => new Promise((resolve, reject) => {
  recordToolActivity(runDir, call, { type: "tool_execution_start", toolCallId: id, toolName: "bash" });
  const child = spawn(join(runDir, "ev"), [id, "--timeout", String(timeout), "--", process.execPath, "-e",
    `setTimeout(() => console.log(${JSON.stringify(`${id}_OK`)}), ${delay});`], { cwd: runDir, detached: true, stdio: "ignore" });
  child.once("error", reject);
  child.once("close", (code) => {
    recordToolActivity(runDir, call, { type: "tool_execution_end", toolCallId: id, toolName: "bash" });
    appendFileSync(join(runDir, "ends.log"), `${id}\t${Date.now()}\n`);
    resolve({ id, code });
  });
})));
// 和真实 Pi 一样：快工具的结果在慢工具结束前不会持久化为会话消息。
for (const { id, code } of outcomes) {
  appendFileSync(session, JSON.stringify({ type: "message", timestamp: new Date().toISOString(), message: { role: "toolResult", toolCallId: id, isError: code !== 0 } }) + "\n");
}
process.stdout.write("## 结论：通过\n## 逐条结果\n" + tools.map(({ id }) => `${id}：通过\n- 证据摘录：${id}_OK`).join("\n") + "\n");
