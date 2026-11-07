#!/usr/bin/env node
/** 仅测试：模拟 Pi 生命周期/模型输出；加载本工作树的真实扩展和内核，不连接模型。 */
import { existsSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const root = process.env.LOOP_DIR;
const { default: extension } = await import(pathToFileURL(join(root, "autoreview.ts")));
const { readTaskRun } = await import(pathToFileURL(join(root, "node-ledger.ts")));
const path = process.env.AUTOREVIEW_KERNEL_LEDGER, run = readTaskRun(path, process.env.AUTOREVIEW_KERNEL_TASK);
const entries = [], events = new Map(), commands = new Map();
const log = join(run.dir, "fake-pi-session.jsonl"); writeFileSync(log, "模拟宿主，不是真实 Pi 会话\n");
writeFileSync(join(run.dir, "host-argv.json"), JSON.stringify(process.argv.slice(2)));
const ctx = { cwd: process.cwd(), isIdle: () => true, abort() {}, hasUI: false,
  sessionManager: { getEntries: () => entries, getSessionId: () => run.taskId ? `fake-${run.taskId}` : "fake-original-session", getSessionFile: () => log },
  ui: { notify() {}, setStatus() {} } };
extension({ on: (name, fn) => events.set(name, fn), registerCommand: (name, command) => commands.set(name, command),
  registerFlag() {}, getCommands: () => [{ name: "ponytail" }], getFlag: () => undefined });
if (process.env.KERNEL_FAKE_ACTION === "no-ack") { setInterval(() => {}, 1000); await new Promise(() => {}); }
await events.get("session_start")({}, ctx);
if (process.env.KERNEL_FAKE_ACTION === "idle") { setInterval(() => {}, 1000); }
else {
  await events.get("before_agent_start")({ systemPromptOptions: {}, messageType: "user", prompt: "fixture" }, ctx);
  if (process.env.KERNEL_FAKE_BARRIER && run.taskId) {
    const dir = process.env.KERNEL_FAKE_BARRIER, name = run.taskRecords.find((t) => t.id === run.taskId).name;
    writeFileSync(join(dir, `${name}.started`), JSON.stringify({ pid: process.pid, task: run.taskId, at: Date.now() }));
    const deadline = Date.now() + 20000;
    while (!existsSync(join(dir, `${name}.go`))) { if (Date.now() >= deadline) throw new Error("fixture barrier timeout"); await sleep(20); }
  }
  for (let i = 1; i <= 5; i++) {
    writeFileSync(join(process.cwd(), run.taskId ? `${run.card.tasks.find((t) => t.name === run.taskRecords.find((r) => r.id === run.taskId).name).name}.txt` : "file.txt"), `fake-model-round-${i}\n`);
    entries.push({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "小改动已交付\n【交付完成】" }] } });
    const result = await events.get("agent_before_settle")({ outcome: "completed", entries: [], continue: false }, ctx);
    if (!result?.continue) {
      if (process.env.KERNEL_FAKE_REPEAT_SETTLE) await events.get("agent_before_settle")({ outcome: "completed", entries: [], continue: false }, ctx);
      break;
    }
    writeFileSync(join(run.dir, `repair-${i}.json`), JSON.stringify(result));
  }
  await events.get("agent_settled")({ aborted: false }, ctx);
  await events.get("session_shutdown")({}, ctx);
}
