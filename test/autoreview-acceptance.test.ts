/** autoreview／acceptance：按功能独立运行，夹具与状态不跨测试进程共享。 */
import "./test-env.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ACCEPTANCE_CONVENTION } from "../acceptance-core.ts";
import { CONVENTION, conventionText } from "../core.ts";
import { statusPath } from "../pipeline-core.ts";
import { result, until, harness } from "./helpers/autoreview-fixture.ts";

test("单一入口 A2/A3/A4：Pi 文件预算 90 与显式覆盖均用于真实评审调用的超时参数", async (t) => {
  for (const flagged of [false, true]) await t.test(flagged ? "flag 120 补足默认预算" : "文件 90 不被默认 flag 遮盖", async () => {
    const h = harness({ stage: "甲", flags: { "autoreview-reviewer-cmd": "", ...(flagged ? { "autoreview-review-timeout-min": "120" } : {}) } });
    const vars = { AUTOREVIEW_ACCEPTANCE_CMD: fileURLToPath(new URL("./fake-tester.mjs", import.meta.url)), FAKE_STATE_DIR: join(h.root, "fake") };
    const old = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
    Object.assign(process.env, vars);
    try {
      h.write(".autoreview.json", JSON.stringify({
        ...(!flagged ? { reviewTimeoutMin: 90 } : {}), maxRepairs: 2, reviewerModel: "file/model", reviewerThinking: "high", reviewerCmd: "/fake-reviewer",
        gate: { cmd: "true", timeoutMin: 20 }, acceptance: { timeoutMin: 60 },
        preparation: { check: "true" }, context: { sources: [{ path: "file.txt", role: "code" }] },
      }));
      await h.event("session_start");
      await h.begin("完成需求\n## 验收标准\nA1. 操作：运行替身命令\n    预期：成功");
      h.write("file.txt", "candidate\n"); h.assistant();
      await h.event("agent_settled"); await h.terminal();
      assert.equal(h.state().phase, "done", h.summary());
      const call = h.calls.find((call) => call.command === "/fake-reviewer");
      assert.ok(call, "触发了一轮评审");
      const budget = (flagged ? 120 : 90) * 60_000;
      // 评审只为自动验收 60 分钟预留预算，旧 gate 的 20 分钟忽略。
      const reviewerBudget = budget - 60 * 60_000;
      assert.ok(call.options.timeout! > reviewerBudget - 30_000 && call.options.timeout! <= reviewerBudget, `整轮 ${budget} ms，只预留验收后应为 ${reviewerBudget} ms，实际 ${call.options.timeout}`);
      assert.doesNotMatch(h.summary(), /必须小于一轮总预算/);
      assert.equal((h.state() as any).rounds[0].acceptance.verdict, "通过");
      const published = JSON.parse(readFileSync(statusPath(h.pipelineDir, "甲"), "utf8"));
      assert.equal(published.configOverrides.reviewTimeoutMin, flagged ? "120" : "", "真实 Pi 扩展发布完成时携带原始显式覆盖");
    } finally {
      await h.close();
      for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
  });
});

test("G11 pi 扩展的后置验收：先静态评审、再验收，标准只认用户消息", async (t) => {
  const accEnv = (root: string, extra: Record<string, string> = {}) => ({
    AUTOREVIEW_ACCEPTANCE_CMD: fileURLToPath(new URL("./fake-tester.mjs", import.meta.url)),
    AUTOREVIEW_CRITERIA_CMD: fileURLToPath(new URL("./fake-drafter.mjs", import.meta.url)),
    FAKE_STATE_DIR: join(root, "fake"), ...extra,
  });
  const withEnv = async (vars: Record<string, string>, body: () => Promise<void>) => {
    const saved = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
    Object.assign(process.env, vars);
    try { await body(); } finally {
      for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
  };
  const requirement = "做待办\n## 验收标准\n1. 操作：todo add 买菜\n   预期：已添加";

  await t.test("不通过：保留先前静态评审结论，验收返修不改变标准", async () => {
    const h = harness();
    try {
      await withEnv(accEnv(h.root, { FAKE_ACC_FAIL: "A1" }), async () => {
        writeFileSync(join(h.repo, ".autoreview.json"), JSON.stringify({ acceptance: {} }));
        await h.event("session_start"); await h.begin(requirement);
        h.write("file.txt", "base\nTODO\n");
        h.assistant("做完了\n【交付完成】"); await h.event("agent_settled");
        await until(() => h.messages.length === 1, "验收返修消息");
        assert.match(h.messages[0], /^【自动验收 · 第 1 次返修】/);
        assert.equal(h.inputs.length, 1, "验收在静态评审通过之后执行");
        assert.equal(h.state().repairs, 1);
        await h.begin(h.messages[0]);
        assert.equal((h.state() as any).criteria.version, 1, "返修消息不会替换验收标准");
      });
    } finally { await h.close(); }
  });

  await t.test("acceptance 配置非法：评审时暂停并说明，不当作没配", async () => {
    const h = harness();
    try {
      writeFileSync(join(h.repo, ".autoreview.json"), JSON.stringify({ acceptance: { timeoutMin: "很久" } }));
      await h.event("session_start"); await h.begin();
      h.write("file.txt", "base\nTODO\n");
      h.assistant(); await h.command(); await h.terminal();
      assert.equal(h.state().phase, "paused");
      assert.match(h.summary(), /acceptance\.timeoutMin 必须是非负整数/);
    } finally { await h.close(); }
  });
});

test("G12/A1/A2 Pi 使用当前运行时约定，不提醒或修改项目副本；环境阻塞与人工项仍提示", async (t) => {
  const accEnv = (root: string, extra: Record<string, string> = {}) => ({
    AUTOREVIEW_ACCEPTANCE_CMD: fileURLToPath(new URL("./fake-tester.mjs", import.meta.url)),
    AUTOREVIEW_CRITERIA_CMD: fileURLToPath(new URL("./fake-drafter.mjs", import.meta.url)),
    FAKE_STATE_DIR: join(root, "fake"), ...extra,
  });
  const withEnv = async (vars: Record<string, string>, body: () => Promise<void>) => {
    const saved = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
    Object.assign(process.env, vars);
    try { await body(); } finally {
      for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
  };
  const requirement = "做待办\n## 验收标准\n1. 操作：todo add 买菜\n   预期：已添加\n2. 操作：todo list\n   预期：有买菜";

  for (const legacy of [true, false]) await t.test(legacy ? "A1 v6 副本完成一轮后字节不变且没有升级提醒" : "A2 无副本也注入当前开发约定和验收写法", async () => {
    const h = harness();
    try {
      await withEnv(accEnv(h.root), async () => {
        h.write(".autoreview.json", JSON.stringify({ acceptance: {} }));
        const copy = join(h.repo, ".autoreview", "CONVENTIONS.md");
        const bytes = Buffer.from("<!-- autoreview:acceptance v6 -->\r\nLEGACY_COPY_MUST_NOT_BE_INJECTED\r\n<!-- /autoreview:acceptance -->\r\n");
        if (legacy) { mkdirSync(join(h.repo, ".autoreview")); writeFileSync(copy, bytes); }
        await h.event("session_start");
        const options: { appendSystemPrompt?: string } = {};
        await h.event("before_agent_start", { prompt: requirement, systemPromptOptions: options });
        assert.equal(options.appendSystemPrompt, conventionText({ acceptance: true }));
        assert.ok(options.appendSystemPrompt.includes(CONVENTION));
        assert.ok(options.appendSystemPrompt.includes(ACCEPTANCE_CONVENTION));
        assert.doesNotMatch(options.appendSystemPrompt, /LEGACY_COPY_MUST_NOT_BE_INJECTED/);
        h.write("file.txt", "changed\n"); h.assistant(); await h.event("agent_settled"); await h.terminal();
        assert.equal(h.state().phase, "done"); assert.equal(h.inputs.length, 1);
        assert.equal((h.state() as any).criteria.items.length, 2);
        assert.doesNotMatch(h.inputs[0], /程序已经启动系统/);
        assert.match(h.summary(), /验收：通过/);
        assert.doesNotMatch(h.summary(), /写法是旧版|替换.*块|CONVENTIONS|可变流程说明尚未准备/);
        assert.doesNotMatch(h.notifications.join("\n"), /【块 1】|写法是旧版|CONVENTIONS/);
        if (legacy) assert.deepEqual(readFileSync(copy), bytes);
        else assert.equal(existsSync(copy), false);
      });
    } finally { await h.close(); }
  });

  await t.test("没配启动连不上 → 暂停，界面里指明 .autoreview.json 和启动配置说明，不打回开发方", async () => {
    const h = harness();
    try {
      await withEnv(accEnv(h.root, { FAKE_ACC_MODE: "unreachable" }), async () => {
        writeFileSync(join(h.repo, ".autoreview.json"), JSON.stringify({ acceptance: {} }));
        await h.event("session_start"); await h.begin(requirement);
        h.write("file.txt", "base\nTODO\n");
        h.assistant("做完了"); await h.event("agent_settled"); await h.terminal();
        assert.equal(h.state().phase, "paused");
        assert.equal(h.messages.length, 0, "不打回开发方");
        assert.ok(h.notifications.some((text) => text.includes("配置 acceptance.start") && text.includes(join(h.repo, ".autoreview.json"))));
        assert.match(h.summary(), /## 需要你做的事\n1\. 在 .*\.autoreview\.json 配置 acceptance.start/);
      });
    } finally { await h.close(); }
  });

  await t.test("个别自动条目验证不了 → 评审后暂停，不把未验证项转成人工完成", async () => {
    const h = harness();
    try {
      await withEnv(accEnv(h.root, { FAKE_ACC_UNKNOWN: "A2" }), async () => {
        writeFileSync(join(h.repo, ".autoreview.json"), JSON.stringify({ acceptance: {} }));
        await h.event("session_start"); await h.begin(requirement);
        h.write("file.txt", "base\nTODO\n");
        h.assistant("做完了"); await h.event("agent_settled"); await h.terminal();
        assert.equal(h.state().phase, "paused");
        assert.equal(h.inputs.length, 1, "照常评审");
        assert.equal(h.state().repairs, 0);
        assert.equal(existsSync(h.ledgerFile), false, "自动项未通过不得登记完成");
        assert.ok(h.notifications.some((text) => text.includes("暂停") && text.includes("完整验收仍有自动条目未通过（A2）")));
      });
    } finally { await h.close(); }
  });
});

test("G14 Pi 单会话配置旧 gate，评审后不执行、不返修并如实总结", async () => {
  const h = harness();
  const gate = "grep -q FIXED file.txt || { echo 'AUTOREVIEW_FAILURE=product'; echo 'no FIXED in file.txt'; exit 1; }";
  try {
    writeFileSync(join(h.repo, ".autoreview.json"), JSON.stringify({ gate: { cmd: gate } }));
    h.acceptor = (call) => {
      const res = spawnSync("/bin/sh", call.args, { cwd: call.options.cwd, encoding: "utf8" });
      return result(res.stdout || "", res.status ?? 1, res.stderr || "", Boolean(res.signal));
    };
    await h.event("session_start");
    const options: { appendSystemPrompt?: string } = {};
    await h.event("before_agent_start", { prompt: "修好 file.txt", systemPromptOptions: options });
    assert.equal(options.appendSystemPrompt, conventionText());

    h.write("file.txt", "base\nTODO\n");
    h.assistant(); await h.event("agent_settled");
    await h.terminal();
    assert.deepEqual(h.messages, []);
    assert.deepEqual(h.accepts, []);
    assert.equal(h.state().repairs, 0);
    assert.equal(h.state().phase, "done");
    assert.equal(h.inputs.length, 1);
    assert.match(h.inputs[0], /Loop 未运行测试/);
    assert.match(h.summary(), /Loop 未运行测试/);
    assert.doesNotMatch(h.summary(), /门禁：通过|测试通过/);
    await h.command("review-status");
    assert.ok(h.notifications.some((text) => text.includes("测试：Loop 未运行测试")));
  } finally { await h.close(); }
});

test("Pi 开发前先准备，未通过就中止该次开发，不消耗业务返修", async () => {
  const h = harness();
  try {
    h.write(".autoreview.json", JSON.stringify({ preparation: { check: "prepare-check" } }));
    h.acceptor = () => result("AUTOREVIEW_FAILURE=environment storage unavailable", 75);
    await h.event("session_start"); await h.begin();
    assert.equal(h.state().phase, "paused");
    assert.equal(h.state().repairs, 0);
    assert.ok(h.apiCalls.includes("abort"));
    assert.match(h.state().pauseReason!, /开发前准备未通过/);
  } finally { await h.close(); }
});

test("开发前准备与随后记录共用同一个开工依据：初始脏工作区不重复取快照", async () => {
  const h = harness();
  try {
    const log = join(h.root, "prep-baseline.txt");
    h.write(".autoreview.json", JSON.stringify({ preparation: { check: "record-baseline" } }));
    h.externalExec = (call) => {
      if (call.options.role !== "准备检查") return undefined;
      writeFileSync(log, call.options.env?.AUTOREVIEW_BASE_REV ?? "");
      return result("");
    };
    h.write("file.txt", "base\ndirty before prepare\n");
    await h.event("session_start"); await h.begin();
    const baseline = h.state().baseline;
    assert.ok(baseline);
    assert.equal(readFileSync(log, "utf8"), baseline, "准备拿到后来保存的 state.baseline");
    assert.notEqual(baseline, h.git("rev-parse", "HEAD"), "初始脏工作区用快照，不是 HEAD");
  } finally { await h.close(); }
});

test("流水线传入的开工依据优先于会话另取的快照，准备也拿同一份", async () => {
  const h = harness();
  const oldLaunch = process.env.AUTOREVIEW_PIPELINE_LAUNCH, oldBase = process.env.AUTOREVIEW_BASE_REV;
  try {
    const base = h.git("rev-parse", "HEAD");
    const log = join(h.root, "pipeline-prep-base.txt");
    h.write(".autoreview.json", JSON.stringify({ preparation: { check: "record-baseline" } }));
    h.externalExec = (call) => {
      if (call.options.role !== "准备检查") return undefined;
      writeFileSync(log, call.options.env?.AUTOREVIEW_BASE_REV ?? "");
      return result("");
    };
    process.env.AUTOREVIEW_PIPELINE_LAUNCH = "1"; process.env.AUTOREVIEW_BASE_REV = base;
    h.write("file.txt", "base\ndirty after pipeline snapshot\n");
    await h.event("session_start"); await h.begin();
    assert.equal(h.state().baseline, base, "采用流水线准备前确定的开工依据");
    assert.equal(readFileSync(log, "utf8"), base, "准备拿到同一份开工依据");
  } finally {
    if (oldLaunch === undefined) delete process.env.AUTOREVIEW_PIPELINE_LAUNCH; else process.env.AUTOREVIEW_PIPELINE_LAUNCH = oldLaunch;
    if (oldBase === undefined) delete process.env.AUTOREVIEW_BASE_REV; else process.env.AUTOREVIEW_BASE_REV = oldBase;
    await h.close();
  }
});

test("Pi 关闭/重载等待外部资源释放，释放不沿用已取消生命周期", async (t) => {
  for (const reason of ["quit", "reload"]) await t.test(reason, async () => {
    const h = harness();
    let cleanupStarted = false, finishCleanup!: () => void;
    try {
      h.write(".autoreview.json", JSON.stringify({ acceptance: { cleanup: "release-owned" } }));
      await h.event("session_start"); await h.begin("requirement\n## 验收标准\n1. 操作：检查\n预期：ok");
      h.write("file.txt", "base\nchange\n");
      h.externalExec = (call) => {
        if (call.options.role === "验收方") return new Promise((resolve) => {
          const cancelled = () => resolve(result("", 137, "", true));
          if (call.options.signal?.aborted) cancelled(); else call.options.signal?.addEventListener("abort", cancelled, { once: true });
        });
        if (call.options.role === "释放项目资源") {
          cleanupStarted = true;
          assert.equal(call.options.signal, undefined);
          return new Promise((resolve) => { finishCleanup = () => resolve(result("released")); });
        }
      };
      await h.command(); await until(() => h.calls.some((c) => c.options.role === "验收方"), "验收方已启动");
      let stopped = false;
      const closing = h.event("session_shutdown", { reason }).then(() => { stopped = true; });
      await until(() => cleanupStarted, "取消后仍执行释放");
      assert.equal(stopped, false, "宿主关闭要等待有界收尾");
      finishCleanup(); await closing;
      const record = JSON.parse(readFileSync(join(h.home, ".pi-autoreview", "repo", "acceptance", "unit-dev", "r1", "cleanup-task.json"), "utf8"));
      assert.equal(record.status, "released"); assert.ok(record.runId);
      assert.match(h.summary(), /外部资源释放：released/);
      assert.equal(h.state().phase, "paused");
    } finally { finishCleanup?.(); await h.close(); }
  });
});

test("旧回复里的标准异议处理过一次后 /review 不再重复暂停", async () => {
  const h = harness();
  const oldTester = process.env.AUTOREVIEW_ACCEPTANCE_CMD;
  process.env.AUTOREVIEW_ACCEPTANCE_CMD = fileURLToPath(new URL("./fake-tester.mjs", import.meta.url));
  try {
    h.write(".autoreview.json", JSON.stringify({ acceptance: {} }));
    await h.event("session_start");
    await h.begin("requirement\n## 验收标准\n1. 操作：检查\n预期：ok");
    h.write("file.txt", "base\nchange\n");
    // 开发方提异议；用户让它按原标准继续，开发方没再说话，/review 再跑时回复原文仍是这条。
    h.assistant("A1：已修\nA1：异议：标准写错了\n【交付完成】");
    await h.command(); await h.terminal();
    assert.equal(h.state().phase, "paused");
    assert.match(h.state().pauseReason!, /开发方对验收标准有异议（A1）/);
    await h.begin("按原标准继续");
    assert.equal(h.state().phase, "idle");
    await h.command(); await h.terminal();
    assert.equal(h.state().phase, "done", `旧异议不再重复拦截，照常验收完成（暂停原因：${h.state().pauseReason ?? "无"}）`);
  } finally {
    await h.close();
    if (oldTester === undefined) delete process.env.AUTOREVIEW_ACCEPTANCE_CMD; else process.env.AUTOREVIEW_ACCEPTANCE_CMD = oldTester;
  }
});
