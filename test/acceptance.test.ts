/** 自动验收：纯函数（取标准、解析、判定、消息）与一轮验收流程（真起被测系统）；产物只写 os.tmpdir()。 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  ACCEPTANCE_CONVENTION, buildAcceptanceInput, buildAcceptanceRepairMessage, buildCorrectionInput, classifySystemExit,
  authorizationHint, authorizationStatus, criteriaFromUser, extractCriteria, findObjections, grantsFromUser, isAuthorizationCriterion,
  isManualCriterion, judgeAcceptance, lastEvidenceAt, mergeAcceptanceReports, parseAcceptanceReport, typedByUser, evidenceExecution,
  parseCriteriaDraft, renderAcceptanceForReview, renderAcceptanceLines, scanLogs, MAX_CRITERIA, NO_PLAYWRIGHT,
  type AcceptanceRecord, type Criteria,
} from "../acceptance-core.ts";
import { ACCEPTANCE_EVENTS_PATH, ACCEPTANCE_PROMPT_PATH, RECOVERY_PROMPT_PATH, parseElapsed, runAcceptanceStage, type AcceptanceDeps } from "../acceptance.ts";
import { checkRoundBudget, DEFAULT_ACCEPTANCE_MODEL, DEFAULT_RESET_TIMEOUT_SEC, parseAcceptanceConfig } from "../config.ts";
import { blockerHint } from "../onboarding.ts";
import { createChildExec } from "../hosts/hook.ts";
import { processStartTime, readProcs, reapProcs } from "../procs.ts";
import { recordToolActivity } from "../acceptance-events.ts";
import { renderSummary } from "../core.ts";

const TESTER = fileURLToPath(new URL("./fake-tester.mjs", import.meta.url));
const DRAFTER = fileURLToPath(new URL("./fake-drafter.mjs", import.meta.url));
const STALLED_TESTER = fileURLToPath(new URL("./fake-stalled-tester.mjs", import.meta.url));
const PARALLEL_TESTER = fileURLToPath(new URL("./fake-parallel-tester.mjs", import.meta.url));

test("A1 取「## 验收标准」：编号、项目符号、续行，遇到下一个二级标题停止", () => {
  const prompt = [
    "# 需求", "做一个待办命令行。", "",
    "## 验收标准", "下面是标准：", "A1. 操作：执行 `todo add 买菜`", "    预期：输出「已添加」",
    "2、操作：执行 todo list", "预期：列表里有「买菜」", "### 细节也算续行", "- A9 操作：重启后 list", "",
    "## 其他", "1. 这一条不是标准",
  ].join("\n");
  const items = extractCriteria(prompt)!;
  assert.deepEqual(items.map((item) => item.id), ["A1", "A2", "A3"]);
  assert.equal(items[0].text, "操作：执行 `todo add 买菜`\n预期：输出「已添加」");
  assert.equal(items[1].text, "操作：执行 todo list\n预期：列表里有「买菜」\n### 细节也算续行");
  assert.equal(items[2].text, "操作：重启后 list");
  assert.equal(extractCriteria("## 验收标准\n\n## 下一节"), undefined);
  assert.equal(extractCriteria("没有这一节"), undefined);
  assert.equal(extractCriteria("### 验收标准\n1. 三级标题不算"), undefined);

  const first = criteriaFromUser(prompt)!;
  assert.equal(first.source, "用户");
  assert.equal(first.version, 1);
  assert.equal(criteriaFromUser("1. 操作", first), undefined, "没有这一节就不替换");
  assert.equal(criteriaFromUser("## 验收标准\n1. 新的", first)!.version, 2);
});

test("A2 起草结果超过上限只留前 10 条；没有条目算解析失败", () => {
  const many = ["## 验收标准", ...Array.from({ length: 12 }, (_, i) => `A${i + 1}. 操作：第 ${i + 1} 条`)].join("\n");
  const parsed = parseCriteriaDraft(many);
  assert.ok(parsed.ok);
  if (parsed.ok) {
    assert.equal(parsed.items.length, MAX_CRITERIA);
    assert.match(parsed.note!, /12 条/);
  }
  assert.equal(parseCriteriaDraft("随便写写").ok, false);
  assert.equal(parseCriteriaDraft("").ok, false);
});

test("A3 解析验收报告：字段续行、网址不被当成字段、额外发现", () => {
  const output = [
    "## 结论：不通过", "## 逐条结果",
    "A1：通过", "- 证据摘录：已添加",
    "A2：不通过", "- 复现：打开", "http://localhost:3000/list", "- 预期：有买菜", "- 实际：空", "- 证据摘录：[]",
    "A3：无法验证", "- 原因：缺浏览器",
    "## 额外发现", "- 标题错别字", "- 无",
  ].join("\n");
  const parsed = parseAcceptanceReport(output);
  assert.ok(parsed.ok);
  if (!parsed.ok) return;
  assert.equal(parsed.report.conclusion, "不通过");
  assert.deepEqual(parsed.report.items.map((item) => [item.id, item.verdict]), [["A1", "通过"], ["A2", "不通过"], ["A3", "无法验证"]]);
  assert.equal(parsed.report.items[1].fields["复现"], "打开\nhttp://localhost:3000/list");
  assert.deepEqual(parsed.report.extra, ["标题错别字"]);
  assert.equal(parseAcceptanceReport("## 结论：通过\n没有逐条").ok, false);
  assert.equal(parseAcceptanceReport("## 逐条结果\n随便").ok, false);
});

const criteriaItems = [{ id: "A1", text: "操作：add\n预期：已添加" }, { id: "A2", text: "操作：list\n预期：有买菜" }];
const evidenceOf = (map: Record<string, string>) => (id: string) => map[id];
const block = (id: string, out: string) => `=== ${id} #1 2026-10-10T00:00:00Z\n$ todo\n退出码：0\n--- 标准输出\n${out}\n`;

test("A4 判定：证据核对、不通过、缺条目、G1/G2，按逐条结果而不是自报结论", () => {
  const report = (lines: string[]) => {
    const parsed = parseAcceptanceReport(["## 结论：通过", "## 逐条结果", ...lines].join("\n"));
    assert.ok(parsed.ok);
    return parsed.ok ? parsed.report : undefined;
  };
  const passed = judgeAcceptance({
    criteria: criteriaItems, logErrors: [], runDir: "/run", hasService: true,
    report: report(["A1：通过", "- 证据摘录：「已添加」", "A2：通过", "- 证据摘录：买菜   牛奶"]),
    evidence: evidenceOf({ A1: block("A1", "已添加"), A2: block("A2", "买菜\n牛奶") }),
  });
  assert.equal(passed.verdict, "通过", "去掉引号、折叠空白后能在证据里找到");

  const lazy = judgeAcceptance({
    criteria: criteriaItems, logErrors: [], runDir: "/run", hasService: true,
    report: report(["A1：通过", "- 证据摘录：已添加", "A2：通过", "- 证据摘录：编的"]),
    evidence: evidenceOf({ A2: block("A2", "买菜") }),
  });
  assert.equal(lazy.verdict, "无法验收");
  assert.ok(lazy.items.every((item) => item.verdict === "无法验证" && item.evidenceProblem));
  assert.match(lazy.items[0].detail, /没有用 \.\/ev/);
  assert.match(lazy.items[1].detail, /证据摘录在 \/run\/evidence\/A2\.txt 里找不到/);

  const failed = judgeAcceptance({
    criteria: criteriaItems, logErrors: ["[12:00] ERROR boom"], runDir: "/run", hasService: true,
    report: report(["A1：通过", "- 证据摘录：已添加", "A2：不通过", "- 复现：list", "- 预期：有买菜", "- 实际：空", "- 证据摘录：（空）"]),
    evidence: evidenceOf({ A1: block("A1", "已添加"), A2: block("A2", "（空）") }),
  });
  assert.equal(failed.verdict, "不通过");
  assert.deepEqual(failed.items.map((item) => [item.id, item.verdict]), [["A1", "通过"], ["A2", "不通过"], ["G2", "不通过"]]);
  assert.match(failed.note!, /自报「通过」，程序按逐条结果判为「不通过」/);

  const missing = judgeAcceptance({
    criteria: criteriaItems, logErrors: [], runDir: "/run", hasService: true,
    report: report(["A1：通过", "- 证据摘录：已添加"]), evidence: evidenceOf({ A1: block("A1", "已添加") }),
  });
  assert.equal(missing.verdict, "无法验收");
  assert.equal(missing.blocker, "验收方");
  assert.equal(missing.reason, "验收方没按要求留证据或输出格式不对（A2）");

  const down = judgeAcceptance({ criteria: criteriaItems, logErrors: [], runDir: "/run", hasService: true, evidence: () => undefined, systemFailure: "系统启动后就退出了" });
  assert.equal(down.verdict, "不通过");
  assert.deepEqual(down.items.map((item) => item.id), ["G1"]);

  const silent = judgeAcceptance({ criteria: criteriaItems, logErrors: [], runDir: "/run", hasService: true, evidence: () => undefined, reportError: "两次都无法解析" });
  assert.equal(silent.verdict, "无法验收");
  assert.equal(silent.blocker, "验收方");
  assert.match(silent.items[0].detail, /两次都无法解析/);
});

test("A5 日志扫描、异议识别、返修消息不含「## 验收标准」标题", () => {
  assert.deepEqual(scanLogs("ok\nERROR a\nERROR a\nERROR known noise\nFATAL b", ["ERROR", "FATAL"], ["known noise"]), ["ERROR a", "FATAL b"]);
  assert.deepEqual(scanLogs("ERROR a", [], []), []);
  assert.deepEqual(findObjections("A1：已修\nA2：异议：标准写错了\n- G2: 异议 日志是故意的"), { objections: ["A2", "G2"], doubts: [] });
  assert.deepEqual(findObjections("第 1 条：异议：评审的"), { objections: [], doubts: [] });
  assert.deepEqual(findObjections("G2：方法存疑：日志是故意的"), { objections: [], doubts: [{ id: "G2", reason: "日志是故意的" }] });
  assert.deepEqual(findObjections("A2：异议：方法存疑的写法也按异议处理"), { objections: ["A2"], doubts: [] });
  const record: AcceptanceRecord = {
    verdict: "不通过", runDir: "/run/r1", durationMs: 1000, logErrors: [], extra: [],
    items: [
      { id: "A1", text: "操作：add\n预期：已添加", verdict: "通过", detail: "证据摘录：已添加" },
      { id: "A2", text: "操作：list\n预期：有买菜", verdict: "不通过", detail: "实际：空\n证据：/run/r1/evidence/A2.txt" },
    ],
  };
  const message = buildAcceptanceRepairMessage(2, record);
  assert.match(message, /^【自动验收 · 第 2 次返修】/);
  assert.match(message, /A2\. 操作：list\n {4}预期：有买菜\n {4}实际：空/);
  assert.ok(!message.includes("A1. 操作"), "通过的条目不发回");
  assert.ok(!/^##/m.test(message), "返修消息不能带二级标题，免得被当成新的验收标准");
  assert.match(message, /最后一行写【交付完成】。$/);
  assert.match(ACCEPTANCE_CONVENTION, /## 验收标准/);
});

test("A6 acceptance 配置：默认值、路径解析、非法字段、预算", () => {
  assert.equal(parseAcceptanceConfig(undefined, "/p"), undefined);
  const config = parseAcceptanceConfig({ start: "npm start", logs: ["logs/app.log"], guide: "docs/use.md" }, "/p", {})!;
  assert.equal(config.model, DEFAULT_ACCEPTANCE_MODEL);
  assert.equal(config.timeoutMin, 20);
  assert.equal(config.idleTimeoutSec, 300);
  assert.equal(parseAcceptanceConfig({ idleTimeoutSec: 12 }, "/p")!.idleTimeoutSec, 12);
  for (const idleTimeoutSec of [0, -1, 1.5, "300", null]) assert.throws(() => parseAcceptanceConfig({ idleTimeoutSec }, "/p"), /idleTimeoutSec/);
  assert.deepEqual(config.logs, ["/p/logs/app.log"]);
  assert.equal(config.guide, "/p/docs/use.md");
  assert.ok(config.errorPatterns.includes("ERROR"));
  assert.throws(() => parseAcceptanceConfig({ readyUrl: "ftp://x" }, "/p"), /readyUrl/);
  assert.throws(() => parseAcceptanceConfig({ logs: "a.log" }, "/p"), /logs/);
  assert.throws(() => parseAcceptanceConfig({ timeoutMin: 0 }, "/p"), /timeoutMin/);
  assert.throws(() => parseAcceptanceConfig({ env: { A: 1 } }, "/p"), /env/);
  assert.throws(() => parseAcceptanceConfig([], "/p"), /acceptance/);
  assert.throws(() => checkRoundBudget(20, config), /必须小于/);
  checkRoundBudget(60, config);
});

async function freePort(): Promise<number> {
  return new Promise((resolvePort) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => resolvePort(port));
    });
  });
}

const SERVER = `
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
const port = Number(process.argv[2]);
// 假验收方的 kill 模式按这个文件找到被测系统。
if (process.env.AUTOREVIEW_RUN_DIR) writeFileSync(join(process.env.AUTOREVIEW_RUN_DIR, "server.pid"), String(process.pid));
createServer((req, res) => {
  if (req.url === "/boom") console.error("ERROR boom at " + req.url);
  if (req.url === "/crash") { console.error("ERROR crash at " + req.url); process.exit(1); }
  res.end(req.url === "/health" ? "ok" : "买菜");
}).listen(port, "127.0.0.1", () => console.log("Listening on " + port));
`;

async function harness(acceptance: Record<string, unknown>, env: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), "autoreview-acc-"));
  const work = join(root, "work");
  mkdirSync(work);
  writeFileSync(join(work, "server.mjs"), SERVER);
  const port = await freePort();
  const saved: Record<string, string | undefined> = {};
  const vars = { AUTOREVIEW_RESOURCE_ROOT: join(root, "resources"), AUTOREVIEW_ACCEPTANCE_CMD: TESTER, AUTOREVIEW_CRITERIA_CMD: DRAFTER, FAKE_STATE_DIR: join(root, "fake"), ...env };
  for (const [key, value] of Object.entries(vars)) { saved[key] = process.env[key]; process.env[key] = value.replace("{port}", String(port)); }
  const raw = JSON.parse(JSON.stringify(acceptance).replaceAll("{port}", String(port)));
  const config = parseAcceptanceConfig(raw, work, process.env)!;
  const procsFile = join(root, "procs.json");
  const state: { requirement?: string; criteria?: Criteria } = { requirement: "做待办\n## 验收标准\n1. 操作：GET /api\n   预期：返回买菜\n2. 操作：GET /boom\n   预期：返回买菜" };
  const deps = (extra: Partial<AcceptanceDeps> = {}): AcceptanceDeps => ({
    workDir: work, devSessionId: "unit", round: 1, deliveryNote: "做完了", state, config,
    reviewerModel: "m", reviewerThinking: "xhigh", exec: createChildExec(procsFile), runDir: join(root, "acc", "r1"),
    procsFile, deadline: Date.now() + 5 * 60_000, now: Date.now, previousFailed: [], saveState: () => {}, ...extra,
  });
  return {
    root, work, port, config, procsFile, state, deps,
    calls: () => existsSync(join(root, "fake", "acc-calls.log")) ? readFileSync(join(root, "fake", "acc-calls.log"), "utf8").trim().split("\n") : [],
    close: () => {
      for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function portOpen(port: number): Promise<boolean> {
  try { await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) }); return true; } catch { return false; }
}

test("A7 真起被测系统：就绪、带时间戳记日志、扫到 ERROR 判 G2 不通过、结束后关停并清登记", async () => {
  const h = await harness(
    { start: "node server.mjs {port}", readyUrl: "http://127.0.0.1:{port}/health" },
    { FAKE_ACC_URL: "http://127.0.0.1:{port}/boom" },
  );
  try {
    const stage = await runAcceptanceStage(h.deps());
    assert.equal(stage.kind, "judged");
    if (stage.kind !== "judged") return;
    const { record } = stage;
    assert.deepEqual(record.items.map((item) => [item.id, item.verdict]), [["A1", "通过"], ["A2", "通过"], ["G2", "不通过"]]);
    assert.equal(record.verdict, "不通过");
    assert.match(record.logErrors[0], /\[stderr\] ERROR boom at \/boom/);
    const log = readFileSync(join(record.runDir, "system.log"), "utf8");
    assert.match(log, /^\[\d{2}:\d{2}:\d{2}\.\d{3}\] Listening on/m);
    assert.match(readFileSync(join(record.runDir, "evidence", "A1.txt"), "utf8"), /^=== A1 #1 /m);
    assert.equal(h.state.criteria?.source, "用户", "需求里的标准被采用并冻结");
    assert.equal(await portOpen(h.port), false, "被测系统已关停");
    assert.deepEqual(readProcs(h.procsFile), [], "登记已清空");
    assert.deepEqual(record.extra, ["首页标题有错别字"]);
  } finally { h.close(); }
});

test("A8 端口已被占用：暂停（环境问题），不启动、不调验收方", async () => {
  const h = await harness({ start: "node server.mjs {port}", readyUrl: "http://127.0.0.1:{port}/health" });
  const { spawn } = await import("node:child_process");
  const squatter = spawn(process.execPath, [join(h.work, "server.mjs"), String(h.port)], { stdio: "ignore" });
  try {
    for (let i = 0; i < 50 && !await portOpen(h.port); i += 1) await new Promise((r) => setTimeout(r, 100));
    const stage = await runAcceptanceStage(h.deps());
    assert.equal(stage.kind, "paused");
    if (stage.kind === "paused") assert.match(stage.reason, /端口 \d+ 已被占用（环境问题/);
    assert.deepEqual(h.calls(), []);
  } finally { squatter.kill("SIGKILL"); h.close(); }
});

test("A9 系统起不来：G1 不通过，附系统输出，不调验收方", async () => {
  const h = await harness({ start: "echo 配置缺失 >&2; exit 3", readyUrl: "http://127.0.0.1:{port}/health" });
  try {
    const stage = await runAcceptanceStage(h.deps());
    assert.equal(stage.kind, "judged");
    if (stage.kind !== "judged") return;
    assert.equal(stage.record.verdict, "不通过");
    assert.equal(stage.record.items[0].id, "G1");
    assert.match(stage.record.items[0].detail, /系统启动后就退出了（退出码 3）[\s\S]*配置缺失/);
    assert.deepEqual(h.calls(), []);
  } finally { h.close(); }
});

test("A10 没有常驻服务（命令行项目）+ 偷懒的验收方：证据对不上就在同一会话重做一次", async () => {
  const h = await harness({}, { FAKE_ACC_MODE: "lazy" });
  try {
    const stage = await runAcceptanceStage(h.deps());
    assert.equal(stage.kind, "judged");
    if (stage.kind !== "judged") return;
    assert.equal(stage.record.verdict, "通过");
    const calls = h.calls();
    assert.equal(calls.length, 2);
    assert.match(calls[1], /correction\.md/);
    assert.equal(calls[0].split("\t")[2], calls[1].split("\t")[2], "同一个验收会话");
    assert.match(readFileSync(join(stage.record.runDir, "correction.md"), "utf8"), /A1：原因：报告「通过」，但没有用/);
  } finally { h.close(); }
});

test("A11 验收方一直乱写：重做一次、再换强模型重验一次，仍不行才无法验收；需求里没标准时先起草一次并冻结", async () => {
  const h = await harness({}, { FAKE_ACC_MODE: "garbage" });
  try {
    h.state.requirement = "做一个待办命令行";
    const stage = await runAcceptanceStage(h.deps());
    assert.equal(h.state.criteria?.source, "自动起草");
    assert.equal(h.state.criteria?.items.length, 2);
    assert.equal(stage.kind, "judged");
    if (stage.kind !== "judged") return;
    assert.equal(stage.record.verdict, "无法验收");
    assert.equal(stage.record.blocker, "验收方");
    assert.equal(stage.record.escalated, true);
    assert.match(stage.record.items[0].detail, /无法解析/);
    const calls = h.calls();
    assert.equal(calls.length, 3);
    assert.match(calls[2].split("\t")[2], /^autoreview-acc-strong-/, "第三次换强模型另开会话");
    const again = await runAcceptanceStage(h.deps({ round: 2, runDir: join(h.root, "acc", "r2") }));
    assert.equal(again.kind, "judged");
    const drafts = readFileSync(join(h.root, "fake", "draft-calls.log"), "utf8").trim().split("\n");
    assert.equal(drafts.length, 1, "标准冻结后不再起草");
  } finally { h.close(); }
});

test("A12 开发方对标准提异议：直接暂停交给用户，不跑验收；同一段旧回复不再重复暂停", async () => {
  const h = await harness({});
  try {
    const note = "A1：已修\nA2：异议：标准和需求矛盾\n【交付完成】";
    const stage = await runAcceptanceStage(h.deps({ deliveryNote: note }));
    assert.equal(stage.kind, "paused");
    if (stage.kind === "paused") assert.equal(stage.reason, "开发方对验收标准有异议（A2）");
    assert.deepEqual(h.calls(), []);
    // 用户决定后开发方没再提异议：同一条旧回复再次走到验收不重复暂停，照常验收。
    const again = await runAcceptanceStage(h.deps({ deliveryNote: note, runDir: join(h.root, "acc", "r2") }));
    assert.equal(again.kind, "judged");
    assert.ok(h.calls().length > 0);
    // 换一条新回复再提异议：还没处理过，照旧暂停。
    const next = await runAcceptanceStage(h.deps({ deliveryNote: "A1：已修\nA2：异议：另一个理由\n【交付完成】", runDir: join(h.root, "acc", "r3") }));
    assert.equal(next.kind, "paused");
  } finally { h.close(); }
});

test("A12b 方法存疑不暂停：照常验收、G2 失败照常判、理由进验收方输入和总结", async () => {
  const h = await harness(
    { start: "node server.mjs {port}", readyUrl: "http://127.0.0.1:{port}/health" },
    { FAKE_ACC_URL: "http://127.0.0.1:{port}/boom" },
  );
  try {
    const note = "A1：已修\nG2：方法存疑：日志是故意的\n【交付完成】";
    const stage = await runAcceptanceStage(h.deps({ deliveryNote: note }));
    assert.equal(stage.kind, "judged");
    if (stage.kind !== "judged") return;
    assert.equal(stage.record.verdict, "不通过", "存疑不等于通过");
    assert.equal(stage.record.items.find((item) => item.id === "G2")?.verdict, "不通过");
    assert.deepEqual(stage.record.methodDoubts, [{ id: "G2", reason: "日志是故意的" }]);
    const input = readFileSync(join(stage.record.runDir, "input.md"), "utf8");
    assert.match(input, /## 开发方对验收方法的存疑（照常实测）\n\n- G2：日志是故意的/);
    assert.match(renderAcceptanceLines(stage.record).join("\n"), /验收方法存疑（照常验收，不作为通过依据）：G2：日志是故意的/);
  } finally { h.close(); }
});

test("A13 验收方输入：环境、工具用法、标准版本、开发方说明的定位", () => {
  const text = buildAcceptanceInput({
    round: 2, requirement: "需求", criteria: { source: "自动起草", items: criteriaItems, version: 3, updatedAt: "" },
    workDir: "/work", runDir: "/run", baseUrl: "http://127.0.0.1:3000", systemLog: "/run/system.log", logFiles: ["/work/app.log"],
    deliveryNote: "用 todo add", previousFailed: ["A2"],
  });
  for (const part of ["被测项目目录：/work（只在这里运行命令，不要读源码）", "系统地址：http://127.0.0.1:3000", "./ev A1 -- <命令>",
    "./browser A1", "## 验收标准（第 3 版，来源：自动起草）", "A2. 操作：list\n    预期：有买菜", "不能当作通过的依据", "上一轮没通过：A2"]) {
    assert.ok(text.includes(part), `缺少：${part}`);
  }
  const withSection = buildAcceptanceInput({
    round: 1, requirement: "做待办\n## 验收标准\n1. 旧写法\n## 备注\n别忘了", criteria: { source: "用户", items: criteriaItems, version: 1, updatedAt: "" },
    workDir: "/work", runDir: "/run", logFiles: [], deliveryNote: "", previousFailed: [],
  });
  assert.equal(withSection.match(/^## 验收标准/gm)?.length, 1, "需求原文里的标准一节被去掉，只列一次");
  assert.ok(withSection.includes("## 备注\n别忘了") && !withSection.includes("旧写法"));
});

test("A14 提示词里的输出格式示例能被解析器原样解析（改提示词时防止格式和解析对不上）", () => {
  const tester = parseAcceptanceReport(readFileSync(new URL("../acceptance-prompt.md", import.meta.url), "utf8"));
  assert.ok(tester.ok);
  if (tester.ok) {
    assert.deepEqual(tester.report.items.map((item) => [item.id, item.verdict]), [["A1", "通过"], ["A2", "不通过"], ["A3", "无法验证"]]);
    assert.deepEqual(Object.keys(tester.report.items[1].fields), ["复现", "预期", "实际", "证据摘录", "相关日志"]);
  }
  const drafter = parseCriteriaDraft(readFileSync(new URL("../criteria-prompt.md", import.meta.url), "utf8"));
  assert.ok(drafter.ok);
  if (drafter.ok) assert.deepEqual(drafter.items.map((item) => item.id), ["A1", "A2"]);
  const guide = readFileSync(new URL("../README-验收标准.md", import.meta.url), "utf8");
  const snippet = /````markdown\n([\s\S]*?)\n````/.exec(guide)?.[1] ?? "";
  assert.ok(snippet.includes("## 验收标准"), "README-验收标准.md 里要有可复制的追加段");
  assert.deepEqual(extractCriteria(snippet)?.map((item) => item.id), ["A1", "A2", "A3", "A4"], "追加段里的示例格式能被程序取到");
});

test("A15 弱模型常见写法：粗体编号、粗体字段名、三级标题条目、粗体异议都能认", () => {
  const parsed = parseAcceptanceReport([
    "## 结论：通过", "## 逐条结果",
    "**A1**：**通过**", "- **证据摘录**：已添加",
    "### A2: 不通过", "- **实际**：空", "- 证据摘录：**[]**",
  ].join("\n"));
  assert.ok(parsed.ok);
  if (parsed.ok) {
    assert.deepEqual(parsed.report.items.map((item) => [item.id, item.verdict]), [["A1", "通过"], ["A2", "不通过"]]);
    assert.equal(parsed.report.items[0].fields["证据摘录"], "已添加");
    assert.equal(parsed.report.items[1].fields["实际"], "空");
    assert.equal(parsed.report.items[1].fields["证据摘录"], "**[]**", "值里的内容原样保留");
  }
  assert.deepEqual(extractCriteria("## 验收标准\n**A1.** 操作：add\n**2.** 操作：list")?.map((item) => item.text), ["操作：add", "操作：list"]);
  assert.deepEqual(findObjections("**A2**：异议：标准写错了"), { objections: ["A2"], doubts: [] });
});

test("A16 无法验证分原因：没配启动时连不上改判、缺工具、个别含糊 → 部分验证、全部含糊 → 无法验收", () => {
  const report = (lines: string[]) => {
    const parsed = parseAcceptanceReport(["## 结论：不通过", "## 逐条结果", ...lines].join("\n"));
    assert.ok(parsed.ok);
    return parsed.ok ? parsed.report : undefined;
  };
  const refused = report(["A1：不通过", "- 实际：Connection refused", "- 证据摘录：已添加", "A2：通过", "- 证据摘录：买菜"]);
  const evidence = evidenceOf({ A1: block("A1", "已添加"), A2: block("A2", "买菜") });
  const noService = judgeAcceptance({ criteria: criteriaItems, logErrors: [], runDir: "/run", hasService: false, report: refused, evidence });
  assert.equal(noService.verdict, "无法验收", "没配启动时连不上不打回开发方");
  assert.equal(noService.blocker, "没配启动");
  assert.match(noService.items[0].detail, /不算开发方的错/);
  const withService = judgeAcceptance({ criteria: criteriaItems, logErrors: [], runDir: "/run", hasService: true, report: refused, evidence });
  assert.equal(withService.verdict, "不通过", "配了启动还连不上，照常算不通过");

  const tool = judgeAcceptance({
    criteria: criteriaItems, logErrors: [], runDir: "/run", hasService: true,
    report: report(["A1：无法验证", "- 原因：工具报错", "A2：通过", "- 证据摘录：买菜"]),
    evidence: evidenceOf({ A1: block("A1", `${NO_PLAYWRIGHT}：…`), A2: block("A2", "买菜") }),
  });
  assert.equal(tool.blocker, "缺工具");

  const vague = report(["A1：无法验证", "- 原因：标准写得含糊", "A2：通过", "- 证据摘录：买菜"]);
  const partial = judgeAcceptance({ criteria: criteriaItems, logErrors: [], runDir: "/run", hasService: true, report: vague, evidence });
  assert.equal(partial.verdict, "部分验证");
  assert.equal(partial.reason, "A1 没能自动验证，需要人工验收");
  assert.equal(partial.blocker, undefined);
  const allVague = judgeAcceptance({
    criteria: criteriaItems, logErrors: [], runDir: "/run", hasService: true, evidence,
    report: report(["A1：无法验证", "- 原因：含糊", "A2：无法验证", "- 原因：含糊"]),
  });
  assert.equal(allVague.verdict, "无法验收");
  assert.equal(allVague.blocker, "其他");
});

test("A17 换强模型重验能救回来：第一位乱写，强模型按要求做完 → 通过，并记下换过模型", async () => {
  const h = await harness({}, { FAKE_ACC_MODE: "garbage", FAKE_ACC_STRONG: "pass" });
  try {
    const stage = await runAcceptanceStage(h.deps());
    assert.equal(stage.kind, "judged");
    if (stage.kind !== "judged") return;
    assert.equal(stage.record.verdict, "通过");
    assert.equal(stage.record.escalated, true);
    assert.equal(h.calls().length, 3);
    assert.match(readFileSync(join(stage.record.runDir, "strong.md"), "utf8"), /上一位验收方没按要求/);
  } finally { h.close(); }
});

// —— 验收方关掉被测系统、数据不干净（上一版 loop 出事的场景）——

const stamped = (id: string, at: string, out: string) => `=== ${id} #1 ${at}\n$ curl\n退出码：0\n--- 标准输出\n${out}\n`;

test("A18 退出方式归责：被信号关掉或无错误的正常退出算被关掉，其余算崩溃", () => {
  assert.equal(classifySystemExit({ code: null, signal: "SIGTERM" }, []), "被关掉");
  assert.equal(classifySystemExit({ code: null, signal: "SIGKILL" }, ["ERROR x"]), "被关掉", "被信号关掉时日志里的错误多半是关停时打的");
  assert.equal(classifySystemExit({ code: 143, signal: null }, []), "被关掉", "sh 转述子进程被 SIGTERM 关掉");
  assert.equal(classifySystemExit({ code: 130, signal: null }, []), "被关掉");
  assert.equal(classifySystemExit({ code: 0, signal: null }, []), "被关掉");
  assert.equal(classifySystemExit({ code: 0, signal: null }, ["ERROR boom"]), "崩溃");
  assert.equal(classifySystemExit({ code: 1, signal: null }, []), "崩溃");
  assert.equal(classifySystemExit({ code: 134, signal: null }, []), "崩溃", "SIGABRT 是崩溃");
  assert.equal(classifySystemExit({ code: null, signal: "SIGSEGV" }, []), "崩溃");
  assert.equal(lastEvidenceAt(`${stamped("A1", "2026-10-10T00:00:01Z", "a")}${stamped("A1", "2026-10-10T00:00:05Z", "b")}`, "A1"), Date.parse("2026-10-10T00:00:05Z"));
  assert.equal(lastEvidenceAt(undefined, "A1"), undefined);
  assert.equal(parseElapsed("05:07"), 307);
  assert.equal(parseElapsed("01:02:03"), 3723);
  assert.equal(parseElapsed("2-00:00:01"), 172801);
  assert.equal(parseElapsed("abc"), undefined);
});

test("A19 被关掉时的判定：之前的证据照算，之后的证据不算，G1/G2 不打回，整轮无法验收", () => {
  const stoppedAt = Date.parse("2026-10-10T00:00:03Z");
  const parsed = parseAcceptanceReport([
    "## 结论：不通过", "## 逐条结果",
    "A1：通过", "- 证据摘录：已添加",
    "A2：不通过", "- 实际：Connection refused", "- 证据摘录：Connection refused",
  ].join("\n"));
  assert.ok(parsed.ok);
  if (!parsed.ok) return;
  const record = judgeAcceptance({
    criteria: criteriaItems, report: parsed.report, logErrors: ["ERROR pool closed during shutdown"], runDir: "/run", hasService: true,
    evidence: evidenceOf({ A1: stamped("A1", "2026-10-10T00:00:01Z", "已添加"), A2: stamped("A2", "2026-10-10T00:00:04Z", "Connection refused") }),
    systemStopped: { at: stoppedAt, detail: "系统在验收途中被关掉了（退出码 143）" },
  });
  const byId = Object.fromEntries(record.items.map((item) => [item.id, item]));
  assert.equal(byId.G1.verdict, "无法验证");
  assert.equal(byId.G1.cause, "系统被关掉");
  assert.equal(byId.A1.verdict, "通过", "关掉之前留的证据照算");
  assert.equal(byId.A2.verdict, "无法验证", "关掉之后留的证据不算");
  assert.match(byId.A2.detail, /被关掉之后留的/);
  assert.equal(byId.G2.verdict, "无法验证", "关停时打的错误不据此打回");
  assert.equal(record.verdict, "无法验收");
  assert.equal(record.blocker, "系统被关掉");
  assert.equal(record.note, undefined, "被关掉时不再对比验收方自报的结论");

  const noReport = judgeAcceptance({
    criteria: criteriaItems, logErrors: [], runDir: "/run", hasService: true, evidence: () => undefined,
    reportError: "第 1 次验收超时或被终止", systemStopped: { at: stoppedAt, detail: "被关掉" },
  });
  assert.deepEqual(noReport.items.map((item) => [item.id, item.verdict, item.cause]),
    [["G1", "无法验证", "系统被关掉"], ["A1", "无法验证", "系统被关掉"], ["A2", "无法验证", "系统被关掉"]]);
  assert.equal(noReport.verdict, "无法验收");

  const failedBeforeStop = parseAcceptanceReport(
    ["## 结论：不通过", "## 逐条结果", "A1：不通过", "- 实际：没输出", "- 证据摘录：没输出", "A2：通过", "- 证据摘录：买菜"].join("\n"),
  );
  assert.ok(failedBeforeStop.ok);
  if (!failedBeforeStop.ok) return;
  const realFailure = judgeAcceptance({
    criteria: criteriaItems, logErrors: [], runDir: "/run", hasService: true, report: failedBeforeStop.report,
    evidence: evidenceOf({ A1: stamped("A1", "2026-10-10T00:00:01Z", "没输出"), A2: stamped("A2", "2026-10-10T00:00:02Z", "买菜") }),
    systemStopped: { at: stoppedAt, detail: "被关掉" },
  });
  assert.equal(realFailure.verdict, "不通过", "关掉之前实测出的真问题照样打回");
  assert.deepEqual(realFailure.items.filter((item) => item.verdict === "不通过").map((item) => item.id), ["A1"]);
});

test("A20 验收方关掉被测系统：立即停掉验收方、不换强模型重验，判无法验收而不是打回开发方", async () => {
  const h = await harness(
    { start: "node server.mjs {port}", readyUrl: "http://127.0.0.1:{port}/health" },
    { FAKE_ACC_MODE: "kill" },
  );
  try {
    const stage = await runAcceptanceStage(h.deps());
    assert.equal(stage.kind, "judged");
    if (stage.kind !== "judged") return;
    const { record } = stage;
    assert.equal(record.verdict, "无法验收");
    assert.equal(record.blocker, "系统被关掉");
    assert.deepEqual(record.items.filter((item) => item.verdict === "不通过"), [], "没有任何一条算到开发方头上");
    const g1 = record.items.find((item) => item.id === "G1")!;
    assert.equal(g1.verdict, "无法验证");
    assert.match(g1.detail, /被关掉了（退出码 (143|SIGTERM)），多半是验收方/);
    assert.equal(h.calls().length, 1, "系统没了就不再重做、不换强模型");
    assert.equal(await portOpen(h.port), false);
    const hint = blockerHint(record as AcceptanceRecord, h.work, h.config);
    assert.match(hint, /不是开发方的问题/);
    assert.match(hint, /acceptance\.reset/);
  } finally { h.close(); }
});

test("A21 验收方关掉后用 setsid 重启服务占着端口：收尾时清掉，并写进记录", async () => {
  const h = await harness(
    { start: "node server.mjs {port}", readyUrl: "http://127.0.0.1:{port}/health" },
    { FAKE_ACC_MODE: "kill-restart", FAKE_ACC_URL: "http://127.0.0.1:{port}/health" },
  );
  try {
    const stage = await runAcceptanceStage(h.deps());
    assert.equal(stage.kind, "judged");
    if (stage.kind !== "judged") return;
    assert.equal(stage.record.blocker, "系统被关掉");
    const restarted = Number(readFileSync(join(stage.record.runDir, "restarted.pid"), "utf8"));
    const state = spawnSync("ps", ["-p", String(restarted), "-o", "stat="], { encoding: "utf8" });
    assert.ok(state.status !== 0 || state.stdout.trim().startsWith("Z"), "独立重启进程已被执行器提前清理，不能只检查端口");
    assert.match((stage.record.cleanup ?? []).join("\n"), /验收方调用及工具子进程已按归属确认停止（含独立进程组）/);
    assert.equal(await portOpen(h.port), false, "逃出进程组的重启进程也被清掉");
  } finally { h.close(); }
});

test("A22 系统自己崩溃（非 0 退出、日志有错误）：仍算 G1 不通过，打回开发方", async () => {
  const h = await harness(
    { start: "node server.mjs {port}", readyUrl: "http://127.0.0.1:{port}/health" },
    { FAKE_ACC_URL: "http://127.0.0.1:{port}/crash" },
  );
  try {
    const stage = await runAcceptanceStage(h.deps());
    assert.equal(stage.kind, "judged");
    if (stage.kind !== "judged") return;
    assert.equal(stage.record.verdict, "不通过");
    const g1 = stage.record.items.find((item) => item.id === "G1")!;
    assert.equal(g1.verdict, "不通过");
    assert.match(g1.detail, /系统在验收过程中退出了（退出码 1）/);
    assert.equal(stage.record.items.find((item) => item.id === "G2")?.verdict, "不通过");
  } finally { h.close(); }
});

test("A23 配了 reset：首次重置，格式更正复用数据与证据，输出不进系统日志", async () => {
  const h = await harness(
    {
      start: "node server.mjs {port}", readyUrl: "http://127.0.0.1:{port}/health",
      reset: "echo 重置 >> \"$AUTOREVIEW_RUN_DIR/reset-count\"; echo \"ERROR 重置时打的不算系统错误 $RESET_FLAG\"",
      env: { RESET_FLAG: "ENV_OK" },
    },
    { FAKE_ACC_MODE: "lazy" },
  );
  try {
    const stage = await runAcceptanceStage(h.deps());
    assert.equal(stage.kind, "judged");
    if (stage.kind !== "judged") return;
    const { runDir } = stage.record;
    assert.equal(stage.record.verdict, "通过", "重置时打的 ERROR 不算 G2");
    assert.equal(readFileSync(join(runDir, "reset-count"), "utf8").trim().split("\n").length, 1, "同一次格式更正不重复清数据");
    const resetLog = readFileSync(join(runDir, "reset.log"), "utf8");
    assert.doesNotMatch(resetLog, /重做前/);
    assert.match(resetLog, /ENV_OK/, "重置命令拿得到被测系统的环境变量");
    assert.doesNotMatch(readFileSync(join(runDir, "system.log"), "utf8"), /重置时打的/);
    assert.match(readFileSync(join(runDir, "correction.md"), "utf8"), /已经留对的证据不用重跑/);
    assert.match(readFileSync(join(runDir, "input.md"), "utf8"), /首次验收和换强模型重验前已把数据重置到初始状态/);
  } finally { h.close(); }
});

test("A24 reset 失败：暂停（环境问题），不调验收方，被测系统照样关停", async () => {
  const h = await harness({
    start: "node server.mjs {port}", readyUrl: "http://127.0.0.1:{port}/health", reset: "echo 测试库连不上 >&2; exit 2",
  });
  try {
    const stage = await runAcceptanceStage(h.deps());
    assert.equal(stage.kind, "paused");
    if (stage.kind !== "paused") return;
    assert.match(stage.reason, /验收前重置数据失败（环境问题/);
    assert.match(stage.notes ?? "", /退出码 2：测试库连不上/);
    assert.match(stage.hint, /acceptance\.reset[\s\S]*reset\.log/);
    assert.deepEqual(h.calls(), []);
    assert.equal(await portOpen(h.port), false);
  } finally { h.close(); }
});

test("A25 没配 reset、验收方报「数据不是初始状态」：无法验收并提示配 reset；配了仍不干净就提示检查重置命令", async () => {
  const h = await harness({}, { FAKE_ACC_MODE: "dirty" });
  try {
    const stage = await runAcceptanceStage(h.deps());
    assert.equal(stage.kind, "judged");
    if (stage.kind !== "judged") return;
    assert.equal(stage.record.verdict, "无法验收");
    assert.equal(stage.record.blocker, "数据不干净");
    assert.match(readFileSync(join(stage.record.runDir, "input.md"), "utf8"), /程序没有配置数据重置[\s\S]*数据不是初始状态/);
    assert.match(blockerHint(stage.record, h.work, h.config), /没有配置 acceptance\.reset[\s\S]*【块 2】/);
    const withReset = parseAcceptanceConfig({ reset: "true" }, h.work, process.env)!;
    assert.match(blockerHint(stage.record, h.work, withReset), /没能把数据恢复到初始状态/);
  } finally { h.close(); }
});

test("A26 reset 配置、提示词硬规则、重做输入", () => {
  const config = parseAcceptanceConfig({ reset: "sh deploy/reset.sh" }, "/p")!;
  assert.equal(config.reset, "sh deploy/reset.sh");
  assert.equal(config.resetTimeoutSec, DEFAULT_RESET_TIMEOUT_SEC);
  assert.equal(parseAcceptanceConfig({}, "/p")!.reset, undefined);
  assert.throws(() => parseAcceptanceConfig({ reset: "" }, "/p"), /reset/);
  assert.throws(() => parseAcceptanceConfig({ resetTimeoutSec: 0 }, "/p"), /resetTimeoutSec/);
  const prompt = readFileSync(ACCEPTANCE_PROMPT_PATH, "utf8");
  assert.match(prompt, /## 不要动被测系统/);
  assert.match(prompt, /不要启动、停止、重启它，不要 kill、pkill 任何进程/);
  assert.match(prompt, /原因写「数据不是初始状态」/);
  const preview = { verdict: "无法验收" as const, items: [{ id: "A1", text: "t", verdict: "无法验证" as const, detail: "没证据", evidenceProblem: true }], logErrors: [], extra: [], runDir: "/run" };
  assert.match(buildCorrectionInput(preview, false), /重做这几条[\s\S]*同一次更正未重置数据[\s\S]*不要启动、停止、重启被测系统/);
  assert.match(buildCorrectionInput(preview, true), /从头重做[\s\S]*从 A1 起全部重新实测/);
});

test("A27 Hook 的子进程被取消时连同后代一起杀掉（验收方起的子进程不留下）", async () => {
  const root = mkdtempSync(join(tmpdir(), "autoreview-abort-"));
  const pidFile = join(root, "child.pid");
  const controller = new AbortController();
  try {
    const exec = createChildExec()("/bin/sh", ["-c", `sleep 30 & echo $! > ${pidFile}; wait`], { cwd: root, timeout: 60_000, signal: controller.signal });
    for (let i = 0; i < 50 && !existsSync(pidFile); i += 1) await new Promise((r) => setTimeout(r, 50));
    const grandchild = Number(readFileSync(pidFile, "utf8"));
    controller.abort();
    const result = await exec;
    assert.equal(result.killed, true);
    // 被杀掉的孙进程可能还是僵尸（等 init 回收），只看它是不是还在运行。
    const running = (): boolean => {
      const res = spawnSync("ps", ["-o", "stat=", "-p", String(grandchild)], { encoding: "utf8" });
      return res.status === 0 && !res.stdout.trim().startsWith("Z");
    };
    for (let i = 0; i < 20 && running(); i += 1) await new Promise((r) => setTimeout(r, 50));
    assert.equal(running(), false, "后台的 sleep 也被杀掉");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("A28 [人工] 标记：开头（可在别的标签或「操作：」之后）的 [人工]/【人工】才算；判为需人工，不影响打回与暂停", () => {
  for (const text of ["[人工] 操作：在桌面客户端点同步", "【人工】操作：看弹窗", "[乙] [人工] 操作：x", "操作：[人工] 在 WB 里点接入", " [ 人工 ] 操作：x"]) {
    assert.ok(isManualCriterion(text), text);
  }
  for (const text of ["操作：打开页面 [人工]", "[人工智能] 操作：x", "操作：查看人工审核列表", "操作：x\n预期：显示 [人工] 标签"]) {
    assert.ok(!isManualCriterion(text), text);
  }
  const items = [{ id: "A1", text: "操作：add\n预期：已添加" }, { id: "A2", text: "[人工] 操作：在桌面客户端点同步\n预期：网页多一条" }];
  const report = (lines: string[]) => {
    const parsed = parseAcceptanceReport(["## 结论：通过", "## 逐条结果", ...lines].join("\n"));
    assert.ok(parsed.ok);
    return parsed.ok ? parsed.report : undefined;
  };
  const passed = judgeAcceptance({
    criteria: items, logErrors: [], runDir: "/run", hasService: true,
    report: report(["A1：通过", "- 证据摘录：已添加"]), evidence: evidenceOf({ A1: block("A1", "已添加") }),
  });
  assert.equal(passed.verdict, "部分验证", "自动的全部通过、还有 [人工] 条目 → 部分验证，照常评审");
  assert.deepEqual(passed.items.map((item) => [item.id, item.verdict]), [["A1", "通过"], ["A2", "需人工"]]);
  assert.equal(passed.reason, "A2 标了 [人工]，需要人工验收");
  assert.equal(passed.note, undefined, "验收方只验了自动的条目，自报「通过」不算矛盾");
  assert.equal(passed.items[1].evidenceProblem, undefined, "验收方没报 [人工] 条目不算它没做好");

  const failed = judgeAcceptance({
    criteria: items, logErrors: [], runDir: "/run", hasService: true,
    report: report(["A1：不通过", "- 实际：报错", "- 证据摘录：报错"]), evidence: evidenceOf({ A1: block("A1", "报错") }),
  });
  assert.equal(failed.verdict, "不通过");
  const allUnknown = judgeAcceptance({
    criteria: items, logErrors: [], runDir: "/run", hasService: true,
    report: report(["A1：无法验证", "- 原因：标准含糊"]), evidence: evidenceOf({}),
  });
  assert.equal(allUnknown.verdict, "无法验收", "自动的条目全都没验证 → 无法验收（[人工] 条目不算数）");
  assert.equal(allUnknown.blocker, "其他");
  const mixed = judgeAcceptance({
    criteria: [...items, { id: "A3", text: "操作：list\n预期：有买菜" }], logErrors: [], runDir: "/run", hasService: true,
    report: report(["A1：通过", "- 证据摘录：已添加", "A3：无法验证", "- 原因：标准含糊"]), evidence: evidenceOf({ A1: block("A1", "已添加") }),
  });
  assert.equal(mixed.reason, "A3 没能自动验证，A2 标了 [人工]，需要人工验收");
  const crashed = judgeAcceptance({ criteria: items, logErrors: [], runDir: "/run", hasService: true, systemFailure: "起不来", evidence: evidenceOf({}) });
  assert.equal(crashed.verdict, "不通过");
  assert.deepEqual(crashed.items.map((item) => [item.id, item.verdict]), [["G1", "不通过"], ["A2", "需人工"]], "系统起不来时 [人工] 条目照样列出");

  const criteria: Criteria = { source: "用户", items, version: 1, updatedAt: "" };
  const input = buildAcceptanceInput({ round: 1, criteria, workDir: "/w", runDir: "/r", logFiles: [], deliveryNote: "", previousFailed: [] });
  assert.ok(input.includes("A1. 操作：add"));
  assert.ok(!input.includes("A2") && !input.includes("桌面客户端"), "[人工] 条目不交给验收方");

  const allManual = judgeAcceptance({ criteria: [items[1]], logErrors: [], runDir: "/run", hasService: false, evidence: evidenceOf({}) });
  assert.equal(allManual.verdict, "部分验证");
  assert.match(renderAcceptanceForReview({ ...allManual, durationMs: 0 }), /验收标准全部交给用户，程序没有启动系统实测/);
  assert.match(renderAcceptanceForReview({ ...passed, durationMs: 0 }), /此前验收记录：部分验证。A2 标了 \[人工\]，需要人工验收/);
});

test("A29 一轮验收：[人工] 条目不出现在验收方输入里；标准全是 [人工] 时不启动系统、不调验收方", async () => {
  const h = await harness({ start: "node server.mjs {port}", readyUrl: "http://127.0.0.1:{port}/health" }, { FAKE_ACC_URL: "http://127.0.0.1:{port}/" });
  try {
    h.state.requirement = "做待办\n## 验收标准\n1. 操作：GET /\n   预期：返回买菜\n2. [人工] 操作：在桌面客户端里看同步状态\n   预期：显示已同步";
    const mixed = await runAcceptanceStage(h.deps());
    assert.equal(mixed.kind, "judged");
    if (mixed.kind !== "judged") return;
    assert.equal(mixed.record.verdict, "部分验证");
    assert.deepEqual(mixed.record.items.map((item) => [item.id, item.verdict]), [["A1", "通过"], ["A2", "需人工"]]);
    const input = readFileSync(join(mixed.record.runDir, "input.md"), "utf8");
    assert.ok(input.includes("A1. 操作：GET /") && !input.includes("桌面客户端"), "验收方看不到 [人工] 条目");
    assert.equal(h.calls().length, 1);

    h.state.criteria = undefined;
    h.state.requirement = "做待办\n## 验收标准\n1. 【人工】操作：在桌面客户端里看同步状态\n   预期：显示已同步";
    const manualOnly = await runAcceptanceStage(h.deps({ config: { ...h.config, start: "exit 1" }, round: 2, runDir: join(h.root, "acc", "r2") }));
    assert.equal(manualOnly.kind, "judged");
    if (manualOnly.kind !== "judged") return;
    assert.equal(manualOnly.record.verdict, "部分验证", "系统起不来也不影响：根本没启动");
    assert.deepEqual(manualOnly.record.items.map((item) => item.verdict), ["需人工"]);
    assert.equal(h.calls().length, 1, "没有调验收方");
    assert.ok(existsSync(join(manualOnly.record.runDir, "result.json")));
  } finally { h.close(); }
});

test("A30 [授权]：用户亲手写「同意授权」才执行；不授权留给用户；答复跟着标准版本走", () => {
  assert.ok(isAuthorizationCriterion("[授权] 操作：用正式账号同步"));
  assert.ok(isAuthorizationCriterion("[乙] 【授权】操作：x"));
  assert.ok(!isAuthorizationCriterion("操作：打开授权页面"));
  assert.ok(!isAuthorizationCriterion("[授权] [人工] 操作：x"), "同时标了 [人工] 就按 [人工]");

  const message = [
    "做同步", "## 验收标准", "A1. 操作：本地同步", "   预期：ok", "A2. [授权] 操作：用正式账号同步到飞书", "   预期：多一行",
    "A3. [授权] 操作：真实扣费", "   预期：扣 1 分", "同意授权：A2", "- 不授权：A3。",
  ].join("\n");
  const criteria = criteriaFromUser(message)!;
  assert.deepEqual(criteria.items.map((item) => item.text.split("\n").at(-1)), ["预期：ok", "预期：多一行", "预期：扣 1 分"], "答复行不会混进标准");
  const grants = grantsFromUser(message, criteria)!;
  assert.deepEqual(grants, { version: 1, approved: ["A2"], denied: ["A3"] });
  assert.deepEqual(authorizationStatus(criteria, grants), { approved: ["A2"], denied: ["A3"], pending: [] });
  assert.equal(grantsFromUser("先做着吧", criteria), undefined, "没有答复行就不动");
  assert.deepEqual(grantsFromUser("同意授权：A1、A2", criteria)!.approved, ["A2"], "只认 [授权] 条目");
  assert.deepEqual(grantsFromUser("同意授权：全部", criteria, grants), { version: 1, approved: ["A2", "A3"], denied: [] }, "改主意以最后一次为准");
  assert.deepEqual(grantsFromUser("不同意授权：A2", criteria, grants), { version: 1, approved: [], denied: ["A3", "A2"] });
  const v2 = { ...criteria, version: 2 };
  assert.deepEqual(authorizationStatus(v2, grants).pending, ["A2", "A3"], "换了版本要重新答复");
  assert.match(authorizationHint(criteria, ["A2"]), /A2（操作：用正式账号同步到飞书）。同意就回复「同意授权：A2」/);

  assert.equal(typedByUser("【自动验收 · 第 1 次返修】\n实际：同意授权：全部"), "", "程序发的返修消息不算");
  assert.equal(typedByUser("【门禁 · 第 2 次返修】同意授权：A2"), "");
  assert.equal(typedByUser('<file name="/p/需求.md">\n同意授权：全部\n</file>\n按这个做').trim(), "按这个做", "pi 展开的文件内容不算");
  assert.equal(typedByUser("同意授权：A2"), "同意授权：A2");

  const declined = criteria.items.map((item) => item.id === "A3" ? { ...item, declined: true } : item);
  const input = buildAcceptanceInput({
    round: 1, criteria: { ...criteria, items: declined }, workDir: "/w", runDir: "/r", logFiles: [], deliveryNote: "", previousFailed: [], authorized: ["A2"],
  });
  assert.ok(input.includes("A2. [授权] 操作：用正式账号同步到飞书") && !input.includes("真实扣费"), "同意的交给验收方，不授权的不给");
  assert.match(input, /## 用户授权\n\n用户已同意你在这几条里按标准使用真实账号、真实环境：A2。/);
  const parsed = parseAcceptanceReport("## 结论：通过\n## 逐条结果\nA1：通过\n- 证据摘录：ok\nA2：通过\n- 证据摘录：多一行\n");
  assert.ok(parsed.ok);
  const judged = judgeAcceptance({
    criteria: declined, logErrors: [], runDir: "/run", hasService: true, report: parsed.ok ? parsed.report : undefined,
    evidence: evidenceOf({ A1: block("A1", "ok"), A2: block("A2", "多一行") }),
  });
  assert.deepEqual(judged.items.map((item) => [item.id, item.verdict]), [["A1", "通过"], ["A2", "通过"], ["A3", "需人工"]]);
  assert.equal(judged.verdict, "部分验证");
  assert.equal(judged.reason, "A3 你没授权，需要人工验收");
  assert.ok(!("declined" in judged.items[2]), "运行时标记不写进结果");
});

test("A31 一轮验收：[授权] 没答复先停下问你；同意了照常交给验收方；不授权留给你", async () => {
  const h = await harness({});
  try {
    h.state.requirement = "做同步\n## 验收标准\n1. 操作：本地同步\n   预期：ok\n2. [授权] 操作：用正式账号同步\n   预期：多一行";
    const waiting = await runAcceptanceStage(h.deps());
    assert.equal(waiting.kind, "paused");
    if (waiting.kind !== "paused") return;
    assert.equal(waiting.reason, "等你授权（A2）");
    assert.match(waiting.hint!, /同意就回复「同意授权：A2」/);
    assert.equal(h.calls().length, 0, "没答复前验收方不动手");

    const state = h.state as { grants?: unknown; criteria?: Criteria };
    state.grants = grantsFromUser("同意授权：A2", state.criteria);
    const approved = await runAcceptanceStage(h.deps());
    assert.equal(approved.kind, "judged");
    if (approved.kind !== "judged") return;
    assert.equal(approved.record.verdict, "通过");
    assert.match(readFileSync(join(approved.record.runDir, "input.md"), "utf8"), /A2\. \[授权\] 操作：用正式账号同步[\s\S]*## 用户授权/);

    state.grants = grantsFromUser("不授权：A2", state.criteria, state.grants as never);
    const denied = await runAcceptanceStage(h.deps({ round: 2, runDir: join(h.root, "acc", "r2") }));
    assert.equal(denied.kind, "judged");
    if (denied.kind !== "judged") return;
    assert.deepEqual(denied.record.items.map((item) => [item.id, item.verdict]), [["A1", "通过"], ["A2", "需人工"]]);
    assert.ok(!readFileSync(join(denied.record.runDir, "input.md"), "utf8").includes("正式账号"));
  } finally { h.close(); }
});


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


test("A33 项目释放脚本始终运行，失败不能发布成功", async () => {
  const h = await harness({ cleanup: 'echo "$AUTOREVIEW_RUN_ID"; echo release-failed >&2; exit 75', env: { AUTOREVIEW_RUN_ID: "foreign-task", AUTOREVIEW_RUN_DIR: "/not-this-run" } });
  try {
    const outcome = await runAcceptanceStage(h.deps());
    assert.equal(outcome.kind, "judged");
    if (outcome.kind !== "judged") return;
    assert.equal(outcome.record.verdict, "无法验收");
    assert.equal(outcome.record.failureKind, "environment");
    assert.match(readFileSync(join(outcome.record.runDir, "cleanup.log"), "utf8"), /release-failed/);
    assert.match(outcome.record.cleanup!.join("\n"), /资源释放未确认/);
    const identity = JSON.parse(readFileSync(join(outcome.record.runDir, "cleanup-task.json"), "utf8"));
    assert.equal(identity.status, "failed");
    const log = readFileSync(join(outcome.record.runDir, "cleanup.log"), "utf8");
    assert.ok(log.includes(identity.runId)); assert.doesNotMatch(log, /foreign-task/);
  } finally { h.close(); }
});


test("A34 检查点全部通过也不能掩盖执行器资源释放失败", async () => {
  const h = await harness({}, { FAKE_ACC_MODE: "checkpoint-all" });
  try {
    const deps = h.deps(), exec = deps.exec;
    deps.exec = async (command, args, options) => {
      const result = await exec(command, args, options);
      return options.role === "验收方" ? { ...result, code: 75, stderr: "AUTOREVIEW_FAILURE=environment 子进程释放未确认，登记已保留" } : result;
    };
    const outcome = await runAcceptanceStage(deps);
    assert.equal(outcome.kind, "judged");
    if (outcome.kind !== "judged") return;
    assert.ok(outcome.record.items.every((item) => item.verdict === "通过"), "保留已取得的逐项业务证据");
    assert.equal(outcome.record.verdict, "无法验收");
    assert.equal(outcome.record.failureKind, "environment");
    assert.match(outcome.record.reason!, /释放未确认/);
    assert.equal(h.calls().length, 1, "执行器错误不重复派给验收模型");
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

test("项目方法三个环境变量：启动、重置、验收命令都拿到同一份", async () => {
  const envLog = (name: string) => `printf '%s|%s|%s\\n' "$AUTOREVIEW_BASE_REV" "$AUTOREVIEW_BATCH_FILE" "$AUTOREVIEW_STAGE" >> "$AUTOREVIEW_RUN_DIR/../${name}"`;
  const testerLog = join(tmpdir(), `autoreview-tester-env-${process.pid}-${Date.now()}.log`);
  const h = await harness({
    start: `${envLog("start.env")}; exec node server.mjs {port}`,
    readyUrl: "http://127.0.0.1:{port}/health",
    reset: envLog("reset.env"),
  }, { FAKE_ACC_ENV_LOG: testerLog });
  try {
    const env = { AUTOREVIEW_BASE_REV: "base-rev", AUTOREVIEW_BATCH_FILE: "/tmp/批次.json", AUTOREVIEW_STAGE: "甲" };
    const stage = await runAcceptanceStage(h.deps({ env }));
    assert.equal(stage.kind, "judged", JSON.stringify(stage));
    const expected = "base-rev|/tmp/批次.json|甲";
    for (const file of ["start.env", "reset.env"]) {
      assert.equal(readFileSync(join(h.root, "acc", file), "utf8").trim(), expected, file);
    }
    assert.equal(readFileSync(testerLog, "utf8").trim(), expected, "验收命令");
  } finally {
    rmSync(testerLog, { force: true });
    h.close();
  }
});

// 本任务 A1–A4：用秒级空闲时限模拟真实断线，不等待分钟级整轮预算。
function acceptanceSummary(record: AcceptanceRecord): string {
  return renderSummary({ cwd: "/work", devSessionId: "dev", reviewerSessionId: "rev", status: record.verdict === "无法验收" ? "暂停" : "完成",
    pauseReason: record.reason, repairs: 0, gitStatusShort: "", rounds: [{ round: 1, startedAt: "", durationMs: record.durationMs,
      conclusion: "评审通过", mustFix: [], mustFixRaw: "无", minor: [], questions: [], recheck: [], acceptance: record }] });
}

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

test("返修1：执行器 reject 取消而未提供释放证明时暂停，不得进入补判", async () => {
  const h = await harness({ idleTimeoutSec: 1 });
  try {
    let calls = 0;
    const stage = await runAcceptanceStage(h.deps({ config: { ...h.config, testerCmd: "" }, exec: async (_command, _args, options) => {
      calls += 1;
      assert.equal(calls, 1, "无释放证明时不得调补报告");
      for (const { id } of criteriaItems) writeFileSync(join(options.cwd, "evidence", `${id}.txt`), block(id, "已完成"));
      return new Promise((_resolve, reject) => options.signal?.addEventListener("abort", () => reject(new Error("AbortError")), { once: true }));
    } }));
    assert.equal(stage.kind, "judged"); if (stage.kind !== "judged") return;
    assert.equal(calls, 1);
    assert.ok(stage.record.items.every((item) => item.verdict === "无法验证"));
    assert.equal(stage.record.recovery, undefined);
    assert.equal(stage.record.verdict, "无法验收");
    assert.equal(stage.record.failureKind, "environment");
    assert.match(stage.record.reason!, /子进程释放未确认/);
  } finally { h.close(); }
});

test("返修1：全部结果和证据通过，但执行器没有释放证明时仍须暂停", async () => {
  const h = await harness({});
  try {
    let calls = 0;
    const stage = await runAcceptanceStage(h.deps({ exec: async (_command, _args, options) => {
      calls += 1;
      for (const { id } of criteriaItems) writeFileSync(join(options.cwd, "evidence", `${id}.txt`), block(id, "已完成"));
      return { stdout: "## 逐条结果\nA1：通过\n- 证据摘录：已完成\nA2：通过\n- 证据摘录：已完成", stderr: "", code: 0, killed: false };
    } }));
    assert.equal(stage.kind, "judged"); if (stage.kind !== "judged") return;
    assert.ok(stage.record.items.every((item) => item.verdict === "通过"));
    assert.equal(stage.record.verdict, "无法验收");
    assert.match(stage.record.reason!, /子进程释放未确认/);
    assert.equal(calls, 1);
    assert.equal(stage.record.recovery, undefined);
  } finally { h.close(); }
});

test("返修1：空闲中止后独立进程组的工具子进程必须真实停止，不能仅看登记为空", async () => {
  const h = await harness({ idleTimeoutSec: 2 }, { AUTOREVIEW_ACCEPTANCE_CMD: STALLED_TESTER, FAKE_ACC_MODE: "stall-detached" });
  let detached: { pid: number; token: string } | undefined;
  const running = (pid: number): boolean => {
    const result = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
    return result.status === 0 && !result.stdout.trim().startsWith("Z");
  };
  try {
    const stage = await runAcceptanceStage(h.deps());
    assert.equal(stage.kind, "judged"); if (stage.kind !== "judged") return;
    detached = JSON.parse(readFileSync(join(stage.record.runDir, "detached.json"), "utf8"));
    assert.equal(stage.record.verdict, "通过");
    assert.equal(running(detached!.pid), false, "原 Pi 进程组外的工具仍在运行时不得发布完成");
    const writes = join(stage.record.runDir, "detached-writes");
    const before = readFileSync(writes, "utf8");
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(readFileSync(writes, "utf8"), before, "完成之后脚本不能继续写数据");
    assert.deepEqual(readProcs(h.procsFile), []);
  } finally {
    if (detached && running(detached.pid)) {
      const env = spawnSync("ps", ["eww", "-p", String(detached.pid), "-o", "command="], { encoding: "utf8" });
      if (env.stdout.split(/\s+/).includes(`AUTOREVIEW_PROCESS_OWNER=${detached.token}`)) process.kill(detached.pid, "SIGKILL");
    }
    h.close();
  }
});

test("返修1：跨组进程扫描失败时保留登记并暂停，已有全部通过检查点也不能补判放行", async () => {
  const h = await harness({ idleTimeoutSec: 2 }, { AUTOREVIEW_ACCEPTANCE_CMD: STALLED_TESTER, FAKE_ACC_MODE: "stall-detached", FAKE_FAIL_PROCESS_SCAN: "1" });
  const path = process.env.PATH;
  try {
    const deps = h.deps(), execute = deps.exec;
    deps.exec = (command, args, options) => execute(command, args, { ...options, onOutput: (text) => {
      options.onOutput?.(text);
      if (text.includes("PROCESS_SCAN_READY")) process.env.PATH = join(h.root, "no-ps-here");
    } });
    const stage = await runAcceptanceStage(deps);
    assert.equal(stage.kind, "judged"); if (stage.kind !== "judged") return;
    assert.ok(stage.record.items.every((item) => item.verdict === "通过"));
    assert.equal(stage.record.verdict, "无法验收");
    assert.equal(stage.record.failureKind, "environment");
    assert.match(stage.record.reason!, /资源释放|归属/);
    assert.ok(readProcs(h.procsFile).length > 0, "不能因原组消失就注销，须留待按身份补偿");
    assert.equal(h.calls().length, 1, "清理失败不能转入强模型补判");
  } finally {
    if (path === undefined) delete process.env.PATH; else process.env.PATH = path;
    reapProcs(h.procsFile, { ownerPid: process.pid });
    assert.deepEqual(readProcs(h.procsFile), [], "恢复查询后按保留的身份清理独立子进程");
    h.close();
  }
});

test("返修2：1秒空闲阈值不能截断等待3秒超时的实测命令", async () => {
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

test("返修2：直接 bash 工具等待不算模型空闲；工具结束后真正模型挂住仍及时补判", async () => {
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

test("返修2：等待实测时整轮预算仍生效，中止不归为模型断线且不补判", async () => {
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

test("第2次返修：同批快慢工具并行，快工具5秒上限不截断20秒慢工具，延迟落盘后仍完整留证通过", async () => {
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

test("第3次返修：工具刚结束、下一次轮询前模型断线，须按最新生命周期补判", async (t) => {
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

test("第3次返修：预算中止前工具确实在执行，清理后进程和标记消失也不能改判为模型断线", async () => {
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

test("共享执行器实时上报 stdout/stderr 活动，不等到进程结束", async () => {
  const root = mkdtempSync(join(tmpdir(), "autoreview-output-"));
  try {
    const chunks: string[] = [];
    const result = await createChildExec()(process.execPath, ["-e", 'console.log("stdout pulse"); console.error("stderr pulse"); setTimeout(() => {}, 50)'],
      { cwd: root, timeout: 5000, onOutput: (chunk) => chunks.push(chunk) });
    assert.equal(result.code, 0);
    assert.match(chunks.join(""), /stdout pulse/);
    assert.match(chunks.join(""), /stderr pulse/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("无法验证不能空原因或仅写漏报；命令只取块头，最多三条且截长，脚本保留完整路径", () => {
  const missingReasons: Record<string, string>[] = [{}, { "原因": "   " }, { "原因": "验收方没有报告这一条" }];
  for (const fields of missingReasons) {
    const record = judgeAcceptance({ criteria: criteriaItems.slice(0, 1), report: { conclusion: "", extra: [], items: [{ id: "A1", verdict: "无法验证", fields }] },
      evidence: () => undefined, logErrors: [], hasService: false, runDir: "/run" });
    assert.match(record.items[0].detail, /未说明无法执行的步骤或具体阻塞条件/);
    assert.equal(record.items[0].cause, "验收方");
  }
  const content = Array.from({ length: 4 }, (_, i) => `=== A1 #${i + 1} 2026-10-27T00:00:00Z\n$ node \"checks/带 空格.mjs\" ${"x".repeat(300)}\n目录：/run\n--- 标准输出\n$ 不是实际命令\n`).join("");
  const execution = evidenceExecution(content, "/run", ["/run/checks/带 空格.mjs"]);
  assert.equal(execution.commands.length, 3);
  assert.ok(execution.commands.every((command) => command.length === 240 && command.endsWith("…")));
  assert.deepEqual(execution.scripts, ["/run/checks/带 空格.mjs"]);
});
