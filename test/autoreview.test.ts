/** 无模型入口回归 G1–G9；所有运行产物只写 os.tmpdir()。 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import autoreview from "../autoreview.ts";

type Result = { stdout: string; stderr: string; code: number; killed: boolean };
type Call = { command: string; args: string[]; options: { cwd?: string; signal?: AbortSignal; timeout?: number } };
type State = {
  enabled: boolean; phase: string; baseline?: string; baselineFingerprint?: string;
  lastSnapshot?: string; lastFingerprint?: string; unresolvedMustFix?: string;
  pauseReason?: string; repairs: number; rounds: { failed?: string; conclusion: string }[];
};
const result = (stdout = "", code = 0, stderr = "", killed = false): Result => ({ stdout, code, stderr, killed });
const PASS = "## 结论：通过\n## 必修\n无\n## 小问题\n- 无\n## 需求疑问\n- 无\n## 上轮必修复查\n- 无\n";
const FIX = "## 结论：需返修\n## 必修\n1. 位置：file.txt:1\n   问题：必修 X\n## 小问题\n- MINOR_SENTINEL\n## 需求疑问\n- QUESTION_SENTINEL\n## 上轮必修复查\n- 无\n";

async function until(predicate: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 4000;
  while (!predicate() && Date.now() < deadline) await nextTurn();
  assert.ok(predicate(), `等待失败：${description}`);
  for (let i = 0; i < 8; i += 1) await nextTurn();
}

function harness(options: { empty?: boolean; restored?: Record<string, unknown> } = {}) {
  const root = mkdtempSync(join(tmpdir(), "autoreview-unit-"));
  const repo = join(root, "repo");
  const home = join(root, "home");
  mkdirSync(repo); mkdirSync(home);
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  const git = (...args: string[]) => {
    const res = spawnSync("git", args, { cwd: repo, env, encoding: "utf8" });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    return res.stdout.trim();
  };
  git("init", "-q"); git("config", "user.email", "unit@example.com"); git("config", "user.name", "unit");
  const write = (path: string, text: string) => writeFileSync(join(repo, path), text);
  if (!options.empty) { write("file.txt", "base\n"); git("add", "file.txt"); git("commit", "-qm", "baseline"); }
  const entries: Record<string, any>[] = options.restored
    ? [{ type: "custom", customType: "autoreview-state", data: structuredClone(options.restored) }] : [];
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => any>();
  const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => any }>();
  const flags = new Map<string, string>();
  const calls: Call[] = [];
  const apiCalls: string[] = [];
  const notifications: string[] = [];
  const messages: string[] = [];
  const inputs: string[] = [];
  let inject: ((args: string[], call: Call) => Result | Promise<Result> | undefined) | undefined;
  let reviewer: (call: Call) => Result | Promise<Result> = () => result(PASS);
  let notifier: (call: Call) => Result | Promise<Result> = () => result();
  let failAppend = false;
  let failStatus = false;
  const pi = {
    on: (event: string, handler: any) => { handlers.set(event, handler); return () => handlers.delete(event); },
    registerCommand: (name: string, command: any) => commands.set(name, command),
    registerFlag: (name: string, flag: { default: string }) => flags.set(name, flag.default),
    getFlag: (name: string) => { apiCalls.push("getFlag"); return name === "autoreview-reviewer-cmd" ? "/fake-reviewer" : flags.get(name); },
    appendEntry: (customType: string, data: unknown) => {
      apiCalls.push("appendEntry");
      if (failAppend) throw new Error("appendEntry 故意失败");
      entries.push({ type: "custom", customType, data: structuredClone(data) });
    },
    sendUserMessage: (text: string) => { apiCalls.push("sendUserMessage"); messages.push(text); },
    exec: async (command: string, args: string[], execOptions: Call["options"] = {}) => {
      apiCalls.push(`exec:${basename(command)}`);
      const call = { command, args, options: execOptions }; calls.push(call);
      if (basename(command) === "osascript") return notifier(call);
      if (command === "/fake-reviewer") { inputs.push(readFileSync(args[1], "utf8")); return reviewer(call); }
      assert.equal(basename(command), "git");
      const plain = args[0] === "-c" ? args.slice(2) : args;
      const injected = inject?.(plain, call);
      if (injected) return injected;
      const res = spawnSync(command, args, { cwd: execOptions.cwd, env, encoding: "utf8" });
      return result(res.stdout || "", res.status ?? 1, res.stderr || "", Boolean(res.signal));
    },
  };
  const ctx = {
    cwd: repo, isIdle: () => { apiCalls.push("isIdle"); return true; },
    ui: {
      notify: (message: string) => { apiCalls.push("notify"); notifications.push(message); },
      setStatus: () => { apiCalls.push("setStatus"); if (failStatus) throw new Error("setStatus 故意失败"); },
    },
    sessionManager: {
      getSessionId: () => { apiCalls.push("getSessionId"); return "unit-dev"; },
      getEntries: () => { apiCalls.push("getEntries"); return entries as SessionEntry[]; },
    },
  } as unknown as ExtensionContext;
  autoreview(pi as unknown as ExtensionAPI);
  const state = (): State => [...entries].reverse().find((entry) => entry.customType === "autoreview-state")?.data;
  const event = async (name: string, data: any = {}) => {
    assert.ok(handlers.has(name), `没有注册 ${name}`);
    await handlers.get(name)!({ type: name, ...data }, ctx);
  };
  const command = async (name = "review") => { await commands.get(name)!.handler("", ctx); };
  const assistant = (text = "已完成\n【交付完成】") => entries.push({ type: "message", message: { role: "assistant", content: text } });
  const begin = async (prompt = "需求原文 ORIGINAL_REQUIREMENT") => {
    await event("before_agent_start", { prompt, systemPromptOptions: {} });
  };
  const terminal = async () => until(() => ["done", "paused"].includes(state()?.phase), "完成或暂停");
  return {
    root, repo, home, git, write, entries, calls, apiCalls, notifications, messages, inputs, state, event, command, assistant, begin, terminal,
    set inject(fn: typeof inject) { inject = fn; },
    set reviewer(fn: typeof reviewer) { reviewer = fn; },
    set notifier(fn: typeof notifier) { notifier = fn; },
    set failAppend(value: boolean) { failAppend = value; },
    set failStatus(value: boolean) { failStatus = value; },
    summary: () => readFileSync(join(home, ".pi-autoreview", "repo", "unit-dev.md"), "utf8"),
    async close() {
      for (let i = 0; i < 12; i += 1) await nextTurn();
      if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("G1 B1 中文、引号及空白路径都参与指纹保护", async (t) => {
  for (const path of ["说明.md", 'a "b".txt', " leading\ttrailing \n.txt"]) {
    await t.test(JSON.stringify(path), async () => {
      const h = harness();
      try {
        await h.event("session_start"); await h.begin();
        h.write("说明.md", "说明 A"); h.write('a "b".txt', "引号 A"); h.write(" leading\ttrailing \n.txt", "空白 A");
        h.reviewer = () => { h.write(path, "评审修改"); return result(PASS); };
        h.assistant(); await h.command(); await h.terminal();
        assert.equal(h.state().phase, "paused");
        assert.match(h.summary(), /评审改动了工作区/);
        assert.ok(h.inputs[0].includes("说明.md") && h.inputs[0].includes('a "b".txt'));
      } finally { await h.close(); }
    });
  }
});

test("G2 B2 git 取证失败暂停；无提交仓库关闭", async (t) => {
  for (const cmd of ["stash", "hash-object", "diff", "ls-files"]) {
    await t.test(`${cmd} 失败`, async () => {
      const h = harness();
      try {
        await h.event("session_start"); await h.begin(); h.write("new.txt", "new");
        h.inject = (args) => args[0] === cmd ? result("", 1, `${cmd} FAIL_SENTINEL`) : undefined;
        h.assistant(); await h.command(); await h.terminal();
        assert.equal(h.state().phase, "paused");
        assert.match(h.state().pauseReason!, /无法读取工作区状态/);
        assert.equal(h.inputs.length, 0);
        assert.ok(!h.notifications.some((text) => text.includes("：完成")));
      } finally { await h.close(); }
    });
  }
  await t.test("killed=true 即使 code=0 也失败", async () => {
    const h = harness();
    try {
      await h.event("session_start"); await h.begin();
      h.inject = (args) => args[0] === "stash" ? result("", 0, "killed", true) : undefined;
      await h.command(); await h.terminal();
      assert.match(h.state().pauseReason!, /无法读取工作区状态/);
    } finally { await h.close(); }
  });
  await t.test("仓库没有任何提交", async () => {
    const h = harness({ empty: true });
    try {
      await h.event("session_start");
      assert.ok(h.notifications.some((text) => text.includes("仓库还没有提交，自动评审已关闭")));
      assert.equal(h.state().enabled, false);
      await h.command(); assert.equal(h.inputs.length, 0);
    } finally { await h.close(); }
  });
});

test("G2 自评第 1 条：临时探测失败可续审，明确不支持则保持关闭", async (t) => {
  for (const killed of [false, true]) {
    await t.test(killed ? "探测被终止后恢复" : "探测非零失败后恢复", async () => {
      const h = harness();
      try {
        h.inject = (args) => args.includes("--git-dir") ? result("", killed ? 0 : 1, "PROBE_FAILURE", killed) : undefined;
        await h.event("session_start");
        assert.equal(h.state().phase, "paused");
        assert.equal(h.state().enabled, true);
        assert.match(h.state().pauseReason!, /无法读取工作区状态/);
        // 故障仍在时也必须重新探测，不能误报「不是 git 仓库」。
        const beforeRetry = h.calls.length;
        await h.command();
        assert.ok(h.calls.length > beforeRetry, "/review 没有重新执行 git");
        await h.terminal();
        assert.ok(!h.notifications.some((text) => text.includes("不是 git 仓库")));
        h.inject = undefined; h.write("file.txt", "base\nRECOVERED_PROBE\n");
        await h.command(); await until(() => h.state()?.phase === "done", "探测恢复后完成评审");
        assert.equal(h.inputs.length, 1);
        assert.ok(h.inputs[0].includes("+RECOVERED_PROBE"));
      } finally { await h.close(); }
    });
  }
  await t.test("确认不是 git 仓库时仍关闭", async () => {
    const h = harness();
    try {
      h.inject = (args) => args.includes("--git-dir") ? result("", 128, "fatal: not a git repository") : undefined;
      await h.event("session_start");
      assert.equal(h.state().enabled, false);
      const count = h.calls.length;
      await h.command();
      assert.equal(h.calls.length, count);
      assert.equal(h.inputs.length, 0);
      assert.ok(h.notifications.some((text) => text.includes("不是 git 仓库")));
    } finally { await h.close(); }
  });
});

test("G3 B4 快照固定提交 id；提交改动不漏审、不漏检", async (t) => {
  await t.test("干净基线和开发中提交", async () => {
    const h = harness();
    try {
      await h.event("session_start"); await h.begin();
      const baseline = h.state().baseline;
      h.write("file.txt", "base\nCOMMITTED_CHANGE\n"); h.git("add", "file.txt"); h.git("commit", "-qm", "development");
      h.assistant(); await h.command(); await h.terminal();
      assert.match(baseline!, /^[a-f0-9]{40}$/);
      assert.ok(h.inputs[0].includes("+COMMITTED_CHANGE"));
      assert.notEqual(baseline, h.git("rev-parse", "HEAD"));
    } finally { await h.close(); }
  });
  for (const empty of [false, true]) {
    await t.test(empty ? "评审只移动 HEAD，变化列表为空" : "评审修改并提交后工作区仍干净", async () => {
      const h = harness();
      try {
        await h.event("session_start"); await h.begin();
        h.reviewer = () => {
          if (!empty) { h.write("file.txt", "REVIEW_COMMIT\n"); h.git("add", "file.txt"); }
          h.git("commit", "--allow-empty", "-qm", "reviewer changed HEAD");
          return result(PASS);
        };
        h.assistant(); await h.command(); await h.terminal();
        assert.equal(h.git("status", "--short"), "");
        assert.equal(h.state().phase, "paused");
        if (empty) assert.match(h.state().pauseReason!, /工作区或提交发生了变化/);
      } finally { await h.close(); }
    });
  }
});

test("G4 B3 成功→两次失败→续审，保留检查点、必修和完整 diff", async () => {
  const h = harness();
  try {
    await h.event("session_start"); await h.begin(); h.write("file.txt", "base\nA\n");
    h.reviewer = () => result(FIX); h.assistant(); await h.command();
    await until(() => h.messages.length === 1, "首轮返修消息");
    const first = structuredClone(h.state());
    assert.ok(!h.messages[0].includes("MINOR_SENTINEL") && !h.messages[0].includes("QUESTION_SENTINEL"));
    h.write("file.txt", "base\nA\nB\n"); h.reviewer = () => result("", 1, "review failed");
    h.assistant("第 1 条：已修\n【交付完成】"); await h.event("agent_settled"); await h.terminal();
    const failed = structuredClone(h.state()); const failedSummary = h.summary();
    h.write("file.txt", "base\nA\nB\nC\n"); h.reviewer = () => result(PASS);
    h.assistant("第 1 条：已修（再检查）\n【交付完成】"); await h.command(); await h.terminal();
    const third = h.inputs.at(-1)!;
    assert.equal(failed.lastSnapshot, first.lastSnapshot);
    assert.equal(failed.lastFingerprint, first.lastFingerprint);
    assert.ok(failed.unresolvedMustFix?.includes("必修 X"));
    assert.ok(failedSummary.includes("## 未解决的必修") && failedSummary.includes("必修 X"));
    assert.ok(third.includes("必修 X") && third.includes("+B") && third.includes("+C"));
    assert.ok(third.includes("第 1 条：已修（再检查）"));
  } finally { await h.close(); }
});

test("G5 B3 首轮两次失败后续审，仍带需求原文和首轮完整改动", async () => {
  const h = harness();
  try {
    await h.event("session_start"); await h.begin(); h.write("file.txt", "base\nUNREVIEWED_A\n");
    h.reviewer = () => result("unparseable"); h.assistant(); await h.command(); await h.terminal();
    const failed = structuredClone(h.state());
    h.reviewer = () => result(PASS); await h.command(); await h.terminal();
    assert.equal(failed.lastSnapshot, undefined);
    assert.equal(failed.lastFingerprint, undefined);
    assert.ok(h.inputs.at(-1)!.includes("## 需求原文"));
    assert.ok(h.inputs.at(-1)!.includes("ORIGINAL_REQUIREMENT"));
    assert.ok(h.inputs.at(-1)!.includes("+UNREVIEWED_A"));
  } finally { await h.close(); }
});

test("G6 B5 新会话直接 /review，HEAD 基线和未提交材料完整", async () => {
  const h = harness();
  try {
    h.write("file.txt", "base\nMANUAL_CHANGE\n"); h.write("说明.md", "manual new");
    await h.event("session_start"); const head = h.git("rev-parse", "HEAD");
    await h.command(); await h.terminal();
    assert.equal(h.state().baseline, head);
    assert.ok(h.inputs[0].includes("+MANUAL_CHANGE") && h.inputs[0].includes("说明.md"));
    assert.ok(h.inputs[0].includes("本会话没有记录需求原文（手动 /review），请按改动本身和项目文档评审"));
  } finally { await h.close(); }
});

test("G7 B6 总结不可写或 pi/UI 抛错仍通知，无未处理 rejection", async (t) => {
  for (const failure of ["summary", "appendEntry", "setStatus"]) {
    await t.test(failure, async () => {
      const h = harness(); const rejections: unknown[] = [];
      const listener = (error: unknown) => rejections.push(error);
      process.on("unhandledRejection", listener);
      try {
        await h.event("session_start"); await h.begin();
        if (failure === "summary") writeFileSync(join(h.home, ".pi-autoreview"), "不是目录");
        if (failure === "appendEntry") h.failAppend = true;
        if (failure === "setStatus") h.failStatus = true;
        await h.command();
        await until(() => h.notifications.some((text) => text.includes("暂停")), "异常后仍通知");
        assert.deepEqual(rejections, []);
        if (failure === "summary") assert.ok(h.notifications.some((text) => /总结.*失败/.test(text)));
      } finally { process.off("unhandledRejection", listener); await h.close(); }
    });
  }
});

test("G8 B7 shutdown 取消 exec、存暂停，旧任务不再调用接口；恢复中断提示", async (t) => {
  await t.test("取消并隔离旧任务", async () => {
    const h = harness(); let release!: (value: Result) => void;
    const pending = new Promise<Result>((resolve) => { release = resolve; });
    try {
      await h.event("session_start"); await h.begin();
      h.reviewer = () => pending; await h.command();
      await until(() => h.inputs.length === 1, "评审已启动");
      const call = h.calls.find((item) => item.command === "/fake-reviewer")!;
      assert.ok(call.options.signal instanceof AbortSignal);
      await h.event("session_shutdown", { reason: "reload" });
      assert.equal(call.options.signal.aborted, true);
      assert.equal(h.state().phase, "paused");
      assert.match(h.state().pauseReason!, /评审被中断（会话关闭或重载）/);
      const count = h.apiCalls.length;
      release(result(PASS)); for (let i = 0; i < 16; i += 1) await nextTurn();
      assert.equal(h.apiCalls.length, count, "shutdown 返回之后不能再调用 pi/ctx");
    } finally { release(result(PASS)); await h.close(); }
  });
  await t.test("恢复持久化的 reviewing", async () => {
    const h = harness({ restored: { enabled: true, rounds: [], repairs: 0, phase: "reviewing" } });
    try {
      await h.event("session_start");
      assert.equal(h.state().phase, "paused");
      assert.match(h.state().pauseReason!, /评审被中断（会话关闭或重载）/);
      assert.ok(h.notifications.some((text) => text.includes("/review")));
    } finally { await h.close(); }
  });
});

test("G8 自评第 2 条：总结准备期间关闭保存中断，已完成通知不倒退", async (t) => {
  for (const output of [FIX, PASS]) {
    await t.test(output === FIX ? "返修总结等待期间关闭" : "完成总结等待期间关闭", async () => {
      const h = harness(); let release!: (value: Result) => void; let waiting = false;
      const pending = new Promise<Result>((resolve) => { release = resolve; });
      try {
        await h.event("session_start"); await h.begin(); h.write("file.txt", "base\nA\n");
        h.reviewer = () => result(output);
        h.inject = (args, call) => {
          if (args[0] !== "status" || !call.options.signal) return undefined;
          waiting = true;
          return pending;
        };
        await h.command(); await until(() => waiting, "总结 git status 已挂起");
        const call = h.calls.find((item) => item.args.includes("status") && item.options.signal)!;
        await h.event("session_shutdown", { reason: "reload" });
        assert.equal(call.options.signal!.aborted, true);
        assert.equal(h.state().phase, "paused");
        assert.match(h.state().pauseReason!, /评审被中断（会话关闭或重载）/);
        assert.ok(h.notifications.some((text) => text.includes("评审被中断")));
        assert.equal(h.messages.length, 0);
        if (output === FIX) assert.ok(h.state().unresolvedMustFix?.includes("必修 X"));
        const count = h.apiCalls.length;
        release(result()); for (let i = 0; i < 16; i += 1) await nextTurn();
        assert.equal(h.apiCalls.length, count, "关闭后旧总结任务不能继续调用接口");
        assert.equal(h.messages.length, 0);
      } finally { release(result()); await h.close(); }
    });
  }
  await t.test("完成后仅系统通知未返回，不应倒退成中断", async () => {
    const h = harness(); let release!: (value: Result) => void;
    const pending = new Promise<Result>((resolve) => { release = resolve; });
    try {
      await h.event("session_start"); await h.begin();
      h.notifier = () => pending;
      await h.command(); await until(() => h.state()?.phase === "done", "评审完成，系统通知等待中");
      const call = h.calls.find((item) => basename(item.command) === "osascript")!;
      await h.event("session_shutdown", { reason: "quit" });
      assert.equal(call.options.signal!.aborted, true);
      assert.equal(h.state().phase, "done");
      const count = h.apiCalls.length;
      release(result()); for (let i = 0; i < 16; i += 1) await nextTurn();
      assert.equal(h.apiCalls.length, count);
    } finally { release(result()); await h.close(); }
  });
});

test("G9 无标记自动评审：有改动就评审、无改动不动作、返修无改动暂停", async (t) => {
  await t.test("无标记 + 有改动 → 自动评审", async () => {
    const h = harness();
    try {
      await h.event("session_start"); await h.begin();
      h.write("file.txt", "base\nAUTO_A\n");
      h.assistant("普通回复，不写标记");
      await h.event("agent_settled");
      await h.terminal();
      assert.equal(h.state().phase, "done");
      assert.equal(h.inputs.length, 1);
      assert.ok(h.inputs[0].includes("+AUTO_A"));
      assert.ok(!h.notifications.some((text) => text.includes("有未评审的改动")));
    } finally { await h.close(); }
  });
  await t.test("无标记 + 无改动 → 什么都不做", async () => {
    const h = harness();
    try {
      await h.event("session_start"); await h.begin();
      h.assistant("普通回复");
      await h.event("agent_settled");
      assert.equal(h.inputs.length, 0);
      assert.equal(h.notifications.length, 0);
      assert.equal(h.state().phase, "idle");
    } finally { await h.close(); }
  });
  await t.test("返修后无标记且无改动 → 暂停「返修后没有任何改动」", async () => {
    const h = harness();
    try {
      await h.event("session_start"); await h.begin(); h.write("file.txt", "base\nA\n");
      h.reviewer = () => result(FIX); await h.command();
      await until(() => h.messages.length === 1, "返修消息");
      h.assistant("第 1 条：已修（没改文件，也没写标记）");
      await h.event("agent_settled");
      assert.equal(h.state().phase, "paused");
      assert.match(h.state().pauseReason!, /返修后没有任何改动/);
      assert.equal(h.inputs.length, 1, "不应发起新一轮评审");
    } finally { await h.close(); }
  });
  await t.test("【需要你决定】→ 暂停；暂停后不自动评审", async () => {
    const h = harness();
    try {
      await h.event("session_start"); await h.begin();
      h.assistant("卡住了\n【需要你决定】");
      await h.event("agent_settled");
      assert.equal(h.state().phase, "paused");
      assert.match(h.state().pauseReason!, /开发方需要你决定/);
      const count = h.inputs.length;
      h.write("file.txt", "base\nAFTER_PAUSE\n");
      h.assistant("普通回复");
      await h.event("agent_settled");
      assert.equal(h.inputs.length, count, "暂停后不自动评审");
    } finally { await h.close(); }
  });
  await t.test("review-off 时无标记有改动不评审", async () => {
    const h = harness();
    try {
      await h.event("session_start"); await h.begin();
      await h.command("review-off");
      h.write("file.txt", "base\nOFF_A\n");
      h.assistant("普通回复");
      await h.event("agent_settled");
      assert.equal(h.inputs.length, 0);
      assert.equal(h.state().phase, "idle");
    } finally { await h.close(); }
  });
});
