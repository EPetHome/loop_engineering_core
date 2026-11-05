/** hook-trigger：独立进程隔离环境，保持全部场景与断言。 */
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

test("Hook触发／无标记按指纹决定评审/不动作/暂停", async (t) => {
  await t.test("无标记 + 有改动 → 自动评审", () => {
    const h = fixture();
    try {
      h.run(h.event("SessionStart"));
      h.run(h.event("UserPromptSubmit", { prompt: "需求" }));
      h.write("file.txt", "base\nAUTO_A\n");
      const res = h.run(h.event("Stop", { last_assistant_message: "普通回复，不写标记" }));
      assert.equal(res.code, 0);
      assert.equal(res.stdout, "");
      const state = h.readState();
      assert.equal(state.phase, "done");
      assert.equal(state.rounds.length, 1);
      assert.ok(existsSync(join(h.root, "fake", "calls.log")), "应调用评审");
    } finally { h.close(); }
  });
  await t.test("无标记 + 无改动 → 什么都不做", () => {
    const h = fixture();
    try {
      h.run(h.event("SessionStart"));
      h.run(h.event("UserPromptSubmit", { prompt: "需求" }));
      const res = h.run(h.event("Stop", { last_assistant_message: "普通回复" }));
      assert.equal(res.stdout, "");
      assert.equal(h.readState().phase, "idle");
      assert.ok(!existsSync(join(h.root, "fake", "calls.log")));
    } finally { h.close(); }
  });
  await t.test("返修后无标记且无改动 → 暂停「返修后没有任何改动」", () => {
    const h = fixture();
    try {
      h.run(h.event("SessionStart"));
      h.write("file.txt", "base\nA\n");
      h.run(h.delivered(), { mode: "always-fix" });
      assert.equal(h.readState().phase, "idle");
      const res = h.run(h.event("Stop", { last_assistant_message: "第 1 条：已修（没改文件）" }));
      assert.equal(res.stdout, "");
      const state = h.readState();
      assert.equal(state.phase, "paused");
      assert.equal(state.pauseReason, "返修后没有任何改动");
    } finally { h.close(); }
  });
  await t.test("返修后有改动但没标记 → 继续评审", () => {
    const h = fixture();
    try {
      h.run(h.event("SessionStart"));
      h.write("file.txt", "base\nA\n");
      h.run(h.delivered(), { mode: "always-fix" });
      h.write("file.txt", "base\nA\nFIXED\n");
      const res = h.run(h.event("Stop", { last_assistant_message: "第 1 条：已修" }), { mode: "pass-after-1" });
      assert.equal(res.stdout, "");
      assert.equal(h.readState().phase, "done");
      assert.equal(h.readState().rounds.length, 2);
    } finally { h.close(); }
  });
  await t.test("【需要你决定】→ 暂停", () => {
    const h = fixture();
    try {
      h.run(h.event("SessionStart"));
      const res = h.run(h.event("Stop", { last_assistant_message: "卡住了\n【需要你决定】" }));
      assertPauseOutput(res, /开发方的问题原文：[\s\S]*卡住了/);
      assert.equal(h.readState().pauseReason, "开发方需要你决定");
      assert.match(h.notifications(), /暂停（开发方需要你决定）/);
    } finally { h.close(); }
  });
});

test("Hook取证／完成总结与未交付提醒的 git 取证失败都改为暂停", async (t) => {
  await t.test("完成总结 git status 失败", () => {
    const h = fixture();
    try {
      h.run(h.event("SessionStart"));
      h.write("file.txt", "base\nA\n");
      const res = h.run(h.delivered(), { mode: "pass", env: { FAKE_GIT_FAIL: "status" } });
      assertPauseOutput(res, /自动评审内部错误/);
      const state = h.readState();
      assert.equal(state.phase, "paused");
      assert.equal(state.pauseReason, "自动评审内部错误");
      assert.match(h.notifications(), /暂停/);
    } finally { h.close(); }
  });
  await t.test("无标记有改动时指纹检查失败", () => {
    const h = fixture();
    try {
      h.run(h.event("SessionStart"));
      h.run(h.event("UserPromptSubmit", { prompt: "需求" }));
      h.write("file.txt", "base\nUNDELIVERED\n");
      const res = h.run(h.event("Stop", { last_assistant_message: "普通回复" }), { env: { FAKE_GIT_FAIL: "stash" } });
      assert.equal(res.code, 0);
      const state = h.readState();
      assert.equal(state.phase, "paused");
      assert.equal(state.pauseReason, "自动评审内部错误");
      assert.match(h.notifications(), /暂停/);
    } finally { h.close(); }
  });
});
