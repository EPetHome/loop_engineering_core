/** acceptance／tools：按功能独立运行，夹具与状态不跨测试进程共享。 */
/** 自动验收：纯函数（取标准、解析、判定、消息）与一轮验收流程（真起被测系统）；产物只写 os.tmpdir()。 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { runAcceptanceStage } from "../acceptance.ts";
import { readProcs } from "../procs.ts";
import { STALLED_TESTER, PARALLEL_TESTER, criteriaItems, block, harness } from "./helpers/acceptance-fixture.ts";

test("验收工具／1秒空闲阈值不能截断等待3秒超时的实测命令", async () => {
  const h = await harness({ idleTimeoutSec: 1 }, { AUTOREVIEW_ACCEPTANCE_CMD: STALLED_TESTER, FAKE_ACC_MODE: "system-timeout", FAKE_COMMAND_TIMEOUT: "3" });
  try {
    const deps = h.deps(), execute = deps.exec;
    deps.exec = async (command, args, options) => {
      // 按 Pi 的真实顺序：先持久化 bash toolCall，再启动执行后端。Node 冷启动本身也是这次工具执行的一部分。
      const session = join(options.cwd, "tester-sessions", "tester", "session.jsonl");
      writeFileSync(session, JSON.stringify({ type: "message", timestamp: new Date().toISOString(), message: { role: "assistant", content: [
        { type: "toolCall", id: "real-ev-commands", name: "bash", arguments: { command: "run two ./ev --timeout 3 commands", timeout: 30 } },
      ] } }) + "\n");
      try { return await execute(command, args, options); }
      finally { writeFileSync(session, JSON.stringify({ type: "message", message: { role: "toolResult", toolCallId: "real-ev-commands" } }) + "\n", { flag: "a" }); }
    };
    const stage = await runAcceptanceStage(deps);
    assert.equal(stage.kind, "judged"); if (stage.kind !== "judged") return;
    assert.equal(stage.record.verdict, "不通过", JSON.stringify(stage.record));
    assert.ok(stage.record.items.every((item) => item.verdict === "不通过" && /ETIMEDOUT|被终止/.test(item.detail)));
    assert.equal(stage.record.recovery, undefined, "被测命令超时不是模型断线");
    assert.equal(h.calls().length, 1, "不启动补判，也不重做实测");
    assert.ok(stage.record.durationMs >= 6000, "两条三秒超时命令均走完自己的超时与证据输出");
  } finally { h.close(); }
});

test("验收工具／直接 bash 工具等待不算模型空闲；工具结束后真正模型挂住仍及时补判", async () => {
  const h = await harness({ idleTimeoutSec: 1 });
  try {
    let calls = 0, finishedAt = 0;
    const stage = await runAcceptanceStage(h.deps({ config: { ...h.config, testerCmd: "" }, exec: async (_command, args, options) => {
      calls += 1;
      if (calls === 1) {
        const session = join(args[args.indexOf("--session-dir") + 1], "session.jsonl");
        writeFileSync(session, JSON.stringify({ type: "message", timestamp: new Date().toISOString(), message: { role: "assistant", content: [
          { type: "toolCall", id: "bash-in-flight", name: "bash", arguments: { command: "sleep 2", timeout: 3 } },
        ] } }) + "\n");
        await new Promise((resolve) => setTimeout(resolve, 1800));
        assert.equal(options.signal?.aborted, false);
        writeFileSync(session, JSON.stringify({ type: "message", message: { role: "toolResult", toolCallId: "bash-in-flight" } }) + "\n", { flag: "a" });
        for (const { id } of criteriaItems) writeFileSync(join(options.cwd, "evidence", `${id}.txt`), block(id, "已完成"));
        finishedAt = Date.now();
        return new Promise((resolve) => options.signal?.addEventListener("abort", () => resolve({ stdout: "", stderr: "", code: 137, killed: true, processesReleased: true }), { once: true }));
      }
      assert.ok(Date.now() - finishedAt < 2500, "实测完成之后，模型空闲时限重新生效");
      return { stdout: "## 逐条结果\nA1：通过\n- 证据摘录：已完成\nA2：通过\n- 证据摘录：已完成", stderr: "", code: 0, killed: false, processesReleased: true };
    } }));
    assert.equal(stage.kind, "judged"); if (stage.kind !== "judged") return;
    assert.equal(stage.record.verdict, "通过");
    assert.equal(calls, 2);
    assert.equal(stage.record.recovery?.attempted, true);
  } finally { h.close(); }
});

test("验收工具／同批快慢工具并行，快工具5秒上限不截断20秒慢工具，延迟落盘后仍完整留证通过", async () => {
  const h = await harness({ idleTimeoutSec: 1 }, { AUTOREVIEW_ACCEPTANCE_CMD: PARALLEL_TESTER });
  try {
    h.state.requirement = "并行验收\n## 验收标准\nA1. 操作：执行快命令\n   预期：输出 A1_OK\nA2. 操作：执行20秒慢命令，时限30秒\n   预期：输出 A2_OK";
    const stage = await runAcceptanceStage(h.deps());
    assert.equal(stage.kind, "judged"); if (stage.kind !== "judged") return;
    assert.equal(stage.record.verdict, "通过", JSON.stringify(stage.record));
    assert.ok(stage.record.items.every((item) => item.verdict === "通过"));
    assert.equal(stage.record.recovery, undefined, "并行等待不是模型断线，不得补判或重跑");
    assert.equal(h.calls().length, 1);
    assert.ok(stage.record.durationMs >= 20_000 && stage.record.durationMs < 60_000);
    const ends: string[][] = readFileSync(join(stage.record.runDir, "ends.log"), "utf8").trim().split("\n").map((line: string) => line.split("\t"));
    assert.deepEqual(ends.map(([id]) => id), ["A1", "A2"]);
    assert.ok(Number(ends[1][1]) - Number(ends[0][1]) >= 15_000, "快工具已结束，但其 toolResult 仍须等待慢工具结束才能落盘");
    const messages = readFileSync(join(stage.record.runDir, "tester-sessions", "tester", "parallel.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const fastResult = messages.find((entry) => entry.message?.role === "toolResult" && entry.message.toolCallId === "A1");
    assert.ok(Date.parse(fastResult.timestamp) >= Number(ends[1][1]), "确实覆盖快工具结果延迟到整批结束才持久化的顺序");
    for (const id of ["A1", "A2"]) assert.match(readFileSync(join(stage.record.runDir, "evidence", `${id}.txt`), "utf8"), new RegExp(`${id}_OK`));
    assert.deepEqual(readProcs(h.procsFile), []);
  } finally { h.close(); }
});
