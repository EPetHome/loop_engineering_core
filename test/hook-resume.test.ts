/** hook-resume：独立进程隔离环境，保持全部场景与断言。 */
import "./test-env.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { CONVENTION } from "../core.ts";
import { readReviewSnapshot } from "../snapshots.ts";
import { fixture, assertPauseOutput } from "./helpers/hook-fixture.ts";

test("Hook计数／完成后再次交付重置返修计数", () => {
  const h = fixture({ marker: JSON.stringify({ maxRepairs: 1 }) });
  const env = { FAKE_FIX_COUNTS: "1,3" };
  try {
    h.run(h.event("SessionStart"));
    h.write("file.txt", "base\nA\n");
    const first = h.run(h.delivered(), { env });
    assert.equal(JSON.parse(first.stdout).decision, "block");
    h.write("file.txt", "base\nA\nB\n");
    const second = h.run(h.delivered({ stop_hook_active: true }), { env });
    assert.equal(second.stdout, "");
    assert.equal(h.readState().phase, "done");
    assert.equal(h.readState().repairs, 1);
    h.write("file.txt", "base\nA\nB\nC\n");
    const third = h.run(h.delivered(), { env });
    assert.equal(JSON.parse(third.stdout).decision, "block", "新一轮应重新获得返修机会");
    const state = h.readState();
    assert.equal(state.phase, "idle");
    assert.equal(state.repairs, 1, "新一轮返修计数从 1 开始");
    assert.equal(state.rounds.length, 3);
  } finally { h.close(); }
});

test("H9 暂停或评审中断后再提交消息：恢复自动评审，返修计数重新算", async (t) => {
  const lockOf = (h: ReturnType<typeof fixture>) => h.statePath().replace(/\.state\.json$/, ".lock");
  await t.test("【需要你决定】暂停后再提交 → 下次 Stop 自动评审", () => {
    const h = fixture();
    try {
      h.run(h.event("SessionStart"));
      h.run(h.event("UserPromptSubmit", { prompt: "需求 ORIGINAL" }));
      h.run(h.event("Stop", { last_assistant_message: "卡住了\n【需要你决定】" }));
      assert.equal(h.readState().phase, "paused");
      const prompt = h.run(h.event("UserPromptSubmit", { prompt: "用方案 A" }));
      assert.equal(JSON.parse(prompt.stdout).hookSpecificOutput.additionalContext, CONVENTION);
      const resumed = h.readState();
      assert.equal(resumed.phase, "idle");
      assert.equal(resumed.pauseReason, undefined);
      assert.equal(resumed.requirement, "需求 ORIGINAL");
      h.write("file.txt", "base\nDECIDED\n");
      const res = h.run(h.event("Stop", { last_assistant_message: "按方案 A 做完了" }));
      assert.equal(res.stdout, "");
      assert.equal(h.readState().phase, "done");
      assert.ok(existsSync(join(h.root, "fake", "calls.log")), "应调用评审");
    } finally { h.close(); }
  });
  await t.test("评审被宿主杀掉（死锁 + reviewing）后再提交 → 清残留，下次 Stop 照常评审", () => {
    const h = fixture();
    try {
      h.run(h.event("SessionStart"));
      h.run(h.event("UserPromptSubmit", { prompt: "需求" }));
      h.write("file.txt", "base\nA\n");
      // 模拟 Stop Hook 评审到一半被杀：状态停在 reviewing，锁属于已死进程。
      writeFileSync(h.statePath(), JSON.stringify({ ...h.readState(), phase: "reviewing" }));
      writeFileSync(lockOf(h), JSON.stringify({ pid: 999999, startedAt: "2026-01-01T00:00:00Z" }));
      h.run(h.event("UserPromptSubmit", { prompt: "继续" }));
      assert.equal(h.readState().phase, "idle");
      assert.ok(!existsSync(lockOf(h)), "死锁已清理");
      const res = h.run(h.event("Stop", { last_assistant_message: "做完了" }));
      assert.equal(res.stdout, "");
      assert.equal(h.readState().phase, "done");
      assert.ok(!h.notifications().includes("评审被中断"));
    } finally { h.close(); }
  });
  await t.test("达到返修上限暂停后再提交 → 返修计数重新算，必修照常打回", () => {
    const h = fixture({ marker: JSON.stringify({ maxRepairs: 1 }) });
    try {
      h.run(h.event("SessionStart"));
      h.write("file.txt", "base\nA\n");
      h.run(h.delivered(), { mode: "always-fix" });
      h.write("file.txt", "base\nA\nB\n");
      h.run(h.delivered(), { mode: "always-fix" });
      assert.equal(h.readState().pauseReason, "达到返修上限");
      h.run(h.event("UserPromptSubmit", { prompt: "剩下的你接着修" }));
      assert.equal(h.readState().repairs, 0);
      h.write("file.txt", "base\nA\nB\nC\n");
      const res = h.run(h.delivered(), { mode: "always-fix" });
      assert.equal(JSON.parse(res.stdout).decision, "block");
      assert.equal(h.readState().repairs, 1);
    } finally { h.close(); }
  });
  await t.test("没暂停时提交不清返修计数；活进程持锁评审中时提交不动状态和锁", () => {
    const h = fixture();
    try {
      h.run(h.event("SessionStart"));
      h.write("file.txt", "base\nA\n");
      assert.equal(JSON.parse(h.run(h.delivered(), { mode: "always-fix" }).stdout).decision, "block");
      h.run(h.event("UserPromptSubmit", { prompt: "插话" }));
      assert.equal(h.readState().phase, "idle");
      assert.equal(h.readState().repairs, 1);
      writeFileSync(h.statePath(), JSON.stringify({ ...h.readState(), phase: "reviewing" }));
      writeFileSync(lockOf(h), JSON.stringify({ pid: process.pid, startedAt: "2026-01-01T00:00:00Z" }));
      h.run(h.event("UserPromptSubmit", { prompt: "再插话" }));
      assert.equal(h.readState().phase, "reviewing");
      assert.equal(h.readState().repairs, 1);
      assert.ok(existsSync(lockOf(h)), "活锁不能被清掉");
    } finally { h.close(); }
  });
});
