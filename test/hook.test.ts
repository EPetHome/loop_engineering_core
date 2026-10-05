/** hosts/hook.ts 无模型回归 H1–H8；所有运行产物只写 os.tmpdir()。 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { CONVENTION } from "../core.ts";
import { childExec, detectHost, findProjectRoot, lastAssistantFromTranscript, loadConfig } from "../hosts/hook.ts";

const HOOK = fileURLToPath(new URL("../hosts/hook.ts", import.meta.url));
const FAKE = fileURLToPath(new URL("./fake-reviewer.mjs", import.meta.url));

interface RunOptions {
  mode?: string;
  env?: Record<string, string>;
  cwd?: string;
  input?: string;
  session?: string;
}

function fixture(options: { marker?: string | null; maxRepairs?: number; files?: Record<string, string> } = {}) {
  const root = mkdtempSync(join(tmpdir(), "autoreview-hook-"));
  const repo = join(root, "repo");
  const home = join(root, "home");
  const bin = join(root, "bin");
  const osLog = join(root, "osascript.log");
  mkdirSync(repo); mkdirSync(home); mkdirSync(bin);
  const osa = join(bin, "osascript");
  writeFileSync(osa, `#!/bin/sh\necho "$@" >> "${osLog}"\n`);
  chmodSync(osa, 0o755);
  // 假 git：FAKE_GIT_FAIL=<子命令> 时对该子命令返回非零，其余转发给真实 git。
  const realGit = (() => {
    const res = spawnSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" });
    return (res.stdout || "").trim() || "/usr/bin/git";
  })();
  const fakeGit = join(bin, "git");
  writeFileSync(fakeGit, `#!/bin/sh\nif [ -n "$FAKE_GIT_FAIL" ]; then\n  case " $* " in\n    *" $FAKE_GIT_FAIL "*) echo "fake git failure" >&2; exit 1;;\n  esac\nfi\nexec "${realGit}" "$@"\n`);
  chmodSync(fakeGit, 0o755);
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  const git = (...args: string[]): string => {
    const res = spawnSync("git", args, { cwd: repo, env, encoding: "utf8" });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    return res.stdout.trim();
  };
  git("init", "-q"); git("config", "user.email", "hook@example.com"); git("config", "user.name", "hook");
  const write = (path: string, text: string) => {
    const file = join(repo, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  };
  write("file.txt", "base\n"); git("add", "file.txt"); git("commit", "-qm", "baseline");
  const marker = options.marker === undefined ? "{}" : options.marker;
  if (marker !== null) writeFileSync(join(repo, ".autoreview.json"), marker);
  for (const [path, text] of Object.entries(options.files ?? {})) write(path, text);

  const run = (event: Record<string, unknown> | string, runOptions: RunOptions = {}) => {
    const baseEnv = { ...env };
    for (const key of ["CLAUDECODE", "CLAUDE_PLUGIN_ROOT", "CLAUDE_CODE_ENTRYPOINT", "AUTOREVIEW_HOST"]) delete baseEnv[key];
    const res = spawnSync(process.execPath, [HOOK], {
      input: typeof event === "string" ? event : JSON.stringify(event),
      cwd: runOptions.cwd ?? repo,
      env: {
        ...baseEnv,
        HOME: home,
        PATH: `${bin}:${env.PATH}`,
        AUTOREVIEW_REVIEWER_CMD: FAKE,
        FAKE_MODE: runOptions.mode ?? "pass",
        FAKE_STATE_DIR: join(root, "fake"),
        FAKE_OSASCRIPT_LOG: osLog,
        ...runOptions.env,
      },
      encoding: "utf8",
    });
    return { code: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
  };
  const statePath = (host = "claude", session = "s1") =>
    join(home, ".pi-autoreview", basename(repo), `${host}-${session}.state.json`);
  const readState = (host = "claude", session = "s1") => JSON.parse(readFileSync(statePath(host, session), "utf8"));
  const summary = (host = "claude", session = "s1") =>
    readFileSync(join(home, ".pi-autoreview", basename(repo), `${host}-${session}.md`), "utf8");
  const notifications = () => existsSync(osLog) ? readFileSync(osLog, "utf8") : "";
  const event = (name: string, extra: Record<string, unknown> = {}, session = "s1") =>
    ({ hook_event_name: name, cwd: repo, session_id: session, ...extra });
  const delivered = (extra: Record<string, unknown> = {}) =>
    event("Stop", { last_assistant_message: "已完成\n【交付完成】", ...extra });
  return {
    root, repo, home, write, git, run, event, delivered, statePath, readState, summary, notifications,
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("H1 找不到 .autoreview.json：退出 0，stdout 为空，不写状态", () => {
  const h = fixture({ marker: null });
  try {
    for (const ev of [h.event("SessionStart"), h.event("UserPromptSubmit", { prompt: "hi" }), h.delivered()]) {
      const res = h.run(ev);
      assert.equal(res.code, 0);
      assert.equal(res.stdout, "");
    }
    assert.ok(!existsSync(join(h.home, ".pi-autoreview")));
  } finally { h.close(); }
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

test("H3 Stop + 交付完成 + 1 条必修：输出合法 block JSON，状态与总结正确", () => {
  const h = fixture();
  try {
    h.run(h.event("SessionStart"));
    h.run(h.event("UserPromptSubmit", { prompt: "需求 ORIGINAL" }));
    h.write("file.txt", "base\nCHANGE\n");
    const res = h.run(h.delivered(), { mode: "always-fix" });
    assert.equal(res.code, 0);
    const out = JSON.parse(res.stdout);
    assert.equal(out.decision, "block");
    assert.match(out.reason, /【自动评审 · 第 1 次返修】/);
    assert.match(out.reason, /add 使用了减法/);
    assert.ok(!out.reason.includes("测试文件命名可以更明确"), "小问题不进返修消息");
    const state = h.readState();
    assert.equal(state.phase, "idle");
    assert.equal(state.awaitingRepair, true);
    assert.equal(state.repairs, 1);
    assert.equal(state.rounds.length, 1);
    assert.equal(state.unresolvedMustFix.includes("add 使用了减法"), true);
    assert.match(h.summary(), /状态：进行中/);
    // 评审输入包含需求原文与本轮改动。
    const inputFile = join(h.home, ".pi-autoreview", basename(h.repo), "review-input-claude-s1-r1.md");
    const input = readFileSync(inputFile, "utf8");
    assert.ok(input.includes("需求 ORIGINAL") && input.includes("+CHANGE"));
  } finally { h.close(); }
});

test("H4 返修后 stop_hook_active=true 再交付：通过，放行并通知", () => {
  const h = fixture();
  try {
    h.run(h.event("SessionStart"));
    h.write("file.txt", "base\nCHANGE\n");
    const first = h.run(h.delivered(), { mode: "always-fix" });
    assert.equal(JSON.parse(first.stdout).decision, "block");
    h.write("file.txt", "base\nCHANGE\nFIXED\n");
    const second = h.run(h.delivered({ stop_hook_active: true }), { mode: "pass-after-1" });
    assert.equal(second.code, 0);
    assert.equal(second.stdout, "", "通过时不输出 block");
    const state = h.readState();
    assert.equal(state.phase, "done");
    assert.equal(state.awaitingRepair, false);
    assert.equal(state.rounds.length, 2);
    assert.match(h.summary(), /状态：完成/);
    assert.match(h.notifications(), /完成（评审 2 次，返修 1 次）/);
    assert.ok(!existsSync(h.statePath().replace(/\.state\.json$/, ".lock")), "锁已释放");
  } finally { h.close(); }
});

test("H5 上限 / 评审失败两次 / 评审改了工作区：放行并暂停", async (t) => {
  await t.test("达到返修上限", () => {
    const h = fixture({ marker: JSON.stringify({ maxRepairs: 1 }) });
    try {
      h.run(h.event("SessionStart"));
      h.write("file.txt", "base\nA\n");
      const first = h.run(h.delivered(), { mode: "always-fix" });
      assert.equal(JSON.parse(first.stdout).decision, "block");
      h.write("file.txt", "base\nA\nB\n");
      const second = h.run(h.delivered(), { mode: "always-fix" });
      assert.equal(second.stdout, "");
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
      assert.equal(res.stdout, "");
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
      assert.equal(res.stdout, "");
      const state = h.readState();
      assert.equal(state.phase, "paused");
      assert.equal(state.pauseReason, "评审改动了工作区");
      assert.ok(!state.awaitingRepair);
      assert.match(h.summary(), /## 评审期间变化的工作区文件/);
    } finally { h.close(); }
  });
});

test("H6 锁属于已死进程：记「评审被中断」暂停并通知", () => {
  const h = fixture();
  try {
    h.run(h.event("SessionStart"));
    const lock = h.statePath().replace(/\.state\.json$/, ".lock");
    mkdirSync(join(h.home, ".pi-autoreview", basename(h.repo)), { recursive: true });
    writeFileSync(lock, JSON.stringify({ pid: 999999, startedAt: "2026-01-01T00:00:00Z" }));
    const res = h.run(h.delivered());
    assert.equal(res.code, 0);
    assert.equal(res.stdout, "");
    const state = h.readState();
    assert.equal(state.phase, "paused");
    assert.match(state.pauseReason, /评审被中断/);
    assert.match(h.notifications(), /评审被中断/);
    assert.ok(!existsSync(lock), "死锁已清理");
  } finally { h.close(); }
});

test("H7 Hook 内部抛错：退出 0，stdout 为空或合法 JSON，状态记暂停", () => {
  const h = fixture({ marker: "{ 这不是 JSON" });
  try {
    const res = h.run(h.event("SessionStart"));
    assert.equal(res.code, 0);
    assert.equal(res.stdout, "");
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
  assert.equal(detectHost({}, { CLAUDE_PLUGIN_ROOT: "/x" }), "codex");
  assert.equal(detectHost({ transcript_path: "/Users/a/.codex/sessions/2026/rollout-x.jsonl" }, {}), "codex");
  assert.equal(detectHost({ transcript_path: "/Users/a/.claude/projects/x.jsonl" }, {}), "claude");
  assert.equal(detectHost({ turn_id: "t" }, { AUTOREVIEW_HOST: "x" }), "x");
});

test("H8 补充：Codex SessionStart 没有 turn_id 也写 codex 状态", () => {
  const h = fixture();
  try {
    const res = h.run(h.event("SessionStart", { transcript_path: "/Users/a/.codex/sessions/2026/rollout-s1.jsonl" }));
    assert.equal(res.code, 0);
    assert.ok(existsSync(h.statePath("codex")), "应有 codex 状态文件");
    assert.ok(!existsSync(h.statePath("claude")), "不应有 claude 状态文件");
  } finally { h.close(); }
});

test("H8 宿主识别：turn_id / 无 / AUTOREVIEW_HOST 强制（端到端）", () => {
  const cases: { extra: Record<string, unknown>; env?: Record<string, string>; host: string }[] = [
    { extra: {}, host: "claude" },
    { extra: { turn_id: "t-1" }, host: "codex" },
    { extra: {}, env: { AUTOREVIEW_HOST: "forced-host" }, host: "forced-host" },
  ];
  for (const item of cases) {
    const h = fixture();
    try {
      h.run(h.event("SessionStart"), { env: item.env });
      h.write("file.txt", "base\nA\n");
      const res = h.run(h.delivered(item.extra), { env: item.env });
      assert.equal(res.stdout, "");
      assert.equal(h.readState(item.host).reviewerSessionId, `autoreview-rev-${item.host}-s1`);
    } finally { h.close(); }
  }
});

test("H 补充（新规则）：无标记按指纹决定评审/不动作/暂停", async (t) => {
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
      assert.equal(res.stdout, "");
      assert.equal(h.readState().pauseReason, "开发方需要你决定");
      assert.match(h.notifications(), /暂停（开发方需要你决定）/);
    } finally { h.close(); }
  });
});

test("H 补充：非 git / 无提交时 SessionStart 提示后不再生效", async (t) => {
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

test("H 补充：transcript 解析（Claude / Codex 两种格式）", () => {
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

test("H 补充：detectHost / findProjectRoot / loadConfig", () => {
  const root = mkdtempSync(join(tmpdir(), "autoreview-root-"));
  try {
    const nested = join(root, "a", "b");
    mkdirSync(nested, { recursive: true });
    assert.equal(findProjectRoot(nested), undefined);
    writeFileSync(join(root, ".autoreview.json"), "{}");
    assert.equal(findProjectRoot(nested), root);
    const config = loadConfig(root, {});
    assert.deepEqual(config, {
      maxRepairs: 3, reviewerModel: "openai-codex/gpt-6-astra", reviewerThinking: "xhigh",
      reviewTimeoutMin: 60, reviewerCmd: "",
    });
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

// —— 返修（第 1–5 条）回归 ——

test("H 返修 1：.autoreview.json 在上级时，以宿主 cwd 为开发目录", () => {
  const h = fixture({ marker: null });
  try {
    writeFileSync(join(h.root, ".autoreview.json"), "{}");
    const start = h.run(h.event("SessionStart"));
    assert.equal(start.code, 0);
    assert.equal(JSON.parse(start.stdout).hookSpecificOutput.additionalContext, CONVENTION);
    assert.ok(existsSync(h.statePath("claude", "s1")), "状态按 cwd 的项目名存放");
    h.write("file.txt", "base\nCHANGE\n");
    const stop = h.run(h.delivered(), { mode: "always-fix" });
    assert.equal(JSON.parse(stop.stdout).decision, "block");
    assert.equal(h.readState().phase, "idle");
  } finally { h.close(); }
});

test("H 返修 2：childExec 超时杀进程组并有界返回", async () => {
  const holder = fileURLToPath(new URL("./descendant-holder.mjs", import.meta.url));
  const started = Date.now();
  const res = await childExec(process.execPath, [holder], { cwd: tmpdir(), timeout: 200 });
  const elapsed = Date.now() - started;
  assert.equal(res.killed, true);
  assert.ok(elapsed < 3000, `应在有界时间返回，实际 ${elapsed}ms`);
});

test("H 返修 3：状态文件损坏时暂停、不评审、保留损坏证据", () => {
  const h = fixture();
  try {
    h.run(h.event("SessionStart"));
    h.run(h.event("UserPromptSubmit", { prompt: "需求原文" }));
    writeFileSync(h.statePath(), "{ 这不是 JSON");
    h.write("file.txt", "base\nA\n");
    const res = h.run(h.delivered(), { mode: "always-fix" });
    assert.equal(res.stdout, "");
    assert.ok(!existsSync(join(h.root, "fake", "calls.log")), "损坏状态不应触发评审");
    const state = h.readState();
    assert.equal(state.phase, "paused");
    assert.equal(state.pauseReason, "自动评审内部错误");
    assert.match(h.notifications(), /暂停/);
    const files = readdirSync(join(h.home, ".pi-autoreview", basename(h.repo)));
    assert.ok(files.some((name) => name.includes(".corrupt-")), `应保留损坏证据：${files.join(",")}`);
  } finally { h.close(); }
});

test("H 返修 4：完成总结与未交付提醒的 git 取证失败都改为暂停", async (t) => {
  await t.test("完成总结 git status 失败", () => {
    const h = fixture();
    try {
      h.run(h.event("SessionStart"));
      h.write("file.txt", "base\nA\n");
      const res = h.run(h.delivered(), { mode: "pass", env: { FAKE_GIT_FAIL: "status" } });
      assert.equal(res.stdout, "");
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

test("H 返修 5：完成后再次交付重置返修计数", () => {
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
