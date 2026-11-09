/** 历史失败片段归因回归；不读取本机历史、不依赖模型或外部服务。 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { classifyFailure, classifyTesterFailure, recoveryDecision, testerDiagnostics } from "../failure.ts";
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

test("准备/测试共用补装规则：只有明确 method 声明跳过，引用和推断不授予跳过资格", () => {
  const config = { recover: "install", maxRecoveries: 2 };
  for (const output of ["Error: Cannot find module 'core'", "opaque failure", "AssertionError: product failed", "AUTOREVIEW_FAILURE=product broken", "```text\nAUTOREVIEW_FAILURE=method example\n```\nopaque failure", "> AUTOREVIEW_FAILURE=method quote\nopaque failure"]) {
    assert.equal(recoveryDecision(1, output, config, 1).allowed, true, output);
  }
  for (const [code, output] of [[78, "opaque failure"], [1, "AUTOREVIEW_FAILURE=method broken"], [75, "AUTOREVIEW_FAILURE=method broken\nError: ENOSPC"]] as const) {
    assert.deepEqual(recoveryDecision(code, output, config, 1), { allowed: false, reason: "项目声明方法错误，未补装", remaining: 1 });
  }
  assert.equal(recoveryDecision(1, "opaque", undefined, 0).reason, "未配置 recover，未补装");
  assert.deepEqual(recoveryDecision(1, "opaque", config, 2), { allowed: false, reason: "补装次数用完，未补装", remaining: 0 });
});

test("ENOSPC 只在通过名/标题里出现：真实产品断言与显式 product 不被吞掉", () => {
  for (const passed of [
    "ok 1 - ENOSPC 故障时保留证据", "# Subtest: ENOSPC 故障时保留证据\nok 1 - ENOSPC",
    "test_ENOSPC_retains_evidence (StorageTests) ... ok", "PASS ENOSPC 故障时保留证据", "✓ ENOSPC fixture",
    "ok 1 - mc: Storage backend has reached its minimum free drive threshold",
  ]) {
    const assertion = classifyFailure(1, `${passed}\nAssertionError: expected 2, got 1`);
    assert.equal(assertion.kind, "product", passed); assert.doesNotMatch(assertion.reason, /存储空间不足/);
    assert.equal(classifyFailure(1, `${passed}\nAUTOREVIEW_FAILURE=product 真实业务断言失败`).kind, "product", passed);
    assert.equal(classifyFailure(1, `${passed}\nopaque failure`).kind, "unknown", "通过名及模糊失败不是当前故障证据");
  }
});

test("真实 ENOSPC/存储错误优先于衍生断言，错误行及冲突声明保留", () => {
  for (const error of [
    "Error: ENOSPC: no space left on device, write '/tmp/report.json'", "Error: ENOSPC",
    "Error [ENOSPC]: write failed", "# Error: ENOSPC: no space left on device, write",
    "OSError: [Errno 28] No space left on device: '/tmp/report.json'",
    "npm ERR! code ENOSPC", "write failed: ENOSPC", "sh: 1: cannot create /tmp/report: No space left on device",
    "mc: Storage backend has reached its minimum free drive threshold",
  ]) {
    const output = `${error}\nAssertionError: evidence file is missing\nAUTOREVIEW_FAILURE=product 衍生断言失败`;
    const failure = classifyFailure(1, output);
    assert.equal(failure.kind, "environment", error); assert.match(failure.reason, /有效故障行/); assert.match(failure.reason, /冲突声明.*AUTOREVIEW_FAILURE=product/);
    assert.ok(failure.reason.includes(error.replace(/^# /, "")), failure.reason);
  }
});

test("声明/有效证据相矛盾时未知，不以任一文本猜产品责任", () => {
  const cases = [
    [1, "AUTOREVIEW_FAILURE=product 业务失败\nModuleNotFoundError: No module named runner", ["AUTOREVIEW_FAILURE=product", "ModuleNotFoundError"]],
    [1, "AUTOREVIEW_FAILURE=method 检查入口坏了\nAssertionError: business result incorrect", ["AUTOREVIEW_FAILURE=method", "AssertionError"]],
    [1, "AUTOREVIEW_FAILURE=environment 环境失败\nAssertionError: business result incorrect", ["AUTOREVIEW_FAILURE=environment", "AssertionError"]],
    [1, "AUTOREVIEW_FAILURE=product 业务失败\nAUTOREVIEW_FAILURE=method 方法失败", ["AUTOREVIEW_FAILURE=product", "AUTOREVIEW_FAILURE=method"]],
    [75, "AUTOREVIEW_FAILURE=product 业务失败", ["AUTOREVIEW_FAILURE=product", "退出码 75"]],
  ] as const;
  for (const [code, output, evidence] of cases) {
    const failure = classifyFailure(code, output); assert.equal(failure.kind, "unknown", output); assert.match(failure.reason, /冲突/);
    for (const text of evidence) assert.ok(failure.reason.includes(text), failure.reason);
  }
  assert.equal(classifyFailure(78, "AUTOREVIEW_FAILURE=method 检查方法不可用").kind, "method");
  assert.equal(classifyFailure(1, "AUTOREVIEW_FAILURE=unknown 尚无归因\nAssertionError: business result incorrect").kind, "unknown");
});

test("孤立 ENOSPC、样本/引用/expected 与模糊非零输出不足归因", () => {
  for (const output of [
    "ENOSPC", "code: 'ENOSPC'", "opaque failure", "expected: Error: ENOSPC\nopaque failure",
    '> Error: ENOSPC: no space left on device\nopaque failure',
    '"Error: ENOSPC: no space left on device"\nopaque failure',
    "```text\nError: ENOSPC: no space left on device\nAUTOREVIEW_FAILURE=product 样本\n```\nopaque failure",
    "example: Error: ENOSPC\nopaque failure", "Error: expected ENOSPC but got opaque response",
    "ok 1 - No space left on device / disk full failure example\nopaque failure",
    "> mc: Storage backend has reached its minimum free drive threshold\nopaque failure",
    "```text\nmc: Storage backend has reached its minimum free drive threshold\n```\nopaque failure",
  ]) assert.equal(classifyFailure(1, output).kind, "unknown", output);
  assert.equal(classifyFailure(1, "expected: ENOSPC\nAssertionError: actual product bug").kind, "product");
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
