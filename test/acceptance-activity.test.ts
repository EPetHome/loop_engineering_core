/** Pi 并行批次：工具结束事件早于整批 toolResult 落盘，不能据消息时间制造工具超时。 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createActionObserver } from "../acceptance-activity.ts";
import acceptanceEvents, { recordToolActivity } from "../acceptance-events.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "autoreview-parallel-activity-"));
  const sessions = join(root, "sessions"), call = "11111111-1111-4111-8111-111111111111";
  mkdirSync(sessions);
  mkdirSync(join(root, "tool-events"));
  const at = Date.parse("2026-10-27T00:00:00Z");
  writeFileSync(join(root, "call-id"), call);
  writeFileSync(join(sessions, "session.jsonl"), JSON.stringify({ type: "message", timestamp: new Date(at).toISOString(), message: {
    role: "assistant", content: [
      { type: "toolCall", id: "fast", name: "bash", arguments: { command: "quick check", timeout: 5 } },
      { type: "toolCall", id: "slow", name: "bash", arguments: { command: "slow check", timeout: 30 } },
    ],
  } }) + "\n");
  const event = (type: "tool_execution_start" | "tool_execution_end", toolCallId: string) => {
    recordToolActivity(root, call, { type, toolCallId, toolName: "bash" });
  };
  return { root, call, at, event, observe: createActionObserver(root, sessions, call, at), close: () => rmSync(root, { recursive: true, force: true }) };
}

test("并行批次：5秒上限的快工具已结束，不能在第7秒截断仍在30秒上限内执行的20秒慢工具", (t) => {
  const f = fixture();
  let now = f.at;
  t.mock.method(Date, "now", () => now);
  try {
    f.event("tool_execution_start", "fast"); f.event("tool_execution_start", "slow");
    now += 1000; f.event("tool_execution_end", "fast");
    assert.equal(f.observe(), "running");
    now = f.at + 8000;
    assert.equal(f.observe(), "running", "快工具没有持久化 toolResult 不等于它仍在执行，更不代表它已超时");
    now = f.at + 20_000; f.event("tool_execution_end", "slow");
    assert.equal(f.observe(), undefined, "整批工具已结束，即使 toolResult 尚未落盘，也必须恢复模型空闲检测");
  } finally { f.close(); }
});

test("排队与准备不计入工具执行超时；超时由工具后端控制，整轮预算仍由执行器限制", (t) => {
  const f = fixture();
  let now = f.at;
  t.mock.method(Date, "now", () => now);
  try {
    now += 10_000;
    assert.equal(f.observe(), "running", "不能以 assistant 消息时间给尚未启动的工具计时");
    f.event("tool_execution_start", "fast"); f.event("tool_execution_start", "slow");
    now += 2000; f.event("tool_execution_end", "fast");
    now += 6000;
    assert.equal(f.observe(), "running");
    now += 20_000; f.event("tool_execution_end", "slow");
    assert.equal(f.observe(), undefined);
  } finally { f.close(); }
});

test("观测扩展订阅即时起止事件，完成事件能在 toolResult 落盘前释放活动状态", (t) => {
  const f = fixture(), oldCall = process.env.AUTOREVIEW_ACCEPTANCE_CALL;
  t.mock.method(Date, "now", () => f.at + 8000);
  try {
    process.env.AUTOREVIEW_ACCEPTANCE_CALL = f.call;
    const handlers = new Map<string, (event: unknown, ctx: { cwd: string }) => unknown>();
    acceptanceEvents({ on: (name: string, handler: (event: unknown, ctx: { cwd: string }) => unknown) => { handlers.set(name, handler); return () => handlers.delete(name); } } as unknown as ExtensionAPI);
    assert.deepEqual([...handlers.keys()], ["tool_execution_start", "tool_execution_end"]);
    for (const id of ["fast", "slow"]) handlers.get("tool_execution_start")!({ type: "tool_execution_start", toolCallId: id, toolName: "bash" }, { cwd: f.root });
    handlers.get("tool_execution_end")!({ type: "tool_execution_end", toolCallId: "fast", toolName: "bash" }, { cwd: f.root });
    assert.equal(f.observe(), "running");
    handlers.get("tool_execution_end")!({ type: "tool_execution_end", toolCallId: "slow", toolName: "bash" }, { cwd: f.root });
    assert.equal(f.observe(), undefined);
  } finally {
    if (oldCall === undefined) delete process.env.AUTOREVIEW_ACCEPTANCE_CALL; else process.env.AUTOREVIEW_ACCEPTANCE_CALL = oldCall;
    f.close();
  }
});
