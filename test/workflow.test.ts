/** 流程选择与交付证据：真实 CLI、系统临时仓库；开发/评审/验收宿主均为替身。 */
import "./test-env.ts";
import "./helpers/git-runtime.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parseStageWorkflow, resolveProjectConfig } from "../config.ts";
import { parsePlan } from "../pipeline.ts";
import { extractCriteria } from "../acceptance-core.ts";
import { gateTestCounts, renderSummary } from "../core.ts";
import { createChildExec } from "../hosts/review-hook.ts";
import { appendLedgerRecord } from "../ledger.ts";
import { completionChecks } from "../pipeline-core.ts";
import { newReviewState, runReviewRound } from "../review.ts";

const LOOP = fileURLToPath(new URL("../bin/loop", import.meta.url));
const REVIEWER = fileURLToPath(new URL("./fake-reviewer.mjs", import.meta.url));
const TESTER = fileURLToPath(new URL("./fake-tester.mjs", import.meta.url));
const PASS = "## 结论：通过\n## 必修\n无\n";
const CRITERIA = "## 验收标准\nA1. 操作：执行项目命令\n    预期：看到了 A1\nA2. [人工] 操作：查看布局\n    预期：符合你的偏好";

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "loop-workflow-"))), repo = join(root, "repo"), workspace = join(root, "work");
  mkdirSync(repo); mkdirSync(join(root, "home"));
  const env = { ...process.env, HOME: join(root, "home"), AUTOREVIEW_RESOURCE_ROOT: join(root, "resources"), AUTOREVIEW_PROJECTS_ROOT: join(root, "projects"),
    AUTOREVIEW_REVIEWER_CMD: REVIEWER, AUTOREVIEW_ACCEPTANCE_CMD: TESTER, FAKE_MODE: "pass", FAKE_ACC_MODE: "pass", FAKE_STATE_DIR: join(root, "fake"),
    LOOP_PA_CONFIG: join(root, "pa.json"), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  const git = (...args: string[]) => {
    const run = spawnSync("git", args, { cwd: repo, env, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr); return run.stdout.trim();
  };
  git("init", "-qb", "main"); git("config", "user.name", "test"); git("config", "user.email", "test@example.invalid");
  const config: Record<string, unknown> = { workspaces: { dev分支: workspace }, gate: { cmd: "env -u NODE_TEST_CONTEXT node --test --test-reporter=tap checks.test.cjs", timeoutMin: 1 }, acceptance: {} };
  writeFileSync(join(repo, ".autoreview.json"), JSON.stringify(config));
  writeFileSync(join(repo, "prompt.md"), "实现项目功能\n");
  writeFileSync(join(repo, "product.txt"), "base\n");
  writeFileSync(join(repo, "checks.test.cjs"), "const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs');\ntest('product is present', () => assert.ok(fs.readFileSync('product.txt','utf8').trim()));\n");
  const batch = join(repo, "batch.json"), pipeline = join(root, "pipeline");
  const writeBatch = (stages: Record<string, unknown>) => writeFileSync(batch, JSON.stringify({ name: "流程选择", branch: "feat/workflow", dir: pipeline, stages }));
  writeBatch({ 甲: { prompt: "prompt.md" } });
  git("add", "."); git("commit", "-qm", "baseline");
  const saved = Object.fromEntries(["AUTOREVIEW_RESOURCE_ROOT", "AUTOREVIEW_PROJECTS_ROOT"].map((key) => [key, process.env[key]]));
  process.env.AUTOREVIEW_RESOURCE_ROOT = env.AUTOREVIEW_RESOURCE_ROOT;
  process.env.AUTOREVIEW_PROJECTS_ROOT = env.AUTOREVIEW_PROJECTS_ROOT;
  return { root, repo, workspace, batch, pipeline, env, config, git, writeBatch,
    marker: (data: unknown) => writeFileSync(join(repo, ".autoreview.json"), JSON.stringify(data)),
    open: (flags: string[] = []) => spawnSync(LOOP, ["开工", batch, "--json", ...flags], { cwd: repo, env, encoding: "utf8", timeout: 30_000 }),
    close: () => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } rmSync(root, { recursive: true, force: true }); },
  };
}

test("忽略配置随开工进入开发空间，开发替身交付后产生真实门禁结果", async () => {
  const f = fixture();
  try {
    f.git("rm", "--cached", ".autoreview.json");
    writeFileSync(join(f.repo, ".git/info/exclude"), ".autoreview.json\n");
    f.git("commit", "-qm", "local configuration");
    f.writeBatch({ 甲: { prompt: "prompt.md", workflow: "without-acceptance" } });
    const original = readFileSync(join(f.repo, ".autoreview.json"), "utf8");
    const opened = f.open(); assert.equal(opened.status, 0, opened.stdout + opened.stderr);
    assert.equal(readFileSync(join(f.workspace, ".autoreview.json"), "utf8"), original);
    const workspaceBatch = join(f.workspace, "batch.json");
    const env = { ...f.env, AUTOREVIEW_BATCH_FILE: workspaceBatch, AUTOREVIEW_STAGE: "甲" };
    const config = resolveProjectConfig(f.workspace, { env });
    assert.equal(config.acceptance, undefined, "不带验收不继承项目验收执行");
    writeFileSync(join(f.workspace, "product.txt"), "developer delivered\n");
    const state = newReviewState();
    const result = await runReviewRound({ cwd: f.workspace, devSessionId: "developer", round: 1, deliveryNote: "已交付", state, config, env,
      exec: createChildExec(join(f.root, "procs.json")), acceptanceDir: join(f.root, "acceptance"), saveState: () => {},
      writeInput: (name, text) => { const path = join(f.root, name); writeFileSync(path, text); return path; }, callReviewer: async () => ({ stdout: PASS, stderr: "", code: 0, killed: false }) });
    assert.equal(result.kind, "done");
    assert.equal(state.rounds[0].gate?.result, "通过");
    assert.equal(state.rounds[0].gate?.testsTotal, 1); assert.equal(state.rounds[0].gate?.testsFailed, 0);
    const summary = renderSummary({ cwd: f.workspace, devSessionId: "developer", reviewerSessionId: "reviewer", status: "完成", rounds: state.rounds, repairs: state.repairs,
      gitStatusShort: "", workflow: config.workflow });
    assert.match(summary, /^# 交付报告\n/); assert.match(summary, /命令：env -u NODE_TEST_CONTEXT node --test --test-reporter=tap checks.test.cjs/); assert.match(summary, /总数：1；失败数：0/);
    assert.doesNotMatch(summary, /门禁：未配置/);
  } finally { f.close(); }
});

test("开工强制检查：缺门禁、缺验收、流程与标准冲突均先拒绝且无开发副作用", async (t) => {
  for (const scenario of ["missing-marker", "missing-gate", "missing-acceptance", "conflicting-criteria"] as const) {
    await t.test(scenario, () => {
      const f = fixture();
      try {
        if (scenario === "missing-marker") rmSync(join(f.repo, ".autoreview.json"));
        else if (scenario === "missing-gate") f.marker({ acceptance: {} });
        else if (scenario === "missing-acceptance") f.marker({ ...f.config, acceptance: undefined });
        else { f.writeBatch({ 甲: { prompt: "prompt.md", workflow: "without-acceptance" } }); writeFileSync(join(f.repo, "prompt.md"), CRITERIA); }
        const branches = f.git("branch"), worktrees = f.git("worktree", "list", "--porcelain");
        for (const flags of [[], ["--dry-run"]]) {
          const run = f.open(flags); assert.notEqual(run.status, 0, run.stdout + run.stderr);
          const error = JSON.parse(run.stdout).error;
          assert.match(error, scenario.startsWith("missing-") && scenario !== "missing-acceptance" ? /缺少项目门禁[\s\S]*gate/ : scenario === "missing-acceptance" ? /缺少验收配置[\s\S]*acceptance/ : /流程和验收标准对不上/);
          assert.equal(existsSync(f.workspace), false); assert.equal(existsSync(f.pipeline), false); assert.equal(existsSync(join(f.root, "fake")), false);
          assert.equal(f.git("branch"), branches); assert.equal(f.git("worktree", "list", "--porcelain"), worktrees);
        }
      } finally { f.close(); }
    });
  }
});

test("流程冲突核对复用既有标题规则，空标准及缩进/冒号写法不能绕过", () => {
  const f = fixture();
  try {
    f.writeBatch({ 甲: { prompt: "prompt.md", workflow: "without-acceptance" } });
    for (const heading of ["## 验收标准", "  ## 验收标准：  ", "##验收标准:"]) {
      writeFileSync(join(f.repo, "prompt.md"), `${heading}\n`);
      const run = f.open(["--dry-run"]); assert.notEqual(run.status, 0);
      assert.match(JSON.parse(run.stdout).error, /流程和验收标准对不上/);
      assert.equal(existsSync(f.workspace), false);
    }
  } finally { f.close(); }
});

test("开工流程输出：带验收与不带验收逐段给出完整步骤和显式或默认依据", () => {
  const f = fixture();
  try {
    f.writeBatch({ 甲: { prompt: "prompt.md" }, 乙: { prompt: "prompt.md", workflow: "without-acceptance" } });
    const run = f.open(); assert.equal(run.status, 0, run.stdout + run.stderr);
    const output = JSON.parse(run.stdout), lines = output.lines.join("\n");
    assert.match(lines, /甲 的流程：开发 → 评审 → 测试 → 验收 → 提交；依据：.*未写，默认带验收/);
    assert.match(lines, /乙 的流程：开发 → 评审 → 测试 → 提交；依据：.*明确指定 without-acceptance/);
    assert.equal(output.workflows.length, 2);
  } finally { f.close(); }
});

test("批次外部项目缺门禁不能借用运行版配置，整批在创建任何开发空间前拒绝", () => {
  const f = fixture();
  try {
    const external = join(f.root, "external-project"); mkdirSync(external);
    assert.equal(spawnSync("git", ["-C", external, "init", "-q"], { env: f.env }).status, 0);
    f.writeBatch({ 甲: { prompt: "prompt.md" }, 乙: { cwd: external, start: "touch must-not-dispatch" } });
    const opened = f.open(); assert.notEqual(opened.status, 0);
    assert.match(JSON.parse(opened.stdout).error, /乙 的门禁配置：缺少项目门禁/);
    assert.equal(existsSync(f.workspace), false); assert.equal(existsSync(f.pipeline), false);
    assert.equal(existsSync(join(external, "must-not-dispatch")), false);
  } finally { f.close(); }
});

test("已有同名配置不覆盖，开工使用开发空间自己的有效配置", () => {
  const f = fixture();
  try {
    f.git("rm", "--cached", ".autoreview.json"); writeFileSync(join(f.repo, ".git/info/exclude"), ".autoreview.json\n"); f.git("commit", "-qm", "local configuration");
    f.git("worktree", "add", "-b", "feat/workflow", f.workspace);
    const existing = JSON.stringify({ ...f.config, gate: { cmd: "printf 'EXISTING_CONFIG\\n'", timeoutMin: 1 } });
    writeFileSync(join(f.workspace, ".autoreview.json"), existing);
    const run = f.open(); assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(JSON.parse(run.stdout).lines.join("\n"), /已有同名配置，不覆盖/);
    assert.equal(readFileSync(join(f.workspace, ".autoreview.json"), "utf8"), existing);
  } finally { f.close(); }
});

test("切分支保护：目标跟踪同名配置时，已有忽略配置在 checkout 前保留", async (t) => {
  for (const flags of [[], ["--dry-run"]]) await t.test(flags.length ? "预览" : "实际开工", () => {
    const f = fixture();
    try {
      const tracked = f.git("rev-parse", "HEAD");
      f.git("rm", "--cached", ".autoreview.json");
      writeFileSync(join(f.repo, ".git/info/exclude"), ".autoreview.json\n");
      f.git("commit", "-qm", "local configuration");
      f.git("branch", "feat/tracked-config", tracked);
      const first = f.open(); assert.equal(first.status, 0, first.stdout + first.stderr);
      const marker = join(f.workspace, ".autoreview.json");
      const original = JSON.stringify({ ...f.config, reviewerModel: "local/keep-this-configuration" });
      writeFileSync(marker, original);
      assert.equal(f.git("-C", f.workspace, "status", "--porcelain"), "", "忽略配置不会被普通脏检查发现");
      const batch = JSON.parse(readFileSync(f.batch, "utf8")); batch.branch = "feat/tracked-config";
      writeFileSync(f.batch, JSON.stringify(batch));
      const branch = f.git("-C", f.workspace, "branch", "--show-current"), refs = f.git("show-ref");
      const status = f.git("status", "--porcelain"), calls = readFileSync(join(f.root, "fake", "calls.log"), "utf8");
      const opened = f.open(flags);
      assert.equal(readFileSync(marker, "utf8"), original, "checkout 不能覆盖已有的本机配置");
      assert.notEqual(opened.status, 0, opened.stdout + opened.stderr);
      assert.match(JSON.parse(opened.stdout).error, /目标分支 feat\/tracked-config 已跟踪本机文件 \.autoreview\.json/);
      assert.equal(f.git("-C", f.workspace, "branch", "--show-current"), branch);
      assert.equal(f.git("show-ref"), refs); assert.equal(f.git("status", "--porcelain"), status);
      assert.equal(readFileSync(join(f.root, "fake", "calls.log"), "utf8"), calls, "冲突时不运行后续空跑评审");
    } finally { f.close(); }
  });
});

test("交付报告逐条展示原文、实测和人工未跑原因，测试在评审之后、验收之前", async () => {
  const f = fixture();
  try {
    const state = newReviewState(); state.requirement = CRITERIA;
    state.criteria = { source: "用户", version: 1, updatedAt: "now", items: extractCriteria(CRITERIA)! };
    const config = resolveProjectConfig(f.repo, { env: f.env });
    const order: string[] = [], exec = createChildExec(join(f.root, "procs.json"));
    const outcome = await runReviewRound({ cwd: f.repo, devSessionId: "evidence", round: 1, deliveryNote: "完成", state, config, env: f.env,
      exec: async (cmd, args, options) => { if (options.role === "门禁") order.push("test"); if (options.role === "验收") order.push("acceptance"); return exec(cmd, args, options); },
      acceptanceDir: join(f.root, "acceptance"), saveState: () => {},
      writeInput: (name, text) => { const path = join(f.root, name); writeFileSync(path, text); return path; },
      callReviewer: async () => { order.push("review"); return { stdout: PASS, stderr: "", code: 0, killed: false }; } });
    assert.equal(outcome.kind, "done", JSON.stringify(outcome));
    assert.equal(order[0], "review"); assert.equal(order[1], "test");
    assert.ok(state.rounds[0].acceptance, "后置验收已实测并留下记录");
    const summary = renderSummary({ cwd: f.repo, devSessionId: "evidence", reviewerSessionId: "reviewer", status: "完成", rounds: state.rounds, repairs: 0,
      criteria: state.criteria, gitStatusShort: "", acceptanceConfigured: true });
    assert.match(summary, /^# 交付报告\n/);
    for (const item of state.criteria!.items) assert.ok(summary.includes(item.text), "标准原文保留操作、预期及续行");
    const report = summary.split("# 自动评审总结")[0];
    assert.match(report, /实际命令：\$ .*echo.*看到了 A1/); assert.match(report, /看到的结果：证据摘录：看到了 A1/);
    assert.match(report, /A2[\s\S]*没跑（标了 \[人工\]/); assert.match(report, /总数：1；失败数：0/); assert.match(report, /耗时：.*秒/); assert.match(report, /日志路径：.*gate-/);
    assert.match(report, /必修条数：0；返修次数：0/);
    const summaryPath = join(f.root, "summary.md"); writeFileSync(summaryPath, summary);
    const ledger = appendLedgerRecord({ project: f.repo, session: "evidence", task: "证据", result: "完成（部分验证）", summary: summaryPath,
      checks: completionChecks(state.rounds[0]), pending: [] }, join(f.root, "交付记录.md"));
    assert.ok(readFileSync(ledger, "utf8").includes(`交付报告：${summaryPath}`));
  } finally { f.close(); }
});

test("门禁产品失败保留评审与原始输出，不进入验收", async () => {
  const f = fixture();
  try {
    const state = newReviewState(), config = resolveProjectConfig(f.repo, { env: f.env });
    config.gate = { cmd: "printf 'AUTOREVIEW_FAILURE=product TEST_FAILURE_ORIGINAL\\n'; exit 1", timeoutMin: 1 };
    const outcome = await runReviewRound({ cwd: f.repo, devSessionId: "test-failure", round: 1, deliveryNote: "完成", state, config, env: f.env,
      exec: createChildExec(), acceptanceDir: join(f.root, "acceptance"), saveState: () => {},
      writeInput: (name, text) => { const path = join(f.root, name); writeFileSync(path, text); return path; },
      callReviewer: async () => ({ stdout: PASS, stderr: "", code: 0, killed: false }) });
    assert.equal(outcome.kind, "repair"); assert.match(outcome.message!, /TEST_FAILURE_ORIGINAL/);
    assert.equal(state.rounds.length, 1); assert.equal(state.rounds[0].reviewConclusion, "通过");
    assert.equal(state.rounds[0].acceptance, undefined); assert.equal(existsSync(join(f.root, "acceptance")), false);
  } finally { f.close(); }
});

test("段流程配置：默认带验收，显式不带验收不继承执行，错误值拒绝且选择进入配置指纹", () => {
  const f = fixture();
  try {
    const env = { ...f.env, AUTOREVIEW_BATCH_FILE: f.batch, AUTOREVIEW_STAGE: "甲" };
    const required = resolveProjectConfig(f.repo, { env });
    assert.equal(required.workflow, "with-acceptance"); assert.ok(required.acceptance);
    f.writeBatch({ 甲: { prompt: "prompt.md", workflow: "without-acceptance" } });
    const omitted = resolveProjectConfig(f.repo, { env });
    assert.equal(omitted.workflow, "without-acceptance"); assert.equal(omitted.acceptance, undefined);
    assert.notEqual(required.configurationHash, omitted.configurationHash);
    for (const workflow of [null, false, "guess", {}]) {
      assert.throws(() => parseStageWorkflow(workflow), /workflow 只支持/);
      assert.throws(() => parsePlan({ name: "bad-flow", stages: { 甲: { start: "true", workflow } } }, f.repo), /workflow 只支持/);
    }
  } finally { f.close(); }
});

test("显式 cwd 的已登记开发空间同样带入被忽略配置", () => {
  const f = fixture();
  try {
    f.git("rm", "--cached", ".autoreview.json"); writeFileSync(join(f.repo, ".git/info/exclude"), ".autoreview.json\n"); f.git("commit", "-qm", "local configuration");
    f.git("worktree", "add", "-b", "feat/workflow", f.workspace);
    f.writeBatch({ 甲: { cwd: f.workspace, prompt: "prompt.md", workflow: "without-acceptance" } });
    const opened = f.open(); assert.equal(opened.status, 0, opened.stdout + opened.stderr);
    assert.equal(readFileSync(join(f.workspace, ".autoreview.json"), "utf8"), readFileSync(join(f.repo, ".autoreview.json"), "utf8"));
    assert.match(JSON.parse(opened.stdout).lines.join("\n"), /已复制本机配置/);
  } finally { f.close(); }
});

test("交付结论缺失如实记录，没有测试统计时也不推断成零失败", () => {
  assert.deepEqual(completionChecks(), { gate: "没有记录", review: "没有记录", acceptance: "没有记录" });
  assert.deepEqual(gateTestCounts("some output, exit zero"), { testsTotal: undefined, testsFailed: undefined });
  assert.deepEqual(gateTestCounts("# tests 5\n# fail 2\n"), { testsTotal: 5, testsFailed: 2 });
  assert.deepEqual(gateTestCounts("AUTOREVIEW_TEST_TOTAL=12\nAUTOREVIEW_TEST_FAILED=0\n"), { testsTotal: 12, testsFailed: 0 });
  assert.deepEqual(gateTestCounts("Tests: 2 failed, 3 passed, 5 total"), { testsTotal: 5, testsFailed: 2 });
  assert.deepEqual(gateTestCounts("Tests: 0 total"), { testsTotal: 0, testsFailed: 0 });
  assert.deepEqual(gateTestCounts("\u001b[32mℹ tests 2\u001b[0m\nℹ fail 0"), { testsTotal: 2, testsFailed: 0 });
  const text = renderSummary({ cwd: "/tmp/project", devSessionId: "old", reviewerSessionId: "reviewer", status: "完成", rounds: [], repairs: 0, gitStatusShort: "" });
  assert.match(text, /没跑（本轮没有门禁执行记录）/); assert.doesNotMatch(text, /完成资格已确认/);
});
