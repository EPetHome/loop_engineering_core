/** e2e.mjs 的判定、报告与驱动回归：纯函数直接测；驱动用临时写出的假 pi 跑通三种结局，不调用模型。 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  acceptRunOf, deliveryNoteOf, hasParsedLatestRound, judge, overallOf, renderReport, statusOf, summaryFinished,
} from "./e2e.mjs";

const E2E = join(dirname(fileURLToPath(import.meta.url)), "e2e.mjs");

test("S1 R5/R6 结构化断言不再假绿", () => {
  assert.equal(hasParsedLatestRound(undefined), false);
  assert.equal(hasParsedLatestRound({ rounds: [] }), false);
  assert.equal(hasParsedLatestRound({ rounds: [{ conclusion: "", failed: "两次无法解析" }] }), false);
  assert.equal(hasParsedLatestRound({ rounds: [{ conclusion: "未解析" }] }), false);
  assert.equal(hasParsedLatestRound({ rounds: [{ conclusion: "通过", failed: "失败" }] }), false);
  assert.equal(hasParsedLatestRound({ rounds: [{ conclusion: "通过" }, { conclusion: "", failed: "失败" }] }), false);
  assert.equal(hasParsedLatestRound({ rounds: [{ conclusion: "通过" }] }), true);
  assert.equal(hasParsedLatestRound({ rounds: [{ conclusion: "需返修" }] }), true);
});

test("E1 终态：暂停立即结束；完成时需要验收命令的场景要等它出结果", () => {
  const summary = (status: string, acceptRun?: string) =>
    `# 自动评审总结\n- 状态：${status}\n- 评审 1 次，返修 0 次\n${acceptRun ? `- 验收命令：${acceptRun}\n` : ""}`;
  assert.equal(summaryFinished(summary("进行中")), false);
  assert.equal(summaryFinished(summary("完成")), true);
  assert.equal(summaryFinished(summary("暂停（评审失败）")), true);
  assert.equal(summaryFinished(summary("完成"), true), false, "完成但验收命令还没开始");
  assert.equal(summaryFinished(summary("完成", "进行中"), true), false);
  assert.equal(summaryFinished(summary("完成", "不通过（退出码 1）"), true), true);
  assert.equal(summaryFinished(summary("暂停（达到返修上限）"), true), true, "暂停不会触发验收命令，不能干等");
  assert.equal(statusOf(summary("完成", "通过")), "完成");
  assert.equal(acceptRunOf(summary("完成", "通过")), "通过");
});

test("E2 交付说明提取：用于判断开发方是否写了标记", () => {
  const input = "## 需求原文\n修 add\n\n## 开发方交付说明\n改好了\n【交付完成】\n\n## 本轮改动\ndiff";
  assert.equal(deliveryNoteOf(input), "改好了\n【交付完成】");
  assert.equal(deliveryNoteOf("## 开发方交付说明\n只改了文件"), "只改了文件");
  assert.equal(deliveryNoteOf(""), "");
});

test("E3 判定规则：前提不满足与没干活为 ⚪，卡住有改动、超时、退出为 🔴", () => {
  const ok = [{ name: "a", ok: true, detail: "" }];
  const bad = [{ name: "a", ok: true, detail: "" }, { name: "b", ok: false, detail: "x" }];
  assert.equal(judge({ end: { kind: "summary" }, checks: ok }).verdict, "pass");
  assert.equal(judge({ end: { kind: "summary" }, checks: bad }).verdict, "fail");
  assert.equal(judge({ end: { kind: "summary" }, checks: bad, precondition: "开发方写了标记" }).verdict, "unknown");
  assert.equal(judge({ end: { kind: "stuck", dirty: false } }).verdict, "unknown");
  assert.equal(judge({ end: { kind: "stuck", dirty: true } }).verdict, "fail");
  assert.match(judge({ end: { kind: "stuck", dirty: true } }).reason, /有未评审的改动却没有开始评审/);
  assert.equal(judge({ end: { kind: "timeout" } }).verdict, "fail");
  assert.equal(judge({ end: { kind: "exited", code: 1 } }).verdict, "fail");
  assert.equal(judge({ end: { kind: "timeout" }, modelErrors: ["429 rate limit"] }).verdict, "unknown");
  assert.equal(judge({ end: { kind: "error", message: "缺权限配置" } }).verdict, "unknown");
  assert.equal(judge({ end: { kind: "interrupted" } }).verdict, "unknown");
});

test("E4 总体结论与报告", () => {
  const item = (id: string, verdict: string) => ({
    id, name: `场景${id}`, verdict, reason: "原因", end: { kind: "summary" }, status: "完成",
    counts: { reviews: 1, repairs: 0 }, durationSeconds: 3, notes: ["说明"], scene: verdict === "pass" ? "" : `/tmp/x/${id}`,
    checks: [{ name: `${id}-1 标准`, ok: verdict !== "fail", detail: "实际不对" }],
  });
  assert.deepEqual(overallOf([item("A1", "pass")]), { text: "🟢 验收通过（1 通过 / 0 不通过 / 0 无法判定）", exitCode: 0 });
  assert.equal(overallOf([item("A1", "pass"), item("A2", "unknown")]).exitCode, 2);
  assert.equal(overallOf([item("A1", "unknown"), item("A2", "fail")]).exitCode, 1);
  assert.equal(overallOf([]).exitCode, 2, "一个场景都没跑不能算通过");
  const report = renderReport({ startedAt: "t", durationSeconds: 9, runDir: "/tmp/x", results: [item("A1", "pass"), item("A2", "fail")] });
  assert.match(report, /^- 结论：🔴 不通过（1 通过 \/ 1 不通过 \/ 0 无法判定）$/m);
  assert.match(report, /^\| A2 场景A2 \| 🔴 不通过 \|/m);
  assert.match(report, /^## A2 场景A2 — 🔴 不通过$/m);
  assert.match(report, /^- 🔴 A2-1 标准 —— 实际不对$/m);
  assert.match(report, /^- 现场：\/tmp\/x\/A2$/m);
  assert.match(report, /^- ℹ️ 说明$/m);
});

/** 假 pi：响应 get_state 和一条 prompt；FAKE_PI_MODE=finish 写出 A5 期望的总结与状态，dirty 只改文件，idle 什么都不做。 */
const FAKE_PI = `#!/usr/bin/env node
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
const mode = process.env.FAKE_PI_MODE;
const id = "fake-dev-1";
const sessionDir = join(process.env.PI_CODING_AGENT_SESSION_DIR, "--fake--");
mkdirSync(sessionDir, { recursive: true });
const sessionFile = join(sessionDir, "2026_" + id + ".jsonl");
const line = (record) => JSON.stringify(record) + "\\n";
writeFileSync(sessionFile, line({ type: "session", id }));
const out = (record) => process.stdout.write(line(record));
createInterface({ input: process.stdin }).on("line", (text) => {
  const record = JSON.parse(text);
  if (record.type === "get_state") out({ type: "response", command: "get_state", data: { sessionId: id, sessionFile } });
  if (record.type !== "prompt") return;
  out({ type: "agent_start" });
  appendFileSync(sessionFile, line({ type: "message", message: { role: "user", content: record.message } }));
  if (mode !== "idle") writeFileSync(join(process.cwd(), "calc.py"), "def add(a, b):\\n    return a + b\\n");
  if (mode === "finish") {
    appendFileSync(sessionFile, line({ type: "custom", customType: "autoreview-state", data: { rounds: [{ conclusion: "通过" }], repairs: 0 } }));
    const dir = join(process.env.HOME, ".pi-autoreview", basename(process.cwd()));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, id + ".md"), "# 自动评审总结\\n- 状态：暂停（评审改动了工作区）\\n- 评审 1 次，返修 0 次\\n## 评审期间变化的工作区文件\\n- reviewer-touched.txt\\n");
  }
  out({ type: "agent_settled" });
}).on("close", () => process.exit(0));
`;

test("E5 驱动：假 pi 跑通通过 / 卡住有改动 / 没干活三种结局，报告与现场保留正确", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "autoreview-e2e-unit-"));
  const pi = join(root, "fake-pi.mjs");
  writeFileSync(pi, FAKE_PI); chmodSync(pi, 0o755);
  const agent = join(root, "agent");
  mkdirSync(join(agent, "extensions", "pi-permission-system"), { recursive: true });
  writeFileSync(join(agent, "extensions", "pi-permission-system", "config.json"), "{}");
  const cases = [
    { mode: "finish", exit: 0, verdict: /🟢 验收通过（1 通过/, kept: false },
    { mode: "dirty", exit: 1, verdict: /🔴 不通过（0 通过 \/ 1 不通过/, kept: true, reason: /有未评审的改动却没有开始评审/ },
    { mode: "idle", exit: 2, verdict: /⚪ 验收未完成（0 通过 \/ 0 不通过 \/ 1 无法判定/, kept: true, reason: /没有任何改动/ },
  ];
  try {
    for (const item of cases) {
      await t.test(item.mode, () => {
        const res = spawnSync(process.execPath, [E2E, "A5"], {
          encoding: "utf8", timeout: 60_000,
          env: { ...process.env, AUTOREVIEW_E2E_PI: pi, AUTOREVIEW_E2E_STUCK_MS: "1500", FAKE_PI_MODE: item.mode, PI_CODING_AGENT_DIR: agent },
        });
        const reportPath = /^验收报告：(.+)$/m.exec(res.stdout)?.[1] ?? "";
        try {
          assert.equal(res.status, item.exit, res.stdout + res.stderr);
          assert.match(res.stdout.trim().split("\n").at(-2) ?? "", /^验收结论：/, "倒数第二行是结论");
          const report = readFileSync(reportPath, "utf8");
          assert.match(report, item.verdict);
          if (item.reason) assert.match(report, item.reason);
          if (item.mode === "finish") assert.match(report, /^- 🟢 A5-1 总结列出被改的文件$/m);
          const scene = join(dirname(reportPath), "A5");
          assert.equal(existsSync(scene), item.kept, item.kept ? "未通过要保留现场" : "通过要清理现场");
          if (item.kept) assert.match(report, new RegExp(`^- 现场：${scene.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
        } finally {
          if (reportPath) rmSync(dirname(reportPath), { recursive: true, force: true });
        }
      });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
