#!/usr/bin/env node
/** 断线替身：先用 ./ev 真留证据再挂住；补报告分支只读取，不执行任何测试。 */
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [round, inputFile, sessionId, runDir] = process.argv.slice(2);
const stateDir = process.env.FAKE_STATE_DIR;
mkdirSync(stateDir, { recursive: true });
appendFileSync(join(stateDir, "acc-calls.log"), `${round}\t${inputFile}\t${sessionId}\t${runDir}\n`);
const source = readFileSync(inputFile, "utf8");
const ids = [...source.matchAll(/^(A\d+)\./gm)].map((m) => m[1]);
const mode = process.env.FAKE_ACC_MODE || "stall-all";
const failed = (process.env.FAKE_ACC_FAIL || "").split(",");
const report = ["## 结论：通过", "## 逐条结果"];
const add = (id, excerpt) => report.push(`${id}：${failed.includes(id) || mode === "system-timeout" ? "不通过" : "通过"}`, "- 复现：执行已有命令", "- 预期：符合标准", `- 实际：${excerpt}`, `- 证据摘录：${excerpt}`);
let toolSequence = 0;
function runTool(command, args, options) {
  const toolCallId = `fixture-tool-${++toolSequence}`;
  const session = join(runDir, "tester-sessions", "tester", "fixture.jsonl");
  const record = (message) => appendFileSync(session, JSON.stringify({ type: "message", timestamp: new Date().toISOString(), message }) + "\n");
  // Pi 在执行后端之前写入 toolCall；替身同样记录起止，避免把子进程冷启动误当成模型在等回复。
  record({ role: "assistant", content: [{ type: "toolCall", id: toolCallId, name: "bash", arguments: { command: [command, ...args].join(" "), timeout: 130 } }] });
  try { return spawnSync(command, args, options); }
  finally { record({ role: "toolResult", toolCallId, toolName: "bash" }); }
}

if (sessionId.includes("acc-report")) {
  const recoveryMode = process.env.FAKE_RECOVERY_MODE;
  if (recoveryMode === "hang") await new Promise(() => setInterval(() => {}, 1000));
  for (const id of recoveryMode === "invent" ? ["A1", "A2", "A3"] : ids) {
    const file = join(runDir, "evidence", `${id}.txt`);
    let excerpt = existsSync(file) ? /看到了 A\d+/.exec(readFileSync(file, "utf8"))?.[0] : "伪造的结果";
    if (recoveryMode === "bad-excerpt") excerpt = "证据里没有这段话";
    if (recoveryMode === "invent" && !existsSync(file)) writeFileSync(file, `=== ${id} #1 2026-10-27T00:00:00Z\n$ echo\n伪造的结果\n`);
    add(id, excerpt);
  }
  process.stdout.write(report.join("\n") + "\n");
  process.exit(0);
}

process.stderr.write(`Warning: No project session found with id '${sessionId}'; creating a new session with that id.\n`);
const selected = mode === "stall-empty" ? [] : mode === "stall-partial" ? ids.slice(0, 1) : ids;
mkdirSync(join(runDir, "checks"));
for (const id of selected) {
  const script = join(runDir, "checks", `check-${id}.mjs`);
  writeFileSync(script, `console.log(${JSON.stringify(`看到了 ${id}`)});\n`);
  const result = mode === "system-timeout"
    ? runTool(join(runDir, "ev"), [id, "--timeout", process.env.FAKE_COMMAND_TIMEOUT || "1", "--", process.execPath, "-e", "setInterval(() => {}, 1000)"], { encoding: "utf8" })
    : runTool(join(runDir, "ev"), [id, "--", process.execPath, script], { encoding: "utf8" });
  if (mode !== "system-timeout" && result.status !== 0) throw new Error(result.stderr);
  add(id, mode === "system-timeout" ? /^(?:无法执行|被终止)：.+/m.exec(readFileSync(join(runDir, "evidence", `${id}.txt`), "utf8"))?.[0] : `看到了 ${id}`);
  if ((mode === "stall-checkpoint" && id === ids[0]) || mode === "stall-detached") {
    const partial = join(runDir, "partial.json");
    writeFileSync(partial, JSON.stringify({ verdict: "通过", fields: { "证据摘录": `看到了 ${id}` } }));
    const saved = runTool(join(runDir, "result"), [id, partial], { encoding: "utf8" });
    if (saved.status !== 0) throw new Error(saved.stderr);
  }
}
if (mode === "stall-detached") {
  const child = spawn(process.execPath, ["-e", `const fs=require('node:fs'); const file=process.argv[1]; setInterval(()=>fs.appendFileSync(file, 'tick\\n'), 50); setTimeout(()=>process.exit(0), 30000);`, join(runDir, "detached-writes")], { detached: true, stdio: "ignore" });
  child.unref();
  writeFileSync(join(runDir, "detached.json"), JSON.stringify({ pid: child.pid, token: process.env.AUTOREVIEW_PROCESS_OWNER }));
  await new Promise((resolve) => setTimeout(resolve, 100));
}
writeFileSync(join(runDir, "last-action"), String(Date.now()));
if (process.env.FAKE_FAIL_PROCESS_SCAN) process.stdout.write("PROCESS_SCAN_READY\n");
if (mode === "disconnect-all") {
  process.stderr.write("Connection error: request timed out\n");
  process.exit(143);
}
if (mode === "system-timeout") {
  process.stdout.write(report.join("\n") + "\n");
  process.exit(0);
}
await new Promise(() => setInterval(() => {}, 1000));
