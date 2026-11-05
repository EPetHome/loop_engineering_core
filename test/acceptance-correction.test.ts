/** 验收／格式更正与强模型重验；真实替身调用，数据重置和证据复用不降级。 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { runAcceptanceStage } from "../acceptance.ts";
import { harness } from "./helpers/acceptance-fixture.ts";

test("验收／格式更正与强模型重验：同会话更正、换模型、标准冻结及重置复用", async (t) => {
  for (const scenario of ["同会话更正", "强模型仍失败", "强模型救回", "重置后更正"] as const) await t.test(scenario, async () => {
    const reset = scenario === "重置后更正", garbage = scenario === "强模型仍失败" || scenario === "强模型救回";
    const h = await harness(reset ? {
      start: "node server.mjs {port}", readyUrl: "http://127.0.0.1:{port}/health",
      reset: 'echo 重置 >> "$AUTOREVIEW_RUN_DIR/reset-count"; echo "ERROR 重置时打的不算系统错误 $RESET_FLAG"',
      env: { RESET_FLAG: "ENV_OK" },
    } : {}, { FAKE_ACC_MODE: garbage ? "garbage" : "lazy", ...(scenario === "强模型救回" ? { FAKE_ACC_STRONG: "pass" } : {}) });
    try {
      if (scenario === "强模型仍失败") h.state.requirement = "做一个待办命令行";
      const stage = await runAcceptanceStage(h.deps());
      assert.equal(stage.kind, "judged"); if (stage.kind !== "judged") return;
      const { record } = stage, calls = h.calls();
      assert.equal(record.verdict, scenario === "强模型仍失败" ? "无法验收" : "通过");
      assert.equal(calls.length, garbage ? 3 : 2);
      if (garbage) {
        assert.equal(record.escalated, true);
        assert.match(calls[2].split("\t")[2], /^autoreview-acc-strong-/, "换强模型另开会话");
        if (scenario === "强模型救回") assert.match(readFileSync(join(record.runDir, "strong.md"), "utf8"), /上一位验收方没按要求/);
        else {
          assert.equal(record.blocker, "验收方"); assert.match(record.items[0].detail, /无法解析/);
          assert.equal(h.state.criteria?.source, "自动起草"); assert.equal(h.state.criteria?.items.length, 2);
          const again = await runAcceptanceStage(h.deps({ round: 2, runDir: join(h.root, "acc", "r2") }));
          assert.equal(again.kind, "judged");
          assert.equal(readFileSync(join(h.root, "fake", "draft-calls.log"), "utf8").trim().split("\n").length, 1, "冻结后不再起草");
        }
      } else {
        assert.match(calls[1], /correction\.md/);
        assert.equal(calls[0].split("\t")[2], calls[1].split("\t")[2], "格式更正在同一会话");
        const correction = readFileSync(join(record.runDir, "correction.md"), "utf8");
        assert.match(correction, /A1：原因：报告「通过」，但没有用/);
        if (reset) {
          assert.equal(readFileSync(join(record.runDir, "reset-count"), "utf8").trim().split("\n").length, 1);
          const resetLog = readFileSync(join(record.runDir, "reset.log"), "utf8");
          assert.doesNotMatch(resetLog, /重做前/); assert.match(resetLog, /ENV_OK/);
          assert.doesNotMatch(readFileSync(join(record.runDir, "system.log"), "utf8"), /重置时打的/);
          assert.match(correction, /已经留对的证据不用重跑/);
          assert.match(readFileSync(join(record.runDir, "input.md"), "utf8"), /首次验收和换强模型重验前已把数据重置到初始状态/);
        }
      }
    } finally { h.close(); }
  });
});
