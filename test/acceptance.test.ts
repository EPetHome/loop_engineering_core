/** 自动验收：纯函数（取标准、解析、判定、消息）与一轮验收流程（真起被测系统）；产物只写 os.tmpdir()。 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  ACCEPTANCE_CONVENTION, buildAcceptanceInput, buildAcceptanceRepairMessage, buildCorrectionInput, classifySystemExit,
  criteriaFromUser, extractCriteria, findObjections, judgeAcceptance, lastEvidenceAt, parseAcceptanceReport,
  parseCriteriaDraft, scanLogs, MAX_CRITERIA, NO_PLAYWRIGHT,
  type AcceptanceRecord, type Criteria,
} from "../acceptance-core.ts";
import { ACCEPTANCE_PROMPT_PATH, parseElapsed, runAcceptanceStage, type AcceptanceDeps } from "../acceptance.ts";
import { checkAcceptanceBudget, DEFAULT_ACCEPTANCE_MODEL, DEFAULT_RESET_TIMEOUT_SEC, parseAcceptanceConfig } from "../config.ts";
import { blockerHint } from "../onboarding.ts";
import { createChildExec } from "../hosts/hook.ts";
import { readProcs } from "../procs.ts";

const TESTER = fileURLToPath(new URL("./fake-tester.mjs", import.meta.url));
const DRAFTER = fileURLToPath(new URL("./fake-drafter.mjs", import.meta.url));

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
  assert.deepEqual(findObjections("A1：已修\nA2：异议：标准写错了\n- G2: 异议 日志是故意的"), ["A2", "G2"]);
  assert.deepEqual(findObjections("第 1 条：异议：评审的"), []);
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
  assert.deepEqual(config.logs, ["/p/logs/app.log"]);
  assert.equal(config.guide, "/p/docs/use.md");
  assert.ok(config.errorPatterns.includes("ERROR"));
  assert.throws(() => parseAcceptanceConfig({ readyUrl: "ftp://x" }, "/p"), /readyUrl/);
  assert.throws(() => parseAcceptanceConfig({ logs: "a.log" }, "/p"), /logs/);
  assert.throws(() => parseAcceptanceConfig({ timeoutMin: 0 }, "/p"), /timeoutMin/);
  assert.throws(() => parseAcceptanceConfig({ env: { A: 1 } }, "/p"), /env/);
  assert.throws(() => parseAcceptanceConfig([], "/p"), /acceptance/);
  assert.throws(() => checkAcceptanceBudget(20, config), /必须小于/);
  checkAcceptanceBudget(60, config);
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
  const vars = { AUTOREVIEW_ACCEPTANCE_CMD: TESTER, AUTOREVIEW_CRITERIA_CMD: DRAFTER, FAKE_STATE_DIR: join(root, "fake"), ...env };
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

test("A12 开发方对标准提异议：直接暂停交给用户，不跑验收", async () => {
  const h = await harness({});
  try {
    const stage = await runAcceptanceStage(h.deps({ deliveryNote: "A1：已修\nA2：异议：标准和需求矛盾\n【交付完成】" }));
    assert.equal(stage.kind, "paused");
    if (stage.kind === "paused") assert.equal(stage.reason, "开发方对验收标准有异议（A2）");
    assert.deepEqual(h.calls(), []);
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
  assert.deepEqual(extractCriteria(snippet)?.map((item) => item.id), ["A1", "A2"], "追加段里的示例格式能被程序取到");
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
  assert.deepEqual(findObjections("**A2**：异议：标准写错了"), ["A2"]);
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
    assert.match((stage.record.cleanup ?? []).join("\n"), /验收期间起的进程 pid \d+（.*），不是程序启动的被测系统，已关掉/);
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

test("A23 配了 reset：每次调验收方前由程序重置，输出不进系统日志；重做时要求从头全部重测", async () => {
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
    assert.equal(readFileSync(join(runDir, "reset-count"), "utf8").trim().split("\n").length, 2, "第 1 次和重做前各重置一次");
    const resetLog = readFileSync(join(runDir, "reset.log"), "utf8");
    assert.match(resetLog, /重做前/);
    assert.match(resetLog, /ENV_OK/, "重置命令拿得到被测系统的环境变量");
    assert.doesNotMatch(readFileSync(join(runDir, "system.log"), "utf8"), /重置时打的/);
    assert.match(readFileSync(join(runDir, "correction.md"), "utf8"), /已把数据重置到初始状态[\s\S]*从 A1 起全部重新实测/);
    assert.match(readFileSync(join(runDir, "input.md"), "utf8"), /每次验收前都已把数据重置到初始状态/);
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
  assert.match(buildCorrectionInput(preview, false), /重做这几条[\s\S]*数据不是初始状态[\s\S]*不要启动、停止、重启被测系统/);
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
