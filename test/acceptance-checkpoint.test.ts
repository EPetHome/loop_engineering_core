/** acceptance／checkpoint：按功能独立运行，夹具与状态不跨测试进程共享。 */
/** 自动验收：纯函数（取标准、解析、判定、消息）与一轮验收流程（真起被测系统）；产物只写 os.tmpdir()。 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { judgeAcceptance, mergeAcceptanceReports } from "../acceptance-core.ts";
import { runAcceptanceStage } from "../acceptance.ts";
import { block, harness } from "./helpers/acceptance-fixture.ts";

test("A32 中断保留逐条显式结果，未完成条目不冒充通过；新重验不读旧检查点", async () => {
  const h = await harness({}, { FAKE_ACC_MODE: "checkpoint" });
  try {
    let now = Date.now();
    const deps = h.deps();
    const exec = deps.exec;
    deps.now = () => now;
    deps.deadline = now + 120_000;
    deps.exec = async (command, args, options) => {
      const result = await exec(command, args, options);
      if (options.role === "验收方") { now += 120_000; return { ...result, killed: true }; }
      return result;
    };
    const outcome = await runAcceptanceStage(deps);
    assert.equal(outcome.kind, "judged");
    if (outcome.kind !== "judged") return;
    assert.equal(outcome.record.items.find((i) => i.id === "A1")?.verdict, "通过");
    assert.equal(outcome.record.items.find((i) => i.id === "A2")?.verdict, "无法验证");
    assert.equal(outcome.record.verdict, "无法验收");
    assert.equal(h.calls().length, 1);
    assert.ok(existsSync(join(outcome.record.runDir, "checkpoints", readFileSync(join(outcome.record.runDir, "call-id"), "utf8"), "A1.json")));
    const next = h.deps(); next.config = { ...next.config, testerCmd: "" };
    next.exec = async () => ({ stdout: "bad report", stderr: "", code: 0, killed: false, processesReleased: true });
    const retried = await runAcceptanceStage(next);
    assert.equal(retried.kind, "judged");
    if (retried.kind === "judged") {
      assert.notEqual(retried.record.runDir, outcome.record.runDir);
      assert.ok(retried.record.items.every((i) => i.verdict !== "通过"));
    }
  } finally { h.close(); }
});

test("A35 更正的新检查点覆盖旧报告；未重跑条目保留，同次矛盾不能放行", async (t) => {
  const duplicate = mergeAcceptanceReports(undefined, { conclusion: "通过", extra: [], items: [
    { id: "A1", verdict: "不通过", fields: { "证据摘录": "observed" } },
    { id: "A1", verdict: "通过", fields: { "证据摘录": "observed" } },
  ] });
  assert.equal(judgeAcceptance({ criteria: [{ id: "A1", text: "检查" }], report: duplicate, evidence: () => block("A1", "observed"), logErrors: [], runDir: "/run", hasService: false }).verdict, "无法验收");
  for (const mode of ["checkpoint-regression", "checkpoint-complete", "checkpoint-conflict"]) await t.test(mode, async () => {
    const h = await harness({}, { FAKE_ACC_MODE: mode });
    try {
      const outcome = await runAcceptanceStage(h.deps());
      assert.equal(outcome.kind, "judged"); if (outcome.kind !== "judged") return;
      const record = outcome.record, a1 = record.items.find((item) => item.id === "A1")!;
      if (mode === "checkpoint-regression") {
        assert.equal(record.verdict, "不通过"); assert.equal(a1.verdict, "不通过"); assert.equal(h.calls().length, 2);
        const input = join(record.runDir, "late.json"); writeFileSync(input, JSON.stringify({ verdict: "通过", fields: { "证据摘录": "看到了 A1" } }));
        const late = spawnSync(join(record.runDir, "result"), ["A1", input], { cwd: record.runDir, env: { ...process.env, AUTOREVIEW_ACCEPTANCE_CALL: "00000000-0000-0000-0000-000000000000" }, encoding: "utf8" });
        assert.equal(late.status, 1); assert.match(late.stderr, /过期或无效/);
      } else if (mode === "checkpoint-complete") {
        assert.equal(record.verdict, "通过"); assert.equal(a1.verdict, "通过"); assert.equal(h.calls().length, 2);
        assert.doesNotMatch(readFileSync(join(record.runDir, "evidence", "A1.txt"), "utf8"), /#2 /, "A1 的有效结果可复用，未重跑动作");
      } else {
        assert.equal(record.verdict, "无法验收"); assert.equal(a1.verdict, "无法验证");
        assert.match(a1.detail, /结论冲突/); assert.equal(h.calls().length, 3);
      }
    } finally { h.close(); }
  });
});
