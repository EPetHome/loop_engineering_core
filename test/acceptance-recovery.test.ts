/** acceptance／recovery：按功能独立运行，夹具与状态不跨测试进程共享。 */
/** 自动验收：纯函数（取标准、解析、判定、消息）与一轮验收流程（真起被测系统）；产物只写 os.tmpdir()。 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { parseAcceptanceReport } from "../acceptance-core.ts";
import { ACCEPTANCE_EVENTS_PATH, RECOVERY_PROMPT_PATH, runAcceptanceStage } from "../acceptance.ts";
import { blockerHint } from "../onboarding.ts";
import { processStartTime, readProcs } from "../procs.ts";
import { recordToolActivity } from "../acceptance-events.ts";
import { STALLED_TESTER, criteriaItems, block, harness, acceptanceSummary } from "./helpers/acceptance-fixture.ts";

test("断线 A1/A2/A4：全部/部分证据后挂住，及时结束、只读补判、总结逐条给命令及脚本", async (t) => {
  for (const mode of ["stall-all", "stall-partial"]) await t.test(mode, async () => {
    const h = await harness({ idleTimeoutSec: 1, reset: 'echo reset >> "$AUTOREVIEW_RUN_DIR/reset-count"' },
      { AUTOREVIEW_ACCEPTANCE_CMD: STALLED_TESTER, FAKE_ACC_MODE: mode });
    try {
      const start = Date.now();
      const stage = await runAcceptanceStage(h.deps());
      assert.equal(stage.kind, "judged"); if (stage.kind !== "judged") return;
      const { record } = stage;
      assert.ok(Date.now() - start < 5000, "整轮用时远小于 5 分钟预算");
      const lastAction = Number(readFileSync(join(record.runDir, "last-action"), "utf8"));
      assert.ok(Date.now() - lastAction < 3000, "末次动作后按 1 秒空闲阈值结束，包含轮询和清理开销");
      assert.equal(record.recovery?.attempted, true);
      assert.equal(record.escalated, undefined, "补报告不是从头重验");
      assert.equal(record.items[0].verdict, "通过");
      assert.equal(record.items[1].verdict, mode === "stall-all" ? "通过" : "无法验证");
      assert.equal(record.verdict, mode === "stall-all" ? "通过" : "无法验收");
      if (mode === "stall-partial") {
        assert.equal(record.blocker, "验收方模型断线");
        assert.match(record.items[1].detail, /原因：验收方模型断线；未留下该条的有效实测证据/);
        assert.match(blockerHint(record, h.work, h.config), /不是被测系统超时或崩溃/);
      }
      assert.equal(h.calls().length, 2);
      assert.match(h.calls()[1], /recovery\.md\tautoreview-acc-report-/);
      assert.notEqual(h.calls()[0].split("\t")[2], h.calls()[1].split("\t")[2]);
      assert.equal(readFileSync(join(record.runDir, "reset-count"), "utf8").trim(), "reset", "补报告不 reset");
      const summary = acceptanceSummary(record);
      for (const item of record.items.filter((item) => item.verdict === "通过")) {
        assert.deepEqual(item.execution?.scripts, [join(record.runDir, "checks", `check-${item.id}.mjs`)]);
        assert.match(summary, new RegExp(`实际命令：\\$ .*check-${item.id}\\.mjs`));
        const evidence = readFileSync(join(record.runDir, "evidence", `${item.id}.txt`), "utf8");
        assert.equal((evidence.match(/^=== /gm) ?? []).length, 1, "没有重新实测");
      }
      assert.doesNotMatch(summary, /No project session found/);
      assert.match(summary, /未重新实测/);
      assert.deepEqual(readProcs(h.procsFile), [], "验收方及子进程已按归属清理");
      assert.deepEqual(JSON.parse(readFileSync(join(record.runDir, "result.json"), "utf8")), record);
    } finally { h.close(); }
  });
});

test("断线：无证据不空跑强模型，补判胡报/摘录不符不能通过，补报告再挂住也有界", async (t) => {
  for (const [mode, recoveryMode] of [["stall-empty", ""], ["stall-partial", "invent"], ["stall-all", "bad-excerpt"], ["stall-all", "hang"]]) {
    await t.test(`${mode}/${recoveryMode}`, async () => {
      const h = await harness({ idleTimeoutSec: 1 }, { AUTOREVIEW_ACCEPTANCE_CMD: STALLED_TESTER, FAKE_ACC_MODE: mode, FAKE_RECOVERY_MODE: recoveryMode });
      try {
        const start = Date.now(), stage = await runAcceptanceStage(h.deps());
        assert.equal(stage.kind, "judged"); if (stage.kind !== "judged") return;
        assert.equal(stage.record.verdict, "无法验收");
        assert.ok(Date.now() - start < 6000);
        if (recoveryMode === "invent") {
          assert.equal(stage.record.items[0].verdict, "通过");
          assert.equal(stage.record.items[1].verdict, "无法验证", "不能使用补报告期间新写的证据");
        } else assert.ok(stage.record.items.every((item) => item.verdict === "无法验证"));
        assert.equal(h.calls().length, mode === "stall-empty" ? 1 : 2);
        assert.ok(stage.record.items.filter((item) => item.verdict === "无法验证").every((item) => item.detail.trim().length > 15));
        assert.deepEqual(readProcs(h.procsFile), []);
      } finally { h.close(); }
    });
  }
});

test("断线：剩余预算不足时不补报告，有效检查点照常按证据判定，其余写明断线和预算原因", async () => {
  const h = await harness({ idleTimeoutSec: 3 }, { AUTOREVIEW_ACCEPTANCE_CMD: STALLED_TESTER, FAKE_ACC_MODE: "stall-checkpoint" });
  try {
    const runDir = join(h.root, "acc", "r1");
    const stage = await runAcceptanceStage(h.deps({ now: () => Date.now() + (existsSync(join(runDir, "last-action")) ? 270_000 : 0) }));
    assert.equal(stage.kind, "judged"); if (stage.kind !== "judged") return;
    assert.equal(stage.record.items[0].verdict, "通过");
    assert.equal(stage.record.items[1].verdict, "无法验证");
    assert.match(stage.record.items[1].detail, /验收方模型断线.*剩余验收预算不足/);
    assert.equal(stage.record.recovery?.attempted, false);
    assert.equal(h.calls().length, 1);
  } finally { h.close(); }
});

test("断线：模型退出也能补判，已有证据显示产品失败时仍不通过", async () => {
  const h = await harness({}, { AUTOREVIEW_ACCEPTANCE_CMD: STALLED_TESTER, FAKE_ACC_MODE: "disconnect-all", FAKE_ACC_FAIL: "A2" });
  try {
    const stage = await runAcceptanceStage(h.deps());
    assert.equal(stage.kind, "judged"); if (stage.kind !== "judged") return;
    assert.deepEqual(stage.record.items.map((item) => item.verdict), ["通过", "不通过"]);
    assert.equal(stage.record.verdict, "不通过");
    assert.equal(h.calls().length, 2);
    assert.doesNotMatch(acceptanceSummary(stage.record), /No project session found/);
  } finally { h.close(); }
});

test("断线：补报告明确使用 strongModel、独立会话、仅 read，不给实测工具", async () => {
  const h = await harness({ strongModel: "provider/strong" });
  try {
    const calls: string[][] = [];
    const externalScript = join(h.root, "outside-step.py");
    let time = Date.now();
    const stage = await runAcceptanceStage(h.deps({ config: { ...h.config, testerCmd: "" }, deadline: time + 120_000, now: () => time, exec: async (_command, args, options) => {
      calls.push(args);
      assert.ok(args.includes("--session-dir"));
      assert.ok(args.includes(ACCEPTANCE_EVENTS_PATH), "普通实测和只读补判都要订阅即时工具生命周期");
      if (calls.length === 1) {
        writeFileSync(externalScript, "print('观察到了 A1')");
        const sessionDir = args[args.indexOf("--session-dir") + 1];
        writeFileSync(join(sessionDir, "session.jsonl"), [
          JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "write-1", name: "write", arguments: { path: externalScript } }] } }),
          JSON.stringify({ type: "message", message: { role: "toolResult", toolCallId: "write-1", toolName: "write", isError: false } }),
        ].join("\n"));
        for (const { id } of criteriaItems) writeFileSync(join(options.cwd, "evidence", `${id}.txt`), block(id, `观察到了 ${id}`).replace("$ todo", `$ sh -c 'python3 ${externalScript}'`));
        time += 10_000;
        return { stdout: "", stderr: "Connection error", code: 1, killed: false, processesReleased: true };
      }
      assert.equal(options.timeout, 110_000, "补判只能使用本轮剩余预算");
      assert.equal(args[args.indexOf("--model") + 1], "provider/strong");
      assert.equal(args[args.indexOf("--tools") + 1], "read");
      assert.ok(args.includes("--no-mcp"));
      assert.ok(args.includes(RECOVERY_PROMPT_PATH));
      assert.match(args[args.indexOf("--session-id") + 1], /acc-report/);
      return { stdout: "## 逐条结果\nA1：通过\n- 证据摘录：观察到了 A1\nA2：通过\n- 证据摘录：观察到了 A2", stderr: "", code: 0, killed: false, processesReleased: true };
    } }));
    assert.equal(stage.kind, "judged");
    if (stage.kind === "judged") {
      assert.equal(stage.record.verdict, "通过");
      assert.deepEqual(stage.record.items[0].execution?.scripts, [externalScript], "临时目录外的自写脚本也从本轮成功 write 记录关联，不能漏报");
    }
    assert.equal(calls.length, 2);
    const parsed = parseAcceptanceReport(readFileSync(RECOVERY_PROMPT_PATH, "utf8"));
    assert.ok(parsed.ok); if (parsed.ok) assert.deepEqual(parsed.report.items.map((item) => item.verdict), ["通过", "不通过", "无法验证"]);
  } finally { h.close(); }
});

test("空闲检测：输出、会话记录、证据三种活动分别刷新时限；外部取消不触发补报告", async (t) => {
  for (const source of ["output", "session", "evidence", "cancel"]) await t.test(source, async () => {
    const h = await harness({ idleTimeoutSec: 1 });
    const abort = new AbortController();
    try {
      let calls = 0;
      const stage = await runAcceptanceStage(h.deps({ config: { ...h.config, testerCmd: "" }, signal: abort.signal, exec: async (_command, args, options) => {
        calls += 1;
        assert.equal(calls, 1, "活跃调用不应被误判挂住，取消也不补判");
        const sessionDir = args[args.indexOf("--session-dir") + 1];
        const pulse = (): void => {
          if (source === "output") options.onOutput?.("tool activity\n");
          if (source === "session") writeFileSync(join(sessionDir, "session.jsonl"), String(Date.now()));
          if (source === "evidence") writeFileSync(join(options.cwd, "evidence", "A1.txt"), block("A1", String(Date.now())));
        };
        const timer = setInterval(pulse, 200);
        try {
          if (source === "cancel") {
            abort.abort();
            assert.equal(options.signal?.aborted, true);
            return { stdout: "", stderr: "", code: 137, killed: true, processesReleased: true };
          }
          await new Promise((resolve) => setTimeout(resolve, 1800));
          assert.equal(options.signal?.aborted, false);
          for (const { id } of criteriaItems) writeFileSync(join(options.cwd, "evidence", `${id}.txt`), block(id, "已完成"));
          return { stdout: "## 逐条结果\nA1：通过\n- 证据摘录：已完成\nA2：通过\n- 证据摘录：已完成", stderr: "", code: 0, killed: false, processesReleased: true };
        } finally { clearInterval(timer); }
      } }));
      assert.equal(stage.kind, "judged");
      if (stage.kind === "judged") assert.equal(stage.record.recovery, undefined);
      assert.equal(calls, 1);
    } finally { h.close(); }
  });
});

test("断线 A3：被测命令真超时仍按实测失败判定，系统未就绪仍是 G1 不通过", async () => {
  const h = await harness({}, { AUTOREVIEW_ACCEPTANCE_CMD: STALLED_TESTER, FAKE_ACC_MODE: "system-timeout" });
  try {
    const stage = await runAcceptanceStage(h.deps());
    assert.equal(stage.kind, "judged"); if (stage.kind !== "judged") return;
    assert.equal(stage.record.verdict, "不通过");
    assert.ok(stage.record.items.every((item) => item.verdict === "不通过"));
    assert.equal(stage.record.recovery, undefined);
    assert.equal(h.calls().length, 1);
    const notReady = await runAcceptanceStage(h.deps({ config: { ...h.config, start: "sleep 30", readyLog: "never ready", readyTimeoutSec: 1 } }));
    assert.equal(notReady.kind, "judged"); if (notReady.kind !== "judged") return;
    assert.equal(notReady.record.items[0].id, "G1");
    assert.equal(notReady.record.items[0].verdict, "不通过");
    assert.match(notReady.record.items[0].detail, /秒内没有就绪/);
    assert.equal(h.calls().length, 1, "系统超时不启动模型补判");
  } finally { h.close(); }
});

test("验收预算／等待实测时整轮预算仍生效，中止不归为模型断线且不补判", async () => {
  const h = await harness({ idleTimeoutSec: 1 });
  try {
    let now = Date.now(), calls = 0;
    const stage = await runAcceptanceStage(h.deps({ config: { ...h.config, testerCmd: "" }, now: () => now, deadline: now + 60_000,
      exec: async (_command, args, options) => {
        calls += 1;
        assert.equal(options.timeout, 60_000, "执行器拿到的仍是整轮剩余预算，不因等待动作扩充");
        const session = join(args[args.indexOf("--session-dir") + 1], "session.jsonl");
        writeFileSync(session, JSON.stringify({ type: "message", timestamp: new Date().toISOString(), message: { role: "assistant", content: [
          { type: "toolCall", id: "waiting-command", name: "bash", arguments: { command: "long command", timeout: 30 } },
        ] } }) + "\n");
        await new Promise((resolve) => setTimeout(resolve, 1400));
        assert.equal(options.signal?.aborted, false, "实测在执行时不能先被 1 秒模型空闲阈值中止");
        // 用虚拟整轮时钟模拟执行器预算耗尽；不依赖 Node 替身在 CPU 竞争时能否在 1 秒内启动。
        now += 60_000;
        return { stdout: "", stderr: "", code: 137, killed: true, processesReleased: true };
      } }));
    assert.equal(stage.kind, "judged"); if (stage.kind !== "judged") return;
    assert.equal(stage.record.verdict, "无法验收");
    assert.match(stage.record.reason!, /被测命令或验收工具仍在执行.*整轮预算/);
    assert.equal(stage.record.recovery, undefined);
    assert.equal(stage.record.durationMs, 60_000);
    assert.equal(calls, 1);
    assert.deepEqual(readProcs(h.procsFile), []);
  } finally { h.close(); }
});

test("验收归因／工具刚结束、下一次轮询前模型断线，须按最新生命周期补判", async (t) => {
  for (const notifyStop of [false, true]) await t.test(notifyStop ? "执行器通知终止边界" : "结果返回边界兜底", async () => {
    const h = await harness({ idleTimeoutSec: 1 });
    try {
      let calls = 0;
      const stage = await runAcceptanceStage(h.deps({ config: { ...h.config, testerCmd: "" }, exec: async (_command, _args, options) => {
        calls += 1;
        if (calls === 1) {
          const call = readFileSync(join(options.cwd, "call-id"), "utf8");
          recordToolActivity(options.cwd, call, { type: "tool_execution_start", toolCallId: "just-finished", toolName: "bash" });
          // 空闲阈值为1秒，轮询间隔为250ms：先让一次轮询观察到在途工具。
          await new Promise((resolve) => setTimeout(resolve, 300));
          assert.equal(options.signal?.aborted, false);
          for (const { id } of criteriaItems) writeFileSync(join(options.cwd, "evidence", `${id}.txt`), block(id, "已完成"));
          recordToolActivity(options.cwd, call, { type: "tool_execution_end", toolCallId: "just-finished", toolName: "bash" });
          if (notifyStop) options.onBeforeStop?.();
          // 同一个微任务中立即返回，不给下一次轮询修正旧缓存的机会。
          return { stdout: "", stderr: "Connection error", code: 1, killed: false, processesReleased: true };
        }
        assert.equal(calls, 2, "只补一次报告，不重新实测");
        assert.ok(_args.includes(RECOVERY_PROMPT_PATH));
        return { stdout: "## 逐条结果\nA1：通过\n- 证据摘录：已完成\nA2：通过\n- 证据摘录：已完成", stderr: "", code: 0, killed: false, processesReleased: true };
      } }));
      assert.equal(stage.kind, "judged"); if (stage.kind !== "judged") return;
      assert.equal(stage.record.verdict, "通过", JSON.stringify(stage.record));
      assert.equal(stage.record.recovery?.attempted, true);
      assert.equal(calls, 2);
      assert.doesNotMatch(acceptanceSummary(stage.record), /不是验收方模型断线|被测命令或验收工具仍在执行/);
      for (const id of ["A1", "A2"]) assert.equal((readFileSync(join(stage.record.runDir, "evidence", `${id}.txt`), "utf8").match(/^=== /gm) ?? []).length, 1);
    } finally { h.close(); }
  });
});

test("验收归因／预算中止前工具确实在执行，清理后进程和标记消失也不能改判为模型断线", async () => {
  const h = await harness({ idleTimeoutSec: 1 });
  let tool: ReturnType<typeof spawn> | undefined;
  try {
    let now = Date.now(), calls = 0;
    const stage = await runAcceptanceStage(h.deps({ config: { ...h.config, testerCmd: "" }, now: () => now, deadline: now + 60_000,
      exec: async (_command, _args, options) => {
        calls += 1;
        assert.equal(calls, 1, "预算中止不得补判");
        tool = spawn(process.execPath, ["-e", "setTimeout(()=>{},30000)"], { detached: true, stdio: "ignore" });
        const call = readFileSync(join(options.cwd, "call-id"), "utf8"), dir = join(options.cwd, "active-actions", call);
        mkdirSync(dir, { recursive: true });
        const action = join(dir, "running.json");
        writeFileSync(action, JSON.stringify({ call, pid: tool.pid, started: processStartTime(tool.pid!) }));
        await new Promise((resolve) => setTimeout(resolve, 100));
        now += 60_000;
        options.onBeforeStop?.();
        const closed = new Promise<void>((resolve) => tool!.once("close", () => resolve())); tool.kill("SIGKILL"); await closed;
        rmSync(action);
        // 模拟执行器可能重复通知：第二次已处在清理之后，不能覆盖第一次的中止现场。
        options.onBeforeStop?.();
        return { stdout: "", stderr: "", code: 137, killed: true, processesReleased: true };
      } }));
    assert.equal(stage.kind, "judged"); if (stage.kind !== "judged") return;
    assert.equal(stage.record.verdict, "无法验收");
    assert.match(stage.record.reason!, /被测命令或验收工具仍在执行.*整轮预算/);
    assert.equal(stage.record.recovery, undefined);
    assert.equal(calls, 1);
  } finally {
    if (tool?.exitCode === null && !tool.signalCode) {
      const closed = new Promise<void>((resolve) => tool!.once("close", () => resolve())); tool.kill("SIGKILL"); await closed;
    }
    h.close();
  }
});
