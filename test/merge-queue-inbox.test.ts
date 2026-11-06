/** merge-queue／inbox：按功能独立运行，夹具与状态不跨测试进程共享。 */
import "./test-env.ts";
import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { inboxPath, readJson, statusPath, type InboxMessage, type StageStatus } from "../pipeline-core.ts";
import { processStartTime } from "../procs.ts";
import { repairText } from "../hosts/inbox-bridge.ts";
import { ROOT, keys, fixture, liveHookRepair, notification } from "./helpers/merge-queue-fixture.ts";

test("队列返修／控制字节：原生收件内容不携带终端控制字节，也不生成粘贴/回车序列", () => {
  const message = repairText("【合入队列返修】\n输出：\x03\x1b[201~\r危险控制字节");
  assert.match(message, /^【合入队列返修】\n/);
  assert.equal(message.includes("\x1b"), false); assert.equal(message.includes("\x03"), false); assert.equal(message.includes("\r"), false);
});

test("A6 文本冲突退回，不通知可合入；关闭的开发窗口精确恢复同一个会话", async () => {
  const f = fixture(1);
  try {
    f.write(0, "src/a.txt", "bad\n"); f.conflict(); const before = f.devEvidence(f.batches[0].cwd);
    f.complete(0, "failed-epoch", false);
    await f.until(() => f.queue().entries[0]?.status === "returned");
    await f.until(() => existsSync(join(f.root, "sessions.jsonl")));
    const entry = f.queue().entries[0];
    const inbox = readJson<InboxMessage>(inboxPath(f.batches[0].dir, "甲"))!;
    assert.match(inbox.message, /合并冲突[\s\S]*src\/a.txt/); assert.match(inbox.message, /Loop 未运行测试/);
    assert.equal(Object.hasOwn(entry, "log"), false);
    assert.doesNotMatch(notification(f, entry.id), /可合入/);
    const args = JSON.parse(readFileSync(join(f.root, "sessions.jsonl"), "utf8").trim());
    assert.equal(args[args.indexOf("--session") + 1], "original-dev-0"); assert.ok(!args.some((arg: string) => arg.startsWith("@")), "恢复不重新发送原需求");
    assert.deepEqual(f.devEvidence(f.batches[0].cwd), before);
    assert.equal(f.git(f.queue().workspace, "status", "--porcelain"), "");
  } finally { await f.close(); }
});

test("队列返修／恢复配置：原 Pi 退出后队列失败，经独立 Terminal 恢复原会话并沿用实际覆盖", async (t) => {
  for (const explicit of [false, true]) await t.test(explicit ? "原段 flag 高于入口环境，含已有 -- 参数" : "入口 120 不在 stage.start 中", async () => {
    const f = fixture(1, 0), log = join(f.root, "config-launches"), windows = join(f.root, "resume-windows.jsonl");
    const vars = { FAKE_CONFIG_LOG: log, FAKE_CONFIG_QUEUE: "1" };
    const saved = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
    Object.assign(process.env, vars);
    try {
      const batch = f.batches[0], marker = JSON.parse(readFileSync(join(f.repo, ".autoreview.json"), "utf8"));
      writeFileSync(join(f.repo, ".autoreview.json"), JSON.stringify({ ...marker, gate: { ...marker.gate, timeoutMin: 20 }, acceptance: { timeoutMin: 60 } }));
      const raw = JSON.parse(readFileSync(batch.file, "utf8"));
      const reviewer = join(f.root, "reviewer's command");
      writeFileSync(reviewer, "#!/bin/sh\nprintf '## 结论：通过\\n## 必修\\n无\\n## 小问题\\n无\\n## 需求疑问\\n无\\n'\n"); chmodSync(reviewer, 0o755);
      raw.pi = { ponytail: false, ...(explicit ? { args: ["--autoreview-review-timeout-min", "150", "--autoreview-reviewer-model", "chosen/model with space", "--autoreview-reviewer-thinking", "high", "--autoreview-max-repairs", "7", "--autoreview-reviewer-cmd", reviewer] } : {}) };
      writeFileSync(batch.file, JSON.stringify(raw));
      f.git(f.repo, "add", ".autoreview.json", "batch-0.json"); f.git(f.repo, "commit", "-qm", "configure launch budget");
      assert.equal(f.cli("开工", batch.file, "--autoreview-review-timeout-min", "120").ok, true);
      process.env.PI_BIN = join(ROOT, "test/fake-config-pi.mjs");
      process.env.AUTOREVIEW_MERGE_QUEUE_LAUNCHER = "terminal";
      writeFileSync(join(f.root, "bin", "osascript"), `#!${process.execPath}
const fs = require('node:fs'), cp = require('node:child_process');
const match = /tell application "Terminal" to do script ("(?:\\\\.|[^"\\\\])*")/.exec(process.argv.slice(2).join('\\n'));
if (!match) process.exit(0);
const command = JSON.parse(match[1]), env = {...process.env};
delete env.AUTOREVIEW_REVIEW_TIMEOUT_MIN; delete env.AUTOREVIEW_REVIEWER_CMD;
fs.appendFileSync(${JSON.stringify(windows)}, JSON.stringify({command, inheritedTimeout:env.AUTOREVIEW_REVIEW_TIMEOUT_MIN ?? null}) + '\\n');
const result = cp.spawnSync('/bin/sh', ['-c', command], {env, encoding:'utf8', timeout:10000});
process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || ''); process.exit(result.status ?? 1);
`);
      chmodSync(join(f.root, "bin", "osascript"), 0o755);
      f.mode("hold"); f.write(0, "src/a.txt", "candidate\n"); f.conflict();
      const initialRun = f.cli("启动", batch.file, "--autoreview-review-timeout-min", "120");
      assert.equal(initialRun.code, 0, JSON.stringify(initialRun));
      const original = readJson<any>(join(log, "甲.json"))!;
      assert.equal(original.resumed, false); assert.equal(original.effectiveConfig.reviewTimeoutMin.value, explicit ? 150 : 120);
      assert.notEqual(processStartTime(original.pid), original.processStarted, "原开发进程已退出后才放行队列失败");
      await f.until(() => f.queue().entries[0]?.status === "checking");
      const candidate = f.devEvidence(batch.cwd);
      writeFileSync(join(f.root, "release"), "allow failed queue gate after developer exit");
      await f.until(() => existsSync(windows), "已派发独立恢复窗口");
      await f.until(() => readJson<any>(join(log, "甲.json"))?.resumed === true, "权限检查通过，替身原会话实际进入返修");
      await f.idle();
      const restored = readJson<any>(join(log, "甲.json"))!, status = readJson<StageStatus>(statusPath(batch.dir, "甲"))!;
      assert.equal(restored.sessionId, original.sessionId); assert.notEqual(restored.pid, original.pid);
      assert.equal(restored.args[restored.args.indexOf("--session") + 1], original.sessionId);
      assert.ok(!restored.args.some((arg: string) => arg.startsWith("@")), "恢复不重新发送需求");
      assert.deepEqual(restored.effectiveConfig, original.effectiveConfig); assert.deepEqual(restored.review, original.review);
      assert.equal(status.sessionId, original.sessionId); assert.equal(status.event, "started"); assert.equal(status.inbox, 1);
      assert.deepEqual(f.devEvidence(batch.cwd), candidate, "恢复不替开发方改候选");
      assert.equal(readFileSync(join(log, "history.jsonl"), "utf8").trim().split("\n").length, 2);
      const window = JSON.parse(readFileSync(windows, "utf8").trim());
      assert.equal(window.inheritedTimeout, null); assert.ok(window.command.includes("AUTOREVIEW_REVIEW_TIMEOUT_MIN='120'"));
      assert.equal(f.queue().entries[0].status, "returned");
    } finally {
      await f.close();
      for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
  });
});
