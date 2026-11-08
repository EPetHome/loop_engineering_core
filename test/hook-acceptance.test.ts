/** hook-acceptance：独立进程隔离环境，保持全部场景与断言。 */
import "./test-env.ts";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createServer } from "node:net";
import test from "node:test";
import { ACCEPTANCE_CONVENTION } from "../acceptance-core.ts";
import { CONVENTION, conventionText } from "../core.ts";
import { loadConfig } from "../hosts/review-hook.ts";
import { ACC_ENV, fixture, assertPauseOutput } from "./helpers/hook-fixture.ts";

test("H11 自动验收：先静态评审再验收，失败按证据打回，标准只认用户消息", async (t) => {
  const marker = JSON.stringify({ acceptance: {} });
  const requirement = "做一个待办命令行\n## 验收标准\n1. 操作：todo add 买菜\n   预期：已添加\n2. 操作：todo list\n   预期：有买菜";
  const reviewerCalls = (h: ReturnType<typeof fixture>) =>
    existsSync(join(h.root, "fake", "calls.log")) ? readFileSync(join(h.root, "fake", "calls.log"), "utf8").trim().split("\n").length : 0;

  await t.test("不通过：静态评审后打回验收返修；返修后没改动 → 暂停", () => {
    const h = fixture({ marker });
    const env = { ...ACC_ENV, FAKE_ACC_FAIL: "A2" };
    try {
      h.run(h.event("SessionStart"), { env });
      h.run(h.event("UserPromptSubmit", { prompt: requirement }), { env });
      h.write("file.txt", "base\nTODO\n");
      const res = h.run(h.delivered(), { env });
      const out = JSON.parse(res.stdout);
      assert.equal(out.decision, "block");
      assert.match(out.reason, /^【自动验收 · 第 1 次返修】/);
      assert.match(out.reason, /A2\. 操作：todo list/);
      assert.ok(!out.reason.includes("A1. 操作"));
      assert.equal(reviewerCalls(h), 1, "验收在静态评审通过后执行");
      const state = h.readState();
      assert.equal(state.repairs, 1);
      assert.equal(state.rounds[0].conclusion, "评审通过（验收不通过）");
      assert.match(h.summary(), /验收：不通过/);
      const again = h.run(h.event("Stop", { last_assistant_message: "A2：已修" }), { env });
      assert.equal(again.stdout, "");
      assert.equal(h.readState().pauseReason, "返修后没有任何改动", "同一份代码不再重跑验收");
    } finally { h.close(); }
  });

  await t.test("返修上限 4 次（验收与评审共用），暂停时总结列出未通过的标准", () => {
    const h = fixture({ marker });
    const env = { ...ACC_ENV, FAKE_ACC_FAIL: "A1" };
    try {
      h.run(h.event("SessionStart"), { env });
      h.run(h.event("UserPromptSubmit", { prompt: requirement }), { env });
      for (let i = 1; i <= 4; i += 1) {
        h.write("file.txt", `base\nTRY ${i}\n`);
        assert.equal(JSON.parse(h.run(h.delivered(), { env }).stdout).decision, "block", `第 ${i} 次打回`);
      }
      h.write("file.txt", "base\nTRY 5\n");
      assertPauseOutput(h.run(h.delivered(), { env }), /达到返修上限/);
      const state = h.readState();
      assert.equal(state.pauseReason, "达到返修上限");
      assert.equal(state.repairs, 4);
      assert.match(h.summary(), /## 未通过的验收标准\nA1\. 操作：todo add 买菜/);
    } finally { h.close(); }
  });

  await t.test("需求没写标准：第一次验收前起草并冻结；你后来发的新标准替换成第 2 版", () => {
    const h = fixture({ marker });
    try {
      h.run(h.event("SessionStart"), { env: ACC_ENV });
      h.run(h.event("UserPromptSubmit", { prompt: "做一个待办命令行" }), { env: ACC_ENV });
      assert.equal(h.readState().criteria, undefined);
      h.write("file.txt", "base\nTODO\n");
      h.run(h.delivered(), { env: ACC_ENV });
      const drafted = h.readState().criteria;
      assert.equal(drafted.source, "自动起草");
      assert.equal(drafted.items.length, 2);
      assert.match(h.summary(), /## 验收标准（自动起草，未经你确认；第 1 版）/);
      h.run(h.event("UserPromptSubmit", { prompt: "再加个功能\n## 验收标准\n- 操作：todo done 1\n  预期：标记完成" }), { env: ACC_ENV });
      const replaced = h.readState().criteria;
      assert.equal(replaced.version, 2);
      assert.equal(replaced.source, "用户");
      assert.deepEqual(replaced.items.map((item: { id: string }) => item.id), ["A1"]);
      assert.equal(readFileSync(join(h.root, "fake", "draft-calls.log"), "utf8").trim().split("\n").length, 1);
    } finally { h.close(); }
  });

  await t.test("验收方改了项目文件 → 暂停「验收期间工作区变了」并列出文件", () => {
    const h = fixture({ marker });
    const env = { ...ACC_ENV, FAKE_ACC_MODE: "modify" };
    try {
      h.run(h.event("SessionStart"), { env });
      h.run(h.event("UserPromptSubmit", { prompt: requirement }), { env });
      h.write("file.txt", "base\nTODO\n");
      assertPauseOutput(h.run(h.delivered(), { env }), /验收期间工作区变了/);
      assert.equal(h.readState().pauseReason, "验收期间工作区变了");
      assert.match(h.summary(), /## 验收期间变化的工作区文件\n- tester-touched\.txt/);
      assert.equal(reviewerCalls(h), 1);
    } finally { h.close(); }
  });

  await t.test("消息里 @需求.md：Hook 展开文件，需求原文和验收标准都从文件里取", () => {
    const h = fixture({ marker, files: { "需求.md": requirement } });
    try {
      h.run(h.event("SessionStart"), { env: ACC_ENV });
      h.run(h.event("UserPromptSubmit", { prompt: "@需求.md 按这个做。@不存在.md @someone" }), { env: ACC_ENV });
      const state = h.readState();
      assert.equal(state.criteria.items.length, 2);
      assert.match(state.requirement, /^@需求\.md 按这个做。@不存在\.md @someone\n\n--- @需求\.md ---\n做一个待办命令行/);
      assert.equal(state.requirement.match(/^--- @/gm).length, 1, "读不到的 @ 当普通文字");
    } finally { h.close(); }
  });

  await t.test("开发方对标准提异议 → 暂停；你再发消息就恢复，标准不变；同一段旧回复不再重复暂停", () => {
    const h = fixture({ marker });
    try {
      h.run(h.event("SessionStart"), { env: ACC_ENV });
      h.run(h.event("UserPromptSubmit", { prompt: requirement }), { env: ACC_ENV });
      h.write("file.txt", "base\nTODO\n");
      h.run(h.event("Stop", { last_assistant_message: "A2：异议：需求没说要列表\n【交付完成】" }), { env: ACC_ENV });
      assert.equal(h.readState().pauseReason, "开发方对验收标准有异议（A2）");
      assert.ok(!existsSync(join(h.root, "fake", "acc-calls.log")), "异议时不跑验收方");
      h.run(h.event("UserPromptSubmit", { prompt: "按原标准做" }), { env: ACC_ENV });
      assert.equal(h.readState().phase, "idle");
      assert.equal(h.readState().criteria.version, 1);
      // 旧回复再次交付：Loop 已处理过，不再暂停，验收照常执行。
      h.write("file.txt", "base\nTODO 2\n");
      assert.equal(h.run(h.event("Stop", { last_assistant_message: "A2：异议：需求没说要列表\n【交付完成】" }), { env: ACC_ENV }).stdout, "");
      assert.equal(h.readState().phase, "done");
      assert.ok(existsSync(join(h.root, "fake", "acc-calls.log")), "验收照常执行");
    } finally { h.close(); }
  });

  await t.test("方法存疑：不暂停、照常验收，理由写进总结", () => {
    const h = fixture({ marker });
    try {
      h.run(h.event("SessionStart"), { env: ACC_ENV });
      h.run(h.event("UserPromptSubmit", { prompt: requirement }), { env: ACC_ENV });
      h.write("file.txt", "base\nTODO\n");
      assert.equal(h.run(h.event("Stop", { last_assistant_message: "A2：方法存疑：需求里没写这条的验收方法\n【交付完成】" }), { env: ACC_ENV }).stdout, "");
      assert.equal(h.readState().phase, "done", "方法存疑不暂停");
      assert.match(h.summary(), /验收方法存疑（照常验收，不作为通过依据）：A2：需求里没写这条的验收方法/);
      const input = readFileSync(join(h.home, ".pi-autoreview", basename(h.repo), "acceptance", "claude-s1", "r1", "input.md"), "utf8");
      assert.match(input, /## 开发方对验收方法的存疑（照常实测）\n\n- A2：需求里没写这条的验收方法/);
    } finally { h.close(); }
  });

  await t.test("开发中途来源变化：不暂停、不判失效，变化写进总结", () => {
    const sourceMarker = JSON.stringify({ acceptance: {}, context: { sources: ["need.md"] } });
    const h = fixture({ marker: sourceMarker, files: { "need.md": "原始需求" } });
    try {
      h.run(h.event("SessionStart"), { env: ACC_ENV });
      h.run(h.event("UserPromptSubmit", { prompt: requirement }), { env: ACC_ENV });
      h.write("file.txt", "base\nTODO\n");
      h.run(h.delivered(), { env: ACC_ENV });
      assert.equal(h.readState().phase, "done");
      h.write("file.txt", "base\nTODO 2\n");
      writeFileSync(join(h.repo, "need.md"), "改过的需求");
      const res = h.run(h.event("Stop", { last_assistant_message: "改完了\n【交付完成】" }), { env: ACC_ENV });
      assert.equal(h.readState().phase, "done", res.stderr);
      assert.match(h.summary(), /## 开发期间来源变化\n- need\.md（/);
    } finally { h.close(); }
  });
  await t.test("提交时来源缺失：暂停原因写明缺哪个文件", () => {
    const sourceMarker = JSON.stringify({ acceptance: {}, context: { sources: ["need.md"] } });
    const h = fixture({ marker: sourceMarker, files: { "need.md": "原始需求" } });
    try {
      h.run(h.event("SessionStart"), { env: ACC_ENV });
      rmSync(join(h.repo, "need.md"));
      const res = h.run(h.event("UserPromptSubmit", { prompt: requirement }), { env: ACC_ENV });
      assert.equal(h.readState().phase, "paused", res.stderr);
      assert.match(h.readState().pauseReason ?? "", /^上游来源缺失：need\.md$/);
    } finally { h.close(); }
  });
});

test("H15 Hook 旧 gate 不运行，静态评审后直接进入配置的自动验收", () => {
  const gate = "grep -q FIXED file.txt || { echo 'AUTOREVIEW_FAILURE=product 测试失败：file.txt 里没有 FIXED'; exit 1; }";
  const h = fixture({ marker: JSON.stringify({ gate: { cmd: gate }, acceptance: {} }) });
  const requirement = "修好 file.txt\n## 验收标准\n1. 操作：cat file.txt\n   预期：有 FIXED";
  const fakeLog = (name: string) => existsSync(join(h.root, "fake", name)) ? readFileSync(join(h.root, "fake", name), "utf8").trim().split("\n") : [];
  try {
    const start = JSON.parse(h.run(h.event("SessionStart"), { env: ACC_ENV }).stdout);
    assert.equal(start.hookSpecificOutput.additionalContext, conventionText({ acceptance: true }));
    h.run(h.event("UserPromptSubmit", { prompt: requirement }), { env: ACC_ENV });

    h.write("file.txt", "base\nTODO\n");
    assert.equal(h.run(h.delivered(), { env: ACC_ENV }).stdout, "");
    assert.equal(h.readState().repairs, 0);
    const state = h.readState();
    assert.equal(state.phase, "done");
    assert.equal(state.rounds[0].gate, undefined);
    assert.equal(state.rounds[0].acceptance.verdict, "通过");
    assert.equal(fakeLog("acc-calls.log").length, 1);
    assert.equal(fakeLog("calls.log").length, 1);
    const input = readFileSync(join(h.home, ".pi-autoreview", basename(h.repo), "review-input-claude-s1-r1.md"), "utf8");
    assert.match(input, /Loop 未运行测试/);
    assert.match(h.summary(), /Loop 未运行测试/);
    assert.doesNotMatch(h.summary(), /门禁：通过|测试通过/);
  } finally { h.close(); }
});

test("Hook旧 gate 不校验类型、命令或预算，不因此暂停", () => {
  const root = mkdtempSync(join(tmpdir(), "autoreview-gate-config-"));
  try {
    writeFileSync(join(root, ".autoreview.json"), JSON.stringify({ gate: { cmd: "npm test", timeoutMin: 5 } }));
    assert.equal(Object.hasOwn(loadConfig(root, {}), "gate"), false);
    writeFileSync(join(root, ".autoreview.json"), JSON.stringify({ reviewTimeoutMin: 30, acceptance: {}, gate: { cmd: "npm test" } }));
    assert.equal(loadConfig(root, {}).reviewTimeoutMin, 30);
  } finally { rmSync(root, { recursive: true, force: true }); }

  const h = fixture({ marker: JSON.stringify({ gate: { timeoutMin: 5 } }) });
  try {
    h.write("file.txt", "base\nCHANGE\n");
    const output = h.run(h.delivered());
    assert.equal(output.stdout, ""); assert.doesNotMatch(output.stderr, /gate.*已停用/);
    assert.equal(h.readState().phase, "done");
    assert.match(h.summary(), /Loop 未运行测试/);
    assert.ok(existsSync(join(h.root, "fake", "calls.log")));
  } finally { h.close(); }
});
