/** 自动验收：纯函数（取标准、解析、判定、消息）与一轮验收流程（真起被测系统）；产物只写 os.tmpdir()。 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  ACCEPTANCE_CONVENTION, buildAcceptanceInput, buildAcceptanceRepairMessage, criteriaFromUser, extractCriteria,
  findObjections, judgeAcceptance, parseAcceptanceReport, parseCriteriaDraft, scanLogs, MAX_CRITERIA,
  type AcceptanceRecord, type Criteria,
} from "../acceptance-core.ts";
import { runAcceptanceStage, type AcceptanceDeps } from "../acceptance.ts";
import { checkAcceptanceBudget, DEFAULT_ACCEPTANCE_MODEL, parseAcceptanceConfig } from "../config.ts";
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
    criteria: criteriaItems, logErrors: [], runDir: "/run",
    report: report(["A1：通过", "- 证据摘录：「已添加」", "A2：通过", "- 证据摘录：买菜   牛奶"]),
    evidence: evidenceOf({ A1: block("A1", "已添加"), A2: block("A2", "买菜\n牛奶") }),
  });
  assert.equal(passed.verdict, "通过", "去掉引号、折叠空白后能在证据里找到");

  const lazy = judgeAcceptance({
    criteria: criteriaItems, logErrors: [], runDir: "/run",
    report: report(["A1：通过", "- 证据摘录：已添加", "A2：通过", "- 证据摘录：编的"]),
    evidence: evidenceOf({ A2: block("A2", "买菜") }),
  });
  assert.equal(lazy.verdict, "无法验收");
  assert.ok(lazy.items.every((item) => item.verdict === "无法验证" && item.evidenceProblem));
  assert.match(lazy.items[0].detail, /没有用 \.\/ev/);
  assert.match(lazy.items[1].detail, /证据摘录在 \/run\/evidence\/A2\.txt 里找不到/);

  const failed = judgeAcceptance({
    criteria: criteriaItems, logErrors: ["[12:00] ERROR boom"], runDir: "/run",
    report: report(["A1：通过", "- 证据摘录：已添加", "A2：不通过", "- 复现：list", "- 预期：有买菜", "- 实际：空", "- 证据摘录：（空）"]),
    evidence: evidenceOf({ A1: block("A1", "已添加"), A2: block("A2", "（空）") }),
  });
  assert.equal(failed.verdict, "不通过");
  assert.deepEqual(failed.items.map((item) => [item.id, item.verdict]), [["A1", "通过"], ["A2", "不通过"], ["G2", "不通过"]]);
  assert.match(failed.note!, /自报「通过」，程序按逐条结果判为「不通过」/);

  const missing = judgeAcceptance({
    criteria: criteriaItems, logErrors: [], runDir: "/run",
    report: report(["A1：通过", "- 证据摘录：已添加"]), evidence: evidenceOf({ A1: block("A1", "已添加") }),
  });
  assert.equal(missing.verdict, "无法验收");
  assert.equal(missing.reason, "A2 无法验证");

  const down = judgeAcceptance({ criteria: criteriaItems, logErrors: [], runDir: "/run", evidence: () => undefined, systemFailure: "系统启动后就退出了" });
  assert.equal(down.verdict, "不通过");
  assert.deepEqual(down.items.map((item) => item.id), ["G1"]);

  const silent = judgeAcceptance({ criteria: criteriaItems, logErrors: [], runDir: "/run", evidence: () => undefined, reportError: "两次都无法解析" });
  assert.equal(silent.verdict, "无法验收");
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
import { createServer } from "node:http";
const port = Number(process.argv[2]);
createServer((req, res) => {
  if (req.url === "/boom") console.error("ERROR boom at " + req.url);
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

test("A11 验收方输出乱写两次：无法验收；需求里没标准时先起草一次并冻结", async () => {
  const h = await harness({}, { FAKE_ACC_MODE: "garbage" });
  try {
    h.state.requirement = "做一个待办命令行";
    const stage = await runAcceptanceStage(h.deps());
    assert.equal(h.state.criteria?.source, "自动起草");
    assert.equal(h.state.criteria?.items.length, 2);
    assert.equal(stage.kind, "judged");
    if (stage.kind !== "judged") return;
    assert.equal(stage.record.verdict, "无法验收");
    assert.match(stage.record.items[0].detail, /无法解析/);
    assert.equal(h.calls().length, 2);
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
