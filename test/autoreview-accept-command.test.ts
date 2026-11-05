/** autoreview／accept-command：按功能独立运行，夹具与状态不跨测试进程共享。 */
import "./test-env.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import test from "node:test";
import { type Result, result, PASS, FIX, until, harness, ACCEPT, stageStatus } from "./helpers/autoreview-fixture.ts";

test("G12 评审完成必触发验收命令：/review、无标记自动评审、返修后完成", async (t) => {
  await t.test("/review 完成后执行一次，结果写进状态、总结、日志和通知", async () => {
    const h = harness({ flags: ACCEPT });
    try {
      await h.event("session_start"); await h.begin(); h.write("file.txt", "base\nA\n");
      h.assistant(); await h.command(); await h.accepted();
      assert.equal(h.accepts.length, 1);
      const call = h.accepts[0];
      assert.equal(call.args[0], "-c");
      assert.match(call.args[1], /AUTOREVIEW_TEMP_DIR=/);
      assert.ok(call.args[1].endsWith("\nACCEPT_CMD --all"));
      assert.equal(call.options.cwd, h.repo);
      assert.ok(call.options.timeout! > 0 && call.options.timeout! <= 120 * 60_000, "使用剩余总预算");
      assert.ok(call.options.signal instanceof AbortSignal);
      const acceptance = h.state().acceptRun!;
      assert.equal(h.state().phase, "done");
      assert.deepEqual([acceptance.result, acceptance.trigger, acceptance.round], ["通过", "auto", 1]);
      const summary = h.summary();
      assert.match(summary, /^- 状态：完成$/m);
      assert.match(summary, /^- 验收命令：通过$/m);
      assert.match(summary, /第 1 轮评审完成后自动执行/);
      assert.match(summary, /ACCEPT_OUTPUT_SENTINEL/);
      const log = join(h.home, ".pi-autoreview", "repo", "accept-unit-dev-r1.log");
      assert.equal(acceptance.logPath, log);
      assert.match(readFileSync(log, "utf8"), /ACCEPT_OUTPUT_SENTINEL/);
      assert.ok(h.notifications.some((text) => text.includes("完成（评审 1 次，返修 0 次），开始执行验收命令")));
      assert.ok(h.notifications.some((text) => text.includes("验收命令通过")));
    } finally { await h.close(); }
  });
  await t.test("无标记自动评审完成后同样执行", async () => {
    const h = harness({ flags: ACCEPT });
    try {
      await h.event("session_start"); await h.begin(); h.write("file.txt", "base\nAUTO\n");
      h.assistant("改完了，不写标记"); await h.event("agent_settled"); await h.accepted();
      assert.equal(h.accepts.length, 1);
      assert.equal(h.state().acceptRun!.result, "通过");
    } finally { await h.close(); }
  });
  await t.test("返修轮不执行，返修后评审完成才执行", async () => {
    const h = harness({ flags: ACCEPT });
    try {
      await h.event("session_start"); await h.begin(); h.write("file.txt", "base\nA\n");
      let calls = 0;
      h.reviewer = () => result((calls += 1) === 1 ? FIX : PASS);
      h.assistant(); await h.command();
      await until(() => h.messages.length === 1, "返修消息");
      assert.equal(h.accepts.length, 0, "返修轮不能执行验收");
      assert.equal(h.state().acceptRun, undefined);
      h.write("file.txt", "base\nB\n"); h.assistant("第 1 条：已修\n【交付完成】");
      await h.event("agent_settled"); await h.accepted();
      assert.equal(h.accepts.length, 1);
      assert.deepEqual([h.state().acceptRun!.result, h.state().acceptRun!.round], ["通过", 2]);
    } finally { await h.close(); }
  });
});

test("G12 未配置或评审暂停时不执行验收命令", async (t) => {
  await t.test("未配置验收命令：行为与以前一致", async () => {
    const h = harness();
    try {
      await h.event("session_start"); await h.begin(); h.write("file.txt", "base\nA\n");
      await h.command(); await h.terminal();
      assert.equal(h.state().phase, "done");
      assert.equal(h.accepts.length, 0);
      assert.equal(h.state().acceptRun, undefined);
      assert.doesNotMatch(h.summary(), /验收命令/);
    } finally { await h.close(); }
  });
  for (const kind of ["达到返修上限", "评审失败"]) {
    await t.test(`${kind}暂停时不执行`, async () => {
      const h = harness({ flags: { ...ACCEPT, "autoreview-max-repairs": "0" } });
      try {
        await h.event("session_start"); await h.begin(); h.write("file.txt", "base\nA\n");
        h.reviewer = () => kind === "评审失败" ? result("", 1, "FAIL") : result(FIX);
        await h.command(); await h.terminal();
        assert.equal(h.state().phase, "paused");
        assert.match(h.state().pauseReason!, new RegExp(kind));
        for (let i = 0; i < 16; i += 1) await nextTurn();
        assert.equal(h.accepts.length, 0);
      } finally { await h.close(); }
    });
  }
});

test("G12 验收命令结果：不通过、超时、无法执行都记录并通知，评审状态不变", async (t) => {
  const cases: { name: string; respond: () => Result | Promise<Result>; label: string; detail?: RegExp }[] = [
    { name: "不通过", respond: () => result("A2 🔴\n验收结论：不通过\n", 3, "STDERR_SENTINEL"), label: "不通过（退出码 3）" },
    { name: "超时", respond: () => result("跑到一半\n", 137, "", true), label: "超时", detail: /超过 5 分钟被终止/ },
    { name: "无法执行", respond: () => Promise.reject(new Error("spawn ENOENT")), label: "无法执行", detail: /spawn ENOENT/ },
  ];
  for (const item of cases) {
    await t.test(item.name, async () => {
      const h = harness({ flags: { ...ACCEPT, "autoreview-accept-timeout-min": "5" } });
      try {
        await h.event("session_start"); await h.begin(); h.write("file.txt", "base\nA\n");
        h.acceptor = item.respond;
        await h.command(); await h.accepted();
        assert.ok(h.accepts[0].options.timeout! > 0 && h.accepts[0].options.timeout! <= 5 * 60_000);
        assert.equal(h.state().phase, "done", "验收结果不改变评审阶段");
        assert.match(h.summary(), new RegExp(`^- 验收命令：${item.label.replace(/[()（）]/g, ".")}$`, "m"));
        assert.ok(h.notifications.some((text) => text.includes(`验收命令${item.label}`)));
        if (item.detail) assert.match(h.state().acceptRun!.detail ?? "", item.detail);
        if (item.name === "不通过") assert.match(h.summary(), /STDERR_SENTINEL/);
      } finally { await h.close(); }
    });
  }
});

test("G12 验收命令期间互斥；关闭记为中断，恢复时提示 /accept", async (t) => {
  await t.test("验收期间不自动评审，/review 提示已有任务；关闭后取消命令并记中断", async () => {
    const h = harness({ flags: ACCEPT }); let release!: (value: Result) => void;
    const pending = new Promise<Result>((resolve) => { release = resolve; });
    try {
      await h.event("session_start"); await h.begin(); h.write("file.txt", "base\nA\n");
      h.acceptor = () => pending;
      await h.command(); await until(() => h.accepts.length === 1, "验收已启动");
      assert.equal(h.state().acceptRun!.result, "进行中");
      assert.match(h.summary(), /^- 验收命令：进行中$/m);
      h.write("file.txt", "base\nDURING_ACCEPT\n"); h.assistant("顺手又改了");
      await h.event("agent_settled"); await h.command();
      assert.equal(h.inputs.length, 1, "验收期间不能开始新评审");
      assert.ok(h.notifications.some((text) => text.includes("已有评审或验收命令在进行")));
      await h.event("session_shutdown", { reason: "reload" });
      assert.equal(h.accepts[0].options.signal!.aborted, true);
      assert.equal(h.state().acceptRun!.result, "中断");
      assert.equal(h.state().phase, "done");
      assert.match(h.summary(), /^- 验收命令：中断$/m);
      assert.ok(h.notifications.some((text) => text.includes("验收命令中断，输入 /accept 重新执行")));
      const count = h.apiCalls.length;
      release(result("迟到的输出")); for (let i = 0; i < 16; i += 1) await nextTurn();
      assert.equal(h.apiCalls.length, count, "关闭后旧验收任务不能再调用接口");
    } finally { release(result()); await h.close(); }
  });
  await t.test("恢复时验收仍是进行中（进程被强杀）→ 记中断并提示", async () => {
    const h = harness({
      flags: ACCEPT,
      restored: { enabled: true, rounds: [], repairs: 0, phase: "done", acceptRun: { command: "ACCEPT_CMD --all", trigger: "auto", round: 1, startedAt: "x", result: "进行中" } },
    });
    try {
      await h.event("session_start");
      assert.equal(h.state().acceptRun!.result, "中断");
      assert.ok(h.notifications.some((text) => text.includes("/accept")));
      assert.equal(h.accepts.length, 0, "恢复时不自动重跑");
    } finally { await h.close(); }
  });
});

test("G12 /accept 手动执行验收命令；新一轮评审清掉旧结果", async (t) => {
  await t.test("未配置时提示", async () => {
    const h = harness();
    try {
      await h.event("session_start"); await h.command("accept");
      assert.ok(h.notifications.some((text) => text.includes("没有配置验收命令")));
      assert.equal(h.accepts.length, 0);
    } finally { await h.close(); }
  });
  await t.test("手动执行后，新一轮评审先清掉旧结果", async () => {
    const h = harness({ flags: ACCEPT });
    try {
      await h.event("session_start"); await h.begin();
      await h.command("accept"); await h.accepted();
      assert.deepEqual([h.state().acceptRun!.trigger, h.state().acceptRun!.result], ["command", "通过"]);
      assert.equal(h.state().phase, "idle");
      assert.match(h.summary(), /手动 \/accept/);
      h.write("file.txt", "base\nA\n"); h.reviewer = () => result(FIX);
      await h.command(); await until(() => h.messages.length === 1, "返修消息");
      assert.equal(h.state().acceptRun, undefined);
      assert.equal(h.accepts.length, 1);
    } finally { await h.close(); }
  });
});

test("必需后置验收未完成时不发段 done，通过后才接力", async () => {
  const h = harness({ stage: "甲", flags: { ...ACCEPT, "autoreview-accept-mode": "required" } });
  let release!: (value: Result) => void;
  const pending = new Promise<Result>((resolve) => { release = resolve; });
  try {
    await h.event("session_start"); await h.begin(); h.write("file.txt", "base\nchange\n");
    h.acceptor = () => pending;
    h.assistant(); await h.command();
    await until(() => h.accepts.length === 1, "必需验收启动");
    assert.equal(h.state().phase, "accepting");
    assert.notEqual(stageStatus(h, "甲")?.event, "done");
    release(result("accepted")); await h.terminal();
    assert.equal(h.state().phase, "done");
    assert.equal(stageStatus(h, "甲")?.event, "done");
  } finally { release(result()); await h.close(); }
});

test("必需验收失败、候选变化或中断都不允许提前接力", async (t) => {
  for (const kind of ["environment", "changed", "interrupted"]) await t.test(kind, async () => {
    const h = harness({ stage: "甲", flags: { ...ACCEPT, "autoreview-accept-mode": "required" } });
    try {
      await h.event("session_start"); await h.begin(); h.write("file.txt", "base\nchange\n");
      h.acceptor = () => {
        if (kind === "changed") { h.write("file.txt", "changed during acceptance"); return result("ok"); }
        if (kind === "interrupted") return result("", 143, "", true);
        return result("OSError: [Errno 28] No space left on device", 1);
      };
      h.assistant(); await h.command(); await h.terminal();
      assert.equal(h.state().phase, "paused");
      assert.equal(stageStatus(h, "甲")?.event, "paused");
      assert.equal(h.state().repairs, 0);
    } finally { await h.close(); }
  });
});

test("/accept 不能绕过尚未完成的静态评审或必修", async () => {
  const h = harness({ flags: { ...ACCEPT, "autoreview-accept-mode": "required", "autoreview-max-repairs": "0" } });
  try {
    await h.event("session_start"); await h.begin(); h.write("file.txt", "change");
    await h.command("accept");
    assert.equal(h.accepts.length, 0);
    h.reviewer = () => result(FIX); h.assistant(); await h.command(); await h.terminal();
    await h.command("accept");
    assert.equal(h.accepts.length, 0);
    assert.notEqual(h.state().phase, "done");
  } finally { await h.close(); }
});

test("必需验收环境恢复有界，机器重试保留业务计数", async () => {
  const h = harness({ flags: { ...ACCEPT, "autoreview-accept-mode": "required" }, restored: { enabled: true, phase: "idle", rounds: [], repairs: 2 } });
  try {
    h.write(".autoreview.json", JSON.stringify({ preparation: { check: "ready", recover: "recover", maxRecoveries: 1 } }));
    let attempts = 0, recoveries = 0;
    h.acceptor = (call) => {
      if (call.options.role === "验收命令") { attempts++; return result("ENOSPC No space left on device", 75); }
      if (call.options.role === "环境恢复") recoveries++;
      return result("ready");
    };
    await h.event("session_start"); await h.begin(); h.write("file.txt", "base\nchange\n"); h.assistant();
    await h.event("agent_settled"); await h.terminal();
    assert.equal(h.state().phase, "paused");
    assert.equal(h.state().repairs, 2);
    assert.equal(attempts, 2); assert.equal(recoveries, 1);
    const base = h.state().baseline;
    const byRole = (role: string) => h.calls.find((call) => call.options.role === role)!;
    assert.equal(byRole("验收命令").options.env?.AUTOREVIEW_BASE_REV, base);
    assert.equal(byRole("环境恢复").options.env?.AUTOREVIEW_BASE_REV, base);
    assert.equal(byRole("准备检查").options.env?.AUTOREVIEW_BASE_REV, base);
  } finally { await h.close(); }
});

test("/accept 在昂贵命令前检查候选变化", async () => {
  const h = harness({ flags: { ...ACCEPT, "autoreview-accept-mode": "required" } });
  try {
    await h.event("session_start"); await h.begin(); h.write("file.txt", "base\nchange\n");
    h.acceptor = () => result("ENOSPC", 75); await h.command(); await h.terminal();
    const calls = h.accepts.length;
    h.write("file.txt", "new unchecked code");
    await h.command("accept");
    await until(() => /候选或输入版本变化/.test(h.state().pauseReason ?? ""), "提前检查已拒绝旧候选");
    assert.equal(h.accepts.length, calls); assert.equal(h.state().phase, "paused");
    assert.match(h.state().pauseReason!, /候选或输入版本变化/);
  } finally { await h.close(); }
});

test("返修交接等本轮释放执行锁，开发方立刻完成也不会丢掉下一轮", async () => {
  const h = harness({ flags: { ...ACCEPT, 'autoreview-accept-mode': 'required' } });
  let release!: () => void, notifying = false;
  try {
    await h.event('session_start'); await h.begin(); h.write('file.txt', 'base\nchange\n');
    h.notifier = (call) => call.args.join(' ').includes('验收命令不通过') ? new Promise((resolve) => { notifying = true; release = () => resolve(result()); }) : result();
    h.acceptor = () => result('AUTOREVIEW_FAILURE=product real assertion', 1);
    await h.command(); await until(() => notifying, '验收失败结果正在收尾通知');
    assert.equal(h.messages.length, 0, '执行锁尚未释放时不交给开发方');
    release(); await until(() => h.messages.length === 1, '本轮结束后发出返修');
    h.notifier = () => result(); h.acceptor = () => result('passed');
    await h.begin(h.messages[0]); h.write('file.txt', 'base\nfixed\n'); h.assistant(); await h.event('agent_settled'); await h.terminal();
    assert.equal(h.state().phase, 'done'); assert.equal(h.inputs.length, 2); assert.equal(h.state().repairs, 1);
  } finally { release?.(); await h.close(); }
});
