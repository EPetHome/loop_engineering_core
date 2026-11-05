/** hook／session：按功能独立运行，夹具与状态不跨测试进程共享。 */
import "./test-env.ts";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { CONVENTION, conventionText } from "../core.ts";
import { findProjectRoot, lastAssistantFromTranscript, loadConfig } from "../hosts/review-hook.ts";
import { detectHost } from "../hosts/hook.ts";
import { projectRootOf } from "../ledger.ts";
import { fixture, assertPauseOutput } from "./helpers/hook-fixture.ts";

test("Hook／普通会话隔离：配置有无及两宿主均不注入、评审或写状态", async (t) => {
  for (const [host, marker] of [["claude", null], ["claude", "{}"], ["codex", "{}"]] as const) {
    await t.test(`${host}/${marker === null ? "无配置" : "有配置"}`, () => {
      const h = fixture({ marker });
      const extra = host === "codex" ? { turn_id: "t1" } : {};
      try {
        const events = [
          h.event("SessionStart", host === "codex" ? { transcript_path: "/Users/a/.codex/sessions/2026/rollout-s1.jsonl" } : {}),
          h.event("UserPromptSubmit", { prompt: "普通聊天", ...extra }),
          h.event("Stop", { last_assistant_message: "我建议这样\n【需要你决定】", ...extra }),
        ];
        for (const event of events) {
          const res = h.run(event, { devRoot: null });
          assert.equal(res.code, 0); assert.equal(res.stdout, "");
        }
        h.write("file.txt", "base\nUNCOMMITTED\n");
        const done = h.run(h.delivered(extra), { devRoot: null, mode: "always-fix" });
        assert.equal(done.code, 0); assert.equal(done.stdout, "", "交付也不启动评审");
        assert.equal(h.notifications(), "");
        assert.ok(!existsSync(join(h.root, "fake", "calls.log")));
        assert.ok(!existsSync(h.statePath(host)));
        assert.ok(!existsSync(join(h.home, ".pi-autoreview")), "没有状态文件或总结");
      } finally { h.close(); }
    });
  }
});

test("A5 Claude/Codex 普通与开发会话的 SessionStart 都不提醒回写，旧段逐字节不变", () => {
  for (const host of ["claude", "codex"]) for (const dev of [false, true]) {
    const h = fixture();
    try {
      mkdirSync(dirname(h.ledger), { recursive: true });
      const old = Buffer.from(`## 2026-10-19 03:12 · ${projectRootOf(h.repo)} · 会话 old\r\n- [ ] 已回写原单\r\n- [x] A1 人工\r\n原文保留\r\n`);
      writeFileSync(h.ledger, old);
      for (let repeat = 0; repeat < 2; repeat++) {
        const res = h.run(h.event("SessionStart"), { devRoot: dev ? h.repo : null, env: { AUTOREVIEW_HOST: host } });
        assert.equal(res.code, 0, res.stderr);
        assert.doesNotMatch(res.stdout + res.stderr, /待回写原单|收尾回写/);
        if (dev) assert.equal(JSON.parse(res.stdout).hookSpecificOutput.additionalContext, conventionText());
        else assert.equal(res.stdout, "", "普通会话不注入任何内容");
        assert.deepEqual(readFileSync(h.ledger), old);
      }
      assert.equal(h.notifications(), "");
      if (!dev) assert.ok(!existsSync(join(h.home, ".pi-autoreview", basename(h.repo))));
    } finally { h.close(); }
  }
});

test("Hook／项目根与文件解析：启动根固定，文件引用使用宿主当前目录", async (t) => {
  for (const location of ["外层目录", "带配置的子目录", "子目录启动", "启动后切目录"]) await t.test(location, () => {
    const h = fixture();
    try {
      const sub = join(h.repo, "子目录"); mkdirSync(sub);
      writeFileSync(join(sub, ".autoreview.json"), "{}");
      h.write("需求.md", "根目录需求\n"); writeFileSync(join(sub, "需求.md"), "子目录需求\n");
      const cwd = location === "外层目录" ? h.root : sub;
      const startCwd = location === "子目录启动" || location === "外层目录" ? cwd : h.repo;
      const start = h.run(h.event("SessionStart", { cwd: startCwd }), { cwd: startCwd, devRoot: h.repo });
      assert.equal(start.code, 0);
      assert.equal(JSON.parse(start.stdout).hookSpecificOutput.additionalContext, CONVENTION);
      assert.ok(existsSync(h.statePath()));
      const relative = location === "子目录启动" || location === "启动后切目录";
      h.run(h.event("UserPromptSubmit", { prompt: relative ? "@需求.md 按这个做" : "需求", cwd }), { cwd });
      if (relative) {
        assert.match(h.readState().requirement, /子目录需求/);
        assert.doesNotMatch(h.readState().requirement, /根目录需求/);
        assert.ok(h.readState().baseline, "项目根仍用于 Git 基线");
      }
      h.write("file.txt", "base\nCHANGE\n");
      const res = h.run(h.delivered({ cwd }), { cwd, mode: location === "外层目录" ? "always-fix" : "pass" });
      assert.equal(res.code, 0); assert.doesNotMatch(res.stderr, /内部错误/);
      if (location === "外层目录") { assert.equal(JSON.parse(res.stdout).decision, "block"); assert.equal(h.readState().phase, "idle"); }
      else assert.equal(h.readState().phase, "done");
      assert.ok(existsSync(join(h.root, "fake", "calls.log")));
      assert.ok(!existsSync(join(h.home, ".pi-autoreview", basename(cwd))), "不按宿主目录另建状态");
    } finally { h.close(); }
  });
});

test("A6 AUTOREVIEW_DEV_ROOT 不可用：按项目配置不可用处理并写出变量值", async (t) => {
  await t.test("目录不存在", () => {
    const h = fixture();
    try {
      const missing = join(h.root, "missing-project");
      const res = h.run(h.event("SessionStart"), { devRoot: missing });
      assert.equal(res.code, 0);
      assert.match(JSON.parse(res.stdout).systemMessage, new RegExp(`AUTOREVIEW_DEV_ROOT=${missing.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
      const state = JSON.parse(readFileSync(join(h.home, ".pi-autoreview", basename(missing), "claude-s1.state.json"), "utf8"));
      assert.equal(state.phase, "paused");
      assert.equal(state.pauseReason, "项目配置不可用");
      assert.ok(!existsSync(join(h.root, "fake", "calls.log")));
    } finally { h.close(); }
  });
  await t.test("目录存在但没有 .autoreview.json", () => {
    const h = fixture();
    try {
      const res = h.run(h.event("UserPromptSubmit", { prompt: "需求" }), { devRoot: h.root });
      assert.equal(res.code, 0);
      assert.match(JSON.parse(res.stdout).systemMessage, /AUTOREVIEW_DEV_ROOT=/);
      const state = JSON.parse(readFileSync(join(h.home, ".pi-autoreview", basename(h.root), "claude-s1.state.json"), "utf8"));
      assert.equal(state.phase, "paused");
      assert.equal(state.requirement, "需求");
      assert.equal(state.pauseReason, "项目配置不可用，用户输入已保存");
    } finally { h.close(); }
  });
});

test("H2 SessionStart / UserPromptSubmit 注入约定，第一次提交记需求和基线", () => {
  const h = fixture({ files: { "已有.md": "untracked before\n" } });
  try {
    const start = h.run(h.event("SessionStart"));
    assert.equal(start.code, 0);
    const startOut = JSON.parse(start.stdout);
    assert.equal(startOut.hookSpecificOutput.hookEventName, "SessionStart");
    assert.equal(startOut.hookSpecificOutput.additionalContext, CONVENTION);

    const first = h.run(h.event("UserPromptSubmit", { prompt: "需求原文 ORIGINAL" }));
    const firstOut = JSON.parse(first.stdout);
    assert.equal(firstOut.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    assert.equal(firstOut.hookSpecificOutput.additionalContext, CONVENTION);
    const state = h.readState();
    assert.equal(state.requirement, "需求原文 ORIGINAL");
    assert.match(state.baseline, /^[a-f0-9]{40}$/);
    assert.ok(state.baselineUntracked.includes("已有.md"));

    h.run(h.event("UserPromptSubmit", { prompt: "第二次提交" }));
    assert.equal(h.readState().requirement, "需求原文 ORIGINAL");
  } finally { h.close(); }
});

test("H7 Hook 内部抛错：退出 0，stdout 为空或合法 JSON，状态记暂停", () => {
  const h = fixture({ marker: "{ 这不是 JSON" });
  try {
    const res = h.run(h.event("SessionStart"));
    assert.equal(res.code, 0);
    assertPauseOutput(res, /Hook 异常：[\s\S]*无法解析 .autoreview.json/);
    assert.match(res.stderr, /autoreview hook 内部错误/);
    const state = h.readState();
    assert.equal(state.phase, "paused");
    assert.equal(state.pauseReason, "自动评审内部错误");
    assert.match(h.summary(), /Hook 异常/);
    assert.match(h.notifications(), /暂停（自动评审内部错误）/);
  } finally { h.close(); }
});

test("H8 宿主识别：turn_id / 环境变量 / transcript / AUTOREVIEW_HOST 强制", () => {
  assert.equal(detectHost({}, {}), "claude");
  assert.equal(detectHost({ turn_id: "t" }, {}), "codex");
  assert.equal(detectHost({}, { CLAUDECODE: "1" }), "claude");
  assert.equal(detectHost({}, { CLAUDE_CODE_ENTRYPOINT: "cli" }), "claude");
  assert.equal(detectHost({}, { CLAUDE_PLUGIN_ROOT: "/x" }), "claude");
  assert.equal(detectHost({}, { PLUGIN_ROOT: "/x", CLAUDE_PLUGIN_ROOT: "/x" }), "codex");
  assert.equal(detectHost({}, { CODEX_THREAD_ID: "parent-thread" }), "claude", "父进程的 Codex 会话变量不能替代当前宿主身份");
  assert.equal(detectHost({ transcript_path: "/Users/a/.claude/projects/x.jsonl" }, { CLAUDE_PLUGIN_ROOT: "/x" }), "claude");
  assert.equal(detectHost({ transcript_path: "/Users/a/.codex/sessions/x.jsonl" }, { CLAUDECODE: "1" }), "codex", "当前 transcript 优先于父进程环境");
  assert.equal(detectHost({ transcript_path: "/Users/a/.codex/sessions/2026/rollout-x.jsonl" }, {}), "codex");
  assert.equal(detectHost({ transcript_path: "/Users/a/.claude/projects/x.jsonl" }, {}), "claude");
  assert.equal(detectHost({ turn_id: "t" }, { AUTOREVIEW_HOST: "x" }), "x");
});

test("H8 宿主识别：turn_id / 无 / AUTOREVIEW_HOST 强制（端到端）", () => {
  const cases: { extra: Record<string, unknown>; env?: Record<string, string>; host: string }[] = [
    { extra: {}, host: "claude" },
    { extra: { turn_id: "t-1" }, host: "codex" },
    { extra: {}, env: { AUTOREVIEW_HOST: "forced-host" }, host: "forced-host" },
    { extra: { transcript_path: "/Users/a/.codex/sessions/2026/rollout-s1.jsonl" }, host: "codex" },
  ];
  for (const item of cases) {
    const h = fixture();
    try {
      const start = h.run(h.event("SessionStart", item.extra), { env: item.env });
      assert.equal(start.code, 0); assert.ok(existsSync(h.statePath(item.host)));
      if (item.host === "codex") assert.ok(!existsSync(h.statePath("claude")));
      h.write("file.txt", "base\nA\n");
      const res = h.run(h.delivered(item.extra), { env: item.env });
      assert.equal(res.stdout, "");
      assert.equal(h.readState(item.host).reviewerSessionId, `autoreview-rev-${item.host}-s1`);
    } finally { h.close(); }
  }
});

test("Hook会话／非 git / 无提交时 SessionStart 提示后不再生效", async (t) => {
  await t.test("仓库还没有提交", () => {
    const h = fixture();
    try {
      rmSync(join(h.repo, ".git"), { recursive: true, force: true });
      h.git("init", "-q");
      const res = h.run(h.event("SessionStart"));
      const out = JSON.parse(res.stdout);
      assert.match(out.hookSpecificOutput.additionalContext, /仓库还没有提交，自动评审已关闭/);
      assert.equal(h.readState().enabled, false);
      h.write("file.txt", "base\nA\n");
      assert.equal(h.run(h.delivered(), { mode: "always-fix" }).stdout, "");
      assert.ok(!existsSync(join(h.root, "fake", "calls.log")), "关闭后不再调评审");
    } finally { h.close(); }
  });
});

test("Hook会话／transcript 解析（Claude / Codex 两种格式）", () => {
  const claude = [
    JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "第一段" }] } }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "最后一段\n【交付完成】" }] } }),
  ].join("\n");
  assert.equal(lastAssistantFromTranscript(claude), "最后一段\n【交付完成】");
  const codex = [
    JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "codex 回复\n【交付完成】" }] } }),
  ].join("\n");
  assert.equal(lastAssistantFromTranscript(codex), "codex 回复\n【交付完成】");
  assert.equal(lastAssistantFromTranscript("not json"), "");
});

test("Hook会话／findProjectRoot 与 loadConfig", () => {
  const root = mkdtempSync(join(tmpdir(), "autoreview-root-"));
  try {
    const nested = join(root, "a", "b");
    mkdirSync(nested, { recursive: true });
    assert.equal(findProjectRoot(nested), undefined);
    writeFileSync(join(root, ".autoreview.json"), "{}");
    assert.equal(findProjectRoot(nested), root);
    const config = loadConfig(root, {});
    const { configurationHash, ...settings } = config;
    assert.match(configurationHash!, /^[a-f0-9]{64}$/);
    assert.deepEqual(settings, {
      maxRepairs: 4, reviewerModel: "openai-codex/gpt-6-astra", reviewerThinking: "xhigh",
      reviewTimeoutMin: 60, reviewerCmd: "",
    });
    writeFileSync(join(root, ".autoreview.json"), JSON.stringify({ acceptance: { start: "npm start", timeoutMin: 15 } }));
    const withAcceptance = loadConfig(root, { AUTOREVIEW_ACCEPTANCE_CMD: "/fake-tester" });
    assert.equal(withAcceptance.acceptance?.start, "npm start");
    assert.equal(withAcceptance.acceptance?.testerCmd, "/fake-tester");
    writeFileSync(join(root, ".autoreview.json"), JSON.stringify({ reviewTimeoutMin: 20, acceptance: { timeoutMin: 20 } }));
    assert.throws(() => loadConfig(root, {}), /acceptance\.timeoutMin（20）必须小于/);
    writeFileSync(join(root, ".autoreview.json"), JSON.stringify({ maxRepairs: 1, reviewerModel: "m", reviewerThinking: "low", reviewTimeoutMin: 5 }));
    const custom = loadConfig(root, { AUTOREVIEW_REVIEWER_CMD: "/fake" });
    assert.equal(custom.maxRepairs, 1);
    assert.equal(custom.reviewerModel, "m");
    assert.equal(custom.reviewerThinking, "low");
    assert.equal(custom.reviewTimeoutMin, 5);
    assert.equal(custom.reviewerCmd, "/fake");
    writeFileSync(join(root, ".autoreview.json"), JSON.stringify({ maxRepairs: -1 }));
    assert.throws(() => loadConfig(root, {}), /maxRepairs/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Hook状态／状态文件损坏时暂停、不评审、保留损坏证据", () => {
  const h = fixture();
  try {
    h.run(h.event("SessionStart"));
    h.run(h.event("UserPromptSubmit", { prompt: "需求原文" }));
    writeFileSync(h.statePath(), "{ 这不是 JSON");
    h.write("file.txt", "base\nA\n");
    const res = h.run(h.delivered(), { mode: "always-fix" });
    assertPauseOutput(res, /状态文件无法使用/);
    assert.ok(!existsSync(join(h.root, "fake", "calls.log")), "损坏状态不应触发评审");
    const state = h.readState();
    assert.equal(state.phase, "paused");
    assert.equal(state.pauseReason, "自动评审内部错误");
    assert.match(h.notifications(), /暂停/);
    const files = readdirSync(join(h.home, ".pi-autoreview", basename(h.repo)));
    assert.ok(files.some((name) => name.includes(".corrupt-")), `应保留损坏证据：${files.join(",")}`);
  } finally { h.close(); }
});
