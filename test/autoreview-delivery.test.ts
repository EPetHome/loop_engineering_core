/** autoreview／delivery：按功能独立运行，夹具与状态不跨测试进程共享。 */
import "./test-env.ts";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { projectRootOf } from "../ledger.ts";
import { registerAcceptanceMaterials } from "../materials.ts";
import { readMergeQueue, registerQueueBatch } from "../merge-queue.ts";
import { statusPath } from "../pipeline-core.ts";
import { phasePath } from "../events.ts";
import { queryBatches } from "../query.ts";
import { type Result, result, PASS, FIX, until, harness, paFixture } from "./helpers/autoreview-fixture.ts";

test("A1 Pi 真正完成边界瘦身全部登记轮次，完成总结写删除统计", async () => {
  const h = harness();
  try {
    await h.event("session_start"); await h.begin();
    const runs = [1, 2].map((round) => join(h.home, ".pi-autoreview", "repo", "acceptance", "unit-dev", `r${round}`));
    for (const run of runs) {
      mkdirSync(join(run, "node_modules"), { recursive: true });
      registerAcceptanceMaterials("unit-dev", h.cwd, run, join(h.home, ".pi-autoreview", "repo", "unit-dev.procs.json"));
      writeFileSync(join(run, "data.db"), Buffer.alloc(300_000));
      writeFileSync(join(run, "node_modules", "tiny.js"), "tiny");
      for (const name of ["evidence", "logs", "checkpoints"]) {
        mkdirSync(join(run, name)); writeFileSync(join(run, name, "large.bin"), Buffer.alloc(300_000));
      }
      for (const name of ["result.json", "input.md", "screenshot.png", "system.log", "reuse.sh"]) writeFileSync(join(run, name), "keep");
    }
    h.write("file.txt", "changed\n"); h.assistant(); await h.event("agent_settled"); await h.terminal();
    await until(() => h.summary().includes("运行材料瘦身：删除 4 个文件"), "完成总结写入瘦身结果");
    assert.equal(h.state().phase, "done");
    for (const run of runs) {
      assert.equal(existsSync(join(run, "data.db")), false); assert.equal(existsSync(join(run, "node_modules")), false);
      for (const name of ["result.json", "input.md", "screenshot.png", "system.log", "reuse.sh", "evidence/large.bin", "logs/large.bin", "checkpoints/large.bin"]) assert.ok(existsSync(join(run, name)), name);
    }
  } finally { await h.close(); }
});

test("必需验收未结束或暂停时不瘦身，成功后才释放验收命令 TMPDIR 的大文件", async () => {
  const h = harness({ flags: { "autoreview-accept-cmd": "check", "autoreview-accept-mode": "required" } });
  try {
    await h.event("session_start"); await h.begin(); h.write("file.txt", "change\n"); h.assistant();
    let resume!: (value: Result) => void, evidence = "";
    h.acceptor = (call) => {
      evidence = /AUTOREVIEW_EVIDENCE_DIR='([^']+)'/.exec(call.args[1])![1];
      writeFileSync(join(evidence, "big.bin"), Buffer.alloc(300_000));
      writeFileSync(join(evidence, "reuse.sh"), "echo reuse");
      return new Promise((resolve) => { resume = resolve; });
    };
    await h.event("agent_settled"); await until(() => Boolean(resume), "必需验收开始");
    assert.equal(h.state().phase, "accepting"); assert.ok(existsSync(join(evidence, "big.bin")));
    resume(result("AUTOREVIEW_FAILURE=environment stopped", 75)); await h.terminal();
    assert.equal(h.state().phase, "paused"); assert.ok(existsSync(join(evidence, "big.bin")));
    h.acceptor = () => result("pass"); await h.command("accept"); await h.accepted();
    await until(() => h.summary().includes("运行材料瘦身：删除 1 个文件"), "必需验收通过后的瘦身");
    assert.equal(h.state().phase, "done"); assert.equal(existsSync(join(evidence, "big.bin")), false);
    assert.ok(existsSync(join(evidence, "reuse.sh")));
  } finally { await h.close(); }
});

test("附加验收结束后才瘦身其 TMPDIR，附加失败也不改变既有完成态", async (t) => {
  for (const code of [0, 1]) await t.test(`附加退出码 ${code}`, async () => {
    const h = harness({ flags: { "autoreview-accept-cmd": "check", "autoreview-accept-mode": "advisory" } });
    try {
      await h.event("session_start"); await h.begin(); h.write("file.txt", "change\n"); h.assistant();
      let evidence = "";
      h.acceptor = (call) => {
        evidence = /AUTOREVIEW_EVIDENCE_DIR='([^']+)'/.exec(call.args[1])![1];
        writeFileSync(join(evidence, "big.bin"), Buffer.alloc(300_000));
        writeFileSync(join(evidence, "reuse.sh"), "echo reuse");
        return result("advisory output", code);
      };
      await h.event("agent_settled"); await h.accepted();
      await until(() => h.summary().includes("运行材料瘦身：删除 1 个文件"), "附加验收结束后的瘦身");
      assert.equal(h.state().phase, "done"); assert.equal(existsSync(join(evidence, "big.bin")), false);
      assert.ok(existsSync(join(evidence, "reuse.sh")));
    } finally { await h.close(); }
  });
});

test("G16 交付总表：Pi 完成追加一段（部分验证 + 人工），总结开头带路径；不可写只提示", async (t) => {
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
  const requirement = "做待办\n## 验收标准\n不授权：A1\n1. [授权] 操作：todo add 买菜\n   预期：已添加\n2. 操作：todo list\n   预期：有买菜\n3. [人工] 操作：看新首页\n   预期：布局和文案是你想要的";

  await t.test("A4 完成写入：项目、任务、结果、总结、两条人工欠项，无回写勾；总结开头写明路径", async () => {
    const h = harness();
    try {
      await withEnv(accEnv(h.root), async () => {
        writeFileSync(join(h.repo, ".autoreview.json"), JSON.stringify({ acceptance: {} }));
        await h.event("session_start"); await h.begin(requirement);
        h.write("file.txt", "base\nTODO\n");
        h.assistant("做完了"); await h.event("agent_settled"); await h.terminal();
        assert.equal(h.state().phase, "done");
        const text = readFileSync(h.ledgerFile, "utf8");
        assert.match(text, new RegExp(`^## .+ · ${projectRootOf(h.repo)} · 会话 unit-dev$`, "m"));
        assert.match(text, /^- 任务：做待办$/m);
        assert.match(text, /^- 结果：完成（部分验证）；评审 1 次，返修 0 次$/m);
        assert.match(text, /^- 总结：.*\/unit-dev\.md$/m);
        assert.doesNotMatch(text, /已回写原单/);
        assert.match(text, /^- \[ \] A1 人工$/m);
        assert.match(text, /^- \[ \] A3 人工$/m);
        assert.match(h.summary(), /^# 自动评审总结\n- 已登记到交付总表：.*（A1 人工、A3 人工）$/m);
        assert.doesNotMatch(h.summary(), /待回写原单/);
      });
    } finally { await h.close(); }
  });

  await t.test("总表不可写：只提示，会话照常完成，不暂停", async () => {
    const h = harness();
    try {
      // 总表位置被一个目录占着：写入必然失败。
      const blocked = join(h.home, ".pi-autoreview", "交付记录.md");
      mkdirSync(blocked, { recursive: true });
      await withEnv(accEnv(h.root), async () => {
        writeFileSync(join(h.repo, ".autoreview.json"), JSON.stringify({ acceptance: {} }));
        await h.event("session_start"); await h.begin(requirement);
        h.write("file.txt", "base\nTODO\n");
        h.assistant("做完了"); await h.event("agent_settled"); await h.terminal();
        assert.equal(h.state().phase, "done", "写入失败不能暂停");
        assert.ok(h.notifications.some((text) => text.includes("交付总表写入失败") && text.includes("会话照常完成")));
        assert.match(h.summary(), /^- 交付总表写入失败：.*交付记录\.md（会话照常完成）$/m);
      });
    } finally { await h.close(); }
  });

  await t.test("同一会话返修后再次完成：追加新段，旧段字节保持不变", async () => {
    const h = harness();
    try {
      await withEnv(accEnv(h.root), async () => {
        writeFileSync(join(h.repo, ".autoreview.json"), JSON.stringify({ acceptance: {} }));
        await h.event("session_start"); await h.begin(requirement);
        h.write("file.txt", "base\nTODO\n");
        h.assistant("做完了"); await h.event("agent_settled"); await h.terminal();
        assert.equal(h.state().phase, "done");
        const first = readFileSync(h.ledgerFile, "utf8");
        // 再改一次并显式 /review：完成态重新评审，完成时追加新段。
        h.write("file.txt", "base\nTODO 2\n");
        h.reviewer = () => result(PASS);
        await h.command(); await h.terminal();
        const second = readFileSync(h.ledgerFile, "utf8");
        assert.ok(second.startsWith(first), "只追加不覆盖");
        assert.equal((second.match(/^## /gm) ?? []).length, 2);
        assert.match(second.slice(first.length), /^## .+ · .+ · 会话 unit-dev$/m);
      });
    } finally { await h.close(); }
  });
});

test("G17 Ponytail 未加载只在启动与完成总结提醒，不改变完成和部分验证结果", async (t) => {
  const requirement = "做待办\n## 验收标准\n1. 操作：todo add 买菜\n   预期：已添加\n2. 操作：todo list\n   预期：有买菜\n3. [人工] 操作：看新首页\n   预期：布局和文案是你想要的";
  const accEnv = (root: string, extra: Record<string, string> = {}) => ({
    AUTOREVIEW_ACCEPTANCE_CMD: fileURLToPath(new URL("./fake-tester.mjs", import.meta.url)),
    AUTOREVIEW_CRITERIA_CMD: fileURLToPath(new URL("./fake-drafter.mjs", import.meta.url)),
    FAKE_STATE_DIR: join(root, "fake"), ...extra,
  });
  const withEnv = async <T>(vars: Record<string, string>, body: () => Promise<T>): Promise<T> => {
    const saved = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
    Object.assign(process.env, vars);
    try { return await body(); } finally {
      for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
  };
  const run = async (
    commands: Array<{ name: string; source?: string }> | (() => Array<{ name: string; source?: string }>),
    options: { acceptance?: boolean; env?: Record<string, string> } = {},
  ) => {
    const h = harness({ commands });
    try {
      return await withEnv(options.acceptance ? accEnv(h.root, options.env) : {}, async () => {
        if (options.acceptance) writeFileSync(join(h.repo, ".autoreview.json"), JSON.stringify({ acceptance: {} }));
        await h.event("session_start");
        await h.begin(options.acceptance ? requirement : "改一下文件");
        h.write("file.txt", "base\nTODO\n");
        h.assistant("做完了");
        await h.event("agent_settled");
        await h.terminal();
        assert.equal(h.state().phase, "done", "Ponytail 检查不能暂停或拦住完成");
        return {
          summary: h.summary(), notifications: [...h.notifications],
          ledger: readFileSync(h.ledgerFile, "utf8"),
        };
      });
    } finally { await h.close(); }
  };
  const resultAndPending = (ledger: string): string => ledger.split("\n")
    .filter((line) => /^- 结果：|^- \[ \]/.test(line)).join("\n");

  await t.test("A1 注册了 ponytail：终端和总结都不出现提醒", async () => {
    const runResult = await run([{ name: "ponytail", source: "extension" }]);
    assert.ok(!runResult.notifications.some((text) => text.includes("未加载 Ponytail")));
    assert.doesNotMatch(runResult.summary, /未加载 Ponytail/);
  });

  await t.test("A2 没注册 ponytail：启动提示一次，照常完成，总结开头写一行", async () => {
    const runResult = await run([]);
    const notices = runResult.notifications.filter((text) => text.includes("未加载 Ponytail"));
    assert.equal(notices.length, 1);
    assert.match(notices[0], /^未加载 Ponytail（开发角色要求加载）/);
    assert.match(runResult.summary, /^# 自动评审总结\n未加载 Ponytail（开发角色要求加载）\n/m);
  });

  await t.test("A3 部分验证：提醒不改变结果和欠项", async () => {
    const loaded = await run([{ name: "ponytail", source: "extension" }], { acceptance: true });
    const missing = await run([], { acceptance: true });
    assert.doesNotMatch(loaded.summary, /未加载 Ponytail/);
    assert.match(missing.summary, /^# 自动评审总结\n未加载 Ponytail（开发角色要求加载）\n/m);
    assert.equal(resultAndPending(missing.ledger), resultAndPending(loaded.ledger));
    assert.match(missing.ledger, /^- 结果：完成（部分验证）；评审 1 次，返修 0 次$/m);
    assert.doesNotMatch(missing.ledger, /^- \[ \] A1 /m, "已通过的自动项不是人工欠项");
    assert.match(missing.ledger, /^- \[ \] A3 人工$/m);
  });

  await t.test("A4 读取命令抛错：无法判断，不提示也不写总结", async () => {
    const runResult = await run(() => { throw new Error("getCommands 故意失败"); });
    assert.ok(!runResult.notifications.some((text) => text.includes("未加载 Ponytail")));
    assert.doesNotMatch(runResult.summary, /未加载 Ponytail/);
  });
});

test("PA A1/A2：Pi 替身会话开始；决定事件带问题和选项原文，关通知仍有 stderr，恢复写 phase", async (t) => {
  const h = harness({ stage: "甲" }), pa = paFixture(h, t);
  try {
    await h.event("session_start"); assert.equal(pa.rows()[0].status, "started"); assert.equal(pa.rows()[0].seq, 1);
    await h.begin(); const question = "请选择\nA. 保留原状\nB. 改接口\n【需要你决定】"; h.assistant(question);
    let stderr = ""; const original = process.stderr.write;
    process.stderr.write = ((chunk: string) => { stderr += chunk; return true; }) as typeof process.stderr.write;
    try { await h.event("agent_settled"); } finally { process.stderr.write = original; }
    const event = pa.rows().at(-1); assert.equal(event.status, "needs-decision"); assert.equal(event.detail.question, question);
    assert.deepEqual(event.detail.options, ["A. 保留原状", "B. 改接口"]); assert.equal(event.detail.next, "send");
    assert.equal(h.calls.filter((call) => call.command === "osascript").length, 0); assert.ok(stderr.includes(question));
    const phase = JSON.parse(readFileSync(phasePath(h.pipelineDir, "甲"), "utf8")); assert.equal(phase.status, "needs-decision");
    const before = readFileSync(statusPath(h.pipelineDir, "甲")); await h.begin("选 A");
    assert.equal(pa.rows().at(-1).status, "resumed"); assert.equal(pa.rows().at(-1).detail.via, "user");
    assert.equal(JSON.parse(readFileSync(phasePath(h.pipelineDir, "甲"), "utf8")).phase, "running");
    assert.deepEqual(readFileSync(statusPath(h.pipelineDir, "甲")), before, "恢复 phase 不覆盖接力 status");
  } finally { await h.close(); }
});

test("PA A3：Pi 必需验收命令保留执行器的 environment 分类和日志，查询与事件相同", async (t) => {
  const h = harness({ stage: "甲", flags: { "autoreview-accept-cmd": "fake accept", "autoreview-accept-mode": "required" } }), pa = paFixture(h, t);
  try {
    h.acceptor = () => result("AUTOREVIEW_FAILURE=environment TEST_ENV_BLOCK\n", 75);
    await h.event("session_start"); await h.begin(); h.write("file.txt", "change\n"); h.assistant(); await h.event("agent_settled"); await h.accepted();
    const event = pa.rows().at(-1); assert.equal(event.status, "paused"); assert.equal(event.reason.category, "环境"); assert.equal(event.detail.failureKind, "environment"); assert.equal(event.detail.next, "send");
    assert.ok(existsSync(event.evidence.log)); const query: any = queryBatches(pa.file).batches[0];
    assert.deepEqual({ category: query.stages[0].pause.category, text: query.stages[0].pause.text }, event.reason);
    assert.equal(query.stages[0].evidence.log, event.evidence.log);
  } finally { await h.close(); }
});

test("PA A4：Pi 返修上限输出剩余必修原文", async (t) => {
  const h = harness({ stage: "甲", flags: { "autoreview-max-repairs": "0" } }), pa = paFixture(h, t);
  try {
    h.reviewer = () => result(FIX); await h.event("session_start"); await h.begin(); h.write("file.txt", "change\n"); h.assistant(); await h.event("agent_settled"); await h.terminal();
    const event = pa.rows().at(-1); assert.equal(event.status, "repair-limit"); assert.equal(event.detail.mustFix, h.state().unresolvedMustFix); assert.match(event.detail.mustFix, /问题：必修 X/);
  } finally { await h.close(); }
});

test("PA A5/A7：单段只在程序提交后发整批 done；接收目录只读时批次仍正常完成", async (t) => {
  for (const readonly of [false, true]) await t.test(readonly ? "只读目录" : "正常目录", async (t) => {
    const h = harness({ stage: "甲" }), pa = paFixture(h, t);
    try {
      h.write(".autoreview.json", JSON.stringify({ gate: { cmd: "true", timeoutMin: 1 } })); h.git("add", ".autoreview.json"); h.git("commit", "-qm", "config");
      const runtime = join(h.root, "runtime"); h.git("worktree", "add", "-b", "release", runtime, "HEAD"); h.git("branch", "-m", "feat/pa");
      registerQueueBatch(runtime, { name: "PA测试", file: pa.file, dir: h.pipelineDir, project: runtime, release: "release", steps: [["甲"]], stages: [{ name: "甲", cwd: h.repo, branch: "feat/pa", start: "fixture" }] });
      if (readonly) { mkdirSync(pa.events); chmodSync(pa.events, 0o500); }
      await h.event("session_start"); await h.begin(); h.write("file.txt", "checked\n"); h.assistant(); await h.event("agent_settled"); await h.terminal();
      await until(() => readMergeQueue(runtime)?.entries[0]?.status === "ready", "提交后进队且释放门禁");
      assert.equal(h.state().phase, "done"); assert.equal(h.git("status", "--porcelain"), "");
      if (readonly) {
        assert.equal(pa.rows().length, 0); assert.match(readFileSync(join(h.home, ".pi-autoreview", "events", "errors.log"), "utf8"), /"seq":\d+.*EACCES|"seq":\d+.*EPERM/);
      } else {
        const done = pa.rows().filter((event) => event.status === "done"); assert.equal(done.length, 1); assert.equal(done[0].stage, null); assert.equal(done[0].detail.scope, "整批");
        assert.equal(done[0].detail.branch, "feat/pa"); assert.equal(done[0].detail.commit, h.git("rev-parse", "feat/pa"));
        assert.equal(h.git("merge-base", "--is-ancestor", done[0].detail.commit, "feat/pa"), "");
        assert.equal(done[0].detail.test, "Loop 未运行测试"); assert.equal(done[0].detail.review.mustFix, 0); assert.equal(done[0].detail.acceptance.verdict, "未配置");
        await h.event("session_shutdown"); await h.event("session_start"); assert.equal(pa.rows().filter((event) => event.status === "done").length, 1, "恢复不补历史 done");
      }
    } finally { if (existsSync(pa.events)) chmodSync(pa.events, 0o700); await h.close(); }
  });
});

test("配置核对 A3：运行中改 Loop 配置不判业务越界，总结单独列字段", async (t) => {
  const h = harness({ stage: "甲" }), pa = paFixture(h, t);
  try {
    const batch = JSON.parse(readFileSync(pa.file, "utf8")); batch.stages.甲.scope = { allow: ["file.txt"] }; writeFileSync(pa.file, JSON.stringify(batch));
    h.write(".autoreview.json", JSON.stringify({ maxRepairs: 4, gate: { cmd: "true", timeoutMin: 1 } })); h.git("add", ".autoreview.json"); h.git("commit", "-qm", "initial config");
    await h.event("session_start"); await h.begin();
    h.write(".autoreview.json", JSON.stringify({ maxRepairs: 3, gate: { cmd: "true", timeoutMin: 1 } })); h.write("file.txt", "changed\n");
    h.assistant(); await h.event("agent_settled"); await h.terminal();
    assert.equal(h.state().phase, "done", h.state().pauseReason); assert.equal(h.state().repairs, 0);
    assert.match(h.summary(), /Loop 配置被修改：.*字段：maxRepairs/);
    assert.doesNotMatch(h.summary(), /未评审（越界改动）/);
  } finally { await h.close(); }
});

test("配置核对 A6/A7：评审异常和开发方问题同时到达会话、系统通知及事件，下一轮仍保留原文", async (t) => {
  const h = harness({ stage: "甲" }), pa = paFixture(h, t);
  try {
    writeFileSync(pa.config, JSON.stringify({ pa: { eventsDir: pa.events, localNotify: true } }));
    const original = `INTERNAL_ERROR_BEGIN ${"完整原文".repeat(150)} INTERNAL_ERROR_END`;
    const question = "接口应返回 404 还是空列表？\n请确认再继续。";
    h.reviewer = () => { throw new Error(original); };
    await h.event("session_start"); await h.begin(); h.write("file.txt", "changed\n"); h.assistant(question);
    await h.event("agent_settled"); await h.terminal();
    assert.equal(h.state().phase, "paused");
    const notice = h.notifications.at(-1)!; assert.ok(notice.includes(original)); assert.ok(notice.includes(question)); assert.match(notice, /需要你做/);
    const osascript = h.calls.filter((call) => call.command === "osascript").at(-1)!;
    assert.ok(osascript.args.join(" ").includes(original)); assert.ok(osascript.args.join(" ").includes("接口应返回 404 还是空列表？"));
    const event = pa.rows().at(-1); assert.equal(event.reason.category, "内部错误"); assert.ok(event.detail.error.includes(original)); assert.equal(event.detail.question, question);
    const evidence = event.evidence.blocker, bytes = readFileSync(evidence, "utf8"); assert.ok(bytes.includes(original));
    h.reviewer = () => result(PASS); await h.begin("继续"); h.assistant(); await h.event("agent_settled");
    await until(() => h.state().phase === "done", "下一轮正常完成");
    assert.equal(readFileSync(evidence, "utf8"), bytes); assert.ok(h.summary().includes(evidence));
  } finally { await h.close(); }
});

test("配置核对 A8：全部无法验证的具体原因出现在暂停信息，不再猜环境", async () => {
  const h = harness(), old = process.env.FAKE_ACC_UNKNOWN, oldTester = process.env.AUTOREVIEW_ACCEPTANCE_CMD;
  process.env.FAKE_ACC_UNKNOWN = "A1,A2"; process.env.AUTOREVIEW_ACCEPTANCE_CMD = fileURLToPath(new URL("./fake-tester.mjs", import.meta.url));
  try {
    h.write(".autoreview.json", JSON.stringify({ acceptance: {} }));
    await h.event("session_start"); await h.begin("需求\n## 验收标准\nA1. 操作：甲\n    预期：ok\nA2. 操作：乙\n    预期：ok");
    h.write("file.txt", "changed\n"); h.assistant(); await h.event("agent_settled"); await h.terminal();
    assert.equal(h.state().phase, "paused");
    const notice = h.notifications.at(-1)!; assert.match(notice, /A1：.*标准写得含糊/); assert.match(notice, /A2：.*标准写得含糊/);
    assert.doesNotMatch(notice, /多半是环境问题|数据库、测试账号/);
  } finally {
    if (old === undefined) delete process.env.FAKE_ACC_UNKNOWN; else process.env.FAKE_ACC_UNKNOWN = old;
    if (oldTester === undefined) delete process.env.AUTOREVIEW_ACCEPTANCE_CMD; else process.env.AUTOREVIEW_ACCEPTANCE_CMD = oldTester;
    await h.close();
  }
});
