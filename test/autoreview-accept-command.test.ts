import assert from "node:assert/strict";
import test from "node:test";
import { harness, result, PASS, FIX, until } from "./helpers/autoreview-fixture.ts";
import autoreview from "../autoreview.ts";
import { kernelFixture } from "./helpers/kernel-fixture.ts";
import { readRun } from "../node-ledger.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";
for (const mode of ["required", "advisory", "invalid"]) test(`旧 accept 参数 ${mode} 不再控制完成或返修；自动/手动路径均只诊断`, async () => {
  const h = harness({ flags: { "autoreview-accept-cmd": "sleep 999; touch never", "autoreview-accept-mode": mode, "autoreview-accept-timeout-min": "invalid" } });
  try { h.acceptor = () => assert.fail("不得执行旧命令"); await h.event("session_start"); await h.command("accept"); await h.begin(); h.write("file.txt", "candidate"); h.assistant(); await h.command(); await h.terminal(); assert.equal(h.state().phase, "done"); assert.equal(h.state().repairs, 0); assert.equal(h.accepts.length, 0); await h.command("accept"); assert.ok(h.notifications.some((n) => /已停用.*tasks\[\]\.test/.test(n))); assert.doesNotMatch(h.summary(), /验收命令用途|do-not-run|必需验收中/); } finally { await h.close(); }
});
test("旧 accepting/命令中断恢复只能迁移暂停，不能重启命令或沿用旧通过资格", async () => {
  const h = harness({ restored: { enabled: true, phase: "accepting", rounds: [], repairs: 3, acceptRun: { result: "进行中", command: "never" } } }); try { await h.event("session_start"); assert.equal(h.state().phase, "paused"); assert.equal(h.state().repairs, 3); assert.match(h.state().pauseReason!, /旧独立验收命令已停用/); await h.command("accept"); assert.equal(h.accepts.length, 0); } finally { await h.close(); }
});
test("直接加载受管 Pi 扩展时旧参数和 /accept 也只迁移，不借内核身份绕过", async () => {
  const f = kernelFixture(["开发评审"]), events = new Map<string, any>(), commands = new Map<string, any>(), notices: string[] = [];
  let ctx: any;
  try {
    const path = f.start(), run = readRun(path); Object.assign(process.env, { AUTOREVIEW_KERNEL_LEDGER: path, AUTOREVIEW_KERNEL_RUN: run.id });
    const api: any = { on: (name: string, fn: any) => events.set(name, fn), registerFlag() {}, registerCommand: (name: string, value: any) => commands.set(name, value), getFlag: (name: string) => name === "autoreview-accept-cmd" ? "never-run" : undefined, getCommands: () => [{ name: "ponytail" }] };
    ctx = { cwd: run.worktree, isIdle: () => true, abort() {}, sessionManager: { getSessionId: () => "original", getSessionFile: () => join(run.dir, "fixture-session.jsonl"), getEntries: () => [] }, ui: { notify: (s: string) => notices.push(s), setStatus() {}, setWidget() {} } };
    autoreview(api, async () => assert.fail("旧命令不得通过模型/宿主执行器"));
    await events.get("session_start")({}, ctx); assert.ok(notices.some((s) => /旧独立验收命令已停用.*tasks\[\]\.test/.test(s)));
    await commands.get("accept").handler("", ctx); assert.equal(readRun(path).results.length, 0); assert.equal(existsSync(join(f.root, "resources")), false);
  } finally { await events.get("session_shutdown")?.({}, ctx); f.cleanup(); }
});

test("静态返修交接等待本轮释放；开发方立即完成也不丢下一轮或重置机器返修次数", async () => {
  const h = harness(); try { await h.event("session_start"); await h.begin(); h.write("file.txt", "broken"); h.reviewer = () => result(FIX); h.assistant(); await h.command(); await until(() => h.messages.length === 1, "评审结束后返修"); assert.equal(h.state().repairs, 1); await h.begin(h.messages[0]); h.write("file.txt", "fixed"); h.reviewer = () => result(PASS); h.assistant(); await h.event("agent_settled"); await h.terminal(); assert.equal(h.state().phase, "done"); assert.equal(h.inputs.length, 2); assert.equal(h.state().repairs, 1); } finally { await h.close(); }
});
