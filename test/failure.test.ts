/** 历史失败片段归因回归；不读取本机历史、不依赖模型或外部服务。 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { classifyFailure, classifyTesterFailure, testerDiagnostics } from "../failure.ts";
import { classifySystemExit, judgeAcceptance } from "../acceptance-core.ts";

const history = JSON.parse(readFileSync(new URL("./fixtures/failure-history.json", import.meta.url), "utf8"));

test("历史归因样本覆盖产品、环境、方法、验收方断线、被测系统被关掉", () => {
  assert.deepEqual(history.samples.map((s: { category: string }) => s.category).sort(),
    ["environment", "method", "product", "system-stopped", "tester-disconnected"]);
  for (const sample of history.samples) {
    assert.match(sample.source, /^~\/\.pi-autoreview\//);
    assert.match(sample.sourceSha256, /^[a-f0-9]{64}$/);
    assert.ok(sample.output?.length < 1200 || sample.detail?.length < 1200);
    assert.doesNotMatch(JSON.stringify(sample), /\/Users\/|\/var\/folders\/|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/);
  }
});

for (const sample of history.samples) test(`历史归因：${sample.category}`, () => {
  if (sample.type === "command") {
    assert.equal(classifyFailure(sample.code, sample.output).kind, sample.expected);
    // 方法样本同时固定显式标记的行为，避免只靠 78 碰巧通过。
    if (sample.category === "method") assert.equal(classifyFailure(1, sample.output).kind, "method");
  } else if (sample.type === "tester") {
    const failure = classifyTesterFailure(sample.code, sample.output, sample.interrupted);
    assert.equal(failure.kind, sample.expected);
    assert.equal(failure.disconnected, true);
    assert.match(failure.reason, /验收方模型断线/);
    assert.equal(testerDiagnostics(sample.output), "");
    const record = judgeAcceptance({ criteria: [{ id: "A1", text: "操作：实测\n预期：符合标准" }],
      evidence: () => undefined, logErrors: [], runDir: "/run", hasService: true, testerDisconnected: failure.reason });
    assert.equal(record.blocker, "验收方模型断线");
    assert.match(record.items[0].detail, /验收方模型断线.*未留下该条的有效实测证据/);
    assert.doesNotMatch(JSON.stringify(record), /No project session found|系统崩溃|被测系统超时/);
  } else {
    assert.equal(classifySystemExit(sample.exit, sample.logErrors), sample.expected);
    const record = judgeAcceptance({ criteria: [{ id: "A1", text: "操作：访问系统\n预期：正常" }],
      evidence: () => undefined, logErrors: sample.logErrors, runDir: "/run", hasService: true,
      systemStopped: { at: 1, detail: sample.detail } });
    assert.equal(record.verdict, "无法验收");
    assert.equal(record.blocker, "系统被关掉");
    assert.equal(record.items[0].cause, "系统被关掉");
    assert.ok(record.items.every((item) => item.verdict === "无法验证"));
  }
});

test("验收方故障不混入产品：限流、无活动、退出信号；资源释放故障优先且保留具体原因", () => {
  for (const [code, output, interrupted, stalled] of [
    [1, "Connection error", false, false], [1, "Request timed out", false, false],
    [1, "HTTP 429 Too many requests", false, false], [143, "", false, false],
    [137, "", true, true],
  ] as const) {
    const failure = classifyTesterFailure(code, output, interrupted, stalled);
    assert.equal(failure.disconnected, true);
    assert.notEqual(failure.kind, "product");
  }
  const cleanup = classifyTesterFailure(75, "AUTOREVIEW_FAILURE=environment 子进程释放未确认，登记已保留", true, true);
  assert.equal(cleanup.disconnected, undefined, "释放失败不能触发掩盖错误的补判");
  assert.equal(cleanup.kind, "environment");
  assert.match(cleanup.reason, /子进程释放未确认/);
  const unknown = classifyTesterFailure(1, "Warning: No project session found with id 'example'; creating a new session with that id.\nopaque failure");
  assert.equal(unknown.kind, "unknown");
  assert.match(unknown.reason, /opaque failure/);
  assert.doesNotMatch(unknown.reason, /No project session found/);
  assert.equal(classifySystemExit({ code: 1, signal: null }, ["ERROR crash"]), "崩溃");
});
