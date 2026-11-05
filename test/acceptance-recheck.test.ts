/** 验收范围、完成前完整验收与来源追溯：替身验收方 + 系统临时 Git 仓库。 */
import "./test-env.ts";
import "./helpers/git-runtime.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { extractCriteria, type AcceptanceRecord } from "../acceptance-core.ts";
import { parseAcceptanceConfig } from "../config.ts";
import { renderDeliveryReport, renderSummary } from "../core.ts";
import { createChildExec } from "../hosts/review-hook.ts";
import { newReviewState, runReviewRound, type ReviewConfig, type ReviewDeps, type ReviewState } from "../review.ts";

const TESTER = fileURLToPath(new URL("./fake-tester.mjs", import.meta.url));
const IDS = ["A1", "A2", "A3", "A4", "A5"];
const STANDARD = `## 验收标准\n${IDS.map((id) => `${id}. 操作：运行功能 ${id}\n    预期：看到了 ${id}`).join("\n")}\n`;
const PASS = "## 结论：通过\n## 必修\n无\n";

function fixture(results: { fail?: string[]; unknown?: string[] }[]) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "loop-acceptance-recheck-"))), repo = join(root, "repo");
  mkdirSync(repo);
  const env = { ...process.env, AUTOREVIEW_RESOURCE_ROOT: join(root, "resources"), AUTOREVIEW_PROJECTS_ROOT: join(root, "projects"),
    FAKE_STATE_DIR: join(root, "fake"), FAKE_ACC_MODE: "pass", FAKE_ACC_FAIL: "", FAKE_ACC_FAIL_ONCE: "", FAKE_ACC_UNKNOWN: "",
    FAKE_ACC_RESULTS: JSON.stringify(results), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  const saved = Object.fromEntries(["AUTOREVIEW_RESOURCE_ROOT", "AUTOREVIEW_PROJECTS_ROOT"].map((key) => [key, process.env[key]]));
  process.env.AUTOREVIEW_RESOURCE_ROOT = env.AUTOREVIEW_RESOURCE_ROOT;
  process.env.AUTOREVIEW_PROJECTS_ROOT = env.AUTOREVIEW_PROJECTS_ROOT;
  const git = (...args: string[]) => {
    const run = spawnSync("git", args, { cwd: repo, env, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr); return run.stdout.trim();
  };
  git("init", "-qb", "main"); git("config", "user.email", "test@example.invalid"); git("config", "user.name", "test");
  writeFileSync(join(repo, "product.txt"), "initial\n");
  git("add", "."); git("commit", "-qm", "initial");
  const state = newReviewState();
  state.requirement = STANDARD;
  state.criteria = { source: "用户", items: extractCriteria(STANDARD)!, version: 1, updatedAt: "initial" };
  const config: ReviewConfig = { maxRepairs: 4, reviewerModel: "fake", reviewerThinking: "off", reviewerCmd: "", reviewTimeoutMin: 10,
    gate: { cmd: "printf 'full gate\\n'", timeoutMin: 1 },
    acceptance: parseAcceptanceConfig({ timeoutMin: 5, reset: "printf 'reset\\n'", cleanup: "printf 'released\\n'" }, repo, {})! };
  config.acceptance!.testerCmd = TESTER;
  const procsFile = join(root, "procs.json"), exec = createChildExec(procsFile);
  const order: string[] = [], summaryStatuses: string[] = [];
  const deps: ReviewDeps = { cwd: repo, devSessionId: "developer", round: 1, deliveryNote: "【交付完成】", state, config, env, procsFile,
    acceptanceDir: join(root, "acceptance"), saveState: () => {},
    writeInput: (name, text) => { const path = join(root, name); writeFileSync(path, text); return path; },
    writeSummary: async (status) => { summaryStatuses.push(status); },
    callReviewer: async () => { order.push("review"); return { stdout: PASS, stderr: "", code: 0, killed: false }; },
    exec: async (cmd, args, options) => { order.push(options.role ?? "git"); return exec(cmd, args, { ...options, env: { ...env, ...options.env } }); } };
  const calls = () => existsSync(join(root, "fake", "acc-calls.log"))
    ? readFileSync(join(root, "fake", "acc-calls.log"), "utf8").trim().split("\n").map((line) => {
      const [round, input, , runDir] = line.split("\t");
      const section = readFileSync(input, "utf8").split(/^## 验收标准（.*$/m)[1]?.split(/^## /m)[0] ?? "";
      return { round: Number(round), ids: [...section.matchAll(/^(A\d+)\./gm)].map((match) => match[1]), runDir };
    }) : [];
  const summary = (status: "进行中" | "完成") => renderSummary({ cwd: repo, devSessionId: "developer", reviewerSessionId: "reviewer", status,
    rounds: deps.state.rounds, repairs: deps.state.repairs, criteria: deps.state.criteria, gitStatusShort: "" });
  return { root, repo, deps, config, order, summaryStatuses, calls, summary, git,
    deliver: (overrides: Partial<ReviewDeps> = {}) => {
      writeFileSync(join(repo, "product.txt"), `delivery ${deps.state.rounds.length + 1}\n`);
      return runReviewRound({ ...deps, round: deps.state.rounds.length + 1, ...overrides });
    },
    close: () => {
      try {
        if (existsSync(procsFile)) assert.deepEqual(JSON.parse(readFileSync(procsFile, "utf8")), [], "所有验收进程已释放");
        if (existsSync(env.AUTOREVIEW_RESOURCE_ROOT)) for (const name of readdirSync(env.AUTOREVIEW_RESOURCE_ROOT).filter((name) => name.endsWith(".json"))) {
          assert.equal(JSON.parse(readFileSync(join(env.AUTOREVIEW_RESOURCE_ROOT, name), "utf8")).status, "released", name);
        }
      } finally {
        for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
        rmSync(root, { recursive: true, force: true });
      }
    },
  };
}

function latest(state: ReviewState): AcceptanceRecord { return state.rounds.at(-1)!.acceptance!; }

test("返修只重验未通过项，完成前完整验收并逐条标明最终来源", async () => {
  const f = fixture([{ fail: ["A2", "A4"] }, {}, {}]);
  try {
    assert.equal((await f.deliver()).kind, "repair");
    const first = latest(f.deps.state);
    assert.deepEqual(first.scope?.tested, IDS); assert.deepEqual(first.scope?.reused, []);
    assert.equal((await f.deliver()).kind, "done");
    assert.deepEqual(f.calls().map((call) => call.ids), [IDS, ["A2", "A4"], IDS]);
    const attempts = f.deps.state.rounds[1].acceptanceAttempts!;
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0].scope?.kind, "retry");
    assert.deepEqual(attempts[0].scope?.reused, ["A1", "A3", "A5"]);
    for (const item of attempts[0].items.filter((item) => ["A1", "A3", "A5"].includes(item.id))) {
      assert.equal(item.source?.round, 1); assert.equal(item.source?.runDir, first.runDir);
      assert.equal(existsSync(join(attempts[0].runDir, "evidence", `${item.id}.txt`)), false, "没有复制旧证据冒充本轮实测");
    }
    assert.equal(attempts[1].scope?.kind, "full"); assert.equal(attempts[1].verdict, "通过");
    assert.deepEqual(attempts[1].scope?.reused, []);
    assert.deepEqual(f.summaryStatuses, ["进行中", "完成"]);
    assert.deepEqual(f.order.filter((role) => ["review", "门禁", "验收方"].includes(role)), ["review", "门禁", "验收方", "review", "门禁", "验收方", "验收方"]);
    const summary = f.summary("完成");
    assert.match(summary, /本次实测：A2、A4；沿用上一轮结论：A1、A3、A5/);
    for (const item of f.deps.state.criteria!.items) assert.ok(summary.includes(`标准原文：${item.text}`));
    const report = summary.split("<!-- loop-summary-metadata -->")[0];
    assert.equal((report.match(/最终结论来源：第 2 轮完整验收/g) ?? []).length, 5);
    assert.ok(report.includes(attempts[1].runDir));
    for (const call of f.calls()) {
      const record = JSON.parse(readFileSync(join(call.runDir, "result.json"), "utf8"));
      assert.ok(record.scope); assert.match(readFileSync(join(call.runDir, "reset.log"), "utf8"), /reset/);
      assert.equal(JSON.parse(readFileSync(join(call.runDir, "cleanup-task.json"), "utf8")).status, "released");
    }
    assert.equal(f.git("rev-list", "--count", "HEAD"), "1", "开发流程不提交");
  } finally { f.close(); }
});

test("完整验收发现通过项回退后打回，下一轮只重验回退项", async () => {
  const f = fixture([{ fail: ["A2", "A4"] }, {}, { fail: ["A1"] }, {}, {}]);
  try {
    assert.equal((await f.deliver()).kind, "repair");
    const result = await f.deliver();
    assert.equal(result.kind, "repair"); assert.match(result.message!, /A1\. 操作：运行功能 A1[\s\S]*之前通过，这次失败/);
    assert.equal(f.summaryStatuses.includes("完成"), false, "定向通过不能提前宣布完成");
    assert.equal(latest(f.deps.state).items.find((item) => item.id === "A1")?.previouslyPassed, true);
    assert.equal(f.deps.state.repairs, 2);
    assert.equal((await f.deliver()).kind, "done");
    assert.deepEqual(f.calls().map((call) => call.ids), [IDS, ["A2", "A4"], IDS, ["A1"], IDS]);
    assert.equal(f.order.filter((role) => role === "门禁").length, 3);
    assert.equal((f.summary("完成").match(/最终结论来源：第 3 轮完整验收/g) ?? []).length, 5);
  } finally { f.close(); }
});

test("用户替换标准后重新完整验收，包括同文新版本和同编号新内容", async (t) => {
  for (const change of ["version", "content"] as const) await t.test(change, async () => {
    const f = fixture([{ fail: ["A2", "A4"] }, {}]);
    try {
      assert.equal((await f.deliver()).kind, "repair");
      // 模拟持久状态恢复以及真实用户输入入口已经冻结的新标准，不改变解析规则。
      f.deps.state = JSON.parse(JSON.stringify(f.deps.state));
      f.deps.state.criteria!.version += 1;
      f.deps.state.criteria!.updatedAt = "updated";
      if (change === "content") f.deps.state.criteria!.items[0].text += "\n新预期：符合新标准";
      assert.equal((await f.deliver()).kind, "done");
      assert.deepEqual(f.calls().map((call) => call.ids), [IDS, IDS]);
      assert.equal(latest(f.deps.state).scope?.kind, "full");
      assert.deepEqual(latest(f.deps.state).scope?.reused, []);
    } finally { f.close(); }
  });
});

test("无法验证项与失败项一起重验，连续返修保留结论的原始来源", async () => {
  const f = fixture([{ fail: ["A2"], unknown: ["A4"] }, { fail: ["A2"] }, {}, {}]);
  try {
    assert.equal((await f.deliver()).kind, "repair");
    assert.equal((await f.deliver()).kind, "repair");
    const retry = latest(f.deps.state);
    assert.deepEqual(retry.scope?.tested, ["A2", "A4"]);
    assert.equal(retry.items.find((item) => item.id === "A4")?.source?.round, 2);
    assert.equal(retry.items.find((item) => item.id === "A1")?.source?.round, 1);
    assert.equal((await f.deliver()).kind, "done");
    assert.deepEqual(f.calls().map((call) => call.ids), [IDS, ["A2", "A4"], ["A2"], IDS]);
    assert.match(f.summary("完成"), /本次实测：A2；沿用上一轮结论：A1、A3、A4、A5/);
  } finally { f.close(); }
});

test("完整验收自动项无法验证时暂停，再次交付只重验未验证项，人工项不转成自动通过", async () => {
  const f = fixture([{ unknown: ["A4"] }, {}, {}]);
  try {
    f.deps.state.criteria!.items[4].text = "[人工] 操作：查看布局\n预期：符合偏好";
    const result = await f.deliver();
    assert.equal(result.kind, "paused"); assert.match(result.reason!, /完整验收仍有自动条目未通过（A4）/);
    assert.equal(f.summaryStatuses.includes("完成"), false);
    assert.equal(latest(f.deps.state).verdict, "部分验证");
    assert.equal((await f.deliver()).kind, "done");
    assert.deepEqual(f.calls().map((call) => call.ids), [IDS.slice(0, 4), ["A4"], IDS.slice(0, 4)]);
    assert.equal(latest(f.deps.state).items.find((item) => item.id === "A5")?.verdict, "需人工");
    assert.match(f.summary("完成"), /第 2 轮完整验收（该条未实测，留给用户）/);
  } finally { f.close(); }
});

test("完成前完整验收出现无法验证项时不完成，保留原因并在后续交付重验", async () => {
  const f = fixture([{ fail: ["A2", "A4"] }, {}, { unknown: ["A1"] }, {}, {}]);
  try {
    assert.equal((await f.deliver()).kind, "repair");
    const result = await f.deliver();
    assert.equal(result.kind, "paused"); assert.match(result.reason!, /完整验收仍有自动条目未通过（A1）/);
    assert.match(result.notes!, /A1：.*标准写得含糊/);
    const attempts = f.deps.state.rounds[1].acceptanceAttempts!;
    assert.equal(attempts[0].verdict, "通过"); assert.equal(attempts[1].verdict, "部分验证");
    assert.equal(attempts[1].scope?.kind, "full");
    assert.equal(latest(f.deps.state).items.find((item) => item.id === "A1")?.verdict, "无法验证");
    assert.equal(f.summaryStatuses.includes("完成"), false);
    assert.equal(f.deps.state.repairs, 1, "无法验证不能当作产品返修计数");
    assert.deepEqual(f.calls().map((call) => call.ids), [IDS, ["A2", "A4"], IDS]);
    assert.equal((await f.deliver()).kind, "done");
    assert.deepEqual(f.calls().map((call) => call.ids), [IDS, ["A2", "A4"], IDS, ["A1"], IDS]);
  } finally { f.close(); }
});

test("定向复验自动项仍无法验证时暂停，不提前启动完成前完整验收", async () => {
  const f = fixture([{ fail: ["A2", "A4"] }, { unknown: ["A2"] }]);
  try {
    assert.equal((await f.deliver()).kind, "repair");
    const result = await f.deliver();
    assert.equal(result.kind, "paused"); assert.match(result.reason!, /定向复验仍有自动条目未通过（A2）/);
    assert.deepEqual(f.calls().map((call) => call.ids), [IDS, ["A2", "A4"]]);
    assert.equal(f.summaryStatuses.includes("完成"), false);
  } finally { f.close(); }
});

test("完成前完整验收仅剩人工或不授权项时保留既有完成处理", async (t) => {
  for (const kind of ["人工", "授权"] as const) await t.test(kind, async () => {
    const f = fixture([{ fail: ["A2"] }, {}, {}]);
    try {
      f.deps.state.criteria!.items[4].text = `[${kind}] 操作：查看布局\n预期：符合偏好`;
      if (kind === "授权") f.deps.state.grants = { version: 1, approved: [], denied: ["A5"] };
      assert.equal((await f.deliver()).kind, "repair");
      assert.equal((await f.deliver()).kind, "done");
      assert.deepEqual(f.calls().map((call) => call.ids), [IDS.slice(0, 4), ["A2"], IDS.slice(0, 4)]);
      const record = latest(f.deps.state);
      assert.equal(record.scope?.kind, "full"); assert.equal(record.verdict, "部分验证");
      assert.equal(record.items.find((item) => item.id === "A5")?.verdict, "需人工");
      assert.ok(record.items.filter((item) => item.id !== "A5").every((item) => item.verdict === "通过"));
    } finally { f.close(); }
  });
});

test("缺少历史范围身份时保守完整验收，不把旧记录推定为可复用", async () => {
  const f = fixture([{ fail: ["A2"] }, {}]);
  try {
    assert.equal((await f.deliver()).kind, "repair");
    delete latest(f.deps.state).scope;
    assert.equal((await f.deliver()).kind, "done");
    assert.deepEqual(f.calls().map((call) => call.ids), [IDS, IDS]);
  } finally { f.close(); }
});

test("定向复验后的完整验收预算不足时暂停，保留定向记录且下次完整验收", async () => {
  const f = fixture([{ fail: ["A2", "A4"] }, {}, {}]);
  try {
    assert.equal((await f.deliver()).kind, "repair");
    let clock = Date.now();
    const exec = f.deps.exec;
    const result = await f.deliver({ now: () => clock, exec: async (cmd, args, options) => {
      const result = await exec(cmd, args, options);
      if (options.role === "验收方") clock += 5 * 60_000;
      return result;
    } });
    assert.equal(result.kind, "paused"); assert.match(result.reason!, /剩余预算不足/);
    assert.deepEqual(f.calls().map((call) => call.ids), [IDS, ["A2", "A4"]]);
    assert.equal(f.summaryStatuses.includes("完成"), false);
    assert.equal(f.deps.state.rounds[1].acceptanceAttempts?.length, 1);
    assert.equal((await f.deliver()).kind, "done");
    assert.deepEqual(f.calls().map((call) => call.ids), [IDS, ["A2", "A4"], IDS]);
  } finally { f.close(); }
});

test("交付报告沿用项引用原证据目录，不把旧命令说成本轮执行", async () => {
  const f = fixture([{ fail: ["A2", "A4"] }, { fail: ["A2"] }]);
  try {
    await f.deliver(); await f.deliver();
    const record = latest(f.deps.state);
    const report = renderDeliveryReport({ cwd: f.repo, devSessionId: "developer", reviewerSessionId: "reviewer", status: "完成",
      rounds: f.deps.state.rounds, repairs: 2, criteria: f.deps.state.criteria, gitStatusShort: "" });
    const a1 = report.split("### A1\n")[1].split("### A2\n")[0];
    assert.ok(a1.includes(`${record.items[0].source!.runDir}/evidence/A1.txt`));
    assert.ok(!a1.includes(`${record.runDir}/evidence/A1.txt`));
    assert.match(a1, /最终结论来源：第 1 轮完整验收/);
  } finally { f.close(); }
});
