import assert from "node:assert/strict";
import test from "node:test";
import { parseDeploymentConfig } from "../config.ts";
import { stopQueueBatch } from "../merge-queue.ts";
import { fixture } from "./helpers/merge-queue-fixture.ts";
test("部署配置保留：默认关闭，启用必须有 cmd/check，时限为正整数", () => {
  assert.equal(parseDeploymentConfig(undefined).enabled, false);
  for (const c of [{ enabled: true }, { enabled: true, cmd: "true" }, { enabled: true, cmd: "true", check: "true", timeoutMin: 0 }]) assert.throws(() => parseDeploymentConfig(c));
  assert.equal(parseDeploymentConfig({ enabled: true, cmd: "deploy", check: "health", timeoutMin: 1 }).enabled, true);
});
test("历史待执行/在途部署只可安全取消，不再触发检查或自动回退；副作用未知单列", () => {
  const f = fixture(); try { for (const status of ["waiting", "deploying", "checking", "rolling-back"] as const) { f.history.entries[0].status = "merged"; f.history.entries[0].deployment = { status, config: { enabled: true, cmd: "must-not-run", check: "must-not-run", timeoutMin: 1 } }; f.saveHistory(); const before = f.bytes(); const preview = stopQueueBatch(f.repo, f.history.batches[0], true); assert.equal(preview.deployments[0].inFlight, status !== "waiting"); assert.deepEqual(f.bytes(), before); stopQueueBatch(f.repo, f.history.batches[0]); assert.equal(f.read().entries[0].deployment!.status, status === "waiting" ? "stopped" : "blocked"); f.refuse("续跑"); } } finally { f.close(); }
});
