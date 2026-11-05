/** hook：独立进程隔离环境，保持全部场景与断言。 */
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

test("Claude/Codex 实际 Hook 入口保存完整快照，漏网 CLI 不改变原会话状态与总结", async (t) => {
  for (const host of ["claude", "codex"]) await t.test(host, () => {
    const h = fixture();
    try {
      const env = { AUTOREVIEW_HOST: host };
      h.run(h.event("UserPromptSubmit", { prompt: "# 快照" }), { env }); h.write("file.txt", "reviewed\n"); h.write("new.txt", "untracked\n");
      const completed = h.run(h.delivered(), { env }), state = h.readState(host);
      assert.equal(state.phase, "done", completed.stderr + h.summary(host));
      const snapshot = readReviewSnapshot(state.rounds[0].snapshot);
      assert.equal(snapshot.session, `${host}-s1`); assert.equal(snapshot.round, 1); assert.equal(snapshot.complete, true);
      assert.ok(snapshot.files.find((file) => file.path === "new.txt")?.content);
      const beforeState = readFileSync(h.statePath(host)), beforeSummary = h.summary(host);
      const registered = spawnSync(fileURLToPath(new URL("../bin/loop", import.meta.url)), ["漏网", h.repo, `${host}-s1`, "遗漏并发缺陷", "后续测试", "--json"],
        { cwd: h.root, env: { ...process.env, HOME: h.home }, encoding: "utf8" });
      assert.equal(registered.status, 0, registered.stderr + registered.stdout);
      assert.equal(JSON.parse(registered.stdout).draft.snapshot, state.rounds[0].snapshot);
      assert.deepEqual(readFileSync(h.statePath(host)), beforeState); assert.equal(h.summary(host), beforeSummary);
    } finally { h.close(); }
  });
});

test("Hook经验／完成后普通问答无改动会注销当前回合，真实开发和等待返修仍阻挡批准", async (t) => {
  for (const host of ["claude", "codex"]) await t.test(host, () => {
    const h = fixture();
    try {
      const env = { AUTOREVIEW_HOST: host };
      const source = join(h.root, "candidate.md");
      writeFileSync(source, "## P01 复核状态\n现象：旧状态继续提交\n根因：未重读\n正确做法：提交前重读\n出现次数：2\n");
      const cli = (action: string, value: string, dryRun = false) => spawnSync(process.execPath,
        [fileURLToPath(new URL("../loop.ts", import.meta.url)), "经验", action, h.repo, value, "--json", ...(dryRun ? ["--dry-run"] : [])],
        { cwd: h.root, env: { ...process.env, HOME: h.home }, encoding: "utf8" });
      assert.equal(cli("导入", source).status, 0);
      h.run(h.event("SessionStart"), { env }); h.run(h.event("UserPromptSubmit", { prompt: "修好 file.txt" }), { env });
      h.write("file.txt", "fixed\n"); h.run(h.delivered(), { env }); assert.equal(h.readState(host).phase, "done");
      h.run(h.event("UserPromptSubmit", { prompt: "解释一下刚才的改动" }), { env });
      assert.equal(cli("批准", "C01", true).status, 1, "问答回合进行中也不能写清单");
      const rounds = h.readState(host).rounds.length;
      h.run(h.event("Stop", { last_assistant_message: "只是解释，没有改动。" }), { env });
      assert.equal(h.readState(host).rounds.length, rounds);
      assert.equal(h.readState(host).experienceActivity.active, false);
      assert.equal(cli("批准", "C01", true).status, 0, "无改动问答结束即可批准，不必伪造另一轮交付");
      h.run(h.event("UserPromptSubmit", { prompt: "继续开发" }), { env }); h.write("file.txt", "bad\n");
      const fix = h.run(h.delivered(), { env, mode: "always-fix" }); assert.equal(JSON.parse(fix.stdout).decision, "block");
      assert.equal(cli("批准", "C01", true).status, 1, "等待返修保持阻挡");
      h.run(h.event("Stop", { last_assistant_message: "还没改" }), { env });
      assert.equal(cli("批准", "C01", true).status, 1, "未修好不能按普通问答注销");
      assert.equal(existsSync(join(h.repo, ".autoreview", "经验.md")), false);
    } finally { h.close(); }
  });
});

test("H5 上限 / 评审失败两次 / 评审改了工作区：放行并暂停",  async (t) => {
  await t.test("达到返修上限", () => {
    const h = fixture({ marker: JSON.stringify({ maxRepairs: 1 }) });
    try {
      h.run(h.event("SessionStart"));
      h.write("file.txt", "base\nA\n");
      const first = h.run(h.delivered(), { mode: "always-fix" });
      assert.equal(JSON.parse(first.stdout).decision, "block");
      h.write("file.txt", "base\nA\nB\n");
      const second = h.run(h.delivered(), { mode: "always-fix" });
      assertPauseOutput(second, /达到返修上限/);
      const state = h.readState();
      assert.equal(state.phase, "paused");
      assert.equal(state.pauseReason, "达到返修上限");
      assert.equal(state.repairs, 1);
      assert.match(h.summary(), /## 未解决的必修/);
      assert.match(h.notifications(), /暂停（达到返修上限）/);
    } finally { h.close(); }
  });
  await t.test("评审失败两次后暂停，重试发生在同一会话", () => {
    const h = fixture();
    try {
      h.run(h.event("SessionStart"));
      h.write("file.txt", "base\nA\n");
      const res = h.run(h.delivered(), { mode: "fail" });
      assertPauseOutput(res, /评审失败[\s\S]*fake reviewer: 故意失败/);
      const state = h.readState();
      assert.equal(state.phase, "paused");
      assert.equal(state.pauseReason, "评审失败");
      assert.equal(state.rounds.length, 1);
      assert.match(state.rounds[0].failed, /第 2 次评审退出码 1/);
      const calls = readFileSync(join(h.root, "fake", "calls.log"), "utf8").trim().split("\n");
      assert.equal(calls.length, 2);
      assert.match(calls[0], /autoreview-rev-claude-s1/);
      assert.match(h.notifications(), /暂停（评审失败）/);
    } finally { h.close(); }
  });
  await t.test("评审改了工作区", () => {
    const h = fixture();
    try {
      h.run(h.event("SessionStart"));
      h.write("file.txt", "base\nA\n");
      const res = h.run(h.delivered(), { mode: "modify" });
      assertPauseOutput(res, /评审改动了工作区/);
      const state = h.readState();
      assert.equal(state.phase, "paused");
      assert.equal(state.pauseReason, "评审改动了工作区");
      assert.ok(!state.awaitingRepair);
      assert.match(h.summary(), /## 评审期间变化的工作区文件/);
    } finally { h.close(); }
  });
});

test("Hook／评审返修生命周期：必修阻止交付，修后通过或请求用户决定", async (t) => {
  for (const host of ["claude", "codex"]) await t.test(host, () => {
    const h = fixture();
    const env = host === "codex" ? { PLUGIN_ROOT: "/plugin" } : { CLAUDE_PLUGIN_ROOT: "/plugin" };
    const extra = host === "codex" ? { turn_id: "turn-1" } : {};
    try {
      h.run(h.event("SessionStart", host === "codex" ? { transcript_path: "/Users/a/.codex/sessions/2026/rollout-s1.jsonl" } : {}), { env });
      h.run(h.event("UserPromptSubmit", { prompt: "需求 ORIGINAL", ...extra }), { env });
      h.write("file.txt", "base\nCHANGE\n");
      const first = h.run(h.delivered(extra), { env, mode: "always-fix" });
      assert.equal(first.code, 0);
      const repair = JSON.parse(first.stdout), pending = h.readState(host);
      assert.equal(repair.decision, "block"); assert.match(repair.reason, /【自动评审 · 第 1 次返修】/);
      assert.match(repair.reason, /add 使用了减法/);
      assert.ok(!repair.reason.includes("测试文件命名可以更明确"), "小问题不进返修消息");
      assert.equal(pending.phase, "idle"); assert.equal(pending.awaitingRepair, true);
      assert.equal(pending.repairs, 1); assert.equal(pending.rounds.length, 1);
      assert.ok(pending.unresolvedMustFix.includes("add 使用了减法"));
      assert.match(h.summary(host), /状态：进行中/);
      const input = readFileSync(join(h.home, ".pi-autoreview", basename(h.repo), `review-input-${host}-s1-r1.md`), "utf8");
      assert.ok(input.includes("需求 ORIGINAL") && input.includes("+CHANGE"));
      assert.ok(existsSync(join(h.root, "fake", "calls.log")));
      if (host === "codex") h.run(h.event("UserPromptSubmit", { prompt: repair.reason, turn_id: "turn-2" }), { env });
      assert.equal(h.readState(host).requirement, "需求 ORIGINAL"); assert.equal(h.readState(host).repairs, 1);
      h.write("file.txt", "base\nCHANGE\nFIXED\n");
      const second = h.run(h.delivered({ ...extra, stop_hook_active: true }), { env, mode: "pass-after-1" });
      assert.equal(second.code, 0); assert.equal(second.stdout, "", "通过时不输出 block");
      const state = h.readState(host);
      assert.equal(state.phase, "done"); assert.equal(state.awaitingRepair, false);
      assert.equal(state.repairs, 1); assert.equal(state.rounds.length, 2);
      assert.equal(state.reviewerSessionId, `autoreview-rev-${host}-s1`);
      assert.match(h.summary(host), /状态：完成/); assert.match(h.notifications(), /完成（评审 2 次，返修 1 次）/);
      assert.ok(!existsSync(h.statePath(host).replace(/\.state\.json$/, ".lock")));
      // 新一轮已经进入返修后提问，仍须暂停并通知；不把完成后的普通问答当作该路径。
      h.write("file.txt", "new task\n"); h.run(h.delivered(extra), { env, mode: "always-fix" });
      const pause = h.run(h.event("Stop", { last_assistant_message: "需要取舍\n【需要你决定】", ...extra }), { env });
      assert.equal(pause.code, 0); assert.equal(h.readState(host).pauseReason, "开发方需要你决定");
      assert.match(h.notifications(), /暂停（开发方需要你决定）/);
    } finally { h.close(); }
  });
});
